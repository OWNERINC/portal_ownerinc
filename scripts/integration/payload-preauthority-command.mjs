import { spawnSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createCommandDiagnostic } from './payload-preauthority-diagnostics.mjs';

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

export function createLeasedCommandInvocation(lock, command, args = []) {
  return {
    command: 'bash',
    args: ['-c', leaseScript, 'payload-fixture-lease', lock, command, ...args],
  };
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
    const candidateSubstep = options.substep || options.activeSubstep || 'unclassified_command';
    if (options.preservePrivateErrorEvidence === true && result.stderr?.length &&
        Array.isArray(options.privateCommandEvidence) && options.privateCommandEvidence.length < 8) {
      options.privateCommandEvidence.push({
        substep: /^[a-z][a-z0-9_]{0,63}$/u.test(candidateSubstep) ? candidateSubstep : 'unclassified_command',
        stderr: Buffer.from(result.stderr).subarray(0, 16 * 1024),
      });
    }
    throw new FixtureFailure(options.failureCode || 'fixture_command_failed', createCommandDiagnostic({
      substep: candidateSubstep,
      status: result.status,
      errorCode: result.error?.code,
      stderr: result.stderr,
      sqlCommandContext: options.sqlCommandContext === true,
      controlCommandContext: options.controlCommandContext,
    }));
  }
  return result.stdout || Buffer.alloc(0);
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
