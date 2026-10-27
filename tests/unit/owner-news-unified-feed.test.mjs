import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareNews, encodeNewsCursor, decodeNewsCursor, mergeNewsPages } = require('../../api/owner-news/feed.js');
const { createNewsBackend } = require('../../api/owner-news/backend.js');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (source, n, published_at = '2026-10-01T00:00:00.000Z') => ({ source, id: id(n), published_at });
const navItem = (source, n, published_at = '2026-10-01T00:00:00.000Z') => ({ ...item(source, n, published_at), title: `${source} ${n}`, editorial: null, content_blocks: [] });
const scannedPage = (rows, count = rows.length, rawRows = rows.length, batches = 1) => ({ rows, count, scan: { rawRows, batches } });
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

test('composite categories sum exact normalized names and home prefers valid Payload content', async () => {
  const home = { version: 1, eyebrow: 'Payload', headline: 'Principal', summary: 'Resumo' };
  const backend = createNewsBackend({
    pool: { async query() { return { rows: [{ mode: 'legacy', epoch: 1 }] }; } },
    legacyReader: { async listPublishedAnnouncementCategories() { return { total: 3, categories: [{ name: 'A', count: 2 }, { name: 'B', count: 1 }] }; } },
    homeReader: async () => ({ version: 1, eyebrow: 'Legado', headline: 'Anterior', summary: 'Resumo' }),
    payloadClient: { async query(action) { return action === 'categories' ? { total: 4, categories: [{ name: 'A', count: 1 }, { name: 'C', count: 3 }] } : { content: home }; } },
  });
  assert.deepEqual((await backend.categories({ withCounts: true }, actor)).value, { total: 7, categories: [{ name: 'A', count: 3 }, { name: 'B', count: 1 }, { name: 'C', count: 3 }] });
  assert.deepEqual((await backend.home({}, actor)).value, { content: home });
});

test('composite categories fail closed before the strict 10,000-name response bound is exceeded', async () => {
  const categories = Array.from({ length: 10000 }, (_, index) => ({ name: `C${String(index).padStart(5, '0')}`, count: 1 }));
  const backend = createNewsBackend({
    pool: { async query() { return { rows: [{ mode: 'payload', epoch: 1 }] }; } },
    legacyReader: { async listPublishedAnnouncementCategories() { return { total: 10000, categories }; } },
    payloadClient: { async query() { return { total: 1, categories: [{ name: 'Overflow', count: 1 }] }; } },
  });
  await assert.rejects(backend.categories({ withCounts: true }, actor),
    error => error.status === 503 && error.code === 'news_unavailable');
});

test('global navigation streams only source neighbors, keeps colliding UUIDs distinct and stops after first next', async () => {
  const shared = id(7);
  const legacyRows = [
    { source: 'legacy', id: shared, title: 'Legacy twin', published_at: '2026-10-02T00:00:00.000Z' },
    { source: 'legacy', id: id(6), title: 'Legacy older', published_at: '2026-10-01T00:00:00.000Z' },
  ];
  const payloadRows = [
    { source: 'payload', id: shared, title: 'Payload twin', published_at: '2026-10-02T00:00:00.000Z', editorial: null },
    { source: 'payload', id: id(8), title: 'Older', published_at: '2026-10-01T00:00:00.000Z', editorial: null },
  ];
  const calls = { legacy: 0, payload: 0 };
  const backend = createNewsBackend({
    pool: { async query() { return { rows: [{ mode: 'payload', epoch: 1 }] }; } },
    legacyReader: {
      async getPublishedAnnouncement() { return legacyRows[0]; },
      async listPublishedAnnouncements(_pool, limit, offset, category, kind, boundary, options) {
        calls.legacy++; assert.equal(limit, 101); assert.equal(offset, 0); assert.equal(category, 'Team'); assert.equal(kind, 'article');
        assert.equal(boundary, null); assert.deepEqual(options.scan, { maxRawRows: 101000, maxBatches: 1000 });
        return scannedPage(legacyRows);
      },
    },
    payloadClient: {
      async query(action, input) {
        if (action === 'detail') { assert.deepEqual(input, { id: shared }); return payloadRows[0]; }
        calls.payload++;
        assert.equal(input.kind, 'article');
        assert.equal(input.category, 'Team');
        assert.deepEqual(input.scan, { maxRawRows: 101000, maxBatches: 1000 });
        return scannedPage(payloadRows);
      },
    },
  });
  const result = await backend.navigation({ id: shared, source: 'payload', category: 'Team' }, actor);
  assert.equal(result.readState, 'complete');
  assert.deepEqual(result.value, {
    previous: { source: 'legacy', id: shared, title: 'Legacy twin' },
    next: { source: 'legacy', id: id(6), title: 'Legacy older' },
  });
  assert.deepEqual(calls, { legacy: 1, payload: 1 }, 'each source stops once its first candidate after current is known');
});

test('global navigation returns null neighbors for an edition without starting source scans', async () => {
  let scans = 0;
  const edition = { ...navItem('payload', 10), editorial: { version: 1, kind: 'edition' } };
  const backend = createNewsBackend({
    pool: { async query() { return { rows: [{ mode: 'payload', epoch: 1 }] }; } },
    legacyReader: { async listPublishedAnnouncements() { scans++; throw new Error('must not scan'); } },
    payloadClient: { async query(action) { if (action !== 'detail') scans++; return edition; } },
  });
  assert.deepEqual(await backend.navigation({ id: edition.id, source: 'payload' }, actor),
    { value: { previous: null, next: null }, readState: 'complete' });
  assert.equal(scans, 0);
});

test('global navigation proves current/category participation, exhausts to null next, and degrades only the non-current source', async () => {
  const current = navItem('payload', 5, '2026-10-02T00:00:00.000Z');
  const previous = navItem('payload', 4, '2026-10-03T00:00:00.000Z');
  let payloadRows = [previous, current], payloadFailure = false;
  const logs = [];
  const backend = createNewsBackend({
    pool: { async query() { return { rows: [{ mode: 'payload', epoch: 1 }] }; } },
    legacyReader: { async listPublishedAnnouncements() { throw new Error('legacy unavailable'); } },
    payloadClient: { async query(action, input) {
      if (action === 'detail') return current;
      if (payloadFailure) throw new Error('payload scan unavailable');
      assert.ok(['Team', 'Other'].includes(input.category));
      return scannedPage(payloadRows);
    } },
    logger: line => logs.push(JSON.parse(line)),
  });
  const result = await backend.navigation({ id: current.id, source: 'payload', category: 'Team' }, actor, { requestId: 'nav' });
  assert.equal(result.readState, 'degraded');
  assert.deepEqual(result.value, { previous: { source: 'payload', id: previous.id, title: previous.title }, next: null });
  assert.deepEqual(logs, [{ code: 'owner_news_read_degraded', action: 'navigation', source: 'legacy', requestId: 'nav' }]);

  payloadRows = [previous];
  await assert.rejects(backend.navigation({ id: current.id, source: 'payload', category: 'Other' }, actor),
    error => error.status === 404 && error.code === 'not_found');
  payloadFailure = true;
  await assert.rejects(backend.navigation({ id: current.id, source: 'payload', category: 'Team' }, actor),
    error => error.status === 503 && error.code === 'news_unavailable');
});

test('global navigation rejects cross-page duplicate/no-progress and one accumulated sparse scan budget', async () => {
  const current = navItem('payload', 999, '2026-01-01T00:00:00.000Z');
  const firstRows = Array.from({ length: 101 }, (_, index) => navItem('payload', index + 1, '2026-12-01T00:00:00.000Z'));
  const makeBackend = responder => createNewsBackend({
    pool: { async query() { return { rows: [{ mode: 'payload', epoch: 1 }] }; } },
    legacyReader: { async listPublishedAnnouncements() { return scannedPage([]); } },
    payloadClient: { async query(action, input) { return action === 'detail' ? current : responder(input); } },
    logger() {},
  });

  let calls = 0;
  const duplicate = makeBackend(input => {
    calls++;
    if (calls === 1) return scannedPage(firstRows, null, 101, 1);
    assert.deepEqual(input.boundary, { published_at: firstRows.at(-1).published_at, source: 'payload', id: firstRows.at(-1).id });
    assert.deepEqual(input.scan, { maxRawRows: 100899, maxBatches: 999 });
    return scannedPage([{ ...firstRows[0], published_at: '2026-11-01T00:00:00.000Z' }], 1, 1, 1);
  });
  await assert.rejects(duplicate.navigation({ id: current.id, source: 'payload' }, actor), error => error.status === 503);
  assert.equal(calls, 2);

  calls = 0;
  const noProgress = makeBackend(() => {
    calls++;
    return calls === 1 ? scannedPage(firstRows, null, 101, 1)
      : scannedPage([firstRows.at(-1)], 1, 1, 1);
  });
  await assert.rejects(noProgress.navigation({ id: current.id, source: 'payload' }, actor), error => error.status === 503);

  calls = 0;
  const exactRawBudget = makeBackend(() => {
    calls++;
    return scannedPage(firstRows, null, 101000, 1);
  });
  await assert.rejects(exactRawBudget.navigation({ id: current.id, source: 'payload' }, actor), error => error.status === 503);
  assert.equal(calls, 1, 'an exhausted raw allowance refuses before a second private source call');

  calls = 0;
  const exactBatchBudget = makeBackend(() => {
    calls++;
    return scannedPage(firstRows, null, 101, 1000);
  });
  await assert.rejects(exactBatchBudget.navigation({ id: current.id, source: 'payload' }, actor), error => error.status === 503);
  assert.equal(calls, 1, 'an exhausted batch allowance refuses before a second private source call');
});

test('navigation rejects false exact-count exhaustion before current-source 404 semantics', async () => {
  const current = navItem('payload', 5);
  for (const page of [
    scannedPage([], 1, 0, 1),
    scannedPage([current], 2, 1, 1),
    scannedPage([current], 0, 1, 1),
  ]) {
    const backend = createNewsBackend({
      pool: { async query() { return { rows: [{ mode: 'payload', epoch: 1 }] }; } },
      legacyReader: { async listPublishedAnnouncements() { throw new Error('non-current unavailable'); } },
      payloadClient: { async query(action) { return action === 'detail' ? current : page; } },
      logger() {},
    });
    await assert.rejects(backend.navigation({ id: current.id, source: 'payload' }, actor),
      error => error.status === 503 && error.code === 'news_unavailable');
  }
});

const actor = { uid: 'reader', email: 'reader@example.invalid', name: null, canManageNews: false };
