import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { NEWS_MIGRATION_BOOTSTRAP_RUN_SIGNATURE } from '../src/publication/bootstrap-run'
import { NEWS_MUTATION_TABLES } from '../src/publication/mutation-ledger'
import { parsePortalDatabaseName, quotePostgresIdentifier } from './database-contract'
import {
  newsProtocolObserverPostMigrationVerificationSQL,
  observerRelationProvisioningSQL,
} from './news-protocol-observer-contract'

const require = createRequire(import.meta.url)
type Client = { connect(): Promise<void>; end(): Promise<void>; query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; verifyControllerPassword?(): Promise<void>; installCmsOwnershipHelper?(sql: string, verificationSQL: string): Promise<void> }
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
export { parsePortalDatabaseName } from './database-contract'

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

function validateRolePassword(password: string): void {
  if (password.length < 32 || /[\x00-\x1f\\]/u.test(password) || /example|placeholder|change-me/i.test(password)) {
    throw new Error('Invalid CMS role password')
  }
}

function clusterRolePasswords(env: Record<string, string | undefined>) {
  const passwords = {
    admin: env.CMS_POSTGRES_PASSWORD || '',
    controller: env.CMS_CONTROLLER_PASSWORD || '',
    migrator: env.CMS_MIGRATOR_PASSWORD || '',
    runtime: env.CMS_RUNTIME_PASSWORD || '',
    observer: env.CMS_OBSERVER_PASSWORD || '',
  }
  for (const password of Object.values(passwords)) validateRolePassword(password)
  if (new Set(Object.values(passwords)).size !== Object.keys(passwords).length) {
    throw new Error('CMS role passwords must be distinct')
  }
  const targetNames = new Set([
    'CMS_POSTGRES_PASSWORD', 'CMS_CONTROLLER_PASSWORD', 'CMS_MIGRATOR_PASSWORD', 'CMS_RUNTIME_PASSWORD',
    'CMS_OBSERVER_PASSWORD',
  ])
  const externalSecrets = new Set<string>()
  for (const [name, value] of Object.entries(env)) {
    if (!value || targetNames.has(name)) continue
    if (/(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY)$/i.test(name)) externalSecrets.add(value)
    if (/_DATABASE_URL$/i.test(name)) {
      try { const url = new URL(value); if (url.password) externalSecrets.add(decodeURIComponent(url.password)) } catch { /* validated elsewhere */ }
    }
  }
  if (Object.values(passwords).some(password => externalSecrets.has(password))) {
    throw new Error('CMS role passwords must be distinct from other configured secrets')
  }
  return passwords
}

export const CMS_ROLE_NAMES = [
  'cms_admin', 'cms_control', 'cms_controller', 'cms_migrator', 'cms_runtime', 'cms_observer',
] as const

/** Cluster-authority-only reconciliation of the six CMS roles. Portal roles
 * remain exclusively owned by api/db/provision.js. Every CMS target role is created without
 * elevated attributes and every retry rotates login credentials back to the
 * exact least-privilege contract. cms_admin is never granted CREATEROLE. */
export function clusterRolesBootstrapSQL(passwords: ReturnType<typeof clusterRolePasswords>): string {
  return `
DO $ownerinc_cms_roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cms_admin') THEN
    CREATE ROLE cms_admin LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cms_control') THEN
    CREATE ROLE cms_control NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cms_controller') THEN
    CREATE ROLE cms_controller LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cms_migrator') THEN
    CREATE ROLE cms_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cms_runtime') THEN
    CREATE ROLE cms_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='cms_observer') THEN
    CREATE ROLE cms_observer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$ownerinc_cms_roles$;
ALTER ROLE cms_admin WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL 'infinity' PASSWORD ${quote(passwords.admin)};
ALTER ROLE cms_control WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL 'infinity' PASSWORD NULL;
ALTER ROLE cms_controller WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL 'infinity' PASSWORD ${quote(passwords.controller)};
ALTER ROLE cms_migrator WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL 'infinity' PASSWORD ${quote(passwords.migrator)};
ALTER ROLE cms_runtime WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL 'infinity' PASSWORD ${quote(passwords.runtime)};
ALTER ROLE cms_observer WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT -1 VALID UNTIL 'infinity' PASSWORD ${quote(passwords.observer)};
ALTER ROLE cms_admin RESET ALL;
ALTER ROLE cms_control RESET ALL;
ALTER ROLE cms_controller RESET ALL;
ALTER ROLE cms_migrator RESET ALL;
ALTER ROLE cms_runtime RESET ALL;
ALTER ROLE cms_observer RESET ALL;
DO $ownerinc_cms_memberships$
DECLARE membership record;
BEGIN
  FOR membership IN
    SELECT granted.rolname AS granted_role, member.rolname AS member_role
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid=m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid=m.member
    WHERE granted.rolname = ANY(ARRAY['cms_admin','cms_control','cms_controller','cms_migrator','cms_runtime','cms_observer']::name[])
       OR member.rolname = ANY(ARRAY['cms_admin','cms_control','cms_controller','cms_migrator','cms_runtime','cms_observer']::name[])
  LOOP
    EXECUTE format('REVOKE %I FROM %I', membership.granted_role, membership.member_role);
  END LOOP;
END
$ownerinc_cms_memberships$;
GRANT cms_control TO cms_admin WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT cms_migrator TO cms_admin WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT cms_runtime TO cms_admin WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
`
}

export const clusterRolesVerificationSQL = `
WITH expected(role_name, can_login, has_password) AS (VALUES
  ('cms_admin'::name, true, true),
  ('cms_control'::name, false, false),
  ('cms_controller'::name, true, true),
  ('cms_migrator'::name, true, true),
  ('cms_runtime'::name, true, true),
  ('cms_observer'::name, true, true)
), observed AS (
  SELECT e.*, r.oid, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
    r.rolinherit, r.rolreplication, r.rolbypassrls, r.rolconnlimit, r.rolvaliduntil, r.rolconfig,
    a.oid IS NOT NULL AS auth_row_exists, a.rolpassword IS NOT NULL AS password_present
  FROM expected e LEFT JOIN pg_roles r ON r.rolname=e.role_name
  LEFT JOIN pg_catalog.pg_authid a ON a.oid=r.oid
)
SELECT count(*)=6 AND bool_and(
  oid IS NOT NULL AND auth_row_exists AND rolcanlogin=can_login
  AND password_present=has_password
  AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
  AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls
  AND rolconnlimit=-1 AND (rolvaliduntil IS NULL OR rolvaliduntil='infinity'::timestamptz) AND rolconfig IS NULL
) AND (SELECT count(*)=3 FROM pg_catalog.pg_auth_members m
  JOIN pg_catalog.pg_roles granted ON granted.oid=m.roleid
  JOIN pg_catalog.pg_roles member ON member.oid=m.member
  WHERE member.rolname='cms_admin'
    AND granted.rolname IN ('cms_control','cms_migrator','cms_runtime')
    AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option)
AND NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_auth_members m
  JOIN pg_catalog.pg_roles granted ON granted.oid=m.roleid
  JOIN pg_catalog.pg_roles member ON member.oid=m.member
  WHERE (granted.rolname IN (SELECT role_name FROM expected)
      OR member.rolname IN (SELECT role_name FROM expected))
    AND NOT (member.rolname='cms_admin'
      AND granted.rolname IN ('cms_control','cms_migrator','cms_runtime')
      AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option)
)
AND EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname=$1)
AND NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY['cms_admin','cms_control','cms_controller','cms_migrator','cms_runtime','cms_observer']::name[]) role_name
  WHERE has_database_privilege(role_name, $1, 'CONNECT')
) AS safe FROM observed
`

/** Public-catalog equivalent used by non-superuser read-only retry gates. */
export const clusterRolesPublicVerificationSQL = `
WITH expected(role_name, can_login) AS (VALUES
  ('cms_admin'::name,true), ('cms_control'::name,false), ('cms_controller'::name,true),
  ('cms_migrator'::name,true), ('cms_runtime'::name,true), ('cms_observer'::name,true)
), observed AS (
  SELECT expected.*, role.oid, role.rolcanlogin, role.rolsuper, role.rolcreatedb, role.rolcreaterole,
    role.rolinherit, role.rolreplication, role.rolbypassrls, role.rolconnlimit,
    role.rolvaliduntil, role.rolconfig
  FROM expected LEFT JOIN pg_catalog.pg_roles role ON role.rolname=expected.role_name
)
SELECT count(*)=6 AND bool_and(
  oid IS NOT NULL AND rolcanlogin=can_login
  AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
  AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls
  AND rolconnlimit=-1 AND (rolvaliduntil IS NULL OR rolvaliduntil='infinity'::timestamptz)
  AND rolconfig IS NULL
) AND (SELECT count(*)=3 FROM pg_catalog.pg_auth_members membership
  JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
  JOIN pg_catalog.pg_roles member ON member.oid=membership.member
  WHERE member.rolname='cms_admin'
    AND granted.rolname IN ('cms_control','cms_migrator','cms_runtime')
    AND NOT membership.admin_option AND NOT membership.inherit_option AND membership.set_option)
AND NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_auth_members membership
  JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
  JOIN pg_catalog.pg_roles member ON member.oid=membership.member
  WHERE (granted.rolname IN (SELECT role_name FROM expected)
      OR member.rolname IN (SELECT role_name FROM expected))
    AND NOT (member.rolname='cms_admin'
      AND granted.rolname IN ('cms_control','cms_migrator','cms_runtime')
      AND NOT membership.admin_option AND NOT membership.inherit_option AND membership.set_option)
)
AND EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname=$1)
AND NOT EXISTS (
  SELECT 1 FROM expected WHERE has_database_privilege(role_name,$1,'CONNECT')
) AS safe FROM observed
`

/** One database-local cms_admin contract reused by every privileged local
 * entrypoint. It observes only public catalogs and never reconciles the role. */
export const cmsAdminDatabaseRoleVerificationSQL = `
SELECT role.rolcanlogin
  AND NOT role.rolsuper AND NOT role.rolcreatedb AND NOT role.rolcreaterole
  AND NOT role.rolinherit AND NOT role.rolreplication AND NOT role.rolbypassrls
  AND role.rolconnlimit=-1
  AND (role.rolvaliduntil IS NULL OR role.rolvaliduntil='infinity'::timestamptz)
  AND role.rolconfig IS NULL
  AND pg_catalog.current_database()='ownerinc_cms'
  AND pg_catalog.pg_get_userbyid(database.datdba)='cms_admin' AS safe
FROM pg_catalog.pg_roles role
CROSS JOIN pg_catalog.pg_database database
WHERE role.rolname='cms_admin' AND database.datname=pg_catalog.current_database()
`

export async function verifyCmsAdminDatabaseRoleContract(client: Pick<Client, 'query'>): Promise<void> {
  const result = await client.query(cmsAdminDatabaseRoleVerificationSQL)
  if (result.rows.length !== 1 || result.rows[0]?.safe !== true) {
    throw new Error('Unsafe CMS admin role contract')
  }
}

function controlRolesObservedSQL(expectedRows: string): string {
  return `
WITH expected(role_name, can_login, schema_create) AS (${expectedRows}), observed AS (
  SELECT e.*, r.oid, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
    r.rolinherit, r.rolreplication, r.rolbypassrls, r.rolconnlimit, r.rolvaliduntil, r.rolconfig,
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
 * expected non-superuser cms_admin owner boundary. Deliberately excludes object
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
  AND rolconnlimit=-1 AND (rolvaliduntil IS NULL OR rolvaliduntil='infinity'::timestamptz) AND rolconfig IS NULL
  AND CASE WHEN role_name='cms_control' THEN NOT has_password ELSE has_password END
  AND has_database_privilege(role_name, current_database(), 'CONNECT')
  AND NOT has_database_privilege(role_name, current_database(), 'CREATE')
  AND NOT has_database_privilege(role_name, current_database(), 'TEMP')
  AND has_schema_privilege(role_name, 'public', 'USAGE')
  AND has_schema_privilege(role_name, 'public', 'CREATE')=schema_create
  AND NOT EXISTS (SELECT 1 FROM pg_auth_members m
    WHERE (m.roleid=oid OR m.member=oid)
      AND NOT (role_name='cms_control' AND m.roleid=oid
        AND m.member=(SELECT oid FROM pg_roles WHERE rolname='cms_admin')
        AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option))
) AS safe
FROM observed
`

/** Public-catalog role contract for the least-privileged read-only audit.
 * Deliberately omits password presence; only a privileged verifier can inspect
 * that property, and the observer must not inherit such access. */
export const controlRolesPublicVerificationSQL = `
WITH expected(role_name, can_login, schema_create) AS (VALUES
  ('cms_control'::name, false, true),
  ('cms_controller'::name, true, false)
), observed AS (
  SELECT e.*, r.oid, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
    r.rolinherit, r.rolreplication, r.rolbypassrls, r.rolconnlimit, r.rolvaliduntil, r.rolconfig
  FROM expected e LEFT JOIN pg_catalog.pg_roles r ON r.rolname=e.role_name
)
SELECT count(*)=2 AND bool_and(
  oid IS NOT NULL
  AND rolcanlogin=can_login
  AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
  AND NOT rolinherit AND NOT rolreplication AND NOT rolbypassrls
  AND rolconnlimit=-1 AND (rolvaliduntil IS NULL OR rolvaliduntil='infinity'::timestamptz) AND rolconfig IS NULL
  AND has_database_privilege(role_name, current_database(), 'CONNECT')
  AND NOT has_database_privilege(role_name, current_database(), 'CREATE')
  AND NOT has_database_privilege(role_name, current_database(), 'TEMP')
  AND has_schema_privilege(role_name, 'public', 'USAGE')
  AND has_schema_privilege(role_name, 'public', 'CREATE')=schema_create
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
    WHERE (m.roleid=oid OR m.member=oid)
      AND NOT (role_name='cms_control' AND m.roleid=oid
        AND m.member=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='cms_admin')
        AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option))
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

/** Installed only by the protected cluster administrator in ownerinc_cms. The
 * SECURITY DEFINER body reads every pg_shdepend ownership dependency whose dbid
 * is the current database, regardless of object class, plus the current
 * pg_database ownership row. It exposes aggregate counts only: no object OIDs,
 * names, dependencies from another database, or generic catalog access. */
export const clusterOwnershipHelperSQL = `
DROP SCHEMA IF EXISTS cms_cluster_guard CASCADE;
CREATE SCHEMA cms_cluster_guard AUTHORIZATION CURRENT_USER;
REVOKE ALL ON SCHEMA cms_cluster_guard FROM PUBLIC;
CREATE FUNCTION cms_cluster_guard.verify_cms_ownership_contract()
RETURNS TABLE(safe boolean, unexpected_ownership_count bigint, approved_control_function_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER PARALLEL RESTRICTED
SET search_path = pg_catalog
AS $ownerinc_cms_ownership$
  WITH current_db AS (
    SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()
  ), ownership_roles AS (
    SELECT oid, rolname FROM pg_catalog.pg_roles
  ), ownership_dependencies AS (
    SELECT dependency.classid, dependency.objid, dependency.dbid, owner_role.rolname
    FROM pg_catalog.pg_shdepend dependency
    JOIN ownership_roles owner_role ON owner_role.oid=dependency.refobjid
    CROSS JOIN current_db
    WHERE dependency.refclassid='pg_catalog.pg_authid'::regclass
      AND dependency.deptype='o'
      AND (dependency.dbid=current_db.oid OR (
        dependency.dbid=0
        AND dependency.classid='pg_catalog.pg_database'::regclass
        AND dependency.objid=current_db.oid
      ))
  ), classified AS (
    SELECT *,
      COALESCE(rolname='cms_control'
        AND dbid=(SELECT oid FROM current_db)
        AND classid='pg_catalog.pg_proc'::regclass
        AND objid=ANY(ARRAY[
          pg_catalog.to_regprocedure('public.owner_news_mutation_guard_stmt()')::oid,
          pg_catalog.to_regprocedure('public.owner_news_mutation_capture_row()')::oid,
          pg_catalog.to_regprocedure('public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text)')::oid,
          pg_catalog.to_regprocedure('public.owner_news_migration_item_binding_guard()')::oid,
          pg_catalog.to_regprocedure('public.owner_news_bootstrap_run(uuid,text,text,text,integer)')::oid
        ]),false) AS approved_control_function,
      rolname='cms_migrator' AND dbid=(SELECT oid FROM current_db) AS migrator_local_object,
      rolname='cms_admin' AND dbid=0
        AND classid='pg_catalog.pg_database'::regclass
        AND objid=(SELECT oid FROM current_db) AS cms_database,
      rolname=current_user AND dbid=(SELECT oid FROM current_db) AND (
        (classid='pg_catalog.pg_namespace'::regclass
          AND objid='cms_cluster_guard'::regnamespace::oid)
        OR (classid='pg_catalog.pg_proc'::regclass
          AND objid='cms_cluster_guard.verify_cms_ownership_contract()'::regprocedure::oid)
      ) AS bounded_helper_object,
      rolname='pg_database_owner' AND dbid=(SELECT oid FROM current_db)
        AND classid='pg_catalog.pg_namespace'::regclass
        AND objid='public'::regnamespace::oid AS public_schema
    FROM ownership_dependencies
  )
  SELECT count(*) FILTER (WHERE NOT (approved_control_function OR migrator_local_object OR cms_database
      OR bounded_helper_object OR public_schema))=0,
    count(*) FILTER (WHERE NOT (approved_control_function OR migrator_local_object OR cms_database
      OR bounded_helper_object OR public_schema)),
    count(*) FILTER (WHERE approved_control_function)
  FROM classified
$ownerinc_cms_ownership$;
REVOKE ALL ON FUNCTION cms_cluster_guard.verify_cms_ownership_contract() FROM PUBLIC;
GRANT USAGE ON SCHEMA cms_cluster_guard TO cms_admin, cms_observer;
GRANT EXECUTE ON FUNCTION cms_cluster_guard.verify_cms_ownership_contract() TO cms_admin, cms_observer;
`

export const clusterOwnershipHelperVerificationSQL = `
SELECT
  pg_catalog.pg_get_userbyid(namespace.nspowner)=current_user
  AND pg_catalog.pg_get_userbyid(proc.proowner)=current_user
  AND proc.prosecdef AND proc.provolatile='s' AND proc.proparallel='r'
  AND proc.proconfig=ARRAY['search_path=pg_catalog']::text[]
  AND (SELECT count(*)=1 FROM pg_catalog.pg_proc candidate WHERE candidate.pronamespace=namespace.oid)
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.aclexplode(proc.proacl) acl
    WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE'
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.aclexplode(proc.proacl) acl
    LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=acl.grantee
    WHERE grantee.rolname<>current_user AND (
      grantee.rolname NOT IN ('cms_admin','cms_observer')
      OR acl.privilege_type<>'EXECUTE' OR acl.is_grantable)
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.aclexplode(namespace.nspacl) acl
    LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=acl.grantee
    WHERE grantee.rolname<>current_user AND (
      grantee.rolname NOT IN ('cms_admin','cms_observer')
      OR acl.privilege_type<>'USAGE' OR acl.is_grantable)
  )
  AND pg_catalog.has_schema_privilege('cms_admin',namespace.oid,'USAGE')
  AND pg_catalog.has_schema_privilege('cms_observer',namespace.oid,'USAGE')
  AND pg_catalog.has_function_privilege('cms_admin',proc.oid,'EXECUTE')
  AND pg_catalog.has_function_privilege('cms_observer',proc.oid,'EXECUTE')
  AND NOT pg_catalog.has_function_privilege('cms_control',proc.oid,'EXECUTE')
  AND NOT pg_catalog.has_function_privilege('cms_controller',proc.oid,'EXECUTE')
  AND NOT pg_catalog.has_function_privilege('cms_migrator',proc.oid,'EXECUTE')
  AND NOT pg_catalog.has_function_privilege('cms_runtime',proc.oid,'EXECUTE') AS safe
FROM pg_catalog.pg_namespace namespace
JOIN pg_catalog.pg_proc proc ON proc.pronamespace=namespace.oid
WHERE namespace.nspname='cms_cluster_guard'
  AND proc.oid='cms_cluster_guard.verify_cms_ownership_contract()'::regprocedure
`

/** Complete database-local ownership proof, implemented by the bounded helper
 * above so non-superuser finalizer and observer sessions never read pg_shdepend. */
export const controlRolesOwnershipVerificationSQL = `
SELECT safe, unexpected_ownership_count, approved_control_function_count
FROM cms_cluster_guard.verify_cms_ownership_contract()
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

/** Narrow database/schema grants only. Cluster-global role creation and
 * credential reconciliation belong exclusively to --bootstrap-database. */
function controlRolesGrantsSQL(): string {
  return `
GRANT CONNECT ON DATABASE ownerinc_cms TO cms_control, cms_controller;
GRANT USAGE, CREATE ON SCHEMA public TO cms_control;
GRANT USAGE ON SCHEMA public TO cms_controller;
`
}

export function controlRolesBootstrapSQL(controllerPassword: string): string {
  validateRolePassword(controllerPassword)
  return controlRolesGrantsSQL()
}

export function provisioningSQL(): string {
  return `
REVOKE ALL ON DATABASE ownerinc_cms FROM PUBLIC;
REVOKE ALL ON DATABASE ownerinc_cms FROM cms_runtime;
GRANT CONNECT ON DATABASE ownerinc_cms TO cms_migrator, cms_runtime, cms_observer;
REVOKE CREATE, TEMPORARY ON DATABASE ownerinc_cms FROM cms_observer;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO cms_migrator;
GRANT USAGE ON SCHEMA public TO cms_runtime, cms_observer;
REVOKE CREATE ON SCHEMA public FROM cms_runtime, cms_observer;
`
}

const adminPreauthorityTables = NEWS_MUTATION_TABLES
  .map(name => `public.${quotePostgresIdentifier(name)}`).join(', ')

/** Exact read surface used by the preauthority empty-catalog verifier. It is
 * deliberately not an ALL TABLES grant and carries no mutation privilege. */
export const adminPreauthorityInspectionSQL = `
REVOKE ALL PRIVILEGES ON TABLE ${adminPreauthorityTables} FROM cms_admin;
GRANT SELECT ON TABLE ${adminPreauthorityTables} TO cms_admin;
`

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
    'public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text)',
    '${NEWS_MIGRATION_BOOTSTRAP_RUN_SIGNATURE}'
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
      has_table_privilege('cms_runtime',c.oid,'SELECT')
      AND NOT has_table_privilege('cms_runtime',c.oid,'INSERT')
      AND NOT has_table_privilege('cms_runtime',c.oid,'UPDATE')
      AND NOT has_table_privilege('cms_runtime',c.oid,'DELETE')
      AND NOT has_table_privilege('cms_runtime',c.oid,'TRUNCATE')
      AND NOT has_table_privilege('cms_runtime',c.oid,'REFERENCES')
      AND NOT has_table_privilege('cms_runtime',c.oid,'TRIGGER')
      AND NOT EXISTS (SELECT 1 FROM pg_attribute a
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          AND (has_column_privilege('cms_runtime',c.oid,a.attnum,'INSERT')
            OR has_column_privilege('cms_runtime',c.oid,a.attnum,'UPDATE')
            OR has_column_privilege('cms_runtime',c.oid,a.attnum,'REFERENCES')))
    WHEN c.relname='news_migration_runs' THEN
      has_table_privilege('cms_runtime',c.oid,'SELECT')
      AND NOT has_table_privilege('cms_runtime',c.oid,'INSERT')
      AND NOT has_table_privilege('cms_runtime',c.oid,'UPDATE')
      AND NOT has_table_privilege('cms_runtime',c.oid,'DELETE')
      AND NOT has_table_privilege('cms_runtime',c.oid,'TRUNCATE')
      AND NOT has_table_privilege('cms_runtime',c.oid,'REFERENCES')
      AND NOT has_table_privilege('cms_runtime',c.oid,'TRIGGER')
      AND NOT EXISTS (SELECT 1 FROM pg_attribute a
        WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
          AND (has_column_privilege('cms_runtime',c.oid,a.attnum,'INSERT')
            OR has_column_privilege('cms_runtime',c.oid,a.attnum,'REFERENCES')
            OR CASE WHEN a.attname = ANY(ARRAY[
            'progress_state','commit_outcome','reconciliation_sha256',
            'destination_fingerprint','unresolved_exceptions'
          ]::name[]) THEN NOT has_column_privilege('cms_runtime',c.oid,a.attnum,'UPDATE')
            ELSE has_column_privilege('cms_runtime',c.oid,a.attnum,'UPDATE') END))
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
    AND p.proname IN ('owner_news_mutation_guard_stmt','owner_news_mutation_capture_row','owner_news_seal_run',
      'owner_news_bootstrap_run')
    AND has_function_privilege('cms_runtime',p.oid,'EXECUTE')
) AS safe
`

export const grantsSQL = `
GRANT USAGE ON SCHEMA public TO cms_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cms_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO cms_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE cms_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cms_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE cms_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO cms_runtime;
${adminPreauthorityInspectionSQL}
DO $owner_news_native_ledger$
BEGIN
  IF to_regclass('public.payload_migrations') IS NOT NULL THEN
    REVOKE ALL PRIVILEGES ON TABLE public.payload_migrations FROM cms_runtime;
    GRANT SELECT ON TABLE public.payload_migrations TO cms_admin, cms_runtime;
  END IF;
END;
$owner_news_native_ledger$;
${buildProtocolRuntimeGrantsSQL()}
`

export async function run(mode: string, env: Record<string, string | undefined> = process.env, suppliedClient?: Client) {
  if (!['--bootstrap-database', '--provision', '--grants', '--verify-migrator', '--verify-runtime', '--bootstrap-control', '--verify-control', '--verify-cluster-roles'].includes(mode)) throw new Error('Invalid provisioning mode')
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
  const clusterBootstrap = mode === '--bootstrap-database'
  const requiresPortalDatabase = ['--bootstrap-database', '--provision', '--grants', '--bootstrap-control', '--verify-control', '--verify-cluster-roles'].includes(mode)
  const portalDatabase = requiresPortalDatabase ? parsePortalDatabaseName(env.CMS_PORTAL_DATABASE_NAME) : null
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname !== (clusterBootstrap ? '/postgres' : '/ownerinc_cms')) throw new Error('Invalid CMS database target')
  let username = ''
  try { username = decodeURIComponent(url.username) } catch { throw new Error('Unsafe CMS database connection identity') }
  if (['--provision', '--bootstrap-control', '--verify-control', '--verify-cluster-roles'].includes(mode) && username !== 'cms_admin') throw new Error('Unsafe CMS owner connection identity')
  if (clusterBootstrap && username === 'cms_admin') throw new Error('Unsafe CMS cluster bootstrap identity')
  if (mode === '--bootstrap-control' || mode === '--verify-control') {
    if (mode === '--bootstrap-control') diagnosticState.phase = 'controller-password-validation'
    validateControllerPassword(env.CMS_CONTROLLER_PASSWORD || '', env)
  }
  const bootstrapPasswords = clusterBootstrap ? clusterRolePasswords(env) : null
  const { Client: PgClient } = require('pg') as { Client: new (options: object) => Client }
  const client = suppliedClient || new PgClient({ connectionString: url.href, connectionTimeoutMillis: 5000 })
  const installOwnershipHelper = async () => {
    if (suppliedClient) {
      if (suppliedClient.installCmsOwnershipHelper) {
        await suppliedClient.installCmsOwnershipHelper(clusterOwnershipHelperSQL, clusterOwnershipHelperVerificationSQL)
        return
      }
      // Unit doubles have no second physical database; they still record and
      // verify the exact installation contract explicitly.
      await suppliedClient.query(clusterOwnershipHelperSQL)
      const verified = await suppliedClient.query(clusterOwnershipHelperVerificationSQL)
      if (verified.rows[0]?.safe !== true) throw new Error('Unsafe CMS ownership helper contract')
      return
    }
    const ownerDatabaseURL = new URL(url.href)
    ownerDatabaseURL.pathname = '/ownerinc_cms'
    const helperClient = new PgClient({ connectionString: ownerDatabaseURL.href, connectionTimeoutMillis: 5000 })
    try {
      await helperClient.connect()
      const identity = await helperClient.query(`SELECT current_user AS name, current_database() AS database, r.rolsuper
        FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`)
      if (identity.rows[0]?.name !== username || identity.rows[0]?.database !== 'ownerinc_cms'
          || identity.rows[0]?.rolsuper !== true) throw new Error('Unsafe CMS ownership helper installer')
      await helperClient.query('BEGIN')
      await helperClient.query('SELECT pg_advisory_xact_lock(7194033)')
      await helperClient.query(clusterOwnershipHelperSQL)
      const verified = await helperClient.query(clusterOwnershipHelperVerificationSQL)
      if (verified.rows[0]?.safe !== true) throw new Error('Unsafe CMS ownership helper contract')
      await helperClient.query('COMMIT')
    } catch (error) {
      await helperClient.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      await helperClient.end()
    }
  }
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
  const verifyCmsAdminContract = async () => {
    await verifyCmsAdminDatabaseRoleContract(client)
  }
  try {
    if (mode === '--bootstrap-control') diagnosticState.phase = 'admin-connect'
    await client.connect()
    if (mode === '--bootstrap-database') {
      const passwords = bootstrapPasswords!
      const identity = await client.query(`SELECT current_user AS name, current_database() AS database, r.rolsuper
        FROM pg_roles r WHERE r.rolname=current_user`)
      if (identity.rows[0]?.database !== 'postgres' || identity.rows[0]?.rolsuper !== true ||
          CMS_ROLE_NAMES.includes(String(identity.rows[0]?.name) as typeof CMS_ROLE_NAMES[number])) {
        throw new Error('CMS database bootstrap requires protected cluster authority')
      }
      await client.query('SELECT pg_advisory_lock(7194032)')
      try {
        const portal = await client.query('SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname=$1) AS present', [portalDatabase])
        if (portal.rows[0]?.present !== true) throw new Error('Configured Portal database does not exist')
        await client.query(clusterRolesBootstrapSQL(passwords))
        const database = await client.query("SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname='ownerinc_cms'")
        if (database.rows.length === 0) await client.query('CREATE DATABASE ownerinc_cms OWNER cms_admin')
        else if (database.rows[0]?.owner !== 'cms_admin') throw new Error('Unsafe existing CMS database owner')
        await client.query('REVOKE ALL ON DATABASE ownerinc_cms FROM PUBLIC')
        await client.query('GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ownerinc_cms TO cms_admin')
        await client.query(`GRANT CONNECT ON DATABASE ownerinc_cms TO cms_control, cms_controller, cms_migrator, cms_runtime, cms_observer;
          REVOKE CREATE, TEMPORARY ON DATABASE ownerinc_cms FROM cms_control, cms_controller, cms_migrator, cms_runtime, cms_observer;
          REVOKE CONNECT ON DATABASE ${quotePostgresIdentifier(portalDatabase!)} FROM PUBLIC, cms_admin, cms_control, cms_controller, cms_migrator, cms_runtime, cms_observer`)
        await installOwnershipHelper()
        const roles = await client.query(clusterRolesVerificationSQL, [portalDatabase])
        if (roles.rows[0]?.safe !== true) throw new Error('Unsafe CMS cluster role contract')
      } finally {
        await client.query('SELECT pg_advisory_unlock(7194032)')
      }
    } else if (mode === '--provision') {
      const identity = await client.query(`SELECT current_user AS name, current_database() AS database, r.rolsuper, r.rolcreaterole
        FROM pg_roles r WHERE r.rolname=current_user`)
      if (identity.rows[0]?.name !== 'cms_admin' || identity.rows[0]?.database !== 'ownerinc_cms') throw new Error('Unsafe CMS provisioner role')
      await verifyCmsAdminContract()
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(7194031)')
      await client.query(provisioningSQL())
      await client.query('COMMIT')
    } else if (mode === '--bootstrap-control' || mode === '--verify-control') {
      if (mode === '--bootstrap-control') diagnosticState.phase = 'admin-identity'
       const admin = await client.query(`SELECT current_user AS name, current_database() AS database, r.rolsuper, r.rolcreaterole
         FROM pg_roles r WHERE r.rolname=current_user`)
       if (admin.rows[0]?.name !== 'cms_admin' || admin.rows[0]?.database !== 'ownerinc_cms') {
           throw new Error('CMS control bootstrap requires the non-superuser cms_admin owner on ownerinc_cms')
      }
      await verifyCmsAdminContract()
      const clusterRoles = await client.query(clusterRolesPublicVerificationSQL, [portalDatabase])
      if (clusterRoles.rows[0]?.safe !== true) throw new Error('Unsafe CMS cluster role contract')
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
        await client.query(controlRolesGrantsSQL())
        diagnosticState.phase = 'database-schema-grants'
        // Roles and credentials are reconciled only by the cluster bootstrap.
      }
      if (mode === '--bootstrap-control') diagnosticState.phase = 'role-contract-query'
      const roles = await client.query(controlRolesPublicVerificationSQL)
      if (roles.rows[0]?.safe !== true) {
        if (mode === '--bootstrap-control') {
          diagnosticState.phase = 'role-contract-policy'
          await client.query('ROLLBACK')
        }
        throw new Error('Unsafe CMS control role contract')
      }
      if (mode === '--bootstrap-control') {
        diagnosticState.phase = 'native-privilege-query'
        const native = await client.query(controlRolesNativePrivilegesVerificationSQL)
        if (native.rows[0]?.safe !== true) {
          diagnosticState.phase = 'native-privilege-policy'
          await client.query('ROLLBACK')
          throw new Error('Unsafe CMS control bootstrap state')
        }
        diagnosticState.phase = 'transaction-commit'
        await client.query('COMMIT')
      }
      if (mode === '--bootstrap-control') diagnosticState.phase = 'post-commit-controller-login'
      await verifyControllerLogin()
    } else if (mode === '--verify-cluster-roles') {
      const identity = await client.query('SELECT current_user AS name, current_database() AS database')
      if (identity.rows[0]?.name !== 'cms_admin' || identity.rows[0]?.database !== 'ownerinc_cms') {
        throw new Error('Unsafe CMS owner connection identity')
      }
      await verifyCmsAdminContract()
      const roles = await client.query(clusterRolesPublicVerificationSQL, [portalDatabase])
      if (roles.rows[0]?.safe !== true) throw new Error('Unsafe CMS cluster role contract')
    } else {
      const expected = mode === '--verify-runtime' ? 'cms_runtime' : 'cms_migrator'
      const { rows } = await client.query(`SELECT current_user AS name, current_database() AS database, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls,
        rolconnlimit=-1 AS connection_limit_safe,
        (rolvaliduntil IS NULL OR rolvaliduntil='infinity'::timestamptz) AS expiry_safe,
        rolconfig IS NULL AS settings_safe,
        has_schema_privilege(current_user, 'public', 'CREATE') AS ddl,
        has_database_privilege(current_user, current_database(), 'CREATE') AS create_schema,
        has_database_privilege(current_user, current_database(), 'TEMP') AS temporary,
        EXISTS (SELECT FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS member
        FROM pg_roles WHERE rolname=current_user`)
      const role = rows[0]
      if (!role || role.name !== expected || role.database !== 'ownerinc_cms' || role.rolsuper || role.rolcreatedb || role.rolcreaterole || role.rolinherit || role.rolreplication || role.rolbypassrls
          || role.connection_limit_safe !== true || role.expiry_safe !== true || role.settings_safe !== true
          || role.member || role.ddl !== (expected === 'cms_migrator') || (expected === 'cms_runtime' && (role.create_schema || role.temporary))) throw new Error('Unsafe CMS database role')
      if (mode === '--grants') {
        await verifyCmsAdminContract()
        const clusterRoles = await client.query(clusterRolesPublicVerificationSQL, [portalDatabase])
        if (clusterRoles.rows[0]?.safe !== true) throw new Error('Unsafe CMS cluster role contract')
        await client.query('BEGIN')
        try {
          await client.query(grantsSQL)
          await client.query(observerRelationProvisioningSQL(portalDatabase!))
          const observer = await client.query(newsProtocolObserverPostMigrationVerificationSQL)
          if (observer.rows[0]?.safe !== true) throw new Error('Unsafe CMS observer relation grants')
          await client.query('COMMIT')
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {})
          throw error
        }
      }
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
