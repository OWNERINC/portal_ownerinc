import { createHash } from 'node:crypto'

/** SELECT-only building blocks. Connection identity, transaction ownership,
 * grants and operational authorization belong to the caller. No helper here
 * opens a connection, executes DDL, changes role or certifies coverage.
 * These are extraction primitives, not a complete strict-readiness verifier:
 * callers still supply committed contracts and perform all inventory, identity,
 * head and privilege checks in their own bounded read-only snapshot. */
export type CatalogResult = { rows: Record<string, unknown>[] }
export type CatalogClient = { query(sql: string, values?: unknown[]): Promise<CatalogResult> }

export type NativeCatalogRelation = { schema: string; name: string; kind: string }
export type NativeCatalogColumn = {
  schema: string; table: string; name: string; type: string; typeSchema: string
  notNull: boolean; defaultExpression: string | null; defaultVerified: boolean
}
export type NativeCatalogIndex = {
  tableSchema: string; table: string; schema: string; name: string
  unique: boolean; primary: boolean; valid: boolean; ready: boolean
  noPredicate: boolean; noExpressions: boolean; keyCount: number; attributeCount: number
  method: string
  columns: readonly { expression: string; isExpression: boolean; asc: boolean; nulls: string }[]
  definition: string
}
export type NativeCatalogConstraint = {
  schema: string; table: string; name: string; kind: string
  validated: boolean; deferrable: boolean; deferred: boolean; definition: string
}
export type NativeCatalogType = { schema: string; name: string; kind: string; labels: string[] }
export type NativeCatalogInventory = {
  relations: NativeCatalogRelation[]; columns: NativeCatalogColumn[]; indexes: NativeCatalogIndex[]
  constraints: NativeCatalogConstraint[]; types: NativeCatalogType[]
}
export type NativeCatalogStage = 'native_relations' | 'native_columns' | 'native_indexes' | 'native_constraints' | 'native_types'

export type CatalogTriggerDiagnosticDetails = {
  expectedCount: number
  observedCount: number
  expectedIndex: number | null
  matchingCount: number | null
  relationSchemaMatch: boolean | null
  enabledMatch: boolean | null
  functionNameMatch: boolean | null
  functionSchemaMatch: boolean | null
  functionIdentityMatch: boolean | null
  eventMask: number | null
  expectedEventMask: number | null
  attributeCount: number | null
  attributeTypeMatch: boolean | null
  attributeTextShapeMatch: boolean | null
  argumentCount: number | null
  argumentBytes: number | null
  noCondition: boolean | null
  definitionExact: boolean | null
  definitionNormalized: boolean | null
}

const fail = (reason: string): never => {
  const error = new Error(`news_protocol_finalizer:${reason}`)
  Object.defineProperty(error, 'code', { value: reason, enumerable: false })
  throw error
}

function sortBy<T>(values: T[], fields: readonly (keyof T)[]): T[] {
  return values.sort((left, right) => {
    for (const field of fields) {
      const a = String(left[field]), b = String(right[field])
      if (a !== b) return a < b ? -1 : 1
    }
    return 0
  })
}

export function catalogTextArrayMatches(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => typeof value === 'string' && value === expected[index])
}

function stripOuterParens(input: string): string {
  let value = input.trim()
  while (value.startsWith('(') && value.endsWith(')')) {
    let depth = 0, quoted = false, closesAtEnd = false
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === "'") {
        if (quoted && value[i + 1] === "'") { i += 1; continue }
        quoted = !quoted
      } else if (!quoted && value[i] === '(') depth += 1
      else if (!quoted && value[i] === ')') {
        depth -= 1
        if (depth === 0) { closesAtEnd = i === value.length - 1; break }
      }
    }
    if (!closesAtEnd) break
    value = value.slice(1, -1).trim()
  }
  return value
}

export function parseJsonbDefaultLiteral(expression: unknown): string | null {
  if (typeof expression !== 'string') return null
  const match = stripOuterParens(expression).match(/^'((?:''|[^'])*)'\s*::\s*(?:pg_catalog\.)?jsonb$/iu)
  return match?.[1]?.replaceAll("''", "'") ?? null
}

export async function jsonbDefaultLiteralsMatch(client: CatalogClient, expectedExpression: unknown,
  actualExpression: unknown, expectedType: string): Promise<boolean> {
  if (expectedType !== 'jsonb') return false
  const expectedJson = parseJsonbDefaultLiteral(expectedExpression)
  const actualJson = parseJsonbDefaultLiteral(actualExpression)
  if (expectedJson === null || actualJson === null) return false
  const comparison = await client.query('SELECT $1::jsonb = $2::jsonb AS matches', [expectedJson, actualJson])
  return comparison.rows[0]?.matches === true
}

/** Catalog expressions are data: never interpolate/evaluate them as SQL. */
export async function defaultMatches(client: CatalogClient, expectedValue: unknown, actualValue: unknown,
  expectedType: string, generatedSequence?: string): Promise<boolean> {
  if (generatedSequence) {
    if (typeof actualValue !== 'string') return false
    const quoted = generatedSequence.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    return new RegExp(`^nextval\\('(?:public\\.)?"?${quoted}"?'::regclass\\)$`, 'iu').test(stripOuterParens(actualValue))
  }
  if (expectedValue === null || expectedValue === undefined) return actualValue === null || actualValue === undefined
  if (typeof actualValue !== 'string') return false
  const expected = stripOuterParens(String(expectedValue))
  const actual = stripOuterParens(actualValue)
  const compactActual = actual.replace(/\s+/gu, ' ')
  if (expected === 'gen_random_uuid()') return /^gen_random_uuid\(\)(?:::uuid)?$/iu.test(compactActual)
  if (expected === 'now()') return /^now\(\)(?:::(?:timestamp with time zone|timestamptz))?$/iu.test(compactActual)
  if (/^(?:0|[1-9][0-9]*)$/u.test(expected)) {
    return compactActual === expected || new RegExp(`^${expected}::(?:numeric|int[248]|integer|smallint|bigint)$`, 'iu').test(compactActual)
  }
  if (expected === 'false' || expected === 'true') return compactActual === expected || compactActual === `${expected}::boolean`
  const expectedJson = expected.match(/^('(?:''|[^'])*')\s*::\s*jsonb$/iu)?.[1]
  if (expectedJson) return jsonbDefaultLiteralsMatch(client, expected, actual, expectedType)
  const literal = expected.match(/^('(?:''|[^'])*')$/u)?.[1]
  if (literal) {
    const actualLiteral = actual.match(/^('(?:''|[^'])*')(?:\s*::\s*([a-z_][a-z0-9_ ]*))?$/iu)
    if (actualLiteral?.[1] !== literal) return false
    const cast = actualLiteral[2]?.toLowerCase().trim()
    if (!cast) return true
    return expectedType.startsWith('enum_') ? cast === expectedType
      : expectedType === 'varchar' ? cast === 'varchar' || cast === 'character varying'
        : expectedType === 'text' ? cast === 'text' : false
  }
  return compactActual === expected.replace(/\s+/gu, ' ')
}

export type NativeColumnContract = {
  table: string; name: string; type: string; default: unknown; serial: boolean
}

/** The caller supplies the committed snapshot contract, never observed defaults.
 * This low-level reader preserves the historical inventory field/key order. */
export async function readNativeCatalog(client: CatalogClient,
  expectedRelations: readonly NativeCatalogRelation[], expectedColumns: readonly NativeColumnContract[],
  setStage: (stage: NativeCatalogStage) => void = () => {},
): Promise<NativeCatalogInventory> {
  setStage('native_relations')
  // Anchor internal namespace spellings: LIKE would treat underscores as
  // wildcards and hide legal user schemas. Empty user namespaces remain rows.
  const relationsResult = await client.query(`SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
    FROM pg_catalog.pg_namespace n LEFT JOIN pg_catalog.pg_class c
      ON n.oid=c.relnamespace AND c.relkind IN ('r','p','v','m','f','S','c')
    WHERE n.nspname NOT IN ('pg_catalog','information_schema','cms_cluster_guard') AND n.nspname !~ '^pg_toast(_temp_[0-9]+)?$'
      AND n.nspname !~ '^pg_temp_[0-9]+$'
    ORDER BY n.nspname, c.relname, c.relkind`)
  const relations = sortBy(relationsResult.rows.map(row => ({
    schema: String(row.schema), name: String(row.name), kind: String(row.kind),
  })), ['schema', 'name', 'kind'])
  if (JSON.stringify(relations) !== JSON.stringify(expectedRelations)) fail('preauthority_native_relation_inventory_mismatch')

  setStage('native_columns')
  const tables = [...new Set(expectedColumns.map(column => column.table))].sort()
  const columnsResult = await client.query(`SELECT namespace.nspname AS schema, relation.relname AS table_name,
    attribute.attname AS column_name, type.typname AS type_name, type_namespace.nspname AS type_schema,
    attribute.attnotnull AS not_null, pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid) AS default_expression
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
    JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid=relation.oid
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
    JOIN pg_catalog.pg_type type ON type.oid=attribute.atttypid
    JOIN pg_catalog.pg_namespace type_namespace ON type_namespace.oid=type.typnamespace
    LEFT JOIN pg_catalog.pg_attrdef default_value ON default_value.adrelid=relation.oid AND default_value.adnum=attribute.attnum
    WHERE namespace.nspname='public' AND relation.relname = ANY($1::text[])
    ORDER BY namespace.nspname, relation.relname, attribute.attname`, [tables])
  const expectedColumnByKey = new Map(expectedColumns.map(column => [`${column.table}.${column.name}`, column]))
  const columns: NativeCatalogColumn[] = []
  for (const row of columnsResult.rows) {
    const schema = String(row.schema), table = String(row.table_name), name = String(row.column_name)
    const expected = expectedColumnByKey.get(`${table}.${name}`)
    if (!expected) return fail('preauthority_native_column_inventory_mismatch')
    const defaultExpression = row.default_expression === null || row.default_expression === undefined
      ? null : String(row.default_expression)
    const defaultVerified = await defaultMatches(client, expected.default, defaultExpression, expected.type,
      expected.serial ? `${table}_${name}_seq` : undefined)
    columns.push({ schema, table, name, type: String(row.type_name), typeSchema: String(row.type_schema),
      notNull: row.not_null === true, defaultExpression, defaultVerified })
  }
  sortBy(columns, ['schema', 'table', 'name'])

  setStage('native_indexes')
  const indexesResult = await client.query(`SELECT table_ns.nspname AS table_schema, table_class.relname AS table_name,
    index_ns.nspname AS index_schema, index_class.relname AS index_name, ix.indisunique AS is_unique,
    ix.indisprimary AS is_primary, ix.indisvalid AS is_valid, ix.indisready AS is_ready,
    ix.indpred IS NULL AS no_predicate, ix.indexprs IS NULL AS no_expressions,
    ix.indnkeyatts AS key_count, ix.indnatts AS attribute_count, access_method.amname AS method,
    (SELECT COALESCE(json_agg(json_build_object('expression', COALESCE(attribute.attname, ''),
      'isExpression', key.attnum = 0, 'asc', (key.option_value & 1) = 0,
      'nulls', CASE WHEN (key.option_value & 2) = 2 THEN 'first' ELSE 'last' END) ORDER BY key.ordinality), '[]'::json)
      FROM unnest(ix.indkey, ix.indoption) WITH ORDINALITY AS key(attnum, option_value, ordinality)
      LEFT JOIN pg_catalog.pg_attribute attribute ON attribute.attrelid=table_class.oid AND attribute.attnum=key.attnum
      WHERE key.ordinality <= ix.indnkeyatts) AS columns,
    pg_catalog.pg_get_indexdef(index_class.oid) AS definition
    FROM pg_catalog.pg_index ix
    JOIN pg_catalog.pg_class table_class ON table_class.oid=ix.indrelid
    JOIN pg_catalog.pg_namespace table_ns ON table_ns.oid=table_class.relnamespace
    JOIN pg_catalog.pg_class index_class ON index_class.oid=ix.indexrelid
    JOIN pg_catalog.pg_namespace index_ns ON index_ns.oid=index_class.relnamespace
    JOIN pg_catalog.pg_am access_method ON access_method.oid=index_class.relam
    WHERE table_ns.nspname NOT IN ('pg_catalog','information_schema') AND table_ns.nspname !~ '^pg_toast(_temp_[0-9]+)?$'
      AND table_ns.nspname !~ '^pg_temp_[0-9]+$'
    ORDER BY table_ns.nspname, table_class.relname, index_ns.nspname, index_class.relname`)
  const indexes: NativeCatalogIndex[] = sortBy(indexesResult.rows.map(row => ({
    tableSchema: String(row.table_schema), table: String(row.table_name), schema: String(row.index_schema),
    name: String(row.index_name), unique: row.is_unique === true, primary: row.is_primary === true,
    valid: row.is_valid === true, ready: row.is_ready === true,
    noPredicate: row.no_predicate === true, noExpressions: row.no_expressions === true,
    keyCount: Number(row.key_count), attributeCount: Number(row.attribute_count), method: String(row.method),
    columns: Array.isArray(row.columns) ? row.columns.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('native_snapshot_invalid')
      const column = raw as Record<string, unknown>
      return { expression: String(column.expression), isExpression: column.isExpression === true,
        asc: column.asc === true, nulls: String(column.nulls) }
    }) : [],
    definition: String(row.definition),
  })), ['tableSchema', 'table', 'schema', 'name'])

  setStage('native_constraints')
  const constraintsResult = await client.query(`SELECT namespace.nspname AS schema, relation.relname AS table_name,
    con.conname AS constraint_name, con.contype AS kind, con.convalidated AS validated,
    con.condeferrable AS deferrable, con.condeferred AS deferred,
    pg_catalog.pg_get_constraintdef(con.oid, false) AS definition
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class relation ON relation.oid=con.conrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname NOT IN ('pg_catalog','information_schema') AND namespace.nspname !~ '^pg_toast(_temp_[0-9]+)?$'
      AND namespace.nspname !~ '^pg_temp_[0-9]+$'
    ORDER BY namespace.nspname, relation.relname, con.conname, con.contype`)
  const constraints: NativeCatalogConstraint[] = sortBy(constraintsResult.rows.map(row => ({
    schema: String(row.schema), table: String(row.table_name), name: String(row.constraint_name), kind: String(row.kind),
    validated: row.validated === true, deferrable: row.deferrable === true, deferred: row.deferred === true,
    definition: String(row.definition),
  })), ['schema', 'table', 'name', 'kind'])

  setStage('native_types')
  // Exclude only catalog-bound rowtypes and internally dependent arrays, never
  // types by spelling. Standalone composites/domains/ranges remain observable.
  const typesResult = await client.query(`SELECT namespace.nspname AS schema, type.typname AS name, type.typtype AS kind,
    COALESCE(array_agg(enum.enumlabel::text ORDER BY enum.enumsortorder) FILTER (WHERE enum.enumlabel IS NOT NULL), ARRAY[]::text[]) AS labels
    FROM pg_catalog.pg_type type JOIN pg_catalog.pg_namespace namespace ON namespace.oid=type.typnamespace
    LEFT JOIN pg_catalog.pg_enum enum ON enum.enumtypid=type.oid
    LEFT JOIN pg_catalog.pg_class composite_relation ON composite_relation.oid=type.typrelid
    WHERE NOT COALESCE(type.typtype='c' AND composite_relation.relkind IN ('r','p','v','m','f')
        AND composite_relation.reltype=type.oid, false)
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_type element
        JOIN pg_catalog.pg_depend dependency ON dependency.classid='pg_catalog.pg_type'::regclass
          AND dependency.objid=type.oid AND dependency.objsubid=0
          AND dependency.refclassid='pg_catalog.pg_type'::regclass
          AND dependency.refobjid=element.oid AND dependency.refobjsubid=0 AND dependency.deptype='i'
        WHERE type.typtype='b' AND type.typcategory='A'
          AND type.typelem=element.oid AND element.typarray=type.oid)
      AND namespace.nspname NOT IN ('pg_catalog','information_schema') AND namespace.nspname !~ '^pg_toast(_temp_[0-9]+)?$'
      AND namespace.nspname !~ '^pg_temp_[0-9]+$'
    GROUP BY namespace.nspname, type.typname, type.typtype
    ORDER BY namespace.nspname, type.typname, type.typtype`)
  const types: NativeCatalogType[] = sortBy(typesResult.rows.map(row => {
    if (!Array.isArray(row.labels) || row.labels.some(label => typeof label !== 'string')) {
      return fail('preauthority_native_type_inventory_mismatch')
    }
    return { schema: String(row.schema), name: String(row.name), kind: String(row.kind), labels: row.labels }
  }), ['schema', 'name', 'kind'])
  return { relations, columns, indexes, constraints, types }
}

/** Keep the original serialization, including observed fields and object key
 * order. The semantic CHECK normalizer is the existing reviewed parser. */
export function nativeCatalogFingerprint(inventory: NativeCatalogInventory, migrationNames: readonly string[],
  parseCheckDefinition: (definition: string) => unknown): string {
  const constraints = inventory.constraints.map(constraint => ({
    ...constraint,
    definition: constraint.kind === 'c'
      ? parseCheckDefinition(constraint.definition) : constraint.definition,
  }))
  return createHash('sha256').update(JSON.stringify({ migrationNames, ...inventory, constraints })).digest('hex')
}

export function extractCanonicalFunctionBodies(ddl: string, expectedNames: readonly string[]): Map<string, string> {
  if (typeof ddl !== 'string' || expectedNames.length === 0 || new Set(expectedNames).size !== expectedNames.length
    || expectedNames.some(name => !/^[a-z_][a-z0-9_]*$/u.test(name))) fail('canonical_function_inventory_unavailable')

  const declarations = [...ddl.matchAll(/CREATE OR REPLACE FUNCTION\s+public\.([a-z_][a-z0-9_]*)\s*\(/gu)]
  const actualNames = declarations.map(match => match[1]!)
  if (actualNames.length !== expectedNames.length || new Set(actualNames).size !== actualNames.length
    || expectedNames.some(name => !actualNames.includes(name))) fail('canonical_function_inventory_unavailable')

  const result = new Map<string, string>()
  for (const declaration of declarations) {
    const name = declaration[1]!
    const suffix = ddl.slice(declaration.index! + declaration[0].length)
    const asMatch = /\bAS\s+/iu.exec(suffix)
    if (asMatch === null) return fail('canonical_function_inventory_unavailable')
    const bodyStart = asMatch.index + asMatch[0].length
    const dollarQuoteMatch = /^\$(?:[\p{L}_][\p{L}\p{M}\p{N}_]*)?\$/u.exec(suffix.slice(bodyStart))
    if (dollarQuoteMatch === null) return fail('canonical_function_inventory_unavailable')
    const dollarQuote = dollarQuoteMatch[0]!
    const closing = suffix.indexOf(dollarQuote, bodyStart + dollarQuote.length)
    if (closing < 0 || !/^\s*;/u.test(suffix.slice(closing + dollarQuote.length))) {
      fail('canonical_function_inventory_unavailable')
    }
    result.set(name, suffix.slice(bodyStart + dollarQuote.length, closing))
  }
  return result
}

/** Pure body comparison shared by privileged finalizer and future runtime
 * readers. Expected bodies must come from the committed canonical builders.
 * Preserves the finalizer's metadata policy (including the search_path entry
 * check); this alone is not an exhaustive function/ACL or native-plus-V2 check. */
export function assertCanonicalProtocolFunctions(rows: readonly Record<string, unknown>[], expected: ReadonlyMap<string, string>): void {
  if (rows.length !== expected.size || new Set(rows.map(row => row.name)).size !== expected.size
    || rows.some(row => !expected.has(String(row.name)) || row.canonical_signature !== true
      || row.security_definer !== (row.name !== 'owner_news_mutation_guard_stmt')
      || row.owner !== 'cms_control' || !Array.isArray(row.config) || !row.config.includes('search_path=pg_catalog, public')
      || row.source !== expected.get(String(row.name))
      || row.name === 'owner_news_bootstrap_run' && (row.bootstrap_return_shape !== true
        || row.bootstrap_is_strict !== false
        || !catalogTextArrayMatches(row.bootstrap_argument_modes, ['i', 'i', 'i', 'i', 'i', 't'])
        || !catalogTextArrayMatches(row.bootstrap_argument_names, [
          'p_run_id', 'p_manifest_sha256', 'p_source_instance', 'p_source_fingerprint', 'p_authority_epoch', 'id',
        ])))) fail(`canonical_function_mismatch:${rows.map(row => {
        const name = String(row.name)
        const bootstrapReturn = name !== 'owner_news_bootstrap_run' || row.bootstrap_return_shape === true
        const bootstrapStrict = name !== 'owner_news_bootstrap_run' || row.bootstrap_is_strict === false
        const bootstrapModes = name !== 'owner_news_bootstrap_run'
          || catalogTextArrayMatches(row.bootstrap_argument_modes, ['i', 'i', 'i', 'i', 'i', 't'])
        const bootstrapNames = name !== 'owner_news_bootstrap_run'
          || catalogTextArrayMatches(row.bootstrap_argument_names, [
            'p_run_id', 'p_manifest_sha256', 'p_source_instance', 'p_source_fingerprint', 'p_authority_epoch', 'id',
          ])
        return `${name}:sig=${row.canonical_signature === true}:sec=${row.security_definer === (name !== 'owner_news_mutation_guard_stmt')}`
          + `:owner=${row.owner === 'cms_control'}:config=${Array.isArray(row.config) && row.config.includes('search_path=pg_catalog, public')}`
          + `:source=${row.source === expected.get(name)}:return=${bootstrapReturn}:strict=${bootstrapStrict}`
          + `:modes=${bootstrapModes}:names=${bootstrapNames}`
      }).join(',')}`)
}

/** Closed signatures only; never accept SQL expressions from the caller. */
export function protocolOidArraySQL(version: 1 | 2): string {
  if (version !== 1 && version !== 2) return fail('canonical_function_inventory_unavailable')
  const signatures = [
    'public.owner_news_mutation_guard_stmt()', 'public.owner_news_mutation_capture_row()',
    'public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text)',
    'public.owner_news_migration_item_binding_guard()',
    ...(version === 2 ? ['public.owner_news_bootstrap_run(uuid,text,text,text,integer)'] : []),
  ]
  return `ARRAY[${signatures.map(signature => `to_regprocedure('${signature}')::oid`).join(',')}]`
}

/** All public owner_news_ functions, including unknown names/overloads, reach
 * the comparator. Other namespaces/functions need separate inventory checks. */
export async function readProtocolFunctions(client: CatalogClient, version: 1 | 2): Promise<CatalogResult> {
  const approvedProtocolOidArray = protocolOidArraySQL(version)
  return client.query(`SELECT p.proname AS name, p.prosrc AS source, p.prosecdef AS security_definer,
    p.proconfig AS config, r.rolname AS owner, p.oid = ANY(${approvedProtocolOidArray}) AS canonical_signature,
    pg_catalog.pg_get_function_result(p.oid) = 'TABLE(id uuid)' AS bootstrap_return_shape,
    p.proisstrict AS bootstrap_is_strict,
    p.proargmodes::text[] AS bootstrap_argument_modes,
    p.proargnames::text[] AS bootstrap_argument_names
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='public' AND p.proname::text ~ '^owner_news_'`)
}

/** Reads every non-internal trigger on the supplied committed table set, not
 * only expected trigger names. A global inventory remains the caller's job. */
export async function readProtocolTriggers(client: CatalogClient, version: 1 | 2,
  tables: readonly string[]): Promise<CatalogResult> {
  const approvedProtocolOidArray = protocolOidArraySQL(version)
  return client.query(`SELECT t.tgname AS name, c.relname AS relation, n.nspname AS relation_schema,
    t.tgenabled AS enabled, t.tgtype::integer AS event_mask,
    COALESCE(array_length(t.tgattr,1),0)::integer AS attribute_count,
    t.tgattr::text AS attribute_vector_text, pg_catalog.pg_typeof(t.tgattr)::text AS attribute_vector_type,
    t.tgnargs::integer AS argument_count, pg_catalog.octet_length(t.tgargs)::integer AS argument_bytes,
    t.tgqual IS NULL AS no_condition,
    p.proname AS function, p.oid = ANY(${approvedProtocolOidArray}) AS function_identity_approved,
    pn.nspname AS function_schema, pg_catalog.pg_get_triggerdef(t.oid,false) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
    JOIN pg_namespace pn ON pn.oid=p.pronamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname = ANY($1::text[])`, [tables])
}

export function normalizeTriggerDefinition(definition: string): string {
  // Deliberately a closed canonical-header recognizer, not a general SQL
  // normalizer. WHEN/literals/comments/arguments/unsupported syntax remain
  // byte-for-byte untouched, so their whitespace and quotes stay significant.
  // The function qualification is preserved rather than inferred from text;
  // identity-gated comparison may consider its one known deparser variant.
  const match = /^CREATE\s+TRIGGER\s+(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+((?:INSERT|DELETE|UPDATE|TRUNCATE)(?:\s+OR\s+(?:INSERT|DELETE|UPDATE|TRUNCATE))*)\s+ON\s+(?:"public"|public)\.(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))\s+FOR\s+EACH\s+(ROW|STATEMENT)\s+EXECUTE\s+FUNCTION\s+((?:"public"|public)\.)?(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))\s*\(\s*\)\s*$/u.exec(definition)
  if (!match) return definition
  const [, quotedTrigger, plainTrigger, timing, events, quotedRelation, plainRelation,
    level, functionQualifier, quotedFunction, plainFunction] = match
  return `CREATE TRIGGER ${quotedTrigger ?? plainTrigger} ${timing!.replace(/\s+/gu, ' ')} ${events!.replace(/\s+/gu, ' ')}`
    + ` ON public.${quotedRelation ?? plainRelation} FOR EACH ${level}`
    + ` EXECUTE FUNCTION ${functionQualifier ? 'public.' : ''}${quotedFunction ?? plainFunction}()`
}

function triggerDefinitionMatchesAfterFunctionIdentityCheck(actualDefinition: string,
  expectedDefinition: string, verifiedFunctionName: string, identityVerified: boolean): boolean {
  const actual = normalizeTriggerDefinition(actualDefinition)
  const expected = normalizeTriggerDefinition(expectedDefinition)
  if (actual === expected) return true
  if (!identityVerified) return false
  const qualifiedCall = ` EXECUTE FUNCTION public.${verifiedFunctionName}()`
  const unqualifiedCall = ` EXECUTE FUNCTION ${verifiedFunctionName}()`
  const unqualifiedExpected = expected.replace(qualifiedCall, unqualifiedCall)
  return unqualifiedExpected !== expected && actual === unqualifiedExpected
}

type CanonicalTriggerMetadata = {
  relation: string
  name: string
  functionName: string
  eventMask: number
  postgresDefinition: string
}

function parseCanonicalTriggerMetadata(key: string, definition: string): CanonicalTriggerMetadata {
  // Closed canonical grammar: no UPDATE OF list, WHEN expression, transition
  // tables, constraint clauses, or trigger arguments can be silently rewritten.
  const match = /^CREATE TRIGGER ([a-z_][a-z0-9_]*) (BEFORE|AFTER|INSTEAD OF) ([A-Z]+(?: OR [A-Z]+)*) ON public\.([a-z_][a-z0-9_]*) FOR EACH (ROW|STATEMENT) EXECUTE FUNCTION public\.([a-z_][a-z0-9_]*)\(\)$/u.exec(definition)
  if (!match) return fail('canonical_trigger_inventory_unavailable')
  const [, name, timing, eventText, relation, level, functionName] = match
  if (`${relation}.${name}` !== key) return fail('canonical_trigger_inventory_unavailable')
  const eventBits: Record<string, number> = { INSERT: 4, DELETE: 8, UPDATE: 16, TRUNCATE: 32 }
  const events = eventText.split(' OR ')
  if (!events.length || new Set(events).size !== events.length) return fail('canonical_trigger_inventory_unavailable')
  let eventMask = level === 'ROW' ? 1 : 0
  eventMask |= timing === 'BEFORE' ? 2 : timing === 'INSTEAD OF' ? 64 : 0
  for (const event of events) {
    if (!(event in eventBits)) return fail('canonical_trigger_inventory_unavailable')
    eventMask |= eventBits[event]!
  }
  const postgresEventOrder = ['INSERT', 'DELETE', 'UPDATE', 'TRUNCATE']
  const orderedEvents = postgresEventOrder.filter(event => events.includes(event))
  const postgresDefinition = `CREATE TRIGGER ${name} ${timing} ${orderedEvents.join(' OR ')} ON public.${relation}`
    + ` FOR EACH ${level} EXECUTE FUNCTION public.${functionName}()`
  return { relation, name, functionName, eventMask, postgresDefinition }
}

/** Pure comparator; the optional failure sink preserves the finalizer's
 * structured diagnostics without importing its privileged operational code. */
export function assertCanonicalProtocolTriggers(rows: readonly Record<string, unknown>[],
  definitions: ReadonlyMap<string, string>,
  onMismatch: (reason: string, details: CatalogTriggerDiagnosticDetails) => never = fail): void {
  const expectedTriggers = [...definitions].map(([key, definition]) => ({
    key, definition, ...parseCanonicalTriggerMetadata(key, definition),
  }))
  const triggerDetails = (expectedIndex: number | null, matchingCount: number | null,
    row: Record<string, unknown> | undefined, expected: (typeof expectedTriggers)[number] | undefined,
    definitionExact: boolean | null = null, definitionNormalized: boolean | null = null): CatalogTriggerDiagnosticDetails => {
    const attributeVectorText = row?.attribute_vector_text
    return {
      expectedCount: expectedTriggers.length, observedCount: rows.length,
      expectedIndex, matchingCount,
      relationSchemaMatch: row ? row.relation_schema === 'public' : null,
      enabledMatch: row ? row.enabled === 'A' : null,
      functionNameMatch: row && expected ? row.function === expected.functionName : null,
      functionSchemaMatch: row ? row.function_schema === 'public' : null,
      functionIdentityMatch: row ? row.function_identity_approved === true : null,
      eventMask: row && Number.isInteger(row.event_mask) ? Number(row.event_mask) : null,
      expectedEventMask: expected?.eventMask ?? null,
      attributeCount: row && Number.isInteger(row.attribute_count) ? Number(row.attribute_count) : null,
      attributeTypeMatch: row ? row.attribute_vector_type === 'int2vector' : null,
      attributeTextShapeMatch: row ? typeof attributeVectorText === 'string'
        && /^[\s0-9-]*$/u.test(attributeVectorText) : null,
      argumentCount: row && Number.isInteger(row.argument_count) ? Number(row.argument_count) : null,
      argumentBytes: row && Number.isInteger(row.argument_bytes) ? Number(row.argument_bytes) : null,
      noCondition: row ? row.no_condition === true : null,
      definitionExact, definitionNormalized,
    }
  }
  for (let expectedIndex = 0; expectedIndex < expectedTriggers.length; expectedIndex += 1) {
    const expected = expectedTriggers[expectedIndex]!
    const matches = rows.filter(row => row.relation === expected.relation && row.name === expected.name)
    if (matches.length === 0) {
      onMismatch('trigger_key_missing', triggerDetails(expectedIndex, 0, undefined, expected))
    }
    if (matches.length > 1) {
      onMismatch('trigger_key_duplicate', triggerDetails(expectedIndex, matches.length, matches[0], expected))
    }
  }
  if (rows.length !== expectedTriggers.length) {
    onMismatch('trigger_inventory_count_mismatch', triggerDetails(null, null, undefined, undefined))
  }
  for (let expectedIndex = 0; expectedIndex < expectedTriggers.length; expectedIndex += 1) {
    const expected = expectedTriggers[expectedIndex]!
    const row = rows.find(candidate => candidate.relation === expected.relation && candidate.name === expected.name)!
    let details = triggerDetails(expectedIndex, 1, row, expected)
    if (details.relationSchemaMatch !== true) onMismatch('trigger_relation_schema_mismatch', details)
    if (details.enabledMatch !== true) onMismatch('trigger_enabled_state_mismatch', details)
    if (details.functionNameMatch !== true || details.functionIdentityMatch !== true) {
      onMismatch('trigger_function_identity_mismatch', details)
    }
    if (details.functionSchemaMatch !== true) onMismatch('trigger_function_schema_mismatch', details)
    // Identity checks precede the one accepted unqualified deparser variant.
    const definitionExact = row.definition === expected.postgresDefinition
    const definitionNormalized = triggerDefinitionMatchesAfterFunctionIdentityCheck(
      String(row.definition ?? ''), expected.postgresDefinition, expected.functionName,
      details.functionNameMatch === true && details.functionSchemaMatch === true
        && details.functionIdentityMatch === true)
    details = { ...details, definitionExact, definitionNormalized }
    if (details.eventMask !== details.expectedEventMask) onMismatch('trigger_event_mask_mismatch', details)
    if (details.attributeTypeMatch !== true || details.attributeTextShapeMatch !== true) {
      onMismatch('trigger_catalog_type_mismatch', details)
    }
    if (details.attributeCount !== 0) onMismatch('trigger_column_inventory_mismatch', details)
    if (details.argumentCount !== 0 || details.argumentBytes !== 0) {
      onMismatch('trigger_argument_inventory_mismatch', details)
    }
    if (details.noCondition !== true) onMismatch('trigger_condition_mismatch', details)
    if (definitionExact !== true && definitionNormalized !== true) {
      onMismatch('trigger_definition_mismatch', details)
    }
  }
}
