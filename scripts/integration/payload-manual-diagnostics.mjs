// Pure diagnostic transport for the disposable manual fixture. No DB, runtime
// catalog or lifecycle dependency. These finite vocabularies mirror the existing
// finalizer formatter; the offline test checks exact vocabulary/formatter parity.
import { types } from 'node:util';

export const manualFinalizerPhases = Object.freeze([
  'connection-configuration', 'admin-connect', 'transaction-begin', 'transaction-lock',
  'audit-transaction-begin', 'audit-identity', 'audit-transaction-commit',
  'precondition-identity', 'precondition-migrations', 'precondition-relations', 'precondition-columns',
  'precondition-sequences', 'precondition-enums', 'precondition-constraints', 'precondition-indexes',
  'precondition-foreign-keys', 'precondition-control-columns', 'precondition-control-roles',
  'precondition-protocol-inventory', 'precondition-control-ownership', 'precondition-native-privileges',
  'precondition-installed-state', 'precondition-observer-role', 'precondition-observer-privileges',
  'protocol-head-read', 'protocol-ledger-ddl', 'protocol-trigger-ddl', 'protocol-binding-ddl',
  'protocol-grants', 'protocol-bootstrap-ddl', 'verify-installed', 'transaction-commit', 'transaction-rollback',
]);
export const manualFinalizerReasons = Object.freeze([
  'admin_database_url_required', 'unsafe_admin_database_url', 'unsafe_admin_target',
  'observer_database_url_required', 'unsafe_observer_database_url', 'unsafe_observer_target',
  'observer_role_contract_mismatch', 'observer_privilege_contract_mismatch',
  'observer_visible_ownership_mismatch', 'protocol_not_installed', 'audit_transaction_contract_mismatch',
  'native_migration_ledger_mismatch', 'native_relation_inventory_mismatch', 'mutation_relation_inventory_mismatch',
  'native_column_inventory_mismatch', 'native_serial_sequence_binding_or_configuration_mismatch',
  'native_enum_catalog_mismatch', 'native_required_constraint_missing', 'native_snapshot_index_missing_or_mismatched',
  'native_snapshot_foreign_key_mismatch', 'native_control_column_types_mismatch', 'native_item_run_id_type_mismatch',
  'control_role_contract_mismatch', 'partial_protocol_installation_manual_recovery_required',
  'protocol_upgrade_required', 'protocol_upgrade_requires_v1',
  'unsafe_preinstallation_control_state', 'diagnostic_installed_protocol_deep_check_skipped',
  'ledger_head_invalid_or_coverage_activated', 'canonical_function_mismatch', 'canonical_function_inventory_unavailable',
  'trigger_inventory_count_mismatch', 'trigger_key_missing', 'trigger_key_duplicate',
  'trigger_relation_schema_mismatch', 'trigger_enabled_state_mismatch', 'trigger_function_identity_mismatch',
  'trigger_function_schema_mismatch', 'trigger_event_mask_mismatch', 'trigger_column_inventory_mismatch',
  'trigger_catalog_type_mismatch', 'trigger_argument_inventory_mismatch', 'trigger_condition_mismatch',
  'trigger_definition_mismatch',
  'runtime_verifier_role_switch_failed', 'runtime_protocol_acl_mismatch', 'admin_role_restore_failed',
  'control_role_table_acl_mismatch', 'control_role_column_acl_mismatch', 'control_role_sequence_acl_mismatch',
  'public_function_execute_outside_allowlist', 'protocol_acl_mismatch', 'unexpected_control_owned_objects',
  'database_error',
]);
const phases = new Set(manualFinalizerPhases), reasons = new Set(manualFinalizerReasons);
export const manualFinalizerGrantOperations = Object.freeze([
  'runtime-grants', 'observer-relation-grants', 'admin-role-reset', 'ownership-transfer', 'observer-privileges-verify',
  'migrator-role-set', 'control-role-set', 'protocol-relation-grants', 'control-function-create',
  'control-function-acl', 'trigger-execute-grant', 'trigger-install', 'trigger-execute-revoke',
]);
export const manualFinalizerLedgerOperations = Object.freeze(['ledger-head-create', 'ledger-head-init', 'ledger-events-create']);
function operationForPhase(phase, operation) {
  return (phase === 'protocol-grants' ? manualFinalizerGrantOperations
    : phase === 'protocol-ledger-ddl' ? manualFinalizerLedgerOperations : []).find(value => value === operation);
}
function operationSuffix(phase, operation) {
  return ` operation=${operation}` + (phase === 'protocol-ledger-ddl' ? ' ddl_source=mutation-ledger expected_owner=cms_migrator' : '');
}
const functions = new Set(['owner_news_mutation_guard_stmt', 'owner_news_mutation_capture_row', 'owner_news_seal_run',
  'owner_news_migration_item_binding_guard', 'owner_news_bootstrap_run']);
const fields = new Set(['sig', 'sec', 'owner', 'config', 'source', 'return', 'strict', 'modes', 'names']);
const prefix = 'MANUAL_RUNTIME_FINALIZER_DIAGNOSTIC code=';
const lineLimit = 2048, captureLimit = 64 * 1024;

// Own data only: never read message/code accessors, inherited fields or causes.
function ownDiagnosticValue(value, key) {
  try {
    if (!value || (typeof value !== 'object' && typeof value !== 'function') || types.isProxy(value)) return undefined;
    return Object.getOwnPropertyDescriptor(value, key)?.value;
  } catch { return undefined; }
}
export function ownDiagnosticString(value, key) {
  const field = ownDiagnosticValue(value, key);
  return typeof field === 'string' && field.length <= lineLimit && !/[\x00-\x1f\x7f]/u.test(field) ? field : null;
}

function canonicalCode(code) {
  if (typeof code !== 'string' || code.length > lineLimit || !code.startsWith('canonical_function_mismatch:')) return false;
  const entries = code.slice('canonical_function_mismatch:'.length).split(','), names = new Set();
  if (entries.length > functions.size) return false;
  for (const entry of entries) {
    const [name, ...checks] = entry.split(':'), seen = new Set();
    if (!functions.has(name) || names.has(name) || !checks.length || checks.length > fields.size) return false;
    names.add(name);
    for (const check of checks) {
      const pair = /^([a-z]+)=(true|false)$/u.exec(check);
      if (!pair || !fields.has(pair[1]) || seen.has(pair[1])) return false;
      seen.add(pair[1]);
    }
  }
  return true;
}

export function isManualFinalizerDiagnostic(line) {
  if (typeof line !== 'string' || line.length > lineLimit || /[\r\n\x00-\x1f\x7f]/u.test(line)) return false;
  if (line.startsWith(prefix)) return canonicalCode(line.slice(prefix.length));
  const match = /^CMS news protocol diagnostic: phase=([a-z-]+) reason=([a-z0-9_]+) sqlstate=(none|[0-9A-Z]{5})(.*)$/u.exec(line);
  if (!match || !phases.has(match[1]) || !reasons.has(match[2])) return false;
  if (!match[4]) return true;
  const operation = operationForPhase(match[1], /^ operation=([a-z-]+)(?: |$)/u.exec(match[4])?.[1]);
  return Boolean(operation && match[4] === operationSuffix(match[1], operation));
}

/** The fixture supplies getFinalizerFailureDiagnostic's result and the existing
 * production formatter. Project only the three transport fields and a valid
 * phase-bound operation. Invalid optional operations are omitted, excluding any
 * optional detail object and any error text. The consumer independently checks
 * the formatted line. Invalid canonical detail falls back to the safe summary. */
export function serializeManualFinalizerDiagnostic(error, diagnostic, formatDiagnostic) {
  const code = ownDiagnosticString(error, 'code');
  if (canonicalCode(code)) return `${prefix}${code}`;
  const phase = ownDiagnosticString(diagnostic, 'phase'), reason = ownDiagnosticString(diagnostic, 'reason');
  const sqlstate = ownDiagnosticValue(diagnostic, 'sqlstate');
  if (!phases.has(phase) || !reasons.has(reason) || (sqlstate !== null &&
    (typeof sqlstate !== 'string' || !/^[0-9A-Z]{5}$/u.test(sqlstate) || /[\r\n]/u.test(sqlstate)))) return null;
  try {
    const operation = operationForPhase(phase, ownDiagnosticString(diagnostic, 'operation'));
    const line = formatDiagnostic({ phase, reason, sqlstate, ...(operation ? { operation } : {}) });
    return isManualFinalizerDiagnostic(line) ? line : null;
  } catch { return null; }
}

/** stdout can contain TAP's '# ' projection of child stderr. Accept whole
 * framed lines only, never a valid-looking substring of an arbitrary message.
 * Bound decoding as well as matching; never return captured output wholesale. */
export function extractManualFinalizerDiagnostic(stdout, stderr) {
  let summary = null;
  for (const captured of [stdout, stderr]) {
    if (types.isProxy(captured) || !(typeof captured === 'string' || Buffer.isBuffer(captured)) || Buffer.byteLength(captured) > captureLimit) continue;
    const text = typeof captured === 'string' ? captured : Buffer.prototype.toString.call(captured, 'utf8');
    for (const raw of text.split(/\r?\n/u)) {
      const line = raw.replace(/^ {0,16}# /u, '');
      if (!isManualFinalizerDiagnostic(line)) continue;
      if (line.startsWith(prefix)) return line;
      summary ??= line;
    }
  }
  return summary;
}
