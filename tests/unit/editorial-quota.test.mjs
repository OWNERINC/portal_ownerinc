import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createDependencyHarness } from '../helpers/api-dependency-harness.mjs';

test('real index isolates bounded authenticated bridge quotas from public IP traffic and reserves revoke/job/authority capacity', async t => {
  const secret = 'synthetic-editorial-service-secret-'.repeat(2);
  const profiles = new Map(['a', 'b'].map(uid => [uid, {
    uid, email: `${uid}@example.test`, name: uid, role: 'admin', permissions: { manageKnowledge: true },
  }]));
  const hash = cookie => createHash('sha256').update(cookie).digest('hex');
  const sessions = new Map(['a', 'b'].map(uid => [hash(`cookie-${uid}`), { uid, expiresAt: new Date('2030-01-01') }]));
  let queries = 0;
  let verifications = 0;
  const h = await createDependencyHarness(t, {
    publicQuota: { max: 2 },
    editorial: {
      env: { PAYLOAD_TO_PORTAL_SECRET: secret },
      quota: { resolve: 4, revoke: 1, actor: 1, authority: 1, rejected: 2 },
      db: { async query(sql, values) {
        queries++;
        if (sql.includes('FROM cms_editor_sessions')) return { rows: sessions.has(values[0]) ? [sessions.get(values[0])] : [] };
        if (sql.includes('FROM users u')) return { rows: [profiles.get(values[0])] };
        if (sql.includes('UPDATE cms_editor_sessions')) return { rowCount: sessions.delete(values[0]) ? 1 : 0 };
        if (sql.includes('owner_news_authority')) return { rows: [{ mode: 'legacy', epoch: 1 }] };
        throw new Error('Unexpected bridge query');
      } },
      firebaseAuth: {
        async verifySessionCookie(cookie, checkRevoked) {
          verifications++;
          assert.equal(checkRevoked, true);
          return { uid: cookie.slice(-1), email_verified: true };
        },
        async getUser(uid) { return { uid, disabled: false, emailVerified: true }; },
      },
    },
  });
  const resolve = (uid, forwarded) => {
    const req = h.request.post('/api/internal/editorial/session/resolve').set('Authorization', `Bearer ${secret}`);
    if (forwarded) req.set('X-Forwarded-For', forwarded);
    return req.send({ cookie: `cookie-${uid}` });
  };
  const resolveAdmin = (uid, forwarded) => {
    const req = h.request.post('/api/internal/editorial/admin/session/resolve').set('Authorization', `Bearer ${secret}`);
    if (forwarded) req.set('X-Forwarded-For', forwarded);
    return req.send({ cookie: `cookie-${uid}` });
  };
  // Bad service credentials cannot spend valid-service capacity or perform even the first DB lookup.
  for (const status of [401, 401, 429]) {
    assert.equal((await h.request.post('/api/internal/editorial/session/resolve').send({ cookie: 'cookie-a' })).status, status);
  }
  assert.equal(queries, 0);
  assert.equal(verifications, 0);
  // Exactly the original public bucket behavior, with a deliberately tiny injected ceiling.
  assert.equal((await h.request.get('/api/health')).status, 200);
  assert.equal((await h.request.get('/api/health')).status, 200);
  assert.equal((await h.request.get('/api/health')).status, 429);
  // Both editors use the same socket IP as each other and as the exhausted public bucket.
  assert.equal((await resolve('a')).body.actor.uid, 'a');
  const generalActor = await resolveAdmin('b');
  assert.equal(generalActor.status, 200);
  assert.deepEqual(generalActor.body.actor, {
    version: 2, uid: 'b', email: 'b@example.test', name: 'b',
    capabilities: { manageKnowledge: true, manageAcademy: false, manageBenefits: false, manageReminders: false },
  });
  profiles.get('a').permissions = {};
  assert.equal((await resolve('a')).status, 403, 'current policy is still consulted on each resolution');
  assert.equal((await resolve('b')).status, 200);
  const beforeLimit = queries;
  const overLimit = await resolveAdmin('b', '203.0.113.92');
  assert.equal(overLimit.status, 429, 'forwarded browser IP cannot reset the service quota');
  assert.equal(overLimit.headers['cache-control'], 'no-store');
  assert.equal(queries, beforeLimit, 'over-quota requests stop before DB/Firebase work');
  assert.equal(verifications, 4, 'no authorization cache');

  const authority = () => h.request.get('/api/internal/editorial/authority').set('Authorization', `Bearer ${secret}`);
  assert.deepEqual((await authority()).body, { mode: 'legacy', epoch: 1 });
  assert.equal((await authority()).status, 429);
  const actor = () => h.request.post('/api/internal/editorial/actor/check').set('Authorization', `Bearer ${secret}`).send({ uid: 'b' });
  assert.equal((await actor()).body.actor.uid, 'b');
  assert.equal((await actor()).status, 429);
  const revoke = () => h.request.post('/api/internal/editorial/session/revoke').set('Authorization', `Bearer ${secret}`).send({ cookie: 'cookie-a' });
  assert.equal((await revoke()).status, 204, 'resolve exhaustion does not prevent confirmed logout');
  assert.equal(sessions.has(hash('cookie-a')), false);
  assert.equal((await revoke()).status, 429);
  assert.equal((await h.request.get('/api/internal/editorial/unknown').set('Authorization', `Bearer ${secret}`)).status, 404);
});
