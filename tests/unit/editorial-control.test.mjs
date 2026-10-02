import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writerAllowed, getAuthority, assertNewsWriter } = require('../../api/owner-news/authority.js');
const { createSessionRecord, findSessionRecord, revokeSessionRecord } = require('../../api/editorial-session/store.js');

for (const [mode, legacy, payload] of [
  ['legacy', true, false], ['frozen', false, false],
  ['payload', false, true], ['payload_frozen', false, false],
]) {
  test(`autoridade ${mode}`, async () => {
    assert.equal(writerAllowed(mode, 'legacy'), legacy);
    assert.equal(writerAllowed(mode, 'payload'), payload);
    for (const [writer, allowed] of [['legacy', legacy], ['payload', payload]]) {
      const db = scriptedDb([
        [sql => assert.match(sql, /pg_advisory_xact_lock/), { rows: [] }],
        [sql => assert.match(sql, /FOR UPDATE/), { rows: [{ mode, epoch: 3 }] }],
      ]);
      if (allowed) assert.deepEqual(await assertNewsWriter(db, writer), { mode, epoch: 3 });
      else await assert.rejects(assertNewsWriter(db, writer), { status: 409, code: 'news_read_only' });
      db.done();
    }
  });
}

function scriptedDb(steps) {
  let index = 0;
  return {
    async query(sql, values) {
      assert.ok(index < steps.length, `Unexpected query: ${sql}`);
      const [check, result] = steps[index++];
      check(sql.replace(/\s+/g, ' ').trim(), values);
      if (result instanceof Error) throw result;
      return result;
    },
    done() { assert.equal(index, steps.length, 'Every expected DB operation completed'); },
  };
}

test('unknown authority modes and writers never authorize writes', () => {
  for (const mode of [undefined, null, '', 'LEGACY', 'other']) {
    assert.equal(writerAllowed(mode, 'legacy'), false);
    assert.equal(writerAllowed(mode, 'payload'), false);
  }
  for (const writer of [undefined, null, '', 'admin', 'PAYLOAD']) {
    assert.equal(writerAllowed('legacy', writer), false);
    assert.equal(writerAllowed('payload', writer), false);
  }
});

test('ordinary authority read returns the shared contract without requesting a lock', async () => {
  const db = scriptedDb([
    [sql => {
      assert.match(sql, /^SELECT mode, epoch FROM owner_news_authority WHERE singleton\s*=\s*TRUE$/);
    }, { rows: [{ mode: 'payload_frozen', epoch: 7 }] }],
  ]);
  assert.deepEqual(await getAuthority(db), { mode: 'payload_frozen', epoch: 7 });
  db.done();
});

test('locked authority read waits for CMS lock 7193029 before locking the singleton', async () => {
  let unlock;
  const pendingLock = new Promise(resolve => { unlock = resolve; });
  let calls = 0;
  const db = { async query(sql, values) {
    calls += 1;
    if (calls === 1) {
      assert.match(sql, /pg_advisory_xact_lock/);
      assert.deepEqual(values, [7193029]);
      await pendingLock;
      return { rows: [] };
    }
    assert.equal(calls, 2);
    assert.match(sql, /WHERE singleton\s*=\s*TRUE FOR UPDATE$/);
    return { rows: [{ mode: 'legacy', epoch: 1 }] };
  } };
  const result = getAuthority(db, { forUpdate: true });
  await Promise.resolve();
  assert.equal(calls, 1);
  unlock();
  assert.deepEqual(await result, { mode: 'legacy', epoch: 1 });
  assert.equal(calls, 2);
});

test('missing or invalid authority is an explicit failure, never a legacy fallback', async () => {
  for (const rows of [[], [{ mode: 'other', epoch: 1 }], [{ mode: 'legacy', epoch: 0 }]]) {
    await assert.rejects(getAuthority({ async query() { return { rows }; } }),
      { status: 503, code: 'news_authority_unavailable' });
  }
  const missingTable = Object.assign(new Error('missing relation'), { code: '42P01' });
  await assert.rejects(getAuthority({ async query() { throw missingTable; } }), error => error === missingTable);
});

test('writer assertion fails closed on missing authority and lock errors', async () => {
  const db = scriptedDb([
    [() => {}, { rows: [] }], [() => {}, { rows: [] }],
  ]);
  await assert.rejects(assertNewsWriter(db, 'legacy'), { status: 503, code: 'news_authority_unavailable' });
  db.done();
  const failure = new Error('lock failed');
  const failedDb = scriptedDb([[sql => assert.match(sql, /pg_advisory_xact_lock/), failure]]);
  await assert.rejects(assertNewsWriter(failedDb, 'legacy'), error => error === failure);
  failedDb.done();
});

const hash = 'a'.repeat(64);
const expiresAt = new Date('2026-10-02T18:00:00.000Z');
const record = { uid: 'editor-fixture', expiresAt };

test('session creation stores only hash/UID/expiry and bounds expired cleanup in the same statement', async () => {
  const db = scriptedDb([[ (sql, values) => {
    assert.match(sql, /DELETE FROM cms_editor_sessions/);
    assert.match(sql, /expires_at <= NOW\(\)/);
    assert.match(sql, /ORDER BY expires_at, token_hash LIMIT 100 FOR UPDATE SKIP LOCKED/);
    assert.match(sql, /INSERT INTO cms_editor_sessions\s*\(token_hash, user_uid, expires_at\)/);
    assert.doesNotMatch(sql, /ON CONFLICT|BEGIN|COMMIT/);
    assert.deepEqual(values, [hash, record.uid, expiresAt]);
  }, { rows: [record] }]]);
  assert.deepEqual(await createSessionRecord(db, { hash, uid: record.uid, expiresAt }), record);
  db.done();
});

test('session lookup filters revoked and expired hashes using the database clock', async () => {
  for (const rows of [[record], []]) {
    const db = scriptedDb([[(sql, values) => {
      assert.match(sql, /WHERE token_hash\s*=\s*\$1/);
      assert.match(sql, /revoked_at IS NULL/);
      assert.match(sql, /expires_at > NOW\(\)/);
      assert.deepEqual(values, [hash]);
    }, { rows }]]);
    assert.deepEqual(await findSessionRecord(db, hash), rows[0] || null);
    db.done();
  }
});

test('revocation touches only its hash, preserves first revocation time and tolerates absence', async () => {
  for (const rowCount of [1, 0]) {
    const db = scriptedDb([[(sql, values) => {
      assert.match(sql, /UPDATE cms_editor_sessions SET revoked_at\s*=\s*NOW\(\)/);
      assert.match(sql, /WHERE token_hash\s*=\s*\$1 AND revoked_at IS NULL/);
      assert.deepEqual(values, [hash]);
    }, { rowCount }]]);
    assert.equal(await revokeSessionRecord(db, hash), rowCount === 1);
    db.done();
  }
});

test('session persistence propagates database failures without pretending success', async () => {
  const failure = Object.assign(new Error('duplicate hash'), { code: '23505' });
  const db = { async query() { throw failure; } };
  for (const operation of [
    () => createSessionRecord(db, { hash, uid: record.uid, expiresAt }),
    () => findSessionRecord(db, hash), () => revokeSessionRecord(db, hash),
  ]) await assert.rejects(operation, error => error === failure);
});
