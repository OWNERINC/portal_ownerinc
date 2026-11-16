import { clone } from './model.js';

// Content only. Server versions, pending requests and physical uploads never
// enter this timeline. Each retained transaction owns both of its snapshots.
export function createDraftHistory({ document, maxEntries = 100, maxBytes = 20971520 }) {
  let current = clone(document), selection = null, entries = [], cursor = 0, open = null;
  const size = value => new TextEncoder().encode(JSON.stringify(value)).length;
  const result = (doc, bookmark) => ({ document: clone(doc), selection: clone(bookmark) });
  const closeGroup = () => { open = null; };
  return {
    get canUndo() { return cursor > 0; }, get canRedo() { return cursor < entries.length; },
    closeGroup,
    commit(document, meta = {}) {
      if (JSON.stringify(current) === JSON.stringify(document)) { if (meta.closeGroup) closeGroup(); return false; }
      const time = meta.time ?? Date.now(), last = entries[cursor - 1];
      const merge = cursor === entries.length && last && open && meta.group && open.group === meta.group && !meta.closeGroup
        && ((open.composing && meta.composing) || (time >= open.time && time - open.time <= 500));
      entries.splice(cursor);
      const after = clone(document), afterSelection = clone(meta.selection ?? null);
      if (merge) { last.after = after; last.selection = afterSelection; }
      else { entries.push({ before: clone(current), beforeSelection: clone(Object.hasOwn(meta, 'beforeSelection') ? meta.beforeSelection : selection), after, selection: afterSelection }); cursor++; }
      current = after; selection = afterSelection;
      open = meta.closeGroup || !meta.group ? null : { group: meta.group, time, composing: !!meta.composing };
      // Limits include redo snapshots. A single oversized transaction is retained
      // so a valid large document still has its immediate undo/redo pair.
      while (entries.length > 1 && (entries.length > Math.max(1, maxEntries) || size(entries) > maxBytes)) { entries.shift(); cursor--; }
      return true;
    },
    undo() {
      closeGroup(); if (!cursor) return null;
      const entry = entries[--cursor]; current = entry.before; selection = entry.beforeSelection;
      return result(current, selection);
    },
    redo() {
      closeGroup(); if (cursor === entries.length) return null;
      const entry = entries[cursor++]; current = entry.after; selection = entry.selection;
      return result(current, selection);
    },
    clear() { entries = []; cursor = 0; closeGroup(); },
  };
}
