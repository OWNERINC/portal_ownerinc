import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dump = 'local database fixture\n';
const uploads = 'local uploads fixture\n';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const manifest = `${sha256(dump)}  postgres.dump\n${sha256(uploads)}  uploads.tar.gz\n`;
const services = ['nginx', 'cron', 'api', 'postgres'];

// These executables never forward to Docker or AWS. The runner also checks PATH
// before starting the real scripts, and receives no cloud/Docker credentials.
const fakeAws = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' "$@" >> "$TEST_ROOT/aws.calls"
printf '\\0' >> "$TEST_ROOT/aws.calls"
exit "\${FAKE_AWS_STATUS:-0}"
`;

const fakeDocker = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' "$@" >> "$TEST_ROOT/docker.calls"
printf '\\0' >> "$TEST_ROOT/docker.calls"
[[ $1 == compose ]] || exit 90
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
  stop)
    kept=()
    while IFS= read -r service; do
      remove=false
      for stopped in "$@"; do
        if [[ $service == "$stopped" ]]; then remove=true; fi
      done
      if [[ $remove == false ]]; then kept+=("$service"); fi
    done < "$TEST_ROOT/running"
    printf '%s\\n' "\${kept[@]}" > "$TEST_ROOT/running"
    ;;
  start)
    for service in "$@"; do
      grep -qx "$service" "$TEST_ROOT/running" || printf '%s\\n' "$service" >> "$TEST_ROOT/running"
    done
    ;;
  up)
    printf 'nginx\\ncron\\napi\\npostgres\\n' > "$TEST_ROOT/running"
    if [[ \${FAKE_DOCKER_FAIL:-} == restart ]]; then exit 42; fi
    ;;
  exec)
    case \${!#} in
      pg_dump*)
        if [[ \${FAKE_DOCKER_FAIL:-} == pg_dump ]]; then exit 42; fi
        printf 'local database fixture\\n'
        ;;
      pg_restore*)
        if [[ \${FAKE_DOCKER_FAIL:-} == pg_restore ]]; then exit 42; fi
        cat > "$TEST_ROOT/restored.dump"
        ;;
      psql*) ;;
      *) exit 91 ;;
    esac
    ;;
  run)
    case " $* " in
      *' --entrypoint tar '*) printf 'local uploads fixture\\n' ;;
      *' tar -xzf '*) cat > "$TEST_ROOT/restored.uploads" ;;
      *' find /app/uploads '*|*' migrate '*) ;;
      *) exit 92 ;;
    esac
    ;;
  *) exit 93 ;;
esac
`;

const runner = `set -euo pipefail
cd -- "$1"
export TEST_ROOT=$PWD
printf '%s' "$PWD" > "$TEST_ROOT/bash-root"
export HOME=$PWD
export PATH="$PWD/bin:/usr/bin:/bin"
[[ $(command -v docker) == "$PWD/bin/docker" ]] || exit 94
[[ $(command -v aws) == "$PWD/bin/aws" ]] || exit 95
export PROJECT_ROOT="$PWD/release with spaces"
export BACKUP_DIR="$PWD/backups with spaces"
export PRE_RESTORE_BACKUP_DIR="$PWD/pre restore backups"
export COMPOSE_ENV_FILE="$PWD/compose env.conf"
export COMPOSE_OVERRIDE="$PWD/compose override.yaml"
export COMPOSE_PROJECT_NAME=portal-backup-test
export RESTORE_BASE_URL=http://restore.invalid
case $2 in
  s3) exec bash "$PROJECT_ROOT/scripts/backup-s3.sh" "$PWD/source backup" ;;
  s3-env) BACKUP_DIR="$PWD/source backup" exec bash "$PROJECT_ROOT/scripts/backup-s3.sh" ;;
  backup) exec bash "$PROJECT_ROOT/scripts/backup.sh" "$PROJECT_ROOT" ;;
  restore) exec bash "$PROJECT_ROOT/scripts/restore.sh" "$PWD/source backup" --confirm RESTORE ;;
  *) exit 96 ;;
esac
`;

async function fixture(t) {
  const bash = process.platform === 'win32'
    ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe') : 'bash';
  const available = spawnSync(bash, ['--version'], { encoding: 'utf8' });
  if (process.platform === 'win32' && available.error?.code === 'ENOENT') {
    t.skip('Git Bash is unavailable');
    return null;
  }
  assert.equal(available.status, 0, available.stderr);
  const root = await mkdtemp(path.join(tmpdir(), 'portal backup s3-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = path.join(root, 'release with spaces/scripts');
  await mkdir(scripts, { recursive: true });
  await mkdir(path.join(root, 'bin'));
  await mkdir(path.join(root, 'source backup'));
  for (const name of ['backup-s3.sh', 'backup.sh', 'restore.sh']) {
    await copyFile(`scripts/${name}`, path.join(scripts, name));
    await chmod(path.join(scripts, name), 0o644);
  }
  const image = name => `example.invalid/ownerinc-portal-${name}@sha256:${'a'.repeat(64)}`;
  await writeFile(path.join(root, 'release with spaces/.image-env'), `API_IMAGE=${image('api')}\nCRON_IMAGE=${image('cron')}\n`);
  await writeFile(path.join(root, 'compose env.conf'), '# No real environment or credentials.\n');
  await writeFile(path.join(root, 'compose override.yaml'), '# Fake Docker never reads this file.\n');
  await writeFile(path.join(root, 'running'), `${services.join('\n')}\n`);
  await writeFile(path.join(root, 'source backup/postgres.dump'), dump);
  await writeFile(path.join(root, 'source backup/uploads.tar.gz'), uploads);
  await writeFile(path.join(root, 'source backup/manifest.sha256'), manifest);
  // Restore's smoke is isolated too: no HTTP request leaves the harness.
  await writeFile(path.join(scripts, 'smoke.sh'), 'printf "%s\\n" "$BASE_URL" > "$TEST_ROOT/smoke.log"\n');
  for (const [name, source] of [['aws', fakeAws], ['docker', fakeDocker]]) {
    await writeFile(path.join(root, 'bin', name), source, { mode: 0o755 });
  }
  const run = (action, env = {}) => {
    const result = spawnSync(bash, ['-c', runner, 'backup-test', root.replaceAll('\\', '/'), action], {
      encoding: 'utf8', timeout: 30000,
      env: {
        // Windows needs its system directory to launch Git Bash; nothing else
        // (especially BACKUP_*, BASH_ENV, AWS_* or DOCKER_*) is inherited.
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
        PATH: process.env.PATH, LC_ALL: 'C', S3_BUCKET: 'test-bucket', ...env,
      },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, `${result.stdout}\n${result.stderr}`);
    return { ...result, output: `${result.stdout}\n${result.stderr}` };
  };
  const calls = async name => {
    const contents = await readFile(path.join(root, `${name}.calls`), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    return contents ? contents.slice(0, -2).split('\0\0').map(call => call.split('\0')) : [];
  };
  const running = async () => (await readFile(path.join(root, 'running'), 'utf8')).trim().split('\n').sort();
  const shellRoot = () => readFile(path.join(root, 'bash-root'), 'utf8');
  return { root, scripts, run, calls, running, shellRoot };
}

async function assertBackup(directory) {
  assert.equal(await readFile(path.join(directory, 'postgres.dump'), 'utf8'), dump);
  assert.equal(await readFile(path.join(directory, 'uploads.tar.gz'), 'utf8'), uploads);
  // Git Bash emits the binary marker (*); Linux sha256sum defaults to text.
  const actualManifest = await readFile(path.join(directory, 'manifest.sha256'), 'utf8');
  assert.equal(actualManifest.replace(/ \*/g, '  '), manifest);
}

async function onlyBackup(root, name) {
  const parent = path.join(root, name);
  const entries = await readdir(parent);
  assert.equal(entries.length, 1, `Expected exactly one backup in ${parent}`);
  assert.match(entries[0], /^\d{8}T\d{6}Z$/);
  const directory = path.join(parent, entries[0]);
  await assertBackup(directory);
  return directory;
}

function composeCommands(calls, root) {
  return calls.map(args => {
    const project = `${root}/release with spaces`;
    assert.deepEqual(args.slice(0, 13), [
      'compose', '--profile', 'notifications', '--env-file', `${root}/compose env.conf`,
      '--file', `${project}/docker-compose.yml`, '--file', `${root}/compose override.yaml`,
      '--project-name', 'portal-backup-test', '--project-directory', project,
    ]);
    return args.slice(13);
  });
}

test('S3 helper invokes aws with the default endpoint and preserves spaced path arguments', async t => {
  const f = await fixture(t); if (!f) return;
  const result = f.run('s3');
  assert.equal(result.status, 0, result.output);
  const calls = await f.calls('aws');
  assert.deepEqual(calls, [[
    's3', 'cp', '--recursive', `${await f.shellRoot()}/source backup/`,
    's3://test-bucket/portal-ownerinc/source backup/',
  ]]);
  await assertBackup(path.join(f.root, 'source backup'));
});

test('S3 helper accepts BACKUP_DIR, a custom endpoint and a spaced prefix as separate arguments', async t => {
  const f = await fixture(t); if (!f) return;
  const endpoint = 'https://storage.invalid:9443/custom endpoint';
  const result = f.run('s3-env', { AWS_ENDPOINT_URL: endpoint, S3_PREFIX: 'daily copies/' });
  assert.equal(result.status, 0, result.output);
  const calls = await f.calls('aws');
  assert.deepEqual(calls, [[
    '--endpoint-url', endpoint, 's3', 'cp', '--recursive', `${await f.shellRoot()}/source backup/`,
    's3://test-bucket/daily copies/source backup/',
  ]]);
});

for (const invalid of ['checksum mismatch', 'malformed manifest']) {
  test(`S3 helper rejects ${invalid} before invoking aws`, async t => {
    const f = await fixture(t); if (!f) return;
    const file = invalid === 'checksum mismatch' ? 'postgres.dump' : 'manifest.sha256';
    await writeFile(path.join(f.root, 'source backup', file), 'invalid fixture\n');
    const result = f.run('s3');
    assert.equal(result.status, 1, result.output);
    assert.deepEqual(await f.calls('aws'), []);
    assert.equal(await readFile(path.join(f.root, 'source backup', file), 'utf8'), 'invalid fixture\n');
    assert.doesNotMatch(result.stdout, /Backup uploaded/);
  });
}

test('S3 helper propagates an AWS failure without changing the verified local backup', async t => {
  const f = await fixture(t); if (!f) return;
  const result = f.run('s3', { FAKE_AWS_STATUS: '42' });
  assert.equal(result.status, 42, result.output);
  assert.equal((await f.calls('aws')).length, 1);
  assert.doesNotMatch(result.stdout, /Backup uploaded/);
  await assertBackup(path.join(f.root, 'source backup'));
});

for (const awsStatus of ['0', '42']) {
  test(`backup invokes its 0644 helper through Bash and preserves local data (AWS status ${awsStatus})`, async t => {
    const f = await fixture(t); if (!f) return;
    if (process.platform !== 'win32') {
      assert.equal((await stat(path.join(f.scripts, 'backup-s3.sh'))).mode & 0o777, 0o644);
    } else t.diagnostic('Windows does not enforce Unix execute bits; Linux runs assert helper mode 0644.');
    const result = f.run('backup', { BACKUP_UPLOAD_S3: 'true', FAKE_AWS_STATUS: awsStatus });
    assert.equal(result.status, awsStatus === '0' ? 0 : 3, result.output);
    const directory = await onlyBackup(f.root, 'backups with spaces');
    const calls = await f.calls('aws');
    assert.deepEqual(calls, [[
      's3', 'cp', '--recursive', `${await f.shellRoot()}/backups with spaces/${path.basename(directory)}/`,
      `s3://test-bucket/portal-ownerinc/${path.basename(directory)}/`,
    ]]);
    const commands = composeCommands(await f.calls('docker'), await f.shellRoot());
    assert.deepEqual(commands.map(args => args[0]), ['ps', 'stop', 'exec', 'run', 'start']);
    assert.deepEqual(commands[1], ['stop', 'nginx', 'cron', 'api']);
    assert.deepEqual(commands[4], ['start', 'nginx', 'cron', 'api']);
    assert.deepEqual(await f.running(), [...services].sort());
    if (awsStatus !== '0') assert.match(result.stderr, /Local backup preserved; S3 upload failed/);
  });
}

test('restore protection backup ignores inherited S3 upload even when AWS would fail', async t => {
  const f = await fixture(t); if (!f) return;
  const result = f.run('restore', { BACKUP_UPLOAD_S3: 'true', LEAVE_STOPPED: 'true', FAKE_AWS_STATUS: '42' });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(await f.calls('aws'), []);
  await onlyBackup(f.root, 'pre restore backups');
  assert.equal(await readFile(path.join(f.root, 'restored.dump'), 'utf8'), dump);
  assert.equal(await readFile(path.join(f.root, 'restored.uploads'), 'utf8'), uploads);
  const commands = composeCommands(await f.calls('docker'), await f.shellRoot());
  assert.deepEqual(commands.map(args => args[0]), ['ps', 'stop', 'exec', 'run', 'exec', 'exec', 'run', 'run', 'run', 'run', 'up']);
  assert.match(commands[5].at(-1), /^pg_restore --single-transaction/);
  assert.deepEqual(await f.running(), [...services].sort());
  assert.equal(await readFile(path.join(f.root, 'smoke.log'), 'utf8'), 'http://restore.invalid\n');
});

for (const failure of ['pg_dump', 'retention']) {
  test(`failed restore protection backup (${failure}) restarts only previously running services before any restore`, async t => {
    const f = await fixture(t); if (!f) return;
    await writeFile(path.join(f.root, 'running'), 'nginx\napi\npostgres\n');
    if (failure === 'retention') {
      await writeFile(path.join(f.root, 'bin/find'), '#!/usr/bin/env bash\nexit 43\n', { mode: 0o755 });
    }
    const result = f.run('restore', { BACKUP_UPLOAD_S3: 'true', FAKE_AWS_STATUS: '42', FAKE_DOCKER_FAIL: failure });
    assert.equal(result.status, failure === 'retention' ? 43 : 42, result.output);
    assert.deepEqual(await f.calls('aws'), []);
    const commands = composeCommands(await f.calls('docker'), await f.shellRoot());
    assert.deepEqual(commands.map(args => args[0]), failure === 'retention'
      ? ['ps', 'stop', 'exec', 'run', 'start'] : ['ps', 'stop', 'exec', 'start']);
    assert.deepEqual(commands.at(-1), ['start', 'nginx', 'api']);
    assert.deepEqual(await f.running(), ['api', 'nginx', 'postgres']);
    assert.deepEqual(await readdir(path.join(f.root, 'pre restore backups')), []);
    await assertBackup(path.join(f.root, 'source backup'));
  });
}

for (const failure of ['pg_restore', 'restart']) {
  test(`restore failure inside Compose (${failure}) reaches its trap and leaves services stopped`, async t => {
    const f = await fixture(t); if (!f) return;
    const result = f.run('restore', { BACKUP_UPLOAD_S3: 'true', FAKE_AWS_STATUS: '42', FAKE_DOCKER_FAIL: failure });
    assert.equal(result.status, 1, result.output);
    assert.match(result.stderr, /Restore failed; services remain stopped/);
    assert.deepEqual(await f.calls('aws'), []);
    await onlyBackup(f.root, 'pre restore backups');
    const commands = composeCommands(await f.calls('docker'), await f.shellRoot());
    assert.deepEqual(commands.at(-2), ['stop', 'nginx', 'api', 'cron']);
    assert.deepEqual(commands.at(-1), ['ps', '--status', 'running', '--services']);
    assert.deepEqual(await f.running(), ['postgres']);
    await assert.rejects(readFile(path.join(f.root, 'smoke.log')), { code: 'ENOENT' });
  });
}
