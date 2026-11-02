#!/usr/bin/python3
"""Offline administrative bootstrap. Authenticate this program BEFORE executing it."""

import argparse
import ctypes
import errno
import hashlib
import json
import os
import re
import stat
import sys
import time
import uuid

TOOL_ROOT = '/opt/ownerinc/lib/payload-candidate'
POLICY_PATH = '/etc/ownerinc/payload-candidate/production-policy.json'
STATE_ROOT = '/var/lib/ownerinc/payload-candidate'
TOOL_FILES = ('ops/payload-candidate-verifier.py', 'scripts/register-payload-candidate-admission.mjs',
              'scripts/package-payload-candidate.mjs', 'scripts/lib/payload-candidate-qualification.mjs')
MAX_JSON = 1024 * 1024
MAX_BINARY = 200 * MAX_JSON
PREPARATION_ROOT = '/opt/ownerinc/lib/payload-preparation'
PREPARATION_LAUNCHER = '/usr/local/libexec/ownerinc-payload-prepare.py'
PREPARATION_APPROVAL = '/etc/ownerinc/payload-preparation/production-approval.json'
PREPARATION_FILES = (
    'ops/prepare-cms-infrastructure.sh', 'ops/prepare-cms-infrastructure-private.py',
    'ops/payload-control-inventory.py', 'ops/payload-control-state.py',
    'ops/deploy-from-ci.sh', 'ops/payload-receiver-admission.py', 'ops/payload-receiver-root.sh',
    'ops/deploy-from-production-ci.sh', 'ops/payload-operations-guard.sh', 'ops/payload-control',
    'ops/payload-control-runtime.py', 'ops/compose.payload.production.yaml', 'docker-compose.payload.yml',
    'ops/payload-production-observer.py',
    'ops/prepare-cms-authenticated.py', 'ops/provision-payload-candidate-trust.py')


def preparation_target(relative):
    require(relative in PREPARATION_FILES, 'invalid_preparation_file')
    return PREPARATION_LAUNCHER if relative == 'ops/prepare-cms-authenticated.py' else PREPARATION_ROOT + '/' + relative


def preparation_mode(relative):
    return 0o644 if relative.endswith(('.yaml', '.yml')) else 0o755


def validate_preparation_approval(value):
    shape(value, ('schemaVersion', 'kind', 'environment', 'repository', 'source', 'hostBaseline', 'admission'))
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1
            and value['kind'] == 'ownerinc-payload-preparation-approval-v1'
            and value['environment'] == 'production' and value['repository'] == 'OWNERINC/portal_ownerinc',
            'invalid_preparation_approval')
    shape(value['source'], ('commit', 'files'))
    require(matches(value['source']['commit'], r'[0-9a-f]{40}'), 'invalid_source_commit')
    shape(value['source']['files'], PREPARATION_FILES)
    require(all(hash64(v) for v in value['source']['files'].values()), 'invalid_source_hash')
    baseline = value['hostBaseline']
    shape(baseline, ('currentCommit', 'legacyImages', 'releaseComposeSha256', 'runtimeComposeSha256',
                     'releaseOverrideSha256', 'inventoryIdentity', 'installedPredecessors'))
    require(matches(baseline['currentCommit'], r'[0-9a-f]{40}'), 'invalid_current_commit')
    shape(baseline['legacyImages'], ('api', 'cron'))
    for service, image in baseline['legacyImages'].items():
        require(matches(image, r'ghcr\.io/ownerinc/ownerinc-portal-' + service + r'@sha256:[0-9a-f]{64}'), 'invalid_legacy_image')
    for field in ('releaseComposeSha256', 'runtimeComposeSha256', 'inventoryIdentity'):
        require(hash64(baseline[field]), 'invalid_baseline_hash')
    require(baseline['releaseOverrideSha256'] is None or hash64(baseline['releaseOverrideSha256']), 'invalid_override_hash')
    predecessors = baseline['installedPredecessors']
    shape(predecessors, ('commonReceiver', 'receiverHelper', 'productionWrapper', 'operationsGuard', 'cmsCandidate'))
    require(hash64(predecessors['commonReceiver']) and all(v is None or hash64(v) for v in predecessors.values()),
            'invalid_predecessor_hash')
    shape(value['admission'], ('policySha256', 'archiveSha256', 'recordSha256'))
    require(all(hash64(v) for v in value['admission'].values()), 'invalid_admission_binding')
    return value


def load_preparation_inputs(approval_path, expected_hash, bundle):
    require(hash64(expected_hash), 'invalid_approval_digest')
    raw = read_protected(approval_path, 0o600, MAX_JSON)
    require(sha(raw) == expected_hash, 'approval_digest_mismatch')
    approval = validate_preparation_approval(strict_json(raw))
    bundle_layout(bundle, PREPARATION_FILES)
    targets = {}
    for relative in PREPARATION_FILES:
        mode = preparation_mode(relative)
        content = read_protected(bundle + '/' + relative, mode, 2 * MAX_JSON)
        require(sha(content) == approval['source']['files'][relative], 'preparation_source_mismatch')
        targets[preparation_target(relative)] = (content, mode, 2 * MAX_JSON)
    targets[PREPARATION_APPROVAL] = (raw, 0o600, MAX_JSON)
    return raw, approval, targets


def provision_preparation(mode, approval_path, expected_hash, bundle):
    original = load_preparation_inputs(approval_path, expected_hash, bundle)
    raw, _, targets = original
    snapshots = STATE_ROOT + '/trust-snapshots'
    directories(snapshots, missing=True, private=True)
    present = [existing_target(filename, expected) for filename, expected in targets.items()]
    if mode == 'check':
        return 'Preparation provisioning check passed; no files written; host eligibility not checked.'
    require(mode == 'apply', 'invalid_action')
    os.umask(0o077)
    directories(snapshots, create=True, private=True)
    for filename in targets:
        directories(os.path.dirname(filename), create=True)
    if not all(present):
        snapshot_prestate(raw, targets)
    for filename, expected in targets.items():
        if filename != PREPARATION_APPROVAL:
            publish(filename, expected)
    require(load_preparation_inputs(approval_path, expected_hash, bundle) == original, 'inputs_changed')
    for filename, expected in targets.items():
        if filename != PREPARATION_APPROVAL:
            require(existing_target(filename, expected), 'incomplete_preparation_closure')
    publish(PREPARATION_APPROVAL, targets[PREPARATION_APPROVAL])
    require(all(existing_target(f, e) for f, e in targets.items()), 'incomplete_installation')
    return 'Preparation closure installed; no preparation executed and no deployment authorized.'


class ProvisionError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise ProvisionError(code)


def shape(value, keys):
    require(isinstance(value, dict) and set(value) == set(keys), 'invalid_shape')


def matches(value, pattern):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def hash64(value):
    return matches(value, r'[0-9a-f]{64}')


def canonical_path(value):
    require(matches(value, r'/[A-Za-z0-9_./-]{1,4095}') and os.path.normpath(value) == value
            and '//' not in value, 'unsafe_path')
    return value


def strict_json(raw):
    require(isinstance(raw, bytes) and 0 < len(raw) <= MAX_JSON, 'invalid_json')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate_field')
            result[key] = value
        return result
    def invalid(_):
        raise ProvisionError('invalid_number')
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                           parse_float=invalid, parse_constant=invalid)
        pending = [(value, 0)]
        while pending:
            item, depth = pending.pop()
            require(depth <= 32, 'invalid_depth')
            if isinstance(item, (dict, list)):
                pending.extend((child, depth + 1) for child in
                               (item.values() if isinstance(item, dict) else item))
        return value
    except (ValueError, UnicodeError, RecursionError):
        raise ProvisionError('invalid_json') from None


def validate_toolchain(toolchain):
    shape(toolchain, ('files', 'executables'))
    shape(toolchain['files'], TOOL_FILES)
    require(all(hash64(value) for value in toolchain['files'].values()), 'invalid_tool_hash')
    shape(toolchain['executables'], ('node', 'git', 'python', 'gitRemoteHttps'))
    paths = set()
    for role, entry in toolchain['executables'].items():
        shape(entry, ('path', 'sha256'))
        selected = canonical_path(entry['path'])
        require(hash64(entry['sha256']) and selected not in paths
                and (role != 'git' or os.path.basename(selected) == 'git')
                and (role != 'gitRemoteHttps' or selected == TOOL_ROOT + '/bin/git-remote-https'),
                'invalid_executable')
        paths.add(selected)


def validate_policy(policy):
    # Bootstrap cannot import validators from the not-yet-authenticated bundle.
    # Compatibility tests compare this fixed contract with BOTH existing validators.
    shape(policy, ('schemaVersion', 'kind', 'environment', 'repository', 'repositoryId',
                   'workflow', 'workflowId', 'approvedRevisions', 'toolchain'))
    require(type(policy['schemaVersion']) is int and policy['schemaVersion'] == 1
            and policy['kind'] == 'ownerinc-payload-candidate-policy-v1'
            and policy['environment'] == 'production'
            and policy['repository'] == 'OWNERINC/portal_ownerinc'
            and policy['workflow'] == '.github/workflows/ci.yml'
            and matches(policy['repositoryId'], r'[1-9][0-9]{0,19}')
            and matches(policy['workflowId'], r'[1-9][0-9]{0,19}'), 'invalid_policy')
    revisions = policy['approvedRevisions']
    require(isinstance(revisions, list) and 1 <= len(revisions) <= 128, 'invalid_revisions')
    seen = set()
    for revision in revisions:
        shape(revision, ('commit', 'workflowSha256'))
        require(matches(revision['commit'], r'[0-9a-f]{40}') and hash64(revision['workflowSha256'])
                and revision['commit'] not in seen, 'invalid_revision')
        seen.add(revision['commit'])
    validate_toolchain(policy['toolchain'])
    return policy


def validate_approval(approval):
    shape(approval, ('schemaVersion', 'kind', 'policySha256', 'toolchain'))
    require(type(approval['schemaVersion']) is int and approval['schemaVersion'] == 1
            and approval['kind'] == 'ownerinc-payload-trust-provisioning-v1'
            and hash64(approval['policySha256']), 'invalid_approval')
    validate_toolchain(approval['toolchain'])
    return approval


def directory_metadata(info, private=False):
    require(stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid) == (0, 0)
            and not stat.S_IMODE(info.st_mode) & 0o7022
            and (not private or stat.S_IMODE(info.st_mode) == 0o700), 'unsafe_directory')


def directories(filename, create=False, private=False, missing=False):
    canonical_path(filename)
    current = '/'
    for part in [''] + filename.strip('/').split('/'):
        current = os.path.join(current, part) if part else current
        try:
            info = os.lstat(current)
        except FileNotFoundError:
            if create:
                try:
                    os.mkdir(current, 0o700)
                except FileExistsError:
                    pass
                info = os.lstat(current)
            elif missing:
                continue
            else:
                raise ProvisionError('missing_directory') from None
        directory_metadata(info, private and current == filename)
        if create and current != '/':
            # A prior attempt may have mkdir'd this entry but failed before its
            # parent fsync. Reaffirm every validated entry, not only new ones.
            # '/' has no separate parent entry; sync it once for its child.
            sync_directory(os.path.dirname(current))


def file_metadata(info, mode, limit):
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
            and (info.st_uid, info.st_gid) == (0, 0)
            and stat.S_IMODE(info.st_mode) == mode and 0 < info.st_size <= limit, 'unsafe_file')


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
            info.st_mode, info.st_uid, info.st_gid, info.st_nlink)


def read_protected(filename, mode, limit):
    canonical_path(filename)
    directories(os.path.dirname(filename))
    before = os.lstat(filename)
    file_metadata(before, mode, limit)
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(descriptor)
        file_metadata(opened, mode, limit)
        require(identity(before) == identity(opened), 'file_changed')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            raw = stream.read(limit + 1)
        require(len(raw) == opened.st_size and identity(os.fstat(descriptor)) == identity(opened)
                and identity(os.lstat(filename)) == identity(opened), 'file_changed')
        directories(os.path.dirname(filename))
        return raw
    finally:
        os.close(descriptor)


def bundle_layout(bundle, names):
    directories(bundle)
    tree = {'': set()}
    for name in names:
        parts = name.split('/')
        for index, part in enumerate(parts):
            parent = '/'.join(parts[:index])
            tree.setdefault(parent, set()).add(part)
    for relative, expected in tree.items():
        selected = os.path.join(bundle, relative) if relative else bundle
        directories(selected)
        require(set(os.listdir(selected)) == expected, 'unexpected_bundle_entry')


def load_inputs(approval_path, expected_hash, bundle):
    require(hash64(expected_hash), 'invalid_approval_digest')
    raw = read_protected(approval_path, 0o600, MAX_JSON)
    require(sha(raw) == expected_hash, 'approval_digest_mismatch')
    approval = validate_approval(strict_json(raw))
    names = (*TOOL_FILES, 'bin/git-remote-https', 'production-policy.json')
    bundle_layout(bundle, names)
    policy_raw = read_protected(bundle + '/production-policy.json', 0o600, MAX_JSON)
    require(sha(policy_raw) == approval['policySha256'], 'policy_digest_mismatch')
    policy = validate_policy(strict_json(policy_raw))
    require(policy['toolchain'] == approval['toolchain'], 'toolchain_approval_mismatch')
    targets = {}
    for relative in TOOL_FILES + ('bin/git-remote-https',):
        mode = 0o755 if relative.endswith('.py') or relative.startswith('bin/') else 0o644
        limit = MAX_BINARY if relative.startswith('bin/') else 2 * MAX_JSON
        content = read_protected(bundle + '/' + relative, mode, limit)
        expected = (approval['toolchain']['executables']['gitRemoteHttps']['sha256']
                    if relative.startswith('bin/') else approval['toolchain']['files'][relative])
        require(sha(content) == expected, 'bundle_hash_mismatch')
        targets[TOOL_ROOT + '/' + relative] = (content, mode, limit)
    targets[POLICY_PATH] = (policy_raw, 0o600, MAX_JSON)
    verify_host_executables(policy)
    return raw, policy, targets


def verify_host_executables(policy):
    for role, entry in policy['toolchain']['executables'].items():
        if role != 'gitRemoteHttps':
            require(sha(read_protected(entry['path'], 0o755, MAX_BINARY)) == entry['sha256'],
                    'host_executable_mismatch')


def existing_target(filename, expected):
    raw, mode, limit = expected
    directories(os.path.dirname(filename), missing=True)
    try:
        os.lstat(filename)
    except FileNotFoundError:
        return False
    require(read_protected(filename, mode, limit) == raw, 'destination_conflict')
    return True


def sync_directory(filename):
    descriptor = os.open(filename, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        directory_metadata(os.fstat(descriptor))
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def rename_noreplace(source, destination):
    # Unlike link+unlink, this never exposes nlink=2 after a crash. Linux only;
    # no replacing rename fallback when libc/kernel/filesystem lacks support.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, 'renameat2', None)
    require(rename is not None, 'atomic_noreplace_unavailable')
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1):
        code = ctypes.get_errno()
        if code == errno.EEXIST:
            raise FileExistsError(code, 'destination_exists')
        raise ProvisionError('atomic_publication_failed')


def publish(filename, expected):
    if existing_target(filename, expected):
        # A retry may follow a crash/error after rename but before directory
        # fsync. Reaffirm durability even when no bytes need publishing.
        fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            file_metadata(os.fstat(fd), expected[1], expected[2])
            os.fsync(fd)
        finally:
            os.close(fd)
        sync_directory(os.path.dirname(filename))
        return
    raw, mode, limit = expected
    parent = os.path.dirname(filename)
    directories(parent)
    temporary = parent + '/.trust-pending-' + uuid.uuid4().hex
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(raw)
            stream.flush()
            file_metadata(os.fstat(fd), mode, limit)
            os.fsync(fd)
    finally:
        os.close(fd)
    require(read_protected(temporary, mode, limit) == raw, 'staged_file_changed')
    try:
        rename_noreplace(temporary, filename)
    except FileExistsError:
        # Retain pending evidence. A concurrent identical publication is safe;
        # a conflicting publication must NEVER be replaced or repaired.
        require(existing_target(filename, expected), 'destination_conflict')
    sync_directory(parent)
    require(existing_target(filename, expected), 'publication_not_verified')


def snapshot_prestate(approval_raw, targets):
    root = STATE_ROOT + '/trust-snapshots'
    snapshot = root + '/' + uuid.uuid4().hex
    os.mkdir(snapshot, 0o700)
    sync_directory(root)
    entries = []
    for index, (filename, expected) in enumerate(targets.items()):
        present = existing_target(filename, expected)
        entries.append({'path': filename, 'present': present, 'mode': expected[1],
                        'uid': 0, 'gid': 0, 'sha256': sha(expected[0]) if present else None})
        if present:
            publish(snapshot + '/' + str(index) + '.before', (expected[0], 0o600, expected[2]))
    publish(snapshot + '/approval.json', (approval_raw, 0o600, MAX_JSON))
    manifest = (json.dumps({'schemaVersion': 1, 'kind': 'payload-trust-prestate', 'files': entries}) + '\n').encode()
    publish(snapshot + '/manifest.json', (manifest, 0o600, MAX_JSON))
    sync_directory(snapshot)


def provision(mode, approval_path, expected_hash, bundle):
    approval_raw, policy, targets = load_inputs(approval_path, expected_hash, bundle)
    private = [STATE_ROOT + '/' + part for part in ('records', 'work', 'incoming', 'trust-snapshots')]
    for directory in private:
        directories(directory, missing=True, private=True)
    present = [existing_target(filename, expected) for filename, expected in targets.items()]
    if mode == 'check':
        return 'Trust provisioning check passed; no files written.'
    require(mode == 'apply', 'invalid_action')
    os.umask(0o077)
    for directory in private:
        directories(directory, create=True, private=True)
    for filename in targets:
        directories(os.path.dirname(filename), create=True)
    if not all(present):
        snapshot_prestate(approval_raw, targets)
    for filename, expected in targets.items():
        if filename != POLICY_PATH:
            publish(filename, expected)
    # Reauthenticate inputs and host executables; verify the entire installed
    # closure before making the exact approved policy visible as the final file.
    require(load_inputs(approval_path, expected_hash, bundle) == (approval_raw, policy, targets), 'inputs_changed')
    for filename, expected in targets.items():
        if filename != POLICY_PATH:
            require(existing_target(filename, expected), 'incomplete_toolchain')
    publish(POLICY_PATH, targets[POLICY_PATH])
    verify_host_executables(policy)
    require(all(existing_target(filename, expected) for filename, expected in targets.items()), 'incomplete_installation')
    return 'Trust provisioning complete; candidate admission and deployment remain separate.'


def validate_rotation_approval(value):
    shape(value, ('schemaVersion', 'kind', 'environment', 'repository', 'repositoryId',
                  'workflow', 'workflowId', 'rotationId', 'issuedAt', 'expiresAt',
                  'fromPolicySha256', 'toPolicySha256', 'candidate', 'targetRevision'))
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1
            and value['kind'] == 'ownerinc-payload-policy-rotation-approval-v1'
            and value['environment'] == 'production'
            and value['repository'] == 'OWNERINC/portal_ownerinc' and value['repositoryId'] == '1308080511'
            and value['workflow'] == '.github/workflows/ci.yml' and value['workflowId'] == '317709204'
            and hash64(value['rotationId']), 'invalid_rotation_approval')
    require(type(value['issuedAt']) is int and type(value['expiresAt']) is int
            and 0 < value['expiresAt'] - value['issuedAt'] <= 3600, 'invalid_rotation_window')
    require(hash64(value['fromPolicySha256']) and hash64(value['toPolicySha256'])
            and value['fromPolicySha256'] != value['toPolicySha256'], 'invalid_rotation_digest')
    candidate = value['candidate']
    shape(candidate, ('commit', 'runId', 'runAttempt', 'approvalSha256', 'inventoryIdentity'))
    require(matches(candidate['commit'], r'[0-9a-f]{40}')
            and all(matches(candidate[key], r'[1-9][0-9]{0,19}') for key in ('runId', 'runAttempt'))
            and hash64(candidate['approvalSha256']) and hash64(candidate['inventoryIdentity']),
            'invalid_rotation_candidate')
    revision = value['targetRevision']
    shape(revision, ('commit', 'workflowSha256'))
    require(revision['commit'] == candidate['commit'] and hash64(revision['workflowSha256']),
            'invalid_rotation_revision')
    return value


def rotation_approval(approval_path, expected_hash):
    require(hash64(expected_hash), 'invalid_approval_digest')
    raw = read_protected(approval_path, 0o600, MAX_JSON)
    require(sha(raw) == expected_hash, 'approval_digest_mismatch')
    return raw, validate_rotation_approval(strict_json(raw))


def rotation_fresh(approval):
    return approval['issuedAt'] <= time.time() < approval['expiresAt']


def rotation_policy(raw):
    policy = validate_policy(strict_json(raw))
    require(policy['repositoryId'] == '1308080511' and policy['workflowId'] == '317709204',
            'rotation_policy_mismatch')
    return policy


def rotation_delta(before, after, approval):
    require({key: value for key, value in before.items() if key != 'approvedRevisions'}
            == {key: value for key, value in after.items() if key != 'approvedRevisions'}
            and after['approvedRevisions'] == [approval['targetRevision']]
            and all(item['commit'] != approval['targetRevision']['commit'] for item in before['approvedRevisions']),
            'rotation_delta_not_allowed')


def rotation_inputs(approval_path, expected_hash, bundle):
    raw, approval = rotation_approval(approval_path, expected_hash)
    bundle_layout(bundle, ('production-policy.json',))
    after_raw = read_protected(bundle + '/production-policy.json', 0o600, MAX_JSON)
    before_raw = read_protected(POLICY_PATH, 0o600, MAX_JSON)
    require(sha(before_raw) == approval['fromPolicySha256'] and sha(after_raw) == approval['toPolicySha256'],
            'rotation_policy_mismatch')
    before, after = rotation_policy(before_raw), rotation_policy(after_raw)
    rotation_delta(before, after, approval)
    require(rotation_fresh(approval), 'rotation_approval_not_current')
    return raw, approval, before_raw, after_raw, before, after


def verify_rotation_interpreter(policy):
    python = policy['toolchain']['executables']['python']['path']
    require(os.path.realpath(sys.executable) == python and os.path.realpath('/usr/bin/python3') == python,
            'python_interpreter_mismatch')


def verify_rotation_closure(policy):
    try:
        verify_rotation_interpreter(policy)
        for relative, digest in policy['toolchain']['files'].items():
            mode = 0o755 if relative.endswith('.py') else 0o644
            require(sha(read_protected(TOOL_ROOT + '/' + relative, mode, 2 * MAX_JSON)) == digest,
                    'rotation_closure_mismatch')
        # Unlike initial bootstrap, the HTTPS helper is already installed here.
        for entry in policy['toolchain']['executables'].values():
            require(sha(read_protected(entry['path'], 0o755, MAX_BINARY)) == entry['sha256'],
                    'rotation_closure_mismatch')
    except (ProvisionError, OSError):
        raise ProvisionError('rotation_closure_mismatch') from None


def rotation_directory_identity(filename, private=False):
    directories(filename, private=private)
    info = os.lstat(filename)
    directory_metadata(info, private)
    # Contents change during publication; inode/owner/mode must not change.
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)


class RotationLease:
    """Cooperative directory lease, NOT exclusion of unwrapped root writers."""

    def __enter__(self):
        import fcntl  # Rotation is Linux-only; importing this module remains portable.
        self.path = STATE_ROOT + '/records'
        self.token = rotation_directory_identity(self.path, private=True)
        self.empty_at_exit = False
        self.fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            try:
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                if error.errno in (errno.EACCES, errno.EAGAIN):
                    raise ProvisionError('rotation_lock_busy') from None
                raise
            self.verify()
            return self
        except BaseException:
            os.close(self.fd)
            raise

    def verify(self, empty=False):
        opened = os.fstat(self.fd)
        directory_metadata(opened, private=True)
        token = (opened.st_dev, opened.st_ino, opened.st_mode, opened.st_uid, opened.st_gid)
        require(token == self.token == rotation_directory_identity(self.path, private=True),
                'rotation_context_changed')
        if empty:
            require(not os.listdir(self.fd), 'rotation_registry_not_empty')
            require(self.token == rotation_directory_identity(self.path, private=True), 'rotation_context_changed')

    def __exit__(self, *_):
        try:
            self.verify(empty=self.empty_at_exit)
        finally:
            os.close(self.fd)


def rotation_manifest(approval_raw, approval):
    return {'schemaVersion': 1, 'kind': 'ownerinc-payload-policy-rotation-prestate-v1',
            'rotationId': approval['rotationId'], 'approvalSha256': sha(approval_raw),
            'fromPolicySha256': approval['fromPolicySha256'], 'toPolicySha256': approval['toPolicySha256']}


def rotation_completion(manifest_raw, approval):
    return {'schemaVersion': 1, 'kind': 'ownerinc-payload-policy-rotation-completion-v1',
            'rotationId': approval['rotationId'], 'manifestSha256': sha(manifest_raw),
            'activePolicySha256': approval['toPolicySha256']}


def rotation_json(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode('utf-8')


def rotation_document(raw, expected):
    value = strict_json(raw)
    shape(value, expected)
    require(type(value['schemaVersion']) is int and value == expected, 'rotation_evidence_conflict')


def inspect_rotation_snapshot(snapshot, approval_raw, approval):
    """Read-only classification. Partial or unknown evidence is never repaired."""
    names = ('approval.json', 'policy.before.json', 'policy.after.json', 'manifest.json', 'completion.json')
    try:
        token = rotation_directory_identity(snapshot, private=True)
        present = set(os.listdir(snapshot))
        stored = {}
        # Even an unexpected retained entry must be safe before it is classified
        # as a content conflict. Never follow links or descend into directories.
        for name in present:
            stored[name] = read_protected(snapshot + '/' + name, 0o600, MAX_JSON)
        require(token == rotation_directory_identity(snapshot, private=True)
                and present == set(os.listdir(snapshot)), 'rotation_evidence_unsafe')
    except (ProvisionError, OSError, ValueError):
        return 'unsafe', None
    try:
        require(os.path.basename(snapshot) == 'policy-rotation-' + approval['rotationId']
                and present <= set(names), 'rotation_evidence_conflict')
        if 'approval.json' in stored:
            require(stored['approval.json'] == approval_raw, 'rotation_evidence_conflict')
        policies = {}
        for name, field in (('policy.before.json', 'fromPolicySha256'), ('policy.after.json', 'toPolicySha256')):
            if name in stored:
                require(sha(stored[name]) == approval[field], 'rotation_evidence_conflict')
                policies[name] = rotation_policy(stored[name])
                revisions = policies[name]['approvedRevisions']
                require((revisions == [approval['targetRevision']] if name == 'policy.after.json' else
                         all(item['commit'] != approval['targetRevision']['commit'] for item in revisions)),
                        'rotation_evidence_conflict')
        if len(policies) == 2:
            rotation_delta(policies['policy.before.json'], policies['policy.after.json'], approval)
        manifest = stored.get('manifest.json')
        if manifest is not None:
            rotation_document(manifest, rotation_manifest(approval_raw, approval))
            require(set(names[:3]) <= present, 'rotation_evidence_conflict')
        if 'completion.json' in stored:
            require(manifest is not None, 'rotation_evidence_conflict')
            rotation_document(stored['completion.json'], rotation_completion(manifest, approval))
            return 'completion-recorded', manifest
        return ('prestate-valid', manifest) if manifest is not None else ('partial', None)
    except (ProvisionError, ValueError):
        return 'conflict', None


def consumed_rotation_check(snapshot, approval_raw, approval):
    state, _ = inspect_rotation_snapshot(snapshot, approval_raw, approval)
    active, observed = 'unknown', None
    try:
        observed = sha(read_protected(POLICY_PATH, 0o600, MAX_JSON))
        active = ('from' if observed == approval['fromPolicySha256'] else
                  'to' if observed == approval['toPolicySha256'] else 'other')
    except (ProvisionError, OSError, ValueError):
        pass
    code = {'unsafe': 'rotation_evidence_unsafe', 'conflict': 'rotation_evidence_conflict'}.get(state, 'rotation_id_consumed')
    return {'schemaVersion': 1, 'kind': 'ownerinc-payload-policy-rotation-check-v1', 'status': 'consumed',
            'code': code, 'rotationId': approval['rotationId'], 'eligible': False,
            'approvalFresh': rotation_fresh(approval), 'snapshotState': state, 'activePolicy': active,
            'observedPolicySha256': observed, 'mutated': False, 'deploymentAuthorized': False}


def rotation_stage(parent, raw):
    directories(parent)
    temporary = parent + '/.rotation-pending-' + uuid.uuid4().hex
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(raw)
            stream.flush()
            file_metadata(os.fstat(fd), 0o600, MAX_JSON)
            os.fsync(fd)
    finally:
        os.close(fd)
    require(read_protected(temporary, 0o600, MAX_JSON) == raw, 'rotation_context_changed')
    return temporary


def rotation_publish_evidence(filename, raw):
    # Deliberately not publish(): no adoption or durability reaffirmation of an
    # existing file is permitted within a single-use rotation reservation.
    require(not os.path.lexists(filename), 'rotation_evidence_conflict')
    temporary = rotation_stage(os.path.dirname(filename), raw)
    rename_noreplace(temporary, filename)
    sync_directory(os.path.dirname(filename))
    require(read_protected(filename, 0o600, MAX_JSON) == raw, 'rotation_evidence_conflict')


def replace_rotation_policy(temporary):
    # Only this profile may replace policy. Existing no-replace helpers retain
    # their original semantics; never unlink first or truncate the active file.
    os.replace(temporary, POLICY_PATH)


class RotationError(ProvisionError):
    def __init__(self, code, phase, cause):
        super().__init__(code)
        attempted = phase == 'swap-attempted'
        self.report = {'schemaVersion': 1, 'kind': 'ownerinc-payload-policy-rotation-failure-v1',
                       'code': code, 'phase': phase, 'cause': cause, 'replacementAttempted': attempted,
                       'message': ('Policy replacement may have occurred; administrative reconciliation required.' if attempted else
                                   'This invocation did not attempt policy replacement; private evidence may have been written.'),
                       'deploymentAuthorized': False}


def provision_policy_rotation(mode, approval_path, expected_hash, bundle):
    phase = 'preflight'
    try:
        require(mode in ('check', 'apply'), 'invalid_action')
        approval_raw, approval = rotation_approval(approval_path, expected_hash)
        with RotationLease() as lease:
            parent = STATE_ROOT + '/trust-snapshots'
            parent_token = rotation_directory_identity(parent, private=True)
            snapshot = parent + '/policy-rotation-' + approval['rotationId']
            # Consumption depends ONLY on the ID, not time, bundle, active policy,
            # closure health, or a new digest for reissued approval bytes.
            if os.path.lexists(snapshot):
                if mode == 'check':
                    return consumed_rotation_check(snapshot, approval_raw, approval)
                raise ProvisionError('rotation_id_consumed')
            original = rotation_inputs(approval_path, expected_hash, bundle)
            require(original[:2] == (approval_raw, approval), 'rotation_context_changed')
            _, _, before_raw, after_raw, before, after = original
            verify_rotation_closure(before)
            policy_parent = os.path.dirname(POLICY_PATH)
            policy_parent_token = rotation_directory_identity(policy_parent)
            lease.verify(empty=True)
            lease.empty_at_exit = True
            if mode == 'check':
                return {'schemaVersion': 1, 'kind': 'ownerinc-payload-policy-rotation-check-v1',
                        'status': 'eligible', 'rotationId': approval['rotationId'], 'eligible': True,
                        'mutated': False, 'ciProvenanceChecked': False, 'liveRuntimeChecked': False,
                        'networkUsed': False, 'githubAuthenticated': False, 'bundleCodeExecuted': False,
                        'liveInventoryChecked': False,
                        'candidateAuthorizationRenewed': False, 'deploymentAuthorized': False}
            require(parent_token == rotation_directory_identity(parent, private=True), 'rotation_context_changed')
            os.umask(0o077)
            phase = 'reservation-attempted'
            try:
                os.mkdir(snapshot, 0o700)
            except FileExistsError:
                raise ProvisionError('rotation_id_consumed') from None
            # No retry may ever fsync/reconcile this entry. External issuance and
            # attempt records must cover a crash before this parent fsync succeeds.
            sync_directory(parent)
            require(parent_token == rotation_directory_identity(parent, private=True), 'rotation_context_changed')
            phase = 'reserved'
            snapshot_token = rotation_directory_identity(snapshot, private=True)
            manifest_raw = rotation_json(rotation_manifest(approval_raw, approval))
            for name, raw in (('approval.json', approval_raw), ('policy.before.json', before_raw),
                              ('policy.after.json', after_raw), ('manifest.json', manifest_raw)):
                rotation_publish_evidence(snapshot + '/' + name, raw)
            sync_directory(snapshot)
            temporary = rotation_stage(policy_parent, after_raw)
            staged_identity = identity(os.lstat(temporary))

            def verify_paths():
                require(parent_token == rotation_directory_identity(parent, private=True)
                        and snapshot_token == rotation_directory_identity(snapshot, private=True)
                        and policy_parent_token == rotation_directory_identity(policy_parent), 'rotation_context_changed')

            require(rotation_inputs(approval_path, expected_hash, bundle) == original, 'rotation_context_changed')
            verify_rotation_closure(before)
            require(inspect_rotation_snapshot(snapshot, approval_raw, approval) == ('prestate-valid', manifest_raw),
                    'rotation_evidence_conflict')
            require(read_protected(temporary, 0o600, MAX_JSON) == after_raw
                    and staged_identity == identity(os.lstat(temporary)), 'rotation_context_changed')
            verify_paths()
            lease.verify(empty=True)
            require(read_protected(POLICY_PATH, 0o600, MAX_JSON) == before_raw, 'rotation_policy_mismatch')
            # Sample again after all potentially expensive hashes, immediately
            # before attempting replacement (not merely before preflight work).
            require(rotation_fresh(approval), 'rotation_approval_not_current')
            phase = 'swap-attempted'
            replace_rotation_policy(temporary)
            sync_directory(policy_parent)

            def verify_active():
                verify_rotation_closure(after)
                verify_paths()
                require(read_protected(POLICY_PATH, 0o600, MAX_JSON) == after_raw, 'rotation_policy_mismatch')
                lease.verify(empty=True)

            verify_active()
            rotation_publish_evidence(snapshot + '/completion.json', rotation_json(rotation_completion(manifest_raw, approval)))
            require(inspect_rotation_snapshot(snapshot, approval_raw, approval) == ('completion-recorded', manifest_raw),
                    'rotation_evidence_conflict')
            verify_active()
            return {'schemaVersion': 1, 'kind': 'ownerinc-payload-policy-rotation-result-v1',
                    'status': 'completed', 'rotationId': approval['rotationId'],
                    'activePolicySha256': approval['toPolicySha256'], 'ciProvenanceChecked': False,
                    'networkUsed': False, 'githubAuthenticated': False, 'bundleCodeExecuted': False,
                    'liveInventoryChecked': False,
                    'liveRuntimeChecked': False, 'candidateAuthorizationRenewed': False, 'deploymentAuthorized': False}
    except BaseException as error:
        cause = (str(error) if isinstance(error, ProvisionError) else
                 ('filesystem_or_input_failure' if phase == 'swap-attempted' else 'rotation_preswap_io_failed'))
        code = 'rotation_reconciliation_required' if phase == 'swap-attempted' else cause
        raise RotationError(code, phase, cause) from None


def main(args=None):
    class Parser(argparse.ArgumentParser):
        def error(self, _message):
            raise ProvisionError('invalid_arguments')
    parser = Parser(add_help=False, allow_abbrev=False)
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument('--check', action='store_true')
    actions.add_argument('--apply', action='store_true')
    for flag in ('approval', 'approval-sha256', 'bundle'):
        parser.add_argument('--' + flag, required=True)
    parser.add_argument('--profile', choices=('preparation', 'policy-rotation'))
    raw_args = sys.argv[1:] if args is None else args
    require(len(raw_args) == (9 if '--profile' in raw_args else 7), 'invalid_arguments')
    require(all(raw_args.count(flag) <= 1 for flag in
                ('--check', '--apply', '--approval', '--approval-sha256', '--bundle', '--profile')), 'invalid_arguments')
    selected = parser.parse_args(raw_args)
    require(sys.platform == 'linux' and os.getuid() == 0 and os.geteuid() == 0
            and os.getgid() == 0 and os.getegid() == 0, 'root_linux_required')
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode, 'isolated_python_required')
    require(set(os.environ) <= {'PATH', 'LANG', 'LC_ALL'}
            and os.environ.get('PATH') == '/usr/bin:/bin'
            and os.environ.get('LANG') == 'C' and os.environ.get('LC_ALL') == 'C', 'clean_environment_required')
    if selected.profile == 'policy-rotation':
        report = provision_policy_rotation('check' if selected.check else 'apply', selected.approval,
                                           selected.approval_sha256, selected.bundle)
        try:
            print(json.dumps(report, sort_keys=True), flush=True)
        except BaseException:
            phase = 'swap-attempted' if report['status'] == 'completed' else 'preflight'
            code = 'rotation_reconciliation_required' if phase == 'swap-attempted' else 'rotation_preswap_io_failed'
            raise RotationError(code, phase, 'report_output_failed') from None
        return 2 if report['status'] == 'consumed' else 0
    if selected.profile == 'preparation':
        require(os.path.realpath(sys.executable) == os.path.realpath('/usr/bin/python3'), 'python_interpreter_mismatch')
        print(provision_preparation('check' if selected.check else 'apply', selected.approval, selected.approval_sha256, selected.bundle))
        return
    _, policy, _ = load_inputs(selected.approval, selected.approval_sha256, selected.bundle)
    python = policy['toolchain']['executables']['python']['path']
    require(os.path.realpath(sys.executable) == python and os.path.realpath('/usr/bin/python3') == python,
            'python_interpreter_mismatch')
    print(provision('check' if selected.check else 'apply', selected.approval, selected.approval_sha256, selected.bundle))


if __name__ == '__main__':
    try:
        sys.exit(main())
    except RotationError as error:
        print(json.dumps(error.report, sort_keys=True), file=sys.stderr)
        sys.exit(2)
    except (ProvisionError, OSError, ValueError) as error:
        reason = str(error) if isinstance(error, ProvisionError) else 'filesystem_or_input_failure'
        print('Trust provisioning denied: ' + reason, file=sys.stderr)
        sys.exit(2)
