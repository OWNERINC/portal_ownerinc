import { createHash } from 'node:crypto';

// Byte-compatible extraction of the original publication/document.ts algorithm.
// Changing collation or normalizing values changes existing snapshot/history hashes.
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, v]) => `${JSON.stringify(key)}:${canonicalJSON(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export const snapshotHash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
