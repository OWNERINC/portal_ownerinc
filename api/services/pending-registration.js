const { randomBytes } = require('node:crypto');
const { firebaseAuth } = require('../middleware/auth');
const { sendRegistrationPassword, sendVerificationEmail } = require('../integrations/password-reset-email');
const { normalizeContract } = require('../middleware/validation');
const {
  cleanupFirebaseIdentity, enableActiveUser, lockFirebaseIdentity, lockPendingRegistrationIdentity,
  queueFirebaseCleanup,
} = require('./user-invitation');

let activeRegistrationOperations = 0;
// Keep Firebase/SMTP work from occupying the entire default PostgreSQL pool.
const MAX_REGISTRATION_OPERATIONS = 2;
const DEFAULT_MAX_PENDING_REGISTRATIONS_PER_HOUR = 100;
const REGISTRATION_RATE_LOCK = 7192028;

async function withRegistrationOperation(operation) {
  if (activeRegistrationOperations >= MAX_REGISTRATION_OPERATIONS) {
    throw serviceError('REGISTRATION_BUSY', 'Registration service is busy.');
  }
  activeRegistrationOperations += 1;
  try {
    return await operation();
  } finally {
    activeRegistrationOperations -= 1;
  }
}

function verificationSettings(env = process.env) {
  try {
    const baseUrl = String(env.PORTAL_PUBLIC_URL || 'https://portal.ownerinc.com.br').replace(/\/+$/, '');
    const url = new URL(`${baseUrl}/login.html`);
    if (!['http:', 'https:'].includes(url.protocol) || (env.NODE_ENV === 'production' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid public URL');
    }
    return { url: url.toString() };
  } catch {
    throw serviceError('INVALID_PUBLIC_URL', 'Portal public URL is invalid.');
  }
}

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function discardClient(result) {
  Object.defineProperty(result, 'discardClient', { value: true, enumerable: false });
  return result;
}

function maxPendingRegistrationsPerHour(env = process.env) {
  const value = Number.parseInt(env.MAX_PENDING_REGISTRATIONS_PER_HOUR || '', 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_PENDING_REGISTRATIONS_PER_HOUR;
}

function temporaryPassword() {
  return randomBytes(32).toString('hex');
}

async function cleanupPendingRegistrationUser({ pool, client, uid, email, pendingRegistrationId, requestId }) {
  const cleanup = await cleanupFirebaseIdentity({
    pool, client, uid, email, pendingRegistrationId, requestId,
  });
  if (cleanup.state === 'deleted' || cleanup.state === 'missing') return null;
  const error = cleanup.error || new Error(`Firebase identity cleanup is ${cleanup.state}.`);
  error.code = cleanup.state === 'referenced' ? 'FIREBASE_IDENTITY_REFERENCED' : 'FIREBASE_CLEANUP_PENDING';
  return error;
}

async function reconcileRejectedRegistration({ pool, id, firebaseUid, reviewerUid, reason, requestId }) {
  if (!pool?.connect) throw serviceError('REGISTRATION_RECONCILIATION_UNAVAILABLE', 'Registration reconciliation is unavailable.');
  const client = await pool.connect();
  let transactionOpen = false;
  let commitAttempted = false;
  let commitCompleted = false;
  let discardClient = false;
  try {
    try {
      await client.query('BEGIN');
      transactionOpen = true;
    } catch (error) {
      discardClient = true;
      throw error;
    }

    const identity = await lockPendingRegistrationIdentity(client, { id, uid: firebaseUid });
    if (identity.changed || (identity.registration && identity.registration.firebase_uid !== firebaseUid)) {
      throw serviceError('REGISTRATION_IDENTITY_CHANGED', 'Registration identity changed during reconciliation.');
    }

    const registration = identity.registration;
    if (registration?.status === 'pending') {
      await client.query(
        `UPDATE pending_registrations
         SET status = 'rejected', reviewed_at = COALESCE(reviewed_at, NOW()), reviewed_by = COALESCE(reviewed_by, $2),
             rejection_reason = COALESCE(rejection_reason, $3), firebase_cleanup_pending = TRUE
         WHERE id = $1 AND firebase_uid = $4 AND status = 'pending'`,
        [id, reviewerUid, reason || null, firebaseUid],
      );
      await client.query(
        `INSERT INTO audit_log (actor_uid, action, target_type, target_id, request_id, details)
         VALUES ($1, 'registration.reject', 'pending_registration', $2, $3, $4::jsonb)`,
        [reviewerUid, id, requestId, JSON.stringify({ reason: reason || null })],
      );
    } else if (registration?.status === 'rejected') {
      await client.query(
        `UPDATE pending_registrations SET firebase_cleanup_pending = TRUE
         WHERE id = $1 AND firebase_uid = $2 AND status = 'rejected'`,
        [id, firebaseUid],
      );
    }

    if (registration?.status === 'pending' || registration?.status === 'rejected') {
      await queueFirebaseCleanup({
        client,
        uid: firebaseUid,
        reason: 'registration_rejection_commit_ambiguous',
      });
    }

    commitAttempted = true;
    try {
      await client.query('COMMIT');
      commitCompleted = true;
      transactionOpen = false;
    } catch (error) {
      transactionOpen = false;
      discardClient = true;
      throw error;
    }
  } catch (error) {
    if (commitAttempted && !commitCompleted) {
      transactionOpen = false;
      discardClient = true;
    } else if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch {
        transactionOpen = false;
        discardClient = true;
      }
    }
    if (discardClient) error.discardClient = true;
    throw error;
  } finally {
    if (transactionOpen && !commitAttempted) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch {
        discardClient = true;
      }
    }
    if (discardClient) client.release(true);
    else client.release();
  }
}

async function reserveRegistrationWindow(client) {
  await client.query('SELECT pg_advisory_xact_lock($1)', [REGISTRATION_RATE_LOCK]);
  const { rows = [] } = await client.query(
    `SELECT COUNT(*)::integer AS count
     FROM pending_registrations
     WHERE created_at >= NOW() - INTERVAL '1 hour'`,
  );
  if (Number(rows[0]?.count || 0) >= maxPendingRegistrationsPerHour()) {
    throw serviceError('REGISTRATION_RATE_LIMITED', 'Registration rate limit reached.');
  }
}

async function lockRegistrationEmail(client, email) {
  await lockFirebaseIdentity(client, { email });
}

async function createPendingRegistration({ client, data, requestId }) {
  let firebaseUser;
  try {
    await lockRegistrationEmail(client, data.email);
    const { rowCount: existingUser } = await client.query(
      'SELECT 1 FROM users WHERE lower(email) = lower($1) LIMIT 1',
      [data.email],
    );
    if (existingUser) throw serviceError('REGISTRATION_ALREADY_EXISTS', 'An account already exists for this email.');
    await reserveRegistrationWindow(client);
    firebaseUser = await firebaseAuth.createUser({
      email: data.email,
      password: temporaryPassword(),
      displayName: data.name,
      emailVerified: false,
      disabled: true,
    });
    await lockFirebaseIdentity(client, { uid: firebaseUser.uid });
    await client.query(
      `INSERT INTO pending_registrations (firebase_uid, email, name)
       VALUES ($1, $2, $3)`,
      [firebaseUser.uid, data.email, data.name],
    );
    const link = await firebaseAuth.generateEmailVerificationLink(data.email, verificationSettings());
    await sendVerificationEmail({ to: data.email, name: data.name, link });
    return { uid: firebaseUser.uid };
  } catch (error) {
    if (firebaseUser?.uid) {
      error.firebaseUid = firebaseUser.uid;
    }
    throw error;
  }
}

async function requestPendingRegistrationPassword({ pool, email }) {
  let client;
  let transactionOpen = false;
  let commitAttempted = false;
  let commitCompleted = false;
  let discardClient = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionOpen = true;
    const identity = await lockPendingRegistrationIdentity(client, { email });
    const registration = identity.registration;
    if (identity.changed || !registration || registration.status !== 'pending' || registration.firebase_cleanup_pending) {
      commitAttempted = true;
      await client.query('COMMIT');
      commitCompleted = true;
      transactionOpen = false;
      return false;
    }
    const firebaseUser = await firebaseAuth.getUser(registration.firebase_uid).catch((error) => {
      if (error.code === 'auth/user-not-found') return null;
      throw error;
    });
    const { rowCount: queuedCleanup } = await client.query(
      'SELECT 1 FROM firebase_cleanup_queue WHERE firebase_uid = $1',
      [registration.firebase_uid],
    );
    if (!firebaseUser || firebaseUser.emailVerified !== true || firebaseUser.disabled !== true || queuedCleanup) {
      commitAttempted = true;
      await client.query('COMMIT');
      commitCompleted = true;
      transactionOpen = false;
      return false;
    }
    commitAttempted = true;
    await client.query('COMMIT');
    commitCompleted = true;
    transactionOpen = false;
    const link = await firebaseAuth.generatePasswordResetLink(email, { url: verificationSettings().url });
    await sendRegistrationPassword({ to: email, link });
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
    if (transactionOpen) await client.query('ROLLBACK').catch(() => { discardClient = true; });
    client?.release(discardClient || (commitAttempted && !commitCompleted));
  }
}

async function recoverPendingRegistration({ pool, data, requestId }) {
  let client;
  let createdUid;
  let committed = false;
  let commitAttempted = false;
  let rollbackAttempted = false;
  let rollbackFailed = false;
  let transactionOpen = false;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    transactionOpen = true;
    const identity = await lockPendingRegistrationIdentity(client, { email: data.email });
    if (identity.changed) return false;
    const pending = identity.registration;
    if (pending?.firebase_cleanup_pending) return false;
    const { rowCount: existingUser } = await client.query(
      `SELECT 1 FROM users
       WHERE ($1::text IS NOT NULL AND uid = $1) OR lower(email) = lower($2)
       LIMIT 1`,
      [pending?.firebase_uid || null, data.email],
    );
    if (existingUser) return false;
    const firebaseUser = pending
      ? await firebaseAuth.getUser(pending.firebase_uid).catch((error) => {
         if (error.code === 'auth/user-not-found') return null;
         throw error;
       })
       : await firebaseAuth.getUserByEmail(data.email).catch((error) => {
         if (error.code === 'auth/user-not-found') return null;
         throw error;
       });
    if (firebaseUser) {
      if (!pending) await lockFirebaseIdentity(client, { uid: firebaseUser.uid });
      const { rowCount: queuedCleanup } = await client.query(
        'SELECT 1 FROM firebase_cleanup_queue WHERE firebase_uid = $1 LIMIT 1',
        [firebaseUser.uid],
      );
      if (queuedCleanup) return false;
    }
    if (pending?.status === 'approved' && !firebaseUser) return false;
    if (firebaseUser && firebaseUser.disabled !== true) return false;

    const recentPending = pending?.status === 'pending'
      && Date.now() - new Date(pending.created_at).getTime() < 60 * 60 * 1000;
    if (recentPending && firebaseUser) {
      commitAttempted = true;
      await client.query('COMMIT');
      committed = true;
      transactionOpen = false;
      return true;
    }

    await reserveRegistrationWindow(client);

    let recoveredUser = firebaseUser;
    if (!recoveredUser) {
      recoveredUser = await firebaseAuth.createUser({
        email: data.email,
        password: temporaryPassword(),
        displayName: data.name,
        emailVerified: false,
        disabled: true,
      });
      createdUid = recoveredUser.uid;
    }
    await lockFirebaseIdentity(client, { uid: recoveredUser.uid });

    if (pending) {
      const latest = (await client.query(
        `SELECT id, firebase_uid, email, status, created_at, firebase_cleanup_pending
         FROM pending_registrations WHERE id = $1 FOR UPDATE`,
        [pending.id],
      )).rows[0];
      if (!latest || latest.id !== pending.id || latest.firebase_uid !== pending.firebase_uid || latest.email !== pending.email) return false;
      const { rowCount } = await client.query(
        `UPDATE pending_registrations
         SET firebase_uid = $1, name = $2, status = 'pending', reviewed_at = NULL,
             reviewed_by = NULL, rejection_reason = NULL, created_at = NOW()
         WHERE id = $3`,
        [recoveredUser.uid, data.name, pending.id],
      );
      if (rowCount !== 1) throw new Error('Pending registration recovery update failed.');
    } else {
      const { rowCount } = await client.query(
        `INSERT INTO pending_registrations (firebase_uid, email, name)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [recoveredUser.uid, data.email, data.name],
      );
      if (rowCount !== 1) throw new Error('Pending registration recovery insert failed.');
    }
    const link = await firebaseAuth.generateEmailVerificationLink(data.email, verificationSettings());
    await sendVerificationEmail({ to: data.email, name: data.name, link });
    commitAttempted = true;
    await client.query('COMMIT');
    committed = true;
    transactionOpen = false;
    return true;
  } catch (error) {
    if (client && !committed && !commitAttempted) {
      rollbackAttempted = true;
      await client.query('ROLLBACK').then(() => { transactionOpen = false; }).catch(() => { rollbackFailed = true; transactionOpen = false; });
    }
    if (createdUid && !commitAttempted && !rollbackFailed) {
       const cleanupError = await cleanupPendingRegistrationUser({ pool, uid: createdUid, email: data.email, requestId });
      if (cleanupError) {
        await queueFirebaseCleanup({ pool, uid: createdUid, reason: 'registration_recovery' }).catch((queueError) => {
          console.error(JSON.stringify({ service: 'api', event: 'firebase_cleanup_queue_failed', requestId, error: queueError.message }));
        });
      }
    }
    if (createdUid && (commitAttempted && !committed || rollbackFailed)) {
      await queueFirebaseCleanup({ pool, uid: createdUid, reason: 'registration_recovery_ambiguous' }).catch((queueError) => {
        console.error(JSON.stringify({ service: 'api', event: 'firebase_cleanup_queue_failed', requestId, error: queueError.message }));
      });
    }
    console.error(JSON.stringify({ service: 'api', event: 'pending_registration_recovery_failed', requestId }));
    return false;
  } finally {
    if (client && !committed && !commitAttempted && !rollbackAttempted) {
      rollbackAttempted = true;
      await client.query('ROLLBACK').then(() => { transactionOpen = false; }).catch(() => { rollbackFailed = true; transactionOpen = false; });
    }
    client?.release(rollbackFailed || (commitAttempted && !committed));
  }
}

async function expirePendingRegistrations({ pool, retentionDays = 730, requestId }) {
  const client = await pool.connect();
  let deleted = 0;
  let failed = 0;
  let discardClient = false;
  const queueRetry = (uid, reason) => uid && queueFirebaseCleanup({ pool, uid, reason }).catch((error) => {
    console.error(JSON.stringify({ service: 'api', event: 'firebase_cleanup_queue_failed', requestId, error: error.message }));
  });
  try {
    const { rows: candidates } = await client.query(
      `SELECT id, firebase_uid, email, status, created_at::text AS created_at_key
       FROM pending_registrations
       WHERE status IN ('pending', 'approved', 'rejected')
         AND (firebase_cleanup_pending = TRUE OR CASE WHEN status = 'approved'
           THEN COALESCE(reviewed_at, created_at) ELSE created_at END
           < NOW() - ($1::integer * INTERVAL '1 day'))
       ORDER BY created_at
       LIMIT 100`,
      [retentionDays],
    );
    for (const candidate of candidates) {
      let transactionOpen = false;
      let commitAttempted = false;
      let commitCompleted = false;
      let rollbackAttempted = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;
        const identity = await lockPendingRegistrationIdentity(client, {
          id: candidate.id,
          email: candidate.email,
          uid: candidate.firebase_uid,
        });
        const registration = identity.registration;
        if (identity.changed || !registration) {
          commitAttempted = true;
          await client.query('COMMIT');
          commitCompleted = true;
          transactionOpen = false;
          continue;
        }
        const eligible = await client.query(
          `SELECT 1 FROM pending_registrations
           WHERE id = $1
             AND status IN ('pending', 'approved', 'rejected')
             AND (firebase_cleanup_pending = TRUE OR CASE WHEN status = 'approved'
               THEN COALESCE(reviewed_at, created_at) ELSE created_at END
               < NOW() - ($2::integer * INTERVAL '1 day'))`,
          [registration.id, retentionDays],
        );
        if (!eligible.rowCount) {
          commitAttempted = true;
          await client.query('COMMIT');
          commitCompleted = true;
          transactionOpen = false;
          continue;
        }
        await client.query(
          'UPDATE pending_registrations SET firebase_cleanup_pending = TRUE WHERE id = $1',
          [registration.id],
        );
        if (registration.status !== 'approved') {
          const cleanup = await cleanupFirebaseIdentity({
            client,
            uid: registration.firebase_uid,
            email: registration.email,
            pendingRegistrationId: registration.id,
            requestId,
            transactionAlreadyOpen: true,
            identityAlreadyLocked: true,
            pendingRegistrationLocked: true,
          });
          if (!['deleted', 'missing'].includes(cleanup.state)) {
            failed += 1;
            commitAttempted = true;
            await client.query('COMMIT');
            commitCompleted = true;
            transactionOpen = false;
            continue;
          }
        }
        const result = await client.query(
          `DELETE FROM pending_registrations
           WHERE id = $1 AND firebase_uid = $2 AND status = $3
             AND created_at = $4::timestamptz AND firebase_cleanup_pending = TRUE`,
          [registration.id, registration.firebase_uid, registration.status, registration.created_at],
        );
        commitAttempted = true;
        await client.query('COMMIT');
        commitCompleted = true;
        transactionOpen = false;
        deleted += result.rowCount;
      } catch (error) {
        if (commitAttempted && !commitCompleted) {
          transactionOpen = false;
          discardClient = true;
          await queueRetry(candidate.firebase_uid, 'registration_retention_commit_ambiguous');
          failed += 1;
          break;
        }
        if (transactionOpen && !rollbackAttempted) {
          rollbackAttempted = true;
          try {
            await client.query('ROLLBACK');
            transactionOpen = false;
          } catch (rollbackError) {
            transactionOpen = false;
            discardClient = true;
            await queueRetry(candidate.firebase_uid, 'registration_retention_rollback_ambiguous');
            console.error(JSON.stringify({ service: 'api', event: 'pending_registration_retention_rollback_ambiguous', requestId, error: rollbackError.message }));
            failed += 1;
            break;
          }
        }
        failed += 1;
        console.error(JSON.stringify({ service: 'api', event: 'pending_registration_retention_cleanup_failed', requestId, error: error.message }));
      }
    }
    return { deleted, failed };
  } catch (error) {
    if (!discardClient) await client.query('ROLLBACK').catch(() => { discardClient = true; });
    throw error;
  } finally {
    client.release(discardClient);
  }
}

async function approvePendingRegistration({ client, pool, id, jobTitleId, contractType, pjDueDay, reviewerUid, requestId }) {
  const contract = normalizeContract(contractType, pjDueDay);
  if (!contract) throw serviceError('INVALID_CONTRACT', 'Employment contract is invalid.');
  let commitAttempted = false;
  let commitCompleted = false;
  try {
    await client.query('BEGIN');
    const identity = await lockPendingRegistrationIdentity(client, { id });
    const registration = identity.registration;
    if (!registration) throw serviceError('REGISTRATION_NOT_FOUND', 'Registration not found.');
    if (identity.changed) throw serviceError('REGISTRATION_IDENTITY_CHANGED', 'Registration identity changed during review.');
    if (registration.status !== 'pending') throw serviceError('REGISTRATION_ALREADY_REVIEWED', 'Registration was already reviewed.');
    if (registration.firebase_cleanup_pending) throw serviceError('REGISTRATION_RETENTION_PENDING', 'Registration is pending retention cleanup.');

    const { rowCount: titleCount } = await client.query(
      'SELECT 1 FROM job_titles WHERE id = $1 AND active = TRUE',
      [jobTitleId],
    );
    if (!titleCount) throw serviceError('INVALID_JOB_TITLE', 'Job title is not active.');

    const firebaseUser = await firebaseAuth.getUser(registration.firebase_uid).catch((error) => {
      if (error.code === 'auth/user-not-found') throw serviceError('REGISTRATION_IDENTITY_MISSING', 'Registration identity is missing.');
      throw error;
    });
    if (firebaseUser.emailVerified !== true) throw serviceError('EMAIL_NOT_VERIFIED', 'Email is not verified.');

    const { rowCount: existingUser } = await client.query(
       'SELECT 1 FROM users WHERE uid = $1 OR lower(email) = lower($2) LIMIT 1',
      [registration.firebase_uid, registration.email],
    );
    if (existingUser) throw serviceError('USER_ALREADY_EXISTS', 'User already exists.');

    await client.query(
       `INSERT INTO users (uid, email, name, role, contract_type, is_pj, pj_due_day, job_title_id, phone, permissions, firebase_enable_pending)
         VALUES ($1, $2, $3, 'viewer', $4, $5, $6, $7, '', '{}'::jsonb, TRUE)`,
       [registration.firebase_uid, registration.email, registration.name, contract.contract_type, contract.is_pj, contract.pj_due_day, jobTitleId],
    );
    await client.query(
      `UPDATE pending_registrations
       SET status = 'approved', reviewed_at = NOW(), reviewed_by = $2
       WHERE id = $1`,
      [id, reviewerUid],
    );
    await client.query(
      `INSERT INTO audit_log (actor_uid, action, target_type, target_id, request_id, details)
       VALUES ($1, 'registration.approve', 'pending_registration', $2, $3, $4::jsonb)`,
      [reviewerUid, id, requestId, JSON.stringify({
        job_title_id: jobTitleId,
        contract_type: contract.contract_type,
        is_pj: contract.is_pj,
        pj_due_day: contract.pj_due_day,
      })],
    );
    commitAttempted = true;
    await client.query('COMMIT');
    commitCompleted = true;
    const enable = await enableActiveUser({ client, pool, uid: registration.firebase_uid, email: registration.email, requestId });
    if (enable.state === 'active') return { status: 'approved', state: 'active' };
    const result = { status: 'approved_pending_enable', state: 'enable_pending' };
    return enable.discardClient ? discardClient(result) : result;
  } catch (error) {
    if (!commitAttempted) {
      await client.query('ROLLBACK').catch(() => { error.discardClient = true; });
    }
    if (commitAttempted && !commitCompleted) {
      console.error(JSON.stringify({ service: 'api', event: 'registration_approval_commit_ambiguous', requestId }));
      return discardClient({ status: 'approval_pending_reconcile', state: 'enable_pending' });
    }
    throw error;
  }
}

async function rejectPendingRegistration({ client, pool, id, reviewerUid, reason, requestId }) {
  let firebaseUid;
  let transactionOpen = false;
  let commitAttempted = false;
  let commitCompleted = false;
  try {
    try {
      await client.query('BEGIN');
      transactionOpen = true;
    } catch (error) {
      error.discardClient = true;
      throw error;
    }
    const identity = await lockPendingRegistrationIdentity(client, { id });
    const registration = identity.registration;
    if (!registration) throw serviceError('REGISTRATION_NOT_FOUND', 'Registration not found.');
    if (identity.changed) throw serviceError('REGISTRATION_IDENTITY_CHANGED', 'Registration identity changed during review.');
    if (registration.status !== 'pending') throw serviceError('REGISTRATION_ALREADY_REVIEWED', 'Registration was already reviewed.');
    if (registration.firebase_cleanup_pending) throw serviceError('REGISTRATION_RETENTION_PENDING', 'Registration is pending retention cleanup.');

    const { rowCount: existingUser } = await client.query(
      'SELECT 1 FROM users WHERE uid = $1 OR lower(email) = lower($2) LIMIT 1',
      [registration.firebase_uid, registration.email],
    );
    if (existingUser) throw serviceError('USER_ALREADY_EXISTS', 'User already exists.');

    firebaseUid = registration.firebase_uid;
    await client.query(
       `UPDATE pending_registrations
        SET status = 'rejected', reviewed_at = NOW(), reviewed_by = $2, rejection_reason = $3,
            firebase_cleanup_pending = TRUE
        WHERE id = $1`,
      [id, reviewerUid, reason || null],
    );
    await client.query(
      `INSERT INTO audit_log (actor_uid, action, target_type, target_id, request_id, details)
       VALUES ($1, 'registration.reject', 'pending_registration', $2, $3, $4::jsonb)`,
      [reviewerUid, id, requestId, JSON.stringify({ reason: reason || null })],
    );
    commitAttempted = true;
    try {
      await client.query('COMMIT');
      commitCompleted = true;
      transactionOpen = false;
    } catch (error) {
      transactionOpen = false;
      throw error;
    }

    const cleanupError = await cleanupPendingRegistrationUser({
      pool,
      client,
      uid: firebaseUid,
      email: registration.email,
      pendingRegistrationId: id,
      requestId,
    });
    if (cleanupError) {
      console.error(JSON.stringify({ service: 'api', event: 'pending_registration_cleanup_failed', requestId }));
      const result = { status: 'rejected', state: 'cleanup_pending' };
      return cleanupError.discardClient ? discardClient(result) : result;
    }
    await client.query(
      `DELETE FROM pending_registrations
       WHERE id = $1 AND firebase_uid = $2 AND status = 'rejected' AND firebase_cleanup_pending = TRUE`,
      [id, firebaseUid],
    );
    return { status: 'rejected', state: 'rejected' };
  } catch (error) {
    if (commitAttempted && !commitCompleted) {
      console.error(JSON.stringify({ service: 'api', event: 'registration_rejection_commit_ambiguous', requestId }));
      try {
        await reconcileRejectedRegistration({
          pool, id, firebaseUid, reviewerUid, reason, requestId,
        });
      } catch (reconciliationError) {
        reconciliationError.discardClient = true;
        throw reconciliationError;
      }
      return discardClient({ status: 'rejection_pending_reconcile', state: 'cleanup_pending' });
    }
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch {
        transactionOpen = false;
        error.discardClient = true;
      }
    }
    throw error;
  }
}

module.exports = {
  approvePendingRegistration,
  createPendingRegistration,
  cleanupPendingRegistrationUser,
  expirePendingRegistrations,
  recoverPendingRegistration,
  requestPendingRegistrationPassword,
  rejectPendingRegistration,
  verificationSettings,
  withRegistrationOperation,
};
