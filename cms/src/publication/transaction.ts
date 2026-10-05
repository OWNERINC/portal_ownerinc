import { sql, type PostgresAdapter } from '@payloadcms/db-postgres'
import { APIError, createLocalReq, type Payload, type PayloadRequest } from 'payload'

export const CMS_REFERENCE_LOCK = 7194030

/** Unlike the adapter's getTransaction, this NEVER falls back to a pool connection. */
export async function requireCmsTransaction(payload: Payload, req: PayloadRequest) {
  const id = await req.transactionID
  const adapter = payload.db as unknown as PostgresAdapter
  const session = id ? adapter.sessions?.[id] : undefined
  if (req.payload !== payload || !session?.db || typeof session.db.execute !== 'function') {
    throw new APIError('cms_transaction_required', 503, undefined, true)
  }
  return session.db
}

export async function lockCmsReferences(payload: Payload, req: PayloadRequest) {
  const db = await requireCmsTransaction(payload, req)
  await db.execute(sql`SET LOCAL lock_timeout = '5s'`)
  await db.execute(sql`SELECT pg_advisory_xact_lock(7194030)`)
  // Native operations retain ownership of this live session, including rollback on failure.
  await requireCmsTransaction(payload, req)
}

/** Standalone helpers own only transactions they start; nested calls retain the same req. */
export async function withCmsTransaction<T>(payload: Payload, incoming: PayloadRequest | undefined,
  work: (req: PayloadRequest) => Promise<T>): Promise<T> {
  if (incoming?.transactionID) {
    await lockCmsReferences(payload, incoming)
    return work(incoming)
  }
  const req = await createLocalReq({ req: incoming ? { ...incoming, context: { ...incoming.context } } : {} }, payload)
  const id = await payload.db.beginTransaction()
  if (!id) throw new APIError('cms_transaction_required', 503, undefined, true)
  req.transactionID = id
  try {
    await lockCmsReferences(payload, req)
    const result = await work(req)
    await requireCmsTransaction(payload, req)
    await payload.db.commitTransaction(id)
    return result
  } catch (error) {
    await payload.db.rollbackTransaction(id)
    throw error
  } finally { delete req.transactionID }
}
