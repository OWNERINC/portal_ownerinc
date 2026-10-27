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
import tempfile
import re
import selectors
import signal
import threading
import time
from contextlib import contextmanager, ExitStack

HOST_ROOT = '/opt/ownerinc/apps/portal-ownerinc-real'
RUNTIME = HOST_ROOT + '/runtime'
RELEASES = HOST_ROOT + '/releases'
LOCK = RUNTIME + '/deploy.lock'
ENVIRONMENT = '/opt/ownerinc/secrets/portal-ownerinc/production.runtime.conf'
PRODUCTION_BACKUP = '/opt/ownerinc/backups/portal-ownerinc/production'

ROOT = '/opt/ownerinc/lib/payload-preparation'
LAUNCHER = '/usr/local/libexec/ownerinc-payload-prepare.py'
APPROVAL = '/etc/ownerinc/payload-preparation/production-approval.json'
OBSERVER_TIMEOUT_SECONDS = 30
OBSERVER_MAX_FRAME = 4096
OBSERVER_CLEANUP_INTERRUPT_RETRIES = 3
SUBPROCESS_MAX_OUTPUT = 64 * 1024
SUBPROCESS_TIMEOUT_SECONDS = 7200
APPLY_RUNTIME_TIMEOUT_SECONDS = 6900
SUBPROCESS_CLEANUP_SECONDS = 3
OBSERVER = ROOT + '/ops/payload-production-observer.py'
FILES = (
    'ops/prepare-cms-infrastructure.sh', 'ops/prepare-cms-infrastructure-private.py',
    'ops/payload-control-inventory.py', 'ops/payload-control-state.py',
    'ops/deploy-from-ci.sh', 'ops/payload-receiver-admission.py', 'ops/payload-receiver-root.sh',
    'ops/deploy-from-production-ci.sh', 'ops/payload-operations-guard.sh', 'ops/payload-control',
    'ops/payload-control-runtime.py', 'ops/compose.payload.production.yaml', 'docker-compose.payload.yml',
    'ops/payload-production-observer.py',
    'ops/prepare-cms-authenticated.py', 'ops/provision-payload-candidate-trust.py')


class VerificationError(Exception):
    pass


def require(condition):
    if not condition:
        raise VerificationError('preparation_verification_denied')


def approval_binding_digest(approval):
    require(isinstance(approval, dict) and 'admission' in approval)
    body = {key: value for key, value in approval.items() if key != 'admission'}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=False).encode('utf-8')).hexdigest()


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


def verify_host_baseline(approval, captured, cms_image, support, metadata_only=False):
    require(type(metadata_only) is bool)
    baseline = approval['hostBaseline']
    inventory = load_authenticated(captured['ops/payload-control-inventory.py'], ROOT + '/ops/payload-control-inventory.py')
    portal_database = inventory.portal_database_from_environment(
        ENVIRONMENT, inventory.PRODUCTION_ENVIRONMENT_OWNER,
        lambda path: host_read(path, (1000, 1000), (0o600,), 1024 * 1024))
    expected = inventory.production_inventory(HOST_ROOT, RUNTIME, RELEASES, HOST_ROOT + '/current-release', LOCK,
        '/opt/ownerinc/backups/portal-ownerinc/daily', PRODUCTION_BACKUP, PRODUCTION_BACKUP + '/restore-protection',
        ENVIRONMENT, RUNTIME + '/compose.production.yaml', RUNTIME + '/compose.payload.production.yaml', portal_database)
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
    if not metadata_only:
        read(ENVIRONMENT, modes=(0o600,))
    environment_info = inventory.verify_environment_file(ENVIRONMENT, expected['environmentFileOwner'])
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
    if metadata_only:
        require(host_identity(inventory.verify_environment_file(
            ENVIRONMENT, expected['environmentFileOwner'])) == host_identity(environment_info))
    require(all(not os.path.lexists(filename) for filename in absent))
    if state_present:
        require(set(os.listdir(state_dir)) == {'00000000000000000000.json', 'current.json'})


def verify_host_under_lock(approval, captured, cms_image, support):
    with deployment_lease() as reaffirm:
        verify_host_baseline(approval, captured, cms_image, support)
        reaffirm()


def _authenticated_material():
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
    return approval, captured, record['images']['cms'], support, support.sha(approval_raw), record, verifier


def authenticate():
    return _authenticated_material()[:5]


def load_runtime_captured(captured):
    inventory = load_authenticated(captured['ops/payload-control-inventory.py'], ROOT + '/ops/payload-control-inventory.py')
    state = load_state_captured(captured, inventory)
    filename = ROOT + '/ops/payload-control-runtime.py'
    class Loader:
        def exec_module(self, module):
            require(module is state)
    spec = types.SimpleNamespace(loader=Loader())
    def select(name, path):
        require(name == 'payload_control_state' and path == ROOT + '/ops/payload-control-state.py')
        return spec
    def create(selected):
        require(selected is spec)
        return state
    proxy = types.SimpleNamespace(util=types.SimpleNamespace(spec_from_file_location=select, module_from_spec=create))
    def importer(name, *args, **kwargs):
        return proxy if name == 'importlib.util' else builtins.__import__(name, *args, **kwargs)
    runtime = types.ModuleType('authenticated_install_plan_runtime')
    runtime.__file__ = filename
    runtime.__dict__['__builtins__'] = dict(vars(builtins), __import__=importer)
    exec(compile(captured['ops/payload-control-runtime.py'], filename, 'exec'), runtime.__dict__)
    require(runtime.STATE is state and runtime.INVENTORY is inventory)
    return runtime


def verify_received_tree(receiver, destination, entries, private_files=None, private_root=True):
    """Compare receiver extraction with authenticated archive, including empty files.

    This is a data reader, not the executable-trust reader. Never extract, merge,
    follow a link, import or execute anything in this tree.
    """
    private_files = private_files or {}
    require(isinstance(private_files, dict))
    entries = {**entries, **private_files}
    children = {'': set()}
    files = {}
    for name, content in entries.items():
        parts = name.split('/')
        for index, part in enumerate(parts):
            parent = '/'.join(parts[:index])
            children.setdefault(parent, set()).add(part)
        if content is None:
            children.setdefault(name, set())
        else:
            files[name] = content
    identities = {}
    for relative, expected_names in children.items():
        filename = destination + ('/' + relative if relative else '')
        receiver.protected_directory(filename, private=private_root and not relative)
        identities[filename] = receiver.identity(os.lstat(filename))
        require(set(os.listdir(filename)) == expected_names)
    for relative, expected in files.items():
        filename = destination + '/' + relative
        before = os.lstat(filename)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and (before.st_uid, before.st_gid) == (0, 0)
                and stat.S_IMODE(before.st_mode) == (0o600 if relative in private_files else 0o644)
                and before.st_size == len(expected) and before.st_size <= receiver.MAX_EXPANDED)
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            require(receiver.identity(os.fstat(fd)) == receiver.identity(before))
            with os.fdopen(fd, 'rb', closefd=False) as stream:
                require(stream.read(len(expected) + 1) == expected)
            require(receiver.identity(os.fstat(fd)) == receiver.identity(before)
                    and receiver.identity(os.lstat(filename)) == receiver.identity(before))
        finally:
            os.close(fd)
    for filename, identity in identities.items():
        require(receiver.identity(os.lstat(filename)) == identity)


def inspect_install_host(approval, captured, metadata_only=False):
    # Separate from preparation eligibility: inspect valid pending/committed
    # journals, never invoke Runtime.__init__ (which allows head repair).
    require(type(metadata_only) is bool)
    runtime = load_runtime_captured(captured)
    state, inventory = runtime.STATE, runtime.INVENTORY
    baseline = approval['hostBaseline']
    portal_database = inventory.portal_database_from_environment(
        ENVIRONMENT, inventory.PRODUCTION_ENVIRONMENT_OWNER,
        lambda path: host_read(path, (1000, 1000), (0o600,), 1024 * 1024))
    expected = inventory.production_inventory(HOST_ROOT, RUNTIME, RELEASES, HOST_ROOT + '/current-release', LOCK,
        '/opt/ownerinc/backups/portal-ownerinc/daily', PRODUCTION_BACKUP, PRODUCTION_BACKUP + '/restore-protection',
        ENVIRONMENT, RUNTIME + '/compose.production.yaml', RUNTIME + '/compose.payload.production.yaml', portal_database)
    require(inventory.identity(expected) == baseline['inventoryIdentity'])
    reads = {}
    absent = set()
    def read(filename, owner=(0, 0), modes=(0o600,), limit=1024 * 1024):
        value = host_read(filename, owner, modes, limit)
        if filename in reads:
            require(reads[filename] == (value, owner, modes, limit))
        else:
            require(sum(len(item[0]) for item in reads.values()) + len(value) <= 16 * 1024 * 1024)
        reads[filename] = (value, owner, modes, limit)
        return value
    def host_data(filename):
        info = os.lstat(filename)
        owner = (info.st_uid, info.st_gid)
        require(owner in ((0, 0), (1000, 1000)))
        return read(filename, owner, (0o600, 0o644)), info
    document_raw = read(RUNTIME + '/payload-control-inventory.json')
    document = inventory.validate(state.parse_canonical(document_raw, 'invalid_inventory_file'))
    require(document == expected)
    if not metadata_only:
        read(ENVIRONMENT, (1000, 1000), (0o600,))
    environment_info = inventory.verify_environment_file(ENVIRONMENT, document['environmentFileOwner'])
    key_path, state_dir = RUNTIME + '/payload-control.key', RUNTIME + '/payload-control-state'
    require(os.path.lexists(key_path) and os.path.lexists(state_dir))
    host_ancestry(key_path)
    state_info = os.lstat(state_dir)
    require(stat.S_ISDIR(state_info.st_mode) and (state_info.st_uid, state_info.st_gid) == (0, 0)
            and stat.S_IMODE(state_info.st_mode) == 0o700)
    journal_names = set(os.listdir(state_dir))
    require(2 <= len(journal_names) <= 4096)
    state._read_file = lambda filename, expected_mode=None, private_owner=False: read(filename)
    key, _, body, _ = state.read_state(RUNTIME, repair_head=False, inventory_identity=inventory.identity(document))
    source = RELEASES + '/' + baseline['currentCommit']
    source_raw, source_info = host_data(source + '/.image-env')
    image_bytes = ('API_IMAGE=' + baseline['legacyImages']['api'] + '\nCRON_IMAGE=' + baseline['legacyImages']['cron']).encode()
    require(source_raw in (image_bytes, image_bytes + b'\n'))
    pointer_raw, pointer_info = host_data(HOST_ROOT + '/current-release')
    pointer = pointer_raw.decode('utf-8').removesuffix('\n')
    intent = body.get('installIntent')
    allowed = {source}
    if intent:
        binding = intent['binding']
        require(binding['sourceRelease'] == source and binding['previousImages'] == baseline['legacyImages']
                and os.path.dirname(binding['candidateRelease']) == RELEASES)
        if intent['stage'] in ('floor_commit_pending', 'floor_committed'):
            allowed.add(binding['candidateRelease'])
        if intent['stage'] == 'floor_committed':
            allowed = {binding['candidateRelease']}
    require(pointer in allowed)
    for filename, field in ((source + '/docker-compose.yml', 'releaseComposeSha256'),
                             (RUNTIME + '/compose.production.yaml', 'runtimeComposeSha256')):
        require(hashlib.sha256(host_data(filename)[0]).hexdigest() == baseline[field])
    override = source + '/compose.ownerinc-vps.yaml'
    if os.path.lexists(override):
        require(hashlib.sha256(host_data(override)[0]).hexdigest() == baseline['releaseOverrideSha256'])
    else:
        require(baseline['releaseOverrideSha256'] is None)
        absent.add(override)
    b0_status = 'absent'
    directories = [intent['binding']['b0']['directory']] if intent else \
        [root + '/000-initial-install-b0' for root in document['paths']['backupRoots']]
    for directory in directories:
        require(os.path.isabs(directory) and os.path.normpath(directory) == directory
                and any(directory != root and os.path.commonpath((directory, root)) == root
                        for root in document['paths']['backupRoots']))
        if not os.path.lexists(directory):
            absent.add(directory)
            continue
        host_ancestry(directory + '/preauthority-proof.json')
        info = os.lstat(directory)
        require(stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid) == (0, 0) and stat.S_IMODE(info.st_mode) == 0o700)
        if not intent:
            b0_status = 'unbound'
            continue
        required = set(state.LEGACY_ARTIFACTS) | {'manifest.sha256', 'preauthority-proof.json'}
        if not required <= set(os.listdir(directory)):
            b0_status = 'partial'
            continue
        proof_raw = read(directory + '/preauthority-proof.json')
        proof = state.verify_envelope(state.parse_canonical(proof_raw, 'proof_not_canonical'), key,
                                      state.validate_proof_body, 'proof_shape_invalid')
        require(proof['kind'] == 'preauthority-legacy-source' and proof['inventoryIdentity'] == body['inventoryIdentity']
                and hashlib.sha256(proof_raw).hexdigest() == intent['binding']['b0']['proofSha256']
                and proof['images'] == baseline['legacyImages']
                and proof['source']['portal'] == intent['binding']['portalTarget']['database']
                and proof['targetImages'] == intent['binding']['candidate']['images'])
        b0_status = 'present_unverified' # Artifact hashes/restoreability/DB identity are not checked here.
    for filename, (raw, owner, modes, limit) in reads.items():
        require(host_read(filename, owner, modes, limit) == raw)
    if metadata_only:
        require(host_identity(inventory.verify_environment_file(
            ENVIRONMENT, document['environmentFileOwner'])) == host_identity(environment_info))
    require(set(os.listdir(state_dir)) == journal_names and all(not os.path.lexists(f) for f in absent))
    lock_info = os.lstat(LOCK)
    ownership = all((i.st_uid, i.st_gid) == (0, 0) for i in (pointer_info, source_info, lock_info)) \
        and all(stat.S_IMODE(i.st_mode) == 0o600 for i in (pointer_info, source_info))
    return runtime, document, body, {'runtimeOwnershipCompatible': ownership,
        'isolatedSourceIdentityCompatible': baseline['currentCommit'] == hashlib.sha256(source_raw).hexdigest()[:40],
        'b0Status': b0_status}


def expected_context(approval, captured, approval_digest):
    runtime, inventory, body, _ = inspect_install_host(
        approval, captured, metadata_only=True)
    lease = os.fstat(9)
    return {
        'approvalSha256': approval_digest,
        'sourceCommit': approval['hostBaseline']['currentCommit'],
        'inventoryIdentity': runtime.INVENTORY.identity(inventory),
        'stateSha256': hashlib.sha256(runtime.STATE.canonical(body)).hexdigest(),
        'stateSequence': body['sequence'],
        'leaseDevice': lease.st_dev,
        'leaseInode': lease.st_ino,
    }


def _terminate_and_reap(process):
    # Popen identifies the directly owned child; never signal by an externally
    # supplied PID or process group. Every wait is deadline-bound; inability to
    # prove reaping is a fail-stop condition while the caller still owns FD9.
    for attempt in range(OBSERVER_CLEANUP_INTERRUPT_RETRIES):
        try:
            process.kill()
            break
        except ProcessLookupError:
            break
        except (InterruptedError, KeyboardInterrupt):
            if attempt + 1 == OBSERVER_CLEANUP_INTERRUPT_RETRIES:
                raise
    for attempt in range(OBSERVER_CLEANUP_INTERRUPT_RETRIES):
        try:
            process.wait(timeout=SUBPROCESS_CLEANUP_SECONDS)
            return
        except (InterruptedError, KeyboardInterrupt):
            if attempt + 1 == OBSERVER_CLEANUP_INTERRUPT_RETRIES:
                raise
        except subprocess.TimeoutExpired:
            raise VerificationError('preparation_verification_denied') from None


def _observer_cleanup_fail_stop():
    # No normal unwinding may release the parent's lease when direct-child state
    # cannot be proven reaped. _exit emits no traceback or private diagnostic.
    os._exit(2)


def _enable_linux_subreaper():
    if sys.platform == 'linux':
        import ctypes
        require(ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0)


def _signal_process_group(process, selected):
    try:
        if os.name == 'posix':
            os.killpg(process.pid, selected)
        elif process.poll() is None:
            process.send_signal(selected)
    except ProcessLookupError:
        pass


def _kill_and_reap_group(process):
    deadline = time.monotonic() + SUBPROCESS_CLEANUP_SECONDS
    _signal_process_group(process, signal.SIGTERM)
    if process.poll() is None:
        try:
            process.wait(timeout=max(0.01, min(0.5, deadline - time.monotonic())))
        except subprocess.TimeoutExpired:
            pass
    # Signal again even if the direct child exited: descendants may still own
    # the session/process group and inherited output or mutation capability.
    _signal_process_group(process, getattr(signal, 'SIGKILL', signal.SIGTERM))
    if process.poll() is None:
        remaining = deadline - time.monotonic()
        require(remaining > 0)
        try:
            process.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            raise VerificationError('preparation_verification_denied') from None
    if os.name != 'posix':
        return
    while True:
        try:
            child, _ = os.waitpid(-process.pid, os.WNOHANG)
        except ChildProcessError:
            return
        if child == 0:
            require(time.monotonic() < deadline)
            time.sleep(0.01)


def _kill_inherited_group_fail_stop(process):
    # The receiver created this session and remains outside it. Killing our own
    # inherited group intentionally terminates this supervisor too, so the outer
    # receiver alone performs bounded reap while retaining the request boundary.
    require(os.name == 'posix' and os.getpgid(process.pid) == os.getpgrp())
    # One group-wide SIGKILL reaches this supervisor, the runtime and every
    # nested mutator atomically. A preceding TERM could terminate this process
    # before it issued the mandatory KILL to a TERM-resistant descendant.
    try:
        os.killpg(os.getpgrp(), signal.SIGKILL)
    except ProcessLookupError:
        pass
    _observer_cleanup_fail_stop()


def run_bounded_subprocess(command, output_limit=SUBPROCESS_MAX_OUTPUT,
                           timeout=SUBPROCESS_TIMEOUT_SECONDS, pass_fds=(), group_mode='new'):
    require(isinstance(command, list) and command and
            all(isinstance(value, str) and value for value in command))
    require(type(output_limit) is int and 0 < output_limit <= SUBPROCESS_MAX_OUTPUT)
    require(type(timeout) is int and 0 < timeout <= SUBPROCESS_TIMEOUT_SECONDS)
    require(isinstance(pass_fds, tuple) and all(type(value) is int and value >= 0 for value in pass_fds))
    require(group_mode in ('new', 'inherit'))
    output_length = 0
    exceeded = threading.Event()
    reader_failed = threading.Event()
    process = None
    private_output = tempfile.TemporaryFile(mode='w+b')

    def consume():
        nonlocal output_length
        try:
            while True:
                chunk = process.stdout.read(8192)
                if not chunk:
                    return
                if output_length + len(chunk) > output_limit:
                    exceeded.set()
                    return
                private_output.write(chunk)
                output_length += len(chunk)
        except BaseException:
            reader_failed.set()

    try:
        _enable_linux_subreaper()
        process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}, pass_fds=pass_fds,
            shell=False, bufsize=0, start_new_session=(os.name == 'posix' and group_mode == 'new'))
        require(process.stdout is not None)
        reader = threading.Thread(target=consume, name='payload-preparation-bounded-output', daemon=True)
        reader.start()
        deadline = time.monotonic() + timeout
        while process.poll() is None and not exceeded.wait(0.01):
            if time.monotonic() >= deadline:
                raise VerificationError('preparation_verification_denied')
        if exceeded.is_set():
            raise VerificationError('preparation_verification_denied')
        remaining = deadline - time.monotonic()
        require(remaining > 0)
        reader.join(remaining)
        require(not reader.is_alive() and not reader_failed.is_set() and output_length <= output_limit)
        private_output.flush()
        private_output.seek(0)
        output = private_output.read(output_limit + 1)
        require(len(output) == output_length)
        returncode = process.returncode
        if group_mode == 'new':
            _kill_and_reap_group(process)
        return subprocess.CompletedProcess(command, returncode, output, b'')
    except BaseException:
        if process is not None:
            try:
                if group_mode == 'inherit' and os.name == 'posix':
                    _kill_inherited_group_fail_stop(process)
                else:
                    _kill_and_reap_group(process)
            except BaseException:
                _observer_cleanup_fail_stop()
        raise VerificationError('preparation_verification_denied') from None
    finally:
        if process is not None and process.stdout is not None:
            try:
                process.stdout.close()
            except BaseException:
                pass
        private_output.close()


def run_bounded_observer(request):
    process = None
    selector = None
    registered = False
    reaped = False
    failed = False
    termination_failed = False
    result = None
    try:
        # Authenticate the validator bytes immediately before they parse either
        # direction of the child protocol. The caller still performs its own
        # wider pre/post authentication and host-drift checks under the lease.
        _, captured, _, _, digest = authenticate()
        require(isinstance(request, dict) and request.get('approvalSha256') == digest)
        observer = load_authenticated(captured['ops/payload-production-observer.py'], OBSERVER)
        request = observer.validate_request(request)
        request_frame = observer.canonical(request) + b'\n'
        require(len(request_frame) <= OBSERVER_MAX_FRAME)
        process = subprocess.Popen(
            ['/usr/bin/python3', '-I', '-S', '-B', OBSERVER, 'collect-context'],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            pass_fds=(9,),
            env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'},
            shell=False,
            bufsize=0,
        )
        require(process.stdin is not None and process.stdout is not None)
        require(process.stdin.write(request_frame) == len(request_frame))
        process.stdin.close()
        os.set_blocking(process.stdout.fileno(), False)
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        registered = True
        deadline = time.monotonic() + OBSERVER_TIMEOUT_SECONDS
        response_frame = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            require(remaining > 0)
            ready = selector.select(remaining)
            if not ready:
                require(time.monotonic() < deadline)
                continue
            try:
                chunk = os.read(process.stdout.fileno(), OBSERVER_MAX_FRAME + 1 - len(response_frame))
            except BlockingIOError:
                continue
            if not chunk:
                break
            response_frame.extend(chunk)
            require(len(response_frame) <= OBSERVER_MAX_FRAME)
        remaining = deadline - time.monotonic()
        require(remaining > 0)
        returncode = process.wait(timeout=remaining)
        reaped = True
        require(returncode == 0)
        require(0 < len(response_frame) <= OBSERVER_MAX_FRAME)
        result = observer.validate_response(
            observer.strict_json(bytes(response_frame), OBSERVER_MAX_FRAME),
            request['nonce'],
            digest,
        )
        require(result['context']['pid'] == process.pid)
    except BaseException:
        failed = True
    finally:
        if process is not None and not reaped:
            try:
                _terminate_and_reap(process)
                reaped = True
            except BaseException:
                termination_failed = True
                failed = True
        if selector is not None:
            if registered and process is not None and process.stdout is not None:
                try:
                    selector.unregister(process.stdout)
                except BaseException:
                    failed = True
            try:
                selector.close()
            except BaseException:
                failed = True
        if process is not None:
            for stream in (process.stdin, process.stdout):
                if stream is not None:
                    try:
                        stream.close()
                    except BaseException:
                        failed = True
        if termination_failed:
            # Descriptor cleanup above is finite and independent. A close that
            # raised was attempted, not assumed complete. The production hook
            # cannot return; the second _exit defends its injectable contract.
            _observer_cleanup_fail_stop()
            os._exit(2)
    if failed or not reaped:
        raise VerificationError('preparation_verification_denied') from None
    return result


def collect_context():
    initial = authenticate()
    with deployment_lease(close_only=True) as reaffirm:
        approval, captured, cms_image, support, digest = authenticate()
        require(digest == initial[4])
        verify_host_baseline(
            approval, captured, cms_image, support, metadata_only=True)
        before = expected_context(approval, captured, digest)
        reaffirm()
        request = {
            'schemaVersion': 1,
            'kind': 'payload-production-context-request-v1',
            'operation': 'collect-context',
            'nonce': os.urandom(32).hex(),
            'approvalSha256': digest,
        }
        result = run_bounded_observer(request)
        reaffirm()
        final = authenticate()
        require(final[4] == digest and final[1] == captured)
        verify_host_baseline(
            final[0], final[1], final[2], final[3], metadata_only=True)
        after = expected_context(final[0], final[1], digest)
        require(before == after)
        require(all(result['context'][key] == value for key, value in after.items()))
        reaffirm()
        return result


def check_install_plan(receipt_id, allow_reserved_expired=False):
    require(isinstance(receipt_id, str) and re.fullmatch(r'payload-[a-z0-9_]{8}', receipt_id) is not None)
    require(type(allow_reserved_expired) is bool)
    with deployment_lease() as reaffirm, ExitStack() as b0_evidence:
        approval, captured, _, support, digest, record, verifier = _authenticated_material()
        authorization = record.get('authorization')
        require(record.get('schemaVersion') == 2 and isinstance(authorization, dict)
                and set(authorization) == {'environment', 'approvalSha256', 'inventoryIdentity', 'expiresAt', 'nonce'}
                and authorization['environment'] == 'production'
                and authorization['approvalSha256'] == approval_binding_digest(approval)
                and isinstance(authorization['expiresAt'], str) and re.fullmatch(r'[1-9][0-9]{9}', authorization['expiresAt']))
        receiver = load_authenticated(captured['ops/payload-receiver-admission.py'], ROOT + '/ops/payload-receiver-admission.py')
        receipt = receiver.INCOMING + '/' + receipt_id
        receiver.protected_directory(receipt, private=True)
        request = {key: record[key] for key in ('commit', 'runId', 'runAttempt', 'images')}
        request.update(artifactIds={role: entry['id'] for role, entry in record['artifacts'].items()},
                       artifactDigests={role: entry['digest'] for role, entry in record['artifacts'].items()},
                       contentDigests={'candidate': record['candidateSha256'], 'qualified': record['qualifiedManifestSha256'],
                                       'report': record['recoveryReportSha256']}, authorization=authorization)
        archive = receipt + '/candidate.tar.gz'
        raw = support.read_protected(archive, 0o600, receiver.MAX_ARCHIVE)
        evidence = verifier.verify_candidate(archive, request)
        require(evidence['admissionRecordSha256'] == approval['admission']['recordSha256']
                and hashlib.sha256(raw).hexdigest() == record['archiveSha256'] and len(raw) == record['archiveBytes'])
        selected = {service + '-image': image for service, image in record['images'].items()}
        entries = receiver.inspect_archive(raw, record['commit'], selected)
        verify_received_tree(receiver, receipt + '/release', entries)
        runtime, inventory, body, observations = inspect_install_host(approval, captured)
        require(authorization['inventoryIdentity'] == runtime.INVENTORY.identity(inventory))
        authority = {'sourceApprovalSha256': approval_binding_digest(approval),
                     'policySha256': approval['admission']['policySha256'],
                     'recordSha256': approval['admission']['recordSha256']}
        fresh = int(time.time()) < int(authorization['expiresAt'])
        if not fresh:
            intent = body.get('installIntent')
            require(allow_reserved_expired and intent is not None and
                    intent.get('authorizationFreshAtReservation') is True)
            runtime.STATE.validate_production_correspondence(
                intent['binding'], approval, record, inventory, authority)
        key, _, rechecked_body, _ = runtime.STATE.read_state(RUNTIME, repair_head=False,
                                                          inventory_identity=runtime.INVENTORY.identity(inventory))
        require(rechecked_body == body)
        b0_verification = {'artifactIntegrityVerified': False, 'storageFingerprintVerified': False,
                           'databaseRestoreVerified': False, 'liveSourceVerified': False,
                           'rollbackAuthorized': False, 'installationExecuted': False, 'deploymentAuthorized': False}
        if observations['b0Status'] == 'present_unverified':
            b0_verification = b0_evidence.enter_context(runtime.verify_production_b0_artifacts(
                body['installIntent']['binding'], inventory, key))
            observations['b0Status'] = 'integrity_verified'
        destination = RELEASES + '/' + record['commit']
        host_ancestry(destination)
        observations['candidateReleasePresent'] = os.path.lexists(destination)
        if observations['candidateReleasePresent']:
            require(stat.S_ISDIR(os.lstat(destination).st_mode))
        result = runtime.production_install_plan(record, authority,
            inventory, body, observations, approval=approval)
        result['b0Verification'] = b0_verification
        require(support.read_protected(archive, 0o600, receiver.MAX_ARCHIVE) == raw)
        verify_received_tree(receiver, receipt + '/release', entries)
        again = _authenticated_material()
        require(again[4] == digest and again[5] == record and again[1] == captured)
        final_key, _, final_body, _ = runtime.STATE.read_state(RUNTIME, repair_head=False,
                                                            inventory_identity=runtime.INVENTORY.identity(inventory))
        require(final_key == key and final_body == body)
        reaffirm()
        require(len(json.dumps(result).encode('utf-8')) <= 4096)
        return result


def _write_exact_private(path, raw):
    require(isinstance(raw, bytes) and 0 < len(raw) <= 1024 * 1024)
    if os.path.lexists(path):
        require(host_read(path, (0, 0), (0o600,), 1024 * 1024) == raw)
        return
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        written = 0
        while written < len(raw):
            count = os.write(descriptor, raw[written:])
            require(count > 0); written += count
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _release_directory(path, modes, owners=((0, 0),)):
    host_ancestry(os.path.join(path, '.entry'))
    info = os.lstat(path)
    require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
            and (info.st_uid, info.st_gid) in owners and stat.S_IMODE(info.st_mode) in modes)
    return host_identity(info)


def _sync_release_directory(path, modes, owners=((0, 0),)):
    before = _release_directory(path, modes, owners)
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        require(host_identity(os.fstat(descriptor)) == before)
        os.fsync(descriptor)
        require(host_identity(os.fstat(descriptor)) == before and host_identity(os.lstat(path)) == before)
    finally:
        os.close(descriptor)


def _release_file(path, expected, mode):
    host_ancestry(path)
    before = os.lstat(path)
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and (before.st_uid, before.st_gid) == (0, 0) and stat.S_IMODE(before.st_mode) == mode
            and before.st_size == len(expected))
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        require(host_identity(os.fstat(descriptor)) == host_identity(before))
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            raw = stream.read(len(expected) + 1)
        require(raw == expected and host_identity(os.fstat(descriptor)) == host_identity(before)
                and host_identity(os.lstat(path)) == host_identity(before))
    finally:
        os.close(descriptor)


def _partial_release_directory(root, relative=''):
    current = root
    _release_directory(current, (0o700,))
    for component in relative.split('/') if relative else ():
        require(component not in ('', '.', '..'))
        selected = os.path.join(current, component)
        if not os.path.lexists(selected):
            os.mkdir(selected, 0o755)
            _sync_release_directory(current, (0o700,) if current == root else (0o755,))
        _release_directory(selected, (0o755,))
        current = selected
    return current


def _publish_candidate_release(receiver, entries, destination, images, nonce):
    pending = RELEASES + '/.payload-install-' + nonce
    host_ancestry(destination)
    if os.path.lexists(destination):
        require(not os.path.lexists(pending))
        _release_directory(destination, (0o755,))
    else:
        if not os.path.lexists(pending):
            os.mkdir(pending, 0o700)
            _sync_release_directory(RELEASES, (0o755,), ((0, 0), (1000, 1000)))
        _release_directory(pending, (0o700,))
        for name, data in sorted(entries.items(), key=lambda item: (item[0].count('/'), item[0])):
            filename = os.path.join(pending, *name.split('/'))
            parent = _partial_release_directory(pending, os.path.dirname(name))
            if data is None:
                if not os.path.lexists(filename):
                    os.mkdir(filename, 0o755)
                    _sync_release_directory(parent, (0o700,) if parent == pending else (0o755,))
                _release_directory(filename, (0o755,))
                continue
            if os.path.lexists(filename):
                _release_file(filename, data, 0o644)
            else:
                descriptor = os.open(filename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
                try:
                    written = 0
                    while written < len(data):
                        count = os.write(descriptor, data[written:]); require(count > 0); written += count
                    os.fsync(descriptor)
                finally: os.close(descriptor)
                _release_file(filename, data, 0o644)
                _sync_release_directory(parent, (0o700,) if parent == pending else (0o755,))
        manifest = ('API_IMAGE=' + images['api'] + '\nCRON_IMAGE=' + images['cron'] + '\nCMS_IMAGE=' + images['cms'] +
                    '\nRELEASE_FORMAT=payload-v1\n').encode('ascii')
        _write_exact_private(pending + '/.image-env', manifest)
        _sync_release_directory(pending, (0o700,))
        verify_received_tree(receiver, pending, entries, private_files={'.image-env': manifest}, private_root=True)
        os.chmod(pending, 0o755)
        _sync_release_directory(pending, (0o755,))
        os.rename(pending, destination)
        _sync_release_directory(RELEASES, (0o755,), ((0, 0), (1000, 1000)))
    manifest = ('API_IMAGE=' + images['api'] + '\nCRON_IMAGE=' + images['cron'] + '\nCMS_IMAGE=' + images['cms'] +
                '\nRELEASE_FORMAT=payload-v1\n').encode('ascii')
    require(host_read(destination + '/.image-env', (0, 0), (0o600,), 4096) == manifest)
    verify_received_tree(receiver, destination, entries, private_files={'.image-env': manifest}, private_root=False)


def apply_install(receipt_id):
    plan = check_install_plan(receipt_id, allow_reserved_expired=True)
    require(plan['classification'] in ('initial_cold', 'pre_floor_install_pending', 'floor_commit_pending', 'floor_committed'))
    with deployment_lease() as reaffirm:
        approval, captured, _, support, digest, record, verifier = _authenticated_material()
        authorization = record['authorization']
        require(authorization['approvalSha256'] == approval_binding_digest(approval))
        receiver = load_authenticated(captured['ops/payload-receiver-admission.py'], ROOT + '/ops/payload-receiver-admission.py')
        receipt = receiver.INCOMING + '/' + receipt_id
        archive = receipt + '/candidate.tar.gz'
        raw = support.read_protected(archive, 0o600, receiver.MAX_ARCHIVE)
        request = {key: record[key] for key in ('commit', 'runId', 'runAttempt', 'images')}
        request.update(artifactIds={role: item['id'] for role, item in record['artifacts'].items()},
                       artifactDigests={role: item['digest'] for role, item in record['artifacts'].items()},
                       contentDigests={'candidate': record['candidateSha256'], 'qualified': record['qualifiedManifestSha256'],
                                       'report': record['recoveryReportSha256']}, authorization=authorization)
        evidence = verifier.verify_candidate(archive, request)
        require(evidence['admissionRecordSha256'] == approval['admission']['recordSha256'])
        entries = receiver.inspect_archive(raw, record['commit'], {name + '-image': value for name, value in record['images'].items()})
        destination = RELEASES + '/' + record['commit']
        _publish_candidate_release(receiver, entries, destination, record['images'], authorization['nonce'])
        runtime = load_runtime_captured(captured)
        inventory = runtime._inventory(force=True)['document']
        require(runtime.INVENTORY.identity(inventory) == authorization['inventoryIdentity'])
        if int(time.time()) >= int(authorization['expiresAt']):
            _, _, resumed, _ = runtime.STATE.read_state(
                RUNTIME, repair_head=False, inventory_identity=authorization['inventoryIdentity'])
            intent = resumed.get('installIntent')
            authority = {'sourceApprovalSha256': approval_binding_digest(approval),
                         'policySha256': approval['admission']['policySha256'],
                         'recordSha256': approval['admission']['recordSha256']}
            require(intent is not None and intent.get('authorizationFreshAtReservation') is True)
            runtime.STATE.validate_production_correspondence(
                intent['binding'], approval, record, inventory, authority)
        ticket = {'schemaVersion': 1, 'kind': 'payload-production-install-request-v1',
                  'candidate': runtime.STATE.production_candidate(record),
                  'authority': {'sourceApprovalSha256': approval_binding_digest(approval),
                                'policySha256': approval['admission']['policySha256'],
                                'recordSha256': approval['admission']['recordSha256']},
                  'inventoryIdentity': authorization['inventoryIdentity'],
                  'sourceCommit': approval['hostBaseline']['currentCommit'],
                  'expiresAt': authorization['expiresAt'], 'nonce': authorization['nonce']}
        ticket_path = RUNTIME + '/payload-production-install-' + authorization['nonce'] + '.json'
        ticket_raw = runtime.STATE.canonical(ticket) + b'\n'
        _write_exact_private(ticket_path, ticket_raw)
        reaffirm()
        result = run_bounded_subprocess(
            ['/usr/bin/python3', '-I', '-S', '-B', ROOT + '/ops/payload-control-runtime.py',
             'initialize-isolated', destination, ticket_path], timeout=APPLY_RUNTIME_TIMEOUT_SECONDS,
            pass_fds=(9,), group_mode='inherit')
        require(result.returncode == 0)
        reaffirm()
        final = _authenticated_material()
        require(final[4] == digest and final[5] == record)
        _, _, body, _ = runtime.STATE.read_state(RUNTIME, repair_head=False,
                                                 inventory_identity=authorization['inventoryIdentity'])
        require(body['installIntent']['stage'] == 'floor_committed' and body['authority'] == {'mode': 'legacy', 'epoch': 1}
                and body['admission'] == 'closed' and body['workerHold'] is True)
        return {'kind': 'payload-production-install-result-v1', 'status': 'installed-private',
                'authority': 'legacy', 'routeReleased': False, 'workerStarted': False,
                'commit': record['commit'], 'nonce': authorization['nonce']}


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


def context_material(expected_digest, metadata_only=False):
    require(type(metadata_only) is bool)
    require(isinstance(expected_digest, str) and len(expected_digest) == 64
            and all(c in '0123456789abcdef' for c in expected_digest))
    verify_inherited_lease()
    approval, captured, cms_image, support, digest = authenticate()
    require(digest == expected_digest)
    verify_host_baseline(approval, captured, cms_image, support,
                         metadata_only=metadata_only)
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
    portal_database = inventory.portal_database_from_environment(
        ENVIRONMENT, inventory.PRODUCTION_ENVIRONMENT_OWNER,
        lambda path: host_read(path, (1000, 1000), (0o600,), 1024 * 1024))
    value = inventory.production_inventory(HOST_ROOT, RUNTIME, RELEASES, HOST_ROOT + '/current-release', LOCK,
        '/opt/ownerinc/backups/portal-ownerinc/daily', PRODUCTION_BACKUP, PRODUCTION_BACKUP + '/restore-protection',
        ENVIRONMENT, RUNTIME + '/compose.production.yaml', RUNTIME + '/compose.payload.production.yaml', portal_database)
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
        result = run_bounded_subprocess(
            ['/bin/bash', '--noprofile', '--norc', ROOT + '/ops/prepare-cms-infrastructure.sh',
             '--authenticated-' + mode, digest], pass_fds=(9,), group_mode='new')
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
    require(args in (['--check'], ['--apply']) or len(args) == 2 and args[0] in
             ('--verify-context', '--create-inventory', '--check-install-plan', '--apply-install', '--collect-context'))
    require(sys.platform == 'linux' and os.getuid() == os.geteuid() == os.getgid() == os.getegid() == 0)
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode)
    require(set(os.environ) <= {'PATH', 'LANG', 'LC_ALL'} and os.environ.get('PATH') == '/usr/bin:/bin'
            and os.environ.get('LANG') == 'C' and os.environ.get('LC_ALL') == 'C')
    require(os.path.realpath(sys.executable) == os.path.realpath('/usr/bin/python3'))
    if args[0] == '--collect-context':
        require(authenticate()[4] == args[1])
        print(json.dumps(collect_context(), sort_keys=True, separators=(',', ':')))
    elif args[0] == '--check-install-plan':
        print(json.dumps(check_install_plan(args[1]), sort_keys=True))
    elif args[0] == '--apply-install':
        print(json.dumps(apply_install(args[1]), sort_keys=True, separators=(',', ':')))
    elif args[0] == '--verify-context':
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
