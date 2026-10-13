#!/usr/bin/python3
"""Installed administrative entrypoint for authenticated inactive preparation."""
import hashlib
import json
import os
import stat
import sys
import types
import builtins
import subprocess
from contextlib import contextmanager

HOST_ROOT = '/opt/ownerinc/apps/portal-ownerinc-real'
RUNTIME = HOST_ROOT + '/runtime'
RELEASES = HOST_ROOT + '/releases'
LOCK = RUNTIME + '/deploy.lock'
ENVIRONMENT = '/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf'
PRODUCTION_BACKUP = '/opt/ownerinc/backups/portal-ownerinc/production'

ROOT = '/opt/ownerinc/lib/payload-preparation'
LAUNCHER = '/usr/local/libexec/ownerinc-payload-prepare.py'
APPROVAL = '/etc/ownerinc/payload-preparation/production-approval.json'
FILES = (
    'ops/prepare-cms-infrastructure.sh', 'ops/prepare-cms-infrastructure-private.py',
    'ops/payload-control-inventory.py', 'ops/payload-control-state.py',
    'ops/deploy-from-ci.sh', 'ops/payload-receiver-admission.py', 'ops/payload-receiver-root.sh',
    'ops/deploy-from-production-ci.sh', 'ops/payload-operations-guard.sh', 'ops/payload-control',
    'ops/payload-control-runtime.py', 'ops/compose.payload.production.yaml', 'docker-compose.payload.yml',
    'ops/prepare-cms-authenticated.py', 'ops/provision-payload-candidate-trust.py')


class VerificationError(Exception):
    pass


def require(condition):
    if not condition:
        raise VerificationError('preparation_verification_denied')


def protected(filename, mode, limit):
    # Minimal bootstrap reader: no closure module may run to authenticate itself.
    # This launcher itself is independently authenticated at administrative install.
    def ancestry():
        require(os.path.isabs(filename) and os.path.normpath(filename) == filename)
        parent = os.path.dirname(filename)
        while True:
            info = os.lstat(parent)
            require(stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid) == (0, 0)
                    and not stat.S_IMODE(info.st_mode) & 0o7022)
            if parent == '/':
                break
            parent = os.path.dirname(parent)
    def identity(info):
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and (info.st_uid, info.st_gid) == (0, 0)
                and stat.S_IMODE(info.st_mode) == mode and 0 < info.st_size <= limit)
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
    ancestry()
    before = identity(os.lstat(filename))
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(identity(os.fstat(fd)) == before)
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read(limit + 1)
        require(len(raw) == before[2] and identity(os.fstat(fd)) == before
                and identity(os.lstat(filename)) == before)
        ancestry()
        return raw
    finally:
        os.close(fd)


def load_authenticated(raw, filename):
    module = types.ModuleType('authenticated_preparation_support')
    module.__file__ = filename
    exec(compile(raw, filename, 'exec'), module.__dict__)
    return module


def host_ancestry(filename):
    require(os.path.isabs(filename) and os.path.normpath(filename) == filename)
    parent = os.path.dirname(filename)
    while True:
        info = os.lstat(parent)
        require(stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid) in ((0, 0), (1000, 1000))
                and not stat.S_IMODE(info.st_mode) & 0o7022)
        if parent == '/':
            break
        parent = os.path.dirname(parent)


def host_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def host_read(filename, owner=(1000, 1000), modes=(0o600, 0o644), limit=2 * 1024 * 1024):
    # Host data only. Never use this weaker ancestry policy for executable trust.
    def metadata(info):
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and (info.st_uid, info.st_gid) == owner and stat.S_IMODE(info.st_mode) in modes
                and 0 < info.st_size <= limit)
        return host_identity(info)
    host_ancestry(filename)
    before = metadata(os.lstat(filename))
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(metadata(os.fstat(fd)) == before)
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            raw = stream.read(limit + 1)
        require(len(raw) == before[6] and metadata(os.fstat(fd)) == before
                and metadata(os.lstat(filename)) == before)
        host_ancestry(filename)
        return raw
    finally:
        os.close(fd)


def lease_operation(fd, unlock=False, shared=False):
    import fcntl
    operation = fcntl.LOCK_SH if shared else fcntl.LOCK_EX
    fcntl.flock(fd, fcntl.LOCK_UN if unlock else operation | fcntl.LOCK_NB)


def lock_metadata(info):
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            and (info.st_uid, info.st_gid) in ((0, 0), (1000, 1000))
            and stat.S_IMODE(info.st_mode) in (0o600, 0o644))
    return host_identity(info)


@contextmanager
def deployment_lease(close_only=False):
    # Parent acquisition only. Inherited contexts use verify_inherited_lease.
    import errno
    try:
        os.fstat(9)
    except OSError as error:
        require(error.errno == errno.EBADF)
    else:
        raise VerificationError('descriptor_nine_already_open')
    host_ancestry(LOCK)
    before = lock_metadata(os.lstat(LOCK))
    fd = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    leased = False
    try:
        require(lock_metadata(os.fstat(fd)) == before and lock_metadata(os.lstat(LOCK)) == before)
        if fd != 9:
            os.dup2(fd, 9, inheritable=False)
            os.close(fd)
            fd = 9
        def reaffirm():
            host_ancestry(LOCK)
            require(lock_metadata(os.fstat(fd)) == before and lock_metadata(os.lstat(LOCK)) == before)
        lease_operation(fd)
        leased = True
        reaffirm()
        yield reaffirm
        reaffirm()
    finally:
        try:
            # Dispatch descendants share this open description. On interruption,
            # closing our reference must not unlock a still-running helper's FD9.
            if leased and not close_only:
                lease_operation(fd, unlock=True)
        finally:
            os.close(fd)


def load_state_captured(captured, inventory):
    # Scope the helper's adjacent import to a captured module; do not monkeypatch
    # process-global importlib or reopen an installed/host inventory helper.
    filename = ROOT + '/ops/payload-control-state.py'
    expected = ROOT + '/ops/payload-control-inventory.py'
    class Loader:
        def exec_module(self, module):
            require(module is inventory)
    spec = types.SimpleNamespace(loader=Loader())
    def select(name, path):
        require(name == 'payload_control_inventory' and path == expected)
        return spec
    def create(selected):
        require(selected is spec)
        return inventory
    proxy = types.SimpleNamespace(util=types.SimpleNamespace(spec_from_file_location=select, module_from_spec=create))
    def importer(name, *args, **kwargs):
        return proxy if name == 'importlib.util' else builtins.__import__(name, *args, **kwargs)
    module = types.ModuleType('authenticated_preparation_state')
    module.__file__ = filename
    module.__dict__['__builtins__'] = dict(vars(builtins), __import__=importer)
    exec(compile(captured['ops/payload-control-state.py'], filename, 'exec'), module.__dict__)
    require(module.INVENTORY is inventory)
    return module


def verify_host_baseline(approval, captured, cms_image, support):
    baseline = approval['hostBaseline']
    inventory = load_authenticated(captured['ops/payload-control-inventory.py'], ROOT + '/ops/payload-control-inventory.py')
    expected = inventory.production_inventory(HOST_ROOT, RUNTIME, RELEASES, HOST_ROOT + '/current-release', LOCK,
        '/opt/ownerinc/backups/portal-ownerinc/daily', PRODUCTION_BACKUP, PRODUCTION_BACKUP + '/restore-protection',
        ENVIRONMENT, RUNTIME + '/compose.production.yaml', RUNTIME + '/compose.payload.production.yaml')
    identity = inventory.identity(expected)
    require(identity == baseline['inventoryIdentity'])
    observed = {}
    def read(filename, owner=(1000, 1000), modes=(0o600, 0o644), limit=2 * 1024 * 1024):
        value = host_read(filename, owner, modes, limit)
        observed[filename] = (value, owner, modes, limit)
        return value
    absent = []
    def present(filename):
        if os.path.lexists(filename):
            return True
        host_ancestry(filename)
        absent.append(filename)
        return False
    release = RELEASES + '/' + baseline['currentCommit']
    require(read(HOST_ROOT + '/current-release') in (release.encode(), (release + '\n').encode()))
    image_bytes = ('API_IMAGE=' + baseline['legacyImages']['api']
                   + '\nCRON_IMAGE=' + baseline['legacyImages']['cron']).encode()
    require(read(release + '/.image-env') in (image_bytes, image_bytes + b'\n'))
    for filename, field in ((release + '/docker-compose.yml', 'releaseComposeSha256'),
                             (RUNTIME + '/compose.production.yaml', 'runtimeComposeSha256')):
        require(support.sha(read(filename)) == baseline[field])
    override = release + '/compose.ownerinc-vps.yaml'
    if present(override):
        require(support.sha(read(override)) == baseline['releaseOverrideSha256'])
    else:
        require(baseline['releaseOverrideSha256'] is None)
    read(ENVIRONMENT, modes=(0o600,))
    inventory.verify_environment_file(ENVIRONMENT, expected['environmentFileOwner'])
    inventory_path = RUNTIME + '/payload-control-inventory.json'
    inventory_present = present(inventory_path)
    if inventory_present:
        raw = read(inventory_path, (0, 0), (0o600,), 1024 * 1024)
        document = inventory.validate(support.strict_json(raw))
        require(inventory.canonical(document) + b'\n' == raw and document == expected)
    key_path, state_dir = RUNTIME + '/payload-control.key', RUNTIME + '/payload-control-state'
    key_present, state_present = present(key_path), present(state_dir)
    require(key_present == state_present)
    require(not present(LOCK + '.admission-closed'))
    if key_present:
        require(inventory_present)
        state = load_state_captured(captured, inventory)
        require(set(os.listdir(state_dir)) == {'00000000000000000000.json', 'current.json'})
        info = os.lstat(state_dir)
        require(stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid) == (0, 0) and stat.S_IMODE(info.st_mode) == 0o700)
        state._read_file = lambda filename, expected_mode=None, private_owner=False: read(filename, (0, 0), (0o600,), 1024 * 1024)
        _, _, body, _ = state.read_state(RUNTIME, repair_head=False, inventory_identity=identity)
        initial = {'schemaVersion': 2, 'phase': 'preauthority', 'cmsStatus': 'cold',
            'authority': {'mode': 'legacy', 'epoch': 1}, 'workerHold': True, 'admission': 'open',
            'sequence': 0, 'previousStateSha256': None, 'restoreIntent': None, 'installIntent': None,
            'latestProofSha256': None, 'legacySourceProofSha256': None, 'releaseImages': None,
            'plannedReleaseImages': None, 'rollbackTargetImages': None, 'nativeCatalogFingerprint': None,
            'inventoryIdentity': identity}
        require(body == initial)
        require(set(os.listdir(state_dir)) == {'00000000000000000000.json', 'current.json'})
    predecessors = (
        ('commonReceiver', '/usr/local/libexec/ownerinc-portal-deploy', 'ops/deploy-from-ci.sh', 0o755),
        ('receiverHelper', '/usr/local/libexec/payload-receiver-admission.py', 'ops/payload-receiver-admission.py', 0o755),
        ('productionWrapper', '/usr/local/libexec/ownerinc-portal-deploy-production', 'ops/deploy-from-production-ci.sh', 0o755),
        ('operationsGuard', RUNTIME + '/payload-operations-guard', 'ops/payload-operations-guard.sh', 0o755),
        ('cmsCandidate', RUNTIME + '/cms-image-candidate.env', None, 0o644))
    for role, filename, source, mode in predecessors:
        approved = baseline['installedPredecessors'][role]
        if present(filename):
            desired = captured[source] if source else ('CMS_IMAGE=' + cms_image + '\n').encode()
            value = read(filename, (0, 0), (mode,))
            require(value == desired or support.sha(value) == approved)
        else:
            require(approved is None)
    for name, source, mode in (
        ('payload-control', 'ops/payload-control', 0o755),
        ('payload-control-runtime.py', 'ops/payload-control-runtime.py', 0o644),
        ('payload-control-state.py', 'ops/payload-control-state.py', 0o644),
        ('payload-control-inventory.py', 'ops/payload-control-inventory.py', 0o644),
        ('compose.payload.production.yaml', 'ops/compose.payload.production.yaml', 0o644)):
        filename = RUNTIME + '/' + name
        if present(filename):
            require(read(filename, (0, 0), (mode,)) == captured[source])
    for filename, (value, owner, modes, limit) in observed.items():
        require(host_read(filename, owner, modes, limit) == value)
    require(all(not os.path.lexists(filename) for filename in absent))
    if state_present:
        require(set(os.listdir(state_dir)) == {'00000000000000000000.json', 'current.json'})


def verify_host_under_lock(approval, captured, cms_image, support):
    with deployment_lease() as reaffirm:
        verify_host_baseline(approval, captured, cms_image, support)
        reaffirm()


def authenticate():
    require(os.path.abspath(__file__) == LAUNCHER)
    approval_raw = protected(APPROVAL, 0o600, 1024 * 1024)
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result)
            result[key] = value
        return result
    approval = json.loads(approval_raw, object_pairs_hook=pairs)
    require(isinstance(approval, dict) and isinstance(approval.get('source'), dict))
    hashes = approval['source'].get('files')
    require(isinstance(hashes, dict) and set(hashes) == set(FILES))
    captured = {}
    for relative in FILES:
        filename = LAUNCHER if relative == 'ops/prepare-cms-authenticated.py' else ROOT + '/' + relative
        raw = protected(filename, 0o644 if relative.endswith(('.yaml', '.yml')) else 0o755, 2 * 1024 * 1024)
        require(hashlib.sha256(raw).hexdigest() == hashes[relative])
        captured[relative] = raw
    # Entire closure has passed before the first import from that closure.
    support = load_authenticated(captured['ops/provision-payload-candidate-trust.py'],
                                 ROOT + '/ops/provision-payload-candidate-trust.py')
    approval = support.validate_preparation_approval(support.strict_json(approval_raw))
    policy_raw = support.read_protected(support.POLICY_PATH, 0o600, support.MAX_JSON)
    require(support.sha(policy_raw) == approval['admission']['policySha256'])
    policy = support.validate_policy(support.strict_json(policy_raw))
    verifier_raw = None
    # Authenticate every admission tool and executable BEFORE executing verifier bytes.
    for relative, expected in policy['toolchain']['files'].items():
        raw = support.read_protected(support.TOOL_ROOT + '/' + relative,
                                     0o755 if relative.endswith('.py') else 0o644, 2 * support.MAX_JSON)
        require(support.sha(raw) == expected)
        if relative == 'ops/payload-candidate-verifier.py':
            verifier_raw = raw
    for entry in policy['toolchain']['executables'].values():
        require(support.sha(support.read_protected(entry['path'], 0o755, support.MAX_BINARY)) == entry['sha256'])
    require(os.path.realpath(sys.executable) == policy['toolchain']['executables']['python']['path'])
    verifier = load_authenticated(verifier_raw, support.TOOL_ROOT + '/ops/payload-candidate-verifier.py')
    verifier.verify_installed_tools(policy)
    binding = approval['admission']
    record_path = verifier.REGISTRY + '/' + binding['archiveSha256'] + '.' + binding['policySha256'] + '.json'
    record_raw = verifier.read_protected(record_path, verifier.MAX_JSON, private_parent=True)
    require(support.sha(record_raw) == binding['recordSha256'])
    record = verifier.validate_record(verifier.strict_json(record_raw))
    request = {key: record[key] for key in ('commit', 'runId', 'runAttempt', 'images')}
    request['artifactIds'] = {role: entry['id'] for role, entry in record['artifacts'].items()}
    # Not archive authentication: sizes/identity come from the protected approved
    # record. Policy/revision/contract validation remains the actual verifier's.
    verifier.verify_record_binding(policy_raw, record, request, binding['archiveSha256'], record['archiveBytes'])
    require(verifier.read_protected(record_path, verifier.MAX_JSON, private_parent=True) == record_raw
            and support.read_protected(support.POLICY_PATH, 0o600, support.MAX_JSON) == policy_raw
            and protected(APPROVAL, 0o600, support.MAX_JSON) == approval_raw)
    verifier.verify_installed_tools(policy)
    for relative, raw in captured.items():
        require(protected(support.preparation_target(relative), support.preparation_mode(relative), 2 * support.MAX_JSON) == raw)
    return approval, captured, record['images']['cms'], support, support.sha(approval_raw)


def verify():
    approval, captured, cms_image, support, _ = authenticate()
    verify_host_under_lock(approval, captured, cms_image, support)
    return {'kind': 'payload-preparation-verification-only', 'sourceAuthenticated': True,
            'admissionRecordAuthenticated': True, 'cmsImage': cms_image,
            'hostBaselineChecked': True, 'archiveBytesChecked': False,
            'preparationExecuted': False, 'deploymentAuthorized': False}


def verify_inherited_lease():
    # Prove FD9 and pathname still identify the same safe file, and that the
    # exclusive lock belongs to this open description rather than another owner.
    # A separate SH probe must be blocked by an existing EX lock. An EX probe
    # would also block on SH and incorrectly permit upgrading inherited SH to EX.
    # Only after that test may flock on inherited FD9 reaffirm the same OFD.
    # The trusted dispatch parent must retain its EX lease throughout this
    # handshake; these separate flock calls are not an atomic lock-state query.
    # Never unlock FD9 here: child and parent share its open description.
    host_ancestry(LOCK)
    before = lock_metadata(os.lstat(LOCK))
    require(lock_metadata(os.fstat(9)) == before)
    probe = os.open(LOCK, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(lock_metadata(os.fstat(probe)) == before)
        try:
            lease_operation(probe, shared=True)
        except BlockingIOError:
            pass
        else:
            lease_operation(probe, unlock=True)
            raise VerificationError('inherited_lease_not_held')
        require(lock_metadata(os.fstat(9)) == before and lock_metadata(os.lstat(LOCK)) == before)
        lease_operation(9)
        require(lock_metadata(os.fstat(9)) == before and lock_metadata(os.lstat(LOCK)) == before)
        host_ancestry(LOCK)
    finally:
        os.close(probe)


def context_material(expected_digest):
    require(isinstance(expected_digest, str) and len(expected_digest) == 64
            and all(c in '0123456789abcdef' for c in expected_digest))
    verify_inherited_lease()
    approval, captured, cms_image, support, digest = authenticate()
    require(digest == expected_digest)
    verify_host_baseline(approval, captured, cms_image, support)
    verify_inherited_lease()
    return approval, captured, cms_image, support, digest


def verified_context(expected_digest):
    approval, _, cms_image, _, digest = context_material(expected_digest)
    # Fixed line protocol: validated hashes/identifiers only, never shell text.
    baseline = approval['hostBaseline']
    return '\n'.join([digest, baseline['currentCommit'], cms_image] +
                     [baseline['installedPredecessors'][role] or '-' for role in
                      ('commonReceiver', 'receiverHelper', 'productionWrapper', 'operationsGuard', 'cmsCandidate')])


def create_inventory(expected_digest):
    # One fixed helper operation; no caller-selected module, destination or paths.
    approval, captured, _, _, _ = context_material(expected_digest)
    inventory = load_authenticated(captured['ops/payload-control-inventory.py'], ROOT + '/ops/payload-control-inventory.py')
    value = inventory.production_inventory(HOST_ROOT, RUNTIME, RELEASES, HOST_ROOT + '/current-release', LOCK,
        '/opt/ownerinc/backups/portal-ownerinc/daily', PRODUCTION_BACKUP, PRODUCTION_BACKUP + '/restore-protection',
        ENVIRONMENT, RUNTIME + '/compose.production.yaml', RUNTIME + '/compose.payload.production.yaml')
    require(inventory.identity(value) == approval['hostBaseline']['inventoryIdentity'])
    inventory.verify_environment_file(ENVIRONMENT, value['environmentFileOwner'])
    verify_inherited_lease()
    inventory.create(RUNTIME + '/payload-control-inventory.json', value)


def dispatch(mode):
    require(mode in ('check', 'apply'))
    # Authenticate before executing ANY closure helper, then reauthenticate and
    # validate host eligibility under the lease used by the actual child.
    initial = authenticate()
    with deployment_lease(close_only=True) as reaffirm:
        approval, captured, cms_image, support, digest = authenticate()
        require(digest == initial[4])
        verify_host_baseline(approval, captured, cms_image, support)
        reaffirm()
        result = subprocess.run(['/bin/bash', '--noprofile', '--norc', ROOT + '/ops/prepare-cms-infrastructure.sh',
                                 '--authenticated-' + mode, digest],
                                env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'},
                                pass_fds=(9,), check=False)
        reaffirm()
        require(result.returncode == 0)
        # No runtime authorization is conferred by preparing inactive files.
        approval, captured, cms_image, support, final_digest = authenticate()
        require(final_digest == digest)
        verify_host_baseline(approval, captured, cms_image, support)
        reaffirm()
    return {'kind': 'payload-inactive-preparation', 'mode': mode, 'hostBaselineChecked': True,
            'archiveBytesChecked': False, 'preparationExecuted': True, 'deploymentAuthorized': False}


def main():
    args = sys.argv[1:]
    require(args in (['--check'], ['--apply']) or len(args) == 2 and args[0] in ('--verify-context', '--create-inventory'))
    require(sys.platform == 'linux' and os.getuid() == os.geteuid() == os.getgid() == os.getegid() == 0)
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode)
    require(set(os.environ) <= {'PATH', 'LANG', 'LC_ALL'} and os.environ.get('PATH') == '/usr/bin:/bin'
            and os.environ.get('LANG') == 'C' and os.environ.get('LC_ALL') == 'C')
    require(os.path.realpath(sys.executable) == os.path.realpath('/usr/bin/python3'))
    if args[0] == '--verify-context':
        print(verified_context(args[1]))
    elif args[0] == '--create-inventory':
        create_inventory(args[1])
        print('Protected production inventory created from authenticated source.')
    else:
        print(json.dumps(dispatch(args[0][2:]), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Neither imported validator exceptions nor paths/private bytes are public.
        print('Preparation verification denied.', file=sys.stderr)
        sys.exit(2)
