const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { canManageCms } = require('../cms/permissions');
const { validBody, withAudit } = require('../route-utils');
const { HomeError, normalizeHome, validVersion, getHomeAdmin, saveHomeDraft, publishHome } = require('../owner-news/home');

const router = express.Router();
const messages = {
  invalid_home: 'A abertura editorial é inválida.',
  version_conflict: 'A abertura foi alterada. Recarregue antes de continuar.',
  draft_required: 'Salve um rascunho antes de publicar.',
};
function sendError(error, req, res, next) {
  if (!(error instanceof HomeError)) return next(error);
  return res.status(error.status).json({ error: messages[error.code], reason: error.code, requestId: req.id });
}
function authorize(req, res, next) {
  if (!canManageCms(req.user, 'announcement')) {
    return res.status(403).json({ error: 'Permissão negada.', reason: 'forbidden', requestId: req.id });
  }
  if (Object.keys(req.query).length) return sendError(new HomeError(400, 'invalid_home'), req, res, next);
  next();
}

function homeBody(body, schema, required) {
  return validBody(body, schema, required) && Object.keys(body).every(key => Object.hasOwn(schema, key));
}

router.get('/home', authMiddleware, authorize, async (req, res, next) => {
  try { res.json(await getHomeAdmin(pool)); } catch (error) { next(error); }
});

router.put('/home/draft', authMiddleware, authorize, async (req, res, next) => {
  try {
    if (!homeBody(req.body, { expected_version: validVersion, content: value => normalizeHome(value) !== null },
      ['expected_version', 'content'])) throw new HomeError(400, 'invalid_home');
    const result = await withAudit(pool, req, 'owner_news.home.draft', 'owner_news_home',
      db => saveHomeDraft(db, req.body, req.user.uid), { details: row => ({ version: row.version }) });
    res.json(result);
  } catch (error) { sendError(error, req, res, next); }
});

router.post('/home/publish', authMiddleware, authorize, async (req, res, next) => {
  try {
    if (!homeBody(req.body, { expected_version: validVersion }, ['expected_version'])) throw new HomeError(400, 'invalid_home');
    const result = await withAudit(pool, req, 'owner_news.home.publish', 'owner_news_home',
      db => publishHome(db, req.body.expected_version, req.user.uid), { details: row => ({ version: row.version }) });
    res.json(result);
  } catch (error) { sendError(error, req, res, next); }
});

module.exports = router;
