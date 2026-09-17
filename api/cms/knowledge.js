const { validateBlocks } = require('./blocks');
const { lockCmsAssets } = require('./locks');

class KnowledgePdfError extends Error {
  constructor(message, code = 'invalid_pdf') {
    super(message);
    this.code = code;
  }
}

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
             published.blocks AS published_blocks, draft.blocks AS draft_blocks,
             scheduled.blocks AS scheduled_blocks
       FROM cms_documents d
       LEFT JOIN cms_revisions published ON published.id = d.published_revision_id
       LEFT JOIN cms_revisions draft ON draft.id = d.draft_revision_id
       LEFT JOIN cms_revisions scheduled ON scheduled.id = d.scheduled_revision_id
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
  if (document) {
    for (const value of [document.draft_blocks, document.scheduled_blocks, document.published_blocks]) {
      const blocks = validateBlocks(value);
      if (blocks !== null) return blocks;
    }
    return [];
  }
  return legacyTextBlocks(content);
}

async function syncKnowledgePdf(db, { sourceId, title, category, content, pdf, actorUid }) {
  await lockCmsAssets(db);
  if (pdf) await validatePdfAsset(db, pdf.assetId);

  const document = await loadKnowledgeDocument(db, sourceId);
  if (!document && (pdf === undefined || pdf === null)) return null;

  let documentId = document?.id;
  if (!documentId) {
    const legacyContent = typeof content === 'string' ? content.trim() : '';
    if (legacyContent && hasUnsafeMarkup(legacyContent)) {
      throw new KnowledgePdfError(
        'Article content contains unsafe markup and cannot be converted to CMS blocks.',
        'unsafe_legacy_content',
      );
    }
    const blocks = currentBlocks(null, content);
    blocks.push({ type: 'pdf', asset_id: pdf.assetId, title: pdf.title });
    const normalized = validateBlocks(blocks);
    if (!normalized) throw new KnowledgePdfError('Article content cannot be converted to CMS blocks.');
    const { rows } = await db.query(
      `INSERT INTO cms_documents (content_type, source_id, title, category, created_by, updated_by)
       VALUES ('knowledge', $1, $2, $3, $4, $4)
       RETURNING id`,
      [sourceId, title, category, actorUid],
    );
    documentId = rows[0].id;
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
    return {
      documentId,
      revisionId: revisions[0].id,
      pdfChanged: true,
      pdfAssetId: pdf.assetId,
    };
  }

  await db.query(
    `UPDATE cms_documents
        SET title = $2, category = $3, updated_by = $4, updated_at = NOW()
      WHERE id = $1`,
    [documentId, title, category, actorUid],
  );
  if (pdf === undefined) return { documentId, revisionId: null, pdfChanged: false, pdfAssetId: null };

  const blocks = currentBlocks(document, content);
  const pdfIndexes = blocks.reduce((indexes, block, index) => {
    if (block.type === 'pdf') indexes.push(index);
    return indexes;
  }, []);
  if (pdfIndexes.length > 1) {
    throw new KnowledgePdfError(
      'Este artigo possui mais de um bloco PDF. Use o Editor CMS para alterar ou remover um PDF.',
      'ambiguous_pdf',
    );
  }
  const currentPdfIndex = pdfIndexes[0] ?? -1;
  const currentPdf = currentPdfIndex >= 0 ? blocks[currentPdfIndex] : null;
  const nextPdf = pdf ? { type: 'pdf', asset_id: pdf.assetId, title: pdf.title } : null;
  if (JSON.stringify(currentPdf) === JSON.stringify(nextPdf)) {
    return {
      documentId,
      revisionId: null,
      pdfChanged: false,
      pdfAssetId: currentPdf?.asset_id || null,
    };
  }

  const nextBlocks = [...blocks];
  if (currentPdfIndex >= 0) nextBlocks.splice(currentPdfIndex, 1);
  if (nextPdf) nextBlocks.splice(currentPdfIndex >= 0 ? currentPdfIndex : nextBlocks.length, 0, nextPdf);
  const normalized = validateBlocks(nextBlocks);
  if (!normalized) throw new KnowledgePdfError('Article content cannot be converted to CMS blocks.');

  const publish = !document.draft_revision_id
    && !document.scheduled_revision_id
    && Boolean(document.published_revision_id);
  const status = publish ? 'published' : 'draft';
  const previousRevisionId = publish ? document.published_revision_id : document.draft_revision_id;
  if (previousRevisionId) {
    await db.query(`UPDATE cms_revisions SET status = 'archived' WHERE id = $1 AND status = '${status}'`, [previousRevisionId]);
  }
  const { rows: versions } = await db.query(
    'SELECT COALESCE(MAX(version), 0) + 1 AS version FROM cms_revisions WHERE document_id = $1',
    [documentId],
  );
  const { rows: revisions } = await db.query(
    `INSERT INTO cms_revisions (document_id, version, status, blocks, created_by)
      VALUES ($1, $2, $3, $4::jsonb, $5)
      RETURNING id, document_id, version, status, blocks, created_by, created_at`,
    [documentId, versions[0].version, status, JSON.stringify(normalized), actorUid],
  );
  const pointer = publish ? 'published_revision_id' : 'draft_revision_id';
  await db.query(
    `UPDATE cms_documents
        SET ${pointer} = $2, ${publish ? 'published_at = NOW(),' : ''}
            updated_by = $3, updated_at = NOW()
      WHERE id = $1`,
    [documentId, revisions[0].id, actorUid],
  );
  return {
    documentId,
    revisionId: revisions[0].id,
    pdfChanged: true,
    pdfAssetId: nextPdf?.asset_id || null,
  };
}

module.exports = { KnowledgePdfError, currentBlocks, legacyTextBlocks, loadKnowledgeDocument, syncKnowledgePdf };
