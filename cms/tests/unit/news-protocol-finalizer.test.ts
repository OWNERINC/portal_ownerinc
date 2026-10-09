import assert from 'node:assert/strict'
import test from 'node:test'
import { NEWS_MUTATION_LEDGER_STATEMENTS, NEWS_MUTATION_TABLES, type NewsMutationLedgerOperation } from '../../src/publication/mutation-ledger'
import { buildNewsMutationTriggersDDL } from '../../src/publication/mutation-triggers'
import {
  buildNewsMigrationBootstrapRunDDL,
  NEWS_MIGRATION_BOOTSTRAP_RUN_SIGNATURE,
  NEWS_MIGRATION_RUN_BOOTSTRAP_INSERT_COLUMNS,
} from '../../src/publication/bootstrap-run'
import {
  finalizeNewsProtocol,
  diagnoseFinalizerPreconditionsReadOnly,
  formatFinalizerCloseDiagnostic,
  formatFinalizerFailureDiagnostic,
  getFinalizerCloseDiagnostic,
  getFinalizerFailureDiagnostic,
  canonicalTriggerDefinitions,
  normalizeTriggerDefinition,
  extractCanonicalFunctionBodies,
  NEWS_MIGRATION_ITEM_BINDING_DDL,
  nativeSchemaSnapshot,
  jsonbDefaultLiteralsMatch,
  catalogTextArrayMatches,
  NATIVE_ENUM_CATALOG_SQL,
  NATIVE_FOREIGN_KEYS_CATALOG_SQL,
  parseJsonbDefaultLiteral,
  runFinalizer,
  auditNewsProtocolReadOnly,
  parseProtocolFinalizerArguments,
  upgradeNewsProtocolV1ToV2,
  type FinalizerClient,
  type QueryResult,
} from '../../scripts/finalize-news-protocol'
import { buildFinalizerRollbackFixtureNames } from '../integration/protocol-finalizer.mjs'
import {
  controlRolesNativePrivilegesVerificationSQL,
  controlRolesPublicVerificationSQL,
  controlRolesOwnershipVerificationSQL,
  controlRolesVerificationSQL,
  runtimeProtocolFunctionsVerifySQL,
  runtimeProtocolPrivilegesVerifySQL,
} from '../../scripts/provision-db'
import {
  newsProtocolObserverOwnershipCatalogPrivilegeVerificationSQL,
  newsProtocolObserverPrivilegesVerificationSQL,
  newsProtocolObserverRoleVerificationSQL,
} from '../../scripts/news-protocol-observer-contract'

const migrations = [
  '20261002_181423_owner_news_initial', '20261005_133515_owner_news_media',
  '20261005_151541_owner_news_publication', '20261005_220916_owner_news_legacy_history',
  '20261006_181325_a_owner_news_suspend_enum', '20261006_181424_z_owner_news_native',
]
const controlColumns = {
  reconciliation_sequence: 'varchar', reconciliation_chain_sha256: 'varchar', reconciliation_sha256: 'varchar',
  destination_fingerprint: 'varchar', unresolved_exceptions: 'jsonb', sealed_sequence: 'varchar',
  sealed_chain_sha256: 'varchar', sealed_at: 'timestamptz', activation_epoch: 'numeric', drain_receipt_sha256: 'varchar',
}
const ledgerHeadDDL = NEWS_MUTATION_LEDGER_STATEMENTS[0].sql

function independentDollarBody(ddl: string, functionName: string): string {
  const declaration = `CREATE OR REPLACE FUNCTION public.${functionName}(`
  const start = ddl.indexOf(declaration)
  assert.notEqual(start, -1, `fixture must contain ${functionName}`)
  assert.equal(ddl.indexOf(declaration, start + declaration.length), -1, `fixture must contain one ${functionName}`)
  const as = ddl.indexOf('AS', start + declaration.length)
  assert.notEqual(as, -1)
  const openerStart = ddl.indexOf('$', as + 2)
  assert.notEqual(openerStart, -1)
  const openerEnd = ddl.indexOf('$', openerStart + 1)
  assert.notEqual(openerEnd, -1)
  const delimiter = ddl.slice(openerStart, openerEnd + 1)
  assert.match(delimiter, /^\$(?:[\p{L}_][\p{L}\p{M}\p{N}_]*)?\$/u)
  const bodyStart = openerEnd + 1
  const close = ddl.indexOf(delimiter, bodyStart)
  assert.notEqual(close, -1)
  return ddl.slice(bodyStart, close)
}

function renderPg16TriggerDefinitionFromSource(definition: string, functionUnqualified = false): string {
  const match = /^CREATE TRIGGER ([a-z_][a-z0-9_]*) (BEFORE|AFTER|INSTEAD OF) ((?:INSERT|DELETE|UPDATE|TRUNCATE)(?: OR (?:INSERT|DELETE|UPDATE|TRUNCATE))*) ON public\.([a-z_][a-z0-9_]*) FOR EACH (ROW|STATEMENT) EXECUTE FUNCTION public\.([a-z_][a-z0-9_]*)\(\)$/u.exec(definition)
  if (!match) return definition
  const [, name, timing, eventText, relation, level, functionName] = match
  const events = eventText.split(' OR ')
  if (new Set(events).size !== events.length) return definition
  return `CREATE TRIGGER ${name} ${timing} ${['INSERT', 'DELETE', 'UPDATE', 'TRUNCATE'].filter(event => events.includes(event)).join(' OR ')} ON public.${relation}`
    + ` FOR EACH ${level} EXECUTE FUNCTION ${functionUnqualified ? '' : 'public.'}${functionName}()`
}

function fakeClient(options: {
  readOnly?: boolean; missingMigration?: boolean; badControlType?: boolean; partial?: boolean; existing?: boolean
  catalogFunctionNames?: string[]
  protocolVersion?: 1 | 2; protocolInventoryDrift?: 'extra-function' | 'missing-bootstrap-signature' | 'bootstrap-overload'
  wrongBootstrapOwner?: boolean; wrongBootstrapSearchPath?: boolean; observerBootstrapExecute?: boolean
  bootstrapStrictness?: 'strict' | 'missing' | 'null'
  unqualifiedTriggerFunctions?: boolean; unqualifiedTriggerRelation?: boolean; quotedTriggerIdentifiers?: boolean
  headRows?: 'empty' | 'multiple' | 'invalid'
  tamperFunctionSource?: { name: string; mutation: 'leading-space' | 'trailing-space' | 'interior-space' | 'string-literal' }
  badNativeNullability?: boolean; badNativeDefault?: boolean; extraColumnGrant?: boolean
  extraBootstrapColumnGrant?: boolean; missingConstraint?: boolean; missingIndex?: boolean; missingForeignKey?: boolean
  foreignKeyColumnDrift?: 'order' | 'missing' | 'extra'
  invalidTrigger?: 'insert-only' | 'wrong-timing' | 'row-level' | 'when' | 'binding' | 'disabled' | 'wrong-function'
    | 'wrong-function-schema' | 'wrong-function-identity' | 'wrong-event-mask' | 'wrong-column-inventory'
    | 'wrong-catalog-type' | 'wrong-arguments' | 'duplicate' | 'missing' | 'extra' | 'definition-update-of'
    | 'definition-duplicate-event' | 'definition-when-literal' | 'definition-case' | 'definition-relation-unqualified'
    | 'definition-relation-wrong-schema' | 'unqualified-wrong-function-identity' | 'unqualified-wrong-function-schema'
    | 'unqualified-wrong-function-name'
  extraControllerGrant?: boolean; controllerWrongOverload?: boolean; publicDefaultFunction?: boolean
  wrongBootstrapAcl?: 'controller' | 'runtime' | 'public'
  nativePgcryptoBaseline?: boolean; pgcryptoSecurityDefiner?: boolean; pgcryptoNonUuidReturn?: boolean
  extraControllerOwnership?: boolean; extraControlWrongNamespaceOwnership?: boolean; unrelatedDatabaseOwnership?: boolean
  sharedControlOwnership?: boolean; sharedControllerOwnership?: boolean; wrongProtocolSignature?: boolean
  wrongBootstrapReturnShape?: boolean; wrongBootstrapArgumentNames?: boolean; failBootstrapSqlState?: string
  serialDrift?: 'unowned' | 'wrong-column' | 'increment' | 'cycle' | 'range' | 'owner' | 'schema' | 'name-collision'
  foreignEnumSchema?: boolean; changedEnumLabels?: boolean; enumLabelDrift?: 'order' | 'missing' | 'extra'
  invalidEnumArray?: boolean; jsonbDefaultsMatch?: boolean; failMigrationSqlState?: string; failTriggerSqlState?: string
  failLedgerOperation?: NewsMutationLedgerOperation
} = {}) {
  const statements: string[] = []
  const jsonbComparisonParams: unknown[][] = []
  const catalogFunctionRows = (options.catalogFunctionNames ?? []).map(proname => ({ proname }))
  let activeRole = 'cms_admin'
  let protocolVersion = options.protocolVersion ?? (options.existing ? 2 : 0)
  let protocolLedgerExists = protocolVersion > 0
  const catalogDefault = (tableName: string, column: { type: string; name: string; default?: unknown }) => {
    const table = tableName.replace(/^public\./u, '')
    if (column.type === 'serial') return `nextval('${table}_${column.name}_seq'::regclass)`
    if (column.default == null) return null
    const value = String(column.default)
    if (value === 'gen_random_uuid()' || value === 'now()' || value === 'false' || value === 'true' || value.endsWith('::jsonb')) return value
    if (/^(?:0|[1-9][0-9]*)$/u.test(value)) return column.type === 'numeric' ? `${value}::numeric` : value
    if (/^'(?:''|[^'])*'$/u.test(value)) return `${value}::${column.type.startsWith('enum_') ? column.type : column.type === 'varchar' ? 'character varying' : column.type}`
    return value
  }
  const triggerRows = [...canonicalTriggerDefinitions].map(([key, definition]) => {
    const [relation, name] = key.split('.')
    let actualDefinition = definition
    if (options.invalidTrigger === 'insert-only' && relation === 'news_articles' && name === 'owner_news_mutation_guard_stmt') {
      actualDefinition = actualDefinition.replace('BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE', 'BEFORE INSERT')
    } else if (options.invalidTrigger === 'wrong-timing' && relation === 'news_articles' && name === 'owner_news_mutation_guard_stmt') {
      actualDefinition = actualDefinition.replace('BEFORE INSERT', 'AFTER INSERT')
    } else if (options.invalidTrigger === 'row-level' && relation === 'news_articles' && name === 'owner_news_mutation_guard_stmt') {
      actualDefinition = actualDefinition.replace('FOR EACH STATEMENT', 'FOR EACH ROW')
    } else if (options.invalidTrigger === 'when' && relation === 'news_articles' && name === 'owner_news_mutation_guard_stmt') {
      actualDefinition = `${actualDefinition} WHEN (true)`
    } else if (options.invalidTrigger === 'binding' && relation === 'news_migration_items' && name === 'owner_news_migration_item_binding_guard') {
      actualDefinition = actualDefinition.replace('BEFORE INSERT OR UPDATE', 'BEFORE INSERT')
    } else if (options.invalidTrigger === 'definition-update-of' && relation === 'news_articles' && name === 'owner_news_mutation_guard_stmt') {
      actualDefinition = actualDefinition.replace('UPDATE', 'UPDATE OF id')
    } else if (options.invalidTrigger === 'definition-duplicate-event' && relation === 'news_articles' && name === 'owner_news_mutation_guard_stmt') {
      actualDefinition = actualDefinition.replace('BEFORE INSERT OR UPDATE', 'BEFORE INSERT OR INSERT OR UPDATE')
    } else if (options.invalidTrigger === 'definition-when-literal' && relation === 'news_articles' && name === 'owner_news_mutation_guard_stmt') {
      actualDefinition = `${actualDefinition} WHEN (NEW.title = 'INSERT OR DELETE')`
    } else if (options.invalidTrigger === 'definition-case' && relation === 'news_articles' && name === 'owner_news_mutation_guard_stmt') {
      actualDefinition = actualDefinition.replace('BEFORE', 'before')
    } else if (options.invalidTrigger === 'unqualified-wrong-function-name' && relation === 'news_articles' && name === 'owner_news_mutation_guard_stmt') {
      actualDefinition = actualDefinition.replace('owner_news_mutation_guard_stmt()', 'owner_news_wrong_fixture()')
    } else if (options.invalidTrigger === 'definition-relation-unqualified' && relation === 'news_articles' && name === 'owner_news_mutation_guard_stmt') {
      actualDefinition = actualDefinition.replace('ON public.news_articles', 'ON news_articles')
    } else if (options.invalidTrigger === 'definition-relation-wrong-schema' && relation === 'news_articles' && name === 'owner_news_mutation_guard_stmt') {
      actualDefinition = actualDefinition.replace('ON public.news_articles', 'ON private.news_articles')
    }
    const parsed = actualDefinition.match(/^CREATE TRIGGER [a-z_][a-z0-9_]* (BEFORE|AFTER|INSTEAD OF) ([A-Z]+(?: OR [A-Z]+)*) ON public\.[a-z_][a-z0-9_]* FOR EACH (ROW|STATEMENT)/u)
    const functionName = actualDefinition.match(/EXECUTE FUNCTION public\.([a-z_][a-z0-9_]*)\(\)/u)?.[1]
    const [, timing, events, level] = parsed ?? []
    const bits: Record<string, number> = { INSERT: 4, DELETE: 8, UPDATE: 16, TRUNCATE: 32 }
    const selected = relation === 'news_articles' && name === 'owner_news_mutation_guard_stmt'
    const maskSource = selected && ['definition-update-of', 'definition-duplicate-event', 'definition-when-literal',
      'definition-case', 'definition-relation-unqualified', 'definition-relation-wrong-schema'].includes(options.invalidTrigger || '')
      ? definition : actualDefinition
    const maskMatch = maskSource.match(/^CREATE TRIGGER [a-z_][a-z0-9_]* (BEFORE|AFTER|INSTEAD OF) ([A-Z]+(?: OR [A-Z]+)*) ON public\.[a-z_][a-z0-9_]* FOR EACH (ROW|STATEMENT)/u)
    const [, maskTiming, maskEvents, maskLevel] = maskMatch ?? []
    const eventMask = (maskLevel === 'ROW' ? 1 : 0) | (maskTiming === 'BEFORE' ? 2 : maskTiming === 'INSTEAD OF' ? 64 : 0)
      | (maskEvents || '').split(' OR ').reduce((mask, event) => mask | (bits[event] || 0), 0)
    const row = { name, relation, relation_schema: 'public', enabled: selected && options.invalidTrigger === 'disabled' ? 'O' : 'A',
      function: selected && options.invalidTrigger === 'wrong-function' ? 'owner_news_mutation_capture_row' : functionName,
      function_schema: selected && ['wrong-function-schema', 'unqualified-wrong-function-schema'].includes(options.invalidTrigger || '') ? 'private' : 'public',
      function_identity_approved: !(selected && ['wrong-function-identity', 'unqualified-wrong-function-identity'].includes(options.invalidTrigger || '')),
      event_mask: selected && options.invalidTrigger === 'wrong-event-mask' ? eventMask ^ 1 : eventMask,
      attribute_count: selected && options.invalidTrigger === 'wrong-column-inventory' ? 1 : 0,
      attribute_vector_text: '', attribute_vector_type: selected && options.invalidTrigger === 'wrong-catalog-type' ? 'text' : 'int2vector',
      argument_count: selected && options.invalidTrigger === 'wrong-arguments' ? 1 : 0,
      argument_bytes: selected && options.invalidTrigger === 'wrong-arguments' ? 1 : 0,
      no_condition: !(selected && (options.invalidTrigger === 'when' || options.invalidTrigger === 'definition-when-literal')),
      definition: (() => {
        let rendered = renderPg16TriggerDefinitionFromSource(actualDefinition, options.unqualifiedTriggerFunctions === true)
        if (options.quotedTriggerIdentifiers) {
          rendered = rendered.replace(/^CREATE TRIGGER ([a-z_][a-z0-9_]*) /u, 'CREATE TRIGGER "$1" ')
            .replace(/ ON public\.([a-z_][a-z0-9_]*) /u, ' ON "public"."$1" ')
            .replace(/EXECUTE FUNCTION public\.([a-z_][a-z0-9_]*)\(\)$/u, 'EXECUTE FUNCTION "public"."$1"()')
        }
        if (selected && (options.unqualifiedTriggerRelation || options.invalidTrigger === 'definition-relation-unqualified')) {
          rendered = rendered.replace('ON public.news_articles', 'ON news_articles')
        }
        if (selected && options.invalidTrigger === 'definition-relation-wrong-schema') {
          rendered = rendered.replace('ON public.news_articles', 'ON private.news_articles')
        }
        return rendered
      })() }
    if (selected && options.invalidTrigger === 'duplicate') return [row, { ...row }]
    return [row]
  }).flat()
  if (options.invalidTrigger === 'missing') triggerRows.splice(triggerRows.findIndex(row => row.relation === 'news_articles' && row.name === 'owner_news_mutation_guard_stmt'), 1)
  if (options.invalidTrigger === 'extra') triggerRows.push({ ...triggerRows[0]!, name: 'unexpected_fixture_trigger' })
  const triggerDDL = buildNewsMutationTriggersDDL()
  const bodies = [
    ['owner_news_mutation_guard_stmt', independentDollarBody(triggerDDL, 'owner_news_mutation_guard_stmt')],
    ['owner_news_mutation_capture_row', independentDollarBody(triggerDDL, 'owner_news_mutation_capture_row')],
    ['owner_news_seal_run', independentDollarBody(triggerDDL, 'owner_news_seal_run')],
    ['owner_news_migration_item_binding_guard', independentDollarBody(NEWS_MIGRATION_ITEM_BINDING_DDL, 'owner_news_migration_item_binding_guard')],
    ['owner_news_bootstrap_run', independentDollarBody(buildNewsMigrationBootstrapRunDDL(), 'owner_news_bootstrap_run')],
  ]
  if (options.tamperFunctionSource) {
    const target = bodies.find(([name]) => name === options.tamperFunctionSource!.name)
    assert.ok(target)
    const body = String(target[1])
    const mutation = options.tamperFunctionSource.mutation
    target[1] = mutation === 'leading-space' ? ` ${body}`
      : mutation === 'trailing-space' ? `${body} `
        : mutation === 'interior-space' ? body.replace('\n  ', '\n   ')
          : body.includes("'owner_news_mutation_ledger_unavailable'")
            ? body.replace("'owner_news_mutation_ledger_unavailable'", "'owner_news_mutation_ledger_unavailablE'")
            : body.replace("'owner_news_bootstrap_identity_conflict'", "'owner_news_bootstrap_identity_conflicT'")
  }
  const client: FinalizerClient = {
    connect: async () => {}, end: async () => {},
    query: async (sql, values): Promise<QueryResult> => {
      statements.push(sql)
      if (sql === 'SELECT $1::jsonb = $2::jsonb AS matches') {
        jsonbComparisonParams.push(values || [])
        return { rows: [{ matches: options.jsonbDefaultsMatch !== false }] }
      }
      const ledgerStatement = NEWS_MUTATION_LEDGER_STATEMENTS.find(statement => statement.sql === sql)
      if (ledgerStatement) {
        if (options.failLedgerOperation === ledgerStatement.operation) {
          throw Object.assign(new Error('private SQL, path and credential must not appear'), { code: '42501' })
        }
        if (ledgerStatement.operation === 'ledger-events-create') protocolLedgerExists = true
        return { rows: [] }
      }
      if (sql === buildNewsMigrationBootstrapRunDDL()) {
        if (options.failBootstrapSqlState) {
          const error = new Error('sensitive bootstrap DDL message must not appear in diagnostic') as Error & { code: string }
          error.code = options.failBootstrapSqlState
          throw error
        }
        protocolVersion = 2
        return { rows: [] }
      }
      if (sql === buildNewsMutationTriggersDDL() && options.failTriggerSqlState) {
        const error = new Error('sensitive DDL message must not appear in diagnostic') as Error & { code: string }
        error.code = options.failTriggerSqlState
        throw error
      }
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) return { rows: [] }
      if (sql === 'SET LOCAL ROLE cms_runtime') { activeRole = 'cms_runtime'; return { rows: [] } }
      if (sql === 'RESET ROLE') { activeRole = 'cms_admin'; return { rows: [] } }
      if (sql.includes('current_user AS role')) return { rows: [{ role: activeRole, db: 'ownerinc_cms', superuser: activeRole === 'cms_admin', read_only: options.readOnly ? 'on' : 'off' }] }
      if (sql.includes('FROM public.payload_migrations')) {
        if (options.failMigrationSqlState) {
          const error = new Error('database message must not appear in diagnostic') as Error & { code: string }
          error.code = options.failMigrationSqlState
          throw error
        }
        return { rows: (options.missingMigration ? migrations.slice(0, 5) : migrations).map(name => ({ name })) }
      }
      if (sql.includes('SELECT c.relname AS name, c.relkind AS kind')) return { rows: Object.keys(nativeSchemaSnapshot.tables).map(name => ({ name: name.replace(/^public\./u, ''), kind: 'r' })) }
      if (sql.includes('SELECT c.relname AS table_name, a.attname AS column_name, t.typname AS type')) return { rows: Object.entries(nativeSchemaSnapshot.tables).flatMap(([table, schema]) => Object.values(schema.columns).map((column, index) => ({
        table_name: table.replace(/^public\./u, ''), column_name: column.name, not_null: options.badNativeNullability && table === 'public.news_articles' && index === 0 ? !column.notNull : column.notNull,
        default_expr: options.badNativeDefault && table === 'public.news_articles' && column.default !== undefined ? "'wrong'" : catalogDefault(table, column),
        type_schema: column.type.startsWith('enum_') && options.foreignEnumSchema ? 'fixture' : column.type.startsWith('enum_') ? 'public' : 'pg_catalog',
        type: ({ varchar: 'varchar', integer: 'int4', serial: 'int4', boolean: 'bool', 'timestamp(3) with time zone': 'timestamptz' } as Record<string, string>)[column.type] ?? column.type,
      }))) }
      if (sql.includes('SELECT t.typname AS name, n.nspname AS schema')) return { rows: Object.values(nativeSchemaSnapshot.enums).map((value, index) => {
        let labels = [...value.values]
        if (index === 0 && (options.changedEnumLabels || options.enumLabelDrift === 'order')) labels.reverse()
        else if (index === 0 && options.enumLabelDrift === 'missing') labels = labels.slice(1)
        else if (index === 0 && options.enumLabelDrift === 'extra') labels.push('fixture_extra_label')
        return { name: value.name, schema: options.foreignEnumSchema && index === 0 ? 'fixture' : value.schema,
          labels, array_binding_valid: !options.invalidEnumArray }
      }) }
      if (sql.includes('SELECT conname AS name FROM pg_constraint')) return { rows: (options.missingConstraint
        ? ['news_migration_runs_manifest_sha256_check'] : ['news_migration_runs_manifest_sha256_check', 'news_migration_runs_source_fingerprint_check',
          'news_migration_runs_source_instance_check', 'news_migration_runs_epoch_integer_check', 'news_migration_runs_reconciliation_sequence_check',
          'news_migration_runs_sealed_sequence_check', 'news_migration_runs_reconciliation_pair_check', 'news_migration_runs_reconciliation_hashes_check',
          'news_migration_runs_exceptions_array_check', 'news_migration_runs_seal_pair_check', 'news_migration_runs_seal_hashes_check',
          'news_migration_seal_complete', 'news_migration_items_run_uuid_check', 'news_migration_items_manifest_sha256_check',
          'news_migration_items_expected_hash_check', 'news_migration_items_observed_hash_check', 'news_migration_items_source_identity_check',
          'news_migration_items_destination_id_check', 'news_migration_items_verified_consistency_check', 'news_schedules_actor_uid_check',
          'news_schedules_import_epoch_check', 'news_schedules_snapshot_hash_check', 'news_schedules_import_provenance_shape_check',
          'legacy_news_revisions_metadata_basis_check']).map(name => ({ name })) }
      if (sql.includes('SELECT t.relname AS table_name, i.relname AS index_name')) return { rows: Object.values(nativeSchemaSnapshot.tables).flatMap(table => Object.values(table.indexes).map((index, position) => ({
        table_name: table.name, index_name: options.missingIndex && position === 0 ? 'missing_fixture_index' : index.name,
        is_unique: Boolean(index.isUnique), method: index.method,
      }))) }
      if (sql.includes('SELECT con.conname AS name')) return { rows: Object.values(nativeSchemaSnapshot.tables).flatMap(table => Object.values(table.foreignKeys).map((key, index) => {
        const columnsFrom = [...key.columnsFrom]
        if (options.foreignKeyColumnDrift === 'order' && columnsFrom.length > 1) columnsFrom.reverse()
        if (options.foreignKeyColumnDrift === 'missing' && index === 0 && columnsFrom.length) columnsFrom.pop()
        if (options.foreignKeyColumnDrift === 'extra' && index === 0) columnsFrom.push('fixture_extra_column')
        return { name: options.missingForeignKey && index === 0 && table.name === 'news_articles_blocks_rich_text' ? 'missing_fixture_fk' : key.name,
          table_from: key.tableFrom, table_to: key.tableTo, columns_from: columnsFrom, columns_to: key.columnsTo,
          delete_code: ({ 'no action': 'a', restrict: 'r', cascade: 'c', 'set null': 'n', 'set default': 'd' } as Record<string, string>)[key.onDelete],
          update_code: ({ 'no action': 'a', restrict: 'r', cascade: 'c', 'set null': 'n', 'set default': 'd' } as Record<string, string>)[key.onUpdate] }
      })) }
      if (sql.includes("a.attrelid='public.news_migration_runs'")) return { rows: Object.entries(controlColumns).map(([name, type]) => ({ name, type: options.badControlType && name === 'sealed_sequence' ? 'int8' : type })) }
      if (sql.includes("a.attrelid='public.news_migration_items'")) return { rows: [{ run_id_type: 'varchar' }] }
      if (sql.includes('FROM unnest($1::text[],$2::text[],$3::text[]) AS expected')) {
        const rows = Object.entries(nativeSchemaSnapshot.tables).flatMap(([tableName, table]) => Object.values(table.columns)
          .filter(column => column.type === 'serial').map(column => {
            const table = tableName.replace(/^public\./u, '')
            const sequence = `${table}_${column.name}_seq`
            const drift = options.serialDrift
            return { table_name: table, column_name: column.name, sequence_name: sequence,
              sequence_present: drift !== 'name-collision', sequence_schema: drift === 'schema' ? 'fixture' : 'public',
              sequence_kind: 'S', sequence_persistence: 'p', sequence_owner: drift === 'owner' ? 'cms_admin' : 'cms_migrator',
              integer_sequence: true, start_value: '1', increment_value: drift === 'increment' ? '2' : '1',
              minimum_value: drift === 'range' ? '0' : '1', maximum_value: '2147483647', cache_value: '1',
              cycles: drift === 'cycle', ownership_dependency: drift === 'unowned' ? null : 'a',
              owned_table_schema: 'public', owned_table: table,
              owned_column: drift === 'wrong-column' ? 'other_column' : column.name, table_owner: 'cms_migrator',
            }
          }))
        if (options.serialDrift === 'name-collision' && rows.length) rows.push({ ...rows[0]!, sequence_schema: 'fixture' })
        return { rows }
      }
      if (sql === controlRolesVerificationSQL || sql === controlRolesOwnershipVerificationSQL || sql === controlRolesNativePrivilegesVerificationSQL
        ) return { rows: [{ safe: true }] }
      if (sql === runtimeProtocolFunctionsVerifySQL || sql === runtimeProtocolPrivilegesVerifySQL) return { rows: [{ safe: true }] }
      if (sql.includes('AS runtime_seal')) return { rows: [{ head_read: true, head_write: false, events_read: true,
        events_write: false, controller_seal: true, runtime_seal: false, controller_bootstrap: protocolVersion === 2,
        runtime_bootstrap: false, public_bootstrap: false, observer_bootstrap: options.observerBootstrapExecute === true }] }
      if (sql.includes('AS function_safe')) return { rows: [{ safe: true, function_safe: true }] }
      if (sql.includes('AS safe')) return { rows: [{ safe: true }] }
      if (sql.includes('AS ledger_relations') && options.catalogFunctionNames !== undefined) {
        // Materialize pg_proc name rows into the same aggregate consumed by
        // checkPreconditions, then exercise that production classifier below.
        const approvedNames = new Set((Array.isArray(values?.[1]) ? values[1] : []) as string[])
        const approvedFixtureFunctions = catalogFunctionRows.filter(row => approvedNames.has(row.proname)).length
        const unexpectedFixtureFunctions = catalogFunctionRows.filter(row => row.proname.startsWith('owner_news_')
          && !approvedNames.has(row.proname)).length
        const ledgerRelations = options.partial ? 1 : protocolVersion > 0 ? 2 : 0
        return { rows: [protocolVersion > 0 && !options.partial ? {
          ledger_relations: ledgerRelations,
          protocol_functions: (protocolVersion === 2 ? 5 : 4) + approvedFixtureFunctions
            + (options.protocolInventoryDrift === 'extra-function' ? 1 : 0)
            + (options.protocolInventoryDrift === 'bootstrap-overload' ? 1 : 0),
          unexpected_protocol_functions: unexpectedFixtureFunctions
            + (options.protocolInventoryDrift === 'extra-function' ? 1 : 0),
          v1_signatures: options.protocolInventoryDrift === 'missing-bootstrap-signature' ? 3 : 4,
          bootstrap_signature: protocolVersion === 2 && options.protocolInventoryDrift !== 'missing-bootstrap-signature',
          protocol_triggers: NEWS_MUTATION_TABLES.length * 2 + 2,
          inventory_triggers: NEWS_MUTATION_TABLES.length * 2 + 2,
        } : {
          ledger_relations: ledgerRelations,
          protocol_functions: approvedFixtureFunctions,
          unexpected_protocol_functions: unexpectedFixtureFunctions,
          v1_signatures: 0,
          bootstrap_signature: false,
          protocol_triggers: 0,
          inventory_triggers: 0,
        }] }
      }
      if (sql.includes('AS ledger_relations')) return { rows: [options.partial
        ? { ledger_relations: 1, protocol_functions: 0, unexpected_protocol_functions: 0, v1_signatures: 0, bootstrap_signature: false, protocol_triggers: 0, inventory_triggers: 0 }
        : protocolVersion > 0 ? {
          ledger_relations: 2,
          protocol_functions: (protocolVersion === 2 ? 5 : 4)
            + (options.protocolInventoryDrift === 'extra-function' ? 1 : 0)
            + (options.protocolInventoryDrift === 'bootstrap-overload' ? 1 : 0),
          unexpected_protocol_functions: options.protocolInventoryDrift === 'extra-function' ? 1 : 0,
          v1_signatures: options.protocolInventoryDrift === 'missing-bootstrap-signature' ? 3 : 4,
          bootstrap_signature: protocolVersion === 2 && options.protocolInventoryDrift !== 'missing-bootstrap-signature',
          protocol_triggers: NEWS_MUTATION_TABLES.length * 2 + 2, inventory_triggers: NEWS_MUTATION_TABLES.length * 2 + 2,
        } : { ledger_relations: 0, protocol_functions: 0, unexpected_protocol_functions: 0, v1_signatures: 0, bootstrap_signature: false,
          protocol_triggers: 0, inventory_triggers: 0 }] }
      if (sql.includes('FROM public.owner_news_mutation_head')) {
        if (!protocolLedgerExists) {
          const error = new Error('relation does not exist') as Error & { code: string }
          error.code = '42P01'
          throw error
        }
        const validHead = { sequence: options.existing ? '17' : '0', chain_sha256: options.existing ? 'a'.repeat(64) : '0'.repeat(64), coverage_version: 0, write_barrier: 'open' }
        if (options.headRows === 'empty') return { rows: [] }
        if (options.headRows === 'multiple') return { rows: [validHead, validHead] }
        if (options.headRows === 'invalid') return { rows: [{ ...validHead, coverage_version: 1 }] }
        return { rows: [validHead] }
      }
      if (sql.includes('FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles')) {
        const activeBodies = bodies.filter(([name]) => name !== 'owner_news_bootstrap_run' || protocolVersion === 2)
        const rows = activeBodies.map(([name, body]) => ({ name, source: body,
          security_definer: name !== 'owner_news_mutation_guard_stmt',
          config: name === 'owner_news_bootstrap_run' && options.wrongBootstrapSearchPath
            ? ['search_path=public'] : ['search_path=pg_catalog, public'],
          owner: name === 'owner_news_bootstrap_run' && options.wrongBootstrapOwner ? 'cms_migrator' : 'cms_control',
          canonical_signature: !(options.wrongProtocolSignature && name === 'owner_news_seal_run'),
          bootstrap_return_shape: name === 'owner_news_bootstrap_run' && options.wrongBootstrapReturnShape !== true,
          ...(name === 'owner_news_bootstrap_run' && options.bootstrapStrictness === 'missing' ? {} : {
            bootstrap_is_strict: name === 'owner_news_bootstrap_run'
              ? options.bootstrapStrictness === 'null' ? null : options.bootstrapStrictness === 'strict'
              : false,
          }),
          bootstrap_argument_modes: name === 'owner_news_bootstrap_run' ? ['i', 'i', 'i', 'i', 'i', 't'] : null,
          bootstrap_argument_names: name === 'owner_news_bootstrap_run' && options.wrongBootstrapArgumentNames !== true
            ? ['p_run_id', 'p_manifest_sha256', 'p_source_instance', 'p_source_fingerprint', 'p_authority_epoch', 'id'] : null }))
        if (options.protocolInventoryDrift === 'bootstrap-overload') {
          rows.push({ ...rows.find(row => row.name === 'owner_news_bootstrap_run')!, source: 'overload-body' })
        }
        return { rows }
      }
      if (sql.includes('FROM pg_trigger t JOIN pg_class')) return { rows: triggerRows }
      if (sql.includes('SELECT c.relname AS relation') && sql.includes("has_table_privilege('cms_control'")) {
        type RelationColumns = readonly [relation: string, columns: readonly string[]]
        const relations: readonly RelationColumns[] = [...Object.entries(nativeSchemaSnapshot.tables).map(([name, table]): RelationColumns => [name.replace(/^public\./u, ''), Object.values(table.columns).map(column => column.name)]),
          ['owner_news_mutation_head', ['singleton', 'sequence', 'chain_sha256', 'coverage_version', 'write_barrier', 'barrier_run_id', 'barrier_epoch', 'barrier_receipt_sha256']],
          ['owner_news_mutation_events', ['sequence', 'event_id', 'table_name', 'operation', 'row_key', 'transaction_id', 'before_sha256', 'after_sha256', 'previous_sha256', 'event_sha256', 'created_at']]]
        const rows = relations.flatMap(([relation, columns]) => columns.map(column => {
          const controlSelect = ['news_migration_runs', 'news_migration_items', 'owner_news_mutation_head'].includes(relation)
          const controlInsert = relation === 'owner_news_mutation_events'
          const controlUpdate = relation === 'owner_news_mutation_head'
          const controlColumnInsert = controlInsert || relation === 'news_migration_runs'
            && protocolVersion === 2 && NEWS_MIGRATION_RUN_BOOTSTRAP_INSERT_COLUMNS.some(name => name === column)
            || options.extraBootstrapColumnGrant === true && relation === 'news_migration_runs' && column === 'created_at'
          const controlColumnUpdate = controlUpdate
            || relation === 'news_migration_runs' && ['admission_state', 'activation_epoch', 'drain_receipt_sha256', 'reconciliation_sequence', 'reconciliation_chain_sha256', 'sealed_sequence', 'sealed_chain_sha256', 'sealed_at'].includes(column)
          return { relation, kind: 'r', column_name: column,
            control_select: controlSelect, control_insert: controlInsert, control_update: controlUpdate,
            control_delete: false, control_truncate: false, control_references: false, control_trigger: false,
            control_column_select: controlSelect, control_column_insert: controlColumnInsert, control_column_update: controlColumnUpdate,
            control_column_references: false, controller_select: false, controller_insert: false, controller_update: false,
            controller_delete: false, controller_truncate: false, controller_references: false, controller_trigger: false,
            controller_column_select: false, controller_column_insert: false, controller_column_update: false,
            controller_column_references: false,
          }
        }))
        if (options.extraColumnGrant) rows.push({ ...rows[0]!, relation: 'news_articles', column_name: 'id', control_column_update: true })
        return { rows }
      }
      if (sql.includes('AS pgcrypto_extension_member')) {
        const rows = [
          { approved_function: true, approved_seal: false, approved_bootstrap: false, expected_pgcrypto_signature: false, pgcrypto_extension_member: false, security_definer: true, returns_uuid: false, public_execute: false, control_execute: true, controller_execute: false, runtime_execute: false },
          { approved_function: true, approved_seal: false, approved_bootstrap: false, expected_pgcrypto_signature: false, pgcrypto_extension_member: false, security_definer: true, returns_uuid: false, public_execute: false, control_execute: true, controller_execute: false, runtime_execute: false },
          { approved_function: true, approved_seal: true, approved_bootstrap: false, expected_pgcrypto_signature: false, pgcrypto_extension_member: false, security_definer: true, returns_uuid: false, public_execute: false, control_execute: true, controller_execute: true, runtime_execute: false },
          { approved_function: true, approved_seal: false, approved_bootstrap: false, expected_pgcrypto_signature: false, pgcrypto_extension_member: false, security_definer: true, returns_uuid: false, public_execute: false, control_execute: true, controller_execute: false, runtime_execute: false },
        ]
        if (protocolVersion === 2) rows.push({ approved_function: true, approved_seal: false, approved_bootstrap: true,
          expected_pgcrypto_signature: false, pgcrypto_extension_member: false, security_definer: true, returns_uuid: false,
          public_execute: options.wrongBootstrapAcl === 'public', control_execute: true,
          controller_execute: options.wrongBootstrapAcl !== 'controller', runtime_execute: options.wrongBootstrapAcl === 'runtime' })
        if (options.nativePgcryptoBaseline) rows.push({ approved_function: false, approved_seal: false, approved_bootstrap: false,
          expected_pgcrypto_signature: true, pgcrypto_extension_member: true, security_definer: options.pgcryptoSecurityDefiner ?? false,
          returns_uuid: !(options.pgcryptoNonUuidReturn ?? false), public_execute: true, control_execute: true,
          controller_execute: true, runtime_execute: true })
        if (options.publicDefaultFunction) rows.push({ approved_function: false, approved_seal: false, approved_bootstrap: false,
          expected_pgcrypto_signature: false, pgcrypto_extension_member: false, security_definer: false, returns_uuid: true,
          public_execute: true, control_execute: true, controller_execute: true, runtime_execute: true })
        if (options.extraControllerGrant) rows.push({ approved_function: false, approved_seal: false, approved_bootstrap: false,
          expected_pgcrypto_signature: false, pgcrypto_extension_member: false, security_definer: false, returns_uuid: false,
          public_execute: false, control_execute: false, controller_execute: true, runtime_execute: false })
        if (options.controllerWrongOverload) rows.push({ approved_function: false, approved_seal: false, approved_bootstrap: false,
          expected_pgcrypto_signature: false, pgcrypto_extension_member: false, security_definer: false, returns_uuid: false,
          public_execute: false, control_execute: false, controller_execute: true, runtime_execute: false })
        return { rows }
      }
      if (sql.includes("c.relkind='S'")) return { rows: [] }
      if (sql.includes('AS unexpected_control_objects')) return { rows: [{ head_read: true, head_write: false, events_read: true, events_write: false, controller_seal: true, runtime_seal: false,
        unexpected_control_objects: options.extraControlWrongNamespaceOwnership || options.extraControllerOwnership ? 1 : 0,
        approved_control_objects: protocolVersion === 2 ? 5 : 4,
        controller_owned_objects: options.extraControllerOwnership ? 1 : 0,
        control_shared_owned_objects: options.sharedControlOwnership ? 1 : 0,
        controller_shared_owned_objects: options.sharedControllerOwnership ? 1 : 0,
        unrelated_database_owned_objects: options.unrelatedDatabaseOwnership ? 1 : 0 }] }
      return { rows: [] }
    },
  }
  return { client, statements, jsonbComparisonParams, catalogFunctionRows }
}

function configureReadOnlyAuditClient(
  client: FinalizerClient,
  statements: string[],
  options: { protocolVersion?: 1 | 2; auditTransactionSafe?: boolean; auditSearchPathSafe?: boolean; observerIdentitySafe?: boolean; observerShdependAccessible?: boolean; observerRoleSafe?: boolean; observerPrivilegesSafe?: boolean; observedCoverage?: 0 | 1; invalidCoverage?: boolean; pgcryptoBaselineAbsent?: boolean; observerUnexpectedFunctionExecute?: boolean; observerBootstrapExecute?: boolean; ownershipDependency?: { owner: 'cms_control' | 'cms_controller'; classid: string; dbid?: number; objid?: number } } = {},
) {
  const originalQuery = client.query.bind(client)
  client.query = async (sql, values) => {
    if (sql === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
      || sql === "SET LOCAL statement_timeout = '5s'" || sql === 'SET LOCAL search_path = pg_catalog, public'
      || sql === 'COMMIT' || sql === 'ROLLBACK') {
      statements.push(sql)
      return { rows: [] }
    }
    if (sql.includes('current_user AS role')) {
      statements.push(sql)
      const identitySafe = options.observerIdentitySafe !== false
      return { rows: [{ role: identitySafe ? 'cms_observer' : 'cms_admin',
        session_role: identitySafe ? 'cms_observer' : 'cms_admin', db: 'ownerinc_cms',
        superuser: !identitySafe, read_only: 'on' }] }
    }
    if (sql.startsWith("SELECT current_setting('transaction_read_only') AS read_only")) {
      statements.push(sql)
      return { rows: [{ read_only: options.auditTransactionSafe === false ? 'off' : 'on',
        isolation: 'repeatable read', search_path: options.auditSearchPathSafe === false ? 'attacker_schema, public' : 'pg_catalog, public',
        bounded_timeout: true }] }
    }
    if (sql === newsProtocolObserverOwnershipCatalogPrivilegeVerificationSQL) {
      statements.push(sql)
      return { rows: [{ safe: options.observerShdependAccessible !== false }] }
    }
    if (sql === newsProtocolObserverRoleVerificationSQL) {
      statements.push(sql)
      return { rows: [{ safe: options.observerRoleSafe !== false }] }
    }
    if (sql === newsProtocolObserverPrivilegesVerificationSQL) {
      statements.push(sql)
      return { rows: [{ safe: options.observerPrivilegesSafe !== false }] }
    }
    if (sql === controlRolesPublicVerificationSQL) {
      statements.push(sql)
      return { rows: [{ safe: true }] }
    }
    if (sql.includes('AS pgcrypto_extension_member')) {
      const result = await originalQuery(sql, values)
      return { rows: result.rows.map((row, index) => {
        const expectedSignature = options.pgcryptoBaselineAbsent ? null : row.expected_pgcrypto_signature
        return { ...row, expected_pgcrypto_signature: expectedSignature,
          observer_execute: options.observerBootstrapExecute === true && index === 4
            ? true : options.observerUnexpectedFunctionExecute === true && index === 0
            ? true : expectedSignature === true }
      }) }
    }
    if (sql.includes('AS unexpected_control_objects')) {
      statements.push(sql)
      const roleOids = { cms_control: 41002, cms_controller: 41003 }
      const approvedFunctionOids = new Set(options.protocolVersion === 1
        ? [42001, 42002, 42003, 42004] : [42001, 42002, 42003, 42004, 42005])
      const mockedDependencies = [
        ...[...approvedFunctionOids].map(objid => ({ classid: 'pg_proc', objid,
          refclassid: 'pg_authid', refobjid: roleOids.cms_control, deptype: 'o', dbid: 16384 })),
        ...(options.ownershipDependency ? [{
          classid: options.ownershipDependency.classid,
          objid: options.ownershipDependency.objid ?? 43001,
          refclassid: 'pg_authid',
          refobjid: roleOids[options.ownershipDependency.owner],
          deptype: 'o',
          dbid: options.ownershipDependency.dbid ?? 16384,
        }] : [])]
      const ownershipRows = mockedDependencies.filter(dependency => dependency.refclassid === 'pg_authid'
        && dependency.deptype === 'o')
      const currentControl = ownershipRows.filter(dependency => dependency.refobjid === roleOids.cms_control
        && dependency.dbid === 16384)
      const unexpectedControl = currentControl.filter(dependency => dependency.classid !== 'pg_proc'
        || !approvedFunctionOids.has(dependency.objid)).length
      const approvedControl = currentControl.filter(dependency => dependency.classid === 'pg_proc'
        && approvedFunctionOids.has(dependency.objid)).length
      const controllerOwned = ownershipRows.filter(dependency => dependency.refobjid === roleOids.cms_controller
        && dependency.dbid === 16384).length
      const controlSharedOwned = ownershipRows.filter(dependency => dependency.refobjid === roleOids.cms_control
        && dependency.dbid === 0).length
      const controllerSharedOwned = ownershipRows.filter(dependency => dependency.refobjid === roleOids.cms_controller
        && dependency.dbid === 0).length
      return { rows: [{ unexpected_control_objects: unexpectedControl, approved_control_objects: approvedControl,
        controller_owned_objects: controllerOwned,
        controller_shared_owned_objects: controllerSharedOwned, control_shared_owned_objects: controlSharedOwned }] }
    }
    if (sql.includes('FROM public.owner_news_mutation_head') && options.observedCoverage === 1) {
      statements.push(sql)
      return { rows: [{ sequence: '17', chain_sha256: 'a'.repeat(64), coverage_version: 1, write_barrier: 'frozen' }] }
    }
    if (sql.includes('FROM public.owner_news_mutation_head') && options.invalidCoverage) {
      statements.push(sql)
      return { rows: [{ sequence: '17', chain_sha256: 'a'.repeat(64), coverage_version: 2, write_barrier: 'open' }] }
    }
    return originalQuery(sql, values)
  }
}

test('JSONB default parser accepts only a quoted JSONB constant and unescapes SQL apostrophes', () => {
  assert.equal(parseJsonbDefaultLiteral(`('{"quote":"Owner''s"}'::jsonb)`), '{"quote":"Owner\'s"}')
  assert.equal(parseJsonbDefaultLiteral("'null'::pg_catalog.jsonb"), 'null')
  for (const expression of [
    `('{"x":1}'::text)::jsonb`, "'{}'::text", "'{}'::json", 'jsonb_build_object(\'x\', 1)',
    "'{}'::jsonb || '{}'::jsonb", '((\'{}\'::jsonb) + interval \'1 day\')',
  ]) assert.equal(parseJsonbDefaultLiteral(expression), null, expression)
})

test('JSONB literal equality binds exact JSON text for PostgreSQL semantics and preserves large integers', async () => {
  const exactJson = '{"nested":{"b":1,"a":"apostrophe: Owner\\u0027s"},"n":9007199254740993123456789}'
  const { client, jsonbComparisonParams } = fakeClient()
  assert.equal(await jsonbDefaultLiteralsMatch(client,
    `'{"nested":{"a":"apostrophe: Owner''s","b":1.0},"n":9007199254740993123456789.0}'::jsonb`,
    `'${exactJson.replaceAll("'", "''")}'::jsonb`, 'jsonb'), true)
  assert.deepEqual(jsonbComparisonParams, [[
    `{"nested":{"a":"apostrophe: Owner's","b":1.0},"n":9007199254740993123456789.0}`,
    exactJson,
  ]])

  for (const [left, right, matches] of [
    ['{"a":1,"b":2}', '{"b":2,"a":1}', true],
    ['{"a":{"x":1,"y":2}}', '{"a":{"y":2,"x":1}}', true],
    ['{"x":"1"}', '{"x":1}', false],
    ['{"x":9007199254740993123456789}', '{"x":9007199254740993123456788}', false],
    ['[1,2]', '[2,1]', false],
    ['{"x":null}', '{}', false],
  ] as const) {
    const comparator = fakeClient({ jsonbDefaultsMatch: matches })
    assert.equal(await jsonbDefaultLiteralsMatch(comparator.client, `'${left}'::jsonb`, `'${right}'::jsonb`, 'jsonb'), matches)
  }
  assert.equal(await jsonbDefaultLiteralsMatch(client, "'{}'::jsonb", "'{}'::jsonb", 'varchar'), false)
  assert.equal(await jsonbDefaultLiteralsMatch(client, "'{}'::jsonb", 'jsonb_build_object(\'x\', 1)', 'jsonb'), false)
})

test('catalog text-array comparison requires exact ordered arrays and rejects driver strings', () => {
  assert.equal(catalogTextArrayMatches(['first', 'second'], ['first', 'second']), true)
  assert.equal(catalogTextArrayMatches(['second', 'first'], ['first', 'second']), false)
  assert.equal(catalogTextArrayMatches(['first'], ['first', 'second']), false)
  assert.equal(catalogTextArrayMatches(['first', 'second', 'extra'], ['first', 'second']), false)
  assert.equal(catalogTextArrayMatches('{first,second}', ['first', 'second']), false)
})

test('canonical function body extraction preserves exact bytes between each builder dollar delimiter', () => {
  const triggerDDL = buildNewsMutationTriggersDDL()
  const expected = new Map([
    ...extractCanonicalFunctionBodies(triggerDDL, [
      'owner_news_mutation_guard_stmt', 'owner_news_mutation_capture_row', 'owner_news_seal_run',
    ]),
    ...extractCanonicalFunctionBodies(NEWS_MIGRATION_ITEM_BINDING_DDL, ['owner_news_migration_item_binding_guard']),
  ])
  const ddlByFunction = new Map([
    ['owner_news_mutation_guard_stmt', triggerDDL],
    ['owner_news_mutation_capture_row', triggerDDL],
    ['owner_news_seal_run', triggerDDL],
    ['owner_news_migration_item_binding_guard', NEWS_MIGRATION_ITEM_BINDING_DDL],
  ])
  const expectedBytes = new Map([
    ['owner_news_mutation_guard_stmt', 585],
    ['owner_news_mutation_capture_row', 2537],
    ['owner_news_seal_run', 3762],
    ['owner_news_migration_item_binding_guard', 1524],
  ])
  for (const [name, body] of expected) {
    const literalBytes = Buffer.from(independentDollarBody(ddlByFunction.get(name)!, name), 'utf8')
    const extractedBytes = Buffer.from(body, 'utf8')
    assert.deepEqual(extractedBytes, literalBytes, `${name} body must be verbatim`)
    assert.equal(literalBytes.length, expectedBytes.get(name))
    assert.equal(literalBytes[0], 0x0a)
    assert.equal(literalBytes.at(-1), 0x0a)
  }
})

test('canonical function body extraction supports empty/named exact-case tags and preserves nested different tags', () => {
  const emptyTag = "CREATE OR REPLACE FUNCTION public.empty_tag() RETURNS text LANGUAGE sql AS $$\nSELECT $nested$literal$nested$;\n$$;"
  const namedTag = "CREATE OR REPLACE FUNCTION public.named_tag() RETURNS text LANGUAGE sql AS $MiXeD_1$\r\n  SELECT 'exact';\r\n$MiXeD_1$;"
  assert.equal(extractCanonicalFunctionBodies(emptyTag, ['empty_tag']).get('empty_tag'),
    "\nSELECT $nested$literal$nested$;\n")
  assert.equal(extractCanonicalFunctionBodies(namedTag, ['named_tag']).get('named_tag'),
    "\r\n  SELECT 'exact';\r\n")
})

for (const [label, ddl, expected] of [
  ['missing declaration', '', ['missing_function']],
  ['duplicate declaration', 'CREATE OR REPLACE FUNCTION public.one() RETURNS text LANGUAGE sql AS $$x$$; CREATE OR REPLACE FUNCTION public.one() RETURNS text LANGUAGE sql AS $$y$$;', ['one']],
  ['different-case closing tag', 'CREATE OR REPLACE FUNCTION public.one() RETURNS text LANGUAGE sql AS $Tag$x$tag$;', ['one']],
  ['unsupported malformed opening tag', 'CREATE OR REPLACE FUNCTION public.one() RETURNS text LANGUAGE sql AS $9tag$x$9tag$;', ['one']],
  ['missing statement terminator', 'CREATE OR REPLACE FUNCTION public.one() RETURNS text LANGUAGE sql AS $$x$$', ['one']],
] as const) {
  test(`canonical function body extraction fails closed for ${label}`, () => {
    assert.throws(() => extractCanonicalFunctionBodies(ddl, expected), /canonical_function_inventory_unavailable/u)
  })
}

test('read-only precondition diagnosis identifies a catalog guard and does not enter DDL', async () => {
  const { client, statements } = fakeClient({ readOnly: true, badNativeDefault: true,
    enumLabelDrift: 'order', foreignKeyColumnDrift: 'extra' })
  const findings = await diagnoseFinalizerPreconditionsReadOnly(client)
  assert.deepEqual(findings[0], { phase: 'precondition-columns', reason: 'native_column_inventory_mismatch', sqlstate: null })
  assert.ok(findings.some(finding => finding.phase === 'precondition-enums' && finding.reason === 'native_enum_catalog_mismatch'))
  assert.ok(findings.some(finding => finding.phase === 'precondition-foreign-keys' && finding.reason === 'native_snapshot_foreign_key_mismatch'))
  assert.equal(statements.some(sql => /^(?:BEGIN|COMMIT|ROLLBACK|SET LOCAL ROLE|RESET ROLE|CREATE|ALTER|GRANT|REVOKE)\b/u.test(sql.trim())), false)
  assert.equal(statements.some(sql => sql.includes('CREATE TABLE public.owner_news_mutation_head')), false)
})

test('installed protocol audit reuses native/finalizer catalogs in a repeatable-read observer transaction only', async () => {
  const { client, statements } = fakeClient({ readOnly: true, existing: true })
  configureReadOnlyAuditClient(client, statements)

  const report = await auditNewsProtocolReadOnly(client)
  assert.deepEqual(report, {
    status: 'PASS', installed: true, catalogValid: true, targetDatabase: 'ownerinc_cms', observerRole: 'cms_observer',
    observedProtocolVersion: 2,
    observedCoverageVersion: 0, headSequence: '17', writeBarrier: 'open', ready: false, admissionActivated: false,
    releaseCertified: false, writeCoverageCertified: false, drainVerified: false,
    passwordPresenceCheck: 'not_performed_unprivileged', clusterSharedOwnershipCheck: 'performed_read_only_pg_shdepend_check',
    physicalClusterIdentity: 'not_verified',
  })
  assert.equal(statements[0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(statements[1], "SET LOCAL statement_timeout = '5s'")
  assert.equal(statements[2], 'SET LOCAL search_path = pg_catalog, public')
  assert.equal(statements.at(-1), 'COMMIT')
  assert.ok(statements.some(sql => sql.includes('p.proisstrict AS bootstrap_is_strict')))
  assert.ok(statements.includes(controlRolesPublicVerificationSQL))
  assert.ok(statements.includes(newsProtocolObserverOwnershipCatalogPrivilegeVerificationSQL))
  assert.ok(statements.includes(newsProtocolObserverRoleVerificationSQL))
  assert.ok(statements.includes(newsProtocolObserverPrivilegesVerificationSQL))
  assert.match(newsProtocolObserverPrivilegesVerificationSQL, /owner_news_bootstrap_run/u)
  assert.ok(statements.some(sql => /FROM pg_catalog\.pg_shdepend d/u.test(sql)))
  assert.ok(statements.some(sql => /FROM pg_shdepend d/u.test(sql)))
  assert.equal(statements.includes(controlRolesVerificationSQL), false)
  assert.equal(statements.some(sql => /\b(?:FROM|JOIN)\s+(?:pg_catalog\.)?pg_authid\b/iu.test(sql)), false)
  assert.equal(statements.some(sql => /\b(?:pg_advisory_xact_lock|SET\s+(?:LOCAL\s+)?ROLE)\b/iu.test(sql)), false)
  const forbiddenStatements = statements.filter(sql => !/^(?:SELECT|WITH)\b/iu.test(sql.trim())
    && sql !== 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
    && sql !== "SET LOCAL statement_timeout = '5s'" && sql !== 'SET LOCAL search_path = pg_catalog, public'
    && sql !== 'COMMIT' && sql !== 'ROLLBACK')
  assert.deepEqual(forbiddenStatements, [])
  const forbiddenQueryOperations = statements.filter(sql => /\b(?:INSERT\s+INTO|UPDATE\s+public\.|DELETE\s+FROM|TRUNCATE\s+|SET\s+(?:LOCAL\s+)?ROLE|RESET\s+ROLE|pg_advisory_xact_lock|setval\s*\(|nextval\s*\()/iu.test(sql))
  assert.deepEqual(forbiddenQueryOperations, [])
  const ownershipQuery = statements.find(sql => sql.includes('AS unexpected_control_objects'))
  assert.match(ownershipQuery ?? '', /d\.classid='pg_proc'::regclass AND d\.objid = ANY/u)
  assert.match(ownershipQuery ?? '', /AS approved_control_objects/u)
  assert.match(ownershipQuery ?? '', /AS control_shared_owned_objects/u)
  assert.match(ownershipQuery ?? '', /AS controller_shared_owned_objects/u)
})

test('observer reports exact V1 separately from coverage and never enters a mutation path', async () => {
  const { client, statements } = fakeClient({ protocolVersion: 1, readOnly: true, existing: true })
  configureReadOnlyAuditClient(client, statements, { protocolVersion: 1, observedCoverage: 1 })

  const report = await auditNewsProtocolReadOnly(client)
  assert.equal(report.observedProtocolVersion, 1)
  assert.equal(report.observedCoverageVersion, 1)
  assert.equal(report.ready, false)
  assert.equal(report.writeCoverageCertified, false)
  assert.ok(statements.includes('COMMIT'))
  assert.equal(statements.some(sql => sql === buildNewsMigrationBootstrapRunDDL()), false)
  assert.equal(statements.some(sql => /^(?:CREATE|ALTER|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE)\b/iu.test(sql.trim())), false)
  assert.equal(statements.some(sql => /\b(?:pg_advisory_xact_lock|SET\s+(?:LOCAL\s+)?ROLE|RESET\s+ROLE)\b/iu.test(sql)), false)
})

for (const protocolInventoryDrift of ['extra-function', 'missing-bootstrap-signature', 'bootstrap-overload'] as const) {
  test(`observer rejects V2 ${protocolInventoryDrift} catalog state read-only`, async () => {
    const { client, statements } = fakeClient({ readOnly: true, protocolVersion: 2, existing: true, protocolInventoryDrift })
    configureReadOnlyAuditClient(client, statements, { protocolVersion: 2 })

    const error = await auditNewsProtocolReadOnly(client).catch(value => value)
    assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'partial_protocol_installation_manual_recovery_required')
    assert.equal(statements.at(-1), 'ROLLBACK')
    assert.equal(statements.includes('COMMIT'), false)
    assert.equal(statements.some(sql => /^(?:CREATE|ALTER|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE)\b/iu.test(sql.trim())), false)
  })
}

test('observer rejects a bootstrap overload mixed into V1 without changing coverage classification', async () => {
  const { client, statements } = fakeClient({ readOnly: true, protocolVersion: 1, existing: true, protocolInventoryDrift: 'bootstrap-overload' })
  configureReadOnlyAuditClient(client, statements, { protocolVersion: 1, observedCoverage: 1 })

  const error = await auditNewsProtocolReadOnly(client).catch(value => value)
  assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'partial_protocol_installation_manual_recovery_required')
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.includes('COMMIT'), false)
})

test('observer denies effective EXECUTE on the V2 bootstrap RPC and rolls back its read-only snapshot', async () => {
  const { client, statements } = fakeClient({ readOnly: true, existing: true, observerBootstrapExecute: true })
  configureReadOnlyAuditClient(client, statements, { protocolVersion: 2 })

  const error = await auditNewsProtocolReadOnly(client).catch(value => value)
  assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'protocol_acl_mismatch')
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.includes('COMMIT'), false)
})

for (const bootstrapStrictness of ['strict', 'missing', 'null'] as const) {
  test(`finalizer V2 verification rejects bootstrap proisstrict=${bootstrapStrictness} catalog metadata without repair`, async () => {
    const { client, statements } = fakeClient({ protocolVersion: 2, bootstrapStrictness })
    const error = await finalizeNewsProtocol(client).catch(value => value)

    assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'canonical_function_mismatch')
    assert.equal(statements.at(-1), 'ROLLBACK')
    assert.equal(statements.includes('COMMIT'), false)
    assert.equal(statements.some(sql => sql === buildNewsMigrationBootstrapRunDDL()), false)
    assert.ok(statements.some(sql => sql.includes('p.proisstrict AS bootstrap_is_strict')))
  })
}

for (const bootstrapStrictness of ['strict', 'missing', 'null'] as const) {
  test(`observer rejects bootstrap proisstrict=${bootstrapStrictness} in its read-only snapshot`, async () => {
    const { client, statements } = fakeClient({ readOnly: true, protocolVersion: 2, existing: true, bootstrapStrictness })
    configureReadOnlyAuditClient(client, statements, { protocolVersion: 2 })
    const error = await auditNewsProtocolReadOnly(client).catch(value => value)

    assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'canonical_function_mismatch')
    assert.equal(statements.at(-1), 'ROLLBACK')
    assert.equal(statements.includes('COMMIT'), false)
    assert.equal(statements.some(sql => sql === buildNewsMigrationBootstrapRunDDL()), false)
    assert.ok(statements.some(sql => sql.includes('p.proisstrict AS bootstrap_is_strict')))
  })
}

test('bootstrap RPC SQL is a controller-bound contract and an offline source assertion, not SQL integration', () => {
  const ddl = buildNewsMigrationBootstrapRunDDL()
  const body = independentDollarBody(ddl, 'owner_news_bootstrap_run')
  assert.equal((ddl.match(/CREATE OR REPLACE FUNCTION public\.owner_news_bootstrap_run\(/gu) || []).length, 1)
  assert.match(ddl, /RETURNS TABLE\(id uuid\)[\s\S]*?LANGUAGE plpgsql[\s\S]*?CALLED ON NULL INPUT[\s\S]*?SECURITY DEFINER[\s\S]*?SET search_path = pg_catalog, public/u)
  assert.match(ddl, /REVOKE ALL ON FUNCTION public\.owner_news_bootstrap_run\(uuid,text,text,text,integer\) FROM PUBLIC, cms_runtime/u)
  assert.match(ddl, /GRANT EXECUTE ON FUNCTION public\.owner_news_bootstrap_run\(uuid,text,text,text,integer\) TO cms_controller/u)
  assert.match(ddl, /ALTER FUNCTION public\.owner_news_bootstrap_run\(uuid,text,text,text,integer\) OWNER TO cms_control/u)
  assert.match(ddl, new RegExp(`GRANT INSERT \\(${NEWS_MIGRATION_RUN_BOOTSTRAP_INSERT_COLUMNS.join(', ')}\\)[\\s\\S]*?TO cms_control`, 'u'))
  assert.match(body, /session_user IS DISTINCT FROM 'cms_controller'[\s\S]*?pg_advisory_xact_lock\(7194030\)/u)
  assert.ok(body.indexOf("session_user IS DISTINCT FROM 'cms_controller'") < body.indexOf('pg_advisory_xact_lock(7194030)'))
  assert.ok(body.indexOf('pg_advisory_xact_lock(7194030)') < body.indexOf('FROM public.owner_news_mutation_head'))
  assert.ok(body.indexOf('FROM public.owner_news_mutation_head') < body.indexOf('FROM public.news_migration_runs'))
  assert.match(body, /INTO STRICT head_sequence,[\s\S]*?WHERE head\.singleton IS TRUE[\s\S]*?FOR UPDATE/u)
  assert.match(body, /WHEN NO_DATA_FOUND OR TOO_MANY_ROWS[\s\S]*?owner_news_bootstrap_head_unavailable/u)
  assert.match(body, /head_sequence < 0[\s\S]*?head_chain_sha256 !~ '\^\[0-9a-f\]\{64\}\$'[\s\S]*?head_coverage_version NOT IN \(0, 1\)/u)
  assert.match(body, /head_write_barrier IS DISTINCT FROM 'open'[\s\S]*?RETURN QUERY SELECT run_by_id\.id AS id/u)
  assert.match(body, /p_run_id IS NULL[\s\S]*?p_manifest_sha256 !~ '\^\[0-9a-f\]\{64\}\$'[\s\S]*?length\(p_source_instance\) NOT BETWEEN 1 AND 128[\s\S]*?p_authority_epoch >= 2147483647/u)
  assert.match(body, /p_source_fingerprint IS NULL OR p_source_fingerprint !~ '\^\[0-9a-f\]\{64\}\$'/u)
  assert.match(body, /run_by_id\.source_instance IS DISTINCT FROM p_source_instance[\s\S]*?run_by_id\.source_fingerprint IS DISTINCT FROM p_source_fingerprint[\s\S]*?run_by_id\.authority_epoch IS DISTINCT FROM p_authority_epoch::numeric/u)
  assert.match(body, /run_by_id\.id IS DISTINCT FROM p_run_id[\s\S]*?run_by_id\.manifest_sha256 IS DISTINCT FROM p_manifest_sha256/u)
  assert.match(body, /WHERE runs\.id = p_run_id[\s\S]*?WHERE runs\.manifest_sha256 = p_manifest_sha256/u)
  assert.match(body, /IF NOT manifest_found[\s\S]*?run_by_id\.id IS DISTINCT FROM run_by_manifest\.id[\s\S]*?owner_news_bootstrap_identity_conflict/u)
  assert.match(body, /IF manifest_found THEN[\s\S]*?owner_news_bootstrap_identity_conflict/u)
  assert.match(body, /'preparing',[\s\S]*?'open',[\s\S]*?'acknowledged',[\s\S]*?'\[\]'::jsonb/u)
  assert.equal((body.match(/INSERT INTO public\.news_migration_runs/gu) || []).length, 1)
  assert.doesNotMatch(body, /\b(?:INSERT\s+INTO|UPDATE)\s+public\.owner_news_mutation_(?:head|events)\b/iu)
  assert.doesNotMatch(body, /EXECUTE\s+/iu)
  assert.equal(NEWS_MIGRATION_BOOTSTRAP_RUN_SIGNATURE, 'public.owner_news_bootstrap_run(uuid,text,text,text,integer)')
  assert.deepEqual([...NEWS_MIGRATION_RUN_BOOTSTRAP_INSERT_COLUMNS], [
    'id', 'manifest_sha256', 'source_instance', 'source_fingerprint', 'authority_epoch',
    'progress_state', 'admission_state', 'commit_outcome', 'unresolved_exceptions',
  ])
  assert.equal(parseProtocolFinalizerArguments(['--finalize-protocol']), 'finalize')
  assert.equal(parseProtocolFinalizerArguments(['--upgrade-protocol-v1-to-v2']), 'upgrade-v1-to-v2')
  assert.equal(parseProtocolFinalizerArguments([]), null)
  assert.equal(parseProtocolFinalizerArguments(['--finalize-protocol', '--upgrade-protocol-v1-to-v2']), null)
  assert.equal(parseProtocolFinalizerArguments(['--unknown']), null)
})

test('observer audit accepts no public pgcrypto baseline without confusing SQL NULL for effective EXECUTE', async () => {
  const { client, statements } = fakeClient({ readOnly: true, existing: true })
  configureReadOnlyAuditClient(client, statements, { pgcryptoBaselineAbsent: true })

  const report = await auditNewsProtocolReadOnly(client)
  assert.equal(report.status, 'PASS')
  assert.equal(report.observerRole, 'cms_observer')
  assert.equal(report.ready, false)
  assert.equal(statements.at(-1), 'COMMIT')
  assert.equal(statements.some(sql => /^(?:GRANT|REVOKE|CREATE|ALTER|INSERT|UPDATE|DELETE|TRUNCATE)\b/iu.test(sql.trim())), false)
})

test('observer audit still rejects effective EXECUTE on a public function when the pgcrypto baseline is absent', async () => {
  const { client, statements } = fakeClient({ readOnly: true, existing: true })
  configureReadOnlyAuditClient(client, statements,
    { pgcryptoBaselineAbsent: true, observerUnexpectedFunctionExecute: true })

  const error = await auditNewsProtocolReadOnly(client).catch(value => value)
  assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'public_function_execute_outside_allowlist')
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.includes('COMMIT'), false)
})

test('audit stops and rolls back unless PostgreSQL confirms read-only repeatable-read snapshot and bounded timeout', async () => {
  const { client, statements } = fakeClient({ readOnly: true, existing: true })
  configureReadOnlyAuditClient(client, statements, { auditTransactionSafe: false })
  const error = await auditNewsProtocolReadOnly(client).catch(value => value)

  assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'audit_transaction_contract_mismatch')
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.some(sql => sql.includes('FROM public.payload_migrations')), false)
  assert.equal(statements.includes('COMMIT'), false)
})

test('audit refuses to query protocol catalogs if the transaction search_path is not pinned', async () => {
  const { client, statements } = fakeClient({ readOnly: true, existing: true })
  configureReadOnlyAuditClient(client, statements, { auditSearchPathSafe: false })
  const error = await auditNewsProtocolReadOnly(client).catch(value => value)

  assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'audit_transaction_contract_mismatch')
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.some(sql => sql.includes('FROM public.payload_migrations')), false)
})

test('read-only audit reports observed coverage 1 without readiness, activation, seal, or release certification', async () => {
  const { client, statements } = fakeClient({ readOnly: true, existing: true })
  configureReadOnlyAuditClient(client, statements, { observedCoverage: 1 })

  const report = await auditNewsProtocolReadOnly(client)
  assert.equal(report.observedProtocolVersion, 2)
  assert.equal(report.observedCoverageVersion, 1)
  assert.equal(report.ready, false)
  assert.equal(report.admissionActivated, false)
  assert.equal(report.releaseCertified, false)
  assert.equal(report.writeCoverageCertified, false)
  assert.equal(report.drainVerified, false)
  assert.equal(statements.at(-1), 'COMMIT')
})

test('observer ACL mismatch aborts the read-only audit and rolls back its snapshot', async () => {
  const { client, statements } = fakeClient({ readOnly: true, existing: true })
  configureReadOnlyAuditClient(client, statements, { observerPrivilegesSafe: false })
  const error = await auditNewsProtocolReadOnly(client).catch(value => value)

  assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'observer_privilege_contract_mismatch')
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.includes('COMMIT'), false)
  assert.equal(statements.some(sql => /^(?:CREATE|ALTER|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE|DO)\b/iu.test(sql.trim())), false)
})

for (const owner of ['cms_control', 'cms_controller'] as const) {
  for (const [objectClass, dbid] of [
    ['pg_publication', 16384],
    ['pg_statistic_ext', 16384],
    ['pg_ts_dict', 16384],
    ['pg_event_trigger', 16384],
    ['pg_publication', 0],
    ['pg_statistic_ext', 0],
    ['pg_ts_dict', 0],
    ['pg_event_trigger', 0],
  ] as const) {
    test(`observer audit rejects ${objectClass} ownership by ${owner} (dbid=${dbid}) and rolls back`, async () => {
      const { client, statements } = fakeClient({ readOnly: true, existing: true })
      configureReadOnlyAuditClient(client, statements, { ownershipDependency: { owner, classid: objectClass, dbid } })
      const error = await auditNewsProtocolReadOnly(client).catch(value => value)

      const ownershipQuery = statements.find(sql => sql.includes('AS unexpected_control_objects'))
      assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'observer_visible_ownership_mismatch')
      assert.match(ownershipQuery ?? '', /FROM pg_shdepend d JOIN pg_roles r ON r\.oid=d\.refobjid/u)
      assert.match(ownershipQuery ?? '', /d\.classid <> 'pg_proc'::regclass OR d\.objid <> ALL/u)
      assert.match(ownershipQuery ?? '', /d\.dbid=\(SELECT oid FROM pg_database WHERE datname=current_database\(\)\)/u)
      assert.match(ownershipQuery ?? '', /d\.dbid=0/u)
      assert.doesNotMatch(ownershipQuery ?? '', /41002|41003|pg_statistic_ext|pg_ts_dict|pg_event_trigger|pg_publication/u)
      assert.equal(statements.at(-1), 'ROLLBACK')
      assert.equal(statements.includes('COMMIT'), false)
      assert.equal(statements.some(sql => /\b(?:FROM|JOIN)\s+(?:pg_catalog\.)?pg_authid\b/iu.test(sql)), false)
      assert.equal(statements.some(sql => /^(?:CREATE|ALTER|GRANT|REVOKE|INSERT|UPDATE|DELETE|TRUNCATE|SET LOCAL ROLE|RESET ROLE)\b/iu.test(sql.trim())), false)
    })
  }
}

test('observer ownership audit fails closed before reading pg_shdepend when catalog SELECT is unavailable', async () => {
  const { client, statements } = fakeClient({ readOnly: true, existing: true })
  configureReadOnlyAuditClient(client, statements, { observerShdependAccessible: false })
  const error = await auditNewsProtocolReadOnly(client).catch(value => value)

  assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'observer_role_contract_mismatch')
  assert.ok(statements.includes(newsProtocolObserverOwnershipCatalogPrivilegeVerificationSQL))
  assert.equal(statements.includes(newsProtocolObserverRoleVerificationSQL), false)
  assert.equal(statements.some(sql => /FROM pg_catalog\.pg_shdepend\b/iu.test(sql)), false)
  assert.equal(statements.some(sql => sql.includes('FROM public.payload_migrations')), false)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.includes('COMMIT'), false)
  assert.equal(statements.some(sql => /^(?:GRANT|REVOKE|CREATE|ALTER|SET LOCAL ROLE)\b/iu.test(sql.trim())), false)
})

test('observer role elevation or membership mismatch fails before installed catalog traversal', async () => {
  const { client, statements } = fakeClient({ readOnly: true, existing: true })
  configureReadOnlyAuditClient(client, statements, { observerRoleSafe: false })
  const error = await auditNewsProtocolReadOnly(client).catch(value => value)

  assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'observer_role_contract_mismatch')
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.some(sql => sql.includes('AS ledger_relations')), false)
  assert.equal(statements.includes('COMMIT'), false)
})

test('read-only audit rejects an admin or otherwise mismatched connection identity', async () => {
  const { client, statements } = fakeClient({ readOnly: true, existing: true })
  configureReadOnlyAuditClient(client, statements, { observerIdentitySafe: false })
  const error = await auditNewsProtocolReadOnly(client).catch(value => value)

  assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'unsafe_observer_target')
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.some(sql => sql.includes('FROM public.payload_migrations')), false)
})

test('observer audit rejects invalid coverage values without certifying or changing them', async () => {
  const { client, statements } = fakeClient({ readOnly: true, existing: true })
  configureReadOnlyAuditClient(client, statements, { invalidCoverage: true })
  const error = await auditNewsProtocolReadOnly(client).catch(value => value)

  assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'ledger_head_invalid_or_coverage_activated')
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.some(sql => /\b(?:INSERT|UPDATE|DELETE)\s+public\.owner_news_mutation_head\b/iu.test(sql)), false)
  assert.equal(statements.includes('COMMIT'), false)
})

test('read-only diagnosis does not accept a partial protocol inventory as a valid install state', async () => {
  const { client, statements } = fakeClient({ readOnly: true, partial: true })
  const findings = await diagnoseFinalizerPreconditionsReadOnly(client)
  assert.ok(findings.some(finding => finding.phase === 'precondition-protocol-inventory'
    && finding.reason === 'partial_protocol_installation_manual_recovery_required'))
  assert.equal(statements.some(sql => sql === ledgerHeadDDL), false)
  assert.equal(statements.some(sql => sql.startsWith('SET LOCAL ROLE')), false)
})

test('cold-install and V1-upgrade rollback helpers preserve real empty/V1 versus partial inventory classification', async () => {
  const suffix = '8c72f420c113'
  const fixtureNames = buildFinalizerRollbackFixtureNames(suffix)
  const coldFunctionRows = [fixtureNames.coldInstallRoguePublicFunction, fixtureNames.coldInstallCaptureFunction]
  const coldFixture = fakeClient({ readOnly: true, catalogFunctionNames: coldFunctionRows })

  assert.deepEqual(coldFixture.catalogFunctionRows, coldFunctionRows.map(proname => ({ proname })))
  assert.ok(coldFunctionRows.every(name => !name.startsWith('owner_news_')))
  const coldFindings = await diagnoseFinalizerPreconditionsReadOnly(coldFixture.client)
  assert.deepEqual(coldFindings, [])
  const inventorySql = coldFixture.statements.find(sql => sql.includes('AS unexpected_protocol_functions'))
  assert.match(inventorySql ?? '', /p\.proname::text ~ '\^owner_news_'/u)

  const legacyColdFunctionRows = [
    `owner_news_finalizer_fixture_${suffix}`,
    `owner_news_finalizer_ddl_capture_${suffix}`,
  ]
  const legacyColdFixture = fakeClient({ readOnly: true, catalogFunctionNames: legacyColdFunctionRows })
  assert.deepEqual(legacyColdFixture.catalogFunctionRows, legacyColdFunctionRows.map(proname => ({ proname })))
  const legacyColdFindings = await diagnoseFinalizerPreconditionsReadOnly(legacyColdFixture.client)
  assert.ok(legacyColdFindings.some(finding => finding.phase === 'precondition-protocol-inventory'
    && finding.reason === 'partial_protocol_installation_manual_recovery_required'))
  assert.equal(legacyColdFixture.statements.includes(ledgerHeadDDL), false)
  assert.equal(legacyColdFixture.statements.some(sql => sql.startsWith('SET LOCAL ROLE')), false)

  const v1Fixture = fakeClient({ protocolVersion: 1, catalogFunctionNames: [fixtureNames.v1UpgradeCaptureFunction] })
  assert.deepEqual(v1Fixture.catalogFunctionRows, [{ proname: fixtureNames.v1UpgradeCaptureFunction }])
  assert.ok(!fixtureNames.v1UpgradeCaptureFunction.startsWith('owner_news_'))
  const v1Error = await finalizeNewsProtocol(v1Fixture.client).catch(error => error)
  assert.equal(getFinalizerFailureDiagnostic(v1Error)?.reason, 'protocol_upgrade_required')
  assert.equal(v1Fixture.statements.includes(ledgerHeadDDL), false)
  assert.equal(v1Fixture.statements.includes(buildNewsMigrationBootstrapRunDDL()), false)

  const legacyV1Fixture = fakeClient({ protocolVersion: 1,
    catalogFunctionNames: [`owner_news_v2_ddl_capture_${suffix}`] })
  const legacyV1Error = await finalizeNewsProtocol(legacyV1Fixture.client).catch(error => error)
  assert.equal(getFinalizerFailureDiagnostic(legacyV1Error)?.reason,
    'partial_protocol_installation_manual_recovery_required')
  assert.equal(legacyV1Fixture.statements.includes(ledgerHeadDDL), false)
  assert.equal(legacyV1Fixture.statements.includes(buildNewsMigrationBootstrapRunDDL()), false)
})

test('diagnostic formatter exposes only allowlisted phase/reason and a strict SQLSTATE', async () => {
  const fixture = fakeClient({ readOnly: true, failMigrationSqlState: '42P01' })
  const error = await diagnoseFinalizerPreconditionsReadOnly(fixture.client).catch(value => value)
  const diagnostic = getFinalizerFailureDiagnostic(error)
  assert.deepEqual(diagnostic, { phase: 'precondition-migrations', reason: 'database_error', sqlstate: '42P01' })
  const formatted = formatFinalizerFailureDiagnostic(diagnostic!)
  assert.equal(formatted, 'CMS news protocol diagnostic: phase=precondition-migrations reason=database_error sqlstate=42P01')
  assert.equal(formatted.includes('database message must not appear'), false)
  assert.equal(getFinalizerFailureDiagnostic(error)?.phase, 'precondition-migrations')
  assert.equal(formatFinalizerFailureDiagnostic({ phase: 'untrusted-phase' as never,
    reason: 'password-in-error-message', sqlstate: '42P01-secret' }),
  'CMS news protocol diagnostic: phase=connection-configuration reason=database_error sqlstate=none')
})

test('failure after ledger DDL preserves its SQLSTATE and rolls back without commit', async () => {
  const { client, statements } = fakeClient({ failTriggerSqlState: '42501' })
  const error = await finalizeNewsProtocol(client).catch(value => value)
  const diagnostic = getFinalizerFailureDiagnostic(error)
  assert.deepEqual(diagnostic, { phase: 'protocol-trigger-ddl', reason: 'database_error', sqlstate: '42501' })
  const formatted = formatFinalizerFailureDiagnostic(diagnostic!)
  assert.equal(formatted.includes('sensitive DDL message'), false)
  assert.ok(NEWS_MUTATION_LEDGER_STATEMENTS.every(statement => statements.includes(statement.sql)))
  assert.ok(statements.indexOf(ledgerHeadDDL) < statements.findIndex(sql => sql === buildNewsMutationTriggersDDL()))
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.includes('COMMIT'), false)
})

for (const [index, statement] of NEWS_MUTATION_LEDGER_STATEMENTS.entries()) {
  test(`ledger ${statement.operation} failure records the exact closed operation and rolls back`, async () => {
    const { client, statements } = fakeClient({ failLedgerOperation: statement.operation })
    const error = await finalizeNewsProtocol(client).catch(value => value)
    const diagnostic = getFinalizerFailureDiagnostic(error)
    assert.deepEqual(diagnostic, { phase: 'protocol-ledger-ddl', reason: 'database_error', sqlstate: '42501', operation: statement.operation })
    assert.equal(formatFinalizerFailureDiagnostic(diagnostic!),
      `CMS news protocol diagnostic: phase=protocol-ledger-ddl reason=database_error sqlstate=42501 operation=${statement.operation} ddl_source=mutation-ledger expected_owner=cms_admin`)
    assert.deepEqual(statements.filter(sql => NEWS_MUTATION_LEDGER_STATEMENTS.some(entry => entry.sql === sql)),
      NEWS_MUTATION_LEDGER_STATEMENTS.slice(0, index + 1).map(entry => entry.sql))
    assert.equal(statements.includes(buildNewsMutationTriggersDDL()), false)
    assert.equal(statements.includes('COMMIT'), false)
    assert.equal(statements.at(-1), 'ROLLBACK')
    assert.equal(JSON.stringify(diagnostic).includes('private'), false)
  })
}

test('ledger operation diagnostics cannot echo injected operation/source/owner or contaminate other phases', () => {
  const base = { phase: 'protocol-ledger-ddl' as const, reason: 'database_error', sqlstate: '42501' }
  assert.equal(formatFinalizerFailureDiagnostic({ ...base, operation: 'postgresql://private' as never }),
    'CMS news protocol diagnostic: phase=protocol-ledger-ddl reason=database_error sqlstate=42501')
  assert.equal(formatFinalizerFailureDiagnostic({ ...base, phase: 'protocol-trigger-ddl', operation: 'ledger-head-create' }),
    'CMS news protocol diagnostic: phase=protocol-trigger-ddl reason=database_error sqlstate=42501')
  assert.equal(formatFinalizerFailureDiagnostic(Object.assign({ ...base, operation: 'ledger-head-create' as const },
    { ddlSource: 'private-path', expectedOwner: 'private-role', message: 'private-driver-text' })),
    'CMS news protocol diagnostic: phase=protocol-ledger-ddl reason=database_error sqlstate=42501 operation=ledger-head-create ddl_source=mutation-ledger expected_owner=cms_admin')
})

test('finalizer installs atomically only after exact native inventory and role checks; readiness and coverage stay disabled', async () => {
  const { client, statements } = fakeClient()
  const result = await finalizeNewsProtocol(client)
  assert.deepEqual(result, { installed: true, ready: false, coverageVersion: 0 })
  assert.equal(statements[0], 'BEGIN')
  assert.equal(statements[1], 'SET LOCAL search_path = pg_catalog, public')
  assert.ok(statements[2]?.includes('pg_advisory_xact_lock(7194030)'))
  assert.ok(statements.includes(controlRolesVerificationSQL))
  assert.ok(statements.includes(controlRolesOwnershipVerificationSQL))
  assert.ok(statements.includes(controlRolesNativePrivilegesVerificationSQL))
  assert.ok(statements.includes('SET LOCAL ROLE cms_runtime'))
  assert.ok(statements.includes('RESET ROLE'))
  assert.match(runtimeProtocolPrivilegesVerifySQL, /has_table_privilege\('cms_runtime'/u)
  assert.match(runtimeProtocolFunctionsVerifySQL, /has_function_privilege\('cms_runtime'/u)
  assert.match(runtimeProtocolFunctionsVerifySQL, /owner_news_bootstrap_run/u)
  assert.ok(statements.some(sql => sql.includes('CREATE TABLE public.owner_news_mutation_head')))
  const ledgerStart = statements.indexOf(ledgerHeadDDL)
  assert.deepEqual(statements.slice(ledgerStart, ledgerStart + 3), NEWS_MUTATION_LEDGER_STATEMENTS.map(statement => statement.sql))
  assert.ok(statements.includes(buildNewsMigrationBootstrapRunDDL()))
  assert.ok(statements.indexOf(ledgerHeadDDL) < statements.findIndex(sql => sql.includes('FROM public.owner_news_mutation_head')))
  assert.equal(statements.filter(sql => sql.includes('SELECT sequence::text AS sequence')).length, 1)
  assert.ok(statements.includes(NATIVE_ENUM_CATALOG_SQL))
  assert.match(NATIVE_ENUM_CATALOG_SQL, /enumlabel::text ORDER BY e\.enumsortorder\)::text\[\]/u)
  assert.ok(statements.includes(NATIVE_FOREIGN_KEYS_CATALOG_SQL))
  assert.equal((NATIVE_FOREIGN_KEYS_CATALOG_SQL.match(/attname::text/gu) || []).length, 2)
  assert.ok(statements.some(sql => sql.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cms_runtime')))
  assert.equal(statements.at(-1), 'COMMIT')
  assert.equal(statements.some(sql => /UPDATE\s+public\.owner_news_mutation_head[^;]*coverage_version|SET\s+coverage_version/u.test(sql)), false)
})

test('ordinary finalizer verifies exact V1 then returns upgrade-required without DDL', async () => {
  const { client, statements } = fakeClient({ protocolVersion: 1 })
  const error = await finalizeNewsProtocol(client).catch(value => value)

  assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'protocol_upgrade_required')
  assert.equal(statements.includes(buildNewsMigrationBootstrapRunDDL()), false)
  assert.equal(statements.includes(ledgerHeadDDL), false)
  assert.equal(statements.includes(buildNewsMutationTriggersDDL()), false)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.includes('COMMIT'), false)
})

test('explicit V1-to-V2 upgrade changes only the bootstrap RPC and exact insert grants', async () => {
  const { client, statements } = fakeClient({ protocolVersion: 1 })
  const result = await upgradeNewsProtocolV1ToV2(client)

  assert.deepEqual(result, { installed: false, ready: false, coverageVersion: 0 })
  assert.equal(statements.filter(sql => sql === buildNewsMigrationBootstrapRunDDL()).length, 1)
  assert.equal(statements.includes(ledgerHeadDDL), false)
  assert.equal(statements.includes(buildNewsMutationTriggersDDL()), false)
  assert.equal(statements.includes(NEWS_MIGRATION_ITEM_BINDING_DDL), false)
  assert.ok(statements.some(sql => sql.includes('protocol_functions') && sql.includes('pg_catalog.to_regprocedure')))
  assert.equal(statements.at(-1), 'COMMIT')
  assert.equal(statements.some(sql => /UPDATE\s+public\.owner_news_mutation_head[^;]*coverage_version|SET\s+coverage_version/u.test(sql)), false)
})

test('exact V2 finalization and explicit upgrade retry verify without protocol DDL', async () => {
  for (const operation of [finalizeNewsProtocol, upgradeNewsProtocolV1ToV2]) {
    const { client, statements } = fakeClient({ protocolVersion: 2 })
    assert.deepEqual(await operation(client), { installed: false, ready: false, coverageVersion: 0 })
    assert.equal(statements.some(sql => sql === buildNewsMigrationBootstrapRunDDL()), false)
    assert.ok(statements.some(sql => sql.includes('p.proisstrict AS bootstrap_is_strict')))
    assert.equal(statements.some(sql => NEWS_MUTATION_LEDGER_STATEMENTS.some(statement => statement.sql === sql) || sql === buildNewsMutationTriggersDDL()), false)
    assert.equal(statements.at(-1), 'COMMIT')
  }
})

test('explicit upgrade rejects empty protocol without DDL', async () => {
  const { client, statements } = fakeClient()
  const error = await upgradeNewsProtocolV1ToV2(client).catch(value => value)

  assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'protocol_upgrade_requires_v1')
  assert.equal(statements.some(sql => sql === buildNewsMigrationBootstrapRunDDL() || sql === ledgerHeadDDL), false)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.includes('COMMIT'), false)
})

for (const protocolInventoryDrift of ['extra-function', 'missing-bootstrap-signature', 'bootstrap-overload'] as const) {
  test(`protocol V2 rejects ${protocolInventoryDrift} inventory before DDL`, async () => {
    const { client, statements } = fakeClient({ protocolVersion: 2, protocolInventoryDrift })
    await assert.rejects(finalizeNewsProtocol(client), /partial_protocol_installation_manual_recovery_required/u)
    assert.equal(statements.some(sql => sql === buildNewsMigrationBootstrapRunDDL()), false)
    assert.equal(statements.at(-1), 'ROLLBACK')
  })
}

test('V2 installed verification rejects wrong bootstrap return or argument identity', async () => {
  for (const option of [{ wrongBootstrapReturnShape: true }, { wrongBootstrapArgumentNames: true }]) {
    const { client, statements } = fakeClient({ protocolVersion: 2, ...option })
    await assert.rejects(finalizeNewsProtocol(client), /canonical_function_mismatch/u)
    assert.equal(statements.some(sql => sql === buildNewsMigrationBootstrapRunDDL()), false)
    assert.equal(statements.at(-1), 'ROLLBACK')
  }
})

for (const option of [
  { wrongBootstrapOwner: true },
  { wrongBootstrapSearchPath: true },
  { tamperFunctionSource: { name: 'owner_news_bootstrap_run', mutation: 'string-literal' as const } },
]) {
  test(`V2 installed verification rejects bootstrap ${Object.keys(option)[0]} drift`, async () => {
    const { client, statements } = fakeClient({ protocolVersion: 2, ...option })
    await assert.rejects(finalizeNewsProtocol(client), /canonical_function_mismatch/u)
    assert.equal(statements.some(sql => sql === buildNewsMigrationBootstrapRunDDL()), false)
    assert.equal(statements.at(-1), 'ROLLBACK')
  })
}

for (const wrongBootstrapAcl of ['controller', 'runtime', 'public'] as const) {
  test(`V2 installed verification rejects ${wrongBootstrapAcl} bootstrap EXECUTE ACL drift`, async () => {
    const { client, statements } = fakeClient({ protocolVersion: 2, wrongBootstrapAcl })
    const error = await finalizeNewsProtocol(client).catch(value => value)
    assert.ok(['public_function_execute_outside_allowlist', 'protocol_acl_mismatch']
      .includes(getFinalizerFailureDiagnostic(error)?.reason || ''))
    assert.equal(statements.some(sql => sql === buildNewsMigrationBootstrapRunDDL()), false)
    assert.equal(statements.at(-1), 'ROLLBACK')
  })
}

test('V2 installed verification rejects column INSERT outside the bootstrap allowlist', async () => {
  const { client, statements } = fakeClient({ protocolVersion: 2, extraBootstrapColumnGrant: true })
  await assert.rejects(finalizeNewsProtocol(client), /control_role_column_acl_mismatch/u)
  assert.equal(statements.some(sql => sql === buildNewsMigrationBootstrapRunDDL()), false)
  assert.equal(statements.at(-1), 'ROLLBACK')
})

test('ordinary finalizer bootstrap DDL failure rolls back the cold install', async () => {
  const { client, statements } = fakeClient({ failBootstrapSqlState: '42501' })
  const error = await finalizeNewsProtocol(client).catch(value => value)

  assert.deepEqual(getFinalizerFailureDiagnostic(error), {
    phase: 'protocol-bootstrap-ddl', reason: 'database_error', sqlstate: '42501',
  })
  assert.ok(NEWS_MUTATION_LEDGER_STATEMENTS.every(statement => statements.includes(statement.sql)))
  assert.ok(statements.includes(buildNewsMigrationBootstrapRunDDL()))
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.includes('COMMIT'), false)
})

test('V1 upgrade DDL failure rolls back without replacing native or existing V1 protocol objects', async () => {
  const { client, statements } = fakeClient({ protocolVersion: 1, failBootstrapSqlState: '42501' })
  const error = await upgradeNewsProtocolV1ToV2(client).catch(value => value)

  assert.deepEqual(getFinalizerFailureDiagnostic(error), {
    phase: 'protocol-bootstrap-ddl', reason: 'database_error', sqlstate: '42501',
  })
  assert.equal(statements.filter(sql => sql === buildNewsMigrationBootstrapRunDDL()).length, 1)
  assert.equal(statements.some(sql => sql === ledgerHeadDDL || sql === buildNewsMutationTriggersDDL()
    || sql === NEWS_MIGRATION_ITEM_BINDING_DDL), false)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.includes('COMMIT'), false)
})

test('wrong expected migration history aborts and rolls back before any protocol DDL', async () => {
  const { client, statements } = fakeClient({ missingMigration: true })
  await assert.rejects(finalizeNewsProtocol(client), /native_migration_ledger_mismatch/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.some(sql => sql.includes('CREATE TABLE public.owner_news_mutation_head')), false)
})

test('native column drift aborts before DDL and does not repair schema', async () => {
  const { client, statements } = fakeClient({ badControlType: true })
  await assert.rejects(finalizeNewsProtocol(client), /native_column_inventory_mismatch|native_control_column_types_mismatch/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.some(sql => sql.includes('ALTER TABLE')), false)
})

test('nullable native catalog drift fails before protocol DDL', async () => {
  const { client, statements } = fakeClient({ badNativeNullability: true })
  await assert.rejects(finalizeNewsProtocol(client), /native_column_inventory_mismatch/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.some(sql => sql.includes('CREATE TABLE public.owner_news_mutation_head')), false)
})

test('native default drift fails before protocol DDL', async () => {
  const { client, statements } = fakeClient({ badNativeDefault: true })
  await assert.rejects(finalizeNewsProtocol(client), /native_column_inventory_mismatch/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.some(sql => sql.includes('CREATE TABLE public.owner_news_mutation_head')), false)
})

test('missing required native custom constraint blocks installation', async () => {
  const { client, statements } = fakeClient({ missingConstraint: true })
  await assert.rejects(finalizeNewsProtocol(client), /native_required_constraint_missing/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.some(sql => sql.includes('CREATE TABLE public.owner_news_mutation_head')), false)
})

test('missing or mismatched native snapshot index blocks installation', async () => {
  const { client, statements } = fakeClient({ missingIndex: true })
  await assert.rejects(finalizeNewsProtocol(client), /native_snapshot_index_missing_or_mismatched/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.some(sql => sql.includes('CREATE TABLE public.owner_news_mutation_head')), false)
})

test('native snapshot foreign-key drift blocks installation', async () => {
  const { client, statements } = fakeClient({ missingForeignKey: true })
  await assert.rejects(finalizeNewsProtocol(client), /native_snapshot_foreign_key_mismatch/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.some(sql => sql.includes('CREATE TABLE public.owner_news_mutation_head')), false)
})

for (const foreignKeyColumnDrift of ['missing', 'extra'] as const) {
  test(`native snapshot foreign-key column ${foreignKeyColumnDrift} drift blocks installation`, async () => {
    const { client, statements } = fakeClient({ foreignKeyColumnDrift })
    await assert.rejects(finalizeNewsProtocol(client), /native_snapshot_foreign_key_mismatch/u)
    assert.equal(statements.at(-1), 'ROLLBACK')
    assert.equal(statements.some(sql => sql.includes('CREATE TABLE public.owner_news_mutation_head')), false)
  })
}

for (const enumLabelDrift of ['order', 'missing', 'extra'] as const) {
  test(`native enum ${enumLabelDrift} label drift blocks installation`, async () => {
    const { client, statements } = fakeClient({ enumLabelDrift })
    await assert.rejects(finalizeNewsProtocol(client), /native_enum_catalog_mismatch/u)
    assert.equal(statements.at(-1), 'ROLLBACK')
    assert.equal(statements.some(sql => sql.includes('CREATE TABLE public.owner_news_mutation_head')), false)
  })
}

for (const [invalidTrigger, reason] of [
  ['insert-only', 'trigger_event_mask_mismatch'], ['wrong-timing', 'trigger_event_mask_mismatch'],
  ['row-level', 'trigger_event_mask_mismatch'], ['when', 'trigger_condition_mismatch'],
  ['binding', 'trigger_event_mask_mismatch'], ['disabled', 'trigger_enabled_state_mismatch'],
  ['wrong-function', 'trigger_function_identity_mismatch'], ['wrong-function-schema', 'trigger_function_schema_mismatch'],
  ['wrong-function-identity', 'trigger_function_identity_mismatch'], ['wrong-event-mask', 'trigger_event_mask_mismatch'],
  ['wrong-column-inventory', 'trigger_column_inventory_mismatch'], ['wrong-catalog-type', 'trigger_catalog_type_mismatch'],
  ['wrong-arguments', 'trigger_argument_inventory_mismatch'], ['duplicate', 'trigger_key_duplicate'],
  ['missing', 'trigger_key_missing'], ['extra', 'trigger_inventory_count_mismatch'],
  ['definition-update-of', 'trigger_definition_mismatch'], ['definition-duplicate-event', 'trigger_definition_mismatch'],
  ['definition-when-literal', 'trigger_condition_mismatch'], ['definition-case', 'trigger_definition_mismatch'],
  ['unqualified-wrong-function-identity', 'trigger_function_identity_mismatch'],
  ['unqualified-wrong-function-schema', 'trigger_function_schema_mismatch'],
  ['unqualified-wrong-function-name', 'trigger_function_identity_mismatch'],
  ['definition-relation-unqualified', 'trigger_definition_mismatch'],
  ['definition-relation-wrong-schema', 'trigger_definition_mismatch'],
] as const) {
  test(`installed trigger metadata guard reports only its fixed reason (${invalidTrigger})`, async () => {
    const { client, statements } = fakeClient({ existing: true, invalidTrigger,
      unqualifiedTriggerFunctions: invalidTrigger.startsWith('unqualified-wrong-') })
    const error = await finalizeNewsProtocol(client).catch(value => value)
    const diagnostic = getFinalizerFailureDiagnostic(error)
    assert.equal(diagnostic?.phase, 'verify-installed')
    assert.equal(diagnostic?.reason, reason)
    assert.equal(statements.at(-1), 'ROLLBACK')
    const formatted = formatFinalizerFailureDiagnostic(diagnostic!)
    assert.match(formatted, /^CMS news protocol diagnostic: phase=verify-installed reason=trigger_[a-z_]+ sqlstate=none /u)
    assert.equal(formatted.includes('CREATE TRIGGER'), false)
    assert.equal(formatted.includes('owner_news_mutation_guard_stmt'), false)
    if (diagnostic?.triggerDetails) {
      assert.equal(Object.values(diagnostic.triggerDetails).some(value => typeof value === 'string'), false)
    }
  })
}

test('canonical expected trigger SQL matches independent PostgreSQL 16 event rendering for all 80 definitions', () => {
  // PostgreSQL 16 ruleutils.c pg_get_triggerdef_worker emits INSERT, DELETE,
  // UPDATE, TRUNCATE in that fixed order (REL_16_STABLE, lines around 1337-1384):
  // https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/utils/adt/ruleutils.c
  // This deliberately models only those documented event bits; it does not
  // simulate a server or weaken the exact/normalized definition check.
  const renderPostgresEventOrder = (events: string[]) => ['INSERT', 'DELETE', 'UPDATE', 'TRUNCATE']
    .filter(event => events.includes(event))
  const orderMismatches = [...canonicalTriggerDefinitions].filter(([, definition]) => {
    const events = definition.match(/ (INSERT|DELETE|UPDATE|TRUNCATE)(?: OR (?:INSERT|DELETE|UPDATE|TRUNCATE))* ON /u)?.[0]
      ?.replace(/^ | ON $/gu, '').split(' OR ') ?? []
    const canonicalOrder = events.join(' OR ')
    const pgOrder = renderPostgresEventOrder(events).join(' OR ')
    return canonicalOrder !== pgOrder
  })
  assert.equal(canonicalTriggerDefinitions.size, NEWS_MUTATION_TABLES.length * 2 + 2)
  assert.equal(orderMismatches.length, NEWS_MUTATION_TABLES.length * 2 + 1)
  assert.ok(orderMismatches.every(([, definition]) => definition.includes(' OR UPDATE') || definition.includes('UPDATE OR DELETE')))
  assert.equal([...canonicalTriggerDefinitions.values()].every(definition => definition.includes('FOR EACH ')), true)
  assert.match(formatFinalizerFailureDiagnostic({ phase: 'verify-installed', reason: 'trigger_definition_mismatch', sqlstate: null,
    triggerDetails: { expectedCount: 80, observedCount: 80, expectedIndex: 0, matchingCount: 1,
      relationSchemaMatch: true, enabledMatch: true, functionNameMatch: true, functionSchemaMatch: true,
      functionIdentityMatch: true, eventMask: 62, expectedEventMask: 62, attributeCount: 0,
      attributeTypeMatch: true, attributeTextShapeMatch: true, argumentCount: 0, argumentBytes: 0,
      noCondition: true, definitionExact: false, definitionNormalized: false } }),
  /event_mask=62 expected_event_mask=62[\s\S]*definition_exact=no definition_normalized=no/u)
  assert.equal(NEWS_MUTATION_TABLES.length, 39)
  assert.equal(buildNewsMutationTriggersDDL().includes('BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE'), true)
  assert.equal(buildNewsMutationTriggersDDL().includes('AFTER INSERT OR UPDATE OR DELETE'), true)
  assert.equal(orderMismatches.length, 79)
  assert.equal(orderMismatches.length < canonicalTriggerDefinitions.size, true)
  assert.equal(orderMismatches.find(([, definition]) => definition.includes('BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE'))?.[1]
    .includes('BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE'), true)
  assert.equal(orderMismatches.some(([, definition]) => definition.includes('BEFORE INSERT OR UPDATE ON public.news_migration_items')), false)
  assert.equal(orderMismatches.some(([, definition]) => definition.includes('BEFORE UPDATE OR DELETE ON public.news_migration_runs')), true)
  assert.equal(orderMismatches.every(([, definition]) => !definition.includes('WHEN')), true)
  assert.equal(orderMismatches.length, 39 * 2 + 1)
  assert.equal(orderMismatches.map(([key]) => key).includes('news_migration_runs.owner_news_migration_run_binding_guard'), true)
  assert.equal(orderMismatches.map(([key]) => key).includes('news_migration_items.owner_news_migration_item_binding_guard'), false)
  assert.equal(orderMismatches.some(([, definition]) => definition.includes('TRUNCATE') && !definition.includes('DELETE')), false)
  assert.equal(orderMismatches.some(([, definition]) => definition.includes('INSERT OR UPDATE OR DELETE')), true)
  assert.equal(orderMismatches.some(([, definition]) => definition.includes('UPDATE OR DELETE')), true)
  assert.equal(orderMismatches.some(([, definition]) => definition.includes('INSERT OR UPDATE ON')), false)
  assert.equal(orderMismatches.length + 1, canonicalTriggerDefinitions.size)
  assert.equal(orderMismatches.some(([key]) => key.endsWith('owner_news_mutation_capture_row')), true)
  assert.equal(orderMismatches.some(([key]) => key.endsWith('owner_news_mutation_guard_stmt')), true)
  assert.equal(orderMismatches.some(([key]) => key.endsWith('owner_news_migration_run_binding_guard')), true)
  assert.equal([...canonicalTriggerDefinitions.values()].filter(definition =>
    renderPg16TriggerDefinitionFromSource(definition) !== definition).length, 79)
  assert.equal([...canonicalTriggerDefinitions.values()].every(definition =>
    renderPg16TriggerDefinitionFromSource(renderPg16TriggerDefinitionFromSource(definition))
      === renderPg16TriggerDefinitionFromSource(definition)), true)
  const unqualifiedFunctionRendering = [...canonicalTriggerDefinitions.values()]
    .map(definition => renderPg16TriggerDefinitionFromSource(definition, true))
  assert.equal(unqualifiedFunctionRendering.length, 80)
  assert.equal(unqualifiedFunctionRendering.every(definition => /EXECUTE FUNCTION owner_news_[a-z_]+\(\)$/u.test(definition)), true)
})

test('all 80 qualified and unqualified PostgreSQL function renderings pass only with verified catalog identity', async () => {
  const qualified = fakeClient({ existing: true })
  const qualifiedResult = await finalizeNewsProtocol(qualified.client)
  assert.deepEqual(qualifiedResult, { installed: false, ready: false, coverageVersion: 0 })

  const unqualified = fakeClient({ existing: true, unqualifiedTriggerFunctions: true })
  const unqualifiedResult = await finalizeNewsProtocol(unqualified.client)
  assert.deepEqual(unqualifiedResult, { installed: false, ready: false, coverageVersion: 0 })
  assert.equal(canonicalTriggerDefinitions.size * 2, 160)

  const shadowed = fakeClient({ existing: true, unqualifiedTriggerFunctions: true,
    invalidTrigger: 'unqualified-wrong-function-identity' })
  const shadowedError = await finalizeNewsProtocol(shadowed.client).catch(value => value)
  assert.equal(getFinalizerFailureDiagnostic(shadowedError)?.reason, 'trigger_function_identity_mismatch')
})

test('trigger definition comparison permits lowercase identifier quotes but preserves SQL case and literals', async () => {
  const quoted = fakeClient({ existing: true, quotedTriggerIdentifiers: true })
  assert.deepEqual(await finalizeNewsProtocol(quoted.client), { installed: false, ready: false, coverageVersion: 0 })

  const caseChanged = fakeClient({ existing: true, invalidTrigger: 'definition-case' })
  const caseError = await finalizeNewsProtocol(caseChanged.client).catch(value => value)
  assert.equal(getFinalizerFailureDiagnostic(caseError)?.reason, 'trigger_definition_mismatch')

  const literalChanged = fakeClient({ existing: true, invalidTrigger: 'definition-when-literal' })
  const literalError = await finalizeNewsProtocol(literalChanged.client).catch(value => value)
  const literalDiagnostic = getFinalizerFailureDiagnostic(literalError)
  assert.equal(literalDiagnostic?.reason, 'trigger_condition_mismatch')
  assert.equal(literalDiagnostic?.triggerDetails?.definitionNormalized, false)
  assert.equal(formatFinalizerFailureDiagnostic(literalDiagnostic!).includes('INSERT OR DELETE'), false)
})

test('trigger normalizer changes whitespace only in recognized trigger headers and refuses literal grammar', () => {
  const canonical = 'CREATE TRIGGER owner_news_mutation_guard_stmt BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.news_articles FOR EACH STATEMENT EXECUTE FUNCTION public.owner_news_mutation_guard_stmt()'
  const quotedAndSpaced = 'CREATE   TRIGGER  "owner_news_mutation_guard_stmt"  BEFORE\n INSERT OR DELETE OR UPDATE OR TRUNCATE ON "public"."news_articles" FOR EACH\tSTATEMENT EXECUTE FUNCTION "public"."owner_news_mutation_guard_stmt" ( ) '
  assert.equal(normalizeTriggerDefinition(quotedAndSpaced), canonical)

  const unqualifiedCall = canonical.replace('EXECUTE FUNCTION public.owner_news_mutation_guard_stmt()',
    'EXECUTE FUNCTION owner_news_mutation_guard_stmt()')
  assert.equal(normalizeTriggerDefinition(unqualifiedCall), unqualifiedCall)
  assert.notEqual(normalizeTriggerDefinition(unqualifiedCall), normalizeTriggerDefinition(canonical))
  const wrongFunctionSchema = canonical.replace('EXECUTE FUNCTION public.owner_news_mutation_guard_stmt()',
    'EXECUTE FUNCTION private.owner_news_mutation_guard_stmt()')
  assert.equal(normalizeTriggerDefinition(wrongFunctionSchema), wrongFunctionSchema)
  const unqualifiedRelation = canonical.replace('ON public.news_articles', 'ON news_articles')
  assert.equal(normalizeTriggerDefinition(unqualifiedRelation), unqualifiedRelation)

  const literalDoubleSpace = `${canonical} WHEN (NEW.title = 'a  b')`
  const literalSingleSpace = `${canonical} WHEN (NEW.title = 'a b')`
  assert.equal(normalizeTriggerDefinition(literalDoubleSpace), literalDoubleSpace)
  assert.equal(normalizeTriggerDefinition(literalSingleSpace), literalSingleSpace)
  assert.notEqual(normalizeTriggerDefinition(literalDoubleSpace), normalizeTriggerDefinition(literalSingleSpace))

  const doubledApostrophe = `${canonical} WHEN (NEW.title = 'a''  b')`
  const alteredDoubledApostrophe = `${canonical} WHEN (NEW.title = 'a'' b')`
  assert.equal(normalizeTriggerDefinition(doubledApostrophe), doubledApostrophe)
  assert.notEqual(normalizeTriggerDefinition(doubledApostrophe), normalizeTriggerDefinition(alteredDoubledApostrophe))

  const literalOrIdentifierLike = `${canonical} WHEN (NEW.title = 'OR INSERT "news_articles"')`
  assert.equal(normalizeTriggerDefinition(literalOrIdentifierLike), literalOrIdentifierLike)
  const malformedQuote = `${canonical} WHEN (NEW.title = 'unterminated  value)`
  assert.equal(normalizeTriggerDefinition(malformedQuote), malformedQuote)
  assert.equal(normalizeTriggerDefinition(canonical.replace('BEFORE', 'before')),
    canonical.replace('BEFORE', 'before'))
})

test('direct cms_controller EXECUTE on an unrelated public function is rejected', async () => {
  const { client, statements } = fakeClient({ existing: true, extraControllerGrant: true })
  await assert.rejects(finalizeNewsProtocol(client), /public_function_execute_outside_allowlist/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
})

test('direct cms_controller EXECUTE on a same-name wrong overload is rejected by identity', async () => {
  const { client, statements } = fakeClient({ existing: true, controllerWrongOverload: true })
  await assert.rejects(finalizeNewsProtocol(client), /public_function_execute_outside_allowlist/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
})

test('fifth public function with default PUBLIC EXECUTE is rejected', async () => {
  const { client, statements } = fakeClient({ existing: true, publicDefaultFunction: true })
  await assert.rejects(finalizeNewsProtocol(client), /public_function_execute_outside_allowlist/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
})

test('exact pgcrypto gen_random_uuid native baseline with default PUBLIC EXECUTE remains permitted', async () => {
  const { client } = fakeClient({ existing: true, nativePgcryptoBaseline: true })
  const result = await finalizeNewsProtocol(client)
  assert.deepEqual(result, { installed: false, ready: false, coverageVersion: 0 })
})

for (const options of [{ pgcryptoSecurityDefiner: true }, { pgcryptoNonUuidReturn: true }]) {
  test(`pgcrypto PUBLIC baseline rejects unsafe function properties (${Object.keys(options)[0]})`, async () => {
    const { client, statements } = fakeClient({ existing: true, nativePgcryptoBaseline: true, ...options })
    await assert.rejects(finalizeNewsProtocol(client), /public_function_execute_outside_allowlist/u)
    assert.equal(statements.includes('COMMIT'), false)
    assert.equal(statements.at(-1), 'ROLLBACK')
  })
}

test('wrong canonical protocol signature fails exact function identity verification', async () => {
  const { client, statements } = fakeClient({ existing: true, wrongProtocolSignature: true })
  await assert.rejects(finalizeNewsProtocol(client), /canonical_function_mismatch/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
})

for (const mutation of ['leading-space', 'trailing-space', 'interior-space', 'string-literal'] as const) {
  test(`canonical function verification rejects ${mutation} source tampering without whitespace normalization`, async () => {
    const { client, statements } = fakeClient({ existing: true,
      tamperFunctionSource: { name: 'owner_news_mutation_guard_stmt', mutation } })
    await assert.rejects(finalizeNewsProtocol(client), /canonical_function_mismatch/u)
    assert.equal(statements.some(sql => sql === ledgerHeadDDL), false)
    assert.equal(statements.some(sql => sql.includes('CREATE TABLE public.owner_news_mutation_head')), false)
    assert.equal(statements.at(-1), 'ROLLBACK')
  })
}

test('cms_controller ownership of any extra database object blocks re-entry without DDL', async () => {
  const { client, statements } = fakeClient({ existing: true, extraControllerOwnership: true })
  await assert.rejects(finalizeNewsProtocol(client), /unexpected_control_owned_objects/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.some(sql => sql.includes('CREATE TABLE public.owner_news_mutation_head')), false)
})

test('cms_controller ownership in an unrelated database does not fail current-database re-entry', async () => {
  const { client, statements } = fakeClient({ existing: true, unrelatedDatabaseOwnership: true })
  const result = await finalizeNewsProtocol(client)
  assert.deepEqual(result, { installed: false, ready: false, coverageVersion: 0 })
  const ownershipQuery = statements.find(sql => sql.includes('AS unexpected_control_objects'))
  assert.ok(ownershipQuery?.includes('d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database())'))
})

for (const options of [{ sharedControlOwnership: true }, { sharedControllerOwnership: true }]) {
  test(`shared database/tablespace ownership by ${Object.keys(options)[0]} role fails closed`, async () => {
    const { client, statements } = fakeClient({ existing: true, ...options })
    await assert.rejects(finalizeNewsProtocol(client), /unexpected_control_owned_objects/u)
    assert.equal(statements.at(-1), 'ROLLBACK')
    const ownershipQuery = statements.find(sql => sql.includes('AS unexpected_control_objects'))
    assert.ok(ownershipQuery?.includes('WHERE d.dbid=0'))
  })
}

test('same-name cms_control function ownership outside approved schema/signature blocks re-entry', async () => {
  const { client, statements } = fakeClient({ existing: true, extraControlWrongNamespaceOwnership: true })
  await assert.rejects(finalizeNewsProtocol(client), /unexpected_control_owned_objects/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
})

test('foreign-schema homonymous enum type blocks before protocol work', async () => {
  const { client, statements } = fakeClient({ foreignEnumSchema: true })
  await assert.rejects(finalizeNewsProtocol(client), /native_column_inventory_mismatch|native_enum_catalog_mismatch/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
})

test('enum labels/order and public array element binding must match snapshot', async () => {
  for (const options of [{ changedEnumLabels: true }, { invalidEnumArray: true }]) {
    const { client, statements } = fakeClient(options)
    await assert.rejects(finalizeNewsProtocol(client), /native_enum_catalog_mismatch/u)
    assert.equal(statements.at(-1), 'ROLLBACK')
  }
})

for (const serialDrift of ['unowned', 'wrong-column', 'increment', 'cycle', 'range', 'owner', 'schema', 'name-collision'] as const) {
  test(`native serial sequence contract rejects ${serialDrift} drift`, async () => {
    const { client, statements } = fakeClient({ serialDrift })
    await assert.rejects(finalizeNewsProtocol(client), /native_serial_sequence_binding_or_configuration_mismatch/u)
    assert.equal(statements.at(-1), 'ROLLBACK')
    assert.equal(statements.some(sql => sql.includes('CREATE TABLE public.owner_news_mutation_head')), false)
  })
}

test('advanced native serial current value is not read or reset by finalization', async () => {
  const { client, statements } = fakeClient()
  const result = await finalizeNewsProtocol(client)
  assert.equal(result.ready, false)
  assert.equal(statements.some(sql => /last_value|is_called|setval\s*\(/iu.test(sql)), false)
})

test('partial pre-existing protocol is rejected for manual recovery, never reset', async () => {
  const { client, statements } = fakeClient({ partial: true })
  await assert.rejects(finalizeNewsProtocol(client), /partial_protocol_installation_manual_recovery_required/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.equal(statements.some(sql => NEWS_MUTATION_LEDGER_STATEMENTS.some(statement => statement.sql === sql)), false)
  assert.equal(statements.some(sql => /^(?:CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE)\b/u.test(sql.trim())), false)
  assert.equal(statements.some(sql => sql.includes('DROP TABLE') || sql.includes('DELETE FROM')), false)
})

for (const headRows of ['empty', 'multiple', 'invalid'] as const) {
  test(`complete protocol inventory with ${headRows} head rows fails closed without reinstall`, async () => {
    const { client, statements } = fakeClient({ existing: true, headRows })
    await assert.rejects(finalizeNewsProtocol(client), /ledger_head_invalid_or_coverage_activated/u)
    assert.equal(statements.some(sql => sql === ledgerHeadDDL), false)
    assert.equal(statements.some(sql => sql.includes('CREATE TABLE public.owner_news_mutation_head')), false)
    assert.equal(statements.at(-1), 'ROLLBACK')
  })
}

test('complete installation re-entry verifies in place and preserves existing head/events', async () => {
  const { client, statements } = fakeClient({ existing: true })
  const result = await finalizeNewsProtocol(client)
  assert.deepEqual(result, { installed: false, ready: false, coverageVersion: 0 })
  assert.equal(statements.some(sql => NEWS_MUTATION_LEDGER_STATEMENTS.some(statement => statement.sql === sql)), false)
  assert.equal(statements.some(sql => /^(?:CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE)\b/u.test(sql.trim())), false)
  assert.equal(statements.some(sql => /CREATE TABLE public\.owner_news_mutation_head|INSERT INTO public\.owner_news_mutation_head|DROP TABLE|DELETE FROM public\.owner_news_mutation_events/u.test(sql)), false)
  assert.equal(statements.filter(sql => sql.includes('SELECT sequence::text AS sequence')).length, 1)
  assert.equal(statements.at(-1), 'COMMIT')
})

test('column-only cms_control DML privilege outside the allowlist rolls back', async () => {
  const { client, statements } = fakeClient({ extraColumnGrant: true })
  await assert.rejects(finalizeNewsProtocol(client), /control_role_column_acl_mismatch/u)
  assert.equal(statements.at(-1), 'ROLLBACK')
})

test('admin URL is explicit and validated even with an injected client; no test target override exists', async () => {
  let connected = false
  const client: FinalizerClient = { connect: async () => { connected = true }, end: async () => {}, query: async () => ({ rows: [] }) }
  await assert.rejects(runFinalizer({}, client), /admin_database_url_required/u)
  await assert.rejects(runFinalizer({ CMS_ADMIN_DATABASE_URL: 'postgres://cms_admin:secret@127.0.0.1/other' }, client), /unsafe_admin_database_url/u)
  assert.equal(connected, false)
})

const adminEnvironment = { CMS_ADMIN_DATABASE_URL: 'postgresql://cms_admin:test-only-secret@127.0.0.1:5432/ownerinc_cms' }

test('successful finalizer result survives client.end failure and reports a sanitized nonfatal warning', async () => {
  const { client, statements } = fakeClient()
  let closeCount = 0
  client.end = async () => {
    closeCount += 1
    throw Object.assign(new Error('close exception contains private text'), { code: '08003' })
  }
  const warnings: { phase: 'admin-disconnect'; sqlstate: string | null }[] = []
  const result = await runFinalizer(adminEnvironment, client, warning => warnings.push(warning))
  assert.deepEqual(result, { installed: true, ready: false, coverageVersion: 0 })
  assert.equal(closeCount, 1)
  assert.equal(statements.filter(sql => sql === 'COMMIT').length, 1)
  assert.equal(statements.includes('ROLLBACK'), false)
  assert.deepEqual(warnings, [{ phase: 'admin-disconnect', sqlstate: '08003' }])
  assert.equal(formatFinalizerCloseDiagnostic(warnings[0]!),
    'CMS news protocol client close warning: phase=admin-disconnect sqlstate=08003')
})

test('successful close preserves the normal installed result without a warning', async () => {
  const { client, statements } = fakeClient()
  let closeCount = 0
  client.end = async () => { closeCount += 1 }
  const warnings: unknown[] = []
  assert.deepEqual(await runFinalizer(adminEnvironment, client, warning => warnings.push(warning)),
    { installed: true, ready: false, coverageVersion: 0 })
  assert.equal(closeCount, 1)
  assert.deepEqual(warnings, [])
  assert.equal(statements.at(-1), 'COMMIT')
})

test('connect failure remains primary when close also fails', async () => {
  const primary = Object.assign(new Error('primary connect text must stay private'), { code: '08006' })
  const client: FinalizerClient = {
    connect: async () => { throw primary },
    end: async () => { throw Object.assign(new Error('secondary close text must stay private'), { code: '08003' }) },
    query: async () => ({ rows: [] }),
  }
  let closeCount = 0
  const originalEnd = client.end
  client.end = async () => { closeCount += 1; await originalEnd() }
  const warnings: unknown[] = []
  const error = await runFinalizer(adminEnvironment, client, warning => warnings.push(warning)).catch(value => value)
  assert.equal(error, primary)
  assert.deepEqual(getFinalizerFailureDiagnostic(error), { phase: 'admin-connect', reason: 'database_error', sqlstate: '08006' })
  assert.deepEqual(getFinalizerCloseDiagnostic(error), { phase: 'admin-disconnect', sqlstate: '08003' })
  assert.deepEqual(warnings, [{ phase: 'admin-disconnect', sqlstate: '08003' }])
  assert.equal(closeCount, 1)
})

for (const failurePhase of ['precondition', 'ddl', 'commit'] as const) {
  test(`${failurePhase} error and diagnostic survive a secondary client.end failure`, async () => {
    const options = failurePhase === 'precondition' ? { badNativeDefault: true } : {}
    const { client, statements } = fakeClient(options)
    let expectedPrimary: Error | undefined
    const query = client.query.bind(client)
    client.query = async (sql, values) => {
      if (failurePhase === 'ddl' && sql === buildNewsMutationTriggersDDL()) {
        expectedPrimary = Object.assign(new Error('primary DDL text must stay private'), { code: '42501' })
        throw expectedPrimary
      }
      if (failurePhase === 'commit' && sql === 'COMMIT') {
        expectedPrimary = Object.assign(new Error('primary commit text must stay private'), { code: '40001' })
        throw expectedPrimary
      }
      return query(sql, values)
    }
    client.end = async () => { throw Object.assign(new Error('secondary close text must stay private'), { code: '08003' }) }
    const warnings: unknown[] = []
    const error = await runFinalizer(adminEnvironment, client, warning => warnings.push(warning)).catch(value => value)
    if (expectedPrimary) assert.equal(error, expectedPrimary)
    const diagnostic = getFinalizerFailureDiagnostic(error)
    assert.ok(diagnostic)
    assert.deepEqual(diagnostic, failurePhase === 'precondition'
      ? { phase: 'precondition-columns', reason: 'native_column_inventory_mismatch', sqlstate: null }
      : failurePhase === 'ddl'
        ? { phase: 'protocol-trigger-ddl', reason: 'database_error', sqlstate: '42501' }
        : { phase: 'transaction-commit', reason: 'database_error', sqlstate: '40001' })
    assert.deepEqual(getFinalizerCloseDiagnostic(error), { phase: 'admin-disconnect', sqlstate: '08003' })
    assert.deepEqual(warnings, [{ phase: 'admin-disconnect', sqlstate: '08003' }])
    assert.equal(formatFinalizerFailureDiagnostic(diagnostic!).includes('private'), false)
    assert.equal(statements.includes('COMMIT'), false)
    assert.equal(statements.at(-1), 'ROLLBACK')
  })
}
