#!/usr/bin/env python3
"""Bounded receiver transport. Admission is NOT permission to install."""

import gzip
import io
import os
import re
import stat
import subprocess
import sys
import tarfile
import tempfile

MAX_ARCHIVE = 10 * 1024 * 1024
MAX_EXPANDED = 128 * 1024 * 1024
MAX_MEMBERS = 20000
INCOMING = '/var/lib/ownerinc/payload-candidate/incoming'
VERIFIER = '/opt/ownerinc/lib/payload-candidate/ops/payload-candidate-verifier.py'
PYTHON = '/usr/bin/python3'
CLEAN_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
FIELDS = ('commit', 'run-id', 'run-attempt', 'api-image', 'cron-image', 'cms-image',
          'candidate-artifact-id', 'qualified-artifact-id', 'report-artifact-id')


class ReceiverError(Exception):
    """Closed reason codes only; never echo caller data or verifier stderr."""


def require(condition, code):
    if not condition:
        raise ReceiverError(code)


def parse_request(raw):
    parts = raw.split(' ')
    require(len(parts) == 10 and parts[0] == 'production:payload-v1', 'invalid_request')
    selected = dict(zip(FIELDS, parts[1:]))
    for field, value in selected.items():
        if field == 'commit':
            pattern = r'[0-9a-f]{40}'
        elif field.endswith('-image'):
            pattern = r'ghcr\.io/ownerinc/ownerinc-portal-' + field[:-6] + r'@sha256:[0-9a-f]{64}'
        else:
            pattern = r'[1-9][0-9]{0,19}'
        require(re.fullmatch(pattern, value) is not None, 'invalid_request')
    require(len({selected[key] for key in FIELDS[-3:]}) == 3, 'invalid_request')
    return selected


def receive(source, destination):
    chunks = []
    size = 0
    while size <= MAX_ARCHIVE:
        chunk = source.read(min(65536, MAX_ARCHIVE + 1 - size))
        if not chunk:
            break
        size += len(chunk)
        require(size <= MAX_ARCHIVE, 'archive_limit_exceeded')
        destination.write(chunk)
        chunks.append(chunk)
    require(size > 0, 'empty_archive')
    destination.flush()
    return b''.join(chunks)


def protected_directory(directory, private=False):
    require(os.path.isabs(directory) and os.path.realpath(directory) == directory,
            'unsafe_receipt_ancestry')
    first = True
    while True:
        info = os.lstat(directory)
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_gid == 0
                and not stat.S_IMODE(info.st_mode) & 0o7022
                and (not (private and first) or stat.S_IMODE(info.st_mode) == 0o700),
                'unsafe_receipt_ancestry')
        if directory == '/':
            break
        directory = os.path.dirname(directory)
        first = False


def identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
            info.st_mode, info.st_uid, info.st_gid, info.st_nlink)


def verify_receipt(archive, stream, raw, selected):
    protected_directory(os.path.dirname(archive), private=True)
    before = os.fstat(stream.fileno())
    require(stat.S_ISREG(before.st_mode) and before.st_uid == 0 and before.st_gid == 0
            and before.st_nlink == 1 and stat.S_IMODE(before.st_mode) == 0o600
            and identity(os.lstat(archive)) == identity(before), 'unsafe_receipt_file')
    command = [PYTHON, '-I', '-S', VERIFIER, 'verify', '--archive', archive]
    for key in FIELDS:
        command.extend(['--' + key, selected[key]])
    # Installed verifier authenticates its own toolchain, policy and protected record.
    result = subprocess.run(command, env=CLEAN_ENV, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False)
    require(result.returncode == 0, 'candidate_admission_denied')
    protected_directory(os.path.dirname(archive), private=True)
    require(identity(os.fstat(stream.fileno())) == identity(before)
            and identity(os.lstat(archive)) == identity(before), 'receipt_identity_changed')
    stream.seek(0)
    require(stream.read(MAX_ARCHIVE + 1) == raw, 'receipt_bytes_changed')
    # Extraction uses raw (immutable bytes), NEVER a reopened pathname or just a hash.
    # A different inode replacing the path during verification is explicitly denied.
    return result.stdout


def inspect_archive(raw, commit, selected):
    with gzip.GzipFile(fileobj=io.BytesIO(raw)) as compressed:
        expanded = compressed.read(MAX_EXPANDED + 1)
    require(len(expanded) <= MAX_EXPANDED, 'expanded_archive_limit_exceeded')
    entries = {}
    with tarfile.open(fileobj=io.BytesIO(expanded), mode='r:') as archive:
        for member in archive:
            require(len(entries) < MAX_MEMBERS, 'archive_member_limit_exceeded')
            name = member.name
            if name.startswith('./'):
                name = name[2:]
            if member.isdir():
                name = name.rstrip('/')
            require(name and not name.startswith('/') and '\\' not in name
                    and not re.search(r'[\x00-\x1f\x7f:]', name)
                    and all(part not in ('', '.', '..') for part in name.split('/'))
                    and name not in entries and (member.isfile() or member.isdir())
                    and not member.issparse(), 'unsafe_archive_member')
            entries[name] = None if member.isdir() else archive.extractfile(member).read()
    for name in entries:
        parent = os.path.dirname(name)
        while parent:
            require(parent not in entries or entries[parent] is None, 'unsafe_archive_member')
            parent = os.path.dirname(parent)
    validate_metadata(entries, commit, selected)
    return entries


def validate_metadata(entries, commit, selected):
    require(entries.get('.ci-commit') in (commit.encode(), (commit + '\n').encode()),
            'archive_commit_mismatch')
    manifest = entries.get('.ci-images')
    require(isinstance(manifest, bytes) and len(manifest) < 1024, 'invalid_image_manifest')
    # A single optional terminal LF, never blank/CR/extra/duplicate metadata lines.
    images = manifest.removesuffix(b'\n').split(b'\n')
    require(len(images) == (3 if selected else 2), 'payload_requires_admission')
    for service, image in zip(('api', 'cron', 'cms'), images):
        require(re.fullmatch(rb'ghcr\.io/ownerinc/ownerinc-portal-' + service.encode()
                             + rb'@sha256:[0-9a-f]{64}', image) is not None, 'invalid_image_manifest')
        if selected:
            require(image == selected[service + '-image'].encode(), 'archive_image_mismatch')
    require('.image-env' not in entries, 'reserved_archive_metadata')


def extract_entries(entries, destination, commit, selected):
    os.mkdir(destination, 0o700)  # Exclusive destination, never merge with an existing release.
    for name, data in entries.items():
        filename = os.path.join(destination, *name.split('/'))
        if data is None:
            os.makedirs(filename, mode=0o755, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(filename), mode=0o755, exist_ok=True)
            with open(filename, 'xb') as output:
                output.write(data)
            os.chmod(filename, 0o644)
    actual = {}
    for name in ('.ci-commit', '.ci-images'):
        with open(os.path.join(destination, name), 'rb') as stream:
            actual[name] = stream.read(1024)
    validate_metadata(actual, commit, selected)


def payload_request(request, source):
    selected = parse_request(request)
    require(os.name == 'posix' and os.getuid() == 0 and os.geteuid() == 0,
            'root_posix_admission_required')
    # No mkdir/chmod of existing host paths: operator provisions this protected chain.
    protected_directory(INCOMING, private=True)
    receipt = tempfile.mkdtemp(prefix='payload-', dir=INCOMING)
    protected_directory(receipt, private=True)
    print('Payload receipt: ' + os.path.basename(receipt), file=sys.stderr)
    archive = os.path.join(receipt, 'candidate.tar.gz')
    with open(archive, 'x+b') as stream:
        os.chmod(archive, 0o600)
        raw = receive(source, stream)
        os.fsync(stream.fileno())
        evidence = verify_receipt(archive, stream, raw, selected)
    with open(os.path.join(receipt, 'admission.json'), 'xb') as output:
        output.write(evidence)
    entries = inspect_archive(raw, selected['commit'], selected)
    extract_entries(entries, os.path.join(receipt, 'release'), selected['commit'], selected)
    # Do not dispatch runtime/controller code, source a candidate, or touch resources.
    # install_receiver_preflight() remains unconditionally closed in the controller.
    raise ReceiverError('release_not_preflighted')


def legacy_request(archive, destination, commit, source):
    require(re.fullmatch(r'[0-9a-f]{40}', commit) is not None, 'invalid_request')
    # The shell reserves this file with mktemp. Never follow a replacement link.
    descriptor = os.open(archive, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, 'r+b') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == 0
                and info.st_uid == os.geteuid() and stat.S_IMODE(info.st_mode) == 0o600,
                'unsafe_receipt_file')
        raw = receive(source, stream)
    entries = inspect_archive(raw, commit, None)
    extract_entries(entries, destination, commit, None)


def main(args):
    os.umask(0o077)
    require(sys.flags.isolated and sys.flags.no_site, 'isolated_receiver_required')
    if len(args) == 2 and args[0] == 'payload':
        payload_request(args[1], sys.stdin.buffer)
    elif len(args) == 4 and args[0] == 'legacy':
        legacy_request(*args[1:], sys.stdin.buffer)
    else:
        raise ReceiverError('invalid_request')


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except ReceiverError as error:
        print('Receiver denied: ' + str(error), file=sys.stderr)
        sys.exit(2)
    except (OSError, ValueError, EOFError, tarfile.TarError, subprocess.SubprocessError):
        print('Receiver denied: receipt_or_archive_invalid', file=sys.stderr)
        sys.exit(2)
