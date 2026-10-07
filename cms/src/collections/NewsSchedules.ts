import { APIError, type CollectionConfig } from 'payload'
import { canManageNews } from '../auth/access'
import { isPublicationMutation } from '../publication/internal'
import { requireCmsTransaction } from '../publication/transaction'
import { assertPreparationIdentity } from '../publication/authority'
import { snapshotHash } from '../publication/document'
import { isUUID, isSha256 } from '../migration/identity'
import { scheduleKey } from '../../../scripts/owner-news-payload/contract.mjs'

export const NewsSchedules: CollectionConfig = {
  slug: 'news-schedules',
  admin: { useAsTitle: 'scheduledAt', defaultColumns: ['documentId', 'action', 'scheduledAt', 'state', 'generation'] },
  access: { read: canManageNews, create: () => false, update: () => false, delete: () => false },
  hooks: { beforeOperation: [async ({ operation, req, args }) => {
    if (!['create', 'update', 'delete'].includes(operation)) return
    if (operation === 'create' && 'data' in args) {
      const data = args.data as Record<string, unknown>
      const importAttempt = ['sourceScheduleKey', 'importRunId', 'importManifestSha256', 'importAuthorityEpoch']
        .some(field => Object.hasOwn(data, field))
      if (importAttempt) {
        await requireCmsTransaction(req.payload, req)
        const identity = await assertPreparationIdentity(req)
        if (data.importRunId !== identity.runId || data.importManifestSha256 !== identity.manifestSha256 ||
          data.importAuthorityEpoch !== identity.expectedEpoch || data.state !== 'suspended' || data.actorUid !== null ||
          data.sourceScheduleKey === undefined || data.sourceSnapshotHash === undefined || data.originalScheduledAt === undefined) {
          throw new APIError('news_schedule_import_binding_mismatch', 409, undefined, true)
        }
        return
      }
      if (data.state === 'suspended') throw new APIError('news_schedule_import_capability_required', 403, undefined, true)
    }
    if (operation === 'delete' || !isPublicationMutation(req)) throw new APIError('news_schedule_server_only', 403, undefined, true)
    await requireCmsTransaction(req.payload, req)
    if (operation === 'update' && 'data' in args && Object.keys(args.data || {}).some(key => !['state', 'jobId', 'updatedAt'].includes(key))) {
      throw new APIError('news_snapshot_immutable', 403, undefined, true)
    }
  }], beforeChange: [async ({ data, originalDoc, req, operation }) => {
    const row = { ...(originalDoc as Record<string, unknown> | undefined), ...(data as Record<string, unknown>) }
    if (operation !== 'create' && originalDoc && (originalDoc as Record<string, unknown>).importRunId != null) {
      throw new APIError('news_import_schedule_activation_controlled', 409, undefined, true)
    }
    if (row.state === 'pending' && (typeof row.actorUid !== 'string' || row.actorUid.length < 1 || row.actorUid.length > 128)) {
      throw new APIError('news_schedule_actor_required', 400, undefined, true)
    }
    const imported = row.state === 'suspended' || row.sourceScheduleKey !== undefined || row.importRunId !== undefined
    if (imported) {
      const identity = await assertPreparationIdentity(req)
      if (operation !== 'create' || row.state !== 'suspended' || row.actorUid !== null ||
        row.importRunId !== identity.runId || row.importManifestSha256 !== identity.manifestSha256 ||
        row.importAuthorityEpoch !== identity.expectedEpoch || typeof row.sourceScheduleKey !== 'string' ||
        !isUUID(row.sourceRevisionId) || !isSha256(row.sourceSnapshotHash) || !isSha256(row.snapshotHash) ||
        typeof row.originalScheduledAt !== 'string' || !Number.isFinite(Date.parse(row.originalScheduledAt)) ||
        !row.sourceSnapshot || typeof row.sourceSnapshot !== 'object' || Array.isArray(row.sourceSnapshot) ||
        snapshotHash(row.sourceSnapshot) !== row.sourceSnapshotHash || row.jobId != null ||
        row.target !== 'news-articles' || row.action !== 'publish' || row.versionId !== row.sourceRevisionId ||
        row.scheduledAt !== row.originalScheduledAt || row.snapshotHash !== row.nativeSnapshotHash ||
        scheduleKey({ documentId: row.documentId as string, revisionId: row.sourceRevisionId as string,
          scheduledAt: row.originalScheduledAt as string }) !== row.sourceScheduleKey) {
        throw new APIError('news_schedule_import_invalid', 400, undefined, true)
      }
      if (row.originalActorEvidence !== 'not_recorded') throw new APIError('news_schedule_actor_evidence_invalid', 400, undefined, true)
    } else if (row.state === 'suspended') throw new APIError('news_schedule_import_capability_required', 403, undefined, true)
    return data
  }] },
  fields: [
    { name: 'target', type: 'select', required: true, options: ['news-articles', 'news-home'] },
    { name: 'documentId', type: 'text', required: true, index: true },
    { name: 'action', type: 'select', required: true, options: ['publish', 'unpublish'] },
    { name: 'versionId', type: 'text' },
    { name: 'snapshot', type: 'json', required: true },
    { name: 'snapshotHash', type: 'text', required: true },
    { name: 'scheduledAt', type: 'date', required: true, index: true },
    { name: 'actorUid', type: 'text' },
    { name: 'generation', type: 'number', required: true, min: 1 },
    { name: 'state', type: 'select', required: true, defaultValue: 'pending', options: ['pending', 'published', 'unpublished', 'cancelled', 'rejected', 'suspended'] },
    { name: 'jobId', type: 'text', unique: true },
    { name: 'sourceScheduleKey', type: 'text', unique: true, admin: { readOnly: true } },
    { name: 'sourceRevisionId', type: 'text', admin: { readOnly: true } },
    { name: 'importRunId', type: 'text', index: true, admin: { readOnly: true } },
    { name: 'importManifestSha256', type: 'text', minLength: 64, maxLength: 64, admin: { readOnly: true } },
    { name: 'importAuthorityEpoch', type: 'number', min: 1, admin: { readOnly: true } },
    { name: 'originalScheduledAt', type: 'text', admin: { readOnly: true } },
    { name: 'originalActorEvidence', type: 'select', options: ['not_recorded'], admin: { readOnly: true } },
    { name: 'sourceSnapshot', type: 'json', admin: { readOnly: true } },
    { name: 'sourceSnapshotHash', type: 'text', minLength: 64, maxLength: 64, admin: { readOnly: true } },
    { name: 'nativeSnapshotHash', type: 'text', minLength: 64, maxLength: 64, admin: { readOnly: true } },
  ],
}
