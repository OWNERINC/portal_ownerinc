const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authMiddleware, can } = require('../middleware/auth');

// GET /api/reminders — lista lembretes (opcionalmente filtrado: ?active=true)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const params = [];
    let where = '';
    if (req.query.active === 'true') {
      params.push(true);
      where = `WHERE active = $${params.length}`;
    }
    const { rows } = await pool.query(
      `SELECT * FROM reminders ${where} ORDER BY trigger_day`,
      params
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reminders (manageReminders)
router.post('/', authMiddleware, async (req, res) => {
  if (!can(req.user, 'manageReminders')) return res.status(403).json({ error: 'Sem permissão.' });
  try {
    const { title, description, trigger_day, target_users, channel, active } = req.body;
    if (!title || !trigger_day) {
      return res.status(400).json({ error: 'Título e dia são obrigatórios.' });
    }
    const { rows } = await pool.query(
      `INSERT INTO reminders (title, description, trigger_day, target_users, channel, active, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING *`,
      [
        title, description || '', trigger_day,
        JSON.stringify(target_users ?? 'all'),
        channel || 'email', active !== false, req.user.uid,
      ]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/reminders/:id (manageReminders)
router.put('/:id', authMiddleware, async (req, res) => {
  if (!can(req.user, 'manageReminders')) return res.status(403).json({ error: 'Sem permissão.' });
  try {
    const { title, description, trigger_day, target_users, channel, active } = req.body;
    const { rows } = await pool.query(
      `UPDATE reminders
       SET title=$2, description=$3, trigger_day=$4, target_users=$5::jsonb,
           channel=$6, active=$7, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [
        req.params.id, title, description || '', trigger_day,
        JSON.stringify(target_users ?? 'all'),
        channel || 'email', !!active,
      ]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Lembrete não encontrado.' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/reminders/:id (manageReminders)
router.delete('/:id', authMiddleware, async (req, res) => {
  if (!can(req.user, 'manageReminders')) return res.status(403).json({ error: 'Sem permissão.' });
  try {
    await pool.query('DELETE FROM reminders WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
