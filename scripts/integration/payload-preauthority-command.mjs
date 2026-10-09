import { spawnSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCommandDiagnostic } from './payload-preauthority-diagnostics.mjs';
import { parseFixtureFailureHold, POST_RESTORE_HOLD_CONTEXT } from './payload-preauthority-snapshot-hold.mjs';

const leaseScript = 'set -Eeuo pipefail; lock=$1; shift; exec 9<>"$lock"; flock -n 9; export PORTAL_OPERATION_LOCK="$lock" PORTAL_OPERATION_LOCK_HELD="$lock"; exec "$@"';
const controlSubsteps = Object.freeze({
  'release-preflight': 'payload_control_release_preflight',
  'verify-release': 'payload_control_verify_release',
});

export class FixtureFailure extends Error {
  constructor(code, diagnostic = null, readinessDiagnostic = null) {
    super(code);
    this.code = code;
    this.diagnostic = diagnostic;
    this.readinessDiagnostic = readinessDiagnostic;
  }
}

export function controlCommandSubstep(action) {
  return controlSubsteps[action] || 'payload_control_unknown_action';
}

export function controlCommandOptions(action, release) {
  return {
    release,
    substep: controlCommandSubstep(action),
    preservePrivateErrorEvidence: true,
    controlCommandContext: Object.hasOwn(controlSubsteps, action) ? `payload-control:${action}` : null,
  };
}

export function coordinatorCommandOptions(action, release) {
  if (!['backup', 'restore'].includes(action)) throw new Error('unsupported coordinator action');
  return {
    release,
    substep: `payload_coordinator_${action}`,
    failureCode: `coordinator_${action}_failed`,
    coordinatorCommandContext: `payload-coordinator:${action}`,
    preservePrivateErrorEvidence: true,
  };
}

export function createLeasedCommandInvocation(lock, command, args = []) {
  return {
    command: 'bash',
    args: ['-c', leaseScript, 'payload-fixture-lease', lock, command, ...args],
  };
}

export function createBoundedCommandStderr() {
  let tail = Buffer.alloc(0);
  return {
    append(chunk) { tail = Buffer.from(Buffer.concat([tail, Buffer.from(chunk)]).subarray(-64 * 1024)); },
    buffer() { return Buffer.from(tail); },
  };
}

// Shared by synchronous coordinator calls and the asynchronous lease-race probe.
export function createFixtureCommandFailure(result, options = {}) {
  const candidateSubstep = options.substep || options.activeSubstep || 'unclassified_command';
  if (options.preservePrivateErrorEvidence === true && (result.stderr?.length || options.coordinatorCommandContext) &&
      Array.isArray(options.privateCommandEvidence) && options.privateCommandEvidence.length < 8) {
    const raw = Buffer.from(result.stderr?.length ? result.stderr : '[no stderr captured]\n');
    options.privateCommandEvidence.push({
      substep: /^[a-z][a-z0-9_]{0,63}$/u.test(candidateSubstep) ? candidateSubstep : 'unclassified_command',
      // Coordinator failures occur after potentially long progress output.
      // Retain the bounded tail privately; public diagnostics never carry it.
      stderr: options.coordinatorCommandContext
        ? Buffer.from(raw.subarray(-16 * 1024)) : Buffer.from(raw.subarray(0, 16 * 1024)),
    });
  }
  const failure = new FixtureFailure(options.failureCode || 'fixture_command_failed', createCommandDiagnostic({
    substep: candidateSubstep,
    status: result.status,
    errorCode: result.error?.code,
    stderr: result.stderr,
    sqlCommandContext: options.sqlCommandContext === true,
    controlCommandContext: options.controlCommandContext,
    coordinatorCommandContext: options.coordinatorCommandContext,
    logicalSnapshotCommandContext: options.logicalSnapshotCommandContext,
    release: options.release,
  }));
  if (options.fixtureFailureHoldContext === POST_RESTORE_HOLD_CONTEXT) {
    const outcome = parseFixtureFailureHold(result.stdout, { status: result.status, errorCode: result.error?.code });
    if (outcome) failure.fixtureFailureHold = outcome;
  }
  return failure;
}

export function runFixtureCommand(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    encoding: null,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    timeout: options.timeout || 180_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw createFixtureCommandFailure(result, options);
  }
  if (options.fixtureFailureHoldContext === POST_RESTORE_HOLD_CONTEXT
      && !parseFixtureFailureHold(result.stdout, { status: result.status })) {
    throw createFixtureCommandFailure(result, { ...options, failureCode: 'post_restore_fixture_hold_protocol_invalid' });
  }
  return result.stdout || Buffer.alloc(0);
}

export function assertRootOwnerGuardProbe({
  mutationStatus,
  mutationStderr,
  adapterStatus,
  adapterStderr,
  restorationStatus,
  restorationStderr,
  lockIdentityPreserved,
  restorationVerifiedUnderLease,
  lockUid,
  lockGid,
  lockUidAfterLease,
  lockGidAfterLease,
  expectedGid,
  controlCommandContext,
  privateCommandEvidence,
}) {
  const diagnostics = {
    mutation: createCommandDiagnostic({
      substep: 'fixture_set_nonroot_owner', status: mutationStatus, stderr: mutationStderr,
    }),
    adapter: createCommandDiagnostic({
      substep: controlCommandSubstep('verify-release'),
      status: adapterStatus,
      stderr: adapterStderr,
      controlCommandContext,
    }),
    restoration: createCommandDiagnostic({
      substep: 'fixture_restore_root_owner', status: restorationStatus, stderr: restorationStderr,
    }),
  };
  const retain = (substep, stderr) => {
    const evidence = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr || '');
    if (evidence.length > 0 && Array.isArray(privateCommandEvidence) && privateCommandEvidence.length < 8) {
      privateCommandEvidence.push({ substep, stderr: Buffer.from(evidence).subarray(0, 16 * 1024) });
    }
  };
  retain('fixture_set_nonroot_owner', mutationStderr);
  retain(controlCommandSubstep('verify-release'), adapterStderr);
  retain('fixture_restore_root_owner', restorationStderr);

  const rootOwnerRestored = restorationStatus === 0 && lockIdentityPreserved === true
    && restorationVerifiedUnderLease === true
    && lockUid === 0 && lockGid === expectedGid
    && lockUidAfterLease === 0 && lockGidAfterLease === expectedGid;
  const adapterRejectedAsExpected = mutationStatus === 0 && adapterStatus === 2
    && diagnostics.adapter.controlErrorIdentifier === 'unsafe_required_owner';
  if (adapterRejectedAsExpected && rootOwnerRestored) {
    // The caller may clean private evidence only after its private-file cleanup
    // also succeeds; retain these buffers until that final step.
    return;
  }

  const mutationFailed = mutationStatus !== 0;
  const failure = new FixtureFailure(
    mutationFailed ? 'fixture_owner_probe_mutation_failed' : 'fixture_owner_guard_regression_failed',
    mutationFailed ? diagnostics.mutation : diagnostics.adapter,
  );
  if (!rootOwnerRestored) {
    failure.secondaryFailure = {
      code: restorationStatus === 0 ? 'fixture_owner_restore_invariant_failed' : 'fixture_owner_restore_failed',
      substep: 'fixture_restore_root_owner',
      diagnostic: diagnostics.restoration,
      lockIdentityPreserved: lockIdentityPreserved === true,
      rootOwnerRestored: false,
    };
  }
  throw failure;
}

export async function persistPrivateCommandEvidence(fixtureRoot, privateCommandEvidence) {
  if (!fixtureRoot || privateCommandEvidence.length === 0) return false;
  const directory = path.join(fixtureRoot, 'private-diagnostics');
  const target = path.join(directory, 'command-stderr.txt');
  const parts = [];
  for (const [index, entry] of privateCommandEvidence.entries()) {
    parts.push(Buffer.from(`--- command ${index + 1}: ${entry.substep} ---\n`), entry.stderr, Buffer.from('\n'));
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(target, Buffer.concat(parts), { flag: 'wx', mode: 0o600 });
  await chmod(target, 0o600);
  return true;
}
