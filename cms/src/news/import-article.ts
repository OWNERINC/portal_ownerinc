import { createLocalReq, type Payload, type PayloadRequest, type RequiredDataFromCollectionSlug } from 'payload'
import { canWriteNews } from '../auth/access'
import { uuid } from './primitives'
import { legacyNewsImportContext } from './validation'
import { withImportTransaction } from '../migration/transaction'
import { snapshotHash } from '../publication/document'

/** Trusted Local API capability, not an HTTP endpoint or the later bundle importer. */
export async function createLegacyNewsArticle(payload: Payload,
  data: RequiredDataFromCollectionSlug<'news-articles'> & { id: string }, incoming?: PayloadRequest) {
  if (!(payload.db as typeof payload.db & { allowIDOnCreate?: boolean }).allowIDOnCreate) {
    throw new Error('legacy_import_requires_separate_import_config')
  }
  if (!incoming || !canWriteNews({ req: incoming })) throw new Error('legacy_import_actor_required')
  const id = uuid(data.id)
  if (data.legacyDocumentId !== undefined && data.legacyDocumentId !== id) throw new Error('legacy_import_identity_mismatch')
  const result = await withImportTransaction(payload, incoming, async req => {
    const doc = await payload.create({ collection: 'news-articles', overrideAccess: true,
      context: legacyNewsImportContext, req, depth: 0, draft: data._status !== 'published',
      data: { ...data, id, legacyDocumentId: id },
    })
    if (doc.id !== id) throw new Error('legacy_import_identity_mismatch')
    const persisted = await payload.findByID({ collection: 'news-articles', id, overrideAccess: true,
      req, depth: 0, draft: true })
    if (persisted.id !== id || persisted.legacyDocumentId !== id) throw new Error('legacy_import_identity_mismatch')
    return { doc, persistedHash: snapshotHash(persisted) }
  }, { confirmCommitted: async result => {
    // Fresh Local API request AND dataloader: never confirm from the transaction's
    // request cache or by trusting the pinned adapter's fulfilled commit promise.
    const req = await createLocalReq({ req: { ...incoming, context: { ...incoming.context },
      transactionID: undefined, payloadDataLoader: undefined } }, payload)
    const persisted = await payload.findByID({ collection: 'news-articles', id, overrideAccess: true,
      req, depth: 0, draft: true, disableErrors: true })
    return Boolean(persisted && persisted.id === id && persisted.legacyDocumentId === id && snapshotHash(persisted) === result.persistedHash)
  } })
  return result.doc
}
