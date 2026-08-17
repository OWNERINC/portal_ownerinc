const { blocksToText, validateBlocks } = require('./blocks');

const CONTENT_TYPES = new Set(['knowledge', 'academy', 'benefit', 'announcement', 'reminder']);

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

async function promoteDueScheduled(db, now = new Date(), contentType = null, sourceIds = null) {
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
       FROM cms_documents d
       JOIN cms_revisions scheduled ON scheduled.id = d.scheduled_revision_id
      WHERE ${conditions.join(' AND ')}
      FOR UPDATE OF d, scheduled`,
    values,
  );
  for (const document of rows) await promoteDocument(db, document, now);
  return rows.length;
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
      `SELECT d.source_id, r.blocks
         FROM cms_documents d
         JOIN cms_revisions r ON r.id = d.published_revision_id
        WHERE d.content_type = $1
          AND d.source_id = ANY($2::uuid[])
          AND r.status = 'published'`,
      [contentType, ids],
    );
    return new Map(rows.flatMap((row) => {
      const blocks = validateBlocks(row.blocks);
      return blocks === null ? [] : [[String(row.source_id), blocks]];
    }));
  });
}

async function addPublishedBlocks(pool, rows, contentType) {
  const blocksBySourceId = await getPublishedBlocksBatch(pool, contentType, rows.map((row) => row.id));
  return rows.map((row) => {
    const sourceId = String(row.id);
    return blocksBySourceId.has(sourceId)
      ? { ...row, content_blocks: blocksBySourceId.get(sourceId) }
      : row;
  });
}

async function listPublishedAnnouncements(pool, limit, offset) {
  return withTransaction(pool, async (db) => {
    await promoteDueScheduled(db);
    const [{ rows: countRows }, { rows }] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::integer AS count
           FROM cms_documents d
           JOIN cms_revisions r ON r.id = d.published_revision_id
          WHERE d.content_type = 'announcement' AND r.status = 'published'`,
      ),
      db.query(
        `SELECT d.id, d.title, d.category, d.published_at, r.blocks
           FROM cms_documents d
           JOIN cms_revisions r ON r.id = d.published_revision_id
          WHERE d.content_type = 'announcement' AND r.status = 'published'
          ORDER BY d.published_at DESC NULLS LAST, d.updated_at DESC, d.id
          LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
    ]);
    return {
      count: countRows[0]?.count || 0,
      rows: rows.map(({ blocks, ...row }) => {
        const contentBlocks = validateBlocks(blocks);
        return contentBlocks === null ? row : { ...row, content_blocks: contentBlocks };
      }),
    };
  });
}

module.exports = {
  addPublishedBlocks,
  blocksToText,
  getPublishedBlocksBatch,
  listPublishedAnnouncements,
  promoteDueScheduled,
};
