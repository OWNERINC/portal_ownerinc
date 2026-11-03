import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const sha = 'a'.repeat(40);
const image = name => `ghcr.io/ownerinc/ownerinc-portal-${name}@sha256:${'b'.repeat(64)}`;
const read = file => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
const cleanEnv = {
  ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
  PATH: process.env.PATH, LC_ALL: 'C',
};

// None of these stubs can forward a request to Docker, AWS, Certbot or a service.
const fakeDocker = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' "$@" >> "$TEST_ROOT/docker.calls"
printf '\\0' >> "$TEST_ROOT/docker.calls"
if [[ $1 == exec ]]; then
  printf 'No renewals were attempted.\\n'
  exit "\${TEST_TLS_STATUS:-0}"
fi
[[ $1 == compose ]] || exit 90
if [[ \${TEST_REAL_FLOCK:-false} == true ]]; then
  if /usr/bin/flock -n "$PORTAL_ROOT/runtime/deploy.lock" true; then exit 91; fi
fi
printf '%s\\n' "$API_IMAGE" "$CRON_IMAGE" "$BACKUP_UPLOAD_S3" "$RETENTION_DAYS" "$LEAVE_STOPPED" > "$TEST_ROOT/policy"
shift
while (($#)); do
  case $1 in
    --profile|--project-directory|--env-file|--file|--project-name) shift 2 ;;
    *) break ;;
  esac
done
command=$1
shift
case $command in
  ps) cat "$TEST_ROOT/running" ;;
  stop) printf 'postgres\\n' > "$TEST_ROOT/running" ;;
  start)
    if [[ \${TEST_FAILURE:-} == start ]]; then exit 43; fi
    printf '%s\\n' postgres "$@" > "$TEST_ROOT/running"
    if [[ \${TEST_FAILURE:-} == corrupt ]]; then
      printf 'corrupt' >> "$BACKUP_DIR"/*/postgres.dump
    elif [[ \${TEST_FAILURE:-} == incomplete-manifest ]]; then
      for manifest in "$BACKUP_DIR"/*/manifest.sha256; do
        head -n 1 "$manifest" > "$manifest.incomplete"
        mv "$manifest.incomplete" "$manifest"
      done
    fi
    ;;
  exec)
    [[ \${!#} == pg_dump* ]] || exit 92
    if [[ \${TEST_FAILURE:-} == dump ]]; then exit 42; fi
    printf 'database fixture\\n'
    ;;
  run)
    [[ " $* " == *' --entrypoint tar api '* ]] || exit 93
    printf 'uploads fixture\\n'
    ;;
  *) exit 94 ;;
esac
`;

const fakeFlock = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$TEST_ROOT/flock.args"
if [[ \${TEST_REAL_FLOCK:-false} == true ]]; then exec /usr/bin/flock "$@"; fi
if [[ \${TEST_UPDATE_CURRENT:-false} == true ]]; then
  printf '%s\\n' "$PORTAL_ROOT/releases/${sha}" > "$PORTAL_ROOT/current-release"
fi
exit "\${TEST_FLOCK_STATUS:-0}"
`;

const runner = `set -euo pipefail
cd -- "$1"
export TEST_ROOT=$PWD HOME=$PWD PATH="$PWD/bin:/usr/bin:/bin"
[[ $(command -v docker) == "$PWD/bin/docker" ]] || exit 95
[[ $(command -v flock) == "$PWD/bin/flock" ]] || exit 96
export PORTAL_ROOT="\${PORTAL_ROOT-$PWD/app root}"
export PORTAL_ENV_FILE="\${PORTAL_ENV_FILE-$PWD/private/runtime.conf}"
export PORTAL_BACKUP_DIR="\${PORTAL_BACKUP_DIR-$PWD/backups/daily}"
case $2 in
  backup) exec bash "$PWD/backup-from-timer.sh" ;;
  tls) exec bash "$PWD/renew-portal-certificate.sh" ;;
  held-lock)
    exec 8>>"$PORTAL_ROOT/runtime/deploy.lock"
    /usr/bin/flock -n 8
    TEST_REAL_FLOCK=true PORTAL_LOCK_WAIT_SECONDS=1 bash "$PWD/backup-from-timer.sh" 8>&-
    ;;
  wait-lock)
    (
      exec 8>>"$PORTAL_ROOT/runtime/deploy.lock"
      /usr/bin/flock -n 8
      touch "$TEST_ROOT/locked"
      sleep 0.3
      printf '%s\\n' "$PORTAL_ROOT/releases/${sha}" > "$PORTAL_ROOT/current-release"
    ) &
    holder=$!
    while [[ ! -f $TEST_ROOT/locked ]]; do sleep 0.01; done
    TEST_REAL_FLOCK=true PORTAL_LOCK_WAIT_SECONDS=3 bash "$PWD/backup-from-timer.sh"
    wait "$holder"
    ;;
  *) exit 97 ;;
esac
`;

async function fixture(t) {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash';
  const available = spawnSync(bash, ['--version'], { encoding: 'utf8', env: cleanEnv });
  if (process.platform === 'win32' && available.error?.code === 'ENOENT') {
    t.skip('Git Bash unavailable; rerun in Linux');
    return null;
  }
  assert.equal(available.status, 0, available.stderr);
  const temp = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp/opencode') : tmpdir();
  const root = await mkdtemp(path.join(temp, 'portal timers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const probe = spawnSync(bash, ['-c', 'cd -- "$1" && pwd -P', 'fixture', root.replaceAll('\\', '/')], {
    encoding: 'utf8', env: cleanEnv,
  });
  assert.equal(probe.status, 0, probe.stderr);
  const shellRoot = probe.stdout.trim();
  const app = path.join(root, 'app root');
  const release = path.join(app, 'releases', sha);
  const shellRelease = `${shellRoot}/app root/releases/${sha}`;
  for (const dir of [path.join(release, 'scripts'), path.join(app, 'runtime'), path.join(root, 'private'), path.join(root, 'bin'), path.join(root, 'backups/daily')]) {
    await mkdir(dir, { recursive: true });
  }
  for (const name of ['backup-from-timer.sh', 'renew-portal-certificate.sh']) {
    await copyFile(`ops/${name}`, path.join(root, name));
    await chmod(path.join(root, name), 0o644);
  }
  await copyFile('scripts/backup.sh', path.join(release, 'scripts/backup.sh'));
  await chmod(path.join(release, 'scripts/backup.sh'), 0o644);
  await writeFile(path.join(release, 'docker-compose.yml'), '# Fake Docker does not load services.\n');
  await writeFile(path.join(release, '.image-env'), `API_IMAGE=${image('api')}\nCRON_IMAGE=${image('cron')}\n`);
  await writeFile(path.join(app, 'current-release'), `${shellRelease}\n`);
  await writeFile(path.join(app, 'runtime/compose.production.yaml'), '# Isolated override.\n');
  await writeFile(path.join(root, 'private/runtime.conf'), '# No production credentials.\n');
  await writeFile(path.join(root, 'running'), 'nginx\ncron\napi\npostgres\n');
  for (const [name, source] of [['docker', fakeDocker], ['flock', fakeFlock], ['aws', '#!/bin/sh\nexit 98\n']]) {
    await writeFile(path.join(root, 'bin', name), source, { mode: 0o755 });
  }
  const run = (action = 'backup', env = {}) => {
    const result = spawnSync(bash, ['-c', runner, 'timer-test', root.replaceAll('\\', '/'), action], {
      encoding: 'utf8', timeout: 20000,
      env: {
        ...cleanEnv, API_IMAGE: 'wrong:tag', CRON_IMAGE: 'wrong:tag',
        BACKUP_UPLOAD_S3: 'true', LEAVE_STOPPED: 'true', RETENTION_DAYS: '1',
        COMPOSE_PROJECT_NAME: 'wrong-project', COMPOSE_ENV_FILE: '/wrong-env', COMPOSE_OVERRIDE: '/wrong-override',
        ...env,
      },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, `${result.stdout}\n${result.stderr}`);
    return { ...result, output: `${result.stdout}\n${result.stderr}` };
  };
  const calls = async () => {
    const value = await readFile(path.join(root, 'docker.calls'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    return value ? value.slice(0, -2).split('\0\0').map(call => call.split('\0')) : [];
  };
  return { root, app, release, shellRoot, shellRelease, run, calls };
}

function commands(calls, f, override) {
  return calls.map(args => {
    assert.deepEqual(args.slice(0, 13), [
      'compose', '--profile', 'notifications', '--env-file', `${f.shellRoot}/private/runtime.conf`,
      '--file', `${f.shellRelease}/docker-compose.yml`, '--file', override,
      '--project-name', 'ownerinc-portal-prod', '--project-directory', f.shellRelease,
    ]);
    return args.slice(13);
  });
}

async function rejectedWithoutDocker(f, result) {
  assert.equal(result.status, 2, result.output);
  assert.deepEqual(await f.calls(), []);
  assert.doesNotMatch(result.stdout, /Backup created|verified/);
}

for (const releaseOverride of [false, true]) {
  test(`daily backup executes the real 0644 helper with receiver override precedence (${releaseOverride})`, async t => {
    const f = await fixture(t); if (!f) return;
    let override = `${f.shellRoot}/app root/runtime/compose.production.yaml`;
    if (releaseOverride) {
      await writeFile(path.join(f.release, 'compose.ownerinc-vps.yaml'), '# Release override.\n');
      override = `${f.shellRelease}/compose.ownerinc-vps.yaml`;
    }
    const old = path.join(f.root, 'backups/daily/old');
    const recent = path.join(f.root, 'backups/daily/recent');
    const outside = path.join(f.root, 'backups/pre-release');
    for (const directory of [old, recent, outside]) await mkdir(directory);
    const age = days => new Date(Date.now() - days * 86400000);
    await utimes(old, age(16), age(16));
    await utimes(recent, age(13), age(13));
    await utimes(outside, age(16), age(16));
    const result = f.run();
    assert.equal(result.status, 0, result.output);
    assert.match(result.stdout, /Local backup verified:/);
    assert.doesNotMatch(result.stdout, /Backup created:/);
    assert.equal(await readFile(path.join(f.root, 'policy'), 'utf8'), `${image('api')}\n${image('cron')}\nfalse\n14\nfalse\n`);
    assert.equal(await readFile(path.join(f.root, 'flock.args'), 'utf8'), '-w\n300\n9\n');
    const actual = commands(await f.calls(), f, override);
    assert.deepEqual(actual.map(args => args[0]), ['ps', 'stop', 'exec', 'run', 'start']);
    assert.deepEqual(actual[1], ['stop', 'nginx', 'cron', 'api']);
    assert.deepEqual(actual[4], ['start', 'nginx', 'cron', 'api']);
    assert.deepEqual((await readFile(path.join(f.root, 'running'), 'utf8')).trim().split('\n').sort(), ['api', 'cron', 'nginx', 'postgres']);
    const entries = await readdir(path.join(f.root, 'backups/daily'));
    assert.ok(!entries.includes('old'));
    assert.ok(entries.includes('recent'));
    assert.ok((await stat(outside)).isDirectory());
    const destination = path.join(f.root, 'backups/daily', entries.find(name => /^\d{8}T\d{6}Z$/.test(name)));
    for (const [name, content] of [['postgres.dump', 'database fixture\n'], ['uploads.tar.gz', 'uploads fixture\n']]) {
      assert.equal(await readFile(path.join(destination, name), 'utf8'), content);
      if (process.platform !== 'win32') assert.equal((await stat(path.join(destination, name))).mode & 0o777, 0o600);
    }
    if (process.platform !== 'win32') {
      assert.equal((await stat(destination)).mode & 0o777, 0o700);
      assert.equal((await stat(path.join(f.root, 'backups/daily'))).mode & 0o777, 0o700);
    }
  });
}

test('current release is read after the deploy lock is acquired, not before waiting', async t => {
  const f = await fixture(t); if (!f) return;
  await writeFile(path.join(f.app, 'current-release'), 'stale pointer\n');
  const result = f.run('backup', { TEST_UPDATE_CURRENT: 'true' });
  assert.equal(result.status, 0, result.output);
  assert.ok((await f.calls()).length > 0);
});

test('unsafe current-release paths are rejected before Docker', async t => {
  for (const value of ['', sha, `releases/${sha}`, 'uppercase', 'short', 'traversal', 'outside', 'multiline', 'blank-line', 'crlf']) {
    await t.test(value || 'empty', async t => {
      const f = await fixture(t); if (!f) return;
      const candidates = {
        uppercase: `${f.shellRoot}/app root/releases/${sha.toUpperCase()}`,
        short: f.shellRelease.slice(0, -1), traversal: `${f.shellRelease}/../${sha}`,
        outside: `${f.shellRoot}/other/releases/${sha}`, multiline: `${f.shellRelease}\n${f.shellRelease}`,
        'blank-line': `${f.shellRelease}\n`, crlf: `${f.shellRelease}\r`,
      };
      await writeFile(path.join(f.app, 'current-release'), `${candidates[value] ?? value}\n`);
      await rejectedWithoutDocker(f, f.run());
    });
  }
});

test('missing release/runtime inputs are rejected before Docker', async t => {
  for (const relative of ['app root/current-release', `app root/releases/${sha}/.image-env`, `app root/releases/${sha}/scripts/backup.sh`, `app root/releases/${sha}/docker-compose.yml`, 'private/runtime.conf', 'app root/runtime/compose.production.yaml']) {
    await t.test(relative, async t => {
      const f = await fixture(t); if (!f) return;
      await rm(path.join(f.root, relative));
      await rejectedWithoutDocker(f, f.run());
    });
  }
});

test('configuration rejects relative/empty/overlapping paths and unbounded lock waits', async t => {
  for (const env of [
    { PORTAL_ROOT: '' }, { PORTAL_ROOT: 'relative' }, { PORTAL_ENV_FILE: 'relative' },
    { PORTAL_BACKUP_DIR: '/' }, { PORTAL_LOCK_WAIT_SECONDS: '0' }, { PORTAL_LOCK_WAIT_SECONDS: '-1' },
    { PORTAL_LOCK_WAIT_SECONDS: '1; true' }, { PORTAL_LOCK_WAIT_SECONDS: '99999' },
  ]) {
    const f = await fixture(t); if (!f) return;
    await rejectedWithoutDocker(f, f.run('backup', env));
  }
  for (const dir of ['app root/runtime', '']) {
    const f = await fixture(t); if (!f) return;
    await rejectedWithoutDocker(f, f.run('backup', { PORTAL_BACKUP_DIR: `${f.shellRoot}${dir ? `/${dir}` : ''}` }));
  }
});

test('release manifest is parsed by backup.sh, never sourced or replaced by inherited image tags', async t => {
  const f = await fixture(t); if (!f) return;
  await writeFile(path.join(f.release, '.image-env'), `touch "$TEST_ROOT/executed"\nAPI_IMAGE=${image('api')}\nCRON_IMAGE=${image('cron')}\n`);
  await writeFile(path.join(f.root, 'private/runtime.conf'), 'touch "$TEST_ROOT/runtime-executed"\n');
  const result = f.run();
  assert.equal(result.status, 0, result.output);
  await assert.rejects(stat(path.join(f.root, 'executed')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(f.root, 'runtime-executed')), { code: 'ENOENT' });
  assert.match(await readFile(path.join(f.root, 'policy'), 'utf8'), /@sha256:/);
});

test('invalid image digest containing shell substitution fails without executing it or Docker', async t => {
  const f = await fixture(t); if (!f) return;
  await writeFile(path.join(f.release, '.image-env'), `API_IMAGE=$(touch "$TEST_ROOT/executed")\nCRON_IMAGE=${image('cron')}\n`);
  await rejectedWithoutDocker(f, f.run());
  await assert.rejects(stat(path.join(f.root, 'executed')), { code: 'ENOENT' });
});

for (const [failure, status] of [['dump', 42], ['start', 43], ['retention', 44], ['corrupt', 1], ['incomplete-manifest', 1]]) {
  test(`backup failure (${failure}) stays nonzero and never announces verified success`, async t => {
    const f = await fixture(t); if (!f) return;
    if (failure === 'retention') await writeFile(path.join(f.root, 'bin/find'), '#!/bin/sh\nexit 44\n', { mode: 0o755 });
    const result = f.run('backup', { TEST_FAILURE: failure });
    assert.equal(result.status, status, result.output);
    assert.doesNotMatch(result.stdout, /Backup created|Local backup verified/);
    assert.ok((await f.calls()).length > 0);
  });
}

test('lock acquisition failure is a failed job, not a skipped successful backup', async t => {
  const f = await fixture(t); if (!f) return;
  const result = f.run('backup', { TEST_FLOCK_STATUS: '1', PORTAL_LOCK_WAIT_SECONDS: '2' });
  assert.equal(result.status, 75, result.output);
  assert.match(result.stderr, /deploy lock/);
  assert.deepEqual(await f.calls(), []);
  assert.doesNotMatch(result.stdout, /verified/);
  assert.equal(await readFile(path.join(f.root, 'flock.args'), 'utf8'), '-w\n2\n9\n');
});

test('Linux real flock excludes a concurrent receiver and times out; waiting resolves the new release under lock', async t => {
  if (process.platform !== 'linux') return t.skip('Linux flock semantics are checked in the isolated Linux run');
  const busy = await fixture(t);
  const started = Date.now();
  const result = busy.run('held-lock');
  assert.equal(result.status, 75, result.output);
  assert.ok(Date.now() - started >= 900, 'must wait rather than silently skip a busy lock');
  assert.deepEqual(await busy.calls(), []);
  const waiting = await fixture(t);
  await writeFile(path.join(waiting.app, 'current-release'), 'old invalid pointer\n');
  const resumed = waiting.run('wait-lock');
  assert.equal(resumed.status, 0, resumed.output);
  // Every Docker stub invocation independently attempts the receiver lock and
  // fails the test if it can acquire it while the backup is running.
  assert.equal((await waiting.calls()).length, 5);
});

test('Linux rejects symlink escape paths for release, runtime, backup, lock and required files', async t => {
  if (process.platform !== 'linux') return t.skip('Git Bash symlinks are not Linux filesystem semantics');
  for (const relative of [`app root/releases/${sha}`, 'app root/releases', 'app root/runtime', 'backups/daily', 'private/runtime.conf', `app root/releases/${sha}/scripts/backup.sh`, `app root/releases/${sha}/compose.ownerinc-vps.yaml`, 'app root/runtime/deploy.lock']) {
    await t.test(relative, async t => {
      const f = await fixture(t);
      const selected = path.join(f.root, relative);
      const target = path.join(f.root, 'outside');
      const isDirectory = ['app root/releases', 'app root/runtime', 'backups/daily', `app root/releases/${sha}`].includes(relative);
      if (isDirectory) await mkdir(target);
      else await writeFile(target, '# Not trusted through a symlink.\n');
      await rm(selected, { force: true, recursive: true });
      await symlink(target, selected);
      await rejectedWithoutDocker(f, f.run());
    });
  }
});

for (const status of [0, 42]) {
  test(`TLS uses only the approved lineage and success-only graceful deploy hook; propagates status ${status}`, async t => {
    const f = await fixture(t); if (!f) return;
    const result = f.run('tls', { TEST_TLS_STATUS: String(status) });
    assert.equal(result.status, status, result.output);
    assert.equal(result.stdout, 'No renewals were attempted.\n');
    assert.deepEqual(await f.calls(), [[
      'exec', 'root-app-1', '/opt/certbot/bin/certbot', 'renew', '--non-interactive',
      '--cert-name', 'portal.ownerinc.com.br', '--no-random-sleep-on-renew', '--no-directory-hooks',
      '--deploy-hook', '/usr/sbin/nginx -t && /usr/sbin/nginx -s reload',
    ]]);
  });
}

test('production defaults match the receiver root/runtime lock and the dedicated daily destination', async () => {
  const backup = await read('ops/backup-from-timer.sh');
  const receiver = await read('ops/deploy-from-ci.sh');
  const root = '/opt/ownerinc/apps/portal-ownerinc-real';
  const environment = '/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf';
  assert.ok(receiver.includes(`root=${root}\n`));
  assert.ok(receiver.includes(`environment=${environment}\n`));
  assert.ok(receiver.includes('exec 9>"$runtime/deploy.lock"'));
  assert.ok(backup.includes(`root=\${PORTAL_ROOT-${root}}\n`));
  assert.ok(backup.includes(`environment=\${PORTAL_ENV_FILE-${environment}}\n`));
  assert.ok(backup.includes('backup_dir=${PORTAL_BACKUP_DIR-/opt/ownerinc/backups/portal-ownerinc/daily}\n'));
  assert.ok(backup.includes('lock="$root/runtime/deploy.lock"\n'));
  for (const file of ['ops/backup-from-timer.sh', 'ops/renew-portal-certificate.sh']) {
    assert.ok(!(await read(file)).includes('\r'), `${file} must use LF`);
  }
});

test('systemd units declare root oneshots, persistent UTC schedules and TLS jitter without enabling services', async () => {
  for (const [name, script, calendar] of [
    ['backup', 'backup', '*-*-* 06:00:00 UTC'],
    ['certificate-renewal', 'renew-certificate', '*-*-* 00,12:00:00 UTC'],
  ]) {
    const service = await read(`ops/ownerinc-portal-${name}.service`);
    const timer = await read(`ops/ownerinc-portal-${name}.timer`);
    assert.match(service, /^Type=oneshot$/m);
    assert.match(service, /^User=root$/m);
    assert.match(service, /^UMask=0077$/m);
    assert.ok(service.includes(`ExecStart=/bin/bash /usr/local/libexec/ownerinc-portal-${script}\n`));
    assert.doesNotMatch(service, /RemainAfterExit|Restart=|SuccessExitStatus|\[Install\]/);
    assert.ok(timer.includes(`OnCalendar=${calendar}\n`));
    assert.match(timer, /^Persistent=true$/m);
    assert.match(timer, /^WantedBy=timers.target$/m);
    assert.ok(timer.includes(`Unit=ownerinc-portal-${name}.service\n`));
    if (name === 'certificate-renewal') assert.match(timer, /^RandomizedDelaySec=30min$/m);
    else assert.doesNotMatch(timer, /RandomizedDelaySec/);
    assert.ok(!service.includes('\r') && !timer.includes('\r'), 'units must use LF');
  }
});
