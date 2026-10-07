import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { APIError, BasePayload, createLocalReq, type PayloadRequest, type RequiredDataFromCollectionSlug } from 'payload'
import { sql, type PostgresAdapter } from '@payloadcms/db-postgres'
import sharp from 'sharp'
import { openNewsMedia } from '../../src/media/read-file.js'
import { canReadPublishedMedia } from '../../src/media/references.js'
import { getFileHandler } from '../../node_modules/payload/dist/uploads/endpoints/getFile.js'
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
    if (String(input) === 'http://127.0.0.1:18085/api/internal/editorial/actor/check') {
      assert.equal(JSON.parse(String(init?.body)).uid, actor.uid)
      return Response.json({ actor })
    }
    assert.equal(String(input), 'http://127.0.0.1:18085/api/internal/editorial/authority')
    assert.equal(init?.redirect, 'error')
    authorityCalls++
    return Response.json(unavailable ? { error: 'unavailable' } : { mode, epoch: 1 }, { status: unavailable ? 503 : 200 })
  }
  const payload = new BasePayload()
  const config = await (await import('../../src/payload.config.js')).default
  // Generation has its own CLI check. Native-op tests must not spawn an unmanaged
  // background `payload generate:types` process on development initialization.
  config.typescript.autoGenerate = false
  await payload.init({ config, disableOnInit: true })
  const adapter = payload.db as unknown as PostgresAdapter
  const actor = { uid: `task5-synthetic-${randomUUID()}`, email: 'task5@example.invalid', name: 'Synthetic Editor', canManageNews: true }
  const projection = await payload.create({ collection: 'portal-editors', overrideAccess: true,
    data: { portalUid: actor.uid, email: actor.email, displayName: actor.name } })
  const user = { ...projection, collection: 'portal-editors' as const, portalActor: actor, portalExpiresAt: new Date(Date.now() + 3600000).toISOString() }
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
      const locks = await adapter.drizzle.execute(sql`SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND objid = 7194030 AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
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

    await t.test('I1 actual native getFileHandler with boolean access/no prefix: auth, locked lookup, bytes/hash, Range and no path fallback', async () => {
      const media = await upload()
      const nativeRequest = async (filename = media.filename!, range?: string) => {
        const request = await req()
        request.routeParams = { collection: 'news-media', filename }
        request.searchParams?.delete('prefix')
        request.headers = new Headers(range ? { range } : {})
        return request
      }
      const request = await nativeRequest()
      assert.equal(await payload.collections['news-media'].config.access.read({ req: request }), true)
      assert.equal(request.searchParams!.get('prefix'), null)
      for (const denied of [null, { ...user, portalActor: { ...actor, canManageNews: false } }]) {
        const request = await nativeRequest(); request.user = denied
        await assert.rejects(async () => getFileHandler(request), error => error instanceof APIError && error.status === 403)
      }
      const lock = await begin()
      const pending = Promise.resolve(getFileHandler(request)); pending.catch(() => {})
      try {
        await waitForBlockedLock(); await commit(lock)
        const response = await pending
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('Content-Type'), 'application/pdf')
        assert.equal(response.headers.get('Content-Length'), String(pdf.length))
        assert.equal(response.headers.get('Cache-Control'), 'private,no-store')
        assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
        assert.equal(response.headers.get('Content-Disposition'), `inline; filename="${media.filename}"`)
        const bytes = Buffer.from(await response.arrayBuffer())
        assert.deepEqual(bytes, pdf)
        assert.equal(createHash('sha256').update(bytes).digest('hex'), media.sha256)
      } finally { if (lock.transactionID) await payload.db.rollbackTransaction((await lock.transactionID)!) }
      const range = await getFileHandler(await nativeRequest(media.filename!, 'bytes=0-3'))
      assert.equal(range.status, 206)
      assert.equal(range.headers.get('Content-Range'), `bytes 0-3/${pdf.length}`)
      assert.equal(Buffer.from(await range.arrayBuffer()).toString(), '%PDF')
      assert.equal((await getFileHandler(await nativeRequest(media.filename!, 'bytes=9999-'))).status, 416)
      const orphanFilename = `${randomUUID()}.pdf`
      await writeFile(path.join(process.env.CMS_UPLOAD_DIR!, orphanFilename), pdf)
      try { assert.equal((await getFileHandler(await nativeRequest(orphanFilename))).status, 404, 'an actual orphan file must NOT use the native filesystem fallback') }
      finally { await rm(path.join(process.env.CMS_UPLOAD_DIR!, orphanFilename)) }
      await rm(path.join(process.env.CMS_UPLOAD_DIR!, media.filename!))
      try { assert.equal((await getFileHandler(await nativeRequest())).status, 503) }
      finally { await writeFile(path.join(process.env.CMS_UPLOAD_DIR!, media.filename!), pdf) }
      assert.equal(Object.keys(adapter.sessions).length, 0)
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
      const image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#234567' } }).png().toBuffer()
      const media = await upload(image, 'image/png'), document = await article()
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
      try {
        await waitForBlockedLock(); await commit(lock)
        const restored = await restore
        const block = restored.body?.[0]
        assert.equal(block?.blockType, 'image')
        assert.ok(block && 'media' in block)
        assert.equal(typeof block.media === 'string' ? block.media : block.media?.id, media.id)
        assert.ok(!('alt' in block) || !block.alt, 'restore retains the intentionally unfinished alt')
      }
      finally { if (lock.transactionID) await payload.db.rollbackTransaction((await lock.transactionID)!) }
      await assert.rejects(payload.delete({ collection: 'news-media', id: media.id, req: await req() }), /media_is_referenced/)
      assert.deepEqual(await readFile(path.join(process.env.CMS_UPLOAD_DIR!, media.filename!)), image)
    })

    await t.test('native restore still rejects an image referencing PDF; rejected restore rolls back without altering bytes', async () => {
      const media = await upload(), document = await article([{ blockType: 'image', media: media.id }])
      const versions = await payload.findVersions({ collection: 'news-articles', depth: 0, where: { parent: { equals: document.id } } })
      const incompatible = versions.docs.find(row => row.version.body?.some(block => block.blockType === 'image'))!
      assert.ok(incompatible)
      await payload.update({ collection: 'news-articles', id: document.id, req: await req(), draft: true, data: { body: [] } })
      await assert.rejects(payload.restoreVersion({ collection: 'news-articles', id: incompatible.id, req: await req(), draft: true }),
        error => error instanceof Error && error.name === 'ValidationError' && error.message.includes('Media'))
      const latest = await payload.findByID({ collection: 'news-articles', id: document.id, draft: true, depth: 0 })
      assert.deepEqual(latest.body, [])
      assert.deepEqual(await readFile(path.join(process.env.CMS_UPLOAD_DIR!, media.filename!)), pdf)
      assert.equal(Object.keys(adapter.sessions).length, 0)
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

    await t.test('I2 shared X survives missing/corrupt sibling Y in either publication order; no grant stays 503 and SQL errors propagate', async () => {
      const x = await upload(), y = await upload()
      const xBlock = { blockType: 'pdf' as const, media: x.id, title: 'Healthy shared X' }
      const yBlock = { blockType: 'pdf' as const, media: y.id, title: 'Sibling Y' }
      const documents = [await article([xBlock]), await article([xBlock])].sort((a, b) => a.id < b.id ? -1 : 1)
      const viewer = { ...actor, canManageNews: false }
      const yPath = path.join(process.env.CMS_UPLOAD_DIR!, y.filename!)
      const readX = async () => openNewsMedia({ payload, id: x.id, actor: viewer, req: await req() })
      for (const damagedIndex of [0, 1]) {
        await writeFile(yPath, pdf)
        const damaged = documents[damagedIndex], healthy = documents[1 - damagedIndex]
        await payload.update({ collection: 'news-articles', id: damaged.id, req: await req(), data: { _status: 'published', body: [xBlock, yBlock] } })
        await payload.update({ collection: 'news-articles', id: healthy.id, req: await req(), data: { _status: 'published', body: [xBlock] } })
        for (const corruption of ['missing', 'corrupt']) {
          if (corruption === 'missing') await rm(yPath)
          else await writeFile(yPath, Buffer.alloc(pdf.length))
          const response = await readX()
          assert.equal(response.status, 200, `${corruption} sibling, damaged publication index ${damagedIndex}`)
          assert.deepEqual(Buffer.from(await new Response(response.body).arrayBuffer()), pdf)
          assert.equal((await openNewsMedia({ payload, id: y.id, actor: viewer, req: await req() })).status, 503)
          await payload.update({ collection: 'news-articles', id: healthy.id, req: await req(), data: { _status: 'draft' } })
          assert.equal((await readX()).status, 503, 'without any healthy grant, damaged publication remains 503')
          await payload.update({ collection: 'news-articles', id: healthy.id, req: await req(), data: { _status: 'published' } })
        }
      }
      // Put the damaged candidate first again, then induce an ACTUAL PostgreSQL
      // failure in that same live lookup transaction, not a transport/DB error double.
      await writeFile(yPath, pdf)
      await payload.update({ collection: 'news-articles', id: documents[0].id, req: await req(), data: { _status: 'published', body: [xBlock, yBlock] } })
      await payload.update({ collection: 'news-articles', id: documents[1].id, req: await req(), data: { _status: 'published', body: [xBlock] } })
      const findByID = payload.findByID
      let sqlFailures = 0
      payload.findByID = (async (options: Parameters<typeof findByID>[0]) => {
        if (options.collection === 'news-media' && options.id === y.id) {
          sqlFailures++
          const transaction = await requireCmsTransaction(payload, options.req as PayloadRequest)
          await transaction.execute(sql`SELECT 1 / 0`)
        }
        return findByID(options)
      }) as typeof findByID
      try {
        await assert.rejects(canReadPublishedMedia(payload, x.id, await req()), error =>
          (error as { cause?: { code?: string } }).cause?.code === '22012')
        assert.equal((await readX()).status, 503, 'a DB error must not be skipped in favor of the later healthy grant')
        assert.equal(sqlFailures, 2)
        assert.equal(Object.keys(adapter.sessions).length, 0)
      } finally { payload.findByID = findByID }
      const recovered = await readX(); assert.equal(recovered.status, 200); await recovered.body!.cancel()
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
    const leaked = Object.keys(adapter.sessions)
    try {
      for (const id of leaked) await payload.db.rollbackTransaction(id)
      const transactions = await adapter.drizzle.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'`)
      const locks = await adapter.drizzle.execute(sql`SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND objid = 7194030 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
      assert.equal(transactions.rows[0].count, 0, 'database retains an open transaction')
      assert.equal(locks.rows[0].count, 0, 'database retains the CMS reference lock')
      assert.equal(adapter.pool.waitingCount, 0)
      assert.equal(leaked.length, 0, 'native operations leaked a live transaction (cleaned up, but test still fails)')
      t.diagnostic(`Teardown: no sessions, DB transactions, reference locks or pool waiters; pool clients=${adapter.pool.totalCount}, idle=${adapter.pool.idleCount}`)
    } finally {
      await payload.destroy()
    }
    // Pinned db-postgres connectWithReconnect permanently checks out its listener
    // client; drizzle destroy only clears schema caches, and pool.end() hangs.
    // The isolated runner uses Node's --test-force-exit AFTER all tests/hooks.
    // It preserves failed test exit codes and checks DB connections have closed.
  }
})
