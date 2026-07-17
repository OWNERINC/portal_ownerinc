const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');

const storage = multer.diskStorage({
  destination: '/app/uploads',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.user.uid}_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype.startsWith('image/'));
  },
});

// POST /api/upload/photo — upload de foto de perfil
router.post('/photo', authMiddleware, upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhuma imagem enviada.' });
    const photo_url = `/uploads/${req.file.filename}`;
    await pool.query('UPDATE users SET photo_url=$2 WHERE uid=$1', [req.user.uid, photo_url]);
    res.json({ url: photo_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
