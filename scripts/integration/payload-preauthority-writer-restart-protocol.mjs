import { conversionProbeReasons } from './payload-logical-snapshot-probe-protocol.mjs';

export const WRITER_RESTART_CONTEXT = 'snapshot-writer-restart';
export const WRITER_RESTART_SUCCESS = 'PAYLOAD_WRITER_RESTART passed\n';
export const writerServices = Object.freeze(['api', 'cron', 'cms']);
export function validWriterIdentities(value) {
  return !!value && typeof value === 'object' && Object.keys(value).sort().join(',') === 'api,cms,cron'
    && writerServices.every(service => typeof value[service] === 'string' && /^[a-f0-9]{64}$/u.test(value[service]))
    && new Set(Object.values(value)).size === 3;
}
export function parseWriterObservation(stdout) {
  const text = Buffer.isBuffer(stdout) ? stdout.toString('utf8') : stdout;
  if (typeof text !== 'string' || text.length > 256) return null;
  try {
    const value = JSON.parse(text);
    if (!validWriterIdentities(value)) return null;
    const canonical = Object.fromEntries(writerServices.map(service => [service, value[service]]));
    return `${JSON.stringify(canonical)}\n` === text ? canonical : null;
  } catch { return null; }
}
const phases = ['configuration', 'lease', 'inventory', 'inspect', 'start', 'verify'];
const reasons = ['configuration_invalid', 'lease_invalid', 'missing', 'ambiguous', 'identity_invalid',
  'state_invalid', 'response_invalid', 'command_failed', 'compose_dependency_missing',
  'compose_service_unknown', 'compose_no_container', 'docker_container_missing', 'docker_daemon_unavailable',
  'permission_denied', 'executable_not_found', 'command_timeout', 'output_limit_exceeded', 'command_signaled', 'internal_error',
  ...conversionProbeReasons.filter(reason => reason.startsWith('configuration_'))];
const states = ['unknown', 'created', 'restarting', 'running', 'removing', 'paused', 'exited', 'dead'];
const prefix = 'PAYLOAD_WRITER_RESTART_FAILED ';
export function encodeWriterRestartFailure(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'phase,reason,service,state'
      || !phases.includes(value.phase) || !reasons.includes(value.reason)
      || ![...writerServices, 'all'].includes(value.service) || !states.includes(value.state)
      || (value.reason.startsWith('configuration_') && value.phase !== 'configuration')
      || (value.reason === 'lease_invalid' && value.phase !== 'lease')
      || (['configuration', 'lease'].includes(value.phase) && (value.service !== 'all' || value.state !== 'unknown'))
      || (['missing', 'ambiguous'].includes(value.reason) && value.phase !== 'inventory')
      || (value.reason === 'state_invalid' && !['inspect', 'verify'].includes(value.phase))) throw new Error('invalid_writer_restart_protocol');
  return `${prefix}${JSON.stringify({ phase: value.phase, reason: value.reason, service: value.service, state: value.state })}\n`;
}
export function parseWriterRestartFailure(stderr, { context, status, errorCode, signal, stdout } = {}) {
  if (context !== WRITER_RESTART_CONTEXT || status !== 2 || errorCode || signal
      || (Buffer.isBuffer(stdout) ? stdout.length !== 0 : stdout !== undefined && stdout !== '')) return null;
  const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : stderr;
  if (typeof text !== 'string' || text.length > 512 || !text.startsWith(prefix)) return null;
  try {
    const value = JSON.parse(text.slice(prefix.length));
    return encodeWriterRestartFailure(value) === text ? value : null;
  } catch { return null; }
}

// Called ONLY for a failed actual Docker command, never for arbitrary successful
// output or a host wrapper/lease failure. Return enums, never captured text.
export function writerCommandFailureReason(error, stderr, { compose = false } = {}) {
  const commandError = error?.diagnostic?.commandError;
  if (reasons.includes(commandError)) return commandError;
  if (error?.diagnostic?.commandSignal) return 'command_signaled';
  const text = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
  const lines = text.split(/\r?\n/u).filter(Boolean);
  if (compose && lines.some(line => /^(api|cron|cms) is missing dependency (postgres|cms-postgres|cms-migrate)$/u.test(line))) return 'compose_dependency_missing';
  if (compose && lines.some(line => /^no such service: (api|cron|cms)$/u.test(line))) return 'compose_service_unknown';
  if (compose && lines.some(line => line === 'no container to start')) return 'compose_no_container';
  if (lines.some(line => /^Error response from daemon: No such container: [a-f0-9]{64}$/u.test(line))) return 'docker_container_missing';
  if (lines.some(line => /^Cannot connect to the Docker daemon at unix:\/\/[^\r\n]+\. Is the docker daemon running\?$/u.test(line))) return 'docker_daemon_unavailable';
  return 'command_failed';
}
