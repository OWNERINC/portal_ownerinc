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

// Academy management may read the audience catalogue without granting the
// broader user-management permission. This is deliberately a separate,
// Academy-scoped projection; /api/job-titles remains manageUsers-only.
router.get('/job-titles', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageAcademy')) return forbidden(req, res);
  const page = parseListQuery(req.query, {});
  if (!page) return invalid(req, res);
  try {
    const [{ rows: [{ count }] }, { rows }] = await Promise.all([
      pool.query('SELECT COUNT(*)::integer AS count FROM job_titles'),
      pool.query('SELECT id, name, active FROM job_titles ORDER BY lower(name), id LIMIT $1 OFFSET $2', [page.limit, page.offset]),
    ]);
    res.set('X-Total-Count', String(count)).json(rows);
  } catch (error) { next(error); }
});

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
