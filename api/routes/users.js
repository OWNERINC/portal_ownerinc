const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authMiddleware, can, admin } = require('../middleware/auth');

// GET /api/users/me
router.get('/me', authMiddleware, (req, res) => {
  res.json(req.user);
});

// PUT /api/users/me — atualiza próprio perfil
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const { name, bio, phone, linkedin_url, photo_url } = req.body;
    const { rows } = await pool.query(
      `UPDATE users SET
        name        = COALESCE($2, name),
        bio         = COALESCE($3, bio),
        phone       = COALESCE($4, phone),
        linkedin_url= COALESCE($5, linkedin_url),
        photo_url   = COALESCE($6, photo_url)
       WHERE uid = $1 RETURNING *`,
      [req.user.uid, name, bio, phone, linkedin_url, photo_url]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users — lista todos (admin + manageUsers)
router.get('/', authMiddleware, async (req, res) => {
  if (!can(req.user, 'manageUsers')) {
    return res.status(403).json({ error: 'Sem permissão.' });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM users ORDER BY name');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users — cria usuário (admin + manageUsers)
router.post('/', authMiddleware, async (req, res) => {
  if (!can(req.user, 'manageUsers')) {
    return res.status(403).json({ error: 'Sem permissão.' });
  }
  try {
    const { uid, name, email, role, contract_type, is_pj, pj_due_day, phone, permissions } = req.body;
    if (!uid || !email) return res.status(400).json({ error: 'uid e email são obrigatórios.' });
    const { rows } = await pool.query(
      `INSERT INTO users (uid, email, name, role, contract_type, is_pj, pj_due_day, phone, permissions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (uid) DO UPDATE SET
         name = EXCLUDED.name, email = EXCLUDED.email,
         role = EXCLUDED.role, contract_type = EXCLUDED.contract_type,
         is_pj = EXCLUDED.is_pj, pj_due_day = EXCLUDED.pj_due_day,
         phone = EXCLUDED.phone, permissions = EXCLUDED.permissions
       RETURNING *`,
      [
        uid, email, name || '', role || 'viewer',
        contract_type || 'clt', !!is_pj,
        pj_due_day || null, phone || '',
        JSON.stringify(permissions || {}),
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/:uid — atualiza qualquer usuário (admin + manageUsers)
router.put('/:uid', authMiddleware, async (req, res) => {
  if (!can(req.user, 'manageUsers')) {
    return res.status(403).json({ error: 'Sem permissão.' });
  }
  try {
    const { name, role, contract_type, is_pj, pj_due_day, phone, permissions } = req.body;
    const updatePerms = role === 'admin' && can(req.user, 'superAdmin');
    const { rows } = await pool.query(
      `UPDATE users SET
        name          = $2,
        role          = $3,
        contract_type = $4,
        is_pj         = $5,
        pj_due_day    = $6,
        phone         = $7,
        permissions   = CASE WHEN $8 THEN $9::jsonb ELSE permissions END
       WHERE uid = $1 RETURNING *`,
      [
        req.params.uid, name, role,
        contract_type, !!is_pj,
        pj_due_day || null, phone || '',
        updatePerms, JSON.stringify(permissions || {}),
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/users/:uid — remove do DB e do Firebase Auth (admin + manageUsers)
router.delete('/:uid', authMiddleware, async (req, res) => {
  if (!can(req.user, 'manageUsers')) {
    return res.status(403).json({ error: 'Sem permissão.' });
  }
  try {
    await pool.query('DELETE FROM users WHERE uid = $1', [req.params.uid]);
    try {
      await admin.auth().deleteUser(req.params.uid);
    } catch {
      // Remoção do Firebase Auth falha silenciosamente (usuário já pode ter sido removido)
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
