const admin = require('firebase-admin');
const pool = require('../db');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido.' });
  }
  try {
    const token = header.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);

    // Carrega (ou cria) o usuário no PostgreSQL
    let { rows } = await pool.query('SELECT * FROM users WHERE uid = $1', [decoded.uid]);
    if (rows.length === 0) {
      const insert = await pool.query(
        `INSERT INTO users (uid, email, name)
         VALUES ($1, $2, $3)
         ON CONFLICT (uid) DO UPDATE SET email = EXCLUDED.email
         RETURNING *`,
        [decoded.uid, decoded.email || '', decoded.name || '']
      );
      rows = insert.rows;
    }

    req.firebaseUser = decoded;
    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

function can(user, perm) {
  return !!(user?.permissions?.superAdmin || user?.permissions?.[perm]);
}

module.exports = { authMiddleware, can, admin };
