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
  details: { target: 'news-articles' | 'news-home'; generation: number; scheduleId?: string; snapshotHash?: string; reason?: string;
    saveKind?: 'manual' | 'autosave' | 'restore'; sourceVersionId?: string; sourceRevisionToken?: string; sourceStatus?: 'draft' | 'published' }
}) {
  await requireCmsTransaction(req.payload, req)
  const { target, generation, scheduleId, snapshotHash, reason, saveKind, sourceVersionId, sourceRevisionToken, sourceStatus } = input.details
  if (saveKind && (!['manual', 'autosave', 'restore'].includes(saveKind) || input.action !== 'draft_saved') ||
    (saveKind === 'restore' ? !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(sourceVersionId || '') ||
      !/^[0-9a-f]{64}$/u.test(sourceRevisionToken || '') || !['draft', 'published'].includes(sourceStatus || '') || sourceVersionId === input.versionId
      : sourceVersionId !== undefined || sourceRevisionToken !== undefined || sourceStatus !== undefined)) {
    throw new APIError('invalid_audit_restore', 400, undefined, true)
  }
  // Whitelist, do not serialize arbitrary exception/data objects or caller-provided extra keys.
  const details = { target, generation, ...(scheduleId ? { scheduleId } : {}),
    ...(snapshotHash ? { snapshotHash } : {}), ...(reason ? { reason } : {}), ...(saveKind ? { saveKind } : {}),
    ...(saveKind === 'restore' ? { sourceVersionId, sourceRevisionToken, sourceStatus } : {}) }
  if (reason && !['invalid_content', 'invalid_asset', 'actor_revoked', 'generation_changed', 'replaced', 'withdrawn', 'cancelled'].includes(reason)) {
    throw new APIError('invalid_audit_reason', 400, undefined, true)
  }
  return publicationMutation(req, () => req.payload.create({ collection: 'news-audit', req, overrideAccess: true,
    data: { ...input, details, actorUid: workerActor(req) ? 'system' : input.actorUid,
      requestedByUid: input.actorUid } }))
}
