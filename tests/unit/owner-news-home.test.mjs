import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { ownerNewsApp } from '../helpers/owner-news-app.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const supertest = require('supertest');
const { normalizeHome } = require('./owner-news/home');
const content = { version: 1, eyebrow: 'OWNER NEWS', headline: 'Chamada\neditorial', summary: 'Resumo.' };

function poolFor() {
  let state = { version: 1, draft: null, published: null, published_at: null };
  let snapshot;
  const calls = [];
  const pool = { calls, corruptDraft(value) { state.draft = value; }, async query(sql, values = []) {
    calls.push({ sql, values });
    if (sql === 'BEGIN') { snapshot = structuredClone(state); return { rows: [] }; }
    if (sql === 'ROLLBACK') { state = snapshot; return { rows: [] }; }
    if (sql === 'COMMIT' || sql.includes('INSERT INTO audit_log')) return { rows: [] };
    if (sql.includes('UPDATE owner_news_home')) {
      if (state.version !== values[0] || (sql.includes('published=draft') && state.draft === null)) return { rows: [] };
      if (sql.includes('published=draft')) { state.published = state.draft; state.draft = null; state.published_at = '2026-09-30T12:00:00Z'; }
      else state.draft = JSON.parse(values[1]);
      state.version += 1;
    } else assert.match(sql, /FROM owner_news_home/);
    return { rows: [structuredClone(state)] };
  }, async connect() { return { query: pool.query, release() {} }; } };
  return pool;
}

test('HomeDTO validates exact keys, plain text, lengths and headline-only line breaks', () => {
  assert.deepEqual(normalizeHome(content), content);
  for (const bad of [null, [], {}, { ...content, extra: true }, { ...content, version: 2 },
    { ...content, eyebrow: 'x'.repeat(81) }, { ...content, headline: 'x'.repeat(161) },
    { ...content, summary: 'x'.repeat(601) }, { ...content, summary: '<b>HTML</b>' },
    { ...content, eyebrow: 'A\nB' }, { ...content, summary: 'A\rB' }, { ...content, headline: '' }]) {
    assert.equal(normalizeHome(bad), null);
  }
});

test('home routes isolate drafts, reject stale versions and publish with audit in one transaction', async () => {
  const pool = poolFor();
  const api = supertest(ownerNewsApp(pool));
  const admin = (method, path) => api[method](`/api/cms/owner-news/home${path}`).set('Authorization', 'Bearer admin');
  const publicHome = () => api.get('/api/announcements/home').set('Authorization', 'Bearer employee');
  const initial = await admin('get', '').expect(200);
  const saved = await admin('put', '/draft').send({ expected_version: initial.body.version, content }).expect(200);
  assert.equal(saved.body.version, 2);
  assert.deepEqual((await publicHome().expect(200)).body, { content: null });
  const stale = await admin('post', '/publish').send({ expected_version: 1 }).expect(409);
  assert.equal(stale.body.reason, 'version_conflict');
  assert.equal(stale.body.requestId, 'owner-news-test');
  const published = await admin('post', '/publish').send({ expected_version: 2 }).expect(200);
  assert.equal(published.body.draft, null);
  assert.deepEqual((await publicHome().expect(200)).body, { content });
  const missing = await admin('post', '/publish').send({ expected_version: 3 }).expect(409);
  assert.equal(missing.body.reason, 'draft_required');
  await admin('put', '/draft').send({ expected_version: 3, content: { ...content, headline: 'Posterior' } }).expect(200);
  assert.deepEqual((await publicHome().expect(200)).body, { content });
  pool.corruptDraft({ ...content, headline: '<script>bad</script>' });
  await admin('post', '/publish').send({ expected_version: 4 }).expect(400);
  assert.deepEqual((await publicHome().expect(200)).body, { content });
  assert.equal(pool.calls.filter(call => call.sql.includes('INSERT INTO audit_log')).length, 3);
  assert.ok(pool.calls.some(call => call.sql.includes('FOR UPDATE')));
});

test('home authenticates and checks real CMS permission before DB; malformed inputs are 400', async () => {
  const pool = poolFor();
  const api = supertest(ownerNewsApp(pool));
  for (const [method, path] of [['get', ''], ['put', '/draft'], ['post', '/publish']]) {
    await api[method](`/api/cms/owner-news/home${path}`).expect(401);
    await api[method](`/api/cms/owner-news/home${path}`).set('Authorization', 'Bearer employee').send({}).expect(403);
  }
  await api.get('/api/announcements/home').expect(401);
  for (const body of [{}, { expected_version: 0, content }, { expected_version: '1', content },
    { expected_version: 1, content: { ...content, summary: '<b>HTML</b>' } }, { expected_version: 1, content, extra: true },
    { expected_version: 1, content, toString: 'unknown' }]) {
    await api.put('/api/cms/owner-news/home/draft').set('Authorization', 'Bearer admin').send(body).expect(400);
  }
  await api.post('/api/cms/owner-news/home/publish').set('Authorization', 'Bearer admin').send({ expected_version: 1, content }).expect(400);
  assert.equal(pool.calls.length, 0);
});
