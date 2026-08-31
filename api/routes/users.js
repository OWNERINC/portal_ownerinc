const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const router = express.Router();
const pool = require('../db');
const { authMiddleware, firebaseAuth } = require('../middleware/auth');
const {
  can, isSuperAdmin, mayChangeAccountStatus, maySetPrivileges, normalizePermissions,
  removesLastActiveSuperAdmin,
} = require('../middleware/policy');
const { hasOwn, validateProfile, validateUser } = require('../middleware/validation');
const { parseListQuery } = require('../route-utils');
const { createInvitedUser } = require('../services/user-invitation');
// The shared invitation service calls sendInvitation and audits user.create.

const forbidden = (req, res) => res.status(403).json({ error: 'Permission denied.', requestId: req.id });
const invalid = (req, res) => res.status(400).json({ error: 'Invalid request.', requestId: req.id });

async function audit(client, req, action, targetId, details = {}) {
  await client.query(
    `INSERT INTO audit_log (actor_uid, action, target_type, target_id, request_id, details)
     VALUES ($1, $2, 'user', $3, $4, $5::jsonb)`,
    [req.user.uid, action, targetId || null, req.id, JSON.stringify(details)]
  );
}

async function stageStoredPhoto(photoUrl) {
  if (!photoUrl?.startsWith('/uploads/')) return null;
  const filename = path.basename(photoUrl);
  if (`/uploads/${filename}` !== photoUrl) return null;
  const original = path.join(process.env.UPLOAD_DIR || '/app/uploads', filename);
  const staged = `${original}.erase-${crypto.randomUUID()}`;
  try {
    await fs.rename(original, staged);
    return { original, staged, contents: await fs.readFile(staged) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

router.get('/me', authMiddleware, (req, res) => res.json(req.user));

router.get('/audit', authMiddleware, async (req, res, next) => {
  if (!isSuperAdmin(req.user)) return forbidden(req, res);
  const page = parseListQuery(req.query);
  if (!page) return invalid(req, res);
  try {
    const [events, count] = await Promise.all([
      pool.query(`SELECT id, actor_uid, action, target_type, target_id, request_id, details, created_at
        FROM audit_log ORDER BY created_at DESC, id LIMIT $1 OFFSET $2`, [page.limit, page.offset]),
      pool.query('SELECT COUNT(*)::integer AS total FROM audit_log'),
    ]);
    res.setHeader('X-Total-Count', count.rows[0].total);
    res.json(events.rows);
  } catch (err) {
    next(err);
  }
});

router.put('/me', authMiddleware, async (req, res, next) => {
  if (!validateProfile(req.body)) return invalid(req, res);
  try {
    const { name, bio, phone, linkedin_url, photo_crop } = req.body;
    const { rows } = await pool.query(
      `UPDATE users SET
        name = COALESCE($2, name), bio = COALESCE($3, bio),
        phone = COALESCE($4, phone), linkedin_url = COALESCE($5, linkedin_url),
        photo_crop = COALESCE($6::jsonb, photo_crop)
       WHERE uid = $1 RETURNING *`,
      [req.user.uid, name, bio, phone, linkedin_url, photo_crop ? JSON.stringify(photo_crop) : null]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

router.get('/', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageUsers')) return forbidden(req, res);
  const page = parseListQuery(req.query);
  if (!page) return invalid(req, res);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const [{ rows }, count] = await Promise.all([
      client.query(`SELECT u.uid, u.email, u.name, u.phone, u.role, u.contract_type, u.is_pj, u.pj_due_day,
          u.job_title_id, jt.name AS job_title, u.permissions, u.created_at
        FROM users u LEFT JOIN job_titles jt ON jt.id = u.job_title_id
        ORDER BY u.name, u.uid LIMIT $1 OFFSET $2`, [page.limit, page.offset]),
      client.query('SELECT COUNT(*)::integer AS total FROM users'),
    ]);
    await audit(client, req, 'user.list', null, { limit: page.limit, offset: page.offset, resultCount: rows.length });
    await client.query('COMMIT');
    res.setHeader('X-Total-Count', count.rows[0].total);
    res.json(rows);
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
});

router.post('/', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageUsers')) return forbidden(req, res);
  if (!validateUser(req.body, { creating: true })) return invalid(req, res);

  const setsPrivileges = hasOwn(req.body, 'role') || hasOwn(req.body, 'permissions');
  if (setsPrivileges && !isSuperAdmin(req.user)) return forbidden(req, res);

  let client;
  try {
    const { email, name = '', contract_type = 'clt', is_pj = false, pj_due_day = null, job_title_id = null, phone = '' } = req.body;
    const role = req.body.role || 'viewer';
    const permissions = role === 'admin' ? normalizePermissions(req.body.permissions) : {};

    client = await pool.connect();
    await client.query('BEGIN');
    if (job_title_id) {
      const { rowCount } = await client.query('SELECT 1 FROM job_titles WHERE id = $1 AND active = TRUE', [job_title_id]);
      if (!rowCount) {
        const error = new Error('Invalid job title');
        error.code = 'INVALID_JOB_TITLE';
        throw error;
      }
    }
    const rows = await createInvitedUser({ client, data: { email, name, contract_type, pj_due_day, job_title_id, phone, role, permissions }, audit: (action, targetId, details) => audit(client, req, action, targetId, details) });
    await client.query('COMMIT');
    res.status(201).json(rows);
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    if (err.code === 'INVALID_JOB_TITLE') return invalid(req, res);
    if (err.code === 'auth/email-already-exists') {
      return res.status(409).json({ error: 'Account already exists.', requestId: req.id });
    }
    next(err);
  } finally {
    client?.release();
  }
});

router.put('/:uid/reactivate', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageUsers')) return forbidden(req, res);
  let client;
  let enabled = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT uid, role, permissions FROM users WHERE uid = $1 FOR UPDATE', [req.params.uid]);
    const target = rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found.', requestId: req.id });
    }
    if (!mayChangeAccountStatus(req.user, target)) {
      await client.query('ROLLBACK');
      return forbidden(req, res);
    }

    await firebaseAuth.updateUser(req.params.uid, { disabled: false });
    enabled = true;
    const result = await client.query(
      `UPDATE users SET permissions = permissions - 'accountDisabled' WHERE uid = $1 RETURNING *`,
      [req.params.uid]
    );
    await audit(client, req, 'user.reactivate', req.params.uid);
    await client.query('COMMIT');
    enabled = false;
    res.json(result.rows[0]);
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    if (enabled) {
      await firebaseAuth.updateUser(req.params.uid, { disabled: true }).catch((cleanupError) => {
        console.error(`[api] request=${req.id} Firebase compensation failed`, cleanupError);
      });
    }
    next(err);
  } finally {
    client?.release();
  }
});

router.put('/:uid', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageUsers')) return forbidden(req, res);
  if (!validateUser(req.body)) return invalid(req, res);

  const setsPrivileges = hasOwn(req.body, 'role') || hasOwn(req.body, 'permissions');
  if (setsPrivileges && !maySetPrivileges(req.user, req.params.uid)) return forbidden(req, res);

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM users WHERE uid = $1 FOR UPDATE', [req.params.uid]);
    const target = rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found.', requestId: req.id });
    }
    if (isSuperAdmin(target) && !isSuperAdmin(req.user)) {
      await client.query('ROLLBACK');
      return forbidden(req, res);
    }

    const role = hasOwn(req.body, 'role') ? req.body.role : target.role;
    const permissions = hasOwn(req.body, 'permissions')
      ? (role === 'admin' ? normalizePermissions(req.body.permissions) : {})
      : target.permissions;
    if (target.permissions?.accountDisabled === true) permissions.accountDisabled = true;
    if (isSuperAdmin(target) && !(role === 'admin' && permissions.superAdmin === true)) {
      const superAdmins = await client.query(
        `SELECT uid FROM users
         WHERE role = 'admin' AND permissions @> '{"superAdmin":true}'::jsonb
           AND NOT (permissions @> '{"accountDisabled":true}'::jsonb)
         FOR UPDATE`
      );
      if (removesLastActiveSuperAdmin(target, role, permissions, superAdmins.rowCount)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'The last super admin cannot be removed.', requestId: req.id });
      }
    }

    const { name, contract_type, is_pj, pj_due_day, phone } = req.body;
    const jobTitleId = hasOwn(req.body, 'job_title_id') ? req.body.job_title_id : target.job_title_id;
    if (jobTitleId) {
      const { rowCount } = await client.query(
        'SELECT 1 FROM job_titles WHERE id = $1 AND (active = TRUE OR id = $2)',
        [jobTitleId, target.job_title_id]
      );
      if (!rowCount) {
        await client.query('ROLLBACK');
        return invalid(req, res);
      }
    }
    const result = await client.query(
      `UPDATE users SET
        name = COALESCE($2, name), role = $3,
        contract_type = COALESCE($4, contract_type),
        is_pj = COALESCE($5, is_pj), pj_due_day = $6,
        job_title_id = $7, phone = COALESCE($8, phone), permissions = $9
       WHERE uid = $1 RETURNING *`,
      [req.params.uid, name, role, contract_type, is_pj, hasOwn(req.body, 'pj_due_day') ? pj_due_day : target.pj_due_day,
        jobTitleId, phone, JSON.stringify(permissions)]
    );
    await audit(client, req, 'user.update', req.params.uid, { fields: Object.keys(req.body).sort() });
    await client.query('COMMIT');
    res.json(result.rows[0]);
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
});

router.delete('/:uid/personal-data', authMiddleware, async (req, res, next) => {
  if (!isSuperAdmin(req.user) || req.user.uid === req.params.uid) return forbidden(req, res);
  let client;
  let stagedPhoto;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM users WHERE uid = $1 FOR UPDATE', [req.params.uid]);
    const target = rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found.', requestId: req.id });
    }
    if (target.permissions?.accountDisabled !== true || isSuperAdmin(target)) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Disable the non-super-admin account before erasing personal data.', requestId: req.id });
    }
    stagedPhoto = await stageStoredPhoto(target.photo_url);
    try {
      await firebaseAuth.deleteUser(req.params.uid);
    } catch (error) {
      if (error.code !== 'auth/user-not-found') throw error;
    }
    await client.query(`UPDATE audit_log SET target_id = NULL, details = details - 'email'
      WHERE target_id = $1`, [req.params.uid]);
    await client.query(
      `UPDATE reminders SET target_users = (
         SELECT COALESCE(jsonb_agg(uid), '[]'::jsonb)
         FROM jsonb_array_elements_text(reminders.target_users) AS targets(uid)
         WHERE uid <> $1
       ), updated_at = NOW()
       WHERE jsonb_typeof(target_users) = 'array' AND target_users ? $1`,
      [req.params.uid]
    );
    await client.query('DELETE FROM users WHERE uid = $1', [req.params.uid]);
    await audit(client, req, 'user.erase_personal_data', null, { recordDeleted: true });
    if (stagedPhoto) await fs.unlink(stagedPhoto.staged);
    await client.query('COMMIT');
    res.json({ success: true, erased: true });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    if (stagedPhoto) {
      await fs.rename(stagedPhoto.staged, stagedPhoto.original)
        .catch(() => fs.writeFile(stagedPhoto.original, stagedPhoto.contents).catch(() => {}));
    }
    next(err);
  } finally {
    client?.release();
  }
});

router.delete('/:uid', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageUsers')) return forbidden(req, res);

  let client;
  let firebaseDisabled = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM users WHERE uid = $1 FOR UPDATE', [req.params.uid]);
    const target = rows[0];
    if (!target) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Account not found.', requestId: req.id });
    }
    if (!mayChangeAccountStatus(req.user, target)) {
      await client.query('ROLLBACK');
      return forbidden(req, res);
    }
    if (isSuperAdmin(target)) {
      const superAdmins = await client.query(
        `SELECT uid FROM users
         WHERE role = 'admin' AND permissions @> '{"superAdmin":true}'::jsonb
           AND NOT (permissions @> '{"accountDisabled":true}'::jsonb)
         FOR UPDATE`
      );
      if (removesLastActiveSuperAdmin(target, target.role, { ...target.permissions, superAdmin: false }, superAdmins.rowCount)) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'The last super admin cannot be disabled.', requestId: req.id });
      }
    }

    await firebaseAuth.updateUser(req.params.uid, { disabled: true });
    firebaseDisabled = true;
    await firebaseAuth.revokeRefreshTokens(req.params.uid);
    await client.query(
      `UPDATE users SET permissions = jsonb_set(permissions, '{accountDisabled}', 'true'::jsonb)
       WHERE uid = $1`,
      [req.params.uid]
    );
    await audit(client, req, 'user.disable', req.params.uid);
    await client.query('COMMIT');
    firebaseDisabled = false;
    res.json({ success: true, disabled: true });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    if (firebaseDisabled) {
      await firebaseAuth.updateUser(req.params.uid, { disabled: false }).catch((cleanupError) => {
        console.error(`[api] request=${req.id} Firebase compensation failed`, cleanupError);
      });
    }
    next(err);
  } finally {
    client?.release();
  }
});

module.exports = router;
