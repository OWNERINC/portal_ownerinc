import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { NEWS_MUTATION_LEDGER_STATEMENTS } from '../../src/publication/mutation-ledger'
import { legacyLedgerDDL, legacyLedgerHeadDDL } from '../fixtures/protocol-ledger-legacy'

// Explicit opt-in to an ALREADY INSTALLED local PGlite CJS entrypoint. No package
// install, listener, database URL, disk dataDir, Docker or authenticated roles.
const modulePath = process.env.OWNERINC_PROTOCOL_PGLITE_MODULE
const require = createRequire(import.meta.url)
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const catalogSQL = `SELECT c.relname, c.relkind, pg_catalog.pg_get_userbyid(c.relowner) AS owner,
  a.attname, a.attnum, a.attnotnull, pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,
  pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expression
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  WHERE n.nspname='public' ORDER BY c.relname,a.attnum`
const constraintsSQL = `SELECT c.relname, con.conname, con.contype,
  pg_catalog.pg_get_constraintdef(con.oid,false) AS definition
  FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid=con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' ORDER BY c.relname,con.conname`
const indexesSQL = `SELECT tablename, indexname, indexdef
  FROM pg_catalog.pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname`

test('local PGlite reproduces catalog-creation 42501 and proves qualified ledger compatibility/rollback',
  { skip: !modulePath }, async () => {
    assert.ok(modulePath && path.isAbsolute(modulePath), 'explicit absolute local module required')
    const { PGlite } = require(modulePath)
    const db = new PGlite()
    try {
      const version = (await db.query('SELECT version() AS version')).rows[0].version
      assert.match(version, /PostgreSQL 16\./u)
      const serverVersion = (await db.query('SHOW server_version')).rows[0].server_version
      assert.match(serverVersion, /^16\.\d+$/u)
      await db.exec('CREATE TABLE public.news_migration_runs(id uuid PRIMARY KEY)')
      const snapshot = async () => ({ columns: (await db.query(catalogSQL)).rows,
        constraints: (await db.query(constraintsSQL)).rows, indexes: (await db.query(indexesSQL)).rows })
      const baseline = await snapshot()

      const systemModsInitially = (await db.query('SHOW allow_system_table_mods')).rows[0].allow_system_table_mods
      // PGlite can enable system modifications for its own bootstrap. Reproduce
      // the PostgreSQL production default explicitly; do not claim WASM defaults.
      await db.exec('BEGIN; SET LOCAL allow_system_table_mods = off; SET LOCAL search_path = pg_catalog, public;')
      let code: string | undefined
      let catalogTargetRejected = false
      try { await db.exec(legacyLedgerHeadDDL) } catch (error) {
        const failure = error as { code?: string; message?: string }
        code = failure.code
        catalogTargetRejected = typeof failure.message === 'string' && failure.message.includes('pg_catalog.owner_news_mutation_head')
      }
      assert.equal(code, '42501')
      assert.equal(catalogTargetRejected, true)
      await db.exec('ROLLBACK')
      assert.deepEqual(await snapshot(), baseline)

      // Legacy install used public as creation target. Snapshot under the SAME
      // deparser search_path as the corrected install; OIDs/xmin are not hashes.
      await db.exec('BEGIN; SET LOCAL allow_system_table_mods = off; SET LOCAL search_path = public;')
      await db.exec(legacyLedgerDDL)
      await db.exec('SET LOCAL search_path = pg_catalog, public')
      const legacyCatalog = await snapshot()
      const legacyHead = (await db.query('SELECT * FROM public.owner_news_mutation_head')).rows
      await db.exec('ROLLBACK')
      assert.deepEqual(await snapshot(), baseline)

      await db.exec('BEGIN; SET LOCAL allow_system_table_mods = off; SET LOCAL search_path = pg_catalog, public;')
      for (const statement of NEWS_MUTATION_LEDGER_STATEMENTS) await db.exec(statement.sql)
      assert.equal((await db.query('SHOW search_path')).rows[0].search_path, 'pg_catalog, public')
      const correctedCatalog = await snapshot()
      assert.deepEqual(correctedCatalog, legacyCatalog)
      assert.deepEqual((await db.query('SELECT * FROM public.owner_news_mutation_head')).rows, legacyHead)
      assert.equal(legacyHead[0].coverage_version, 0)
      assert.equal(legacyHead[0].write_barrier, 'open')
      assert.equal((await db.query('SELECT count(*)::text AS count FROM public.owner_news_mutation_events')).rows[0].count, '0')
      await db.exec('ROLLBACK')
      assert.deepEqual(await snapshot(), baseline)
      const failureRollbacks = []
      // Real transaction aborts after each explicit statement boundary. Duplicate
      // the targeted statement inside this throwaway transaction to force a PG
      // error without fault hooks or changes to the production installer.
      for (const [index, statement] of NEWS_MUTATION_LEDGER_STATEMENTS.entries()) {
        await db.exec('BEGIN; SET LOCAL allow_system_table_mods = off; SET LOCAL search_path = pg_catalog, public;')
        for (const earlier of NEWS_MUTATION_LEDGER_STATEMENTS.slice(0, index + 1)) await db.exec(earlier.sql)
        let sqlstate: string | undefined
        try { await db.exec(statement.sql) } catch (error) { sqlstate = (error as { code?: string }).code }
        assert.equal(sqlstate, statement.operation === 'ledger-head-init' ? '23505' : '42P07')
        await db.exec('ROLLBACK')
        assert.deepEqual(await snapshot(), baseline)
        failureRollbacks.push({ operation: statement.operation, sqlstate, unchanged: true })
      }
      assert.equal((await db.query(`SELECT count(*)::text AS count FROM pg_catalog.pg_class c
        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='pg_catalog' AND c.relname IN ('owner_news_mutation_head','owner_news_mutation_events')`)).rows[0].count, '0')
      console.log(JSON.stringify({ engine: 'pglite-wasm-pg16', serverVersion, firstCreateSqlstate: code,
        systemModsInitially, reproducedSystemMods: 'off',
        catalogTargetRejected, catalogEquivalent: true, rollbackUnchanged: true,
        failureRollbacks,
        catalogSha256: hash(correctedCatalog), coverageVersion: 0, ready: false,
        authenticatedRoleAcceptance: false, linuxProtocolAcceptance: false }))
    } finally { await db.close() }
  })
