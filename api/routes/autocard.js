const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { canUseAutoCard } = require('../middleware/policy');
const { normalizeImage } = require('../middleware/validation');
const { forbidden, invalid, parseListQuery, uuid, withAudit } = require('../route-utils');

const router = express.Router();
const uploadDirectory = process.env.UPLOAD_DIR || '/app/uploads';
const templates = new Set(['comunicado', 'vaga', 'aniversariante', 'novo_funcionario']);
const modes = new Set(['light', 'dark', 'beige']);
const variants = new Set(['editorial', 'noir', 'beige']);
const mediaSizes = new Set(['small', 'medium', 'large']);
const maxMediaBytes = 3 * 1024 * 1024;
const defaultMediaCrop = { x: 0.5, y: 0.5, zoom: 1 };
const maxMediaCropZoom = 3;

function parseMediaCrop(value) {
  if (value == null) return { ...defaultMediaCrop };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { x, y, zoom } = value;
  if (![x, y, zoom].every(Number.isFinite)) return null;
  if (x < 0 || x > 1 || y < 0 || y > 1 || zoom < 1 || zoom > maxMediaCropZoom) return null;
  return { x, y, zoom };
}

function requireAutoCard(req, res, next) {
  return canUseAutoCard(req.user) ? next() : forbidden(req, res);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('Payload too large.');
        error.code = 'LIMIT_FILE_SIZE';
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseCard(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 120) return null;
  if (!templates.has(body.template) || !body.values || typeof body.values !== 'object' || Array.isArray(body.values)) return null;
  if (JSON.stringify(body.values).length > 50000) return null;
  if (body.icon != null && (typeof body.icon !== 'string' || body.icon.length > 80)) return null;
  if (body.illustration != null && (typeof body.illustration !== 'string' || body.illustration.length > 80)) return null;
  if (!modes.has(body.mode || 'light') || !variants.has(body.variant || 'editorial') || !mediaSizes.has(body.mediaSize || 'medium')) return null;
  if (body.mediaId != null && !uuid(body.mediaId)) return null;
  const mediaCrop = parseMediaCrop(body.mediaCrop);
  if (!mediaCrop) return null;
  return {
    name: body.name.trim(),
    template: body.template,
    values: body.values,
    icon: body.icon || null,
    illustration: body.illustration || null,
    mode: body.mode || 'light',
    variant: body.variant || 'editorial',
    mediaSize: body.mediaSize || 'medium',
    mediaId: body.mediaId || null,
    mediaCrop,
  };
}

async function mediaExists(client, mediaId) {
  if (!mediaId) return true;
  const result = await client.query('SELECT 1 FROM autocard_media WHERE id = $1', [mediaId]);
  return result.rowCount === 1;
}

async function removeMediaIfUnused(mediaId) {
  if (!mediaId) return;
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT m.storage_key FROM autocard_media m
       WHERE m.id = $1 AND NOT EXISTS (SELECT 1 FROM autocard_cards c WHERE c.media_id = m.id)`,
      [mediaId],
    );
    if (!result.rowCount) return;
    await client.query('DELETE FROM autocard_media WHERE id = $1', [mediaId]);
    await fs.unlink(path.join(uploadDirectory, result.rows[0].storage_key)).catch(() => {});
  } finally {
    client.release();
  }
}

router.use(authMiddleware, requireAutoCard);

router.get('/access', (req, res) => res.json({ allowed: true }));

router.get('/cards', async (req, res, next) => {
  const page = parseListQuery(req.query, {
    search: value => value.length <= 120,
    template: value => !value || templates.has(value),
  });
  if (!page) return invalid(req, res);
  try {
    const search = req.query.search || '';
    const template = req.query.template || '';
    const filters = [];
    const values = [];
    if (search) { values.push(`%${search}%`); filters.push(`name ILIKE $${values.length}`); }
    if (template) { values.push(template); filters.push(`template = $${values.length}`); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const [cards, count] = await Promise.all([
      pool.query(`SELECT id, name, template, "values", icon, illustration, mode, variant, media_size AS "mediaSize", media_id AS "mediaId", media_crop AS "mediaCrop", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM autocard_cards ${where} ORDER BY updated_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, page.limit, page.offset]),
      pool.query(`SELECT COUNT(*)::integer AS total FROM autocard_cards ${where}`, values),
    ]);
    res.setHeader('X-Total-Count', count.rows[0].total);
    return res.json(cards.rows);
  } catch (error) { return next(error); }
});

router.post('/cards', async (req, res, next) => {
  const card = parseCard(req.body);
  if (!card) return invalid(req, res);
  try {
    const result = await withAudit(pool, req, 'autocard.card.create', 'autocard_card', async (client) => {
      if (!await mediaExists(client, card.mediaId)) return null;
      const { rows } = await client.query(
         `INSERT INTO autocard_cards (name, template, "values", icon, illustration, mode, variant, media_size, media_id, media_crop, created_by)
          VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
          RETURNING id, name, template, "values", icon, illustration, mode, variant, media_size AS "mediaSize", media_id AS "mediaId", media_crop AS "mediaCrop", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`,
         [card.name, card.template, JSON.stringify(card.values), card.icon, card.illustration, card.mode, card.variant, card.mediaSize, card.mediaId, JSON.stringify(card.mediaCrop), req.user.uid],
      );
      return rows[0];
    }, { targetId: result => result?.id });
    if (!result) return invalid(req, res);
    return res.status(201).json(result);
  } catch (error) { return next(error); }
});

router.get('/cards/:id', async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const { rows } = await pool.query(
      `SELECT id, name, template, "values", icon, illustration, mode, variant, media_size AS "mediaSize", media_id AS "mediaId", media_crop AS "mediaCrop", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM autocard_cards WHERE id = $1`, [req.params.id],
    );
    return rows[0] ? res.json(rows[0]) : res.status(404).json({ error: 'Card não encontrado.', requestId: req.id });
  } catch (error) { return next(error); }
});

router.put('/cards/:id', async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  const card = parseCard(req.body);
  if (!card) return invalid(req, res);
  try {
    const result = await withAudit(pool, req, 'autocard.card.update', 'autocard_card', async (client) => {
      if (!await mediaExists(client, card.mediaId)) return null;
      const { rows } = await client.query(
       `UPDATE autocard_cards SET name = $2, template = $3, "values" = $4::jsonb, icon = $5, illustration = $6, mode = $7, variant = $8, media_size = $9, media_id = $10, media_crop = $11::jsonb, updated_at = NOW()
          WHERE id = $1
          RETURNING id, name, template, "values", icon, illustration, mode, variant, media_size AS "mediaSize", media_id AS "mediaId", media_crop AS "mediaCrop", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`,
         [req.params.id, card.name, card.template, JSON.stringify(card.values), card.icon, card.illustration, card.mode, card.variant, card.mediaSize, card.mediaId, JSON.stringify(card.mediaCrop)],
      );
      return rows[0] || null;
    }, { targetId: result => result?.id });
    if (!result) return res.status(404).json({ error: 'Card não encontrado.', requestId: req.id });
    return res.json(result);
  } catch (error) { return next(error); }
});

router.post('/cards/:id/duplicate', async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const result = await withAudit(pool, req, 'autocard.card.duplicate', 'autocard_card', async (client) => {
      const { rows } = await client.query(
         `INSERT INTO autocard_cards (name, template, "values", icon, illustration, mode, variant, media_size, media_id, media_crop, created_by)
          SELECT name || ' v2', template, "values", icon, illustration, mode, variant, media_size, media_id, media_crop, $2
          FROM autocard_cards WHERE id = $1
          RETURNING id, name, template, "values", icon, illustration, mode, variant, media_size AS "mediaSize", media_id AS "mediaId", media_crop AS "mediaCrop", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [req.params.id, req.user.uid],
      );
      return rows[0] || null;
    }, { targetId: result => result?.id });
    if (!result) return res.status(404).json({ error: 'Card não encontrado.', requestId: req.id });
    return res.status(201).json(result);
  } catch (error) { return next(error); }
});

router.delete('/cards/:id', async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const result = await withAudit(pool, req, 'autocard.card.delete', 'autocard_card', async (client) => {
      const { rows } = await client.query('DELETE FROM autocard_cards WHERE id = $1 RETURNING id, media_id AS "mediaId"', [req.params.id]);
      return rows[0] || null;
    }, { targetId: result => result?.id });
    if (!result) return res.status(404).json({ error: 'Card não encontrado.', requestId: req.id });
    await removeMediaIfUnused(result.mediaId);
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

router.post('/media', async (req, res, next) => {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) return res.status(415).json({ error: 'Formato de imagem não permitido.', requestId: req.id });
  let storageKey;
  try {
    const content = await readBody(req, maxMediaBytes);
    const normalized = await normalizeImage(content);
    const id = crypto.randomUUID();
    storageKey = `autocard-${id}.webp`;
    await fs.mkdir(uploadDirectory, { recursive: true });
    await fs.writeFile(path.join(uploadDirectory, storageKey), normalized, { flag: 'wx' });
    const result = await withAudit(pool, req, 'autocard.media.create', 'autocard_media', async (client) => {
      const { rows } = await client.query(
        `INSERT INTO autocard_media (id, storage_key, content_type, byte_size, created_by)
         VALUES ($1, $2, 'image/webp', $3, $4)
          RETURNING id, '/api/autocard/media/' || id AS url, byte_size AS "byteSize", content_type AS "contentType"`,
        [id, storageKey, normalized.length, req.user.uid],
      );
      return rows[0];
    }, { targetId: result => result?.id });
    return res.status(201).json(result);
  } catch (error) {
    if (storageKey) await fs.unlink(path.join(uploadDirectory, storageKey)).catch(() => {});
    return next(error);
  }
});

router.get('/media/:id', async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const { rows } = await pool.query('SELECT storage_key, content_type FROM autocard_media WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Mídia não encontrada.', requestId: req.id });
    res.setHeader('Content-Type', rows[0].content_type);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.sendFile(path.join(uploadDirectory, rows[0].storage_key));
  } catch (error) { return next(error); }
});

module.exports = router;
