import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { NextRequest } from 'next/server'
import type { Payload } from 'payload'
import { proxy, editorialPolicy } from '../../src/proxy'
import {
  buildProtocolRuntimeGrantsSQL, controlRolesBootstrapSQL, controlRolesNativePrivilegesVerificationSQL,
  controlRolePasswordPresenceSQL, controlRolesOwnershipVerificationSQL, controlRolesVerificationSQL,
  grantsSQL, provisioningSQL, run,
  getBootstrapControlFailureDiagnostic, formatBootstrapControlFailureDiagnostic,
  runtimeProtocolFunctionsVerifySQL, runtimeProtocolPrivilegesVerifySQL,
} from '../../scripts/provision-db'
import { privateStorageDir } from '../../src/media/storage'

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

test('provisioning quotes passwords, rejects placeholder/control values and separates roles', () => {
  const password = "synthetic-only-'" + 'x'.repeat(32)
  const sql = provisioningSQL(password, 'y'.repeat(40))
  assert.ok(sql.includes("synthetic-only-''"))
  assert.match(sql, /ALTER DEFAULT PRIVILEGES FOR ROLE cms_migrator/)
  assert.match(sql, /REVOKE CREATE ON SCHEMA public FROM cms_runtime/)
  for (const value of ['', 'placeholder-' + 'x'.repeat(32), 'x'.repeat(32) + '\n', 'x'.repeat(32) + '\\']) {
    assert.throws(() => provisioningSQL(value, 'y'.repeat(40)))
  }
  assert.throws(() => provisioningSQL('y'.repeat(40), 'y'.repeat(40)))
})

test('control-role bootstrap creates only the bounded roles and exports reusable role/readiness verifiers', () => {
  const password = "synthetic-controller-'" + 'x'.repeat(32)
  const sql = controlRolesBootstrapSQL(password)
  assert.match(sql, /CREATE ROLE cms_control NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/)
  assert.match(sql, /CREATE ROLE cms_controller LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD/)
  assert.ok(sql.includes("synthetic-controller-''"))
  assert.doesNotMatch(sql, /ALTER\s+ROLE|GRANT\s+cms_control\s+TO|GRANT\s+cms_controller\s+TO/i)
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
  assert.match(controlRolesOwnershipVerificationSQL, /pg_shdepend/)
  assert.match(controlRolesNativePrivilegesVerificationSQL, /has_table_privilege/)
  assert.throws(() => controlRolesBootstrapSQL('placeholder-' + 'x'.repeat(32)), /Invalid CMS controller password/)
})

test('control-role password presence contract consumes auth-catalog booleans and rejects missing rows', async () => {
  const env = { CMS_DATABASE_URL: 'postgresql://cms_admin:admin-secret@db.invalid:5432/ownerinc_cms',
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
        return { rows: [{ name: 'cms_admin', database: 'ownerinc_cms', rolsuper: true }] }
      }
      if (sql === controlRolesVerificationSQL) { verifierCalled = true; return { rows: [{ safe }] } }
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
  const env = { CMS_DATABASE_URL: 'postgresql://cms_admin:admin-secret@db.invalid:5432/ownerinc_cms',
    CMS_CONTROLLER_PASSWORD: password, CMS_MIGRATOR_PASSWORD: 'synthetic-migrator-secret-' + 'y'.repeat(32),
    CMS_RUNTIME_PASSWORD: 'synthetic-runtime-secret-' + 'z'.repeat(32), CMS_POSTGRES_PASSWORD: 'synthetic-postgres-secret-' + 'a'.repeat(32) }
  for (const [scenario, accepted] of [['ready', true], ['unsafe-role', false], ['owns-object', false], ['native-acl', false], ['not-superuser', false]] as const) {
    let ended = false
    const queries: string[] = []
    const client = { async connect() {}, async end() { ended = true }, async verifyControllerPassword() {}, async query(sql: string) {
      queries.push(sql)
      if (sql.includes('current_user AS name, current_database() AS database, r.rolsuper')) {
        return { rows: [{ name: 'cms_admin', database: 'ownerinc_cms', rolsuper: scenario !== 'not-superuser' }] }
      }
      if (sql.includes('WITH expected(role_name')) return { rows: [{ safe: scenario !== 'unsafe-role' }] }
      if (sql.includes('pg_shdepend')) return { rows: [{ safe: scenario !== 'owns-object' }] }
      if (sql.includes('has_table_privilege')) return { rows: [{ safe: scenario !== 'native-acl' }] }
      return { rows: [] }
    } }
    const execution = run('--bootstrap-control', env, client)
    if (accepted) await execution; else await assert.rejects(execution, /Unsafe CMS|requires the cms_admin superuser/)
    assert.equal(ended, true)
    if (scenario === 'ready') {
      const createRoles = queries.findIndex(sql => sql.includes('CREATE ROLE cms_control') && sql.includes('CREATE ROLE cms_controller'))
      const grantDatabaseSchema = queries.findIndex(sql => sql.includes('GRANT CONNECT ON DATABASE ownerinc_cms TO cms_control, cms_controller'))
      assert.ok(createRoles >= 0)
      assert.ok(grantDatabaseSchema > createRoles)
      assert.ok(queries.includes('COMMIT'))
    } else assert.ok(queries.includes('ROLLBACK') || scenario === 'not-superuser')
  }
  await assert.rejects(run('--bootstrap-control', { ...env, CMS_CONTROLLER_PASSWORD: env.CMS_RUNTIME_PASSWORD },
    { async connect() { throw new Error('should not connect') }, async end() {}, async query() { return { rows: [] } } }), /distinct from other configured secrets/)
})

test('bootstrap diagnostics identify the exact role-contract rollback phase without exposing guard errors', async () => {
  const env = { CMS_DATABASE_URL: 'postgresql://cms_admin:admin-secret@db.invalid:5432/ownerinc_cms',
    CMS_CONTROLLER_PASSWORD: 'synthetic-controller-secret-' + 'x'.repeat(32),
    CMS_MIGRATOR_PASSWORD: 'synthetic-migrator-secret-' + 'y'.repeat(32),
    CMS_RUNTIME_PASSWORD: 'synthetic-runtime-secret-' + 'z'.repeat(32) }
  const queries: string[] = []
  let ended = false
  const client = { async connect() {}, async end() { ended = true }, async verifyControllerPassword() {}, async query(sql: string) {
    queries.push(sql)
    if (sql.includes('current_user AS name, current_database() AS database, r.rolsuper')) {
      return { rows: [{ name: 'cms_admin', database: 'ownerinc_cms', rolsuper: true }] }
    }
    if (sql.includes("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cms_controller')")) return { rows: [{ present: false }] }
    if (sql.includes('WITH expected(role_name')) return { rows: [{ safe: false }] }
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
  const env = { CMS_DATABASE_URL: 'postgresql://cms_admin:admin-secret@db.invalid:5432/ownerinc_cms',
    CMS_CONTROLLER_PASSWORD: 'synthetic-controller-secret-' + 'x'.repeat(32),
    CMS_MIGRATOR_PASSWORD: 'synthetic-migrator-secret-' + 'y'.repeat(32),
    CMS_RUNTIME_PASSWORD: 'synthetic-runtime-secret-' + 'z'.repeat(32) }
  const identityQuery = 'SELECT current_user AS name, current_database() AS database, r.rolsuper'
  const validPgError = Object.assign(new Error('database password=must-not-appear'), { code: '40P01' })
  const baseClient = (failure: unknown) => ({ async connect() {}, async end() {}, async verifyControllerPassword() {}, async query(sql: string) {
    if (sql.includes(identityQuery)) return { rows: [{ name: 'cms_admin', database: 'ownerinc_cms', rolsuper: true }] }
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
  const env = { CMS_DATABASE_URL: 'postgresql://cms_admin:admin-secret@db.invalid:5432/ownerinc_cms',
    CMS_CONTROLLER_PASSWORD: 'synthetic-controller-secret-' + 'x'.repeat(32),
    CMS_MIGRATOR_PASSWORD: 'synthetic-migrator-secret-' + 'y'.repeat(32),
    CMS_RUNTIME_PASSWORD: 'synthetic-runtime-secret-' + 'z'.repeat(32) }
  const client = { async connect() {}, async end() {}, async verifyControllerPassword() { throw new Error('synthetic verify failure') }, async query(sql: string) {
    if (sql.includes('current_user AS name, current_database() AS database, r.rolsuper')) {
      return { rows: [{ name: 'cms_admin', database: 'ownerinc_cms', rolsuper: true }] }
    }
    if (sql.includes('WITH expected(role_name')) return { rows: [{ safe: true }] }
    return { rows: [] }
  } }
  let failure: unknown
  try { await run('--verify-control', env, client) } catch (error) { failure = error }
  assert.ok(failure instanceof Error)
  assert.equal(getBootstrapControlFailureDiagnostic(failure), null)
})

test('control verification is phase-agnostic for approved finalizer ownership but still rejects role drift', async () => {
  const env = { CMS_DATABASE_URL: 'postgresql://cms_admin:admin-secret@db.invalid:5432/ownerinc_cms',
    CMS_CONTROLLER_PASSWORD: 'synthetic-controller-secret-' + 'x'.repeat(32),
    CMS_MIGRATOR_PASSWORD: 'synthetic-migrator-secret-' + 'y'.repeat(32),
    CMS_RUNTIME_PASSWORD: 'synthetic-runtime-secret-' + 'z'.repeat(32) }
  for (const [scenario, safe] of [['finalized-control-owns-approved-function', true], ['unexpected-role-attributes', false], ['unexpected-membership', false]] as const) {
    const queries: string[] = []
    const client = { async connect() {}, async end() {}, async verifyControllerPassword() {}, async query(sql: string) {
      queries.push(sql)
      if (sql.includes('current_user AS name, current_database() AS database, r.rolsuper')) {
        return { rows: [{ name: 'cms_admin', database: 'ownerinc_cms', rolsuper: true }] }
      }
      if (sql.includes('WITH expected(role_name')) return { rows: [{ safe }] }
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
  const role = { name: 'cms_runtime', database: 'ownerinc_cms', rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false,
    rolbypassrls: false, ddl: false, create_schema: false, temporary: false, member: false }
  const grants = { content: true, jobs: true, migration_write: false, owns_objects: false }
  for (const [roleChange, grantChange, protocolSafe, functionsSafe, passes] of [
    [{}, {}, true, true, true], [{ name: 'cms_admin' }, {}, true, true, false], [{ member: true }, {}, true, true, false],
    [{ ddl: true }, {}, true, true, false], [{ create_schema: true }, {}, true, true, false], [{ temporary: true }, {}, true, true, false],
    [{ rolsuper: true }, {}, true, true, false], [{}, { owns_objects: true }, true, true, false],
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
