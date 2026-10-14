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
import re
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


def verify_received_tree(receiver, destination, entries):
    """Compare receiver extraction with authenticated archive, including empty files.

    This is a data reader, not the executable-trust reader. Never extract, merge,
    follow a link, import or execute anything in this tree.
    """
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
        receiver.protected_directory(filename, private=not relative)
        identities[filename] = receiver.identity(os.lstat(filename))
        require(set(os.listdir(filename)) == expected_names)
    for relative, expected in files.items():
        filename = destination + '/' + relative
        before = os.lstat(filename)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and (before.st_uid, before.st_gid) == (0, 0) and stat.S_IMODE(before.st_mode) == 0o644
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


def inspect_install_host(approval, captured):
    # Separate from preparation eligibility: inspect valid pending/committed
    # journals, never invoke Runtime.__init__ (which allows head repair).
    runtime = load_runtime_captured(captured)
    state, inventory = runtime.STATE, runtime.INVENTORY
    baseline = approval['hostBaseline']
    expected = inventory.production_inventory(HOST_ROOT, RUNTIME, RELEASES, HOST_ROOT + '/current-release', LOCK,
        '/opt/ownerinc/backups/portal-ownerinc/daily', PRODUCTION_BACKUP, PRODUCTION_BACKUP + '/restore-protection',
        ENVIRONMENT, RUNTIME + '/compose.production.yaml', RUNTIME + '/compose.payload.production.yaml')
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
    read(ENVIRONMENT, (1000, 1000), (0o600,))
    inventory.verify_environment_file(ENVIRONMENT, document['environmentFileOwner'])
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
    require(set(os.listdir(state_dir)) == journal_names and all(not os.path.lexists(f) for f in absent))
    lock_info = os.lstat(LOCK)
    ownership = all((i.st_uid, i.st_gid) == (0, 0) for i in (pointer_info, source_info, lock_info)) \
        and all(stat.S_IMODE(i.st_mode) == 0o600 for i in (pointer_info, source_info))
    return runtime, document, body, {'runtimeOwnershipCompatible': ownership,
        'isolatedSourceIdentityCompatible': baseline['currentCommit'] == hashlib.sha256(source_raw).hexdigest()[:40],
        'b0Status': b0_status}


def check_install_plan(receipt_id):
    require(isinstance(receipt_id, str) and re.fullmatch(r'payload-[a-z0-9_]{8}', receipt_id) is not None)
    with deployment_lease() as reaffirm:
        approval, captured, _, support, digest, record, verifier = _authenticated_material()
        receiver = load_authenticated(captured['ops/payload-receiver-admission.py'], ROOT + '/ops/payload-receiver-admission.py')
        receipt = receiver.INCOMING + '/' + receipt_id
        receiver.protected_directory(receipt, private=True)
        request = {key: record[key] for key in ('commit', 'runId', 'runAttempt', 'images')}
        request['artifactIds'] = {role: entry['id'] for role, entry in record['artifacts'].items()}
        archive = receipt + '/candidate.tar.gz'
        raw = support.read_protected(archive, 0o600, receiver.MAX_ARCHIVE)
        evidence = verifier.verify_candidate(archive, request)
        require(evidence['admissionRecordSha256'] == approval['admission']['recordSha256']
                and hashlib.sha256(raw).hexdigest() == record['archiveSha256'] and len(raw) == record['archiveBytes'])
        selected = {service + '-image': image for service, image in record['images'].items()}
        entries = receiver.inspect_archive(raw, record['commit'], selected)
        verify_received_tree(receiver, receipt + '/release', entries)
        runtime, inventory, body, observations = inspect_install_host(approval, captured)
        destination = RELEASES + '/' + record['commit']
        host_ancestry(destination)
        observations['candidateReleasePresent'] = os.path.lexists(destination)
        if observations['candidateReleasePresent']:
            require(stat.S_ISDIR(os.lstat(destination).st_mode))
        result = runtime.production_install_plan(record, {'sourceApprovalSha256': digest,
            'policySha256': approval['admission']['policySha256'], 'recordSha256': approval['admission']['recordSha256']},
            inventory, body, observations, approval=approval)
        require(support.read_protected(archive, 0o600, receiver.MAX_ARCHIVE) == raw)
        verify_received_tree(receiver, receipt + '/release', entries)
        again = _authenticated_material()
        require(again[4] == digest and again[5] == record and again[1] == captured)
        reaffirm()
        require(len(json.dumps(result).encode('utf-8')) <= 4096)
        return result


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
    require(args in (['--check'], ['--apply']) or len(args) == 2 and args[0] in ('--verify-context', '--create-inventory', '--check-install-plan'))
    require(sys.platform == 'linux' and os.getuid() == os.geteuid() == os.getgid() == os.getegid() == 0)
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode)
    require(set(os.environ) <= {'PATH', 'LANG', 'LC_ALL'} and os.environ.get('PATH') == '/usr/bin:/bin'
            and os.environ.get('LANG') == 'C' and os.environ.get('LC_ALL') == 'C')
    require(os.path.realpath(sys.executable) == os.path.realpath('/usr/bin/python3'))
    if args[0] == '--check-install-plan':
        print(json.dumps(check_install_plan(args[1]), sort_keys=True))
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
