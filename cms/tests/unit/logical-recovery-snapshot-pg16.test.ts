import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { canonicalObservedCheckDefinition } from '../../scripts/finalize-news-protocol'
import { recreateNativeCatalog } from '../fixtures/recreate-native-catalog'
import { captureLogicalSnapshotWithClient } from '../../../scripts/integration/payload-logical-snapshot.mjs'

const require = createRequire(import.meta.url)
const supplied = process.env.CMS_TEST_PGLITE_MODULE
if (supplied && !isAbsolute(supplied)) throw new Error('CMS_TEST_PGLITE_MODULE must be absolute')
let modulePath: string | undefined
try { modulePath = require.resolve(supplied || '@electric-sql/pglite') } catch (error) { if (supplied) throw error }
type Result = { rows: Record<string, unknown>[] }
type DB = { exec(sql: string): Promise<Result[]>; query(sql: string, values?: unknown[]): Promise<Result>; close(): Promise<void> }
const options = { skip: modulePath ? false : 'optional PGlite unavailable', timeout: 120_000 }
const snapshot = (db: DB) => captureLogicalSnapshotWithClient(db, canonicalObservedCheckDefinition)
const migrations = ['20261002_181423_owner_news_initial','20261005_133515_owner_news_media',
  '20261005_151541_owner_news_publication','20261005_220916_owner_news_legacy_history',
  '20261006_181325_a_owner_news_suspend_enum','20261006_181424_z_owner_news_native']

test('independent complete native snapshot survives logical reconstruction and captures invalid negative catalogs', options, async () => {
  const { PGlite } = require(modulePath!) as { PGlite: new () => DB }
  const db = new PGlite()
  try {
    const dialect = new PgDialect()
    for (const name of migrations) {
      const migration = await import(new URL(`../../src/migrations/${name}.ts`, import.meta.url).href)
      await migration.up({ db: { execute: async (sql: Parameters<PgDialect['sqlToQuery']>[0]) => {
        const query = dialect.sqlToQuery(sql); assert.equal(query.params.length, 0); await db.exec(query.sql)
      } } })
    }
    const original = await snapshot(db)
    await db.exec('SET search_path=pg_catalog,public')
    await recreateNativeCatalog(db)
    assert.deepEqual(await snapshot(db), original)
    await db.exec('SET search_path=public,pg_catalog')
    for (const ddl of [
      'CREATE SCHEMA fixture_empty',
      "CREATE TYPE fixture_type AS ENUM ('extra')",
      'CREATE MATERIALIZED VIEW fixture_view AS SELECT id FROM portal_editors',
      'ALTER TABLE news_migration_items DROP CONSTRAINT news_migration_items_source_identity_check; ALTER TABLE news_migration_items ADD CONSTRAINT news_migration_items_source_identity_check CHECK (true)',
    ]) {
      await db.exec(ddl)
      const invalid = await snapshot(db)
      assert.notEqual(invalid.schema, original.schema, 'capture must represent invalid native catalogs without validating/rejecting them')
      assert.deepEqual(await snapshot(db), invalid, 'unchanged negative target is representable')
      // Recreate the clean fixture rather than invoking the production guard.
      if (ddl.startsWith('CREATE SCHEMA')) await db.exec('DROP SCHEMA fixture_empty')
      else if (ddl.startsWith('CREATE TYPE')) await db.exec('DROP TYPE fixture_type')
      else if (ddl.startsWith('CREATE MATERIALIZED')) await db.exec('DROP MATERIALIZED VIEW fixture_view')
      else break
      assert.deepEqual(await snapshot(db), original)
    }
  } finally { await db.close() }
})

test('Portal migrations (except unavailable WASM pgcrypto loader) are captured without table exclusions', options, async t => {
  const { PGlite } = require(modulePath!) as { PGlite: new () => DB }
  const db = new PGlite()
  try {
    const directory = new URL('../../../api/db/migrations/', import.meta.url)
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8')
      await db.exec(name === '001_initial_schema.sql' ? sql.replace('CREATE EXTENSION IF NOT EXISTS "pgcrypto";', '') : sql)
    }
    await db.exec(`CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      INSERT INTO schema_migrations(version) VALUES ('fixture_ledger');
      INSERT INTO users(uid,email) VALUES ('fixture-user','fixture@example.invalid');
      INSERT INTO cms_editor_sessions(token_hash,user_uid,expires_at) VALUES (repeat('a',64),'fixture-user',now()+interval '1 day')`)
    const original = await snapshot(db)
    t.diagnostic('Actual Portal migration SQL executed except pgcrypto loader unavailable in this WASM build; native gen_random_uuid is available. No server or Docker.')
    assert.deepEqual(await snapshot(db), original)
    await db.exec('SET search_path=pg_catalog,public')
    await recreateNativeCatalog(db)
    assert.deepEqual(await snapshot(db), original, 'Portal rows, all sequences and complete logical schema survive observed reconstruction')
    await db.exec("UPDATE owner_news_authority SET epoch=epoch+1")
    assert.notEqual((await snapshot(db)).data, original.data)
    await db.exec('UPDATE owner_news_authority SET epoch=epoch-1')
    await db.exec("UPDATE cms_editor_sessions SET revoked_at=now()")
    assert.notEqual((await snapshot(db)).data, original.data, 'operational sessions are not omitted')
    await db.exec('UPDATE cms_editor_sessions SET revoked_at=NULL')
    await db.exec("UPDATE schema_migrations SET version='changed_ledger'")
    assert.notEqual((await snapshot(db)).data, original.data, 'migration ledger is not omitted')
  } finally { await db.close() }
})

test('row ordering, duplicates, precision, sequences and complete user schema objects are independently bound', options, async () => {
  const { PGlite } = require(modulePath!) as { PGlite: new () => DB }
  const db = new PGlite()
  try {
    await db.exec(`CREATE SCHEMA fixture;
      CREATE TABLE fixture.rows (n numeric, value text, nullable text, document jsonb, bytes bytea);
      INSERT INTO fixture.rows VALUES (9007199254740993,'x',NULL,'{"n":9007199254740993}','\\x00ff'),
        (9007199254740993,'x',NULL,'{"n":9007199254740993}','\\x00ff'), (9007199254740992,'y','','null','\\x');
      CREATE SEQUENCE fixture.counter AS bigint INCREMENT BY 3 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 2 CYCLE;
      SELECT setval('fixture.counter',9007199254740993,false);`)
    const original = await snapshot(db)
    const sequenceBefore = await db.query('SELECT last_value::text,is_called FROM fixture.counter')
    await db.exec('CREATE TEMP TABLE reorder AS SELECT * FROM fixture.rows ORDER BY n; TRUNCATE fixture.rows; INSERT INTO fixture.rows SELECT * FROM reorder; DROP TABLE reorder')
    assert.deepEqual(await snapshot(db), original, 'physical row order does not affect the logical multiset')
    assert.deepEqual(await db.query('SELECT last_value::text,is_called FROM fixture.counter'), sequenceBefore, 'snapshot does not advance sequences')
    const mutations = [
      "UPDATE fixture.rows SET n=9007199254740994 WHERE value='y'",
      "DELETE FROM fixture.rows WHERE ctid=(SELECT ctid FROM fixture.rows WHERE value='x' LIMIT 1)",
      "UPDATE fixture.rows SET nullable='' WHERE value='x'",
      "UPDATE fixture.rows SET document=NULL WHERE value='y'",
      "SELECT setval('fixture.counter',9007199254740994,false)",
      "SELECT setval('fixture.counter',9007199254740993,true)",
      'ALTER SEQUENCE fixture.counter INCREMENT BY 4',
      'ALTER TABLE fixture.rows ADD COLUMN extra text',
      'CREATE INDEX fixture_index ON fixture.rows (value)',
      'ALTER TABLE fixture.rows ADD CONSTRAINT fixture_check CHECK (n>0)',
      "CREATE TYPE fixture.extra AS ENUM ('a','b')",
      'CREATE VIEW fixture.extra_view AS SELECT * FROM fixture.rows',
      'CREATE FUNCTION fixture.answer() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 42 $$',
      `CREATE FUNCTION fixture.tg() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
       CREATE TRIGGER fixture_tg BEFORE INSERT ON fixture.rows FOR EACH ROW EXECUTE FUNCTION fixture.tg()`,
      "CREATE DOMAIN fixture.positive AS numeric CHECK (VALUE>0)",
    ]
    // Sequence state is nontransactional: restore explicitly after each mutation.
    for (const sql of mutations) {
      await db.exec(sql)
      assert.notDeepEqual(await snapshot(db), original, sql)
      if (sql.startsWith('UPDATE fixture.rows SET n=')) await db.exec("UPDATE fixture.rows SET n=9007199254740992 WHERE value='y'")
      else if (sql.startsWith('DELETE')) await db.exec("INSERT INTO fixture.rows VALUES (9007199254740993,'x',NULL,'{\"n\":9007199254740993}','\\x00ff')")
      else if (sql.startsWith('UPDATE fixture.rows SET nullable')) await db.exec("UPDATE fixture.rows SET nullable=NULL WHERE value='x'")
      else if (sql.startsWith('UPDATE fixture.rows SET document')) await db.exec("UPDATE fixture.rows SET document='null'::jsonb WHERE value='y'")
      else if (sql.includes('setval')) await db.exec("SELECT setval('fixture.counter',9007199254740993,false)")
      else if (sql.startsWith('ALTER SEQUENCE')) await db.exec('ALTER SEQUENCE fixture.counter INCREMENT BY 3')
      else if (sql.includes('ADD COLUMN')) await db.exec('ALTER TABLE fixture.rows DROP COLUMN extra')
      else if (sql.startsWith('CREATE INDEX')) await db.exec('DROP INDEX fixture.fixture_index')
      else if (sql.includes('ADD CONSTRAINT')) await db.exec('ALTER TABLE fixture.rows DROP CONSTRAINT fixture_check')
      else if (sql.startsWith('CREATE TYPE')) await db.exec('DROP TYPE fixture.extra')
      else if (sql.startsWith('CREATE VIEW')) await db.exec('DROP VIEW fixture.extra_view')
      else if (sql.startsWith('CREATE FUNCTION fixture.answer')) await db.exec('DROP FUNCTION fixture.answer()')
      else if (sql.startsWith('CREATE FUNCTION fixture.tg')) await db.exec('DROP TRIGGER fixture_tg ON fixture.rows; DROP FUNCTION fixture.tg()')
      else await db.exec('DROP DOMAIN fixture.positive')
      assert.deepEqual(await snapshot(db), original, `cleanup restores logical content after: ${sql}`)
    }
    await db.exec('CREATE TYPE fixture.rng AS RANGE (subtype=integer)')
    await assert.rejects(snapshot(db), /logical_snapshot_unsupported_object/u)
    await db.exec('DROP TYPE fixture.rng')
    assert.deepEqual(await snapshot(db), original, 'unsupported objects fail closed without mutating the fixture')

    await db.exec(`CREATE INDEX stable_index ON fixture.rows(value);
      CREATE FUNCTION fixture.tg() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$;
      CREATE TRIGGER stable_tg BEFORE INSERT ON fixture.rows FOR EACH ROW EXECUTE FUNCTION fixture.tg()`)
    const defined = await snapshot(db)
    await db.exec('DROP INDEX fixture.stable_index; CREATE INDEX stable_index ON fixture.rows(value) WHERE n>0')
    assert.notEqual((await snapshot(db)).schema, defined.schema, 'same-name index predicate is not reduced to an identity/count')
    await db.exec('DROP INDEX fixture.stable_index; CREATE INDEX stable_index ON fixture.rows(value)')
    assert.deepEqual(await snapshot(db), defined)
    await db.exec('ALTER TABLE fixture.rows DISABLE TRIGGER stable_tg')
    assert.notEqual((await snapshot(db)).schema, defined.schema)
    await db.exec('ALTER TABLE fixture.rows ENABLE TRIGGER stable_tg')
    await db.exec('CREATE OR REPLACE FUNCTION fixture.tg() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$')
    assert.notEqual((await snapshot(db)).schema, defined.schema, 'same-name routine body remains part of the actual schema')
  } finally { await db.close() }
})

test('logical column order remains significant and quoted identifiers are not executed as SQL', options, async () => {
  const { PGlite } = require(modulePath!) as { PGlite: new () => DB }
  const db = new PGlite()
  try {
    await db.exec(`CREATE SCHEMA "odd'; --"; CREATE TABLE "odd'; --"."rows;" (a integer,b text);
      INSERT INTO "odd'; --"."rows;" VALUES (NULL,NULL)`)
    const original = await snapshot(db)
    await db.exec(`ALTER TABLE "odd'; --"."rows;" ADD COLUMN c text; ALTER TABLE "odd'; --"."rows;" DROP COLUMN c`)
    assert.deepEqual(await snapshot(db), original, 'dropped physical holes do not change logical columns')
    await db.exec(`ALTER TABLE "odd'; --"."rows;" DROP COLUMN a; ALTER TABLE "odd'; --"."rows;" ADD COLUMN a integer`)
    const reordered = await snapshot(db)
    assert.equal(reordered.data, original.data)
    assert.notEqual(reordered.schema, original.schema, 'visible logical column order is retained')
  } finally { await db.close() }
})

test('SQL NULL versus JSON null, JSON lexemes, array bounds and null composites are not collapsed', options, async () => {
  const { PGlite } = require(modulePath!) as { PGlite: new () => DB }
  const db = new PGlite()
  try {
    await db.exec(`CREATE TYPE pair AS (a integer,b text);
      CREATE TABLE exact_values (j json,jb jsonb,a integer[],c pair);
      INSERT INTO exact_values VALUES ('{"x":1,"x":2}','null',ARRAY[1,2],ROW(NULL,NULL)::pair);
      CREATE TABLE empty_tuple (); INSERT INTO empty_tuple DEFAULT VALUES;`)
    const original = await snapshot(db)
    for (const [change, undo] of [
      ["UPDATE exact_values SET j='{\"x\":2}'", "UPDATE exact_values SET j='{\"x\":1,\"x\":2}'"],
      ['UPDATE exact_values SET jb=NULL', "UPDATE exact_values SET jb='null'"],
      ["UPDATE exact_values SET a='[0:1]={1,2}'", 'UPDATE exact_values SET a=ARRAY[1,2]'],
      ['UPDATE exact_values SET c=NULL', 'UPDATE exact_values SET c=ROW(NULL,NULL)::pair'],
    ]) {
      await db.exec(change!)
      assert.notEqual((await snapshot(db)).data, original.data, change)
      await db.exec(undo!)
      assert.deepEqual(await snapshot(db), original)
    }
    await db.exec('INSERT INTO empty_tuple DEFAULT VALUES')
    assert.notEqual((await snapshot(db)).data, original.data, 'zero-column duplicate rows are still counted')
  } finally { await db.close() }
})

test('real unsupported conversions, handlerless FDWs and unused user access methods fail closed', options, async t => {
  const { PGlite } = require(modulePath!) as { PGlite: new () => DB }
  const db = new PGlite()
  try {
    const baseline = await snapshot(db)
    const builtin = await db.query(`SELECT n.nspname AS schema,p.proname AS function
      FROM pg_conversion c JOIN pg_proc p ON p.oid=c.conproc JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE c.conforencoding=pg_char_to_encoding('UTF8') AND c.contoencoding=pg_char_to_encoding('LATIN1') LIMIT 1`)
    assert.equal(builtin.rows.length, 1, 'the engine must expose a real encoding-conversion function')
    const identifier = (value: unknown) => `"${String(value).replaceAll('"','""')}"`
    const cases = [
      { name: 'conversion', create: `CREATE CONVERSION public.fixture_conversion FOR 'UTF8' TO 'LATIN1'
        FROM ${identifier(builtin.rows[0]!.schema)}.${identifier(builtin.rows[0]!.function)}`,
        remove: 'DROP CONVERSION public.fixture_conversion', catalog: "SELECT count(*)::text AS count FROM pg_conversion WHERE conname='fixture_conversion'" },
      { name: 'handlerless FDW', create: 'CREATE FOREIGN DATA WRAPPER fixture_fdw NO HANDLER NO VALIDATOR',
        remove: 'DROP FOREIGN DATA WRAPPER fixture_fdw', catalog: "SELECT count(*)::text AS count FROM pg_foreign_data_wrapper WHERE fdwname='fixture_fdw' AND fdwhandler=0" },
      { name: 'unused user AM', create: 'CREATE ACCESS METHOD fixture_am TYPE TABLE HANDLER pg_catalog.heap_tableam_handler',
        remove: 'DROP ACCESS METHOD fixture_am', catalog: "SELECT count(*)::text AS count FROM pg_am WHERE amname='fixture_am'" },
    ]
    for (const item of cases) {
      await t.test(item.name, async subtest => {
        try { await db.exec(item.create) }
        catch (error) {
          // An engine capability absence is not evidence of snapshot rejection.
          // It must remain a visible skip with an explicit Linux CI obligation.
          const code = (error as { code?: string }).code
          const unavailableConversionLibrary = item.name === 'conversion' && code === '58P01'
            && (error as Error).message.includes('$libdir/utf8_and_iso8859_1')
          if (code === '0A000' || unavailableConversionLibrary) {
            subtest.skip(`PGlite SQL capability unavailable (${code}); execute this exact DDL/capture case on PG16 Linux CI`)
            return
          }
          throw error
        }
        try {
          assert.equal((await db.query(item.catalog)).rows[0]!.count, '1')
          await assert.rejects(snapshot(db), { message: 'logical_snapshot_unsupported_object' })
        } finally { await db.exec(item.remove) }
        assert.deepEqual(await snapshot(db), baseline)
      })
    }
  } finally { await db.close() }
})
