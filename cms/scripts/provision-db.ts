import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
type Client = { connect(): Promise<void>; end(): Promise<void>; query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; verifyControllerPassword?(): Promise<void> }
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

export const bootstrapControlFailurePhases = [
  'connection-configuration', 'controller-password-validation', 'admin-connect', 'admin-identity',
  'existing-controller-check', 'existing-controller-authentication', 'transaction-begin', 'transaction-lock',
  'role-creation', 'database-schema-grants', 'role-contract-query', 'role-contract-policy',
  'ownership-query', 'ownership-policy', 'native-privilege-query', 'native-privilege-policy',
  'transaction-commit', 'post-commit-controller-login',
] as const
export type BootstrapControlFailurePhase = typeof bootstrapControlFailurePhases[number]
export type BootstrapControlFailureDiagnostic = { phase: BootstrapControlFailurePhase; sqlstate: string | null }

const bootstrapControlDiagnostics = new WeakMap<object, BootstrapControlFailureDiagnostic>()

function safePostgresSqlState(error: unknown): string | null {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return null
  try {
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value
    return typeof code === 'string' && /^[0-9A-Z]{5}$/u.test(code) ? code : null
  } catch { return null }
}

export function getBootstrapControlFailureDiagnostic(error: unknown): BootstrapControlFailureDiagnostic | null {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return null
  return bootstrapControlDiagnostics.get(error as object) || null
}

export function formatBootstrapControlFailureDiagnostic(diagnostic: BootstrapControlFailureDiagnostic): string {
  const phase = bootstrapControlFailurePhases.includes(diagnostic.phase) ? diagnostic.phase : 'connection-configuration'
  const sqlstate = typeof diagnostic.sqlstate === 'string' && /^[0-9A-Z]{5}$/u.test(diagnostic.sqlstate)
    ? diagnostic.sqlstate : 'none'
  return `CMS bootstrap diagnostic: phase=${phase} sqlstate=${sqlstate}`
}

function recordBootstrapControlFailure(error: unknown, phase: BootstrapControlFailurePhase, sqlstate: string | null) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return
  bootstrapControlDiagnostics.set(error as object, { phase, sqlstate: sqlstate || safePostgresSqlState(error) })
}

function validateControllerPassword(password: string, env: Record<string, string | undefined>) {
  if (password.length < 32 || /[\x00-\x1f\\]/u.test(password) || /example|placeholder|change-me/i.test(password)) {
    throw new Error('Invalid CMS controller password')
  }
  const otherSecrets = new Set<string>()
  for (const [name, value] of Object.entries(env)) {
    if (!value || name === 'CMS_CONTROLLER_PASSWORD') continue
    if (/(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY)$/i.test(name)) otherSecrets.add(value)
    if (/_DATABASE_URL$/i.test(name)) {
      try {
        const url = new URL(value)
        if (url.password) otherSecrets.add(decodeURIComponent(url.password))
      } catch { /* The selected CMS_DATABASE_URL is validated separately. */ }
    }
  }
  if (otherSecrets.has(password)) throw new Error('CMS controller password must be distinct from other configured secrets')
}

function controlRolesObservedSQL(expectedRows: string): string {
  return `
WITH expected(role_name, can_login, schema_create) AS (${expectedRows}), observed AS (
  SELECT e.*, r.oid, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
    r.rolinherit, r.rolreplication, r.rolbypassrls,
    a.oid IS NOT NULL AS auth_row_exists,
    a.rolpassword IS NOT NULL AS has_password
  FROM expected e LEFT JOIN pg_roles r ON r.rolname=e.role_name
  LEFT JOIN pg_catalog.pg_authid a ON a.oid=r.oid
)
`
}

/** Shared, read-only role contract for bootstrap verification and the later
 * protocol finalizer. Password presence comes from a privileged catalog join;
 * the secret itself is never selected. Callers must first establish the
 * existing cms_admin superuser boundary. Deliberately excludes object
 * ownership: the finalizer owns its approved SECURITY DEFINER functions. */
export const controlRolesVerificationSQL = `${controlRolesObservedSQL(`VALUES
  ('cms_control'::name, false, true),
  ('cms_controller'::name, true, false)`)}
SELECT count(*)=2 AND bool_and(
  oid IS NOT NULL
  AND auth_row_exists
  AND rolcanlogin=can_login
  AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
  AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls
  AND CASE WHEN role_name='cms_control' THEN NOT has_password ELSE has_password END
  AND has_database_privilege(role_name, current_database(), 'CONNECT')
  AND NOT has_database_privilege(role_name, current_database(), 'CREATE')
  AND NOT has_database_privilege(role_name, current_database(), 'TEMP')
  AND has_schema_privilege(role_name, 'public', 'USAGE')
  AND has_schema_privilege(role_name, 'public', 'CREATE')=schema_create
  AND NOT EXISTS (SELECT 1 FROM pg_auth_members m
    WHERE m.roleid=oid OR m.member=oid)
) AS safe
FROM observed
`

/** Read-only diagnostic projection using the exact password-presence join
 * consumed by the contract. Parameterize the role names; never return hashes. */
export function controlRolePasswordPresenceSQL(): string {
  return `${controlRolesObservedSQL(`
    SELECT role_name, NULL::boolean AS can_login, NULL::boolean AS schema_create
    FROM unnest($1::name[]) AS requested(role_name)`)}
SELECT role_name, auth_row_exists, has_password FROM observed ORDER BY role_name
`
}

/** Bootstrap-only guard. pg_shdepend lets the privileged bootstrap refuse a
 * pre-existing control role that already owns an object anywhere in the cluster. */
export const controlRolesOwnershipVerificationSQL = `
SELECT NOT EXISTS (
  SELECT 1 FROM pg_shdepend d JOIN pg_roles r ON r.oid=d.refobjid
  WHERE d.refclassid='pg_authid'::regclass AND d.deptype='o'
    AND r.rolname = ANY(ARRAY['cms_control','cms_controller']::name[])
) AS safe
`

/** Bootstrap-only check: these roles must not inherit effective CRUD on native
 * relations/sequences. Later finalizer ACLs are separately owned by that phase. */
export const controlRolesNativePrivilegesVerificationSQL = `
SELECT NOT EXISTS (
  SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  CROSS JOIN unnest(ARRAY['cms_control','cms_controller']::name[]) role_name
  WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S')
    AND (
      (c.relkind='S' AND EXISTS (SELECT 1 FROM unnest(ARRAY['USAGE','SELECT','UPDATE']::text[]) p
        WHERE has_sequence_privilege(role_name,c.oid,p)))
      OR (c.relkind<>'S' AND EXISTS (SELECT 1 FROM unnest(ARRAY[
        'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'
      ]::text[]) p WHERE has_table_privilege(role_name,c.oid,p)))
    )
) AS safe
`

/** Cluster-global CREATE ROLE plus narrow DB/schema grants. Existing roles are
 * never ALTERed; the caller must verify their exact contract before this runs. */
function controlRolesCreationSQL(controllerPassword: string): string {
  if (controllerPassword.length < 32 || /[\x00-\x1f\\]/u.test(controllerPassword) || /example|placeholder|change-me/i.test(controllerPassword)) {
    throw new Error('Invalid CMS controller password')
  }
  return `
DO $owner_news_control_roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cms_control') THEN
    EXECUTE 'CREATE ROLE cms_control NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cms_controller') THEN
    EXECUTE 'CREATE ROLE cms_controller LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ' || ${quote(quote(controllerPassword))};
  END IF;
END;
$owner_news_control_roles$;
`
}

function controlRolesGrantsSQL(): string {
  return `
GRANT CONNECT ON DATABASE ownerinc_cms TO cms_control, cms_controller;
GRANT USAGE, CREATE ON SCHEMA public TO cms_control;
GRANT USAGE ON SCHEMA public TO cms_controller;
`
}

export function controlRolesBootstrapSQL(controllerPassword: string): string {
  return `${controlRolesCreationSQL(controllerPassword)}${controlRolesGrantsSQL()}`
}

export function provisioningSQL(migrator: string, runtime: string): string {
  for (const value of [migrator, runtime]) {
    if (value.length < 32 || /[\x00-\x1f\\]/u.test(value) || /example|placeholder|change-me/i.test(value)) throw new Error('Invalid CMS role password')
  }
  if (migrator === runtime) throw new Error('CMS role passwords must differ')
  return `
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='cms_migrator') THEN CREATE ROLE cms_migrator; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='cms_runtime') THEN CREATE ROLE cms_runtime; END IF;
END $$;
ALTER ROLE cms_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quote(migrator)};
ALTER ROLE cms_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quote(runtime)};
REVOKE ALL ON DATABASE ownerinc_cms FROM PUBLIC;
REVOKE ALL ON DATABASE ownerinc_cms FROM cms_runtime;
GRANT CONNECT ON DATABASE ownerinc_cms TO cms_migrator, cms_runtime;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO cms_migrator;
GRANT USAGE ON SCHEMA public TO cms_runtime;
REVOKE CREATE ON SCHEMA public FROM cms_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE cms_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cms_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE cms_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO cms_runtime;
`
}

/** Canonical runtime protocol policy. Keep aligned with
 * mutation-triggers.ts::buildNewsMutationTriggersDDL: ledger head/events are
 * SELECT-only; migration runs receive only the ordinary progress-column UPDATE
 * allowlist. The control role owns seal/bookkeeping privileges. */
export function buildProtocolRuntimeGrantsSQL(): string {
  return `
DO $owner_news_runtime_grants$
DECLARE
  relation regclass;
  column_name name;
  ordinary_run_columns constant text[] := ARRAY[
    'progress_state', 'commit_outcome', 'reconciliation_sha256',
    'destination_fingerprint', 'unresolved_exceptions'
  ];
  function_signature text;
BEGIN
  relation := to_regclass('public.owner_news_mutation_head');
  IF relation IS NOT NULL THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM cms_runtime', relation);
    FOR column_name IN SELECT attname FROM pg_attribute
      WHERE attrelid=relation AND attnum>0 AND NOT attisdropped
    LOOP
      EXECUTE format('REVOKE INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON TABLE %2$s FROM cms_runtime', column_name, relation);
    END LOOP;
    EXECUTE format('GRANT SELECT ON TABLE %s TO cms_runtime', relation);
  END IF;

  relation := to_regclass('public.owner_news_mutation_events');
  IF relation IS NOT NULL THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM cms_runtime', relation);
    FOR column_name IN SELECT attname FROM pg_attribute
      WHERE attrelid=relation AND attnum>0 AND NOT attisdropped
    LOOP
      EXECUTE format('REVOKE INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON TABLE %2$s FROM cms_runtime', column_name, relation);
    END LOOP;
    EXECUTE format('GRANT SELECT ON TABLE %s TO cms_runtime', relation);
  END IF;

  relation := to_regclass('public.news_migration_runs');
  IF relation IS NOT NULL THEN
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM cms_runtime', relation);
    FOR column_name IN SELECT attname FROM pg_attribute
      WHERE attrelid=relation AND attnum>0 AND NOT attisdropped
    LOOP
      EXECUTE format('REVOKE INSERT (%1$I), UPDATE (%1$I), REFERENCES (%1$I) ON TABLE %2$s FROM cms_runtime', column_name, relation);
    END LOOP;
    EXECUTE format('GRANT SELECT ON TABLE %s TO cms_runtime', relation);
    FOR column_name IN SELECT attname FROM pg_attribute
      WHERE attrelid=relation AND attnum>0 AND NOT attisdropped
        AND attname = ANY(ordinary_run_columns)
    LOOP
      EXECUTE format('GRANT UPDATE (%1$I) ON TABLE %2$s TO cms_runtime', column_name, relation);
    END LOOP;
  END IF;

  FOREACH function_signature IN ARRAY ARRAY[
    'public.owner_news_mutation_guard_stmt()',
    'public.owner_news_mutation_capture_row()',
    'public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text)'
  ] LOOP
    IF to_regprocedure(function_signature) IS NOT NULL THEN
      EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, cms_runtime', to_regprocedure(function_signature));
    END IF;
  END LOOP;
END;
$owner_news_runtime_grants$;
`
}

/**
 * Verify effective relation and per-column rights, not SQL text or only role
 * attributes. The relation catalog scan is empty on pre-protocol schemas and
 * therefore remains compatible before those tables are installed.
 */
export const runtimeProtocolPrivilegesVerifySQL = `
SELECT COALESCE(bool_and(
  CASE
    WHEN c.relname IN ('owner_news_mutation_head','owner_news_mutation_events') THEN
      has_table_privilege(current_user,c.oid,'SELECT')
      AND NOT has_table_privilege(current_user,c.oid,'INSERT')
      AND NOT has_table_privilege(current_user,c.oid,'UPDATE')
      AND NOT has_table_privilege(current_user,c.oid,'DELETE')
      AND NOT has_table_privilege(current_user,c.oid,'TRUNCATE')
      AND NOT has_table_privilege(current_user,c.oid,'REFERENCES')
      AND NOT has_table_privilege(current_user,c.oid,'TRIGGER')
      AND NOT EXISTS (SELECT 1 FROM pg_attribute a
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          AND (has_column_privilege(current_user,c.oid,a.attnum,'INSERT')
            OR has_column_privilege(current_user,c.oid,a.attnum,'UPDATE')
            OR has_column_privilege(current_user,c.oid,a.attnum,'REFERENCES')))
    WHEN c.relname='news_migration_runs' THEN
      has_table_privilege(current_user,c.oid,'SELECT')
      AND NOT has_table_privilege(current_user,c.oid,'INSERT')
      AND NOT has_table_privilege(current_user,c.oid,'UPDATE')
      AND NOT has_table_privilege(current_user,c.oid,'DELETE')
      AND NOT has_table_privilege(current_user,c.oid,'TRUNCATE')
      AND NOT has_table_privilege(current_user,c.oid,'REFERENCES')
      AND NOT has_table_privilege(current_user,c.oid,'TRIGGER')
      AND NOT EXISTS (SELECT 1 FROM pg_attribute a
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          AND (has_column_privilege(current_user,c.oid,a.attnum,'INSERT')
            OR has_column_privilege(current_user,c.oid,a.attnum,'REFERENCES')
            OR CASE WHEN a.attname = ANY(ARRAY[
            'progress_state','commit_outcome','reconciliation_sha256',
            'destination_fingerprint','unresolved_exceptions'
          ]::name[]) THEN NOT has_column_privilege(current_user,c.oid,a.attnum,'UPDATE')
            ELSE has_column_privilege(current_user,c.oid,a.attnum,'UPDATE') END))
    ELSE false
  END
),true) AS safe
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relkind IN ('r','p')
  AND c.relname IN ('owner_news_mutation_head','owner_news_mutation_events','news_migration_runs')
`

export const runtimeProtocolFunctionsVerifySQL = `
SELECT NOT EXISTS (
  SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN ('owner_news_mutation_guard_stmt','owner_news_mutation_capture_row','owner_news_seal_run')
    AND has_function_privilege(current_user,p.oid,'EXECUTE')
) AS safe
`

export const grantsSQL = `
GRANT USAGE ON SCHEMA public TO cms_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cms_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cms_runtime;
DO $owner_news_native_ledger$
BEGIN
  IF to_regclass('public.payload_migrations') IS NOT NULL THEN
    REVOKE ALL PRIVILEGES ON TABLE public.payload_migrations FROM cms_runtime;
    GRANT SELECT ON TABLE public.payload_migrations TO cms_runtime;
  END IF;
END;
$owner_news_native_ledger$;
${buildProtocolRuntimeGrantsSQL()}
`

export async function run(mode: string, env: Record<string, string | undefined> = process.env, suppliedClient?: Client) {
  if (!['--provision', '--grants', '--verify-migrator', '--verify-runtime', '--bootstrap-control', '--verify-control'].includes(mode)) throw new Error('Invalid provisioning mode')
  const diagnosticState = { phase: 'connection-configuration' as BootstrapControlFailurePhase, sqlstate: null as string | null }
  try { await runProvisioning(mode, env, suppliedClient, diagnosticState) }
  catch (error) {
    if (mode === '--bootstrap-control') recordBootstrapControlFailure(error, diagnosticState.phase, diagnosticState.sqlstate)
    throw error
  }
}

async function runProvisioning(mode: string, env: Record<string, string | undefined>, suppliedClient: Client | undefined,
  diagnosticState: { phase: BootstrapControlFailurePhase; sqlstate: string | null }) {
  let url: URL
  try { url = new URL(env.CMS_DATABASE_URL || '') } catch { throw new Error('Invalid CMS database target') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname !== '/ownerinc_cms') throw new Error('Invalid CMS database target')
  let username = ''
  try { username = decodeURIComponent(url.username) } catch { throw new Error('Unsafe CMS database connection identity') }
  if (['--provision', '--bootstrap-control', '--verify-control'].includes(mode) && username !== 'cms_admin') throw new Error('Unsafe CMS admin connection identity')
  if (mode === '--bootstrap-control' || mode === '--verify-control') {
    if (mode === '--bootstrap-control') diagnosticState.phase = 'controller-password-validation'
    validateControllerPassword(env.CMS_CONTROLLER_PASSWORD || '', env)
  }
  const { Client: PgClient } = require('pg') as { Client: new (options: object) => Client }
  const client = suppliedClient || new PgClient({ connectionString: url.href, connectionTimeoutMillis: 5000 })
  const verifyControllerLogin = async () => {
    if (suppliedClient?.verifyControllerPassword) return suppliedClient.verifyControllerPassword()
    const controllerURL = new URL(url.href)
    controllerURL.username = 'cms_controller'
    controllerURL.password = env.CMS_CONTROLLER_PASSWORD || ''
    const verifier = new PgClient({ connectionString: controllerURL.href, connectionTimeoutMillis: 5000 })
    try { await verifier.connect() } catch (error) {
      if (mode === '--bootstrap-control') diagnosticState.sqlstate = safePostgresSqlState(error)
      throw new Error('CMS controller credential verification failed')
    }
    finally { await verifier.end() }
  }
  try {
    if (mode === '--bootstrap-control') diagnosticState.phase = 'admin-connect'
    await client.connect()
    if (mode === '--provision') {
      const identity = await client.query('SELECT current_user AS name, current_database() AS database')
      if (identity.rows[0]?.name !== 'cms_admin' || identity.rows[0]?.database !== 'ownerinc_cms') throw new Error('Unsafe CMS provisioner role')
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(7194031)')
      await client.query(provisioningSQL(env.CMS_MIGRATOR_PASSWORD || '', env.CMS_RUNTIME_PASSWORD || ''))
      await client.query('COMMIT')
    } else if (mode === '--bootstrap-control' || mode === '--verify-control') {
      if (mode === '--bootstrap-control') diagnosticState.phase = 'admin-identity'
      const admin = await client.query(`SELECT current_user AS name, current_database() AS database, r.rolsuper
        FROM pg_roles r WHERE r.rolname=current_user`)
      if (admin.rows[0]?.name !== 'cms_admin' || admin.rows[0]?.database !== 'ownerinc_cms' || admin.rows[0]?.rolsuper !== true) {
        throw new Error('CMS control bootstrap requires the cms_admin superuser on ownerinc_cms')
      }
      if (mode === '--bootstrap-control') {
        diagnosticState.phase = 'existing-controller-check'
        const existing = await client.query("SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cms_controller') AS present")
        if (existing.rows[0]?.present === true) {
          diagnosticState.phase = 'existing-controller-authentication'
          await verifyControllerLogin()
        }
        diagnosticState.phase = 'transaction-begin'
        await client.query('BEGIN')
        diagnosticState.phase = 'transaction-lock'
        await client.query('SELECT pg_advisory_xact_lock(7194031)')
        diagnosticState.phase = 'role-creation'
        await client.query(controlRolesCreationSQL(env.CMS_CONTROLLER_PASSWORD || ''))
        diagnosticState.phase = 'database-schema-grants'
        await client.query(controlRolesGrantsSQL())
      }
      if (mode === '--bootstrap-control') diagnosticState.phase = 'role-contract-query'
      const roles = await client.query(controlRolesVerificationSQL)
      if (roles.rows[0]?.safe !== true) {
        if (mode === '--bootstrap-control') {
          diagnosticState.phase = 'role-contract-policy'
          await client.query('ROLLBACK')
        }
        throw new Error('Unsafe CMS control role contract')
      }
      if (mode === '--bootstrap-control') {
        diagnosticState.phase = 'ownership-query'
        const ownership = await client.query(controlRolesOwnershipVerificationSQL)
        diagnosticState.phase = 'native-privilege-query'
        const native = await client.query(controlRolesNativePrivilegesVerificationSQL)
        if (ownership.rows[0]?.safe !== true || native.rows[0]?.safe !== true) {
          diagnosticState.phase = ownership.rows[0]?.safe !== true ? 'ownership-policy' : 'native-privilege-policy'
          await client.query('ROLLBACK')
          throw new Error('Unsafe CMS control bootstrap state')
        }
        diagnosticState.phase = 'transaction-commit'
        await client.query('COMMIT')
      }
      if (mode === '--bootstrap-control') diagnosticState.phase = 'post-commit-controller-login'
      await verifyControllerLogin()
    } else {
      const expected = mode === '--verify-runtime' ? 'cms_runtime' : 'cms_migrator'
      const { rows } = await client.query(`SELECT current_user AS name, current_database() AS database, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls,
        has_schema_privilege(current_user, 'public', 'CREATE') AS ddl,
        has_database_privilege(current_user, current_database(), 'CREATE') AS create_schema,
        has_database_privilege(current_user, current_database(), 'TEMP') AS temporary,
        EXISTS (SELECT FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS member
        FROM pg_roles WHERE rolname=current_user`)
      const role = rows[0]
      if (!role || role.name !== expected || role.database !== 'ownerinc_cms' || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolreplication || role.rolbypassrls || role.member || role.ddl !== (expected === 'cms_migrator') || (expected === 'cms_runtime' && (role.create_schema || role.temporary))) throw new Error('Unsafe CMS database role')
      if (mode === '--grants') await client.query(grantsSQL)
      if (mode === '--verify-runtime') {
        const result = await client.query(`SELECT
          (SELECT bool_and(has_table_privilege(current_user,'public.news_articles',p)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p) AS content,
          (SELECT bool_and(has_table_privilege(current_user,'public.payload_jobs',p)) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p) AS jobs,
          has_table_privilege(current_user,'public.payload_migrations','INSERT,UPDATE,DELETE') AS migration_write,
          EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owns_objects`)
        const row = result.rows[0]
        if (!row?.content || !row.jobs || row.migration_write || row.owns_objects) throw new Error('Unsafe CMS runtime grants')
        const protocol = await client.query(runtimeProtocolPrivilegesVerifySQL)
        if (protocol.rows[0]?.safe !== true) throw new Error('Unsafe CMS protocol grants')
        const functions = await client.query(runtimeProtocolFunctionsVerifySQL)
        if (functions.rows[0]?.safe !== true) throw new Error('Unsafe CMS control function grants')
      }
    }
  } finally { await client.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv[2]).catch(error => {
    const diagnostic = process.argv[2] === '--bootstrap-control' ? getBootstrapControlFailureDiagnostic(error) : null
    if (diagnostic) console.error(formatBootstrapControlFailureDiagnostic(diagnostic))
    console.error('CMS database provisioning/verification failed; inspect configuration privately')
    process.exitCode = 1
  })
}
