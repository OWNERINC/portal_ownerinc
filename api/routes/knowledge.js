const express = require('express');
const pool = require('../db');
const { authMiddleware, can } = require('../middleware/auth');
const {
  forbidden, invalid, parseListQuery, text, uuid, validBody, withAudit,
} = require('../route-utils');

const router = express.Router();
const schema = {
  title: text(200, true),
  category: text(100),
  content: text(50000),
};
const listQuery = {
  q: value => value.length <= 120,
  category: value => value.length <= 100,
};

router.get('/categories', authMiddleware, async (req, res, next) => {
  if (Object.keys(req.query).length) return invalid(req, res);
  try {
    const { rows } = await pool.query(
      `SELECT id, btrim(category) AS category
       FROM knowledge_base
       WHERE btrim(category) <> ''
       ORDER BY category, id`,
    );
    res.json([...new Set(rows.map(({ category }) => category))]);
  } catch (error) {
    next(error);
  }
});

router.get('/', authMiddleware, async (req, res, next) => {
  const page = parseListQuery(req.query, listQuery);
  if (!page) return invalid(req, res);
  const category = req.query.category;
  const values = [];
  const conditions = [];
  if (category) {
    values.push(category);
    conditions.push(`btrim(knowledge_base.category) = $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    const { rows } = await pool.query(
      `SELECT knowledge_base.*
         FROM knowledge_base ${where}
        ORDER BY knowledge_base.updated_at DESC, knowledge_base.id`,
      values,
    );
    const matches = req.query.q
      ? rows.filter((row) => {
        const needle = req.query.q.toLocaleLowerCase('pt-BR');
        return [row.title, row.content].some((value) => String(value || '')
          .toLocaleLowerCase('pt-BR').includes(needle));
      })
      : rows;
    res.set('X-Total-Count', String(matches.length))
      .json(matches.slice(page.offset, page.offset + page.limit));
  } catch (error) {
    next(error);
  }
});

router.get('/:id', authMiddleware, async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const { rows } = await pool.query('SELECT * FROM knowledge_base WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Article not found.', requestId: req.id });
    res.json(rows[0]);
  } catch (error) {
    next(error);
  }
});

router.post('/', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageKnowledge')) return forbidden(req, res);
  if (!validBody(req.body, schema, ['title'])) return invalid(req, res);
  try {
    const { title, category = '', content = '' } = req.body;
    const result = await withAudit(pool, req, 'knowledge.create', 'knowledge', async (db) => {
      const { rows } = await db.query(
        `INSERT INTO knowledge_base (title, category, content, created_by)
          VALUES ($1, $2, $3, $4) RETURNING *`,
        [title.trim(), category, content, req.user.uid]
      );
      return { row: rows[0] };
    }, { targetId: result => result.row.id });
    res.status(201).json(result.row);
  } catch (error) { next(error); }
});

router.put('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageKnowledge')) return forbidden(req, res);
  if (!uuid(req.params.id) || !validBody(req.body, schema, ['title', 'category'])) return invalid(req, res);
  try {
    const result = await withAudit(pool, req, 'knowledge.update', 'knowledge', async (db) => {
      const existing = await db.query('SELECT * FROM knowledge_base WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!existing.rows[0]) return null;
      const content = req.body.content === undefined ? existing.rows[0].content : req.body.content;
      const { rows } = await db.query(
        `UPDATE knowledge_base SET title=$2, category=$3, content=$4, updated_at=NOW()
           WHERE id=$1 RETURNING *`,
        [req.params.id, req.body.title.trim(), req.body.category, content]
      );
      if (!rows[0]) return null;
      return { row: rows[0] };
    }, { targetId: req.params.id });
    if (!result || !result.row) return res.status(404).json({ error: 'Article not found.', requestId: req.id });
    res.json(result.row);
  } catch (error) { next(error); }
});

router.delete('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageKnowledge')) return forbidden(req, res);
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const row = await withAudit(pool, req, 'knowledge.delete', 'knowledge',
      async db => (await db.query('DELETE FROM knowledge_base WHERE id=$1 RETURNING id', [req.params.id])).rows[0], { targetId: req.params.id });
    if (!row) return res.status(404).json({ error: 'Article not found.', requestId: req.id });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
