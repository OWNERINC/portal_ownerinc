const express = require('express');
const pool = require('../db');
const { authMiddleware, can } = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');
const {
  forbidden, invalid, oneOf, parseListQuery, text, uuid, validBody, withAudit,
} = require('../route-utils');

const router = express.Router();
const submissionLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, key: (req) => req.user.uid });
const createSchema = { category: text(100), message: text(10000, true) };
const patchSchema = {
  status: oneOf('new', 'in_review', 'resolved'),
  assigned_to: (value) => value === undefined || value === null
    || (typeof value === 'string' && value.length > 0 && value.length <= 128),
  internal_notes: text(10000),
};

router.get('/', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'viewOmbudsman')) return forbidden(req, res);
  const page = parseListQuery(req.query, {
    status: (value) => ['new', 'in_review', 'resolved'].includes(value),
    assigned_to: (value) => value.length > 0 && value.length <= 128,
  });
  if (!page) return invalid(req, res);

  const params = [];
  const conditions = [];
  for (const field of ['status', 'assigned_to']) {
    if (req.query[field] === undefined) continue;
    params.push(req.query[field]);
    conditions.push(`${field} = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    const result = await withAudit(pool, req, 'ombudsman.read', 'ombudsman', async (db) => {
      const countResult = await db.query(`SELECT COUNT(*)::integer AS count FROM ombudsman ${where}`, params);
      const listParams = [...params, page.limit, page.offset];
      const { rows } = await db.query(
        `SELECT * FROM ombudsman ${where} ORDER BY created_at DESC, id
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        listParams
      );
      return { count: countResult.rows[0].count, rows };
    }, { details: (value) => ({ returned: value.rows.length, total: value.count }) });
    res.set('X-Total-Count', String(result.count)).json(result.rows);
  } catch (error) {
    next(error);
  }
});

router.post('/', authMiddleware, submissionLimit, async (req, res, next) => {
  if (!validBody(req.body, createSchema, ['message'])) return invalid(req, res);
  try {
    const { category = '', message } = req.body;
    const { rows } = await pool.query(
      'INSERT INTO ombudsman (category, message) VALUES ($1, $2) RETURNING *',
      [category, message.trim()]
    );
    res.status(201).json(rows[0]);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'viewOmbudsman')) return forbidden(req, res);
  if (!uuid(req.params.id) || !Object.keys(req.body || {}).length || !validBody(req.body, patchSchema)) {
    return invalid(req, res);
  }
  if (req.body.assigned_to) {
    try {
      const { rowCount } = await pool.query('SELECT 1 FROM users WHERE uid = $1', [req.body.assigned_to]);
      if (!rowCount) return invalid(req, res);
    } catch (error) {
      return next(error);
    }
  }

  try {
    const fields = Object.keys(req.body);
    const row = await withAudit(pool, req, 'ombudsman.update', 'ombudsman', async (db) => {
      const { rows } = await db.query(
        `UPDATE ombudsman SET
           status = COALESCE($2, status),
           assigned_to = CASE WHEN $3 THEN $4 ELSE assigned_to END,
           internal_notes = CASE WHEN $5 THEN $6 ELSE internal_notes END,
           resolved_at = CASE
             WHEN $2 = 'resolved' THEN COALESCE(resolved_at, NOW())
             WHEN $2 IN ('new', 'in_review') THEN NULL
             ELSE resolved_at
           END,
           updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [req.params.id, req.body.status || null,
          fields.includes('assigned_to'), req.body.assigned_to ?? null,
          fields.includes('internal_notes'), req.body.internal_notes ?? null]
      );
      return rows[0];
    }, { targetId: req.params.id, details: { fields } });
    if (!row) return res.status(404).json({ error: 'Message not found.', requestId: req.id });
    res.json(row);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
