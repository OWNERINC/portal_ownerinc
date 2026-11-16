import { clone, allBlocks } from './model.js';
import { defaultStyle } from './composition.js';

// Extract only the public video identity. No fetching, iframe parsing, URL
// persistence or suffix matching. Tracking parameters are deliberately discarded.
export function parseYouTubeURL(input) {
  if (typeof input !== 'string' || /[<>\u0000-\u0020\\]/u.test(input.trim())) return null;
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !['youtube.com','www.youtube.com','m.youtube.com','youtu.be'].includes(url.hostname)) return null;
    let id;
    if (url.hostname === 'youtu.be') id = /^\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)?.[1];
    else if (url.pathname === '/watch' && url.searchParams.getAll('v').length === 1) id = url.searchParams.get('v');
    else id = /^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)?.[1];
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? { provider: 'youtube', video_id: id } : null;
  } catch { return null; }
}

// Pure opt-in conversion. Opening, cancelling or saving an unchanged old page
// must never call a writer or implicitly change its schema/content/identities.
export function upgradeDocument(doc) {
  const next = clone(doc);
  if (next.schema_version === 3) return next;
  next.schema_version = 3;
  next.template = { id: next.template.id, version: next.template.id === 'owner-news' ? 2 : 3 };
  next.metadata.category = '';
  next.presentation = { theme: 'conecta', defaults: { font: 'manrope', scale: 'standard', align: 'start',
    palette: 'conecta', foreground: '#2A275E', background: '#FFFEFB', accent: '#E84F1C' } };
  for (const block of allBlocks(next)) {
    if (!block.style) block.style = defaultStyle();
    if (block.type === 'button' && block.destination) { block.action = block.destination; delete block.destination; }
  }
  return next;
}

export function editV3(doc, change) {
  const next = upgradeDocument(doc), before = JSON.stringify(next);
  const result = change(next);
  if (result === false || result === null || JSON.stringify(next) === before) return null;
  return next;
}
