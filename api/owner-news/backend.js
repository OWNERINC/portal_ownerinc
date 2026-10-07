const { getAuthority } = require('./authority');
const legacy = require('../cms/reader');
const { getPublishedHome } = require('./home');
const { createPayloadNewsClient } = require('./payload-client');
const { validInput, unavailable } = require('./payload-dto');
const { validateNewsRevision, estimateNewsReadTime } = require('./editorial');
const { lockCmsAssets } = require('../cms/locks');
const { open, lstat } = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const missing = () => Object.assign(new Error('not_found'), { status: 404 });
async function legacyTransaction(pool, work) {
  const db = await pool.connect();
  try { await db.query('BEGIN'); await lockCmsAssets(db); const result = await work(db); await db.query('COMMIT'); return result; }
  catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
  finally { db.release(); }
}
async function legacyPreview(pool, input) {
  if (input.source !== 'legacy') throw missing();
  return legacyTransaction(pool, async db => {
    const { rows } = await db.query(`SELECT d.id, d.title, d.category, d.published_at, r.blocks, r.editorial, r.status
      FROM cms_documents d JOIN cms_revisions r ON r.document_id=d.id
      WHERE d.id=$1 AND r.id=$2 AND d.content_type='announcement'`, [input.id, input.versionId]);
    const row = rows[0]; if (!row) throw missing();
    const revision = validateNewsRevision(row.blocks, row.editorial ?? null);
    if (!revision || !(await legacy.validatePublishedBlocks(db, revision.blocks)).blocks) throw missing();
    return { id: row.id, title: row.title, category: row.category, published_at: row.published_at,
      editorial: revision.editorial, content_version: 2, asset_scope: 'owner-news-preview', content_blocks: revision.blocks,
      read_time_minutes: estimateNewsReadTime(revision.blocks, revision.editorial),
      preview_revision: { id: input.versionId, source: 'legacy', status: row.status } };
  });
}
async function legacyAsset(pool, input, { signal } = {}) {
  let file;
  try {
    const result = await legacyTransaction(pool, async db => {
      const { rows } = await db.query('SELECT id, storage_key, mime_type, byte_size FROM cms_assets WHERE id=$1 AND deleting_at IS NULL', [input.id]);
      const asset = rows[0]; if (!asset) throw missing();
      const refs = await db.query(`SELECT r.blocks, r.editorial FROM cms_revisions r JOIN cms_documents d ON d.id=r.document_id
        WHERE d.content_type='announcement' AND ($2::boolean OR (d.published_revision_id=r.id AND r.status='published'))
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(r.blocks) b WHERE lower(b->>'asset_id')=$1)`, [input.id, input.preview]);
      let allowed = false;
      for (const row of refs.rows) {
        const revision = validateNewsRevision(row.blocks, row.editorial ?? null, { publishing: !input.preview });
        if (revision && (await legacy.validatePublishedBlocks(db, revision.blocks)).blocks) { allowed = true; break; }
      }
      if (!allowed) throw Object.assign(new Error('forbidden'), { status: 403 });
      const size = Number(asset.byte_size);
      if (!Number.isSafeInteger(size) || size < 1 || size > 50 * 1024 * 1024 || typeof asset.storage_key !== 'string' || !/^[a-zA-Z0-9._-]+$/u.test(asset.storage_key) || ['.', '..'].includes(asset.storage_key)) throw unavailable();
      const filename = path.join(process.env.UPLOAD_DIR || '/app/uploads', 'cms-private', asset.storage_key);
      const stat = await lstat(filename); if (!stat.isFile() || stat.isSymbolicLink()) throw unavailable();
      file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const opened = await file.stat(); if (opened.size !== size || stat.ino !== opened.ino || stat.dev !== opened.dev) throw unavailable();
      const supportsRange = asset.mime_type === 'application/pdf' || asset.mime_type.startsWith('video/');
      let start = 0, end = size - 1;
      const headers = { 'Content-Type': asset.mime_type, 'Content-Disposition': `inline; filename="${asset.storage_key}"`, 'Cache-Control': 'private,no-store', 'X-Content-Type-Options': 'nosniff' };
      if (supportsRange) headers['Accept-Ranges'] = 'bytes';
      if (input.range && supportsRange) {
        const m = /^bytes=(\d*)-(\d*)$/u.exec(input.range);
        if (m && (m[1] || m[2])) { start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])); end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1; }
        if (!m || (!m[1] && !m[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return { status: 416, headers: { ...headers, 'Content-Length': '0', 'Content-Range': `bytes */${size}` }, body: null };
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      }
      headers['Content-Length'] = String(end - start + 1);
      return { status: headers['Content-Range'] ? 206 : 200, headers, start, end };
    });
    if (!('start' in result)) { await file.close(); return result; }
    const stream = file.createReadStream({ start: result.start, end: result.end, signal }); file = null;
    return { status: result.status, headers: result.headers, body: Readable.toWeb(stream) };
  } catch (error) { await file?.close().catch(() => {}); if ([403, 404].includes(error.status)) throw error; throw unavailable(); }
}

function createNewsBackend({ pool, payloadClient }) {
  // Lazy construction: a legacy deployment does not need any CMS credentials to boot.
  const client = () => payloadClient || (payloadClient = createPayloadNewsClient({ baseURL: process.env.CMS_INTERNAL_URL, secret: process.env.PORTAL_TO_PAYLOAD_SECRET }));
  async function run(action, input, actor, options) {
    if (!validInput(action, input)) throw Object.assign(new Error('invalid_request'), { status: 400 });
    if (!actor?.uid) throw Object.assign(new Error('unauthorized'), { status: 401 });
    if ((action === 'preview' || (action === 'asset' && input.preview)) && !actor.canManageNews) throw Object.assign(new Error('forbidden'), { status: 403 });
    let authority;
    try { authority = await getAuthority(pool); } catch { throw unavailable(); }
    if (['payload', 'payload_frozen'].includes(authority.mode)) {
      try { return action === 'asset' ? await client().asset(input, actor, options) : await client().query(action, input, actor, options); }
      catch (error) { if ([403, 404].includes(error.status)) throw Object.assign(new Error(error.status === 404 ? 'not_found' : 'forbidden'), { status: error.status }); throw unavailable(); }
    }
    try {
      switch (action) {
        case 'list': return await legacy.listPublishedAnnouncements(pool, input.limit, input.offset, input.category, input.kind);
        case 'detail': return await legacy.getPublishedAnnouncement(pool, input.id);
        case 'categories': return await legacy.listPublishedAnnouncementCategories(pool, input);
        case 'navigation': return await legacy.getPublishedAnnouncementNavigation(pool, input.id, input.category);
        case 'home': return { content: await getPublishedHome(pool) };
        case 'preview': return await legacyPreview(pool, input);
        case 'asset': return await legacyAsset(pool, input, options);
        default: throw unavailable();
      }
    } catch (error) { if ([403, 404].includes(error.status)) throw error; throw unavailable(); }
  }
  return Object.fromEntries(['list', 'detail', 'categories', 'navigation', 'home', 'preview', 'asset'].map(action => [action, (input, actor, options) => run(action, input, actor, options)]));
}
module.exports = { createNewsBackend };
