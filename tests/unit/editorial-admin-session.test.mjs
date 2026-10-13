import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
const express = apiRequire('express');
const request = apiRequire('supertest');
const { safeResponses } = require('../../api/middleware/security.js');
const { createEditorialSessionRouter } = require('../../api/routes/editorial-session.js');
const { createEditorialAdminSessionRouter } = require('../../api/routes/editorial-admin-session.js');
const { createEditorialInternalRouter } = require('../../api/routes/editorial-internal.js');

const origin = 'https://portal.example.test';
const secret = 'fixture-portal-bridge-secret-0123456789';
const env = { PORTAL_PUBLIC_URL: origin, CMS_INTERNAL_URL: 'https://cms.example.test', PAYLOAD_TO_PORTAL_SECRET: secret };
const allowed = ['manageKnowledge', 'manageAcademy', 'manageBenefits', 'manageReminders'];
const profile = (uid = 'editor-a', permissions = { manageKnowledge: true }, changes = {}) => ({
  uid, email: `${uid}@example.test`, name: 'Portal Editor', role: 'admin', permissions,
  firebase_enable_pending: false, ...changes,
});
function fixture(settings = env, { runtimeReady = true, fetchImpl, readinessTimeoutMs } = {}) {
  const users = new Map([['editor-a', profile()], ['editor-b', profile('editor-b')]]);
  const sessions = new Map();
  const queries = [];
  const events = [];
  const state = { users, sessions, queries, events, runtimeReady, readinessRequests: [], nextCookie: 0,
    unverified: false, firebaseError: null, settings };
  state.db = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.startsWith('SET LOCAL') ||
        sql.includes('pg_advisory_xact_lock') || sql.includes('pg_sleep')) return { rows: [] };
      if (sql.startsWith('SELECT token_hash')) return { rows: sessions.has(values[0]) ? [{ token_hash: values[0] }] : [] };
      if (sql.includes('INSERT INTO cms_editor_sessions')) {
        const [key, uid, expiresAt] = values;
        if (sessions.has(key)) throw new Error('unique session hash');
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
        return { rows: row && !row.revoked && row.expiresAt > new Date() ? [row] : [] };
      }
      if (sql.includes('FROM users u')) return { rows: users.has(values[0]) ? [users.get(values[0])] : [] };
      if (sql.includes('pending_registrations')) return { rows: state.pending ? [{ status: 'pending' }] : [] };
      if (sql.includes('owner_news_authority')) return { rows: [{ mode: 'payload', epoch: 1 }] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async connect() {
      events.push('transaction-connect');
      let snapshot;
      return {
        async query(sql, values) {
          if (sql === 'BEGIN') snapshot = new Map([...sessions].map(([key, value]) => [key, { ...value }]));
          if (sql === 'ROLLBACK') {
            sessions.clear();
            for (const [key, value] of snapshot) sessions.set(key, value);
          }
          return state.db.query(sql, values);
        },
        release() {},
      };
    },
  };
  state.firebaseAuth = {
    async verifyIdToken(uid, checkRevoked) {
      assert.equal(checkRevoked, true);
      if (state.firebaseError) throw state.firebaseError;
      return { uid, email_verified: !state.unverified };
    },
    async createSessionCookie(uid, options) {
      assert.deepEqual(options, { expiresIn: 7200000 });
      if (state.firebaseError) throw state.firebaseError;
      return `${uid}.session-${++state.nextCookie}`;
    },
    async verifySessionCookie(cookie, checkRevoked) {
      assert.equal(checkRevoked, true);
      if (state.firebaseError) throw state.firebaseError;
      return { uid: cookie.split('.')[0], email_verified: !state.unverified };
    },
    async getUser(uid) { return { uid, emailVerified: !state.unverified, disabled: false }; },
  };

  // Run the actual Bearer middleware and active Portal-profile loader; isolate only Firebase Admin setup and pg.
  const authFile = new URL('../../api/middleware/auth.js', import.meta.url);
  const localRequire = createRequire(authFile);
  const authModule = { exports: {} };
  new Function('require', 'module', 'exports', readFileSync(authFile, 'utf8'))(name => {
    if (name === 'firebase-admin/app') return { getApps: () => [1] };
    if (name === 'firebase-admin/auth') return { getAuth: () => state.firebaseAuth };
    if (name === '../db') return state.db;
    return localRequire(name);
  }, authModule, authModule.exports);

  const app = express();
  app.use(safeResponses);
  app.use('/api/cms/session', createEditorialSessionRouter({ ...state, ...authModule.exports, env: settings,
    fetchImpl: fetchImpl || (async (url, options) => {
      events.push('readiness');
      state.readinessRequests.push({ url, options });
      if (!state.runtimeReady) return Response.json({ status: 'unavailable' }, { status: 503 });
      return Response.json({ status: 'ready' });
    }), readinessTimeoutMs }));
  app.use('/api/cms/v2/session', createEditorialAdminSessionRouter({ ...state, ...authModule.exports, env: settings,
    fetchImpl: fetchImpl || (async (url, options) => {
      events.push('readiness');
      state.readinessRequests.push({ url, options });
      if (!state.runtimeReady) return Response.json({ status: 'unavailable' }, { status: 503 });
      return Response.json({ status: 'ready' });
    }), readinessTimeoutMs }));
  app.use('/api/internal/editorial', createEditorialInternalRouter({ ...state, env: settings }));
  state.request = request(app);
  state.login = (uid = 'editor-a', previousCookie, sessionPath = '/api/cms/v2/session', suppliedOrigin = origin) => {
    let call = state.request.post(sessionPath).set('Authorization', `Bearer ${uid}`);
    if (suppliedOrigin !== false) call = call.set('Origin', suppliedOrigin);
    if (previousCookie) call = call.set('Cookie', previousCookie);
    return call;
  };
  state.internal = (route, authorization = `Bearer ${secret}`) => state.request.post(`/api/internal/editorial${route}`)
    .set('Authorization', authorization);
  return state;
}

function cookieFrom(response) {
  assert.ok(response.headers['set-cookie']?.[0], 'session response sets its HTTP-only cookie');
  return response.headers['set-cookie'][0].split(';')[0];
}

function expectedCapabilities(permission) {
  return Object.fromEntries(allowed.map(key => [key, key === permission]));
}

test('v2 availability reports admin permission and runtime independently of News authority', async () => {
  const state = fixture({ PORTAL_PUBLIC_URL: origin, CMS_INTERNAL_URL: env.CMS_INTERNAL_URL });
  const availability = () => state.request.get('/api/cms/v2/session/availability').set('Authorization', 'Bearer editor-a');
  assert.equal((await state.request.get('/api/cms/v2/session/availability')).status, 401);
  assert.equal(state.events.includes('readiness'), false, 'availability does not probe before Portal authentication');
  const ready = await availability();
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.body, { version: 2, adminEntryAllowed: true, runtimeAvailable: true, canEnterAdmin: true });
  assert.equal(state.readinessRequests[0].url, 'https://cms.example.test/editorial/ready');
  assert.equal(state.queries.some(({ sql }) => sql.includes('owner_news_authority')), false);

  state.runtimeReady = false;
  assert.deepEqual((await availability()).body,
    { version: 2, adminEntryAllowed: false, runtimeAvailable: false, canEnterAdmin: true });
  state.users.get('editor-a').permissions = { manageUsers: true };
  state.runtimeReady = true;
  assert.deepEqual((await availability()).body,
    { version: 2, adminEntryAllowed: false, runtimeAvailable: true, canEnterAdmin: false });
  assert.equal(state.queries.some(({ sql }) => sql.includes('owner_news_authority')), false);
});

for (const permission of allowed) {
  test(`v2 issues and resolves an exact general actor for ${permission}`, async () => {
    const state = fixture();
    state.users.set('editor-a', profile('editor-a', { [permission]: true }));
    const issued = await state.login();
    assert.equal(issued.status, 201);
    const expectedActor = { version: 2, uid: 'editor-a', email: 'editor-a@example.test', name: 'Portal Editor',
      capabilities: expectedCapabilities(permission) };
    assert.deepEqual(issued.body, { actor: expectedActor, expiresAt: issued.body.expiresAt });
    assert.equal(typeof issued.body.expiresAt, 'string');
    assert.match(cookieFrom(issued), /^__Host-ownerinc-editorial=/u);
    assert.ok(state.events.indexOf('readiness') >= 0);
    assert.ok(state.events.indexOf('readiness') < state.events.indexOf('transaction-connect'), 'runtime readiness precedes session transaction');
    assert.equal(state.queries.some(({ sql }) => sql.includes('owner_news_authority')), false);

    const cookie = cookieFrom(issued);
    const resolved = await state.request.get('/api/cms/v2/session').set('Cookie', cookie);
    assert.equal(resolved.status, 200);
    assert.deepEqual(resolved.body, { actor: expectedActor, expiresAt: issued.body.expiresAt });
    const internal = await state.internal('/admin/session/resolve').send({ cookie: cookie.split('=')[1] });
    assert.equal(internal.status, 200);
    assert.deepEqual(internal.body, { actor: expectedActor, expiresAt: issued.body.expiresAt });
    assert.equal(state.queries.some(({ sql }) => sql.includes('owner_news_authority')), false);
  });
}

test('v2 rejects role-only, manageUsers-only, and non-admin users without any fixed capability', async () => {
  for (const [label, user] of [
    ['role only', profile('editor-a', {})],
    ['manageUsers only', profile('editor-a', { manageUsers: true })],
    ['unrelated permission only', profile('editor-a', { manageSolides: true })],
    ['viewer with a capability bit', profile('editor-a', { manageKnowledge: true }, { role: 'viewer' })],
  ]) {
    const state = fixture();
    state.users.set('editor-a', user);
    const availability = await state.request.get('/api/cms/v2/session/availability').set('Authorization', 'Bearer editor-a');
    assert.equal(availability.status, 200, label);
    assert.deepEqual(availability.body, { version: 2, adminEntryAllowed: false, runtimeAvailable: true, canEnterAdmin: false }, label);
    const issue = await state.login().send({
      role: 'admin', permissions: { manageKnowledge: true, manageAcademy: true, manageBenefits: true, manageReminders: true },
      actor: { version: 2, capabilities: Object.fromEntries(allowed.map(key => [key, true])) },
    });
    assert.equal(issue.status, 403, label);
    assert.equal(issue.body.reason, 'editorial_permission_denied', label);
    assert.equal(issue.headers['set-cookie'], undefined, label);
    assert.equal(state.events.includes('transaction-connect'), false, label);
  }
});

test('v2 issuance requires verified active Portal accounts and checks readiness before transactional issuance', async () => {
  const state = fixture();
  state.runtimeReady = false;
  const unavailable = await state.login();
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.reason, 'editorial_unavailable');
  assert.equal(unavailable.headers['set-cookie'], undefined);
  assert.equal(state.events.includes('transaction-connect'), false);
  assert.equal(state.queries.some(({ sql }) => sql.includes('owner_news_authority')), false);

  state.runtimeReady = true;
  state.unverified = true;
  assert.equal((await state.login()).status, 403);
  state.unverified = false;
  state.users.delete('editor-a');
  const inactive = await state.login();
  assert.equal(inactive.status, 403);
  assert.match(inactive.body.error, /not active/iu);
  assert.equal(state.events.includes('transaction-connect'), false);
});

test('v2 resolution reloads current capabilities and active/verified status on every request', async () => {
  const state = fixture();
  state.users.set('editor-a', profile('editor-a', { manageAcademy: true }));
  const issued = await state.login();
  const cookie = cookieFrom(issued);
  const get = () => state.request.get('/api/cms/v2/session').set('Cookie', cookie);
  assert.equal((await get()).status, 200);

  state.users.get('editor-a').permissions = {};
  assert.equal((await get()).status, 403, 'permission removal is enforced immediately');
  state.users.get('editor-a').permissions = { manageBenefits: true };
  const changed = await get();
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.actor.capabilities, expectedCapabilities('manageBenefits'));

  state.unverified = true;
  assert.equal((await get()).status, 403, 'email verification is rechecked from Firebase on resolve');
  state.unverified = false;
  state.users.get('editor-a').permissions = { manageBenefits: true, accountDisabled: true };
  assert.equal((await get()).status, 403, 'account disablement is rechecked from the Portal profile');
  state.users.delete('editor-a');
  assert.equal((await get()).status, 403, 'deleted Portal profiles cannot keep an admin session');
});

test('v1 and v2 share the revocable cookie but apply their current, distinct authorization projections', async () => {
  const state = fixture();
  state.users.set('editor-a', profile('editor-a', { manageAcademy: true }));
  const issued = await state.login();
  const cookie = cookieFrom(issued);
  const value = cookie.split('=')[1];

  assert.equal((await state.request.get('/api/cms/v2/session').set('Cookie', cookie)).status, 200);
  assert.equal((await state.request.get('/api/cms/session').set('Cookie', cookie)).status, 403,
    'a v2-only Academy grant does not grant News access');
  const newsInternal = await state.internal('/session/resolve').send({ cookie: value });
  assert.equal(newsInternal.status, 403);
  assert.equal((await state.internal('/admin/session/resolve').send({ cookie: value })).status, 200);

  state.users.get('editor-a').permissions.manageKnowledge = true;
  const newsRead = await state.request.get('/api/cms/session').set('Cookie', cookie);
  assert.equal(newsRead.status, 200);
  assert.deepEqual(Object.keys(newsRead.body).sort(), ['expiresAt', 'uid'], 'v1 public response remains exact');
  const newsResolved = await state.internal('/session/resolve').send({ cookie: value });
  assert.deepEqual(newsResolved.body.actor,
    { uid: 'editor-a', email: 'editor-a@example.test', name: 'Portal Editor', canManageNews: true },
    'v1 internal News actor DTO remains exact');

  const rotated = await state.login('editor-a', cookie);
  assert.equal(rotated.status, 201);
  const rotatedCookie = cookieFrom(rotated);
  assert.equal((await state.request.get('/api/cms/v2/session').set('Cookie', cookie)).status, 401,
    'v2 rotation revokes the old shared cookie');
  assert.equal((await state.request.get('/api/cms/session').set('Cookie', cookie)).status, 401);
  assert.equal((await state.request.get('/api/cms/v2/session').set('Cookie', rotatedCookie)).status, 200);

  const logout = await state.request.delete('/api/cms/v2/session').set('Origin', origin).set('Cookie', rotatedCookie);
  assert.equal(logout.status, 204);
  assert.equal((await state.request.get('/api/cms/v2/session').set('Cookie', rotatedCookie)).status, 401);
  assert.equal((await state.request.get('/api/cms/session').set('Cookie', rotatedCookie)).status, 401);
  assert.equal((await state.internal('/admin/session/resolve').send({ cookie: rotatedCookie.split('=')[1] })).status, 401);
});

test('v2 public mutations enforce exact Origin, service secret, and bounded failure responses', async () => {
  const state = fixture();
  for (const suppliedOrigin of [false, 'https://other.example.test', `${origin}/`, 'null']) {
    assert.equal((await state.login('editor-a', undefined, '/api/cms/v2/session', suppliedOrigin)).status, 403);
  }
  assert.equal((await state.request.post('/api/cms/v2/session').set('Origin', origin)
    .set('Sec-Fetch-Site', 'cross-site').set('Authorization', 'Bearer editor-a')).status, 403);
  assert.equal((await state.request.delete('/api/cms/v2/session').set('Cookie', '__Host-ownerinc-editorial=x')
    .set('Origin', 'https://other.example.test')).status, 403);
  assert.equal(state.events.includes('readiness'), false);
  assert.equal(state.events.includes('transaction-connect'), false);

  const missingBridge = fixture({ PORTAL_PUBLIC_URL: origin, CMS_INTERNAL_URL: env.CMS_INTERNAL_URL });
  const blocked = await missingBridge.login();
  assert.equal(blocked.status, 503);
  assert.equal(blocked.body.reason, 'editorial_unavailable');
  assert.equal(missingBridge.events.includes('transaction-connect'), false);
  assert.doesNotMatch(JSON.stringify(blocked.body), /secret|cookie|private/i);
});

test('internal v2 resolution uses service authentication, exact cookie bodies, and the shared bounded resolve lane', async () => {
  const state = fixture();
  const cookie = cookieFrom(await state.login());
  const rawCookie = cookie.split('=')[1];
  for (const authorization of ['', 'Bearer wrong', 'Bearer editor-a']) {
    assert.equal((await state.internal('/admin/session/resolve', authorization).send({ cookie: rawCookie })).status, 401);
  }
  assert.equal((await state.internal('/admin/session/resolve').send({ cookie: rawCookie, actor: { capabilities: {} } })).status, 400);
  assert.equal((await state.internal('/admin/session/resolve').send({ cookie: 'x'.repeat(16384) })).status, 413);

  const resolved = await state.internal('/admin/session/resolve').send({ cookie: rawCookie });
  assert.equal(resolved.status, 200);
  assert.deepEqual(Object.keys(resolved.body).sort(), ['actor', 'expiresAt']);
  assert.deepEqual(Object.keys(resolved.body.actor).sort(), ['capabilities', 'email', 'name', 'uid', 'version']);
  assert.equal(resolved.body.actor.version, 2);
  assert.equal(JSON.stringify(resolved.body).includes(rawCookie), false);
  assert.equal(state.queries.some(({ sql }) => sql.includes('owner_news_authority')), false);
});
