require('dotenv').config();
const pool = require('./db');

async function checkHealth() {
  const { rows } = await pool.query(
    `SELECT heartbeat_at, last_error,
       heartbeat_at > NOW() - INTERVAL '26 hours' AS fresh
     FROM cron_status WHERE name = 'reminders'`
  );
  if (!rows[0]?.fresh || rows[0].last_error) throw new Error('Reminder worker heartbeat is stale or failed');
}

checkHealth()
  .then(() => pool.end())
  .catch(async (error) => {
    console.error(JSON.stringify({ service: 'cron', event: 'health_failed', error: error.message }));
    await pool.end().catch(() => {});
    process.exitCode = 1;
  });
