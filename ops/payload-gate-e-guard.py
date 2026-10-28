#!/usr/bin/env python3
"""Gate E host controller: verify private evidence, produce fresh receipts, invoke fixed CLIs."""
import datetime
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.realpath(__file__))


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STATE = load('payload_control_state_gate_e', 'payload-control-state.py')
ROUTE = load('payload_route_gate_e', 'payload-route-promotion.py')
HEX = re.compile(r'^[0-9a-f]{64}$')
DIGEST = re.compile(r'^sha256:[0-9a-f]{64}$')
COMMIT = re.compile(r'^[0-9a-f]{40}$')
TOKEN = re.compile(r'^[A-Za-z0-9._:-]{1,128}$')
NODE = '/usr/bin/node'
MAX_OUTPUT = 4096


class GateError(Exception):
    pass


class FrozenError(GateError):
    def __init__(self, epoch):
        super().__init__('frozen_reconciliation_required')
        self.epoch = epoch


class ReconciliationError(GateError):
    def __init__(self, reason, mode, epoch):
        super().__init__(reason)
        self.mode = mode
        self.epoch = epoch


def require(value, reason='gate_e_refused'):
    if not value:
        raise GateError(reason)


def refuse(reason='gate_e_refused', mode=None, epoch=None):
    value = {'gate': 'E', 'status': 'refused', 'reason': reason}
    if mode in ('legacy', 'frozen', 'payload', 'payload_frozen'):
        value.update(mode=mode, epoch=epoch)
    print(json.dumps(value, separators=(',', ':')), file=sys.stderr)
    return 2


def read_fd9_key():
    try:
        info = os.fstat(9)
        trusted = {0, os.geteuid()} if os.name != 'nt' else {info.st_uid}
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600
                and info.st_uid in trusted,
                'unsafe_signing_key')
        os.lseek(9, 0, os.SEEK_SET)
        key = os.read(9, 129)
        require(32 <= len(key) <= 128, 'unsafe_signing_key')
        return key
    except OSError as error:
        raise GateError('unsafe_signing_key') from error


def parse(argv):
    require(len(argv) == 14 and argv[1] in ('preflight', 'activate', 'resume'), 'invalid_arguments')
    command, runtime, commit, epoch, release, image, manifest, seal, b1, deadline, editor, operator, request = argv[1:]
    require(os.path.isabs(runtime) and os.path.normpath(runtime) == runtime and COMMIT.fullmatch(commit), 'invalid_arguments')
    require(epoch.isdigit() and 0 < int(epoch) < 2147483647 and DIGEST.fullmatch(release)
            and DIGEST.fullmatch(image) and HEX.fullmatch(b1), 'invalid_arguments')
    require((manifest == '-' and seal == '-') or (HEX.fullmatch(manifest) and HEX.fullmatch(seal)), 'invalid_arguments')
    require(command == 'preflight' or manifest != '-', 'invalid_arguments')
    require(TOKEN.fullmatch(editor) and TOKEN.fullmatch(operator) and editor != operator
            and TOKEN.fullmatch(request), 'invalid_arguments')
    try:
        expiry = datetime.datetime.fromisoformat(deadline.replace('Z', '+00:00'))
        now = datetime.datetime.now(datetime.timezone.utc)
        require(expiry.tzinfo is not None and now < expiry <= now + datetime.timedelta(minutes=60), 'cutover_deadline_invalid')
    except (ValueError, TypeError) as error:
        raise GateError('cutover_deadline_invalid') from error
    return {'command': command, 'runtime': runtime, 'commit': commit, 'epoch': int(epoch), 'release': release,
            'image': image, 'manifest': None if manifest == '-' else manifest, 'seal': None if seal == '-' else seal,
            'b1': b1, 'deadline': deadline, 'editor': editor, 'operator': operator, 'request': request}


def private_file(path, expected_mode=0o600, limit=128 * 1024):
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
        try:
            info = os.fstat(descriptor)
            trusted = {0, os.geteuid()} if os.name != 'nt' else {info.st_uid}
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= limit
                    and (os.name == 'nt' or info.st_uid in trusted and stat.S_IMODE(info.st_mode) == expected_mode),
                    'unsafe_private_receipt')
            raw = b''
            while len(raw) <= limit:
                chunk = os.read(descriptor, min(65536, limit + 1 - len(raw)))
                if not chunk:
                    break
                raw += chunk
            require(len(raw) <= limit, 'unsafe_private_receipt')
            return raw
        finally:
            os.close(descriptor)
    except (OSError, GateError) as error:
        if isinstance(error, GateError):
            raise
        raise GateError('unsafe_private_receipt') from error


def durable_exclusive(path, raw):
    parent = os.path.dirname(path)
    descriptor = -1
    temporary = None
    try:
        descriptor, temporary = tempfile.mkstemp(prefix='.gate-e-', dir=parent)
        os.fchmod(descriptor, 0o600)
        remaining = memoryview(raw)
        while remaining:
            written = os.write(descriptor, remaining)
            if not isinstance(written, int) or written <= 0 or written > len(remaining):
                raise GateError('private_receipt_write_failed')
            remaining = remaining[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.link(temporary, path)  # no overwrite and no symlink following
        os.unlink(temporary)
        temporary = None
        if os.name != 'nt':
            directory = os.open(parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    except (OSError, FileExistsError) as error:
        raise GateError('private_receipt_write_failed') from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def verify_envelope(path, key, validator=lambda value: value):
    raw = private_file(path)
    envelope = STATE.parse_canonical(raw, 'receipt_not_canonical')
    body = STATE.verify_envelope(envelope, key, validator, 'receipt_invalid')
    return body, hashlib.sha256(raw).hexdigest()


def private_receipt_directory(runtime):
    directory = os.path.join(runtime, 'gate-e-receipts')
    if not os.path.exists(directory):
        os.mkdir(directory, 0o700)
        descriptor = os.open(runtime, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    info = os.lstat(directory)
    require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
            and (os.name == 'nt' or stat.S_IMODE(info.st_mode) == 0o700), 'unsafe_private_receipt_directory')
    return directory


def verify_runtime(request, key):
    state_key, state_dir, state, state_sha = STATE.read_state(request['runtime'])
    require(state_key == key, 'signature_key_mismatch')
    install = state.get('installIntent')
    require(isinstance(install, dict) and install.get('stage') == 'floor_committed'
            and state.get('admission') == 'closed', 'runtime_binding_unavailable')
    binding = install['binding']
    require(binding['candidate']['commit'] == request['commit']
            and binding['candidate']['candidateSha256'] == request['release'].removeprefix('sha256:')
            and binding['candidate']['images']['cms'].endswith('@' + request['image'])
            and install['b1']['proofSha256'] == request['b1'], 'runtime_binding_unavailable')
    release = binding['candidateRelease']
    require(os.path.isabs(release) and os.path.basename(release) == request['commit'], 'runtime_binding_unavailable')
    request['observer'] = os.path.join(release, 'api', 'scripts', 'owner-news-gate-e-observe.js')
    request['cutover'] = os.path.join(release, 'api', 'scripts', 'owner-news-cutover.js')
    for executable in (request['observer'], request['cutover']):
        info = os.lstat(executable)
        require(stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_nlink == 1,
                'runtime_binding_unavailable')
    current = os.path.join(state_dir, 'current.json')
    raw = private_file(current)
    require(hashlib.sha256(STATE.canonical(STATE.parse_canonical(raw, 'state_journal_corrupt'))).hexdigest() == state_sha,
            'runtime_binding_unavailable')
    return state, binding, {'path': current, 'sha256': hashlib.sha256(raw).hexdigest()}


def verify_b1(request, state, binding, key):
    receipt = state['installIntent']['b1']
    path = os.path.join(receipt['directory'], 'b1-proof.json')
    body, sha = verify_envelope(path, key)
    require(sha == request['b1'] == receipt['proofSha256'] and body.get('kind') == 'payload-private-install-b1-v1'
            and body.get('installBindingSha256') == hashlib.sha256(STATE.canonical(binding)).hexdigest()
            and body.get('candidate') == binding['candidate'] and body.get('authority') == binding['authority']
            and body.get('authorityState') == {'mode': 'legacy', 'epoch': 1}
            and body.get('workerHeld') is True and body.get('routeReleased') is False, 'b1_receipt_unverified')
    return {'path': path, 'sha256': sha}


def verify_route(request, key):
    root = os.path.join(os.path.dirname(request['runtime']), 'payload-route')
    observed = ROUTE.inspect_active(root, key, expected_status='promoted')
    promotion = observed['receipt']['promotion']
    require(promotion['commit'] == request['commit'] and promotion['cmsImage'].endswith('@' + request['image']),
            'route_binding_unavailable')
    path = os.path.join(root, observed['generation'], 'receipt.json')
    return {'path': path, 'sha256': hashlib.sha256(private_file(path, expected_mode=0o400)).hexdigest()}


def child(command):
    try:
        os.lseek(9, 0, os.SEEK_SET)
        environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'OWNER_NEWS_CUTOVER_KEY_FD': '9'}
        for name in ('DATABASE_URL', 'PAYLOAD_INTERNAL_URL', 'CMS_INTERNAL_URL', 'PORTAL_TO_PAYLOAD_SECRET',
                     'OWNER_NEWS_CUTOVER_TRUSTED_UIDS'):
            if name in os.environ:
                environment[name] = os.environ[name]
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                close_fds=True, pass_fds=(9,), timeout=45, check=False,
                                env=environment)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GateError('private_observation_failed') from error
    require(result.returncode == 0 and 0 < len(result.stdout) <= MAX_OUTPUT, 'private_observation_failed')
    try:
        output = json.loads(result.stdout.decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GateError('private_observation_failed') from error
    require(isinstance(output, dict) and output.get('status') != 'refused', 'private_observation_failed')
    return output


def observation_args(kind, request, destination, mode, epoch):
    args = [NODE, request['observer'], kind, '--epoch', str(epoch), '--mode', mode, '--editor', request['editor'],
            '--operator', request['operator'], '--request-id', request['request'], '--commit', request['commit'],
            '--release-digest', request['release'], '--image-digest', request['image'], '--deadline', request['deadline'],
            '--receipt-file', destination]
    if mode != 'legacy':
        args += ['--manifest-sha256', request['manifest'], '--seal-sha256', request['seal']]
    return args


def verify_observation(path, kind, request, key, mode, epoch):
    body, sha = verify_envelope(path, key)
    require(body.get('kind') == 'owner-news-{}-observation-v1'.format(kind)
            and body.get('requestId') == request['request'] and body.get('mode') == mode and body.get('epoch') == epoch
            and body.get('commit') == request['commit'] and body.get('releaseDigest') == request['release']
            and body.get('imageDigest') == request['image'] and body.get('expiresAt') == request['deadline']
            and body.get('editor') == request['editor'] and body.get('operator') == request['operator'],
            'observation_binding_mismatch')
    issued = datetime.datetime.fromisoformat(body['issuedAt'].replace('Z', '+00:00'))
    require(datetime.datetime.now(datetime.timezone.utc) - issued <= datetime.timedelta(minutes=2), 'observation_stale')
    if kind == 'feed' and mode == 'frozen':
        migration = body.get('observation', {}).get('migration')
        require(isinstance(migration, dict) and migration.get('manifestSha256') == request['manifest']
                and migration.get('sealSha256') == request['seal'] and migration.get('authorityEpoch') == epoch,
                'migration_seal_unverified')
    if kind == 'drain':
        require(body.get('observation', {}).get('activeWriters') == 0
                and body.get('observation', {}).get('conflictingLocks') == 0, 'writers_not_drained')
    return {'path': path, 'sha256': sha}


def produce_evidence(request, mode, epoch, key, suffix):
    now = datetime.datetime.now(datetime.timezone.utc)
    deadline = datetime.datetime.fromisoformat(request['deadline'].replace('Z', '+00:00'))
    require(now < deadline and deadline - now <= datetime.timedelta(minutes=60), 'cutover_deadline_expired')
    state, binding, runtime_receipt = verify_runtime(request, key)
    b1_receipt = verify_b1(request, state, binding, key)
    route_receipt = verify_route(request, key)
    directory = private_receipt_directory(request['runtime'])
    prefix = '{}-{}-{}'.format(request['request'], mode, suffix)
    feed_path = os.path.join(directory, prefix + '-feed.json')
    child(observation_args('feed', request, feed_path, mode, epoch))
    feed = verify_observation(feed_path, 'feed', request, key, mode, epoch)
    drain = None
    if mode == 'frozen':
        drain_path = os.path.join(directory, prefix + '-drain.json')
        child(observation_args('drain', request, drain_path, mode, epoch))
        drain = verify_observation(drain_path, 'drain', request, key, mode, epoch)
    body = {'version': 2, 'kind': 'owner-news-gate-e-evidence-v2', 'issuedAt': now.isoformat().replace('+00:00', 'Z'),
            'expiresAt': request['deadline'], 'requestId': request['request'], 'mode': mode, 'epoch': epoch,
            'commit': request['commit'], 'manifestSha256': request['manifest'] if mode != 'legacy' else None,
            'sealSha256': request['seal'] if mode != 'legacy' else None, 'releaseDigest': request['release'],
            'imageDigest': request['image'], 'editor': request['editor'], 'operator': request['operator'],
            'receipts': {'runtime': runtime_receipt, 'route': route_receipt, 'b1': b1_receipt,
                         'feed': feed, 'drain': drain}}
    path = os.path.join(directory, prefix + '-evidence.json')
    durable_exclusive(path, STATE.canonical(STATE.sign_envelope(body, key)) + b'\n')
    return path


def cli_args(command, request, evidence, receipt, epoch, expect=None, expect_action=None):
    result = [NODE, request['cutover'], command, '--epoch', str(epoch), '--editor', request['editor'], '--operator', request['operator'],
              '--request-id', request['request'], '--deadline', request['deadline'], '--evidence-file', evidence,
              '--receipt-file', receipt]
    if expect:
        result += ['--expect-mode', expect]
    if expect_action:
        result += ['--expect-action', expect_action]
    return result


def reconcile_after_failure(request, evidence, receipt, epoch, action):
    try:
        output = child(cli_args('reconcile', request, evidence, receipt, epoch,
                                expect_action=action))
    except GateError as error:
        raise ReconciliationError('activation_state_diverged', None, None) from error
    state = output.get('state')
    if state == 'payload_observed' and output.get('mode') == 'payload' and output.get('epoch') == epoch:
        return output
    if state == 'frozen' and output.get('mode') == 'frozen':
        raise FrozenError(output.get('epoch'))
    if state == 'freeze_not_committed' and output.get('mode') == 'legacy':
        raise ReconciliationError('freeze_not_committed', 'legacy', output.get('epoch'))
    if state == 'payload_frozen' and output.get('mode') == 'payload_frozen':
        raise ReconciliationError('resume_reconciliation_required', 'payload_frozen', output.get('epoch'))
    if state == 'payload_unobserved' and output.get('mode') == 'payload':
        raise ReconciliationError('activation_reconciliation_required', 'payload', output.get('epoch'))
    raise ReconciliationError('activation_state_diverged', None, None)


def current_authority(runtime):
    try:
        _key, _directory, state, _sha = STATE.read_state(runtime)
        authority = state.get('authority', {})
        return authority.get('mode'), authority.get('epoch')
    except Exception:
        return None, None


def run(request, key):
    nonce = hashlib.sha256((request['request'] + request['deadline'] + request['command']).encode()).hexdigest()[:16]
    directory = private_receipt_directory(request['runtime'])
    if request['command'] == 'resume':
        evidence = produce_evidence(request, 'payload_frozen', request['epoch'], key, nonce + '-payload-frozen')
        preflight = os.path.join(directory, '{}-payload-frozen-preflight.json'.format(nonce))
        child(cli_args('preflight', request, evidence, preflight, request['epoch'], 'payload_frozen'))
        resumed_epoch = request['epoch'] + 1
        try:
            child(cli_args('resume-payload', request, evidence, preflight, request['epoch']))
        except GateError:
            return reconcile_after_failure(request, evidence, preflight, resumed_epoch, 'resume-payload')
        try:
            child(cli_args('observe', request, evidence, preflight, resumed_epoch,
                           expect_action='resume-payload'))
        except GateError:
            return reconcile_after_failure(request, evidence, preflight, resumed_epoch, 'resume-payload')
        return {'gate': 'E', 'status': 'observed', 'mode': 'payload', 'epoch': resumed_epoch,
                'expiresAt': request['deadline'], 'evidenceSha256': hashlib.sha256(private_file(evidence)).hexdigest()}
    legacy_evidence = produce_evidence(request, 'legacy', request['epoch'], key, nonce + '-legacy')
    legacy_preflight = os.path.join(directory, '{}-legacy-preflight.json'.format(nonce))
    child(cli_args('preflight', request, legacy_evidence, legacy_preflight, request['epoch'], 'legacy'))
    if request['command'] == 'preflight':
        return {'gate': 'E', 'status': 'qualified', 'mode': 'legacy', 'epoch': request['epoch'],
                'expiresAt': request['deadline'], 'evidenceSha256': hashlib.sha256(private_file(legacy_evidence)).hexdigest()}
    frozen_epoch = request['epoch'] + 1
    try:
        child(cli_args('freeze', request, legacy_evidence, legacy_preflight, request['epoch']))
    except GateError:
        return reconcile_after_failure(request, legacy_evidence, legacy_preflight, frozen_epoch, 'freeze')
    try:
        frozen_evidence = produce_evidence(request, 'frozen', frozen_epoch, key, nonce + '-frozen')
        frozen_preflight = os.path.join(directory, '{}-frozen-preflight.json'.format(nonce))
        child(cli_args('preflight', request, frozen_evidence, frozen_preflight, frozen_epoch, 'frozen'))
        activated_epoch = frozen_epoch + 1
        try:
            child(cli_args('activate', request, frozen_evidence, frozen_preflight, frozen_epoch))
        except GateError:
            return reconcile_after_failure(request, frozen_evidence, frozen_preflight, activated_epoch, 'activate')
        try:
            child(cli_args('observe', request, frozen_evidence, frozen_preflight, activated_epoch,
                           expect_action='activate'))
        except GateError:
            return reconcile_after_failure(request, frozen_evidence, frozen_preflight, activated_epoch, 'activate')
        return {'gate': 'E', 'status': 'observed', 'mode': 'payload', 'epoch': frozen_epoch + 1,
                'expiresAt': request['deadline'], 'evidenceSha256': hashlib.sha256(private_file(frozen_evidence)).hexdigest()}
    except (GateError, STATE.StateError, ROUTE.RouteError) as error:
        # There is intentionally no legacy resume edge. After a successful freeze,
        # any deadline/observation failure remains frozen for explicit reconciliation.
        if isinstance(error, (FrozenError, ReconciliationError)):
            raise
        raise FrozenError(frozen_epoch) from error


def main(argv):
    request = None
    try:
        request = parse(argv)
        key = read_fd9_key()
        result = run(request, key)
        print(json.dumps(result, separators=(',', ':')))
        return 0
    except (GateError, STATE.StateError, ROUTE.RouteError) as error:
        if isinstance(error, FrozenError):
            mode, epoch = 'frozen', error.epoch
        elif isinstance(error, ReconciliationError):
            mode, epoch = error.mode, error.epoch
        else:
            mode, epoch = current_authority(request['runtime']) if request and request['command'] != 'resume' else (None, None)
        return refuse(str(error) if str(error) else 'gate_e_refused', mode, epoch)


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
