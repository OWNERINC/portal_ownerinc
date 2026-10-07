const express = require('express');
const {
  adminActorFromUser, firebaseError, unavailable,
  issueEditorialAdminSession, resolveEditorialAdminSession, revokeEditorialSession,
} = require('../editorial-session/service');
const { canEnterAdmin } = require('../editorial-session/admin-actor');
const { editorialCookieConfig, assertEditorialOrigin, readEditorialCookie } = require('../editorial-session/origin');
const { bridgeSecret } = require('../editorial-session/service-auth');
const { editorialErrorHandler, payloadRuntimeReady } = require('./editorial-session');

async function getAdminAvailability({ user, env = process.env, fetchImpl = globalThis.fetch,
  timeoutMs = 2000 }) {
  const canEnter = canEnterAdmin(user);
  const runtimeAvailable = await payloadRuntimeReady({ env, fetchImpl, timeoutMs });
  return {
    version: 2,
    adminEntryAllowed: canEnter && runtimeAvailable,
    runtimeAvailable,
    canEnterAdmin: canEnter,
  };
}

function createEditorialAdminSessionRouter({ db, firebaseAuth, createAuthMiddleware, env = process.env,
  fetchImpl = globalThis.fetch, readinessTimeoutMs = 2000 }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    // Like v1 availability, this read does not depend on the optional service-secret/cookie setup.
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
    try { res.json(await getAdminAvailability({ user: req.user, env, fetchImpl, timeoutMs: readinessTimeoutMs })); }
    catch (error) { next(error); }
  });
  router.post('/', authenticate, async (req, res, next) => {
    try {
      const actor = adminActorFromUser(req.user);
      const runtimeAvailable = await payloadRuntimeReady({ env, fetchImpl, timeoutMs: readinessTimeoutMs });
      if (!runtimeAvailable) throw unavailable();
      const { name, options } = req.editorialCookie;
      const previous = readEditorialCookie(req.get('cookie'), name);
      const { cookie, expiresAt } = await issueEditorialAdminSession({
        firebaseAuth, db, token: req.get('authorization').slice(7), user: req.user, previous,
      });
      res.cookie(name, cookie, { ...options, expires: new Date(expiresAt) });
      res.status(201).json({ actor, expiresAt });
    } catch (error) { next(error); }
  });
  router.get('/', async (req, res, next) => {
    try {
      const cookie = readEditorialCookie(req.get('cookie'), req.editorialCookie.name);
      res.json(await resolveEditorialAdminSession({ firebaseAuth, db, cookie }));
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
  router.use((_req, res) => res.sendStatus(404));
  router.use(editorialErrorHandler);
  return router;
}

module.exports = { createEditorialAdminSessionRouter, getAdminAvailability };
