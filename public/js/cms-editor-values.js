export function normalizeEditorBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map(block => {
    if (!block || typeof block !== 'object') return block;
    const next = structuredClone(block);
    if (['video', 'callout'].includes(next.type) && typeof next.title === 'string' && !next.title.trim()) delete next.title;
    const optionalFields = next.type === 'image' ? ['caption', 'credit']
      : next.type === 'quote' ? ['attribution']
        : next.type === 'profile' ? ['role', 'text', 'asset_id', 'alt'] : [];
    for (const field of optionalFields) {
      if (typeof next[field] === 'string' && !next[field].trim()) delete next[field];
    }
    return next;
  });
}
