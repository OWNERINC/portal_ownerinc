require('dotenv').config();
const pool = require('./db');
const { sendOperationalAlert } = require('./sendOperationalAlert');

function isExecutionRunning(row) {
  if (!row) return false;
  if (row.running === true) return true;
  const startedAt = new Date(row.last_started_at).getTime();
  const finishedAt = new Date(row.last_finished_at).getTime();
  return Number.isFinite(startedAt)
    && (!Number.isFinite(finishedAt) || finishedAt < startedAt);
}

function healthSignature(row) {
  if (!row) return 'missing';
  if (isExecutionRunning(row)) return row.fresh ? 'running' : 'stale-heartbeat';
  const executionError = row.execution_error || row.last_error;
  if (executionError === 'Worker status missing') return 'missing';
  if (executionError) return 'failed';
  if (!row.fresh) return 'stale-heartbeat';
  return null;
}

function canRecover(row) {
  if (!row || row.execution_error || row.last_error || row.fresh !== true || isExecutionRunning(row)) return false;
  if (row.execution_succeeded === false) return false;
  const startedAt = new Date(row.last_started_at).getTime();
  const finishedAt = new Date(row.last_finished_at).getTime();
  const successAt = new Date(row.last_success_at).getTime();
  return Number.isFinite(startedAt) && Number.isFinite(finishedAt) && Number.isFinite(successAt)
    && finishedAt >= startedAt && successAt >= startedAt;
}

async function checkHealth(overrides = {}) {
  const db = overrides.pool || pool;
  const alert = overrides.sendOperationalAlert || sendOperationalAlert;
  const { rows } = await db.query(
      `SELECT heartbeat_at, last_error AS execution_error,
         name, last_started_at, last_finished_at, last_success_at,
         CASE WHEN last_started_at IS NOT NULL
           AND (last_finished_at IS NULL OR last_finished_at < last_started_at)
           THEN TRUE ELSE FALSE END AS running,
         CASE WHEN last_started_at IS NOT NULL AND last_finished_at IS NOT NULL
           AND last_finished_at >= last_started_at
           AND last_success_at IS NOT NULL AND last_success_at >= last_started_at
           AND last_error IS NULL THEN TRUE ELSE FALSE END AS execution_succeeded,
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
  const unhealthy = states.filter(({ signature }) => signature && signature !== 'running');
  let healthFailed = false;
  if (unhealthy.length) {
    healthFailed = true;
    console.error(JSON.stringify({ service: 'cron', event: 'worker_health_failed', workers: unhealthy.map(({ name }) => name) }));
    for (const { name, row, signature } of unhealthy) {
      if (!row) {
        await db.query(
          `INSERT INTO cron_status (name, heartbeat_at, last_error, alert_signature)
           VALUES ($1, NOW(), 'Worker status missing', NULL)
           ON CONFLICT (name) DO NOTHING`,
          [name],
        );
      }
      const current = row || { alert_signature: null, last_error: 'Worker status missing' };
      if (current.alert_signature !== signature && await alert({
        subject: signature === 'failed' ? 'falha no worker' : 'worker atrasado',
        text: signature === 'failed'
          ? `O worker ${name} registrou uma falha: ${current.execution_error || current.last_error}`
          : `O worker ${name} está sem heartbeat recente.`,
      })) {
        await db.query('UPDATE cron_status SET alert_signature = $2, alert_sent_at = NOW() WHERE name = $1', [name, signature]);
      }
    }
  }
  for (const { name, row, signature } of states) {
    if (!signature && canRecover(row) && row.alert_signature && await alert({
      subject: 'worker recuperado',
      text: `O worker ${name} voltou a responder normalmente.`,
    })) {
      await db.query('UPDATE cron_status SET alert_signature = NULL, alert_sent_at = NOW() WHERE name = $1', [name]);
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

module.exports = { canRecover, checkHealth, healthSignature, isExecutionRunning };
