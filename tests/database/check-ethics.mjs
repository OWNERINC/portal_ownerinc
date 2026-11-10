// Execute the real migration and acceptance service in an ephemeral PostgreSQL
// WASM instance. No network, credentials, Docker or existing database is used.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

if (!process.env.PGLITE_MODULE_PATH) throw new Error('Set PGLITE_MODULE_PATH to an externally installed @electric-sql/pglite module');
const { PGlite } = await import(pathToFileURL(resolve(process.env.PGLITE_MODULE_PATH)).href);
const require = createRequire(import.meta.url);
const { acceptTerm, term } = require('../../api/ethics');
const db = new PGlite();
try {
  await db.exec(`CREATE ROLE portal_api; CREATE ROLE portal_cron;
    CREATE TABLE users (uid TEXT PRIMARY KEY);
    INSERT INTO users VALUES ('viewer'), ('admin'), ('super');`);
  const migration = await readFile(new URL('../../api/db/migrations/039_ethics_acceptances.sql', import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  assert.equal((await db.query('SELECT * FROM ethics_acceptances')).rows.length, 0, 'no backfill for existing accounts');
  for (const uid of ['viewer', 'admin', 'super']) {
    const first = await acceptTerm(db, uid);
    const repeat = await acceptTerm(db, uid);
    assert.deepEqual(repeat, first);
    assert.ok(Number.isFinite(new Date(first.accepted_at).getTime()));
  }
  assert.equal((await db.query('SELECT * FROM ethics_acceptances')).rows.length, 3);
  assert.equal((await db.query('SELECT * FROM ethics_acceptances WHERE is_mock IS TRUE')).rows.length, 3);
  const current = `SELECT EXISTS (SELECT 1 FROM ethics_acceptances
    WHERE user_uid = $1 AND term_version = $2 AND content_sha256 = $3) AS accepted`;
  assert.equal((await db.query(current, ['viewer', term.version, term.contentHash])).rows[0].accepted, true);
  assert.equal((await db.query(current, ['viewer', 'official-v1', term.contentHash])).rows[0].accepted, false);
  assert.equal((await db.query(current, ['viewer', term.version, '0'.repeat(64)])).rows[0].accepted, false);
  await assert.rejects(db.query('INSERT INTO ethics_acceptances (user_uid, term_version, content_sha256, is_mock) VALUES ($1,$2,$3,$4)', ['viewer', 'bad', 'bad-hash', true]), /check constraint/);
  await assert.rejects(db.query('INSERT INTO ethics_acceptances (user_uid, term_version, content_sha256, is_mock) VALUES ($1,$2,$3,$4)', ['missing', term.version, term.contentHash, true]), /foreign key constraint/);
  await db.exec('SET ROLE portal_api');
  assert.equal((await db.query('SELECT * FROM ethics_acceptances')).rows.length, 3);
  await acceptTerm(db, 'viewer');
  await assert.rejects(db.exec('UPDATE ethics_acceptances SET accepted_at = NOW()'), /permission denied/);
  await assert.rejects(db.exec('DELETE FROM ethics_acceptances'), /permission denied/);
  await db.exec('RESET ROLE; SET ROLE portal_cron');
  await assert.rejects(db.exec('SELECT * FROM ethics_acceptances'), /permission denied/);
  await assert.rejects(db.query('INSERT INTO ethics_acceptances (user_uid, term_version, content_sha256, is_mock) VALUES ($1,$2,$3,$4)', ['viewer', 'other', term.contentHash, true]), /permission denied/);
  await db.exec("RESET ROLE; DELETE FROM users WHERE uid = 'viewer'");
  assert.equal((await db.query("SELECT * FROM ethics_acceptances WHERE user_uid = 'viewer'")).rows.length, 0, 'user erasure cascades');
  // Fresh bootstrap must declare the exact same table as the upgrade migration.
  const schema = await readFile(new URL('../../api/db/schema.sql', import.meta.url), 'utf8');
  const table = schema.match(/CREATE TABLE IF NOT EXISTS ethics_acceptances \([\s\S]*?\n\);/)[0];
  await db.exec(`DROP TABLE ethics_acceptances; ${table}`);
  await acceptTerm(db, 'admin');
  assert.equal((await db.query('SELECT * FROM ethics_acceptances')).rows.length, 1);
  console.log(`Ethics SQL: migration repeatability, existing accounts, idempotency, version/hash, constraints, runtime grants and erasure PASS (${fileURLToPath(new URL('../../api/db/migrations/039_ethics_acceptances.sql', import.meta.url))})`);
} finally {
  await db.close();
}
