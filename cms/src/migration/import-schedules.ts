import type { Payload, PayloadRequest } from 'payload'
import { scheduleKey } from '../../../scripts/owner-news-payload/contract.mjs'
import { assertPreparationIdentity } from '../publication/authority'
import { isSha256, isUUID } from './identity'

export type SuspendedImportSchedule = {
  documentId: string; revisionId: string; scheduledAt: string; snapshotHash: string
  sourceSnapshot: Record<string, unknown>; nativeSnapshot: Record<string, unknown>; nativeSnapshotHash: string
}

/** Persist source provenance and native activation payload separately. This
 * creates no job, uses no inferred actor, and does not restore native draft C. */
export async function createSuspendedImportSchedule(payload: Payload, req: PayloadRequest,
  schedule: SuspendedImportSchedule, generation: number) {
  const identity = await assertPreparationIdentity(req)
  if (!isUUID(schedule.documentId) || !isUUID(schedule.revisionId) || !isSha256(schedule.snapshotHash) ||
    !isSha256(schedule.nativeSnapshotHash) || !Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('invalid_import_schedule')
  }
  const sourceScheduleKey = scheduleKey({ documentId: schedule.documentId, revisionId: schedule.revisionId,
    scheduledAt: schedule.scheduledAt })
  const row = await payload.create({ collection: 'news-schedules', overrideAccess: true, req, depth: 0,
    data: {
      target: 'news-articles', documentId: schedule.documentId, action: 'publish',
      // It is a legacy source revision identifier, never a native version lookup:
      // the suspended state is not executable until a later activation adapter.
      versionId: schedule.revisionId, snapshot: schedule.nativeSnapshot, snapshotHash: schedule.nativeSnapshotHash,
      scheduledAt: schedule.scheduledAt, actorUid: null, generation, state: 'suspended', jobId: null,
      sourceScheduleKey, sourceRevisionId: schedule.revisionId, importRunId: identity.runId,
      importManifestSha256: identity.manifestSha256, importAuthorityEpoch: identity.expectedEpoch,
      originalScheduledAt: schedule.scheduledAt, originalActorEvidence: 'not_recorded',
      sourceSnapshot: schedule.sourceSnapshot, sourceSnapshotHash: schedule.snapshotHash,
      nativeSnapshotHash: schedule.nativeSnapshotHash,
    },
  })
  if (row.sourceScheduleKey !== sourceScheduleKey || row.state !== 'suspended' || row.actorUid !== null || row.jobId != null) {
    throw new Error('import_schedule_persistence_mismatch')
  }
  return row
}
