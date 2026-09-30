const { validateBlocks } = require('../cms/blocks');

const MAX_BYTES = 5 * 1024 * 1024;
const KEYS = new Set(['version', 'kind', 'summary', 'author', 'source_label', 'source_date']);

// Keep these pure rules aligned with public/js/owner-news/model.js.
function plain(value, max, multiline = false) {
  return typeof value === 'string' && value.trim().length <= max
    && (multiline || !/[\r\n]/.test(value))
    && !/<\/?[a-z][^>]*>|<\s*(script|style|iframe|object|embed)\b|\bon[a-z]+\s*=|javascript\s*:/i.test(value);
}

function civilDate(value) {
  return value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
}

function normalizeEditorial(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !KEYS.has(key))
    || value.version !== 1 || !['article', 'edition'].includes(value.kind)
    || !plain(value.summary, 1000, true) || !plain(value.author, 200)
    || !plain(value.source_label, 200) || !civilDate(value.source_date)) return null;
  return { version: 1, kind: value.kind, summary: value.summary.trim(),
    author: value.author.trim(), source_label: value.source_label.trim(), source_date: value.source_date };
}

function announcementKind({ blocks, content_blocks, editorial }) {
  return editorial?.kind || ((blocks || content_blocks || []).some(b => b.type === 'pdf') ? 'edition' : 'article');
}

function readingText(blocks) {
  return blocks.flatMap(block => {
    if (['heading', 'paragraph', 'quote', 'profile', 'callout'].includes(block.type)) return block.text || '';
    if (block.type === 'list') return block.items;
    return [];
  }).join(' ').trim();
}

function estimateNewsReadTime(blocks, editorial) {
  if (announcementKind({ blocks, editorial }) === 'edition') return null;
  const text = readingText(blocks);
  return text ? Math.max(1, Math.ceil(text.split(/\s+/).length / 200)) : null;
}

function validateNewsRevision(value, editorial, { publishing = false } = {}) {
  const blocks = validateBlocks(value);
  const normalized = editorial === null ? null : normalizeEditorial(editorial);
  if (!blocks || (editorial !== null && !normalized)) return null;
  if (blocks.filter(b => b.type === 'image' && b.usage === 'cover').length > 1
    || blocks.filter(b => b.type === 'pdf' && b.usage === 'edition').length > 1) return null;
  if (publishing && normalized?.kind === 'article'
    && (!normalized.summary || !blocks.some(b => ['paragraph', 'list', 'quote', 'profile'].includes(b.type)
      && (b.type === 'list' ? b.items.length > 0 : Boolean(b.text?.trim()))))) return null;
  if (publishing && normalized?.kind === 'edition' && !blocks.some(b => b.type === 'pdf')) return null;
  const result = { blocks, editorial: normalized };
  return Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_BYTES ? result : null;
}

module.exports = { normalizeEditorial, validateNewsRevision, announcementKind, estimateNewsReadTime };
