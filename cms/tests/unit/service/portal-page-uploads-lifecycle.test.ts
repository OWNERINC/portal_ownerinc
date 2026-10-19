import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import type { Payload, PayloadRequest } from 'payload'
import { portalPageUploadEndpoints } from '../../../src/endpoints/portal-page-uploads'
import { portalPageMediaMutationActor } from '../../../src/portal-pages/persistence'
import {
  createPortalPageUploadService,
  PORTAL_PAGE_UPLOAD_CHUNK_SIZE,
  PORTAL_PAGE_UPLOAD_MIN_FREE_BYTES,
  PORTAL_PAGE_UPLOAD_RETENTION_MS,
  PortalPageUploadError,
  verifyPortalPageUploadToken,
} from '../../../src/portal-pages/upload-service'
import { createPortalPageStorageKey } from '../../../src/portal-pages/validation'

const MiB = 1024 * 1024
const actor = 'editor-1'

function pdfBytes() { return Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n') }
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
  const service = (serviceActor = owner, serviceReq = { ...req, context: {} } as PayloadRequest) => createPortalPageUploadService({ payload, req: serviceReq, actorUid: serviceActor, uploadDir,
    now: () => clock, statfsFreeBytes: options.statfsFreeBytes || (async () => options.freeBytes ?? 10n * 1024n * 1024n * 1024n) })
  return { uploadDir, rows, payload, req, service, setTime: (next: number) => { clock = next }, dispose: () => rm(uploadDir, { recursive: true, force: true }) }
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
  const concurrentUploads = f.service()
  const [first, second] = await Promise.all([
    uploads.complete(started.id, { token: started.token }),
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

test('corrupt manifests, symlinked chunk files and traversal IDs fail closed without following external targets', async t => {
  const f = await fixture(); t.after(f.dispose)
  const uploads = f.service(), bytes = pdfBytes(), started = await begin(uploads, bytes)
  const incoming = path.join(f.uploadDir, 'portal-pages', '.incoming')
  const manifestPath = path.join(incoming, `m-${started.id}.json`)
  await writeFile(manifestPath, '{corrupt')
  f.setTime(Date.now() + PORTAL_PAGE_UPLOAD_RETENTION_MS + 1000)
  await assert.rejects(uploads.cleanupExpired(), (error: unknown) => error instanceof PortalPageUploadError && error.status === 503)
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
})
