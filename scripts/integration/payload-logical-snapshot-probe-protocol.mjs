import { logicalSnapshotErrorCodes } from './payload-logical-snapshot.mjs';

export const CONVERSION_PROBE_CONTEXT = 'linux-conversion-probe';
export const CONVERSION_PROBE_SUCCESS = 'PAYLOAD_LINUX_CONVERSION_PREREQUISITE passed\n';
export const conversionProbePhases = Object.freeze([
  'conversion_validate_fixture', 'conversion_validate_lease', 'conversion_baseline', 'conversion_create',
  'conversion_catalog_presence', 'conversion_require_rejection', 'conversion_cleanup', 'conversion_compare_all_stores',
  ...['baseline', 'compare'].flatMap(prefix => ['writers', 'portal_sql', 'portal_cli', 'cms_sql', 'cms_cli',
    'portal_archive', 'portal_storage', 'cms_archive', 'cms_storage'].map(suffix => `conversion_${prefix}_${suffix}`)),
  'conversion_reject_sql', 'conversion_reject_cli',
]);
export const conversionProbeReasons = Object.freeze([
  'configuration_invalid', 'lease_unavailable', 'lease_identity_mismatch', 'lease_permissions_invalid',
  'platform_or_uid_invalid', 'writers_active', 'psql_failed', 'cli_failed', 'compose_failed', 'storage_failed',
  'catalog_absent', 'conversion_not_rejected', 'snapshot_mismatch', 'snapshot_shape_invalid', 'snapshot_result_invalid',
  'command_timeout', 'executable_not_found', 'permission_denied', 'output_limit_exceeded', 'command_signaled',
  'command_process_error', 'internal_error',
  'cli_module_not_found', 'cli_unknown_file_extension', 'cli_type_stripping_unsupported',
]);
const components = ['portalDatabase', 'cmsDatabase', 'portalSchema', 'cmsSchema', 'portalUploads', 'cmsUploads'];
const sqlPhases = new Set(['conversion_create', 'conversion_catalog_presence', 'conversion_cleanup',
  'conversion_baseline_portal_sql', 'conversion_baseline_cms_sql', 'conversion_compare_portal_sql',
  'conversion_compare_cms_sql', 'conversion_reject_sql']);
const cliPhases = new Set(['conversion_baseline_portal_cli', 'conversion_baseline_cms_cli',
  'conversion_compare_portal_cli', 'conversion_compare_cms_cli', 'conversion_reject_cli']);
const sqlStates = new Set(['08001','08006','22001','22007','22021','22023','23502','23503','23505','23514',
  '28P01','3D000','42501','42601','42804','42883','42P01','42P07','42703','42710','57014','58P01','0A000']);
const fields = ['phase', 'reason', 'sqlState', 'logicalError', 'mismatch'];

/** Node's own finite error-code footer, only from a direct CLI launch with
 * clean exit 1. Never return a module name, path, error message or stack. */
export function conversionCliLaunchReason(stderr, { context, status, errorCode, signal } = {}) {
  if (context !== 'logical-snapshot-cli' || status !== 1 || errorCode || signal) return null;
  const code = String(stderr || '').match(/^  code: '(ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION|ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING)',?\r?$/mu)?.[1];
  return ({ ERR_MODULE_NOT_FOUND: 'cli_module_not_found', MODULE_NOT_FOUND: 'cli_module_not_found',
    ERR_UNKNOWN_FILE_EXTENSION: 'cli_unknown_file_extension',
    ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING: 'cli_type_stripping_unsupported' })[code] || null;
}

function valid(value) {
  if (!value || typeof value !== 'object' || Object.keys(value).join(',') !== fields.join(',')
      || !conversionProbePhases.includes(value.phase) || !conversionProbeReasons.includes(value.reason)) return false;
  if (value.reason === 'configuration_invalid' && value.phase !== 'conversion_validate_fixture') return false;
  if (['lease_unavailable','lease_identity_mismatch','lease_permissions_invalid','platform_or_uid_invalid'].includes(value.reason)
      && value.phase !== 'conversion_validate_lease') return false;
  if (value.reason === 'writers_active' && !['conversion_baseline_writers','conversion_compare_writers'].includes(value.phase)) return false;
  if (value.reason === 'catalog_absent' && value.phase !== 'conversion_catalog_presence') return false;
  if (value.reason === 'conversion_not_rejected' && !['conversion_require_rejection','conversion_reject_cli'].includes(value.phase)) return false;
  if (value.reason === 'snapshot_result_invalid' && !cliPhases.has(value.phase)) return false;
  if (value.reason === 'snapshot_shape_invalid' && value.phase !== 'conversion_compare_all_stores') return false;
  if (value.reason.startsWith('cli_') && !cliPhases.has(value.phase)) return false;
  if (value.sqlState !== null && (!sqlPhases.has(value.phase) || value.reason !== 'psql_failed' || !sqlStates.has(value.sqlState))) return false;
  if (value.logicalError !== null && (!cliPhases.has(value.phase) || value.reason !== 'cli_failed'
      || !logicalSnapshotErrorCodes.includes(value.logicalError))) return false;
  if (value.mismatch !== null) {
    if (value.phase !== 'conversion_compare_all_stores' || value.reason !== 'snapshot_mismatch'
        || !Array.isArray(value.mismatch) || value.mismatch.length < 1 || value.mismatch.length > 6) return false;
    const seen = new Set();
    for (const item of value.mismatch) {
      if (!item || Object.keys(item).join(',') !== 'component,expectedHash,actualHash' || !components.includes(item.component)
          || seen.has(item.component) || typeof item.expectedHash !== 'string' || typeof item.actualHash !== 'string'
          || !/^[0-9a-f]{64}$/u.test(item.expectedHash) || !/^[0-9a-f]{64}$/u.test(item.actualHash)
          || item.expectedHash === item.actualHash) return false;
      seen.add(item.component);
    }
  }
  return (value.reason !== 'snapshot_mismatch' || value.mismatch !== null)
    && (value.reason !== 'psql_failed' || sqlPhases.has(value.phase))
    && (value.reason !== 'cli_failed' || cliPhases.has(value.phase));
}

export function encodeConversionProbeFailure(value) {
  if (!valid(value)) throw new Error('invalid_conversion_probe_diagnostic');
  return `PAYLOAD_LINUX_CONVERSION_FAILURE ${JSON.stringify(value)}\n`;
}

/** One exact canonical protocol, only a clean exit-2 child in the explicit
 * context. No scanning arbitrary stdout/stderr or accepting a partial timeout. */
export function parseConversionProbeFailure(stderr, { context, status, errorCode, signal, stdout } = {}) {
  if (context !== CONVERSION_PROBE_CONTEXT || status !== 2 || errorCode || signal || Buffer.byteLength(stdout || '') !== 0) return null;
  const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr || '');
  if (text.length > 4096) return null;
  const match = text.match(/^PAYLOAD_LINUX_CONVERSION_FAILURE (\{[^\r\n]+\})\n$/u);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    return valid(value) && encodeConversionProbeFailure(value) === text ? value : null;
  } catch { return null; }
}
