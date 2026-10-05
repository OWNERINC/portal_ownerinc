import { APIError, type PayloadRequest, type RequiredDataFromCollectionSlug } from 'payload'
import { sql } from '@payloadcms/db-postgres'
import { createPortalClient, PortalAuthError } from '../auth/portal-client'
import { readCmsEnvironment } from '../config/environment'
import { uuid } from '../news/primitives'
import { normalizeNewsContent, normalizeNewsHome, validateNewsPublication } from '../news/validation'
import { assertMediaReferences } from '../media/references'
import { MediaFileUnavailableError } from '../media/storage'
import { appendNewsAudit, publicationActor } from './audit'
import { asPublicationWorker, publicationMutation } from './internal'
import { currentDocument, latestRevision, setGeneration, snapshotDocument, snapshotHash, type NewsSnapshot } from './document'
import { lockPublicationDocument, requireCmsTransaction, withCmsTransaction, withPublicationTransaction, type PublicationTarget } from './transaction'

export function canRunSchedule(schedule: { state: string; generation: number }, generation: number) {
  return schedule.state === 'pending' && schedule.generation === generation
}

export type ScheduleInput = {
  target: PublicationTarget; documentId: string; versionId: string; snapshotHash: string
  scheduledAt: string; expectedGeneration: number; action: 'publish' | 'unpublish'
}
export function validateScheduleTarget(target: unknown, id: unknown): asserts target is PublicationTarget {
  if (target !== 'news-articles' && target !== 'news-home') throw new APIError('invalid_schedule_target', 400, undefined, true)
  if (target === 'news-articles') uuid(id)
  else if (id !== 'news-home') throw new APIError('invalid_schedule_target', 400, undefined, true)
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
export async function scheduleRevision(req: PayloadRequest, input: ScheduleInput) {
  validateScheduleTarget(input.target, input.documentId)
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
    if (hash !== input.snapshotHash) throw new APIError('news_schedule_conflict', 409, undefined, true)
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

export async function runScheduledRevision(req: PayloadRequest, { scheduleId }: { scheduleId: string }): Promise<{
  state: 'published' | 'unpublished' | 'cancelled' | 'rejected' | 'already_processed'
}> {
  return withCmsTransaction(req.payload, req, async req => {
    const client = createPortalClient(readCmsEnvironment(process.env))
    const authority = await client.getAuthority()
    if (authority.mode !== 'payload') throw new APIError('cms_authority_read_only', 409, undefined, true)
    const schedule = await scheduleRow(req, scheduleId)
    if (schedule.state !== 'pending') return { state: 'already_processed' }
    await lockPublicationDocument(req, schedule.target, schedule.documentId)
    const current = await currentDocument(req, schedule.target, schedule.documentId)
    return asPublicationWorker(req, schedule.actorUid, async () => {
      const reject = async (reason: 'actor_revoked' | 'invalid_content' | 'invalid_asset' | 'generation_changed') => {
        const state = reason === 'generation_changed' ? 'cancelled' : 'rejected'
        await changeState(req, schedule.id, state)
        await appendNewsAudit(req, { action: state === 'cancelled' ? 'schedule_cancelled' : 'schedule_rejected',
          documentId: schedule.documentId, versionId: schedule.versionId, actorUid: schedule.actorUid,
          details: { target: schedule.target, generation: schedule.generation, scheduleId: schedule.id, reason } })
        return { state } as const
      }
      if (!canRunSchedule(schedule, Number(current.publicationGeneration || 0))) return reject('generation_changed')
      if (Date.parse(schedule.scheduledAt) > Date.now()) throw new APIError('news_schedule_not_due', 409, undefined, true)
      try { await client.checkPortalActor(schedule.actorUid) }
      catch (error) {
        if (error instanceof PortalAuthError && [401, 403].includes(error.status)) return reject('actor_revoked')
        throw error
      }
      if (snapshotHash(schedule.snapshot) !== schedule.snapshotHash) return reject('invalid_content')
      try { await validateSnapshot(req, schedule.target, schedule.snapshot as NewsSnapshot) }
      catch (error) {
        if (error instanceof MediaFileUnavailableError) return reject('invalid_asset')
        if (error instanceof APIError && error.status === 400) return reject('invalid_content')
        throw error
      }
      const later = await latestRevision(req, schedule.target, schedule.documentId)
      const preserve = later?.version._status === 'draft' &&
        (schedule.action === 'unpublish' || later.id !== schedule.versionId || snapshotHash(snapshotDocument(schedule.target, later.version)) !== schedule.snapshotHash)
      const data = schedule.action === 'publish' ? { ...schedule.snapshot as NewsSnapshot, _status: 'published' as const } : { _status: 'draft' as const }
      const state = schedule.action === 'publish' ? 'published' : 'unpublished'
      // Still uncommitted. Withdrawal cancels OTHER pending agendas, not itself.
      await changeState(req, schedule.id, state)
      if (schedule.target === 'news-articles') {
        await req.payload.update({ collection: 'news-articles', id: schedule.documentId, req, depth: 0, overrideAccess: true, data: data as RequiredDataFromCollectionSlug<'news-articles'> })
        if (preserve) await req.payload.update({ collection: 'news-articles', id: schedule.documentId, req, depth: 0, overrideAccess: true, draft: true,
          data: { ...snapshotDocument(schedule.target, later!.version), _status: 'draft' } })
      } else {
        await req.payload.updateGlobal({ slug: 'news-home', req, depth: 0, overrideAccess: true, data })
        if (preserve) await req.payload.updateGlobal({ slug: 'news-home', req, depth: 0, overrideAccess: true, draft: true,
          data: { ...snapshotDocument(schedule.target, later!.version), _status: 'draft' } })
      }
      return { state }
    })
  })
}
