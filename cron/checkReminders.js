const pool = require('./db');
const { blocksToText, promoteDueScheduled } = require('../api/cms/reader');
const { lockCmsAssets } = require('../api/cms/locks');
const { sendEmail } = require('./sendEmail');
const { dueDateKeys, reminderMatchesDate, resolveTargets } = require('./scheduling');

const JOB_NAME = 'reminders';
const MAX_ATTEMPTS = 3;

function reminderForDelivery(reminder) {
  if (reminder.cms_document_id === null || reminder.cms_document_id === undefined) {
    if (reminder.cms_blocks === null || reminder.cms_blocks === undefined) return reminder;
    const description = blocksToText(reminder.cms_blocks);
    return description.trim() ? { ...reminder, description } : reminder;
  }
  const description = blocksToText(reminder.cms_blocks);
  return description.trim() ? { ...reminder, description } : null;
}

function channelsFor(channel) {
  return channel === 'both' ? ['email', 'whatsapp'] : [channel || 'email'];
}

function errorMessage(error) {
  return String(error?.message || error).slice(0, 1000);
}

function isRetryableUnsent(error) {
  const status = Number(error?.response?.statusCode ?? error?.responseCode);
  return status === 421 || status === 429 || status === 451 || (status >= 500 && status !== 535);
}

async function claim(db, reminderId, userUid, scheduledDate, channel) {
  try {
    const { rows } = await db.query(
      `INSERT INTO notifications_log
         (reminder_id, user_uid, scheduled_date, channel, status)
       VALUES ($1, $2, $3, $4, 'pending')
       ON CONFLICT (reminder_id, user_uid, scheduled_date, channel) DO UPDATE
         SET claimed_at = NOW(), attempt_count = LEAST(notifications_log.attempt_count + 1, $5),
             finished_at = NULL, last_error = NULL
         WHERE notifications_log.status = 'pending'
       RETURNING id`,
      [reminderId, userUid, scheduledDate, channel, MAX_ATTEMPTS]
    );
    return rows[0]?.id ?? null;
  } catch (error) {
    if (error?.code === '23503') return null;
    throw error;
  }
}

async function markSending(db, logId) {
  await db.query(
    `UPDATE notifications_log SET status = 'sending'
     WHERE id = $1 AND status = 'pending'`,
    [logId]
  );
}

async function finish(db, logId, status, error = null) {
  await db.query(
    `UPDATE notifications_log
     SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE NULL END,
         finished_at = NOW(), last_error = $3
     WHERE id = $1`,
    [logId, status, error]
  );
}

async function withTransaction(db, operation) {
  await db.query('BEGIN');
  try {
    const result = await operation(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function currentReminderForDelivery(db, reminderId, user, scheduledDate, channel) {
  await lockCmsAssets(db);
  const { rows } = await db.query(
    `SELECT reminder.id, reminder.title, reminder.description, reminder.active,
            reminder.trigger_day, reminder.target_users, reminder.channel,
            document.id AS cms_document_id, document.published_revision_id
       FROM reminders reminder
       LEFT JOIN cms_documents document
         ON document.content_type = 'reminder' AND document.source_id = reminder.id
      WHERE reminder.id = $1 AND reminder.active = TRUE
      FOR UPDATE OF reminder`,
    [reminderId],
  );
  const reminder = rows[0];
  if (!reminder || reminder.active !== true
    || !reminderMatchesDate(reminder.trigger_day, scheduledDate)
    || !channelsFor(reminder.channel).includes(channel)
    || !resolveTargets(reminder.target_users, [user]).some(target => target.uid === user.uid)) {
    return null;
  }
  if (!reminder.cms_document_id) return reminder;

  const published = await db.query(
    `SELECT document.id AS cms_document_id, revision.blocks AS cms_blocks
       FROM cms_documents document
       JOIN cms_revisions revision
         ON revision.id = document.published_revision_id AND revision.status = 'published'
      WHERE document.id = $1 AND document.content_type = 'reminder'
      FOR UPDATE OF document, revision`,
    [reminder.cms_document_id],
  );
  return published.rows[0] ? { ...reminder, ...published.rows[0] } : null;
}

async function deliverEmail(db, reminder, user, scheduledDate, logId) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await withTransaction(db, async (transaction) => {
      const currentReminder = await currentReminderForDelivery(
        transaction, reminder.id, user, scheduledDate, 'email',
      );
      const current = currentReminder ? reminderForDelivery(currentReminder) : null;
      if (!current) {
        await finish(transaction, logId, 'skipped',
          'Reminder is no longer active or published');
        return 'skipped';
      }

      await markSending(transaction, logId);
      try {
        // ponytail: hold the shared lock through delivery for send/unpublish ordering; use an outbox if throughput requires shorter transactions.
        await sendEmail({
          to: user.email,
          subject: `Lembrete: ${current.title}`,
          text: `Ola, ${user.name || 'colaborador(a)'}!\n\n${current.description || current.title}\n\nPortal Ownerinc`
        });
        await finish(transaction, logId, 'sent');
        return 'sent';
      } catch (error) {
        if (!isRetryableUnsent(error) || attempt === MAX_ATTEMPTS) {
          await finish(transaction, logId, 'failed', errorMessage(error));
          return 'failed';
        }
        await transaction.query(
          `UPDATE notifications_log SET status = 'pending', attempt_count = $2, last_error = $3
           WHERE id = $1`,
          [logId, attempt + 1, errorMessage(error)]
        );
        return null;
      }
    });
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (attempt - 1))));
  }
}

async function processOccurrence(db, reminder, user, scheduledDate, channel) {
  const logId = await claim(db, reminder.id, user.uid, scheduledDate, channel);
  if (logId === null) return null;

  try {
    if (channel === 'whatsapp') {
      await finish(db, logId, 'skipped', 'WhatsApp channel is disabled');
      return 'skipped';
    }
    if (!user.email) {
      await finish(db, logId, 'skipped', 'Recipient has no email');
      return 'skipped';
    }
    return await deliverEmail(db, reminder, user, scheduledDate, logId);
  } catch (error) {
    await finish(db, logId, 'failed', errorMessage(error)).catch(() => {});
    console.error(`[checkReminders] Falha isolada para ${user.uid}/${channel}:`, errorMessage(error));
    return 'failed';
  }
}

async function processDate(db, scheduledDate) {
  const [{ rows: reminders }, { rows: users }] = await Promise.all([
    db.query(`SELECT reminder.id, reminder.title, reminder.description, reminder.trigger_day,
                     reminder.target_users, reminder.channel, document.id AS cms_document_id,
                     revision.blocks AS cms_blocks
                FROM reminders reminder
                LEFT JOIN cms_documents document
                  ON document.content_type = 'reminder' AND document.source_id = reminder.id
                LEFT JOIN cms_revisions revision
                  ON revision.id = document.published_revision_id AND revision.status = 'published'
               WHERE reminder.active = true
                 AND (document.id IS NULL OR revision.id IS NOT NULL)`),
    db.query(`SELECT uid, email, name, contract_type, is_pj, phone FROM users
      WHERE NOT (permissions @> '{"accountDisabled":true}'::jsonb)`)
  ]);
  const counts = { attempted: 0, sent: 0, failed: 0, skipped: 0 };

  for (const reminder of reminders.filter((item) => reminderMatchesDate(item.trigger_day, scheduledDate))) {
    const deliveryReminder = reminderForDelivery(reminder);
    if (!deliveryReminder) continue;
    for (const user of resolveTargets(reminder.target_users, users)) {
      for (const channel of channelsFor(reminder.channel)) {
        const status = await processOccurrence(db, deliveryReminder, user, scheduledDate, channel);
        if (!status) continue;
        counts.attempted += 1;
        counts[status] += 1;
      }
    }
  }
  return counts;
}

async function promoteScheduledRevisions(db, now) {
  await db.query('BEGIN');
  try {
    const promoted = await promoteDueScheduled(db, now);
    await db.query('COMMIT');
    return promoted;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    throw error;
  }
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
       ON CONFLICT (name) DO UPDATE SET heartbeat_at = NOW(), last_started_at = NOW(),
         last_error = CASE WHEN cron_status.last_error = 'Worker status missing' THEN NULL ELSE cron_status.last_error END`,
      [JOB_NAME]
    );
    await db.query(
      `UPDATE notifications_log SET status = 'failed', finished_at = NOW(),
          last_error = 'Delivery outcome unknown after worker interruption; not retried'
      WHERE status = 'sending' AND claimed_at < NOW() - INTERVAL '1 hour'`
    );
    await promoteScheduledRevisions(db, now);

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
      `UPDATE cron_status SET heartbeat_at = NOW(), last_finished_at = NOW(),
         last_success_at = CASE WHEN $5 = 0 THEN NOW() ELSE last_success_at END,
         duration_ms = $2, attempted_count = $3, sent_count = $4, failed_count = $5,
         skipped_count = $6, last_error = $7 WHERE name = $1`,
      [JOB_NAME, Date.now() - started, totals.attempted, totals.sent, totals.failed, totals.skipped,
        totals.failed ? `${totals.failed} reminder deliveries failed.` : null]
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

module.exports = {
  checkReminders, channelsFor, currentReminderForDelivery, deliverEmail, isRetryableUnsent,
  processOccurrence, promoteScheduledRevisions, reminderForDelivery,
};
