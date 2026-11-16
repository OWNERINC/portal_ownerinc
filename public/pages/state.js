import { clone, newId } from './model.js';
import { createDraftHistory } from './history.js';
import { upgradeDocument } from './document-v3.js';

function freezeSnapshot(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freezeSnapshot); Object.freeze(value); }
  return value;
}

// A snapshot acknowledged by the server is the only saved baseline. Changes
// made while it is in flight remain dirty; retry reuses exactly the same key.
export function createEditorState(workspace, onChange = () => {}) {
  let document = clone(workspace.draft.document), saved = JSON.stringify(document);
  let status = 'saved', pending = null, uploads = 0;
  const listeners = new Set();
  const emit = () => { listeners.forEach(listener => listener(state)); onChange(state); };
  const history = createDraftHistory({ document });
  let formatFloor = document.schema_version === 3 ? 3 : 1, selection = null;
  const floor = value => formatFloor === 3 && value.schema_version < 3 ? upgradeDocument(value) : clone(value);
  const notify = () => { if (status !== 'saving' && status !== 'conflict') status = pending ? 'failure' : state.dirty ? 'dirty' : 'saved'; emit(); };
  const restore = direction => {
    if (!state.editable || state.blocked || status === 'conflict') return false;
    const entry = history[direction](); if (!entry) return false;
    document = floor(entry.document); selection = entry.selection; notify(); return true;
  };
  const updateMetadata = ack => {
    if (ack.document_support) workspace.document_support = clone(ack.document_support);
    // Old recorded ACKs may omit slug. Never clear an alias on legacy replay.
    if (Object.hasOwn(ack, 'slug')) workspace.slug = ack.slug;
  };
  const state = {
    workspace,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    get document() { return document; },
    get dirty() { return JSON.stringify(document) !== saved; },
    get status() { return status; }, get pending() { return pending; }, get uploads() { return uploads; },
    get writable() { return (workspace.document_support?.write_versions || [1,2]).includes(document.schema_version); },
    get editable() { return workspace.capabilities.edit && state.writable; },
    get editingUnavailableReason() { return state.writable ? null : 'document_version_disabled'; },
    get blocked() { return status === 'saving' || uploads > 0; },
    get publishable() { return !pending && !state.dirty && !state.blocked && status === 'saved' && workspace.capabilities.publish; },
    get selection() { return clone(selection); },
    get canUndo() { return state.editable && !state.blocked && status !== 'conflict' && history.canUndo; },
    get canRedo() { return state.editable && !state.blocked && status !== 'conflict' && history.canRedo; },
    closeHistoryGroup() { history.closeGroup(); },
    transact(meta, change) {
      if (!state.editable || status === 'conflict') return false;
      const next = clone(document), outcome = change(next);
      if (outcome === false || outcome === null) return false;
      return state.replace(next, meta);
    },
    // Legacy callers may still mutate then call changed(). History's independent
    // current snapshot, not the already-mutated working document, is the before.
    changed(meta = {}) { const committed = history.commit(document, meta); if (committed) selection = clone(meta.selection ?? null); notify(); return committed; },
    replace(value, meta = { closeGroup: true }) {
      const next = floor(value);
      if (JSON.stringify(next) === JSON.stringify(document)) { if (meta.closeGroup) history.closeGroup(); return false; }
      if (!history.commit(next, meta)) return false;
      document = next; selection = clone(meta.selection ?? null); notify(); return true;
    },
    undo() { return restore('undo'); }, redo() { return restore('redo'); },
    uploadStart() { uploads++; emit(); }, uploadEnd() { uploads--; emit(); },
    async save(api) {
      history.closeGroup();
      if (state.blocked || status === 'conflict') return false;
      // A disabled writer may still reconcile an already submitted snapshot.
      if (!pending && !state.writable) return false;
      if (!pending && !state.dirty) return true;
      pending ||= freezeSnapshot({ expected_version: workspace.version, client_mutation_id: newId(), document: clone(document) });
      status = 'saving'; emit();
      try {
        const ack = await api.save(workspace.id, pending);
        saved = JSON.stringify(pending.document);
        if (pending.document.schema_version === 3) { formatFloor = 3; document = floor(document); }
        pending = null;
        workspace.version = ack.version; workspace.draft_revision_id = ack.draft_revision_id;
        workspace.published_revision_id = ack.published_revision_id;
        updateMetadata(ack);
        status = state.dirty ? 'dirty' : 'saved'; emit(); return true;
      } catch (error) {
        if ([400, 403, 404, 413, 415].includes(error.status)) pending = null;
        status = error.status === 409 ? 'conflict' : 'failure'; emit(); throw error;
      }
    },
    acknowledge(ack) { workspace.version = ack.version; workspace.published_revision_id = ack.published_revision_id; updateMetadata(ack); emit(); },
  };
  return state;
}
