const { createHash, timingSafeEqual } = require('node:crypto');
const { observe } = require('../operational/observe');

function createOperationalHandler({ pool, env = process.env, observeImpl = observe, now = Date.now } = {}) {
  let busy = false, lastStarted = -Infinity;
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = env.OPERATIONAL_MONITOR_TOKEN;
    const supplied = req.headers.authorization;
    // This handler is also closed when invoked outside its exact route. Query,
    // body, browser cookies/origin and alternate methods grant no capability.
    if (req.method !== 'GET' || req.originalUrl !== '/api/operational/observe'
      || req.headers.origin !== undefined || req.headers.cookie !== undefined || req.headers['sec-fetch-site'] !== undefined
      || req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')) {
      return res.status(404).json({ reason: 'not_found' });
    }
    if (!/^[A-Za-z0-9_-]{32,128}$/u.test(token || '') || typeof supplied !== 'string' || supplied.length > 136) {
      return res.status(401).json({ reason: 'unauthorized' });
    }
    const hash = value => createHash('sha256').update(value).digest();
    if (!timingSafeEqual(hash(supplied), hash(`Bearer ${token}`))) return res.status(401).json({ reason: 'unauthorized' });
    const time = now();
    if (busy || time - lastStarted < 1000) return res.status(429).json({ reason: 'observation_busy' });
    busy = true; lastStarted = time;
    try { return res.json(await observeImpl({ pool, now })); }
    catch { return res.status(503).json({ reason: 'application_unavailable' }); }
    finally { busy = false; }
  };
}
function createOperationalRouter(options) {
  const router = require('express').Router({ strict: true });
  router.get('/observe', createOperationalHandler(options));
  router.use((_req, res) => res.status(404).json({ reason: 'not_found' }));
  return router;
}
module.exports = { createOperationalRouter, createOperationalHandler };
