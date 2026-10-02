const express = require('express');
const { EditorialSessionError, firebaseError, unavailable, issueEditorialSession, resolveEditorialSession, revokeEditorialSession } = require('../editorial-session/service');
const { editorialCookieConfig, assertEditorialOrigin, readEditorialCookie } = require('../editorial-session/origin');
const { bridgeSecret } = require('../editorial-session/service-auth');

function editorialErrorHandler(error, req, res, next) { // eslint-disable-line no-unused-vars
  const safe = error instanceof EditorialSessionError ? error :
    error.type === 'entity.too.large' ? new EditorialSessionError(413, 'editorial_request_too_large') :
      error.type === 'entity.parse.failed' ? new EditorialSessionError(400, 'invalid_editorial_request') : unavailable();
  res.status(safe.status).json({ error: safe.reason, reason: safe.reason, requestId: req.id });
}
function createEditorialSessionRouter({ db, firebaseAuth, createAuthMiddleware, env = process.env }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try {
      bridgeSecret(env);
      req.editorialCookie = editorialCookieConfig(env);
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) assertEditorialOrigin(req, req.editorialCookie);
      next();
    } catch (error) { next(error); }
  });
  router.use(express.json({ limit: '16kb' }));
  const authenticate = createAuthMiddleware({ db, firebaseAuth, onTokenError: firebaseError });
  router.post('/', authenticate, async (req, res, next) => {
    try {
      const { name, options } = req.editorialCookie;
      const previous = readEditorialCookie(req.get('cookie'), name);
      // Revocation must succeed before replacing the browser's session, including account switches.
      await revokeEditorialSession({ db, cookie: previous });
      const { cookie, expiresAt } = await issueEditorialSession({
        firebaseAuth, db, token: req.get('authorization').slice(7), user: req.user,
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
module.exports = { createEditorialSessionRouter, editorialErrorHandler };
