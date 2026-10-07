import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { resolveEditorialSession, issueEditorialSession, checkEditorialActor } = require('../../api/editorial-session/service.js');
const { loadActivePortalUser } = require('../../api/middleware/active-user.js');
const { editorialCookieConfig } = require('../../api/editorial-session/origin.js');
const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
const express = apiRequire('express');
const request = apiRequire('supertest');
const { createEditorialSessionRouter } = require('../../api/routes/editorial-session.js');
const { createEditorialInternalRouter } = require('../../api/routes/editorial-internal.js');
const { safeResponses } = require('../../api/middleware/security.js');
const origin = 'https://portal.example.test';
const env = { PORTAL_PUBLIC_URL: origin, CMS_INTERNAL_URL: 'https://cms.example.test', PAYLOAD_TO_PORTAL_SECRET: 'fixture-portal-bridge-secret-'.repeat(2) };
const now = new Date('2026-10-02T12:00:00.000Z');
const profile = (uid = 'editor-a', changes = {}) => ({ uid, email: `${uid}@example.test`, name: 'Editor',
  role: 'admin', permissions: { manageKnowledge: true }, firebase_enable_pending: false, ...changes });
const hash = cookie => createHash('sha256').update(cookie).digest('hex');
function fixture() {
  const users = new Map([['editor-a', profile()], ['editor-b', profile('editor-b')]]);
  const sessions = new Map();
  const calls = [];
  const state = { users, sessions, calls, dbError: false, firebaseError: null, nextCookie: 0, unverified: false,
    authorityMode: 'payload', runtimeReady: true, readinessRequests: [] };
  state.db = { async query(sql, values = []) {
    calls.push({ sql, values });
    if (state.dbError) throw new Error('private db details');
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SET LOCAL') ||
      sql.includes('pg_advisory_xact_lock') || sql.includes('pg_sleep')) return { rows: [] };
    if (sql.startsWith('SELECT token_hash')) return { rows: sessions.has(values[0]) ? [{ token_hash: values[0] }] : [] };
    if (sql.includes('INSERT INTO cms_editor_sessions')) {
      const [key, uid, expiresAt] = values;
      if (sessions.has(key)) throw new Error('unique');
      const row = { uid, expiresAt };
      sessions.set(key, row);
      return { rows: [row] };
    }
    if (sql.includes('UPDATE cms_editor_sessions')) {
      const row = sessions.get(values[0]);
      if (!row || row.revoked) return { rowCount: 0 };
      row.revoked = true;
      return { rowCount: 1 };
    }
    if (sql.includes('FROM cms_editor_sessions')) {
      const row = sessions.get(values[0]);
      return { rows: row && !row.revoked && row.expiresAt > now ? [row] : [] };
    }
    if (sql.includes('FROM users u')) return { rows: users.has(values[0]) ? [users.get(values[0])] : [] };
    if (sql.includes('pending_registrations')) return { rows: state.pending ? [{ status: 'pending' }] : [] };
    if (sql.includes('owner_news_authority')) return { rows: [{ mode: state.authorityMode, epoch: 1 }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  state.db.connect = async () => {
    if (state.dbError) throw new Error('private connect failure');
    let snapshot;
    return { async query(sql, values) {
      if (sql === 'BEGIN') snapshot = structuredClone(sessions);
      if (sql === 'ROLLBACK') { sessions.clear(); for (const [key, value] of snapshot) sessions.set(key, value); }
      return state.db.query(sql, values);
    }, release(error) { calls.push({ release: true, error: Boolean(error) }); } };
  };
  state.firebaseAuth = {
    async verifyIdToken(token, checkRevoked) {
      assert.equal(checkRevoked, true);
      if (state.firebaseError) throw state.firebaseError;
      if (!users.has(token)) throw Object.assign(new Error('private token'), { code: 'auth/invalid-id-token' });
      return { uid: token, email_verified: !state.unverified };
    },
    async createSessionCookie(token, options) {
      calls.push({ firebase: 'createSessionCookie' });
      assert.deepEqual(options, { expiresIn: 7200000 });
      if (state.firebaseError) throw state.firebaseError;
      return state.fixedCookie || `${token}.${++state.nextCookie}`;
    },
    async verifySessionCookie(cookie, checkRevoked) {
      calls.push({ firebase: 'verifySessionCookie', cookie, checkRevoked });
      assert.equal(checkRevoked, true);
      if (state.firebaseError) throw state.firebaseError;
      return { uid: cookie.split('.')[0], email_verified: !state.unverified };
    },
    async getUser(uid) {
      calls.push({ firebase: 'getUser', uid });
      if (state.firebaseError) throw state.firebaseError;
      return { uid, emailVerified: !state.unverified, disabled: state.disabled === true };
    },
  };
  return state;
}
async function httpFixture(settings = env, { fetchImpl, readinessTimeoutMs } = {}) {
  const state = fixture();
  // Execute the real Bearer middleware; only Firebase initialization and pg are doubled.
  const filename = new URL('../../api/middleware/auth.js', import.meta.url);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', await readFile(filename, 'utf8'))(name => {
    if (name === 'firebase-admin/app') return { getApps: () => [1] };
    if (name === 'firebase-admin/auth') return { getAuth: () => state.firebaseAuth };
    if (name === '../db') return state.db;
    return localRequire(name);
  }, module, module.exports);
  const app = express();
  app.use(safeResponses);
  app.use('/api/cms/session', createEditorialSessionRouter({ ...state, ...module.exports, env: settings,
    fetchImpl: fetchImpl || (async (url, options) => {
      state.readinessRequests.push({ url, options });
      if (!state.runtimeReady) return Response.json({ status: 'unavailable' }, { status: 503 });
      return Response.json({ status: 'ready' });
    }), readinessTimeoutMs }));
  app.use('/api/internal/editorial', createEditorialInternalRouter({ ...state, env: settings }));
  app.get('/api/legacy', module.exports.authMiddleware, (req, res) => res.json({ uid: req.user.uid }));
  state.request = request(app);
  state.login = (uid = 'editor-a', cookie) => {
    const call = state.request.post('/api/cms/session').set('Origin', origin).set('Authorization', `Bearer ${uid}`);
    if (cookie) call.set('Cookie', cookie);
    return call;
  };
  state.internal = path => state.request.post(`/api/internal/editorial${path}`).set('Authorization', `Bearer ${env.PAYLOAD_TO_PORTAL_SECRET}`);
  return state;
}

test('revalida a revogação Firebase em toda resolução', async () => {
  let calls = 0;
  const firebaseAuth = { async verifySessionCookie(cookie, revoked) {
    assert.equal(revoked, true); calls++;
    throw Object.assign(new Error('revoked'), { code: 'auth/session-cookie-revoked' });
  } };
  const cookie = 'synthetic-cookie';
  const hash = createHash('sha256').update(cookie).digest('hex');
  const db = { async query() { return { rows: [{ token_hash: hash,
    uid: 'editor-a', expiresAt: new Date('2030-01-01') }] }; } };
  for (let index = 0; index < 2; index++) {
    await assert.rejects(resolveEditorialSession({ firebaseAuth, db, cookie, now: new Date('2026-10-02') }),
      error => error.status === 401);
  }
  assert.equal(calls, 2);
});

test('issuance uses the exact lifetime and stores only SHA-256; expiry is ISO and UID mismatch fails closed', async () => {
  const state = fixture();
  const result = await issueEditorialSession({ ...state, token: 'editor-a', user: profile(), now });
  assert.equal(result.expiresAt, '2026-10-02T14:00:00.000Z');
  assert.deepEqual(state.calls.find(call => call.sql?.includes('INSERT INTO cms_editor_sessions')).values,
    [hash(result.cookie), 'editor-a', new Date(result.expiresAt)]);
  assert.ok(state.calls.findIndex(call => call.sql?.includes('pg_sleep')) < state.calls.findIndex(call => call.firebase));
  assert.ok(state.calls.findIndex(call => call.sql === 'COMMIT') > state.calls.findIndex(call => call.sql?.includes('INSERT INTO')));
  assert.deepEqual(await resolveEditorialSession({ ...state, cookie: result.cookie, now }), {
    actor: { uid: 'editor-a', email: 'editor-a@example.test', name: 'Editor', canManageNews: true }, expiresAt: result.expiresAt,
  });
  state.sessions.get(hash(result.cookie)).uid = 'editor-b';
  await assert.rejects(resolveEditorialSession({ ...state, cookie: result.cookie, now }), { status: 401 });
});

test('active profile helper preserves pending/disabled/email/cargo checks without broadening policy', async () => {
  const state = fixture();
  state.users.set('editor-a', profile('editor-a', { job_title_active: true, job_title_access: { autocard: true, posCards: false } }));
  const user = await loadActivePortalUser(state.db, { uid: 'editor-a', email_verified: true });
  assert.equal(user.autocard_access, true);
  assert.equal(user.pos_cards_access, false);
  assert.match(state.calls[0].sql, /LEFT JOIN job_titles/);
  await assert.rejects(loadActivePortalUser(state.db, { uid: 'editor-a', email_verified: false }), { status: 403, reason: 'email-not-verified' });
  state.users.clear();
  state.pending = true;
  await assert.rejects(loadActivePortalUser(state.db, { uid: 'editor-a', email_verified: true }), { status: 403, reason: 'pending-approval' });
  state.pending = false;
  await assert.rejects(loadActivePortalUser(state.db, { uid: 'editor-a', email_verified: true }), { status: 403, message: 'Account is not active.' });
});

test('expired and absent hashes fail before Firebase, and Firebase invalid/disabled failures retain distinct statuses', async () => {
  const state = fixture();
  const cookie = 'editor-a.expired';
  for (const record of [undefined, { uid: 'editor-a', expiresAt: now }, { uid: 'editor-a', expiresAt: new Date(now.getTime() - 1) }]) {
    if (record) state.sessions.set(hash(cookie), record);
    await assert.rejects(resolveEditorialSession({ ...state, cookie, now }), { status: 401 });
  }
  assert.ok(!state.calls.some(call => call.firebase));
  state.sessions.set(hash(cookie), { uid: 'editor-a', expiresAt: new Date('2030-01-01') });
  for (const [code, status] of [['auth/session-cookie-expired', 401], ['auth/argument-error', 401], ['auth/user-disabled', 403], ['auth/user-not-found', 401]]) {
    state.firebaseError = { code };
    await assert.rejects(resolveEditorialSession({ ...state, cookie, now }), { status });
  }
});

test('HTTP issuance/read/rotation/logout keep account isolation and never return raw cookies in JSON', async () => {
  const state = await httpFixture();
  const first = await state.login();
  assert.equal(first.status, 201);
  assert.deepEqual(Object.keys(first.body).sort(), ['expiresAt', 'uid']);
  assert.equal(first.headers['cache-control'], 'no-store');
  const cookieA = first.headers['set-cookie'][0].split(';')[0];
  assert.match(first.headers['set-cookie'][0], /^__Host-ownerinc-editorial=.*; Path=\/; Expires=.*; HttpOnly; Secure; SameSite=Lax$/);
  const read = await state.request.get('/api/cms/session').set('Cookie', cookieA);
  assert.equal(read.status, 200);
  assert.deepEqual(read.body, first.body);
  assert.equal(read.headers['set-cookie'], undefined);
  const second = await state.login('editor-b', cookieA);
  assert.equal(second.status, 201);
  const cookieB = second.headers['set-cookie'][0].split(';')[0];
  assert.equal((await state.request.get('/api/cms/session').set('Cookie', cookieA)).status, 401);
  assert.equal((await state.request.get('/api/cms/session').set('Cookie', cookieB)).body.uid, 'editor-b');
  for (let attempt = 0; attempt < 2; attempt++) {
    const logout = await state.request.delete('/api/cms/session').set('Origin', origin).set('Cookie', cookieB);
    assert.equal(logout.status, 204);
    assert.match(logout.headers['set-cookie'][0], /Expires=Thu, 01 Jan 1970/);
  }
  assert.equal((await state.request.get('/api/cms/session').set('Cookie', cookieB)).status, 401);
});

test('availability is Portal-authenticated and reports source activation separately from Payload runtime readiness', async () => {
  const state = await httpFixture();
  assert.equal((await state.request.get('/api/cms/session/availability')).status, 401);
  const availability = () => state.request.get('/api/cms/session/availability').set('Authorization', 'Bearer editor-a');
  const active = await availability();
  assert.equal(active.status, 200);
  assert.deepEqual(active.body, { mode: 'payload', epoch: 1, activated: true, runtimeReady: true, canEnter: true });
  assert.equal(active.headers['cache-control'], 'no-store');
  assert.equal(state.readinessRequests.at(-1).url, 'https://cms.example.test/editorial/ready');
  assert.equal(state.readinessRequests.at(-1).options.redirect, 'error');

  state.runtimeReady = false;
  const runtimeDown = await availability();
  assert.equal(runtimeDown.status, 200);
  assert.deepEqual(runtimeDown.body, { mode: 'payload', epoch: 1, activated: true, runtimeReady: false, canEnter: false });

  state.authorityMode = 'legacy';
  const notActivated = await availability();
  assert.deepEqual(notActivated.body, { mode: 'legacy', epoch: 1, activated: false, runtimeReady: false, canEnter: false });

  state.users.get('editor-a').permissions = {};
  const denied = await state.request.get('/api/cms/session/availability').set('Authorization', 'Bearer editor-a');
  assert.equal(denied.status, 403);
  assert.equal(denied.body.reason, 'editorial_permission_denied');
});

test('readiness probe is fixed-route, response-size bounded and timeout bounded', async () => {
  let unexpectedCalls = 0;
  const invalidTarget = await httpFixture({ ...env, CMS_INTERNAL_URL: 'https://cms.example.test/other/path' }, {
    fetchImpl: async () => { unexpectedCalls += 1; return Response.json({ status: 'ready' }); },
  });
  const unavailable = await invalidTarget.request.get('/api/cms/session/availability').set('Authorization', 'Bearer editor-a');
  assert.equal(unavailable.body.runtimeReady, false);
  assert.equal(unexpectedCalls, 0, 'the configured service base must be an origin, not an arbitrary route');

  const timed = await httpFixture(env, { readinessTimeoutMs: 100, fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(new Error('aborted'));
    else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  const started = Date.now();
  const timeoutResponse = await timed.request.get('/api/cms/session/availability').set('Authorization', 'Bearer editor-a');
  assert.ok(Date.now() - started < 1000);
  assert.equal(timeoutResponse.body.runtimeReady, false);

  const slowAuthority = await httpFixture(env, { readinessTimeoutMs: 10 });
  const query = slowAuthority.db.query;
  slowAuthority.db.query = (sql, values) => sql.includes('owner_news_authority') ? new Promise(() => {}) : query(sql, values);
  const authorityStarted = Date.now();
  const authorityTimeout = await slowAuthority.request.get('/api/cms/session/availability').set('Authorization', 'Bearer editor-a');
  assert.ok(Date.now() - authorityStarted < 1000);
  assert.equal(authorityTimeout.status, 503);
  assert.equal(authorityTimeout.body.reason, 'editorial_unavailable');

  const oversized = await httpFixture(env, { fetchImpl: async () => new Response(' '.repeat(257), { headers: { 'Content-Type': 'application/json' } }) });
  const oversizedResponse = await oversized.request.get('/api/cms/session/availability').set('Authorization', 'Bearer editor-a');
  assert.equal(oversizedResponse.body.runtimeReady, false);
});

test('session issuance rechecks activation and runtime before creating an editorial cookie', async () => {
  const state = await httpFixture();
  state.authorityMode = 'legacy';
  const notActivated = await state.login();
  assert.equal(notActivated.status, 409);
  assert.equal(notActivated.body.reason, 'editorial_not_activated');
  assert.equal(notActivated.headers['set-cookie'], undefined);
  assert.equal(state.sessions.size, 0);

  state.authorityMode = 'payload';
  state.runtimeReady = false;
  const unavailable = await state.login();
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.reason, 'editorial_unavailable');
  assert.equal(unavailable.headers['set-cookie'], undefined);
  assert.equal(state.sessions.size, 0);

  state.runtimeReady = true;
  assert.equal((await state.login()).status, 201);
});

for (const [label, overrides, unverified, expected] of [
  ['viewer', { role: 'viewer' }, false, 403],
  ['permission missing', { permissions: {} }, false, 403],
  ['permission string', { permissions: { manageKnowledge: 'true' } }, false, 403],
  ['superadmin', { permissions: { superAdmin: true } }, false, 201],
  ['unverified', {}, true, 403],
  ['disabled boolean', { permissions: { manageKnowledge: true, accountDisabled: true } }, false, 403],
  ['disabled string', { permissions: { superAdmin: true, accountDisabled: 'true' } }, false, 403],
  ['enable pending', { firebase_enable_pending: true }, false, 403],
]) test(`HTTP permission policy: ${label}`, async () => {
  const state = await httpFixture();
  state.users.set('editor-a', profile('editor-a', overrides));
  state.unverified = unverified;
  const response = await state.login();
  assert.equal(response.status, expected);
  if (expected !== 201) assert.equal(response.headers['set-cookie'], undefined);
});

test('HTTP resolution observes permission removal, Firebase revocation and dependency outages per request', async () => {
  const state = await httpFixture();
  const cookie = (await state.login()).headers['set-cookie'][0].split(';')[0];
  const get = () => state.request.get('/api/cms/session').set('Cookie', cookie);
  state.users.get('editor-a').permissions = {};
  assert.equal((await get()).status, 403);
  state.users.get('editor-a').permissions = { manageKnowledge: true };
  assert.equal((await get()).status, 200);
  state.firebaseError = { code: 'auth/session-cookie-revoked' };
  assert.equal((await get()).status, 401);
  state.firebaseError = { code: 'auth/internal-error', message: 'private upstream text' };
  assert.equal((await get()).status, 503);
  state.firebaseError = null;
  state.dbError = true;
  const failed = await get();
  assert.equal(failed.status, 503);
  assert.equal(failed.body.reason, 'editorial_unavailable');
  assert.doesNotMatch(JSON.stringify(failed.body), /private|cookie/);
});

test('HTTP exact Origin and fetch-site guard every public mutation before effects', async () => {
  const state = await httpFixture();
  for (const method of ['post', 'delete']) {
    for (const supplied of [undefined, 'https://other.example.test', `${origin}/`, 'null']) {
      let call = state.request[method]('/api/cms/session').set('Authorization', 'Bearer editor-a');
      if (supplied !== undefined) call = call.set('Origin', supplied);
      assert.equal((await call).status, 403);
    }
    assert.equal((await state.request[method]('/api/cms/session').set('Origin', origin).set('Sec-Fetch-Site', 'cross-site')).status, 403);
  }
  assert.equal(state.calls.length, 0);
});

test('HTTP rejects forged/duplicate/wrong-environment cookies and oversized or malformed bodies', async () => {
  const state = await httpFixture();
  for (const cookie of ['__Host-ownerinc-editorial=forged', 'ownerinc-editorial-dev=editor-a.1',
    '__Host-ownerinc-editorial=a; __Host-ownerinc-editorial=b']) {
    assert.equal((await state.request.get('/api/cms/session').set('Cookie', cookie)).status, 401);
  }
  const huge = await state.login().send({ cookie: 'x'.repeat(16384) });
  assert.equal(huge.status, 413);
  assert.equal(huge.headers['set-cookie'], undefined);
  const invalid = await state.login().set('Content-Type', 'application/json').send('{"private-token":');
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(JSON.stringify(invalid.body), /private-token/);
});

test('HTTP INSERT failure and Firebase dependency failure never set a browser cookie', async () => {
  const state = await httpFixture();
  const query = state.db.query;
  state.db.query = async (sql, params) => {
    if (sql.includes('INSERT INTO cms_editor_sessions')) throw new Error('private insert error');
    return query(sql, params);
  };
  const failed = await state.login();
  assert.equal(failed.status, 503);
  assert.equal(failed.headers['set-cookie'], undefined);
  state.firebaseError = { code: 'app/network-error' };
  const firebase = await state.login();
  assert.equal(firebase.status, 503);
  assert.equal(firebase.headers['set-cookie'], undefined);
});

test('HTTP failed revocation does not expire or replace the cookie or claim confirmed logout', async () => {
  const state = await httpFixture();
  const cookie = (await state.login()).headers['set-cookie'][0].split(';')[0];
  const query = state.db.query;
  state.db.query = async (sql, params) => {
    if (sql.includes('UPDATE cms_editor_sessions')) throw new Error('private db error');
    return query(sql, params);
  };
  const logout = await state.request.delete('/api/cms/session').set('Origin', origin).set('Cookie', cookie);
  assert.equal(logout.status, 503);
  assert.equal(logout.headers['set-cookie'], undefined);
  const rotation = await state.login('editor-b', cookie);
  assert.equal(rotation.status, 503);
  assert.equal(rotation.headers['set-cookie'], undefined);
  assert.equal((await state.request.get('/api/cms/session').set('Cookie', cookie)).body.uid, 'editor-a');
});

test('identical provider output gets one attempt and controlled rollback, preserving the usable previous cookie', async () => {
  const state = await httpFixture();
  state.fixedCookie = 'editor-a.identical';
  const first = await state.login();
  const cookie = first.headers['set-cookie'][0].split(';')[0];
  for (const previous of [cookie, undefined]) {
    const response = await state.login('editor-a', previous);
    assert.equal(response.status, 503);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal((await state.request.get('/api/cms/session').set('Cookie', cookie)).status, 200);
    assert.equal(state.sessions.size, 1);
  }
  assert.equal(state.calls.filter(call => call.firebase === 'createSessionCookie').length, 3, 'no issuance retry');
  assert.equal(state.calls.filter(call => call.sql === 'ROLLBACK').length, 2);
  await state.request.delete('/api/cms/session').set('Origin', origin).set('Cookie', cookie);
  assert.equal((await state.login()).status, 503);
  assert.equal((await state.request.get('/api/cms/session').set('Cookie', cookie)).status, 401, 'no revived revoked hash');
});

for (const failingStep of ['INSERT INTO cms_editor_sessions', 'COMMIT', 'empty RETURNING']) {
  test(`replacement ${failingStep} failure rolls back old revocation and candidate insert`, async () => {
    const state = await httpFixture();
    const cookie = (await state.login()).headers['set-cookie'][0].split(';')[0];
    const query = state.db.query;
    state.db.query = async (sql, params) => {
      if (failingStep === 'empty RETURNING' && sql.includes('INSERT INTO cms_editor_sessions')) return { rows: [] };
      if (sql.includes(failingStep)) throw new Error('private transaction failure');
      return query(sql, params);
    };
    const failed = await state.login('editor-b', cookie);
    assert.equal(failed.status, 503);
    assert.equal(failed.headers['set-cookie'], undefined);
    assert.equal(state.sessions.size, 1);
    assert.equal((await state.request.get('/api/cms/session').set('Cookie', cookie)).status, 200);
    assert.ok(state.calls.some(call => call.sql === 'ROLLBACK'));
    assert.ok(state.calls.some(call => call.release));
  });
}

test('pre-issuance serialization failure never mints and provider failure never revokes', async () => {
  const state = await httpFixture();
  const cookie = (await state.login()).headers['set-cookie'][0].split(';')[0];
  const query = state.db.query;
  state.db.query = async (sql, params) => {
    if (sql.includes('pg_advisory_xact_lock')) throw new Error('lock timeout');
    return query(sql, params);
  };
  assert.equal((await state.login('editor-a', cookie)).status, 503);
  assert.equal(state.calls.filter(call => call.firebase === 'createSessionCookie').length, 1);
  state.db.query = query;
  state.firebaseAuth.createSessionCookie = async () => { throw { code: 'auth/internal-error' }; };
  assert.equal((await state.login('editor-a', cookie)).status, 503);
  assert.equal((await state.request.get('/api/cms/session').set('Cookie', cookie)).status, 200);
  assert.equal(state.sessions.size, 1);
});

test('HTTP private endpoints require a dedicated service secret, return exact contracts and never accept body actors', async () => {
  const state = await httpFixture();
  const cookie = (await state.login()).headers['set-cookie'][0].split(';')[0].split('=')[1];
  for (const path of ['/session/resolve', '/session/revoke', '/actor/check']) {
    for (const secret of ['', 'Bearer wrong', 'Bearer editor-a']) {
      assert.equal((await state.request.post(`/api/internal/editorial${path}`).set('Authorization', secret).send({ cookie })).status, 401);
    }
  }
  const resolved = await state.internal('/session/resolve').send({ cookie });
  assert.equal(resolved.status, 200);
  assert.deepEqual(resolved.body.actor, { uid: 'editor-a', email: 'editor-a@example.test', name: 'Editor', canManageNews: true });
  assert.equal(typeof resolved.body.expiresAt, 'string');
  assert.equal((await state.internal('/actor/check').send({ uid: 'editor-a', actor: { canManageNews: true } })).status, 400);
  assert.equal((await state.internal('/session/resolve').send({ cookie: 'x'.repeat(16384) })).status, 413);
  assert.equal((await state.request.get('/api/internal/editorial/authority')).status, 401);
  state.authorityMode = 'legacy';
  const authority = await state.request.get('/api/internal/editorial/authority').set('Authorization', `Bearer ${env.PAYLOAD_TO_PORTAL_SECRET}`);
  assert.deepEqual(authority.body, { mode: 'legacy', epoch: 1 });
  assert.equal((await state.internal('/session/revoke').send({ cookie })).status, 204);
  assert.equal((await state.internal('/session/resolve').send({ cookie })).status, 401);
  // Job actor authorization is independent of browser-session lifetime.
  assert.equal((await state.internal('/actor/check').send({ uid: 'editor-a' })).status, 200);
  state.users.get('editor-a').permissions = {};
  assert.equal((await state.internal('/actor/check').send({ uid: 'editor-a' })).status, 403);
});

test('job actor check verifies Firebase current identity, email, disabled and current Portal profile', async () => {
  const state = fixture();
  assert.equal((await checkEditorialActor({ ...state, uid: 'editor-a' })).canManageNews, true);
  assert.ok(state.calls.some(call => call.firebase === 'getUser'));
  state.unverified = true;
  await assert.rejects(checkEditorialActor({ ...state, uid: 'editor-a' }), { status: 403, reason: 'email-not-verified' });
  state.unverified = false;
  state.disabled = true;
  await assert.rejects(checkEditorialActor({ ...state, uid: 'editor-a' }), { status: 403, reason: 'account-disabled' });
  state.firebaseError = { code: 'app/network-error' };
  await assert.rejects(checkEditorialActor({ ...state, uid: 'editor-a' }), { status: 503 });
});

test('optional CMS configuration is checked at the bridge boundary and legacy Bearer auth still works', async () => {
  const state = await httpFixture({});
  assert.equal((await state.request.get('/api/legacy').set('Authorization', 'Bearer editor-a')).status, 200);
  state.authorityMode = 'legacy';
  const availability = await state.request.get('/api/cms/session/availability').set('Authorization', 'Bearer editor-a');
  assert.equal(availability.status, 200, 'legacy authority availability does not require optional Payload bridge or cookie config');
  assert.deepEqual(availability.body, { mode: 'legacy', epoch: 1, activated: false, runtimeReady: false, canEnter: false });
  assert.equal(state.readinessRequests.length, 0, 'missing CMS_INTERNAL_URL fails closed without a network request');
  assert.equal((await state.request.get('/api/cms/session')).status, 503);
  assert.equal((await state.login()).status, 503, 'session issuance still requires its bridge configuration');
  assert.equal((await state.internal('/actor/check').send({ uid: 'editor-a' })).status, 503);
});

test('cookie exception is restricted to development plus HTTP loopback', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const config = editorialCookieConfig({ NODE_ENV: 'development', PORTAL_PUBLIC_URL: `http://${host}:8080` });
    assert.equal(config.name, 'ownerinc-editorial-dev');
    assert.equal(config.options.secure, false);
  }
  for (const settings of [ { NODE_ENV: 'production', PORTAL_PUBLIC_URL: 'http://localhost:8080' },
    { NODE_ENV: 'development', PORTAL_PUBLIC_URL: 'http://portal.example.test' } ]) assert.throws(() => editorialCookieConfig(settings), { status: 503 });
  assert.equal(editorialCookieConfig({ NODE_ENV: 'development', PORTAL_PUBLIC_URL: origin }).name, '__Host-ownerinc-editorial');
});
