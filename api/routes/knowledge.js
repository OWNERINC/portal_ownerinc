const express = require('express');
const pool = require('../db');
const { addPublishedBlocks } = require('../cms/reader');
const { KnowledgePdfError, syncKnowledgePdf } = require('../cms/knowledge');
const { authMiddleware, can } = require('../middleware/auth');
const {
  forbidden, invalid, parseListQuery, text, uuid, validBody, withAudit,
} = require('../route-utils');

const router = express.Router();
const schema = {
  title: text(200, true),
  category: text(100),
  content: text(50000),
  pdf_asset_id: value => value === undefined || value === null || uuid(value),
  pdf_title: value => value === undefined || text(200, true)(value),
};
const listQuery = {
  q: value => value.length <= 120,
  category: value => value.length <= 100,
};

function pdfChange(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'pdf_asset_id')) return undefined;
  if (body.pdf_asset_id === null) return null;
  if (!body.pdf_title) throw new KnowledgePdfError('PDF title is required.');
  return { assetId: body.pdf_asset_id, title: body.pdf_title.trim() };
}

router.get('/categories', authMiddleware, async (req, res, next) => {
  if (Object.keys(req.query).length) return invalid(req, res);
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT btrim(category) AS category
       FROM knowledge_base
       WHERE btrim(category) <> ''
       ORDER BY category`,
    );
    res.json(rows.map(({ category }) => category));
  } catch (error) {
    next(error);
  }
});

router.get('/', authMiddleware, async (req, res, next) => {
  const page = parseListQuery(req.query, listQuery);
  if (!page) return invalid(req, res);
  const values = [];
  const conditions = [];
  if (req.query.q) {
    values.push(`%${req.query.q.replace(/[\\%_]/g, '\\$&')}%`);
    conditions.push(`(title ILIKE $${values.length} ESCAPE '\\' OR content ILIKE $${values.length} ESCAPE '\\')`);
  }
  if (req.query.category) {
    values.push(req.query.category);
    conditions.push(`category = $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    const [{ rows: [{ count }] }, { rows }] = await Promise.all([
      pool.query(`SELECT COUNT(*)::integer AS count FROM knowledge_base ${where}`, values),
      pool.query(`SELECT * FROM knowledge_base ${where} ORDER BY updated_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, page.limit, page.offset]),
    ]);
    res.set('X-Total-Count', String(count)).json(await addPublishedBlocks(pool, rows, 'knowledge'));
  } catch (error) {
    next(error);
  }
});

router.get('/:id', authMiddleware, async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const { rows } = await pool.query('SELECT * FROM knowledge_base WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Article not found.', requestId: req.id });
    const [row] = await addPublishedBlocks(pool, [rows[0]], 'knowledge');
    res.json(row);
  } catch (error) {
    next(error);
  }
});

router.post('/', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageKnowledge')) return forbidden(req, res);
  if (!validBody(req.body, schema, ['title'])) return invalid(req, res);
  try {
    const { title, category = '', content = '' } = req.body;
    const pdf = pdfChange(req.body);
    const result = await withAudit(pool, req, 'knowledge.create', 'knowledge', async (db) => {
      const { rows } = await db.query(
        `INSERT INTO knowledge_base (title, category, content, created_by)
          VALUES ($1, $2, $3, $4) RETURNING *`,
        [title.trim(), category, content, req.user.uid]
      );
      const cms = await syncKnowledgePdf(db, {
        sourceId: rows[0].id,
        title: title.trim(),
        category,
        content,
        pdf,
        actorUid: req.user.uid,
      });
      return { row: rows[0], cms };
    }, {
      targetId: (result) => result.row.id,
      details: (result) => result.cms ? {
        cms_document_id: result.cms.documentId,
        cms_revision_id: result.cms.revisionId,
        pdf_asset_id: result.cms.pdfAssetId,
        pdf_changed: result.cms.pdfChanged,
      } : {},
    });
    res.status(201).json(result.row);
  } catch (error) {
    if (error instanceof KnowledgePdfError) return invalid(req, res);
    next(error);
  }
});

router.put('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageKnowledge')) return forbidden(req, res);
  if (!uuid(req.params.id) || !validBody(req.body, schema, ['title', 'category', 'content'])) return invalid(req, res);
  try {
    const pdf = pdfChange(req.body);
    const result = await withAudit(pool, req, 'knowledge.update', 'knowledge', async (db) => {
      const { rows } = await db.query(
        `UPDATE knowledge_base SET title=$2, category=$3, content=$4, updated_at=NOW()
          WHERE id=$1 RETURNING *`,
        [req.params.id, req.body.title.trim(), req.body.category, req.body.content]
      );
      if (!rows[0]) return null;
      const cms = await syncKnowledgePdf(db, {
        sourceId: rows[0].id,
        title: rows[0].title,
        category: rows[0].category,
        content: rows[0].content,
        pdf,
        actorUid: req.user.uid,
      });
      return { row: rows[0], cms };
    }, {
      targetId: req.params.id,
      details: (result) => result.cms ? {
        cms_document_id: result.cms.documentId,
        cms_revision_id: result.cms.revisionId,
        pdf_asset_id: result.cms.pdfAssetId,
        pdf_changed: result.cms.pdfChanged,
      } : {},
    });
    if (!result.row) return res.status(404).json({ error: 'Article not found.', requestId: req.id });
    res.json(result.row);
  } catch (error) {
    if (error instanceof KnowledgePdfError) return invalid(req, res);
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
