const { cert, getApps, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const pool = require('../db');
const { can } = require('./policy');
const { ActivePortalUserError, loadActivePortalUser } = require('./active-user');
const { authEmulatorEnabled, rateLimit } = require('./security');

const writeLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 60, key: (req) => req.user.uid });
const progressLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 120, key: (req) => req.user.uid });
const progressPath = /^\/api\/academy\/lessons\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/progress$/i;

if (!getApps().length) {
  const emulator = authEmulatorEnabled(process.env);
  initializeApp(emulator ? { projectId: process.env.FIREBASE_PROJECT_ID } : {
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const firebaseAuth = getAuth();

function createAuthMiddleware({ firebaseAuth, db, onTokenError }) {
  return async function authMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required.', requestId: req.id });
    }
    let decoded;
    try {
      decoded = await firebaseAuth.verifyIdToken(header.slice(7), true);
    } catch (err) {
      if (onTokenError) return next(onTokenError(err));
      return res.status(401).json({ error: 'Invalid or expired token.', requestId: req.id });
    }

    try {
      const user = await loadActivePortalUser(db, decoded);
      req.firebaseUser = decoded;
      req.user = user;
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const pathname = (req.originalUrl || '').split('?')[0];
        return (req.method === 'PUT' && progressPath.test(pathname) ? progressLimit : writeLimit)(req, res, next);
      }
      next();
    } catch (err) {
      if (err instanceof ActivePortalUserError) {
        return res.status(err.status).json({ error: err.message, ...(err.reason ? { reason: err.reason } : {}), requestId: req.id });
      }
      next(err);
    }
  };
}

const authMiddleware = createAuthMiddleware({ firebaseAuth, db: pool });
module.exports = { authMiddleware, createAuthMiddleware, can, firebaseAuth };
