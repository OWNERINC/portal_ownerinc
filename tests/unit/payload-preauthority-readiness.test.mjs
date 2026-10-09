import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  CMS_READINESS_ROUTE,
  createCommandDiagnostic,
  createReadinessDiagnostic,
  createRecoveryProgressReport,
  inferReadinessFailureReason,
} from '../../scripts/integration/payload-preauthority-diagnostics.mjs';
import {
  createRecoveryFailureReportFields,
  runSnapshotAndRestart,
} from '../../scripts/integration/payload-preauthority-recovery-flow.mjs';

const recoveryRunner = await readFile(new URL('../../scripts/test-payload-preauthority-recovery.mjs', import.meta.url), 'utf8');
const commandRunner = await readFile(new URL('../../scripts/integration/payload-preauthority-command.mjs', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');

test('readiness report values are restricted to the state, status, exit and expected route allowlists', () => {
  assert.equal(CMS_READINESS_ROUTE, '/editorial/ready');
  assert.deepEqual(createReadinessDiagnostic({
    reason: 'unhealthy',
    containerState: 'running',
    healthStatus: 'unhealthy',
    containerExitCode: 0,
    readinessHttpStatus: 503,
    service: 'cms',
  }), {
    reason: 'unhealthy',
    containerState: 'running',
    healthStatus: 'unhealthy',
    containerExitCode: 0,
    readinessHttpStatus: 503,
    expectedRoute: '/editorial/ready',
  });

  const hostile = createReadinessDiagnostic({
    reason: 'private-password-value',
    containerState: 'running private-environment',
    healthStatus: 'unhealthy response body',
    containerExitCode: '0 private-output',
    readinessHttpStatus: '503 response-body',
    service: 'cms with private value',
  });
  assert.deepEqual(hostile, {
    reason: 'diagnostic_unavailable',
    containerState: 'unknown',
    healthStatus: 'unknown',
    containerExitCode: null,
    readinessHttpStatus: null,
    expectedRoute: null,
  });
  assert.doesNotMatch(JSON.stringify(hostile), /private|response|body|environment/u);
});

test('readiness failures distinguish missing, exited, unhealthy and bounded wait-deadline causes', () => {
  assert.equal(inferReadinessFailureReason('wait_deadline', { containerId: '', containerState: 'unknown' }), 'missing');
  assert.equal(inferReadinessFailureReason('wait_deadline', { containerId: 'fixture-id', containerState: 'exited' }), 'exited');
  assert.equal(inferReadinessFailureReason('wait_deadline', { containerId: 'fixture-id', containerState: 'running', healthStatus: 'unhealthy' }), 'unhealthy');
  assert.equal(inferReadinessFailureReason('wait_deadline', { containerId: 'fixture-id', containerState: 'running', healthStatus: 'starting' }), 'wait_deadline');
  assert.equal(inferReadinessFailureReason('private-password', { containerId: 'fixture-id', containerState: 'running' }), 'diagnostic_unavailable');
});

test('recovery progress reports only fixed fixture roles and allowlisted snapshot outcomes', () => {
  assert.deepEqual(createRecoveryProgressReport({
    source: { initialCmsHealthPassed: true, writersRestartedHealthy: true, quiescentSnapshotComparison: 'passed' },
    target: { initialCmsHealthPassed: true, writersRestartedHealthy: false, quiescentSnapshotComparison: 'failed' },
    attackerControlledRole: { initialCmsHealthPassed: true, writersRestartedHealthy: true, quiescentSnapshotComparison: 'secret' },
  }), {
    source: { initialCmsHealthPassed: true, writersRestartedHealthy: true, quiescentSnapshotComparison: 'passed' },
    target: { initialCmsHealthPassed: true, writersRestartedHealthy: false, quiescentSnapshotComparison: 'failed' },
    leaseTarget: { initialCmsHealthPassed: false, writersRestartedHealthy: false, quiescentSnapshotComparison: 'not_started' },
  });
});

test('CMS readiness diagnostics read only allowlisted Docker fields and HTTP status, never response content', () => {
  assert.match(recoveryRunner, /\{\{\.State\.Status\}\}\|\{\{\.State\.ExitCode\}\}\|\{\{if \.State\.Health\}\}\{\{\.State\.Health\.Status\}\}\{\{else\}\}none\{\{end\}\}/u);
  assert.match(recoveryRunner, /http:\/\/127\.0\.0\.1:3001\$\{CMS_READINESS_ROUTE\}/u);
  assert.match(recoveryRunner, /const status=String\(response\.status\);await response\.body\?\.cancel\(\)/u);
  assert.match(recoveryRunner, /process\.stdout\.write\(status\)/u);
  assert.match(recoveryRunner, /recoveryProgress\[runtime\.role\]\.initialCmsHealthPassed = true/u);
  assert.match(recoveryRunner, /quiescentSnapshotComparison = 'passed'/u);
  assert.match(recoveryRunner, /quiescentSnapshotComparison = 'failed'/u);
  assert.match(recoveryRunner, /setStage\(`restart_writers_\$\{runtime\.role\}`\)/u);
  assert.match(recoveryRunner, /setStage\(`verify_release_\$\{runtime\.role\}`\)/u);
  assert.match(recoveryRunner, /failedStage: outcome\.primaryPhase === 'snapshot' \? snapshotStage : stage/u);
  assert.match(recoveryRunner, /recoveryProgress: createRecoveryProgressReport\(recoveryProgress\)/u);
  assert.match(recoveryRunner, /controlCommandOptions\(action, release\)/u);
  assert.match(recoveryRunner, /persistPrivateCommandEvidence\(\s*fixtureRoot,\s*privateCommandEvidence,\s*\)/u);
  assert.match(recoveryRunner, /substep: 'snapshot_restart_writers',[\s\S]{0,120}preservePrivateErrorEvidence: true/u);
  assert.match(recoveryRunner, /recoveryProgress\[runtime\.role\]\.writersRestartedHealthy = true/u);
  assert.doesNotMatch(recoveryRunner, /response\.(?:text|json|arrayBuffer)\(|docker', \['logs'|State\.Health\.Log|Config\.Env/u);
  assert.match(commandRunner, /path\.join\(fixtureRoot, 'private-diagnostics'\)/u);
  assert.match(commandRunner, /chmod\(directory, 0o700\)/u);
  assert.match(commandRunner, /chmod\(target, 0o600\)/u);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/payload-preauthority-recovery-report\.json/u);
  assert.doesNotMatch(workflow, /private-diagnostics|command-stderr\.txt/u);
});

test('serialized recovery reports keep snapshot failure primary and restart failure secondary only when both fail', async () => {
  const snapshotDiagnostic = createCommandDiagnostic({
    substep: 'snapshot_compare_quiescent',
    status: 17,
  });
  const restartDiagnostic = createCommandDiagnostic({
    substep: 'wait_cms_health',
    status: 2,
  });
  const restartReadiness = createReadinessDiagnostic({
    reason: 'unhealthy',
    containerState: 'running',
    healthStatus: 'unhealthy',
    containerExitCode: 0,
    readinessHttpStatus: 503,
    service: 'cms',
  });
  const snapshotError = Object.assign(new Error('private snapshot stderr'), {
    code: 'snapshot_command_failed', diagnostic: snapshotDiagnostic,
  });
  const restartError = Object.assign(new Error('private restart stderr'), {
    code: 'service_cms_not_ready',
    diagnostic: restartDiagnostic,
    readinessDiagnostic: restartReadiness,
  });

  async function runScenario(snapshotFails, restartFails) {
    const calls = [];
    let activeSubstep = null;
    const outcome = await runSnapshotAndRestart(
      async () => {
        calls.push('snapshot');
        activeSubstep = 'snapshot_compare_quiescent';
        if (snapshotFails) throw snapshotError;
        return 'snapshot-stable';
      },
      async () => {
        calls.push('restart');
        activeSubstep = 'wait_cms_health';
        if (restartFails) throw restartError;
      },
      () => activeSubstep,
    );
    const report = JSON.parse(JSON.stringify({
      status: outcome.primaryError ? 'failed' : 'passed',
      ...(outcome.primaryError ? createRecoveryFailureReportFields(outcome) : {}),
    }));
    return { calls, outcome, report };
  }

  const snapshotOnly = await runScenario(true, false);
  assert.deepEqual(snapshotOnly.calls, ['snapshot', 'restart']);
  assert.equal(snapshotOnly.outcome.primaryError, snapshotError);
  assert.equal(snapshotOnly.outcome.primaryPhase, 'snapshot');
  assert.equal(snapshotOnly.outcome.secondaryError, null);
  assert.equal(snapshotOnly.report.failureCode, 'snapshot_command_failed');
  assert.equal(snapshotOnly.report.failedSubstep, 'snapshot_compare_quiescent');
  assert.deepEqual(snapshotOnly.report.commandDiagnostic, snapshotDiagnostic);
  assert.equal('failureContext' in snapshotOnly.report, false);

  const restartOnly = await runScenario(false, true);
  assert.deepEqual(restartOnly.calls, ['snapshot', 'restart']);
  assert.equal(restartOnly.outcome.primaryError, restartError);
  assert.equal(restartOnly.outcome.primaryPhase, 'writer_restart');
  assert.equal(restartOnly.outcome.secondaryError, null);
  assert.equal(restartOnly.report.failureCode, 'service_cms_not_ready');
  assert.equal(restartOnly.report.failedSubstep, 'wait_cms_health');
  assert.deepEqual(restartOnly.report.commandDiagnostic, restartDiagnostic);
  assert.deepEqual(restartOnly.report.readinessDiagnostic, restartReadiness);
  assert.equal('failureContext' in restartOnly.report, false);

  const both = await runScenario(true, true);
  assert.deepEqual(both.calls, ['snapshot', 'restart']);
  assert.equal(both.outcome.primaryError, snapshotError);
  assert.equal(both.outcome.primaryPhase, 'snapshot');
  assert.equal(both.outcome.secondaryError, restartError);
  assert.equal(both.report.failureCode, 'snapshot_command_failed');
  assert.equal(both.report.failedSubstep, 'snapshot_compare_quiescent');
  assert.deepEqual(both.report.commandDiagnostic, snapshotDiagnostic);
  assert.deepEqual(both.report.failureContext.writerRestart, {
    failureCode: 'service_cms_not_ready',
    failedSubstep: 'wait_cms_health',
    commandDiagnostic: restartDiagnostic,
    readinessDiagnostic: restartReadiness,
  });
  assert.doesNotMatch(JSON.stringify(both.report), /private snapshot stderr|private restart stderr/u);

  const unclassifiedError = Object.assign(new Error('private command failure'), {
    code: 'fixture_command_failed',
    diagnostic: { substep: 'unclassified_command', commandExitCode: 2 },
  });
  const boundedFallback = createRecoveryFailureReportFields({
    primaryError: unclassifiedError,
    primarySubstep: 'snapshot_restart_writers',
  });
  assert.equal(boundedFallback.failedSubstep, 'snapshot_restart_writers');
  assert.equal(boundedFallback.commandDiagnostic.substep, 'snapshot_restart_writers');
});
