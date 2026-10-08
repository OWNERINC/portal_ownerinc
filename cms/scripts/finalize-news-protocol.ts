import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import nativeSchema from '../src/migrations/20261006_181424_z_owner_news_native.json' with { type: 'json' }
import {
  controlRolesVerificationSQL,
  controlRolesPublicVerificationSQL,
  controlRolesOwnershipVerificationSQL,
  controlRolesNativePrivilegesVerificationSQL,
  runtimeProtocolFunctionsVerifySQL,
  runtimeProtocolPrivilegesVerifySQL,
  grantsSQL,
} from './provision-db'
import { NEWS_MUTATION_LEDGER_DDL, NEWS_MUTATION_TABLES } from '../src/publication/mutation-ledger'
import { buildNewsMutationTriggersDDL } from '../src/publication/mutation-triggers'
import {
  buildNewsMigrationBootstrapRunDDL,
  NEWS_MIGRATION_BOOTSTRAP_RUN_SIGNATURE,
  NEWS_MIGRATION_RUN_BOOTSTRAP_INSERT_COLUMNS,
} from '../src/publication/bootstrap-run'
import {
  newsProtocolObserverOwnershipCatalogPrivilegeVerificationSQL,
  newsProtocolObserverPrivilegesVerificationSQL,
  newsProtocolObserverRoleVerificationSQL,
} from './news-protocol-observer-contract'

const require = createRequire(import.meta.url)
const MIGRATIONS = [
  '20261002_181423_owner_news_initial',
  '20261005_133515_owner_news_media',
  '20261005_151541_owner_news_publication',
  '20261005_220916_owner_news_legacy_history',
  '20261006_181325_a_owner_news_suspend_enum',
  '20261006_181424_z_owner_news_native',
] as const
const LOCK_ID = 7194030
const V1_PROTOCOL_SIGNATURES = [
  'public.owner_news_mutation_guard_stmt()',
  'public.owner_news_mutation_capture_row()',
  'public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text)',
  'public.owner_news_migration_item_binding_guard()',
] as const
const V2_PROTOCOL_SIGNATURES = [...V1_PROTOCOL_SIGNATURES, NEWS_MIGRATION_BOOTSTRAP_RUN_SIGNATURE] as const
const PROTOCOL_FUNCTION_NAMES = [
  'owner_news_mutation_guard_stmt', 'owner_news_mutation_capture_row', 'owner_news_seal_run',
  'owner_news_migration_item_binding_guard', 'owner_news_bootstrap_run',
] as const
function approvedProtocolOidArraySQL(protocolVersion: 1 | 2): string {
  const signatures = protocolVersion === 1 ? V1_PROTOCOL_SIGNATURES : V2_PROTOCOL_SIGNATURES
  return `ARRAY[${signatures.map(signature => `to_regprocedure('${signature}')::oid`).join(',')}]`
}

export const finalizerDiagnosticPhases = [
  'connection-configuration', 'admin-connect', 'transaction-begin', 'transaction-lock',
  'audit-transaction-begin', 'audit-identity', 'audit-transaction-commit',
  'precondition-identity', 'precondition-migrations', 'precondition-relations', 'precondition-columns',
  'precondition-sequences', 'precondition-enums', 'precondition-constraints', 'precondition-indexes',
  'precondition-foreign-keys', 'precondition-control-columns', 'precondition-control-roles',
  'precondition-protocol-inventory', 'precondition-control-ownership', 'precondition-native-privileges',
  'precondition-installed-state', 'precondition-observer-role', 'precondition-observer-privileges',
  'protocol-head-read', 'protocol-ledger-ddl', 'protocol-trigger-ddl', 'protocol-binding-ddl',
  'protocol-grants', 'protocol-bootstrap-ddl', 'verify-installed', 'transaction-commit', 'transaction-rollback',
] as const
export type FinalizerDiagnosticPhase = typeof finalizerDiagnosticPhases[number]
export type FinalizerTriggerDiagnosticDetails = {
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
export type FinalizerFailureDiagnostic = {
  phase: FinalizerDiagnosticPhase
  reason: string
  sqlstate: string | null
  triggerDetails?: FinalizerTriggerDiagnosticDetails
}
export type FinalizerCloseDiagnostic = { phase: 'admin-disconnect'; sqlstate: string | null }
export type FinalizerCloseWarningSink = (diagnostic: FinalizerCloseDiagnostic) => void
export type ProtocolInstallationState = 'empty' | 'v1' | 'v2' | 'partial'

const finalizerDiagnosticReasons = new Set([
  'admin_database_url_required', 'unsafe_admin_database_url', 'unsafe_admin_target',
  'observer_database_url_required', 'unsafe_observer_database_url', 'unsafe_observer_target',
  'observer_role_contract_mismatch', 'observer_privilege_contract_mismatch',
  'observer_visible_ownership_mismatch', 'protocol_not_installed', 'audit_transaction_contract_mismatch',
  'native_migration_ledger_mismatch', 'native_relation_inventory_mismatch', 'mutation_relation_inventory_mismatch',
  'native_column_inventory_mismatch', 'native_serial_sequence_binding_or_configuration_mismatch',
  'native_enum_catalog_mismatch', 'native_required_constraint_missing', 'native_snapshot_index_missing_or_mismatched',
  'native_snapshot_foreign_key_mismatch', 'native_control_column_types_mismatch', 'native_item_run_id_type_mismatch',
  'control_role_contract_mismatch', 'partial_protocol_installation_manual_recovery_required',
  'protocol_upgrade_required', 'protocol_upgrade_requires_v1',
  'unsafe_preinstallation_control_state', 'diagnostic_installed_protocol_deep_check_skipped',
  'ledger_head_invalid_or_coverage_activated', 'canonical_function_mismatch', 'canonical_function_inventory_unavailable',
  'trigger_inventory_count_mismatch', 'trigger_key_missing', 'trigger_key_duplicate',
  'trigger_relation_schema_mismatch', 'trigger_enabled_state_mismatch', 'trigger_function_identity_mismatch',
  'trigger_function_schema_mismatch', 'trigger_event_mask_mismatch', 'trigger_column_inventory_mismatch',
  'trigger_catalog_type_mismatch', 'trigger_argument_inventory_mismatch', 'trigger_condition_mismatch',
  'trigger_definition_mismatch',
  'runtime_verifier_role_switch_failed', 'runtime_protocol_acl_mismatch', 'admin_role_restore_failed',
  'control_role_table_acl_mismatch', 'control_role_column_acl_mismatch', 'control_role_sequence_acl_mismatch',
  'public_function_execute_outside_allowlist', 'protocol_acl_mismatch', 'unexpected_control_owned_objects',
  'database_error',
])
const finalizerFailureDiagnostics = new WeakMap<object, FinalizerFailureDiagnostic>()
const finalizerCloseDiagnostics = new WeakMap<object, FinalizerCloseDiagnostic>()
const finalizerTriggerDiagnosticDetails = new WeakMap<object, FinalizerTriggerDiagnosticDetails>()

function failWithTriggerDiagnostic(reason: string, details: FinalizerTriggerDiagnosticDetails): never {
  const error = new Error(`news_protocol_finalizer:${reason}`)
  Object.defineProperty(error, 'code', { value: reason, enumerable: false })
  finalizerTriggerDiagnosticDetails.set(error, details)
  throw error
}

function safeDiagnosticSqlState(error: unknown): string | null {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return null
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value
    if (typeof code !== 'string' || !/^[0-9A-Z]{5}$/u.test(code) || finalizerDiagnosticReasons.has(code)) return null
    return code
  } catch { return null }
}

function normalizeDiagnosticReason(code: unknown): string {
  if (typeof code !== 'string') return 'database_error'
  const base = code.split(':', 1)[0]
  return finalizerDiagnosticReasons.has(base) ? base : 'database_error'
}

function diagnosticReason(error: unknown): string {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return 'database_error'
  try { return normalizeDiagnosticReason(Object.getOwnPropertyDescriptor(error, 'code')?.value) }
  catch { return 'database_error' }
}

function recordFinalizerFailure(error: unknown, phase: FinalizerDiagnosticPhase) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function') || finalizerFailureDiagnostics.has(error as object)) return
  finalizerFailureDiagnostics.set(error as object, {
    phase: finalizerDiagnosticPhases.includes(phase) ? phase : 'connection-configuration',
    reason: diagnosticReason(error), sqlstate: safeDiagnosticSqlState(error),
    ...(finalizerTriggerDiagnosticDetails.get(error as object)
      ? { triggerDetails: finalizerTriggerDiagnosticDetails.get(error as object)! } : {}),
  })
}

export function getFinalizerFailureDiagnostic(error: unknown): FinalizerFailureDiagnostic | null {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return null
  return finalizerFailureDiagnostics.get(error as object) || null
}

export function formatFinalizerFailureDiagnostic(diagnostic: FinalizerFailureDiagnostic): string {
  const phase = finalizerDiagnosticPhases.includes(diagnostic.phase) ? diagnostic.phase : 'connection-configuration'
  const reason = finalizerDiagnosticReasons.has(diagnostic.reason) ? diagnostic.reason : 'database_error'
  const sqlstate = typeof diagnostic.sqlstate === 'string' && /^[0-9A-Z]{5}$/u.test(diagnostic.sqlstate)
    && !finalizerDiagnosticReasons.has(diagnostic.sqlstate) ? diagnostic.sqlstate : 'none'
  const detail = diagnostic.triggerDetails ? formatFinalizerTriggerDiagnosticDetails(diagnostic.triggerDetails) : ''
  return `CMS news protocol diagnostic: phase=${phase} reason=${reason} sqlstate=${sqlstate}${detail}`
}

function formatFinalizerTriggerDiagnosticDetails(details: FinalizerTriggerDiagnosticDetails): string {
  const integer = (value: number | null) => Number.isSafeInteger(value) ? String(value) : 'none'
  const boolean = (value: boolean | null) => value === true ? 'yes' : value === false ? 'no' : 'none'
  return ` trigger_index=${integer(details.expectedIndex)} expected_count=${integer(details.expectedCount)}`
    + ` observed_count=${integer(details.observedCount)} matched_count=${integer(details.matchingCount)}`
    + ` relation_schema_match=${boolean(details.relationSchemaMatch)} enabled_match=${boolean(details.enabledMatch)}`
    + ` function_name_match=${boolean(details.functionNameMatch)} function_schema_match=${boolean(details.functionSchemaMatch)}`
    + ` function_identity_match=${boolean(details.functionIdentityMatch)}`
    + ` event_mask=${integer(details.eventMask)} expected_event_mask=${integer(details.expectedEventMask)}`
    + ` attribute_count=${integer(details.attributeCount)} attribute_type_match=${boolean(details.attributeTypeMatch)}`
    + ` attribute_text_shape_match=${boolean(details.attributeTextShapeMatch)}`
    + ` argument_count=${integer(details.argumentCount)} argument_bytes=${integer(details.argumentBytes)}`
    + ` no_condition=${boolean(details.noCondition)} definition_exact=${boolean(details.definitionExact)}`
    + ` definition_normalized=${boolean(details.definitionNormalized)}`
}

export function getFinalizerCloseDiagnostic(error: unknown): FinalizerCloseDiagnostic | null {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return null
  return finalizerCloseDiagnostics.get(error as object) || null
}

export function formatFinalizerCloseDiagnostic(diagnostic: FinalizerCloseDiagnostic): string {
  const sqlstate = typeof diagnostic.sqlstate === 'string' && /^[0-9A-Z]{5}$/u.test(diagnostic.sqlstate)
    && !finalizerDiagnosticReasons.has(diagnostic.sqlstate) ? diagnostic.sqlstate : 'none'
  return `CMS news protocol client close warning: phase=admin-disconnect sqlstate=${sqlstate}`
}

export interface DrizzleColumnSnapshot {
  name: string
  type: string
  notNull: boolean
  primaryKey?: boolean
  default?: string | number | boolean
}
export interface DrizzleIndexColumnSnapshot {
  expression: string
  isExpression: boolean
  asc: boolean
  nulls: string
}
export interface DrizzleIndexSnapshot {
  name: string
  isUnique: boolean
  method: string
  columns: readonly DrizzleIndexColumnSnapshot[]
}
export interface DrizzleForeignKeySnapshot {
  name: string
  tableFrom: string
  tableTo: string
  columnsFrom: readonly string[]
  columnsTo: readonly string[]
  onDelete: string
  onUpdate: string
}
export interface DrizzleEnumSnapshot { name: string; schema: string; values: readonly string[] }
export interface DrizzleTableSnapshot {
  name: string
  columns: Readonly<Record<string, DrizzleColumnSnapshot>>
  indexes: Readonly<Record<string, DrizzleIndexSnapshot>>
  foreignKeys: Readonly<Record<string, DrizzleForeignKeySnapshot>>
}
export interface DrizzleNativeSnapshot {
  tables: Readonly<Record<string, DrizzleTableSnapshot>>
  enums: Readonly<Record<string, DrizzleEnumSnapshot>>
}

const fail = (reason: string): never => {
  const error = new Error(`news_protocol_finalizer:${reason}`)
  Object.defineProperty(error, 'code', { value: reason, enumerable: false })
  throw error
}

function objectEntries(value: unknown): [string, unknown][] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail('native_snapshot_invalid')
  return Object.entries(value)
}

function requiredString(record: Readonly<Record<string, unknown>>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) return fail('native_snapshot_invalid')
  return value
}

function stringList(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) {
    const entries: string[] = []
    for (const entry of value) {
      if (typeof entry !== 'string') return fail('native_snapshot_invalid')
      entries.push(entry)
    }
    return entries
  }
  return fail('native_snapshot_invalid')
}

/** Validate the generated JSON at the boundary and normalize Drizzle's accepted
 * scalar-or-array FK column representation into a single typed representation. */
function parseNativeSnapshot(value: unknown): DrizzleNativeSnapshot {
  const root = Object.fromEntries(objectEntries(value))
  const rawTables = Object.fromEntries(objectEntries(root.tables))
  const tables: Record<string, DrizzleTableSnapshot> = {}
  for (const [tableKey, rawTableValue] of Object.entries(rawTables)) {
    const rawTable = Object.fromEntries(objectEntries(rawTableValue))
    const columns: Record<string, DrizzleColumnSnapshot> = {}
    for (const [columnKey, rawColumnValue] of objectEntries(rawTable.columns)) {
      const rawColumn = Object.fromEntries(objectEntries(rawColumnValue))
      const type = requiredString(rawColumn, 'type')
      if (typeof rawColumn.notNull !== 'boolean') return fail('native_snapshot_invalid')
      const column: DrizzleColumnSnapshot = { name: requiredString(rawColumn, 'name'), type, notNull: rawColumn.notNull }
      if (Object.hasOwn(rawColumn, 'primaryKey')) {
        if (typeof rawColumn.primaryKey !== 'boolean') return fail('native_snapshot_invalid')
        column.primaryKey = rawColumn.primaryKey
      }
      if (Object.hasOwn(rawColumn, 'default')) {
        const defaultValue = rawColumn.default
        if (typeof defaultValue !== 'string' && typeof defaultValue !== 'number' && typeof defaultValue !== 'boolean') return fail('native_snapshot_invalid')
        column.default = defaultValue
      }
      columns[columnKey] = column
    }
    const indexes: Record<string, DrizzleIndexSnapshot> = {}
    for (const [indexKey, rawIndexValue] of objectEntries(rawTable.indexes ?? {})) {
      const rawIndex = Object.fromEntries(objectEntries(rawIndexValue))
      if (typeof rawIndex.isUnique !== 'boolean') return fail('native_snapshot_invalid')
      if (!Array.isArray(rawIndex.columns) || rawIndex.columns.length === 0) return fail('native_snapshot_invalid')
      const columns = rawIndex.columns.map(rawColumn => {
        const indexColumn = Object.fromEntries(objectEntries(rawColumn))
        if (typeof indexColumn.isExpression !== 'boolean' || typeof indexColumn.asc !== 'boolean'
          || typeof indexColumn.nulls !== 'string' || !['first', 'last'].includes(indexColumn.nulls)) {
          return fail('native_snapshot_invalid')
        }
        return {
          expression: requiredString(indexColumn, 'expression'), isExpression: indexColumn.isExpression,
          asc: indexColumn.asc, nulls: indexColumn.nulls,
        }
      })
      indexes[indexKey] = {
        name: requiredString(rawIndex, 'name'), method: requiredString(rawIndex, 'method'),
        isUnique: rawIndex.isUnique, columns,
      }
    }
    const foreignKeys: Record<string, DrizzleForeignKeySnapshot> = {}
    for (const [key, rawForeignKeyValue] of objectEntries(rawTable.foreignKeys ?? {})) {
      const rawForeignKey = Object.fromEntries(objectEntries(rawForeignKeyValue))
      foreignKeys[key] = {
        name: requiredString(rawForeignKey, 'name'), tableFrom: requiredString(rawForeignKey, 'tableFrom'),
        tableTo: requiredString(rawForeignKey, 'tableTo'), columnsFrom: stringList(rawForeignKey.columnsFrom),
        columnsTo: stringList(rawForeignKey.columnsTo), onDelete: requiredString(rawForeignKey, 'onDelete'),
        onUpdate: requiredString(rawForeignKey, 'onUpdate'),
      }
    }
    tables[tableKey] = { name: requiredString(rawTable, 'name'), columns, indexes, foreignKeys }
  }
  const enums: Record<string, DrizzleEnumSnapshot> = {}
  for (const [enumKey, rawEnumValue] of objectEntries(root.enums)) {
    const rawEnum = Object.fromEntries(objectEntries(rawEnumValue))
    const values = rawEnum.values
    if (!Array.isArray(values)) return fail('native_snapshot_invalid')
    const enumValues: string[] = []
    for (const entry of values) {
      if (typeof entry !== 'string') return fail('native_snapshot_invalid')
      enumValues.push(entry)
    }
    enums[enumKey] = { name: requiredString(rawEnum, 'name'), schema: requiredString(rawEnum, 'schema'), values: enumValues }
  }
  return { tables, enums }
}

export const nativeSchemaSnapshot = parseNativeSnapshot(nativeSchema)
const expectedColumns = Object.entries(nativeSchemaSnapshot.tables).flatMap(([tableName, table]) => Object.values(table.columns).map(column => ({
  table: tableName.replace(/^public\./u, ''), name: column.name,
  type: ({ varchar: 'varchar', integer: 'int4', serial: 'int4', boolean: 'bool', 'timestamp(3) with time zone': 'timestamptz' } satisfies Record<string, string>)[column.type] ?? column.type,
  notNull: column.notNull,
  serial: column.type === 'serial',
  enumType: column.type.startsWith('enum_'),
  default: 'default' in column ? column.default : null,
})))
const expectedSerials = expectedColumns.filter(column => column.serial).map(column => ({
  table: column.table, column: column.name, sequence: `${column.table}_${column.name}_seq`,
}))
const CONTROL_COLUMNS: Record<string, string> = {
  reconciliation_sequence: 'varchar', reconciliation_chain_sha256: 'varchar',
  reconciliation_sha256: 'varchar', destination_fingerprint: 'varchar',
  unresolved_exceptions: 'jsonb', sealed_sequence: 'varchar',
  sealed_chain_sha256: 'varchar', sealed_at: 'timestamptz',
  activation_epoch: 'numeric', drain_receipt_sha256: 'varchar',
}
const NATIVE_REQUIRED_CONSTRAINTS = [
  'news_migration_runs_manifest_sha256_check', 'news_migration_runs_source_fingerprint_check',
  'news_migration_runs_source_instance_check', 'news_migration_runs_epoch_integer_check',
  'news_migration_runs_reconciliation_sequence_check', 'news_migration_runs_sealed_sequence_check',
  'news_migration_runs_reconciliation_pair_check', 'news_migration_runs_reconciliation_hashes_check',
  'news_migration_runs_exceptions_array_check', 'news_migration_runs_seal_pair_check',
  'news_migration_runs_seal_hashes_check', 'news_migration_seal_complete',
  'news_migration_items_run_uuid_check', 'news_migration_items_manifest_sha256_check',
  'news_migration_items_expected_hash_check', 'news_migration_items_observed_hash_check',
  'news_migration_items_source_identity_check', 'news_migration_items_destination_id_check',
  'news_migration_items_verified_consistency_check', 'news_schedules_actor_uid_check',
  'news_schedules_import_epoch_check', 'news_schedules_snapshot_hash_check',
  'news_schedules_import_provenance_shape_check', 'legacy_news_revisions_metadata_basis_check',
] as const

type SqlToken = { kind: 'word' | 'string' | 'number' | 'operator' | 'punctuation'; value: string }
type SqlExpression = string | boolean | null | SqlExpression[]

function tokenizeSql(input: string): SqlToken[] {
  const tokens: SqlToken[] = []
  for (let index = 0; index < input.length;) {
    const character = input[index]!
    if (/\s/u.test(character)) { index += 1; continue }
    if (character === "'") {
      index += 1
      let value = ''
      let closed = false
      while (index < input.length) {
        if (input[index] === "'" && input[index + 1] === "'") { value += "'"; index += 2; continue }
        if (input[index] === "'") { index += 1; closed = true; break }
        value += input[index++]!
      }
      if (!closed) return fail('native_constraint_definition_unavailable')
      tokens.push({ kind: 'string', value })
      continue
    }
    if (character === '"') {
      index += 1
      let value = ''
      let closed = false
      while (index < input.length) {
        if (input[index] === '"' && input[index + 1] === '"') { value += '"'; index += 2; continue }
        if (input[index] === '"') { index += 1; closed = true; break }
        value += input[index++]!
      }
      if (!closed) return fail('native_constraint_definition_unavailable')
      tokens.push({ kind: 'word', value: value === value.toLowerCase() ? value : `quoted:${value}` })
      continue
    }
    const numeric = /^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/u.exec(input.slice(index))
    if (numeric) {
      tokens.push({ kind: 'number', value: numeric[0] })
      index += numeric[0].length
      continue
    }
    const word = /^[a-z_][a-z0-9_$]*/iu.exec(input.slice(index))
    if (word) {
      tokens.push({ kind: 'word', value: word[0].toLowerCase() })
      index += word[0].length
      continue
    }
    const operator = ['::', '!~*', '~*', '!~', '>=', '<=', '<>', '!=', '||'].find(value => input.startsWith(value, index))
    if (operator) {
      tokens.push({ kind: 'operator', value: operator })
      index += operator.length
      continue
    }
    if ('(),.'.includes(character)) {
      tokens.push({ kind: 'punctuation', value: character })
      index += 1
      continue
    }
    if ('=<>~+-*/%'.includes(character)) {
      tokens.push({ kind: 'operator', value: character })
      index += 1
      continue
    }
    return fail('native_constraint_definition_unavailable')
  }
  return tokens
}

function parseSqlExpression(input: string): SqlExpression {
  const tokens = tokenizeSql(input)
  let position = 0
  const peek = (value?: string): boolean => value === undefined
    ? position < tokens.length : tokens[position]?.value === value
  const take = (): SqlToken => {
    const token = tokens[position]
    if (!token) return fail('native_constraint_definition_unavailable')
    position += 1
    return token
  }
  const expect = (value: string): void => { if (!peek(value)) fail('native_constraint_definition_unavailable'); position += 1 }
  const operation = (name: string, ...args: SqlExpression[]): SqlExpression => [name, ...args]
  const parseOr = (): SqlExpression => {
    let result = parseAnd()
    while (peek('or')) { take(); result = operation('or', result, parseAnd()) }
    return result
  }
  const parseAnd = (): SqlExpression => {
    let result = parseNot()
    while (peek('and')) { take(); result = operation('and', result, parseNot()) }
    return result
  }
  const parseNot = (): SqlExpression => peek('not') ? (take(), operation('not', parseNot())) : parseComparison()
  const parseComparison = (): SqlExpression => {
    const left = parseConcat()
    if (peek('is')) {
      take()
      const negated = peek('not')
      if (negated) take()
      if (peek('distinct')) {
        take()
        expect('from')
        return operation(negated ? 'is-not-distinct-from' : 'is-distinct-from', left, parseConcat())
      }
      if (peek('null')) { take(); return operation(negated ? 'is-not-null' : 'is-null', left) }
      if (peek('true') || peek('false') || peek('unknown')) return operation(negated ? 'is-not' : 'is', left, parseConcat())
      return fail('native_constraint_definition_unavailable')
    }
    if (peek('between')) {
      take()
      const lower = parseConcat()
      expect('and')
      return operation('between', left, lower, parseConcat())
    }
    const operator = tokens[position]?.value
    if (operator && ['=', '<>', '!=', '<', '<=', '>', '>=', '~', '!~', '~*', '!~*'].includes(operator)) {
      take()
      return operation(operator === '!=' ? '<>' : operator, left, parseConcat())
    }
    return left
  }
  const parseConcat = (): SqlExpression => {
    let result = parseAdd()
    while (peek('||')) { take(); result = operation('||', result, parseAdd()) }
    return result
  }
  const parseAdd = (): SqlExpression => {
    let result = parseMultiply()
    while (peek('+') || peek('-')) { const operator = take().value; result = operation(operator, result, parseMultiply()) }
    return result
  }
  const parseMultiply = (): SqlExpression => {
    let result = parseUnary()
    while (peek('*') || peek('/') || peek('%')) { const operator = take().value; result = operation(operator, result, parseUnary()) }
    return result
  }
  const parseUnary = (): SqlExpression => {
    if (peek('+') || peek('-')) { const operator = take().value; return operation(`unary${operator}`, parseUnary()) }
    return parsePostfix()
  }
  const parsePostfix = (): SqlExpression => {
    let result = parsePrimary()
    while (peek('::')) {
      take()
      const typeParts = [take().value]
      if (peek('.')) { take(); typeParts.push(take().value) }
      if (typeParts.at(-1) === 'character' && peek('varying')) typeParts.push(take().value)
      const type = typeParts.join('.')
      const numberLiteral = Array.isArray(result) && result[0] === 'number'
      const stringLiteral = Array.isArray(result) && result[0] === 'string'
      const castType = type.replace(/^(?:pg_catalog|public)\./u, '')
      if (['text', 'varchar', 'character varying'].includes(castType)
        || castType === 'numeric' && numberLiteral
        || expectedEnums.some(entry => entry.name === castType) && stringLiteral) continue
      result = operation(`cast:${castType}`, result)
    }
    return result
  }
  const parsePrimary = (): SqlExpression => {
    if (peek('(')) { take(); const result = parseOr(); expect(')'); return result }
    if (peek('case')) {
      take()
      const base = peek('when') ? null : parseOr()
      const branches: SqlExpression[] = []
      while (peek('when')) {
        take()
        const condition = parseOr()
        expect('then')
        branches.push(operation('when', condition, parseOr()))
      }
      const otherwise = peek('else') ? (take(), parseOr()) : null
      expect('end')
      return operation('case', base, ...branches, operation('else', otherwise))
    }
    const token = take()
    if (token.kind === 'string') return operation('string', token.value)
    if (token.kind === 'number') return operation('number', token.value)
    if (token.kind !== 'word') return fail('native_constraint_definition_unavailable')
    if (token.value === 'null') return null
    if (token.value === 'true') return true
    if (token.value === 'false') return false
    let name = token.value
    while (peek('.')) { take(); name += `.${take().value}` }
    if (!peek('(')) return operation('identifier', name)
    take()
    const args: SqlExpression[] = []
    if (!peek(')')) {
      args.push(parseOr())
      while (peek(',')) { take(); args.push(parseOr()) }
    }
    expect(')')
    return operation('call', name, ...args)
  }
  const expression = parseOr()
  if (position !== tokens.length) return fail('native_constraint_definition_unavailable')
  return expression
}

function extractCheckExpression(definition: string): string {
  const match = /^\s*CHECK\s*\(/iu.exec(definition)
  if (!match) return fail('native_constraint_definition_unavailable')
  const start = match[0].length
  let depth = 1
  let quote: "'" | '"' | null = null
  for (let index = start; index < definition.length; index += 1) {
    const character = definition[index]!
    if (quote) {
      if (character === quote && definition[index + 1] === quote) { index += 1; continue }
      if (character === quote) quote = null
      continue
    }
    if (character === "'" || character === '"') { quote = character; continue }
    if (character === '(') depth += 1
    else if (character === ')' && --depth === 0) {
      if (definition.slice(index + 1).trim() !== '') return fail('native_constraint_definition_unavailable')
      return definition.slice(start, index)
    }
  }
  return fail('native_constraint_definition_unavailable')
}

function extractMigrationCheckExpressions(source: string): ReadonlyMap<string, string> {
  const result = new Map<string, string>()
  const matcher = /ADD\s+CONSTRAINT\s+(?:"([a-z_][a-z0-9_]*)"|([a-z_][a-z0-9_]*))\s+CHECK\s*\(/giu
  for (const match of source.matchAll(matcher)) {
    const name = match[1] ?? match[2]
    const start = match.index! + match[0].length
    let depth = 1
    let quote: "'" | '"' | null = null
    for (let index = start; index < source.length; index += 1) {
      const character = source[index]!
      if (quote) {
        if (character === quote && source[index + 1] === quote) { index += 1; continue }
        if (character === quote) quote = null
        continue
      }
      if (character === "'" || character === '"') { quote = character; continue }
      if (character === '(') depth += 1
      else if (character === ')' && --depth === 0) {
        if (result.has(name!)) return fail('native_snapshot_invalid')
        result.set(name!, source.slice(start, index).trim())
        break
      }
    }
    if (!result.has(name!)) return fail('native_snapshot_invalid')
  }
  if (result.size !== NATIVE_REQUIRED_CONSTRAINTS.length
    || NATIVE_REQUIRED_CONSTRAINTS.some(name => !result.has(name))) return fail('native_snapshot_invalid')
  return result
}

let cachedNativeCheckExpressions: ReadonlyMap<string, string> | undefined

function nativeCheckExpressions(): ReadonlyMap<string, string> {
  if (!cachedNativeCheckExpressions) {
    cachedNativeCheckExpressions = extractMigrationCheckExpressions(readFileSync(
      new URL('../src/migrations/20261006_181424_z_owner_news_native.ts', import.meta.url), 'utf8'))
  }
  return cachedNativeCheckExpressions
}

function normalizeDefinitionTokens(definition: string): string {
  const tokens = tokenizeSql(definition)
  const normalized: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token.kind === 'word' && token.value === 'public' && tokens[index + 1]?.value === '.') {
      index += 1
      continue
    }
    if (token.kind === 'word' && token.value === 'match' && tokens[index + 1]?.value === 'simple') {
      index += 1
      continue
    }
    if (token.kind === 'word' && token.value === 'on' && tokens[index + 1]?.value === 'update'
      && tokens[index + 2]?.value === 'no' && tokens[index + 3]?.value === 'action') { index += 3; continue }
    if (token.kind === 'word' && token.value === 'on' && tokens[index + 1]?.value === 'delete'
      && tokens[index + 2]?.value === 'no' && tokens[index + 3]?.value === 'action') { index += 3; continue }
    normalized.push(`${token.kind}:${token.value}`)
  }
  return JSON.stringify(normalized)
}

function canonicalIndexDefinition(index: DrizzleIndexSnapshot, table: string): string {
  const columns = index.columns.map(column => {
    const expression = column.isExpression ? column.expression : quoteIdentifier(column.expression)
    const direction = column.asc ? '' : ' DESC'
    const nulls = column.asc && column.nulls === 'first' || !column.asc && column.nulls === 'last'
      ? ` NULLS ${column.nulls.toUpperCase()}` : ''
    return `${expression}${direction}${nulls}`
  }).join(', ')
  return `CREATE ${index.isUnique ? 'UNIQUE ' : ''}INDEX ${quoteIdentifier(index.name)} ON public.${quoteIdentifier(table)} USING ${index.method} (${columns})`
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

const expectedIndexes = Object.values(nativeSchemaSnapshot.tables).flatMap(table => Object.values(table.indexes).map(index => ({
  table: table.name, name: index.name, unique: Boolean(index.isUnique), method: index.method,
})))
const expectedForeignKeys = Object.values(nativeSchemaSnapshot.tables).flatMap(table => Object.values(table.foreignKeys).map(key => ({
  name: key.name, from: key.tableFrom, to: key.tableTo, fromColumns: key.columnsFrom, toColumns: key.columnsTo,
  delete: key.onDelete, update: key.onUpdate,
})))
const expectedEnums = Object.values(nativeSchemaSnapshot.enums)
const CONTROL_RUN_UPDATE_COLUMNS = new Set([
  'admission_state', 'activation_epoch', 'drain_receipt_sha256', 'reconciliation_sequence',
  'reconciliation_chain_sha256', 'sealed_sequence', 'sealed_chain_sha256', 'sealed_at',
])
const CONTROL_RUN_INSERT_COLUMNS = new Set<string>(NEWS_MIGRATION_RUN_BOOTSTRAP_INSERT_COLUMNS)
export const NEWS_MIGRATION_ITEM_BINDING_DDL = `
CREATE OR REPLACE FUNCTION public.owner_news_migration_item_binding_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $owner_news_binding$
DECLARE parent_manifest text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(7194030);
  IF TG_TABLE_NAME = 'news_migration_items' THEN
    IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id
      OR NEW.run_id IS DISTINCT FROM OLD.run_id
      OR NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256) THEN
      RAISE EXCEPTION 'owner_news_migration_item_identity_immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.run_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'owner_news_migration_item_run_invalid' USING ERRCODE = '23514';
    END IF;
    SELECT manifest_sha256 INTO parent_manifest FROM public.news_migration_runs
      WHERE id = NEW.run_id::uuid FOR KEY SHARE;
    IF NOT FOUND OR parent_manifest IS DISTINCT FROM NEW.manifest_sha256 THEN
      RAISE EXCEPTION 'owner_news_migration_item_parent_mismatch' USING ERRCODE = '23503';
    END IF;
  ELSIF TG_TABLE_NAME = 'news_migration_runs' THEN
    IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id
      OR NEW.manifest_sha256 IS DISTINCT FROM OLD.manifest_sha256) THEN
      RAISE EXCEPTION 'owner_news_migration_run_identity_immutable' USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'DELETE' AND EXISTS (
      SELECT 1 FROM public.news_migration_items i WHERE i.run_id = OLD.id::text
    ) THEN
      RAISE EXCEPTION 'owner_news_migration_run_has_items' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$owner_news_binding$;
REVOKE ALL ON FUNCTION public.owner_news_migration_item_binding_guard() FROM PUBLIC, cms_runtime;
ALTER FUNCTION public.owner_news_migration_item_binding_guard() OWNER TO cms_control;
GRANT SELECT ON public.news_migration_items TO cms_control;
DROP TRIGGER IF EXISTS owner_news_migration_item_binding_guard ON public.news_migration_items;
CREATE TRIGGER owner_news_migration_item_binding_guard BEFORE INSERT OR UPDATE ON public.news_migration_items
  FOR EACH ROW EXECUTE FUNCTION public.owner_news_migration_item_binding_guard();
ALTER TABLE public.news_migration_items ENABLE ALWAYS TRIGGER owner_news_migration_item_binding_guard;
DROP TRIGGER IF EXISTS owner_news_migration_run_binding_guard ON public.news_migration_runs;
CREATE TRIGGER owner_news_migration_run_binding_guard BEFORE UPDATE OR DELETE ON public.news_migration_runs
  FOR EACH ROW EXECUTE FUNCTION public.owner_news_migration_item_binding_guard();
ALTER TABLE public.news_migration_runs ENABLE ALWAYS TRIGGER owner_news_migration_run_binding_guard;
`

export type QueryResult = { rows: Record<string, unknown>[] }
export type FinalizerClient = {
  connect(): Promise<void>
  end(): Promise<void>
  query(sql: string, values?: unknown[]): Promise<QueryResult>
}

const jsonTables = Object.keys(nativeSchemaSnapshot.tables).map(name => name.replace(/^public\./u, '')).sort()

type NativeCatalogRelation = { schema: string; name: string; kind: string }
type NativeCatalogColumn = {
  schema: string
  table: string
  name: string
  type: string
  typeSchema: string
  notNull: boolean
  defaultExpression: string | null
  defaultVerified: boolean
}
type NativeCatalogIndex = {
  tableSchema: string
  table: string
  schema: string
  name: string
  unique: boolean
  primary: boolean
  valid: boolean
  ready: boolean
  noPredicate: boolean
  noExpressions: boolean
  keyCount: number
  attributeCount: number
  method: string
  columns: readonly { expression: string; isExpression: boolean; asc: boolean; nulls: string }[]
  definition: string
}
type NativeCatalogConstraint = {
  schema: string
  table: string
  name: string
  kind: string
  validated: boolean
  deferrable: boolean
  deferred: boolean
  definition: string
}
type NativeCatalogType = { schema: string; name: string; kind: string; labels: string[] }

const expectedNativeRelations: NativeCatalogRelation[] = [
  ...jsonTables.map(name => ({ schema: 'public', name, kind: 'r' })),
  ...expectedSerials.map(({ sequence }) => ({ schema: 'public', name: sequence, kind: 'S' })),
]

const expectedNativeIndexes: Omit<NativeCatalogIndex, 'valid' | 'ready' | 'noPredicate' | 'noExpressions' | 'keyCount' | 'attributeCount'>[] = [
  ...Object.entries(nativeSchemaSnapshot.tables).flatMap(([_tableName, table]) => Object.values(table.indexes).map(index => ({
    tableSchema: 'public', table: table.name, schema: 'public', name: index.name,
    unique: index.isUnique, primary: false, method: index.method,
    columns: index.columns, definition: canonicalIndexDefinition(index, table.name),
  }))),
  ...Object.entries(nativeSchemaSnapshot.tables).flatMap(([_tableName, table]) => {
    const primaryColumns = Object.values(table.columns).filter(column => column.primaryKey === true)
    if (primaryColumns.length === 0) return []
    if (primaryColumns.length !== 1) return fail('native_snapshot_invalid')
    const index: DrizzleIndexSnapshot = {
      name: `${table.name}_pkey`, isUnique: true, method: 'btree',
      columns: [{ expression: primaryColumns[0]!.name, isExpression: false, asc: true, nulls: 'last' }],
    }
    return [{
      tableSchema: 'public', table: table.name, schema: 'public', name: `${table.name}_pkey`,
      unique: true, primary: true, method: 'btree',
      columns: index.columns, definition: canonicalIndexDefinition(index, table.name),
    }]
  }),
]

const requiredCheckTables: Readonly<Record<string, string>> = Object.fromEntries(NATIVE_REQUIRED_CONSTRAINTS.map(name => {
  if (name === 'news_migration_seal_complete') return [name, 'news_migration_runs']
  const table = jsonTables.filter(candidate => name.startsWith(`${candidate}_`)
    || name === `${candidate}_metadata_basis_check`).sort((left, right) => right.length - left.length)[0]
  if (!table) return fail('native_snapshot_invalid')
  return [name, table]
}))

function expectedNativeConstraints(): NativeCatalogConstraint[] {
  const checkExpressions = nativeCheckExpressions()
  const constraints: NativeCatalogConstraint[] = [
  ...Object.values(nativeSchemaSnapshot.tables).flatMap(table => {
    const primaryColumns = Object.values(table.columns).filter(column => column.primaryKey === true)
    return primaryColumns.length ? [{
      schema: 'public', table: table.name, name: `${table.name}_pkey`, kind: 'p',
      validated: true, deferrable: false, deferred: false,
      definition: `PRIMARY KEY (${primaryColumns.map(column => quoteIdentifier(column.name)).join(', ')})`,
    }] : []
  }),
  ...expectedForeignKeys.map(foreignKey => ({
    schema: 'public', table: foreignKey.from, name: foreignKey.name, kind: 'f',
    validated: true, deferrable: false, deferred: false,
    definition: `FOREIGN KEY (${foreignKey.fromColumns.map(quoteIdentifier).join(', ')}) REFERENCES public.${quoteIdentifier(foreignKey.to)} (${foreignKey.toColumns.map(quoteIdentifier).join(', ')})`
      + (foreignKey.delete.toLowerCase() === 'no action' ? '' : ` ON DELETE ${foreignKey.delete}`)
      + (foreignKey.update.toLowerCase() === 'no action' ? '' : ` ON UPDATE ${foreignKey.update}`),
  })),
  ...NATIVE_REQUIRED_CONSTRAINTS.map(name => ({
    schema: 'public', table: requiredCheckTables[name]!, name, kind: 'c',
    validated: true, deferrable: false, deferred: false,
    definition: `CHECK (${checkExpressions.get(name)!})`,
  })),
  ]
  return sortBy(constraints, ['schema', 'table', 'name', 'kind'])
}

const expectedNativeTypes: NativeCatalogType[] = expectedEnums.map(type => ({
  schema: type.schema, name: type.name, kind: 'e', labels: [...type.values],
}))

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sortBy<T>(values: T[], fields: readonly (keyof T)[]): T[] {
  return values.sort((left, right) => {
    for (const field of fields) {
      const compared = compareText(String(left[field]), String(right[field]))
      if (compared !== 0) return compared
    }
    return 0
  })
}

function compareCatalogInventory<T>(observed: readonly T[], expected: readonly T[], reason: string): void {
  if (JSON.stringify(observed) !== JSON.stringify(expected)) fail(reason)
}

sortBy(expectedNativeRelations, ['schema', 'name', 'kind'])
sortBy(expectedNativeIndexes, ['tableSchema', 'table', 'schema', 'name'])
sortBy(expectedNativeTypes, ['schema', 'name', 'kind'])

export type PreauthorityNativeCatalogInventory = {
  relations: NativeCatalogRelation[]
  columns: NativeCatalogColumn[]
  indexes: NativeCatalogIndex[]
  constraints: NativeCatalogConstraint[]
  types: NativeCatalogType[]
}

export function preauthorityExpectedNativeCatalogInventory(): PreauthorityNativeCatalogInventory {
  return {
    relations: expectedNativeRelations.map(value => ({ ...value })),
    columns: expectedColumns.map(column => ({
      schema: 'public', table: column.table, name: column.name, type: column.type,
      typeSchema: column.enumType ? 'public' : 'pg_catalog', notNull: column.notNull,
      defaultExpression: column.default === null || column.default === undefined ? null : String(column.default),
      defaultVerified: true,
    })).sort((left, right) => compareText(left.schema, right.schema)
      || compareText(left.table, right.table) || compareText(left.name, right.name)),
    indexes: expectedNativeIndexes.map(index => ({
      ...index, valid: true, ready: true, noPredicate: true, noExpressions: true,
      keyCount: index.columns.length, attributeCount: index.columns.length,
      columns: index.columns.map(column => ({ ...column })),
    })),
    constraints: expectedNativeConstraints().map(item => ({ ...item })),
    types: expectedNativeTypes.map(value => ({ ...value, labels: [...value.labels] })),
  }
}

export function assertPreauthorityNativeCatalogInventory(
  inventory: PreauthorityNativeCatalogInventory,
  migrationNames: readonly string[],
): string {
  compareCatalogInventory(inventory.relations, expectedNativeRelations, 'preauthority_native_relation_inventory_mismatch')
  const expected = preauthorityExpectedNativeCatalogInventory()
  if (inventory.columns.length !== expected.columns.length || inventory.columns.some((actual, index) => {
    const reviewed = expected.columns[index]
    return !reviewed || actual.schema !== reviewed.schema || actual.table !== reviewed.table
      || actual.name !== reviewed.name || actual.type !== reviewed.type || actual.typeSchema !== reviewed.typeSchema
      || actual.notNull !== reviewed.notNull || !actual.defaultVerified
  })) fail('preauthority_native_column_inventory_mismatch')
  if (inventory.indexes.length !== expected.indexes.length || inventory.indexes.some((actual, index) => {
    const reviewed = expected.indexes[index]
    return !reviewed || actual.tableSchema !== reviewed.tableSchema || actual.table !== reviewed.table
      || actual.schema !== reviewed.schema || actual.name !== reviewed.name || actual.unique !== reviewed.unique
      || actual.primary !== reviewed.primary || !actual.valid || !actual.ready || !actual.noPredicate || !actual.noExpressions
      || actual.keyCount !== reviewed.keyCount || actual.attributeCount !== reviewed.attributeCount
      || actual.method !== reviewed.method || JSON.stringify(actual.columns) !== JSON.stringify(reviewed.columns)
      || normalizeDefinitionTokens(actual.definition) !== normalizeDefinitionTokens(reviewed.definition)
  })) fail('preauthority_native_index_inventory_mismatch')
  if (inventory.constraints.length !== expected.constraints.length || inventory.constraints.some((actual, index) => {
    const reviewed = expected.constraints[index]
    if (!reviewed || actual.schema !== reviewed.schema || actual.table !== reviewed.table
      || actual.name !== reviewed.name || actual.kind !== reviewed.kind || !actual.validated
      || actual.deferrable || actual.deferred) return true
    if (actual.kind === 'c') {
      try {
        return JSON.stringify(parseSqlExpression(extractCheckExpression(actual.definition)))
          !== JSON.stringify(parseSqlExpression(extractCheckExpression(reviewed.definition)))
      } catch {
        return true
      }
    }
    return normalizeDefinitionTokens(actual.definition) !== normalizeDefinitionTokens(reviewed.definition)
  })) fail('preauthority_native_constraint_inventory_mismatch')
  compareCatalogInventory(inventory.types, expectedNativeTypes, 'preauthority_native_type_inventory_mismatch')
  return createHash('sha256').update(JSON.stringify({ migrationNames, ...inventory })).digest('hex')
}

/** Strict inventory used only for the unsupported protocol-absent phase. The
 * protocol finalizer itself may accept its canonical v1/v2 objects; those are
 * deliberately not passed through this preauthority-only allowlist. */
async function verifyPreauthorityNativeCatalog(client: FinalizerClient, migrationNames: readonly string[]): Promise<string> {
  const relationsResult = await client.query(`SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
      AND n.nspname NOT LIKE 'pg_temp_%' AND c.relkind IN ('r','p','v','m','f','S','c')
    ORDER BY n.nspname, c.relname, c.relkind`)
  const relations = sortBy(relationsResult.rows.map(row => ({
    schema: String(row.schema), name: String(row.name), kind: String(row.kind),
  })), ['schema', 'name', 'kind'])
  compareCatalogInventory(relations, expectedNativeRelations, 'preauthority_native_relation_inventory_mismatch')

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
    ORDER BY namespace.nspname, relation.relname, attribute.attname`, [jsonTables])
  const expectedColumnByKey = new Map(expectedColumns.map(column => [`${column.table}.${column.name}`, column]))
  const columns: NativeCatalogColumn[] = []
  for (const row of columnsResult.rows) {
    const schema = String(row.schema)
    const table = String(row.table_name)
    const name = String(row.column_name)
    const expected = expectedColumnByKey.get(`${table}.${name}`)
    if (!expected) return fail('preauthority_native_column_inventory_mismatch')
    const defaultExpression = row.default_expression === null || row.default_expression === undefined
      ? null : String(row.default_expression)
    const defaultVerified = await defaultMatches(client, expected.default, defaultExpression, expected.type,
      expected.serial ? `${table}_${name}_seq` : undefined)
    columns.push({
      schema, table, name, type: String(row.type_name), typeSchema: String(row.type_schema),
      notNull: row.not_null === true, defaultExpression, defaultVerified,
    })
  }
  sortBy(columns, ['schema', 'table', 'name'])

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
    WHERE table_ns.nspname NOT IN ('pg_catalog','information_schema') AND table_ns.nspname NOT LIKE 'pg_toast%'
      AND table_ns.nspname NOT LIKE 'pg_temp_%'
    ORDER BY table_ns.nspname, table_class.relname, index_ns.nspname, index_class.relname`)
  const indexes: NativeCatalogIndex[] = sortBy(indexesResult.rows.map(row => ({
    tableSchema: String(row.table_schema), table: String(row.table_name), schema: String(row.index_schema),
    name: String(row.index_name), unique: row.is_unique === true, primary: row.is_primary === true,
    valid: row.is_valid === true, ready: row.is_ready === true,
    noPredicate: row.no_predicate === true, noExpressions: row.no_expressions === true,
    keyCount: Number(row.key_count), attributeCount: Number(row.attribute_count), method: String(row.method),
    columns: Array.isArray(row.columns) ? row.columns.map(raw => {
      const column = Object.fromEntries(objectEntries(raw))
      return {
        expression: String(column.expression), isExpression: column.isExpression === true,
        asc: column.asc === true, nulls: String(column.nulls),
      }
    }) : [],
    definition: String(row.definition),
  })), ['tableSchema', 'table', 'schema', 'name'])

  const constraintsResult = await client.query(`SELECT namespace.nspname AS schema, relation.relname AS table_name,
    con.conname AS constraint_name, con.contype AS kind, con.convalidated AS validated,
    con.condeferrable AS deferrable, con.condeferred AS deferred,
    pg_catalog.pg_get_constraintdef(con.oid, false) AS definition
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class relation ON relation.oid=con.conrelid
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
    WHERE namespace.nspname NOT IN ('pg_catalog','information_schema') AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
    ORDER BY namespace.nspname, relation.relname, con.conname, con.contype`)
  const constraints: NativeCatalogConstraint[] = sortBy(constraintsResult.rows.map(row => ({
    schema: String(row.schema), table: String(row.table_name), name: String(row.constraint_name), kind: String(row.kind),
    validated: row.validated === true, deferrable: row.deferrable === true, deferred: row.deferred === true,
    definition: String(row.definition),
  })), ['schema', 'table', 'name', 'kind'])

  const typesResult = await client.query(`SELECT namespace.nspname AS schema, type.typname AS name, type.typtype AS kind,
    COALESCE(array_agg(enum.enumlabel ORDER BY enum.enumsortorder) FILTER (WHERE enum.enumlabel IS NOT NULL), ARRAY[]::name[]) AS labels
    FROM pg_catalog.pg_type type JOIN pg_catalog.pg_namespace namespace ON namespace.oid=type.typnamespace
    LEFT JOIN pg_catalog.pg_enum enum ON enum.enumtypid=type.oid
    LEFT JOIN pg_catalog.pg_class composite_relation ON composite_relation.oid=type.typrelid
    WHERE (type.typrelid=0 AND type.typtype IN ('e','d','r','m')
        OR type.typtype='c' AND composite_relation.relkind='c')
      AND namespace.nspname NOT IN ('pg_catalog','information_schema') AND namespace.nspname NOT LIKE 'pg_toast%'
      AND namespace.nspname NOT LIKE 'pg_temp_%'
    GROUP BY namespace.nspname, type.typname, type.typtype
    ORDER BY namespace.nspname, type.typname, type.typtype`)
  const types: NativeCatalogType[] = sortBy(typesResult.rows.map(row => ({
    schema: String(row.schema), name: String(row.name), kind: String(row.kind),
    labels: Array.isArray(row.labels) ? row.labels.map(String) : [],
  })), ['schema', 'name', 'kind'])
  return assertPreauthorityNativeCatalogInventory({ relations, columns, indexes, constraints, types }, migrationNames)
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

export async function jsonbDefaultLiteralsMatch(client: FinalizerClient, expectedExpression: unknown,
  actualExpression: unknown, expectedType: string): Promise<boolean> {
  if (expectedType !== 'jsonb') return false
  const expectedJson = parseJsonbDefaultLiteral(expectedExpression)
  const actualJson = parseJsonbDefaultLiteral(actualExpression)
  if (expectedJson === null || actualJson === null) return false
  const comparison = await client.query('SELECT $1::jsonb = $2::jsonb AS matches', [expectedJson, actualJson])
  return comparison.rows[0]?.matches === true
}

export const NATIVE_ENUM_CATALOG_SQL = `SELECT t.typname AS name, n.nspname AS schema,
  array_agg(e.enumlabel::text ORDER BY e.enumsortorder)::text[] AS labels,
  EXISTS (SELECT 1 FROM pg_type array_type JOIN pg_namespace array_ns ON array_ns.oid=array_type.typnamespace
    WHERE array_type.oid=t.typarray AND array_type.typelem=t.oid AND array_ns.nspname='public') AS array_binding_valid
  FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace JOIN pg_enum e ON e.enumtypid=t.oid
  WHERE n.nspname='public' AND t.typtype='e' GROUP BY t.oid,n.nspname`

export const NATIVE_FOREIGN_KEYS_CATALOG_SQL = `SELECT con.conname AS name, source.relname AS table_from, target.relname AS table_to,
  ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY key(attnum,ord)
    JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=key.attnum ORDER BY key.ord) AS columns_from,
  ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY key(attnum,ord)
    JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=key.attnum ORDER BY key.ord) AS columns_to,
  con.confdeltype AS delete_code, con.confupdtype AS update_code
  FROM pg_constraint con JOIN pg_namespace n ON n.oid=con.connamespace
  JOIN pg_class source ON source.oid=con.conrelid JOIN pg_class target ON target.oid=con.confrelid
  WHERE n.nspname='public' AND con.contype='f' AND source.relname = ANY($1::text[])`

export function catalogTextArrayMatches(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => typeof value === 'string' && value === expected[index])
}

async function defaultMatches(client: FinalizerClient, expectedValue: unknown, actualValue: unknown,
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
  if (expectedJson) {
    // Parse only strict quoted JSONB constants, then let PostgreSQL compare
    // them. This preserves jsonb semantics and exact numeric precision.
    return jsonbDefaultLiteralsMatch(client, expected, actual, expectedType)
  }
  const literal = expected.match(/^('(?:''|[^'])*')$/u)?.[1]
  if (literal) {
    const actualLiteral = actual.match(/^('(?:''|[^'])*')(?:\s*::\s*([a-z_][a-z0-9_ ]*))?$/iu)
    if (actualLiteral?.[1] !== literal) return false
    const cast = actualLiteral[2]?.toLowerCase().trim()
    if (!cast) return true
    const allowed = expectedType.startsWith('enum_') ? cast === expectedType
      : expectedType === 'varchar' ? cast === 'varchar' || cast === 'character varying'
        : expectedType === 'text' ? cast === 'text' : false
    return allowed
  }
  return compactActual === expected.replace(/\s+/gu, ' ')
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

function functionBodies(ddl: string): Map<string, string> {
  return extractCanonicalFunctionBodies(ddl, [
    'owner_news_mutation_guard_stmt', 'owner_news_mutation_capture_row', 'owner_news_seal_run',
  ])
}

function protocolFunctionBodies(version: 1 | 2): Map<string, string> {
  const expected = functionBodies(buildNewsMutationTriggersDDL())
  expected.set('owner_news_migration_item_binding_guard', bindingBody())
  if (version === 2) {
    const bootstrapBody = extractCanonicalFunctionBodies(buildNewsMigrationBootstrapRunDDL(), ['owner_news_bootstrap_run'])
      .get('owner_news_bootstrap_run')
    if (bootstrapBody === undefined) return fail('canonical_function_inventory_unavailable')
    expected.set('owner_news_bootstrap_run', bootstrapBody)
  }
  return expected
}

function bindingBody(): string {
  return extractCanonicalFunctionBodies(NEWS_MIGRATION_ITEM_BINDING_DDL,
    ['owner_news_migration_item_binding_guard']).get('owner_news_migration_item_binding_guard')
    ?? fail('canonical_function_inventory_unavailable')
}

function makeCanonicalTriggerDefinitions(): ReadonlyMap<string, string> {
  const sql = `${buildNewsMutationTriggersDDL()}\n${NEWS_MIGRATION_ITEM_BINDING_DDL}`
  const definitions = new Map<string, string>()
  const matcher = /CREATE TRIGGER\s+([a-z_][a-z0-9_]*)\s+(BEFORE|AFTER|INSTEAD OF)\s+([A-Z]+(?:\s+OR\s+[A-Z]+)*)\s+ON\s+public\."?([a-z_][a-z0-9_]*)"?\s+FOR EACH\s+(ROW|STATEMENT)\s+EXECUTE FUNCTION\s+public\.([a-z_][a-z0-9_]*)\(\);/giu
  for (const match of sql.matchAll(matcher)) {
    const [, name, timing, events, relation, level, functionName] = match
    const definition = `CREATE TRIGGER ${name} ${timing} ${events} ON public.${relation} FOR EACH ${level} EXECUTE FUNCTION public.${functionName}()`
    definitions.set(`${relation}.${name}`, definition)
  }
  if (definitions.size !== NEWS_MUTATION_TABLES.length * 2 + 2) fail('canonical_trigger_inventory_unavailable')
  return definitions
}

export const canonicalTriggerDefinitions = makeCanonicalTriggerDefinitions()

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

async function checkPreconditions(client: FinalizerClient,
  setPhase: (phase: FinalizerDiagnosticPhase) => void = () => {},
  readOnlyDiagnosis = false,
  collectedFailures?: { phase: FinalizerDiagnosticPhase; reason: string }[],
  observerAudit = false): Promise<ProtocolInstallationState | null> {
  let currentPhase: FinalizerDiagnosticPhase = 'precondition-identity'
  const enter = (phase: FinalizerDiagnosticPhase) => { currentPhase = phase; setPhase(phase) }
  const requireGuard = (condition: boolean, reason: string) => {
    if (condition) return
    if (!collectedFailures) fail(reason)
    collectedFailures!.push({ phase: currentPhase, reason: normalizeDiagnosticReason(reason) })
  }
  enter('precondition-identity')
  const identity = await client.query(`SELECT current_user AS role, session_user AS session_role,
    current_database() AS db, r.rolsuper AS superuser, current_setting('transaction_read_only') AS read_only
    FROM pg_roles r WHERE r.rolname=current_user`)
  const who = identity.rows[0]
  if (observerAudit) {
    requireGuard(who?.role === 'cms_observer' && who.session_role === 'cms_observer'
      && who.db === 'ownerinc_cms' && who.superuser === false && who.read_only === 'on', 'unsafe_observer_target')
    enter('precondition-observer-role')
    const ownershipCatalog = await client.query(newsProtocolObserverOwnershipCatalogPrivilegeVerificationSQL)
    requireGuard(ownershipCatalog.rows[0]?.safe === true, 'observer_role_contract_mismatch')
    const observerRole = await client.query(newsProtocolObserverRoleVerificationSQL)
    requireGuard(observerRole.rows[0]?.safe === true, 'observer_role_contract_mismatch')
    enter('precondition-observer-privileges')
    const observerPrivileges = await client.query(newsProtocolObserverPrivilegesVerificationSQL)
    requireGuard(observerPrivileges.rows[0]?.safe === true, 'observer_privilege_contract_mismatch')
  } else {
    requireGuard(who?.role === 'cms_admin' && who.db === 'ownerinc_cms' && who.superuser === true
      && who.read_only === (readOnlyDiagnosis ? 'on' : 'off'), 'unsafe_admin_target')
  }

  enter('precondition-migrations')
  const ledger = await client.query('SELECT name FROM public.payload_migrations ORDER BY name')
  const applied = ledger.rows.map(row => row.name)
  requireGuard(applied.length === MIGRATIONS.length && !MIGRATIONS.some((name, index) => applied[index] !== name),
    'native_migration_ledger_mismatch')

  enter('precondition-relations')
  const relations = await client.query(`SELECT c.relname AS name, c.relkind AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname = ANY($1::text[])`, [jsonTables])
  const found = new Map(relations.rows.map(row => [row.name, row.kind]))
  requireGuard(jsonTables.length === 46 && found.size === 46 && !jsonTables.some(name => !['r', 'p'].includes(String(found.get(name)))),
    'native_relation_inventory_mismatch')
  requireGuard(NEWS_MUTATION_TABLES.length === 39 && !NEWS_MUTATION_TABLES.some(name => !found.has(name)),
    'mutation_relation_inventory_mismatch')

  enter('precondition-columns')
  const nativeColumns = await client.query(`SELECT c.relname AS table_name, a.attname AS column_name, t.typname AS type,
    tn.nspname AS type_schema, a.attnotnull AS not_null, pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expr
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace tn ON tn.oid=t.typnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relname = ANY($1::text[])`, [jsonTables])
  const actualColumns = new Map(nativeColumns.rows.map(row => [`${String(row.table_name)}.${String(row.column_name)}`, row.type]))
  const actualColumnRows = new Map(nativeColumns.rows.map(row => [`${String(row.table_name)}.${String(row.column_name)}`, row]))
  let columnMismatch: typeof expectedColumns[number] | undefined
  for (const column of expectedColumns) {
    const actual = actualColumnRows.get(`${column.table}.${column.name}`)
    if (!actual || actual.type !== column.type || actual.not_null !== column.notNull
      || actual.type_schema !== (column.enumType ? 'public' : 'pg_catalog')) {
      columnMismatch ??= column
      if (!collectedFailures) break
      continue
    }
    if (!await defaultMatches(client, column.default, actual.default_expr, column.type,
      column.serial ? `${column.table}_${column.name}_seq` : undefined)) {
      columnMismatch ??= column
      if (!collectedFailures) break
    }
  }
  requireGuard(actualColumns.size === expectedColumns.length && !columnMismatch,
    `native_column_inventory_mismatch:${columnMismatch?.table}.${columnMismatch?.name}`)

  enter('precondition-sequences')
  const serialCatalog = await client.query(`SELECT expected.table_name, expected.column_name, expected.sequence_name,
    seq.oid IS NOT NULL AS sequence_present, seqns.nspname AS sequence_schema, seq.relkind AS sequence_kind,
    seq.relpersistence AS sequence_persistence, pg_catalog.pg_get_userbyid(seq.relowner) AS sequence_owner,
    s.seqtypid='int4'::regtype AS integer_sequence, s.seqstart::text AS start_value,
    s.seqincrement::text AS increment_value, s.seqmin::text AS minimum_value,
    s.seqmax::text AS maximum_value, s.seqcache::text AS cache_value, s.seqcycle AS cycles,
    dep.deptype AS ownership_dependency, owner_table.relname AS owned_table,
    owner_table_ns.nspname AS owned_table_schema, owner_attribute.attname AS owned_column,
    pg_catalog.pg_get_userbyid(owner_table.relowner) AS table_owner
    FROM unnest($1::text[],$2::text[],$3::text[]) AS expected(table_name,column_name,sequence_name)
    LEFT JOIN pg_class seq ON seq.relname=expected.sequence_name
    LEFT JOIN pg_namespace seqns ON seqns.oid=seq.relnamespace
    LEFT JOIN pg_sequence s ON s.seqrelid=seq.oid
    LEFT JOIN pg_depend dep ON dep.classid='pg_class'::regclass AND dep.objid=seq.oid
      AND dep.refclassid='pg_class'::regclass AND dep.deptype='a'
    LEFT JOIN pg_class owner_table ON owner_table.oid=dep.refobjid
    LEFT JOIN pg_namespace owner_table_ns ON owner_table_ns.oid=owner_table.relnamespace
    LEFT JOIN pg_attribute owner_attribute ON owner_attribute.attrelid=dep.refobjid AND owner_attribute.attnum=dep.refobjsubid`, [
    expectedSerials.map(item => item.table), expectedSerials.map(item => item.column), expectedSerials.map(item => item.sequence),
  ])
  requireGuard(serialCatalog.rows.length === expectedSerials.length && !expectedSerials.some(expected => {
    const matches = serialCatalog.rows.filter(row => row.table_name === expected.table && row.column_name === expected.column)
    const actual = matches[0]
    return matches.length !== 1 || !actual?.sequence_present || actual.sequence_schema !== 'public'
      || actual.sequence_kind !== 'S' || actual.sequence_persistence !== 'p' || actual.sequence_owner !== 'cms_migrator'
      || actual.integer_sequence !== true || String(actual.start_value) !== '1' || String(actual.increment_value) !== '1'
      || String(actual.minimum_value) !== '1' || String(actual.maximum_value) !== '2147483647'
      || String(actual.cache_value) !== '1' || actual.cycles !== false || actual.ownership_dependency !== 'a'
      || actual.owned_table_schema !== 'public' || actual.owned_table !== expected.table
      || actual.owned_column !== expected.column || actual.table_owner !== 'cms_migrator'
  }), 'native_serial_sequence_binding_or_configuration_mismatch')

  enter('precondition-enums')
  const enumCatalog = await client.query(NATIVE_ENUM_CATALOG_SQL)
  const actualEnums = new Map(enumCatalog.rows.map(row => [row.name, row]))
  requireGuard(actualEnums.size === expectedEnums.length && !expectedEnums.some(expected => {
    const actual = actualEnums.get(expected.name)
    return expected.schema !== 'public' || !actual || actual.schema !== expected.schema
      || !catalogTextArrayMatches(actual.labels, expected.values) || actual.array_binding_valid !== true
  }), 'native_enum_catalog_mismatch')

  enter('precondition-constraints')
  const nativeConstraints = await client.query(`SELECT conname AS name FROM pg_constraint c
    JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND c.conname = ANY($1::text[])`, [NATIVE_REQUIRED_CONSTRAINTS])
  const constraintNames = new Set(nativeConstraints.rows.map(row => row.name))
  requireGuard(!NATIVE_REQUIRED_CONSTRAINTS.some(name => !constraintNames.has(name)), 'native_required_constraint_missing')
  enter('precondition-indexes')
  const indexes = await client.query(`SELECT t.relname AS table_name, i.relname AS index_name,
    ix.indisunique AS is_unique, am.amname AS method
    FROM pg_index ix JOIN pg_class t ON t.oid=ix.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    JOIN pg_class i ON i.oid=ix.indexrelid JOIN pg_am am ON am.oid=i.relam
    WHERE n.nspname='public' AND t.relname = ANY($1::text[])`, [jsonTables])
  const indexRows = new Map(indexes.rows.map(row => [`${String(row.table_name)}.${String(row.index_name)}`, row]))
  requireGuard(!expectedIndexes.some(expected => {
    const actual = indexRows.get(`${expected.table}.${expected.name}`)
    return !actual || actual.is_unique !== expected.unique || actual.method !== expected.method
  }), 'native_snapshot_index_missing_or_mismatched')
  enter('precondition-foreign-keys')
  const foreignKeys = await client.query(NATIVE_FOREIGN_KEYS_CATALOG_SQL, [jsonTables])
  const fkRows = new Map(foreignKeys.rows.map(row => [row.name, row]))
  const actionCode: Record<string, string> = { 'no action': 'a', restrict: 'r', cascade: 'c', 'set null': 'n', 'set default': 'd' }
  requireGuard(fkRows.size === expectedForeignKeys.length && !expectedForeignKeys.some(expected => {
    const actual = fkRows.get(expected.name)
    return !actual || actual.table_from !== expected.from || actual.table_to !== expected.to
      || !catalogTextArrayMatches(actual.columns_from, expected.fromColumns)
      || !catalogTextArrayMatches(actual.columns_to, expected.toColumns)
      || actual.delete_code !== actionCode[expected.delete.toLowerCase()]
      || actual.update_code !== actionCode[expected.update.toLowerCase()]
  }), 'native_snapshot_foreign_key_mismatch')

  enter('precondition-control-columns')
  const columns = await client.query(`SELECT a.attname AS name, t.typname AS type
    FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
    WHERE a.attrelid='public.news_migration_runs'::regclass AND a.attnum > 0 AND NOT a.attisdropped`)
  const actual = new Map(columns.rows.map(row => [row.name, row.type]))
  requireGuard(!Object.entries(CONTROL_COLUMNS).some(([name, type]) => actual.get(name) !== type),
    'native_control_column_types_mismatch')
  const item = await client.query(`SELECT t.typname AS run_id_type FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid
    WHERE a.attrelid='public.news_migration_items'::regclass AND a.attname='run_id' AND a.attnum > 0 AND NOT a.attisdropped`)
  requireGuard(item.rows[0]?.run_id_type === 'varchar', 'native_item_run_id_type_mismatch')

  enter('precondition-control-roles')
  const roles = await client.query(observerAudit ? controlRolesPublicVerificationSQL : controlRolesVerificationSQL)
  requireGuard(roles.rows[0]?.safe === true, 'control_role_contract_mismatch')
  enter('precondition-protocol-inventory')
  const state = await client.query(`SELECT
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('owner_news_mutation_head','owner_news_mutation_events')) AS ledger_relations,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname = ANY($2::name[])) AS protocol_functions,
    (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname::text ~ '^owner_news_' AND NOT p.proname = ANY($2::name[])) AS unexpected_protocol_functions,
    (SELECT count(*) FROM unnest($3::text[]) AS signature(value)
      WHERE pg_catalog.to_regprocedure(signature.value) IS NOT NULL) AS v1_signatures,
    (pg_catalog.to_regprocedure($4::text) IS NOT NULL) AS bootstrap_signature,
     (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND t.tgname IN ('owner_news_mutation_guard_stmt','owner_news_mutation_capture_row','owner_news_migration_item_binding_guard','owner_news_migration_run_binding_guard')) AS protocol_triggers,
    (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname = ANY($1::text[]) AND NOT t.tgisinternal) AS inventory_triggers`,
  [NEWS_MUTATION_TABLES, PROTOCOL_FUNCTION_NAMES, V1_PROTOCOL_SIGNATURES, NEWS_MIGRATION_BOOTSTRAP_RUN_SIGNATURE])
  const stateRow = state.rows[0]
  const empty = Number(stateRow?.ledger_relations) === 0 && Number(stateRow?.protocol_functions) === 0
    && Number(stateRow?.unexpected_protocol_functions) === 0
    && Number(stateRow?.v1_signatures) === 0 && stateRow?.bootstrap_signature === false
    && Number(stateRow?.protocol_triggers) === 0 && Number(stateRow?.inventory_triggers) === 0
  const triggerInventoryComplete = Number(stateRow?.protocol_triggers) === NEWS_MUTATION_TABLES.length * 2 + 2
    && Number(stateRow?.inventory_triggers) === NEWS_MUTATION_TABLES.length * 2 + 2
  const v1 = Number(stateRow?.ledger_relations) === 2 && Number(stateRow?.protocol_functions) === 4
    && Number(stateRow?.unexpected_protocol_functions) === 0
    && Number(stateRow?.v1_signatures) === V1_PROTOCOL_SIGNATURES.length
    && stateRow?.bootstrap_signature === false && triggerInventoryComplete
  const v2 = Number(stateRow?.ledger_relations) === 2 && Number(stateRow?.protocol_functions) === 5
    && Number(stateRow?.unexpected_protocol_functions) === 0
    && Number(stateRow?.v1_signatures) === V1_PROTOCOL_SIGNATURES.length
    && stateRow?.bootstrap_signature === true && triggerInventoryComplete
  requireGuard(empty || v1 || v2, 'partial_protocol_installation_manual_recovery_required')
  if (!empty && !v1 && !v2) return 'partial'
  if ((v1 || v2) && readOnlyDiagnosis && !observerAudit) {
    requireGuard(false, 'diagnostic_installed_protocol_deep_check_skipped')
    return null
  }
  if (v1 || v2) {
    enter('precondition-installed-state')
    await verifyInstalled(client, setPhase, { observerAudit, protocolVersion: v2 ? 2 : 1 })
  }
  else if (observerAudit) {
    fail('protocol_not_installed')
  }
  else {
    for (const [verifier, phase] of [
      [controlRolesOwnershipVerificationSQL, 'precondition-control-ownership'],
      [controlRolesNativePrivilegesVerificationSQL, 'precondition-native-privileges'],
    ] as const) {
      enter(phase)
      const result = await client.query(verifier)
      requireGuard(result.rows[0]?.safe === true, 'unsafe_preinstallation_control_state')
    }
  }
  return empty ? 'empty' : v2 ? 'v2' : 'v1'
}

/** Run only the SELECT-based precondition diagnosis in an already-open
 * server-enforced read-only transaction. This diagnostic intentionally skips
 * deep validation of a complete install; auditNewsProtocolReadOnly reuses that
 * installed-state verifier under the dedicated observer identity. */
export async function diagnoseFinalizerPreconditionsReadOnly(client: FinalizerClient): Promise<readonly FinalizerFailureDiagnostic[]> {
  let phase: FinalizerDiagnosticPhase = 'precondition-identity'
  const findings: { phase: FinalizerDiagnosticPhase; reason: string }[] = []
  try {
    await checkPreconditions(client, next => { phase = next }, true, findings)
    if (!findings.length) return []
    const first = findings[0]!
    const error = new Error(`news_protocol_finalizer:${first.reason}`)
    Object.defineProperty(error, 'code', { value: first.reason, enumerable: false })
    recordFinalizerFailure(error, first.phase)
    const firstDiagnostic = getFinalizerFailureDiagnostic(error)!
    return findings.map(finding => ({
      phase: finding.phase,
      reason: finalizerDiagnosticReasons.has(finding.reason) ? finding.reason : 'database_error',
      sqlstate: firstDiagnostic.sqlstate,
    }))
  } catch (error) {
    recordFinalizerFailure(error, phase)
    throw error
  }
}

/**
 * Read-only native-catalog check for the explicitly unsupported preauthority
 * phase. This reuses the same canonical migration/snapshot/catalog verifier as
 * the one-shot finalizer, but it never installs, upgrades, or certifies protocol
 * coverage. A present or mixed protocol is rejected rather than downgraded.
 */
export async function verifyPreauthorityCatalogReadOnly(client: FinalizerClient): Promise<{
  protocolStatus: 'absent'
  coverageApplicability: 'not-applicable'
  migrationNames: readonly string[]
  migrationFingerprint: string
  nativeCatalogFingerprint: string
}> {
  const state = await checkPreconditions(client, () => {}, true)
  if (state !== 'empty') fail('preauthority_protocol_not_absent')
  const migrationFingerprint = createHash('sha256').update(JSON.stringify(MIGRATIONS)).digest('hex')
  const nativeCatalogFingerprint = await verifyPreauthorityNativeCatalog(client, MIGRATIONS)
  return {
    protocolStatus: 'absent',
    coverageApplicability: 'not-applicable',
    migrationNames: MIGRATIONS,
    migrationFingerprint,
    nativeCatalogFingerprint,
  }
}

async function verifyInstalled(client: FinalizerClient,
  setPhase: (phase: FinalizerDiagnosticPhase) => void = () => {},
  options: { observerAudit?: boolean; protocolVersion: 1 | 2 } = { protocolVersion: 1 }): Promise<void> {
  setPhase('verify-installed')
  const approvedProtocolOidArray = approvedProtocolOidArraySQL(options.protocolVersion)
  const head = await client.query(`SELECT sequence::text AS sequence, chain_sha256, coverage_version, write_barrier,
    barrier_run_id, barrier_epoch, barrier_receipt_sha256 FROM public.owner_news_mutation_head WHERE singleton=true`)
  const coverage = head.rows[0]?.coverage_version
  if (head.rows.length !== 1 || !/^(0|[1-9][0-9]*)$/u.test(String(head.rows[0]?.sequence))
    || !/^[0-9a-f]{64}$/u.test(String(head.rows[0]?.chain_sha256))
    || (coverage !== 0 && !(options.observerAudit && coverage === 1))
     || !['open', 'sealed', 'frozen'].includes(String(head.rows[0]?.write_barrier))) fail('ledger_head_invalid_or_coverage_activated')
  const fns = await client.query(`SELECT p.proname AS name, p.prosrc AS source, p.prosecdef AS security_definer,
    p.proconfig AS config, r.rolname AS owner, p.oid = ANY(${approvedProtocolOidArray}) AS canonical_signature,
    pg_catalog.pg_get_function_result(p.oid) = 'TABLE(id uuid)' AS bootstrap_return_shape,
    p.proisstrict AS bootstrap_is_strict,
    p.proargmodes::text[] = ARRAY['i','i','i','i','i','t']::text[] AS bootstrap_argument_modes,
    p.proargnames = ARRAY['p_run_id','p_manifest_sha256','p_source_instance','p_source_fingerprint',
      'p_authority_epoch','id']::text[] AS bootstrap_argument_names
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='public' AND p.proname = ANY($1::text[])`, [PROTOCOL_FUNCTION_NAMES])
  const expected = protocolFunctionBodies(options.protocolVersion)
  if (fns.rows.length !== expected.size || fns.rows.some(row => row.canonical_signature !== true
    || row.security_definer !== (row.name !== 'owner_news_mutation_guard_stmt')
    || row.owner !== 'cms_control' || !Array.isArray(row.config) || !row.config.includes('search_path=pg_catalog, public')
    || row.source !== expected.get(String(row.name))
    || row.name === 'owner_news_bootstrap_run' && (row.bootstrap_return_shape !== true
      || row.bootstrap_is_strict !== false
      || !catalogTextArrayMatches(row.bootstrap_argument_modes, ['i', 'i', 'i', 'i', 'i', 't'])
      || !catalogTextArrayMatches(row.bootstrap_argument_names, [
        'p_run_id', 'p_manifest_sha256', 'p_source_instance', 'p_source_fingerprint', 'p_authority_epoch', 'id',
      ])))) fail(`canonical_function_mismatch:${fns.rows.map(row => `${String(row.name)}:${row.source === expected.get(String(row.name))}`).join(',')}`)

  const triggers = await client.query(`SELECT t.tgname AS name, c.relname AS relation, n.nspname AS relation_schema,
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
    WHERE n.nspname='public' AND NOT t.tgisinternal AND c.relname = ANY($1::text[])`, [NEWS_MUTATION_TABLES])
  const expectedTriggers = [...canonicalTriggerDefinitions].map(([key, definition]) => ({
    key, definition, ...parseCanonicalTriggerMetadata(key, definition),
  }))
  const triggerDetails = (expectedIndex: number | null, matchingCount: number | null,
    row: Record<string, unknown> | undefined, expected: (typeof expectedTriggers)[number] | undefined,
    definitionExact: boolean | null = null, definitionNormalized: boolean | null = null): FinalizerTriggerDiagnosticDetails => {
    const attributeVectorText = row?.attribute_vector_text
    return {
      expectedCount: expectedTriggers.length, observedCount: triggers.rows.length,
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
    const matches = triggers.rows.filter(row => row.relation === expected.relation && row.name === expected.name)
    if (matches.length === 0) {
      failWithTriggerDiagnostic('trigger_key_missing', triggerDetails(expectedIndex, 0, undefined, expected))
    }
    if (matches.length > 1) {
      failWithTriggerDiagnostic('trigger_key_duplicate', triggerDetails(expectedIndex, matches.length, matches[0], expected))
    }
  }
  if (triggers.rows.length !== expectedTriggers.length) {
    failWithTriggerDiagnostic('trigger_inventory_count_mismatch', triggerDetails(null, null, undefined, undefined))
  }
  for (let expectedIndex = 0; expectedIndex < expectedTriggers.length; expectedIndex += 1) {
    const expected = expectedTriggers[expectedIndex]!
    const row = triggers.rows.find(candidate => candidate.relation === expected.relation && candidate.name === expected.name)!
    let details = triggerDetails(expectedIndex, 1, row, expected)
    if (details.relationSchemaMatch !== true) failWithTriggerDiagnostic('trigger_relation_schema_mismatch', details)
    if (details.enabledMatch !== true) failWithTriggerDiagnostic('trigger_enabled_state_mismatch', details)
    if (details.functionNameMatch !== true || details.functionIdentityMatch !== true) {
      failWithTriggerDiagnostic('trigger_function_identity_mismatch', details)
    }
    if (details.functionSchemaMatch !== true) failWithTriggerDiagnostic('trigger_function_schema_mismatch', details)
    // Catalog name/schema/OID identity is now established. Record the closed
    // text comparison for later structural failures too, without allowing it
    // to bypass any event/attribute/argument/condition guard.
    const definitionExact = row.definition === expected.postgresDefinition
    const definitionNormalized = triggerDefinitionMatchesAfterFunctionIdentityCheck(
      String(row.definition ?? ''), expected.postgresDefinition, expected.functionName,
      details.functionNameMatch === true && details.functionSchemaMatch === true
        && details.functionIdentityMatch === true)
    details = { ...details, definitionExact, definitionNormalized }
    if (details.eventMask !== details.expectedEventMask) failWithTriggerDiagnostic('trigger_event_mask_mismatch', details)
    if (details.attributeTypeMatch !== true || details.attributeTextShapeMatch !== true) {
      failWithTriggerDiagnostic('trigger_catalog_type_mismatch', details)
    }
    if (details.attributeCount !== 0) failWithTriggerDiagnostic('trigger_column_inventory_mismatch', details)
    if (details.argumentCount !== 0 || details.argumentBytes !== 0) {
      failWithTriggerDiagnostic('trigger_argument_inventory_mismatch', details)
    }
    if (details.noCondition !== true) failWithTriggerDiagnostic('trigger_condition_mismatch', details)
    // The catalog identity checks above are prerequisites for this one
    // unqualified public-function rendering variant.
    if (definitionExact !== true && definitionNormalized !== true) {
      failWithTriggerDiagnostic('trigger_definition_mismatch', details)
    }
  }

  let runtimeSafe = false
  if (options.observerAudit) {
    // Shared ACL queries name cms_runtime explicitly. An observer must not
    // change transaction identity to perform this installed-state check.
    const privileges = await client.query(runtimeProtocolPrivilegesVerifySQL)
    const functions = await client.query(runtimeProtocolFunctionsVerifySQL)
    runtimeSafe = privileges.rows[0]?.safe === true && functions.rows[0]?.safe === true
  } else {
    // Preserve the one-shot finalizer's existing runtime-principal verification.
    await client.query('SET LOCAL ROLE cms_runtime')
    try {
      const identity = await client.query('SELECT current_user AS role, current_database() AS db')
      if (identity.rows[0]?.role !== 'cms_runtime' || identity.rows[0]?.db !== 'ownerinc_cms') {
        fail('runtime_verifier_role_switch_failed')
      }
      const privileges = await client.query(runtimeProtocolPrivilegesVerifySQL)
      const functions = await client.query(runtimeProtocolFunctionsVerifySQL)
      runtimeSafe = privileges.rows[0]?.safe === true && functions.rows[0]?.safe === true
    } finally {
      // If a verifier query aborts PostgreSQL's transaction, RESET also errors;
      // the outer transaction rollback restores cms_admin before recovery.
      try { await client.query('RESET ROLE') } catch { /* The caller rolls back the aborted tx. */ }
    }
  }
  if (!runtimeSafe) fail('runtime_protocol_acl_mismatch')
  const restored = await client.query(`SELECT current_user AS role, current_database() AS db,
    r.rolsuper AS superuser FROM pg_roles r WHERE r.rolname=current_user`)
  const expectedConnectionRole = options.observerAudit ? 'cms_observer' : 'cms_admin'
  const expectedSuperuser = options.observerAudit ? false : true
  if (restored.rows[0]?.role !== expectedConnectionRole || restored.rows[0]?.db !== 'ownerinc_cms'
    || restored.rows[0]?.superuser !== expectedSuperuser) {
    fail(options.observerAudit ? 'unsafe_observer_target' : 'admin_role_restore_failed')
  }

  const scope = await client.query(`SELECT c.relname AS relation, c.relkind AS kind, a.attname AS column_name,
    has_table_privilege('cms_control',c.oid,'SELECT') AS control_select,
    has_table_privilege('cms_control',c.oid,'INSERT') AS control_insert,
    has_table_privilege('cms_control',c.oid,'UPDATE') AS control_update,
    has_table_privilege('cms_control',c.oid,'DELETE') AS control_delete,
    has_table_privilege('cms_control',c.oid,'TRUNCATE') AS control_truncate,
    has_table_privilege('cms_control',c.oid,'REFERENCES') AS control_references,
    has_table_privilege('cms_control',c.oid,'TRIGGER') AS control_trigger,
    has_column_privilege('cms_control',c.oid,a.attnum,'SELECT') AS control_column_select,
    has_column_privilege('cms_control',c.oid,a.attnum,'INSERT') AS control_column_insert,
    has_column_privilege('cms_control',c.oid,a.attnum,'UPDATE') AS control_column_update,
    has_column_privilege('cms_control',c.oid,a.attnum,'REFERENCES') AS control_column_references,
    has_table_privilege('cms_controller',c.oid,'SELECT') AS controller_select,
    has_table_privilege('cms_controller',c.oid,'INSERT') AS controller_insert,
    has_table_privilege('cms_controller',c.oid,'UPDATE') AS controller_update,
    has_table_privilege('cms_controller',c.oid,'DELETE') AS controller_delete,
    has_table_privilege('cms_controller',c.oid,'TRUNCATE') AS controller_truncate,
    has_table_privilege('cms_controller',c.oid,'REFERENCES') AS controller_references,
    has_table_privilege('cms_controller',c.oid,'TRIGGER') AS controller_trigger,
    has_column_privilege('cms_controller',c.oid,a.attnum,'SELECT') AS controller_column_select,
    has_column_privilege('cms_controller',c.oid,a.attnum,'INSERT') AS controller_column_insert,
    has_column_privilege('cms_controller',c.oid,a.attnum,'UPDATE') AS controller_column_update,
    has_column_privilege('cms_controller',c.oid,a.attnum,'REFERENCES') AS controller_column_references
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m')`)
  const tablePrivileges = ['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']
  const columnPrivileges = ['select', 'insert', 'update', 'references']
  for (const row of scope.rows) {
    const relation = String(row.relation), column = String(row.column_name)
    const controlAllowed = relation === 'owner_news_mutation_head' || relation === 'owner_news_mutation_events'
      || relation === 'news_migration_runs' || relation === 'news_migration_items'
    for (const privilege of tablePrivileges) {
      const allowed = relation === 'owner_news_mutation_head' ? privilege === 'select' || privilege === 'update'
        : relation === 'owner_news_mutation_events' ? privilege === 'insert'
          : relation === 'news_migration_runs' || relation === 'news_migration_items' ? privilege === 'select' : false
      if (row[`control_${privilege}`] !== allowed || row[`controller_${privilege}`] !== false) fail(`control_role_table_acl_mismatch:${relation}:${privilege}`)
    }
    for (const privilege of columnPrivileges) {
      const allowed = controlAllowed && (relation === 'owner_news_mutation_head' && (privilege === 'select' || privilege === 'update')
        || relation === 'owner_news_mutation_events' && privilege === 'insert'
        || (relation === 'news_migration_runs' || relation === 'news_migration_items') && privilege === 'select'
        || options.protocolVersion === 2 && relation === 'news_migration_runs'
          && privilege === 'insert' && CONTROL_RUN_INSERT_COLUMNS.has(column)
        || relation === 'news_migration_runs' && privilege === 'update' && CONTROL_RUN_UPDATE_COLUMNS.has(column))
      if (row[`control_column_${privilege}`] !== allowed || row[`controller_column_${privilege}`] !== false) fail(`control_role_column_acl_mismatch:${relation}:${column}:${privilege}`)
    }
  }
  const sequences = await client.query(`SELECT c.relname AS relation,
    has_sequence_privilege('cms_control',c.oid,'USAGE') AS control_usage,
    has_sequence_privilege('cms_control',c.oid,'SELECT') AS control_select,
    has_sequence_privilege('cms_control',c.oid,'UPDATE') AS control_update,
    has_sequence_privilege('cms_controller',c.oid,'USAGE') AS controller_usage,
    has_sequence_privilege('cms_controller',c.oid,'SELECT') AS controller_select,
    has_sequence_privilege('cms_controller',c.oid,'UPDATE') AS controller_update
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='S'`)
  if (sequences.rows.some(row => row.control_usage !== false || row.control_select !== false || row.control_update !== false
    || row.controller_usage !== false || row.controller_select !== false || row.controller_update !== false)) fail('control_role_sequence_acl_mismatch')
  const observerFunctionProjection = options.observerAudit
    ? `has_function_privilege('cms_observer',p.oid,'EXECUTE') AS observer_execute`
    : `false AS observer_execute`
  const publicFunctionScope = await client.query(`SELECT p.oid = ANY(${approvedProtocolOidArray}) AS approved_function,
    p.oid = to_regprocedure('public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text)')::oid AS approved_seal,
    p.oid = to_regprocedure('${NEWS_MIGRATION_BOOTSTRAP_RUN_SIGNATURE}')::oid AS approved_bootstrap,
    p.oid = to_regprocedure('public.gen_random_uuid()')::oid AS expected_pgcrypto_signature,
    EXISTS (SELECT 1 FROM pg_depend extension_dependency
        JOIN pg_extension extension ON extension.oid=extension_dependency.refobjid
        WHERE extension_dependency.classid='pg_proc'::regclass AND extension_dependency.objid=p.oid
          AND extension_dependency.refclassid='pg_extension'::regclass AND extension_dependency.deptype='e'
          AND extension.extname='pgcrypto') AS pgcrypto_extension_member,
    p.prosecdef AS security_definer,
    p.prorettype='pg_catalog.uuid'::regtype AS returns_uuid,
    EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl
      WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute,
    has_function_privilege('cms_control',p.oid,'EXECUTE') AS control_execute,
    has_function_privilege('cms_controller',p.oid,'EXECUTE') AS controller_execute,
    has_function_privilege('cms_runtime',p.oid,'EXECUTE') AS runtime_execute,
    ${observerFunctionProjection}
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'`)
  const approvedFunctionRows = publicFunctionScope.rows.filter(row => row.approved_function === true)
  if (approvedFunctionRows.length !== (options.protocolVersion === 2 ? V2_PROTOCOL_SIGNATURES.length : V1_PROTOCOL_SIGNATURES.length)
    || publicFunctionScope.rows.some(row => {
    const trustedBaseline = row.expected_pgcrypto_signature === true
      && row.pgcrypto_extension_member === true && row.security_definer === false && row.returns_uuid === true
    if (row.public_execute === true && !trustedBaseline) return true
    // to_regprocedure() yields SQL NULL when this optional public pgcrypto
    // signature is absent. The observer's expected privilege is true only for
    // that exact recognized baseline; coerce the nullable identity result
    // before comparing the driver's boolean privilege value.
    if (options.observerAudit && row.observer_execute !== (row.expected_pgcrypto_signature === true)) return true
    return row.runtime_execute !== row.public_execute
      || row.control_execute !== (row.approved_function === true || row.public_execute === true)
      || row.controller_execute !== (row.approved_seal === true || row.approved_bootstrap === true || row.public_execute === true)
  })) fail('public_function_execute_outside_allowlist')
  const acl = await client.query(`SELECT
    has_table_privilege('cms_runtime','public.owner_news_mutation_head','SELECT') AS head_read,
    has_table_privilege('cms_runtime','public.owner_news_mutation_head','UPDATE') AS head_write,
    has_table_privilege('cms_runtime','public.owner_news_mutation_events','SELECT') AS events_read,
    has_table_privilege('cms_runtime','public.owner_news_mutation_events','INSERT') AS events_write,
    has_function_privilege('cms_controller','public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text)','EXECUTE') AS controller_seal,
    has_function_privilege('cms_runtime','public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text)','EXECUTE') AS runtime_seal,
    has_function_privilege('cms_controller',to_regprocedure('${NEWS_MIGRATION_BOOTSTRAP_RUN_SIGNATURE}')::oid,'EXECUTE') AS controller_bootstrap,
    has_function_privilege('cms_runtime',to_regprocedure('${NEWS_MIGRATION_BOOTSTRAP_RUN_SIGNATURE}')::oid,'EXECUTE') AS runtime_bootstrap,
    EXISTS (SELECT 1 FROM pg_proc bootstrap WHERE bootstrap.oid=to_regprocedure('${NEWS_MIGRATION_BOOTSTRAP_RUN_SIGNATURE}')::oid
      AND EXISTS (SELECT 1 FROM aclexplode(COALESCE(bootstrap.proacl,acldefault('f',bootstrap.proowner))) acl
        WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE')) AS public_bootstrap,
    ${options.observerAudit
    ? `has_function_privilege('cms_observer',to_regprocedure('${NEWS_MIGRATION_BOOTSTRAP_RUN_SIGNATURE}')::oid,'EXECUTE') AS observer_bootstrap`
    : 'false AS observer_bootstrap'}`)
  const a = acl.rows[0]
  if (!a?.head_read || a.head_write || !a.events_read || a.events_write || !a.controller_seal || a.runtime_seal) fail('protocol_acl_mismatch')
  if (options.protocolVersion === 2 && (!a.controller_bootstrap || a.runtime_bootstrap || a.public_bootstrap
    || options.observerAudit && a.observer_bootstrap)) fail('protocol_acl_mismatch')

  const ownership = await client.query(`SELECT
      (SELECT count(*) FROM pg_shdepend d JOIN pg_roles r ON r.oid=d.refobjid
        WHERE d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND d.refclassid='pg_authid'::regclass AND d.deptype='o' AND r.rolname='cms_control'
        AND (d.classid <> 'pg_proc'::regclass OR d.objid <> ALL(${approvedProtocolOidArray}))) AS unexpected_control_objects,
     (SELECT count(*) FROM pg_shdepend d JOIN pg_roles r ON r.oid=d.refobjid
      WHERE d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND d.refclassid='pg_authid'::regclass AND d.deptype='o' AND r.rolname='cms_control'
        AND d.classid='pg_proc'::regclass AND d.objid = ANY(${approvedProtocolOidArray})) AS approved_control_objects,
     (SELECT count(*) FROM pg_shdepend d JOIN pg_roles r ON r.oid=d.refobjid
      WHERE d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND d.refclassid='pg_authid'::regclass AND d.deptype='o' AND r.rolname='cms_controller') AS controller_owned_objects,
     (SELECT count(*) FROM pg_shdepend d JOIN pg_roles r ON r.oid=d.refobjid
      WHERE d.dbid=0 AND d.refclassid='pg_authid'::regclass AND d.deptype='o' AND r.rolname='cms_control') AS control_shared_owned_objects,
       (SELECT count(*) FROM pg_shdepend d JOIN pg_roles r ON r.oid=d.refobjid
         WHERE d.dbid=0 AND d.refclassid='pg_authid'::regclass AND d.deptype='o' AND r.rolname='cms_controller') AS controller_shared_owned_objects`)
  const owned = ownership.rows[0]
  if (Number(owned?.unexpected_control_objects) !== 0
    || Number(owned?.approved_control_objects) !== (options.protocolVersion === 2 ? V2_PROTOCOL_SIGNATURES.length : V1_PROTOCOL_SIGNATURES.length)
    || Number(owned?.controller_owned_objects) !== 0 || Number(owned?.control_shared_owned_objects) !== 0
    || Number(owned?.controller_shared_owned_objects) !== 0) {
    fail(options.observerAudit ? 'observer_visible_ownership_mismatch' : 'unexpected_control_owned_objects')
  }
}

export type NewsProtocolAuditReport = {
  status: 'PASS'
  installed: true
  catalogValid: true
  targetDatabase: 'ownerinc_cms'
  observerRole: 'cms_observer'
  observedProtocolVersion: 1 | 2
  observedCoverageVersion: 0 | 1
  headSequence: string
  writeBarrier: 'open' | 'sealed' | 'frozen'
  ready: false
  admissionActivated: false
  releaseCertified: false
  writeCoverageCertified: false
  drainVerified: false
  passwordPresenceCheck: 'not_performed_unprivileged'
  clusterSharedOwnershipCheck: 'performed_read_only_pg_shdepend_check'
  physicalClusterIdentity: 'not_verified'
}

/**
 * Read-only audit of a fully installed protocol. The caller supplies an
 * explicitly configured cms_observer connection; this function starts the
 * server-enforced read-only snapshot before reading catalog state. It does not
 * install, repair, lock, activate, seal, or certify release/coverage.
 */
export async function auditNewsProtocolReadOnly(client: FinalizerClient): Promise<NewsProtocolAuditReport> {
  let phase: FinalizerDiagnosticPhase = 'audit-transaction-begin'
  let transactionOpen = false
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transactionOpen = true
    phase = 'audit-identity'
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query('SET LOCAL search_path = pg_catalog, public')
    const transaction = await client.query(`SELECT current_setting('transaction_read_only') AS read_only,
      current_setting('transaction_isolation') AS isolation,
      current_setting('search_path') AS search_path,
      current_setting('statement_timeout')::interval > interval '0 seconds'
        AND current_setting('statement_timeout')::interval <= interval '5 seconds' AS bounded_timeout`)
    const tx = transaction.rows[0]
    if (tx?.read_only !== 'on' || tx.isolation !== 'repeatable read' || tx.search_path !== 'pg_catalog, public'
      || tx.bounded_timeout !== true) {
      fail('audit_transaction_contract_mismatch')
    }

    const protocolState = await checkPreconditions(client, next => { phase = next }, true, undefined, true)
    if (protocolState !== 'v1' && protocolState !== 'v2') fail('protocol_not_installed')

    const head = await client.query(`SELECT sequence::text AS sequence, coverage_version, write_barrier
      FROM public.owner_news_mutation_head WHERE singleton=true`)
    const row = head.rows[0]
    if (head.rows.length !== 1 || !/^(0|[1-9][0-9]*)$/u.test(String(row?.sequence))
      || (row?.coverage_version !== 0 && row?.coverage_version !== 1)
      || !['open', 'sealed', 'frozen'].includes(String(row?.write_barrier))) fail('ledger_head_invalid_or_coverage_activated')

    phase = 'audit-transaction-commit'
    await client.query('COMMIT')
    transactionOpen = false
    return {
      status: 'PASS', installed: true, catalogValid: true, targetDatabase: 'ownerinc_cms', observerRole: 'cms_observer',
      observedProtocolVersion: protocolState === 'v2' ? 2 : 1,
      observedCoverageVersion: row.coverage_version as 0 | 1, headSequence: String(row.sequence),
      writeBarrier: row.write_barrier as NewsProtocolAuditReport['writeBarrier'],
      ready: false, admissionActivated: false, releaseCertified: false, writeCoverageCertified: false, drainVerified: false,
      passwordPresenceCheck: 'not_performed_unprivileged',
      clusterSharedOwnershipCheck: 'performed_read_only_pg_shdepend_check',
      physicalClusterIdentity: 'not_verified',
    }
  } catch (error) {
    recordFinalizerFailure(error, phase)
    if (transactionOpen) {
      try { await client.query('ROLLBACK') } catch { /* Preserve the sanitized primary diagnostic. */ }
    }
    throw error
  }
}

type ProtocolFinalizerOperation = 'finalize' | 'upgrade-v1-to-v2'

async function runProtocolFinalizerOperation(client: FinalizerClient, operation: ProtocolFinalizerOperation):
Promise<{ installed: boolean; ready: false; coverageVersion: 0 }> {
  let phase: FinalizerDiagnosticPhase = 'transaction-begin'
  let committed = false
  try {
    await client.query('BEGIN')
    // Canonical DDL contains some unqualified PostgreSQL types and creates the
    // integration ledger with an unqualified table name. Pin resolution before
    // any catalog-dependent DDL so caller/database URL settings cannot redirect
    // object creation or type lookup.
    await client.query('SET LOCAL search_path = pg_catalog, public')
    phase = 'transaction-lock'
    await client.query(`SELECT pg_catalog.pg_advisory_xact_lock(${LOCK_ID})`)
    const protocolState = await checkPreconditions(client, next => { phase = next })
    if (protocolState === null || protocolState === 'partial') fail('partial_protocol_installation_manual_recovery_required')

    if (operation === 'finalize' && protocolState === 'v1') {
      fail('protocol_upgrade_required')
    }
    if (operation === 'upgrade-v1-to-v2' && protocolState === 'empty') {
      fail('protocol_upgrade_requires_v1')
    }

    if (operation === 'finalize' && protocolState === 'empty') {
      phase = 'protocol-ledger-ddl'
      await client.query(NEWS_MUTATION_LEDGER_DDL)
      phase = 'protocol-trigger-ddl'
      await client.query(buildNewsMutationTriggersDDL())
      phase = 'protocol-binding-ddl'
      await client.query(NEWS_MIGRATION_ITEM_BINDING_DDL)
      phase = 'protocol-grants'
      await client.query(grantsSQL)
      phase = 'protocol-bootstrap-ddl'
      await client.query(buildNewsMigrationBootstrapRunDDL())
      await verifyInstalled(client, next => { phase = next }, { protocolVersion: 2 })
    } else if (operation === 'upgrade-v1-to-v2' && protocolState === 'v1') {
      phase = 'protocol-bootstrap-ddl'
      await client.query(buildNewsMigrationBootstrapRunDDL())
      await verifyInstalled(client, next => { phase = next }, { protocolVersion: 2 })
    }
    phase = 'transaction-commit'
    await client.query('COMMIT')
    committed = true
    return { installed: operation === 'finalize' && protocolState === 'empty', ready: false, coverageVersion: 0 }
  } catch (error) {
    recordFinalizerFailure(error, phase)
    if (!committed) {
      try { await client.query('ROLLBACK') } catch { /* Keep original failure; connection is discarded below. */ }
    }
    throw error
  }
}

export async function finalizeNewsProtocol(client: FinalizerClient): Promise<{ installed: boolean; ready: false; coverageVersion: 0 }> {
  return runProtocolFinalizerOperation(client, 'finalize')
}

export async function upgradeNewsProtocolV1ToV2(client: FinalizerClient): Promise<{ installed: boolean; ready: false; coverageVersion: 0 }> {
  return runProtocolFinalizerOperation(client, 'upgrade-v1-to-v2')
}

export type ProtocolFinalizerCommand = 'finalize' | 'upgrade-v1-to-v2'

/** One exact, single-purpose command flag is required; no default can turn an
 * ordinary finalizer invocation into an upgrade. */
export function parseProtocolFinalizerArguments(args: readonly string[]): ProtocolFinalizerCommand | null {
  if (args.length !== 1) return null
  if (args[0] === '--finalize-protocol') return 'finalize'
  if (args[0] === '--upgrade-protocol-v1-to-v2') return 'upgrade-v1-to-v2'
  return null
}

async function runAdminProtocolOperation(operation: ProtocolFinalizerOperation,
  env: Record<string, string | undefined>,
  suppliedClient?: FinalizerClient,
  reportCloseWarning: FinalizerCloseWarningSink = diagnostic => console.error(formatFinalizerCloseDiagnostic(diagnostic))
): Promise<{ installed: boolean; ready: false; coverageVersion: 0 }> {
  let phase: FinalizerDiagnosticPhase = 'connection-configuration'
  const raw = env.CMS_ADMIN_DATABASE_URL
  let url: URL
  let client: FinalizerClient | undefined
  let operationFailed = false
  let primaryError: unknown
  let result: { installed: boolean; ready: false; coverageVersion: 0 } | undefined
  try {
    try { url = new URL(raw || '') } catch { fail('admin_database_url_required') }
    if (!['postgres:', 'postgresql:'].includes(url!.protocol) || url!.pathname !== '/ownerinc_cms'
      || decodeURIComponent(url!.username) !== 'cms_admin' || !url!.password) fail('unsafe_admin_database_url')
    const { Client } = require('pg') as { Client: new (options: object) => FinalizerClient }
    client = suppliedClient ?? new Client({ connectionString: url!.href, connectionTimeoutMillis: 5000 })
    phase = 'admin-connect'
    await client.connect()
    result = await runProtocolFinalizerOperation(client, operation)
  } catch (error) {
    recordFinalizerFailure(error, phase)
    operationFailed = true
    primaryError = error
  }

  if (client) {
    try {
      await client.end()
    } catch (closeError) {
      const closeDiagnostic: FinalizerCloseDiagnostic = { phase: 'admin-disconnect', sqlstate: safeDiagnosticSqlState(closeError) }
      if (operationFailed && primaryError !== null && primaryError !== undefined
        && (typeof primaryError === 'object' || typeof primaryError === 'function')) {
        finalizerCloseDiagnostics.set(primaryError as object, closeDiagnostic)
      }
      try { reportCloseWarning(closeDiagnostic) } catch { /* A nonfatal reporting failure must not alter operation outcome. */ }
    }
  }

  if (operationFailed) throw primaryError
  if (!result) return fail('database_error')
  return result
}

export async function runFinalizer(env: Record<string, string | undefined> = process.env,
  suppliedClient?: FinalizerClient,
  reportCloseWarning?: FinalizerCloseWarningSink
): Promise<{ installed: boolean; ready: false; coverageVersion: 0 }> {
  return runAdminProtocolOperation('finalize', env, suppliedClient, reportCloseWarning)
}

export async function runProtocolV1Upgrade(env: Record<string, string | undefined> = process.env,
  suppliedClient?: FinalizerClient,
  reportCloseWarning?: FinalizerCloseWarningSink
): Promise<{ installed: boolean; ready: false; coverageVersion: 0 }> {
  return runAdminProtocolOperation('upgrade-v1-to-v2', env, suppliedClient, reportCloseWarning)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = parseProtocolFinalizerArguments(process.argv.slice(2))
  if (command === null) {
    console.error('CMS news protocol finalizer requires exactly one of --finalize-protocol or --upgrade-protocol-v1-to-v2 and CMS_ADMIN_DATABASE_URL')
    process.exitCode = 2
  } else {
    const run = command === 'finalize' ? runFinalizer : runProtocolV1Upgrade
    run().then(result => {
      console.log(JSON.stringify({ ...result, message: 'protocol operation complete; native writes and readiness remain disabled' }))
    }).catch(error => {
      console.error('CMS news protocol finalization failed; inspect target privately and use manual recovery for partial state')
      const diagnostic = getFinalizerFailureDiagnostic(error)
      if (diagnostic) console.error(formatFinalizerFailureDiagnostic(diagnostic))
      process.exitCode = 1
    })
  }
}
