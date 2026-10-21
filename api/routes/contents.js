'use strict';

const express = require('express');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const pool = require('../db');
const { authMiddleware, firebaseAuth: defaultFirebaseAuth } = require('../middleware/auth');
const { ActivePortalUserError, loadActivePortalUser } = require('../middleware/active-user');
const { can } = require('../middleware/policy');
const { createPortalPagesClientFromEnv } = require('../portal-pages/payload-client');
const {
  MEDIA_SESSION_MS, MediaSessionError, assertMediaOrigin, mediaCookieConfig, mediaFirebaseError, readMediaCookie,
} = require('../portal-pages/media-cookie');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ERROR_STATUS = new Set([400, 401, 403, 404, 416, 503]);
const CONTENTS_REQUEST_BUDGET_MS = 4200;

function requestHasBody(req) {
  const length = req.headers['content-length'];
  return (length !== undefined && length !== '0') || Boolean(req.headers['transfer-encoding'])
    || (req.body !== undefined && req.body !== null);
}

function rejectBody(req, res, next) {
  if (requestHasBody(req)) return res.status(400).json({ error: 'invalid_request', reason: 'invalid_request', requestId: req.id });
  return next();
}

function strictQuery(query, allowed) {
  if (!query || typeof query !== 'object' || Array.isArray(query)) return false;
  return Object.keys(query).every(key => allowed.includes(key) && typeof query[key] === 'string');
}

function canonicalUUID(value) { return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null; }

function parseList(req) {
  const query = req.query;
  if (!strictQuery(query, ['limit', 'offset', 'category'])) return null;
  const integer = (value, fallback) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  };
  const limit = integer(query.limit, 50);
  const offset = integer(query.offset, 0);
  if (limit === null || limit < 1 || limit > 50 || offset === null || offset < 0 || offset > 1_000_000) return null;
  if (query.category !== undefined && (query.category.length > 160 || !SLUG.test(query.category))) return null;
  return { limit, offset, ...(query.category === undefined ? {} : { category: query.category }) };
}

function portalActor(user) {
  return { uid: user?.uid, email: user?.email, name: typeof user?.name === 'string' ? user.name : null,
    canManageKnowledge: can(user, 'manageKnowledge') };
}

function safeStatus(error) {
  return ERROR_STATUS.has(error?.status) ? error.status : 503;
}

function sendError(error, req, res) {
  if (res.headersSent) return res.destroy();
  const status = safeStatus(error);
  const reason = status === 400 ? 'invalid_request'
    : status === 401 ? 'media_session_invalid'
      : status === 403 ? (error?.reason || 'forbidden')
        : status === 404 ? 'not_found'
          : status === 416 ? 'range_not_satisfiable' : 'portal_pages_unavailable';
  if (status === 401 && req.clearMediaCookieOnError && req.mediaCookieConfig) {
    const { name, options } = req.mediaCookieConfig;
    res.clearCookie(name, options);
  }
  return res.status(status).json({ error: reason, reason, requestId: req.id });
}

function createRequestSignal(req, res, budgetMs = CONTENTS_REQUEST_BUDGET_MS) {
  const controller = new AbortController();
  const abort = () => { if (!res.writableFinished) controller.abort(); };
  const deadlineAt = budgetMs === null ? undefined : Date.now() + budgetMs;
  let deadlineExpired = false;
  const deadlineTimer = budgetMs === null ? undefined : setTimeout(() => {
    deadlineExpired = true;
    controller.abort();
  }, budgetMs);
  req.on('aborted', abort);
  res.on('close', abort);
  return { controller, deadlineAt, deadlineExpired: () => deadlineExpired,
    cleanup: () => {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      req.removeListener('aborted', abort); res.removeListener('close', abort);
    } };
}

function sendDeadlineOrStop({ controller, deadlineExpired, req, res }) {
  if (!controller.signal.aborted) return false;
  if (deadlineExpired() && !req.aborted && !res.destroyed && !res.headersSent) {
    sendError({ status: 503 }, req, res);
  }
  return true;
}

async function mediaActor(req, { db, firebaseAuth, env, preview }) {
  const config = mediaCookieConfig(env);
  req.mediaCookieConfig = config;
  req.clearMediaCookieOnError = true;
  const cookie = readMediaCookie(req.get('cookie'), config.name);
  if (!cookie) throw new MediaSessionError(401, 'media_session_invalid');

  let decoded;
  try { decoded = await firebaseAuth.verifySessionCookie(cookie, true); }
  catch (error) { throw mediaFirebaseError(error); }
  if (!decoded || typeof decoded.uid !== 'string' || !decoded.uid || decoded.uid.length > 128) {
    throw new MediaSessionError(401, 'media_session_invalid');
  }

  let user;
  try { user = await loadActivePortalUser(db, decoded); }
  catch (error) {
    if (error instanceof ActivePortalUserError) throw new MediaSessionError(error.status, error.reason || 'account_inactive');
    throw new MediaSessionError(503, 'portal_pages_unavailable');
  }
  if (preview && !can(user, 'manageKnowledge')) throw new MediaSessionError(403, 'forbidden');
  return portalActor(user);
}

function createContentsRouter({ db = pool, firebaseAuth = defaultFirebaseAuth, authenticate = authMiddleware,
  payloadClient, payloadClientFactory, env = process.env } = {}) {
  const router = express.Router();
  let client = payloadClient;

  function getPayloadClient() {
    if (!client) client = payloadClientFactory ? payloadClientFactory() : createPortalPagesClientFromEnv(env);
    return client;
  }

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private,no-store');
    next();
  });

  function queryRoute(action, parse) {
    return async (req, res) => {
      if (requestHasBody(req)) return res.status(400).json({ error: 'invalid_request', reason: 'invalid_request', requestId: req.id });
      const input = parse(req);
      if (!input) return res.status(400).json({ error: 'invalid_request', reason: 'invalid_request', requestId: req.id });
      if (action === 'preview' && !can(req.user, 'manageKnowledge')) {
        return res.status(403).json({ error: 'forbidden', reason: 'forbidden', requestId: req.id });
      }
      const { controller, deadlineAt, deadlineExpired, cleanup } = createRequestSignal(req, res);
      try {
        const result = await getPayloadClient()[action](input, portalActor(req.user), {
          signal: controller.signal, requestId: req.id, ...(deadlineAt === undefined ? {} : { deadlineAt }),
        });
        if (controller.signal.aborted) { await result?.body?.cancel().catch(() => {}); return sendDeadlineOrStop({ controller, deadlineExpired, req, res }); }
        if (action === 'availability') {
          if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1 ||
            typeof result.available !== 'boolean') throw new Error('invalid availability response');
          return res.json({ available: result.available });
        }
        if (result === null) return res.status(404).json({ error: 'not_found', reason: 'not_found', requestId: req.id });
        if (action === 'list') return res.set('X-Total-Count', String(result.count)).json(result.rows);
        return res.json(result);
      } catch (error) {
        if (controller.signal.aborted) return sendDeadlineOrStop({ controller, deadlineExpired, req, res });
        return sendError(error, req, res);
      } finally { cleanup(); }
    };
  }

  function assetRoute(preview) {
    return async (req, res) => {
      if (requestHasBody(req)) return res.status(400).json({ error: 'invalid_request', reason: 'invalid_request', requestId: req.id });
      const pageId = canonicalUUID(req.params.pageId);
      const revisionId = canonicalUUID(preview ? req.params.versionId : req.params.revisionId);
      const assetId = canonicalUUID(req.params.assetId);
      const range = req.get('range') || null;
      if (!pageId || !revisionId || !assetId || (range !== null && range.length > 200)) {
        return res.status(400).json({ error: 'invalid_request', reason: 'invalid_request', requestId: req.id });
      }
      const { controller, cleanup } = createRequestSignal(req, res, null);
      let result;
      try {
        const actor = await mediaActor(req, { db, firebaseAuth, env, preview });
        result = await getPayloadClient().asset({ pageId, revisionId, assetId, preview, range }, actor,
          { signal: controller.signal, requestId: req.id });
        if (controller.signal.aborted) { await result?.body?.cancel().catch(() => {}); return; }
        res.status(result.status).set(result.headers);
        if (!result.body) return res.end();
        await pipeline(Readable.fromWeb(result.body), res, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted) return;
        return sendError(error, req, res);
      } finally { cleanup(); }
    };
  }

  router.get('/', authenticate, rejectBody, queryRoute('list', parseList));
  router.get('/availability', authenticate, rejectBody, queryRoute('availability', req => strictQuery(req.query, []) ? {} : null));
  router.get('/categories', authenticate, rejectBody, queryRoute('categories', req => strictQuery(req.query, []) ? {} : null));
  router.get('/preview/:pageId', authenticate, rejectBody, queryRoute('preview', req => {
    const pageId = canonicalUUID(req.params.pageId);
    if (!pageId || !strictQuery(req.query, ['version']) || canonicalUUID(req.query.version) === null) return null;
    return { pageId, versionId: canonicalUUID(req.query.version) };
  }));

  router.get('/assets/preview/:pageId/:versionId/:assetId', rejectBody, assetRoute(true));
  router.get('/assets/:pageId/:revisionId/:assetId', rejectBody, assetRoute(false));

  router.post('/media-session', rejectBody, async (req, res, next) => {
    try { req.mediaCookieConfig = mediaCookieConfig(env); assertMediaOrigin(req, req.mediaCookieConfig); next(); }
    catch (error) { sendError(error, req, res); }
  }, authenticate, async (req, res) => {
    try {
      const token = req.get('authorization').slice(7);
      const cookie = await firebaseAuth.createSessionCookie(token, { expiresIn: MEDIA_SESSION_MS });
      if (typeof cookie !== 'string' || cookie.length < 1 || cookie.length > 12_000 || !/^[A-Za-z0-9._-]+$/u.test(cookie)) {
        throw new MediaSessionError(503, 'portal_pages_unavailable');
      }
      const { name, options } = req.mediaCookieConfig;
      const expires = new Date(Date.now() + MEDIA_SESSION_MS);
      res.cookie(name, cookie, { ...options, maxAge: MEDIA_SESSION_MS, expires });
      return res.status(204).end();
    } catch (error) { return sendError(mediaFirebaseError(error), req, res); }
  });

  router.delete('/media-session', rejectBody, (req, res) => {
    try {
      const config = mediaCookieConfig(env);
      assertMediaOrigin(req, config);
      res.clearCookie(config.name, config.options);
      return res.status(204).end();
    } catch (error) { return sendError(error, req, res); }
  });

  router.get('/:slug', authenticate, rejectBody, queryRoute('detail', req => {
    const slug = req.params.slug;
    return typeof slug === 'string' && slug.length <= 160 && SLUG.test(slug) && strictQuery(req.query, []) ? { slug } : null;
  }));

  router.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    sendError(error, req, res);
  });
  return router;
}

module.exports = { createContentsRouter, parseList, requestHasBody };
