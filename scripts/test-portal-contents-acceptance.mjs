#!/usr/bin/env node
// This check-only acceptance wrapper never starts services. Browser, HTTP and
// service cases are recorded by the operator in the guarded evidence directory.
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_CASES = Object.freeze([
  'live-auth-gate',
  'catalog-routing',
  'native-image',
  'native-range',
  'long-video-renewal',
  'media-failure-recovery',
  'large-pdf',
  'auth-exit-cross-tab',
  'gallery-keyboard',
  'screen-reader-gallery',
  'embeds-effective-csp',
  'layout-mobile',
  'bfcache-cleanup',
  'owner-news-regression',
  'editorial-accessibility',
]);

const RECORD_KEYS = Object.freeze([
  'case', 'commit', 'runId', 'environment', 'browser', 'viewport', 'scenario', 'status', 'artifact', 'notes',
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMMIT = /^[0-9a-f]{40}$/iu;
const RECORD_FILE = 'portal-contents-acceptance.json';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class AcceptanceConfigError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AcceptanceConfigError';
    this.code = code;
  }
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function isLoopback(hostname) {
  const host = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (isIP(host) === 4) return Number(host.split('.')[0]) === 127;
  return false;
}

export async function checkEnvironment(environment = process.env, { checkout = repoRoot } = {}) {
  if (environment.NODE_ENV !== 'test') throw new AcceptanceConfigError('node_env_must_be_test');
  if (environment.PORTAL_CONTENTS_TEST_DISPOSABLE !== 'true') {
    throw new AcceptanceConfigError('disposable_opt_in_required');
  }

  let baseURL;
  try { baseURL = new URL(environment.PORTAL_CONTENTS_TEST_BASE_URL); }
  catch { throw new AcceptanceConfigError('loopback_base_url_required'); }
  if (!['http:', 'https:'].includes(baseURL.protocol) || !isLoopback(baseURL.hostname)
    || baseURL.username || baseURL.password || baseURL.pathname !== '/' || baseURL.search || baseURL.hash) {
    throw new AcceptanceConfigError('loopback_base_url_required');
  }

  const runId = environment.PORTAL_CONTENTS_TEST_RUN_ID;
  if (typeof runId !== 'string' || !UUID_V4.test(runId)) throw new AcceptanceConfigError('uuid_v4_run_id_required');

  const configuredDirectory = environment.PORTAL_CONTENTS_TEST_EVIDENCE_DIR;
  if (typeof configuredDirectory !== 'string' || !configuredDirectory || !path.isAbsolute(configuredDirectory)) {
    throw new AcceptanceConfigError('absolute_evidence_directory_required');
  }
  let directoryInfo;
  let evidenceDir;
  let checkoutRoot;
  try {
    directoryInfo = await lstat(configuredDirectory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new AcceptanceConfigError('evidence_directory_must_be_real_directory');
    }
    [evidenceDir, checkoutRoot] = await Promise.all([realpath(configuredDirectory), realpath(checkout)]);
  } catch (error) {
    if (error instanceof AcceptanceConfigError) throw error;
    throw new AcceptanceConfigError('evidence_directory_unavailable');
  }
  if (inside(checkoutRoot, evidenceDir)) throw new AcceptanceConfigError('evidence_directory_must_be_outside_checkout');

  return Object.freeze({ runId, baseURL: baseURL.origin, evidenceDir, checkoutRoot });
}

function artifactPathIsSafe(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\\') || value.includes(':')
    || value.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(value)) return false;
  const segments = value.split('/');
  return segments.every(segment => segment && segment !== '.' && segment !== '..');
}

function validateRecord(record, expectedRunId, context) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'record_not_object';
  const keys = Object.keys(record).sort();
  if (keys.length !== RECORD_KEYS.length || keys.some((key, index) => key !== [...RECORD_KEYS].sort()[index])) {
    return 'record_keys_invalid';
  }
  if (!REQUIRED_CASES.includes(record.case)) return 'case_not_allowed';
  if (!COMMIT.test(record.commit || '')) return 'commit_invalid';
  if (!UUID_V4.test(record.runId || '') || (expectedRunId && record.runId !== expectedRunId)) return 'run_id_invalid';
  if (!['PASS', 'FAIL', 'NOT_EXECUTED'].includes(record.status)) return 'status_invalid';
  for (const key of ['environment', 'browser', 'viewport', 'scenario', 'notes']) {
    if (typeof record[key] !== 'string' || !record[key].trim()) return `${key}_missing`;
  }
  if (record.artifact !== null && !artifactPathIsSafe(record.artifact)) return 'artifact_path_invalid';
  if (record.status === 'PASS') {
    if (!/\bdisposable[- ]local\b/iu.test(record.environment)) return 'pass_environment_not_disposable_local';
    if (/\b(mock(?:ed)?|unit[- ]test|test[- ]harness|offline|not[- ]executed)\b/iu.test(`${record.environment} ${record.browser}`)) {
      return 'mocked_or_offline_pass_forbidden';
    }
  }
  if (context.commit && context.commit !== record.commit) return 'commit_mismatch';
  if (context.runId && context.runId !== record.runId) return 'run_id_mismatch';
  context.commit ||= record.commit;
  context.runId ||= record.runId;
  return null;
}

export function aggregateEvidence(records, { expectedRunId } = {}) {
  const errors = [];
  if (!Array.isArray(records)) {
    return { status: 'FAIL', exitCode: 1, cases: [], errors: ['manifest_not_array'] };
  }

  const byCase = new Map();
  const context = { commit: null, runId: null };
  records.forEach((record, index) => {
    const invalid = validateRecord(record, expectedRunId, context);
    if (invalid) {
      errors.push(`record_${index + 1}:${invalid}`);
      return;
    }
    if (byCase.has(record.case)) errors.push(`duplicate_case:${record.case}`);
    else byCase.set(record.case, record);
  });
  for (const row of records) {
    if (row && typeof row === 'object' && !Array.isArray(row) && row.status === 'FAIL'
      && REQUIRED_CASES.includes(row.case)) errors.push(`case_failed:${row.case}`);
  }

  const cases = REQUIRED_CASES.map(caseName => {
    const record = byCase.get(caseName);
    return record ? { case: caseName, status: record.status }
      : { case: caseName, status: 'NOT_EXECUTED', reason: 'missing_record' };
  });
  if (errors.length) return { status: 'FAIL', exitCode: 1, cases, errors: [...new Set(errors)] };
  if (cases.some(row => row.status === 'FAIL')) return { status: 'FAIL', exitCode: 1, cases, errors: [] };
  if (cases.some(row => row.status === 'NOT_EXECUTED')) return { status: 'NOT_EXECUTED', exitCode: 2, cases, errors: [] };
  return { status: 'PASS', exitCode: 0, cases, errors: [] };
}

export function createNotExecutedEvidence({ commit, runId, environment, reason }) {
  if (!COMMIT.test(commit || '') || !UUID_V4.test(runId || '')
    || typeof environment !== 'string' || !environment.trim()
    || typeof reason !== 'string' || !reason.trim()) {
    throw new TypeError('NOT_EXECUTED evidence requires a commit, UUIDv4, environment and reason.');
  }
  return REQUIRED_CASES.map(caseName => ({
    case: caseName,
    commit,
    runId,
    environment,
    browser: 'NOT_EXECUTED',
    viewport: 'NOT_EXECUTED',
    scenario: `${caseName}: required local service/browser scenario was not executed.`,
    status: 'NOT_EXECUTED',
    artifact: null,
    notes: reason,
  }));
}

async function validateArtifactFiles(records, evidenceDir) {
  for (const record of records) {
    if (record?.artifact === null || !artifactPathIsSafe(record?.artifact)) continue;
    const target = path.resolve(evidenceDir, ...record.artifact.split('/'));
    if (!inside(evidenceDir, target)) throw new AcceptanceConfigError('artifact_path_invalid');
    let current = evidenceDir;
    for (const segment of record.artifact.split('/')) {
      current = path.join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new AcceptanceConfigError('artifact_symlink_forbidden');
    }
    if (!(await lstat(target)).isFile()) throw new AcceptanceConfigError('artifact_must_be_regular_file');
  }
}

function safeErrorCode(error) {
  return error instanceof AcceptanceConfigError && /^[a-z0-9_]+$/u.test(error.code)
    ? error.code : 'acceptance_configuration_invalid';
}

function summary(result, { configStatus = null, runId = null } = {}) {
  return {
    status: result.status,
    exitCode: result.exitCode,
    ...(configStatus ? { configStatus } : {}),
    ...(runId ? { runId } : {}),
    cases: result.cases.map(row => ({ case: row.case, status: row.status })),
    errors: result.errors,
  };
}

export async function runAcceptanceCLI(args = process.argv.slice(2), environment = process.env) {
  const mode = args.length === 1 ? args[0] : null;
  if (!['--check-config', '--aggregate'].includes(mode)) {
    const output = { status: 'NOT_EXECUTED', exitCode: 2, configStatus: 'NOT_CHECKED',
      cases: REQUIRED_CASES.map(caseName => ({ case: caseName, status: 'NOT_EXECUTED' })),
      errors: ['exactly_one_supported_mode_required'] };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return 2;
  }

  let config;
  try { config = await checkEnvironment(environment); }
  catch (error) {
    const invalidAggregateConfig = mode === '--aggregate';
    const output = { status: invalidAggregateConfig ? 'FAIL' : 'NOT_EXECUTED',
      exitCode: invalidAggregateConfig ? 1 : 2, configStatus: 'INVALID',
      cases: REQUIRED_CASES.map(caseName => ({ case: caseName, status: 'NOT_EXECUTED' })),
      errors: [safeErrorCode(error)] };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return output.exitCode;
  }

  if (mode === '--check-config') {
    const output = { status: 'NOT_EXECUTED', exitCode: 2, configStatus: 'CONFIG_VALID', runId: config.runId,
      baseURL: config.baseURL,
      cases: REQUIRED_CASES.map(caseName => ({ case: caseName, status: 'NOT_EXECUTED' })), errors: [] };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return 2;
  }

  try {
    const manifestPath = path.join(config.evidenceDir, RECORD_FILE);
    const manifestInfo = await lstat(manifestPath).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!manifestInfo) {
      const result = aggregateEvidence([], { expectedRunId: config.runId });
      process.stdout.write(`${JSON.stringify(summary(result, { runId: config.runId }))}\n`);
      return result.exitCode;
    }
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) throw new AcceptanceConfigError('manifest_must_be_regular_file');
    const records = JSON.parse(await readFile(manifestPath, 'utf8'));
    const result = aggregateEvidence(records, { expectedRunId: config.runId });
    if (Array.isArray(records)) {
      try { await validateArtifactFiles(records, config.evidenceDir); }
      catch (error) {
        result.status = 'FAIL';
        result.exitCode = 1;
        result.errors.push(safeErrorCode(error));
      }
    }
    process.stdout.write(`${JSON.stringify(summary(result, { runId: config.runId }))}\n`);
    return result.exitCode;
  } catch (error) {
    const output = { status: 'FAIL', exitCode: 1, runId: config.runId,
      cases: REQUIRED_CASES.map(caseName => ({ case: caseName, status: 'NOT_EXECUTED' })),
      errors: [safeErrorCode(error)] };
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runAcceptanceCLI();
}
