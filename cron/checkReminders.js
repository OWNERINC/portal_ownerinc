const pool = require('./db');
const { sendEmail } = require('./sendEmail');
const { dueDateKeys, reminderMatchesDate, resolveTargets } = require('./scheduling');

const JOB_NAME = 'reminders';
const MAX_ATTEMPTS = 3;

function channelsFor(channel) {
  return channel === 'both' ? ['email', 'whatsapp'] : [channel || 'email'];
}

function errorMessage(error) {
  return String(error?.message || error).slice(0, 1000);
}

function isRetryableUnsent(error) {
  const status = error?.response?.statusCode;
  return status === 429 || status >= 500;
}

async function claim(db, reminderId, userUid, scheduledDate, channel) {
  const { rowCount } = await db.query(
    `INSERT INTO notifications_log
       (reminder_id, user_uid, scheduled_date, channel, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (reminder_id, user_uid, scheduled_date, channel) DO UPDATE
       SET claimed_at = NOW(), attempt_count = LEAST(notifications_log.attempt_count + 1, $5),
           finished_at = NULL, last_error = NULL
       WHERE notifications_log.status = 'pending'
      `,
    [reminderId, userUid, scheduledDate, channel, MAX_ATTEMPTS]
  );
  return rowCount === 1;
}

async function markSending(db, reminderId, userUid, scheduledDate, channel) {
  await db.query(
    `UPDATE notifications_log SET status = 'sending'
     WHERE reminder_id = $1 AND user_uid = $2 AND scheduled_date = $3 AND channel = $4 AND status = 'pending'`,
    [reminderId, userUid, scheduledDate, channel]
  );
}

async function finish(db, reminderId, userUid, scheduledDate, channel, status, error = null) {
  await db.query(
    `UPDATE notifications_log
     SET status = $5, sent_at = CASE WHEN $5 = 'sent' THEN NOW() ELSE NULL END,
         finished_at = NOW(), last_error = $6
     WHERE reminder_id = $1 AND user_uid = $2 AND scheduled_date = $3 AND channel = $4`,
    [reminderId, userUid, scheduledDate, channel, status, error]
  );
}

async function deliverEmail(db, reminder, user, scheduledDate) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await markSending(db, reminder.id, user.uid, scheduledDate, 'email');
    try {
      await sendEmail({
        to: user.email,
        subject: `Lembrete: ${reminder.title}`,
        text: `Ola, ${user.name || 'colaborador(a)'}!\n\n${reminder.description || reminder.title}\n\nPortal Ownerinc`
      });
      await finish(db, reminder.id, user.uid, scheduledDate, 'email', 'sent');
      return 'sent';
    } catch (error) {
      if (!isRetryableUnsent(error) || attempt === MAX_ATTEMPTS) {
        await finish(db, reminder.id, user.uid, scheduledDate, 'email', 'failed', errorMessage(error));
        return 'failed';
      }
      await db.query(
        `UPDATE notifications_log SET status = 'pending', attempt_count = $5, last_error = $6
         WHERE reminder_id = $1 AND user_uid = $2 AND scheduled_date = $3 AND channel = $4`,
        [reminder.id, user.uid, scheduledDate, 'email', attempt + 1, errorMessage(error)]
      );
      await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempt - 1))));
    }
  }
}

async function processOccurrence(db, reminder, user, scheduledDate, channel) {
  if (!await claim(db, reminder.id, user.uid, scheduledDate, channel)) return null;

  try {
    if (channel === 'whatsapp') {
      await finish(db, reminder.id, user.uid, scheduledDate, channel, 'skipped', 'WhatsApp channel is disabled');
      return 'skipped';
    }
    if (!user.email) {
      await finish(db, reminder.id, user.uid, scheduledDate, channel, 'skipped', 'Recipient has no email');
      return 'skipped';
    }
    return await deliverEmail(db, reminder, user, scheduledDate);
  } catch (error) {
    await finish(db, reminder.id, user.uid, scheduledDate, channel, 'failed', errorMessage(error)).catch(() => {});
    console.error(`[checkReminders] Falha isolada para ${user.uid}/${channel}:`, errorMessage(error));
    return 'failed';
  }
}

async function processDate(db, scheduledDate) {
  const [{ rows: reminders }, { rows: users }] = await Promise.all([
    db.query('SELECT id, title, description, trigger_day, target_users, channel FROM reminders WHERE active = true'),
    db.query(`SELECT uid, email, name, contract_type, is_pj, phone FROM users
      WHERE NOT (permissions @> '{"accountDisabled":true}'::jsonb)`)
  ]);
  const counts = { attempted: 0, sent: 0, failed: 0, skipped: 0 };

  for (const reminder of reminders.filter((item) => reminderMatchesDate(item.trigger_day, scheduledDate))) {
    for (const user of resolveTargets(reminder.target_users, users)) {
      for (const channel of channelsFor(reminder.channel)) {
        const status = await processOccurrence(db, reminder, user, scheduledDate, channel);
        if (!status) continue;
        counts.attempted += 1;
        counts[status] += 1;
      }
    }
  }
  return counts;
}

async function checkReminders(now = new Date()) {
  const db = await pool.connect();
  const started = Date.now();
  let locked = false;
  const totals = { attempted: 0, sent: 0, failed: 0, skipped: 0 };

  try {
    ({ rows: [{ pg_try_advisory_lock: locked }] } = await db.query('SELECT pg_try_advisory_lock($1)', [7193001]));
    if (!locked) return { skipped: true, reason: 'already-running' };

    await db.query(
      `INSERT INTO cron_status (name, heartbeat_at, last_started_at, last_error)
       VALUES ($1, NOW(), NOW(), NULL)
       ON CONFLICT (name) DO UPDATE SET heartbeat_at = NOW(), last_started_at = NOW(), last_error = NULL`,
      [JOB_NAME]
    );
    await db.query(
      `UPDATE notifications_log SET status = 'failed', finished_at = NOW(),
          last_error = 'Delivery outcome unknown after worker interruption; not retried'
        WHERE status = 'sending' AND claimed_at < NOW() - INTERVAL '1 hour'`
    );

    const { rows: [status] } = await db.query('SELECT last_scheduled_date FROM cron_status WHERE name = $1', [JOB_NAME]);
    const dates = dueDateKeys(now, status.last_scheduled_date);
    for (const date of dates) {
      const counts = await processDate(db, date);
      for (const key of Object.keys(totals)) totals[key] += counts[key];
      await db.query(
        `UPDATE cron_status SET heartbeat_at = NOW(), last_scheduled_date = $2,
           attempted_count = $3, sent_count = $4, failed_count = $5, skipped_count = $6
         WHERE name = $1`,
        [JOB_NAME, date, totals.attempted, totals.sent, totals.failed, totals.skipped]
      );
    }

    await db.query(
      `UPDATE cron_status SET heartbeat_at = NOW(), last_finished_at = NOW(), last_success_at = NOW(),
         duration_ms = $2, attempted_count = $3, sent_count = $4, failed_count = $5,
         skipped_count = $6, last_error = NULL WHERE name = $1`,
      [JOB_NAME, Date.now() - started, totals.attempted, totals.sent, totals.failed, totals.skipped]
    );
    console.log(JSON.stringify({ service: 'cron', event: 'run_completed', days: dates.length, ...totals }));
    return totals;
  } catch (error) {
    if (locked) {
      await db.query(
        `UPDATE cron_status SET heartbeat_at = NOW(), last_finished_at = NOW(), duration_ms = $2,
           last_error = $3 WHERE name = $1`,
        [JOB_NAME, Date.now() - started, errorMessage(error)]
      ).catch(() => {});
    }
    throw error;
  } finally {
    if (locked) await db.query('SELECT pg_advisory_unlock($1)', [7193001]).catch(() => {});
    db.release();
  }
}

module.exports = { checkReminders, channelsFor, isRetryableUnsent };
