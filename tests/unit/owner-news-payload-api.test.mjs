import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { Module } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const require = createRequire(import.meta.url);
const { createNewsBackend } = require('../../api/owner-news/backend.js');
const actor = { uid: 'reader', email: 'reader@example.invalid', name: null, canManageNews: false };
const { createPayloadNewsClient } = require('../../api/owner-news/payload-client.js');
const { payloadRuntimeState } = require('../../api/owner-news/payload-client.js');
const { readNewsDTO, readNewsPage, readResult, validPublicInput } = require('../../api/owner-news/payload-dto.js');
const { decodeNewsCursor } = require('../../api/owner-news/feed.js');
const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
const express = apiRequire('express'), supertest = apiRequire('supertest');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const secret = 'synthetic-task7-service-secret-not-real';
const dto = (n = 1) => ({ source: 'payload', id: id(n), title: `Article ${n}`, category: '', published_at: '2026-10-01T00:00:00.000Z', editorial: null,
  content_version: 2, asset_scope: 'owner-news', content_blocks: [{ type: 'paragraph', text: 'Published A' }], read_time_minutes: 1 });
const clientFor = (fetchImpl, options = {}) => createPayloadNewsClient({ baseURL: 'http://cms.invalid', secret, fetchImpl, ...options });
function appFor(fetchImpl, mode = 'payload', overrides = {}) {
  const calls = [], pool = { async query(sql) { calls.push(sql); return { rows: [{ mode, epoch: 1 }] }; } };
  const legacyDto = { ...dto(), source: 'legacy', asset_scope: 'legacy' };
  const legacyReader = overrides.legacyReader || {
    async listPublishedAnnouncements(_pool, limit, _offset, _category, kind, _boundary, options = {}) {
      const page = { rows: kind === 'article' && limit === 101 ? [legacyDto] : [], count: kind === 'article' && limit === 101 ? 1 : 0 };
      return options.scan ? { ...page, scan: { rawRows: page.rows.length, batches: 1 } } : page;
    },
    async listPublishedAnnouncementCategories(_pool, input) { return input.withCounts ? { total: 0, categories: [] } : []; },
    async getPublishedAnnouncement() { return legacyDto; },
  };
  const filename = fileURLToPath(new URL('../../api/routes/announcements.js', import.meta.url));
  const mod = new Module(filename), local = createRequire(filename);
  const authenticate = (req, res, next) => {
    if (!['Bearer reader', 'Bearer editor'].includes(req.get('authorization'))) return res.sendStatus(401);
    req.id = 'test-request'; req.user = { uid: 'verified-user', email: 'verified@example.invalid', name: null, role: req.get('authorization') === 'Bearer editor' ? 'admin' : 'employee', permissions: { manageKnowledge: req.get('authorization') === 'Bearer editor' } }; next();
  };
  mod.require = name => name === '../db' ? pool : name === '../middleware/auth' ? { authMiddleware: authenticate } : name === './owner-news-polls' ? express.Router().get('/', (_req, res) => res.json({ polls: true })) : local(name);
  mod._compile(readFileSync(filename, 'utf8'), filename);
  const app = express();
  const backendOptions = { pool, legacyReader, homeReader: async () => null, logger: overrides.logger };
  if (!overrides.inactivePayload) backendOptions.payloadClient = clientFor(fetchImpl);
  app.use('/api/announcements', mod.exports.createAnnouncementsRouter({ backend: createNewsBackend(backendOptions), authenticate }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.code || 'safe' }));
  return { app, api: supertest(app), calls };
}
test('composite reads coexist in every authority mode and one-source failures degrade without changing authority', async () => {
  for (const mode of ['legacy', 'payload']) {
    const calls = [];
    const pool = { async query(sql) { calls.push(sql); return { rows: [{ mode, epoch: 2 }] }; } };
    const backend = createNewsBackend({ pool,
      legacyReader: { async listPublishedAnnouncements() { return { rows: [{ ...dto(1), source: 'legacy', asset_scope: 'legacy' }], count: 1 }; } },
      payloadClient: { async query(action) { assert.equal(action, 'list'); return { rows: [dto(2)], count: 1 }; } },
    });
    const result = await backend.list({ limit: 24, offset: 0 }, actor, { requestId: 'dual-read' });
    assert.equal(result.readState, 'complete');
    assert.equal(result.value.count, 2, 'complete composition retains the exact total from both sources');
    assert.deepEqual(result.value.rows.map(row => row.source), ['legacy', 'payload']);
    assert.equal(calls.filter(sql => sql.includes('owner_news_authority')).length, 1);
    assert.equal(calls.some(sql => /UPDATE|INSERT/u.test(sql)), false, 'reads never transition authority or release a writer');
  }

  const logs = [];
  const degraded = createNewsBackend({
    pool: { async query() { return { rows: [{ mode: 'payload', epoch: 3 }] }; } },
    legacyReader: { async listPublishedAnnouncements() { return { rows: [{ ...dto(3), source: 'legacy', asset_scope: 'legacy' }], count: 1 }; } },
    payloadClient: { async query() { throw new Error('private storage path'); } },
    logger: line => logs.push(JSON.parse(line)),
  });
  const first = await degraded.list({ limit: 1, offset: 0 }, actor, { requestId: 'safe-id' });
  assert.equal(first.readState, 'degraded');
  assert.equal(first.value.count, null, 'a partial source count is not an exact composite total');
  assert.equal(first.value.nextCursor, null);
  assert.deepEqual(logs, [{ code: 'owner_news_read_degraded', action: 'list', source: 'payload', requestId: 'safe-id' }]);

  const payloadOnly = createNewsBackend({
    pool: { async query() { return { rows: [{ mode: 'legacy', epoch: 4 }] }; } },
    legacyReader: { async listPublishedAnnouncements() { throw new Error('private database detail'); } },
    payloadClient: { async query() { return { rows: [dto(4)], count: 1 }; } },
    logger() {},
  });
  const second = await payloadOnly.list({ limit: 1, offset: 0 }, actor);
  assert.equal(second.readState, 'degraded');
  assert.equal(second.value.count, null, 'a partial source count is not an exact composite total');
  assert.deepEqual(second.value.rows.map(row => row.source), ['payload']);
  assert.equal(second.value.nextCursor, null);
});

test('cursor degradation requires restart, double failure is unavailable, and unreadable authority touches no source', async () => {
  const filters = {}, cursor = require('../../api/owner-news/feed.js').encodeNewsCursor({ source: 'legacy', id: id(1), published_at: null }, filters);
  const base = { pool: { async query() { return { rows: [{ mode: 'payload', epoch: 1 }] }; } },
    legacyReader: { async listPublishedAnnouncements() { return { rows: [], count: 0 }; } } };
  const partial = createNewsBackend({ ...base, payloadClient: { async query() { throw new Error('offline'); } }, logger() {} });
  await assert.rejects(partial.list({ limit: 10, offset: 0, boundary: require('../../api/owner-news/feed.js').decodeNewsCursor(cursor, filters) }, actor), e => e.status === 503 && e.code === 'news_page_restart_required');
  await assert.rejects(partial.list({ limit: 10, offset: 1 }, actor), e => e.status === 400 && e.code === 'invalid_request');
  await assert.rejects(partial.list({ limit: 10, offset: 1, boundary: require('../../api/owner-news/feed.js').decodeNewsCursor(cursor, filters) }, actor), e => e.status === 400 && e.code === 'invalid_request');
  const double = createNewsBackend({ ...base, legacyReader: { async listPublishedAnnouncements() { throw new Error('db'); } }, payloadClient: { async query() { throw new Error('cms'); } }, logger() {} });
  await assert.rejects(double.list({ limit: 10, offset: 0 }, actor), e => e.status === 503 && e.code === 'news_unavailable');
  let touched = 0;
  const closed = createNewsBackend({ pool: { async query() { throw new Error('authority'); } }, legacyReader: { async listPublishedAnnouncements() { touched++; } }, payloadClient: { async query() { touched++; } } });
  await assert.rejects(closed.list({ limit: 10, offset: 0 }, actor), e => e.status === 503);
  assert.equal(touched, 0);
});

test('detail and asset reads are source-directed and preserve 404/403 without fallback', async () => {
  const calls = [];
  const backend = createNewsBackend({
    pool: { async query() { return { rows: [{ mode: 'payload', epoch: 1 }] }; } },
    legacyReader: { async getPublishedAnnouncement() { calls.push('legacy-detail'); return null; } },
    payloadClient: { async query() { calls.push('payload-detail'); throw Object.assign(new Error('not_found'), { status: 404 }); }, async asset() { calls.push('payload-asset'); throw Object.assign(new Error('forbidden'), { status: 403 }); } },
    legacyAssetReader: async () => { calls.push('legacy-asset'); return {}; },
  });
  await assert.rejects(backend.detail({ id: id(1), source: 'payload' }, actor), e => e.status === 404);
  assert.deepEqual(calls, ['payload-detail']);
  await assert.rejects(backend.asset({ id: id(1), preview: false, range: null, source: 'payload' }, actor), e => e.status === 403);
  assert.deepEqual(calls, ['payload-detail', 'payload-asset']);
});
test('authority is refreshed each operation; missing/invalid control fails closed', async () => {
  let mode = 'payload', reads = 0;
  const backend = createNewsBackend({ pool: { async query() { return { rows: mode === 'missing' ? [] : [{ mode, epoch: 1 }] }; } }, payloadClient: { async query() { reads++; return { content: null }; } } });
  for (const value of ['payload', 'payload_frozen']) { mode = value; await backend.home({}, actor); }
  mode = 'missing'; await assert.rejects(backend.home({}, actor), e => e.status === 503);
  assert.equal(reads, 2);
});
test('legacy dependency failure returns intentionally inactive Payload as degraded empty', async () => {
  const pool = { async query(sql) {
    if (sql.includes('owner_news_authority')) return { rows: [{ mode: 'legacy', epoch: 1 }] };
    throw new Error('postgres private detail');
  } };
  const result = await createNewsBackend({ pool, logger() {} }).home({}, actor);
  assert.deepEqual(result, { value: { content: null }, readState: 'degraded' });
});
test('Payload runtime configuration distinguishes intentional inactivity, partial config and fail-closed modes', () => {
  assert.equal(payloadRuntimeState({ mode: 'legacy' }), 'inactive');
  assert.equal(payloadRuntimeState({ mode: 'frozen', baseURL: '', secret: '' }), 'inactive');
  assert.equal(payloadRuntimeState({ mode: 'legacy', baseURL: 'http://cms.invalid' }), 'unavailable');
  assert.equal(payloadRuntimeState({ mode: 'payload' }), 'unavailable');
  assert.equal(payloadRuntimeState({ mode: 'payload_frozen', baseURL: 'http://cms.invalid', secret }), 'active');
  assert.equal(payloadRuntimeState({ mode: 'legacy', suppliedClient: true }), 'active');
});
test('intentionally inactive Payload still rejects public offset pagination', async () => {
  const calls = [];
  const backend = createNewsBackend({
    pool: { async query() { return { rows: [{ mode: 'legacy', epoch: 1 }] }; } },
    legacyReader: { async listPublishedAnnouncements(_pool, limit, offset) {
      calls.push({ limit, offset });
      return { count: 500, rows: [
        { ...dto(201), source: 'legacy', asset_scope: 'legacy' },
        { ...dto(202), source: 'legacy', asset_scope: 'legacy' },
        { ...dto(203), source: 'legacy', asset_scope: 'legacy' },
      ] };
    } },
  });
  await assert.rejects(backend.list({ limit: 2, offset: 200 }, actor),
    error => error.status === 400 && error.code === 'invalid_request');
  assert.deepEqual(calls, []);
  const result = await backend.list({ limit: 2, offset: 0 }, actor);
  assert.deepEqual(calls, [{ limit: 3, offset: 0 }]);
  assert.deepEqual(result.value.rows.map(row => row.id), [id(201), id(202)]);
  assert.ok(result.value.nextCursor);
  assert.equal(result.readState, 'complete');
});
test('intentionally inactive Payload is a healthy-empty navigation source in backend and HTTP without degradation logs', async () => {
  const rows = [1, 2, 3].map(n => ({ ...dto(n), source: 'legacy', asset_scope: 'legacy' }));
  const logs = []; let payloadFetches = 0;
  const legacyReader = {
    async getPublishedAnnouncement(_pool, value) { return rows.find(row => row.id === value) || null; },
    async listPublishedAnnouncements(_pool, limit, offset, _category, kind, _boundary, options = {}) {
      assert.equal(limit, 101); assert.equal(offset, 0); assert.equal(kind, 'article');
      return { rows, count: rows.length, ...(options.scan ? { scan: { rawRows: rows.length, batches: 1 } } : {}) };
    },
  };
  const pool = { async query() { return { rows: [{ mode: 'legacy', epoch: 1 }] }; } };
  const backend = createNewsBackend({ pool, legacyReader, logger: line => logs.push(line) });
  const result = await backend.navigation({ id: id(2), source: 'legacy' }, actor, { requestId: 'inactive-navigation' });
  assert.deepEqual(result, { value: {
    previous: { source: 'legacy', id: id(1), title: 'Article 1' },
    next: { source: 'legacy', id: id(3), title: 'Article 3' },
  }, readState: 'complete' });
  assert.deepEqual(logs, []);

  const http = appFor(async () => { payloadFetches++; throw new Error('must not fetch'); }, 'legacy', {
    inactivePayload: true, legacyReader, logger: line => logs.push(line),
  }).api;
  const response = await http.get(`/api/announcements/${id(2)}/navigation`)
    .set('Authorization', 'Bearer reader').expect(200);
  assert.equal(response.headers['x-owner-news-read-state'], 'complete');
  assert.deepEqual(response.body, result.value);
  assert.equal(payloadFetches, 0); assert.deepEqual(logs, []);
});
test('JSON transport uses fixed POST paths, exact actor/input, isolated headers and strict DTOs', async () => {
  const client = clientFor(async (url, init) => {
    assert.equal(url, 'http://cms.invalid/editorial/api/portal-news/list');
    assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error');
    assert.deepEqual(Object.keys(init.headers).sort(), ['Authorization', 'Content-Type', 'X-Request-ID']);
    assert.deepEqual(JSON.parse(init.body), { actor, input: { limit: 24, offset: 0 } });
    return Response.json({ rows: [dto()], count: 1 });
  });
  assert.equal((await client.query('list', { limit: 24, offset: 0 }, actor)).count, 1);
  for (const value of [{ ...dto(), secret: 'private' }, { ...dto(), asset_scope: 'legacy' }, { ...dto(), content_blocks: [{ type: 'script' }] }, { ...dto(), editorial: {} }]) assert.throws(() => readNewsDTO(value), /news_unavailable/);
  assert.throws(() => readNewsPage({ rows: [dto()], count: 0 }), /news_unavailable/);
  assert.equal(readNewsPage({ rows: [dto()], count: null }).count, null);
  assert.throws(() => readNewsPage({ rows: [dto(), dto()], count: null }), /news_unavailable/);
  const scanned = { rows: [dto()], count: null, scan: { rawRows: 101, batches: 2 } };
  const allowance = { maxRawRows: 101, maxBatches: 2 };
  assert.deepEqual(readResult('list', scanned, { limit: 1, offset: 0, scan: allowance }).scan, scanned.scan);
  for (const malformed of [
    { rows: [dto()], count: null },
    { ...scanned, scan: { rawRows: 101, batches: 0 } },
    { ...scanned, scan: { rawRows: 101, batches: 2, extra: true } },
    { ...scanned, scan: { rawRows: -1, batches: 1 } },
    { ...scanned, scan: { rawRows: 102, batches: 2 } },
    { ...scanned, scan: { rawRows: 101, batches: 3 } },
  ]) assert.throws(() => readResult('list', malformed, { limit: 1, offset: 0, scan: allowance }), /news_unavailable/);
  assert.throws(() => readResult('list', scanned, { limit: 1, offset: 0 }), /news_unavailable/);
  await assert.rejects(client.query('../news-articles', {}, actor), /news_unavailable/);
  await assert.rejects(client.query('list', { limit: 102, offset: 0 }, actor), /news_unavailable/);
  for (const scan of [true, false, {}, { maxRawRows: 0, maxBatches: 1 }, { maxRawRows: 1, maxBatches: 0 },
    { maxRawRows: 101001, maxBatches: 1 }, { maxRawRows: 1, maxBatches: 1001 }, { maxRawRows: 1, maxBatches: 1, extra: true }])
    await assert.rejects(client.query('list', { limit: 1, offset: 0, scan }, actor), /news_unavailable/);
});

test('private preflight uses the fixed service path and validates exact empty-state evidence', async () => {
  const result = { ready: true, publicationMode: 'manual', authority: { mode: 'frozen', epoch: 9 }, newsEmpty: true,
    mutation: { sequence: '0', chainSha256: '0'.repeat(64), writeBarrier: 'open' },
    counts: { articles: 0, media: 0, homePublished: 0, schedules: 0 } };
  const client = clientFor(async (url, init) => {
    assert.equal(url, 'http://cms.invalid/editorial/api/portal-news/preflight');
    assert.deepEqual(JSON.parse(init.body), { input: {} });
    return Response.json(result);
  });
  assert.deepEqual(await client.preflight(), result);
  await assert.rejects(client.query('preflight', {}, actor), /news_unavailable/);
  assert.equal(validPublicInput('preflight', {}), false);
  for (const malformed of [
    { ...result, extra: true },
    { ...result, ready: false },
    { ...result, publicationMode: 'scheduled' },
    { ...result, authority: { mode: 'payload', epoch: 9 } },
    { ...result, newsEmpty: false },
    { ...result, mutation: { ...result.mutation, sequence: 0 } },
    { ...result, mutation: { ...result.mutation, sequence: '01' } },
    { ...result, mutation: { ...result.mutation, chainSha256: 'A'.repeat(64) } },
    { ...result, mutation: { ...result.mutation, writeBarrier: 'sealed' } },
    { ...result, counts: { ...result.counts, articles: -1 } },
  ]) await assert.rejects(clientFor(async () => Response.json(malformed)).preflight(), /news_unavailable/);
});
test('duplicate source identities are source failures: degrade first pages, restart continuations, and never become client 400', async () => {
  const duplicateLegacy = { ...dto(7), source: 'legacy', asset_scope: 'legacy' };
  const logs = [];
  const backend = createNewsBackend({
    pool: { async query() { return { rows: [{ mode: 'payload', epoch: 1 }] }; } },
    legacyReader: { async listPublishedAnnouncements() { return { rows: [duplicateLegacy, { ...duplicateLegacy }], count: null }; } },
    payloadClient: { async query() { return { rows: [dto(9)], count: 1 }; } },
    logger: line => logs.push(JSON.parse(line)),
  });
  const first = await backend.list({ limit: 10, offset: 0 }, actor, { requestId: 'duplicate-legacy' });
  assert.equal(first.readState, 'degraded');
  assert.deepEqual(first.value.rows.map(row => row.id), [id(9)]);
  assert.equal(first.value.count, null); assert.equal(first.value.nextCursor, null);
  assert.deepEqual(logs, [{ code: 'owner_news_read_degraded', action: 'list', source: 'legacy', requestId: 'duplicate-legacy' }]);
  await assert.rejects(backend.list({ limit: 10, offset: 1 }, actor),
    error => error.status === 400 && error.code === 'invalid_request');

  const none = createNewsBackend({
    pool: { async query() { return { rows: [{ mode: 'payload', epoch: 1 }] }; } },
    legacyReader: { async listPublishedAnnouncements() { return { rows: [duplicateLegacy, { ...duplicateLegacy }], count: null }; } },
    payloadClient: { async query() { return { rows: [dto(8), dto(8)], count: null }; } }, logger() {},
  });
  await assert.rejects(none.list({ limit: 10, offset: 0 }, actor),
    error => error.status === 503 && error.code === 'news_unavailable');

  const inactive = createNewsBackend({
    pool: { async query() { return { rows: [{ mode: 'legacy', epoch: 1 }] }; } },
    legacyReader: { async listPublishedAnnouncements() { return { rows: [duplicateLegacy, { ...duplicateLegacy }], count: null }; } },
    logger() {},
  });
  const inactiveFirst = await inactive.list({ limit: 10, offset: 0 }, actor);
  assert.deepEqual(inactiveFirst, { value: { rows: [], count: null, nextCursor: null }, readState: 'degraded' });

  const { api } = appFor(async () => Response.json({ rows: [dto(8), dto(8)], count: null }), 'payload', {
    legacyReader: { async listPublishedAnnouncements() { return { rows: [], count: 0 }; } },
  });
  const response = await api.get('/api/announcements?limit=10&offset=0').set('Authorization', 'Bearer reader').expect(200);
  assert.equal(response.headers['x-owner-news-read-state'], 'degraded');
  assert.deepEqual(response.body, []);
  assert.equal(response.headers['x-owner-news-next-cursor'], undefined);
  assert.equal(response.headers['x-total-count'], undefined);
});
test('private list forwards only an exact decoded boundary and permits the 101-row source lookahead', async () => {
  const boundary = { published_at: null, source: 'legacy', id: id(9) };
  let fetches = 0;
  const client = clientFor(async (_url, init) => {
    fetches++;
    assert.deepEqual(JSON.parse(init.body).input, { limit: 101, offset: 0, category: '', kind: 'article', boundary });
    return Response.json({ rows: Array.from({ length: 101 }, (_, index) => dto(index + 1)), count: 101 });
  });
  assert.equal((await client.query('list', { limit: 101, offset: 0, category: '', kind: 'article', boundary }, actor)).rows.length, 101);
  for (const malformed of [
    null, [], {}, { ...boundary, extra: true }, { published_at: null, source: 'legacy' },
    { ...boundary, published_at: 'bad' }, { ...boundary, source: 'other' }, { ...boundary, id: 'bad' },
  ]) await assert.rejects(client.query('list', { limit: 101, offset: 0, boundary: malformed }, actor), /news_unavailable/);
  await assert.rejects(client.query('list', { limit: 102, offset: 0, boundary }, actor), /news_unavailable/);
  assert.equal(fetches, 1, 'malformed private inputs must be rejected before fetch');
});
test('full multi-document page >6MiB is accepted; rich body is not silently omitted', async () => {
  const rows = [dto(), dto(2)].map(value => ({ ...value, content_blocks: [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [{ type: 'text', marks: ['bold'], text: 'a'.repeat(4 * 1024 * 1024) }] }] }] }));
  const result = await clientFor(async () => Response.json({ rows, count: 2 })).query('list', { limit: 2, offset: 0 }, actor);
  assert.equal(result.rows[1].content_blocks[0].nodes[0].children[0].text.length, 4 * 1024 * 1024);
});
test('private list transport enforces one fixed 32 MiB cap from Content-Length and streamed bytes before parsing', async () => {
  let metadataCancelled = false;
  const metadataBody = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{}')); }, cancel() { metadataCancelled = true; } });
  await assert.rejects(clientFor(async () => new Response(metadataBody, { headers: {
    'content-type': 'application/json', 'content-length': String(32 * 1024 * 1024 + 1),
  } })).query('list', { limit: 100, offset: 0 }, actor), /news_unavailable/);
  assert.equal(metadataCancelled, true);

  let streamedCancelled = false;
  const chunk = new Uint8Array(4 * 1024 * 1024);
  const stream = new ReadableStream({ pull(c) { c.enqueue(chunk); }, cancel() { streamedCancelled = true; } });
  await assert.rejects(clientFor(async () => new Response(stream, { headers: { 'content-type': 'application/json' } }))
    .query('list', { limit: 1, offset: 0 }, actor), /news_unavailable/);
  assert.equal(streamedCancelled, true);
});
test('malformed JSON, redirects, internal errors, and metadata/stream byte excess are sanitized and cancelled', async () => {
  for (const response of [new Response('{', { headers: { 'content-type': 'application/json' } }), Response.redirect('http://other.invalid'), Response.json({ secret: '/private/path' }, { status: 500 }), Response.json(dto(), { headers: { 'content-length': String(7 * 1024 * 1024) } })]) {
    await assert.rejects(clientFor(async () => response).query('detail', { id: id(1) }, actor), e => e.status === 503 && e.message === 'news_unavailable');
  }
  let cancelled = false;
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; } });
  await assert.rejects(clientFor(async () => new Response(body, { headers: { 'content-type': 'application/json' } })).query('home', {}, actor), /news_unavailable/);
  assert.equal(cancelled, true);
  const tooMany = Array.from({ length: 10001 }, (_, n) => String(n));
  await assert.rejects(clientFor(async () => Response.json(tooMany)).query('categories', { withCounts: false }, actor), /news_unavailable/);
});
test('timeout and caller abort propagate into fetch', async () => {
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) reject(new Error('aborted'));
    else init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  await assert.rejects(clientFor(fetchImpl, { timeoutMs: 15 }).query('home', {}, actor), /news_unavailable/);
  const controller = new AbortController(), pending = clientFor(fetchImpl).query('home', {}, actor, { signal: controller.signal });
  controller.abort(); await assert.rejects(pending, /news_unavailable/);
});
test('JSON, preflight and asset timeout actively cancel a stalled response body, including an idle stream', async () => {
  let cancelled = 0;
  const stall = () => new ReadableStream({ cancel() { cancelled++; } });
  await assert.rejects(clientFor(async () => new Response(stall(), { headers: { 'content-type': 'application/json' } }), { timeoutMs: 15 }).query('home', {}, actor), /news_unavailable/);
  await assert.rejects(clientFor(async () => new Response(stall(), { headers: { 'content-type': 'application/json' } }), { timeoutMs: 15 }).preflight(), /news_unavailable/);
  const result = await clientFor(async () => new Response(stall(), { headers: { 'content-type': 'application/pdf', 'content-length': '4', 'content-disposition': 'inline; filename="x.pdf"' } }), { timeoutMs: 15 }).asset({ id: id(1), preview: false, range: null }, actor);
  await assert.rejects(result.body.getReader().read(), /news_unavailable/);
  assert.equal(cancelled, 3);
});
test('Express HTTP preserves list/envelopes/filter validation and uses current user/policy, not body/query identity', async () => {
  let seen = [];
  const { api } = appFor(async (url, init) => {
    const request = JSON.parse(init.body); seen.push(request); const action = url.split('/').at(-1);
    assert.equal(request.actor.uid, 'verified-user'); assert.equal(init.headers['X-Request-ID'], 'test-request');
    if (action === 'list') return Response.json({ rows: [dto()], count: 7 });
    if (action === 'categories') return Response.json({ total: 0, categories: [] });
    if (action === 'home') return Response.json({ content: null });
    if (action === 'navigation') return Response.json({ previous: null, next: null });
    return Response.json({ ...dto(), asset_scope: action === 'preview' ? 'owner-news-preview' : 'owner-news' });
  });
  const get = (path, who = 'reader') => api.get(`/api/announcements${path}`).set('Authorization', `Bearer ${who}`);
  const page = await get('?limit=1&offset=0&category=&kind=article').expect(200);
  assert.equal(page.headers['x-total-count'], '7'); assert.equal(page.body.length, 1);
  assert.deepEqual(seen[0].input, { limit: 2, offset: 0, category: '', kind: 'article' });
  assert.equal(page.headers['x-owner-news-read-state'], 'complete');
  await get('/categories').expect(200); assert.deepEqual((await get('/home').expect(200)).body, { content: null });
  await get(`/${id(1)}/navigation`).expect(200);
  assert.equal((await get(`/${id(1)}?source=payload`, 'editor').expect(200)).body.content_blocks[0].text, 'Published A');
  assert.equal(seen.at(-1).actor.canManageNews, true);
  await get(`/preview/${id(1)}?version=${id(2)}`).expect(403);
  await get(`/preview/${id(1)}?version=${id(2)}&source=payload`, 'editor').expect(200);
  assert.equal(seen.at(-1).input.source, 'payload');
  const before = seen.length;
  for (const path of ['?limit=0', '?category=x&category=y', '?actor=evil', '/home?draft=true', '/assets/bad', `/${id(1)}?source=other`, `/preview/${id(1)}`, `/preview/${id(1)}?version=${id(2)}&source=other`]) await get(path, 'editor').expect(400);
  await get('').send({ actor: { canManageNews: true } }).expect(400);
  await api.get('/api/announcements').expect(401);
  assert.equal(seen.length, before);
  assert.deepEqual((await api.get('/api/announcements/polls').expect(200)).body, { polls: true });
});
test('Express HTTP maps missing publication and dependency failure without exposing private CMS error', async () => {
  for (const status of [404, 500, 503]) {
    const { api } = appFor(async () => Response.json({ private: 'storage/secret' }, { status }));
    const response = await api.get(`/api/announcements/${id(1)}?source=payload`).set('Authorization', 'Bearer reader').expect(status === 404 ? 404 : 503);
    assert.equal(response.body.reason, status === 404 ? 'not_found' : 'news_unavailable'); assert.doesNotMatch(JSON.stringify(response.body), /storage\/secret/);
  }
});
test('Express list emits an opaque next cursor, sends only its typed boundary upstream, and requires restart on degradation', async () => {
  let calls = 0;
  const { api } = appFor(async (_url, init) => {
    calls++;
    const input = JSON.parse(init.body).input;
    if (calls === 1) {
      assert.equal(Object.hasOwn(input, 'boundary'), false);
      return Response.json({ rows: [dto(1), dto(2)], count: 2 });
    }
    assert.deepEqual(input.boundary, { source: 'payload', id: id(1), published_at: dto(1).published_at });
    return Response.json({ rows: [], count: 2 });
  });
  const first = await api.get('/api/announcements?limit=1&offset=0').set('Authorization', 'Bearer reader').expect(200);
  const cursor = first.headers['x-owner-news-next-cursor'];
  assert.deepEqual(decodeNewsCursor(cursor, {}), { source: 'payload', id: id(1), published_at: dto(1).published_at });
  const beforeInvalid = calls;
  const invalid = await api.get(`/api/announcements?limit=1&offset=1&cursor=${encodeURIComponent(cursor)}`).set('Authorization', 'Bearer reader').expect(400);
  assert.equal(invalid.body.reason, 'invalid_request');
  assert.equal(calls, beforeInvalid, 'cursor plus offset is rejected before either source');
  await api.get(`/api/announcements?limit=1&offset=0&cursor=${encodeURIComponent(cursor)}`).set('Authorization', 'Bearer reader').expect(200);

  const unavailable = appFor(async () => Response.json({ private: 'no' }, { status: 500 })).api;
  const restart = await unavailable.get(`/api/announcements?limit=1&offset=0&cursor=${encodeURIComponent(cursor)}`).set('Authorization', 'Bearer reader').expect(503);
  assert.equal(restart.body.reason, 'news_page_restart_required');
  assert.equal(restart.headers['x-owner-news-next-cursor'], undefined);
});
test('Express omits informational total when bounded dual-source lookahead cannot prove it exact', async () => {
  const legacyReader = {
    async listPublishedAnnouncements() { return { rows: [], count: null }; },
  };
  const { api } = appFor(async () => Response.json({ rows: [dto()], count: 500 }), 'payload', { legacyReader });
  const response = await api.get('/api/announcements?limit=1&offset=0').set('Authorization', 'Bearer reader').expect(200);
  assert.equal(response.headers['x-total-count'], undefined);
  assert.equal(response.headers['x-owner-news-read-state'], 'complete');
  assert.deepEqual(response.body.map(row => row.id), [id(1)]);
});
test('Express omits total and continuation on a degraded first page while complete pages retain exact totals', async () => {
  const degraded = appFor(async () => Response.json({ private: 'dependency detail' }, { status: 503 })).api;
  const partial = await degraded.get('/api/announcements?limit=1&offset=0').set('Authorization', 'Bearer reader').expect(200);
  assert.equal(partial.headers['x-owner-news-read-state'], 'degraded');
  assert.equal(partial.headers['x-total-count'], undefined);
  assert.equal(partial.headers['x-owner-news-next-cursor'], undefined);

  const complete = appFor(async () => Response.json({ rows: [dto(2)], count: 1 })).api;
  const whole = await complete.get('/api/announcements?limit=100&offset=0&kind=article').set('Authorization', 'Bearer reader').expect(200);
  assert.equal(whole.headers['cache-control'], 'private,no-store');
  assert.equal(whole.headers['x-owner-news-read-state'], 'complete');
  assert.equal(whole.headers['x-total-count'], '2');
});
test('public read responses stay private and sanitize DTOs, headers and degradation logs', async () => {
  const upstreamURL = 'http://cms.internal.invalid/editorial/api/portal-news/list';
  const credential = 'Bearer private-service-credential';
  const internalReason = 'postgres socket /private/content failed';
  const stack = `Error: ${internalReason}\n    at ${upstreamURL}:1:1`;
  const forbidden = /cms\.internal\.invalid|private-service-credential|private\/content|Error:|at http/u;
  const logs = [];
  const { api } = appFor(async () => {
    const error = new Error(internalReason);
    error.stack = stack;
    error.url = upstreamURL;
    error.authorization = credential;
    throw error;
  }, 'payload', { logger: line => logs.push(line) });

  const degraded = await api.get('/api/announcements?limit=1&offset=0')
    .set('Authorization', 'Bearer reader').expect(200);
  assert.equal(degraded.headers['cache-control'], 'private,no-store');
  assert.equal(degraded.headers['x-owner-news-read-state'], 'degraded');
  assert.equal(degraded.headers['x-total-count'], undefined);
  assert.equal(degraded.headers['x-owner-news-next-cursor'], undefined);
  assert.doesNotMatch(JSON.stringify({ body: degraded.body, headers: degraded.headers, logs }), forbidden);
  assert.deepEqual(logs.map(JSON.parse), [{ code: 'owner_news_read_degraded', action: 'list', source: 'payload', requestId: 'test-request' }]);

  const unavailable = appFor(async () => Response.json({ url: upstreamURL, credential, stack, content: internalReason, reason: 'db_timeout' }, { status: 503 })).api;
  const failure = await unavailable.get(`/api/announcements/${id(1)}?source=payload`)
    .set('Authorization', 'Bearer reader').expect(503);
  assert.equal(failure.headers['cache-control'], 'private,no-store');
  assert.deepEqual(failure.body, { error: 'Owner News indisponível.', reason: 'news_unavailable', requestId: 'test-request' });
  assert.doesNotMatch(JSON.stringify({ body: failure.body, headers: failure.headers }), forbidden);

  assert.throws(() => readNewsDTO({ ...dto(), upstreamURL, credential, stack, content: internalReason, internalReason }), /news_unavailable/);
});
test('asset stream enforces headers, byte limits, Range and cancellation without JSON buffering', async () => {
  const headers = { 'content-type': 'application/pdf', 'content-length': '4', 'content-disposition': 'inline; filename="test.pdf"', 'accept-ranges': 'bytes', 'content-range': 'bytes 1-4/10' };
  const { api } = appFor(async (_url, init) => { assert.equal(JSON.parse(init.body).input.range, 'bytes=1-4'); return new Response('abcd', { status: 206, headers }); });
  const response = await api.get(`/api/announcements/assets/${id(1)}`).set('Authorization', 'Bearer reader').set('Range', 'bytes=1-4').expect(206);
  assert.equal(response.headers['content-range'], 'bytes 1-4/10'); assert.equal(response.body.toString(), 'abcd');
  let cancelled = false;
  const client = clientFor(async () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(8)); }, cancel() { cancelled = true; } }), { headers: { ...headers, 'content-range': '' } }));
  const asset = await client.asset({ id: id(1), preview: false, range: null }, actor);
  await assert.rejects(asset.body.getReader().read(), /news_unavailable/); assert.equal(cancelled, true);
  cancelled = false;
  const streaming = clientFor(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers }));
  const result = await streaming.asset({ id: id(1), preview: false, range: null }, actor); await result.body.cancel(); assert.equal(cancelled, true);
});
test('real Express socket disconnect aborts upstream CMS fetch', async () => {
  let aborted, started;
  const abortSeen = new Promise(resolve => { aborted = resolve; }), startSeen = new Promise(resolve => { started = resolve; });
  const { app } = appFor(async (_url, init) => { started(); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => { aborted(); reject(new Error('abort')); }, { once: true })); });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${server.address().port}/api/announcements`, { headers: { Authorization: 'Bearer reader' }, signal: controller.signal }).catch(() => {});
    await startSeen; controller.abort(); await abortSeen; await request;
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('legacy/frozen preview uses exact original IDs only; public asset never gains editor draft access', async () => {
  const previous = process.env.UPLOAD_DIR;
  const directory = await mkdtemp(path.join(process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir(), 'task7-legacy-'));
  process.env.UPLOAD_DIR = directory;
  const asset = { id: id(8), storage_key: id(8), mime_type: 'application/pdf', byte_size: 10 };
  const revision = { blocks: [{ type: 'pdf', asset_id: asset.id, title: 'Legacy PDF' }], editorial: null, status: 'published' };
  const calls = [];
  const pool = { async query(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('owner_news_authority')) return { rows: [{ mode: 'frozen', epoch: 2 }] };
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM cms_assets')) return { rows: [asset] };
    if (sql.includes('r.id=$2')) return { rows: params[0] === id(1) && params[1] === id(2) ? [{ id: id(1), title: 'Legacy', category: '', published_at: null, ...revision }] : [] };
    if (sql.includes('FROM cms_revisions r')) {
      assert.match(sql, /d\.published_revision_id=r\.id AND r\.status='published'/);
      assert.equal(params[1], false, 'editor normal asset is not a preview');
      return { rows: [revision] };
    }
    throw new Error('Unexpected SQL');
  }, async connect() { return { query: pool.query, release() {} }; } };
  const editor = { ...actor, canManageNews: true }, backend = createNewsBackend({ pool });
  try {
    await mkdir(path.join(directory, 'cms-private')); await writeFile(path.join(directory, 'cms-private', asset.storage_key), '%PDF-12345');
    const preview = (await backend.preview({ id: id(1), versionId: id(2), source: 'legacy' }, editor)).value;
    assert.equal(preview.id, id(1)); assert.equal(preview.asset_scope, 'owner-news-preview'); assert.equal(preview.read_time_minutes, null);
    assert.deepEqual(preview.preview_revision, { id: id(2), source: 'legacy', status: 'published' });
    await assert.rejects(backend.preview({ id: id(1), versionId: id(2), source: 'payload' }, editor), e => e.status === 503);
    await assert.rejects(backend.preview({ id: id(3), versionId: id(2), source: 'legacy' }, editor), e => e.status === 404);
    const result = (await backend.asset({ id: asset.id, preview: false, range: 'bytes=0-4', source: 'legacy' }, editor)).value;
    assert.equal(result.status, 206); assert.equal(await new Response(result.body).text(), '%PDF-');
    assert.equal((await backend.asset({ id: asset.id, preview: false, range: 'bytes=-0', source: 'legacy' }, actor)).value.status, 416);
    const before = calls.length;
    await assert.rejects(backend.asset({ id: asset.id, preview: true, range: null, source: 'legacy' }, actor), e => e.status === 403);
    assert.equal(calls.length, before);
  } finally { if (previous === undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR = previous; await rm(directory, { recursive: true, force: true }); }
});

test('optional preview revision metadata is exact, source-bound and never leaks into published DTOs', () => {
  const input = { id: id(1), versionId: id(2), source: 'payload' };
  const preview = { ...dto(), asset_scope: 'owner-news-preview' };
  assert.equal(readResult('preview', preview, input), preview, 'older compatible DTO has no invented status');
  for (const status of ['draft', 'published']) {
    const data = { ...preview, preview_revision: { id: id(2), source: 'payload', status } };
    assert.equal(readResult('preview', data, input), data);
  }
  for (const meta of [null, {}, { id: id(2), source: 'payload', status: 'unknown' },
    { id: id(2), source: 'payload', status: 'scheduled' }, { id: id(3), source: 'payload', status: 'draft' },
    { id: id(2), source: 'legacy', status: 'draft' }, { id: id(2), source: 'payload', status: 'draft', secret: 'no' }]) {
    assert.throws(() => readResult('preview', { ...preview, preview_revision: meta }, input), /news_unavailable/);
  }
  assert.throws(() => readNewsDTO({ ...dto(), preview_revision: { id: id(2), source: 'payload', status: 'published' } }), /news_unavailable/);
});

test('Payload DTOs and navigation references require exact public source identity', () => {
  assert.equal(readNewsDTO(dto()).source, 'payload');
  for (const value of [
    Object.fromEntries(Object.entries(dto()).filter(([key]) => key !== 'source')),
    { ...dto(), source: 'legacy' },
    { ...dto(), source: 'unknown' },
    { ...dto(), source: 'payload', asset_scope: 'legacy' },
    { ...dto(), id: 'not-a-uuid' },
    { ...dto(), extra: true },
  ]) assert.throws(() => readNewsDTO(value), /news_unavailable/);

  const input = { id: id(1), category: '' };
  const reference = { source: 'payload', id: id(2), title: 'Next' };
  assert.deepEqual(readResult('navigation', { previous: reference, next: null }, input).previous, reference);
  for (const value of [
    { id: id(2), title: 'Next' },
    { ...reference, source: 'legacy' },
    { ...reference, source: 'unknown' },
    { ...reference, id: 'not-a-uuid' },
    { ...reference, extra: true },
  ]) assert.throws(() => readResult('navigation', { previous: value, next: null }, input), /news_unavailable/);
});

test('preview revision source remains independent from the public Payload document source', () => {
  const preview = { ...dto(), asset_scope: 'owner-news-preview', preview_revision: { id: id(2), source: 'legacy', status: 'archived' } };
  assert.equal(readResult('preview', preview, { id: id(1), versionId: id(2), source: 'legacy' }).source, 'payload');
});
