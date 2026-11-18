import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { expectedVersions, historicalExpectedVersions, isAcceptedMigrationLedger, verifyPages } = require('./db/verify-migrations');
const migrationPath = 'api/db/migrations/042_pages_reference_fidelity.sql';
const tables = ['pages', 'page_revisions', 'page_revision_job_titles', 'page_media', 'page_revision_media', 'page_requests'];

test('042 is additive, repeatable, LF-only and leaves provisioning and historical migrations alone', async () => {
  const [sql, schema, provision] = await Promise.all([migrationPath, 'api/db/schema.sql', 'api/db/provision.js'].map(file => readFile(file, 'utf8')));
  assert.doesNotMatch(sql, /\r/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS slug TEXT/);
  assert.match(sql, /schema_version IN \(1,2,3\)/);
  assert.match(sql, /length\(slug\) BETWEEN 1 AND 120/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS pages_slug_unique_idx ON pages\(slug\) WHERE slug IS NOT NULL/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ''), /\b(?:GRANT|REVOKE|UPDATE|INSERT|DELETE|TRUNCATE)\b|DROP TABLE|REFERENCES/i);
  assert.match(schema, /slug TEXT/);
  assert.match(schema, /pages_slug_check/);
  assert.match(schema, /pages_slug_unique_idx/);
  assert.match(schema, /schema_version IN \(1,2,3\)/);
  assert.doesNotMatch(schema, /\('042_pages_reference_fidelity'\)/, 'bootstrap must not skip runtime-grant migrations');
  assert.match(provision, /GRANT SELECT, INSERT, UPDATE ON pages TO portal_api/);
  assert.doesNotMatch(provision, /GRANT[^;]*\bpages\b[^;]*TO portal_cron/);
  for (const [file, sha256] of [
    ['040_pages.sql', 'be822d6384830b775b397010929d87560e145f126c3d5fb953c09a32e59929bc'],
  ]) assert.equal(createHash('sha256').update(await readFile(`api/db/migrations/${file}`)).digest('hex'), sha256);
});

test('current and historical readiness ledgers require 042 and reject a pre-042 ledger', async () => {
  for (const versions of [expectedVersions, historicalExpectedVersions]) {
    assert.ok(versions.includes('042_pages_reference_fidelity'));
    assert.equal(isAcceptedMigrationLedger(versions), true);
    assert.equal(isAcceptedMigrationLedger(versions.slice(0, -1)), false);
  }
  for (const file of ['scripts/test-migrations.mjs', 'scripts/test-migration-readiness.mjs']) {
    assert.match(await readFile(file, 'utf8'), /'042_pages_reference_fidelity'/, file);
  }
});

test('disposable 041→042 twice preserves all snapshots, hashes, associations and grants; verifies actual schema', { skip: !process.env.PGLITE_MODULE_PATH && 'PGLITE_MODULE_PATH unavailable: SQL gate pending, not native PG16 evidence' }, async () => {
  const { createPagesDatabaseHarness, pageDocument, cargoA } = await import('../database/check-pages.mjs');
  async function snapshot(db) {
    const data = {};
    for (const table of tables) data[table] = (await db.query(`SELECT ${table === 'pages' ? "to_jsonb(t) - 'slug'" : 'to_jsonb(t)'} AS row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
    const documents = (await db.query('SELECT id, document::text AS bytes FROM page_revisions ORDER BY id')).rows;
    const hashes = documents.map(({ id, bytes }) => ({ id, sha256: createHash('sha256').update(bytes).digest('hex') }));
    const grants = (await db.query("SELECT grantee,table_name,column_name,privilege_type FROM information_schema.column_privileges WHERE grantee IN ('portal_api','portal_cron') AND table_name = ANY($1::text[]) AND column_name <> 'slug' ORDER BY grantee,table_name,column_name,privilege_type", [tables])).rows;
    const foreignKeys = (await db.query("SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE contype='f' AND conrelid = ANY($1::regclass[]) ORDER BY relation,conname", [tables])).rows;
    return { data, hashes, grants, foreignKeys };
  }
  let before, hookCalled = false;
  const pageIds = [];
  const h = await createPagesDatabaseHarness({ afterMedia: async db => {
    hookCalled = true;
    for (const version of [1, 2]) {
      const pageId = randomUUID(), revisionId = randomUUID(), mediaId = randomUUID();
      pageIds.push(pageId);
      const document = pageDocument(`Snapshot legado v${version}`);
      document.schema_version = version;
      if (version === 2) document.template.version = 2;
      document.sections[0].rows[0].columns[0].blocks.push(version === 1
        ? { id: randomUUID(), type: 'image', media_id: mediaId, alt: 'Imagem sintética', caption: '', credit: '' }
        : { id: randomUUID(), type: 'audio', media_id: mediaId, title: 'Áudio sintético', transcript: 'Transcrição de teste.' });
      await db.query("INSERT INTO pages(id,author_uid) VALUES($1,'author')", [pageId]);
      await db.query("INSERT INTO page_revisions(id,page_id,schema_version,title,document,created_by) VALUES($1,$2,$3,$4,$5,'author')", [revisionId, pageId, version, document.metadata.title, document]);
      await db.query('INSERT INTO page_revision_job_titles(revision_id,job_title_id) VALUES($1,$2)', [revisionId, cargoA]);
      await db.query("INSERT INTO page_media(id,page_id,uploaded_by,storage_key,mime_type,byte_size,width,height,sha256,kind,duration_ms) VALUES($1,$2,'author',$3,$4,20,$5,$5,$6,$7,$8)", [mediaId, pageId, `pages-${mediaId}.${version === 1 ? 'webp' : 'mp3'}`, version === 1 ? 'image/webp' : 'audio/mpeg', version === 1 ? 2 : null, 'a'.repeat(64), version === 1 ? 'image' : 'audio', version === 1 ? null : 5000]);
      await db.query('INSERT INTO page_revision_media(page_id,revision_id,media_id) VALUES($1,$2,$3)', [pageId, revisionId, mediaId]);
      await db.query("UPDATE pages SET draft_revision_id=$1,published_revision_id=$1,published_at=now(),published_by='publisher' WHERE id=$2", [revisionId, pageId]);
      await db.query("INSERT INTO page_requests(actor_uid,client_mutation_id,operation,target_id,request_hash,response,status) VALUES('author',$1,'draft',$2,$3,$4,200)", [randomUUID(), pageId, 'b'.repeat(64), { id: pageId }]);
    }
    before = await snapshot(db);
    await assert.rejects(db.query('INSERT INTO page_revisions(page_id,schema_version,title,document) VALUES($1,3,$2,$3)', [pageIds[0], 'v3 antes de 042', {}]), { code: '23514' });
  } });
  try {
    assert.equal(hookCalled, true, 'afterMedia must run before 042');
    assert.deepEqual(await snapshot(h.db), before, '042 must not rewrite JSON bytes, hashes, UUIDs, timestamps, heads, references or privileges');
    await verifyPages(h.pool);
    const { PGlite } = await import(pathToFileURL(resolve(process.env.PGLITE_MODULE_PATH)).href);
    const fresh = new PGlite();
    try {
      await fresh.exec('CREATE ROLE portal_api; CREATE ROLE portal_cron; CREATE TABLE users(uid TEXT PRIMARY KEY); CREATE TABLE job_titles(id UUID PRIMARY KEY)');
      const bootstrap = await readFile('api/db/schema.sql', 'utf8');
      await fresh.exec(bootstrap.slice(bootstrap.indexOf('CREATE TABLE IF NOT EXISTS pages ('), bootstrap.indexOf('-- The legacy catalog seed')));
      for (const file of ['040_pages.sql', '041_pages_media.sql', '042_pages_reference_fidelity.sql']) await fresh.exec(await readFile(`api/db/migrations/${file}`, 'utf8'));
      for (const sql of [
        "SELECT table_name,column_name,is_nullable,data_type,column_default FROM information_schema.columns WHERE table_schema='public' AND table_name = ANY($1::text[]) ORDER BY table_name,ordinal_position",
        'SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = ANY($1::regclass[]) ORDER BY relation,conname',
        "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename = ANY($1::text[]) ORDER BY tablename,indexname",
        "SELECT grantee,table_name,privilege_type FROM information_schema.role_table_grants WHERE grantee IN ('portal_api','portal_cron') AND table_name = ANY($1::text[]) ORDER BY grantee,table_name,privilege_type",
      ]) assert.deepEqual((await fresh.query(sql, [tables])).rows, (await h.db.query(sql, [tables])).rows, 'bootstrap plus pending migrations and populated upgrade converge');
      await verifyPages(fresh);
    } finally { await fresh.close(); }
    // Like pg_dump/pg_restore, reparse the server's CHECK definition. PostgreSQL
    // can flatten associative AND groups; readiness must survive that roundtrip.
    const check = (await h.db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='pages'::regclass AND conname='pages_slug_check'")).rows[0].definition;
    await h.db.exec(`ALTER TABLE pages DROP CONSTRAINT pages_slug_check; ALTER TABLE pages ADD CONSTRAINT pages_slug_check ${check}`);
    await verifyPages(h.pool);
    assert.equal((await h.db.query('SELECT count(*)::int AS n FROM pages WHERE slug IS NULL')).rows[0].n, 2);
    await h.db.query('UPDATE pages SET slug=$1 WHERE id=$2', ['guia-interno-1', pageIds[0]]);
    await assert.rejects(h.db.query('UPDATE pages SET slug=$1 WHERE id=$2', ['guia-interno-1', pageIds[1]]), { code: '23505' });
    for (const slug of ['', 'Upper', '-prefix', 'suffix-', 'double--hyphen', 'with space', 'café', 'under_score', 'a'.repeat(121)]) {
      await assert.rejects(h.db.query('UPDATE pages SET slug=$1 WHERE id=$2', [slug, pageIds[1]]), { code: '23514' }, slug);
    }
    await h.db.query('UPDATE pages SET slug=$1 WHERE id=$2', ['a'.repeat(120), pageIds[1]]);
    await h.db.query('INSERT INTO page_revisions(page_id,schema_version,title,document) VALUES($1,3,$2,$3)', [pageIds[0], 'v3 permitido por SQL apenas', { schema_version: 3 }]);
    for (const version of [0, 4]) await assert.rejects(h.db.query('INSERT INTO page_revisions(page_id,schema_version,title,document) VALUES($1,$2,$3,$4)', [pageIds[0], version, 'inválido', {}]), { code: '23514' });
    await h.db.exec('SET ROLE portal_api');
    await h.db.query('UPDATE pages SET slug=NULL WHERE id=$1', [pageIds[0]]);
    await assert.rejects(h.db.query('UPDATE page_revisions SET title=title WHERE FALSE'), { code: '42501' });
    await h.db.exec('RESET ROLE');
    const migration = await readFile(migrationPath, 'utf8');
    // Ledger success is not enough: weakened checks and wrong partial indexes fail.
    for (const ddl of [
      'ALTER TABLE pages DROP CONSTRAINT pages_slug_check; ALTER TABLE pages ADD CONSTRAINT pages_slug_check CHECK (true)',
      "ALTER TABLE pages DROP CONSTRAINT pages_slug_check; ALTER TABLE pages ADD CONSTRAINT pages_slug_check CHECK ((slug IS NULL OR length(slug) >= 1) AND length(slug) <= 120 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')",
      "ALTER TABLE pages DROP CONSTRAINT pages_slug_check; ALTER TABLE pages ADD CONSTRAINT pages_slug_check CHECK (slug IS NULL OR (length(slug) BETWEEN 1 AND 120 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')) NOT VALID",
      'ALTER TABLE page_revisions DROP CONSTRAINT page_revisions_schema_version_check; ALTER TABLE page_revisions ADD CONSTRAINT page_revisions_schema_version_check CHECK (schema_version IN (1,2,3,4))',
      'DROP INDEX pages_slug_unique_idx; CREATE INDEX pages_slug_unique_idx ON pages(slug) WHERE slug IS NOT NULL',
      "DROP INDEX pages_slug_unique_idx; CREATE UNIQUE INDEX pages_slug_unique_idx ON pages(id) WHERE slug IS NOT NULL",
      'DROP INDEX pages_slug_unique_idx; CREATE UNIQUE INDEX pages_slug_unique_idx ON pages(slug)',
      'DROP INDEX pages_slug_unique_idx; CREATE UNIQUE INDEX pages_slug_unique_idx ON pages(slug) WHERE slug IS NOT NULL AND length(slug) > 10',
      'ALTER TABLE pages ALTER COLUMN slug SET DEFAULT \'invented-default\'',
    ]) {
      await h.db.exec('BEGIN');
      try { await h.db.exec(ddl); await assert.rejects(verifyPages(h.pool), /Pages relational invariants/, ddl); }
      finally { await h.db.exec('ROLLBACK'); }
    }
    await h.db.exec(migration);
    await verifyPages(h.pool);
  } finally { await h.close(); }
});
