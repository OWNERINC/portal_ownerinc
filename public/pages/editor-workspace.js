import { el, button } from './dom.js';
import { openEditorPanel, watchVisualViewport, restoreVisibleFocus } from './editor-panels.js';
import { applyBlockStyle } from './renderer.js';

// Simple local geometry, matching the line-icon vocabulary of the supplied SVGs.
const paths = {
  plus: 'M12 5v14M5 12h14', back: 'm12 5-7 7 7 7M5 12h14',
  layers: 'm12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5',
  text: 'M4 5h16M12 5v14M8 19h8', columns: 'M4 4h16v16H4ZM12 4v16',
  image: 'M4 4h16v16H4ZM4 16l5-5 5 5 3-3 3 3M8 8h.01',
  video: 'M3 6h12v12H3ZM15 10l6-4v12l-6-4', audio: 'M4 14v-3a8 8 0 0 1 16 0v3M4 12h3v8H4ZM17 12h3v8h-3Z',
  button: 'M4 6h16v12H4ZM8 12h8m-3-3 3 3-3 3', divider: 'M3 12h18',
  callout: 'M4 4h16v13H9l-5 4V4ZM8 8h8M8 12h5',
  palette: 'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h5a4 4 0 0 0 4-4c0-3-4-6-9-6ZM7 9h.01M10 6h.01M15 7h.01',
  marker: 'm15 3 6 6-9 9H6v-6ZM4 18l2 2M2 22h8',
  undo: 'm8 5-5 5 5 5M3 10h10a6 6 0 0 1 0 12', redo: 'm16 5 5 5-5 5M21 10h-10a6 6 0 0 0 0 12',
  cover: 'M4 4h16v16H4ZM4 8h16', info: 'M12 11v6m0-10v1M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20',
  publish: 'M7 17 17 7M7 7h10v10', monitor: 'M3 4h18v13H3ZM12 17v4M8 21h8',
  chevron: 'm6 9 6 6 6-6',
};
export function editorIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false', class: 'pages-editor-icon' })) svg.setAttribute(key, value);
  if (name === 'eye') {
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '/assets/icons.svg#eye'); svg.append(use); return svg;
  }
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[name] || paths.layers); svg.append(path); return svg;
}
export function editorAction(text, icon, action, attrs = {}) {
  const node = button('', action, { className: 'btn btn-ghost', ...attrs });
  node.append(editorIcon(icon), el('span', { text })); return node;
}

export function viewportGeometry({ device, zoom, available, height }) {
  if (!['desktop','mobile'].includes(device) || ![50,75,100,125,150].includes(zoom)) throw new Error('Invalid viewport');
  const width = device === 'mobile' ? 390 : Math.max(1, available), scale = zoom / 100;
  return { width, scale, scaledWidth: width * scale, scaledHeight: height * scale };
}

// One receipt/key per chosen model for this visit. Opening a menu has no effect;
// uncertain create or a failed/cancelled navigation must not create another page.
export function createModelDraftController({ newId, create, beforeCreate, canAct, navigate, onBusy = () => {} }) {
  const requests = new Map(); let active = true, busy = false;
  return {
    async choose(templateId) {
      if (!active || busy || !canAct()) return false;
      const permit = beforeCreate(); if (!permit) return false;
      let request = requests.get(templateId);
      if (!request) { request = { payload: { template_id: templateId, client_mutation_id: newId() } }; requests.set(templateId, request); }
      busy = true; onBusy(true);
      try {
        if (!request.ack) request.ack = await create(request.payload);
        if (!active) return false;
        return await navigate(request.ack, permit);
      } finally { busy = false; if (active) onBusy(false); }
    },
    dispose() { active = false; },
  };
}

export function createEditorWorkspace({ root, page, menus, header, actions, metadata, modes, toolbar, editorHost, previewHost, add, feedback, onInsert, onStyle, onSection, onSelect,
  onUndo, onRedo, onModel, onDevice, onZoom, templates = [],
  sortableFactory, onReorderSection, canReorder = () => false, onLayoutDragging = () => {} }) {
  let disposed = false, activeSection, currentDocument, overlay, sheetOpener, textTools, textBlockNode, isEditable = false, restoringFocus = false, sectionSortable, sectionDragging = false, dragCancelled = false, stopViewport;
  let formatOrder = [];
  const compact = window.matchMedia?.('(max-width: 1099px)');
  const phone = window.matchMedia?.('(max-width: 599px)');
  const structure = el('nav', { className: 'pages-v2-structure', 'aria-label': 'Estrutura da página' });
  structure.dataset.organizing = 'false';
  const sectionList = el('div', { className: 'pages-v2-section-list' });
  const organize = button('Organizar estrutura', () => {
    const next = structure.dataset.organizing !== 'true';
    structure.dataset.organizing = root.dataset.organizing = String(next); organize.setAttribute('aria-pressed', String(next));
  }, { 'aria-pressed': 'false', 'data-edit-only': '' });
  const sectionAdd = editorAction('Adicionar seção', 'plus', onSection, { 'data-edit-only': '' });
  organize.setAttribute('aria-label','Organizar estrutura');organize.textContent='Arraste para organizar';
  structure.append(el('h2', { text: 'Estrutura' }), sectionList, sectionAdd,
    el('div', { className: 'pages-v2-structure-help' }, organize, el('p', { text: 'Selecione um bloco para editar. Use a alça ou os botões de mover.' })));
  const canvasTitle = el('h2', { className: 'pages-v2-content-title' });
  const canvasSummary = el('p', { className: 'pages-v2-content-summary' });
  const canvasTags = el('p', { className: 'pages-v2-content-tags' });
  const canvasMetadata = el('div', { className: 'pages-v2-canvas-metadata' }, canvasTags, canvasTitle, canvasSummary);
  const canvas = el('div', { className: 'pages-v2-canvas' }, canvasMetadata, editorHost);
  const surface = el('div', { className: 'pages-edit-surface pages-editor-surface' }, canvas, add, previewHost);
  const scaled = el('div', { className: 'pages-v2-scaled-surface' }, surface);
  const viewport = el('div', { className: 'pages-v2-viewport' }, scaled);
  const count = el('span');
  const mobileNotice = el('p', { className: 'pages-v2-mobile-notice', text: 'Prévia · conteúdo ilustrativo', hidden: true });
  const center = el('div', { className: 'pages-v2-center' }, el('div', { className: 'pages-v2-canvas-label' }, count, el('span', { text: 'Rascunho · salvar é explícito' })), mobileNotice, viewport);
  let view = { device: 'desktop', zoom: 100 };
  function measureViewport() {
    if (disposed) return;
    const geometry = viewportGeometry({ ...view, available: viewport.clientWidth || 1044, height: surface.offsetHeight });
    surface.style.width = `${geometry.width}px`;
    surface.style.transform = `scale(${geometry.scale})`;
    // Keep the established paper spacing when it already clears the toolbar.
    // The toolbar is unscaled, anchored 16 paper pixels inside the block: reserve
    // its measured border-box plus a real 4px gap even at 50% or after wrapping.
    const toolbarHeight = textTools?.offsetHeight || 44;
    const contextSpace = Math.max(44 / geometry.scale + 28, (toolbarHeight + 4) / geometry.scale + 16);
    surface.style.setProperty('--pages-context-space', `${contextSpace}px`);
    scaled.style.width = `${geometry.scaledWidth}px`;
    scaled.style.height = `${surface.offsetHeight * geometry.scale}px`;
    positionTextTools();
  }
  const inspectorTitle = el('h2', { text: 'Editar bloco' });
  const inspector = el('aside', { className: 'pages-v2-inspector', 'aria-label': 'Propriedades do editor' });
  const contentFields = el('div', { className: 'pages-v2-content-fields', 'data-inspector-section': 'content' });
  const mobileFormat = el('div', { className: 'pages-v2-mobile-format', 'data-inspector-section': 'content', hidden: true });
  const extraFormat = el('div', { className: 'pages-v2-extra-format', 'data-inspector-section': 'style', hidden: true });
  const blockPanel = el('div', { className: 'pages-v2-block-panel' }, mobileFormat, contentFields, extraFormat, toolbar);
  const pagePanel = el('div', { className: 'pages-v2-page-panel', hidden: true }, metadata, actions);
  function setTab(tab) {
    const isPage = tab === 'page'; blockPanel.hidden = isPage; pagePanel.hidden = !isPage;
    inspectorTitle.textContent = isPage ? 'Propriedades da página' : compact?.matches ? 'Editar bloco' : currentDocument?.sections.find(s=>s.id===activeSection)?.label || 'Editar bloco';
    for (const node of tabs.children) node.setAttribute('aria-pressed', String(node.dataset.inspectorTab === tab));
  }
  function closeInspector(restore = true) {
    root.dataset.inspectorOpen = 'false';
    syncSheetViewport();
    if (restore) {
      restoringFocus = true;
      try { restoreVisibleFocus([sheetOpener, textBlockNode?.querySelector('.ProseMirror'), header.querySelector('.pages-v2-back')]); }
      finally { restoringFocus = false; }
    }
  }
  function keepFocusVisible({ top = window.visualViewport?.offsetTop || 0 } = {}) {
    const focused = document.activeElement;
    if (!focused || document.querySelector('dialog[open]')) return;
    if (inspector.contains(focused)) {
      const box = focused.getBoundingClientRect(), sheet = inspector.getBoundingClientRect();
      if (box.top < sheet.top + 50 || box.bottom > sheet.bottom - 12) focused.scrollIntoView?.({ block: 'nearest' });
    } else if (textBlockNode?.contains(focused)) {
      const selection = window.getSelection?.();
      const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : focused.getBoundingClientRect();
      const bottom = inspector.getBoundingClientRect().top - 12;
      if (rect.bottom > bottom) window.scrollBy?.(0, rect.bottom - bottom);
      else if (rect.top < top + 8) window.scrollBy?.(0, rect.top - top - 8);
    }
  }
  function syncSheetViewport() {
    const active = !disposed && compact?.matches && root.dataset.inspectorOpen === 'true';
    if (active && !stopViewport) {
      inspector.setAttribute('role', 'dialog'); inspector.setAttribute('aria-modal', 'false');
      stopViewport = watchVisualViewport(inspector, keepFocusVisible);
      root.addEventListener('focusin', keepFocusVisible);
      document.addEventListener('selectionchange', keepFocusVisible);
    } else if (!active) {
      stopViewport?.(); stopViewport = null;
      root.removeEventListener('focusin', keepFocusVisible);
      document.removeEventListener('selectionchange', keepFocusVisible);
      inspector.removeAttribute('role'); inspector.removeAttribute('aria-modal');
    }
  }
  const closeButton = button('×', () => closeInspector(), { className: 'btn btn-ghost pages-icon-button pages-sheet-close', 'aria-label': 'Fechar propriedades' });
  const tabs = el('div', { className: 'pages-v2-inspector-tabs', role: 'group', 'aria-label': 'Propriedades' },
    button('Bloco', () => setTab('block'), { 'data-inspector-tab': 'block', 'aria-pressed': 'true' }), button('Página', () => setTab('page'), { 'data-inspector-tab': 'page', 'aria-pressed': 'false' }));
  const mobileTabs = el('div', { className: 'pages-v2-sheet-tabs', role: 'group', 'aria-label': 'Editar bloco' });
  for (const [value, label] of [['content','Conteúdo'], ['style','Estilo'], ['position','Posição']]) mobileTabs.append(button(label, () => {
    root.dataset.inspectorSection = value;
    for (const node of mobileTabs.children) node.setAttribute('aria-pressed', String(node.dataset.sheetTab === value));
  }, { 'data-sheet-tab': value, 'aria-pressed': String(value === 'content') }));
  blockPanel.insertBefore(el('p',{className:'pages-v2-inspector-help',text:'Personalize somente o bloco selecionado.'}),blockPanel.firstElementChild);
  inspector.append(tabs, el('div', { className: 'pages-v2-inspector-heading' }, inspectorTitle, closeButton), mobileTabs, blockPanel, pagePanel,
    button('Concluir edição', () => closeInspector(), { className: 'btn btn-primary pages-sheet-done', 'aria-label': 'Concluir edição' }));
  const openInspector = (tab = 'block', opener = document.activeElement) => {
    if (!inspector.contains(opener)) sheetOpener = opener;
    setTab(tab); root.dataset.inspectorOpen = 'true'; syncSheetViewport();
  };
  const openStructure = anchor => {
    overlay?.close(false);
    overlay = openEditorPanel({ page, anchor, title: 'Estrutura da página', content: structure, className: 'pages-structure-panel' });
  };
  const insert = editorAction('Inserir bloco', 'plus', () => { if (phone?.matches) overflow.open = false; onInsert(phone?.matches ? overflow.querySelector('summary') : insert); }, { className: 'btn btn-primary', 'data-edit-only': '' });
  const style = editorAction('Estilo da página', 'palette', () => { if (phone?.matches) overflow.open = false; onStyle(phone?.matches ? overflow.querySelector('summary') : style); }, { 'data-edit-only': '' });
  const model = el('select', { className: 'pages-v2-model', 'aria-label': 'Modelo', 'data-edit-only': '' }, el('option', { value: '', text: 'Modelo' }));
  const modelHit=el('label',{className:'pages-v2-select-hit','data-edit-only':''},model);
  for (const template of templates) model.append(el('option', { value: template.id, text: `Novo: ${template.name}` }));
  model.addEventListener('change', () => { const id = model.value; model.value = ''; if (id && !model.disabled) onModel?.(id); });
  const undo = editorAction('Desfazer', 'undo', onUndo, { 'data-history': 'undo', 'aria-label': 'Desfazer', title: 'Desfazer', disabled: true });
  const redo = editorAction('Refazer', 'redo', onRedo, { 'data-history': 'redo', 'aria-label': 'Refazer', title: 'Refazer', disabled: true });
  const device = el('select', { 'aria-label': 'Dispositivo', className: 'pages-v2-device' }, el('option', { value: 'desktop', text: 'Desktop' }), el('option', { value: 'mobile', text: 'Celular · 390 px' }));
  const deviceChevron = editorIcon('chevron'); deviceChevron.classList.add('pages-device-chevron');
  const zoom = el('select', { 'aria-label': 'Zoom', className: 'pages-v2-zoom' }, ...[50,75,100,125,150].map(value => el('option', { value, text: `${value}%`, selected: value === 100 })));
  const setViewport = next => { view = { ...view, ...next }; device.value = view.device; zoom.value = String(view.zoom); root.dataset.device = view.device; root.dataset.zoom = String(view.zoom); measureViewport(); };
  device.addEventListener('change', () => { setViewport({ device: device.value }); onDevice?.(view.device); });
  zoom.addEventListener('change', () => { setViewport({ zoom: Number(zoom.value) }); onZoom?.(view.zoom); });
  const topTools = el('div', { className: 'pages-v2-tools' },
    editorAction('Blocos', 'layers', event => openStructure(event.currentTarget), { className: 'btn btn-ghost pages-structure-toggle' }), insert, modelHit, style,
    el('div', { className: 'pages-v2-view-tools' }, undo, redo, el('label',{className:'pages-v2-select-hit pages-device-control'},editorIcon('monitor'),device,deviceChevron), el('label',{className:'pages-v2-select-hit'},zoom), button('Propriedades', event => {
      const opener = phone?.matches ? overflow.querySelector('summary') : event.currentTarget;
      overflow.open = false; openInspector('page', opener);
      ([...pagePanel.querySelectorAll('input')].find(node => !node.disabled) || closeButton).focus();
    }, { className: 'btn btn-ghost pages-properties-toggle' })));
  const workspace = el('div', { className: 'pages-v2-workspace' }, structure, center, inspector);
  const properties = topTools.querySelector('.pages-properties-toggle');
  const viewTools = topTools.querySelector('.pages-v2-view-tools');
  const primary = header.querySelector('.pages-primary-actions');
  const publish = [...(primary?.querySelectorAll('button') || [])].find(node => node.textContent === 'Publicar');
  const preview = primary?.querySelector('.pages-v2-preview-menu');
  const overflowContent = el('div', { className: 'pages-v2-overflow-content' });
  const overflow = el('details', { className: 'pages-v2-overflow' }, el('summary', { text: '•••', 'aria-label': 'Mais ações do editor' }), overflowContent);
  const unregisterOverflow = menus?.register(overflow);
  preview?.addEventListener('click', event => {
    if (!phone?.matches) return;
    overflow.open = false;
    if (event.target.closest('[data-preview-mode]')) preview.querySelector('summary').focus();
  });
  primary?.addEventListener('click', event => {
    // Opening the nested preview chooser is not a completed action. Keep its
    // containing mobile menu open until an actual preview mode is selected.
    if (event.target.closest('.pages-v2-preview-menu > summary')) return;
    overflow.open = false; if (phone?.matches) overflow.querySelector('summary').focus();
  });
  header.append(overflow);
  root.replaceChildren(header, topTools, feedback, workspace);
  root.dataset.inspectorOpen = 'false'; root.dataset.inspectorSection = 'content'; root.dataset.organizing = 'false';
  const onKey = event => { if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return; if (event.key === 'Escape' && sectionDragging) { dragCancelled = true; event.preventDefault(); return; } if (event.key === 'Escape' && !document.querySelector('dialog[open]')) closeInspector(); };
  window.addEventListener('keydown', onKey);
  const onHistory = () => { if (!document.querySelector('dialog[open]')) closeInspector(false); };
  window.addEventListener('popstate', onHistory);
  const onResize = () => {
    overlay?.close(false);
    if (structure.parentElement !== workspace) workspace.insertBefore(structure, center);
    if (phone?.matches) {
      overflowContent.append(primary, insert, modelHit, style, properties);
      if (preview) topTools.insertBefore(preview, topTools.children[1]);
      if (publish) topTools.append(publish);
      overflowContent.append(viewTools);
    } else {
      header.insertBefore(primary, overflow); if (preview) primary.append(preview); if (publish) primary.append(publish);
      topTools.append(viewTools);
      topTools.insertBefore(modelHit, style.parentElement===topTools?style:topTools.querySelector('.pages-v2-view-tools'));topTools.insertBefore(insert, modelHit); topTools.insertBefore(style, topTools.querySelector('.pages-v2-view-tools'));
      topTools.querySelector('.pages-v2-view-tools').append(properties);
      overflow.open = false;
    }
    measureViewport();
    relocateTextTools();
    setTab(pagePanel.hidden ? 'block' : 'page'); syncSheetViewport();
    // A compact inspector is nonmodal so text remains editable. CSS reserves its
    // actual measured height; resizing never reparents or recreates PM content.
  };
  function relocateTextTools() {
    mobileFormat.hidden = !compact?.matches;
    extraFormat.hidden = !compact?.matches;
    if (!textTools || !textBlockNode) return;
    const link = textTools.querySelector('[aria-label="Link"]');
    if (link) link.textContent = compact?.matches ? 'Link' : '↗';
    if (compact?.matches) {
      mobileFormat.append(textTools);
      for (const node of formatOrder) if (!['Estilo do texto','Links'].includes(node.getAttribute('aria-label'))) extraFormat.append(node);
    } else { for (const node of formatOrder) textTools.append(node); viewport.append(textTools); positionTextTools(); }
  }
  function positionTextTools() {
    if (!textTools || !textBlockNode?.isConnected || compact?.matches) return;
    const block = textBlockNode.getBoundingClientRect(), frame = viewport.getBoundingClientRect();
    textTools.style.left = `${block.left - frame.left + viewport.scrollLeft + 16 * view.zoom / 100}px`;
    textTools.style.top = `${block.top - frame.top + viewport.scrollTop + 16 * view.zoom / 100}px`;
  }
  compact?.addEventListener('change', onResize);
  phone?.addEventListener('change', onResize);
  onResize();
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    root.style.setProperty('--inspector-height', `${inspector.getBoundingClientRect().height}px`);
  }) : null;
  observer?.observe(inspector);
  const viewportObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(measureViewport) : null;
  viewportObserver?.observe(viewport); viewportObserver?.observe(surface);
  setViewport(view);
  return {
    canvas, structure, inspector, contentFields,
    setViewport,
    setHistory({ canUndo, canRedo }) { undo.disabled = !canUndo; redo.disabled = !canRedo; },
    setModelBusy(value) { model.disabled = Boolean(value); },
    placeContextTools(node, blockNode) {
      if (textTools) viewportObserver?.unobserve(textTools);
      textBlockNode?.classList.remove('has-context-tools'); extraFormat.replaceChildren(); textTools = node; formatOrder = node ? [...node.children] : []; textBlockNode = blockNode; blockPanel.dataset.richText = String(!!node); blockNode?.classList.add('has-context-tools');
      relocateTextTools();
      if (textTools) viewportObserver?.observe(textTools);
      measureViewport();
    },
    focusText() {
      if (restoringFocus) return;
      openInspector('block'); root.dataset.inspectorSection = 'content';
      for (const node of mobileTabs.children) node.setAttribute('aria-pressed', String(node.dataset.sheetTab === 'content'));
    },
    showPage: () => openInspector('page'),
    closeInspector,
    refresh(doc, editable) {
      if (disposed) return;
      currentDocument = doc; isEditable = editable; canvasTitle.textContent = doc.metadata.title || 'Página sem título'; canvasSummary.textContent = doc.metadata.summary;
      // Reuse the renderer's canonical painter, not separate preview colors.
      for(const surface of [canvas,canvasTitle,canvasSummary,canvasTags]){
        if(doc.schema_version===3)applyBlockStyle(surface,{type:'rich_text'},doc);
        else if(surface.dataset.schemaVersion==='3'){
          surface.style.color='';surface.style.backgroundColor='';
          for(const key of ['schemaVersion','font','align','scale','palette'])delete surface.dataset[key];
        }
      }
      canvasTags.textContent = doc.metadata.tags.join(' · '); canvasTags.hidden = !doc.metadata.tags.length;
      count.textContent = `Página · ${doc.sections.length} ${doc.sections.length === 1 ? 'seção' : 'seções'}`;
      model.firstElementChild.textContent = `Modelo: ${doc.template.id === 'guia-interno' ? 'Guia interno' : doc.template.id === 'owner-news' ? 'Owner News' : 'Comunicado'}`;
      const hasCover = doc.schema_version === 3 && doc.template.id === 'guia-interno';
      mobileNotice.hidden = !hasCover;
      canvasMetadata.hidden = hasCover;
      const subtitle = header.querySelector('.pages-v2-header-subtitle');
      if (subtitle) subtitle.textContent = `Conteúdos / ${doc.metadata.category || 'Página'}`;
      root.querySelectorAll('[data-edit-only]').forEach(node => { node.hidden = !editable; });
      const name = header.querySelector('[data-document-name]'); if (name) name.textContent = doc.metadata.title || 'Página sem título';
    },
    rebuildStructure(doc) {
      sectionSortable?.destroy(); sectionSortable = null;
      currentDocument = doc;
      const move = (sectionId, delta) => {
        if (!canReorder()) return;
        const sections = currentDocument.sections, index = sections.findIndex(s => s.id === sectionId);
        if (index < 0 || index + delta < 0 || index + delta >= sections.length) return;
        onReorderSection?.({ sectionId, beforeSectionId: delta < 0 ? sections[index - 1].id : sections[index + 2]?.id });
        sectionList.querySelector(`[data-structure-section="${sectionId}"]`)?.focus({ preventScroll: true });
      };
      sectionList.replaceChildren(...doc.sections.map(section => {
        const firstBlock = section.rows.flatMap(row => row.columns.flatMap(col => col.blocks))[0];
        const icon = section.rows.some(r=>r.columns.length===2)&&firstBlock?.type!=='faq'?'columns':section===doc.sections[0]&&firstBlock?.type==='rich_text'?'cover':{ rich_text: 'text', image: 'image', gif: 'image', gallery: 'image', faq: 'info', audio: 'audio', video: 'video', video_embed: 'video', button: 'button', callout: 'callout', divider: 'divider' }[firstBlock?.type] || 'image';
        const node = editorAction(section.label || 'Seção sem nome', icon, () => {
          activeSection = section.id;
          const first = section.rows.flatMap(row => row.columns.flatMap(col => col.blocks))[0];
          if (first && isEditable && root.dataset.editorMode !== 'preview') onSelect(first.id, false);
          overlay?.close(false);
          if (structure.parentElement !== workspace) workspace.insertBefore(structure, center);
          const target = root.dataset.editorMode === 'preview' ? previewHost.querySelector(`#section-${section.id}`) : editorHost.querySelector(`[data-section-id="${section.id}"]`);
          target?.scrollIntoView?.({ block: 'start' });
          (target?.querySelector('.pages-select-block') || target)?.focus?.({ preventScroll: true });
        }, { className: 'btn btn-ghost pages-v2-section-link', 'data-structure-section': section.id, 'aria-pressed': String(section.id === activeSection) });
        node.addEventListener('keydown', event => {
          if (event.altKey && ['ArrowUp','ArrowDown'].includes(event.key)) { event.preventDefault(); move(section.id, event.key === 'ArrowUp' ? -1 : 1); }
        });
        const index = doc.sections.indexOf(section), label = section.label || 'Seção sem nome';
        const handle = button('⋮⋮', () => node.focus(), { className: 'btn btn-ghost pages-section-drag-handle', 'aria-label': `Arrastar seção ${label}; Alt+setas para mover`, 'data-edit-only': '', hidden: !isEditable });
        handle.addEventListener('keydown', event => { if (event.altKey && ['ArrowUp','ArrowDown'].includes(event.key)) { event.preventDefault(); move(section.id, event.key === 'ArrowUp' ? -1 : 1); } });
        const position = el('details', { className: 'pages-v2-section-position', 'data-edit-only': '', hidden: !isEditable }, el('summary', { text: 'Posição', 'aria-label': `Posição da seção ${label}` }),
          el('div', { className: 'pages-v2-section-actions' },
            button('Subir', () => move(section.id, -1), { 'aria-label': `Subir seção ${label}`, disabled: index === 0 }),
            button('Descer', () => move(section.id, 1), { 'aria-label': `Descer seção ${label}`, disabled: index === doc.sections.length - 1 })));
        return el('div', { className: 'pages-v2-section-entry', 'data-section-sort-id': section.id }, node, handle, position);
      }));
      if (sortableFactory && isEditable) sectionSortable = sortableFactory(sectionList, {
        draggable: '[data-section-sort-id]', handle: '.pages-section-drag-handle', animation: 0, forceFallback: true, fallbackOnBody: true,
        onMove: () => canReorder(),
        onStart() { sectionDragging = true; dragCancelled = false; onLayoutDragging(true); },
        onEnd(event) {
          try {
            const sectionId = event.item.dataset.sectionSortId, beforeSectionId = event.item.nextElementSibling?.dataset.sectionSortId;
            if (dragCancelled || !canReorder() || !onReorderSection?.({ sectionId, beforeSectionId })) restoreOrder();
            sectionList.querySelector(`[data-structure-section="${sectionId}"]`)?.focus({ preventScroll: true });
          } finally { sectionDragging = false; onLayoutDragging(false); }
        },
      });
      const restoreOrder = () => { if (!disposed) for (const section of currentDocument.sections) { const node = sectionList.querySelector(`[data-section-sort-id="${section.id}"]`); if (node) sectionList.append(node); } };
    },
    select(block, fields, open = true) {
      if (disposed) return;
      const section = currentDocument?.sections.find(s => s.rows.some(r => r.columns.some(c => c.blocks.some(b => b.id === block?.id))));
      activeSection = section?.id;
      sectionList.querySelectorAll('[data-structure-section]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.structureSection === activeSection)));
      if (fields && contentFields.firstElementChild !== fields) contentFields.replaceChildren(fields);
      if (fields) fields.hidden = false;
      if (!fields) contentFields.replaceChildren(el('p', { className: 'pages-v2-field-hint', text: block ? 'Edite o texto diretamente na página. Use Estilo ou Posição para personalizar este bloco.' : 'Selecione um bloco na página.' }));
      if (open) openInspector('block');
      if (!pagePanel.hidden) return;
      inspectorTitle.textContent = compact?.matches && block ? 'Editar bloco' : section?.label || (block ? 'Editar bloco' : 'Selecione um bloco');
    },
    showMode(editing) { root.dataset.editorMode = editing ? 'edit' : 'preview'; add.hidden=!editing||!isEditable; if(textTools)textTools.hidden=!editing; if (!editing) closeInspector(false); measureViewport(); },
    dispose() {
      unregisterOverflow?.();
      if (disposed) return; disposed = true; overlay?.close(false); observer?.disconnect(); viewportObserver?.disconnect(); sectionSortable?.destroy(); onLayoutDragging(false);
      syncSheetViewport(); window.removeEventListener('popstate', onHistory);
      compact?.removeEventListener('change', onResize); window.removeEventListener('keydown', onKey);
      phone?.removeEventListener('change', onResize);
    },
  };
}
