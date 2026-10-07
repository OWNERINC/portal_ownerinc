import { createRequire } from 'node:module';
import { fail, historyHashes, LIMITS, uuid } from './contract.mjs';
const require = createRequire(import.meta.url);
const { validateNewsRevision } = require('../../api/owner-news/editorial.js');
const types = new Set(['heading', 'paragraph', 'list', 'callout', 'quote', 'profile', 'image', 'divider', 'link', 'pdf', 'video']);

export function convertLegacyRevision({ document, revision, assets = new Map() }) {
  uuid(document.id); uuid(revision.id);
  if (revision.document_id !== undefined && revision.document_id !== document.id) fail('revision_document_mismatch', { id: revision.id });
  if (!Array.isArray(revision.blocks) || revision.blocks.length > LIMITS.blocks) fail('invalid_revision', { id: revision.id });
  for (const [index, block] of revision.blocks.entries()) {
    if (!types.has(block?.type)) fail('unsupported_block', { id: revision.id, index });
    // The legacy API tolerated a redundant invalid video property; the CMS does
    // not. Refuse rather than erase original data while normalizing.
    if (block.type === 'video' && Object.hasOwn(block, 'url') && Object.hasOwn(block, 'asset_id')) fail('invalid_revision', { id: revision.id, index });
  }
  const normalized = validateNewsRevision(revision.blocks, revision.editorial, { publishing: document.published_revision_id === revision.id });
  if (!normalized) fail('invalid_revision', { id: revision.id });
  const mediaIds = [...new Set(normalized.blocks.flatMap(block => block.asset_id ? [block.asset_id] : []))].sort();
  for (const block of normalized.blocks) {
    if (!block.asset_id) continue;
    const asset = assets.get(block.asset_id);
    const allowed = block.type === 'pdf' ? ['application/pdf'] : block.type === 'video'
      ? ['video/mp4', 'video/webm', 'video/quicktime'] : ['image/jpeg', 'image/png', 'image/webp'];
    if (!asset || !allowed.includes(asset.mime ?? asset.mime_type)) fail('invalid_media_reference', { id: revision.id });
  }
  const originalPublishedAt = document.published_revision_id === revision.id ? document.published_at : null;
  const metadataBasis = { title: 'document_snapshot', category: 'document_snapshot', publishedAt: originalPublishedAt === null ? 'unknown' : 'published_pointer' };
  const original = { legacyDocumentId: document.id, legacyRevisionId: revision.id, originalVersion: revision.version,
    originalCreatedAt: revision.created_at, originalActorUid: revision.created_by, originalStatus: revision.status,
    originalTitle: document.title, originalCategory: document.category, originalPublishedAt,
    originalBody: structuredClone(revision.blocks), originalEditorial: structuredClone(revision.editorial) };
  const history = { ...original, ...historyHashes(original), mediaReferences: mediaIds, metadataBasis };
  return { id: document.id,
    content: { title: document.title, category: document.category, body: normalized.blocks, editorial: normalized.editorial, publishedAt: originalPublishedAt },
    provenance: { version: revision.version, revisionId: revision.id, sourceId: document.source_id, createdAt: revision.created_at, actorUid: revision.created_by, status: revision.status, metadataBasis },
    history, mediaIds };
}
