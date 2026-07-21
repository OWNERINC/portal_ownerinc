const express = require('express');
const pool = require('../db');
const { authMiddleware, can } = require('../middleware/auth');
const {
  boolean, forbidden, integer, invalid, mayViewAll, oneOf, parseListQuery,
  targetUsers, text, uuid, validBody, withAudit,
} = require('../route-utils');

const router = express.Router();
const schema = {
  title: text(200, true), description: text(5000), trigger_day: integer(1, 31),
  target_users: targetUsers, channel: oneOf('email', 'whatsapp', 'both'), active: boolean,
};
const listQuery = { all: (value) => ['true', 'false'].includes(value), active: (value) => value === 'true' };
const date = (value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
};

router.get('/deliveries', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageReminders')) return forbidden(req, res);
  const page = parseListQuery(req.query, {
    status: (value) => ['pending', 'sending', 'sent', 'failed', 'skipped'].includes(value),
    channel: (value) => ['email', 'whatsapp'].includes(value),
    reminder_id: uuid,
    user_uid: (value) => value.length > 0 && value.length <= 128,
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
    conditions.push(`${column} ${operator} $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  try {
    const countResult = await pool.query(`SELECT COUNT(*)::integer AS count FROM notifications_log ${where}`, params);
    const listParams = [...params, page.limit, page.offset];
    const { rows } = await pool.query(
      `SELECT * FROM notifications_log ${where}
       ORDER BY scheduled_date DESC, claimed_at DESC, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams
    );
    res.set('X-Total-Count', String(countResult.rows[0].count)).json(rows);
  } catch (error) {
    next(error);
  }
});

router.get('/cron-status', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageReminders')) return forbidden(req, res);
  if (Object.keys(req.query).length) return invalid(req, res);
  try {
    const { rows } = await pool.query('SELECT * FROM cron_status WHERE name = $1', ['reminders']);
    res.json(rows[0] || null);
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
  )`;
  const audience = req.user.contract_type === 'pj' || req.user.is_pj ? 'pj' : 'clt';
  const params = viewAll ? [] : [audience, req.user.uid];
  try {
    const countResult = await pool.query(`SELECT COUNT(*)::integer AS count FROM reminders ${where}`, params);
    const listParams = [...params, page.limit, page.offset];
    const { rows } = await pool.query(
      `SELECT * FROM reminders ${where} ORDER BY trigger_day, id
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      listParams
    );
    res.set('X-Total-Count', String(countResult.rows[0].count)).json(rows);
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
    res.status(201).json(row);
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
    res.json(row);
  } catch (error) {
    next(error);
  }
});

router.delete('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageReminders')) return forbidden(req, res);
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const row = await withAudit(pool, req, 'reminder.delete', 'reminder', async (db) => {
      const { rows } = await db.query('DELETE FROM reminders WHERE id=$1 RETURNING id', [req.params.id]);
      return rows[0];
    }, { targetId: req.params.id });
    if (!row) return res.status(404).json({ error: 'Reminder not found.', requestId: req.id });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
