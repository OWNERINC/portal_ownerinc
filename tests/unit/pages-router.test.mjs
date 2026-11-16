import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express'), request = require('supertest');
const { createPagesRouter } = require('./pages/router');
const { createTemplate, listTemplates } = require('./pages/templates');

test('every Pages boundary authenticates before shape validation or SQL, including literal, private-media and write routes', async () => {
  let queries = 0;
  const app = express(); app.use(express.json()); app.use('/api/pages', createPagesRouter({ pool: { query() { queries++; throw new Error('SQL forbidden'); } }, authenticate: (_req,res) => res.status(401).json({ error: 'Authentication required.' }) }));
  for (const [method, route] of [['get','/templates'],['get','/job-titles'],['get','/manage'],['get','/categories'],['get','/by-slug/INVALID'],['get','/'],['get','/bad'],['get','/bad/workspace'],['get','/bad/preview'],['get','/bad/media/bad'],['post','/'],['put','/bad/draft'],['post','/bad/publish'],['post','/bad/archive'],['post','/bad/restore'],['post','/bad/media']]) {
    const response = await request(app)[method](`/api/pages${route}`).send({ bad: true });
    assert.equal(response.status, 401, `${method} ${route}`); assert.equal(response.body.reason, 'authentication_required');
  }
  assert.equal(queries, 0);
});

test('incapable actors are denied before mutation/catalog SQL and uploads are ownership-gated before multipart parsing', async () => {
  let queries = 0; const id = randomUUID(); let user = { uid: 'viewer', role: 'viewer', permissions: { editPages: true, publishPages: true } };
  const pool = { query: async () => { queries++; return { rows: [{ id, author_uid: 'other', archived_at: null }] }; } };
  const app = express(); app.use(express.json()); app.use('/api/pages', createPagesRouter({ pool, authenticate: (req,_res,next) => { req.user = user; next(); } }));
  for (const [method, route] of [['get','/job-titles'],['get','/manage'],['get','/categories'],['post','/'],['put',`/${id}/draft`],['post',`/${id}/publish`],['post',`/${id}/media`]]) assert.equal((await request(app)[method](`/api/pages${route}`).send({})).status, 403);
  assert.equal(queries, 0);
  user = { uid: 'admin', role: 'admin', permissions: { superAdmin: true } };
  const response = await request(app).post(`/api/pages/${id}/media`).set('Content-Type','multipart/form-data; boundary=bad').send('unparseable');
  assert.equal(response.status, 403); assert.equal(response.body.reason, 'author_only'); assert.equal(queries, 1);
});

test('router advertises strict per-instance document support without changing capabilities or old template versions', async () => {
  const id = randomUUID(), revisionId = randomUUID();
  const pool = { query: async () => ({ rows: [{ id, author_uid: 'author', draft_revision_id: revisionId, draft: { id: revisionId, document: { schema_version: 3 } } }] }) };
  for (const [flag, versions] of [[true, [1,2,3]], [false, [1,2]], ['true', [1,2]]]) {
    const app = express(); app.use('/api/pages', createPagesRouter({ pool, v3WritesEnabled: flag, authenticate: (req,_res,next) => { req.user = { uid: 'author', role: 'admin', permissions: { editPages: true } }; next(); } }));
    const response = await request(app).get(`/api/pages/${id}/workspace`);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.document_support, { read_versions: [1,2,3], write_versions: versions });
    assert.deepEqual(response.body.capabilities, { edit: true, publish: false, archive: false });
    const catalog = await request(app).get('/api/pages/templates');
    assert.deepEqual(catalog.body.map(item => [item.id, item.schema_version]), [['comunicado', 1], ['owner-news', 2], ...(flag===true?[['guia-interno',3]]:[])]);
  }
});

test('template catalog declares actual generated schemas; only boolean enabled advertises the guide', () => {
  for (const v3WritesEnabled of [false, true, 'true']) {
    const catalog = listTemplates({ v3WritesEnabled });
    assert.deepEqual(catalog.map(item => item.id), ['comunicado', 'owner-news', ...(v3WritesEnabled===true?['guia-interno']:[])]);
    for (const template of catalog) assert.equal(createTemplate(template.id).schema_version, template.schema_version);
  }
});

test('v3 deployment configuration stays explicitly disabled by default without altering pipeline scripts', async () => {
  const [env, compose] = await Promise.all(['.env.example', 'docker-compose.yml'].map(file => readFile(file, 'utf8')));
  assert.match(env, /^PAGES_V3_WRITES_ENABLED=false$/m);
  assert.match(compose, /PAGES_V3_WRITES_ENABLED: \$\{PAGES_V3_WRITES_ENABLED:-false\}/);
  assert.doesNotMatch(compose, /\r/);
});

test('download authenticates before validation and shares strict private-media query guards before SQL', async () => {
  const id = randomUUID(), mediaId = randomUUID(); let queries = 0, user = null;
  const app = express(); app.use('/api/pages', createPagesRouter({ pool: { query() { queries++; throw new Error('SQL forbidden'); } },
    authenticate: (req,res,next) => { if (!user) return res.status(401).json({ error: 'Authentication required.' }); req.user = user; next(); } }));
  assert.equal((await request(app).get('/api/pages/bad/media/bad/download')).status, 401);
  user = { uid: 'reader', role: 'viewer' };
  for (const suffix of ['?unknown=1','?preview=0',`?preview=1&revision_id=${randomUUID()}`, '?revision_id=bad', '?preview=1&preview=1']) {
    const response = await request(app).get(`/api/pages/${id}/media/${mediaId}/download${suffix}`);
    assert.ok([400,403].includes(response.status), suffix);
  }
  assert.equal((await request(app).get(`/api/pages/${id}/media/${mediaId}/download?preview=1`)).status, 403);
  assert.equal(queries, 0);
});
