const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const pool = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { canUsePosCards } = require('../middleware/policy');
const { normalizeImage, sanitizeRichValues } = require('../middleware/validation');
const { forbidden, invalid, parseListQuery, uuid, withAudit } = require('../route-utils');

const router = express.Router();
const uploadDirectory = process.env.UPLOAD_DIR || '/app/uploads';
const templates = new Set(['convite_owntime', 'convite_owner']);
const maxMediaBytes = 3 * 1024 * 1024;
// Share the media-retention lock with AutoCard so reference writes cannot race cleanup.
const posCardsLock = 7193003;

function requirePosCards(req, res, next) {
  return canUsePosCards(req.user) ? next() : forbidden(req, res);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        const error = new Error('Payload too large.');
        error.code = 'LIMIT_FILE_SIZE';
        settled = true;
        reject(error);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!settled) resolve(Buffer.concat(chunks)); });
    req.on('error', error => { if (!settled) reject(error); });
  });
}

function parseCard(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length < 1 || name.length > 120 || !templates.has(body.template)) return null;
  if (!body.values || typeof body.values !== 'object' || Array.isArray(body.values)) return null;
  let values;
  let serializedValues;
  try {
    values = sanitizeRichValues(body.values);
    serializedValues = JSON.stringify(values);
  } catch {
    return null;
  }
  if (serializedValues.length > 50000) return null;
  if (body.mediaId != null && !uuid(body.mediaId)) return null;
  return { name, template: body.template, values, mediaId: body.mediaId || null };
}

function safeCard(card) {
  return card ? { ...card, values: sanitizeRichValues(card.values) } : card;
}

async function mediaExists(client, mediaId) {
  if (!mediaId) return true;
  const result = await client.query('SELECT 1 FROM pos_card_media WHERE id = $1', [mediaId]);
  return result.rowCount === 1;
}

async function removeMediaIfUnused(mediaId) {
  if (!mediaId) return;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(${posCardsLock})`);
    const result = await client.query(
      `SELECT m.storage_key FROM pos_card_media m
       WHERE m.id = $1 AND NOT EXISTS (SELECT 1 FROM pos_cards c WHERE c.media_id = m.id)`,
      [mediaId],
    );
    if (!result.rowCount) {
      await client.query('COMMIT');
      return;
    }
    await client.query('DELETE FROM pos_card_media WHERE id = $1', [mediaId]);
    await client.query('COMMIT');
    await fs.unlink(path.join(uploadDirectory, result.rows[0].storage_key)).catch(() => {});
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

router.use(authMiddleware, requirePosCards);

router.get('/access', (req, res) => res.json({ allowed: true }));

router.get('/cards', async (req, res, next) => {
  const page = parseListQuery(req.query, { search: value => value.length <= 120 });
  if (!page) return invalid(req, res);
  try {
    const search = req.query.search || '';
    const escapedSearch = search.replace(/[\\%_]/g, '\\$&');
    const values = [];
    const where = search ? (values.push(`%${escapedSearch}%`), `WHERE name ILIKE $${values.length} ESCAPE '\\'`) : '';
    const [cards, count] = await Promise.all([
      pool.query(`SELECT id, name, template, "values", media_id AS "mediaId", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
        FROM pos_cards ${where} ORDER BY updated_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, page.limit, page.offset]),
      pool.query(`SELECT COUNT(*)::integer AS total FROM pos_cards ${where}`, values),
    ]);
    res.setHeader('X-Total-Count', count.rows[0].total);
    return res.json(cards.rows.map(safeCard));
  } catch (error) { return next(error); }
});

router.post('/cards', async (req, res, next) => {
  const card = parseCard(req.body);
  if (!card) return invalid(req, res);
  try {
    const result = await withAudit(pool, req, 'pos-cards.card.create', 'pos_card', async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(${posCardsLock})`);
      if (!await mediaExists(client, card.mediaId)) return null;
      const { rows } = await client.query(
        `INSERT INTO pos_cards (name, template, "values", media_id, created_by)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         RETURNING id, name, template, "values", media_id AS "mediaId", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [card.name, card.template, JSON.stringify(card.values), card.mediaId, req.user.uid],
      );
      return rows[0];
    }, { targetId: result => result?.id });
    if (!result) return res.status(404).json({ error: 'Mídia não encontrada.', requestId: req.id });
    return res.status(201).json(safeCard(result));
  } catch (error) { return next(error); }
});

router.get('/cards/:id', async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const { rows } = await pool.query(
      `SELECT id, name, template, "values", media_id AS "mediaId", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"
       FROM pos_cards WHERE id = $1`, [req.params.id],
    );
    return rows[0] ? res.json(safeCard(rows[0])) : res.status(404).json({ error: 'Card não encontrado.', requestId: req.id });
  } catch (error) { return next(error); }
});

router.put('/cards/:id', async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  const card = parseCard(req.body);
  if (!card) return invalid(req, res);
  try {
    const result = await withAudit(pool, req, 'pos-cards.card.update', 'pos_card', async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(${posCardsLock})`);
      const current = await client.query('SELECT media_id FROM pos_cards WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!current.rowCount || !await mediaExists(client, card.mediaId)) return null;
      const { rows } = await client.query(
        `UPDATE pos_cards SET name = $2, template = $3, "values" = $4::jsonb, media_id = $5, updated_at = NOW()
         WHERE id = $1
         RETURNING id, name, template, "values", media_id AS "mediaId", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [req.params.id, card.name, card.template, JSON.stringify(card.values), card.mediaId],
      );
      return { card: rows[0], oldMediaId: current.rows[0].media_id };
    }, { targetId: result => result?.card?.id });
    if (!result) return res.status(404).json({ error: 'Card ou mídia não encontrado.', requestId: req.id });
    if (result.oldMediaId !== result.card.mediaId) await removeMediaIfUnused(result.oldMediaId);
    return res.json(safeCard(result.card));
  } catch (error) { return next(error); }
});

router.post('/cards/:id/duplicate', async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const result = await withAudit(pool, req, 'pos-cards.card.duplicate', 'pos_card', async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(${posCardsLock})`);
      const source = await client.query('SELECT name, template, "values", media_id AS "mediaId" FROM pos_cards WHERE id = $1', [req.params.id]);
      if (!source.rowCount) return null;
      const { rows } = await client.query(
        `INSERT INTO pos_cards (name, template, "values", media_id, created_by)
         VALUES (LEFT($1 || ' v2', 120), $2, $3::jsonb, $4, $5)
         RETURNING id, name, template, "values", media_id AS "mediaId", created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [source.rows[0].name, source.rows[0].template, JSON.stringify(sanitizeRichValues(source.rows[0].values)), source.rows[0].mediaId, req.user.uid],
      );
      return rows[0] || null;
    }, { targetId: result => result?.id });
    if (!result) return res.status(404).json({ error: 'Card não encontrado.', requestId: req.id });
    return res.status(201).json(safeCard(result));
  } catch (error) { return next(error); }
});

router.delete('/cards/:id', async (req, res, next) => {
  if (!uuid(req.params.id)) return invalid(req, res);
  try {
    const result = await withAudit(pool, req, 'pos-cards.card.delete', 'pos_card', async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(${posCardsLock})`);
      const { rows } = await client.query('DELETE FROM pos_cards WHERE id = $1 RETURNING id, media_id AS "mediaId"', [req.params.id]);
      return rows[0] || null;
    }, { targetId: result => result?.id });
    if (!result) return res.status(404).json({ error: 'Card não encontrado.', requestId: req.id });
    await removeMediaIfUnused(result.mediaId);
    return res.json({ ok: true });
  } catch (error) { return next(error); }
});

router.post('/media', async (req, res, next) => {
  const contentType = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
    return res.status(415).json({ error: 'Formato de imagem não permitido.', requestId: req.id });
  }
  let storageKey;
  try {
    const content = await readBody(req, maxMediaBytes);
    let normalized;
    try {
      normalized = await normalizeImage(content);
    } catch {
      return invalid(req, res);
    }
    const id = crypto.randomUUID();
    storageKey = `pos-card-${id}.webp`;
    await fs.mkdir(uploadDirectory, { recursive: true });
    await fs.writeFile(path.join(uploadDirectory, storageKey), normalized, { flag: 'wx' });
    const result = await withAudit(pool, req, 'pos-cards.media.create', 'pos_card_media', async (client) => {
      const { rows } = await client.query(
        `INSERT INTO pos_card_media (id, storage_key, content_type, byte_size, created_by)
         VALUES ($1, $2, 'image/webp', $3, $4)
         RETURNING id, '/api/pos-cards/media/' || id AS url, byte_size AS "byteSize", content_type AS "contentType"`,
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
    const { rows } = await pool.query('SELECT storage_key, content_type FROM pos_card_media WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Mídia não encontrada.', requestId: req.id });
    res.setHeader('Content-Type', rows[0].content_type);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.sendFile(path.join(uploadDirectory, rows[0].storage_key));
  } catch (error) { return next(error); }
});

module.exports = router;
