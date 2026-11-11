import { Schema } from 'prosemirror-model';
import { EditorState, Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { baseKeymap, toggleMark, setBlockType, chainCommands, exitCode } from 'prosemirror-commands';
import { history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { bulletList, orderedList, listItem, wrapInList, liftListItem, sinkListItem, splitListItem } from 'prosemirror-schema-list';
import { safeLink } from './model.js';
import { compositionDropGuard } from './drag-guard.js';
import Sortable from 'sortablejs';
export const createSortable = (host, options) => Sortable.create(host, options);

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
  link: { attrs: { href: {} }, inclusive: false,
    parseDOM: [{ tag: 'a[href]', getAttrs: dom => safeLink(dom.getAttribute('href')) ? { href: dom.getAttribute('href') } : false }],
    toDOM: mark => ['a', { href: mark.attrs.href, rel: 'noopener noreferrer' }, 0] },
} });
function bounded(doc) {
  let chars = 0, valid = true;
  function walk(node, lists = 0) {
    if (node.type.name.endsWith('_list')) lists++;
    if (lists > 2) valid = false;
    if (node.isText) chars += node.text.length;
    if (node.type.name === 'heading' && ![2, 3].includes(node.attrs.level)) valid = false;
    if (node.type.name === 'ordered_list' && (!Number.isInteger(node.attrs.order) || node.attrs.order < 1 || node.attrs.order > 100000)) valid = false;
    node.marks.forEach(mark => { if (mark.type.name === 'link' && !safeLink(mark.attrs.href)) valid = false; });
    node.forEach(child => walk(child, lists));
  }
  walk(doc); return valid && chars <= 100000;
}
export function createRichEditor({ host, content, onChange, onFocus, onSelection, onLimit, isLayoutDragging }) {
  const state = EditorState.create({ schema, doc: schema.nodeFromJSON(content), plugins: [
    new Plugin({ filterTransaction(tr) { const okay = !tr.docChanged || bounded(tr.doc); if (!okay) onLimit?.(); return okay; } }),
    history(), keymap({ 'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo,
      'Mod-b': toggleMark(schema.marks.strong), 'Mod-i': toggleMark(schema.marks.em), 'Mod-u': toggleMark(schema.marks.underline),
      Enter: splitListItem(schema.nodes.list_item), Tab: sinkListItem(schema.nodes.list_item), 'Shift-Tab': liftListItem(schema.nodes.list_item),
      'Shift-Enter': chainCommands(exitCode, (s, dispatch) => { if (dispatch) dispatch(s.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView()); return true; }),
    }), keymap(baseKeymap),
  ] });
  const view = new EditorView(host, {
    state, attributes: { 'aria-label': 'Conteúdo do bloco de texto', role: 'textbox', 'aria-multiline': 'true', spellcheck: 'true' },
    dispatchTransaction(tr) { view.updateState(view.state.apply(tr)); if (tr.docChanged) onChange(view.state.doc.toJSON()); onSelection?.(); },
    handleDOMEvents: { focus: () => { onFocus?.(); return false; }, drop: compositionDropGuard(isLayoutDragging) },
  });
  const command = fn => { view.focus(); return fn(view.state, view.dispatch, view); };
  return {
    mark(name) { return command(toggleMark(schema.marks[name])); },
    paragraph() { return command(setBlockType(schema.nodes.paragraph)); },
    heading(level) { return command(setBlockType(schema.nodes.heading, { level })); },
    list(ordered) { return command(wrapInList(schema.nodes[ordered ? 'ordered_list' : 'bullet_list'])); },
    unlist() { return command(liftListItem(schema.nodes.list_item)); },
    link(href) { if (href && !safeLink(href)) return false; return command(toggleMark(schema.marks.link, href ? { href } : undefined)); },
    undo() { return command(undo); }, redo() { return command(redo); },
    active(name) { const { from, $from, to, empty } = view.state.selection; const mark = schema.marks[name]; return empty ? !!mark.isInSet(view.state.storedMarks || $from.marks()) : view.state.doc.rangeHasMark(from, to, mark); },
    focus() { view.focus(); }, destroy() { view.destroy(); },
  };
}
