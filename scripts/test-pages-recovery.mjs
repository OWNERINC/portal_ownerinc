// Database-only rehearsal on the approved, initially empty PostgreSQL 16 CI
// database. Never an operational restore helper; never connects to the VPS.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { requireDisposableMigrationEnvironment, assertApprovedMigrationCluster, assertEmptyMigrationDatabase } from './migration-test-guards.mjs';

requireDisposableMigrationEnvironment();
assert.equal(process.env.NODE_ENV, 'test', 'Recovery rehearsal requires NODE_ENV=test');
const connection = new URL(process.env.MIGRATION_DATABASE_URL);
assert.equal(connection.search, '', 'Recovery rehearsal URL must not contain connection overrides or query parameters');
assert.equal(connection.hash, '', 'Recovery rehearsal URL must not contain a fragment');
assert.ok(['postgres:', 'postgresql:'].includes(connection.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(connection.hostname), 'Recovery rehearsal requires loopback PostgreSQL');
assert.ok(/^\d+$/.test(connection.port) && Number(connection.port) >= 1 && Number(connection.port) <= 65535, 'Recovery rehearsal requires an explicit port');
assert.ok(connection.username && connection.password, 'Recovery rehearsal requires explicit username and password');
assert.equal(decodeURIComponent(connection.pathname.slice(1)), 'portal_test_pages_recovery', 'Recovery rehearsal requires its dedicated empty database');
const require = createRequire(new URL('../api/package.json', import.meta.url));
const { Pool } = require('pg');
const { provisionRoles } = require('../api/db/provision');
const { migrate } = require('../api/db/migrate');
const { verifyMigrations } = require('../api/db/verify-migrations');
const exec = promisify(execFile);
const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
let client, directory;
const toolsEnvironment = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PG/i.test(key))),
  PGHOST: connection.hostname.replace(/^\[|\]$/g, ''), PGPORT: connection.port,
  PGUSER: decodeURIComponent(connection.username), PGPASSWORD: decodeURIComponent(connection.password),
  PGDATABASE: decodeURIComponent(connection.pathname.slice(1)), PGSSLMODE: 'disable', PGCONNECT_TIMEOUT: '10' };
const dumpBinary = process.env.PG_DUMP_PATH || 'pg_dump';
const restoreBinary = process.env.PG_RESTORE_PATH || 'pg_restore';
const restoreOptions = ['--clean', '--if-exists', '--no-owner', '--single-transaction'];
const receiver = await readFile(new URL('../ops/deploy-from-ci.sh', import.meta.url), 'utf8');
const sqlBlocks = [...receiver.matchAll(/<<'PAGES_RECOVERY_SQL'\n([\s\S]*?)\nPAGES_RECOVERY_SQL/g)];
assert.equal(sqlBlocks.length, 1, 'receiver must contain one literal production recovery SQL block');
const recoverySql = `${sqlBlocks[0][1]}\n`;
const classifiers = [...receiver.matchAll(/^classify_backup_pages\(\) \{\n[\s\S]*?^\}/gm)];
assert.equal(classifiers.length, 1, 'receiver must contain one backup classifier');
let cleanupExecutions = 0;
const uid = `recovery-${randomUUID()}`;
const titleId = randomUUID();
async function tool(binary, args, extraEnvironment = {}) {
  try { return await exec(binary, args, { env: { ...toolsEnvironment, ...extraEnvironment }, timeout: 120000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }); }
  catch (error) {
    // pg tools receive credentials only via env, never CLI. Still redact errors
    // defensively before they can reach CI stdout or an assertion report.
    let detail = String(error.stderr || error.message || 'tool failure');
    for (const secret of [process.env.MIGRATION_DATABASE_URL, toolsEnvironment.PGPASSWORD]) if (secret) detail = detail.split(secret).join('[redacted]');
    throw Object.assign(new Error(`PostgreSQL tool failed: ${detail.slice(0, 12000)}`), { toolOutput: detail, exitCode: error.code });
  }
}
async function schemaSnapshot() {
  const relations = await client.query(`SELECT c.relname, c.relkind, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','S','v','p','m','f') ORDER BY c.relname`);
  const columns = await client.query(`SELECT c.relname, a.attname, format_type(a.atttypid,a.atttypmod) AS type, a.attnotnull,
    a.attidentity, pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`);
  const constraints = await client.query(`SELECT c.relname, x.conname, x.contype, x.convalidated, pg_get_constraintdef(x.oid) AS definition
    FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' ORDER BY c.relname,x.conname`);
  const indexes = await client.query(`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`);
  const policies = await client.query(`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname`);
  return { relations: relations.rows, columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows, policies: policies.rows };
}
const ledger = async () => (await client.query('SELECT version,applied_at FROM schema_migrations ORDER BY version')).rows;
async function fixtureSnapshot() {
  return {
    user: (await client.query('SELECT uid,email,name,job_title_id,permissions FROM users WHERE uid=$1', [uid])).rows,
    cargo: (await client.query('SELECT id,name,active,page_access FROM job_titles WHERE id=$1', [titleId])).rows,
  };
}
async function dump(name) {
  const folder = join(directory, name); await mkdir(folder);
  const file = join(folder, 'postgres.dump');
  await tool(dumpBinary, ['--format=custom', '--no-owner', '--file', file]);
  await chmod(file, 0o600);
  const bytes = await readFile(file); assert.ok(bytes.length > 0);
  return { file, hash: createHash('sha256').update(bytes).digest('hex') };
}
async function restore(backup) {
  assert.equal(createHash('sha256').update(await readFile(backup.file)).digest('hex'), backup.hash, 'dump checksum unchanged before restore');
  await tool(restoreBinary, [...restoreOptions, '--dbname', toolsEnvironment.PGDATABASE, backup.file]);
}
async function classifyDump(backup) {
  // Execute the unchanged receiver classifier with a single in-process Docker
  // double forwarding ONLY pg_restore --list to the real native client.
  const source = `set -uo pipefail
${classifiers[0][0]}
backup=$1
postgres_container=synthetic-native-postgres
docker() {
  [[ $# == 6 && $1 == exec && $2 == -i && $3 == synthetic-native-postgres && $4 == sh && $5 == -c && $6 == 'pg_restore --list' ]] || return 99
  "$PG_RESTORE_BINARY" --list
}
classify_backup_pages`;
  return (await tool('bash', ['-c', source, 'native-pages-inventory', dirname(backup.file)], { PG_RESTORE_BINARY: restoreBinary })).stdout.trim();
}
async function cleanupPages() {
  cleanupExecutions++;
  try { await client.query(recoverySql); }
  catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function expectCleanupRefusal(label, pattern, role) {
  const before = { schema: await schemaSnapshot(), ledger: await ledger(), data: await fixtureSnapshot() };
  try {
    if (role === 'portal_cron') await client.query('SET ROLE portal_cron');
    else if (role === 'portal_api') await client.query('SET ROLE portal_api');
    else assert.equal(role, undefined);
    await assert.rejects(cleanupPages(), pattern, label);
  } finally { await client.query('RESET ROLE'); }
  assert.deepEqual(await schemaSnapshot(), before.schema, `${label}: all relations, constraints, indexes and RLS policies unchanged`);
  assert.deepEqual(await ledger(), before.ledger, `${label}: ledger unchanged`);
  assert.deepEqual(await fixtureSnapshot(), before.data, `${label}: baseline data unchanged`);
  console.log(`Recovery guard refused safely: ${label}`);
}
// Exact pre-drop currently present in the versioned receiver. Executed only
// after all disposable-cluster/empty-database guards above pass.
async function legacyPreparation() {
  await client.query('DROP TABLE IF EXISTS public.firebase_cleanup_queue CASCADE; DROP TABLE IF EXISTS public.pending_registrations CASCADE');
}
try {
  client = await pool.connect();
  await assertApprovedMigrationCluster(client);
  const version = Number((await client.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(version >= 160000 && version < 170000, 'Rehearsal requires PostgreSQL 16 server');
  const existing = await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND left(n.nspname,3)<>'pg_'
    UNION ALL SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema') AND left(nspname,3)<>'pg_'`);
  assertEmptyMigrationDatabase(existing.rows);
  await provisionRoles(client);
  await client.query('CREATE TABLE schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const migrations = new URL('../api/db/migrations/', import.meta.url);
  const baselineFiles = (await readdir(migrations)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name) && name < '040_pages.sql').sort();
  for (const filename of baselineFiles) {
    await client.query('BEGIN');
    try {
      await client.query(await readFile(new URL(filename, migrations), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [filename.slice(0, -4)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
  assert.equal((await client.query("SELECT to_regclass('public.pages') AS relation")).rows[0].relation, null);
  await client.query('INSERT INTO job_titles(id,name,active) VALUES($1,$2,true)', [titleId, 'Cargo sintético do ensaio de recuperação']);
  await client.query('INSERT INTO users(uid,email,name,job_title_id) VALUES($1,$2,$3,$4)', [uid, `${uid}@example.test`, 'Pessoa sintética do ensaio', titleId]);
  const baseline = { ledger: await ledger(), data: await fixtureSnapshot() };
  const base = join(tmpdir(), 'opencode'); await mkdir(base, { recursive: true }); directory = await mkdtemp(join(base, 'pages-recovery-'));
  const beforePages = await dump('before-pages');
  assert.equal(await classifyDump(beforePages), 'absent', 'real native TOC proves Pages absent');
  // A dump/restore can flatten associative AND groups when CHECK expressions are
  // parsed again. Use an independently restored pre-Pages reference, not string
  // stripping or skipped constraints, for the subsequent recovery comparison.
  await legacyPreparation(); await restore(beforePages);
  assert.deepEqual(await ledger(), baseline.ledger, 'reference roundtrip preserves baseline ledger');
  assert.deepEqual(await fixtureSnapshot(), baseline.data, 'reference roundtrip preserves baseline data');
  const restoredBaselineSchema = await schemaSnapshot();
  await cleanupPages();
  assert.deepEqual(await schemaSnapshot(), restoredBaselineSchema, 'no-Pages no-op preserves the baseline schema');
  assert.deepEqual(await ledger(), baseline.ledger, 'no-Pages no-op preserves the ledger');
  assert.deepEqual(await fixtureSnapshot(), baseline.data, 'no-Pages no-op preserves fixture data');

  // First-migration-only failures must use the same production block, not a
  // separately maintained drop list. Apply the real 040 and its ledger atomically.
  await client.query('BEGIN');
  try {
    await client.query(await readFile(new URL('040_pages.sql', migrations), 'utf8'));
    await client.query("INSERT INTO schema_migrations(version) VALUES('040_pages')");
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  assert.ok((await ledger()).some(row => row.version === '040_pages'));
  assert.ok(!(await ledger()).some(row => row.version === '041_pages_media'));
  await cleanupPages(); await legacyPreparation(); await restore(beforePages);
  assert.deepEqual(await schemaSnapshot(), restoredBaselineSchema, '040-only recovery restores the exact baseline schema');
  assert.deepEqual(await ledger(), baseline.ledger, '040-only recovery restores the baseline ledger');
  assert.deepEqual(await fixtureSnapshot(), baseline.data, '040-only recovery restores fixture data');
  await migrate(); await verifyMigrations();
  assert.ok((await ledger()).some(row => row.version === '040_pages'));
  assert.ok((await ledger()).some(row => row.version === '041_pages_media'));
  await legacyPreparation();
  await assert.rejects(restore(beforePages), error => {
    assert.match(error.toolOutput || '', /depend|cannot drop/i);
    assert.match(error.toolOutput || '', /page_revisions|page_revision_job_titles|page_media|pages_author_uid|pages_published_by/);
    return true;
  }, 'legacy pre-Pages restore must expose new FK dependencies');
  assert.deepEqual(await fixtureSnapshot(), baseline.data, 'failed restore transaction preserves fixture rows');
  console.log('Recovery rehearsal: pre-Pages restore failure reproduced with new Pages dependencies (no production connection).');

  await client.query('ALTER TABLE public.page_requests RENAME TO recovery_missing_requests');
  try {
    await expectCleanupRefusal('partial relations', /partial or nonordinary/);
    await client.query('CREATE VIEW public.page_requests AS SELECT * FROM public.recovery_missing_requests');
    try { await expectCleanupRefusal('nonordinary relation', /partial or nonordinary/); }
    finally { await client.query('DROP VIEW public.page_requests'); }
  } finally { await client.query('ALTER TABLE public.recovery_missing_requests RENAME TO page_requests'); }

  await client.query('CREATE VIEW public.recovery_pages_dependency AS SELECT id FROM public.page_media');
  try { await expectCleanupRefusal('external dependency', /depend|cannot drop/i); }
  finally { await client.query('DROP VIEW public.recovery_pages_dependency'); }

  const guardedPageId = randomUUID();
  await client.query('INSERT INTO pages(id,author_uid) VALUES($1,$2)', [guardedPageId, uid]);
  try {
    await expectCleanupRefusal('nonempty pages', /nonempty relation pages/);
    assert.equal(Number((await client.query('SELECT count(*) FROM pages WHERE id=$1', [guardedPageId])).rows[0].count), 1);
  } finally { await client.query('DELETE FROM pages WHERE id=$1', [guardedPageId]); }

  const mutationId = randomUUID(), targetId = randomUUID();
  await client.query(`INSERT INTO page_requests(actor_uid,client_mutation_id,operation,target_id,request_hash,response,status)
    VALUES($1,$2,'create',$3,$4,'{}',201)`, [uid, mutationId, targetId, 'a'.repeat(64)]);
  try {
    await expectCleanupRefusal('nonempty page_requests', /nonempty relation page_requests/);
    assert.equal(Number((await client.query('SELECT count(*) FROM page_requests')).rows[0].count), 1);
    await client.query('ALTER TABLE public.page_requests ENABLE ROW LEVEL SECURITY');
    await client.query('CREATE POLICY recovery_hidden_requests ON public.page_requests FOR SELECT TO portal_api USING (false)');
    try {
      await client.query('SET ROLE portal_api');
      try { assert.equal(Number((await client.query('SELECT count(*) FROM page_requests')).rows[0].count), 0, 'synthetic row is genuinely hidden by RLS'); }
      finally { await client.query('RESET ROLE'); }
      await expectCleanupRefusal('RLS-hidden row', /superuser or BYPASSRLS/, 'portal_api');
      assert.equal(Number((await client.query('SELECT count(*) FROM page_requests')).rows[0].count), 1, 'RLS-hidden row preserved');
    } finally {
      await client.query('DROP POLICY recovery_hidden_requests ON public.page_requests');
      await client.query('ALTER TABLE public.page_requests DISABLE ROW LEVEL SECURITY');
    }
  } finally { await client.query('DELETE FROM page_requests WHERE actor_uid=$1 AND client_mutation_id=$2', [uid, mutationId]); }
  await expectCleanupRefusal('insufficient role', /superuser or BYPASSRLS/, 'portal_cron');

  // Execute the exact production SQL, then the historical preparation, then the
  // real restore, all against the same guarded disposable database only.
  await cleanupPages(); await legacyPreparation(); await restore(beforePages);
  assert.deepEqual(await schemaSnapshot(), restoredBaselineSchema, 'recovery schema matches independently restored baseline exactly');
  assert.deepEqual(await ledger(), baseline.ledger, 'baseline migration ledger/timestamps restored');
  assert.deepEqual(await fixtureSnapshot(), baseline.data, 'baseline fixture rows restored');
  console.log('Recovery rehearsal: exact production Pages guard + restore recovers baseline schema, ledger and fixture data.');

  await migrate(); await verifyMigrations();
  assert.deepEqual(await fixtureSnapshot(), baseline.data, 'upgrade after recovery preserves baseline fixture rows');
  const pageId = randomUUID(), revisionId = randomUUID();
  await client.query('INSERT INTO pages(id,author_uid) VALUES($1,$2)', [pageId, uid]);
  await client.query('INSERT INTO page_revisions(id,page_id,schema_version,title,document,created_by) VALUES($1,$2,1,$3,$4,$5)', [revisionId, pageId, 'Revisão sintética preservada', { synthetic: true }, uid]);
  await client.query('UPDATE pages SET draft_revision_id=$1 WHERE id=$2', [revisionId, pageId]);
  const withPages = await dump('with-pages');
  assert.equal(await classifyDump(withPages), 'present', 'real native TOC identifies the later Pages backup');
  await client.query('UPDATE users SET name=$1 WHERE uid=$2', ['Alteração sintética posterior ao backup', uid]);
  await client.query('UPDATE pages SET version=7 WHERE id=$1', [pageId]);
  const executionsBeforeLaterRestore = cleanupExecutions;
  await legacyPreparation(); await restore(withPages);
  assert.equal(cleanupExecutions, executionsBeforeLaterRestore, 'later Pages backup restores without special cleanup');
  assert.deepEqual(await fixtureSnapshot(), baseline.data, 'later backup restores original fixture rows');
  assert.equal((await client.query('SELECT draft_revision_id,version FROM pages WHERE id=$1', [pageId])).rows[0].draft_revision_id, revisionId);
  assert.equal((await client.query('SELECT version FROM pages WHERE id=$1', [pageId])).rows[0].version, 0);
  assert.equal((await client.query('SELECT title FROM page_revisions WHERE id=$1', [revisionId])).rows[0].title, 'Revisão sintética preservada');
  await verifyMigrations();
  console.log('Recovery rehearsal PASS: exact receiver SQL/TOC, native PG16 refusal guards, 040/041 recovery and later Pages backup preservation. Installed receiver/API/cron acceptance remains an operator gate.');
} finally {
  client?.release(); await pool.end();
  if (directory) await rm(directory, { recursive: true, force: true });
}
