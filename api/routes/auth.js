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
const registrationLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });
const registrationPasswordLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });
const accepted = { status: 'accepted' };
const registrationAccepted = { status: 'accepted', state: 'received' };

router.post('/register', registrationLimit, async (req, res, next) => {
  if (!validateRegistration(req.body)) return res.status(400).json({ error: 'Invalid request.', requestId: req.id });
  const data = {
    email: req.body.email.trim().toLowerCase(),
    name: req.body.name.trim(),
  };
  let client;
  let createdUid;
  let commitAttempted = false;
  let commitCompleted = false;
  let discardClient = false;
  try {
    await withRegistrationOperation(async () => {
      client = await pool.connect();
      await client.query('BEGIN');
      const registration = await createPendingRegistration({ client, data, requestId: req.id });
      createdUid = registration.uid;
      commitAttempted = true;
      await client.query('COMMIT');
      commitCompleted = true;
      return registration;
    });
    createdUid = null;
    console.log(JSON.stringify({ service: 'api', event: 'pending_registration_accepted', requestId: req.id }));
    return res.status(202).json(registrationAccepted);
  } catch (error) {
    let rollbackFailed = false;
    if (!commitAttempted) await client?.query('ROLLBACK').catch(() => { rollbackFailed = true; discardClient = true; });
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
        await queueFirebaseCleanup({ pool, uid: cleanupUid, reason: 'registration' }).catch((queueError) => {
          console.error(JSON.stringify({ service: 'api', event: 'firebase_cleanup_queue_failed', requestId: req.id, error: queueError.message }));
        });
        console.error(JSON.stringify({ service: 'api', event: 'pending_registration_cleanup_failed', requestId: req.id }));
      }
    }
    if (error.code === 'auth/email-already-exists' || error.code === '23505') {
      client?.release(discardClient || rollbackFailed);
      client = null;
      await withRegistrationOperation(() => recoverPendingRegistration({ pool, data, requestId: req.id })).catch(() => false);
      return res.status(202).json(registrationAccepted);
    }
    if (error.code === 'REGISTRATION_ALREADY_EXISTS') return res.status(202).json(registrationAccepted);
    if (error.code === 'REGISTRATION_BUSY') return res.status(503).json({ error: 'Cadastro temporariamente indisponível.', requestId: req.id });
    if (error.code === 'REGISTRATION_RATE_LIMITED') return res.status(429).json({ error: 'Muitos cadastros recentes. Tente novamente mais tarde.', requestId: req.id });
    console.error(JSON.stringify({ service: 'api', event: 'pending_registration_failed', requestId: req.id, code: error.code || 'unknown' }));
    return res.status(503).json({ error: 'Cadastro temporariamente indisponível.', requestId: req.id });
  } finally {
    client?.release(discardClient || (commitAttempted && !commitCompleted));
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

    if (firebaseUser.disabled || firebaseUser.emailVerified !== true) return res.status(202).json(accepted);
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
    console.error(JSON.stringify({ service: 'api', event: 'password_reset_failed', requestId: req.id, code: error.code || 'unknown' }));
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
    console.error(JSON.stringify({ service: 'api', event: 'registration_password_failed', requestId: req.id, code: error.code || 'unknown' }));
    return res.status(202).json(accepted);
  }
});

module.exports = router;
