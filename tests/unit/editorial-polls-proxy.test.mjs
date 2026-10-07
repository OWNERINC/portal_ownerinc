import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express'), request = require('supertest');
const { createEditorialInternalRouter } = require('./routes/editorial-internal');
const { createPollAdminRouter } = require('./routes/owner-news-polls');
const cookie = 'task9-unit-cookie', secret = 'task9-private-test-secret-'.repeat(3), id = '12345678-1234-4234-8234-123456789abc';
function fixture() {
  const state = { permission: true, revoked: false, firebaseCalls: 0, queries: [], writes: [] };
  const db = { async query(sql, params = []) {
    state.queries.push([sql, params]);
    if (sql.includes('FROM cms_editor_sessions')) return { rows: !state.revoked && params[0] === createHash('sha256').update(cookie).digest('hex') ? [{ uid: 'real-cookie-uid', expiresAt: new Date(Date.now() + 7200000) }] : [] };
    if (sql.includes('FROM users u')) return { rows: [{ uid: 'real-cookie-uid', email: 'unit@example.invalid', role: 'admin', permissions: { manageKnowledge: state.permission } }] };
    if (sql.startsWith('WITH filtered')) return { rows: [{ count: 0, rows: [] }] };
    if (sql.includes('FOR UPDATE')) return { rows: [{ id, version: 2, status: 'draft' }] };
    if (['BEGIN', 'ROLLBACK', 'COMMIT'].includes(sql)) { state.writes.push(sql); return { rows: [] }; }
    throw new Error('Unexpected SQL');
  }, async connect() { return { query: db.query, release() {} }; } };
  const firebaseAuth = { async verifySessionCookie(value, revoked) { state.firebaseCalls++; assert.equal(value, cookie); assert.equal(revoked, true); return { uid: 'real-cookie-uid', email_verified: true }; } };
  const app = express(); app.use(express.json());
  app.use('/api/internal/editorial', createEditorialInternalRouter({ db, firebaseAuth, env: { PORTAL_PUBLIC_URL: 'https://portal.example.test', PAYLOAD_TO_PORTAL_SECRET: secret } }));
  app.use('/normal', createPollAdminRouter({ db, authenticate(req, res, next) { req.user = { uid: 'bearer-uid', role: 'admin', permissions: { manageKnowledge: true } }; next(); } }));
  const api = request(app), call = (method, path = '', value = cookie) => api[method](`/api/internal/editorial/polls${path}`).set('Authorization', `Bearer ${secret}`).set('Cookie', `__Host-ownerinc-editorial=${value}`);
  return { state, api, call };
}
test('private poll router requires BOTH secret and resolved cookie, never a supplied actor', async () => {
  const { api, call, state } = fixture();
  await api.get('/api/internal/editorial/polls').expect(401);
  await api.get('/api/internal/editorial/polls').set('Authorization', `Bearer ${secret}`).expect(401);
  await call('get', '', 'forged').expect(401);
  await call('get', '?uid=admin').expect(400);
  const result = await call('get', '?limit=20&offset=0').set('X-User-UID', 'forged-admin').expect(200);
  assert.equal(result.headers['x-total-count'], '0'); assert.deepEqual(result.body, []);
  assert.equal(state.queries.find(([sql]) => sql.startsWith('WITH filtered'))[1][1], 'real-cookie-uid');
  state.permission = false; await call('get').expect(403);
  state.permission = true; state.revoked = true; await call('get').expect(401);
});
test('private and normal factory share exact version conflict and rollback domain', async () => {
  const { api, call, state } = fixture();
  const internal = await call('post', `/${id}/publish`).send({ expected_version: 1 }).expect(409);
  const normal = await api.post(`/normal/${id}/publish`).send({ expected_version: 1 }).expect(409);
  assert.deepEqual(internal.body, normal.body); assert.equal(internal.body.reason, 'version_conflict');
  assert.deepEqual(state.writes, ['BEGIN', 'ROLLBACK', 'BEGIN', 'ROLLBACK']);
  for (const path of [`/${id}/votes`, '/outside', `/${id}/delete`]) await call('post', path).send({}).expect(404);
  await call('post', `/${id}/publish?x=1`).send({ expected_version: 2 }).expect(400);
  await call('post', `/${id}/publish`).send({ expected_version: 2, uid: 'admin' }).expect(400);
});
