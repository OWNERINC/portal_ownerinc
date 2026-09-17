const pool = require('./db');
const { blocksToText, promoteDueScheduled } = require('../api/cms/reader');
const { lockCmsAssets } = require('../api/cms/locks');
const { reminderContentPath } = require('../api/cms/blocks');
const { sendEmail } = require('./sendEmail');
const {
  dueDateKeys, reminderIsEligibleForDate, reminderMatchesDate, resolveTargets,
} = require('./scheduling');
const {
  classifySmtpError, classifySmtpResult, smtpResponseCode,
} = require('./mailTransport');

const JOB_NAME = 'reminders';
const MAX_ATTEMPTS = 3;
const INTERRUPTED_SENDING_AFTER = "NOW() - INTERVAL '1 hour'";
const DEFAULT_PORTAL_PUBLIC_URL = 'https://portal.ownerinc.com.br';

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

function skippedDelivery(reason) {
  return { reminder: null, user: null, reason };
}

function deliveryErrorMessage(error, classification) {
  const code = smtpResponseCode(error);
  const prefix = `${classification}${code ? ` SMTP ${code}` : ''}`;
  return `${prefix}: ${errorMessage(error)}`.slice(0, 1000);
}

function isRetryableUnsent(error) {
  return classifySmtpError(error) === 'retryable'
    || Number(error?.response?.statusCode ?? error?.responseCode) === 429;
}

function reminderContentUrl(reminderId, env = process.env) {
  const path = reminderContentPath(reminderId);
  if (!path) return null;
  const base = String(env.PORTAL_PUBLIC_URL || DEFAULT_PORTAL_PUBLIC_URL).replace(/\/+$/, '');
  const baseUrl = new URL(base);
  if (!['http:', 'https:'].includes(baseUrl.protocol)
    || (env.NODE_ENV === 'production' && baseUrl.protocol !== 'https:')
    || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
    throw new Error('Invalid PORTAL_PUBLIC_URL');
  }
  return new URL(path, `${base}/`).toString();
}

function reminderPageUrl(env = process.env) {
  const base = String(env.PORTAL_PUBLIC_URL || DEFAULT_PORTAL_PUBLIC_URL).replace(/\/+$/, '');
  const url = new URL(`${base}/reminders.html`);
  if (!['http:', 'https:'].includes(url.protocol)
    || (env.NODE_ENV === 'production' && url.protocol !== 'https:')
    || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid PORTAL_PUBLIC_URL');
  }
  return url.toString();
}

async function claim(db, reminderId, userUid, scheduledDate, channel) {
  try {
    const { rows } = await db.query(
      `INSERT INTO notifications_log
          (reminder_id, user_uid, scheduled_date, channel, status, attempt_count)
        VALUES ($1, $2, $3, $4, 'sending', 1)
        ON CONFLICT (reminder_id, user_uid, scheduled_date, channel) DO UPDATE
          SET status = 'sending', claimed_at = NOW(),
              attempt_count = LEAST(notifications_log.attempt_count + 1, $5),
              sent_at = NULL, finished_at = NULL, last_error = NULL
          WHERE notifications_log.status = 'pending'
            AND notifications_log.attempt_count < $5
        RETURNING id, attempt_count`,
      [reminderId, userUid, scheduledDate, channel, MAX_ATTEMPTS]
    );
    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      attemptCount: Number.isInteger(Number(rows[0].attempt_count))
        ? Number(rows[0].attempt_count) : 1,
    };
  } catch (error) {
    if (error?.code === '23503') return null;
    throw error;
  }
}

async function markPending(db, logId, error) {
  await db.query(
    `UPDATE notifications_log
        SET status = 'pending', sent_at = NULL, finished_at = NULL, last_error = $2
      WHERE id = $1 AND status = 'sending'`,
    [logId, error]
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

async function currentDeliveryForDelivery(db, reminderId, user, scheduledDate, channel) {
  await lockCmsAssets(db);
  const { rows } = await db.query(
    `SELECT reminder.id, reminder.title, reminder.description, reminder.active,
             reminder.trigger_day, reminder.target_users, reminder.channel,
             reminder.created_at,
             document.id AS cms_document_id, document.published_revision_id
       FROM reminders reminder
       LEFT JOIN cms_documents document
         ON document.content_type = 'reminder' AND document.source_id = reminder.id
      WHERE reminder.id = $1
      FOR UPDATE OF reminder`,
    [reminderId],
  );
  const reminder = rows[0];
  if (!reminder) return skippedDelivery('reminder_removed');
  if (reminder.active !== true) return skippedDelivery('reminder_inactive');
  if (!reminderMatchesDate(reminder.trigger_day, scheduledDate)) return skippedDelivery('reminder_not_due');
  if (!reminderIsEligibleForDate(reminder.created_at, scheduledDate)) {
    return skippedDelivery('reminder_created_after_scheduled_date');
  }
  if (!channelsFor(reminder.channel).includes(channel)) return skippedDelivery('channel_not_available');
  let deliveryReminder = reminder;
  if (reminder.cms_document_id) {
    const published = await db.query(
      `SELECT document.id AS cms_document_id, revision.blocks AS cms_blocks
         FROM cms_documents document
         JOIN cms_revisions revision
           ON revision.id = document.published_revision_id AND revision.status = 'published'
        WHERE document.id = $1 AND document.content_type = 'reminder'
        FOR UPDATE OF document, revision`,
      [reminder.cms_document_id],
    );
    if (!published.rows[0]) return skippedDelivery('content_not_published');
    deliveryReminder = { ...reminder, ...published.rows[0] };
  }

  // Keep the recipient row locked until the caller commits the send decision.
  const { rows: [currentUser] } = await db.query(
    `SELECT uid, email, name, contract_type, is_pj, phone, permissions, firebase_enable_pending
       FROM users
      WHERE uid = $1
      FOR UPDATE`,
    [user.uid],
  );
  const email = String(currentUser?.email || '').trim();
  const accountDisabled = currentUser?.permissions?.accountDisabled === true
    || currentUser?.permissions?.accountDisabled === 'true';
  if (!currentUser) return skippedDelivery('recipient_removed');
  if (accountDisabled) return skippedDelivery('recipient_disabled');
  if (currentUser.firebase_enable_pending === true) return skippedDelivery('recipient_enablement_pending');
  if (!email) return skippedDelivery('recipient_missing_email');
  if (!resolveTargets(reminder.target_users, [currentUser])
    .some(target => target.uid === currentUser.uid)) return skippedDelivery('recipient_not_in_audience');
  return { reminder: deliveryReminder, user: { ...currentUser, email } };
}

async function currentReminderForDelivery(db, reminderId, user, scheduledDate, channel) {
  return currentDeliveryForDelivery(db, reminderId, user, scheduledDate, channel);
}

async function deliverEmail(db, reminder, user, scheduledDate, logId, initialAttemptCount = 1) {
  let currentLogId = logId;
  let attemptCount = Math.max(1, Number(initialAttemptCount) || 1);
  let retryNumber = 0;

  while (attemptCount <= MAX_ATTEMPTS) {
    const result = await withTransaction(db, async (transaction) => {
      const currentDelivery = await currentReminderForDelivery(
        transaction, reminder.id, user, scheduledDate, 'email',
      );
      const current = currentDelivery.reminder ? reminderForDelivery(currentDelivery.reminder) : null;
      if (!current) {
        await finish(transaction, currentLogId, 'skipped', currentDelivery.reason || 'content_empty');
        return 'skipped';
      }

      // ponytail: hold the shared lock through delivery for send/unpublish ordering; use an outbox if throughput requires shorter transactions.
      const message = {
        to: currentDelivery.user.email,
        subject: `Lembrete: ${current.title}`,
        text: `Ola, ${currentDelivery.user.name || 'colaborador(a)'}!\n\n${current.description || current.title}\n\nAcessar lembrete: ${reminderContentUrl(current.id) || reminderPageUrl()}\n\nPortal Ownerinc`
      };
      let info;
      try {
        info = await sendEmail(message);
      } catch (error) {
        const classification = classifySmtpError(error, currentDelivery.user.email);
        if (classification === 'retryable' && attemptCount < MAX_ATTEMPTS) {
          await markPending(transaction, currentLogId, deliveryErrorMessage(error, classification));
          return 'retry';
        }
        await finish(transaction, currentLogId, 'failed', deliveryErrorMessage(error, classification));
        return 'failed';
      }

      const resultClassification = classifySmtpResult(info, currentDelivery.user.email);
      if (resultClassification === 'retryable' && attemptCount < MAX_ATTEMPTS) {
        const transient = new Error('SMTP did not accept the recipient yet');
        const code = smtpResponseCode(info);
        if (code) transient.responseCode = code;
        await markPending(transaction, currentLogId, deliveryErrorMessage(transient, resultClassification));
        return 'retry';
      }
      if (resultClassification === 'unknown') {
        throw new Error('SMTP delivery result is ambiguous');
      }
      if (resultClassification !== 'accepted') {
        const rejection = new Error('SMTP did not accept the recipient');
        const code = smtpResponseCode(info);
        if (code) rejection.responseCode = code;
        await finish(transaction, currentLogId, 'failed', deliveryErrorMessage(rejection, resultClassification));
        return 'failed';
      }
      await finish(transaction, currentLogId, 'sent');
      return 'sent';
    });
    if (result !== 'retry') return result;

    retryNumber += 1;
    await new Promise((resolve) => setTimeout(resolve, 250 * (2 ** (retryNumber - 1))));
    const nextClaim = await claim(db, reminder.id, user.uid, scheduledDate, 'email');
    if (!nextClaim) {
      return withTransaction(db, async (transaction) => {
        const currentDelivery = await currentReminderForDelivery(
          transaction, reminder.id, user, scheduledDate, 'email',
        );
        const current = currentDelivery.reminder ? reminderForDelivery(currentDelivery.reminder) : null;
        const status = current ? 'failed' : 'skipped';
        const reason = current ? 'retry_claim_unavailable' : currentDelivery.reason || 'content_empty';
        await finish(transaction, currentLogId, status, reason);
        return status;
      });
    }
    currentLogId = nextClaim.id;
    attemptCount = Math.max(attemptCount + 1, nextClaim.attemptCount);
  }
  return 'failed';
}

async function processOccurrence(db, reminder, user, scheduledDate, channel) {
  const claimResult = await claim(db, reminder.id, user.uid, scheduledDate, channel);
  if (claimResult === null) return null;
  const logId = claimResult.id;

  if (channel === 'whatsapp') {
    await finish(db, logId, 'skipped', 'WhatsApp channel is disabled');
    return 'skipped';
  }
  return deliverEmail(db, reminder, user, scheduledDate, logId, claimResult.attemptCount);
}

async function processDate(db, scheduledDate) {
  const [{ rows: reminders }, { rows: users }] = await Promise.all([
    db.query(`SELECT reminder.id, reminder.title, reminder.description, reminder.trigger_day,
                     reminder.target_users, reminder.channel, reminder.created_at,
                     document.id AS cms_document_id,
                     revision.blocks AS cms_blocks
                FROM reminders reminder
                LEFT JOIN cms_documents document
                  ON document.content_type = 'reminder' AND document.source_id = reminder.id
                LEFT JOIN cms_revisions revision
                  ON revision.id = document.published_revision_id AND revision.status = 'published'
               WHERE reminder.active = true
                 AND (document.id IS NULL OR revision.id IS NOT NULL)`),
    db.query(`SELECT uid, email, name, contract_type, is_pj, phone, permissions, firebase_enable_pending
      FROM users
      WHERE COALESCE(permissions->>'accountDisabled', '') <> 'true'
        AND firebase_enable_pending IS NOT TRUE`)
  ]);
  const counts = { attempted: 0, sent: 0, failed: 0, skipped: 0 };

  for (const reminder of reminders.filter((item) => reminderMatchesDate(item.trigger_day, scheduledDate)
    && reminderIsEligibleForDate(item.created_at, scheduledDate))) {
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

async function recoverInterruptedDeliveries(db) {
  const recovered = { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  // ON DELETE SET NULL is authoritative: an orphaned sending row is known to
  // be undeliverable even when its claim is newer than the timeout.
  const orphaned = await db.query(
    `UPDATE notifications_log
        SET status = 'skipped', sent_at = NULL, finished_at = NOW(),
            last_error = CASE WHEN reminder_id IS NULL THEN 'reminder_removed'
                              ELSE 'recipient_removed' END
      WHERE status IN ('sending', 'pending')
        AND (reminder_id IS NULL OR user_uid IS NULL)
      RETURNING id`,
  );
  recovered.attempted += orphaned.rows.length;
  recovered.skipped += orphaned.rows.length;
  const interrupted = await db.query(
    `UPDATE notifications_log
        SET status = 'failed', sent_at = NULL, finished_at = NOW(),
            last_error = 'Delivery outcome unknown after worker interruption; not retried'
      WHERE status = 'sending' AND claimed_at < ${INTERRUPTED_SENDING_AFTER}
        AND reminder_id IS NOT NULL AND user_uid IS NOT NULL
      RETURNING id`,
  );
  recovered.attempted += interrupted.rows.length;
  recovered.failed += interrupted.rows.length;
  const exhausted = await db.query(
    `UPDATE notifications_log
        SET status = 'failed', finished_at = COALESCE(finished_at, NOW()),
            last_error = 'Maximum delivery attempts reached'
      WHERE status = 'pending' AND attempt_count >= $1
        AND reminder_id IS NOT NULL AND user_uid IS NOT NULL
      RETURNING id`,
    [MAX_ATTEMPTS],
  );
  recovered.attempted += exhausted.rows.length;
  recovered.failed += exhausted.rows.length;
  return recovered;
}

async function touchHeartbeat(db) {
  await db.query('UPDATE cron_status SET heartbeat_at = NOW() WHERE name = $1', [JOB_NAME]);
}

async function checkReminders(now = new Date(), overrides = {}) {
  const runtime = {
    pool, processDate, promoteScheduledRevisions, recoverInterruptedDeliveries, touchHeartbeat,
    ...overrides,
  };
  const db = await runtime.pool.connect();
  const started = Date.now();
  let locked = false;
  const totals = { attempted: 0, sent: 0, failed: 0, skipped: 0 };

  try {
    ({ rows: [{ pg_try_advisory_lock: locked }] } = await db.query('SELECT pg_try_advisory_lock($1)', [7193001]));
    if (!locked) return { skipped: true, reason: 'already-running' };

    await db.query(
       `INSERT INTO cron_status (name, heartbeat_at, last_started_at, last_error)
       VALUES ($1, NOW(), NOW(), NULL)
       ON CONFLICT (name) DO UPDATE SET heartbeat_at = NOW(), last_started_at = NOW()`,
      [JOB_NAME]
    );
    const recovered = await runtime.recoverInterruptedDeliveries(db) || {};
    for (const key of Object.keys(totals)) totals[key] += Number(recovered[key]) || 0;
    await runtime.promoteScheduledRevisions(db, now);

    const { rows: [status] } = await db.query(
      'SELECT last_scheduled_date::text AS last_scheduled_date FROM cron_status WHERE name = $1',
      [JOB_NAME],
    );
    const dates = dueDateKeys(now, status.last_scheduled_date);
    for (const date of dates) {
      await runtime.touchHeartbeat(db);
      const counts = await runtime.processDate(db, date);
      for (const key of Object.keys(totals)) totals[key] += counts[key];
      await db.query(
        `UPDATE cron_status SET last_scheduled_date = $2,
           attempted_count = $3, sent_count = $4, failed_count = $5, skipped_count = $6
         WHERE name = $1`,
        [JOB_NAME, date, totals.attempted, totals.sent, totals.failed, totals.skipped]
      );
    }

    await db.query(
      `UPDATE cron_status SET heartbeat_at = NOW(), last_finished_at = NOW(),
         last_success_at = NOW(),
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

module.exports = {
  checkReminders, channelsFor, currentReminderForDelivery, deliverEmail, isRetryableUnsent,
  processDate, processOccurrence, promoteScheduledRevisions, recoverInterruptedDeliveries,
  reminderContentUrl, reminderForDelivery, touchHeartbeat,
};
