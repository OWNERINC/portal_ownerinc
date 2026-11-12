import { el, button } from './dom.js';
import { openEditorPanel } from './editor-panels.js';

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
};
export function editorIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'pages-editor-icon' })) svg.setAttribute(key, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', paths[name] || paths.layers); svg.append(path); return svg;
}
export function editorAction(text, icon, action, attrs = {}) {
  const node = button('', action, { className: 'btn btn-ghost', ...attrs });
  node.append(editorIcon(icon), el('span', { text })); return node;
}

export function createEditorWorkspace({ root, page, header, actions, metadata, modes, toolbar, editorHost, previewHost, add, feedback, onInsert, onStyle, onSection, onSelect }) {
  let disposed = false, activeSection, currentDocument, overlay, sheetOpener, textTools, textBlockNode, isEditable = false, restoringFocus = false;
  const compact = window.matchMedia?.('(max-width: 1099px)');
  const phone = window.matchMedia?.('(max-width: 599px)');
  const structure = el('nav', { className: 'pages-v2-structure', 'aria-label': 'Estrutura da página' });
  const sectionList = el('div', { className: 'pages-v2-section-list' });
  const organize = button('Organizar estrutura', () => {
    const next = root.dataset.organizing !== 'true'; root.dataset.organizing = String(next); organize.setAttribute('aria-pressed', String(next));
  }, { 'aria-pressed': 'false', 'data-edit-only': '' });
  const sectionAdd = editorAction('Adicionar seção', 'plus', onSection, { 'data-edit-only': '' });
  structure.append(el('h2', { text: 'Estrutura' }), sectionList, sectionAdd, organize,
    el('div', { className: 'pages-v2-structure-help' }, el('strong', { text: 'Arraste para organizar' }), el('p', { text: 'Selecione um bloco para editar. Use a alça ou os comandos de posição.' })));
  const canvasTitle = el('h2', { className: 'pages-v2-content-title' });
  const canvasSummary = el('p', { className: 'pages-v2-content-summary' });
  const canvasTags = el('p', { className: 'pages-v2-content-tags' });
  const canvas = el('div', { className: 'pages-v2-canvas' }, canvasTags, canvasTitle, canvasSummary, editorHost);
  const count = el('span');
  const center = el('div', { className: 'pages-v2-center' }, el('div', { className: 'pages-v2-canvas-label' }, count, el('span', { text: 'Rascunho · não publicado automaticamente' })),
    el('div', { className: 'pages-edit-surface' }, canvas, add), previewHost);
  const inspectorTitle = el('h2', { text: 'Editar bloco' });
  const inspector = el('aside', { className: 'pages-v2-inspector', 'aria-label': 'Propriedades do editor' });
  const contentFields = el('div', { className: 'pages-v2-content-fields', 'data-inspector-section': 'content' });
  const mobileFormat = el('div', { className: 'pages-v2-mobile-format', 'data-inspector-section': 'content', hidden: true });
  const blockPanel = el('div', { className: 'pages-v2-block-panel' }, mobileFormat, contentFields, toolbar);
  const pagePanel = el('div', { className: 'pages-v2-page-panel', hidden: true }, metadata, actions);
  function setTab(tab) {
    const isPage = tab === 'page'; blockPanel.hidden = isPage; pagePanel.hidden = !isPage;
    inspectorTitle.textContent = isPage ? 'Propriedades da página' : 'Editar bloco';
    for (const node of tabs.children) node.setAttribute('aria-pressed', String(node.dataset.inspectorTab === tab));
  }
  function closeInspector(restore = true) {
    root.dataset.inspectorOpen = 'false';
    if (restore && sheetOpener?.isConnected && !sheetOpener.closest('[hidden], [inert]')) {
      restoringFocus = true; try { sheetOpener.focus(); } finally { restoringFocus = false; }
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
  inspector.append(tabs, el('div', { className: 'pages-v2-inspector-heading' }, inspectorTitle, closeButton), mobileTabs, blockPanel, pagePanel,
    button('Concluir edição', () => closeInspector(), { className: 'btn btn-primary pages-sheet-done' }));
  const openInspector = (tab = 'block', opener = document.activeElement) => {
    sheetOpener = opener; setTab(tab); root.dataset.inspectorOpen = 'true';
  };
  const openStructure = anchor => {
    overlay?.close(false);
    overlay = openEditorPanel({ page, anchor, title: 'Estrutura da página', content: structure, className: 'pages-structure-panel' });
  };
  const insert = editorAction('Inserir bloco', 'plus', () => { if (phone?.matches) overflow.open = false; onInsert(phone?.matches ? overflow.querySelector('summary') : insert); }, { className: 'btn btn-primary', 'data-edit-only': '' });
  const style = editorAction('Estilo da página', 'palette', () => { if (phone?.matches) overflow.open = false; onStyle(phone?.matches ? overflow.querySelector('summary') : style); }, { 'data-edit-only': '' });
  const model = el('span', { className: 'pages-v2-model' });
  const topTools = el('div', { className: 'pages-v2-tools' },
    editorAction('Blocos', 'layers', event => openStructure(event.currentTarget), { className: 'btn btn-ghost pages-structure-toggle' }), insert, model, style,
    el('div', { className: 'pages-v2-view-tools' }, modes, button('Propriedades', event => {
      const opener = phone?.matches ? overflow.querySelector('summary') : event.currentTarget;
      overflow.open = false; openInspector('page', opener);
      ([...pagePanel.querySelectorAll('input')].find(node => !node.disabled) || closeButton).focus();
    }, { className: 'btn btn-ghost pages-properties-toggle' })));
  const workspace = el('div', { className: 'pages-v2-workspace' }, structure, center, inspector);
  const properties = topTools.querySelector('.pages-properties-toggle');
  const primary = header.querySelector('.pages-primary-actions');
  const publish = [...(primary?.querySelectorAll('button') || [])].find(node => node.textContent === 'Publicar');
  const overflowContent = el('div', { className: 'pages-v2-overflow-content' });
  const overflow = el('details', { className: 'pages-v2-overflow' }, el('summary', { text: '•••', 'aria-label': 'Mais ações do editor' }), overflowContent);
  primary?.addEventListener('click', () => { overflow.open = false; if (phone?.matches) overflow.querySelector('summary').focus(); });
  header.append(overflow);
  root.replaceChildren(header, topTools, feedback, workspace);
  root.dataset.inspectorOpen = 'false'; root.dataset.inspectorSection = 'content'; root.dataset.organizing = 'false';
  const onKey = event => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { if (overflow.open) { overflow.open = false; overflow.querySelector('summary').focus(); } else closeInspector(); } };
  window.addEventListener('keydown', onKey);
  const onResize = () => {
    overlay?.close(false);
    if (structure.parentElement !== workspace) workspace.insertBefore(structure, center);
    if (phone?.matches) {
      overflowContent.append(primary, insert, style, properties);
      if (publish) topTools.append(publish);
    } else {
      header.insertBefore(primary, overflow); if (publish) primary.append(publish);
      topTools.insertBefore(insert, model); topTools.insertBefore(style, topTools.querySelector('.pages-v2-view-tools'));
      topTools.querySelector('.pages-v2-view-tools').append(properties);
      overflow.open = false;
    }
    const mobilePreview = modes.querySelector('[data-preview-mode="mobile"]');
    if (mobilePreview) { mobilePreview.setAttribute('aria-label', 'Prévia mobile · 402 px'); mobilePreview.textContent = phone?.matches ? 'Prévia' : 'Prévia mobile · 402 px'; }
    relocateTextTools();
    // A compact inspector is nonmodal so text remains editable. CSS reserves its
    // actual measured height; resizing never reparents or recreates PM content.
  };
  function relocateTextTools() {
    mobileFormat.hidden = !compact?.matches;
    if (!textTools || !textBlockNode) return;
    if (compact?.matches) mobileFormat.append(textTools);
    else textBlockNode.insertBefore(textTools, textBlockNode.querySelector('.pages-rich-host'));
  }
  compact?.addEventListener('change', onResize);
  phone?.addEventListener('change', onResize);
  onResize();
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    root.style.setProperty('--inspector-height', `${inspector.getBoundingClientRect().height}px`);
  }) : null;
  observer?.observe(inspector);
  return {
    canvas, structure, inspector, contentFields,
    placeContextTools(node, blockNode) { textTools = node; textBlockNode = blockNode; relocateTextTools(); },
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
      canvasTags.textContent = doc.metadata.tags.join(' · '); canvasTags.hidden = !doc.metadata.tags.length;
      count.textContent = `Página · ${doc.sections.length} ${doc.sections.length === 1 ? 'seção' : 'seções'}`;
      model.textContent = `Modelo: ${doc.template.id === 'owner-news' ? 'Owner News · sintético' : 'Comunicado'}`;
      root.querySelectorAll('[data-edit-only]').forEach(node => { node.hidden = !editable; });
      const name = header.querySelector('[data-document-name]'); if (name) name.textContent = doc.metadata.title || 'Página sem título';
    },
    rebuildStructure(doc) {
      sectionList.replaceChildren(...doc.sections.map(section => {
        const node = editorAction(section.label || 'Seção sem nome', 'layers', () => {
          activeSection = section.id;
          const first = section.rows.flatMap(row => row.columns.flatMap(col => col.blocks))[0];
          if (first && isEditable && root.dataset.editorMode !== 'preview') onSelect(first.id, false);
          overlay?.close(false);
          if (structure.parentElement !== workspace) workspace.insertBefore(structure, center);
          const target = root.dataset.editorMode === 'preview' ? previewHost.querySelector(`#section-${section.id}`) : editorHost.querySelector(`[data-section-id="${section.id}"]`);
          target?.scrollIntoView?.({ block: 'start' });
          (target?.querySelector('.pages-select-block') || target)?.focus?.({ preventScroll: true });
        }, { className: 'btn btn-ghost pages-v2-section-link', 'data-structure-section': section.id, 'aria-pressed': String(section.id === activeSection) });
        return node;
      }));
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
    },
    showMode(editing) { root.dataset.editorMode = editing ? 'edit' : 'preview'; if (!editing) closeInspector(false); },
    dispose() {
      if (disposed) return; disposed = true; overlay?.close(false); observer?.disconnect();
      compact?.removeEventListener('change', onResize); window.removeEventListener('keydown', onKey);
      phone?.removeEventListener('change', onResize);
    },
  };
}
