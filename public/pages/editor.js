import { createPagesAPI } from './api.js';
import { createRichEditor, createSortable } from './vendor/editor.js';
import { createEditorState } from './state.js';
import { allBlocks, blockList, clone, newId, publicationIssues, safeLink, textBlock } from './model.js';
import { el, button, link, field, errorText, showError } from './dom.js';
import { renderDocument, imageFigure, mediaFigure, applyBlockStyle } from './renderer.js';
import { openPagesDialog } from './dialog.js';
import { compose, findBlock, findColumn, columns, genericBlock, defaultStyle, adjacentMove } from './composition.js';
import { createEditorWorkspace, editorAction, editorIcon } from './editor-workspace.js';
import { openEditorPanel } from './editor-panels.js';

const statusLabels = { saved: 'Salvo', saving: 'Salvando…', dirty: 'Alterações não salvas', failure: 'Falha ao salvar — tente novamente', conflict: 'Conflito — recarregue a página' };
const blockLabels = { rich_text: 'Texto', image: 'Imagem', gif: 'GIF', audio: 'Áudio', video: 'Vídeo', callout: 'Destaque', button: 'Botão', divider: 'Separador' };
const optionLabels = { start: 'À esquerda', center: 'Centralizado', end: 'À direita', small: 'Pequena', standard: 'Padrão', large: 'Grande', neutral: 'Neutra', brand: 'Marca', warm: 'Quente', manrope: 'Manrope', 'source-serif-4': 'Source Serif 4', oswald: 'Oswald', info: 'Informação', attention: 'Atenção', success: 'Sucesso', none: 'Sem ícone', alert: 'Alerta', check: 'Confirmação', primary: 'Primário', secondary: 'Secundário', text: 'Texto' };

export function mountPageEditor(page) {
  const root = document.getElementById('page-editor-root'); if (!root) return;
  const api = createPagesAPI(page);
  let state, cargos = [], activeId, mode = 'edit', disposed = false, writePending = false, uploadRetry = null;
  let richEditors = new Map(), blockDisposers = [], previewDispose, editorHost, previewHost, toolbar, status, saveButton, publishButton, feedback, uploadStatus, retryUploadButton, cancelUploadButton, undoDeleteButton, loadSequence = 0;
  const recovery = [];
  const blockNodes = new Map(); let sortables = [], compositionStatus, layoutDragging = false;
  let documentURL, workspaceUI, contextTools, editorPanel, insertActions, uploadInput;
  document.body.classList.add('pages-editor-active');
  const documentLocation = () => { const url = new URL(page.location.href); return url.pathname + url.search; };
  const live = () => page.active && !disposed;
  page.beforeLeave(() => {
    if (writePending || state?.blocked) { page.toast('Aguarde as gravações e uploads.'); return false; }
    return (!state?.dirty && !state?.pending && !uploadRetry) || window.confirm('Sair sem salvar as alterações locais desta Page?');
  });
  page.listen(window, 'beforeunload', event => {
    if (state?.dirty || state?.pending || state?.blocked || writePending || uploadRetry) { event.preventDefault(); event.returnValue = ''; }
  });
  function destroyBlocks() { layoutDragging = false; sortables.forEach(item => item.destroy()); sortables = []; richEditors.forEach(editor => editor.destroy()); richEditors.clear(); blockDisposers.forEach(fn => fn()); blockDisposers = []; blockNodes.forEach(item => item.dispose?.()); blockNodes.clear(); }
  page.cleanup(() => { disposed = true; workspaceUI?.dispose(); editorPanel?.close(false); previewDispose?.(); destroyBlocks(); uploadRetry = null; document.body.classList.remove('pages-editor-active'); });
  function update() {
    if (!live() || !state || !status) return;
    status.textContent = statusLabels[state.status];
    saveButton.disabled = !state.workspace.capabilities.edit || state.blocked || writePending || state.status === 'conflict' || (!state.dirty && !state.pending);
    saveButton.textContent = state.status === 'failure' && state.pending ? 'Salvar rascunho (tentar novamente)' : 'Salvar rascunho';
    // Only a confirmed clean revision can enter the publication dialog.
    publishButton.disabled = !state.publishable || writePending || !!uploadRetry;
    uploadStatus.textContent = state.uploads ? 'Enviando imagem…' : uploadRetry ? 'Upload não confirmado. Tente novamente ou cancele.' : '';
    if (retryUploadButton) { retryUploadButton.hidden = !uploadRetry; retryUploadButton.disabled = state.blocked; }
    if (cancelUploadButton) { cancelUploadButton.hidden = !uploadRetry; cancelUploadButton.disabled = state.blocked; }
    if (undoDeleteButton) undoDeleteButton.disabled = !recovery.length || state.blocked;
    const audienceSummary = root.querySelector('[data-audience-summary]');
    if (audienceSummary) { const count = state.document.metadata.audience.job_title_ids.length; audienceSummary.textContent = `Público e destinos (${count} ${count === 1 ? 'cargo selecionado' : 'cargos selecionados'})`; }
    root.dataset.saveState = state.status;
    workspaceUI?.refresh(state.document, state.workspace.capabilities.edit);
  }
  function changed() { state.changed(); }
  function fail(error) { if (live()) feedback.textContent = errorText(error); }
  function select(id, open = true) {
    activeId = id;
    editorHost?.querySelectorAll('[data-block-id]').forEach(node => node.classList.toggle('is-selected', node.dataset.blockId === id));
    renderToolbar();
    workspaceUI?.select(findBlock(state.document, id)?.block, blockNodes.get(id)?.fields, open);
  }
  function containerFor(id) {
    for (const section of state.document.sections) for (const row of section.rows) for (const col of row.columns) {
      const index = col.blocks.findIndex(block => block.id === id); if (index >= 0) return { blocks: col.blocks, columnId: col.id, index };
    }
    return null;
  }
  function mutateBlocks(action) {
    if (!state.workspace.capabilities.edit || writePending || state.blocked) return;
    action(); changed(); renderBlocks();
  }
  function composition(command, announce = 'Composição atualizada.') {
    if (!command || !state.workspace.capabilities.edit || writePending || state.blocked) return false;
    const next = compose(state.document, command); if (!next) return false;
    for (const item of recovery) if (!findColumn(next, item.columnId)) {
      const old = findColumn(state.document, item.columnId), merged = old && next.sections.flatMap(s => s.rows).find(row => row.id === old.row.id);
      if (merged?.layout === 'single') { item.index += old.row.columns[0].blocks.length; item.columnId = merged.columns[0].id; }
    }
    state.replace(next); renderBlocks();
    if (compositionStatus) compositionStatus.textContent = announce;
    return true;
  }
  function selectedColumn() { return findBlock(state.document, activeId)?.column.id || state.document.sections[0].rows[0].columns[0].id; }
  function addText() {
    mutateBlocks(() => { if (allBlocks(state.document).length >= 100) return page.toast('Limite de 100 blocos.');
      const block = textBlock(); findColumn(state.document, selectedColumn()).column.blocks.push(block); activeId = block.id; });
    richEditors.get(activeId)?.focus();
  }
  function toolbarCommand(label, fn, attrs) {
    const node = button(label, fn, attrs);
    node.addEventListener('mousedown', event => event.preventDefault()); return node;
  }
  function renderToolbar() {
    if (!toolbar || !state.workspace.capabilities.edit) return;
    const block = allBlocks(state.document).find(item => item.id === activeId);
    contextTools?.remove(); contextTools = null;
    workspaceUI?.placeContextTools(null, null);
    toolbar.replaceChildren(); if (!block) { toolbar.append(el('span', { className: 'pages-toolbar-empty', text: 'Selecione um bloco para editar.' })); workspaceUI?.select(null, null, false); return; }
    const items = allBlocks(state.document), index = items.indexOf(block);
    const up = toolbarCommand('Subir', () => composition(adjacentMove(state.document, activeId, -1), 'Bloco movido para cima.'), { disabled: index === 0, 'aria-label': 'Mover bloco para cima' });
    const down = toolbarCommand('Descer', () => composition(adjacentMove(state.document, activeId, 1), 'Bloco movido para baixo.'), { disabled: index === items.length - 1, 'aria-label': 'Mover bloco para baixo' });
    const movement = el('div', { className: 'pages-toolbar-group pages-toolbar-movement', role: 'group', 'aria-label': 'Organização do bloco' }, up, down,
      toolbarCommand('Duplicar', () => mutateBlocks(() => {
        if (allBlocks(state.document).length >= 100) return page.toast('Limite de 100 blocos.');
        const current = containerFor(activeId), copied = { ...clone(block), id: newId() }; current.blocks.splice(current.index + 1, 0, copied); activeId = copied.id;
      })), toolbarCommand('Excluir', () => mutateBlocks(() => {
        const current = containerFor(activeId); recovery.push({ block: clone(block), columnId: current.columnId, index: current.index });
        current.blocks.splice(current.index, 1); activeId = null;
      })));
    movement.dataset.inspectorSection = 'position';
    toolbar.append(el('span', { className: 'pages-toolbar-label', text: blockLabels[block.type] }), movement);
    const destination = el('select', { 'aria-label': 'Coluna de destino' });
    columns(state.document).forEach(col => destination.append(el('option', { value: col.id, text: col.label, selected: col.id === selectedColumn() })));
    toolbar.append(el('div', { className: 'pages-toolbar-group pages-toolbar-destination', role: 'group', 'aria-label': 'Mover entre colunas', 'data-inspector-section': 'position' }, field('Destino do bloco', destination), toolbarCommand('Mover para destino', () => {
      if (composition({ type: 'move', blockId: activeId, columnId: destination.value }, 'Bloco movido para o destino selecionado.')) editorHost.querySelector(`[data-block-id="${activeId}"] .pages-select-block`)?.focus();
    })));
    const presentation = el('div', { className: 'pages-toolbar-presentation', role: 'group', 'aria-label': 'Apresentação do bloco', 'data-inspector-section': 'style' });
    for (const [key, label, values] of [['align','Alinhamento',['start','center','end']], ['scale','Escala',['small','standard','large']], ['palette','Paleta',['neutral','brand','warm']], ['font','Fonte',['manrope','source-serif-4','oswald']]]) {
      const control = el('select', { 'aria-label': label }); const current = block.style || defaultStyle();
      values.forEach(value => control.append(el('option', { value, text: optionLabels[value], selected: current[key] === value })));
      control.addEventListener('change', () => composition({ type: 'style', blockId: block.id, style: { ...(findBlock(state.document, block.id).block.style || defaultStyle()), [key]: control.value } }));
      presentation.append(field(label, control));
    }
    toolbar.append(presentation);
    if (['rich_text','callout'].includes(block.type)) {
      const editor = richEditors.get(block.id);
      if (!editor) return;
      const formats = el('div', { className: 'pages-format-tools', role: 'toolbar', 'aria-label': 'Formatação do texto selecionado' });
      const marks = el('div', { className: 'pages-toolbar-group', role: 'group', 'aria-label': 'Estilo do texto' });
      for (const [label, mark] of [['Negrito','strong'],['Itálico','em'],['Sublinhado','underline']]) marks.append(toolbarCommand(label, () => editor.mark(mark), { 'aria-pressed': String(editor.active(mark)), 'data-mark': mark }));
      const kind = el('select', { 'aria-label': 'Formato do texto' }, el('option', { value: 'paragraph', text: 'Texto' }), el('option', { value: '2', text: 'Título 2' }), el('option', { value: '3', text: 'Título 3' }));
      kind.addEventListener('change', () => { if (kind.value === 'paragraph') editor.paragraph(); else editor.heading(Number(kind.value)); });
      const structure = el('div', { className: 'pages-toolbar-group', role: 'group', 'aria-label': 'Parágrafos e títulos' }, kind);
      const lists = el('div', { className: 'pages-toolbar-group', role: 'group', 'aria-label': 'Listas' }, toolbarCommand('Lista', () => editor.list(false)), toolbarCommand('Lista numerada', () => editor.list(true)), toolbarCommand('Remover lista', () => editor.unlist()));
      const links = el('div', { className: 'pages-toolbar-group', role: 'group', 'aria-label': 'Links' }, toolbarCommand('Link', () => {
          const input = el('input', { type: 'text', maxlength: 2048, placeholder: 'https://… ou /caminho' });
          openPagesDialog({ page, title: 'Link no texto selecionado', content: field('Endereço HTTPS ou caminho do Portal', input), confirmText: 'Aplicar link', action: async () => {
            if (!safeLink(input.value)) throw new Error('Informe um endereço HTTPS sem credenciais ou um caminho iniciado por /.');
            editor.link(input.value);
          } });
        }), toolbarCommand('Remover link', () => { if (editor.active('link')) editor.link(''); }));
      const history = el('div', { className: 'pages-toolbar-group', role: 'group', 'aria-label': 'Histórico do texto' }, toolbarCommand('Desfazer texto', () => editor.undo()), toolbarCommand('Refazer texto', () => editor.redo()));
      const more = el('details', { className: 'pages-format-more' }, el('summary', { text: '•••', 'aria-label': 'Mais opções de texto' }), el('div', { className: 'pages-format-overflow' }, lists, history));
      formats.append(structure, marks, links, more);
      for (const [mark, glyph] of [['strong','B'], ['em','I'], ['underline','U']]) {
        const control = marks.querySelector(`[data-mark="${mark}"]`); control.setAttribute('aria-label', control.textContent); control.title = control.textContent; control.textContent = glyph;
      }
      links.querySelectorAll('button').forEach((control, index) => { control.setAttribute('aria-label', control.textContent); control.title = control.textContent; control.textContent = index ? '↛' : '↗'; });
      contextTools = formats;
      const node = blockNodes.get(block.id)?.node; if (node) workspaceUI?.placeContextTools(formats, node);
    }
  }
  function renderBlocks() {
    sortables.forEach(item => item.destroy()); sortables = [];
    const ids = new Set(allBlocks(state.document).map(block => block.id));
    for (const [id, item] of blockNodes) if (!ids.has(id)) { richEditors.get(id)?.destroy(); richEditors.delete(id); item.dispose?.(); blockNodes.delete(id); }
    const editable = state.workspace.capabilities.edit;
    for (const [index, block] of allBlocks(state.document).entries()) {
      if (blockNodes.has(block.id)) {
        const entry = blockNodes.get(block.id); applyBlockStyle(entry.node, block); entry.reconcile?.(); continue;
      }
      const node = el('section', { className: `pages-editor-block${activeId === block.id ? ' is-selected' : ''}`, 'data-block-id': block.id, 'data-block-type': block.type,
        'aria-label': `Bloco ${index + 1}: ${blockLabels[block.type]}` });
      const entry = { node }; blockNodes.set(block.id, entry); applyBlockStyle(node, block);
      if (editable) node.append(el('div', { className: 'pages-block-header' }, button('⋮⋮', () => select(block.id), { className: 'btn btn-ghost pages-drag-handle', title: 'Arrastar bloco', 'aria-label': 'Arrastar bloco; use Subir, Descer ou destino pelo teclado' }), button(`Selecionar ${blockLabels[block.type].toLocaleLowerCase('pt-BR')} ${index + 1}`, () => select(block.id), { className: 'btn btn-ghost pages-select-block' })));
      const currentBlock = () => findBlock(state.document, block.id)?.block;
      if (['rich_text','callout'].includes(block.type)) {
        if (block.type === 'callout') {
          const fields = el('div', { className: 'pages-block-fields' });
          for (const [key, label, options] of [['tone','Tom',['info','attention','success']], ['icon','Ícone',['none','info','alert','check']]]) {
            const control = el('select', { 'aria-label': label }); options.forEach(value => control.append(el('option', { value, text: optionLabels[value], selected: value === block[key] })));
            control.addEventListener('change', () => { currentBlock()[key] = control.value; changed(); }); fields.append(field(label, control));
          }
          entry.fields = fields;
        }
        const host = el('div', { className: 'pages-rich-host' }); node.append(host);
        if (editable) {
          host.addEventListener('pointerdown', () => { if (activeId !== block.id) select(block.id); workspaceUI?.focusText(); });
          const editor = createRichEditor({ host, content: block.content, isLayoutDragging: () => layoutDragging,
            onChange(content) { const value = currentBlock(); if (value) { value.content = content; changed(); } }, onFocus() { if (activeId !== block.id) select(block.id); workspaceUI?.focusText(); },
            onSelection() { if (activeId === block.id) contextTools?.querySelectorAll('[data-mark]').forEach(control => control.setAttribute('aria-pressed', String(richEditors.get(block.id)?.active(control.dataset.mark) || false))); }, onLimit() { page.toast('Limite: 100 mil caracteres e dois níveis de listas.'); } });
          richEditors.set(block.id, editor);
        }
      } else if (['image','gif','audio','video'].includes(block.type)) {
        const figure = (block.type === 'image' ? imageFigure : mediaFigure)(block, { api, pageId: state.workspace.id, revisionId: state.workspace.draft_revision_id, staged: editable, signal: page.signal, resolveBlock: currentBlock });
        node.append(figure.node); entry.dispose = figure.dispose; entry.reconcile = figure.refresh;
        const fields = el('div', { className: 'pages-image-fields', hidden: activeId !== block.id });
        const definitions = ['audio','video'].includes(block.type) ? [['title','Título da mídia',200], ['transcript','Transcrição (obrigatória para publicar)',20000]] : [['alt','Texto alternativo (obrigatório para publicar)',300],['caption','Legenda',1000],['credit','Crédito',300]];
        for (const [key, label, max] of definitions) {
          const control = el(key === 'transcript' ? 'textarea' : 'input', { value: block[key], maxlength: max, disabled: !editable });
          control.addEventListener('focus', () => select(block.id));
          control.addEventListener('input', () => { currentBlock()[key] = control.value; changed(); figure.refresh?.(); }); fields.append(field(label, control));
        }
        if (block.type === 'video') {
          const cues = el('textarea', { maxlength: 100000, 'aria-label': 'Legendas sincronizadas JSON', value: JSON.stringify(block.captions, null, 2) });
          cues.addEventListener('change', () => { try {
            const value = JSON.parse(cues.value); let end = 0;
            if (!Array.isArray(value) || value.length > 500 || value.some(c => {
              const bad = !c || Object.keys(c).sort().join(',') !== 'end_ms,start_ms,text' || !Number.isSafeInteger(c.start_ms) || !Number.isSafeInteger(c.end_ms) || c.start_ms < end || c.end_ms <= c.start_ms || c.end_ms > 120000 || typeof c.text !== 'string' || c.text.length > 1000 || /[<>]|-->/.test(c.text); end = c?.end_ms; return bad;
            })) throw new Error();
            currentBlock().captions = value; changed(); figure.refresh?.(); feedback.textContent = '';
          } catch { feedback.textContent = 'Use uma lista JSON de {start_ms,end_ms,text}, ordenada, sem sobreposição (até 500 legendas / 120s).'; } });
          fields.append(field('Legendas: [{"start_ms":0,"end_ms":1000,"text":"Exemplo"}]', cues));
        }
        entry.fields = fields;
      } else if (block.type === 'button') {
        const display = el('span', { className: `pages-content-button pages-button-${block.preset}`, text: block.label }); node.append(display);
        const refreshButton = () => { const value = currentBlock(); display.textContent = value.label; display.className = `pages-content-button pages-button-${value.preset}`; };
        const label = el('input', { value: block.label, maxlength: 120 }); label.addEventListener('input', () => { currentBlock().label = label.value; refreshButton(); changed(); });
        const preset = el('select', { 'aria-label': 'Estilo do botão' }); ['primary','secondary','text'].forEach(value => preset.append(el('option', { value, text: optionLabels[value], selected: block.preset === value })));
        preset.addEventListener('change', () => { currentBlock().preset = preset.value; refreshButton(); changed(); });
        const target = el('select', { 'aria-label': 'Tipo de destino' });
        entry.reconcile = () => {
          const value = currentBlock(); if (!value) return;
          refreshButton();
          target.replaceChildren(el('option', { value: 'url', text: 'Endereço HTTPS ou /caminho' }), ...state.document.sections.map(s => el('option', { value: s.id, text: `Seção: ${s.label}` })));
          target.value = value.destination.type === 'url' ? 'url' : value.destination.value;
        };
        entry.reconcile();
        const address = el('input', { value: block.destination.type === 'url' ? block.destination.value : '', maxlength: 2048 });
        target.addEventListener('change', () => { if (target.value !== 'url') { currentBlock().destination = { type: 'section', value: target.value }; changed(); } else if (safeLink(address.value)) { currentBlock().destination = { type: 'url', value: address.value }; changed(); } });
        address.addEventListener('change', () => { if (target.value === 'url' && safeLink(address.value)) { currentBlock().destination = { type: 'url', value: address.value }; changed(); feedback.textContent = ''; } else feedback.textContent = 'Informe HTTPS ou /caminho seguro.'; });
        entry.fields = el('div', { className: 'pages-block-fields' }, field('Rótulo', label), field('Estilo do botão', preset), field('Destino', target), field('Endereço', address));
      } else if (block.type === 'divider') {
        node.append(el('hr'));
      }
    }
    const fragment = document.createDocumentFragment();
    for (const [s, section] of state.document.sections.entries()) {
      const label = el('input', { value: section.label, maxlength: 200, 'aria-label': `Nome da seção ${s + 1}` });
      label.addEventListener('input', () => {
        state.document.sections.find(item => item.id === section.id).label = label.value; changed();
        for (const block of allBlocks(state.document)) if (block.type === 'button') blockNodes.get(block.id)?.reconcile?.();
        workspaceUI?.rebuildStructure(state.document);
      });
      const sectionActions = el('div', { className: 'pages-structure-actions', role: 'group', 'aria-label': `Ações da seção ${s + 1}` },
        button('Subir seção', () => composition({ type: 'reorder', sectionId: section.id, delta: -1 }), { disabled: s === 0 }),
        button('Descer seção', () => composition({ type: 'reorder', sectionId: section.id, delta: 1 }), { disabled: s === state.document.sections.length - 1 }),
        button('Adicionar linha', () => composition({ type: 'row', sectionId: section.id })));
      const group = el('section', { className: 'pages-editor-section', 'data-section-id': section.id }, el('div', { className: 'pages-section-header' }, field('Seção', label), sectionActions));
      for (const [r, row] of section.rows.entries()) {
        const layout = el('select', { 'aria-label': `Colunas da linha ${r + 1}` }, ...[['single','Uma coluna'],['two_equal','Duas colunas']].map(([value,text]) => el('option', { value, text, selected: row.layout === value })));
        layout.addEventListener('change', () => composition({ type: 'layout', rowId: row.id, layout: layout.value }));
        const rowActions = el('div', { className: 'pages-structure-actions', role: 'group', 'aria-label': `Ações da linha ${r + 1}` }, button('Subir linha', () => composition({ type: 'reorder', sectionId: section.id, rowId: row.id, delta: -1 }), { disabled: r === 0 }), button('Descer linha', () => composition({ type: 'reorder', sectionId: section.id, rowId: row.id, delta: 1 }), { disabled: r === section.rows.length - 1 }));
        const rowNode = el('div', { className: 'pages-editor-row', 'data-row-id': row.id }, el('div', { className: 'pages-row-header' }, field(`Linha ${r + 1}`, layout), rowActions));
        const grid = el('div', { className: `pages-row pages-row-${row.layout}` });
        for (const col of row.columns) {
          const host = el('div', { className: 'pages-column pages-drop-target', 'data-column-id': col.id, 'aria-label': 'Coluna de blocos' });
          col.blocks.forEach(block => host.append(blockNodes.get(block.id).node)); grid.append(host);
          if (editable) sortables.push(createSortable(host, { group: 'pages-blocks', draggable: '.pages-editor-block', handle: '.pages-drag-handle', filter: 'input,textarea,select,.ProseMirror', preventOnFilter: false, animation: 0, emptyInsertThreshold: 30,
            forceFallback: true, fallbackOnBody: true,
            onStart() { layoutDragging = true; },
            onEnd(event) {
              try {
                const blockId = event.item.dataset.blockId, columnId = event.to.dataset.columnId, beforeId = event.item.nextElementSibling?.dataset.blockId;
                if (!composition({ type: 'move', blockId, columnId, ...(beforeId ? { beforeId } : {}) }, 'Bloco movido por arraste.')) renderBlocks();
                activeId = blockId; select(blockId); editorHost.querySelector(`[data-block-id="${blockId}"] .pages-select-block`)?.focus();
              } finally { layoutDragging = false; }
            } }));
        }
        rowNode.append(grid); group.append(rowNode);
      }
      fragment.append(group);
    }
    editorHost.replaceChildren(fragment);
    if (!allBlocks(state.document).length) editorHost.append(el('p', { text: 'Adicione um bloco de texto ou uma imagem.' }));
    renderToolbar();
    workspaceUI?.rebuildStructure(state.document);
    workspaceUI?.refresh(state.document, editable);
    workspaceUI?.select(findBlock(state.document, activeId)?.block, blockNodes.get(activeId)?.fields, false);
  }
  function showMode(next) {
    mode = next; previewDispose?.(); previewDispose = null;
    const editing = next === 'edit'; editorHost.parentElement.hidden = !editing; previewHost.hidden = editing;
    workspaceUI?.showMode(editing);
    const editorHeading = root.querySelector('.pages-heading h1'); if (editorHeading) editorHeading.hidden = !editing;
    previewHost.classList.toggle('is-mobile', next === 'mobile');
    root.querySelectorAll('[data-preview-mode]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.previewMode === next)));
    if (!editing) previewDispose = renderDocument({ host: previewHost, document: state.document, api, pageId: state.workspace.id,
      revisionId: state.workspace.draft_revision_id, staged: state.workspace.capabilities.edit });
  }
  async function upload(file, key) {
    if (!live() || state.blocked || writePending) return;
    if (allBlocks(state.document).length >= 100) { page.toast('Limite de 100 blocos.'); return; }
    const kind = { 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'image/gif': 'gif', 'audio/mpeg': 'audio', 'video/mp4': 'video' }[file.type];
    if (!kind || file.size > ({ image: 5, gif: 8, audio: 10, video: 25 }[kind]) * 1024 * 1024) { fail({ reason: 'unsupported_image' }); return; }
    const origin = state, pageId = origin.workspace.id, sequence = loadSequence;
    const current = () => live() && state === origin && loadSequence === sequence && origin.workspace.id === pageId;
    origin.uploadStart(); feedback.textContent = '';
    try {
      const ack = await api.upload(pageId, file, key, kind);
      if (!current()) return;
      const block = { id: newId(), type: kind, media_id: ack.media_id, ...(['audio','video'].includes(kind) ? { title: file.name.slice(0,200), transcript: '', ...(kind === 'video' ? { captions: [] } : {}) } : { alt: '', caption: '', credit: '' }) };
      if (kind === 'image') { findColumn(origin.document, selectedColumn()).column.blocks.push(block); origin.changed(); }
      else { const next = compose(origin.document, { type: 'insert', columnId: selectedColumn(), block }); if (!next) return; origin.replace(next); }
      activeId = block.id; uploadRetry = null; renderBlocks(); select(block.id);
      if (mode !== 'edit') showMode(mode);
    } catch (error) { if (current()) { uploadRetry = { file, key }; fail(error); } }
    finally { origin.uploadEnd(); }
  }
  function openInsertion(anchor) {
    if (!state.workspace.capabilities.edit || state.blocked || writePending) return;
    editorPanel?.close(false);
    const search = el('input', { type: 'search', placeholder: 'Texto, imagem, áudio…', 'aria-label': 'Buscar bloco' });
    const empty = el('p', { text: 'Nenhum bloco encontrado.', hidden: true, role: 'status' });
    const content = el('div', { className: 'pages-insert-panel-content' }, field('Buscar bloco', search), insertActions, empty,
      el('p', { className: 'pages-panel-help', text: 'Os blocos se adaptam ao modelo escolhido. Mídias são arquivos privados.' }));
    search.addEventListener('input', () => {
      let count = 0;
      const query = search.value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
      insertActions.querySelectorAll('button').forEach(node => { node.hidden = !node.textContent.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').includes(query); if (!node.hidden) count++; });
      empty.hidden = count > 0;
    });
    insertActions.querySelectorAll('button').forEach(node => { node.hidden = false; });
    editorPanel = openEditorPanel({ page, title: 'O que você quer adicionar?', anchor, content, className: 'pages-insert-panel' });
  }
  function openStyle(anchor) {
    if (!state.workspace.capabilities.edit || state.blocked || writePending) return;
    editorPanel?.close(false);
    const content = el('div', { className: 'pages-style-panel-content' }, el('p', { className: 'pages-panel-help', text: 'Escolha uma base para os blocos existentes. Você pode ajustar cada bloco depois.' }));
    const font = el('select', { 'aria-label': 'Fonte dos blocos existentes' }, ...['manrope','source-serif-4','oswald'].map(value => el('option', { value, text: optionLabels[value] })));
    const scale = el('select', { 'aria-label': 'Escala dos blocos existentes' }, ...['small','standard','large'].map(value => el('option', { value, text: optionLabels[value], selected: value === 'standard' })));
    let palette = 'neutral';
    const sample = el('div', { className: 'pages-style-sample', 'data-font': 'manrope' }, el('strong', { text: 'Aa Manrope' }), el('p', { text: 'Clareza em cada detalhe.' }));
    font.addEventListener('change', () => { sample.dataset.font = font.value; sample.querySelector('strong').textContent = `Aa ${optionLabels[font.value]}`; });
    const choices = el('div', { className: 'pages-palette-choices', role: 'group', 'aria-label': 'Paleta dos blocos existentes' });
    for (const value of ['neutral','brand','warm']) {
      const pick = button('', () => { palette = value; for (const node of choices.children) node.setAttribute('aria-pressed', String(node.dataset.paletteValue === value)); sample.dataset.palette = value; }, { 'data-palette-value': value, 'aria-pressed': String(value === 'neutral') });
      pick.append(el('span', { className: `pages-palette-swatch pages-swatch-${value}`, 'aria-hidden': 'true' }), el('span', { text: optionLabels[value] })); choices.append(pick);
    }
    content.append(field('Tipografia', font), sample, field('Tamanho', scale), el('h3', { text: 'Paleta' }), choices,
      el('p', { className: 'pages-panel-help', text: 'Aplica somente aos blocos já existentes. Novos blocos mantêm o padrão; salve o rascunho para persistir.' }),
      button('Aplicar aos blocos existentes', () => {
        if (state.blocked || writePending || !state.workspace.capabilities.edit) return;
        let next = state.document;
        for (const block of allBlocks(state.document)) {
          const updated = compose(next, { type: 'style', blockId: block.id, style: { ...(block.style || defaultStyle()), font: font.value, scale: scale.value, palette } });
          if (updated) next = updated;
        }
        if (next !== state.document) { state.replace(next); renderBlocks(); }
        editorPanel?.close();
      }, { className: 'btn btn-primary' }));
    editorPanel = openEditorPanel({ page, title: 'Estilo da página', anchor, content });
  }
  async function publish() {
    if (!state.publishable || writePending || uploadRetry) return;
    writePending = true; update();
    try { cargos = await api.cargos(); } catch (error) { fail(error); return; }
    finally { writePending = false; update(); }
    if (!live() || !state.publishable || uploadRetry) return;
    const issues = publicationIssues(state.document, cargos);
    if (issues.length) { feedback.textContent = issues.join(' '); return; }
    const title = state.document.metadata.title, revision = state.workspace.draft_revision_id;
    const destination = state.document.metadata.audience.job_title_ids.map(id => cargos.find(cargo => cargo.id === id)?.name).join(', ');
    const payload = { expected_version: state.workspace.version, revision_id: revision, client_mutation_id: newId() };
    const review = el('div', { className: 'pages-publication-review' }, el('p', { className: 'pages-panel-help', text: 'Revise como este conteúdo aparecerá no Portal.' }),
      field('Título', el('input', { value: title, readonly: true })), field('Público por cargo', el('output', { className: 'pages-review-audience', text: destination })),
      el('p', { className: 'pages-review-revision', text: `Revisão salva: ${revision}` }),
      el('p', { text: 'Apenas colaboradores com um dos cargos ativos selecionados poderão ler esta publicação.' }));
    const checks = el('fieldset', { className: 'pages-review-checks' }, el('legend', { text: 'Conferência pessoal (não registrada)' }));
    for (const text of ['Prévia de celular conferida', 'Mídias e descrições revisadas', 'Conteúdo revisado pelo responsável']) checks.append(el('label', {}, el('input', { type: 'checkbox' }), document.createTextNode(text)));
    review.append(checks);
    openPagesDialog({ page, title: 'Pronto para compartilhar?', className: 'pages-publication-dialog', confirmText: 'Confirmar publicação', content: review,
      action: async () => {
        if (!state.publishable || uploadRetry || state.workspace.draft_revision_id !== revision) throw new Error('Salve e confira novamente a revisão antes de publicar.');
        writePending = true; update();
        try { const ack = await api.publish(state.workspace.id, payload); if (live()) { state.acknowledge(ack); feedback.textContent = 'Publicação confirmada.'; } }
        catch (error) { throw new Error(errorText(error)); } finally { writePending = false; update(); }
      } });
  }
  function archiveOrRestore() {
    if (writePending || state.blocked || state.dirty || state.pending) { page.toast('Salve o rascunho e aguarde as operações antes de arquivar.'); return; }
    const archived = !!state.workspace.archived_at, operation = archived ? 'restore' : 'archive';
    const payload = { expected_version: state.workspace.version, client_mutation_id: newId() };
    openPagesDialog({ page, title: archived ? 'Restaurar Page' : 'Arquivar Page', confirmText: archived ? 'Restaurar como rascunho' : 'Arquivar',
      content: el('p', { text: archived ? 'A página voltará como rascunho, sem republicar automaticamente.' : 'A publicação e suas imagens deixarão de estar disponíveis aos leitores.' }),
      action: async () => {
        writePending = true; update();
        try { await api[operation](state.workspace.id, payload); if (live()) { state = null; await load(); } }
        catch (error) { throw new Error(errorText(error)); } finally { writePending = false; update(); }
      } });
  }
  function build(workspace) {
    workspaceUI?.dispose(); workspaceUI = null; editorPanel?.close(false);
    previewDispose?.(); destroyBlocks(); recovery.length = 0; activeId = null;
    const sequence = loadSequence;
    state = createEditorState(workspace, value => { if (state === value && sequence === loadSequence) update(); });
    const editable = workspace.capabilities.edit;
    status = el('p', { className: 'pages-save-status', role: 'status', 'aria-live': 'polite' });
    feedback = el('p', { className: 'pages-feedback', role: 'alert' }); uploadStatus = el('p', { role: 'status' });
    saveButton = button('Salvar rascunho', async () => { feedback.textContent = ''; try { await state.save(api); } catch (error) { fail(error); } }, { className: 'btn btn-primary' });
    publishButton = button('Publicar', publish, { className: 'btn btn-primary' });
    const primaryActions = el('div', { className: 'pages-primary-actions' });
    if (editable) primaryActions.append(saveButton);
    if (workspace.capabilities.publish) primaryActions.append(publishButton);
    const secondaryActions = el('div', { className: 'pages-secondary-actions' });
    if (workspace.capabilities.archive) secondaryActions.append(button(workspace.archived_at ? 'Restaurar' : 'Arquivar', archiveOrRestore));
    secondaryActions.append(button('Recarregar versão salva', () => {
      if (writePending || state.blocked || ((state.dirty || state.pending) && !window.confirm('Descartar as alterações locais e carregar a versão salva?'))) return;
      state = null; void load();
    }));
    const back = link('', './pages.html?manage=1'); back.className = 'pages-v2-back'; back.setAttribute('aria-label', 'Voltar à gestão de Pages'); back.append(editorIcon('back'));
    const brand = link('', './dashboard.html'); brand.className = 'pages-v2-brand'; brand.setAttribute('aria-label', 'Conecta Ownerinc — início'); brand.append(el('img', { src: './assets/conecta/logo.svg', alt: 'Conecta', width: 104, height: 32 }));
    const header = el('header', { className: 'pages-heading pages-v2-header' }, back, brand, el('div', { className: 'pages-heading-copy' },
      el('h1', { className: 'pages-visually-hidden', text: editable ? 'Editar Page' : 'Revisar Page' }), el('strong', { 'data-document-name': '', text: state.document.metadata.title }), el('span', { className: 'pages-v2-header-subtitle', text: editable ? 'Conteúdos / Edição de página' : 'Conteúdos / Somente revisão' })), status, primaryActions);
    const metadata = el('div', { className: 'pages-metadata' });
    for (const [key, label, max, multiline] of [['title','Título',200,false],['summary','Resumo',1000,true]]) {
      const control = el(multiline ? 'textarea' : 'input', { maxlength: max, disabled: !editable }); control.value = state.document.metadata[key];
      control.addEventListener('input', () => { state.document.metadata[key] = control.value; changed(); });
      const item = field(label, control); item.classList.add(`pages-metadata-${key}`); metadata.append(item);
    }
    const tags = el('input', { value: state.document.metadata.tags.join(', '), disabled: !editable, maxlength: 838 });
    tags.addEventListener('input', () => { const values = [...new Set(tags.value.split(',').map(value => value.trim()).filter(Boolean))];
      if (values.length > 20 || values.some(value => value.length > 40)) feedback.textContent = 'Use no máximo 20 tags de 40 caracteres.';
      state.document.metadata.tags = values; changed(); });
    metadata.append(field('Tags (separadas por vírgula)', tags));
    const audience = el('fieldset', { className: 'pages-audience', disabled: !editable }, el('legend', { text: 'Público por cargo' }));
    const selected = state.document.metadata.audience.job_title_ids;
    for (const cargo of cargos) {
      const checkbox = el('input', { type: 'checkbox', value: cargo.id, checked: selected.includes(cargo.id), disabled: !editable || (!cargo.active && !selected.includes(cargo.id)) });
      checkbox.addEventListener('change', () => {
        const values = state.document.metadata.audience.job_title_ids;
        if (checkbox.checked && values.length >= 100) { checkbox.checked = false; page.toast('Selecione até 100 cargos.'); return; }
        state.document.metadata.audience.job_title_ids = checkbox.checked ? [...values, cargo.id] : values.filter(id => id !== cargo.id); changed();
      });
      audience.append(el('label', {}, checkbox, document.createTextNode(`${cargo.name}${cargo.active ? '' : ' (inativo — remova antes de publicar)'}`)));
    }
    metadata.append(el('details', {}, el('summary', { text: 'Público e destinos', 'data-audience-summary': '' }), audience));
    if (!editable) metadata.append(el('p', { text: workspace.archived_at ? 'Página arquivada. Restaure como rascunho para retomar.' : 'Modo de revisão. Apenas o autor pode editar, inclusive entre administradores.' }));
    const modes = el('div', { className: 'pages-preview-tools', role: 'group', 'aria-label': 'Modo do documento' });
    if (editable) modes.append(button('Editar', () => showMode('edit'), { 'data-preview-mode': 'edit', 'aria-pressed': 'true' }));
    modes.append(button('Prévia desktop', () => showMode('desktop'), { 'data-preview-mode': 'desktop' }), button('Prévia mobile · 402 px', () => showMode('mobile'), { 'data-preview-mode': 'mobile' }));
    toolbar = el('div', { className: 'pages-context-toolbar', role: 'toolbar', 'aria-label': 'Ações do bloco selecionado', hidden: !editable });
    editorHost = el('div', { className: 'pages-blocks' });
    previewHost = el('div', { className: 'pages-preview-frame', hidden: true });
    const add = el('div', { className: 'pages-add-tools', hidden: !editable });
    const file = el('input', { type: 'file', className: 'pages-visually-hidden', accept: 'image/jpeg,image/png,image/webp,image/gif,audio/mpeg,video/mp4', 'aria-label': 'Selecionar imagem estática ou mídia GIF, MP3, MP4' }); uploadInput = file;
    file.addEventListener('change', () => { const image = file.files?.[0]; file.value = ''; if (image) { editorPanel?.close(); uploadRetry = null; void upload(image, newId()); } });
    undoDeleteButton = button('Desfazer exclusão', () => mutateBlocks(() => {
        const item = recovery.pop(); if (!item) return; if (allBlocks(state.document).length >= 100) { recovery.push(item); return; }
        const target = findColumn(state.document, item.columnId); if (!target) { recovery.push(item); return; }
        target.column.blocks.splice(Math.min(item.index, target.column.blocks.length), 0, item.block); activeId = item.block.id;
      }));
    retryUploadButton = button('Tentar upload novamente', () => { if (uploadRetry) void upload(uploadRetry.file, uploadRetry.key); });
    cancelUploadButton = button('Cancelar upload não confirmado', () => { if (!state.uploads) { uploadRetry = null; update(); } });
    compositionStatus = el('p', { role: 'status', 'aria-live': 'polite' });
    insertActions = el('div', { className: 'pages-insert-actions', role: 'group', 'aria-label': 'Adicionar conteúdo' });
    const insertItem = (label, icon, detail, action) => {
      const control = editorAction(label.replace(/^Adicionar /, ''), icon, () => { editorPanel?.close(); action(); }, { 'aria-label': label, className: 'btn btn-ghost pages-insert-item' });
      control.append(el('small', { text: detail })); insertActions.append(control);
    };
    insertItem('Adicionar texto', 'text', 'Título, parágrafo ou lista', addText);
    for (const [label, icon, detail] of [['Adicionar imagem ou GIF','image','Arquivo, legenda e texto alternativo'], ['Adicionar vídeo','video','Upload MP4 com transcrição e legendas'], ['Adicionar áudio','audio','Upload MP3 com transcrição']]) insertItem(label, icon, detail, () => uploadInput.click());
    insertItem('Adicionar duas colunas', 'columns', 'Combine blocos lado a lado', () => { const current = findColumn(state.document, selectedColumn()); if (current) composition({ type: 'layout', rowId: current.row.id, layout: 'two_equal' }); });
    for (const [type, label, detail] of [['callout','Adicionar destaque','Chamada com tom e ícone'], ['button','Adicionar botão','Link seguro ou destino nesta página'], ['divider','Adicionar separador','Uma divisão entre conteúdos']]) insertItem(label, type, detail, () => { const block = genericBlock(type); if (composition({ type: 'insert', columnId: selectedColumn(), block })) { activeId = block.id; select(block.id); } });
    add.append(editorAction('Adicionar bloco', 'plus', event => openInsertion(event.currentTarget)), file,
      el('div', { className: 'pages-recovery-actions' }, undoDeleteButton, retryUploadButton, cancelUploadButton), compositionStatus, uploadStatus);
    workspaceUI = createEditorWorkspace({ root, page, header, actions: secondaryActions, metadata, modes, toolbar, editorHost, previewHost, add, feedback,
      onInsert: openInsertion, onStyle: openStyle, onSelect: select, onSection: () => composition({ type: 'section' }) });
    if (editable) { activeId = allBlocks(state.document)[0]?.id; renderBlocks(); showMode('edit'); } else {
      workspaceUI.refresh(state.document, false); workspaceUI.rebuildStructure(state.document); workspaceUI.showPage(); showMode('desktop');
    }
    update();
  }
  async function load() {
    const sequence = ++loadSequence;
    document.body.classList.add('pages-editor-active');
    documentURL = documentLocation();
    workspaceUI?.dispose(); workspaceUI = null; editorPanel?.close(false);
    previewDispose?.(); previewDispose = null; destroyBlocks();
    root.replaceChildren(el('p', { role: 'status', text: 'Carregando editor…' }));
    try {
      const params = new URL(page.location.href).searchParams, id = params.get('id');
      const [workspace, titles] = await Promise.all([api.workspace(id), api.cargos()]);
      if (!live() || sequence !== loadSequence) return; cargos = titles; build(workspace);
    } catch (error) { if (live() && sequence === loadSequence && error.name !== 'AbortError') { document.body.classList.remove('pages-editor-active'); showError(root, error, load); } }
  }
  page.listen(window, 'popstate', () => {
    // Native fragment/skip-link entries may have no shell history index. They
    // never change the document or invalidate its local state and pending work.
    if (documentLocation() === documentURL) return;
    state = null; uploadRetry = null; void load();
  });
  void load();
}
