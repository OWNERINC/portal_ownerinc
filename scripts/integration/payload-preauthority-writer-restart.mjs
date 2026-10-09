import { fstatSync, lstatSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertRecoveryFixtureConfiguration } from './payload-preauthority-snapshot-runtime.mjs';
import { runFixtureCommand, persistPrivateCommandEvidence } from './payload-preauthority-command.mjs';
import { writerServices, validWriterIdentities, WRITER_RESTART_SUCCESS, encodeWriterRestartFailure,
  writerCommandFailureReason } from './payload-preauthority-writer-restart-protocol.mjs';

const idPattern = /^[a-f0-9]{64}$/u;
export function assertWriterIdentities(value) {
  if (!validWriterIdentities(value)) throw new Error('invalid_writer_identities');
}

/** Observe all services before effects; on resume start only the IDs captured
 * BEFORE stop. No Compose dependency traversal, creation, pull or adoption. */
export function observeOrRestartWriters({ configuration, mode, identities }, operations) {
  const found = {};
  const reject = reason => { throw Object.assign(new Error(reason), { restartReason: reason }); };
  for (const service of writerServices) {
    operations.step('inventory', service, 'unknown');
    const raw = operations.compose(['ps', '--all', '--quiet', '--no-trunc', service]).toString('utf8').trim();
    if (!raw) reject('missing');
    const ids = raw.split(/\r?\n/u);
    if (ids.length !== 1) reject('ambiguous');
    if (!idPattern.test(ids[0])) reject('response_invalid');
    found[service] = ids[0];
    if (mode === 'restart' && found[service] !== identities[service]) reject('identity_invalid');
    inspect(service, mode === 'observe' ? 'running' : 'exited', 'inspect');
  }
  if (new Set(Object.values(found)).size !== 3) reject('identity_invalid');
  if (mode === 'observe') return found;
  // All three passed identity/state validation before the first mutation.
  for (const service of writerServices) {
    operations.step('start', service, 'exited');
    operations.docker(['start', found[service]]);
  }
  for (const service of writerServices) inspect(service, 'running', 'verify');
  return found;

  function inspect(service, expectedState, phase) {
    operations.step(phase, service, 'unknown');
    let values;
    try { values = JSON.parse(operations.docker(['inspect', found[service]]).toString('utf8')); }
    catch (error) { if (error?.diagnostic) throw error; reject('response_invalid'); }
    if (!Array.isArray(values) || values.length !== 1 || !values[0] || typeof values[0] !== 'object') reject('response_invalid');
    const value = values[0];
    const labels = value.Config?.Labels;
    // A running service may have been created with the legacy release, while CMS
    // was receipted with a private creation overlay. Do NOT relabel/reconfigure it.
    if (value.Id !== found[service] || labels?.['com.docker.compose.project'] !== configuration.project
        || labels?.['com.docker.compose.service'] !== service || labels?.['com.docker.compose.oneoff'] !== 'False') reject('identity_invalid');
    const state = value.State?.Status;
    const known = ['created', 'restarting', 'running', 'removing', 'paused', 'exited', 'dead'].includes(state) ? state : 'unknown';
    operations.step(phase, service, known);
    if (state !== expectedState || value.State?.Running !== (expectedState === 'running')
        || value.State?.Paused !== false || value.State?.Restarting !== false) reject('state_invalid');
  }
}

async function main() {
  let phase = 'configuration'; let service = 'all'; let state = 'unknown';
  let evidenceDirectory;
  const evidence = [];
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk.toString('utf8');
      if (input.length > 64 * 1024) throw new Error('invalid_configuration');
    }
    const request = JSON.parse(input);
    if (!request || Object.keys(request).sort().join(',') !== 'configuration,identities,mode'
        || !['observe', 'restart'].includes(request.mode)) throw new Error('invalid_configuration');
    assertRecoveryFixtureConfiguration(request.configuration, process.env, ['source', 'target', 'lease-target']);
    if (request.mode === 'restart') assertWriterIdentities(request.identities);
    else if (request.identities !== null) throw new Error('invalid_configuration');
    phase = 'lease';
    if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('invalid_lease');
    const fd = fstatSync(9, { bigint: true });
    const lock = lstatSync(process.env.PORTAL_OPERATION_LOCK, { bigint: true });
    if (!fd.isFile() || !lock.isFile() || fd.dev !== lock.dev || fd.ino !== lock.ino
        || lock.uid !== 0n || (lock.mode & 0o022n) !== 0n) throw new Error('invalid_lease');
    evidenceDirectory = request.configuration.runtimeDirectory;
    const env = { PATH: process.env.PATH, HOME: '/root' };
    const run = (args, compose = false) => {
      const before = evidence.length;
      try {
        return runFixtureCommand('docker', args, { env, timeout: 60_000, maxBuffer: 1024 * 1024,
          substep: `snapshot_restart_${phase}_${service}`, privateCommandEvidence: evidence, preservePrivateErrorEvidence: true });
      } catch (error) {
        error.restartReason = writerCommandFailureReason(error, evidence.length > before ? evidence.at(-1).stderr : null, { compose });
        throw error;
      }
    };
    const result = observeOrRestartWriters(request, {
      step: (p, s, value) => { phase = p; service = s; state = value; },
      compose: args => run(['compose', ...request.configuration.composeArgs, ...args], true),
      docker: args => run(args),
    });
    process.stdout.write(request.mode === 'observe' ? `${JSON.stringify(result)}\n` : WRITER_RESTART_SUCCESS);
  } catch (error) {
    const reason = phase === 'configuration' ? error?.probeReason || 'configuration_invalid' : phase === 'lease' ? 'lease_invalid'
      : error?.restartReason || 'internal_error';
    // Raw stderr is retained only in the private runner fixture, not this wire.
    if (evidenceDirectory) {
      try { await persistPrivateCommandEvidence(path.join(evidenceDirectory, `writer-restart-${randomUUID()}`), evidence); } catch { /* preserve primary */ }
    }
    process.stderr.write(encodeWriterRestartFailure({ phase, reason, service, state }));
    process.exitCode = 2;
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
