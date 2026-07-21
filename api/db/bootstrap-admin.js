require('dotenv').config();
const { Pool } = require('pg');
const { firebaseAuth } = require('../middleware/auth');

async function bootstrapAdmin(uid, email, name) {
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('Missing required environment variable: MIGRATION_DATABASE_URL');
  if (!uid || uid.length > 128) throw new Error('Firebase UID is required and must be at most 128 characters');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '') || email.length > 320) throw new Error('A valid email is required');
  if (!name || name.length > 200) throw new Error('Name is required and must be at most 200 characters');

  const firebaseUser = await firebaseAuth.getUser(uid);
  if (firebaseUser.email?.toLowerCase() !== email.toLowerCase()) throw new Error('Firebase email does not match');
  if (!firebaseUser.emailVerified) throw new Error('Firebase email must be verified');
  if (firebaseUser.disabled) throw new Error('Firebase account must be enabled');

  const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [7192027]);
    const { rowCount } = await client.query(`SELECT 1 FROM users
      WHERE role = 'admin' AND permissions @> '{"superAdmin":true}'::jsonb
        AND permissions->>'accountDisabled' IS DISTINCT FROM 'true'
      LIMIT 1`);
    if (rowCount) throw new Error('An active superAdmin already exists; no changes were made');

    await client.query(`INSERT INTO users (uid, email, name, role, permissions)
      VALUES ($1, $2, $3, 'admin', '{"superAdmin":true}'::jsonb)
      ON CONFLICT (uid) DO UPDATE SET
        email = EXCLUDED.email,
        name = EXCLUDED.name,
        role = 'admin',
        permissions = (COALESCE(users.permissions, '{}'::jsonb) - 'accountDisabled') || EXCLUDED.permissions`,
    [uid, email, name]);
    await client.query(`INSERT INTO audit_log (actor_uid, action, target_type, target_id, details)
      VALUES ($1, 'bootstrap_super_admin', 'user', $1, jsonb_build_object('email', $2::text))`, [uid, email]);
    await client.query('COMMIT');
    console.log(`[bootstrap-admin] Created superAdmin ${uid}`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  bootstrapAdmin(...process.argv.slice(2, 5)).catch((error) => {
    console.error('[bootstrap-admin] Failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { bootstrapAdmin };
