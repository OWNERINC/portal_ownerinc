const express = require('express');
const { EditorialSessionError, resolveEditorialSession, revokeEditorialSession, checkEditorialActor } = require('../editorial-session/service');
const { assertEditorialService } = require('../editorial-session/service-auth');
const { getAuthority } = require('../owner-news/authority');
const { editorialErrorHandler } = require('./editorial-session');

function createEditorialInternalRouter({ db, firebaseAuth, env = process.env }) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    try { assertEditorialService(req, env); next(); } catch (error) { next(error); }
  });
  router.use(express.json({ limit: '16kb' }));
  function input(req, key) {
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).length !== 1 ||
      typeof req.body[key] !== 'string' || !req.body[key]) throw new EditorialSessionError(400, 'invalid_editorial_request');
    return req.body[key];
  }
  router.post('/session/resolve', async (req, res, next) => {
    try { res.json(await resolveEditorialSession({ firebaseAuth, db, cookie: input(req, 'cookie') })); }
    catch (error) { next(error); }
  });
  router.post('/session/revoke', async (req, res, next) => {
    try { await revokeEditorialSession({ db, cookie: input(req, 'cookie') }); res.sendStatus(204); }
    catch (error) { next(error); }
  });
  router.post('/actor/check', async (req, res, next) => {
    try { res.json({ actor: await checkEditorialActor({ firebaseAuth, db, uid: input(req, 'uid') }) }); }
    catch (error) { next(error); }
  });
  router.get('/authority', async (req, res, next) => {
    try { res.json(await getAuthority(db)); }
    catch { next(new EditorialSessionError(503, 'news_authority_unavailable')); }
  });
  router.use(editorialErrorHandler);
  return router;
}
module.exports = { createEditorialInternalRouter };
