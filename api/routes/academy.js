const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authMiddleware, can } = require('../middleware/auth');

// GET /api/academy — lista cursos (?active=true, ?limit=N)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const params = [];
    const conditions = [];
    if (req.query.active === 'true') {
      params.push(true);
      conditions.push(`active = $${params.length}`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitClause = req.query.limit ? ` LIMIT ${parseInt(req.query.limit)}` : '';
    const { rows } = await pool.query(
      `SELECT * FROM academy ${where} ORDER BY "order"${limitClause}`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/academy (manageAcademy)
router.post('/', authMiddleware, async (req, res) => {
  if (!can(req.user, 'manageAcademy')) return res.status(403).json({ error: 'Sem permissão.' });
  try {
    const { title, category, description, url, order, active } = req.body;
    if (!title || !url) return res.status(400).json({ error: 'Título e URL são obrigatórios.' });
    const { rows } = await pool.query(
      `INSERT INTO academy (title, category, description, url, "order", active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [title, category || '', description || '', url, order || 0, active !== false]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/academy/:id (manageAcademy)
router.put('/:id', authMiddleware, async (req, res) => {
  if (!can(req.user, 'manageAcademy')) return res.status(403).json({ error: 'Sem permissão.' });
  try {
    const { title, category, description, url, order, active } = req.body;
    const { rows } = await pool.query(
      `UPDATE academy
       SET title=$2, category=$3, description=$4, url=$5, "order"=$6, active=$7
       WHERE id=$1 RETURNING *`,
      [req.params.id, title, category || '', description || '', url, order || 0, !!active]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Curso não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/academy/:id (manageAcademy)
router.delete('/:id', authMiddleware, async (req, res) => {
  if (!can(req.user, 'manageAcademy')) return res.status(403).json({ error: 'Sem permissão.' });
  try {
    await pool.query('DELETE FROM academy WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
