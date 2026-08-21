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
const ASSET_MIMES = {
  image: new Set(['image/jpeg', 'image/png', 'image/webp']),
  pdf: new Set(['application/pdf']),
  video: new Set(['video/mp4', 'video/webm', 'video/quicktime']),
};
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

function audienceFor(user) {
  return user.contract_type === 'pj' || user.is_pj ? 'pj' : 'clt';
}

function reminderIsVisible(row, user) {
  const targetUsers = row.reminder_target_users;
  return row.reminder_active === true && (
    targetUsers === 'all'
    || targetUsers === audienceFor(user)
    || (Array.isArray(targetUsers) && targetUsers.includes(user.uid))
  );
}

function publishedIsVisible(row, user) {
  if (row.content_type === 'knowledge' || row.content_type === 'announcement') return true;
  if (row.content_type === 'academy') return row.academy_active === true;
  if (row.content_type === 'benefit') return row.benefit_active === true;
  if (row.content_type === 'reminder') return reminderIsVisible(row, user);
  return false;
}

function referenceIsReadable(row, user, asset) {
  if (!ASSET_MIMES[row.block_type]?.has(asset.mime_type)) return false;
  if (canManageCms(user, row.content_type) && ['draft', 'published', 'scheduled'].includes(row.status)) return true;
  return row.status === 'published'
    && row.published_revision_id === row.revision_id
    && publishedIsVisible(row, user);
}

async function canReadAsset(user, asset) {
  const { rows } = await pool.query(
    `SELECT d.content_type, d.published_revision_id, r.id AS revision_id, r.status,
            block->>'type' AS block_type,
            academy.active AS academy_active,
            benefits.active AS benefit_active,
            reminders.active AS reminder_active,
            reminders.target_users AS reminder_target_users
       FROM cms_documents d
       JOIN cms_revisions r ON r.document_id = d.id
       CROSS JOIN LATERAL jsonb_array_elements(r.blocks) block
       LEFT JOIN academy ON d.content_type = 'academy' AND academy.id = d.source_id
       LEFT JOIN benefits ON d.content_type = 'benefit' AND benefits.id = d.source_id
       LEFT JOIN reminders ON d.content_type = 'reminder' AND reminders.id = d.source_id
      WHERE block->>'asset_id' = $1
        AND r.status IN ('draft', 'published', 'scheduled')`,
    [asset.id],
  );
  return rows.some((row) => referenceIsReadable(row, user, asset));
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
      `SELECT id, storage_key, original_name, mime_type, byte_size, created_at
         FROM cms_assets WHERE id = $1 AND deleting_at IS NULL`,
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
