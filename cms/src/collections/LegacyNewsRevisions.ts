import { APIError, type CollectionConfig } from 'payload'
import type { LegacyNewsRevisionInput } from '../contracts/news'
import { canManageNews } from '../auth/access'
import { isLegacyNewsImport, normalizeNewsDocument } from '../news/validation'
import { uuid } from '../news/primitives'
import { collectMediaIds } from '../media/references'
import { lockCmsReferences } from '../publication/transaction'
import { snapshotHash } from '../publication/document'

export function historyDocument(value: { legacyDocumentId: unknown; originalTitle: unknown; originalCategory?: unknown; originalBody: unknown; originalEditorial?: unknown; originalPublishedAt?: unknown }) {
  return { id: value.legacyDocumentId, title: value.originalTitle, category: value.originalCategory ?? '',
    body: value.originalBody, editorial: value.originalEditorial ?? null, publishedAt: value.originalPublishedAt ?? null }
}
/** Canonical JSON key order, original values retained (not normalized/re-authored). */
export function historyHashes(value: Omit<LegacyNewsRevisionInput, 'contentHash' | 'provenanceHash' | 'mediaReferences'>) {
  const hash = snapshotHash
  const contentHash = hash({ title: value.originalTitle, category: value.originalCategory, body: value.originalBody, editorial: value.originalEditorial })
  return { contentHash, provenanceHash: hash({ legacyDocumentId: value.legacyDocumentId, legacyRevisionId: value.legacyRevisionId,
    originalVersion: value.originalVersion, originalCreatedAt: value.originalCreatedAt, originalActorUid: value.originalActorUid,
    originalStatus: value.originalStatus, originalPublishedAt: value.originalPublishedAt, contentHash }) }
}
export const historyFields = ['legacyDocumentId', 'legacyRevisionId', 'originalVersion', 'originalCreatedAt', 'originalActorUid',
  'originalStatus', 'originalTitle', 'originalCategory', 'originalPublishedAt', 'originalBody', 'originalEditorial', 'contentHash', 'provenanceHash', 'mediaReferences']
export const LegacyNewsRevisions: CollectionConfig = {
  slug: 'legacy-news-revisions',
  admin: { hidden: true },
  access: { read: canManageNews, create: () => false, update: () => false, delete: () => false },
  indexes: [{ fields: ['legacyDocumentId', 'legacyRevisionId'], unique: true }],
  hooks: {
    beforeOperation: [async ({ operation, req }) => {
      if (!['create', 'update', 'delete', 'restoreVersion'].includes(operation)) return
      if (operation !== 'create' || !isLegacyNewsImport(req.context)) throw new APIError('legacy_history_read_only', 403, undefined, true)
      await lockCmsReferences(req.payload, req)
    }],
    beforeChange: [({ data }) => {
      const value = data as LegacyNewsRevisionInput
      if (value.legacyDocumentId !== uuid(value.legacyDocumentId) || value.legacyRevisionId !== uuid(value.legacyRevisionId)) throw new APIError('invalid_legacy_history_identity', 400)
      const validDate = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v))
      if (!Number.isSafeInteger(value.originalVersion) || value.originalVersion < 1 || !validDate(value.originalCreatedAt) ||
        !(value.originalPublishedAt === null || validDate(value.originalPublishedAt)) ||
        !(value.originalActorUid === null || (typeof value.originalActorUid === 'string' && value.originalActorUid.length > 0 && value.originalActorUid.length <= 128))) throw new APIError('invalid_legacy_history', 400)
      const normalized = normalizeNewsDocument(historyDocument(value), false)
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
  ],
}
