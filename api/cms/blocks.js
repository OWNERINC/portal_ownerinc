const MAX_BLOCKS = 100;
const MAX_URL_LENGTH = 2048;
const MAX_CMS_PAYLOAD_BYTES = 2 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ALLOWED_BLOCK_TYPES = new Set([
  'heading', 'paragraph', 'list', 'callout', 'image', 'divider', 'link', 'pdf', 'video',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasUnsafeMarkup(value) {
  return /<\/?[a-z][^>]*>|<\s*(script|style|iframe|object|embed)\b|\bon[a-z]+\s*=|javascript\s*:/i.test(value);
}

function text(value, max, { required = true, multiline = true } = {}) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max || hasUnsafeMarkup(normalized)) return null;
  if (!multiline && /[\r\n]/.test(normalized)) return null;
  return normalized;
}

function url(value) {
  if (typeof value !== 'string' || value.trim().length > MAX_URL_LENGTH) return null;
  const normalized = value.trim();
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function assetId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function keysAre(block, allowed) {
  return Object.keys(block).every((key) => allowed.has(key));
}

function normalizeBlock(block) {
  if (!isRecord(block) || !ALLOWED_BLOCK_TYPES.has(block.type)) return null;

  switch (block.type) {
    case 'heading': {
      if (!keysAre(block, new Set(['type', 'text', 'level']))) return null;
      const value = text(block.text, 200, { multiline: false });
      const level = block.level === undefined ? 2 : block.level;
      return value && Number.isInteger(level) && level >= 1 && level <= 6
        ? { type: 'heading', text: value, level } : null;
    }
    case 'paragraph': {
      if (!keysAre(block, new Set(['type', 'text']))) return null;
      const value = text(block.text, 5000);
      return value ? { type: 'paragraph', text: value } : null;
    }
    case 'list': {
      if (!keysAre(block, new Set(['type', 'items', 'ordered'])) || !Array.isArray(block.items)) return null;
      if (!block.items.length || block.items.length > 100) return null;
      const items = block.items.map((item) => text(item, 500, { multiline: false }));
      const ordered = block.ordered === undefined ? false : block.ordered;
      return items.every(Boolean) && typeof ordered === 'boolean'
        ? { type: 'list', items, ordered } : null;
    }
    case 'callout': {
      if (!keysAre(block, new Set(['type', 'tone', 'title', 'text']))) return null;
      const value = text(block.text, 2000);
      const hasTitle = Object.prototype.hasOwnProperty.call(block, 'title');
      const title = hasTitle ? text(block.title, 200, { multiline: false }) : null;
      const tone = block.tone === undefined ? 'info' : block.tone;
      return value && (!hasTitle || title) && ['info', 'warning', 'success'].includes(tone)
        ? { type: 'callout', tone, ...(title ? { title } : {}), text: value } : null;
    }
    case 'image': {
      if (!keysAre(block, new Set(['type', 'asset_id', 'alt']))) return null;
      const id = assetId(block.asset_id);
      const alt = text(block.alt, 300, { multiline: false });
      return id && alt ? { type: 'image', asset_id: id, alt } : null;
    }
    case 'divider':
      return keysAre(block, new Set(['type'])) ? { type: 'divider' } : null;
    case 'link': {
      if (!keysAre(block, new Set(['type', 'label', 'url', 'new_tab']))) return null;
      const label = text(block.label, 200, { multiline: false });
      const target = url(block.url);
      const newTab = block.new_tab === undefined ? false : block.new_tab;
      return label && target && typeof newTab === 'boolean'
        ? { type: 'link', label, url: target, new_tab: newTab } : null;
    }
    case 'pdf': {
      if (!keysAre(block, new Set(['type', 'asset_id', 'title']))) return null;
      const id = assetId(block.asset_id);
      const title = text(block.title, 200, { multiline: false });
      return id && title ? { type: 'pdf', asset_id: id, title } : null;
    }
    case 'video': {
      if (!keysAre(block, new Set(['type', 'url', 'asset_id', 'title']))) return null;
      const target = block.url === undefined ? null : url(block.url);
      const id = block.asset_id === undefined ? null : assetId(block.asset_id);
      const title = block.title === undefined ? null : text(block.title, 200, { multiline: false });
      if ((!target && !id) || (target && id) || (block.title !== undefined && !title)) return null;
      return {
        type: 'video',
        ...(target ? { url: target } : { asset_id: id }),
        ...(title ? { title } : {}),
      };
    }
    default:
      return null;
  }
}

function validateBlocks(value) {
  if (!Array.isArray(value) || value.length > MAX_BLOCKS) return null;
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_CMS_PAYLOAD_BYTES) return null;
  const normalized = value.map(normalizeBlock);
  return normalized.every(Boolean) ? normalized : null;
}

function blocksToText(blocks) {
  const normalized = validateBlocks(blocks);
  if (!normalized) return '';
  return normalized.map((block) => {
    switch (block.type) {
      case 'heading':
      case 'paragraph':
        return block.text;
      case 'list':
        return block.items.map((item) => `${block.ordered ? '1.' : '-'} ${item}`).join('\n');
      case 'callout':
        return block.title ? `${block.title}: ${block.text}` : block.text;
      case 'link':
        return `${block.label}: ${block.url}`;
      case 'pdf':
        return block.title;
      case 'video':
        return block.title || block.url || 'Video';
      case 'image':
      case 'divider':
        return null;
      default:
        return null;
    }
  }).filter(Boolean).join('\n\n');
}

module.exports = { blocksToText, validateBlocks };
