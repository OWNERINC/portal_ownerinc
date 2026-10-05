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
const { readNewsDTO, readNewsPage } = require('../../api/owner-news/payload-dto.js');
const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
const express = apiRequire('express'), supertest = apiRequire('supertest');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const secret = 'synthetic-task7-service-secret-not-real';
const dto = (n = 1) => ({ id: id(n), title: `Article ${n}`, category: '', published_at: '2026-10-01T00:00:00.000Z', editorial: null,
  content_version: 2, asset_scope: 'owner-news', content_blocks: [{ type: 'paragraph', text: 'Published A' }], read_time_minutes: 1 });
const clientFor = (fetchImpl, options = {}) => createPayloadNewsClient({ baseURL: 'http://cms.invalid', secret, fetchImpl, ...options });
function appFor(fetchImpl, mode = 'payload') {
  const calls = [], pool = { async query(sql) { calls.push(sql); return { rows: [{ mode, epoch: 1 }] }; } };
  const filename = fileURLToPath(new URL('../../api/routes/announcements.js', import.meta.url));
  const mod = new Module(filename), local = createRequire(filename);
  const authenticate = (req, res, next) => {
    if (!['Bearer reader', 'Bearer editor'].includes(req.get('authorization'))) return res.sendStatus(401);
    req.id = 'test-request'; req.user = { uid: 'verified-user', email: 'verified@example.invalid', name: null, role: req.get('authorization') === 'Bearer editor' ? 'admin' : 'employee', permissions: { manageKnowledge: req.get('authorization') === 'Bearer editor' } }; next();
  };
  mod.require = name => name === '../db' ? pool : name === '../middleware/auth' ? { authMiddleware: authenticate } : name === './owner-news-polls' ? express.Router().get('/', (_req, res) => res.json({ polls: true })) : local(name);
  mod._compile(readFileSync(filename, 'utf8'), filename);
  const app = express();
  app.use('/api/announcements', mod.exports.createAnnouncementsRouter({ backend: createNewsBackend({ pool, payloadClient: clientFor(fetchImpl) }), authenticate }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.code || 'safe' }));
  return { app, api: supertest(app), calls };
}
test('Payload outage never falls back to legacy content', async () => {
  let legacyQueries = 0;
  const pool = { async query(sql) {
    if (sql.includes('owner_news_authority')) return { rows: [{ mode: 'payload', epoch: 2 }] };
    legacyQueries++; throw new Error('legacy read forbidden');
  } };
  const backend = createNewsBackend({ pool, payloadClient: { async query() { throw new Error('private storage path'); } } });
  await assert.rejects(backend.list({ limit: 24, offset: 0 }, actor), error => error.status === 503 && error.message === 'news_unavailable');
  assert.equal(legacyQueries, 0);
});
test('authority is refreshed each operation; missing/invalid control fails closed', async () => {
  let mode = 'payload', reads = 0;
  const backend = createNewsBackend({ pool: { async query() { return { rows: mode === 'missing' ? [] : [{ mode, epoch: 1 }] }; } }, payloadClient: { async query() { reads++; return { content: null }; } } });
  for (const value of ['payload', 'payload_frozen']) { mode = value; await backend.home({}, actor); }
  mode = 'missing'; await assert.rejects(backend.home({}, actor), e => e.status === 503);
  assert.equal(reads, 2);
});
test('legacy dependency failures are also controlled 503 without private database diagnostics', async () => {
  const pool = { async query(sql) {
    if (sql.includes('owner_news_authority')) return { rows: [{ mode: 'legacy', epoch: 1 }] };
    throw new Error('postgres private detail');
  } };
  await assert.rejects(createNewsBackend({ pool }).home({}, actor), e => e.status === 503 && e.message === 'news_unavailable');
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
  await assert.rejects(client.query('../news-articles', {}, actor), /news_unavailable/);
  await assert.rejects(client.query('list', { limit: 101, offset: 0 }, actor), /news_unavailable/);
});
test('full multi-document page >6MiB is accepted; rich body is not silently omitted', async () => {
  const rows = [dto(), dto(2)].map(value => ({ ...value, content_blocks: [{ type: 'rich_text', nodes: [{ type: 'paragraph', children: [{ type: 'text', marks: ['bold'], text: 'a'.repeat(4 * 1024 * 1024) }] }] }] }));
  const result = await clientFor(async () => Response.json({ rows, count: 2 })).query('list', { limit: 2, offset: 0 }, actor);
  assert.equal(result.rows[1].content_blocks[0].nodes[0].children[0].text.length, 4 * 1024 * 1024);
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
test('JSON and asset timeout actively cancel a stalled response body, including an idle stream', async () => {
  let cancelled = 0;
  const stall = () => new ReadableStream({ cancel() { cancelled++; } });
  await assert.rejects(clientFor(async () => new Response(stall(), { headers: { 'content-type': 'application/json' } }), { timeoutMs: 15 }).query('home', {}, actor), /news_unavailable/);
  const result = await clientFor(async () => new Response(stall(), { headers: { 'content-type': 'application/pdf', 'content-length': '4', 'content-disposition': 'inline; filename="x.pdf"' } }), { timeoutMs: 15 }).asset({ id: id(1), preview: false, range: null }, actor);
  await assert.rejects(result.body.getReader().read(), /news_unavailable/);
  assert.equal(cancelled, 2);
});
test('Express HTTP preserves list/envelopes/filter validation and uses current user/policy, not body/query identity', async () => {
  let seen = [];
  const { api } = appFor(async (url, init) => {
    const request = JSON.parse(init.body); seen.push(request); const action = url.split('/').at(-1);
    assert.equal(request.actor.uid, 'verified-user'); assert.equal(init.headers['X-Request-ID'], 'test-request');
    if (action === 'list') return Response.json({ rows: [dto()], count: 7 });
    if (action === 'categories') return Response.json([]);
    if (action === 'home') return Response.json({ content: null });
    if (action === 'navigation') return Response.json({ previous: null, next: null });
    return Response.json({ ...dto(), asset_scope: action === 'preview' ? 'owner-news-preview' : 'owner-news' });
  });
  const get = (path, who = 'reader') => api.get(`/api/announcements${path}`).set('Authorization', `Bearer ${who}`);
  const page = await get('?limit=1&offset=2&category=&kind=article').expect(200);
  assert.equal(page.headers['x-total-count'], '7'); assert.equal(page.body.length, 1);
  assert.deepEqual(seen[0].input, { limit: 1, offset: 2, category: '', kind: 'article' });
  await get('/categories').expect(200); assert.deepEqual((await get('/home').expect(200)).body, { content: null });
  await get(`/${id(1)}/navigation`).expect(200);
  assert.equal((await get(`/${id(1)}`, 'editor').expect(200)).body.content_blocks[0].text, 'Published A');
  assert.equal(seen.at(-1).actor.canManageNews, true);
  await get(`/preview/${id(1)}?version=${id(2)}`).expect(403);
  await get(`/preview/${id(1)}?version=${id(2)}&source=legacy`, 'editor').expect(200);
  assert.equal(seen.at(-1).input.source, 'legacy');
  const before = seen.length;
  for (const path of ['?limit=0', '?category=x&category=y', '?actor=evil', '/home?draft=true', '/assets/bad', `/${id(1)}?source=legacy`, `/preview/${id(1)}`, `/preview/${id(1)}?version=${id(2)}&source=other`]) await get(path, 'editor').expect(400);
  await get('').send({ actor: { canManageNews: true } }).expect(400);
  await api.get('/api/announcements').expect(401);
  assert.equal(seen.length, before);
  assert.deepEqual((await api.get('/api/announcements/polls').expect(200)).body, { polls: true });
});
test('Express HTTP maps missing publication and dependency failure without exposing private CMS error', async () => {
  for (const status of [404, 500, 503]) {
    const { api } = appFor(async () => Response.json({ private: 'storage/secret' }, { status }));
    const response = await api.get(`/api/announcements/${id(1)}`).set('Authorization', 'Bearer reader').expect(status === 404 ? 404 : 503);
    assert.equal(response.body.reason, status === 404 ? 'not_found' : 'news_unavailable'); assert.doesNotMatch(JSON.stringify(response.body), /storage\/secret/);
  }
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
  const revision = { blocks: [{ type: 'pdf', asset_id: asset.id, title: 'Legacy PDF' }], editorial: null };
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
    const preview = await backend.preview({ id: id(1), versionId: id(2), source: 'legacy' }, editor);
    assert.equal(preview.id, id(1)); assert.equal(preview.asset_scope, 'owner-news-preview'); assert.equal(preview.read_time_minutes, null);
    await assert.rejects(backend.preview({ id: id(1), versionId: id(2), source: 'payload' }, editor), e => e.status === 404);
    await assert.rejects(backend.preview({ id: id(3), versionId: id(2), source: 'legacy' }, editor), e => e.status === 404);
    const result = await backend.asset({ id: asset.id, preview: false, range: 'bytes=0-4' }, editor);
    assert.equal(result.status, 206); assert.equal(await new Response(result.body).text(), '%PDF-');
    assert.equal((await backend.asset({ id: asset.id, preview: false, range: 'bytes=-0' }, actor)).status, 416);
    const before = calls.length;
    await assert.rejects(backend.asset({ id: asset.id, preview: true, range: null }, actor), e => e.status === 403);
    assert.equal(calls.length, before);
  } finally { if (previous === undefined) delete process.env.UPLOAD_DIR; else process.env.UPLOAD_DIR = previous; await rm(directory, { recursive: true, force: true }); }
});
