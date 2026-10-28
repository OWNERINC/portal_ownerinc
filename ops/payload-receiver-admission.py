#!/usr/bin/env python3
"""Bounded receiver transport. Admission is NOT permission to install."""

import gzip
import io
import os
import re
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from contextlib import contextmanager

MAX_ARCHIVE = 10 * 1024 * 1024
MAX_EXPANDED = 128 * 1024 * 1024
MAX_MEMBERS = 20000
MAX_INCOMING_BYTES = 256 * 1024 * 1024
MAX_RECEIPTS = 128
MAX_SUBPROCESS_OUTPUT = 64 * 1024
MAX_RECEIPT_BYTES = MAX_ARCHIVE + MAX_EXPANDED + (2 * MAX_SUBPROCESS_OUTPUT) + 4096
SUBPROCESS_TIMEOUT = 120
APPLY_SUBPROCESS_TIMEOUT = 7200
SUBPROCESS_CLEANUP_SECONDS = 3
INCOMING = '/var/lib/ownerinc/payload-candidate/incoming'
NONCES = '/var/lib/ownerinc/payload-candidate/nonces'
LOCK_ROOT = '/var/lib/ownerinc/payload-candidate/locks'
QUOTA_LOCK = LOCK_ROOT + '/incoming.lock'
VERIFIER = '/opt/ownerinc/lib/payload-candidate/ops/payload-candidate-verifier.py'
PREFLIGHT = '/usr/local/libexec/ownerinc-payload-prepare.py'
PYTHON = '/usr/bin/python3'
CLEAN_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
RECEIVER_UID = 0
RECEIVER_GID = 0
FIELDS = ('commit', 'run-id', 'run-attempt', 'api-image', 'cron-image', 'cms-image',
          'candidate-artifact-id', 'qualified-artifact-id', 'report-artifact-id',
          'candidate-artifact-digest', 'qualified-artifact-digest', 'report-artifact-digest',
          'candidate-sha256', 'qualified-sha256', 'report-sha256', 'approval-sha256',
          'inventory-identity', 'expires-at', 'nonce')


class ReceiverError(Exception):
    """Closed reason codes only; never echo caller data or verifier stderr."""


def require(condition, code):
    if not condition:
        raise ReceiverError(code)


def parse_request(raw):
    parts = raw.split(' ')
    require(len(parts) == len(FIELDS) + 1 and parts[0] == 'production:payload-v2', 'invalid_request')
    selected = dict(zip(FIELDS, parts[1:]))
    for field, value in selected.items():
        if field == 'commit':
            pattern = r'[0-9a-f]{40}'
        elif field.endswith('-image'):
            pattern = r'ghcr\.io/ownerinc/ownerinc-portal-' + field[:-6] + r'@sha256:[0-9a-f]{64}'
        elif field.endswith('-artifact-digest'):
            pattern = r'sha256:[0-9a-f]{64}'
        elif field.endswith('-sha256') or field in ('inventory-identity', 'nonce'):
            pattern = r'[0-9a-f]{64}'
        elif field == 'expires-at':
            pattern = r'[1-9][0-9]{9}'
        else:
            pattern = r'[1-9][0-9]{0,19}'
        require(re.fullmatch(pattern, value) is not None, 'invalid_request')
    require(len({selected[key] for key in ('candidate-artifact-id', 'qualified-artifact-id', 'report-artifact-id')}) == 3,
            'invalid_request')
    return selected


def bounded_subprocess(command, output_limit=MAX_SUBPROCESS_OUTPUT, timeout=SUBPROCESS_TIMEOUT):
    require(type(output_limit) is int and 0 < output_limit <= MAX_SUBPROCESS_OUTPUT, 'subprocess_contract_invalid')
    require(type(timeout) is int and 0 < timeout <= 7200, 'subprocess_contract_invalid')
    require(isinstance(command, list) and command and all(isinstance(value, str) and value for value in command),
            'subprocess_contract_invalid')
    output = bytearray()
    exceeded = threading.Event()
    reader_error = []
    process = None
    reader = None

    def enable_subreaper():
        if sys.platform == 'linux':
            import ctypes
            require(ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0, 'subprocess_contract_invalid')

    def signal_group(selected):
        try:
            if os.name == 'posix':
                os.killpg(process.pid, selected)
            elif process.poll() is None:
                process.send_signal(selected)
        except ProcessLookupError:
            pass

    def cleanup_group():
        # The receiver owns the session rooted at process.pid. Cleanup is always
        # wall-clock bounded; a kernel that cannot reap it is a fail-stop error.
        deadline = time.monotonic() + SUBPROCESS_CLEANUP_SECONDS
        signal_group(signal.SIGTERM)
        if process.poll() is None:
            try:
                process.wait(timeout=max(0.01, min(0.5, deadline - time.monotonic())))
            except subprocess.TimeoutExpired:
                pass
        signal_group(getattr(signal, 'SIGKILL', signal.SIGTERM))
        if process.poll() is None:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ReceiverError('subprocess_cleanup_failed')
            try:
                process.wait(timeout=remaining)
            except subprocess.TimeoutExpired:
                raise ReceiverError('subprocess_cleanup_failed') from None
        if os.name == 'posix':
            while True:
                try:
                    child, _ = os.waitpid(-process.pid, os.WNOHANG)
                except ChildProcessError:
                    break
                if child == 0:
                    if time.monotonic() >= deadline:
                        raise ReceiverError('subprocess_cleanup_failed')
                    time.sleep(0.01)

    def consume():
        try:
            while True:
                chunk = process.stdout.read(min(8192, output_limit + 1 - len(output)))
                if not chunk:
                    return
                output.extend(chunk)
                if len(output) > output_limit:
                    exceeded.set()
                    return
        except (OSError, ValueError) as error:
            reader_error.append(error)

    failure = None
    try:
        enable_subreaper()
        process = subprocess.Popen(command, env=CLEAN_ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, shell=False, start_new_session=(os.name == 'posix'))
        reader = threading.Thread(target=consume, name='payload-bounded-output', daemon=True)
        reader.start()
        deadline = time.monotonic() + timeout
        while process.poll() is None and not exceeded.wait(0.01):
            if time.monotonic() >= deadline:
                failure = 'subprocess_timeout'
                break
        if exceeded.is_set():
            failure = 'subprocess_output_limit_exceeded'
        if failure is None:
            remaining = max(0.0, deadline - time.monotonic())
            reader.join(min(remaining, 1.0))
            if reader.is_alive():
                failure = 'subprocess_timeout'
            elif reader_error or len(output) > output_limit:
                failure = 'subprocess_output_limit_exceeded'
        returncode = process.returncode
    except OSError:
        failure = 'subprocess_cleanup_failed'
    finally:
        if process is not None:
            cleanup_group()
            if reader is not None:
                reader.join(max(0.0, min(0.5, SUBPROCESS_CLEANUP_SECONDS)))
            if reader is not None and reader.is_alive():
                failure = 'subprocess_cleanup_failed'
            if process.stdout is not None:
                process.stdout.close()
    if failure is not None:
        raise ReceiverError(failure)
    return subprocess.CompletedProcess(command, returncode, bytes(output), b'')


def incoming_quota(reserve_bytes=0, reserve_receipts=0):
    require(type(reserve_bytes) is int and 0 <= reserve_bytes <= MAX_INCOMING_BYTES and
            type(reserve_receipts) is int and reserve_receipts in (0, 1), 'incoming_quota_exceeded')
    protected_directory(INCOMING, private=True)
    total = 0
    count = 0
    with os.scandir(INCOMING) as entries:
        for entry in entries:
            info = entry.stat(follow_symlinks=False)
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == RECEIVER_UID and info.st_gid == RECEIVER_GID and
                    stat.S_IMODE(info.st_mode) == 0o700, 'unsafe_receipt_ancestry')
            count += 1
            require(count <= MAX_RECEIPTS - reserve_receipts, 'incoming_quota_exceeded')
            pending = [entry.path]
            while pending:
                directory = pending.pop()
                with os.scandir(directory) as children:
                    for child in children:
                        child_info = child.stat(follow_symlinks=False)
                        if stat.S_ISDIR(child_info.st_mode):
                            require(child_info.st_uid == RECEIVER_UID and child_info.st_gid == RECEIVER_GID and
                                    not stat.S_IMODE(child_info.st_mode) & 0o0022, 'unsafe_receipt_ancestry')
                            pending.append(child.path)
                        else:
                            require(stat.S_ISREG(child_info.st_mode) and child_info.st_uid == RECEIVER_UID and child_info.st_gid == RECEIVER_GID and
                                    child_info.st_nlink == 1, 'unsafe_receipt_file')
                            total += child_info.st_size
                            require(total <= MAX_INCOMING_BYTES - reserve_bytes, 'incoming_quota_exceeded')
    return total, count


def _lock_operation(descriptor, unlock=False):
    if os.name == 'posix':
        import fcntl
        fcntl.flock(descriptor, fcntl.LOCK_UN if unlock else fcntl.LOCK_EX)
    else:
        import msvcrt
        os.lseek(descriptor, 0, os.SEEK_SET)
        msvcrt.locking(descriptor, msvcrt.LK_UNLCK if unlock else msvcrt.LK_LOCK, 1)


@contextmanager
def incoming_lock():
    protected_directory(LOCK_ROOT, private=True)
    created = False
    try:
        descriptor = os.open(QUOTA_LOCK, os.O_RDWR | os.O_CREAT | os.O_EXCL |
                             getattr(os, 'O_NOFOLLOW', 0), 0o600)
        created = True
    except FileExistsError:
        descriptor = os.open(QUOTA_LOCK, os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0))
    try:
        info = os.fstat(descriptor)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == RECEIVER_UID and info.st_gid == RECEIVER_GID and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == 0o600 and identity(os.lstat(QUOTA_LOCK)) == identity(info),
                'unsafe_receipt_ancestry')
        if created:
            os.fsync(descriptor)
        sync_directory(LOCK_ROOT)
        _lock_operation(descriptor)
        require(identity(os.fstat(descriptor)) == identity(info) and identity(os.lstat(QUOTA_LOCK)) == identity(info),
                'unsafe_receipt_ancestry')
        yield
    finally:
        try:
            _lock_operation(descriptor, unlock=True)
        finally:
            os.close(descriptor)


def reap_expired_nonces(now):
    protected_directory(NONCES, private=True)
    changed = False
    with os.scandir(NONCES) as entries:
        for entry in entries:
            info = entry.stat(follow_symlinks=False)
            require(stat.S_ISREG(info.st_mode) and info.st_uid == RECEIVER_UID and info.st_gid == RECEIVER_GID and info.st_nlink == 1
                    and stat.S_IMODE(info.st_mode) == 0o600, 'unsafe_receipt_file')
            raw = read_private_file(entry.path, 32)
            require(re.fullmatch(rb'[1-9][0-9]{9}\n', raw) is not None, 'unsafe_receipt_file')
            if int(raw[:-1]) <= now:
                os.unlink(entry.path)
                changed = True
    if changed:
        sync_directory(NONCES)


def reserve_nonce(selected, now=None):
    now = int(time.time()) if now is None else now
    expires = int(selected['expires-at'])
    require(now < expires <= now + 86400, 'request_expired')
    protected_directory(NONCES, private=True)
    marker = os.path.join(NONCES, selected['nonce'])
    try:
        descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    except FileExistsError:
        raise ReceiverError('request_replayed') from None
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write((selected['expires-at'] + '\n').encode('ascii'))
        stream.flush()
        os.fsync(stream.fileno())
    sync_directory(NONCES)
    return marker


@contextmanager
def reserve_admission(selected):
    now = int(time.time())
    # The exclusive lock serializes the complete incoming mutation. Worst-case
    # archive bytes are reserved before the receipt exists; actual aggregate
    # bytes are checked again before releasing the lock.
    with incoming_lock():
        reap_expired_nonces(now)
        incoming_quota(MAX_RECEIPT_BYTES, 1)
        reserve_nonce(selected, now)
        receipt = tempfile.mkdtemp(prefix='payload-', dir=INCOMING)
        protected_directory(receipt, private=True)
        sync_directory(INCOMING)
        try:
            yield receipt
        finally:
            incoming_quota()
            sync_directory(receipt)


def sync_directory(directory):
    protected_directory(directory, private=True)
    # Portable tests can override os.name for the POSIX control path while the
    # underlying Windows kernel still cannot open directories as file handles.
    if sys.platform == 'win32':
        return
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def read_private_file(filename, limit):
    require(type(limit) is int and 0 < limit <= MAX_SUBPROCESS_OUTPUT, 'unsafe_receipt_file')
    protected_directory(os.path.dirname(filename), private=True)
    before = os.lstat(filename)
    require(stat.S_ISREG(before.st_mode) and before.st_uid == RECEIVER_UID and before.st_gid == RECEIVER_GID and before.st_nlink == 1
            and stat.S_IMODE(before.st_mode) == 0o600 and 0 < before.st_size <= limit, 'unsafe_receipt_file')
    descriptor = os.open(filename, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | os.O_NONBLOCK)
    try:
        require(identity(os.fstat(descriptor)) == identity(before), 'receipt_identity_changed')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            raw = stream.read(limit + 1)
        require(len(raw) == before.st_size and identity(os.fstat(descriptor)) == identity(before)
                and identity(os.lstat(filename)) == identity(before), 'receipt_identity_changed')
        return raw
    finally:
        os.close(descriptor)


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
    result = bounded_subprocess(command)
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
    with reserve_admission(selected) as receipt:
        print('Payload receipt: ' + os.path.basename(receipt), file=sys.stderr)
        archive = os.path.join(receipt, 'candidate.tar.gz')
        with open(archive, 'x+b') as stream:
            os.chmod(archive, 0o600)
            raw = receive(source, stream)
            os.fsync(stream.fileno())
            evidence = verify_receipt(archive, stream, raw, selected)
        with open(os.path.join(receipt, 'admission.json'), 'xb') as output:
            output.write(evidence)
            output.flush()
            os.fsync(output.fileno())
        entries = inspect_archive(raw, selected['commit'], selected)
        extract_entries(entries, os.path.join(receipt, 'release'), selected['commit'], selected)
        # The admission boundary may invoke only the authenticated read-only plan.
        # Installation is a distinct request and can never be reached by archive input.
        result = bounded_subprocess([PYTHON, '-I', '-S', '-B', PREFLIGHT, '--check-install-plan', os.path.basename(receipt)], 4096)
        require(result.returncode == 0, 'candidate_preflight_denied')
        with open(os.path.join(receipt, 'preflight.json'), 'xb') as output:
            output.write(result.stdout)
            output.flush()
            os.fsync(output.fileno())
    try:
        plan = __import__('json').loads(result.stdout)
    except (ValueError, UnicodeError):
        raise ReceiverError('candidate_preflight_denied') from None
    require(isinstance(plan, dict) and plan.get('installationExecuted') is False and
            plan.get('deploymentAuthorized') is False, 'candidate_preflight_denied')
    response = {'status': 'preflighted-private', 'receiptId': os.path.basename(receipt),
                'installationExecuted': False, 'routeReleased': False, 'authorityChanged': False}
    print(__import__('json').dumps(response, sort_keys=True, separators=(',', ':')))


def apply_request(request):
    parts = request.split(' ')
    require(len(parts) == 3 and parts[0] == 'production:payload-apply-v2' and
            re.fullmatch(r'payload-[a-z0-9_]{8}', parts[1]) is not None and
            re.fullmatch(r'[0-9a-f]{64}', parts[2]) is not None, 'invalid_request')
    receipt = INCOMING + '/' + parts[1]
    protected_directory(receipt, private=True)
    marker = NONCES + '/' + parts[2]
    protected_directory(NONCES, private=True)
    evidence = read_private_file(os.path.join(receipt, 'admission.json'), MAX_SUBPROCESS_OUTPUT)
    try:
        admitted = __import__('json').loads(evidence)
    except (ValueError, UnicodeError):
        raise ReceiverError('candidate_admission_denied') from None
    authorization = admitted.get('authorization', {})
    fresh = isinstance(authorization.get('expiresAt'), str) and re.fullmatch(r'[1-9][0-9]{9}', authorization['expiresAt']) and \
        int(time.time()) < int(authorization['expiresAt'])
    marker_raw = read_private_file(marker, 32) if fresh or os.path.lexists(marker) else None
    require(len(evidence) <= MAX_SUBPROCESS_OUTPUT and authorization.get('nonce') == parts[2] and
            isinstance(authorization.get('expiresAt'), str) and re.fullmatch(r'[1-9][0-9]{9}', authorization['expiresAt']) and
            (marker_raw is None or marker_raw == (authorization['expiresAt'] + '\n').encode('ascii')),
            'candidate_admission_denied')
    preflight_raw = read_private_file(os.path.join(receipt, 'preflight.json'), 4096)
    try:
        preflight = __import__('json').loads(preflight_raw)
    except (ValueError, UnicodeError):
        raise ReceiverError('release_not_preflighted') from None
    require(isinstance(preflight, dict) and preflight.get('installationExecuted') is False and
            preflight.get('deploymentAuthorized') is False, 'release_not_preflighted')
    result = bounded_subprocess([PYTHON, '-I', '-S', '-B', PREFLIGHT, '--apply-install', parts[1]],
                                4096, APPLY_SUBPROCESS_TIMEOUT)
    require(result.returncode == 0, 'candidate_install_denied')
    print(result.stdout.decode('utf-8'), end='')


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
        if args[1].startswith('production:payload-apply-v2 '):
            apply_request(args[1])
        else:
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
