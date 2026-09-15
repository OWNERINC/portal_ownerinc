const { blocksToText, validateBlocks } = require('./blocks');
const { lockCmsAssets } = require('./locks');

const CONTENT_TYPES = new Set(['knowledge', 'academy', 'benefit', 'announcement', 'reminder']);
const ASSET_MIMES = {
  image: new Set(['image/jpeg', 'image/png', 'image/webp']),
  pdf: new Set(['application/pdf']),
  video: new Set(['video/mp4', 'video/webm', 'video/quicktime']),
};

async function validatePublishedBlocks(db, value) {
  const blocks = validateBlocks(value);
  if (!blocks) return { blocks: null, reason: 'invalid_blocks' };

  const references = new Map();
  for (const block of blocks) {
    if (!ASSET_MIMES[block.type] || !block.asset_id) continue;
    const types = references.get(block.asset_id) || new Set();
    types.add(block.type);
    references.set(block.asset_id, types);
  }
  if (!references.size) return { blocks, reason: null };

  const { rows } = await db.query(
    `SELECT id, mime_type, storage_key, byte_size, deleting_at
       FROM cms_assets
      WHERE id = ANY($1::uuid[])
        AND storage_key IS NOT NULL
        AND deleting_at IS NULL
        AND byte_size BETWEEN 1 AND 52428800`,
    [[...references.keys()]],
  );
  const assets = new Map(rows.map((asset) => [String(asset.id), asset]));
  for (const [assetId, types] of references) {
    const asset = assets.get(String(assetId));
    if (!asset || [...types].some((type) => !ASSET_MIMES[type].has(asset.mime_type))) {
      return { blocks: null, reason: 'invalid_assets' };
    }
  }
  return { blocks, reason: null };
}

async function promoteDocument(db, document, now) {
  if (document.published_revision_id) {
    await db.query(
      "UPDATE cms_revisions SET status = 'archived' WHERE id = $1 AND status = 'published'",
      [document.published_revision_id],
    );
  }
  await db.query(
    "UPDATE cms_revisions SET status = 'published' WHERE id = $1 AND status = 'scheduled'",
    [document.scheduled_revision_id],
  );
  await db.query(
    `UPDATE cms_documents
        SET published_revision_id = $2, published_at = $3,
            scheduled_revision_id = NULL, scheduled_at = NULL, updated_at = NOW()
      WHERE id = $1`,
    [document.id, document.scheduled_revision_id, now],
  );
  await db.query(
    `INSERT INTO audit_log (actor_uid, action, target_type, target_id, details)
     VALUES (NULL, 'cms.document.promote', 'cms_document', $1, $2::jsonb)`,
    [document.id, JSON.stringify({ revisionId: document.scheduled_revision_id })],
  );
}

async function retireInvalidScheduled(db, document, reason) {
  await db.query(
    "UPDATE cms_revisions SET status = 'archived' WHERE id = $1 AND status = 'scheduled'",
    [document.scheduled_revision_id],
  );
  await db.query(
    `UPDATE cms_documents
        SET scheduled_revision_id = NULL, scheduled_at = NULL, updated_at = NOW()
      WHERE id = $1 AND scheduled_revision_id = $2`,
    [document.id, document.scheduled_revision_id],
  );
  await db.query(
    `INSERT INTO audit_log (actor_uid, action, target_type, target_id, details)
     VALUES (NULL, 'cms.document.schedule_invalid', 'cms_document', $1, $2::jsonb)`,
    [document.id, JSON.stringify({ revisionId: document.scheduled_revision_id, reason })],
  );
}

async function promoteDueScheduled(db, now = new Date(), contentType = null, sourceIds = null) {
  await lockCmsAssets(db);
  const values = [now];
  const conditions = ["scheduled.status = 'scheduled'", 'd.scheduled_at <= $1'];
  if (contentType) {
    values.push(contentType);
    conditions.push(`d.content_type = $${values.length}`);
  }
  if (sourceIds) {
    values.push(sourceIds);
    conditions.push(`d.source_id = ANY($${values.length}::uuid[])`);
  }
  const { rows } = await db.query(
    `SELECT d.id, d.published_revision_id, d.scheduled_revision_id
             , scheduled.blocks AS scheduled_blocks
       FROM cms_documents d
       JOIN cms_revisions scheduled ON scheduled.id = d.scheduled_revision_id
      WHERE ${conditions.join(' AND ')}
      FOR UPDATE OF d, scheduled`,
    values,
  );
  let promoted = 0;
  for (const document of rows) {
    const validation = await validatePublishedBlocks(db, document.scheduled_blocks);
    if (validation.reason) await retireInvalidScheduled(db, document, validation.reason);
    else {
      await promoteDocument(db, document, now);
      promoted += 1;
    }
  }
  return promoted;
}

async function withTransaction(pool, operation) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await operation(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

async function getPublishedBlocksBatch(pool, contentType, sourceIds) {
  const ids = [...new Set(sourceIds.filter(Boolean).map(String))];
  if (!CONTENT_TYPES.has(contentType) || !ids.length) return new Map();
  return withTransaction(pool, async (db) => {
    await promoteDueScheduled(db, new Date(), contentType, ids);
    const { rows } = await db.query(
      `SELECT d.source_id, r.blocks, d.id AS document_id
          FROM cms_documents d
          LEFT JOIN cms_revisions r
            ON r.id = d.published_revision_id AND r.status = 'published'
         WHERE d.content_type = $1
           AND d.source_id = ANY($2::uuid[])
      `,
      [contentType, ids],
    );
    const entries = [];
    for (const row of rows) {
      const validation = await validatePublishedBlocks(db, row.blocks);
      entries.push([String(row.source_id), validation.blocks]);
    }
    return new Map(entries);
  });
}

async function promoteDueScheduledForPool(pool, now = new Date(), contentType = null) {
  return withTransaction(pool, (db) => promoteDueScheduled(db, now, contentType));
}

const LEGACY_BODY_FIELDS = {
  knowledge: ['content'],
  academy: ['description'],
  benefit: ['description', 'instructions'],
  reminder: ['description'],
};

function cmsManagedRow(row, contentType, blocks) {
  const next = { ...row, cms_managed: true };
  for (const field of LEGACY_BODY_FIELDS[contentType] || []) {
    if (Object.prototype.hasOwnProperty.call(next, field)) next[field] = '';
  }
  if (blocks !== null) next.content_blocks = blocks;
  return next;
}

function isPublicCmsRow(row) {
  return row?.cms_managed !== true
    || Object.prototype.hasOwnProperty.call(row, 'content_blocks');
}

async function addPublishedBlocks(pool, rows, contentType) {
  const blocksBySourceId = await getPublishedBlocksBatch(pool, contentType, rows.map((row) => row.id));
  return rows.map((row) => {
    const sourceId = String(row.id);
    return blocksBySourceId.has(sourceId)
      ? cmsManagedRow(row, contentType, blocksBySourceId.get(sourceId))
      : row;
  });
}

function publishedBodyText(row, legacyField = 'content') {
  if (row?.cms_managed) return blocksToText(row.content_blocks);
  return typeof row?.[legacyField] === 'string' ? row[legacyField] : '';
}

async function listPublishedAnnouncements(pool, limit, offset) {
  return withTransaction(pool, async (db) => {
    await promoteDueScheduled(db);
    const { rows } = await db.query(
      `SELECT d.id, d.title, d.category, d.published_at, r.blocks
         FROM cms_documents d
         JOIN cms_revisions r
           ON r.id = d.published_revision_id AND r.status = 'published'
        WHERE d.content_type = 'announcement'
        ORDER BY d.published_at DESC NULLS LAST, d.updated_at DESC, d.id`,
    );
    const visible = [];
    for (const row of rows) {
      const validation = await validatePublishedBlocks(db, row.blocks);
      if (validation.blocks !== null) visible.push({ ...row, blocks: validation.blocks });
    }
    return {
      count: visible.length,
      rows: visible.slice(offset, offset + limit).map(({ blocks, ...row }) => ({ ...row, content_blocks: blocks })),
    };
  });
}

async function getPublishedAnnouncement(pool, id) {
  return withTransaction(pool, async (db) => {
    await promoteDueScheduled(db);
    const { rows } = await db.query(
      `SELECT d.id, d.title, d.category, d.published_at, r.blocks
         FROM cms_documents d
         JOIN cms_revisions r
           ON r.id = d.published_revision_id AND r.status = 'published'
        WHERE d.id = $1 AND d.content_type = 'announcement'`,
      [id],
    );
    const row = rows[0];
    if (!row) return null;
    const validation = await validatePublishedBlocks(db, row.blocks);
    if (validation.blocks === null) return null;
    const { blocks, ...announcement } = row;
    return { ...announcement, content_blocks: validation.blocks };
  });
}

module.exports = {
  addPublishedBlocks,
  cmsManagedRow,
  getPublishedAnnouncement,
  blocksToText,
  getPublishedBlocksBatch,
  isPublicCmsRow,
  listPublishedAnnouncements,
  publishedBodyText,
  promoteDueScheduled,
  promoteDueScheduledForPool,
  validatePublishedBlocks,
};
