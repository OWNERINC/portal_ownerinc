import { sql } from '@payloadcms/db-postgres'
import { APIError, type Payload, type PayloadRequest } from 'payload'
import { requireCmsTransaction, withCmsTransaction } from '../publication/transaction'
import { lockPortalPageUpload } from './persistence'
import { uuid } from './primitives'

export type PortalPageUploadCleanupState = {
  status: 'pending' | 'done'
  attemptCount: number
  nextAttemptAt: number | null
  lastErrorCode: string | null
}

export type FreshPortalPageUploadState = {
  media: Record<string, unknown> | null
  cleanup: PortalPageUploadCleanupState | null
}

function unavailable(): never {
  throw new APIError('upload_unavailable', 503, undefined, true)
}

function cleanupState(value: unknown): PortalPageUploadCleanupState | null {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { rows?: unknown }).rows)) unavailable()
  const rows = (value as { rows: unknown[] }).rows
  if (rows.length === 0) return null
  if (rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object' || Array.isArray(rows[0])) unavailable()
  const row = rows[0] as Record<string, unknown>
  const status = row.status
  const rawAttemptCount = row.attempt_count
  if (typeof rawAttemptCount === 'string' && !/^(?:0|[1-9][0-9]*)$/u.test(rawAttemptCount)) unavailable()
  const attemptCount = Number(rawAttemptCount)
  const rawNextAttemptAt = row.next_attempt_ms
  if (typeof rawNextAttemptAt === 'string' && !/^(?:0|[1-9][0-9]*)(?:\.0+)?$/u.test(rawNextAttemptAt)) unavailable()
  const nextAttemptAt = rawNextAttemptAt === null ? null : Number(rawNextAttemptAt)
  const rawLastErrorCode = row.last_error_code
  const lastErrorCode = rawLastErrorCode === null ? null : rawLastErrorCode as string
  if ((status !== 'pending' && status !== 'done') || !Number.isSafeInteger(attemptCount) || attemptCount < 0 ||
    attemptCount > 2_147_483_647 ||
    (typeof rawAttemptCount !== 'number' && typeof rawAttemptCount !== 'string') ||
    (nextAttemptAt !== null && !Number.isSafeInteger(nextAttemptAt)) ||
    (nextAttemptAt === null && status !== 'done') ||
    (typeof rawNextAttemptAt !== 'number' && typeof rawNextAttemptAt !== 'string' && rawNextAttemptAt !== null) ||
    (rawLastErrorCode !== null && typeof rawLastErrorCode !== 'string') ||
    (status === 'done' && rawLastErrorCode !== null)) {
    unavailable()
  }
  return { status, attemptCount, nextAttemptAt, lastErrorCode }
}

export async function readPortalPageUploadCleanupState(payload: Payload, req: PayloadRequest,
  rawID: string): Promise<PortalPageUploadCleanupState | null> {
  const id = uuid(rawID, 'upload_unavailable')
  const db = await requireCmsTransaction(payload, req)
  const result = await db.execute(sql`SELECT status, attempt_count,
    extract(epoch FROM next_attempt_at) * 1000 AS next_attempt_ms, last_error_code
    FROM portal_page_upload_cleanup WHERE upload_id = ${id}::uuid`)
  return cleanupState(result)
}

/**
 * Read committed page-upload state in a new Payload session, never an incoming
 * request's possibly stale transaction. Callers retain the filesystem owner
 * across this read when confirming an upload lifecycle transition.
 */
export async function readFreshPortalPageUploadState(payload: Payload, incoming: PayloadRequest,
  rawID: string): Promise<FreshPortalPageUploadState> {
  const id = uuid(rawID, 'upload_unavailable')
  const freshRequest = { ...incoming, transactionID: undefined, context: { ...incoming.context } } as PayloadRequest
  return withCmsTransaction(payload, freshRequest, async transactionReq => {
    await lockPortalPageUpload(payload, transactionReq, id)
    const mediaResult = await payload.findByID({ collection: 'portal-page-media', id, req: transactionReq,
      overrideAccess: true, depth: 0, disableErrors: true }) as unknown
    const media = mediaResult && typeof mediaResult === 'object' && !Array.isArray(mediaResult)
      ? mediaResult as Record<string, unknown> : null
    const cleanup = await readPortalPageUploadCleanupState(payload, transactionReq, id)
    return { media, cleanup }
  })
}
