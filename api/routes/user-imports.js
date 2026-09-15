const express = require('express');
const crypto = require('node:crypto');
const pool = require('../db');
const { authMiddleware, firebaseAuth } = require('../middleware/auth');
const { can, isSuperAdmin } = require('../middleware/policy');
const { invalid, uuid } = require('../route-utils');
const {
  canClaimImportIdentity, decideImportIdentity, parseCsv, validateRows, MAX_ROWS,
} = require('../services/bulk-user-import');
const {
  compensateCreatedInvitedUser, createInvitedUser, enableActiveUser,
  lockPendingRegistrationIdentity, processFirebaseCleanup,
  reconcilePendingFirebaseEnables,
} = require('../services/user-invitation');
const { expirePendingRegistrations } = require('../services/pending-registration');
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

async function loadExistingEmails(client) {
  const { rows } = await client.query(
    `SELECT lower(email) AS email FROM users
     UNION
     SELECT lower(email) AS email FROM pending_registrations
      WHERE status IN ('pending', 'approved') OR firebase_cleanup_pending = TRUE`,
  );
  return new Set(rows.map(row => row.email));
}

router.post('/preview', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageUsers')) return forbidden(req, res);
  try {
    const rows = parseCsv(req.body?.csv);
    const client = await pool.connect();
    try {
      const preview = validateRows(rows, await loadTitles(client), await loadExistingEmails(client));
      res.json({ maxRows: MAX_ROWS, total: preview.length, ready: preview.filter(row => row.status === 'ready').length, rows: preview });
    } finally { client.release(); }
  } catch (error) { if (error.message.startsWith('CSV ') || error.message.includes('headers')) return res.status(400).json({ error: error.message, requestId: req.id }); next(error); }
});

router.post('/confirm', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageUsers')) return forbidden(req, res);
  let client;
  try {
    const sourceRows = req.body?.rows;
    if (!Array.isArray(sourceRows) || !sourceRows.length || sourceRows.length > MAX_ROWS
      || sourceRows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
      return res.status(400).json({ error: 'Invalid preview rows.', requestId: req.id });
    }
    client = await pool.connect();
    const titles = await loadTitles(client);
    const rows = validateRows(sourceRows, titles, await loadExistingEmails(client));
    const readyRows = rows.filter(row => row.status === 'ready');
    if (!rows.length) return res.status(400).json({ error: 'No valid rows to import.', requestId: req.id });
    await client.query('BEGIN');
    const jobStatus = readyRows.length ? 'queued' : 'completed';
    const job = await client.query(`INSERT INTO user_import_jobs (created_by, total_count, ready_count, status, finished_at) VALUES ($1, $2, $3, $4, CASE WHEN $3 = 0 THEN NOW() ELSE NULL END) RETURNING id`, [req.user.uid, rows.length, readyRows.length, jobStatus]);
    for (const row of rows) await client.query(
      `INSERT INTO user_import_rows (job_id, row_number, name, email, job_title, contract_type, pj_due_day, phone, status, validation_errors) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [job.rows[0].id, row.row_number, row.name, row.email, row.job_title, row.contract_type, row.pj_due_day || null, row.phone, row.status === 'ready' ? 'pending' : row.status, JSON.stringify(row.errors)]
    );
    await client.query('COMMIT');
    res.status(202).json({ id: job.rows[0].id, total: rows.length, ready: readyRows.length, status: jobStatus });
  } catch (error) { await client?.query('ROLLBACK').catch(() => {}); next(error); } finally { client?.release(); }
});

router.get('/:id', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageUsers')) return forbidden(req, res);
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const result = await pool.query(`SELECT j.*,
       (j.expires_at <= NOW()) AS expired,
       (SELECT COUNT(*) FROM user_import_rows r WHERE r.job_id=j.id AND r.status='invited')::integer AS invited_count,
      (SELECT COUNT(*) FROM user_import_rows r WHERE r.job_id=j.id AND r.status='failed')::integer AS failed_count,
      (SELECT COUNT(*) FROM user_import_rows r WHERE r.job_id=j.id AND r.status IN ('pending', 'processing'))::integer AS pending_count,
      (SELECT COUNT(*) FROM user_import_rows r WHERE r.job_id=j.id AND r.status IN ('invalid', 'duplicate'))::integer AS ignored_count
       FROM user_import_jobs j
       WHERE j.id=$1 AND ($2::boolean OR j.created_by=$3)`,
      [req.params.id, isSuperAdmin(req.user), req.user.uid]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Import job not found.', requestId: req.id });
    if (result.rows[0].expired) return res.status(410).json({ error: 'Import job expired.', requestId: req.id });
    const { expired: _expired, ...job } = result.rows[0];
    const rows = await pool.query(`SELECT row_number, name, email, job_title, contract_type, pj_due_day, phone,
      status, attempt_count, last_error, validation_errors, firebase_uid
      FROM user_import_rows WHERE job_id=$1 ORDER BY row_number`, [req.params.id]);
    res.json({ ...job, rows: rows.rows });
  } catch (error) { next(error); }
});

router.post('/:id/retry', authMiddleware, async (req, res, next) => {
  if (!can(req.user, 'manageUsers')) return forbidden(req, res);
  if (!uuid(req.params.id)) return invalid(req, res);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const job = await client.query(
      `SELECT id, status, expires_at, expires_at <= NOW() AS expired
       FROM user_import_jobs
       WHERE id = $1 AND ($2::boolean OR created_by = $3)
       FOR UPDATE`,
      [req.params.id, isSuperAdmin(req.user), req.user.uid],
    );
    if (!job.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Import job not found.', requestId: req.id });
    }
    if (job.rows[0].expired) {
      await client.query('ROLLBACK');
      return res.status(410).json({ error: 'Import job expired.', requestId: req.id });
    }
    if (job.rows[0].status !== 'completed') {
      await client.query('COMMIT');
      return res.status(202).json({ status: job.rows[0].status, retried: 0 });
    }
    const retried = await client.query(
      `UPDATE user_import_rows
       SET status = 'pending', last_error = NULL, updated_at = NOW()
       WHERE job_id = $1 AND status = 'failed' AND attempt_count < 3
         AND EXISTS (SELECT 1 FROM user_import_jobs WHERE id = $1 AND expires_at > NOW())
       RETURNING id`,
      [req.params.id],
    );
    if (!retried.rowCount) {
      await client.query('COMMIT');
      return res.status(202).json({ status: job.rows[0].status, retried: 0 });
    }
    await client.query(
      `UPDATE user_import_jobs SET status = 'queued', finished_at = NULL
       WHERE id = $1`,
      [req.params.id],
    );
    await client.query('COMMIT');
    res.status(202).json({ status: 'queued', retried: retried.rowCount });
  } catch (error) {
    await client?.query('ROLLBACK').catch(() => {});
    next(error);
  } finally { client?.release(); }
});

async function markImportReconciliationPending({ pool, row, uid, message }) {
  await pool.query(
    `UPDATE user_import_rows
     SET firebase_uid = COALESCE($2, firebase_uid), status = 'processing',
         last_error = $3, updated_at = NOW()
     WHERE id = $1 AND status IN ('pending', 'processing')`,
    [row.id, uid, message],
  ).catch(() => {});
}

async function inspectImportIdentity(client, { email, uid }) {
  const identity = await lockPendingRegistrationIdentity(client, { email, uid });
  if (identity.changed) return { state: 'indeterminate', uid: identity.registration?.firebase_uid || uid || null };
  const pending = identity.registration;
  const candidateUid = pending?.firebase_uid || uid || null;
  const localUser = (await client.query(
    `SELECT uid, email FROM users
     WHERE ($1::text IS NOT NULL AND uid = $1) OR lower(email) = lower($2)
     LIMIT 1`,
    [candidateUid, email],
  )).rows[0];
  const queuedCleanup = candidateUid
    ? (await client.query(
      'SELECT firebase_uid FROM firebase_cleanup_queue WHERE firebase_uid = $1 FOR UPDATE NOWAIT',
      [candidateUid],
    )).rows.length > 0
    : false;
  return { pending, localUser, queuedCleanup, candidateUid };
}

async function reconcileImportIdentity({ pool, row, uid, requestId }) {
  const knownUid = uid || row.firebase_uid || null;
  let client;
  let transactionOpen = false;
  let commitAttempted = false;
  let commitCompleted = false;
  let discardClient = false;
  const fallbackMessage = 'Unable to verify the invitation commit; reconciliation is pending.';
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionOpen = true;
    const updateRow = (status, rowUid, message = null) => client.query(
      `UPDATE user_import_rows
       SET firebase_uid = COALESCE($2, firebase_uid),
           status = $3,
           invited_at = CASE WHEN $3 = 'invited' THEN COALESCE(invited_at, NOW()) ELSE invited_at END,
           last_error = CASE WHEN $3 = 'invited' THEN NULL ELSE $4 END,
           updated_at = NOW()
       WHERE id = $1 AND status IN ('pending', 'processing')`,
      [row.id, rowUid, status, message],
    );
    const finish = async value => {
      commitAttempted = true;
      try {
        await client.query('COMMIT');
        commitCompleted = true;
        transactionOpen = false;
        return value;
      } catch (error) {
        transactionOpen = false;
        discardClient = true;
        throw error;
      }
    };
    const pendingResult = async (pending, message) => {
      const pendingUid = pending?.firebase_uid || knownUid;
      await updateRow('processing', pendingUid, message);
       return await finish({ state: 'pending_registration', uid: pendingUid });
    };

    let inspected = await inspectImportIdentity(client, { email: row.email, uid: knownUid });
    if (inspected.state === 'indeterminate') {
      await updateRow('processing', inspected.uid, fallbackMessage);
       return await finish(inspected);
    }
    let { pending, localUser, queuedCleanup, candidateUid } = inspected;
    if (localUser || pending || queuedCleanup) {
      const decision = decideImportIdentity({
        knownUid: candidateUid,
        email: row.email,
        pending,
        localUser,
        queuedCleanup,
        firebaseUser: null,
      });
      if (decision.state === 'invited') {
        await updateRow('invited', decision.uid);
         return await finish(decision);
      }
      if (decision.state === 'duplicate') {
        await updateRow('duplicate', decision.uid, 'Email already belongs to another local account.');
         return await finish(decision);
      }
      if (decision.state === 'pending_registration') {
         return await pendingResult(pending, 'A pending registration owns this identity; import reconciliation is waiting.');
      }
      await updateRow('processing', decision.uid, 'Firebase cleanup is pending; import will wait before retrying.');
       return await finish(decision);
    }

    let firebaseUser;
    try {
      firebaseUser = candidateUid
        ? await firebaseAuth.getUser(candidateUid).catch((error) => {
          if (error.code === 'auth/user-not-found') return null;
          throw error;
        })
        : await firebaseAuth.getUserByEmail(row.email).catch((error) => {
          if (error.code === 'auth/user-not-found') return null;
          throw error;
        });
    } catch (error) {
      await updateRow('processing', candidateUid, fallbackMessage);
      console.error(JSON.stringify({ service: 'api', event: 'invitation_identity_lookup_failed', requestId, error: error.message }));
       return await finish({ state: 'indeterminate', uid: candidateUid });
    }

    if (firebaseUser?.uid) {
      inspected = await inspectImportIdentity(client, { email: row.email, uid: firebaseUser.uid });
      if (inspected.state === 'indeterminate') {
        await updateRow('processing', inspected.uid, fallbackMessage);
         return await finish(inspected);
      }
      ({ pending, localUser, queuedCleanup, candidateUid } = inspected);
    }

    const result = decideImportIdentity({
      knownUid,
      email: row.email,
      pending,
      localUser,
      queuedCleanup,
      firebaseUser,
    });
    if (result.state === 'pending_registration') {
       return await pendingResult(pending, 'A pending registration owns this identity; import reconciliation is waiting.');
    }
    if (result.state === 'pending_cleanup') {
      await updateRow('processing', result.uid, 'Firebase cleanup is pending; import will wait before retrying.');
       return await finish(result);
    }
    if (result.state === 'duplicate') {
      await updateRow('duplicate', result.uid, 'Email already belongs to another local account.');
       return await finish(result);
    }
    await updateRow(result.state === 'reusable' || result.state === 'resolved_missing' ? 'pending' : 'processing', result.uid,
      result.state === 'indeterminate' ? 'Firebase identity requires reconciliation before retrying.' : null);
     return await finish(result);
  } catch (error) {
    if (commitAttempted && !commitCompleted) {
      discardClient = true;
      transactionOpen = false;
    } else if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch {
        discardClient = true;
        transactionOpen = false;
      }
    }
    await markImportReconciliationPending({ pool, row, uid: knownUid, message: fallbackMessage });
    console.error(JSON.stringify({ service: 'api', event: 'invitation_identity_reconcile_failed', requestId, error: error?.message }));
    return { state: 'indeterminate', uid: knownUid };
  } finally {
    if (client) {
      if (transactionOpen && !commitAttempted) await client.query('ROLLBACK').catch(() => { discardClient = true; });
      client.release(discardClient || (commitAttempted && !commitCompleted));
    }
  }
}

async function claimImportRow({ client, row }) {
  const inspected = await inspectImportIdentity(client, { email: row.email, uid: row.firebase_uid || null });
  if (inspected.state === 'indeterminate') return inspected;
  const { pending, localUser, queuedCleanup, candidateUid } = inspected;
  if (localUser || pending || queuedCleanup) {
    const decision = decideImportIdentity({
      knownUid: candidateUid,
      email: row.email,
      pending,
      localUser,
      queuedCleanup,
      firebaseUser: null,
    });
    const message = decision.state === 'pending_registration'
      ? 'A pending registration owns this identity; import reconciliation is waiting.'
      : decision.state === 'pending_cleanup'
        ? 'Firebase cleanup is pending; import will wait before retrying.'
        : decision.state === 'duplicate'
          ? 'Email already belongs to another local account.'
          : null;
    await client.query(
      `UPDATE user_import_rows
       SET firebase_uid = COALESCE($2, firebase_uid),
           status = $3,
           invited_at = CASE WHEN $3 = 'invited' THEN COALESCE(invited_at, NOW()) ELSE invited_at END,
           last_error = CASE WHEN $3 = 'invited' THEN NULL ELSE $4 END,
           updated_at = NOW()
       WHERE id = $1 AND status IN ('pending', 'processing')`,
      [row.id, decision.uid, decision.state === 'invited' ? 'invited' : decision.state === 'duplicate' ? 'duplicate' : 'processing', message],
    );
    return decision;
  }

  const attemptCountBefore = Number(row.attempt_count || 0);
  const claimResult = await client.query(
    `UPDATE user_import_rows
     SET status = 'processing', attempt_count = attempt_count + 1, last_error = NULL, updated_at = NOW()
      WHERE id = $1 AND attempt_count < 3
        AND (status = 'pending' OR (status = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes'))
      RETURNING id, attempt_count`,
    [row.id],
  );
  return claimResult.rowCount
    ? { state: 'claimed', attemptCountBefore, attemptCountAfter: Number(claimResult.rows?.[0]?.attempt_count || attemptCountBefore + 1) }
    : { state: 'lost' };
}

async function restoreImportClaim({ pool, row, uid, attemptCountBefore, attemptCountAfter, message, status = 'processing' }) {
  let client;
  let transactionOpen = false;
  let commitAttempted = false;
  let commitCompleted = false;
  let discardClient = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionOpen = true;
    const identity = await lockPendingRegistrationIdentity(client, { email: row.email, uid: uid || row.firebase_uid || null });
    if (identity.changed) return false;
    await client.query(
      `UPDATE user_import_rows
       SET firebase_uid = COALESCE($2, firebase_uid), status = $3,
           attempt_count = $4, last_error = $5, updated_at = NOW()
       WHERE id = $1 AND attempt_count = $6
         AND status IN ('pending', 'processing', 'invited')`,
      [row.id, uid, status, attemptCountBefore, message, attemptCountAfter],
    );
    commitAttempted = true;
    await client.query('COMMIT');
    commitCompleted = true;
    transactionOpen = false;
    return true;
  } catch (error) {
    if (commitAttempted && !commitCompleted) {
      discardClient = true;
      transactionOpen = false;
    } else if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch {
        discardClient = true;
        transactionOpen = false;
      }
    }
    return false;
  } finally {
    if (transactionOpen && !commitAttempted) await client.query('ROLLBACK').catch(() => { discardClient = true; });
    client?.release(discardClient || (commitAttempted && !commitCompleted));
  }
}

async function processPending(requestId = 'bulk-import') {
  const client = await pool.connect();
  let jobId;
  let candidates = [];
  let processed = 0;
  let failed = 0;
  let transactionOpen = false;
  let commitAttempted = false;
  let commitCompleted = false;
  let discardClient = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const result = await client.query(`SELECT id FROM user_import_jobs
      WHERE expires_at > NOW()
        AND (status = 'queued' OR (status = 'processing' AND started_at < NOW() - INTERVAL '10 minutes'))
       ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!result.rows[0]) {
      commitAttempted = true;
      await client.query('COMMIT');
      commitCompleted = true;
      transactionOpen = false;
      return { processed: 0, failed: 0 };
    }
    jobId = result.rows[0].id;
    await client.query(`UPDATE user_import_jobs SET status='processing', started_at=NOW() WHERE id=$1`, [jobId]);
    const rows = await client.query(`SELECT user_import_rows.* FROM user_import_rows
      WHERE job_id=$1
        AND (status = 'pending' OR (status = 'processing' AND updated_at < NOW() - INTERVAL '10 minutes'))
      ORDER BY row_number LIMIT 25`, [jobId]);
    candidates = rows.rows;
    commitAttempted = true;
    await client.query('COMMIT');
    commitCompleted = true;
    transactionOpen = false;
    for (const row of candidates) {
      const reconciliation = await reconcileImportIdentity({ pool, row, requestId });
      if (reconciliation.state === 'invited') {
        processed += 1;
        const enable = await enableActiveUser({ pool, uid: reconciliation.uid, email: row.email, requestId });
        if (enable.state !== 'active') {
          console.error(JSON.stringify({ service: 'api', event: 'firebase_enable_pending', requestId }));
        }
        continue;
      }
      if (!canClaimImportIdentity(reconciliation.state)) continue;
      if (row.attempt_count >= 3) {
        await pool.query(
          `UPDATE user_import_rows
           SET status = 'failed', last_error = COALESCE(last_error, 'Worker stopped after the maximum attempts.'), updated_at = NOW()
           WHERE id = $1 AND status IN ('pending', 'processing')`,
          [row.id],
        ).catch(() => {});
        failed += 1;
        continue;
      }
      const rowClient = await pool.connect();
      let createdUid;
      let firebaseWasCreated = false;
      let commitAttempted = false;
      let commitCompleted = false;
      let claimed = false;
      let attemptCountBefore = Number(row.attempt_count || 0);
      let attemptCountAfter = attemptCountBefore + 1;
      let discardRowClient = false;
      try {
        await rowClient.query('BEGIN');
        const claimResult = await claimImportRow({
          client: rowClient,
          row: { ...row, firebase_uid: reconciliation.uid || row.firebase_uid || null },
        });
        if (claimResult.state === 'invited') {
          commitAttempted = true;
          await rowClient.query('COMMIT');
          commitCompleted = true;
          processed += 1;
          try {
            const enable = await enableActiveUser({ pool, uid: claimResult.uid, email: row.email, requestId });
            if (enable.state !== 'active') console.error(JSON.stringify({ service: 'api', event: 'firebase_enable_pending', requestId }));
          } catch {
            console.error(JSON.stringify({ service: 'api', event: 'firebase_enable_pending', requestId }));
          }
          continue;
        }
        if (claimResult.state !== 'claimed') {
          commitAttempted = true;
          await rowClient.query('COMMIT');
          commitCompleted = true;
          continue;
        }
        claimed = true;
        attemptCountBefore = claimResult.attemptCountBefore;
        attemptCountAfter = claimResult.attemptCountAfter;
        const title = await rowClient.query('SELECT id FROM job_titles WHERE btrim(lower(name))=btrim(lower($1)) AND active=TRUE', [row.job_title]);
        if (!title.rows[0]) throw new Error('Job title is inactive or unknown.');
        const invited = await createInvitedUser({
          client: rowClient,
          data: {
            name: row.name,
            email: row.email,
            contract_type: row.contract_type,
            pj_due_day: row.pj_due_day,
            phone: row.phone,
            job_title_id: title.rows[0].id,
            role: 'viewer',
            permissions: {},
          },
          audit: async (action, targetId, details) => rowClient.query(
            `INSERT INTO audit_log (actor_uid, action,target_type,target_id,details)
             VALUES ((SELECT created_by FROM user_import_jobs WHERE id=$1),$2,'user',$3,$4::jsonb)`,
            [jobId, action, targetId, JSON.stringify({ ...details, import_job_id: jobId, source: 'bulk' })],
          ),
        });
        createdUid = invited.uid;
        firebaseWasCreated = invited.firebaseCreated === true;
        await rowClient.query(
          `UPDATE user_import_rows
           SET firebase_uid=$2, status='invited', last_error=NULL, invited_at=NOW(), updated_at=NOW()
           WHERE id=$1`,
          [row.id, invited.uid],
        );
        commitAttempted = true;
        await rowClient.query('COMMIT');
        commitCompleted = true;
        processed += 1;
        try {
          const enable = await enableActiveUser({ pool, uid: invited.uid, email: row.email, requestId });
          if (enable.state !== 'active' && !enable.skipped) {
            await restoreImportClaim({
              pool,
              row,
              uid: invited.uid,
              attemptCountBefore,
              attemptCountAfter,
              message: 'Firebase enable is pending; import will retry reconciliation.',
            });
            console.error(JSON.stringify({ service: 'api', event: 'firebase_enable_pending', requestId }));
          }
         } catch {
           console.error(JSON.stringify({ service: 'api', event: 'firebase_enable_pending', requestId }));
        }
        createdUid = null;
      } catch (error) {
        if (commitAttempted && !commitCompleted) discardRowClient = true;
        let rollbackFailed = false;
        if (!commitAttempted) {
          await rowClient.query('ROLLBACK').then(() => {}).catch(() => { rollbackFailed = true; discardRowClient = true; });
        }
        const commitStatusUnknown = (commitAttempted && !commitCompleted) || rollbackFailed;
        const cleanupUid = createdUid || error.firebaseUid || row.firebase_uid;
        if (commitStatusUnknown) {
          const reconciliation = await reconcileImportIdentity({ pool, row, uid: cleanupUid, requestId });
          if (reconciliation.state === 'invited') {
            processed += 1;
            try {
              const enable = await enableActiveUser({ pool, uid: reconciliation.uid, email: row.email, requestId });
              if (enable.state !== 'active') {
                if (claimed && !enable.skipped) {
                  await restoreImportClaim({
                    pool,
                    row,
                    uid: reconciliation.uid,
                    attemptCountBefore,
                    attemptCountAfter,
                    message: 'Firebase enable is pending; import will retry reconciliation.',
                  });
                }
                console.error(JSON.stringify({ service: 'api', event: 'firebase_enable_pending', requestId }));
              }
            } catch {
              console.error(JSON.stringify({ service: 'api', event: 'firebase_enable_pending', requestId }));
            }
          } else {
            if (claimed) {
              await restoreImportClaim({
                pool,
                row,
                uid: cleanupUid,
                attemptCountBefore,
                attemptCountAfter,
                message: 'Invitation commit is ambiguous; reconciliation is pending.',
              });
            }
            await compensateCreatedInvitedUser({
              pool,
              uid: cleanupUid,
              email: row.email,
              firebaseCreated: firebaseWasCreated || error.firebaseCreated === true,
              commitAttempted: true,
              commitCompleted: false,
              requestId,
              reason: 'bulk_invitation',
            });
          }
        } else if (claimed && (error.code === 'FIREBASE_CLEANUP_PENDING'
          || error.identityIndeterminate === true
          || error.code === 'FIREBASE_IDENTITY_INDETERMINATE'
          || error.importIdentityState === 'pending_registration'
          || error.importIdentityState === 'pending_cleanup')) {
          await restoreImportClaim({
            pool,
            row,
            uid: cleanupUid,
            attemptCountBefore,
            attemptCountAfter,
            message: error.code === 'FIREBASE_CLEANUP_PENDING'
              ? 'Firebase cleanup is pending; import will wait before retrying.'
              : 'Firebase identity requires reconciliation before retrying.',
          });
        } else if (claimed && error.importIdentityState === 'duplicate') {
          await restoreImportClaim({
            pool,
            row,
            uid: cleanupUid,
            attemptCountBefore,
            attemptCountAfter,
            status: 'duplicate',
            message: 'Email already belongs to another local account.',
          });
        } else if (claimed) {
          await compensateCreatedInvitedUser({
            pool,
            uid: cleanupUid,
            email: row.email,
            firebaseCreated: firebaseWasCreated || error.firebaseCreated === true,
            commitAttempted: false,
            commitCompleted,
            requestId,
            reason: 'bulk_invitation',
          });
          failed += 1;
          await pool.query(
           `UPDATE user_import_rows
            SET status = 'failed',
                  attempt_count = GREATEST(attempt_count, LEAST($2, 3)),
                  last_error = $3, updated_at = NOW()
             WHERE id = $1 AND status IN ('pending', 'processing')`,
            [row.id, attemptCountAfter, String(error.message || error).slice(0, 1000)],
          ).catch(() => {});
        }
      } finally { rowClient.release(discardRowClient); }
    }
    const finalJob = await pool.query(
       `UPDATE user_import_jobs
       SET status = CASE WHEN EXISTS (
         SELECT 1 FROM user_import_rows WHERE job_id = $1 AND status IN ('pending', 'processing')
       ) THEN 'queued' ELSE 'completed' END,
       finished_at = CASE WHEN NOT EXISTS (
         SELECT 1 FROM user_import_rows WHERE job_id = $1 AND status IN ('pending', 'processing')
       ) THEN NOW() ELSE NULL END
       WHERE id = $1 RETURNING status`,
      [jobId],
    );
    return { processed, failed, jobId, status: finalJob.rows[0]?.status || 'completed' };
  } catch (error) {
    if (commitAttempted && !commitCompleted) {
      discardClient = true;
      transactionOpen = false;
    } else if (transactionOpen) {
      await client.query('ROLLBACK').catch(() => { discardClient = true; });
      transactionOpen = false;
    }
    throw error;
  } finally {
    if (transactionOpen && !commitAttempted) await client.query('ROLLBACK').catch(() => { discardClient = true; });
    client.release(discardClient || (commitAttempted && !commitCompleted));
  }
}

internalRouter.post('/process', internal_authMiddleware, async (req, res, next) => {
  try { res.json(await processPending(req.id)); } catch (error) { next(error); }
});

internalRouter.post('/registrations/retention', internal_authMiddleware, async (req, res, next) => {
  try {
    const retentionDays = Number(process.env.PENDING_REGISTRATION_RETENTION_DAYS || 730);
    if (!Number.isInteger(retentionDays) || retentionDays < 30 || retentionDays > 3650) throw new Error('Invalid pending registration retention days.');
    res.json(await expirePendingRegistrations({ pool, retentionDays, requestId: req.id }));
  } catch (error) { next(error); }
});

internalRouter.post('/firebase-enables', internal_authMiddleware, async (req, res, next) => {
  try { res.json(await reconcilePendingFirebaseEnables({ pool, requestId: req.id })); } catch (error) { next(error); }
});

internalRouter.post('/firebase-cleanup', internal_authMiddleware, async (req, res, next) => {
  try { res.json(await processFirebaseCleanup({ pool, requestId: req.id })); } catch (error) { next(error); }
});

module.exports = { claimImportRow, reconcileImportIdentity, router, internalRouter, processPending };
