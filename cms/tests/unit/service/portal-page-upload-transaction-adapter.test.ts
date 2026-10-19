import assert from 'node:assert/strict'
import test from 'node:test'
import { sql } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'
import { lockPortalPageUpload, portalPageUploadAdvisoryKey } from '../../../src/portal-pages/persistence'
import { withCmsTransaction } from '../../../src/publication/transaction'
import { createPortalPageUploadTransactionAdapter } from '../../fixtures/portal-page-upload-transaction-adapter'

const uploadID = '018f47a2-7b3c-7a11-8a2c-1234567890ad'

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>(resolve => { resolvePromise = resolve })
  return { promise, resolve: (value?: T) => resolvePromise(value as T) }
}

test('session adapter owns independent transactions, models savepoints, and discards rolled-back writes', async () => {
  const fixture = createPortalPageUploadTransactionAdapter()
  const firstReq = fixture.req(), secondReq = fixture.req()
  const firstEntered = deferred<void>()
  const releaseFirst = deferred<void>()
  const first = withCmsTransaction(fixture.payload, firstReq, async transactionReq => {
    const db = (await transactionReq.transactionID)!
    const session = (fixture.payload.db as unknown as { sessions: Record<string, { db: { execute: (query: unknown) => Promise<unknown> } }> }).sessions[db]!
    await session.db.execute(sql`SAVEPOINT portal_page_upload_cleanup_item`)
    await session.db.execute(sql`INSERT INTO portal_page_upload_cleanup (upload_id, status, next_attempt_at)
      VALUES (${uploadID}::uuid, 'pending', ${new Date(0)}) ON CONFLICT (upload_id) DO NOTHING`)
    assert.equal(fixture.queue.has(uploadID), false, 'uncommitted queue writes are isolated from committed state')
    await session.db.execute(sql`ROLLBACK TO SAVEPOINT portal_page_upload_cleanup_item`)
    await session.db.execute(sql`RELEASE SAVEPOINT portal_page_upload_cleanup_item`)
    firstEntered.resolve()
    await releaseFirst.promise
  })
  await firstEntered.promise

  const secondStarted = fixture.waitForNextBegin()
  let secondEntered = false
  const second = withCmsTransaction(fixture.payload, secondReq, async transactionReq => {
    await lockPortalPageUpload(fixture.payload, transactionReq, uploadID)
    secondEntered = true
  })
  const secondTransactionID = await secondStarted
  assert.ok(fixture.activeSessionIDs().includes(secondTransactionID), 'second request owns a distinct session while waiting')
  assert.equal(secondEntered, false, 'the CMS advisory transaction boundary serializes independent sessions')
  releaseFirst.resolve()
  await Promise.all([first, second])

  assert.deepEqual(fixture.activeSessionIDs(), [])
  assert.equal(fixture.queue.has(uploadID), false, 'savepoint rollback discarded the staged queue insert')
  const lockEvents = fixture.trace.filter(event => event.kind === 'advisory-lock')
  assert.ok(lockEvents.some(event => event.lockClass === 'cms-reference'), 'the shared CMS lock is modeled')
  assert.ok(lockEvents.some(event => event.lockClass === 'portal-page-upload'),
    'the production per-upload helper must execute the advisory SQL')
  assert.equal(fixture.trace.filter(event => event.kind === 'begin').length, 2, 'each request begins its own transaction')
  assert.equal(fixture.trace.filter(event => event.kind === 'commit').length, 2)
  assert.ok(fixture.trace.some(event => event.kind === 'savepoint' && event.sql?.startsWith('ROLLBACK TO SAVEPOINT')))
})

test('session adapter applies a successful commit even when its receipt is lost', async () => {
  const fixture = createPortalPageUploadTransactionAdapter()
  fixture.loseNextCommitReceipt()
  await assert.rejects(withCmsTransaction(fixture.payload, fixture.req(), async transactionReq => {
    const id = await transactionReq.transactionID
    const session = (fixture.payload.db as unknown as { sessions: Record<string, { db: { execute: (query: unknown) => Promise<unknown> } }> }).sessions[id!]!
    await session.db.execute(sql`INSERT INTO portal_page_upload_cleanup (upload_id, status, next_attempt_at)
      VALUES (${uploadID}::uuid, 'pending', ${new Date(1234)}) ON CONFLICT (upload_id) DO NOTHING`)
  }), /transaction_fixture_lost_commit_receipt/u)

  assert.equal(fixture.queue.get(uploadID)?.nextAttemptAt, 1234, 'the commit was applied before the transport receipt failed')
  assert.deepEqual(fixture.activeSessionIDs(), [], 'a lost receipt does not leave a live session behind')
  assert.equal(fixture.trace.filter(event => event.kind === 'commit').length, 1)
  assert.equal(fixture.trace.filter(event => event.kind === 'rollback').length, 0, 'rollback after a lost receipt is a native no-op')
})

test('production per-upload advisory SQL blocks a second independent transaction until commit', async () => {
  const fixture = createPortalPageUploadTransactionAdapter()
  const db = fixture.payload.db as unknown as {
    beginTransaction: () => Promise<string>
    commitTransaction: (id: string) => Promise<void>
  }
  const firstID = await db.beginTransaction()
  const firstReq = { ...fixture.req(), transactionID: firstID } as PayloadRequest
  await lockPortalPageUpload(fixture.payload, firstReq, uploadID)

  const secondID = await db.beginTransaction()
  const secondReq = { ...fixture.req(), transactionID: secondID } as PayloadRequest
  const waiting = fixture.waitForNextAdvisoryWait()
  let secondEntered = false
  const second = lockPortalPageUpload(fixture.payload, secondReq, uploadID).then(() => { secondEntered = true })
  const waitResult = await Promise.race([
    waiting.then(event => ({ kind: 'wait' as const, event })),
    second.then(() => ({ kind: 'unblocked' as const })),
  ])
  assert.equal(waitResult.kind, 'wait', 'removing the production upload-lock SQL must fail promptly instead of hanging')
  if (waitResult.kind !== 'wait') return
  const waitEvent = waitResult.event
  assert.equal(waitEvent.transactionID, secondID)
  assert.equal(waitEvent.lockKey, `portal-page-upload:${portalPageUploadAdvisoryKey(uploadID).join(',')}`)
  assert.equal(secondEntered, false, 'the second helper call waits on the actual per-upload key without a shared-lock gate')
  await db.commitTransaction(firstID)
  await second
  assert.equal(secondEntered, true)
  await db.commitTransaction(secondID)

  const uploadLocks = fixture.trace.filter(event => event.kind === 'advisory-lock' && event.lockClass === 'portal-page-upload')
  assert.equal(uploadLocks.length, 2)
  assert.notEqual(uploadLocks[0]!.transactionID, uploadLocks[1]!.transactionID)
  assert.equal(uploadLocks[0]!.lockKey, uploadLocks[1]!.lockKey)
  assert.deepEqual(fixture.activeSessionIDs(), [])
})
