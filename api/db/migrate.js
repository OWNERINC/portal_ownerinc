require('dotenv').config();
const { readdir, readFile } = require('node:fs/promises');
const path = require('node:path');
const { Pool } = require('pg');
const { grantRuntimeAccess, provisionRoles } = require('./provision');

async function migrate() {
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('Missing required environment variable: MIGRATION_DATABASE_URL');

  const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  let client;
  try {
    client = await pool.connect();
    await provisionRoles(client);
    await client.query('SELECT pg_advisory_lock($1)', [7192026]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    const directory = path.join(__dirname, 'migrations');
    const files = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map(({ version }) => version));

    for (const file of files) {
      const version = file.slice(0, -4);
      if (applied.has(version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(await readFile(path.join(directory, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        console.log(`[migrate] Applied ${version}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    await grantRuntimeAccess(client);
  } finally {
    await client?.query('SELECT pg_advisory_unlock($1)', [7192026]).catch(() => {});
    client?.release();
    await pool.end();
  }
}

if (require.main === module) {
  migrate()
    .catch((error) => {
      console.error('[migrate] Migration failed:', error.message);
      process.exitCode = 1;
    });
}

module.exports = { migrate };
