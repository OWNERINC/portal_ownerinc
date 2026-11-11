import { clone, newId } from './model.js';

// A snapshot acknowledged by the server is the only saved baseline. Changes
// made while it is in flight remain dirty; retry reuses exactly the same key.
export function createEditorState(workspace, onChange = () => {}) {
  let document = clone(workspace.draft.document), saved = JSON.stringify(document);
  let status = 'saved', pending = null, uploads = 0;
  const state = {
    workspace,
    get document() { return document; },
    get dirty() { return JSON.stringify(document) !== saved; },
    get status() { return status; }, get pending() { return pending; }, get uploads() { return uploads; },
    get blocked() { return status === 'saving' || uploads > 0; },
    get publishable() { return !pending && !state.dirty && !state.blocked && status === 'saved' && workspace.capabilities.publish; },
    changed() { if (status !== 'saving' && status !== 'conflict') status = pending ? 'failure' : state.dirty ? 'dirty' : 'saved'; onChange(state); },
    replace(value) { document = clone(value); state.changed(); },
    uploadStart() { uploads++; onChange(state); }, uploadEnd() { uploads--; onChange(state); },
    async save(api) {
      if (state.blocked || status === 'conflict') return false;
      if (!pending && !state.dirty) return true;
      pending ||= { expected_version: workspace.version, client_mutation_id: newId(), document: clone(document) };
      status = 'saving'; onChange(state);
      try {
        const ack = await api.save(workspace.id, pending);
        saved = JSON.stringify(pending.document); pending = null;
        workspace.version = ack.version; workspace.draft_revision_id = ack.draft_revision_id;
        workspace.published_revision_id = ack.published_revision_id;
        status = state.dirty ? 'dirty' : 'saved'; onChange(state); return true;
      } catch (error) {
        if ([400, 403, 404, 413, 415].includes(error.status)) pending = null;
        status = error.status === 409 ? 'conflict' : 'failure'; onChange(state); throw error;
      }
    },
    acknowledge(ack) { workspace.version = ack.version; workspace.published_revision_id = ack.published_revision_id; onChange(state); },
  };
  return state;
}
