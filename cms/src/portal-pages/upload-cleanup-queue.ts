export const PORTAL_PAGE_UPLOAD_CLEANUP_BATCH_SIZE = 32
const BASE_RETRY_MS = 60_000
const MAX_RETRY_MS = 24 * 60 * 60 * 1000
const SAFE_CLEANUP_ERROR_CODES = new Set([
  'invalid_media_file', 'upload_incomplete', 'upload_unavailable', 'storage_unavailable', 'disk_unavailable',
  'cleanup_failed', 'upload_not_found', 'media_already_complete',
])

export type PortalPageUploadCleanupItem = {
  uploadID: string
  attemptCount: number
  nextAttemptAt: number
}

export type PortalPageUploadCleanupResult = { done: true; remove?: boolean } | { done: false; nextAttemptAt: number }

export interface PortalPageUploadCleanupAdapter {
  withPassSavepoint<T>(work: () => Promise<T>): Promise<T>
  /** Returns the number of unique queue rows repaired, never more than `limit`. */
  repairMissing(limit: number, now: number): Promise<number>
  claimDue(limit: number, now: number): Promise<PortalPageUploadCleanupItem[]>
  withSavepoint<T>(uploadID: string, work: () => Promise<T>): Promise<T>
  markDone(uploadID: string): Promise<void>
  remove(uploadID: string): Promise<void>
  reschedule(uploadID: string, nextAttemptAt: number): Promise<void>
  defer(uploadID: string, attempts: number, code: string, nextAttemptAt: number): Promise<void>
}

export function portalPageUploadRetryDelay(attempt: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new RangeError('invalid retry attempt')
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** Math.min(attempt - 1, 32)))
}

function safeErrorCode(error: unknown): string {
  const candidate = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
  return SAFE_CLEANUP_ERROR_CODES.has(candidate) ? candidate : 'cleanup_failed'
}

/** A bounded, deterministic pass. Filesystem/metadata truth is resolved by `reconcile`, not this queue. */
export async function processPortalPageUploadCleanupBatch(
  adapter: PortalPageUploadCleanupAdapter,
  reconcile: (uploadID: string, now: number) => Promise<PortalPageUploadCleanupResult>,
  now: number,
  batchSize = PORTAL_PAGE_UPLOAD_CLEANUP_BATCH_SIZE,
): Promise<{ repaired: number; processed: number; done: number; deferred: number }> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > PORTAL_PAGE_UPLOAD_CLEANUP_BATCH_SIZE) {
    throw new RangeError('invalid cleanup batch size')
  }
  return adapter.withPassSavepoint(async () => {
    const repairedCount = await adapter.repairMissing(batchSize, now)
    if (!Number.isSafeInteger(repairedCount) || repairedCount < 0 || repairedCount > batchSize) {
      throw new Error('invalid cleanup repair count')
    }
    const repaired = repairedCount
    const remaining = batchSize - repaired
    if (remaining === 0) return { repaired, processed: 0, done: 0, deferred: 0 }
    const claimed = await adapter.claimDue(remaining, now)
    const byID = new Map<string, PortalPageUploadCleanupItem>()
    for (const item of claimed) {
      if (!Number.isSafeInteger(item.attemptCount) || item.attemptCount < 0 || !Number.isFinite(item.nextAttemptAt) || !item.uploadID) continue
      const previous = byID.get(item.uploadID)
      if (!previous || item.nextAttemptAt < previous.nextAttemptAt ||
        (item.nextAttemptAt === previous.nextAttemptAt && item.attemptCount < previous.attemptCount)) byID.set(item.uploadID, item)
    }
    const items = [...byID.values()].sort((left, right) => left.nextAttemptAt - right.nextAttemptAt || left.uploadID.localeCompare(right.uploadID))
      .slice(0, remaining)
    let done = 0, deferred = 0
    for (const item of items) {
      let completed = false
      try {
        await adapter.withSavepoint(item.uploadID, async () => {
          const outcome = await reconcile(item.uploadID, now)
          if (outcome.done) {
            if (outcome.remove) await adapter.remove(item.uploadID)
            else await adapter.markDone(item.uploadID)
            completed = true
          } else {
            if (!Number.isFinite(outcome.nextAttemptAt) || outcome.nextAttemptAt <= now) throw new Error('invalid retry schedule')
            await adapter.reschedule(item.uploadID, outcome.nextAttemptAt)
          }
        })
        if (completed) done++
      } catch (error) {
        const attempts = item.attemptCount + 1
        await adapter.defer(item.uploadID, attempts, safeErrorCode(error), now + portalPageUploadRetryDelay(attempts))
        deferred++
      }
    }
    return { repaired, processed: items.length, done, deferred }
  })
}
