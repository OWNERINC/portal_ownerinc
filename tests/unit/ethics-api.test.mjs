import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { ethicsHarness, term } from '../helpers/ethics-api.mjs';

const require = createRequire(import.meta.url);
const { isEthicsBootstrapRequest } = require('../../api/ethics');
const payload = { version: term.version, contentHash: term.contentHash, accepted: true };

for (const account of ['viewer', 'admin', 'super']) {
  test(`${account}: existing accounts start pending and all protected methods require their own acceptance`, async () => {
    const { request, state } = await ethicsHarness();
    const me = await request.get('/api/users/me').auth(account, { type: 'bearer' }).expect(200);
    assert.equal(me.body.ethics_accepted, false);
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const blocked = await request[method]('/api/protected').auth(account, { type: 'bearer' }).expect(403);
      assert.equal(blocked.body.reason, 'ethics-required');
    }
    const document = await request.get('/api/ethics').auth(account, { type: 'bearer' }).expect(200);
    assert.deepEqual(document.body, { term, accepted: false });
    assert.equal(term.mock, true);
    assert.match(term.notice, /não é o Código de Ética oficial/);
    const accepted = await request.post('/api/ethics/accept').auth(account, { type: 'bearer' }).send(payload).expect(200);
    assert.equal(accepted.body.accepted, true);
    assert.equal(state.acceptances.size, 1);
    assert.equal([...state.acceptances.values()][0].is_mock, true);
    const retried = await request.post('/api/ethics/accept').auth(account, { type: 'bearer' }).send(payload).expect(200);
    assert.deepEqual(retried.body, accepted.body);
    assert.equal(state.acceptances.size, 1);
    await request.get('/api/protected').auth(account, { type: 'bearer' }).expect(200);
    const after = await request.get('/api/users/me').auth(account, { type: 'bearer' }).expect(200);
    assert.equal(after.body.ethics_accepted, true);
    const other = account === 'viewer' ? 'super' : 'viewer';
    await request.get('/api/protected').auth(other, { type: 'bearer' }).expect(403);
    // A new content hash or version, even with the same UID, is not accepted.
    state.acceptances.clear();
    state.acceptances.set(`${account}:official-v1:${term.contentHash}`, {});
    state.acceptances.set(`${account}:${term.version}:${'0'.repeat(64)}`, {});
    await request.get('/api/protected').auth(account, { type: 'bearer' }).expect(403);
    assert.ok(state.sql.some(({ sql, params }) => /ea.term_version = \$2 AND ea.content_sha256 = \$3/.test(sql)
      && params[0] === account && params[1] === term.version && params[2] === term.contentHash));
  });
}

test('acceptance rejects unchecked, malformed, stale and client-attributed payloads without a write', async () => {
  const { request, state } = await ethicsHarness();
  for (const body of [null, [], {}, { ...payload, accepted: false }, { ...payload, accepted: 'true' },
    { ...payload, uid: 'super' }, { ...payload, acceptedAt: '2000-01-01' }, { ...payload, version: 1 }]) {
    await request.post('/api/ethics/accept').auth('viewer', { type: 'bearer' }).send(body).expect(400);
  }
  for (const body of [{ ...payload, version: 'official-v1' }, { ...payload, contentHash: '0'.repeat(64) }]) {
    const response = await request.post('/api/ethics/accept').auth('super', { type: 'bearer' }).send(body).expect(409);
    assert.equal(response.body.reason, 'ethics-version-changed');
  }
  assert.equal(state.acceptances.size, 0);
  assert.equal(state.sql.some(({ sql }) => /INSERT INTO ethics_acceptances/.test(sql)), false);
});

test('authentication/account status are still mandatory; outages fail closed', async () => {
  const { request, state } = await ethicsHarness();
  await request.get('/api/ethics').expect(401);
  await request.post('/api/ethics/accept').send(payload).expect(401);
  await request.get('/api/ethics').auth('unknown', { type: 'bearer' }).expect(401);
  state.users.get('viewer').permissions.accountDisabled = true;
  const denied = await request.post('/api/ethics/accept').auth('viewer', { type: 'bearer' }).send(payload).expect(403);
  assert.equal(denied.body.reason, 'account-disabled');
  state.users.get('admin').firebase_enable_pending = true;
  await request.get('/api/ethics').auth('admin', { type: 'bearer' }).expect(403);
  state.fail = true;
  await request.get('/api/protected').auth('super', { type: 'bearer' }).expect(503);
  await request.post('/api/ethics/accept').auth('super', { type: 'bearer' }).send(payload).expect(503);
  assert.equal(state.acceptances.size, 0);
});

test('bootstrap exemptions match only exact routes and methods', () => {
  for (const [method, path] of [['GET', '/api/users/me'], ['GET', '/api/users/me?x=1'], ['GET', '/api/ethics'], ['POST', '/api/ethics/accept']]) {
    assert.equal(isEthicsBootstrapRequest(method, path), true);
  }
  for (const [method, path] of [['PUT', '/api/users/me'], ['GET', '/api/users'], ['DELETE', '/api/ethics/accept'],
    ['POST', '/api/ethics'], ['GET', '/api/ethics/accept'], ['GET', '/api/users/me/extra'], ['GET', '/api/ethics/../protected']]) {
    assert.equal(isEthicsBootstrapRequest(method, path), false);
  }
});

test('schema and migration agree; no backfill, cron access or mutable acceptance grant', async () => {
  const schema = await readFile('api/db/schema.sql', 'utf8');
  const migration = await readFile('api/db/migrations/039_ethics_acceptances.sql', 'utf8');
  const provision = await readFile('api/db/provision.js', 'utf8');
  const table = source => source.match(/CREATE TABLE IF NOT EXISTS ethics_acceptances \([\s\S]*?\n\);/)[0];
  assert.equal(table(schema), table(migration));
  assert.match(migration, /REFERENCES users\(uid\) ON DELETE CASCADE/);
  assert.match(migration, /accepted_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.doesNotMatch(migration, /INSERT INTO ethics_acceptances/);
  for (const source of [migration, provision]) {
    assert.match(source, /GRANT SELECT, INSERT ON ethics_acceptances TO portal_api/);
    assert.doesNotMatch(source, /GRANT[^;]*ethics_acceptances[^;]*TO portal_cron/);
  }
});
