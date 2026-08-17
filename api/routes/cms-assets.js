const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { canManageCms } = require('../cms/permissions');
const { forbidden, invalid, uuid, withAudit } = require('../route-utils');

const router = express.Router();
const uploadDirectory = process.env.UPLOAD_DIR || '/app/uploads';
const privateDirectory = path.join(uploadDirectory, 'cms-private');
const MAX_ASSET_SIZE = 50 * 1024 * 1024;
const CONTENT_TYPES = ['knowledge', 'academy', 'benefit', 'announcement', 'reminder'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ASSET_SIZE, files: 1 },
});

function detectedMime(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  if (buffer.subarray(4, 8).toString() === 'ftyp') {
    return buffer.subarray(8, 12).toString() === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  return null;
}

function manageable(user) {
  return CONTENT_TYPES.some((type) => canManageCms(user, type));
}

function assetResponse(asset) {
  return {
    id: asset.id,
    original_name: asset.original_name,
    mime_type: asset.mime_type,
    byte_size: Number(asset.byte_size),
    created_at: asset.created_at,
  };
}

async function canReadAsset(user, asset) {
  if (!manageable(user)) return false;
  if (asset.uploaded_by === user.uid) return true;
  const { rows } = await pool.query(
    `SELECT d.content_type
       FROM cms_documents d
       JOIN cms_revisions r ON r.document_id = d.id
      WHERE r.blocks @> $1::jsonb`,
    [JSON.stringify([{ asset_id: asset.id }])],
  );
  return rows.some(({ content_type }) => canManageCms(user, content_type));
}

router.post('/', authMiddleware, upload.single('asset'), async (req, res, next) => {
  if (!manageable(req.user)) return forbidden(req, res);
  if (!req.file || !req.file.buffer?.length) return invalid(req, res);
  const mimeType = detectedMime(req.file.buffer);
  if (!mimeType || mimeType !== req.file.mimetype || req.file.size < 1 || req.file.size > MAX_ASSET_SIZE) {
    return invalid(req, res);
  }
  const originalName = path.basename(String(req.file.originalname || 'asset').replace(/\\/g, '/')).trim();
  if (!originalName || originalName.length > 255) return invalid(req, res);

  const storageKey = crypto.randomUUID();
  const target = path.join(privateDirectory, storageKey);
  let fileWritten = false;
  try {
    const asset = await withAudit(pool, req, 'cms.asset.upload', 'cms_asset', async (db) => {
      await fsp.mkdir(privateDirectory, { recursive: true });
      await fsp.writeFile(target, req.file.buffer, { flag: 'wx' });
      fileWritten = true;
      const { rows } = await db.query(
        `INSERT INTO cms_assets (storage_key, original_name, mime_type, byte_size, uploaded_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, original_name, mime_type, byte_size, uploaded_by, created_at`,
        [storageKey, originalName, mimeType, req.file.size, req.user.uid],
      );
      return rows[0];
    }, { targetId: (result) => result.id, details: { mime_type: mimeType, byte_size: req.file.size } });
    res.status(201).json(assetResponse(asset));
  } catch (error) {
    if (fileWritten) await fsp.unlink(target).catch(() => {});
    next(error);
  }
});

router.get('/:id', authMiddleware, async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const { rows } = await pool.query(
      `SELECT id, storage_key, original_name, mime_type, byte_size, uploaded_by, created_at
         FROM cms_assets WHERE id = $1`,
      [req.params.id],
    );
    const asset = rows[0];
    if (!asset) return res.status(404).json({ error: 'Asset not found.', requestId: req.id });
    if (!await canReadAsset(req.user, asset)) return forbidden(req, res);

    res.set({
      'Content-Length': String(asset.byte_size),
      'Content-Type': asset.mime_type,
      'Content-Disposition': `inline; filename="${asset.original_name.replace(/["\\\r\n]/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    const stream = fs.createReadStream(path.join(privateDirectory, asset.storage_key));
    stream.on('error', next).pipe(res);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
module.exports.detectedMime = detectedMime;
