import { types } from 'node:util';

// Parent boundaries only: Compose failure does not identify an inner command.
// This closed projection diagnoses failure; it never grants fixture authority.
const childOperations = new Set(['pre-role-forwarder-health', 'database-bindings', 'portal-system-identity',
  'cms-system-identity', 'compose-up', 'role-bindings']);
const operations = new Map([
  ['portal-migrate', childOperations], ['cms-provision', childOperations], ['cms-migrate', childOperations],
  ['post-migrations', new Set(['news-digest', 'authority-baseline', 'pre-runtime-forwarder-health'])],
]);
// Exact literals emitted by runProcess; neither messages nor prefixes qualify.
const processCodes = new Set(['functional_process_unavailable', 'functional_process_timeout',
  'functional_process_output_limit', 'functional_process_failed']);
// Guards in verifyBindings, fixtureSQL, forwarder.assertHealthy and newsDigest.
const guardCodes = new Set(['functional_volume_binding_mismatch', 'functional_container_binding_mismatch',
  'functional_container_mount_mismatch', 'functional_image_environment_invalid', 'functional_resolved_environment_mismatch',
  'functional_unexpected_published_port', 'functional_internal_network_required', 'functional_attached_network_mismatch',
  'functional_forwarder_binding_failed', 'functional_forwarder_listener_failed', 'functional_forwarder_lifetime_exceeded',
  'functional_forwarder_listener_closed', 'functional_store_invalid', 'functional_sql_binding_invalid', 'functional_news_inventory_invalid']);
const causes = new Set([...processCodes, ...guardCodes, 'assertion_failed', 'unexpected_failure']);

function ownData(value, key) {
  try {
    if (value === null || !['object', 'function'].includes(typeof value) || types.isProxy(value)) return undefined;
    const field = Object.getOwnPropertyDescriptor(value, key);
    return field && Object.hasOwn(field, 'value') ? field.value : undefined;
  } catch { return undefined; }
}

export function validateFunctionalMigrationDiagnostic(value) {
  try {
    if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || keys.some(key => !['role', 'operation', 'cause'].includes(key))) return null;
    const role = ownData(value, 'role'), operation = ownData(value, 'operation'), cause = ownData(value, 'cause');
    if (typeof role !== 'string' || typeof operation !== 'string' || typeof cause !== 'string' ||
        !operations.get(role)?.has(operation) || !causes.has(cause)) return null;
    return Object.freeze({ role, operation, cause });
  } catch { return null; }
}

export function functionalMigrationDiagnostic(role, operation, error) {
  const code = ownData(error, 'code');
  const cause = typeof code === 'string' && (processCodes.has(code) || guardCodes.has(code)) ? code
    : code === 'ERR_ASSERTION' ? 'assertion_failed' : 'unexpected_failure';
  return validateFunctionalMigrationDiagnostic({ role, operation, cause });
}
