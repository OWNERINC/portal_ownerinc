import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { functionalCases, newFunctionalReport, runFunctionalCase, finishFunctionalReport } from '../../cms/tests/integration/functional-matrix.mjs';
import { readFunctionalConfig } from '../../cms/tests/support/integration-config.mjs';
import { hash, playwrightVersion } from '../../scripts/integration/payload-functional-fixture.mjs';
import { functionalBaseImages } from '../../scripts/integration/payload-functional-base-images.mjs';
import { CI_BASE_PINS } from '../../scripts/prepare-ci-registry-pulls.mjs';
import { assertExecutionWindow, cleanupGrace, executionDeadline, executionReserve, jobTimeout,
  executionTimeout, fixtureEnvironment, qualifyEditorial, runBounded, scopeSummary,
  validateEditorialResult } from '../../scripts/integration/payload-editorial-ci.mjs';

// Existing locked CMS dependency, installed by the workflow before this test.
const { parse } = createRequire(new URL('../../cms/package.json', import.meta.url))('yaml');
const workflowPath = new URL('../../.github/workflows/payload-editorial-check.yml', import.meta.url);
const revision = 'a'.repeat(40), runId = '134cfd81-7f0d-47ca-a4fb-c9cabd069c0f';
const image = digit => `sha256:${digit.repeat(64)}`;
const privateRoot = path.join(process.platform === 'win32' && process.env.LOCALAPPDATA ?
  path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir(), 'editorial-offline-only');
const baseEnvironment = () => fixtureEnvironment({ PATH: process.env.PATH, HOME: privateRoot, GITHUB_SHA: revision,
  PAYLOAD_FUNCTIONAL_PRIVATE_PARENT: privateRoot, PAYLOAD_FUNCTIONAL_CERTIFICATE: path.join(privateRoot, 'cert.pem'),
  PAYLOAD_FUNCTIONAL_PRIVATE_KEY: path.join(privateRoot, 'key.pem'),
  PAYLOAD_FUNCTIONAL_PLAYWRIGHT_MODULE: path.join(privateRoot, 'tools', 'index.mjs'),
  PAYLOAD_FUNCTIONAL_BROWSER_EXECUTABLE: path.join(privateRoot, 'chromium'),
  PAYLOAD_FUNCTIONAL_API_IMAGE: image('1'), PAYLOAD_FUNCTIONAL_CMS_IMAGE: image('2'), PAYLOAD_FUNCTIONAL_EMULATOR_IMAGE: image('3') });

async function completedReport() {
  // Synthetic validator input, never native/browser evidence. Exercise the real
  // case recorder and finalizer so required observations come from their contract.
  const report = newFunctionalReport(runId), notBefore = Date.now() - 1000;
  Object.assign(report, { scope: 'editorial-real-https-isolated-fixture', startedAt: new Date(notBefore).toISOString(),
    source: { commit: revision, diffHash: hash(''), sourceHash: 'b'.repeat(64) },
    layers: { portalApi: 'REAL', firebase: 'REAL', cms: 'REAL', nginx: 'REAL', browser: 'REAL' },
    images: { api: image('1'), cms: image('2'), emulator: image('3'),
      postgres: functionalBaseImages.postgres.platforms.amd64.configDigest, nginx: functionalBaseImages.nginx.platforms.amd64.configDigest },
    targetBindings: { portalSystemIdentifierHash: 'c'.repeat(64), cmsSystemIdentifierHash: 'd'.repeat(64), independentClusters: true, freshBeforeDDL: true },
    transport: { kind: 'host_loopback_tcp_to_internal_nginx', origin: 'https://127.0.0.1:19443', runnerPid: 4242,
      targetBindingHash: 'e'.repeat(64), listenerObserved: true, tlsVerifiedReadiness: true, containerPublishedPorts: false },
    editorialAdmission: { kind: 'synthetic-fixture-only', productionGateE: false, protocol: 'canonical-finalizer-fixture-empty-baseline' },
    cleanup: 'owned_services_stopped_volumes_and_evidence_retained', transportCleanup: 'owned_listener_and_sockets_closed' });
  for (const contract of functionalCases.filter(item => item.phase === 'editorial')) {
    await runFunctionalCase(report, contract.scenarioId, async () => contract.requiredChecks.map(check => ({ check, passed: true })));
  }
  report.finishedAt = new Date().toISOString();
  assert.equal(finishFunctionalReport(report), 2);
  assert.equal(report.editorialPhaseComplete, true, 'the real producer must establish the narrow completion field');
  return { report, expected: { runId, source: structuredClone(report.source), images: structuredClone(report.images), notBefore, notAfter: Date.now() + 1000 },
    result: { code: 2, signal: null, interrupted: false, pid: 4242, stderr: '',
      stdout: JSON.stringify({ status: 'INCOMPLETE', preauthorityComplete: false, acceptanceComplete: false, passed: 4, failed: 0, incomplete: 44 }) + '\n' } };
}

test('only the complete synthetic four-case contract maps exit 2 to narrow success; full acceptance stays incomplete', async () => {
  const input = await completedReport(), before = structuredClone(input.report);
  const summary = validateEditorialResult(input.result, input.report, input.expected);
  assert.deepEqual(input.report, before, 'classification must not rewrite evidence');
  assert.deepEqual(summary, { editorialBrowser: 'PASS', editorialPhaseComplete: true, runnerStatus: 'INCOMPLETE', runnerExitCode: 2,
    acceptanceComplete: false, productionValidated: false, passed: 4, remaining: 44,
    scenarios: ['EDITORIAL-drafts', 'EDITORIAL-restore', 'EDITORIAL-conflict', 'EDITORIAL-revocation'], cleanup: 'owned_services_and_listener_stopped' });
  assert.ok(Object.isFrozen(summary) && Object.isFrozen(summary.scenarios));
  const publicText = scopeSummary(summary);
  assert.ok(publicText.includes('44 cases unexecuted') && publicText.includes('synthetic fixture-only'));
  for (const privateValue of [runId, revision, input.report.transport.origin, input.report.targetBindings.portalSystemIdentifierHash]) {
    assert.ok(!publicText.includes(privateValue));
  }
});

const editorialCase = report => report.cases.find(item => item.phase === 'editorial');
const negatives = {
  'missing case': ({ report }) => report.cases.pop(),
  'extra case': ({ report }) => report.cases.push(structuredClone(editorialCase(report))),
  'duplicate case identity': ({ report }) => { report.cases[9] = structuredClone(report.cases[8]); },
  'wrong summary count': ({ result }) => { result.stdout = result.stdout.replace('"passed":4', '"passed":3'); },
  'name-only PASS fabrication': ({ report }) => { editorialCase(report).observations = []; },
  'self-declared reduced requirements': ({ report }) => { const item = editorialCase(report); item.requiredChecks = ['invented']; item.observations = [{ check: 'invented', passed: true }]; },
  'duplicate observation': ({ report }) => { const item = editorialCase(report); item.observations[1] = { ...item.observations[0] }; },
  'false observation': ({ report }) => { editorialCase(report).observations[0].passed = false; },
  'unbounded observation field': ({ report }) => { editorialCase(report).observations[0].cookie = 'synthetic-private-marker'; },
  'invalid HTTP observation': ({ report }) => { editorialCase(report).observations[0].httpStatus = 600; },
  'unexecuted case PASS': ({ report }) => { report.cases[0].status = 'PASS'; },
  'unexecuted case fabricated observations': ({ report }) => { report.cases[0].observations = [{ check: 'invented', passed: true }]; },
  'wrong phase': ({ report }) => { editorialCase(report).phase = 'preauthority'; },
  'wrong scope': ({ report }) => { report.scope = 'preauthority-real-https-first-slice'; },
  'missing narrow producer field': ({ report }) => { delete report.editorialPhaseComplete; },
  'false narrow producer field': ({ report }) => { report.editorialPhaseComplete = false; },
  'partial case': ({ report }) => { editorialCase(report).status = 'INCOMPLETE'; },
  'full acceptance fabrication': ({ report }) => { report.acceptanceComplete = true; },
  'production qualification fabrication': ({ report }) => { report.productionValidated = true; },
  'production Gate E fabrication': ({ report }) => { report.editorialAdmission.productionGateE = true; },
  'service cleanup failure': ({ report }) => { report.cleanup = 'owned_stop_failed_preserved'; },
  'transport cleanup failure': ({ report }) => { report.transportCleanup = 'owned_listener_stop_failed'; },
  'late failure after four passes': ({ report }) => { report.failure = { stage: 'owned_process_stop', reason: 'functional_cleanup_failed' }; },
  'unexecuted browser layer': ({ report }) => { report.layers.browser = 'NOT_EXECUTED'; },
  'old report identity': ({ report }) => { report.runId = '234cfd81-7f0d-47ca-a4fb-c9cabd069c0f'; },
  'different checkout': ({ report }) => { report.source.commit = 'f'.repeat(40); },
  'different image': ({ report }) => { report.images.cms = image('9'); },
  'external transport': ({ report }) => { report.transport.origin = 'https://example.invalid:19443'; },
  'unbound runner PID': ({ report }) => { report.transport.runnerPid++; },
  'non-independent clusters': ({ report }) => { report.targetBindings.cmsSystemIdentifierHash = report.targetBindings.portalSystemIdentifierHash; },
  'stale report timestamp': ({ report }) => { report.startedAt = '2020-01-01T00:00:00.000Z'; },
  'unfinished observation': ({ report }) => { editorialCase(report).finishedAt = null; },
  'exit 1 with apparently passing report': ({ result }) => { result.code = 1; },
  'exit 0 full success forbidden': ({ result }) => { result.code = 0; },
  'unknown exit': ({ result }) => { result.code = 137; },
  'signal': ({ result }) => { result.signal = 'SIGTERM'; },
  'timeout after complete report': ({ result }) => { result.interrupted = true; },
  'unknown stdout': ({ result }) => { result.stdout = 'unrecognized\n' + result.stdout; },
  'empty stdout': ({ result }) => { result.stdout = ''; },
  'partial JSON': ({ result }) => { result.stdout = result.stdout.slice(0, 15); },
  'unexpected stderr': ({ result }) => { result.stderr = 'synthetic-private-marker'; },
  'unknown report field': ({ report }) => { report.cookie = 'synthetic-private-marker'; },
};
for (const [name, mutate] of Object.entries(negatives)) test(`deny ${name} (synthetic report only)`, async () => {
  const input = await completedReport(); mutate(input);
  assert.throws(() => validateEditorialResult(input.result, input.report, input.expected));
});

test('fixture subprocess environment is a closed projection; ambient production and loader settings cannot leak', () => {
  const env = fixtureEnvironment({ ...baseEnvironment(), DATABASE_URL: 'synthetic-production-marker', CMS_EDITORIAL_PROFILE: 'held-v1',
    CMS_PUBLICATION_MODE: 'manual', PAYLOAD_TEST_DATABASE: 'synthetic-marker', DOCKER_HOST: 'tcp://invalid:2375',
    DOCKER_CONFIG: '/private-registry-auth', NODE_OPTIONS: '--import=bad.mjs', HTTPS_PROXY: 'https://invalid',
    GOOGLE_APPLICATION_CREDENTIALS: '/private-credentials', GITHUB_TOKEN: 'synthetic-private-marker',
    PAYLOAD_EDITORIAL_RUN_TOKEN: 'synthetic-bootstrap-only-token', PAYLOAD_EDITORIAL_CI_DEADLINE_MS: '1999999999999' });
  assert.doesNotThrow(() => readFunctionalConfig(env));
  assert.equal(env.PAYLOAD_FUNCTIONAL_PHASE, 'editorial'); assert.equal(env.PAYLOAD_FUNCTIONAL_HTTPS_PORT, '0');
  assert.ok(!JSON.stringify(env).includes('synthetic-')); assert.ok(!JSON.stringify(env).includes('private-registry'));
  assert.deepEqual(Object.keys(env).sort(), Object.keys(baseEnvironment()).sort());
  assert.equal(env.PAYLOAD_EDITORIAL_CI_DEADLINE_MS, undefined);
  assert.equal(env.PAYLOAD_EDITORIAL_RUN_TOKEN, undefined);
});

async function orchestrationFixture() {
  const input = await completedReport(), env = baseEnvironment(), config = readFunctionalConfig(env);
  const directory = path.join(privateRoot, `ownerinc-payload-functional-${runId.replaceAll('-', '')}`), leasePath = path.join(directory, 'lease.json');
  const lease = { phase: 'editorial', identity: { runId }, config, binding: input.expected.source };
  const calls = [], reads = [];
  return { ...input, env, lease, calls, reads, leasePath,
    deps: { deadline: input.expected.notAfter + executionReserve, now: () => Date.now() + 1000, binding: async () => input.expected.source,
      read: async filename => { reads.push(filename); return filename === leasePath ? lease : input.report; },
      run: async (program, args, options) => {
        calls.push({ program, args, options });
        if (args[1] === '--prepare-lease') return { code: 0, stdout: `payload-functional: PREPARED; services not contacted; acceptance INCOMPLETE\nlease: ${leasePath}\n`, stderr: '' };
        return input.result;
      } } };
}

test('orchestration prepares exactly one fresh lease, invokes the actual CLI once and reads its private persisted report', async () => {
  const f = await orchestrationFixture();
  f.deps.now = () => f.calls.length ? f.expected.notAfter : f.expected.notBefore;
  const summary = await qualifyEditorial(f.env, f.deps);
  assert.equal(summary.editorialBrowser, 'PASS'); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(call => [call.program, call.args]), [
    [process.execPath, ['scripts/test-payload-integration.mjs', '--prepare-lease']],
    [process.execPath, ['scripts/test-payload-integration.mjs', '--execute', '--lease', f.leasePath]],
  ]);
  assert.deepEqual(f.reads, [f.leasePath, path.join(path.dirname(f.leasePath), 'functional-acceptance-report.json')]);
  assert.deepEqual(f.calls[1].options, { env: f.env, timeout: executionTimeout, grace: cleanupGrace });
  assert.equal(executionTimeout + cleanupGrace, 14 * 60_000);
});

test('deadline never resets after setup and requires the full execution and cleanup reserve', () => {
  const now = 1793620800000;
  assert.equal(executionReserve, 15 * 60_000);
  const env = { PAYLOAD_EDITORIAL_CI_DEADLINE_MS: String(now + executionReserve) };
  assert.equal(executionDeadline(env, now), now + executionReserve);
  assert.equal(executionDeadline(env, now + 60000), now + executionReserve);
  assert.doesNotThrow(() => assertExecutionWindow(now + executionReserve, now));
  assert.throws(() => assertExecutionWindow(now + executionReserve - 1, now), /insufficient_execution_cleanup_window/u);
  for (const value of [undefined, '', 'NaN', '-1', String(now + jobTimeout + 1)]) {
    assert.throws(() => executionDeadline({ PAYLOAD_EDITORIAL_CI_DEADLINE_MS: value }, now), /execution_deadline_invalid/u);
  }
});

for (const phase of ['before-preparation', 'after-preparation']) test(`insufficient remaining budget ${phase} never spawns --execute or mutable fixture services`, async () => {
  const f = await orchestrationFixture(), start = f.expected.notBefore;
  f.deps.deadline = start + executionReserve + 1000;
  f.deps.now = () => start + (phase === 'before-preparation' || f.calls.length ? 1001 : 0);
  await assert.rejects(qualifyEditorial(f.env, f.deps), /insufficient_execution_cleanup_window/u);
  assert.equal(f.calls.length, phase === 'before-preparation' ? 0 : 1);
  assert.equal(f.calls.some(call => call.args.includes('--execute')), false);
  assert.ok(f.calls.every(call => call.args[1] === '--prepare-lease'), 'only service-free preparation can run');
});

for (const mode of ['exit1', 'timeout', 'missing-report', 'wrong-phase', 'source-changed', 'garbage-prepare']) {
  test(`orchestration ${mode} fails without retrying execution or replacing the lease (all commands doubled)`, async () => {
    const f = await orchestrationFixture();
    f.deps.now = () => f.calls.length ? f.expected.notAfter : f.expected.notBefore;
    if (mode === 'exit1') f.result.code = 1;
    if (mode === 'timeout') f.result.interrupted = true;
    if (mode === 'wrong-phase') f.lease.phase = 'preauthority';
    if (mode === 'missing-report') { const read = f.deps.read; f.deps.read = filename => filename === f.leasePath ? read(filename) : Promise.reject(new Error('missing private report')); }
    if (mode === 'source-changed') f.deps.binding = async () => f.calls.length ? { ...f.expected.source, sourceHash: 'f'.repeat(64) } : f.expected.source;
    if (mode === 'garbage-prepare') { const run = f.deps.run; f.deps.run = async (...args) => ({ ...await run(...args), stdout: 'unknown output' }); }
    await assert.rejects(qualifyEditorial(f.env, f.deps));
    assert.equal(f.calls.filter(call => call.args.includes('--prepare-lease')).length, 1);
    assert.equal(f.calls.filter(call => call.args.includes('--execute')).length, ['wrong-phase', 'garbage-prepare'].includes(mode) ? 0 : 1);
  });
}

test('subprocess diagnostics remain captured and process failures are not retried (real offline Node process)', async () => {
  const result = await runBounded(process.execPath, ['-e', 'process.stdout.write("synthetic-private-stdout");process.stderr.write("synthetic-private-stderr");process.exitCode=1'],
    { env: {}, timeout: 5000 });
  assert.equal(result.code, 1); assert.equal(result.interrupted, false);
  assert.equal(result.stdout, 'synthetic-private-stdout'); assert.equal(result.stderr, 'synthetic-private-stderr');
  const denied = spawnSync(process.execPath, ['scripts/integration/payload-editorial-ci.mjs'], { env: {}, encoding: 'utf8', timeout: 10000 });
  assert.equal(denied.status, 1); assert.equal(denied.stdout, '');
  assert.ok(denied.stderr.includes('hosted_linux_ci_required')); assert.ok(!denied.stderr.includes('PASS'));
});

test('real stalled offline child is interrupted within a bounded grace and cannot be classified as success', async () => {
  const result = await runBounded(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setTimeout(()=>{},60000)'],
    { env: {}, timeout: 200, grace: 200 });
  assert.equal(result.interrupted, true);
  assert.notEqual(result.code, 2);
});

test('workflow YAML has read-only hosted PR/dispatch scope, exact existing action pins and bounded steps', async () => {
  const text = await readFile(workflowPath, 'utf8'), workflow = parse(text);
  const existing = parse(await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['editorial-browser']);
  const job = workflow.jobs['editorial-browser'];
  assert.equal(job.name, 'Editorial browser — four cases only'); assert.equal(job['runs-on'], 'ubuntu-latest'); assert.equal(job['timeout-minutes'], 35);
  assert.equal(job['timeout-minutes'] * 60_000, jobTimeout);
  assert.equal(job.steps.at(-1)['timeout-minutes'], job['timeout-minutes'], 'step start is later, so its cap cannot preempt the job deadline');
  assert.ok(executionReserve < jobTimeout);
  assert.equal(job.services, undefined); assert.equal(job.environment, undefined); assert.equal(job['continue-on-error'], undefined);
  const pins = existing.jobs['payload-manual-runtime'].steps.filter(step => step.uses).map(step => step.uses);
  assert.deepEqual(job.steps.filter(step => step.uses).map(step => step.uses), pins);
  assert.deepEqual(job.steps[0].with, { ref: '${{ github.sha }}', 'persist-credentials': false });
  assert.equal(job.steps[1].with['node-version'], 24);
  for (const step of job.steps) {
    assert.equal(step['continue-on-error'], undefined);
    if (step.run) assert.ok(step['timeout-minutes'] > 0 && step['timeout-minutes'] <= (step === job.steps.at(-1) ? 35 : 16));
  }
  assert.equal(job.steps.find(step => step.name.startsWith('Prepare isolated')).run, 'node scripts/prepare-ci-registry-pulls.mjs');
  assert.equal(job.steps.at(-1).run, 'node scripts/integration/payload-editorial-ci.mjs');
  const tokenSteps = job.steps.filter(step => Object.hasOwn(step.env || {}, 'PAYLOAD_EDITORIAL_RUN_TOKEN'));
  assert.equal(tokenSteps.length, 1); assert.equal(tokenSteps[0].name, 'Bind deadline to this workflow run attempt');
  assert.deepEqual(tokenSteps[0].env, { PAYLOAD_EDITORIAL_RUN_TOKEN: '${{ github.token }}' });
  assert.equal(job.steps.at(-1).env, undefined);
  assert.doesNotMatch(text, /secrets\.|upload-artifact|docker (?:push|login)|ip -[46] route|system prune|volume prune|pull_request_target|continue-on-error/u);
  for (const filename of ['cms/src/admin/RestoreDraft.tsx', 'cms/tests/integration/functional-editorial.mjs', 'api/routes/cms.js',
    'public/js/cms.js', 'nginx/nginx.conf', 'firebase-emulator/Dockerfile', 'scripts/integration/payload-functional-run.mjs',
    'scripts/integration/payload-editorial-ci.mjs', 'tests/unit/payload-editorial-workflow.test.mjs', '.github/workflows/payload-editorial-check.yml']) {
    assert.ok(workflow.on.pull_request.paths.some(pattern => path.matchesGlob(filename, pattern)), `missing PR path ${filename}`);
  }
  assert.equal(workflow.on.pull_request.paths.some(pattern => path.matchesGlob('cron/operational-monitor.js', pattern)), false);
  const browserStep = job.steps.find(step => step.name === 'Install external pinned Chromium tooling');
  assert.ok(browserStep.run.includes(`playwright@${playwrightVersion}`));
  assert.ok(browserStep.run.includes('"$RUNNER_TEMP/payload-editorial-tools"'));
  assert.ok(browserStep.run.includes('install --with-deps chromium'));
  const availablePins = CI_BASE_PINS.map(([name, tag, value]) => `${name}:${tag}@sha256:${value}`);
  for (const filename of ['api/Dockerfile', 'cms/Dockerfile', 'firebase-emulator/Dockerfile']) {
    const dockerfile = await readFile(filename, 'utf8');
    for (const match of dockerfile.matchAll(/^FROM (?:--platform=\S+ )?(\S+)/gmu)) {
      if (match[1].includes('@sha256:')) assert.ok(availablePins.includes(match[1]), `unprepared base in ${filename}`);
    }
  }
});

test('actual bootstrap script binds only this run attempt and includes pre-step time without persisting its token (HTTP doubled)', async t => {
  const workflow = parse(await readFile(workflowPath, 'utf8'));
  const body = workflow.jobs['editorial-browser'].steps.find(step => step.name === 'Bind deadline to this workflow run attempt').run;
  const script = body.slice(body.indexOf('\n') + 1, body.lastIndexOf('\nNODE'));
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)('process', 'fetch', script);
  const scratch = await mkdtemp(path.join(path.dirname(privateRoot), 'editorial-deadline-unit-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const output = path.join(scratch, 'github-env'), now = Date.now();
  // Started 21 minutes ago, including queue and runner bootstrap before any step.
  // A newly captured step-local "start" would incorrectly grant another 35m.
  const started = Math.floor((now - 21 * 60_000) / 1000) * 1000;
  for (const mode of ['valid', 'wrong-repository', 'wrong-run', 'wrong-attempt', 'future-start', 'missing-start', 'http-error']) {
    await writeFile(output, '');
    const metadata = { id: 123456, run_attempt: 2, repository: { full_name: 'ownerinc/portal' }, run_started_at: new Date(started).toISOString() };
    if (mode === 'wrong-repository') metadata.repository.full_name = 'another/repo';
    if (mode === 'wrong-run') metadata.id++;
    if (mode === 'wrong-attempt') metadata.run_attempt++;
    if (mode === 'future-start') metadata.run_started_at = new Date(now + 60_000).toISOString();
    if (mode === 'missing-start') delete metadata.run_started_at;
    const calls = [];
    const operation = () => execute({ env: { GITHUB_REPOSITORY: 'ownerinc/portal', GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '2',
      GITHUB_ENV: output, PAYLOAD_EDITORIAL_RUN_TOKEN: 'synthetic-bootstrap-only-token' } }, async (url, options) => {
      calls.push({ url, options }); return { ok: mode !== 'http-error', json: async () => metadata };
    });
    if (mode === 'valid') {
      await operation();
      assert.equal(await readFile(output, 'utf8'), `PAYLOAD_EDITORIAL_CI_DEADLINE_MS=${started + jobTimeout}\n`);
      assert.throws(() => assertExecutionWindow(started + jobTimeout, now), /insufficient_execution_cleanup_window/u);
    } else {
      await assert.rejects(operation()); assert.equal(await readFile(output, 'utf8'), '');
    }
    assert.equal(calls.length, 1, 'run lookup is not retried');
    assert.equal(calls[0].url, 'https://api.github.com/repos/ownerinc/portal/actions/runs/123456/attempts/2');
    assert.equal(calls[0].options.redirect, 'error');
    assert.ok(calls[0].options.signal instanceof AbortSignal);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-bootstrap-only-token');
    assert.ok(!(await readFile(output, 'utf8')).includes('synthetic-bootstrap-only-token'));
  }
});

const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
test('actual workflow build shell binds all three contexts, local IDs and revisions; mismatched image labels and packaging fail (Docker doubled)', async t => {
  const bash = ['bash', 'C:/Program Files/Git/bin/bash.exe'].find(command => spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10000 }).status === 0);
  if (!bash) { t.skip('Bash unavailable; workflow shell execution not verified'); return; }
  const parent = path.dirname(privateRoot), scratch = await mkdtemp(path.join(parent, 'editorial-ci-shell-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const stub = path.join(scratch, 'docker-double.cjs'), trace = path.join(scratch, 'calls.jsonl'), outputs = path.join(scratch, 'github-env');
  await writeFile(stub, String.raw`const fs=require('node:fs'),path=require('node:path');const a=process.argv.slice(2);fs.appendFileSync(process.env.TRACE,JSON.stringify(a)+'\n');
if(a[0]==='context')process.stdout.write('default\n');
else if(a[0]==='buildx')process.stdout.write('Driver: docker\n');
else if(a[0]==='build'){const f=a[a.indexOf('--iidfile')+1];const role=path.basename(f).split('-')[1].split('.')[0];fs.writeFileSync(f,'sha256:'+({api:'1',cms:'2',emulator:'3'}[role]).repeat(64));}
else if(a[0]==='image')process.stdout.write(process.env.MODE==='bad-label'?'f'.repeat(40):process.env.GITHUB_SHA);
else if(a[0]==='run')process.exitCode=process.env.MODE==='missing-package'?1:0;
else process.exitCode=99;`);
  const workflow = parse(await readFile(workflowPath, 'utf8'));
  const body = workflow.jobs['editorial-browser'].steps.find(step => step.name === 'Build immutable local qualification images').run;
  const preamble = `docker() { ${shellQuote(process.execPath.replaceAll('\\', '/'))} ${shellQuote(stub.replaceAll('\\', '/'))} "$@"; }\ngit() { printf '%s\\n' "$GITHUB_SHA"; }\n`;
  for (const mode of ['ok', 'bad-label', 'missing-package']) {
    await writeFile(trace, ''); await writeFile(outputs, '');
    const env = { ...process.env, RUNNER_TEMP: scratch.replaceAll('\\', '/'), GITHUB_ENV: outputs.replaceAll('\\', '/'),
      RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_SHA: revision, TRACE: trace, MODE: mode };
    delete env.DOCKER_HOST; delete env.DOCKER_CONTEXT;
    const result = spawnSync(bash, ['-c', preamble + body], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, mode === 'ok' ? 0 : 1, result.stderr);
    const calls = (await readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const builds = calls.filter(args => args[0] === 'build'); assert.equal(builds.length, 3);
    assert.deepEqual(builds.map(args => [args[args.indexOf('--file') + 1], args.at(-1)]),
      [['api/Dockerfile', 'api'], ['cms/Dockerfile', '.'], ['firebase-emulator/Dockerfile', 'firebase-emulator']]);
    for (const args of builds) {
      assert.equal(args[args.indexOf('--label') + 1], `org.opencontainers.image.revision=${revision}`);
      assert.equal(args[args.indexOf('--platform') + 1], 'linux/amd64');
      assert.ok(!args.includes('--push') && !args.includes('--build-arg'));
    }
    if (mode === 'ok') {
      assert.deepEqual((await readFile(outputs, 'utf8')).trim().split('\n'),
        [`PAYLOAD_FUNCTIONAL_API_IMAGE=${image('1')}`, `PAYLOAD_FUNCTIONAL_CMS_IMAGE=${image('2')}`, `PAYLOAD_FUNCTIONAL_EMULATOR_IMAGE=${image('3')}`]);
      const smoke = calls.find(args => args[0] === 'run'); assert.ok(smoke.includes(image('2')) && smoke.includes('--read-only'));
    }
    if (mode === 'bad-label') assert.equal(calls.some(args => args[0] === 'run'), false);
  }
});
