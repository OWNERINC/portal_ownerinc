const crypto = require('node:crypto');
const { firebaseAuth } = require('../middleware/auth');
const { portalLoginUrl, sendInvitation, smtpAcceptanceAuditDetails } = require('../integrations/password-reset-email');
const { normalizeContract } = require('../middleware/validation');

function identityLockValues({ email, uid, uids } = {}) {
  const values = [
    email && `email:${String(email).trim().toLowerCase()}`,
    ...(Array.isArray(uids) ? uids : [uid]).map(value => value && `uid:${String(value).trim()}`),
  ];
  return [...new Set(values.filter(Boolean))].sort();
}

async function lockFirebaseIdentity(client, identity) {
  for (const value of identityLockValues(identity)) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`firebase-identity:${value}`]);
  }
}

function pendingRegistrationQuery(forUpdate = false) {
  return `SELECT id, firebase_uid, email, name, status, created_at, firebase_cleanup_pending
          FROM pending_registrations
          WHERE ($1::uuid IS NOT NULL AND id = $1::uuid)
             OR ($2::text IS NOT NULL AND firebase_uid = $2)
             OR ($3::text IS NOT NULL AND lower(email) = lower($3))
          ORDER BY CASE WHEN $1::uuid IS NOT NULL AND id = $1::uuid THEN 0
                        WHEN $2::text IS NOT NULL AND firebase_uid = $2 THEN 1 ELSE 2 END,
                   created_at DESC
          LIMIT 1${forUpdate ? ' FOR UPDATE NOWAIT' : ''}`;
}

function samePendingIdentity(left, right) {
  return left?.id === right?.id
    && left?.firebase_uid === right?.firebase_uid
    && String(left?.email || '').toLowerCase() === String(right?.email || '').toLowerCase();
}

// Email serializes the row lookup; a pending row then contributes its UID lock.
async function lockPendingRegistrationIdentity(client, { id = null, email = null, uid = null } = {}) {
  let candidate;
  let lockedEmail = email ? String(email).trim().toLowerCase() : null;
  if (lockedEmail) {
    await lockFirebaseIdentity(client, { email: lockedEmail });
  } else {
    candidate = (await client.query(pendingRegistrationQuery(), [id, uid, null])).rows[0];
    lockedEmail = candidate?.email?.trim().toLowerCase() || null;
    if (lockedEmail) await lockFirebaseIdentity(client, { email: lockedEmail });
  }

  candidate = (await client.query(pendingRegistrationQuery(), [id, uid, lockedEmail])).rows[0];
  if (!candidate) {
    if (uid) await lockFirebaseIdentity(client, { uid });
    return { registration: null, email: lockedEmail, uid };
  }

  const locked = (await client.query(
    `SELECT id, firebase_uid, email, name, status, created_at, firebase_cleanup_pending
     FROM pending_registrations WHERE id = $1 FOR UPDATE NOWAIT`,
    [candidate.id],
  )).rows[0];
  if (!locked || !samePendingIdentity(candidate, locked)) return { changed: true, registration: locked || candidate };

  await lockFirebaseIdentity(client, { uids: [uid, locked.firebase_uid] });
  const reread = (await client.query(
    `SELECT id, firebase_uid, email, name, status, created_at, firebase_cleanup_pending
     FROM pending_registrations WHERE id = $1 FOR UPDATE NOWAIT`,
    [locked.id],
  )).rows[0];
  if (!reread || !samePendingIdentity(locked, reread)) return { changed: true, registration: reread || locked };
  return { registration: reread, email: reread.email, uid: reread.firebase_uid };
}

async function lookupFirebaseUser(uid) {
  try {
    return await firebaseAuth.getUser(uid);
  } catch (error) {
    if (error.code === 'auth/user-not-found') return null;
    throw error;
  }
}

async function cleanupFirebaseIdentity({
  pool,
  client: providedClient,
  uid,
  email,
  pendingRegistrationId = null,
  requestId,
  deleteExternal = true,
  transactionAlreadyOpen = false,
  identityAlreadyLocked = false,
  pendingRegistrationLocked = false,
}) {
  if ((!pool && !providedClient) || !uid) return { state: 'invalid' };

  const client = providedClient || await pool.connect();
  const ownsClient = !providedClient;
  let transactionOpen = transactionAlreadyOpen;
  let commitAttempted = false;
  let commitCompleted = false;
  let rollbackAttempted = false;
  let discardClient = false;

  const commit = async () => {
    if (transactionAlreadyOpen) return;
    commitAttempted = true;
    try {
      await client.query('COMMIT');
      commitCompleted = true;
      transactionOpen = false;
    } catch (error) {
      transactionOpen = false;
      discardClient = true;
      error.discardClient = true;
      throw error;
    }
  };

  try {
    if (!transactionAlreadyOpen) {
      await client.query('BEGIN');
      transactionOpen = true;
    }

    let effectiveEmail = email ? String(email).trim().toLowerCase() : null;
    if (!effectiveEmail && !pendingRegistrationLocked) {
      const localIdentity = await client.query(
        `SELECT email FROM pending_registrations WHERE id = $1::uuid OR firebase_uid = $2
         UNION ALL
         SELECT email FROM users WHERE uid = $2
         LIMIT 1`,
        [pendingRegistrationId, uid],
      );
      effectiveEmail = localIdentity.rows[0]?.email?.trim().toLowerCase() || null;
    }

    let pendingIdentity;
    if (!pendingRegistrationLocked && !identityAlreadyLocked) {
      const identity = await lockPendingRegistrationIdentity(client, {
        id: pendingRegistrationId,
        email: effectiveEmail,
        uid,
      });
      if (identity.changed) {
        await commit();
        return { state: 'indeterminate' };
      }
      pendingIdentity = identity.registration;
      effectiveEmail = pendingIdentity?.email || identity.email || effectiveEmail;
      if (pendingIdentity && pendingIdentity.firebase_uid !== uid) {
        await commit();
        return { state: 'indeterminate' };
      }
    }

    let firebaseUser;
    try {
      firebaseUser = await lookupFirebaseUser(uid);
    } catch (error) {
      console.error(JSON.stringify({ service: 'api', event: 'firebase_cleanup_lookup_failed', requestId, error: error.message }));
      await commit();
      return { state: 'indeterminate', error };
    }

    if (!effectiveEmail && firebaseUser?.email && !transactionAlreadyOpen) {
      // UID-only queue entries discover email in Firebase; restart before taking the email lock.
      await client.query('ROLLBACK');
      transactionOpen = false;
      await client.query('BEGIN');
      transactionOpen = true;
      const identity = await lockPendingRegistrationIdentity(client, { email: firebaseUser.email, uid });
      if (identity.changed) {
        await commit();
        return { state: 'indeterminate' };
      }
      pendingIdentity = identity.registration;
      effectiveEmail = pendingIdentity?.email || identity.email || firebaseUser.email.toLowerCase();
      if (pendingIdentity && pendingIdentity.firebase_uid !== uid) {
        await commit();
        return { state: 'indeterminate' };
      }
      firebaseUser = await lookupFirebaseUser(uid);
    }

    if (firebaseUser?.email && effectiveEmail && firebaseUser.email.toLowerCase() !== effectiveEmail) {
      await commit();
      return { state: 'indeterminate' };
    }

    const users = await client.query(
      'SELECT uid, email FROM users WHERE uid = $1',
      [uid],
    );
    const registrations = await client.query(
      `SELECT id, firebase_uid, email FROM pending_registrations
       WHERE firebase_uid = $1
         AND ($2::uuid IS NULL OR id <> $2::uuid)`,
      [uid, pendingRegistrationId],
    );
    await client.query(
      'SELECT firebase_uid FROM firebase_cleanup_queue WHERE firebase_uid = $1 FOR UPDATE NOWAIT',
      [uid],
    );

    let hasReference = users.rows.length > 0
      || registrations.rows.length > 0
      || Boolean(pendingIdentity && pendingIdentity.id !== pendingRegistrationId);

    if (hasReference || !deleteExternal || !firebaseUser) {
      await client.query('DELETE FROM firebase_cleanup_queue WHERE firebase_uid = $1', [uid]);
      await commit();
      return {
        state: hasReference ? 'referenced' : !firebaseUser ? 'missing' : 'preserved',
        queueRemoved: true,
      };
    }

    const deletionError = await firebaseAuth.deleteUser(uid).catch((error) => error);
    if (deletionError && deletionError.code !== 'auth/user-not-found') {
      await firebaseAuth.updateUser(uid, { disabled: true }).catch(() => {});
      await client.query(
        `INSERT INTO firebase_cleanup_queue (firebase_uid, reason)
         VALUES ($1, $2)
         ON CONFLICT (firebase_uid) DO UPDATE SET reason = EXCLUDED.reason`,
        [uid, String(`cleanup:${requestId || 'unknown'}`).slice(0, 120)],
      ).catch(() => {});
      await client.query(
        'UPDATE firebase_cleanup_queue SET last_error = $2 WHERE firebase_uid = $1',
        [uid, String(deletionError.message || deletionError).slice(0, 1000)],
      ).catch(() => {});
      await commit();
      return { state: 'failed', error: deletionError };
    }

    await client.query('DELETE FROM firebase_cleanup_queue WHERE firebase_uid = $1', [uid]);
    await commit();
    return { state: deletionError ? 'missing' : 'deleted', queueRemoved: true };
  } catch (error) {
    if (!transactionAlreadyOpen && transactionOpen && !commitAttempted) {
      rollbackAttempted = true;
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch (rollbackError) {
        transactionOpen = false;
        discardClient = true;
        error.discardClient = true;
        console.error(JSON.stringify({ service: 'api', event: 'firebase_cleanup_rollback_ambiguous', requestId, error: rollbackError.message }));
      }
    }
    if (!transactionAlreadyOpen && commitAttempted && !commitCompleted) discardClient = true;
    throw error;
  } finally {
    if (!transactionAlreadyOpen && transactionOpen && !rollbackAttempted && !commitAttempted) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch {
        discardClient = true;
      }
    }
    if (ownsClient) client.release(discardClient || (commitAttempted && !commitCompleted));
  }
}

function accountDisabled(permissions) {
  return permissions?.accountDisabled === true || permissions?.accountDisabled === 'true';
}

async function keepFirebaseEnablePending({ pool, client, uid, requestId }) {
  const query = pool?.query?.bind(pool) || client?.query?.bind(client);
  if (!query) return false;
  try {
    await query(
      `UPDATE users SET firebase_enable_pending = TRUE WHERE uid = $1`,
      [uid],
    );
    return true;
  } catch (error) {
    console.error(JSON.stringify({ service: 'api', event: 'firebase_enable_pending_persist_failed', requestId, error: error.message }));
    return false;
  }
}

async function enableActiveUser({ pool, client: providedClient, uid, email, requestId }) {
  let client = providedClient;
  let ownsClient = false;
  let transactionOpen = false;
  let discardClient = false;
  let firebaseEnabled = false;
  let commitAttempted = false;
  let commitCompleted = false;
  let rollbackAttempted = false;
  const pendingResult = () => {
    const result = { state: 'enable_pending' };
    if (discardClient) Object.defineProperty(result, 'discardClient', { value: true, enumerable: false });
    return result;
  };
  const finish = async result => {
    commitAttempted = true;
    try {
      await client.query('COMMIT');
      commitCompleted = true;
      transactionOpen = false;
      return result;
    } catch (error) {
      transactionOpen = false;
      discardClient = true;
      throw error;
    }
  };
  try {
    if (!client) {
      client = await pool.connect();
      ownsClient = true;
    }
    let knownEmail = email ? String(email).trim().toLowerCase() : null;
    if (!knownEmail) {
      const identity = await client.query('SELECT email FROM users WHERE uid = $1', [uid]);
      knownEmail = identity.rows[0]?.email?.trim().toLowerCase() || null;
    }
    await client.query('BEGIN');
    transactionOpen = true;
    if (knownEmail) await lockFirebaseIdentity(client, { email: knownEmail });
    else await lockFirebaseIdentity(client, { uid });
    const { rows } = await client.query(
      `SELECT uid, email, permissions, firebase_enable_pending
       FROM users WHERE uid = $1 FOR UPDATE`,
      [uid],
    );
    const user = rows[0];
    if (!user) {
       return await finish({ state: 'missing' });
    }
    if (knownEmail && user.email && user.email.toLowerCase() !== knownEmail) return await finish({ state: 'enable_pending' });
    await lockFirebaseIdentity(client, { uid: user.uid });
    const reread = (await client.query(
      `SELECT uid, email, permissions, firebase_enable_pending
       FROM users WHERE uid = $1 FOR UPDATE`,
      [uid],
    )).rows[0];
    if (!reread || reread.uid !== user.uid || (reread.email || '').toLowerCase() !== (user.email || '').toLowerCase()) {
      return await finish({ state: 'enable_pending' });
    }
    const currentUser = reread;
    if (accountDisabled(currentUser.permissions)) {
      return await finish({ state: 'enable_pending', skipped: true, reason: 'account_disabled' });
    }
    if (currentUser.firebase_enable_pending !== true) {
      return await finish({ state: 'active', alreadyResolved: true });
    }

    try {
      await firebaseAuth.updateUser(uid, { disabled: false });
      firebaseEnabled = true;
    } catch (error) {
      rollbackAttempted = true;
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch {
        discardClient = true;
        transactionOpen = false;
      }
      console.error(JSON.stringify({ service: 'api', event: 'firebase_enable_failed', requestId, error: error.message }));
      return pendingResult();
    }

    const updated = await client.query(
      `UPDATE users SET firebase_enable_pending = FALSE
       WHERE uid = $1 AND permissions->>'accountDisabled' IS DISTINCT FROM 'true'
       RETURNING uid`,
      [uid],
    );
    if (updated.rowCount !== 1) throw new Error('User became disabled during Firebase enable.');

    return await finish({ state: 'active' });
  } catch (error) {
    if (commitAttempted && !commitCompleted) {
      discardClient = true;
      transactionOpen = false;
    } else if (transactionOpen && !rollbackAttempted) {
      rollbackAttempted = true;
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch {
        discardClient = true;
        transactionOpen = false;
      }
    }
    if (firebaseEnabled) {
      await keepFirebaseEnablePending({ pool, client: discardClient ? null : client, uid, requestId });
      await firebaseAuth.updateUser(uid, { disabled: true }).catch((cleanupError) => {
        console.error(JSON.stringify({ service: 'api', event: 'firebase_enable_compensation_failed', requestId, error: cleanupError.message }));
      });
    }
    console.error(JSON.stringify({
      service: 'api',
      event: commitAttempted ? 'firebase_enable_commit_ambiguous' : 'firebase_enable_pending',
      requestId,
      error: error.message,
    }));
    return pendingResult();
  } finally {
    if (transactionOpen && !rollbackAttempted && !commitAttempted) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch {
        discardClient = true;
      }
    }
    if (ownsClient) client.release(discardClient || (commitAttempted && !commitCompleted));
  }
}

async function queueFirebaseCleanup({ pool, client, uid, reason = 'compensation' }) {
  const query = client?.query?.bind(client) || pool?.query?.bind(pool);
  if (!query) throw new Error('A database connection is required to queue Firebase cleanup.');
  await query(
    `INSERT INTO firebase_cleanup_queue (firebase_uid, reason)
     VALUES ($1, $2)
     ON CONFLICT (firebase_uid) DO UPDATE
     SET reason = EXCLUDED.reason, last_error = NULL`,
    [uid, String(reason).slice(0, 120)],
  );
}

async function compensateCreatedInvitedUser({
  pool, uid, email, firebaseCreated, commitAttempted = false, commitCompleted = false, requestId, reason = 'invitation',
}) {
  if (!uid || !firebaseCreated) return;
  const queue = (queueReason) => queueFirebaseCleanup({ pool, uid, reason: queueReason }).catch((error) => {
    console.error(JSON.stringify({ service: 'api', event: 'firebase_cleanup_queue_failed', requestId, error: error.message }));
  });

  if (commitAttempted && !commitCompleted) {
    await queue(`${reason}_commit_ambiguous`);
    return;
  }

  let cleanup;
  try {
    cleanup = await cleanupFirebaseIdentity({ pool, uid, email, requestId });
  } catch (error) {
    await queue(`${reason}_database_ambiguous`);
    console.error(JSON.stringify({ service: 'api', event: 'firebase_cleanup_failed', requestId, error: error.message }));
    return;
  }
  if (cleanup.state === 'indeterminate' || cleanup.state === 'failed') {
    await queue(reason);
    console.error(JSON.stringify({ service: 'api', event: 'invitation_cleanup_failed', requestId }));
  }
}

async function processFirebaseCleanup({ pool, requestId, limit = 25 }) {
  const client = await pool.connect();
  let deleted = 0;
  let failed = 0;
  let transactionOpen = false;
  let commitAttempted = false;
  let commitCompleted = false;
  let discardClient = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const { rows } = await client.query(
      `SELECT firebase_uid, reason FROM firebase_cleanup_queue
       WHERE last_attempt_at IS NULL OR last_attempt_at < NOW() - INTERVAL '5 minutes'
       ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    for (const row of rows) {
      await client.query(
        `UPDATE firebase_cleanup_queue
         SET last_attempt_at = NOW(), attempts = attempts + 1
         WHERE firebase_uid = $1`,
        [row.firebase_uid],
      );
    }
    commitAttempted = true;
    await client.query('COMMIT');
    commitCompleted = true;
    transactionOpen = false;
    for (const row of rows) {
      try {
        const cleanup = await cleanupFirebaseIdentity({
          pool,
          uid: row.firebase_uid,
          requestId,
          deleteExternal: !/reused/i.test(row.reason || ''),
        });
        if (cleanup.state === 'failed' || cleanup.state === 'indeterminate') {
          failed += 1;
          continue;
        }
        if (cleanup.queueRemoved) deleted += 1;
      } catch (error) {
        await pool.query(
          'UPDATE firebase_cleanup_queue SET last_error = $2 WHERE firebase_uid = $1',
          [row.firebase_uid, String(error.message || error).slice(0, 1000)],
        ).catch(() => {});
        failed += 1;
        console.error(JSON.stringify({ service: 'api', event: 'firebase_cleanup_queue_failed', requestId }));
      }
    }
    return { deleted, failed };
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
    throw error;
  } finally {
    if (transactionOpen && !commitAttempted) await client.query('ROLLBACK').catch(() => { discardClient = true; });
    client.release(discardClient || (commitAttempted && !commitCompleted));
  }
}

function isAmbiguousFirebaseCreateError(error) {
  return error?.ambiguous === true
    || !error?.code
    || ['auth/internal-error', 'auth/network-request-failed', 'auth/service-unavailable', 'auth/quota-exceeded', 'auth/too-many-requests'].includes(error.code)
    || /^(ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket)/i.test(error.code);
}

function indeterminateInvitationError(cause, uid) {
  const error = new Error('Unable to determine the Firebase invitation identity; retry is pending.');
  error.code = 'FIREBASE_IDENTITY_INDETERMINATE';
  error.identityIndeterminate = true;
  error.firebaseIdentityState = 'indeterminate';
  if (uid) error.firebaseUid = uid;
  error.cause = cause;
  return error;
}

async function resolveExistingFirebaseIdentity({ client, data, cause, ambiguous = false }) {
  let existing;
  try {
    existing = await firebaseAuth.getUserByEmail(data.email);
  } catch (lookupError) {
    throw indeterminateInvitationError(lookupError, null);
  }
  if (!existing?.uid) throw indeterminateInvitationError(cause, null);

  const identity = await lockPendingRegistrationIdentity(client, { email: data.email, uid: existing.uid });
  if (identity.changed) throw indeterminateInvitationError(cause, existing.uid);
  const pending = identity.registration;
  const localUser = await client.query(
    `SELECT uid, email FROM users
     WHERE uid = $1 OR lower(email) = lower($2)`,
    [existing.uid, data.email],
  );
  const queuedCleanup = await client.query(
    'SELECT firebase_uid FROM firebase_cleanup_queue WHERE firebase_uid = $1 FOR UPDATE NOWAIT',
    [existing.uid],
  );
  if (localUser.rows[0]) {
    const error = new Error('Account already exists.');
    error.code = 'auth/email-already-exists';
    error.importIdentityState = 'duplicate';
    error.firebaseUid = localUser.rows[0].uid;
    throw error;
  }
  if (pending && (pending.status === 'pending' || pending.status === 'approved' || pending.firebase_cleanup_pending)) {
    const error = new Error('A pending registration owns this identity.');
    error.code = 'FIREBASE_IDENTITY_REFERENCED';
    error.importIdentityState = 'pending_registration';
    error.firebaseUid = pending.firebase_uid;
    throw error;
  }
  if (queuedCleanup.rows.length) {
    const error = new Error('Firebase cleanup is pending for this identity.');
    error.code = 'FIREBASE_CLEANUP_PENDING';
    error.importIdentityState = 'pending_cleanup';
    error.firebaseUid = existing.uid;
    throw error;
  }
  if (existing.email?.toLowerCase() !== data.email.toLowerCase()
    || existing.disabled !== true || existing.emailVerified !== true) {
    if (ambiguous) throw indeterminateInvitationError(cause, existing.uid);
    const error = new Error('Account already exists.');
    error.code = 'auth/email-already-exists';
    error.importIdentityState = 'duplicate';
    error.firebaseUid = existing.uid;
    throw error;
  }
  return existing;
}

async function createInvitedUser({ client, data, audit }) {
  const contract = normalizeContract(data.contract_type === undefined ? 'clt' : data.contract_type, data.pj_due_day);
  if (!contract) {
    const error = new Error('Invalid employment contract.');
    error.code = 'INVALID_CONTRACT';
    throw error;
  }
  let firebaseUser;
  let createdFirebaseUser = false;
  try {
    await lockFirebaseIdentity(client, { email: data.email });
    const localUser = (await client.query(
      'SELECT uid FROM users WHERE lower(email) = lower($1) LIMIT 1',
      [data.email],
    )).rows[0];
    if (localUser) {
      const error = new Error('Account already exists.');
      error.code = 'auth/email-already-exists';
      error.importIdentityState = 'duplicate';
      error.firebaseUid = localUser.uid;
      throw error;
    }
    firebaseUser = await firebaseAuth.createUser({
      email: data.email, password: crypto.randomBytes(32).toString('base64url'),
      displayName: data.name || undefined, emailVerified: true, disabled: true,
    });
    createdFirebaseUser = true;
  } catch (error) {
    if (error.importIdentityState === 'duplicate') throw error;
    if (error.code !== 'auth/email-already-exists' && !isAmbiguousFirebaseCreateError(error)) throw error;
    try {
      firebaseUser = await resolveExistingFirebaseIdentity({
        client, data, cause: error, ambiguous: error.code !== 'auth/email-already-exists',
      });
    } catch (reconciliationError) {
      if (reconciliationError.importIdentityState || reconciliationError.identityIndeterminate === true) throw reconciliationError;
      throw indeterminateInvitationError(reconciliationError, reconciliationError.firebaseUid);
    }
  }
  await lockFirebaseIdentity(client, { uid: firebaseUser.uid });
  try {
    const { rows } = await client.query(
      `INSERT INTO users (uid, email, name, role, contract_type, is_pj, pj_due_day, job_title_id, phone, permissions, firebase_enable_pending)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, TRUE) RETURNING *`,
      [firebaseUser.uid, data.email, data.name, data.role || 'viewer', contract.contract_type, contract.is_pj, contract.pj_due_day, data.job_title_id, data.phone || '', JSON.stringify(data.permissions || {})]
    );
    if (!createdFirebaseUser) {
      await client.query(
        `DELETE FROM pending_registrations
         WHERE firebase_uid = $1 AND status = 'rejected'`,
        [firebaseUser.uid],
      );
    }
    const link = await firebaseAuth.generatePasswordResetLink(data.email, { url: portalLoginUrl() });
    const delivery = await sendInvitation({ to: data.email, name: data.name, link });
    const invitation = smtpAcceptanceAuditDetails(delivery);
    if (audit) await audit('user.create', firebaseUser.uid, { role: data.role || 'viewer', invitation });
    const result = { ...rows[0], invitation: { state: invitation.state } };
    Object.defineProperty(result, 'firebaseCreated', { value: createdFirebaseUser, enumerable: false });
    return result;
  } catch (error) {
    if (createdFirebaseUser) {
      error.firebaseUid = firebaseUser.uid;
      error.firebaseCreated = true;
    }
    throw error;
  }
}

async function reconcilePendingFirebaseEnables({ pool, requestId, limit = 25 }) {
  const client = await pool.connect();
  let resolved = 0;
  let failed = 0;
  let transactionOpen = false;
  let commitAttempted = false;
  let commitCompleted = false;
  let discardClient = false;
  try {
    try {
      await client.query('BEGIN');
      transactionOpen = true;
    } catch (error) {
      // BEGIN may have reached PostgreSQL even when its response was lost.
      discardClient = true;
      throw error;
    }
    const { rows } = await client.query(
       `SELECT uid, email, permissions FROM users
        WHERE firebase_enable_pending = TRUE
         AND permissions->>'accountDisabled' IS DISTINCT FROM 'true'
       ORDER BY created_at LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );
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
    for (const row of rows) {
      const result = await enableActiveUser({ pool, uid: row.uid, email: row.email, requestId });
      if (result.state === 'active') {
        resolved += 1;
      } else if (!result.skipped) {
        failed += 1;
        console.error(JSON.stringify({ service: 'api', event: 'firebase_enable_reconciliation_failed', requestId }));
      }
    }
    return { resolved, failed };
  } catch (error) {
    if (commitAttempted && !commitCompleted) {
      discardClient = true;
      transactionOpen = false;
    } else if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
        transactionOpen = false;
      } catch {
        transactionOpen = false;
        discardClient = true;
      }
    }
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

module.exports = {
  cleanupFirebaseIdentity,
  compensateCreatedInvitedUser,
  createInvitedUser,
  enableActiveUser,
  lockFirebaseIdentity,
  lockPendingRegistrationIdentity,
  processFirebaseCleanup,
  queueFirebaseCleanup,
  reconcilePendingFirebaseEnables,
};
