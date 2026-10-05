import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import sharp from 'sharp'
import { createOperation, updateByIDOperation, updateOperation, restoreVersionOperation, type Payload, type PayloadRequest, type RequiredDataFromCollectionSlug } from 'payload'

test('pinned native early lifecycle rejects before snapshot/filesystem; DB and authority transport are explicitly doubles', async t => {
  const previousEnv = { ...process.env }, previousFetch = globalThis.fetch
  const temporaryRoot = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir()
  const directory = await mkdtemp(path.join(temporaryRoot, 'task5-native-unit-'))
  Object.assign(process.env, {
    CMS_BUILD_ONLY: 'true', NEXT_PHASE: 'phase-production-build', NODE_ENV: 'development',
    CMS_DATABASE_URL: 'postgresql://not-connected.invalid/task5', PAYLOAD_SECRET: 'synthetic-task5-payload-not-a-runtime-secret',
    PAYLOAD_TO_PORTAL_SECRET: 'synthetic-task5-outbound-not-a-runtime-secret', PORTAL_TO_PAYLOAD_SECRET: 'synthetic-task5-inbound-not-a-runtime-secret',
    PORTAL_PUBLIC_URL: 'http://localhost:18085', PORTAL_INTERNAL_URL: 'http://127.0.0.1:18085', CMS_UPLOAD_DIR: directory,
  })
  const config = await (await import('../../../src/payload.config.js')).default
  const mediaConfig = config.collections.find(c => c.slug === 'news-media')!
  if (mediaConfig.upload) mediaConfig.upload.staticDir = directory
  const articlesConfig = config.collections.find(c => c.slug === 'news-articles')!
  let mode = 'payload'
  let persisted: Record<string, unknown> | undefined
  const events: string[] = []
  globalThis.fetch = async input => {
    if (String(input).endsWith('/actor/check')) {
      events.push('actor'); return Response.json({ actor: { uid: 'test', email: 'test@example.invalid', name: null, canManageNews: true } })
    }
    events.push('authority'); return Response.json({ mode, epoch: 1 })
  }
  const sessions: Record<string, { db: { execute: () => Promise<void> } }> = {}
  const payload = {
    config,
    collections: { 'news-media': { config: mediaConfig } },
    find: async () => ({ docs: [] }),
    findVersionByID: async () => { events.push('snapshot'); throw new Error('native_snapshot_reached') },
    logger: { error: () => {} },
    db: {
      sessions,
      beginTransaction: async () => {
        events.push('begin'); const id = randomUUID()
        sessions[id] = { db: { execute: async () => { events.push('lock') } } }; return id
      },
      rollbackTransaction: async (id: string) => { events.push('rollback'); delete sessions[id] },
      findOne: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.filename) return null // Native UUID filename collision query; no real DB in this unit test.
        events.push('snapshot'); throw new Error('native_snapshot_reached')
      },
      findVersions: async () => { events.push('snapshot'); throw new Error('native_snapshot_reached') },
      create: async ({ data }: { data: Record<string, unknown> }) => { persisted = data; throw new Error('test_persist_boundary') },
    },
  } as unknown as Payload
  const request = () => ({ payload, context: {}, query: {}, t: (key: string) => key, user: { id: randomUUID(), collection: 'portal-editors',
    portalUid: 'test', portalActor: { uid: 'test', canManageNews: true } } } as unknown as PayloadRequest)
  const collection = { config: mediaConfig }
  const file = path.join(directory, 'preserved.pdf')
  await writeFile(file, 'preserve native bytes')
  try {
    await t.test('replace, crop and URL update stop before getLatestCollectionVersion/generateFileData even with overrideAccess', async () => {
      for (const variant of ['replace', 'crop', 'url']) {
        events.length = 0
        const req = request()
        if (variant === 'replace') req.file = { data: Buffer.from('new'), name: 'new.pdf', mimetype: 'application/pdf', size: 3 }
        if (variant === 'crop') req.query = { uploadEdits: { crop: {} } }
        await assert.rejects(updateByIDOperation({ id: randomUUID(), collection, overrideAccess: true, req,
          data: variant === 'url' ? { url: 'https://must-not-fetch.invalid/file' } : {} }), /media_immutable_create_new_asset/)
        assert.deepEqual(events, ['begin', 'lock', 'lock', 'authority', 'actor', 'rollback'])
        assert.equal(await readFile(file, 'utf8'), 'preserve native bytes')
      }
    })
    await t.test('remote-only create and invalid signature stop before generateFileData writes/remote fetch', async () => {
      events.length = 0
      await assert.rejects(createOperation({ collection, overrideAccess: false, req: request(),
        data: { url: 'https://must-not-fetch.invalid/file.pdf', filename: 'file.pdf' } as RequiredDataFromCollectionSlug<'news-media'> }), /media_raw_file_required/)
      const req = request(); req.file = { data: Buffer.from('not PDF'), size: 7, mimetype: 'application/pdf', name: 'x.pdf' }
      await assert.rejects(createOperation({ collection, overrideAccess: true, req, data: {} }), /invalid_media_signature/)
      assert.deepEqual(await readdir(directory), ['preserved.pdf'])
    })
    await t.test('missing/dead sessions refuse and frozen authority runs only AFTER the lock; read snapshot never occurs', async () => {
      events.length = 0
      await assert.rejects(updateByIDOperation({ id: randomUUID(), collection, overrideAccess: true, req: request(),
        disableTransaction: true, data: {} }), /cms_transaction_required/)
      assert.deepEqual(events, [])
      const req = request(); req.transactionID = 'dead'
      await assert.rejects(updateByIDOperation({ id: randomUUID(), collection, overrideAccess: true, req, data: {} }), /cms_transaction_required/)
      for (mode of ['legacy', 'frozen', 'payload_frozen']) {
        events.length = 0
        await assert.rejects(updateByIDOperation({ id: randomUUID(), collection: { config: articlesConfig }, overrideAccess: true,
          req: request(), data: { title: 'No' } }), /cms_authority_read_only/)
        assert.deepEqual(events, ['begin', 'lock', 'lock', 'authority', 'rollback'])
      }
      mode = 'payload'
    })
    await t.test('native single article PATCH and restore reach snapshot only after lock+authority; unsafe bulk updates denied', async () => {
      for (const operation of ['update', 'restore']) {
        events.length = 0
        const args = { id: randomUUID(), collection: { config: articlesConfig }, overrideAccess: true, req: request() }
        await assert.rejects(operation === 'update' ? updateByIDOperation({ ...args, data: {} }) : restoreVersionOperation(args), /native_snapshot_reached/)
        assert.equal(events[0], 'begin')
        assert.ok(events.indexOf('lock') < events.indexOf('authority'))
        assert.ok(events.indexOf('authority') < events.indexOf('actor'))
        assert.ok(events.indexOf('actor') < events.indexOf('snapshot'))
        assert.equal(events.at(-1), 'rollback')
      }
      await assert.rejects(updateOperation({ collection: { config: articlesConfig }, req: request(), overrideAccess: true,
        data: {}, where: { id: { exists: true } } }), /news_update_requires_single_id/)
      assert.equal(Object.keys(sessions).length, 0)
    })
    await t.test('real native file generation/writes preserve original PNG/JPEG/WebP/PDF bytes before doubled DB persistence', async () => {
      const files: [Buffer, string][] = [[Buffer.from('%PDF-1.7\nxref\n0 1\n0000000000 65535 f\n%%EOF\n'), 'application/pdf']]
      for (const format of ['jpeg', 'png', 'webp'] as const) files.push([
        await sharp({ create: { width: 3, height: 2, channels: 3, background: '#123456' } }).toFormat(format).toBuffer(), `image/${format}`,
      ])
      assert.equal(config.sharp, undefined)
      for (const [bytes, mimetype] of files) {
        const req = request()
        req.file = { data: bytes, name: 'user-filename', mimetype, size: bytes.length }
        persisted = undefined
        await assert.rejects(createOperation({ collection, req, overrideAccess: false,
          data: {} as RequiredDataFromCollectionSlug<'news-media'> }), /test_persist_boundary/)
        assert.ok(persisted)
        const doc = persisted as Record<string, unknown>
        assert.match(String(doc.filename), /^[0-9a-f-]{36}\.(pdf|jpg|png|webp)$/u)
        assert.equal(doc.sha256, createHash('sha256').update(bytes).digest('hex'))
        assert.deepEqual(await readFile(path.join(directory, String(doc.filename))), bytes)
      }
    })
  } finally {
    globalThis.fetch = previousFetch
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key]
    Object.assign(process.env, previousEnv)
    await rm(directory, { recursive: true, force: true })
  }
})
