import { sql, type PostgresAdapter } from '@payloadcms/db-postgres'
import { APIError, createLocalReq, type Payload, type PayloadRequest } from 'payload'

export const CMS_REFERENCE_LOCK = 7194030

export type CmsTransactionOptions = { signal?: AbortSignal; deadlineAt?: number }

function remainingBudget(options: CmsTransactionOptions): number | undefined {
  if (options.signal?.aborted) throw new APIError('portal_pages_unavailable', 503, undefined, true)
  if (options.deadlineAt === undefined) return undefined
  if (!Number.isSafeInteger(options.deadlineAt)) throw new APIError('portal_pages_unavailable', 503, undefined, true)
  const remaining = options.deadlineAt - Date.now()
  if (remaining < 1) throw new APIError('portal_pages_unavailable', 503, undefined, true)
  return Math.min(5000, remaining)
}

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

async function setTransactionTimeouts(payload: Payload, req: PayloadRequest, timeoutMs: number) {
  const db = await requireCmsTransaction(payload, req)
  const timeout = `${Math.max(1, Math.floor(timeoutMs))}ms`
  await db.execute(sql`SELECT set_config('lock_timeout', ${timeout}, true)`)
  await db.execute(sql`SELECT set_config('statement_timeout', ${timeout}, true)`)
}

export async function lockCmsReferences(payload: Payload, req: PayloadRequest, timeoutMs?: number) {
  const db = await requireCmsTransaction(payload, req)
  if (timeoutMs === undefined) await db.execute(sql`SET LOCAL lock_timeout = '5s'`)
  else await setTransactionTimeouts(payload, req, timeoutMs)
  await db.execute(sql`SELECT pg_advisory_xact_lock(7194030)`)
  // Native operations retain ownership of this live session, including rollback on failure.
  await requireCmsTransaction(payload, req)
}

/** Standalone helpers own only transactions they start; nested calls retain the same req. */
export async function withCmsTransaction<T>(payload: Payload, incoming: PayloadRequest | undefined,
  work: (req: PayloadRequest) => Promise<T>, options: CmsTransactionOptions = {}): Promise<T> {
  remainingBudget(options)
  if (incoming?.transactionID) {
    await lockCmsReferences(payload, incoming, remainingBudget(options))
    const timeoutAfterLock = remainingBudget(options)
    if (timeoutAfterLock !== undefined) await setTransactionTimeouts(payload, incoming, timeoutAfterLock)
    remainingBudget(options)
    const result = await work(incoming)
    remainingBudget(options)
    return result
  }
  const req = await createLocalReq({ req: incoming ? { ...incoming, context: { ...incoming.context } } : {} }, payload)
  const id = await payload.db.beginTransaction()
  if (!id) throw new APIError('cms_transaction_required', 503, undefined, true)
  req.transactionID = id
  try {
    await lockCmsReferences(payload, req, remainingBudget(options))
    const timeoutAfterLock = remainingBudget(options)
    if (timeoutAfterLock !== undefined) await setTransactionTimeouts(payload, req, timeoutAfterLock)
    remainingBudget(options)
    const result = await work(req)
    remainingBudget(options)
    await requireCmsTransaction(payload, req)
    await payload.db.commitTransaction(id)
    return result
  } catch (error) {
    await payload.db.rollbackTransaction(id)
    throw error
  } finally { delete req.transactionID }
}

export type PublicationTarget = 'news-articles' | 'news-home'

/** Global advisory lock -> fresh Portal authority/actor -> row lock. No independent pool. */
export async function lockPublicationDocument(req: PayloadRequest, target: PublicationTarget, documentId: string) {
  const db = await requireCmsTransaction(req.payload, req)
  if (target === 'news-articles') await db.execute(sql`SELECT id FROM news_articles WHERE id = ${documentId}::uuid FOR UPDATE`)
  else await db.execute(sql`SELECT id FROM news_home FOR UPDATE`)
}

export async function withPublicationTransaction<T>(req: PayloadRequest, target: PublicationTarget,
  documentId: string, operation: (req: PayloadRequest) => Promise<T>): Promise<T> {
  return withCmsTransaction(req.payload, req, async transactionReq => {
    const { assertCmsWriteAuthority } = await import('./authority')
    await assertCmsWriteAuthority(transactionReq)
    await lockPublicationDocument(transactionReq, target, documentId)
    return operation(transactionReq)
  })
}
