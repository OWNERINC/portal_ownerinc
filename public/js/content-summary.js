export function summarizeContent(blocks, fallback = '', maxChars = 180) {
  const parts = Array.isArray(blocks) ? blocks.flatMap(block => {
    if (!block || typeof block !== 'object') return [];
    if (['heading', 'paragraph', 'callout'].includes(block.type)) return [block.title, block.text].filter(value => typeof value === 'string');
    if (block.type === 'list') return (Array.isArray(block.items) ? block.items : []).filter(value => typeof value === 'string');
    if (['link', 'pdf', 'video'].includes(block.type)) return [block.label, block.title].filter(value => typeof value === 'string');
    return [];
  }) : [];
  const body = parts.join(' ').replace(/\s+/g, ' ').trim();
  const text = body || (Array.isArray(blocks) && blocks.length ? 'Material complementar disponível.' : String(fallback || '').replace(/\s+/g, ' ').trim());
  const limit = Math.max(1, Math.floor(Number(maxChars) || 180));
  const chars = Array.from(text);
  return chars.length <= limit ? text : chars.slice(0, limit - 1).join('').trimEnd() + '…';
}
