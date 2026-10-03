import type { Payload, RequiredDataFromCollectionSlug } from 'payload'
import { uuid } from './primitives'
import { legacyNewsImportContext } from './validation'

/** Trusted Local API capability, not an HTTP endpoint or the later bundle importer. */
export async function createLegacyNewsArticle(payload: Payload,
  data: RequiredDataFromCollectionSlug<'news-articles'> & { id: string }) {
  if (!(payload.db as typeof payload.db & { allowIDOnCreate?: boolean }).allowIDOnCreate) {
    throw new Error('legacy_import_requires_separate_import_config')
  }
  const id = uuid(data.id)
  if (data.legacyDocumentId !== undefined && data.legacyDocumentId !== id) throw new Error('legacy_import_identity_mismatch')
  const transactionID = await payload.db.beginTransaction()
  if (!transactionID) throw new Error('legacy_import_requires_transaction')
  const req = { transactionID }
  try {
    const doc = await payload.create({ collection: 'news-articles', overrideAccess: true,
      context: legacyNewsImportContext, req, depth: 0, draft: data._status !== 'published',
      data: { ...data, id, legacyDocumentId: id },
    })
    if (doc.id !== id) throw new Error('legacy_import_identity_mismatch')
    const persisted = await payload.findByID({ collection: 'news-articles', id, overrideAccess: true,
      req, depth: 0, draft: true })
    if (persisted.id !== id || persisted.legacyDocumentId !== id) throw new Error('legacy_import_identity_mismatch')
    await payload.db.commitTransaction(transactionID)
    return doc
  } catch (error) {
    await payload.db.rollbackTransaction(transactionID)
    throw error
  }
}
