import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { apiRequire, load, root } from '../helpers/readiness-harness.mjs';

// Intentionally optional/external: no project dependency and no database URL.
assert.ok(process.env.PGLITE_MODULE_PATH, 'Set PGLITE_MODULE_PATH to an externally installed PGlite module');
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE_PATH).href);
const pg = apiRequire('pg');
const { prepareValue } = apiRequire('pg/lib/utils');
const db = new PGlite({ parsers: { 1184: pg.types.getTypeParser(1184, 'text') } });
console.log('Disposable in-memory PGlite + pg timestamp parser/bind + fake Firebase; NOT native PostgreSQL 16.');
const firebase = new Map(), firebaseDeletes = [], deleteBinds = [], batches = [];
let failDelete = null, releases = 0;
const firebaseAuth = {
  async getUser(uid) {
    if (!firebase.has(uid)) throw Object.assign(new Error('Synthetic missing user'), { code: 'auth/user-not-found' });
    return { uid, ...firebase.get(uid) };
  },
  async deleteUser(uid) {
    if (uid === failDelete) throw new Error('Synthetic Firebase outage');
    assert.ok(firebase.has(uid));
    firebase.delete(uid);
    firebaseDeletes.push(uid);
  },
  async updateUser(uid, data) { firebase.set(uid, { ...firebase.get(uid), ...data }); },
};
const invitation = load('api/services/user-invitation.js', {
  '../middleware/auth': { firebaseAuth }, '../integrations/password-reset-email': {},
});
const pending = load('api/services/pending-registration.js', {
  '../middleware/auth': { firebaseAuth }, '../integrations/password-reset-email': {},
  './user-invitation': invitation,
});
const client = {
  async query(sql, params = []) {
    const bound = params.map(value => prepareValue(value));
    const result = await db.query(sql, bound);
    const rowCount = /^\s*SELECT\b/i.test(sql) ? result.rows.length : result.affectedRows ?? result.rows.length;
    if (sql.includes('LIMIT 100')) batches.push(result.rows.map(item => item.firebase_uid));
    if (/^\s*DELETE FROM pending_registrations/.test(sql)) {
      deleteBinds.push({ uid: params[1], key: params[3], rowCount });
    }
    return { rows: result.rows, rowCount };
  },
  release(discard) { assert.ok(!discard); releases++; },
};
const pool = { connect: async () => client, query: (...args) => client.query(...args) };
async function seed(uid, timestamp, status = 'pending', reviewedAt = null) {
  const email = `${uid}@example.invalid`;
  await db.query(`INSERT INTO pending_registrations (id, firebase_uid, email, name, status, created_at, reviewed_at)
    VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7::timestamptz)`,
  [randomUUID(), uid, email, 'Synthetic person', status, timestamp, reviewedAt]);
  firebase.set(uid, { email });
}
async function reset() {
  await db.exec('TRUNCATE pending_registrations, firebase_cleanup_queue, users;');
  firebase.clear(); firebaseDeletes.length = 0; deleteBinds.length = 0; batches.length = 0;
}
const expire = requestId => pending.expirePendingRegistrations({ pool, requestId, retentionDays: 730 });
try {
  await db.exec('CREATE TABLE users (uid TEXT PRIMARY KEY, email TEXT);');
  for (const name of ['025_pending_registrations.sql', '027_pending_registration_cleanup.sql', '028_firebase_cleanup_queue.sql']) {
    await db.exec(await readFile(new URL(`api/db/migrations/${name}`, root), 'utf8'));
  }
  const now = (await db.query('SELECT NOW()::text AS value')).rows[0].value;
  for (const status of ['pending', 'rejected', 'approved']) {
    await seed(`${status}-micro`, '2020-01-01 00:00:00.123456+00', status);
    await seed(`${status}-aligned`, '2020-01-01 00:00:00.123000+00', status);
  }
  await seed('recent', now);
  await seed('approved-recent-review', '2020-01-01 00:00:00.123456+00', 'approved', now);
  await seed('referenced', '2020-01-01 00:00:00.123456+00');
  await db.query('INSERT INTO users (uid,email) VALUES ($1,$2)', ['referenced', 'referenced@example.invalid']);
  assert.deepEqual(await expire('mixed'), { deleted: 6, failed: 1 });
  assert.deepEqual((await db.query('SELECT firebase_uid FROM pending_registrations ORDER BY firebase_uid')).rows.map(item => item.firebase_uid),
    ['approved-recent-review', 'recent', 'referenced']);
  assert.equal(firebaseDeletes.length, 4, 'approved identities must not be deleted externally');
  assert.equal(firebase.has('recent'), true);
  assert.equal(firebase.has('referenced'), true);
  assert.equal(firebase.has('approved-micro'), true);
  assert.ok(deleteBinds.every(item => typeof item.key === 'string' && item.rowCount === 1));
  assert.ok(deleteBinds.some(item => item.key.includes('.123456')));
  assert.ok(deleteBinds.some(item => /\.123(?:000)?\+/.test(item.key)));
  console.log('PASS: exact microseconds/aligned keys, pending/rejected/approved, recent/referenced protection');

  await reset();
  await seed('retry', '2020-01-01 00:00:00.123456+00');
  failDelete = 'retry';
  assert.deepEqual(await expire('retry-fails'), { deleted: 0, failed: 1 });
  assert.equal((await db.query('SELECT firebase_cleanup_pending FROM pending_registrations')).rows[0].firebase_cleanup_pending, true);
  assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM firebase_cleanup_queue')).rows[0].count, 1);
  failDelete = null;
  assert.deepEqual(await expire('retry-recovers'), { deleted: 1, failed: 0 });
  assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM firebase_cleanup_queue')).rows[0].count, 0);
  console.log('PASS: external cleanup failure stays retryable and succeeds later');

  await reset();
  for (let i = 0; i < 100; i++) await seed(`micro-${i}`, '2020-01-01 00:00:00.123456+00');
  await seed('later-101', '2020-01-02 00:00:00.123000+00');
  assert.deepEqual(await expire('batch-first'), { deleted: 100, failed: 0 });
  assert.deepEqual(await expire('batch-second'), { deleted: 1, failed: 0 });
  assert.deepEqual(batches.map(batch => batch.length), [100, 1]);
  assert.deepEqual(batches[1], ['later-101']);
  assert.equal((await db.query('SELECT COUNT(*)::int AS count FROM pending_registrations')).rows[0].count, 0);
  assert.equal(firebase.size, 0);
  assert.equal(releases, 5);
  console.log('PASS: first 100 removed; second run reaches record 101; five owned clients released');
} finally {
  await db.close();
}
