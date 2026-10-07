import { createLocalReq, type Payload, type PayloadRequest } from 'payload'
import { lockCmsReferences, requireCmsTransaction } from '../publication/transaction'

export class ImportCommitOutcomeUnknown extends Error {
  readonly code = 'commit_outcome_unknown'
  constructor() { super('commit_outcome_unknown') }
}

/** No file cleanup belongs here. A thrown COMMIT may already have persisted rows.
 * Nested callers retain ownership, including the duty to reconcile their COMMIT. */
export async function withImportTransaction<T>(payload: Payload, incoming: PayloadRequest,
  work: (req: PayloadRequest) => Promise<T>, options: { confirmCommitted?: (result: T) => Promise<boolean> } = {}): Promise<T> {
  if (incoming.transactionID) {
    await lockCmsReferences(payload, incoming)
    const result = await work(incoming)
    await requireCmsTransaction(payload, incoming)
    return result
  }
  // Pinned drizzle begin/commit wrappers can swallow a COMMIT failure and fulfill.
  // Adapter resolution alone is NOT an acknowledgement. A standalone unit needs
  // a durable receipt/content read on a fresh request after the transaction ends.
  if (!options.confirmCommitted) throw new Error('import_commit_confirmation_required')
  const req = await createLocalReq({ req: { ...incoming, context: { ...incoming.context } } }, payload)
  const id = await payload.db.beginTransaction()
  if (!id) throw new Error('legacy_import_requires_transaction')
  req.transactionID = id
  let commitSent = false
  try {
    await lockCmsReferences(payload, req)
    const result = await work(req)
    await requireCmsTransaction(payload, req)
    commitSent = true
    await payload.db.commitTransaction(id)
    if (!await options.confirmCommitted(result)) throw new ImportCommitOutcomeUnknown()
    return result
  } catch (error) {
    if (commitSent) throw new ImportCommitOutcomeUnknown()
    try { await payload.db.rollbackTransaction(id) }
    catch { throw new Error('import_rollback_failed') }
    throw error
  } finally {
    delete req.transactionID
  }
}
