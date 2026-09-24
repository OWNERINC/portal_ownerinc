export function normalizeEditorBlocks(blocks) {
  if (!Array.isArray(blocks)) return blocks;
  return blocks.map(block => {
    if (!block || typeof block !== 'object') return block;
    const next = structuredClone(block);
    if (['video', 'callout'].includes(next.type) && typeof next.title === 'string' && !next.title.trim()) delete next.title;
    return next;
  });
}
