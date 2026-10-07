import { createHash } from 'node:crypto';
export { canonicalJSON, snapshotHash } from '../../cms/src/publication/snapshot-hash.mjs';
export { historyHashes } from '../../cms/src/news/history-hashes.mjs';

export const LIMITS = Object.freeze({ manifest: 32 * 1024 * 1024, revision: 5 * 1024 * 1024, asset: 50 * 1024 * 1024, blocks: 100 });
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HASH = /^[0-9a-f]{64}$/;
export const MIMES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm', 'video/quicktime'];
export class BundleError extends Error {
  constructor(code, { id, index } = {}) {
    super(code); this.name = 'BundleError'; this.code = code;
    // Diagnostics are deliberately a closed vocabulary: never source strings.
    if (typeof id === 'string' && UUID.test(id)) this.id = id;
    if (Number.isSafeInteger(index) && index >= 0) this.index = index;
  }
}
export const fail = (code, details) => { throw new BundleError(code, details); };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export function exact(value, names, code = 'invalid_bundle_shape') {
  if (!record(value) || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) fail(code);
}
export function uuid(value, nullable = false) {
  if (!(nullable && value === null) && !(typeof value === 'string' && UUID.test(value))) fail('invalid_uuid');
  return value;
}
export function hash(value) { if (typeof value !== 'string' || !HASH.test(value)) fail('invalid_hash'); return value; }
export function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid_integer'); return value;
}
export function actor(value) {
  // PostgreSQL user UIDs are opaque text, not constrained to ASCII. Preserve
  // exact source identity; only enforce the existing nonempty/max-length rule.
  if (value !== null && !(typeof value === 'string' && value.length > 0 && value.length <= 128)) fail('invalid_actor');
}
export function instant(value, nullable = false) {
  if (nullable && value === null) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) fail('invalid_timestamp');
  return value; // Never round-trip through Date: PostgreSQL microseconds matter.
}
export function plain(value, max, { empty = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value) ||
    /<\/?[a-z][^>]*>|<\s*(script|style|iframe|object|embed)\b|\bon[a-z]+\s*=|javascript\s*:/i.test(value)) fail('invalid_text');
}
export function relativePath(value) {
  if (typeof value !== 'string' || !/^(?:assets\/[0-9a-f-]{36}|revisions\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.json)$/.test(value)) fail('invalid_relative_path');
  return value;
}
export const revisionKey = (documentId, revisionId) => `${uuid(documentId)}/${uuid(revisionId)}`;
export const scheduleKey = schedule => `${revisionKey(schedule.documentId, schedule.revisionId)}/${instant(schedule.scheduledAt)}`;
