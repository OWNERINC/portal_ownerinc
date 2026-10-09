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

export function createCommandDiagnostic({ substep, status, errorCode, stderr, sqlCommandContext = false }) {
  const sqlState = extractSqlState(stderr, { sqlCommandContext });
  return sanitizeCommandDiagnostic({
    substep: safeSubstepPattern.test(substep || '') ? substep : 'unclassified_command',
    commandExitCode: Number.isInteger(status) ? status : null,
    commandError: Object.hasOwn(processErrorIdentifiers, errorCode)
      ? processErrorIdentifiers[errorCode]
      : errorCode ? 'command_process_error' : null,
    sqlState,
    errorIdentifier: sqlState ? sqlStateIdentifiers[sqlState] : null,
  });
}

export function sanitizeCommandDiagnostic(diagnostic = {}) {
  return {
    substep: safeSubstepPattern.test(diagnostic.substep || '') ? diagnostic.substep : 'unclassified_command',
    commandExitCode: Number.isInteger(diagnostic.commandExitCode) && diagnostic.commandExitCode >= 0 && diagnostic.commandExitCode <= 255
      ? diagnostic.commandExitCode : null,
    commandError: knownCommandErrors.has(diagnostic.commandError) ? diagnostic.commandError : null,
    sqlState: Object.hasOwn(sqlStateIdentifiers, diagnostic.sqlState) ? diagnostic.sqlState : null,
    errorIdentifier: knownErrorIdentifiers.has(diagnostic.errorIdentifier) ? diagnostic.errorIdentifier : null,
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
      quiescentSnapshotComparison: snapshotOutcomes.has(status.quiescentSnapshotComparison)
        ? status.quiescentSnapshotComparison : 'not_started',
    }];
  }));
}
