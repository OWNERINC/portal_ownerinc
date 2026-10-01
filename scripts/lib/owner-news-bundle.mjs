import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { identity, richText, sourceUrl, download, validateMedia } from '../import-owner-news.mjs';

const require = createRequire(import.meta.url);
const { validateNewsRevision } = require('../../api/owner-news/editorial.js');
const { validateBlocks } = require('../../api/cms/blocks.js');
const MAX_ASSET = 50 * 1024 * 1024;
const MAX_TOTAL = 300 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const layouts = new Set(['content', 'wide', 'full', 'left', 'right']);
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const civilDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function canonicalText(text) {
  return String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('pt-BR');
}
export function bodyFingerprint(blocks) {
  return hash(canonicalText(blocks.flatMap(b => b.type === 'list' ? b.items : b.text || []).join('\n')));
}
export function sourceIdentity(key) {
  return identity('source', key.startsWith('reference:') ? key.slice('reference:'.length) : key);
}

// No update-to-publication fallback. Invalid/unsupported source fields require curation.
export function convertReferenceArticle(article, assetsByUrl = new Map()) {
  if (!nonempty(article?.id) || !Array.isArray(article.blocks)) fail('Invalid reference article');
  const title = richText(article.titleHtml || article.title || '');
  const issues = [], blocks = [];
  const issue = value => { if (!issues.includes(value)) issues.push(value); };
  const optional = (out, key, value) => { const text = richText(value || ''); if (text) out[key] = text; };
  const attributes = (block, textual = false) => {
    const out = {};
    if (block.layout !== undefined) {
      if (!layouts.has(block.layout)) fail('Invalid source layout');
      out.layout = block.layout;
    }
    if (textual && block.style?.font !== undefined) {
      if (['serif', 'sans'].includes(block.style.font)) out.typography = block.style.font;
      else issue('unsupported_font');
    }
    return out;
  };
  const media = value => {
    try {
      const url = sourceUrl(value);
      const asset = assetsByUrl.get(url);
      const key = typeof asset === 'string' ? asset : asset?.key;
      if (!key) issue('unresolved_media');
      return key || null;
    } catch { issue('unsupported_media_origin'); return null; }
  };
  const image = (value, block, extra = {}) => {
    const asset_key = media(value);
    const out = { type: 'image', ...(asset_key ? { asset_key } : {}), alt: richText(block.alt || block.captionHtml || block.caption || title), ...attributes(block), ...extra };
    optional(out, 'caption', block.captionHtml || block.caption); optional(out, 'credit', block.credit);
    blocks.push(out);
  };
  const paragraphs = (value, block) => {
    const text = richText(value || ''), attrs = attributes(block, true);
    if (!text) return;
    const column = ['left', 'right'].includes(attrs.layout);
    if (column && text.length > 5000) issue('column_requires_relayout');
    const parts = column ? [text] : text.split(/\n+/).filter(Boolean);
    for (let rest of parts) {
      while (rest.length > 5000) {
        const at = rest.lastIndexOf(' ', 5000);
        if (at < 1) { issue('unbreakable_paragraph'); blocks.push({ type: 'paragraph', text: rest, ...attrs }); rest = ''; break; }
        blocks.push({ type: 'paragraph', text: rest.slice(0, at), ...attrs }); rest = rest.slice(at + 1);
      }
      if (rest) blocks.push({ type: 'paragraph', text: rest, ...attrs });
    }
  };
  const textWithImages = (value, block) => {
    // Remove executable containers before finding inline images; keep visible image order.
    const safe = (value || '').replace(/<(script|style|iframe|object|template)\b[^>]*>[^]*?<\/\1\s*>/gi, '');
    for (const part of safe.split(/(<img\b[^>]*>)/gi)) {
      if (!/^<img\b/i.test(part)) { paragraphs(part, block); continue; }
      const src = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(part);
      if (!src) { issue('unresolved_media'); continue; }
      image(richText(src[1] ?? src[2] ?? src[3]), { layout: block.layout });
    }
  };
  if (article.cover) image(article.cover, {}, { usage: 'cover', layout: 'full' });
  for (const block of article.blocks) {
    attributes(block);
    switch (block.type) {
      case 'text': textWithImages(block.html || block.text, block); break;
      case 'image':
        image(block.image || block.url, block);
        textWithImages(block.html || block.text, block); break;
      case 'video': {
        const asset_key = media(block.url || block.video);
        const out = { type: 'video', ...(asset_key ? { asset_key } : {}), ...attributes(block) };
        optional(out, 'title', block.title || block.captionHtml || block.caption);
        blocks.push(out); textWithImages(block.html || block.text, block);
        if (block.captionHtml || block.caption) paragraphs(block.captionHtml || block.caption, block);
        break;
      }
      case 'quote': {
        const out = { type: 'quote', text: richText(block.html || block.text || ''), ...attributes(block, true) };
        if (/<img\b/i.test(block.html || block.text || '')) issue('quote_inline_media_requires_review');
        optional(out, 'attribution', block.author || block.name); blocks.push(out); break;
      }
      case 'profile': {
        const out = { type: 'profile', name: richText(block.name || ''), ...attributes(block, true) };
        optional(out, 'role', block.role); optional(out, 'text', block.html || block.text);
        if (/<img\b/i.test(block.html || block.text || '')) issue('profile_inline_media_requires_review');
        if (block.image || block.url) {
          const asset_key = media(block.image || block.url);
          if (asset_key) { out.asset_key = asset_key; out.alt = richText(block.alt || block.name || title); }
        }
        blocks.push(out); break;
      }
      case 'divider': blocks.push({ type: 'divider', ...attributes(block) }); break;
      default: issue('unsupported_block');
    }
  }
  if (article.publishedAt && !civilDate(article.publishedAt)) issue('invalid_publication_date');
  return { title, category: richText(article.category || ''), editorial: { version: 1, kind: 'article',
    summary: richText(article.excerptHtml || article.excerpt || ''), author: richText(article.author || ''),
    source_label: richText(article.source_label || ''), source_date: civilDate(article.publishedAt) ? article.publishedAt : null },
  blocks, sources: [{ kind: 'reference', external_id: article.id, updated_at: article.updatedAt ?? null,
    published_at: article.publishedAt ?? null, status: article.status }], review_status: 'needs_review', issues };
}

export function sourceKey(source, canonicalKey) {
  if (source?.kind === 'reference' && nonempty(source.external_id)) return `reference:${source.external_id}`;
  const editionSourceKey = source?.source_key ?? canonicalKey;
  if (source?.kind === 'edition' && nonempty(source.edition_key) && nonempty(editionSourceKey)
    && editionSourceKey.startsWith(`edition:${source.edition_key}:`) && Array.isArray(source.pages)
    && source.pages.length && source.pages.every(p => Number.isInteger(p) && p > 0)) return editionSourceKey;
  fail('Invalid source provenance');
}

export function inventorySources({ referencePayload, editionItems = [], decisions = [] }) {
  if (!Array.isArray(referencePayload?.store?.articles)) fail('Expected store.articles');
  const rows = referencePayload.store.articles.map(a => {
    const converted = convertReferenceArticle(a);
    return { source_key: `reference:${a.id}`, title: converted.title, category: converted.category,
      origin: 'reference', pages: [], status: a.status, updated_at: a.updatedAt ?? null, published_at: a.publishedAt ?? null,
      fingerprint: bodyFingerprint(converted.blocks), body_empty: !converted.blocks.some(b => b.text), candidates: [] };
  });
  for (const item of editionItems) rows.push({ source_key: item.key, title: item.title, category: item.category,
    origin: 'edition', pages: item.sources.flatMap(s => s.pages || []), status: 'extracted',
    fingerprint: bodyFingerprint(item.blocks), body_empty: !item.blocks.some(b => b.text || b.items?.length), candidates: [] });
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.source_key)) fail('Duplicate source_key'); seen.add(row.source_key);
    row.candidates = rows.filter(other => other !== row && !row.body_empty && !other.body_empty && other.fingerprint === row.fingerprint).map(other => other.source_key);
    const d = decisions.find(d => d.source_key === row.source_key);
    Object.assign(row, { decision: d?.decision ?? null, canonical_key: d?.canonical_key ?? null,
      reviewer: d?.reviewer ?? null, reason: d?.reason ?? null });
  }
  return rows;
}

export function prepareBundle({ referencePayload, editionItems = [], decisions, assets = [], sourceSnapshot }) {
  const inventory = inventorySources({ referencePayload, editionItems, decisions });
  if (sourceSnapshot?.reference_published_count !== referencePayload.store.articles.filter(a => a.status === 'published').length) fail('Source count mismatch');
  const assetsByUrl = new Map(assets.filter(a => a.url).map(a => [sourceUrl(a.url), a.key]));
  const originals = new Map(referencePayload.store.articles.map(a => [`reference:${a.id}`, convertReferenceArticle(a, assetsByUrl)]));
  for (const item of editionItems) { if (originals.has(item.key)) fail('Duplicate source_key'); originals.set(item.key, item); }
  const keys = [...inventory.map(i => i.source_key), ...(sourceSnapshot?.pending_sources || []).map(s => s.source_key).filter(k => !originals.has(k))];
  checkDecisions(decisions, keys);
  const items = [];
  for (const d of decisions) {
    if (!['include', 'retain_pdf'].includes(d.decision)) continue;
    const original = originals.get(d.source_key);
    if (!original && sourceSnapshot?.pending_sources?.some(s => s.source_key === d.source_key)) continue;
    if (!original || d.canonical_key !== d.source_key) fail('Invalid canonical decision');
    const item = { ...structuredClone(original), key: d.canonical_key, action: 'upsert', review_status: 'needs_review', target: null };
    // Explicit merge decisions attach provenance, never concatenate or discard text automatically.
    for (const merge of decisions.filter(m => m.decision === 'merge' && m.canonical_key === item.key)) {
      const other = originals.get(merge.source_key); if (!other) fail('Missing merge source');
      item.sources.push(...structuredClone(other.sources).map(s => s.kind === 'edition' ? { ...s, source_key: sourceKey(s, merge.source_key) } : s));
      item.issues = [...(item.issues || []), 'merged_body_requires_review'];
    }
    items.push(item);
  }
  for (const d of decisions.filter(d => d.decision === 'merge')) {
    if (!items.some(i => i.key === d.canonical_key)) fail('Missing canonical merge item');
  }
  const used = new Set(items.flatMap(i => i.blocks.map(b => b.asset_key).filter(Boolean)));
  return { schema_version: 1, source_snapshot: { ...sourceSnapshot, inventory_source_keys: keys },
    assets: assets.filter(a => used.has(a.key)).map(({ url, ...a }) => a), items, decisions: structuredClone(decisions) };
}

function checkDecisions(decisions, keys) {
  if (!Array.isArray(decisions) || !Array.isArray(keys) || new Set(keys).size !== keys.length
    || keys.some(k => !nonempty(k))) fail('Invalid source inventory');
  const seen = new Set();
  for (const d of decisions) {
    if (!keys.includes(d.source_key) || seen.has(d.source_key) || !['include', 'merge', 'exclude', 'retain_pdf'].includes(d.decision)
      || !nonempty(d.reason) || !nonempty(d.reviewer)
      || (d.decision === 'exclude' ? d.canonical_key !== null : !nonempty(d.canonical_key))) fail('Invalid or duplicate decision');
    seen.add(d.source_key);
  }
  if (seen.size !== keys.length) fail('Missing source decision');
}

function relativePath(value) {
  if (!nonempty(value) || path.isAbsolute(value) || path.win32.isAbsolute(value) || /[\\:\x00]/.test(value)
    || value.split('/').some(p => !p || p === '..' || p === '.')) fail('Unsafe relative_path');
  return value.split('/');
}
const within = (base, file) => file !== base && !path.relative(base, file).startsWith(`..${path.sep}`)
  && path.relative(base, file) !== '..' && !path.isAbsolute(path.relative(base, file));

export async function validateBundleAsset(asset, { root }) {
  if (!nonempty(asset?.key) || !HASH.test(asset.sha256) || !Number.isSafeInteger(asset.byte_size)
    || asset.byte_size < 1 || asset.byte_size > MAX_ASSET) fail('Invalid asset size/hash/key');
  const parts = relativePath(asset.relative_path);
  await privatePath(root, { existing: true });
  const base = await fs.realpath(root);
  let file = base;
  for (const part of parts) {
    file = path.join(file, part);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) fail('Asset symlink forbidden');
  }
  if (!within(base, await fs.realpath(file))) fail('Asset outside bundle root');
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size !== asset.byte_size || stat.size > MAX_ASSET) fail('Asset size/file mismatch');
  const buffer = await fs.readFile(file);
  if (buffer.length !== asset.byte_size || hash(buffer) !== asset.sha256) fail('Asset hash mismatch');
  if (asset.mime === 'application/pdf') {
    if (buffer.subarray(0, 5).toString() !== '%PDF-') fail('Invalid PDF signature');
    return { buffer, mime: asset.mime, sha256: asset.sha256 };
  }
  return validateMedia({ buffer, mime: asset.mime }, asset.mime?.startsWith('image/') ? 'image' : 'video');
}

function validateTarget(item) {
  if (item.target === null) { if (item.action === 'withdraw') fail('Withdraw requires target'); return; }
  const target = item.target;
  const fields = ['document_id', 'source_id', 'published_revision_id', 'draft_revision_id', 'scheduled_revision_id', 'scheduled_at', 'published_at', 'title', 'category'];
  if (!target || Object.keys(target).length !== fields.length || fields.some(k => !(k in target))
    || !UUID.test(target.document_id) || !UUID.test(target.source_id)
    || ['published_revision_id', 'draft_revision_id', 'scheduled_revision_id'].some(k => target[k] !== null && !UUID.test(target[k]))
    || ['scheduled_at', 'published_at'].some(k => target[k] !== null && (typeof target[k] !== 'string' || !Number.isFinite(Date.parse(target[k]))))
    || !nonempty(target.title) || typeof target.category !== 'string') fail('Invalid target snapshot');
  if (item.action === 'withdraw' && (!target.published_revision_id || !item.sources.some(s => sourceIdentity(sourceKey(s, item.key)) === target.source_id))) fail('Withdraw requires identified imported target');
}

export async function validateBundle(bundle, { root, allowPending = false }) {
  if (bundle?.schema_version !== 1 || !Array.isArray(bundle.assets) || !Array.isArray(bundle.items)) fail('Invalid bundle schema');
  const snapshot = bundle.source_snapshot;
  if (!snapshot || !HASH.test(snapshot.reference_sha256) || !Number.isFinite(Date.parse(snapshot.reference_observed_at))
    || !Number.isSafeInteger(snapshot.reference_published_count) || snapshot.reference_published_count < 0
    || !nonempty(snapshot.edition_key) || (snapshot.edition_pdf_sha256 !== null && !HASH.test(snapshot.edition_pdf_sha256))) fail('Invalid source snapshot');
  checkDecisions(bundle.decisions, snapshot.inventory_source_keys);
  const pending = snapshot.pending_sources || [];
  if (!Array.isArray(pending) || new Set(pending.map(p => p.source_key)).size !== pending.length
    || pending.some(p => !snapshot.inventory_source_keys.includes(p.source_key) || !nonempty(p.reason))) fail('Invalid pending sources');
  const assets = new Map(); let bytes = 0;
  for (const asset of bundle.assets) {
    if (assets.has(asset.key)) fail('Duplicate asset_key');
    bytes += asset.byte_size;
    if (!Number.isSafeInteger(bytes) || bytes > MAX_TOTAL) fail('Bundle exceeds 300 MiB asset budget');
    assets.set(asset.key, asset);
  }
  const keys = new Set(), sources = new Set(), referenced = new Set();
  for (const item of bundle.items) {
    if (!nonempty(item.key) || keys.has(item.key) || !['upsert', 'withdraw', 'skip'].includes(item.action)
      || !['approved', 'needs_review'].includes(item.review_status)) fail('Invalid item/action/key');
    keys.add(item.key);
    if (!allowPending && item.review_status !== 'approved') fail('Item needs_review');
    if (item.review_status === 'approved' && item.issues?.length) fail('Approved item has unresolved review issues');
    if (!Array.isArray(item.sources) || !item.sources.length) fail('Missing source provenance');
    for (const source of item.sources) {
      const key = sourceKey(source, item.key), d = bundle.decisions.find(d => d.source_key === key);
      if (!d || sources.has(key) || (item.action === 'upsert' && (!['include', 'merge', 'retain_pdf'].includes(d.decision) || d.canonical_key !== item.key))
        || (item.action === 'withdraw' && d.decision !== 'exclude')) fail('Inconsistent/duplicate source decision');
      if (pending.some(p => p.source_key === key)) fail('Pending source must stay outside bundle items');
      if (d.decision === 'retain_pdf' && (source.kind !== 'edition' || item.editorial?.kind !== 'edition'
        || !item.blocks?.some(b => b.type === 'pdf' && b.usage === 'edition'))) fail('retain_pdf requires edition PDF');
      sources.add(key);
    }
    validateTarget(item);
    if (item.action !== 'upsert') continue;
    if (!nonempty(item.title) || item.title.length > 200 || typeof item.category !== 'string' || item.category.length > 100
      || !validateBlocks([{ type: 'paragraph', text: item.title }, ...(item.category ? [{ type: 'paragraph', text: item.category }] : [])])) fail('Invalid item metadata');
    if (!Array.isArray(item.blocks) || !item.editorial) fail('Invalid editorial revision');
    if (Buffer.byteLength(JSON.stringify({ blocks: item.blocks, editorial: item.editorial }), 'utf8') > 5 * 1024 * 1024) fail('Editorial payload exceeds 5 MiB');
    const blocks = item.blocks.map(block => {
      const b = { ...block };
      if ('asset_id' in b) fail('Bundle must use asset_key only');
      if (b.type === 'video' && 'url' in b) fail('Bundle video requires validated asset_key');
      if ('asset_key' in b) {
        const asset = assets.get(b.asset_key); if (!asset) fail('Unknown asset_key');
        const type = b.type === 'profile' ? 'image' : b.type;
        if (!(type === 'pdf' ? asset.mime === 'application/pdf' : ['image', 'video'].includes(type) && asset.mime.startsWith(`${type}/`))) fail('Block/asset MIME mismatch');
        referenced.add(b.asset_key); b.asset_id = identity('bundle-asset', asset.key); delete b.asset_key;
      }
      return b;
    });
    if (!validateNewsRevision(blocks, item.editorial, { publishing: item.review_status === 'approved' })
      && !(allowPending && item.review_status === 'needs_review' && item.issues?.length)) fail('Invalid CMS editorial revision');
  }
  for (const d of bundle.decisions) {
    if (d.decision === 'retain_pdf' && !d.source_key.startsWith(`edition:${snapshot.edition_key}:`)) fail('retain_pdf requires edition source');
    if (['include', 'merge', 'retain_pdf'].includes(d.decision) && !sources.has(d.source_key)
      && !(d.decision === 'retain_pdf' && pending.some(p => p.source_key === d.source_key))) fail('Decision missing canonical item');
  }
  if (referenced.size !== assets.size) fail('Unreferenced bundle asset');
  for (const asset of assets.values()) await validateBundleAsset(asset, { root });
  return structuredClone(bundle);
}

// bundle hash is the exact serialization written by the CLI (including final LF).
export const serializeBundle = bundle => `${JSON.stringify(bundle, null, 2)}\n`;
export function bundleHashes(bundle) {
  const content = structuredClone(bundle);
  for (const item of content.items) delete item.target;
  return { bundle_sha256: hash(serializeBundle(bundle)), content_sha256: hash(serializeBundle(content)) };
}

export async function captureReference({ fetcher = fetch } = {}) {
  const result = await download('/api/cms', 5 * 1024 * 1024, fetcher);
  if (result.mime !== 'application/json') fail('Source CMS is not JSON');
  const payload = JSON.parse(result.buffer.toString('utf8'));
  inventorySources({ referencePayload: payload });
  return { ...result, payload, sha256: hash(result.buffer), observed_at: new Date().toISOString(),
    published_count: payload.store.articles.filter(a => a.status === 'published').length };
}

// URLs are enumerated from all source records, including pending/drafts, for provenance.
export function referenceMedia(payload) {
  const media = new Map();
  const add = (value, type) => {
    if (!value) return;
    const url = sourceUrl(value);
    if (media.has(url) && media.get(url).type !== type) fail('Conflicting source media type');
    media.set(url, { url, type, key: identity('asset', url) });
  };
  for (const a of payload.store.articles) {
    add(a.cover, 'image');
    for (const b of a.blocks) {
      if (['image', 'profile'].includes(b.type)) add(b.image || b.url, 'image');
      if (b.type === 'video') add(b.url || b.video, 'video');
      for (const match of (b.html || b.text || '').matchAll(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi)) add(richText(match[1] ?? match[2] ?? match[3]), 'image');
    }
  }
  return [...media.values()];
}

export async function captureReferenceMedia(payload, { root, fetcher = fetch } = {}) {
  await privatePath(root, { existing: true });
  const assets = []; let bytes = 0;
  for (const media of referenceMedia(payload)) {
    const result = await validateMedia(await download(media.url, MAX_ASSET, fetcher), media.type);
    bytes += result.buffer.length; if (bytes > MAX_TOTAL) fail('Capture exceeds 300 MiB asset budget');
    const relative_path = `media/${media.key}`;
    await fs.mkdir(path.join(root, 'media'), { recursive: true, mode: 0o700 });
    await privatePath(path.join(root, 'media'), { existing: true });
    await fs.writeFile(path.join(root, relative_path), result.buffer, { flag: 'wx', mode: 0o600 });
    assets.push({ key: media.key, url: media.url, relative_path, mime: result.mime, sha256: result.sha256, byte_size: result.buffer.length });
  }
  return assets;
}

// Existing worktrees and their main checkout are forbidden, including symlink ancestors.
export async function privatePath(value, { existing = false } = {}) {
  if (!value || !path.isAbsolute(value)) fail('Private path must be absolute');
  const absolute = path.resolve(value);
  let cursor = absolute;
  while (true) {
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) fail('Private path symlink forbidden');
      const real = await fs.realpath(cursor), repo = await fs.realpath(ROOT);
      if (real === repo || within(repo, real)) fail('Private artifacts cannot be in repository');
      try {
        const git = path.join(cursor, '.git'), gitStat = await fs.lstat(git);
        if (gitStat.isDirectory()) await fs.lstat(path.join(git, 'HEAD'));
        fail('Private artifacts cannot be in Git checkout');
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    } catch (error) { if (error.code !== 'ENOENT' || existing && cursor === absolute) throw error; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return absolute;
}
