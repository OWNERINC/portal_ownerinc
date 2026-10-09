#!/usr/bin/env python3
"""Bounded Docker/PostgreSQL controller for the preauthority-only phase."""

import datetime
import hashlib
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
import secrets
import time


HERE = os.path.dirname(os.path.realpath(__file__))
STATE_PATH = os.path.join(HERE, 'payload-control-state.py')
SPEC = importlib.util.spec_from_file_location('payload_control_state', STATE_PATH)
if SPEC is None or SPEC.loader is None:
    raise SystemExit(2)
STATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STATE)
INVENTORY = STATE.INVENTORY

INVENTORY_FILENAME = 'payload-control-inventory.json'
_INVENTORY_CACHE = None
KNOWN_SERVICES = {
    'postgres', 'cms-postgres', 'api', 'cron', 'nginx', 'cms', 'cms-worker',
    'migrate', 'bootstrap-admin', 'cms-provision', 'cms-control-roles', 'cms-migrate',
    'cms-preauthority-verify',
}
NEWS_TABLES = [
    'news_articles', '_news_articles_v',
    'news_articles_blocks_rich_text', 'news_articles_blocks_heading',
    'news_articles_blocks_paragraph', 'news_articles_blocks_list_items', 'news_articles_blocks_list',
    'news_articles_blocks_image', 'news_articles_blocks_callout',
    'news_articles_blocks_quote', 'news_articles_blocks_profile',
    'news_articles_blocks_divider', 'news_articles_blocks_link',
    'news_articles_blocks_pdf', 'news_articles_blocks_video',
    '_news_articles_v_blocks_rich_text', '_news_articles_v_blocks_heading',
    '_news_articles_v_blocks_paragraph', '_news_articles_v_blocks_list_items', '_news_articles_v_blocks_list',
    '_news_articles_v_blocks_image', '_news_articles_v_blocks_callout',
    '_news_articles_v_blocks_quote', '_news_articles_v_blocks_profile',
    '_news_articles_v_blocks_divider', '_news_articles_v_blocks_link',
    '_news_articles_v_blocks_pdf', '_news_articles_v_blocks_video',
    'news_home', '_news_home_v', 'news_media', 'news_schedules', 'news_audit',
    'payload_jobs', 'payload_jobs_log', 'legacy_news_revisions',
    'legacy_news_revisions_rels', 'news_migration_runs', 'news_migration_items',
]
SESSION_TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
ACTION_SET = {
    'release-preflight', 'close-admission', 'quiescence-proof', 'backup-metadata',
    'restore-preflight', 'prepare-restore', 'portal-restore-intermediate',
    'verify-restored', 'verify-release',
    'rollback-check', 'open-admission',
    'install-retry-check', 'install-receiver-preflight',
    'initialize-isolated', 'install-floor-commit',
}


class ControlError(Exception):
    """Fixed reason only; subprocess output and environment are never echoed."""

    def __init__(self, code, native_catalog_diagnostic=None):
        super().__init__(code)
        self.native_catalog_diagnostic = native_catalog_diagnostic


def fail(code, native_catalog_diagnostic=None):
    raise ControlError(code, native_catalog_diagnostic)


NATIVE_CATALOG_DIAGNOSTIC_STAGES = set('''
connection transaction protocol_identity protocol_migrations protocol_relations protocol_columns
protocol_sequences protocol_enums protocol_constraints protocol_indexes protocol_foreign_keys
protocol_control_columns protocol_control_roles protocol_control_ownership protocol_native_privileges
protocol_inventory protocol_state native_relations native_columns native_indexes native_constraints
native_types news_rows verifier process launch
'''.split())
NATIVE_CATALOG_DIAGNOSTIC_REASONS = set('''
postgres_error preauthority_catalog_verification_failed preauthority_protocol_not_absent
unsafe_admin_target native_migration_ledger_mismatch native_relation_inventory_mismatch
mutation_relation_inventory_mismatch native_column_inventory_mismatch
native_serial_sequence_binding_or_configuration_mismatch native_enum_catalog_mismatch
native_required_constraint_missing native_snapshot_index_missing_or_mismatched
native_snapshot_foreign_key_mismatch native_control_column_types_mismatch native_item_run_id_type_mismatch
control_role_contract_mismatch partial_protocol_installation_manual_recovery_required native_snapshot_invalid
unsafe_preinstallation_control_state diagnostic_installed_protocol_deep_check_skipped
native_constraint_definition_unavailable preauthority_native_relation_inventory_mismatch
preauthority_native_column_inventory_mismatch preauthority_native_index_inventory_mismatch
preauthority_native_constraint_inventory_mismatch preauthority_native_type_inventory_mismatch
process_exit_without_diagnostic invalid_verifier_diagnostic executable_not_found permission_denied
process_launch_failed
'''.split())
NATIVE_CONSTRAINT_DIAGNOSTIC_CATEGORIES = set('''
missing_expected unexpected_observed constraint_identity constraint_metadata
check_definition check_definition_parse primary_key_definition foreign_key_definition
'''.split())
NATIVE_CATALOG_DIAGNOSTIC_PREFIX = 'PREAUTHORITY_CATALOG_DIAGNOSTIC '
NATIVE_CONSTRAINT_DIAGNOSTIC_PREFIX = 'PREAUTHORITY_CONSTRAINT_DIAGNOSTIC '
NATIVE_DIAGNOSTIC_IDENTIFIER = re.compile(r'[a-z_][a-z0-9_]{0,62}')
NATIVE_DIAGNOSTIC_SHA256 = re.compile(r'[0-9a-f]{64}')
def _expected_native_constraint_identities(release):
    try:
        # Bind diagnostic identifiers to the already-selected Payload release,
        # not to the controller checkout: installed controllers live under
        # fixture/runtime while candidate source lives under releases/<name>/cms.
        _release(release, payload=True, owner_root=True)
        schema_path = os.path.join(release, 'cms', 'src', 'migrations', '20261006_181424_z_owner_news_native.json')
        verifier_path = os.path.join(release, 'cms', 'scripts', 'finalize-news-protocol.ts')
        schema = _strict_json(_read_bytes(schema_path, owner_root=True), 'invalid_verifier_diagnostic')
        verifier = _read_bytes(verifier_path, owner_root=True).decode('utf-8')
        checks_block = re.search(r'const NATIVE_REQUIRED_CONSTRAINTS = \[(.*?)\] as const', verifier, re.S)
        if checks_block is None:
            return set()
        check_names = re.findall(r"'([a-z_][a-z0-9_]*)'", checks_block.group(1))
        tables = schema.get('tables')
        if not isinstance(tables, dict) or not check_names or len(check_names) != len(set(check_names)):
            return set()
        identities = set()
        table_names = []
        for table in tables.values():
            if not isinstance(table, dict) or not isinstance(table.get('name'), str):
                return set()
            table_name = table['name']
            if table_name.startswith('public.'):
                table_name = table_name[len('public.'):]
            table_names.append(table_name)
            columns = table.get('columns')
            foreign_keys = table.get('foreignKeys')
            if not isinstance(columns, dict) or not isinstance(foreign_keys, dict):
                return set()
            if any(isinstance(column, dict) and column.get('primaryKey') is True for column in columns.values()):
                identities.add((table_name, table_name + '_pkey'))
            for foreign_key in foreign_keys.values():
                if not isinstance(foreign_key, dict) or not isinstance(foreign_key.get('name'), str):
                    return set()
                identities.add((table_name, foreign_key['name']))
        for name in check_names:
            if name == 'news_migration_seal_complete':
                table_name = 'news_migration_runs'
            else:
                matches = [table for table in table_names
                           if name.startswith(table + '_') or name == table + '_metadata_basis_check']
                if not matches:
                    return set()
                table_name = max(matches, key=len)
            identities.add((table_name, name))
        return identities
    except (ControlError, OSError, UnicodeDecodeError, ValueError, TypeError, KeyError):
        return set()


def _safe_native_constraint_mismatch(value, release=None):
    if not isinstance(value, dict):
        return None
    category = value.get('category')
    table = value.get('table')
    constraint = value.get('constraint')
    expected_count = value.get('expectedCount')
    observed_count = value.get('observedCount')
    expected_hash = value.get('expectedDefinitionSha256')
    observed_hash = value.get('observedDefinitionSha256')
    if not isinstance(category, str) or category not in NATIVE_CONSTRAINT_DIAGNOSTIC_CATEGORIES:
        return None
    if not ((table is None and constraint is None)
            or (isinstance(table, str) and NATIVE_DIAGNOSTIC_IDENTIFIER.fullmatch(table)
                and isinstance(constraint, str) and NATIVE_DIAGNOSTIC_IDENTIFIER.fullmatch(constraint)
                and release is not None
                and (table, constraint) in _expected_native_constraint_identities(release))):
        return None
    if not all(isinstance(count, int) and not isinstance(count, bool) and 0 <= count <= 1_000_000
               for count in (expected_count, observed_count)):
        return None
    if any(value is not None and (not isinstance(value, str) or not NATIVE_DIAGNOSTIC_SHA256.fullmatch(value))
           for value in (expected_hash, observed_hash)):
        return None
    return {
        'category': category, 'table': table, 'constraint': constraint,
        'expectedCount': expected_count, 'observedCount': observed_count,
        'expectedDefinitionSha256': expected_hash, 'observedDefinitionSha256': observed_hash,
    }


def _format_native_constraint_mismatch(diagnostic, release):
    detail = _safe_native_constraint_mismatch(diagnostic, release=release)
    if detail is None:
        return None
    return (
        f"{NATIVE_CONSTRAINT_DIAGNOSTIC_PREFIX}category={detail['category']} "
        f"table={detail['table'] or 'none'} constraint={detail['constraint'] or 'none'} "
        f"expectedCount={detail['expectedCount']} observedCount={detail['observedCount']} "
        f"expectedSha256={detail['expectedDefinitionSha256'] or 'none'} "
        f"observedSha256={detail['observedDefinitionSha256'] or 'none'}"
    )


def _parse_native_catalog_diagnostic(stderr, release=None):
    if isinstance(stderr, bytes):
        stderr = stderr.decode('utf-8', errors='replace')
    if not isinstance(stderr, str):
        return None
    candidates = [line for line in stderr.splitlines() if line.startswith(NATIVE_CATALOG_DIAGNOSTIC_PREFIX)]
    constraint_candidates = [line for line in stderr.splitlines() if line.startswith(NATIVE_CONSTRAINT_DIAGNOSTIC_PREFIX)]
    invalid = {'stage': 'process', 'reason': 'invalid_verifier_diagnostic', 'sqlstate': None}
    if not candidates:
        return invalid if constraint_candidates else None
    if len(candidates) != 1 or len(constraint_candidates) > 1:
        return invalid
    match = re.fullmatch(
        r'PREAUTHORITY_CATALOG_DIAGNOSTIC stage=([a-z_]+) reason=([a-z][a-z0-9_]{0,63}) sqlstate=(none|[0-9A-Z]{5})',
        candidates[0],
    )
    if not match:
        return invalid
    stage, reason, sqlstate = match.groups()
    if stage not in NATIVE_CATALOG_DIAGNOSTIC_STAGES or reason not in NATIVE_CATALOG_DIAGNOSTIC_REASONS:
        return invalid
    if (reason == 'postgres_error') != (sqlstate != 'none'):
        return invalid
    result = {'stage': stage, 'reason': reason, 'sqlstate': None if sqlstate == 'none' else sqlstate}
    if constraint_candidates:
        if stage != 'native_constraints' or reason != 'preauthority_native_constraint_inventory_mismatch' or release is None:
            return invalid
        constraint_match = re.fullmatch(
            r'PREAUTHORITY_CONSTRAINT_DIAGNOSTIC category=([a-z_]+) '
            r'table=([a-z_][a-z0-9_]{0,62}|none) constraint=([a-z_][a-z0-9_]{0,62}|none) '
            r'expectedCount=(0|[1-9][0-9]{0,6}) observedCount=(0|[1-9][0-9]{0,6}) '
            r'expectedSha256=(none|[0-9a-f]{64}) observedSha256=(none|[0-9a-f]{64})',
            constraint_candidates[0],
        )
        if not constraint_match:
            return invalid
        category, table, constraint, expected_count, observed_count, expected_hash, observed_hash = constraint_match.groups()
        detail = _safe_native_constraint_mismatch({
            'category': category, 'table': None if table == 'none' else table,
            'constraint': None if constraint == 'none' else constraint,
            'expectedCount': int(expected_count), 'observedCount': int(observed_count),
            'expectedDefinitionSha256': None if expected_hash == 'none' else expected_hash,
            'observedDefinitionSha256': None if observed_hash == 'none' else observed_hash,
        }, release=release)
        if detail is None or ((table == 'none') != (constraint == 'none')):
            return invalid
        result['constraintMismatch'] = detail
    return result


def _emit_control_error(error, release):
    print(str(error), file=sys.stderr)
    diagnostic = getattr(error, 'native_catalog_diagnostic', None)
    if not isinstance(diagnostic, dict):
        return
    stage = diagnostic.get('stage')
    reason = diagnostic.get('reason')
    sqlstate = diagnostic.get('sqlstate')
    if stage not in NATIVE_CATALOG_DIAGNOSTIC_STAGES or reason not in NATIVE_CATALOG_DIAGNOSTIC_REASONS:
        return
    if sqlstate is not None and (not isinstance(sqlstate, str) or not re.fullmatch(r'[0-9A-Z]{5}', sqlstate)):
        return
    if (reason == 'postgres_error') != (sqlstate is not None):
        return
    print(f'{NATIVE_CATALOG_DIAGNOSTIC_PREFIX}stage={stage} reason={reason} sqlstate={sqlstate or "none"}', file=sys.stderr)
    if reason == 'preauthority_native_constraint_inventory_mismatch':
        constraint_line = _format_native_constraint_mismatch(diagnostic.get('constraintMismatch'), release)
        if constraint_line:
            print(constraint_line, file=sys.stderr)


def _inventory(force=False):
    global _INVENTORY_CACHE
    if _INVENTORY_CACHE is not None and not force:
        return _INVENTORY_CACHE
    path = os.path.join(HERE, INVENTORY_FILENAME)
    try:
        document = INVENTORY.load(path)
        if document['paths']['runtime'] != HERE:
            fail('inventory_runtime_path_mismatch')
        value = {'document': document, 'identity': INVENTORY.identity(document)}
        _INVENTORY_CACHE = value
        return value
    except INVENTORY.InventoryError as error:
        fail(str(error))


def _paths():
    return _inventory()['document']['paths']


def _verify_environment_file(config):
    try:
        INVENTORY.verify_environment_file(config['paths']['environmentFile'], config['environmentFileOwner'])
    except INVENTORY.InventoryError as error:
        fail(str(error))


def _expected_compose_override(release):
    paths = _paths()
    release_override = os.path.join(release, 'compose.ownerinc-vps.yaml')
    if os.path.lexists(release_override):
        _safe_regular(release_override, owner_root=True)
        return release_override
    return paths['composeOverride']


def _load_helpers():
    if not os.path.isfile(STATE_PATH) or os.path.islink(STATE_PATH):
        fail('state_helper_unavailable')
    return STATE


def _safe_regular(path, mode=None, owner_root=False):
    try:
        info = os.lstat(path)
    except OSError:
        fail('required_path_unavailable')
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        fail('unsafe_required_path')
    if os.name != 'nt':
        actual_mode = stat.S_IMODE(info.st_mode)
        if mode is not None and actual_mode != mode:
            fail('unsafe_required_permissions')
        if owner_root and info.st_uid != 0:
            fail('unsafe_required_owner')
    if os.path.realpath(path) != path:
        fail('unsafe_required_path')
    return info


def _read_bytes(path, mode=None, owner_root=False):
    before = _safe_regular(path, mode, owner_root)
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
        try:
            after = os.fstat(descriptor)
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino) or after.st_nlink != 1:
                fail('unsafe_required_path')
            chunks = []
            while True:
                data = os.read(descriptor, 1024 * 1024)
                if not data:
                    break
                chunks.append(data)
            return b''.join(chunks)
        finally:
            os.close(descriptor)
    except ControlError:
        raise
    except OSError:
        fail('required_path_unavailable')


def _strict_json(raw, code):
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=STATE._pairs_without_duplicates,
                           parse_constant=lambda _value: fail(code))
    except ControlError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError):
        fail(code)
    return value


def _manifest(path, owner_root=False):
    raw = _read_bytes(path, owner_root=owner_root)
    try:
        lines = raw.decode('ascii').splitlines()
    except UnicodeDecodeError:
        fail('invalid_release_manifest')
    values = {}
    for line in lines:
        if not line or line.count('=') != 1:
            fail('invalid_release_manifest')
        key, value = line.split('=', 1)
        if key in values or key not in {'API_IMAGE', 'CRON_IMAGE', 'CMS_IMAGE', 'RELEASE_FORMAT'}:
            fail('invalid_release_manifest')
        values[key] = value
    legacy_keys = {'API_IMAGE', 'CRON_IMAGE'}
    payload_keys = legacy_keys | {'CMS_IMAGE', 'RELEASE_FORMAT'}
    if set(values) == legacy_keys:
        payload = False
    elif set(values) == payload_keys and values['RELEASE_FORMAT'] == 'payload-v1':
        payload = True
    else:
        fail('invalid_release_manifest')
    image_names = {'API_IMAGE': 'api', 'CRON_IMAGE': 'cron', 'CMS_IMAGE': 'cms'}
    images = {image_names[name]: values[name] for name in ('API_IMAGE', 'CRON_IMAGE')}
    if payload:
        images[image_names['CMS_IMAGE']] = values['CMS_IMAGE']
    STATE._valid_images(images, payload=payload)
    return images, payload


def _release(path, payload=None, owner_root=False):
    if not isinstance(path, str) or not os.path.isabs(path) or os.path.realpath(path) != path:
        fail('invalid_release_path')
    if os.path.dirname(path) != _paths()['releases']:
        fail('invalid_release_path')
    try:
        info = os.lstat(path)
    except OSError:
        fail('invalid_release_path')
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        fail('invalid_release_path')
    images, actual_payload = _manifest(os.path.join(path, '.image-env'), owner_root=owner_root)
    if payload is not None and actual_payload is not payload:
        fail('unsupported_release_format')
    if actual_payload:
        for name in ('docker-compose.yml', 'docker-compose.payload.yml'):
            _safe_regular(os.path.join(path, name))
    return images, actual_payload


def _lock_and_state(release):
    _load_helpers()
    inventory = _inventory(force=True)
    config = inventory['document']
    lock = os.environ.get('PORTAL_OPERATION_LOCK', '')
    held = os.environ.get('PORTAL_OPERATION_LOCK_HELD', '')
    if lock != config['paths']['lock'] or not lock or lock != held or os.path.realpath(lock) != lock:
        fail('operation_lease_missing')
    if os.environ.get('COMPOSE_PROJECT_NAME') != config['project']:
        fail('unsupported_compose_project')
    paths = config['paths']
    if os.environ.get('COMPOSE_ENV_FILE') != paths['environmentFile'] or \
       os.environ.get('COMPOSE_OVERRIDE') != _expected_compose_override(release) or \
       os.environ.get('PAYLOAD_CONTROL_ENV_FILE') or os.environ.get('PAYLOAD_CONTROL_COMPOSE_OVERRIDE'):
        fail('control_compose_configuration_mismatch')
    if os.environ.get('BACKUP_DIR') and os.environ['BACKUP_DIR'] not in paths['backupRoots']:
        fail('backup_root_override_forbidden')
    if os.environ.get('PRE_RESTORE_BACKUP_DIR') and os.environ['PRE_RESTORE_BACKUP_DIR'] != paths['preRestoreBackupRoot']:
        fail('protection_backup_root_override_forbidden')
    if any(name.startswith('DOCKER_') for name in os.environ):
        fail('docker_endpoint_override_forbidden')
    # Validate the declared operational owner before any journal transition or
    # Docker/DB inspection, including the cold preflight that does not use Compose.
    _verify_environment_file(config)
    _safe_regular(lock, owner_root=True)
    try:
        lock_info = os.stat(lock)
        descriptor_info = os.stat('/proc/{}/fd/9'.format(os.getpid()))
    except OSError:
        fail('operation_lease_missing')
    if (lock_info.st_dev, lock_info.st_ino) != (descriptor_info.st_dev, descriptor_info.st_ino):
        fail('operation_lease_inode_mismatch')
    if os.name != 'nt' and os.geteuid() != 0:
        fail('host_control_requires_root')
    runtime_dir = config['paths']['runtime']
    root = config['paths']['root']
    if runtime_dir != HERE or os.path.dirname(runtime_dir) != root:
        fail('inventory_runtime_path_mismatch')
    return runtime_dir, root


def _sentinel(runtime_dir, expected=True):
    path = _paths()['admissionClosed']
    if not expected:
        if os.path.lexists(path):
            fail('admission_sentinel_stale')
        return path
    info = _safe_regular(path, owner_root=True)
    if os.name != 'nt' and stat.S_IMODE(info.st_mode) != 0o600:
        fail('unsafe_admission_sentinel')
    return path


def _container_inventory():
    config = _inventory()['document']
    project = config['project']
    if os.environ.get('COMPOSE_PROJECT_NAME') != project:
        fail('unsupported_compose_project')
    command = [
        'docker', 'ps', '--all',
        '--format', '{{.ID}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}\t{{.Names}}',
    ]
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, text=True)
    if result.returncode != 0:
        fail('docker_inventory_unavailable')
    containers = []
    for line in result.stdout.splitlines():
        parts = line.split('\t')
        if len(parts) != 5 or not parts[0]:
            fail('unknown_project_container')
        container_project, service, state, name = parts[1:]
        if name.startswith('/') or not name:
            fail('unknown_project_container')
        name_claims_project = name.startswith(project + '-') or name.startswith(project + '_')
        if name_claims_project and container_project != project:
            fail('unknown_project_container')
        relevant = container_project == project
        if not relevant:
            continue
        if service not in KNOWN_SERVICES or state not in ('running', 'exited', 'created', 'restarting', 'paused', 'dead'):
            fail('unknown_project_container')
        containers.append({'id': parts[0], 'service': service, 'state': state, 'name': name})
    return containers


def _all_volume_names():
    result = subprocess.run(['docker', 'volume', 'ls', '--format', '{{.Name}}'],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, text=True)
    if result.returncode != 0:
        fail('docker_volume_inventory_unavailable')
    return [line for line in result.stdout.splitlines() if line]


def _project_volumes():
    project = _inventory()['document']['project']
    if os.environ.get('COMPOSE_PROJECT_NAME') != project:
        fail('unsupported_compose_project')
    all_names = _all_volume_names()
    prefix = project + '_'
    labeled = subprocess.run(
        ['docker', 'volume', 'ls', '--filter', 'label=com.docker.compose.project=' + project, '--format', '{{.Name}}'],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, text=True,
    )
    if labeled.returncode != 0:
        fail('docker_volume_inventory_unavailable')
    project_names = set(line for line in labeled.stdout.splitlines() if line)
    for name in all_names:
        if name.startswith(prefix) and name not in project_names:
            fail('target_volume_inventory_mismatch')
    return sorted(project_names)


def _check_container_shape(cms_status, quiescent=False):
    containers = _container_inventory()
    running = [c for c in containers if c['state'] == 'running']
    for container in containers:
        if container['service'] in ('migrate', 'bootstrap-admin', 'cms-provision', 'cms-control-roles', 'cms-migrate', 'cms-preauthority-verify') and container['state'] == 'running':
            fail('one_shot_container_running')
        if container['service'] == 'cms-worker' and container['state'] == 'running':
            fail('worker_admission_forbidden')
    if quiescent:
        allowed = {'postgres'}
        if cms_status == 'migrated':
            allowed.add('cms-postgres')
        if any(c['service'] not in allowed for c in running):
            fail('writers_not_quiescent')
    else:
        if not any(c['service'] == 'postgres' and c['state'] == 'running' for c in containers):
            fail('portal_database_container_unavailable')
        if cms_status == 'migrated' and not any(c['service'] == 'cms-postgres' and c['state'] == 'running' for c in containers):
            fail('cms_database_container_unavailable')
        if cms_status == 'cold':
            cms_services = {'cms-postgres', 'cms-provision', 'cms-control-roles', 'cms-migrate', 'cms-preauthority-verify', 'cms', 'cms-worker'}
            if any(c['service'] in cms_services for c in containers):
                fail('unexpected_cold_cms_container')
            project = _inventory()['document']['project']
            if any(name.startswith(project + '_cms_') for name in _project_volumes()):
                fail('unexpected_cold_cms_volume')
    return containers


def _container_id(service, running=True):
    containers = [c for c in _container_inventory() if c['service'] == service and (not running or c['state'] == 'running')]
    if len(containers) != 1:
        fail('database_container_ambiguous')
    return containers[0]['id']


def _psql_json(service, sql):
    container = _container_id(service)
    command = [
        'docker', 'exec', '-i', container, 'sh', '-ceu',
        'psql -XqAt -v ON_ERROR_STOP=1 --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"',
    ]
    result = subprocess.run(command, input=sql, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, check=False, text=True)
    if result.returncode != 0 or not result.stdout.strip():
        fail('database_inspection_failed')
    value = _strict_json(result.stdout.strip().encode('utf-8'), 'database_metadata_invalid')
    if not isinstance(value, dict):
        fail('database_metadata_invalid')
    return value


def _database_identity(service, expected_name):
    value = _psql_json(service, """
SELECT json_build_object(
  'systemIdentifier', (SELECT system_identifier::text FROM pg_catalog.pg_control_system()),
  'databaseOid', (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()),
  'databaseName', pg_catalog.current_database()
)::text;
""")
    identity = {
        'systemIdentifier': value.get('systemIdentifier'),
        'databaseOid': value.get('databaseOid'),
        'databaseName': value.get('databaseName'),
    }
    STATE._validate_database_identity(identity)
    if identity['databaseName'] != expected_name:
        fail('database_identity_mismatch')
    return identity


def _validate_portal_session_grants(value, mode):
    """Accept only the old pre-v2 grant floor or the fully provisioned v2 floor.

    The cold release gate runs before the normal, backed-up migration/provision
    stage, so it must recognize the existing legacy state without treating that
    state as sufficient for starting the v2 API. Every later service gate uses
    the strict floor. First-install application recovery may see either complete
    floor, but never a partial grant set.
    """
    legacy = {
        'portalApiSessionPrivileges': [False] * len(SESSION_TABLE_PRIVILEGES),
        'portalCronSessionPrivileges': [False] * len(SESSION_TABLE_PRIVILEGES),
    }
    provisioned = {
        'portalApiSessionPrivileges': [True, True, True, True, False, False, False],
        'portalCronSessionPrivileges': [False] * len(SESSION_TABLE_PRIVILEGES),
    }
    if not isinstance(value, dict) or set(value) != set(legacy) or any(
        not isinstance(value[name], list) or len(value[name]) != len(SESSION_TABLE_PRIVILEGES)
        or any(type(allowed) is not bool for allowed in value[name])
        for name in legacy
    ):
        fail('portal_session_grant_state_invalid')
    observed = {
        'portalApiSessionPrivileges': value['portalApiSessionPrivileges'],
        'portalCronSessionPrivileges': value['portalCronSessionPrivileges'],
    }
    if mode == 'legacy' and observed == legacy:
        return
    if mode == 'strict' and observed == provisioned:
        return
    if mode == 'recovery' and observed in (legacy, provisioned):
        return
    if mode == 'legacy':
        fail('portal_legacy_session_grant_floor_mismatch')
    if mode == 'strict':
        fail('portal_session_v2_grants_unprovisioned_or_mismatched')
    if mode == 'recovery':
        fail('portal_session_grant_state_ambiguous')
    fail('unsupported_portal_grant_mode')


def _portal_state(grant_mode):
    value = _psql_json('postgres', """
SELECT json_build_object(
  'versions', (SELECT COALESCE(json_agg(version ORDER BY version), '[]'::json) FROM public.schema_migrations),
  'authorityRows', (SELECT count(*) FROM public.owner_news_authority),
  'authority', (SELECT json_build_object('mode', mode, 'epoch', epoch)
    FROM public.owner_news_authority WHERE singleton=TRUE),
  'portalApiSessionPrivileges', json_build_array(
    has_table_privilege('portal_api', 'public.cms_editor_sessions', 'SELECT'),
    has_table_privilege('portal_api', 'public.cms_editor_sessions', 'INSERT'),
    has_table_privilege('portal_api', 'public.cms_editor_sessions', 'UPDATE'),
    has_table_privilege('portal_api', 'public.cms_editor_sessions', 'DELETE'),
    has_table_privilege('portal_api', 'public.cms_editor_sessions', 'TRUNCATE'),
    has_table_privilege('portal_api', 'public.cms_editor_sessions', 'REFERENCES'),
    has_table_privilege('portal_api', 'public.cms_editor_sessions', 'TRIGGER')),
  'portalCronSessionPrivileges', json_build_array(
    has_table_privilege('portal_cron', 'public.cms_editor_sessions', 'SELECT'),
    has_table_privilege('portal_cron', 'public.cms_editor_sessions', 'INSERT'),
    has_table_privilege('portal_cron', 'public.cms_editor_sessions', 'UPDATE'),
    has_table_privilege('portal_cron', 'public.cms_editor_sessions', 'DELETE'),
    has_table_privilege('portal_cron', 'public.cms_editor_sessions', 'TRUNCATE'),
    has_table_privilege('portal_cron', 'public.cms_editor_sessions', 'REFERENCES'),
    has_table_privilege('portal_cron', 'public.cms_editor_sessions', 'TRIGGER'))
)::text;
""")
    if value.get('versions') != STATE.PORTAL_MIGRATIONS or value.get('authorityRows') != 1 or \
       value.get('authority') != {'mode': 'legacy', 'epoch': 1}:
        fail('portal_legacy_floor_mismatch')
    grant_values = {name: value.get(name) for name in (
        'portalApiSessionPrivileges', 'portalCronSessionPrivileges',
    )}
    _validate_portal_session_grants(grant_values, grant_mode)
    return value


def _assert_database_quiescent(service):
    value = _psql_json(service, """
SELECT json_build_object(
  'clientBackends', count(*)::integer,
  'activeQueries', count(*) FILTER (WHERE state='active')::integer,
  'openTransactions', count(*) FILTER (WHERE xact_start IS NOT NULL)::integer
)
FROM pg_catalog.pg_stat_activity
WHERE datid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
  AND backend_type='client backend' AND pid <> pg_catalog.pg_backend_pid();
""")
    if not isinstance(value, dict) or set(value) != {'clientBackends', 'activeQueries', 'openTransactions'} or \
       any(not STATE._safe_int(value[name]) for name in ('clientBackends', 'activeQueries', 'openTransactions')) or \
       value != {'clientBackends': 0, 'activeQueries': 0, 'openTransactions': 0}:
        fail('database_sessions_not_quiescent')


def _cms_state():
    union = '\nUNION ALL\n'.join('SELECT count(*) AS row_count FROM public."{}"'.format(name) for name in NEWS_TABLES)
    sql = """
SELECT json_build_object(
  'migrations', (SELECT COALESCE(json_agg(name ORDER BY name), '[]'::json) FROM public.payload_migrations),
  'protocolRelations', (SELECT count(*) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('owner_news_mutation_head','owner_news_mutation_events')),
  'protocolFunctions', (SELECT count(*) FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname::text LIKE 'owner_news_%'),
  'protocolTriggers', (SELECT count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND t.tgname IN ('owner_news_mutation_guard_stmt','owner_news_mutation_capture_row',
      'owner_news_migration_item_binding_guard','owner_news_migration_run_binding_guard')),
  'newsRows', (SELECT COALESCE(sum(row_count),0) FROM (""" + union + """) AS news_row_counts)
)::text;
"""
    value = _psql_json('cms-postgres', sql)
    if value.get('migrations') != STATE.CMS_MIGRATIONS:
        fail('cms_migration_floor_mismatch')
    if value.get('protocolRelations') != 0 or value.get('protocolFunctions') != 0 or value.get('protocolTriggers') != 0:
        fail('unsupported_protocol_present_or_mixed')
    if value.get('newsRows') != 0:
        fail('unexpected_preauthority_news_rows')
    return value


def _data_fingerprint(service):
    rows = _psql_json(service, """
SELECT json_build_object(
  'unsupportedRelations', (SELECT COALESCE(json_agg(json_build_object(
      'schema', n.nspname, 'name', c.relname, 'kind', c.relkind
    ) ORDER BY n.nspname, c.relname, c.relkind), '[]'::json)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND n.nspname NOT LIKE 'pg_temp_%' AND (n.nspname <> 'public' OR c.relkind NOT IN ('r','p','S','i','I'))),
  'tables', (SELECT COALESCE(json_agg(json_build_object('schema', n.nspname, 'name', c.relname)
    ORDER BY n.nspname, c.relname), '[]'::json)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')),
  'sequences', (SELECT COALESCE(json_agg(json_build_object('schema', n.nspname, 'name', c.relname)
    ORDER BY n.nspname, c.relname), '[]'::json)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='S')
)::text;
""")
    tables = rows.get('tables')
    sequences = rows.get('sequences')
    unsupported = rows.get('unsupportedRelations')
    if not isinstance(tables, list) or not isinstance(sequences, list) or not isinstance(unsupported, list):
        fail('database_fingerprint_failed')
    if unsupported:
        fail('database_fingerprint_unsupported_relation')
    relations = []
    for kind, inventory_rows in (('table', tables), ('sequence', sequences)):
        for row in inventory_rows:
            if not isinstance(row, dict) or set(row) != {'schema', 'name'} or row['schema'] != 'public' or \
               not isinstance(row['name'], str) or not re.fullmatch(r'[a-z_][a-z0-9_]*', row['name']):
                fail('database_fingerprint_failed')
            relations.append({'relation': 'public.' + row['name'], 'name': row['name'], 'kind': kind})
    relations.sort(key=lambda row: (row['relation'], row['kind']))
    if len({row['relation'] for row in relations}) != len(relations):
        fail('database_fingerprint_failed')
    if not tables:
        fail('database_fingerprint_failed')
    statements = []
    for entry in relations:
        quoted = '"public"."{}"'.format(entry['name'])
        relation = entry['relation']
        if entry['kind'] == 'table':
            statements.append("SELECT pg_catalog.json_build_array('{}'::text, pg_catalog.to_jsonb(row_value))::text FROM ONLY {} AS row_value".format(relation, quoted))
        else:
            statements.append("SELECT pg_catalog.json_build_array('{}'::text, pg_catalog.json_build_object('last_value', row_value.last_value, 'is_called', row_value.is_called))::text FROM {} AS row_value".format(relation, quoted))
    sql = (' UNION ALL '.join(statements)) + ' ORDER BY 1;\n'
    container = _container_id(service)
    command = ['docker', 'exec', '-i', container, 'sh', '-ceu',
               'psql -XqAt -v ON_ERROR_STOP=1 --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"']
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        assert process.stdin is not None and process.stdout is not None
        process.stdin.write(sql.encode('ascii'))
        process.stdin.close()
        grouped = {}
        for raw_line in process.stdout:
            try:
                row = _strict_json(raw_line.rstrip(b'\r\n'), 'database_fingerprint_failed')
                if not isinstance(row, list) or len(row) != 2:
                    raise ValueError('row')
                relation, row_value = row
            except (UnicodeDecodeError, ValueError, ControlError):
                process.kill()
                fail('database_fingerprint_failed')
            if not isinstance(relation, str) or relation not in [entry['relation'] for entry in relations] or \
               not isinstance(row_value, dict):
                process.kill()
                fail('database_fingerprint_failed')
            record = grouped.get(relation)
            if record is None:
                record = {'count': 0, 'hash': hashlib.sha256()}
                grouped[relation] = record
            record['count'] += 1
            record['hash'].update(STATE.canonical(row_value) + b'\n')
        status = process.wait()
        if status != 0:
            fail('database_fingerprint_failed')
    except ControlError:
        raise
    except (OSError, BrokenPipeError):
        try:
            process.kill()
        except OSError:
            pass
        fail('database_fingerprint_failed')
    inventory = []
    for entry in relations:
        relation = entry['relation']
        record = grouped.get(relation, {'count': 0, 'hash': hashlib.sha256()})
        inventory.append({'relation': relation, 'kind': entry['kind'], 'rowCount': record['count'],
                          'rowContentsSha256': record['hash'].hexdigest()})
    return hashlib.sha256(STATE.canonical(inventory)).hexdigest()


def _volume_info(name):
    by_name = {entry['name']: entry for entry in _inventory()['document']['volumes'].values()}
    entry = by_name.get(name)
    if entry is None:
        fail('target_volume_invalid')
    result = subprocess.run(['docker', 'volume', 'inspect', name], stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, check=False, text=True)
    if result.returncode != 0:
        fail('target_volume_unavailable')
    data = _strict_json(result.stdout.encode('utf-8'), 'target_volume_invalid')
    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
        fail('target_volume_invalid')
    raw = data[0]
    labels = raw.get('Labels') or {}
    project = labels.get('com.docker.compose.project') if isinstance(labels, dict) else None
    compose_key = labels.get('com.docker.compose.volume') if isinstance(labels, dict) else None
    inventory_project = _inventory()['document']['project']
    if raw.get('Name') != name or raw.get('Driver') != 'local' or raw.get('Scope') != 'local' or \
       not isinstance(raw.get('Mountpoint'), str) or not os.path.isabs(raw['Mountpoint']) or \
       project != inventory_project or compose_key != entry['composeKey']:
        fail('target_volume_invalid')
    safe = {
        'name': raw['Name'], 'driver': raw['Driver'], 'mountpoint': raw['Mountpoint'],
        'labels': labels, 'options': raw.get('Options'), 'scope': raw.get('Scope'),
        'createdAt': raw.get('CreatedAt'),
    }
    return {
        'name': raw['Name'], 'driver': raw['Driver'], 'mountpoint': raw['Mountpoint'],
        'fingerprint': hashlib.sha256(STATE.canonical(safe)).hexdigest(),
    }


def _target_binding():
    inventory = _inventory(force=True)
    config = inventory['document']
    existing = _project_volumes()
    expected = sorted(entry['name'] for entry in config['volumes'].values())
    if existing != expected:
        fail('target_volume_inventory_mismatch')
    _verify_inventory_mounts(config)
    portal = _database_identity('postgres', 'portal')
    cms = _database_identity('cms-postgres', 'ownerinc_cms')
    volumes = {
        key: _volume_info(entry['name']) for key, entry in config['volumes'].items()
    }
    return {'inventoryIdentity': inventory['identity'], 'portal': portal, 'cms': cms, 'volumes': volumes}


def _verify_inventory_mounts(config, required_services=None):
    inspected = {}
    for container in _container_inventory():
        result = subprocess.run(
            ['docker', 'inspect', '--format', '{{json .Config.Labels}}\n{{json .Mounts}}', container['id']],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, text=True,
        )
        if result.returncode != 0:
            fail('target_mount_inspection_failed')
        lines = result.stdout.splitlines()
        if len(lines) != 2:
            fail('target_mount_inspection_failed')
        labels = _strict_json(lines[0].encode('utf-8'), 'target_mount_inspection_failed')
        mounts = _strict_json(lines[1].encode('utf-8'), 'target_mount_inspection_failed')
        if not isinstance(labels, dict) or labels.get('com.docker.compose.project') != config['project'] or \
           labels.get('com.docker.compose.service') != container['service'] or not isinstance(mounts, list):
            fail('target_mount_inspection_failed')
        inspected.setdefault(container['service'], []).append(mounts)
    for volume in config['volumes'].values():
        for expected in volume['mounts']:
            instances = inspected.get(expected['service'], [])
            if not instances:
                if expected['required'] and (required_services is None or expected['service'] in required_services):
                    fail('target_service_mount_missing')
                continue
            for mounts in instances:
                matching = [mount for mount in mounts if isinstance(mount, dict) and
                            mount.get('Destination') == expected['destination']]
                if len(matching) != 1 or matching[0].get('Type') != 'volume' or \
                   matching[0].get('Name') != volume['name'] or matching[0].get('RW') is not True:
                    fail('target_service_mount_mismatch')


def _same_target(expected, actual):
    STATE.assert_restore_target_matches(expected, actual)


def _manifest_hashes(directory, payload=True):
    expected = [
        'postgres.dump', 'uploads.tar.gz', 'cms-postgres.dump', 'cms-uploads.tar.gz',
        'release.images', 'operations-proof.json', 'backup.format',
    ] if payload else ['postgres.dump', 'uploads.tar.gz']
    path = os.path.join(directory, 'manifest.sha256')
    raw = _read_bytes(path)
    try:
        lines = raw.decode('ascii').splitlines()
    except UnicodeDecodeError:
        fail('backup_manifest_invalid')
    seen = []
    for line in lines:
        match = re.fullmatch(r'([0-9a-f]{64})  ([a-z.-]+)', line)
        if not match:
            fail('backup_manifest_invalid')
        digest, name = match.groups()
        if name in seen:
            fail('backup_manifest_invalid')
        if _file_hash(os.path.join(directory, name))['sha256'] != digest:
            fail('backup_manifest_mismatch')
        seen.append(name)
    if seen != expected:
        fail('backup_manifest_invalid')
    return seen


def _normalize_tar_name(name):
    if not isinstance(name, str) or '\\' in name or name.startswith('/') or name.startswith('\\'):
        fail('unsafe_storage_archive')
    parts = [part for part in name.split('/') if part not in ('', '.')]
    if not parts or any(part == '..' for part in parts):
        if name in ('.', './'):
            return '.'
        fail('unsafe_storage_archive')
    if any('\x00' in part for part in parts):
        fail('unsafe_storage_archive')
    return '/'.join(parts)


def _tar_tree(stream, compressed=False):
    mode = 'r|gz' if compressed else 'r|'
    try:
        archive = tarfile.open(fileobj=stream, mode=mode)
    except (tarfile.TarError, OSError):
        fail('unsafe_storage_archive')
    entries = {}
    try:
        for member in archive:
            name = _normalize_tar_name(member.name)
            if name in entries:
                fail('unsafe_storage_archive')
            if member.isdir() and member.type == tarfile.DIRTYPE:
                entries[name] = {'type': 'directory', 'mode': member.mode & 0o7777, 'size': 0, 'sha256': None}
                continue
            if not member.isfile() or member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE):
                fail('unsafe_storage_archive')
            file_stream = archive.extractfile(member)
            if file_stream is None:
                fail('unsafe_storage_archive')
            digest = hashlib.sha256()
            size = 0
            while True:
                block = file_stream.read(1024 * 1024)
                if not block:
                    break
                digest.update(block)
                size += len(block)
            if size != member.size:
                fail('unsafe_storage_archive')
            entries[name] = {'type': 'file', 'mode': member.mode & 0o7777, 'size': size, 'sha256': digest.hexdigest()}
    except ControlError:
        raise
    except (tarfile.TarError, OSError, EOFError):
        fail('unsafe_storage_archive')
    finally:
        archive.close()
    return hashlib.sha256(STATE.canonical([{'name': name, **entries[name]} for name in sorted(entries)])).hexdigest()


def _archive_tree(path):
    _safe_regular(path)
    try:
        with open(path, 'rb') as stream:
            return _tar_tree(stream, compressed=True)
    except OSError:
        fail('unsafe_storage_archive')


def _compose_args(release):
    inventory = _inventory()['document']
    project = inventory['project']
    paths = inventory['paths']
    if os.environ.get('COMPOSE_PROJECT_NAME') != project:
        fail('unsupported_compose_project')
    if os.environ.get('PAYLOAD_CONTROL_ENV_FILE') or os.environ.get('PAYLOAD_CONTROL_COMPOSE_OVERRIDE'):
        fail('operator_compose_override_forbidden')
    environment = os.environ.get('COMPOSE_ENV_FILE', '')
    override = os.environ.get('COMPOSE_OVERRIDE', '')
    if environment != paths['environmentFile']:
        fail('control_compose_configuration_mismatch')
    selected_override = _expected_compose_override(release)
    if override != selected_override:
        fail('control_compose_configuration_mismatch')
    override = selected_override
    if not environment or not os.path.isabs(environment) or not override or not os.path.isabs(override):
        fail('control_compose_configuration_missing')
    _verify_environment_file(inventory)
    _safe_regular(override, owner_root=True)
    runtime_dir = paths['runtime']
    payload_override = paths['payloadOverride']
    _safe_regular(payload_override, owner_root=True)
    _safe_regular(os.path.join(release, 'docker-compose.yml'))
    _safe_regular(os.path.join(release, 'docker-compose.payload.yml'))
    return [
        'env', '-i', 'PATH=' + os.environ.get('PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'),
        'HOME=' + os.environ.get('HOME', '/root'), 'docker', 'compose', '--profile', 'notifications', '--env-file', environment,
        '--env-file', os.path.join(release, '.image-env'), '-f', os.path.join(release, 'docker-compose.yml'),
        '-f', os.path.join(release, 'docker-compose.payload.yml'), '-f', override,
        '-f', payload_override, '--project-name', project, '--project-directory', release,
    ]


def _run_catalog_verifier(release):
    args = _compose_args(release) + ['run', '--rm', '--no-deps', '--pull', 'never', '-T', 'cms-preauthority-verify']
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
                                text=True, encoding='utf-8', errors='replace')
    except FileNotFoundError:
        fail('native_catalog_verifier_launch_failed', {
            'stage': 'launch', 'reason': 'executable_not_found', 'sqlstate': None,
        })
    except PermissionError:
        fail('native_catalog_verifier_launch_failed', {
            'stage': 'launch', 'reason': 'permission_denied', 'sqlstate': None,
        })
    except OSError:
        fail('native_catalog_verifier_launch_failed', {
            'stage': 'launch', 'reason': 'process_launch_failed', 'sqlstate': None,
        })
    except Exception:
        fail('native_catalog_verifier_execution_failed', {
            'stage': 'process', 'reason': 'process_exit_without_diagnostic', 'sqlstate': None,
        })
    if result.returncode != 0:
        diagnostic = _parse_native_catalog_diagnostic(result.stderr, release)
        if diagnostic and diagnostic['stage'] != 'process':
            fail('native_catalog_verification_failed', diagnostic)
        fail('native_catalog_verifier_execution_failed', diagnostic or {
            'stage': 'process', 'reason': 'process_exit_without_diagnostic', 'sqlstate': None,
        })
    if _parse_native_catalog_diagnostic(result.stderr, release):
        fail('native_catalog_verifier_execution_failed', {
            'stage': 'process', 'reason': 'invalid_verifier_diagnostic', 'sqlstate': None,
        })
    raw_lines = [line for line in result.stdout.splitlines() if line.strip()]
    if len(raw_lines) != 1:
        fail('native_catalog_verification_invalid')
    value = _strict_json(raw_lines[0].encode('utf-8'), 'native_catalog_verification_invalid')
    expected_keys = {
        'phase', 'protocolStatus', 'coverageApplicability', 'migrationNames',
        'migrationFingerprint', 'nativeCatalogFingerprint', 'newsMutationRows',
        'ready', 'admissionActivated', 'cutoverCertified',
    }
    if not isinstance(value, dict) or set(value) != expected_keys or value.get('phase') != 'preauthority' or \
       value.get('protocolStatus') != 'absent' or value.get('coverageApplicability') != 'not-applicable' or \
       value.get('migrationNames') != STATE.CMS_MIGRATIONS or value.get('migrationFingerprint') != hashlib.sha256(STATE.canonical(STATE.CMS_MIGRATIONS)).hexdigest() or \
       not isinstance(value.get('nativeCatalogFingerprint'), str) or not STATE.HEX_64.fullmatch(value['nativeCatalogFingerprint']) or \
       value.get('newsMutationRows') != 0 or value.get('ready') is not False or \
       value.get('admissionActivated') is not False or value.get('cutoverCertified') is not False:
        fail('native_catalog_verification_invalid')
    return value


def _verify_portal(release, grant_mode):
    _release(release, payload=True)
    return _portal_state(grant_mode)


def _verify_cms(release, catalog=True):
    _database_identity('cms-postgres', 'ownerinc_cms')
    _cms_state()
    return _run_catalog_verifier(release) if catalog else None


def _verify_release_images(release, images):
    _release_images, is_payload = _release(release, payload=True)
    if not is_payload or _release_images != images:
        fail('release_image_manifest_mismatch')
    containers = _check_container_shape('migrated', quiescent=False)
    for service in ('api', 'cron', 'cms'):
        entries = [c for c in containers if c['service'] == service and c['state'] == 'running']
        if len(entries) != 1:
            fail('release_service_not_running')
        result = subprocess.run(['docker', 'inspect', '--format', '{{.Config.Image}}', entries[0]['id']],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, text=True)
        if result.returncode != 0 or result.stdout.strip() != images[service]:
            fail('release_container_image_mismatch')
    # Nginx is allowed to be intentionally stopped during pre-publication smoke.
    return containers


def _file_hash(path):
    _safe_regular(path)
    digest = hashlib.sha256()
    size = 0
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_BINARY', 0))
        with os.fdopen(descriptor, 'rb') as stream:
            opened = os.fstat(stream.fileno())
            if not stat.S_ISREG(opened.st_mode) or opened.st_nlink != 1:
                fail('unsafe_backup_artifact')
            while True:
                block = stream.read(1024 * 1024)
                if not block:
                    break
                digest.update(block)
                size += len(block)
    except OSError:
        fail('backup_artifact_unavailable')
    return {'sha256': digest.hexdigest(), 'size': size}


def _proof_directory(output, expected_name):
    if not output or not os.path.isabs(output) or os.path.basename(output) != expected_name or os.path.realpath(os.path.dirname(output)) != os.path.dirname(output):
        fail('invalid_proof_output_path')
    parent = os.path.dirname(output)
    backup_roots = tuple(_paths()['backupRoots']) + (_paths()['preRestoreBackupRoot'],)
    try:
        if not any(os.path.commonpath((backup_root, parent)) == backup_root and parent != backup_root
                   for backup_root in backup_roots):
            fail('invalid_proof_output_path')
    except ValueError:
        fail('invalid_proof_output_path')
    try:
        parent_info = os.lstat(parent)
    except OSError:
        fail('invalid_proof_output_path')
    if stat.S_ISLNK(parent_info.st_mode) or not stat.S_ISDIR(parent_info.st_mode):
        fail('invalid_proof_output_path')
    if os.name != 'nt' and (parent_info.st_uid != 0 or stat.S_IMODE(parent_info.st_mode) != 0o700):
        fail('invalid_proof_output_path')
    if os.path.lexists(output):
        fail('proof_output_already_exists')
    return parent


def _write_private_proof(path, envelope):
    raw = STATE.canonical(envelope) + b'\n'
    STATE._write_exclusive(path, raw, 0o600)
    return hashlib.sha256(raw).hexdigest()


def _parse_proof(directory, key, payload=True):
    body, digest = STATE.read_proof(directory, key, payload=payload)
    if payload:
        _manifest_hashes(directory, payload=True)
        format_raw = _read_bytes(os.path.join(directory, 'backup.format'))
        if format_raw != b'payload-v1\n':
            fail('backup_format_invalid')
        images, is_payload = _manifest(os.path.join(directory, 'release.images'))
        if not is_payload or images != body['images']:
            fail('backup_image_manifest_mismatch')
        for item in body['artifacts']:
            if item['name'] in ('uploads.tar.gz', 'cms-uploads.tar.gz'):
                _archive_tree(os.path.join(directory, item['name']))
        return body, digest
    _manifest_hashes(directory, payload=False)
    for item in body['artifacts']:
        if item['name'] == 'uploads.tar.gz':
            _archive_tree(os.path.join(directory, item['name']))
    return body, digest


def _validate_pg_archives(directory, services, payload=True):
    names = ['postgres.dump', 'cms-postgres.dump'] if payload else ['postgres.dump']
    for name, service in zip(names, services):
        container = _container_id(service)
        path = os.path.join(directory, name)
        _safe_regular(path)
        try:
            with open(path, 'rb') as stream:
                result = subprocess.run(['docker', 'exec', '-i', container, 'pg_restore', '--list'],
                                        stdin=stream, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL, check=False)
        except OSError:
            fail('database_archive_validation_failed')
        if result.returncode != 0:
            fail('database_archive_validation_failed')


def _proof_body(kind, images, target_images, source, migrations, fingerprints, artifacts):
    body = {
        'schemaVersion': 1,
        'kind': kind,
        'phase': 'preauthority',
        'inventoryIdentity': _inventory()['identity'],
        'authority': {'mode': 'legacy', 'epoch': 1},
        'protocol': {'status': 'absent', 'coverage': 'not-applicable'},
        'images': images,
        'source': source,
        'migrations': migrations,
        'dataFingerprints': fingerprints,
        'artifacts': artifacts,
        'createdAtUtc': datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    }
    if target_images is not None:
        body['targetImages'] = target_images
    return STATE.validate_proof_body(body)


class Runtime:
    def __init__(self, action, release, evidence):
        if action not in ACTION_SET:
            fail('unsupported_operation')
        self.action = action
        self.release_path = release
        self.evidence = evidence or None
        self.inventory = _inventory(force=True)
        self.runtime_dir, self.root = _lock_and_state(release)
        # Ownership and the inherited exact lock inode were verified above.
        # Repair only a unique signed append/head window, never an intent/reset.
        self.key, self.state_dir, self.state, self.state_parent_hash = STATE.read_state(
            self.runtime_dir, repair_head=True, inventory_identity=self.inventory['identity'])
        if self.state['inventoryIdentity'] != self.inventory['identity']:
            fail('state_inventory_identity_mismatch')
        self.closed = self.inventory['document']['paths']['admissionClosed']

    def _admission_closed(self):
        _sentinel(self.runtime_dir, expected=True)
        if self.state['admission'] != 'closed':
            fail('signed_admission_not_closed')

    def _admission_open(self):
        _sentinel(self.runtime_dir, expected=False)
        if self.state['admission'] != 'open':
            fail('signed_admission_not_open')

    def _verify_service_image(self, images, service):
        containers = [c for c in _container_inventory() if c['service'] == service and c['state'] == 'running']
        if len(containers) != 1:
            fail('release_service_not_running')
        result = subprocess.run(['docker', 'inspect', '--format', '{{.Config.Image}}', containers[0]['id']],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, text=True)
        if result.returncode != 0 or result.stdout.strip() != images[service]:
            fail('release_container_image_mismatch')

    def _current_release(self):
        paths = self.inventory['document']['paths']
        releases = paths['releases']
        path = paths['currentRelease']
        if os.path.lexists(path):
            raw = _read_bytes(path)
            try:
                lines = raw.decode('utf-8').splitlines()
            except UnicodeDecodeError:
                fail('current_release_invalid')
            if len(lines) != 1:
                fail('current_release_invalid')
            selected = lines[0]
        else:
            legacy_pointer = os.path.join(self.root, 'current')
            if not os.path.islink(legacy_pointer):
                fail('current_release_invalid')
            selected = os.path.realpath(legacy_pointer)
        if not selected.startswith(releases + os.sep) or os.path.realpath(selected) != selected:
            fail('current_release_invalid')
        _release(selected)
        return selected

    def release_preflight(self):
        if STATE.install_pending(self.state):
            return self.install_retry_check()
        self._admission_open()
        target_images, payload = _release(self.release_path)
        if not payload:
            fail('unsupported_release_format')
        source_path = self.evidence or self._current_release()
        source_images, source_payload = _release(source_path)
        _verify_portal(self.release_path, 'legacy' if self.state['cmsStatus'] == 'cold' else 'strict')
        if self.state['cmsStatus'] == 'cold':
            if source_payload:
                fail('cold_source_not_legacy')
            _check_container_shape('cold', quiescent=False)
            volumes = self.inventory['document']['volumes']
            if _project_volumes() != sorted([volumes['portalPostgres']['name'], volumes['portalUploads']['name']]):
                fail('unexpected_cold_volume_inventory')
            self._verify_service_image(source_images, 'api')
            self._verify_service_image(source_images, 'cron')
        else:
            if not source_payload or source_images != self.state['releaseImages']:
                fail('active_release_state_mismatch')
            _check_container_shape('migrated', quiescent=False)
            _verify_portal(self.release_path, 'strict')
            _verify_cms(source_path, catalog=True)
        if target_images['api'] == '' or target_images['cron'] == '' or target_images['cms'] == '':
            fail('invalid_release_images')
        if self.state['cmsStatus'] == 'cold' or target_images != self.state['releaseImages']:
            def update(body):
                body['plannedReleaseImages'] = target_images
            self.state = STATE.transition(self.runtime_dir, update)
        print('preauthority release preflight passed; authority legacy/1 and worker hold retained')

    def close_admission(self):
        if self.state['admission'] == 'closed':
            if os.path.lexists(self.closed):
                _sentinel(self.runtime_dir, expected=True)
            return
        def update(body):
            body['admission'] = 'closed'
        self.state = STATE.transition(self.runtime_dir, update)
        if os.path.lexists(self.closed):
            _sentinel(self.runtime_dir, expected=True)

    def quiescence_proof(self):
        if STATE.install_pending(self.state) or self.state['cmsStatus'] == 'provisioned':
            fail('release_not_preflighted')
        self._admission_closed()
        _check_container_shape(self.state['cmsStatus'], quiescent=True)
        _verify_portal(self.release_path, 'legacy' if self.state['cmsStatus'] == 'cold' else 'strict')
        _assert_database_quiescent('postgres')
        if self.state['cmsStatus'] == 'migrated':
            cms = _cms_state()
            if self.state['nativeCatalogFingerprint'] is None:
                fail('native_catalog_fingerprint_missing')
            # The shared lease excludes supported DDL/migration one-shots; this
            # direct post-stop ledger/protocol reread avoids starting a verifier
            # container inside the quiescence boundary.
            if cms['migrations'] != STATE.CMS_MIGRATIONS:
                fail('cms_migration_floor_mismatch')
            _assert_database_quiescent('cms-postgres')
        print('preauthority quiescence verified; only databases may remain running')

    def backup_metadata(self):
        if STATE.install_pending(self.state) or self.state['cmsStatus'] == 'provisioned':
            fail('release_not_preflighted')
        if not self.evidence:
            fail('proof_output_required')
        if self.state['admission'] != 'closed':
            fail('backup_requires_closed_admission')
        _check_container_shape(self.state['cmsStatus'], quiescent=True)
        _verify_portal(self.release_path, 'legacy' if self.state['cmsStatus'] == 'cold' else 'strict')
        _assert_database_quiescent('postgres')
        portal_identity = _database_identity('postgres', 'portal')
        portal_data = _data_fingerprint('postgres')
        portal_versions = {'versions': STATE.PORTAL_MIGRATIONS,
                           'fingerprint': hashlib.sha256(STATE.canonical(STATE.PORTAL_MIGRATIONS)).hexdigest()}
        output_name = os.path.basename(self.evidence)
        if self.state['cmsStatus'] == 'cold':
            directory = _proof_directory(self.evidence, 'preauthority-proof.json')
            _manifest_hashes(directory, payload=False)
            _validate_pg_archives(directory, ('postgres',), payload=False)
            source_path = self._current_release()
            source_images, source_payload = _release(source_path, payload=False)
            if source_payload:
                fail('cold_source_not_legacy')
            target_images, target_payload = _release(self.release_path, payload=True)
            if self.state['plannedReleaseImages'] != target_images:
                fail('planned_release_mismatch')
            artifacts = [{'name': name, **_file_hash(os.path.join(directory, name))} for name in STATE.LEGACY_ARTIFACTS]
            fingerprints = {'portalDatabase': portal_data, 'cmsDatabase': None,
                            'portalUploads': _archive_tree(os.path.join(directory, 'uploads.tar.gz')),
                            'cmsUploads': None}
            _assert_database_quiescent('postgres')
            body = _proof_body(
                'preauthority-legacy-source', source_images, target_images,
                {'portal': portal_identity, 'cms': None},
                {'portal': portal_versions, 'cms': None, 'nativeCatalogFingerprint': None},
                fingerprints, artifacts,
            )
            proof_hash = _write_private_proof(self.evidence, STATE.sign_envelope(body, self.key))
            def update(state):
                state['legacySourceProofSha256'] = proof_hash
                state['latestProofSha256'] = proof_hash
            self.state = STATE.transition(self.runtime_dir, update)
        else:
            directory = _proof_directory(self.evidence, 'operations-proof.json')
            images, is_payload = _release(self.release_path, payload=True)
            if not is_payload or images != self.state['releaseImages']:
                fail('active_release_state_mismatch')
            backup_images, backup_payload = _manifest(os.path.join(directory, 'release.images'))
            if not backup_payload or backup_images != images or \
               _read_bytes(os.path.join(directory, 'backup.format')) != b'payload-v1\n':
                fail('backup_image_manifest_mismatch')
            _validate_pg_archives(directory, ('postgres', 'cms-postgres'), payload=True)
            cms_identity = _database_identity('cms-postgres', 'ownerinc_cms')
            cms_state = _cms_state()
            catalog = _run_catalog_verifier(self.release_path)
            _assert_database_quiescent('cms-postgres')
            cms_data = _data_fingerprint('cms-postgres')
            cms_uploads = _archive_tree(os.path.join(directory, 'cms-uploads.tar.gz'))
            artifacts = [{'name': name, **_file_hash(os.path.join(directory, name))} for name in STATE.PAYLOAD_ARTIFACTS]
            fingerprints = {'portalDatabase': portal_data, 'cmsDatabase': cms_data,
                            'portalUploads': _archive_tree(os.path.join(directory, 'uploads.tar.gz')),
                            'cmsUploads': cms_uploads}
            _assert_database_quiescent('postgres')
            _assert_database_quiescent('cms-postgres')
            body = _proof_body(
                'preauthority-four-store-backup', images, None,
                {'portal': portal_identity, 'cms': cms_identity},
                {'portal': portal_versions, 'cms': {'names': cms_state['migrations'],
                   'fingerprint': catalog['migrationFingerprint']},
                 'nativeCatalogFingerprint': catalog['nativeCatalogFingerprint']},
                fingerprints, artifacts,
            )
            proof_hash = _write_private_proof(self.evidence, STATE.sign_envelope(body, self.key))
            def update(state):
                state['latestProofSha256'] = proof_hash
                state['nativeCatalogFingerprint'] = catalog['nativeCatalogFingerprint']
            self.state = STATE.transition(self.runtime_dir, update)
        print('preauthority backup metadata signed; private host key was not included')

    def _validate_source_backup(self):
        if not self.evidence:
            fail('backup_evidence_required')
        directory = self.evidence
        info = os.lstat(directory) if os.path.exists(directory) else None
        if info is None or stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or os.path.realpath(directory) != directory:
            fail('unsafe_backup_directory')
        backup_roots = self.inventory['document']['paths']['backupRoots']
        try:
            if not any(os.path.commonpath((backup_root, directory)) == backup_root and directory != backup_root
                       for backup_root in backup_roots):
                fail('unsafe_backup_directory')
        except ValueError:
            fail('unsafe_backup_directory')
        if os.name != 'nt' and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700):
            fail('unsafe_backup_directory')
        body, proof_hash = _parse_proof(directory, self.key, payload=True)
        allowed_inventory_ids = set(self.inventory['document']['trustedSourceInventoryIdentities'])
        allowed_inventory_ids.add(self.inventory['identity'])
        if body['inventoryIdentity'] not in allowed_inventory_ids:
            fail('backup_inventory_identity_untrusted')
        images, payload = _release(self.release_path, payload=True)
        if not payload or images != body['images']:
            fail('backup_release_mismatch')
        _validate_pg_archives(directory, ('postgres', 'cms-postgres'), payload=True)
        return body, proof_hash

    def restore_preflight(self):
        if os.environ.get('PRE_RESTORE_BACKUP_DIR') != self.inventory['document']['paths']['preRestoreBackupRoot']:
            fail('protection_backup_root_override_forbidden')
        self._admission_open()
        if self.state['cmsStatus'] != 'migrated' or self.state['releaseImages'] is None:
            fail('restore_requires_migrated_preauthority')
        images, payload = _release(self.release_path, payload=True)
        if not payload or images != self.state['releaseImages']:
            fail('restore_release_mismatch')
        body, proof_hash = self._validate_source_backup()
        _check_container_shape('migrated', quiescent=False)
        _verify_portal(self.release_path, 'strict')
        _verify_cms(self.release_path, catalog=True)
        target = _target_binding()
        if body['protocol'] != {'status': 'absent', 'coverage': 'not-applicable'}:
            fail('unsupported_protocol_state')
        target_fingerprints = {
            'portalDatabase': _data_fingerprint('postgres'),
            'cmsDatabase': _data_fingerprint('cms-postgres'),
            'portalUploads': self._storage_tree_fingerprint('api'),
            'cmsUploads': self._storage_tree_fingerprint('cms'),
        }
        intent = {'proofSha256': proof_hash, 'target': target, 'releaseImages': images,
                  'stage': 'reserved',
                  'targetFingerprints': target_fingerprints}
        def update(state):
            state['restoreIntent'] = intent
        self.state = STATE.transition(self.runtime_dir, update)
        print('restore preflight passed; current target identities reserved without comparing them to source')

    def _recheck_restore_boundary(self, grant_mode='strict'):
        current_inventory = _inventory(force=True)
        if current_inventory['identity'] != self.state['inventoryIdentity'] or \
           current_inventory['identity'] != self.inventory['identity']:
            fail('restore_inventory_identity_changed')
        self.inventory = current_inventory
        self._admission_closed()
        intent = self.state.get('restoreIntent')
        if intent is None:
            fail('restore_intent_missing')
        body, proof_hash = self._validate_source_backup()
        if proof_hash != intent['proofSha256']:
            fail('restore_proof_changed')
        if body['images'] != intent['releaseImages']:
            fail('restore_image_binding_mismatch')
        _check_container_shape('migrated', quiescent=True)
        _verify_portal(self.release_path, grant_mode)
        actual = _target_binding()
        _same_target(intent['target'], actual)
        _assert_database_quiescent('postgres')
        _assert_database_quiescent('cms-postgres')
        if intent['stage'] == 'reserved':
            actual_fingerprints = {
                'portalDatabase': _data_fingerprint('postgres'),
                'cmsDatabase': _data_fingerprint('cms-postgres'),
                'portalUploads': self._storage_tree_fingerprint('api'),
                'cmsUploads': self._storage_tree_fingerprint('cms'),
            }
            if STATE.canonical(actual_fingerprints) != STATE.canonical(intent['targetFingerprints']):
                fail('restore_target_content_changed')
        return body

    def prepare_restore(self):
        self._recheck_restore_boundary()
        _validate_pg_archives(self.evidence, ('postgres', 'cms-postgres'), payload=True)
        if self.state['restoreIntent']['stage'] == 'reserved':
            def mark_destructive_boundary(state):
                state['restoreIntent']['stage'] = 'restoring'
            self.state = STATE.transition(self.runtime_dir, mark_destructive_boundary)
        elif self.state['restoreIntent']['stage'] == 'portal_restored':
            # The preceding bounded Portal restore may have removed the v2 grants.
            # This strict boundary proves the normal migration/grant step restored
            # them before the next destructive database operation.
            def mark_portal_grants_restored(state):
                state['restoreIntent']['stage'] = 'portal_grants_restored'
            self.state = STATE.transition(self.runtime_dir, mark_portal_grants_restored)

    def portal_restore_intermediate(self):
        intent = self.state.get('restoreIntent')
        if intent is None or intent['stage'] != 'restoring':
            fail('portal_restore_stage_invalid')
        body = self._recheck_restore_boundary(grant_mode='recovery')
        if _data_fingerprint('postgres') != body['dataFingerprints']['portalDatabase']:
            fail('restored_portal_database_fingerprint_mismatch')
        def mark_portal_restored(state):
            if state['restoreIntent'] is None or state['restoreIntent']['stage'] != 'restoring':
                fail('portal_restore_stage_invalid')
            state['restoreIntent']['stage'] = 'portal_restored'
        self.state = STATE.transition(self.runtime_dir, mark_portal_restored)
        print('Portal restore verified at the bounded grant-recovery floor; strict grant verification is required before further destruction')

    def verify_restored(self):
        if self.state.get('restoreIntent') is None or self.state['restoreIntent']['stage'] != 'portal_grants_restored':
            fail('portal_restore_grants_not_reverified')
        body = self._recheck_restore_boundary()
        catalog = _verify_cms(self.release_path, catalog=True)
        if not isinstance(catalog, dict) or \
           catalog.get('nativeCatalogFingerprint') != body['migrations']['nativeCatalogFingerprint']:
            fail('restored_native_catalog_fingerprint_mismatch')
        if _data_fingerprint('postgres') != body['dataFingerprints']['portalDatabase'] or \
           _data_fingerprint('cms-postgres') != body['dataFingerprints']['cmsDatabase']:
            fail('restored_database_fingerprint_mismatch')
        if self._storage_tree_fingerprint('api') != body['dataFingerprints']['portalUploads'] or \
           self._storage_tree_fingerprint('cms') != body['dataFingerprints']['cmsUploads']:
            fail('restored_storage_fingerprint_mismatch')
        def update(state):
            state['nativeCatalogFingerprint'] = body['migrations']['nativeCatalogFingerprint']
            state['restoreIntent'] = None
        self.state = STATE.transition(self.runtime_dir, update)
        print('restored databases, file trees, native catalog and authority verified')

    def _storage_tree_fingerprint(self, service):
        args = _compose_args(self.release_path) + [
            'run', '--rm', '--no-deps', '--pull', 'never', '-T', '--entrypoint', 'tar',
            service, '-cf', '-', '-C', '/app/uploads' if service == 'api' else '/var/lib/ownerinc-cms/media', '.',
        ]
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            assert process.stdout is not None
            fingerprint = _tar_tree(process.stdout, compressed=False)
            status = process.wait()
        except ControlError:
            process.kill()
            process.wait()
            raise
        except OSError:
            process.kill()
            process.wait()
            fail('restored_storage_inspection_failed')
        if status != 0:
            fail('restored_storage_inspection_failed')
        return fingerprint

    def verify_release(self):
        # An ordinary health/catalog verification is never an install/floor
        # commit, nor permission to discard an unrelated pending restore.
        if STATE.install_pending(self.state) or self.state.get('restoreIntent') is not None or \
           self.state['cmsStatus'] != 'migrated':
            fail('release_not_preflighted')
        images, payload = _release(self.release_path, payload=True)
        if not payload:
            fail('unsupported_release_format')
        _verify_portal(self.release_path, 'strict')
        _verify_release_images(self.release_path, images)
        catalog = _verify_cms(self.release_path, catalog=True)
        if self.state['cmsStatus'] == 'cold':
            if self.state['plannedReleaseImages'] != images:
                fail('planned_release_mismatch')
        elif self.state['releaseImages'] != images and self.state['plannedReleaseImages'] != images:
            fail('release_not_preflighted')
        def update(state):
            state['cmsStatus'] = 'migrated'
            state['releaseImages'] = images
            state['plannedReleaseImages'] = None
            state['nativeCatalogFingerprint'] = catalog['nativeCatalogFingerprint']
        self.state = STATE.transition(self.runtime_dir, update)
        print('preauthority release verified; worker remains explicitly held and authority remains legacy/1')

    def rollback_check(self):
        if STATE.install_pending(self.state) or self.state['cmsStatus'] != 'migrated' or \
           self.state.get('restoreIntent') is not None:
            # No pre-floor downgrade based merely on a boolean cold enum.
            # Fenced recreate/readiness and floor-aware rollback are a next gate.
            fail('rollback_requires_closed_admission')
        target_path = self._current_release()
        target_images, target_payload = _release(target_path)
        if not target_payload or self.state['cmsStatus'] != 'migrated':
            fail('legacy_fallback_forbidden')
        if self.state['admission'] != 'closed':
            fail('rollback_requires_closed_admission')
        if target_images.get('cms') != self.state['releaseImages'].get('cms'):
            fail('rollback_cms_image_floor_mismatch')
        _verify_portal(self.release_path, 'strict')
        _verify_cms(self.release_path, catalog=True)
        _assert_database_quiescent('postgres')
        _assert_database_quiescent('cms-postgres')
        print('rollback target remains within the same preauthority Payload floor')

    def _verify_container_image(self, images, service, running=None):
        containers = [c for c in _container_inventory() if c['service'] == service and (running is None or (c['state'] == 'running') is running)]
        if len(containers) != 1:
            fail('release_service_not_running')
        result = subprocess.run(['docker', 'inspect', '--format', '{{.Config.Image}}', containers[0]['id']],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=False, text=True)
        if result.returncode != 0 or result.stdout.strip() != images[service]:
            fail('release_container_image_mismatch')

    def open_admission(self):
        self._admission_closed()
        if STATE.install_pending(self.state) or self.state['cmsStatus'] != 'migrated':
            fail('admission_open_forbidden')
        images, payload = _release(self.release_path)
        if self.state['cmsStatus'] != 'migrated' or self.state['restoreIntent'] is not None:
            fail('admission_open_forbidden')
        images, payload = _release(self.release_path, payload=True)
        if not payload or images != self.state['releaseImages']:
            fail('release_state_mismatch')
        _verify_portal(self.release_path, 'strict')
        _verify_release_images(self.release_path, images)
        _verify_cms(self.release_path, catalog=True)
        def update(state):
            state['admission'] = 'open'
        self.state = STATE.transition(self.runtime_dir, update)
        print('preauthority writer admission reopened; CMS worker remains held')

    def install_receiver_preflight(self):
        # Permanent fail-closed integration boundary for this reviewed slice.
        # No environment toggle, fabricated receipt or JSON shape enables it.
        # A subsequent reviewed change must wire candidate verifier/register,
        # floor/pointer intent, fenced rollback and the B1 publication barrier.
        fail('release_not_preflighted')

    def _install_target(self, cms_bound):
        config = self.inventory['document']
        names = {'portalPostgres', 'portalUploads'}
        if cms_bound:
            names |= {'cmsPostgres', 'cmsUploads'}
        if _project_volumes() != sorted(config['volumes'][key]['name'] for key in names):
            fail('target_volume_inventory_mismatch')
        _verify_inventory_mounts(config, required_services={'postgres', 'cms-postgres'} if cms_bound else {'postgres'})
        portal = {'database': _database_identity('postgres', 'portal'),
                  'volumes': {key: _volume_info(config['volumes'][key]['name'])
                              for key in ('portalPostgres', 'portalUploads')}}
        cms = None
        if cms_bound:
            cms = {'database': _database_identity('cms-postgres', 'ownerinc_cms'),
                   'volumes': {key: _volume_info(config['volumes'][key]['name'])
                               for key in ('cmsPostgres', 'cmsUploads')}}
        return portal, cms

    def _install_role_verification(self):
        # Explicit read-only verifiers; never fallback to --provision/bootstrap.
        probes = [
            ('cms-control-roles', '--verify-control'),
            ('cms-migrate', '--verify-migrator'),
        ]
        for service, mode in probes:
            args = _compose_args(self.release_path) + [
                '--profile', 'cms-control-roles', 'run', '--rm', '--no-deps', '--pull', 'never', '-T',
                service, 'node', '--import', 'tsx', 'scripts/provision-db.ts', mode,
            ]
            result = subprocess.run(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            if result.returncode != 0:
                fail('native_catalog_verification_failed')

    def _install_upload_fingerprint(self):
        # No candidate entrypoint and no writable mount. Bind the same live
        # Portal tree captured in B0 without adopting/touching CMS storage.
        volume = self.inventory['document']['volumes']['portalUploads']['name']
        args = ['docker', 'run', '--rm', '--read-only', '--network', 'none', '--pull', 'never',
                '--volume', volume + ':/data:ro',
                'nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752',
                'tar', '-cf', '-', '-C', '/data', '.']
        process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            fingerprint = _tar_tree(process.stdout, compressed=False)
            status = process.wait()
        except (ControlError, OSError):
            process.kill()
            process.wait()
            raise
        if status != 0:
            fail('restored_storage_inspection_failed')
        return fingerprint

    def _install_origin_check(self):
        self._admission_closed()
        intent = self.state.get('installIntent')
        if intent is None or self.state.get('restoreIntent') is not None:
            fail('invalid_cold_state')
        binding = intent['binding']
        STATE.validate_state_body(self.state)
        if _inventory(force=True)['identity'] != binding['inventoryIdentity']:
            fail('state_inventory_identity_mismatch')
        _verify_environment_file(self.inventory['document'])
        images, payload = _release(self.release_path, payload=True, owner_root=True)
        if not payload or images != binding['candidate']['images'] or self.release_path != binding['candidateRelease'] or \
           self.inventory['identity'] != binding['inventoryIdentity']:
            fail('planned_release_mismatch')
        lock = self.inventory['document']['paths']['lock']
        _safe_regular(lock, owner_root=True)
        observed_lease = os.stat(lock)
        descriptor_lease = os.stat('/proc/{}/fd/9'.format(os.getpid()))
        if (observed_lease.st_dev, observed_lease.st_ino) != (descriptor_lease.st_dev, descriptor_lease.st_ino) or \
           {'device': observed_lease.st_dev, 'inode': observed_lease.st_ino} != binding['lease']:
            fail('operation_lease_inode_mismatch')
        allowed_pointers = {binding['sourceRelease']}
        if intent['stage'] == 'floor_commit_pending':
            allowed_pointers.add(binding['candidateRelease'])
        if intent['stage'] == 'floor_committed':
            allowed_pointers = {binding['candidateRelease']}
        if self._current_release() not in allowed_pointers:
            # A candidate pointer during a provision-only stage is not success.
            fail('current_release_invalid')
        source_images, source_payload = _release(binding['sourceRelease'], payload=False, owner_root=True)
        if source_payload or source_images != binding['previousImages']:
            fail('preauthority_source_recovery_proof_mismatch')
        if binding.get('bindingVersion') == 2:
            self._initializer_local_daemon()
            _safe_regular(self.inventory['document']['paths']['currentRelease'], mode=0o600, owner_root=True)
            source_raw = _read_bytes(os.path.join(binding['sourceRelease'], '.image-env'), mode=0o600, owner_root=True)
            if hashlib.sha256(source_raw).hexdigest() != binding['candidate']['sourceMaterialSha256']:
                fail('preauthority_source_recovery_proof_mismatch')
            request_raw = _read_bytes(os.path.join(self.runtime_dir, 'payload-initialize-request.json'), mode=0o600, owner_root=True)
            request = STATE.parse_canonical(request_raw, 'invalid_cold_state')
            expected_request = {name: value for name, value in binding['candidate'].items()
                                if name not in ('candidateSha256', 'sourceMaterialSha256')}
            if request != expected_request or hashlib.sha256(STATE.canonical(request)).hexdigest() != binding['candidate']['candidateSha256']:
                fail('planned_release_mismatch')
        directory = binding['b0']['directory']
        if self.evidence != directory:
            fail('preauthority_source_recovery_proof_mismatch')
        info = os.lstat(directory)
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or os.path.realpath(directory) != directory or \
           (os.name != 'nt' and (info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700)) or \
           not any(directory != root and os.path.commonpath((directory, root)) == root
                   for root in self.inventory['document']['paths']['backupRoots']):
            fail('unsafe_backup_directory')
        proof, digest = _parse_proof(directory, self.key, payload=False)
        if digest != binding['b0']['proofSha256'] or proof['inventoryIdentity'] != binding['inventoryIdentity'] or \
           proof['source']['portal'] != binding['portalTarget']['database'] or proof['images'] != source_images or \
           proof['targetImages'] != images:
            fail('preauthority_source_recovery_proof_mismatch')
        return intent, proof, images, source_images

    def install_retry_check(self):
        """Read-only boundary, not authorization to execute the next step."""
        intent, proof, images, source_images = self._install_origin_check()
        binding = intent['binding']
        cms_bound = intent['cmsTarget'] is not None
        # Before the creator has recorded exact physical identities, reject ALL
        # residual CMS resources, even when their names look expected. No adoption.
        _check_container_shape('migrated' if cms_bound else 'cold', quiescent=False)
        containers = _check_container_shape('migrated' if cms_bound else 'cold', quiescent=True)
        self._install_container_images(containers, images, source_images)
        portal_target, cms_target = self._install_target(cms_bound)
        if STATE.canonical(portal_target) != STATE.canonical(binding['portalTarget']) or \
           STATE.canonical(cms_target) != STATE.canonical(intent['cmsTarget']):
            fail('restore_target_changed')
        # Only the complete legacy OR complete v2 floor is recognized while the
        # backed-up regrant may have committed but its signed postmark did not.
        mode = 'legacy' if intent['stage'] == 'reserved' else \
               'recovery' if intent['stage'] == 'portal_grants_pending' else 'strict'
        _verify_portal(self.release_path, mode)
        _assert_database_quiescent('postgres')
        if _data_fingerprint('postgres') != proof['dataFingerprints']['portalDatabase']:
            fail('preauthority_source_database_changed')
        if self._install_upload_fingerprint() != proof['dataFingerprints']['portalUploads']:
            fail('restored_storage_fingerprint_mismatch')
        _assert_database_quiescent('postgres')
        if cms_bound:
            _assert_database_quiescent('cms-postgres')
        if intent['stage'] in ('provisioned', 'floor_commit_pending', 'floor_committed'):
            self._install_role_verification()
            _assert_database_quiescent('cms-postgres')
        print('signed install retry boundary verified; admission remains closed and no next-step permission was issued')
        return intent['stage']

    def _install_container_images(self, containers, images, source_images):
        for container in containers:
            if container['service'] in ('api', 'cron', 'cms', 'migrate', 'cms-provision', 'cms-control-roles', 'cms-migrate', 'cms-preauthority-verify'):
                service = 'api' if container['service'] == 'migrate' else \
                          'cms' if container['service'].startswith('cms') else container['service']
                result = subprocess.run(['docker', 'inspect', '--format', '{{.Config.Image}}', container['id']],
                                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, check=False)
                allowed = {images[service]}
                if service in ('api', 'cron'):
                    allowed.add(source_images[service])
                if result.returncode != 0 or result.stdout.strip() not in allowed:
                    fail('release_container_image_mismatch')
    def _initializer_request(self):
        # Purpose is a closed input type, not a permission/skip flag. Every
        # environment/lease/shape/identity/quiescence check still runs normally.
        config = self.inventory['document']
        if not re.fullmatch(r'payload-preauth-[0-9]+-[0-9]+-[0-9a-f]{10}-(source|target|lease)', config['project']):
            fail('unsupported_compose_project')
        self._initializer_local_daemon()
        path = os.path.join(self.runtime_dir, 'payload-initialize-request.json')
        if self.evidence != path:
            fail('invalid_cold_state')
        _safe_regular(config['paths']['currentRelease'], mode=0o600, owner_root=True)
        raw = _read_bytes(path, mode=0o600, owner_root=True)
        request = STATE.parse_canonical(raw, 'invalid_cold_state')
        STATE._exact_keys(request, {'schemaVersion', 'purpose', 'commit', 'runId', 'runAttempt', 'images'}, 'invalid_cold_state')
        if type(request['schemaVersion']) is not int or request['schemaVersion'] != 1 or \
           request['purpose'] != 'isolated-recovery-producer':
            fail('invalid_cold_state')
        images, payload = _release(self.release_path, payload=True, owner_root=True)
        if not payload or images != request['images'] or os.path.basename(self.release_path) != request['commit']:
            fail('planned_release_mismatch')
        intent = self.state.get('installIntent')
        source = intent['binding']['sourceRelease'] if intent else self._current_release()
        source_images, source_payload = _release(source, payload=False, owner_root=True)
        source_raw = _read_bytes(os.path.join(source, '.image-env'), mode=0o600, owner_root=True)
        source_hash = hashlib.sha256(source_raw).hexdigest()
        if source_payload or os.path.basename(source) != source_hash[:40]:
            fail('preauthority_source_recovery_proof_mismatch')
        candidate = {**request, 'candidateSha256': hashlib.sha256(STATE.canonical(request)).hexdigest(),
                     'sourceMaterialSha256': source_hash}
        # Validate candidate before effects; B0 gets its actual digest only after
        # capture. No placeholder digest is ever signed or used as a receipt.
        STATE.validate_install_candidate(candidate, producer=True)
        lease = os.stat(self.inventory['document']['paths']['lock'])
        template = {'bindingVersion': 2, 'candidate': candidate, 'candidateRelease': self.release_path,
                    'sourceRelease': source, 'previousImages': source_images,
                    # Sort before coordinated timestamp backups; existing
                    # newestBackup selection must never accidentally pick B0.
                    'b0': {'directory': os.path.join(config['paths']['backupRoots'][0], '000-initial-install-b0'),
                           'proofSha256': self.state['legacySourceProofSha256']},
                    'inventoryIdentity': self.inventory['identity'],
                    'lease': {'device': lease.st_dev, 'inode': lease.st_ino},
                    'portalTarget': intent['binding']['portalTarget'] if intent else self._install_target(False)[0]}
        return template

    def _initializer_command(self, args, output=None):
        result = subprocess.run(args, stdout=output if output is not None else subprocess.PIPE,
                                stderr=subprocess.DEVNULL, check=False,
                                **({'pass_fds': (9,)} if os.name != 'nt' else {}))
        if result.returncode != 0:
            fail('native_catalog_verifier_execution_failed')
        return result.stdout if output is None else None

    def _initializer_local_daemon(self):
        # No caller-selected context/endpoint. A remote current context in the
        # root Docker configuration must not turn a disposable producer into a
        # remote installer, even when no DOCKER_* variables were supplied.
        raw = self._initializer_command(['docker', 'context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'])
        if _strict_json(raw, 'docker_endpoint_override_forbidden') != 'unix:///var/run/docker.sock':
            fail('docker_endpoint_override_forbidden')

    def _initializer_compose(self, args, creation=False):
        command = _compose_args(self.release_path)
        if creation:
            command += ['-f', self._creation_overlay()]
        return self._initializer_command(command + args)

    def _capture_initial_b0(self, directory):
        # Refuse any partial/unrecorded prior capture; never overwrite evidence.
        if os.path.lexists(directory):
            fail('proof_output_already_exists')
        # Validate every existing ancestor, including the protected backup root,
        # before creating the not-yet-existing capture directory.
        INVENTORY._verify_ancestry(os.path.join(os.path.dirname(directory), 'capture'), {0}, 'unsafe_inventory_ancestry')
        os.mkdir(directory, 0o700)
        def capture(name, args):
            path = os.path.join(directory, name)
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
            with os.fdopen(os.open(path, flags, 0o600), 'wb') as stream:
                self._initializer_command(args, output=stream)
                stream.flush()
                os.fsync(stream.fileno())
        capture('postgres.dump', ['docker', 'exec', _container_id('postgres'), 'sh', '-ceu',
                                 'pg_dump --format=custom --dbname="$POSTGRES_DB" --username="$POSTGRES_USER"'])
        capture('uploads.tar.gz', ['docker', 'run', '--rm', '--read-only', '--network', 'none', '--pull', 'never',
                '--volume', self.inventory['document']['volumes']['portalUploads']['name'] + ':/data:ro',
                'nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752',
                'tar', '-czf', '-', '-C', '/data', '.'])
        manifest = ''.join(_file_hash(os.path.join(directory, name))['sha256'] + '  ' + name + '\n'
                           for name in STATE.LEGACY_ARTIFACTS)
        STATE._write_exclusive(os.path.join(directory, 'manifest.sha256'), manifest.encode('ascii'), 0o600)
        self.evidence = os.path.join(directory, 'preauthority-proof.json')
        self.backup_metadata()
        self.evidence = directory

    def _creation_overlay(self):
        nonce = self.state['installIntent']['creation']['nonce']
        document = {'services': {service: {'labels': {'io.ownerinc.install-reservation': nonce}}
                                for service in ('cms-postgres', 'cms')}}
        raw = STATE.canonical(document) + b'\n'
        path = os.path.join(self.runtime_dir, 'payload-initialize-compose.json')
        if os.path.lexists(path):
            if _read_bytes(path, mode=0o600, owner_root=True) != raw:
                fail('restore_target_changed')
        else:
            STATE._write_exclusive(path, raw, 0o600)
        return path

    def _creation_volume(self, key):
        intent = self.state['installIntent']
        name = self.inventory['document']['volumes'][key]['name']
        raw = self._initializer_command(['docker', 'volume', 'inspect', name])
        inspected = _strict_json(raw, 'target_volume_invalid')
        if not isinstance(inspected, list) or len(inspected) != 1 or \
           inspected[0].get('Labels', {}).get('io.ownerinc.install-reservation') != intent['creation']['nonce'] or \
           not inspected[0].get('CreatedAt'):
            fail('restore_target_changed')
        return _volume_info(name)

    def _creation_container(self, service):
        intent = self.state['installIntent']
        raw = self._initializer_command(['docker', 'inspect', _container_id(service, running=False)])
        inspected = _strict_json(raw, 'target_mount_inspection_failed')
        if not isinstance(inspected, list) or len(inspected) != 1 or not isinstance(inspected[0], dict):
            fail('restore_target_changed')
        value = inspected[0]
        labels = value.get('Config', {}).get('Labels', {})
        image = value.get('Config', {}).get('Image')
        expected_image = intent['binding']['candidate']['images']['cms'] if service == 'cms' else \
            'postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'
        if not isinstance(value.get('Id'), str) or not STATE.HEX_64.fullmatch(value['Id']) or \
           image != expected_image or labels.get('com.docker.compose.project') != self.inventory['document']['project'] or \
           labels.get('com.docker.compose.service') != service or \
           labels.get('io.ownerinc.install-reservation') != intent['creation']['nonce']:
            fail('restore_target_changed')
        fingerprint = hashlib.sha256(STATE.canonical({
            'id': value['Id'], 'image': image, 'labels': labels,
            'created': value.get('Created'), 'mounts': value.get('Mounts'),
        })).hexdigest()
        return {'id': value['Id'], 'image': image, 'fingerprint': fingerprint}

    def _creation_boundary(self):
        intent, proof, images, source_images = self._install_origin_check()
        _verify_portal(self.release_path, 'strict')
        if _database_identity('postgres', 'portal') != intent['binding']['portalTarget']['database'] or \
           any(_volume_info(self.inventory['document']['volumes'][key]['name']) != value
               for key, value in intent['binding']['portalTarget']['volumes'].items()):
            fail('restore_target_changed')
        _verify_inventory_mounts(self.inventory['document'], required_services={'postgres'})
        if _data_fingerprint('postgres') != proof['dataFingerprints']['portalDatabase'] or \
           self._install_upload_fingerprint() != proof['dataFingerprints']['portalUploads']:
            fail('preauthority_source_database_changed')
        intent = self.state['installIntent']
        receipts = intent['creation']
        config = self.inventory['document']
        expected = {config['volumes'][name]['name'] for name in ('portalPostgres', 'portalUploads')}
        expected |= {value['name'] for value in receipts['volumes'].values()}
        if set(_project_volumes()) != expected:
            fail('restore_target_changed')
        for key in ('cmsPostgres', 'cmsUploads'):
            name = config['volumes'][key]['name']
            if key not in receipts['volumes'] and name in _all_volume_names():
                fail('restore_target_changed')
        containers = _container_inventory()
        for container in containers:
            if container['service'].startswith('cms') and container['service'] not in receipts['containers']:
                fail('restore_target_changed')
            if container['state'] in ('running', 'restarting', 'paused') and container['service'] not in ('postgres', 'cms-postgres'):
                fail('writers_not_quiescent')
        self._install_container_images(containers, images, source_images)
        for key, receipt in receipts['volumes'].items():
            if self._creation_volume(key) != receipt:
                fail('restore_target_changed')
        for service, receipt in receipts['containers'].items():
            if self._creation_container(service) != receipt:
                fail('restore_target_changed')
        _assert_database_quiescent('postgres')

    def _wait_initial_database(self):
        container = _container_id('cms-postgres', running=False)
        for _attempt in range(180):
            result = self._initializer_command(['docker', 'inspect', '--format', '{{.State.Health.Status}}', container])
            if result.strip() == b'healthy':
                return
            time.sleep(1)
        fail('cms_database_container_unavailable')

    def _initialize_resources(self):
        intent = self.state['installIntent']
        binding = intent['binding']
        self._creation_boundary()
        for key in ('cmsPostgres', 'cmsUploads'):
            if key not in self.state['installIntent']['creation']['volumes']:
                entry = self.inventory['document']['volumes'][key]
                self._creation_boundary()
                output = self._initializer_command(['docker', 'volume', 'create', '--driver', 'local',
                    '--label', 'com.docker.compose.project=' + self.inventory['document']['project'],
                    '--label', 'com.docker.compose.volume=' + entry['composeKey'],
                    '--label', 'io.ownerinc.install-reservation=' + intent['creation']['nonce'], entry['name']])
                if output.strip().decode('ascii') != entry['name']:
                    fail('restore_target_changed')
                self.state = STATE.record_install_creation(self.runtime_dir, binding, 'volumes', key, self._creation_volume(key))
        for service in ('cms-postgres', 'cms'):
            if service not in self.state['installIntent']['creation']['containers']:
                self._creation_boundary()
                self._initializer_compose(['create', '--no-build', '--no-deps', '--pull', 'never', service], creation=True)
                self.state = STATE.record_install_creation(self.runtime_dir, binding, 'containers', service, self._creation_container(service))
        self._creation_boundary()
        self._initializer_command(['docker', 'start', self.state['installIntent']['creation']['containers']['cms-postgres']['id']])
        self._wait_initial_database()
        portal, cms = self._install_target(True)
        if portal != binding['portalTarget']:
            fail('restore_target_changed')
        self.state = STATE.advance_install(self.runtime_dir, binding, 'cms_resources_bound', cms)

    def _initial_floor_observations(self):
        self.install_retry_check()
        intent = self.state['installIntent']
        if 'creation' in intent:
            self._creation_boundary()
        for service in ('api', 'cron', 'cms'):
            self._verify_container_image(intent['binding']['candidate']['images'], service, running=False)
        self._install_role_verification()
        self._initializer_compose(['run', '--rm', '--no-deps', '--pull', 'never', '-T', 'cms',
                                  'node', '--import', 'tsx', 'scripts/provision-db.ts', '--verify-runtime'])
        catalog = _verify_cms(self.release_path, catalog=True)
        _assert_database_quiescent('postgres')
        _assert_database_quiescent('cms-postgres')
        return catalog['nativeCatalogFingerprint']

    def install_floor_commit(self):
        self._admission_closed()
        intent = self.state.get('installIntent')
        if intent is None or intent['stage'] not in ('provisioned', 'floor_commit_pending', 'floor_committed'):
            fail('invalid_cold_state')
        binding = intent['binding']
        self.evidence = binding['b0']['directory']
        fingerprint = self._initial_floor_observations()
        if intent['stage'] == 'floor_committed':
            if fingerprint != intent['floor']['nativeCatalogFingerprint'] or \
               self.state['releaseImages'] != binding['candidate']['images'] or \
               self.state['nativeCatalogFingerprint'] != fingerprint:
                fail('release_state_mismatch')
            print('exact signed committed floor reverified; admission remains closed and worker held')
            return
        if intent['stage'] == 'provisioned':
            self.state = STATE.begin_install_floor(self.runtime_dir, binding, fingerprint)
        elif fingerprint != intent['floor']['nativeCatalogFingerprint']:
            fail('native_catalog_fingerprint_missing')
        pointer = self.inventory['document']['paths']['currentRelease']
        _safe_regular(pointer, mode=0o600, owner_root=True)
        # Full prevalidation has completed before any pointer write. The signed
        # pending marker is durable first, and permits ONLY this exact window.
        if self._current_release() == binding['sourceRelease']:
            STATE._atomic_replace(pointer, (binding['candidateRelease'] + '\n').encode('utf-8'), 0o600)
        elif self._current_release() != binding['candidateRelease']:
            fail('current_release_invalid')
        if self._initial_floor_observations() != fingerprint or self._current_release() != binding['candidateRelease']:
            fail('current_release_invalid')
        self.state = STATE.commit_install_floor(self.runtime_dir, binding)
        print('native preauthority floor committed with signed audit; admission closed and worker held')

    def initialize_isolated(self):
        template = self._initializer_request()
        if self.state['schemaVersion'] != 2 or self.state.get('restoreIntent') is not None:
            fail('invalid_cold_state')
        existing = self.state.get('installIntent')
        if existing is not None:
            STATE.assert_install_matches(self.state, template)
        else:
            if self.state['cmsStatus'] != 'cold' or self.state['releaseImages'] is not None or self.state['rollbackTargetImages'] is not None:
                fail('invalid_cold_state')
            if self.state['admission'] == 'open':
                self.evidence = template['sourceRelease']
                self.release_preflight()
                self.close_admission()
                if not os.path.lexists(self.closed):
                    STATE._write_exclusive(self.closed, b'', 0o600)
                self._initializer_compose(['stop', '--timeout', '120', 'nginx', 'api', 'cron', 'cms', 'cms-worker'])
                self.quiescence_proof()
                self._capture_initial_b0(template['b0']['directory'])
            self._admission_closed()
            proof, digest = _parse_proof(template['b0']['directory'], self.key, payload=False)
            template['b0']['proofSha256'] = digest
            if digest != self.state['legacySourceProofSha256'] or digest != self.state['latestProofSha256']:
                fail('preauthority_source_recovery_proof_mismatch')
            self.state = STATE.reserve_install(self.runtime_dir, template, proof, digest,
                creation={'nonce': secrets.token_hex(32), 'volumes': {}, 'containers': {}})
        binding = self.state['installIntent']['binding']
        self.evidence = binding['b0']['directory']
        def advance(stage):
            self.state = STATE.advance_install(self.runtime_dir, binding, stage)
        stage = self.state['installIntent']['stage']
        if stage == 'reserved':
            self.install_retry_check()
            advance('portal_grants_pending')
        if self.state['installIntent']['stage'] == 'portal_grants_pending':
            self.install_retry_check()
            self._initializer_compose(['run', '--rm', '--no-deps', '--pull', 'never', '-T', 'migrate'])
            self._initializer_compose(['run', '--rm', '--no-deps', '--pull', 'never', '-T',
                '-e', 'RUN_MIGRATIONS=false', '-e', 'MIGRATION_ONLY=false', 'migrate', 'node', 'db/verify-migrations.js'])
            _verify_portal(self.release_path, 'strict')
            self.install_retry_check()
            advance('portal_grants_verified')
        if self.state['installIntent']['stage'] == 'portal_grants_verified':
            self.install_retry_check()
            advance('cms_resources_pending')
        if self.state['installIntent']['stage'] == 'cms_resources_pending':
            # Partial resources are acceptable only with their creator receipts;
            # no cold shape bypass or inferred binding on this retry path.
            self._initialize_resources()
        if self.state['installIntent']['stage'] == 'cms_resources_bound':
            self.install_retry_check()
            advance('cms_provision_pending')
        if self.state['installIntent']['stage'] == 'cms_provision_pending':
            self.install_retry_check()
            self._creation_boundary()
            self._initializer_compose(['run', '--rm', '--no-deps', '--pull', 'never', '-T', 'cms-provision'])
            self._initializer_compose(['--profile', 'cms-control-roles', 'run', '--rm', '--no-deps', '--pull', 'never', '-T',
                'cms-control-roles', 'node', '--import', 'tsx', 'scripts/provision-db.ts', '--bootstrap-control'])
            self._initializer_compose(['run', '--rm', '--no-deps', '--pull', 'never', '-T', 'cms-migrate'])
            self._initial_floor_observations()
            advance('provisioned')
        self.install_floor_commit()

    def run(self):
        if self.action == 'initialize-isolated': return self.initialize_isolated()
        if self.action == 'install-floor-commit': return self.install_floor_commit()
        if self.action == 'install-receiver-preflight': return self.install_receiver_preflight()
        if self.action == 'install-retry-check': return self.install_retry_check()
        if self.action == 'release-preflight': return self.release_preflight()
        if self.action == 'close-admission': return self.close_admission()
        if self.action == 'quiescence-proof': return self.quiescence_proof()
        if self.action == 'backup-metadata': return self.backup_metadata()
        if self.action == 'restore-preflight': return self.restore_preflight()
        if self.action == 'prepare-restore': return self.prepare_restore()
        if self.action == 'portal-restore-intermediate': return self.portal_restore_intermediate()
        if self.action == 'verify-restored': return self.verify_restored()
        if self.action == 'verify-release': return self.verify_release()
        if self.action == 'rollback-check': return self.rollback_check()
        if self.action == 'open-admission': return self.open_admission()
        fail('unsupported_operation')


def main(argv):
    if len(argv) != 4:
        print('Invalid Payload control invocation.', file=sys.stderr)
        return 2
    action, release, evidence = argv[1:]
    try:
        if os.name != 'nt':
            os.environ['PATH'] = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
            os.environ['HOME'] = '/root'
        Runtime(action, release, evidence).run()
    except (ControlError, STATE.StateError) as error:
        _emit_control_error(error, release)
        return 2
    except Exception:
        print('Payload control failed closed.', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
