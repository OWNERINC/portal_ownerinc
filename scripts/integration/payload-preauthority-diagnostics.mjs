import {
  closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, realpathSync,
} from 'node:fs';
import path from 'node:path';
import { logicalSnapshotErrorCodes } from './payload-logical-snapshot.mjs';

const safeSubstepPattern = /^[a-z][a-z0-9_]{0,63}$/u;

const sqlStateIdentifiers = Object.freeze({
  '08001': 'connection_unavailable',
  '08006': 'connection_failure',
  '22001': 'string_data_right_truncation',
  '22007': 'invalid_datetime_format',
  '22021': 'character_not_in_repertoire',
  '22023': 'invalid_parameter_value',
  '23502': 'not_null_violation',
  '23503': 'foreign_key_violation',
  '23505': 'unique_violation',
  '23514': 'check_violation',
  '28P01': 'invalid_password',
  '3D000': 'database_not_found',
  '42501': 'insufficient_privilege',
  '42601': 'syntax_error',
  '42804': 'datatype_mismatch',
  '42883': 'undefined_function',
  '42P01': 'undefined_table',
  '42P07': 'duplicate_table',
  '42703': 'undefined_column',
  '42710': 'duplicate_object',
  '57014': 'query_canceled',
  '58P01': 'undefined_file',
  '0A000': 'feature_not_supported',
});

const processErrorIdentifiers = Object.freeze({
  EACCES: 'permission_denied',
  ENOENT: 'executable_not_found',
  ETIMEDOUT: 'command_timeout',
  ENOBUFS: 'output_limit_exceeded',
});

const controlCommandContexts = new Set([
  'payload-control:release-preflight',
  'payload-control:verify-release',
]);
const initializerContexts = new Map([
  ['payload-control:initialize-isolated', 'payload_initialize_isolated'],
  ['payload-control:install-floor-commit', 'payload_install_floor_commit'],
]);
export const initializerDiagnosticPhases = Object.freeze(`
runtime_validation request_validation source_preflight close_admission stop_writers quiescence
b0_ancestry b0_database_capture b0_storage_capture b0_manifest b0_sign b0_validate install_reserve
retry_boundary portal_grants_migrate portal_grants_verify portal_grants_postcheck install_advance
resources_boundary volume_create volume_receipt container_create container_receipt database_start
database_readiness database_binding cms_provision cms_control_bootstrap cms_migrate
floor_boundary floor_roles floor_runtime floor_native_catalog floor_pending floor_pointer_swap floor_postcheck floor_commit
`.trim().split(/\s+/u));
const initializerStages = new Set(`none reserved portal_grants_pending portal_grants_verified
cms_resources_pending cms_resources_bound cms_provision_pending provisioned floor_commit_pending floor_committed`.split(/\s+/u));
const processSignals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGHUP', 'SIGABRT', 'SIGSEGV']);
const initializerErrorIdentifiers = new Set([
  'initializer_command_failed', 'initializer_command_launch_failed', 'initializer_command_signaled', 'initializer_internal_error',
]);
// These are the finite fixed reason codes emitted by payload-control-runtime.py,
// payload-control-state.py and payload-control-inventory.py. Keep parsing gated
// to the known adapter contexts above; never infer identifiers from arbitrary
// subprocess stderr.
const controlErrorIdentifiers = new Set(`
active_release_state_mismatch admission_open_forbidden admission_sentinel_stale
backup_artifact_mismatch backup_artifact_unavailable backup_evidence_required backup_format_invalid
backup_image_manifest_mismatch backup_inventory_identity_untrusted backup_manifest_invalid backup_manifest_mismatch
backup_release_mismatch backup_requires_closed_admission backup_root_override_forbidden cms_database_container_unavailable
cms_migration_fingerprint_mismatch cms_migration_floor_mismatch cold_source_not_legacy
control_compose_configuration_mismatch control_compose_configuration_missing current_release_invalid
database_archive_validation_failed database_container_ambiguous database_fingerprint_failed
database_fingerprint_unsupported_relation database_identity_mismatch database_inspection_failed
database_metadata_invalid database_sessions_not_quiescent docker_endpoint_override_forbidden
docker_inventory_unavailable docker_volume_inventory_unavailable duplicate_inventory_field duplicate_json_field environment_unavailable
host_control_requires_root invalid_admission_state invalid_cold_state invalid_data_fingerprints
invalid_database_identity invalid_environment_file_owner invalid_inventory_backup_paths invalid_inventory_file invalid_inventory_mounts
invalid_inventory_operational_paths invalid_inventory_path invalid_inventory_paths invalid_inventory_project
invalid_inventory_shape invalid_inventory_trust invalid_inventory_volume_name invalid_inventory_volumes
invalid_json_constant invalid_json_value invalid_legacy_proof_migrations invalid_legacy_proof_source
invalid_migrated_state invalid_native_catalog_fingerprint invalid_private_key invalid_proof_artifacts
invalid_proof_inventory_identity invalid_proof_output_path invalid_proof_source invalid_proof_timestamp
invalid_release_images invalid_release_manifest invalid_release_path invalid_restore_intent invalid_restore_target
invalid_restore_target_fingerprints invalid_restore_volumes invalid_rollback_state invalid_state_digest
invalid_state_inventory_identity invalid_state_parent invalid_state_sequence inventory_runtime_path_mismatch
inventory_unavailable inventory_write_failed legacy_fallback_forbidden native_catalog_fingerprint_missing
native_catalog_verification_failed native_catalog_verification_invalid native_catalog_verifier_launch_failed
native_catalog_verifier_execution_failed noncanonical_inventory noncanonical_json
one_shot_container_running operation_lease_inode_mismatch operation_lease_missing
operator_compose_override_forbidden planned_release_mismatch portal_database_container_unavailable
portal_legacy_floor_mismatch portal_legacy_session_grant_floor_mismatch portal_migration_fingerprint_mismatch
portal_migration_floor_mismatch portal_restore_grants_not_reverified portal_restore_stage_invalid
portal_session_grant_state_ambiguous portal_session_grant_state_invalid
portal_session_v2_grants_unprovisioned_or_mismatched preauthority_source_database_changed
preauthority_source_recovery_proof_mismatch preauthority_source_recovery_proof_required
private_state_already_exists private_state_directory_unavailable private_state_file_unavailable
private_state_initialization_failed private_state_write_failed production_inventory_mismatch
proof_output_already_exists proof_output_required protection_backup_root_override_forbidden
release_container_image_mismatch release_image_manifest_mismatch release_not_preflighted
release_service_not_running release_state_mismatch required_path_unavailable restore_image_binding_mismatch
restore_intent_missing restore_inventory_identity_changed restore_proof_changed restore_release_mismatch
restore_requires_migrated_preauthority restore_target_changed restore_target_content_changed
restored_database_fingerprint_mismatch restored_native_catalog_fingerprint_mismatch
restored_portal_database_fingerprint_mismatch restored_storage_fingerprint_mismatch
restored_storage_inspection_failed rollback_cms_image_floor_mismatch rollback_requires_closed_admission
signature_invalid signature_key_mismatch signed_admission_not_closed signed_admission_not_open
proof_not_canonical proof_shape_invalid state_head_corrupt state_head_mismatch state_helper_unavailable
state_inventory_identity_mismatch state_journal_corrupt
state_parent_mismatch target_mount_inspection_failed target_service_mount_mismatch target_service_mount_missing
target_volume_invalid target_volume_inventory_mismatch target_volume_unavailable trusted_source_identity_mismatch
trusted_source_not_authorized unexpected_cold_cms_container unexpected_cold_cms_volume
unexpected_cold_volume_inventory unexpected_preauthority_news_rows unknown_project_container
unsafe_admission_sentinel unsafe_backup_artifact unsafe_backup_directory
unsafe_environment_ancestry unsafe_environment_file unsafe_environment_owner unsafe_environment_permissions
unsafe_inventory_ancestry unsafe_inventory_destination
unsafe_inventory_file unsafe_inventory_permissions unsafe_private_key unsafe_private_state_directory
unsafe_private_state_file unsafe_private_state_path unsafe_private_state_permissions unsafe_required_owner
unsafe_required_path unsafe_required_permissions unsafe_storage_archive unsupported_authority_state
unsupported_cms_state unsupported_compose_project unsupported_inventory_version unsupported_operation
unsupported_portal_grant_mode unsupported_proof_authority unsupported_proof_kind unsupported_proof_phase
unsupported_proof_shape unsupported_protocol_present_or_mixed unsupported_protocol_state unsupported_release_format
unsupported_state_phase worker_admission_forbidden writers_not_quiescent
admission_state_not_closed admission_state_not_open
`.trim().split(/\s+/u));
const controlAdapterMessages = new Map([
  ['Invalid Payload control invocation.', 'control_invocation_invalid'],
  ['Payload control helpers are unavailable.', 'control_helpers_unavailable'],
  ['Payload control failed closed.', 'control_failed_closed'],
]);
const controlGuardMessages = new Map([
  ['Guard requires inherited exclusive operation lease', 'guard_operation_lease_required'],
  ['Durable Payload control adapter not integrated', 'guard_control_adapter_not_integrated'],
  ['Unsafe Payload admission sentinel', 'guard_admission_sentinel_unsafe'],
  ['A project writer is still running; no drain proof', 'guard_writer_still_running'],
  ['Unknown Payload guard action', 'guard_action_unknown'],
]);
const controlGuardContext = 'payload-operations-guard';
const coordinatorContexts = new Set(['payload-coordinator:backup', 'payload-coordinator:restore']);
const coordinatorGuardSteps = new Set(`
guard_release_preflight guard_close_admission guard_quiescence_proof guard_backup_metadata
guard_verify_release guard_open_admission guard_restore_preflight guard_portal_restore_intermediate
guard_verify_restored guard_prepare_restore_portal guard_prepare_restore_cms
guard_prepare_restore_api_clear guard_prepare_restore_api_extract
guard_prepare_restore_cms_clear guard_prepare_restore_cms_extract guard_prepare_restore_cms_migrate
`.trim().split(/\s+/u));
export const coordinatorDiagnosticSteps = Object.freeze([
  ...`initialize validate_invocation release_manifest lock_configuration guard_configuration
lock_inherited lock_acquire writers_inventory_before stop_writers writers_inventory_after
writers_stopped_check capture_directory capture_portal_database capture_portal_storage
capture_cms_database capture_cms_storage capture_release_metadata capture_manifest capture_verify_manifest
resume_writers backup_destination backup_upload restore_confirmation restore_manifest
restore_portal_archive restore_cms_archive restore_protection_destination restore_portal_database
restore_portal_migrate restore_portal_verify_migrations restore_cms_database restore_api_storage_clear
restore_api_storage_extract restore_cms_storage_clear restore_cms_storage_extract restore_cms_migrate
restore_cms_verify_runtime restore_start_readiness restore_smoke`.trim().split(/\s+/u),
  ...coordinatorGuardSteps,
]);
const coordinatorSteps = new Set(coordinatorDiagnosticSteps);
const knownControlErrorIdentifiers = new Set([
  ...controlErrorIdentifiers,
  ...initializerErrorIdentifiers,
  ...controlAdapterMessages.values(),
  ...controlGuardMessages.values(),
]);
const nativeCatalogVerifierStages = new Set(`
connection transaction protocol_identity protocol_migrations protocol_relations protocol_columns
protocol_sequences protocol_enums protocol_constraints protocol_indexes protocol_foreign_keys
protocol_control_columns protocol_control_roles protocol_control_ownership protocol_native_privileges
protocol_inventory protocol_state native_relations native_columns native_indexes native_constraints
native_types news_rows verifier process launch
`.trim().split(/\s+/u));
const nativeCatalogVerifierReasons = new Set(`
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
process_exit_without_diagnostic invalid_verifier_diagnostic executable_not_found permission_denied process_launch_failed
`.trim().split(/\s+/u));
const nativeCatalogVerifierControlErrors = new Set([
  'native_catalog_verification_failed',
  'native_catalog_verifier_launch_failed',
  'native_catalog_verifier_execution_failed',
]);
const nativeConstraintMismatchCategories = new Set(`
missing_expected unexpected_observed constraint_identity constraint_metadata
check_definition check_definition_parse primary_key_definition foreign_key_definition
`.trim().split(/\s+/u));
const nativeDiagnosticIdentifierPattern = /^[a-z_][a-z0-9_]{0,62}$/u;
const nativeDiagnosticSha256Pattern = /^[0-9a-f]{64}$/u;
const authorizedNativeConstraintMismatches = new WeakSet();
function readCandidateReleaseFile(release, relativePath, expectedOwner) {
  if (typeof release !== 'string' || !path.isAbsolute(release) || path.resolve(release) !== release
    || realpathSync(release) !== release) throw new Error('invalid candidate release path');
  const releaseInfo = lstatSync(release);
  if (!releaseInfo.isDirectory() || releaseInfo.isSymbolicLink()) throw new Error('invalid candidate release directory');
  const file = path.join(release, relativePath);
  const before = lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || realpathSync(file) !== file
    || (expectedOwner !== undefined && before.uid !== expectedOwner)) {
    throw new Error('invalid candidate release file');
  }
  const descriptor = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.nlink !== 1 || before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error('candidate release file changed');
    }
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function nativeConstraintIdentitiesFromRelease(release) {
  const manifestBytes = readCandidateReleaseFile(release, '.image-env');
  const manifestOwner = lstatSync(path.join(release, '.image-env')).uid;
  if ([...manifestBytes].some(byte => byte > 0x7f)) throw new Error('invalid release manifest encoding');
  const manifestLines = manifestBytes.toString('ascii').split(/\r?\n/u);
  if (manifestLines.at(-1) === '') manifestLines.pop();
  const manifest = new Map();
  for (const line of manifestLines) {
    const separator = line.indexOf('=');
    if (separator < 1 || separator !== line.lastIndexOf('=')) throw new Error('invalid release manifest');
    const key = line.slice(0, separator);
    if (manifest.has(key)) throw new Error('duplicate release manifest key');
    manifest.set(key, line.slice(separator + 1));
  }
  if (manifest.size !== 4 || manifest.get('RELEASE_FORMAT') !== 'payload-v1'
    || !/^ghcr\.io\/ownerinc\/ownerinc-portal-api@sha256:[0-9a-f]{64}$/u.test(manifest.get('API_IMAGE') || '')
    || !/^ghcr\.io\/ownerinc\/ownerinc-portal-cron@sha256:[0-9a-f]{64}$/u.test(manifest.get('CRON_IMAGE') || '')
    || !/^ghcr\.io\/ownerinc\/ownerinc-portal-cms@sha256:[0-9a-f]{64}$/u.test(manifest.get('CMS_IMAGE') || '')) {
    throw new Error('unvalidated payload release manifest');
  }
  const schema = JSON.parse(readCandidateReleaseFile(
    release, 'cms/src/migrations/20261006_181424_z_owner_news_native.json', manifestOwner,
  ).toString('utf8'));
  const verifier = readCandidateReleaseFile(release, 'cms/scripts/finalize-news-protocol.ts', manifestOwner).toString('utf8');
  const checksBlock = verifier.match(/const NATIVE_REQUIRED_CONSTRAINTS = \[(.*?)\] as const/su)?.[1];
  const checks = checksBlock ? [...checksBlock.matchAll(/'([a-z_][a-z0-9_]*)'/gu)].map(match => match[1]) : [];
  const tables = Object.values(schema.tables || {});
  if (!checks.length || new Set(checks).size !== checks.length || !tables.length) throw new Error('native diagnostic allowlist unavailable');
  const identities = new Set();
  const tableNames = [];
  for (const item of tables) {
    if (!item || typeof item.name !== 'string' || !item.columns || !item.foreignKeys) throw new Error('invalid native snapshot');
    const tableName = item.name.replace(/^public\./u, '');
    tableNames.push(tableName);
    if (Object.values(item.columns).some(column => column?.primaryKey === true)) {
      identities.add(`${tableName}\u0000${tableName}_pkey`);
    }
    for (const foreignKey of Object.values(item.foreignKeys)) {
      if (typeof foreignKey?.name !== 'string') throw new Error('invalid native foreign key');
      identities.add(`${tableName}\u0000${foreignKey.name}`);
    }
  }
  for (const name of checks) {
    const matches = name === 'news_migration_seal_complete' ? ['news_migration_runs']
      : tableNames.filter(candidate => name.startsWith(`${candidate}_`) || name === `${candidate}_metadata_basis_check`);
    if (!matches.length) throw new Error('native CHECK table unavailable');
    identities.add(`${matches.sort((left, right) => right.length - left.length)[0]}\u0000${name}`);
  }
  return identities;
}

function nativeConstraintIdentityIsExpected(release, table, constraint) {
  try {
    return nativeConstraintIdentitiesFromRelease(release).has(`${table}\u0000${constraint}`);
  } catch {
    return false;
  }
}

const readinessReasons = new Set([
  'missing', 'exited', 'unhealthy', 'wait_deadline',
  'health_inspect_failed', 'container_inspect_failed', 'diagnostic_unavailable',
]);
const containerStates = new Set(['created', 'restarting', 'running', 'removing', 'paused', 'exited', 'dead']);
const healthStatuses = new Set(['starting', 'healthy', 'unhealthy', 'none']);
const recoveryRoles = Object.freeze(['source', 'target', 'leaseTarget']);
const snapshotOutcomes = new Set(['not_started', 'running', 'passed', 'failed']);
const knownCommandErrors = new Set([...Object.values(processErrorIdentifiers), 'command_process_error']);
const knownErrorIdentifiers = new Set(Object.values(sqlStateIdentifiers));
export const CMS_READINESS_ROUTE = '/editorial/ready';

export function inferReadinessFailureReason(reason, { containerId, containerState, healthStatus } = {}) {
  if (!containerId) return 'missing';
  if (containerState === 'exited' || containerState === 'dead') return 'exited';
  if (healthStatus === 'unhealthy') return 'unhealthy';
  return readinessReasons.has(reason) ? reason : 'diagnostic_unavailable';
}

export function extractSqlState(stderr, { sqlCommandContext = false } = {}) {
  if (!sqlCommandContext) return null;
  const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
  // psql with VERBOSITY=sqlstate emits this exact, uppercase, code-only line.
  // Require both that invocation context and a known PostgreSQL code so prose,
  // arbitrary five-character values, and appended server details are discarded.
  const match = text.match(/^ERROR:[ \t]+([0-9A-Z]{5})[ \t]*\r?$/mu);
  return match && Object.hasOwn(sqlStateIdentifiers, match[1]) ? match[1] : null;
}

export function extractNativeCatalogVerifierDiagnostic(stderr, { controlCommandContext, release } = {}) {
  if (!controlCommandContexts.has(controlCommandContext) && controlCommandContext !== controlGuardContext) return null;
  const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
  const match = text.match(/^([a-z][a-z0-9_]{0,63})\r?\n(PREAUTHORITY_CATALOG_DIAGNOSTIC stage=([a-z_]+) reason=([a-z][a-z0-9_]{0,63}) sqlstate=(none|[0-9A-Z]{5}))\r?\n(?:([^\r\n]+)\r?\n)?$/u);
  if (!match || !nativeCatalogVerifierControlErrors.has(match[1])) return null;
  const [, controlErrorIdentifier, , stage, reason, rawSqlState, constraintLine] = match;
  if (!nativeCatalogVerifierStages.has(stage) || !nativeCatalogVerifierReasons.has(reason)) return null;
  const sqlState = rawSqlState === 'none' ? null : rawSqlState;
  if ((reason === 'postgres_error') !== (sqlState !== null)) return null;
  let constraintMismatch = null;
  if (constraintLine !== undefined) {
    if (stage !== 'native_constraints' || reason !== 'preauthority_native_constraint_inventory_mismatch') return null;
    const detail = constraintLine.match(/^PREAUTHORITY_CONSTRAINT_DIAGNOSTIC category=([a-z_]+) table=([a-z_][a-z0-9_]{0,62}|none) constraint=([a-z_][a-z0-9_]{0,62}|none) expectedCount=(0|[1-9][0-9]{0,6}) observedCount=(0|[1-9][0-9]{0,6}) expectedSha256=(none|[0-9a-f]{64}) observedSha256=(none|[0-9a-f]{64})$/u);
    if (!detail || !nativeConstraintMismatchCategories.has(detail[1])) return null;
    const [, category, rawTable, rawConstraint, rawExpectedCount, rawObservedCount, rawExpectedHash, rawObservedHash] = detail;
    const table = rawTable === 'none' ? null : rawTable;
    const constraint = rawConstraint === 'none' ? null : rawConstraint;
    const expectedCount = Number(rawExpectedCount);
    const observedCount = Number(rawObservedCount);
    const expectedDefinitionSha256 = rawExpectedHash === 'none' ? null : rawExpectedHash;
    const observedDefinitionSha256 = rawObservedHash === 'none' ? null : rawObservedHash;
    if ((table === null) !== (constraint === null)
      || (table !== null && (!nativeDiagnosticIdentifierPattern.test(table) || !nativeDiagnosticIdentifierPattern.test(constraint)
        || !nativeConstraintIdentityIsExpected(release, table, constraint)))
      || !Number.isSafeInteger(expectedCount) || expectedCount > 1_000_000
      || !Number.isSafeInteger(observedCount) || observedCount > 1_000_000
      || (expectedDefinitionSha256 !== null && !nativeDiagnosticSha256Pattern.test(expectedDefinitionSha256))
      || (observedDefinitionSha256 !== null && !nativeDiagnosticSha256Pattern.test(observedDefinitionSha256))) return null;
    constraintMismatch = {
      category, table, constraint, expectedCount, observedCount,
      expectedDefinitionSha256, observedDefinitionSha256,
    };
    Object.freeze(constraintMismatch);
    authorizedNativeConstraintMismatches.add(constraintMismatch);
  }
  if (controlErrorIdentifier === 'native_catalog_verification_failed'
    && (stage === 'process' || stage === 'launch')) return null;
  if (controlErrorIdentifier === 'native_catalog_verifier_launch_failed'
    && (stage !== 'launch' || !['executable_not_found', 'permission_denied', 'process_launch_failed'].includes(reason))) return null;
  if (controlErrorIdentifier === 'native_catalog_verifier_execution_failed'
    && (stage !== 'process' || !['process_exit_without_diagnostic', 'invalid_verifier_diagnostic'].includes(reason))) return null;
  return { stage, reason, sqlState, ...(constraintMismatch ? { constraintMismatch } : {}) };
}

function initializerScope(stderr, options) {
  if (!initializerContexts.has(options.controlCommandContext)
    || initializerContexts.get(options.controlCommandContext) !== options.substep
    || options.status !== 2 || options.errorCode || options.signal) return null;
  const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
  const match = text.match(/^([\s\S]*\n)PREAUTHORITY_INITIALIZER_DIAGNOSTIC phase=([a-z][a-z0-9_]+) installStage=([a-z_]+) commandExit=(none|[0-9]{1,3}) commandSignal=(none|[0-9]{1,2}) privateStderr=(retained|none)\r?\n$/u);
  if (!match) return text.includes('PREAUTHORITY_INITIALIZER_DIAGNOSTIC') ? null : { body: text };
  const [, body, phase, installStage, rawExit, rawSignal, retained] = match;
  const commandExitCode = rawExit === 'none' ? null : Number(rawExit);
  const commandSignal = rawSignal === 'none' ? null : Number(rawSignal);
  if (!initializerDiagnosticPhases.includes(phase) || !initializerStages.has(installStage)
    || (commandExitCode !== null && (commandExitCode < 1 || commandExitCode > 255))
    || (commandSignal !== null && (commandSignal < 1 || commandSignal > 64))
    || (commandExitCode !== null && commandSignal !== null)) return null;
  return { body, initializer: { phase, installStage, commandExitCode, commandSignal, privateStderrRetained: retained === 'retained' } };
}

function initializerBodyIdentifier(scope, release) {
  if (!scope) return null;
  const code = scope.body.match(/^([a-z][a-z0-9_]{0,63})\r?\n$/u)?.[1];
  if (!initializerErrorIdentifiers.has(code)) {
    return extractControlErrorIdentifier(scope.body, { controlCommandContext: controlGuardContext, release });
  }
  // These newly introduced errors are never emitted without the runtime frame;
  // require the exact reason/exit/signal relationship, not just finite fields.
  const metadata = scope.initializer;
  if (!metadata) return null;
  if (code === 'initializer_command_failed') return metadata.commandExitCode !== null && metadata.commandSignal === null ? code : null;
  if (code === 'initializer_command_signaled') return metadata.commandExitCode === null && metadata.commandSignal !== null ? code : null;
  return metadata.commandExitCode === null && metadata.commandSignal === null && !metadata.privateStderrRetained ? code : null;
}

export function extractControlErrorIdentifier(stderr, options = {}) {
  const { controlCommandContext, release } = options;
  if (initializerContexts.has(controlCommandContext)) {
    const scope = initializerScope(stderr, options);
    return initializerBodyIdentifier(scope, release);
  }
  const adapterContext = controlCommandContexts.has(controlCommandContext);
  const guardContext = controlCommandContext === controlGuardContext;
  if (!adapterContext && !guardContext) return null;

  const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
  const nativeDiagnostic = extractNativeCatalogVerifierDiagnostic(text, { controlCommandContext, release });
  if (nativeDiagnostic) {
    const controlCode = text.match(/^([a-z][a-z0-9_]{0,63})\r?\n/u)?.[1];
    return knownControlErrorIdentifiers.has(controlCode) ? controlCode : null;
  }
  // The Python adapter uses print(reason, file=sys.stderr), so accept exactly
  // one complete line (including that terminator), never a matching line with
  // adjacent diagnostics, arguments, paths, or secret-bearing detail.
  const match = text.match(/^([a-z][a-z0-9_]{0,63})\r?\n$/u);
  if (match) {
    return controlErrorIdentifiers.has(match[1]) ? match[1] : null;
  }

  const line = text.match(/^([^\r\n]+)\r?\n$/u)?.[1];
  if (!line) return null;
  if (adapterContext) return controlAdapterMessages.get(line) || null;
  return controlGuardMessages.get(line) || controlAdapterMessages.get(line) || null;
}

export function extractCoordinatorDiagnostic(stderr, { coordinatorCommandContext, status, release } = {}) {
  if (!coordinatorContexts.has(coordinatorCommandContext)) return null;
  const lines = (Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '')).split(/\r?\n/u);
  let step = null;
  let start = 0;
  for (const [index, line] of lines.entries()) {
    const progress = line.match(/^PAYLOAD_COORDINATOR_STEP step=([a-z_]+)$/u);
    if (progress) {
      if (!coordinatorSteps.has(progress[1])) return null;
      step = progress[1]; start = index + 1;
      continue;
    }
    const failure = line.match(/^PAYLOAD_COORDINATOR_FAILURE step=([a-z_]+) status=([0-9]{1,3})$/u);
    if (!failure) continue;
    if (!step || failure[1] !== step || Number(failure[2]) !== status || status < 1 || status > 255) return null;
    // Only this failing guard invocation may supply an adapter reason. Never
    // search Docker/tool output, prior steps or cleanup output for known words.
    const context = { controlCommandContext: controlGuardContext, release };
    const body = lines.slice(start, index).join('\n') + '\n';
    const native = coordinatorGuardSteps.has(step) ? extractNativeCatalogVerifierDiagnostic(body, context) : null;
    return {
      coordinatorStep: step,
      controlErrorIdentifier: coordinatorGuardSteps.has(step) ? extractControlErrorIdentifier(body, context) : null,
      ...(native ? { nativeCatalogVerifier: native } : {}),
    };
  }
  // A timeout/kill may prevent EXIT from running. Retain a finite last-started
  // step only; partial output never authorizes a guessed guard reason.
  return step ? { coordinatorStep: step, controlErrorIdentifier: null } : null;
}

export function createCommandDiagnostic({
  substep, status, signal, errorCode, stderr, sqlCommandContext = false, controlCommandContext, coordinatorCommandContext,
  logicalSnapshotCommandContext, release,
}) {
  const sqlState = extractSqlState(stderr, { sqlCommandContext });
  const initializer = initializerScope(stderr, { controlCommandContext, substep, status, errorCode, signal });
  const initializerReason = initializerBodyIdentifier(initializer, release);
  const nativeCatalogVerifier = extractNativeCatalogVerifierDiagnostic(initializerReason ? initializer.body : stderr,
    { controlCommandContext: initializerReason ? controlGuardContext : controlCommandContext, release });
  const logicalCode = logicalSnapshotCommandContext === 'logical-snapshot-cli'
    ? String(stderr || '').match(/^(logical_snapshot_[a-z_]+)\r?\n?$/u)?.[1] : null;
  return sanitizeCommandDiagnostic({
    substep: safeSubstepPattern.test(substep || '') ? substep : 'unclassified_command',
    commandExitCode: Number.isInteger(status) ? status : null,
    commandError: Object.hasOwn(processErrorIdentifiers, errorCode)
      ? processErrorIdentifiers[errorCode]
      : errorCode ? 'command_process_error' : null,
    sqlState,
    errorIdentifier: sqlState ? sqlStateIdentifiers[sqlState] : null,
    controlErrorIdentifier: extractControlErrorIdentifier(stderr, { controlCommandContext, release, substep, status, errorCode, signal }),
    ...(processSignals.has(signal) ? { commandSignal: signal } : {}),
    ...(initializerReason && initializer.initializer ? { initializer: initializer.initializer } : {}),
    ...(nativeCatalogVerifier ? { nativeCatalogVerifier } : {}),
    ...(logicalSnapshotErrorCodes.includes(logicalCode) ? { logicalSnapshotErrorIdentifier: logicalCode } : {}),
    ...extractCoordinatorDiagnostic(stderr, { coordinatorCommandContext, status, release }),
  });
}

export function sanitizeCommandDiagnostic(diagnostic = {}) {
  const initializer = diagnostic.initializer;
  const safeInitializer = initializer && initializerDiagnosticPhases.includes(initializer.phase)
    && initializerStages.has(initializer.installStage)
    && (initializer.commandExitCode === null || Number.isInteger(initializer.commandExitCode)
      && initializer.commandExitCode >= 1 && initializer.commandExitCode <= 255)
    && (initializer.commandSignal === null || Number.isInteger(initializer.commandSignal)
      && initializer.commandSignal >= 1 && initializer.commandSignal <= 64)
    && (initializer.commandExitCode === null || initializer.commandSignal === null)
    && typeof initializer.privateStderrRetained === 'boolean'
    ? { phase: initializer.phase, installStage: initializer.installStage,
      commandExitCode: initializer.commandExitCode, commandSignal: initializer.commandSignal,
      privateStderrRetained: initializer.privateStderrRetained } : null;
  const native = diagnostic.nativeCatalogVerifier;
  const nativeConstraintMismatch = native?.constraintMismatch;
  const safeConstraintMismatch = nativeConstraintMismatch && authorizedNativeConstraintMismatches.has(nativeConstraintMismatch)
    && nativeConstraintMismatchCategories.has(nativeConstraintMismatch.category)
    && ((nativeConstraintMismatch.table === null && nativeConstraintMismatch.constraint === null)
      || typeof nativeConstraintMismatch.table === 'string' && nativeDiagnosticIdentifierPattern.test(nativeConstraintMismatch.table)
        && typeof nativeConstraintMismatch.constraint === 'string' && nativeDiagnosticIdentifierPattern.test(nativeConstraintMismatch.constraint))
    && Number.isSafeInteger(nativeConstraintMismatch.expectedCount) && nativeConstraintMismatch.expectedCount >= 0
    && nativeConstraintMismatch.expectedCount <= 1_000_000
    && Number.isSafeInteger(nativeConstraintMismatch.observedCount) && nativeConstraintMismatch.observedCount >= 0
    && nativeConstraintMismatch.observedCount <= 1_000_000
    && (nativeConstraintMismatch.expectedDefinitionSha256 === null
      || typeof nativeConstraintMismatch.expectedDefinitionSha256 === 'string'
        && nativeDiagnosticSha256Pattern.test(nativeConstraintMismatch.expectedDefinitionSha256))
    && (nativeConstraintMismatch.observedDefinitionSha256 === null
      || typeof nativeConstraintMismatch.observedDefinitionSha256 === 'string'
        && nativeDiagnosticSha256Pattern.test(nativeConstraintMismatch.observedDefinitionSha256))
    ? Object.freeze({
      category: nativeConstraintMismatch.category,
      table: nativeConstraintMismatch.table,
      constraint: nativeConstraintMismatch.constraint,
      expectedCount: nativeConstraintMismatch.expectedCount,
      observedCount: nativeConstraintMismatch.observedCount,
      expectedDefinitionSha256: nativeConstraintMismatch.expectedDefinitionSha256,
      observedDefinitionSha256: nativeConstraintMismatch.observedDefinitionSha256,
    }) : null;
  if (safeConstraintMismatch) authorizedNativeConstraintMismatches.add(safeConstraintMismatch);
  const nativeCatalogVerifier = native && nativeCatalogVerifierStages.has(native.stage)
    && nativeCatalogVerifierReasons.has(native.reason)
    && (native.sqlState === null || typeof native.sqlState === 'string' && /^[0-9A-Z]{5}$/u.test(native.sqlState))
    && ((native.reason === 'postgres_error') === (native.sqlState !== null))
    && (!safeConstraintMismatch || native.stage === 'native_constraints'
      && native.reason === 'preauthority_native_constraint_inventory_mismatch')
    ? {
      stage: native.stage, reason: native.reason, sqlState: native.sqlState,
      ...(safeConstraintMismatch ? { constraintMismatch: safeConstraintMismatch } : {}),
    } : null;
  return {
    substep: safeSubstepPattern.test(diagnostic.substep || '') ? diagnostic.substep : 'unclassified_command',
    commandExitCode: Number.isInteger(diagnostic.commandExitCode) && diagnostic.commandExitCode >= 0 && diagnostic.commandExitCode <= 255
      ? diagnostic.commandExitCode : null,
    commandError: knownCommandErrors.has(diagnostic.commandError) ? diagnostic.commandError : null,
    sqlState: Object.hasOwn(sqlStateIdentifiers, diagnostic.sqlState) ? diagnostic.sqlState : null,
    errorIdentifier: knownErrorIdentifiers.has(diagnostic.errorIdentifier) ? diagnostic.errorIdentifier : null,
    controlErrorIdentifier: knownControlErrorIdentifiers.has(diagnostic.controlErrorIdentifier)
      ? diagnostic.controlErrorIdentifier : null,
    ...(processSignals.has(diagnostic.commandSignal) ? { commandSignal: diagnostic.commandSignal } : {}),
    ...(safeInitializer ? { initializer: safeInitializer } : {}),
    ...(nativeCatalogVerifier ? { nativeCatalogVerifier } : {}),
    ...(coordinatorSteps.has(diagnostic.coordinatorStep) ? { coordinatorStep: diagnostic.coordinatorStep } : {}),
    ...(logicalSnapshotErrorCodes.includes(diagnostic.logicalSnapshotErrorIdentifier)
      ? { logicalSnapshotErrorIdentifier: diagnostic.logicalSnapshotErrorIdentifier } : {}),
  };
}

export function createReadinessDiagnostic({
  reason,
  containerState,
  healthStatus,
  containerExitCode,
  readinessHttpStatus,
  service,
}) {
  return {
    reason: readinessReasons.has(reason) ? reason : 'diagnostic_unavailable',
    containerState: containerStates.has(containerState) ? containerState : 'unknown',
    healthStatus: healthStatuses.has(healthStatus) ? healthStatus : 'unknown',
    containerExitCode: Number.isInteger(containerExitCode) && containerExitCode >= 0 && containerExitCode <= 255
      ? containerExitCode : null,
    readinessHttpStatus: Number.isInteger(readinessHttpStatus) && readinessHttpStatus >= 100 && readinessHttpStatus <= 599
      ? readinessHttpStatus : null,
    expectedRoute: service === 'cms' ? CMS_READINESS_ROUTE : null,
  };
}

export function createRecoveryProgressReport(progress = {}) {
  return Object.fromEntries(recoveryRoles.map(role => {
    const status = progress[role] || {};
    return [role, {
      initialCmsHealthPassed: status.initialCmsHealthPassed === true,
      writersRestartedHealthy: status.writersRestartedHealthy === true,
      quiescentSnapshotComparison: snapshotOutcomes.has(status.quiescentSnapshotComparison)
        ? status.quiescentSnapshotComparison : 'not_started',
    }];
  }));
}
