import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createCommandDiagnostic } from '../../scripts/integration/payload-preauthority-diagnostics.mjs';

const image = name => `ghcr.io/ownerinc/ownerinc-portal-${name}@sha256:${'b'.repeat(64)}`;
const legacy = `API_IMAGE=${image('api')}\nCRON_IMAGE=${image('cron')}\n`;
const payload = `${legacy}CMS_IMAGE=${image('cms')}\nRELEASE_FORMAT=payload-v1\n`;
const fakeDocker = `#!/usr/bin/env bash
set -euo pipefail
FIXTURE="$(cd -- "$(dirname -- "$0")/.." && pwd)"
printf '%s\\n' "$*" >> "$FIXTURE/calls"
if [[ $1 == ps ]]; then cat "$FIXTURE/running"; exit 0; fi
if [[ $1 == start ]]; then
  printf 'docker:start %s\\n' "$2" >> "$FIXTURE/timeline"
  service=nginx
  case \${2:0:1} in 2) service=api;; 3) service=cron;; 4) service=cms;; esac
  printf '%s\\n' "$service" >> "$FIXTURE/running"
  exit 0
fi
[[ $1 == compose ]] || exit 90
shift
while (($#)); do
  case $1 in --profile|--project-directory|--project-name|--env-file|-f) shift 2;; *) break;; esac
done
cmd=$1; shift
printf 'docker:%s %s\\n' "$cmd" "$*" >> "$FIXTURE/timeline"
case $cmd in
 ps) cat "$FIXTURE/running";;
 stop)
    if [[ \${FAIL_CLEANUP_STOP:-false} == true && -f "$FIXTURE/restores" ]]; then
      printf 'unsafe_required_owner\\nprivate-cleanup-output\\n' >&2; exit 46
    fi
    printf 'postgres\\ncms-postgres\\n' > "$FIXTURE/running";;
  start) printf 'private missing cms-migrate dependency\\n' >&2; exit 1;;
 up) printf 'postgres\\ncms-postgres\\nnginx\\napi\\ncms\\n' > "$FIXTURE/running";;
 exec|run)
    if [[ $cmd == run && " $* " == *' migrate '* ]]; then
      printf 'migrate\\n' >> "$FIXTURE/migration.attempts"
      [[ \${FAIL_GRANT_RESTORE:-false} != true ]] || exit 44
    fi
   if grep -Eq '^(nginx|api|cron|cms|cms-worker)$' "$FIXTURE/running"; then exit 91; fi
   if [[ \${FAIL_DUMP:-false} == true ]]; then exit 92; fi
   if [[ "$*" == *pg_restore* || "$*" == *'-xzf -'* ]]; then
     printf 'restore\\n' >> "$FIXTURE/restores"
     [[ \${FAIL_RESTORE:-false} != true ]] || exit 43
     cat >> "$FIXTURE/restored-bytes"
   fi
   printf 'synthetic artifact\\n';;
 *) exit 93;;
esac
`;
const fakeGuard = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$1" >> "$FIXTURE/guard.calls"
printf 'guard:%s\\n' "$1" >> "$FIXTURE/timeline"
if [[ \${FAIL_GUARD:-} == "$1" ]]; then
  if [[ -n \${FAIL_GUARD_STDERR:-} ]]; then printf '%s\\n' "$FAIL_GUARD_STDERR" >&2; fi
  exit "\${FAIL_GUARD_EXIT:-42}"
fi
case $1 in
  observe-writers) printf 'synthetic signed-ticket double\\n';;
  resume-writers|resume-readiness-writers)
    [[ $3 == 'synthetic signed-ticket double' ]] || exit 94
    for digit in 1 2 3 4; do
      [[ $1 != resume-readiness-writers || $digit != 3 ]] || continue
      identity=$(printf '%064d' 0 | tr 0 "$digit")
      docker start "$identity" >/dev/null
    done;;
  close-admission) printf 'closed\\n' > "$FIXTURE/admission";;
  open-admission) printf 'open\\n' > "$FIXTURE/admission";;
  release-preflight|restore-preflight) ! grep -qx 'cms-worker' "$FIXTURE/running";;
  quiescence-proof) ! grep -Eq '^(nginx|api|cron|cms|cms-worker)$' "$FIXTURE/running";;
  verify-release)
    for service in api cron cms; do grep -qx "$service" "$FIXTURE/running" || exit 43; done
    ! grep -qx 'cms-worker' "$FIXTURE/running" ;;
  backup-metadata) printf '{"fixture":true,"epoch":1,"ambiguousPromotions":1}\\n' > "$3";;
esac
`;

async function fixture(t) {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const base = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir();
  const root = await mkdtemp(path.join(base, 'payload ops-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['release/scripts', 'bin', 'backups', 'protection']) await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, 'compose.payload.production.yaml'), 'services: {}\n');
  for (const file of ['release-manifest.sh', 'payload-operations.sh', 'backup.sh', 'restore.sh', 'backup-s3.sh']) {
    const source = await readFile(`scripts/${file}`, 'utf8');
    // The coordinator pins PATH on the Linux host. This isolated shell fixture
    // keeps its local fake docker/flock binaries ahead of host tools.
    const fixtureSource = file === 'payload-operations.sh'
      ? source
        .replace('PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nexport PATH\n', '')
        .replace('env -i PATH="$PATH" HOME="${HOME:-/root}" docker compose',
          'env -i PATH="$PATH" HOME="${HOME:-/root}" FAIL_DUMP="${FAIL_DUMP:-false}" FAIL_RESTORE="${FAIL_RESTORE:-false}" FAIL_GRANT_RESTORE="${FAIL_GRANT_RESTORE:-false}" FAIL_CLEANUP_STOP="${FAIL_CLEANUP_STOP:-false}" docker compose')
      : source;
    if (file === 'payload-operations.sh') assert.notEqual(fixtureSource, source, 'production PATH pin must remain explicit');
    await writeFile(path.join(root, 'release/scripts', file), fixtureSource);
  }
  await writeFile(path.join(root, 'release/.image-env'), payload);
  await writeFile(path.join(root, 'release/docker-compose.payload.yml'), '# synthetic\n');
  await writeFile(path.join(root, 'release/scripts/smoke.sh'), '#!/bin/sh\nprintf "smoke\\n" >> "$FIXTURE/smoke.calls"\n');
  await writeFile(path.join(root, 'running'), 'postgres\ncms-postgres\nnginx\napi\ncron\ncms\n');
  await writeFile(path.join(root, 'admission'), 'open\n');
  await writeFile(path.join(root, 'timeline'), '');
  await writeFile(path.join(root, 'bin/docker'), fakeDocker, { mode: 0o755 });
  await writeFile(path.join(root, 'bin/flock'), '#!/bin/sh\nprintf "lock\\n" >> "$FIXTURE/lock.calls"\n', { mode: 0o755 });
  // Archive listing only; this stub never extracts data or invokes system tar.
  await writeFile(path.join(root, 'bin/tar'), '#!/bin/sh\ncase "$2" in -tzf) printf "./\\n./.owner-news-import/receipt.json\\n";; -tvzf) printf "drwx------ fixture\\n-rw------- fixture\\n";; *) exit 95;; esac\n', { mode: 0o755 });
  await writeFile(path.join(root, 'guard'), fakeGuard, { mode: 0o755 });
  const run = (body, extra = {}) => {
    const result = spawnSync(bash, ['-c', `set -euo pipefail
cd -- "$1"
export FIXTURE=$PWD PATH="$PWD/bin:/usr/bin:/bin"
[[ $(command -v docker) == "$PWD/bin/docker" ]] || exit 94
export PORTAL_OPERATION_LOCK="$PWD/operation.lock" PAYLOAD_OPERATIONS_GUARD="$PWD/guard" BACKUP_DIR="$PWD/backups"
${body}`, 'fixture', root.replaceAll('\\', '/')], {
      encoding: 'utf8', timeout: 15000,
      env: { PATH: process.env.PATH, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}), ...extra },
    });
    assert.ifError(result.error);
    return result;
  };
  return { root, run };
}

test('release manifest rejects partial CMS, duplicates, mutable digests and extra keys without executing data', async t => {
  const f = await fixture(t);
  for (const valid of [legacy, payload]) {
    await writeFile(path.join(f.root, 'release/.image-env'), valid);
    const r = f.run('. release/scripts/release-manifest.sh; load_release_manifest release/.image-env');
    assert.equal(r.status, 0, r.stderr);
  }
  for (const invalid of [`${legacy}CMS_IMAGE=${image('cms')}\n`, `${legacy}CMS_IMAGE=\n`, `${legacy}RELEASE_FORMAT=payload-v1\n`,
    `${payload}API_IMAGE=${image('api')}\n`, payload.replace(image('cms'), 'cms:latest'), `${payload}X=$(touch marker)\n`]) {
    await writeFile(path.join(f.root, 'release/.image-env'), invalid);
    assert.notEqual(f.run('. release/scripts/release-manifest.sh; load_release_manifest release/.image-env').status, 0);
  }
  assert.equal((await readdir(f.root)).includes('marker'), false);
});

test('coordinated backup stops live Portal/CMS writers while the worker stays held', async t => {
  const f = await fixture(t);
  const r = f.run('bash release/scripts/backup.sh "$PWD/release"');
  assert.equal(r.status, 0, r.stderr);
  const [name] = await readdir(path.join(f.root, 'backups'));
  const backup = path.join(f.root, 'backups', name);
  const files = await readdir(backup);
  for (const file of ['postgres.dump', 'uploads.tar.gz', 'cms-postgres.dump', 'cms-uploads.tar.gz', 'operations-proof.json', 'release.images', 'backup.format', 'manifest.sha256']) assert.ok(files.includes(file));
  const calls = await readFile(path.join(f.root, 'calls'), 'utf8');
  assert.match(calls, /stop --timeout 120 nginx api cron cms/);
  assert.doesNotMatch(calls, /(?:start|up)[^\n]*cms-worker/);
  assert.match(calls, /--entrypoint tar cms -czf - -C \/var\/lib\/ownerinc-cms\/media \./);
  assert.match(calls, /--entrypoint tar api -czf - -C \/app\/uploads \./);
  assert.match(calls, /--entrypoint tar api -czf - -C \/app\/uploads \./);
  assert.equal((await readFile(path.join(backup, 'manifest.sha256'), 'utf8')).trim().split('\n').length, 7);
  assert.deepEqual((await readFile(path.join(f.root, 'guard.calls'), 'utf8')).trim().split('\n'),
    ['release-preflight', 'observe-writers', 'close-admission', 'quiescence-proof', 'backup-metadata', 'resume-writers', 'verify-release', 'open-admission']);
  assert.doesNotMatch(calls, /compose[^\n]* start /u, 'Compose start would traverse the absent one-shot dependency in this regression');
  for (const digit of ['1', '2', '3', '4']) assert.ok(calls.includes(`start ${digit.repeat(64)}`));
  assert.equal((await readFile(path.join(f.root, 'lock.calls'), 'utf8')).trim(), 'lock');
});

test('backup preflight rejects an already-running CMS worker before capture', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'running'), 'postgres\ncms-postgres\ncms-worker\n');
  const r = f.run('bash release/scripts/backup.sh "$PWD/release"');
  assert.notEqual(r.status, 0);
  assert.match(await readFile(path.join(f.root, 'guard.calls'), 'utf8'), /^release-preflight\n/u);
  assert.doesNotMatch(await readFile(path.join(f.root, 'calls'), 'utf8').catch(() => ''), /pg_dump|start|up/);
  assert.match(await readFile(path.join(f.root, 'running'), 'utf8'), /^cms-worker$/mu);
});

test('actual coordinated capture retains its proof and primary resume reason without opening admission or leaking tool output', async t => {
  for (const stderr of ['writer_start_command_failed', 'private-unknown-Docker-output']) {
    const f = await fixture(t);
    const result = f.run('bash release/scripts/backup.sh "$PWD/release"', { FAIL_GUARD: 'resume-writers', FAIL_GUARD_STDERR: stderr });
    assert.equal(result.status, 42);
    const diagnostic = createCommandDiagnostic({ substep: 'payload_coordinator_backup', status: result.status,
      stderr: result.stderr, coordinatorCommandContext: 'payload-coordinator:backup' });
    assert.equal(diagnostic.coordinatorStep, 'resume_writers');
    assert.equal(diagnostic.controlErrorIdentifier, stderr === 'writer_start_command_failed' ? stderr : null);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-unknown/u);
    assert.equal((await readFile(path.join(f.root, 'admission'), 'utf8')).trim(), 'closed');
    assert.doesNotMatch(await readFile(path.join(f.root, 'guard.calls'), 'utf8'), /open-admission|verify-release/u);
    const [backup] = await readdir(path.join(f.root, 'backups'));
    assert.ok((await readdir(path.join(f.root, 'backups', backup))).includes('operations-proof.json'));
  }
});

test('actual Bash observe-writers failure keeps the parent progress/failure step and attributes only exact finite reasons before effects', async t => {
  for (const stderr of [
    'writer_coordinator_scope_invalid', 'writer_inspect_command_failed',
    'private-observation-error', 'writer_inspect_command_failed\nprivate-observation-detail',
  ]) {
    const f = await fixture(t);
    const runningBefore = await readFile(path.join(f.root, 'running'), 'utf8');
    const result = f.run('bash release/scripts/backup.sh "$PWD/release"', {
      FAIL_GUARD: 'observe-writers', FAIL_GUARD_EXIT: '2', FAIL_GUARD_STDERR: stderr,
    });
    assert.equal(result.status, 2);
    const progress = [...result.stderr.matchAll(/^PAYLOAD_COORDINATOR_STEP step=([^\r\n]+)$/gmu)].map(match => match[1]);
    const failures = [...result.stderr.matchAll(/^PAYLOAD_COORDINATOR_FAILURE step=([^ ]+) status=([0-9]+)$/gmu)];
    assert.equal(progress.at(-1), 'guard_observe_writers');
    assert.equal(failures.length, 1, 'one primary EXIT frame, not an inherited subshell failure');
    assert.equal(failures[0][1], progress.at(-1), 'the real parent EXIT must match the last emitted progress marker');
    assert.equal(failures[0][2], '2');
    assert.equal(progress.filter(step => step === 'guard_observe_writers').length, 1,
      'observation progress is emitted once in the parent, never duplicated inside stdout capture');
    const diagnostic = createCommandDiagnostic({ substep: 'payload_coordinator_backup', status: result.status,
      stderr: result.stderr, coordinatorCommandContext: 'payload-coordinator:backup' });
    assert.equal(diagnostic.coordinatorStep, 'guard_observe_writers');
    assert.equal(diagnostic.controlErrorIdentifier,
      ['writer_coordinator_scope_invalid', 'writer_inspect_command_failed'].includes(stderr) ? stderr : null);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-observation/u);
    assert.equal(result.stdout, '', 'observation never leaks a ticket or failure body to coordinator stdout');
    assert.deepEqual((await readFile(path.join(f.root, 'guard.calls'), 'utf8')).trim().split('\n'),
      ['release-preflight', 'observe-writers']);
    assert.equal((await readFile(path.join(f.root, 'admission'), 'utf8')).trim(), 'open');
    assert.equal(await readFile(path.join(f.root, 'running'), 'utf8'), runningBefore);
    assert.deepEqual(await readdir(path.join(f.root, 'backups')), []);
    assert.deepEqual(await readdir(path.join(f.root, 'protection')), []);
    assert.doesNotMatch(await readFile(path.join(f.root, 'calls'), 'utf8'), /(?:\bstop\b|\bstart\b|\bup\b|\bexec\b|\brun\b|pg_dump|pg_restore)/u);
  }
});

test('failed quiescence cannot produce a dump or reopen admission', async t => {
  const f = await fixture(t);
  const r = f.run('bash release/scripts/backup.sh "$PWD/release"', { FAIL_GUARD: 'quiescence-proof' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(await readdir(path.join(f.root, 'backups')), []);
  assert.doesNotMatch(await readFile(path.join(f.root, 'calls'), 'utf8'), /pg_dump| start /);
  assert.doesNotMatch(await readFile(path.join(f.root, 'guard.calls'), 'utf8'), /open-admission/);
});

test('corrupt/partial coordinated set and legacy restore into CMS are rejected before mutation', async t => {
  const f = await fixture(t);
  assert.equal(f.run('bash release/scripts/backup.sh "$PWD/release"').status, 0);
  const [name] = await readdir(path.join(f.root, 'backups'));
  await writeFile(path.join(f.root, 'backups', name, 'cms-postgres.dump'), 'corrupt');
  let r = f.run(`. release/scripts/release-manifest.sh; verify_backup_manifest "backups/${name}"`);
  assert.notEqual(r.status, 0);
  await writeFile(path.join(f.root, 'release/.image-env'), legacy);
  r = f.run(`PROJECT_ROOT="$PWD/release" bash release/scripts/restore.sh "backups/${name}" --confirm RESTORE`);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /legacy release/);
});

test('missing integration guard blocks CMS backup before Docker', async t => {
  const f = await fixture(t);
  const r = f.run('PAYLOAD_OPERATIONS_GUARD="$PWD/missing" bash release/scripts/backup.sh "$PWD/release"');
  assert.notEqual(r.status, 0);
  assert.equal((await readdir(f.root)).includes('calls'), false);
});

test('coordinated restore protects first, restores both DBs/files and verifies before reopening', async t => {
  const f = await fixture(t);
  assert.equal(f.run('bash release/scripts/backup.sh "$PWD/release"').status, 0);
  const [name] = await readdir(path.join(f.root, 'backups'));
  await writeFile(path.join(f.root, 'calls'), '');
  await writeFile(path.join(f.root, 'guard.calls'), '');
  await writeFile(path.join(f.root, 'timeline'), '');
  const r = f.run(`PRE_RESTORE_BACKUP_DIR="$PWD/protection" RESTORE_BASE_URL=http://fixture.invalid PROJECT_ROOT="$PWD/release" bash release/scripts/restore.sh "$PWD/backups/${name}" --confirm RESTORE`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal((await readdir(path.join(f.root, 'protection'))).length, 1);
  assert.equal((await readFile(path.join(f.root, 'restores'), 'utf8')).trim().split('\n').length, 4);
  const calls = await readFile(path.join(f.root, 'calls'), 'utf8');
  assert.ok(calls.indexOf('pg_dump') < calls.indexOf('pg_restore'));
  assert.match(calls, /--role=cms_migrator/);
  assert.match(calls, /--entrypoint tar cms -xzf - -C \/var\/lib\/ownerinc-cms\/media/);
  assert.match(calls, /--entrypoint tar api -xzf - -C \/app\/uploads/);
  assert.match(calls, /restore-files \/var\/lib\/ownerinc-cms\/media/);
  assert.match(calls, /--entrypoint tar api -xzf - -C \/app\/uploads/);
  const guardCalls = (await readFile(path.join(f.root, 'guard.calls'), 'utf8')).trim().split('\n');
  assert.deepEqual(guardCalls, [
    'restore-preflight', 'observe-writers', 'close-admission', 'quiescence-proof', 'backup-metadata', 'prepare-restore',
    'portal-restore-intermediate', 'prepare-restore', 'prepare-restore', 'prepare-restore',
    'prepare-restore', 'prepare-restore', 'prepare-restore', 'prepare-restore',
    'verify-restored', 'resume-readiness-writers', 'resume-writers', 'verify-release', 'open-admission',
  ]);
  const timeline = (await readFile(path.join(f.root, 'timeline'), 'utf8')).trim().split('\n');
  const at = entry => timeline.findIndex(value => value === entry);
  assert.ok(at('guard:verify-restored') < at('guard:resume-readiness-writers'));
  assert.ok(at('guard:resume-writers') < at('guard:verify-release'));
  assert.doesNotMatch(calls, /compose[^\n]*(?: start | up )/u);
  assert.ok(at('guard:verify-release') < at('guard:open-admission'));
  assert.equal((await readFile(path.join(f.root, 'admission'), 'utf8')).trim(), 'open');
  assert.equal((await readFile(path.join(f.root, 'smoke.calls'), 'utf8')).trim(), 'smoke');
});

test('restore failure preserves protection set and leaves all writers stopped with admission closed', async t => {
  const f = await fixture(t);
  assert.equal(f.run('bash release/scripts/backup.sh "$PWD/release"').status, 0);
  const [name] = await readdir(path.join(f.root, 'backups'));
  await writeFile(path.join(f.root, 'guard.calls'), '');
  const r = f.run(`PRE_RESTORE_BACKUP_DIR="$PWD/protection" RESTORE_BASE_URL=http://fixture.invalid PROJECT_ROOT="$PWD/release" bash release/scripts/restore.sh "$PWD/backups/${name}" --confirm RESTORE`, { FAIL_RESTORE: 'true' });
  assert.notEqual(r.status, 0);
  assert.equal((await readdir(path.join(f.root, 'protection'))).length, 1);
  assert.doesNotMatch(await readFile(path.join(f.root, 'running'), 'utf8'), /^(nginx|api|cron|cms|cms-worker)$/m);
  assert.doesNotMatch(await readFile(path.join(f.root, 'guard.calls'), 'utf8'), /open-admission/);
});

test('Portal grant restoration failure stops before CMS destruction and keeps writers/admission closed', async t => {
  const f = await fixture(t);
  assert.equal(f.run('bash release/scripts/backup.sh "$PWD/release"').status, 0);
  const [name] = await readdir(path.join(f.root, 'backups'));
  await writeFile(path.join(f.root, 'calls'), '');
  await writeFile(path.join(f.root, 'guard.calls'), '');
  await writeFile(path.join(f.root, 'timeline'), '');
  const r = f.run(`PRE_RESTORE_BACKUP_DIR="$PWD/protection" RESTORE_BASE_URL=http://fixture.invalid PROJECT_ROOT="$PWD/release" bash release/scripts/restore.sh "backups/${name}" --confirm RESTORE`, {
    FAIL_GRANT_RESTORE: 'true',
  });
  assert.notEqual(r.status, 0);
  assert.equal((await readFile(path.join(f.root, 'guard.calls'), 'utf8')).trim().split('\n').at(-1), 'portal-restore-intermediate');
  assert.equal((await readFile(path.join(f.root, 'migration.attempts'), 'utf8')).trim(), 'migrate');
  assert.equal((await readFile(path.join(f.root, 'restores'), 'utf8')).trim().split('\n').length, 1,
    'only the Portal restore may have run before grant restoration succeeds');
  const calls = await readFile(path.join(f.root, 'calls'), 'utf8');
  assert.doesNotMatch(calls, /exec -T cms-postgres sh -c pg_restore/u);
  assert.doesNotMatch(calls, /restore-files|tar.*-xzf -/u);
  assert.doesNotMatch(await readFile(path.join(f.root, 'running'), 'utf8'), /^(nginx|api|cron|cms|cms-worker)$/m);
  assert.equal((await readFile(path.join(f.root, 'admission'), 'utf8')).trim(), 'closed');
  assert.doesNotMatch(await readFile(path.join(f.root, 'guard.calls'), 'utf8'), /open-admission/u);
});

test('real tar listing rejects traversal before extraction and accepts ordinary fixture files', async t => {
  const f = await fixture(t);
  const r = f.run(`export PATH=/usr/bin:/bin
printf 'synthetic' > safe
tar -czf clean.tar.gz safe
tar --transform='s|safe|../outside|' -czf unsafe.tar.gz safe
. release/scripts/release-manifest.sh
verify_storage_archive clean.tar.gz
if verify_storage_archive unsafe.tar.gz; then exit 96; fi`);
  assert.equal(r.status, 0, r.stderr);
});

test('real guard dispatch supplies three arguments to the real control entrypoint (adapter and Windows fd probe doubled)', async t => {
  const f = await fixture(t);
  const guardSource = await readFile('ops/payload-operations-guard.sh', 'utf8');
  // Git Bash lacks Linux /proc/PID/fd. Only that identity predicate is replaced
  // in this unit fixture; this test proves argv dispatch, NOT a Linux lease.
  const dispatchSource = process.platform === 'win32'
    ? guardSource.replace('/proc/$$/fd/9 -ef $PORTAL_OPERATION_LOCK', '-f $PORTAL_OPERATION_LOCK') : guardSource;
  await writeFile(path.join(f.root, 'real-guard'), dispatchSource, { mode: 0o755 });
  await writeFile(path.join(f.root, 'payload-control'), await readFile('ops/payload-control'), { mode: 0o755 });
  for (const name of ['payload-control-runtime.py', 'payload-control-state.py']) await writeFile(path.join(f.root, name), '# fixture\n');
  await writeFile(path.join(f.root, 'bin/python3'), `#!/usr/bin/env bash
set -euo pipefail
[[ $# == 4 && -z $4 ]] || exit 97
printf '%s:%s\\n' "$2" "$#" >> "$FIXTURE/adapter.argv"
`, { mode: 0o755 });
  await writeFile(path.join(f.root, 'running'), 'postgres\ncms-postgres\n');
  const invoke = (script, action) => f.run(`: > "$PORTAL_OPERATION_LOCK"
exec 9<>"$PORTAL_OPERATION_LOCK"
export PORTAL_OPERATION_LOCK_HELD="$PORTAL_OPERATION_LOCK" COMPOSE_PROJECT_NAME=fixture
bash "$PWD/${script}" ${action} "$PWD/release" ''`);
  for (const action of ['close-admission', 'quiescence-proof']) {
    const result = invoke('real-guard', action);
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(await readFile(path.join(f.root, 'adapter.argv'), 'utf8'), 'close-admission:4\nquiescence-proof:4\n');
  // Replay the original two-argument calls: the actual entrypoint rejects them
  // before executing even the synthetic Python adapter, reproducing exit 2.
  await writeFile(path.join(f.root, 'old-guard'), dispatchSource
    .replace('"$control" close-admission "$release" "$evidence"', '"$control" close-admission "$release"')
    .replace('"$control" quiescence-proof "$release" "$evidence"', '"$control" quiescence-proof "$release"'));
  for (const action of ['close-admission', 'quiescence-proof']) {
    const result = invoke('old-guard', action);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, 'Invalid Payload control invocation.\n');
  }
  assert.equal(await readFile(path.join(f.root, 'adapter.argv'), 'utf8'), 'close-admission:4\nquiescence-proof:4\n');
});

test('coordinator classifies early explicit exits and isolates known guard errors from unknown private output', async t => {
  const f = await fixture(t);
  const diagnostic = r => createCommandDiagnostic({ substep: 'payload_coordinator_backup', status: r.status,
    stderr: r.stderr, coordinatorCommandContext: 'payload-coordinator:backup' });
  const invalid = f.run('PAYLOAD_OPERATIONS_GUARD="$PWD/missing" bash release/scripts/payload-operations.sh backup "$PWD/release"');
  assert.equal(invalid.status, 2);
  assert.equal(diagnostic(invalid).coordinatorStep, 'guard_configuration');
  for (const [stderr, reason] of [['unsafe_required_owner', 'unsafe_required_owner'], ['private-value-token', null]]) {
    const result = f.run('bash release/scripts/payload-operations.sh backup "$PWD/release"', {
      FAIL_GUARD: 'close-admission', FAIL_GUARD_STDERR: stderr,
    });
    assert.equal(result.status, 42);
    const parsed = diagnostic(result);
    assert.equal(parsed.coordinatorStep, 'guard_close_admission');
    assert.equal(parsed.controlErrorIdentifier, reason);
    assert.doesNotMatch(JSON.stringify(parsed), /private-value-token/u);
  }
  assert.doesNotMatch(await readFile(path.join(f.root, 'calls'), 'utf8'), /pg_dump|pg_restore| start /u);
});

test('coordinator preserves primary restore step/status when destructive failure cleanup also fails', async t => {
  const f = await fixture(t);
  assert.equal(f.run('bash release/scripts/backup.sh "$PWD/release"').status, 0);
  const [name] = await readdir(path.join(f.root, 'backups'));
  const result = f.run(`PRE_RESTORE_BACKUP_DIR="$PWD/protection" RESTORE_BASE_URL=http://fixture.invalid bash release/scripts/payload-operations.sh restore "$PWD/release" "$PWD/backups/${name}" --confirm RESTORE`, {
    FAIL_RESTORE: 'true', FAIL_CLEANUP_STOP: 'true',
  });
  assert.equal(result.status, 43, result.stderr);
  assert.match(result.stderr, /private-cleanup-output/u);
  const parsed = createCommandDiagnostic({ substep: 'payload_coordinator_restore', status: result.status,
    stderr: result.stderr, coordinatorCommandContext: 'payload-coordinator:restore' });
  assert.equal(parsed.coordinatorStep, 'restore_portal_database');
  assert.equal(parsed.commandExitCode, 43);
  assert.equal(parsed.controlErrorIdentifier, null, 'cleanup output cannot impersonate the primary guard');
  assert.doesNotMatch(JSON.stringify(parsed), /private-cleanup-output/u);
  assert.equal((await readFile(path.join(f.root, 'admission'), 'utf8')).trim(), 'closed');
});
