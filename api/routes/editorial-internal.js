const express = require('express');
const {
  EditorialSessionError, resolveEditorialSession, resolveEditorialAdminSession,
  revokeEditorialSession, checkEditorialActor,
} = require('../editorial-session/service');
const { assertEditorialService } = require('../editorial-session/service-auth');
const { createEditorialQuotas } = require('../editorial-session/quota');
const { getAuthority } = require('../owner-news/authority');
const { editorialErrorHandler } = require('./editorial-session');
const { editorialCookieConfig, readEditorialCookie } = require('../editorial-session/origin');
const { loadActivePortalUser, ActivePortalUserError } = require('../middleware/active-user');

function createEditorialInternalRouter({ db, firebaseAuth, env = process.env, quota }) {
  const router = express.Router();
  const limits = createEditorialQuotas(quota);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try { assertEditorialService(req, env); next(); }
    catch (error) { limits.rejected(req, res, () => next(error)); }
  });
  const json = express.json({ limit: '16kb' });
  function input(req, key) {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 1 ||
      typeof req.body[key] !== 'string' || !req.body[key]) throw new EditorialSessionError(400, 'invalid_editorial_request');
    return req.body[key];
  }
  router.post('/session/resolve', limits.resolve, json, async (req, res, next) => {
    try { res.json(await resolveEditorialSession({ firebaseAuth, db, cookie: input(req, 'cookie') })); }
    catch (error) { next(error); }
  });
  // This v2 general-admin resolution deliberately shares the bounded resolve lane
  // with News session resolution; it does not read or project News authority.
  router.post('/admin/session/resolve', limits.resolve, json, async (req, res, next) => {
    try { res.json(await resolveEditorialAdminSession({ firebaseAuth, db, cookie: input(req, 'cookie') })); }
    catch (error) { next(error); }
  });
  router.post('/session/revoke', limits.revoke, json, async (req, res, next) => {
    try { await revokeEditorialSession({ db, cookie: input(req, 'cookie') }); res.sendStatus(204); }
    catch (error) { next(error); }
  });
  router.post('/actor/check', limits.actor, json, async (req, res, next) => {
    try { res.json({ actor: await checkEditorialActor({ firebaseAuth, db, uid: input(req, 'uid') }) }); }
    catch (error) { next(error); }
  });
  router.get('/authority', limits.authority, async (req, res, next) => {
    try { res.json(await getAuthority(db)); }
    catch { next(new EditorialSessionError(503, 'news_authority_unavailable')); }
  });
  // The service secret alone never authorizes a browser editor. Resolve the real
  // revocable cookie on every request, then use the unchanged CMS authorizer.
  router.use('/polls', limits.resolve, json, require('./owner-news-polls').createPollAdminRouter({ db,
    authenticate: async (req, res, next) => {
      try {
        const cookie = readEditorialCookie(req.get('cookie'), editorialCookieConfig(env).name);
        const { actor } = await resolveEditorialSession({ firebaseAuth, db, cookie });
        req.user = await loadActivePortalUser(db, { uid: actor.uid, email_verified: true });
        next();
      } catch (error) {
        next(error instanceof ActivePortalUserError ? new EditorialSessionError(403, error.reason || 'account-inactive') : error);
      }
    },
  }));
  // This private namespace must not fall through into the public-client bucket.
  router.use((req, res) => res.sendStatus(404));
  router.use(editorialErrorHandler);
  return router;
}
module.exports = { createEditorialInternalRouter };
