const { Pool } = require('pg');

const expectedVersions = [
  '001_initial_schema',
  '002_reliable_notifications',
  '003_governance',
  '004_operational_hardening',
  '005_notification_claim_state',
  '006_user_erasure',
  '007_solides_employee_links',
  '008_solides_link_hardening',
  '009_job_titles',
  '010_autocard',
  '011_cron_alert_state',
  '012_autocard_media_crop',
  '013_job_title_catalog',
  '015_cms_editor',
  '016_remove_ombudsman',
  '017_pos_cards',
  '018_pos_card_storage_key',
  '019_cms_asset_deletion_state',
  '020_profile_photo_crop',
  '021_bulk_user_imports',
  '022_bulk_user_import_validation',
  '023_pos_owner_cards',
  '024_job_title_page_access',
  '025_pending_registrations',
  '026_firebase_enable_pending',
  '027_pending_registration_cleanup',
  '028_firebase_cleanup_queue',
  '029_autocard_media_safety',
  '030_dho_job_title_catalog',
  '031_contract_invariants',
  '032_user_import_identity',
  '033_academy_learning',
  '034_owner_news_editorial',
  '035_owner_news_polls',
  '038_disable_legacy_editorial_writes',
  '039_ethics_acceptances',
  '040_pages',
  '041_pages_media',
];

const historicalVersions = Object.freeze([
  '036_payload_editorial_control',
  '037_owner_news_cutover',
]);

function buildHistoricalExpectedVersions(versions) {
  const anchor = '038_disable_legacy_editorial_writes';
  const anchorIndex = versions.indexOf(anchor);
  if (anchorIndex === -1 || anchorIndex !== versions.lastIndexOf(anchor)) {
    throw new Error(`Expected exactly one migration anchor: ${anchor}`);
  }
  return [
    ...versions.slice(0, anchorIndex),
    ...historicalVersions,
    ...versions.slice(anchorIndex),
  ];
}

const historicalExpectedVersions = Object.freeze(buildHistoricalExpectedVersions(expectedVersions));

function isAcceptedMigrationLedger(appliedVersions) {
  return [expectedVersions, historicalExpectedVersions]
    .some((accepted) => JSON.stringify(appliedVersions) === JSON.stringify(accepted));
}

const editorialTables = [
  'cms_documents',
  'cms_revisions',
  'cms_assets',
  'owner_news_home',
  'owner_news_polls',
  'owner_news_poll_options',
  'owner_news_poll_votes',
];
const editorialPrivileges = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const editorialColumnPrivileges = ['SELECT', 'INSERT', 'UPDATE'];

async function editorialPrivilegesDenied(pool, role) {
  const { rows } = await pool.query(`SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`, [editorialTables]);

  for (const { relname } of rows) {
    const result = await pool.query(`SELECT
      (SELECT bool_and(NOT COALESCE(has_table_privilege($1, $2, privilege), FALSE))
       FROM unnest($3::text[]) AS table_privileges(privilege)) AS table_denied,
      (SELECT bool_and(NOT COALESCE(has_any_column_privilege($1, $2, privilege), FALSE))
       FROM unnest($4::text[]) AS column_privileges(privilege)) AS column_denied`, [
      role, `public.${relname}`, editorialPrivileges, editorialColumnPrivileges,
    ]);
    if (result.rows[0]?.table_denied !== true || result.rows[0]?.column_denied !== true) return false;
  }
  return true;
}

async function verifyMigrations() {
  const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  try {
    const versions = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    const appliedVersions = versions.rows.map(({ version }) => version);
    if (!isAcceptedMigrationLedger(appliedVersions)) {
      throw new Error(`Unexpected migration ledger: ${appliedVersions.join(',')}`);
    }
    const result = await pool.query(`SELECT to_regclass('public.job_titles') AS job_titles,
      to_regclass('public.ombudsman') AS ombudsman,
      to_regclass('public.ombudsman_workflow_idx') AS ombudsman_workflow_idx,
      to_regclass('public.autocard_cards') AS autocard_cards,
      to_regclass('public.autocard_media') AS autocard_media,
      to_regclass('public.pos_cards') AS pos_cards,
      to_regclass('public.pos_card_media') AS pos_card_media,
      to_regclass('public.pending_registrations') AS pending_registrations,
      to_regclass('public.firebase_cleanup_queue') AS firebase_cleanup_queue,
       (SELECT COUNT(*) = 2 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'schema_migrations') AS schema_migrations_shape,
       EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'schema_migrations'
          AND column_name = 'version' AND data_type = 'text' AND is_nullable = 'NO') AS schema_migrations_version,
       EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'schema_migrations'
          AND column_name = 'applied_at' AND data_type = 'timestamp with time zone' AND is_nullable = 'NO') AS schema_migrations_applied_at,
        (SELECT ARRAY_AGG(column_name::text ORDER BY ordinal_position)
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'pending_registrations')
           = ARRAY['id', 'firebase_uid', 'email', 'name', 'status', 'created_at', 'reviewed_at', 'reviewed_by', 'rejection_reason', 'firebase_cleanup_pending']::text[] AS pending_registrations_columns,
       (SELECT ARRAY_AGG(column_name::text ORDER BY ordinal_position)
        FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'firebase_cleanup_queue')
          = ARRAY['firebase_uid', 'reason', 'created_at', 'last_attempt_at', 'attempts', 'last_error']::text[] AS firebase_cleanup_queue_columns,
       EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.pending_registrations'::regclass
          AND conname = 'pending_registrations_reviewed_by_fkey' AND contype = 'f') AS pending_registrations_reviewer_fk,
       EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.pending_registrations'::regclass
          AND conname = 'pending_registrations_status_check' AND contype = 'c') AS pending_registrations_status_check,
       EXISTS (SELECT 1 FROM pg_index i
        JOIN pg_class index_rel ON index_rel.oid = i.indexrelid
        WHERE i.indrelid = 'public.pending_registrations'::regclass
          AND index_rel.relname = 'pending_registrations_pending_email_unique'
          AND i.indisunique AND i.indpred IS NOT NULL
          AND pg_get_indexdef(i.indexrelid) LIKE '%lower(email)%'
          AND pg_get_expr(i.indpred, i.indrelid) LIKE '%status%') AS pending_registrations_pending_email_index,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'job_title_id') AS user_job_title_column,
        (SELECT NOT EXISTS (
           SELECT 1 FROM job_titles
           WHERE btrim(name) ~* '(^|[^[:alnum:]_])rh([^[:alnum:]_]|$)'
         )) AS job_titles_without_legacy_rh,
        EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.job_titles'::regclass
            AND conname = 'job_titles_name_no_legacy_rh_check'
            AND contype = 'c') AS job_titles_no_legacy_rh_constraint,
       (SELECT COUNT(*) = 2 FROM job_titles
          WHERE btrim(lower(name)) IN ('analista de dho sênior', 'gerente de dho')
            AND active = TRUE
            AND page_access @> '{"autocard":true,"posCards":true}'::jsonb) AS dho_page_access,
       EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'user_import_rows'
           AND column_name = 'firebase_uid' AND data_type = 'text' AND is_nullable = 'YES') AS user_import_firebase_uid,
       EXISTS (SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.users'::regclass
           AND conname = 'users_contract_consistency'
           AND contype = 'c'
           AND convalidated
           -- PostgreSQL deparses BETWEEN into >= / <=. Match the complete
           -- migration 031 predicate, including grouping (no OR TRUE bypass).
           AND pg_get_constraintdef(oid) = 'CHECK ((((contract_type = ''pj''::text) AND (is_pj IS TRUE)'
             || ' AND ((pj_due_day >= 1) AND (pj_due_day <= 31)))'
             || ' OR ((contract_type = ''clt''::text) AND (is_pj IS FALSE) AND (pj_due_day IS NULL))))') AS user_contract_invariants,
       (SELECT COUNT(*) = 0 FROM users
        WHERE contract_type IS NULL OR is_pj IS NULL
           OR contract_type NOT IN ('clt', 'pj')
           OR (contract_type = 'pj' AND (is_pj IS NOT TRUE OR pj_due_day IS NULL OR NOT (pj_due_day BETWEEN 1 AND 31)))
           OR (contract_type = 'clt' AND (is_pj IS NOT FALSE OR pj_due_day IS NOT NULL))
       ) AS user_contract_data_valid,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'firebase_enable_pending' AND data_type = 'boolean' AND is_nullable = 'NO') AS user_firebase_enable_pending,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'photo_crop' AND is_nullable = 'NO') AS user_photo_crop_not_null,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'autocard_cards' AND column_name = 'media_crop' AND is_nullable = 'NO') AS autocard_media_crop_not_null,
        EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.autocard_media'::regclass
            AND conname = 'autocard_media_storage_key_check'
            AND replace(pg_get_constraintdef(oid), chr(92) || chr(92), chr(92)) LIKE
              '%^autocard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
              || chr(92) || chr(92) || '.webp$%') AS autocard_media_storage_key_exact,
        EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.users'::regclass
            AND conname = 'users_photo_crop_check'
            AND pg_get_constraintdef(oid) LIKE '%jsonb_path_exists%') AS user_photo_crop_bounds,
        EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.autocard_cards'::regclass
            AND conname = 'autocard_cards_media_crop_check'
            AND pg_get_constraintdef(oid) LIKE '%jsonb_path_exists%') AS autocard_media_crop_bounds,
        EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.pos_card_media'::regclass
            AND conname = 'pos_card_media_storage_key_check'
          AND replace(pg_get_constraintdef(oid), chr(92) || chr(92), chr(92)) LIKE
           '%^pos-card-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
           || chr(92) || chr(92) || '.webp$%') AS pos_card_media_storage_key_exact,
        EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.pos_cards'::regclass
            AND conname = 'pos_cards_template_check'
            AND pg_get_constraintdef(oid) LIKE '%convite_owntime%'
            AND pg_get_constraintdef(oid) LIKE '%convite_owner%') AS pos_cards_templates,
       (has_table_privilege('portal_api', 'public.job_titles', 'SELECT')
         AND has_table_privilege('portal_api', 'public.job_titles', 'INSERT')
         AND has_table_privilege('portal_api', 'public.job_titles', 'UPDATE')
         AND has_table_privilege('portal_api', 'public.job_titles', 'DELETE')) AS api_job_title_privileges,
       (has_table_privilege('portal_api', 'public.pending_registrations', 'SELECT')
         AND has_table_privilege('portal_api', 'public.pending_registrations', 'INSERT')
         AND has_table_privilege('portal_api', 'public.pending_registrations', 'UPDATE')
         AND has_table_privilege('portal_api', 'public.pending_registrations', 'DELETE')) AS api_pending_registrations_privileges,
       (has_table_privilege('portal_api', 'public.firebase_cleanup_queue', 'SELECT')
         AND has_table_privilege('portal_api', 'public.firebase_cleanup_queue', 'INSERT')
         AND has_table_privilege('portal_api', 'public.firebase_cleanup_queue', 'UPDATE')
         AND has_table_privilege('portal_api', 'public.firebase_cleanup_queue', 'DELETE')) AS api_firebase_cleanup_queue_privileges,
       (has_table_privilege('portal_api', 'public.autocard_cards', 'SELECT')
         AND has_table_privilege('portal_api', 'public.autocard_cards', 'INSERT')
         AND has_table_privilege('portal_api', 'public.autocard_cards', 'UPDATE')
         AND has_table_privilege('portal_api', 'public.autocard_cards', 'DELETE')) AS api_autocard_cards_privileges,
       (has_table_privilege('portal_api', 'public.autocard_media', 'SELECT')
         AND has_table_privilege('portal_api', 'public.autocard_media', 'INSERT')
         AND has_table_privilege('portal_api', 'public.autocard_media', 'UPDATE')
         AND has_table_privilege('portal_api', 'public.autocard_media', 'DELETE')) AS api_autocard_media_privileges,
       (has_table_privilege('portal_api', 'public.pos_cards', 'SELECT')
         AND has_table_privilege('portal_api', 'public.pos_cards', 'INSERT')
         AND has_table_privilege('portal_api', 'public.pos_cards', 'UPDATE')
         AND has_table_privilege('portal_api', 'public.pos_cards', 'DELETE')) AS api_pos_cards_privileges,
       (has_table_privilege('portal_api', 'public.pos_card_media', 'SELECT')
          AND has_table_privilege('portal_api', 'public.pos_card_media', 'INSERT')
          AND has_table_privilege('portal_api', 'public.pos_card_media', 'UPDATE')
          AND has_table_privilege('portal_api', 'public.pos_card_media', 'DELETE')) AS api_pos_card_media_privileges,
        COALESCE(NOT (
          has_table_privilege('portal_api', to_regclass('public.cms_documents'), 'SELECT')
          OR has_table_privilege('portal_api', to_regclass('public.cms_documents'), 'INSERT')
          OR has_table_privilege('portal_api', to_regclass('public.cms_documents'), 'UPDATE')
          OR has_table_privilege('portal_api', to_regclass('public.cms_documents'), 'DELETE')
          OR has_table_privilege('portal_api', to_regclass('public.cms_revisions'), 'SELECT')
          OR has_table_privilege('portal_api', to_regclass('public.cms_revisions'), 'INSERT')
          OR has_table_privilege('portal_api', to_regclass('public.cms_revisions'), 'UPDATE')
          OR has_table_privilege('portal_api', to_regclass('public.cms_revisions'), 'DELETE')
          OR has_table_privilege('portal_api', to_regclass('public.cms_assets'), 'SELECT')
          OR has_table_privilege('portal_api', to_regclass('public.cms_assets'), 'INSERT')
          OR has_table_privilege('portal_api', to_regclass('public.cms_assets'), 'UPDATE')
          OR has_table_privilege('portal_api', to_regclass('public.cms_assets'), 'DELETE')
        ), TRUE) AS api_cms_privileges_denied,
        COALESCE(NOT (
          has_table_privilege('portal_api', to_regclass('public.owner_news_home'), 'SELECT')
          OR has_table_privilege('portal_api', to_regclass('public.owner_news_home'), 'INSERT')
          OR has_table_privilege('portal_api', to_regclass('public.owner_news_home'), 'UPDATE')
          OR has_table_privilege('portal_api', to_regclass('public.owner_news_home'), 'DELETE')
          OR has_table_privilege('portal_api', to_regclass('public.owner_news_polls'), 'SELECT')
          OR has_table_privilege('portal_api', to_regclass('public.owner_news_polls'), 'INSERT')
          OR has_table_privilege('portal_api', to_regclass('public.owner_news_polls'), 'UPDATE')
          OR has_table_privilege('portal_api', to_regclass('public.owner_news_polls'), 'DELETE')
          OR has_table_privilege('portal_api', to_regclass('public.owner_news_poll_options'), 'SELECT')
          OR has_table_privilege('portal_api', to_regclass('public.owner_news_poll_options'), 'INSERT')
          OR has_table_privilege('portal_api', to_regclass('public.owner_news_poll_options'), 'UPDATE')
          OR has_table_privilege('portal_api', to_regclass('public.owner_news_poll_options'), 'DELETE')
          OR has_table_privilege('portal_api', to_regclass('public.owner_news_poll_votes'), 'SELECT')
          OR has_table_privilege('portal_api', to_regclass('public.owner_news_poll_votes'), 'INSERT')
          OR has_table_privilege('portal_api', to_regclass('public.owner_news_poll_votes'), 'UPDATE')
          OR has_table_privilege('portal_api', to_regclass('public.owner_news_poll_votes'), 'DELETE')
        ), TRUE) AS api_owner_news_privileges_denied,
       has_table_privilege('portal_cron', 'public.autocard_cards', 'SELECT') AS cron_autocard_cards_privileges,
        (has_table_privilege('portal_cron', 'public.autocard_media', 'SELECT')
          AND has_table_privilege('portal_cron', 'public.autocard_media', 'DELETE')) AS cron_autocard_media_privileges,
        (has_table_privilege('portal_cron', 'public.users', 'SELECT')
          AND has_table_privilege('portal_cron', 'public.users', 'UPDATE')
          AND NOT has_table_privilege('portal_cron', 'public.users', 'INSERT')
          AND NOT has_table_privilege('portal_cron', 'public.users', 'DELETE')) AS cron_users_lock_privileges,
        (has_table_privilege('portal_cron', 'public.reminders', 'SELECT')
          AND has_table_privilege('portal_cron', 'public.reminders', 'UPDATE')
          AND NOT has_table_privilege('portal_cron', 'public.reminders', 'INSERT')
          AND NOT has_table_privilege('portal_cron', 'public.reminders', 'DELETE')) AS cron_reminders_lock_privileges,
         (NOT has_table_privilege('portal_cron', 'public.pending_registrations', 'SELECT')
          AND NOT has_table_privilege('portal_cron', 'public.pending_registrations', 'DELETE')) AS cron_pending_registrations_denied,
         (has_table_privilege('portal_cron', 'public.user_import_jobs', 'DELETE')
           AND has_column_privilege('portal_cron', 'public.user_import_jobs', 'expires_at', 'SELECT')
           AND NOT has_table_privilege('portal_cron', 'public.user_import_jobs', 'SELECT')
          AND NOT has_table_privilege('portal_cron', 'public.user_import_jobs', 'INSERT')
          AND NOT has_table_privilege('portal_cron', 'public.user_import_jobs', 'UPDATE')) AS cron_user_import_jobs_privileges,
        (NOT has_table_privilege('portal_cron', 'public.user_import_rows', 'SELECT')
          AND NOT has_table_privilege('portal_cron', 'public.user_import_rows', 'INSERT')
          AND NOT has_table_privilege('portal_cron', 'public.user_import_rows', 'UPDATE')
          AND NOT has_table_privilege('portal_cron', 'public.user_import_rows', 'DELETE')) AS cron_user_import_rows_denied,
       has_table_privilege('portal_cron', 'public.pos_cards', 'SELECT') AS cron_pos_cards_privileges,
       (has_table_privilege('portal_cron', 'public.pos_card_media', 'SELECT')
         AND has_table_privilege('portal_cron', 'public.pos_card_media', 'DELETE')) AS cron_pos_card_media_privileges,
        COALESCE(NOT (
         has_table_privilege('portal_cron', to_regclass('public.cms_documents'), 'SELECT')
         OR has_table_privilege('portal_cron', to_regclass('public.cms_documents'), 'INSERT')
         OR has_table_privilege('portal_cron', to_regclass('public.cms_documents'), 'UPDATE')
         OR has_table_privilege('portal_cron', to_regclass('public.cms_documents'), 'DELETE')
         OR has_table_privilege('portal_cron', to_regclass('public.cms_revisions'), 'SELECT')
         OR has_table_privilege('portal_cron', to_regclass('public.cms_revisions'), 'INSERT')
         OR has_table_privilege('portal_cron', to_regclass('public.cms_revisions'), 'UPDATE')
         OR has_table_privilege('portal_cron', to_regclass('public.cms_revisions'), 'DELETE')
         OR has_table_privilege('portal_cron', to_regclass('public.cms_assets'), 'SELECT')
         OR has_table_privilege('portal_cron', to_regclass('public.cms_assets'), 'INSERT')
         OR has_table_privilege('portal_cron', to_regclass('public.cms_assets'), 'UPDATE')
         OR has_table_privilege('portal_cron', to_regclass('public.cms_assets'), 'DELETE')
       ), TRUE) AS cron_cms_privileges_denied,
       COALESCE(NOT (
          has_table_privilege('portal_cron', to_regclass('public.owner_news_home'), 'SELECT')
          OR has_table_privilege('portal_cron', to_regclass('public.owner_news_home'), 'INSERT')
          OR has_table_privilege('portal_cron', to_regclass('public.owner_news_home'), 'UPDATE')
          OR has_table_privilege('portal_cron', to_regclass('public.owner_news_home'), 'DELETE')
          OR has_table_privilege('portal_cron', to_regclass('public.owner_news_polls'), 'SELECT')
          OR has_table_privilege('portal_cron', to_regclass('public.owner_news_polls'), 'INSERT')
          OR has_table_privilege('portal_cron', to_regclass('public.owner_news_polls'), 'UPDATE')
          OR has_table_privilege('portal_cron', to_regclass('public.owner_news_polls'), 'DELETE')
          OR has_table_privilege('portal_cron', to_regclass('public.owner_news_poll_options'), 'SELECT')
          OR has_table_privilege('portal_cron', to_regclass('public.owner_news_poll_options'), 'INSERT')
          OR has_table_privilege('portal_cron', to_regclass('public.owner_news_poll_options'), 'UPDATE')
          OR has_table_privilege('portal_cron', to_regclass('public.owner_news_poll_options'), 'DELETE')
          OR has_table_privilege('portal_cron', to_regclass('public.owner_news_poll_votes'), 'SELECT')
          OR has_table_privilege('portal_cron', to_regclass('public.owner_news_poll_votes'), 'INSERT')
          OR has_table_privilege('portal_cron', to_regclass('public.owner_news_poll_votes'), 'UPDATE')
          OR has_table_privilege('portal_cron', to_regclass('public.owner_news_poll_votes'), 'DELETE')
        ), TRUE) AS cron_owner_news_privileges_denied,
       (has_table_privilege('portal_cron', 'public.audit_log', 'SELECT')
         AND has_table_privilege('portal_cron', 'public.audit_log', 'INSERT')
         AND has_table_privilege('portal_cron', 'public.audit_log', 'UPDATE')
         AND has_table_privilege('portal_cron', 'public.audit_log', 'DELETE')) AS cron_audit_privileges`);
    if (result.rows[0].job_titles !== 'job_titles'
      || result.rows[0].ombudsman !== null
      || result.rows[0].ombudsman_workflow_idx !== null
      || result.rows[0].autocard_cards !== 'autocard_cards'
      || result.rows[0].autocard_media !== 'autocard_media'
      || result.rows[0].pos_cards !== 'pos_cards'
      || result.rows[0].pos_card_media !== 'pos_card_media'
        || result.rows[0].pending_registrations !== 'pending_registrations'
        || result.rows[0].schema_migrations_shape !== true
        || result.rows[0].schema_migrations_version !== true
        || result.rows[0].schema_migrations_applied_at !== true
         || result.rows[0].pending_registrations_columns !== true
         || result.rows[0].firebase_cleanup_queue !== 'firebase_cleanup_queue'
         || result.rows[0].firebase_cleanup_queue_columns !== true
        || result.rows[0].pending_registrations_reviewer_fk !== true
        || result.rows[0].pending_registrations_status_check !== true
        || result.rows[0].pending_registrations_pending_email_index !== true
       || result.rows[0].user_job_title_column !== true
       || result.rows[0].user_firebase_enable_pending !== true
       || result.rows[0].user_photo_crop_not_null !== true
       || result.rows[0].autocard_media_crop_not_null !== true
       || result.rows[0].autocard_media_storage_key_exact !== true
       || result.rows[0].user_photo_crop_bounds !== true
       || result.rows[0].autocard_media_crop_bounds !== true
        || result.rows[0].pos_card_media_storage_key_exact !== true
         || result.rows[0].pos_cards_templates !== true
        || result.rows[0].job_titles_without_legacy_rh !== true
         || result.rows[0].job_titles_no_legacy_rh_constraint !== true
         || result.rows[0].dho_page_access !== true
        || result.rows[0].user_import_firebase_uid !== true
        || result.rows[0].user_contract_invariants !== true
        || result.rows[0].user_contract_data_valid !== true
        || result.rows[0].api_job_title_privileges !== true
         || result.rows[0].api_pending_registrations_privileges !== true
         || result.rows[0].api_firebase_cleanup_queue_privileges !== true
      || result.rows[0].api_autocard_cards_privileges !== true
      || result.rows[0].api_autocard_media_privileges !== true
      || result.rows[0].api_pos_cards_privileges !== true
      || result.rows[0].api_pos_card_media_privileges !== true
      || result.rows[0].api_cms_privileges_denied !== true
      || result.rows[0].api_owner_news_privileges_denied !== true
        || result.rows[0].cron_autocard_cards_privileges !== true
        || result.rows[0].cron_autocard_media_privileges !== true
        || result.rows[0].cron_users_lock_privileges !== true
        || result.rows[0].cron_reminders_lock_privileges !== true
         || result.rows[0].cron_pending_registrations_denied !== true
        || result.rows[0].cron_user_import_jobs_privileges !== true
        || result.rows[0].cron_user_import_rows_denied !== true
       || result.rows[0].cron_pos_cards_privileges !== true
      || result.rows[0].cron_pos_card_media_privileges !== true
      || result.rows[0].cron_cms_privileges_denied !== true
      || result.rows[0].cron_owner_news_privileges_denied !== true
        || result.rows[0].cron_audit_privileges !== true) {
      throw new Error('Migration ledger or Ombudsman removal schema/runtime checks are incomplete; verify DHO, registrations, media and denied editorial privileges');
    }
    const [apiEditorialPrivilegesDenied, cronEditorialPrivilegesDenied] = await Promise.all([
      editorialPrivilegesDenied(pool, 'portal_api'),
      editorialPrivilegesDenied(pool, 'portal_cron'),
    ]);
    if (!apiEditorialPrivilegesDenied || !cronEditorialPrivilegesDenied) {
      throw new Error('Effective editorial privileges remain through a direct grant, PUBLIC, role membership or column grant');
    }
    const ethics = await pool.query(`SELECT
      to_regclass('public.ethics_acceptances') IS NOT NULL AS present,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ethics_acceptances'::regclass
        AND contype = 'p' AND pg_get_constraintdef(oid) = 'PRIMARY KEY (user_uid, term_version, content_sha256)') AS identity,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.ethics_acceptances'::regclass
        AND contype = 'f' AND confrelid = 'public.users'::regclass AND confdeltype = 'c') AS erasure,
      has_table_privilege('portal_api', 'public.ethics_acceptances', 'SELECT') AS readable,
      has_table_privilege('portal_api', 'public.ethics_acceptances', 'INSERT') AS writable,
      NOT has_table_privilege('portal_api', 'public.ethics_acceptances', 'UPDATE') AS immutable_update,
      NOT has_table_privilege('portal_api', 'public.ethics_acceptances', 'DELETE') AS immutable_delete,
      NOT has_table_privilege('portal_cron', 'public.ethics_acceptances', 'SELECT,INSERT,UPDATE,DELETE') AS cron_denied`);
    if (!Object.values(ethics.rows[0]).every(value => value === true)) {
      throw new Error('Ethics acceptance schema or runtime privileges are incomplete');
    }
    const academyTables = ['academy_course_job_titles', 'academy_modules', 'academy_lessons', 'academy_lesson_progress'];
    for (const table of academyTables) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const access = await pool.query(`SELECT
          has_table_privilege('portal_api', $1, $2) AS api_allowed,
          has_table_privilege('portal_cron', $1, $2) AS cron_allowed`, [`public.${table}`, privilege]);
        if (access.rows[0].api_allowed !== true || access.rows[0].cron_allowed !== false) {
          throw new Error(`Unexpected Academy runtime privilege: ${table} ${privilege}`);
        }
      }
    }
    const academy = await pool.query(`SELECT
      EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'academy'
          AND column_name = 'url' AND is_nullable = 'YES') AS nullable_url,
      EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.academy'::regclass
          AND conname = 'academy_delivery_url_check') AS delivery_check,
      EXISTS (SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.academy_lessons'::regclass
          AND conname = 'academy_lesson_media_check') AS media_check`);
    if (!Object.values(academy.rows[0]).every((value) => value === true)) {
      throw new Error('Academy delivery or media schema checks are incomplete');
    }
    await verifyPages(pool);
    console.log('migration verification: current schema ok');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  verifyMigrations().catch((error) => {
    console.error(`[migration-verify] ${error.message}`);
    process.exitCode = 1;
  });
}

async function verifyPages(pool) {
  const tables = ['pages', 'page_revisions', 'page_revision_job_titles', 'page_media', 'page_revision_media', 'page_requests'];
  for (const table of tables) {
    const present = await pool.query('SELECT to_regclass($1) IS NOT NULL AS present', [`public.${table}`]);
    if (!present.rows[0].present) throw new Error(`Missing Pages table: ${table}`);
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      const expected = ['SELECT', 'INSERT'].includes(privilege) || (table === 'pages' && privilege === 'UPDATE');
      const result = await pool.query(`SELECT has_table_privilege('portal_api', $1, $2) AS api,
        has_table_privilege('portal_cron', $1, $2) AS cron`, [`public.${table}`, privilege]);
      if (result.rows[0].api !== expected || result.rows[0].cron !== false) throw new Error(`Unexpected Pages privilege: ${table} ${privilege}`);
    }
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE']) {
      const result = await pool.query(`SELECT has_any_column_privilege('portal_api', $1, $2) AS api,
        has_any_column_privilege('portal_cron', $1, $2) AS cron`, [`public.${table}`, privilege]);
      if (result.rows[0].cron !== false || (privilege === 'UPDATE' && table !== 'pages' && result.rows[0].api !== false)) throw new Error(`Unexpected Pages column privilege: ${table}`);
    }
  }
  const shape = await pool.query(`SELECT
    (SELECT count(*) = 2 FROM pg_constraint WHERE conrelid = 'pages'::regclass AND conname IN ('pages_draft_revision_fk','pages_published_revision_fk') AND contype = 'f' AND array_length(conkey,1) = 2 AND confdeltype = 'r') AS heads,
    (SELECT count(*) = 2 FROM pg_constraint WHERE conrelid = 'page_revision_media'::regclass AND contype = 'f' AND array_length(conkey,1) = 2 AND confdeltype = 'r') AS media_same_page,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid = 'page_revision_job_titles'::regclass AND confrelid = 'job_titles'::regclass AND confdeltype = 'r') AS audience_restrict,
    (SELECT count(*) = 4 FROM pg_constraint WHERE conrelid IN ('pages'::regclass,'page_revisions'::regclass,'page_media'::regclass) AND confrelid = 'users'::regclass AND confdeltype = 'n') AS anonymization,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid = 'page_requests'::regclass AND contype = 'p' AND pg_get_constraintdef(oid) = 'PRIMARY KEY (actor_uid, client_mutation_id)') AS requests_identity,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid = 'page_media'::regclass AND conname = 'page_media_typed_check' AND pg_get_constraintdef(oid) LIKE '%IS TRUE%') AS typed_media,
    EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid = 'page_revisions'::regclass AND conname = 'page_revisions_schema_version_check' AND pg_get_constraintdef(oid) LIKE '%2%') AS versions`);
  if (!Object.values(shape.rows[0]).every(value => value === true)) throw new Error('Pages relational invariants are incomplete');
}

module.exports = {
  verifyPages,
  expectedVersions,
  historicalVersions,
  historicalExpectedVersions,
  buildHistoricalExpectedVersions,
  isAcceptedMigrationLedger,
  verifyMigrations,
};
