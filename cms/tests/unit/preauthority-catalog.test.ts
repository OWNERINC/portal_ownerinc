import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertPreauthorityNativeCatalogInventory,
  formatPreauthorityCatalogFailureDiagnostic,
  getPreauthorityCatalogFailureDiagnostic,
  NATIVE_ENUM_CATALOG_SQL,
  NATIVE_FOREIGN_KEYS_CATALOG_SQL,
  nativeSchemaSnapshot,
  preauthorityExpectedNativeCatalogInventory,
  verifyPreauthorityCatalogReadOnly,
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

const fixtureMigrations = [
  '20261002_181423_owner_news_initial', '20261005_133515_owner_news_media',
  '20261005_151541_owner_news_publication', '20261005_220916_owner_news_legacy_history',
  '20261006_181325_a_owner_news_suspend_enum', '20261006_181424_z_owner_news_native',
]

function preconditionClient({ failedControlCheck, protocolPresent }: {
  failedControlCheck?: 'ownership' | 'native-privileges'
  protocolPresent?: boolean
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
      if (sql === controlRolesVerificationSQL) return { rows: [{ safe: true }] }
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
      options: { protocolPresent: true }, expectedReason: 'diagnostic_installed_protocol_deep_check_skipped',
      expectedStage: 'protocol_inventory', expectedQuery: 'AS ledger_relations',
    },
  ]
  for (const { options, expectedReason, expectedStage, expectedQuery } of cases) {
    const fixture = preconditionClient(options)
    let currentStage: PreauthorityCatalogDiagnosticStage = 'connection'
    const error = await verifyPreauthorityCatalogReadOnly(fixture.client, stage => { currentStage = stage })
      .then(() => null, value => value)
    assert.ok(error instanceof Error, 'the verifier must fail closed for this fixture')
    assert.ok(fixture.statements.some(sql => sql.includes(expectedQuery)), 'the real precondition stage was reached')
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

test('preauthority native inventory is exact while the protocol finalizer remains outside its allowlist', () => {
  const expected = preauthorityExpectedNativeCatalogInventory()
  const migrationNames = [
    '20261002_181423_owner_news_initial', '20261005_133515_owner_news_media',
    '20261005_151541_owner_news_publication', '20261005_220916_owner_news_legacy_history',
    '20261006_181325_a_owner_news_suspend_enum', '20261006_181424_z_owner_news_native',
  ]
  const fingerprint = assertPreauthorityNativeCatalogInventory(expected, migrationNames)
  assert.match(fingerprint, /^[0-9a-f]{64}$/u)

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
  assert.throws(() => assertPreauthorityNativeCatalogInventory(unexpectedConstraint, migrationNames),
    /preauthority_native_constraint_inventory_mismatch/u)

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
  pgCheck.definition = "CHECK (((manifest_sha256)::text ~ '^[0-9a-f]{64}$'::text))"
  assert.doesNotThrow(() => assertPreauthorityNativeCatalogInventory(pgRenderedCheck, migrationNames),
    'canonical check comparison accepts PostgreSQL-added casts and grouping without accepting changed predicates')

  const primaryKeys = expected.constraints.filter(constraint => constraint.kind === 'p')
  assert.ok(primaryKeys.length > 0)
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
