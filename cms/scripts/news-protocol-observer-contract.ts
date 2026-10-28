import { parsePortalDatabaseName, quotePostgresIdentifier, quotePostgresLiteral } from './database-contract'

const OBSERVER_ROLE = 'cms_observer'
const OBSERVER_ALLOWED_TABLES = ['payload_migrations', 'owner_news_mutation_head'] as const

/**
 * Database-local grants for the cluster-bootstrap-created observer role. This
 * builder never creates or alters a cluster role and never handles a password.
 */
export function observerRoleProvisioningStatements(rawPortalDatabase: string): string {
  const portalDatabase = parsePortalDatabaseName(rawPortalDatabase)
  return `DO $ownerinc_observer_contract$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
    WHERE r.rolname='${OBSERVER_ROLE}' AND r.rolcanlogin
      AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
      AND NOT r.rolinherit AND NOT r.rolreplication AND NOT r.rolbypassrls
      AND r.rolconnlimit=-1
      AND (r.rolvaliduntil IS NULL OR r.rolvaliduntil='infinity'::timestamptz)
      AND r.rolconfig IS NULL
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid OR m.member=r.oid)
  ) THEN
    RAISE EXCEPTION 'cms_observer_role_contract_mismatch' USING ERRCODE='42501';
  END IF;
END
$ownerinc_observer_contract$;
GRANT CONNECT ON DATABASE ownerinc_cms TO ${OBSERVER_ROLE};
REVOKE CREATE, TEMPORARY ON DATABASE ownerinc_cms FROM ${OBSERVER_ROLE};
REVOKE CONNECT ON DATABASE ${quotePostgresIdentifier(portalDatabase)} FROM ${OBSERVER_ROLE};
GRANT USAGE ON SCHEMA public TO ${OBSERVER_ROLE};
REVOKE CREATE ON SCHEMA public FROM ${OBSERVER_ROLE};
`
}

/** Post-migration relation normalization executed by cms_migrator. Cluster and
 * database/schema authority stays in cms-cluster-bootstrap; this step only
 * normalizes objects that now exist and revokes broad future grants. */
export function observerRelationProvisioningSQL(rawPortalDatabase: string): string {
  const portalDatabase = parsePortalDatabaseName(rawPortalDatabase)
  return `DO $ownerinc_observer_relation_contract$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
    WHERE r.rolname='${OBSERVER_ROLE}' AND r.rolcanlogin
      AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
      AND NOT r.rolinherit AND NOT r.rolreplication AND NOT r.rolbypassrls
      AND r.rolconnlimit=-1
      AND (r.rolvaliduntil IS NULL OR r.rolvaliduntil='infinity'::timestamptz)
      AND r.rolconfig IS NULL
      AND has_database_privilege('${OBSERVER_ROLE}',current_database(),'CONNECT')
      AND NOT has_database_privilege('${OBSERVER_ROLE}',current_database(),'CREATE')
      AND NOT has_database_privilege('${OBSERVER_ROLE}',current_database(),'TEMP')
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname=${quotePostgresLiteral(portalDatabase)})
      AND NOT has_database_privilege('${OBSERVER_ROLE}',${quotePostgresLiteral(portalDatabase)},'CONNECT')
      AND has_schema_privilege('${OBSERVER_ROLE}','public','USAGE')
      AND NOT has_schema_privilege('${OBSERVER_ROLE}','public','CREATE')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.roleid=r.oid OR m.member=r.oid)
  ) THEN
    RAISE EXCEPTION 'cms_observer_role_contract_mismatch' USING ERRCODE='42501';
  END IF;
END
$ownerinc_observer_relation_contract$;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${OBSERVER_ROLE};
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${OBSERVER_ROLE};
ALTER DEFAULT PRIVILEGES FOR ROLE cms_migrator IN SCHEMA public REVOKE ALL ON TABLES FROM ${OBSERVER_ROLE};
ALTER DEFAULT PRIVILEGES FOR ROLE cms_migrator IN SCHEMA public REVOKE ALL ON SEQUENCES FROM ${OBSERVER_ROLE};
ALTER DEFAULT PRIVILEGES FOR ROLE cms_migrator IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM ${OBSERVER_ROLE};
GRANT SELECT ON TABLE public.payload_migrations TO ${OBSERVER_ROLE};
DO $ownerinc_observer_optional_head$
BEGIN
  IF pg_catalog.to_regclass('public.owner_news_mutation_head') IS NOT NULL THEN
    GRANT SELECT ON TABLE public.owner_news_mutation_head TO ${OBSERVER_ROLE};
  END IF;
END
$ownerinc_observer_optional_head$;
`
}

/** Verifies the common post-migration floor before the protocol head exists.
 * If the finalizer has already installed the head, it becomes mandatory too. */
export const newsProtocolObserverPostMigrationVerificationSQL = `
WITH public_relations AS (
  SELECT c.oid, c.relname FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
), expected AS (
  SELECT pg_catalog.to_regclass('public.payload_migrations') AS migrations,
    pg_catalog.to_regclass('public.owner_news_mutation_head') AS protocol_head
)
SELECT migrations IS NOT NULL
  AND has_table_privilege('${OBSERVER_ROLE}',migrations,'SELECT')
  AND (protocol_head IS NULL OR has_table_privilege('${OBSERVER_ROLE}',protocol_head,'SELECT'))
  AND NOT EXISTS (
    SELECT 1 FROM public_relations relation, expected
    WHERE relation.oid<>expected.migrations
      AND (expected.protocol_head IS NULL OR relation.oid<>expected.protocol_head)
      AND has_table_privilege('${OBSERVER_ROLE}',relation.oid,'SELECT')
  )
  AND NOT EXISTS (
    SELECT 1 FROM public_relations relation
    WHERE has_table_privilege('${OBSERVER_ROLE}',relation.oid,'INSERT')
      OR has_table_privilege('${OBSERVER_ROLE}',relation.oid,'UPDATE')
      OR has_table_privilege('${OBSERVER_ROLE}',relation.oid,'DELETE')
      OR has_table_privilege('${OBSERVER_ROLE}',relation.oid,'TRUNCATE')
      OR has_table_privilege('${OBSERVER_ROLE}',relation.oid,'REFERENCES')
      OR has_table_privilege('${OBSERVER_ROLE}',relation.oid,'TRIGGER')
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class sequence
    JOIN pg_catalog.pg_namespace n ON n.oid=sequence.relnamespace
    WHERE n.nspname='public' AND sequence.relkind='S' AND (
      has_sequence_privilege('${OBSERVER_ROLE}',sequence.oid,'USAGE')
      OR has_sequence_privilege('${OBSERVER_ROLE}',sequence.oid,'SELECT')
      OR has_sequence_privilege('${OBSERVER_ROLE}',sequence.oid,'UPDATE'))
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_default_acl defaults
    CROSS JOIN LATERAL pg_catalog.aclexplode(defaults.defaclacl) acl
    WHERE defaults.defaclrole=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='cms_migrator')
      AND defaults.defaclnamespace='public'::regnamespace
      AND acl.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname='${OBSERVER_ROLE}')
  ) AS safe
FROM expected
`

/** Applies baseline database/schema privileges needed before an archive whose
 * ACLs reference the already-created cms_observer role is restored. */
export function buildNewsProtocolObserverRoleProvisioningSQL(portalDatabase: string): string {
  return `BEGIN;
${observerRoleProvisioningStatements(portalDatabase)}COMMIT;
`
}

export function buildNewsProtocolObserverProvisioningSQL(portalDatabase: string): string {
  return `BEGIN;
${observerRoleProvisioningStatements(portalDatabase)}
SET LOCAL ROLE cms_migrator;
${observerRelationProvisioningSQL(portalDatabase)}
RESET ROLE;
COMMIT;
`
}

export const newsProtocolObserverRoleVerificationSQL = `
SELECT r.rolcanlogin
  AND NOT r.rolsuper AND NOT r.rolcreatedb AND NOT r.rolcreaterole
  AND NOT r.rolinherit AND NOT r.rolreplication AND NOT r.rolbypassrls
  AND r.rolconnlimit=-1
  AND (r.rolvaliduntil IS NULL OR r.rolvaliduntil='infinity'::timestamptz)
  AND r.rolconfig IS NULL
  AND has_database_privilege('${OBSERVER_ROLE}', current_database(), 'CONNECT')
  AND EXISTS (SELECT 1 FROM pg_catalog.pg_database WHERE datname=$1)
  AND NOT has_database_privilege('${OBSERVER_ROLE}', $1, 'CONNECT')
  AND NOT has_database_privilege('${OBSERVER_ROLE}', current_database(), 'CREATE')
  AND NOT has_database_privilege('${OBSERVER_ROLE}', current_database(), 'TEMP')
  AND has_schema_privilege('${OBSERVER_ROLE}', 'public', 'USAGE')
  AND NOT has_schema_privilege('${OBSERVER_ROLE}', 'public', 'CREATE')
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    WHERE m.roleid=r.oid OR m.member=r.oid
  )
  AND (SELECT ownership.safe FROM cms_cluster_guard.verify_cms_ownership_contract() ownership) AS safe
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
 * execution remain forbidden. Exact exceptions are gen_random_uuid and the
 * bounded ownership helper installed by cluster bootstrap.
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
        OR (n.nspname NOT IN ('public','pg_catalog','information_schema','cms_cluster_guard')
          AND has_schema_privilege('${OBSERVER_ROLE}',n.oid,'USAGE'))
    ) AS schema_privileges_safe,
    NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','cms_cluster_guard')
        AND has_function_privilege('${OBSERVER_ROLE}',p.oid,'EXECUTE')
        AND (
          (p.prosecdef AND p.oid IS DISTINCT FROM
            to_regprocedure('cms_cluster_guard.verify_cms_ownership_contract()')::oid)
          OR p.proname IN (
            'owner_news_mutation_guard_stmt', 'owner_news_mutation_capture_row',
            'owner_news_seal_run', 'owner_news_migration_item_binding_guard',
            'owner_news_bootstrap_run'
          )
          OR (p.oid IS DISTINCT FROM to_regprocedure('public.gen_random_uuid()')::oid
            AND p.oid IS DISTINCT FROM to_regprocedure('cms_cluster_guard.verify_cms_ownership_contract()')::oid)
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
