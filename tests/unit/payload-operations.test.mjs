import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const image = name => `ghcr.io/ownerinc/ownerinc-portal-${name}@sha256:${'b'.repeat(64)}`;
const legacy = `API_IMAGE=${image('api')}\nCRON_IMAGE=${image('cron')}\n`;
const payload = `${legacy}CMS_IMAGE=${image('cms')}\nRELEASE_FORMAT=payload-v1\n`;
const fakeDocker = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FIXTURE/calls"
[[ $1 == compose ]] || exit 90
shift
while (($#)); do
  case $1 in --profile|--project-directory|--project-name|--env-file|-f) shift 2;; *) break;; esac
done
cmd=$1; shift
case $cmd in
 ps) cat "$FIXTURE/running";;
 stop) printf 'postgres\\ncms-postgres\\n' > "$FIXTURE/running";;
 start) printf '%s\\n' "$@" >> "$FIXTURE/running";;
 up) printf 'postgres\\ncms-postgres\\nnginx\\napi\\ncms\\n' > "$FIXTURE/running";;
 exec|run)
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
[[ \${FAIL_GUARD:-} != "$1" ]] || exit 42
case $1 in
  release-preflight|restore-preflight) ! grep -qx 'cms-worker' "$FIXTURE/running";;
  quiescence-proof) ! grep -Eq '^(nginx|api|cron|cms|cms-worker)$' "$FIXTURE/running";;
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
  for (const file of ['release-manifest.sh', 'payload-operations.sh', 'backup.sh', 'restore.sh', 'backup-s3.sh']) await copyFile(`scripts/${file}`, path.join(root, 'release/scripts', file));
  await writeFile(path.join(root, 'release/.image-env'), payload);
  await writeFile(path.join(root, 'release/docker-compose.payload.yml'), '# synthetic\n');
  await writeFile(path.join(root, 'release/scripts/smoke.sh'), '#!/bin/sh\nprintf "smoke\\n" >> "$FIXTURE/smoke.calls"\n');
  await writeFile(path.join(root, 'running'), 'postgres\ncms-postgres\nnginx\napi\ncron\ncms\n');
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
    ['release-preflight', 'close-admission', 'quiescence-proof', 'backup-metadata', 'verify-release', 'open-admission']);
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
  assert.deepEqual((await readFile(path.join(f.root, 'guard.calls'), 'utf8')).trim().split('\n'),
    ['restore-preflight', 'close-admission', 'quiescence-proof', 'backup-metadata', 'prepare-restore',
      'prepare-restore', 'prepare-restore', 'prepare-restore', 'prepare-restore', 'prepare-restore',
      'prepare-restore', 'prepare-restore', 'verify-restored', 'verify-release', 'verify-release', 'open-admission']);
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
