#!/usr/bin/env node
// CI orchestration only: the existing leased runner owns every fixture operation.
import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { functionalCases } from '../../cms/tests/integration/functional-matrix.mjs';
import { checkFunctionalParent, readFunctionalConfig } from '../../cms/tests/support/integration-config.mjs';
import { checkoutBinding, hash, root } from './payload-functional-fixture.mjs';
import { functionalBaseImages } from './payload-functional-base-images.mjs';
import { readPrivateBytes } from '../owner-news-payload/files.mjs';

const fail = reason => { throw new EditorialCIError(reason); };
class EditorialCIError extends Error {}
const equal = (a, b, reason) => { if (!isDeepStrictEqual(a, b)) fail(reason); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function freeze(value) { if (object(value) || Array.isArray(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
// Snapshot the real immutable inventory; never accept report-supplied check names.
const contracts = freeze(structuredClone(functionalCases));
const editorial = contracts.filter(item => item.phase === 'editorial');
const scope = 'editorial-real-https-isolated-fixture';
export const executionTimeout = 8 * 60_000;
export const cleanupGrace = 6 * 60_000;
export const executionReserve = executionTimeout + cleanupGrace + 60_000;
export const jobTimeout = 35 * 60_000;

export function executionDeadline(env, now = Date.now()) {
  const value = env.PAYLOAD_EDITORIAL_CI_DEADLINE_MS;
  if (typeof value !== 'string' || !/^[1-9][0-9]{12}$/u.test(value) ||
      !Number.isSafeInteger(now) ||
      Number(value) > now + jobTimeout) fail('execution_deadline_invalid');
  // Sole outer deadline, grounded in the run's start before any job/step setup.
  // The execution step shares the 35m job ceiling, so cannot expire before this.
  return Number(value);
}

export function assertExecutionWindow(deadline, now = Date.now()) {
  if (!Number.isSafeInteger(deadline) || !Number.isSafeInteger(now)) fail('execution_deadline_invalid');
  if (deadline - now < executionReserve) fail('insufficient_execution_cleanup_window');
}

export function fixtureEnvironment(env) {
  // No database, authentication, profile, Node loader, proxy or Docker overrides.
  return { PATH: env.PATH, HOME: env.HOME, NODE_ENV: 'test', MIGRATION_TEST_DISPOSABLE: 'true',
    GITHUB_SHA: env.GITHUB_SHA, PAYLOAD_FUNCTIONAL_PHASE: 'editorial', PAYLOAD_FUNCTIONAL_HTTPS_PORT: '0',
    ...Object.fromEntries(['PRIVATE_PARENT', 'CERTIFICATE', 'PRIVATE_KEY', 'PLAYWRIGHT_MODULE',
      'BROWSER_EXECUTABLE', 'API_IMAGE', 'CMS_IMAGE', 'EMULATOR_IMAGE'].map(key =>
      [`PAYLOAD_FUNCTIONAL_${key}`, env[`PAYLOAD_FUNCTIONAL_${key}`]])) };
}

function parseJSON(text, reason) { try { return JSON.parse(text); } catch { fail(reason); } }

export function validateEditorialResult(result, report, expected) {
  if (result.code === 1) fail('runner_failed');
  if (result.code !== 2 || result.signal || result.interrupted || result.stderr !== '') fail('runner_exit_or_output_invalid');
  if (!Object.isFrozen(functionalCases) || editorial.length !== 4 || contracts.length !== 48 ||
      editorial.some(item => !item.implemented || !item.requiredChecks.length)) fail('editorial_inventory_changed');
  if (!exactKeys(report, ['schemaVersion', 'runId', 'scope', 'status', 'acceptanceComplete', 'productionValidated',
    'layers', 'cases', 'cleanup', 'source', 'startedAt', 'images', 'targetBindings', 'transport',
    'editorialAdmission', 'transportCleanup', 'finishedAt', 'preauthorityComplete', 'editorialPhaseComplete'])) fail('report_shape_invalid');
  equal([report.schemaVersion, report.runId, report.scope, report.status, report.acceptanceComplete,
    report.productionValidated, report.preauthorityComplete, report.editorialPhaseComplete],
  [1, expected.runId, scope, 'INCOMPLETE', false, false, false, true], 'report_scope_invalid');
  if (!uuid(report.runId)) fail('report_identity_invalid');
  equal(report.source, expected.source, 'report_source_mismatch');
  equal(report.images, expected.images, 'report_images_mismatch');
  equal(report.layers, { portalApi: 'REAL', firebase: 'REAL', cms: 'REAL', nginx: 'REAL', browser: 'REAL' }, 'report_layers_invalid');
  equal(report.editorialAdmission, { kind: 'synthetic-fixture-only', productionGateE: false,
    protocol: 'canonical-finalizer-fixture-empty-baseline' }, 'report_admission_invalid');
  equal([report.cleanup, report.transportCleanup], ['owned_services_stopped_volumes_and_evidence_retained',
    'owned_listener_and_sockets_closed'], 'report_cleanup_invalid');
  const targets = report.targetBindings, transport = report.transport;
  if (!exactKeys(targets, ['portalSystemIdentifierHash', 'cmsSystemIdentifierHash', 'independentClusters', 'freshBeforeDDL']) ||
      targets.independentClusters !== true || targets.freshBeforeDDL !== true || !digest(targets.portalSystemIdentifierHash) ||
      !digest(targets.cmsSystemIdentifierHash) || targets.portalSystemIdentifierHash === targets.cmsSystemIdentifierHash) fail('report_targets_invalid');
  if (!exactKeys(transport, ['kind', 'origin', 'runnerPid', 'targetBindingHash', 'listenerObserved', 'tlsVerifiedReadiness', 'containerPublishedPorts']) ||
      transport.kind !== 'host_loopback_tcp_to_internal_nginx' || !/^https:\/\/127\.0\.0\.1:[0-9]{4,5}$/u.test(transport.origin) ||
      Number(new URL(transport.origin).port) < 1024 || Number(new URL(transport.origin).port) > 65535 ||
      !Number.isInteger(result.pid) || result.pid < 1 || transport.runnerPid !== result.pid || !digest(transport.targetBindingHash) ||
      transport.listenerObserved !== true || transport.tlsVerifiedReadiness !== true || transport.containerPublishedPorts !== false) fail('report_transport_invalid');
  if (!isoTime(report.startedAt) || !isoTime(report.finishedAt) || Date.parse(report.startedAt) < expected.notBefore ||
      Date.parse(report.finishedAt) > expected.notAfter || report.startedAt > report.finishedAt) fail('report_time_invalid');
  if (!Array.isArray(report.cases) || report.cases.length !== contracts.length) fail('report_inventory_invalid');
  let previous = report.startedAt;
  for (const [index, contract] of contracts.entries()) {
    const item = report.cases[index];
    if (!exactKeys(item, [...Object.keys(contract), 'status', 'reason', 'observations', 'startedAt', 'finishedAt'])) fail('report_case_shape_invalid');
    for (const key of Object.keys(contract)) equal(item[key], contract[key], 'report_case_contract_mismatch');
    if (contract.phase !== 'editorial') {
      equal([item.status, item.reason, item.observations, item.startedAt, item.finishedAt],
        ['INCOMPLETE', contract.implemented ? 'not_executed' : contract.dependency, [], null, null], 'report_unexecuted_claim_invalid');
      continue;
    }
    if (item.status !== 'PASS' || item.reason !== null || !isoTime(item.startedAt) || !isoTime(item.finishedAt) ||
        item.startedAt < previous || item.finishedAt < item.startedAt || item.finishedAt > report.finishedAt ||
        !Array.isArray(item.observations)) fail('report_editorial_case_incomplete');
    previous = item.finishedAt;
    for (const observation of item.observations) {
      if (!object(observation) || !exactKeys(observation, observation.httpStatus === undefined ? ['check', 'passed'] : ['check', 'passed', 'httpStatus']) ||
          observation.passed !== true || (observation.httpStatus !== undefined &&
          (!Number.isInteger(observation.httpStatus) || observation.httpStatus < 100 || observation.httpStatus > 599))) fail('report_observation_invalid');
    }
    equal(item.observations.map(value => value.check).sort(), [...contract.requiredChecks].sort(), 'report_observation_inventory_invalid');
  }
  equal(parseJSON(result.stdout, 'runner_output_invalid'), { status: 'INCOMPLETE', preauthorityComplete: false,
    acceptanceComplete: false, passed: 4, failed: 0, incomplete: 44 }, 'runner_summary_mismatch');
  // This is a new narrow summary, never a rewrite of the runner's full report.
  return freeze({ editorialBrowser: 'PASS', editorialPhaseComplete: true, runnerStatus: 'INCOMPLETE', runnerExitCode: 2,
    acceptanceComplete: false, productionValidated: false, passed: 4, remaining: 44,
    scenarios: editorial.map(item => item.scenarioId), cleanup: 'owned_services_and_listener_stopped' });
}

export async function runBounded(program, args, { env, timeout = 60_000, grace = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, env, detached: process.platform === 'linux', stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', size = 0, interrupted = false, killTimer;
    const interrupt = () => {
      if (interrupted) return;
      interrupted = true; child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try { if (process.platform === 'linux') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {}
      }, grace);
    };
    const timer = setTimeout(interrupt, timeout);
    const clear = () => { clearTimeout(timer); clearTimeout(killTimer); process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt); };
    process.once('SIGTERM', interrupt); process.once('SIGINT', interrupt);
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) { interrupt(); return; }
      if (key === 'stdout') stdout += chunk; else stderr += chunk;
    });
    child.once('error', () => { clear(); reject(new EditorialCIError('process_unavailable')); });
    child.once('close', (code, signal) => { clear(); resolve({ code, signal, pid: child.pid, interrupted, stdout, stderr }); });
  });
}

async function readPrivateJSON(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid() || (info.mode & 0o077)) fail('private_report_file_invalid');
  return parseJSON((await readPrivateBytes(filename, 1024 * 1024)).toString('utf8'), 'private_report_json_invalid');
}

// Dependency seams are exercised offline; CLI always uses the real subprocesses,
// read-only private-file reader and checkout binding. No fixture implementation here.
export async function qualifyEditorial(env, { deadline, run = runBounded, read = readPrivateJSON, binding = checkoutBinding, now = Date.now } = {}) {
  const config = readFunctionalConfig(env), source = await binding(), notBefore = now();
  if (source.commit !== config.commit || source.diffHash !== hash('')) fail('clean_exact_checkout_required');
  assertExecutionWindow(deadline, now());
  const prepared = await run(process.execPath, ['scripts/test-payload-integration.mjs', '--prepare-lease'], { env, timeout: 60_000 });
  if (prepared.code !== 0 || prepared.signal || prepared.interrupted || prepared.stderr) fail('lease_preparation_failed');
  const lines = prepared.stdout.trimEnd().split('\n');
  if (lines.length !== 2 || lines[0] !== 'payload-functional: PREPARED; services not contacted; acceptance INCOMPLETE' ||
      !lines[1].startsWith('lease: ')) fail('lease_output_invalid');
  const leasePath = lines[1].slice(7), directory = path.dirname(leasePath);
  if (!path.isAbsolute(leasePath) || path.basename(leasePath) !== 'lease.json' || path.dirname(directory) !== config.privateParent ||
      !/^ownerinc-payload-functional-[0-9a-f]{32}$/u.test(path.basename(directory))) fail('lease_path_invalid');
  const lease = await read(leasePath);
  if (lease.phase !== 'editorial' || !uuid(lease.identity?.runId) ||
      path.basename(directory) !== `ownerinc-payload-functional-${lease.identity.runId.replaceAll('-', '')}`) fail('lease_phase_or_identity_invalid');
  equal(lease.config, config, 'lease_configuration_mismatch'); equal(lease.binding, source, 'lease_source_mismatch');
  const expected = { runId: lease.identity.runId, source, notBefore, images: {
    api: config.apiImage, cms: config.cmsImage, emulator: config.emulatorImage,
    postgres: functionalBaseImages.postgres.platforms.amd64.configDigest, nginx: functionalBaseImages.nginx.platforms.amd64.configDigest } };
  // Last admission check, after all service-free preparation and immediately
  // before the sole command that can start mutable fixture services. No retry.
  assertExecutionWindow(deadline, now());
  const result = await run(process.execPath, ['scripts/test-payload-integration.mjs', '--execute', '--lease', leasePath],
    { env, timeout: executionTimeout, grace: cleanupGrace });
  // Exit 1, interruption, timeout and missing report can never become a narrow PASS.
  if (result.code === 1) fail('runner_failed');
  if (result.code !== 2 || result.signal || result.interrupted) fail('runner_exit_or_output_invalid');
  equal(await binding(), source, 'checkout_changed_during_execution');
  const report = await read(path.join(directory, 'functional-acceptance-report.json'));
  return validateEditorialResult(result, report, { ...expected, notAfter: now() });
}

export function scopeSummary(summary) {
  return `### Editorial browser qualification\n\nFour editorial cases: **${summary.editorialBrowser}**. ` +
    `Full acceptance: **INCOMPLETE** (${summary.remaining} cases unexecuted).\n\n` +
    'Production validated: **false**. Admission: **synthetic fixture-only**.\n\n' +
    summary.scenarios.map(id => `- ${id}: PASS`).join('\n') +
    '\n\nOwned services and HTTPS listener stopped; private volumes/evidence stay on the ephemeral runner until disposal.\n';
}

async function main() {
  if (process.argv.length !== 2 || process.platform !== 'linux' || process.arch !== 'x64' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      !path.isAbsolute(process.env.RUNNER_TEMP || '') || !path.isAbsolute(process.env.HOME || '')) fail('hosted_linux_ci_required');
  const deadline = executionDeadline(process.env);
  assertExecutionWindow(deadline);
  process.umask(0o077);
  const parent = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'payload-editorial-ci-')); await chmod(parent, 0o700);
  await checkFunctionalParent({ privateParent: parent });
  const certificate = path.join(parent, 'cert.pem'), privateKey = path.join(parent, 'key.pem');
  const cert = await runBounded('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', privateKey, '-out', certificate],
  { env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  if (cert.code !== 0 || cert.signal || cert.interrupted) fail('synthetic_tls_generation_failed');
  await chmod(certificate, 0o600); await chmod(privateKey, 0o600);
  const env = fixtureEnvironment({ ...process.env, PAYLOAD_FUNCTIONAL_PRIVATE_PARENT: parent,
    PAYLOAD_FUNCTIONAL_CERTIFICATE: certificate, PAYLOAD_FUNCTIONAL_PRIVATE_KEY: privateKey });
  const summary = await qualifyEditorial(env, { deadline });
  console.log(JSON.stringify(summary));
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, scopeSummary(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(async error => {
    const reason = error instanceof EditorialCIError ? error.message : 'editorial_ci_failed_closed';
    console.error(`payload-editorial-ci: FAIL; ${reason}; acceptance INCOMPLETE; productionValidated=false`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
      `### Editorial browser qualification\n\n**FAIL / NOT QUALIFIED**: ${reason}. Full acceptance INCOMPLETE; production validated false.\n`).catch(() => {});
    process.exitCode = 1;
  });
}
