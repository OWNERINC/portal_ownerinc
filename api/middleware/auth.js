const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const pool = require('../db');
const { can } = require('./policy');
const { rateLimit } = require('./security');

const writeLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, key: (req) => req.user.uid });

if (!getApps().length) {
  const emulator = process.env.NODE_ENV === 'development' && process.env.FIREBASE_AUTH_EMULATOR_HOST;
  initializeApp(emulator ? { projectId: process.env.FIREBASE_PROJECT_ID } : {
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const firebaseAuth = getAuth();

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required.', requestId: req.id });
  }
  let decoded;
  try {
    decoded = await firebaseAuth.verifyIdToken(header.slice(7), true);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token.', requestId: req.id });
  }
  if (decoded.email_verified !== true) {
    return res.status(403).json({ error: 'A verified email is required.', requestId: req.id });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE uid = $1', [decoded.uid]);
    if (!rows[0] || rows[0].permissions?.accountDisabled === true) {
      return res.status(403).json({ error: 'Account is not active.', requestId: req.id });
    }
    req.firebaseUser = decoded;
    req.user = rows[0];
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return writeLimit(req, res, next);
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { authMiddleware, can, firebaseAuth };
