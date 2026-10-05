import { APIError, type Endpoint, type PayloadRequest } from 'payload'
import { canManageNews } from '../auth/access'
import { PortalAuthError } from '../auth/portal-client'
import { currentDocument, latestRevision, snapshotDocument, snapshotHash } from '../publication/document'
import { cancelSchedule, scheduleRevision, validateScheduleTarget, type ScheduleInput } from '../publication/schedule'
import { withCmsTransaction } from '../publication/transaction'

async function handle(req: PayloadRequest, operation: () => Promise<unknown>) {
  try {
    if (!canManageNews({ req })) throw new APIError('editorial_permission_denied', 403, undefined, true)
    return Response.json(await operation(), { headers: { 'Cache-Control': 'private,no-store' } })
  } catch (error) {
    const status = error instanceof APIError || error instanceof PortalAuthError ? error.status : 503
    return Response.json({ error: status === 409 ? 'news_schedule_conflict' : status === 400 ? 'invalid_schedule' :
      status === 403 ? 'editorial_permission_denied' : 'editorial_unavailable' }, { status, headers: { 'Cache-Control': 'private,no-store' } })
  }
}
export const newsScheduleEndpoints: Endpoint[] = [
  { path: '/news-schedule', method: 'get', handler: req => handle(req, async () => {
    const target = req.searchParams?.get('target'), documentId = req.searchParams?.get('documentId')
    validateScheduleTarget(target, documentId)
    return withCmsTransaction(req.payload, req, async req => {
      const current = await currentDocument(req, target, documentId!)
      const revision = await latestRevision(req, target, documentId!)
      if (!revision) throw new APIError('news_saved_revision_required', 409, undefined, true)
      const snapshot = snapshotDocument(target, revision.version)
      const pending = await req.payload.find({ collection: 'news-schedules', req, depth: 0, overrideAccess: false, limit: 1,
        where: { and: [{ target: { equals: target } }, { documentId: { equals: documentId } }, { state: { equals: 'pending' } }] } })
      return { versionId: revision.id, snapshotHash: snapshotHash(snapshot), title: snapshot.title || snapshot.headline || '',
        savedAt: revision.updatedAt, generation: Number(current.publicationGeneration || 0),
        pending: pending.docs.map(({ id, generation, scheduledAt, action }) => ({ id, generation, scheduledAt, action })) }
    })
  }) },
  { path: '/news-schedule', method: 'post', handler: req => handle(req, async () => {
    const input = await req.json?.()
    if (!input || typeof input !== 'object') throw new APIError('invalid_schedule', 400, undefined, true)
    return scheduleRevision(req, input as ScheduleInput)
  }) },
  { path: '/news-schedule', method: 'delete', handler: req => handle(req, async () => {
    const input = await req.json?.()
    if (!input || typeof input !== 'object') throw new APIError('invalid_schedule', 400, undefined, true)
    return cancelSchedule(req, input as { id: string; expectedGeneration: number })
  }) },
]
