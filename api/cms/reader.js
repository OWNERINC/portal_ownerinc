const { blocksToText, validateBlocks } = require('./blocks');
const { lockCmsAssets } = require('./locks');

const CONTENT_TYPES = new Set(['knowledge', 'academy', 'benefit', 'announcement', 'reminder']);
const SOURCE_TABLES = {
  knowledge: 'knowledge_base',
  academy: 'academy',
  benefit: 'benefits',
  reminder: 'reminders',
};
const SOURCE_ACTIVE_COLUMNS = {
  academy: 's.active',
  benefit: 's.active',
  reminder: 's.active',
};
const SOURCE_STATES = {
  missing: Symbol('missing_source'),
  legacy: Symbol('legacy_source'),
  inactive: Symbol('inactive_source'),
};
const ASSET_MIMES = {
  image: new Set(['image/jpeg', 'image/png', 'image/webp']),
  pdf: new Set(['application/pdf']),
  video: new Set(['video/mp4', 'video/webm', 'video/quicktime']),
};

function assetReferences(blocks) {
  const references = new Map();
  for (const block of blocks) {
    if (!ASSET_MIMES[block.type] || !block.asset_id) continue;
    const types = references.get(block.asset_id) || new Set();
    types.add(block.type);
    references.set(block.asset_id, types);
  }
  return references;
}

async function validatePublishedBlocksBatch(db, values) {
  const normalized = values.map(value => {
    const blocks = validateBlocks(value);
    return { blocks, reason: blocks ? null : 'invalid_blocks' };
  });
  const referencesByValue = normalized.map(({ blocks }) => blocks ? assetReferences(blocks) : new Map());
  const references = new Map();
  referencesByValue.forEach(valueReferences => {
    for (const [assetId, types] of valueReferences) {
      const existing = references.get(assetId) || new Set();
      for (const type of types) existing.add(type);
      references.set(assetId, existing);
    }
  });
  if (!references.size) return normalized;

  const { rows } = await db.query(
    `SELECT id, mime_type, storage_key, byte_size, deleting_at
       FROM cms_assets
      WHERE id = ANY($1::uuid[])
        AND storage_key IS NOT NULL
        AND deleting_at IS NULL
        AND byte_size BETWEEN 1 AND 52428800`,
    [[...references.keys()]],
  );
  const assets = new Map(rows.map((asset) => [String(asset.id).toLowerCase(), asset]));
  referencesByValue.forEach((valueReferences, index) => {
    if (normalized[index].reason) return;
    for (const [assetId, types] of valueReferences) {
      const asset = assets.get(String(assetId).toLowerCase());
      if (!asset || [...types].some((type) => !ASSET_MIMES[type].has(asset.mime_type))) {
        normalized[index] = { blocks: null, reason: 'invalid_assets' };
        break;
      }
    }
  });
  return normalized;
}

async function validatePublishedBlocks(db, value) {
  return (await validatePublishedBlocksBatch(db, [value]))[0];
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
  const validations = await validatePublishedBlocksBatch(db, rows.map(document => document.scheduled_blocks));
  let promoted = 0;
  for (const [index, document] of rows.entries()) {
    const validation = validations[index];
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

async function recheckPublishedAnnouncements(pool, snapshots) {
  const ids = [...new Set(snapshots.map(({ id }) => String(id).toLowerCase()))];
  if (!ids.length) return new Set();
  return withTransaction(pool, async (db) => {
    await lockCmsAssets(db);
    const { rows } = await db.query(
      `SELECT d.id, r.id AS published_revision_id
         FROM cms_documents d
         JOIN cms_revisions r
           ON r.id = d.published_revision_id AND r.status = 'published'
        WHERE d.content_type = 'announcement' AND d.id = ANY($1::uuid[])
        FOR UPDATE OF d, r`,
      [ids],
    );
    const current = new Map(rows.map(row => [String(row.id).toLowerCase(),
      String(row.published_revision_id).toLowerCase()]));
    return new Set(snapshots
      .filter(({ id, publishedRevisionId }) => current.get(String(id).toLowerCase()) === publishedRevisionId)
      .map(({ id }) => String(id).toLowerCase()));
  });
}

async function getPublishedBlocksBatch(pool, contentType, sourceIds) {
  const ids = [...new Set(sourceIds.filter(Boolean).map(value => String(value).toLowerCase()))];
  if (!CONTENT_TYPES.has(contentType) || !ids.length) return new Map();
  await promoteDueScheduledForPool(pool, new Date(), contentType, ids);
  const snapshots = new Map(ids.map(sourceId => [sourceId, {
    sourceExists: false, documentId: null, publishedRevisionId: null,
  }]));
  const entries = await withTransaction(pool, async (db) => {
    const sourceTable = SOURCE_TABLES[contentType];
    const activeSelection = SOURCE_ACTIVE_COLUMNS[contentType]
      ? `${SOURCE_ACTIVE_COLUMNS[contentType]} AS source_active,` : '';
    const { rows } = await db.query(
      sourceTable
        ? `SELECT s.id AS source_id, ${activeSelection}
                  d.id AS document_id, r.id AS published_revision_id, r.blocks
             FROM ${sourceTable} s
             LEFT JOIN cms_documents d
               ON d.content_type = $1 AND d.source_id = s.id
             LEFT JOIN cms_revisions r
               ON r.id = d.published_revision_id AND r.status = 'published'
            WHERE s.id = ANY($2::uuid[])`
        : `SELECT d.source_id, d.id AS document_id, r.blocks
             FROM cms_documents d
             LEFT JOIN cms_revisions r
               ON r.id = d.published_revision_id AND r.status = 'published'
            WHERE d.content_type = $1 AND d.source_id = ANY($2::uuid[])`,
      [contentType, ids],
    );
    const entries = new Map(ids.map(sourceId => [sourceId, SOURCE_STATES.missing]));
    const publishedRows = [];
    for (const row of rows) {
      const sourceId = String(row.source_id).toLowerCase();
      const sourceActive = row.source_active !== false;
      if (!row.document_id) {
        snapshots.set(sourceId, { sourceExists: true, sourceActive, documentId: null, publishedRevisionId: null });
        entries.set(sourceId, sourceActive ? SOURCE_STATES.legacy : SOURCE_STATES.inactive);
        continue;
      }
      snapshots.set(sourceId, {
        sourceExists: true, sourceActive,
        documentId: String(row.document_id).toLowerCase(),
        publishedRevisionId: row.published_revision_id
          ? String(row.published_revision_id).toLowerCase() : null,
      });
      entries.set(sourceId, sourceActive ? null : SOURCE_STATES.inactive);
      if (sourceActive) publishedRows.push({ sourceId, blocks: row.blocks });
    }
    const validations = await validatePublishedBlocksBatch(
      db,
      publishedRows.map(({ blocks }) => blocks),
    );
    for (const [index, { sourceId }] of publishedRows.entries()) {
      entries.set(sourceId, validations[index].blocks);
    }
    return entries;
  });
  const sourceTable = SOURCE_TABLES[contentType];
  if (!sourceTable) return entries;
  await withTransaction(pool, async (db) => {
    await lockCmsAssets(db);
    const activeSelection = SOURCE_ACTIVE_COLUMNS[contentType]
      ? `${SOURCE_ACTIVE_COLUMNS[contentType]} AS source_active,` : '';
    const { rows } = await db.query(
      `SELECT s.id AS source_id, ${activeSelection}
              d.id AS document_id, r.id AS published_revision_id
         FROM ${sourceTable} s
         LEFT JOIN cms_documents d
           ON d.content_type = $2 AND d.source_id = s.id
         LEFT JOIN cms_revisions r
           ON r.id = d.published_revision_id AND r.status = 'published'
        WHERE s.id = ANY($1::uuid[])
        FOR UPDATE OF s`,
      [ids, contentType],
    );
    const currentBySourceId = new Map(rows.map(row => [String(row.source_id).toLowerCase(), {
      sourceActive: row.source_active !== false,
      documentId: row.document_id ? String(row.document_id).toLowerCase() : null,
      publishedRevisionId: row.published_revision_id
        ? String(row.published_revision_id).toLowerCase() : null,
    }]));
    for (const sourceId of ids) {
      const initial = snapshots.get(sourceId);
      const current = currentBySourceId.get(sourceId);
      if (!current || !initial?.sourceExists) {
        entries.set(sourceId, SOURCE_STATES.missing);
      } else if (current.sourceActive === false) {
        entries.set(sourceId, SOURCE_STATES.inactive);
      } else if (initial.sourceActive === false) {
        entries.set(sourceId, null);
      } else if (!current.documentId) {
        entries.set(sourceId, initial.documentId ? null : SOURCE_STATES.legacy);
      } else if (initial.documentId !== current.documentId
        || initial.publishedRevisionId !== current.publishedRevisionId) {
        entries.set(sourceId, null);
      }
    }
  });
  return entries;
}

async function promoteDueScheduledForPool(pool, now = new Date(), contentType = null, sourceIds = null) {
  return withTransaction(pool, (db) => promoteDueScheduled(db, now, contentType, sourceIds));
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
  return Boolean(row) && row.active !== false && (row.cms_managed !== true
    || Object.prototype.hasOwnProperty.call(row, 'content_blocks'));
}

async function addPublishedBlocks(pool, rows, contentType) {
  const blocksBySourceId = await getPublishedBlocksBatch(pool, contentType, rows.map((row) => row.id));
  return rows.flatMap((row) => {
    const sourceId = String(row.id).toLowerCase();
    if (!blocksBySourceId.has(sourceId)) return [row];
    const blocks = blocksBySourceId.get(sourceId);
    if (blocks === SOURCE_STATES.missing) return [];
    if (blocks === SOURCE_STATES.legacy) return [row];
    if (blocks === SOURCE_STATES.inactive) return [{ ...row, active: false }];
    return [cmsManagedRow(row, contentType, blocks)];
  });
}

function publishedBodyText(row, legacyField = 'content') {
  if (row?.cms_managed) return blocksToText(row.content_blocks);
  return typeof row?.[legacyField] === 'string' ? row[legacyField] : '';
}

async function listPublishedAnnouncements(pool, limit, offset) {
  await promoteDueScheduledForPool(pool, new Date(), 'announcement');
  const visible = await withTransaction(pool, async (db) => {
    const { rows } = await db.query(
      `SELECT d.id, d.title, d.category, d.published_at,
              r.id AS published_revision_id, r.blocks
         FROM cms_documents d
         JOIN cms_revisions r
           ON r.id = d.published_revision_id AND r.status = 'published'
        WHERE d.content_type = 'announcement'
        ORDER BY d.published_at DESC NULLS LAST, d.updated_at DESC, d.id`,
    );
    const validations = await validatePublishedBlocksBatch(db, rows.map(row => row.blocks));
    const visible = rows.flatMap((row, index) => validations[index].blocks === null
      ? []
      : [{ ...row, blocks: validations[index].blocks }]);
    return visible;
  });
  const stableIds = await recheckPublishedAnnouncements(pool, visible.map(row => ({
    id: row.id,
    publishedRevisionId: row.published_revision_id,
  })));
  const stable = visible.filter(row => stableIds.has(String(row.id).toLowerCase()));
  return {
    count: stable.length,
    rows: stable.slice(offset, offset + limit)
      .map(({ blocks, published_revision_id: _publishedRevisionId, ...row }) => ({ ...row, content_blocks: blocks })),
  };
}

async function getPublishedAnnouncement(pool, id) {
  await promoteDueScheduledForPool(pool, new Date(), 'announcement');
  const result = await withTransaction(pool, async (db) => {
    const { rows } = await db.query(
      `SELECT d.id, d.title, d.category, d.published_at,
              r.id AS published_revision_id, r.blocks
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
    return { row, blocks: validation.blocks };
  });
  if (!result) return null;
  const stableIds = await recheckPublishedAnnouncements(pool, [{
    id: result.row.id,
    publishedRevisionId: result.row.published_revision_id,
  }]);
  if (!stableIds.has(String(result.row.id).toLowerCase())) return null;
  const { blocks: _rawBlocks, published_revision_id: _publishedRevisionId, ...announcement } = result.row;
  return { ...announcement, content_blocks: result.blocks };
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
  validatePublishedBlocksBatch,
};
