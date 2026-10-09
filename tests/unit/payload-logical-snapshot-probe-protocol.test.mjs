import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { CONVERSION_PROBE_CONTEXT, CONVERSION_PROBE_SUCCESS, conversionProbePhases,
  encodeConversionProbeFailure, parseConversionProbeFailure, conversionCliLaunchReason } from '../../scripts/integration/payload-logical-snapshot-probe-protocol.mjs';
import { conversionProbeFailure, verifyLinuxConversionPrerequisite } from '../../scripts/integration/payload-logical-snapshot-conversion-probe.mjs';
import { createLeasedCommandInvocation, FixtureFailure, runFixtureCommand } from '../../scripts/integration/payload-preauthority-command.mjs';
import { createRecoveryFailureReportFields, runSnapshotAndRestart } from '../../scripts/integration/payload-preauthority-recovery-flow.mjs';

const message = (changes = {}) => ({ phase: 'conversion_create', reason: 'psql_failed', sqlState: '58P01', logicalError: null, mismatch: null, ...changes });
const context = (changes = {}) => ({ context: CONVERSION_PROBE_CONTEXT, status: 2, stdout: '', ...changes });
const executeFailure = (body, options = {}, status = 2, stdout = '') => {
  let caught;
  try {
    runFixtureCommand(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(body)},()=>process.exit(${status}))`], {
      substep: 'linux_conversion_prerequisite', failureCode: 'linux_conversion_prerequisite_failed',
      conversionProbeCommandContext: CONVERSION_PROBE_CONTEXT, ...options,
    });
  } catch (error) { caught = error; }
  assert.ok(caught instanceof FixtureFailure);
  return caught;
};

test('conversion protocol carries only finite complete exact-context failures; timeout, partial and arbitrary output are rejected', () => {
  const body = encodeConversionProbeFailure(message());
  assert.deepEqual(parseConversionProbeFailure(body, context()), message());
  for (const invalid of [body + 'private-data\n', 'private-data\n' + body, body.trimEnd(), body.replace(/\n$/u, '\r\n'),
    body.replace('"phase":', '"phase": "conversion_create", "phase":'),
    body.replace('"sqlState":"58P01"', '"sqlState":"private-data"'),
    body.replace('"reason":"psql_failed"', '"reason":"private-data"'),
    body.replace('"phase":"conversion_create"', '"phase":"private-data"')]) {
    assert.equal(parseConversionProbeFailure(invalid, context()), null);
  }
  for (const invalid of [{ context: undefined }, { context: 'logical-snapshot-cli' }, { status: 0 }, { status: 3 },
    { signal: 'SIGTERM' }, { errorCode: 'ETIMEDOUT' }, { stdout: 'private-data' }]) {
    assert.equal(parseConversionProbeFailure(body, context(invalid)), null);
  }
  assert.throws(() => encodeConversionProbeFailure(message({ phase: 'conversion_reject_cli' })), /invalid_conversion_probe_diagnostic/u);
});

test('the actual throwing command wrapper retains phase, reason, SQLSTATE and private stderr without widening report fields', () => {
  for (const sqlState of ['58P01', '0A000', '42883', '42710', '22021']) {
    const evidence = [];
    const body = encodeConversionProbeFailure(message({ sqlState }));
    const error = executeFailure(body, { privateCommandEvidence: evidence, preservePrivateErrorEvidence: true });
    assert.equal(error.code, 'linux_conversion_create_psql_failed');
    const report = createRecoveryFailureReportFields({ primaryError: error });
    assert.equal(report.failedSubstep, 'conversion_create');
    assert.equal(report.commandDiagnostic.sqlState, sqlState);
    assert.equal(report.commandDiagnostic.commandExitCode, 2);
    assert.equal(evidence[0].stderr.toString(), body);
    assert.deepEqual(Object.keys(report).sort(), ['commandDiagnostic', 'failedSubstep', 'failureCode']);
  }
  const cli = executeFailure(encodeConversionProbeFailure(message({ phase: 'conversion_baseline_cms_cli', reason: 'cli_failed',
    sqlState: null, logicalError: 'logical_snapshot_unsupported_object' })));
  assert.equal(cli.code, 'linux_conversion_baseline_cms_cli_cli_failed');
  assert.equal(cli.diagnostic.logicalSnapshotErrorIdentifier, 'logical_snapshot_unsupported_object');
  for (const phase of conversionProbePhases) {
    const error = executeFailure(encodeConversionProbeFailure(message({ phase, reason: 'internal_error', sqlState: null })));
    assert.equal(error.diagnostic.substep, phase, 'all phases survive the real wrapper and sanitizer');
  }
});

test('component/hash mismatch crosses the actual child wrapper and sanitizes into the existing six-component diagnostic', () => {
  const mismatch = [{ component: 'cmsUploads', expectedHash: 'a'.repeat(64), actualHash: 'b'.repeat(64) }];
  const error = executeFailure(encodeConversionProbeFailure(message({ phase: 'conversion_compare_all_stores',
    reason: 'snapshot_mismatch', sqlState: null, mismatch })));
  const report = createRecoveryFailureReportFields({ primaryError: error });
  assert.equal(report.failureCode, 'linux_conversion_compare_all_stores_snapshot_mismatch');
  assert.deepEqual(report.snapshotMismatch, mismatch);
  for (const invalid of [[...mismatch, ...mismatch], [{ ...mismatch[0], component: 'private-name' }],
    [{ ...mismatch[0], expectedHash: 'private-data' }], [{ ...mismatch[0], extra: 'private-data' }]]) {
    assert.throws(() => encodeConversionProbeFailure(message({ phase: 'conversion_compare_all_stores', reason: 'snapshot_mismatch', sqlState: null, mismatch: invalid })));
  }
});

test('malformed exit-2 and contradictory success cannot satisfy the prerequisite or publish raw output', () => {
  for (const body of ['', 'logical_snapshot_unsupported_object\n', 'private-data\n', encodeConversionProbeFailure(message()) + 'private\n']) {
    const error = executeFailure(body);
    assert.equal(error.code, 'linux_conversion_probe_protocol_invalid');
    assert.doesNotMatch(JSON.stringify(createRecoveryFailureReportFields({ primaryError: error })), /private-data|58P01/u);
  }
  const unrelated = executeFailure(encodeConversionProbeFailure(message()), { conversionProbeCommandContext: null });
  assert.equal(unrelated.code, 'linux_conversion_prerequisite_failed');
  assert.equal(unrelated.diagnostic.sqlState, null);
  for (const [stdout, stderr] of [[CONVERSION_PROBE_SUCCESS, 'private-data\n'], ['wrong-success\n', ''], ['', encodeConversionProbeFailure(message())]]) {
    const error = executeFailure(stderr, {}, 0, stdout);
    assert.equal(error.code, 'linux_conversion_probe_protocol_invalid');
  }
  assert.equal(runFixtureCommand(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(CONVERSION_PROBE_SUCCESS)})`],
    { conversionProbeCommandContext: CONVERSION_PROBE_CONTEXT }).toString(), CONVERSION_PROBE_SUCCESS);
});

test('fine-grained primary phase survives cleanup, comparison and writer restart failures without accepting a SQL failure as rejection', async () => {
  let phase;
  const primary = Object.assign(new FixtureFailure('fixture_command_failed', { commandExitCode: 3, sqlState: '58P01' }), { probeReason: 'psql_failed' });
  const snapshot = Object.fromEntries(['portalDatabase','cmsDatabase','portalSchema','cmsSchema','portalUploads','cmsUploads'].map(key => [key, 'a'.repeat(64)]));
  const result = await runSnapshotAndRestart(() => verifyLinuxConversionPrerequisite({
    step: value => { phase = value; }, failureStep: () => phase, assertStopped: () => {}, snapshot: () => snapshot,
    create: () => {}, present: () => true,
    captureActual: () => { phase = 'conversion_reject_sql'; throw primary; },
    remove: () => { phase = 'conversion_cleanup'; throw new Error('private-cleanup-failure'); },
  }), () => { throw new FixtureFailure('fixture_command_failed', { substep: 'snapshot_restart_writers', commandExitCode: 1 }); }, () => phase);
  assert.equal(result.primaryError, primary);
  assert.equal(result.primarySubstep, 'conversion_reject_sql');
  const typed = conversionProbeFailure(primary, phase);
  assert.equal(typed.phase, 'conversion_reject_sql');
  assert.equal(typed.reason, 'psql_failed');
  assert.equal(typed.sqlState, '58P01');
  const propagated = executeFailure(encodeConversionProbeFailure(typed));
  const report = createRecoveryFailureReportFields({ ...result, primaryError: propagated });
  assert.equal(report.failedSubstep, 'conversion_reject_sql');
  assert.equal(report.failureContext.writerRestart.failedSubstep, 'snapshot_restart_writers');
});

test('actual probe executable emits a strict configuration failure before invoking any engine or Compose command', () => {
  let error;
  try {
    runFixtureCommand(process.execPath, [path.resolve('scripts/integration/payload-logical-snapshot-conversion-probe.mjs')], {
      input: '{private-invalid-json', conversionProbeCommandContext: CONVERSION_PROBE_CONTEXT,
    });
  } catch (caught) { error = caught; }
  assert.ok(error instanceof FixtureFailure);
  assert.equal(error.code, 'linux_conversion_validate_fixture_configuration_invalid');
  assert.equal(error.diagnostic.substep, 'conversion_validate_fixture');
  assert.doesNotMatch(JSON.stringify(error.diagnostic), /private-invalid-json/u);
});

test('actual native Node missing-import exit is classified only in the CLI context; private module path never crosses the wrapper', () => {
  const missing = pathToFileURL(path.resolve('tests/unit/private-fixture-nonexistent-conversion-loader.mjs')).href;
  const result = spawnSync(process.execPath, ['--import', missing, '-e', 'process.exit(0)'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(conversionCliLaunchReason(result.stderr, { context: 'logical-snapshot-cli', status: 1 }), 'cli_module_not_found');
  assert.equal(conversionCliLaunchReason(result.stderr, { context: CONVERSION_PROBE_CONTEXT, status: 1 }), null);
  assert.equal(conversionCliLaunchReason(result.stderr, { context: 'logical-snapshot-cli', status: 2 }), null);
  assert.equal(conversionCliLaunchReason(result.stderr, { context: 'logical-snapshot-cli', status: 1, errorCode: 'ETIMEDOUT' }), null);
  const error = executeFailure(encodeConversionProbeFailure(message({ phase: 'conversion_baseline_portal_cli',
    reason: 'cli_module_not_found', sqlState: null })));
  assert.equal(error.code, 'linux_conversion_baseline_portal_cli_cli_module_not_found');
  assert.doesNotMatch(JSON.stringify(createRecoveryFailureReportFields({ primaryError: error })), /private-fixture|loader\.mjs|stack/u);
});

test('Linux actual Bash lease exec -> native Node -> asynchronous stdin EOF retains FD9 inode identity (no Docker)', async t => {
  if (process.platform !== 'linux' || spawnSync('bash', ['-c', 'command -v flock'], { stdio: 'ignore' }).status !== 0) {
    return t.skip('requires native Linux Node and Bash/flock; no Windows FD emulation is engine evidence');
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'conversion-native-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'deploy.lock');
  await writeFile(lock, 'synthetic lock\n', { mode: 0o600 });
  const code = `import {fstatSync,lstatSync} from 'node:fs';
for await(const part of process.stdin) {}
const lease=fstatSync(9,{bigint:true}); const lock=lstatSync(process.env.PORTAL_OPERATION_LOCK,{bigint:true});
if(lease.dev!==lock.dev||lease.ino!==lock.ino||!lease.isFile()) process.exit(3);
process.stdout.write('inherited_lease_retained\\n');`;
  const invocation = createLeasedCommandInvocation(lock, process.execPath, ['--input-type=module', '-e', code]);
  assert.equal(runFixtureCommand(invocation.command, invocation.args, { input: 'synthetic input' }).toString(), 'inherited_lease_retained\n');
});
