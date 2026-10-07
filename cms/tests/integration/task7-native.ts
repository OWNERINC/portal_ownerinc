import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFile, rename } from 'node:fs/promises'
import { BasePayload, createLocalReq, type RequiredDataFromCollectionSlug } from 'payload'
import { sql, type PostgresAdapter } from '@payloadcms/db-postgres'
import { queryPublishedNews, queryNewsDetail, queryNewsCategories, queryNewsNavigation, queryNewsPreview, queryNewsHome } from '../../src/news/queries.js'
import { legacyNewsImportContext } from '../../src/news/validation.js'
import { historyHashes } from '../../src/collections/LegacyNewsRevisions.js'
import { withCmsTransaction, lockCmsReferences } from '../../src/publication/transaction.js'
import { assertMediaOrphan } from '../../src/media/references.js'
import { setTimeout as delay } from 'node:timers/promises'
const database = new URL(process.env.CMS_DATABASE_URL || 'http://invalid'), directory = process.env.TASK7_PRIVATE_DIR || ''
if (process.env.TASK7_DISPOSABLE !== 'cms_task7_test' || database.hostname !== '127.0.0.1' || database.port !== '55441' || database.pathname !== '/cms_task7_test' || database.username !== 'cms_runtime' ||
  path.dirname(directory) !== path.join(process.env.LOCALAPPDATA || '', 'Temp', 'opencode') || !path.basename(directory).startsWith('ownerinc-task7-')) throw new Error('Refusing non-disposable Task7 environment')
test('Task7 real native PostgreSQL read bridge; only Portal actor/authority transport doubled', async t => {
  const actor = { uid: 'task7-synthetic-editor', email: 'task7@example.invalid', name: null, canManageNews: true }, reader = { ...actor, canManageNews: false }
  const savedFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(init?.redirect, 'error')
    if (String(url).endsWith('/authority')) return Response.json({ mode: 'payload', epoch: 1 })
    assert.equal(String(url), 'http://127.0.0.1:18087/api/internal/editorial/actor/check')
    return Response.json({ actor })
  }
  const payload = new BasePayload(), config = await (await import('../../src/payload.config.js')).default
  config.typescript.autoGenerate = false
  await payload.init({ config, disableOnInit: true })
  const adapter = payload.db as unknown as PostgresAdapter
  const projection = await payload.create({ collection: 'portal-editors', overrideAccess: true, data: { portalUid: actor.uid, email: actor.email } })
  const user = { ...projection, collection: 'portal-editors' as const, portalActor: actor, portalExpiresAt: new Date(Date.now() + 3600000).toISOString() }
  const req = () => createLocalReq({ user }, payload)
  const editorial = { version: 1 as const, kind: 'article' as const, summary: 'Summary A', author: '', source_label: '', source_date: null }
  const create = async (title: string, category = 'News', body: any[] = [{ blockType: 'paragraph', text: 'Body A' }]) => payload.create({ collection: 'news-articles', req: await req(), overrideAccess: false, data: { title, category, editorial, body, _status: 'published' } })
  const latest = async (id: string) => (await payload.findVersions({ collection: 'news-articles', req: await req(), overrideAccess: false, where: { parent: { equals: id } }, sort: '-updatedAt', depth: 0, limit: 1 })).docs[0]
  const pdf = Buffer.from('%PDF-1.7\nTask7 synthetic\nxref\n0 1\n0000000000 65535 f\n%%EOF\n')
  const media = await payload.create({ collection: 'news-media', req: await req(), overrideAccess: false, data: {} as RequiredDataFromCollectionSlug<'news-media'>, file: { name: 'task7.pdf', data: pdf, size: pdf.length, mimetype: 'application/pdf' } })
  const a = await create('Publication A'), b = await create('Second', ''), invalid = await create('Invalid body', 'Invalid')
  const edition = await payload.create({ collection: 'news-articles', req: await req(), overrideAccess: false, data: { title: 'PDF edition', category: 'Edition', editorial: { ...editorial, kind: 'edition' }, body: [{ blockType: 'pdf', media: media.id, title: 'PDF' }], _status: 'published' } })
  await payload.update({ collection: 'news-articles', id: a.id, req: await req(), overrideAccess: false, draft: true, data: { title: 'Draft B', body: [{ blockType: 'paragraph', text: 'Draft body B' }] } })
  const versionB = await latest(a.id)
  // Synthetic corruption bypasses native guards ONLY in this disposable DB.
  await adapter.drizzle.execute(sql`UPDATE news_articles SET editorial='{"version":99}'::jsonb WHERE id=${invalid.id}::uuid`)
  await adapter.drizzle.execute(sql`UPDATE news_articles SET published_at='2026-10-01T12:00:00Z', updated_at='2026-10-01T12:00:00Z' WHERE id IN (${a.id}::uuid,${b.id}::uuid,${edition.id}::uuid)`)
  const legacyDocumentId = randomUUID(), legacyRevisionId = randomUUID()
  const original = { legacyDocumentId, legacyRevisionId, originalVersion: 7, originalCreatedAt: '2020-03-01T12:34:56.000Z', originalActorUid: null,
    originalStatus: 'archived' as const, originalTitle: 'Legacy original', originalCategory: '', originalPublishedAt: null,
    originalBody: [{ type: 'pdf', asset_id: media.id, title: 'Original PDF' }], originalEditorial: null }
  let historyId = ''
  try {
    await t.test('published A vs saved B, strict visible set/order/count/empty category/edition/global', async () => {
      assert.equal((await queryNewsDetail(await req(), { id: a.id }, actor)).title, 'Publication A')
      assert.equal((await queryNewsPreview(await req(), { id: a.id, versionId: versionB.id, source: 'payload' }, actor)).title, 'Draft B')
      await assert.rejects(queryNewsPreview(await req(), { id: b.id, versionId: versionB.id, source: 'payload' }, actor), e => (e as any).status === 404)
      const page = await queryPublishedNews(await req(), { limit: 100, offset: 0 }, reader)
      assert.equal(page.count, 3); assert.deepEqual(page.rows.map(row => row.id), [a.id, b.id, edition.id].sort())
      assert.equal((await queryPublishedNews(await req(), { limit: 1, offset: 0, category: '' }, reader)).rows[0].id, b.id)
      assert.deepEqual(await queryNewsCategories(await req(), { withCounts: true }, reader), { total: 3, categories: [{ name: 'Edition', count: 1 }, { name: 'News', count: 1 }] })
      assert.deepEqual(await queryNewsNavigation(await req(), { id: edition.id }, reader), { previous: null, next: null })
      await assert.rejects(queryNewsNavigation(await req(), { id: invalid.id }, reader), e => (e as any).status === 404)
      await payload.updateGlobal({ slug: 'news-home', req: await req(), overrideAccess: false, data: { eyebrow: 'Owner', headline: 'Home A', summary: 'Summary A', _status: 'published' } })
      await payload.updateGlobal({ slug: 'news-home', req: await req(), overrideAccess: false, draft: true, data: { headline: 'Home B' } })
      assert.equal((await queryNewsHome(await req(), {}, reader)).content?.headline, 'Home A')
    })
    await t.test('real persisted legacy compound identity/provenance, browser writes denied, raw+relation retention', async () => {
      const data = { ...original, ...historyHashes(original), mediaReferences: [media.id] }
      const createHistory = () => withCmsTransaction(payload, undefined, req => payload.create({ collection: 'legacy-news-revisions', req, overrideAccess: true, context: legacyNewsImportContext, data }))
      const row = await createHistory(); historyId = row.id
      assert.equal(row.originalVersion, 7); assert.equal(row.originalCreatedAt, original.originalCreatedAt); assert.equal(row.originalActorUid, null)
      await assert.rejects(createHistory(), /unique|already|valid/i)
      await assert.rejects(payload.create({ collection: 'legacy-news-revisions', req: await req(), overrideAccess: false, data }))
      const preview = await queryNewsPreview(await req(), { id: legacyDocumentId, versionId: legacyRevisionId, source: 'legacy' }, actor)
      assert.equal(preview.id, legacyDocumentId); assert.equal(preview.editorial, null); assert.equal(preview.read_time_minutes, null)
      await assert.rejects(queryNewsPreview(await req(), { id: a.id, versionId: legacyRevisionId, source: 'legacy' }, actor), e => (e as any).status === 404)
      await assert.rejects(queryNewsPreview(await req(), { id: legacyDocumentId, versionId: legacyRevisionId, source: 'payload' }, actor), e => (e as any).status === 404)
      // History-only asset ensures neither native current nor Versions protects it.
      const orphan = await payload.create({ collection: 'news-media', req: await req(), overrideAccess: false, data: {} as RequiredDataFromCollectionSlug<'news-media'>, file: { name: 'history.pdf', data: pdf, size: pdf.length, mimetype: 'application/pdf' } })
      const history = { ...original, legacyRevisionId: randomUUID(), originalBody: [{ type: 'pdf', asset_id: orphan.id, title: 'Only history' }] }
      const retained = await withCmsTransaction(payload, undefined, req => payload.create({ collection: 'legacy-news-revisions', req, overrideAccess: true, context: legacyNewsImportContext, data: { ...history, ...historyHashes(history), mediaReferences: [orphan.id] } }))
      await assert.rejects(withCmsTransaction(payload, undefined, req => assertMediaOrphan(payload, orphan.id, req)), /media_is_referenced/)
      await adapter.drizzle.execute(sql`DELETE FROM legacy_news_revisions_rels WHERE parent_id=${retained.id}::uuid`)
      await assert.rejects(withCmsTransaction(payload, undefined, req => assertMediaOrphan(payload, orphan.id, req)), /media_is_referenced/)
      await adapter.drizzle.execute(sql`INSERT INTO legacy_news_revisions_rels(parent_id,path,news_media_id) VALUES(${retained.id}::uuid,'mediaReferences',${orphan.id}::uuid)`)
      await adapter.drizzle.execute(sql`UPDATE legacy_news_revisions SET original_body='[]'::jsonb WHERE id=${retained.id}::uuid`)
      await assert.rejects(withCmsTransaction(payload, undefined, req => assertMediaOrphan(payload, orphan.id, req)), /media_is_referenced/)
    })
    await t.test('missing actual file is 503, not an empty list or false categories/count', async () => {
      const filename = path.join(process.env.CMS_UPLOAD_DIR!, media.filename!)
      await rename(filename, `${filename}.held`)
      try {
        await assert.rejects(queryPublishedNews(await req(), { limit: 10, offset: 0 }, reader), e => (e as any).status === 503)
        await assert.rejects(queryNewsCategories(await req(), { withCounts: true }, reader), e => (e as any).status === 503)
      } finally { await rename(`${filename}.held`, filename) }
    })
    await t.test('published query waits on the actual reference lock and sees the committed withdrawal', async () => {
      const temporary = await create('Withdraw under lock'), holder = await req(), tx = await payload.db.beginTransaction()
      assert.ok(tx); holder.transactionID = tx; await lockCmsReferences(payload, holder)
      let pending: Promise<unknown> | undefined
      try {
        pending = queryNewsDetail(await req(), { id: temporary.id }, reader)
        const rejection = assert.rejects(pending, e => (e as any).status === 404)
        let waiting = false
        for (let i = 0; i < 100; i++) { const locks = await adapter.drizzle.execute(sql`SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND objid=7194030 AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`); if (Number(locks.rows[0].count)) { waiting = true; break }; await delay(10) }
        assert.equal(waiting, true)
        await payload.update({ collection: 'news-articles', id: temporary.id, req: holder, overrideAccess: false, data: { _status: 'draft' } })
        await payload.db.commitTransaction(tx); delete holder.transactionID; await rejection
      } finally { if (holder.transactionID) await payload.db.rollbackTransaction(tx); await pending?.catch(() => {}) }
    })
    const largePDF = Buffer.alloc(8 * 1024 * 1024, 32), footer = Buffer.from('\nxref\n0 1\n0000000000 65535 f\n%%EOF\n')
    pdf.copy(largePDF); footer.copy(largePDF, largePDF.length - footer.length)
    const large = await payload.create({ collection: 'news-media', req: await req(), overrideAccess: false, data: {} as RequiredDataFromCollectionSlug<'news-media'>,
      file: { name: 'stream.pdf', data: largePDF, size: largePDF.length, mimetype: 'application/pdf' } })
    await writeFile(path.join(directory, 'fixture.json'), JSON.stringify({ actor, articleId: a.id, secondId: b.id, editionId: edition.id, invalidId: invalid.id, versionB: versionB.id,
      legacyDocumentId, legacyRevisionId, historyId, mediaId: media.id, filename: media.filename, mediaSize: pdf.length, largeMediaId: large.id, largeMediaSize: largePDF.length }), { mode: 0o600 })
  } finally { globalThis.fetch = savedFetch; await payload.destroy() }
})
