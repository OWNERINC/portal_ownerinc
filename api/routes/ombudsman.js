const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authMiddleware, can } = require('../middleware/auth');

// GET /api/ombudsman — lista mensagens (viewOmbudsman)
router.get('/', authMiddleware, async (req, res) => {
  if (!can(req.user, 'viewOmbudsman')) return res.status(403).json({ error: 'Sem permissão.' });
  try {
    const { rows } = await pool.query(
      'SELECT * FROM ombudsman ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ombudsman — envia mensagem (anônima, qualquer usuário autenticado)
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { category, message } = req.body;
    if (!message) return res.status(400).json({ error: 'Mensagem é obrigatória.' });
    const { rows } = await pool.query(
      'INSERT INTO ombudsman (category, message) VALUES ($1, $2) RETURNING *',
      [category || '', message]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
