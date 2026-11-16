import { clone, newId, allBlocks, safeLink } from './model.js';
import { editV3 } from './document-v3.js';

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
export function cloneBlock(block) {
  const copied = clone(block); copied.id = newId();
  if (['faq', 'gallery'].includes(copied.type)) copied.items.forEach(item => { item.id = newId(); });
  return copied;
}

// Commands must not create an unsaveable graph, including after a version/layout
// conversion adds bytes or changes aggregate accounting. The server remains
// authoritative; these checks cover identities, references and aggregate budgets
// across the complete candidate, including nested items and rich-text marks.
function candidateValid(doc) {
  const ids = new Set(), uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  let chars = 0, nodes = 0;
  const id = value => { if (!uuid.test(value) || ids.has(value.toLowerCase())) throw Error(); ids.add(value.toLowerCase()); };
  const count = (value, max = 100000) => { if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw Error(); chars += value.length; };
  const keys = (value, required, optional = []) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(k => !Object.hasOwn(value, k)) || Object.keys(value).some(k => ![...required, ...optional].includes(k))) throw Error();
  };
  const prose = (node, parent, lists = 0, depth = 0) => {
    if (++nodes > 20000 || depth > 12) throw Error();
    keys(node, ['type'], ['content','attrs','text','marks']);
    if (['text','hard_break'].includes(node.type)) {
      if (!['paragraph','heading'].includes(parent) || node.content || node.attrs) throw Error();
      if (node.type === 'text') { count(node.text); if (!node.text.length) throw Error(); }
      else if (node.text !== undefined) throw Error();
      const marks = node.marks || [], seen = new Set(); if (!Array.isArray(marks) || marks.length > (doc.schema_version === 3 ? 6 : 4)) throw Error();
      for (const mark of marks) {
        if ((doc.schema_version === 3 && ++nodes > 20000) || seen.has(mark.type)) throw Error(); seen.add(mark.type); keys(mark, ['type'], ['attrs']);
        if (mark.type === 'link') { keys(mark.attrs, ['href']); if (!safeLink(mark.attrs.href)) throw Error(); if (doc.schema_version === 3) count(mark.attrs.href, 2048); }
        else if (doc.schema_version === 3 && ['text_color','highlight'].includes(mark.type)) { keys(mark.attrs, ['color']); if (!/^#[0-9a-f]{6}$/i.test(mark.attrs.color)) throw Error(); count(mark.attrs.color); }
        else if (!['strong','em','underline'].includes(mark.type) || mark.attrs !== undefined) throw Error();
      }
      return;
    }
    if (node.text !== undefined || node.marks !== undefined) throw Error();
    const children = node.content || []; if (!Array.isArray(children)) throw Error();
    if (node.type === 'doc') { if (parent || !children.length) throw Error(); }
    else if (['paragraph','heading'].includes(node.type)) {
      if (!['doc','list_item'].includes(parent)) throw Error();
      if (node.type === 'heading') { keys(node.attrs, ['level']); if (![2,3].includes(node.attrs.level)) throw Error(); }
    } else if (['bullet_list','ordered_list'].includes(node.type)) {
      if (!['doc','list_item'].includes(parent) || ++lists > 2 || !children.length) throw Error();
      if (node.attrs !== undefined) { keys(node.attrs, ['order']); if (node.type !== 'ordered_list' || !Number.isInteger(node.attrs.order) || node.attrs.order < 1 || node.attrs.order > 100000) throw Error(); }
    } else if (node.type === 'list_item') { if (!['bullet_list','ordered_list'].includes(parent) || children[0]?.type !== 'paragraph') throw Error(); }
    else throw Error();
    if (!['heading','ordered_list'].includes(node.type) && node.attrs !== undefined) throw Error();
    const allowed = ['paragraph','heading'].includes(node.type) ? ['text','hard_break'] : ['doc','list_item'].includes(node.type) ? ['paragraph','heading','bullet_list','ordered_list'] : ['list_item'];
    if (children.some(child => !allowed.includes(child.type))) throw Error();
    children.forEach(child => prose(child, node.type, lists, depth + 1));
  };
  try {
    if (doc.sections.length > 20 || doc.sections.reduce((n,s) => n + s.rows.length, 0) > 100 || allBlocks(doc).length > 100 || new TextEncoder().encode(JSON.stringify(doc)).length > 1048576) return false;
    count(doc.metadata.title, 200); count(doc.metadata.summary, 1000); if (doc.metadata.category !== undefined) count(doc.metadata.category, 80); doc.metadata.tags.forEach(tag => count(tag, 40));
    for (const section of doc.sections) { id(section.id); count(section.label, 200); for (const row of section.rows) {
      id(row.id); if (!['single', ...(doc.schema_version !== 1 ? ['two_equal'] : []), ...(doc.schema_version === 3 ? ['aside_right'] : [])].includes(row.layout) || row.columns.length !== (row.layout === 'single' ? 1 : 2)) return false;
      for (const col of row.columns) { id(col.id); for (const block of col.blocks) {
      id(block.id); block.tags?.forEach(tag => count(tag, 40));
      const fields = { rich_text: ['content'], callout: ['tone','icon','content'], divider: [], image: ['media_id','alt','caption','credit'], gif: ['media_id','alt','caption','credit'], audio: ['media_id','title','transcript'], video: ['media_id','title','transcript','captions'], gallery: ['items'], faq: ['items'], button: ['label','preset', doc.schema_version === 3 ? 'action' : 'destination'], video_embed: ['provider','video_id','title','transcript'] }[block.type];
      if (!fields || (doc.schema_version !== 3 && ['gallery','faq','video_embed'].includes(block.type))) return false;
      keys(block, ['id','type', ...fields], ['style', ...(doc.schema_version === 3 ? ['appearance','tags'] : [])]);
      if (doc.schema_version === 1 && (block.style || !['rich_text','image'].includes(block.type))) return false;
      if (block.style) { keys(block.style, ['align','scale','palette','font']); for (const [key, values] of [['align',['start','center','end']], ['scale',['small','standard','large']], ['palette',['neutral','brand','warm']], ['font',['manrope','source-serif-4','oswald']]]) if (!values.includes(block.style[key])) return false; }
      if (block.content) { if (block.content.type !== 'doc') return false; prose(block.content); }
      if (block.type === 'callout' && (!['info','attention','success'].includes(block.tone) || !['none','info','alert','check'].includes(block.icon))) return false;
      const mediaValid = value => value === null ? doc.schema_version === 3 : typeof value === 'string' && uuid.test(value);
      if (Object.hasOwn(block, 'media_id') && !mediaValid(block.media_id)) return false;
      for (const [key,max] of [['alt',300],['caption',1000],['credit',300],['title',200],['transcript',20000],['label',120]]) if (block[key] !== undefined) count(block[key], max);
      if (block.items) {
        if (!Array.isArray(block.items) || block.items.length > 50) return false;
        for (const item of block.items) {
          id(item.id);
          if (block.type === 'faq') { keys(item, ['id','question','answer']); count(item.question, 200); if (item.answer.type !== 'doc') return false; prose(item.answer); }
          else { keys(item, ['id','kind','media_id','alt','caption','credit']); if (!['image','gif'].includes(item.kind) || !mediaValid(item.media_id)) return false; for (const [key,max] of [['alt',300],['caption',1000],['credit',300]]) count(item[key], max); }
        }
      }
      if (block.captions) {
        if (!Array.isArray(block.captions) || block.captions.length > 500) return false;
        let end = 0;
        for (const cue of block.captions) { keys(cue, ['start_ms','end_ms','text']); count(cue.text, 1000); if (!Number.isSafeInteger(cue.start_ms) || !Number.isSafeInteger(cue.end_ms) || cue.start_ms < end || cue.end_ms <= cue.start_ms || cue.end_ms > 120000 || /[<>]|-->/.test(cue.text)) return false; end = cue.end_ms; }
      }
      if (block.type === 'video_embed' && (block.provider !== 'youtube' || !/^[A-Za-z0-9_-]{11}$/.test(block.video_id))) return false;
      if (block.type === 'button') {
        if (!block.label.trim() || !['primary','secondary','text'].includes(block.preset)) return false;
        const action = block.action || block.destination;
        keys(action, action.type === 'download' ? ['type','media_id','kind','file_name'] : ['type','value']);
        if (action.type === 'url') { if (!safeLink(action.value)) return false; if (doc.schema_version === 3) count(action.value, 2048); }
        else if (action.type === 'section') { if (!doc.sections.some(s => s.id.toLowerCase() === action.value.toLowerCase())) return false; }
        else if (doc.schema_version === 3 && action.type === 'video') { if (!allBlocks(doc).some(b => b.id.toLowerCase() === action.value.toLowerCase() && ['video','video_embed'].includes(b.type))) return false; }
        else if (doc.schema_version === 3 && action.type === 'download') { const extension = { image: '.webp', gif: '.gif', audio: '.mp3', video: '.mp4' }[action.kind]; if (!uuid.test(action.media_id) || !extension || /[\/\\\u0000-\u001f\u007f-\u009f]/.test(action.file_name) || !action.file_name.endsWith(extension) || !action.file_name.slice(0,-extension.length).trim()) return false; count(action.file_name, 120); }
        else return false;
      }
    } } } }
    return chars <= 100000;
  } catch { return false; }
}

export function insertAt(doc, { columnId, index, block }) {
  const target = findColumn(doc, columnId);
  if (!target || !block || !Number.isInteger(index) || index < 0 || index > target.column.blocks.length) return null;
  const next = clone(doc); findColumn(next, columnId).column.blocks.splice(index, 0, clone(block));
  if (next.schema_version === 1 && !['rich_text','image'].includes(block.type)) { next.schema_version = 2; next.template = { id: 'comunicado', version: 2 }; }
  return candidateValid(next) ? next : null;
}
export function insertColumns(doc, { sectionId, beforeRowId }) {
  const section = doc.sections.find(s => s.id === sectionId);
  if (!section || doc.sections.reduce((n,s) => n + s.rows.length, 0) >= 100 || (beforeRowId != null && !section.rows.some(r => r.id === beforeRowId))) return null;
  const next = clone(doc), rows = next.sections.find(s => s.id === sectionId).rows;
  rows.splice(beforeRowId == null ? rows.length : rows.findIndex(r => r.id === beforeRowId), 0, { id: newId(), layout: 'two_equal', columns: [{ id: newId(), blocks: [] }, { id: newId(), blocks: [] }] });
  if (next.schema_version === 1) { next.schema_version = 2; next.template = { id: 'comunicado', version: 2 }; }
  return candidateValid(next) ? next : null;
}
export function reorderSection(doc, { sectionId, beforeSectionId }) {
  const from = doc.sections.findIndex(s => s.id === sectionId);
  if (from < 0 || sectionId === beforeSectionId || (beforeSectionId != null && !doc.sections.some(s => s.id === beforeSectionId))) return null;
  // Content is immutable here. Keep section/row/block references intact.
  const sections = [...doc.sections], [section] = sections.splice(from, 1);
  sections.splice(beforeSectionId == null ? sections.length : sections.findIndex(s => s.id === beforeSectionId), 0, section);
  if (sections.every((s,i) => s === doc.sections[i])) return null;
  const next = { ...doc, sections };
  return candidateValid(next) ? next : null;
}
export function setBlockWidth(doc, { blockId, width }) {
  const target = findBlock(doc, blockId);
  if (!target || !['full','half'].includes(width)) return null;
  return compose(doc, { type: 'layout', rowId: target.row.id, layout: width === 'half' ? 'two_equal' : 'single' });
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
    if (!row || !['single','two_equal','aside_right'].includes(command.layout) || row.layout === command.layout) return null;
    if (command.layout === 'aside_right') return editV3(doc, draft => {
      const current = draft.sections.flatMap(s => s.rows).find(r => r.id === command.rowId);
      if (current.columns.length === 1) current.columns.push({ id: newId(), blocks: [] });
      current.layout = 'aside_right';
      return candidateValid(draft);
    });
    if (command.layout === 'two_equal' && row.columns.length === 1) row.columns.push({ id: newId(), blocks: [] });
    else if (command.layout === 'single') { row.columns[0].blocks.push(...row.columns[1].blocks); row.columns.length = 1; }
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
    if (!target) return null;
    const inserted = insertAt(doc, { ...command, index: command.index ?? target.column.blocks.length });
    if (!inserted) return null;
    if (inserted.schema_version === 1) { inserted.schema_version = 2; inserted.template = { id: 'comunicado', version: 2 }; }
    return candidateValid(inserted) ? inserted : null;
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
  return candidateValid(next) ? next : null;
}
export function adjacentMove(doc, blockId, delta) {
  const items = allBlocks(doc), index = items.findIndex(b => b.id === blockId), neighbor = items[index + delta];
  if (!neighbor) return null;
  const target = findBlock(doc, neighbor.id), beforeId = delta < 0 ? neighbor.id : target.column.blocks[target.index + 1]?.id;
  return { type: 'move', blockId, columnId: target.column.id, ...(beforeId ? { beforeId } : {}) };
}
