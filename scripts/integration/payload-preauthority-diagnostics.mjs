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
  return {
    substep: safeSubstepPattern.test(substep || '') ? substep : 'unclassified_command',
    commandExitCode: Number.isInteger(status) ? status : null,
    commandError: Object.hasOwn(processErrorIdentifiers, errorCode)
      ? processErrorIdentifiers[errorCode]
      : errorCode ? 'command_process_error' : null,
    sqlState,
    errorIdentifier: sqlState ? sqlStateIdentifiers[sqlState] : null,
  };
}
