import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express'), request = require('supertest');
const { createPagesRouter } = require('./pages/router');

test('every Pages boundary authenticates before shape validation or SQL, including literal, private-media and write routes', async () => {
  let queries = 0;
  const app = express(); app.use(express.json()); app.use('/api/pages', createPagesRouter({ pool: { query() { queries++; throw new Error('SQL forbidden'); } }, authenticate: (_req,res) => res.status(401).json({ error: 'Authentication required.' }) }));
  for (const [method, route] of [['get','/templates'],['get','/job-titles'],['get','/manage'],['get','/'],['get','/bad'],['get','/bad/workspace'],['get','/bad/preview'],['get','/bad/media/bad'],['post','/'],['put','/bad/draft'],['post','/bad/publish'],['post','/bad/archive'],['post','/bad/restore'],['post','/bad/media']]) {
    const response = await request(app)[method](`/api/pages${route}`).send({ bad: true });
    assert.equal(response.status, 401, `${method} ${route}`); assert.equal(response.body.reason, 'authentication_required');
  }
  assert.equal(queries, 0);
});

test('incapable actors are denied before mutation/catalog SQL and uploads are ownership-gated before multipart parsing', async () => {
  let queries = 0; const id = randomUUID(); let user = { uid: 'viewer', role: 'viewer', permissions: { editPages: true, publishPages: true } };
  const pool = { query: async () => { queries++; return { rows: [{ id, author_uid: 'other', archived_at: null }] }; } };
  const app = express(); app.use(express.json()); app.use('/api/pages', createPagesRouter({ pool, authenticate: (req,_res,next) => { req.user = user; next(); } }));
  for (const [method, route] of [['get','/job-titles'],['get','/manage'],['post','/'],['put',`/${id}/draft`],['post',`/${id}/publish`],['post',`/${id}/media`]]) assert.equal((await request(app)[method](`/api/pages${route}`).send({})).status, 403);
  assert.equal(queries, 0);
  user = { uid: 'admin', role: 'admin', permissions: { superAdmin: true } };
  const response = await request(app).post(`/api/pages/${id}/media`).set('Content-Type','multipart/form-data; boundary=bad').send('unparseable');
  assert.equal(response.status, 403); assert.equal(response.body.reason, 'author_only'); assert.equal(queries, 1);
});
