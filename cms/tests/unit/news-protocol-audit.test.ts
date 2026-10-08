import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getFinalizerFailureDiagnostic,
  type FinalizerClient,
} from '../../scripts/finalize-news-protocol'
import {
  buildNewsProtocolObserverProvisioningSQL,
  newsProtocolObserverOwnershipCatalogPrivilegeVerificationSQL,
  newsProtocolObserverPrivilegesVerificationSQL,
  newsProtocolObserverRoleVerificationSQL,
  parseObserverDatabaseUrl,
} from '../../scripts/news-protocol-observer-contract'
import { runNewsProtocolAudit } from '../../scripts/verify-news-protocol'

test('observer provisioning creates only a least-privileged cms_observer without shared catalog ACL changes', () => {
  const password = `observer-secret-${'x'.repeat(24)}-end`
  const sql = buildNewsProtocolObserverProvisioningSQL(password)

  assert.match(sql, /^BEGIN;\nCREATE ROLE cms_observer LOGIN/u)
  assert.match(sql, /CREATE ROLE cms_observer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/u)
  assert.match(sql, /GRANT CONNECT ON DATABASE ownerinc_cms TO cms_observer/u)
  assert.match(sql, /GRANT USAGE ON SCHEMA public TO cms_observer/u)
  assert.match(sql, /GRANT SELECT ON TABLE public\.payload_migrations, public\.owner_news_mutation_head TO cms_observer/u)
  assert.match(sql, /COMMIT;\n$/u)
  assert.doesNotMatch(sql, /\bALTER ROLE\b|\bSET ROLE\b|\bGRANT\s+cms_/iu)
  assert.doesNotMatch(sql, /\bREVOKE\b[\s\S]*\bpg_catalog\.pg_settings\b/iu)
  assert.doesNotMatch(sql, /\bGRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE)\s+ON\b/iu)
  assert.doesNotMatch(sql, /news_articles|news_media|news_schedules|news_mutation_events|owner_news_seal_run/u)
  assert.doesNotMatch(sql, /CMS_(?:ADMIN|RUNTIME)_DATABASE_URL/u)
  assert.ok(sql.includes(password))
})

test('observer provisioning safely SQL-quotes punctuation in the caller-supplied password', () => {
  const password = `O'Reilly; DROP ROLE cms_observer; --${'x'.repeat(32)}`
  const sql = buildNewsProtocolObserverProvisioningSQL(password)
  assert.ok(sql.includes(`PASSWORD 'O''Reilly; DROP ROLE cms_observer; --${'x'.repeat(32)}'`))
  assert.equal(sql.includes(`PASSWORD '${password}'`), false)
})

test('observer SQL checks role membership and ownership dependencies without reading pg_authid', () => {
  assert.match(newsProtocolObserverRoleVerificationSQL, /rolcanlogin/u)
  for (const attribute of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolinherit', 'rolreplication', 'rolbypassrls']) {
    assert.match(newsProtocolObserverRoleVerificationSQL, new RegExp(`NOT r\\.${attribute}`, 'u'))
  }
  assert.match(newsProtocolObserverRoleVerificationSQL, /pg_auth_members[\s\S]*m\.roleid=r\.oid OR m\.member=r\.oid/u)
  assert.match(newsProtocolObserverOwnershipCatalogPrivilegeVerificationSQL,
    /has_table_privilege\(current_user, 'pg_catalog\.pg_shdepend', 'SELECT'\) AS safe/u)
  assert.match(newsProtocolObserverRoleVerificationSQL,
    /FROM pg_catalog\.pg_shdepend d[\s\S]*d\.refclassid='pg_catalog\.pg_authid'::regclass[\s\S]*d\.refobjid=r\.oid AND d\.deptype='o'/u)
  assert.doesNotMatch(newsProtocolObserverRoleVerificationSQL,
    /(?:FROM|JOIN)\s+pg_catalog\.pg_authid\b/iu)
  for (const relation of ['payload_migrations', 'owner_news_mutation_head']) {
    assert.ok(newsProtocolObserverPrivilegesVerificationSQL.includes(`'${relation}'`))
  }
  assert.match(newsProtocolObserverPrivilegesVerificationSQL, /has_table_privilege\('cms_observer'/u)
  assert.match(newsProtocolObserverPrivilegesVerificationSQL,
    /OR \(NOT r\.session_settings_view AND has_table_privilege\('cms_observer',r\.oid,'UPDATE'\)\)/u)
  assert.match(newsProtocolObserverPrivilegesVerificationSQL, /has_column_privilege\('cms_observer'/u)
  assert.match(newsProtocolObserverPrivilegesVerificationSQL, /has_sequence_privilege\('cms_observer'/u)
  assert.match(newsProtocolObserverPrivilegesVerificationSQL, /has_function_privilege\('cms_observer'/u)
  assert.match(newsProtocolObserverPrivilegesVerificationSQL, /n\.nspname IN \('pg_catalog','information_schema'\) AS catalog_read/u)
  assert.match(newsProtocolObserverPrivilegesVerificationSQL, /WHERE has_schema_privilege\('cms_observer',n\.oid,'CREATE'\)/u)
  assert.match(newsProtocolObserverPrivilegesVerificationSQL, /aclexplode\([\s\S]*acl\.grantee=0/u)
  assert.match(newsProtocolObserverPrivilegesVerificationSQL,
    /a\.attacl IS NOT NULL AND EXISTS \([\s\S]*aclexplode\(\s*a\.attacl\)/u)
  assert.match(newsProtocolObserverPrivilegesVerificationSQL, /owner_news_seal_run/u)
  assert.doesNotMatch(newsProtocolObserverPrivilegesVerificationSQL,
    /pg_authid|pg_shdepend|SECURITY\s+DEFINER/u)
})

test('persistent-DML audit exempts only UPDATE on the canonical pg_settings view', () => {
  type RelationFixture = { oid: string; schema: string; kind: 'v' | 'r'; effectiveUpdate: boolean;
    publicAcl: string[]; label: string }
  const relations: RelationFixture[] = [
    { oid: 'pg_catalog.pg_settings', schema: 'pg_catalog', kind: 'v', effectiveUpdate: true,
      publicAcl: ['SELECT', 'UPDATE'], label: 'builtin settings view with PG16 initial PUBLIC ACL' },
    { oid: 'pg_catalog.pg_class', schema: 'pg_catalog', kind: 'r', effectiveUpdate: true,
      publicAcl: ['UPDATE'], label: 'other catalog relation' },
    { oid: 'public.pg_settings', schema: 'public', kind: 'v', effectiveUpdate: true,
      publicAcl: ['UPDATE'], label: 'same-name application view' },
    { oid: 'public.owner_news_mutation_head', schema: 'public', kind: 'r', effectiveUpdate: true,
      publicAcl: ['UPDATE'], label: 'allowed-read application table' },
  ]
  const isCanonicalSettingsView = (relation: RelationFixture) => relation.oid === 'pg_catalog.pg_settings'
    && relation.schema === 'pg_catalog' && relation.kind === 'v'
  const sessionSettingException = (relation: RelationFixture, privilege: string) =>
    privilege === 'UPDATE' && isCanonicalSettingsView(relation)

  assert.deepEqual(relations[0].publicAcl, ['SELECT', 'UPDATE'])
  assert.equal(sessionSettingException(relations[0], 'UPDATE'), true)
  for (const relation of relations) {
    assert.equal(relation.effectiveUpdate && !sessionSettingException(relation, 'UPDATE'),
      relation !== relations[0], relation.label)
  }
  for (const privilege of ['INSERT', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
    assert.equal(sessionSettingException(relations[0], privilege), false)
  }

  assert.match(newsProtocolObserverPrivilegesVerificationSQL,
    /c\.oid='pg_catalog\.pg_settings'::regclass AND n\.nspname='pg_catalog' AND c\.relkind='v' AS session_settings_view/u)
  assert.match(newsProtocolObserverPrivilegesVerificationSQL,
    /count\(\*\)=1 FROM relations WHERE session_settings_view\) AS session_settings_view_present/u)
  assert.match(newsProtocolObserverPrivilegesVerificationSQL,
    /OR \(NOT r\.session_settings_view AND has_table_privilege\('cms_observer',r\.oid,'UPDATE'\)\)/u)
  assert.match(newsProtocolObserverPrivilegesVerificationSQL,
    /OR \(NOT r\.session_settings_view AND has_column_privilege\('cms_observer',r\.oid,a\.attnum,'UPDATE'\)\)/u)
  for (const privilege of ['INSERT', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
    assert.match(newsProtocolObserverPrivilegesVerificationSQL,
      new RegExp(`OR has_table_privilege\\('cms_observer',r\\.oid,'${privilege}'\\)`, 'u'))
  }
})

for (const [objectClass, dbid] of [
  ['pg_publication', 16384],
  ['pg_statistic_ext', 0],
  ['pg_ts_dict', 91731],
  ['pg_event_trigger', 16384],
] as const) {
  test(`mock cms_observer ownership dependency for ${objectClass} (dbid=${dbid}) fails and rolls the audit back`, async () => {
    const roleOid = 41001
    const roleRows = [{ rolname: 'cms_observer', oid: roleOid }]
    const ownershipDependencies = [{ classid: objectClass, refclassid: 'pg_authid', refobjid: roleOid,
      deptype: 'o', dbid }]
    const hasOwnedDependency = ownershipDependencies.some(dependency => dependency.refclassid === 'pg_authid'
      && dependency.deptype === 'o' && roleRows.some(role => role.oid === dependency.refobjid))
    const statements: string[] = []
    const client: FinalizerClient = {
      connect: async () => {},
      end: async () => {},
      query: async sql => {
        statements.push(sql)
        if (sql === newsProtocolObserverOwnershipCatalogPrivilegeVerificationSQL) return { rows: [{ safe: true }] }
        if (sql === newsProtocolObserverRoleVerificationSQL) return { rows: [{ safe: !hasOwnedDependency }] }
        if (sql.startsWith("SELECT current_setting('transaction_read_only') AS read_only")) {
          return { rows: [{ read_only: 'on', isolation: 'repeatable read',
            search_path: 'pg_catalog, public', bounded_timeout: true }] }
        }
        if (sql.includes('current_user AS role')) {
          return { rows: [{ role: 'cms_observer', session_role: 'cms_observer',
            db: 'ownerinc_cms', superuser: false, read_only: 'on' }] }
        }
        return { rows: [] }
      },
    }

    const error = await runNewsProtocolAudit({
      CMS_OBSERVER_DATABASE_URL: 'postgres://cms_observer:test-only-secret@127.0.0.1/ownerinc_cms',
    }, client).catch(value => value)

    assert.equal(hasOwnedDependency, true)
    assert.equal(getFinalizerFailureDiagnostic(error)?.reason, 'observer_role_contract_mismatch')
    assert.match(newsProtocolObserverRoleVerificationSQL,
      /NOT EXISTS \(\s*SELECT 1 FROM pg_catalog\.pg_shdepend d\s+WHERE d\.refclassid='pg_catalog\.pg_authid'::regclass\s+AND d\.refobjid=r\.oid AND d\.deptype='o'\s*\)/u)
    assert.doesNotMatch(newsProtocolObserverRoleVerificationSQL, /\bd\.classid\s*=/u)
    assert.doesNotMatch(newsProtocolObserverRoleVerificationSQL, /\bd\.dbid\s*=/u)
    assert.equal(statements.at(-1), 'ROLLBACK')
    assert.equal(statements.includes('COMMIT'), false)
  })
}

test('observer URL parser requires explicit cms_observer credentials and the exact CMS database', () => {
  const accepted = parseObserverDatabaseUrl('postgresql://cms_observer:only-for-test@127.0.0.1:5432/ownerinc_cms')
  assert.equal(accepted.protocol, 'postgresql:')
  assert.equal(accepted.pathname, '/ownerinc_cms')
  assert.equal(decodeURIComponent(accepted.username), 'cms_observer')

  for (const invalid of [
    undefined,
    '',
    'postgres://cms_admin:secret@127.0.0.1/ownerinc_cms',
    'postgres://cms_runtime:secret@127.0.0.1/ownerinc_cms',
    'postgres://cms_observer:secret@127.0.0.1/portal',
    'postgres://cms_observer@127.0.0.1/ownerinc_cms',
    'postgres://cms_observer:secret@127.0.0.1/ownerinc_cms?options=-c%20role%3Dcms_admin',
    'postgres://cms_observer:secret@127.0.0.1/ownerinc_cms#target',
    'https://cms_observer:secret@127.0.0.1/ownerinc_cms',
  ]) assert.throws(() => parseObserverDatabaseUrl(invalid))
})

test('observer URL errors do not echo supplied connection data', () => {
  const secretUrl = 'postgres://cms_admin:never-echo-this@127.0.0.1/ownerinc_cms'
  assert.throws(() => parseObserverDatabaseUrl(secretUrl), error => {
    assert.ok(error instanceof Error)
    assert.equal(error.message.includes('never-echo-this'), false)
    assert.equal(error.message.includes('127.0.0.1'), false)
    return true
  })
})

test('audit command never falls back to admin or runtime connection URLs', async () => {
  let connected = false
  const client = {
    connect: async () => { connected = true },
    end: async () => {},
    query: async () => ({ rows: [] }),
  }
  await assert.rejects(runNewsProtocolAudit({
    CMS_ADMIN_DATABASE_URL: 'postgres://cms_admin:admin-secret@localhost/ownerinc_cms',
    CMS_RUNTIME_DATABASE_URL: 'postgres://cms_runtime:runtime-secret@localhost/ownerinc_cms',
  }, client))
  assert.equal(connected, false)
})
