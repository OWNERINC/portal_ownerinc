import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PORTAL_PAGE_UPLOAD_CLEANUP_BATCH_SIZE,
  portalPageUploadRetryDelay,
  processPortalPageUploadCleanupBatch,
  type PortalPageUploadCleanupAdapter,
  type PortalPageUploadCleanupItem,
} from '../../../src/portal-pages/upload-cleanup-queue'

function item(uploadID: string, attemptCount = 0, nextAttemptAt = 0): PortalPageUploadCleanupItem {
  return { uploadID, attemptCount, nextAttemptAt }
}

function adapter(items: PortalPageUploadCleanupItem[], repaired = 0) {
  const processed: string[] = []
  const deferred: Array<{ uploadID: string; attempts: number; code: string; nextAttemptAt: number }> = []
  const done: string[] = []
  const claims: number[] = []
  let repairs = 0
  const value: PortalPageUploadCleanupAdapter = {
    async withPassSavepoint(work) { return work() },
    async repairMissing(limit) { repairs += limit; return repaired },
    async claimDue(limit) { claims.push(limit); return items },
    async withSavepoint(_uploadID, work) { return work() },
    async markDone(uploadID) { done.push(uploadID) },
    async remove(uploadID) { done.push(`removed:${uploadID}`) },
    async reschedule(uploadID, nextAttemptAt) { deferred.push({ uploadID, attempts: 0, code: 'rescheduled', nextAttemptAt }) },
    async defer(uploadID, attempts, code, nextAttemptAt) { deferred.push({ uploadID, attempts, code, nextAttemptAt }) },
  }
  return { value, processed, deferred, done, claims, repairs: () => repairs }
}

test('cleanup queue has a fixed bounded batch and spends repair budget before due claims', async () => {
  assert.equal(PORTAL_PAGE_UPLOAD_CLEANUP_BATCH_SIZE, 32)
  const f = adapter(Array.from({ length: 40 }, (_, index) => item(`id-${String(index).padStart(2, '0')}`)), 5)
  const result = await processPortalPageUploadCleanupBatch(f.value, async () => ({ done: true }), 10_000)
  assert.equal(f.repairs(), 32)
  assert.deepEqual(f.claims, [27])
  assert.equal(result.repaired, 5)
  assert.equal(result.processed, 27)

  const next = adapter(Array.from({ length: 40 }, (_, index) => item(`id-${String(index).padStart(2, '0')}`)))
  const progressed = await processPortalPageUploadCleanupBatch(next.value, async () => ({ done: true }), 10_000)
  assert.deepEqual(next.claims, [32])
  assert.equal(progressed.processed, 32)
  assert.deepEqual(next.done, Array.from({ length: 32 }, (_, index) => `id-${String(index).padStart(2, '0')}`))
})

test('cleanup queue sorts deterministically, deduplicates IDs, and isolates a poison entry', async () => {
  const f = adapter([
    item('id-c', 0, 300), item('id-b', 1, 100), item('id-a', 0, 100), item('id-a', 2, 50), item('id-z', 0, 400),
  ])
  const result = await processPortalPageUploadCleanupBatch(f.value, async uploadID => {
    if (uploadID === 'id-b') throw Object.assign(new Error('sensitive path detail'), { code: 'storage_unavailable' })
    if (uploadID === 'id-z') throw Object.assign(new Error('sensitive path detail'), { code: '../../private/path' })
    return { done: true }
  }, 10_000)
  assert.equal(result.processed, 4)
  assert.equal(result.done, 2)
  assert.equal(result.deferred, 2)
  assert.deepEqual(f.done, ['id-a', 'id-c'])
  assert.equal(f.deferred.length, 2)
  assert.deepEqual(f.deferred[0], {
    uploadID: 'id-b', attempts: 2, code: 'storage_unavailable', nextAttemptAt: 10_000 + portalPageUploadRetryDelay(2),
  })
  assert.deepEqual(f.deferred[1], {
    uploadID: 'id-z', attempts: 1, code: 'cleanup_failed', nextAttemptAt: 10_000 + portalPageUploadRetryDelay(1),
  })
  assert.ok(!JSON.stringify(f.deferred).includes('sensitive path detail'))
})

test('cleanup retry delay is exponential, positive, and capped', () => {
  assert.equal(portalPageUploadRetryDelay(1), 60_000)
  assert.equal(portalPageUploadRetryDelay(2), 120_000)
  assert.equal(portalPageUploadRetryDelay(3), 240_000)
  assert.equal(portalPageUploadRetryDelay(100), 24 * 60 * 60 * 1000)
  assert.throws(() => portalPageUploadRetryDelay(0))
})
