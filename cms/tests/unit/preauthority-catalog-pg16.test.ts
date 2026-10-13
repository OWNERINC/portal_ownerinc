import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import { recreateNativeCatalog } from '../fixtures/recreate-native-catalog'
import {
  verifyPreauthorityNativeCatalog,
  type FinalizerClient,
  type PreauthorityCatalogDiagnosticStage,
} from '../../scripts/finalize-news-protocol'

const require = createRequire(import.meta.url)
// Optional existing test tool, never installed by verify or added to runtime.
// An explicitly supplied module must exist; only absence of the optional default
// produces a visible skip. The override is a local tooling path, not a DB URL.
const suppliedModule = process.env.CMS_TEST_PGLITE_MODULE
if (suppliedModule && !isAbsolute(suppliedModule)) throw new Error('CMS_TEST_PGLITE_MODULE must be absolute')
let pgliteModule: string | undefined
try { pgliteModule = require.resolve(suppliedModule || '@electric-sql/pglite') }
catch (error) { if (suppliedModule) throw error }

type Result = { rows: Record<string, unknown>[] }
type PgliteClient = {
  exec(sql: string): Promise<unknown>
  query(sql: string, values?: unknown[], options?: { parsers: Record<number, (value: string) => unknown> }): Promise<Result>
  close(): Promise<void>
}
const migrations = [
  '20261002_181423_owner_news_initial', '20261005_133515_owner_news_media',
  '20261005_151541_owner_news_publication', '20261005_220916_owner_news_legacy_history',
  '20261006_181325_a_owner_news_suspend_enum', '20261006_181424_z_owner_news_native',
]

test('actual PostgreSQL catalog queries reject namespace lookalikes and retain only automatic exclusions', {
  skip: pgliteModule ? false : 'optional PGlite unavailable; set CMS_TEST_PGLITE_MODULE to an existing module',
  timeout: 120_000,
}, async t => {
  const { PGlite } = require(pgliteModule!) as { PGlite: new () => PgliteClient }
  const { types } = require('pg') as { types: { getTypeParser(oid: number): (value: string) => unknown } }
  const db = new PGlite() // In-memory only: no server, socket, credential or storage path.
  try {
    t.diagnostic(String((await db.query('SELECT version() AS version')).rows[0]!.version))
    const dialect = new PgDialect()
    for (const name of migrations) {
      const migration = await import(new URL(`../../src/migrations/${name}.ts`, import.meta.url).href)
      await migration.up({ db: { execute: async (sql: Parameters<PgDialect['sqlToQuery']>[0]) => {
        const query = dialect.sqlToQuery(sql)
        assert.equal(query.params.length, 0, 'native migrations contain no interpolated inputs')
        await db.exec(query.sql)
      } } })
    }
    const parsers = Object.fromEntries((await db.query('SELECT oid FROM pg_type')).rows
      .map(row => [Number(row.oid), types.getTypeParser(Number(row.oid))]))
    let currentStage: PreauthorityCatalogDiagnosticStage = 'native_relations'
    const queries = new Map<PreauthorityCatalogDiagnosticStage, { sql: string; values?: unknown[] }>()
    const client: FinalizerClient = {
      connect: async () => {}, end: async () => {},
      query: async (sql, values) => {
        if (!queries.has(currentStage)) queries.set(currentStage, { sql, values })
        return db.query(sql, values, { parsers })
      },
    }
    const verify = () => verifyPreauthorityNativeCatalog(client, migrations, stage => { currentStage = stage })
    for (const name of migrations) await db.query('INSERT INTO payload_migrations (name, batch) VALUES ($1, 1)', [name])
    const seededLedger = () => db.query('SELECT * FROM payload_migrations ORDER BY name')
    const ledgerBefore = await seededLedger()
    const canonical = await verify()
    // Reproduce the recovery fixture's exact committed CREATE/DROP sequence.
    // Read sequences without nextval: catalog validation must not advance them.
    const sequenceState = () => db.query('SELECT schemaname, sequencename, last_value FROM pg_sequences ORDER BY schemaname, sequencename')
    const sequencesBefore = await sequenceState()
    const relationSql = queries.get('native_relations')!.sql
    const previousSql = relationSql.replace(
      "FROM pg_catalog.pg_namespace n LEFT JOIN pg_catalog.pg_class c\n      ON n.oid=c.relnamespace AND c.relkind IN ('r','p','v','m','f','S','c')",
      'FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace',
    ).replace("AND n.nspname !~ '^pg_temp_[0-9]+$'", () => "AND n.nspname !~ '^pg_temp_[0-9]+$' AND c.relkind IN ('r','p','v','m','f','S','c')")
    assert.notEqual(previousSql, relationSql)
    const previousBaseline = await db.query(previousSql)
    await db.exec('CREATE SCHEMA fixture_unexpected_schema')
    assert.deepEqual(await db.query(previousSql), previousBaseline, 'the old inner join silently omits the real empty schema')
    assert.equal(await verifyPreauthorityNativeCatalog({ ...client, query: (sql, values) =>
      db.query(sql === relationSql ? previousSql : sql, values, { parsers }) }, migrations, () => {}), canonical,
    'the previous complete native verifier accepts the injected empty schema')
    await assert.rejects(verify(), /preauthority_native_relation_inventory_mismatch/u)
    assert.equal(currentStage, 'native_relations')
    assert.deepEqual(await sequenceState(), sequencesBefore)
    assert.deepEqual(await seededLedger(), ledgerBefore)
    await db.exec('DROP SCHEMA fixture_unexpected_schema')
    assert.equal(await verify(), canonical)
    assert.deepEqual(await sequenceState(), sequencesBefore)
    assert.deepEqual(await seededLedger(), ledgerBefore)
    assert.deepEqual([...queries.keys()], ['native_relations', 'native_columns', 'native_indexes', 'native_constraints', 'native_types'])
    const executeCatalog = async (stage: PreauthorityCatalogDiagnosticStage) => {
      const query = queries.get(stage)!
      return db.query(query.sql, query.values, { parsers })
    }

    // Real temp relation/index/constraint/TOAST objects must remain excluded.
    await db.exec('CREATE TEMP TABLE fixture_temp (payload text PRIMARY KEY)')
    assert.equal(await verify(), canonical)
    const namespaces = await db.query("SELECT nspname FROM pg_namespace WHERE nspname ~ '^pg_(toast_temp|temp)_[0-9]+$'")
    assert.ok(namespaces.rows.some(row => /^pg_temp_[0-9]+$/u.test(String(row.nspname))))
    assert.ok(namespaces.rows.some(row => /^pg_toast_temp_[0-9]+$/u.test(String(row.nspname))))

    for (const schema of ['pgxtoast_hidden', 'pgxtempyhidden']) {
      for (const kind of ['enum', 'domain', 'composite', 'table'] as const) {
        await t.test(`${schema}: real ${kind} is visible and rejected`, async () => {
          await db.exec('BEGIN')
          try {
            // Identifiers are fixed test cases, never externally supplied.
            await db.exec(`CREATE SCHEMA ${schema}`)
            const ddl = {
              enum: `CREATE TYPE ${schema}.fixture_extra AS ENUM ('x')`,
              domain: `CREATE DOMAIN ${schema}.fixture_extra AS text`,
              composite: `CREATE TYPE ${schema}.fixture_extra AS (x text)`,
              table: `CREATE TABLE ${schema}.fixture_extra (id integer PRIMARY KEY, payload text CHECK (length(payload) > 0));
                CREATE INDEX fixture_payload_idx ON ${schema}.fixture_extra (payload)`,
            }[kind]
            await db.exec(ddl)
            if (kind === 'table') {
              // Execute ALL affected real queries even though the full verifier
              // correctly stops first at the extra relation. No injected rows.
              for (const stage of ['native_relations', 'native_indexes', 'native_constraints'] as const) {
                const result = await executeCatalog(stage)
                const extra = result.rows.filter(row => (row.schema ?? row.table_schema) === schema)
                assert.ok(extra.length > 0, `${stage} must not hide ${schema}`)
                if (stage === 'native_indexes') assert.ok(extra.some(row => row.index_name === 'fixture_payload_idx'))
                if (stage === 'native_constraints') assert.ok(extra.some(row => row.kind === 'c'))
              }
            } else {
              const result = await executeCatalog('native_types')
              const extra = result.rows.filter(row => row.schema === schema)
              assert.deepEqual(extra, [{ schema, name: 'fixture_extra', kind: { enum: 'e', domain: 'd', composite: 'c' }[kind],
                labels: kind === 'enum' ? ['x'] : [] }], 'only the dependent automatic array is excluded')
            }
            await assert.rejects(verify(), /preauthority_native_relation_inventory_mismatch/u)
          } finally { await db.exec('ROLLBACK') }
          assert.equal(await verify(), canonical, 'the full real native catalog passes after each rollback')
        })
      }
    }
  } finally { await db.close() }
})

test('real migrated and logically recreated catalogs have the same observed fingerprint despite CHECK deparser regrouping', {
  skip: pgliteModule ? false : 'optional PGlite unavailable; set CMS_TEST_PGLITE_MODULE to an existing module',
  timeout: 120_000,
}, async t => {
  const { PGlite } = require(pgliteModule!) as { PGlite: new () => PgliteClient }
  const db = new PGlite()
  try {
    const dialect = new PgDialect()
    for (const name of migrations) {
      const migration = await import(new URL(`../../src/migrations/${name}.ts`, import.meta.url).href)
      await migration.up({ db: { execute: async (sql: Parameters<PgDialect['sqlToQuery']>[0]) => {
        const query = dialect.sqlToQuery(sql)
        assert.equal(query.params.length, 0)
        await db.exec(query.sql)
      } } })
    }
    await db.exec('SET search_path = pg_catalog, public')
    let stage: PreauthorityCatalogDiagnosticStage = 'native_relations'
    let capture: Record<string, Record<string, unknown>[]> = {}
    const client: FinalizerClient = {
      connect: async () => {}, end: async () => {},
      query: async (sql, values) => {
        const result = await db.query(sql, values)
        capture[stage] = result.rows
        return result
      },
    }
    const verify = () => verifyPreauthorityNativeCatalog(client, migrations, value => { stage = value })
    const sourceHash = await verify()
    const source = capture
    const sourceOid = (await db.query("SELECT 'public.news_migration_items'::regclass::oid AS oid")).rows[0]!.oid
    await recreateNativeCatalog(db)
    assert.notEqual((await db.query("SELECT 'public.news_migration_items'::regclass::oid AS oid")).rows[0]!.oid, sourceOid)
    capture = {}
    assert.equal(await verify(), sourceHash, 'hash must come from equivalent observed catalogs, not physical OIDs or deparser formatting')
    const restored = capture
    for (const name of ['native_relations', 'native_columns', 'native_indexes', 'native_types']) {
      assert.deepEqual(restored[name], source[name], `${name} unchanged in the reproduction`)
    }
    const different = source.native_constraints!.filter((row, index) =>
      JSON.stringify(row) !== JSON.stringify(restored.native_constraints![index]))
    assert.deepEqual(different.map(row => row.constraint_name), ['news_migration_items_source_identity_check'])
    assert.notDeepEqual(source.native_constraints, restored.native_constraints, 'raw-string hashing reproduces the mismatch')
    t.diagnostic('Observed CHECK regrouping reproduced across full logical schema recreation; this is not pg_dump/pg_restore.')

    // Real post-recreation drift must still reject, never yield a canonical hash.
    const foreignKey = restored.native_constraints!.find(row => row.kind === 'f')!
    const changedForeignKey = String(foreignKey.definition).replace(/ON DELETE (CASCADE|SET NULL|RESTRICT|NO ACTION)/u,
      clause => clause === 'ON DELETE CASCADE' ? 'ON DELETE RESTRICT' : 'ON DELETE CASCADE')
    assert.notEqual(changedForeignKey, foreignKey.definition)
    const index = restored.native_indexes!.find(row => row.is_primary === false && row.is_unique === false)!
    const enumType = restored.native_types!.find(row => row.kind === 'e')!
    const mutations = [
      `ALTER TABLE news_migration_items DROP CONSTRAINT news_migration_items_source_identity_check;
       ALTER TABLE news_migration_items ADD CONSTRAINT news_migration_items_source_identity_check CHECK (true)`,
      `DROP INDEX public."${index.index_name}"; ${index.definition} WHERE false`,
      `ALTER TABLE public."${foreignKey.table_name}" DROP CONSTRAINT "${foreignKey.constraint_name}";
       ALTER TABLE public."${foreignKey.table_name}" ADD CONSTRAINT "${foreignKey.constraint_name}" ${changedForeignKey}`,
      `ALTER TYPE public."${enumType.name}" ADD VALUE 'fixture_extra_label'`,
      "ALTER TABLE news_migration_items ALTER COLUMN source_id SET DEFAULT 'changed'",
    ]
    for (const [mutationIndex, sql] of mutations.entries()) {
      await db.exec('BEGIN')
      try {
        await db.exec(sql)
        await assert.rejects(verify(), /preauthority_native_(constraint|index|type|column)_inventory_mismatch/u, `mutation ${mutationIndex}`)
      } finally { await db.exec('ROLLBACK') }
      assert.equal(await verify(), sourceHash)
    }
  } finally { await db.close() }
})
