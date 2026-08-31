require('dotenv').config();
const { Pool } = require('pg');

const rolePasswords = {
  portal_api: process.env.PORTAL_API_DB_PASSWORD,
  portal_cron: process.env.PORTAL_CRON_DB_PASSWORD,
};

function literal(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function identifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function validateEnvironment() {
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('Missing required environment variable: MIGRATION_DATABASE_URL');
  for (const [role, password] of Object.entries(rolePasswords)) {
    if (!password || password.length < 16) throw new Error(`${role} password must contain at least 16 characters`);
  }
}

async function provisionRoles(client) {
  validateEnvironment();
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'portal_api') THEN CREATE ROLE portal_api LOGIN; END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'portal_cron') THEN CREATE ROLE portal_cron LOGIN; END IF;
  END $$`);
  for (const [role, password] of Object.entries(rolePasswords)) {
    await client.query(`ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${literal(password)}`);
  }
}

async function grantRuntimeAccess(client) {
  const { rows: [{ database }] } = await client.query('SELECT current_database() AS database');
  await client.query(`
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT CONNECT ON DATABASE ${identifier(database)} TO portal_api, portal_cron;
    GRANT USAGE ON SCHEMA public TO portal_api, portal_cron;
    REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM portal_api, portal_cron;
    REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM portal_api, portal_cron;
    GRANT SELECT, INSERT, UPDATE, DELETE ON users TO portal_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON knowledge_base, reminders, academy, benefits TO portal_api;
    GRANT SELECT ON notifications_log TO portal_api;
    GRANT SELECT ON cron_status TO portal_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON solides_employee_links TO portal_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON job_titles TO portal_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON autocard_cards, autocard_media TO portal_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON pos_cards, pos_card_media TO portal_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON cms_documents, cms_revisions, cms_assets TO portal_api;
    GRANT SELECT, INSERT, UPDATE ON audit_log TO portal_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON user_import_jobs, user_import_rows TO portal_api;
    GRANT SELECT ON users, reminders TO portal_cron;
    GRANT SELECT, INSERT, UPDATE, DELETE ON notifications_log TO portal_cron;
    GRANT SELECT, INSERT, UPDATE ON cron_status TO portal_cron;
    GRANT SELECT ON autocard_cards TO portal_cron;
    GRANT SELECT, DELETE ON autocard_media TO portal_cron;
    GRANT SELECT ON pos_cards TO portal_cron;
    GRANT SELECT, DELETE ON pos_card_media TO portal_cron;
    GRANT SELECT, UPDATE ON cms_documents, cms_revisions TO portal_cron;
    GRANT SELECT, DELETE ON cms_assets TO portal_cron;
    GRANT SELECT, INSERT, UPDATE, DELETE ON audit_log TO portal_cron;
    GRANT SELECT, INSERT, UPDATE, DELETE ON user_import_jobs, user_import_rows TO portal_cron;
  `);
}

async function provision() {
  validateEnvironment();
  const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  try {
    const client = await pool.connect();
    try {
      await provisionRoles(client);
      await grantRuntimeAccess(client);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  provision().catch((error) => {
    console.error('[provision] Provisioning failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { grantRuntimeAccess, provisionRoles };
