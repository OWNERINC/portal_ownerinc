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
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'job_title_id') AS user_job_title_column,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'autocard_cards' AND column_name = 'media_crop' AND is_nullable = 'NO') AS autocard_media_crop_not_null,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cms_documents_content_type_check') AS cms_content_type_check,
      EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cms_revisions_status_check') AS cms_revision_status_check,
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cms_revisions_blocks_check') AS cms_revision_blocks_check,
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cms_documents_published_revision_id_fkey') AS cms_published_revision_fk,
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cms_documents_draft_revision_id_fkey') AS cms_draft_revision_fk,
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cms_documents_scheduled_revision_id_fkey') AS cms_scheduled_revision_fk,
       EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pos_card_media_storage_key_check'
         AND replace(pg_get_constraintdef(oid), chr(92) || chr(92), chr(92)) LIKE
           '%^pos-card-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
           || chr(92) || chr(92) || '.webp$%') AS pos_card_media_storage_key_exact,
      has_table_privilege('portal_api', 'public.job_titles', 'SELECT,INSERT,UPDATE,DELETE') AS api_job_title_privileges,
      has_table_privilege('portal_api', 'public.autocard_cards', 'SELECT,INSERT,UPDATE,DELETE') AS api_autocard_cards_privileges,
      has_table_privilege('portal_api', 'public.autocard_media', 'SELECT,INSERT,UPDATE,DELETE') AS api_autocard_media_privileges,
      has_table_privilege('portal_api', 'public.pos_cards', 'SELECT,INSERT,UPDATE,DELETE') AS api_pos_cards_privileges,
      has_table_privilege('portal_api', 'public.pos_card_media', 'SELECT,INSERT,UPDATE,DELETE') AS api_pos_card_media_privileges,
      has_table_privilege('portal_api', 'public.cms_documents', 'SELECT,INSERT,UPDATE,DELETE') AS api_cms_documents_privileges,
      has_table_privilege('portal_api', 'public.cms_revisions', 'SELECT,INSERT,UPDATE,DELETE') AS api_cms_revisions_privileges,
      has_table_privilege('portal_api', 'public.cms_assets', 'SELECT,INSERT,UPDATE,DELETE') AS api_cms_assets_privileges,
      has_table_privilege('portal_cron', 'public.autocard_cards', 'SELECT') AS cron_autocard_cards_privileges,
      has_table_privilege('portal_cron', 'public.autocard_media', 'SELECT,DELETE') AS cron_autocard_media_privileges,
      has_table_privilege('portal_cron', 'public.pos_cards', 'SELECT') AS cron_pos_cards_privileges,
      has_table_privilege('portal_cron', 'public.pos_card_media', 'SELECT,DELETE') AS cron_pos_card_media_privileges,
       has_table_privilege('portal_cron', 'public.cms_documents', 'SELECT,UPDATE') AS cron_cms_documents_privileges,
       has_table_privilege('portal_cron', 'public.cms_revisions', 'SELECT,UPDATE') AS cron_cms_revisions_privileges,
       has_table_privilege('portal_cron', 'public.cms_assets', 'SELECT,DELETE') AS cron_cms_assets_privileges,
      has_table_privilege('portal_cron', 'public.audit_log', 'SELECT,INSERT,UPDATE,DELETE') AS cron_audit_privileges`);
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
      || result.rows[0].user_job_title_column !== true
      || result.rows[0].autocard_media_crop_not_null !== true
      || result.rows[0].cms_content_type_check !== true
      || result.rows[0].cms_revision_status_check !== true
      || result.rows[0].cms_revision_blocks_check !== true
       || result.rows[0].cms_published_revision_fk !== true
       || result.rows[0].cms_draft_revision_fk !== true
       || result.rows[0].cms_scheduled_revision_fk !== true
       || result.rows[0].pos_card_media_storage_key_exact !== true
      || result.rows[0].api_job_title_privileges !== true
      || result.rows[0].api_autocard_cards_privileges !== true
      || result.rows[0].api_autocard_media_privileges !== true
      || result.rows[0].api_pos_cards_privileges !== true
      || result.rows[0].api_pos_card_media_privileges !== true
      || result.rows[0].api_cms_documents_privileges !== true
      || result.rows[0].api_cms_revisions_privileges !== true
      || result.rows[0].api_cms_assets_privileges !== true
      || result.rows[0].cron_autocard_cards_privileges !== true
      || result.rows[0].cron_autocard_media_privileges !== true
      || result.rows[0].cron_pos_cards_privileges !== true
      || result.rows[0].cron_pos_card_media_privileges !== true
       || result.rows[0].cron_cms_documents_privileges !== true
       || result.rows[0].cron_cms_revisions_privileges !== true
       || result.rows[0].cron_cms_assets_privileges !== true
      || result.rows[0].cron_audit_privileges !== true) {
      throw new Error('Job title, AutoCard, Pos-Cards, CMS, or Ombudsman removal schema/runtime checks are incomplete');
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
