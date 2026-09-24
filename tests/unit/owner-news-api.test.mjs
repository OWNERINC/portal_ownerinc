import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

function poolFor() {
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
  const calls = [];
  return {
    calls,
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
  const routeModule = new Module(routePath);
  const routeRequire = createRequire(routePath);
  routeModule.require = name => {
    if (name === '../db') return pool;
    if (name === '../middleware/auth') return {
      authMiddleware(req, res, next) {
        if (req.get('Authorization') !== 'Bearer test-user') return res.sendStatus(401);
        next();
      },
    };
    return routeRequire(name);
  };
  routeModule._compile(routeSource, routePath);
  const app = express();
  app.use('/api/announcements', routeModule.exports);
  return supertest(app);
}

test('category filtering precedes pagination and total count over validated stable publications', async () => {
  const api = appFor(poolFor());
  const result = await api.get('/api/announcements?limit=1&offset=1&category=News')
    .set('Authorization', 'Bearer test-user').expect(200);
  assert.equal(result.headers['x-total-count'], '2');
  assert.deepEqual(result.body.map(row => row.id), [id(8)]);
  assert.deepEqual(Object.keys(result.body[0]).sort(), ['category', 'content_blocks', 'id', 'published_at', 'title']);
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
  for (const path of ['', '/categories', `/${id(5)}`]) {
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
    content_blocks: [{ type: 'paragraph', text: 'Body 5' }],
  });
  for (const n of [2, 3, 4, 6, 7]) {
    await api.get(`/api/announcements/${id(n)}`).set('Authorization', 'Bearer test-user').expect(404);
  }
});
