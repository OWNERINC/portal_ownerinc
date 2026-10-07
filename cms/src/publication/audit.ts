import { APIError, type PayloadRequest } from 'payload'
import type { PortalRuntimeUser } from '../auth/access'
import { requireCmsTransaction } from './transaction'
import { publicationMutation, workerActor } from './internal'

export type AuditAction = 'draft_saved' | 'published' | 'unpublished' | 'scheduled' | 'schedule_cancelled' | 'schedule_rejected'
export function publicationActor(req: PayloadRequest): string {
  const uid = workerActor(req) || (req.user as PortalRuntimeUser | null)?.portalActor?.uid
  if (!uid) throw new APIError('news_audit_actor_required', 403, undefined, true)
  return uid
}
export async function appendNewsAudit(req: PayloadRequest, input: {
  action: AuditAction; documentId: string; versionId?: string | null; actorUid: string
  details: { target: 'news-articles' | 'news-home'; generation: number; scheduleId?: string; snapshotHash?: string; reason?: string }
}) {
  await requireCmsTransaction(req.payload, req)
  const { target, generation, scheduleId, snapshotHash, reason } = input.details
  // Whitelist, do not serialize arbitrary exception/data objects or caller-provided extra keys.
  const details = { target, generation, ...(scheduleId ? { scheduleId } : {}),
    ...(snapshotHash ? { snapshotHash } : {}), ...(reason ? { reason } : {}) }
  if (reason && !['invalid_content', 'invalid_asset', 'actor_revoked', 'generation_changed', 'replaced', 'withdrawn', 'cancelled'].includes(reason)) {
    throw new APIError('invalid_audit_reason', 400, undefined, true)
  }
  return publicationMutation(req, () => req.payload.create({ collection: 'news-audit', req, overrideAccess: true,
    data: { ...input, details, actorUid: workerActor(req) ? 'system' : input.actorUid,
      requestedByUid: input.actorUid } }))
}
