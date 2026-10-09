#!/usr/bin/env python3
"""Private, non-sourcing production environment preparation for Payload."""

import json
import importlib.util
import os
import re
import secrets
import stat
import sys
import tempfile
from urllib.parse import unquote, urlsplit

REQUIRED = {
    'CMS_POSTGRES_PASSWORD', 'CMS_CONTROLLER_PASSWORD', 'CMS_MIGRATOR_PASSWORD', 'CMS_RUNTIME_PASSWORD',
    'CMS_ADMIN_DATABASE_URL', 'CMS_MIGRATION_DATABASE_URL', 'CMS_RUNTIME_DATABASE_URL',
    'PAYLOAD_SECRET', 'PAYLOAD_TO_PORTAL_SECRET', 'PORTAL_TO_PAYLOAD_SECRET',
}
LEGACY_REQUIRED = REQUIRED - {'CMS_CONTROLLER_PASSWORD'}
SECRET_KEYS = {
    'CMS_POSTGRES_PASSWORD', 'CMS_CONTROLLER_PASSWORD', 'CMS_MIGRATOR_PASSWORD', 'CMS_RUNTIME_PASSWORD',
    'PAYLOAD_SECRET', 'PAYLOAD_TO_PORTAL_SECRET', 'PORTAL_TO_PAYLOAD_SECRET',
}
URL_USERS = {
    'CMS_ADMIN_DATABASE_URL': ('cms_admin', 'CMS_POSTGRES_PASSWORD'),
    'CMS_MIGRATION_DATABASE_URL': ('cms_migrator', 'CMS_MIGRATOR_PASSWORD'),
    'CMS_RUNTIME_DATABASE_URL': ('cms_runtime', 'CMS_RUNTIME_PASSWORD'),
}
CANONICAL_PORTAL_URL = 'https://portal.ownerinc.com.br'
INVENTORY_PATH = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'payload-control-inventory.py')
INVENTORY_SPEC = importlib.util.spec_from_file_location('cms_preparation_inventory', INVENTORY_PATH)
if INVENTORY_SPEC is None or INVENTORY_SPEC.loader is None:
    raise SystemExit(2)
INVENTORY = importlib.util.module_from_spec(INVENTORY_SPEC)
INVENTORY_SPEC.loader.exec_module(INVENTORY)
PRODUCTION_ENVIRONMENT_OWNER = INVENTORY.PRODUCTION_ENVIRONMENT_OWNER


class PreparationError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def fail(code):
    raise PreparationError(code)


def read_environment(path):
    try:
        # Production identity is fixed by the reviewed installer, not learned
        # from this file or supplied by an environment-owner command-line flag.
        info = INVENTORY.verify_environment_file(path, PRODUCTION_ENVIRONMENT_OWNER)
        descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        try:
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino, opened.st_uid, opened.st_gid, opened.st_mode, opened.st_nlink) != \
               (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode, info.st_nlink):
                fail('unsafe_environment_file')
            with os.fdopen(descriptor, 'rb', closefd=False) as stream:
                raw = stream.read()
        finally:
            os.close(descriptor)
    except PreparationError:
        raise
    except INVENTORY.InventoryError as error:
        fail(str(error))
    except OSError:
        fail('environment_unavailable')

    values = {}
    duplicates = set()
    for line in raw.splitlines():
        candidate = line.strip()
        if not candidate or candidate.startswith(b'#'):
            continue
        if candidate.startswith(b'export '):
            candidate = candidate[len(b'export '):].lstrip()
        if b'=' not in candidate:
            possible_key = candidate.split(None, 1)[0].decode('ascii', errors='ignore')
            if possible_key in REQUIRED | {'PORTAL_PUBLIC_URL'}:
                fail('malformed_protected_environment_entry')
            continue
        key_bytes, value_bytes = candidate.split(b'=', 1)
        try:
            key = key_bytes.decode('ascii').strip()
        except UnicodeDecodeError:
            continue
        if key not in REQUIRED | {'PORTAL_PUBLIC_URL'}:
            continue
        if key in values:
            duplicates.add(key)
        try:
            value = value_bytes.decode('utf-8')
        except UnicodeDecodeError:
            fail('invalid_environment_encoding')
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key] = value
    if duplicates:
        fail('duplicate_environment_key')
    present = REQUIRED.intersection(values)
    if 'PORTAL_PUBLIC_URL' not in values:
        if present == REQUIRED:
            fail('canonical_portal_url_missing_for_existing_cms_configuration')
        if present:
            fail('partial_cms_credential_set')
    elif values['PORTAL_PUBLIC_URL'] != CANONICAL_PORTAL_URL:
        fail('canonical_portal_url_mismatch')
    return raw, info, values


def validate_values(values):
    present = REQUIRED.intersection(values)
    if not present:
        return 'empty'
    if present not in (REQUIRED, LEGACY_REQUIRED):
        fail('partial_cms_credential_set')
    legacy = present == LEGACY_REQUIRED
    checked_secrets = SECRET_KEYS - {'CMS_CONTROLLER_PASSWORD'} if legacy else SECRET_KEYS
    for key in checked_secrets:
        value = values[key]
        if len(value) < 32 or not re.fullmatch(r'[A-Za-z0-9_-]+', value):
            fail('invalid_cms_credential')
        if re.search(r'example|placeholder|change-me', value, re.I):
            fail('invalid_cms_credential')
    if len({values[key] for key in checked_secrets}) != len(checked_secrets):
        fail('cms_credentials_not_distinct')
    for key, (username, password_key) in URL_USERS.items():
        try:
            parsed = urlsplit(values[key])
            valid = (
                parsed.scheme in ('postgres', 'postgresql')
                and parsed.hostname == 'cms-postgres'
                and parsed.port == 5432
                and parsed.path == '/ownerinc_cms'
                and parsed.username == username
                and unquote(parsed.password or '') == values[password_key]
                and not parsed.query
                and not parsed.fragment
            )
        except (ValueError, TypeError):
            valid = False
        if not valid:
            fail('invalid_cms_database_url')
    return 'legacy-complete' if legacy else 'complete'


def inspect(path):
    _, _, values = read_environment(path)
    print(validate_values(values))


def update(path):
    raw, before, values = read_environment(path)
    state = validate_values(values)
    if state not in ('empty', 'legacy-complete'):
        fail('configuration_changed_during_preparation')

    if state == 'legacy-complete':
        generated = {'CMS_CONTROLLER_PASSWORD': secrets.token_hex(32)}
        if generated['CMS_CONTROLLER_PASSWORD'] in {values[key] for key in SECRET_KEYS - {'CMS_CONTROLLER_PASSWORD'}}:
            fail('credential_generation_failed')
        entries = generated
    else:
        generated = {
            'CMS_POSTGRES_PASSWORD': secrets.token_hex(32),
            'CMS_CONTROLLER_PASSWORD': secrets.token_hex(32),
            'CMS_MIGRATOR_PASSWORD': secrets.token_hex(32),
            'CMS_RUNTIME_PASSWORD': secrets.token_hex(32),
            'PAYLOAD_SECRET': secrets.token_hex(32),
            'PAYLOAD_TO_PORTAL_SECRET': secrets.token_hex(32),
            'PORTAL_TO_PAYLOAD_SECRET': secrets.token_hex(32),
        }
        if len(set(generated.values())) != len(generated):
            fail('credential_generation_failed')
        entries = {
            **generated,
            'CMS_ADMIN_DATABASE_URL': (
                f"postgresql://cms_admin:{generated['CMS_POSTGRES_PASSWORD']}@cms-postgres:5432/ownerinc_cms"
            ),
            'CMS_MIGRATION_DATABASE_URL': (
                f"postgresql://cms_migrator:{generated['CMS_MIGRATOR_PASSWORD']}@cms-postgres:5432/ownerinc_cms"
            ),
            'CMS_RUNTIME_DATABASE_URL': (
                f"postgresql://cms_runtime:{generated['CMS_RUNTIME_PASSWORD']}@cms-postgres:5432/ownerinc_cms"
            ),
        }
    if 'PORTAL_PUBLIC_URL' not in values:
        entries = {'PORTAL_PUBLIC_URL': CANONICAL_PORTAL_URL, **entries}
    suffix = b'' if not raw or raw.endswith(b'\n') else b'\n'
    suffix += ''.join(f'{key}={value}\n' for key, value in entries.items()).encode('ascii')
    directory = os.path.dirname(os.path.abspath(path))
    descriptor = -1
    temporary = None
    try:
        descriptor, temporary = tempfile.mkstemp(prefix='.production.runtime.conf.', dir=directory)
        os.fchmod(descriptor, stat.S_IMODE(before.st_mode))
        if os.name != 'nt':
            current_uid, current_gid = os.geteuid(), os.getegid()
            if (before.st_uid, before.st_gid) != (current_uid, current_gid):
                os.fchown(descriptor, before.st_uid, before.st_gid)
        with os.fdopen(descriptor, 'wb', closefd=True) as stream:
            descriptor = -1
            stream.write(raw)
            stream.write(suffix)
            stream.flush()
            os.fsync(stream.fileno())
        latest = INVENTORY.verify_environment_file(path, PRODUCTION_ENVIRONMENT_OWNER)
        if (
            (latest.st_dev, latest.st_ino, latest.st_uid, latest.st_gid, latest.st_mode, latest.st_nlink) !=
            (before.st_dev, before.st_ino, before.st_uid, before.st_gid, before.st_mode, before.st_nlink)
        ):
            fail('environment_changed_during_preparation')
        os.replace(temporary, path)
        temporary = None
        if os.name != 'nt':
            directory_fd = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    except PreparationError:
        raise
    except INVENTORY.InventoryError as error:
        fail(str(error))
    except Exception:
        fail('private_environment_write_failed')
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def backup_metadata(output, paths):
    names = ['receiver', 'guard', 'environment']
    record = {}
    for name, path in zip(names, paths):
        try:
            info = os.lstat(path)
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
                fail('unsafe_backup_source')
            record[name] = {
                'present': True,
                'uid': info.st_uid,
                'gid': info.st_gid,
                'mode': format(stat.S_IMODE(info.st_mode), '04o'),
            }
        except FileNotFoundError:
            record[name] = {'present': False}
        except OSError:
            fail('unsafe_backup_source')
    try:
        with open(output, 'x', encoding='utf-8') as stream:
            json.dump(record, stream, sort_keys=True)
            stream.write('\n')
        os.chmod(output, 0o600)
    except OSError:
        fail('backup_metadata_write_failed')


def main():
    if len(sys.argv) < 3:
        print('Usage: prepare-cms-infrastructure-private.py inspect|update ENV | backup-metadata FILE RECEIVER GUARD ENV', file=sys.stderr)
        return 2
    action = sys.argv[1]
    try:
        if action == 'inspect' and len(sys.argv) == 3:
            inspect(sys.argv[2])
        elif action == 'update' and len(sys.argv) == 3:
            update(sys.argv[2])
        elif action == 'backup-metadata' and len(sys.argv) == 6:
            backup_metadata(sys.argv[2], sys.argv[3:])
        else:
            print('Invalid private preparation action.', file=sys.stderr)
            return 2
    except PreparationError as error:
        print(error.code, file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
