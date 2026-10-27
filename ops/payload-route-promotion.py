#!/usr/bin/env python3
"""Gate D same-host route publication with immutable generations.

The Nginx container mounts ROUTE_ROOT as a directory and includes active.conf.
Each active pointer names one immutable generation containing both include.conf
and its signed receipt.  Gate C never calls this controller or releases a route.
"""

import errno
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
import uuid


HERE = os.path.dirname(os.path.realpath(__file__))
STATE_PATH = os.path.join(HERE, 'payload-control-state.py')
SPEC = importlib.util.spec_from_file_location('payload_control_state_route', STATE_PATH)
if SPEC is None or SPEC.loader is None:
    raise SystemExit(2)
STATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STATE)

HEX_64 = re.compile(r'^[0-9a-f]{64}$')
CORRELATION = re.compile(r'^[A-Za-z0-9._:-]{1,128}$')
GENERATION = re.compile(r'^(?:baseline-inactive|generation-(?:promoted|unavailable)-[0-9]{10}-[0-9a-f]{32})$')
CMS_IMAGE = re.compile(r'^ghcr\.io/ownerinc/ownerinc-portal-cms@sha256:[0-9a-f]{64}$')
MAX_COMMAND_OUTPUT = 65536
COMMAND_TIMEOUT = 10
ROUTE_ROOT = '/var/lib/ownerinc/payload-route'
ACTIVE_ROUTE = os.path.join(ROUTE_ROOT, 'active.conf')
CONTAINER_ROUTE_ROOT = '/etc/nginx/editorial-route-state'
READINESS_SCRIPT = """const http=require('http');const r=http.get('http://127.0.0.1:3001/editorial/ready',{headers:{accept:'application/json'}},s=>{let b='';s.setEncoding('utf8');s.on('data',c=>{b+=c;if(b.length>256)r.destroy()});s.on('end',()=>{if(s.statusCode!==200||b!=='{\"status\":\"ready\"}')process.exit(2);process.stdout.write(b)})});r.setTimeout(3000,()=>r.destroy());r.on('error',()=>process.exit(2))"""
CLOSED_ROUTE = (b'# Previously promoted route, closed after a failed recovery check.\n'
                b'location = /editorial { return 503; }\n'
                b'location ^~ /editorial/ { return 503; }\n'
                b'location = /_next/image { return 404; }\n'
                b'location ^~ /_next/ { return 503; }\n')
CLOSED_ROUTE_SHA256 = '33018ca00f2681bdfab0922ee5f30fc9d13ec1fc3f6d0b2867cc55d7af2af403'
BASELINE_ROUTE = (b'# Gate D baseline: no redirect and no CMS ingress before explicit promotion.\n'
                  b'location = /editorial { return 404; }\n'
                  b'location ^~ /editorial/ { return 404; }\n'
                  b'location = /_next/image { return 404; }\n'
                  b'location ^~ /_next/ { return 404; }\n')
BASELINE_ROUTE_SHA256 = 'ce131671e4810315c62b155462359b4ef1e8dde8839b21eb83288fd969e00e2e'
PUBLICATION_BOUNDARIES = (
    'before_generation_create', 'after_generation_create',
    'before_include_write', 'before_include_file_fsync', 'after_include_file_fsync', 'after_include_write',
    'before_receipt_write', 'before_receipt_file_fsync', 'after_receipt_file_fsync', 'after_receipt_write',
    'before_generation_seal', 'after_generation_seal',
    'before_generation_fsync', 'after_generation_fsync',
    'before_generation_rename', 'after_generation_rename',
    'before_generation_parent_fsync', 'after_generation_parent_fsync',
    'before_pointer_write', 'after_pointer_write',
    'before_pointer_fsync', 'after_pointer_fsync',
    'before_pointer_swap', 'after_pointer_swap',
    'before_pointer_parent_fsync', 'after_pointer_parent_fsync',
)


class RouteError(Exception):
    pass


class PublicationError(RouteError):
    def __init__(self, reason, generation, swapped=False, ambiguous=False, durable=False):
        super().__init__(reason)
        self.generation = generation
        self.swapped = swapped
        self.ambiguous = ambiguous
        self.durable = durable


def fail(reason):
    raise RouteError(reason)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode('ascii')


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def log_event(event, correlation_id, **fields):
    safe = {'service': 'payload-route', 'event': event, 'correlationId': correlation_id}
    safe.update(fields)
    print(canonical(safe).decode('ascii'), file=sys.stderr)


def _exact(value, names, reason='route_contract_invalid'):
    if not isinstance(value, dict) or set(value) != set(names):
        fail(reason)


def route_context(body):
    if body.get('authority') != {'mode': 'legacy', 'epoch': 1} or body.get('workerHold') is not True:
        fail('authority_state_invalid')
    intent = body.get('installIntent')
    if not isinstance(intent, dict) or intent.get('stage') != 'floor_committed':
        fail('gate_c_not_committed')
    binding = intent.get('binding')
    if not isinstance(binding, dict) or binding.get('bindingVersion') != 4 or binding.get('project') != 'ownerinc-portal-prod':
        fail('gate_c_binding_invalid')
    STATE.validate_install_binding(binding)
    creation = intent.get('creation')
    receipt = creation.get('containers', {}).get('cms') if isinstance(creation, dict) else None
    if not isinstance(receipt, dict):
        fail('cms_container_receipt_missing')
    image = binding['candidate']['images']['cms']
    if not CMS_IMAGE.fullmatch(image) or receipt.get('image') != image or receipt.get('releasePath') != binding['candidateRelease']:
        fail('release_container_divergence')
    return {'commit': binding['candidate']['commit'], 'release': binding['candidateRelease'],
            'image': image, 'containerId': receipt.get('id'), 'authority': body['authority'],
            'routeReleased': False}


def validate_observation(context, observation):
    _exact(observation, {'commit', 'release', 'image', 'containerId', 'containerImage', 'containerStatus',
                         'containerHealth', 'readiness', 'readinessReason', 'authority'})
    if observation['authority'] != context['authority']:
        fail('authority_state_invalid')
    if any(observation[name] != context[name] for name in ('commit', 'release', 'image', 'containerId')) or \
       observation['containerImage'] != context['image']:
        fail('release_container_divergence')
    if observation['containerStatus'] != 'running' or observation['containerHealth'] != 'healthy' or \
       observation['readiness'] != 'ready' or observation['readinessReason'] != 'ready':
        fail('private_readiness_failed')
    return True


def generation_record(status, generation, route_sha256, correlation_id, context=None, reason='ready', now=None):
    if status not in ('inactive', 'promoted', 'unavailable') or not GENERATION.fullmatch(generation) or \
       not HEX_64.fullmatch(route_sha256) or not CORRELATION.fullmatch(correlation_id):
        fail('route_contract_invalid')
    if (status == 'inactive') != (generation == 'baseline-inactive'):
        fail('route_contract_invalid')
    promotion = None
    if status == 'promoted':
        if not isinstance(context, dict):
            fail('route_contract_invalid')
        promotion = {'commit': context['commit'], 'release': context['commit'], 'cmsImage': context['image'],
                     'cmsContainerId': context['containerId'], 'authority': context['authority']}
    return {'schemaVersion': 2, 'kind': 'payload-route-generation-v2', 'status': status,
            'generation': generation, 'routeConfigSha256': route_sha256,
            'readiness': {'status': 'ready' if status == 'promoted' else status, 'reason': reason},
            'promotion': promotion, 'correlationId': correlation_id,
            'observedAt': int(time.time() if now is None else now), 'gateC': {'routeReleased': False}}


def validate_generation_record(body):
    _exact(body, {'schemaVersion', 'kind', 'status', 'generation', 'routeConfigSha256', 'readiness',
                  'promotion', 'correlationId', 'observedAt', 'gateC'}, 'route_receipt_invalid')
    if body['schemaVersion'] != 2 or body['kind'] != 'payload-route-generation-v2' or \
       body['status'] not in ('inactive', 'promoted', 'unavailable') or not GENERATION.fullmatch(body['generation']) or \
       not HEX_64.fullmatch(body['routeConfigSha256']) or not CORRELATION.fullmatch(body['correlationId']) or \
       type(body['observedAt']) is not int or body['observedAt'] < 0 or body['gateC'] != {'routeReleased': False}:
        fail('route_receipt_invalid')
    _exact(body['readiness'], {'status', 'reason'}, 'route_receipt_invalid')
    if (body['status'] == 'inactive') != (body['generation'] == 'baseline-inactive'):
        fail('route_receipt_invalid')
    expected = 'ready' if body['status'] == 'promoted' else body['status']
    if body['readiness']['status'] != expected or not isinstance(body['readiness']['reason'], str) or \
       not re.fullmatch(r'[a-z_]{1,64}', body['readiness']['reason']):
        fail('route_receipt_invalid')
    if body['status'] == 'promoted':
        _exact(body['promotion'], {'commit', 'release', 'cmsImage', 'cmsContainerId', 'authority'}, 'route_receipt_invalid')
        if not re.fullmatch(r'[0-9a-f]{40}', body['promotion']['commit']) or body['promotion']['release'] != body['promotion']['commit'] or \
           not CMS_IMAGE.fullmatch(body['promotion']['cmsImage']) or not re.fullmatch(r'[0-9a-f]{64}', body['promotion']['cmsContainerId']) or \
           body['promotion']['authority'] != {'mode': 'legacy', 'epoch': 1}:
            fail('route_receipt_invalid')
    elif body['promotion'] is not None:
        fail('route_receipt_invalid')
    return body


def _run(command, limit=MAX_COMMAND_OUTPUT):
    try:
        result = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                check=False, timeout=COMMAND_TIMEOUT,
                                env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'})
    except (OSError, subprocess.TimeoutExpired):
        fail('private_observation_failed')
    if result.returncode != 0 or len(result.stdout) > limit:
        fail('private_observation_failed')
    return result.stdout


def observe(context):
    raw = _run(['/usr/bin/docker', 'inspect', '--format', '{{json .}}', context['containerId']])
    try:
        item = json.loads(raw)
        observed = {'commit': context['commit'], 'release': context['release'], 'image': context['image'],
                    'containerId': item['Id'], 'containerImage': item['Config']['Image'],
                    'containerStatus': item['State']['Status'], 'containerHealth': item['State']['Health']['Status'],
                    'readiness': 'unavailable', 'readinessReason': 'closed', 'authority': context['authority']}
    except (KeyError, TypeError, ValueError):
        fail('private_observation_failed')
    readiness = _run(['/usr/bin/docker', 'exec', context['containerId'], 'node', '-e', READINESS_SCRIPT], 256)
    if readiness != b'{"status":"ready"}':
        fail('private_readiness_failed')
    observed.update(readiness='ready', readinessReason='ready')
    return observed


def _trusted_uid():
    return 0 if os.name != 'nt' and os.geteuid() == 0 else (os.geteuid() if os.name != 'nt' else None)


def _safe_directory(path, mode=None, trusted_uid=None):
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        fail('unsafe_route_directory')
    if os.name != 'nt':
        expected_uid = _trusted_uid() if trusted_uid is None else trusted_uid
        if info.st_uid != expected_uid or info.st_nlink < 2 or stat.S_IMODE(info.st_mode) & 0o022 or \
           (mode is not None and stat.S_IMODE(info.st_mode) != mode):
            fail('unsafe_route_directory')
    return info


def _safe_file(filename, maximum=262144, expected_mode=None, trusted_uid=None):
    before = os.lstat(filename)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > maximum:
        fail('unsafe_route_file')
    if os.name != 'nt':
        expected_uid = _trusted_uid() if trusted_uid is None else trusted_uid
        if before.st_uid != expected_uid or (expected_mode is not None and stat.S_IMODE(before.st_mode) != expected_mode):
            fail('unsafe_route_file')
    descriptor = os.open(filename, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
    try:
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino, opened.st_nlink) != (before.st_dev, before.st_ino, 1):
            fail('unsafe_route_file')
        raw = b''
        while len(raw) <= maximum:
            part = os.read(descriptor, min(65536, maximum + 1 - len(raw)))
            if not part:
                break
            raw += part
    finally:
        os.close(descriptor)
    if len(raw) > maximum:
        fail('unsafe_route_file')
    return raw


class OperationLease:
    """Retains and repeatedly proves the caller's exclusive Linux FD9 lease."""

    def __init__(self, path, trusted_uid=0, require_root=True):
        self.path = path
        self.trusted_uid = trusted_uid
        if os.name == 'nt':
            fail('operation_lease_missing')
        if require_root and os.geteuid() != 0:
            fail('operation_lease_missing')
        if os.environ.get('PORTAL_OPERATION_LOCK') != path or os.environ.get('PORTAL_OPERATION_LOCK_HELD') != path or \
           os.path.realpath(path) != path or any(name.startswith('DOCKER_') for name in os.environ):
            fail('operation_lease_missing')
        self.identity = None
        self.reaffirm()

    def reaffirm(self):
        import fcntl
        flags = os.O_RDONLY | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_NOFOLLOW', 0)
        try:
            fd_info = os.fstat(9)
            path_info = os.lstat(self.path)
            probe = os.open(self.path, flags)
        except OSError:
            fail('operation_lease_missing')
        try:
            probe_info = os.fstat(probe)
            identity = (fd_info.st_dev, fd_info.st_ino, fd_info.st_uid, fd_info.st_gid,
                        stat.S_IMODE(fd_info.st_mode), fd_info.st_nlink)
            observed = (path_info.st_dev, path_info.st_ino, path_info.st_uid, path_info.st_gid,
                        stat.S_IMODE(path_info.st_mode), path_info.st_nlink)
            if not stat.S_ISREG(fd_info.st_mode) or identity != observed or \
               (probe_info.st_dev, probe_info.st_ino) != (fd_info.st_dev, fd_info.st_ino) or \
               fd_info.st_uid != self.trusted_uid or fd_info.st_nlink != 1 or stat.S_IMODE(fd_info.st_mode) != 0o600 or \
               (self.identity is not None and identity != self.identity):
                fail('operation_lease_missing')
            # A separate shared probe succeeds for unlocked/shared locks, but is
            # blocked by the required exclusive lock held on FD9.
            try:
                fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)
            except BlockingIOError:
                pass
            else:
                fcntl.flock(probe, fcntl.LOCK_UN)
                fail('operation_lease_missing')
            try:
                fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                fail('operation_lease_missing')
            after_fd = os.fstat(9)
            after_path = os.lstat(self.path)
            after = (after_fd.st_dev, after_fd.st_ino, after_fd.st_uid, after_fd.st_gid,
                     stat.S_IMODE(after_fd.st_mode), after_fd.st_nlink)
            if after != identity or (after_path.st_dev, after_path.st_ino, after_path.st_nlink) != \
               (fd_info.st_dev, fd_info.st_ino, 1):
                fail('operation_lease_missing')
            self.identity = identity
        finally:
            os.close(probe)
        return True


def verify_operation_lease(inventory):
    return OperationLease(inventory['paths']['lock'])


def _fsync_directory(path):
    if os.name == 'nt':
        return
    descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_private_file(path, raw, hook=None, fsync_name=None, sync=True):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_BINARY', 0), 0o600)
    try:
        written = 0
        while written < len(raw):
            count = os.write(descriptor, raw[written:])
            if count <= 0:
                raise OSError(errno.EIO, 'private write failed')
            written += count
        if sync:
            if fsync_name is not None:
                _hook(hook, 'before_{}_file_fsync'.format(fsync_name))
            os.fsync(descriptor)
            if fsync_name is not None:
                _hook(hook, 'after_{}_file_fsync'.format(fsync_name))
    finally:
        os.close(descriptor)


def _pointer_bytes(generation):
    return ('include {}/{}/include.conf;\n'.format(CONTAINER_ROUTE_ROOT, generation)).encode('ascii')


def _parse_pointer(raw):
    match = re.fullmatch(rb'include /etc/nginx/editorial-route-state/((?:baseline-inactive|generation-(?:promoted|unavailable)-[0-9]{10}-[0-9a-f]{32}))/include\.conf;\n', raw)
    if not match:
        fail('active_route_invalid')
    return match.group(1).decode('ascii')


def _hook(hook, boundary):
    if hook is not None:
        hook(boundary)


def inspect_generation(root, generation, key, expected_status=None):
    if not GENERATION.fullmatch(generation):
        fail('route_generation_invalid')
    directory = os.path.join(root, generation)
    _safe_directory(directory, 0o500)
    route = _safe_file(os.path.join(directory, 'include.conf'), expected_mode=0o400)
    receipt_raw = _safe_file(os.path.join(directory, 'receipt.json'), expected_mode=0o400)
    if set(os.listdir(directory)) != {'include.conf', 'receipt.json'}:
        fail('route_generation_invalid')
    try:
        envelope = json.loads(receipt_raw)
    except (UnicodeError, ValueError):
        fail('route_receipt_invalid')
    if canonical(envelope) + b'\n' != receipt_raw:
        fail('route_receipt_invalid')
    body = STATE.verify_envelope(envelope, key, validate_generation_record, 'route_receipt_invalid')
    if body['generation'] != generation or body['routeConfigSha256'] != sha256(route) or \
       (expected_status is not None and body['status'] != expected_status):
        fail('route_generation_invalid')
    return {'generation': generation, 'route': route, 'receipt': body}


def inspect_active(root, key, expected_generation=None, expected_status=None):
    _safe_directory(root, 0o700)
    pointer = _safe_file(os.path.join(root, 'active.conf'), 4096, expected_mode=0o600)
    generation = _parse_pointer(pointer)
    if expected_generation is not None and generation != expected_generation:
        fail('active_route_mismatch')
    return inspect_generation(root, generation, key, expected_status)


def publish_generation(root, route, envelope, key, lease=None, hook=None, replace=os.replace):
    """Materialize a complete generation, then atomically swap active.conf once."""
    _safe_directory(root, 0o700)
    body = STATE.verify_envelope(envelope, key, validate_generation_record, 'route_receipt_invalid')
    generation = body['generation']
    if body['routeConfigSha256'] != sha256(route):
        fail('route_receipt_invalid')
    pending_generation = os.path.join(root, '.{}'.format(generation))
    final_generation = os.path.join(root, generation)
    pending_pointer = os.path.join(root, '.active-{}.conf'.format(uuid.uuid4().hex))
    swapped = False
    ambiguous = False
    durable = False
    try:
        _hook(hook, 'before_generation_create')
        os.mkdir(pending_generation, 0o700)
        _hook(hook, 'after_generation_create')
        _hook(hook, 'before_include_write')
        _write_private_file(os.path.join(pending_generation, 'include.conf'), route, hook, 'include')
        _hook(hook, 'after_include_write')
        _hook(hook, 'before_receipt_write')
        _write_private_file(os.path.join(pending_generation, 'receipt.json'), canonical(envelope) + b'\n', hook, 'receipt')
        _hook(hook, 'after_receipt_write')
        _hook(hook, 'before_generation_seal')
        os.chmod(os.path.join(pending_generation, 'include.conf'), 0o400)
        os.chmod(os.path.join(pending_generation, 'receipt.json'), 0o400)
        os.chmod(pending_generation, 0o500)
        _hook(hook, 'after_generation_seal')
        _hook(hook, 'before_generation_fsync')
        _fsync_directory(pending_generation)
        _hook(hook, 'after_generation_fsync')
        _hook(hook, 'before_generation_rename')
        os.rename(pending_generation, final_generation)
        _hook(hook, 'after_generation_rename')
        _hook(hook, 'before_generation_parent_fsync')
        _fsync_directory(root)
        _hook(hook, 'after_generation_parent_fsync')
        inspect_generation(root, generation, key, body['status'])
        _hook(hook, 'before_pointer_write')
        _write_private_file(pending_pointer, _pointer_bytes(generation), sync=False)
        _hook(hook, 'after_pointer_write')
        _hook(hook, 'before_pointer_fsync')
        pointer_fd = os.open(pending_pointer, os.O_RDWR | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
        try:
            os.fsync(pointer_fd)
        finally:
            os.close(pointer_fd)
        _hook(hook, 'after_pointer_fsync')
        if lease is not None:
            lease.reaffirm()
        _hook(hook, 'before_pointer_swap')
        try:
            replace(pending_pointer, os.path.join(root, 'active.conf'))
            swapped = True
        except OSError:
            ambiguous = True
            raise
        _hook(hook, 'after_pointer_swap')
        if lease is not None:
            lease.reaffirm()
        _hook(hook, 'before_pointer_parent_fsync')
        _fsync_directory(root)
        durable = True
        _hook(hook, 'after_pointer_parent_fsync')
        result = inspect_active(root, key, generation, body['status'])
        result['durability'] = 'committed'
        return result
    except (OSError, RouteError, STATE.StateError, ValueError) as error:
        raise PublicationError('route_publication_failed', generation, swapped, ambiguous, durable) from error
    finally:
        if os.path.isfile(pending_pointer):
            try:
                os.unlink(pending_pointer)
            except OSError:
                pass
        if os.path.isdir(pending_generation):
            try:
                os.chmod(pending_generation, 0o700)
            except OSError:
                pass
            for name in ('include.conf', 'receipt.json'):
                try:
                    os.unlink(os.path.join(pending_generation, name))
                except OSError:
                    pass
            try:
                os.rmdir(pending_generation)
            except OSError:
                pass


def _new_generation(status):
    return 'generation-{}-{:010d}-{}'.format(status, int(time.time()), uuid.uuid4().hex)


def _unavailable_envelope(key, correlation_id, reason='readiness_closed'):
    generation = _new_generation('unavailable')
    body = generation_record('unavailable', generation, CLOSED_ROUTE_SHA256, correlation_id, reason=reason)
    return STATE.sign_envelope(body, key)


def _baseline_envelope(key, correlation_id):
    body = generation_record('inactive', 'baseline-inactive', BASELINE_ROUTE_SHA256,
                             correlation_id, reason='inactive')
    return STATE.sign_envelope(body, key)


def inspect_baseline(root, key):
    result = inspect_active(root, key, 'baseline-inactive', 'inactive')
    if result['route'] != BASELINE_ROUTE or result['receipt']['routeConfigSha256'] != BASELINE_ROUTE_SHA256:
        fail('baseline_route_invalid')
    return result


def inspect_initialized_root(root, key):
    result = inspect_generation(root, 'baseline-inactive', key, 'inactive')
    if result['route'] != BASELINE_ROUTE or result['receipt']['routeConfigSha256'] != BASELINE_ROUTE_SHA256:
        fail('baseline_route_invalid')
    return result


def initialize_route_state(root, baseline_template, key, correlation_id, lease):
    """Idempotently materialize the authenticated inactive state under FD9."""
    _safe_directory(root, 0o700)
    baseline = _safe_file(baseline_template)
    if baseline != BASELINE_ROUTE or sha256(baseline) != BASELINE_ROUTE_SHA256:
        fail('baseline_route_invalid')
    entries = set(os.listdir(root))
    if entries:
        result = inspect_baseline(root, key)
        if lease is not None:
            lease.reaffirm()
        _fsync_directory(root)
        if lease is not None:
            lease.reaffirm()
        result['durability'] = 'committed'
        return result
    envelope = _baseline_envelope(key, correlation_id)
    result = publish_generation(root, baseline, envelope, key, lease)
    if result['durability'] != 'committed':
        fail('route_durability_indeterminate')
    return result


def publish_unavailable(root, key, correlation_id, lease, reason='readiness_closed'):
    """Return success only after a closed pointer swap and parent fsync."""
    last_error = None
    for _attempt in range(2):
        envelope = _unavailable_envelope(key, correlation_id, reason)
        expected = envelope['body']['generation']
        try:
            return publish_generation(root, CLOSED_ROUTE, envelope, key, lease)
        except PublicationError as error:
            last_error = error
            if error.durable:
                try:
                    result = inspect_active(root, key, expected, 'unavailable')
                    result['durability'] = 'committed'
                    return result
                except (OSError, RouteError, STATE.StateError, ValueError):
                    pass
            if lease is not None:
                lease.reaffirm()
    raise PublicationError('route_durability_indeterminate', last_error.generation if last_error else 'unknown',
                           durable=False)


def publish_promoted_fail_closed(root, route, envelope, key, correlation_id, lease, hook=None, replace=os.replace):
    """Resolve a swap ambiguity without ever exposing a partial generation."""
    expected = envelope['body']['generation']
    inspect_initialized_root(root, key)
    current = inspect_active(root, key)
    if current['receipt']['status'] == 'inactive':
        inspect_baseline(root, key)
    try:
        return publish_generation(root, route, envelope, key, lease, hook, replace)
    except PublicationError as error:
        if not error.swapped and not error.ambiguous:
            raise
        if lease is not None:
            lease.reaffirm()
        if error.durable:
            try:
                result = inspect_active(root, key, expected, 'promoted')
                result['durability'] = 'committed'
                return result
            except (OSError, RouteError, STATE.StateError, ValueError):
                pass
        result = publish_unavailable(root, key, correlation_id, lease, 'durability_indeterminate')
        if lease is not None:
            lease.reaffirm()
        return result


def _load_operation(runtime_dir):
    inventory = STATE.INVENTORY.load(os.path.join(runtime_dir, 'payload-control-inventory.json'))
    lease = verify_operation_lease(inventory)
    lease.reaffirm()
    key, _state_dir, body, _digest = STATE.read_state(runtime_dir)
    context = route_context(body)
    current = _safe_file(inventory['paths']['currentRelease'], 4096, expected_mode=0o600).decode('utf-8')
    if current != context['release'] + '\n':
        fail('release_container_divergence')
    return inventory, lease, key, context


def _load_route_base(runtime_dir):
    inventory = STATE.INVENTORY.load(os.path.join(runtime_dir, 'payload-control-inventory.json'))
    lease = verify_operation_lease(inventory)
    lease.reaffirm()
    key = STATE._key_for(runtime_dir)
    current = _safe_file(inventory['paths']['currentRelease'], 4096, expected_mode=0o600).decode('utf-8')
    if not current.endswith('\n') or not os.path.isabs(current[:-1]):
        fail('release_container_divergence')
    return inventory, lease, key, current[:-1]


def initialize(runtime_dir, baseline_template, unavailable_template, correlation_id):
    _inventory, lease, key, current_release = _load_route_base(runtime_dir)
    expected_template = os.path.join(current_release, 'nginx', 'editorial-route.inactive.conf')
    if os.path.realpath(baseline_template) != expected_template:
        fail('route_template_release_mismatch')
    closed = _safe_file(unavailable_template)
    if closed != CLOSED_ROUTE or sha256(closed) != CLOSED_ROUTE_SHA256:
        fail('route_template_release_mismatch')
    lease.reaffirm()
    result = initialize_route_state(ROUTE_ROOT, baseline_template, key, correlation_id, lease)
    lease.reaffirm()
    if result['receipt']['status'] != 'inactive' or result['durability'] != 'committed':
        fail('route_durability_indeterminate')
    log_event('route_initialized', correlation_id, routeStatus='inactive', durability='committed')
    return result['receipt']


def promote(runtime_dir, template, unavailable_template, correlation_id, observer=observe):
    _inventory, lease, key, context = _load_operation(runtime_dir)
    expected_template = os.path.join(context['release'], 'nginx', 'editorial-route.promoted.conf')
    if os.path.realpath(template) != expected_template:
        fail('route_template_release_mismatch')
    route = _safe_file(template)
    closed = _safe_file(unavailable_template)
    if sha256(closed) != CLOSED_ROUTE_SHA256 or closed != CLOSED_ROUTE:
        fail('route_template_release_mismatch')
    lease.reaffirm()
    observation = observer(context)
    lease.reaffirm()
    validate_observation(context, observation)
    generation = _new_generation('promoted')
    record = generation_record('promoted', generation, sha256(route), correlation_id, context)
    envelope = STATE.sign_envelope(record, key)
    lease.reaffirm()
    result = publish_promoted_fail_closed(ROUTE_ROOT, route, envelope, key, correlation_id, lease)
    lease.reaffirm()
    status = result['receipt']['status']
    if result.get('durability') != 'committed':
        fail('route_durability_indeterminate')
    event = 'route_promoted' if status == 'promoted' else 'route_promotion_closed'
    log_event(event, correlation_id, commit=context['commit'], release=context['commit'],
              digest=context['image'].split('@sha256:')[1], readiness=status,
              readinessReason=result['receipt']['readiness']['reason'],
              authorityMode=context['authority']['mode'], authorityEpoch=context['authority']['epoch'])
    if status != 'promoted':
        fail('route_publication_failed')
    return record


def recover(runtime_dir, unavailable_template, correlation_id):
    inventory = STATE.INVENTORY.load(os.path.join(runtime_dir, 'payload-control-inventory.json'))
    lease = verify_operation_lease(inventory)
    lease.reaffirm()
    key = STATE._key_for(runtime_dir)
    inspect_initialized_root(ROUTE_ROOT, key)
    closed = _safe_file(unavailable_template)
    if sha256(closed) != CLOSED_ROUTE_SHA256 or closed != CLOSED_ROUTE:
        fail('route_template_release_mismatch')
    result = publish_unavailable(ROUTE_ROOT, key, correlation_id, lease)
    lease.reaffirm()
    if result['receipt']['status'] != 'unavailable' or result.get('durability') != 'committed':
        fail('route_durability_indeterminate')
    log_event('route_recovery_closed', correlation_id, readiness='unavailable', readinessReason='readiness_closed')
    return result['receipt']


def main(argv):
    if len(argv) != 6 or argv[1] not in ('initialize', 'promote', 'recover') or not CORRELATION.fullmatch(argv[5]):
        print('Invalid route promotion invocation.', file=sys.stderr)
        return 2
    action, runtime_dir, promoted, unavailable, correlation_id = argv[1:]
    try:
        if action == 'initialize':
            initialize(runtime_dir, promoted, unavailable, correlation_id)
        elif action == 'promote':
            promote(runtime_dir, promoted, unavailable, correlation_id)
        else:
            recover(runtime_dir, unavailable, correlation_id)
    except (RouteError, STATE.StateError, STATE.INVENTORY.InventoryError, OSError, ValueError, UnicodeError, KeyError, TypeError) as error:
        if str(error) == 'route_durability_indeterminate':
            event, reason = 'route_durability_indeterminate', 'durability_indeterminate'
        else:
            event = {'initialize': 'route_initialization_refused', 'promote': 'route_promotion_refused',
                     'recover': 'route_recovery_refused'}[action]
            reason = 'operation_refused'
        log_event(event, correlation_id, readiness='unavailable', readinessReason=reason)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
