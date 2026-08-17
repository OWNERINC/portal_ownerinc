const { blocksToText, validateBlocks } = require('./blocks');

const CONTENT_TYPES = new Set(['knowledge', 'academy', 'benefit', 'announcement', 'reminder']);

function due(scheduledAt, now) {
  return scheduledAt && new Date(scheduledAt).getTime() <= now.getTime();
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

async function promoteDueScheduled(db, now = new Date()) {
  const { rows } = await db.query(
    `SELECT d.id, d.published_revision_id, d.scheduled_revision_id
       FROM cms_documents d
       JOIN cms_revisions scheduled ON scheduled.id = d.scheduled_revision_id
      WHERE scheduled.status = 'scheduled' AND d.scheduled_at <= $1
      FOR UPDATE OF d, scheduled`,
    [now],
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

async function getPublishedBlocks(pool, contentType, sourceId) {
  if (!CONTENT_TYPES.has(contentType)) return null;
  return withTransaction(pool, async (db) => {
    const { rows } = await db.query(
      `SELECT id, published_revision_id, scheduled_revision_id, scheduled_at
         FROM cms_documents
        WHERE content_type = $1 AND source_id IS NOT DISTINCT FROM $2::uuid
        FOR UPDATE`,
      [contentType, sourceId || null],
    );
    const document = rows[0];
    if (!document) return null;

    let revisionId = document.published_revision_id;
    if (due(document.scheduled_at, new Date())) {
      await promoteDocument(db, document, new Date());
      revisionId = document.scheduled_revision_id;
    }
    if (!revisionId) return null;

    const { rows: revisions } = await db.query(
      `SELECT blocks
         FROM cms_revisions
        WHERE id = $1 AND document_id = $2 AND status = 'published'`,
      [revisionId, document.id],
    );
    return revisions[0] ? validateBlocks(revisions[0].blocks) : null;
  });
}

async function addPublishedBlocks(pool, rows, contentType) {
  return Promise.all(rows.map(async (row) => {
    const contentBlocks = await getPublishedBlocks(pool, contentType, row.id);
    return contentBlocks === null ? row : { ...row, content_blocks: contentBlocks };
  }));
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
  getPublishedBlocks,
  listPublishedAnnouncements,
  promoteDueScheduled,
};
