// Native PG16 only. Called by the existing, empty-database migration gate after
// migrations; PGlite's serialized connection adapter cannot prove these races.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { assertApprovedMigrationCluster, requireDisposableMigrationEnvironment } from './migration-test-guards.mjs';

const require = createRequire(new URL('../api/package.json', import.meta.url));
const { ensureSlug } = require('../api/pages/aliases');

// Poll server evidence, not elapsed sleeps. A successful observation proves both
// the blocked backend and the specific holder of its ungranted lock.
export async function waitForAliasLock(observer, holderPid, waiterPid, locktype, pending, timeoutMs = 5000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const { rows } = await observer.query(`SELECT a.pid, a.wait_event_type, a.wait_event, l.locktype,
        pg_blocking_pids(a.pid) AS blockers
      FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid
      WHERE a.pid = $1 AND a.wait_event_type = 'Lock' AND NOT l.granted
        AND l.locktype = $3 AND $2 = ANY(pg_blocking_pids(a.pid))
        AND EXISTS (SELECT 1 FROM pg_locks held WHERE held.pid = $2 AND held.granted
          AND held.locktype = l.locktype
          AND held.database IS NOT DISTINCT FROM l.database
          AND held.classid IS NOT DISTINCT FROM l.classid
          AND held.objid IS NOT DISTINCT FROM l.objid
          AND held.objsubid IS NOT DISTINCT FROM l.objsubid
          AND held.transactionid IS NOT DISTINCT FROM l.transactionid)`, [waiterPid, holderPid, locktype]);
    if (rows.length) {
      assert.equal(pending.settled, false, 'waiter must still be blocked at the observed lock');
      console.log(`Pages alias lock evidence: ${JSON.stringify(rows[0])}`);
      return rows[0];
    }
    assert.equal(pending.settled, false, `alias operation settled without observed ${locktype} contention`);
  } while (performance.now() < deadline);
  assert.fail(`Timed out observing ${locktype} contention between independent alias backends`);
}

function track(operation) {
  const pending = { settled: false };
  // Attach rejection handling immediately, including when lock observation fails.
  pending.result = operation.then(
    value => { pending.settled = true; return { value }; },
    error => { pending.settled = true; return { error }; },
  );
  return pending;
}

export async function testPagesAliasConcurrency() {
  requireDisposableMigrationEnvironment();
  assert.equal(process.env.NODE_ENV, 'test', 'Alias concurrency requires NODE_ENV=test');
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL,
    max: 3, connectionTimeoutMillis: 5000, statement_timeout: 15000,
    lock_timeout: 10000, query_timeout: 20000 });
  const clients = [], fixtureIds = [];
  let observer;
  const insert = async (db, id) => {
    const page = (await db.query('INSERT INTO pages(id) VALUES($1) RETURNING id,slug', [id])).rows[0];
    fixtureIds.push(id); // Never clean up an ID whose INSERT did not succeed.
    return page;
  };
  try {
    for (let i = 0; i < 3; i++) {
      const client = await pool.connect(); clients.push(client);
      await assertApprovedMigrationCluster(client);
    }
    const [first, second] = clients; observer = clients[2];
    const version = Number((await observer.query('SHOW server_version_num')).rows[0].server_version_num);
    assert.ok(version >= 160000 && version < 170000, 'Alias concurrency requires native PostgreSQL 16');
    const pids = await Promise.all(clients.map(async db => (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid));
    assert.equal(new Set(pids).size, 3, 'two transaction backends and an independent observer are required');
    const checkRows = async expected => {
      const rows = (await observer.query('SELECT id,slug FROM pages WHERE id = ANY($1::uuid[]) ORDER BY id', [expected.map(row => row.id)])).rows;
      assert.deepEqual(rows, expected.slice().sort((a, b) => a.id.localeCompare(b.id)));
    };
    for (const finish of ['COMMIT', 'ROLLBACK']) {
      const base = `alias-${randomUUID()}`, firstId = randomUUID(), secondId = randomUUID();
      try {
        await first.query('BEGIN'); await second.query('BEGIN');
        const firstPage = await insert(first, firstId), secondPage = await insert(second, secondId);
        assert.equal(await ensureSlug(first, firstPage, base), base);
        const pending = track(ensureSlug(second, secondPage, base));
        await waitForAliasLock(observer, pids[0], pids[1], 'advisory', pending);
        await first.query(finish);
        const result = await pending.result;
        assert.ifError(result.error);
        const expected = finish === 'COMMIT' ? `${base}-${secondId.replace(/-/g, '')}` : base;
        assert.equal(result.value, expected, `same-base allocation after holder ${finish}`);
        await second.query('COMMIT');
        await checkRows([{ id: secondId, slug: expected }, ...(finish === 'COMMIT' ? [{ id: firstId, slug: base }] : [])]);
        if (finish === 'ROLLBACK') assert.equal((await observer.query('SELECT id FROM pages WHERE id=$1', [firstId])).rowCount, 0);
        console.log(`Pages alias same-base ${finish}: PASS`);
      } finally {
        // Concurrent rollback releases the holder even if the waiter is queued.
        await Promise.all([first.query('ROLLBACK'), second.query('ROLLBACK')]);
      }
    }

    // Different advisory keys can still target the same alias: one page's
    // UUID-suffixed alias is another title's base. Exercise the real UNIQUE
    // index, without dropping it or injecting a synthetic PostgreSQL error.
    for (const finish of ['COMMIT', 'ROLLBACK']) {
      const base = `cross-${randomUUID().slice(0, 8)}`, seedId = randomUUID(), firstId = randomUUID(), secondId = randomUUID();
      const suffix = `${base}-${firstId.replace(/-/g, '')}`;
      await observer.query('BEGIN');
      try {
        assert.equal(await ensureSlug(observer, await insert(observer, seedId), base), base);
        await observer.query('COMMIT');
      } catch (error) { await observer.query('ROLLBACK'); throw error; }
      // Avoid an accidental hash collision masquerading as the intended UNIQUE wait.
      const keys = (await observer.query('SELECT hashtext($1) <> hashtext($2) AS distinct_keys', [`pages-alias:${base}`, `pages-alias:${suffix}`])).rows[0];
      assert.equal(keys.distinct_keys, true);
      try {
        await first.query('BEGIN'); await second.query('BEGIN');
        assert.equal(await ensureSlug(first, await insert(first, firstId), base), suffix);
        const pending = track(ensureSlug(second, await insert(second, secondId), suffix));
        await waitForAliasLock(observer, pids[0], pids[1], 'transactionid', pending);
        await first.query(finish);
        const result = await pending.result;
        if (finish === 'COMMIT') {
          assert.equal(result.error?.code, '23505', 'native unique violation after cross-base winner commits');
          assert.equal(result.error?.constraint, 'pages_slug_unique_idx');
          await second.query('ROLLBACK');
          assert.equal((await observer.query('SELECT id FROM pages WHERE id=$1', [secondId])).rowCount, 0, 'loser INSERT rolls back');
          await checkRows([{ id: seedId, slug: base }, { id: firstId, slug: suffix }]);
        } else {
          assert.ifError(result.error); assert.equal(result.value, suffix);
          await second.query('COMMIT');
          assert.equal((await observer.query('SELECT id FROM pages WHERE id=$1', [firstId])).rowCount, 0);
          await checkRows([{ id: seedId, slug: base }, { id: secondId, slug: suffix }]);
        }
        console.log(`Pages alias cross-base UNIQUE ${finish}: PASS`);
      } finally { await Promise.all([first.query('ROLLBACK'), second.query('ROLLBACK')]); }
    }
  } finally {
    try {
      const rollback = await Promise.allSettled(clients.map(db => db.query('ROLLBACK')));
      assert.ok(rollback.every(result => result.status === 'fulfilled'), 'all owned alias transactions must roll back');
      if (observer && fixtureIds.length) {
        await observer.query('DELETE FROM pages WHERE id = ANY($1::uuid[])', [fixtureIds]);
        assert.equal((await observer.query('SELECT id FROM pages WHERE id = ANY($1::uuid[])', [fixtureIds])).rowCount, 0);
      }
    } finally {
      for (const client of clients) client.release(true);
      await pool.end();
    }
  }
  console.log('Pages alias concurrency: PASS; four observed native lock waits; owned fixture rows removed');
}
