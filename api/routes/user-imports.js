const express = require('express');
const crypto = require('node:crypto');
const pool = require('../db');
const { authMiddleware, firebaseAuth } = require('../middleware/auth');
const { can } = require('../middleware/policy');
const { parseCsv, validateRows, MAX_ROWS } = require('../services/bulk-user-import');
const { createInvitedUser } = require('../services/user-invitation');
const router = express.Router();
const internalRouter = express.Router();
const forbidden = (req, res) => res.status(403).json({ error: 'Permission denied.', requestId: req.id });
const internal_authMiddleware = (req, res, next) => {
  const supplied = Buffer.from(req.get('x-worker-secret') || '');
  const expected = Buffer.from(process.env.BULK_IMPORT_WORKER_SECRET || '');
  if (!expected.length || supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return res.sendStatus(404);
  next();
};

async function loadTitles(client) {
  const { rows } = await client.query('SELECT id, name FROM job_titles WHERE active = TRUE');
  return new Map(rows.map(title => [title.name.trim().toLocaleLowerCase('pt-BR'), title]));
}

router.post('/preview', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageUsers')) return forbidden(req, res);
  try {
    const rows = parseCsv(req.body?.csv);
    const client = await pool.connect();
    try {
      const existing = await client.query('SELECT lower(email) AS email FROM users WHERE lower(email) = ANY($1::text[])', [rows.map(row => row.email.toLowerCase())]);
      const preview = validateRows(rows, await loadTitles(client), new Set(existing.rows.map(row => row.email)));
      res.json({ maxRows: MAX_ROWS, total: preview.length, ready: preview.filter(row => row.status === 'ready').length, rows: preview });
    } finally { client.release(); }
  } catch (error) { if (error.message.startsWith('CSV ') || error.message.includes('headers')) return res.status(400).json({ error: error.message, requestId: req.id }); next(error); }
});

router.post('/confirm', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageUsers')) return forbidden(req, res);
  let client;
  try {
    const sourceRows = req.body?.rows;
    if (!Array.isArray(sourceRows) || !sourceRows.length || sourceRows.length > MAX_ROWS) return res.status(400).json({ error: 'Invalid preview rows.', requestId: req.id });
    client = await pool.connect();
    const titles = await loadTitles(client);
    const existing = await client.query('SELECT lower(email) AS email FROM users');
    const rows = validateRows(sourceRows, titles, new Set(existing.rows.map(row => row.email)));
    const readyRows = rows.filter(row => row.status === 'ready');
    if (!rows.length) return res.status(400).json({ error: 'No valid rows to import.', requestId: req.id });
    await client.query('BEGIN');
    const job = await client.query(`INSERT INTO user_import_jobs (created_by, total_count, ready_count, status, finished_at) VALUES ($1, $2, $3, $4, CASE WHEN $3 = 0 THEN NOW() ELSE NULL END) RETURNING id`, [req.user.uid, rows.length, readyRows.length, readyRows.length ? 'queued' : 'completed']);
    for (const row of rows) await client.query(
      `INSERT INTO user_import_rows (job_id, row_number, name, email, job_title, contract_type, pj_due_day, phone, status, validation_errors) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [job.rows[0].id, row.row_number, row.name, row.email, row.job_title, row.contract_type, row.pj_due_day || null, row.phone, row.status === 'ready' ? 'pending' : row.status, JSON.stringify(row.errors)]
    );
    await client.query('COMMIT');
    res.status(202).json({ id: job.rows[0].id, total: rows.length, status: 'queued' });
  } catch (error) { await client?.query('ROLLBACK').catch(() => {}); next(error); } finally { client?.release(); }
});

router.get('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageUsers')) return forbidden(req, res);
  try {
    const result = await pool.query(`SELECT j.*, (SELECT COUNT(*) FROM user_import_rows r WHERE r.job_id=j.id AND r.status='invited')::integer AS invited_count,
      (SELECT COUNT(*) FROM user_import_rows r WHERE r.job_id=j.id AND r.status='failed')::integer AS failed_count FROM user_import_jobs j WHERE j.id=$1`, [req.params.id]);
    if (!result.rows[0]) return res.sendStatus(404);
    const rows = await pool.query(`SELECT row_number, email, status, attempt_count, last_error, validation_errors FROM user_import_rows WHERE job_id=$1 ORDER BY row_number`, [req.params.id]);
    res.json({ ...result.rows[0], rows: rows.rows });
  } catch (error) { next(error); }
});

router.post('/:id/retry', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageUsers')) return forbidden(req, res);
  try {
    await pool.query(`UPDATE user_import_rows SET status='pending', last_error=NULL WHERE job_id=$1 AND status='failed' AND attempt_count < 3`, [req.params.id]);
    await pool.query(`UPDATE user_import_jobs SET status='queued', finished_at=NULL WHERE id=$1`, [req.params.id]);
    res.status(202).json({ status: 'queued' });
  } catch (error) { next(error); }
});

async function processPending() {
  const client = await pool.connect();
  let jobId;
  try {
    await client.query('BEGIN');
    const result = await client.query(`SELECT id FROM user_import_jobs WHERE status IN ('queued','processing') AND expires_at > NOW() ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`);
    if (!result.rows[0]) { await client.query('COMMIT'); return { processed: 0 }; }
    jobId = result.rows[0].id;
    await client.query(`UPDATE user_import_jobs SET status='processing', started_at=COALESCE(started_at,NOW()) WHERE id=$1`, [jobId]);
    const rows = await client.query(`SELECT * FROM user_import_rows WHERE job_id=$1 AND status='pending' AND attempt_count < 3 ORDER BY row_number LIMIT 25`, [jobId]);
    await client.query('COMMIT');
    for (const row of rows.rows) {
      const rowClient = await pool.connect();
      try {
        await rowClient.query('BEGIN');
        await rowClient.query(`UPDATE user_import_rows SET status='processing', attempt_count=attempt_count+1, updated_at=NOW() WHERE id=$1 AND status='pending'`, [row.id]);
        const title = await rowClient.query('SELECT id FROM job_titles WHERE lower(name)=lower($1) AND active=TRUE', [row.job_title]);
        if (!title.rows[0]) throw new Error('Job title is inactive or unknown.');
        await createInvitedUser({ client: rowClient, data: { ...row, job_title_id: title.rows[0].id }, audit: async (action, targetId, details) => rowClient.query(`INSERT INTO audit_log (actor_uid, action,target_type,target_id,details) VALUES ((SELECT created_by FROM user_import_jobs WHERE id=$1),$2,'user',$3,$4::jsonb)`, [jobId, action, targetId, JSON.stringify({ ...details, import_job_id: jobId, source: 'bulk' })]) });
        await rowClient.query(`UPDATE user_import_rows SET status='invited', invited_at=NOW(), updated_at=NOW() WHERE id=$1`, [row.id]);
        await rowClient.query('COMMIT');
      } catch (error) {
        await rowClient.query('ROLLBACK').catch(() => {});
        await rowClient.query(`UPDATE user_import_rows SET status='failed', attempt_count=LEAST(attempt_count+1, 3), last_error=$2, updated_at=NOW() WHERE id=$1`, [row.id, String(error.message).slice(0, 1000)]).catch(() => {});
      } finally { rowClient.release(); }
    }
    await pool.query(`UPDATE user_import_jobs SET status=CASE WHEN EXISTS (SELECT 1 FROM user_import_rows WHERE job_id=$1 AND status='pending' AND attempt_count < 3) THEN 'queued' ELSE 'completed' END, finished_at=CASE WHEN NOT EXISTS (SELECT 1 FROM user_import_rows WHERE job_id=$1 AND status='pending' AND attempt_count < 3) THEN NOW() ELSE NULL END WHERE id=$1`, [jobId]);
    return { processed: rows.rowCount, jobId };
  } finally { client.release(); }
}

internalRouter.post('/process', internal_authMiddleware, async (req, res, next) => {
  try { res.json(await processPending()); } catch (error) { next(error); }
});

module.exports = { router, internalRouter, processPending };
