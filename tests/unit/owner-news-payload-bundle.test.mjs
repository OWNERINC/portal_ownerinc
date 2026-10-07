import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildBundle, validateBundle, validateRevisionFile, sourceFingerprint, serializeManifest, snapshotHash, canonicalJSON, sha256, convertLegacyRevision } from '../../scripts/owner-news-payload/bundle.mjs';
import { historyHashes } from '../../cms/src/news/history-hashes.mjs';
import { ids, sourceFixture, mediaFixture, everyLegacyBlock } from '../fixtures/owner-news-payload.mjs';

const throws = (fn, code) => assert.throws(fn, error => error.code === code);
test('canonical extraction keeps pre-extraction bytes and immutable history hashes', () => {
  const oldCanonical = value => Array.isArray(value) ? `[${value.map(oldCanonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, v]) => `${JSON.stringify(key)}:${oldCanonical(v)}`).join(',')}}` : JSON.stringify(value);
  const values = [{ z: null, a: ['á', { Z: true, a: false, 'é': 1, E: 0 }] }, { title: 'Synthetic', editorial: null, body: [] }, { value: -0, newline: '\n', quote: '"' }];
  for (const value of values) {
    assert.equal(canonicalJSON(value), oldCanonical(value));
    assert.equal(snapshotHash(value), createHash('sha256').update(oldCanonical(value)).digest('hex'));
  }
  assert.equal(snapshotHash({}), '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
  const input = sourceFixture();
  const { history } = convertLegacyRevision({ document: input.documents[0], revision: input.revisions[0] });
  const expectedContent = snapshotHash({ title: history.originalTitle, category: history.originalCategory, body: history.originalBody, editorial: history.originalEditorial });
  const expectedProvenance = snapshotHash({ legacyDocumentId: history.legacyDocumentId, legacyRevisionId: history.legacyRevisionId,
    originalVersion: history.originalVersion, originalCreatedAt: history.originalCreatedAt, originalActorUid: history.originalActorUid,
    originalStatus: history.originalStatus, originalPublishedAt: history.originalPublishedAt, contentHash: expectedContent });
  assert.deepEqual(historyHashes(history), { contentHash: expectedContent, provenanceHash: expectedProvenance });
  assert.deepEqual(historyHashes({ ...history, metadataBasis: { title: 'unknown' } }), historyHashes(history));
});
test('complete source graph, explicit null home/source/editorial and microseconds survive', () => {
  const input = sourceFixture(), { manifest, revisionFiles } = buildBundle(input);
  assert.equal(manifest.documents[0].id, ids.document);
  assert.equal(manifest.documents[0].source_id, null);
  assert.deepEqual(manifest.home, input.home);
  const restored = validateRevisionFile(manifest, manifest.revisions[0], revisionFiles.get(manifest.revisions[0].relativePath));
  assert.equal(restored.created_at, '2026-09-01T12:00:00.123456Z');
  assert.equal(restored.editorial, null);
  assert.equal(restored.converted.history.metadataBasis.title, 'document_snapshot');
  const draft = validateRevisionFile(manifest, manifest.revisions[1], revisionFiles.get(manifest.revisions[1].relativePath));
  assert.equal(draft.converted.history.originalPublishedAt, null);
  assert.equal(draft.converted.history.metadataBasis.publishedAt, 'unknown');
});
test('all eleven legacy block types preserve positions/options and shared UUID references', () => {
  const input = sourceFixture(); input.revisions[0].blocks = everyLegacyBlock();
  input.assets = [mediaFixture(ids.image, 'image/png'), mediaFixture(ids.pdf, 'application/pdf'), mediaFixture(ids.video, 'video/mp4')];
  input.assets[0].sharedWithContentTypes = ['academy', 'knowledge'];
  const { manifest, revisionFiles } = buildBundle(input);
  const result = validateRevisionFile(manifest, manifest.revisions[0], revisionFiles.get(manifest.revisions[0].relativePath));
  assert.deepEqual(result.blocks, input.revisions[0].blocks);
  assert.deepEqual(result.converted.content.body, input.revisions[0].blocks);
  assert.deepEqual(result.converted.mediaIds, [ids.image, ids.pdf, ids.video]);
  assert.equal(manifest.assets.length, 3);
});
test('draft may be publication-incomplete; actual publication is checked separately', () => {
  const input = sourceFixture(); assert.doesNotThrow(() => buildBundle(input));
  input.documents[0].published_revision_id = ids.draft; input.documents[0].draft_revision_id = null; input.revisions[1].status = 'published';
  throws(() => buildBundle(input), 'invalid_revision');
});
test('unknown original fields are not silently stripped, unsupported blocks report only safe codes', () => {
  const input = sourceFixture(); input.revisions[0].blocks = [{ type: 'unrecognized', secret: 'private sentinel' }];
  assert.throws(() => buildBundle(input), error => error.code === 'unsupported_block' && error.index === 0 && !JSON.stringify(error).includes('private sentinel'));
  input.revisions[0].blocks = [{ type: 'paragraph', text: 'Synthetic', extra: true }];
  throws(() => buildBundle(input), 'invalid_revision');
});
test('opaque unicode actor UID is preserved exactly in every source actor field', () => {
  const input = sourceFixture(), actorUid = '編輯者-😀-e';
  input.documents[0].created_by = actorUid; input.documents[0].updated_by = actorUid;
  input.revisions[0].created_by = actorUid; input.home.updated_by = actorUid;
  input.revisions[0].blocks = [{ type: 'image', asset_id: ids.image, alt: 'Synthetic' }];
  input.assets = [mediaFixture(ids.image, 'image/png')]; input.assets[0].uploadedBy = actorUid;
  const { manifest } = buildBundle(input);
  assert.equal(manifest.documents[0].created_by, actorUid);
  assert.equal(manifest.documents[0].updated_by, actorUid);
  assert.equal(manifest.revisions[0].created_by, actorUid);
  assert.equal(manifest.home.updated_by, actorUid);
  assert.equal(manifest.assets[0].uploadedBy, actorUid);
  assert.throws(() => buildBundle({ ...input, documents: [{ ...input.documents[0], created_by: 'x'.repeat(129) }] }), { code: 'invalid_actor' });
});
test('scheduled revision remains distinct from a later draft, actor unknown and suspended', () => {
  const input = sourceFixture(); input.documents[0].scheduled_revision_id = ids.scheduled; input.documents[0].scheduled_at = '2020-01-01T00:00:00.000001Z';
  input.revisions.push({ ...input.revisions[0], id: ids.scheduled, version: 3, status: 'scheduled' });
  const { manifest } = buildBundle(input);
  assert.equal(manifest.documents[0].draft_revision_id, ids.draft);
  assert.equal(manifest.schedules[0].actorUid, null);
  assert.equal(manifest.schedules[0].executionState, 'suspended');
  assert.deepEqual(manifest.schedules[0].exceptions, ['actor_unknown']);
  assert.equal(manifest.schedules[0].scheduledAt, input.documents[0].scheduled_at);
});
test('fingerprint is clock/path independent, repeatable but detects microsecond/content/metadata drift', () => {
  const input = sourceFixture(), first = buildBundle(input);
  input.exportedAt = '2027-01-01T00:00:00Z'; const second = buildBundle(input);
  assert.equal(first.manifest.sourceFingerprint, second.manifest.sourceFingerprint);
  assert.notEqual(sha256(serializeManifest(first.manifest)), sha256(serializeManifest(second.manifest)));
  input.revisions[0].created_at = '2026-09-01T12:00:00.123457Z';
  assert.notEqual(buildBundle(input).manifest.sourceFingerprint, first.manifest.sourceFingerprint);
  assert.equal(sourceFingerprint(first.manifest), first.manifest.sourceFingerprint);
});
test('closed graph rejects duplicate IDs/version, foreign pointers, paths and missing singleton', () => {
  const input = sourceFixture();
  throws(() => buildBundle({ ...input, home: null }), 'home_missing');
  throws(() => buildBundle({ ...input, revisions: [...input.revisions, input.revisions[0]] }), 'duplicate_identity');
  const { manifest } = buildBundle(input);
  const foreign = structuredClone(manifest); foreign.documents[0].draft_revision_id = ids.image;
  throws(() => validateBundle(foreign), 'invalid_revision_pointer');
  const path = structuredClone(manifest); path.revisions[0].relativePath = '../private.json';
  throws(() => validateBundle(path), 'invalid_relative_path');
  const unknown = structuredClone(manifest); unknown.secret = 'not allowed'; throws(() => validateBundle(unknown), 'invalid_bundle_shape');
});
test('missing stored SHA is valid; corrupt stored SHA and invalid dates are rejected', () => {
  const input = sourceFixture(); input.revisions[0].blocks.push({ type: 'pdf', asset_id: ids.pdf, title: 'Synthetic' });
  input.assets = [mediaFixture(ids.pdf, 'application/pdf')]; assert.doesNotThrow(() => buildBundle(input));
  input.assets[0].storedSha256 = '0'.repeat(64); throws(() => buildBundle(input), 'asset_hash_mismatch');
  input.assets = []; input.revisions[0].blocks.pop(); input.documents[0].created_at = '2026-02-30T00:00:00Z';
  throws(() => buildBundle(input), 'invalid_timestamp');
});
test('revision file must match exact bytes AND source-row/history hashes', () => {
  const { manifest, revisionFiles } = buildBundle(sourceFixture()), row = manifest.revisions[0], bytes = revisionFiles.get(row.relativePath);
  throws(() => validateRevisionFile(manifest, row, Buffer.concat([bytes, Buffer.from(' ')])), 'revision_file_mismatch');
  throws(() => validateRevisionFile(manifest, { ...row, contentHash: '0'.repeat(64) }, bytes), 'revision_hash_mismatch');
});
test('inventory above 300MiB remains valid when every asset fits the approved per-file limit', () => {
  const input = sourceFixture();
  for (let index = 1; index <= 7; index++) {
    const id = `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`;
    const asset = mediaFixture(id, 'application/pdf'); asset.size = 50 * 1024 * 1024;
    input.assets.push(asset); input.revisions[0].blocks.push({ type: 'pdf', asset_id: id, title: 'Synthetic' });
  }
  assert.equal(buildBundle(input).manifest.counts.assetBytes, 350 * 1024 * 1024);
});
