import { fetchAPIAsset } from './auth.js';
import { clear, element, safeHttpUrl } from './ui.js';

export const BLOCK_TYPES = ['heading', 'paragraph', 'list', 'callout', 'image', 'divider', 'link', 'pdf', 'video'];
const BLOCK_TYPE_SET = new Set(BLOCK_TYPES);
// Keep the editor aligned with the server's 5 MiB normalized block limit.
const MAX_CMS_PAYLOAD_BYTES = 5 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const renderStates = new WeakMap();
const documentObservers = new WeakMap();

function renderState(container) {
  if (!renderStates.has(container)) renderStates.set(container, { container, token: Symbol('cms-render'), urls: new Set(), observerRecord: null });
  return renderStates.get(container);
}

export function cleanupRenderedBlocks(container) {
  const state = renderStates.get(container);
  if (!state) return;
  state.token = Symbol('cms-render');
  state.urls.forEach(url => { if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url); });
  state.urls.clear();
}

function observeContainer(container, state) {
  if (state.observerRecord || typeof MutationObserver === 'undefined' || !container.ownerDocument?.documentElement) return;
  const document = container.ownerDocument;
  let record = documentObservers.get(document);
  if (!record) {
    const states = new Set();
    const observer = new MutationObserver(() => {
      [...states].forEach(candidate => {
        if (candidate.container.isConnected) return;
        cleanupRenderedBlocks(candidate.container);
        states.delete(candidate);
        candidate.observerRecord = null;
      });
      if (!states.size) {
        observer.disconnect();
        documentObservers.delete(document);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    record = { observer, states };
    documentObservers.set(document, record);
  }
  record.states.add(state);
  state.observerRecord = record;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value, max, multiline = true) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /<\/?[a-z][^>]*>|\bon[a-z]+\s*=|javascript\s*:/i.test(normalized)) return null;
  if (!multiline && /[\r\n]/.test(normalized)) return null;
  return normalized;
}

function safeAssetId(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null;
}

function safeHttpsUrl(value) {
  const target = safeHttpUrl(value);
  return target?.startsWith('https:') ? target : null;
}

function exactKeys(block, keys) {
  return Object.keys(block).every(key => keys.has(key));
}

function normalizeBlock(block) {
  if (!isRecord(block) || !BLOCK_TYPE_SET.has(block.type)) return null;
  switch (block.type) {
    case 'heading': {
      if (!exactKeys(block, new Set(['type', 'text', 'level']))) return null;
      const text = safeText(block.text, 200, false);
      const level = block.level === undefined ? 2 : block.level;
      return text && Number.isInteger(level) && level >= 1 && level <= 6 ? { type: 'heading', text, level } : null;
    }
    case 'paragraph': {
      if (!exactKeys(block, new Set(['type', 'text']))) return null;
      const text = safeText(block.text, 5000);
      return text ? { type: 'paragraph', text } : null;
    }
    case 'list': {
      if (!exactKeys(block, new Set(['type', 'items', 'ordered'])) || !Array.isArray(block.items) || !block.items.length || block.items.length > 100) return null;
      const items = block.items.map(item => safeText(item, 500, false));
      const ordered = block.ordered === undefined ? false : block.ordered;
      return items.every(Boolean) && typeof ordered === 'boolean' ? { type: 'list', items, ordered } : null;
    }
    case 'callout': {
      if (!exactKeys(block, new Set(['type', 'tone', 'title', 'text']))) return null;
      const text = safeText(block.text, 2000);
      const title = block.title === undefined ? undefined : safeText(block.title, 200, false);
      const tone = block.tone === undefined ? 'info' : block.tone;
      return text && (title !== null) && ['info', 'warning', 'success'].includes(tone)
        ? { type: 'callout', tone, ...(title ? { title } : {}), text } : null;
    }
    case 'image': {
      if (!exactKeys(block, new Set(['type', 'asset_id', 'alt']))) return null;
      const assetId = safeAssetId(block.asset_id);
      const alt = safeText(block.alt, 300, false);
      return assetId && alt ? { type: 'image', asset_id: assetId, alt } : null;
    }
    case 'divider':
      return exactKeys(block, new Set(['type'])) ? { type: 'divider' } : null;
    case 'link': {
      if (!exactKeys(block, new Set(['type', 'label', 'url', 'new_tab']))) return null;
      const label = safeText(block.label, 200, false);
      const url = safeHttpsUrl(block.url);
      const newTab = block.new_tab === undefined ? false : block.new_tab;
      return label && url && typeof newTab === 'boolean' ? { type: 'link', label, url, new_tab: newTab } : null;
    }
    case 'pdf': {
      if (!exactKeys(block, new Set(['type', 'asset_id', 'title']))) return null;
      const assetId = safeAssetId(block.asset_id);
      const title = safeText(block.title, 200, false);
      return assetId && title ? { type: 'pdf', asset_id: assetId, title } : null;
    }
    case 'video': {
      if (!exactKeys(block, new Set(['type', 'url', 'asset_id', 'title']))) return null;
      const url = block.url === undefined ? null : safeHttpsUrl(block.url);
      const assetId = block.asset_id === undefined ? null : safeAssetId(block.asset_id);
      const title = block.title === undefined ? null : safeText(block.title, 200, false);
      if ((!url && !assetId) || (url && assetId) || (block.title !== undefined && !title)) return null;
      return { type: 'video', ...(url ? { url } : { asset_id: assetId }), ...(title ? { title } : {}) };
    }
    default:
      return null;
  }
}

export function validateBlocks(value) {
  if (!Array.isArray(value) || value.length > 100) return null;
  const blocks = value.map(normalizeBlock);
  if (!blocks.every(Boolean)) return null;
  return new TextEncoder().encode(JSON.stringify(blocks)).byteLength <= MAX_CMS_PAYLOAD_BYTES
    ? blocks : null;
}

export function blocksToText(blocks) {
  const normalized = validateBlocks(blocks);
  if (!normalized) return '';
  return normalized.map(block => {
    if (block.type === 'heading' || block.type === 'paragraph') return block.text;
    if (block.type === 'list') return block.items.map(item => `${block.ordered ? '1.' : '-'} ${item}`).join('\n');
    if (block.type === 'callout') return block.title ? `${block.title}: ${block.text}` : block.text;
    if (block.type === 'link') return `${block.label}: ${block.url}`;
    if (block.type === 'pdf') return block.title;
    if (block.type === 'video') return block.title || block.url || 'Video';
    return null;
  }).filter(Boolean).join('\n\n');
}

function assetEndpoint(assetId) {
  return `/api/cms/assets/${encodeURIComponent(assetId)}`;
}

function loadPrivateAsset(node, assetId, label, state) {
  const token = state.token;
  fetchAPIAsset(assetEndpoint(assetId)).then(url => {
    if (token !== state.token || !node.isConnected) {
      if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
      return;
    }
    state.urls.add(url);
    node.src = url;
    node.dataset.loaded = 'true';
  }).catch(() => {
    if (token !== state.token || !node.isConnected) return;
    node.replaceWith(element('span', { className: 'cms-asset-error', role: 'status', text: `Não foi possível carregar ${label}.` }));
  });
}

function renderPdf(container, block) {
  const link = element('a', {
    className: 'btn btn-ghost cms-pdf-link',
    href: assetEndpoint(block.asset_id),
    role: 'button',
    text: `Abrir PDF: ${block.title}`,
  });
  link.addEventListener('click', async event => {
    event.preventDefault();
    try {
      const url = await fetchAPIAsset(link.getAttribute('href'));
      const download = element('a', { href: url, target: '_blank', rel: 'noopener noreferrer' });
      document.body.append(download);
      download.click();
      download.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      link.textContent = 'Não foi possível abrir o PDF.';
    }
  });
  container.append(link);
}

export function renderBlocks(container, blocks, { fallbackText = '' } = {}) {
  cleanupRenderedBlocks(container);
  const state = renderState(container);
  observeContainer(container, state);
  const normalized = validateBlocks(blocks);
  clear(container);
  if (!normalized || !normalized.length) {
    if (fallbackText) container.append(element('p', { className: 'cms-fallback', text: fallbackText }));
    return false;
  }
  normalized.forEach(block => {
    if (block.type === 'heading') container.append(element(`h${block.level}`, { className: 'cms-block cms-heading', text: block.text }));
    if (block.type === 'paragraph') container.append(element('p', { className: 'cms-block', text: block.text }));
    if (block.type === 'list') container.append(element(block.ordered ? 'ol' : 'ul', { className: 'cms-block cms-list' }, block.items.map(item => element('li', { text: item }))));
    if (block.type === 'callout') container.append(element('aside', { className: `cms-block cms-callout cms-callout-${block.tone}` }, [
      ...(block.title ? [element('strong', { text: block.title })] : []), element('p', { text: block.text }),
    ]));
    if (block.type === 'image') {
      const image = element('img', { className: 'cms-block cms-image', alt: block.alt, loading: 'lazy' });
      container.append(image);
      loadPrivateAsset(image, block.asset_id, 'a imagem', state);
    }
    if (block.type === 'divider') container.append(element('hr', { className: 'cms-block cms-divider' }));
    if (block.type === 'link') container.append(element('a', {
      className: 'btn btn-ghost cms-block cms-link', href: block.url,
      ...(block.new_tab ? { target: '_blank', rel: 'noopener noreferrer' } : {}), text: block.label,
    }));
    if (block.type === 'pdf') renderPdf(container, block);
    if (block.type === 'video') {
      const video = element('video', { className: 'cms-block cms-video', controls: '', preload: 'metadata' });
      if (block.title) video.setAttribute('aria-label', block.title);
      if (block.url) video.src = block.url;
      else loadPrivateAsset(video, block.asset_id, 'o vídeo', state);
      container.append(video);
    }
  });
  return true;
}
