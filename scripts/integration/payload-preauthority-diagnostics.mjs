const safeSubstepPattern = /^[a-z][a-z0-9_]{0,63}$/u;

const sqlStateIdentifiers = Object.freeze({
  '08001': 'connection_unavailable',
  '08006': 'connection_failure',
  '22001': 'string_data_right_truncation',
  '22007': 'invalid_datetime_format',
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
});

const processErrorIdentifiers = Object.freeze({
  EACCES: 'permission_denied',
  ENOENT: 'executable_not_found',
  ETIMEDOUT: 'command_timeout',
});

const controlCommandContexts = new Set([
  'payload-control:release-preflight',
  'payload-control:verify-release',
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
docker_inventory_unavailable docker_volume_inventory_unavailable duplicate_inventory_field duplicate_json_field
host_control_requires_root invalid_admission_state invalid_cold_state invalid_data_fingerprints
invalid_database_identity invalid_inventory_backup_paths invalid_inventory_file invalid_inventory_mounts
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
unsafe_admission_sentinel unsafe_backup_artifact unsafe_backup_directory unsafe_inventory_destination
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
const knownControlErrorIdentifiers = new Set([
  ...controlErrorIdentifiers,
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

export function extractNativeCatalogVerifierDiagnostic(stderr, { controlCommandContext } = {}) {
  if (!controlCommandContexts.has(controlCommandContext)) return null;
  const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
  const match = text.match(/^([a-z][a-z0-9_]{0,63})\r?\nPREAUTHORITY_CATALOG_DIAGNOSTIC stage=([a-z_]+) reason=([a-z][a-z0-9_]{0,63}) sqlstate=(none|[0-9A-Z]{5})\r?\n$/u);
  if (!match || !nativeCatalogVerifierControlErrors.has(match[1])) return null;
  const [, controlErrorIdentifier, stage, reason, rawSqlState] = match;
  if (!nativeCatalogVerifierStages.has(stage) || !nativeCatalogVerifierReasons.has(reason)) return null;
  const sqlState = rawSqlState === 'none' ? null : rawSqlState;
  if ((reason === 'postgres_error') !== (sqlState !== null)) return null;
  if (controlErrorIdentifier === 'native_catalog_verification_failed'
    && (stage === 'process' || stage === 'launch')) return null;
  if (controlErrorIdentifier === 'native_catalog_verifier_launch_failed'
    && (stage !== 'launch' || !['executable_not_found', 'permission_denied', 'process_launch_failed'].includes(reason))) return null;
  if (controlErrorIdentifier === 'native_catalog_verifier_execution_failed'
    && (stage !== 'process' || !['process_exit_without_diagnostic', 'invalid_verifier_diagnostic'].includes(reason))) return null;
  return { stage, reason, sqlState };
}

export function extractControlErrorIdentifier(stderr, { controlCommandContext } = {}) {
  const adapterContext = controlCommandContexts.has(controlCommandContext);
  const guardContext = controlCommandContext === controlGuardContext;
  if (!adapterContext && !guardContext) return null;

  const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
  const nativeDiagnostic = extractNativeCatalogVerifierDiagnostic(text, { controlCommandContext });
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
  return controlGuardMessages.get(line) || null;
}

export function createCommandDiagnostic({
  substep, status, errorCode, stderr, sqlCommandContext = false, controlCommandContext,
}) {
  const sqlState = extractSqlState(stderr, { sqlCommandContext });
  const nativeCatalogVerifier = extractNativeCatalogVerifierDiagnostic(stderr, { controlCommandContext });
  return sanitizeCommandDiagnostic({
    substep: safeSubstepPattern.test(substep || '') ? substep : 'unclassified_command',
    commandExitCode: Number.isInteger(status) ? status : null,
    commandError: Object.hasOwn(processErrorIdentifiers, errorCode)
      ? processErrorIdentifiers[errorCode]
      : errorCode ? 'command_process_error' : null,
    sqlState,
    errorIdentifier: sqlState ? sqlStateIdentifiers[sqlState] : null,
    controlErrorIdentifier: extractControlErrorIdentifier(stderr, { controlCommandContext }),
    ...(nativeCatalogVerifier ? { nativeCatalogVerifier } : {}),
  });
}

export function sanitizeCommandDiagnostic(diagnostic = {}) {
  const native = diagnostic.nativeCatalogVerifier;
  const nativeCatalogVerifier = native && nativeCatalogVerifierStages.has(native.stage)
    && nativeCatalogVerifierReasons.has(native.reason)
    && (native.sqlState === null || typeof native.sqlState === 'string' && /^[0-9A-Z]{5}$/u.test(native.sqlState))
    && ((native.reason === 'postgres_error') === (native.sqlState !== null))
    ? { stage: native.stage, reason: native.reason, sqlState: native.sqlState } : null;
  return {
    substep: safeSubstepPattern.test(diagnostic.substep || '') ? diagnostic.substep : 'unclassified_command',
    commandExitCode: Number.isInteger(diagnostic.commandExitCode) && diagnostic.commandExitCode >= 0 && diagnostic.commandExitCode <= 255
      ? diagnostic.commandExitCode : null,
    commandError: knownCommandErrors.has(diagnostic.commandError) ? diagnostic.commandError : null,
    sqlState: Object.hasOwn(sqlStateIdentifiers, diagnostic.sqlState) ? diagnostic.sqlState : null,
    errorIdentifier: knownErrorIdentifiers.has(diagnostic.errorIdentifier) ? diagnostic.errorIdentifier : null,
    controlErrorIdentifier: knownControlErrorIdentifiers.has(diagnostic.controlErrorIdentifier)
      ? diagnostic.controlErrorIdentifier : null,
    ...(nativeCatalogVerifier ? { nativeCatalogVerifier } : {}),
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
