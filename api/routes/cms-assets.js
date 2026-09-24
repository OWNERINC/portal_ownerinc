const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { canManageCms } = require('../cms/permissions');
const { lockCmsAssets } = require('../cms/locks');
const { forbidden, invalid, uuid, withAudit } = require('../route-utils');

const router = express.Router();
const uploadDirectory = process.env.UPLOAD_DIR || '/app/uploads';
const privateDirectory = path.join(uploadDirectory, 'cms-private');
const MAX_ASSET_SIZE = 50 * 1024 * 1024;
const MAX_PDF_SIZE = 100 * 1024 * 1024;
const CONTENT_TYPES = ['knowledge', 'academy', 'benefit', 'announcement', 'reminder'];
const ASSET_MIMES = {
  image: new Set(['image/jpeg', 'image/png', 'image/webp']),
  pdf: new Set(['application/pdf']),
  video: new Set(['video/mp4', 'video/webm', 'video/quicktime']),
};
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fieldNameSize: 100,
    fieldSize: 1024,
    fields: 0,
    fileSize: MAX_PDF_SIZE,
    files: 1,
    parts: 2,
  },
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

function isMalformedMultipart(error) {
  if (error?.code === 'ERR_MULTIPART_BOUNDARY') return true;
  return /multipart|part header|Unexpected end of form/i.test(String(error?.message || ''));
}

async function reserveUnreferencedAsset(db, assetId, { lock = true } = {}) {
  if (lock) await lockCmsAssets(db);
  const { rows } = await db.query(
    `SELECT id, storage_key, deleting_at
       FROM cms_assets
      WHERE id = $1
      FOR UPDATE`,
    [assetId],
  );
  const asset = rows[0];
  if (!asset) return null;
  const { rows: references } = await db.query(
    `SELECT 1
       FROM cms_revisions r
       CROSS JOIN LATERAL jsonb_array_elements(r.blocks) block
       WHERE lower(block->>'asset_id') = lower($1::text)
      LIMIT 1`,
    [assetId],
  );
  if (references[0]) {
    if (asset.deleting_at) {
      await db.query(
        'UPDATE cms_assets SET deleting_at = NULL WHERE id = $1 AND deleting_at IS NOT NULL',
        [assetId],
      );
    }
    return { referenced: true, cleared: Boolean(asset.deleting_at) };
  }
  if (asset.deleting_at) {
    return reservationIsActive(asset.deleting_at) ? { asset, deleting: true } : { asset, retry: true };
  }
  const { rows: reserved } = await db.query(
    `UPDATE cms_assets
        SET deleting_at = NOW()
      WHERE id = $1 AND deleting_at IS NULL
      RETURNING id, storage_key`,
    [assetId],
  );
  return reserved[0] ? { asset: reserved[0] } : { asset, deleting: true };
}

function reservationIsActive(value) {
  const markedAt = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(markedAt) && Date.now() - markedAt < 60 * 1000;
}

async function finalizeUnreferencedAsset(db, assetId, { lock = true } = {}) {
  if (lock) await lockCmsAssets(db);
  const { rows } = await db.query(
    `DELETE FROM cms_assets
      WHERE id = $1
        AND deleting_at IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
             FROM cms_revisions r
             CROSS JOIN LATERAL jsonb_array_elements(r.blocks) block
           WHERE lower(block->>'asset_id') = lower($1::text)
         )
       RETURNING id`,
    [assetId],
  );
  if (rows[0]) return rows[0];
  const { rows: references } = await db.query(
    `SELECT 1
       FROM cms_revisions r
       CROSS JOIN LATERAL jsonb_array_elements(r.blocks) block
       WHERE lower(block->>'asset_id') = lower($1::text)
       LIMIT 1`,
    [assetId],
  );
  if (references[0]) {
    await db.query(
      'UPDATE cms_assets SET deleting_at = NULL WHERE id = $1 AND deleting_at IS NOT NULL',
      [assetId],
    );
    return { referenced: true };
  }
  return null;
}

async function auditAssetAction(db, req, action, targetId, details = {}) {
  await db.query(
    `INSERT INTO audit_log (actor_uid, action, target_type, target_id, request_id, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [req.user.uid, action, 'cms_asset', targetId || null, req.id, JSON.stringify(details)],
  );
}

async function deleteUnreferencedAsset(req, assetId, {
  dbPool = pool,
  fileSystem = fsp,
  directory = privateDirectory,
} = {}) {
  const client = await dbPool.connect();
  let inTransaction = false;
  const commit = async () => {
    await client.query('COMMIT');
    inTransaction = false;
  };
  try {
    await client.query('BEGIN');
    inTransaction = true;
    await lockCmsAssets(client);

    const reservation = await reserveUnreferencedAsset(client, assetId, { lock: false });
    if (!reservation) {
      await commit();
      return { status: 404, body: { error: 'Asset not found.', reason: 'not_found', requestId: req.id } };
    }
    await auditAssetAction(client, req, 'cms.asset.delete.reserve', assetId, {
      outcome: reservation.referenced ? 'referenced' : reservation.deleting ? 'already_deleting' : reservation.retry ? 'retry' : 'reserved',
    });
    if (reservation.referenced) {
      await commit();
      return { status: 409, body: { error: 'Asset is still referenced by CMS content.', reason: 'referenced', requestId: req.id } };
    }
    if (reservation.deleting) {
      await commit();
      return { status: 409, body: { error: 'Asset cleanup is already in progress.', reason: 'already_deleting', requestId: req.id } };
    }

    const storageKey = String(reservation.asset.storage_key);
    if (path.basename(storageKey) !== storageKey) {
      await client.query('UPDATE cms_assets SET deleting_at = NULL WHERE id = $1 AND deleting_at IS NOT NULL', [assetId]);
      await commit();
      return { status: 500, body: { error: 'Invalid asset storage key.', requestId: req.id } };
    }
    try {
      await fileSystem.unlink(path.join(directory, storageKey));
    } catch (error) {
      if (error.code === 'ENOENT') {
        // A missing file is already in the desired physical state; finalize the row below.
      } else {
        await client.query('UPDATE cms_assets SET deleting_at = NULL WHERE id = $1 AND deleting_at IS NOT NULL', [assetId]);
        await auditAssetAction(client, req, 'cms.asset.delete.finalize', assetId, { outcome: 'unlink_failed' });
        await commit();
        throw error;
      }
    }

    let deleted;
    try {
      await client.query('SAVEPOINT cms_asset_finalize');
      deleted = await finalizeUnreferencedAsset(client, assetId, { lock: false });
      const outcome = deleted?.referenced ? 'referenced' : deleted ? 'deleted' : 'pending';
      await auditAssetAction(client, req, 'cms.asset.delete.finalize', assetId, { outcome });
      await client.query('RELEASE SAVEPOINT cms_asset_finalize');
    } catch {
      await client.query('ROLLBACK TO SAVEPOINT cms_asset_finalize');
      await client.query('UPDATE cms_assets SET deleting_at = NULL WHERE id = $1 AND deleting_at IS NOT NULL', [assetId]);
      await auditAssetAction(client, req, 'cms.asset.delete.finalize', assetId, { outcome: 'pending' });
      await client.query('RELEASE SAVEPOINT cms_asset_finalize');
      await commit();
      return { status: 202, body: { error: 'Asset cleanup is pending.', reason: 'pending', requestId: req.id } };
    }

    if (deleted?.referenced) {
      await commit();
      return { status: 409, body: { error: 'Asset is still referenced by CMS content.', reason: 'referenced', requestId: req.id } };
    }
    if (!deleted) {
      await commit();
      return { status: 202, body: { error: 'Asset cleanup is pending.', reason: 'pending', requestId: req.id } };
    }
    await commit();
    return { status: 204 };
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function canReadAsset(db, user, asset) {
  const { rows } = await db.query(
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
         WHERE lower(block->>'asset_id') = lower($1::text)
        AND r.status IN ('draft', 'published', 'scheduled')`,
    [asset.id],
  );
  return rows.some((row) => referenceIsReadable(row, user, asset));
}

function uploadMiddleware(req, res, next) {
  if (!manageable(req.user)) return forbidden(req, res);
  upload.single('asset')(req, res, (error) => {
    if (!error) return handleAssetUpload(req, res, next);
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Asset too large.', requestId: req.id });
    }
    if (error instanceof multer.MulterError
      || error.code === 'LIMIT_UNEXPECTED_FILE' || error.code === 'LIMIT_FILE_COUNT') {
      return invalid(req, res);
    }
    return isMalformedMultipart(error) ? invalid(req, res) : next(error);
  });
}

async function handleAssetUpload(req, res, next) {
  if (!manageable(req.user)) return forbidden(req, res);
  if (!req.file || !req.file.buffer?.length) return invalid(req, res);
  const mimeType = detectedMime(req.file.buffer);
  if (!mimeType || mimeType !== req.file.mimetype || req.file.size < 1) return invalid(req, res);
  const maxSize = mimeType === 'application/pdf' ? MAX_PDF_SIZE : MAX_ASSET_SIZE;
  if (req.file.size > maxSize) return res.status(413).json({ error: 'Asset too large.', requestId: req.id });
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
}

router.post('/', authMiddleware, uploadMiddleware);

router.delete('/:id', authMiddleware, async (req, res, next) => {
  if (!manageable(req.user)) return forbidden(req, res);
  if (!uuid(req.params.id)) return invalid(req, res);
  const assetId = req.params.id;
  try {
    const result = await deleteUnreferencedAsset(req, assetId);
    if (result.status === 204) return res.status(204).end();
    return res.status(result.status).json(result.body);
  } catch (error) {
    return next(error);
  }
});

router.get('/:id', authMiddleware, async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  let db;
  let file;
  let stream;
  let inTransaction = false;
  let released = false;
  try {
    db = await pool.connect();
    await db.query('BEGIN');
    inTransaction = true;
    await lockCmsAssets(db);
    const { rows } = await db.query(
      `SELECT id, storage_key, original_name, mime_type, byte_size, created_at
         FROM cms_assets WHERE id = $1 AND deleting_at IS NULL`,
      [req.params.id],
    );
    const asset = rows[0];
    if (!asset) {
      await db.query('ROLLBACK');
      inTransaction = false;
      db.release();
      released = true;
      return res.status(404).json({ error: 'Asset not found.', requestId: req.id });
    }
    if (!await canReadAsset(db, req.user, asset)) {
      await db.query('ROLLBACK');
      inTransaction = false;
      db.release();
      released = true;
      return forbidden(req, res);
    }

    file = await fsp.open(path.join(privateDirectory, asset.storage_key), 'r');
    stream = file.createReadStream();
    file = null;
    await db.query('COMMIT');
    inTransaction = false;
    db.release();
    released = true;
    res.set({
      'Content-Length': String(asset.byte_size),
      'Content-Type': asset.mime_type,
      'Content-Disposition': `inline; filename="${asset.original_name.replace(/["\\\r\n]/g, '_')}"`,
      'X-Content-Type-Options': 'nosniff',
    });
    stream.on('error', next).pipe(res);
  } catch (error) {
    stream?.destroy();
    if (file) await file.close().catch(() => {});
    if (inTransaction) await db.query('ROLLBACK').catch(() => {});
    next(error);
  } finally {
    if (!released && db) db.release();
  }
});

module.exports = router;
module.exports.detectedMime = detectedMime;
module.exports.isMalformedMultipart = isMalformedMultipart;
module.exports.deleteUnreferencedAsset = deleteUnreferencedAsset;
