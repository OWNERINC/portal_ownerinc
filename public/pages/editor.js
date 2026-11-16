import { createPagesAPI } from './api.js';
import { createRichEditor, createSortable } from './vendor/editor.js';
import { createEditorState } from './state.js';
import { allBlocks, blockList, clone, newId, safeLink, textBlock } from './model.js';
import { el, button, link, field, errorText, showError } from './dom.js';
import { renderDocument, imageFigure, mediaFigure, applyBlockStyle, richNode } from './renderer.js';
import { renderV3Block, v3Icon } from './render-blocks-v3.js';
import { openPagesDialog } from './dialog.js';
import { openReview, reviewSession } from './editor-review.js';
import { compose, findBlock, findColumn, columns, genericBlock, defaultStyle, adjacentMove, insertAt, insertColumns, reorderSection, setBlockWidth, cloneBlock } from './composition.js';
import { editV3, parseYouTubeURL } from './document-v3.js';
import { createBlockFields, mediaAccept, mediaKind } from './editor-media.js';
import { createDestinationFields } from './editor-destinations.js';
import { openInsertPanel, insertionPoint, resolveInsertionPoint } from './editor-insert.js';
import { createEditorWorkspace, createModelDraftController, editorAction, editorIcon } from './editor-workspace.js';
import { createEditorMenus } from './editor-menus.js';
import { createPageButton } from './button.js';
import { navigate } from '../js/router.js';
import { openEditorPanel } from './editor-panels.js';
import { openStylePanel, createInspector, openInlineColorPanel, styleCandidate } from './editor-style.js';
import { resolveAppearance, appearanceIssues, typographyMetrics } from './appearance.js';

const statusLabels = { saved: 'Rascunho salvo', saving: 'Salvando…', dirty: 'Alterações não salvas', failure: 'Falha ao salvar — tente novamente', conflict: 'Conflito — recarregue a página' };
const blockLabels = { rich_text: 'Texto', image: 'Imagem', gif: 'GIF', audio: 'Áudio', video: 'Vídeo', callout: 'Destaque', button: 'Botão', divider: 'Separador', gallery: 'Galeria', faq: 'FAQ', video_embed: 'Vídeo incorporado' };
const optionLabels = { start: 'À esquerda', center: 'Centralizado', end: 'À direita', small: 'Pequena', standard: 'Padrão', large: 'Grande', neutral: 'Neutra', brand: 'Marca', warm: 'Quente', manrope: 'Manrope', 'source-serif-4': 'Source Serif 4', oswald: 'Oswald', info: 'Informação', attention: 'Atenção', success: 'Sucesso', none: 'Sem ícone', alert: 'Alerta', check: 'Confirmação', primary: 'Primário', secondary: 'Secundário', text: 'Texto' };

export function mountPageEditor(page) {
  const root = document.getElementById('page-editor-root'); if (!root) return;
  const api = createPagesAPI(page);
  const menus = createEditorMenus({ page });
  let unregisterTextMenu, unregisterPreviewMenu;
  let state, cargos = [], activeId, activeItemId, mode = 'edit', disposed = false, writePending = false, uploadRetry = null;
  let richEditors = new Map(), blockDisposers = [], previewDispose, editorHost, previewHost, toolbar, status, saveButton, publishButton, feedback, uploadStatus, retryUploadButton, cancelUploadButton, undoDeleteButton, loadSequence = 0;
  let metadataSync = [];
  const nativeFields = new Map(), nativeCompositions = new Map();
  const blockNodes = new Map(); let sortables = [], compositionStatus, layoutDragging = false;
  let documentURL, workspaceUI, contextTools, editorPanel, inspectorUI, uploadInput, uploadPoint, pendingPlacement, placeUploadButton;
  let availableTemplates = [], modelController, leavePermit, saveControl;
  let inlineAdd, reviewUI;
  document.body.classList.add('pages-editor-active');
  const documentLocation = () => { const url = new URL(page.location.href); return url.pathname + url.search; };
  const live = () => page.active && !disposed;
  const publishUncertain = () => !!state && reviewSession(state).uncertain;
  const leaveFingerprint = () => JSON.stringify([state?.document,state?.pending,!!uploadRetry,!!pendingPlacement,publishUncertain()]);
  const checkLeave = () => {
    if (writePending || state?.blocked) { page.toast('Aguarde as gravações e uploads.'); return false; }
    return (!state?.dirty && !state?.pending && !uploadRetry && !pendingPlacement && !publishUncertain()) || window.confirm('Sair sem salvar ou reconciliar as operações pendentes desta Page?');
  };
  page.beforeLeave(() => {
    const permit = leavePermit; leavePermit = null;
    return permit && permit === leaveFingerprint() && !writePending && !state?.blocked ? true : checkLeave();
  });
  page.listen(window, 'beforeunload', event => {
    if (state?.dirty || state?.pending || state?.blocked || writePending || uploadRetry || pendingPlacement || publishUncertain()) { event.preventDefault(); event.returnValue = ''; }
  });
  function setLayoutDragging(value) { layoutDragging = value; root.dataset.layoutDragging = String(value); }
  function destroyBlocks() { setLayoutDragging(false); sortables.forEach(item => item.destroy()); sortables = []; blockNodes.forEach(item => item.dispose?.()); blockNodes.clear(); richEditors.forEach(editor => editor.destroy()); richEditors.clear(); blockDisposers.forEach(fn => fn()); blockDisposers = []; }
  page.cleanup(() => { disposed = true; modelController?.dispose(); saveControl?.dispose(); inspectorUI?.dispose(); nativeFields.clear(); nativeCompositions.clear(); workspaceUI?.dispose(); editorPanel?.close(false); previewDispose?.(); destroyBlocks(); uploadRetry = null; document.body.classList.remove('pages-editor-active'); });
  function update() {
    if (!live() || !state || !status) return;
    status.textContent = statusLabels[state.status];
    saveControl.setDisabled(!state.workspace.capabilities.edit || (!state.writable && !state.pending) || state.blocked || writePending || publishUncertain() || state.status === 'conflict' || (!state.dirty && !state.pending));
    if (state.dirty || state.pending) saveControl.resetConfirmation();
    if(state.workspace.capabilities.edit){const host=root.querySelector(state.dirty||state.pending?'.pages-primary-actions':'.pages-secondary-actions');if(host&&saveButton.parentElement!==host)host.insertBefore(saveButton,host.firstElementChild);}
    // Only a confirmed clean revision can enter the publication dialog.
    publishButton.disabled = !state.publishable || writePending || !!uploadRetry || !!pendingPlacement;
    uploadStatus.textContent = state.uploads ? 'Enviando mídia…' : uploadRetry ? uploadRetry.uncertain ? 'Upload não confirmado. Tente novamente com a mesma chave ou cancele.' : 'Falha no upload. Itens anteriores conservados. Tente novamente ou cancele.' : '';
    if (retryUploadButton) { retryUploadButton.hidden = !uploadRetry; retryUploadButton.disabled = state.blocked; }
    if (cancelUploadButton) { cancelUploadButton.hidden = !uploadRetry; cancelUploadButton.disabled = state.blocked; }
    if (placeUploadButton) { placeUploadButton.hidden = !pendingPlacement; placeUploadButton.disabled = !canEditContent(); }
    if (undoDeleteButton) undoDeleteButton.disabled = !state.canUndo || historyBlocked();
    root.querySelectorAll('[data-history]').forEach(node => { node.disabled = historyBlocked() || !(node.dataset.history === 'undo' ? state.canUndo : state.canRedo); });
    workspaceUI?.setHistory({canUndo:state.canUndo&&!historyBlocked(),canRedo:state.canRedo&&!historyBlocked()});
    workspaceUI?.setModelBusy(writePending || state.blocked || historyBlocked());
    const audienceSummary = root.querySelector('[data-audience-summary]');
    if (audienceSummary) { const count = state.document.metadata.audience.job_title_ids.length; audienceSummary.textContent = `Público e destinos (${count} ${count === 1 ? 'cargo selecionado' : 'cargos selecionados'})`; }
    root.dataset.saveState = state.status;
    refreshNativeFields();
    workspaceUI?.refresh(state.document, state.editable);
    reviewUI?.refresh();
  }
  function canEditContent() { return !!state?.editable && !writePending && !publishUncertain() && !state.uploads && !uploadRetry && state.status !== 'conflict'; }
  function refreshNativeFields() {
    for (const [control, binding] of nativeFields) {
      if (!binding.retained()) { nativeFields.delete(control); nativeCompositions.delete(control); continue; }
      control.disabled = !canEditContent() || binding.unavailable();
      if (control.disabled) binding.sync();
    }
  }
  function nativeField(control, sync, unavailable = () => false, retained = () => root.contains(control)) {
    nativeFields.set(control, { sync, unavailable, retained });
    const startComposition = () => { state.closeHistoryGroup(); nativeCompositions.set(control, Symbol()); update(); };
    const endComposition = () => {
      const token = nativeCompositions.get(control); if (!token) return;
      // Keep the final input in this group when the browser emits it immediately
      // after compositionend. A later composition/visit cannot be closed here.
      queueMicrotask(() => {
        if (!live() || nativeCompositions.get(control) !== token) return;
        nativeCompositions.delete(control); state.closeHistoryGroup(); update();
      });
    };
    for (const type of ['beforeinput','input','change','compositionstart']) control.addEventListener(type, event => {
      if (!live() || !retained() || !canEditContent() || unavailable()) { event.preventDefault(); event.stopImmediatePropagation(); sync(); refreshNativeFields(); return; }
      if (type === 'input' && event.isComposing && !nativeCompositions.has(control)) startComposition();
    }, true);
    control.addEventListener('compositionstart', startComposition);
    control.addEventListener('compositionend', endComposition);
    control.addEventListener('blur', endComposition);
    return control;
  }
  function nativeMeta(event) { return { beforeSelection: null, composing: !!event?.isComposing || nativeCompositions.has(event?.currentTarget) }; }
  const editorKey = (blockId, itemId) => itemId ? `${blockId}:${itemId}` : blockId;
  const activeEditor = () => richEditors.get(editorKey(activeId, activeItemId));
  const bookmark = () => activeEditor()?.bookmark?.() || null;
  function historyBlocked() { return writePending || publishUncertain() || !!uploadRetry || nativeCompositions.size > 0 || [...richEditors.values()].some(editor => editor.composing); }
  function historyAction(direction) {
    if (historyBlocked() || !state[direction]()) return false;
    const selection = state.selection;
    if (selection?.blockId && findBlock(state.document, selection.blockId)) { activeId = selection.blockId; activeItemId = selection.itemId; }
    else if (!findBlock(state.document, activeId)) activeId = allBlocks(state.document)[0]?.id;
    metadataSync.forEach(sync => sync()); renderBlocks(selection);
    if (selection && activeEditor()) activeEditor().focus();
    else blockNodes.get(activeId)?.node.querySelector('.pages-select-block')?.focus();
    if (mode !== 'edit') showMode(mode);
    return true;
  }
  function edit(meta, change) {
    if (!canEditContent()) { refreshNativeFields(); return false; }
    return state.transact({ beforeSelection: bookmark(), ...meta }, change);
  }
  function editBlock(id, key, value, typing = true, event) {
    return edit({ ...nativeMeta(event), group: typing ? `${id}:${key}` : undefined, closeGroup: !typing }, doc => { const block = findBlock(doc, id)?.block; if (!block) return false; block[key] = value; });
  }
  function fail(error) { if (live()) feedback.textContent = errorText(error); }
  function select(id, open = true) {
    if (id !== activeId) { state.closeHistoryGroup(); activeItemId = null; }
    activeId = id;
    blockNodes.get(id)?.syncDestinations?.();
    editorHost?.querySelectorAll('[data-block-id]').forEach(node => node.classList.toggle('is-selected', node.dataset.blockId === id));
    renderToolbar();
    workspaceUI?.select(findBlock(state.document, id)?.block, blockNodes.get(id)?.fields, open);
  }
  function containerFor(id, doc = state.document) {
    for (const section of doc.sections) for (const row of section.rows) for (const col of row.columns) {
      const index = col.blocks.findIndex(block => block.id === id); if (index >= 0) return { blocks: col.blocks, columnId: col.id, index };
    }
    return null;
  }
  function mutateBlocks(action) {
    if (!state.editable || historyBlocked() || state.blocked || state.status === 'conflict') return;
    edit({ closeGroup: true }, action); renderBlocks();
  }
  function composition(command, announce = 'Composição atualizada.') {
    if (!command || !canEditContent() || historyBlocked() || state.blocked) return false;
    if (command.layout === 'aside_right' && !v3Available()) { page.toast('O servidor não permite escrita v3.'); return false; }
    const next = compose(state.document, command); return applyComposition(next, announce);
  }
  const v3Available = () => state?.workspace.document_support?.write_versions?.includes(3) === true;
  function applyComposition(next, announce = 'Composição atualizada.') {
    if (!next || !canEditContent() || historyBlocked() || state.blocked) return false;
    if (!(state.workspace.document_support?.write_versions || [1,2]).includes(next.schema_version)) { page.toast('O servidor não permite escrita desta versão.'); return false; }
    state.replace(next, { closeGroup: true, beforeSelection: bookmark() }); renderBlocks();
    if (compositionStatus) compositionStatus.textContent = announce;
    return true;
  }
  function changeLayout(rowId, layout, anchor) {
    const row = state.document.sections.flatMap(s => s.rows).find(r => r.id === rowId);
    if (!row || !canEditContent() || historyBlocked()) return;
    if (layout === 'single' && row.columns.length === 2) {
      openPagesDialog({ page, title: 'Unir colunas?', content: el('p', { text: 'Os blocos da esquerda vêm antes dos da direita. Nenhum bloco será apagado.' }), confirmText: 'Unir colunas', action: async () => { composition({ type: 'layout', rowId, layout }); } });
      if (anchor) anchor.value = row.layout;
    } else if (!composition({ type: 'layout', rowId, layout }) && anchor) anchor.value = row.layout;
  }
  function selectedColumn() { return findBlock(state.document, activeId)?.column.id || state.document.sections[0].rows[0].columns[0].id; }
  function insertBlock(type, point) {
    if (!canEditContent() || historyBlocked()) return;
    const target = resolveInsertionPoint(state.document, point);
    if (!target) { page.toast('O destino foi removido ou movido. Escolha um novo ponto de inserção.'); return; }
    const isV3 = ['gallery','faq'].includes(type);
    if (isV3 && !v3Available()) { page.toast('O servidor não permite escrita v3.'); return; }
    const block = type === 'rich_text' ? textBlock() : isV3 ? { id: newId(), type, items: [] } : genericBlock(type);
    if (state.document.schema_version === 3 && block.type === 'button') { block.action = block.destination; delete block.destination; }
    const insert = doc => insertAt(doc, { columnId: point.columnId, index: target.index, block });
    const candidate = isV3 ? editV3(state.document, doc => { const inserted = insert(doc); if (!inserted) return false; Object.assign(doc, inserted); }) : insert(state.document);
    if (!applyComposition(candidate, 'Bloco inserido.')) { page.toast('Não foi possível inserir: confira os limites do documento.'); return; }
    activeId = block.id; select(block.id); richEditors.get(block.id)?.focus();
  }
  function toolbarCommand(label, fn, attrs) {
    const node = button(label, event => { if (live() && root.contains(node) && canEditContent() && !historyBlocked()) fn(event); }, attrs);
    node.addEventListener('mousedown', event => event.preventDefault()); return node;
  }
  function renderToolbar() {
    if (!toolbar || !state?.editable || !live()) return;
    const block = allBlocks(state.document).find(item => item.id === activeId);
    const disclosures=inspectorUI&&inspectorUI.blockId===block?.id?{advanced:inspectorUI.node.querySelector('.pages-inspector-advanced')?.open,legacy:inspectorUI.node.querySelector('.pages-legacy-presentation')?.open}:null;
    inspectorUI?.dispose(); inspectorUI = null;
    unregisterTextMenu?.(); unregisterTextMenu = null;
    contextTools?.remove(); contextTools = null;
    workspaceUI?.placeContextTools(null, null);
    toolbar.replaceChildren(); if (!block) { toolbar.append(el('span', { className: 'pages-toolbar-empty', text: 'Selecione um bloco para editar.' })); workspaceUI?.select(null, null, false); return; }
    const items = allBlocks(state.document), index = items.indexOf(block);
    const up = toolbarCommand('Subir', () => composition(adjacentMove(state.document, activeId, -1), 'Bloco movido para cima.'), { disabled: index === 0, 'aria-label': 'Mover bloco para cima' });
    const down = toolbarCommand('Descer', () => composition(adjacentMove(state.document, activeId, 1), 'Bloco movido para baixo.'), { disabled: index === items.length - 1, 'aria-label': 'Mover bloco para baixo' });
    const movement = el('div', { className: 'pages-toolbar-group pages-toolbar-movement', role: 'group', 'aria-label': 'Organização do bloco' }, up, down,
      toolbarCommand('Duplicar', () => mutateBlocks(doc => {
        if (allBlocks(doc).length >= 100) { page.toast('Limite de 100 blocos.'); return false; }
        const current = containerFor(activeId, doc); if (!current) return false;
        const copied = cloneBlock(current.blocks[current.index]);
        const next = insertAt(doc, { columnId: current.columnId, index: current.index + 1, block: copied });
        if (!next) { page.toast('Não foi possível duplicar: confira referências e limites.'); return false; }
        Object.assign(doc, next); activeId = copied.id;
      })), toolbarCommand('Excluir', () => mutateBlocks(doc => {
        const current = containerFor(activeId, doc);
        if (allBlocks(doc).some(b=>b.type==='button'&&b.action?.type==='video'&&b.action.value===activeId)) { page.toast('Este vídeo é destino de um botão. Altere o destino antes de excluir.'); return false; }
        current.blocks.splice(current.index, 1); activeId = null;
      })));
    movement.dataset.inspectorSection = 'position';
    const advancedNodes = [movement];
    const destination = el('select', { 'aria-label': 'Coluna de destino' });
    columns(state.document).forEach(col => destination.append(el('option', { value: col.id, text: col.label, selected: col.id === selectedColumn() })));
    nativeField(destination, () => { destination.value = selectedColumn(); });
    advancedNodes.push(el('div', { className: 'pages-toolbar-group pages-toolbar-destination', role: 'group', 'aria-label': 'Mover entre colunas', 'data-inspector-section': 'position' }, field('Destino do bloco', destination), toolbarCommand('Mover para destino', () => {
      if (composition({ type: 'move', blockId: activeId, columnId: destination.value }, 'Bloco movido para o destino selecionado.')) editorHost.querySelector(`[data-block-id="${activeId}"] .pages-select-block`)?.focus();
    })));
    const presentation = el('div', { className: 'pages-toolbar-presentation', role: 'group', 'aria-label': 'Apresentação do bloco', 'data-inspector-section': 'style' });
    for (const [key, label, values] of [['align','Alinhamento',['start','center','end']], ['scale','Escala',['small','standard','large']], ['palette','Paleta',['neutral','brand','warm']], ['font','Fonte',['manrope','source-serif-4','oswald']]]) {
      const control = el('select', { 'aria-label': label }); const current = block.style || defaultStyle();
      values.forEach(value => control.append(el('option', { value, text: optionLabels[value], selected: current[key] === value })));
      nativeField(control, () => { control.value = (findBlock(state.document, block.id)?.block.style || defaultStyle())[key]; });
      control.addEventListener('change', () => composition({ type: 'style', blockId: block.id, style: { ...(findBlock(state.document, block.id).block.style || defaultStyle()), [key]: control.value } }));
      presentation.append(field(label, control));
    }
    const legacyPresentation = el('details', { className: 'pages-legacy-presentation' }, el('summary', { text: 'Presets legados deste bloco' }), presentation,
      toolbarCommand('Presets legados em todos os blocos existentes', () => openLegacyStyle(null)));
    presentation.removeAttribute('data-inspector-section');
    advancedNodes.push(legacyPresentation);
    // Width uses the same bounded command and merge confirmation as Task 11.
    const origin=state, sequence=loadSequence;
    const canStyle=()=>live()&&state===origin&&loadSequence===sequence&&canEditContent()&&!historyBlocked()&&v3Available();
    const changeStyle=change=>{
      if(!canStyle())return false;
      if(!editV3(state.document,change))return true;
      const next=styleCandidate(state.document,change);
      if(!next){page.toast('Não foi possível alterar: confira os valores e limites do documento.');return false;}
      return applyComposition(next);
    };
    inspectorUI=createInspector({document:state.document,block,available:v3Available(),canAct:()=>live()&&state===origin&&loadSequence===sequence&&canEditContent()&&!historyBlocked(),bindNative:nativeField,nativeMeta,
      onAppearance(patch){return changeStyle(doc=>{
        const current=findBlock(doc,block.id)?.block;if(!current)return false;
        const appearance={...current.appearance};
        for(const [key,value]of Object.entries(patch)){
          // A property reset removes only its explicit override. Keep the legacy
          // pin: inner preset pairs cannot represent outer wrapper colors too.
          if(value===null)delete appearance[key];else appearance[key]=value;
        }
        if(Object.keys(appearance).length)current.appearance=appearance;else delete current.appearance;
      });},
      onReset(){return changeStyle(doc=>{const current=findBlock(doc,block.id)?.block;if(!current)return false;delete current.style;delete current.appearance;});},
      onTags(tags,meta){return changeStyle(doc=>{const current=findBlock(doc,block.id)?.block;if(!current)return false;current.tags=tags;});},
      onWidth(value,control){if(!canEditContent()||historyBlocked())return;const current=findBlock(state.document,block.id);if(!current)return;if(value==='full'&&current.row.columns.length===2){changeLayout(current.row.id,'single',control);control.value='half';}else if(!applyComposition(setBlockWidth(state.document,{blockId:block.id,width:value})))control.value=current.row.layout==='single'?'full':'half';},
      onAdvanced(node){
        const savedRow=findBlock(state.document,block.id)?.row;
        const layout=el('select',{'aria-label':'Composição da linha'},...Object.entries({single:'Uma coluna',two_equal:'Duas colunas',aside_right:'Conteúdo com lateral'}).map(([value,text])=>el('option',{value,text,disabled:value==='aside_right'&&!v3Available()})));
        layout.value=savedRow.layout;nativeField(layout,()=>{layout.value=findBlock(state.document,block.id)?.row.layout||'single';});
        layout.addEventListener('change',()=>{if(!root.contains(layout)||!canEditContent()||historyBlocked()){layout.value=savedRow.layout;return;}const current=findBlock(state.document,block.id);if(current)changeLayout(current.row.id,layout.value,layout);});
        node.append(...advancedNodes,field('Composição da linha',layout));
      }
    });
    toolbar.append(inspectorUI.node);
    if(disclosures){inspectorUI.node.querySelector('.pages-inspector-advanced').open=disclosures.advanced;inspectorUI.node.querySelector('.pages-legacy-presentation').open=disclosures.legacy;}
    if (['rich_text','callout','faq'].includes(block.type)) {
      const editor = activeEditor();
      if (!editor) return;
      const formats = el('div', { className: 'pages-format-tools', role: 'toolbar', 'aria-label': 'Formatação do texto selecionado' });
      const marks = el('div', { className: 'pages-toolbar-group', role: 'group', 'aria-label': 'Estilo do texto' });
      for (const [label, mark] of [['Negrito','strong'],['Itálico','em'],['Sublinhado','underline']]) marks.append(toolbarCommand(label, () => editor.mark(mark), { 'aria-pressed': String(editor.active(mark)), 'data-mark': mark }));
      const kind = el('select', { 'aria-label': 'Formato do texto' }, el('option', { value: 'paragraph', text: 'Texto' }), el('option', { value: '2', text: 'Título 2' }), el('option', { value: '3', text: 'Título 3' }));
      let textFormat = 'paragraph'; nativeField(kind, () => { kind.value = textFormat; });
      kind.addEventListener('change', () => { const applied = kind.value === 'paragraph' ? editor.paragraph() : editor.heading(Number(kind.value)); if (applied) textFormat = kind.value; else kind.value = textFormat; });
      const structure = el('div', { className: 'pages-toolbar-group', role: 'group', 'aria-label': 'Parágrafos e títulos' }, kind);
      const lists = el('div', { className: 'pages-toolbar-group', role: 'group', 'aria-label': 'Listas' }, toolbarCommand('Lista', () => editor.list(false)), toolbarCommand('Lista numerada', () => editor.list(true)), toolbarCommand('Remover lista', () => editor.unlist()));
      const links = el('div', { className: 'pages-toolbar-group', role: 'group', 'aria-label': 'Links' }, toolbarCommand('Link', () => {
          const input = el('input', { type: 'text', maxlength: 2048, placeholder: 'https://… ou /caminho' });
          openPagesDialog({ page, title: 'Link no texto selecionado', content: field('Endereço HTTPS ou caminho do Portal', input), confirmText: 'Aplicar link', action: async () => {
            if (!safeLink(input.value)) throw new Error('Informe um endereço HTTPS sem credenciais ou um caminho iniciado por /.');
            editor.link(input.value);
          } });
        }), toolbarCommand('Remover link', () => { if (editor.active('link')) editor.link(''); }));
      const history = el('div', { className: 'pages-toolbar-group', role: 'group', 'aria-label': 'Histórico do texto' }, toolbarCommand('Desfazer texto', () => historyAction('undo'), { 'data-history': 'undo', disabled: !state.canUndo || historyBlocked() }), toolbarCommand('Refazer texto', () => historyAction('redo'), { 'data-history': 'redo', disabled: !state.canRedo || historyBlocked() }));
      const more = el('details', { className: 'pages-format-more' }, el('summary', { text: '•••', 'aria-label': 'Mais opções de texto' }), el('div', { className: 'pages-format-overflow' }, lists, history));
      unregisterTextMenu = menus.register(more);
      more.querySelector('.pages-format-overflow').append(links.children[links.children.length-1]);
      const inlineColors=el('div',{className:'pages-toolbar-group',role:'group','aria-label':'Cores do texto selecionado'},
        toolbarCommand('Realce do texto selecionado',event=>openInlineColor('highlight',event.currentTarget),{disabled:!v3Available(),'aria-label':'Realce do texto selecionado'}),
        toolbarCommand('Cor do texto selecionado',event=>openInlineColor('text_color',event.currentTarget),{disabled:!v3Available(),'aria-label':'Cor do texto selecionado'}));
      inlineColors.children[0].replaceChildren(editorIcon('marker'));inlineColors.children[1].replaceChildren(editorIcon('palette'));
      formats.append(structure, marks, links, inlineColors, more);
      for (const control of [...marks.children, ...links.children, ...inlineColors.children]) control.classList.add('pages-format-compact');
      for (const [mark, glyph] of [['strong','B'], ['em','I'], ['underline','U']]) {
        const control = marks.querySelector(`[data-mark="${mark}"]`); control.setAttribute('aria-label', control.textContent); control.title = control.textContent; control.textContent = glyph;
      }
      links.querySelectorAll('button').forEach((control, index) => { control.setAttribute('aria-label', control.textContent); control.title = control.textContent; control.textContent = index ? '↛' : '↗'; });
      contextTools = formats;
      const node = blockNodes.get(block.id)?.node;
      const target = block.type === 'faq' ? node?.querySelector(`[data-media-item-id="${activeItemId}"]`) : node;
      if (target) workspaceUI?.placeContextTools(formats, target);
    }
    refreshNativeFields();
  }
  function renderBlocks(selection) {
    const focused = activeEditor(), restoreFocus = blockNodes.get(activeId)?.node.contains(document.activeElement);
    const retainedSelection = selection || (restoreFocus ? focused?.bookmark?.() : null);
    sortables.forEach(item => item.destroy()); sortables = [];
    const ids = new Set(allBlocks(state.document).map(block => block.id));
    for (const [id, item] of blockNodes) if (!ids.has(id)) { richEditors.get(id)?.destroy(); richEditors.delete(id); item.dispose?.(); blockNodes.delete(id); }
    const editable = state.editable;
    for (const [index, block] of allBlocks(state.document).entries()) {
      if (blockNodes.has(block.id) && blockNodes.get(block.id).type !== block.type) { const old = blockNodes.get(block.id); old.dispose?.(); old.node.remove(); blockNodes.delete(block.id); }
      if (blockNodes.has(block.id)) {
        const entry = blockNodes.get(block.id); applyBlockStyle(entry.node, block, state.document); entry.reconcile?.(retainedSelection); entry.syncFields?.();
        richEditors.get(block.id)?.sync?.(block.content, retainedSelection?.blockId === block.id ? retainedSelection : null); continue;
      }
      const node = el('section', { className: `pages-editor-block${activeId === block.id ? ' is-selected' : ''}`, 'data-block-id': block.id, 'data-block-type': block.type,
        'aria-label': `Bloco ${index + 1}: ${blockLabels[block.type]}` });
      const entry = { node, type: block.type }; blockNodes.set(block.id, entry); applyBlockStyle(node, block, state.document);
      node.addEventListener('click', event => { if (event.target.closest('a')) event.preventDefault(); if (editable && activeId !== block.id) select(block.id); });
      if (editable) node.append(el('div', { className: 'pages-block-header' }, button('⋮⋮', () => select(block.id), { className: 'btn btn-ghost pages-drag-handle', title: 'Arrastar bloco', 'aria-label': 'Arrastar bloco; use Subir, Descer ou destino pelo teclado' }), button(`Selecionar ${blockLabels[block.type].toLocaleLowerCase('pt-BR')} ${index + 1}`, () => select(block.id), { className: 'btn btn-ghost pages-select-block' })));
      const currentBlock = () => findBlock(state.document, block.id)?.block;
      const fieldSync = [];
      const bind = (control, read) => { const sync = () => { if (currentBlock()) control.value = read(currentBlock()); }; fieldSync.push(sync); return nativeField(control, sync, () => false, () => blockNodes.get(block.id) === entry); };
      entry.syncFields = () => fieldSync.forEach(sync => sync());
      if (['rich_text','callout'].includes(block.type)) {
        if (block.type === 'callout') {
          const fields = el('div', { className: 'pages-block-fields' });
          for (const [key, label, options] of [['tone','Tom',['info','attention','success']], ['icon','Ícone',['none','info','alert','check']]]) {
            const control = el('select', { 'aria-label': label }); options.forEach(value => control.append(el('option', { value, text: optionLabels[value], selected: value === block[key] })));
            bind(control, value => value[key]); control.addEventListener('change', () => { editBlock(block.id, key, control.value, false); }); fields.append(field(label, control));
          }
          entry.fields = fields;
        }
        const host = el('div', { className: 'pages-rich-host' }); node.append(host);
        if (editable) {
          host.addEventListener('pointerdown', () => { if (activeId !== block.id) select(block.id); workspaceUI?.focusText(); });
          const editor = createRichEditor({ host, content: block.content, blockId: block.id, isLayoutDragging: () => layoutDragging,
            historyCommands: { undo: () => historyAction('undo'), redo: () => historyAction('redo') },
            canEdit: canEditContent, allowV3Marks: () => state.document.schema_version === 3 && v3Available(),
            onHistoryBoundary: () => state.closeHistoryGroup(), onComposition: () => update(),
            onChange(content, meta = {}) { edit({ ...meta, group: `${block.id}:content` }, doc => { const value = findBlock(doc, block.id)?.block; if (!value) return false; value.content = content; }); }, onFocus() { if (activeId !== block.id) select(block.id); workspaceUI?.focusText(); },
            onSelection() { if (activeId === block.id) contextTools?.querySelectorAll('[data-mark]').forEach(control => control.setAttribute('aria-pressed', String(richEditors.get(block.id)?.active(control.dataset.mark) || false))); }, onLimit() { page.toast('Limite: 100 mil caracteres e dois níveis de listas.'); } });
          richEditors.set(block.id, editor);
        }
      } else if (['image','gif','audio','video','gallery','faq','video_embed'].includes(block.type)) {
        const options = { api, pageId: state.workspace.id, revisionId: state.workspace.draft_revision_id, staged: editable, signal: page.signal, document: state.document, resolveDocument: () => state.document, resolveBlock: currentBlock, richNode, imageFigure, mediaFigure };
        const figure = block.type === 'faq' ? null : ['gallery','video_embed'].includes(block.type) ? renderV3Block(block, options) : (block.type === 'image' ? imageFigure : mediaFigure)(block, options);
        if (figure) node.append(figure.node);
        if(block.type==='audio'&&state.document.schema_version===3&&state.document.template.id==='guia-interno'){
          const pick=editorAction('Selecionar áudio','audio',()=>{if(live()&&blockNodes.get(block.id)===entry&&root.contains(node)&&canEditContent()&&!historyBlocked())entry.fields?.querySelector('input[type="file"]')?.click();},{className:'btn btn-ghost pages-audio-picker'});
          nativeField(pick,()=>{},()=>false,()=>blockNodes.get(block.id)===entry);
          node.append(pick);const syncPicker=()=>{pick.hidden=!!currentBlock()?.media_id;};syncPicker();entry.syncAudioPicker=syncPicker;
        }
        const fields = createBlockFields({ page, block, resolveBlock: currentBlock, createRichEditor,
          canEdit: canEditContent, canAct: () => canEditContent() && !historyBlocked(), bindNative: nativeField, nativeMeta,
          transact(meta, change) { return edit(meta, doc => { if (change(doc) === false) return false; const found = findBlock(doc, block.id); if (!found) return false; const candidate = clone(doc); findBlock(candidate, block.id).column.blocks.splice(found.index,1); return !!insertAt(candidate, { columnId: found.column.id, index: found.index, block: found.block }); }); },
          upload: (files,target) => { void upload(files[0], newId(), target, files.slice(1)); },
          onSource: id => openVideoSource(null, id),
          onFocus(itemId) { const changed = activeId !== block.id || activeItemId !== itemId; if (changed) state.closeHistoryGroup(); activeItemId = itemId; if (activeId !== block.id) { activeId = block.id; select(block.id); } else if (changed) renderToolbar(); if (itemId && block.type === 'faq') workspaceUI?.focusText(); },
          registerEditor: (itemId, editor) => richEditors.set(editorKey(block.id,itemId),editor),
          unregisterEditor: itemId => { richEditors.delete(editorKey(block.id,itemId)); if (activeId === block.id && activeItemId === itemId) { activeItemId = null; renderToolbar(); } },
          richOptions: { canEdit: canEditContent, allowV3Marks: () => state.document.schema_version === 3 && v3Available(), isLayoutDragging: () => layoutDragging,
            historyCommands: { undo: () => historyAction('undo'), redo: () => historyAction('redo') },
            onHistoryBoundary: () => state.closeHistoryGroup(), onComposition: () => update(),
            onSelection(itemId) { if (activeId === block.id && activeItemId === itemId) contextTools?.querySelectorAll('[data-mark]').forEach(control => control.setAttribute('aria-pressed', String(activeEditor()?.active(control.dataset.mark) || false))); },
            onLimit: () => page.toast('Limite: 100 mil caracteres e dois níveis de listas.') },
          onChange: () => { figure?.refresh?.(); refreshNativeFields(); },
        });
        entry.dispose = () => { fields.dispose(); figure?.dispose(); };
        entry.reconcile = bookmark => { fields.refresh(bookmark); figure?.refresh?.(); entry.syncAudioPicker?.(); };
        entry.syncFields = () => {};
        if (block.type === 'faq') node.append(fields.node); else entry.fields = fields.node;
      } else if (block.type === 'button') {
        const display = el('span', { className: `pages-content-button pages-button-${block.preset}`, text: block.label }); node.append(display);
        const refreshButton = () => { const value = currentBlock(); display.textContent = value.label; display.className = `pages-content-button pages-button-${value.preset}`; };
        const label = bind(el('input', { value: block.label, maxlength: 120 }), value => value.label); label.addEventListener('input', event => { editBlock(block.id, 'label', label.value, true, event); refreshButton(); });
        const preset = el('select', { 'aria-label': 'Estilo do botão' }); ['primary','secondary','text'].forEach(value => preset.append(el('option', { value, text: optionLabels[value], selected: block.preset === value })));
        bind(preset, value => value.preset); preset.addEventListener('change', () => { editBlock(block.id, 'preset', preset.value, false); refreshButton(); });
        const destinations = createDestinationFields({ blockId:block.id, getDocument:()=>state.document, getMedia:()=>state.workspace.media,
          v3Enabled:v3Available, bindNative:nativeField, retained:()=>blockNodes.get(block.id)===entry,
          canAct:()=>live()&&canEditContent()&&!historyBlocked(), apply:next=>applyComposition(next,'Destino do botão atualizado.') });
        entry.reconcile = () => { refreshButton(); destinations.refresh(); };
        entry.syncDestinations = destinations.refresh;
        entry.dispose = () => destinations.dispose();
        entry.fields = el('div', { className: 'pages-block-fields' }, field('Rótulo', label), field('Estilo do botão', preset), destinations.node);
        entry.reconcile();
      } else if (block.type === 'divider') {
        node.append(el('hr'));
      }
    }
    for(const block of allBlocks(state.document)){
      const entry=blockNodes.get(block.id);entry.appearanceIcon?.remove();
      if(state.document.schema_version!==3)continue;
      const appearance=resolveAppearance(state.document,block),icon=v3Icon(appearance.icon);
      if(icon){icon.style.color=appearance.accent;entry.node.insertBefore(icon,entry.node.children[1]||null);entry.appearanceIcon=icon;}
      entry.guideCategory?.remove();entry.guideTitle?.remove();
      if(typographyMetrics(state.document,block).cover&&state.document.metadata.category){const category=el('div',{className:'pages-guide-category'},...(icon?[icon]:[]),el('span',{text:state.document.metadata.category}));entry.node.insertBefore(category,entry.node.querySelector('.pages-rich-host'));entry.guideCategory=category;}
      if(state.document.template.id==='guia-interno'&&block.type==='faq'){const section=state.document.sections.find(s=>s.rows.some(r=>r.columns.some(c=>c.blocks.some(b=>b.id===block.id))));const title=el('h2',{className:'pages-guide-faq-title',text:section?.label||'Dúvidas frequentes'});entry.node.insertBefore(title,entry.node.querySelector('.pages-block-fields'));entry.guideTitle=title;}
      // Persisted block tags are shown/edited by the inspector. Duplicating them
      // as canvas badges would add content that is absent from the editing frame.
    }
    const fragment = document.createDocumentFragment();
    for (const [s, section] of state.document.sections.entries()) {
      const label = el('input', { value: section.label, maxlength: 200, 'aria-label': `Nome da seção ${s + 1}` });
      nativeField(label, () => { label.value = state.document.sections.find(item => item.id === section.id)?.label || ''; });
      label.addEventListener('input', event => {
        edit({ ...nativeMeta(event), group: `${section.id}:label` }, doc => { doc.sections.find(item => item.id === section.id).label = label.value; });
        for (const block of allBlocks(state.document)) if (block.type === 'button') blockNodes.get(block.id)?.reconcile?.();
        workspaceUI?.rebuildStructure(state.document);
      });
      const sectionActions = el('div', { className: 'pages-structure-actions', role: 'group', 'aria-label': `Ações da seção ${s + 1}` },
        button('Subir seção', () => composition({ type: 'reorder', sectionId: section.id, delta: -1 }), { disabled: s === 0 }),
        button('Descer seção', () => composition({ type: 'reorder', sectionId: section.id, delta: 1 }), { disabled: s === state.document.sections.length - 1 }),
        button('Adicionar linha', () => composition({ type: 'row', sectionId: section.id })));
      const empty=state.document.schema_version===3&&!section.rows.some(row=>row.columns.some(column=>column.blocks.length));
      const group = el('section', { className: 'pages-editor-section', 'data-section-id': section.id, 'data-pages-empty-section':empty?'':undefined }, el('div', { className: 'pages-section-header' }, field('Seção', label), sectionActions));
      for (const [r, row] of section.rows.entries()) {
        const layout = el('select', { 'aria-label': `Colunas da linha ${r + 1}` }, ...[['single','Uma coluna'],['two_equal','Duas colunas'],['aside_right','Conteúdo com lateral']].map(([value,text]) => el('option', { value, text, selected: row.layout === value, disabled: value === 'aside_right' && !v3Available() })));
        nativeField(layout, () => { layout.value = state.document.sections.flatMap(item => item.rows).find(item => item.id === row.id)?.layout || 'single'; });
        layout.addEventListener('change', () => changeLayout(row.id, layout.value, layout));
        const rowActions = el('div', { className: 'pages-structure-actions', role: 'group', 'aria-label': `Ações da linha ${r + 1}` }, button('Subir linha', () => composition({ type: 'reorder', sectionId: section.id, rowId: row.id, delta: -1 }), { disabled: r === 0 }), button('Descer linha', () => composition({ type: 'reorder', sectionId: section.id, rowId: row.id, delta: 1 }), { disabled: r === section.rows.length - 1 }));
        const rowNode = el('div', { className: 'pages-editor-row', 'data-row-id': row.id }, el('div', { className: 'pages-row-header' }, field(`Linha ${r + 1}`, layout), rowActions));
        const grid = el('div', { className: `pages-row pages-row-${row.layout}`, 'data-schema-version': state.document.schema_version === 3 ? '3' : undefined });
        for (const col of row.columns) {
          const host = el('div', { className: 'pages-column pages-drop-target', 'data-column-id': col.id, 'aria-label': 'Coluna de blocos' });
          col.blocks.forEach(block => host.append(blockNodes.get(block.id).node)); grid.append(host);
          if (editable && !col.blocks.length) host.append(editorAction('Inserir nesta coluna', 'plus', event => openInsertion(event.currentTarget, insertionPoint(state.document, { columnId: col.id })), { className: 'btn btn-ghost pages-empty-column-insert' }));
          if (editable) sortables.push(createSortable(host, { group: 'pages-blocks', draggable: '.pages-editor-block', handle: '.pages-drag-handle', filter: 'input,textarea,select,.ProseMirror', preventOnFilter: false, animation: 0, emptyInsertThreshold: 30,
            forceFallback: true, fallbackOnBody: true,
            onMove: () => canEditContent() && !historyBlocked() && !state.blocked,
            onStart() { setLayoutDragging(true); },
            onEnd(event) {
              try {
                const blockId = event.item.dataset.blockId, columnId = event.to.dataset.columnId, beforeId = event.item.nextElementSibling?.dataset.blockId;
                if (!composition({ type: 'move', blockId, columnId, ...(beforeId ? { beforeId } : {}) }, 'Bloco movido por arraste.')) renderBlocks();
                activeId = blockId; select(blockId); editorHost.querySelector(`[data-block-id="${blockId}"] .pages-select-block`)?.focus();
              } finally { setLayoutDragging(false); }
            } }));
        }
        rowNode.append(grid); group.append(rowNode);
      }
      fragment.append(group);
      if(state.document.template.id==='guia-interno'&&s===2&&inlineAdd)fragment.append(inlineAdd);
    }
    editorHost.replaceChildren(fragment);
    if (restoreFocus || selection) {
      const editor = richEditors.get(editorKey(retainedSelection?.blockId,retainedSelection?.itemId));
      const block = findBlock(state.document, retainedSelection?.blockId)?.block;
      if (editor && block) { editor.sync?.(retainedSelection.itemId ? block.items?.find(item => item.id === retainedSelection.itemId)?.answer : block.content, retainedSelection); if (restoreFocus) editor.focus(); }
    }
    if (!allBlocks(state.document).length) editorHost.append(el('p', { text: 'Adicione um bloco de texto ou uma imagem.' }));
    renderToolbar();
    workspaceUI?.rebuildStructure(state.document);
    workspaceUI?.refresh(state.document, editable);
    workspaceUI?.select(findBlock(state.document, activeId)?.block, blockNodes.get(activeId)?.fields, false);
    refreshNativeFields();
  }
  function showMode(next) {
    mode = next; previewDispose?.(); previewDispose = null;
    const editing = next === 'edit'; editorHost.parentElement.hidden = !editing; previewHost.hidden = editing;
    workspaceUI?.showMode(editing);
    const editorHeading = root.querySelector('.pages-heading h1'); if (editorHeading) editorHeading.hidden = !editing;
    previewHost.classList.toggle('is-mobile', next === 'mobile');
    previewHost.style.maxWidth=next==='mobile'?'390px':'';
    root.querySelectorAll('[data-preview-mode]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.previewMode === next)));
    if (!editing) previewDispose = renderDocument({ host: previewHost, document: state.document, api, pageId: state.workspace.id,
      revisionId: state.workspace.draft_revision_id, staged: state.workspace.capabilities.edit });
  }
  async function upload(file, key, point = insertionPoint(state.document, { blockId: activeId }), remaining = []) {
    if (!live() || !state.editable || state.status === 'conflict' || state.blocked || writePending) return;
    if (pendingPlacement) { page.toast('Escolha primeiro o destino do arquivo já enviado.'); return; }
    if (!point?.target && allBlocks(state.document).length >= 100) { page.toast('Limite de 100 blocos.'); return; }
    const origin = state, pageId = origin.workspace.id, sequence = loadSequence;
    const current = () => live() && state === origin && loadSequence === sequence && origin.workspace.id === pageId;
    let acknowledged = null, placed = false;
    origin.uploadStart(); feedback.textContent = '';
    try {
      while (file) {
        acknowledged = null; placed = false;
        const kind = mediaKind(file, point?.expectedKind);
        if (!kind) throw Object.assign(Error('Tipo ou tamanho de arquivo inválido para este seletor.'), { status: 415, reason: 'unsupported_image' });
        if (point?.target === 'gallery' && findBlock(origin.document,point.blockId)?.block.items?.length >= 50) throw Error('Limite de 50 itens na galeria. Os arquivos anteriores foram conservados.');
        const ack = await api.upload(pageId, file, key, kind);
        if (!current()) return;
        if (ack.page_id === pageId && ack.kind === kind) origin.workspace.media = [...(origin.workspace.media || []).filter(m=>m.id!==ack.media_id), {id:ack.media_id,kind:ack.kind}];
        const block = { id: newId(), type: kind, media_id: ack.media_id, ...(['audio','video'].includes(kind) ? { title: file.name.slice(0,200), transcript: '', ...(kind === 'video' ? { captions: [] } : {}) } : { alt: '', caption: '', credit: '' }) };
        acknowledged = block;
        let next, placedId = block.id;
        if (point?.target) {
          const candidate = clone(origin.document), found = findBlock(candidate, point.blockId);
          const value = found?.block;
          if (value && (!point.isCurrent || point.isCurrent()) && (point.target === 'gallery' ? value.type === 'gallery' : value.type === point.sourceType)) {
            let valid = true;
            if (point.target === 'gallery') value.items.push({ id: newId(), kind, media_id: ack.media_id, alt: '', caption: '', credit: '' });
            else if (point.itemId) { const item = value.items?.find(i => i.id === point.itemId); if (!item) valid = false; else { item.media_id = ack.media_id; item.kind = kind; } }
            else if (value.type === 'video_embed') {
              const { provider, video_id, ...previous } = value;
              found.column.blocks[found.index] = { ...previous, type: 'video', media_id: ack.media_id, captions: [] };
            } else { value.media_id = ack.media_id; value.type = kind; }
            if (valid) { const replaced = found.column.blocks.splice(found.index,1)[0]; next = insertAt(candidate, { columnId: found.column.id, index: found.index, block: replaced }); placedId = point.blockId; }
          }
        } else {
          const target = resolveInsertionPoint(origin.document, point);
          next = target && insertAt(origin.document, { columnId: point.columnId, index: target.index, block });
        }
        if (!origin.editable || next && !(origin.workspace.document_support?.write_versions || [1,2]).includes(next.schema_version)) next = null;
        if (!next) { uploadRetry = null; pendingPlacement = block; page.toast('Arquivo enviado, mas o destino não está mais disponível ou atingiu o limite. Escolha um novo destino; o envio não foi desfeito. Os próximos arquivos não foram enviados.'); return; }
        origin.replace(next, { closeGroup: true, beforeSelection: bookmark() });
        placed = true;
        activeId = placedId; uploadRetry = null; renderBlocks(); select(placedId);
        if (mode !== 'edit') showMode(mode);
        file = remaining[0]; remaining = remaining.slice(1); key = newId();
      }
    } catch (error) { if (current()) { if (acknowledged) { uploadRetry = null; if (!placed) pendingPlacement = acknowledged; } else uploadRetry = { file, key, point, remaining, uncertain: ![400,403,404,413,415].includes(error.status) }; fail(error); } }
    finally { origin.uploadEnd(); }
  }
  function chooseUploadDestination() {
    if (!pendingPlacement || !canEditContent()) return;
    const block = pendingPlacement, origin = state;
    const destination = el('select', { 'aria-label': 'Novo destino do arquivo enviado' }, el('option', { value: '', text: 'Selecione uma coluna' }), ...columns(state.document).map(col => el('option', { value: col.id, text: col.label })));
    openPagesDialog({ page, title: 'Escolha um novo destino', content: el('div', {}, el('p', { text: 'O arquivo já foi enviado. Insira-o ao final da coluna escolhida, sem reenviar bytes.' }), field('Coluna', destination)), confirmText: 'Inserir arquivo enviado', action: async () => {
      if (state !== origin || pendingPlacement !== block || !canEditContent()) throw Error('Destino indisponível.');
      const target = findColumn(state.document, destination.value);
      const next = target && insertAt(state.document, { columnId: destination.value, index: target.column.blocks.length, block });
      if (!applyComposition(next)) throw Error('Escolha uma coluna disponível e confira o limite de blocos.');
      pendingPlacement = null; activeId = block.id; select(block.id); update();
    } });
  }
  function openVideoSource(point, blockId) {
    if (!canEditContent() || historyBlocked()) return;
    const origin = state, sequence = loadSequence;
    const source = el('select', { 'aria-label': 'Fonte do vídeo' }, el('option', { value: 'private', text: 'Upload MP4 privado' }), el('option', { value: 'youtube', text: 'Link incorporado do YouTube', disabled: !v3Available() }));
    const address = el('input', { type: 'url', maxlength: 2048, 'aria-label': 'URL do YouTube', placeholder: 'https://www.youtube.com/watch?v=…' });
    const warning = el('p', { text: 'YouTube é um serviço de terceiros. O vídeo externo não é privado pelo login do Portal. A leitura só conecta após consentimento no próprio aviso; não carregamos miniaturas ou player agora.' });
    openPagesDialog({ page, title: blockId ? 'Trocar fonte do vídeo' : 'Adicionar vídeo', content: el('div', {}, field('Fonte', source), field('Link incorporado', address), warning,
      el('p', { text: blockId ? 'Confirmar substitui a fonte deste bloco. Cancelar mantém o conteúdo anterior. Os arquivos históricos não são excluídos.' : 'Escolha um arquivo MP4 privado ou informe um link válido. Cancelar não cria bloco.' })), confirmText: 'Confirmar fonte', action: async () => {
      if (!live() || state !== origin || sequence !== loadSequence || !canEditContent()) throw Error('Edição indisponível.');
      const previous = blockId && findBlock(state.document, blockId)?.block;
      if (blockId && !['video','video_embed'].includes(previous?.type)) throw Error('O vídeo de destino não está mais disponível.');
      if (source.value === 'private') {
        uploadPoint = blockId ? Object.freeze({ target: 'replace', blockId, sourceType: previous.type, expectedKind: 'video' }) : Object.freeze({ ...point, expectedKind: 'video' });
        uploadInput.accept = mediaAccept('video'); uploadInput.value = ''; uploadInput.click(); return;
      }
      if (!v3Available()) throw Error('O servidor não permite escrita v3.');
      const identity = parseYouTubeURL(address.value); if (!identity) throw Error('Informe uma URL HTTPS válida do YouTube (watch, shorts, embed ou youtu.be).');
      const value = { id: blockId || newId(), type: 'video_embed', ...identity, title: previous?.title || '', transcript: previous?.transcript || '' };
      for (const key of ['style','appearance','tags']) if (previous?.[key] !== undefined) value[key] = clone(previous[key]);
      const next = editV3(state.document, doc => {
        const found = blockId ? findBlock(doc,blockId) : resolveInsertionPoint(doc,point); if (!found) return false;
        if (blockId) found.column.blocks.splice(found.index,1);
        const inserted = insertAt(doc, { columnId: found.column.id, index: found.index, block: value }); if (!inserted) return false;
        Object.assign(doc,inserted);
      });
      if (!applyComposition(next)) throw Error('Destino ou limites do documento indisponíveis.');
      activeId = value.id; activeItemId = null; select(value.id);
    } });
  }
  function openInsertion(anchor, point = insertionPoint(state.document, { blockId: activeId })) {
    if (!state.editable || state.blocked || writePending || uploadRetry || state.status === 'conflict') return;
    editorPanel?.close(false);
    editorPanel = openInsertPanel({ page, anchor, point, v3Available: v3Available(), onInsert: insertBlock,
      onUpload(kind, captured) { if (kind === 'video') openVideoSource(captured); else { uploadPoint = Object.freeze({ ...captured, expectedKind: kind }); uploadInput.accept = mediaAccept(kind); uploadInput.value = ''; uploadInput.click(); } },
      onColumns(captured) {
        const target = resolveInsertionPoint(state.document, captured);
        if (!target) { page.toast('Escolha um novo ponto de inserção.'); return; }
        const rows = target.section.rows, index = rows.findIndex(row => row.id === captured.rowId);
        const beforeRowId = captured.side === 'before' ? captured.rowId : rows[index + 1]?.id;
        applyComposition(insertColumns(state.document, { sectionId: captured.sectionId, beforeRowId }));
      } });
  }
  function openInlineColor(mark,anchor) {
    if(!canEditContent()||historyBlocked()||!v3Available())return;
    const editor=activeEditor(), selection=editor?.bookmark(), origin=state, sequence=loadSequence;
    if(!selection||selection.from===selection.to){page.toast('Selecione o texto para alterar sua cor ou realce.');return;}
    const blockId=activeId,itemId=activeItemId,content=JSON.stringify(itemId?findBlock(state.document,blockId)?.block.items?.find(i=>i.id===itemId)?.answer:findBlock(state.document,blockId)?.block.content);
    const canAct=()=>live()&&origin===state&&sequence===loadSequence&&canEditContent()&&!historyBlocked()&&v3Available()&&richEditors.get(editorKey(blockId,itemId))===editor&&activeId===blockId&&activeItemId===itemId;
    editorPanel?.close(false);
    const candidate=color=>{
      const prepared=editor.prepareColor(mark,color,selection);if(!prepared)return null;
      return styleCandidate(state.document,doc=>{const block=findBlock(doc,blockId)?.block;if(!block)return false;if(itemId){const item=block.items?.find(i=>i.id===itemId);if(!item)return false;item.answer=prepared.content;}else block.content=prepared.content;});
    };
    editorPanel=openInlineColorPanel({page,anchor,mark,canAct,bindNative:nativeField,
      contrast(color){if(!canAct())return '';const next=candidate(color);if(!next)return '';const issues=appearanceIssues(next);return issues.length?`Contraste AA insuficiente em ${issues.length} trecho(s) do documento.`:'O contraste será verificado novamente antes de publicar.';},onApply(color){
      if(!canAct())return false;
      const current=findBlock(state.document,blockId)?.block,value=itemId?current?.items?.find(i=>i.id===itemId)?.answer:current?.content;
      if(JSON.stringify(value)!==content)return false;
      const prepared=editor.prepareColor(mark,color,selection);if(!prepared)return true;
      const next=candidate(color);
      if(!next){page.toast('Limite do documento atingido.');return false;}
      if(!canAct())return false;
      state.replace(next,{closeGroup:true,beforeSelection:selection,selection});renderBlocks(selection);
      queueMicrotask(()=>{if(canAct())editor.focus();});return true;
    }});
  }
  function openStyle(anchor) {
    if(!canEditContent()||historyBlocked())return;
    editorPanel?.close(false);
    const origin=state,sequence=loadSequence;
    editorPanel=openStylePanel({page,anchor,document:state.document,bindNative:nativeField,
      available:v3Available(),canAct:()=>live()&&state===origin&&sequence===loadSequence&&canEditContent()&&!historyBlocked(),
      onLegacy:()=>openLegacyStyle(anchor),
      onApply(defaults){
        if(!live()||state!==origin||sequence!==loadSequence||!canEditContent()||historyBlocked()||!v3Available())return false;
        if(!editV3(state.document,doc=>{doc.presentation.defaults=defaults;}))return true;
        const next=styleCandidate(state.document,doc=>{doc.presentation.defaults=defaults;});
        if(next)return applyComposition(next,'Estilo da página atualizado.');
        page.toast('Não foi possível alterar: confira os limites do documento.');return false;
      }});
  }
  function openLegacyStyle(anchor) {
    if (!canEditContent() || historyBlocked()) return;
    const origin=state,sequence=loadSequence;
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
        if (!live() || state!==origin || sequence!==loadSequence || !content.isConnected || !canEditContent() || historyBlocked()) return;
        let next = state.document;
        for (const block of allBlocks(state.document)) {
          const updated = compose(next, { type: 'style', blockId: block.id, style: { ...(block.style || defaultStyle()), font: font.value, scale: scale.value, palette } });
          if (updated) next = updated;
        }
        if (next !== state.document) { state.replace(next, { closeGroup: true, beforeSelection: bookmark() }); renderBlocks(); }
        editorPanel?.close();
      }, { className: 'btn btn-primary' }));
    editorPanel = openEditorPanel({ page, title: 'Estilo da página', anchor, content });
    for(const control of [font,scale])nativeField(control,()=>{},()=>false,()=>content.isConnected);
  }
  async function publish() {
    if (!state.publishable || writePending || uploadRetry || pendingPlacement) return;
    const origin = state, sequence = loadSequence, opener = document.activeElement;
    writePending = true; update();
    try { cargos = await api.cargos(); } catch (error) { if (!reviewSession(origin).uncertain) { fail(error); return; } }
    finally { writePending = false; update(); }
    if (!live() || state!==origin || sequence!==loadSequence || !state.publishable || uploadRetry || pendingPlacement) return;
    reviewUI?.close();
    reviewUI = openReview({page,state:origin,api,cargos,opener,
      canAct:()=>live() && state===origin && sequence===loadSequence && !writePending && !uploadRetry && !pendingPlacement && !nativeCompositions.size,
      onChanged:()=>{if(live()&&state===origin){metadataSync.forEach(sync=>sync());renderBlocks();if(mode!=='edit')showMode(mode);update();}},
      onPublish:async payload=>{
        if (!live() || state!==origin || !origin.publishable || uploadRetry || pendingPlacement) throw new Error('Salve e confira novamente a revisão antes de publicar.');
        writePending = true; update();
        try {const ack=await api.publish(origin.workspace.id,payload);if(live()&&state===origin){origin.acknowledge(ack);feedback.textContent='Publicação confirmada.';}}
        finally {writePending=false;update();}
      }});
  }
  function archiveOrRestore() {
    if (publishUncertain()) { page.toast('Reconcilie a publicação pendente antes de arquivar ou restaurar.'); return; }
    if (pendingPlacement) { page.toast('Escolha um destino para o arquivo já enviado ou confirme seu descarte local ao recarregar. O envio não será desfeito.'); return; }
    if (writePending || state.blocked || state.dirty || state.pending) { page.toast('Salve o rascunho e aguarde as operações antes de arquivar.'); return; }
    const archived = !!state.workspace.archived_at, operation = archived ? 'restore' : 'archive';
    const payload = { expected_version: state.workspace.version, client_mutation_id: newId() };
    openPagesDialog({ page, title: archived ? 'Restaurar Page' : 'Arquivar Page', confirmText: archived ? 'Restaurar como rascunho' : 'Arquivar',
      content: el('p', { text: archived ? 'A página voltará como rascunho, sem republicar automaticamente.' : 'A publicação e suas imagens deixarão de estar disponíveis aos leitores.' }),
      action: async () => {
        if (pendingPlacement) throw new Error('Resolva o destino do arquivo já enviado antes de arquivar ou restaurar.');
        writePending = true; update();
        try { await api[operation](state.workspace.id, payload); if (live()) { state = null; await load(); } }
        catch (error) { throw new Error(errorText(error)); } finally { writePending = false; update(); }
      } });
  }
  function openModel(templateId) {
    const template=availableTemplates.find(item=>item.id===templateId);
    if(!template||!canEditContent()||historyBlocked()||state.blocked)return;
    openPagesDialog({page,title:`Criar ${template.name}`,confirmText:'Criar novo rascunho',
      content:el('div',{},el('p',{text:template.description}),el('p',{text:'Será criada outra página. O rascunho atual não será substituído. Alterações locais não salvas exigem confirmação para sair.'})),
      action:async()=>{await modelController.choose(template.id);}});
  }
  function build(workspace) {
    menus.closeAll(); unregisterPreviewMenu?.(); unregisterPreviewMenu = null;
    workspaceUI?.dispose(); workspaceUI = null; editorPanel?.close(false);
    previewDispose?.(); destroyBlocks(); metadataSync = []; nativeFields.clear(); nativeCompositions.clear(); activeId = null; activeItemId = null; uploadPoint = null; pendingPlacement = null;
    const sequence = loadSequence;
    state = createEditorState(workspace, value => { if (state === value && sequence === loadSequence) update(); });
    const editable = state.editable;
    status = el('p', { className: 'pages-save-status', role: 'status', 'aria-live': 'polite' });
    feedback = el('p', { className: 'pages-feedback', role: 'alert' }); uploadStatus = el('p', { role: 'status' });
    saveControl?.dispose();
    saveControl = createPageButton({label:'Salvar rascunho',preset:'secondary',icon:'upload',context:{command:'save',canAuthor:workspace.capabilities.edit===true,signal:page.signal,
      onCommand:async()=>{
        if(!live()||historyBlocked())throw Error('Salvamento indisponível.');
        const origin=state;let acknowledged=false;feedback.textContent='';
        try{await origin.save({save:async(...args)=>{const ack=await api.save(...args);acknowledged=true;return ack;}});
          if(!acknowledged)throw Error('Nenhum salvamento foi confirmado.');
          return{acknowledged:true,current:state===origin&&!origin.dirty&&!origin.pending};
        }catch(error){fail(error);throw error;}
      }}});
    saveButton = saveControl.node;
    publishButton = editorAction('Publicar', 'publish', publish, { className: 'btn btn-primary' });
    const primaryActions = el('div', { className: 'pages-primary-actions' });
    if (workspace.capabilities.publish) primaryActions.append(publishButton);
    const secondaryActions = el('div', { className: 'pages-secondary-actions' });
    if (workspace.capabilities.edit) secondaryActions.append(saveButton);
    if (workspace.capabilities.archive) secondaryActions.append(button(workspace.archived_at ? 'Restaurar' : 'Arquivar', archiveOrRestore));
    secondaryActions.append(button('Recarregar versão salva', () => {
      const message = pendingPlacement ? 'Descartar as alterações locais e a colocação do arquivo já enviado, carregando a versão salva? O envio do arquivo não será desfeito.' : 'Descartar as alterações locais e carregar a versão salva?';
      if (writePending || state.blocked || ((state.dirty || state.pending || pendingPlacement || publishUncertain()) && !window.confirm(message))) return;
      state = null; void load();
    }));
    const back = link('', './pages.html?manage=1'); back.className = 'pages-v2-back'; back.setAttribute('aria-label', 'Voltar à gestão de Pages'); back.append(editorIcon('back'));
    const brand = link('', './dashboard.html'); brand.className = 'pages-v2-brand'; brand.setAttribute('aria-label', 'Conecta Ownerinc — início'); brand.append(el('span', { className: 'pages-v2-wordmark' }, el('img', { src: './assets/conecta/logo.svg', alt: 'Conecta', width: 104, height: 32 })));
    const header = el('header', { className: 'pages-heading pages-v2-header' }, back, brand, el('div', { className: 'pages-heading-copy' },
      el('h1', { className: 'pages-visually-hidden', text: editable ? 'Editar Page' : 'Revisar Page' }), el('strong', { 'data-document-name': '', text: state.document.metadata.title }), el('span', { className: 'pages-v2-header-subtitle', text: editable ? 'Conteúdos / Edição de página' : 'Conteúdos / Somente revisão' })), status, primaryActions);
    const metadata = el('div', { className: 'pages-metadata' });
    for (const [key, label, max, multiline] of [['title','Título',200,false],['summary','Resumo',1000,true]]) {
      const control = el(multiline ? 'textarea' : 'input', { maxlength: max, disabled: !editable }); control.value = state.document.metadata[key];
      const sync = () => { control.value = state.document.metadata[key]; }; metadataSync.push(sync); nativeField(control, sync);
      control.addEventListener('input', event => { edit({ ...nativeMeta(event), group: `metadata:${key}` }, doc => { doc.metadata[key] = control.value; }); });
      const item = field(label, control); item.classList.add(`pages-metadata-${key}`); metadata.append(item);
    }
    const tags = el('input', { value: state.document.metadata.tags.join(', '), disabled: !editable, maxlength: 838 });
    nativeField(tags, () => { tags.value = state.document.metadata.tags.join(', '); });
    tags.addEventListener('input', event => { const values = [...new Set(tags.value.split(',').map(value => value.trim()).filter(Boolean))];
      if (values.length > 20 || values.some(value => value.length > 40)) feedback.textContent = 'Use no máximo 20 tags de 40 caracteres.';
      edit({ ...nativeMeta(event), group: 'metadata:tags' }, doc => { doc.metadata.tags = values; }); });
    metadataSync.push(() => { tags.value = state.document.metadata.tags.join(', '); });
    metadata.append(field('Tags (separadas por vírgula)', tags));
    const audience = el('fieldset', { className: 'pages-audience', disabled: !editable }, el('legend', { text: 'Público por cargo' }));
    const selected = state.document.metadata.audience.job_title_ids;
    for (const cargo of cargos) {
      const checkbox = el('input', { type: 'checkbox', value: cargo.id, checked: selected.includes(cargo.id), disabled: !editable || (!cargo.active && !selected.includes(cargo.id)) });
      nativeField(checkbox, () => { checkbox.checked = state.document.metadata.audience.job_title_ids.includes(cargo.id); }, () => !cargo.active && !state.document.metadata.audience.job_title_ids.includes(cargo.id));
      checkbox.addEventListener('change', () => {
        const values = state.document.metadata.audience.job_title_ids;
        if (checkbox.checked && values.length >= 100) { checkbox.checked = false; page.toast('Selecione até 100 cargos.'); return; }
        edit({ closeGroup: true, beforeSelection: null }, doc => { doc.metadata.audience.job_title_ids = checkbox.checked ? [...values, cargo.id] : values.filter(id => id !== cargo.id); });
      });
      metadataSync.push(() => { checkbox.checked = state.document.metadata.audience.job_title_ids.includes(cargo.id); });
      audience.append(el('label', {}, checkbox, document.createTextNode(`${cargo.name}${cargo.active ? '' : ' (inativo — remova antes de publicar)'}`)));
    }
    metadata.append(el('details', {}, el('summary', { text: 'Público e destinos', 'data-audience-summary': '' }), audience));
    if (!editable) metadata.append(el('p', { text: !state.writable ? 'Edição indisponível para esta versão do documento.' : workspace.archived_at ? 'Página arquivada. Restaure como rascunho para retomar.' : 'Modo de revisão. Apenas o autor pode editar, inclusive entre administradores.' }));
    const modes = el('div', { className: 'pages-preview-tools', role: 'group', 'aria-label': 'Modo do documento' });
    if (editable) modes.append(button('Editar', () => showMode('edit'), { 'data-preview-mode': 'edit', 'aria-pressed': 'true' }));
    modes.append(button('Prévia desktop', () => showMode('desktop'), { 'data-preview-mode': 'desktop' }), button('Prévia mobile · 390 px', () => showMode('mobile'), { 'data-preview-mode': 'mobile' }));
    const previewMenu = el('details',{className:'pages-v2-preview-menu'},el('summary',{},editorIcon('eye'),el('span',{text:'Prévia'})),modes);
    unregisterPreviewMenu = menus.register(previewMenu);
    primaryActions.insertBefore(previewMenu,primaryActions.firstElementChild);
    modes.addEventListener('click',()=>{previewMenu.open=false;});
    toolbar = el('div', { className: 'pages-context-toolbar', role: 'toolbar', 'aria-label': 'Ações do bloco selecionado', hidden: !editable });
    editorHost = el('div', { className: 'pages-blocks' });
    previewHost = el('div', { className: 'pages-preview-frame', hidden: true });
    const add = el('div', { className: 'pages-add-tools', hidden: !editable });
    const file = el('input', { type: 'file', className: 'pages-visually-hidden', accept: 'image/jpeg,image/png,image/webp,image/gif,audio/mpeg,video/mp4', 'aria-label': 'Selecionar imagem estática ou mídia GIF, MP3, MP4' }); uploadInput = file;
    nativeField(file, () => { file.value = ''; });
    file.addEventListener('change', () => { const image = file.files?.[0], point = uploadPoint || insertionPoint(state.document, { blockId: activeId }); uploadPoint = null; file.value = ''; if (image) { editorPanel?.close(); uploadRetry = null; void upload(image, newId(), point); } });
    undoDeleteButton = button('Desfazer exclusão', () => historyAction('undo'));
    retryUploadButton = button('Tentar upload novamente', () => { if (uploadRetry) void upload(uploadRetry.file, uploadRetry.key, uploadRetry.point, uploadRetry.remaining); });
    cancelUploadButton = button('Cancelar upload não confirmado', () => { if (!state.uploads) { uploadRetry = null; update(); } });
    placeUploadButton = button('Escolher destino para arquivo enviado', chooseUploadDestination, { hidden: true });
    compositionStatus = el('p', { role: 'status', 'aria-live': 'polite' });
    add.append(editorAction('Adicionar bloco', 'plus', event => openInsertion(event.currentTarget)), file,
      el('div', { className: 'pages-recovery-actions' }, undoDeleteButton, retryUploadButton, cancelUploadButton, placeUploadButton), compositionStatus, uploadStatus);
    inlineAdd=state.document.template.id==='guia-interno'?el('div',{className:'pages-inline-insert'},add.firstElementChild):null;
    workspaceUI = createEditorWorkspace({ root, page, menus, header, actions: secondaryActions, metadata, modes, toolbar, editorHost, previewHost, add, feedback,
      templates:availableTemplates,onUndo:()=>historyAction('undo'),onRedo:()=>historyAction('redo'),onModel:openModel,
      onInsert: openInsertion, onStyle: openStyle, onSelect: select, onSection: () => composition({ type: 'section' }),
      sortableFactory: createSortable, canReorder: () => canEditContent() && !historyBlocked() && !state.blocked,
      onLayoutDragging: setLayoutDragging,
      onReorderSection: command => applyComposition(reorderSection(state.document, command), 'Seção movida.') });
    modelController?.dispose();
    modelController=createModelDraftController({newId,create:payload=>api.create(payload),canAct:()=>live()&&canEditContent()&&!historyBlocked()&&!state.blocked,
      beforeCreate:()=>checkLeave()?leaveFingerprint():false,onBusy:value=>{writePending=value;update();},
      navigate:async(ack,permit)=>{
        // The shell rechecks the guard at navigation commit. Consume this permit
        // once only; any intervening document/pending change requires a new check.
        writePending=false;update();leavePermit=permit;
        try { return await navigate(`/page-editor.html?id=${encodeURIComponent(ack.id)}`); }
        finally { if(leavePermit===permit)leavePermit=null; }
      }});
    workspaceUI.refresh(state.document, editable);
    if (editable) { activeId = allBlocks(state.document)[0]?.id; renderBlocks(); showMode('edit'); } else {
      workspaceUI.refresh(state.document, false); workspaceUI.rebuildStructure(state.document); workspaceUI.showPage(); showMode('desktop');
    }
    update();
  }
  async function load() {
    menus.closeAll(); unregisterTextMenu?.(); unregisterTextMenu = null; unregisterPreviewMenu?.(); unregisterPreviewMenu = null;
    reviewUI?.close(); reviewUI=null;
    const sequence = ++loadSequence;
    document.body.classList.add('pages-editor-active');
    documentURL = documentLocation();
    workspaceUI?.dispose(); workspaceUI = null; editorPanel?.close(false);
    previewDispose?.(); previewDispose = null; destroyBlocks(); nativeFields.clear(); nativeCompositions.clear();
    root.replaceChildren(el('p', { role: 'status', text: 'Carregando editor…' }));
    try {
      const params = new URL(page.location.href).searchParams, id = params.get('id');
    const [workspace, titles, templates] = await Promise.all([api.workspace(id), api.cargos(), api.templates()]);
      if (!live() || sequence !== loadSequence) return; cargos = titles; availableTemplates=templates; build(workspace);
    } catch (error) { if (live() && sequence === loadSequence && error.name !== 'AbortError') { document.body.classList.remove('pages-editor-active'); showError(root, error, load); } }
  }
  page.listen(window, 'popstate', () => {
    // Native fragment/skip-link entries may have no shell history index. They
    // never change the document or invalidate its local state and pending work.
    if (documentLocation() === documentURL) return;
    state = null; uploadRetry = null; void load();
  });
  page.listen(root, 'focusout', () => state?.closeHistoryGroup());
  page.listen(root, 'keydown', event => {
    if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey || !state) return;
    const key = event.key?.toLowerCase();
    if (key === 'z' || key === 'y') { event.preventDefault(); if (!event.isComposing) historyAction(key === 'y' || event.shiftKey ? 'redo' : 'undo'); }
    if (key === 's') { event.preventDefault(); if (!event.isComposing && !historyBlocked() && !saveButton.disabled) saveButton.click(); }
  });
  void load();
}
