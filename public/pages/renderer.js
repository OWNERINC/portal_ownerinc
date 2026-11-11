import { el, button } from './dom.js';
import { safeLink } from './model.js';

// Shared by the reader and both preview widths. Data is never treated as HTML.
export function richNode(value) {
  if (value.type === 'text') {
    let node = document.createTextNode(value.text);
    for (const mark of value.marks || []) {
      const tag = { strong: 'strong', em: 'em', underline: 'u', link: 'a' }[mark.type];
      if (!tag || (mark.type === 'link' && !safeLink(mark.attrs?.href))) continue;
      const parent = el(tag, mark.type === 'link' ? { href: mark.attrs.href, rel: 'noopener noreferrer' } : {});
      parent.append(node); node = parent;
    }
    return node;
  }
  const tag = { doc: 'div', paragraph: 'p', heading: value.attrs?.level === 3 ? 'h3' : 'h2', bullet_list: 'ul', ordered_list: 'ol', list_item: 'li', hard_break: 'br' }[value.type];
  if (!tag) return document.createTextNode('');
  return el(tag, value.type === 'ordered_list' ? { start: value.attrs?.order || 1 } : {}, ...(value.content || []).map(richNode));
}
export function imageFigure(block, { api, pageId, revisionId, staged, signal }) {
  const image = el('img', { alt: block.alt, loading: 'lazy', decoding: 'async' });
  const status = el('span', { className: 'pages-media-status', role: 'status', text: 'Carregando imagem…' });
  const figure = el('figure', {}, image, status);
  if (block.caption || block.credit) figure.append(el('figcaption', {}, el('span', { text: block.caption }),
    ...(block.credit ? [el('span', { className: 'pages-credit', text: `Crédito: ${block.credit}` })] : [])));
  let url = null, active = true;
  api.asset(pageId, block.media_id, { revisionId, staged, signal }).then(value => {
    if (!active || signal?.aborted) { URL.revokeObjectURL(value); return; }
    url = value; image.src = value; status.remove();
  }).catch(error => { if (active && error.name !== 'AbortError') status.textContent = 'Imagem indisponível.'; });
  return { node: figure, dispose() { active = false; image.removeAttribute('src'); if (url) URL.revokeObjectURL(url); } };
}
export function applyBlockStyle(node, block) {
  const style = block.style || { align: 'start', scale: 'standard', palette: 'neutral', font: 'manrope' };
  for (const key of ['align','scale','palette','font']) node.dataset[key] = style[key];
}
export function captionsVTT(captions) {
  if (!Array.isArray(captions) || captions.length > 500) return null;
  let end = 0;
  const stamp = ms => `${String(Math.floor(ms / 3600000)).padStart(2,'0')}:${String(Math.floor(ms / 60000) % 60).padStart(2,'0')}:${String(Math.floor(ms / 1000) % 60).padStart(2,'0')}.${String(ms % 1000).padStart(3,'0')}`;
  const lines = [];
  for (const cue of captions) {
    if (!Number.isSafeInteger(cue.start_ms) || !Number.isSafeInteger(cue.end_ms) || cue.start_ms < end || cue.end_ms <= cue.start_ms || cue.end_ms > 120000 || typeof cue.text !== 'string' || cue.text.length > 1000 || /[<>]|-->/.test(cue.text)) return null;
    end = cue.end_ms; lines.push(`${stamp(cue.start_ms)} --> ${stamp(cue.end_ms)}\n${cue.text}`);
  }
  return `WEBVTT\n\n${lines.join('\n\n')}\n`;
}
export function mediaFigure(block, { api, pageId, revisionId, staged, signal, resolveBlock = () => block }) {
  const gif = block.type === 'gif', name = { gif: 'animação', audio: 'áudio', video: 'vídeo' }[block.type];
  const media = el(gif ? 'img' : block.type, gif ? { alt: block.alt, hidden: true } : { controls: true, preload: 'none', playsinline: block.type === 'video', 'aria-label': block.title || name });
  const status = el('span', { role: 'status', className: 'pages-media-status', text: `${name} não carregado.` });
  let active = true, generation = 0, url, trackURL, controller, captionSignature;
  const heading = el('h3'), caption = el('figcaption'), transcriptText = el('p');
  const transcript = el('details', {}, el('summary', { text: 'Transcrição' }), transcriptText);
  function refresh() {
    const current = resolveBlock(); if (!active || !current) return;
    heading.hidden = !current.title; heading.textContent = current.title || '';
    caption.hidden = !current.caption && !current.credit; caption.textContent = [current.caption, current.credit].filter(Boolean).join(' · ');
    transcript.hidden = !current.transcript; transcriptText.textContent = current.transcript || '';
    if (gif) media.alt = current.alt; else media.setAttribute('aria-label', current.title || name);
    if (current.type === 'video' && url) {
      const signature = JSON.stringify(current.captions);
      if (signature === captionSignature) return;
      media.querySelectorAll('track').forEach(track => { track.removeAttribute('src'); track.remove(); });
      if (trackURL) URL.revokeObjectURL(trackURL); trackURL = null; captionSignature = signature;
      const vtt = captionsVTT(current.captions);
      if (vtt && current.captions.length) {
        trackURL = URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' }));
        media.append(el('track', { kind: 'captions', label: 'Português', srclang: 'pt-BR', src: trackURL, default: true }));
      }
    }
  }
  function clear() {
    generation++; controller?.abort(); controller = null;
    if (!gif) media.pause();
    media.querySelectorAll('track').forEach(track => { track.removeAttribute('src'); track.remove(); });
    media.removeAttribute('src');
    if (gif) media.hidden = true;
    if (!gif) media.load();
    if (url) URL.revokeObjectURL(url); if (trackURL) URL.revokeObjectURL(trackURL); url = trackURL = captionSignature = null;
  }
  const stop = button(gif ? 'Parar animação' : 'Descarregar mídia', () => { clear(); load.disabled = false; stop.disabled = true; status.textContent = `${name} não carregado.`; }, { disabled: true });
  const load = button(gif ? 'Iniciar animação' : `Carregar ${name}`, async () => {
    clear(); const request = generation; controller = new AbortController(); load.disabled = true; stop.disabled = false; status.textContent = `Carregando ${name}…`;
    try {
      const current = resolveBlock(); if (!current || current.type !== block.type) throw new Error('Media removed');
      const mediaId = current.media_id;
      const value = await api.asset(pageId, mediaId, { revisionId, staged, signal: controller.signal });
      if (!active || request !== generation || signal?.aborted || resolveBlock()?.media_id !== mediaId) { URL.revokeObjectURL(value); return; }
      url = value;
      refresh(); media.src = value; if (gif) media.hidden = false; else media.load(); status.textContent = gif ? 'Animação iniciada. Use Parar animação para interromper.' : 'Mídia carregada. Use os controles para reproduzir.';
    } catch (error) { if (active && request === generation && error.name !== 'AbortError') { status.textContent = `${name} indisponível.`; load.disabled = false; stop.disabled = true; } }
  });
  const figure = el('figure', { className: 'pages-private-media' }, heading, media, el('div', { className: 'pages-actions' }, load, stop), status, caption, transcript);
  refresh();
  const dispose = () => { active = false; clear(); signal?.removeEventListener('abort', dispose); };
  signal?.addEventListener('abort', dispose, { once: true });
  return { node: figure, dispose, refresh };
}
export function focusSection(host, hash = window.location.hash) {
  if (!/^#section-[0-9a-f-]{36}$/i.test(hash)) return;
  const target = host.querySelector(`[id="${hash.slice(1)}"]`);
  if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start' }); }
}
export function renderDocument({ host, document: doc, api, pageId, revisionId, staged = false }) {
  const controller = new AbortController(), disposers = [];
  const article = el('article', { className: 'pages-document' }, el('header', {}, el('h1', { text: doc.metadata.title }),
    ...(doc.metadata.summary ? [el('p', { className: 'pages-summary', text: doc.metadata.summary })] : [])));
  for (const section of doc.sections) {
    const sectionNode = el('section', { 'aria-label': section.label || 'Conteúdo', id: `section-${section.id}`, tabindex: '-1' });
    for (const row of section.rows) {
      const rowNode = el('div', { className: `pages-row pages-row-${row.layout}`, 'data-row-id': row.id });
      for (const column of row.columns) {
        const columnNode = el('div', { className: 'pages-column', 'data-column-id': column.id });
        for (const block of column.blocks) {
          const wrapper = el('div', { className: 'pages-rendered-block', 'data-block-id': block.id }); applyBlockStyle(wrapper, block);
          if (block.type === 'rich_text') wrapper.append(richNode(block.content));
          else if (block.type === 'callout') wrapper.append(el('aside', { className: `pages-callout pages-callout-${block.tone}` }, ...(block.icon !== 'none' ? [el('span', { 'aria-hidden': 'true', text: { info: 'ⓘ', alert: '!', check: '✓' }[block.icon] })] : []), richNode(block.content)));
          else if (block.type === 'divider') wrapper.append(el('hr'));
          else if (block.type === 'button') {
            const href = block.destination.type === 'section' ? `./pages.html?id=${encodeURIComponent(pageId)}#section-${block.destination.value}` : block.destination.value;
            if (block.destination.type === 'section' || safeLink(href)) {
              const anchor = el('a', { href, className: `pages-content-button pages-button-${block.preset}`, text: block.label });
              if (block.destination.type === 'section') anchor.addEventListener('click', event => {
                event.preventDefault();
                if (staged || revisionId) focusSection(host, `#section-${block.destination.value}`);
                else { window.history.pushState(window.history.state, '', href); focusSection(host); }
              });
              wrapper.append(anchor);
            }
          } else if (['image','gif','audio','video'].includes(block.type)) {
            const figure = (block.type === 'image' ? imageFigure : mediaFigure)(block, { api, pageId, revisionId, staged, signal: controller.signal });
            wrapper.append(figure.node); disposers.push(figure.dispose);
          }
          columnNode.append(wrapper);
        }
        rowNode.append(columnNode);
      }
      sectionNode.append(rowNode);
    }
    article.append(sectionNode);
  }
  if (doc.metadata.tags.length) article.append(el('footer', { className: 'pages-tags', text: doc.metadata.tags.join(' · ') }));
  host.replaceChildren(article);
  return () => { controller.abort(); disposers.forEach(fn => fn()); };
}
