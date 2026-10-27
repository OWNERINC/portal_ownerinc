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
import tempfile
import gzip
from contextlib import contextmanager, ExitStack


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
RUNTIME_CHILD_WAIT_SECONDS = 600
RUNTIME_CHILD_CLEANUP_SECONDS = 3
KNOWN_SERVICES = {
    'postgres', 'cms-postgres', 'api', 'cron', 'nginx', 'cms',
    'migrate', 'bootstrap-admin', 'cms-cluster-bootstrap', 'cms-provision', 'cms-control-roles', 'cms-migrate',
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
    'observe-writers', 'resume-writers', 'resume-readiness-writers',
    'portal-database-target',
}
INITIALIZER_DIAGNOSTIC_PHASES = set('''
runtime_validation request_validation source_preflight close_admission stop_writers quiescence
b0_ancestry b0_database_capture b0_storage_capture b0_manifest b0_sign b0_validate install_reserve
retry_boundary portal_grants_migrate portal_grants_verify portal_grants_postcheck install_advance
resources_boundary volume_create volume_receipt container_create container_receipt database_start
database_readiness database_binding cms_provision cms_control_bootstrap cms_migrate
floor_boundary floor_roles floor_runtime floor_native_catalog floor_pending floor_pointer_swap floor_postcheck floor_commit
private_start private_readiness private_stop b1_capture b1_sign private_final
'''.split())


QUIESCENCE_DIAGNOSTIC_SERVICES = ('api', 'cms', 'postgres', 'cron', 'nginx', 'unknown')


def _quiescence_failure_summary(cms_status, running, allowed):
    counts = {}
    for container in running:
        if container['service'] not in allowed:
            service = container['service'] if container['service'] in QUIESCENCE_DIAGNOSTIC_SERVICES else 'unknown'
            counts[service] = counts.get(service, 0) + 1
    return {'predicate': 'running_service_not_allowed', 'cmsStatus': cms_status,
            'offenders': [{'service': service, 'state': 'running', 'count': min(counts[service], 99)}
                          for service in QUIESCENCE_DIAGNOSTIC_SERVICES if service in counts],
            'truncated': any(count > 99 for count in counts.values())}


def _emit_initializer_diagnostic(runtime, error=None):
    phase = getattr(runtime, 'initializer_phase', 'runtime_validation')
    state = getattr(runtime, 'state', None)
    intent = state.get('installIntent') if isinstance(state, dict) else None
    stage = intent.get('stage') if isinstance(intent, dict) else None
    stage = stage if stage in STATE.INSTALL_TRANSITION_STAGES else 'none'
    phase = phase if isinstance(phase, str) and phase in INITIALIZER_DIAGNOSTIC_PHASES else 'runtime_validation'
    exit_code = getattr(runtime, 'initializer_command_exit', None)
    signal = getattr(runtime, 'initializer_command_signal', None)
    exit_code = exit_code if type(exit_code) is int and 0 <= exit_code <= 255 else 'none'
    signal = signal if type(signal) is int and 1 <= signal <= 64 else 'none'
    retained = 'retained' if getattr(runtime, 'initializer_stderr_retained', False) is True else 'none'
    extra = ''
    summary = getattr(error, 'quiescence_diagnostic', None)
    if (getattr(runtime, 'action', None) == 'initialize-isolated' and str(error) == 'writers_not_quiescent'
            and phase == 'quiescence' and stage == 'none' and exit_code == 'none'
            and signal == 'none' and retained == 'none' and isinstance(summary, dict)
            and summary.get('predicate') == 'running_service_not_allowed'
            and summary.get('cmsStatus') in ('cold', 'migrated') and type(summary.get('truncated')) is bool):
        offenders = summary.get('offenders')
        if (isinstance(offenders, list) and 1 <= len(offenders) <= len(QUIESCENCE_DIAGNOSTIC_SERVICES)
                and all(isinstance(item, dict) and item.get('service') in QUIESCENCE_DIAGNOSTIC_SERVICES
                        and item.get('state') == 'running' and type(item.get('count')) is int
                        and 1 <= item['count'] <= 99 for item in offenders)):
            encoded = ','.join(f"{item['service']}:running:{item['count']}" for item in offenders)
            extra = (f" quiescencePredicate=running_service_not_allowed quiescenceCms={summary['cmsStatus']}"
                     f" quiescenceOffenders={encoded} quiescenceTruncated={str(summary['truncated']).lower()}")
    print(f'PREAUTHORITY_INITIALIZER_DIAGNOSTIC phase={phase} installStage={stage} '
          f'commandExit={exit_code} commandSignal={signal} privateStderr={retained}{extra}', file=sys.stderr)


class ControlError(Exception):
    """Fixed reason only; subprocess output and environment are never echoed."""

    def __init__(self, code, native_catalog_diagnostic=None):
        super().__init__(code)
        self.native_catalog_diagnostic = native_catalog_diagnostic


def fail(code, native_catalog_diagnostic=None):
    raise ControlError(code, native_catalog_diagnostic)


def _kill_and_reap_child(process, failure_code):
    try:
        process.kill()
    except ProcessLookupError:
        pass
    except OSError:
        fail(failure_code)
    try:
        process.wait(timeout=RUNTIME_CHILD_CLEANUP_SECONDS)
    except (subprocess.TimeoutExpired, OSError):
        fail(failure_code)


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
    reason = str(error)
    print(str(error), file=sys.stderr)
    correlation = os.environ.get('PAYLOAD_CORRELATION_ID', 'unassigned')
    if not isinstance(correlation, str) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', correlation):
        correlation = 'unassigned'
    if reason in ('restore_target_changed', 'current_release_invalid', 'release_image_mismatch'):
        category = 'release_container_divergence'
    elif reason.startswith('backup_') or reason.startswith('unsafe_backup'):
        category = 'backup_failure'
    elif reason.startswith('restore_') or reason.startswith('restored_'):
        category = 'restore_failure'
    elif 'database' in reason or 'postgres' in reason:
        category = 'database_unavailable'
    elif 'storage' in reason or 'upload' in reason:
        category = 'storage_unavailable'
    else:
        category = 'control_refused'
    if category != 'control_refused':
        print(json.dumps({'service': 'payload-control', 'event': 'operation_failed', 'category': category,
                          'reason': reason, 'correlationId': correlation}, sort_keys=True, separators=(',', ':')), file=sys.stderr)
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
        environment_database = INVENTORY.portal_database_from_environment(
            config['paths']['environmentFile'], config['environmentFileOwner'])
    except INVENTORY.InventoryError as error:
        fail(str(error))
    inventory_database = _portal_database(config)
    if environment_database != inventory_database:
        fail('portal_database_configuration_mismatch')
    return inventory_database


def _portal_database(config=None):
    if config is None:
        config = _inventory()['document']
    try:
        value = config['databaseCluster']['databases']['portal']['name']
    except (KeyError, TypeError):
        fail('invalid_inventory_database_cluster')
    if not isinstance(value, str) or not INVENTORY.DATABASE_IDENTIFIER.fullmatch(value) or value == 'ownerinc_cms':
        fail('invalid_inventory_database_cluster')
    return value


def production_authorization_allows_resume(candidate, intent, now=None):
    """Expiry gates reservation, not an exact signed continuation."""
    STATE.validate_install_candidate(candidate)
    authorization = candidate.get('authorization')
    if authorization is None:
        return False
    current = int(time.time()) if now is None else now
    if type(current) is not int:
        return False
    if current < int(authorization['expiresAt']):
        return True
    return isinstance(intent, dict) and intent.get('authorizationFreshAtReservation') is True and \
        isinstance(intent.get('binding'), dict) and \
        STATE.canonical(intent['binding'].get('candidate')) == STATE.canonical(candidate)


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
        if container['service'] == 'cms-worker':
            fail('worker_admission_forbidden')
        if container['service'] in ('migrate', 'bootstrap-admin', 'cms-cluster-bootstrap', 'cms-provision', 'cms-control-roles', 'cms-migrate', 'cms-preauthority-verify') and container['state'] == 'running':
            fail('one_shot_container_running')
    if quiescent:
        allowed = {'postgres'}
        if any(c['service'] not in allowed for c in running):
            error = ControlError('writers_not_quiescent')
            # Same observation as the failed predicate: never issue a second
            # inventory/inspect that could describe a different container set.
            error.quiescence_diagnostic = _quiescence_failure_summary(cms_status, running, allowed)
            raise error
    else:
        if not any(c['service'] == 'postgres' and c['state'] == 'running' for c in containers):
            fail('portal_database_container_unavailable')
        if cms_status == 'migrated' and not any(c['service'] == 'postgres' and c['state'] == 'running' for c in containers):
            fail('cms_database_container_unavailable')
        if cms_status == 'cold':
            cms_services = {'cms-postgres', 'cms-cluster-bootstrap', 'cms-provision', 'cms-control-roles', 'cms-migrate', 'cms-preauthority-verify', 'cms'}
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


def _psql_json(service, sql, database=None):
    container = _container_id(service)
    command = [
        'docker', 'exec', '-i', container, 'sh', '-ceu',
        'psql -XqAt -v ON_ERROR_STOP=1 --dbname="${1:-$POSTGRES_DB}" --username="${2:-$POSTGRES_USER}"',
    ]
    if database is not None:
        portal_database = _portal_database()
        if database not in (portal_database, 'ownerinc_cms'):
            fail('database_identity_mismatch')
        command += ['database-target', database, 'cms_admin' if database == 'ownerinc_cms' else 'portal_admin']
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
""", expected_name)
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


LEGACY_SECURITY_MAX_RECORDS = 20000
LEGACY_SECURITY_MAX_BYTES = 4 * 1024 ** 2
LEGACY_SECURITY_ROLES = ('portal_api', 'portal_cron')
LEGACY_SECURITY_PRIVILEGES = {
    'database': ('CONNECT', 'CREATE', 'TEMPORARY'), 'schema': ('USAGE', 'CREATE'),
    'table': tuple(SESSION_TABLE_PRIVILEGES), 'column': ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES'),
    'sequence': ('USAGE', 'SELECT', 'UPDATE'), 'routine': ('EXECUTE',), 'type': ('USAGE',),
}


def portal_legacy_security_observation_sql():
    """Fixed PG16 catalog query only. NOT registered or executed by this module.

    Future authenticated transport must enforce a 30s process/4MiB byte bound.
    Catalog rows are capped before JSON aggregation; overflow never truncates.
    """
    return r"""
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = pg_catalog;
SET LOCAL statement_timeout = '20s';
SET LOCAL lock_timeout = '2s';
SET LOCAL timezone = 'UTC';
SET LOCAL datestyle = 'ISO, YMD';
WITH
scope AS MATERIALIZED (SELECT pg_catalog.current_setting('server_version_num')::integer/10000=16 AS ok),
db AS MATERIALIZED (SELECT oid, datname, datdba, datacl FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()),
roles AS MATERIALIZED (SELECT oid, rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
  rolinherit, rolreplication, rolbypassrls, rolconnlimit, rolvaliduntil
  FROM pg_catalog.pg_roles WHERE rolname IN ('portal_api','portal_cron')),
objects AS (
 SELECT 'database'::text AS object_type, ''::text AS schema, d.datname::text AS name, ''::text AS subname,
 d.datdba AS owner, d.datacl AS acl, 'd'::"char" AS acl_kind, d.oid, 0::integer AS subid, false AS unsupported
 FROM db d
 UNION ALL SELECT 'schema','',n.nspname,'',n.nspowner,n.nspacl,'n',n.oid,0,false
 FROM pg_catalog.pg_namespace n WHERE n.nspname='public'
 UNION ALL SELECT CASE WHEN c.relkind='S' THEN 'sequence' ELSE 'table' END,n.nspname,c.relname,'',
 c.relowner,c.relacl,CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.oid,0,
 c.relkind NOT IN ('r','S') OR c.relrowsecurity OR c.relforcerowsecurity
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite w WHERE w.ev_class=c.oid AND w.rulename<>'_RETURN')
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind NOT IN ('i','I','t')
 UNION ALL SELECT 'column',n.nspname,c.relname,a.attname,c.relowner,a.attacl,'c',c.oid,a.attnum,false
 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
 JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'routine',n.nspname,p.proname,pg_catalog.pg_get_function_identity_arguments(p.oid),
 p.proowner,p.proacl,'f',p.oid,0,p.prosecdef OR p.proconfig IS NOT NULL OR p.prokind NOT IN ('f','p')
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
 UNION ALL SELECT 'type',n.nspname,t.typname,'',t.typowner,t.typacl,'T',t.oid,0,false
 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
 UNION ALL SELECT 'default',COALESCE(n.nspname,''),pg_catalog.pg_get_userbyid(a.defaclrole),a.defaclobjtype::text,
 a.defaclrole,a.defaclacl,a.defaclobjtype,a.oid,0,false
 FROM pg_catalog.pg_default_acl a LEFT JOIN pg_catalog.pg_namespace n ON n.oid=a.defaclnamespace
 WHERE a.defaclnamespace=0 OR n.nspname='public'
),
bounded_objects AS MATERIALIZED (SELECT * FROM objects WHERE (SELECT ok FROM scope) LIMIT 20001),
object_budget AS MATERIALIZED (SELECT count(*)<=20000 AS ok FROM bounded_objects),
privileges(object_type,privilege) AS (VALUES
 ('database','CONNECT'),('database','CREATE'),('database','TEMPORARY'),('schema','USAGE'),('schema','CREATE'),
 ('table','SELECT'),('table','INSERT'),('table','UPDATE'),('table','DELETE'),('table','TRUNCATE'),('table','REFERENCES'),('table','TRIGGER'),
 ('column','SELECT'),('column','INSERT'),('column','UPDATE'),('column','REFERENCES'),
 ('sequence','USAGE'),('sequence','SELECT'),('sequence','UPDATE'),('routine','EXECUTE'),('type','USAGE')),
effective AS (
 SELECT o.*,r.oid AS role_oid,r.rolname,v.privilege FROM bounded_objects o
 CROSS JOIN roles r JOIN privileges v ON v.object_type=o.object_type
 WHERE (SELECT ok FROM object_budget)
),
records AS (
 SELECT pg_catalog.jsonb_build_object('kind','role','name',r.rolname,'login',r.rolcanlogin,'superuser',r.rolsuper,
 'createDatabase',r.rolcreatedb,'createRole',r.rolcreaterole,'inherit',r.rolinherit,'replication',r.rolreplication,
 'bypassRls',r.rolbypassrls,'connectionLimit',r.rolconnlimit,'validUntil',r.rolvaliduntil::text) AS record FROM roles r
 UNION ALL SELECT pg_catalog.jsonb_build_object('kind','membership','role',pg_catalog.pg_get_userbyid(m.roleid),
 'member',pg_catalog.pg_get_userbyid(m.member),'grantor',pg_catalog.pg_get_userbyid(m.grantor),
 'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)
 FROM pg_catalog.pg_auth_members m WHERE m.roleid IN (SELECT oid FROM roles) OR m.member IN (SELECT oid FROM roles)
 UNION ALL SELECT pg_catalog.jsonb_build_object('kind','settings','role',r.rolname,'present',
 EXISTS(SELECT 1 FROM pg_catalog.pg_db_role_setting x WHERE x.setrole=r.oid OR
 (x.setrole=0 AND x.setdatabase=(SELECT oid FROM db)))) FROM roles r
 UNION ALL SELECT pg_catalog.jsonb_build_object('kind','object','objectType',o.object_type,'schema',o.schema,
 'name',o.name,'subname',o.subname,'owner',pg_catalog.pg_get_userbyid(o.owner),'aclNull',o.acl IS NULL,
 'unsupported',o.unsupported) FROM bounded_objects o
 UNION ALL SELECT pg_catalog.jsonb_build_object('kind','acl','objectType',o.object_type,'schema',o.schema,
 'name',o.name,'subname',o.subname,'grantor',pg_catalog.pg_get_userbyid(a.grantor),
 'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
 'privilege',a.privilege_type,'grantable',a.is_grantable)
 FROM bounded_objects o CROSS JOIN LATERAL pg_catalog.aclexplode(
 COALESCE(o.acl,pg_catalog.acldefault(o.acl_kind,o.owner))) a WHERE (SELECT ok FROM object_budget)
 UNION ALL SELECT pg_catalog.jsonb_build_object('kind','effective','objectType',o.object_type,'schema',o.schema,
 'name',o.name,'subname',o.subname,'role',o.rolname,'privilege',o.privilege,
 'allowed',CASE o.object_type
 WHEN 'database' THEN pg_catalog.has_database_privilege(o.role_oid,o.oid,o.privilege)
 WHEN 'schema' THEN pg_catalog.has_schema_privilege(o.role_oid,o.oid,o.privilege)
 WHEN 'table' THEN pg_catalog.has_table_privilege(o.role_oid,o.oid,o.privilege)
 WHEN 'column' THEN pg_catalog.has_column_privilege(o.role_oid,o.oid,o.subid::smallint,o.privilege)
 WHEN 'sequence' THEN pg_catalog.has_sequence_privilege(o.role_oid,o.oid,o.privilege)
 WHEN 'routine' THEN pg_catalog.has_function_privilege(o.role_oid,o.oid,o.privilege)
 WHEN 'type' THEN pg_catalog.has_type_privilege(o.role_oid,o.oid,o.privilege) END,
 'grantable',CASE o.object_type
 WHEN 'database' THEN pg_catalog.has_database_privilege(o.role_oid,o.oid,o.privilege||' WITH GRANT OPTION')
 WHEN 'schema' THEN pg_catalog.has_schema_privilege(o.role_oid,o.oid,o.privilege||' WITH GRANT OPTION')
 WHEN 'table' THEN pg_catalog.has_table_privilege(o.role_oid,o.oid,o.privilege||' WITH GRANT OPTION')
 WHEN 'column' THEN pg_catalog.has_column_privilege(o.role_oid,o.oid,o.subid::smallint,o.privilege||' WITH GRANT OPTION')
 WHEN 'sequence' THEN pg_catalog.has_sequence_privilege(o.role_oid,o.oid,o.privilege||' WITH GRANT OPTION')
 WHEN 'routine' THEN pg_catalog.has_function_privilege(o.role_oid,o.oid,o.privilege||' WITH GRANT OPTION')
 WHEN 'type' THEN pg_catalog.has_type_privilege(o.role_oid,o.oid,o.privilege||' WITH GRANT OPTION') END) FROM effective o
 UNION ALL SELECT pg_catalog.jsonb_build_object('kind','sequenceDependency','schema',n.nspname,'name',c.relname,
 'tableSchema',tn.nspname,'table',tc.relname,'column',a.attname,'dependency',d.deptype::text)
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::pg_catalog.regclass AND d.objid=c.oid
 AND d.refclassid='pg_catalog.pg_class'::pg_catalog.regclass AND d.deptype IN ('a','i')
 JOIN pg_catalog.pg_class tc ON tc.oid=d.refobjid JOIN pg_catalog.pg_namespace tn ON tn.oid=tc.relnamespace
 JOIN pg_catalog.pg_attribute a ON a.attrelid=tc.oid AND a.attnum=d.refobjsubid
 WHERE n.nspname='public' AND c.relkind='S'
 -- PG16 shared dependency kinds o/a/i/r reference roles (t references tablespaces).
 -- Only an existence flag is returned; no other database is queried.
 UNION ALL SELECT pg_catalog.jsonb_build_object('kind','guard','name','externalRoleDependencies','present',
 EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.deptype IN ('o','a','i','r')
 AND d.refobjid IN (SELECT oid FROM roles) AND NOT
 (d.dbid=(SELECT oid FROM db) OR (d.dbid=0 AND d.classid='pg_catalog.pg_database'::pg_catalog.regclass AND d.objid=(SELECT oid FROM db)))))
 UNION ALL SELECT pg_catalog.jsonb_build_object('kind','guard','name','outsidePublicObjects','present',
 EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT IN ('public','pg_catalog','information_schema')
 AND n.nspname !~ '^pg_(toast|temp)(_|$)'))
 UNION ALL SELECT pg_catalog.jsonb_build_object('kind','guard','name','largeObjects','present',
 EXISTS(SELECT 1 FROM pg_catalog.pg_largeobject_metadata))
),
bounded_records AS MATERIALIZED (SELECT record FROM records WHERE (SELECT ok FROM scope) LIMIT 20001),
budget AS MATERIALIZED (SELECT count(*) AS count, COALESCE(sum(pg_catalog.octet_length(record::text)),0) AS bytes FROM bounded_records),
gate AS MATERIALIZED (SELECT (SELECT ok FROM object_budget) AND count<=20000 AND bytes+count*2+1024<=4194304
 AND (SELECT ok FROM scope) AS ok FROM budget),
accepted AS MATERIALIZED (SELECT b.record FROM bounded_records b WHERE (SELECT ok FROM gate)),
document AS (SELECT pg_catalog.jsonb_build_object('schemaVersion',1,'kind','portal-legacy-security-observation-v1',
 'serverMajor',16,'database',pg_catalog.jsonb_build_object('systemIdentifier',
 (SELECT system_identifier::text FROM pg_catalog.pg_control_system()),'databaseOid',(SELECT oid::text FROM db),
 'databaseName',pg_catalog.current_database()),'records',COALESCE(pg_catalog.jsonb_agg(record),'[]'::pg_catalog.jsonb)) AS value FROM accepted)
SELECT CASE WHEN (SELECT ok FROM gate) THEN value ELSE
 pg_catalog.jsonb_build_object('kind','portal-legacy-security-observation-refused') END::text FROM document;
ROLLBACK;
"""


def _legacy_security_require(condition):
    if not condition:
        fail('legacy_security_observation_invalid')


def validate_portal_legacy_security_observation(observation, expected_database='portal'):
    """Pure bounded validator/canonicalizer. No catalog execution or authority."""
    if isinstance(observation, bytes):
        _legacy_security_require(len(observation) <= LEGACY_SECURITY_MAX_BYTES)
        observation = _strict_json(observation, 'legacy_security_observation_invalid')
    _legacy_security_require(isinstance(observation, dict) and set(observation) ==
        {'schemaVersion', 'kind', 'serverMajor', 'database', 'records'})
    _legacy_security_require(type(observation['schemaVersion']) is int and observation['schemaVersion'] == 1 and
        type(observation['serverMajor']) is int and observation['serverMajor'] == 16 and
        observation['kind'] == 'portal-legacy-security-observation-v1')
    STATE._validate_database_identity(observation['database'])
    _legacy_security_require(isinstance(expected_database, str) and
                             INVENTORY.DATABASE_IDENTIFIER.fullmatch(expected_database) is not None and
                             expected_database != 'ownerinc_cms' and
                             observation['database']['databaseName'] == expected_database)
    records = observation['records']
    _legacy_security_require(isinstance(records, list) and len(records) <= LEGACY_SECURITY_MAX_RECORDS)
    shapes = {
        'role': ('name login superuser createDatabase createRole inherit replication bypassRls connectionLimit validUntil',
                 'login superuser createDatabase createRole inherit replication bypassRls'),
        'membership': ('role member grantor admin inherit set', 'admin inherit set'),
        'settings': ('role present', 'present'),
        'object': ('objectType schema name subname owner aclNull unsupported', 'aclNull unsupported'),
        'acl': ('objectType schema name subname grantor grantee privilege grantable', 'grantable'),
        'effective': ('objectType schema name subname role privilege allowed grantable', 'allowed grantable'),
        'sequenceDependency': ('schema name tableSchema table column dependency', ''),
        'guard': ('name present', 'present'),
    }
    identity_fields = {
        'role': ('name',), 'membership': ('role', 'member', 'grantor'), 'settings': ('role',),
        'object': ('objectType', 'schema', 'name', 'subname'),
        'acl': ('objectType', 'schema', 'name', 'subname', 'grantor', 'grantee', 'privilege'),
        'effective': ('objectType', 'schema', 'name', 'subname', 'role', 'privilege'),
        'sequenceDependency': ('schema', 'name'), 'guard': ('name',),
    }
    seen, objects, effective, roles, settings, guards, dependencies = set(), {}, set(), set(), set(), set(), set()
    total_bytes = 0
    for row in records:
        _legacy_security_require(isinstance(row, dict) and isinstance(row.get('kind'), str) and row['kind'] in shapes)
        kind = row['kind']
        names, boolean_names = (set(part.split()) for part in shapes[kind])
        _legacy_security_require(set(row) == names | {'kind'})
        for name in names:
            value = row[name]
            if name in boolean_names:
                _legacy_security_require(type(value) is bool)
            elif kind == 'role' and name == 'connectionLimit':
                _legacy_security_require(type(value) is int and -1 <= value <= 2147483647)
            elif kind == 'role' and name == 'validUntil':
                _legacy_security_require(value is None or isinstance(value, str) and
                    re.fullmatch(r'(?:infinity|-infinity|[0-9T :.+-]{10,64})', value) is not None)
            else:
                _legacy_security_require(isinstance(value, str) and len(value.encode('utf-8')) <= 8192 and
                                         not any(token in value for token in ('\0', '\n', '\r', '\t', '://')))
                if name not in ('schema', 'subname'):
                    _legacy_security_require(bool(value))
        identity = (kind,) + tuple(row[name] for name in identity_fields[kind])
        _legacy_security_require(identity not in seen)
        seen.add(identity)
        total_bytes += len(STATE.canonical(row)) + 1
        _legacy_security_require(total_bytes <= LEGACY_SECURITY_MAX_BYTES)
        if kind == 'role':
            _legacy_security_require(row['name'] in LEGACY_SECURITY_ROLES)
            roles.add(row['name'])
        elif kind == 'settings':
            _legacy_security_require(row['role'] in LEGACY_SECURITY_ROLES)
            settings.add(row['role'])
        elif kind == 'membership':
            _legacy_security_require(row['role'] in LEGACY_SECURITY_ROLES or row['member'] in LEGACY_SECURITY_ROLES)
        elif kind == 'guard':
            _legacy_security_require(row['name'] in ('externalRoleDependencies', 'outsidePublicObjects', 'largeObjects'))
            guards.add(row['name'])
        elif kind in ('object', 'acl', 'effective'):
            object_key = tuple(row[name] for name in ('objectType', 'schema', 'name', 'subname'))
            _legacy_security_require(row['objectType'] in set(LEGACY_SECURITY_PRIVILEGES) | {'default'})
            _legacy_security_require(row['schema'] in ('', 'public') and bool(row['name']))
            if row['objectType'] in ('database', 'schema'):
                _legacy_security_require(row['schema'] == row['subname'] == '' and
                    row['name'] == (expected_database if row['objectType'] == 'database' else 'public'))
            elif row['objectType'] == 'default':
                _legacy_security_require(row['subname'] in ('r', 'S', 'f', 'T', 'n', 'L'))
            else:
                _legacy_security_require(row['schema'] == 'public' and
                    (row['subname'] == '' if row['objectType'] in ('table', 'sequence', 'type') else True))
                if row['objectType'] == 'column':
                    _legacy_security_require(bool(row['subname']))
            if kind == 'object':
                if row['objectType'] == 'default':
                    _legacy_security_require(row['name'] == row['owner'] and not row['aclNull'])
                objects[object_key] = row
            elif kind == 'effective':
                # PG16 owners can retain implicit grant options after ordinary
                # privileges are revoked. Observe both booleans independently;
                # ownership/grantability remain separate recovery blockers.
                _legacy_security_require(row['role'] in LEGACY_SECURITY_ROLES and
                    row['privilege'] in LEGACY_SECURITY_PRIVILEGES.get(row['objectType'], ()))
                effective.add(object_key + (row['role'], row['privilege']))
            else:
                privileges = LEGACY_SECURITY_PRIVILEGES.get(row['objectType'])
                if row['objectType'] == 'default':
                    privileges = {'r': LEGACY_SECURITY_PRIVILEGES['table'], 'S': LEGACY_SECURITY_PRIVILEGES['sequence'],
                                  'f': ('EXECUTE',), 'T': ('USAGE',), 'n': ('USAGE', 'CREATE'), 'L': ('SELECT', 'UPDATE')}[row['subname']]
                _legacy_security_require(row['privilege'] in privileges)
        elif kind == 'sequenceDependency':
            _legacy_security_require(row['schema'] == row['tableSchema'] == 'public' and row['dependency'] in ('a', 'i'))
            dependencies.add(('sequence', row['schema'], row['name'], ''))
    _legacy_security_require(roles == settings == set(LEGACY_SECURITY_ROLES) and guards ==
                            {'externalRoleDependencies', 'outsidePublicObjects', 'largeObjects'})
    _legacy_security_require(('database', '', expected_database, '') in objects and ('schema', '', 'public', '') in objects and
                            ('table', 'public', 'cms_editor_sessions', '') in objects)
    expected_effective = {key + (role, privilege) for key in objects for role in LEGACY_SECURITY_ROLES
                          for privilege in LEGACY_SECURITY_PRIVILEGES.get(key[0], ())}
    _legacy_security_require(effective == expected_effective)
    _legacy_security_require(dependencies == {key for key in objects if key[0] == 'sequence'})
    for row in records:
        if row['kind'] == 'acl':
            _legacy_security_require(tuple(row[k] for k in ('objectType', 'schema', 'name', 'subname')) in objects)
        elif row['kind'] == 'object' and row['objectType'] == 'column':
            _legacy_security_require(('table', row['schema'], row['name'], '') in objects)
        elif row['kind'] == 'sequenceDependency':
            _legacy_security_require(('column', row['tableSchema'], row['table'], row['column']) in objects)
    result = dict(observation, records=sorted(records, key=STATE.canonical))
    _legacy_security_require(len(STATE.canonical(result)) <= LEGACY_SECURITY_MAX_BYTES)
    return result


def check_portal_legacy_security_baseline(observation, body, approval, record, inventory, authority, approved_profile=None):
    """Internal already-authenticated inputs only; no caller hash confers trust.

    A profile is independently authenticated by a future caller. There is no
    built-in profile or production collector/repair dispatcher in this slice.
    """
    STATE.validate_state_body(body)
    intent = body.get('installIntent')
    _legacy_security_require(intent is not None and intent['binding'].get('bindingVersion') == 4)
    binding = intent['binding']
    STATE.validate_production_correspondence(binding, approval, record, inventory, authority)
    expected_database = binding['sharedCluster']['databases']['portal']['name']
    observed = validate_portal_legacy_security_observation(observation, expected_database)
    _legacy_security_require(observed['database'] == binding['portalTarget']['database'])
    blockers = {'legacy_security_host_collection_not_integrated', 'legacy_security_pg16_qualification_required',
                'legacy_role_exclusivity_unverified', 'legacy_credentials_unverified', 'legacy_recovery_executor_not_integrated'}
    if intent['stage'] != 'reserved' or body.get('restoreIntent') is not None:
        blockers.add('legacy_baseline_not_pregrant')
    for row in observed['records']:
        kind = row['kind']
        if kind == 'role' and (not row['login'] or any(row[k] for k in ('superuser', 'createDatabase', 'createRole', 'replication', 'bypassRls'))):
            blockers.add('legacy_runtime_role_attributes_unsafe')
        if kind == 'membership':
            blockers.add('legacy_runtime_role_membership_unsupported')
        if kind == 'settings' and row['present']:
            blockers.add('legacy_role_settings_unsupported')
        if kind == 'effective' and row['grantable']:
            blockers.add('legacy_runtime_grant_options_unsupported')
        if kind == 'effective' and row['objectType'] == 'column' and row['name'] == 'cms_editor_sessions' and row['allowed']:
            blockers.add('legacy_session_capability_mismatch')
        if kind == 'object':
            if row['owner'] in LEGACY_SECURITY_ROLES:
                blockers.add('legacy_runtime_role_ownership_unsupported')
            if row['unsupported']:
                blockers.add('legacy_security_mechanism_unsupported')
        if kind == 'guard' and row['present']:
            blockers.add({'externalRoleDependencies': 'legacy_shared_role_dependencies',
                          'outsidePublicObjects': 'legacy_outside_public_objects', 'largeObjects': 'legacy_large_objects_unsupported'}[row['name']])
    session = {}
    for role, field in (('portal_api', 'portalApiSessionPrivileges'), ('portal_cron', 'portalCronSessionPrivileges')):
        session[field] = [next(row['allowed'] for row in observed['records'] if row['kind'] == 'effective' and
            (row['objectType'], row['schema'], row['name'], row['subname'], row['role'], row['privilege']) ==
            ('table', 'public', 'cms_editor_sessions', '', role, privilege)) for privilege in SESSION_TABLE_PRIVILEGES]
    try:
        _validate_portal_session_grants(session, 'legacy')
    except ControlError:
        blockers.add('legacy_session_capability_mismatch')
    profile_matches = False
    if approved_profile is None:
        blockers.add('legacy_capability_profile_unapproved')
    else:
        _legacy_security_require(isinstance(approved_profile, dict) and set(approved_profile) ==
                                {'kind', 'sourceCommit', 'previousImages', 'observation'})
        _legacy_security_require(approved_profile['kind'] == 'portal-legacy-security-profile-v1')
        _legacy_security_require(isinstance(approved_profile['sourceCommit'], str) and
                                 re.fullmatch(r'[0-9a-f]{40}', approved_profile['sourceCommit']) is not None)
        STATE._valid_images(approved_profile['previousImages'], payload=False)
        expected = validate_portal_legacy_security_observation(approved_profile['observation'], expected_database)
        profile_matches = (approved_profile['sourceCommit'] == binding['sourceCommit'] and
                           approved_profile['previousImages'] == binding['previousImages'] and expected == observed)
        if not profile_matches:
            blockers.add('legacy_capability_profile_mismatch')
    return {'kind': 'portal-legacy-security-baseline-check-v1', 'observationSha256': hashlib.sha256(STATE.canonical(observed)).hexdigest(),
            'sourceApprovalSha256': authority['sourceApprovalSha256'], 'policySha256': authority['policySha256'],
            'recordSha256': authority['recordSha256'], 'installBindingSha256': hashlib.sha256(STATE.canonical(binding)).hexdigest(),
            'b0ProofSha256': binding['b0']['proofSha256'], 'sourceCommit': binding['sourceCommit'],
            'previousImages': binding['previousImages'], 'inventoryIdentity': binding['inventoryIdentity'],
            'databaseIdentity': observed['database'], 'profileMatches': profile_matches, 'blockers': sorted(blockers),
            'credentialVerified': False, 'clusterRoleMutationAuthorized': False, 'rollbackAuthorized': False,
            'installationExecuted': False, 'deploymentAuthorized': False}


FENCE_NETWORKS = ('ownerinc-portal-backend', 'ownerinc-portal-egress', 'ownerinc_proxy')
FENCE_ROUTES = ('/', '/api/ready', '/editorial/ready')


def _fence_require(value):
    if not value:
        fail('fence_observation_invalid')


def _fence_keys(value, names):
    _fence_require(isinstance(value, dict) and set(value) == set(names.split()))


def _fence_hash(value):
    _fence_require(isinstance(value, str) and STATE.HEX_64.fullmatch(value) is not None)


def _fence_uint(value):
    _fence_require(type(value) is int and 0 <= value <= 9007199254740991)


def _fence_context(value):
    _fence_keys(value, 'inventoryIdentity stateSha256 sequence installBindingSha256 sourceApprovalSha256 policySha256 recordSha256 pid processStart nonce device inode')
    for name, item in value.items():
        if name in ('sequence', 'pid', 'processStart', 'device', 'inode'):
            _fence_uint(item)
            if name in ('pid', 'processStart', 'inode'):
                _fence_require(item > 0)
        else:
            _fence_hash(item)


def _fence_records(value, maximum, key):
    _fence_require(isinstance(value, list) and len(value) <= maximum)
    identities = []
    for row in value:
        _fence_require(isinstance(row, dict) and key in row and isinstance(row[key], str))
        identities.append(row[key])
    _fence_require(len(set(identities)) == len(identities))


def _fence_container_identity(row):
    for name in ('id', 'imageId', 'receiptSha256'):
        _fence_hash(row[name])
    _fence_require(row['service'] in KNOWN_SERVICES)
    _fence_require(isinstance(row['image'], str) and len(row['image']) <= 512 and
                   re.fullmatch(r'[a-z0-9./_:-]+@sha256:[0-9a-f]{64}', row['image']) is not None)
    for name, allowed in (('networks', None), ('volumeKeys', INVENTORY.VOLUME_KEYS)):
        values = row[name]
        _fence_require(isinstance(values, list) and len(values) <= (3 if name == 'networks' else 4) and
                       all(isinstance(v, str) for v in values) and len(set(values)) == len(values))
        for value in values:
            if allowed is None:
                _fence_hash(value)
            else:
                _fence_require(value in allowed)


def validate_portal_fence_observation(observation):
    """Fixed Portal projections, not an authenticated Docker collector."""
    if isinstance(observation, bytes):
        _fence_require(len(observation) <= 4 * 1024 ** 2)
        observation = _strict_json(observation, 'fence_observation_invalid')
    _fence_keys(observation, 'kind mode context started ended passes databases external')
    _fence_require(observation['kind'] == 'portal-fence-observation-v1' and observation['mode'] in ('destructive', 'private-readiness'))
    _fence_context(observation['context'])
    for name in ('started', 'ended'):
        _fence_uint(observation[name])
    _fence_require(observation['started'] <= observation['ended'])
    _fence_require(isinstance(observation['passes'], list) and len(observation['passes']) == 2)
    normalized = []
    for inventory_pass in observation['passes']:
        _fence_keys(inventory_pass, 'host containers networks')
        _fence_records(inventory_pass['host'], 512, 'id')
        _fence_records(inventory_pass['containers'], 64, 'id')
        _fence_records(inventory_pass['networks'], 3, 'name')
        for row in inventory_pass['host']:
            _fence_keys(row, 'id portalProject portalNameClaim portalVolumeConsumer')
            _fence_hash(row['id'])
            _fence_require(all(type(row[k]) is bool for k in ('portalProject', 'portalNameClaim', 'portalVolumeConsumer')))
        for row in inventory_pass['containers']:
            _fence_keys(row, 'id service imageId image receiptSha256 networks volumeKeys status running paused restarting dead oneOff projectMatches nginxNameMatches networkMode publishedPorts aliasesApproved')
            _fence_container_identity(row)
            _fence_require(row['status'] in ('created', 'exited', 'running', 'paused', 'restarting', 'dead'))
            _fence_require(row['networkMode'] in ('bridge', 'host', 'container', 'none', 'other'))
            for key in ('running', 'paused', 'restarting', 'dead', 'oneOff', 'projectMatches', 'nginxNameMatches', 'publishedPorts', 'aliasesApproved'):
                _fence_require(type(row[key]) is bool)
        for row in inventory_pass['networks']:
            _fence_keys(row, 'name id driver internal optionsApproved endpoints')
            _fence_require(row['name'] in FENCE_NETWORKS and row['driver'] in ('bridge', 'host', 'overlay', 'macvlan', 'ipvlan', 'other'))
            _fence_hash(row['id'])
            _fence_require(type(row['internal']) is bool and type(row['optionsApproved']) is bool)
            _fence_records(row['endpoints'], 256, 'id')
            for endpoint in row['endpoints']:
                _fence_keys(endpoint, 'id relevant')
                _fence_hash(endpoint['id'])
                _fence_require(type(endpoint['relevant']) is bool)
        normalized.append({
            'host': sorted(inventory_pass['host'], key=STATE.canonical),
            'containers': sorted([dict(row, networks=sorted(row['networks']), volumeKeys=sorted(row['volumeKeys']))
                                  for row in inventory_pass['containers']], key=STATE.canonical),
            'networks': sorted([dict(row, endpoints=sorted(row['endpoints'], key=STATE.canonical))
                                for row in inventory_pass['networks']], key=STATE.canonical),
        })
    _fence_records(observation['databases'], 2, 'service')
    for row in observation['databases']:
        _fence_keys(row, 'service containerId database clients activeQueries openTransactions preparedTransactions backgroundWriters backgroundCoverageComplete')
        _fence_require(row['service'] in ('postgres:portal', 'postgres:ownerinc_cms'))
        _fence_hash(row['containerId'])
        STATE._validate_database_identity(row['database'])
        _fence_require(row['database']['databaseName'] == row['service'].split(':', 1)[1])
        for key in ('clients', 'activeQueries', 'openTransactions', 'preparedTransactions', 'backgroundWriters'):
            _fence_uint(row[key])
        _fence_require(type(row['backgroundCoverageComplete']) is bool)
    external = observation['external']
    if external is not None:
        _fence_keys(external, 'observerSha256 independent nonce started ended requests')
        _fence_hash(external['observerSha256']); _fence_hash(external['nonce'])
        _fence_require(type(external['independent']) is bool)
        _fence_uint(external['started']); _fence_uint(external['ended'])
        _fence_records(external['requests'], 3, 'route')
        for row in external['requests']:
            _fence_keys(row, 'route origin method status tlsVerified redirected transportError bodySha256')
            _fence_require(row['route'] in FENCE_ROUTES and row['method'] == 'GET')
            _fence_origin(row['origin'])
            _fence_uint(row['status']); _fence_require(row['status'] <= 599)
            _fence_require(type(row['tlsVerified']) is bool and type(row['redirected']) is bool and
                           row['transportError'] in ('none', 'timeout', 'dns', 'tls', 'connection', 'other'))
            _fence_hash(row['bodySha256'])
    result = dict(observation, passes=normalized, databases=sorted(observation['databases'], key=STATE.canonical))
    _fence_require(len(STATE.canonical(result)) <= 4 * 1024 ** 2)
    return result


def _fence_origin(origin):
    _fence_require(isinstance(origin, str) and len(origin) <= 253 and
                   re.fullmatch(r'https://[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?', origin) is not None)


def check_portal_destructive_fence(observation, expected_context, approved_topology=None, approved_closure=None, *, now_monotonic):
    """Already-authenticated context/profiles ONLY; input shapes confer no trust.

    Times are local monotonic milliseconds. External intervals are the trusted
    collector's send/receive interval, NOT an external machine's clock.
    No IO, mutation, signed ticket, Runtime construction or action registration.
    """
    value = validate_portal_fence_observation(observation)
    _fence_context(expected_context); _fence_uint(now_monotonic)
    blockers = set()
    if value['context'] != expected_context or value['passes'][0] != value['passes'][1]:
        blockers.add('fence_context_changed')
    if not value['started'] <= value['ended'] <= now_monotonic or now_monotonic - value['started'] > 30000:
        blockers.add('fence_observation_stale')
    if value['mode'] != 'destructive':
        blockers.add('fence_private_readiness_not_destructive')
    snapshot = value['passes'][1]
    containers = {row['id']: row for row in snapshot['containers']}
    networks = {row['name']: row for row in snapshot['networks']}
    host = {row['id']: row for row in snapshot['host']}
    if set(networks) != set(FENCE_NETWORKS) or len({row['id'] for row in networks.values()}) != 3 or not containers:
        blockers.add('fence_observation_incomplete')
    if any(row['id'] not in containers for row in host.values() if row['portalProject'] or row['portalNameClaim'] or row['portalVolumeConsumer']) or \
       any(identity not in host or not host[identity]['portalProject'] for identity in containers):
        blockers.add('fence_unaccounted_container')
    if len({row['service'] for row in containers.values()}) != len(containers):
        blockers.add('fence_unaccounted_container')
    nginx = [row for row in containers.values() if row['service'] == 'nginx']
    if len(nginx) != 1 or not nginx[0]['nginxNameMatches']:
        blockers.add('fence_nginx_identity_mismatch')
    for row in containers.values():
        if row['oneOff'] or not row['projectMatches']:
            blockers.add('fence_unaccounted_container')
        db = row['service'] == 'postgres'
        consistent = (row['status'] == 'running' and row['running']) if db else (row['status'] in ('created', 'exited') and not row['running'])
        if not consistent or any(row[k] for k in ('paused', 'restarting', 'dead')):
            blockers.add('fence_nginx_not_stopped' if row['service'] == 'nginx' else 'fence_writer_not_stopped')
        if row['networkMode'] != 'bridge' or row['publishedPorts'] or not row['aliasesApproved']:
            blockers.add('fence_alternative_ingress_detected')
        if any(identity not in {net['id'] for net in networks.values()} for identity in row['networks']):
            blockers.add('fence_network_identity_mismatch')
        if row['service'] != 'nginx' and networks.get('ownerinc_proxy', {}).get('id') in row['networks']:
            blockers.add('fence_alternative_ingress_detected')
        logical = ('ownerinc-portal-backend',)
        if row['service'] in ('api', 'cron', 'bootstrap-admin'):
            logical += ('ownerinc-portal-egress',)
        elif row['service'] == 'nginx':
            logical += ('ownerinc_proxy',)
        if set(row['networks']) != {networks.get(name, {}).get('id') for name in logical}:
            blockers.add('fence_network_identity_mismatch')
        if row['id'] in host and host[row['id']]['portalVolumeConsumer'] != bool(row['volumeKeys']):
            blockers.add('fence_unaccounted_container')
    for net in networks.values():
        if net['driver'] != 'bridge' or not net['optionsApproved'] or net['internal'] is not (net['name'] == 'ownerinc-portal-backend'):
            blockers.add('fence_network_identity_mismatch')
        for endpoint in net['endpoints']:
            if endpoint['id'] not in host:
                blockers.add('fence_observation_incomplete')
            if endpoint['id'] in containers and net['id'] not in containers[endpoint['id']]['networks']:
                blockers.add('fence_network_identity_mismatch')
            if net['name'] != 'ownerinc_proxy' and endpoint['id'] not in containers:
                blockers.add('fence_unapproved_endpoint')
        for container in containers.values():
            if container['running'] and net['id'] in container['networks'] and container['id'] not in {ep['id'] for ep in net['endpoints']}:
                blockers.add('fence_network_identity_mismatch')
    if approved_topology is None:
        blockers.add('fence_topology_unapproved')
    else:
        _fence_keys(approved_topology, 'kind context containers networks databases')
        _fence_require(approved_topology['kind'] == 'portal-fence-topology-v1')
        _fence_context(approved_topology['context'])
        if approved_topology['context'] != expected_context:
            blockers.add('fence_context_changed')
        _fence_records(approved_topology['containers'], 64, 'id')
        expected_containers = {}
        for row in approved_topology['containers']:
            _fence_keys(row, 'id service imageId image receiptSha256 networks volumeKeys')
            _fence_container_identity(row)
            expected_containers[row['id']] = row
        if set(expected_containers) != set(containers) or not {'nginx', 'api', 'cron', 'postgres'} <= {r['service'] for r in expected_containers.values()}:
            blockers.add('fence_unaccounted_container')
        for identity in set(expected_containers) & set(containers):
            if any((sorted(containers[identity][key]) != sorted(item) if key in ('networks', 'volumeKeys') else containers[identity][key] != item)
                   for key, item in expected_containers[identity].items()):
                blockers.add('fence_container_receipt_mismatch')
        _fence_records(approved_topology['networks'], 3, 'name')
        if {row['name'] for row in approved_topology['networks']} != set(FENCE_NETWORKS):
            blockers.add('fence_topology_unapproved')
        for row in approved_topology['networks']:
            _fence_keys(row, 'name id relevantEndpointIds')
            _fence_require(row['name'] in FENCE_NETWORKS); _fence_hash(row['id'])
            ids = row['relevantEndpointIds']
            _fence_require(isinstance(ids, list) and len(ids) <= 256 and all(isinstance(i, str) for i in ids) and len(set(ids)) == len(ids))
            for identity in ids:
                _fence_hash(identity)
            actual = networks.get(row['name'])
            if actual is None or actual['id'] != row['id']:
                blockers.add('fence_network_identity_mismatch')
            elif {ep['id'] for ep in actual['endpoints'] if ep['relevant'] or ep['id'] in containers or row['name'] != 'ownerinc_proxy'} != set(ids):
                blockers.add('fence_unapproved_endpoint')
        _fence_records(approved_topology['databases'], 2, 'service')
        expected_dbs = {}
        for row in approved_topology['databases']:
            _fence_keys(row, 'service containerId database')
            _fence_require(row['service'] in ('postgres:portal', 'postgres:ownerinc_cms')); _fence_hash(row['containerId'])
            STATE._validate_database_identity(row['database'])
            expected_dbs[row['service']] = row
        actual_dbs = {row['service']: row for row in value['databases']}
        postgres_containers = [row['id'] for row in containers.values() if row['service'] == 'postgres']
        db_containers = {service: postgres_containers[0] for service in expected_dbs} if len(postgres_containers) == 1 else {}
        if set(expected_dbs) != set(actual_dbs) or set(expected_dbs) != set(db_containers) or \
           set(expected_dbs) != {'postgres:portal', 'postgres:ownerinc_cms'}:
            blockers.add('fence_database_identity_mismatch')
        for service in set(expected_dbs) & set(actual_dbs):
            if any(actual_dbs[service][k] != v for k, v in expected_dbs[service].items()) or actual_dbs[service]['containerId'] != db_containers.get(service):
                blockers.add('fence_database_identity_mismatch')
    for row in value['databases']:
        if any(row[k] != 0 for k in ('clients', 'activeQueries', 'openTransactions', 'preparedTransactions', 'backgroundWriters')):
            blockers.add('fence_database_not_quiescent')
        if not row['backgroundCoverageComplete']:
            blockers.add('fence_background_writers_unverified')
    external = value['external']
    if approved_closure is None:
        blockers.add('fence_public_profile_unapproved')
        blockers.add('fence_external_topology_unverified')
    else:
        _fence_keys(approved_closure, 'kind context origin observerSha256 nonDockerCoverageVerified routes')
        _fence_require(approved_closure['kind'] == 'portal-public-closure-profile-v1')
        _fence_context(approved_closure['context']); _fence_origin(approved_closure['origin']); _fence_hash(approved_closure['observerSha256'])
        _fence_require(type(approved_closure['nonDockerCoverageVerified']) is bool)
        if approved_closure['context'] != expected_context:
            blockers.add('fence_context_changed')
        if not approved_closure['nonDockerCoverageVerified']:
            blockers.add('fence_external_topology_unverified')
        _fence_records(approved_closure['routes'], 3, 'route')
        expected_routes = {}
        for row in approved_closure['routes']:
            _fence_keys(row, 'route status bodySha256'); _fence_hash(row['bodySha256'])
            _fence_require(row['route'] in FENCE_ROUTES and type(row['status']) is int and 400 <= row['status'] <= 599)
            expected_routes[row['route']] = row
        if set(expected_routes) != set(FENCE_ROUTES):
            blockers.add('fence_public_probe_mismatch')
        if external is not None:
            if not external['independent'] or external['observerSha256'] != approved_closure['observerSha256'] or \
               external['nonce'] != expected_context['nonce'] or not value['started'] <= external['started'] <= external['ended'] <= value['ended']:
                blockers.add('fence_public_probe_mismatch')
            if {row['route'] for row in external['requests']} != set(FENCE_ROUTES):
                blockers.add('fence_public_probe_mismatch')
            for row in external['requests']:
                expected = expected_routes.get(row['route'])
                if expected is None or any(row[k] != v for k, v in expected.items()) or row['origin'] != approved_closure['origin'] or \
                   not row['tlsVerified'] or row['redirected'] or row['transportError'] != 'none':
                    blockers.add('fence_public_probe_mismatch')
    if external is None:
        blockers.add('fence_public_probe_missing')
    return {'kind': 'portal-destructive-fence-check-v1', 'observationSha256': hashlib.sha256(STATE.canonical(value)).hexdigest(),
            'blockers': sorted(blockers), 'observationsMatched': not blockers,
            'destructiveOperationAuthorized': False, 'installationExecuted': False, 'deploymentAuthorized': False}


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


def _assert_database_quiescent(service, database=None):
    if database is None:
        database = _portal_database()
    value = _psql_json(service, """
SELECT json_build_object(
  'clientBackends', count(*)::integer,
  'activeQueries', count(*) FILTER (WHERE state='active')::integer,
  'openTransactions', count(*) FILTER (WHERE xact_start IS NOT NULL)::integer
)
FROM pg_catalog.pg_stat_activity
WHERE datid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database())
  AND backend_type='client backend' AND pid <> pg_catalog.pg_backend_pid();
""", database)
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
    value = _psql_json('postgres', sql, 'ownerinc_cms')
    if value.get('migrations') != STATE.CMS_MIGRATIONS:
        fail('cms_migration_floor_mismatch')
    if value.get('protocolRelations') != 0 or value.get('protocolFunctions') != 0 or value.get('protocolTriggers') != 0:
        fail('unsupported_protocol_present_or_mixed')
    if value.get('newsRows') != 0:
        fail('unexpected_preauthority_news_rows')
    return value


def _data_fingerprint(service, database=None, *, isolated_query=None):
    if database is None:
        database = _portal_database()
    # Internal disposable executor may supply a bounded query transport. It uses
    # these SAME SQL/ordering/canonical bytes, never a different proof algorithm.
    inventory_sql = """
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
"""
    rows = _psql_json(service, inventory_sql, database) if isolated_query is None else json.loads(isolated_query(inventory_sql))
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
    if isolated_query is not None:
        return _data_fingerprint_rows(relations, isolated_query(sql).splitlines(keepends=True))
    container = _container_id(service)
    command = ['docker', 'exec', '-i', container, 'sh', '-ceu',
               'psql -XqAt -v ON_ERROR_STOP=1 --dbname="$1" --username="$2"',
               'database-target', database, 'cms_admin' if database == 'ownerinc_cms' else 'portal_admin']
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    try:
        assert process.stdin is not None and process.stdout is not None
        process.stdin.write(sql.encode('ascii'))
        process.stdin.close()
        fingerprint = _data_fingerprint_rows(relations, process.stdout)
        status = process.wait(timeout=RUNTIME_CHILD_WAIT_SECONDS)
        if status != 0:
            fail('database_fingerprint_failed')
    except ControlError:
        _kill_and_reap_child(process, 'database_fingerprint_failed')
        raise
    except (OSError, BrokenPipeError, subprocess.TimeoutExpired):
        _kill_and_reap_child(process, 'database_fingerprint_failed')
        fail('database_fingerprint_failed')
    return fingerprint


def _data_fingerprint_rows(relations, lines):
    grouped = {}
    for raw_line in lines:
        try:
            row = _strict_json(raw_line.rstrip(b'\r\n'), 'database_fingerprint_failed')
            if not isinstance(row, list) or len(row) != 2:
                raise ValueError('row')
            relation, row_value = row
        except (UnicodeDecodeError, ValueError, ControlError):
            fail('database_fingerprint_failed')
        if not isinstance(relation, str) or relation not in [entry['relation'] for entry in relations] or not isinstance(row_value, dict):
            fail('database_fingerprint_failed')
        record = grouped.get(relation)
        if record is None:
            record = {'count': 0, 'hash': hashlib.sha256()}
            grouped[relation] = record
        record['count'] += 1
        record['hash'].update(STATE.canonical(row_value) + b'\n')
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
    return _volume_receipt(raw)


def _volume_receipt(raw):
    """Historical receipt bytes, after the caller's exact ownership checks."""
    labels = raw.get('Labels') or {}
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
    portal = _database_identity('postgres', _portal_database(config))
    cms = _database_identity('postgres', 'ownerinc_cms')
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


def _manifest_hashes(directory, payload=True, read_bytes=None, file_hash=None):
    expected = [
        'postgres.dump', 'uploads.tar.gz', 'cms.dump', 'cms-uploads.tar.gz',
        'release.images', 'operations-proof.json', 'backup.format',
    ] if payload else ['postgres.dump', 'uploads.tar.gz']
    path = os.path.join(directory, 'manifest.sha256')
    raw = (read_bytes or _read_bytes)(path)
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
        if name in seen or name not in expected:
            fail('backup_manifest_invalid')
        if (file_hash or _file_hash)(os.path.join(directory, name))['sha256'] != digest:
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


def _tar_tree(stream, compressed=False, limits=None, projection=None):
    # Optional materialization projection is a separate, stricter contract.
    # Historical hash fields and the default traversal remain unchanged.
    if projection is not None and (limits is None or projection):
        fail('unsafe_storage_archive')
    mode = 'r|gz' if compressed else 'r|'
    extension_count = extension_bytes = extension_depth = 0
    class BoundedTarInfo(tarfile.TarInfo):
        def _proc_member(self, archive):
            nonlocal extension_count, extension_bytes, extension_depth
            # Global PAX is updated before tarfile recursively parses the next
            # header. Check it here before that header can copy/extend it again.
            if len(archive.pax_headers) > limits['globalPaxKeys'] or sum(
                    len(k.encode('utf-8')) + len(v.encode('utf-8'))
                    for k, v in archive.pax_headers.items()) > limits['globalPaxBytes']:
                fail('unsafe_storage_archive')
            # tarfile processes extension payloads before yielding a member.
            # Bound those allocations before PAX/GNU long-name parsing occurs.
            if self.type == tarfile.GNUTYPE_SPARSE:
                fail('unsafe_storage_archive')
            extension = self.type in (tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.SOLARIS_XHDTYPE,
                                      tarfile.GNUTYPE_LONGNAME, tarfile.GNUTYPE_LONGLINK)
            if extension:
                if projection is not None:
                    fail('unsafe_storage_archive')
                extension_count += 1
                extension_bytes += self.size
                if not 0 <= self.size <= 64 * 1024 or extension_count > limits['extensionCount'] or \
                   extension_bytes > limits['extensionBytes'] or extension_depth >= limits['extensionDepth']:
                    fail('unsafe_storage_archive')
                extension_depth += 1
            try:
                return super()._proc_member(archive)
            finally:
                if extension:
                    extension_depth -= 1

        def _proc_gnusparse_10(self, *args, **kwargs):
            fail('unsafe_storage_archive')
    try:
        archive = tarfile.open(fileobj=stream, mode=mode, **({'tarinfo': BoundedTarInfo} if limits is not None else {}))
    except (tarfile.TarError, OSError):
        fail('unsafe_storage_archive')
    entries = {}
    name_bytes = 0
    try:
        for member in archive:
            if limits is not None:
                # Only sequential extraction by this explicit TarInfo is used;
                # links are rejected and no name lookup/getmembers is permitted.
                # Avoid retaining every member's copy of accumulated global PAX.
                archive.members.clear()
                if member.sparse is not None:
                    fail('unsafe_storage_archive')
                name_bytes += len(member.name.encode('utf-8'))
                if len(entries) >= limits['members'] or len(member.name) > limits['nameLength'] or name_bytes > limits['nameBytes']:
                    fail('unsafe_storage_archive')
            name = _normalize_tar_name(member.name)
            if name in entries:
                fail('unsafe_storage_archive')
            if projection is not None:
                if member.pax_headers or member.sparse is not None or \
                   type(member.uid) is not int or type(member.gid) is not int or \
                   not 0 <= member.uid <= 2097151 or not 0 <= member.gid <= 2097151 or \
                   type(member.mtime) is not int or not 0 <= member.mtime <= 8589934591 or \
                   len(name.encode('utf-8')) > 100 or len(name.split('/')) > 32 or \
                   member.mode not in ((0o700, 0o750, 0o755) if member.isdir() else (0o600, 0o640, 0o644)):
                    fail('unsafe_storage_archive')
                projection[name] = {'uid': member.uid, 'gid': member.gid, 'mtime': member.mtime, 'data': b''}
            if member.isdir() and member.type == tarfile.DIRTYPE:
                if limits is not None and member.size != 0:
                    fail('unsafe_storage_archive')
                entries[name] = {'type': 'directory', 'mode': member.mode & 0o7777, 'size': 0, 'sha256': None}
                continue
            if not member.isfile() or member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE):
                fail('unsafe_storage_archive')
            if limits is not None and name == '.':
                fail('unsafe_storage_archive')
            file_stream = archive.extractfile(member)
            if file_stream is None:
                fail('unsafe_storage_archive')
            digest = hashlib.sha256()
            size = 0
            content = bytearray() if projection is not None else None
            while True:
                block = file_stream.read(1024 * 1024)
                if not block:
                    break
                digest.update(block)
                size += len(block)
                if content is not None:
                    content.extend(block)
            if size != member.size:
                fail('unsafe_storage_archive')
            entries[name] = {'type': 'file', 'mode': member.mode & 0o7777, 'size': size, 'sha256': digest.hexdigest()}
            if projection is not None:
                projection[name]['data'] = bytes(content)
        if limits is not None:
            for name in entries:
                parts = name.split('/')
                if any(entries.get('/'.join(parts[:index]), {}).get('type') == 'file'
                       for index in range(1, len(parts))):
                    fail('unsafe_storage_archive')
            # Streaming tar keeps read-ahead bytes after its first end marker.
            # Reject hidden trailing members here as well as in the gzip drain.
            buffered = getattr(archive.fileobj, 'buf', None)
            if not isinstance(buffered, bytes) or buffered.strip(b'\0'):
                fail('unsafe_storage_archive')
    except ControlError:
        raise
    except (tarfile.TarError, OSError, EOFError):
        fail('unsafe_storage_archive')
    finally:
        archive.close()
    if projection is not None:
        if entries.get('.', {}).get('type') != 'directory':
            fail('unsafe_storage_archive')
        for name in entries:
            parts = name.split('/')
            if any(entries.get('/'.join(parts[:i]), {}).get('type') != 'directory' for i in range(1, len(parts))):
                fail('unsafe_storage_archive')
            projection[name].update(entries[name])
    return hashlib.sha256(STATE.canonical([{'name': name, **entries[name]} for name in sorted(entries)])).hexdigest()


def _bounded_gzip_tar_tree(stream, limits, projection=None):
    """Shared expansion/footer/trailing-data checks, including materialization."""
    class BoundedExpansion:
        def __init__(self, source):
            self.source, self.total = source, 0

        def read(self, size=-1):
            if size < 0 or size > 1024 * 1024:
                fail('unsafe_storage_archive')
            block = self.source.read(min(size, limits['expanded'] - self.total + 1))
            self.total += len(block)
            if self.total > limits['expanded']:
                fail('unsafe_storage_archive')
            return block
    try:
        with gzip.GzipFile(fileobj=stream, mode='rb') as expanded:
            bounded = BoundedExpansion(expanded)
            fingerprint = _tar_tree(bounded, limits=limits, projection=projection)
            while True:
                block = bounded.read(1024 * 1024)
                if not block:
                    break
                if block.strip(b'\0'):
                    fail('unsafe_storage_archive')
            return fingerprint
    except (OSError, EOFError, tarfile.TarError):
        fail('unsafe_storage_archive')


def _archive_tree(path):
    _safe_regular(path)
    try:
        with open(path, 'rb') as stream:
            return _tar_tree(stream, compressed=True)
    except OSError:
        fail('unsafe_storage_archive')


# Fixed administrative limits, not environment/request overrides. Legacy readers
# retain their existing behavior; these apply only to the production B0 check.
PRODUCTION_B0_LIMITS = {
    'postgres.dump': 256 * 1024 ** 3, 'uploads.tar.gz': 32 * 1024 ** 3,
    'manifest.sha256': 4096, 'preauthority-proof.json': 64 * 1024,
}
PRODUCTION_B0_TAR_LIMITS = {'expanded': 64 * 1024 ** 3, 'members': 50000,
                          'nameLength': 4096, 'nameBytes': 8 * 1024 ** 2,
                          'extensionCount': 4096, 'extensionBytes': 1024 ** 2,
                          'extensionDepth': 8, 'globalPaxKeys': 1024, 'globalPaxBytes': 64 * 1024}


def _b0_identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


@contextmanager
def verify_production_b0_artifacts(binding, inventory, key):
    """Read-only artifact integrity, never restoreability or authorization.

    Caller authenticates helpers/context and retains the exclusive deployment
    lease. Keep descriptors and identity observations alive until caller's final
    journal/lease recheck. No Runtime, subprocess, extraction or publication.
    """
    STATE.validate_install_binding(binding)
    INVENTORY.validate(inventory)
    directory = binding['b0']['directory']
    if binding['inventoryIdentity'] != INVENTORY.identity(inventory) or not any(
            directory != root and os.path.commonpath((directory, root)) == root
            for root in inventory['paths']['backupRoots']):
        fail('preauthority_source_recovery_proof_mismatch')
    ancestors = {}
    current = directory
    while True:
        info = os.lstat(current)
        if not stat.S_ISDIR(info.st_mode) or (info.st_uid, info.st_gid) != (0, 0) or \
           stat.S_IMODE(info.st_mode) & 0o022 or (current == directory and stat.S_IMODE(info.st_mode) != 0o700):
            fail('unsafe_backup_directory')
        ancestors[current] = _b0_identity(info)
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    if set(os.listdir(directory)) != set(PRODUCTION_B0_LIMITS):
        fail('backup_manifest_invalid')
    with ExitStack() as stack:
        streams, identities = {}, {}
        for name, limit in PRODUCTION_B0_LIMITS.items():
            path = os.path.join(directory, name)
            before = os.lstat(path)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or \
               (before.st_uid, before.st_gid) != (0, 0) or stat.S_IMODE(before.st_mode) != 0o600 or \
               not 0 < before.st_size <= limit:
                fail('unsafe_backup_file')
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            try:
                stream = os.fdopen(fd, 'rb')
            except BaseException:
                os.close(fd)
                raise
            stack.enter_context(stream)
            if _b0_identity(os.fstat(stream.fileno())) != _b0_identity(before):
                fail('backup_artifact_changed')
            streams[name], identities[name] = stream, _b0_identity(before)

        def reaffirm():
            if set(os.listdir(directory)) != set(PRODUCTION_B0_LIMITS):
                fail('backup_artifact_changed')
            for path, identity in ancestors.items():
                if _b0_identity(os.lstat(path)) != identity:
                    fail('backup_artifact_changed')
            for name, identity in identities.items():
                if _b0_identity(os.lstat(os.path.join(directory, name))) != identity or \
                   _b0_identity(os.fstat(streams[name].fileno())) != identity:
                    fail('backup_artifact_changed')

        def small(name):
            stream = streams[name]
            stream.seek(0)
            value = stream.read(PRODUCTION_B0_LIMITS[name] + 1)
            if len(value) != identities[name][6]:
                fail('backup_artifact_changed')
            return value

        raw = small('preauthority-proof.json')
        proof = STATE.verify_envelope(STATE.parse_canonical(raw, 'proof_not_canonical'), key,
                                      STATE.validate_proof_body, 'proof_shape_invalid')
        if hashlib.sha256(raw).hexdigest() != binding['b0']['proofSha256'] or \
           proof['kind'] != 'preauthority-legacy-source' or proof['inventoryIdentity'] != binding['inventoryIdentity'] or \
           proof['source']['portal'] != binding['portalTarget']['database'] or \
           proof['images'] != binding['previousImages'] or proof['targetImages'] != binding['candidate']['images']:
            fail('preauthority_source_recovery_proof_mismatch')
        hashes = {}
        for artifact in proof['artifacts']:
            name = artifact['name']
            stream = streams[name]
            digest, size = hashlib.sha256(), 0
            while True:
                block = stream.read(1024 * 1024)
                if not block:
                    break
                size += len(block)
                if size > PRODUCTION_B0_LIMITS[name]:
                    fail('backup_artifact_changed')
                digest.update(block)
            hashes[name] = {'sha256': digest.hexdigest(), 'size': size}
            if size != artifact['size'] or size != identities[name][6] or digest.hexdigest() != artifact['sha256']:
                fail('backup_artifact_mismatch')
        _manifest_hashes(directory, payload=False,
                         read_bytes=lambda path: small(os.path.basename(path)),
                         file_hash=lambda path: hashes.get(os.path.basename(path), {}))
        expected_manifest = ''.join(hashes[name]['sha256'] + '  ' + name + '\n' for name in STATE.LEGACY_ARTIFACTS).encode('ascii')
        if small('manifest.sha256') != expected_manifest:
            fail('backup_manifest_invalid')
        streams['uploads.tar.gz'].seek(0)

        fingerprint = _bounded_gzip_tar_tree(streams['uploads.tar.gz'], PRODUCTION_B0_TAR_LIMITS)
        if fingerprint != proof['dataFingerprints']['portalUploads']:
            fail('backup_storage_fingerprint_mismatch')
        reaffirm()
        yield {'artifactIntegrityVerified': True, 'storageFingerprintVerified': True,
               'databaseRestoreVerified': False, 'liveSourceVerified': False,
               'rollbackAuthorized': False, 'installationExecuted': False, 'deploymentAuthorized': False}
        reaffirm()


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
    _database_identity('postgres', 'ownerinc_cms')
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
        if format_raw != b'payload-v2-shared-postgres\n':
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
    names = ['postgres.dump', 'cms.dump'] if payload else ['postgres.dump']
    for name, service in zip(names, services):
        container = _container_id(service)
        path = os.path.join(directory, name)
        _safe_regular(path)
        try:
            with open(path, 'rb') as stream:
                result = subprocess.run(['docker', 'exec', '-i', container, 'pg_restore', '--list'],
                                        stdin=stream, stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL, check=False)
        except (OSError, subprocess.TimeoutExpired):
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


def production_container_fingerprint(value, release_path):
    """New persistent production algorithm; never used for historical receipts.

    Caller separately verifies topology, reservation labels and stopped state.
    Preserve all mount fields and nested array ordering, sort outer mounts only.
    """
    if not isinstance(value, dict) or not isinstance(value.get('Config'), dict):
        fail('restore_target_changed')
    config = value['Config']
    if not isinstance(value.get('Id'), str) or not STATE.HEX_64.fullmatch(value['Id']) or \
       not isinstance(value.get('Image'), str) or not re.fullmatch(r'sha256:[0-9a-f]{64}', value['Image']) or \
       not isinstance(config.get('Image'), str) or not config['Image'] or \
       not isinstance(value.get('Created'), str) or not value['Created'] or \
       not isinstance(config.get('Labels'), dict) or \
       any(not isinstance(k, str) or not isinstance(v, str) for k, v in config['Labels'].items()) or \
       not isinstance(release_path, str) or '\0' in release_path or not os.path.isabs(release_path) or \
       os.path.normpath(release_path) != release_path:
        fail('restore_target_changed')
    mounts = value.get('Mounts')
    if not isinstance(mounts, list):
        fail('restore_target_changed')
    destinations = set()
    for mount in mounts:
        destination = mount.get('Destination') if isinstance(mount, dict) else None
        if not isinstance(destination, str) or '\0' in destination or not os.path.isabs(destination) or \
           os.path.normpath(destination) != destination or destination in destinations:
            fail('restore_target_changed')
        destinations.add(destination)
    return hashlib.sha256(STATE.canonical({
        'algorithm': 'production-container-mounts-v1', 'id': value['Id'], 'image': config['Image'],
        'imageId': value['Image'], 'labels': config['Labels'], 'created': value['Created'],
        'releasePath': release_path, 'mounts': sorted(mounts, key=lambda m: m['Destination']),
    })).hexdigest()


def production_install_plan(record, trust, inventory, body, observations, approval=None):
    """Pure classification, NOT authentication or permission to install.

    The installed administrative caller authenticates evidence and reads the
    signed journal without repair. No Runtime constructor or action dispatch.
    """
    STATE.validate_state_body(body)
    INVENTORY.validate(inventory)
    if body['inventoryIdentity'] != INVENTORY.identity(inventory):
        fail('state_inventory_identity_mismatch')
    STATE._exact_keys(trust, {'sourceApprovalSha256', 'policySha256', 'recordSha256'}, 'invalid_cold_state')
    if any(not isinstance(value, str) or not STATE.HEX_64.fullmatch(value) for value in trust.values()):
        fail('invalid_cold_state')
    STATE._exact_keys(observations, {'runtimeOwnershipCompatible', 'isolatedSourceIdentityCompatible',
                                   'candidateReleasePresent', 'b0Status'}, 'invalid_cold_state')
    if any(type(observations[name]) is not bool for name in observations if name != 'b0Status') or \
       observations['b0Status'] not in ('absent', 'unbound', 'partial', 'present_unverified', 'integrity_verified'):
        fail('invalid_cold_state')
    candidate = STATE.production_candidate(record)
    production = body.get('installIntent') is not None and body['installIntent']['binding'].get('bindingVersion') == 4
    blockers = ['production_initializer_not_enabled',
                'production_creation_execution_not_integrated' if production else 'production_creation_binding_unsupported',
                'physical_resource_observations_required', 'closed_b1_ingress_readiness_not_integrated']
    if body['schemaVersion'] != 2:
        blockers.append('install_state_schema_upgrade_required')
    if inventory['project'] != 'ownerinc-portal-prod':
        blockers.append('production_project_mismatch')
    if not observations['runtimeOwnershipCompatible']:
        blockers.append('production_runtime_ownership_incompatible')
    if not observations['isolatedSourceIdentityCompatible']:
        blockers.append('isolated_source_identity_incompatible')
    blockers.append('candidate_release_publication_unverified' if observations['candidateReleasePresent']
                    else 'candidate_release_not_published')
    if observations['b0Status'] in ('partial', 'unbound'):
        blockers.append('partial_or_unbound_b0')
    else:
        blockers.append('b0_recovery_verification_required')
    intent = body.get('installIntent')
    # A restore can retain a committed install intent: diagnose both independently.
    if intent:
        if observations['b0Status'] == 'absent':
            blockers.append('bound_b0_missing')
        if intent['binding'].get('bindingVersion') == 2:
            blockers.append('isolated_binding_not_production_authority')
        if intent['binding']['candidate'] != candidate:
            blockers.append('existing_install_candidate_mismatch')
        if production:
            if intent['binding']['authority'] != trust:
                blockers.append('existing_install_authority_mismatch')
            if approval is None:
                blockers.append('production_binding_context_required')
            else:
                try:
                    STATE.validate_production_correspondence(intent['binding'], approval, record, inventory, trust)
                except STATE.StateError:
                    blockers.append('production_binding_context_mismatch')
        creation = intent.get('creation')
        if creation is None or set(creation['volumes']) != ({'cmsUploads'} if production else {'cmsPostgres', 'cmsUploads'}) or \
           set(creation['containers']) != ({'cms', 'api', 'cron'} if production else {'postgres', 'cms'}):
            blockers.append('creation_receipts_incomplete')
        blockers.append('install_intent_retained')
    if body.get('restoreIntent') is not None:
        classification = 'restore_pending'
        blockers.append('restore_intent_retained')
    elif intent:
        stage = intent['stage']
        classification = stage if stage in ('floor_commit_pending', 'floor_committed') else 'pre_floor_install_pending'
    elif body['cmsStatus'] == 'cold':
        initial = body['sequence'] == 0 and body['admission'] == 'open' and all(body[name] is None for name in
            ('latestProofSha256', 'legacySourceProofSha256', 'releaseImages', 'plannedReleaseImages',
             'rollbackTargetImages', 'nativeCatalogFingerprint'))
        classification = 'initial_cold' if initial else 'cold_without_install_intent'
    else:
        classification = 'noninitial_without_install_intent'
        blockers.append('existing_floor_requires_separate_recovery')
    return {'kind': 'payload-production-install-plan-v1', 'classification': classification,
            'candidate': candidate, 'trust': dict(trust), 'inventoryIdentity': body['inventoryIdentity'],
            'b0Status': observations['b0Status'], 'blockers': sorted(blockers),
            'installationExecuted': False, 'deploymentAuthorized': False}


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
            _assert_database_quiescent('postgres', 'ownerinc_cms')
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
        portal_database = _portal_database(self.inventory['document'])
        portal_identity = _database_identity('postgres', portal_database)
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
               _read_bytes(os.path.join(directory, 'backup.format')) != b'payload-v2-shared-postgres\n':
                fail('backup_image_manifest_mismatch')
            _validate_pg_archives(directory, ('postgres',) * 2, payload=True)
            cms_identity = _database_identity('postgres', 'ownerinc_cms')
            cms_state = _cms_state()
            catalog = _run_catalog_verifier(self.release_path)
            _assert_database_quiescent('postgres', 'ownerinc_cms')
            cms_data = _data_fingerprint('postgres', 'ownerinc_cms')
            cms_uploads = _archive_tree(os.path.join(directory, 'cms-uploads.tar.gz'))
            artifacts = [{'name': name, **_file_hash(os.path.join(directory, name))} for name in STATE.PAYLOAD_ARTIFACTS]
            fingerprints = {'portalDatabase': portal_data, 'cmsDatabase': cms_data,
                            'portalUploads': _archive_tree(os.path.join(directory, 'uploads.tar.gz')),
                            'cmsUploads': cms_uploads}
            _assert_database_quiescent('postgres', 'ownerinc_cms')
            _assert_database_quiescent('postgres')
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
        _validate_pg_archives(directory, ('postgres',) * 2, payload=True)
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
            'cmsDatabase': _data_fingerprint('postgres', 'ownerinc_cms'),
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
        _assert_database_quiescent('postgres', 'ownerinc_cms')
        _assert_database_quiescent('postgres')
        if intent['stage'] == 'reserved':
            actual_fingerprints = {
                'portalDatabase': _data_fingerprint('postgres'),
                'cmsDatabase': _data_fingerprint('postgres', 'ownerinc_cms'),
                'portalUploads': self._storage_tree_fingerprint('api'),
                'cmsUploads': self._storage_tree_fingerprint('cms'),
            }
            if STATE.canonical(actual_fingerprints) != STATE.canonical(intent['targetFingerprints']):
                fail('restore_target_content_changed')
        return body

    def prepare_restore(self):
        self._recheck_restore_boundary()
        _validate_pg_archives(self.evidence, ('postgres',) * 2, payload=True)
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
           _data_fingerprint('postgres', 'ownerinc_cms') != body['dataFingerprints']['cmsDatabase']:
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
            status = process.wait(timeout=RUNTIME_CHILD_WAIT_SECONDS)
        except ControlError:
            _kill_and_reap_child(process, 'restored_storage_inspection_failed')
            raise
        except OSError:
            _kill_and_reap_child(process, 'restored_storage_inspection_failed')
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
        _assert_database_quiescent('postgres', _portal_database(self.inventory['document']))
        _assert_database_quiescent('postgres', 'ownerinc_cms')
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

    def _writer_scope(self):
        # No ticket survives the coordinator process/lease that observed it.
        # Check a real ancestor, not an arbitrary caller-selected PID or sidecar.
        value = os.environ.get('PAYLOAD_WRITER_COORDINATOR_PID', '')
        if os.name == 'nt' or not re.fullmatch(r'[1-9][0-9]{0,9}', value):
            fail('writer_coordinator_scope_invalid')
        selected = int(value)
        pid = os.getppid()
        for _ in range(5):
            info = os.stat('/proc/' + str(pid))
            if info.st_uid != 0:
                fail('writer_coordinator_scope_invalid')
            with open('/proc/' + str(pid) + '/stat', 'r', encoding='ascii') as stream:
                fields = stream.read(4096).rsplit(')', 1)[1].split()
            if pid == selected:
                lease = os.stat(self.inventory['document']['paths']['lock'])
                descriptor = os.stat('/proc/' + str(pid) + '/fd/9')
                if (descriptor.st_dev, descriptor.st_ino) != (lease.st_dev, lease.st_ino):
                    fail('operation_lease_inode_mismatch')
                return {'pid': pid, 'started': fields[19], 'device': lease.st_dev, 'inode': lease.st_ino}
            pid = int(fields[1])
            if pid <= 1:
                break
        fail('writer_coordinator_scope_invalid')

    def _writer_command(self, args, reason):
        try:
            return self._initializer_command(args, evidence_prefix='payload-writer-command')
        except ControlError as error:
            if str(error) not in ('initializer_command_failed', 'initializer_command_launch_failed', 'initializer_command_signaled'):
                raise
            fail(reason)

    def _writer_inspect(self, container, service, allowed_states):
        raw = self._writer_command(['docker', 'inspect', container], 'writer_inspect_command_failed')
        values = _strict_json(raw, 'writer_inspect_response_invalid')
        if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], dict):
            fail('writer_inspect_response_invalid')
        value = values[0]
        labels = value.get('Config', {}).get('Labels', {})
        status = value.get('State', {})
        identity = value.get('Id')
        if not isinstance(identity, str) or not STATE.HEX_64.fullmatch(identity) or not identity.startswith(container) or \
           labels.get('com.docker.compose.project') != self.inventory['document']['project'] or \
           labels.get('com.docker.compose.service') != service or labels.get('com.docker.compose.oneoff') != 'False':
            fail('writer_identity_mismatch')
        state = status.get('Status')
        if state not in allowed_states or status.get('Running') is not (state == 'running') or \
           status.get('Paused') is not False or status.get('Restarting') is not False:
            fail('writer_state_invalid')
        mounts = value.get('Mounts')
        if not isinstance(mounts, list):
            fail('writer_inspect_response_invalid')
        destinations = set()
        for mount in mounts:
            destination = mount.get('Destination') if isinstance(mount, dict) else None
            if not isinstance(destination, str) or not destination.startswith('/') or '\0' in destination or \
               destination in destinations:
                fail('writer_inspect_response_invalid')
            destinations.add(destination)
        # Docker Mounts is an unordered collection. Preserve every record/field
        # and its cardinality; only this v2 ephemeral writer ticket sorts it.
        # Do NOT reuse this change for persistent _creation_container receipts.
        mounts = sorted(mounts, key=lambda mount: mount['Destination'])
        receipt = {'id': identity, 'fingerprint': hashlib.sha256(STATE.canonical({
            'id': identity, 'image': value.get('Image'), 'configImage': value.get('Config', {}).get('Image'),
            'labels': labels, 'created': value.get('Created'), 'mounts': mounts,
            'healthcheck': value.get('Config', {}).get('Healthcheck'),
        })).hexdigest()}
        return receipt, state, status.get('Health', {}).get('Status', 'none')

    def observe_writers(self):
        if STATE.install_pending(self.state) or self.state['cmsStatus'] != 'migrated':
            fail('writer_resume_floor_invalid')
        images, payload = _release(self.release_path, payload=True)
        if not payload or images != self.state['releaseImages']:
            fail('release_state_mismatch')
        scope = self._writer_scope()
        _verify_release_images(self.release_path, images)
        containers = _check_container_shape('migrated')
        captured = {}
        for service in ('nginx', 'api', 'cron', 'cms'):
            found = [c for c in containers if c['service'] == service]
            if len(found) > 1:
                fail('writer_identity_mismatch')
            if found and found[0]['state'] == 'running':
                captured[service] = self._writer_inspect(found[0]['id'], service, {'running'})[0]
            elif found and found[0]['state'] not in ('exited', 'created'):
                fail('writer_state_invalid')
        if not {'api', 'cron', 'cms'} <= set(captured) or len({v['id'] for v in captured.values()}) != len(captured):
            fail('writer_identity_mismatch')
        ticket = {'kind': 'coordinator-writers-v2', 'inventoryIdentity': self.inventory['identity'],
                  'release': self.release_path, 'scope': scope, 'sequence': self.state['sequence'],
                  'stateSha256': self.state_parent_hash, 'containers': captured}
        print(STATE.canonical(STATE.sign_envelope(ticket, self.key)).decode('utf-8'))

    def resume_writers(self, readiness=False):
        self._admission_closed()
        if STATE.install_pending(self.state) or self.state['cmsStatus'] != 'migrated' or self.state['restoreIntent'] is not None:
            fail('writer_resume_floor_invalid')
        if not self.evidence or len(self.evidence) > 16 * 1024:
            fail('writer_ticket_invalid')
        def validate(ticket):
            STATE._exact_keys(ticket, {'kind', 'inventoryIdentity', 'release', 'scope', 'sequence', 'stateSha256', 'containers'}, 'writer_ticket_invalid')
            if ticket['kind'] != 'coordinator-writers-v2' or ticket['inventoryIdentity'] != self.inventory['identity'] or \
               ticket['release'] != self.release_path or ticket['scope'] != self._writer_scope() or \
               not STATE._safe_int(ticket['sequence']) or ticket['sequence'] >= self.state['sequence'] or \
               not isinstance(ticket['stateSha256'], str) or not STATE.HEX_64.fullmatch(ticket['stateSha256']):
                fail('writer_ticket_invalid')
            found = ticket['containers']
            if not isinstance(found, dict) or not {'api', 'cron', 'cms'} <= set(found) <= {'nginx', 'api', 'cron', 'cms'}:
                fail('writer_ticket_invalid')
            for item in found.values():
                STATE._exact_keys(item, {'id', 'fingerprint'}, 'writer_ticket_invalid')
                if any(not isinstance(item[k], str) or not STATE.HEX_64.fullmatch(item[k]) for k in item):
                    fail('writer_ticket_invalid')
            if len({item['id'] for item in found.values()}) != len(found):
                fail('writer_ticket_invalid')
            return ticket
        envelope = STATE.parse_canonical(self.evidence.encode('utf-8') + b'\n', 'writer_ticket_invalid')
        ticket = STATE.verify_envelope(envelope, self.key, validate, 'writer_ticket_invalid')
        # Origin is an existing signed journal entry, not an operator JSON state.
        origin_path = os.path.join(self.state_dir, STATE._journal_name(ticket['sequence']))
        raw = STATE._read_file(origin_path, 0o600, private_owner=True)
        origin_envelope = STATE.parse_canonical(raw, 'state_journal_corrupt')
        if hashlib.sha256(STATE.canonical(origin_envelope)).hexdigest() != ticket['stateSha256']:
            fail('writer_ticket_invalid')
        origin = STATE.verify_envelope(origin_envelope, self.key, STATE.validate_state_body, 'state_journal_corrupt')
        if any(origin.get(k) != self.state.get(k) for k in ('inventoryIdentity', 'releaseImages', 'nativeCatalogFingerprint', 'installIntent')) or \
           self.state['latestProofSha256'] is None or self.state['latestProofSha256'] == origin['latestProofSha256']:
            fail('writer_resume_floor_invalid')
        containers = _check_container_shape('migrated')
        pending = []
        # Validate the ENTIRE captured set and held worker before the first start.
        for item in containers:
            if item['service'] == 'cms-worker' and item['state'] not in ('exited', 'created'):
                fail('worker_admission_forbidden')
            if item['service'] in ('nginx', 'api', 'cron', 'cms') and item['service'] not in ticket['containers'] and item['state'] not in ('exited', 'created'):
                fail('writer_identity_mismatch')
        for service, receipt in ticket['containers'].items():
            found = [c for c in containers if c['service'] == service]
            if len(found) != 1:
                fail('writer_identity_mismatch')
            observed, state, _ = self._writer_inspect(found[0]['id'], service, {'exited', 'running'})
            if observed != receipt:
                fail('writer_identity_mismatch')
            if state == 'exited' and (not readiness or service != 'cron'):
                pending.append(receipt['id'])
        for identity in pending:
            self._writer_command(['docker', 'start', identity], 'writer_start_command_failed')
        for service, receipt in ticket['containers'].items():
            if readiness and service == 'cron':
                continue
            for _ in range(180):
                observed, _, health = self._writer_inspect(receipt['id'], service, {'running'})
                if observed != receipt:
                    fail('writer_identity_mismatch')
                if health == 'healthy' or (service == 'nginx' and health == 'none'):
                    break
                if health != 'starting':
                    fail('writer_health_invalid')
                time.sleep(1)
            else:
                fail('writer_readiness_timeout')
        print('exact pre-stop writers resumed; admission closed and worker held')

    def install_receiver_preflight(self):
        # Permanent fail-closed integration boundary for this reviewed slice.
        # No environment toggle, fabricated receipt or JSON shape enables it.
        # A subsequent reviewed change must wire candidate verifier/register,
        # floor/pointer intent, fenced rollback and the B1 publication barrier.
        fail('release_not_preflighted')

    def portal_database_target(self):
        # Output is intentionally limited to the authenticated, identifier-safe
        # inventory value after the protected environment correspondence check.
        print(_verify_environment_file(self.inventory['document']))

    def _install_target(self, cms_bound):
        config = self.inventory['document']
        names = {'portalPostgres', 'portalUploads'}
        if cms_bound:
            names.add('cmsUploads')
        if _project_volumes() != sorted(config['volumes'][key]['name'] for key in names):
            fail('target_volume_inventory_mismatch')
        _verify_inventory_mounts(config, required_services={'postgres', 'cms'} if cms_bound else {'postgres'})
        portal = {'database': _database_identity('postgres', _portal_database(config)),
                  'volumes': {key: _volume_info(config['volumes'][key]['name'])
                              for key in ('portalPostgres', 'portalUploads')}}
        cms = None
        if cms_bound:
            cms = {'database': _database_identity('postgres', 'ownerinc_cms'),
                    'volumes': {'cmsUploads': _volume_info(config['volumes']['cmsUploads']['name'])}}
        return portal, cms

    def _install_role_verification(self):
        # One public-catalog, read-only contract covers all six CMS roles,
        # exact memberships and the configured Portal CONNECT fence. Never
        # fallback to --provision/bootstrap or fragmented role probes.
        args = _compose_args(self.release_path) + [
            'run', '--rm', '--no-deps', '--pull', 'never', '-T',
            'cms-provision', 'node', '--import', 'tsx', 'scripts/provision-db.ts', '--verify-cluster-roles',
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
            status = process.wait(timeout=RUNTIME_CHILD_WAIT_SECONDS)
        except (ControlError, OSError, subprocess.TimeoutExpired):
            _kill_and_reap_child(process, 'restored_storage_inspection_failed')
            raise
        if status != 0:
            fail('restored_storage_inspection_failed')
        return fingerprint

    def _install_origin_check(self):
        if 'recovery' in (self.state.get('installIntent') or {}):
            fail('install_recovery_invalid')
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
        if binding.get('bindingVersion') == 2 or \
           binding.get('bindingVersion') == 4 and binding.get('project', '').startswith('payload-preauth-'):
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
        portal_database = binding['portalTarget']['database']['databaseName']
        _assert_database_quiescent('postgres', portal_database)
        if _data_fingerprint('postgres') != proof['dataFingerprints']['portalDatabase']:
            fail('preauthority_source_database_changed')
        if self._install_upload_fingerprint() != proof['dataFingerprints']['portalUploads']:
            fail('restored_storage_fingerprint_mismatch')
        _assert_database_quiescent('postgres', portal_database)
        if cms_bound:
            _assert_database_quiescent('postgres', 'ownerinc_cms')
        if intent['stage'] in ('provisioned', 'private_started', 'private_ready', 'b1_committed',
                               'floor_commit_pending', 'floor_committed'):
            self._install_role_verification()
            _assert_database_quiescent('postgres', 'ownerinc_cms')
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
        production = config['project'] == 'ownerinc-portal-prod'
        if not production and not re.fullmatch(r'payload-preauth-[0-9]+-[0-9]+-[0-9a-f]{10}-(source|target|lease)', config['project']):
            fail('unsupported_compose_project')
        path = self.evidence if production else os.path.join(self.runtime_dir, 'payload-initialize-request.json')
        if self.evidence != path:
            fail('invalid_cold_state')
        if production:
            preliminary = STATE.parse_canonical(_read_bytes(path, mode=0o600, owner_root=True), 'invalid_cold_state')
            if not isinstance(preliminary, dict) or preliminary.get('kind') != 'payload-production-install-request-v1':
                fail('unsupported_compose_project')
        self._initializer_local_daemon()
        _safe_regular(config['paths']['currentRelease'], mode=0o600, owner_root=True)
        raw = _read_bytes(path, mode=0o600, owner_root=True)
        request = STATE.parse_canonical(raw, 'invalid_cold_state')
        if production:
            STATE._exact_keys(request, {'schemaVersion', 'kind', 'candidate', 'authority', 'inventoryIdentity',
                                       'sourceCommit', 'expiresAt', 'nonce'}, 'invalid_cold_state')
            existing = self.state.get('installIntent')
            request_now = int(time.time())
            current_release = self._current_release()
            expected_source_commit = (existing['binding']['sourceCommit'] if existing is not None
                                      else os.path.basename(current_release))
            if type(request['schemaVersion']) is not int or request['schemaVersion'] != 1 or \
               request['kind'] != 'payload-production-install-request-v1' or \
               request['inventoryIdentity'] != self.inventory['identity'] or \
               request['sourceCommit'] != expected_source_commit or \
               not isinstance(request['expiresAt'], str) or not re.fullmatch(r'[1-9][0-9]{9}', request['expiresAt']) or \
               not production_authorization_allows_resume(request['candidate'], existing, request_now) or \
               not isinstance(request['nonce'], str) or not STATE.HEX_64.fullmatch(request['nonce']):
                fail('invalid_cold_state')
            STATE._exact_keys(request['authority'], {'sourceApprovalSha256', 'policySha256', 'recordSha256'}, 'invalid_cold_state')
            if any(not isinstance(value, str) or not STATE.HEX_64.fullmatch(value) for value in request['authority'].values()):
                fail('invalid_cold_state')
            candidate = STATE.validate_install_candidate(request['candidate'])
            images, payload = _release(self.release_path, payload=True, owner_root=True)
            if not payload or images != candidate['images'] or os.path.basename(self.release_path) != candidate['commit']:
                fail('planned_release_mismatch')
            source = existing['binding']['sourceRelease'] if existing is not None else current_release
            if existing is not None and current_release not in (source, existing['binding']['candidateRelease']):
                fail('current_release_invalid')
            self.production_authorization_expires_at = request['expiresAt']
            source_images, source_payload = _release(source, payload=False, owner_root=True)
            if source_payload or os.path.basename(source) != request['sourceCommit']:
                fail('preauthority_source_recovery_proof_mismatch')
            lease = os.stat(config['paths']['lock'])
            return {'bindingVersion': 4, 'candidate': candidate, 'candidateRelease': self.release_path,
                    'sourceRelease': source, 'previousImages': source_images,
                    'b0': {'directory': os.path.join(config['paths']['backupRoots'][0], '000-initial-install-b0'),
                           'proofSha256': self.state['legacySourceProofSha256']},
                    'inventoryIdentity': self.inventory['identity'], 'lease': {'device': lease.st_dev, 'inode': lease.st_ino},
                    'authority': request['authority'], 'sourceCommit': request['sourceCommit'], 'project': config['project'],
                    'sharedCluster': config['databaseCluster'],
                    'portalTarget': self.state['installIntent']['binding']['portalTarget'] if self.state.get('installIntent') else self._install_target(False)[0]}
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
        template = {'bindingVersion': 4, 'candidate': candidate, 'candidateRelease': self.release_path,
                    'sourceRelease': source, 'previousImages': source_images,
                    # Sort before coordinated timestamp backups; existing
                    # newestBackup selection must never accidentally pick B0.
                    'b0': {'directory': os.path.join(config['paths']['backupRoots'][0], '000-initial-install-b0'),
                           'proofSha256': self.state['legacySourceProofSha256']},
                    'inventoryIdentity': self.inventory['identity'],
                     'lease': {'device': lease.st_dev, 'inode': lease.st_ino},
                     'authority': {
                         'sourceApprovalSha256': self.state['legacySourceProofSha256'] or '0' * 64,
                         'policySha256': self.inventory['identity'],
                         'recordSha256': candidate['candidateSha256'],
                     },
                     'sourceCommit': os.path.basename(source),
                     'project': config['project'],
                     'sharedCluster': config['databaseCluster'],
                     'portalTarget': intent['binding']['portalTarget'] if intent else self._install_target(False)[0]}
        return template

    def _initializer_command(self, args, output=None, evidence_prefix='payload-initialize-command'):
        self.initializer_command_exit = None
        self.initializer_command_signal = None
        self.initializer_stderr_retained = False
        # Stream unknown tool stderr to a private temporary file, never parent
        # stderr. Only a bounded tail survives failure, in an exclusive 0600 file.
        with tempfile.TemporaryFile(dir=self.runtime_dir) as private_stderr:
            try:
                result = subprocess.run(args, stdout=output if output is not None else subprocess.PIPE,
                                        stderr=private_stderr, check=False,
                                        **({'pass_fds': (9,)} if os.name != 'nt' else {}))
            except OSError:
                fail('initializer_command_launch_failed')
            if result.returncode != 0:
                try:
                    private_stderr.seek(0, os.SEEK_END)
                    private_stderr.seek(max(0, private_stderr.tell() - 16 * 1024))
                    raw = private_stderr.read(16 * 1024)
                    if raw:
                        STATE._write_exclusive(os.path.join(self.runtime_dir,
                            evidence_prefix + '-' + secrets.token_hex(16) + '.stderr'), raw, 0o600)
                        self.initializer_stderr_retained = True
                except (OSError, STATE.StateError):
                    pass  # Never replace the primary failure with evidence read/write failure.
        if result.returncode != 0:
            if result.returncode < 0:
                self.initializer_command_signal = -result.returncode
                fail('initializer_command_signaled')
            self.initializer_command_exit = result.returncode
            fail('initializer_command_failed')
        return result.stdout if output is None else None

    def _initializer_phase(self, phase):
        if phase not in INITIALIZER_DIAGNOSTIC_PHASES:
            fail('unsupported_operation')
        self.initializer_phase = phase
        self.initializer_command_exit = None
        self.initializer_command_signal = None
        self.initializer_stderr_retained = False

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
        self._initializer_phase('b0_ancestry')
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
        self._initializer_phase('b0_database_capture')
        capture('postgres.dump', ['docker', 'exec', _container_id('postgres'), 'sh', '-ceu',
                                 'pg_dump --format=custom --dbname="$1" --username="$POSTGRES_USER"',
                                 'portal-database', _portal_database(self.inventory['document'])])
        self._initializer_phase('b0_storage_capture')
        capture('uploads.tar.gz', ['docker', 'run', '--rm', '--read-only', '--network', 'none', '--pull', 'never',
                '--volume', self.inventory['document']['volumes']['portalUploads']['name'] + ':/data:ro',
                'nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752',
                'tar', '-czf', '-', '-C', '/data', '.'])
        self._initializer_phase('b0_manifest')
        manifest = ''.join(_file_hash(os.path.join(directory, name))['sha256'] + '  ' + name + '\n'
                           for name in STATE.LEGACY_ARTIFACTS)
        STATE._write_exclusive(os.path.join(directory, 'manifest.sha256'), manifest.encode('ascii'), 0o600)
        self.evidence = os.path.join(directory, 'preauthority-proof.json')
        self._initializer_phase('b0_sign')
        self.backup_metadata()
        self.evidence = directory

    def _creation_overlay(self):
        nonce = self.state['installIntent']['creation']['nonce']
        shared = self.state['installIntent']['binding'].get('bindingVersion') == 4
        services = ('cms', 'api', 'cron') if shared else ('cms-postgres', 'cms')
        document = {'services': {service: {'labels': {'io.ownerinc.install-reservation': nonce}}
                                for service in services}}
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
        expected_image = intent['binding']['candidate']['images'].get(service)
        if service == 'cms-postgres':
            expected_image = 'postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'
        if not isinstance(value.get('Id'), str) or not STATE.HEX_64.fullmatch(value['Id']) or \
           image != expected_image or labels.get('com.docker.compose.project') != self.inventory['document']['project'] or \
           labels.get('com.docker.compose.service') != service or \
           labels.get('io.ownerinc.install-reservation') != intent['creation']['nonce']:
            fail('restore_target_changed')
        fingerprint = hashlib.sha256(STATE.canonical({
            'id': value['Id'], 'image': image, 'labels': labels,
            'created': value.get('Created'), 'mounts': value.get('Mounts'),
        })).hexdigest()
        receipt = {'id': value['Id'], 'image': image, 'fingerprint': fingerprint}
        if intent['binding'].get('bindingVersion') in (3, 4):
            receipt.update(releasePath=intent['binding']['candidateRelease'], creationState='created')
        return receipt

    def _creation_boundary(self):
        intent, proof, images, source_images = self._install_origin_check()
        _verify_portal(self.release_path, 'strict')
        if _database_identity('postgres', _portal_database(self.inventory['document'])) != intent['binding']['portalTarget']['database'] or \
           any(_volume_info(self.inventory['document']['volumes'][key]['name']) != value
               for key, value in intent['binding']['portalTarget']['volumes'].items()):
            fail('restore_target_changed')
        _verify_inventory_mounts(self.inventory['document'], required_services={'postgres'})
        if _data_fingerprint('postgres') != proof['dataFingerprints']['portalDatabase'] or \
           self._install_upload_fingerprint() != proof['dataFingerprints']['portalUploads']:
            fail('preauthority_source_database_changed')
        intent = self.state['installIntent']
        receipts = intent['creation']
        shared = intent['binding'].get('bindingVersion') == 4
        config = self.inventory['document']
        expected = {config['volumes'][name]['name'] for name in ('portalPostgres', 'portalUploads')}
        expected |= {value['name'] for value in receipts['volumes'].values()}
        if set(_project_volumes()) != expected:
            fail('restore_target_changed')
        for key in (('cmsUploads',) if shared else ('cmsPostgres', 'cmsUploads')):
            name = config['volumes'][key]['name']
            if key not in receipts['volumes'] and name in _all_volume_names():
                fail('restore_target_changed')
        containers = _container_inventory()
        for container in containers:
            if container['service'].startswith('cms') and container['service'] not in receipts['containers']:
                fail('restore_target_changed')
            if container['state'] in ('running', 'restarting', 'paused') and container['service'] not in ({'postgres'} if shared else {'postgres', 'cms-postgres'}):
                fail('writers_not_quiescent')
        self._install_container_images(containers, images, source_images)
        for key, receipt in receipts['volumes'].items():
            if self._creation_volume(key) != receipt:
                fail('restore_target_changed')
        for service, receipt in receipts['containers'].items():
            if self._creation_container(service) != receipt:
                fail('restore_target_changed')
        _assert_database_quiescent('postgres')

    def _wait_initial_database(self, service):
        container = _container_id(service, running=False)
        for _attempt in range(180):
            result = self._initializer_command(['docker', 'inspect', '--format', '{{.State.Health.Status}}', container])
            if result.strip() == b'healthy':
                return
            time.sleep(1)
        fail('cms_database_container_unavailable')

    def _initialize_resources(self):
        intent = self.state['installIntent']
        binding = intent['binding']
        shared = binding.get('bindingVersion') == 4
        self._initializer_phase('resources_boundary')
        self._creation_boundary()
        for key in (('cmsUploads',) if shared else ('cmsPostgres', 'cmsUploads')):
            if key not in self.state['installIntent']['creation']['volumes']:
                entry = self.inventory['document']['volumes'][key]
                self._initializer_phase('resources_boundary')
                self._creation_boundary()
                self._initializer_phase('volume_create')
                output = self._initializer_command(['docker', 'volume', 'create', '--driver', 'local',
                    '--label', 'com.docker.compose.project=' + self.inventory['document']['project'],
                    '--label', 'com.docker.compose.volume=' + entry['composeKey'],
                    '--label', 'io.ownerinc.install-reservation=' + intent['creation']['nonce'], entry['name']])
                if output.strip().decode('ascii') != entry['name']:
                    fail('restore_target_changed')
                self._initializer_phase('volume_receipt')
                self.state = STATE.record_install_creation(self.runtime_dir, binding, 'volumes', key, self._creation_volume(key))
        for service in (('cms', 'api', 'cron') if shared else ('cms-postgres', 'cms')):
            if service not in self.state['installIntent']['creation']['containers']:
                self._initializer_phase('resources_boundary')
                self._creation_boundary()
                self._initializer_phase('container_create')
                # `compose create` has no --no-deps flag. `up --no-start`
                # provides create-only semantics with dependency isolation;
                # do not drop --no-deps and accidentally create unbound services.
                self._initializer_compose(['up', '--no-start', '--no-recreate', '--no-build', '--no-deps', '--pull', 'never', service], creation=True)
                self._initializer_phase('container_receipt')
                self.state = STATE.record_install_creation(self.runtime_dir, binding, 'containers', service, self._creation_container(service))
        self._initializer_phase('resources_boundary')
        self._creation_boundary()
        self._initializer_phase('database_start')
        if shared:
            self._initializer_compose(['--profile', 'cms-bootstrap', 'run', '--rm', '--no-deps', '--pull', 'never', '-T', 'cms-cluster-bootstrap'])
        else:
            self._initializer_command(['docker', 'start', self.state['installIntent']['creation']['containers']['cms-postgres']['id']])
        self._initializer_phase('database_readiness')
        self._wait_initial_database('postgres' if shared else 'cms-postgres')
        self._initializer_phase('database_binding')
        portal, cms = self._install_target(True)
        if portal != binding['portalTarget']:
            fail('restore_target_changed')
        self.state = STATE.advance_install(self.runtime_dir, binding, 'cms_resources_bound', cms)

    def _initial_floor_observations(self):
        self._initializer_phase('floor_boundary')
        self.install_retry_check()
        intent = self.state['installIntent']
        if 'creation' in intent:
            self._creation_boundary()
        for service in ('api', 'cron', 'cms'):
            self._verify_container_image(intent['binding']['candidate']['images'], service, running=False)
        self._initializer_phase('floor_roles')
        self._install_role_verification()
        self._initializer_phase('floor_runtime')
        self._initializer_compose(['run', '--rm', '--no-deps', '--pull', 'never', '-T', 'cms',
                                  'node', '--import', 'tsx', 'scripts/provision-db.ts', '--verify-runtime'])
        self._initializer_phase('floor_native_catalog')
        catalog = _verify_cms(self.release_path, catalog=True)
        _assert_database_quiescent('postgres', 'ownerinc_cms')
        _assert_database_quiescent('postgres')
        return catalog['nativeCatalogFingerprint']

    def _private_cms_readiness(self, start=True):
        intent = self.state['installIntent']
        receipt = intent['creation']['containers']['cms']
        if start:
            self._initializer_phase('private_start')
            observed = self._creation_container('cms')
            if observed != receipt:
                fail('restore_target_changed')
            status = self._initializer_command(['docker', 'inspect', '--format', '{{.State.Status}}', receipt['id']]).strip()
            if status == b'created' or status == b'exited':
                self._initializer_command(['docker', 'start', receipt['id']])
            elif status != b'running':
                fail('restore_target_changed')
        self._initializer_phase('private_readiness')
        for _attempt in range(180):
            health = self._initializer_command(['docker', 'inspect', '--format', '{{.State.Status}} {{.State.Health.Status}}', receipt['id']]).strip()
            if health == b'running healthy':
                break
            if not health.startswith(b'running starting'):
                fail('private_readiness_failed')
            time.sleep(1)
        else:
            fail('private_readiness_timeout')
        containers = _container_inventory()
        if any(item['service'] in ('api', 'cron', 'nginx') and item['state'] in ('running', 'restarting', 'paused')
               for item in containers):
            fail('writers_not_quiescent')

    def _capture_install_b1(self):
        intent = self.state['installIntent']
        binding = intent['binding']
        directory = os.path.join(self.inventory['document']['paths']['backupRoots'][0], '001-initial-install-b1')
        portal_database = _portal_database(self.inventory['document'])
        binding_sha256 = hashlib.sha256(STATE.canonical(binding)).hexdigest()
        def sync_directory():
            info = os.lstat(directory)
            if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or \
               (os.name != 'nt' and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (0, 0, 0o700)):
                fail('unsafe_backup_artifact')
            descriptor = os.open(directory, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0))
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        def completed_receipt():
            proof_path = os.path.join(directory, 'b1-proof.json')
            raw = _read_bytes(proof_path, mode=0o600, owner_root=True)
            envelope = STATE.parse_canonical(raw, 'invalid_backup_proof')
            body = STATE.verify_envelope(envelope, self.key, lambda value: value, 'invalid_backup_proof')
            STATE._exact_keys(body, {'schemaVersion', 'kind', 'installBindingSha256', 'inventoryIdentity', 'candidate',
                                    'authority', 'artifacts', 'portalDatabase', 'cmsDatabase', 'authorityState',
                                    'workerHeld', 'routeReleased'}, 'invalid_backup_proof')
            if type(body['schemaVersion']) is not int or body['schemaVersion'] != 1 or \
               body['kind'] != 'payload-private-install-b1-v1' or body['installBindingSha256'] != binding_sha256 or \
               body['inventoryIdentity'] != binding['inventoryIdentity'] or body['candidate'] != binding['candidate'] or \
               body['authority'] != binding['authority'] or body['portalDatabase'] != _database_identity('postgres', portal_database) or \
               body['cmsDatabase'] != _database_identity('postgres', 'ownerinc_cms') or \
               body['authorityState'] != {'mode': 'legacy', 'epoch': 1} or body['workerHeld'] is not True or \
               body['routeReleased'] is not False or not isinstance(body['artifacts'], list) or \
               [item.get('name') for item in body['artifacts'] if isinstance(item, dict)] != STATE.PAYLOAD_ARTIFACTS:
                fail('restore_target_changed')
            for item in body['artifacts']:
                STATE._exact_keys(item, {'name', 'sha256', 'size'}, 'invalid_backup_proof')
                artifact_path = os.path.join(directory, item['name'])
                info = os.lstat(artifact_path)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or \
                   (os.name != 'nt' and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (0, 0, 0o600)) or \
                   _file_hash(artifact_path) != {'sha256': item['sha256'], 'size': item['size']}:
                    fail('backup_artifact_mismatch')
            return {'directory': directory, 'proofSha256': hashlib.sha256(raw).hexdigest()}
        if os.path.lexists(directory):
            sync_directory()
            if os.path.lexists(os.path.join(directory, 'b1-proof.json')):
                return completed_receipt()
        else:
            INVENTORY._verify_ancestry(os.path.join(os.path.dirname(directory), 'capture'), {0}, 'unsafe_inventory_ancestry')
            os.mkdir(directory, 0o700)
            sync_directory()
        def capture(name, args):
            destination = os.path.join(directory, name)
            if os.path.lexists(destination):
                info = os.lstat(destination)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or \
                   (os.name != 'nt' and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (0, 0, 0o600)):
                    fail('unsafe_backup_artifact')
                return
            pending = os.path.join(directory, '.pending-' + name)
            if os.path.lexists(pending):
                info = os.lstat(pending)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or \
                   (os.name != 'nt' and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) != (0, 0, 0o600)):
                    fail('unsafe_backup_artifact')
                os.unlink(pending)
                sync_directory()
            with os.fdopen(os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                                   getattr(os, 'O_NOFOLLOW', 0), 0o600), 'wb') as stream:
                self._initializer_command(args, output=stream, evidence_prefix='payload-b1-command')
                stream.flush(); os.fsync(stream.fileno())
            os.rename(pending, destination)
            sync_directory()
        self._initializer_phase('b1_capture')
        capture('postgres.dump', ['docker', 'exec', _container_id('postgres'), 'sh', '-ceu',
            'pg_dump --format=custom --dbname="$1" --username="$POSTGRES_USER"', 'portal-database', portal_database])
        capture('cms.dump', ['docker', 'exec', _container_id('postgres'), 'sh', '-ceu',
            'pg_dump --format=custom --dbname=ownerinc_cms --username="$POSTGRES_USER"'])
        for filename, key in (('uploads.tar.gz', 'portalUploads'), ('cms-uploads.tar.gz', 'cmsUploads')):
            capture(filename, ['docker', 'run', '--rm', '--read-only', '--network', 'none', '--pull', 'never',
                '--volume', self.inventory['document']['volumes'][key]['name'] + ':/data:ro',
                'nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752',
                'tar', '-czf', '-', '-C', '/data', '.'])
        artifacts = [{'name': name, **_file_hash(os.path.join(directory, name))} for name in STATE.PAYLOAD_ARTIFACTS]
        self._initializer_phase('b1_sign')
        proof = {'schemaVersion': 1, 'kind': 'payload-private-install-b1-v1',
                 'installBindingSha256': binding_sha256,
                 'inventoryIdentity': binding['inventoryIdentity'], 'candidate': binding['candidate'],
                 'authority': binding['authority'], 'artifacts': artifacts,
                 'portalDatabase': _database_identity('postgres', portal_database),
                 'cmsDatabase': _database_identity('postgres', 'ownerinc_cms'),
                 'authorityState': {'mode': 'legacy', 'epoch': 1}, 'workerHeld': True, 'routeReleased': False}
        path = os.path.join(directory, 'b1-proof.json')
        digest = _write_private_proof(path, STATE.sign_envelope(proof, self.key))
        sync_directory()
        receipt = completed_receipt()
        if receipt['proofSha256'] != digest:
            fail('invalid_backup_proof')
        return receipt

    def install_floor_commit(self):
        self._initializer_phase('floor_boundary')
        self._admission_closed()
        intent = self.state.get('installIntent')
        if intent is None or intent['stage'] not in ('provisioned', 'b1_committed', 'floor_commit_pending', 'floor_committed'):
            fail('invalid_cold_state')
        binding = intent['binding']
        production = binding.get('bindingVersion') == 4 and binding.get('project') == 'ownerinc-portal-prod'
        self.evidence = binding['b0']['directory']
        if intent['stage'] == 'floor_committed':
            if production:
                self._initializer_phase('private_final')
                self._private_cms_readiness()
            fingerprint = intent['floor']['nativeCatalogFingerprint']
            if fingerprint != intent['floor']['nativeCatalogFingerprint'] or \
               self.state['releaseImages'] != binding['candidate']['images'] or \
               self.state['nativeCatalogFingerprint'] != fingerprint:
                fail('release_state_mismatch')
            print('exact signed committed floor reverified; admission remains closed and worker held')
            return
        fingerprint = self._initial_floor_observations()
        if intent['stage'] == 'provisioned':
            self._initializer_phase('floor_pending')
            self.state = STATE.begin_install_floor(self.runtime_dir, binding, fingerprint)
        elif fingerprint != intent['floor']['nativeCatalogFingerprint']:
            fail('native_catalog_fingerprint_missing')
        pointer = self.inventory['document']['paths']['currentRelease']
        self._initializer_phase('floor_pointer_swap')
        _safe_regular(pointer, mode=0o600, owner_root=True)
        # Full prevalidation has completed before any pointer write. The signed
        # pending marker is durable first, and permits ONLY this exact window.
        if self._current_release() == binding['sourceRelease']:
            STATE._atomic_replace(pointer, (binding['candidateRelease'] + '\n').encode('utf-8'), 0o600)
        elif self._current_release() != binding['candidateRelease']:
            fail('current_release_invalid')
        observed_fingerprint = self._initial_floor_observations()
        self._initializer_phase('floor_postcheck')
        if observed_fingerprint != fingerprint or self._current_release() != binding['candidateRelease']:
            fail('current_release_invalid')
        self._initializer_phase('floor_commit')
        self.state = STATE.commit_install_floor(self.runtime_dir, binding)
        if production:
            self._initializer_phase('private_final')
            self._private_cms_readiness()
        print('native preauthority floor committed with signed audit; admission closed and worker held')

    def _reserve_install_intent(self, template, proof, digest, creation):
        production = template.get('bindingVersion') == 4 and template.get('project') == 'ownerinc-portal-prod'
        expires_at = getattr(self, 'production_authorization_expires_at', None) if production else None
        return STATE.reserve_install(
            self.runtime_dir, template, proof, digest, creation=creation,
            authorization_expires_at=expires_at)

    def initialize_isolated(self):
        self._initializer_phase('request_validation')
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
                self._initializer_phase('source_preflight')
                self.release_preflight()
                self._initializer_phase('close_admission')
                self.close_admission()
                if not os.path.lexists(self.closed):
                    STATE._write_exclusive(self.closed, b'', 0o600)
                self._initializer_phase('stop_writers')
                self._initializer_compose(['stop', '--timeout', '120', 'nginx', 'api', 'cron', 'cms'])
                self._initializer_phase('quiescence')
                self.quiescence_proof()
                self._capture_initial_b0(template['b0']['directory'])
            self._initializer_phase('b0_validate')
            self._admission_closed()
            proof, digest = _parse_proof(template['b0']['directory'], self.key, payload=False)
            template['b0']['proofSha256'] = digest
            if template['project'] != 'ownerinc-portal-prod':
                template['authority']['sourceApprovalSha256'] = digest
            if digest != self.state['legacySourceProofSha256'] or digest != self.state['latestProofSha256']:
                fail('preauthority_source_recovery_proof_mismatch')
            self._initializer_phase('install_reserve')
            self.state = self._reserve_install_intent(
                template, proof, digest, STATE.production_install_creation(template, secrets.token_hex(32)))
        binding = self.state['installIntent']['binding']
        production = binding.get('bindingVersion') == 4 and binding.get('project') == 'ownerinc-portal-prod'
        self.evidence = binding['b0']['directory']
        def advance(stage):
            self._initializer_phase('install_advance')
            self.state = STATE.advance_install(self.runtime_dir, binding, stage)
        stage = self.state['installIntent']['stage']
        if stage == 'reserved':
            self._initializer_phase('retry_boundary')
            self.install_retry_check()
            advance('portal_grants_pending')
        if self.state['installIntent']['stage'] == 'portal_grants_pending':
            self._initializer_phase('retry_boundary')
            self.install_retry_check()
            self._initializer_phase('portal_grants_migrate')
            self._initializer_compose(['run', '--rm', '--no-deps', '--pull', 'never', '-T', 'migrate'])
            self._initializer_phase('portal_grants_verify')
            self._initializer_compose(['run', '--rm', '--no-deps', '--pull', 'never', '-T',
                '-e', 'RUN_MIGRATIONS=false', '-e', 'MIGRATION_ONLY=false', 'migrate', 'node', 'db/verify-migrations.js'])
            _verify_portal(self.release_path, 'strict')
            self._initializer_phase('portal_grants_postcheck')
            self.install_retry_check()
            advance('portal_grants_verified')
        if self.state['installIntent']['stage'] == 'portal_grants_verified':
            self._initializer_phase('retry_boundary')
            self.install_retry_check()
            advance('cms_resources_pending')
        if self.state['installIntent']['stage'] == 'cms_resources_pending':
            # Partial resources are acceptable only with their creator receipts;
            # no cold shape bypass or inferred binding on this retry path.
            self._initialize_resources()
        if self.state['installIntent']['stage'] == 'cms_resources_bound':
            self._initializer_phase('retry_boundary')
            self.install_retry_check()
            advance('cms_provision_pending')
        if self.state['installIntent']['stage'] == 'cms_provision_pending':
            self._initializer_phase('retry_boundary')
            self.install_retry_check()
            self._initializer_phase('resources_boundary')
            self._creation_boundary()
            self._initializer_phase('cms_provision')
            self._initializer_compose(['run', '--rm', '--no-deps', '--pull', 'never', '-T', 'cms-provision'])
            self._initializer_phase('cms_control_bootstrap')
            self._initializer_compose(['--profile', 'cms-control-roles', 'run', '--rm', '--no-deps', '--pull', 'never', '-T',
                'cms-control-roles', 'node', '--import', 'tsx', 'scripts/provision-db.ts', '--bootstrap-control'])
            self._initializer_phase('cms_migrate')
            self._initializer_compose(['run', '--rm', '--no-deps', '--pull', 'never', '-T', 'cms-migrate'])
            self._initial_floor_observations()
            advance('provisioned')
        if production and self.state['installIntent']['stage'] == 'provisioned':
            self._private_cms_readiness()
            advance('private_started')
        if production and self.state['installIntent']['stage'] == 'private_started':
            self._private_cms_readiness()
            advance('private_ready')
        if production and self.state['installIntent']['stage'] == 'private_ready':
            self._initializer_phase('private_stop')
            receipt = self.state['installIntent']['creation']['containers']['cms']
            status = self._initializer_command(['docker', 'inspect', '--format', '{{.State.Status}}', receipt['id']]).strip()
            if status == b'running':
                self._initializer_command(['docker', 'stop', '--time', '120', receipt['id']])
            elif status not in (b'exited', b'created'):
                fail('restore_target_changed')
            self.install_retry_check()
            b1 = self._capture_install_b1()
            self.state = STATE.advance_install(self.runtime_dir, binding, 'b1_committed', b1=b1)
        self.install_floor_commit()

    def run(self):
        if self.action == 'portal-database-target': return self.portal_database_target()
        if self.action == 'observe-writers': return self.observe_writers()
        if self.action == 'resume-writers': return self.resume_writers()
        if self.action == 'resume-readiness-writers': return self.resume_writers(readiness=True)
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
    runtime = None
    try:
        if os.name != 'nt':
            os.environ['PATH'] = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
            os.environ['HOME'] = '/root'
        runtime = Runtime(action, release, evidence)
        runtime.run()
    except (ControlError, STATE.StateError) as error:
        _emit_control_error(error, release)
        if action in ('initialize-isolated', 'install-floor-commit'):
            _emit_initializer_diagnostic(runtime, error)
        return 2
    except Exception:
        if action in ('initialize-isolated', 'install-floor-commit'):
            print('initializer_internal_error', file=sys.stderr)
            _emit_initializer_diagnostic(runtime)
        else:
            print('Payload control failed closed.', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
