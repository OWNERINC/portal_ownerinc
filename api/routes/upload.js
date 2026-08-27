const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { rateLimit } = require('../middleware/security');
const { normalizeImage } = require('../middleware/validation');

const router = express.Router();
const uploadDirectory = process.env.UPLOAD_DIR || '/app/uploads';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024, files: 1 } });
const uploadLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, key: (req) => req.user.uid });

async function removePhoto(photoUrl) {
  if (!photoUrl?.startsWith('/uploads/')) return;
  const filename = path.basename(photoUrl);
  if (`/uploads/${filename}` !== photoUrl) return;
  await fs.unlink(path.join(uploadDirectory, filename)).catch((err) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

router.post('/photo', authMiddleware, uploadLimit, upload.single('photo'), async (req, res, next) => {
  if (!req.file) return res.status(400).json({ error: 'Image is required.', requestId: req.id });
  let normalized;
  try {
    normalized = await normalizeImage(req.file.buffer);
  } catch {
    return res.status(400).json({ error: 'Only valid JPEG, PNG, or WebP images are allowed.', requestId: req.id });
  }

  const filename = `${crypto.randomUUID()}.webp`;
  const target = path.join(uploadDirectory, filename);
  const photoUrl = `/uploads/${filename}`;
  let client;
  let previousPhoto;
  try {
    client = await pool.connect();
    await fs.mkdir(uploadDirectory, { recursive: true });
    await fs.writeFile(target, normalized, { flag: 'wx' });
    await client.query('BEGIN');
    const current = await client.query('SELECT photo_url FROM users WHERE uid = $1 FOR UPDATE', [req.user.uid]);
    previousPhoto = current.rows[0]?.photo_url;
    await client.query(
      `UPDATE users SET photo_url = $2, photo_crop = '{"x":0.5,"y":0.5,"zoom":1}'::jsonb WHERE uid = $1`,
      [req.user.uid, photoUrl],
    );
    await client.query('COMMIT');
    await removePhoto(previousPhoto).catch((err) => console.error(`[api] request=${req.id} old photo cleanup failed`, err));
    res.json({ url: photoUrl });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    await fs.unlink(target).catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
});

router.delete('/photo', authMiddleware, uploadLimit, async (req, res, next) => {
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT photo_url FROM users WHERE uid = $1 FOR UPDATE', [req.user.uid]);
    await client.query(
      `UPDATE users SET photo_url = '', photo_crop = '{"x":0.5,"y":0.5,"zoom":1}'::jsonb WHERE uid = $1`,
      [req.user.uid],
    );
    await client.query('COMMIT');
    await removePhoto(rows[0]?.photo_url).catch((err) => console.error(`[api] request=${req.id} photo cleanup failed`, err));
    res.json({ success: true, url: '' });
  } catch (err) {
    await client?.query('ROLLBACK').catch(() => {});
    next(err);
  } finally {
    client?.release();
  }
});

module.exports = router;
