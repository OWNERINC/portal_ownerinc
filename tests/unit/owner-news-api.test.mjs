import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express');
const supertest = require('supertest');
const { listPublishedAnnouncements } = require('./cms/reader');
const routePath = fileURLToPath(new URL('../../api/routes/announcements.js', import.meta.url));
const routeSource = await readFile(routePath, 'utf8');
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function poolFor(extended = false) {
  const rows = [
    { category: 'Other' },
    { category: 'News', blocks: [{ type: 'unknown' }] },
    { category: 'Missing asset', blocks: [{ type: 'image', asset_id: id(100), alt: 'Missing cover' }] },
    { category: 'Draft', status: 'draft' },
    { category: 'News' },
    { category: 'Unstable', unstable: true },
    { category: 'Wrong MIME', blocks: [{ type: 'image', asset_id: id(101), alt: 'Wrong cover MIME' }] },
    { category: 'News' },
    { category: '' },
  ].map((row, index) => ({
    id: id(index + 1), title: `Article ${index + 1}`, published_revision_id: id(index + 20),
    published_at: new Date(Date.UTC(2026, 8, 22 - index)).toISOString(),
    status: 'published', blocks: [{ type: 'paragraph', text: `Body ${index + 1}` }], ...row,
  }));
  if (extended) rows.push(...[
    { category: 'People & Culture', editorial: { version: 1, kind: 'article', summary: 'Resumo.', author: '', source_label: '', source_date: null } },
    { category: 'Edition', blocks: [{ type: 'pdf', asset_id: id(101), title: 'Edição' }] },
    { category: 'Invalid editorial', editorial: { version: 99 } },
    ...Array.from({ length: 26 }, () => ({ category: 'People & Culture' })),
  ].map((row, index) => ({ id: id(index + 10), title: `Article ${index + 10}`, published_revision_id: id(index + 1000),
    status: 'published', blocks: [{ type: 'paragraph', text: 'Texto sintético.' }], published_at: null, ...row })));
  const calls = [];
  return {
    calls,
    async query(sql) {
      assert.match(sql, /owner_news_authority/);
      return { rows: [{ mode: 'legacy', epoch: 1 }] };
    },
    async connect() {
      return {
        release() {},
        async query(sql, params = []) {
          calls.push({ sql, params });
          if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
          if (sql.includes("scheduled.status = 'scheduled'")) return { rows: [] };
          if (sql.includes('FROM cms_assets')) return { rows: [{ id: id(101), mime_type: 'application/pdf' }] };
          if (sql.includes('FROM cms_documents d')) {
            assert.match(sql, /r\.id = d\.published_revision_id AND r\.status = 'published'/);
            assert.match(sql, /d\.content_type = 'announcement'/);
            let published = rows.filter(row => row.status === 'published');
            if (sql.includes('FOR UPDATE OF d, r')) {
              return { rows: published.filter(row => !row.unstable && params[0].includes(row.id)) };
            }
            if (sql.includes('WHERE d.id = $1')) published = published.filter(row => row.id === params[0]);
            else {
              assert.match(sql, /ORDER BY d\.published_at DESC/);
              assert.doesNotMatch(sql, /LIMIT|OFFSET/);
            }
            return { rows: published.map(({ status, unstable, ...row }) => row) };
          }
          throw new Error(`Unexpected query: ${sql}`);
        },
      };
    },
  };
}

function appFor(pool) {
  function loadRoute(path, source) {
    const routeModule = new Module(path);
    const routeRequire = createRequire(path);
    routeModule.require = name => {
      if (name === '../db') return pool;
      if (name === './owner-news-polls') {
        const childPath = routeRequire.resolve(name);
        return loadRoute(childPath, readFileSync(childPath, 'utf8'));
      }
      if (name === '../middleware/auth') return {
        authMiddleware(req, res, next) {
          if (req.get('Authorization') !== 'Bearer test-user') return res.sendStatus(401);
          req.user = { uid: 'test-user', role: 'employee', permissions: {} };
          next();
        },
      };
      return routeRequire(name);
    };
    routeModule._compile(source, path);
    return routeModule.exports;
  }
  const app = express();
  app.use('/api/announcements', loadRoute(routePath, routeSource));
  return supertest(app);
}

test('category filtering precedes pagination and total count over validated stable publications', async () => {
  const api = appFor(poolFor());
  const result = await api.get('/api/announcements?limit=1&offset=1&category=News')
    .set('Authorization', 'Bearer test-user').expect(200);
  assert.equal(result.headers['x-total-count'], '2');
  assert.deepEqual(result.body.map(row => row.id), [id(8)]);
  assert.deepEqual(Object.keys(result.body[0]).sort(), ['category', 'content_blocks', 'editorial', 'id', 'published_at', 'read_time_minutes', 'title']);
  assert.equal(result.body[0].editorial, null);
  const empty = await api.get('/api/announcements?category=Absent').set('Authorization', 'Bearer test-user').expect(200);
  assert.equal(empty.headers['x-total-count'], '0');
  assert.deepEqual(empty.body, []);
});

test('unfiltered signature remains compatible and excludes invalid, draft and unstable rows', async () => {
  const pool = poolFor();
  const result = await listPublishedAnnouncements(pool, 50, 0);
  assert.equal(result.count, 4);
  assert.deepEqual(result.rows.map(row => row.id), [id(1), id(5), id(8), id(9)]);
  assert.deepEqual(pool.calls.find(call => call.sql.includes('FROM cms_assets')).params[0], [id(100), id(101)]);
});

test('categories returns unique nonempty strings from the same validated stable publications', async () => {
  const result = await appFor(poolFor()).get('/api/announcements/categories')
    .set('Authorization', 'Bearer test-user').expect(200);
  assert.deepEqual(result.body, ['News', 'Other']);
});

test('all announcement routes authenticate before accessing published content', async () => {
  const pool = poolFor();
  const api = appFor(pool);
  for (const path of ['', '/categories', '/home', `/${id(5)}`, `/${id(5)}/navigation`]) {
    await api.get(`/api/announcements${path}`).expect(401);
  }
  assert.equal(pool.calls.length, 0);
});

test('list query strictly validates category type, length, pagination and unknown parameters', async () => {
  const pool = poolFor();
  const api = appFor(pool);
  for (const query of [
    `category=${'x'.repeat(101)}`, 'category=News&category=Other', 'category[x]=News',
    'unexpected=value', 'limit=0', 'offset=-1', 'limit=101',
  ]) {
    await api.get(`/api/announcements?${query}`).set('Authorization', 'Bearer test-user').expect(400);
  }
  assert.equal(pool.calls.length, 0);
  await api.get(`/api/announcements?category=${'x'.repeat(100)}`).set('Authorization', 'Bearer test-user').expect(200);
  const empty = await api.get('/api/announcements?category=').set('Authorization', 'Bearer test-user').expect(200);
  assert.deepEqual(empty.body.map(row => row.id), [id(9)]);
});

test('detail preserves the published response format and hides draft or invalid content', async () => {
  const api = appFor(poolFor());
  const result = await api.get(`/api/announcements/${id(5)}`).set('Authorization', 'Bearer test-user').expect(200);
  assert.deepEqual(result.body, {
    id: id(5), title: 'Article 5', category: 'News', published_at: '2026-09-18T00:00:00.000Z',
    content_blocks: [{ type: 'paragraph', text: 'Body 5' }], editorial: null, read_time_minutes: 1,
  });
  for (const n of [2, 3, 4, 6, 7]) {
    await api.get(`/api/announcements/${id(n)}`).set('Authorization', 'Bearer test-user').expect(404);
  }
});

test('kind filters before pagination; counts and navigation share complete stable publications', async () => {
  const api = appFor(poolFor(true));
  const get = path => api.get(`/api/announcements${path}`).set('Authorization', 'Bearer test-user');
  const articles = await get('?kind=article&limit=1&offset=0').expect(200);
  assert.equal(articles.headers['x-total-count'], '31');
  assert.equal(articles.body[0].read_time_minutes, 1);
  const editions = await get('?kind=edition').expect(200);
  assert.deepEqual(editions.body.map(row => row.id), [id(11)]);
  assert.equal(editions.body[0].read_time_minutes, null);
  await get(`/${id(11)}`).expect(200);
  assert.deepEqual((await get(`/${id(11)}/navigation`).expect(200)).body, { previous: null, next: null });
  const counts = await get('/categories?kind=article&with_counts=true').expect(200);
  assert.deepEqual(counts.body, { total: 31, categories: [
    { name: 'News', count: 2 }, { name: 'Other', count: 1 }, { name: 'People & Culture', count: 27 },
  ] });
  assert.deepEqual((await get(`/${id(1)}/navigation`).expect(200)).body,
    { previous: null, next: { id: id(5), title: 'Article 5' } });
  assert.deepEqual((await get(`/${id(5)}/navigation`).expect(200)).body,
    { previous: { id: id(1), title: 'Article 1' }, next: { id: id(8), title: 'Article 8' } });
  assert.deepEqual((await get(`/${id(38)}/navigation?category=People%20%26%20Culture`).expect(200)).body,
    { previous: { id: id(37), title: 'Article 37' }, next: null });
  assert.deepEqual((await get(`/${id(10)}/navigation?category=People%20%26%20Culture`).expect(200)).body,
    { previous: null, next: { id: id(13), title: 'Article 13' } });
  for (const n of [2, 4, 6, 12, 99]) await get(`/${id(n)}/navigation`).expect(404);
  await get('/invalid/navigation').expect(400);
});

test('all new query contracts reject unknown, duplicate and invalid values before DB', async () => {
  const pool = poolFor(true);
  const api = appFor(pool);
  for (const path of ['?kind=unknown', '?kind=article&kind=edition', '/categories?unexpected=x',
    '/categories?with_counts=1', '/categories?kind=article&kind=edition', '/categories?with_counts=true&with_counts=false',
    `/${id(1)}/navigation?limit=1`, `/${id(1)}/navigation?category=A&category=B`, '/home?draft=true',
    `/${id(1)}?unknown=true`]) {
    await api.get(`/api/announcements${path}`).set('Authorization', 'Bearer test-user').expect(400);
  }
  assert.equal(pool.calls.length, 0);
});
