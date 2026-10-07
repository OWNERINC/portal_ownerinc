import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBundle, scheduleKey } from '../../../scripts/owner-news-payload/bundle.mjs'
import { sourceFixture, ids, timestamp } from '../../../tests/fixtures/owner-news-payload.mjs'
import { planNewsImport, summarizeImportPlan } from '../../src/migration/plan'

test('producer contract plans historical archive, published A and incomplete draft B separately', () => {
  const bundle = buildBundle(sourceFixture())
  const plan = planNewsImport(bundle, [], new Date('2026-10-06T12:00:00Z'))
  assert.equal(plan.counts.create, 4) // 2 history, document, home
  assert.equal(plan.documents[0].published!.body[0].blockType, 'paragraph')
  assert.deepEqual(plan.documents[0].draft!.body, [])
  assert.equal(plan.documents[0].draft!.editorial!.summary, '')
  assert.equal(plan.documents[0].history[0].originalCreatedAt, timestamp)
  assert.equal(plan.documents[0].history[0].metadataBasis.title, 'document_snapshot')
  assert.equal(plan.documents[0].history[1].originalPublishedAt, null)
  assert.deepEqual(plan.home, { published: null, draft: null, publishedAt: null })
  assert.equal(plan.contentReadyForSeal, false)
  assert.ok(plan.exceptions.some(item => item.code === 'native_timestamp_precision'))
})

test('snapshot C never replaces draft B or published A; missing actor/expired remain explicit', () => {
  const source = sourceFixture()
  const document = source.documents[0] as unknown as Record<string, unknown>
  document.scheduled_revision_id = ids.scheduled
  document.scheduled_at = timestamp
  const revisions = source.revisions as unknown as Array<Record<string, unknown>>
  revisions.push({ ...revisions[0], id: ids.scheduled, version: 3, status: 'scheduled',
    blocks: [{ type: 'paragraph', text: 'Snapshot C.' }] })
  const plan = planNewsImport(buildBundle(source), [], new Date('2026-10-06T12:00:00Z'))
  assert.equal(plan.documents[0].published!.body[0].text, 'Synthetic body.')
  assert.deepEqual(plan.documents[0].draft!.body, [])
  assert.equal(plan.documents[0].snapshot!.body[0].text, 'Snapshot C.')
  assert.equal(plan.schedules[0].executionState, 'suspended')
  assert.equal(plan.schedules[0].actorUid, null)
  assert.equal(plan.schedules[0].scheduledAt, timestamp)
  assert.equal(plan.schedules[0].sourceId, scheduleKey(source.documents.map(doc => ({ documentId: doc.id, revisionId: doc.scheduled_revision_id, scheduledAt: doc.scheduled_at }))[0]))
  assert.notEqual(plan.schedules[0].nativeSnapshotHash, plan.schedules[0].snapshotHash)
  const scheduleItem = plan.expectedItems.find(item => item.entityKind === 'schedule')!
  assert.equal(scheduleItem.sourceSnapshotHash, plan.schedules[0].snapshotHash)
  assert.equal(scheduleItem.nativeSnapshotHash, plan.schedules[0].nativeSnapshotHash)
  assert.ok(plan.exceptions.some(item => item.code === 'actor_unknown'))
  assert.ok(plan.exceptions.some(item => item.code === 'schedule_expired'))
})

test('exact expected observations reconcile but subsequent editing conflicts regardless of counts', () => {
  const source = sourceFixture(); source.documents[0].published_at = '2026-09-01T12:00:00.123000Z'
  const bundle = buildBundle(source)
  const prepared = planNewsImport(bundle, [])
  const observed = prepared.expectedItems.map(item => ({ entityKind: item.entityKind, sourceId: item.sourceId,
    contentHash: item.expectedHash, destinationId: item.destinationId ?? 'native-history-id', identityMatches: true }))
  assert.equal(planNewsImport(bundle, observed).contentReadyForSeal, true)
  observed.find(item => item.entityKind === 'document')!.contentHash = 'b'.repeat(64)
  const changed = planNewsImport(bundle, observed)
  assert.equal(changed.contentReadyForSeal, false)
  assert.equal(changed.conflicts[0].code, 'content_changed')
  assert.equal(changed.counts.expected, changed.counts.observed)
})

test('report summary excludes private body/provenance/paths and does not claim cutover', () => {
  const plan = planNewsImport(buildBundle(sourceFixture()), [])
  const summary = summarizeImportPlan(plan)
  const text = JSON.stringify(summary)
  for (const privateValue of ['Synthetic body.', 'Synthetic document', 'originalActorUid', 'originalBody', 'relativePath', 'cutoverEligible']) {
    assert.equal(text.includes(privateValue), false)
  }
  assert.equal(summary.phase, 'planned')
  assert.equal(summary.counts.create, 4)
})

test('revision bytes and complete inventory are validated by producer before planning', () => {
  const bundle = buildBundle(sourceFixture())
  const incomplete = new Map(bundle.revisionFiles); incomplete.delete(incomplete.keys().next().value!)
  assert.throws(() => planNewsImport({ ...bundle, revisionFiles: incomplete }, []), /import_revision_inventory_mismatch/)
  const damaged = new Map(bundle.revisionFiles)
  damaged.set(damaged.keys().next().value!, Buffer.from('{}'))
  assert.throws(() => planNewsImport({ ...bundle, revisionFiles: damaged }, []), /revision_file_mismatch/)
  assert.throws(() => planNewsImport({ ...bundle, manifest: { ...bundle.manifest, home: null } }, []), /home_missing/)
})
