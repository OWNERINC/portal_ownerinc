import { APIError, ValidationError, type PayloadRequest, type RequiredDataFromCollectionSlug } from 'payload'
import { sql } from '@payloadcms/db-postgres'
import { createPortalClient, PortalAuthError } from '../auth/portal-client'
import { readCmsEnvironment } from '../config/environment'
import type { ScheduleInput } from '../contracts/news'
import { isUUID } from '../migration/identity'
import { uuid } from '../news/primitives'
import { normalizeNewsContent, normalizeNewsHome, validateNewsPublication } from '../news/validation'
import { assertMediaReferences } from '../media/references'
import { MediaFileUnavailableError } from '../media/storage'
import { appendNewsAudit, publicationActor } from './audit'
import { asPublicationWorker, publicationMutation } from './internal'
import { currentDocument, latestRevision, setGeneration, snapshotDocument, snapshotHash, type NewsSnapshot } from './document'
import { lockPublicationDocument, requireCmsTransaction, withCmsTransaction, withPublicationTransaction, type PublicationTarget } from './transaction'
import { isNativeContentValidation, validateNativeSnapshot } from './validation'

export function canRunSchedule(schedule: { state: string; generation: number }, generation: number) {
  return schedule.state === 'pending' && schedule.generation === generation
}

/** Shared API vocabulary stays independent of Payload collection/global slugs. */
export function scheduleTarget(target: unknown, id: unknown): PublicationTarget {
  if (target !== 'article' && target !== 'home') throw new APIError('invalid_schedule_target', 400, undefined, true)
  if (target === 'article') uuid(id)
  else if (id !== 'news-home') throw new APIError('invalid_schedule_target', 400, undefined, true)
  return target === 'article' ? 'news-articles' : 'news-home'
}
function expectGeneration(actual: number, expected: number) {
  if (!Number.isSafeInteger(expected) || expected < 0 || expected >= Number.MAX_SAFE_INTEGER || actual !== expected) throw new APIError('news_schedule_conflict', 409, undefined, true)
}
async function validateSnapshot(req: PayloadRequest, target: PublicationTarget, snapshot: NewsSnapshot) {
  if (target === 'news-home') normalizeNewsHome(snapshot, true)
  else {
    validateNewsPublication(snapshot)
    await assertMediaReferences(req.payload, normalizeNewsContent(snapshot.body), req)
  }
  await validateNativeSnapshot(req, target, snapshot)
}
async function scheduleRow(req: PayloadRequest, id: string) {
  const db = await requireCmsTransaction(req.payload, req)
  await db.execute(sql`SELECT id FROM news_schedules WHERE id = ${uuid(id)}::uuid FOR UPDATE`)
  return req.payload.findByID({ collection: 'news-schedules', id, req, depth: 0, overrideAccess: true })
}
async function changeState(req: PayloadRequest, id: string, state: 'cancelled' | 'rejected' | 'published' | 'unpublished') {
  return publicationMutation(req, () => req.payload.update({ collection: 'news-schedules', id, req, overrideAccess: true, data: { state } }))
}
export async function cancelPendingSchedules(req: PayloadRequest, target: PublicationTarget, documentId: string, reason: 'withdrawn' | 'replaced' | 'cancelled') {
  await requireCmsTransaction(req.payload, req)
  const pending = await req.payload.find({ collection: 'news-schedules', req, overrideAccess: true, depth: 0, limit: 100,
    where: { and: [{ target: { equals: target } }, { documentId: { equals: documentId } }, { state: { equals: 'pending' } }] } })
  if (pending.hasNextPage) throw new APIError('news_schedule_scan_limit', 503, undefined, true)
  for (const schedule of pending.docs) {
    await scheduleRow(req, schedule.id)
    await changeState(req, schedule.id, 'cancelled')
    await appendNewsAudit(req, { action: 'schedule_cancelled', documentId, versionId: schedule.versionId,
      actorUid: publicationActor(req), details: { target, generation: schedule.generation, scheduleId: schedule.id, reason } })
  }
}
export async function scheduleRevision(req: PayloadRequest, request: ScheduleInput) {
  const input = { ...request, target: scheduleTarget(request.target, request.documentId), action: request.operation }
  uuid(input.versionId)
  if (!['publish', 'unpublish'].includes(input.action) || typeof input.scheduledAt !== 'string' ||
    !Number.isFinite(Date.parse(input.scheduledAt)) || new Date(input.scheduledAt).toISOString() !== input.scheduledAt || Date.parse(input.scheduledAt) <= Date.now()) {
    throw new APIError('invalid_schedule_date_or_action', 400, undefined, true)
  }
  return withPublicationTransaction(req, input.target, input.documentId, async req => {
    const current = await currentDocument(req, input.target, input.documentId)
    expectGeneration(Number(current.publicationGeneration || 0), input.expectedGeneration)
    const version = input.target === 'news-articles'
      ? await req.payload.findVersionByID({ collection: input.target, id: input.versionId, req, depth: 0, overrideAccess: true })
      : await req.payload.findGlobalVersionByID({ slug: input.target, id: input.versionId, req, depth: 0, overrideAccess: true })
    if ('parent' in version && version.parent !== input.documentId) throw new APIError('news_schedule_version_mismatch', 409, undefined, true)
    const snapshot = snapshotDocument(input.target, version.version)
    const hash = snapshotHash(snapshot)
    if (input.snapshotHash !== undefined && hash !== input.snapshotHash) throw new APIError('news_schedule_conflict', 409, undefined, true)
    await validateSnapshot(req, input.target, snapshot)
    const generation = input.expectedGeneration + 1
    await cancelPendingSchedules(req, input.target, input.documentId, 'replaced')
    await setGeneration(req, input.target, input.documentId, generation)
    const actorUid = publicationActor(req)
    const schedule = await publicationMutation(req, () => req.payload.create({ collection: 'news-schedules', req, overrideAccess: true,
      data: { target: input.target, documentId: input.documentId, action: input.action, versionId: input.versionId,
        snapshot, snapshotHash: hash, actorUid, scheduledAt: input.scheduledAt, generation, state: 'pending' } }))
    const job = await req.payload.jobs.queue({ task: 'publish-news-snapshot', input: { scheduleId: schedule.id },
      queue: 'owner-news', waitUntil: new Date(input.scheduledAt), req })
    // The public Jobs concurrency extension binds its UNIQUE key at native creation.
    await publicationMutation(req, () => req.payload.update({ collection: 'news-schedules', id: schedule.id, req, overrideAccess: true, data: { jobId: String(job.id) } }))
    await appendNewsAudit(req, { action: 'scheduled', documentId: input.documentId, versionId: input.versionId, actorUid,
      details: { target: input.target, generation, scheduleId: schedule.id, snapshotHash: hash } })
    return { id: schedule.id, generation, scheduledAt: schedule.scheduledAt }
  })
}
export async function cancelSchedule(req: PayloadRequest, input: { id: string; expectedGeneration: number }) {
  // Read-only routing hint; all authority/state/generation decisions use the locked reread.
  const hint = await req.payload.findByID({ collection: 'news-schedules', id: uuid(input.id), req, overrideAccess: false, depth: 0 })
  return withPublicationTransaction(req, hint.target, hint.documentId, async req => {
    const schedule = await scheduleRow(req, input.id)
    const current = await currentDocument(req, schedule.target, schedule.documentId)
    expectGeneration(schedule.generation, input.expectedGeneration)
    expectGeneration(Number(current.publicationGeneration || 0), input.expectedGeneration)
    if (schedule.state !== 'pending') throw new APIError('news_schedule_conflict', 409, undefined, true)
    await setGeneration(req, schedule.target, schedule.documentId, input.expectedGeneration + 1)
    await cancelPendingSchedules(req, schedule.target, schedule.documentId, 'cancelled')
    return { state: 'cancelled' as const }
  })
}

type ScheduleResult = {
  state: 'published' | 'unpublished' | 'cancelled' | 'rejected' | 'already_processed'
}
type RejectionFence = { generation: number; snapshotHash: string; versionId: string; actorUid: string }
class NativePublicationFailure extends Error {
  constructor(readonly validation: unknown, readonly fence: RejectionFence) { super('news_native_content_invalid') }
}
export async function runScheduledRevision(req: PayloadRequest, { scheduleId }: { scheduleId: string }): Promise<ScheduleResult> {
  const callerOwnsTransaction = Boolean(req.transactionID)
  try { return await runScheduleTransaction(req, scheduleId) }
  catch (error) {
    if (!(error instanceof NativePublicationFailure)) throw error
    // A native write has killed the entire transaction. Never continue on that req,
    // nor independently commit a rejection if the caller owned the rolled-back unit.
    if (callerOwnsTransaction) throw error.validation
    // The failed owned unit is already rolled back. Fresh transaction, fresh lock /
    // authority / actor / state / generation checks; rejection + audit commit together.
    return runScheduleTransaction(req, scheduleId, error.fence)
  }
}
async function runScheduleTransaction(req: PayloadRequest, scheduleId: string, failed?: RejectionFence): Promise<ScheduleResult> {
  return withCmsTransaction(req.payload, req, async req => {
    const client = createPortalClient(readCmsEnvironment(process.env))
    const authority = await client.getAuthority()
    if (authority.mode !== 'payload') throw new APIError('cms_authority_read_only', 409, undefined, true)
    const schedule = await scheduleRow(req, scheduleId)
    if (schedule.state !== 'pending') return { state: 'already_processed' }
    const actorUid = schedule.actorUid
    if (typeof actorUid !== 'string' || actorUid.length === 0) {
      throw new APIError('news_schedule_actor_unknown', 409, undefined, true)
    }
    const versionId = schedule.versionId
    if (typeof versionId !== 'string' || versionId.length === 0) {
      throw new APIError('news_schedule_version_missing', 409, undefined, true)
    }
    if (!isUUID(versionId)) throw new APIError('news_schedule_version_invalid', 409, undefined, true)
    await lockPublicationDocument(req, schedule.target, schedule.documentId)
    const current = await currentDocument(req, schedule.target, schedule.documentId)
    return asPublicationWorker(req, actorUid, async () => {
      const reject = async (reason: 'actor_revoked' | 'invalid_content' | 'invalid_asset' | 'generation_changed') => {
        await requireCmsTransaction(req.payload, req)
        const state = reason === 'generation_changed' ? 'cancelled' : 'rejected'
        await changeState(req, schedule.id, state)
        await appendNewsAudit(req, { action: state === 'cancelled' ? 'schedule_cancelled' : 'schedule_rejected',
         documentId: schedule.documentId, versionId, actorUid,
          details: { target: schedule.target, generation: schedule.generation, scheduleId: schedule.id, reason } })
        return { state } as const
      }
      if (!canRunSchedule(schedule, Number(current.publicationGeneration || 0))) return reject('generation_changed')
      if (Date.parse(schedule.scheduledAt) > Date.now()) throw new APIError('news_schedule_not_due', 409, undefined, true)
      try { await client.checkPortalActor(actorUid) }
      catch (error) {
        if (error instanceof PortalAuthError && [401, 403].includes(error.status)) return reject('actor_revoked')
        throw error
      }
      if (failed) {
        if (failed.generation !== schedule.generation || failed.snapshotHash !== schedule.snapshotHash ||
           failed.versionId !== versionId || failed.actorUid !== actorUid) {
          throw new APIError('news_schedule_conflict', 409, undefined, true)
        }
        return reject('invalid_content')
      }
      if (snapshotHash(schedule.snapshot) !== schedule.snapshotHash) return reject('invalid_content')
      try { await validateSnapshot(req, schedule.target, schedule.snapshot as NewsSnapshot) }
      catch (error) {
        if (error instanceof MediaFileUnavailableError) return reject('invalid_asset')
        if (error instanceof ValidationError) {
          if (isNativeContentValidation(error, schedule.target)) return reject('invalid_content')
          throw error
        }
        if (error instanceof APIError && error.status === 400) return reject('invalid_content')
        throw error
      }
      const later = await latestRevision(req, schedule.target, schedule.documentId)
      const preserve = later?.version._status === 'draft' &&
         (schedule.action === 'unpublish' || later.id !== versionId || snapshotHash(snapshotDocument(schedule.target, later.version)) !== schedule.snapshotHash)
      const data = schedule.action === 'publish' ? { ...schedule.snapshot as NewsSnapshot, _status: 'published' as const } : { _status: 'draft' as const }
      const state = schedule.action === 'publish' ? 'published' : 'unpublished'
      // Still uncommitted. Withdrawal cancels OTHER pending agendas, not itself.
      await changeState(req, schedule.id, state)
      try {
        if (schedule.target === 'news-articles') {
          await req.payload.update({ collection: 'news-articles', id: schedule.documentId, req, depth: 0, overrideAccess: true, data: data as RequiredDataFromCollectionSlug<'news-articles'> })
          if (preserve) await req.payload.update({ collection: 'news-articles', id: schedule.documentId, req, depth: 0, overrideAccess: true, draft: true,
            data: { ...snapshotDocument(schedule.target, later!.version), _status: 'draft' } })
        } else {
          await req.payload.updateGlobal({ slug: 'news-home', req, depth: 0, overrideAccess: true, data })
          if (preserve) await req.payload.updateGlobal({ slug: 'news-home', req, depth: 0, overrideAccess: true, draft: true,
            data: { ...snapshotDocument(schedule.target, later!.version), _status: 'draft' } })
        }
      } catch (error) {
        if (isNativeContentValidation(error, schedule.target)) {
          throw new NativePublicationFailure(error, { generation: schedule.generation, snapshotHash: schedule.snapshotHash,
            versionId, actorUid })
        }
        throw error
      }
      return { state }
    })
  })
}
