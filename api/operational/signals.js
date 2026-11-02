const { randomBytes } = require('node:crypto');
const WINDOW_MS = 5 * 60000;
function createSignals({ now = Date.now } = {}) {
  const started = now();
  const generation = randomBytes(16).toString('hex');
  const counters = Object.fromEntries(['feed_requests', 'editorial_requests', 'legacy_refusals'].map(id => [id,
    { successes: 0, failures: 0, degraded: 0, lastSuccess: null, lastFailure: null, lastDegraded: null }]));
  function record(id, outcome) {
    const entry = counters[id]; if (!entry || !['ok', 'failed', 'degraded'].includes(outcome)) return;
    const field = outcome === 'ok' ? 'successes' : outcome === 'failed' ? 'failures' : 'degraded';
    entry[field] = Math.min(Number.MAX_SAFE_INTEGER, entry[field] + 1);
    entry[outcome === 'ok' ? 'lastSuccess' : outcome === 'failed' ? 'lastFailure' : 'lastDegraded'] = now();
  }
  function snapshot() {
    const time = now();
    return Object.entries(counters).map(([id, entry]) => {
      let reason, status;
      if (entry.lastFailure !== null && time - entry.lastFailure < WINDOW_MS) { reason = 'request_failures'; status = 'failed'; }
      else if (entry.lastDegraded !== null && time - entry.lastDegraded < WINDOW_MS) { reason = id === 'legacy_refusals' ? 'legacy_refused' : 'read_degraded'; status = 'degraded'; }
      else if (time < started || time - started < WINDOW_MS) { reason = 'coverage_gap'; status = 'unknown'; }
      else if (id === 'legacy_refusals') { reason = 'quiet'; status = 'ok'; }
      else if (entry.lastSuccess === null || time - entry.lastSuccess > WINDOW_MS) { reason = 'no_samples'; status = 'unknown'; }
      else { reason = 'ready'; status = 'ok'; }
      return { id, reason, status };
    });
  }
  function middleware(req, res, next) {
    const pathname = String(req.originalUrl || req.url || '').split('?')[0];
    const id = /^\/api\/announcements(?:\/|$)/u.test(pathname) ? 'feed_requests'
      : /^\/api\/cms\/(?:v2\/)?session(?:\/|$)/u.test(pathname) || pathname.startsWith('/api/internal/editorial/') ? 'editorial_requests' : null;
    if (id) res.once('finish', () => {
      if (res.statusCode >= 500) record(id, 'failed');
      else if (res.statusCode >= 200 && res.statusCode < 300) record(id, res.getHeader('X-Owner-News-Read-State') === 'degraded' ? 'degraded' : 'ok');
    });
    next();
  }
  return { generation, record, snapshot, middleware };
}
const signals = createSignals();
module.exports = { createSignals, signals };
