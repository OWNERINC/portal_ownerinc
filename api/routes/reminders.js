const express = require('express');
const pool = require('../db');
const {
  addPublishedBlocks, isPublicCmsRow, promoteDueScheduledForPool,
} = require('../cms/reader');
const { reminderContentPath } = require('../cms/blocks');
const { deleteCmsSource } = require('../cms/sources');
const { authMiddleware, can } = require('../middleware/auth');
const {
  boolean, firebaseUid, forbidden, integer, invalid, mayViewAll, oneOf, parseListQuery,
  targetUsers, text, uuid, validBody, withAudit,
} = require('../route-utils');

const router = express.Router();
const schema = {
  title: text(200, true), description: text(5000), trigger_day: integer(1, 31),
  target_users: targetUsers, channel: oneOf('email'), active: boolean,
};
const listQuery = { all: (value) => ['true', 'false'].includes(value), active: (value) => value === 'true' };
const cmsVisible = `(
  NOT EXISTS (
    SELECT 1 FROM cms_documents hidden_document
     WHERE hidden_document.content_type = 'reminder' AND hidden_document.source_id = reminders.id
  )
  OR EXISTS (
    SELECT 1
      FROM cms_documents visible_document
      JOIN cms_revisions visible_revision ON visible_revision.id = visible_document.published_revision_id
     WHERE visible_document.content_type = 'reminder'
       AND visible_document.source_id = reminders.id
       AND visible_revision.status = 'published'
  )
)`;
const date = (value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};
const brasiliaDate = () => {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  return new Date(Date.UTC(
    Number(parts.find(part => part.type === 'year').value),
    Number(parts.find(part => part.type === 'month').value) - 1,
    Number(parts.find(part => part.type === 'day').value),
  ));
};
const nextOccurrence = (triggerDay, start = brasiliaDate()) => {
  for (let offset = 0; offset < 2; offset += 1) {
    const month = start.getUTCMonth() + offset;
    const year = start.getUTCFullYear() + Math.floor(month / 12);
    const normalizedMonth = month % 12;
    const lastDay = new Date(Date.UTC(year, normalizedMonth + 1, 0)).getUTCDate();
    const occurrence = new Date(Date.UTC(year, normalizedMonth, Math.min(Number(triggerDay), lastDay)));
    if (occurrence >= start) return occurrence;
  }
  return null;
};

function withContentUrl(row, reminderId = row?.id) {
  const contentUrl = reminderContentPath(reminderId);
  return contentUrl ? { ...row, content_url: contentUrl } : row;
}

router.get('/deliveries', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageReminders')) return forbidden(req, res);
  const page = parseListQuery(req.query, {
    status: (value) => ['pending', 'sending', 'sent', 'failed', 'skipped'].includes(value),
    channel: (value) => ['email', 'whatsapp'].includes(value),
    reminder_id: uuid,
    user_uid: firebaseUid,
    scheduled_from: date,
    scheduled_to: date,
  });
  if (!page || (req.query.scheduled_from && req.query.scheduled_to
    && req.query.scheduled_from > req.query.scheduled_to)) return invalid(req, res);

  const params = [];
  const conditions = [];
  for (const [field, operator] of [['status', '='], ['channel', '='], ['reminder_id', '='], ['user_uid', '='], ['scheduled_from', '>='], ['scheduled_to', '<=']]) {
    if (req.query[field] === undefined) continue;
    params.push(req.query[field]);
    const column = field === 'scheduled_from' || field === 'scheduled_to' ? 'scheduled_date' : field;
    conditions.push(`notifications_log.${column} ${operator} $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    const countResult = await pool.query(`SELECT COUNT(*)::integer AS count FROM notifications_log ${where}`, params);
    const listParams = [...params, page.limit, page.offset];
    const { rows } = await pool.query(
      `SELECT notifications_log.id, notifications_log.reminder_id, notifications_log.user_uid,
              notifications_log.scheduled_date::text AS scheduled_date,
              notifications_log.channel, notifications_log.status,
              notifications_log.attempt_count, notifications_log.claimed_at,
              notifications_log.sent_at, notifications_log.finished_at,
              notifications_log.last_error,
              reminders.title AS reminder_title,
              users.name AS recipient_name, users.email AS recipient_email,
              notifications_log.last_error AS reason
         FROM notifications_log
         LEFT JOIN reminders ON reminders.id = notifications_log.reminder_id
         LEFT JOIN users ON users.uid = notifications_log.user_uid
        ${where}
        ORDER BY notifications_log.scheduled_date DESC, notifications_log.claimed_at DESC,
                 notifications_log.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams
    );
    res.set('X-Total-Count', String(countResult.rows[0].count))
      .json(rows.map(row => withContentUrl(row, row.reminder_id)));
  } catch (error) {
    next(error);
  }
});

router.get('/cron-status', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageReminders')) return forbidden(req, res);
  if (Object.keys(req.query).length) return invalid(req, res);
  try {
    const { rows } = await pool.query(
      `SELECT cron_status.name, cron_status.heartbeat_at, cron_status.last_started_at,
         cron_status.last_finished_at, cron_status.last_success_at,
         cron_status.last_scheduled_date::text AS last_scheduled_date,
         cron_status.duration_ms, cron_status.attempted_count, cron_status.sent_count,
         cron_status.failed_count, cron_status.skipped_count, cron_status.last_error,
         cron_status.alert_signature, cron_status.alert_sent_at,
         CASE
           WHEN last_started_at IS NOT NULL
             AND (last_finished_at IS NULL OR last_finished_at < last_started_at) THEN 'running'
           WHEN last_error IS NULL THEN 'succeeded'
           ELSE 'failed'
         END AS execution_status,
         CASE
           WHEN attempted_count = 0 THEN 'no_candidates'
           WHEN failed_count > 0 AND sent_count > 0 THEN 'partial_failure'
           WHEN failed_count > 0 THEN 'failed'
           WHEN sent_count > 0 THEN 'sent'
           ELSE 'skipped'
         END AS delivery_status
       FROM cron_status WHERE name = $1`,
      ['reminders'],
    );
    res.json(rows[0] || null);
  } catch (error) {
    next(error);
  }
});

router.get('/upcoming', authMiddleware, async (req, res, next) => {
  if (req.query.days !== '7' || Object.keys(req.query).length !== 1) return invalid(req, res);
  const audience = req.user.contract_type === 'pj' || req.user.is_pj ? 'pj' : 'clt';
  const where = `WHERE active = TRUE AND (
    target_users = '"all"'::jsonb
    OR target_users = to_jsonb($1::text)
    OR target_users ? $2
  ) AND ${cmsVisible}`;
  try {
    await promoteDueScheduledForPool(pool, new Date(), 'reminder');
    const { rows } = await pool.query(`SELECT * FROM reminders ${where} ORDER BY trigger_day, id`, [audience, req.user.uid]);
    const start = brasiliaDate();
    const end = new Date(start.getTime() + 7 * 86400000);
    const upcoming = (await addPublishedBlocks(pool, rows, 'reminder'))
      .filter(isPublicCmsRow)
      .map(reminder => ({ ...reminder, next_occurrence: nextOccurrence(reminder.trigger_day, start) }))
      .filter(reminder => reminder.next_occurrence && reminder.next_occurrence <= end)
      .sort((left, right) => left.next_occurrence - right.next_occurrence || String(left.id).localeCompare(String(right.id)))
      .map(reminder => withContentUrl({
        ...reminder, next_occurrence: reminder.next_occurrence.toISOString().slice(0, 10),
      }));
    res.json(upcoming);
  } catch (error) {
    next(error);
  }
});

router.get('/', authMiddleware, async (req, res, next) => {
  const page = parseListQuery(req.query, listQuery);
  if (!page) return invalid(req, res);
  if (req.query.all === 'true' && !can(req.user, 'manageReminders')) return forbidden(req, res);
  const viewAll = mayViewAll(req.user, 'manageReminders', req.query.all);
  const where = viewAll ? '' : `WHERE active = TRUE AND (
    target_users = '"all"'::jsonb
    OR target_users = to_jsonb($1::text)
    OR target_users ? $2
  ) AND ${cmsVisible}`;
  const audience = req.user.contract_type === 'pj' || req.user.is_pj ? 'pj' : 'clt';
  const params = viewAll ? [] : [audience, req.user.uid];
  try {
    await promoteDueScheduledForPool(pool, new Date(), 'reminder');
    if (!viewAll) {
      const { rows } = await pool.query(
        `SELECT * FROM reminders ${where} ORDER BY trigger_day, id`,
        params,
      );
      const visible = (await addPublishedBlocks(pool, rows, 'reminder'))
        .filter(isPublicCmsRow).map(reminder => withContentUrl(reminder));
      return res.set('X-Total-Count', String(visible.length))
        .json(visible.slice(page.offset, page.offset + page.limit));
    }
    const countResult = await pool.query(`SELECT COUNT(*)::integer AS count FROM reminders ${where}`, params);
    const listParams = [...params, page.limit, page.offset];
    const { rows } = await pool.query(
      `SELECT * FROM reminders ${where} ORDER BY trigger_day, id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams
    );
    res.set('X-Total-Count', String(countResult.rows[0].count))
      .json((await addPublishedBlocks(pool, rows, 'reminder'))
        .filter(Boolean).map(reminder => withContentUrl(reminder)));
  } catch (error) {
    next(error);
  }
});

router.get('/:id', authMiddleware, async (req, res, next) => {
  if (!uuid(req.params.id)) {
    return res.status(404).json({ error: 'Reminder not found.', requestId: req.id });
  }
  const manager = can(req.user, 'manageReminders');
  const audience = req.user.contract_type === 'pj' || req.user.is_pj ? 'pj' : 'clt';
  const scope = manager ? '' : `AND (
    target_users = '"all"'::jsonb
    OR target_users = to_jsonb($2::text)
    OR target_users ? $3
  )`;
  const params = manager ? [req.params.id] : [req.params.id, audience, req.user.uid];
  try {
    const { rows: [accessible] } = await pool.query(
      `SELECT id FROM reminders WHERE id = $1 AND active = TRUE ${scope}`,
      params,
    );
    if (!accessible) {
      return res.status(404).json({ error: 'Reminder not found.', requestId: req.id });
    }
    await promoteDueScheduledForPool(pool, new Date(), 'reminder', [req.params.id]);
    const { rows } = await pool.query(
      `SELECT * FROM reminders
        WHERE id = $1 AND active = TRUE AND ${cmsVisible} ${scope}`,
      params,
    );
    const [reminder] = (await addPublishedBlocks(pool, rows, 'reminder')).filter(isPublicCmsRow);
    if (!reminder) {
      return res.status(404).json({ error: 'Reminder not found.', requestId: req.id });
    }
    res.json(withContentUrl(reminder));
  } catch (error) {
    next(error);
  }
});

router.post('/', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageReminders')) return forbidden(req, res);
  if (!validBody(req.body, schema, ['title', 'trigger_day'])) return invalid(req, res);
  try {
    const {
      title, description = '', trigger_day, target_users = 'all', channel = 'email', active = true,
    } = req.body;
    const row = await withAudit(pool, req, 'reminder.create', 'reminder', async (db) => {
      const { rows } = await db.query(
        `INSERT INTO reminders (title, description, trigger_day, target_users, channel, active, created_by)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING *`,
        [title.trim(), description, trigger_day, JSON.stringify(target_users), channel, active, req.user.uid]
      );
      return rows[0];
    }, { targetId: (result) => result.id });
    res.status(201).json(withContentUrl(row));
  } catch (error) {
    next(error);
  }
});

router.put('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageReminders')) return forbidden(req, res);
  if (!uuid(req.params.id) || !validBody(req.body, schema, Object.keys(schema))) return invalid(req, res);
  try {
    const row = await withAudit(pool, req, 'reminder.update', 'reminder', async (db) => {
      const { title, description, trigger_day, target_users, channel, active } = req.body;
      const { rows } = await db.query(
        `UPDATE reminders SET title=$2, description=$3, trigger_day=$4, target_users=$5::jsonb,
           channel=$6, active=$7, updated_at=NOW() WHERE id=$1 RETURNING *`,
        [req.params.id, title.trim(), description, trigger_day, JSON.stringify(target_users), channel, active]
      );
      return rows[0];
    }, { targetId: req.params.id });
    if (!row) return res.status(404).json({ error: 'Reminder not found.', requestId: req.id });
    res.json(withContentUrl(row));
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageReminders')) return forbidden(req, res);
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const row = await withAudit(pool, req, 'reminder.delete', 'reminder',
      db => deleteCmsSource(db, 'reminder', req.params.id), { targetId: req.params.id });
    if (!row) return res.status(404).json({ error: 'Reminder not found.', requestId: req.id });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
