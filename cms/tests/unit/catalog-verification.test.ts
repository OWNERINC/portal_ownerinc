import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertCanonicalProtocolFunctions, assertCanonicalProtocolTriggers, defaultMatches,
  extractCanonicalFunctionBodies, jsonbDefaultLiteralsMatch, nativeCatalogFingerprint,
  readNativeCatalog, readProtocolFunctions, readProtocolTriggers,
  type CatalogClient, type NativeCatalogInventory, type NativeColumnContract,
} from '../../src/database/catalog-verification'
import {
  assertPreauthorityNativeCatalogInventory, canonicalTriggerDefinitions,
  nativeSchemaSnapshot, NEWS_MIGRATION_ITEM_BINDING_DDL, preauthorityExpectedNativeCatalogInventory,
} from '../../scripts/finalize-news-protocol'
import { buildNewsMigrationBootstrapRunDDL } from '../../src/publication/bootstrap-run'
import { buildNewsMutationTriggersDDL } from '../../src/publication/mutation-triggers'
import { nativeChecksPg16 } from '../fixtures/native-checks-pg16'

const migrations = [
  '20261002_181423_owner_news_initial', '20261005_133515_owner_news_media',
  '20261005_151541_owner_news_publication', '20261005_220916_owner_news_legacy_history',
  '20261006_181325_a_owner_news_suspend_enum', '20261006_181424_z_owner_news_native',
]
// Captured from the original finalizer before extraction, not computed from
// the new serializer. Includes all 49/460/224/119/61 inventory entries.
const originalNativeFingerprint = '72325d9644870e9ac3d714e5224dbded1a92afaa5990a1e183046281b9229046'

test('native fingerprint retains the pre-extraction golden bytes and accepts captured PG16 CHECK rendering', () => {
  const inventory = preauthorityExpectedNativeCatalogInventory()
  const before = structuredClone(inventory)
  assert.equal(assertPreauthorityNativeCatalogInventory(inventory, migrations), originalNativeFingerprint)
  assert.deepEqual(inventory, before)
  for (const constraint of inventory.constraints.filter(row => row.kind === 'c')) {
    constraint.definition = nativeChecksPg16[constraint.name]!
  }
  assert.equal(assertPreauthorityNativeCatalogInventory(inventory, migrations), originalNativeFingerprint)
})

test('fingerprint binds observed default/index bytes and ordered migrations after semantic validation', () => {
  const inventory = preauthorityExpectedNativeCatalogInventory()
  const column = inventory.columns.find(row => row.defaultExpression === 'now()')!
  column.defaultExpression = '(now())'
  assert.notEqual(assertPreauthorityNativeCatalogInventory(inventory, migrations), originalNativeFingerprint)
  const other = preauthorityExpectedNativeCatalogInventory()
  other.indexes[0]!.definition = ` ${other.indexes[0]!.definition}`
  assert.notEqual(assertPreauthorityNativeCatalogInventory(other, migrations), originalNativeFingerprint)
  assert.notEqual(assertPreauthorityNativeCatalogInventory(preauthorityExpectedNativeCatalogInventory(),
    [...migrations].reverse()), originalNativeFingerprint)
})

test('standalone serializer normalizes observed CHECKs only and retains non-CHECK bytes without mutating evidence', () => {
  const inventory: NativeCatalogInventory = {
    relations: [], columns: [], indexes: [], constraints: [
      { schema: 'public', table: 'sample', name: 'pk', kind: 'p', validated: true,
        deferrable: false, deferred: false, definition: 'PRIMARY KEY (id)' },
      { schema: 'public', table: 'sample', name: 'check', kind: 'c', validated: true,
        deferrable: false, deferred: false, definition: 'CHECK (observed)' },
    ], types: [],
  }
  const before = structuredClone(inventory)
  const calls: string[] = []
  const fingerprint = nativeCatalogFingerprint(inventory, ['one'], definition => {
    calls.push(definition)
    return ['observed-expression']
  })
  assert.deepEqual(calls, ['CHECK (observed)'])
  assert.deepEqual(inventory, before)
  inventory.constraints[0]!.definition += ' '
  assert.notEqual(nativeCatalogFingerprint(inventory, ['one'], () => ['observed-expression']), fingerprint)
  assert.equal(before.constraints[1]!.definition, inventory.constraints[1]!.definition)
})

function nativeReaderFixture(mutate: (inventory: NativeCatalogInventory) => void = () => {}) {
  const inventory = preauthorityExpectedNativeCatalogInventory()
  const relations = structuredClone(inventory.relations)
  const columns: NativeColumnContract[] = inventory.columns.map(column => {
    const snapshot = nativeSchemaSnapshot.tables[`public.${column.table}`]!.columns[column.name]!
    const serial = snapshot.type === 'serial'
    if (serial) column.defaultExpression = `nextval('${column.table}_${column.name}_seq'::regclass)`
    return { table: column.table, name: column.name, type: column.type, default: snapshot.default, serial }
  })
  mutate(inventory)
  const statements: string[] = []
  const client: CatalogClient = { query: async (sql, values) => {
    statements.push(sql)
    assert.match(sql, /^SELECT /u, 'every executed statement must be SELECT-only')
    if (sql.includes('FROM pg_catalog.pg_namespace n LEFT JOIN')) return { rows: inventory.relations }
    if (sql.includes('attribute.attname AS column_name')) {
      assert.deepEqual(values, [[...new Set(columns.map(column => column.table))].sort()])
      return { rows: [...inventory.columns].reverse().map(column => ({
        schema: column.schema, table_name: column.table, column_name: column.name,
        type_name: column.type, type_schema: column.typeSchema, not_null: column.notNull,
        default_expression: column.defaultExpression,
      })) }
    }
    if (sql === 'SELECT $1::jsonb = $2::jsonb AS matches') {
      // This fixture only uses identical literals. It must never impersonate
      // PostgreSQL's JSONB equality for unequal JSON text.
      assert.equal(values?.[0], values?.[1])
      return { rows: [{ matches: true }] }
    }
    if (sql.includes('SELECT table_ns.nspname AS table_schema')) return { rows: inventory.indexes.map(index => ({
      table_schema: index.tableSchema, table_name: index.table, index_schema: index.schema,
      index_name: index.name, is_unique: index.unique, is_primary: index.primary,
      is_valid: index.valid, is_ready: index.ready, no_predicate: index.noPredicate, no_expressions: index.noExpressions,
      key_count: index.keyCount, attribute_count: index.attributeCount, method: index.method,
      columns: index.columns, definition: index.definition,
    })) }
    if (sql.includes('con.conname AS constraint_name')) return { rows: inventory.constraints.map(row => ({
      schema: row.schema, table_name: row.table, constraint_name: row.name, kind: row.kind,
      validated: row.validated, deferrable: row.deferrable, deferred: row.deferred, definition: row.definition,
    })) }
    if (sql.includes('type.typtype AS kind')) return { rows: inventory.types }
    assert.fail(`Unexpected reader query: ${sql}`)
  } }
  return { client, inventory, relations, columns, statements }
}

test('shared native reader produces the observed inventory using only SELECT and preserves stage order', async () => {
  const fixture = nativeReaderFixture()
  const stages: string[] = []
  const observed = await readNativeCatalog(fixture.client, fixture.relations, fixture.columns, stage => stages.push(stage))
  assert.deepEqual(observed, fixture.inventory)
  assert.deepEqual(stages, ['native_relations', 'native_columns', 'native_indexes', 'native_constraints', 'native_types'])
  assert.match(assertPreauthorityNativeCatalogInventory(observed, migrations), /^[0-9a-f]{64}$/u)
  assert.ok(fixture.statements.length >= 5)
})

const nativeMutations: [string, (inventory: NativeCatalogInventory) => void, RegExp][] = [
  ['unexpected protocol relation', inventory => inventory.relations.push({
    schema: 'public', name: 'owner_news_mutation_head', kind: 'r',
  }), /preauthority_native_relation_inventory_mismatch/u],
  ['unexpected user namespace', inventory => inventory.relations.push({
    schema: 'pgxtempyhidden', name: 'unexpected', kind: 'r',
  }), /preauthority_native_relation_inventory_mismatch/u],
  ['extra native column', inventory => inventory.columns.push({ ...inventory.columns[0]!, name: 'unexpected' }),
    /preauthority_native_column_inventory_mismatch/u],
  ['extra native index', inventory => inventory.indexes.push({ ...inventory.indexes[0]!, name: 'unexpected' }),
    /preauthority_native_index_inventory_mismatch/u],
  ['extra native constraint', inventory => inventory.constraints.push({ ...inventory.constraints[0]!, name: 'unexpected' }),
    /preauthority_native_constraint_inventory_mismatch/u],
  ['weakened native CHECK', inventory => { inventory.constraints.find(row => row.kind === 'c')!.definition = 'CHECK (true)' },
    /preauthority_native_constraint_inventory_mismatch/u],
  ['extra native type', inventory => inventory.types.push({ schema: 'public', name: 'unexpected', kind: 'd', labels: [] }),
    /preauthority_native_type_inventory_mismatch/u],
  ['executable native default', inventory => { inventory.columns.find(row => row.defaultExpression === 'now()')!.defaultExpression = 'public.side_effect()' },
    /preauthority_native_column_inventory_mismatch/u],
]
for (const [name, mutate, reason] of nativeMutations) {
  test(`shared reader plus strict native wrapper rejects ${name}`, async () => {
    const fixture = nativeReaderFixture(mutate)
    await assert.rejects(async () => {
      const observed = await readNativeCatalog(fixture.client, fixture.relations, fixture.columns)
      assertPreauthorityNativeCatalogInventory(observed, migrations)
    }, reason)
    assert.ok(fixture.statements.every(sql => !sql.includes('side_effect')))
  })
}

test('default comparison never executes catalog expressions, including disguised JSONB or nextval expressions', async () => {
  const client: CatalogClient = { query: async () => assert.fail('unsafe expression must not reach SQL execution') }
  for (const expression of [
    "'{}'::jsonb || public.side_effect()", "('{}'::jsonb); SELECT public.side_effect()",
    'public.side_effect()', "E'{}'::jsonb", "'{}'::public.jsonb", "'{}'::jsonb /* hidden */",
  ]) assert.equal(await defaultMatches(client, "'{}'::jsonb", expression, 'jsonb'), false, expression)
  assert.equal(await defaultMatches(client, null, "nextval('public.other_seq'::regclass)", 'int4', 'sample_id_seq'), false)
  assert.equal(await defaultMatches(client, null, "nextval('sample_id_seq'::regclass); SELECT 1", 'int4', 'sample_id_seq'), false)
  assert.equal(await defaultMatches(client, null, "nextval('public.sample_id_seq'::regclass)", 'int4', 'sample_id_seq'), true)
})

test('JSONB literal comparison binds exact data bytes and propagates the database result without JS number rounding', async () => {
  const expected = '{"n":9007199254740993,"text":"it\'s SELECT public.side_effect()"}'
  const actual = '{"n":9007199254740992,"text":"it\'s SELECT public.side_effect()"}'
  const quoted = (value: string) => `'${value.replaceAll("'", "''")}'::jsonb`
  let calls = 0
  const client: CatalogClient = { query: async (sql, values) => {
    calls += 1
    assert.equal(sql, 'SELECT $1::jsonb = $2::jsonb AS matches')
    assert.deepEqual(values, [expected, actual])
    return { rows: [{ matches: false }] }
  } }
  assert.equal(await jsonbDefaultLiteralsMatch(client, quoted(expected), quoted(actual), 'jsonb'), false)
  assert.equal(calls, 1)
})

const functionBodies = new Map([
  ...extractCanonicalFunctionBodies(buildNewsMutationTriggersDDL(), [
    'owner_news_mutation_guard_stmt', 'owner_news_mutation_capture_row', 'owner_news_seal_run',
  ]),
  ...extractCanonicalFunctionBodies(NEWS_MIGRATION_ITEM_BINDING_DDL, ['owner_news_migration_item_binding_guard']),
  ...extractCanonicalFunctionBodies(buildNewsMigrationBootstrapRunDDL(), ['owner_news_bootstrap_run']),
])
function canonicalFunctions(): Record<string, unknown>[] {
  return [...functionBodies].map(([name, source]) => ({
    name, source, canonical_signature: true, security_definer: name !== 'owner_news_mutation_guard_stmt',
    owner: 'cms_control', config: ['search_path=pg_catalog, public'],
    bootstrap_return_shape: true, bootstrap_is_strict: false,
    bootstrap_argument_modes: ['i', 'i', 'i', 'i', 'i', 't'],
    bootstrap_argument_names: ['p_run_id', 'p_manifest_sha256', 'p_source_instance', 'p_source_fingerprint', 'p_authority_epoch', 'id'],
  }))
}

const functionMutations: [string, (rows: Record<string, unknown>[]) => void][] = [
  ['missing bootstrap', rows => { rows.splice(rows.findIndex(row => row.name === 'owner_news_bootstrap_run'), 1) }],
  ['changed seal body', rows => { rows.find(row => row.name === 'owner_news_seal_run')!.source += '\n-- drift' }],
  ['changed bootstrap body', rows => { rows.find(row => row.name === 'owner_news_bootstrap_run')!.source += ' ' }],
  ['unknown name replacing canonical member', rows => { rows[0]!.name = 'owner_news_unexpected' }],
  ['extra function', rows => { rows.push({ ...rows[0]!, name: 'owner_news_unexpected' }) }],
  ['duplicate name hiding a missing member', rows => { rows[0] = { ...rows[1]! } }],
  ['wrong overload identity', rows => { rows[0]!.canonical_signature = false }],
  ['wrong owner', rows => { rows[0]!.owner = 'cms_runtime' }],
  ['wrong search path', rows => { rows[0]!.config = ['search_path=public, pg_catalog'] }],
]
for (const [name, mutate] of functionMutations) {
  test(`shared function reader/comparator rejects ${name}`, async () => {
    const rows = canonicalFunctions()
    assert.doesNotThrow(() => assertCanonicalProtocolFunctions(rows, functionBodies))
    mutate(rows)
    const client: CatalogClient = { query: async sql => {
      assert.match(sql, /^SELECT /u)
      assert.match(sql, /p\.proname::text ~ '\^owner_news_'/u)
      assert.doesNotMatch(sql, /p\.proname = ANY/u, 'unknown functions must not be filtered out')
      return { rows }
    } }
    const observed = await readProtocolFunctions(client, 2)
    assert.throws(() => assertCanonicalProtocolFunctions(observed.rows, functionBodies), /canonical_function_mismatch/u)
  })
}

test('readers reject a runtime-invalid protocol version before issuing SQL', async () => {
  const client: CatalogClient = { query: async () => assert.fail('invalid version must not reach SQL') }
  await assert.rejects(readProtocolFunctions(client, 3 as 2), /canonical_function_inventory_unavailable/u)
  await assert.rejects(readProtocolTriggers(client, 3 as 2, ['news_articles']), /canonical_function_inventory_unavailable/u)
})

const triggerKey = 'news_articles.owner_news_mutation_guard_stmt'
const triggerContract = new Map([[triggerKey, canonicalTriggerDefinitions.get(triggerKey)!]])
function triggerRow(): Record<string, unknown> {
  return {
    name: 'owner_news_mutation_guard_stmt', relation: 'news_articles', relation_schema: 'public',
    enabled: 'A', event_mask: 62, attribute_count: 0, attribute_vector_text: '', attribute_vector_type: 'int2vector',
    argument_count: 0, argument_bytes: 0, no_condition: true,
    function: 'owner_news_mutation_guard_stmt', function_schema: 'public', function_identity_approved: true,
    definition: 'CREATE TRIGGER owner_news_mutation_guard_stmt BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON public.news_articles FOR EACH STATEMENT EXECUTE FUNCTION owner_news_mutation_guard_stmt()',
  }
}

test('trigger reader retains unexpected trigger names and binds the table set as data', async () => {
  const rows = [triggerRow(), { ...triggerRow(), name: 'unexpected_trigger' }]
  assert.doesNotThrow(() => assertCanonicalProtocolTriggers([rows[0]!], triggerContract))
  const table = "untrusted'); SELECT public.side_effect(); --"
  const client: CatalogClient = { query: async (sql, values) => {
    assert.match(sql, /^SELECT /u)
    assert.deepEqual(values, [['news_articles', table]])
    assert.doesNotMatch(sql, /side_effect|t\.tgname\s*(?:=|~|LIKE)/u)
    return { rows }
  } }
  const observed = await readProtocolTriggers(client, 2, ['news_articles', table])
  assert.throws(() => assertCanonicalProtocolTriggers(observed.rows, triggerContract), /trigger_inventory_count_mismatch/u)
})

test('unqualified trigger rendering never bypasses function identity, schema, event or condition checks', () => {
  for (const [field, value, reason] of [
    ['function_identity_approved', false, 'trigger_function_identity_mismatch'],
    ['function_schema', 'private', 'trigger_function_schema_mismatch'],
    ['event_mask', 6, 'trigger_event_mask_mismatch'],
    ['no_condition', false, 'trigger_condition_mismatch'],
    ['definition', `${triggerRow().definition} WHEN (true)`, 'trigger_definition_mismatch'],
  ] as const) {
    assert.throws(() => assertCanonicalProtocolTriggers([{ ...triggerRow(), [field]: value }], triggerContract),
      new RegExp(reason, 'u'))
  }
})

test('trigger comparator preserves missing/duplicate diagnostics and structured failure-sink details', () => {
  assert.throws(() => assertCanonicalProtocolTriggers([], triggerContract), /trigger_key_missing/u)
  assert.throws(() => assertCanonicalProtocolTriggers([triggerRow(), triggerRow()], triggerContract), /trigger_key_duplicate/u)
  const sentinel = new Error('diagnostic sink')
  assert.throws(() => assertCanonicalProtocolTriggers([{ ...triggerRow(), event_mask: 6 }], triggerContract,
    (reason, details) => {
      assert.equal(reason, 'trigger_event_mask_mismatch')
      assert.equal(details.expectedIndex, 0)
      assert.equal(details.expectedCount, 1)
      assert.equal(details.observedCount, 1)
      assert.equal(details.expectedEventMask, 62)
      assert.equal(details.eventMask, 6)
      assert.equal(details.functionIdentityMatch, true)
      assert.equal(details.definitionNormalized, true)
      throw sentinel
    }), error => error === sentinel)
})
