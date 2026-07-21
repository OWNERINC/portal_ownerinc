const express = require('express');
const pool = require('../db');
const { authMiddleware, can } = require('../middleware/auth');
const {
  forbidden, invalid, parseListQuery, text, uuid, validBody, withAudit,
} = require('../route-utils');

const router = express.Router();
const schema = { title: text(200, true), category: text(100), content: text(50000) };

router.get('/', authMiddleware, async (req, res, next) => {
  const page = parseListQuery(req.query);
  if (!page) return invalid(req, res);
  try {
    const [{ rows: [{ count }] }, { rows }] = await Promise.all([
      pool.query('SELECT COUNT(*)::integer AS count FROM knowledge_base'),
      pool.query('SELECT * FROM knowledge_base ORDER BY updated_at DESC LIMIT $1 OFFSET $2', [page.limit, page.offset]),
    ]);
    res.set('X-Total-Count', String(count)).json(rows);
  } catch (error) {
    next(error);
  }
});

router.post('/', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageKnowledge')) return forbidden(req, res);
  if (!validBody(req.body, schema, ['title'])) return invalid(req, res);
  try {
    const { title, category = '', content = '' } = req.body;
    const row = await withAudit(pool, req, 'knowledge.create', 'knowledge', async (db) => {
      const { rows } = await db.query(
        `INSERT INTO knowledge_base (title, category, content, created_by)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [title.trim(), category, content, req.user.uid]
      );
      return rows[0];
    }, { targetId: (result) => result.id });
    res.status(201).json(row);
  } catch (error) {
    next(error);
  }
});

router.put('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageKnowledge')) return forbidden(req, res);
  if (!uuid(req.params.id) || !validBody(req.body, schema, ['title', 'category', 'content'])) return invalid(req, res);
  try {
    const row = await withAudit(pool, req, 'knowledge.update', 'knowledge', async (db) => {
      const { rows } = await db.query(
        `UPDATE knowledge_base SET title=$2, category=$3, content=$4, updated_at=NOW()
         WHERE id=$1 RETURNING *`,
        [req.params.id, req.body.title.trim(), req.body.category, req.body.content]
      );
      return rows[0];
    }, { targetId: req.params.id });
    if (!row) return res.status(404).json({ error: 'Article not found.', requestId: req.id });
    res.json(row);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageKnowledge')) return forbidden(req, res);
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const row = await withAudit(pool, req, 'knowledge.delete', 'knowledge', async (db) => {
      const { rows } = await db.query('DELETE FROM knowledge_base WHERE id=$1 RETURNING id', [req.params.id]);
      return rows[0];
    }, { targetId: req.params.id });
    if (!row) return res.status(404).json({ error: 'Article not found.', requestId: req.id });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
