import assert from 'node:assert/strict'
import test from 'node:test'
import { validateUpload } from '../../src/media/validate-upload.js'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { APIError, type Payload, type PayloadRequest, type Where } from 'payload'
import { collectMediaIds, assertMediaOrphan, canReadPublishedMedia } from '../../src/media/references.js'
import { createNewsMedia } from '../../src/collections/NewsMedia.js'
import { NewsMigrationItems } from '../../src/collections/NewsMigrationItems.js'
import { NewsMigrationRuns } from '../../src/collections/NewsMigrationRuns.js'
import { getFileHandler } from '../../node_modules/payload/dist/uploads/endpoints/getFile.js'
import { normalizeNewsDraftReferences } from '../../src/news/validation.js'
import { mediaRange, openNewsMedia } from '../../src/media/read-file.js'
import { openStoredMedia } from '../../src/media/storage.js'
import { requireCmsTransaction, withCmsTransaction } from '../../src/publication/transaction.js'

const pdf = Buffer.from('%PDF-1.7\nsynthetic fixture; not a full PDF parser test\n%%EOF\n')
const assetID = 'a0000000-0000-4000-8000-000000000001'
const actor = { uid: 'synthetic-reader', email: 'reader@example.invalid', name: null, canManageNews: false }
const editor = { ...actor, canManageNews: true }

test('recusa PDF acima do limite editorial de 50 MiB', async () => {
  await assert.rejects(validateUpload({ bytes: Buffer.alloc(50 * 1024 * 1024 + 1),
    mime: 'application/pdf', filename: 'synthetic.pdf' }), /media_too_large/)
})

test('all MIME families have the same hard cap; signature mismatch, empty and traversal inputs fail', async () => {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm', 'video/quicktime']) {
    await assert.rejects(validateUpload({ bytes: Buffer.alloc(50 * 1024 * 1024 + 1), mime, filename: 'x' }), /media_too_large/)
    await assert.rejects(validateUpload({ bytes: Buffer.from('not media'), mime, filename: 'x' }), /invalid_media_signature/)
  }
  await assert.rejects(validateUpload({ bytes: pdf, mime: 'application/pdf', filename: '../x.pdf' }), /invalid_media_upload/)
  await assert.rejects(validateUpload({ bytes: Buffer.alloc(0), mime: 'application/pdf', filename: 'x.pdf' }))
  const boundary = Buffer.alloc(50 * 1024 * 1024, 32)
  pdf.copy(boundary); Buffer.from('%%EOF\n').copy(boundary, boundary.length - 6)
  assert.equal((await validateUpload({ bytes: boundary, mime: 'application/pdf', filename: 'x.pdf' })).size, boundary.length)
})

test('sharp decodes JPEG/PNG/WebP but SHA remains the original bytes; truncated images fail', async () => {
  for (const format of ['jpeg', 'png', 'webp'] as const) {
    const bytes = await sharp({ create: { width: 2, height: 3, channels: 3, background: '#335577' } }).toFormat(format).toBuffer()
    const result = await validateUpload({ bytes, mime: `image/${format}`, filename: `image.${format}` })
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'))
    await assert.rejects(validateUpload({ bytes: bytes.subarray(0, 24), mime: `image/${format}`, filename: `image.${format}` }))
  }
  const large = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: '#000' } }).png().toBuffer()
  await assert.rejects(validateUpload({ bytes: large, mime: 'image/png', filename: 'large.png' }), /invalid_media_image/)
})

test('bounded container headers distinguish MP4, QuickTime and WebM (not codec validity)', async () => {
  for (const [brand, mime] of [['isom', 'video/mp4'], ['qt  ', 'video/quicktime']]) {
    const bytes = Buffer.alloc(24); bytes.writeUInt32BE(24); bytes.write('ftyp', 4); bytes.write(brand, 8)
    assert.equal((await validateUpload({ bytes, mime, filename: 'video' })).mime, mime)
    await assert.rejects(validateUpload({ bytes, mime: mime === 'video/mp4' ? 'video/quicktime' : 'video/mp4', filename: 'video' }))
  }
  const bytes = Buffer.from('1a45dfa3874282847765626d', 'hex')
  assert.equal((await validateUpload({ bytes, mime: 'video/webm', filename: 'video.webm' })).mime, 'video/webm')
})

test('reference projection retains incomplete chosen relations; flat collector never searches JSON text', () => {
  const blocks = normalizeNewsDraftReferences([{ blockType: 'image', media: { id: assetID.toUpperCase() } },
    { blockType: 'pdf', media: assetID, title: null }, { blockType: 'quote', text: assetID }])
  assert.deepEqual([...collectMediaIds(blocks)], [assetID])
  assert.deepEqual([...collectMediaIds([{ type: 'quote', text: assetID }])], [])
  assert.throws(() => normalizeNewsDraftReferences([{ blockType: 'unknown', media: assetID }]))
  assert.throws(() => normalizeNewsDraftReferences([{ blockType: 'image', media: 'invalid' }]))
})

test('single ranges cover suffix/open/oversized-end and reject multiple, negative, unsafe and unsatisfiable', () => {
  assert.deepEqual(mediaRange('bytes=2-4', 10), { start: 2, end: 4, partial: true })
  assert.deepEqual(mediaRange('bytes=-3', 10), { start: 7, end: 9, partial: true })
  assert.deepEqual(mediaRange('bytes=4-', 10), { start: 4, end: 9, partial: true })
  assert.deepEqual(mediaRange('bytes=0-99', 10), { start: 0, end: 9, partial: true })
  for (const invalid of ['bytes=10-', 'bytes=4-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,2-3', 'bytes=9007199254740992-', 'items=1-2']) assert.equal(mediaRange(invalid, 10), null)
})

async function fixture() {
  const directory = await mkdtemp(path.join(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir(), 'task5-unit-'))
  const asset = { id: assetID, filename: `${randomUUID()}.pdf`, mimeType: 'application/pdf', filesize: pdf.length,
    sha256: createHash('sha256').update(pdf).digest('hex') }
  await writeFile(path.join(directory, asset.filename), pdf)
  const assets = new Map([[assetID, asset]])
  const articles: Record<string, unknown>[] = []
  const versions: Record<string, unknown>[] = []
  const calls: string[] = []
  const sessions: Record<string, unknown> = { live: { db: { execute: async () => { calls.push('lock') } } } }
  const payload = {
    db: { sessions, beginTransaction: async () => { calls.push('begin'); return 'live' },
      commitTransaction: async () => { calls.push('commit') }, rollbackTransaction: async () => { calls.push('rollback') } },
    collections: { 'news-media': { config: { upload: { staticDir: directory } } }, 'news-articles': { config: { fields: [], versions: { maxPerDoc: 0 } } },
      'news-migration-runs': { config: NewsMigrationRuns }, 'news-migration-items': { config: NewsMigrationItems } },
    config: { globals: [], jobs: { tasks: [] } },
    findByID: async ({ id, req }: { id: string; req: PayloadRequest }) => { assert.equal(req.transactionID, 'live'); return assets.get(id) || null },
    find: async ({ req, collection, where }: { req: PayloadRequest; collection: string; where?: Where }) => {
      assert.equal(req.transactionID, 'live')
      const field = where?.filename
      const filename = Array.isArray(field) ? undefined : field?.equals
      return { docs: collection === 'news-media' ? [...assets.values()].filter(asset => asset.filename === filename) : articles, hasNextPage: false }
    },
    findVersions: async ({ req }: { req: PayloadRequest }) => { assert.equal(req.transactionID, 'live'); return { docs: versions.map(version => ({ version })), hasNextPage: false } },
  } as unknown as Payload
  const req = { transactionID: 'live', payload } as PayloadRequest
  return { directory, asset, assets, articles, versions, calls, sessions, payload, req, cleanup: () => rm(directory, { force: true, recursive: true }) }
}

test('I1 actual native getFileHandler: boolean access without prefix still resolves editor bytes under the lock', async () => {
  const f = await fixture()
  try {
    const config = createNewsMedia({ uploadDir: f.directory })
    Object.assign(f.payload.collections['news-media'], { config })
    const req = { ...f.req, routeParams: { collection: 'news-media', filename: f.asset.filename },
      searchParams: new URLSearchParams(), headers: new Headers(), t: (key: string) => key,
      user: { id: randomUUID(), collection: 'portal-editors', portalUid: editor.uid, portalActor: editor } } as unknown as PayloadRequest
    assert.equal(await config.access!.read!({ req }), true)
    assert.equal(req.searchParams!.get('prefix'), null)
    for (const user of [null, { ...req.user!, portalActor: actor }]) {
      const calls = f.calls.length
      await assert.rejects(async () => getFileHandler({ ...req, user } as PayloadRequest), error => error instanceof APIError && error.status === 403)
      assert.equal(f.calls.length, calls, 'denied native access must precede transaction/file access')
    }
    const response = await getFileHandler(req)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('Cache-Control'), 'private,no-store')
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), pdf)
    req.headers.set('range', 'bytes=0-3')
    const range = await getFileHandler(req)
    assert.equal(range.status, 206)
    assert.equal(range.headers.get('Content-Range'), `bytes 0-3/${pdf.length}`)
    assert.equal(Buffer.from(await range.arrayBuffer()).toString(), '%PDF')
    req.routeParams!.filename = `${randomUUID()}.pdf`
    assert.equal((await getFileHandler(req)).status, 404)
    assert.ok(f.calls.includes('lock'))
  } finally { await f.cleanup() }
})

test('I2 a damaged sibling asset cannot shadow a healthy shared grant in either publication order', async () => {
  const f = await fixture()
  try {
    const y = { ...f.asset, id: randomUUID(), filename: `${randomUUID()}.pdf` }
    f.assets.set(y.id, y)
    const base = { title: 'Synthetic edition', category: '', editorial: { version: 1, kind: 'edition', summary: '', author: '', source_label: '', source_date: null }, _status: 'published' }
    const xBlock = { blockType: 'pdf', media: f.asset.id, title: 'Healthy X' }
    const damaged = { ...base, body: [xBlock, { blockType: 'pdf', media: y.id, title: 'Damaged Y' }] }
    const healthy = { ...base, body: [xBlock] }
    for (const corruption of ['missing', 'corrupt']) {
      if (corruption === 'corrupt') await writeFile(path.join(f.directory, y.filename), Buffer.alloc(pdf.length))
      for (const docs of [[damaged, healthy], [healthy, damaged]]) {
        f.articles.splice(0, f.articles.length, ...docs)
        const response = await openNewsMedia({ payload: f.payload, id: f.asset.id, actor, req: f.req })
        assert.equal(response.status, 200, `${corruption}: a healthy grant must win in either order`)
        assert.deepEqual(Buffer.from(await new Response(response.body).arrayBuffer()), pdf)
      }
      f.articles.splice(0, f.articles.length, damaged)
      assert.equal((await openNewsMedia({ payload: f.payload, id: f.asset.id, actor, req: f.req })).status, 503)
    }
    f.articles.splice(0, f.articles.length, damaged, healthy)
    const dbError = new APIError('media_unavailable', 503, undefined, true)
    const findByID = f.payload.findByID
    f.payload.findByID = (async (args: { id: string }) => { if (args.id === y.id) throw dbError; return f.asset }) as typeof findByID
    await assert.rejects(canReadPublishedMedia(f.payload, f.asset.id, f.req), error => error === dbError)
    assert.equal((await openNewsMedia({ payload: f.payload, id: f.asset.id, actor, req: f.req })).status, 503)
    f.payload.findByID = findByID
  } finally { await f.cleanup() }
})

test('missing/dead request sessions refuse instead of using default adapter; nested helpers do not commit', async () => {
  const f = await fixture()
  try {
    await assert.rejects(requireCmsTransaction(f.payload, { payload: f.payload } as PayloadRequest), /cms_transaction_required/)
    await assert.rejects(withCmsTransaction(f.payload, { ...f.req, transactionID: 'dead' }, async () => true), /cms_transaction_required/)
    assert.equal(await withCmsTransaction(f.payload, f.req, async req => req === f.req), true)
    assert.ok(!f.calls.includes('commit'))
  } finally { await f.cleanup() }
})

test('editor draft 200, viewer draft 403, anonymous 401, missing 404, publication/shared/unpublish gates', async () => {
  const f = await fixture()
  try {
    const read = (who = actor, preview = false, id = assetID, range?: string) => openNewsMedia({ payload: f.payload, id, actor: who, preview, req: f.req, range })
    assert.equal((await openNewsMedia({ payload: f.payload, id: assetID, actor: null, req: f.req })).status, 401)
    assert.equal((await read()).status, 403)
    assert.equal((await read(actor, true)).status, 403)
    assert.equal((await read(editor, true, randomUUID())).status, 404)
    let response = await read(editor, true)
    assert.equal(response.status, 200)
    assert.deepEqual(Buffer.from(await new Response(response.body).arrayBuffer()), pdf)
    assert.equal(response.headers['Cache-Control'], 'private,no-store')
    assert.equal(response.headers['X-Content-Type-Options'], 'nosniff')
    assert.equal(response.headers['Content-Disposition'], `inline; filename="${f.asset.filename}"`)
    const published = { title: 'Synthetic edition', category: '', editorial: { version: 1, kind: 'edition', summary: '', author: '', source_label: '', source_date: null },
      _status: 'published', body: [{ blockType: 'pdf', media: assetID, title: 'PDF' }] }
    f.articles.push(published)
    response = await read()
    assert.equal(response.status, 200); await response.body!.cancel()
    response = await read(actor, false, assetID, 'bytes=0-3')
    assert.equal(response.status, 206)
    assert.deepEqual(Buffer.from(await new Response(response.body).arrayBuffer()), pdf.subarray(0, 4))
    assert.equal((await read(actor, false, assetID, 'bytes=900-')).status, 416)
    f.articles.push({ ...published }); published._status = 'draft'
    response = await read(); assert.equal(response.status, 200); await response.body!.cancel()
    f.articles[1]._status = 'draft'
    assert.equal((await read()).status, 403)
    await rm(path.join(f.directory, f.asset.filename))
    assert.equal((await read(editor, true)).status, 503)
  } finally { await f.cleanup() }
})

test('orphan guard retains incomplete drafts and every old version; unknown configured stores fail closed', async () => {
  const f = await fixture()
  try {
    f.articles.push({ body: [{ blockType: 'image', media: assetID }] })
    await assert.rejects(assertMediaOrphan(f.payload, assetID, f.req), /media_is_referenced/)
    f.versions.push(f.articles.pop()!)
    await assert.rejects(assertMediaOrphan(f.payload, assetID, f.req), /media_is_referenced/)
    f.versions.length = 0
    await assertMediaOrphan(f.payload, assetID, f.req)
    Object.assign(f.payload.collections, { 'future-snapshots': { config: {} } })
    await assert.rejects(assertMediaOrphan(f.payload, assetID, f.req), /media_reference_store_not_covered/)
  } finally { await f.cleanup() }
})

test('private descriptor rejects traversal, external URL and altered bytes; abort/cancel release streams', async t => {
  const f = await fixture()
  try {
    for (const filename of ['../secret.pdf', 'https://example.invalid/file.pdf']) await assert.rejects(openStoredMedia(f.payload, { ...f.asset, filename }), /media_unavailable/)
    await writeFile(path.join(f.directory, f.asset.filename), Buffer.alloc(pdf.length))
    await assert.rejects(openStoredMedia(f.payload, f.asset), /media_unavailable/)
    await writeFile(path.join(f.directory, f.asset.filename), pdf)
    const abort = new AbortController()
    const response = await openNewsMedia({ payload: f.payload, id: assetID, preview: true, actor: editor, req: { ...f.req, signal: abort.signal } })
    abort.abort()
    await assert.rejects(new Response(response.body).arrayBuffer(), /Aborted/)
    const cancelled = await openNewsMedia({ payload: f.payload, id: assetID, preview: true, actor: editor, req: f.req })
    await cancelled.body!.cancel()
    await t.test('symbolic-link file is rejected (requires symlink permission)', async t => {
      const outside = await mkdtemp(path.join(path.dirname(f.directory), 'task5-outside-'))
      try {
        const target = path.join(outside, 'outside.pdf')
        await writeFile(target, pdf)
        await rm(path.join(f.directory, f.asset.filename))
        try { await symlink(target, path.join(f.directory, f.asset.filename)) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
          t.skip('Windows EPERM; real Linux symlink acceptance pending')
          return
        }
        await assert.rejects(openStoredMedia(f.payload, f.asset), /media_unavailable/)
        assert.deepEqual(await readFile(target), pdf)
      } finally { await rm(outside, { recursive: true, force: true }) }
    })
  } finally { await f.cleanup() }
})
