const express = require('express');
const pool = require('../db');
const { firebaseAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');
const { sendPasswordReset } = require('../integrations/password-reset-email');

const router = express.Router();
const resetLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 });
const accepted = { status: 'accepted' };

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
    if (!firebaseUser || firebaseUser.disabled) return res.status(202).json(accepted);

    const { rowCount } = await pool.query(
      `SELECT 1 FROM users WHERE uid = $1
       AND permissions->>'accountDisabled' IS DISTINCT FROM 'true' LIMIT 1`,
      [firebaseUser.uid],
    );
    if (!rowCount) return res.status(202).json(accepted);

    const link = await firebaseAuth.generatePasswordResetLink(email, {
      url: 'https://portal.ownerinc.com.br/login.html',
    });
    await sendPasswordReset({ to: email, link });
    console.log(JSON.stringify({ service: 'api', event: 'password_reset_email_accepted', requestId: req.id }));
    res.status(202).json(accepted);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
