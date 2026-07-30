const express = require('express');
const pool = require('../db');
const { authMiddleware, can } = require('../middleware/auth');
const { boolean, forbidden, invalid, parseListQuery, text, uuid, validBody, withAudit } = require('../route-utils');

const router = express.Router();
const schema = { name: text(120, true), active: boolean };
const listQuery = { all: (value) => ['true', 'false'].includes(value), active: (value) => value === 'true' };

function canManage(req, res) {
  if (!can(req.user, 'manageUsers')) {
    forbidden(req, res);
    return false;
  }
  return true;
}

router.get('/', authMiddleware, async (req, res, next) => {
  if (!canManage(req, res)) return;
  const page = parseListQuery(req.query, listQuery);
  if (!page) return invalid(req, res);
  const where = req.query.all === 'true' ? '' : 'WHERE jt.active = TRUE';
  try {
    const [{ rows: [{ count }] }, { rows }] = await Promise.all([
      pool.query(`SELECT COUNT(*)::integer AS count FROM job_titles jt ${where}`),
      pool.query(`SELECT jt.id, jt.name, jt.active, jt.created_at, jt.updated_at, COUNT(u.uid)::integer AS user_count
        FROM job_titles jt LEFT JOIN users u ON u.job_title_id = jt.id ${where}
        GROUP BY jt.id ORDER BY lower(jt.name), jt.id LIMIT $1 OFFSET $2`, [page.limit, page.offset]),
    ]);
    res.set('X-Total-Count', String(count)).json(rows);
  } catch (error) {
    next(error);
  }
});

router.post('/', authMiddleware, async (req, res, next) => {
  if (!canManage(req, res)) return;
  if (!validBody(req.body, schema, ['name'])) return invalid(req, res);
  try {
    const row = await withAudit(pool, req, 'job_title.create', 'job_title', async (db) => {
      const { rows } = await db.query(
        'INSERT INTO job_titles (name, active) VALUES ($1, $2) RETURNING *',
        [req.body.name.trim(), req.body.active ?? true]
      );
      return rows[0];
    }, { targetId: (result) => result.id });
    res.status(201).json({ ...row, user_count: 0 });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Cargo já cadastrado.', requestId: req.id });
    next(error);
  }
});

router.put('/:id', authMiddleware, async (req, res, next) => {
  if (!canManage(req, res)) return;
  if (!uuid(req.params.id) || !validBody(req.body, schema, ['name', 'active'])) return invalid(req, res);
  try {
    const row = await withAudit(pool, req, 'job_title.update', 'job_title', async (db) => {
      const { rows } = await db.query(
        `UPDATE job_titles SET name = $2, active = $3, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [req.params.id, req.body.name.trim(), req.body.active]
      );
      return rows[0];
    }, { targetId: req.params.id, details: { fields: Object.keys(req.body).sort() } });
    if (!row) return res.status(404).json({ error: 'Cargo não encontrado.', requestId: req.id });
    const { rows: [{ count }] } = await pool.query('SELECT COUNT(*)::integer AS count FROM users WHERE job_title_id = $1', [row.id]);
    res.json({ ...row, user_count: count });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Cargo já cadastrado.', requestId: req.id });
    next(error);
  }
});

module.exports = router;
