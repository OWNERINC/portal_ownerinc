import { el } from './dom.js';

// Closed local vocabulary. Author data can select a name, never supply SVG/HTML.
const iconPaths = {
  info: 'M12 11v6m0-10v1M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20',
  alert: 'm12 3 10 18H2Zm0 5v6m0 3v1', check: 'm4 12 5 5L20 6',
  arrow: 'M5 12h14m-6-6 6 6-6 6', download: 'M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5',
  play: 'm7 3 14 9-14 9Z', upload: 'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
  coffee: 'M4 8h12v9a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3Zm12 1h2a3 3 0 0 1 0 6h-2M7 2v3m5-3v3M2 22h18',
  users: 'M8 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M2 21v-3a6 6 0 0 1 12 0v3m3-17a4 4 0 0 1 0 8m1 3a5 5 0 0 1 4 5v1',
  headphones: 'M3 14v-3a9 9 0 0 1 18 0v3M3 12h4v9H3Zm14 0h4v9h-4Z',
  shirt: 'm8 3-6 4 3 5 3-2v12h8V10l3 2 3-5-6-4a4 4 0 0 1-8 0Z',
};
export function v3Icon(name) {
  if (!Object.hasOwn(iconPaths, name)) return null;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key,value] of Object.entries({ viewBox: '0 0 24 24', width: '24', height: '24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'pages-block-icon' })) svg.setAttribute(key,value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', iconPaths[name]); svg.append(path); return svg;
}

// Helpers are injected by renderer.js; this module never imports its consumer.
export function renderV3Block(block, context) {
  const current = context.resolveBlock || (() => block), preview = context.staged || !!context.revisionId;
  const node = el('div', { className: `pages-v3-${block.type}` });
  let active = true;
  const alive = () => active && !context.signal?.aborted;
  let refreshContent = () => {}, disposeContent = () => {};
  if (block.type === 'gallery') {
    const items = new Map();
    refreshContent = () => {
      const value = current(), list = value?.type === 'gallery' ? value.items : [];
      node.querySelectorAll('[data-pages-placeholder]').forEach(placeholder => { if (placeholder.parentNode === node) placeholder.remove(); });
      const ids = new Set(list.map(item => item.id));
      for (const [id,entry] of items) if (!ids.has(id) || list.find(item => item.id === id)?.kind !== entry.kind) {
        entry.figure.dispose(); entry.figure.node.remove(); items.delete(id);
      }
      for (const item of list) {
        let entry = items.get(item.id);
        if (!entry) {
          const resolveItem = () => {
            const parent = current();
            const value = parent?.type === 'gallery' ? parent.items.find(candidate => candidate.id === item.id) : null;
            return value ? { ...value, type: value.kind } : null;
          };
          const figure = (item.kind === 'gif' ? context.mediaFigure : context.imageFigure)({ ...item, type: item.kind },
            { ...context, resolveBlock: resolveItem, captionBlock: () => current() });
          figure.node.dataset.galleryItemId = item.id;
          entry = { kind: item.kind, figure }; items.set(item.id, entry);
        } else entry.figure.refresh?.();
        node.append(entry.figure.node);
      }
      if (!list.length && preview) node.append(el('p', { 'data-pages-placeholder': '', text: 'Galeria sem imagens.' }));
    };
    disposeContent = () => { items.forEach(entry => entry.figure.dispose()); items.clear(); };
  } else if (block.type === 'faq') {
    // Native, independent disclosures. No `name`, persistence or data mutation.
    const items = new Map();
    refreshContent = () => {
      const value = current(), list = value?.type === 'faq' ? value.items : [];
      const ids = new Set(list.map(item => item.id));
      for (const [id,entry] of items) if (!ids.has(id)) { entry.node.remove(); items.delete(id); }
      for (const item of list) {
        let entry = items.get(item.id);
        if (!entry) {
          const heading = el('h3', { id: `faq-question-${item.id}` });
          const answer = el('div', { className: 'pages-faq-answer', role: 'region', 'aria-labelledby': heading.id });
          entry = { node: el('details', { 'data-faq-item-id': item.id }, el('summary', {}, heading), answer), heading, answer };
          items.set(item.id, entry);
        }
        entry.heading.textContent = item.question || (preview ? 'Pergunta não preenchida' : '');
        entry.answer.replaceChildren(context.richNode(item.answer, { document: context.resolveDocument?.() || context.document, block: value }));
        node.append(entry.node);
      }
      node.querySelectorAll('[data-pages-placeholder]').forEach(n => n.remove());
      if (!list.length && preview) node.append(el('p', { 'data-pages-placeholder': '', text: 'FAQ sem perguntas.' }));
    };
  } else if (block.type === 'video_embed') {
    const heading = el('h3'), transcript = el('p');
    const notice = el('p', { text: 'Ao carregar, você se conecta ao YouTube. A autenticação do Portal não torna este vídeo externo privado.' });
    const consent = el('button', { type: 'button', 'data-pages-video-consent': '', text: 'Carregar vídeo do YouTube' });
    const unload = el('button', { type: 'button', 'data-pages-video-unload': '', text: 'Descarregar vídeo', disabled: true });
    const player = el('div', { className: 'pages-embed-player' });
    let iframe, loadedId;
    function clear() {
      iframe?.removeAttribute('src'); iframe?.remove(); iframe = null; loadedId = null;
      consent.disabled = !alive(); unload.disabled = true;
    }
    function load() {
      if (!alive() || iframe) return;
      const value = current();
      if (value?.provider !== 'youtube' || !/^[A-Za-z0-9_-]{11}$/u.test(value.video_id)) return;
      loadedId = value.video_id;
      iframe = el('iframe', { title: value.title || 'Vídeo do YouTube', src: `https://www.youtube-nocookie.com/embed/${loadedId}?autoplay=0&rel=0`,
        allow: 'encrypted-media; picture-in-picture', referrerpolicy: 'strict-origin-when-cross-origin', sandbox: 'allow-scripts allow-same-origin allow-presentation', allowfullscreen: true });
      player.append(iframe); consent.disabled = true; unload.disabled = false;
    }
    consent.addEventListener('click', load); unload.addEventListener('click', clear);
    node.append(heading, notice, el('div', { className: 'pages-actions' }, consent, unload), player,
      el('details', {}, el('summary', { text: 'Transcrição' }), transcript));
    refreshContent = () => {
      const value = current();
      if (!value || value.type !== 'video_embed' || (loadedId && (loadedId !== value.video_id || value.provider !== 'youtube'))) clear();
      heading.textContent = value?.title || ''; heading.hidden = !value?.title;
      transcript.textContent = value?.transcript || ''; transcript.parentNode.hidden = !value?.transcript;
      if (iframe) iframe.title = value.title || 'Vídeo do YouTube';
    };
    disposeContent = () => { clear(); consent.removeEventListener('click', load); unload.removeEventListener('click', clear); };
  } else throw new Error('Unsupported v3 block');
  function refresh() { if (alive()) refreshContent(); }
  function dispose() {
    if (!active) return;
    active = false; disposeContent(); context.signal?.removeEventListener('abort', dispose);
  }
  if (context.signal?.aborted) dispose(); else { refresh(); context.signal?.addEventListener('abort', dispose, { once: true }); }
  return { node, refresh, dispose };
}
