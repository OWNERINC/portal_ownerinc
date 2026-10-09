import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createRecoveryFailureReportFields,
  runSnapshotAndRestart,
} from '../../scripts/integration/payload-preauthority-recovery-flow.mjs';
import { coordinatorDiagnosticSteps, createCommandDiagnostic } from '../../scripts/integration/payload-preauthority-diagnostics.mjs';
import {
  assertRootOwnerGuardProbe,
  controlCommandOptions,
  coordinatorCommandOptions,
  createBoundedCommandStderr,
  createFixtureCommandFailure,
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

test('both coordinator actions retain bounded private stderr and finite failing-step metadata through report sanitization', async t => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'payload-coordinator-diagnostic-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  for (const action of ['backup', 'restore']) {
    for (const body of ['unsafe_required_owner\n', 'Invalid Payload control invocation.\n', 'private-secret-value\n']) {
      const options = coordinatorCommandOptions(action, '/synthetic/release');
      const evidence = [];
      const stderr = 'PAYLOAD_COORDINATOR_STEP step=guard_close_admission\n' + body
        + 'PAYLOAD_COORDINATOR_FAILURE step=guard_close_admission status=2\n'
        + 'private-cleanup-output\n';
      let failure;
      try {
        runFixtureCommand(process.execPath, ['-e', `process.stderr.write(${JSON.stringify('private-earlier-output\n')}.repeat(1500) + ${JSON.stringify(stderr)}, () => process.exit(2))`], {
          ...options, privateCommandEvidence: evidence,
        });
      } catch (error) { failure = error; }
      assert.ok(failure instanceof FixtureFailure);
      const report = createRecoveryFailureReportFields({ primaryError: failure });
      assert.equal(report.failureCode, `coordinator_${action}_failed`);
      assert.equal(report.failedSubstep, `payload_coordinator_${action}`);
      assert.equal(report.commandDiagnostic.coordinatorStep, 'guard_close_admission');
      assert.equal(report.commandDiagnostic.controlErrorIdentifier, body.startsWith('unsafe_') ? 'unsafe_required_owner'
        : body.startsWith('Invalid') ? 'control_invocation_invalid' : null);
      assert.doesNotMatch(JSON.stringify(report), /private-|synthetic|stderr|stdout/u);
      assert.equal(evidence.length, 1);
      assert.ok(evidence[0].stderr.length <= 16 * 1024);
      assert.match(evidence[0].stderr.toString(), /private-cleanup-output/u, 'bounded tail preserves late failure evidence');
      const root = path.join(fixtureRoot, `${action}-${body.startsWith('unsafe_') ? 'known' : body.startsWith('Invalid') ? 'invocation' : 'unknown'}`);
      assert.equal(await persistPrivateCommandEvidence(root, evidence), true);
      assert.match(await readFile(path.join(root, 'private-diagnostics', 'command-stderr.txt'), 'utf8'), /private-cleanup-output/u);
    }
  }
  assert.throws(() => coordinatorCommandOptions('unknown', '/synthetic/release'));
});

test('coordinator parsing never attributes tool, prior-step, malformed or cleanup output to a failing guard', () => {
  const parse = (stderr, extra = {}) => createCommandDiagnostic({ substep: 'payload_coordinator_restore', status: 2,
    stderr, coordinatorCommandContext: 'payload-coordinator:restore', ...extra });
  const frame = (step, body) => `PAYLOAD_COORDINATOR_STEP step=${step}\n${body}PAYLOAD_COORDINATOR_FAILURE step=${step} status=2\n`;
  for (const stderr of [
    'unsafe_required_owner\n',
    frame('restore_portal_database', 'unsafe_required_owner\n'),
    frame('guard_close_admission', 'unsafe_required_owner\nprivate-trailing-data\n'),
    frame('guard_close_admission', 'private-before unsafe_required_owner\n'),
    frame('guard_close_admission', 'unknown_reason\n'),
    frame('guard_close_admission', '') + 'unsafe_required_owner\n',
    'PAYLOAD_COORDINATOR_STEP step=guard_release_preflight\nunsafe_required_owner\n' + frame('guard_close_admission', ''),
  ]) assert.equal(parse(stderr).controlErrorIdentifier, null);
  assert.equal(parse(frame('guard_close_admission', 'unsafe_required_owner\n'), { coordinatorCommandContext: null }).coordinatorStep, undefined);
  assert.equal(parse(frame('private_arbitrary_value', 'unsafe_required_owner\n')).coordinatorStep, undefined);
  assert.equal(parse(frame('guard_close_admission', 'unsafe_required_owner\n'), { status: 43 }).controlErrorIdentifier, null);
  const timeout = parse('PAYLOAD_COORDINATOR_STEP step=capture_cms_database\nprivate-output', { status: null, errorCode: 'ETIMEDOUT' });
  assert.equal(timeout.coordinatorStep, 'capture_cms_database');
  assert.equal(timeout.commandError, 'command_timeout');
  assert.equal(timeout.controlErrorIdentifier, null);
  for (const step of coordinatorDiagnosticSteps) {
    assert.equal(parse(frame(step, '')).coordinatorStep, step, `finite stage ${step} survives an opaque failure`);
  }
  const native = parse(frame('guard_backup_metadata', 'native_catalog_verification_failed\n'
    + 'PREAUTHORITY_CATALOG_DIAGNOSTIC stage=native_types reason=preauthority_native_type_inventory_mismatch sqlstate=none\n'));
  assert.equal(native.nativeCatalogVerifier.stage, 'native_types');
  assert.equal(native.controlErrorIdentifier, 'native_catalog_verification_failed');
});

test('asynchronous coordinator capture is bounded, drained before reporting, and retains opaque and launch failures privately', async () => {
  const capture = createBoundedCommandStderr();
  const child = spawn(process.execPath, ['-e', String.raw`process.stderr.write('x'.repeat(100000) + '\nPAYLOAD_COORDINATOR_STEP step=restore_cms_database\nprivate-async-error\nPAYLOAD_COORDINATOR_FAILURE step=restore_cms_database status=2\n', () => process.exit(2))`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', chunk => capture.append(chunk));
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(child.exitCode, 2);
  assert.equal(capture.buffer().length, 64 * 1024);
  const evidence = [];
  const options = { ...coordinatorCommandOptions('restore', '/synthetic/release'), privateCommandEvidence: evidence };
  const failure = createFixtureCommandFailure({ status: child.exitCode, stderr: capture.buffer() }, options);
  const report = createRecoveryFailureReportFields({ primaryError: failure });
  assert.equal(report.commandDiagnostic.coordinatorStep, 'restore_cms_database');
  assert.equal(report.commandDiagnostic.controlErrorIdentifier, null);
  assert.doesNotMatch(JSON.stringify(report), /private-async-error/u);
  assert.equal(evidence[0].stderr.length, 16 * 1024);
  assert.match(evidence[0].stderr.toString(), /private-async-error/u);
  const launch = createFixtureCommandFailure({ status: null, error: { code: 'ENOENT' }, stderr: null }, options);
  assert.equal(launch.diagnostic.commandError, 'executable_not_found');
  assert.equal(evidence.length, 2, 'launch failures retain a private bounded absence-of-stderr record');
  const runner = await readFile('scripts/test-payload-preauthority-recovery.mjs', 'utf8');
  assert.match(runner, /\.\.\.coordinatorCommandOptions\(action, release\)/u);
  assert.match(runner, /stdio: \['ignore', 'ignore', 'pipe'\]/u);
  assert.match(runner, /child\.signalCode \|\| !Number\.isInteger\(child\.exitCode\)/u,
    'a killed asynchronous coordinator must not count as an expected rejection');
});

test('redacted recovery report preserves the native verifier stage, reason, and SQLSTATE', () => {
  const stderr = 'native_catalog_verification_failed\n'
    + 'PREAUTHORITY_CATALOG_DIAGNOSTIC stage=native_constraints reason=postgres_error sqlstate=23514\n';
  const failure = new FixtureFailure('fixture_command_failed', createCommandDiagnostic({
    substep: 'payload_control_verify_release', status: 2, stderr,
    controlCommandContext: 'payload-control:verify-release',
  }));
  const report = JSON.parse(JSON.stringify(createRecoveryFailureReportFields({
    primaryError: failure, primarySubstep: 'payload_control_verify_release',
  })));
  assert.deepEqual(report.commandDiagnostic.nativeCatalogVerifier, {
    stage: 'native_constraints', reason: 'postgres_error', sqlState: '23514',
  });
  assert.equal(report.commandDiagnostic.controlErrorIdentifier, 'native_catalog_verification_failed');
  assert.doesNotMatch(JSON.stringify(report), /stderr|stdout|23514.*private|url|definition/u);
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

test('owner probe persists unexpected adapter and restoration stderr privately with redacted primary and secondary diagnostics', async t => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'payload-owner-probe-private-'));
  await chmod(fixtureRoot, 0o700);
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const evidence = [{ substep: 'prior_private_command', stderr: Buffer.from('prior-private') }];
  let failure;
  try {
    assertRootOwnerGuardProbe({
      mutationStatus: 0,
      mutationStderr: Buffer.alloc(0),
      adapterStatus: 2,
      adapterStderr: Buffer.from('planned_release_mismatch\n'),
      restorationStatus: 1,
      restorationStderr: Buffer.from('chown-private-token'),
      lockIdentityPreserved: true,
      restorationVerifiedUnderLease: false,
      lockUid: 65534,
      lockGid: 0,
      lockUidAfterLease: 65534,
      lockGidAfterLease: 0,
      expectedGid: 0,
      controlCommandContext: 'payload-control:verify-release',
      privateCommandEvidence: evidence,
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof FixtureFailure);
  assert.equal(failure.diagnostic.controlErrorIdentifier, 'planned_release_mismatch');
  assert.equal(failure.secondaryFailure.code, 'fixture_owner_restore_failed');
  assert.deepEqual(failure.secondaryFailure.diagnostic, {
    substep: 'fixture_restore_root_owner',
    commandExitCode: 1,
    commandError: null,
    sqlState: null,
    errorIdentifier: null,
    controlErrorIdentifier: null,
  });
  assert.equal(evidence.length, 3, 'unexpected adapter and restoration stderr stay available for private persistence');
  assert.match(evidence[1].stderr.toString('utf8'), /planned_release_mismatch/u);
  assert.match(evidence[2].stderr.toString('utf8'), /chown-private-token/u);

  const report = JSON.parse(JSON.stringify(createRecoveryFailureReportFields({
    primaryError: failure,
    primarySubstep: 'payload_control_verify_release',
  })));
  assert.equal(report.commandDiagnostic.controlErrorIdentifier, 'planned_release_mismatch');
  assert.equal(report.failureContext.fixtureOwnerRestoration.failureCode, 'fixture_owner_restore_failed');
  assert.equal(report.failureContext.fixtureOwnerRestoration.commandDiagnostic.substep, 'fixture_restore_root_owner');
  assert.equal(report.failureContext.fixtureOwnerRestoration.lockIdentityPreserved, true);
  assert.equal(report.failureContext.fixtureOwnerRestoration.rootOwnerRestored, false);
  assert.doesNotMatch(JSON.stringify(report), /chown-private-token|stderr/u);
  assert.equal(await persistPrivateCommandEvidence(fixtureRoot, evidence), true);
  const privateFile = path.join(fixtureRoot, 'private-diagnostics', 'command-stderr.txt');
  const privateText = await readFile(privateFile, 'utf8');
  assert.match(privateText, /planned_release_mismatch/u);
  assert.match(privateText, /chown-private-token/u);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.dirname(privateFile))).mode & 0o777, 0o700);
    assert.equal((await stat(privateFile)).mode & 0o777, 0o600);
  }
});

test('owner probe retains evidence when restoration fails and defers cleanup until verified success', () => {
  const restorationFailureEvidence = [];
  let failure;
  try {
    assertRootOwnerGuardProbe({
      mutationStatus: 0,
      mutationStderr: Buffer.alloc(0),
      adapterStatus: 2,
      adapterStderr: Buffer.from('unsafe_required_owner\n'),
      restorationStatus: 1,
      restorationStderr: Buffer.from('restore-secret-29d'),
      lockIdentityPreserved: true,
      restorationVerifiedUnderLease: false,
      lockUid: 65534,
      lockGid: 0,
      lockUidAfterLease: 65534,
      lockGidAfterLease: 0,
      expectedGid: 0,
      controlCommandContext: 'payload-control:verify-release',
      privateCommandEvidence: restorationFailureEvidence,
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof FixtureFailure);
  assert.equal(failure.diagnostic.controlErrorIdentifier, 'unsafe_required_owner',
    'restoration failure must not replace the primary adapter reason');
  assert.equal(failure.secondaryFailure.code, 'fixture_owner_restore_failed');
  assert.equal(restorationFailureEvidence.length, 2);
  assert.match(restorationFailureEvidence[1].stderr.toString('utf8'), /restore-secret-29d/u);

  let lateOwnerFailure;
  try {
    assertRootOwnerGuardProbe({
      mutationStatus: 0,
      mutationStderr: Buffer.alloc(0),
      adapterStatus: 2,
      adapterStderr: Buffer.from('unsafe_required_owner\n'),
      restorationStatus: 0,
      restorationStderr: Buffer.alloc(0),
      lockIdentityPreserved: true,
      restorationVerifiedUnderLease: false,
      lockUid: 65534,
      lockGid: 42,
      lockUidAfterLease: 0,
      lockGidAfterLease: 42,
      expectedGid: 42,
      controlCommandContext: 'payload-control:verify-release',
      privateCommandEvidence: [],
    });
  } catch (error) {
    lateOwnerFailure = error;
  }
  assert.ok(lateOwnerFailure instanceof FixtureFailure,
    'a root owner observed only after lease release cannot satisfy the in-lease restoration check');
  assert.equal(lateOwnerFailure.secondaryFailure.code, 'fixture_owner_restore_invariant_failed');

  const successfulEvidence = [{ substep: 'earlier', stderr: Buffer.from('retain-earlier') }];
  const start = successfulEvidence.length;
  assert.doesNotThrow(() => assertRootOwnerGuardProbe({
    mutationStatus: 0,
    mutationStderr: Buffer.alloc(0),
    adapterStatus: 2,
    adapterStderr: Buffer.from('unsafe_required_owner\n'),
    restorationStatus: 0,
    restorationStderr: Buffer.alloc(0),
    lockIdentityPreserved: true,
    restorationVerifiedUnderLease: true,
    lockUid: 0,
    lockGid: 42,
    lockUidAfterLease: 0,
    lockGidAfterLease: 42,
    expectedGid: 42,
    controlCommandContext: 'payload-control:verify-release',
    privateCommandEvidence: successfulEvidence,
  }));
  assert.equal(successfulEvidence.length, 2,
    'expected adapter stderr remains private evidence until the caller finishes private-file cleanup');
  assert.match(successfulEvidence[1].stderr.toString('utf8'), /unsafe_required_owner/u);
  successfulEvidence.splice(start);
  assert.deepEqual(successfulEvidence.map(entry => entry.substep), ['earlier'],
    'only verified expected-negative evidence is cleaned up after identity, UID and GID restoration pass');
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
