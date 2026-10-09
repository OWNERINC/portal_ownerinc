import { FIXTURE_STOP_TIMEOUT_SECONDS, FIXTURE_STOP_COMMAND_MARGIN_MS } from './payload-preauthority-fixture.mjs';

export const POST_RESTORE_HOLD_CONTEXT = 'post-restore-fixture-hold';
export const POST_RESTORE_HOLD_SERVICES = Object.freeze(['nginx', 'api', 'cron', 'cms', 'cms-worker']);
export const POST_RESTORE_ADMISSION_TIMEOUT_SECONDS = 120;
export const POST_RESTORE_ADMISSION_KILL_GRACE_SECONDS = 10;
// Compose can stop every requested service serially, even optional workers.
// The guard has its own deadline. The command margin covers lease/orchestration.
export const POST_RESTORE_HOLD_TIMEOUT_MS =
  (POST_RESTORE_HOLD_SERVICES.length * FIXTURE_STOP_TIMEOUT_SECONDS
    + POST_RESTORE_ADMISSION_TIMEOUT_SECONDS + POST_RESTORE_ADMISSION_KILL_GRACE_SECONDS) * 1000
    + FIXTURE_STOP_COMMAND_MARGIN_MS;

/** Accept only the shell's entire fixed protocol and consistent process status.
 * Never search arbitrary stdout for a marker; timeout/killed commands cannot
 * authorize even a partial successful result. No raw output is returned. */
export function parseFixtureFailureHold(stdout, { status, errorCode } = {}) {
  if (errorCode || ![0, 2].includes(status)) return null;
  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(typeof stdout === 'string' ? stdout : '');
  if (buffer.length > 128) return null;
  const match = buffer.toString('utf8').match(/^PAYLOAD_FIXTURE_FAILURE_HOLD admission_status=(0|[1-9][0-9]{0,2}) stop_status=(0|[1-9][0-9]{0,2})\n$/u);
  if (!match) return null;
  const admissionStatus = Number(match[1]); const stopStatus = Number(match[2]);
  if (admissionStatus > 255 || stopStatus > 255) return null;
  const passed = admissionStatus === 0 && stopStatus === 0;
  if (status !== (passed ? 0 : 2)) return null;
  return Object.freeze({ admissionStatus, stopStatus,
    admissionClosed: admissionStatus === 0, writersStopped: stopStatus === 0 });
}

export const postRestoreFixtureHoldScript = `set +e
guard=$1; release=$2; shift 2
timeout --signal=TERM --kill-after=${POST_RESTORE_ADMISSION_KILL_GRACE_SECONDS}s ${POST_RESTORE_ADMISSION_TIMEOUT_SECONDS}s "$guard" close-admission "$release" "" >/dev/null
guard_status=$?
"$@" stop --timeout ${FIXTURE_STOP_TIMEOUT_SECONDS} ${POST_RESTORE_HOLD_SERVICES.join(' ')} >/dev/null
stop_status=$?
printf 'PAYLOAD_FIXTURE_FAILURE_HOLD admission_status=%s stop_status=%s\\n' "$guard_status" "$stop_status"
if ((guard_status == 0 && stop_status == 0)); then exit 0; else exit 2; fi`;
