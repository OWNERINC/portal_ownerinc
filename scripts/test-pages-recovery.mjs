// Database-only rehearsal on the approved, initially empty PostgreSQL 16 CI
// database. Never an operational restore helper; never connects to the VPS.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, readdir, rm, chmod, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { requireDisposableMigrationEnvironment, assertApprovedMigrationCluster, assertEmptyMigrationDatabase } from './migration-test-guards.mjs';
import { featureDocument, referenceMedia } from '../tests/helpers/pages-reference-document.mjs';

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
const { validateDocument } = require('../api/pages/validation');
const { ensureSlug } = require('../api/pages/aliases');
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

  // A pre-042 Pages dump already contains all six tables. The unchanged
  // receiver classifier selects ordinary pg_restore, never the empty-Pages
  // cleanup. Rehearse that path across the additive slug/version expansion.
  for (const filename of ['040_pages.sql', '041_pages_media.sql']) {
    await client.query('BEGIN');
    try {
      await client.query(await readFile(new URL(filename, migrations), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [filename.slice(0, -4)]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  }
  const pre042Page = randomUUID(), pre042Revision = randomUUID();
  await client.query('INSERT INTO pages(id,author_uid) VALUES($1,$2)', [pre042Page, uid]);
  await client.query('INSERT INTO page_revisions(id,page_id,schema_version,title,document,created_by) VALUES($1,$2,2,$3,$4,$5)', [pre042Revision, pre042Page, 'Snapshot pré-042', { schema_version: 2, synthetic: true }, uid]);
  await client.query('UPDATE pages SET draft_revision_id=$1 WHERE id=$2', [pre042Revision, pre042Page]);
  const pre042Ledger = await ledger();
  const pre042Rows = (await client.query('SELECT id,page_id,schema_version,title,document::text,created_by,created_at FROM page_revisions WHERE id=$1', [pre042Revision])).rows;
  const beforeReferenceFidelity = await dump('before-reference-fidelity');
  assert.equal(await classifyDump(beforeReferenceFidelity), 'present', 'pre-042 native TOC identifies an ordinary Pages backup');
  await legacyPreparation(); await restore(beforeReferenceFidelity);
  const restoredPre042Schema = await schemaSnapshot();
  await migrate(); await verifyMigrations();
  assert.ok((await ledger()).some(row => row.version === '042_pages_reference_fidelity'));
  const executionsBeforePre042Restore = cleanupExecutions;
  await legacyPreparation(); await restore(beforeReferenceFidelity);
  assert.equal(cleanupExecutions, executionsBeforePre042Restore, 'pre-042 restore uses ordinary restore without Pages cleanup');
  assert.deepEqual(await schemaSnapshot(), restoredPre042Schema, 'pre-042 restore recovers exact schema, including removal of slug/index');
  assert.deepEqual(await ledger(), pre042Ledger, 'pre-042 restore preserves ledger and timestamps');
  assert.deepEqual((await client.query('SELECT id,page_id,schema_version,title,document::text,created_by,created_at FROM page_revisions WHERE id=$1', [pre042Revision])).rows, pre042Rows, 'pre-042 restore preserves JSON bytes, UUIDs and revision timestamps');
  await assert.rejects(verifyMigrations(), /Unexpected migration ledger/, 'pre-042 restore stays unready until migrations are reapplied');
  await migrate(); await verifyMigrations();
  assert.deepEqual((await client.query('SELECT id,page_id,schema_version,title,document::text,created_by,created_at FROM page_revisions WHERE id=$1', [pre042Revision])).rows, pre042Rows, '042 re-upgrade preserves the restored snapshot');
  // Remove only this rehearsal's synthetic rows before exercising empty-Pages
  // recovery. Never adapt or relax the receiver's nonempty-table refusal.
  await client.query('UPDATE pages SET draft_revision_id=NULL WHERE id=$1', [pre042Page]);
  await client.query('DELETE FROM page_revisions WHERE id=$1', [pre042Revision]);
  await client.query('DELETE FROM pages WHERE id=$1', [pre042Page]);
  await migrate(); await verifyMigrations();
  assert.ok((await ledger()).some(row => row.version === '040_pages'));
  assert.ok((await ledger()).some(row => row.version === '041_pages_media'));
  assert.ok((await ledger()).some(row => row.version === '042_pages_reference_fidelity'));
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
  // Preserve the v1 scenario above and add a valid, private v3 graph. The bytes
  // live only in this rehearsal's directory, never in the application's uploads.
  // This is a database restore test, not a claim of uploads.tar.gz recovery.
  const v3PageId = randomUUID(), publishedId = randomUUID(), draftId = randomUUID(), mediaId = randomUUID();
  const mediaBytes = await require('sharp')(referenceMedia()[0].bytes).webp().toBuffer();
  const privateDirectory = join(directory, 'pages-private'); await mkdir(privateDirectory);
  const storageKey = `pages-${mediaId}.webp`, mediaHash = createHash('sha256').update(mediaBytes).digest('hex');
  await writeFile(join(privateDirectory, storageKey), mediaBytes, { flag: 'wx', mode: 0o600 });
  const document = featureDocument();
  document.metadata.title = 'Ensaio privado v3'; document.metadata.audience.job_title_ids = [titleId];
  for (const section of document.sections) for (const row of section.rows) for (const column of row.columns) {
    // The source board's audio is an unfilled authoring placeholder, not a
    // publishable recording. Retain the complete five-section v3 structure.
    column.blocks = column.blocks.filter(block => block.type !== 'audio');
    for (const block of column.blocks) {
      if (block.type === 'image') { block.media_id = mediaId; block.alt = 'Imagem sintética privada'; }
      if (block.type === 'gallery') for (const item of block.items) { item.media_id = mediaId; item.alt = 'Mesma imagem privada'; }
      if (block.type === 'button') block.action = { type: 'download', media_id: mediaId, kind: 'image', file_name: 'ensaio.webp' };
      if (block.type === 'faq') for (const item of block.items) item.answer = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Resposta sintética do ensaio.' }] }] };
    }
  }
  const published = validateDocument(document, { publishing: true });
  const draftDocument = structuredClone(document);
  draftDocument.metadata.title = 'Rascunho privado posterior'; draftDocument.metadata.category = 'Categoria posterior';
  const draft = validateDocument(draftDocument);
  assert.deepEqual(published.mediaIds, [mediaId], 'image/gallery/download deduplicate to one private media reference');
  await client.query('BEGIN');
  try {
    const page = (await client.query('INSERT INTO pages(id,author_uid) VALUES($1,$2) RETURNING id,slug', [v3PageId, uid])).rows[0];
    await ensureSlug(client, page, document.metadata.title);
    await client.query(`INSERT INTO page_media(id,page_id,uploaded_by,storage_key,mime_type,byte_size,width,height,sha256)
      VALUES($1,$2,$3,$4,'image/webp',$5,1,1,$6)`, [mediaId, v3PageId, uid, storageKey, mediaBytes.length, mediaHash]);
    for (const [id, validated] of [[publishedId, published], [draftId, draft]]) {
      await client.query(`INSERT INTO page_revisions(id,page_id,schema_version,title,document,created_by)
        VALUES($1,$2,3,$3,$4::jsonb,$5)`, [id, v3PageId, validated.document.metadata.title, JSON.stringify(validated.document), uid]);
      for (const job of validated.jobTitleIds) await client.query('INSERT INTO page_revision_job_titles(revision_id,job_title_id) VALUES($1,$2)', [id, job]);
      for (const media of validated.mediaIds) await client.query('INSERT INTO page_revision_media(page_id,revision_id,media_id) VALUES($1,$2,$3)', [v3PageId, id, media]);
    }
    await client.query(`UPDATE pages SET draft_revision_id=$2,published_revision_id=$3,
      published_at=now(),published_by=$4,version=3 WHERE id=$1`, [v3PageId, draftId, publishedId, uid]);
    await client.query(`INSERT INTO page_requests(actor_uid,client_mutation_id,operation,target_id,request_hash,response,status)
      VALUES($1,$2,'draft',$3,$4,$5::jsonb,200)`, [uid, randomUUID(), v3PageId, 'b'.repeat(64), JSON.stringify({ id: v3PageId, draft_revision_id: draftId, version: 3 })]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  async function v3Snapshot() {
    // JSON text keeps every column, JSONB content and full timestamp precision;
    // no selected-field comparison can hide a lost alias or association.
    const snapshot = {};
    for (const [table, predicate, order] of [
      ['pages', 'id=$1', 'id'], ['page_revisions', 'page_id=$1', 'id'],
      ['page_media', 'page_id=$1', 'id'], ['page_revision_media', 'page_id=$1', 'revision_id,media_id'],
      ['page_revision_job_titles', 'revision_id IN (SELECT id FROM page_revisions WHERE page_id=$1)', 'revision_id,job_title_id'],
      ['page_requests', 'target_id=$1', 'actor_uid,client_mutation_id'],
    ]) snapshot[table] = (await client.query(`SELECT to_jsonb(t)::text AS snapshot FROM ${table} t WHERE ${predicate} ORDER BY ${order}`, [v3PageId])).rows;
    return snapshot;
  }
  const v3Before = await v3Snapshot(), laterLedger = await ledger();
  assert.deepEqual(Object.fromEntries(Object.entries(v3Before).map(([table, rows]) => [table, rows.length])), {
    pages: 1, page_revisions: 2, page_media: 1, page_revision_media: 2, page_revision_job_titles: 2, page_requests: 1,
  });
  const withPages = await dump('with-pages');
  assert.equal(await classifyDump(withPages), 'present', 'real native TOC identifies the later Pages backup');
  // Establish an independently restored schema reference (CHECK expressions
  // can be flattened by pg_restore), then perturb every part of the v3 graph.
  await legacyPreparation(); await restore(withPages);
  const laterSchema = await schemaSnapshot();
  assert.deepEqual(await v3Snapshot(), v3Before, 'reference roundtrip preserves the complete v3 graph');
  await client.query('UPDATE users SET name=$1 WHERE uid=$2', ['Alteração sintética posterior ao backup', uid]);
  await client.query('UPDATE pages SET version=7 WHERE id=$1', [pageId]);
  await client.query(`UPDATE pages SET slug=$2,draft_revision_id=$3,published_revision_id=NULL,
    published_at=NULL,published_by=NULL,version=9 WHERE id=$1`, [v3PageId, `changed-${v3PageId}`, publishedId]);
  await client.query(`UPDATE page_revisions SET document=jsonb_set(document,'{metadata,category}','"Alterada"'::jsonb) WHERE page_id=$1`, [v3PageId]);
  await client.query('DELETE FROM page_revision_media WHERE page_id=$1', [v3PageId]);
  await client.query('DELETE FROM page_revision_job_titles WHERE revision_id=ANY($1::uuid[])', [[publishedId, draftId]]);
  await client.query('DELETE FROM page_media WHERE id=$1', [mediaId]);
  await client.query('DELETE FROM page_requests WHERE target_id=$1 AND actor_uid=$2', [v3PageId, uid]);
  const v3Changed = await v3Snapshot();
  for (const table of Object.keys(v3Before)) assert.notDeepEqual(v3Changed[table], v3Before[table], `${table}: restore must repair a real change`);
  const executionsBeforeLaterRestore = cleanupExecutions;
  await legacyPreparation(); await restore(withPages);
  assert.equal(cleanupExecutions, executionsBeforeLaterRestore, 'later Pages backup restores without special cleanup');
  assert.deepEqual(await fixtureSnapshot(), baseline.data, 'later backup restores original fixture rows');
  assert.equal((await client.query('SELECT draft_revision_id,version FROM pages WHERE id=$1', [pageId])).rows[0].draft_revision_id, revisionId);
  assert.equal((await client.query('SELECT version FROM pages WHERE id=$1', [pageId])).rows[0].version, 0);
  assert.equal((await client.query('SELECT title FROM page_revisions WHERE id=$1', [revisionId])).rows[0].title, 'Revisão sintética preservada');
  assert.deepEqual(await v3Snapshot(), v3Before, 'full v3 snapshot, alias, private media, revision/audience references and receipt restored exactly');
  assert.deepEqual(await ledger(), laterLedger, 'later backup restores the complete migration ledger and timestamps');
  assert.deepEqual(await schemaSnapshot(), laterSchema, 'later backup restores the complete schema');
  assert.equal(createHash('sha256').update(await readFile(join(privateDirectory, storageKey))).digest('hex'), mediaHash,
    'database-only restore leaves the owned private fixture bytes intact; not an uploads restore');
  await verifyMigrations();
  console.log('Recovery rehearsal PASS: exact receiver SQL/TOC, native PG16 refusal guards, 040/041/042 recovery, pre-042 restore/re-upgrade and later Pages backup preservation including full v3 alias/media/revision parity. Installed receiver/API/cron acceptance remains an operator gate.');
} finally {
  client?.release(); await pool.end();
  if (directory) await rm(directory, { recursive: true, force: true });
}
