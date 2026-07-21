const express = require('express');
const pool = require('../db');
const { authMiddleware, can } = require('../middleware/auth');
const {
  boolean, forbidden, integer, invalid, mayViewAll, parseListQuery, text, uuid,
  validBody, withAudit,
} = require('../route-utils');

const router = express.Router();
const schema = {
  company: text(200, true), category: text(100), description: text(5000),
  instructions: text(10000), order: integer(-100000, 100000), active: boolean,
};
const listQuery = { all: (value) => ['true', 'false'].includes(value), active: (value) => value === 'true' };

router.get('/', authMiddleware, async (req, res, next) => {
  const page = parseListQuery(req.query, listQuery);
  if (!page) return invalid(req, res);
  if (req.query.all === 'true' && !can(req.user, 'manageBenefits')) return forbidden(req, res);
  const where = mayViewAll(req.user, 'manageBenefits', req.query.all) ? '' : 'WHERE active = TRUE';
  try {
    const [{ rows: [{ count }] }, { rows }] = await Promise.all([
      pool.query(`SELECT COUNT(*)::integer AS count FROM benefits ${where}`),
      pool.query(`SELECT * FROM benefits ${where} ORDER BY "order", id LIMIT $1 OFFSET $2`, [page.limit, page.offset]),
    ]);
    res.set('X-Total-Count', String(count)).json(rows);
  } catch (error) {
    next(error);
  }
});

router.post('/', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageBenefits')) return forbidden(req, res);
  if (!validBody(req.body, schema, ['company'])) return invalid(req, res);
  try {
    const { company, category = '', description = '', instructions = '', order = 0, active = true } = req.body;
    const row = await withAudit(pool, req, 'benefit.create', 'benefit', async (db) => {
      const { rows } = await db.query(
        `INSERT INTO benefits (company, category, description, instructions, "order", active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [company.trim(), category, description, instructions, order, active]
      );
      return rows[0];
    }, { targetId: (result) => result.id });
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageBenefits')) return forbidden(req, res);
  if (!uuid(req.params.id) || !validBody(req.body, schema, Object.keys(schema))) return invalid(req, res);
  try {
    const row = await withAudit(pool, req, 'benefit.update', 'benefit', async (db) => {
      const { company, category, description, instructions, order, active } = req.body;
      const { rows } = await db.query(
        `UPDATE benefits SET company=$2, category=$3, description=$4, instructions=$5, "order"=$6, active=$7
         WHERE id=$1 RETURNING *`,
        [req.params.id, company.trim(), category, description, instructions, order, active]
      );
      return rows[0];
    }, { targetId: req.params.id });
    if (!row) return res.status(404).json({ error: 'Benefit not found.', requestId: req.id });
    res.json(row);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageBenefits')) return forbidden(req, res);
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const row = await withAudit(pool, req, 'benefit.delete', 'benefit', async (db) => {
      const { rows } = await db.query('DELETE FROM benefits WHERE id=$1 RETURNING id', [req.params.id]);
      return rows[0];
    }, { targetId: req.params.id });
    if (!row) return res.status(404).json({ error: 'Benefit not found.', requestId: req.id });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
