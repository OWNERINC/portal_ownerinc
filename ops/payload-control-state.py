#!/usr/bin/env python3
"""Private, fail-closed state/proof primitives for the preauthority adapter.

This module deliberately knows nothing about Docker or database contents. It
stores a signed append-only host journal and verifies signed, metadata-only
backup proofs. The key and journal are host state, never backup artifacts.
"""

import hashlib
import hmac
import importlib.util
import json
import os
import re
import secrets
import stat
import sys
import tempfile


INVENTORY_PATH = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'payload-control-inventory.py')
INVENTORY_SPEC = importlib.util.spec_from_file_location('payload_control_inventory', INVENTORY_PATH)
if INVENTORY_SPEC is None or INVENTORY_SPEC.loader is None:
    raise SystemExit(2)
INVENTORY = importlib.util.module_from_spec(INVENTORY_SPEC)
INVENTORY_SPEC.loader.exec_module(INVENTORY)


HEX_64 = re.compile(r'^[0-9a-f]{64}$')
IMAGE = {
    'api': re.compile(r'^ghcr\.io/ownerinc/ownerinc-portal-api@sha256:[0-9a-f]{64}$'),
    'cron': re.compile(r'^ghcr\.io/ownerinc/ownerinc-portal-cron@sha256:[0-9a-f]{64}$'),
    'cms': re.compile(r'^ghcr\.io/ownerinc/ownerinc-portal-cms@sha256:[0-9a-f]{64}$'),
}
PORTAL_MIGRATIONS = [
    '001_initial_schema', '002_reliable_notifications', '003_governance',
    '004_operational_hardening', '005_notification_claim_state', '006_user_erasure',
    '007_solides_employee_links', '008_solides_link_hardening', '009_job_titles',
    '010_autocard', '011_cron_alert_state', '012_autocard_media_crop',
    '013_job_title_catalog', '015_cms_editor', '016_remove_ombudsman',
    '017_pos_cards', '018_pos_card_storage_key', '019_cms_asset_deletion_state',
    '020_profile_photo_crop', '021_bulk_user_imports', '022_bulk_user_import_validation',
    '023_pos_owner_cards', '024_job_title_page_access', '025_pending_registrations',
    '026_firebase_enable_pending', '027_pending_registration_cleanup',
    '028_firebase_cleanup_queue', '029_autocard_media_safety',
    '030_dho_job_title_catalog', '031_contract_invariants', '032_user_import_identity',
    '033_academy_learning', '034_owner_news_editorial', '035_owner_news_polls',
    '036_payload_editorial_control',
]
CMS_MIGRATIONS = [
    '20261002_181423_owner_news_initial',
    '20261005_133515_owner_news_media',
    '20261005_151541_owner_news_publication',
    '20261005_220916_owner_news_legacy_history',
    '20261006_181325_a_owner_news_suspend_enum',
    '20261006_181424_z_owner_news_native',
]
LEGACY_ARTIFACTS = ['postgres.dump', 'uploads.tar.gz']
PAYLOAD_ARTIFACTS = ['postgres.dump', 'uploads.tar.gz', 'cms-postgres.dump', 'cms-uploads.tar.gz']


class StateError(Exception):
    """An intentionally sanitized operational-control failure."""


def fail(code):
    raise StateError(code)


def canonical(value):
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False,
                          sort_keys=True, separators=(',', ':')).encode('utf-8')
    except (TypeError, ValueError, UnicodeEncodeError):
        fail('invalid_json_value')


def _pairs_without_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail('duplicate_json_field')
        result[key] = value
    return result


def parse_canonical(raw, reason):
    if not isinstance(raw, bytes) or not raw.endswith(b'\n') or b'\r' in raw:
        fail(reason)
    try:
        value = json.loads(raw[:-1].decode('utf-8'), object_pairs_hook=_pairs_without_duplicates,
                           parse_constant=lambda _value: fail('invalid_json_constant'))
    except StateError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail(reason)
    if canonical(value) + b'\n' != raw:
        fail('noncanonical_json')
    return value


def _exact_keys(value, names, reason):
    if not isinstance(value, dict) or set(value) != set(names):
        fail(reason)


def _safe_int(value, minimum=0):
    return type(value) is int and value >= minimum


def _valid_images(images, payload=True):
    expected = {'api', 'cron', 'cms'} if payload else {'api', 'cron'}
    _exact_keys(images, expected, 'invalid_release_images')
    for name, pattern in IMAGE.items():
        if name in images and (not isinstance(images[name], str) or not pattern.fullmatch(images[name])):
            fail('invalid_release_images')


def validate_state_body(body):
    _exact_keys(body, {
        'schemaVersion', 'phase', 'cmsStatus', 'authority', 'workerHold',
        'admission', 'sequence', 'previousStateSha256', 'restoreIntent',
        'latestProofSha256', 'legacySourceProofSha256', 'releaseImages',
        'plannedReleaseImages', 'rollbackTargetImages', 'nativeCatalogFingerprint',
        'inventoryIdentity',
    }, 'unsupported_state_shape')
    if type(body['schemaVersion']) is not int or body['schemaVersion'] != 1 or body['phase'] != 'preauthority':
        fail('unsupported_state_phase')
    if body['cmsStatus'] not in ('cold', 'migrated'):
        fail('unsupported_cms_state')
    _exact_keys(body['authority'], {'mode', 'epoch'}, 'invalid_authority_state')
    if body['authority'].get('mode') != 'legacy' or type(body['authority'].get('epoch')) is not int or body['authority']['epoch'] != 1:
        fail('unsupported_authority_state')
    if body['workerHold'] is not True:
        fail('worker_admission_forbidden')
    if body['admission'] not in ('open', 'closed'):
        fail('invalid_admission_state')
    if not _safe_int(body['sequence']):
        fail('invalid_state_sequence')
    previous = body['previousStateSha256']
    if body['sequence'] == 0:
        if previous is not None:
            fail('invalid_state_parent')
    elif not isinstance(previous, str) or not HEX_64.fullmatch(previous):
        fail('invalid_state_parent')
    for name in ('latestProofSha256', 'legacySourceProofSha256', 'nativeCatalogFingerprint'):
        value = body[name]
        if value is not None and (not isinstance(value, str) or not HEX_64.fullmatch(value)):
            fail('invalid_state_digest')
    if not isinstance(body['inventoryIdentity'], str) or not HEX_64.fullmatch(body['inventoryIdentity']):
        fail('invalid_state_inventory_identity')
    if body['cmsStatus'] == 'cold':
        if body['releaseImages'] is not None or body['nativeCatalogFingerprint'] is not None:
            fail('invalid_cold_state')
    else:
        if body['releaseImages'] is None:
            fail('invalid_migrated_state')
        _valid_images(body['releaseImages'], payload=True)
        if not isinstance(body['nativeCatalogFingerprint'], str) or not HEX_64.fullmatch(body['nativeCatalogFingerprint']):
            fail('invalid_migrated_state')
    if body['plannedReleaseImages'] is not None:
        _valid_images(body['plannedReleaseImages'], payload=True)
    if body['rollbackTargetImages'] is not None:
        if body['cmsStatus'] != 'cold':
            fail('invalid_rollback_state')
        _valid_images(body['rollbackTargetImages'], payload=False)
    intent = body['restoreIntent']
    if intent is not None:
        _exact_keys(intent, {'proofSha256', 'target', 'releaseImages', 'targetFingerprints', 'stage'}, 'invalid_restore_intent')
        if not isinstance(intent['proofSha256'], str) or not HEX_64.fullmatch(intent['proofSha256']):
            fail('invalid_restore_intent')
        if intent['stage'] not in ('reserved', 'restoring', 'portal_restored', 'portal_grants_restored'):
            fail('invalid_restore_intent')
        _valid_images(intent['releaseImages'], payload=True)
        fingerprints = intent['targetFingerprints']
        _exact_keys(fingerprints, {'portalDatabase', 'cmsDatabase', 'portalUploads', 'cmsUploads'}, 'invalid_restore_target_fingerprints')
        if any(not isinstance(item, str) or not HEX_64.fullmatch(item) for item in fingerprints.values()):
            fail('invalid_restore_target_fingerprints')
        _exact_keys(intent['target'], {'inventoryIdentity', 'portal', 'cms', 'volumes'}, 'invalid_restore_target')
        if not isinstance(intent['target']['inventoryIdentity'], str) or not HEX_64.fullmatch(intent['target']['inventoryIdentity']):
            fail('invalid_restore_target')
        for database in ('portal', 'cms'):
            _validate_database_identity(intent['target'][database])
        if intent['target']['portal']['databaseName'] != 'portal' or \
           intent['target']['cms']['databaseName'] != 'ownerinc_cms':
            fail('invalid_restore_target')
        volumes = intent['target']['volumes']
        _exact_keys(volumes, {'portalPostgres', 'portalUploads', 'cmsPostgres', 'cmsUploads'}, 'invalid_restore_volumes')
        for value in volumes.values():
            _exact_keys(value, {'name', 'driver', 'mountpoint', 'fingerprint'}, 'invalid_restore_volumes')
            if not all(isinstance(value[k], str) and value[k] for k in ('name', 'driver', 'mountpoint')):
                fail('invalid_restore_volumes')
            if not HEX_64.fullmatch(str(value['fingerprint'])):
                fail('invalid_restore_volumes')
    return body


def _validate_database_identity(value):
    _exact_keys(value, {'systemIdentifier', 'databaseOid', 'databaseName'}, 'invalid_database_identity')
    if not isinstance(value['systemIdentifier'], str) or not re.fullmatch(r'[0-9]{1,32}', value['systemIdentifier']):
        fail('invalid_database_identity')
    if not isinstance(value['databaseOid'], str) or not re.fullmatch(r'[1-9][0-9]{0,9}', value['databaseOid']):
        fail('invalid_database_identity')
    if value['databaseName'] not in ('portal', 'ownerinc_cms'):
        fail('invalid_database_identity')


def sign_envelope(body, key):
    unsigned = {'body': body}
    signature = hmac.new(key, canonical(unsigned), hashlib.sha256).hexdigest()
    return {'body': body, 'signature': {
        'algorithm': 'HMAC-SHA256',
        'keyId': hashlib.sha256(key).hexdigest()[:24],
        'value': signature,
    }}


def verify_envelope(envelope, key, body_validator, reason):
    _exact_keys(envelope, {'body', 'signature'}, reason)
    _exact_keys(envelope['signature'], {'algorithm', 'keyId', 'value'}, reason)
    signature = envelope['signature']
    if signature['algorithm'] != 'HMAC-SHA256' or signature['keyId'] != hashlib.sha256(key).hexdigest()[:24]:
        fail('signature_key_mismatch')
    expected = hmac.new(key, canonical({'body': envelope['body']}), hashlib.sha256).hexdigest()
    if not isinstance(signature['value'], str) or not hmac.compare_digest(signature['value'], expected):
        fail('signature_invalid')
    return body_validator(envelope['body'])


def assert_restore_target_matches(reserved, observed):
    if canonical(reserved) != canonical(observed):
        fail('restore_target_changed')


def _state_validator(body):
    return validate_state_body(body)


def _file_info(path, expected_mode=None, private_owner=False):
    try:
        info = os.lstat(path)
    except OSError:
        fail('private_state_file_unavailable')
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        fail('unsafe_private_state_file')
    if os.name != 'nt':
        mode = stat.S_IMODE(info.st_mode)
        if expected_mode is not None and mode != expected_mode:
            fail('unsafe_private_state_permissions')
        trusted_uid = 0 if os.geteuid() == 0 else os.geteuid()
        if private_owner and (info.st_uid != trusted_uid or mode != 0o600):
            fail('unsafe_private_key')
    return info


def _read_file(path, expected_mode=None, private_owner=False):
    before = _file_info(path, expected_mode, private_owner)
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
    try:
        descriptor = os.open(path, flags)
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1 or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino):
                fail('unsafe_private_state_file')
            chunks = []
            while True:
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
            return b''.join(chunks)
        finally:
            os.close(descriptor)
    except StateError:
        raise
    except OSError:
        fail('private_state_file_unavailable')


def _hash_file(path):
    before = _file_info(path)
    digest = hashlib.sha256()
    size = 0
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
        try:
            opened = os.fstat(descriptor)
            if (before.st_dev, before.st_ino) != (opened.st_dev, opened.st_ino) or opened.st_nlink != 1:
                fail('unsafe_backup_artifact')
            while True:
                data = os.read(descriptor, 1024 * 1024)
                if not data:
                    break
                digest.update(data)
                size += len(data)
        finally:
            os.close(descriptor)
    except StateError:
        raise
    except OSError:
        fail('backup_artifact_unavailable')
    return digest.hexdigest(), size


def _safe_runtime_directory(path):
    try:
        info = os.lstat(path)
    except OSError:
        fail('private_state_directory_unavailable')
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        fail('unsafe_private_state_directory')
    trusted_uid = 0 if os.name == 'nt' or os.geteuid() == 0 else os.geteuid()
    if os.name != 'nt' and (info.st_uid != trusted_uid or stat.S_IMODE(info.st_mode) & 0o022):
        fail('unsafe_private_state_directory')
    return info


def _safe_state_directory(path):
    info = _safe_runtime_directory(path)
    if os.name != 'nt' and stat.S_IMODE(info.st_mode) != 0o700:
        fail('unsafe_private_state_directory')
    return info


def _key_for(directory):
    key_path = os.path.join(directory, 'payload-control.key')
    raw = _read_file(key_path, 0o600, private_owner=True)
    if len(raw) != 32:
        fail('invalid_private_key')
    return raw


def _state_paths(directory):
    state_dir = os.path.join(directory, 'payload-control-state')
    _safe_state_directory(state_dir)
    return state_dir, os.path.join(state_dir, 'current.json')


def _journal_name(sequence):
    return '{:020d}.json'.format(sequence)


def read_state(directory):
    _safe_runtime_directory(directory)
    key = _key_for(directory)
    state_dir, head_path = _state_paths(directory)
    names = sorted(os.listdir(state_dir))
    if not names or names[-1] != 'current.json' or 'current.json' not in names:
        fail('state_journal_corrupt')
    journal_names = names[:-1]
    if not journal_names or any(not re.fullmatch(r'[0-9]{20}\.json', name) for name in journal_names):
        fail('state_journal_corrupt')
    body = None
    previous_digest = None
    for sequence, name in enumerate(journal_names):
        if name != _journal_name(sequence):
            fail('state_journal_corrupt')
        path = os.path.join(state_dir, name)
        envelope = parse_canonical(_read_file(path, 0o600, private_owner=True), 'state_journal_corrupt')
        candidate = verify_envelope(envelope, key, _state_validator, 'state_journal_corrupt')
        if candidate['sequence'] != sequence or candidate['previousStateSha256'] != previous_digest:
            fail('state_parent_mismatch')
        previous_digest = hashlib.sha256(canonical(envelope)).hexdigest()
        body = candidate
    head = parse_canonical(_read_file(head_path, 0o600, private_owner=True), 'state_head_corrupt')
    head_body = verify_envelope(head, key, _state_validator, 'state_head_corrupt')
    if canonical(head) != canonical(sign_envelope(body, key)) or head_body != body:
        fail('state_head_mismatch')
    if set(names) != set(journal_names + ['current.json']):
        fail('state_journal_corrupt')
    return key, state_dir, body, previous_digest


def _write_exclusive(path, raw, mode):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0)
    try:
        descriptor = os.open(path, flags, mode)
        with os.fdopen(descriptor, 'wb', closefd=True) as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        if os.name != 'nt':
            os.chown(path, os.geteuid(), os.getegid())
            os.chmod(path, mode)
    except FileExistsError:
        fail('private_state_already_exists')
    except StateError:
        raise
    except OSError:
        fail('private_state_write_failed')


def _atomic_replace(path, raw, mode):
    parent = os.path.dirname(path)
    descriptor = -1
    temporary = None
    try:
        descriptor, temporary = tempfile.mkstemp(prefix='.payload-control.', dir=parent)
        if os.name != 'nt':
            os.fchown(descriptor, os.geteuid(), os.getegid())
            os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, 'wb', closefd=True) as stream:
            descriptor = -1
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        temporary = None
        if os.name != 'nt':
            directory_fd = os.open(parent, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    except OSError:
        fail('private_state_write_failed')
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        if temporary:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def initialize(directory, inventory_identity, trusted_key=None):
    info = os.lstat(directory)
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        fail('unsafe_private_state_directory')
    trusted_uid = 0 if os.name == 'nt' or os.geteuid() == 0 else os.geteuid()
    if os.name != 'nt' and (info.st_uid != trusted_uid or stat.S_IMODE(info.st_mode) & 0o022):
        fail('unsafe_private_state_directory')
    state_dir = os.path.join(directory, 'payload-control-state')
    try:
        os.mkdir(state_dir, 0o700)
        if os.name != 'nt':
            os.chown(state_dir, os.geteuid(), os.getegid())
            os.chmod(state_dir, 0o700)
    except FileExistsError:
        fail('private_state_already_exists')
    except OSError:
        fail('private_state_initialization_failed')
    key_path = os.path.join(directory, 'payload-control.key')
    if not isinstance(inventory_identity, str) or not HEX_64.fullmatch(inventory_identity):
        fail('invalid_state_inventory_identity')
    key = secrets.token_bytes(32) if trusted_key is None else trusted_key
    if not isinstance(key, bytes) or len(key) != 32:
        fail('invalid_private_key')
    body = {
        'schemaVersion': 1, 'phase': 'preauthority', 'cmsStatus': 'cold',
        'authority': {'mode': 'legacy', 'epoch': 1}, 'workerHold': True,
        'admission': 'open', 'sequence': 0, 'previousStateSha256': None,
        'restoreIntent': None, 'latestProofSha256': None,
        'legacySourceProofSha256': None, 'releaseImages': None,
        'plannedReleaseImages': None, 'rollbackTargetImages': None,
        'nativeCatalogFingerprint': None, 'inventoryIdentity': inventory_identity,
    }
    envelope = sign_envelope(validate_state_body(body), key)
    raw = canonical(envelope) + b'\n'
    try:
        _write_exclusive(key_path, key, 0o600)
        _write_exclusive(os.path.join(state_dir, _journal_name(0)), raw, 0o600)
        _write_exclusive(os.path.join(state_dir, 'current.json'), raw, 0o600)
        if os.name != 'nt':
            directory_fd = os.open(state_dir, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            parent_fd = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
            try:
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
    except Exception:
        # A partial initialization is deliberately not repaired or overwritten.
        raise
    return body


def transition(directory, mutate):
    key, state_dir, old, parent_hash = read_state(directory)
    new = json.loads(json.dumps(old))
    mutate(new)
    new['sequence'] = old['sequence'] + 1
    new['previousStateSha256'] = parent_hash
    validate_state_body(new)
    envelope = sign_envelope(new, key)
    raw = canonical(envelope) + b'\n'
    journal_path = os.path.join(state_dir, _journal_name(new['sequence']))
    _write_exclusive(journal_path, raw, 0o600)
    if os.name != 'nt':
        directory_fd = os.open(state_dir, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    _atomic_replace(os.path.join(state_dir, 'current.json'), raw, 0o600)
    return new


def verify_admission(directory, expected):
    if expected not in ('open', 'closed'):
        fail('invalid_admission_state')
    _key, _state_dir, body, _parent = read_state(directory)
    if body['admission'] != expected:
        fail('admission_state_not_' + expected)
    return body


def _validate_identity(identity):
    _exact_keys(identity, {'systemIdentifier', 'databaseOid', 'databaseName'}, 'invalid_database_identity')
    _validate_database_identity(identity)


def validate_proof_body(body):
    common = {
        'schemaVersion', 'kind', 'phase', 'authority', 'protocol', 'images',
        'source', 'migrations', 'dataFingerprints', 'artifacts', 'createdAtUtc',
        'inventoryIdentity',
    }
    if not isinstance(body, dict):
        fail('unsupported_proof_shape')
    if type(body['schemaVersion']) is not int or body['schemaVersion'] != 1 or body['phase'] != 'preauthority':
        fail('unsupported_proof_phase')
    if not isinstance(body['inventoryIdentity'], str) or not HEX_64.fullmatch(body['inventoryIdentity']):
        fail('invalid_proof_inventory_identity')
    kind = body['kind']
    if kind not in ('preauthority-legacy-source', 'preauthority-four-store-backup'):
        fail('unsupported_proof_kind')
    expected_keys = common | ({'targetImages'} if kind == 'preauthority-legacy-source' else set())
    if set(body) != expected_keys:
        fail('unsupported_proof_shape')
    _exact_keys(body['authority'], {'mode', 'epoch'}, 'invalid_proof_authority')
    if body['authority'].get('mode') != 'legacy' or type(body['authority'].get('epoch')) is not int or body['authority']['epoch'] != 1:
        fail('unsupported_proof_authority')
    _exact_keys(body['protocol'], {'status', 'coverage'}, 'invalid_protocol_status')
    if body['protocol'] != {'status': 'absent', 'coverage': 'not-applicable'}:
        fail('unsupported_protocol_state')
    payload = kind == 'preauthority-four-store-backup'
    _valid_images(body['images'], payload=payload)
    if not payload:
        _valid_images(body['targetImages'], payload=True)
    _exact_keys(body['source'], {'portal', 'cms'}, 'invalid_proof_source')
    _validate_identity(body['source']['portal'])
    if body['source']['portal']['databaseName'] != 'portal':
        fail('invalid_proof_source')
    if payload:
        _validate_identity(body['source']['cms'])
        if body['source']['cms']['databaseName'] != 'ownerinc_cms':
            fail('invalid_proof_source')
    elif body['source']['cms'] is not None:
        fail('invalid_legacy_proof_source')
    _exact_keys(body['migrations'], {'portal', 'cms', 'nativeCatalogFingerprint'}, 'invalid_proof_migrations')
    _exact_keys(body['migrations']['portal'], {'versions', 'fingerprint'}, 'invalid_portal_migrations')
    if body['migrations']['portal']['versions'] != PORTAL_MIGRATIONS:
        fail('portal_migration_floor_mismatch')
    expected_portal_hash = hashlib.sha256(canonical(PORTAL_MIGRATIONS)).hexdigest()
    if body['migrations']['portal']['fingerprint'] != expected_portal_hash:
        fail('portal_migration_fingerprint_mismatch')
    if payload:
        _exact_keys(body['migrations']['cms'], {'names', 'fingerprint'}, 'invalid_cms_migrations')
        if body['migrations']['cms']['names'] != CMS_MIGRATIONS:
            fail('cms_migration_floor_mismatch')
        if body['migrations']['cms']['fingerprint'] != hashlib.sha256(canonical(CMS_MIGRATIONS)).hexdigest():
            fail('cms_migration_fingerprint_mismatch')
        if not isinstance(body['migrations']['nativeCatalogFingerprint'], str) or not HEX_64.fullmatch(body['migrations']['nativeCatalogFingerprint']):
            fail('invalid_native_catalog_fingerprint')
    else:
        if body['migrations']['cms'] is not None or body['migrations']['nativeCatalogFingerprint'] is not None:
            fail('invalid_legacy_proof_migrations')
    data_keys = {'portalDatabase', 'cmsDatabase', 'portalUploads', 'cmsUploads'}
    _exact_keys(body['dataFingerprints'], data_keys, 'invalid_data_fingerprints')
    for name in ('portalDatabase', 'portalUploads'):
        if not isinstance(body['dataFingerprints'][name], str) or not HEX_64.fullmatch(body['dataFingerprints'][name]):
            fail('invalid_data_fingerprints')
    if payload:
        for name in ('cmsDatabase', 'cmsUploads'):
            if not isinstance(body['dataFingerprints'][name], str) or not HEX_64.fullmatch(body['dataFingerprints'][name]):
                fail('invalid_data_fingerprints')
    elif body['dataFingerprints']['cmsDatabase'] is not None or body['dataFingerprints']['cmsUploads'] is not None:
            fail('invalid_data_fingerprints')
    if not isinstance(body['createdAtUtc'], str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', body['createdAtUtc']):
        fail('invalid_proof_timestamp')
    expected_artifacts = PAYLOAD_ARTIFACTS if payload else LEGACY_ARTIFACTS
    artifacts = body['artifacts']
    if not isinstance(artifacts, list) or len(artifacts) != len(expected_artifacts):
        fail('invalid_proof_artifacts')
    for item, expected_name in zip(artifacts, expected_artifacts):
        _exact_keys(item, {'name', 'sha256', 'size'}, 'invalid_proof_artifacts')
        if item['name'] != expected_name or not isinstance(item['sha256'], str) or not HEX_64.fullmatch(item['sha256']) or not _safe_int(item['size'], 1):
            fail('invalid_proof_artifacts')
    return body


def read_proof(directory, key, payload=True):
    name = 'operations-proof.json' if payload else 'preauthority-proof.json'
    path = os.path.join(directory, name)
    raw = _read_file(path, 0o600)
    envelope = parse_canonical(raw, 'proof_not_canonical')
    body = verify_envelope(envelope, key, validate_proof_body, 'proof_shape_invalid')
    expected_kind = 'preauthority-four-store-backup' if payload else 'preauthority-legacy-source'
    if body['kind'] != expected_kind:
        fail('unsupported_proof_kind')
    for artifact in body['artifacts']:
        artifact_path = os.path.join(directory, artifact['name'])
        digest, size = _hash_file(artifact_path)
        if size != artifact['size'] or digest != artifact['sha256']:
            fail('backup_artifact_mismatch')
    return body, hashlib.sha256(raw).hexdigest()


def verify_envelope_file(key, path, validator):
    envelope = parse_canonical(_read_file(path, 0o600), 'proof_not_canonical')
    return verify_envelope(envelope, key, validator, 'proof_shape_invalid')


def _directory_from_cli(path):
    if not os.path.isabs(path):
        fail('unsafe_private_state_path')
    resolved = os.path.realpath(path)
    if os.name != 'nt' and resolved != path:
        fail('unsafe_private_state_path')
    _safe_runtime_directory(resolved)
    return resolved


def _inventory_for_runtime(directory):
    path = os.path.join(directory, 'payload-control-inventory.json')
    try:
        value = INVENTORY.load(path)
    except INVENTORY.InventoryError as error:
        fail(str(error))
    if value['paths']['runtime'] != directory:
        fail('inventory_runtime_path_mismatch')
    return value, INVENTORY.identity(value)


def _trusted_source_key(source_directory):
    source_directory = _directory_from_cli(source_directory)
    inventory, source_identity = _inventory_for_runtime(source_directory)
    key = _key_for(source_directory)
    return inventory, source_identity, key


def main(argv):
    if len(argv) not in (3, 4, 5):
        print('Usage: payload-control-state.py initialize|verify-state DIRECTORY | initialize-trusted TARGET_DIRECTORY SOURCE_DIRECTORY SOURCE_INVENTORY_ID | verify-admission DIRECTORY open|closed', file=sys.stderr)
        return 2
    action, directory = argv[1:3]
    try:
        if action == 'initialize' and len(argv) == 3:
            directory = _directory_from_cli(directory)
            inventory, inventory_identity = _inventory_for_runtime(directory)
            initialize(directory, inventory_identity)
            print('private preauthority state initialized')
        elif action == 'initialize-trusted' and len(argv) == 5:
            target_directory = _directory_from_cli(directory)
            source_inventory, source_identity, key = _trusted_source_key(argv[3])
            if argv[4] != source_identity:
                fail('trusted_source_identity_mismatch')
            target_inventory, target_identity = _inventory_for_runtime(target_directory)
            if source_identity not in target_inventory['trustedSourceInventoryIdentities']:
                fail('trusted_source_not_authorized')
            initialize(target_directory, target_identity, trusted_key=key)
            print('private state initialized with explicitly trusted fixture signing key')
        elif action == 'verify-state' and len(argv) == 3:
            directory = _directory_from_cli(directory)
            _key, _state_dir, body, _parent = read_state(directory)
            _inventory, inventory_identity = _inventory_for_runtime(directory)
            if body['inventoryIdentity'] != inventory_identity:
                fail('state_inventory_identity_mismatch')
            print('preauthority state verified at sequence {}'.format(body['sequence']))
        elif action == 'verify-admission' and len(argv) == 4:
            directory = _directory_from_cli(directory)
            body = verify_admission(directory, argv[3])
            print('preauthority admission verified as {}'.format(body['admission']))
        else:
            print('Invalid state action.', file=sys.stderr)
            return 2
    except StateError as error:
        print(str(error), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
