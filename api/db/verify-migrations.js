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
];

async function verifyMigrations() {
  const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  try {
    const versions = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    const appliedVersions = versions.rows.map(({ version }) => version);
    if (JSON.stringify(appliedVersions) !== JSON.stringify(expectedVersions)) {
      throw new Error(`Unexpected migration ledger: ${appliedVersions.join(',')}`);
    }
    const result = await pool.query(`SELECT to_regclass('public.job_titles') AS job_titles,
      to_regclass('public.ombudsman') AS ombudsman,
      to_regclass('public.ombudsman_workflow_idx') AS ombudsman_workflow_idx,
      to_regclass('public.autocard_cards') AS autocard_cards,
      to_regclass('public.autocard_media') AS autocard_media,
      to_regclass('public.pos_cards') AS pos_cards,
      to_regclass('public.pos_card_media') AS pos_card_media,
      to_regclass('public.cms_documents') AS cms_documents,
       to_regclass('public.cms_revisions') AS cms_revisions,
       to_regclass('public.cms_assets') AS cms_assets,
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
        (SELECT ARRAY_AGG(column_name ORDER BY ordinal_position)
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'pending_registrations')
           = ARRAY['id', 'firebase_uid', 'email', 'name', 'status', 'created_at', 'reviewed_at', 'reviewed_by', 'rejection_reason', 'firebase_cleanup_pending']::text[] AS pending_registrations_columns,
       (SELECT ARRAY_AGG(column_name ORDER BY ordinal_position)
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
           AND pg_get_constraintdef(oid) LIKE '%pj_due_day BETWEEN 1 AND 31%'
           AND pg_get_constraintdef(oid) LIKE '%is_pj IS TRUE%'
           AND pg_get_constraintdef(oid) LIKE '%is_pj IS FALSE%') AS user_contract_invariants,
       (SELECT COUNT(*) = 0 FROM users
        WHERE contract_type IS NULL OR is_pj IS NULL
           OR contract_type NOT IN ('clt', 'pj')
           OR (contract_type = 'pj' AND (is_pj IS NOT TRUE OR pj_due_day IS NULL OR NOT (pj_due_day BETWEEN 1 AND 31)))
           OR (contract_type = 'clt' AND (is_pj IS NOT FALSE OR pj_due_day IS NOT NULL))
       ) AS user_contract_data_valid,
       EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'firebase_enable_pending' AND data_type = 'boolean' AND is_nullable = 'NO') AS user_firebase_enable_pending,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'photo_crop' AND is_nullable = 'NO') AS user_photo_crop_not_null,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'autocard_cards' AND column_name = 'media_crop' AND is_nullable = 'NO') AS autocard_media_crop_not_null,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cms_assets' AND column_name = 'deleting_at' AND data_type = 'timestamp with time zone') AS cms_asset_deleting_at,
       EXISTS (SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.cms_documents'::regclass
           AND conname = 'cms_documents_content_type_check') AS cms_content_type_check,
       EXISTS (SELECT 1 FROM pg_constraint
         WHERE conrelid = 'public.cms_revisions'::regclass
           AND conname = 'cms_revisions_status_check') AS cms_revision_status_check,
        EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.cms_revisions'::regclass
            AND conname = 'cms_revisions_blocks_check') AS cms_revision_blocks_check,
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
          WHERE conrelid = 'public.cms_documents'::regclass
            AND conname = 'cms_documents_published_revision_id_fkey') AS cms_published_revision_fk,
        EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.cms_documents'::regclass
            AND conname = 'cms_documents_draft_revision_id_fkey') AS cms_draft_revision_fk,
        EXISTS (SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.cms_documents'::regclass
            AND conname = 'cms_documents_scheduled_revision_id_fkey') AS cms_scheduled_revision_fk,
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
       (has_table_privilege('portal_api', 'public.cms_documents', 'SELECT')
         AND has_table_privilege('portal_api', 'public.cms_documents', 'INSERT')
         AND has_table_privilege('portal_api', 'public.cms_documents', 'UPDATE')
         AND has_table_privilege('portal_api', 'public.cms_documents', 'DELETE')) AS api_cms_documents_privileges,
       (has_table_privilege('portal_api', 'public.cms_revisions', 'SELECT')
         AND has_table_privilege('portal_api', 'public.cms_revisions', 'INSERT')
         AND has_table_privilege('portal_api', 'public.cms_revisions', 'UPDATE')
         AND has_table_privilege('portal_api', 'public.cms_revisions', 'DELETE')) AS api_cms_revisions_privileges,
       (has_table_privilege('portal_api', 'public.cms_assets', 'SELECT')
         AND has_table_privilege('portal_api', 'public.cms_assets', 'INSERT')
         AND has_table_privilege('portal_api', 'public.cms_assets', 'UPDATE')
         AND has_table_privilege('portal_api', 'public.cms_assets', 'DELETE')) AS api_cms_assets_privileges,
       has_table_privilege('portal_cron', 'public.autocard_cards', 'SELECT') AS cron_autocard_cards_privileges,
       (has_table_privilege('portal_cron', 'public.autocard_media', 'SELECT')
         AND has_table_privilege('portal_cron', 'public.autocard_media', 'DELETE')) AS cron_autocard_media_privileges,
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
        (has_table_privilege('portal_cron', 'public.cms_documents', 'SELECT')
          AND has_table_privilege('portal_cron', 'public.cms_documents', 'UPDATE')) AS cron_cms_documents_privileges,
        (has_table_privilege('portal_cron', 'public.cms_revisions', 'SELECT')
          AND has_table_privilege('portal_cron', 'public.cms_revisions', 'UPDATE')) AS cron_cms_revisions_privileges,
        (has_table_privilege('portal_cron', 'public.cms_assets', 'SELECT')
          AND has_table_privilege('portal_cron', 'public.cms_assets', 'UPDATE')
          AND has_table_privilege('portal_cron', 'public.cms_assets', 'DELETE')) AS cron_cms_assets_privileges,
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
      || result.rows[0].cms_documents !== 'cms_documents'
      || result.rows[0].cms_revisions !== 'cms_revisions'
        || result.rows[0].cms_assets !== 'cms_assets'
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
      || result.rows[0].cms_asset_deleting_at !== true
      || result.rows[0].cms_content_type_check !== true
      || result.rows[0].cms_revision_status_check !== true
      || result.rows[0].cms_revision_blocks_check !== true
       || result.rows[0].cms_published_revision_fk !== true
       || result.rows[0].cms_draft_revision_fk !== true
       || result.rows[0].cms_scheduled_revision_fk !== true
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
      || result.rows[0].api_cms_documents_privileges !== true
      || result.rows[0].api_cms_revisions_privileges !== true
      || result.rows[0].api_cms_assets_privileges !== true
       || result.rows[0].cron_autocard_cards_privileges !== true
       || result.rows[0].cron_autocard_media_privileges !== true
        || result.rows[0].cron_pending_registrations_denied !== true
        || result.rows[0].cron_user_import_jobs_privileges !== true
        || result.rows[0].cron_user_import_rows_denied !== true
       || result.rows[0].cron_pos_cards_privileges !== true
      || result.rows[0].cron_pos_card_media_privileges !== true
       || result.rows[0].cron_cms_documents_privileges !== true
       || result.rows[0].cron_cms_revisions_privileges !== true
       || result.rows[0].cron_cms_assets_privileges !== true
       || result.rows[0].cron_audit_privileges !== true) {
       throw new Error('Migration ledger, DHO job title, pending registration, profile photo crop, AutoCard, Pos-Cards, CMS, or Ombudsman removal schema/runtime checks are incomplete');
    }
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

module.exports = { verifyMigrations };
