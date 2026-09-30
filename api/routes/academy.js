const express = require('express');
const pool = require('../db');
const { listCourses, listCategories } = require('../academy/catalog');
const { createAcademyLearningRouter, academyFailure } = require('./academy-learning');
const { saveCourse, deleteCourseTree } = require('../academy/mutations');
const { validateCourseInput } = require('../academy/validation');
const { authMiddleware, can } = require('../middleware/auth');
const {
  forbidden, invalid, mayViewAll, parseListQuery, uuid, withAudit,
} = require('../route-utils');

const router = express.Router();
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
  if (!validateCourseInput(req.body)) return invalid(req, res);
  try {
    const row = await withAudit(pool, req, 'academy.create', 'academy',
      db => saveCourse(db, req.user, null, req.body), { targetId: result => result.id });
    res.status(201).json(row);
  } catch (error) {
    academyFailure(error, req, res, next);
  }
});

router.put('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageAcademy')) return forbidden(req, res);
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const row = await withAudit(pool, req, 'academy.update', 'academy',
      db => saveCourse(db, req.user, req.params.id, req.body), { targetId: req.params.id });
    if (!row) return res.status(404).json({ error: 'Course not found.', requestId: req.id });
    res.json(row);
  } catch (error) {
    academyFailure(error, req, res, next);
  }
});

router.delete('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageAcademy')) return forbidden(req, res);
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const row = await withAudit(pool, req, 'academy.delete', 'academy',
      db => deleteCourseTree(db, req.params.id), { targetId: req.params.id });
    if (!row) return res.status(404).json({ error: 'Course not found.', requestId: req.id });
    res.json({ success: true });
  } catch (error) {
    academyFailure(error, req, res, next);
  }
});

module.exports = router;
