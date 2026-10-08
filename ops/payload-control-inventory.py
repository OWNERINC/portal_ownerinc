#!/usr/bin/env python3
"""Strict protected inventory for the Payload preauthority host adapter."""

import hashlib
import json
import os
import re
import stat
import sys
import tempfile


HEX_64 = re.compile(r'^[0-9a-f]{64}$')
PROJECT = re.compile(r'^[a-z0-9][a-z0-9_-]{0,62}$')
PATH_KEYS = {
    'root', 'runtime', 'releases', 'currentRelease', 'lock', 'admissionClosed',
    'backupRoots', 'preRestoreBackupRoot', 'environmentFile', 'composeOverride',
    'payloadOverride',
}
VOLUME_KEYS = {'portalPostgres', 'portalUploads', 'cmsPostgres', 'cmsUploads'}
MOUNT_SHAPE = {
    'portalPostgres': {'composeKey': 'postgres_data', 'mounts': [('postgres', '/var/lib/postgresql/data', True)]},
    'portalUploads': {'composeKey': 'uploads_data', 'mounts': [('api', '/app/uploads', True), ('cron', '/app/uploads', True)]},
    'cmsPostgres': {'composeKey': 'cms_postgres_data', 'mounts': [('cms-postgres', '/var/lib/postgresql/data', True)]},
    'cmsUploads': {'composeKey': 'cms_uploads_data', 'mounts': [('cms', '/var/lib/ownerinc-cms/media', True), ('cms-worker', '/var/lib/ownerinc-cms/media', False)]},
}


class InventoryError(Exception):
    pass


def fail(code):
    raise InventoryError(code)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True,
                      separators=(',', ':')).encode('utf-8')


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail('duplicate_inventory_field')
        result[key] = value
    return result


def _path(value):
    if not isinstance(value, str) or not os.path.isabs(value) or '\x00' in value:
        fail('invalid_inventory_path')
    normalized = os.path.normpath(value)
    if normalized != value and normalized.replace('\\', '/') != value:
        fail('invalid_inventory_path')


def _same_path(left, right):
    return left == right or left.replace('\\', '/') == right.replace('\\', '/')


def validate(value):
    if not isinstance(value, dict) or set(value) != {
        'schemaVersion', 'project', 'paths', 'volumes', 'trustedSourceInventoryIdentities',
    }:
        fail('invalid_inventory_shape')
    if type(value['schemaVersion']) is not int or value['schemaVersion'] != 1:
        fail('unsupported_inventory_version')
    project = value['project']
    if not isinstance(project, str) or not PROJECT.fullmatch(project):
        fail('invalid_inventory_project')
    paths = value['paths']
    if not isinstance(paths, dict) or set(paths) != PATH_KEYS:
        fail('invalid_inventory_paths')
    for name in PATH_KEYS - {'backupRoots'}:
        _path(paths[name])
    root = paths['root']
    runtime = paths['runtime']
    if not _same_path(paths['runtime'], os.path.join(root, 'runtime')) or \
       not _same_path(paths['releases'], os.path.join(root, 'releases')) or \
       not _same_path(paths['currentRelease'], os.path.join(root, 'current-release')) or \
       not _same_path(paths['lock'], os.path.join(runtime, 'deploy.lock')) or \
       paths['admissionClosed'] != paths['lock'] + '.admission-closed':
        fail('invalid_inventory_operational_paths')
    backup_roots = paths['backupRoots']
    if not isinstance(backup_roots, list) or not backup_roots or \
       any(not isinstance(item, str) for item in backup_roots) or backup_roots != sorted(set(backup_roots)):
        fail('invalid_inventory_backup_paths')
    for item in backup_roots:
        _path(item)
    if paths['preRestoreBackupRoot'] in backup_roots:
        fail('invalid_inventory_backup_paths')
    volumes = value['volumes']
    if not isinstance(volumes, dict) or set(volumes) != VOLUME_KEYS:
        fail('invalid_inventory_volumes')
    names = []
    for key, shape in MOUNT_SHAPE.items():
        entry = volumes[key]
        if not isinstance(entry, dict) or set(entry) != {'name', 'composeKey', 'mounts'}:
            fail('invalid_inventory_volumes')
        if entry['name'] != project + '_' + shape['composeKey'] or entry['composeKey'] != shape['composeKey']:
            fail('invalid_inventory_volume_name')
        mounts = entry['mounts']
        if not isinstance(mounts, list) or len(mounts) != len(shape['mounts']):
            fail('invalid_inventory_mounts')
        observed = []
        for mount in mounts:
            if not isinstance(mount, dict) or set(mount) != {'service', 'destination', 'required'}:
                fail('invalid_inventory_mounts')
            if not isinstance(mount['service'], str) or not isinstance(mount['destination'], str) or type(mount['required']) is not bool:
                fail('invalid_inventory_mounts')
            observed.append((mount['service'], mount['destination'], mount['required']))
        if observed != shape['mounts']:
            fail('invalid_inventory_mounts')
        names.append(entry['name'])
    if len(set(names)) != len(names):
        fail('invalid_inventory_volume_name')
    trusted = value['trustedSourceInventoryIdentities']
    if not isinstance(trusted, list) or any(not isinstance(item, str) or not HEX_64.fullmatch(item) for item in trusted) or \
       trusted != sorted(set(trusted)):
        fail('invalid_inventory_trust')
    return value


def identity(value):
    return hashlib.sha256(canonical(validate(value))).hexdigest()


def _safe_regular(path, mode=0o600, owner_root=True):
    try:
        info = os.lstat(path)
    except OSError:
        fail('inventory_unavailable')
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        fail('unsafe_inventory_file')
    if os.name != 'nt' and (stat.S_IMODE(info.st_mode) != mode or (owner_root and info.st_uid != 0)):
        fail('unsafe_inventory_permissions')
    if os.path.realpath(path) != path:
        fail('unsafe_inventory_file')
    return info


def load(path):
    _safe_regular(path)
    try:
        with open(path, 'rb') as stream:
            raw = stream.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024 or not raw.endswith(b'\n') or b'\r' in raw:
            fail('invalid_inventory_file')
        value = json.loads(raw[:-1].decode('utf-8'), object_pairs_hook=_pairs,
                           parse_constant=lambda _value: fail('invalid_inventory_file'))
        if canonical(value) + b'\n' != raw:
            fail('noncanonical_inventory')
    except InventoryError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, OSError):
        fail('invalid_inventory_file')
    return validate(value)


def production_inventory(root, runtime, releases, current, lock, daily_backup, production_backup, pre_restore,
                         environment, compose_override, payload_override):
    project = 'ownerinc-portal-prod'
    volumes = {}
    for key, shape in MOUNT_SHAPE.items():
        volumes[key] = {
            'name': project + '_' + shape['composeKey'],
            'composeKey': shape['composeKey'],
            'mounts': [{'service': service, 'destination': destination, 'required': required}
                       for service, destination, required in shape['mounts']],
        }
    return validate({
        'schemaVersion': 1,
        'project': project,
        'paths': {
            'root': root, 'runtime': runtime, 'releases': releases,
            'currentRelease': current, 'lock': lock, 'admissionClosed': lock + '.admission-closed',
            'backupRoots': sorted([daily_backup, production_backup]), 'preRestoreBackupRoot': pre_restore,
            'environmentFile': environment, 'composeOverride': compose_override,
            'payloadOverride': payload_override,
        },
        'volumes': volumes,
        'trustedSourceInventoryIdentities': [],
    })


def create(path, value):
    parent = os.path.dirname(path)
    if not os.path.isabs(path) or os.path.realpath(parent) != parent or os.path.lexists(path):
        fail('unsafe_inventory_destination')
    raw = canonical(validate(value)) + b'\n'
    descriptor, temporary = tempfile.mkstemp(prefix='.payload-inventory.', dir=parent)
    try:
        if os.name != 'nt':
            os.fchown(descriptor, 0, 0)
            os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
    except OSError:
        fail('inventory_write_failed')
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def main(argv):
    try:
        if len(argv) == 3 and argv[1] == 'validate':
            value = load(argv[2])
            print(identity(value))
        elif len(argv) == 14 and argv[1] == 'create-production':
            output = argv[2]
            paths = argv[3:]
            value = production_inventory(*paths)
            create(output, value)
            print('protected production inventory created')
        elif len(argv) == 14 and argv[1] == 'verify-production':
            value = load(argv[2])
            expected = production_inventory(*argv[3:])
            if canonical(value) != canonical(expected):
                fail('production_inventory_mismatch')
            print('protected production inventory verified')
        else:
            print('Invalid inventory helper invocation.', file=sys.stderr)
            return 2
    except InventoryError as error:
        print(str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
