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
# These are reviewed identities, never values learned from filesystem metadata
# or environment/CLI overrides. Disposable non-production inventories use root.
PRODUCTION_ENVIRONMENT_OWNER = {'uid': 1000, 'gid': 1000}
ROOT_ENVIRONMENT_OWNER = {'uid': 0, 'gid': 0}
TRUSTED_DIRECTORY_UIDS = {0, 1000}
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
    if isinstance(value, dict) and (type(value.get('schemaVersion')) is not int or value['schemaVersion'] != 2):
        fail('unsupported_inventory_version')
    if not isinstance(value, dict) or set(value) != {
        'schemaVersion', 'project', 'paths', 'volumes', 'trustedSourceInventoryIdentities',
        'environmentFileOwner',
    }:
        fail('invalid_inventory_shape')
    project = value['project']
    if not isinstance(project, str) or not PROJECT.fullmatch(project):
        fail('invalid_inventory_project')
    owner = value['environmentFileOwner']
    expected_owner = PRODUCTION_ENVIRONMENT_OWNER if project == 'ownerinc-portal-prod' else ROOT_ENVIRONMENT_OWNER
    if not isinstance(owner, dict) or set(owner) != {'uid', 'gid'} or \
       any(type(owner[name]) is not int for name in ('uid', 'gid')) or owner != expected_owner:
        fail('invalid_environment_file_owner')
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


def _verify_ancestry(path, trusted_uids, reason):
    """lstat each ancestor; a realpath-only check would miss unsafe ownership."""
    if not os.path.isabs(path) or os.path.realpath(path) != path:
        fail(reason)
    current = os.path.dirname(path)
    while True:
        try:
            info = os.lstat(current)
        except OSError:
            fail(reason)
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
            fail(reason)
        if os.name != 'nt':
            mode = stat.S_IMODE(info.st_mode)
            if info.st_uid not in trusted_uids or \
               (mode & 0o022 and not (info.st_uid == 0 and mode & stat.S_ISVTX)):
                fail(reason)
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent


def verify_environment_file(path, expected_owner):
    """Verify an already-approved inventory owner; never discover/return a policy."""
    if not isinstance(expected_owner, dict) or set(expected_owner) != {'uid', 'gid'} or \
       any(type(expected_owner[name]) is not int for name in ('uid', 'gid')) or \
       expected_owner not in (PRODUCTION_ENVIRONMENT_OWNER, ROOT_ENVIRONMENT_OWNER):
        fail('invalid_environment_file_owner')
    _verify_ancestry(path, {0, expected_owner['uid']}, 'unsafe_environment_ancestry')
    try:
        info = os.lstat(path)
    except OSError:
        fail('environment_unavailable')
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        fail('unsafe_environment_file')
    if os.name != 'nt':
        if stat.S_IMODE(info.st_mode) != 0o600:
            fail('unsafe_environment_permissions')
        if (info.st_uid, info.st_gid) != (expected_owner['uid'], expected_owner['gid']):
            fail('unsafe_environment_owner')
    return info


def _safe_regular(path, mode=0o600, owner_root=True):
    _verify_ancestry(path, TRUSTED_DIRECTORY_UIDS, 'unsafe_inventory_ancestry')
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
    before = _safe_regular(path)
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
        with os.fdopen(descriptor, 'rb') as stream:
            opened = os.fstat(stream.fileno())
            if (before.st_dev, before.st_ino, before.st_uid, before.st_gid, before.st_mode, before.st_nlink) != \
               (opened.st_dev, opened.st_ino, opened.st_uid, opened.st_gid, opened.st_mode, opened.st_nlink):
                fail('unsafe_inventory_file')
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
        'schemaVersion': 2,
        'project': project,
        'environmentFileOwner': dict(PRODUCTION_ENVIRONMENT_OWNER),
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
    _verify_ancestry(path, TRUSTED_DIRECTORY_UIDS, 'unsafe_inventory_ancestry')
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
            verify_environment_file(value['paths']['environmentFile'], value['environmentFileOwner'])
            create(output, value)
            print('protected production inventory created')
        elif len(argv) == 14 and argv[1] == 'verify-production':
            value = load(argv[2])
            expected = production_inventory(*argv[3:])
            if canonical(value) != canonical(expected):
                fail('production_inventory_mismatch')
            verify_environment_file(value['paths']['environmentFile'], value['environmentFileOwner'])
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
