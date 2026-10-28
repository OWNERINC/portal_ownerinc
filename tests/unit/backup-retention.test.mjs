import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const bash = process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || 'C:/Program Files', 'Git/bin/bash.exe')
  : 'bash';
const legacyDump = 'fixture dump\n';
const legacyUploads = 'fixture uploads\n';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const legacyManifest = `${sha256(legacyDump)}  postgres.dump\n${sha256(legacyUploads)}  uploads.tar.gz\n`;

const fakeDocker = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\0' "$@" >> "$TEST_ROOT/docker.calls"
printf '\0' >> "$TEST_ROOT/docker.calls"
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
  ps) printf 'nginx\ncron\napi\npostgres\n' ;;
  stop|start) ;;
  exec)
    [[ \${FAKE_DOCKER_FAIL:-} != pg_dump ]] || exit 42
    printf 'database fixture\n'
    ;;
  run) printf 'uploads fixture\n' ;;
  *) exit 91 ;;
esac
`;

const runner = `set -euo pipefail
cd -- "$1"
export TEST_ROOT=$PWD
export PATH="$PWD/bin:/usr/bin:/bin"
export BACKUP_DIR="$PWD/backups"
export RETENTION_DAYS=1
exec bash "$PWD/release/scripts/backup.sh" "$PWD/release"
`;

async function fixture(t) {
  const available = spawnSync(bash, ['--version'], { encoding: 'utf8' });
  if (process.platform === 'win32' && available.error?.code === 'ENOENT') {
    t.skip('Git Bash is unavailable');
    return null;
  }
  assert.equal(available.status, 0, available.stderr);

  const root = await mkdtemp(path.join(tmpdir(), 'portal backup retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'release/scripts'), { recursive: true });
  await mkdir(path.join(root, 'bin'));
  await mkdir(path.join(root, 'backups'));
  await copyFile('scripts/backup.sh', path.join(root, 'release/scripts/backup.sh'));
  await writeFile(path.join(root, 'bin/docker'), fakeDocker, { mode: 0o755 });

  const run = (env = {}) => {
    const result = spawnSync(bash, ['-c', runner, 'backup-retention-test', root.replaceAll('\\', '/')], {
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
        PATH: process.env.PATH,
        LC_ALL: 'C',
        ...env,
      },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, `${result.stdout}\n${result.stderr}`);
    return { ...result, output: `${result.stdout}\n${result.stderr}` };
  };

  const dockerCalls = async () => readFile(path.join(root, 'docker.calls'), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });

  const createValidBackup = async name => {
    const directory = path.join(root, 'backups', name);
    await mkdir(directory);
    await writeFile(path.join(directory, 'postgres.dump'), legacyDump);
    await writeFile(path.join(directory, 'uploads.tar.gz'), legacyUploads);
    await writeFile(path.join(directory, 'manifest.sha256'), legacyManifest);
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(directory, old, old);
    return directory;
  };

  return { root, run, dockerCalls, createValidBackup };
}

for (const invalid of ['missing artifact', 'malformed manifest', 'checksum mismatch', 'forbidden manifest path']) {
  test(`retention preflight preserves a backup with ${invalid} and refuses before Docker`, async t => {
    const f = await fixture(t); if (!f) return;
    const directory = await f.createValidBackup('20260101T000000Z');
    if (invalid === 'missing artifact') await rm(path.join(directory, 'uploads.tar.gz'));
    if (invalid === 'malformed manifest') await writeFile(path.join(directory, 'manifest.sha256'), 'not a checksum manifest\n');
    if (invalid === 'checksum mismatch') await writeFile(path.join(directory, 'postgres.dump'), 'changed after manifest\n');
    if (invalid === 'forbidden manifest path') {
      await writeFile(
        path.join(directory, 'manifest.sha256'),
        `${sha256(legacyDump)}  ../postgres.dump\n${sha256(legacyUploads)}  uploads.tar.gz\n`,
      );
    }

    const result = f.run();
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.stderr, /Backup retention preflight failed: backup artifacts or manifest are invalid/);
    assert.equal(await f.dockerCalls(), '');
    assert.ok((await readdir(path.join(f.root, 'backups'))).includes('20260101T000000Z'));
    assert.doesNotMatch(result.stderr, /postgres\.dump|uploads\.tar\.gz|\.\.\//);
  });
}

test('retention preflight refuses an expired backup without deletion permission before Docker', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    t.skip('requires POSIX permissions under a non-root account');
    return;
  }
  const f = await fixture(t); if (!f) return;
  const firstCandidate = await f.createValidBackup('20260101T000000Z');
  const candidate = await f.createValidBackup('20260102T000000Z');
  await f.createValidBackup('20260103T000000Z');
  await chmod(candidate, 0o555);
  const result = f.run();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.stderr, /retention preflight failed/i);
  assert.equal(await f.dockerCalls(), '');
  const entries = await readdir(path.join(f.root, 'backups'));
  assert.ok(entries.includes(path.basename(firstCandidate)), 'no candidate may be removed before all candidates validate');
  assert.ok(entries.includes('20260102T000000Z'));
});

for (const kind of ['partial directory', 'regular file', 'symlink']) {
  test(`retention preflight refuses an unexpected ${kind} before Docker and preserves it`, async t => {
    const f = await fixture(t); if (!f) return;
    const unexpected = path.join(f.root, 'backups', kind === 'partial directory' ? '20260101T000000Z' : `unexpected-${kind.replace(' ', '-')}`);
    if (kind === 'partial directory') await mkdir(unexpected);
    if (kind === 'regular file') await writeFile(unexpected, 'do not remove\n');
    if (kind === 'symlink') {
      try {
        await symlink(path.join(f.root, 'release'), unexpected, 'dir');
      } catch (error) {
        if (error.code === 'EPERM') {
          t.skip('creating symlinks is not permitted on this host');
          return;
        }
        throw error;
      }
    }

    const result = f.run();
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.stderr, /retention preflight failed/i);
    assert.equal(await f.dockerCalls(), '');
    assert.ok((await readdir(path.join(f.root, 'backups'))).includes(path.basename(unexpected)));
    assert.doesNotMatch(result.stderr, /unexpected-regular-file|unexpected-symlink/);
  });
}

test('retention preflight refuses a special filesystem entry before Docker and preserves it', async t => {
  if (process.platform === 'win32') {
    t.skip('requires a POSIX FIFO');
    return;
  }
  const f = await fixture(t); if (!f) return;
  const special = path.join(f.root, 'backups', 'unexpected-special');
  const created = spawnSync('mkfifo', [special], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr);
  const result = f.run();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.stderr, /retention preflight failed/i);
  assert.equal(await f.dockerCalls(), '');
  assert.ok((await readdir(path.join(f.root, 'backups'))).includes('unexpected-special'));
  assert.doesNotMatch(result.stderr, /unexpected-special/);
});

test('retention removes only expired valid backups older than the newest valid backup', async t => {
  const f = await fixture(t); if (!f) return;
  await f.createValidBackup('20260101T000000Z');
  await f.createValidBackup('20260102T000000Z');

  const result = f.run();
  assert.equal(result.status, 0, result.output);
  const entries = await readdir(path.join(f.root, 'backups'));
  assert.ok(!entries.includes('20260101T000000Z'));
  assert.ok(entries.includes('20260102T000000Z'), 'the newest pre-existing valid backup must be preserved');
  assert.ok(entries.some(name => /^\d{8}T\d{6}Z$/.test(name) && name !== '20260102T000000Z'));
});

test('a failed new backup is preserved and reported by safe basename without automatic cleanup', async t => {
  const f = await fixture(t); if (!f) return;
  const result = f.run({ FAKE_DOCKER_FAIL: 'pg_dump' });
  assert.equal(result.status, 42, result.output);
  const entries = await readdir(path.join(f.root, 'backups'));
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^\d{8}T\d{6}Z$/);
  assert.match(result.stderr, new RegExp(`Backup attempt preserved: ${entries[0]}`));
  assert.ok(!result.stderr.includes(f.root), 'diagnostic must not disclose the backup root');
});

test('a removal failure is explicit, preserves the new backup, and does not disclose the root', async t => {
  const f = await fixture(t); if (!f) return;
  await f.createValidBackup('20260101T000000Z');
  await f.createValidBackup('20260102T000000Z');
  await writeFile(path.join(f.root, 'bin/rm'), '#!/usr/bin/env bash\nexit 44\n', { mode: 0o755 });

  const result = f.run();
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.stderr, /Backup retention failed: candidate could not be removed \(20260101T000000Z\)/);
  assert.ok(!result.stderr.includes(f.root), 'diagnostic must not disclose the backup root');
  const entries = await readdir(path.join(f.root, 'backups'));
  assert.ok(entries.includes('20260101T000000Z'));
  assert.ok(entries.includes('20260102T000000Z'));
  assert.ok(entries.some(name => /^\d{8}T\d{6}Z$/.test(name) && !name.startsWith('2026010')));
});
