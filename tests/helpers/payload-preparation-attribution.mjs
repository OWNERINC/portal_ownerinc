import { types } from 'node:util';

// Deliberately literal and ordered. The offline inventory guard compares every
// name against the real declarations; neither names nor captured text are public.
const inventory = [
  ['preparation.head-lease', 'head reconciliation rejects a replacement lease before its repair write (portable syscall observations)'],
  ['preparation.native-b0-cli', 'native root B0 administrative capture, provisioning, acceptance and expired exact resume through real CLI children'],
  ['preparation.resume-binding', 'all 19 resume fields bind authenticated admission before dispatch, head repair and publication (filesystem doubles)'],
  ['preparation.host-identity', 'root host fixture verifies signed state even when the test runner is POSIX non-root (identity doubles)'],
  ['preparation.host-negative', 'root host fixture still rejects unsafe POSIX runtime metadata and invalid signed journals (observation doubles)'],
  ['preparation.host-baseline', 'host gate checks fixed approved baseline, predecessor/desired retries and exact signed initial state without writes (I/O doubles)'],
  ['preparation.environment-binding', 'collector and inspection authenticate the protected environment while binding the configured Portal database'],
  ['preparation.host-drift', 'altered host baselines, partial keys, unknown inventory and signed noninitial states refuse without effects (I/O doubles)'],
  ['preparation.lease-syscalls', 'lease is noncreating nontruncating FD9, refuses busy/replaced/missing lock before host reads, and releases own lock (syscall doubles)'],
  ['preparation.native-context', 'native Linux root qualifies the production context envelope on an isolated real filesystem'],
  ['preparation.generated-audit', 'generated child audit classifies Popen pipes and delegates os.open default, dir_fd, and keyword mode'],
  ['preparation.candidate-gate', 'candidate-only CI gate retains exact native preparation discovery without widening deployment'],
  ['preparation.context-negative-coverage', 'Task 4 retains executable wrong-PID and returned process-context mismatch refusal evidence'],
  ['preparation.bounded-output', 'authenticated preparation subprocess supervisor bounds finite, infinite and timed-out output while preserving JSON'],
  ['preparation.runtime-group-contract', 'apply runtime inherits the receiver group, has cleanup reserve, and no supervisor uses unbounded wait'],
  ['preparation.inherited-group', 'inherited runtime-like group leaves no nested child after timeout or output overflow'],
  ['preparation.child-group', 'authenticated preparation supervisor kills and reaps the Linux child process group'],
  ['preparation.host-reader', 'host-data reader retains exact deploy ownership, bounded stable bytes, and distinct trust ancestry (metadata doubles)'],
  ['preparation.dispatch', 'dispatch retains parent lease across fixed child, binds approval continuity and fails closed on child/context errors (process doubles)'],
  ['preparation.observer-transport', 'bounded observer transport authenticates before the exact isolated child and validates a capped response (portable process doubles)'],
  ['preparation.observer-negatives', 'bounded observer transport denies timeout, overflow, child/status/frame/binding/PID failures and always reaps (portable process doubles)'],
  ['preparation.observer-cleanup', 'every post-spawn BaseException and cleanup failure terminates and reaps before sanitized denial (portable process doubles)'],
  ['preparation.observer-fail-stop', 'persistent child termination failures invoke one fail-stop after finite independent resource cleanup (portable process doubles)'],
  ['preparation.context-drift', 'context collection owns the lease, independently projects context, and denies all post-child drift (portable observation doubles)'],
  ['preparation.context-cli', 'collect-context CLI has exact two-token grammar and authenticates the supplied approval before collection'],
  ['preparation.inherited-lease', 'inherited context refuses shared, unlocked, foreign-description, missing and replaced FD9 without unlocking parent (syscall doubles)'],
  ['preparation.source-closure', 'all 19 source files authenticate before any closure helper; fixed report never authorizes execution (read doubles)'],
  ['preparation.approval-shape', 'strict independent approval rejects extra/missing fields and candidate-policy substitution'],
  ['preparation.bootstrap-reader', 'bootstrap reader rejects unsafe ancestry and leaf metadata before opening helpers (metadata doubles)'],
  ['preparation.admission-binding', 'actual admission validators reject forged approved-hash records and wrong policy/image/toolchain (read doubles)'],
  ['preparation.provisioning', 'preparation provisioning snapshots, conflicts, interruption retry and approval-last reuse existing primitives (publication doubles)'],
];

const summaryFields = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
const supervisorMessage = 'Native qualification supervision failed; private diagnostics withheld.\n';
const maxStdout = 2 * 1024 * 1024;
const maxStderr = 4096;
const maxLines = 32768;
const maxLine = 16 * 1024;
const snapshots = new WeakMap();
const unavailable = 'preparation-attribution: unavailable';

function boundedString(value, maximum) {
  return typeof value === 'string' && value.length <= maximum && Buffer.byteLength(value, 'utf8') <= maximum;
}

function fieldsOf(result) {
  if (result === null || typeof result !== 'object' || types.isProxy(result)) return null;
  const fields = Object.create(null);
  for (const key of ['status', 'signal', 'stdout', 'stderr', 'error']) {
    const descriptor = Object.getOwnPropertyDescriptor(result, key);
    if (!descriptor) {
      if (key !== 'error') return null;
    } else {
      if (!Object.hasOwn(descriptor, 'value')) return null;
      fields[key] = descriptor.value;
    }
  }
  // Inspect only the error's native type, never its code/message/stack or other
  // properties. A native spawn error can also carry a termination signal.
  const error = fields.error;
  if (error !== undefined && error !== null &&
      (typeof error !== 'object' || types.isProxy(error) || !types.isNativeError(error))) return null;
  return fields;
}

function processOutcome(fields) {
  const { status, signal, error } = fields;
  if (signal !== null && !(typeof signal === 'string' && /^SIG[A-Z0-9]{1,16}$/u.test(signal))) return 'unknown';
  if (status === null) {
    if (error !== undefined && error !== null) return 'spawn-error';
    return signal === null ? 'unknown' : 'signal';
  }
  if (!Number.isInteger(status) || status < 0 || status > 255 || signal !== null ||
      (error !== undefined && error !== null)) return 'unknown';
  return status === 0 ? 'exit-zero' : 'exit-nonzero';
}

function parseTap(stdout) {
  const invalid = { state: 'invalid' };
  const incomplete = { state: 'incomplete' };
  if (!boundedString(stdout, maxStdout)) return invalid;
  if (stdout === '') return incomplete;
  const lines = stdout.split('\n', maxLines + 1);
  if (lines.length > maxLines || lines.some(line => !boundedString(line, maxLine) || /[\r\u2028\u2029]/u.test(line))) return invalid;
  if (lines.pop() !== '') return incomplete;
  if (lines.shift() !== 'TAP version 13') return invalid;

  const counts = { tests: inventory.length, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  const failedIds = [], skippedIds = [], todoIds = [];
  let records = 0, summary = 0;
  let plan = false, finished = false, yaml = false, diagnosticAllowed = false;
  for (const line of lines) {
    if (yaml) {
      if (line === '  ...') yaml = false;
      else if (line === '  ---') return invalid;
      else if (line !== '' && !line.startsWith('  ')) return invalid;
      continue;
    }
    if (line === '') continue;
    if (finished) return invalid;
    if (line === '  ---') {
      if (!diagnosticAllowed || plan) return invalid;
      yaml = true; diagnosticAllowed = false;
      continue;
    }
    // Delimiters outside the supported Node top-level diagnostic region cannot
    // silently create an untracked/unclosed block, including nested delimiters.
    if (/^[ \t]+(?:---|\.\.\.)$/u.test(line)) return invalid;
    // Nested/indented text is never an identity source. Its presence cannot
    // replace any of the 31 required top-level results or terminal counters.
    if (/^[ \t]/u.test(line)) continue;
    if (line.startsWith('#')) {
      const count = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (0|[1-9][0-9]{0,2})$/u.exec(line);
      if (count) {
        if (!plan || count[1] !== summaryFields[summary] || Number(count[2]) !== counts[count[1]]) return invalid;
        summary += 1;
      } else if (/^# duration_ms (?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,9})?$/u.test(line)) {
        if (!plan || summary !== summaryFields.length) return invalid;
        finished = true;
      } else if (/^# (?:tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)(?:\s|$)/u.test(line)) return invalid;
      continue;
    }
    diagnosticAllowed = false;
    if (line.startsWith('1..')) {
      if (plan || records !== inventory.length || line !== `1..${inventory.length}`) return invalid;
      plan = true;
      continue;
    }
    const record = /^(ok|not ok) ([1-9][0-9]?) - (.+)$/u.exec(line);
    if (!record || plan || records >= inventory.length || Number(record[2]) !== records + 1) return invalid;
    const [id, name] = inventory[records];
    const tail = record[3];
    if (tail === name) {
      if (record[1] === 'ok') counts.pass += 1;
      else { counts.fail += 1; failedIds.push(id); }
    } else {
      if (!tail.startsWith(name + ' # ')) return invalid;
      const directive = /^(SKIP|TODO)(?: .*)?$/u.exec(tail.slice(name.length + 3));
      if (!directive || (directive[1] === 'SKIP' && record[1] !== 'ok')) return invalid;
      if (directive[1] === 'SKIP') { counts.skipped += 1; skippedIds.push(id); }
      else { counts.todo += 1; todoIds.push(id); }
    }
    records += 1;
    diagnosticAllowed = true;
  }
  if (yaml || !finished || !plan || records !== inventory.length) return incomplete;
  return { state: 'complete', counts, failedIds, skippedIds, todoIds };
}

function publish(process, tap, supervisor, observed = null) {
  const projection = Object.freeze({
    kind: 'preparation-failure-attribution-v1',
    process, tap, supervisor,
    attribution: observed ? 'observed-tap' : 'unknown',
    // Complete conforming stdout can be forged. This is never an authenticated
    // origin, a causal receipt, or evidence used by the qualification assertions.
    authenticated: false,
    counts: observed ? Object.freeze(observed.counts) : null,
    failedIds: Object.freeze(observed ? observed.failedIds : []),
    skippedIds: Object.freeze(observed ? observed.skippedIds : []),
    todoIds: Object.freeze(observed ? observed.todoIds : []),
  });
  const text = 'preparation-attribution: ' + JSON.stringify(projection);
  snapshots.set(projection, text.length <= 4096 ? text : unavailable);
  return projection;
}

export function projectPreparationFailure(result) {
  const fields = fieldsOf(result);
  if (!fields) return publish('unknown', 'invalid', 'unknown');
  const process = processOutcome(fields);
  const tap = parseTap(fields.stdout);
  const supervisor = !boundedString(fields.stderr, maxStderr) ? 'unknown'
    : fields.stderr === '' ? 'absent' : fields.stderr === supervisorMessage ? 'reported' : 'unknown';
  const consistent = tap.state === 'complete' && supervisor === 'absent' &&
    ((process === 'exit-zero' && tap.counts.fail === 0) || (process === 'exit-nonzero' && tap.counts.fail > 0));
  return publish(process, tap.state, supervisor, consistent ? tap : null);
}

export function formatPreparationFailure(projection) {
  // WeakMap lookup does not read arbitrary objects, getters, proxies or toJSON.
  return snapshots.get(projection) ?? unavailable;
}
