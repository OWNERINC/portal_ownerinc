const express = require('express');
const { EditorialSessionError, firebaseError, unavailable, issueEditorialSession, resolveEditorialSession, revokeEditorialSession } = require('../editorial-session/service');
const { editorialCookieConfig, assertEditorialOrigin, readEditorialCookie } = require('../editorial-session/origin');
const { bridgeSecret } = require('../editorial-session/service-auth');
const { can } = require('../middleware/policy');
const { getAuthority } = require('../owner-news/authority');

const RUNTIME_READY_PATH = '/editorial/ready';
const RUNTIME_READY_TIMEOUT_MS = 2000;
const RUNTIME_READY_MAX_BYTES = 256;

async function readReadinessBody(response, controller) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > RUNTIME_READY_MAX_BYTES)) return null;
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) { complete = true; break; }
      size += part.value.byteLength;
      if (size > RUNTIME_READY_MAX_BYTES) { controller.abort(); return null; }
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return null; }
  finally {
    if (!complete) {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}

async function payloadRuntimeReady({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = RUNTIME_READY_TIMEOUT_MS } = {}) {
  let origin;
  try {
    const url = new URL(env.CMS_INTERNAL_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash || typeof fetchImpl !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RUNTIME_READY_TIMEOUT_MS) return false;
    origin = url.origin;
  } catch { return false; }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${origin}${RUNTIME_READY_PATH}`, {
      method: 'GET', cache: 'no-store', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (controller.signal.aborted || response.status !== 200
      || !/^application\/json(?:\s*;|$)/iu.test(response.headers.get('content-type') || '')) return false;
    const body = await readReadinessBody(response, controller);
    return !controller.signal.aborted && body?.status === 'ready';
  } catch { return false; }
  finally {
    clearTimeout(timer);
    if (response?.body && !response.bodyUsed) await response.body.cancel().catch(() => {});
  }
}

async function getEditorialAvailability({ db, env = process.env, fetchImpl = globalThis.fetch,
  timeoutMs = RUNTIME_READY_TIMEOUT_MS }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RUNTIME_READY_TIMEOUT_MS) throw unavailable();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(unavailable()), timeoutMs);
  });
  try {
    return await Promise.race([(async () => {
      const startedAt = Date.now();
      const authority = await getAuthority(db);
      const remainingMs = timeoutMs - (Date.now() - startedAt);
      const activated = authority.mode === 'payload' || authority.mode === 'payload_frozen';
      const safetyMarginMs = Math.min(50, Math.max(5, Math.ceil(timeoutMs * 0.05)));
      const runtimeReady = remainingMs <= safetyMarginMs ? false
        : await payloadRuntimeReady({ env, fetchImpl, timeoutMs: remainingMs - safetyMarginMs });
      return {
        mode: authority.mode,
        epoch: authority.epoch,
        activated,
        runtimeReady,
        canEnter: activated && runtimeReady,
      };
    })(), timedOut]);
  } finally { clearTimeout(timer); }
}

function assertEditorialPermission(user) {
  if (!can(user, 'manageKnowledge')) throw new EditorialSessionError(403, 'editorial_permission_denied');
}

function assertEditorialAvailable(availability) {
  if (!availability.activated) throw new EditorialSessionError(409, 'editorial_not_activated');
  if (!availability.runtimeReady) throw unavailable();
}

function editorialErrorHandler(error, req, res, next) { // eslint-disable-line no-unused-vars
  const safe = error instanceof EditorialSessionError ? error :
    error.type === 'entity.too.large' ? new EditorialSessionError(413, 'editorial_request_too_large') :
      error.type === 'entity.parse.failed' ? new EditorialSessionError(400, 'invalid_editorial_request') : unavailable();
  res.status(safe.status).json({ error: safe.reason, reason: safe.reason, requestId: req.id });
}
function createEditorialSessionRouter({ db, firebaseAuth, createAuthMiddleware, env = process.env, fetchImpl = globalThis.fetch,
  readinessTimeoutMs = RUNTIME_READY_TIMEOUT_MS }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Read availability without requiring optional Payload bridge/cookie config.
    // It still authenticates the Portal user and reads the Portal authority below.
    if (req.method === 'GET' && req.path === '/availability') return next();
    try {
      bridgeSecret(env);
      req.editorialCookie = editorialCookieConfig(env);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) assertEditorialOrigin(req, req.editorialCookie);
      next();
    } catch (error) { next(error); }
  });
  router.use(express.json({ limit: '16kb' }));
  const authenticate = createAuthMiddleware({ db, firebaseAuth, onTokenError: firebaseError });
  router.get('/availability', authenticate, async (req, res, next) => {
    try {
      assertEditorialPermission(req.user);
      res.json(await getEditorialAvailability({ db, env, fetchImpl, timeoutMs: readinessTimeoutMs }));
    } catch (error) { next(error); }
  });
  router.post('/', authenticate, async (req, res, next) => {
    try {
      assertEditorialPermission(req.user);
      const availability = await getEditorialAvailability({ db, env, fetchImpl, timeoutMs: readinessTimeoutMs });
      assertEditorialAvailable(availability);
      const { name, options } = req.editorialCookie;
      const previous = readEditorialCookie(req.get('cookie'), name);
      const { cookie, expiresAt } = await issueEditorialSession({
        firebaseAuth, db, token: req.get('authorization').slice(7), user: req.user, previous,
      });
      res.cookie(name, cookie, { ...options, expires: new Date(expiresAt) });
      res.status(201).json({ uid: req.user.uid, expiresAt });
    } catch (error) { next(error); }
  });
  router.get('/', async (req, res, next) => {
    try {
      const cookie = readEditorialCookie(req.get('cookie'), req.editorialCookie.name);
      const { actor, expiresAt } = await resolveEditorialSession({ firebaseAuth, db, cookie });
      res.json({ uid: actor.uid, expiresAt });
    } catch (error) { next(error); }
  });
  router.delete('/', async (req, res, next) => {
    try {
      const { name, options } = req.editorialCookie;
      await revokeEditorialSession({ db, cookie: readEditorialCookie(req.get('cookie'), name) });
      res.clearCookie(name, options);
      res.sendStatus(204);
    } catch (error) { next(error); }
  });
  router.use(editorialErrorHandler);
  return router;
}
module.exports = { createEditorialSessionRouter, editorialErrorHandler, getEditorialAvailability, payloadRuntimeReady };
