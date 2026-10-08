import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

const repository = path.resolve('.');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const cmsImage = `ghcr.io/ownerinc/ownerinc-portal-cms@sha256:${'6eaddc9a333ba682508a09a4ae8a6409d9e571abab9ec4a62829c2e9828730b0'}`;
const apiImage = `ghcr.io/ownerinc/ownerinc-portal-api@sha256:${'a'.repeat(64)}`;
const cronImage = `ghcr.io/ownerinc/ownerinc-portal-cron@sha256:${'b'.repeat(64)}`;
const commit = 'd285029970c82d48cd50cc393a054af4cbfdf1e8';
const previousReceiver = 'previous receiver\n';
const previousReceiverHash = createHash('sha256').update(previousReceiver).digest('hex');

function bashPath(value) {
  const normalized = value.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : normalized;
}

function validCmsConfiguration({ includePublicUrl = true } = {}) {
  const values = {
    CMS_POSTGRES_PASSWORD: 'a'.repeat(64),
    CMS_MIGRATOR_PASSWORD: 'b'.repeat(64),
    CMS_RUNTIME_PASSWORD: 'c'.repeat(64),
    PAYLOAD_SECRET: 'd'.repeat(64),
    PAYLOAD_TO_PORTAL_SECRET: 'e'.repeat(64),
    PORTAL_TO_PAYLOAD_SECRET: 'f'.repeat(64),
  };
  Object.assign(values, {
    CMS_ADMIN_DATABASE_URL: `postgresql://cms_admin:${values.CMS_POSTGRES_PASSWORD}@cms-postgres:5432/ownerinc_cms`,
    CMS_MIGRATION_DATABASE_URL: `postgresql://cms_migrator:${values.CMS_MIGRATOR_PASSWORD}@cms-postgres:5432/ownerinc_cms`,
    CMS_RUNTIME_DATABASE_URL: `postgresql://cms_runtime:${values.CMS_RUNTIME_PASSWORD}@cms-postgres:5432/ownerinc_cms`,
  });
  const publicUrl = includePublicUrl ? 'PORTAL_PUBLIC_URL=https://portal.ownerinc.com.br\n' : '';
  return `${publicUrl}${Object.entries(values).map(([key, value]) => `${key === 'CMS_POSTGRES_PASSWORD' ? 'export ' : ''}${key}=${value}`).join('\n')}\n`;
}

async function fixture(t) {
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
  const root = await mkdtemp(path.join(parent, 'cms-preparation-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const paths = {
    app: path.join(root, 'apps', 'portal-ownerinc-real'),
    runtime: path.join(root, 'apps', 'portal-ownerinc-real', 'runtime'),
    release: path.join(root, 'apps', 'portal-ownerinc-real', 'releases', commit),
    secrets: path.join(root, 'secrets', 'portal-ownerinc'),
    backups: path.join(root, 'backups', 'portal-ownerinc', 'production'),
    libexec: path.join(root, 'usr', 'local', 'libexec'),
    bundle: path.join(root, 'bundle'),
    bin: path.join(root, 'bin'),
  };
  await Promise.all(Object.values(paths).map(value => mkdir(value, { recursive: true })));
  await mkdir(path.join(paths.app, 'releases'), { recursive: true });
  await writeFile(path.join(paths.app, 'current-release'), `${bashPath(paths.release)}\n`);
  await writeFile(path.join(paths.release, 'docker-compose.yml'), 'services: {}\n');
  await writeFile(path.join(paths.release, '.image-env'), `API_IMAGE=${apiImage}\nCRON_IMAGE=${cronImage}\n`);
  await writeFile(path.join(paths.runtime, 'deploy.lock'), 'shared deployment lock inode; never truncate or unlink\n');
  await writeFile(path.join(paths.runtime, 'compose.production.yaml'), 'services: {}\n');
  await writeFile(path.join(paths.secrets, 'production.runtime.conf'), [
    '# existing production configuration (must stay byte-for-byte intact)',
    'PRESERVED_OPERATOR_VALUE=literal-$(touch-never-run-this)',
    '',
  ].join('\n'));
  await chmod(path.join(paths.secrets, 'production.runtime.conf'), 0o600);
  await writeFile(path.join(paths.libexec, 'ownerinc-portal-deploy'), previousReceiver);
  await chmod(path.join(paths.libexec, 'ownerinc-portal-deploy'), 0o755);
  await writeFile(path.join(paths.runtime, 'payload-operations-guard'), 'previous guard\n');
  await chmod(path.join(paths.runtime, 'payload-operations-guard'), 0o755);
  await writeFile(path.join(paths.bundle, 'docker-compose.payload.yml'), await readFile('docker-compose.payload.yml'));
  await mkdir(path.join(paths.bundle, 'ops'));
  for (const file of ['deploy-from-ci.sh', 'payload-operations-guard.sh', 'compose.payload.production.yaml', 'prepare-cms-infrastructure-private.py']) {
    const source = path.join(repository, 'ops', file);
    await copyFile(source, path.join(paths.bundle, 'ops', file));
  }

  // The installed program has fixed production paths and no --root switch. Only
  // this disposable test copy maps those constants onto the isolated fake host.
  let installer = await readFile(path.join(repository, 'ops', 'prepare-cms-infrastructure.sh'), 'utf8');
  const replacements = [
    ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', `PATH=${bashPath(paths.bin)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`],
    ['/opt/ownerinc/apps/portal-ownerinc-real', bashPath(paths.app)],
    ['/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf', bashPath(path.join(paths.secrets, 'production.runtime.conf'))],
    ['/opt/ownerinc/backups/portal-ownerinc/production', bashPath(paths.backups)],
    ['/usr/local/libexec', bashPath(paths.libexec)],
    ['install -o 0 -g 0', 'install'],
    ['chown 0:0 "$temporary"', ':'],
  ];
  for (const [from, to] of replacements) {
    assert.ok(installer.includes(from), `expected fixed production path ${from}`);
    installer = installer.replaceAll(from, to);
  }
  installer = installer.replace('expected_installed_receiver=30be4941fe15c1c75e16175625685e2f51acc6ceaa52db146d61684cdacce0f7',
    `expected_installed_receiver=${previousReceiverHash}`);
  const rootOwnedModeGate = 'root_owned_mode() { [[ $(stat -c \'%u:%g:%a\' -- "$1") == "0:0:$2" ]]; }';
  assert.ok(installer.includes(rootOwnedModeGate), 'root-owned install modes must be checked on production');
  installer = installer.replace(rootOwnedModeGate, 'root_owned_mode() { [[ -f $1 ]]; }');
  const rootCheck = 'if [[ $(uname -s) != Linux || $(id -u) != 0 ]]; then';
  assert.ok(installer.includes(rootCheck), 'test copy can only bypass the Linux/root host gate');
  installer = installer.replace(rootCheck, 'if [[ ${CMS_PREPARATION_TEST_HOST:-} != 1 ]]; then');
  const securePathCheck = /# Inspect every existing path component[\s\S]*?^fi\n\n(?=# The receiver and daily backup share this lease)/mu;
  assert.match(installer, securePathCheck, 'fixed-path security inspection must remain in the production source');
  installer = installer.replace(securePathCheck, '# Fake host paths are confined to this temporary fixture.\n\n');
  await writeFile(path.join(paths.bundle, 'ops', 'prepare-cms-infrastructure.sh'), installer);

  const dockerLog = path.join(root, 'docker.calls');
  const composeEnvironmentLog = path.join(root, 'compose.environment');
  const flockLog = path.join(root, 'flock.calls');
  const dockerLogShell = bashPath(dockerLog);
  const composeEnvironmentLogShell = bashPath(composeEnvironmentLog);
  const flockLogShell = bashPath(flockLog);
  const docker = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> '${dockerLogShell}'
printf 'PORTAL_PUBLIC_URL=%s\\n' "\${PORTAL_PUBLIC_URL:-}" >> '${composeEnvironmentLogShell}'
[[ $1 == compose ]] || exit 90
[[ " $* " == *' config --quiet '* ]] || exit 91
exit 0
`;
  await writeFile(path.join(paths.bin, 'docker'), docker, { mode: 0o755 });
  await writeFile(path.join(paths.bin, 'flock'), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${flockLogShell}'\n[[ $1 == -n && $2 == 9 ]] || exit 92\nexit 0\n`, { mode: 0o755 });
  if (process.platform === 'win32') {
    const pythonExe = process.env.PATH.split(path.delimiter).map(directory => path.join(directory, 'python.exe')).find(existsSync);
    if (!pythonExe) return { skip: 'Windows Python runtime unavailable for private configuration fixture' };
    await writeFile(path.join(paths.bin, 'python3'), `#!/usr/bin/env bash\nexec '${pythonExe.replaceAll('\\', '/')}' "$@"\n`, { mode: 0o755 });
  }

  const script = path.join(paths.bundle, 'ops', 'prepare-cms-infrastructure.sh');
  const run = (args = ['--check']) => spawnSync(bash, [bashPath(script), ...args], {
    cwd: paths.bundle,
    encoding: 'utf8',
    timeout: 20000,
    env: {
      PATH: `${bashPath(paths.bin)}:${process.env.PATH || ''}`,
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
      CMS_PREPARATION_TEST_HOST: '1',
    },
  });
  return { root, paths, run, dockerLog, composeEnvironmentLog, flockLog };
}

test('preparation defaults to a read-only dry check and accepts only fixed host actions', async t => {
  const f = await fixture(t);
  if (f.skip) return t.skip(f.skip);
  const envPath = path.join(f.paths.secrets, 'production.runtime.conf');
  const before = await readFile(envPath);
  const lockPath = path.join(f.paths.runtime, 'deploy.lock');
  const lockBefore = await readFile(lockPath);
  const result = f.run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /DRY RUN/);
  assert.match(result.stdout, /no services started/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /literal-\$\(touch-never-run-this\)|postgresql:\/\//i);
  assert.deepEqual(await readFile(envPath), before);
  assert.deepEqual(await readFile(lockPath), lockBefore);
  assert.match(await readFile(f.flockLog, 'utf8'), /^-n 9\n/u);
  assert.equal(await readdir(f.paths.backups).then(files => files.length), 0);
  assert.equal(await readdir(f.paths.runtime).then(files => files.includes('cms-image-candidate.env')), false);
  const composeCalls = await readFile(f.dockerLog, 'utf8');
  assert.match(composeCalls, /compose .*config --quiet/);
  assert.ok(composeCalls.includes(`--file ${bashPath(path.join(f.paths.runtime, 'compose.production.yaml'))}`));
  assert.ok(!composeCalls.includes('compose.ownerinc-vps.yaml'));
  assert.equal(await readFile(f.composeEnvironmentLog, 'utf8'), 'PORTAL_PUBLIC_URL=https://portal.ownerinc.com.br\n');

  const arbitraryRoot = f.run(['--root', bashPath(f.root)]);
  assert.equal(arbitraryRoot.status, 2);
  assert.doesNotMatch(`${arbitraryRoot.stdout}${arbitraryRoot.stderr}`, /production\.runtime\.conf=/);
});

test('apply atomically prepares private credentials and reviewed files without activating services', async t => {
  const f = await fixture(t);
  if (f.skip) return t.skip(f.skip);
  const originalEnvironment = await readFile(path.join(f.paths.secrets, 'production.runtime.conf'));
  const lockPath = path.join(f.paths.runtime, 'deploy.lock');
  const lockBefore = await readFile(lockPath);
  const result = f.run(['--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /prepared \(inactive\)/i);
  assert.match(result.stdout, /payload-control.*not integrated/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /postgresql:\/\/|CMS_(?:POSTGRES|MIGRATOR|RUNTIME)_PASSWORD=/i);

  const envPath = path.join(f.paths.secrets, 'production.runtime.conf');
  const environment = await readFile(envPath, 'utf8');
  for (const originalLine of originalEnvironment.toString('utf8').split('\n').slice(0, 3)) assert.ok(environment.includes(originalLine));
  assert.ok(environment.startsWith(originalEnvironment.toString('utf8')), 'configuration update must preserve the full original byte sequence');
  const envStat = await stat(envPath);
  if (process.platform !== 'win32') assert.equal(envStat.mode & 0o777, 0o600, 'existing environment mode must be preserved');
  const values = Object.fromEntries(environment.split(/\r?\n/u).filter(line => line.includes('=')).map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
  }));
  assert.equal(values.PORTAL_PUBLIC_URL, 'https://portal.ownerinc.com.br');
  assert.equal(environment.split(/\r?\n/u).filter(line => line.startsWith('PORTAL_PUBLIC_URL=')).length, 1);
  const required = ['CMS_POSTGRES_PASSWORD', 'CMS_MIGRATOR_PASSWORD', 'CMS_RUNTIME_PASSWORD',
    'CMS_ADMIN_DATABASE_URL', 'CMS_MIGRATION_DATABASE_URL', 'CMS_RUNTIME_DATABASE_URL',
    'PAYLOAD_SECRET', 'PAYLOAD_TO_PORTAL_SECRET', 'PORTAL_TO_PAYLOAD_SECRET'];
  for (const key of required) assert.ok(values[key], `missing ${key}`);
  const secrets = ['CMS_POSTGRES_PASSWORD', 'CMS_MIGRATOR_PASSWORD', 'CMS_RUNTIME_PASSWORD',
    'PAYLOAD_SECRET', 'PAYLOAD_TO_PORTAL_SECRET', 'PORTAL_TO_PAYLOAD_SECRET'].map(key => values[key]);
  assert.equal(new Set(secrets).size, secrets.length, 'all generated credentials must be distinct');
  for (const secret of secrets) assert.match(secret, /^[A-Za-z0-9_-]{32,}$/u);
  for (const [key, user] of [['CMS_ADMIN_DATABASE_URL', 'cms_admin'], ['CMS_MIGRATION_DATABASE_URL', 'cms_migrator'],
    ['CMS_RUNTIME_DATABASE_URL', 'cms_runtime']]) {
    const url = new URL(values[key]);
    assert.equal(url.protocol, 'postgresql:');
    assert.equal(url.hostname, 'cms-postgres');
    assert.equal(url.port, '5432');
    assert.equal(url.pathname, '/ownerinc_cms');
    assert.equal(url.username, user);
    assert.equal(decodeURIComponent(url.password), values[{ cms_admin: 'CMS_POSTGRES_PASSWORD',
      cms_migrator: 'CMS_MIGRATOR_PASSWORD', cms_runtime: 'CMS_RUNTIME_PASSWORD' }[user]]);
  }

  assert.equal(await readFile(path.join(f.paths.libexec, 'ownerinc-portal-deploy'), 'utf8'), await readFile(path.join(repository, 'ops/deploy-from-ci.sh'), 'utf8'));
  assert.equal(await readFile(path.join(f.paths.runtime, 'payload-operations-guard'), 'utf8'), await readFile(path.join(repository, 'ops/payload-operations-guard.sh'), 'utf8'));
  assert.equal(await readFile(path.join(f.paths.runtime, 'compose.payload.production.yaml'), 'utf8'), await readFile(path.join(repository, 'ops/compose.payload.production.yaml'), 'utf8'));
  const candidate = await readFile(path.join(f.paths.runtime, 'cms-image-candidate.env'), 'utf8');
  assert.equal(candidate, `CMS_IMAGE=${cmsImage}\n`);
  assert.doesNotMatch(candidate, /RELEASE_FORMAT|API_IMAGE|CRON_IMAGE/);
  assert.equal(await readFile(path.join(f.paths.app, 'current-release'), 'utf8'), `${bashPath(f.paths.release)}\n`);
  assert.deepEqual(await readFile(lockPath), lockBefore);
  assert.match(await readFile(f.flockLog, 'utf8'), /^-n 9\n/u);
  assert.deepEqual((await readdir(f.paths.libexec)).sort(), ['ownerinc-portal-deploy']);
  assert.deepEqual(await readFile(path.join(f.paths.runtime, 'compose.production.yaml'), 'utf8'), 'services: {}\n');
  assert.deepEqual(await readFile(path.join(f.paths.release, '.image-env'), 'utf8'), `API_IMAGE=${apiImage}\nCRON_IMAGE=${cronImage}\n`);
  assert.equal(await readdir(f.paths.runtime).then(files => files.includes('payload-control')), false);

  const backups = await readdir(f.paths.backups);
  assert.equal(backups.length, 1);
  const backup = path.join(f.paths.backups, backups[0]);
  assert.match(backups[0], /^cms-infrastructure-preparation-/u);
  assert.equal(await readFile(path.join(backup, 'ownerinc-portal-deploy'), 'utf8'), previousReceiver);
  assert.equal(await readFile(path.join(backup, 'payload-operations-guard'), 'utf8'), 'previous guard\n');
  assert.deepEqual(await readFile(path.join(backup, 'production.runtime.conf')), originalEnvironment);
  if (process.platform !== 'win32') {
    assert.equal((await stat(backup)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(backup, 'production.runtime.conf'))).mode & 0o777, 0o600);
  }

  const calls = await readFile(f.dockerLog, 'utf8');
  assert.match(calls, /compose .*config --quiet/);
  assert.doesNotMatch(calls, /\b(?:up|pull|run|exec|start|stop|restart)\b/);

  const repeated = f.run(['--apply']);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /already prepared/i);
  assert.equal((await readdir(f.paths.backups)).length, 1, 'idempotent apply must not rotate secrets or create another backup');
  assert.equal(await readFile(envPath, 'utf8'), environment);
});

test('an existing complete CMS credential set is preserved without secret rotation', async t => {
  const f = await fixture(t);
  if (f.skip) return t.skip(f.skip);
  const environmentPath = path.join(f.paths.secrets, 'production.runtime.conf');
  const original = `${await readFile(environmentPath, 'utf8')}${validCmsConfiguration()}`;
  await writeFile(environmentPath, original);
  await chmod(environmentPath, 0o600);

  const result = f.run(['--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /prepared \(inactive\)/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /[a-f]{64}|postgresql:\/\//i);
  assert.equal(await readFile(environmentPath, 'utf8'), original);
  const backups = await readdir(f.paths.backups);
  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(f.paths.backups, backups[0], 'production.runtime.conf'), 'utf8'), original);
});

test('complete existing CMS credentials without a public URL are rejected without changes', async t => {
  const f = await fixture(t);
  if (f.skip) return t.skip(f.skip);
  const environmentPath = path.join(f.paths.secrets, 'production.runtime.conf');
  const original = `${await readFile(environmentPath, 'utf8')}${validCmsConfiguration({ includePublicUrl: false })}`;
  await writeFile(environmentPath, original);
  await chmod(environmentPath, 0o600);

  const result = f.run(['--apply']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /existing CMS configuration lacks PORTAL_PUBLIC_URL/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /[a-f]{64}|postgresql:\/\//i);
  assert.equal(await readFile(environmentPath, 'utf8'), original);
  assert.equal((await readdir(f.paths.backups)).length, 0);
  assert.equal(await readFile(f.dockerLog, 'utf8').catch(() => ''), '');
});

test('an explicitly empty or noncanonical public URL is rejected on first CMS preparation', async t => {
  for (const publicURL of ['', 'https://attacker.invalid']) {
    const f = await fixture(t);
    if (f.skip) return t.skip(f.skip);
    const environmentPath = path.join(f.paths.secrets, 'production.runtime.conf');
    const original = `${await readFile(environmentPath, 'utf8')}PORTAL_PUBLIC_URL=${publicURL}\n`;
    await writeFile(environmentPath, original);
    await chmod(environmentPath, 0o600);

    const result = f.run(['--apply']);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /PORTAL_PUBLIC_URL is not canonical/i);
    assert.equal(await readFile(environmentPath, 'utf8'), original);
    assert.equal((await readdir(f.paths.backups)).length, 0);
    assert.equal(await readFile(f.dockerLog, 'utf8').catch(() => ''), '');
  }
});

test('Compose validation selects a protected release-local production override when present', async t => {
  const f = await fixture(t);
  if (f.skip) return t.skip(f.skip);
  const localOverride = path.join(f.paths.release, 'compose.ownerinc-vps.yaml');
  await writeFile(localOverride, 'services: {}\n');
  await chmod(localOverride, 0o644);
  const result = f.run(['--check']);
  assert.equal(result.status, 0, result.stderr);
  const calls = await readFile(f.dockerLog, 'utf8');
  assert.ok(calls.includes(`--file ${bashPath(localOverride)}`));
  assert.ok(!calls.includes(`--file ${bashPath(path.join(f.paths.runtime, 'compose.production.yaml'))}`));
});

test('an unsafe release-local override is rejected without Compose diagnostics or data leakage', async t => {
  if (process.platform === 'win32') return t.skip('Windows symlink creation may require elevated privileges');
  const f = await fixture(t);
  if (f.skip) return t.skip(f.skip);
  const localOverride = path.join(f.paths.release, 'compose.ownerinc-vps.yaml');
  const sentinel = 'release-local-override-secret-must-not-appear-0001';
  const outside = path.join(f.root, 'private-override');
  await writeFile(outside, `services: {}\n# ${sentinel}\n`);
  await symlink(outside, localOverride);
  const result = f.run(['--check']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /release-local production Compose override is unsafe/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(sentinel, 'u'));
  assert.equal(await readFile(f.dockerLog, 'utf8').catch(() => ''), '');
});

test('partial CMS credentials fail closed without backing up, rewriting, or printing values', async t => {
  const f = await fixture(t);
  if (f.skip) return t.skip(f.skip);
  const envPath = path.join(f.paths.secrets, 'production.runtime.conf');
  const partialSecret = 'partial-secret-value-that-must-never-be-printed-0001';
  const partialKey = ['CMS', 'POSTGRES', 'PASSWORD'].join('_');
  const original = `${await readFile(envPath, 'utf8')}${partialKey}=${partialSecret}\n`;
  await writeFile(envPath, original);
  await chmod(envPath, 0o600);
  const beforeReceiver = await readFile(path.join(f.paths.libexec, 'ownerinc-portal-deploy'), 'utf8');
  const result = f.run(['--apply']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /partial CMS credential set/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(partialSecret, 'u'));
  assert.equal(await readFile(envPath, 'utf8'), original);
  assert.equal(await readFile(path.join(f.paths.libexec, 'ownerinc-portal-deploy'), 'utf8'), beforeReceiver);
  assert.equal((await readdir(f.paths.backups)).length, 0);
  assert.equal(await readFile(f.dockerLog, 'utf8').catch(() => ''), '', 'refuse malformed config before Compose parsing');
});

test('an unknown installed common receiver is not replaced or backed up', async t => {
  const f = await fixture(t);
  if (f.skip) return t.skip(f.skip);
  await writeFile(path.join(f.paths.libexec, 'ownerinc-portal-deploy'), 'unexpected receiver bytes\n');
  const beforeEnvironment = await readFile(path.join(f.paths.secrets, 'production.runtime.conf'));
  const result = f.run(['--apply']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /installed common receiver differs/i);
  assert.equal(await readFile(path.join(f.paths.libexec, 'ownerinc-portal-deploy'), 'utf8'), 'unexpected receiver bytes\n');
  assert.deepEqual(await readFile(path.join(f.paths.secrets, 'production.runtime.conf')), beforeEnvironment);
  assert.equal((await readdir(f.paths.backups)).length, 0);
  assert.equal(await readFile(f.dockerLog, 'utf8').catch(() => ''), '');
});

test('symlinked production environment is rejected before lock, compose, or file writes', async t => {
  if (process.platform === 'win32') return t.skip('Windows symlink creation may require elevated privileges');
  const f = await fixture(t);
  if (f.skip) return t.skip(f.skip);
  const envPath = path.join(f.paths.secrets, 'production.runtime.conf');
  const outside = path.join(f.root, 'outside.runtime.conf');
  await copyFile(envPath, outside);
  await rm(envPath);
  await symlink(outside, envPath);
  const result = f.run(['--apply']);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /symlink|linked|unsafe production environment/i);
  assert.equal(await readFile(outside, 'utf8').then(text => text.includes('CMS_POSTGRES_PASSWORD')), false);
  assert.equal((await readdir(f.paths.backups)).length, 0);
  assert.equal(await readFile(f.dockerLog, 'utf8').catch(() => ''), '');
});

test('production overlay and receiver wiring preserve the legacy path and stay payload-gated', async () => {
  const [receiver, productionOverlay, baseProduction, installer] = await Promise.all([
    readFile('ops/deploy-from-ci.sh', 'utf8'),
    readFile('ops/compose.payload.production.yaml', 'utf8'),
    readFile('ops/compose.production.yaml', 'utf8'),
    readFile('ops/prepare-cms-infrastructure.sh', 'utf8'),
  ]);
  assert.match(receiver, /if \[\[ \$target == production \]\][\s\S]*compose\.payload\.production\.yaml/);
  assert.match(receiver, /Payload releases[\s\S]*append this after the regular production override/);
  assert.match(receiver, /--file "\$selected_override"[\s\S]*payload_production_overlay/);
  assert.match(receiver, /payload_production_overlay=\(\)/);
  assert.match(productionOverlay, /cms-postgres:[\s\S]*networks: \[backend\]/);
  assert.match(productionOverlay, /cms:[\s\S]*networks: \[backend\]/);
  assert.match(productionOverlay, /cms-worker:[\s\S]*networks: \[backend\]/);
  assert.match(productionOverlay, /no-new-privileges:true/);
  assert.match(productionOverlay, /driver: local/);
  assert.match(productionOverlay, /max-size: "10m"/);
  assert.doesNotMatch(productionOverlay, /ports\s*:/);
  assert.doesNotMatch(productionOverlay, /ownerinc_proxy|egress/);
  assert.match(baseProduction, /backend:\n\s+name: ownerinc-portal-backend\n\s+internal: true/);
  assert.doesNotMatch(installer, /--(?:root|target-root|path)\b/);
  assert.match(installer, /stat\.S_ISLNK\(value\.st_mode\)/);
  assert.match(installer, /mode & 0o022/);
  assert.match(installer, /expected_current=d285029970c82d48cd50cc393a054af4cbfdf1e8/);
  assert.match(installer, /expected_installed_receiver=30be4941fe15c1c75e16175625685e2f51acc6ceaa52db146d61684cdacce0f7/);
  assert.match(installer, /root_owned_mode\(\) \{ \[\[ \$\(stat -c '%u:%g:%a' -- "\$1"\) == "0:0:\$2" \]\]; \}/);
  assert.match(installer, /value\.st_uid != 0 or mode != 0o755/);
});

test('root-owned install mode also requires the root group', async () => {
  const installer = await readFile('ops/prepare-cms-infrastructure.sh', 'utf8');
  const declaration = installer.match(/^root_owned_mode\(\) \{.*\}$/mu)?.[0];
  assert.ok(declaration, 'expected the production root-owned mode predicate');
  const runPredicate = (owner, group, mode, expectedMode = '755') => spawnSync(bash, ['-c', [
    `stat() { printf '%s\\n' '${owner}:${group}:${mode}'; }`,
    declaration,
    `root_owned_mode /fixture ${expectedMode}`,
  ].join('\n')], { encoding: 'utf8', timeout: 5000 });
  assert.equal(runPredicate(0, 0, '755').status, 0);
  assert.notEqual(runPredicate(0, 1000, '755').status, 0, 'root uid with operator gid must be rejected');
  assert.notEqual(runPredicate(1000, 0, '755').status, 0, 'operator uid with root gid must be rejected');
  assert.notEqual(runPredicate(0, 0, '644').status, 0, 'wrong file mode must be rejected');
});

test('manual preparation rollback locks and verifies lock identity before reading the release floor', async () => {
  const documentation = await readFile('docs/operations/payload-runtime-recovery.md', 'utf8');
  const start = documentation.indexOf('sudo bash -s -- "$BACKUP_DIR"');
  const end = documentation.indexOf('\n```', start);
  assert.ok(start >= 0 && end > start, 'expected the documented rollback command');
  const rollback = documentation.slice(start, end);
  const lock = rollback.indexOf('flock -n 9');
  const floor = rollback.indexOf('$(<"$root/current-release")');
  assert.ok(lock >= 0 && floor > lock, 'the current-release floor must be read only after the shared lock is acquired');
  assert.match(rollback.slice(0, lock), /stat -Lc '%d:%i:%h'/u);
  assert.match(rollback.slice(0, lock), /\/proc\/\$\$\/fd\/9 -ef \$runtime\/deploy\.lock/u);
  assert.match(rollback.slice(lock), /\/proc\/\$\$\/fd\/9 -ef \$runtime\/deploy\.lock/u);
  assert.match(rollback.slice(0, lock), /exec 9<>"\$runtime\/deploy\.lock"/u);
});
