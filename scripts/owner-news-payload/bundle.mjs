import { createRequire } from 'node:module';
import { canonicalJSON, snapshotHash, sha256, fail, exact, record, uuid, hash, integer, actor, instant, plain, relativePath, LIMITS, MIMES, revisionKey } from './contract.mjs';
import { convertLegacyRevision } from './legacy-converter.mjs';
export * from './contract.mjs';
export { convertLegacyRevision } from './legacy-converter.mjs';
export { loadBundle } from './files.mjs';
const require = createRequire(import.meta.url);
const { normalizeHome } = require('../../api/owner-news/home.js');

export const DOCUMENT_FIELDS = ['id', 'content_type', 'source_id', 'title', 'category', 'published_revision_id', 'draft_revision_id', 'scheduled_revision_id', 'scheduled_at', 'published_at', 'created_by', 'updated_by', 'created_at', 'updated_at'];
export const REVISION_FIELDS = ['id', 'document_id', 'version', 'status', 'blocks', 'editorial', 'created_by', 'created_at'];
export const HOME_FIELDS = ['singleton', 'version', 'draft', 'published', 'updated_by', 'updated_at', 'published_at'];
export const ASSET_FIELDS = ['id', 'storageKey', 'originalName', 'mime', 'size', 'uploadedBy', 'createdAt', 'updatedAt', 'deletingAt', 'metadataHash', 'storedSha256', 'sha256', 'relativePath', 'sharedWithContentTypes'];
const revisionIndexFields = ['id', 'document_id', 'version', 'status', 'created_by', 'created_at', 'relativePath', 'byteSize', 'sha256', 'sourceRowHash', 'contentHash', 'provenanceHash', 'metadataBasis', 'mediaIds'];
const statuses = ['draft', 'published', 'scheduled', 'archived'];
const sorted = values => [...values].sort((a, b) => a.id.localeCompare(b.id, 'en'));
const same = (a, b) => canonicalJSON(a) === canonicalJSON(b);
function unique(values, key = value => value.id) {
  if (!Array.isArray(values)) fail('invalid_inventory');
  const map = new Map();
  for (const value of values) { const id = key(value); if (map.has(id)) fail('duplicate_identity'); map.set(id, value); }
  return map;
}
function source(value) {
  exact(value, ['instanceId', 'authority']);
  if (typeof value.instanceId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value.instanceId)) fail('invalid_source_identity');
  exact(value.authority, ['mode', 'epoch']);
  if (!['legacy', 'frozen', 'payload', 'payload_frozen'].includes(value.authority.mode)) fail('invalid_authority');
  integer(value.authority.epoch, 1, 2147483647);
}
function document(value) {
  exact(value, DOCUMENT_FIELDS); uuid(value.id);
  if (value.content_type !== 'announcement') fail('invalid_document_type');
  for (const key of ['source_id', 'published_revision_id', 'draft_revision_id', 'scheduled_revision_id']) uuid(value[key], true);
  plain(value.title, 200); plain(value.category, 100, { empty: true });
  for (const key of ['created_at', 'updated_at']) instant(value[key]);
  for (const key of ['scheduled_at', 'published_at']) instant(value[key], true);
  actor(value.created_by); actor(value.updated_by);
  if ((value.scheduled_at === null) !== (value.scheduled_revision_id === null)) fail('invalid_schedule_pointer');
  if (value.published_revision_id === null && value.published_at !== null) fail('invalid_published_pointer');
}
function revisionMetadata(value) {
  uuid(value.id); uuid(value.document_id); integer(value.version, 1, 2147483647);
  if (!statuses.includes(value.status)) fail('invalid_revision_status');
  actor(value.created_by); instant(value.created_at);
}
function home(value) {
  if (value === null || value === undefined) fail('home_missing');
  exact(value, HOME_FIELDS);
  if (value.singleton !== true) fail('home_missing');
  integer(value.version, 1, 2147483647); actor(value.updated_by); instant(value.updated_at); instant(value.published_at, true);
  for (const field of ['draft', 'published']) if (value[field] !== null && !normalizeHome(value[field])) fail('invalid_home');
  if (value.published === null && value.published_at !== null) fail('invalid_home');
}
function asset(value) {
  exact(value, ASSET_FIELDS); uuid(value.id); uuid(value.storageKey);
  if (typeof value.originalName !== 'string' || !value.originalName.trim() || value.originalName.length > 255 || value.originalName.includes('\0')) fail('invalid_asset_name');
  if (!MIMES.includes(value.mime)) fail('invalid_asset_mime');
  integer(value.size, 1, LIMITS.asset); actor(value.uploadedBy); instant(value.createdAt); instant(value.updatedAt);
  if (value.deletingAt !== null) fail('asset_deleting', { id: value.id });
  hash(value.metadataHash); hash(value.sha256);
  if (value.storedSha256 !== null && hash(value.storedSha256) !== value.sha256) fail('asset_hash_mismatch', { id: value.id });
  if (relativePath(value.relativePath) !== `assets/${value.id}`) fail('invalid_relative_path');
  if (!Array.isArray(value.sharedWithContentTypes) || new Set(value.sharedWithContentTypes).size !== value.sharedWithContentTypes.length ||
    value.sharedWithContentTypes.some(type => !['knowledge', 'academy', 'academy_lesson', 'benefit', 'reminder'].includes(type))) fail('invalid_shared_inventory');
}
function basis(value) {
  exact(value, ['title', 'category', 'publishedAt']);
  if (value.title !== 'document_snapshot' || value.category !== 'document_snapshot' || !['unknown', 'published_pointer'].includes(value.publishedAt)) fail('invalid_metadata_basis');
}
export function bundleCounts(bundle) {
  return { documents: bundle.documents.length, revisions: bundle.revisions.length, assets: bundle.assets.length,
    assetBytes: bundle.assets.reduce((sum, row) => sum + row.size, 0),
    publications: bundle.documents.filter(row => row.published_revision_id !== null).length,
    drafts: bundle.documents.filter(row => row.draft_revision_id !== null).length, schedules: bundle.schedules.length };
}
/** Recomputable by export and cutover. Dates/metadata come from source, not clock. */
export function sourceFingerprint(bundle) {
  return snapshotHash({ source: bundle.source, documents: sorted(bundle.documents), home: bundle.home,
    revisions: sorted(bundle.revisions).map(row => ({ id: row.id, document_id: row.document_id, sourceRowHash: row.sourceRowHash })),
    assets: sorted(bundle.assets), schedules: [...bundle.schedules].sort((a, b) => a.documentId.localeCompare(b.documentId, 'en')) });
}
export function serializeManifest(bundle) { return Buffer.from(`${canonicalJSON(bundle)}\n`, 'utf8'); }
/** Structural validation; loadBundle additionally authenticates ALL private files. */
export function validateBundle(bundle) {
  exact(bundle, ['format', 'version', 'canonicalization', 'exportedAt', 'source', 'sourceFingerprint', 'counts', 'documents', 'revisions', 'home', 'schedules', 'assets']);
  if (bundle.format !== 'owner-news-payload' || bundle.version !== 1 || bundle.canonicalization !== 'cms-snapshot-en-v1') fail('unsupported_bundle_version');
  if (serializeManifest(bundle).length > LIMITS.manifest) fail('manifest_too_large');
  source(bundle.source); instant(bundle.exportedAt); hash(bundle.sourceFingerprint);
  const docs = unique(bundle.documents), revisions = unique(bundle.revisions), assets = unique(bundle.assets);
  unique(bundle.documents.filter(row => row.source_id !== null), row => row.source_id);
  unique(bundle.revisions, row => revisionKey(row.document_id, row.id));
  unique(bundle.revisions, row => `${row.document_id}/${row.version}`);
  for (const row of docs.values()) document(row);
  for (const row of assets.values()) asset(row);
  unique(bundle.assets, row => row.storageKey);
  const refs = new Set();
  for (const row of revisions.values()) {
    exact(row, revisionIndexFields); revisionMetadata(row); basis(row.metadataBasis);
    if (!docs.has(row.document_id)) fail('revision_document_mismatch', { id: row.id });
    for (const key of ['sha256', 'sourceRowHash', 'contentHash', 'provenanceHash']) hash(row[key]);
    integer(row.byteSize, 1, LIMITS.revision);
    if (relativePath(row.relativePath) !== `revisions/${revisionKey(row.document_id, row.id)}.json`) fail('invalid_relative_path');
    if (!Array.isArray(row.mediaIds) || new Set(row.mediaIds).size !== row.mediaIds.length) fail('invalid_media_reference');
    for (const id of row.mediaIds) { uuid(id); if (!assets.has(id)) fail('invalid_media_reference', { id: row.id }); refs.add(id); }
  }
  for (const doc of docs.values()) for (const [field, status] of [['published_revision_id', 'published'], ['draft_revision_id', 'draft'], ['scheduled_revision_id', 'scheduled']]) {
    if (doc[field] === null) continue;
    const rev = revisions.get(doc[field]);
    if (!rev || rev.document_id !== doc.id || rev.status !== status) fail('invalid_revision_pointer', { id: doc.id });
  }
  if (refs.size !== assets.size) fail('unreferenced_asset');
  home(bundle.home);
  const schedules = unique(bundle.schedules, row => row.documentId);
  for (const row of schedules.values()) {
    exact(row, ['documentId', 'revisionId', 'scheduledAt', 'operation', 'actorUid', 'actorEvidence', 'snapshotHash', 'executionState', 'exceptions']);
    uuid(row.documentId); uuid(row.revisionId); instant(row.scheduledAt); hash(row.snapshotHash);
    const doc = docs.get(row.documentId), rev = revisions.get(row.revisionId);
    if (!doc || !rev || doc.scheduled_revision_id !== row.revisionId || doc.scheduled_at !== row.scheduledAt || row.operation !== 'publish' ||
      row.actorUid !== null || row.actorEvidence !== 'not_recorded' || row.executionState !== 'suspended' ||
      !same(row.exceptions, ['actor_unknown']) || row.snapshotHash !== rev.contentHash) fail('invalid_schedule_snapshot');
  }
  if (schedules.size !== bundle.documents.filter(doc => doc.scheduled_revision_id !== null).length) fail('invalid_schedule_inventory');
  const counts = bundleCounts(bundle);
  for (const value of Object.values(counts)) integer(value);
  if (!same(bundle.counts, counts)) fail('invalid_counts');
  if (sourceFingerprint(bundle) !== bundle.sourceFingerprint) fail('source_fingerprint_mismatch');
  return bundle;
}
export function validateRevisionFile(bundle, entry, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== entry.byteSize || bytes.length > LIMITS.revision || sha256(bytes) !== entry.sha256) fail('revision_file_mismatch', { id: entry.id });
  let content;
  try { content = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('invalid_revision_json', { id: entry.id }); }
  exact(content, ['blocks', 'editorial']);
  const row = { ...Object.fromEntries(['id', 'document_id', 'version', 'status', 'created_by', 'created_at'].map(key => [key, entry[key]])), ...content };
  const converted = convertLegacyRevision({ document: bundle.documents.find(doc => doc.id === entry.document_id), revision: row, assets: new Map(bundle.assets.map(asset => [asset.id, asset])) });
  if (snapshotHash(row) !== entry.sourceRowHash || converted.history.contentHash !== entry.contentHash || converted.history.provenanceHash !== entry.provenanceHash ||
    !same(converted.history.metadataBasis, entry.metadataBasis) || !same(converted.mediaIds, entry.mediaIds)) fail('revision_hash_mismatch', { id: entry.id });
  return { ...row, converted };
}
export function buildBundle({ source: origin, documents, revisions, home: opening, assets, exportedAt }) {
  source(origin); home(opening);
  const docs = unique(documents), media = unique(assets);
  for (const doc of docs.values()) document(doc);
  for (const row of media.values()) asset(row);
  const revisionFiles = new Map();
  const entries = sorted(revisions).map(row => {
    exact(row, REVISION_FIELDS); revisionMetadata(row);
    const doc = docs.get(row.document_id);
    if (!doc) fail('revision_document_mismatch', { id: row.id });
    const result = convertLegacyRevision({ document: doc, revision: row, assets: media });
    const file = Buffer.from(canonicalJSON({ blocks: row.blocks, editorial: row.editorial }));
    if (file.length > LIMITS.revision) fail('revision_too_large', { id: row.id });
    const relativePath = `revisions/${revisionKey(row.document_id, row.id)}.json`;
    revisionFiles.set(relativePath, file);
    return { ...Object.fromEntries(['id', 'document_id', 'version', 'status', 'created_by', 'created_at'].map(key => [key, row[key]])),
      relativePath, byteSize: file.length, sha256: sha256(file), sourceRowHash: snapshotHash(row),
      contentHash: result.history.contentHash, provenanceHash: result.history.provenanceHash, metadataBasis: result.history.metadataBasis, mediaIds: result.mediaIds };
  });
  const schedules = sorted(documents).filter(doc => doc.scheduled_revision_id !== null).map(doc => ({
    documentId: doc.id, revisionId: doc.scheduled_revision_id, scheduledAt: doc.scheduled_at, operation: 'publish',
    actorUid: null, actorEvidence: 'not_recorded', snapshotHash: entries.find(row => row.id === doc.scheduled_revision_id)?.contentHash,
    executionState: 'suspended', exceptions: ['actor_unknown'],
  }));
  const manifest = { format: 'owner-news-payload', version: 1, canonicalization: 'cms-snapshot-en-v1', exportedAt,
    source: origin, documents: sorted(documents), revisions: entries, home: opening, assets: sorted(assets), schedules };
  manifest.counts = bundleCounts(manifest); manifest.sourceFingerprint = sourceFingerprint(manifest);
  validateBundle(manifest);
  return { manifest, revisionFiles };
}
