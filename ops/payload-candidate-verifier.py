#!/usr/bin/env python3
"""Read-only production candidate admission; never extracts or executes a bundle."""

import argparse
import hashlib
import json
import os
import re
import stat
import sys

POLICY_PATH = '/etc/ownerinc/payload-candidate/production-policy.json'
TOOL_ROOT = '/opt/ownerinc/lib/payload-candidate'
REGISTRY = '/var/lib/ownerinc/payload-candidate/records'
REPOSITORY = 'OWNERINC/portal_ownerinc'
WORKFLOW = '.github/workflows/ci.yml'
CONTRACT = 'payload-preauthority-recovery-v1'
TOOL_FILES = (
    'ops/payload-candidate-verifier.py',
    'scripts/register-payload-candidate-admission.mjs',
    'scripts/package-payload-candidate.mjs',
    'scripts/lib/payload-candidate-qualification.mjs',
)
ROLES = ('candidate', 'qualified', 'report')
SERVICES = ('api', 'cron', 'cms')
MAX_JSON = 1024 * 1024
MAX_ARCHIVE = 10 * 1024 * 1024


class AdmissionError(Exception):
    """Only closed reason codes cross the CLI boundary."""


def fail(code):
    raise AdmissionError(code)


def shape(value, fields):
    if not isinstance(value, dict) or set(value) != set(fields):
        fail('invalid_admission_shape')


def matches(value, pattern):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def hash64(value):
    return matches(value, r'[0-9a-f]{64}')


def identifier(value):
    return matches(value, r'[1-9][0-9]{0,19}')


def canonical_path(value):
    if (not matches(value, r'/[A-Za-z0-9_./-]{1,4095}')
            or os.path.normpath(value) != value or '//' in value):
        fail('unsafe_admission_path')
    return value


def strict_json(raw):
    if not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_JSON:
        fail('invalid_admission_json')

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                fail('duplicate_admission_field')
            result[key] = value
        return result

    def invalid_number(_value):
        fail('invalid_admission_number')

    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                           parse_float=invalid_number, parse_constant=invalid_number)
        pending = [(value, 0)]
        while pending:
            item, depth = pending.pop()
            if depth > 32:
                fail('admission_nesting_exceeded')
            if isinstance(item, (dict, list)):
                pending.extend((child, depth + 1) for child in
                               (item.values() if isinstance(item, dict) else item))
        return value
    except (ValueError, UnicodeError, RecursionError):
        fail('invalid_admission_json')


def validate_policy(policy):
    shape(policy, ('schemaVersion', 'kind', 'environment', 'repository', 'repositoryId',
                   'workflow', 'workflowId', 'approvedRevisions', 'toolchain'))
    if type(policy['schemaVersion']) is not int or policy['schemaVersion'] != 1:
        fail('unsupported_admission_policy')
    if (policy['kind'] != 'ownerinc-payload-candidate-policy-v1'
            or policy['environment'] != 'production' or policy['repository'] != REPOSITORY
            or policy['workflow'] != WORKFLOW or not identifier(policy['repositoryId'])
            or not identifier(policy['workflowId'])):
        fail('invalid_admission_policy')
    revisions = policy['approvedRevisions']
    if not isinstance(revisions, list) or not 1 <= len(revisions) <= 128:
        fail('invalid_approved_revisions')
    seen = set()
    for revision in revisions:
        shape(revision, ('commit', 'workflowSha256'))
        if (not matches(revision['commit'], r'[0-9a-f]{40}')
                or not hash64(revision['workflowSha256']) or revision['commit'] in seen):
            fail('invalid_approved_revisions')
        seen.add(revision['commit'])
    shape(policy['toolchain'], ('files', 'executables'))
    shape(policy['toolchain']['files'], TOOL_FILES)
    if not all(hash64(value) for value in policy['toolchain']['files'].values()):
        fail('invalid_admission_toolchain')
    shape(policy['toolchain']['executables'], ('node', 'git', 'python', 'gitRemoteHttps'))
    paths = set()
    for role, executable in policy['toolchain']['executables'].items():
        shape(executable, ('path', 'sha256'))
        selected = canonical_path(executable['path'])
        if (selected in paths or not hash64(executable['sha256'])
                or (role == 'git' and os.path.basename(selected) != 'git')
                or (role == 'gitRemoteHttps' and selected != TOOL_ROOT + '/bin/git-remote-https')):
            fail('invalid_admission_toolchain')
        paths.add(selected)
    return policy


def validate_images(images):
    shape(images, SERVICES)
    for service in SERVICES:
        if not matches(images[service], r'ghcr\.io/ownerinc/ownerinc-portal-' + service + r'@sha256:[0-9a-f]{64}'):
            fail('invalid_admission_images')


def validate_request(request):
    shape(request, ('commit', 'runId', 'runAttempt', 'images', 'artifactIds'))
    if (not matches(request['commit'], r'[0-9a-f]{40}')
            or not identifier(request['runId']) or not identifier(request['runAttempt'])):
        fail('invalid_admission_identity')
    validate_images(request['images'])
    shape(request['artifactIds'], ROLES)
    if (not all(identifier(value) for value in request['artifactIds'].values())
            or len(set(request['artifactIds'].values())) != 3):
        fail('invalid_admission_artifacts')


RECORD_FIELDS = (
    'schemaVersion', 'kind', 'environment', 'policySha256', 'repository', 'repositoryId',
    'workflow', 'workflowId', 'workflowSha256', 'commit', 'runId', 'runAttempt', 'images',
    'artifacts', 'qualificationContract', 'candidateSha256', 'qualifiedManifestSha256',
    'recoveryReportSha256', 'sourceTreeSha', 'sourceArchiveSha256', 'archiveSha256',
    'archiveBytes', 'deploymentAuthorized',
)


def validate_record(record):
    shape(record, RECORD_FIELDS)
    if type(record['schemaVersion']) is not int or record['schemaVersion'] != 1:
        fail('unsupported_admission_record')
    if (record['kind'] != 'payload-candidate-admission-record-v1'
            or record['environment'] != 'production' or record['repository'] != REPOSITORY
            or record['workflow'] != WORKFLOW or record['deploymentAuthorized'] is not False
            or record['qualificationContract'] != CONTRACT
            or not identifier(record['repositoryId']) or not identifier(record['workflowId'])):
        fail('invalid_admission_record')
    for field in ('policySha256', 'workflowSha256', 'candidateSha256', 'qualifiedManifestSha256',
                  'recoveryReportSha256', 'sourceArchiveSha256', 'archiveSha256'):
        if not hash64(record[field]):
            fail('invalid_admission_hash')
    if (not matches(record['sourceTreeSha'], r'[0-9a-f]{40}')
            or type(record['archiveBytes']) is not int or not 0 < record['archiveBytes'] <= MAX_ARCHIVE):
        fail('invalid_admission_archive')
    shape(record['artifacts'], ROLES)
    ids = {}
    for role, artifact in record['artifacts'].items():
        shape(artifact, ('id', 'digest'))
        if not matches(artifact['digest'], r'sha256:[0-9a-f]{64}'):
            fail('invalid_admission_artifacts')
        ids[role] = artifact['id']
    validate_request({key: record[key] for key in ('commit', 'runId', 'runAttempt', 'images')}
                     | {'artifactIds': ids})
    return record


def verify_record_binding(policy_raw, record, request, archive_hash, archive_size):
    """Pure binding check, NOT authentication of caller-provided JSON."""
    policy = validate_policy(strict_json(policy_raw))
    validate_record(record)
    validate_request(request)
    revision = next((item for item in policy['approvedRevisions'] if item['commit'] == request['commit']), None)
    if revision is None:
        fail('candidate_revision_not_approved')
    if (record['policySha256'] != hashlib.sha256(policy_raw).hexdigest()
            or any(record[key] != policy[key] for key in
                   ('environment', 'repository', 'repositoryId', 'workflow', 'workflowId'))
            or record['workflowSha256'] != revision['workflowSha256']):
        fail('admission_policy_binding_mismatch')
    if (any(record[key] != request[key] for key in ('commit', 'runId', 'runAttempt', 'images'))
            or any(record['artifacts'][role]['id'] != request['artifactIds'][role] for role in ROLES)):
        fail('admission_candidate_binding_mismatch')
    if record['archiveSha256'] != archive_hash or record['archiveBytes'] != archive_size:
        fail('admission_archive_binding_mismatch')
    # All returned strings are validated identifiers/hashes, not paths/private evidence.
    return {key: record[key] for key in RECORD_FIELDS if key not in ('kind', 'schemaVersion')}


def check_file_metadata(info, modes):
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        fail('unsafe_admission_file')
    if info.st_uid != 0 or info.st_gid != 0:
        fail('unsafe_admission_owner')
    if stat.S_IMODE(info.st_mode) not in modes:
        fail('unsafe_admission_permissions')


def check_directory_metadata(info, private=False):
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_gid != 0
            or stat.S_IMODE(info.st_mode) & 0o7022
            or (private and stat.S_IMODE(info.st_mode) != 0o700)):
        fail('unsafe_admission_ancestry')


def verify_ancestry(filename, private_parent=False):
    canonical_path(filename)
    if os.path.realpath(filename) != filename:
        fail('unsafe_admission_path')
    parent = os.path.dirname(filename)
    first = True
    while True:
        check_directory_metadata(os.lstat(parent), private_parent and first)
        if parent == '/':
            break
        parent = os.path.dirname(parent)
        first = False


def fingerprint(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
            info.st_mode, info.st_uid, info.st_gid, info.st_nlink)


def read_protected(filename, limit, modes=(0o600,), private_parent=False):
    verify_ancestry(filename, private_parent)
    before = os.lstat(filename)
    check_file_metadata(before, modes)
    if not 0 < before.st_size <= limit:
        fail('admission_file_limit_exceeded')
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        opened = os.fstat(descriptor)
        check_file_metadata(opened, modes)
        if fingerprint(before) != fingerprint(opened):
            fail('admission_file_changed')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            raw = stream.read(limit + 1)
        if len(raw) != opened.st_size or fingerprint(os.fstat(descriptor)) != fingerprint(opened):
            fail('admission_file_changed')
        check_file_metadata(os.lstat(filename), modes)
        if fingerprint(os.lstat(filename)) != fingerprint(opened):
            fail('admission_file_changed')
        verify_ancestry(filename, private_parent)
        return raw
    finally:
        os.close(descriptor)


def verify_installed_tools(policy):
    for relative, expected in policy['toolchain']['files'].items():
        modes = (0o755,) if relative.endswith('.py') else (0o644,)
        raw = read_protected(TOOL_ROOT + '/' + relative, 2 * MAX_JSON, modes)
        if hashlib.sha256(raw).hexdigest() != expected:
            fail('installed_admission_tool_mismatch')
    if os.path.abspath(__file__) != TOOL_ROOT + '/ops/payload-candidate-verifier.py':
        fail('admission_tool_not_installed')
    for executable in policy['toolchain']['executables'].values():
        raw = read_protected(executable['path'], 200 * MAX_JSON, (0o755,))
        if hashlib.sha256(raw).hexdigest() != executable['sha256']:
            fail('installed_admission_executable_mismatch')
    if os.path.realpath(sys.executable) != policy['toolchain']['executables']['python']['path']:
        fail('admission_interpreter_mismatch')


def verify_candidate(archive, request):
    if os.name != 'posix' or os.getuid() != 0 or os.geteuid() != 0:
        fail('root_posix_admission_required')
    policy_raw = read_protected(POLICY_PATH, MAX_JSON)
    policy = validate_policy(strict_json(policy_raw))
    verify_installed_tools(policy)
    validate_request(request)
    # No tar/zip library, subprocess, import from candidate, or extraction here.
    archive_raw = read_protected(archive, MAX_ARCHIVE)
    archive_hash = hashlib.sha256(archive_raw).hexdigest()
    policy_hash = hashlib.sha256(policy_raw).hexdigest()
    record_path = REGISTRY + '/' + archive_hash + '.' + policy_hash + '.json'
    record_raw = read_protected(record_path, MAX_JSON, private_parent=True)
    result = verify_record_binding(policy_raw, strict_json(record_raw), request, archive_hash, len(archive_raw))
    if read_protected(POLICY_PATH, MAX_JSON) != policy_raw:
        fail('admission_policy_changed')
    verify_installed_tools(policy)
    if (read_protected(archive, MAX_ARCHIVE) != archive_raw
            or read_protected(record_path, MAX_JSON, private_parent=True) != record_raw):
        fail('admission_file_changed')
    # External identity of the protected record bytes, never a circular self-field.
    result['admissionRecordSha256'] = hashlib.sha256(record_raw).hexdigest()
    return result


def main(args=None):
    class RedactedParser(argparse.ArgumentParser):
        def error(self, _message):
            fail('invalid_admission_arguments')

    parser = RedactedParser(add_help=False, allow_abbrev=False)
    parser.add_argument('action', choices=('verify',))
    for flag in ('archive', 'commit', 'run-id', 'run-attempt', 'api-image', 'cron-image', 'cms-image',
                 'candidate-artifact-id', 'qualified-artifact-id', 'report-artifact-id'):
        parser.add_argument('--' + flag, required=True)
    selected = sys.argv[1:] if args is None else args
    flags = selected[1::2]
    if len(selected) != 21 or len(flags) != len(set(flags)):
        fail('invalid_admission_arguments')
    values = parser.parse_args(selected)
    request = {'commit': values.commit, 'runId': values.run_id, 'runAttempt': values.run_attempt,
               'images': {role: getattr(values, role + '_image') for role in SERVICES},
               'artifactIds': {role: getattr(values, role + '_artifact_id') for role in ROLES}}
    print(json.dumps(verify_candidate(values.archive, request), sort_keys=True, separators=(',', ':')))


if __name__ == '__main__':
    try:
        # -I -S is part of the installed contract: no Python path or site injection.
        if not sys.flags.isolated or not sys.flags.no_site:
            fail('isolated_admission_interpreter_required')
        main()
    except (AdmissionError, OSError, ValueError, TypeError, SystemExit, RecursionError):
        print('Candidate admission verification failed closed.', file=sys.stderr)
        sys.exit(1)
