import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertProtocolFunctionContract, verifyProtocolFunctionContract, PROTOCOL_FUNCTION_CATALOG_SQL,
  PROTOCOL_REQUIRED_RELATIONS_SQL, PROTOCOL_TRIGGER_RESIDUE_SQL,
  PROTOCOL_TRIGGER_EXECUTE_GRANT_SQL, PROTOCOL_TRIGGER_EXECUTE_REVOKE_SQL,
} from '../../src/database/protocol-function-contract'

const names = ['owner_news_mutation_guard_stmt', 'owner_news_mutation_capture_row', 'owner_news_seal_run',
  'owner_news_migration_item_binding_guard', 'owner_news_bootstrap_run']
const grant = (grantee: string) => ({ grantor: 'cms_control', grantee, privilege: 'EXECUTE', grantable: false })
function functions(version = 2) {
  return names.slice(0, version === 1 ? 4 : 5).map((name, index) => ({ name, kind: 'f', owner: 'cms_control',
    arguments: index === 2 ? 'uuid, text, integer, bigint, text, text, text' : index === 4 ? 'uuid, text, text, text, integer' : '',
    acl: [grant('cms_control'), ...([2, 4].includes(index) ? [grant('cms_controller')] : [])] }))
}
const relations = (installed = true) => ['payload_migrations', 'news_migration_runs', 'news_migration_items',
  ...(installed ? ['owner_news_mutation_head', 'owner_news_mutation_events'] : [])]
  .map(name => ({ name, kind: 'r', owner: 'cms_migrator' }))

test('fixed catalog applicability accepts absent/V1/V2 independently of operational state', () => {
  assert.equal(assertProtocolFunctionContract([], relations(false)), 'absent')
  assert.equal(assertProtocolFunctionContract(functions(1), relations()), 'v1')
  assert.equal(assertProtocolFunctionContract(functions(), relations()), 'v2')
  const rows = functions(); rows[0]!.acl[0]!.grantable = true
  assert.equal(assertProtocolFunctionContract(rows, relations()), 'v2', 'owner-inherent grant authority is not delegated')
  for (const sql of [PROTOCOL_FUNCTION_CATALOG_SQL, PROTOCOL_REQUIRED_RELATIONS_SQL, PROTOCOL_TRIGGER_RESIDUE_SQL]) {
    assert.match(sql, /^SELECT/u)
    assert.doesNotMatch(sql, /SET ROLE|SET LOCAL ROLE|coverage_version|write_barrier|FROM public\.|pg_shdepend|verify_cms_ownership_contract/u)
  }
  assert.match(PROTOCOL_FUNCTION_CATALOG_SQL, /aclexplode\(COALESCE\(p\.proacl,pg_catalog\.acldefault\('f',p\.proowner\)\)\)/u)
  assert.match(PROTOCOL_FUNCTION_CATALOG_SQL, /p\.proname::text ~ '\^owner_news_'/u)
})

for (const name of names) {
  for (const principal of ['PUBLIC', 'cms_runtime', 'cms_observer', 'cms_admin', 'cms_migrator', 'unexpected_role']) {
    test(`${name} refuses EXECUTE for ${principal}`, () => {
      const rows = functions(); rows.find(row => row.name === name)!.acl.push(grant(principal))
      assert.throws(() => assertProtocolFunctionContract(rows, relations()), /invalid_catalog/u)
    })
  }
  for (const drift of ['owner', 'arguments', 'kind', 'owner-missing', 'grantor', 'grant-option', 'controller', 'null-acl', 'default-acl', 'empty-acl'] as const) {
    test(`${name} refuses ${drift} drift`, () => {
      const rows: Record<string, any>[] = functions(), row = rows.find(row => row.name === name)!
      if (drift === 'owner') row.owner = 'cms_migrator'
      if (drift === 'arguments') row.arguments = 'text'
      if (drift === 'kind') row.kind = 'p'
      if (drift === 'owner-missing') row.acl = row.acl.filter((value: any) => value.grantee !== 'cms_control')
      if (drift === 'grantor') row.acl[0].grantor = 'cms_admin'
      if (drift === 'grant-option') row.acl = [grant('cms_control'), { ...grant('cms_controller'), grantable: true }]
      if (drift === 'controller') row.acl = [grant('cms_control'), ...([names[2], names[4]].includes(name) ? [] : [grant('cms_controller')])]
      if (drift === 'null-acl') row.acl = null
      if (drift === 'default-acl') row.acl = [grant('cms_control'), grant('PUBLIC')]
      if (drift === 'empty-acl') row.acl = []
      assert.throws(() => assertProtocolFunctionContract(rows, relations()), /invalid_catalog/u)
    })
  }
}

test('unknown names, overloads, duplicates, missing functions and partial/wrong relations refuse', () => {
  const canonical = functions()
  for (const rows of [canonical.slice(1), [...canonical, { ...canonical[0]!, arguments: 'integer' }],
    [...canonical.slice(1), canonical[1]!], [...canonical.slice(1), { ...canonical[0]!, name: 'owner_news_extra' }]]) {
    assert.throws(() => assertProtocolFunctionContract(rows, relations()), /invalid_catalog/u)
  }
  for (const name of relations().map(value => value.name)) for (const change of ['missing', 'owner', 'kind'] as const) {
    const rows = relations()
    if (change === 'missing') rows.splice(rows.findIndex(row => row.name === name), 1)
    else rows.find(row => row.name === name)![change] = change === 'owner' ? 'cms_admin' : 'v'
    assert.throws(() => assertProtocolFunctionContract(canonical, rows), /invalid_catalog/u)
  }
  assert.throws(() => assertProtocolFunctionContract([], relations()), /invalid_catalog/u)
  assert.throws(() => assertProtocolFunctionContract(canonical, relations(false)), /invalid_catalog/u)
})

test('absent requires an explicit no-trigger-residue result, never an empty/malformed observation', async () => {
  for (const rows of [[{ present: false }], [{ present: true }], [], [{ present: null }]]) {
    const queries: string[] = []
    const client = { async query(sql: string) { queries.push(sql)
      if (sql === PROTOCOL_FUNCTION_CATALOG_SQL) return { rows: [] }
      if (sql === PROTOCOL_REQUIRED_RELATIONS_SQL) return { rows: relations(false) }
      assert.equal(sql, PROTOCOL_TRIGGER_RESIDUE_SQL); return { rows }
    } }
    if (rows[0]?.present === false) assert.equal(await verifyProtocolFunctionContract(client), 'absent')
    else await assert.rejects(verifyProtocolFunctionContract(client), /invalid_catalog/u)
    assert.equal(queries.length, 3)
  }
})

test('temporary authority names exactly the three trigger functions and carries no grant option', () => {
  const expected = [names[0], names[1], names[3]]
  for (const sql of [PROTOCOL_TRIGGER_EXECUTE_GRANT_SQL, PROTOCOL_TRIGGER_EXECUTE_REVOKE_SQL]) {
    assert.deepEqual([...sql.matchAll(/public\.(owner_news_[a-z_]+)\(\)/gu)].map(value => value[1]), expected)
    assert.doesNotMatch(sql, /GRANT OPTION|PUBLIC|seal_run|bootstrap_run|DEFAULT|ROLE/u)
  }
  assert.match(PROTOCOL_TRIGGER_EXECUTE_GRANT_SQL, /^GRANT EXECUTE[\s\S]*TO cms_migrator;$/u)
  assert.match(PROTOCOL_TRIGGER_EXECUTE_REVOKE_SQL, /^REVOKE EXECUTE[\s\S]*FROM cms_migrator;$/u)
})
