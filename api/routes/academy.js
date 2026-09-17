const express = require('express');
const pool = require('../db');
const { addPublishedBlocks, isPublicCmsRow } = require('../cms/reader');
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
  const where = viewAll ? '' : 'WHERE active = TRUE';
  try {
    if (!viewAll) {
      const { rows } = await pool.query(
        `SELECT id, category FROM academy ${where} AND btrim(category) <> '' ORDER BY category, id`,
      );
      const visible = (await addPublishedBlocks(pool, rows, 'academy')).filter(isPublicCmsRow);
      return res.json([...new Set(visible.map(({ category }) => category.trim()))]);
    }
    const { rows } = await pool.query(
      `SELECT DISTINCT btrim(category) AS category
       FROM academy ${where} ${where ? 'AND' : 'WHERE'} btrim(category) <> ''
       ORDER BY category`,
    );
    res.json(rows.map(({ category }) => category));
  } catch (error) {
    next(error);
  }
});

router.get('/', authMiddleware, async (req, res, next) => {
  const page = parseListQuery(req.query, { ...listQuery, category: value => value.length <= 100 });
  if (!page) return invalid(req, res);
  if (req.query.all === 'true' && !can(req.user, 'manageAcademy')) return forbidden(req, res);
  const conditions = [];
  const viewAll = mayViewAll(req.user, 'manageAcademy', req.query.all);
  if (!viewAll) conditions.push('active = TRUE');
  if (req.query.active === 'true') conditions.push('active = TRUE');
  if (req.query.category) conditions.push('btrim(academy.category) = $1');
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const filterValues = req.query.category ? [req.query.category] : [];
  try {
    if (!viewAll) {
      const { rows } = await pool.query(
        `SELECT * FROM academy ${where} ORDER BY "order", id`,
        filterValues,
      );
      const visible = (await addPublishedBlocks(pool, rows, 'academy')).filter(isPublicCmsRow);
      return res.set('X-Total-Count', String(visible.length))
        .json(visible.slice(page.offset, page.offset + page.limit));
    }
    const [{ rows: [{ count }] }, { rows }] = await Promise.all([
      pool.query(`SELECT COUNT(*)::integer AS count FROM academy ${where}`, filterValues),
      pool.query(`SELECT * FROM academy ${where} ORDER BY "order", id LIMIT $${filterValues.length + 1} OFFSET $${filterValues.length + 2}`, [...filterValues, page.limit, page.offset]),
    ]);
    res.set('X-Total-Count', String(count)).json((await addPublishedBlocks(pool, rows, 'academy')).filter(Boolean));
  } catch (error) {
    next(error);
  }
});

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
