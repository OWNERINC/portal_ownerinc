import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createEditorState } from '../../public/pages/state.js';

const require = createRequire(import.meta.url);
const { slugBase, ensureSlug } = require('../../api/pages/aliases');
const { reader, readerBySlug, categories } = require('../../api/pages/store');
const { createTemplate } = require('../../api/pages/templates');
const id = '10000000-0000-4000-8000-000000000001';

test('slug handles accents, length and empty input without claiming public access', () => {
  assert.equal(slugBase('Código de vestimenta'), 'codigo-de-vestimenta');
  assert.equal(slugBase('   '), null);
  assert.equal(slugBase('!'), 'pagina');
  assert.equal(slugBase(' Café — GUIA / ações! '), 'cafe-guia-acoes');
  assert.equal(slugBase('中文'), 'pagina');
  assert.equal(slugBase(`${'a'.repeat(79)} - b`), 'a'.repeat(79));
  assert.ok(slugBase('a'.repeat(200)).length <= 80);
});

function aliasDB(occupied = []) {
  const queries = [];
  return { queries, async query(sql, values) {
    queries.push({ sql, values });
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] };
    if (sql.startsWith('SELECT slug FROM pages')) return { rows: occupied.map(slug => ({ slug })) };
    if (sql.startsWith('UPDATE pages SET slug')) return { rows: [] };
    assert.fail(`Unexpected SQL: ${sql}`);
  } };
}

test('reservation keeps existing aliases and skips empty titles without any query', async () => {
  const db = aliasDB();
  assert.equal(await ensureSlug(db, { id, slug: 'original' }, 'New title'), 'original');
  assert.equal(await ensureSlug(db, { id, slug: null }, '  '), null);
  assert.equal(db.queries.length, 0);
});

test('reservation takes base lock, checks both candidates, and updates only its already-locked row', async () => {
  for (const occupied of [[], ['guia']]) {
    const db = aliasDB(occupied), suffix = `guia-${id.replaceAll('-', '')}`;
    assert.equal(await ensureSlug(db, { id, slug: null }, 'Guia'), occupied.length ? suffix : 'guia');
    assert.equal(db.queries.length, 3);
    assert.deepEqual(db.queries[0].values, ['pages-alias:guia']);
    assert.deepEqual(db.queries[1].values, [['guia', suffix]]);
    assert.doesNotMatch(db.queries[1].sql, /FOR UPDATE|FOR SHARE/i, 'never acquire another page row lock');
    assert.deepEqual(db.queries[2].values, [id, occupied.length ? suffix : 'guia']);
  }
  const db = aliasDB(['a'.repeat(80)]);
  assert.equal((await ensureSlug(db, { id, slug: null }, 'a'.repeat(200))).length, 113);
});

test('an occupied UUID-suffix candidate conflicts explicitly without blind retries or additional locks', async () => {
  const db = aliasDB(['guia', `guia-${id.replaceAll('-', '')}`]);
  await assert.rejects(ensureSlug(db, { id, slug: null }, 'Guia'), { status: 409, reason: 'slug_conflict' });
  assert.equal(db.queries.length, 2);
});

test('slug and UUID reader use the same single-statement eligibility and DTO, no preliminary alias lookup', async () => {
  const queries = [], dto = { id, slug: 'guia', revision_id: 'revision', document: {}, published_at: 'date' };
  const db = { async query(sql, values) { queries.push({ sql, values }); return { rows: [dto] }; } };
  assert.deepEqual(await reader(db, { uid: 'actor' }, id), dto);
  assert.deepEqual(await readerBySlug(db, { uid: 'actor' }, 'guia'), dto);
  assert.equal(queries.length, 2);
  assert.equal(queries[0].sql.replace('p.id = $2', 'p.slug = $2'), queries[1].sql);
  assert.deepEqual(queries[1].values, ['actor', 'guia']);
  assert.match(queries[1].sql, /JOIN job_titles jt.*jt.active = TRUE/);
  assert.match(queries[1].sql, /a.revision_id = p.published_revision_id/);
  await assert.rejects(readerBySlug({ query: async () => ({ rows: [] }) }, { uid: 'actor' }, 'missing'), { status: 404, reason: 'not_visible' });
});

test('categories denies non-managers before SQL and binds actor, search, pagination and publisher scope', async () => {
  let called = 0;
  const db = { async query(sql, values) { called++; assert.match(sql, /SELECT DISTINCT/); assert.match(sql, /p.archived_at IS NULL/); assert.deepEqual(values, ['actor', "' OR TRUE --", 2, 3, false]); return { rows: [{ total: 0, items: [] }] }; } };
  await assert.rejects(categories(db, { uid: 'actor', role: 'viewer', permissions: { editPages: true } }, {}), { status: 403 });
  assert.equal(called, 0);
  assert.deepEqual(await categories(db, { uid: 'actor', role: 'admin', permissions: { editPages: true } }, { q: "' OR TRUE --", limit: 2, offset: 3 }), { total: 0, items: [] });
});

test('only confirmed slug metadata updates workspace; legacy ACK omission preserves slug and pending/baseline', async () => {
  const workspace = { id, slug: null, version: 0, draft: { document: createTemplate() }, capabilities: { edit: true, publish: true } };
  const state = createEditorState(workspace);
  state.document.metadata.title = 'First save'; state.changed();
  assert.equal(workspace.slug, null);
  let sent;
  await assert.rejects(state.save({ save: async (_id, body) => { sent = body; throw new Error('lost response'); } }));
  state.document.metadata.title = 'Newer title'; state.changed();
  state.acknowledge({ version: 0, published_revision_id: null, slug: 'confirmed' });
  assert.equal(workspace.slug, 'confirmed'); assert.equal(state.pending, sent); assert.equal(state.dirty, true);
  await state.save({ save: async (_id, body) => { assert.equal(body, sent); return { version: 1, draft_revision_id: 'r1', published_revision_id: null }; } });
  assert.equal(workspace.slug, 'confirmed'); assert.equal(state.dirty, true);
  await state.save({ save: async () => ({ version: 2, draft_revision_id: 'r2', published_revision_id: null, slug: 'server-alias' }) });
  assert.equal(workspace.slug, 'server-alias'); assert.equal(state.dirty, false);
  state.acknowledge({ version: 3, published_revision_id: null }); assert.equal(workspace.slug, 'server-alias');
  state.acknowledge({ version: 4, published_revision_id: null, slug: null }); assert.equal(workspace.slug, null);
});

test('browser API uses authenticated bound requests, encoded slug and paginated categories, without a friendly frontend route', async () => {
  const source = (await readFile(new URL('../../public/pages/api.js', import.meta.url), 'utf8')).replace(/^import .*?;\r?\n/, '');
  const { createPagesAPI } = await import(`data:text/javascript,${encodeURIComponent(`const fetchAPI = null, fetchAPIPage = null, fetchAPIAsset = null;\n${source}`)}`);
  const calls = [], signal = new AbortController().signal, result = { data: ['Pessoas'], total: 1 };
  const api = createPagesAPI({ signal, bindAPI: () => ({
    fetchAPI: async (...args) => { calls.push(args); return { id }; },
    fetchAPIPage: async (...args) => { calls.push(args); return result; },
  }) });
  assert.deepEqual(await api.readSlug('guia/privado?'), { id });
  assert.deepEqual(calls[0], ['/api/pages/by-slug/guia%2Fprivado%3F', { signal }]);
  assert.equal(await api.categories({ q: 'Pessoas & cultura', limit: 1, offset: 0 }), result);
  assert.deepEqual(calls[1], ['/api/pages/categories?q=Pessoas+%26+cultura&limit=1&offset=0', { signal }]);
});
