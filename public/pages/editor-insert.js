import { el, field } from './dom.js';
import { editorAction } from './editor-workspace.js';
import { openEditorPanel } from './editor-panels.js';
import { findBlock, findColumn } from './composition.js';
import { newId } from './model.js';

// Points contain identities, never array offsets or block references retained
// across an await. Missing/moved anchors fail closed instead of changing columns.
export function insertionPoint(doc, { blockId, columnId, side = 'after' } = {}) {
  const found = blockId ? findBlock(doc, blockId) : findColumn(doc, columnId || doc.sections[0]?.rows[0]?.columns[0]?.id);
  if (!found) return null;
  return Object.freeze({ sectionId: found.section.id, rowId: found.row.id, columnId: found.column.id,
    ...(blockId ? { blockId, side } : {}) });
}
export function resolveInsertionPoint(doc, point) {
  if (!point) return null;
  const found = findColumn(doc, point.columnId);
  if (!found || found.section.id !== point.sectionId || found.row.id !== point.rowId) return null;
  const index = point.blockId ? found.column.blocks.findIndex(b => b.id === point.blockId) : found.column.blocks.length;
  if (index < 0) return null;
  return { ...found, index: index + (point.blockId && point.side !== 'before' ? 1 : 0) };
}

export function openInsertPanel({ page, anchor, point, onInsert, onUpload, onColumns, v3Available = false }) {
  let panel, captured = point && Object.freeze({ ...point });
  const search = el('input', { type: 'search', placeholder: 'Texto, imagem, áudio…', 'aria-label': 'Buscar bloco' });
  const list = el('div', { className: 'pages-insert-actions', role: 'group', 'aria-label': 'Adicionar conteúdo' });
  const empty = el('p', { text: 'Nenhum bloco encontrado.', hidden: true, role: 'status' });
  const additional = el('details', {}, el('summary', { text: 'Outros blocos' }));
  const more = el('div', { className: 'pages-insert-actions' }); additional.append(more);
  const choose = el('div', { id: `pages-insert-choices-${newId()}`, role: 'group', 'aria-label': 'Escolha destaque ou botão', hidden: true });
  let choicesExpanded = false;
  const entries = [];
  const invoke = action => { panel.close(); action(captured); };
  function entry(host, label, icon, detail, action, disabled = false) {
    const title = label.replace(/^Adicionar /, '');
    const control = editorAction(title.charAt(0).toLocaleUpperCase('pt-BR') + title.slice(1), icon, () => invoke(action), { 'aria-label': label, className: 'btn btn-ghost pages-insert-item', disabled });
    control.append(el('small', { text: detail })); host.append(control); entries.push({ control, text: `${label} ${detail}`, host }); return control;
  }
  entry(list, 'Adicionar texto', 'text', 'Título, parágrafo ou lista', p => onInsert('rich_text', p));
  entry(list, 'Adicionar imagem ou GIF', 'image', 'Arquivo, legenda e texto alternativo', p => onUpload('image', p));
  entry(list, 'Adicionar vídeo', 'video', 'MP4 privado ou link incorporado do YouTube', p => onUpload('video', p));
  entry(list, 'Adicionar áudio', 'audio', 'Upload MP3 com transcrição', p => onUpload('audio', p));
  entry(list, 'Adicionar galeria', 'image', v3Available ? 'Imagens e GIFs privados, legendas e ordem' : 'Indisponível: servidor sem escrita v3', p => onInsert('gallery', p), !v3Available);
  entry(list, 'Adicionar duas colunas', 'columns', 'Novo grupo lado a lado', onColumns);
  const combined = editorAction('Destaque ou botão', 'callout', () => { choicesExpanded = choose.hidden; showChoices(choicesExpanded); if (!choose.hidden) choose.querySelector('button').focus(); }, { className: 'btn btn-ghost pages-insert-item', 'aria-label': 'Destaque ou botão', 'aria-expanded': 'false', 'aria-controls': choose.id });
  function showChoices(expanded) { choose.hidden = !expanded; combined.setAttribute('aria-expanded', String(expanded)); }
  combined.append(el('small', { text: 'Citação, chamada ou link' })); list.append(combined);
  entry(choose, 'Adicionar destaque', 'callout', 'Chamada com tom e ícone', p => onInsert('callout', p));
  entry(choose, 'Adicionar botão', 'button', 'Link seguro ou destino nesta página', p => onInsert('button', p)); list.append(choose);
  entry(more, 'Adicionar FAQ', 'callout', v3Available ? 'Perguntas e respostas editáveis' : 'Indisponível: servidor sem escrita v3', p => onInsert('faq', p), !v3Available);
  entry(more, 'Adicionar separador', 'divider', 'Uma divisão entre conteúdos', p => onInsert('divider', p));
  const content = el('div', { className: 'pages-insert-panel-content' }, field('Buscar bloco', search));
  if (point?.blockId) {
    const position = el('select', { 'aria-label': 'Ponto de inserção' }, el('option', { value: 'after', text: 'Depois do bloco selecionado' }), el('option', { value: 'before', text: 'Antes do bloco selecionado' }));
    position.value = point.side || 'after'; position.addEventListener('change', () => { captured = Object.freeze({ ...point, side: position.value }); });
    additional.append(field('Inserir', position));
  }
  const normalize = value => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  search.addEventListener('input', () => {
    const query = normalize(search.value).trim(); let count = 0;
    for (const item of entries) { item.control.hidden = !!query && !normalize(item.text).includes(query); if (!item.control.hidden) count++; }
    combined.hidden = !!query && !normalize('Destaque ou botão Citação chamada link').includes(query);
    if (!combined.hidden) count++;
    showChoices(query ? entries.some(e => e.host === choose && !e.control.hidden) : choicesExpanded);
    additional.open = !!query; additional.hidden = !!query && !entries.some(e => e.host === more && !e.control.hidden);
    empty.hidden = count > 0;
  });
  content.append(list, additional, empty, el('p', { className: 'pages-panel-help', text: 'Os blocos se adaptam ao modelo escolhido. Mídias são arquivos privados.' }));
  panel = openEditorPanel({ page, title: 'O que você quer adicionar?', anchor, content, className: 'pages-insert-panel' });
  return panel;
}
