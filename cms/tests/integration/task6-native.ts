import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { BasePayload, createLocalReq, restoreVersionOperation, restoreVersionOperationGlobal, type PayloadRequest, type RequiredDataFromCollectionSlug } from 'payload'
import { sql, type PostgresAdapter } from '@payloadcms/db-postgres'
import { scheduleRevision, runScheduledRevision, cancelSchedule } from '../../src/publication/schedule.js'
import { snapshotDocument, snapshotHash } from '../../src/publication/document.js'
import { lockCmsReferences, requireCmsTransaction } from '../../src/publication/transaction.js'
import { assertMediaOrphan } from '../../src/media/references.js'
import { publicationMutation } from '../../src/publication/internal.js'
import { legacyNewsImportContext } from '../../src/news/validation.js'

const database = new URL(process.env.CMS_DATABASE_URL || 'http://invalid')
const privateDir = process.env.TASK6_PRIVATE_DIR || ''
if (process.env.TASK6_DISPOSABLE !== 'cms_task6_test' || database.hostname !== '127.0.0.1' || database.port !== '55441' ||
  database.pathname !== '/cms_task6_test' || database.username !== 'cms_runtime' || !path.basename(privateDir).startsWith('ownerinc-task6-') ||
  path.dirname(privateDir) !== path.join(process.env.LOCALAPPDATA || '', 'Temp', 'opencode') || process.env.CMS_UPLOAD_DIR !== path.join(privateDir, 'uploads')) {
  throw new Error('Refusing non-disposable Task6 environment')
}
test('Task6 real PostgreSQL/native Versions/Jobs; Portal transport explicitly doubled', async t => {
  let mode = 'payload', revoked = false, authorityCalls = 0, actorCalls = 0
  const originalFetch = globalThis.fetch
  const actor = { uid: `task6-${randomUUID()}`, email: 'task6@example.invalid', name: 'Synthetic Editor', canManageNews: true }
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.redirect, 'error')
    if (String(input).endsWith('/authority')) { authorityCalls++; return Response.json({ mode, epoch: 1 }) }
    actorCalls++
    assert.equal(String(input), 'http://127.0.0.1:18086/api/internal/editorial/actor/check')
    assert.equal(JSON.parse(String(init?.body)).uid, actor.uid)
    return Response.json(revoked ? { reason: 'editorial_permission_denied' } : { actor }, { status: revoked ? 403 : 200 })
  }
  const payload = new BasePayload()
  const config = await (await import('../../src/payload.config.js')).default
  config.typescript.autoGenerate = false
  await payload.init({ config, disableOnInit: true })
  const adapter = payload.db as unknown as PostgresAdapter
  const projection = await payload.create({ collection: 'portal-editors', data: { portalUid: actor.uid, email: actor.email, displayName: actor.name } })
  const user = { ...projection, collection: 'portal-editors' as const, portalActor: actor }
  await writeFile(path.join(privateDir, 'browser-fixture.json'), JSON.stringify({ actor }))
  const req = () => createLocalReq({ user }, payload)
  const worker = () => createLocalReq({}, payload)
  const editorial = { version: 1 as const, kind: 'article' as const, summary: 'Full summary', author: '', source_label: '', source_date: null }
  const article = (title = 'Revision A') => req().then(req => payload.create({ collection: 'news-articles', req, draft: true, overrideAccess: false,
    data: { title, category: 'Category A', editorial, body: [{ blockType: 'paragraph', text: 'Body A' }] } }))
  const saved = async (id: string) => (await payload.findVersions({ collection: 'news-articles', depth: 0, where: { parent: { equals: id } }, sort: '-updatedAt', limit: 1 })).docs[0]
  const schedule = async (id: string, milliseconds = 150) => {
    const version = await saved(id)
    const doc = await payload.findByID({ collection: 'news-articles', id, draft: false })
    return scheduleRevision(await req(), { target: 'news-articles', documentId: id, versionId: version.id,
      snapshotHash: snapshotHash(snapshotDocument('news-articles', version.version)), action: 'publish', expectedGeneration: doc.publicationGeneration || 0,
      scheduledAt: new Date(Date.now() + milliseconds).toISOString() })
  }
  const begin = async () => {
    const request = await req(), id = await payload.db.beginTransaction()
    assert.ok(id); request.transactionID = id
    await lockCmsReferences(payload, request)
    return request
  }
  const commit = async (request: PayloadRequest) => {
    await payload.db.commitTransaction((await request.transactionID)!); delete request.transactionID
  }
  const rollback = async (request: PayloadRequest) => {
    if (request.transactionID) await payload.db.rollbackTransaction((await request.transactionID)!)
    delete request.transactionID
  }
  async function waitForBlockedLock() {
    for (let i = 0; i < 100; i++) {
      const locks = await adapter.drizzle.execute(sql`SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND objid = 7194030 AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
      if (Number(locks.rows[0].count) > 0) return
      await delay(10)
    }
    assert.fail('worker/native operation never waited on PostgreSQL advisory lock 7194030')
  }
  const audits = async (id: string) => (await payload.find({ collection: 'news-audit', limit: 100, where: { documentId: { equals: id } }, sort: 'createdAt' })).docs
  const live = (id: string) => payload.findByID({ collection: 'news-articles', id, draft: false, depth: 0 })
  const draft = (id: string) => payload.findByID({ collection: 'news-articles', id, draft: true, depth: 0 })
  const scheduleDoc = (id: string) => payload.findByID({ collection: 'news-schedules', id, depth: 0 })
  try {
    await t.test('restricted role and exact immutable snapshot A publishes while native draft B survives', async () => {
      assert.deepEqual((await adapter.drizzle.execute(sql`SELECT current_database() AS db, current_user AS role`)).rows[0], { db: 'cms_task6_test', role: 'cms_runtime' })
      const a = await article(), source = await saved(a.id), pending = await schedule(a.id)
      await payload.update({ collection: 'news-articles', id: a.id, req: await req(), draft: true,
        data: { title: 'Revision B', category: 'Category B', editorial: { ...editorial, summary: 'Summary B' }, body: [{ blockType: 'paragraph', text: 'Body B' }] } })
      const later = await saved(a.id)
      await delay(170)
      await payload.jobs.run({ queue: 'owner-news' })
      const live = await payload.findByID({ collection: 'news-articles', id: a.id, draft: false, depth: 0 })
      const draft = await payload.findByID({ collection: 'news-articles', id: a.id, draft: true, depth: 0 })
      const stored = await payload.findByID({ collection: 'news-schedules', id: pending.id })
      assert.equal(stored.state, 'published')
      const job = await payload.findByID({ collection: 'payload-jobs', id: stored.jobId! })
      assert.ok(job.completedAt)
      assert.equal(job.concurrencyKey, `news-schedule:${pending.id}`)
      assert.deepEqual(job.input, { scheduleId: pending.id })
      assert.equal(stored.versionId, source.id)
      assert.equal(stored.snapshotHash, snapshotHash(snapshotDocument('news-articles', source.version)))
      assert.deepEqual(snapshotDocument('news-articles', live), snapshotDocument('news-articles', source.version))
      assert.deepEqual(snapshotDocument('news-articles', draft), snapshotDocument('news-articles', later.version))
      assert.equal(live._status, 'published'); assert.equal(draft._status, 'draft')
      assert.ok(live.publishedAt)
      assert.deepEqual(await runScheduledRevision(await worker(), { scheduleId: pending.id }), { state: 'already_processed' })
      t.diagnostic(`A=${source.id}; B=${later.id}; schedule=${pending.id}; hash=${stored.snapshotHash}; published A / draft B verified`)
    })
    await t.test('native Jobs unique concurrency key, two runners, and two delivered workers produce exactly one publication', async () => {
      const a = await article('Two workers'), pending = await schedule(a.id), stored = await scheduleDoc(pending.id)
      await assert.rejects(payload.jobs.queue({ task: 'publish-news-snapshot', queue: 'owner-news', input: { scheduleId: pending.id } }))
      assert.equal((await payload.find({ collection: 'payload-jobs', where: { concurrencyKey: { equals: `news-schedule:${pending.id}` } } })).totalDocs, 1)
      await delay(170)
      // Two independent OS processes/pools execute the unmodified native CLI.
      // Only this one job is due/unprocessed at this point in the suite.
      const workers = await Promise.all([1, 2].map(async number => {
        const output = await promisify(execFile)(process.execPath, ['--import', './tests/integration/task6-portal-double.mjs',
          'node_modules/payload/bin.js', 'jobs:run', '--queue', 'owner-news', '--limit', '1'], {
          cwd: process.cwd(), env: { ...process.env, PAYLOAD_CONFIG_PATH: path.resolve('tests/integration/task6-worker.config.ts') }, timeout: 60000,
        })
        await writeFile(path.join(privateDir, `worker-cli-${number}.log`), output.stdout + output.stderr)
        return number
      }))
      assert.deepEqual(workers, [1, 2])
      assert.equal((await scheduleDoc(pending.id)).state, 'published')
      assert.equal((await audits(a.id)).filter(row => row.action === 'published').length, 1)
      const b = await article('Duplicate deliveries'), second = await schedule(b.id)
      await delay(170)
      const results = await Promise.all([runScheduledRevision(await worker(), { scheduleId: second.id }), runScheduledRevision(await worker(), { scheduleId: second.id })])
      assert.deepEqual(results.map(row => row.state).sort(), ['already_processed', 'published'])
      assert.equal((await audits(b.id)).filter(row => row.action === 'published').length, 1)
      t.diagnostic(`two OS-process native CLI workers exited 0; job ${stored.jobId}: unique queue row; duplicate delivered workers ${second.id}: published + already_processed`)
    })
    await t.test('cancel wins a dequeued-worker race; isolated cancellation preserves draft B and expected generation conflicts', async () => {
      const a = await article(), pending = await schedule(a.id)
      await payload.update({ collection: 'news-articles', id: a.id, req: await req(), draft: true, data: { title: 'B after schedule' } })
      const before = await draft(a.id), holder = await begin()
      let execution: Promise<unknown> | undefined
      try {
        await cancelSchedule(holder, { id: pending.id, expectedGeneration: pending.generation })
        execution = runScheduledRevision(await worker(), { scheduleId: pending.id }); execution.catch(() => {})
        await waitForBlockedLock(); await commit(holder)
        assert.deepEqual(await execution, { state: 'already_processed' })
      } finally { await rollback(holder); await execution?.catch(() => {}) }
      assert.equal((await scheduleDoc(pending.id)).state, 'cancelled')
      assert.deepEqual(snapshotDocument('news-articles', await draft(a.id)), snapshotDocument('news-articles', before))
      assert.equal((await live(a.id)).publicationGeneration, pending.generation + 1)
      await assert.rejects(cancelSchedule(await req(), { id: pending.id, expectedGeneration: pending.generation }), /news_schedule_conflict/)
      assert.equal((await audits(a.id)).filter(row => row.action === 'published').length, 0)
    })
    await t.test('worker wins cancellation race; losing cancellation is 409 without changing published state', async () => {
      const a = await article(), pending = await schedule(a.id)
      await delay(170)
      const holder = await begin()
      let cancellation: Promise<unknown> | undefined
      try {
        assert.deepEqual(await runScheduledRevision(holder, { scheduleId: pending.id }), { state: 'published' })
        cancellation = cancelSchedule(await req(), { id: pending.id, expectedGeneration: pending.generation })
        const denied = assert.rejects(cancellation, /news_schedule_conflict/)
        await waitForBlockedLock(); await commit(holder); await denied
      } finally { await rollback(holder); await cancellation?.catch(() => {}) }
      assert.equal((await live(a.id))._status, 'published')
      assert.equal((await scheduleDoc(pending.id)).state, 'published')
    })
    await t.test('native manual publish retains first publishedAt; withdrawal invalidates an already dequeued worker', async () => {
      const a = await article()
      const first = await payload.update({ collection: 'news-articles', id: a.id, req: await req(), overrideAccess: false, data: { _status: 'published', publishedAt: '2000-01-01T00:00:00.000Z', publicationGeneration: 999 } })
      assert.ok(first.publishedAt); assert.notEqual(first.publishedAt, '2000-01-01T00:00:00.000Z'); assert.equal(first.publicationGeneration, 0)
      const next = await payload.update({ collection: 'news-articles', id: a.id, req: await req(), data: { title: 'Updated publication', _status: 'published' } })
      assert.equal(next.publishedAt, first.publishedAt)
      const pending = await schedule(a.id), holder = await begin()
      let execution: Promise<unknown> | undefined
      try {
        execution = runScheduledRevision(await worker(), { scheduleId: pending.id }); execution.catch(() => {})
        await waitForBlockedLock()
        await payload.update({ collection: 'news-articles', id: a.id, req: holder, select: { title: true }, data: { _status: 'draft' } })
        await commit(holder); assert.deepEqual(await execution, { state: 'already_processed' })
      } finally { await rollback(holder); await execution?.catch(() => {}) }
      assert.equal((await live(a.id))._status, 'draft')
      assert.equal((await live(a.id)).publicationGeneration, pending.generation + 1)
      assert.equal((await scheduleDoc(pending.id)).state, 'cancelled')
      assert.equal((await audits(a.id)).at(-1)?.action, 'unpublished')
      assert.equal(((await audits(a.id)).at(-1)?.details as { generation: number }).generation, pending.generation + 1, 'caller selection cannot erase audit generation')
    })
    await t.test('authority and real requester are rechecked AFTER a PostgreSQL lock wait', async () => {
      const a = await article(), pending = await schedule(a.id)
      await delay(170)
      const holder = await begin(), beforeAuthority = authorityCalls, beforeActor = actorCalls
      const execution = runScheduledRevision(await worker(), { scheduleId: pending.id }); execution.catch(() => {})
      try {
        await waitForBlockedLock(); assert.equal(authorityCalls, beforeAuthority); assert.equal(actorCalls, beforeActor)
        revoked = true; await commit(holder)
        assert.deepEqual(await execution, { state: 'rejected' })
      } finally { revoked = false; await rollback(holder); await execution.catch(() => {}) }
      const rejection = (await audits(a.id)).at(-1)!
      assert.equal(rejection.action, 'schedule_rejected'); assert.equal(rejection.actorUid, 'system'); assert.equal(rejection.requestedByUid, actor.uid)
      assert.equal((rejection.details as { reason: string }).reason, 'actor_revoked')
      assert.equal((await live(a.id))._status, 'draft')
      mode = 'payload_frozen'
      try {
        await assert.rejects(payload.update({ collection: 'news-articles', id: a.id, req: await req(), draft: true, data: { title: 'denied' } }), /cms_authority_read_only/)
        await assert.rejects(payload.updateGlobal({ slug: 'news-home', req: await req(), draft: true, data: { headline: 'denied' } }), /cms_authority_read_only/)
        await assert.rejects(runScheduledRevision(await worker(), { scheduleId: pending.id }), /cms_authority_read_only/)
      } finally { mode = 'payload' }
    })
    await t.test('worker wins first, then waiting native withdrawal commits last and no retry republishes', async () => {
      const a = await article(), pending = await schedule(a.id)
      await delay(170)
      const holder = await begin()
      let withdrawal: Promise<unknown> | undefined
      try {
        await runScheduledRevision(holder, { scheduleId: pending.id })
        withdrawal = payload.update({ collection: 'news-articles', id: a.id, req: await req(), data: { _status: 'draft' } })
        withdrawal.catch(() => {})
        await waitForBlockedLock(); await commit(holder); await withdrawal
      } finally { await rollback(holder); await withdrawal?.catch(() => {}) }
      assert.equal((await live(a.id))._status, 'draft')
      assert.equal((await live(a.id)).publicationGeneration, pending.generation + 1)
      assert.deepEqual((await audits(a.id)).map(row => row.action), ['draft_saved', 'scheduled', 'published', 'unpublished'])
      assert.deepEqual(await runScheduledRevision(await worker(), { scheduleId: pending.id }), { state: 'already_processed' })
      assert.equal((await live(a.id))._status, 'draft')
    })
    await t.test('native article and GLOBAL restore validate effective content and never restore stale publication metadata', async () => {
      const a = await article('Historical article'), source = await saved(a.id)
      const published = await payload.update({ collection: 'news-articles', id: a.id, req: await req(), data: { _status: 'published' } })
      // The pinned Local restore wrapper ignores `draft`; these are the public native
      // operations used by REST/Server Actions, where draft is actually forwarded.
      const restored = await restoreVersionOperation({ collection: payload.collections['news-articles'], id: source.id, req: await req(), draft: true, overrideAccess: false })
      assert.equal(restored.title, 'Historical article'); assert.equal(restored._status, 'draft')
      assert.equal((await live(a.id))._status, 'published'); assert.equal(restored.publishedAt, published.publishedAt)
      await payload.updateGlobal({ slug: 'news-home', req: await req(), draft: true, data: { eyebrow: 'Owner', headline: 'Home A', summary: 'Home summary A' } })
      const homeSource = (await payload.findGlobalVersions({ slug: 'news-home', limit: 1, sort: '-updatedAt' })).docs[0]
      const homePublished = await payload.updateGlobal({ slug: 'news-home', req: await req(), data: { _status: 'published', headline: 'Home live' } })
      const homeRestored = await restoreVersionOperationGlobal({ globalConfig: payload.globals.config.find(g => g.slug === 'news-home')!, id: homeSource.id, req: await req(), draft: true, overrideAccess: false })
      assert.equal(homeRestored.headline, 'Home A')
      assert.equal((await payload.findGlobal({ slug: 'news-home', draft: false })).headline, 'Home live')
      assert.equal((await payload.findGlobal({ slug: 'news-home', draft: true })).headline, 'Home A')
      assert.equal(homeRestored.publishedAt, homePublished.publishedAt)
      const liveHome = await payload.restoreGlobalVersion({ slug: 'news-home', id: homeSource.id, req: await req(), overrideAccess: false })
      assert.equal(liveHome._status, 'draft')
      assert.equal(liveHome.publicationGeneration, 1)
      assert.equal(liveHome.publishedAt, homePublished.publishedAt)
      assert.equal((await audits('news-home')).at(-1)?.action, 'unpublished')
      t.diagnostic(`global source ${homeSource.id}: restore-as-draft kept live Home live + draft Home A; native restore withdrawal generation=1`)
    })
    await t.test('real global Versions: scheduled home A publishes, later home B survives; scheduled withdrawal preserves B', async () => {
      await payload.updateGlobal({ slug: 'news-home', req: await req(), draft: true, data: { eyebrow: 'Owner', headline: 'Scheduled home A', summary: 'Summary A' } })
      const source = (await payload.findGlobalVersions({ slug: 'news-home', limit: 1, sort: '-updatedAt' })).docs[0]
      const current = await payload.findGlobal({ slug: 'news-home', draft: false })
      const pending = await scheduleRevision(await req(), { target: 'news-home', documentId: 'news-home', versionId: source.id,
        snapshotHash: snapshotHash(snapshotDocument('news-home', source.version)), action: 'publish', expectedGeneration: current.publicationGeneration || 0,
        scheduledAt: new Date(Date.now() + 150).toISOString() })
      await payload.updateGlobal({ slug: 'news-home', req: await req(), draft: true, data: { headline: 'Later home B' } })
      await delay(170); assert.deepEqual(await runScheduledRevision(await worker(), { scheduleId: pending.id }), { state: 'published' })
      assert.equal((await payload.findGlobal({ slug: 'news-home', draft: false })).headline, 'Scheduled home A')
      assert.equal((await payload.findGlobal({ slug: 'news-home', draft: true })).headline, 'Later home B')
      const withdraw = await scheduleRevision(await req(), { target: 'news-home', documentId: 'news-home', versionId: source.id,
        snapshotHash: snapshotHash(snapshotDocument('news-home', source.version)), action: 'unpublish', expectedGeneration: pending.generation,
        scheduledAt: new Date(Date.now() + 150).toISOString() })
      await delay(170); assert.deepEqual(await runScheduledRevision(await worker(), { scheduleId: withdraw.id }), { state: 'unpublished' })
      assert.equal((await payload.findGlobal({ slug: 'news-home', draft: false }))._status, 'draft')
      assert.equal((await payload.findGlobal({ slug: 'news-home', draft: true })).headline, 'Later home B')
      assert.equal((await scheduleDoc(withdraw.id)).state, 'unpublished')
    })
    await t.test('invalid real stored asset rejects snapshot and preserves previous publication; history/snapshot still prevents deletion', async () => {
      const a = await article('Prior healthy publication')
      await payload.update({ collection: 'news-articles', id: a.id, req: await req(), data: { _status: 'published' } })
      const before = await live(a.id)
      const bytes = Buffer.from('%PDF-1.7\nTask6 synthetic\nxref\n0 1\n0000000000 65535 f\n%%EOF\n')
      const media = await payload.create({ collection: 'news-media', req: await req(), data: {} as RequiredDataFromCollectionSlug<'news-media'>,
        file: { data: bytes, name: 'synthetic.pdf', mimetype: 'application/pdf', size: bytes.length } })
      await payload.update({ collection: 'news-articles', id: a.id, req: await req(), draft: true,
        data: { title: 'Bad asset snapshot', body: [{ blockType: 'paragraph', text: 'Body with PDF' }, { blockType: 'pdf', media: media.id, title: 'PDF' }] } })
      const pending = await schedule(a.id), filename = path.join(process.env.CMS_UPLOAD_DIR!, media.filename!)
      const original = await readFile(filename); await rm(filename)
      try { await delay(170); assert.deepEqual(await runScheduledRevision(await worker(), { scheduleId: pending.id }), { state: 'rejected' }) }
      finally { await writeFile(filename, original) }
      const preserved = await live(a.id)
      assert.deepEqual(snapshotDocument('news-articles', preserved), snapshotDocument('news-articles', before))
      assert.equal(preserved.publishedAt, before.publishedAt); assert.equal(preserved._status, 'published')
      assert.equal(preserved.publicationGeneration, pending.generation)
      await assert.rejects(payload.delete({ collection: 'news-media', id: media.id, req: await req() }), /media_is_referenced/)
    })
    await t.test('PostgreSQL audit INSERT fault rolls back content, native Versions, schedule state and generation', async () => {
      const a = await article(), pending = await schedule(a.id)
      await delay(170)
      const beforeLive = await live(a.id), beforeDraft = await draft(a.id), beforeAudit = await audits(a.id)
      const beforeVersions = await payload.findVersions({ collection: 'news-articles', where: { parent: { equals: a.id } }, limit: 100 })
      const holder = await begin()
      try {
        await (await requireCmsTransaction(payload, holder)).execute(sql`SELECT set_config('owner_news.test_audit_fail', 'on', true)`)
        await assert.rejects(runScheduledRevision(holder, { scheduleId: pending.id }))
      } finally { await rollback(holder) }
      assert.deepEqual(await live(a.id), beforeLive); assert.deepEqual(await draft(a.id), beforeDraft)
      assert.deepEqual(await audits(a.id), beforeAudit)
      assert.equal((await scheduleDoc(pending.id)).state, 'pending')
      assert.deepEqual((await payload.findVersions({ collection: 'news-articles', where: { parent: { equals: a.id } }, limit: 100 })).docs, beforeVersions.docs)
      assert.deepEqual(await runScheduledRevision(await worker(), { scheduleId: pending.id }), { state: 'published' })
    })
    await t.test('unsaved/wrong/mutated saved revisions cannot schedule; replacement uses expected generation and leaves the old snapshot immutable', async () => {
      const a = await article(), b = await article(), source = await saved(a.id), other = await saved(b.id)
      const input = { target: 'news-articles' as const, documentId: a.id, versionId: source.id,
        snapshotHash: snapshotHash(snapshotDocument('news-articles', source.version)), action: 'publish' as const, expectedGeneration: 0,
        scheduledAt: new Date(Date.now() + 60000).toISOString() }
      await assert.rejects(scheduleRevision(await req(), { ...input, versionId: randomUUID() }))
      await assert.rejects(scheduleRevision(await req(), { ...input, versionId: other.id }), /version_mismatch/)
      await assert.rejects(scheduleRevision(await req(), { ...input, snapshotHash: '0'.repeat(64) }), /news_schedule_conflict/)
      const first = await scheduleRevision(await req(), input), original = await scheduleDoc(first.id)
      await assert.rejects(scheduleRevision(await req(), input), /news_schedule_conflict/)
      await payload.update({ collection: 'news-articles', id: a.id, req: await req(), draft: true, data: { title: 'Replace snapshot' } })
      const second = await schedule(a.id, 60000)
      assert.equal(second.generation, first.generation + 1)
      assert.equal((await scheduleDoc(first.id)).state, 'cancelled')
      assert.deepEqual((await scheduleDoc(first.id)).snapshot, original.snapshot)
      assert.equal((await scheduleDoc(first.id)).snapshotHash, original.snapshotHash)
      const holder = await begin()
      try {
        await assert.rejects(publicationMutation(holder, () => payload.update({ collection: 'news-schedules', id: first.id, req: holder,
          data: { snapshot: { title: 'tampered' } }, overrideAccess: true })), /news_snapshot_immutable/)
      } finally { await rollback(holder) }
      const audit = (await audits(a.id))[0]
      await assert.rejects(payload.update({ collection: 'news-audit', id: audit.id, req: await req(), overrideAccess: true, data: { actorUid: 'tampered' } }), /news_audit_append_only/)
      await assert.rejects(payload.delete({ collection: 'news-audit', id: audit.id, req: await req(), overrideAccess: true }), /news_audit_append_only/)
      assert.equal((await payload.findByID({ collection: 'news-audit', id: audit.id })).actorUid, actor.uid)
    })
    await t.test('audit database faults also atomically roll back scheduling/queue creation, draft saves and global native restoration', async () => {
      const a = await article(), source = await saved(a.id)
      const original = await live(a.id), originalDraft = await draft(a.id), originalAudit = await audits(a.id)
      const jobsBefore = (await payload.find({ collection: 'payload-jobs', limit: 1000 })).docs.map(job => job.id).sort()
      for (const operation of ['schedule', 'draft'] as const) {
        const holder = await begin()
        try {
          await (await requireCmsTransaction(payload, holder)).execute(sql`SELECT set_config('owner_news.test_audit_fail', 'on', true)`)
          await assert.rejects(operation === 'schedule' ? scheduleRevision(holder, { target: 'news-articles', documentId: a.id,
            versionId: source.id, snapshotHash: snapshotHash(snapshotDocument('news-articles', source.version)), action: 'publish',
            expectedGeneration: 0, scheduledAt: new Date(Date.now() + 60000).toISOString() }) :
            payload.update({ collection: 'news-articles', id: a.id, req: holder, draft: true, data: { title: 'must rollback' } }))
        } finally { await rollback(holder) }
        assert.deepEqual(await live(a.id), original); assert.deepEqual(await draft(a.id), originalDraft)
        assert.deepEqual(await audits(a.id), originalAudit)
        assert.equal((await payload.find({ collection: 'news-schedules', where: { documentId: { equals: a.id } } })).totalDocs, 0)
        assert.deepEqual((await payload.find({ collection: 'payload-jobs', limit: 1000 })).docs.map(job => job.id).sort(), jobsBefore)
      }
      const homeBefore = await payload.findGlobal({ slug: 'news-home', draft: false })
      const homeDraftBefore = await payload.findGlobal({ slug: 'news-home', draft: true })
      const versions = await payload.findGlobalVersions({ slug: 'news-home', limit: 100, sort: '-updatedAt' })
      const homeAudit = await audits('news-home'), holder = await begin()
      try {
        await (await requireCmsTransaction(payload, holder)).execute(sql`SELECT set_config('owner_news.test_audit_fail', 'on', true)`)
        await assert.rejects(payload.restoreGlobalVersion({ slug: 'news-home', id: versions.docs.at(-1)!.id, req: holder }))
      } finally { await rollback(holder) }
      assert.deepEqual(await payload.findGlobal({ slug: 'news-home', draft: false }), homeBefore)
      assert.deepEqual(await payload.findGlobal({ slug: 'news-home', draft: true }), homeDraftBefore)
      assert.deepEqual((await payload.findGlobalVersions({ slug: 'news-home', limit: 100, sort: '-updatedAt' })).docs, versions.docs)
      assert.deepEqual(await audits('news-home'), homeAudit)
    })
    await t.test('snapshot-only media reference protection and explicit store coverage remain fail-closed', async () => {
      const bytes = Buffer.from('%PDF-1.7\nTask6 snapshot-only fixture\nxref\n0 1\n0000000000 65535 f\n%%EOF\n')
      const media = await payload.create({ collection: 'news-media', req: await req(), data: {} as RequiredDataFromCollectionSlug<'news-media'>,
        file: { data: bytes, name: 'fixture.pdf', mimetype: 'application/pdf', size: bytes.length } })
      const a = await article()
      await payload.update({ collection: 'news-articles', id: a.id, req: await req(), draft: true,
        data: { body: [{ blockType: 'paragraph', text: 'Snapshot reference' }, { blockType: 'pdf', media: media.id, title: 'Fixture' }] } })
      const pending = await schedule(a.id, 60000), holder = await begin()
      try {
        // TEST-ONLY loss of the source history proves the independent snapshot scan;
        // rollback retains all history afterward. Production native delete is forbidden.
        await payload.db.deleteVersions({ collection: 'news-articles', req: holder, where: { parent: { equals: a.id } } })
        await assert.rejects(assertMediaOrphan(payload, media.id, holder), /media_is_referenced/)
        assert.equal((await payload.findByID({ collection: 'news-schedules', id: pending.id, req: holder })).snapshotHash, (await scheduleDoc(pending.id)).snapshotHash)
        const fields = payload.collections['news-audit'].config.fields
        fields.push({ name: 'uncoveredMedia', type: 'text' })
        try { await assert.rejects(assertMediaOrphan(payload, randomUUID(), holder), /media_reference_store_not_covered/) }
        finally { fields.pop() }
      } finally { await rollback(holder) }
      assert.deepEqual(await readFile(path.join(process.env.CMS_UPLOAD_DIR!, media.filename!)), bytes)
    })
    await t.test('invalid GLOBAL restored content is checked before native bypass; preparation imports keep provenance and a revalidated UID', async () => {
      const prior = await payload.findGlobal({ slug: 'news-home', draft: false })
      const holder = await begin()
      let malformedId: string
      try {
        const malformed = await payload.db.createGlobalVersion({ globalSlug: 'news-home', req: holder, autosave: false,
          versionData: { ...prior, headline: '', _status: 'published' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
        malformedId = String(malformed.id)
        await assert.rejects(payload.restoreGlobalVersion({ slug: 'news-home', id: malformedId, req: holder }), /invalid_news_content/)
      } finally { await rollback(holder) }
      assert.deepEqual(await payload.findGlobal({ slug: 'news-home', draft: false }), prior)
      mode = 'legacy'
      try {
        const imported = await payload.create({ collection: 'news-articles', req: await req(), context: legacyNewsImportContext,
          data: { title: 'Trusted preparation', category: '', body: [], editorial: null, _status: 'published', publishedAt: '2020-01-02T03:00:00.000Z' } })
        assert.equal(imported.publishedAt, '2020-01-02T03:00:00.000Z')
        assert.equal((await audits(imported.id))[0].actorUid, actor.uid)
        revoked = true
        await assert.rejects(payload.create({ collection: 'news-articles', req: await req(), context: legacyNewsImportContext, draft: true,
          data: { title: 'Revoked import', body: [], editorial: null } }), /editorial_permission_denied/)
      } finally { mode = 'payload'; revoked = false }
    })
    await t.test('lost response AFTER real COMMIT retries as already_processed with identical content/version/audit IDs', async () => {
      const a = await article(), pending = await schedule(a.id)
      await delay(170)
      const realCommit = payload.db.commitTransaction
      let committed = false
      payload.db.commitTransaction = async id => { await realCommit.call(payload.db, id); committed = true; throw new Error('task6_lost_commit_response') }
      try { await assert.rejects(runScheduledRevision(await worker(), { scheduleId: pending.id }), /task6_lost_commit_response/) }
      finally { payload.db.commitTransaction = realCommit }
      assert.equal(committed, true)
      const before = await live(a.id), beforeAudit = await audits(a.id), beforeVersion = await saved(a.id)
      assert.equal((await scheduleDoc(pending.id)).state, 'published')
      assert.deepEqual(await runScheduledRevision(await worker(), { scheduleId: pending.id }), { state: 'already_processed' })
      assert.deepEqual(await live(a.id), before); assert.deepEqual(await audits(a.id), beforeAudit); assert.deepEqual(await saved(a.id), beforeVersion)
      t.diagnostic(`committed schedule=${pending.id}, version=${beforeVersion.id}, audit IDs=${beforeAudit.map(row => row.id).join(',')}; retry unchanged`)
    })
    const browserArticle = await article('Task6 native browser fixture')
    await writeFile(path.join(privateDir, 'browser-fixture.json'), JSON.stringify({ actor, articleId: browserArticle.id }))
    assert.equal(Object.keys(adapter.sessions).length, 0, 'no live nested/native transactions remain')
    assert.equal(Number((await adapter.drizzle.execute(sql`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`)).rows[0].count), 0)
    assert.equal(Number((await adapter.drizzle.execute(sql`SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND objid = 7194030 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)).rows[0].count), 0)
  } finally {
    globalThis.fetch = originalFetch
    await payload.destroy()
  }
})
