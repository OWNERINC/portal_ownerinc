const OBSERVER_ROLE = 'cms_observer'
const OBSERVER_ALLOWED_TABLES = ['payload_migrations', 'owner_news_mutation_head'] as const

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Privileged, one-time provisioning SQL for a human-reviewed operation only.
 * The read-only audit CLI never imports or executes this builder.
 */
export function buildNewsProtocolObserverProvisioningSQL(password: string): string {
  if (typeof password !== 'string' || password.length < 32
    || /[\x00-\x1f\\]/u.test(password) || /example|placeholder|change-me/i.test(password)) {
    throw new Error('invalid_observer_password')
  }

  return `BEGIN;
CREATE ROLE ${OBSERVER_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  PASSWORD ${quoteLiteral(password)};
GRANT CONNECT ON DATABASE ownerinc_cms TO ${OBSERVER_ROLE};
GRANT USAGE ON SCHEMA public TO ${OBSERVER_ROLE};
GRANT SELECT ON TABLE public.payload_migrations, public.owner_news_mutation_head TO ${OBSERVER_ROLE};
COMMIT;
`
}

/** Public-catalog role checks only. Password presence is deliberately omitted. */
export const newsProtocolObserverOwnershipCatalogPrivilegeVerificationSQL = `
SELECT has_table_privilege(current_user, 'pg_catalog.pg_shdepend', 'SELECT') AS safe
`

export const newsProtocolObserverRoleVerificationSQL = `
SELECT r.rolcanlogin
  AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
  AND NOT r.rolinherit AND NOT r.rolreplication AND NOT r.rolbypassrls
  AND has_database_privilege('${OBSERVER_ROLE}', current_database(), 'CONNECT')
  AND NOT has_database_privilege('${OBSERVER_ROLE}', current_database(), 'CREATE')
  AND NOT has_database_privilege('${OBSERVER_ROLE}', current_database(), 'TEMP')
  AND has_schema_privilege('${OBSERVER_ROLE}', 'public', 'USAGE')
  AND NOT has_schema_privilege('${OBSERVER_ROLE}', 'public', 'CREATE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    WHERE m.roleid=r.oid OR m.member=r.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_shdepend d
    WHERE d.refclassid='pg_catalog.pg_authid'::regclass
      AND d.refobjid=r.oid AND d.deptype='o'
  ) AS safe
FROM pg_catalog.pg_roles r
WHERE r.rolname='${OBSERVER_ROLE}'
`

/**
 * Effective observer privileges over persistent relations. The only application
 * relations with SELECT are the migration ledger and protocol head; standard
 * pg_catalog/information_schema reads are required for this audit. No relation
 * DML is allowed except UPDATE on PostgreSQL's canonical pg_catalog.pg_settings
 * view, which maps to SET for the current session rather than persistent row
 * mutation. That exception is tied to its qualified relation OID and view kind.
 * Sequence access, non-public schema access, and protocol/security-definer
 * execution remain forbidden. The exact gen_random_uuid baseline is the only
 * invoker-function exception and is also checked by the shared finalizer ACL
 * verifier.
 */
export const newsProtocolObserverPrivilegesVerificationSQL = `
WITH relations AS (
  SELECT c.oid, c.relacl, c.relowner, n.nspname, c.relname,
    n.nspname='public' AND c.relname=ANY(ARRAY[${OBSERVER_ALLOWED_TABLES.map(name => `'${name}'`).join(',')}]::name[]) AS allowed_select,
    n.nspname IN ('pg_catalog','information_schema') AS catalog_read,
    c.oid='pg_catalog.pg_settings'::regclass AND n.nspname='pg_catalog' AND c.relkind='v' AS session_settings_view
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p','v','m','f')
),
checks AS (
  SELECT
    (SELECT count(*)=2 FROM relations WHERE allowed_select) AS required_tables_present,
    (SELECT count(*)=1 FROM relations WHERE session_settings_view) AS session_settings_view_present,
    NOT EXISTS (
      SELECT 1 FROM relations r
      WHERE (r.allowed_select AND NOT has_table_privilege('${OBSERVER_ROLE}',r.oid,'SELECT'))
        OR (NOT r.allowed_select AND NOT r.catalog_read AND has_table_privilege('${OBSERVER_ROLE}',r.oid,'SELECT'))
        OR (NOT r.catalog_read AND EXISTS (
          SELECT 1 FROM pg_catalog.aclexplode(
            COALESCE(r.relacl,pg_catalog.acldefault('r',r.relowner))) acl
          WHERE acl.grantee=0
        ))
        OR has_table_privilege('${OBSERVER_ROLE}',r.oid,'INSERT')
        OR (NOT r.session_settings_view AND has_table_privilege('${OBSERVER_ROLE}',r.oid,'UPDATE'))
        OR has_table_privilege('${OBSERVER_ROLE}',r.oid,'DELETE')
        OR has_table_privilege('${OBSERVER_ROLE}',r.oid,'TRUNCATE')
        OR has_table_privilege('${OBSERVER_ROLE}',r.oid,'REFERENCES')
        OR has_table_privilege('${OBSERVER_ROLE}',r.oid,'TRIGGER')
        OR EXISTS (
          SELECT 1 FROM pg_catalog.pg_attribute a
          WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped
            AND (
              has_column_privilege('${OBSERVER_ROLE}',r.oid,a.attnum,'INSERT')
              OR (NOT r.session_settings_view AND has_column_privilege('${OBSERVER_ROLE}',r.oid,a.attnum,'UPDATE'))
              OR has_column_privilege('${OBSERVER_ROLE}',r.oid,a.attnum,'REFERENCES')
              OR (r.allowed_select AND NOT has_column_privilege('${OBSERVER_ROLE}',r.oid,a.attnum,'SELECT'))
              OR (NOT r.allowed_select AND NOT r.catalog_read
                AND has_column_privilege('${OBSERVER_ROLE}',r.oid,a.attnum,'SELECT'))
              OR (NOT r.catalog_read AND a.attacl IS NOT NULL AND EXISTS (
                SELECT 1 FROM pg_catalog.aclexplode(
                  a.attacl) acl
                WHERE acl.grantee=0
              ))
            )
        )
    ) AS relation_privileges_safe,
    NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind='S' AND (
        has_sequence_privilege('${OBSERVER_ROLE}',c.oid,'USAGE')
        OR has_sequence_privilege('${OBSERVER_ROLE}',c.oid,'SELECT')
        OR has_sequence_privilege('${OBSERVER_ROLE}',c.oid,'UPDATE')
      )
    ) AS sequence_privileges_safe,
    NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_namespace n
      WHERE has_schema_privilege('${OBSERVER_ROLE}',n.oid,'CREATE')
        OR (n.nspname NOT IN ('public','pg_catalog','information_schema')
          AND has_schema_privilege('${OBSERVER_ROLE}',n.oid,'USAGE'))
    ) AS schema_privileges_safe,
    NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
        AND has_function_privilege('${OBSERVER_ROLE}',p.oid,'EXECUTE')
        AND (
          p.prosecdef
          OR p.proname IN (
            'owner_news_mutation_guard_stmt', 'owner_news_mutation_capture_row',
            'owner_news_seal_run', 'owner_news_migration_item_binding_guard'
          )
          OR p.oid IS DISTINCT FROM to_regprocedure('public.gen_random_uuid()')::oid
        )
    ) AS function_privileges_safe
)
SELECT required_tables_present AND session_settings_view_present AND relation_privileges_safe
  AND sequence_privileges_safe AND schema_privileges_safe AND function_privileges_safe AS safe,
  required_tables_present, session_settings_view_present, relation_privileges_safe, sequence_privileges_safe,
  schema_privileges_safe, function_privileges_safe
FROM checks
`

export type ObserverDatabaseUrlFailure = 'observer_database_url_required' | 'unsafe_observer_database_url'

/** Strict explicit connection target; no default/admin/runtime URL fallback. */
export function parseObserverDatabaseUrl(raw: unknown): URL {
  const reject = (reason: ObserverDatabaseUrlFailure): never => {
    const error = new Error(reason)
    Object.defineProperty(error, 'code', { value: reason, enumerable: false })
    throw error
  }
  if (typeof raw !== 'string' || raw.length === 0) reject('observer_database_url_required')

  let url: URL
  try { url = new URL(raw as string) } catch { reject('unsafe_observer_database_url') }
  let username = ''
  let password = ''
  try {
    username = decodeURIComponent(url!.username)
    password = decodeURIComponent(url!.password)
  } catch { reject('unsafe_observer_database_url') }
  if (!['postgres:', 'postgresql:'].includes(url!.protocol) || url!.pathname !== '/ownerinc_cms'
    || username !== OBSERVER_ROLE || password.length === 0 || /[\x00-\x1f]/u.test(password)
    || !url!.hostname || url!.search || url!.hash) reject('unsafe_observer_database_url')
  return url!
}
