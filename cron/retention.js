const pool = require('./db');

function retentionDays(env = process.env) {
  const values = {
    notifications: Number(env.NOTIFICATION_RETENTION_DAYS || 730),
    audit: Number(env.AUDIT_RETENTION_DAYS || 1825),
  };
  if (Object.values(values).some((value) => !Number.isInteger(value) || value < 30 || value > 3650)) {
    throw new Error('Retention days must be integers between 30 and 3650');
  }
  return values;
}

async function enforceRetention() {
  const days = retentionDays();
  const db = await pool.connect();
  let locked = false;
  try {
    ({ rows: [{ pg_try_advisory_lock: locked }] } = await db.query('SELECT pg_try_advisory_lock($1)', [7193002]));
    if (!locked) return { skipped: true };
    await db.query('BEGIN');
    const notifications = await db.query(
      `DELETE FROM notifications_log
       WHERE status IN ('sent', 'failed', 'skipped')
         AND scheduled_date < CURRENT_DATE - $1::integer`,
      [days.notifications]
    );
    const audit = await db.query(
      `DELETE FROM audit_log WHERE created_at < NOW() - ($1::integer * INTERVAL '1 day')`,
      [days.audit]
    );
    const userImports = await db.query('DELETE FROM user_import_jobs WHERE expires_at < NOW()');
    const details = { notifications: notifications.rowCount, audit: audit.rowCount, userImports: userImports.rowCount, days };
    await db.query(
      `INSERT INTO audit_log (action, target_type, details)
       VALUES ('retention.enforce', 'system', $1::jsonb)`,
      [JSON.stringify(details)]
    );
    await db.query('COMMIT');
    console.log(JSON.stringify({ service: 'cron', event: 'retention_completed', ...details }));
    return details;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (locked) await db.query('SELECT pg_advisory_unlock($1)', [7193002]).catch(() => {});
    db.release();
  }
}

module.exports = { enforceRetention, retentionDays };
