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
      to_regclass('public.autocard_cards') AS autocard_cards,
      to_regclass('public.autocard_media') AS autocard_media,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'job_title_id') AS user_job_title_column,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'autocard_cards' AND column_name = 'media_crop' AND is_nullable = 'NO') AS autocard_media_crop_not_null,
      has_table_privilege('portal_api', 'public.job_titles', 'SELECT,INSERT,UPDATE,DELETE') AS api_job_title_privileges,
      has_table_privilege('portal_api', 'public.autocard_cards', 'SELECT,INSERT,UPDATE,DELETE') AS api_autocard_cards_privileges,
      has_table_privilege('portal_api', 'public.autocard_media', 'SELECT,INSERT,UPDATE,DELETE') AS api_autocard_media_privileges,
      has_table_privilege('portal_cron', 'public.autocard_cards', 'SELECT') AS cron_autocard_cards_privileges,
      has_table_privilege('portal_cron', 'public.autocard_media', 'SELECT,DELETE') AS cron_autocard_media_privileges,
      has_table_privilege('portal_cron', 'public.audit_log', 'SELECT,INSERT,UPDATE,DELETE') AS cron_audit_privileges`);
    if (result.rows[0].job_titles !== 'job_titles'
      || result.rows[0].autocard_cards !== 'autocard_cards'
      || result.rows[0].autocard_media !== 'autocard_media'
      || result.rows[0].user_job_title_column !== true
      || result.rows[0].autocard_media_crop_not_null !== true
      || result.rows[0].api_job_title_privileges !== true
      || result.rows[0].api_autocard_cards_privileges !== true
      || result.rows[0].api_autocard_media_privileges !== true
      || result.rows[0].cron_autocard_cards_privileges !== true
      || result.rows[0].cron_autocard_media_privileges !== true
      || result.rows[0].cron_audit_privileges !== true) {
      throw new Error('Job title, AutoCard schema, or runtime privileges are incomplete');
    }
    console.log('migration verification: 013_job_title_catalog ok');
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
