function copy(value) { return structuredClone(value); }
export function createDraftState(defaultsByTemplate) {
  const drafts = new Map(Object.entries(defaultsByTemplate || {}).map(([template, values]) => [template, {
    values: copy(values), mediaId: null, mediaUrl: '', editingId: null, name: '', generation: 0, baseline: JSON.stringify([values, null]),
  }]));
  const draft = template => drafts.get(template);
  const snapshot = template => JSON.stringify([draft(template)?.values || {}, draft(template)?.mediaId || null]);
  return {
    get(template) { return draft(template) || null; },
    setValue(template, key, html) { draft(template).values[key] = html; },
    setMedia(template, media) { Object.assign(draft(template), { mediaId: media?.mediaId || null, mediaUrl: media?.mediaUrl || '' }); },
    snapshot,
    isDirty(template) { return template ? snapshot(template) !== draft(template)?.baseline : [...drafts.keys()].some(key => snapshot(key) !== draft(key).baseline); },
    loadSaved(card, mediaUrl = '') {
      const item = draft(card.template); if (!item) return;
      item.values = copy(card.values || {}); item.mediaId = card.mediaId || card.media_id || null; item.mediaUrl = mediaUrl || ''; item.editingId = card.id || null; item.name = card.name || ''; item.generation += 1; item.baseline = snapshot(card.template);
    },
    beginSave(template, name) { const item = draft(template); return Object.freeze({ template, generation: item.generation, editingId: item.editingId, name, values: copy(item.values), mediaId: item.mediaId, snapshot: JSON.stringify([item.values, item.mediaId]) }); },
    acceptSave(ticket, response) { const item = draft(ticket.template); if (!item || item.generation !== ticket.generation) return false; item.editingId = response?.id ?? item.editingId; item.name = response?.name ?? ticket.name; item.baseline = ticket.snapshot; return true; },
  };
}
