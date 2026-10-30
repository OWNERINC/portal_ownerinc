import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getFinalizerFailureDiagnostic,
  type FinalizerClient,
} from '../../scripts/finalize-news-protocol'
import {
  buildNewsProtocolObserverProvisioningSQL,
  buildNewsProtocolObserverRoleProvisioningSQL,
  newsProtocolObserverPrivilegesVerificationSQL,
  newsProtocolObserverRoleVerificationSQL,
  observerRelationProvisioningSQL,
  parseObserverDatabaseUrl,
} from '../../scripts/news-protocol-observer-contract'
import { runNewsProtocolAudit } from '../../scripts/verify-news-protocol'

test('observer provisioning configures only database-local grants for the precreated role', () => {
  const sql = buildNewsProtocolObserverProvisioningSQL('portal_test')

  assert.match(sql, /^BEGIN;\nDO \$ownerinc_observer_contract\$/u)
  assert.doesNotMatch(sql, /CREATE ROLE|ALTER ROLE|PASSWORD/u)
  assert.match(sql, /cms_observer_role_contract_mismatch/u)
  assert.match(sql, /GRANT CONNECT ON DATABASE ownerinc_cms TO cms_observer/u)
  assert.match(sql, /REVOKE CONNECT ON DATABASE "portal_test" FROM cms_observer/u)
  assert.doesNotMatch(sql, /ON DATABASE portal\b/u)
  assert.match(sql, /GRANT USAGE ON SCHEMA public TO cms_observer/u)
  assert.match(sql, /GRANT SELECT ON TABLE public\.payload_migrations TO cms_observer/u)
  assert.match(sql, /GRANT SELECT ON TABLE public\.owner_news_mutation_head TO cms_observer/u)
  assert.match(sql, /COMMIT;\n$/u)
  assert.match(sql, /SET LOCAL ROLE cms_migrator/u)
  assert.doesNotMatch(sql, /\bALTER ROLE\b|\bGRANT\s+cms_/iu)
  assert.doesNotMatch(sql, /\bREVOKE\b[\s\S]*\bpg_catalog\.pg_settings\b/iu)
  assert.doesNotMatch(sql, /\bGRANT\s+(?:INSERT|UPDATE|DELETE|TRUNCATE)\s+ON\b/iu)
  assert.doesNotMatch(sql, /news_articles|news_media|news_schedules|news_mutation_events|owner_news_seal_run/u)
  assert.doesNotMatch(sql, /CMS_(?:ADMIN|RUNTIME)_DATABASE_URL/u)
})

test('pre-restore observer role provisioning omits relation grants restored from the archive', () => {
  const sql = buildNewsProtocolObserverRoleProvisioningSQL('portal_test')
  assert.doesNotMatch(sql, /CREATE ROLE|ALTER ROLE|PASSWORD/u)
  assert.match(sql, /GRANT CONNECT ON DATABASE ownerinc_cms/u)
  assert.match(sql, /GRANT USAGE ON SCHEMA public/u)
  assert.doesNotMatch(sql, /GRANT SELECT ON TABLE/u)
})

test('observer SQL checks role membership and database-local ownership without pg_authid or pg_shdepend', () => {
  assert.match(newsProtocolObserverRoleVerificationSQL, /rolcanlogin/u)
  for (const attribute of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolinherit', 'rolreplication', 'rolbypassrls']) {
    assert.match(newsProtocolObserverRoleVerificationSQL, new RegExp(`NOT r\\.${attribute}`, 'u'))
  }
  assert.match(newsProtocolObserverRoleVerificationSQL, /pg_auth_members[\s\S]*m\.roleid=r\.oid OR m\.member=r\.oid/u)
  assert.match(newsProtocolObserverRoleVerificationSQL, /cms_cluster_guard\.verify_cms_ownership_contract/u)
  assert.doesNotMatch(newsProtocolObserverRoleVerificationSQL,
    /pg_authid|pg_shdepend/iu)
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

test('post-migration observer provisioning is bounded, normalizing, and has no role authority', () => {
  const sql = observerRelationProvisioningSQL('portal_test')
  assert.doesNotMatch(sql, /CREATE ROLE|ALTER ROLE|PASSWORD/u)
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM cms_observer/u)
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM cms_observer/u)
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE cms_migrator[\s\S]*REVOKE ALL ON TABLES FROM cms_observer/u)
  assert.match(sql, /GRANT SELECT ON TABLE public\.payload_migrations TO cms_observer/u)
  assert.match(sql, /to_regclass\('public\.owner_news_mutation_head'\)[\s\S]*GRANT SELECT ON TABLE public\.owner_news_mutation_head/u)
  assert.doesNotMatch(sql, /GRANT (?:CREATE|TEMPORARY|INSERT|UPDATE|DELETE|TRUNCATE)/u)
  assert.match(sql, /datname='portal_test'/u)
  assert.match(sql, /has_database_privilege\('cms_observer','portal_test','CONNECT'\)/u)
})

test('observer provisioning rejects absent or unsafe Portal database identifiers before SQL construction', () => {
  for (const invalid of [undefined, '', 'portal-test', 'Portal', 'portal;DROP DATABASE ownerinc_cms', 'a'.repeat(64)]) {
    assert.throws(() => buildNewsProtocolObserverProvisioningSQL(invalid as string), /Invalid CMS Portal database name/u)
  }
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
