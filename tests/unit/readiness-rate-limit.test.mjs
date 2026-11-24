import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { load, response, root, routes } from '../helpers/readiness-harness.mjs';

const security = load('api/middleware/security.js');
const pass = (req, res, next) => next();

function harness({ user, queryError } = {}) {
  const queries = [], verifications = [];
  const pool = { async query(sql, params) {
    queries.push({ sql, params });
    if (queryError) throw queryError;
    if (sql.includes('FROM pending_registrations')) return { rows: [{ status: 'pending' }] };
    const row = user ? user(params[0]) : { uid: params[0], permissions: {}, ethics_accepted: true };
    return { rows: row ? [row] : [] };
  } };
  const { authMiddleware } = load('api/middleware/auth.js', {
    '../db': pool,
    'firebase-admin/app': { getApps: () => [{}] },
    'firebase-admin/auth': { getAuth: () => ({ async verifyIdToken(token, revoked) {
      verifications.push({ token, revoked });
      if (['invalid', 'revoked'].includes(token)) throw new Error(token);
      return { uid: token.split(':')[0], untrustedClaim: 'not a database permission' };
    } }) },
  });
  let aggregate;
  const app = { set() {}, disable() {}, get() {}, use() {} };
  const express = Object.assign(() => app, { json: () => pass, static: () => pass });
  const index = readFileSync(new URL('api/index.js', root), 'utf8');
  const routeOverrides = Object.fromEntries([...index.matchAll(/require\('(\.\/routes\/[^']+)'\)/g)]
    .map(([, name]) => [name, pass]));
  load('api/index.js', {
    ...routeOverrides, express, dotenv: { config() {} }, './db': pool,
    './middleware/security': {
      ...security, validateEnvironment() {},
      rateLimit(options) { aggregate = security.rateLimit(options); return aggregate; },
    },
  });
  async function hit(token, options = {}) {
    const req = {
      id: 'readiness', ip: '192.0.2.1', method: 'GET', originalUrl: '/api/knowledge',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '198.51.100.9' },
      ...options,
    };
    const res = response();
    let continued = false, error, continuation;
    aggregate(req, res, () => { continuation = authMiddleware(req, res, caught => {
      error = caught;
      continued = !caught;
    }); });
    await continuation;
    return { req, res, continued, error };
  }
  return { hit, queries, verifications, aggregate };
}

async function clock(run) {
  const original = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try { await run(delta => { now += delta; }); }
  finally { Date.now = original; }
}

test('100 verified UIDs on one IP can each make five initial requests', async () => {
  const h = harness();
  for (let round = 0; round < 5; round++) {
    for (let uid = 0; uid < 100; uid++) {
      const result = await h.hit(`uid-${uid}`);
      assert.equal(result.res.statusCode, 200, `round ${round}, UID ${uid}`);
      assert.equal(result.continued, true);
      assert.equal(result.req.user.uid, `uid-${uid}`);
    }
  }
  assert.equal(h.verifications.length, 500);
  assert.ok(h.verifications.every(item => item.revoked === true));
});

test('UID budget survives token refresh, IP changes and spoofed request identity; other UID is independent', async () => {
  await clock(async advance => {
    const h = harness();
    for (let i = 0; i < 300; i++) assert.equal((await h.hit(`abuser:${i}`)).continued, true);
    const denied = await h.hit('abuser:fresh', { ip: '192.0.2.2', user: { uid: 'spoof' }, firebaseUser: { uid: 'spoof' } });
    assert.equal(denied.res.statusCode, 429);
    assert.deepEqual(denied.res.body, { error: 'Too many requests.', requestId: 'readiness' });
    assert.equal(denied.res.headers['Retry-After'], '900');
    assert.equal(h.queries.length, 300, 'budget checked before account query');
    assert.equal((await h.hit('independent')).continued, true);
    advance(899001);
    assert.equal((await h.hit('abuser')).res.headers['Retry-After'], '1');
    advance(999);
    assert.equal((await h.hit('abuser')).continued, true);
  });
});

test('aggregate IP budget remains bounded at 30000 and retains its original window', async () => {
  await clock(async advance => {
    const { aggregate } = harness();
    const hit = () => {
      const res = response();
      let allowed = false;
      aggregate({ ip: '192.0.2.3', id: 'ip' }, res, () => { allowed = true; });
      return { res, allowed };
    };
    for (let i = 0; i < 30000; i++) assert.equal(hit().allowed, true);
    assert.equal(hit().res.headers['Retry-After'], '900');
    advance(899999);
    assert.equal(hit().res.headers['Retry-After'], '1');
    advance(1);
    assert.equal(hit().allowed, true);
  });
});

test('invalid, revoked and missing tokens cannot reach SQL or acquire verified UID access', async () => {
  const h = harness();
  for (const token of ['invalid', 'revoked']) {
    const result = await h.hit(token);
    assert.equal(result.res.statusCode, 401);
    assert.equal(result.continued, false);
    assert.equal(result.req.firebaseUser, undefined);
  }
  assert.equal((await h.hit('', { headers: {} })).res.statusCode, 401);
  assert.equal(h.queries.length, 0);
  assert.equal((await h.hit('valid')).continued, true);
});

test('verified traffic still enforces disabled, pending approval, enable pending and ethics gates', async () => {
  const h = harness({ user(uid) {
    if (uid === 'pending') return null;
    return {
      uid, role: 'admin', permissions: { superAdmin: true, accountDisabled: uid === 'disabled' },
      firebase_enable_pending: uid === 'enable', ethics_accepted: uid !== 'ethics',
    };
  } });
  for (const [uid, reason] of [['disabled', 'account-disabled'], ['pending', 'pending-approval'], ['enable', 'enable-pending'], ['ethics', 'ethics-required']]) {
    const result = await h.hit(uid);
    assert.equal(result.res.statusCode, 403);
    assert.equal(result.res.body.reason, reason);
    assert.equal(result.continued, false);
    assert.equal(result.req.user, undefined);
  }
  assert.equal((await h.hit('ethics', { originalUrl: '/api/ethics' })).continued, true);
});

test('async account lookup failures reach next exactly through the awaited auth continuation', async () => {
  const failure = new Error('synthetic SQL unavailable');
  const result = await harness({ queryError: failure }).hit('valid');
  assert.equal(result.error, failure);
  assert.equal(result.continued, false);
});

test('write and Academy progress UID budgets remain 60 and 120', async () => {
  const h = harness();
  for (const [uid, max, url, method] of [
    ['writer', 60, '/api/users/me', 'PUT'],
    ['learner', 120, '/api/academy/lessons/10000000-0000-4000-8000-000000000001/progress', 'PUT'],
  ]) {
    for (let i = 0; i < max; i++) assert.equal((await h.hit(uid, { method, originalUrl: url })).continued, true);
    const result = await h.hit(uid, { method, originalUrl: url });
    assert.equal(result.res.statusCode, 429);
    assert.equal(result.res.headers['Retry-After'], '900');
  }
});

test('Nginx shared-network budgets preserve upload, API and media zones with LF', () => {
  const source = readFileSync(new URL('nginx/nginx.conf', root), 'utf8');
  assert.ok(!source.includes('\r'));
  assert.match(source, /zone=api:10m rate=20r\/s/);
  assert.match(source, /zone=uploads:10m rate=60r\/m/);
  assert.match(source, /zone=media_reads:10m rate=60r\/s/);
  const directives = [...source.matchAll(/limit_req zone=(\w+) burst=(\d+) nodelay;/g)];
  assert.equal(directives.length, 15);
  for (const [, zone, burst] of directives) assert.equal(burst, zone === 'uploads' ? '20' : '500');
});

test('photo keeps 10/UID/15m, registration permits 300/IP/hour and recovery keeps 5/IP/hour', async () => {
  await clock(async advance => {
    const photo = routes(), auth = routes();
    const multer = () => ({ single: () => pass });
    multer.memoryStorage = () => ({});
    load('api/routes/upload.js', {
      express: { Router: () => photo.router }, multer, '../db': {},
      '../middleware/auth': { authMiddleware: pass },
    });
    load('api/routes/auth.js', {
      express: { Router: () => auth.router }, '../db': {},
      '../middleware/auth': { firebaseAuth: {} },
      '../integrations/password-reset-email': {},
      '../services/pending-registration': {},
      '../services/user-invitation': {},
    });
    const hit = (limiter, uid = 'user', ip = '192.0.2.8') => {
      const res = response();
      let allowed = false;
      limiter({ user: { uid }, ip, id: 'specialized' }, res, () => { allowed = true; });
      return { res, allowed };
    };
    const photoLimit = photo.handlers('post', '/photo')[1];
    for (let i = 0; i < 10; i++) assert.equal(hit(photoLimit).allowed, true);
    assert.equal(hit(photoLimit).res.headers['Retry-After'], '900');
    assert.equal(hit(photoLimit, 'another').allowed, true);
    for (const path of ['/register', '/password-reset', '/registration-password']) {
      const limiter = auth.handlers('post', path)[0];
      const max = path === '/register' ? 300 : 5;
      for (let i = 0; i < max; i++) assert.equal(hit(limiter, `uid-${i}`).allowed, true);
      const denied = hit(limiter, 'new-uid');
      assert.equal(denied.res.statusCode, 429);
      assert.equal(denied.res.headers['Retry-After'], '3600');
      assert.equal(hit(limiter, 'user', '192.0.2.9').allowed, true);
      advance(3600000);
      assert.equal(hit(limiter).allowed, true);
    }
    assert.equal(hit(photoLimit).allowed, true);
  });
});
