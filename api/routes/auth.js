const express = require('express');
const pool = require('../db');
const { firebaseAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');
const { portalLoginUrl, sendPasswordReset } = require('../integrations/password-reset-email');
const { validateRegistration } = require('../middleware/validation');
const {
  cleanupPendingRegistrationUser, createPendingRegistration, recoverPendingRegistration,
  requestPendingRegistrationPassword, withRegistrationOperation,
} = require('../services/pending-registration');
const { queueFirebaseCleanup } = require('../services/user-invitation');

const router = express.Router();
const resetLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });
const configuredRegistrationMax = Number(process.env.REGISTRATION_MAX_ATTEMPTS_PER_IP_PER_HOUR || 300);
const registrationLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number.isSafeInteger(configuredRegistrationMax) && configuredRegistrationMax > 0 ? configuredRegistrationMax : 300,
});
const registrationPasswordLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });
const accepted = { status: 'accepted' };
const registrationAccepted = { status: 'accepted', state: 'received' };
const failureCodes = new Set(['auth/invalid-email', 'auth/invalid-password', 'auth/too-many-requests',
  'auth/internal-error', 'auth/insufficient-permission', 'ECONNECTION', 'ETIMEDOUT']);
const failureCode = (error) => failureCodes.has(error.code) ? error.code : 'unknown';

router.post('/register', registrationLimit, async (req, res, next) => {
  if (!validateRegistration(req.body)) return res.status(400).json({ error: 'Invalid request.', requestId: req.id });
  const data = {
    email: req.body.email.trim().toLowerCase(),
    name: req.body.name.trim(),
    password: req.body.password,
  };
  const controller = new AbortController();
  const abortWaiting = () => { if (!res.writableEnded) controller.abort(); };
  const admission = { wait: true, signal: controller.signal };
  req.once('aborted', abortWaiting);
  res.once('close', abortWaiting);
  try {
    const needsRecovery = await withRegistrationOperation(async () => {
      let client;
      let createdUid;
      let commitAttempted = false;
      let commitCompleted = false;
      let discardClient = false;
      try {
        client = await pool.connect();
        await client.query('BEGIN');
        const registration = await createPendingRegistration({ client, data, requestId: req.id });
        createdUid = registration.uid;
        commitAttempted = true;
        await client.query('COMMIT');
        commitCompleted = true;
        return false;
      } catch (error) {
        let rollbackFailed = false;
        if (!commitAttempted) await client?.query('ROLLBACK').catch(() => { rollbackFailed = true; discardClient = true; });
        // Keep admission through rollback/compensation, but return this client
        // before any cleanup helper can acquire a separate pool connection.
        client?.release(discardClient || (commitAttempted && !commitCompleted));
        client = null;
        if ((commitAttempted && !commitCompleted || rollbackFailed) && (createdUid || error.firebaseUid)) {
          await queueFirebaseCleanup({ pool, uid: createdUid || error.firebaseUid, reason: 'registration_commit_ambiguous' })
            .catch(() => console.error(JSON.stringify({ service: 'api', event: 'firebase_cleanup_queue_failed', requestId: req.id })));
        }
        const cleanupUid = !commitAttempted && !rollbackFailed ? (createdUid || error.firebaseUid) : null;
        if (cleanupUid) {
          const cleanupError = await cleanupPendingRegistrationUser({
            pool, uid: cleanupUid, email: data.email, requestId: req.id,
          });
          if (cleanupError) {
            await queueFirebaseCleanup({ pool, uid: cleanupUid, reason: 'registration' }).catch(() => {
              console.error(JSON.stringify({ service: 'api', event: 'firebase_cleanup_queue_failed', requestId: req.id }));
            });
            console.error(JSON.stringify({ service: 'api', event: 'pending_registration_cleanup_failed', requestId: req.id }));
          }
        }
        if (error.code === 'auth/email-already-exists' || error.code === '23505' || error.code === 'REGISTRATION_PENDING_EXISTS') return true;
        if (error.code === 'REGISTRATION_ALREADY_EXISTS') return false;
        throw error;
      } finally {
        client?.release(discardClient || (commitAttempted && !commitCompleted));
      }
    }, admission);
    // Recover a duplicate only after the original client and gate slot have
    // been released. Never nest admission while retaining an active slot.
    if (needsRecovery) {
      await withRegistrationOperation(() => recoverPendingRegistration({ pool, data, requestId: req.id }), admission).catch(() => false);
    }
    console.log(JSON.stringify({ service: 'api', event: 'pending_registration_accepted', requestId: req.id }));
    return res.status(202).json(registrationAccepted);
  } catch (error) {
    if (error.code === 'REGISTRATION_ABORTED') return;
    if (error.code === 'REGISTRATION_BUSY') {
      res.setHeader('Retry-After', '5');
      return res.status(503).json({ error: 'Cadastro temporariamente indisponível.', reason: 'registration_busy', requestId: req.id });
    }
    if (error.code === 'REGISTRATION_RATE_LIMITED') {
      res.setHeader('Retry-After', String(error.retryAfter));
      return res.status(429).json({ error: 'Muitos cadastros recentes. Tente novamente mais tarde.', requestId: req.id });
    }
    console.error(JSON.stringify({ service: 'api', event: 'pending_registration_failed', requestId: req.id, code: failureCode(error) }));
    return res.status(503).json({ error: 'Cadastro temporariamente indisponível.', requestId: req.id });
  } finally {
    req.removeListener('aborted', abortWaiting);
    res.removeListener('close', abortWaiting);
  }
});

router.post('/password-reset', resetLimit, async (req, res, next) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    return res.status(400).json({ error: 'Invalid email.', requestId: req.id });
  }

  try {
    const firebaseUser = await firebaseAuth.getUserByEmail(email).catch((error) => {
      if (error.code === 'auth/user-not-found') return null;
      throw error;
    });
    if (!firebaseUser) return res.status(202).json(accepted);

    if (firebaseUser.disabled) {
      await withRegistrationOperation(() => requestPendingRegistrationPassword({ pool, email }));
      return res.status(202).json(accepted);
    }
    const { rowCount } = await pool.query(
      `SELECT 1 FROM users WHERE uid = $1
       AND permissions->>'accountDisabled' IS DISTINCT FROM 'true'
       AND firebase_enable_pending IS NOT TRUE LIMIT 1`,
      [firebaseUser.uid],
    );
    if (!rowCount) return res.status(202).json(accepted);

    const link = await firebaseAuth.generatePasswordResetLink(email, { url: portalLoginUrl() });
    await sendPasswordReset({ to: email, link });
    console.log(JSON.stringify({ service: 'api', event: 'password_reset_email_accepted', requestId: req.id }));
    res.status(202).json(accepted);
  } catch (error) {
    console.error(JSON.stringify({ service: 'api', event: 'password_reset_failed', requestId: req.id, code: failureCode(error) }));
    return res.status(202).json(accepted);
  }
});

router.post('/registration-password', registrationPasswordLimit, async (req, res, next) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    return res.status(400).json({ error: 'Invalid email.', requestId: req.id });
  }

  try {
    await withRegistrationOperation(() => requestPendingRegistrationPassword({ pool, email }));
    return res.status(202).json(accepted);
  } catch (error) {
    if (error.code === 'REGISTRATION_BUSY') {
      return res.status(503).json({ error: 'Cadastro temporariamente indisponível.', requestId: req.id });
    }
    console.error(JSON.stringify({ service: 'api', event: 'registration_password_failed', requestId: req.id, code: failureCode(error) }));
    return res.status(202).json(accepted);
  }
});

module.exports = router;
