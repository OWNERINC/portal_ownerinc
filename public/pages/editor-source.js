import { Schema } from 'prosemirror-model';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { baseKeymap, toggleMark, setBlockType, chainCommands, exitCode } from 'prosemirror-commands';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { bulletList, orderedList, listItem, wrapInList, liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import { safeLink } from './model.js';
import { normalizeHex } from './appearance.js';
import { compositionDropGuard } from './drag-guard.js';
import Sortable from 'sortablejs';
export const createSortable = (host, options) => Sortable.create(host, options);

const colorMark = (name, property) => ({ attrs: { color: {} },
  parseDOM: [{ tag: `span[data-pages-${name}]`, getAttrs: dom => { const color = normalizeHex(dom.getAttribute(`data-pages-${name}`)); return color ? { color } : false; } }],
  toDOM: mark => { const color = normalizeHex(mark.attrs.color); return ['span', color ? { [`data-pages-${name}`]: color, style: `${property}:${color}` } : {}, 0]; },
});
const schema = new Schema({ nodes: {
  doc: { content: 'block+' },
  paragraph: { group: 'block', content: 'inline*', parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
  heading: { group: 'block', content: 'inline*', defining: true, attrs: { level: { default: 2 } },
    parseDOM: [{ tag: 'h2', attrs: { level: 2 } }, { tag: 'h3', attrs: { level: 3 } }], toDOM: node => [`h${node.attrs.level}`, 0] },
  bullet_list: { ...bulletList, content: 'list_item+', group: 'block' },
  ordered_list: { ...orderedList, content: 'list_item+', group: 'block' },
  list_item: { ...listItem, content: 'paragraph block*' },
  text: { group: 'inline' },
  hard_break: { inline: true, group: 'inline', selectable: false, parseDOM: [{ tag: 'br' }], toDOM: () => ['br'] },
}, marks: {
  strong: { parseDOM: [{ tag: 'strong' }, { tag: 'b' }], toDOM: () => ['strong', 0] },
  em: { parseDOM: [{ tag: 'em' }, { tag: 'i' }], toDOM: () => ['em', 0] },
  underline: { parseDOM: [{ tag: 'u' }], toDOM: () => ['u', 0] },
  text_color: colorMark('text_color', 'color'),
  highlight: colorMark('highlight', 'background-color'),
  link: { attrs: { href: {} }, inclusive: false,
    parseDOM: [{ tag: 'a[href]', getAttrs: dom => safeLink(dom.getAttribute('href')) ? { href: dom.getAttribute('href') } : false }],
    toDOM: mark => ['a', { href: mark.attrs.href, rel: 'noopener noreferrer' }, 0] },
} });
function bounded(doc, allowV3Marks) {
  let chars = 0, valid = true;
  function walk(node, lists = 0) {
    if (node.type.name.endsWith('_list')) lists++;
    if (lists > 2) valid = false;
    if (node.isText) chars += node.text.length;
    if (node.type.name === 'heading' && ![2, 3].includes(node.attrs.level)) valid = false;
    if (node.type.name === 'ordered_list' && (!Number.isInteger(node.attrs.order) || node.attrs.order < 1 || node.attrs.order > 100000)) valid = false;
    node.marks.forEach(mark => {
      if (mark.type.name === 'link' && !safeLink(mark.attrs.href)) valid = false;
      if (['text_color','highlight'].includes(mark.type.name) && (!allowV3Marks || normalizeHex(mark.attrs.color) !== mark.attrs.color)) valid = false;
    });
    node.forEach(child => walk(child, lists));
  }
  walk(doc); return valid && chars <= 100000;
}
export function createRichEditor({ host, content, onChange, onFocus, onSelection, onLimit, isLayoutDragging,
  blockId, itemId, historyCommands, onHistoryBoundary, onComposition, canEdit = () => true, allowV3Marks = () => false }) {
  let composing = false, destroyed = false;
  const bookmark = state => ({ blockId, ...(itemId ? { itemId } : {}), from: state.selection.from, to: state.selection.to });
  const undoCommand = historyCommands ? () => { historyCommands.undo(); return true; } : undo;
  const redoCommand = historyCommands ? () => { historyCommands.redo(); return true; } : redo;
  const boundaryCommand = fn => (state, dispatch, view) => {
    onHistoryBoundary?.();
    const result = fn(state, dispatch && (tr => dispatch(tr.setMeta('pagesCommand', true))), view);
    onHistoryBoundary?.(); return result;
  };
  const state = EditorState.create({ schema, doc: schema.nodeFromJSON(content), plugins: [
    new Plugin({ filterTransaction(tr) { if (tr.docChanged && !tr.getMeta('pagesSync') && !canEdit()) return false; const okay = !tr.docChanged || bounded(tr.doc, tr.getMeta('pagesSync') || allowV3Marks()); if (!okay) onLimit?.(); return okay; } }),
    ...(!historyCommands ? [history()] : []), keymap({ 'Mod-z': undoCommand, 'Mod-Shift-z': redoCommand, 'Mod-y': redoCommand,
      'Mod-b': boundaryCommand(toggleMark(schema.marks.strong)), 'Mod-i': boundaryCommand(toggleMark(schema.marks.em)), 'Mod-u': boundaryCommand(toggleMark(schema.marks.underline)),
      Enter: boundaryCommand(splitListItem(schema.nodes.list_item)), Tab: boundaryCommand(sinkListItem(schema.nodes.list_item)), 'Shift-Tab': boundaryCommand(liftListItem(schema.nodes.list_item)),
      'Shift-Enter': boundaryCommand(chainCommands(exitCode, (s, dispatch) => { if (dispatch) dispatch(s.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView()); return true; })),
    }), keymap(Object.fromEntries(Object.entries(baseKeymap).map(([key, fn]) => [key, boundaryCommand(fn)]))),
  ] });
  const view = new EditorView(host, {
    state, editable: canEdit, attributes: { 'aria-label': 'Conteúdo do bloco de texto', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true' },
    dispatchTransaction(tr) {
      const before = view.state, next = before.apply(tr); view.updateState(next);
      if (!before.doc.eq(next.doc) && !tr.getMeta('pagesSync')) onChange(next.doc.toJSON(), {
        beforeSelection: bookmark(before), selection: bookmark(next), composing: composing || view.composing || tr.getMeta('composition') != null,
        time: tr.time, closeGroup: !!tr.getMeta('pagesCommand'),
      });
      onSelection?.(bookmark(next));
    },
    handleDOMEvents: {
      keydown: (_view, event) => {
        const key = event.key.toLowerCase();
        if (!historyCommands || !(event.ctrlKey || event.metaKey) || event.altKey || !['z','y'].includes(key)) return false;
        // PM deliberately skips its keymap during IME. Consume global history
        // shortcuts here as well, so native contenteditable undo cannot fork it.
        event.preventDefault();
        if (!composing && !view.composing) (key === 'y' || event.shiftKey ? historyCommands.redo : historyCommands.undo)();
        return true;
      },
      focus: () => { onFocus?.(); return false; }, blur: () => { onHistoryBoundary?.(); return false; },
      compositionstart: () => { composing = true; onHistoryBoundary?.(); onComposition?.(true); return false; },
      compositionend: () => { composing = false; queueMicrotask(() => { if (!destroyed) { onComposition?.(false); onHistoryBoundary?.(); } }); return false; },
      drop: compositionDropGuard(isLayoutDragging),
    },
  });
  const command = fn => {
    if (!canEdit() || composing || view.composing) return false;
    onHistoryBoundary?.(); view.focus();
    const result = fn(view.state, tr => view.dispatch(tr.setMeta('pagesCommand', true)), view); onHistoryBoundary?.(); return result;
  };
  return {
    // Pure transform: the coordinator can atomically opt into v3 and commit the
    // changed content on its single timeline, then sync this same EditorView.
    prepareColor(name, color, selection) {
      if (destroyed || !canEdit() || composing || view.composing || !['text_color','highlight'].includes(name)) return null;
      const before = view.state, saved = bookmark(before);
      if (!selection || JSON.stringify(saved) !== JSON.stringify(selection) || saved.from === saved.to) return null;
      const normalized = color === null ? null : normalizeHex(color); if (color !== null && !normalized) return null;
      const type = schema.marks[name];
      const tr = color === null ? before.tr.removeMark(saved.from,saved.to,type) : before.tr.addMark(saved.from,saved.to,type.create({color:normalized}));
      if (before.doc.eq(tr.doc) || !bounded(tr.doc,true)) return null;
      return { content: tr.doc.toJSON(), beforeSelection: saved, selection: saved };
    },
    mark(name, attrs) {
      if (['text_color','highlight'].includes(name)) { const color = normalizeHex(attrs?.color); if (!allowV3Marks() || !color) return false; attrs = { color }; }
      return schema.marks[name] ? command(toggleMark(schema.marks[name], attrs)) : false;
    },
    paragraph() { return command(setBlockType(schema.nodes.paragraph)); },
    heading(level) { return command(setBlockType(schema.nodes.heading, { level })); },
    list(ordered) { return command(wrapInList(schema.nodes[ordered ? 'ordered_list' : 'bullet_list'])); },
    unlist() { return command(liftListItem(schema.nodes.list_item)); },
    link(href) { if (href && !safeLink(href)) return false; return command(toggleMark(schema.marks.link, href ? { href } : undefined)); },
    undo() { return composing || view.composing ? false : historyCommands ? historyCommands.undo() : command(undo); },
    redo() { return composing || view.composing ? false : historyCommands ? historyCommands.redo() : command(redo); },
    bookmark() { return bookmark(view.state); },
    selectionFormat() {
      const { doc, selection } = view.state;
      const formats = new Set();
      const collect = node => {
        if (node.isTextblock) formats.add(node.type === schema.nodes.heading ? String(node.attrs.level) : 'paragraph');
      };
      if (selection.empty) collect(selection.$from.parent);
      else doc.nodesBetween(selection.from, selection.to, node => { collect(node); return !node.isTextblock; });
      return formats.size > 1 ? 'mixed' : formats.values().next().value || 'paragraph';
    },
    get composing() { return composing || view.composing; },
    sync(content, selection) {
      if (composing || view.composing) return false;
      const doc = schema.nodeFromJSON(content), before = view.state;
      let tr = before.tr;
      if (!before.doc.eq(doc)) tr = tr.replaceWith(0, before.doc.content.size, doc.content);
      if (selection) {
        const clamp = value => Math.max(0, Math.min(tr.doc.content.size, Number.isFinite(value) ? value : 1));
        tr = tr.setSelection(TextSelection.between(tr.doc.resolve(clamp(selection.from)), tr.doc.resolve(clamp(selection.to))));
      }
      if (tr.docChanged || !tr.selection.eq(before.selection)) view.dispatch(tr.setMeta('pagesSync', true).setMeta('addToHistory', false));
      return true;
    },
    active(name) { const { from, $from, to, empty } = view.state.selection; const mark = schema.marks[name]; return !!mark && (empty ? !!mark.isInSet(view.state.storedMarks || $from.marks()) : view.state.doc.rangeHasMark(from, to, mark)); },
    focus() { view.focus(); }, destroy() { destroyed = true; view.destroy(); },
  };
}
