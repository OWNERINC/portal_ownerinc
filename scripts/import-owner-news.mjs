import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

const require = createRequire(new URL('../api/package.json', import.meta.url));
const { validateBlocks } = require('./cms/blocks.js');
const { lockCmsAssets } = require('./cms/locks.js');
export const ORIGIN = 'https://owner-news.ownerinc-developers.chatgpt.site';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_MEDIA = 50 * 1024 * 1024;
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function identity(kind, value) {
  const bytes = Buffer.from(hash(`${ORIGIN}\n${kind}\n${value}`).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function sourceUrl(value) {
  const url = new URL(value, ORIGIN);
  if (url.origin !== ORIGIN || url.username || url.password || url.hash
    || !['/api/cms', '/api/media'].includes(url.pathname) && !url.pathname.startsWith('/assets/')) {
    throw new Error('Source URL outside the approved HTTPS origin/paths');
  }
  return url.href;
}

export async function download(value, maxBytes, fetcher = fetch) {
  let url = sourceUrl(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(60000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect without location');
      url = sourceUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Source HTTP ${response.status}`); }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel(); throw new Error('Source exceeds size limit');
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maxBytes) throw new Error('Source exceeds size limit');
      chunks.push(chunk);
    }
    if (!length) throw new Error('Empty source');
    return { buffer: Buffer.concat(chunks), mime: response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() };
  }
  throw new Error('Too many source redirects');
}

function decode(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•', copy: '©' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, entity) => {
    if (!entity.startsWith('#')) return entities[entity] ?? all;
    const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '\uFFFD';
  });
}

// Convert to plain text only. The CMS validator rejects residual/encoded markup.
export function richText(value = '') {
  if (typeof value !== 'string') throw new Error('Expected source text');
  return decode(value.replace(/<!--[^]*?-->/g, '')
    .replace(/<(script|style|iframe|object|template)\b[^>]*>[^]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(?:p|div|blockquote|h[1-6]|ul|ol|li)\b[^>]*>|<br\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/\r/g, '').replace(/[\t ]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

export function publicationDate(article) {
  let value = article.publishedAt;
  if (!value) {
    const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    const match = /^(\d{1,2}) de ([a-z]{3})\. de (\d{4})$/.exec(article.updatedAt || '');
    if (match && months.includes(match[2])) value = `${match[3]}-${String(months.indexOf(match[2]) + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString().slice(0, 10) !== value) throw new Error('Missing or invalid publication date');
  return `${value}T12:00:00.000Z`;
}

export function prepare(payload) {
  if (!Array.isArray(payload?.store?.articles)) throw new Error('Expected store.articles');
  const media = new Map();
  const seen = new Set();
  const documents = payload.store.articles.filter((a) => a.status === 'published').map((article) => {
    if (typeof article.id !== 'string' || !article.id || seen.has(article.id)) throw new Error('Missing/duplicate source identity');
    seen.add(article.id);
    const title = richText(article.titleHtml || article.title);
    const category = richText(article.category);
    if (!title || title.length > 200 || category.length > 100 || !Array.isArray(article.blocks)) throw new Error('Invalid article metadata');
    const blocks = [];
    const paragraphs = (text) => {
      for (const paragraph of richText(text).split(/\n+/).filter(Boolean)) {
        // ponytail: split oversized paragraphs at words; the CMS caps text at 5,000 characters.
        let rest = paragraph;
        while (rest.length > 5000) {
          const at = rest.lastIndexOf(' ', 5000);
          if (at < 1) throw new Error('Unbreakable oversized source paragraph');
          blocks.push({ type: 'paragraph', text: rest.slice(0, at) });
          rest = rest.slice(at + 1);
        }
        if (rest) blocks.push({ type: 'paragraph', text: rest });
      }
    };
    const addMedia = (value, type = 'image', label = title) => {
      if (!value) throw new Error('Missing media URL');
      const url = sourceUrl(value);
      const id = identity('asset', url);
      if (media.has(url) && media.get(url).type !== type) throw new Error('Conflicting media types');
      media.set(url, { id, url, type });
      blocks.push(type === 'image' ? { type, asset_id: id, alt: richText(label).slice(0, 300) || title }
        : { type, asset_id: id, title: richText(label).slice(0, 200) || title });
    };
    const textWithImages = (text = '') => {
      // Inline images retain their position; no HTML is passed to the renderer.
      for (const part of text.split(/(<img\b[^>]*>)/gi)) {
        if (!/^<img\b/i.test(part)) { paragraphs(part); continue; }
        const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(part);
        if (!src) throw new Error('Inline image without src');
        addMedia(decode(src[1] ?? src[2] ?? src[3]));
      }
    };
    if (article.cover) addMedia(article.cover);
    paragraphs(article.excerptHtml || article.excerpt || '');
    paragraphs(`Autoria: ${article.author || 'Owner News'}`);
    const publishedAt = publicationDate(article);
    paragraphs(`${article.publishedAt ? 'Publicado em' : 'Data da fonte (atualização)'}: ${publishedAt.slice(0, 10)}`);
    for (const block of article.blocks) {
      switch (block.type) {
        case 'text': textWithImages(block.html || block.text); break;
        case 'image':
          addMedia(block.image || block.url, 'image', block.alt || block.caption || title);
          paragraphs(block.text || ''); paragraphs(block.captionHtml || block.caption || ''); break;
        case 'video':
          addMedia(block.url || block.video, 'video', block.title || block.caption || title);
          paragraphs(block.text || ''); paragraphs(block.captionHtml || block.caption || ''); break;
        case 'quote': paragraphs(`“${richText(block.html || block.text)}”`); paragraphs(block.author || block.name || ''); break;
        case 'profile':
          if (block.image || block.url) addMedia(block.image || block.url, 'image', block.name || title);
          paragraphs([block.name, block.role].filter(Boolean).join(' — ')); textWithImages(block.html || block.text); break;
        case 'divider': blocks.push({ type: 'divider' }); break;
        default: throw new Error('Unsupported source block type');
      }
    }
    if (!validateBlocks(blocks) || !validateBlocks([{ type: 'paragraph', text: title }, ...(category ? [{ type: 'paragraph', text: category }] : [])])) throw new Error('Converted article violates CMS schema');
    return { id: identity('document', article.id), sourceId: identity('source', article.id), revisionId: identity('revision-v1', article.id), title, category, publishedAt, blocks };
  });
  return { documents, media: [...media.values()], ignored: payload.store.articles.length - documents.length };
}

export async function validateMedia(downloaded, type) {
  const { buffer, mime } = downloaded;
  if (!buffer.length || buffer.length > MAX_MEDIA) throw new Error('Invalid media size');
  let detected;
  if (buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) detected = 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) detected = 'image/png';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') detected = 'image/webp';
  if (buffer.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) detected = 'video/webm';
  if (buffer.length >= 16 && buffer.readUInt32BE(0) >= 16 && buffer.readUInt32BE(0) <= buffer.length && buffer.subarray(4, 8).toString() === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString();
    if (brand === 'qt  ') detected = 'video/quicktime';
    else if (/^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV)$/.test(brand)) detected = 'video/mp4';
  }
  if (!detected || detected !== mime || !mime.startsWith(`${type}/`)) throw new Error('Media MIME/signature mismatch');
  if (type === 'image') {
    const sharp = require('sharp');
    await sharp(buffer, { limitInputPixels: 80000000, failOn: 'warning' }).stats();
  }
  return { ...downloaded, sha256: hash(buffer) };
}

export function localDatabase(env) {
  if (env.NODE_ENV !== 'development' || !env.OWNER_NEWS_DATABASE_URL) throw new Error('Set NODE_ENV=development and OWNER_NEWS_DATABASE_URL for a confirmed local development database');
  const url = new URL(env.OWNER_NEWS_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.search || !/\b(dev|development|local|test)\b/i.test(url.pathname.replace(/[_-]/g, ' '))) {
    throw new Error('Only loopback development/local/test database names without URL options are allowed');
  }
  return url.href;
}

export function existingState(document, row) {
  if (!row) return 'new';
  if (row.id !== document.id || row.source_id !== document.sourceId || row.content_type !== 'announcement') throw new Error('Existing unrelated document identity collision');
  if (row.title !== document.title || row.category !== document.category || row.published_revision_id !== document.revisionId
    || row.status !== 'published' || new Date(row.published_at).toISOString() !== document.publishedAt
    || !isDeepStrictEqual(row.blocks, document.blocks)) throw new Error('Existing imported publication differs; manual review required (never overwritten)');
  return 'existing';
}

async function inspectDatabase(db, plan) {
  const pending = [];
  for (const document of plan.documents) {
    const { rows } = await db.query(`SELECT d.*, r.status, r.blocks FROM cms_documents d
      LEFT JOIN cms_revisions r ON r.id=d.published_revision_id
      WHERE d.id=$1 OR (d.content_type='announcement' AND (d.source_id=$2 OR lower(d.title)=lower($3)))`, [document.id, document.sourceId, document.title]);
    if (rows.length > 1) throw new Error('Ambiguous existing announcement title/identity');
    if (existingState(document, rows[0]) === 'new') pending.push(document);
  }
  return pending;
}

async function privateDirectory(value) {
  if (!value || !path.isAbsolute(value)) throw new Error('Set absolute OWNER_NEWS_UPLOAD_DIR matching the local API UPLOAD_DIR');
  const base = await fs.realpath(value);
  const publicPath = await fs.realpath(path.join(ROOT, 'public'));
  const isPublic = (target) => target === publicPath || target.startsWith(`${publicPath}${path.sep}`);
  if (isPublic(base)) throw new Error('Uploads must never be stored under public');
  const target = path.join(base, 'cms-private');
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory() || isPublic(await fs.realpath(target))) throw new Error('Unsafe private directory');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some((arg) => !['--apply', '--dry-run'].includes(arg)) || args.includes('--apply') && args.includes('--dry-run')) throw new Error('Usage: node scripts/import-owner-news.mjs [--dry-run | --apply]');
  const apply = args.includes('--apply');
  // Validate destination before downloading when writes were requested.
  const connectionString = apply || env.OWNER_NEWS_DATABASE_URL ? localDatabase(env) : null;
  const directory = env.OWNER_NEWS_UPLOAD_DIR ? await privateDirectory(env.OWNER_NEWS_UPLOAD_DIR) : null;
  if (apply && !directory) throw new Error('Set OWNER_NEWS_UPLOAD_DIR matching the local API');
  const source = await download('/api/cms', 5 * 1024 * 1024);
  if (source.mime !== 'application/json') throw new Error('Source CMS is not JSON');
  let payload;
  try { payload = JSON.parse(source.buffer.toString('utf8')); } catch { throw new Error('Invalid source JSON'); }
  const plan = prepare(payload);
  if (plan.documents.length !== 19) throw new Error('Expected exactly 19 published source articles; review source changes');
  let bytes = 0;
  for (const asset of plan.media) {
    Object.assign(asset, await validateMedia(await download(asset.url, MAX_MEDIA), asset.type));
    bytes += asset.buffer.length;
    if (bytes > 300 * 1024 * 1024) throw new Error('Import exceeds total media budget');
  }
  const report = { mode: apply ? 'apply' : 'dry-run', prepared: plan.documents.length, media: plan.media.length, bytes, ignoredDrafts: plan.ignored, applied: 0, existing: 0, databaseChecked: false };
  if (!connectionString) { console.log(JSON.stringify(report)); return report; }
  const { Client } = require('pg');
  const db = new Client({ connectionString, connectionTimeoutMillis: 5000 });
  return persist(plan, report, { db, directory, apply });
}

export async function persist(plan, report, { db, directory, apply }) {
  const written = [];
  let commitAttempted = false;
  try {
    await db.connect();
    await db.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    if (apply) await lockCmsAssets(db);
    const pending = await inspectDatabase(db, plan);
    const pendingIds = new Set(pending.map((document) => document.id));
    const publishedAssetIds = new Set(plan.documents
      .filter((document) => !pendingIds.has(document.id))
      .flatMap((document) => document.blocks.map((block) => block.asset_id).filter(Boolean)));
    report.databaseChecked = true;
    report.existing = plan.documents.length - pending.length;
    for (const asset of plan.media) {
      const { rows } = await db.query('SELECT * FROM cms_assets WHERE id=$1', [asset.id]);
      const row = rows[0];
      if (!row && publishedAssetIds.has(asset.id)) {
        throw new Error(`Existing imported publication references missing cms_assets row ${asset.id}; explicit repair required before rerunning import`);
      }
      if (row) {
        if (row.metadata?.owner_news_source !== asset.url || row.metadata?.sha256 !== asset.sha256
          || row.mime_type !== asset.mime || Number(row.byte_size) !== asset.buffer.length || row.deleting_at) throw new Error('Existing asset differs or is being deleted');
        if (!directory) throw new Error('Set OWNER_NEWS_UPLOAD_DIR to verify existing private files');
        if (!/^[a-f0-9-]{36}$/.test(row.storage_key)) throw new Error('Invalid existing storage key');
        const file = path.join(directory, row.storage_key);
        if ((await fs.lstat(file)).isSymbolicLink() || hash(await fs.readFile(file)) !== asset.sha256) throw new Error('Existing private asset is missing or differs');
      } else if (apply) {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, asset.id);
        // Exclusive creation refuses crash leftovers; it never overwrites another file.
        const handle = await fs.open(file, 'wx', 0o600);
        written.push(file);
        try { await handle.writeFile(asset.buffer); await handle.sync(); } finally { await handle.close(); }
        await db.query(`INSERT INTO cms_assets (id,storage_key,original_name,mime_type,byte_size,metadata)
          VALUES ($1,$1,$2,$3,$4,$5::jsonb)`, [asset.id, `owner-news-${asset.id}`, asset.mime, asset.buffer.length, JSON.stringify({ owner_news_source: asset.url, sha256: asset.sha256 })]);
      }
    }
    if (apply) {
      for (const document of pending) {
        await db.query(`INSERT INTO cms_documents (id,content_type,source_id,title,category,published_at)
          VALUES ($1,'announcement',$2,$3,$4,$5)`, [document.id, document.sourceId, document.title, document.category, document.publishedAt]);
        await db.query(`INSERT INTO cms_revisions (id,document_id,version,status,blocks,created_at)
          VALUES ($1,$2,1,'published',$3::jsonb,$4)`, [document.revisionId, document.id, JSON.stringify(document.blocks), document.publishedAt]);
        await db.query('UPDATE cms_documents SET published_revision_id=$2 WHERE id=$1', [document.id, document.revisionId]);
      }
      const verified = await inspectDatabase(db, plan);
      if (verified.length) throw new Error('Publication verification failed');
      commitAttempted = true;
      await db.query('COMMIT');
      report.applied = pending.length;
      report.verifiedPublications = plan.documents.length;
      report.verifiedAssets = plan.media.length;
    } else await db.query('ROLLBACK');
    console.log(JSON.stringify(report));
    return report;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {});
    // An ambiguous COMMIT may have succeeded: keep private files, never break live references.
    if (!commitAttempted) for (const file of written) await fs.unlink(file);
    if (commitAttempted) throw new Error('Commit outcome uncertain; retain private files and rerun dry-run to reconcile');
    throw error;
  } finally { await db.end().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    // Database/network errors can contain credentials or source content; print only known safe errors.
    console.error(error.code ? `Import blocked (${String(error.code).replace(/[^A-Z0-9_]/gi, '')})` : `Import blocked: ${error.message.replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]')}`);
    process.exitCode = 1;
  });
}
