const { getAuthority } = require('./authority');
const legacy = require('../cms/reader');
const { getPublishedHome } = require('./home');
const { createPayloadNewsClient, payloadRuntimeState } = require('./payload-client');
const { validPublicInput, unavailable } = require('./payload-dto');
const { compareNews, encodeNewsCursor, assertUniqueNewsRows } = require('./feed');
const { validateNewsRevision, announcementKind, estimateNewsReadTime } = require('./editorial');
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
    return { source: 'legacy', id: row.id, title: row.title, category: row.category, published_at: row.published_at,
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

const controlled = (status, code) => Object.assign(new Error(code), { status, code });
const safeRequestId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(value) ? value : null;
const withoutSource = input => Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'source'));
const sourceOf = input => ['legacy', 'payload'].includes(input?.source) ? input.source : null;

function createNewsBackend({ pool, payloadClient, legacyReader = legacy, homeReader = getPublishedHome,
  legacyPreviewReader = legacyPreview, legacyAssetReader = legacyAsset, logger = console.error } = {}) {
  const suppliedPayloadClient = Boolean(payloadClient);
  // Lazy construction: a legacy deployment with both values absent stays healthy.
  const client = () => payloadClient || (payloadClient = createPayloadNewsClient({ baseURL: process.env.CMS_INTERNAL_URL, secret: process.env.PORTAL_TO_PAYLOAD_SECRET }));

  function payloadState(authority) {
    return payloadRuntimeState({ mode: authority.mode, baseURL: process.env.CMS_INTERNAL_URL,
      secret: process.env.PORTAL_TO_PAYLOAD_SECRET, suppliedClient: suppliedPayloadClient });
  }

  async function authority() {
    try { return await getAuthority(pool); } catch { throw unavailable(); }
  }

  function logDegraded(action, source, options) {
    try { logger(JSON.stringify({ code: 'owner_news_read_degraded', action, source, requestId: safeRequestId(options?.requestId) })); }
    catch { /* Observability must not turn a healthy partial response into an outage. */ }
  }

  async function capture(source, work) {
    try { return { source, ok: true, value: await work() }; }
    catch (error) {
      if (error?.code === 'news_duplicate_identity') throw error;
      return { source, ok: false };
    }
  }

  function inactiveValue(action, input) {
    if (action === 'list') return { rows: [], count: 0 };
    if (action === 'categories') return input.withCounts ? { total: 0, categories: [] } : [];
    if (action === 'home') return { content: null };
    return null;
  }

  async function payloadComposite(action, input, actor, options, currentAuthority) {
    const state = payloadState(currentAuthority);
    if (state === 'inactive') return inactiveValue(action, input);
    if (state === 'unavailable') throw unavailable();
    return client().query(action, input, actor, options);
  }

  function finishComposite(action, results, options, combine, { hasCursor = false } = {}) {
    const failed = results.filter(result => !result.ok);
    if (failed.length === results.length) throw unavailable();
    if (failed.length) {
      if (hasCursor) throw controlled(503, 'news_page_restart_required');
      logDegraded(action, failed.map(result => result.source).join(','), options);
    }
    const value = combine(results);
    if (failed.length && action === 'list') {
      value.count = null;
      value.nextCursor = null;
    }
    return { value, readState: failed.length ? 'degraded' : 'complete' };
  }

  async function runCompositeRead(action, input, actor, options, currentAuthority) {
    if (action === 'list') {
      if (payloadState(currentAuthority) === 'inactive') {
        const results = await Promise.all([
          capture('legacy', () => legacyReader.listPublishedAnnouncements(pool, input.limit + 1, input.offset, input.category, input.kind, input.boundary)),
          Promise.resolve({ source: 'payload', ok: true, value: { rows: [], count: 0 } }),
        ]);
        return finishComposite(action, results, options, values => {
          const legacyPage = values.find(value => value.source === 'legacy' && value.ok)?.value || { rows: [], count: 0 };
          assertUniqueNewsRows('legacy', legacyPage.rows);
          const rows = legacyPage.rows.slice(0, input.limit);
          return { rows, count: legacyPage.count,
            nextCursor: legacyPage.rows.length > input.limit && rows.length
              ? encodeNewsCursor(rows.at(-1), { category: input.category, kind: input.kind }) : null };
        }, { hasCursor: Boolean(input.boundary) || input.offset > 0 });
      }
      const wanted = Math.min(101, input.offset + input.limit + 1);
      const sourceInput = { limit: wanted, offset: 0,
        ...(input.category === undefined ? {} : { category: input.category }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.boundary ? { boundary: input.boundary } : {}) };
      const results = await Promise.all([
        capture('legacy', () => legacyReader.listPublishedAnnouncements(pool, wanted, 0, input.category, input.kind, input.boundary, { exactTotal: false })),
        capture('payload', () => payloadComposite('list', sourceInput, actor, options, currentAuthority)),
      ]);
      return finishComposite(action, results, options, values => {
        const bySource = Object.fromEntries(values.filter(v => v.ok).map(v => [v.source, v.value]));
        for (const source of ['legacy', 'payload']) if (bySource[source]) assertUniqueNewsRows(source, bySource[source].rows);
        const rows = [...(bySource.legacy?.rows || []), ...(bySource.payload?.rows || [])].sort(compareNews);
        const start = input.offset, page = rows.slice(start, start + input.limit);
        const hasMore = rows.length > start + input.limit;
        const counts = Object.values(bySource).map(result => result.count);
        const count = counts.every(Number.isSafeInteger) ? counts.reduce((sum, value) => sum + value, 0) : null;
        return { rows: page, count,
          nextCursor: hasMore && page.length ? encodeNewsCursor(page.at(-1), { category: input.category, kind: input.kind }) : null };
      }, { hasCursor: Boolean(input.boundary) || input.offset > 0 });
    }
    if (action === 'categories') {
      const sourceInput = { withCounts: true, ...(input.kind === undefined ? {} : { kind: input.kind }) };
      const results = await Promise.all([
        capture('legacy', () => legacyReader.listPublishedAnnouncementCategories(pool, sourceInput)),
        capture('payload', () => payloadComposite('categories', sourceInput, actor, options, currentAuthority)),
      ]);
      return finishComposite(action, results, options, values => {
        const counts = new Map(); let total = 0;
        for (const result of values.filter(v => v.ok)) {
          total += result.value.total;
          for (const category of result.value.categories) counts.set(category.name, (counts.get(category.name) || 0) + category.count);
        }
        const categories = [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, count]) => ({ name, count }));
        return input.withCounts ? { total, categories } : categories.map(category => category.name);
      });
    }
    if (action === 'home') {
      const results = await Promise.all([
        capture('legacy', async () => ({ content: await homeReader(pool) })),
        capture('payload', () => payloadComposite('home', {}, actor, options, currentAuthority)),
      ]);
      return finishComposite(action, results, options, values => {
        const bySource = Object.fromEntries(values.filter(v => v.ok).map(v => [v.source, v.value]));
        return bySource.payload?.content ? bySource.payload : (bySource.legacy || { content: null });
      });
    }
    throw unavailable();
  }

  async function directedSource(source, action, input, actor, options, currentAuthority) {
    try {
      if (source === 'payload') {
        if (payloadState(currentAuthority) !== 'active') throw unavailable();
        return action === 'asset' ? await client().asset(withoutSource(input), actor, options)
          : await client().query(action, action === 'preview' ? input : action === 'detail' ? { id: input.id } : withoutSource(input), actor, options);
      }
      if (action === 'detail') return await legacyReader.getPublishedAnnouncement(pool, input.id);
      if (action === 'preview') return await legacyPreviewReader(pool, input);
      if (action === 'asset') return await legacyAssetReader(pool, withoutSource(input), options);
      throw unavailable();
    } catch (error) {
      if ([403, 404].includes(error?.status)) throw controlled(error.status, error.status === 404 ? 'not_found' : 'forbidden');
      throw unavailable();
    }
  }

  async function collectSource(source, input, actor, options, currentAuthority) {
    const rows = []; let boundary = null;
    for (let batch = 0; batch < 1000; batch++) {
      const sourceInput = { limit: 101, offset: 0, ...(input.category === undefined ? {} : { category: input.category }), kind: 'article', ...(boundary ? { boundary } : {}) };
      const page = source === 'legacy'
        ? await legacyReader.listPublishedAnnouncements(pool, 101, 0, input.category, 'article', boundary, { exactTotal: false })
        : await payloadComposite('list', sourceInput, actor, options, currentAuthority);
      rows.push(...page.rows);
      assertUniqueNewsRows(source, rows);
      if (page.rows.length < 101) return rows;
      const last = page.rows.at(-1);
      const next = { published_at: last.published_at, source: last.source, id: last.id };
      if (boundary && compareNews(next, boundary) === 0) throw unavailable();
      boundary = next;
    }
    throw unavailable();
  }

  async function runNavigation(input, actor, options, currentAuthority) {
    const currentSource = input.source;
    const current = await directedSource(currentSource, 'detail', input, actor, options, currentAuthority);
    if (!current) throw controlled(404, 'not_found');
    if (announcementKind(current) === 'edition') return { value: { previous: null, next: null }, readState: 'complete' };
    const results = await Promise.all([
      capture('legacy', () => collectSource('legacy', input, actor, options, currentAuthority)),
      capture('payload', () => collectSource('payload', input, actor, options, currentAuthority)),
    ]);
    const own = results.find(result => result.source === currentSource);
    if (!own.ok) throw unavailable();
    return finishComposite('navigation', results, options, values => {
      const rows = values.filter(v => v.ok).flatMap(v => v.value).sort(compareNews);
      const at = rows.findIndex(row => row.source === currentSource && row.id === input.id);
      if (at < 0) throw controlled(404, 'not_found');
      const reference = row => row ? { source: row.source, id: row.id, title: row.title } : null;
      return { previous: reference(rows[at - 1]), next: reference(rows[at + 1]) };
    });
  }

  async function run(action, input, actor, options = {}) {
    const publicSource = sourceOf(input);
    if (!validPublicInput(action, input)) throw controlled(400, 'invalid_request');
    if (!actor?.uid) throw controlled(401, 'unauthorized');
    if ((action === 'preview' || (action === 'asset' && input.preview)) && !actor.canManageNews) throw controlled(403, 'forbidden');
    const currentAuthority = await authority();
    if (['list', 'categories', 'home'].includes(action)) return runCompositeRead(action, input, actor, options, currentAuthority);
    if (action === 'navigation') return runNavigation(input, actor, options, currentAuthority);
    const source = action === 'preview' ? input.source : publicSource;
    return { value: await directedSource(source, action, input, actor, options, currentAuthority), readState: 'complete' };
  }
  return Object.fromEntries(['list', 'detail', 'categories', 'navigation', 'home', 'preview', 'asset'].map(action => [action, (input, actor, options) => run(action, input, actor, options)]));
}
module.exports = { createNewsBackend };
