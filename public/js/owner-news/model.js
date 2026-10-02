const KEYS = new Set(['version', 'kind', 'summary', 'author', 'source_label', 'source_date']);

// Pure preview rules; api/owner-news/editorial.js remains the publication authority.
function plain(value, max, multiline = false) {
  return typeof value === 'string' && value.trim().length <= max
    && (multiline || !/[\r\n]/.test(value))
    && !/<\/?[a-z][^>]*>|<\s*(script|style|iframe|object|embed)\b|\bon[a-z]+\s*=|javascript\s*:/i.test(value);
}

function civilDate(value) {
  return value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
}

export function normalizeEditorial(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !KEYS.has(key))
    || value.version !== 1 || !['article', 'edition'].includes(value.kind)
    || !plain(value.summary, 1000, true) || !plain(value.author, 200)
    || !plain(value.source_label, 200) || !civilDate(value.source_date)) return null;
  return { version: 1, kind: value.kind, summary: value.summary.trim(),
    author: value.author.trim(), source_label: value.source_label.trim(), source_date: value.source_date };
}

export function announcementKind({ blocks, content_blocks, editorial }) {
  return editorial?.kind || ((blocks || content_blocks || []).some(b => b.type === 'pdf') ? 'edition' : 'article');
}

function readingText(blocks) {
  return blocks.flatMap(block => {
    if (['heading', 'paragraph', 'quote', 'profile', 'callout'].includes(block.type)) return block.text || '';
    if (block.type === 'list') return block.items;
    return [];
  }).join(' ').trim();
}

export function estimateNewsReadTime(blocks, editorial) {
  if (announcementKind({ blocks, editorial }) === 'edition') return null;
  const text = readingText(blocks);
  return text ? Math.max(1, Math.ceil(text.split(/\s+/).length / 200)) : null;
}

export function getNewsPresentation(article) {
  const blocks = article.content_blocks || [];
  const explicitCover = blocks.find(b => b.type === 'image' && b.usage === 'cover') || null;
  const companion = blocks.find(b => b.type === 'pdf' && b.usage === 'edition') || null;
  const meta = article.editorial;
  return {
    cover: explicitCover || (meta ? null : blocks.find(b => b.type === 'image') || null),
    body: blocks.filter(b => b !== explicitCover && b !== companion),
    companion,
    summary: meta?.summary || blocks.find(b => b.type === 'paragraph')?.text || '',
    author: meta?.author || 'Owner News',
    sourceLabel: meta?.source_label || '',
    sourceDate: meta?.source_date || null,
  };
}
