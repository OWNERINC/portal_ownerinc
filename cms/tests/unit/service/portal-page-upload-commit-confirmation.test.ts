import assert from 'node:assert/strict'
import test from 'node:test'
import { sql } from '@payloadcms/db-postgres'
import type { PayloadRequest } from 'payload'
import { readFreshPortalPageUploadState } from '../../../src/portal-pages/upload-commit-confirmation'
import { withCmsTransaction } from '../../../src/publication/transaction'
import { createPortalPageUploadTransactionAdapter } from '../../fixtures/portal-page-upload-transaction-adapter'

test('fresh upload snapshot ignores a stale request session and reads media plus cleanup through a new locked session', async () => {
  const fixture = createPortalPageUploadTransactionAdapter()
  const committed = await withCmsTransaction(fixture.payload, fixture.req(), async transactionReq => {
    const media = await fixture.payload.create({ collection: 'portal-page-media', req: transactionReq, overrideAccess: true,
      data: { originalName: 'fresh.pdf', mimeType: 'application/pdf', filesize: 7, sha256: null,
        state: 'uploading', completedAt: null } as never }) as unknown as Record<string, unknown>
    const db = (fixture.payload.db as unknown as { sessions: Record<string, { db: { execute: (query: unknown) => Promise<unknown> } }> })
      .sessions[String(await transactionReq.transactionID)]!.db
    await db.execute(sql`INSERT INTO portal_page_upload_cleanup (upload_id, status, next_attempt_at)
      VALUES (${media.id}::uuid, 'pending', ${new Date(123456)}) ON CONFLICT (upload_id) DO NOTHING`)
    return media
  })

  const db = fixture.payload.db as unknown as {
    beginTransaction: () => Promise<string>
    rollbackTransaction: (id: string) => Promise<void>
    sessions: Record<string, { db: { execute: (query: unknown) => Promise<unknown> } }>
  }
  const staleID = await db.beginTransaction()
  await db.sessions[staleID]!.db.execute(sql`UPDATE portal_page_upload_cleanup SET status = 'done',
    next_attempt_at = NULL, last_error_code = NULL WHERE upload_id = ${committed.id}::uuid`)
  const staleReq = { ...fixture.req(), transactionID: staleID } as PayloadRequest
  const traceStart = fixture.trace.length

  const fresh = await readFreshPortalPageUploadState(fixture.payload, staleReq, String(committed.id))

  assert.equal(fresh.media?.id, committed.id)
  assert.equal(fresh.media?.state, 'uploading')
  assert.equal(fresh.media?.uploadedBy, 'transaction-fixture-actor')
  assert.deepEqual(fresh.cleanup, { status: 'pending', attemptCount: 0, nextAttemptAt: 123456, lastErrorCode: null },
    'the fresh reader sees committed queue state instead of the stale request snapshot')
  const freshEvents = fixture.trace.slice(traceStart)
  const begin = freshEvents.find(event => event.kind === 'begin')
  const cmsLock = freshEvents.find(event => event.kind === 'advisory-lock' && event.lockClass === 'cms-reference')
  const uploadLock = freshEvents.find(event => event.kind === 'advisory-lock' && event.lockClass === 'portal-page-upload')
  assert.ok(begin && begin.transactionID !== staleID, 'confirmation owns a new Payload session')
  assert.ok(cmsLock && uploadLock)
  assert.equal(cmsLock.transactionID, begin!.transactionID)
  assert.equal(uploadLock.transactionID, begin!.transactionID)
  assert.ok(cmsLock.sequence < uploadLock.sequence, 'confirmation preserves CMS → upload advisory order')
  assert.deepEqual(fixture.activeSessionIDs(), [staleID], 'confirmation closed its new session without consuming caller ownership')
  await db.rollbackTransaction(staleID)
  assert.deepEqual(fixture.activeSessionIDs(), [])
})
