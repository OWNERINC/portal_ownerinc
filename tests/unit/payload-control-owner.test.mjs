import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const python = (process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'])
  .find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);

async function runPython(t, source) {
  if (!python) { t.skip('Python 3 unavailable'); return; }
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
  const fixture = await mkdtemp(path.join(parent, 'payload-control-owner-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const result = spawnSync(python, ['-B', '-c', String.raw`
import copy, importlib.util, json, os, stat, sys
from types import SimpleNamespace
from unittest.mock import patch

repo, fixture = sys.argv[1:]
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(repo, 'ops', filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
I = load('owner_inventory', 'payload-control-inventory.py')
R = load('owner_runtime', 'payload-control-runtime.py')
P = load('owner_private', 'prepare-cms-infrastructure-private.py')
def expect(code, callback):
    try:
        callback()
    except (I.InventoryError, R.ControlError, P.PreparationError) as error:
        assert str(error) == code, (str(error), code)
    else:
        raise AssertionError('expected ' + code)
root = os.path.join(fixture, 'app')
runtime = os.path.join(root, 'runtime')
environment = os.path.join(fixture, 'secrets', 'runtime.conf')
args = [root, runtime, os.path.join(root, 'releases'), os.path.join(root, 'current-release'),
        os.path.join(runtime, 'deploy.lock'), os.path.join(fixture, 'daily'),
        os.path.join(fixture, 'production'), os.path.join(fixture, 'protection'), environment,
        os.path.join(runtime, 'compose.yaml'), os.path.join(runtime, 'payload.yaml')]
` + source, path.resolve('.'), fixture], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('inventory v2 fixes approved environment owners and rejects legacy/unknown/ambiguous contracts', async t => {
  await runPython(t, String.raw`
document = I.production_inventory(*args)
assert document['schemaVersion'] == 2
assert document['environmentFileOwner'] == {'uid': 1000, 'gid': 1000}
I.validate(document)
fixture_doc = copy.deepcopy(document)
fixture_doc['project'] = 'payload-preauth-owner-source'
for entry in fixture_doc['volumes'].values():
    entry['name'] = fixture_doc['project'] + '_' + entry['composeKey']
fixture_doc['environmentFileOwner'] = {'uid': 0, 'gid': 0}
I.validate(fixture_doc)
assert I.identity(document) != I.identity(fixture_doc)
for changed in [None, {'uid': 2000, 'gid': 1000}, {'uid': 1000, 'gid': 0},
                {'uid': True, 'gid': 1000}, {'uid': '1000', 'gid': 1000},
                {'uid': 1000, 'gid': 1000, 'mode': 384}, {'uid': -1, 'gid': 1000}]:
    bad = copy.deepcopy(document)
    bad['environmentFileOwner'] = changed
    expect('invalid_environment_file_owner', lambda: I.validate(bad))
bad = copy.deepcopy(document)
bad['environmentFileOwner'] = {'uid': 0, 'gid': 0}
expect('invalid_environment_file_owner', lambda: I.validate(bad))
bad = copy.deepcopy(fixture_doc)
bad['environmentFileOwner'] = {'uid': 1000, 'gid': 1000}
expect('invalid_environment_file_owner', lambda: I.validate(bad))
for version in [1, True, 3, '2']:
    bad = copy.deepcopy(document)
    bad['schemaVersion'] = version
    expect('unsupported_inventory_version', lambda: I.validate(bad))
bad = copy.deepcopy(document)
del bad['environmentFileOwner']
expect('invalid_inventory_shape', lambda: I.validate(bad))
bad = copy.deepcopy(document)
bad['environmentOwnerOverride'] = True
expect('invalid_inventory_shape', lambda: I.validate(bad))
`);
});

test('POSIX owner policy accepts only the declared private environment and protected ancestry', async t => {
  await runPython(t, String.raw`
expected = {'uid': 1000, 'gid': 1000}
def info(mode, uid=0, gid=0, links=1):
    return SimpleNamespace(st_mode=mode, st_uid=uid, st_gid=gid, st_nlink=links, st_dev=1, st_ino=2)
file_info = info(stat.S_IFREG | 0o600, 1000, 1000)
directory = info(stat.S_IFDIR | 0o755)
bad_directory = None
def lstat(selected):
    if selected == environment: return file_info
    if bad_directory is not None and selected == os.path.dirname(environment): return bad_directory
    return directory
with patch.object(I.os, 'name', 'posix'), patch.object(I.os, 'lstat', lstat), \
     patch.object(I.os.path, 'realpath', lambda value: value):
    assert I.verify_environment_file(environment, expected) is file_info
    for uid, gid in [(0, 0), (2000, 1000), (1000, 0), (1000, 2000)]:
        file_info = info(stat.S_IFREG | 0o600, uid, gid)
        expect('unsafe_environment_owner', lambda: I.verify_environment_file(environment, expected))
    for mode in [0o640, 0o660, 0o644, 0o400, 0o1600]:
        file_info = info(stat.S_IFREG | mode, 1000, 1000)
        expect('unsafe_environment_permissions', lambda: I.verify_environment_file(environment, expected))
    for mode, links in [(stat.S_IFLNK | 0o600, 1), (stat.S_IFREG | 0o600, 2),
                        (stat.S_IFDIR | 0o600, 1)]:
        file_info = info(mode, 1000, 1000, links)
        expect('unsafe_environment_file', lambda: I.verify_environment_file(environment, expected))
    file_info = info(stat.S_IFREG | 0o600, 1000, 1000)
    for mode, uid in [(stat.S_IFDIR | 0o775, 0), (stat.S_IFDIR | 0o777, 1000),
                      (stat.S_IFLNK | 0o755, 0), (stat.S_IFDIR | 0o755, 2000)]:
        bad_directory = info(mode, uid)
        expect('unsafe_environment_ancestry', lambda: I.verify_environment_file(environment, expected))
    bad_directory = info(stat.S_IFDIR | 0o755, 1000, 1000)
    I.verify_environment_file(environment, expected)
    bad_directory = None
    directory = info(stat.S_IFDIR | 0o1777)
    I.verify_environment_file(environment, expected)
    directory = info(stat.S_IFDIR | 0o1777, 1000, 1000)
    expect('unsafe_environment_ancestry', lambda: I.verify_environment_file(environment, expected))
    directory = info(stat.S_IFDIR | 0o755)
    file_info = info(stat.S_IFREG | 0o600)
    I.verify_environment_file(environment, {'uid': 0, 'gid': 0})
`);
});

test('runtime and private preparer reject unsafe environment before state/database/file effects', async t => {
  await runPython(t, String.raw`
document = I.production_inventory(*args)
effects = []
directory = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0, st_gid=0, st_nlink=1)
for mode, uid, gid, links, reason in [
    (stat.S_IFREG | 0o600, 2000, 1000, 1, 'unsafe_environment_owner'),
    (stat.S_IFREG | 0o600, 1000, 2000, 1, 'unsafe_environment_owner'),
    (stat.S_IFREG | 0o660, 1000, 1000, 1, 'unsafe_environment_permissions'),
    (stat.S_IFLNK | 0o600, 1000, 1000, 1, 'unsafe_environment_file'),
    (stat.S_IFREG | 0o600, 1000, 1000, 2, 'unsafe_environment_file'),
]:
    file_info = SimpleNamespace(st_mode=mode, st_uid=uid, st_gid=gid, st_nlink=links)
    with patch.object(I.os, 'name', 'posix'), \
         patch.object(I.os, 'lstat', lambda selected: file_info if selected == environment else directory), \
         patch.object(I.os.path, 'realpath', lambda selected: selected), \
         patch.object(R, '_load_helpers', lambda: None), \
         patch.object(R, '_inventory', lambda **_kwargs: {'document': document}), \
         patch.object(R, '_expected_compose_override', lambda _release: args[-2]), \
         patch.object(R.STATE, 'read_state', lambda *_args: effects.append('state')), \
         patch.object(R.subprocess, 'run', lambda *_args, **_kwargs: effects.append('command')), \
         patch.object(P.tempfile, 'mkstemp', lambda **_kwargs: effects.append('temporary')), \
         patch.object(P.os, 'open', lambda *_args, **_kwargs: effects.append('open')), \
         patch.dict(os.environ, {'PORTAL_OPERATION_LOCK': args[4], 'PORTAL_OPERATION_LOCK_HELD': args[4],
             'COMPOSE_PROJECT_NAME': document['project'], 'COMPOSE_ENV_FILE': environment,
             'COMPOSE_OVERRIDE': args[-2], 'PAYLOAD_CONTROL_ENVIRONMENT_UID': str(uid)}, clear=True):
        expect(reason, lambda: R.Runtime('close-admission', root, ''))
        expect(reason, lambda: R._compose_args(root))
        expect(reason, lambda: P.update(environment))
assert effects == []
assert P.PRODUCTION_ENVIRONMENT_OWNER == {'uid': 1000, 'gid': 1000}
`);
});

test('Compose consumes the approved 1000 environment without relaxing root checks on other files', async t => {
  await runPython(t, String.raw`
document = I.production_inventory(*args)
directory = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0, st_gid=0, st_nlink=1)
file_info = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=1000, st_gid=1000, st_nlink=1)
checks = []
def root_check(selected, **options):
    assert selected != environment, 'the environment must use its declared inventory policy'
    checks.append((selected, options))
with patch.object(I.os, 'name', 'posix'), \
     patch.object(I.os, 'lstat', lambda selected: file_info if selected == environment else directory), \
     patch.object(I.os.path, 'realpath', lambda selected: selected), \
     patch.object(R, '_inventory', lambda: {'document': document}), \
     patch.object(R, '_expected_compose_override', lambda _release: args[-2]), \
     patch.object(R, '_safe_regular', root_check), \
     patch.dict(os.environ, {'COMPOSE_PROJECT_NAME': document['project'], 'COMPOSE_ENV_FILE': environment,
         'COMPOSE_OVERRIDE': args[-2]}, clear=True):
    command = R._compose_args(root)
assert environment in command
assert (args[-2], {'owner_root': True}) in checks
assert (args[-1], {'owner_root': True}) in checks
`);
});

test('inventory parser rejects duplicate JSON, noncanonical transport and unsafe file ancestry', async t => {
  await runPython(t, String.raw`
document = I.production_inventory(*args)
inventory_path = os.path.join(fixture, 'inventory.json')
for raw, reason in [(b'{"schemaVersion":2,"schemaVersion":2}\n', 'duplicate_inventory_field'),
                    (json.dumps(document, indent=2).encode() + b'\n', 'noncanonical_inventory'),
                    (I.canonical(document), 'invalid_inventory_file')]:
    with open(inventory_path, 'wb') as stream: stream.write(raw)
    # Isolate transport validation from the POSIX policy tested below. No runtime
    # state is initialized and no owner policy is replaced in production code.
    with patch.object(I, '_safe_regular', lambda _path: os.stat(_path)):
        expect(reason, lambda: I.load(inventory_path))
file_info = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0, st_nlink=1)
directory_info = SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_uid=0, st_gid=0, st_nlink=1)
def lstat(selected): return file_info if selected == inventory_path else directory_info
with patch.object(I.os, 'name', 'posix'), patch.object(I.os, 'lstat', lstat), \
     patch.object(I.os.path, 'realpath', lambda value: value):
    I._safe_regular(inventory_path)
    file_info.st_uid = 1000
    expect('unsafe_inventory_permissions', lambda: I._safe_regular(inventory_path))
    file_info.st_uid = 0
    file_info.st_mode = stat.S_IFREG | 0o640
    expect('unsafe_inventory_permissions', lambda: I._safe_regular(inventory_path))
    file_info.st_mode = stat.S_IFLNK | 0o600
    expect('unsafe_inventory_file', lambda: I._safe_regular(inventory_path))
    file_info.st_mode = stat.S_IFREG | 0o600
    file_info.st_nlink = 2
    expect('unsafe_inventory_file', lambda: I._safe_regular(inventory_path))
    file_info.st_nlink = 1
    directory_info.st_uid = 2000
    expect('unsafe_inventory_ancestry', lambda: I._safe_regular(inventory_path))
    directory_info.st_uid = 0
    directory_info.st_mode = stat.S_IFDIR | 0o775
    expect('unsafe_inventory_ancestry', lambda: I._safe_regular(inventory_path))
`);
});

test('the operational environment exception never applies to root lock or private key/journal', async t => {
  await runPython(t, String.raw`
private = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0, st_nlink=1)
with patch.object(R.os, 'name', 'posix'), patch.object(R.os, 'lstat', lambda _path: private), \
     patch.object(R.os.path, 'realpath', lambda value: value), patch.object(R.os, 'geteuid', lambda: 0, create=True):
    R._safe_regular(args[4], owner_root=True)
    R.STATE._file_info(os.path.join(runtime, 'payload-control.key'), 0o600, private_owner=True)
    private.st_uid = 1000
    expect('unsafe_required_owner', lambda: R._safe_regular(args[4], owner_root=True))
    try:
        R.STATE._file_info(os.path.join(runtime, 'payload-control.key'), 0o600, private_owner=True)
    except R.STATE.StateError as error:
        assert str(error) == 'unsafe_private_key'
    else:
        raise AssertionError('operational environment owner must not authorize a private key')
    try:
        R.STATE._file_info(os.path.join(runtime, 'payload-control-state', 'current.json'), 0o600, private_owner=True)
    except R.STATE.StateError as error:
        assert str(error) == 'unsafe_private_key'
    else:
        raise AssertionError('operational environment owner must not authorize journal ownership')
`);
});

test('Linux root fixture preserves a real 1000:1000 environment and root private journal without services', async t => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    return t.skip('actual POSIX chown requires a disposable Linux root fixture; mocked policy tests run on all hosts');
  }
  await runPython(t, String.raw`
os.makedirs(runtime, mode=0o700)
os.makedirs(os.path.dirname(environment), mode=0o755)
original = b'# private fixture\nPORTAL_PUBLIC_URL=https://portal.ownerinc.com.br\n'
with open(environment, 'wb') as stream: stream.write(original)
os.chmod(environment, 0o600)
os.chown(environment, 1000, 1000)
P.update(environment)
with open(environment, 'rb') as stream: updated = stream.read()
assert updated.startswith(original)
approved = I.verify_environment_file(environment, {'uid': 1000, 'gid': 1000})
assert (approved.st_uid, approved.st_gid, stat.S_IMODE(approved.st_mode)) == (1000, 1000, 0o600)
document = I.production_inventory(*args)
I.create(os.path.join(runtime, 'payload-control-inventory.json'), document)
R.STATE.initialize(runtime, I.identity(document))
R.STATE.read_state(runtime)
for selected in ['payload-control.key', os.path.join('payload-control-state', 'current.json')]:
    observed = os.stat(os.path.join(runtime, selected))
    assert (observed.st_uid, observed.st_gid, stat.S_IMODE(observed.st_mode)) == (0, 0, 0o600)
os.chown(environment, 2000, 1000)
expect('unsafe_environment_owner', lambda: P.update(environment))
with open(environment, 'rb') as stream: assert stream.read() == updated
`);
});
