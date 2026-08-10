import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../api/package.json', import.meta.url));
require('dotenv').config({ path: new URL('../.env', import.meta.url) });
if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
const { Pool } = require('pg');
const { migrate } = require('../api/db/migrate');

await migrate();
await migrate();

const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
try {
  const versions = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(versions.rows.map(({ version }) => version), [
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
  ]);
  const tables = await pool.query(`SELECT to_regclass('public.audit_log') AS audit,
    to_regclass('public.cron_status') AS cron, to_regclass('public.notifications_log') AS notifications,
    to_regclass('public.solides_employee_links') AS solides_links,
     to_regclass('public.job_titles') AS job_titles,
     to_regclass('public.autocard_cards') AS autocard_cards,
     to_regclass('public.autocard_media') AS autocard_media`);
  assert.equal(tables.rows[0].audit, 'audit_log');
  assert.equal(tables.rows[0].cron, 'cron_status');
  assert.equal(tables.rows[0].notifications, 'notifications_log');
  assert.equal(tables.rows[0].solides_links, 'solides_employee_links');
  assert.equal(tables.rows[0].job_titles, 'job_titles');
  assert.equal(tables.rows[0].autocard_cards, 'autocard_cards');
  assert.equal(tables.rows[0].autocard_media, 'autocard_media');
  const roles = await pool.query("SELECT rolname FROM pg_roles WHERE rolname IN ('portal_api', 'portal_cron') ORDER BY rolname");
  assert.deepEqual(roles.rows.map(({ rolname }) => rolname), ['portal_api', 'portal_cron']);
  console.log('migration integration: ok');
} finally {
  await pool.end();
}
