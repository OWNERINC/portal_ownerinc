import { sql, type PostgresAdapter } from '@payloadcms/db-postgres'
import { APIError, createLocalReq, type Payload, type PayloadRequest } from 'payload'

export const CMS_REFERENCE_LOCK = 7194030

export type CmsTransactionOptions = { signal?: AbortSignal; deadlineAt?: number; snapshotID?: string; now?: () => number }

type CmsPreparedQuery = {
  execute?: (...args: unknown[]) => unknown
  all?: (...args: unknown[]) => unknown
}
type CmsDrizzleSession = {
  prepareQuery: (...args: unknown[]) => CmsPreparedQuery
}
type CmsDrizzleDatabase = {
  execute: (query: unknown) => unknown
  session?: CmsDrizzleSession
}
type CmsReadBudgetState = {
  options: CmsTransactionOptions
  db: CmsDrizzleDatabase
  session: CmsDrizzleSession
  originalPrepareQuery: CmsDrizzleSession['prepareQuery']
  previousPrepareQuery: PropertyDescriptor | undefined
  tail: Promise<void>
  controlMode: boolean
  lastTimeoutMs: number | undefined
  references: number
  failure: unknown
}

const cmsReadBudgetSessions = new WeakMap<object, CmsReadBudgetState>()
const READ_TIMEOUT_CODES = new Set(['40001', '55P03', '57014'])

function hasReadBudget(options: CmsTransactionOptions): boolean {
  return options.signal !== undefined || options.deadlineAt !== undefined
}

function remainingBudget(options: CmsTransactionOptions): number | undefined {
  if (options.signal?.aborted) throw new APIError('portal_pages_unavailable', 503, undefined, true)
  if (options.deadlineAt === undefined) return undefined
  if (!Number.isSafeInteger(options.deadlineAt)) throw new APIError('portal_pages_unavailable', 503, undefined, true)
  const remaining = options.deadlineAt - (options.now?.() ?? Date.now())
  if (remaining < 1) throw new APIError('portal_pages_unavailable', 503, undefined, true)
  return Math.min(5000, remaining)
}

function assertReadBudget(options: CmsTransactionOptions): void {
  remainingBudget(options)
}

function databaseErrorCode(error: unknown): string | null {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    const value = current as { code?: unknown; cause?: unknown; originalError?: unknown }
    if (typeof value.code === 'string') return value.code
    current = value.cause ?? value.originalError
  }
  return null
}

function budgetError(error: unknown, options: CmsTransactionOptions): unknown {
  if (options.signal?.aborted || (options.deadlineAt !== undefined && (options.now?.() ?? Date.now()) >= options.deadlineAt) ||
    READ_TIMEOUT_CODES.has(databaseErrorCode(error) || '')) {
    return new APIError('portal_pages_unavailable', 503, undefined, true)
  }
  return error
}

function readOperationError(error: unknown, options: CmsTransactionOptions): unknown {
  const budgetFailure = budgetError(error, options)
  if (budgetFailure !== error) return budgetFailure
  if (error instanceof APIError && [400, 403, 404, 503].includes(error.status)) return error
  return new APIError('portal_pages_unavailable', 503, undefined, true)
}

/** Guard a Payload-level read before and after it; Drizzle statements are guarded at the session driver boundary below. */
export async function withCmsReadOperation<T>(options: CmsTransactionOptions | undefined,
  operation: () => Promise<T>): Promise<T> {
  if (!options || !hasReadBudget(options)) return operation()
  assertReadBudget(options)
  try {
    const result = await operation()
    assertReadBudget(options)
    return result
  } catch (error) { throw readOperationError(error, options) }
}

function transactionSession(db: CmsDrizzleDatabase): object | null {
  return db.session && typeof db.session === 'object' ? db.session : null
}

function timeoutValue(options: CmsTransactionOptions, previous?: number): string {
  const remaining = remainingBudget(options)
  if (remaining === undefined) throw new APIError('portal_pages_unavailable', 503, undefined, true)
  const current = Math.max(1, Math.floor(remaining))
  return `${previous === undefined ? current : Math.min(current, previous)}ms`
}

async function executeControlQuery(state: CmsReadBudgetState, query: unknown): Promise<unknown> {
  assertReadBudget(state.options)
  let pending: unknown
  try {
    state.controlMode = true
    pending = state.db.execute(query)
  } catch (error) {
    throw readOperationError(error, state.options)
  } finally { state.controlMode = false }
  try {
    const execute = pending && typeof pending === 'object'
      ? (pending as { execute?: () => unknown }).execute : undefined
    const result = await (typeof execute === 'function' ? execute.call(pending) : pending)
    assertReadBudget(state.options)
    return result
  } catch (error) { throw readOperationError(error, state.options) }
}

async function refreshTransactionTimeouts(state: CmsReadBudgetState): Promise<void> {
  const value = timeoutValue(state.options, state.lastTimeoutMs)
  const milliseconds = Number(value.slice(0, -2))
  await executeControlQuery(state, sql`SELECT
    set_config('lock_timeout', ${value}, true),
    set_config('statement_timeout', ${value}, true)`)
  state.lastTimeoutMs = milliseconds
  assertReadBudget(state.options)
}

function runBudgetedDatabaseOperation<T>(state: CmsReadBudgetState, operation: () => T): Promise<T> {
  const result = state.tail.then(async () => {
    try {
      if (state.failure !== undefined) throw state.failure
      assertReadBudget(state.options)
      await refreshTransactionTimeouts(state)
      assertReadBudget(state.options)
      const value = await operation()
      assertReadBudget(state.options)
      return value
    } catch (error) {
      state.failure = readOperationError(error, state.options)
      throw state.failure
    }
  })
  state.tail = result.then(() => undefined, () => undefined)
  return result
}

function installReadBudget(payload: Payload, req: PayloadRequest, options: CmsTransactionOptions,
  db: CmsDrizzleDatabase): CmsReadBudgetState {
  const session = db.session
  if (!session || typeof session.prepareQuery !== 'function') throw new APIError('portal_pages_unavailable', 503, undefined, true)
  const known = cmsReadBudgetSessions.get(session as object)
  if (known) {
    known.options = options
    known.references++
    return known
  }
  const originalPrepareQuery = session.prepareQuery
  const state: CmsReadBudgetState = {
    options, db, session, originalPrepareQuery,
    previousPrepareQuery: Object.getOwnPropertyDescriptor(session, 'prepareQuery'),
    tail: Promise.resolve(), controlMode: false, lastTimeoutMs: undefined, references: 1, failure: undefined,
  }
  const prepareQuery = function (this: unknown, ...args: unknown[]): CmsPreparedQuery {
    const prepared = Reflect.apply(originalPrepareQuery, this, args)
    if (state.controlMode || !prepared || typeof prepared !== 'object') return prepared
    for (const method of ['execute', 'all'] as const) {
      const original = prepared[method]
      if (typeof original !== 'function') continue
      Object.defineProperty(prepared, method, {
        configurable: true,
        writable: true,
        value: function (this: unknown, ...methodArgs: unknown[]) {
          return runBudgetedDatabaseOperation(state, () => Reflect.apply(original, this, methodArgs))
        },
      })
    }
    return prepared
  }
  try {
    Object.defineProperty(session, 'prepareQuery', { configurable: true, writable: true, value: prepareQuery })
  } catch { throw new APIError('portal_pages_unavailable', 503, undefined, true) }
  cmsReadBudgetSessions.set(session as object, state)
  return state
}

function disposeReadBudget(req: PayloadRequest): void {
  const id = req.transactionID
  if (!id) return
  const payload = req.payload as unknown as { db?: { sessions?: Record<string, { db?: CmsDrizzleDatabase }> } }
  const db = payload.db?.sessions?.[String(id)]?.db
  const session = db && transactionSession(db)
  if (!db || !session) return
  const state = cmsReadBudgetSessions.get(session)
  if (!state) return
  state.references--
  if (state.references > 0) return
  try {
    if (state.previousPrepareQuery) Object.defineProperty(session, 'prepareQuery', state.previousPrepareQuery)
    else Reflect.deleteProperty(session, 'prepareQuery')
  } finally { cmsReadBudgetSessions.delete(session) }
}

async function drainReadBudget(req: PayloadRequest): Promise<unknown> {
  const id = req.transactionID
  if (!id) return undefined
  const payload = req.payload as unknown as { db?: { sessions?: Record<string, { db?: CmsDrizzleDatabase }> } }
  const db = payload.db?.sessions?.[String(id)]?.db
  const session = db && transactionSession(db)
  const state = session ? cmsReadBudgetSessions.get(session) : undefined
  if (!state) return undefined
  await state.tail
  return state.failure
}

async function executeTransactionCommand(payload: Payload, req: PayloadRequest, query: unknown,
  options: CmsTransactionOptions): Promise<unknown> {
  assertReadBudget(options)
  try {
    const db = await requireCmsTransaction(payload, req)
    const result = await (db as unknown as CmsDrizzleDatabase).execute(query)
    assertReadBudget(options)
    return result
  } catch (error) { throw readOperationError(error, options) }
}

async function initializeReadTransaction(payload: Payload, req: PayloadRequest, options: CmsTransactionOptions): Promise<void> {
  const statementTimeout = timeoutValue(options)
  await executeTransactionCommand(payload, req, sql.raw(`SET LOCAL statement_timeout = '${statementTimeout}'`), options)
  const lockTimeout = timeoutValue(options, Number(statementTimeout.slice(0, -2)))
  await executeTransactionCommand(payload, req, sql.raw(`SET LOCAL lock_timeout = '${lockTimeout}'`), options)
}

async function importReadSnapshot(payload: Payload, req: PayloadRequest, options: CmsTransactionOptions): Promise<void> {
  if (!options.snapshotID) return
  const snapshotID = options.snapshotID
  if (snapshotID.length > 128 || !/^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$/u.test(snapshotID)) {
    throw new APIError('portal_pages_unavailable', 503, undefined, true)
  }
  await executeTransactionCommand(payload, req,
    sql.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ'), options)
  await executeTransactionCommand(payload, req,
    sql.raw(`SET TRANSACTION SNAPSHOT '${snapshotID}'`), options)
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
  if (!transactionSession(db as unknown as CmsDrizzleDatabase) ||
    !cmsReadBudgetSessions.has(transactionSession(db as unknown as CmsDrizzleDatabase)!)) {
    if (timeoutMs === undefined) await db.execute(sql`SET LOCAL lock_timeout = '5s'`)
    else await setTransactionTimeouts(payload, req, timeoutMs)
  }
  await db.execute(sql`SELECT pg_advisory_xact_lock(7194030)`)
  // Native operations retain ownership of this live session, including rollback on failure.
  await requireCmsTransaction(payload, req)
}

/** Standalone helpers own only transactions they start; nested calls retain the same req. */
export async function withCmsTransaction<T>(payload: Payload, incoming: PayloadRequest | undefined,
  work: (req: PayloadRequest) => Promise<T>, options: CmsTransactionOptions = {}): Promise<T> {
  remainingBudget(options)
  if (incoming?.transactionID) {
    try {
      if (hasReadBudget(options)) {
        const db = await requireCmsTransaction(payload, incoming)
        installReadBudget(payload, incoming, options, db as unknown as CmsDrizzleDatabase)
      }
      await lockCmsReferences(payload, incoming, remainingBudget(options))
      const result = await work(incoming)
      assertReadBudget(options)
      const failure = hasReadBudget(options) ? await drainReadBudget(incoming) : undefined
      if (failure !== undefined) throw failure
      return result
    } catch (error) { throw hasReadBudget(options) ? readOperationError(error, options) : error }
    finally {
      if (hasReadBudget(options)) {
        await drainReadBudget(incoming)
        disposeReadBudget(incoming)
      }
    }
  }
  const req = await createLocalReq({ req: incoming ? { ...incoming, context: { ...incoming.context } } : {} }, payload)
  const id = await payload.db.beginTransaction()
  if (!id) throw new APIError('cms_transaction_required', 503, undefined, true)
  req.transactionID = id
  try {
    if (hasReadBudget(options)) {
      await importReadSnapshot(payload, req, options)
      await initializeReadTransaction(payload, req, options)
      const db = await requireCmsTransaction(payload, req)
      installReadBudget(payload, req, options, db as unknown as CmsDrizzleDatabase)
    }
    await lockCmsReferences(payload, req, remainingBudget(options))
    const result = await work(req)
    assertReadBudget(options)
    const failure = await drainReadBudget(req)
    if (failure !== undefined) throw failure
    await requireCmsTransaction(payload, req)
    disposeReadBudget(req)
    await payload.db.commitTransaction(id)
    return result
  } catch (error) {
    try { await drainReadBudget(req) }
    finally {
      try { disposeReadBudget(req) }
      finally { await payload.db.rollbackTransaction(id) }
    }
    throw hasReadBudget(options) ? readOperationError(error, options) : error
  } finally {
    try { await drainReadBudget(req) }
    finally {
      try { disposeReadBudget(req) }
      finally { delete req.transactionID }
    }
  }
}

/** Hold a short repeatable-read snapshot without the application reference lock across batches. */
export async function withCmsReadSnapshot<T>(payload: Payload, incoming: PayloadRequest | undefined,
  options: CmsTransactionOptions, work: (snapshotID: string) => Promise<T>): Promise<T> {
  assertReadBudget(options)
  const req = await createLocalReq({ req: incoming ? { ...incoming, context: { ...incoming.context }, transactionID: undefined } : {} }, payload)
  const id = await payload.db.beginTransaction()
  if (!id) throw new APIError('cms_transaction_required', 503, undefined, true)
  req.transactionID = id
  try {
    await executeTransactionCommand(payload, req,
      sql.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY'), options)
    await initializeReadTransaction(payload, req, options)
    const db = await requireCmsTransaction(payload, req)
    installReadBudget(payload, req, options, db as unknown as CmsDrizzleDatabase)
    const result = await db.execute(sql`SELECT pg_export_snapshot() AS snapshot_id`)
    assertReadBudget(options)
    const rows = result && typeof result === 'object' ? (result as { rows?: unknown }).rows : undefined
    const snapshotID = Array.isArray(rows) && rows[0] && typeof rows[0] === 'object'
      ? (rows[0] as { snapshot_id?: unknown }).snapshot_id : undefined
    if (typeof snapshotID !== 'string' || snapshotID.length > 128 || !/^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$/u.test(snapshotID)) {
      throw new APIError('portal_pages_unavailable', 503, undefined, true)
    }
    const value = await work(snapshotID)
    assertReadBudget(options)
    return value
  } catch (error) {
    throw readOperationError(error, options)
  } finally {
    try { await drainReadBudget(req) }
    finally {
      try { disposeReadBudget(req) }
      finally {
        try { await payload.db.rollbackTransaction(id) }
        finally { delete req.transactionID }
      }
    }
  }
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
