/** Fixed protocol policy shared by the owner installer and pure-migrator replay.
 * Public catalogs only: no connections, role switches, head reads or repair. */
export type ProtocolOwnerFragments = Readonly<{
  functionCreate: string
  functionACL: string
  relationGrants: string
  triggers: string
}>

export const PROTOCOL_FUNCTION_CONTRACT = Object.freeze([
  { name: 'owner_news_mutation_guard_stmt', arguments: '', controller: false, trigger: true, version: 1 },
  { name: 'owner_news_mutation_capture_row', arguments: '', controller: false, trigger: true, version: 1 },
  { name: 'owner_news_seal_run', arguments: 'uuid, text, integer, bigint, text, text, text', controller: true, trigger: false, version: 1 },
  { name: 'owner_news_migration_item_binding_guard', arguments: '', controller: false, trigger: true, version: 1 },
  { name: 'owner_news_bootstrap_run', arguments: 'uuid, text, text, text, integer', controller: true, trigger: false, version: 2 },
].map(value => Object.freeze(value)))

const triggerSignatures = PROTOCOL_FUNCTION_CONTRACT.filter(value => value.trigger)
  .map(value => `public.${value.name}()`).join(',\n  ')
export const PROTOCOL_TRIGGER_EXECUTE_GRANT_SQL = `GRANT EXECUTE ON FUNCTION\n  ${triggerSignatures}\nTO cms_migrator;`
export const PROTOCOL_TRIGGER_EXECUTE_REVOKE_SQL = `REVOKE EXECUTE ON FUNCTION\n  ${triggerSignatures}\nFROM cms_migrator;`

export const PROTOCOL_FUNCTION_CATALOG_SQL = `SELECT p.proname AS name,
  pg_catalog.oidvectortypes(p.proargtypes) AS arguments, p.prokind AS kind,
  pg_catalog.pg_get_userbyid(p.proowner) AS owner,
  COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'grantor',pg_catalog.pg_get_userbyid(a.grantor),
    'grantee',CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
    'privilege',a.privilege_type,'grantable',a.is_grantable)
    ORDER BY a.grantee,a.grantor,a.privilege_type)
    FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a),'[]'::jsonb) AS acl
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname::text ~ '^owner_news_'
  ORDER BY p.proname,p.oid`

export const PROTOCOL_REQUIRED_RELATIONS_SQL = `SELECT c.relname AS name,c.relkind AS kind,
  pg_catalog.pg_get_userbyid(c.relowner) AS owner
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('payload_migrations','news_migration_runs',
    'news_migration_items','owner_news_mutation_head','owner_news_mutation_events') ORDER BY c.relname`

export const PROTOCOL_TRIGGER_RESIDUE_SQL = `SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
  WHERE NOT t.tgisinternal AND n.nspname='public'
    AND (t.tgname::text ~ '^owner_news_' OR (pn.nspname='public' AND p.proname::text ~ '^owner_news_'))
) AS present`

export type ProtocolACLApplicability = 'absent' | 'v1' | 'v2'
type Row = Record<string, unknown>
const refuse = (): never => { throw new Error('cms_protocol_function_contract:invalid_catalog') }

/** ACL applicability only, not body/trigger certification or operational readiness. */
export function assertProtocolFunctionContract(functions: readonly Row[], relations: readonly Row[]): ProtocolACLApplicability {
  const native = ['payload_migrations', 'news_migration_runs', 'news_migration_items']
  const ledger = ['owner_news_mutation_head', 'owner_news_mutation_events']
  const names = relations.map(row => row.name)
  if (new Set(names).size !== names.length || relations.some(row => row.kind !== 'r' || row.owner !== 'cms_migrator'
    || ![...native, ...ledger].includes(row.name as string)) || native.some(name => !names.includes(name))) refuse()
  if (functions.length === 0 && ledger.every(name => !names.includes(name))) return 'absent'
  if (!ledger.every(name => names.includes(name)) || ![4, 5].includes(functions.length)) return refuse()
  const version = functions.length === 4 ? 1 : 2
  const expected = PROTOCOL_FUNCTION_CONTRACT.filter(value => value.version <= version)
  if (new Set(functions.map(row => row.name)).size !== expected.length) refuse()
  for (const contract of expected) {
    const row = functions.find(value => value.name === contract.name)
    if (!row || row.arguments !== contract.arguments || row.kind !== 'f' || row.owner !== 'cms_control'
      || !Array.isArray(row.acl) || row.acl.length !== (contract.controller ? 2 : 1)) return refuse()
    const grantees = new Set<string>()
    for (const grant of row.acl) {
      if (!grant || grant.grantor !== 'cms_control' || grant.privilege !== 'EXECUTE'
        || typeof grant.grantable !== 'boolean' || grantees.has(grant.grantee)) refuse()
      // Owners inherently hold grant authority, even when their explicit ACL
      // entry has no grant option. Only the controller receives delegated rights.
      if (grant.grantee !== 'cms_control' && !(contract.controller && grant.grantee === 'cms_controller'
        && grant.grantable === false)) refuse()
      grantees.add(grant.grantee)
    }
    if (!grantees.has('cms_control') || contract.controller && !grantees.has('cms_controller')) refuse()
  }
  return version === 1 ? 'v1' : 'v2'
}

export async function verifyProtocolFunctionContract(client: {
  query(sql: string): Promise<{ rows: Row[] }>
}): Promise<ProtocolACLApplicability> {
  const functions = await client.query(PROTOCOL_FUNCTION_CATALOG_SQL)
  const relations = await client.query(PROTOCOL_REQUIRED_RELATIONS_SQL)
  const state = assertProtocolFunctionContract(functions.rows, relations.rows)
  if (state === 'absent') {
    const residue = await client.query(PROTOCOL_TRIGGER_RESIDUE_SQL)
    if (residue.rows.length !== 1 || residue.rows[0]?.present !== false) refuse()
  }
  return state
}
