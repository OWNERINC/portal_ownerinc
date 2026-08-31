const { validateBlocks } = require('./blocks');

const CMS_ASSET_RETENTION_LOCK = 7193029;

class KnowledgePdfError extends Error {}

function hasUnsafeMarkup(value) {
  return /<\/?[a-z][^>]*>|\bon[a-z]+\s*=|javascript\s*:/i.test(value);
}

function legacyTextBlocks(value) {
  const content = typeof value === 'string' ? value.trim() : '';
  if (!content || hasUnsafeMarkup(content)) return [];
  const blocks = [];
  let cursor = 0;
  while (cursor < content.length) {
    let end = Math.min(cursor + 5000, content.length);
    if (end < content.length) {
      const boundary = Math.max(content.lastIndexOf('\n', end), content.lastIndexOf(' ', end));
      if (boundary > cursor) end = boundary;
    }
    const text = content.slice(cursor, end).trim();
    if (text) blocks.push({ type: 'paragraph', text });
    cursor = end;
  }
  return blocks;
}

async function loadKnowledgeDocument(db, sourceId) {
  const { rows } = await db.query(
    `SELECT d.id, d.published_revision_id, d.draft_revision_id, d.scheduled_revision_id,
            published.blocks AS published_blocks, draft.blocks AS draft_blocks
       FROM cms_documents d
       LEFT JOIN cms_revisions published ON published.id = d.published_revision_id
       LEFT JOIN cms_revisions draft ON draft.id = d.draft_revision_id
      WHERE d.content_type = 'knowledge' AND d.source_id = $1
      FOR UPDATE OF d`,
    [sourceId],
  );
  return rows[0] || null;
}

async function validatePdfAsset(db, assetId) {
  const { rows } = await db.query(
    `SELECT id FROM cms_assets
      WHERE id = $1 AND mime_type = 'application/pdf'
        AND storage_key IS NOT NULL AND deleting_at IS NULL
        AND byte_size BETWEEN 1 AND 52428800`,
    [assetId],
  );
  if (!rows[0]) throw new KnowledgePdfError('PDF asset is invalid.');
}

function currentBlocks(document, content) {
  const published = validateBlocks(document?.published_blocks);
  const legacyBlocks = legacyTextBlocks(content);
  if (typeof content === 'string' && content.trim() && !legacyBlocks.length) return null;
  if (!published) return legacyBlocks;
  const managedTypes = new Set(['paragraph']);
  return [...legacyBlocks, ...published.filter((block) => !managedTypes.has(block.type))];
}

async function syncKnowledgePdf(db, { sourceId, title, category, content, pdf, actorUid }) {
  await db.query('SELECT pg_advisory_xact_lock($1)', [CMS_ASSET_RETENTION_LOCK]);
  if (pdf) await validatePdfAsset(db, pdf.assetId);

  const document = await loadKnowledgeDocument(db, sourceId);
  if (!document && pdf === undefined) return null;

  const blocks = currentBlocks(document, content);
  if (pdf !== undefined) {
    const firstPdf = blocks.findIndex((block) => block.type === 'pdf');
    if (firstPdf >= 0) blocks.splice(firstPdf, 1);
    if (pdf) blocks.push({ type: 'pdf', asset_id: pdf.assetId, title: pdf.title });
  }
  const normalized = validateBlocks(blocks);
  if (!normalized) throw new KnowledgePdfError('Article content cannot be converted to CMS blocks.');

  let documentId = document?.id;
  if (!documentId) {
    const { rows } = await db.query(
      `INSERT INTO cms_documents (content_type, source_id, title, category, created_by, updated_by)
       VALUES ('knowledge', $1, $2, $3, $4, $4)
       RETURNING id`,
      [sourceId, title, category, actorUid],
    );
    documentId = rows[0].id;
  }

  if (document?.published_revision_id) {
    await db.query("UPDATE cms_revisions SET status = 'archived' WHERE id = $1", [document.published_revision_id]);
  }
  const { rows: versions } = await db.query(
    'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM cms_revisions WHERE document_id = $1',
    [documentId],
  );
  const { rows: revisions } = await db.query(
    `INSERT INTO cms_revisions (document_id, version, status, blocks, created_by)
     VALUES ($1, $2, 'published', $3::jsonb, $4)
     RETURNING id, document_id, version, status, blocks, created_by, created_at`,
    [documentId, versions[0].version, JSON.stringify(normalized), actorUid],
  );
  await db.query(
      `UPDATE cms_documents
         SET title = $2, category = $3, published_revision_id = $4,
             published_at = NOW(), updated_by = $5, updated_at = NOW()
       WHERE id = $1`,
    [documentId, title, category, revisions[0].id, actorUid],
  );
  const publishedPdf = normalized.find((block) => block.type === 'pdf');
  return {
    documentId,
    revisionId: revisions[0].id,
    pdfChanged: pdf !== undefined,
    pdfAssetId: publishedPdf?.asset_id || null,
  };
}

module.exports = { KnowledgePdfError, legacyTextBlocks, syncKnowledgePdf };
