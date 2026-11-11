import { clone, newId, allBlocks } from './model.js';

export const defaultStyle = () => ({ align: 'start', scale: 'standard', palette: 'neutral', font: 'manrope' });
export function findColumn(doc, id) {
  for (const section of doc.sections) for (const row of section.rows) {
    const column = row.columns.find(item => item.id === id); if (column) return { section, row, column };
  }
  return null;
}
export function findBlock(doc, id) {
  for (const section of doc.sections) for (const row of section.rows) for (const column of row.columns) {
    const index = column.blocks.findIndex(block => block.id === id);
    if (index >= 0) return { section, row, column, index, block: column.blocks[index] };
  }
  return null;
}
export function columns(doc) {
  return doc.sections.flatMap((section, s) => section.rows.flatMap((row, r) => row.columns.map((column, c) => ({ id: column.id, label: `${section.label || `Seção ${s + 1}`} · linha ${r + 1} · ${row.layout === 'single' ? 'coluna única' : c === 0 ? 'esquerda' : 'direita'}` }))));
}
export function genericBlock(type) {
  const base = { id: newId(), type };
  if (type === 'divider') return base;
  if (type === 'callout') return { ...base, tone: 'info', icon: 'info', content: { type: 'doc', content: [{ type: 'paragraph' }] } };
  if (type === 'button') return { ...base, label: 'Saiba mais', preset: 'primary', destination: { type: 'url', value: '/pages.html' } };
  return null;
}
// Commit this copy only on success: invalid drops/cancel/failure never migrate v1.
export function compose(doc, command) {
  const next = clone(doc), from = command.blockId ? findBlock(next, command.blockId) : null;
  let success = false;
  if (command.type === 'move') {
    const to = findColumn(next, command.columnId);
    if (!from || !to || (command.beforeId && !to.column.blocks.some(b => b.id === command.beforeId)) || command.beforeId === from.block.id) return null;
    from.column.blocks.splice(from.index, 1);
    const index = command.beforeId ? to.column.blocks.findIndex(b => b.id === command.beforeId) : to.column.blocks.length;
    to.column.blocks.splice(index, 0, from.block); success = true;
  } else if (command.type === 'layout') {
    const row = next.sections.flatMap(s => s.rows).find(r => r.id === command.rowId);
    if (!row || !['single','two_equal'].includes(command.layout) || row.layout === command.layout) return null;
    if (command.layout === 'two_equal') row.columns.push({ id: newId(), blocks: [] });
    else { row.columns[0].blocks.push(...row.columns[1].blocks); row.columns.length = 1; }
    row.layout = command.layout; success = true;
  } else if (command.type === 'section') {
    if (next.sections.length >= 20 || next.sections.reduce((n,s) => n + s.rows.length, 0) >= 100) return null;
    next.sections.push({ id: newId(), label: command.label || 'Nova seção', rows: [{ id: newId(), layout: 'single', columns: [{ id: newId(), blocks: [] }] }] }); success = true;
  } else if (command.type === 'row') {
    const section = next.sections.find(s => s.id === command.sectionId);
    if (!section || next.sections.reduce((n,s) => n + s.rows.length, 0) >= 100) return null;
    section.rows.push({ id: newId(), layout: 'single', columns: [{ id: newId(), blocks: [] }] }); success = true;
  } else if (command.type === 'insert') {
    const target = findColumn(next, command.columnId);
    if (!target || !command.block || allBlocks(next).length >= 100 || allBlocks(next).some(b => b.id === command.block.id)) return null;
    target.column.blocks.splice(Math.min(command.index ?? target.column.blocks.length, target.column.blocks.length), 0, clone(command.block)); success = true;
  } else if (command.type === 'style') {
    const s = command.style;
    if (!from || !s || Object.keys(s).sort().join(',') !== 'align,font,palette,scale' || !['start','center','end'].includes(s.align) || !['small','standard','large'].includes(s.scale) || !['neutral','brand','warm'].includes(s.palette) || !['manrope','source-serif-4','oswald'].includes(s.font)) return null;
    from.block.style = clone(command.style); success = true;
  } else if (command.type === 'reorder') {
    const section = next.sections.find(s => s.id === command.sectionId), list = command.rowId ? section?.rows : next.sections;
    const index = list?.findIndex(item => item.id === (command.rowId || command.sectionId)), target = index + command.delta;
    if (!list || index < 0 || target < 0 || target >= list.length || ![-1,1].includes(command.delta)) return null;
    [list[index], list[target]] = [list[target], list[index]]; success = true;
  }
  if (!success || JSON.stringify(next) === JSON.stringify(doc)) return null;
  if (next.schema_version === 1) { next.schema_version = 2; next.template = { id: 'comunicado', version: 2 }; }
  return next;
}
export function adjacentMove(doc, blockId, delta) {
  const items = allBlocks(doc), index = items.findIndex(b => b.id === blockId), neighbor = items[index + delta];
  if (!neighbor) return null;
  const target = findBlock(doc, neighbor.id), beforeId = delta < 0 ? neighbor.id : target.column.blocks[target.index + 1]?.id;
  return { type: 'move', blockId, columnId: target.column.id, ...(beforeId ? { beforeId } : {}) };
}
