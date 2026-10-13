#!/usr/bin/python3
"""Installed, verification-only administrative entrypoint. Never dispatches preparation."""
import hashlib
import json
import os
import stat
import sys
import types

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


def verify():
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
    return {'kind': 'payload-preparation-verification-only', 'sourceAuthenticated': True,
            'admissionRecordAuthenticated': True, 'cmsImage': record['images']['cms'],
            'hostBaselineChecked': False, 'archiveBytesChecked': False,
            'preparationExecuted': False, 'deploymentAuthorized': False}


def main():
    require(sys.argv[1:] == ['--check'])
    require(sys.platform == 'linux' and os.getuid() == os.geteuid() == os.getgid() == os.getegid() == 0)
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode)
    require(set(os.environ) <= {'PATH', 'LANG', 'LC_ALL'} and os.environ.get('PATH') == '/usr/bin:/bin'
            and os.environ.get('LANG') == 'C' and os.environ.get('LC_ALL') == 'C')
    require(os.path.realpath(sys.executable) == os.path.realpath('/usr/bin/python3'))
    print(json.dumps(verify(), sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Neither imported validator exceptions nor paths/private bytes are public.
        print('Preparation verification denied.', file=sys.stderr)
        sys.exit(2)
