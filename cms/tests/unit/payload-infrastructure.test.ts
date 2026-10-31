import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { NextRequest } from 'next/server'
import type { Payload } from 'payload'
import { proxy, editorialPolicy, isNativeNewsRestoreRequest } from '../../src/proxy'
import {
  buildProtocolRuntimeGrantsSQL, clusterRolesBootstrapSQL, clusterRolesVerificationSQL,
  adminPreauthorityInspectionSQL,
  clusterRolesPublicVerificationSQL, cmsAdminDatabaseRoleVerificationSQL,
  clusterOwnershipHelperSQL, clusterOwnershipHelperVerificationSQL, CMS_ROLE_NAMES,
  controlRolesBootstrapSQL, controlRolesNativePrivilegesVerificationSQL, controlRolesPublicVerificationSQL,
  controlRolePasswordPresenceSQL, controlRolesOwnershipVerificationSQL, controlRolesVerificationSQL,
  grantsSQL, provisioningSQL, run,
  parsePortalDatabaseName,
  getBootstrapControlFailureDiagnostic, formatBootstrapControlFailureDiagnostic,
  runtimeProtocolFunctionsVerifySQL, runtimeProtocolPrivilegesVerifySQL,
} from '../../scripts/provision-db'
import { privateStorageDir } from '../../src/media/storage'
import {
  newsProtocolObserverPostMigrationVerificationSQL,
  observerRelationProvisioningSQL,
} from '../../scripts/news-protocol-observer-contract'
import { NEWS_MUTATION_TABLES } from '../../src/publication/mutation-ledger'

const PORTAL_ENV = { CMS_PORTAL_DATABASE_NAME: 'portal' }

test('nonce is fresh, replaces attacker headers and matches request and response CSP for RSC', () => {
  const request = () => new NextRequest('https://portal.example/editorial/admin', { headers: {
    'x-nonce': 'attacker', 'Content-Security-Policy': "script-src 'unsafe-inline'", rsc: '1',
  } })
  const first = proxy(request()); const second = proxy(request())
  const csp = first.headers.get('Content-Security-Policy')!
  assert.match(csp, /'nonce-[A-Za-z0-9+/]{32}'/)
  assert.equal(first.headers.get('x-middleware-request-content-security-policy'), csp)
  assert.notEqual(csp, second.headers.get('Content-Security-Policy'))
  assert.notEqual(first.headers.get('x-middleware-request-x-nonce'), 'attacker')
  assert.equal(first.headers.get('Cache-Control'), 'private, no-store')
  assert.doesNotMatch(editorialPolicy('a'.repeat(32)), /unsafe-eval|script-src[^;]*unsafe-inline/)
})

test('origin guard remains enforced for native form/actions with CSP on denial', () => {
  const old = process.env.PORTAL_PUBLIC_URL
  process.env.PORTAL_PUBLIC_URL = 'https://portal.example'
  try {
    for (const origin of [undefined, 'https://attacker.invalid']) {
      const response = proxy(new NextRequest('https://portal.example/editorial/admin', { method: 'POST', headers: origin ? { origin } : {} }))
      assert.equal(response.status, 403)
      assert.match(response.headers.get('Content-Security-Policy')!, /nonce-/)
    }
    const response = proxy(new NextRequest('https://portal.example/editorial/admin', { method: 'POST', headers: { origin: 'https://portal.example' } }))
    assert.equal(response.status, 200)
  } finally { if (old === undefined) delete process.env.PORTAL_PUBLIC_URL; else process.env.PORTAL_PUBLIC_URL = old }
})

test('native article and home restore endpoints are unavailable before Payload dispatch', () => {
  const article = '/editorial/api/news-articles/versions/11111111-1111-4111-8111-111111111111'
  const home = '/editorial/api/globals/news-home/versions/22222222-2222-4222-8222-222222222222'
  for (const pathname of [article, home]) {
    assert.equal(isNativeNewsRestoreRequest(pathname, 'POST'), true)
    const response = proxy(new NextRequest(`https://portal.example${pathname}`, { method: 'POST' }))
    assert.equal(response.status, 404)
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store')
  }
  assert.equal(isNativeNewsRestoreRequest(article, 'GET'), false)
  assert.equal(isNativeNewsRestoreRequest('/editorial/api/news-media/versions/id', 'POST'), false)
})

test('ordinary provisioning applies database/schema grants without role authority or secrets', () => {
  const sql = provisioningSQL()
  assert.match(sql, /GRANT USAGE, CREATE ON SCHEMA public TO cms_migrator/)
  assert.match(sql, /GRANT CONNECT ON DATABASE ownerinc_cms TO cms_migrator, cms_runtime, cms_observer/)
  assert.match(sql, /REVOKE CREATE, TEMPORARY ON DATABASE ownerinc_cms FROM cms_observer/)
  assert.match(sql, /GRANT USAGE ON SCHEMA public TO cms_runtime, cms_observer/)
  assert.match(sql, /REVOKE CREATE ON SCHEMA public FROM cms_runtime, cms_observer/)
  assert.doesNotMatch(sql, /CREATE ROLE|ALTER ROLE|PASSWORD|CREATEROLE/u)
})

test('post-migration grants expose only the native ledger to the exact admin verifier', () => {
  assert.match(grantsSQL,
    /GRANT SELECT ON TABLE public\.payload_migrations TO cms_admin, cms_runtime/u)
  assert.doesNotMatch(grantsSQL,
    /GRANT (?:INSERT|UPDATE|DELETE|ALL(?: PRIVILEGES)?) ON TABLE public\.payload_migrations TO cms_admin/u)
  assert.doesNotMatch(grantsSQL,
    /GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL(?: PRIVILEGES)?) ON ALL TABLES IN SCHEMA public TO cms_admin/u)
})

test('admin preauthority inspection is SELECT-only on the exact News mutation inventory', () => {
  const tables = adminPreauthorityInspectionSQL.match(/public\."[^"]+"/gu) || []
  const expected = NEWS_MUTATION_TABLES.map(name => `public."${name}"`)
  assert.deepEqual(tables, [...expected, ...expected])
  assert.equal(new Set(tables).size, NEWS_MUTATION_TABLES.length)
  assert.match(adminPreauthorityInspectionSQL, /^\nREVOKE ALL PRIVILEGES ON TABLE /u)
  assert.match(adminPreauthorityInspectionSQL, / FROM cms_admin;\nGRANT SELECT ON TABLE /u)
  assert.match(adminPreauthorityInspectionSQL, / TO cms_admin;\n$/u)
  assert.doesNotMatch(adminPreauthorityInspectionSQL,
    /GRANT (?:INSERT|UPDATE|DELETE|TRUNCATE|REFERENCES|TRIGGER|ALL(?: PRIVILEGES)?)/u)
  assert.doesNotMatch(adminPreauthorityInspectionSQL, /ALL TABLES IN SCHEMA/u)
})

test('the common post-migration grants path normalizes and verifies observer access', async () => {
  const statements: string[] = []
  const client = { async connect() {}, async end() {}, async query(sql: string) {
    statements.push(sql)
    if (sql.includes('SELECT current_user AS name')) return { rows: [{
      name: 'cms_migrator', database: 'ownerinc_cms', rolsuper: false, rolcreatedb: false, rolcreaterole: false,
      rolinherit: false, rolreplication: false, rolbypassrls: false, connection_limit_safe: true, expiry_safe: true,
      settings_safe: true, ddl: true, create_schema: false, temporary: false, member: false,
    }] }
    if (sql === newsProtocolObserverPostMigrationVerificationSQL || sql === cmsAdminDatabaseRoleVerificationSQL
        || sql === clusterRolesPublicVerificationSQL) return { rows: [{ safe: true }] }
    return { rows: [] }
  } }
  await run('--grants', { CMS_DATABASE_URL: 'postgresql://cms_migrator@cms.invalid/ownerinc_cms',
    CMS_PORTAL_DATABASE_NAME: 'portal_test' }, client)
  const grantsIndex = statements.indexOf(grantsSQL)
  const observerIndex = statements.indexOf(observerRelationProvisioningSQL('portal_test'))
  const verifyIndex = statements.indexOf(newsProtocolObserverPostMigrationVerificationSQL)
  assert.ok(grantsIndex > statements.indexOf('BEGIN'))
  assert.ok(observerIndex > grantsIndex && verifyIndex > observerIndex)
  assert.equal(statements.at(-1), 'COMMIT')
})

test('cluster bootstrap reconciles all bounded roles without ever elevating cms_admin', () => {
  const passwords = {
    admin: "synthetic-admin-'" + 'a'.repeat(32), controller: 'c'.repeat(40),
    migrator: 'm'.repeat(40), runtime: 'r'.repeat(40), observer: 'o'.repeat(40),
  }
  const sql = clusterRolesBootstrapSQL(passwords)
  for (const role of ['cms_admin', 'cms_control', 'cms_controller', 'cms_migrator', 'cms_runtime', 'cms_observer']) {
    assert.match(sql, new RegExp(`CREATE ROLE ${role} `, 'u'))
    assert.match(sql, new RegExp(`ALTER ROLE ${role} WITH `, 'u'))
  }
  assert.ok(sql.includes("synthetic-admin-''"))
  assert.doesNotMatch(sql, /(?:^|\s)CREATEROLE(?:\s|;)/mu)
  assert.match(sql, /ALTER ROLE cms_admin WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT/)
  assert.match(clusterRolesVerificationSQL, /count\(\*\)=6/)
  assert.match(clusterRolesVerificationSQL, /NOT rolcreaterole/)
  assert.match(clusterRolesVerificationSQL, /pg_auth_members/)
  assert.deepEqual([...CMS_ROLE_NAMES], ['cms_admin', 'cms_control', 'cms_controller', 'cms_migrator', 'cms_runtime', 'cms_observer'])
  assert.match(sql, /ALTER ROLE cms_admin[\s\S]*CONNECTION LIMIT -1 VALID UNTIL 'infinity'/u)
  for (const role of CMS_ROLE_NAMES) assert.match(sql, new RegExp(`ALTER ROLE ${role} RESET ALL`, 'u'))
  assert.match(clusterRolesVerificationSQL, /rolconnlimit=-1/)
  assert.match(clusterRolesVerificationSQL, /rolvaliduntil IS NULL OR rolvaliduntil='infinity'::timestamptz/)
  assert.match(clusterRolesVerificationSQL, /rolconfig IS NULL/)
  assert.match(clusterRolesVerificationSQL, /EXISTS \(SELECT 1 FROM pg_catalog\.pg_database WHERE datname=\$1\)/u)
  assert.match(clusterRolesPublicVerificationSQL, /'cms_admin'::name[\s\S]*'cms_observer'::name/u)
  assert.match(clusterRolesPublicVerificationSQL, /has_database_privilege\(role_name,\$1,'CONNECT'\)/u)
})

test('Portal database configuration is explicit, injection-safe, and absent databases fail before role mutation', async () => {
  assert.equal(parsePortalDatabaseName('portal_test'), 'portal_test')
  for (const invalid of [undefined, '', 'portal-test', 'Portal', 'portal; DROP DATABASE ownerinc_cms', 'a'.repeat(64)]) {
    assert.throws(() => parsePortalDatabaseName(invalid), /Invalid CMS Portal database name/u)
  }
  let connected = false
  await assert.rejects(run('--bootstrap-database', {
    CMS_DATABASE_URL: `postgresql://portal_admin:${'p'.repeat(40)}@db.invalid:5432/postgres`,
    CMS_POSTGRES_PASSWORD: 'a'.repeat(40), CMS_CONTROLLER_PASSWORD: 'c'.repeat(40),
    CMS_MIGRATOR_PASSWORD: 'm'.repeat(40), CMS_RUNTIME_PASSWORD: 'r'.repeat(40),
    CMS_OBSERVER_PASSWORD: 'o'.repeat(40), CMS_PORTAL_DATABASE_NAME: 'portal;DROP DATABASE ownerinc_cms',
  }, { async connect() { connected = true }, async end() {}, async query() { return { rows: [] } } }),
  /Invalid CMS Portal database name/u)
  assert.equal(connected, false)

  const statements: string[] = []
  await assert.rejects(run('--bootstrap-database', {
    CMS_DATABASE_URL: `postgresql://portal_admin:${'p'.repeat(40)}@db.invalid:5432/postgres`,
    CMS_POSTGRES_PASSWORD: 'a'.repeat(40), CMS_CONTROLLER_PASSWORD: 'c'.repeat(40),
    CMS_MIGRATOR_PASSWORD: 'm'.repeat(40), CMS_RUNTIME_PASSWORD: 'r'.repeat(40),
    CMS_OBSERVER_PASSWORD: 'o'.repeat(40), CMS_PORTAL_DATABASE_NAME: 'missing_portal',
  }, { async connect() {}, async end() {}, async query(sql: string) {
    statements.push(sql)
    if (sql.includes('current_user AS name')) return { rows: [{ name: 'portal_admin', database: 'postgres', rolsuper: true }] }
    if (sql.includes('SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname=$1)')) return { rows: [{ present: false }] }
    return { rows: [] }
  } }), /Configured Portal database does not exist/u)
  assert.equal(statements.some(sql => /CREATE ROLE|ALTER ROLE|REVOKE CONNECT ON DATABASE/u.test(sql)), false)
})

test('every cms_admin role-attribute drift fails the canonical database-local entrypoint contract', async () => {
  const categories = ['NOLOGIN', 'SUPERUSER', 'CREATEDB', 'CREATEROLE', 'INHERIT', 'REPLICATION', 'BYPASSRLS',
    'CONNECTION LIMIT', 'VALID UNTIL', 'rolconfig', 'database owner']
  for (const category of categories) {
    const statements: string[] = []
    const client = { async connect() {}, async end() {}, async query(sql: string) {
      statements.push(sql)
      if (sql.includes('current_user AS name')) return { rows: [{ name: 'cms_admin', database: 'ownerinc_cms' }] }
      if (sql === cmsAdminDatabaseRoleVerificationSQL) return { rows: [{ safe: false }] }
      return { rows: [] }
    } }
    await assert.rejects(run('--provision', {
      CMS_DATABASE_URL: 'postgresql://cms_admin:test@db.invalid/ownerinc_cms', CMS_PORTAL_DATABASE_NAME: 'portal',
    }, client), /Unsafe CMS admin role contract/u, category)
    assert.equal(statements.includes(provisioningSQL()), false, category)
  }
  for (const expected of ['rolcanlogin', 'NOT role.rolsuper', 'NOT role.rolcreatedb', 'NOT role.rolcreaterole',
    'NOT role.rolinherit', 'NOT role.rolreplication', 'NOT role.rolbypassrls', 'role.rolconnlimit=-1',
    "role.rolvaliduntil='infinity'::timestamptz", 'role.rolconfig IS NULL', "current_database()='ownerinc_cms'",
    "pg_get_userbyid(database.datdba)='cms_admin'"]) assert.ok(cmsAdminDatabaseRoleVerificationSQL.includes(expected), expected)
})

test('manual protocol entrypoint verifies the canonical cms_admin contract before observer DDL', () => {
  const source = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../integration/manual-runtime-protocol.ts'), 'utf8')
  const verification = source.indexOf('await verifyCmsAdminDatabaseRoleContract(client)')
  const roleProvisioning = source.lastIndexOf('buildNewsProtocolObserverRoleProvisioningSQL(portalDatabase)')
  const observerProvisioning = source.lastIndexOf('buildNewsProtocolObserverProvisioningSQL(portalDatabase)')
  assert.ok(verification >= 0)
  assert.ok(roleProvisioning > verification)
  assert.ok(observerProvisioning > verification)
  assert.ok(source.indexOf("stage = 'admin-contract'") < verification)
  assert.ok(source.indexOf("stage = 'provision'") > verification)
})

test('read-only retry verifier covers all six CMS roles and rejects cms_admin or observer drift without mutation', async () => {
  for (const drift of ['cms_admin', 'cms_observer']) {
    const statements: string[] = []
    const client = { async connect() {}, async end() {}, async query(sql: string) {
      statements.push(sql)
      if (sql === 'SELECT current_user AS name, current_database() AS database') {
        return { rows: [{ name: 'cms_admin', database: 'ownerinc_cms' }] }
      }
      if (sql === cmsAdminDatabaseRoleVerificationSQL) return { rows: [{ safe: drift !== 'cms_admin' }] }
      if (sql === clusterRolesPublicVerificationSQL) return { rows: [{ safe: drift !== 'cms_observer' }] }
      return { rows: [] }
    } }
    await assert.rejects(run('--verify-cluster-roles', {
      CMS_DATABASE_URL: 'postgresql://cms_admin:test@db.invalid/ownerinc_cms', CMS_PORTAL_DATABASE_NAME: 'portal_test',
    }, client), /Unsafe CMS (?:admin role|cluster role) contract/u)
    assert.equal(statements.some(sql => /\b(?:BEGIN|COMMIT|CREATE|ALTER|GRANT|REVOKE)\b/u.test(sql)), false, drift)
  }
  for (const role of CMS_ROLE_NAMES) assert.ok(clusterRolesPublicVerificationSQL.includes(`'${role}'::name`), role)
})

test('cluster bootstrap retries and intermediate failures can never leave cms_admin with CREATEROLE', async () => {
  const env = {
    CMS_DATABASE_URL: `postgresql://portal_admin:${'p'.repeat(40)}@db.invalid:5432/postgres`,
    CMS_POSTGRES_PASSWORD: 'a'.repeat(40), CMS_CONTROLLER_PASSWORD: 'c'.repeat(40),
    CMS_MIGRATOR_PASSWORD: 'm'.repeat(40), CMS_RUNTIME_PASSWORD: 'r'.repeat(40),
    CMS_OBSERVER_PASSWORD: 'o'.repeat(40), CMS_PORTAL_DATABASE_NAME: 'portal_test',
  }
  const responses = (sql: string) => {
    if (sql.includes('current_user AS name')) return { rows: [{ name: 'portal_admin', database: 'postgres', rolsuper: true }] }
    if (sql === clusterRolesVerificationSQL) return { rows: [{ safe: true }] }
    if (sql.includes('SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname=$1)')) return { rows: [{ present: true }] }
    if (sql === clusterOwnershipHelperVerificationSQL) return { rows: [{ safe: true }] }
    if (sql.includes('FROM pg_database')) return { rows: [{ owner: 'cms_admin' }] }
    return { rows: [] }
  }
  for (let failAt = 1; failAt <= 7; failAt += 1) {
    const queries: string[] = []
    let queryNumber = 0
    const client = { async connect() {}, async end() {}, async query(sql: string) {
      queries.push(sql); queryNumber += 1
      if (queryNumber === failAt) throw new Error('synthetic cluster bootstrap interruption')
      return responses(sql)
    } }
    await assert.rejects(run('--bootstrap-database', env, client), /synthetic cluster bootstrap interruption/)
    assert.equal(queries.some(sql => /(?:^|\s)CREATEROLE(?:\s|;)/mu.test(sql)), false)
    const bootstrapAttempted = queries.some(sql => sql.includes('DO $ownerinc_cms_roles$'))
    assert.equal(!bootstrapAttempted || queries.some(sql => /ALTER ROLE cms_admin[\s\S]*NOCREATEROLE/u.test(sql)), true)
  }
  await assert.rejects(run('--bootstrap-database', { ...env, CMS_RUNTIME_PASSWORD: 'p'.repeat(40) },
    { async connect() { throw new Error('must reject before connect') }, async end() {}, async query() { return { rows: [] } } }),
  /distinct from other configured secrets/)
})

test('control bootstrap grants only bounded access and exports reusable role/readiness verifiers', () => {
  const password = "synthetic-controller-'" + 'x'.repeat(32)
  const sql = controlRolesBootstrapSQL(password)
  assert.doesNotMatch(sql, /CREATE\s+ROLE|ALTER\s+ROLE|PASSWORD|GRANT\s+cms_control\s+TO|GRANT\s+cms_controller\s+TO/i)
  assert.match(sql, /GRANT CONNECT ON DATABASE ownerinc_cms TO cms_control, cms_controller/)
  assert.match(sql, /GRANT USAGE, CREATE ON SCHEMA public TO cms_control/)
  assert.match(sql, /GRANT USAGE ON SCHEMA public TO cms_controller/)
  assert.match(controlRolesVerificationSQL, /rolcanlogin=can_login/)
  assert.match(controlRolesVerificationSQL, /NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole/)
  assert.match(controlRolesVerificationSQL, /NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls/)
  assert.match(controlRolesVerificationSQL, /m\.roleid=oid OR m\.member=oid/)
  assert.match(controlRolesVerificationSQL, /has_schema_privilege\(role_name, 'public', 'CREATE'\)=schema_create/)
  assert.match(controlRolesVerificationSQL, /LEFT JOIN pg_catalog\.pg_authid a ON a\.oid=r\.oid/)
  assert.match(controlRolesVerificationSQL, /a\.oid IS NOT NULL AS auth_row_exists/)
  assert.match(controlRolesVerificationSQL, /a\.rolpassword IS NOT NULL AS has_password/)
  assert.match(controlRolesVerificationSQL, /AND auth_row_exists/)
  assert.match(controlRolesVerificationSQL, /CASE WHEN role_name='cms_control' THEN NOT has_password ELSE has_password END/)
  assert.doesNotMatch(controlRolesVerificationSQL, /(?:r|a)\.rolpassword\s*,|(?:r|a)\.rolpassword\s+AS\s+rolpassword/u)
  assert.match(controlRolePasswordPresenceSQL(), /a\.rolpassword IS NOT NULL AS has_password/)
  assert.match(controlRolePasswordPresenceSQL(), /a\.oid IS NOT NULL AS auth_row_exists/)
  assert.match(controlRolesOwnershipVerificationSQL, /cms_cluster_guard\.verify_cms_ownership_contract/u)
  assert.doesNotMatch(controlRolesOwnershipVerificationSQL, /pg_shdepend|pg_authid/u)
  assert.match(clusterOwnershipHelperSQL, /FROM pg_catalog\.pg_shdepend dependency/u)
  assert.match(clusterOwnershipHelperSQL, /dependency\.dbid=current_db\.oid/u)
  assert.match(clusterOwnershipHelperSQL, /dependency\.classid='pg_catalog\.pg_database'::regclass/u)
  assert.match(clusterOwnershipHelperSQL, /COALESCE\(rolname='cms_control'/u)
  assert.doesNotMatch(clusterOwnershipHelperSQL, /pg_catalog\.coalesce/u)
  assert.doesNotMatch(clusterOwnershipHelperSQL, /pg_class c|pg_proc p|pg_type t|pg_namespace n/u)
  assert.match(clusterOwnershipHelperSQL, /RETURNS TABLE\(safe boolean, unexpected_ownership_count bigint, approved_control_function_count bigint\)/u)
  assert.match(clusterOwnershipHelperVerificationSQL, /count\(\*\)=1/u)
  assert.match(clusterOwnershipHelperVerificationSQL, /NOT pg_catalog\.has_function_privilege\('cms_runtime'/u)
  assert.match(controlRolesNativePrivilegesVerificationSQL, /has_table_privilege/)
  assert.match(controlRolesPublicVerificationSQL, /NOT rolcreaterole/)
  assert.throws(() => controlRolesBootstrapSQL('placeholder-' + 'x'.repeat(32)), /Invalid CMS role password/)
})

test('control-role password presence contract consumes auth-catalog booleans and rejects missing rows', async () => {
  const env = { ...PORTAL_ENV, CMS_DATABASE_URL: 'postgresql://cms_admin:admin-secret@db.invalid:5432/ownerinc_cms',
    CMS_CONTROLLER_PASSWORD: 'synthetic-controller-secret-' + 'x'.repeat(32),
    CMS_MIGRATOR_PASSWORD: 'synthetic-migrator-secret-' + 'y'.repeat(32),
    CMS_RUNTIME_PASSWORD: 'synthetic-runtime-secret-' + 'z'.repeat(32) }
  const fixtures = [
    { name: 'expected', rows: [
      { roleName: 'cms_control', authRowExists: true, hasPassword: false },
      { roleName: 'cms_controller', authRowExists: true, hasPassword: true },
    ], accepted: true },
    { name: 'control-has-password', rows: [
      { roleName: 'cms_control', authRowExists: true, hasPassword: true },
      { roleName: 'cms_controller', authRowExists: true, hasPassword: true },
    ], accepted: false },
    { name: 'controller-password-missing', rows: [
      { roleName: 'cms_control', authRowExists: true, hasPassword: false },
      { roleName: 'cms_controller', authRowExists: true, hasPassword: false },
    ], accepted: false },
    { name: 'control-auth-row-missing', rows: [
      { roleName: 'cms_control', authRowExists: false, hasPassword: false },
      { roleName: 'cms_controller', authRowExists: true, hasPassword: true },
    ], accepted: false },
    { name: 'controller-auth-row-missing', rows: [
      { roleName: 'cms_control', authRowExists: true, hasPassword: false },
      { roleName: 'cms_controller', authRowExists: false, hasPassword: true },
    ], accepted: false },
  ]

  for (const fixture of fixtures) {
    let verifierCalled = false
    const safe = fixture.rows.length === 2 && fixture.rows.every(row => row.authRowExists === true &&
      row.hasPassword === (row.roleName === 'cms_controller'))
    const client = { async connect() {}, async end() {}, async verifyControllerPassword() {}, async query(sql: string) {
      if (sql.includes('current_user AS name, current_database() AS database, r.rolsuper')) {
        return { rows: [{ name: 'cms_admin', database: 'ownerinc_cms', rolsuper: false, rolcreaterole: false }] }
      }
      if (sql === cmsAdminDatabaseRoleVerificationSQL || sql === clusterRolesPublicVerificationSQL) return { rows: [{ safe: true }] }
      if (sql === controlRolesPublicVerificationSQL) { verifierCalled = true; return { rows: [{ safe }] } }
      return { rows: [] }
    } }
    const execution = run('--verify-control', env, client)
    if (fixture.accepted) await execution
    else await assert.rejects(execution, /Unsafe CMS control role contract/)
    assert.equal(verifierCalled, true, `${fixture.name} must exercise the shared verifier`)
  }
})

test('control-role bootstrap fails closed on secret reuse, wrong authority, or role drift', async () => {
  const password = 'synthetic-controller-secret-' + 'x'.repeat(32)
  const env = { ...PORTAL_ENV, CMS_DATABASE_URL: 'postgresql://cms_admin:admin-secret@db.invalid:5432/ownerinc_cms',
    CMS_CONTROLLER_PASSWORD: password, CMS_MIGRATOR_PASSWORD: 'synthetic-migrator-secret-' + 'y'.repeat(32),
    CMS_RUNTIME_PASSWORD: 'synthetic-runtime-secret-' + 'z'.repeat(32), CMS_POSTGRES_PASSWORD: 'synthetic-postgres-secret-' + 'a'.repeat(32) }
  for (const [scenario, accepted] of [['ready', true], ['unsafe-role', false], ['native-acl', false], ['superuser', false]] as const) {
    let ended = false
    const queries: string[] = []
    const client = { async connect() {}, async end() { ended = true }, async verifyControllerPassword() {}, async query(sql: string) {
      queries.push(sql)
      if (sql.includes('current_user AS name, current_database() AS database, r.rolsuper')) {
        return { rows: [{ name: 'cms_admin', database: 'ownerinc_cms', rolsuper: scenario === 'superuser', rolcreaterole: false }] }
      }
      if (sql === cmsAdminDatabaseRoleVerificationSQL) return { rows: [{ safe: scenario !== 'superuser' }] }
      if (sql === clusterRolesPublicVerificationSQL) return { rows: [{ safe: scenario !== 'unsafe-role' }] }
      if (sql === controlRolesPublicVerificationSQL) return { rows: [{ safe: scenario !== 'unsafe-role' }] }
      if (sql.includes('has_table_privilege')) return { rows: [{ safe: scenario !== 'native-acl' }] }
      return { rows: [] }
    } }
    const execution = run('--bootstrap-control', env, client)
    if (accepted) await execution; else await assert.rejects(execution, /Unsafe CMS|requires the non-superuser cms_admin/)
    assert.equal(ended, true)
    if (scenario === 'ready') {
      const grantDatabaseSchema = queries.findIndex(sql => sql.includes('GRANT CONNECT ON DATABASE ownerinc_cms TO cms_control, cms_controller'))
      assert.ok(grantDatabaseSchema >= 0)
      assert.equal(queries.some(sql => /CREATE ROLE|ALTER ROLE/u.test(sql)), false)
      assert.equal(queries.some(sql => sql.includes('pg_shdepend')), false)
      assert.ok(queries.includes('COMMIT'))
    } else assert.ok(queries.includes('ROLLBACK') || scenario === 'superuser' || scenario === 'unsafe-role')
  }
  await assert.rejects(run('--bootstrap-control', { ...env, CMS_CONTROLLER_PASSWORD: env.CMS_RUNTIME_PASSWORD },
    { async connect() { throw new Error('should not connect') }, async end() {}, async query() { return { rows: [] } } }), /distinct from other configured secrets/)
})

test('bootstrap diagnostics identify the exact role-contract rollback phase without exposing guard errors', async () => {
  const env = { ...PORTAL_ENV, CMS_DATABASE_URL: 'postgresql://cms_admin:admin-secret@db.invalid:5432/ownerinc_cms',
    CMS_CONTROLLER_PASSWORD: 'synthetic-controller-secret-' + 'x'.repeat(32),
    CMS_MIGRATOR_PASSWORD: 'synthetic-migrator-secret-' + 'y'.repeat(32),
    CMS_RUNTIME_PASSWORD: 'synthetic-runtime-secret-' + 'z'.repeat(32) }
  const queries: string[] = []
  let ended = false
  const client = { async connect() {}, async end() { ended = true }, async verifyControllerPassword() {}, async query(sql: string) {
    queries.push(sql)
    if (sql.includes('current_user AS name, current_database() AS database, r.rolsuper')) {
      return { rows: [{ name: 'cms_admin', database: 'ownerinc_cms', rolsuper: false, rolcreaterole: false }] }
    }
    if (sql.includes("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cms_controller')")) return { rows: [{ present: false }] }
    if (sql === cmsAdminDatabaseRoleVerificationSQL || sql === clusterRolesPublicVerificationSQL) return { rows: [{ safe: true }] }
    if (sql === controlRolesPublicVerificationSQL) return { rows: [{ safe: false }] }
    return { rows: [] }
  } }

  let failure: unknown
  try { await run('--bootstrap-control', env, client) } catch (error) { failure = error }
  assert.ok(failure instanceof Error)
  assert.match(failure.message, /Unsafe CMS control role contract/)
  assert.equal(ended, true)
  assert.ok(queries.includes('ROLLBACK'))
  assert.equal(queries.includes('COMMIT'), false)
  const diagnostic = getBootstrapControlFailureDiagnostic(failure)
  assert.deepEqual(diagnostic, { phase: 'role-contract-policy', sqlstate: null })
  assert.equal(formatBootstrapControlFailureDiagnostic(diagnostic!),
    'CMS bootstrap diagnostic: phase=role-contract-policy sqlstate=none')
  assert.doesNotMatch(JSON.stringify(diagnostic), /Unsafe CMS control role contract|admin-secret|synthetic-/u)
})

test('bootstrap diagnostics preserve a valid PostgreSQL SQLSTATE but discard malicious error text/code', async () => {
  const env = { ...PORTAL_ENV, CMS_DATABASE_URL: 'postgresql://cms_admin:admin-secret@db.invalid:5432/ownerinc_cms',
    CMS_CONTROLLER_PASSWORD: 'synthetic-controller-secret-' + 'x'.repeat(32),
    CMS_MIGRATOR_PASSWORD: 'synthetic-migrator-secret-' + 'y'.repeat(32),
    CMS_RUNTIME_PASSWORD: 'synthetic-runtime-secret-' + 'z'.repeat(32) }
  const identityQuery = 'SELECT current_user AS name, current_database() AS database, r.rolsuper'
  const validPgError = Object.assign(new Error('database password=must-not-appear'), { code: '40P01' })
  const baseClient = (failure: unknown) => ({ async connect() {}, async end() {}, async verifyControllerPassword() {}, async query(sql: string) {
    if (sql.includes(identityQuery)) return { rows: [{ name: 'cms_admin', database: 'ownerinc_cms', rolsuper: false, rolcreaterole: false }] }
    if (sql === cmsAdminDatabaseRoleVerificationSQL || sql === clusterRolesPublicVerificationSQL) return { rows: [{ safe: true }] }
    if (sql === 'SELECT pg_advisory_xact_lock(7194031)') throw failure
    return { rows: [{ present: false }] }
  } })

  let caught: unknown
  try { await run('--bootstrap-control', env, baseClient(validPgError)) } catch (error) { caught = error }
  assert.equal(caught, validPgError)
  assert.deepEqual(getBootstrapControlFailureDiagnostic(caught), { phase: 'transaction-lock', sqlstate: '40P01' })

  const hostile = new Error('connectionString=secret; password=must-not-appear')
  Object.defineProperty(hostile, 'code', { get() { throw new Error('credential getter must not run') } })
  caught = undefined
  try { await run('--bootstrap-control', env, baseClient(hostile)) } catch (error) { caught = error }
  assert.equal(caught, hostile)
  const hostileDiagnostic = getBootstrapControlFailureDiagnostic(caught)
  assert.deepEqual(hostileDiagnostic, { phase: 'transaction-lock', sqlstate: null })
  const safeLine = formatBootstrapControlFailureDiagnostic(hostileDiagnostic!)
  assert.equal(safeLine, 'CMS bootstrap diagnostic: phase=transaction-lock sqlstate=none')
  assert.doesNotMatch(safeLine, /connectionString|secret|password|getter|must-not-appear/u)

  const stringCodeError = Object.assign(new Error('private connection URL must not appear'), { code: 'password-secret-value' })
  caught = undefined
  try { await run('--bootstrap-control', env, baseClient(stringCodeError)) } catch (error) { caught = error }
  assert.equal(caught, stringCodeError)
  const stringCodeDiagnostic = getBootstrapControlFailureDiagnostic(caught)
  assert.deepEqual(stringCodeDiagnostic, { phase: 'transaction-lock', sqlstate: null })
  assert.doesNotMatch(formatBootstrapControlFailureDiagnostic(stringCodeDiagnostic!), /password-secret-value|private connection URL/u)
})

test('non-bootstrap control verification does not acquire bootstrap diagnostic output', async () => {
  const env = { ...PORTAL_ENV, CMS_DATABASE_URL: 'postgresql://cms_admin:admin-secret@db.invalid:5432/ownerinc_cms',
    CMS_CONTROLLER_PASSWORD: 'synthetic-controller-secret-' + 'x'.repeat(32),
    CMS_MIGRATOR_PASSWORD: 'synthetic-migrator-secret-' + 'y'.repeat(32),
    CMS_RUNTIME_PASSWORD: 'synthetic-runtime-secret-' + 'z'.repeat(32) }
  const client = { async connect() {}, async end() {}, async verifyControllerPassword() { throw new Error('synthetic verify failure') }, async query(sql: string) {
    if (sql.includes('current_user AS name, current_database() AS database, r.rolsuper')) {
      return { rows: [{ name: 'cms_admin', database: 'ownerinc_cms', rolsuper: false, rolcreaterole: false }] }
    }
    if (sql === cmsAdminDatabaseRoleVerificationSQL || sql === clusterRolesPublicVerificationSQL
        || sql === controlRolesPublicVerificationSQL) return { rows: [{ safe: true }] }
    return { rows: [] }
  } }
  let failure: unknown
  try { await run('--verify-control', env, client) } catch (error) { failure = error }
  assert.ok(failure instanceof Error)
  assert.equal(getBootstrapControlFailureDiagnostic(failure), null)
})

test('control verification is phase-agnostic for approved finalizer ownership but still rejects role drift', async () => {
  const env = { ...PORTAL_ENV, CMS_DATABASE_URL: 'postgresql://cms_admin:admin-secret@db.invalid:5432/ownerinc_cms',
    CMS_CONTROLLER_PASSWORD: 'synthetic-controller-secret-' + 'x'.repeat(32),
    CMS_MIGRATOR_PASSWORD: 'synthetic-migrator-secret-' + 'y'.repeat(32),
    CMS_RUNTIME_PASSWORD: 'synthetic-runtime-secret-' + 'z'.repeat(32) }
  for (const [scenario, safe] of [['finalized-control-owns-approved-function', true], ['unexpected-role-attributes', false], ['unexpected-membership', false]] as const) {
    const queries: string[] = []
    const client = { async connect() {}, async end() {}, async verifyControllerPassword() {}, async query(sql: string) {
      queries.push(sql)
      if (sql.includes('current_user AS name, current_database() AS database, r.rolsuper')) {
        return { rows: [{ name: 'cms_admin', database: 'ownerinc_cms', rolsuper: false, rolcreaterole: false }] }
      }
      if (sql === cmsAdminDatabaseRoleVerificationSQL || sql === clusterRolesPublicVerificationSQL) return { rows: [{ safe: true }] }
      if (sql === controlRolesPublicVerificationSQL) return { rows: [{ safe }] }
      throw new Error('verify-control issued an unexpected query')
    } }
    const execution = run('--verify-control', env, client)
    if (safe) await execution; else await assert.rejects(execution, /Unsafe CMS control role contract/)
    assert.equal(queries.some(sql => sql.includes('pg_shdepend')), false, `${scenario}: ownership guard is bootstrap-only`)
    assert.equal(queries.some(sql => sql.includes('has_table_privilege')), false, `${scenario}: native ACL guard is bootstrap-only`)
  }
})

test('runtime grants restore native privileges then narrow optional protocol tables and verify effective rights', () => {
  const grants = grantsSQL
  const protocol = buildProtocolRuntimeGrantsSQL()
  assert.match(grants, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cms_runtime/)
  assert.match(grants, /GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cms_runtime/)
  assert.match(grants, /payload_migrations[\s\S]*GRANT SELECT ON TABLE public\.payload_migrations/)
  for (const table of ['owner_news_mutation_head', 'owner_news_mutation_events', 'news_migration_runs']) {
    assert.ok(protocol.includes(`to_regclass('public.${table}')`), `optional table guard ${table}`)
    assert.match(protocol, /REVOKE ALL PRIVILEGES ON TABLE %s FROM cms_runtime/)
    assert.match(protocol, /REVOKE INSERT \(%1\$I\), UPDATE \(%1\$I\), REFERENCES \(%1\$I\)/)
  }
  assert.match(protocol, /GRANT SELECT ON TABLE %s TO cms_runtime/)
  for (const allowed of ['progress_state', 'commit_outcome', 'reconciliation_sha256', 'destination_fingerprint', 'unresolved_exceptions']) assert.ok(protocol.includes(`'${allowed}'`))
  for (const forbidden of ['admission_state', 'activation_epoch', 'drain_receipt_sha256', 'reconciliation_sequence', 'reconciliation_chain_sha256', 'sealed_sequence', 'sealed_chain_sha256', 'sealed_at']) assert.ok(!protocol.includes(`'${forbidden}'`))
  assert.match(protocol, /GRANT UPDATE \(%1\$I\) ON TABLE %2\$s TO cms_runtime/)
  assert.match(protocol, /REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, cms_runtime/)
  for (const expected of ['has_column_privilege', 'TRUNCATE', 'TRIGGER', 'owner_news_mutation_head', 'owner_news_mutation_events', 'news_migration_runs']) assert.ok(runtimeProtocolPrivilegesVerifySQL.includes(expected))
  for (const expected of ['owner_news_mutation_guard_stmt', 'owner_news_mutation_capture_row', 'owner_news_seal_run', 'has_function_privilege']) assert.ok(runtimeProtocolFunctionsVerifySQL.includes(expected))
})

test('runtime preflight fails closed on excessive roles, ownership or missing grants and closes connections', async () => {
  const role = { name: 'cms_runtime', database: 'ownerinc_cms', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false, rolreplication: false,
    rolbypassrls: false, connection_limit_safe: true, expiry_safe: true, settings_safe: true, ddl: false, create_schema: false, temporary: false, member: false }
  const grants = { content: true, jobs: true, migration_write: false, owns_objects: false }
  for (const [roleChange, grantChange, protocolSafe, functionsSafe, passes] of [
    [{}, {}, true, true, true], [{ name: 'cms_admin' }, {}, true, true, false], [{ member: true }, {}, true, true, false],
    [{ ddl: true }, {}, true, true, false], [{ create_schema: true }, {}, true, true, false], [{ temporary: true }, {}, true, true, false],
    [{ rolsuper: true }, {}, true, true, false], [{}, { owns_objects: true }, true, true, false],
    [{ connection_limit_safe: false }, {}, true, true, false], [{ expiry_safe: false }, {}, true, true, false],
    [{ settings_safe: false }, {}, true, true, false],
    [{}, { migration_write: true }, true, true, false], [{}, { jobs: false }, true, true, false], [{}, { content: false }, true, true, false],
    [{}, {}, false, true, false], [{}, {}, true, false, false],
  ] as const) {
    let ended = false
    const client = { async connect() {}, async end() { ended = true }, async verifyControllerPassword() {}, async query(sql: string) {
      if (sql.includes('SELECT current_user AS name')) return { rows: [{ ...role, ...roleChange }] }
      if (sql.includes('COALESCE(bool_and(')) return { rows: [{ safe: protocolSafe }] }
      if (sql.includes('has_function_privilege')) return { rows: [{ safe: functionsSafe }] }
      return { rows: [{ ...grants, ...grantChange }] }
    } }
    const execution = run('--verify-runtime', { CMS_DATABASE_URL: 'postgresql://cms_runtime@cms.invalid/ownerinc_cms' }, client)
    if (passes) await execution; else await assert.rejects(execution, /Unsafe CMS/)
    assert.equal(ended, true)
  }
})

test('private storage uses external runtime media root and rejects checkout paths', () => {
  const payloadAt = (staticDir: string) => ({
    collections: { 'news-media': { config: { upload: { staticDir } } } },
  }) as unknown as Payload
  const media = path.resolve(os.tmpdir(), 'ownerinc-cms', 'media')
  assert.equal(privateStorageDir(payloadAt(media)), media)
  assert.throws(() => privateStorageDir(payloadAt(path.resolve('uploads'))), /media_unavailable/)
  assert.throws(() => privateStorageDir(payloadAt(path.resolve('cms', 'uploads'))), /media_unavailable/)
})
