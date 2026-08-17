const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { canManageCms } = require('../cms/permissions');
const { validateBlocks } = require('../cms/blocks');
const {
  forbidden, invalid, oneOf, parseListQuery, text, uuid, validBody, withAudit,
} = require('../route-utils');

const router = express.Router();
const CONTENT_TYPES = ['knowledge', 'academy', 'benefit', 'announcement', 'reminder'];
const REVISION_STATUSES = ['draft', 'published', 'scheduled', 'archived'];
const SOURCE_TABLES = {
  knowledge: 'knowledge_base',
  academy: 'academy',
  benefit: 'benefits',
  reminder: 'reminders',
};
const ASSET_MIMES = {
  image: new Set(['image/jpeg', 'image/png', 'image/webp']),
  pdf: new Set(['application/pdf']),
  video: new Set(['video/mp4', 'video/webm', 'video/quicktime']),
};

class CmsRouteError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function manageableTypes(user) {
  return CONTENT_TYPES.filter((type) => canManageCms(user, type));
}

function documentBody(value) {
  return validBody(value, {
    type: oneOf(...CONTENT_TYPES),
    title: text(200, true),
    category: text(100),
    source_id: (sourceId) => sourceId === undefined || uuid(sourceId),
  }, ['type', 'title']);
}

function revisionBody(value) {
  return validBody(value, { blocks: (blocks) => validateBlocks(blocks) !== null }, ['blocks']);
}

function emptyBody(value) {
  return value === undefined
    || (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
}

function futureIso(value) {
  if (typeof value !== 'string' || !value.includes('T') || !/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function publishBody(value) {
  return value === undefined
    || validBody(value, { revision_id: (revisionId) => revisionId === undefined || uuid(revisionId) });
}

function scheduleBody(value) {
  return validBody(value, {
    revision_id: (revisionId) => revisionId === undefined || uuid(revisionId),
    scheduled_at: futureIso,
  }, ['scheduled_at']);
}

async function findDocument(db, user, id, forUpdate = false) {
  const types = manageableTypes(user);
  if (!types.length) return null;
  const lock = forUpdate ? ' FOR UPDATE' : '';
  const { rows } = await db.query(
    `SELECT id, content_type, source_id, title, category, published_revision_id,
            draft_revision_id, scheduled_revision_id, scheduled_at, published_at,
            created_by, updated_by, created_at, updated_at
       FROM cms_documents
      WHERE id = $1 AND content_type = ANY($2::text[])${lock}`,
    [id, types],
  );
  return rows[0] || null;
}

async function documentView(db, document) {
  const revisionIds = [
    document.draft_revision_id,
    document.published_revision_id,
    document.scheduled_revision_id,
  ].filter(Boolean);
  const { rows } = revisionIds.length ? await db.query(
    `SELECT id, document_id, version, status, blocks, created_by, created_at
       FROM cms_revisions
      WHERE document_id = $1 AND id = ANY($2::uuid[])`,
    [document.id, revisionIds],
  ) : { rows: [] };
  const revisions = new Map(rows.map((revision) => [revision.id, revision]));
  const draft = revisions.get(document.draft_revision_id) || null;
  const published = revisions.get(document.published_revision_id) || null;
  const scheduled = revisions.get(document.scheduled_revision_id) || null;
  return {
    document,
    draft,
    published,
    schedule: document.scheduled_revision_id ? {
      revision_id: document.scheduled_revision_id,
      scheduled_at: document.scheduled_at,
      revision: scheduled,
    } : null,
  };
}

async function validateAssetReferences(db, blocks) {
  const references = new Map();
  for (const block of blocks) {
    if (!ASSET_MIMES[block.type] || !block.asset_id) continue;
    const types = references.get(block.asset_id) || new Set();
    types.add(block.type);
    references.set(block.asset_id, types);
  }
  if (!references.size) return;

  const { rows } = await db.query(
    `SELECT id, mime_type, storage_key, byte_size
       FROM cms_assets
      WHERE id = ANY($1::uuid[])
        AND storage_key IS NOT NULL
        AND byte_size BETWEEN 1 AND 52428800`,
    [[...references.keys()]],
  );
  const assets = new Map(rows.map((asset) => [asset.id, asset]));
  for (const [assetId, types] of references) {
    const asset = assets.get(assetId);
    if (!asset || [...types].some((type) => !ASSET_MIMES[type].has(asset.mime_type))) {
      throw new CmsRouteError(400, 'asset_invalid');
    }
  }
}

function sendCmsError(error, req, res, next) {
  if (!(error instanceof CmsRouteError)) return next(error);
  if (error.status === 404) return res.status(404).json({ error: 'CMS document not found.', requestId: req.id });
  if (error.status === 409) return res.status(409).json({ error: 'CMS revision cannot be changed.', requestId: req.id });
  return invalid(req, res);
}

router.get('/documents', authMiddleware, async (req, res, next) => {
  const page = parseListQuery(req.query, {
    type: oneOf(...CONTENT_TYPES),
    status: oneOf(...REVISION_STATUSES),
    source_id: (sourceId) => uuid(sourceId),
  });
  if (!page) return invalid(req, res);

  const types = manageableTypes(req.user);
  if (!types.length) return res.json([]);
  const values = [types];
  const conditions = ['content_type = ANY($1::text[])'];
  if (req.query.type) {
    values.push(req.query.type);
    conditions.push(`content_type = $${values.length}`);
  }
  if (req.query.status) {
    values.push(req.query.status);
    const position = values.length;
    conditions.push(`(
      ($${position} = 'draft' AND draft_revision_id IS NOT NULL)
      OR ($${position} = 'published' AND published_revision_id IS NOT NULL)
      OR ($${position} = 'scheduled' AND scheduled_revision_id IS NOT NULL)
      OR ($${position} = 'archived' AND EXISTS (
        SELECT 1 FROM cms_revisions archived_revision
         WHERE archived_revision.document_id = cms_documents.id
           AND archived_revision.status = 'archived'
      ))
    )`);
  }
  if (req.query.source_id) {
    values.push(req.query.source_id);
    conditions.push(`source_id = $${values.length}`);
  }
  values.push(page.limit, page.offset);
  try {
    const filterValues = values.slice(0, -2);
    const [{ rows: [{ count }] }, { rows }] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::integer AS count
           FROM cms_documents
          WHERE ${conditions.join(' AND ')}`,
        filterValues,
      ),
      pool.query(
        `SELECT id, content_type, source_id, title, category, published_revision_id,
                draft_revision_id, scheduled_revision_id, scheduled_at, published_at,
                created_by, updated_by, created_at, updated_at
           FROM cms_documents
          WHERE ${conditions.join(' AND ')}
          ORDER BY updated_at DESC, id
          LIMIT $${values.length - 1} OFFSET $${values.length}`,
        values,
      ),
    ]);
    res.set('X-Total-Count', String(count)).json(rows);
  } catch (error) {
    next(error);
  }
});

router.post('/documents', authMiddleware, async (req, res, next) => {
  if (!documentBody(req.body)) return invalid(req, res);
  if (!canManageCms(req.user, req.body.type)) return forbidden(req, res);
  const sourceId = req.body.source_id;
  if (req.body.type !== 'announcement' && !sourceId) return invalid(req, res);

  try {
    const result = await withAudit(pool, req, 'cms.document.create', 'cms_document', async (db) => {
      const sourceTable = SOURCE_TABLES[req.body.type];
      if (sourceTable) {
        const source = await db.query(`SELECT id FROM ${sourceTable} WHERE id = $1`, [sourceId]);
        if (!source.rows[0]) throw new CmsRouteError(404, 'source_not_found');
      }
      const { rows: documents } = await db.query(
        `INSERT INTO cms_documents (content_type, source_id, title, category, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $5)
         RETURNING id, content_type, source_id, title, category, published_revision_id,
                   draft_revision_id, scheduled_revision_id, scheduled_at, published_at,
                   created_by, updated_by, created_at, updated_at`,
        [req.body.type, sourceId || null, req.body.title.trim(), req.body.category || '', req.user.uid],
      );
      const document = documents[0];
      const { rows: revisions } = await db.query(
        `INSERT INTO cms_revisions (document_id, version, status, blocks, created_by)
         VALUES ($1, 1, 'draft', $2::jsonb, $3)
         RETURNING id, document_id, version, status, blocks, created_by, created_at`,
        [document.id, JSON.stringify([]), req.user.uid],
      );
      const { rows: updated } = await db.query(
        `UPDATE cms_documents SET draft_revision_id = $2, updated_at = NOW()
          WHERE id = $1
          RETURNING id, content_type, source_id, title, category, published_revision_id,
                    draft_revision_id, scheduled_revision_id, scheduled_at, published_at,
                    created_by, updated_by, created_at, updated_at`,
        [document.id, revisions[0].id],
      );
      return { document: updated[0], revision: revisions[0] };
    }, { targetId: (result) => result.document.id });
    res.status(201).json(result);
  } catch (error) {
    sendCmsError(error, req, res, next);
  }
});

router.get('/documents/:id', authMiddleware, async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const document = await findDocument(pool, req.user, req.params.id);
    if (!document) return res.status(404).json({ error: 'CMS document not found.', requestId: req.id });
    res.json(await documentView(pool, document));
  } catch (error) {
    next(error);
  }
});

router.put('/documents/:id/draft', authMiddleware, async (req, res, next) => {
  if (!uuid(req.params.id) || !revisionBody(req.body)) return invalid(req, res);
  const blocks = validateBlocks(req.body.blocks);
  try {
    const result = await withAudit(pool, req, 'cms.revision.draft', 'cms_revision', async (db) => {
      const document = await findDocument(db, req.user, req.params.id, true);
      if (!document) return null;
      await validateAssetReferences(db, blocks);
      const { rows: versions } = await db.query(
        'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM cms_revisions WHERE document_id = $1',
        [document.id],
      );
      const { rows } = await db.query(
        `INSERT INTO cms_revisions (document_id, version, status, blocks, created_by)
         VALUES ($1, $2, 'draft', $3::jsonb, $4)
         RETURNING id, document_id, version, status, blocks, created_by, created_at`,
        [document.id, versions[0].version, JSON.stringify(blocks), req.user.uid],
      );
      await db.query(
        `UPDATE cms_documents SET draft_revision_id = $2, updated_by = $3, updated_at = NOW()
          WHERE id = $1`,
        [document.id, rows[0].id, req.user.uid],
      );
      return { documentId: document.id, revision: rows[0] };
    }, { targetId: (result) => result.revision.id });
    if (!result) return res.status(404).json({ error: 'CMS document not found.', requestId: req.id });
    res.json({ document: await findDocument(pool, req.user, result.documentId), revision: result.revision });
  } catch (error) {
    sendCmsError(error, req, res, next);
  }
});

router.post('/documents/:id/publish', authMiddleware, async (req, res, next) => {
  if (!uuid(req.params.id) || !publishBody(req.body)) return invalid(req, res);
  try {
    const result = await withAudit(pool, req, 'cms.document.publish', 'cms_document', async (db) => {
      const document = await findDocument(db, req.user, req.params.id, true);
      if (!document) return null;
      const revisionId = req.body.revision_id || document.draft_revision_id;
      const { rows: revisions } = await db.query(
        `SELECT id, document_id, version, status, blocks, created_by, created_at
           FROM cms_revisions
          WHERE id = $1 AND document_id = $2
          FOR UPDATE`,
        [revisionId, document.id],
      );
      const revision = revisions[0];
      if (!revision || revision.status !== 'draft') throw new CmsRouteError(409, 'draft_required');
      if (document.published_revision_id) {
        await db.query("UPDATE cms_revisions SET status = 'archived' WHERE id = $1", [document.published_revision_id]);
      }
      if (document.scheduled_revision_id && document.scheduled_revision_id !== revision.id) {
        await db.query("UPDATE cms_revisions SET status = 'archived' WHERE id = $1 AND status = 'scheduled'", [document.scheduled_revision_id]);
      }
      await db.query("UPDATE cms_revisions SET status = 'published' WHERE id = $1", [revision.id]);
      revision.status = 'published';
      const { rows: documents } = await db.query(
        `UPDATE cms_documents
            SET published_revision_id = $2, published_at = NOW(), draft_revision_id = NULL,
                scheduled_revision_id = NULL, scheduled_at = NULL, updated_by = $3, updated_at = NOW()
          WHERE id = $1
          RETURNING id, content_type, source_id, title, category, published_revision_id,
                    draft_revision_id, scheduled_revision_id, scheduled_at, published_at,
                    created_by, updated_by, created_at, updated_at`,
        [document.id, revision.id, req.user.uid],
      );
      return { document: documents[0], revision };
    }, { targetId: req.params.id });
    if (!result) return res.status(404).json({ error: 'CMS document not found.', requestId: req.id });
    res.json(result);
  } catch (error) {
    sendCmsError(error, req, res, next);
  }
});

router.post('/documents/:id/schedule', authMiddleware, async (req, res, next) => {
  if (!uuid(req.params.id) || !scheduleBody(req.body)) return invalid(req, res);
  try {
    const result = await withAudit(pool, req, 'cms.document.schedule', 'cms_document', async (db) => {
      const document = await findDocument(db, req.user, req.params.id, true);
      if (!document) return null;
      const revisionId = req.body.revision_id || document.draft_revision_id;
      const { rows: revisions } = await db.query(
        `SELECT id, document_id, version, status, blocks, created_by, created_at
           FROM cms_revisions
          WHERE id = $1 AND document_id = $2
          FOR UPDATE`,
        [revisionId, document.id],
      );
      const revision = revisions[0];
      if (!revision || revision.status !== 'draft') throw new CmsRouteError(409, 'draft_required');
      if (document.scheduled_revision_id && document.scheduled_revision_id !== revision.id) {
        await db.query("UPDATE cms_revisions SET status = 'archived' WHERE id = $1 AND status = 'scheduled'", [document.scheduled_revision_id]);
      }
      await db.query("UPDATE cms_revisions SET status = 'scheduled' WHERE id = $1", [revision.id]);
      revision.status = 'scheduled';
      const { rows: documents } = await db.query(
        `UPDATE cms_documents
            SET scheduled_revision_id = $2, scheduled_at = $3, draft_revision_id = NULL,
                updated_by = $4, updated_at = NOW()
          WHERE id = $1
          RETURNING id, content_type, source_id, title, category, published_revision_id,
                    draft_revision_id, scheduled_revision_id, scheduled_at, published_at,
                    created_by, updated_by, created_at, updated_at`,
        [document.id, revision.id, new Date(req.body.scheduled_at).toISOString(), req.user.uid],
      );
      return { document: documents[0], revision };
    }, { targetId: req.params.id, details: { scheduled: true } });
    if (!result) return res.status(404).json({ error: 'CMS document not found.', requestId: req.id });
    res.json(result);
  } catch (error) {
    sendCmsError(error, req, res, next);
  }
});

router.post('/documents/:id/unpublish', authMiddleware, async (req, res, next) => {
  if (!uuid(req.params.id) || !emptyBody(req.body)) return invalid(req, res);
  try {
    const result = await withAudit(pool, req, 'cms.document.unpublish', 'cms_document', async (db) => {
      const document = await findDocument(db, req.user, req.params.id, true);
      if (!document) return null;
      if (!document.published_revision_id) throw new CmsRouteError(409, 'not_published');
      await db.query("UPDATE cms_revisions SET status = 'archived' WHERE id = $1", [document.published_revision_id]);
      const { rows } = await db.query(
        `UPDATE cms_documents
            SET published_revision_id = NULL, published_at = NULL, updated_by = $2, updated_at = NOW()
          WHERE id = $1
          RETURNING id, content_type, source_id, title, category, published_revision_id,
                    draft_revision_id, scheduled_revision_id, scheduled_at, published_at,
                    created_by, updated_by, created_at, updated_at`,
        [document.id, req.user.uid],
      );
      return rows[0];
    }, { targetId: req.params.id });
    if (!result) return res.status(404).json({ error: 'CMS document not found.', requestId: req.id });
    res.json({ document: result });
  } catch (error) {
    sendCmsError(error, req, res, next);
  }
});

router.delete('/documents/:id/schedule', authMiddleware, async (req, res, next) => {
  if (!uuid(req.params.id) || !emptyBody(req.body)) return invalid(req, res);
  try {
    const result = await withAudit(pool, req, 'cms.document.unschedule', 'cms_document', async (db) => {
      const document = await findDocument(db, req.user, req.params.id, true);
      if (!document) return null;
      if (!document.scheduled_revision_id) throw new CmsRouteError(409, 'not_scheduled');
      await db.query("UPDATE cms_revisions SET status = 'draft' WHERE id = $1 AND status = 'scheduled'", [document.scheduled_revision_id]);
      const { rows } = await db.query(
        `UPDATE cms_documents
            SET scheduled_revision_id = NULL, scheduled_at = NULL, draft_revision_id = $2,
                updated_by = $3, updated_at = NOW()
          WHERE id = $1
          RETURNING id, content_type, source_id, title, category, published_revision_id,
                    draft_revision_id, scheduled_revision_id, scheduled_at, published_at,
                    created_by, updated_by, created_at, updated_at`,
        [document.id, document.scheduled_revision_id, req.user.uid],
      );
      return rows[0];
    }, { targetId: req.params.id });
    if (!result) return res.status(404).json({ error: 'CMS document not found.', requestId: req.id });
    res.json({ document: result });
  } catch (error) {
    sendCmsError(error, req, res, next);
  }
});

router.delete('/revisions/:id', authMiddleware, async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const result = await withAudit(pool, req, 'cms.revision.delete', 'cms_revision', async (db) => {
      const types = manageableTypes(req.user);
      if (!types.length) return null;
      const { rows } = await db.query(
        `SELECT r.id, r.document_id, r.status, d.content_type
           FROM cms_revisions r
           JOIN cms_documents d ON d.id = r.document_id
          WHERE r.id = $1 AND d.content_type = ANY($2::text[])
          FOR UPDATE OF r, d`,
        [req.params.id, types],
      );
      const revision = rows[0];
      if (!revision) return null;
      if (revision.status !== 'draft') throw new CmsRouteError(409, 'draft_only');
      const { rows: deleted } = await db.query(
        "DELETE FROM cms_revisions WHERE id = $1 AND status = 'draft' RETURNING id, document_id",
        [revision.id],
      );
      await db.query(
        'UPDATE cms_documents SET draft_revision_id = NULL, updated_at = NOW() WHERE id = $1 AND draft_revision_id = $2',
        [revision.document_id, revision.id],
      );
      return deleted[0];
    }, { targetId: req.params.id });
    if (!result) return res.status(404).json({ error: 'CMS revision not found.', requestId: req.id });
    res.json({ success: true, id: result.id });
  } catch (error) {
    sendCmsError(error, req, res, next);
  }
});

module.exports = router;
