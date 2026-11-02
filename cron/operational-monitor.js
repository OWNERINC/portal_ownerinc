const { randomBytes } = require('node:crypto');
const { API_CHECKS, HOST_CHECKS, CHECKS, REASONS, URGENT, check, validateObservation } = require('./operational-contract');
const { openState, readProtectedJson, MAX_PENDING } = require('./operational-monitor-state');
const { sendOperationalAlertResult } = require('./sendOperationalAlert');

const STATE_DIRECTORY = '/var/lib/ownerinc-portal-monitor/delivery';
const HOST_FILE = '/var/lib/ownerinc-portal-monitor/observations/host.json';
function validateConfig(env) {
  let origin;
  try {
    const url = new URL(env.PORTAL_PUBLIC_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    origin = url.origin;
  } catch { throw new Error('monitor_config_invalid'); }
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(env.OPERATIONAL_MONITOR_TOKEN || '')
    || !env.OPERATIONAL_ALERT_EMAIL || !env.SMTP_ADDRESS || !['465', '587', '2525', '25'].includes(env.SMTP_PORT)
    || !env.SMTP_USERNAME || !env.SMTP_PASSWORD || !env.MAILER_SENDER_EMAIL) throw new Error('monitor_config_invalid');
  return { origin, token: env.OPERATIONAL_MONITOR_TOKEN };
}
async function boundedFetch(url, options, fetchImpl, { json = true, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  let response, reader, timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); void reader?.cancel().catch(() => {}); reject(new Error('application_unavailable'));
  }, timeoutMs); });
  try {
    return await Promise.race([timeout, (async () => {
      response = await fetchImpl(url, { ...options, cache: 'no-store', redirect: 'manual', signal: controller.signal });
      if (!json) return { status: response.status, location: response.headers.get('location') };
      if (response.status !== 200 || !/^application\/json(?:;|$)/iu.test(response.headers.get('content-type') || '')
        || !response.body || Number(response.headers.get('content-length') || 0) > 16384) throw new Error('application_unavailable');
      reader = response.body.getReader(); let size = 0; const parts = [];
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength; if (size > 16384 || controller.signal.aborted) throw new Error('observation_invalid');
        parts.push(Buffer.from(part.value));
      }
      return JSON.parse(Buffer.concat(parts).toString('utf8'));
    })()]);
  } finally {
    clearTimeout(timer); controller.abort();
    // Do not wait indefinitely for a broken upstream's cancellation promise.
    if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* Pending read. */ } }
    else void response?.body?.cancel().catch(() => {});
  }
}
async function collectObservations(config, { now = Date.now(), fetchImpl = globalThis.fetch,
  readHost = () => readProtectedJson(HOST_FILE, { uid: 0, max: 16384, privateFile: false }) } = {}) {
  const checks = [], sources = {};
  let host;
  const results = await Promise.allSettled([
    readHost(),
    boundedFetch(`${config.origin}/api/operational/observe`, { headers: { Authorization: `Bearer ${config.token}` } }, fetchImpl),
  ]);
  for (const [index, source, ids, availability] of [[0, 'host', HOST_CHECKS, 'host_observer'], [1, 'api', API_CHECKS, 'application']]) {
    try {
      if (results[index].status !== 'fulfilled') throw new Error();
      const observation = validateObservation(results[index].value, source, now);
      sources[source] = { observedAt: observation.observedAt, generation: observation.generation };
      if (source === 'host') host = observation;
      checks.push(check(availability, 'ready'), ...observation.checks);
    } catch {
      const reason = source === 'host' ? 'state_unverified' : 'application_unavailable';
      checks.push(check(availability, reason), ...ids.map(id => check(id, reason)));
    }
  }
  // Only the initial preauthority adapter is implemented. An active lifecycle
  // requires its owner's exact public route contract, never an inferred 200.
  if (host?.checks.find(row => row.id === 'host_state')?.reason === 'planned_hold') {
    try {
      const response = await boundedFetch(`${config.origin}/editorial`, {}, fetchImpl, { json: false });
      checks.push(check('public_editorial', response.status === 404 ? 'planned_hold' : 'editorial_unavailable'));
    } catch { checks.push(check('public_editorial', 'editorial_unavailable')); }
  } else checks.push(check('public_editorial', 'unsupported_contract'));
  return { checks, sources };
}
function advance(state, checks, now) {
  if (now < state.updatedAt || new Set(checks.map(row => row.id)).size !== CHECKS.length
    || checks.length !== CHECKS.length || checks.some(row => !require('./operational-contract').validCheck(row))) throw new Error('observation_invalid');
  const changes = [];
  for (const row of checks) {
    const entry = state.checks[row.id] ||= { candidate: null, count: 0, badCount: 0, current: null, delivered: null };
    const previous = entry.current;
    let reason = row.status === 'ok' ? null : row.reason;
    if (row.id.startsWith('disk_') && reason === null && entry.current && row.value >= 75) reason = 'disk_warning';
    if (row.status === 'unknown' && entry.current && ['failed', 'degraded'].includes(REASONS[entry.current])) reason = entry.current;
    // A forbidden committed write is latched evidence, not cleared by silence.
    if (entry.current === 'legacy_write_forbidden') reason = entry.current;
    // Qualification counts continuous bad evidence, independently of which
    // reason wins signature deduplication. Unknown is bad, never a clean reset.
    entry.badCount = reason === null ? 0 : Math.min(2, entry.badCount + 1);
    if (entry.candidate === reason) entry.count = Math.min(2, entry.count + 1);
    else { entry.candidate = reason; entry.count = 1; }
    if (entry.count === 2 || URGENT.has(reason) || (entry.current === null && entry.badCount === 2)) entry.current = reason;
    if (entry.current !== previous) changes.push({ id: row.id, reason: entry.current });
  }
  state.updatedAt = now;
  return changes;
}
function messageFor(outbox, state) {
  const recovering = outbox.changes.every(row => row.reason === null);
  return { subject: recovering ? '[OWN34] recuperacao observada' : '[OWN34] alerta operacional', notificationId: outbox.id,
    text: ['OWN34 — notification only; no operational action authorized.', `Notification: ${outbox.id}`,
      `First queued: ${new Date(outbox.createdAt).toISOString()}`,
      ...outbox.changes.map(row => `${row.id}: ${row.reason === null ? 'recovered' : `${REASONS[row.reason]} / ${row.reason}`}`),
      ...(state ? outbox.changes.filter(row => row.reason !== state.checks[row.id].current)
        .map(row => `${row.id}: latest observation ${state.checks[row.id].current || 'recovered'} (delivery was pending)`) : []),
      'Local backup verification is not off-host protection or restore qualification.'].join('\n') };
}
async function runMonitor({ store, env = process.env, collect, send = sendOperationalAlertResult, now = Date.now(),
  id = () => randomBytes(16).toString('hex') }) {
  const state = await store.load();
  if (state.queueOverflow) throw new Error('monitor_queue_overflow');
  const previous = structuredClone(state);
  const collected = await collect();
  let checks = collected.checks;
  for (const source of ['api', 'host']) {
    const incoming = collected.sources[source], previous = state.sources[source];
    if (incoming && previous && incoming.observedAt <= previous.observedAt) {
      const ids = source === 'api' ? [...API_CHECKS, 'application'] : [...HOST_CHECKS, 'host_observer', 'public_editorial'];
      checks = checks.map(row => ids.includes(row.id) ? check(row.id, 'observation_stale') : row);
    } else if (incoming) state.sources[source] = incoming;
  }
  const changes = advance(state, checks, now);
  // Preserve an in-flight message on restart. The acceptance/persist crash window
  // is ambiguous; delay its retry and reuse its Message-ID.
  if (state.outbox?.inflight) { state.outbox.inflight = false; state.outbox.nextAt = now + 15 * 60000; }
  if (!state.outbox && state.pending.length) state.outbox = state.pending.shift();
  if (changes.length) {
    if (state.outbox && state.pending.length >= MAX_PENDING) {
      // Keep the last complete history and source checkpoints. Persist an
      // explicit coverage-loss latch, then stop rather than overwrite history.
      previous.queueOverflow = true;
      await store.save(previous);
      throw new Error('monitor_queue_overflow');
    }
    const item = { id: id(), createdAt: now, nextAt: now, attempts: 0, inflight: false, changes };
    if (state.outbox) state.pending.push(item); else state.outbox = item;
  }
  await store.save(state);
  if (!state.outbox || state.outbox.nextAt > now) return { status: 'observed', pending: Boolean(state.outbox) };
  const item = state.outbox;
  item.inflight = true; item.attempts = Math.min(1000000, item.attempts + 1);
  await store.save(state);
  let outcome;
  try { outcome = await send(messageFor(item, state), env); } catch { outcome = { status: 'unknown' }; }
  if (outcome?.status === 'accepted') {
    for (const change of item.changes) state.checks[change.id].delivered = change.reason;
    state.outbox = null;
  } else {
    item.inflight = false;
    const delays = [60000, 300000, 900000, 3600000];
    item.nextAt = now + (outcome?.status === 'retryable' ? delays[Math.min(item.attempts - 1, 3)]
      : outcome?.status === 'permanent' ? 3600000 : 900000);
  }
  await store.save(state);
  return { status: outcome?.status === 'accepted' ? 'accepted' : 'pending', pending: Boolean(state.outbox || state.pending.length) };
}
async function main() {
  if (process.platform !== 'linux' || process.getuid() === 0 || process.argv.length !== 3 || process.argv[2] !== '--locked') throw new Error('monitor_config_invalid');
  const config = validateConfig(process.env);
  const store = await openState(STATE_DIRECTORY);
  const result = await runMonitor({ store, collect: () => collectObservations(config) });
  console.log(JSON.stringify({ service: 'operational-monitor', event: result.status, pending: result.pending }));
  if (result.pending) process.exitCode = 1;
}
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ service: 'operational-monitor',
    event: error?.message === 'monitor_queue_overflow' ? 'monitor_queue_overflow' : 'monitor_unavailable' })); process.exitCode = 1;
});
module.exports = { runMonitor, collectObservations, boundedFetch, validateConfig, advance, messageFor };
