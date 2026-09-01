import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const [html, app, guard, css, sidebar, footer] = await Promise.all([
  readFile('public/cards-pos.html', 'utf8'),
  readFile('public/cards-pos/app.js', 'utf8'),
  readFile('public/cards-pos/guard.js', 'utf8'),
  readFile('public/cards-pos/styles.css', 'utf8'),
  readFile('public/js/sidebar.js', 'utf8'),
  readFile('public/cards-pos/assets/footer.svg', 'utf8'),
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
  await access('public/cards-pos/assets/guest/guest-cover.jpg');
  for (const asset of ['owner-cover.jpg', 'icon-cleaning.svg', 'icon-support.svg', 'icon-security.svg', 'icon-pet.svg', 'icon-food.svg', 'icon-chef.svg', 'icon-trainer.svg', 'icon-babysitter.svg', 'icon-car.svg', 'Raleway-Variable.woff2']) await access(`public/cards-pos/assets/owner/${asset}`);
  assert.match(footer, /width="1448" height="307" viewBox="0 0 1448 307"/);
});

test('Cards Pós exposes independent Guest and Owner modules', () => {
  for (const module of ['guest', 'owner']) assert.match(html, new RegExp(`data-module="${module}"`));
  assert.match(html, /Convidado/);
  assert.match(html, /Owner/);
  assert.match(app, /convite_owntime/);
  assert.match(app, /convite_owner/);
  assert.match(app, /function switchModule/);
  assert.match(app, /function renderOwner/);
  assert.match(app, /previewLabel.*290,6.*175,1/);
});

test('editor and history retain the source field and view contract', () => {
  for (const field of ['heroTitle', 'heroEmphasis', 'heroBrand', 'greeting', 'stayInfo', 'experienceTitle', 'experienceBody', 'consumptionTitle', 'consumptionBody', 'notIncludedBody', 'contact']) {
    assert.match(html, new RegExp(`data-field="${field}"`));
    assert.match(app, new RegExp(field));
  }
  for (const id of ['editorView', 'historyView', 'cardCanvas', 'historySearch', 'historyList', 'historyEmpty']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /data-view="history"/);
  assert.match(app, /duplicate/);
  assert.match(app, /method: 'DELETE'/);
  for (const field of ['heroTitle', 'heroEmphasis', 'heroBrand', 'recipientName', 'greeting', 'stayInfo', 'includedIntro', 'includedTitle', 'cleaningTitle', 'cleaningBody', 'supportTitle', 'supportBody', 'securityTitle', 'securityBody', 'consumptionTitle', 'gasTitle', 'gasInfo', 'waterTitle', 'waterInfo', 'energyTitle', 'energyInfo', 'petTitle', 'petBody', 'servicesIntro', 'gastronomyTitle', 'gastronomyBody', 'chefTitle', 'chefBody', 'extraCleaningTitle', 'extraCleaningBody', 'trainerTitle', 'trainerBody', 'babysitterTitle', 'babysitterBody', 'carWashTitle', 'carWashBody', 'contact']) {
    assert.match(html, new RegExp(`data-owner-field="${field}"`));
    assert.match(app, new RegExp(field));
  }
});

test('API calls are authenticated and use only the Pos-Cards routes', () => {
  for (const endpoint of ['/api/pos-cards/media', '/api/pos-cards/cards']) assert.match(`${app}${guard}`, new RegExp(endpoint.replaceAll('/', '\\/')));
  assert.match(app, /fetchAPI\('\/api\/pos-cards\/media'/);
  assert.match(app, /fetchAPIAsset/);
  assert.doesNotMatch(`${html}${app}${guard}`, /\/api\/(?!pos-cards)/);
  assert.doesNotMatch(`${html}${app}${guard}`, /server\.mjs|cards\.json/);
});

test('guard requires auth, checks access, and stops editor initialization when denied', () => {
  assert.match(guard, /requireAuth\(\)/);
  assert.match(guard, /user\.pos_cards_access === true/);
  assert.doesNotMatch(guard, /fetchAPI\(|\/api\/pos-cards\/access/);
  assert.match(guard, /Acesso restrito/);
  assert.match(guard, /dashboard\.html/);
  assert.match(guard, /showDeniedState\(\);\s*window\.setTimeout\(\(\) => window\.location\.assign\('\.\/dashboard\.html'\), 1500\)/);
  assert.match(guard, /role', 'alert'/);
  assert.match(app, /if \(await requirePosCards\(\)\) \{/);
});

test('history edits revoke the current blob URL before replacing media state', () => {
  const reset = app.indexOf("replaceMediaUrl('');");
  const state = app.indexOf('current = { ...current, template: card.template, editingId: card.id, mediaId: card.mediaId');
  assert.ok(reset >= 0 && reset < state);
});

test('preview escapes user values, validates image uploads, and preserves print composition', () => {
  assert.match(app, /function esc/);
  assert.match(app, /innerHTML = .*esc\(/s);
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) assert.match(app, new RegExp(type.replace('/', '\\/')));
  assert.match(app, /value < 500/);
  assert.match(app, /GUEST_COVER_ASSET|OWNER_COVER_ASSET/);
  assert.match(app, /function renderFooter/);
  assert.match(app, /footer-phone-editable/);
  assert.match(app, /address-line/);
  assert.match(css, /background: #e9e6de/);
  assert.match(app, /guest-cover\.jpg/);
  assert.match(app, /owner-cover\.jpg/);
  assert.match(css, /aspect-ratio: 1448 \/ 2347/);
  assert.match(css, /aspect-ratio: 1448 \/ 3896/);
  assert.match(css, /grid-template-rows: 18\.43% minmax\(0, 1fr\) 7\.88%/);
  assert.match(css, /grid-template-rows: 30\.59% minmax\(0, 1fr\) 13\.08%/);
  assert.match(css, /font-family: ['"]Raleway['"]/);
  assert.match(css, /@page owner-page/);
  assert.match(css, /@page owner-page \{ size: 108mm 290\.6mm/);
  assert.match(css, /gold-rule/);
  assert.match(css, /@media print/);
  assert.match(css, /@page guest-page \{ size: 108mm 175\.1mm/);
  assert.match(app, /const available = body\.clientHeight - parseFloat\(styles\.paddingTop\) - parseFloat\(styles\.paddingBottom\)/);
  assert.doesNotMatch(app, /current\.template !== 'convite_owner'\) return/);
  assert.match(app, /text\.replace\(\/\[\^\\d\+\(\)\.\\s-\]\//);
});

test('Figma frames keep their proportions, address, photos, and editable phone footer', () => {
  assert.match(app, /const ADDRESS_TEXT = 'Como chegar: Rua João XXIII, 222, Centro - Gramado'/);
  assert.match(app, /function renderAddress/);
  assert.match(app, /renderAddress\(\)/g);
  assert.match(app, /FOOTER_ASSET/);
  assert.match(app, /footer-phone-editable.*phoneFromContact/);
  assert.match(app, /current\.mediaUrl \|\| (?:GUEST|OWNER)_COVER_ASSET/);
  assert.match(html, /Telefone/);
  assert.match(css, /\.footer-phone-backdrop/);
  assert.match(css, /\.footer-phone-editable/);
  assert.doesNotMatch(app, /replaceFooterWithAsset/);
});

test('rich text fields expose a native toolbar and a strict HTML allowlist', () => {
  assert.match(app, /function sanitizeRichHtml/);
  assert.match(app, /const RICH_TAG_PATTERN/);
  assert.match(app, /contentEditable/);
  assert.match(app, /dataset\.maxlength/);
  assert.match(app, /container\.textContent\.slice\(0, maxLength\)/);
  assert.match(app, /function toRichHtml\(value\) \{\s*return sanitizeRichHtml\(value\);/);
  assert.match(app, /event\.clipboardData\?\.getData\('text\/html'\)/);
  assert.match(app, /function init\(\) \{[\s\S]*?upgradeRichFields\(\);[\s\S]*?loadValues\(\);/);
  for (const command of ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList', 'removeFormat']) {
    assert.match(app, new RegExp(command));
  }
  for (const tag of ['STRONG', 'EM', 'U', 'S', 'BR', 'UL', 'OL', 'LI']) assert.match(app, new RegExp(tag));
  assert.match(css, /\.rich-toolbar \{/);
  assert.match(css, /\.rich-editor \{/);
  assert.doesNotMatch(app, /<\/?(?:script|iframe)\b/i);
});

test('media upload and card editing cannot apply stale responses or save mid-operation', () => {
  assert.match(app, /let mediaOperationToken = 0/);
  assert.match(app, /let activeMediaPromise = null/);
  assert.match(app, /const operationToken = \+\+mediaOperationToken/);
  assert.match(app, /if \(operationToken !== mediaOperationToken\) return/);
  assert.match(app, /\$\('saveButton'\)\.disabled = busy/);
  assert.match(app, /if \(activeMediaPromise\) return/);
});

test('the hidden file input has a single accessible keyboard trigger', () => {
  assert.match(html, /id="imageInput"[^>]*tabindex="-1"[^>]*aria-hidden="true"/);
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
  assert.match(css, /font-family:\s*var\(--font-sans\)/);
  assert.match(css, /font-family:\s*['"]Novelin['"]/);
});

test('history actions and generated Cards Pós navigation retain shell interaction semantics', () => {
  assert.match(css, /\.history-actions button\s*\{[^}]*min-height:\s*44px;/);
  assert.match(html, /<!-- generated:portal-sidebar -->[\s\S]*class="pos-cards-link"[\s\S]*href="\.\/cards-pos\.html"/);
  assert.doesNotMatch(sidebar, /posCardsItem|posCardsLink/);
});

test('editing a Cards Pós invitation preserves its saved history name by default', () => {
  assert.match(app, /name: ''/);
  assert.match(app, /current\.name \|\| richTextToPlainText\(activeValues\(\)\.heroBrand\)/);
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
