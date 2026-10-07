import { snapshotHash } from '../publication/snapshot-hash.mjs';

// Original immutable history contract. metadataBasis is deliberately not folded
// into these historical hashes; bundle source-row hashes cover the added basis.
export function historyHashes(value) {
  const contentHash = snapshotHash({ title: value.originalTitle, category: value.originalCategory, body: value.originalBody, editorial: value.originalEditorial });
  return { contentHash, provenanceHash: snapshotHash({ legacyDocumentId: value.legacyDocumentId, legacyRevisionId: value.legacyRevisionId,
    originalVersion: value.originalVersion, originalCreatedAt: value.originalCreatedAt, originalActorUid: value.originalActorUid,
    originalStatus: value.originalStatus, originalPublishedAt: value.originalPublishedAt, contentHash }) };
}
