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
const previousProductionReceiver = 'previous production receiver\n';
const previousReceiverHash = createHash('sha256').update(previousReceiver).digest('hex');

function bashPath(value) {
  const normalized = value.replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`) : normalized;
}

function validCmsConfiguration({ includePublicUrl = true } = {}) {
  const values = {
    CMS_POSTGRES_PASSWORD: 'a'.repeat(64),
    CMS_CONTROLLER_PASSWORD: 'g'.repeat(64),
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

async function fixture(t, { failReceiverHelperInstall = false, tamperReceiverHelperInstall = false, failRootInstall = false, failSudoers = false } = {}) {
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
    dailyBackups: path.join(root, 'backups', 'portal-ownerinc', 'daily'),
    libexec: path.join(root, 'usr', 'local', 'libexec'),
    bundle: path.join(root, 'bundle'),
    bin: path.join(root, 'bin'),
    sudoers: path.join(root, 'etc', 'sudoers.d'),
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
  await writeFile(path.join(paths.libexec, 'ownerinc-portal-deploy-production'), previousProductionReceiver);
  await writeFile(path.join(paths.runtime, 'payload-operations-guard'), 'previous guard\n');
  await chmod(path.join(paths.runtime, 'payload-operations-guard'), 0o755);
  await writeFile(path.join(paths.bundle, 'docker-compose.payload.yml'), await readFile('docker-compose.payload.yml'));
  await mkdir(path.join(paths.bundle, 'ops'));
  for (const file of ['deploy-from-ci.sh', 'deploy-from-production-ci.sh', 'payload-receiver-root.sh', 'payload-receiver-admission.py', 'payload-operations-guard.sh', 'payload-control', 'payload-control-runtime.py',
    'payload-control-state.py', 'payload-control-inventory.py', 'compose.payload.production.yaml', 'prepare-cms-infrastructure-private.py']) {
    const source = path.join(repository, 'ops', file);
    await copyFile(source, path.join(paths.bundle, 'ops', file));
  }
  const inventoryTestHelper = path.join(paths.bundle, 'ops', 'payload-control-inventory-test.py');
  const stateTestHelper = path.join(paths.bundle, 'ops', 'payload-control-state-test.py');
  let testInventorySource = await readFile(path.join(paths.bundle, 'ops', 'payload-control-inventory.py'), 'utf8');
  let testStateSource = await readFile(path.join(paths.bundle, 'ops', 'payload-control-state.py'), 'utf8');
  if (process.platform !== 'win32') {
    // Fixture-only reviewed identity, not a production owner auto-discovery.
    // The actual installer has fixed 1000:1000 and no identity override switch.
    assert.ok(testInventorySource.includes("PRODUCTION_ENVIRONMENT_OWNER = {'uid': 1000, 'gid': 1000}"));
    testInventorySource = testInventorySource
      .replace("PRODUCTION_ENVIRONMENT_OWNER = {'uid': 1000, 'gid': 1000}",
        "PRODUCTION_ENVIRONMENT_OWNER = {'uid': os.geteuid(), 'gid': os.getegid()}")
      .replace('TRUSTED_DIRECTORY_UIDS = {0, 1000}', 'TRUSTED_DIRECTORY_UIDS = {0, os.geteuid()}')
      .replace('(owner_root and info.st_uid != 0)', 'False')
      .replace('os.fchown(descriptor, 0, 0)', 'os.fchown(descriptor, os.geteuid(), os.getegid())');
    testStateSource = testStateSource.replace("'payload-control-inventory.py')", "'payload-control-inventory-test.py')");
    const privateHelperPath = path.join(paths.bundle, 'ops', 'prepare-cms-infrastructure-private.py');
    const privateSource = await readFile(privateHelperPath, 'utf8');
    assert.ok(privateSource.includes("'payload-control-inventory.py')"));
    await writeFile(privateHelperPath, privateSource.replace("'payload-control-inventory.py')",
      "'payload-control-inventory-test.py')"));
  }
  await writeFile(inventoryTestHelper, testInventorySource);
  await writeFile(stateTestHelper, testStateSource);

  // The installed program has fixed production paths and no --root switch. Only
  // this disposable test copy maps those constants onto the isolated fake host.
  let installer = await readFile(path.join(repository, 'ops', 'prepare-cms-infrastructure.sh'), 'utf8');
  const replacements = [
    ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', `PATH=${bashPath(paths.bin)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`],
    ['/opt/ownerinc/apps/portal-ownerinc-real', bashPath(paths.app)],
    ['/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf', bashPath(path.join(paths.secrets, 'production.runtime.conf'))],
    ['/opt/ownerinc/backups/portal-ownerinc/production', bashPath(paths.backups)],
    ['/opt/ownerinc/backups/portal-ownerinc/daily', bashPath(paths.dailyBackups)],
    ['/usr/local/libexec', bashPath(paths.libexec)],
    ['/etc/sudoers.d', bashPath(paths.sudoers)],
    ['/var/lib/ownerinc/payload-candidate/incoming', bashPath(path.join(root, 'incoming'))],
    ['[[ -x /usr/bin/sudo && -x /usr/sbin/visudo ]]', 'true'],
    ['/usr/sbin/visudo', 'visudo'],
    ['chown 0:0 "$sudoers_temporary"', ':'],
    ['install -o 0 -g 0', 'install'],
    ['/usr/bin/python3 -I -S', 'python3 -I -S'],
    ['chown 0:0 "$temporary"', ':'],
    ['chown 0:0 -- "$pre_restore_backup_root"', process.platform === 'win32' ? ':' : 'chown 0:0 -- "$pre_restore_backup_root"'],
  ];
  for (const [from, to] of replacements) {
    assert.ok(installer.includes(from), `expected fixed production path ${from}`);
    installer = installer.replaceAll(from, to);
  }
  const rootOwnedKeyGate = '(key_info.st_uid, stat.S_IMODE(key_info.st_mode)) != (0, 0o600)';
  const rootOwnedStateDirectoryGate = '(dir_info.st_uid, stat.S_IMODE(dir_info.st_mode)) != (0, 0o700)';
  assert.ok(installer.includes(rootOwnedKeyGate), 'production must require the signing key to be root:root 0600');
  assert.ok(installer.includes(rootOwnedStateDirectoryGate), 'production must require the state directory to be root:root 0700');
  const nonRootFixtureInstaller = installer
    .replace(rootOwnedKeyGate, '(key_info.st_uid, stat.S_IMODE(key_info.st_mode)) != (os.geteuid(), 0o600)')
    .replace(rootOwnedStateDirectoryGate, '(dir_info.st_uid, stat.S_IMODE(dir_info.st_mode)) != (os.geteuid(), 0o700)');
  assert.notEqual(nonRootFixtureInstaller, installer, 'test adaptation must match the production tuple-based owner gates');
  assert.ok(nonRootFixtureInstaller.includes('(key_info.st_uid, stat.S_IMODE(key_info.st_mode)) != (os.geteuid(), 0o600)'));
  assert.ok(nonRootFixtureInstaller.includes('(dir_info.st_uid, stat.S_IMODE(dir_info.st_mode)) != (os.geteuid(), 0o700)'));
  assert.ok(!nonRootFixtureInstaller.includes(rootOwnedKeyGate));
  assert.ok(!nonRootFixtureInstaller.includes(rootOwnedStateDirectoryGate));
  if (process.platform !== 'win32') {
    // This disposable test copy runs as the GitHub runner, not root. Adapt only
    // ownership to the fixture's effective UID; retain the production 0600/0700
    // modes and the source assertions above. Never rewrite the production script.
    installer = nonRootFixtureInstaller;
  }
  installer = installer.replace("== '0:700'", '== "$(id -u):700"');
  installer = installer.replace('chown 0:0 -- "$pre_restore_backup_root"', ':');
  installer = installer.replace('expected_installed_receiver=30be4941fe15c1c75e16175625685e2f51acc6ceaa52db146d61684cdacce0f7',
    `expected_installed_receiver=${previousReceiverHash}`);
  installer = installer.replace('b1be89c891468052aea9de917e75214c7331c9ff72a4cb3e790aae9b4007d1b6',
    createHash('sha256').update(previousProductionReceiver).digest('hex'));
  const rootOwnedModeGate = 'root_owned_mode() { [[ $(stat -c \'%u:%g:%a\' -- "$1") == "0:0:$2" ]]; }';
  assert.ok(installer.includes(rootOwnedModeGate), 'root-owned install modes must be checked on production');
  installer = installer.replace(rootOwnedModeGate, 'root_owned_mode() { [[ -f $1 ]]; }');
  const rootCheck = 'if [[ $(uname -s) != Linux || $(id -u) != 0 ]]; then';
  assert.ok(installer.includes(rootCheck), 'test copy can only bypass the Linux/root host gate');
  installer = installer.replace(rootCheck, 'if [[ ${CMS_PREPARATION_TEST_HOST:-} != 1 ]]; then');
  const securePathCheck = /# Inspect every existing path component[\s\S]*?^fi\n\n(?=# The receiver and daily backup share this lease)/mu;
  assert.match(installer, securePathCheck, 'fixed-path security inspection must remain in the production source');
  installer = installer.replace(securePathCheck, '# Fake host paths are confined to this temporary fixture.\n\n');
  // Privilege-path ownership is exercised separately with actual Python and
  // synthetic stat observations. This transport fixture may run on Windows.
  installer = installer.replace(/receiver_privilege_paths\(\) \{[\s\S]*?^\}/mu,
    'receiver_privilege_paths() { [[ $1 != create ]] || mkdir -p -m 0700 -- "$receiver_incoming"; }');
  await writeFile(path.join(paths.bundle, 'ops', 'prepare-cms-infrastructure.sh'), installer);

  const dockerLog = path.join(root, 'docker.calls');
  const composeEnvironmentLog = path.join(root, 'compose.environment');
  const flockLog = path.join(root, 'flock.calls');
  const installLog = path.join(root, 'install.calls');
  // Filesystem transport double: log atomic publications, optionally fail helper
  // publication. No real host path, owner, Docker or service is exercised here.
  await writeFile(path.join(paths.bin, 'mv'), `#!/usr/bin/env bash
target="\${!#}"
if [[ $target == '${bashPath(path.join(paths.libexec, 'ownerinc-payload-receive'))}' ]]; then
  ${failRootInstall ? 'exit 95' : ':'}
fi
printf '%s\\n' "$target" >> '${bashPath(installLog)}'
if [[ $target == '${bashPath(path.join(paths.libexec, 'payload-receiver-admission.py'))}' ]]; then
  ${failReceiverHelperInstall ? 'exit 94' : ':'}
fi
/usr/bin/mv "$@" || exit $?
if [[ $target == '${bashPath(path.join(paths.libexec, 'payload-receiver-admission.py'))}' ]]; then
  ${tamperReceiverHelperInstall ? 'printf "altered after publication\\n" > "$target"' : ':'}
fi
exit 0
`, { mode: 0o755 });
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
  await writeFile(path.join(paths.bin, 'visudo'), `#!/usr/bin/env bash\n[[ $1 == -cf ]] || exit 93\n[[ $2 != - ]] || cat >/dev/null\n${failSudoers ? '[[ $2 == - ]] || exit 96' : ':'}\nexit 0\n`, { mode: 0o755 });
  if (process.platform === 'win32') {
    const pythonExe = process.env.PATH.split(path.delimiter).map(directory => path.join(directory, 'python.exe')).find(existsSync);
    if (!pythonExe) return { skip: 'Windows Python runtime unavailable for private configuration fixture' };
    await writeFile(path.join(paths.bin, 'python3'), `#!/usr/bin/env bash
script=$1
shift
python_args=()
for argument in "$@"; do
  if [[ $argument =~ ^/[A-Za-z]/ ]]; then argument=$(cygpath --windows "$argument"); fi
  python_args+=("$argument")
done
case "$script" in
  */payload-control-inventory.py) script='${inventoryTestHelper.replaceAll('\\', '/')}' ;;
  */payload-control-state.py) script='${stateTestHelper.replaceAll('\\', '/')}' ;;
esac
exec '${pythonExe.replaceAll('\\', '/')}' "$script" "\${python_args[@]}"
`, { mode: 0o755 });
  } else {
    const pythonExe = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim();
    if (!pythonExe) return { skip: 'Python 3 unavailable for private configuration fixture' };
    const quotedPython = pythonExe.replaceAll("'", "'\\''");
    await writeFile(path.join(paths.bin, 'python3'), `#!/usr/bin/env bash
case "$1" in
  */payload-control-inventory.py) shift; exec '${quotedPython}' '${inventoryTestHelper.replaceAll("'", "'\\''")}' "$@" ;;
  */payload-control-state.py) shift; exec '${quotedPython}' '${stateTestHelper.replaceAll("'", "'\\''")}' "$@" ;;
esac
exec '${quotedPython}' "$@"
`, { mode: 0o755 });
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
  return { root, paths, run, dockerLog, composeEnvironmentLog, flockLog, installLog };
}

async function authenticatedFixture(t, options = {}) {
  const f = await fixture(t, options);
  if (f.skip) return f;
  const digest = '7'.repeat(64);
  const approvedCms = `ghcr.io/ownerinc/ownerinc-portal-cms@sha256:${'8'.repeat(64)}`;
  const callback = path.join(f.paths.libexec, 'ownerinc-payload-prepare.py');
  const log = path.join(f.root, 'context.calls');
  const refuse = path.join(f.root, 'context.refuse');
  const script = path.join(f.paths.bundle, 'ops', 'prepare-cms-infrastructure.sh');
  let source = await readFile(script, 'utf8');
  source = source.replaceAll('/opt/ownerinc/lib/payload-preparation', bashPath(f.paths.bundle))
    .replaceAll('PATH=/usr/bin:/bin LANG=C LC_ALL=C', `PATH=${bashPath(f.paths.bin)}:/usr/bin:/bin LANG=C LC_ALL=C`);
  // Preserve fixture helper routing (owner-only doubles); production still uses
  // fixed isolated Python, asserted in the source-level boundary tests.
  source = source.replace(/python3\(\) \{[^\n]+\}/u, 'python3() { command python3 "$@"; }');
  if (process.platform === 'win32') source = source.replace('${BASH_SOURCE[0]} ==', '$(cygpath --unix "${BASH_SOURCE[0]}") ==');
  await writeFile(script, source);
  // Actual context/data protocol and fixed create-inventory code, with explicit
  // authentication/lease/host observations doubled. Full cryptographic/host
  // validators and native FD9 semantics have separate tests; this is not VPS proof.
  await writeFile(callback, `import importlib.util,pathlib,sys,json,os
sys.stdout.reconfigure(newline='\\n') # Linux line protocol on the Windows transport double.
spec=importlib.util.spec_from_file_location('m',${JSON.stringify(path.join(repository, 'ops/prepare-cms-authenticated.py'))})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.HOST_ROOT=${JSON.stringify(f.paths.app)};m.RUNTIME=${JSON.stringify(f.paths.runtime)}
m.RELEASES=os.path.join(m.HOST_ROOT,'releases');m.LOCK=os.path.join(m.RUNTIME,'deploy.lock')
m.ENVIRONMENT=${JSON.stringify(path.join(f.paths.secrets, 'production.runtime.conf'))}
m.PRODUCTION_BACKUP=${JSON.stringify(f.paths.backups)}
captured={'ops/payload-control-inventory.py':pathlib.Path(${JSON.stringify(path.join(f.paths.bundle, 'ops/payload-control-inventory-test.py'))}).read_bytes()}
inv=m.load_authenticated(captured['ops/payload-control-inventory.py'],'captured-inventory.py')
# Fixture substitutes the daily-backup constant consistently in this one fixed operation.
original=inv.production_inventory
def inventory(*args):
 args=list(args);args[5]=${JSON.stringify(f.paths.dailyBackups)};return original(*[os.path.normpath(a) for a in args])
inv.production_inventory=inventory
original_create=inv.create
inv.create=lambda filename,value:original_create(os.path.normpath(filename),value)
expected=inventory(m.HOST_ROOT,m.RUNTIME,m.RELEASES,m.HOST_ROOT+'/current-release',m.LOCK,
 '',m.PRODUCTION_BACKUP,m.PRODUCTION_BACKUP+'/restore-protection',m.ENVIRONMENT,
 m.RUNTIME+'/compose.production.yaml',m.RUNTIME+'/compose.payload.production.yaml')
approval={'hostBaseline':{'currentCommit':${JSON.stringify(commit)},'inventoryIdentity':inv.identity(expected),
 'installedPredecessors':{'commonReceiver':${JSON.stringify(previousReceiverHash)},'receiverHelper':None,
 'productionWrapper':${JSON.stringify(createHash('sha256').update(previousProductionReceiver).digest('hex'))},
 'operationsGuard':${JSON.stringify(createHash('sha256').update('previous guard\n').digest('hex'))},'cmsCandidate':None}}}
def observe():
 if pathlib.Path(${JSON.stringify(refuse)}).exists():raise ValueError('context denied')
 with open(${JSON.stringify(log)},'a') as stream:stream.write(sys.argv[1]+'\\n')
m.verify_inherited_lease=observe
m.verify_host_baseline=lambda *args,**kwargs:None
m.authenticate=lambda:(approval,captured,${JSON.stringify(approvedCms)},None,${JSON.stringify(digest)})
m.load_authenticated=lambda *args:inv
if sys.argv[1]=='--verify-context':print(m.verified_context(sys.argv[2]))
elif sys.argv[1]=='--create-inventory':m.create_inventory(sys.argv[2])
else:raise ValueError('unexpected operation')
`, { mode: 0o755 });
  const run = (mode = 'check', selectedDigest = digest) => spawnSync(bash, ['-c',
    // Same-shell descriptor transport is a Windows double, not native pass_fds.
    'exec 9<>"$1"; shift; source "$@"', 'fixture-parent', bashPath(path.join(f.paths.runtime, 'deploy.lock')),
    bashPath(script), `--authenticated-${mode}`, selectedDigest], {
    cwd: f.paths.bundle, encoding: 'utf8', timeout: 60000,
    env: { PATH: `${bashPath(f.paths.bin)}:${process.env.PATH || ''}`, CMS_PREPARATION_TEST_HOST: '1',
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) },
  });
  return { ...f, runAuthenticated: run, approvedCms, refuse, log };
}

test('authenticated preparer uses fixed context protocol, inherited FD9 and approved CMS; retries preserve secrets (host/process doubles)', async t => {
  const f = await authenticatedFixture(t);
  if (f.skip) return t.skip(f.skip);
  const env = path.join(f.paths.secrets, 'production.runtime.conf');
  const before = await readFile(env);
  const check = f.runAuthenticated();
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(await readFile(env), before);
  assert.deepEqual(await readdir(f.paths.backups), []);
  assert.equal(existsSync(f.flockLog), false, 'child must not reopen/reacquire via shell flock');
  const apply = f.runAuthenticated('apply');
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(await readFile(path.join(f.paths.runtime, 'cms-image-candidate.env'), 'utf8'), `CMS_IMAGE=${f.approvedCms}\n`);
  const prepared = await readFile(env);
  const retry = f.runAuthenticated('apply');
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(await readFile(env), prepared);
  assert.match(await readFile(f.log, 'utf8'), /--create-inventory/u);
  for (const line of (await readFile(f.dockerLog, 'utf8')).trim().split('\n')) assert.match(line, / config --quiet$/u);
});

test('authenticated wrong context and dependency failure preserve receivers; direct flags do not establish authority (host doubles)', async t => {
  const f = await authenticatedFixture(t, { failReceiverHelperInstall: true });
  if (f.skip) return t.skip(f.skip);
  const wrong = f.runAuthenticated('apply', '0'.repeat(64));
  assert.notEqual(wrong.status, 0);
  assert.deepEqual(await readdir(f.paths.backups), []);
  await writeFile(f.refuse, 'deny');
  assert.notEqual(f.runAuthenticated('apply').status, 0);
  assert.deepEqual(await readdir(f.paths.backups), []);
  await rm(f.refuse);
  assert.notEqual(f.runAuthenticated('apply').status, 0);
  assert.equal(await readFile(path.join(f.paths.libexec, 'ownerinc-portal-deploy'), 'utf8'), previousReceiver);
  assert.equal(await readFile(path.join(f.paths.libexec, 'ownerinc-portal-deploy-production'), 'utf8'), previousProductionReceiver);
  const production = await readFile('ops/prepare-cms-infrastructure.sh', 'utf8');
  assert.match(production, /authenticated=false/u);
  assert.match(production, /expected_current=d285029970c82d48cd50cc393a054af4cbfdf1e8/u);
  assert.ok(production.includes(cmsImage), 'legacy CMS pin remains unchanged');
  assert.doesNotMatch(production, /\$\{?APPROVED/u);
});

test('missing receiver helper is installed and verified before receiver publication (fake host)', async t => {
  const f = await fixture(t);
  if (f.skip) return t.skip(f.skip);
  const helper = path.join(f.paths.libexec, 'payload-receiver-admission.py');
  assert.equal(existsSync(helper), false);
  const check = f.run(['--check']);
  assert.equal(check.status, 0, check.stderr);
  assert.equal(existsSync(helper), false, 'dry run must not install dependency');
  const applied = f.run(['--apply']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(await readFile(helper, 'utf8'), await readFile('ops/payload-receiver-admission.py', 'utf8'));
  const publications = (await readFile(f.installLog, 'utf8')).trim().split('\n');
  const helperIndex = publications.indexOf(bashPath(helper));
  const receiverIndex = publications.indexOf(bashPath(path.join(f.paths.libexec, 'ownerinc-portal-deploy')));
  assert.ok(helperIndex >= 0 && receiverIndex > helperIndex, 'helper must precede receiver rename');
});

for (const fault of ['missing-launcher', 'root-publication', 'sudoers-validation']) {
  test(`privilege dependency ${fault} preserves both old receivers (fake host)`, async t => {
    const f = await fixture(t, { failRootInstall: fault === 'root-publication', failSudoers: fault === 'sudoers-validation' });
    if (f.skip) return t.skip(f.skip);
    if (fault === 'missing-launcher') await rm(path.join(f.paths.bundle, 'ops', 'payload-receiver-root.sh'));
    const result = f.run(['--apply']);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(path.join(f.paths.libexec, 'ownerinc-portal-deploy'), 'utf8'), previousReceiver);
    assert.equal(await readFile(path.join(f.paths.libexec, 'ownerinc-portal-deploy-production'), 'utf8'), previousProductionReceiver);
    assert.equal(existsSync(path.join(f.paths.sudoers, 'ownerinc-payload-receive')), false);
  });
}

test('reviewed predecessor helper upgrades with a retained private copy, without broadening source approval (fake host)', async t => {
  const f = await fixture(t);
  if (f.skip) return t.skip(f.skip);
  const source = await readFile('ops/payload-receiver-admission.py', 'utf8');
  const previous = source.replace("INCOMING = '/var/lib/ownerinc/payload-candidate/incoming'",
    "INCOMING = '/opt/ownerinc/apps/portal-ownerinc-real/incoming'");
  assert.equal(createHash('sha256').update(previous).digest('hex'), 'ffe1c2ed3fb086e156401063cdeaf9c6575a49e3458b202928df7f6794587bf8');
  const helper = path.join(f.paths.libexec, 'payload-receiver-admission.py');
  await writeFile(helper, previous);
  const result = f.run(['--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(helper, 'utf8'), source);
  const snapshot = (await readdir(f.paths.backups)).find(name => name.startsWith('cms-infrastructure-preparation-'));
  assert.ok(snapshot);
  assert.equal(await readFile(path.join(f.paths.backups, snapshot, 'payload-receiver-admission.py'), 'utf8'), previous);
  assert.equal(await readFile(path.join(f.paths.backups, snapshot, 'ownerinc-portal-deploy-production'), 'utf8'), previousProductionReceiver);
});

test('failed receiver-helper publication leaves the working receiver untouched (fake host)', async t => {
  const f = await fixture(t, { failReceiverHelperInstall: true });
  if (f.skip) return t.skip(f.skip);
  const result = f.run(['--apply']);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(f.paths.libexec, 'ownerinc-portal-deploy'), 'utf8'), previousReceiver);
  assert.equal(existsSync(path.join(f.paths.libexec, 'payload-receiver-admission.py')), false);
});

test('receiver is not published if helper post-install verification fails (fake host)', async t => {
  const f = await fixture(t, { tamperReceiverHelperInstall: true });
  if (f.skip) return t.skip(f.skip);
  const result = f.run(['--apply']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /receiver helper installation did not verify/u);
  assert.equal(await readFile(path.join(f.paths.libexec, 'ownerinc-portal-deploy'), 'utf8'), previousReceiver);
});

for (const defect of ['missing-source', 'invalid-source', 'unknown-installed-helper', 'missing-interpreter']) {
  test(`receiver dependency preflight refuses ${defect} without replacing the receiver (fake host)`, async t => {
    const f = await fixture(t);
    if (f.skip) return t.skip(f.skip);
    const helperSource = path.join(f.paths.bundle, 'ops', 'payload-receiver-admission.py');
    if (defect === 'missing-source') await rm(helperSource);
    if (defect === 'invalid-source') await writeFile(helperSource, 'invalid python source !\n');
    if (defect === 'unknown-installed-helper') {
      const target = path.join(f.paths.libexec, 'payload-receiver-admission.py');
      await writeFile(target, '# unexpected dependency\n');
      await chmod(target, 0o755);
    }
    if (defect === 'missing-interpreter') {
      const script = path.join(f.paths.bundle, 'ops', 'prepare-cms-infrastructure.sh');
      const source = await readFile(script, 'utf8');
      assert.ok(source.includes('python3 -I -S -c'));
      await writeFile(script, source.replace('python3 -I -S -c', '/nonexistent/receiver-python -I -S -c'));
    }
    const result = f.run(['--apply']);
    assert.equal(result.status, 2, result.stderr);
    assert.equal(await readFile(path.join(f.paths.libexec, 'ownerinc-portal-deploy'), 'utf8'), previousReceiver);
    assert.deepEqual(await readdir(f.paths.backups), [], 'preflight must precede backups and changes');
  });
}

test('production installer binds the fixed helper, root chain, mode and interpreter before receiver publication', async () => {
  const source = await readFile('ops/prepare-cms-infrastructure.sh', 'utf8');
  assert.match(source, /receiver_helper_target=\/usr\/local\/libexec\/payload-receiver-admission\.py/u);
  assert.match(source, /env -i PATH="\$PATH" \/usr\/bin\/python3 -I -S -c/u);
  assert.match(source, /\(value\.st_uid, value\.st_gid\) != \(0, 0\) or stat\.S_IMODE\(value\.st_mode\) & 0o7022/u);
  assert.match(source, /path == files\[-2\].*mode != 0o755/u);
  const helperInstall = source.indexOf('atomic_install "$source_receiver_helper" "$receiver_helper_target" 0755');
  const postCheck = source.indexOf('file_installed "$receiver_helper_target" "$source_receiver_helper" 755 || {', helperInstall);
  assert.ok(helperInstall > 0 && postCheck > helperInstall);
  assert.ok(source.indexOf('atomic_install "$source_receiver" "$receiver_target" 0755') > postCheck);
});

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
  const originalEnvironmentStat = await stat(path.join(f.paths.secrets, 'production.runtime.conf'));
  const lockPath = path.join(f.paths.runtime, 'deploy.lock');
  const lockBefore = await readFile(lockPath);
  const result = f.run(['--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /prepared \(inactive\)/i);
  assert.match(result.stdout, /private host-only signing key and explicit worker hold/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /postgresql:\/\/|CMS_(?:POSTGRES|MIGRATOR|RUNTIME)_PASSWORD=/i);

  const envPath = path.join(f.paths.secrets, 'production.runtime.conf');
  const environment = await readFile(envPath, 'utf8');
  for (const originalLine of originalEnvironment.toString('utf8').split('\n').slice(0, 3)) assert.ok(environment.includes(originalLine));
  assert.ok(environment.startsWith(originalEnvironment.toString('utf8')), 'configuration update must preserve the full original byte sequence');
  const envStat = await stat(envPath);
  if (process.platform !== 'win32') {
    assert.equal(envStat.mode & 0o777, 0o600, 'existing environment mode must be preserved');
    assert.equal(envStat.uid, originalEnvironmentStat.uid, 'existing approved owner must be preserved');
    assert.equal(envStat.gid, originalEnvironmentStat.gid, 'existing approved group must be preserved');
  }
  const values = Object.fromEntries(environment.split(/\r?\n/u).filter(line => line.includes('=')).map(line => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
  }));
  assert.equal(values.PORTAL_PUBLIC_URL, 'https://portal.ownerinc.com.br');
  assert.equal(environment.split(/\r?\n/u).filter(line => line.startsWith('PORTAL_PUBLIC_URL=')).length, 1);
  const required = ['CMS_POSTGRES_PASSWORD', 'CMS_CONTROLLER_PASSWORD', 'CMS_MIGRATOR_PASSWORD', 'CMS_RUNTIME_PASSWORD',
    'CMS_ADMIN_DATABASE_URL', 'CMS_MIGRATION_DATABASE_URL', 'CMS_RUNTIME_DATABASE_URL',
    'PAYLOAD_SECRET', 'PAYLOAD_TO_PORTAL_SECRET', 'PORTAL_TO_PAYLOAD_SECRET'];
  for (const key of required) assert.ok(values[key], `missing ${key}`);
  const secrets = ['CMS_POSTGRES_PASSWORD', 'CMS_CONTROLLER_PASSWORD', 'CMS_MIGRATOR_PASSWORD', 'CMS_RUNTIME_PASSWORD',
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
  assert.deepEqual((await readdir(f.paths.libexec)).sort(), ['ownerinc-payload-receive', 'ownerinc-portal-deploy', 'ownerinc-portal-deploy-production', 'payload-receiver-admission.py']);
  assert.equal(await readFile(path.join(f.paths.libexec, 'ownerinc-payload-receive'), 'utf8'), await readFile('ops/payload-receiver-root.sh', 'utf8'));
  assert.equal(await readFile(path.join(f.paths.libexec, 'ownerinc-portal-deploy-production'), 'utf8'), await readFile('ops/deploy-from-production-ci.sh', 'utf8'));
  assert.equal(await readFile(path.join(f.paths.sudoers, 'ownerinc-payload-receive'), 'utf8'),
    `deploy ALL=(root) NOPASSWD: NOSETENV: ${bashPath(f.paths.libexec)}/ownerinc-payload-receive\n`);
  const publications = (await readFile(f.installLog, 'utf8')).split('\n');
  const publicationIndex = (directory, name) => publications.indexOf(bashPath(path.join(directory, name)));
  assert.ok(publicationIndex(f.paths.libexec, 'payload-receiver-admission.py') < publicationIndex(f.paths.libexec, 'ownerinc-payload-receive'));
  assert.ok(publicationIndex(f.paths.libexec, 'ownerinc-payload-receive') < publicationIndex(f.paths.sudoers, 'ownerinc-payload-receive'));
  assert.ok(publicationIndex(f.paths.sudoers, 'ownerinc-payload-receive') < publicationIndex(f.paths.libexec, 'ownerinc-portal-deploy-production'));
  assert.deepEqual(await readFile(path.join(f.paths.runtime, 'compose.production.yaml'), 'utf8'), 'services: {}\n');
  assert.deepEqual(await readFile(path.join(f.paths.release, '.image-env'), 'utf8'), `API_IMAGE=${apiImage}\nCRON_IMAGE=${cronImage}\n`);
  assert.equal(await readFile(path.join(f.paths.runtime, 'payload-control'), 'utf8'), await readFile('ops/payload-control', 'utf8'));
  assert.equal(await readFile(path.join(f.paths.runtime, 'payload-control-runtime.py'), 'utf8'), await readFile('ops/payload-control-runtime.py', 'utf8'));
  assert.equal(await readFile(path.join(f.paths.runtime, 'payload-control-state.py'), 'utf8'), await readFile('ops/payload-control-state.py', 'utf8'));
  assert.equal(await readFile(path.join(f.paths.runtime, 'payload-control-inventory.py'), 'utf8'), await readFile('ops/payload-control-inventory.py', 'utf8'));
  const inventory = JSON.parse(await readFile(path.join(f.paths.runtime, 'payload-control-inventory.json'), 'utf8'));
  if (process.platform !== 'win32') {
    const privateKeyStat = await stat(path.join(f.paths.runtime, 'payload-control.key'));
    const stateDirectoryStat = await stat(path.join(f.paths.runtime, 'payload-control-state'));
    const inventoryStat = await stat(path.join(f.paths.runtime, 'payload-control-inventory.json'));
    assert.equal(privateKeyStat.mode & 0o777, 0o600, 'fixture key retains the production private mode');
    assert.equal(stateDirectoryStat.mode & 0o777, 0o700, 'fixture state directory retains the production private mode');
    assert.equal(inventoryStat.mode & 0o777, 0o600, 'fixture inventory retains the production private mode');
    if (process.getuid) {
      assert.equal(privateKeyStat.uid, process.getuid());
      assert.equal(stateDirectoryStat.uid, process.getuid());
      assert.equal(inventoryStat.uid, process.getuid());
    }
  }
  assert.equal(inventory.project, 'ownerinc-portal-prod');
  assert.equal(inventory.schemaVersion, 2);
  assert.deepEqual(inventory.environmentFileOwner, process.platform === 'win32'
    ? { uid: 1000, gid: 1000 } : { uid: process.getuid(), gid: process.getgid() });
  assert.deepEqual(inventory.paths.backupRoots.map(bashPath).sort(), [bashPath(f.paths.backups), bashPath(f.paths.dailyBackups)].sort());
  assert.deepEqual(Object.keys(inventory.volumes).sort(), ['cmsPostgres', 'cmsUploads', 'portalPostgres', 'portalUploads']);
  if (process.platform !== 'win32') {
    assert.equal(await stat(path.join(f.paths.backups, 'restore-protection')).then(info => info.mode & 0o777), 0o700);
  }
  let stateEntries;
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    const result = spawnSync('sudo', ['-n', 'ls', path.join(f.paths.runtime, 'payload-control-state')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    stateEntries = result.stdout.split(/\r?\n/u);
  } else {
    stateEntries = await readdir(path.join(f.paths.runtime, 'payload-control-state'));
  }
  assert.equal(stateEntries.includes('current.json'), true);

  const backups = (await readdir(f.paths.backups)).filter(name => name.startsWith('cms-infrastructure-preparation-'));
  assert.equal(backups.length, 1);
  const backup = path.join(f.paths.backups, backups[0]);
  assert.equal((await readdir(backup)).includes('payload-control.key'), false);
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
  assert.equal((await readFile(path.join(f.paths.runtime, 'payload-control.key'))).length, 32);
  const stateVerification = spawnSync(bash, [bashPath(path.join(f.paths.bin, 'python3')),
    bashPath(path.join(f.paths.bundle, 'ops', 'payload-control-state.py')), 'verify-state', bashPath(f.paths.runtime)], {
    encoding: 'utf8', env: { PATH: `${bashPath(f.paths.bin)}:${process.env.PATH || ''}`, ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) },
  });
  assert.equal(stateVerification.status, 0, stateVerification.stderr);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /already prepared/i);
  assert.equal((await readdir(f.paths.backups)).filter(name => name.startsWith('cms-infrastructure-preparation-')).length, 1,
    'idempotent apply must not rotate secrets or create another backup');
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
  const backups = (await readdir(f.paths.backups)).filter(name => name.startsWith('cms-infrastructure-preparation-'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(f.paths.backups, backups[0], 'production.runtime.conf'), 'utf8'), original);
});

test('apply upgrades the prior complete private CMS configuration by adding only a distinct controller credential', async t => {
  const f = await fixture(t);
  if (f.skip) return t.skip(f.skip);
  const envPath = path.join(f.paths.secrets, 'production.runtime.conf');
  const prior = validCmsConfiguration().replace(/^CMS_CONTROLLER_PASSWORD=.*\n/mu, '');
  await writeFile(envPath, prior, { mode: 0o600 });

  const check = f.run(['--check']);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /DRY RUN/u);
  assert.deepEqual(await readFile(envPath, 'utf8'), prior, 'read-only check must not migrate the existing private file');
  assert.equal(await readdir(f.paths.backups).then(files => files.length), 0);

  const result = f.run(['--apply']);
  assert.equal(result.status, 0, result.stderr);
  const updated = await readFile(envPath, 'utf8');
  assert.ok(updated.startsWith(prior), 'the prior complete configuration remains byte-for-byte intact');
  const added = updated.slice(prior.length).trimEnd().split(/\r?\n/u);
  assert.equal(added.length, 1);
  assert.match(added[0], /^CMS_CONTROLLER_PASSWORD=[A-Za-z0-9_-]{64}$/u);
  assert.ok(!added[0].endsWith('a'.repeat(64)) && !added[0].endsWith('b'.repeat(64))
    && !added[0].endsWith('c'.repeat(64)));
  const backupNames = (await readdir(f.paths.backups)).filter(name => name.startsWith('cms-infrastructure-preparation-'));
  assert.equal(backupNames.length, 1, 'the old private file is retained in the approved backup before migration');
  assert.equal(await readFile(path.join(f.paths.backups, backupNames[0], 'production.runtime.conf'), 'utf8'), prior);
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
  assert.match(installer, /\(value\.st_uid, value\.st_gid\) != \(1000, 1000\) or mode != 0o600/);
  assert.ok(installer.indexOf('cms_env_state=$(python3 "$source_private_helper" inspect') < installer.indexOf('backup_name='),
    'private owner/ancestry validation must precede the first apply snapshot or install');
});

test('old inventories are refused before installation without rewriting owner policy or signed state', async t => {
  const f = await fixture(t);
  if (f.skip) return t.skip(f.skip);
  const inventoryPath = path.join(f.paths.runtime, 'payload-control-inventory.json');
  const oldInventory = '{"schemaVersion":1}\n';
  await writeFile(inventoryPath, oldInventory, { mode: 0o600 });
  const receiverBefore = await readFile(path.join(f.paths.libexec, 'ownerinc-portal-deploy'));
  const envBefore = await readFile(path.join(f.paths.secrets, 'production.runtime.conf'));
  const result = f.run(['--apply']);
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /protected Payload inventory differs/);
  assert.equal(await readFile(inventoryPath, 'utf8'), oldInventory);
  assert.deepEqual(await readFile(path.join(f.paths.libexec, 'ownerinc-portal-deploy')), receiverBefore);
  assert.deepEqual(await readFile(path.join(f.paths.secrets, 'production.runtime.conf')), envBefore);
  assert.equal((await readdir(f.paths.backups)).length, 0);
  assert.equal(await readFile(f.dockerLog, 'utf8').catch(() => ''), '');
  assert.equal(existsSync(path.join(f.paths.runtime, 'payload-control.key')), false);
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
