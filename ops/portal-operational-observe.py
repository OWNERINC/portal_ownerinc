#!/usr/bin/python3
"""Notification-only host observer. Never executes an operational controller."""
import datetime
import hashlib
import importlib.util
import json
import os
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
import uuid

CONFIG = '/etc/ownerinc/portal-monitor.json'
CLOSURE = '/opt/ownerinc/lib/portal-monitor/verifier'
RUNTIME = '/opt/ownerinc/apps/portal-ownerinc-real/runtime'
OBSERVATIONS = '/var/lib/ownerinc-portal-monitor/observations'
BACKUPS = '/opt/ownerinc/backups/portal-ownerinc/daily'
INVENTORY = RUNTIME + '/payload-control-inventory.json'
FILES = ('payload-control-inventory.py', 'payload-control-state.py')
DISKS = ('postgres', 'portal_uploads', 'cms_uploads', 'backups', 'monitor')
ARTIFACTS = {
    'legacy': ('postgres.dump', 'uploads.tar.gz'),
    'payload-v2-shared-postgres': ('postgres.dump', 'uploads.tar.gz', 'cms.dump', 'cms-uploads.tar.gz',
                                  'release.images', 'operations-proof.json', 'backup.format'),
}
STAGES = ('reserved', 'portal_grants_pending', 'portal_grants_verified', 'cms_resources_pending',
          'cms_resources_bound', 'cms_provision_pending', 'provisioned', 'private_started',
          'private_ready', 'b1_committed', 'floor_commit_pending', 'floor_committed')


def require(value):
    if not value:
        raise ValueError('observation_invalid')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode() + b'\n'


def exact(value, names):
    require(type(value) is dict and set(value) == set(names.split()))


def pairs(items):
    value = {}
    for key, item in items:
        require(key not in value)
        value[key] = item
    return value


def ancestry(path, uid=0):
    require(os.path.isabs(path) and os.path.realpath(path) == path)
    current = path
    while True:
        info = os.lstat(current)
        require(not stat.S_ISLNK(info.st_mode))
        if os.name != 'nt':
            sticky_root = current != path and info.st_uid == 0 and info.st_mode & stat.S_ISVTX
            require(info.st_uid in (0, uid) and (sticky_root or not info.st_mode & 0o022))
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent


def read_file(path, maximum=16384, private=True):
    ancestry(path)
    before = os.lstat(path)
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= maximum)
    if os.name != 'nt':
        require(before.st_uid == 0 and not before.st_mode & (0o077 if private else 0o022))
    fd = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino))
        raw = stream.read(maximum + 1)
    require(len(raw) <= maximum)
    return raw


def read_json(path, maximum=16384):
    raw = read_file(path, maximum)
    value = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: require(False))
    require(canonical(value) == raw)
    return value


def atomic_json(path, value, mode=0o640):
    parent = os.path.dirname(path)
    ancestry(parent)
    raw = canonical(value)
    require(len(raw) <= 16384)
    fd, temporary = tempfile.mkstemp(prefix='.observe-', dir=parent)
    try:
        os.fchmod(fd, mode)
        # Directory setgid selects the approved monitor read group; no gid input.
        if os.name != 'nt':
            os.fchown(fd, 0, os.stat(parent).st_gid)
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        if os.path.lexists(path):
            read_file(path, private=False)
        os.replace(temporary, path)
        temporary = None
        descriptor = os.open(parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if temporary:
            os.unlink(temporary)


def check(identity, reason, status='unknown', value=None):
    return dict(id=identity, reason=reason, status=status, **({} if value is None else {'value': value}))


def config():
    value = read_json(CONFIG)
    exact(value, 'schemaVersion inventoryIdentity verifierSha256 mounts')
    require(type(value['schemaVersion']) is int and value['schemaVersion'] == 1)
    require(type(value['inventoryIdentity']) is str and re.fullmatch('[0-9a-f]{64}', value['inventoryIdentity']))
    require(type(value['verifierSha256']) is dict and set(value['verifierSha256']) == set(FILES))
    for name in FILES:
        require(type(value['verifierSha256'][name]) is str and re.fullmatch('[0-9a-f]{64}', value['verifierSha256'][name]))
    require(type(value['mounts']) is dict and set(value['mounts']) == set(DISKS))
    for mount in value['mounts'].values():
        exact(mount, 'path mountPoint device')
        require(all(type(mount[key]) is str and mount[key].startswith('/') and os.path.normpath(mount[key]) == mount[key]
                    and not re.search(r'[\x00-\x1f]', mount[key]) for key in ('path', 'mountPoint')))
        require(type(mount['device']) is int and mount['device'] >= 0)
    return value


def phase_checks(body, sentinel):
    if type(body.get('schemaVersion')) is not int or body['schemaVersion'] not in (1, 2) or body.get('phase') != 'preauthority':
        return [check('host_state', 'unsupported_contract'), check('host_admission', 'unsupported_contract')]
    intent = body.get('installIntent')
    if body.get('restoreIntent') is not None or (intent and (intent.get('stage') not in STAGES or 'recovery' in intent)):
        return [check('host_state', 'unsupported_contract'), check('host_admission', 'unsupported_contract')]
    if body.get('authority') != {'mode': 'legacy', 'epoch': 1} or body.get('workerHold') is not True:
        return [check('host_state', 'unsupported_contract'), check('host_admission', 'unsupported_contract')]
    if body.get('cmsStatus') not in ('cold', 'provisioned', 'migrated'):
        return [check('host_state', 'unsupported_contract'), check('host_admission', 'unsupported_contract')]
    admission = body.get('admission')
    require(admission in ('open', 'closed'))
    # A migrated preauthority state does not authenticate the independently
    # promoted public route. Its exact route adapter remains an integration gate.
    held = body['cmsStatus'] in ('cold', 'provisioned')
    return [check('host_state', 'planned_hold', 'degraded') if held else check('host_state', 'unsupported_contract'),
            check('host_admission', 'ready', 'ok') if sentinel == (admission == 'closed')
            else check('host_admission', 'admission_mismatch', 'failed')]


def observe_state(settings):
    import fcntl
    for name in FILES:
        raw = read_file(os.path.join(CLOSURE, name), 1024 * 1024, private=False)
        require(hashlib.sha256(raw).hexdigest() == settings['verifierSha256'][name])
    specification = importlib.util.spec_from_file_location('monitor_reviewed_state', os.path.join(CLOSURE, FILES[1]))
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    inventory = module.INVENTORY.load(INVENTORY)
    require(module.INVENTORY.identity(inventory) == settings['inventoryIdentity'])
    require(inventory['paths']['runtime'] == RUNTIME)
    lock = RUNTIME + '/deploy.lock'
    # Verify existing lock ancestry with the inventory's reviewed owner policy.
    module.INVENTORY._verify_ancestry(lock, module.INVENTORY.TRUSTED_DIRECTORY_UIDS, 'unsafe_lock')
    before = os.lstat(lock)
    require(stat.S_ISREG(before.st_mode) and not stat.S_ISLNK(before.st_mode) and before.st_nlink == 1
            and before.st_uid in module.INVENTORY.TRUSTED_DIRECTORY_UIDS and not before.st_mode & 0o022)
    fd = os.open(lock, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        require((opened.st_dev, opened.st_ino) == (before.st_dev, before.st_ino))
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except BlockingIOError:
            return [check('host_state', 'observation_busy'), check('host_admission', 'observation_busy')]
        _, _, body, _ = module.read_state(RUNTIME, repair_head=False, inventory_identity=settings['inventoryIdentity'])
        sentinel = lock + '.admission-closed'
        exists = os.path.lexists(sentinel)
        if exists:
            info = os.lstat(sentinel)
            require(stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode) and info.st_nlink == 1
                    and info.st_uid in module.INVENTORY.TRUSTED_DIRECTORY_UIDS and not info.st_mode & 0o022)
        return phase_checks(body, exists)
    finally:
        os.close(fd)


def mount_table(raw):
    require(len(raw) <= 1024 * 1024)
    result = {}
    for line in raw.decode('utf-8').splitlines():
        fields = line.split()
        require(len(fields) >= 10 and '-' in fields)
        point = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), fields[4])
        result[point] = fields[5].split(',')
    return result


def disk_check(identity, mount, mounts, stat_fn=os.stat, statvfs_fn=None):
    try:
        statvfs_fn = statvfs_fn or os.statvfs
        require(os.path.realpath(mount['path']) == mount['path'])
        require(mount['mountPoint'] in mounts and os.path.commonpath([mount['path'], mount['mountPoint']]) == mount['mountPoint'])
        governing = max((point for point in mounts if os.path.commonpath([mount['path'], point]) == point), key=len)
        require(governing == mount['mountPoint'])
        require(stat_fn(mount['path']).st_dev == mount['device'])
        # Read the host mount flags, not ProtectSystem=strict's read-only view.
        if 'ro' in mounts[mount['mountPoint']]:
            return check('disk_' + identity, 'storage_read_only', 'failed')
        usage = statvfs_fn(mount['path'])
        require(usage.f_blocks > 0 and usage.f_files > 0)
        percent = round(max(100 * (1 - usage.f_bavail / usage.f_blocks), 100 * (1 - usage.f_favail / usage.f_files)), 3)
        require(0 <= percent <= 100)
        return check('disk_' + identity, 'disk_critical' if percent >= 90 else 'disk_warning' if percent >= 80 else 'ready',
                     'failed' if percent >= 90 else 'degraded' if percent >= 80 else 'ok', round(percent, 3))
    except Exception:
        return check('disk_' + identity, 'storage_unavailable')


def unit_properties(unit):
    require(unit in ('ownerinc-portal-backup.service', 'ownerinc-portal-backup.timer'))
    # Fixed read-only invocation; bounded on disk before reading, never journal text.
    with tempfile.TemporaryFile(dir=OBSERVATIONS) as output:
        process = subprocess.Popen(['/usr/bin/systemctl', 'show', '--no-pager',
            '--property=LoadState,ActiveState,Result,ExecMainStatus,NextElapseUSecRealtime', unit],
            stdout=output, stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/bin', 'LANG': 'C'})
        try:
            require(process.wait(timeout=2) == 0)
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
        output.seek(0)
        raw = output.read(4097)
    require(len(raw) <= 4096)
    values = {}
    for line in raw.decode('ascii').splitlines():
        key, value = line.split('=', 1)
        require(key in ('LoadState', 'ActiveState', 'Result', 'ExecMainStatus', 'NextElapseUSecRealtime') and key not in values)
        values[key] = value
    return values


def artifact_metadata(directory, names):
    result = {}
    for name in names:
        filename = os.path.join(directory, name)
        ancestry(filename)
        info = os.lstat(filename)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size > 0)
        result[name] = {'size': info.st_size, 'mtimeNs': str(info.st_mtime_ns), 'inode': info.st_ino, 'device': info.st_dev}
    return result


def backup_checks(receipt, now, verify=True):
    exact(receipt, 'version attempt verified')
    require(type(receipt['version']) is int and receipt['version'] == 1)
    attempt = receipt['attempt']
    exact(attempt, 'id startedAt finishedAt outcome')
    require(re.fullmatch('[0-9a-f]{32}', attempt['id']) and attempt['outcome'] in ('running', 'failed', 'verified'))
    require(type(attempt['startedAt']) is int and 0 < attempt['startedAt'] <= now)
    require(attempt['finishedAt'] is None if attempt['outcome'] == 'running'
            else type(attempt['finishedAt']) is int and attempt['startedAt'] <= attempt['finishedAt'] <= now)
    outcome = attempt['outcome']
    rows = [check('backup_attempt', 'backup_running' if outcome == 'running' else 'backup_failed' if outcome == 'failed' else 'verified_local',
                  'degraded' if outcome == 'running' else 'failed' if outcome == 'failed' else 'ok')]
    if receipt['verified'] is None:
        return rows + [check('backup_age', 'backup_missing')]
    value = receipt['verified']
    exact(value, 'captureAt verifiedAt name format manifestSha256 artifacts')
    require(re.fullmatch(r'[0-9]{8}T[0-9]{6}Z', value['name']) and value['format'] in ARTIFACTS
            and re.fullmatch('[0-9a-f]{64}', value['manifestSha256']))
    captured = int(datetime.datetime.strptime(value['name'], '%Y%m%dT%H%M%SZ').replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)
    require(type(value['captureAt']) is int and value['captureAt'] == captured
            and type(value['verifiedAt']) is int and 0 < captured <= value['verifiedAt'] <= now)
    names = ARTIFACTS[value['format']] + ('manifest.sha256',)
    require(type(value['artifacts']) is dict and set(value['artifacts']) == set(names))
    if verify:
        directory = os.path.join(BACKUPS, value['name'])
        require(artifact_metadata(directory, names) == value['artifacts'])
        require(hashlib.sha256(read_file(directory + '/manifest.sha256')).hexdigest() == value['manifestSha256'])
    age = (now - captured) // 1000
    return rows + [check('backup_age', 'backup_stale' if age > 86400 else 'verified_local', 'failed' if age > 86400 else 'ok', age)]


def record_backup(action, name=None):
    # Invoked only by the protected backup wrapper. Arguments identify a basename,
    # never an arbitrary directory or command. Root can already alter receipts.
    now = int(time.time() * 1000)
    filename = OBSERVATIONS + '/backup.json'
    try:
        value = read_json(filename)
        backup_checks(value, now, verify=False)
    except FileNotFoundError:
        value = {'version': 1, 'attempt': None, 'verified': None}
    if action == 'backup-start':
        value['attempt'] = {'id': uuid.uuid4().hex, 'startedAt': now, 'finishedAt': None, 'outcome': 'running'}
    else:
        require(value['attempt'] is not None and value['attempt']['outcome'] == 'running')
        value['attempt']['finishedAt'] = now
        value['attempt']['outcome'] = 'failed' if action == 'backup-failed' else 'verified'
        if action == 'backup-verified':
            require(type(name) is str and re.fullmatch('[0-9]{8}T[0-9]{6}Z', name))
            directory = BACKUPS + '/' + name
            marker = directory + '/backup.format'
            form = read_file(marker, 128).decode().strip() if os.path.lexists(marker) else 'legacy'
            require(form in ARTIFACTS)
            manifest = read_file(directory + '/manifest.sha256')
            parsed = [re.fullmatch(r'([0-9a-f]{64}) [ *]([a-z.-]+)', line) for line in manifest.decode('ascii').splitlines()]
            require(all(parsed) and tuple(match[2] for match in parsed) == ARTIFACTS[form])
            capture = int(datetime.datetime.strptime(name, '%Y%m%dT%H%M%SZ').replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)
            require(0 < capture <= now)
            value['verified'] = {'captureAt': capture, 'verifiedAt': now, 'name': name, 'format': form,
                'manifestSha256': hashlib.sha256(manifest).hexdigest(),
                'artifacts': artifact_metadata(directory, ARTIFACTS[form] + ('manifest.sha256',))}
    atomic_json(filename, value, 0o600)


def collect(clock=time.time):
    now = int(clock() * 1000)
    rows = []
    try:
        settings = config()
    except Exception:
        settings = None
    try:
        require(settings is not None)
        rows += observe_state(settings)
    except Exception:
        rows += [check('host_state', 'state_unverified'), check('host_admission', 'state_unverified')]
    try:
        with open('/proc/1/mountinfo', 'rb') as source:
            mounts = mount_table(source.read(1024 * 1024 + 1))
        require(settings is not None)
        rows += [disk_check(identity, settings['mounts'][identity], mounts) for identity in DISKS]
    except Exception:
        rows += [check('disk_' + identity, 'storage_unavailable') for identity in DISKS]
    try:
        receipt = read_json(OBSERVATIONS + '/backup.json')
        # A backup may publish atomically while earlier checks are in progress.
        # Validate its timestamps against a fresh clock after reading that receipt.
        rows += backup_checks(receipt, int(clock() * 1000))
    except FileNotFoundError:
        rows += [check('backup_age', 'backup_missing'), check('backup_attempt', 'backup_missing')]
    except Exception:
        rows += [check('backup_age', 'backup_invalid', 'failed'), check('backup_attempt', 'backup_invalid', 'failed')]
    try:
        service = unit_properties('ownerinc-portal-backup.service')
        timer = unit_properties('ownerinc-portal-backup.timer')
        require(service.get('LoadState') == 'loaded' and timer.get('LoadState') == 'loaded')
        require(timer.get('ActiveState') == 'active' and timer.get('NextElapseUSecRealtime') not in (None, '', 'n/a'))
        if service.get('Result') not in ('success', '') or service.get('ExecMainStatus') not in ('0', ''):
            rows = [check('backup_attempt', 'backup_failed', 'failed') if row['id'] == 'backup_attempt' else row for row in rows]
        rows.append(check('backup_timer', 'ready', 'ok'))
    except Exception:
        rows.append(check('backup_timer', 'backup_timer_unavailable'))
    return {'schemaVersion': 1, 'kind': 'portal-operational-observation-v1', 'source': 'host',
            'generation': uuid.uuid4().hex, 'observedAt': now, 'expiresAt': now + 120000, 'checks': rows}


def main():
    require(sys.platform == 'linux' and os.geteuid() == 0)
    args = sys.argv[1:]
    require(args == ['collect'] or args in (['backup-start'], ['backup-failed'])
            or len(args) == 2 and args[0] == 'backup-verified')
    import resource
    resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_FSIZE, (1024 * 1024, 1024 * 1024))
    signal.signal(signal.SIGALRM, lambda *_: (_ for _ in ()).throw(TimeoutError()))
    signal.alarm(9)
    if args == ['collect']:
        atomic_json(OBSERVATIONS + '/host.json', collect())
    else:
        record_backup(*args)


if __name__ == '__main__':
    try:
        sys.dont_write_bytecode = True
        main()
    except BaseException:
        sys.stderr.write('operational_observation_unavailable\n')
        sys.exit(1)
