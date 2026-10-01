const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { oneOf, parseListQuery, text, uuid } = require('../route-utils');
const { getPublishedAnnouncement, getPublishedAnnouncementNavigation, listPublishedAnnouncementCategories, listPublishedAnnouncements } = require('../cms/reader');
const { getPublishedHome } = require('../owner-news/home');

const router = express.Router();
router.use('/polls', require('./owner-news-polls'));
const kind = oneOf('article', 'edition');
const invalid = (req, res) => res.status(400).json({ error: 'Requisição inválida.', reason: 'invalid_request', requestId: req.id });
const notFound = (req, res) => res.status(404).json({ error: 'Publicação não encontrada.', reason: 'not_found', requestId: req.id });
function validQuery(query, schema = {}) {
  return Object.entries(query).every(([key, value]) => Object.hasOwn(schema, key)
    && typeof value === 'string' && schema[key](value));
}

router.get('/', authMiddleware, async (req, res, next) => {
  const page = parseListQuery(req.query, { category: text(100), kind });
  if (!page) return invalid(req, res);
  try {
    const result = await listPublishedAnnouncements(pool, page.limit, page.offset, req.query.category, req.query.kind);
    res.set('X-Total-Count', String(result.count)).json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.get('/categories', authMiddleware, async (req, res, next) => {
  if (!validQuery(req.query, { kind, with_counts: oneOf('true', 'false') })) return invalid(req, res);
  try {
    res.json(await listPublishedAnnouncementCategories(pool, { kind: req.query.kind, withCounts: req.query.with_counts === 'true' }));
  } catch (error) {
    next(error);
  }
});

router.get('/home', authMiddleware, async (req, res, next) => {
  if (!validQuery(req.query)) return invalid(req, res);
  try { res.json({ content: await getPublishedHome(pool) }); } catch (error) { next(error); }
});

router.get('/:id/navigation', authMiddleware, async (req, res, next) => {
  if (!uuid(req.params.id) || !validQuery(req.query, { category: text(100) })) return invalid(req, res);
  try {
    const navigation = await getPublishedAnnouncementNavigation(pool, req.params.id.toLowerCase(), req.query.category);
    if (!navigation) return notFound(req, res);
    res.json(navigation);
  } catch (error) { next(error); }
});

router.get('/:id', authMiddleware, async (req, res, next) => {
  if (!uuid(req.params.id) || !validQuery(req.query)) return invalid(req, res);
  try {
    const announcement = await getPublishedAnnouncement(pool, req.params.id.toLowerCase());
    if (!announcement) return notFound(req, res);
    res.json(announcement);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
