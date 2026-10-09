import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import test from 'node:test'
import {
  assertPreauthorityNativeCatalogInventory,
  formatPreauthorityCatalogFailureDiagnostic,
  formatPreauthorityNativeConstraintMismatchDiagnostic,
  getPreauthorityCatalogFailureDiagnostic,
  NATIVE_ENUM_CATALOG_SQL,
  NATIVE_FOREIGN_KEYS_CATALOG_SQL,
  nativeSchemaSnapshot,
  preauthorityExpectedNativeCatalogInventory,
  verifyPreauthorityCatalogReadOnly,
  verifyPreauthorityNativeCatalog,
  type FinalizerClient,
  type PreauthorityCatalogDiagnosticStage,
} from '../../scripts/finalize-news-protocol'
import { NEWS_MUTATION_TABLES } from '../../src/publication/mutation-ledger'
import {
  controlRolesNativePrivilegesVerificationSQL,
  controlRolesOwnershipVerificationSQL,
  controlRolesVerificationSQL,
} from '../../scripts/provision-db'
import { assertPreauthorityCatalogState } from '../../scripts/verify-preauthority-catalog'
import { nativeChecksPg16 } from '../fixtures/native-checks-pg16'
import { nativeTypeLabelsPg16Oid, nativeTypesPg16 } from '../fixtures/native-types-pg16'

const { types: pgTypes } = createRequire(import.meta.url)('pg') as {
  types: { getTypeParser(oid: number): (value: string) => unknown }
}

const fixtureMigrations = [
  '20261002_181423_owner_news_initial', '20261005_133515_owner_news_media',
  '20261005_151541_owner_news_publication', '20261005_220916_owner_news_legacy_history',
  '20261006_181325_a_owner_news_suspend_enum', '20261006_181424_z_owner_news_native',
]

function captureVerifierError(action: () => unknown): Error {
  try {
    action()
  } catch (error) {
    assert.ok(error instanceof Error)
    return error
  }
  assert.fail('expected preauthority verifier rejection')
}

test('all 24 PostgreSQL-rendered native CHECKs pass without accepting same-name weakened predicates', () => {
  const inventory = preauthorityExpectedNativeCatalogInventory()
  const checks = inventory.constraints.filter(item => item.kind === 'c')
  assert.equal(checks.length, 24)
  assert.deepEqual(checks.map(item => item.name).sort(), Object.keys(nativeChecksPg16).sort())
  const metadata = checks.find(item => item.name === 'legacy_news_revisions_metadata_basis_check')!
  assert.equal(createHash('sha256').update(metadata.definition).digest('hex'),
    '3b02b2c21f6acfcacde15c19870890242f4ecd6f156edc3e249d39387e10ecee')
  assert.equal(createHash('sha256').update(nativeChecksPg16[metadata.name]!).digest('hex'),
    'd745997d2ddc6747dcdaf1d922d92b00366775f74f38caad50e48620dc5239f4')
  for (const check of checks) check.definition = nativeChecksPg16[check.name]!
  assert.doesNotThrow(() => assertPreauthorityNativeCatalogInventory(inventory, fixtureMigrations))
  for (const check of checks) {
    const definition = check.definition
    for (const weakened of ['CHECK (true)', `CHECK ((${definition.slice(7, -1)}) OR true)`]) {
      check.definition = weakened
      const error = captureVerifierError(() => assertPreauthorityNativeCatalogInventory(inventory, fixtureMigrations))
      assert.equal(getPreauthorityCatalogFailureDiagnostic(error, 'native_constraints').constraintMismatch?.category,
        'check_definition', check.name)
    }
    check.definition = definition
  }
})

test('native CHECK normalization preserves JSONB values, bounds, casts, branches and regex semantics', () => {
  const metadataName = 'legacy_news_revisions_metadata_basis_check'
  const mutations: [string, string, string][] = [
    [metadataName, '"unknown"', '"known"'],
    [metadataName, '"category": "document_snapshot", ', ''],
    [metadataName, '"title": "document_snapshot"', '"title": "document_snapshot", "extra": "value"'],
    [metadataName, '"title": "document_snapshot"', '"title": "document_snapshot", "title": "document_snapshot"'],
    [metadataName, '"title": "document_snapshot"', '"title": 9007199254740993'],
    [metadataName, '::jsonb', '::json'],
    [metadataName, '::jsonb', '::private.jsonb'],
    [metadataName, 'original_published_at IS NULL', 'original_published_at IS NOT NULL'],
    ['news_migration_runs_source_instance_check', '<= 128', '<= 129'],
    ['news_migration_runs_source_instance_check', '>= 1', '> 1'],
    ['news_migration_runs_source_instance_check', ' AND ', ' OR '],
    ['news_migration_runs_reconciliation_sequence_check', '9223372036854775807', '9223372036854775808'],
    ['news_migration_runs_reconciliation_sequence_check', '9223372036854775807', '9223372036854775806'],
    ['news_migration_runs_reconciliation_sequence_check', '::bigint', '::integer'],
    ['news_migration_runs_reconciliation_sequence_check', '::bigint', '::public.bigint'],
    ['news_migration_runs_reconciliation_sequence_check', '(reconciliation_sequence)::numeric', '(reconciliation_sequence)::bigint'],
    ['news_migration_runs_reconciliation_sequence_check', 'ELSE false', 'ELSE true'],
    ['news_schedules_import_provenance_shape_check', 'NOT (original_actor_evidence IS DISTINCT', '(original_actor_evidence IS DISTINCT'],
    ['news_schedules_import_provenance_shape_check', '(.[0-9]{1,6})', '(\\.[0-9]{1,6})'],
    ['news_migration_items_source_identity_check', '(.[0-9]{1,6})', '(\\.[0-9]{1,6})'],
  ]
  for (const [name, before, after] of mutations) {
    const inventory = preauthorityExpectedNativeCatalogInventory()
    const check = inventory.constraints.find(item => item.name === name)!
    check.definition = nativeChecksPg16[name]!.replace(before, after)
    assert.notEqual(check.definition, nativeChecksPg16[name], `${name}: mutation must apply`)
    assert.throws(() => assertPreauthorityNativeCatalogInventory(inventory, fixtureMigrations),
      /preauthority_native_constraint_inventory_mismatch/u, `${name}: ${before} -> ${after}`)
  }
  const inventory = preauthorityExpectedNativeCatalogInventory()
  const check = inventory.constraints.find(item => item.name === metadataName)!
  check.definition = nativeChecksPg16[metadataName]!.replaceAll(
    '"title": "document_snapshot", "category": "document_snapshot"',
    '"category":"document_snapshot", "title":"document_snapshot"')
  assert.doesNotThrow(() => assertPreauthorityNativeCatalogInventory(inventory, fixtureMigrations),
    'only JSONB object key order and insignificant JSON whitespace change')
})

function preconditionClient({ failedControlCheck, protocolPresent, roleFixture = 'preauthority' }: {
  failedControlCheck?: 'ownership' | 'native-privileges'
  protocolPresent?: boolean
  roleFixture?: 'preauthority' | 'finalizer-installed' | 'missing-control' | 'missing-controller' | 'insecure-control' | 'insecure-controller'
} = {}): { client: FinalizerClient; statements: string[] } {
  const statements: string[] = []
  const expected = preauthorityExpectedNativeCatalogInventory()
  const postgresTypes: Record<string, string> = {
    varchar: 'varchar', integer: 'int4', serial: 'int4', boolean: 'bool',
    'timestamp(3) with time zone': 'timestamptz',
  }
  const catalogDefault = (table: string, column: { type: string; name: string; default?: string | number | boolean }) => {
    if (column.type === 'serial') return `nextval('${table}_${column.name}_seq'::regclass)`
    if (column.default === undefined) return null
    const value = String(column.default)
    if (['gen_random_uuid()', 'now()', 'false', 'true'].includes(value) || value.endsWith('::jsonb')) return value
    if (/^(?:0|[1-9][0-9]*)$/u.test(value)) return column.type === 'numeric' ? `${value}::numeric` : value
    if (/^'(?:''|[^'])*'$/u.test(value)) {
      const type = column.type.startsWith('enum_') ? column.type : column.type === 'varchar' ? 'character varying' : column.type
      return `${value}::${type}`
    }
    return value
  }
  const client: FinalizerClient = {
    connect: async () => {},
    end: async () => {},
    query: async (sql, values) => {
      statements.push(sql)
      if (sql.includes('current_user AS role')) {
        return { rows: [{ role: 'cms_admin', db: 'ownerinc_cms', superuser: true, read_only: 'on' }] }
      }
      if (sql === 'SELECT name FROM public.payload_migrations ORDER BY name') {
        return { rows: fixtureMigrations.map(name => ({ name })) }
      }
      if (sql.includes('SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind')) {
        return { rows: expected.relations.map(relation => ({ ...relation })) }
      }
      if (sql.includes('SELECT namespace.nspname AS schema, relation.relname AS table_name')) {
        if (sql.includes('attribute.attname AS column_name')) {
          return { rows: expected.columns.map(column => ({
            schema: column.schema, table_name: column.table, column_name: column.name,
            type_name: column.type, type_schema: column.typeSchema, not_null: column.notNull,
            default_expression: catalogDefault(column.table,
              nativeSchemaSnapshot.tables[`public.${column.table}`]!.columns[column.name]!),
          })) }
        }
        if (sql.includes('con.conname AS constraint_name')) {
          return { rows: expected.constraints.map(constraint => ({
            schema: constraint.schema, table_name: constraint.table, constraint_name: constraint.name,
            kind: constraint.kind, validated: constraint.validated, deferrable: constraint.deferrable,
            deferred: constraint.deferred, definition: constraint.definition,
          })) }
        }
      }
      if (sql.includes('SELECT table_ns.nspname AS table_schema')) {
        return { rows: expected.indexes.map(index => ({
          table_schema: index.tableSchema, table_name: index.table, index_schema: index.schema,
          index_name: index.name, is_unique: index.unique, is_primary: index.primary,
          is_valid: index.valid, is_ready: index.ready, no_predicate: index.noPredicate,
          no_expressions: index.noExpressions, key_count: index.keyCount,
          attribute_count: index.attributeCount, method: index.method, columns: index.columns,
          definition: index.definition,
        })) }
      }
      if (sql.includes('SELECT namespace.nspname AS schema, type.typname AS name')) {
        return { rows: expected.types.map(type => ({ ...type })) }
      }
      if (sql.includes('SELECT c.relname AS name, c.relkind AS kind')) {
        return { rows: Object.keys(nativeSchemaSnapshot.tables).map(name => ({
          name: name.replace(/^public\./u, ''), kind: 'r',
        })) }
      }
      if (sql.includes('SELECT c.relname AS table_name, a.attname AS column_name, t.typname AS type')) {
        return { rows: Object.entries(nativeSchemaSnapshot.tables).flatMap(([table, schema]) =>
          Object.values(schema.columns).map(column => ({
            table_name: table.replace(/^public\./u, ''), column_name: column.name,
            type: postgresTypes[column.type] ?? column.type,
            type_schema: column.type.startsWith('enum_') ? 'public' : 'pg_catalog',
            not_null: column.notNull, default_expr: catalogDefault(table.replace(/^public\./u, ''), column),
          }))) }
      }
      if (sql === 'SELECT $1::jsonb = $2::jsonb AS matches') return { rows: [{ matches: true }] }
      if (sql.includes('FROM unnest($1::text[],$2::text[],$3::text[]) AS expected')) {
        const [tables, columns, sequences] = values as [string[], string[], string[]]
        return { rows: tables.map((table, index) => ({
          table_name: table, column_name: columns[index], sequence_name: sequences[index],
          sequence_present: true, sequence_schema: 'public', sequence_kind: 'S', sequence_persistence: 'p',
          sequence_owner: 'cms_migrator', integer_sequence: true, start_value: '1', increment_value: '1',
          minimum_value: '1', maximum_value: '2147483647', cache_value: '1', cycles: false,
          ownership_dependency: 'a', owned_table_schema: 'public', owned_table: table,
          owned_column: columns[index], table_owner: 'cms_migrator',
        })) }
      }
      if (sql === NATIVE_ENUM_CATALOG_SQL) {
        return { rows: Object.values(nativeSchemaSnapshot.enums).map(value => ({
          name: value.name, schema: value.schema, labels: [...value.values], array_binding_valid: true,
        })) }
      }
      if (sql.includes('SELECT conname AS name FROM pg_constraint')) {
        return { rows: expected.constraints.filter(constraint => constraint.kind === 'c').map(({ name }) => ({ name })) }
      }
      if (sql.includes('SELECT t.relname AS table_name, i.relname AS index_name')) {
        return { rows: Object.values(nativeSchemaSnapshot.tables).flatMap(table =>
          Object.values(table.indexes).map(index => ({
            table_name: table.name, index_name: index.name, is_unique: Boolean(index.isUnique), method: index.method,
          }))) }
      }
      if (sql === NATIVE_FOREIGN_KEYS_CATALOG_SQL) {
        const actionCodes: Record<string, string> = {
          'no action': 'a', restrict: 'r', cascade: 'c', 'set null': 'n', 'set default': 'd',
        }
        return { rows: Object.values(nativeSchemaSnapshot.tables).flatMap(table =>
          Object.values(table.foreignKeys).map(key => ({
            name: key.name, table_from: key.tableFrom, table_to: key.tableTo,
            columns_from: [...key.columnsFrom], columns_to: [...key.columnsTo],
            delete_code: actionCodes[key.onDelete.toLowerCase()], update_code: actionCodes[key.onUpdate.toLowerCase()],
          }))) }
      }
      if (sql.includes("a.attrelid='public.news_migration_runs'")) {
        return { rows: [
          ['reconciliation_sequence', 'varchar'], ['reconciliation_chain_sha256', 'varchar'],
          ['reconciliation_sha256', 'varchar'], ['destination_fingerprint', 'varchar'],
          ['unresolved_exceptions', 'jsonb'], ['sealed_sequence', 'varchar'], ['sealed_chain_sha256', 'varchar'],
          ['sealed_at', 'timestamptz'], ['activation_epoch', 'numeric'], ['drain_receipt_sha256', 'varchar'],
        ].map(([name, type]) => ({ name, type })) }
      }
      if (sql.includes("a.attrelid='public.news_migration_items'")) return { rows: [{ run_id_type: 'varchar' }] }
      if (sql === controlRolesVerificationSQL) {
        return { rows: [{ safe: roleFixture === 'preauthority' || roleFixture === 'finalizer-installed' }] }
      }
      if (sql.includes('AS ledger_relations')) {
        return { rows: [protocolPresent ? {
          ledger_relations: 2, protocol_functions: 4, unexpected_protocol_functions: 0,
          v1_signatures: 4, bootstrap_signature: false,
          protocol_triggers: NEWS_MUTATION_TABLES.length * 2 + 2,
          inventory_triggers: NEWS_MUTATION_TABLES.length * 2 + 2,
        } : {
          ledger_relations: 0, protocol_functions: 0, unexpected_protocol_functions: 0,
          v1_signatures: 0, bootstrap_signature: false, protocol_triggers: 0, inventory_triggers: 0,
        }] }
      }
      if (sql === controlRolesOwnershipVerificationSQL) return { rows: [{ safe: failedControlCheck !== 'ownership' }] }
      if (sql === controlRolesNativePrivilegesVerificationSQL) {
        return { rows: [{ safe: failedControlCheck !== 'native-privileges' }] }
      }
      throw new Error('Unexpected preauthority fixture query')
    },
  }
  return { client, statements }
}

test('native type query requests text[] and accepts captured PG16 catalog through the actual pg decoder', async () => {
  const fixture = preconditionClient()
  const stages: PreauthorityCatalogDiagnosticStage[] = []
  let reachedTypes = false
  const client: FinalizerClient = {
    ...fixture.client,
    query: async (sql, values) => {
      if (!sql.includes('type.typtype AS kind')) return fixture.client.query(sql, values)
      reachedTypes = true
      assert.match(sql, /array_agg\(enum\.enumlabel::text ORDER BY enum\.enumsortorder\)/u)
      assert.match(sql, /ARRAY\[\]::text\[\]/u)
      assert.doesNotMatch(sql, /ARRAY\[\]::name\[\]/u)
      // Automatic arrays require the reciprocal pg_type binding AND internal
      // dependency. Never discard a standalone composite or unknown base type.
      assert.match(sql, /composite_relation\.relkind IN \('r','p','v','m','f'\)/u)
      assert.match(sql, /composite_relation\.reltype=type\.oid/u)
      assert.match(sql, /type\.typelem=element\.oid AND element\.typarray=type\.oid/u)
      assert.match(sql, /dependency\.deptype='i'/u)
      assert.doesNotMatch(sql, /type\.typtype IN \(/u)
      const rows = nativeTypesPg16.map(row => ({
        ...row, labels: pgTypes.getTypeParser(nativeTypeLabelsPg16Oid)(row.labels),
      }))
      assert.equal(rows.length, 61)
      assert.deepEqual(rows, preauthorityExpectedNativeCatalogInventory().types)
      assert.equal(pgTypes.getTypeParser(1003)(nativeTypesPg16[0]!.labels), nativeTypesPg16[0]!.labels,
        'pg leaves name[] as a raw string: the pre-fix query lost every label')
      return { rows }
    },
  }
  assert.match(await verifyPreauthorityNativeCatalog(client, fixtureMigrations, stage => stages.push(stage)), /^[0-9a-f]{64}$/u)
  assert.ok(reachedTypes)
  assert.deepEqual(stages, ['native_relations', 'native_columns', 'native_indexes', 'native_constraints', 'native_types'])
})

test('native type boundary rejects unexpected driver shapes and extra types, including empty-label types', async () => {
  const rows = nativeTypesPg16.map(row => ({ ...row, labels: pgTypes.getTypeParser(nativeTypeLabelsPg16Oid)(row.labels) }))
  for (const labels of [nativeTypesPg16[0]!.labels, null, undefined, {}, [1], ['draft', null]]) {
    const fixture = preconditionClient()
    const client = { ...fixture.client, query: async (sql: string, values?: unknown[]) => sql.includes('type.typtype AS kind')
      ? { rows: [{ ...rows[0]!, labels }, ...rows.slice(1)] } : fixture.client.query(sql, values) }
    await assert.rejects(verifyPreauthorityNativeCatalog(client, fixtureMigrations, () => {}),
      /preauthority_native_type_inventory_mismatch/u)
  }
  for (const kind of ['c', 'd', 'e', 'r', 'm', 'b', 'p']) {
    const fixture = preconditionClient()
    const client = { ...fixture.client, query: async (sql: string, values?: unknown[]) => sql.includes('type.typtype AS kind')
      ? { rows: [...rows, { schema: 'public', name: 'fixture_extra', kind, labels: kind === 'e' ? ['x'] : [] }] }
      : fixture.client.query(sql, values) }
    await assert.rejects(verifyPreauthorityNativeCatalog(client, fixtureMigrations, () => {}),
      /preauthority_native_type_inventory_mismatch/u, `extra ${kind} is not an automatic array/rowtype`)
  }
})

test('all 61 captured native enums retain exact schema, identity, label values and order', () => {
  const observed = nativeTypesPg16.map(row => ({ ...row,
    labels: pgTypes.getTypeParser(nativeTypeLabelsPg16Oid)(row.labels) as string[],
  }))
  const expected = preauthorityExpectedNativeCatalogInventory()
  assert.deepEqual(observed, expected.types)
  for (const [index, type] of observed.entries()) {
    const mutations = [
      { ...type, labels: [...type.labels, 'fixture_extra'] },
      { ...type, labels: type.labels.slice(1) },
      { ...type, labels: ['fixture_changed', ...type.labels.slice(1)] },
      { ...type, schema: 'fixture_schema' },
      { ...type, name: `${type.name}_changed` },
      ...(type.labels.length > 1 ? [{ ...type, labels: [...type.labels].reverse() }] : []),
    ]
    for (const mutation of mutations) {
      const inventory = { ...expected, types: observed.map((row, i) => i === index ? mutation : row) }
      assert.throws(() => assertPreauthorityNativeCatalogInventory(inventory, fixtureMigrations),
        /preauthority_native_type_inventory_mismatch/u, type.name)
    }
  }
})

test('preauthority catalog accepts only an absent protocol with no native News rows', () => {
  assert.doesNotThrow(() => assertPreauthorityCatalogState('absent', 0n))
  assert.throws(() => assertPreauthorityCatalogState('v1', 0n), /preauthority_catalog_verification_failed/)
  assert.throws(() => assertPreauthorityCatalogState('v2', 0n), /preauthority_catalog_verification_failed/)
  assert.throws(() => assertPreauthorityCatalogState('partial', 0n), /preauthority_catalog_verification_failed/)
  assert.throws(() => assertPreauthorityCatalogState('absent', 1n), /preauthority_catalog_verification_failed/)
  assert.throws(() => assertPreauthorityCatalogState('absent', '0'), /preauthority_catalog_verification_failed/)
})

test('native verifier diagnostics retain only a finite stage, reason, and PostgreSQL SQLSTATE', () => {
  const mismatch = Object.assign(new Error('sensitive catalog detail'), {
    code: 'preauthority_native_constraint_inventory_mismatch',
  })
  const catalogDiagnostic = getPreauthorityCatalogFailureDiagnostic(mismatch, 'native_types')
  assert.deepEqual(catalogDiagnostic, {
    stage: 'native_constraints', reason: 'preauthority_native_constraint_inventory_mismatch', sqlstate: null,
  })
  assert.equal(formatPreauthorityCatalogFailureDiagnostic(catalogDiagnostic),
    'PREAUTHORITY_CATALOG_DIAGNOSTIC stage=native_constraints reason=preauthority_native_constraint_inventory_mismatch sqlstate=none')

  const queryError = Object.assign(new Error('postgres://user:secret@host/database'), { code: '42703' })
  assert.deepEqual(getPreauthorityCatalogFailureDiagnostic(queryError, 'native_columns'), {
    stage: 'native_columns', reason: 'postgres_error', sqlstate: '42703',
  })

  const dynamicCode = Object.assign(new Error('private relation name'), {
    code: 'native_column_inventory_mismatch:private_relation.private_column',
  })
  const safeDynamicDiagnostic = getPreauthorityCatalogFailureDiagnostic(dynamicCode, 'protocol_columns')
  assert.deepEqual(safeDynamicDiagnostic, {
    stage: 'protocol_columns', reason: 'native_column_inventory_mismatch', sqlstate: null,
  })

  const unknown = Object.assign(new Error('private value'), { code: 'arbitrary-private-reason' })
  const safeFallback = getPreauthorityCatalogFailureDiagnostic(unknown, 'news_rows')
  assert.deepEqual(safeFallback, {
    stage: 'news_rows', reason: 'preauthority_catalog_verification_failed', sqlstate: null,
  })
  assert.doesNotMatch(JSON.stringify([catalogDiagnostic, safeDynamicDiagnostic, safeFallback]),
    /sensitive|private|postgres:\/\//u)
})

test('preauthority verifier maps every statically reachable fixed rejection to its owning phase', () => {
  const reachableReasons: [string, PreauthorityCatalogDiagnosticStage, PreauthorityCatalogDiagnosticStage][] = [
    ['unsafe_admin_target', 'protocol_identity', 'protocol_identity'],
    ['native_migration_ledger_mismatch', 'protocol_migrations', 'protocol_migrations'],
    ['native_relation_inventory_mismatch', 'protocol_relations', 'protocol_relations'],
    ['mutation_relation_inventory_mismatch', 'protocol_relations', 'protocol_relations'],
    ['native_column_inventory_mismatch:private_fixture.private_column', 'protocol_columns', 'protocol_columns'],
    ['native_serial_sequence_binding_or_configuration_mismatch', 'protocol_sequences', 'protocol_sequences'],
    ['native_enum_catalog_mismatch', 'protocol_enums', 'protocol_enums'],
    ['native_required_constraint_missing', 'protocol_constraints', 'protocol_constraints'],
    ['native_snapshot_index_missing_or_mismatched', 'protocol_indexes', 'protocol_indexes'],
    ['native_snapshot_foreign_key_mismatch', 'protocol_foreign_keys', 'protocol_foreign_keys'],
    ['native_control_column_types_mismatch', 'protocol_control_columns', 'protocol_control_columns'],
    ['native_item_run_id_type_mismatch', 'protocol_control_columns', 'protocol_control_columns'],
    ['control_role_contract_mismatch', 'protocol_control_roles', 'protocol_control_roles'],
    ['unsafe_preinstallation_control_state', 'protocol_control_ownership', 'protocol_control_ownership'],
    ['unsafe_preinstallation_control_state', 'protocol_native_privileges', 'protocol_native_privileges'],
    ['partial_protocol_installation_manual_recovery_required', 'protocol_inventory', 'protocol_inventory'],
    ['diagnostic_installed_protocol_deep_check_skipped', 'protocol_inventory', 'protocol_inventory'],
    ['preauthority_protocol_not_absent', 'protocol_state', 'protocol_state'],
    ['preauthority_native_relation_inventory_mismatch', 'native_relations', 'native_relations'],
    ['preauthority_native_column_inventory_mismatch', 'native_columns', 'native_columns'],
    ['preauthority_native_index_inventory_mismatch', 'native_indexes', 'native_indexes'],
    ['preauthority_native_constraint_inventory_mismatch', 'native_constraints', 'native_constraints'],
    ['preauthority_native_type_inventory_mismatch', 'native_types', 'native_types'],
    ['native_constraint_definition_unavailable', 'native_constraints', 'native_constraints'],
    ['native_snapshot_invalid', 'native_constraints', 'native_constraints'],
    ['preauthority_catalog_verification_failed', 'news_rows', 'news_rows'],
  ]
  for (const [code, currentStage, expectedStage] of reachableReasons) {
    const error = Object.assign(new Error('private diagnostic detail'), { code })
    const diagnostic = getPreauthorityCatalogFailureDiagnostic(error, currentStage)
    assert.deepEqual(diagnostic, {
      stage: expectedStage, reason: code.split(':', 1)[0], sqlstate: null,
    }, `fixed verifier reason ${code} must retain its precise stage and bounded reason`)
  }
  assert.deepEqual(getPreauthorityCatalogFailureDiagnostic(
    Object.assign(new Error('private SQL driver text'), { code: '42703' }), 'native_columns',
  ), { stage: 'native_columns', reason: 'postgres_error', sqlstate: '42703' })
})

test('actual read-only preauthority verifier reports ownership, native-privilege, and present-protocol phases', async () => {
  const cases: {
    options: Parameters<typeof preconditionClient>[0]
    expectedReason: string
    expectedStage: PreauthorityCatalogDiagnosticStage
    expectedQuery: string
  }[] = [
    {
      options: { failedControlCheck: 'ownership' }, expectedReason: 'unsafe_preinstallation_control_state',
      expectedStage: 'protocol_control_ownership', expectedQuery: controlRolesOwnershipVerificationSQL,
    },
    {
      options: { failedControlCheck: 'native-privileges' }, expectedReason: 'unsafe_preinstallation_control_state',
      expectedStage: 'protocol_native_privileges', expectedQuery: controlRolesNativePrivilegesVerificationSQL,
    },
    {
      options: { protocolPresent: true, roleFixture: 'finalizer-installed' },
      expectedReason: 'diagnostic_installed_protocol_deep_check_skipped',
      expectedStage: 'protocol_inventory', expectedQuery: 'AS ledger_relations',
    },
    ...(['missing-control', 'missing-controller', 'insecure-control', 'insecure-controller'] as const).map(roleFixture => ({
      options: { roleFixture }, expectedReason: 'control_role_contract_mismatch',
      expectedStage: 'protocol_control_roles' as const, expectedQuery: controlRolesVerificationSQL,
    })),
  ]
  for (const { options, expectedReason, expectedStage, expectedQuery } of cases) {
    const fixture = preconditionClient(options)
    let currentStage: PreauthorityCatalogDiagnosticStage = 'connection'
    const error = await verifyPreauthorityCatalogReadOnly(fixture.client, stage => { currentStage = stage })
      .then(() => null, value => value)
    assert.ok(error instanceof Error, 'the verifier must fail closed for this fixture')
    assert.ok(fixture.statements.some(sql => sql.includes(expectedQuery)), 'the real precondition stage was reached')
    if (options?.protocolPresent) {
      assert.ok(fixture.statements.includes(controlRolesVerificationSQL),
        'the canonical installed-protocol path uses the same baseline role contract before checking protocol inventory')
    }
    assert.deepEqual(getPreauthorityCatalogFailureDiagnostic(error, currentStage), {
      stage: expectedStage, reason: expectedReason, sqlstate: null,
    })
    assert.equal(formatPreauthorityCatalogFailureDiagnostic(
      getPreauthorityCatalogFailureDiagnostic(error, currentStage),
    ), `PREAUTHORITY_CATALOG_DIAGNOSTIC stage=${expectedStage} reason=${expectedReason} sqlstate=none`)
    assert.ok(!fixture.statements.some(sql => sql.includes('WHERE n.nspname NOT IN')),
      'failed preconditions must stop before strict native-catalog traversal')
  }
})

test('actual preauthority verifier accepts provisioned baseline control roles without a protocol, while role drift fails closed', async () => {
  assert.ok(controlRolesVerificationSQL.includes("('cms_control'::name, false, true)"))
  assert.ok(controlRolesVerificationSQL.includes("('cms_controller'::name, true, false)"))
  assert.ok(!/owner_news_|news_migration_|pg_shdepend|has_table_privilege|has_sequence_privilege/u.test(controlRolesVerificationSQL),
    'the shared role contract validates the provisioned baseline, not installed protocol ownership or ACLs')

  const fixture = preconditionClient({ roleFixture: 'preauthority' })
  let stage: PreauthorityCatalogDiagnosticStage = 'connection'
  const result = await verifyPreauthorityCatalogReadOnly(fixture.client, value => { stage = value })
  assert.equal(result.protocolStatus, 'absent')
  assert.equal(result.coverageApplicability, 'not-applicable')
  assert.equal(stage, 'native_types', 'a correctly provisioned preauthority database passes the shared role check and reaches native verification')
  assert.ok(fixture.statements.includes(controlRolesVerificationSQL))
  assert.ok(fixture.statements.some(sql => sql.includes('AS ledger_relations')),
    'the accepted fixture has an empty finalizer protocol inventory')

  for (const roleFixture of ['missing-control', 'missing-controller', 'insecure-control', 'insecure-controller'] as const) {
    const rejected = preconditionClient({ roleFixture })
    let failedStage: PreauthorityCatalogDiagnosticStage = 'connection'
    const error = await verifyPreauthorityCatalogReadOnly(rejected.client, value => { failedStage = value })
      .then(() => null, value => value)
    assert.ok(error instanceof Error)
    assert.deepEqual(getPreauthorityCatalogFailureDiagnostic(error, failedStage), {
      stage: 'protocol_control_roles', reason: 'control_role_contract_mismatch', sqlstate: null,
    }, `${roleFixture} must be rejected by the actual shared role contract`)
    assert.ok(rejected.statements.includes(controlRolesVerificationSQL))
    assert.ok(!rejected.statements.some(sql => sql.includes('AS ledger_relations')),
      'role drift must fail before protocol-state or native-catalog checks')
  }
})

test('preauthority native inventory is exact while the protocol finalizer remains outside its allowlist', () => {
  const expected = preauthorityExpectedNativeCatalogInventory()
  const migrationNames = [
    '20261002_181423_owner_news_initial', '20261005_133515_owner_news_media',
    '20261005_151541_owner_news_publication', '20261005_220916_owner_news_legacy_history',
    '20261006_181325_a_owner_news_suspend_enum', '20261006_181424_z_owner_news_native',
  ]
  const fingerprint = assertPreauthorityNativeCatalogInventory(expected, migrationNames)
  assert.match(fingerprint, /^[0-9a-f]{64}$/u)
  assert.deepEqual(
    Object.fromEntries(['p', 'f', 'c'].map(kind => [kind, expected.constraints.filter(item => item.kind === kind).length])),
    { p: 46, f: 49, c: 24 },
    'native constraints are PK, FK, and reviewed CHECK entries; unique indexes stay in the separate index inventory',
  )
  assert.ok(expected.constraints.every(constraint => constraint.validated && !constraint.deferrable && !constraint.deferred),
    'the expected PostgreSQL constraint catalog requires validated and non-deferrable constraints')
  assert.equal(expected.indexes.filter(index => index.unique).length, 55,
    'unique indexes from the combined native migration snapshots are independently covered by the strict index inventory')

  for (const [field, value] of [
    ['validated', false], ['deferrable', true], ['deferred', true],
  ] as const) {
    const changedConstraintMetadata = structuredClone(expected)
    const changed = changedConstraintMetadata.constraints[0]!
    changed[field] = value
    const metadataError = captureVerifierError(
      () => assertPreauthorityNativeCatalogInventory(changedConstraintMetadata, migrationNames),
    )
    assert.equal(getPreauthorityCatalogFailureDiagnostic(metadataError, 'native_constraints').constraintMismatch?.category,
      'constraint_metadata', `${field} drift is rejected as metadata mismatch`)
  }

  const unexpectedMaterializedView = structuredClone(expected)
  unexpectedMaterializedView.relations.push({ schema: 'public', name: 'fixture_summary', kind: 'm' })
  assert.throws(() => assertPreauthorityNativeCatalogInventory(unexpectedMaterializedView, migrationNames),
    /preauthority_native_relation_inventory_mismatch/u)

  const unexpectedCompositeRelation = structuredClone(expected)
  unexpectedCompositeRelation.relations.push({ schema: 'public', name: 'fixture_payload', kind: 'c' })
  assert.throws(() => assertPreauthorityNativeCatalogInventory(unexpectedCompositeRelation, migrationNames),
    /preauthority_native_relation_inventory_mismatch/u)

  const unexpectedView = structuredClone(expected)
  unexpectedView.relations.push({ schema: 'public', name: 'fixture_summary', kind: 'v' })
  assert.throws(() => assertPreauthorityNativeCatalogInventory(unexpectedView, migrationNames),
    /preauthority_native_relation_inventory_mismatch/u)

  const unexpectedColumn = structuredClone(expected)
  unexpectedColumn.columns.push({
    ...unexpectedColumn.columns[0]!, table: 'news_articles', name: 'fixture_unreviewed_column',
  })
  assert.throws(() => assertPreauthorityNativeCatalogInventory(unexpectedColumn, migrationNames),
    /preauthority_native_column_inventory_mismatch/u)

  const mismatchedDefault = structuredClone(expected)
  mismatchedDefault.columns[0]!.defaultVerified = false
  assert.throws(() => assertPreauthorityNativeCatalogInventory(mismatchedDefault, migrationNames),
    /preauthority_native_column_inventory_mismatch/u)

  const unexpectedIndex = structuredClone(expected)
  unexpectedIndex.indexes.push({
    ...unexpectedIndex.indexes[0]!, name: 'fixture_unreviewed_idx', definition: 'CREATE INDEX fixture_unreviewed_idx',
  })
  assert.throws(() => assertPreauthorityNativeCatalogInventory(unexpectedIndex, migrationNames),
    /preauthority_native_index_inventory_mismatch/u)

  const unexpectedConstraint = structuredClone(expected)
  unexpectedConstraint.constraints.push({
    ...unexpectedConstraint.constraints[0]!, name: 'fixture_unreviewed_check', kind: 'c',
    definition: 'CHECK (true)',
  })
  const unexpectedConstraintError = captureVerifierError(
    () => assertPreauthorityNativeCatalogInventory(unexpectedConstraint, migrationNames),
  )
  assert.match(unexpectedConstraintError.message, /preauthority_native_constraint_inventory_mismatch/u)
  const unexpectedConstraintDiagnostic = getPreauthorityCatalogFailureDiagnostic(unexpectedConstraintError, 'native_constraints')
  assert.deepEqual(unexpectedConstraintDiagnostic.constraintMismatch, {
    category: 'unexpected_observed', table: null, constraint: null,
    expectedCount: expected.constraints.length, observedCount: unexpectedConstraint.constraints.length,
    expectedDefinitionSha256: null,
    observedDefinitionSha256: createHash('sha256').update('CHECK (true)', 'utf8').digest('hex'),
  })
  assert.match(formatPreauthorityNativeConstraintMismatchDiagnostic(unexpectedConstraintDiagnostic)!,
    /^PREAUTHORITY_CONSTRAINT_DIAGNOSTIC category=unexpected_observed table=none constraint=none /u)
  assert.doesNotMatch(formatPreauthorityNativeConstraintMismatchDiagnostic(unexpectedConstraintDiagnostic)!, /fixture_unreviewed|CHECK \(true\)/u)

  const unexpectedCompositeType = structuredClone(expected)
  unexpectedCompositeType.types.push({ schema: 'public', name: 'fixture_payload', kind: 'c', labels: [] })
  assert.throws(() => assertPreauthorityNativeCatalogInventory(unexpectedCompositeType, migrationNames),
    /preauthority_native_type_inventory_mismatch/u)
  assert.ok(expected.relations.every(relation => relation.kind !== 'c'), 'automatic table rowtypes are not standalone relations')
  assert.ok(expected.types.every(type => type.kind !== 'c'), 'automatic table rowtypes and their arrays are not custom standalone types')

  const requiredChecks = expected.constraints.filter(constraint => constraint.kind === 'c')
  assert.equal(requiredChecks.length, 24, 'every CHECK added by the native migration has a canonical definition')
  for (const constraint of requiredChecks) {
    const weakenedCheck = structuredClone(expected)
    const sameNameCheck = weakenedCheck.constraints.find(candidate => candidate.name === constraint.name)
    assert.ok(sameNameCheck)
    sameNameCheck.definition = 'CHECK (true)'
    assert.throws(() => assertPreauthorityNativeCatalogInventory(weakenedCheck, migrationNames),
      /preauthority_native_constraint_inventory_mismatch/u, `weakened same-name check ${constraint.name} is rejected`)
  }

  const pgRenderedCheck = structuredClone(expected)
  const pgCheck = pgRenderedCheck.constraints.find(constraint => constraint.name === 'news_migration_runs_manifest_sha256_check')
  assert.ok(pgCheck)
  // PostgreSQL pg_get_constraintdef output for varchar regex checks adds
  // parentheses and text coercions around both operands; these casts are
  // semantics-preserving for this reviewed expression only.
  pgCheck.definition = "CHECK (((manifest_sha256)::text ~ '^[0-9a-f]{64}$'::text))"
  assert.doesNotThrow(() => assertPreauthorityNativeCatalogInventory(pgRenderedCheck, migrationNames),
    'canonical check comparison accepts PostgreSQL-rendered casts and grouping without accepting changed predicates')

  const weakenedPostgresCheck = structuredClone(pgRenderedCheck)
  const weakenedPostgresConstraint = weakenedPostgresCheck.constraints.find(constraint => constraint.name === pgCheck.name)
  assert.ok(weakenedPostgresConstraint)
  weakenedPostgresConstraint.definition = 'CHECK (true)'
  const weakenedPostgresError = captureVerifierError(
    () => assertPreauthorityNativeCatalogInventory(weakenedPostgresCheck, migrationNames),
  )
  assert.match(weakenedPostgresError.message,
    /preauthority_native_constraint_inventory_mismatch/u,
    'a same-name PostgreSQL-rendered CHECK weakened to TRUE still fails exact semantic comparison')
  const weakenedPostgresDiagnostic = getPreauthorityCatalogFailureDiagnostic(weakenedPostgresError, 'native_constraints')
  assert.deepEqual(weakenedPostgresDiagnostic.constraintMismatch, {
    category: 'check_definition', table: 'news_migration_runs', constraint: pgCheck.name,
    expectedCount: expected.constraints.length, observedCount: expected.constraints.length,
    expectedDefinitionSha256: createHash('sha256').update(
      expected.constraints.find(constraint => constraint.name === pgCheck.name)!.definition, 'utf8',
    ).digest('hex'),
    observedDefinitionSha256: createHash('sha256').update('CHECK (true)', 'utf8').digest('hex'),
  })
  const renderedMismatchLine = formatPreauthorityNativeConstraintMismatchDiagnostic(weakenedPostgresDiagnostic)
  assert.ok(renderedMismatchLine)
  assert.match(renderedMismatchLine, /category=check_definition table=news_migration_runs constraint=news_migration_runs_manifest_sha256_check/u)
  assert.match(renderedMismatchLine, /expectedSha256=[0-9a-f]{64} observedSha256=[0-9a-f]{64}$/u)
  assert.doesNotMatch(renderedMismatchLine, /CHECK \(|\^/u,
    'the verifier emits only reviewed identifiers, counts and hashes, never raw definitions')

  const primaryKeys = expected.constraints.filter(constraint => constraint.kind === 'p')
  assert.ok(primaryKeys.length > 0)
  const pgRenderedPrimaryKey = structuredClone(expected)
  const renderedPrimaryKey = pgRenderedPrimaryKey.constraints.find(constraint => constraint.kind === 'p')
  assert.ok(renderedPrimaryKey)
  renderedPrimaryKey.definition = 'PRIMARY KEY (id)'
  assert.doesNotThrow(() => assertPreauthorityNativeCatalogInventory(pgRenderedPrimaryKey, migrationNames),
    'PostgreSQL pg_get_constraintdef identifier dequoting remains equivalent for reviewed primary keys')
  for (const constraint of primaryKeys) {
    const changedPrimaryKey = structuredClone(expected)
    const sameNamePrimaryKey = changedPrimaryKey.constraints.find(candidate => candidate.name === constraint.name)
    assert.ok(sameNamePrimaryKey)
    sameNamePrimaryKey.definition = 'PRIMARY KEY (wrong_id)'
    assert.throws(() => assertPreauthorityNativeCatalogInventory(changedPrimaryKey, migrationNames),
      /preauthority_native_constraint_inventory_mismatch/u, `changed same-name primary key ${constraint.name} is rejected`)
  }

  const foreignKeys = expected.constraints.filter(constraint => constraint.kind === 'f')
  assert.ok(foreignKeys.length > 0)
  for (const constraint of foreignKeys) {
    const changedForeignKey = structuredClone(expected)
    const sameNameForeignKey = changedForeignKey.constraints.find(candidate => candidate.name === constraint.name)
    assert.ok(sameNameForeignKey)
    sameNameForeignKey.definition = 'FOREIGN KEY (wrong_id) REFERENCES public.wrong_table(id)'
    assert.throws(() => assertPreauthorityNativeCatalogInventory(changedForeignKey, migrationNames),
      /preauthority_native_constraint_inventory_mismatch/u, `changed same-name foreign key ${constraint.name} is rejected`)
  }

  const pgRenderedForeignKey = structuredClone(expected)
  const pgForeignKey = pgRenderedForeignKey.constraints.find(constraint => constraint.kind === 'f'
    && /ON DELETE CASCADE/iu.test(constraint.definition))
  assert.ok(pgForeignKey)
  pgForeignKey.definition = `${pgForeignKey.definition.replaceAll('"', '').replace('public.', '')} ON UPDATE NO ACTION MATCH SIMPLE`
  assert.doesNotThrow(() => assertPreauthorityNativeCatalogInventory(pgRenderedForeignKey, migrationNames),
    'canonical FK comparison accepts PostgreSQL schema/quote/default-action rendering')

  const uniqueIndexes = expected.indexes.filter(index => index.unique)
  assert.ok(uniqueIndexes.length > 0)
  for (const index of uniqueIndexes) {
    const changedUniqueIndex = structuredClone(expected)
    const sameNameIndex = changedUniqueIndex.indexes.find(candidate => candidate.name === index.name)
    assert.ok(sameNameIndex)
    sameNameIndex.definition = `CREATE UNIQUE INDEX ${index.name} ON public.wrong_table (wrong_id)`
    assert.throws(() => assertPreauthorityNativeCatalogInventory(changedUniqueIndex, migrationNames),
      /preauthority_native_index_inventory_mismatch/u, `changed same-name unique index ${index.name} is rejected`)
  }

  const pgRenderedUniqueIndex = structuredClone(expected)
  const renderedUniqueIndex = pgRenderedUniqueIndex.indexes.find(index => index.unique)
  assert.ok(renderedUniqueIndex)
  renderedUniqueIndex.definition = `CREATE UNIQUE INDEX ${renderedUniqueIndex.name} ON public.${renderedUniqueIndex.table} USING ${renderedUniqueIndex.method} (${renderedUniqueIndex.columns.map(column => column.expression).join(', ')})`
  assert.doesNotThrow(() => assertPreauthorityNativeCatalogInventory(pgRenderedUniqueIndex, migrationNames),
    'canonical unique-index comparison accepts PostgreSQL identifier dequoting')
})
