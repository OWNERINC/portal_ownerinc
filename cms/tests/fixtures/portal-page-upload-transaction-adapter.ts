import { randomUUID } from 'node:crypto'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { Payload, PayloadRequest } from 'payload'
import { portalPageMediaMutationActor } from '../../src/portal-pages/persistence'
import { createPortalPageStorageKey } from '../../src/portal-pages/validation'

type MediaRow = Record<string, unknown> & { id: string }
type CleanupRow = {
  uploadID: string
  status: 'pending' | 'done'
  nextAttemptAt: number | null
  attemptCount: number
  lastErrorCode: string | null
}
type Savepoint = { rows: Map<string, MediaRow>; queue: Map<string, CleanupRow>; dirty: boolean }
type LockWaiter = { transactionID: string; resolve: () => void }
type LockState = { owner: string | null; waiters: LockWaiter[] }
type Transaction = {
  id: string
  rows: Map<string, MediaRow>
  queue: Map<string, CleanupRow>
  dirty: boolean
  heldLocks: Set<string>
  savepoints: Map<string, Savepoint>
  finished: boolean
  committed: boolean
}
type FixtureSession = {
  db: { execute: (statement: unknown) => Promise<{ rows: Record<string, unknown>[] }> }
  resolve: () => Promise<void>
  reject: () => Promise<void>
}
type CommitOutcome = 'commit' | 'rollback-swallowed' | 'commit-swallowed'
type TraceEvent = {
  sequence: number
  transactionID: string
  kind: 'begin' | 'commit' | 'rollback' | 'sql' | 'advisory-lock' | 'advisory-wait' | 'savepoint'
  sql?: string
  params?: unknown[]
  lockKey?: string
  lockClass?: 'cms-reference' | 'portal-page-upload'
}

function cloneMap<T extends object>(source: Map<string, T>): Map<string, T> {
  return new Map([...source].map(([key, value]) => [key, { ...value }]))
}

function asDate(value: unknown): number {
  const timestamp = value instanceof Date ? value.getTime() : Number(value)
  if (!Number.isFinite(timestamp)) throw new Error('transaction_fixture_invalid_timestamp')
  return timestamp
}

function cloneCleanupRow(row: CleanupRow): CleanupRow { return { ...row } }

/**
 * Deterministic session-bound adapter for the upload service. It intentionally
 * models only the page-media/cleanup tables and the advisory/savepoint SQL used
 * by those operations; unexpected SQL fails loudly instead of using a pool.
 */
export function createPortalPageUploadTransactionAdapter(initialRows: MediaRow[] = []) {
  const rows = new Map(initialRows.map(row => [row.id, { ...row }]))
  const queue = new Map<string, CleanupRow>()
  const sessions: Record<string, FixtureSession> = {}
  const transactions = new Map<string, Transaction>()
  const locks = new Map<string, LockState>()
  const trace: TraceEvent[] = []
  const dialect = new PgDialect()
  let sequence = 0
  let nextID = 0
  let nextBeginListener: ((transactionID: string) => void) | undefined
  let nextAdvisoryWaitListener: ((transactionID: string, lockKey: string) => void) | undefined
  let afterNextCommit: {
    callback: (transactionID: string) => Promise<void>
    predicate: (transactionID: string, committedRows: Map<string, MediaRow>) => boolean
  } | undefined
  let nextCommitOutcome: CommitOutcome = 'commit'
  let failNextSchedule = false

  const event = (transactionID: string, value: Omit<TraceEvent, 'sequence' | 'transactionID'>) => {
    trace.push({ sequence: ++sequence, transactionID, ...value })
  }
  const transactionForRequest = async (req: PayloadRequest): Promise<Transaction> => {
    const id = await req.transactionID
    const transaction = typeof id === 'string' ? transactions.get(id) : undefined
    if (!transaction || sessions[id as string] === undefined) throw new Error('transaction_fixture_session_missing')
    return transaction
  }
  const transactionForSession = (id: string): Transaction => {
    const transaction = transactions.get(id)
    if (!transaction || !sessions[id]) throw new Error('transaction_fixture_session_missing')
    return transaction
  }

  const acquireLock = async (transaction: Transaction, key: string,
    lockClass: 'cms-reference' | 'portal-page-upload') => {
    if (transaction.heldLocks.has(key)) return
    let state = locks.get(key)
    if (!state) {
      state = { owner: null, waiters: [] }
      locks.set(key, state)
    }
    if (state.owner && state.owner !== transaction.id) {
      event(transaction.id, { kind: 'advisory-wait', lockKey: key, lockClass })
      const listener = nextAdvisoryWaitListener
      nextAdvisoryWaitListener = undefined
      listener?.(transaction.id, key)
      await new Promise<void>(resolve => state!.waiters.push({ transactionID: transaction.id, resolve }))
    } else {
      state.owner = transaction.id
      transaction.heldLocks.add(key)
      event(transaction.id, { kind: 'advisory-lock', lockKey: key, lockClass })
    }

    // PostgreSQL READ COMMITTED gives statements after lock acquisition a
    // fresh committed view. Transactions in these helpers do no writes before
    // the shared CMS lock, so refresh their fixture snapshot at that point.
    if (lockClass === 'cms-reference' && !transaction.dirty) {
      transaction.rows = cloneMap(rows)
      transaction.queue = cloneMap(queue)
    }
  }

  const releaseLocks = (transaction: Transaction) => {
    for (const key of transaction.heldLocks) {
      const state = locks.get(key)
      if (!state || state.owner !== transaction.id) continue
      const next = state.waiters.shift()
      if (!next) {
        state.owner = null
        continue
      }
      state.owner = next.transactionID
      const nextTransaction = transactions.get(next.transactionID)
      if (!nextTransaction) throw new Error('transaction_fixture_waiter_missing')
      nextTransaction.heldLocks.add(key)
      const lockClass = key === 'cms-reference' ? 'cms-reference' : 'portal-page-upload'
      event(next.transactionID, { kind: 'advisory-lock', lockKey: key, lockClass })
      next.resolve()
    }
    transaction.heldLocks.clear()
  }

  const snapshot = (transaction: Transaction): Savepoint => ({
    rows: cloneMap(transaction.rows), queue: cloneMap(transaction.queue), dirty: transaction.dirty,
  })
  const restore = (transaction: Transaction, value: Savepoint) => {
    transaction.rows = cloneMap(value.rows)
    transaction.queue = cloneMap(value.queue)
    transaction.dirty = value.dirty
  }

  const execute = async (transactionID: string, statement: unknown) => {
    const transaction = transactionForSession(transactionID)
    const compiled = dialect.sqlToQuery(statement as never)
    const query = compiled.sql.replace(/\s+/gu, ' ').trim()
    const params = [...compiled.params]
    event(transactionID, { kind: 'sql', sql: query, params })

    if (query === 'SET LOCAL lock_timeout = \'5s\'') return { rows: [] }
    if (query === 'SELECT pg_advisory_xact_lock(7194030)') {
      await acquireLock(transaction, 'cms-reference', 'cms-reference')
      return { rows: [] }
    }
    if (query === 'SELECT pg_advisory_xact_lock($1, $2)') {
      if (params.length !== 2 || params.some(value => !Number.isInteger(value) || Number(value) < -2_147_483_648 || Number(value) > 2_147_483_647)) {
        throw new Error('transaction_fixture_invalid_upload_advisory_key')
      }
      const lockKey = `portal-page-upload:${params[0]},${params[1]}`
      await acquireLock(transaction, lockKey, 'portal-page-upload')
      return { rows: [] }
    }
    const savepoint = query.match(/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) ([a-z0-9_]+)$/u)
    if (savepoint) {
      const [, operation, name] = savepoint
      if (operation === 'SAVEPOINT') transaction.savepoints.set(name!, snapshot(transaction))
      else if (operation === 'ROLLBACK TO SAVEPOINT') {
        const value = transaction.savepoints.get(name!)
        if (!value) throw new Error('transaction_fixture_savepoint_missing')
        restore(transaction, value)
      } else transaction.savepoints.delete(name!)
      event(transactionID, { kind: 'savepoint', sql: query })
      return { rows: [] }
    }
    if (query.startsWith('SELECT id, uploaded_by, filesize FROM portal_page_media')) {
      const active = [...transaction.rows.values()].filter(row => row.state === 'uploading')
        .sort((left, right) => String(left.id).localeCompare(String(right.id))).slice(0, 9)
      return { rows: active.map(row => ({ id: row.id, uploaded_by: row.uploadedBy, filesize: row.filesize })) }
    }
    if (query.startsWith('WITH missing AS (') && query.includes('INSERT INTO portal_page_upload_cleanup')) {
      const limit = Number(params[0]), timestamp = asDate(params[1])
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('transaction_fixture_invalid_repair_limit')
      const missing = [...transaction.rows.values()].filter(row => !transaction.queue.has(String(row.id)))
        .sort((left, right) => String(left.id).localeCompare(String(right.id))).slice(0, limit)
      for (const row of missing) transaction.queue.set(String(row.id), {
        uploadID: String(row.id), status: 'pending', nextAttemptAt: timestamp, attemptCount: 0, lastErrorCode: null,
      })
      if (missing.length) transaction.dirty = true
      return { rows: missing.map(row => ({ upload_id: row.id })) }
    }
    if (query.startsWith('SELECT upload_id, attempt_count')) {
      const timestamp = asDate(params[0]), limit = Number(params[1])
      const due = [...transaction.queue.values()].filter(row => row.status === 'pending' && row.nextAttemptAt !== null && row.nextAttemptAt <= timestamp)
        .sort((left, right) => left.nextAttemptAt! - right.nextAttemptAt! || left.uploadID.localeCompare(right.uploadID))
        .slice(0, limit)
      return { rows: due.map(row => ({ upload_id: row.uploadID, attempt_count: row.attemptCount,
        next_attempt_ms: row.nextAttemptAt })) }
    }
    if (query.startsWith('SELECT status, attempt_count, extract(epoch FROM next_attempt_at) * 1000 AS next_attempt_ms')) {
      const id = String(params[0]).toLowerCase()
      const entry = transaction.queue.get(id)
      return { rows: entry ? [{ status: entry.status, attempt_count: entry.attemptCount,
        next_attempt_ms: entry.nextAttemptAt, last_error_code: entry.lastErrorCode }] : [] }
    }
    if (query.startsWith('INSERT INTO portal_page_upload_cleanup')) {
      const id = String(params[0]).toLowerCase(), timestamp = asDate(params[1])
      const existing = transaction.queue.get(id)
      if (!existing) transaction.queue.set(id, { uploadID: id, status: 'pending', nextAttemptAt: timestamp,
        attemptCount: 0, lastErrorCode: null })
      else if (existing.status === 'pending') transaction.queue.set(id, { ...existing,
        nextAttemptAt: Math.min(existing.nextAttemptAt ?? timestamp, timestamp) })
      transaction.dirty = true
      return { rows: [] }
    }
    if (query.startsWith('DELETE FROM portal_page_upload_cleanup')) {
      transaction.queue.delete(String(params[0]).toLowerCase())
      transaction.dirty = true
      return { rows: [] }
    }
    if (query.startsWith('UPDATE portal_page_upload_cleanup SET status = \'done\'')) {
      const id = String(params[0]).toLowerCase(), entry = transaction.queue.get(id)
      if (entry) transaction.queue.set(id, { ...entry, status: 'done', nextAttemptAt: null, lastErrorCode: null })
      transaction.dirty = true
      return { rows: [] }
    }
    if (query.startsWith('UPDATE portal_page_upload_cleanup SET status = \'pending\'')) {
      if (/attempt_count = \$2, last_error_code = \$3/u.test(query)) {
        const id = String(params[3]).toLowerCase()
        const entry = transaction.queue.get(id)
        if (!entry) return { rows: [] }
        transaction.queue.set(id, { ...entry, status: 'pending', nextAttemptAt: asDate(params[0]),
          attemptCount: Number(params[1]), lastErrorCode: String(params[2]) })
        transaction.dirty = true
        return { rows: [] }
      }
      const id = String(params[1]).toLowerCase()
      const entry = transaction.queue.get(id)
      if (!entry) return { rows: [] }
      if (/attempt_count = 0, last_error_code = NULL/u.test(query)) {
        transaction.queue.set(id, { ...entry, status: 'pending', nextAttemptAt: asDate(params[0]),
          attemptCount: 0, lastErrorCode: null })
      } else {
        if (failNextSchedule) {
          failNextSchedule = false
          throw new Error('transaction_fixture_injected_schedule_failure')
        }
        transaction.queue.set(id, { ...entry, status: 'pending', nextAttemptAt: asDate(params[0]), lastErrorCode: null })
      }
      transaction.dirty = true
      return { rows: [] }
    }
    throw new Error(`transaction_fixture_unhandled_sql: ${query}`)
  }

  const payload = {
    config: { admin: { user: 'portal-editors' }, i18n: { fallbackLanguage: 'en' } },
    db: {
      sessions,
      beginTransaction: async () => {
        const id = `upload-tx-${++nextID}`
        const transaction: Transaction = { id, rows: cloneMap(rows), queue: cloneMap(queue), dirty: false,
          heldLocks: new Set(), savepoints: new Map(), finished: false, committed: false }
        transactions.set(id, transaction)
        let resolveReady!: () => void
        let rejectReady!: (error: unknown) => void
        const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
        resolveReady()
        await ready

        let finishTransaction!: (outcome: 'commit' | 'rollback') => void
        const finish = new Promise<'commit' | 'rollback'>(resolve => { finishTransaction = resolve })
        const discard = () => {
          if (transaction.finished) return
          transaction.finished = true
          transactions.delete(id)
          event(id, { kind: 'rollback' })
          releaseLocks(transaction)
        }
        const applyCommit = () => {
          if (transaction.dirty) {
            rows.clear(); for (const [key, row] of transaction.rows) rows.set(key, { ...row })
            queue.clear(); for (const [key, entry] of transaction.queue) queue.set(key, cloneCleanupRow(entry))
          }
          transaction.finished = true
          transaction.committed = true
          transactions.delete(id)
          event(id, { kind: 'commit' })
          releaseLocks(transaction)
        }
        const done = finish.then(outcome => {
          if (outcome === 'rollback') throw new Error('transaction_fixture_explicit_rollback')
          const commitOutcome = nextCommitOutcome
          nextCommitOutcome = 'commit'
          if (commitOutcome === 'rollback-swallowed') throw new Error('transaction_fixture_late_commit_rollback')
          applyCommit()
          if (commitOutcome === 'commit-swallowed') throw new Error('transaction_fixture_lost_commit_receipt')
        }).catch(error => {
          // Installed beginTransaction attaches a catch to Drizzle's completion
          // promise and invokes transactionFailed(error). The readiness promise
          // has already resolved before the session is returned, so this reject
          // is inert and the catch itself fulfills (late failure is swallowed).
          rejectReady(error)
          if (!transaction.finished) discard()
        })
        const session: FixtureSession = {
          db: { execute: statement => execute(id, statement) },
          resolve: async () => {
            finishTransaction('commit')
            await done
            const listener = afterNextCommit
            if (transaction.committed && listener?.predicate(id, rows)) {
              afterNextCommit = undefined
              await listener.callback(id)
            }
          },
          reject: async () => {
            finishTransaction('rollback')
            await done
          },
        }
        sessions[id] = session
        event(id, { kind: 'begin' })
        const listener = nextBeginListener
        nextBeginListener = undefined
        listener?.(id)
        return id
      },
      commitTransaction: async (id: string) => {
        const session = sessions[id]
        if (!session) return
        delete sessions[id]
        // Match @payloadcms/drizzle's installed commitTransaction wrapper.
        try { await session.resolve() }
        catch { await session.reject() }
      },
      rollbackTransaction: async (id: string) => {
        const session = sessions[id]
        if (!session) return
        delete sessions[id]
        await session.reject()
      },
    },
    findByID: async ({ id, req }: { id: string; req: PayloadRequest }) => {
      const transaction = await transactionForRequest(req)
      return transaction.rows.get(String(id)) || null
    },
    create: async ({ data, req }: { data: Record<string, unknown>; req: PayloadRequest }) => {
      const transaction = await transactionForRequest(req)
      const id = randomUUID()
      const uploadedBy = portalPageMediaMutationActor(req) || 'transaction-fixture-actor'
      const row = { id, ...data, storageKey: createPortalPageStorageKey(data.mimeType), uploadedBy,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      transaction.rows.set(id, row)
      transaction.dirty = true
      return row
    },
    update: async ({ id, data, req }: { id: string; data: Record<string, unknown>; req: PayloadRequest }) => {
      const transaction = await transactionForRequest(req)
      const row = transaction.rows.get(id)
      if (!row) throw new Error('transaction_fixture_row_missing')
      Object.assign(row, data)
      transaction.dirty = true
      return row
    },
    delete: async ({ id, req }: { id: string; req: PayloadRequest }) => {
      const transaction = await transactionForRequest(req)
      const row = transaction.rows.get(id)
      transaction.rows.delete(id)
      transaction.dirty = true
      return row
    },
    find: async () => ({ docs: [], hasNextPage: false }),
    findVersions: async () => ({ docs: [], hasNextPage: false }),
  } as unknown as Payload

  const req = () => ({ payload, transactionID: undefined, context: {}, user: null, headers: new Headers(),
    i18n: { t: (key: string) => key }, payloadDataLoader: {}, routeParams: {}, query: {} } as unknown as PayloadRequest)

  return {
    payload,
    req,
    rows,
    queue,
    trace,
    activeSessionIDs: () => Object.keys(sessions),
    waitForNextBegin: () => new Promise<string>(resolve => { nextBeginListener = resolve }),
    waitForNextAdvisoryWait: () => new Promise<{ transactionID: string; lockKey: string }>(resolve => {
      nextAdvisoryWaitListener = (transactionID, lockKey) => resolve({ transactionID, lockKey })
    }),
    afterNextCommit: (callback: (transactionID: string) => Promise<void>,
      predicate: (transactionID: string, committedRows: Map<string, MediaRow>) => boolean = () => true) => {
      afterNextCommit = { callback, predicate }
    },
    loseNextCommitReceipt: () => { nextCommitOutcome = 'commit-swallowed' },
    failNextCommitBeforeApply: () => { nextCommitOutcome = 'rollback-swallowed' },
    failNextCleanupSchedule: () => { failNextSchedule = true },
  }
}
