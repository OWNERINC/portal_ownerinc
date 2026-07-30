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
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'job_title_id') AS user_job_title_column,
      has_table_privilege('portal_api', 'public.job_titles', 'SELECT,INSERT,UPDATE,DELETE') AS api_job_title_privileges`);
    if (result.rows[0].job_titles !== 'job_titles'
      || result.rows[0].user_job_title_column !== true
      || result.rows[0].api_job_title_privileges !== true) {
      throw new Error('Job title schema is incomplete');
    }
    console.log('migration verification: 009_job_titles ok');
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
