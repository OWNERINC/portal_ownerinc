import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import type { Payload, PayloadRequest } from 'payload'
import { portalPageUploadEndpoints } from '../../../src/endpoints/portal-page-uploads'
import { portalPageMediaMutationActor } from '../../../src/portal-pages/persistence'
import type { PortalPageUploadCleanupAdapter, PortalPageUploadCleanupItem } from '../../../src/portal-pages/upload-cleanup-queue'
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

const MiB = 1024 * 1024
const actor = 'editor-1'

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
  const execute = async () => ({ rows: [...rows.values()].filter(row => row.state === 'uploading').map(row => ({
    id: row.id, uploaded_by: row.uploadedBy, filesize: row.filesize,
  })) })
  const payload = {
    db: { sessions: { live: { db: { execute } } } },
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
  const req = { payload, transactionID: 'live', context: {}, user: null, headers: new Headers() } as unknown as PayloadRequest
  let clock = options.now ?? Date.now()
  const service = (serviceActor = owner, serviceReq = { ...req, context: {} } as PayloadRequest,
    overrides: Partial<Parameters<typeof createPortalPageUploadService>[0]> = {}) => createPortalPageUploadService({
    payload, req: serviceReq, actorUid: serviceActor, uploadDir, now: () => clock, cleanupQueueAdapter: () => cleanupQueueAdapter,
    statfsFreeBytes: options.statfsFreeBytes || (async () => options.freeBytes ?? 10n * 1024n * 1024n * 1024n), ...overrides,
  })
  return { uploadDir, rows, queue, payload, req, service, cleanupQueueAdapter,
    setTime: (next: number) => { clock = next }, dispose: () => rm(uploadDir, { recursive: true, force: true }) }
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

test('completion streams immutable bytes, hashes exactly, and concurrent callers reconcile to the same completed result', async t => {
  const f = await fixture(); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, bytes)
  await sendChunk(uploads, started.id, started.token, bytes)
  const sessions = (f.payload.db as unknown as { sessions: Record<string, unknown> }).sessions
  sessions['complete-a'] = sessions.live
  sessions['complete-b'] = sessions.live
  const firstContext = f.service(actor, { ...f.req, transactionID: 'complete-a', context: {} } as PayloadRequest)
  const concurrentUploads = f.service(actor, { ...f.req, transactionID: 'complete-b', context: {} } as PayloadRequest)
  const [first, second] = await Promise.all([
    firstContext.complete(started.id, { token: started.token }),
    concurrentUploads.complete(started.id, { token: started.token }),
  ])
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
  await assert.rejects(uploads.cancel(started.id, { token: started.token }), (error: unknown) =>
    error instanceof PortalPageUploadError && error.code === 'media_already_complete')
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
  const f = await fixture(); t.after(f.dispose)
  const initial = await f.service().init({ originalName: 'first.pdf', mimeType: 'application/pdf', bytes: 1 })
  let admissionTail = Promise.resolve()
  const leases = new Map<string, () => void>()
  const gatedService = (transactionID: string) => {
    const session = (f.payload.db as unknown as { sessions: Record<string, unknown> }).sessions.live
    ;(f.payload.db as unknown as { sessions: Record<string, unknown> }).sessions[transactionID] = session
    const req = { ...f.req, transactionID, context: {} } as PayloadRequest
    const adapter = {
      ...f.cleanupQueueAdapter,
      async enqueue(id: string, nextAttemptAt: number) {
        await f.cleanupQueueAdapter.enqueue(id, nextAttemptAt)
        leases.get(transactionID)?.()
        leases.delete(transactionID)
      },
    }
    return f.service(actor, req, {
      readUploadAdmission: async (uid, timestamp) => {
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        const prior = admissionTail
        admissionTail = prior.then(() => gate)
        await prior
        leases.set(transactionID, release)
        const active = [...f.rows.values()].filter(row => row.state === 'uploading')
        return { activeForActor: active.filter(row => row.uploadedBy === uid).length,
          activeGlobal: active.length, reservedBytes: active.reduce((sum, row) => sum + BigInt(String(row.filesize)), 0n) }
      },
      cleanupQueueAdapter: () => adapter,
    })
  }
  const attempts = await Promise.allSettled([
    gatedService('independent-a').init({ originalName: 'second.pdf', mimeType: 'application/pdf', bytes: 1 }),
    gatedService('independent-b').init({ originalName: 'third.pdf', mimeType: 'application/pdf', bytes: 1 }),
  ])
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = attempts.find(result => result.status === 'rejected') as PromiseRejectedResult
  assert.ok(rejected.reason instanceof PortalPageUploadError && rejected.reason.code === 'upload_limit_reached')
  assert.equal([...f.rows.values()].filter(row => row.state === 'uploading' && row.uploadedBy === actor).length, 2)
  await f.service().cancel(initial.id, { token: initial.token })
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
