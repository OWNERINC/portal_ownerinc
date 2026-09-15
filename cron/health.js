require('dotenv').config();
const pool = require('./db');
const { sendOperationalAlert } = require('./sendOperationalAlert');

function healthSignature(row) {
  if (!row) return 'missing';
  if (row.last_error === 'Worker status missing' && row.alert_signature === 'missing') return 'missing';
  if (row.last_error) return 'failed';
  if (!row.fresh) return 'stale-heartbeat';
  return null;
}

async function checkHealth() {
  const { rows } = await pool.query(
    `SELECT heartbeat_at, last_error,
       name,
        heartbeat_at > NOW() - CASE WHEN name IN ('reminders', 'retention')
          THEN INTERVAL '26 hours' ELSE INTERVAL '10 minutes' END AS fresh,
       alert_signature
      FROM cron_status
      WHERE name = ANY($1::text[])`,
    [['reminders', 'user-imports', 'retention']],
  );
  const states = ['reminders', 'user-imports', 'retention'].map((name) => {
    const row = rows.find((candidate) => candidate.name === name);
    return { name, row, signature: healthSignature(row) };
  });
  const unhealthy = states.filter(({ signature }) => signature);
  let healthFailed = false;
  if (unhealthy.length) {
    healthFailed = true;
    console.error(JSON.stringify({ service: 'cron', event: 'worker_health_failed', workers: unhealthy.map(({ name }) => name) }));
    for (const { name, row, signature } of unhealthy) {
      if (!row) {
        await pool.query(
          `INSERT INTO cron_status (name, heartbeat_at, last_error, alert_signature)
           VALUES ($1, NOW(), 'Worker status missing', NULL)
           ON CONFLICT (name) DO NOTHING`,
          [name],
        );
      }
      const current = row || { alert_signature: null, last_error: 'Worker status missing' };
      if (current.alert_signature !== signature && await sendOperationalAlert({
        subject: signature === 'failed' ? 'falha no worker' : 'worker atrasado',
        text: signature === 'failed'
          ? `O worker ${name} registrou uma falha: ${current.last_error}`
          : `O worker ${name} está sem heartbeat recente.`,
      })) {
        await pool.query('UPDATE cron_status SET alert_signature = $2, alert_sent_at = NOW() WHERE name = $1', [name, signature]);
      }
    }
  }
  for (const { name, row, signature } of states) {
    if (!signature && row?.alert_signature && await sendOperationalAlert({
      subject: 'worker recuperado',
      text: `O worker ${name} voltou a responder normalmente.`,
    })) {
      await pool.query('UPDATE cron_status SET alert_signature = NULL, alert_sent_at = NOW() WHERE name = $1', [name]);
    }
  }
  if (healthFailed) throw new Error(`Scheduled worker health failed: ${unhealthy.map(({ name }) => name).join(', ')}`);
}

if (require.main === module) {
  if (process.env.CRON_BOOTSTRAP_ONLY === 'true') process.exit(0);
  checkHealth()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error(JSON.stringify({ service: 'cron', event: 'health_failed', error: error.message }));
      await pool.end().catch(() => {});
      process.exitCode = 1;
    });
}

module.exports = { checkHealth, healthSignature };
