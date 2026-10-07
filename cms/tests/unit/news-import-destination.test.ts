import assert from 'node:assert/strict'
import test from 'node:test'
import type { Payload, PayloadRequest } from 'payload'
import { scheduleKey, snapshotHash } from '../../../scripts/owner-news-payload/bundle.mjs'
import { readImportDestination } from '../../src/migration/destination'
import { reconcileImportItems, type ExpectedImportItem } from '../../src/migration/reconcile'

const documentId = '11111111-1111-4111-8111-111111111111'
const revisionId = '22222222-2222-4222-8222-222222222222'
const scheduledAt = '2026-11-06T12:00:00.000Z'
const sourceSnapshot = { title: 'Legacy title', category: 'news', body: [{ type: 'paragraph', text: 'Legacy body' }], editorial: null }
const nativeSnapshot = { title: 'Legacy title', category: 'news', body: [{ blockType: 'paragraph', text: 'Legacy body' }], editorial: null }
const sourceSnapshotHash = snapshotHash(sourceSnapshot)
const nativeSnapshotHash = snapshotHash(nativeSnapshot)
const sourceScheduleKey = scheduleKey({ documentId, revisionId, scheduledAt })
const sourceFields = { documentId, revisionId, scheduledAt, operation: 'publish', actorUid: null,
  actorEvidence: 'not_recorded', snapshotHash: sourceSnapshotHash, executionState: 'suspended',
  exceptions: ['actor_unknown'], snapshot: sourceSnapshot }
const expected: ExpectedImportItem = { entityKind: 'schedule', sourceId: sourceScheduleKey,
  expectedHash: snapshotHash(sourceFields), destinationId: null, sourceSnapshotHash, nativeSnapshotHash }

function persistedSchedule(snapshot = nativeSnapshot, storedNativeHash = nativeSnapshotHash) {
  return { id: '33333333-3333-4333-8333-333333333333', target: 'news-articles', documentId, action: 'publish',
    versionId: revisionId, snapshot, snapshotHash: storedNativeHash, nativeSnapshotHash: storedNativeHash,
    scheduledAt, actorUid: null, generation: 1, state: 'suspended', jobId: null,
    sourceScheduleKey, sourceRevisionId: revisionId, originalScheduledAt: scheduledAt,
    originalActorEvidence: 'not_recorded', sourceSnapshot, sourceSnapshotHash }
}

async function observe(row: Record<string, unknown>) {
  const payload = { find: async (args: Record<string, unknown>) => {
    assert.equal(args.collection, 'news-schedules')
    return { docs: [row] }
  } } as unknown as Payload
  const result = await readImportDestination(payload, {} as PayloadRequest, [expected], new Map())
  assert.equal(result.length, 1)
  return result[0]!
}

test('schedule reconciliation rejects native payload edits while retaining valid legacy provenance', async () => {
  const observed = await observe(persistedSchedule())
  assert.equal(observed.sourceSnapshotHashMatches, true)
  assert.equal(observed.nativeSnapshotHashMatches, true)
  assert.equal(observed.contentHash, expected.expectedHash)
  assert.equal(observed.identityMatches, true)
  assert.equal(reconcileImportItems([expected], [observed]).ok, true)
})

test('schedule reconciliation rejects changed native payload when original source snapshot is unchanged', async () => {
  const row = persistedSchedule({ ...nativeSnapshot, title: 'Tampered native title' })
  const observed = await observe(row)
  assert.equal(observed.sourceSnapshotHashMatches, true)
  assert.equal(observed.nativeSnapshotHashMatches, false)
  assert.equal(observed.contentHash, expected.expectedHash)
  const result = reconcileImportItems([expected], [observed])
  assert.equal(result.ok, false)
  assert.equal(result.conflicts[0].code, 'native_snapshot_changed')
})

test('schedule reconciliation rejects a changed stored native hash even when source provenance is intact', async () => {
  const observed = await observe(persistedSchedule(nativeSnapshot, 'f'.repeat(64)))
  assert.equal(observed.sourceSnapshotHashMatches, true)
  assert.equal(observed.nativeSnapshotHashMatches, false)
  assert.equal(reconcileImportItems([expected], [observed]).conflicts[0].code, 'native_snapshot_changed')
})

test('schedule reconciliation rejects a self-consistent changed native payload and hash against plan expectation', async () => {
  const changedNative = { ...nativeSnapshot, title: 'Consistently altered title' }
  const changedHash = snapshotHash(changedNative)
  const observed = await observe(persistedSchedule(changedNative, changedHash))
  assert.equal(snapshotHash(changedNative), changedHash)
  assert.equal(observed.sourceSnapshotHashMatches, true)
  assert.equal(observed.nativeSnapshotHashMatches, false)
  assert.equal(reconcileImportItems([expected], [observed]).conflicts[0].code, 'native_snapshot_changed')
})

test('schedule reconciliation rejects a changed legacy payload and stored source hash independently', async () => {
  const changedSource = { ...sourceSnapshot, title: 'Tampered legacy title' }
  const changedSourceHash = snapshotHash(changedSource)
  const observed = await observe({ ...persistedSchedule(), sourceSnapshot: changedSource, sourceSnapshotHash: changedSourceHash })
  assert.equal(observed.sourceSnapshotHashMatches, false)
  assert.equal(observed.nativeSnapshotHashMatches, true)
  assert.equal(reconcileImportItems([expected], [observed]).conflicts[0].code, 'source_snapshot_changed')
})
