import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createRecoveryFailureReportFields,
  runSnapshotAndRestart,
} from '../../scripts/integration/payload-preauthority-recovery-flow.mjs';
import { createCommandDiagnostic } from '../../scripts/integration/payload-preauthority-diagnostics.mjs';
import {
  controlCommandOptions,
  createLeasedCommandInvocation,
  FixtureFailure,
  persistPrivateCommandEvidence,
  runFixtureCommand,
} from '../../scripts/integration/payload-preauthority-command.mjs';

const leaseShellCheck = spawnSync('bash', ['-c', 'command -v flock >/dev/null 2>&1'], {
  env: { PATH: process.env.PATH || '/usr/bin:/bin' },
  stdio: 'ignore',
});
const supportsLeaseShell = !leaseShellCheck.error && leaseShellCheck.status === 0;

async function assertExitTwoIsPrivateOnly(t, runCommand) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'payload-command-diagnostic-'));
  await chmod(fixtureRoot, 0o700);
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const secretDiagnostic = 'synthetic-private-stderr-73b74d23';
  const args = ['-e', `process.stderr.write(${JSON.stringify(secretDiagnostic)});process.exit(2)`];
  const evidence = [];
  const options = controlCommandOptions('verify-release', '/synthetic/release');
  const substep = options.substep;
  let thrown;

  try {
    await runCommand({
      cwd: fixtureRoot,
      env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: process.env.HOME || fixtureRoot },
      ...options,
      args,
      privateCommandEvidence: evidence,
    });
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof FixtureFailure);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].substep, 'payload_control_verify_release');
  assert.match(evidence[0].stderr.toString('utf8'), /synthetic-private-stderr/u);
  const privateEvidenceRetained = await persistPrivateCommandEvidence(fixtureRoot, evidence);
  const report = JSON.parse(JSON.stringify({
    status: 'failed',
    ...createRecoveryFailureReportFields({ primaryError: thrown, primarySubstep: substep }),
    evidence: { privateRunnerErrorEvidenceRetained: privateEvidenceRetained },
  }));

  assert.equal(report.failureCode, 'fixture_command_failed');
  assert.equal(report.failedSubstep, 'payload_control_verify_release');
  assert.equal(report.commandDiagnostic.substep, 'payload_control_verify_release');
  assert.equal(report.commandDiagnostic.commandExitCode, 2);
  assert.equal(report.evidence.privateRunnerErrorEvidenceRetained, true);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-private-stderr|stderr|stdout/u);

  const evidencePath = path.join(fixtureRoot, 'private-diagnostics', 'command-stderr.txt');
  assert.match(await readFile(evidencePath, 'utf8'), /synthetic-private-stderr-73b74d23/u);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.dirname(evidencePath))).mode & 0o777, 0o700);
    assert.equal((await stat(evidencePath)).mode & 0o777, 0o600);
  }
}

test('exit-2 command keeps stderr private while producing a bounded caller report', async t => {
  await assertExitTwoIsPrivateOnly(t, ({ args, ...options }) => runFixtureCommand(process.execPath, args, options));
});

test('known adapter reason survives command capture and primary/secondary report sanitization', async () => {
  const options = controlCommandOptions('verify-release', '/synthetic/release');
  assert.equal(options.controlCommandContext, 'payload-control:verify-release');
  assert.equal(controlCommandOptions('backup-metadata', '/synthetic/release').controlCommandContext, null);
  const invokeFailure = stderrText => {
    let failure;
    try {
      runFixtureCommand(process.execPath, [
        '-e', `process.stderr.write(${JSON.stringify(stderrText)});process.exit(2)`,
      ], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH || '', HOME: process.env.HOME || process.cwd() },
        ...options,
        privateCommandEvidence: [],
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof FixtureFailure);
    return failure;
  };

  const adapterFailure = invokeFailure('planned_release_mismatch\n');
  assert.equal(adapterFailure.diagnostic.controlErrorIdentifier, 'planned_release_mismatch');
  const primaryReport = createRecoveryFailureReportFields({
    primaryError: adapterFailure,
    primarySubstep: options.substep,
  });
  assert.equal(primaryReport.commandDiagnostic.controlErrorIdentifier, 'planned_release_mismatch');
  assert.doesNotMatch(JSON.stringify(primaryReport), /planned release image|secret|stderr/u);

  const snapshotError = Object.assign(new Error('synthetic snapshot failure'), {
    code: 'snapshot_command_failed',
    diagnostic: createCommandDiagnostic({ substep: 'snapshot_compare_quiescent', status: 2 }),
  });
  let activeSubstep = null;
  const outcome = await runSnapshotAndRestart(
    async () => {
      activeSubstep = 'snapshot_compare_quiescent';
      throw snapshotError;
    },
    async () => {
      activeSubstep = options.substep;
      throw adapterFailure;
    },
    () => activeSubstep,
  );
  const secondaryReport = JSON.parse(JSON.stringify(createRecoveryFailureReportFields(outcome)));
  assert.equal(secondaryReport.failureCode, 'snapshot_command_failed');
  assert.equal(secondaryReport.failureContext.writerRestart.commandDiagnostic.controlErrorIdentifier,
    'planned_release_mismatch');

  for (const stderrText of [
    'unknown_adapter_secret_861a\n',
    'planned_release_mismatch\ncredential=fixture-secret-7ad2\n',
  ]) {
    const unknownFailure = invokeFailure(stderrText);
    const unknownReport = JSON.parse(JSON.stringify(createRecoveryFailureReportFields({
      primaryError: unknownFailure,
      primarySubstep: options.substep,
    })));
    assert.equal(unknownReport.commandDiagnostic.controlErrorIdentifier, null);
    assert.doesNotMatch(JSON.stringify(unknownReport), /unknown_adapter_secret|fixture-secret|credential=/u);
  }
});

test('leased exit-2 command preserves the shell wrapper and emits the same bounded caller report', {
  skip: supportsLeaseShell ? false : 'requires bash and flock',
}, async t => {
  await assertExitTwoIsPrivateOnly(t, async ({ cwd, args, ...options }) => {
    const lock = path.join(cwd, 'operation.lock');
    await writeFile(lock, 'synthetic lock\n', { mode: 0o600 });
    const invocation = createLeasedCommandInvocation(lock, process.execPath, args);
    return runFixtureCommand(invocation.command, invocation.args, { cwd, ...options });
  });
});
