const express = require('express');
const pool = require('../db');
const { listCourses, listCategories } = require('../academy/catalog');
const { createAcademyLearningRouter, academyFailure } = require('./academy-learning');
const { deleteCmsSource } = require('../cms/sources');
const { authMiddleware, can } = require('../middleware/auth');
const {
  boolean, forbidden, httpUrl, integer, invalid, mayViewAll, parseListQuery,
  text, uuid, validBody, withAudit,
} = require('../route-utils');

const router = express.Router();
const schema = {
  title: text(200, true), category: text(100), description: text(5000),
  url: httpUrl, order: integer(-100000, 100000), active: boolean,
};
const listQuery = { all: (value) => ['true', 'false'].includes(value), active: (value) => value === 'true' };

router.get('/categories', authMiddleware, async (req, res, next) => {
  const all = req.query.all;
  if (all !== undefined && !['true', 'false'].includes(all)) return invalid(req, res);
  if (all === 'true' && !can(req.user, 'manageAcademy')) return forbidden(req, res);
  const viewAll = mayViewAll(req.user, 'manageAcademy', all);
  try {
    res.json(await listCategories(pool, req.user, { preview: viewAll }));
  } catch (error) {
    academyFailure(error, req, res, next);
  }
});

router.get('/', authMiddleware, async (req, res, next) => {
  const page = parseListQuery(req.query, { ...listQuery, category: value => value.length <= 100,
    group: value => ['initial', 'role'].includes(value) });
  if (!page) return invalid(req, res);
  if (req.query.all === 'true' && !can(req.user, 'manageAcademy')) return forbidden(req, res);
  const viewAll = mayViewAll(req.user, 'manageAcademy', req.query.all);
  try {
    const { items, total } = await listCourses(pool, req.user, { ...req.query, ...page, preview: viewAll });
    res.set('X-Total-Count', String(total)).json(items);
  } catch (error) {
    academyFailure(error, req, res, next);
  }
});

router.use(createAcademyLearningRouter({ pool, authenticate: authMiddleware }));

router.post('/', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageAcademy')) return forbidden(req, res);
  if (!validBody(req.body, schema, ['title', 'url'])) return invalid(req, res);
  try {
    const { title, category = '', description = '', url, order = 0, active = true } = req.body;
    const row = await withAudit(pool, req, 'academy.create', 'academy', async (db) => {
      const { rows } = await db.query(
        `INSERT INTO academy (title, category, description, url, "order", active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [title.trim(), category, description, url, order, active]
      );
      return rows[0];
    }, { targetId: (result) => result.id });
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageAcademy')) return forbidden(req, res);
  if (!uuid(req.params.id) || !validBody(req.body, schema, Object.keys(schema))) return invalid(req, res);
  try {
    const row = await withAudit(pool, req, 'academy.update', 'academy', async (db) => {
      const { title, category, description, url, order, active } = req.body;
      const { rows } = await db.query(
        `UPDATE academy SET title=$2, category=$3, description=$4, url=$5, "order"=$6, active=$7
         WHERE id=$1 RETURNING *`,
        [req.params.id, title.trim(), category, description, url, order, active]
      );
      return rows[0];
    }, { targetId: req.params.id });
    if (!row) return res.status(404).json({ error: 'Course not found.', requestId: req.id });
    res.json(row);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageAcademy')) return forbidden(req, res);
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const row = await withAudit(pool, req, 'academy.delete', 'academy',
      db => deleteCmsSource(db, 'academy', req.params.id), { targetId: req.params.id });
    if (!row) return res.status(404).json({ error: 'Course not found.', requestId: req.id });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
