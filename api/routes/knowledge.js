const express = require('express');
const pool = require('../db');
const { loadDocument, documentImage, documentSummary } = require('../knowledge/documents');
const { authMiddleware, can } = require('../middleware/auth');
const {
  forbidden, invalid, parseListQuery, text, uuid, validBody, withAudit,
} = require('../route-utils');

const router = express.Router();
const uploadDir = () => process.env.UPLOAD_DIR || '/app/uploads';
const schema = {
  title: text(200, true),
  category: text(100),
  content: text(50000),
};
const listQuery = {
  q: value => value.length <= 120,
  category: value => value.length <= 100,
};
const legacyPdfFields = new Set(['pdf_asset_id', 'pdf_title', 'pdf', 'asset_id', 'pdf_state']);
const hasLegacyPdfFields = body => body && typeof body === 'object'
  && Object.keys(body).some(key => legacyPdfFields.has(key));

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
        ORDER BY CASE WHEN knowledge_base.document->>'kind' = 'ethics' THEN 0 ELSE 1 END,
                 knowledge_base.updated_at DESC, knowledge_base.id`,
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
      .json(await Promise.all(matches.slice(page.offset, page.offset + page.limit)
        .map(article => documentSummary(article, uploadDir()))));
  } catch (error) {
    next(error);
  }
});

async function readDocument(req, res, next) {
  if (!uuid(req.params.id) || Object.keys(req.query).length) return invalid(req, res);
  try {
    const { rows } = await pool.query('SELECT id, document FROM knowledge_base WHERE id=$1', [req.params.id]);
    if (!rows[0] || rows[0].document?.kind !== 'pdf') {
      return res.status(404).json({ error: 'Documento indisponível.', requestId: req.id });
    }
    const descriptor = rows[0].document;
    res.set('Cache-Control', 'private, no-store');
    if (req.params.number !== undefined || req.path.endsWith('/cover')) {
      const bytes = await documentImage(uploadDir(), descriptor, req.params.number ?? 'cover');
      return res.type('image/webp').set('X-Content-Type-Options', 'nosniff').send(bytes);
    }
    const manifest = await loadDocument(uploadDir(), descriptor);
    const base = `/api/knowledge/${req.params.id}/document`;
    return res.json({ pageCount: manifest.pages.length, sourceUrl: manifest.source.url,
      pages: manifest.pages.map(({ number, width, height, text }) => ({
        number, width, height, text, url: `${base}/pages/${number}`,
      })) });
  } catch (error) {
    if (error.status === 404) return res.status(404).json({ error: 'Documento indisponível.', requestId: req.id });
    return next(error);
  }
}
router.get('/:id/document', authMiddleware, readDocument);
router.get('/:id/document/cover', authMiddleware, readDocument);
router.get('/:id/document/pages/:number', authMiddleware, readDocument);

router.get('/:id', authMiddleware, async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const { rows } = await pool.query('SELECT * FROM knowledge_base WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Article not found.', requestId: req.id });
    res.json(await documentSummary(rows[0], uploadDir()));
  } catch (error) {
    next(error);
  }
});

router.post('/', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageKnowledge')) return forbidden(req, res);
  if (hasLegacyPdfFields(req.body)) return invalid(req, res);
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
    res.status(201).json(await documentSummary(result.row, uploadDir()));
  } catch (error) { next(error); }
});

router.put('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageKnowledge')) return forbidden(req, res);
  if (hasLegacyPdfFields(req.body)) return invalid(req, res);
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
    res.json(await documentSummary(result.row, uploadDir()));
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
