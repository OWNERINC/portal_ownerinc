import { fetchAPIAsset } from './auth.js';
import { clear, element, safeHttpUrl } from './ui.js';
import { cmsAssetEndpoint, validateAssetScope } from './owner-news/asset-path.mjs';
export { cmsAssetEndpoint };

export const BLOCK_TYPES = ['heading', 'paragraph', 'list', 'callout', 'image', 'divider', 'link', 'pdf', 'video', 'quote', 'profile'];
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
  state.controller?.abort();
  state.releaseSignal?.();
  const record = state.observerRecord;
  if (record) {
    record.states.delete(state);
    state.observerRecord = null;
    if (!record.states.size) {
      record.observer.disconnect();
      documentObservers.delete(container.ownerDocument);
    }
  }
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
  if (!normalized || normalized.length > max || /<\/?[a-z][^>]*>|<\s*(script|style|iframe|object|embed)\b|\bon[a-z]+\s*=|javascript\s*:/i.test(normalized)) return null;
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

function normalizeBaseBlock(block) {
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
    case 'quote': {
      if (!exactKeys(block, new Set(['type', 'text', 'attribution']))) return null;
      const text = safeText(block.text, 5000);
      const attribution = 'attribution' in block ? safeText(block.attribution, 200, false) : undefined;
      return text && attribution !== null
        ? { type: 'quote', text, ...(attribution ? { attribution } : {}) } : null;
    }
    case 'profile': {
      if (!exactKeys(block, new Set(['type', 'name', 'role', 'text', 'asset_id', 'alt']))) return null;
      const name = safeText(block.name, 200, false);
      if (!name) return null;
      const result = { type: 'profile', name };
      for (const field of ['role', 'text']) {
        if (!(field in block)) continue;
        const value = safeText(block[field], field === 'role' ? 200 : 5000, field === 'text');
        if (!value) return null;
        result[field] = value;
      }
      if ('asset_id' in block) {
        const id = safeAssetId(block.asset_id);
        const alt = safeText(block.alt, 300, false);
        if (!id || !alt) return null;
        result.asset_id = id;
        result.alt = alt;
      } else if ('alt' in block) return null;
      return result;
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

const LAYOUTS = new Set(['content', 'wide', 'full', 'left', 'right']);
const TYPOGRAPHIC_TYPES = new Set(['paragraph', 'list', 'callout', 'quote', 'profile']);

function normalizeBlock(block) {
  if (!isRecord(block)) return null;
  const core = { ...block };
  const extra = {};
  if ('layout' in core) {
    if (!LAYOUTS.has(core.layout)) return null;
    extra.layout = core.layout;
    delete core.layout;
  }
  if ('typography' in core) {
    if (!TYPOGRAPHIC_TYPES.has(core.type) || !['serif', 'sans'].includes(core.typography)) return null;
    extra.typography = core.typography;
    delete core.typography;
  }
  if (core.type === 'image') {
    for (const field of ['caption', 'credit']) {
      if (!(field in core)) continue;
      const value = safeText(core[field], field === 'caption' ? 1000 : 300);
      if (!value) return null;
      extra[field] = value;
      delete core[field];
    }
  }
  if ('usage' in core && ['image', 'pdf'].includes(core.type)) {
    const allowed = core.type === 'image' ? ['cover', 'body'] : ['edition', 'attachment'];
    if (!allowed.includes(core.usage)) return null;
    extra.usage = core.usage;
    delete core.usage;
  }
  const result = normalizeBaseBlock(core);
  return result ? { ...result, ...extra } : null;
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
    if (['heading', 'paragraph', 'quote', 'profile'].includes(block.type)) return block.text;
    if (block.type === 'list') return block.items.map(item => `${block.ordered ? '1.' : '-'} ${item}`).join('\n');
    if (block.type === 'callout') return block.title ? `${block.title}: ${block.text}` : block.text;
    if (block.type === 'link') return `${block.label}: ${block.url}`;
    if (block.type === 'pdf') return block.title;
    if (block.type === 'video') return block.title || block.url || 'Video';
    return null;
  }).filter(Boolean).join('\n\n');
}

function retryableAsset(node, assetId, label, state, { status, apply, reset }) {
  const token = state.token;
  const signal = state.controller.signal;
  let pending = false, currentURL = null, externalStatus = false;
  const current = () => token === state.token && !signal.aborted && node.isConnected;
  function release() {
    reset();
    if (currentURL) { state.urls.delete(currentURL); URL.revokeObjectURL(currentURL); currentURL = null; }
  }
  function fail() {
    if (!current()) return;
    release();
    status.hidden = false;
    status.replaceChildren(element('span', { text: `Não foi possível carregar ${label}.` }),
      element('button', { className: 'btn btn-ghost', type: 'button', text: 'Tentar novamente', on: { click: event => { event.preventDefault(); event.stopPropagation(); if (current()) load(); } } }));
    if (!status.isConnected) {
      const anchor = node.closest('a');
      externalStatus = Boolean(anchor);
      (anchor || node).after(status);
    }
  }
  function load() {
    if (pending || token !== state.token || signal.aborted) return;
    pending = true;
    status.textContent = 'Carregando mídia…';
    fetchAPIAsset(cmsAssetEndpoint(assetId, state.assetScope), { signal }).then(url => {
      if (!current()) { URL.revokeObjectURL(url); return; }
      currentURL = url; state.urls.add(url);
      apply(url); status.hidden = true;
    }).catch(fail).finally(() => { pending = false; });
  }
  node.addEventListener('error', fail, { signal });
  signal.addEventListener('abort', () => { if (externalStatus) status.remove(); }, { once: true });
  load();
}

function loadPrivateAsset(node, assetId, label, state) {
  retryableAsset(node, assetId, label, state, {
    status: element('div', { className: 'cms-asset-error', role: 'status' }),
    apply: url => { node.hidden = false; node.src = url; node.dataset.loaded = 'true'; },
    reset: () => { node.hidden = true; node.removeAttribute('src'); delete node.dataset.loaded; },
  });
}

function renderPdf(container, block, state) {
  const frame = element('iframe', {
    className: 'cms-block cms-pdf-frame',
    title: `Visualização do PDF: ${block.title}`,
    loading: 'lazy',
    hidden: '',
  });
  const status = element('p', { className: 'cms-asset-status', role: 'status', text: 'Carregando PDF...' });
  const link = element('a', {
    className: 'btn btn-ghost cms-pdf-link',
    target: '_blank',
    rel: 'noopener noreferrer',
    text: `Abrir PDF em nova aba: ${block.title}`,
    hidden: '',
  });
  const note = element('p', {
    className: 'cms-pdf-note',
    text: 'A acessibilidade do arquivo depende do documento PDF original.',
  });
  const wrapper = element('section', { className: 'cms-pdf-block', 'aria-label': block.title }, [frame, status, link, note]);
  container.append(wrapper);
  retryableAsset(frame, block.asset_id, 'o PDF', state, {
    status,
    apply: url => { frame.src = url; frame.hidden = false; link.href = url; link.hidden = false; },
    reset: () => { frame.hidden = true; frame.removeAttribute('src'); link.hidden = true; link.removeAttribute('href'); },
  });
}

export function renderBlocks(container, blocks, { fallbackText = '', signal, assetScope = 'legacy' } = {}) {
  validateAssetScope(assetScope);
  cleanupRenderedBlocks(container);
  const state = renderState(container);
  state.assetScope = assetScope;
  state.controller = new AbortController();
  if (signal) {
    const dispose = () => cleanupRenderedBlocks(container);
    signal.addEventListener('abort', dispose, { once: true });
    state.releaseSignal = () => signal.removeEventListener('abort', dispose);
    if (signal.aborted) { dispose(); return false; }
  }
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
    if (block.type === 'quote') {
      const quote = element('blockquote', { className: 'cms-block cms-quote' }, [element('p', { text: block.text })]);
      if (block.attribution) quote.append(element('cite', { text: block.attribution }));
      container.append(quote);
    }
    if (block.type === 'profile') {
      const profile = element('section', { className: 'cms-block cms-profile' });
      if (block.asset_id) {
        const image = element('img', { className: 'cms-profile-image', alt: block.alt, loading: 'lazy' });
        profile.append(image);
        loadPrivateAsset(image, block.asset_id, 'o retrato', state);
      }
      const copy = element('div', {}, [element('strong', { text: block.name })]);
      if (block.role) copy.append(element('p', { className: 'cms-profile-role', text: block.role }));
      if (block.text) copy.append(element('p', { text: block.text }));
      profile.append(copy);
      container.append(profile);
    }
    if (block.type === 'image') {
      const image = element('img', { className: 'cms-block cms-image', alt: block.alt, loading: 'lazy' });
      if (block.caption || block.credit) {
        container.append(element('figure', { className: 'cms-block cms-figure' }, [image,
          element('figcaption', { text: [block.caption, block.credit].filter(Boolean).join(' · ') }),
        ]));
      } else container.append(image);
      loadPrivateAsset(image, block.asset_id, 'a imagem', state);
    }
    if (block.type === 'divider') container.append(element('hr', { className: 'cms-block cms-divider' }));
    if (block.type === 'link') container.append(element('a', {
      className: 'btn btn-ghost cms-block cms-link', href: block.url,
      ...(block.new_tab ? { target: '_blank', rel: 'noopener noreferrer' } : {}), text: block.label,
    }));
    if (block.type === 'pdf') renderPdf(container, block, state);
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
