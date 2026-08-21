import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const [html, app, guard, css, sidebar] = await Promise.all([
  readFile('public/cards-pos.html', 'utf8'),
  readFile('public/cards-pos/app.js', 'utf8'),
  readFile('public/cards-pos/guard.js', 'utf8'),
  readFile('public/cards-pos/styles.css', 'utf8'),
  readFile('public/js/sidebar.js', 'utf8'),
]);

test('Cards Pós uses the authenticated Portal shell and local module assets', async () => {
  for (const marker of ['portal-wrapper', 'sidebar', 'topbar', 'skip-link', 'id="main-content"', 'sidebar-logout']) assert.match(html, new RegExp(marker));
  for (const stylesheet of ['./css/tokens.css', './css/layout.css', './css/components.css', './cards-pos/styles.css']) assert.match(html, new RegExp(`href="${stylesheet.replaceAll('.', '\\.') }"`));
  assert.match(html, /title>Cards Pós — Portal Ownerinc/);
  assert.match(html, /assets\/icons\.svg#/);
  assert.doesNotMatch(html, /lucide@0\.441\.0/);
  assert.match(html, /<script src="\.\/js\/sidebar\.js"><\/script>/);
  assert.match(html, /type="module" src="\.\/cards-pos\/app\.js"/);
  for (const asset of ['owntime-logo-white.webp', 'ownerinc-logo-white.png', 'casa-logo-white.svg']) await access(`public/cards-pos/assets/${asset}`);
});

test('editor and history retain the source field and view contract', () => {
  for (const field of ['heroTitle', 'heroEmphasis', 'heroBrand', 'greeting', 'stayInfo', 'experienceTitle', 'experienceBody', 'foodInfo', 'consumptionTitle', 'consumptionBody', 'afterStay', 'conditions', 'contact']) {
    assert.match(html, new RegExp(`data-field="${field}"`));
    assert.match(app, new RegExp(field));
  }
  for (const id of ['editorView', 'historyView', 'cardCanvas', 'historySearch', 'historyList', 'historyEmpty']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /data-view="history"/);
  assert.match(app, /duplicate/);
  assert.match(app, /method: 'DELETE'/);
});

test('API calls are authenticated and use only the Pos-Cards routes', () => {
  for (const endpoint of ['/api/pos-cards/access', '/api/pos-cards/media', '/api/pos-cards/cards']) assert.match(`${app}${guard}`, new RegExp(endpoint.replaceAll('/', '\\/')));
  assert.match(app, /fetchAPI\('\/api\/pos-cards\/media'/);
  assert.match(app, /fetchAPIAsset/);
  assert.doesNotMatch(`${html}${app}${guard}`, /\/api\/(?!pos-cards)/);
  assert.doesNotMatch(`${html}${app}${guard}`, /server\.mjs|cards\.json/);
});

test('guard requires auth, checks access, and stops editor initialization when denied', () => {
  assert.match(guard, /requireAuth\(\)/);
  assert.match(guard, /fetchAPI\('\/api\/pos-cards\/access'\)/);
  assert.match(guard, /allowed\s*===\s*true/);
  assert.match(guard, /Acesso restrito/);
  assert.match(guard, /dashboard\.html/);
  assert.match(guard, /showDeniedState\(\);\s*window\.setTimeout\(\(\) => window\.location\.assign\('\.\/dashboard\.html'\), 1500\)/);
  assert.match(guard, /role', 'alert'/);
  assert.match(app, /if \(await requirePosCards\(\)\) init\(\)/);
});

test('history edits revoke the current blob URL before replacing media state', () => {
  const reset = app.indexOf("replaceMediaUrl('');");
  const state = app.indexOf('current = { ...current, editingId: card.id, mediaId: card.mediaId');
  assert.ok(reset >= 0 && reset < state);
});

test('preview escapes user values, validates image uploads, and preserves print composition', () => {
  assert.match(app, /function esc/);
  assert.match(app, /innerHTML = .*esc\(/s);
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) assert.match(app, new RegExp(type.replace('/', '\\/')));
  assert.match(app, /value < 500/);
  for (const logo of ['owntime-logo-white.webp', 'ownerinc-logo-white.png', 'casa-logo-white.svg']) assert.match(app, new RegExp(logo.replace('.', '\\.')));
  assert.match(css, /background: #e9e6de/);
  assert.match(css, /gold-rule/);
  assert.match(css, /@media print/);
  assert.match(css, /@page \{ size: 108mm 192mm/);
});

test('Portal visual and accessibility contracts are present without external font imports', () => {
  for (const token of ['var(--bg)', 'var(--surface)', 'var(--border)', 'var(--primary)', 'var(--focus)', 'var(--space-', 'var(--radius-', 'var(--shadow-']) assert.match(css, new RegExp(token.replace(/[()[\]-]/g, '\\$&')));
  assert.match(css, /grid-template-columns: minmax\(330px, 460px\)/);
  assert.match(css, /@media \(max-width: 900px\)/);
  assert.match(css, /min-height: 44px/);
  assert.match(css, /focus-visible/);
  assert.match(css, /:disabled/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /fonts\.googleapis\.com|@import/);
  assert.match(css, /Novelin-Regular\.otf/);
});

test('history actions and generated Cards Pós navigation retain shell interaction semantics', () => {
  assert.match(css, /\.history-actions button\s*\{[^}]*min-height:\s*44px;/);
  assert.match(html, /<!-- generated:portal-sidebar -->[\s\S]*class="pos-cards-link"[\s\S]*href="\.\/cards-pos\.html"/);
  assert.doesNotMatch(sidebar, /posCardsItem|posCardsLink/);
});

test('editing a Cards Pós invitation preserves its saved history name by default', () => {
  assert.match(app, /name: ''/);
  assert.match(app, /current\.name \|\| current\.values\.heroBrand/);
  assert.match(app, /mediaId: card\.mediaId, name: card\.name \|\| ''/);
  assert.match(app, /current\.name = saved\.name \|\| name\.trim\(\)/);
});

test('Cards Pós history ignores stale search responses', () => {
  assert.match(app, /let historyRequest = 0/);
  assert.match(app, /const requestToken = \+\+historyRequest/);
  assert.match(app, /if \(requestToken !== historyRequest\) return/);
});

test('Cards Pós history exposes pagination for more than one page of saved cards', () => {
  assert.match(html, /id="historyPagination"/);
  assert.match(app, /fetchAPIPage\(`\/api\/pos-cards\/cards\?search=\$\{search\}&limit=\$\{HISTORY_PAGE_SIZE\}&offset=\$\{historyOffset\}`\)/);
  assert.match(app, /renderHistoryPagination\(result\.total/);
});
