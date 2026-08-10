require('dotenv').config();
const pool = require('./db');
const { sendOperationalAlert } = require('./sendOperationalAlert');

function healthSignature(row) {
  if (!row) return 'missing';
  if (row.last_error) return `failed:${row.last_error}`.slice(0, 200);
  if (!row.fresh) return 'stale-heartbeat';
  return null;
}

async function checkHealth() {
  const { rows } = await pool.query(
    `SELECT heartbeat_at, last_error,
       heartbeat_at > NOW() - INTERVAL '26 hours' AS fresh,
       alert_signature
     FROM cron_status WHERE name = 'reminders'`
  );
  const row = rows[0];
  const signature = healthSignature(row);
  if (!signature) {
    if (row.alert_signature && await sendOperationalAlert({
      subject: 'worker recuperado',
      text: 'O worker de lembretes voltou a responder normalmente.',
    })) {
      await pool.query('UPDATE cron_status SET alert_signature = NULL, alert_sent_at = NOW() WHERE name = $1', ['reminders']);
    }
    return;
  }
  if (row?.alert_signature !== signature && await sendOperationalAlert({
    subject: signature.startsWith('failed:') ? 'falha no worker' : 'worker atrasado',
    text: signature.startsWith('failed:')
      ? `O worker de lembretes registrou uma falha: ${row.last_error}`
      : 'O worker de lembretes está sem heartbeat recente.',
  })) {
    await pool.query('UPDATE cron_status SET alert_signature = $2, alert_sent_at = NOW() WHERE name = $1', ['reminders', signature]);
  }
  throw new Error('Reminder worker heartbeat is stale or failed');
}

if (require.main === module) {
  checkHealth()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error(JSON.stringify({ service: 'cron', event: 'health_failed', error: error.message }));
      await pool.end().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = { checkHealth, healthSignature };
