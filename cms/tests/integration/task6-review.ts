import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { sql, type PostgresAdapter } from '@payloadcms/db-postgres'
import { createLocalReq, ValidationError, type Payload, type PayloadRequest } from 'payload'
import type { ScheduleInput } from '../../src/contracts/news.js'
import type { PortalRuntimeUser } from '../../src/auth/access.js'
import { newsScheduleEndpoints } from '../../src/endpoints/news-schedule.js'
import { scheduleRevision, runScheduledRevision } from '../../src/publication/schedule.js'
import { snapshotDocument, snapshotHash, setGeneration } from '../../src/publication/document.js'
import { lockCmsReferences, requireCmsTransaction, withCmsTransaction } from '../../src/publication/transaction.js'
import { publicationMutation, workerActor } from '../../src/publication/internal.js'
import { appendNewsAudit } from '../../src/publication/audit.js'
import { legacyNewsImportContext } from '../../src/news/validation.js'
import { validateNativeSnapshot } from '../../src/publication/validation.js'

// Uses only the guarded parent runner's dedicated DB, real native operations and Portal double.
export async function runReviewCases(t: TestContext, payload: Payload, user: PortalRuntimeUser, revoke: (value: boolean) => void) {
  const adapter = payload.db as unknown as PostgresAdapter
  const req = () => createLocalReq({ user }, payload)
  const worker = () => createLocalReq({}, payload)
  const article = async (title = 'Review live') => payload.create({ collection: 'news-articles', req: await req(), data: {
    title, category: '', editorial: { version: 1, kind: 'article', summary: 'Summary', author: '', source_label: '', source_date: null },
    body: [{ blockType: 'paragraph', text: 'Body' }], _status: 'published',
  } })
  const versions = async (id: string) => (await payload.findVersions({ collection: 'news-articles', depth: 0, sort: '-updatedAt', limit: 100, where: { parent: { equals: id } } })).docs
  const live = (id: string) => payload.findByID({ collection: 'news-articles', id, depth: 0, draft: false })
  const draft = (id: string) => payload.findByID({ collection: 'news-articles', id, depth: 0, draft: true })
  const audits = async (id: string) => (await payload.find({ collection: 'news-audit', limit: 100, sort: 'createdAt', where: { documentId: { equals: id } } })).docs
  const agenda = (id: string) => payload.findByID({ collection: 'news-schedules', id, depth: 0 })
  const begin = async () => {
    const request = await req(), id = await payload.db.beginTransaction()
    assert.ok(id); request.transactionID = id; await lockCmsReferences(payload, request); return request
  }
  const rollback = async (request: PayloadRequest) => {
    if (request.transactionID) await payload.db.rollbackTransaction(await request.transactionID)
    delete request.transactionID
  }
  const sharedInput = async (id: string): Promise<ScheduleInput> => ({ target: 'article', documentId: id, versionId: (await versions(id))[0].id,
    operation: 'publish', scheduledAt: new Date(Date.now() + 60000).toISOString(), expectedGeneration: (await live(id)).publicationGeneration || 0 })
  // Represents an already queued pre-fix row. Snapshot comes from a REAL saved native
  // Version; public in-process mutation capability is used only to seed that history.
  const oldSchedule = async (id: string) => withCmsTransaction(payload, await req(), async request => {
    const source = (await versions(id))[0], snapshot = snapshotDocument('news-articles', source.version)
    const generation = Number((await live(id)).publicationGeneration || 0) + 1
    await setGeneration(request, 'news-articles', id, generation)
    const row = await publicationMutation(request, () => payload.create({ collection: 'news-schedules', req: request, data: {
      target: 'news-articles', documentId: id, versionId: source.id, snapshot, snapshotHash: snapshotHash(snapshot),
      action: 'publish', scheduledAt: new Date(Date.now() - 1000).toISOString(), actorUid: user.portalUid, generation, state: 'pending',
    } }))
    const job = await payload.jobs.queue({ task: 'publish-news-snapshot', queue: 'owner-news', input: { scheduleId: row.id }, req: request })
    await publicationMutation(request, () => payload.update({ collection: 'news-schedules', id: row.id, req: request, data: { jobId: String(job.id) } }))
    await appendNewsAudit(request, { action: 'scheduled', documentId: id, versionId: source.id, actorUid: user.portalUid,
      details: { target: 'news-articles', generation, scheduleId: row.id, snapshotHash: row.snapshotHash } })
    return row
  })

  await t.test('I1 shared ScheduleInput requests: article/home + operation, optional hash still fences confirmation', async () => {
    const post = newsScheduleEndpoints.find(endpoint => endpoint.method === 'post')!.handler
    const send = async (input: ScheduleInput & { snapshotHash?: string }) => {
      const request = await req(); request.json = async () => JSON.parse(JSON.stringify(input))
      return post(request)
    }
    const a = await article(), input: ScheduleInput = await sharedInput(a.id)
    const response = await send(input)
    assert.equal(response.status, 200, await response.clone().text())
    const created = await response.json(), stored = await agenda(created.id)
    assert.equal(stored.target, 'news-articles'); assert.equal(stored.action, 'publish')
    assert.equal(stored.snapshotHash, snapshotHash(snapshotDocument('news-articles', (await versions(a.id))[0].version)))
    const confirmed = { ...input, expectedGeneration: created.generation, snapshotHash: '0'.repeat(64) }
    assert.equal((await send(confirmed)).status, 409)
    assert.equal((await agenda(created.id)).state, 'pending')
    assert.equal((await send({ ...confirmed, snapshotHash: stored.snapshotHash, operation: 'unpublish' })).status, 200)
    await payload.updateGlobal({ slug: 'news-home', req: await req(), draft: true, data: { eyebrow: 'Owner', headline: 'Shared home', summary: 'Summary' } })
    const home = (await payload.findGlobalVersions({ slug: 'news-home', sort: '-updatedAt', limit: 1 })).docs[0]
    const homeInput: ScheduleInput = { target: 'home', documentId: 'news-home', versionId: home.id, operation: 'unpublish',
      scheduledAt: input.scheduledAt, expectedGeneration: 0 }
    const homeResponse = await send(homeInput)
    assert.equal(homeResponse.status, 200, await homeResponse.clone().text())
    const homeStored = await agenda((await homeResponse.json()).id)
    assert.equal(homeStored.target, 'news-home'); assert.equal(homeStored.action, 'unpublish')
    t.diagnostic(`shared boundary accepted article=${stored.id}, home=${homeStored.id}; supplied stale hash refused 409`)
  })

  await t.test('I2 interactive expiry fails closed, including actual expiry during PostgreSQL lock wait', async () => {
    const a = await article(), before = await versions(a.id), beforeAudit = await audits(a.id)
    for (const expires of [undefined, '', 'invalid', '2030', 123, new Date(Date.now() - 1).toISOString()]) {
      const request = await createLocalReq({ user: { ...user, portalExpiresAt: expires } as PortalRuntimeUser }, payload)
      request.context = { newsPublicationProtocol: true, 'news-publication-worker': user.portalUid, 'owner-news-legacy-import': true }
      await assert.rejects(scheduleRevision(request, await sharedInput(a.id)), /editorial_session_expired/)
      await assert.rejects(payload.update({ collection: 'news-articles', id: a.id, req: request, draft: true, data: { title: 'Expired edit' } }), /editorial_session_expired/)
    }
    const holder = await begin(), expires = Date.now() + 650
    const waitingReq = await createLocalReq({ user: { ...user, portalExpiresAt: new Date(expires).toISOString() } as PortalRuntimeUser }, payload)
    const waiting = payload.update({ collection: 'news-articles', id: a.id, req: waitingReq, draft: true, data: { title: 'Must not save after lock' } })
    const refused = assert.rejects(waiting, /editorial_session_expired/)
    try {
      let blocked = false
      for (let i = 0; i < 100; i++) {
        const result = await adapter.drizzle.execute(sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 7194030 AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)
        if (Number(result.rows[0].n)) { blocked = true; break }
        await delay(10)
      }
      assert.equal(blocked, true, 'actual native operation blocked before expiry')
      assert.ok(Date.now() < expires, 'session initially live while blocked')
      await delay(Math.max(0, expires - Date.now() + 20))
      await payload.db.commitTransaction((await holder.transactionID)!); delete holder.transactionID
      await refused
    } finally { await rollback(holder); await refused }
    assert.deepEqual(await versions(a.id), before); assert.deepEqual(await audits(a.id), beforeAudit)
    t.diagnostic(`interactive session expired at ${new Date(expires).toISOString()} during observed pg_locks wait; no content/version/audit writes`)
  })

  await t.test('I2 workers and trusted CLI imports revalidate UID without a browser expiry dependency', async () => {
    const a = await article(), pending = await oldSchedule(a.id)
    assert.deepEqual(await runScheduledRevision(await worker(), { scheduleId: pending.id }), { state: 'published' })
    const expired = await createLocalReq({ user: { ...user, portalExpiresAt: 'expired-browser' } as PortalRuntimeUser }, payload)
    const imported = await payload.create({ collection: 'news-articles', req: expired, context: legacyNewsImportContext,
      data: { title: 'CLI import', category: '', editorial: null, body: [], _status: 'published' } })
    assert.equal((await audits(imported.id))[0].actorUid, user.portalUid)
    revoke(true)
    try {
      await assert.rejects(payload.create({ collection: 'news-articles', req: expired, context: legacyNewsImportContext,
        data: { title: 'Revoked CLI import', category: '', editorial: null, body: [] } }), /editorial_permission_denied/)
    } finally { revoke(false) }
  })

  await t.test('I3 raw native maxLength mismatch: new schedules refuse and pre-fix pending schedules terminally reject atomically', async () => {
    const a = await article(), badTitle = 'A' + ' '.repeat(200)
    await payload.update({ collection: 'news-articles', id: a.id, req: await req(), draft: true, data: { title: badTitle } })
    assert.equal((await draft(a.id)).title, badTitle, 'native draft stores raw length 201')
    const nativeReq = await req()
    await assert.rejects(payload.update({ collection: 'news-articles', id: a.id, req: nativeReq, data: { title: badTitle, _status: 'published' } }), ValidationError)
    assert.equal(nativeReq.transactionID, undefined, 'native field failure killed its transaction')
    // A persisted row from before the fix must still reach terminal rejection.
    const pending = await oldSchedule(a.id), beforeLive = await live(a.id), beforeDraft = await draft(a.id)
    const beforeVersions = await versions(a.id), beforeAudit = await audits(a.id), holder = await begin()
    try {
      await (await requireCmsTransaction(payload, holder)).execute(sql`SELECT set_config('owner_news.test_audit_fail', 'on', true)`)
      await assert.rejects(runScheduledRevision(holder, { scheduleId: pending.id }))
    } finally { await rollback(holder) }
    assert.equal((await agenda(pending.id)).state, 'pending'); assert.deepEqual(await audits(a.id), beforeAudit)
    assert.deepEqual(await live(a.id), beforeLive); assert.deepEqual(await draft(a.id), beforeDraft)
    assert.deepEqual(await versions(a.id), beforeVersions)
    assert.deepEqual(await runScheduledRevision(await worker(), { scheduleId: pending.id }), { state: 'rejected' })
    assert.deepEqual(await live(a.id), beforeLive); assert.deepEqual(await draft(a.id), beforeDraft)
    assert.deepEqual(await versions(a.id), beforeVersions)
    const afterAudit = await audits(a.id)
    assert.equal(afterAudit.length, beforeAudit.length + 1); assert.equal(afterAudit.at(-1)?.action, 'schedule_rejected')
    await assert.rejects(scheduleRevision(await req(), await sharedInput(a.id)), ValidationError)
    assert.equal((await live(a.id)).publicationGeneration, pending.generation)
    // Category has the same native raw-length mismatch. Block text was already
    // raw-length bounded by draft validation; native traversal also checks it.
    await payload.update({ collection: 'news-articles', id: a.id, req: await req(), draft: true, data: { title: 'Valid', category: 'C' + ' '.repeat(100) } })
    await assert.rejects(scheduleRevision(await req(), await sharedInput(a.id)), ValidationError)
    assert.equal((await live(a.id)).publicationGeneration, pending.generation)
    const badBlock = { title: 'Valid', category: '', body: [{ blockType: 'quote' as const, text: 'Text', attribution: 'A' + ' '.repeat(200) }] }
    await assert.rejects(payload.update({ collection: 'news-articles', id: a.id, req: await req(), draft: true, data: badBlock }), /invalid_news_content/)
    await assert.rejects(withCmsTransaction(payload, await req(), request =>
      validateNativeSnapshot(request, 'news-articles', { ...snapshotDocument('news-articles', beforeDraft), ...badBlock })), ValidationError)
    t.diagnostic(`raw-title schedule=${pending.id}; original native ValidationError reproduced; rejection + audit committed; prior publication/draft/version IDs unchanged`)
  })

  await t.test('I3 late native ValidationError recovers only in a fresh owned transaction; audit and DB faults remain retryable', async () => {
    const a = await article(), pending = await oldSchedule(a.id)
    await payload.update({ collection: 'news-articles', id: a.id, req: await req(), draft: true, data: { title: 'Later review draft' } })
    const beforeLive = await live(a.id), beforeDraft = await draft(a.id), beforeVersions = await versions(a.id), beforeAudit = await audits(a.id)
    const hooks = payload.collections['news-articles'].config.hooks.beforeChange
    const auditHooks = payload.collections['news-audit'].config.hooks.beforeChange
    let killedID: string | number | undefined, recoveryID: string | number | undefined, failAudit = true, operational = false
    // Real native field validator runs AFTER this public collection hook, unlike preflight.
    const lateHook: typeof hooks[number] = async ({ data, req: request }) => {
      if (workerActor(request) && data._status === 'published') {
        killedID = await request.transactionID
        if (operational) await (await requireCmsTransaction(payload, request)).execute(sql`SELECT 1 / 0`)
        data.title = 'A' + ' '.repeat(200)
      }
      return data
    }
    const auditHook: typeof auditHooks[number] = async ({ data, req: request }) => {
      if (data.action === 'schedule_rejected' && data.documentId === a.id) {
        recoveryID = await request.transactionID
        assert.ok(recoveryID); assert.notEqual(recoveryID, killedID)
        assert.equal(adapter.sessions[killedID!], undefined, 'never reuse the native-killed adapter session')
        if (failAudit) await (await requireCmsTransaction(payload, request)).execute(sql`SELECT set_config('owner_news.test_audit_fail', 'on', true)`)
      }
      return data
    }
    hooks.push(lateHook); auditHooks.push(auditHook)
    try {
      const caller = await begin()
      try { await assert.rejects(runScheduledRevision(caller, { scheduleId: pending.id }), ValidationError) }
      finally { await rollback(caller) }
      assert.equal(recoveryID, undefined, 'caller-owned rollback never starts an independent rejection commit')
      assert.equal((await agenda(pending.id)).state, 'pending'); assert.deepEqual(await audits(a.id), beforeAudit)
      await assert.rejects(runScheduledRevision(await worker(), { scheduleId: pending.id }))
      assert.ok(recoveryID, 'deterministic native error attempted atomic rejection on a new transaction')
      assert.equal((await agenda(pending.id)).state, 'pending'); assert.deepEqual(await audits(a.id), beforeAudit)
      assert.deepEqual(await live(a.id), beforeLive); assert.deepEqual(await draft(a.id), beforeDraft); assert.deepEqual(await versions(a.id), beforeVersions)
      failAudit = false; operational = true; recoveryID = undefined
      await assert.rejects(runScheduledRevision(await worker(), { scheduleId: pending.id }))
      assert.equal(recoveryID, undefined, 'database error must not become editorial rejection')
      assert.equal((await agenda(pending.id)).state, 'pending'); assert.deepEqual(await audits(a.id), beforeAudit)
      operational = false
      assert.deepEqual(await runScheduledRevision(await worker(), { scheduleId: pending.id }), { state: 'rejected' })
      assert.deepEqual(await live(a.id), beforeLive); assert.deepEqual(await draft(a.id), beforeDraft); assert.deepEqual(await versions(a.id), beforeVersions)
      assert.equal((await audits(a.id)).at(-1)?.action, 'schedule_rejected')
      assert.deepEqual(await runScheduledRevision(await worker(), { scheduleId: pending.id }), { state: 'already_processed' })
      t.diagnostic(`late native ValidationError: rolled back transaction=${killedID}; terminal rejection transaction=${recoveryID}; audit fault and real DB division-by-zero preserved pending`)
    } finally { hooks.splice(hooks.indexOf(lateHook), 1); auditHooks.splice(auditHooks.indexOf(auditHook), 1) }
  })

  await t.test('I3 native GLOBAL late field failure rejects without changing live home or its later draft', async () => {
    await payload.updateGlobal({ slug: 'news-home', req: await req(), data: { eyebrow: 'Owner', headline: 'Live review home', summary: 'Summary', _status: 'published' } })
    const source = (await payload.findGlobalVersions({ slug: 'news-home', sort: '-updatedAt', limit: 1 })).docs[0]
    const input: ScheduleInput = { target: 'home', documentId: 'news-home', versionId: source.id, operation: 'publish',
      scheduledAt: new Date(Date.now() + 150).toISOString(), expectedGeneration: (await payload.findGlobal({ slug: 'news-home', draft: false })).publicationGeneration || 0 }
    const pending = await scheduleRevision(await req(), input)
    await payload.updateGlobal({ slug: 'news-home', req: await req(), draft: true, data: { headline: 'Later review home' } })
    const beforeLive = await payload.findGlobal({ slug: 'news-home', draft: false }), beforeDraft = await payload.findGlobal({ slug: 'news-home', draft: true })
    const beforeVersions = await payload.findGlobalVersions({ slug: 'news-home', sort: '-updatedAt', limit: 100 }), beforeAudit = await audits('news-home')
    const hooks = payload.globals.config.find(config => config.slug === 'news-home')!.hooks.beforeChange
    const lateHook: typeof hooks[number] = ({ data, req: request }) => {
      if (workerActor(request) && data._status === 'published') data.headline = 'H' + ' '.repeat(160)
      return data
    }
    hooks.push(lateHook)
    try {
      await delay(170)
      assert.deepEqual(await runScheduledRevision(await worker(), { scheduleId: pending.id }), { state: 'rejected' })
      assert.deepEqual(await payload.findGlobal({ slug: 'news-home', draft: false }), beforeLive)
      assert.deepEqual(await payload.findGlobal({ slug: 'news-home', draft: true }), beforeDraft)
      assert.deepEqual(await payload.findGlobalVersions({ slug: 'news-home', sort: '-updatedAt', limit: 100 }), beforeVersions)
      const afterAudit = await audits('news-home')
      assert.equal(afterAudit.length, beforeAudit.length + 1); assert.equal(afterAudit.at(-1)?.action, 'schedule_rejected')
    } finally { hooks.splice(hooks.indexOf(lateHook), 1) }
  })
}
