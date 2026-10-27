import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { migrations } from '../migrations/index'
import { NEWS_MUTATION_TABLES } from '../publication/mutation-ledger'
import { expectedNewsMutationTriggerFunctionBodies } from '../publication/mutation-triggers'
import { requireCmsTransaction, withCmsTransaction } from '../publication/transaction'

type ReadinessFile = { sync(): Promise<void>; close(): Promise<void> }
type ReadinessFileSystem = {
  open(filename: string, flags: 'wx', mode: number): Promise<ReadinessFile>
  unlink(filename: string): Promise<void>
}

/** Proves the configured mounted storage accepts a durable private file. The
 * probe is always removed and contains no content or identity data. */
export async function assertCmsStorageReady(directory: string,
  fileSystem: ReadinessFileSystem = fs, id: () => string = randomUUID): Promise<void> {
  const filename = path.join(directory, `.ownerinc-ready-${id()}`)
  let file: ReadinessFile | undefined
  let created = false
  let primary: unknown
  try {
    file = await fileSystem.open(filename, 'wx', 0o600)
    created = true
    await file.sync()
  } catch (error) {
    primary = error
    throw error
  } finally {
    await file?.close().catch(() => {})
    if (created) {
      try { await fileSystem.unlink(filename) }
      catch (error) { if (primary === undefined) throw error }
    }
  }
}

const requiredRelations = ['payload_migrations', 'portal_editors', 'news_articles', '_news_articles_v',
  'news_media', 'news_home', '_news_home_v', 'news_schedules', 'owner_news_mutation_head', 'owner_news_mutation_events'] as const

const requiredColumns = [
  ['payload_migrations', 'id'], ['payload_migrations', 'name'], ['payload_migrations', 'batch'],
  ['portal_editors', 'id'], ['portal_editors', 'portal_uid'], ['portal_editors', 'email'],
  ['news_articles', 'id'], ['news_articles', 'title'], ['news_articles', 'category'], ['news_articles', 'publication_generation'], ['news_articles', '_status'],
  ['_news_articles_v', 'id'], ['_news_articles_v', 'parent_id'], ['_news_articles_v', 'version__status'],
  ['news_media', 'id'], ['news_media', 'sha256'], ['news_media', 'filename'],
  ['news_home', 'id'], ['news_home', 'publication_generation'], ['news_home', '_status'],
  ['_news_home_v', 'id'], ['_news_home_v', 'latest'], ['_news_home_v', 'version__status'],
  ['news_schedules', 'id'], ['news_schedules', 'target'], ['news_schedules', 'scheduled_at'], ['news_schedules', 'state'],
  ['owner_news_mutation_head', 'singleton'], ['owner_news_mutation_head', 'sequence'], ['owner_news_mutation_head', 'chain_sha256'],
  ['owner_news_mutation_head', 'coverage_version'], ['owner_news_mutation_head', 'write_barrier'],
  ['owner_news_mutation_events', 'sequence'], ['owner_news_mutation_events', 'event_sha256'],
] as const

type RuntimeCatalog = {
  migrations: unknown[]
  columns: unknown[]
  functions: unknown[]
  triggers: unknown[]
}

const rowKey = (row: unknown, fields: string[]): string | null => {
  if (!row || typeof row !== 'object') return null
  const values = row as Record<string, unknown>
  return fields.every(field => typeof values[field] === 'string') ? fields.map(field => values[field]).join(':') : null
}

export function assertCmsRuntimeCatalog(catalog: RuntimeCatalog): void {
  const observedMigrations = catalog.migrations.map(row => rowKey(row, ['name']))
  const expectedMigrations = migrations.map(migration => migration.name)
  if (observedMigrations.some(name => name === null) || observedMigrations.length !== expectedMigrations.length
    || new Set(observedMigrations).size !== observedMigrations.length
    || expectedMigrations.some(name => !observedMigrations.includes(name))) throw new Error('cms_readiness_migrations_incompatible')

  const observedColumns = new Set(catalog.columns.map(row => rowKey(row, ['table_name', 'column_name'])))
  if (observedColumns.has(null) || requiredColumns.some(([table, column]) => !observedColumns.has(`${table}:${column}`))) {
    throw new Error('cms_readiness_columns_incompatible')
  }

  const expectedFunctions = expectedNewsMutationTriggerFunctionBodies()
  if (catalog.functions.length !== expectedFunctions.size || catalog.functions.some(row => {
    if (!row || typeof row !== 'object') return true
    const value = row as Record<string, unknown>
    const name = typeof value.function_name === 'string' ? value.function_name : ''
    return !expectedFunctions.has(name) || value.source !== expectedFunctions.get(name)
      || value.security_definer !== (name === 'owner_news_mutation_capture_row' ? 'true' : 'false')
      || value.owner !== 'cms_control' || value.config !== 'search_path=pg_catalog, public'
      || value.identity_arguments !== '' || value.result !== 'trigger'
  })) throw new Error('cms_readiness_functions_incompatible')

  const observedTriggers = catalog.triggers.map(row => rowKey(row, ['table_name', 'trigger_name', 'function_name', 'function_schema', 'trigger_type',
    'enabled', 'attribute_count', 'argument_count', 'argument_bytes', 'no_condition']))
  const expectedTriggers = NEWS_MUTATION_TABLES.flatMap(table => [
    `${table}:owner_news_mutation_guard_stmt:owner_news_mutation_guard_stmt:public:62:A:0:0:0:true`,
    `${table}:owner_news_mutation_capture_row:owner_news_mutation_capture_row:public:29:A:0:0:0:true`,
  ])
  if (observedTriggers.some(name => name === null) || observedTriggers.length !== expectedTriggers.length
    || new Set(observedTriggers).size !== observedTriggers.length
    || expectedTriggers.some(name => !observedTriggers.includes(name))) throw new Error('cms_readiness_triggers_incompatible')
}

export function assertCmsSchemaCatalog(row: unknown): void {
  if (!row || typeof row !== 'object') throw new Error('cms_readiness_schema_incomplete')
  const values = row as Record<string, unknown>
  if (Object.keys(values).length !== requiredRelations.length || requiredRelations.some(name => values[name] !== name)) {
    throw new Error('cms_readiness_schema_incomplete')
  }
}

export async function assertCmsDatabaseReady(payload: Payload): Promise<void> {
  await withCmsTransaction(payload, undefined, async req => {
    const db = await requireCmsTransaction(payload, req)
    const result = await db.execute(sql`SELECT
      to_regclass('public.payload_migrations')::text AS payload_migrations,
      to_regclass('public.portal_editors')::text AS portal_editors,
      to_regclass('public.news_articles')::text AS news_articles,
      to_regclass('public._news_articles_v')::text AS _news_articles_v,
      to_regclass('public.news_media')::text AS news_media,
      to_regclass('public.news_home')::text AS news_home,
      to_regclass('public._news_home_v')::text AS _news_home_v,
      to_regclass('public.news_schedules')::text AS news_schedules,
      to_regclass('public.owner_news_mutation_head')::text AS owner_news_mutation_head,
      to_regclass('public.owner_news_mutation_events')::text AS owner_news_mutation_events`)
    if (result.rows.length !== 1) throw new Error('cms_readiness_schema_incomplete')
    assertCmsSchemaCatalog(result.rows[0])
    const migrationRows = await db.execute(sql`SELECT name FROM public.payload_migrations`)
    const columnRows = await db.execute(sql`SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name IN ('payload_migrations', 'portal_editors', 'news_articles', '_news_articles_v',
        'news_media', 'news_home', '_news_home_v', 'news_schedules', 'owner_news_mutation_head', 'owner_news_mutation_events')`)
    const functionRows = await db.execute(sql`SELECT procedure.proname AS function_name, procedure.prosrc AS source,
        procedure.prosecdef::text AS security_definer, role.rolname AS owner,
        array_to_string(procedure.proconfig, E'\n') AS config,
        pg_catalog.pg_get_function_identity_arguments(procedure.oid) AS identity_arguments,
        pg_catalog.pg_get_function_result(procedure.oid) AS result
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      JOIN pg_catalog.pg_roles AS role ON role.oid = procedure.proowner
      WHERE namespace.nspname = 'public'
        AND procedure.proname IN ('owner_news_mutation_guard_stmt', 'owner_news_mutation_capture_row')`)
    const triggerRows = await db.execute(sql`SELECT relation.relname AS table_name, trigger.tgname AS trigger_name,
        procedure.proname AS function_name, procedure_namespace.nspname AS function_schema,
        trigger.tgtype::int::text AS trigger_type, trigger.tgenabled::text AS enabled,
        COALESCE(array_length(trigger.tgattr, 1), 0)::text AS attribute_count,
        trigger.tgnargs::int::text AS argument_count, octet_length(trigger.tgargs)::text AS argument_bytes,
        (trigger.tgqual IS NULL)::text AS no_condition
      FROM pg_catalog.pg_trigger AS trigger
      JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
      JOIN pg_catalog.pg_namespace AS relation_namespace ON relation_namespace.oid = relation.relnamespace
      JOIN pg_catalog.pg_proc AS procedure ON procedure.oid = trigger.tgfoid
      JOIN pg_catalog.pg_namespace AS procedure_namespace ON procedure_namespace.oid = procedure.pronamespace
      WHERE NOT trigger.tgisinternal AND relation_namespace.nspname = 'public'
        AND trigger.tgname IN ('owner_news_mutation_guard_stmt', 'owner_news_mutation_capture_row')`)
    const coveredTriggerRows = triggerRows.rows.filter(row => row && typeof row === 'object'
      && NEWS_MUTATION_TABLES.includes((row as Record<string, unknown>).table_name as typeof NEWS_MUTATION_TABLES[number]))
    assertCmsRuntimeCatalog({ migrations: migrationRows.rows, columns: columnRows.rows,
      functions: functionRows.rows, triggers: coveredTriggerRows })
  })
}
