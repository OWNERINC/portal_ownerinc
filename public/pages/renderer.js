import { el, button } from './dom.js';
import { safeLink } from './model.js';
import { createPageButton } from './button.js';
import { resolveAppearance, normalizeHex, typographyMetrics } from './appearance.js';
import { renderV3Block, v3Icon } from './render-blocks-v3.js';

// Shared by the reader and both preview widths. Data is never treated as HTML.
export function richNode(value, context) {
  if (value.type === 'text') {
    let node = document.createTextNode(value.text);
    const v3 = context?.document?.schema_version === 3;
    const foreground = v3 && normalizeHex(value.marks?.find(mark => mark.type === 'text_color')?.attrs?.color);
    const highlight = v3 && normalizeHex(value.marks?.find(mark => mark.type === 'highlight')?.attrs?.color);
    for (const mark of value.marks || []) {
      const tag = { strong: 'strong', em: 'em', underline: 'u', link: 'a' }[mark.type];
      if (!tag || (mark.type === 'link' && !safeLink(mark.attrs?.href))) continue;
      const parent = el(tag, mark.type === 'link' ? { href: mark.attrs.href, rel: 'noopener noreferrer' } : {});
      if (v3 && mark.type === 'link') parent.style.color = foreground || resolveAppearance(context.document, context.block, 'link').foreground;
      parent.append(node); node = parent;
    }
    if (foreground || highlight) {
      const run = el('span', { 'data-pages-rich-run': '' }, node);
      if (foreground) run.style.color = foreground;
      if (highlight) run.style.backgroundColor = highlight;
      node = run;
    }
    return node;
  }
  const tag = { doc: 'div', paragraph: 'p', heading: value.attrs?.level === 3 ? 'h3' : 'h2', bullet_list: 'ul', ordered_list: 'ol', list_item: 'li', hard_break: 'br' }[value.type];
  if (!tag) return document.createTextNode('');
  return el(tag, value.type === 'ordered_list' ? { start: value.attrs?.order || 1 } : {}, ...(value.content || []).map(child => richNode(child, context)));
}
function paint(node, appearance) {
  for (const key of ['align','scale','font']) node.dataset[key] = appearance[key];
  node.style.color = appearance.foreground; node.style.backgroundColor = appearance.background;
}
function paintCaption(node, block, doc) {
  if (doc?.schema_version !== 3) {
    if (node.dataset.pagesCaption === '3') { node.removeAttribute('style'); for (const key of ['align','scale','font','pagesCaption']) delete node.dataset[key]; }
    return;
  }
  node.dataset.pagesCaption = '3';
  paint(node, resolveAppearance(doc, block, 'caption'));
  node.style.fontSize = '14px'; node.style.fontWeight = '400';
}
export function imageFigure(block, { api, pageId, revisionId, staged, signal, document: doc, resolveDocument = () => doc, resolveBlock = () => block, captionBlock = resolveBlock }) {
  const image = el('img', { alt: block.alt, loading: 'lazy', decoding: 'async' });
  const status = el('span', { className: 'pages-media-status', role: 'status', text: 'Carregando imagem…' });
  const figure = el('figure', {}, image, status);
  let url = null, active = true, generation = 0, mediaId, request, caption;
  function clear() { generation++; request?.abort(); request = null; image.removeAttribute('src'); if (url) URL.revokeObjectURL(url); url = null; }
  function refresh() {
    if (!active || signal?.aborted) return;
    const current = resolveBlock();
    if (!current) { clear(); mediaId = undefined; return; }
    image.alt = current.alt || '';
    if (current.caption || current.credit) {
      if (!caption) { caption = el('figcaption'); figure.append(caption); }
      caption.replaceChildren(el('span', { text: current.caption || '' }), ...(current.credit ? [el('span', { className: 'pages-credit', text: `Crédito: ${current.credit}` })] : []));
      paintCaption(caption, captionBlock(), resolveDocument());
    } else { caption?.remove(); caption = null; }
    if (mediaId === current.media_id) return;
    clear(); mediaId = current.media_id;
    if (!mediaId) { image.hidden = true; status.textContent = staged || revisionId ? 'Imagem não enviada.' : ''; status.hidden = !staged && !revisionId; if (staged || revisionId) status.dataset.pagesPlaceholder = ''; figure.insertBefore(status, caption || null); return; }
    image.hidden = false; status.hidden = false; delete status.dataset.pagesPlaceholder; status.textContent = 'Carregando imagem…';
    figure.insertBefore(status, caption || null);
    request = new AbortController(); const version = generation, id = mediaId;
    api.asset(pageId, id, { revisionId, staged, signal: request.signal }).then(value => {
      if (!active || signal?.aborted || version !== generation || resolveBlock()?.media_id !== id) { URL.revokeObjectURL(value); return; }
      url = value; image.src = value; status.remove();
    }).catch(error => { if (active && version === generation && error.name !== 'AbortError') status.textContent = 'Imagem indisponível.'; });
  }
  function dispose() { if (!active) return; active = false; clear(); signal?.removeEventListener('abort', dispose); }
  if (signal?.aborted) dispose(); else { refresh(); signal?.addEventListener('abort', dispose, { once: true }); }
  return { node: figure, refresh, dispose };
}
export function applyBlockStyle(node, block, doc) {
  const style = block.style || { align: 'start', scale: 'standard', palette: 'neutral', font: 'manrope' };
  for (const key of ['align','scale','palette','font']) node.dataset[key] = style[key];
  if (doc?.schema_version === 3) {
    node.dataset.schemaVersion = '3';
    // Preset pairs belong to the actual inner control/callout, not an invented
    // full-width stripe. Resolve ordinary outer inheritance through the same
    // canonical algorithm, without duplicating palette/override precedence.
    paint(node, resolveAppearance(doc, ['button','callout'].includes(block.type) ? { ...block, type: 'rich_text' } : block));
    const metrics = typographyMetrics(doc, block);
    if(metrics.guide){node.dataset.guideBlock=metrics.cover?'cover':block.type;node.style.setProperty('--pages-body-size',`${metrics.body}px`);node.style.setProperty('--pages-h2-size',`${metrics.h2}px`);node.style.setProperty('--pages-h3-size',`${metrics.h3}px`);}
    else{delete node.dataset.guideBlock;for(const key of ['--pages-body-size','--pages-h2-size','--pages-h3-size'])node.style.removeProperty(key);}
  }
  else if (node.dataset.schemaVersion === '3') { delete node.dataset.schemaVersion; delete node.dataset.guideBlock; node.style.color = ''; node.style.backgroundColor = ''; for(const key of ['--pages-body-size','--pages-h2-size','--pages-h3-size'])node.style.removeProperty(key); }
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
export function mediaFigure(block, { api, pageId, revisionId, staged, signal, document: doc, resolveDocument = () => doc, resolveBlock = () => block, captionBlock = resolveBlock }) {
  const gif = block.type === 'gif', name = { gif: 'animação', audio: 'áudio', video: 'vídeo' }[block.type];
  const media = el(gif ? 'img' : block.type, gif ? { alt: block.alt, hidden: true } : { controls: true, preload: 'none', playsinline: block.type === 'video', 'aria-label': block.title || name });
  const status = el('span', { role: 'status', className: 'pages-media-status', text: `${name} não carregado.` });
  let active = true, generation = 0, url, trackURL, controller, captionSignature, mediaId = block.media_id;
  const heading = el('h3'), caption = el('figcaption'), transcriptText = el('p');
  const guide=doc?.schema_version===3&&doc.template.id==='guia-interno';
  const placeholder = guide?el('p',{className:'pages-audio-placeholder',text:'Adicione um áudio com as orientações da equipe.'}):null;
  const transcript = el('details', {}, el('summary', { text: 'Transcrição' }), transcriptText);
  function refresh() {
    const current = resolveBlock(); if (!active || signal?.aborted) return;
    if (!current || current.type !== block.type || current.media_id !== mediaId) {
      clear(); mediaId = current?.media_id; load.disabled = !current?.media_id; stop.disabled = true; status.textContent = `${name} não carregado.`;
    }
    if (!current) return;
    if(guide){const emptyAudio=current.type==='audio'&&!current.media_id;figure.dataset.emptyAudio=String(emptyAudio);placeholder.hidden=!emptyAudio;}
    heading.hidden = !current.title; heading.textContent = current.title || '';
    caption.hidden = !current.caption && !current.credit; caption.textContent = [current.caption, current.credit].filter(Boolean).join(' · ');
    paintCaption(caption, captionBlock(), resolveDocument());
    transcript.hidden = !current.transcript; transcriptText.textContent = current.transcript || '';
    if (gif) media.alt = current.alt; else media.setAttribute('aria-label', current.title || name);
    load.disabled = !current.media_id || load.disabled;
    if (!current.media_id) { if (staged || revisionId) status.dataset.pagesPlaceholder = ''; status.hidden = !staged && !revisionId; status.textContent = staged || revisionId ? 'Mídia não enviada.' : ''; load.hidden = stop.hidden = true; }
    else { delete status.dataset.pagesPlaceholder; status.hidden = false; load.hidden = stop.hidden = false; }
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
  const onStop = () => { if (!active || signal?.aborted) return; clear(); load.disabled = false; stop.disabled = true; status.textContent = `${name} não carregado.`; };
  const stop = button(gif ? 'Parar animação' : 'Descarregar mídia', onStop, { disabled: true });
  const onLoad = async () => {
    if (!active || signal?.aborted || !resolveBlock()?.media_id) return;
    clear(); const request = generation; controller = new AbortController(); load.disabled = true; stop.disabled = false; status.textContent = `Carregando ${name}…`;
    try {
      const current = resolveBlock(); if (!current || current.type !== block.type) throw new Error('Media removed');
      const requestedId = current.media_id;
      const value = await api.asset(pageId, requestedId, { revisionId, staged, signal: controller.signal });
      if (!active || request !== generation || signal?.aborted || resolveBlock()?.media_id !== requestedId) { URL.revokeObjectURL(value); return; }
      url = value;
      refresh(); media.src = value; if (gif) media.hidden = false; else media.load(); status.textContent = gif ? 'Animação iniciada. Use Parar animação para interromper.' : 'Mídia carregada. Use os controles para reproduzir.';
    } catch (error) { if (active && request === generation && error.name !== 'AbortError') { status.textContent = `${name} indisponível.`; load.disabled = false; stop.disabled = true; } }
  };
  const load = button(gif ? 'Iniciar animação' : `Carregar ${name}`, onLoad);
  const figure = el('figure', { className: 'pages-private-media' }, heading, media, el('div', { className: 'pages-actions' }, load, stop), status, caption, transcript);
  refresh();
  const dispose = () => { if (!active) return; active = false; clear(); load.disabled = stop.disabled = true; load.removeEventListener('click', onLoad); stop.removeEventListener('click', onStop); signal?.removeEventListener('abort', dispose); };
  if (signal?.aborted) dispose(); else signal?.addEventListener('abort', dispose, { once: true });
  if(placeholder)figure.append(placeholder);
  return { node: figure, dispose, refresh, activate() {
    if (!active || signal?.aborted) return;
    if (!url && !load.disabled) load.click();
    media.focus({ preventScroll: true }); media.scrollIntoView({ block: 'nearest' });
  } };
}
export function focusSection(host, hash = window.location.hash) {
  if (!/^#section-[0-9a-f-]{36}$/i.test(hash)) return;
  const target = host.querySelector(`[id="${hash.slice(1)}"]`);
  if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start' }); }
}
export function renderDocument({ host, document: doc, api, pageId, revisionId, staged = false }) {
  const controller = new AbortController(), disposers = [], mediaControls = new Map();
  const blocks = new Map(doc.sections.flatMap(section => section.rows.flatMap(row => row.columns.flatMap(column => column.blocks))).map(block => [block.id, block]));
  const guide = doc.schema_version===3&&doc.template.id==='guia-interno';
  const article = el('article', { className: 'pages-document' }, el('header', guide?{className:'pages-guide-metadata'}:{}, el('h1', { text: doc.metadata.title }),
    ...(doc.metadata.summary ? [el('p', { className: 'pages-summary', text: doc.metadata.summary })] : [])));
  const v3 = doc.schema_version === 3;
  if (v3) {
    article.dataset.schemaVersion = '3'; paint(article, resolveAppearance(doc));
    paint(article.querySelector('header'), resolveAppearance(doc));
  }
  for (const section of doc.sections) {
    const sectionNode = el('section', { 'aria-label': section.label || 'Conteúdo', id: `section-${section.id}`, tabindex: '-1' });
    // Preserve empty navigation anchors without manufacturing visible row boxes.
    if (v3 && !section.rows.some(row => row.columns.some(column => column.blocks.length))) sectionNode.dataset.pagesEmptySection = '';
    for (const row of section.rows) {
      const rowNode = el('div', { className: `pages-row pages-row-${row.layout}`, 'data-row-id': row.id });
      for (const column of row.columns) {
        const columnNode = el('div', { className: 'pages-column', 'data-column-id': column.id });
        for (const block of column.blocks) {
          const wrapper = el('div', { className: 'pages-rendered-block', 'data-block-id': block.id }); applyBlockStyle(wrapper, block, doc);
          const richContext = v3 ? { document: doc, block } : undefined;
          if (v3 && block.type !== 'button') {
            const appearance = resolveAppearance(doc, block), icon = v3Icon(appearance.icon);
            if (icon) { icon.style.color = appearance.accent; wrapper.append(icon); }
            if(typographyMetrics(doc,block).cover&&doc.metadata.category){const category=el('div',{className:'pages-guide-category'},...(icon?[icon]:[]),el('span',{text:doc.metadata.category}));wrapper.append(category);}
          }
          if (block.type === 'rich_text') wrapper.append(richNode(block.content, richContext));
          else if (block.type === 'callout') {
            const callout = el('aside', { className: `pages-callout pages-callout-${block.tone}` }, ...(block.icon !== 'none' ? [el('span', { 'aria-hidden': 'true', text: { info: 'ⓘ', alert: '!', check: '✓' }[block.icon] })] : []), richNode(block.content, richContext));
            if (v3) paint(callout, resolveAppearance(doc, block));
            wrapper.append(callout);
          }
          else if (block.type === 'divider') wrapper.append(el('hr'));
          else if (block.type === 'button') {
            const component = createPageButton({ label: block.label, preset: block.preset, icon: doc.schema_version === 3 ? block.appearance?.icon : 'none',
              action: doc.schema_version === 3 ? block.action : block.destination,
              context: { api, pageId, revisionId, staged, host, signal: controller.signal, resolveBlock: id => blocks.get(id),
                activateVideo(id) {
                  const controls = mediaControls.get(id);
                  if (controls) return controls.activate();
                  // The embed renderer owns the third-party consent control. A
                  // content button must never manufacture or bypass an iframe.
                  const target = host.querySelector(`[data-block-id="${id}"]`);
                  const consent = target?.querySelector('[data-pages-video-consent]');
                  if (!consent) throw new Error('Video controls unavailable');
                  consent.focus({ preventScroll: true }); consent.scrollIntoView({ block: 'nearest' });
                } } });
            if (doc.schema_version === 3) {
              const appearance = resolveAppearance(doc, block);
              paint(component.node, appearance);
              component.node.style.fontSize = { small: '14px', standard: '16px', large: '19.2px' }[appearance.scale];
              component.node.style.borderColor = block.preset === 'text' ? 'transparent' : block.preset === 'primary' ? appearance.background : '#E1E2DD';
              component.node.dataset.font = appearance.font; component.node.dataset.scale = appearance.scale;
            } else component.node.dataset.legacy = 'true';
            wrapper.append(component.node); disposers.push(component.dispose);
          } else if (['image','gif','audio','video'].includes(block.type)) {
            const figure = (block.type === 'image' ? imageFigure : mediaFigure)(block, { api, pageId, revisionId, staged, signal: controller.signal, document: doc });
            wrapper.append(figure.node); disposers.push(figure.dispose);
            if (block.type === 'video') mediaControls.set(block.id, figure);
          } else if (v3 && ['gallery','faq','video_embed'].includes(block.type)) {
            if(guide&&block.type==='faq')wrapper.append(el('h2',{className:'pages-guide-faq-title',text:section.label}));
            const figure = renderV3Block(block, { api, pageId, revisionId, staged, signal: controller.signal, document: doc,
              richNode, imageFigure, mediaFigure, resolveBlock: () => blocks.get(block.id) });
            wrapper.append(figure.node); disposers.push(figure.dispose);
          }
          if (v3 && block.tags?.length) {
            const tags = el('div', { className: 'pages-block-tags' }, ...block.tags.map(tag => el('span', { text: tag })));
            paint(tags, resolveAppearance(doc, block)); tags.style.fontSize = '14px'; tags.style.fontWeight = '400'; wrapper.append(tags);
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
