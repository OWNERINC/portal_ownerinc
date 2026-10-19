import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { Payload, PayloadRequest } from 'payload'
import { portalPageUploadEndpoints } from '../../../src/endpoints/portal-page-uploads'
import { portalPageMediaMutationActor, portalPageUploadAdvisoryKey } from '../../../src/portal-pages/persistence'
import { portalPageUploadRetryDelay, type PortalPageUploadCleanupAdapter, type PortalPageUploadCleanupItem }
  from '../../../src/portal-pages/upload-cleanup-queue'
import { createPortalPageUploadTransactionAdapter } from '../../fixtures/portal-page-upload-transaction-adapter'
import {
  createPortalPageUploadService,
  PORTAL_PAGE_UPLOAD_CHUNK_SIZE,
  PORTAL_PAGE_UPLOAD_MIN_FREE_BYTES,
  PORTAL_PAGE_UPLOAD_RETENTION_MS,
  PortalPageUploadError,
  verifyPortalPageUploadToken,
  writePortalPageBytesFully,
} from '../../../src/portal-pages/upload-service'
import { createPortalPageStorageKey } from '../../../src/portal-pages/validation'
import { withCmsTransaction } from '../../../src/publication/transaction'

const MiB = 1024 * 1024
const actor = 'editor-1'

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (reason?: unknown) => void
  const promise = new Promise<T>((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject })
  return { promise, resolve: (value?: T) => resolvePromise(value as T), reject: (reason?: unknown) => rejectPromise(reason) }
}

function pdfBytes() { return Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n') }
function statementText(query: unknown): string {
  if (!query || typeof query !== 'object' || !Array.isArray((query as { queryChunks?: unknown }).queryChunks)) return ''
  return ((query as { queryChunks: unknown[] }).queryChunks).map(chunk => {
    if (typeof chunk === 'string') return chunk
    if (!chunk || typeof chunk !== 'object') return ''
    const value = (chunk as { value?: unknown }).value
    return Array.isArray(value) ? value.join('') : ''
  }).join('')
}
function mp4Bytes(brand = 'isom') {
  const bytes = Buffer.alloc(24)
  bytes.writeUInt32BE(24, 0); bytes.write('ftyp', 4, 'ascii'); bytes.write(brand, 8, 'ascii')
  bytes.writeUInt32BE(0, 12); bytes.write('isom', 16, 'ascii'); bytes.write('mp42', 20, 'ascii')
  return bytes
}
function webmBytes() { return Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]) }

function mediaRow(id: string, owner: string, state: 'uploading' | 'complete' = 'uploading') {
  return {
    id, originalName: 'arquivo.pdf', storageKey: createPortalPageStorageKey('application/pdf'), mimeType: 'application/pdf',
    filesize: 20, sha256: state === 'complete' ? 'a'.repeat(64) : null, state, uploadedBy: owner,
    completedAt: state === 'complete' ? '2026-10-19T10:20:30.000Z' : null,
  }
}

function assertUploadLockOrder(events: Array<{ transactionID: string; kind: string; lockClass?: string; sequence: number }>) {
  for (const uploadLock of events.filter(event => event.kind === 'advisory-lock' && event.lockClass === 'portal-page-upload')) {
    assert.ok(events.some(event => event.transactionID === uploadLock.transactionID && event.kind === 'advisory-lock' &&
      event.lockClass === 'cms-reference' && event.sequence < uploadLock.sequence),
    `transaction ${uploadLock.transactionID} must acquire the CMS reference lock before its upload advisory lock`)
  }
}

function expectedUploadLockKey(id: string): string {
  return `portal-page-upload:${portalPageUploadAdvisoryKey(id).join(',')}`
}

async function fixture(options: { actorUid?: string; freeBytes?: bigint; statfsFreeBytes?: (directory: string) => Promise<bigint>;
  initialRows?: Record<string, unknown>[]; now?: number } = {}) {
  const parent = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir()
  await mkdir(parent, { recursive: true })
  const uploadDir = await mkdtemp(path.join(parent, 'portal-page-uploads-'))
  const owner = options.actorUid || actor
  const rows = new Map<string, Record<string, unknown>>((options.initialRows || []).map(row => [String(row.id), { ...row }]))
  type QueueRecord = PortalPageUploadCleanupItem & { status: 'pending' | 'done'; lastErrorCode?: string }
  const queue = new Map<string, QueueRecord>()
  for (const id of rows.keys()) queue.set(id, { uploadID: id, attemptCount: 0, nextAttemptAt: Number.MAX_SAFE_INTEGER, status: 'pending' })
  const dialect = new PgDialect()
  const cloneMap = <T extends object>(source: Map<string, T>) => new Map([...source].map(([id, value]) => [id, { ...value }]))
  const transactional = async <T>(work: () => Promise<T>): Promise<T> => {
    const rowSnapshot = cloneMap(rows), queueSnapshot = cloneMap(queue)
    try { return await work() }
    catch (error) {
      rows.clear(); for (const [id, row] of rowSnapshot) rows.set(id, row)
      queue.clear(); for (const [id, entry] of queueSnapshot) queue.set(id, entry)
      throw error
    }
  }
  const cleanupQueueAdapter: PortalPageUploadCleanupAdapter & {
    enqueue: (id: string, next: number) => Promise<void>
    schedule: (id: string, next: number) => Promise<void>
  } = {
    withPassSavepoint: transactional,
    async repairMissing(limit, timestamp) {
      const missing = [...rows.keys()].filter(id => !queue.has(id)).sort().slice(0, limit)
      for (const id of missing) queue.set(id, { uploadID: id, attemptCount: 0, nextAttemptAt: timestamp, status: 'pending' })
      return missing.length
    },
    async claimDue(limit, timestamp) {
      return [...queue.values()].filter(entry => entry.status === 'pending' && entry.nextAttemptAt <= timestamp)
        .sort((left, right) => left.nextAttemptAt - right.nextAttemptAt || left.uploadID.localeCompare(right.uploadID))
        .slice(0, limit).map(({ uploadID, attemptCount, nextAttemptAt }) => ({ uploadID, attemptCount, nextAttemptAt }))
    },
    withSavepoint: (_id, work) => transactional(work),
    async markDone(id) { const entry = queue.get(id); if (entry) queue.set(id, { ...entry, status: 'done', nextAttemptAt: Number.MAX_SAFE_INTEGER }) },
    async remove(id) { queue.delete(id) },
    async reschedule(id, next) {
      const entry = queue.get(id)
      if (entry) queue.set(id, { ...entry, status: 'pending', attemptCount: 0, nextAttemptAt: next, lastErrorCode: undefined })
    },
    async defer(id, attempts, code, next) {
      const entry = queue.get(id)
      if (entry) queue.set(id, { ...entry, status: 'pending', attemptCount: attempts, lastErrorCode: code, nextAttemptAt: next })
    },
    async enqueue(id, next) {
      const entry = queue.get(id)
      if (!entry) queue.set(id, { uploadID: id, attemptCount: 0, nextAttemptAt: next, status: 'pending' })
      else if (entry.status === 'pending') queue.set(id, { ...entry, nextAttemptAt: Math.min(entry.nextAttemptAt, next) })
    },
    async schedule(id, next) {
      const entry = queue.get(id)
      if (entry) queue.set(id, { ...entry, status: 'pending', nextAttemptAt: next, lastErrorCode: undefined })
    },
  }
  const execute = async (query: unknown) => {
    const compiled = dialect.sqlToQuery(query as never)
    const normalized = compiled.sql.replace(/\s+/gu, ' ').trim()
    const params = compiled.params
    if (normalized.startsWith('INSERT INTO portal_page_upload_cleanup')) {
      const id = String(params[0]).toLowerCase()
      const timestamp = params[1] instanceof Date ? params[1].getTime() : Number(params[1])
      if (!queue.has(id)) queue.set(id, { uploadID: id, status: 'pending', attemptCount: 0, nextAttemptAt: timestamp })
      return { rows: [] }
    }
    if (normalized.startsWith('DELETE FROM portal_page_upload_cleanup')) {
      queue.delete(String(params[0]).toLowerCase())
      return { rows: [] }
    }
    if (normalized.startsWith('UPDATE portal_page_upload_cleanup SET status = \'pending\'')) {
      if (normalized.includes('attempt_count = $2, last_error_code = $3')) {
        const id = String(params[3]).toLowerCase()
        const entry = queue.get(id)
        if (entry) queue.set(id, { ...entry, status: 'pending', nextAttemptAt: Number(params[0]),
          attemptCount: Number(params[1]), lastErrorCode: String(params[2]) })
      } else {
        const id = String(params[1]).toLowerCase()
        const entry = queue.get(id)
        if (entry) queue.set(id, { ...entry, status: 'pending', nextAttemptAt: params[0] instanceof Date ? params[0].getTime() : Number(params[0]),
          attemptCount: normalized.includes('attempt_count = 0') ? 0 : entry.attemptCount, lastErrorCode: undefined })
      }
      return { rows: [] }
    }
    if (normalized.startsWith('SELECT status, attempt_count, extract(epoch FROM next_attempt_at) * 1000 AS next_attempt_ms')) {
      const id = String(compiled.params[0]).toLowerCase()
      const entry = queue.get(id)
      return { rows: entry ? [{ status: entry.status, attempt_count: entry.attemptCount,
        next_attempt_ms: entry.nextAttemptAt, last_error_code: entry.lastErrorCode ?? null }] : [] }
    }
    return { rows: [...rows.values()].filter(row => row.state === 'uploading').map(row => ({
      id: row.id, uploaded_by: row.uploadedBy, filesize: row.filesize,
    })) }
  }
  const sessions: Record<string, { db: { execute: (query: unknown) => Promise<unknown> } }> = { live: { db: { execute } } }
  const payload = {
    db: { sessions,
      beginTransaction: async () => { const id = randomUUID(); sessions[id] = sessions.live!; return id },
      commitTransaction: async (id: string) => { delete sessions[id] },
      rollbackTransaction: async (id: string) => { delete sessions[id] },
    },
    findByID: async ({ id }: { id: string }) => rows.get(String(id)) || null,
    create: async ({ data, req }: { data: Record<string, unknown>; req: PayloadRequest }) => {
      const id = randomUUID()
      const uploadedBy = portalPageMediaMutationActor(req) || owner
      const row = { id, ...data, storageKey: createPortalPageStorageKey(data.mimeType), uploadedBy,
        createdAt: '2026-10-19T10:20:30.000Z', updatedAt: '2026-10-19T10:20:30.000Z' }
      rows.set(id, row)
      return row
    },
    update: async ({ id, data }: { id: string; data: Record<string, unknown> }) => {
      const row = rows.get(id)
      if (!row) throw new Error('missing fixture row')
      Object.assign(row, data)
      return row
    },
    delete: async ({ id }: { id: string }) => {
      const row = rows.get(id)
      rows.delete(id)
      return row
    },
    find: async () => ({ docs: [], hasNextPage: false }),
    findVersions: async () => ({ docs: [], hasNextPage: false }),
  } as unknown as Payload
  const req = { payload, transactionID: 'live', context: {}, user: null, headers: new Headers(),
    i18n: { t: (key: string) => key }, payloadDataLoader: {}, routeParams: {}, query: {} } as unknown as PayloadRequest
  let clock = options.now ?? Date.now()
  const service = (serviceActor = owner, serviceReq = { ...req, context: {} } as PayloadRequest,
    overrides: Partial<Parameters<typeof createPortalPageUploadService>[0]> = {}) => createPortalPageUploadService({
    payload, req: serviceReq, actorUid: serviceActor, uploadDir, now: () => clock, cleanupQueueAdapter: () => cleanupQueueAdapter,
    statfsFreeBytes: options.statfsFreeBytes || (async () => options.freeBytes ?? 10n * 1024n * 1024n * 1024n), ...overrides,
  })
  return { uploadDir, rows, queue, payload, req, service, cleanupQueueAdapter,
    setTime: (next: number) => { clock = next }, dispose: () => rm(uploadDir, { recursive: true, force: true }) }
}

async function transactionFixture(options: { actorUid?: string; initialRows?: Record<string, unknown>[]; now?: number } = {}) {
  const parent = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir()
  await mkdir(parent, { recursive: true })
  const uploadDir = await mkdtemp(path.join(parent, 'portal-page-upload-transactions-'))
  const adapter = createPortalPageUploadTransactionAdapter(options.initialRows as Array<Record<string, unknown> & { id: string }> | undefined)
  const owner = options.actorUid || actor
  let clock = options.now ?? Date.now()
  const service = (serviceActor = owner, overrides: Partial<Parameters<typeof createPortalPageUploadService>[0]> = {}) =>
    createPortalPageUploadService({ payload: adapter.payload, req: adapter.req(), actorUid: serviceActor, uploadDir,
      now: () => clock, statfsFreeBytes: async () => 10n * 1024n * 1024n * 1024n, ...overrides })
  return { ...adapter, uploadDir, service, setTime: (next: number) => { clock = next },
    dispose: () => rm(uploadDir, { recursive: true, force: true }) }
}

async function begin(service: ReturnType<typeof createPortalPageUploadService>, data: Buffer, mimeType = 'application/pdf') {
  return service.init({ originalName: 'arquivo', mimeType, bytes: data.length })
}

async function sendChunk(service: ReturnType<typeof createPortalPageUploadService>, id: string, token: string,
  bytes: Buffer, index = '0') {
  return service.putChunk(id, index, new Headers({
    'x-portal-page-upload-token': token,
    'content-type': 'application/octet-stream',
    'content-length': String(bytes.length),
  }), new Response(Uint8Array.from(bytes)).body)
}

async function proveLockOwnerStale(lockPath: string): Promise<void> {
  let deadPID: number | undefined
  for (let offset = 1; offset <= 100; offset++) {
    const candidate = process.pid + 1_000_000 + offset
    try { process.kill(candidate, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') { deadPID = candidate; break }
    }
  }
  assert.ok(deadPID, 'fixture found a PID proven absent by the operating system')
  await writeFile(lockPath, JSON.stringify({ version: 1, pid: deadPID, processInstanceNonce: 'f'.repeat(48),
    processStartIdentity: 'terminated-process-start', createdAt: new Date().toISOString(), nonce: 'c'.repeat(32) }),
  { mode: 0o600 })
}

test('unexpired cleanup reconciles a stale-owner interrupted chunk partial before rescheduling', async t => {
  const now = Date.now()
  const f = await transactionFixture({ now }); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, bytes)
  const incoming = path.join(f.uploadDir, 'portal-pages', '.incoming')
  const partial = path.join(incoming, `${started.id}-0.part`)
  const manifestPath = path.join(incoming, `m-${started.id}.json`)
  const manifestTemp = path.join(incoming, `m-${started.id}.tmp`)
  const lockPath = path.join(incoming, `u-${started.id}.lock`)
  await writeFile(partial, 'interrupted chunk body', { mode: 0o600 })
  await writeFile(manifestTemp, 'interrupted manifest replacement', { mode: 0o600 })
  await proveLockOwnerStale(lockPath)

  assert.deepEqual(await uploads.cleanupExpired(), { removed: 0, unresolved: 0 },
    'unexpired receiving uploads are reconciled and rescheduled without being deleted')
  await assert.rejects(readFile(partial), { code: 'ENOENT' }, 'the stale request-owned partial was removed')
  await assert.rejects(readFile(manifestTemp), { code: 'ENOENT' }, 'the exact incomplete manifest temp was removed')
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'receiving', 'the manifest remains authoritative')
  assert.equal(f.queue.get(started.id)?.nextAttemptAt, now + PORTAL_PAGE_UPLOAD_RETENTION_MS)
  assert.deepEqual(await sendChunk(uploads, started.id, started.token, bytes),
    { id: started.id, index: 0, received: true, duplicate: false, sha256: createHash('sha256').update(bytes).digest('hex') },
    'retrying the interrupted declared index succeeds after cleanup reclaimed the stale owner')
})

test('a different chunk that first reclaims a stale owner cannot strand the interrupted index partial', async t => {
  const f = await transactionFixture(); t.after(f.dispose)
  const uploads = f.service(), bytes = Buffer.alloc(PORTAL_PAGE_UPLOAD_CHUNK_SIZE + 1, 0x41)
  const started = await begin(uploads, bytes)
  assert.equal(started.chunkCount, 2)
  const incoming = path.join(f.uploadDir, 'portal-pages', '.incoming')
  const interrupted = path.join(incoming, `${started.id}-0.part`)
  const lockPath = path.join(incoming, `u-${started.id}.lock`)
  const lastChunk = Buffer.from([0x42])
  await writeFile(interrupted, 'interrupted first index', { mode: 0o600 })
  await proveLockOwnerStale(lockPath)

  await sendChunk(uploads, started.id, started.token, lastChunk, '1')
  await assert.rejects(readFile(interrupted), { code: 'ENOENT' },
    'the first stale-owner reclaimer reconciles every declared index, not only its request index')
  assert.deepEqual(await readFile(path.join(incoming, `${started.id}-1.chunk`)), lastChunk,
    'the newly completed canonical chunk remains intact')
  assert.equal((await sendChunk(uploads, started.id, started.token, bytes.subarray(0, PORTAL_PAGE_UPLOAD_CHUNK_SIZE))).duplicate,
    false, 'retrying the interrupted index succeeds after another index reclaimed the owner')
  assert.deepEqual(await readFile(path.join(incoming, `${started.id}-1.chunk`)), lastChunk,
    'recovery removes partials only and retains completed chunks')
})

test('complete and cancel first reclaimers reconcile stale chunk partials through the shared helper', async t => {
  const completeFixture = await transactionFixture(); t.after(completeFixture.dispose)
  const completeUploads = completeFixture.service(), completeBytes = pdfBytes()
  const completeStarted = await begin(completeUploads, completeBytes)
  const completeIncoming = path.join(completeFixture.uploadDir, 'portal-pages', '.incoming')
  const completePart = path.join(completeIncoming, `${completeStarted.id}-0.part`)
  await writeFile(completePart, 'interrupted before promotion', { mode: 0o600 })
  await proveLockOwnerStale(path.join(completeIncoming, `u-${completeStarted.id}.lock`))

  await assert.rejects(completeUploads.complete(completeStarted.id, { token: completeStarted.token }),
    (error: unknown) => error instanceof PortalPageUploadError && error.code === 'upload_incomplete')
  await assert.rejects(readFile(completePart), { code: 'ENOENT' },
    'complete takes over the stale owner and removes the interrupted non-authoritative part before inspecting chunks')
  await assert.rejects(readFile(path.join(completeIncoming, `r-${completeStarted.id}.lock`)), { code: 'ENOENT' })
  await sendChunk(completeUploads, completeStarted.id, completeStarted.token, completeBytes)
  assert.equal((await completeUploads.complete(completeStarted.id, { token: completeStarted.token })).state, 'complete')

  const cancelFixture = await transactionFixture(); t.after(cancelFixture.dispose)
  const cancelUploads = cancelFixture.service(), cancelBytes = pdfBytes()
  const cancelStarted = await begin(cancelUploads, cancelBytes)
  const cancelIncoming = path.join(cancelFixture.uploadDir, 'portal-pages', '.incoming')
  const cancelPart = path.join(cancelIncoming, `${cancelStarted.id}-0.part`)
  await writeFile(cancelPart, 'interrupted before promotion', { mode: 0o600 })
  await proveLockOwnerStale(path.join(cancelIncoming, `u-${cancelStarted.id}.lock`))

  assert.deepEqual(await cancelUploads.cancel(cancelStarted.id, { token: cancelStarted.token }),
    { id: cancelStarted.id, cancelled: true })
  await assert.rejects(readFile(cancelPart), { code: 'ENOENT' })
  await assert.rejects(readFile(path.join(cancelIncoming, `r-${cancelStarted.id}.lock`)), { code: 'ENOENT' })
  assert.equal(cancelFixture.rows.has(cancelStarted.id), false)
})

test('stale partial recovery preserves validated assembled bytes for ready-to-rename recovery', async t => {
  const f = await transactionFixture(); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, pdfBytes())
  await sendChunk(uploads, started.id, started.token, bytes)
  const incoming = path.join(f.uploadDir, 'portal-pages', '.incoming')
  const manifestPath = path.join(incoming, `m-${started.id}.json`)
  const assembledPath = path.join(incoming, `${started.id}.assembled.part`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await writeFile(manifestPath, JSON.stringify({ ...manifest, state: 'ready_to_rename', finalSha256: sha256 }), { mode: 0o600 })
  await writeFile(assembledPath, bytes, { mode: 0o600 })
  await proveLockOwnerStale(path.join(incoming, `u-${started.id}.lock`))

  assert.deepEqual(await uploads.cleanupExpired(), { removed: 0, unresolved: 0 })
  const row = f.rows.get(started.id)!
  assert.equal(row.state, 'complete')
  assert.equal(row.sha256, sha256)
  assert.deepEqual(await readFile(path.join(f.uploadDir, 'portal-pages', String(row.storageKey))), bytes,
    'the complete assembled recovery source was preserved and promoted to final bytes')
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'renamed')
})

test('stale partial recovery fails closed on an expected symlink and leaves unrelated part entries untouched', async t => {
  const now = Date.now()
  const f = await transactionFixture({ now }); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, bytes)
  const incoming = path.join(f.uploadDir, 'portal-pages', '.incoming')
  const expectedPart = path.join(incoming, `${started.id}-0.part`)
  const unrelatedPart = path.join(incoming, `${randomUUID()}-0.part`)
  const unrelatedNamedPart = path.join(incoming, 'unrelated-upload.part')
  const lockPath = path.join(incoming, `u-${started.id}.lock`)
  const externalDirectory = path.join(f.uploadDir, 'external-part-target')
  const recoveryMarker = path.join(incoming, `r-${started.id}.lock`)
  await mkdir(externalDirectory)
  await writeFile(path.join(externalDirectory, 'target.txt'), 'outside')
  await writeFile(unrelatedNamedPart, 'unrelated bytes')
  let expectedIsSymlink = false
  let unrelatedIsSymlink = false
  try {
    await symlink(externalDirectory, expectedPart, 'junction')
    expectedIsSymlink = true
    await symlink(externalDirectory, unrelatedPart, 'junction')
    unrelatedIsSymlink = true
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code || '')) throw error
    t.diagnostic('symlink/junction creation unavailable on this platform; non-regular expected part still exercises fail-closed handling')
    if (expectedIsSymlink) await rm(expectedPart, { recursive: true, force: true })
    await mkdir(expectedPart)
    await writeFile(unrelatedPart, 'unrelated symlink-shaped name')
  }
  await proveLockOwnerStale(lockPath)

  assert.deepEqual(await uploads.cleanupExpired(), { removed: 0, unresolved: 1 },
    'unsafe expected partial state defers cleanup instead of following or deleting it')
  assert.ok(await lstat(expectedPart), 'the expected non-regular/symlink path is retained for safe retry')
  assert.ok(await lstat(recoveryMarker), 'failed reconciliation preserves durable stale-owner evidence')
  assert.equal(await readFile(unrelatedNamedPart, 'utf8'), 'unrelated bytes')
  if (unrelatedIsSymlink) assert.equal((await lstat(unrelatedPart)).isSymbolicLink(), true)
  else assert.equal(await readFile(unrelatedPart, 'utf8'), 'unrelated symlink-shaped name')

  await rm(expectedPart, { recursive: true, force: true })
  await writeFile(expectedPart, 'safe retry partial', { mode: 0o600 })
  f.queue.get(started.id)!.nextAttemptAt = now
  assert.deepEqual(await uploads.cleanupExpired(), { removed: 0, unresolved: 0 },
    'a later bounded cleanup retry finishes the preserved recovery work')
  await assert.rejects(readFile(expectedPart), { code: 'ENOENT' })
  await assert.rejects(readFile(recoveryMarker), { code: 'ENOENT' }, 'the marker clears only after safe reconciliation completes')
  assert.equal(await readFile(unrelatedNamedPart, 'utf8'), 'unrelated bytes')
  if (unrelatedIsSymlink) assert.equal((await lstat(unrelatedPart)).isSymbolicLink(), true)
  else assert.equal(await readFile(unrelatedPart, 'utf8'), 'unrelated symlink-shaped name')
})

test('chunk ingress stores only a token hash, validates owner/token, and permits only exact hash-identical duplicates', async t => {
  const f = await fixture(); t.after(f.dispose)
  const uploads = f.service()
  const bytes = pdfBytes(), started = await begin(uploads, bytes)
  assert.equal(started.chunkSize, PORTAL_PAGE_UPLOAD_CHUNK_SIZE)
  assert.equal(verifyPortalPageUploadToken(started.token, createHash('sha256').update(started.token).digest('hex')), true)
  assert.equal(verifyPortalPageUploadToken('wrong-token', createHash('sha256').update(started.token).digest('hex')), false)
  const manifestPath = path.join(f.uploadDir, 'portal-pages', '.incoming', `m-${started.id}.json`)
  const manifestText = await readFile(manifestPath, 'utf8')
  const manifest = JSON.parse(manifestText) as Record<string, unknown>
  assert.equal(manifest.tokenHash, createHash('sha256').update(started.token).digest('hex'))
  assert.equal(manifestText.includes(started.token), false)
  assert.equal(manifest.actorUid, actor)

  await assert.rejects(sendChunk(uploads, started.id, 'wrong-token', bytes), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'invalid_upload_token')

  let interruptedFirstPull = true
  const interrupted = new ReadableStream<Uint8Array>({ pull(controller) {
    if (interruptedFirstPull) {
      interruptedFirstPull = false
      controller.enqueue(new Uint8Array(bytes.subarray(0, 5)))
      return
    }
    controller.error(new Error('client disconnected'))
  } })
  await assert.rejects(uploads.putChunk(started.id, '0', new Headers({
    'x-portal-page-upload-token': started.token, 'content-type': 'application/octet-stream', 'content-length': String(bytes.length),
  }), interrupted))
  const incoming = path.join(f.uploadDir, 'portal-pages', '.incoming')
  assert.equal((await readdir(incoming)).includes(`${started.id}-0.part`), false, 'interrupted partial is removed')
  assert.equal((await readdir(incoming)).some(name => name.endsWith('.lock')), false, 'request lock is released')

  assert.equal((await sendChunk(uploads, started.id, started.token, bytes)).duplicate, false)
  assert.equal((await sendChunk(uploads, started.id, started.token, bytes)).duplicate, true)
  const conflict = Buffer.from(bytes); conflict[conflict.length - 1] ^= 1
  await assert.rejects(sendChunk(uploads, started.id, started.token, conflict), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'chunk_conflict' && error.status === 409)
  assert.equal((await readFile(path.join(incoming, `${started.id}-0.chunk`))).equals(bytes), true)
})

test('chunk body cleanup is exclusive and crash recovery removes only the validated deterministic partial', async t => {
  const f = await transactionFixture(); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, bytes)
  const incoming = path.join(f.uploadDir, 'portal-pages', '.incoming')
  const partial = path.join(incoming, `${started.id}-0.part`)
  const unrelated = path.join(incoming, 'unrelated.part')

  await writeFile(partial, 'not-created-by-this-request', { mode: 0o600 })
  await assert.rejects(sendChunk(uploads, started.id, started.token, bytes), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'upload_busy')
  assert.equal(await readFile(partial, 'utf8'), 'not-created-by-this-request',
    'exclusive-create failure never removes a partial the request did not create')
  await rm(partial)

  const expectedLength = String(bytes.length)
  const headers = new Headers({ 'x-portal-page-upload-token': started.token,
    'content-type': 'application/octet-stream', 'content-length': expectedLength })
  await assert.rejects(uploads.putChunk(started.id, '0', headers,
    new Response(Uint8Array.from(bytes.subarray(0, bytes.length - 1))).body), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'invalid_chunk_size')
  assert.equal((await readdir(incoming)).includes(`${started.id}-0.part`), false, 'short owned body removes its exact partial')
  await assert.rejects(uploads.putChunk(started.id, '0', headers,
    new Response(Uint8Array.from(Buffer.concat([bytes, Buffer.from([0])]))).body), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'invalid_chunk_size')
  assert.equal((await readdir(incoming)).includes(`${started.id}-0.part`), false, 'oversized owned body removes its exact partial')

  let deadPID: number | undefined
  for (let offset = 1; offset <= 10; offset++) {
    const candidate = process.pid + 1_000_000 + offset
    try { process.kill(candidate, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') { deadPID = candidate; break }
    }
  }
  assert.ok(deadPID, 'fixture found a PID proven absent by the operating system')
  await writeFile(path.join(incoming, `u-${started.id}.lock`), JSON.stringify({ version: 1, pid: deadPID,
    processInstanceNonce: 'f'.repeat(48), processStartIdentity: 'crashed-process',
    createdAt: new Date().toISOString(), nonce: 'c'.repeat(32) }), { mode: 0o600 })
  await writeFile(partial, 'crashed partial body', { mode: 0o600 })
  await writeFile(unrelated, 'untouched')

  assert.equal((await sendChunk(uploads, started.id, started.token, bytes)).duplicate, false)
  assert.deepEqual(await readFile(path.join(incoming, `${started.id}-0.chunk`)), bytes,
    'a process-identity-proven stale owner permits recovery of the exact canonical partial')
  assert.equal((await readdir(incoming)).includes(`${started.id}-0.part`), false)
  assert.equal(await readFile(unrelated, 'utf8'), 'untouched', 'crash cleanup does not discover or delete arbitrary partial names')
})

test('completion streams immutable bytes, confirms fresh metadata, and defers a concurrent caller while owned', async t => {
  const f = await transactionFixture(); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, bytes)
  await sendChunk(uploads, started.id, started.token, bytes)
  const firstContext = f.service()
  const concurrentUploads = f.service()
  const traceStart = f.trace.length
  const firstCommit = deferred<void>(), continueFirst = deferred<void>()
  f.afterNextCommit(async () => { firstCommit.resolve(); await continueFirst.promise },
    (_transactionID, committedRows) => committedRows.get(started.id)?.state === 'complete')
  const firstPromise = firstContext.complete(started.id, { token: started.token })
  await firstCommit.promise
  await assert.rejects(concurrentUploads.complete(started.id, { token: started.token }), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'upload_busy' && error.status === 409)
  continueFirst.resolve()
  const first = await firstPromise
  const second = await concurrentUploads.complete(started.id, { token: started.token })
  assert.deepEqual(first, second)
  assert.equal(first.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(first.bytes, bytes.length)
  assert.equal(f.rows.get(started.id)?.state, 'complete')
  assert.equal(f.rows.get(started.id)?.sha256, first.sha256)
  const row = f.rows.get(started.id)!
  const finalPath = path.join(f.uploadDir, 'portal-pages', String(row.storageKey))
  assert.deepEqual(await readFile(finalPath), bytes)
  const incoming = await readdir(path.join(f.uploadDir, 'portal-pages', '.incoming'))
  assert.ok(incoming.includes(`m-${started.id}.json`), 'token hash remains available for verified concurrent retries')
  assert.equal(incoming.some(name => name === `${started.id}-0.chunk`), false)
  const completedLockEvents = f.trace.slice(traceStart).filter(event => event.kind === 'advisory-lock' &&
    event.lockClass === 'portal-page-upload')
  assert.equal(completedLockEvents.length, 5, 'complete, busy competitor, retry, and fresh confirmations use the production upload lock')
  assert.ok(completedLockEvents.every(event => event.lockKey === expectedUploadLockKey(started.id)))
  assert.equal(new Set(completedLockEvents.map(event => event.transactionID)).size, 5)
  assert.equal(f.activeSessionIDs().length, 0)
  await assert.rejects(uploads.cancel(started.id, { token: started.token }), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'media_already_complete')
})

test('completion validates only exact manifest chunk paths despite more than 1024 unrelated entries', async t => {
  const f = await fixture(); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, bytes)
  await sendChunk(uploads, started.id, started.token, bytes)
  const incoming = path.join(f.uploadDir, 'portal-pages', '.incoming')
  const unknownChunkName = `${started.id}-9.chunk`
  await writeFile(path.join(incoming, unknownChunkName), 'untrusted-unknown-index')
  for (let index = 0; index < 1050; index++) {
    await writeFile(path.join(incoming, `unrelated-${index}.tmp`), 'retained')
  }

  const completed = await uploads.complete(started.id, { token: started.token })
  assert.equal(completed.bytes, bytes.length)
  assert.deepEqual(await readFile(path.join(f.uploadDir, 'portal-pages', String(f.rows.get(started.id)!.storageKey))), bytes)
  assert.equal(await readFile(path.join(incoming, unknownChunkName), 'utf8'), 'untrusted-unknown-index',
    'an undeclared chunk-like path is neither trusted nor deleted')
  assert.equal((await readdir(incoming)).filter(name => name.startsWith('unrelated-')).length, 1050,
    'unrelated retained entries are not enumerated or removed by completion')
})

test('cleanup defers at the committed-init/pre-manifest window while init retains filesystem ownership', async t => {
  const f = await transactionFixture(); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes()
  const committed = deferred<string>()
  const continueInit = deferred<void>()
  f.afterNextCommit(async transactionID => {
    committed.resolve(transactionID)
    await continueInit.promise
  }, (_transactionID, committedRows) => committedRows.size === 1)

  const initPromise = begin(uploads, bytes)
  const ownerTransaction = await committed.promise
  const id = [...f.rows.keys()][0]!
  const incoming = path.join(f.uploadDir, 'portal-pages', '.incoming')
  const manifestPath = path.join(incoming, `m-${id}.json`)
  const lockPath = path.join(incoming, `u-${id}.lock`)
  assert.ok(f.rows.has(id), 'media row committed before manifest publication')
  assert.deepEqual(f.queue.get(id)?.status, 'pending', 'the cleanup index committed with metadata')
  await assert.rejects(readFile(manifestPath), { code: 'ENOENT' }, 'manifest publication has not started')
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid,
    'init still owns the recovery-safe filesystem lock after database commit')

  const cleanup = await uploads.cleanupExpired()
  assert.deepEqual(cleanup, { removed: 0, unresolved: 1 }, 'cleanup records a bounded retry instead of racing init')
  assert.ok(f.rows.has(id), 'cleanup did not delete the committed media row')
  const deferredUntil = f.queue.get(id)!.nextAttemptAt
  assert.ok(deferredUntil !== null && deferredUntil > Date.now(), 'cleanup defers the live owner')
  assert.equal(f.queue.get(id)?.attemptCount, 1)
  assert.equal(f.queue.get(id)?.lastErrorCode, 'cleanup_failed')
  assert.ok(deferredUntil! <= Date.now() + portalPageUploadRetryDelay(1), 'init accepts only the bounded sanitized deferral')
  await assert.rejects(readFile(manifestPath), { code: 'ENOENT' })
  assert.ok(f.trace.some(event => event.transactionID === ownerTransaction && event.kind === 'commit'))
  assertUploadLockOrder(f.trace)
  assert.ok(f.trace.some(event => event.transactionID === ownerTransaction && event.kind === 'advisory-lock' &&
    event.lockClass === 'portal-page-upload' && event.lockKey === expectedUploadLockKey(id)),
  'init took the production upload lock before creating its filesystem owner')
  assert.ok(f.trace.some(event => event.kind === 'advisory-lock' && event.lockClass === 'portal-page-upload' &&
    event.lockKey === expectedUploadLockKey(id)), 'cleanup used the same upload advisory key before observing the live owner')

  continueInit.resolve()
  const started = await initPromise
  assert.equal(started.id, id)
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).id, id,
    'the same owner publishes the atomic manifest before releasing its lock')
  assert.ok(f.rows.has(id))
  assert.deepEqual(f.activeSessionIDs(), [])
})

test('cleanup recovers a committed init after its filesystem owner process disappears', async t => {
  const f = await transactionFixture(); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes()
  const committed = deferred<string>()
  const simulateCrash = deferred<void>()
  f.afterNextCommit(async transactionID => {
    const id = [...f.rows.keys()][0]!
    const lockPath = path.join(f.uploadDir, 'portal-pages', '.incoming', `u-${id}.lock`)
    const lock = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>
    let deadPID: number | undefined
    for (let offset = 1; offset <= 10; offset++) {
      const candidate = process.pid + 1_000_000 + offset
      try { process.kill(candidate, 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') { deadPID = candidate; break }
      }
    }
    assert.ok(deadPID, 'fixture found a PID proven absent by the operating system')
    await writeFile(lockPath, JSON.stringify({ ...lock, pid: deadPID, processInstanceNonce: 'f'.repeat(48),
      processStartIdentity: 'terminated-process-start' }), { mode: 0o600 })
    committed.resolve(transactionID)
    await simulateCrash.promise
  }, (_transactionID, committedRows) => committedRows.size === 1)

  const initPromise = begin(uploads, bytes)
  const initTransaction = await committed.promise
  const id = [...f.rows.keys()][0]!
  const lockPath = path.join(f.uploadDir, 'portal-pages', '.incoming', `u-${id}.lock`)
  assert.equal(f.rows.get(id)?.state, 'uploading')
  assert.equal(f.queue.get(id)?.status, 'pending')
  const recovered = await uploads.cleanupExpired()
  assert.deepEqual(recovered, { removed: 1, unresolved: 0 }, 'cleanup reclaims the proven-dead owner and reconciles no-manifest init')
  assert.equal(f.rows.has(id), false)
  assert.equal(f.queue.has(id), false)
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' })
  await assert.rejects(readFile(path.join(f.uploadDir, 'portal-pages', '.incoming', `m-${id}.json`)), { code: 'ENOENT' })

  simulateCrash.reject(new Error('simulated_process_exit_after_commit'))
  await assert.rejects(initPromise, 'the interrupted initializer cannot resume and return a token')
  assert.ok(f.trace.some(event => event.transactionID === initTransaction && event.kind === 'commit'))
  assert.deepEqual(f.activeSessionIDs(), [])
})

test('cancellation retains filesystem ownership through delete commit and fresh confirmation', async t => {
  const f = await transactionFixture(); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, bytes)
  const firstCommit = deferred<string>()
  const continueCancel = deferred<void>()
  const traceStart = f.trace.length
  f.afterNextCommit(async transactionID => {
    firstCommit.resolve(transactionID)
    await continueCancel.promise
  })

  const cancelPromise = uploads.cancel(started.id, { token: started.token })
  const firstTransactionID = await firstCommit.promise
  const incoming = path.join(f.uploadDir, 'portal-pages', '.incoming')
  const lockPath = path.join(incoming, `u-${started.id}.lock`)
  const manifestPath = path.join(incoming, `m-${started.id}.json`)
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'cancelling')
  assert.equal(f.rows.get(started.id)?.state, 'uploading')
  assert.ok(f.queue.has(started.id), 'the first cancellation commit retains durable cleanup work')
  assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid,
    'the cancellation filesystem owner remains while its first database session is already committed')

  const cleanup = await uploads.cleanupExpired()
  assert.deepEqual(cleanup, { removed: 0, unresolved: 1 }, 'cleanup defers rather than overlapping cancellation file removal')
  assert.equal(f.rows.get(started.id)?.state, 'uploading')
  assert.ok(f.queue.get(started.id)!.nextAttemptAt! > Date.now())
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'cancelling')

  continueCancel.resolve()
  assert.deepEqual(await cancelPromise, { id: started.id, cancelled: true })
  assert.equal(f.rows.has(started.id), false)
  assert.equal(f.queue.has(started.id), false)
  await assert.rejects(readFile(manifestPath), { code: 'ENOENT' })
  const cancelEvents = f.trace.slice(traceStart).filter(event => event.kind === 'advisory-lock' && event.lockClass === 'portal-page-upload' &&
    event.lockKey === expectedUploadLockKey(started.id))
  assert.equal(cancelEvents.length, 4, 'first cancel phase, racing cleanup, delete phase, and fresh confirmation each use the upload key')
  assertUploadLockOrder(f.trace)
  assert.notEqual(cancelEvents[0]!.transactionID, cancelEvents[2]!.transactionID)
  assert.ok(f.trace.some(event => event.kind === 'commit' && event.transactionID === firstTransactionID))
  assert.deepEqual(f.activeSessionIDs(), [])
})

test('paused chunk body holds no database locks while unrelated CMS work completes and same-upload work defers', async t => {
  const f = await transactionFixture(); t.after(f.dispose)
  const setup = f.service(), bytes = pdfBytes(), started = await begin(setup, bytes)
  const paused = deferred<void>(), resume = deferred<void>()
  let didPull = false
  const rawBody = new ReadableStream<Uint8Array>({ async pull(controller) {
    if (didPull) return
    didPull = true
    paused.resolve()
    await resume.promise
    controller.enqueue(Uint8Array.from(bytes))
    controller.close()
  } })
  const ingress = f.service()
  const putPromise = ingress.putChunk(started.id, '0', new Headers({
    'x-portal-page-upload-token': started.token, 'content-type': 'application/octet-stream',
    'content-length': String(bytes.length),
  }), rawBody)
  await paused.promise

  assert.deepEqual(f.activeSessionIDs(), [], 'the body phase retains no Payload database session')
  const unrelatedTransaction = await withCmsTransaction(f.payload, f.req(), async transactionReq =>
    transactionReq.transactionID)
  assert.equal(typeof unrelatedTransaction, 'string')
  assert.deepEqual(f.activeSessionIDs(), [], 'an unrelated CMS reference transaction finishes during the paused body')

  assert.deepEqual(await ingress.cleanupExpired(), { removed: 0, unresolved: 1 },
    'cleanup records a bounded deferral instead of waiting on the live filesystem owner')
  await assert.rejects(ingress.complete(started.id, { token: started.token }), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'upload_busy' && error.status === 409)
  await assert.rejects(ingress.cancel(started.id, { token: started.token }), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'upload_busy' && error.status === 409)
  const partial = path.join(f.uploadDir, 'portal-pages', '.incoming', `${started.id}-0.part`)
  assert.equal((await stat(partial)).size, 0, 'same-upload competitors leave the request-owned partial untouched')
  assert.deepEqual(f.activeSessionIDs(), [], 'competing operations do not retain database sessions while deferred')

  resume.resolve()
  const result = await putPromise
  assert.equal(result.duplicate, false)
  assert.deepEqual(await readFile(path.join(f.uploadDir, 'portal-pages', '.incoming', `${started.id}-0.chunk`)), bytes)
  await assert.rejects(readFile(partial), { code: 'ENOENT' })
  assert.deepEqual(f.activeSessionIDs(), [])
})

test('two independent stale-lock reclaimers cannot remove or overlap a newly established live owner', async t => {
  const f = await transactionFixture(); t.after(f.dispose)
  const initService = f.service(), bytes = pdfBytes(), started = await begin(initService, bytes)
  const incoming = path.join(f.uploadDir, 'portal-pages', '.incoming')
  const lockPath = path.join(incoming, `u-${started.id}.lock`)
  const stalePath = await writeFile(lockPath, '{stale}', { mode: 0o600 }).then(() => lockPath)
  const oldTime = new Date(Date.now() - 2 * PORTAL_PAGE_UPLOAD_RETENTION_MS)
  await utimes(stalePath, oldTime, oldTime)

  const chunkWriteStarted = deferred<string>()
  const releaseChunkWrite = deferred<void>()
  const first = f.service(actor, { fileHandleWrite: async (handle, data, purpose) => {
    if (purpose === 'chunk') {
      const ownerText = await readFile(lockPath, 'utf8')
      chunkWriteStarted.resolve(ownerText)
      await releaseChunkWrite.promise
    }
    await writePortalPageBytesFully(handle, data)
  } })
  const traceStart = f.trace.length
  const firstPromise = sendChunk(first, started.id, started.token, bytes)
  const establishedOwnerText = await chunkWriteStarted.promise
  const establishedOwner = JSON.parse(establishedOwnerText) as { nonce: string; pid: number }
  assert.equal(establishedOwner.pid, process.pid)
  const secondStarted = f.waitForNextBegin()
  const second = f.service()
  const secondPromise = sendChunk(second, started.id, started.token, bytes)
  const secondTransaction = await secondStarted

  assert.equal(await readFile(lockPath, 'utf8'), establishedOwnerText,
    'the second context cannot check-then-unlink the just-published live owner')
  await assert.rejects(secondPromise, (error: unknown) => error instanceof PortalPageUploadError && error.code === 'upload_busy')
  assert.equal(f.trace.some(event => event.transactionID === secondTransaction && event.kind === 'advisory-lock' &&
    event.lockClass === 'portal-page-upload'), true, 'the short phase-A transaction reaches the upload key, then defers at the live file owner')
  assertUploadLockOrder(f.trace.slice(traceStart))

  releaseChunkWrite.resolve()
  const firstResult = await firstPromise
  assert.equal(firstResult.duplicate, false)
  const secondResult = await sendChunk(second, started.id, started.token, bytes)
  assert.equal(secondResult.duplicate, true, 'an identical retry remains a duplicate success after ownership is released')
  const uploadLocks = f.trace.slice(traceStart).filter(event => event.kind === 'advisory-lock' &&
    event.lockClass === 'portal-page-upload')
  assert.equal(uploadLocks.length, 7, 'phase-A, phase-C, confirmation, and the deferred competitor all use the production upload-lock helper')
  assert.ok(uploadLocks.every(event => event.lockKey === expectedUploadLockKey(started.id)))
  assert.notEqual(uploadLocks[0]!.transactionID, uploadLocks[1]!.transactionID)
  assert.deepEqual(f.activeSessionIDs(), [])
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' }, 'the completed operations release their owners')
})

test('format checks validate decoded images and bounded PDF/MP4/WebM structure while rejecting QuickTime bytes', async t => {
  const f = await fixture(); t.after(f.dispose)
  const uploads = f.service()
  const imageFixtures: Array<[string, Buffer]> = []
  for (const format of ['jpeg', 'png', 'webp'] as const) {
    imageFixtures.push([`image/${format}`, await sharp({ create: { width: 2, height: 2, channels: 3, background: '#234567' } }).toFormat(format).toBuffer()])
  }
  const fixtures: Array<[string, Buffer]> = [
    ...imageFixtures,
    ['application/pdf', pdfBytes()],
    ['video/mp4', mp4Bytes()],
    ['video/webm', webmBytes()],
  ]
  for (const [mimeType, bytes] of fixtures) {
    const started = await begin(uploads, bytes, mimeType)
    await sendChunk(uploads, started.id, started.token, bytes)
    const result = await uploads.complete(started.id, { token: started.token })
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'), mimeType)
    assert.deepEqual(await readFile(path.join(f.uploadDir, 'portal-pages', String(f.rows.get(started.id)!.storageKey))), bytes)
  }

  const quickTime = mp4Bytes('qt  ')
  const rejected = await begin(uploads, quickTime, 'video/mp4')
  await sendChunk(uploads, rejected.id, rejected.token, quickTime)
  await assert.rejects(uploads.complete(rejected.id, { token: rejected.token }), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'invalid_media_file')
  assert.equal(f.rows.get(rejected.id)?.state, 'uploading')
  await uploads.cancel(rejected.id, { token: rejected.token })
  await assert.rejects(uploads.init({ originalName: 'video.mov', mimeType: 'video/quicktime', bytes: 10 }),
    (error: unknown) => error instanceof PortalPageUploadError && error.code === 'unsupported_media')
})

test('high-bit corruption in fixed media signatures is never normalized into an accepted format', async t => {
  const f = await fixture(); t.after(f.dispose)
  const uploads = f.service()
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#234567' } }).png().toBuffer()
  const webp = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#234567' } }).webp().toBuffer()
  const cases: Array<[string, string, Buffer, number]> = [
    ['JPEG SOI', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0x00]), 0],
    ['PNG magic', 'image/png', png, 0],
    ['WebP RIFF', 'image/webp', webp, 0],
    ['WebP form type', 'image/webp', webp, 8],
    ['PDF header', 'application/pdf', pdfBytes(), 0],
    ['MP4 ftyp', 'video/mp4', mp4Bytes(), 4],
    ['MP4 brand', 'video/mp4', mp4Bytes(), 8],
    ['EBML ID', 'video/webm', webmBytes(), 0],
    ['WebM DocType', 'video/webm', webmBytes(), 8],
  ]
  for (const [label, mimeType, validBytes, offset] of cases) await t.test(label, async () => {
    const corrupted = Buffer.from(validBytes)
    corrupted[offset] = corrupted[offset]! ^ 0x80
    const started = await begin(uploads, corrupted, mimeType)
    await sendChunk(uploads, started.id, started.token, corrupted)
    let failure: unknown
    try { await uploads.complete(started.id, { token: started.token }) }
    catch (error) { failure = error }
    assert.ok(failure instanceof PortalPageUploadError && failure.code === 'invalid_media_file',
      `${label} corruption must be rejected`)
    if (f.rows.get(started.id)?.state === 'uploading') await uploads.cancel(started.id, { token: started.token })
  })
})

test('process-aware locks atomically publish complete content, detect PID reuse, and retain a live old lock', async t => {
  const f = await fixture(); t.after(f.dispose)
  const setup = f.service(), bytes = pdfBytes(), stale = await begin(setup, bytes)
  const incoming = path.join(f.uploadDir, 'portal-pages', '.incoming')
  const lockPath = path.join(incoming, `u-${stale.id}.lock`)
  const old = {
    version: 1, pid: process.pid, processInstanceNonce: 'a'.repeat(48), processStartIdentity: 'old-process-start',
    createdAt: new Date(Date.now() - 2 * PORTAL_PAGE_UPLOAD_RETENTION_MS).toISOString(), nonce: 'c'.repeat(32),
  }
  const oldLockJSON = JSON.stringify(old)
  await writeFile(lockPath, oldLockJSON, { mode: 0o600 })
  let canonicalAbsentDuringTempWrite = false
  const current = f.service(actor, undefined, {
    processInstanceNonce: 'b'.repeat(48), processStartIdentity: 'current-process-start',
    readProcessIdentity: async () => 'current-process-start',
    fileHandleWrite: async (handle, data, purpose) => {
      if (purpose === 'lock') {
        const visible = await readFile(lockPath, 'utf8').catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        })
        if (visible === null) canonicalAbsentDuringTempWrite = true
        else assert.equal(visible, oldLockJSON, 'the old complete lock is removed only after process identity proves it stale')
      }
      await writePortalPageBytesFully(handle, data)
    },
  })
  await sendChunk(current, stale.id, stale.token, bytes)
  assert.equal(canonicalAbsentDuringTempWrite, true, 'lock bytes are fully written to a temp inode before canonical publication')
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' })

  const live = await begin(setup, bytes)
  const liveLockPath = path.join(incoming, `u-${live.id}.lock`)
  const liveOwner = { ...old, processInstanceNonce: 'b'.repeat(48), processStartIdentity: 'current-process-start' }
  await writeFile(liveLockPath, JSON.stringify(liveOwner), { mode: 0o600 })
  const oldTime = new Date(Date.now() - 2 * PORTAL_PAGE_UPLOAD_RETENTION_MS)
  await utimes(liveLockPath, oldTime, oldTime)
  const sameInstance = f.service(actor, undefined, {
    processInstanceNonce: 'b'.repeat(48), processStartIdentity: 'current-process-start',
    readProcessIdentity: async () => 'current-process-start',
  })
  await assert.rejects(sendChunk(sameInstance, live.id, live.token, bytes), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'upload_busy')
  assert.deepEqual(JSON.parse(await readFile(liveLockPath, 'utf8')), liveOwner,
    'a current process instance is not stolen because the lock is old')
  await current.cancel(stale.id, { token: stale.token })
  await rm(liveLockPath, { force: true })
  await sameInstance.cancel(live.id, { token: live.token })

  const interrupted = await begin(setup, bytes)
  const tempPath = path.join(incoming, `u-${interrupted.id}.tmp`)
  await writeFile(tempPath, oldLockJSON, { mode: 0o600 })
  await sendChunk(current, interrupted.id, interrupted.token, bytes)
  await assert.rejects(readFile(tempPath), { code: 'ENOENT' })
})

test('empty canonical locks are busy until their stale grace expires, then safely recovered', async t => {
  const f = await fixture(); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, bytes)
  const lockPath = path.join(f.uploadDir, 'portal-pages', '.incoming', `u-${started.id}.lock`)
  await writeFile(lockPath, '', { mode: 0o600 })
  await assert.rejects(sendChunk(uploads, started.id, started.token, bytes), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'upload_busy')
  assert.equal((await stat(lockPath)).size, 0, 'a recent partial legacy lock is preserved')
  const unrelated = await begin(uploads, bytes)
  await sendChunk(uploads, unrelated.id, unrelated.token, bytes)
  assert.equal((await readFile(path.join(f.uploadDir, 'portal-pages', '.incoming', `${unrelated.id}-0.chunk`))).length, bytes.length,
    'one upload’s partial lock does not block an unrelated upload ID')
  await uploads.cancel(unrelated.id, { token: unrelated.token })
  const oldTime = new Date(Date.now() - 2 * PORTAL_PAGE_UPLOAD_RETENTION_MS)
  await utimes(lockPath, oldTime, oldTime)
  await sendChunk(uploads, started.id, started.token, bytes)
  await assert.rejects(readFile(lockPath), { code: 'ENOENT' })
})

test('zero-progress chunk writes remove their partial file and leave the upload retryable', async t => {
  const f = await fixture(); t.after(f.dispose)
  const setup = f.service(), bytes = pdfBytes(), started = await begin(setup, bytes)
  const failing = f.service(actor, undefined, {
    fileHandleWrite: async (handle, data, purpose) => {
      if (purpose === 'chunk') throw new Error('file write made zero progress')
      await writePortalPageBytesFully(handle, data)
    },
  })
  await assert.rejects(sendChunk(failing, started.id, started.token, bytes), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'storage_unavailable')
  const incoming = path.join(f.uploadDir, 'portal-pages', '.incoming')
  assert.equal((await readdir(incoming)).includes(`${started.id}-0.part`), false)
  assert.equal(JSON.parse(await readFile(path.join(incoming, `m-${started.id}.json`), 'utf8')).state, 'receiving')
  await sendChunk(setup, started.id, started.token, bytes)
  assert.equal((await readFile(path.join(incoming, `${started.id}-0.chunk`))).length, bytes.length)
})

test('init reserves capacity and disk fail-closed, including the exact 500 MiB metadata-only path', async t => {
  const f = await fixture({ freeBytes: 3n * 1024n * 1024n * 1024n }); t.after(f.dispose)
  const uploads = f.service()
  const max = await uploads.init({ originalName: 'video', mimeType: 'video/mp4', bytes: 500 * MiB })
  assert.equal(max.chunkCount, 100)
  assert.equal(f.rows.get(max.id)?.filesize, 500 * MiB)
  await uploads.cancel(max.id, { token: max.token })

  const insufficient = f.service()
  const reserve = BigInt(PORTAL_PAGE_UPLOAD_MIN_FREE_BYTES + 2 * (500 * MiB))
  const low = await fixture({ freeBytes: reserve - 1n }); t.after(low.dispose)
  await assert.rejects(low.service().init({ originalName: 'video', mimeType: 'video/mp4', bytes: 500 * MiB }), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'insufficient_disk_space' && error.status === 507)
  const unavailable = await fixture({ statfsFreeBytes: async () => { throw new Error('statfs unavailable') } }); t.after(unavailable.dispose)
  await assert.rejects(unavailable.service().init({ originalName: 'x', mimeType: 'application/pdf', bytes: 1 }), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'disk_unavailable')
  void insufficient
})

test('generated multi-chunk PDF streams assemble exact bytes and hash without a whole-file source buffer', async t => {
  const f = await fixture(); t.after(f.dispose)
  const uploads = f.service()
  const totalBytes = PORTAL_PAGE_UPLOAD_CHUNK_SIZE + 1024 * 1024
  const started = await uploads.init({ originalName: 'generated.pdf', mimeType: 'application/pdf', bytes: totalBytes })
  const generatedWindow = 64 * 1024
  let maximumGeneratedWindow = 0
  let producedBytes = 0
  const makeChunkStream = (chunkIndex: number, chunkLength: number) => {
    let offset = 0
    return new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset >= chunkLength) { controller.close(); return }
      const length = Math.min(generatedWindow, chunkLength - offset)
      const bytes = Buffer.alloc(length, 0x20)
      const absoluteOffset = chunkIndex * PORTAL_PAGE_UPLOAD_CHUNK_SIZE + offset
      if (absoluteOffset === 0) Buffer.from('%PDF-1.7\n').copy(bytes)
      if (absoluteOffset + length === totalBytes) Buffer.from('%%EOF').copy(bytes, length - 5)
      offset += length
      producedBytes += length
      maximumGeneratedWindow = Math.max(maximumGeneratedWindow, bytes.byteLength)
      controller.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
    } })
  }
  const chunkLengths = [PORTAL_PAGE_UPLOAD_CHUNK_SIZE, totalBytes - PORTAL_PAGE_UPLOAD_CHUNK_SIZE]
  for (let index = 0; index < chunkLengths.length; index++) {
    const length = chunkLengths[index]!
    await uploads.putChunk(started.id, String(index), new Headers({
      'x-portal-page-upload-token': started.token, 'content-type': 'application/octet-stream', 'content-length': String(length),
    }), makeChunkStream(index, length))
  }
  const expected = createHash('sha256')
  let expectedOffset = 0
  while (expectedOffset < totalBytes) {
    const length = Math.min(generatedWindow, totalBytes - expectedOffset)
    const bytes = Buffer.alloc(length, 0x20)
    if (expectedOffset === 0) Buffer.from('%PDF-1.7\n').copy(bytes)
    if (expectedOffset + length === totalBytes) Buffer.from('%%EOF').copy(bytes, length - 5)
    expected.update(bytes)
    expectedOffset += length
  }
  const completion = await uploads.complete(started.id, { token: started.token })
  const target = path.join(f.uploadDir, 'portal-pages', String(f.rows.get(started.id)!.storageKey))
  const actualHash = createHash('sha256')
  for await (const bytes of createReadStream(target)) actualHash.update(bytes)
  assert.equal(producedBytes, totalBytes)
  assert.equal(maximumGeneratedWindow, generatedWindow)
  assert.equal((await stat(target)).size, totalBytes)
  assert.equal(completion.bytes, totalBytes)
  assert.equal(completion.sha256, expected.digest('hex'))
  assert.equal(actualHash.digest('hex'), completion.sha256)
})

test('active upload actor/global limits are checked from transaction rows and cancel/expiry clean only owned paths', async t => {
  const seededSameActor = [mediaRow(randomUUID(), actor), mediaRow(randomUUID(), actor)]
  const actorLimited = await fixture({ initialRows: seededSameActor }); t.after(actorLimited.dispose)
  await assert.rejects(actorLimited.service().init({ originalName: 'x', mimeType: 'application/pdf', bytes: 1 }), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'upload_limit_reached')

  const seededGlobal = Array.from({ length: 8 }, (_, index) => mediaRow(randomUUID(), `editor-${index}`))
  const globalLimited = await fixture({ initialRows: seededGlobal }); t.after(globalLimited.dispose)
  await assert.rejects(globalLimited.service().init({ originalName: 'x', mimeType: 'application/pdf', bytes: 1 }), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'upload_limit_reached')

  const f = await fixture({ now: Date.parse('2026-10-19T12:00:00.000Z') }); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, bytes)
  await sendChunk(uploads, started.id, started.token, bytes)
  const cancelled = await uploads.cancel(started.id, { token: started.token })
  assert.equal(cancelled.cancelled, true)
  assert.equal(f.rows.has(started.id), false)
  assert.deepEqual(await readdir(path.join(f.uploadDir, 'portal-pages', '.incoming')), [])

  const expired = await begin(uploads, bytes)
  await sendChunk(uploads, expired.id, expired.token, bytes)
  f.setTime(Date.parse('2026-10-19T12:00:00.000Z') + PORTAL_PAGE_UPLOAD_RETENTION_MS + 1)
  const cleanup = await uploads.cleanupExpired()
  assert.equal(cleanup.removed, 1)
  assert.equal(f.rows.has(expired.id), false)
  assert.deepEqual(await readdir(path.join(f.uploadDir, 'portal-pages', '.incoming')), [])
})

test('more than 32 successful retained manifests do not make init fail', async t => {
  const f = await fixture({ now: Date.parse('2026-10-19T12:00:00.000Z') }); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes()
  for (let index = 0; index < 35; index++) {
    const started = await begin(uploads, bytes)
    await sendChunk(uploads, started.id, started.token, bytes)
    await uploads.complete(started.id, { token: started.token })
  }
  const next = await uploads.init({ originalName: 'new.pdf', mimeType: 'application/pdf', bytes: 1 })
  assert.equal(f.rows.get(next.id)?.state, 'uploading')
  assert.equal([...f.rows.values()].filter(row => row.state === 'complete').length, 35)
  await uploads.cancel(next.id, { token: next.token })
})

test('a cleanup pass infrastructure failure does not reject otherwise safe initialization', async t => {
  const f = await fixture(); t.after(f.dispose)
  const brokenQueue = {
    ...f.cleanupQueueAdapter,
    async withPassSavepoint() { throw new Error('synthetic cleanup queue unavailable') },
  }
  const uploads = f.service(actor, undefined, { cleanupQueueAdapter: () => brokenQueue })
  const started = await uploads.init({ originalName: 'safe.pdf', mimeType: 'application/pdf', bytes: 1 })
  assert.equal(f.rows.get(started.id)?.state, 'uploading')
  assert.equal(f.queue.get(started.id)?.status, 'pending', 'the required init enqueue still persists')
})

test('expired cleanup progresses through a backlog in repeated bounded passes', async t => {
  const f = await fixture({ now: Date.parse('2026-10-19T12:00:00.000Z') }); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes()
  for (let index = 0; index < 37; index++) {
    const started = await begin(uploads, bytes)
    await sendChunk(uploads, started.id, started.token, bytes)
    await uploads.complete(started.id, { token: started.token })
  }
  f.setTime(Date.parse('2026-10-19T12:00:00.000Z') + PORTAL_PAGE_UPLOAD_RETENTION_MS + 1)
  let removed = 0
  for (let pass = 0; pass < 4 && removed < 37; pass++) {
    const result = await uploads.cleanupExpired()
    assert.ok(result.removed <= 32, 'one cleanup pass respects the hard batch budget')
    removed += result.removed
  }
  assert.equal(removed, 37)
  const incoming = await readdir(path.join(f.uploadDir, 'portal-pages', '.incoming'))
  assert.equal(incoming.filter(name => name.endsWith('.json')).length, 0)
})

test('missing queue rows are repaired idempotently within the shared bounded pass', async t => {
  const f = await fixture({ now: Date.parse('2026-10-19T12:00:00.000Z') }); t.after(f.dispose)
  const uploads = f.service(), started = await begin(uploads, pdfBytes())
  f.queue.delete(started.id)
  const first = await uploads.cleanupExpired()
  assert.equal(first.removed, 0)
  assert.equal(f.queue.get(started.id)?.status, 'pending')
  const repairedDue = f.queue.get(started.id)?.nextAttemptAt
  assert.equal(repairedDue, Date.parse('2026-10-19T12:00:00.000Z') + PORTAL_PAGE_UPLOAD_RETENTION_MS)
  const second = await uploads.cleanupExpired()
  assert.equal(second.removed, 0)
  assert.equal(f.queue.get(started.id)?.nextAttemptAt, repairedDue)
  await uploads.cleanupExpired()
  assert.equal(f.queue.get(started.id)?.status, 'pending', 'repeated repair does not duplicate or re-enqueue the existing row')
})

test('database queue adapter uses page-only idempotent SQL, due ordering, savepoints, and skip-locked claims', async t => {
  const now = Date.parse('2026-10-19T12:00:00.000Z')
  const f = await fixture({ now }); t.after(f.dispose)
  const calls: string[] = []
  let claimID: string | undefined
  const session = (f.payload.db as unknown as { sessions: { live: { db: { execute: (query: unknown) => Promise<unknown> } } } }).sessions.live.db
  session.execute = async query => {
    const text = statementText(query).replace(/\s+/gu, ' ').trim()
    calls.push(text)
    if (text.startsWith('SELECT id, uploaded_by, filesize FROM portal_page_media')) {
      return { rows: [...f.rows.values()].filter(row => row.state === 'uploading').map(row => ({
        id: row.id, uploaded_by: row.uploadedBy, filesize: row.filesize,
      })) }
    }
    if (text.startsWith('SELECT upload_id, attempt_count')) {
      return { rows: claimID ? [{ upload_id: claimID, attempt_count: 0, next_attempt_ms: now }] : [] }
    }
    if (text.startsWith('SELECT status, attempt_count, extract(epoch FROM next_attempt_at) * 1000 AS next_attempt_ms')) {
      return { rows: [{ status: 'pending', attempt_count: 0, next_attempt_ms: now, last_error_code: null }] }
    }
    return { rows: [] }
  }
  const uploads = f.service(actor, undefined, { cleanupQueueAdapter: undefined })
  const started = await uploads.init({ originalName: 'database-queue.pdf', mimeType: 'application/pdf', bytes: 1 })
  claimID = started.id
  const result = await uploads.cleanupExpired()
  assert.deepEqual(result, { removed: 0, unresolved: 0 })
  const claim = calls.find(text => text.startsWith('SELECT upload_id, attempt_count')) || ''
  assert.ok(calls.some(text => text.includes('ON CONFLICT (upload_id) DO UPDATE SET')))
  assert.ok(calls.some(text => text.includes('LEFT JOIN portal_page_upload_cleanup AS cleanup ON cleanup.upload_id = media.id')))
  assert.match(claim, /ORDER BY next_attempt_at, upload_id LIMIT/u)
  assert.match(claim, /FOR UPDATE SKIP LOCKED/u)
  assert.ok(calls.some(text => text === 'SAVEPOINT portal_page_upload_cleanup_pass'))
  assert.ok(calls.some(text => text === 'SAVEPOINT portal_page_upload_cleanup_item'))
  assert.ok(calls.some(text => text.startsWith('UPDATE portal_page_upload_cleanup SET status = ')))
  assert.ok(calls.every(text => !/\bnews_(?:articles|media|schedules|audit)\b/iu.test(text)))
})

test('concurrent init calls in independent transactions cannot exceed actor quota', async t => {
  const f = await transactionFixture(); t.after(f.dispose)
  const initial = await f.service().init({ originalName: 'first.pdf', mimeType: 'application/pdf', bytes: 1 })
  const traceStart = f.trace.length
  const attempts = await Promise.allSettled([
    f.service().init({ originalName: 'second.pdf', mimeType: 'application/pdf', bytes: 1 }),
    f.service().init({ originalName: 'third.pdf', mimeType: 'application/pdf', bytes: 1 }),
  ])
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = attempts.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.ok(rejected.reason instanceof PortalPageUploadError && rejected.reason.code === 'upload_limit_reached')
  assert.equal([...f.rows.values()].filter(row => row.state === 'uploading' && row.uploadedBy === actor).length, 2)
  const events = f.trace.slice(traceStart)
  const admitted = attempts.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<{ id: string }>
  const [firstKey, secondKey] = portalPageUploadAdvisoryKey(admitted.value.id)
  const begun = events.filter(event => event.kind === 'begin').map(event => event.transactionID)
  assert.equal(begun.length, 5, 'each init attempt uses cleanup/admission transactions and the admitted init confirms in a fresh session')
  assert.equal(new Set(begun).size, 5)
  assert.ok(events.some(event => event.kind === 'advisory-lock' && event.lockClass === 'portal-page-upload' &&
    event.lockKey === `portal-page-upload:${firstKey},${secondKey}`), 'the admitted init executes the production per-upload lock helper')
  assertUploadLockOrder(events)
  assert.deepEqual(f.activeSessionIDs(), [])
  const cancelTraceStart = f.trace.length
  await f.service().cancel(initial.id, { token: initial.token })
  const cancelEvents = f.trace.slice(cancelTraceStart)
  assertUploadLockOrder(cancelEvents)
  const cancelLocks = cancelEvents.filter(event => event.kind === 'advisory-lock' && event.lockClass === 'portal-page-upload')
  assert.equal(cancelLocks.length, 3,
    'cancellation mutation, delete, and fresh confirmation take CMS → upload advisory locks')
  assert.ok(cancelLocks.every(event => event.lockKey === expectedUploadLockKey(initial.id)))
  assert.equal(new Set(cancelLocks.map(event => event.transactionID)).size, 3)
  assert.equal(cancelEvents.filter(event => event.kind === 'commit').length, 3)
  assert.deepEqual(f.activeSessionIDs(), [])
})

test('one corrupt expired manifest is deferred without blocking unrelated cleanup', async t => {
  const f = await fixture({ now: Date.parse('2026-10-19T12:00:00.000Z') }); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes()
  const bad = await begin(uploads, bytes)
  const good = await begin(uploads, bytes)
  const incoming = path.join(f.uploadDir, 'portal-pages', '.incoming')
  await writeFile(path.join(incoming, `m-${bad.id}.json`), '{partial')
  f.setTime(Date.parse('2026-10-19T12:00:00.000Z') + PORTAL_PAGE_UPLOAD_RETENTION_MS + 1)
  const result = await uploads.cleanupExpired()
  assert.equal(result.removed, 1)
  assert.equal(f.rows.has(good.id), false)
  assert.equal(f.rows.has(bad.id), true)
  assert.ok((await readdir(incoming)).includes(`m-${bad.id}.json`))
})

test('owner cancellation validates and removes a promoted file while the metadata row is uploading', async t => {
  const f = await fixture(); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, bytes)
  const row = f.rows.get(started.id)!
  const pages = path.join(f.uploadDir, 'portal-pages')
  const finalPath = path.join(pages, String(row.storageKey))
  const manifestPath = path.join(pages, '.incoming', `m-${started.id}.json`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  manifest.state = 'renamed'
  const expectedHash = createHash('sha256').update(bytes).digest('hex')
  manifest.finalSha256 = expectedHash
  await writeFile(manifestPath, JSON.stringify(manifest))
  const corrupted = Buffer.from(bytes)
  corrupted[corrupted.length - 1] ^= 1
  await writeFile(finalPath, corrupted, { mode: 0o600 })

  assert.equal(row.state, 'uploading')
  await assert.rejects(uploads.cancel(started.id, { token: started.token }), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'upload_unavailable')
  const cancelling = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  assert.equal(cancelling.state, 'cancelling')
  assert.equal(cancelling.finalSha256, expectedHash, 'the original final hash remains until verified removal succeeds')
  assert.equal(f.rows.get(started.id)?.state, 'uploading')

  await writeFile(finalPath, bytes, { mode: 0o600 })
  assert.equal((await uploads.cancel(started.id, { token: started.token })).cancelled, true)
  assert.equal(f.rows.has(started.id), false)
  await assert.rejects(readFile(finalPath), { code: 'ENOENT' })
  await assert.rejects(readFile(manifestPath), { code: 'ENOENT' })
})

test('known database update failure after promotion removes final bytes and keeps metadata incomplete', async t => {
  const f = await fixture(); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, bytes)
  await sendChunk(uploads, started.id, started.token, bytes)
  const row = f.rows.get(started.id)!
  const target = path.join(f.uploadDir, 'portal-pages', String(row.storageKey))
  const originalUpdate = f.payload.update
  f.payload.update = async () => { throw new Error('synthetic known rollback') }
  await assert.rejects(uploads.complete(started.id, { token: started.token }))
  f.payload.update = originalUpdate
  assert.equal(f.rows.get(started.id)?.state, 'uploading')
  await assert.rejects(readFile(target), { code: 'ENOENT' })
  await assert.rejects(readFile(path.join(f.uploadDir, 'portal-pages', '.incoming', `${started.id}.assembled.part`)), { code: 'ENOENT' })
  assert.equal(JSON.parse(await readFile(path.join(f.uploadDir, 'portal-pages', '.incoming', `m-${started.id}.json`), 'utf8')).state, 'receiving')
})

test('actual transaction rollback after file promotion restores uploading metadata and retryable bytes', async t => {
  const f = await transactionFixture(); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, bytes)
  await sendChunk(uploads, started.id, started.token, bytes)
  assert.ok(f.queue.has(started.id), 'the session adapter committed the init queue row')
  const row = f.rows.get(started.id)!
  const target = path.join(f.uploadDir, 'portal-pages', String(row.storageKey))
  f.failNextCleanupSchedule()
  await assert.rejects(uploads.complete(started.id, { token: started.token }), /transaction_fixture_injected_schedule_failure/u)
  assert.equal(f.rows.get(started.id)?.state, 'uploading', 'transaction rollback discarded staged completion metadata')
  assert.equal(f.queue.get(started.id)?.status, 'pending', 'the pre-transaction queue state remains recoverable')
  await assert.rejects(readFile(target), { code: 'ENOENT' }, 'known rollback compensation removed the promoted file')
  const manifest = JSON.parse(await readFile(path.join(f.uploadDir, 'portal-pages', '.incoming', `m-${started.id}.json`), 'utf8'))
  assert.equal(manifest.state, 'receiving')
  assert.equal(manifest.finalSha256, undefined)
  assert.deepEqual(f.activeSessionIDs(), [])
  assert.ok(f.trace.some(event => event.kind === 'rollback'), 'withCmsTransaction rolled back the actual owning session')
})

test('fresh confirmation rejects swallowed rollbacks and accepts commits whose receipt is lost', async t => {
  const now = Date.parse('2026-10-19T12:00:00.000Z')
  const bytes = pdfBytes()

  const failedInit = await transactionFixture({ now }); t.after(failedInit.dispose)
  failedInit.afterNextCommit(async () => { failedInit.failNextCommitBeforeApply() },
    (_transactionID, committedRows) => committedRows.size === 0)
  await assert.rejects(failedInit.service().init({ originalName: 'rollback.pdf', mimeType: 'application/pdf', bytes: bytes.length }),
    (error: unknown) => error instanceof PortalPageUploadError && error.code === 'upload_unavailable')
  assert.equal(failedInit.rows.size, 0, 'fresh confirmation prevents an init token after a swallowed rollback')
  assert.equal(failedInit.queue.size, 0)
  assert.equal((await readdir(path.join(failedInit.uploadDir, 'portal-pages', '.incoming'))).some(name => name.startsWith('m-')), false)
  assert.deepEqual(failedInit.activeSessionIDs(), [])

  const committedInit = await transactionFixture({ now }); t.after(committedInit.dispose)
  committedInit.afterNextCommit(async () => { committedInit.loseNextCommitReceipt() },
    (_transactionID, committedRows) => committedRows.size === 0)
  const started = await committedInit.service().init({ originalName: 'receipt-lost.pdf', mimeType: 'application/pdf', bytes: bytes.length })
  assert.equal(committedInit.rows.get(started.id)?.state, 'uploading')
  assert.equal(committedInit.queue.get(started.id)?.status, 'pending')
  assert.equal(JSON.parse(await readFile(path.join(committedInit.uploadDir, 'portal-pages', '.incoming', `m-${started.id}.json`), 'utf8')).id,
    started.id, 'fresh committed row and queue state permit manifest publication and token return')
  assert.deepEqual(committedInit.activeSessionIDs(), [])

  const failedComplete = await transactionFixture({ now }); t.after(failedComplete.dispose)
  const failedCompleteUploads = failedComplete.service()
  const incomplete = await begin(failedCompleteUploads, bytes)
  await sendChunk(failedCompleteUploads, incomplete.id, incomplete.token, bytes)
  failedComplete.failNextCommitBeforeApply()
  await assert.rejects(failedCompleteUploads.complete(incomplete.id, { token: incomplete.token }),
    (error: unknown) => error instanceof PortalPageUploadError && error.code === 'upload_unavailable')
  const incompleteRow = failedComplete.rows.get(incomplete.id)!
  const incompleteTarget = path.join(failedComplete.uploadDir, 'portal-pages', String(incompleteRow.storageKey))
  const incompleteManifest = JSON.parse(await readFile(path.join(failedComplete.uploadDir, 'portal-pages', '.incoming', `m-${incomplete.id}.json`), 'utf8'))
  assert.equal(incompleteRow.state, 'uploading', 'a swallowed rollback cannot be reported as completion')
  assert.equal(incompleteManifest.state, 'renamed', 'ambiguous promoted state remains available to reconciliation')
  assert.deepEqual(await readFile(incompleteTarget), bytes, 'ambiguous completion preserves final bytes')
  assert.deepEqual(failedComplete.activeSessionIDs(), [])

  const committedComplete = await transactionFixture({ now }); t.after(committedComplete.dispose)
  const committedCompleteUploads = committedComplete.service()
  const completeStarted = await begin(committedCompleteUploads, bytes)
  await sendChunk(committedCompleteUploads, completeStarted.id, completeStarted.token, bytes)
  committedComplete.loseNextCommitReceipt()
  const completed = await committedCompleteUploads.complete(completeStarted.id, { token: completeStarted.token })
  assert.equal(completed.state, 'complete', 'fresh exact row/queue state accepts an applied commit with a lost receipt')
  assert.equal(committedComplete.rows.get(completeStarted.id)?.sha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(committedComplete.queue.get(completeStarted.id)?.nextAttemptAt, now + PORTAL_PAGE_UPLOAD_RETENTION_MS,
    'the exact fresh queue snapshot includes the completion retention schedule')
  assert.deepEqual(committedComplete.activeSessionIDs(), [])

  const failedCancel = await transactionFixture({ now }); t.after(failedCancel.dispose)
  const failedCancelUploads = failedCancel.service()
  const cancelStarted = await begin(failedCancelUploads, bytes)
  failedCancel.afterNextCommit(async () => { failedCancel.failNextCommitBeforeApply() })
  await assert.rejects(failedCancelUploads.cancel(cancelStarted.id, { token: cancelStarted.token }),
    (error: unknown) => error instanceof PortalPageUploadError && error.code === 'upload_unavailable')
  assert.equal(failedCancel.rows.has(cancelStarted.id), true, 'fresh absence check rejects a swallowed delete rollback')
  assert.equal(failedCancel.queue.has(cancelStarted.id), true, 'the pending queue keeps ambiguous cancellation reconcilable')
  const cancelArtifacts = await readdir(path.join(failedCancel.uploadDir, 'portal-pages', '.incoming'))
  assert.equal(cancelArtifacts.includes(`m-${cancelStarted.id}.json`), false)
  assert.deepEqual(await failedCancelUploads.cleanupExpired(), { removed: 1, unresolved: 0 })
  assert.equal(failedCancel.rows.has(cancelStarted.id), false, 'bounded reconciliation removes the ambiguous row later')

  const committedCancel = await transactionFixture({ now }); t.after(committedCancel.dispose)
  const committedCancelUploads = committedCancel.service()
  const cancelCommitted = await begin(committedCancelUploads, bytes)
  committedCancel.afterNextCommit(async () => { committedCancel.loseNextCommitReceipt() })
  assert.deepEqual(await committedCancelUploads.cancel(cancelCommitted.id, { token: cancelCommitted.token }),
    { id: cancelCommitted.id, cancelled: true }, 'fresh row/queue absence accepts a committed cancellation with lost receipt')
  assert.equal(committedCancel.rows.has(cancelCommitted.id), false)
  assert.equal(committedCancel.queue.has(cancelCommitted.id), false)
  assert.deepEqual(committedCancel.activeSessionIDs(), [])
})

test('init refuses to publish a token when the committed cleanup retry exceeds its bounded schedule', async t => {
  const now = Date.parse('2026-10-19T12:00:00.000Z')
  const f = await transactionFixture({ now }); t.after(f.dispose)
  f.afterNextCommit(async () => {
    const id = [...f.rows.keys()][0]!
    const cleanup = f.queue.get(id)!
    f.queue.set(id, { ...cleanup, attemptCount: 1, nextAttemptAt: now + 25 * 60 * 60 * 1000,
      lastErrorCode: 'cleanup_failed' })
  }, (_transactionID, committedRows) => committedRows.size === 1)

  await assert.rejects(f.service().init({ originalName: 'unbounded-retry.pdf', mimeType: 'application/pdf', bytes: pdfBytes().length }),
    (error: unknown) => error instanceof PortalPageUploadError && error.code === 'upload_unavailable')
  const id = [...f.rows.keys()][0]!
  assert.equal(f.rows.get(id)?.state, 'uploading', 'the unconfirmed row remains for durable reconciliation')
  await assert.rejects(readFile(path.join(f.uploadDir, 'portal-pages', '.incoming', `m-${id}.json`)), { code: 'ENOENT' },
    'an unbounded queue snapshot cannot authorize token/manifest publication')
  assert.deepEqual(f.activeSessionIDs(), [])
})

test('completion rejects a fresh cleanup snapshot that differs from the scheduled transaction state', async t => {
  const f = await transactionFixture(); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, bytes)
  await sendChunk(uploads, started.id, started.token, bytes)
  f.afterNextCommit(async () => {
    const cleanup = f.queue.get(started.id)
    assert.ok(cleanup)
    f.queue.set(started.id, { ...cleanup, attemptCount: cleanup.attemptCount + 1 })
  }, (_transactionID, committedRows) => committedRows.get(started.id)?.state === 'complete')

  await assert.rejects(uploads.complete(started.id, { token: started.token }),
    (error: unknown) => error instanceof PortalPageUploadError && error.code === 'upload_unavailable')
  assert.equal(f.rows.get(started.id)?.state, 'complete', 'the database commit is retained despite a mismatched fresh queue snapshot')
  const row = f.rows.get(started.id)!
  const target = path.join(f.uploadDir, 'portal-pages', String(row.storageKey))
  const manifestPath = path.join(f.uploadDir, 'portal-pages', '.incoming', `m-${started.id}.json`)
  assert.deepEqual(await readFile(target), bytes, 'confirmation failure preserves promoted bytes')
  assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).state, 'renamed',
    'confirmation failure preserves the recovery manifest')
  assert.deepEqual(f.activeSessionIDs(), [])
})

test('unproven compensation retains the renamed manifest and queue for later reconciliation', async t => {
  const f = await fixture({ now: Date.parse('2026-10-19T12:00:00.000Z') }); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, bytes)
  await sendChunk(uploads, started.id, started.token, bytes)
  const target = path.join(f.uploadDir, 'portal-pages', String(f.rows.get(started.id)!.storageKey))
  const originalUpdate = f.payload.update
  f.payload.update = async () => {
    await rm(target, { recursive: true, force: true })
    await mkdir(target)
    throw new Error('synthetic database update failure')
  }
  await assert.rejects(uploads.complete(started.id, { token: started.token }))
  f.payload.update = originalUpdate
  assert.equal(f.rows.get(started.id)?.state, 'uploading')
  const manifestPath = path.join(f.uploadDir, 'portal-pages', '.incoming', `m-${started.id}.json`)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
  assert.equal(manifest.state, 'renamed')
  assert.equal(manifest.finalSha256, createHash('sha256').update(bytes).digest('hex'))
  assert.equal(f.queue.get(started.id)?.status, 'pending')

  await rm(target, { recursive: true, force: true })
  await writeFile(target, bytes, { mode: 0o600 })
  const queued = f.queue.get(started.id)!
  f.queue.set(started.id, { ...queued, nextAttemptAt: Date.parse('2026-10-19T12:00:00.000Z') })
  await uploads.cleanupExpired()
  assert.equal(f.rows.get(started.id)?.state, 'complete')
  assert.deepEqual(await readFile(target), bytes)
})

test('cleanup reconciles either outcome of an ambiguous completion transaction', async t => {
  const now = Date.parse('2026-10-19T12:00:00.000Z')
  const bytes = pdfBytes()
  const hash = createHash('sha256').update(bytes).digest('hex')

  const rolledBack = await fixture({ now }); t.after(rolledBack.dispose)
  const rollbackService = rolledBack.service(), pending = await begin(rollbackService, bytes)
  await sendChunk(rollbackService, pending.id, pending.token, bytes)
  const pendingRow = rolledBack.rows.get(pending.id)!
  const pendingManifestPath = path.join(rolledBack.uploadDir, 'portal-pages', '.incoming', `m-${pending.id}.json`)
  const pendingManifest = JSON.parse(await readFile(pendingManifestPath, 'utf8')) as Record<string, unknown>
  pendingManifest.state = 'ready_to_rename'
  pendingManifest.finalSha256 = hash
  await writeFile(pendingManifestPath, JSON.stringify(pendingManifest))
  const pendingFinal = path.join(rolledBack.uploadDir, 'portal-pages', String(pendingRow.storageKey))
  await writeFile(pendingFinal, bytes, { mode: 0o600 })
  const pendingQueue = rolledBack.queue.get(pending.id)!
  rolledBack.queue.set(pending.id, { ...pendingQueue, nextAttemptAt: now })

  await rollbackService.cleanupExpired()
  assert.equal(rolledBack.rows.get(pending.id)?.state, 'complete', 'an uploading row is promoted from the durable renamed manifest')
  assert.equal(rolledBack.rows.get(pending.id)?.sha256, hash)
  assert.deepEqual(await readFile(pendingFinal), bytes)
  assert.equal(JSON.parse(await readFile(pendingManifestPath, 'utf8')).state, 'renamed')
  assert.equal(rolledBack.queue.get(pending.id)?.status, 'pending', 'completion remains scheduled for retention cleanup')

  const committed = await fixture({ now }); t.after(committed.dispose)
  const committedService = committed.service(), finished = await begin(committedService, bytes)
  const completeRow = committed.rows.get(finished.id)!
  completeRow.state = 'complete'
  completeRow.sha256 = hash
  completeRow.completedAt = new Date(now).toISOString()
  const completeManifestPath = path.join(committed.uploadDir, 'portal-pages', '.incoming', `m-${finished.id}.json`)
  const completeManifest = JSON.parse(await readFile(completeManifestPath, 'utf8')) as Record<string, unknown>
  completeManifest.state = 'renamed'
  completeManifest.finalSha256 = hash
  await writeFile(completeManifestPath, JSON.stringify(completeManifest))
  const completeFinal = path.join(committed.uploadDir, 'portal-pages', String(completeRow.storageKey))
  await writeFile(completeFinal, bytes, { mode: 0o600 })
  const completeQueue = committed.queue.get(finished.id)!
  committed.queue.set(finished.id, { ...completeQueue, nextAttemptAt: now })

  await committedService.cleanupExpired()
  assert.equal(committed.rows.get(finished.id)?.state, 'complete', 'a confirmed completion is validated, not removed')
  assert.equal(committed.queue.get(finished.id)?.status, 'pending')
  assert.equal(committed.queue.get(finished.id)?.nextAttemptAt, now + PORTAL_PAGE_UPLOAD_RETENTION_MS)
  assert.deepEqual(await readFile(completeFinal), bytes)
})

test('corrupt manifests, symlinked chunk files and traversal IDs fail closed without following external targets', async t => {
  const f = await fixture(); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, bytes)
  const incoming = path.join(f.uploadDir, 'portal-pages', '.incoming')
  const manifestPath = path.join(incoming, `m-${started.id}.json`)
  await writeFile(manifestPath, '{corrupt')
  f.setTime(Date.now() + PORTAL_PAGE_UPLOAD_RETENTION_MS + 1000)
  const deferred = await uploads.cleanupExpired()
  assert.equal(deferred.unresolved, 1, 'a poison queue item is deferred instead of aborting the pass')
  assert.equal(f.rows.get(started.id)?.state, 'uploading', 'corrupt state is not broad-cleaned')
  await assert.rejects(uploads.putChunk('../outside', '0', new Headers(), new Response(bytes).body),
    (error: unknown) => error instanceof PortalPageUploadError && error.code === 'invalid_request')

  const symlinkFixture = await fixture(); t.after(symlinkFixture.dispose)
  const symlinkService = symlinkFixture.service(), upload = await begin(symlinkService, bytes)
  const symlinkIncoming = path.join(symlinkFixture.uploadDir, 'portal-pages', '.incoming')
  const external = path.join(symlinkFixture.uploadDir, 'outside.bin')
  await writeFile(external, 'untouched')
  try { await symlink(external, path.join(symlinkIncoming, `${upload.id}-0.chunk`), 'file') }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code || '')) { t.diagnostic('symlink creation unavailable on this platform'); return }
    throw error
  }
  await assert.rejects(sendChunk(symlinkService, upload.id, upload.token, bytes), (error: unknown) =>
    error instanceof PortalPageUploadError && error.status === 503)
  assert.equal(await readFile(external, 'utf8'), 'untouched')
})

test('endpoint enforces same-origin V2 editor auth and derives actor identity only from the verified request', async t => {
  const f = await fixture({ actorUid: 'editor-v2' }); t.after(f.dispose)
  const previous = Object.fromEntries(['CMS_DATABASE_URL', 'PAYLOAD_SECRET', 'PORTAL_PUBLIC_URL', 'PORTAL_INTERNAL_URL',
    'PAYLOAD_TO_PORTAL_SECRET', 'PORTAL_TO_PAYLOAD_SECRET', 'CMS_UPLOAD_DIR'].map(key => [key, process.env[key]]))
  Object.assign(process.env, {
    CMS_DATABASE_URL: 'postgresql://localhost/cms_test', PAYLOAD_SECRET: 'synthetic-payload-secret-0000000000000000',
    PORTAL_PUBLIC_URL: 'https://portal.example.test', PORTAL_INTERNAL_URL: 'http://127.0.0.1:18085',
    PAYLOAD_TO_PORTAL_SECRET: 'synthetic-payload-to-portal-000000000000',
    PORTAL_TO_PAYLOAD_SECRET: 'synthetic-portal-to-payload-000000000000', CMS_UPLOAD_DIR: f.uploadDir,
  })
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value
  })
  const handler = portalPageUploadEndpoints[0]!.handler as (req: PayloadRequest) => Promise<Response>
  const crossSite = await handler({ headers: new Headers({ origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' }) } as unknown as PayloadRequest)
  assert.equal(crossSite.status, 403)
  assert.match((await crossSite.json()).message, /Permissão/u)

  const uid = 'editor-v2'
  const user = { id: 'cms-editor', collection: 'portal-editors', portalUid: uid, adminExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    adminActor: { version: 2, uid, email: 'editor@example.test', name: null,
      capabilities: { manageKnowledge: true, manageAcademy: false, manageBenefits: false, manageReminders: false } } }
  const input = { originalName: 'manual.pdf', mimeType: 'application/pdf', bytes: 8 }
  const serialized = JSON.stringify(input)
  const request = { payload: f.payload, transactionID: 'live', user, routeParams: {},
    i18n: { t: (key: string) => key }, payloadDataLoader: {},
    headers: new Headers({ origin: 'https://portal.example.test', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }),
    body: new Response(serialized).body } as unknown as PayloadRequest
  const response = await handler(request)
  assert.equal(response.status, 201)
  const started = await response.json() as { id: string; token: string }
  assert.equal(f.rows.get(started.id)?.uploadedBy, uid)

  const injected = { ...input, actorUid: 'attacker' }
  const attackerBody = JSON.stringify(injected)
  const invalid = await handler({ ...request, body: new Response(attackerBody).body } as unknown as PayloadRequest)
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).message, 'A solicitação é inválida.')
  assert.equal([...f.rows.values()].filter(row => row.state === 'uploading').length, 1)

  // The installed Payload endpoint dispatcher requires a booted Payload instance and DB adapter.
  // This offline adapter calls the exact exported handler and streams the real raw request body.
  const chunk = Buffer.alloc(5 * MiB, 0x20)
  Buffer.from('%PDF-1.7\n').copy(chunk)
  Buffer.from('%%EOF').copy(chunk, chunk.length - 5)
  const chunkInit = await handler({ ...request, body: new Response(JSON.stringify({
    originalName: 'exact-chunk.pdf', mimeType: 'application/pdf', bytes: chunk.length,
  })).body } as unknown as PayloadRequest)
  assert.equal(chunkInit.status, 201)
  const upload = await chunkInit.json() as { id: string; token: string }
  const chunkHandler = portalPageUploadEndpoints[1]!.handler as (req: PayloadRequest) => Promise<Response>
  const chunkResponse = await chunkHandler({ ...request, routeParams: { id: upload.id, index: '0' },
    headers: new Headers({ origin: 'https://portal.example.test', 'sec-fetch-site': 'same-origin',
      'x-portal-page-upload-token': upload.token, 'content-type': 'application/octet-stream',
      'content-length': String(chunk.length) }), body: new Response(Uint8Array.from(chunk)).body } as unknown as PayloadRequest)
  assert.equal(chunkResponse.status, 200)
  assert.deepEqual(await readFile(path.join(f.uploadDir, 'portal-pages', '.incoming', `${upload.id}-0.chunk`)), chunk)
})
