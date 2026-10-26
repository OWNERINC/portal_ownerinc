import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareNews, encodeNewsCursor, decodeNewsCursor, mergeNewsPages } = require('../../api/owner-news/feed.js');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (source, n, published_at = '2026-10-01T00:00:00.000Z') => ({ source, id: id(n), published_at });
const filters = { category: 'Updates', kind: 'article' };

test('canonical comparator sorts date descending, null last, then source and lowercase UUID ascending', () => {
  const rows = [item('payload', 2), item('legacy', 2), item('payload', 1), item('legacy', 1), item('legacy', 3, null), item('payload', 3, '2026-10-02T00:00:00.000Z')];
  assert.deepEqual([...rows].sort(compareNews), [rows[5], rows[3], rows[1], rows[2], rows[0], rows[4]]);
});

test('same UUID in legacy and Payload remains two source-aware items', () => {
  const result = mergeNewsPages({ legacy: [item('legacy', 1)], payload: [item('payload', 1)], limit: 2, filters });
  assert.deepEqual(result.rows.map(row => [row.source, row.id]), [['legacy', id(1)], ['payload', id(1)]]);
  assert.equal(result.nextCursor, null);
});

test('cursor round-trips an exact versioned boundary bound to normalized filters', () => {
  const cursor = encodeNewsCursor(item('payload', 7, null), filters);
  assert.deepEqual(decodeNewsCursor(cursor, filters), item('payload', 7, null));
  assert.deepEqual(decodeNewsCursor(encodeNewsCursor(item('legacy', 2), {}), {}), item('legacy', 2));
  assert.throws(() => decodeNewsCursor(cursor, { category: 'Other', kind: 'article' }), /invalid_request/);
  assert.throws(() => decodeNewsCursor(cursor, { category: 'Updates', kind: 'edition' }), /invalid_request/);
});

test('cursor rejects invalid encoding, size, version, exact shape, date, source, UUID and filters', () => {
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const base = { v: 1, published_at: '2026-10-01T00:00:00.000Z', source: 'legacy', id: id(1), category: null, kind: null };
  for (const cursor of [
    '*not-base64url*', 'a'.repeat(1025), encoded({ ...base, v: 2 }), encoded({ ...base, extra: true }),
    encoded({ ...base, published_at: 'not-a-date' }), encoded({ ...base, source: 'other' }),
    encoded({ ...base, id: 'not-a-uuid' }), encoded({ ...base, category: 1 }), encoded({ ...base, kind: 'other' }),
  ]) assert.throws(() => decodeNewsCursor(cursor, {}), /invalid_request/);
});

test('boundary selects only later items and a new earlier publication does not shift the next page', () => {
  const original = [item('legacy', 1, '2026-10-03T00:00:00.000Z'), item('payload', 2, '2026-10-02T00:00:00.000Z'), item('legacy', 3, '2026-10-01T00:00:00.000Z')];
  const first = mergeNewsPages({ legacy: original.filter(row => row.source === 'legacy'), payload: original.filter(row => row.source === 'payload'), limit: 2, filters: {} });
  const boundary = decodeNewsCursor(first.nextCursor, {});
  const inserted = item('payload', 9, '2026-10-04T00:00:00.000Z');
  const next = mergeNewsPages({ legacy: original.filter(row => row.source === 'legacy'), payload: [inserted, ...original.filter(row => row.source === 'payload')], limit: 2, boundary, filters: {} });
  assert.deepEqual(next.rows, [original[2]]);
});

test('limit plus one controls nextCursor and duplicate identities within one source fail closed', () => {
  const page = mergeNewsPages({ legacy: [item('legacy', 1), item('legacy', 3, null)], payload: [item('payload', 2)], limit: 2, filters });
  assert.deepEqual(page.rows.map(row => row.id), [id(1), id(2)]);
  assert.deepEqual(decodeNewsCursor(page.nextCursor, filters), page.rows[1]);
  const final = mergeNewsPages({ legacy: [item('legacy', 1)], payload: [item('payload', 2)], limit: 2, filters });
  assert.equal(final.nextCursor, null);
  assert.throws(() => mergeNewsPages({ legacy: [item('legacy', 1), item('legacy', 1)], payload: [], limit: 2, filters: {} }), /invalid_request/);
});

test('101 source rows preserve continuation at the public maximum page size of 100', () => {
  const sourceRows = Array.from({ length: 101 }, (_, index) => item('legacy', index + 1));
  const page = mergeNewsPages({ legacy: sourceRows, payload: [], limit: 100, filters: {} });
  assert.equal(page.rows.length, 100);
  assert.deepEqual(decodeNewsCursor(page.nextCursor, {}), page.rows[99]);
  assert.equal(page.rows.at(-1).id, id(100));
});
