import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { BasePayload, createLocalReq, type PayloadRequest, type RequiredDataFromCollectionSlug } from 'payload'
import { sql, type PostgresAdapter } from '@payloadcms/db-postgres'
import sharp from 'sharp'
import { openNewsMedia } from '../../src/media/read-file.js'
import { lockCmsReferences, requireCmsTransaction } from '../../src/publication/transaction.js'
import { legacyNewsImportContext } from '../../src/news/validation.js'

const database = new URL(process.env.CMS_DATABASE_URL || 'http://invalid')
const privateDir = process.env.TASK5_PRIVATE_DIR || ''
if (process.env.TASK5_DISPOSABLE !== 'cms_task5_test' || database.hostname !== '127.0.0.1' ||
  database.port !== '55441' || database.pathname !== '/cms_task5_test' || database.username !== 'cms_runtime' ||
  !path.basename(privateDir).startsWith('ownerinc-task5-') ||
  path.dirname(privateDir) !== path.join(process.env.LOCALAPPDATA || '', 'Temp', 'opencode') ||
  process.env.CMS_UPLOAD_DIR !== path.join(privateDir, 'uploads')) throw new Error('Refusing non-disposable Task5 test environment')

test('real PostgreSQL + pinned native operations (Portal authority transport is a double)', async t => {
  let mode = 'payload', authorityCalls = 0, unavailable = false
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:18085/api/internal/editorial/authority')
    assert.equal(init?.redirect, 'error')
    authorityCalls++
    return Response.json(unavailable ? { error: 'unavailable' } : { mode, epoch: 1 }, { status: unavailable ? 503 : 200 })
  }
  const payload = new BasePayload()
  const config = (await import('../../src/payload.config.js')).default
  await payload.init({ config, disableOnInit: true })
  const adapter = payload.db as unknown as PostgresAdapter
  const actor = { uid: 'task5-synthetic-editor', email: 'task5@example.invalid', name: 'Synthetic Editor', canManageNews: true }
  const projection = await payload.create({ collection: 'portal-editors', overrideAccess: true,
    data: { portalUid: actor.uid, email: actor.email, displayName: actor.name } })
  const user = { ...projection, collection: 'portal-editors' as const, portalActor: actor }
  const req = async () => createLocalReq({ user }, payload)
  const pdf = Buffer.from('%PDF-1.7\nTask5 synthetic only\nxref\n0 1\n0000000000 65535 f\ntrailer\n<< /Size 1 >>\nstartxref\n9\n%%EOF\n')
  const upload = async (bytes: Buffer = pdf, mimetype = 'application/pdf') => payload.create({ collection: 'news-media',
    req: await req(), overrideAccess: false, data: {} as RequiredDataFromCollectionSlug<'news-media'>,
    file: { data: bytes, mimetype, name: 'user-supplied.pdf', size: bytes.length } })
  const article = async (body: unknown[] = []) => payload.create({ collection: 'news-articles', req: await req(),
    overrideAccess: false, draft: true, data: { title: 'Synthetic article', category: '', body,
      editorial: { version: 1, kind: 'edition', summary: '', author: '', source_label: '', source_date: null } } as RequiredDataFromCollectionSlug<'news-articles'> })
  const begin = async () => {
    const request = await req()
    const id = await payload.db.beginTransaction()
    assert.ok(id)
    request.transactionID = id
    await lockCmsReferences(payload, request)
    return request
  }
  const commit = async (request: PayloadRequest) => {
    await payload.db.commitTransaction((await request.transactionID)!)
    delete request.transactionID
  }
  async function waitForBlockedLock() {
    for (let i = 0; i < 50; i++) {
      const locks = await adapter.drizzle.execute(sql`SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND objid = 7194030 AND NOT granted`)
      if (Number(locks.rows[0].count) > 0) return
      await delay(20)
    }
    assert.fail('Native operation did not block on advisory lock 7194030')
  }
  try {
    await t.test('restricted role and migrations; UUID filenames and PDF/JPEG/PNG/WebP SHA match ORIGINAL stored bytes', async () => {
      const identity = await adapter.drizzle.execute(sql`SELECT current_database() AS db, current_user AS role`)
      assert.deepEqual(identity.rows[0], { db: 'cms_task5_test', role: 'cms_runtime' })
      const files = [[pdf, 'application/pdf']] as [Buffer, string][]
      for (const format of ['jpeg', 'png', 'webp'] as const) files.push([await sharp({ create: { width: 4, height: 3, channels: 3, background: '#235678' } }).toFormat(format).toBuffer(), `image/${format}`])
      for (const [bytes, mime] of files) {
        const media = await upload(bytes, mime)
        assert.match(media.filename!, /^[0-9a-f-]{36}\.(pdf|jpg|png|webp)$/u)
        assert.deepEqual(await readFile(path.join(process.env.CMS_UPLOAD_DIR!, media.filename!)), bytes)
        assert.equal(media.sha256, createHash('sha256').update(bytes).digest('hex'))
      }
      assert.equal(Object.keys(adapter.sessions).length, 0, 'native operations must own their COMMIT')
    })

    await t.test('native update/replace/crop/remote/duplicate and invalid create refuse BEFORE any file mutation', async () => {
      const media = await upload()
      const before = (await readdir(process.env.CMS_UPLOAD_DIR!)).sort()
      for (const variant of ['replace', 'crop', 'remote', 'metadata']) {
        const request = await req()
        if (variant === 'crop') request.query = { uploadEdits: { crop: { x: 0, y: 0, width: 1, height: 1 } } }
        await assert.rejects(payload.update({ collection: 'news-media', id: media.id, req: request, overrideAccess: true,
          data: variant === 'remote' ? { url: 'https://not-contacted.invalid/file.pdf' } : { sha256: '0'.repeat(64) },
          ...(variant === 'replace' ? { file: { data: pdf, name: 'replacement.pdf', mimetype: 'application/pdf', size: pdf.length } } : {}) }), /media_immutable_create_new_asset/)
      }
      await assert.rejects(payload.create({ collection: 'news-media', req: await req(), overrideAccess: false,
        data: { url: 'https://not-contacted.invalid/file.pdf', filename: 'remote.pdf' } as RequiredDataFromCollectionSlug<'news-media'> }), /media_raw_file_required/)
      await assert.rejects(payload.create({ collection: 'news-media', req: await req(), overrideAccess: true,
        duplicateFromID: media.id, data: {} as RequiredDataFromCollectionSlug<'news-media'> }), /media_server_owned_file/)
      await assert.rejects(upload(Buffer.from('not PDF')), /invalid_media_signature/)
      assert.deepEqual((await readdir(process.env.CMS_UPLOAD_DIR!)).sort(), before)
      assert.deepEqual(await readFile(path.join(process.env.CMS_UPLOAD_DIR!, media.filename!)), pdf)
      assert.equal(Object.keys(adapter.sessions).length, 0, 'native failures must roll back')
    })

    await t.test('all normal article/media mutations refuse frozen/legacy/unavailable authority; read/preview remains available', async () => {
      const media = await upload(), document = await article()
      for (const denied of ['legacy', 'frozen', 'payload_frozen']) {
        mode = denied
        await assert.rejects(upload(), /cms_authority_read_only/)
        await assert.rejects(payload.update({ collection: 'news-articles', id: document.id, req: await req(), draft: true, data: { title: 'Denied' } }), /cms_authority_read_only/)
        await assert.rejects(payload.delete({ collection: 'news-media', id: media.id, req: await req() }), /cms_authority_read_only/)
        const read = await openNewsMedia({ payload, id: media.id, preview: true, actor, req: await req() })
        assert.equal(read.status, 200); await read.body!.cancel()
      }
      unavailable = true; mode = 'payload'
      await assert.rejects(upload(), /editorial_unavailable/)
      unavailable = false
      mode = 'legacy'
      await payload.create({ collection: 'news-articles', req: await req(), context: legacyNewsImportContext, draft: true,
        data: { title: 'Preparation import', category: '', body: [], editorial: null } })
      mode = 'payload'
    })

    await t.test('missing/dead native request transaction fails without default-adapter fallback', async () => {
      const request = await req()
      await assert.rejects(payload.create({ collection: 'news-articles', req: request, disableTransaction: true, draft: true,
        data: { title: 'No transaction', body: [] } }), /cms_transaction_required/)
      const dead = await req(); dead.transactionID = randomUUID()
      await assert.rejects(requireCmsTransaction(payload, dead), /cms_transaction_required/)
      await assert.rejects(payload.create({ collection: 'news-articles', req: dead, draft: true,
        data: { title: 'Dead transaction', body: [] } }), /cms_transaction_required/)
    })

    await t.test('lock precedes authority AND native originalDoc snapshot; PATCH waits and retains newly committed references', async () => {
      const media = await upload(), document = await article()
      const holder = await begin()
      const beforeAuthority = authorityCalls
      const pending = payload.update({ collection: 'news-articles', id: document.id, req: await req(), draft: true, depth: 0, data: { title: 'Waiter PATCH' } })
      // Attach a rejection handler now so a failed assertion cannot leave an unhandled promise.
      pending.catch(() => {})
      try {
        await waitForBlockedLock()
        assert.equal(authorityCalls, beforeAuthority, 'authority must be read AFTER the lock')
        await payload.update({ collection: 'news-articles', id: document.id, req: holder, draft: true,
          data: { body: [{ blockType: 'image', media: media.id }] } })
        assert.ok(adapter.sessions[(await holder.transactionID)!], 'nested native operation must not commit its caller transaction')
        await commit(holder)
        const updated = await pending
        assert.equal(updated.body?.[0].blockType, 'image')
        assert.equal((updated.body?.[0] as { media: string }).media, media.id)
        assert.equal(updated.title, 'Waiter PATCH')
      } finally { if (holder.transactionID) await payload.db.rollbackTransaction((await holder.transactionID)!) }
    })

    await t.test('concurrent delete waits for incomplete draft reference, then refuses; ALL native history remains protective', async () => {
      const media = await upload(), document = await article()
      const holder = await begin()
      await payload.update({ collection: 'news-articles', id: document.id, req: holder, draft: true,
        data: { body: [{ blockType: 'image', media: media.id }] } })
      const pending = payload.delete({ collection: 'news-media', id: media.id, req: await req() })
      const denied = assert.rejects(pending, /media_is_referenced/)
      try { await waitForBlockedLock(); await commit(holder); await denied }
      finally { if (holder.transactionID) await payload.db.rollbackTransaction((await holder.transactionID)!) }
      await payload.update({ collection: 'news-articles', id: document.id, req: await req(), draft: true, data: { body: [] } })
      await assert.rejects(payload.delete({ collection: 'news-media', id: media.id, req: await req() }), /media_is_referenced/)
      await assert.rejects(payload.delete({ collection: 'news-articles', id: document.id, req: await req() }), /news_history_retention_required/)
      const versions = await payload.findVersions({ collection: 'news-articles', depth: 0, where: { parent: { equals: document.id } } })
      const previous = versions.docs.find(row => row.version.body?.some(block => block.blockType === 'image'))!
      const lock = await begin()
      const restore = payload.restoreVersion({ collection: 'news-articles', id: previous.id, req: await req(), draft: true })
      restore.catch(() => {})
      try { await waitForBlockedLock(); await commit(lock); await restore }
      finally { if (lock.transactionID) await payload.db.rollbackTransaction((await lock.transactionID)!) }
      assert.deepEqual(await readFile(path.join(process.env.CMS_UPLOAD_DIR!, media.filename!)), pdf)
    })

    await t.test('native publication validates live MIME/files; actual published revision, shared grant, unpublish, Range and missing file', async () => {
      const media = await upload(), document = await article([{ blockType: 'pdf', media: media.id, title: 'Synthetic PDF' }])
      const viewer = { ...actor, canManageNews: false }
      const read = async () => openNewsMedia({ payload, id: media.id, actor: viewer, req: await req() })
      assert.equal((await read()).status, 403)
      await payload.update({ collection: 'news-articles', id: document.id, req: await req(), data: { _status: 'published' } })
      let response = await read(); assert.equal(response.status, 200); await response.body!.cancel()
      // New draft must not replace the current published grant.
      await payload.update({ collection: 'news-articles', id: document.id, req: await req(), draft: true, data: { body: [] } })
      response = await read(); assert.equal(response.status, 200); await response.body!.cancel()
      const other = await article([{ blockType: 'pdf', media: media.id, title: 'Shared' }])
      await payload.update({ collection: 'news-articles', id: other.id, req: await req(), data: { _status: 'published' } })
      await payload.update({ collection: 'news-articles', id: document.id, req: await req(), data: { _status: 'draft' } })
      response = await read(); assert.equal(response.status, 200); await response.body!.cancel()
      response = await openNewsMedia({ payload, id: media.id, actor: viewer, range: 'bytes=0-3', req: await req() })
      assert.equal(response.status, 206); assert.equal(Buffer.from(await new Response(response.body).arrayBuffer()).toString(), '%PDF')
      await payload.update({ collection: 'news-articles', id: other.id, req: await req(), data: { _status: 'draft' } })
      assert.equal((await read()).status, 403)
      const wrong = await article([{ blockType: 'image', media: media.id, alt: 'Wrong MIME' }, { blockType: 'pdf', media: media.id, title: 'Edition' }])
      await assert.rejects(payload.update({ collection: 'news-articles', id: wrong.id, req: await req(), data: { _status: 'published' } }), /invalid_media_reference/)
      await writeFile(path.join(process.env.CMS_UPLOAD_DIR!, media.filename!), Buffer.alloc(pdf.length))
      await assert.rejects(payload.update({ collection: 'news-articles', id: other.id, req: await req(), data: { _status: 'published' } }), /media_unavailable/)
      await writeFile(path.join(process.env.CMS_UPLOAD_DIR!, media.filename!), pdf)
    })

    await t.test('orphan deletion waits for read descriptor-open transaction; stream survives unlink and closes on cancel/abort', async () => {
      const media = await upload()
      const holder = await begin()
      const response = await openNewsMedia({ payload, id: media.id, actor, preview: true, req: holder })
      assert.equal(response.status, 200)
      const pending = payload.delete({ collection: 'news-media', id: media.id, req: await req() })
      pending.catch(() => {})
      try {
        await waitForBlockedLock(); await commit(holder); await pending
        assert.deepEqual(Buffer.from(await new Response(response.body).arrayBuffer()), pdf)
        await assert.rejects(readFile(path.join(process.env.CMS_UPLOAD_DIR!, media.filename!)), { code: 'ENOENT' })
      } finally { if (holder.transactionID) await payload.db.rollbackTransaction((await holder.transactionID)!) }
      const next = await upload(), abort = new AbortController(), request = await req()
      Object.defineProperty(request, 'signal', { value: abort.signal })
      const aborted = await openNewsMedia({ payload, id: next.id, actor, preview: true, req: request })
      abort.abort(); await assert.rejects(new Response(aborted.body).arrayBuffer(), /Aborted/)
      const cancelled = await openNewsMedia({ payload, id: next.id, actor, preview: true, req: await req() })
      await cancelled.body!.cancel()
      assert.equal(Object.keys(adapter.sessions).length, 0)
    })
  } finally {
    globalThis.fetch = originalFetch
    await payload.destroy()
  }
})
