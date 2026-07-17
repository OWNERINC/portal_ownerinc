const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');

// GET /api/knowledge — todos, ordenado por updated_at
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM knowledge_base ORDER BY updated_at DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/knowledge — cria artigo (admin)
router.post('/', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sem permissão.' });
  try {
    const { title, category, content } = req.body;
    if (!title) return res.status(400).json({ error: 'Título é obrigatório.' });
    const { rows } = await pool.query(
      `INSERT INTO knowledge_base (title, category, content, created_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [title, category || '', content || '', req.user.uid]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/knowledge/:id — atualiza artigo (admin)
router.put('/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sem permissão.' });
  try {
    const { title, category, content } = req.body;
    const { rows } = await pool.query(
      `UPDATE knowledge_base
       SET title=$2, category=$3, content=$4, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id, title, category || '', content || '']
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Artigo não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/knowledge/:id (admin)
router.delete('/:id', authMiddleware, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sem permissão.' });
  try {
    await pool.query('DELETE FROM knowledge_base WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
