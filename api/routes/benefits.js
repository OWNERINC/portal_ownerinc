const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authMiddleware, can } = require('../middleware/auth');

// GET /api/benefits — lista benefícios (?active=true)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const params = [];
    const conditions = [];
    if (req.query.active === 'true') {
      params.push(true);
      conditions.push(`active = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM benefits ${where} ORDER BY "order"`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/benefits (manageBenefits)
router.post('/', authMiddleware, async (req, res) => {
  if (!can(req.user, 'manageBenefits')) return res.status(403).json({ error: 'Sem permissão.' });
  try {
    const { company, category, description, instructions, order, active } = req.body;
    if (!company) return res.status(400).json({ error: 'Nome da empresa é obrigatório.' });
    const { rows } = await pool.query(
      `INSERT INTO benefits (company, category, description, instructions, "order", active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [company, category || '', description || '', instructions || '', order || 0, active !== false]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/benefits/:id (manageBenefits)
router.put('/:id', authMiddleware, async (req, res) => {
  if (!can(req.user, 'manageBenefits')) return res.status(403).json({ error: 'Sem permissão.' });
  try {
    const { company, category, description, instructions, order, active } = req.body;
    const { rows } = await pool.query(
      `UPDATE benefits
       SET company=$2, category=$3, description=$4, instructions=$5, "order"=$6, active=$7
       WHERE id=$1 RETURNING *`,
      [req.params.id, company, category || '', description || '', instructions || '', order || 0, !!active]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Benefício não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/benefits/:id (manageBenefits)
router.delete('/:id', authMiddleware, async (req, res) => {
  if (!can(req.user, 'manageBenefits')) return res.status(403).json({ error: 'Sem permissão.' });
  try {
    await pool.query('DELETE FROM benefits WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
