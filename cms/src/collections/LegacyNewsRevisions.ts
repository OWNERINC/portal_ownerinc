import { APIError, type CollectionConfig } from 'payload'
import type { LegacyNewsRevisionInput } from '../contracts/news'
import { newsAreaReadAccess } from '../auth/news-area-access'
import { isLegacyNewsImport, normalizeNewsDocument } from '../news/validation'
import { uuid } from '../news/primitives'
import { collectMediaIds } from '../media/references'
import { lockCmsReferences } from '../publication/transaction'
import { historyHashes } from '../news/history-hashes.mjs'
export { historyHashes } from '../news/history-hashes.mjs'

export function historyDocument(value: { legacyDocumentId: unknown; originalTitle: unknown; originalCategory?: unknown; originalBody: unknown; originalEditorial?: unknown; originalPublishedAt?: unknown }) {
  return { id: value.legacyDocumentId, title: value.originalTitle, category: value.originalCategory ?? '',
    body: value.originalBody, editorial: value.originalEditorial ?? null, publishedAt: value.originalPublishedAt ?? null }
}
export const historyFields = ['legacyDocumentId', 'legacyRevisionId', 'originalVersion', 'originalCreatedAt', 'originalActorUid',
  'originalStatus', 'originalTitle', 'originalCategory', 'originalPublishedAt', 'originalBody', 'originalEditorial', 'contentHash', 'provenanceHash', 'mediaReferences', 'metadataBasis']
export type LegacyMetadataBasis = { title: 'document_snapshot'; category: 'document_snapshot'; publishedAt: 'published_pointer' | 'unknown' }
export function validateHistoryMetadataBasis(value: unknown, originalPublishedAt: unknown): void {
  // Existing Task7 records have no basis. Never retrofit their hashes or pretend
  // their source is known. New bundle imports explicitly supply this field.
  if (value === undefined || value === null) return
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new APIError('invalid_legacy_metadata_basis', 400)
  const basis = value as Record<string, unknown>
  if (Object.keys(basis).length !== 3 || basis.title !== 'document_snapshot' || basis.category !== 'document_snapshot' ||
    basis.publishedAt !== (originalPublishedAt === null ? 'unknown' : 'published_pointer')) throw new APIError('invalid_legacy_metadata_basis', 400)
}
export const LegacyNewsRevisions: CollectionConfig = {
  slug: 'legacy-news-revisions',
  admin: { hidden: true },
  access: { read: newsAreaReadAccess, create: () => false, update: () => false, delete: () => false },
  indexes: [{ fields: ['legacyDocumentId', 'legacyRevisionId'], unique: true }],
  hooks: {
    beforeOperation: [async ({ operation, req }) => {
      if (!['create', 'update', 'delete', 'restoreVersion'].includes(operation)) return
      if (operation !== 'create' || !isLegacyNewsImport(req.context)) throw new APIError('legacy_history_read_only', 403, undefined, true)
      await lockCmsReferences(req.payload, req)
    }],
    beforeChange: [({ data }) => {
      const value = data as LegacyNewsRevisionInput & { metadataBasis?: LegacyMetadataBasis | null }
      if (value.legacyDocumentId !== uuid(value.legacyDocumentId) || value.legacyRevisionId !== uuid(value.legacyRevisionId)) throw new APIError('invalid_legacy_history_identity', 400)
      const validDate = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v))
      if (!Number.isSafeInteger(value.originalVersion) || value.originalVersion < 1 || !validDate(value.originalCreatedAt) ||
        !(value.originalPublishedAt === null || validDate(value.originalPublishedAt)) ||
        !(value.originalActorUid === null || (typeof value.originalActorUid === 'string' && value.originalActorUid.length > 0 && value.originalActorUid.length <= 128))) throw new APIError('invalid_legacy_history', 400)
      const normalized = normalizeNewsDocument(historyDocument(value), false)
      validateHistoryMetadataBasis(value.metadataBasis, value.originalPublishedAt)
      const expected = [...collectMediaIds(normalized.blocks)].sort()
      if (!Array.isArray(value.mediaReferences) || JSON.stringify([...value.mediaReferences].map(uuid).sort()) !== JSON.stringify(expected)) throw new APIError('invalid_legacy_history_relations', 400)
      const hashes = historyHashes(value)
      if (value.contentHash !== hashes.contentHash || value.provenanceHash !== hashes.provenanceHash) throw new APIError('invalid_legacy_history_hash', 400)
      return data
    }],
  },
  fields: [
    { name: 'legacyDocumentId', type: 'text', required: true, index: true },
    { name: 'legacyRevisionId', type: 'text', required: true, index: true },
    { name: 'originalVersion', type: 'number', required: true, min: 1 },
    { name: 'originalCreatedAt', type: 'text', required: true },
    { name: 'originalActorUid', type: 'text' },
    { name: 'originalStatus', type: 'select', required: true, options: ['draft', 'published', 'scheduled', 'archived'] },
    { name: 'originalTitle', type: 'text', required: true, maxLength: 200 },
    { name: 'originalCategory', type: 'text', maxLength: 100 },
    { name: 'originalPublishedAt', type: 'text' },
    { name: 'originalBody', type: 'json', required: true },
    { name: 'originalEditorial', type: 'json' },
    { name: 'contentHash', type: 'text', required: true, minLength: 64, maxLength: 64 },
    { name: 'provenanceHash', type: 'text', required: true, minLength: 64, maxLength: 64 },
    { name: 'mediaReferences', type: 'relationship', relationTo: 'news-media', hasMany: true },
    { name: 'metadataBasis', type: 'json', admin: { readOnly: true, description: 'Distinguishes document snapshot metadata from unknown revision provenance. Does not rewrite existing history hashes.' } },
  ],
}
