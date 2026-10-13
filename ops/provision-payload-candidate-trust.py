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
    return 'Preparation verification closure installed; preparation execution and deployment remain disabled.'


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
    parser.add_argument('--profile', choices=('preparation',))
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
        main()
    except (ProvisionError, OSError, ValueError) as error:
        reason = str(error) if isinstance(error, ProvisionError) else 'filesystem_or_input_failure'
        print('Trust provisioning denied: ' + reason, file=sys.stderr)
        sys.exit(2)
