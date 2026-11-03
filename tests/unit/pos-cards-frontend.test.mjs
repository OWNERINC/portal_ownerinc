import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const [html, app, guard, css, sidebar, footer] = await Promise.all([
  readFile('public/cards-pos.html', 'utf8'),
  readFile('public/cards-pos/app.js', 'utf8'),
  readFile('public/cards-pos/guard.js', 'utf8'),
  readFile('public/cards-pos/styles.css', 'utf8'),
  readFile('public/js/sidebar.js', 'utf8'),
  readFile('public/cards-pos/assets/footer.svg', 'utf8'),
]);
const router = await readFile('public/js/router.js', 'utf8');

test('Cards Pós uses the authenticated Portal shell and local module assets', async () => {
  for (const marker of ['portal-wrapper', 'sidebar', 'topbar', 'skip-link', 'id="main-content"', 'sidebar-logout']) assert.match(html, new RegExp(marker));
  for (const stylesheet of ['./css/tokens.css', './css/layout.css', './css/components.css', './cards-pos/styles.css']) assert.match(html, new RegExp(`href="${stylesheet.replaceAll('.', '\\.') }"`));
  assert.match(html, /title>Cards Pós — Portal Ownerinc/);
  assert.match(html, /assets\/icons\.svg#/);
  assert.doesNotMatch(html, /lucide@0\.441\.0/);
  assert.match(html, /<script src="\.\/js\/sidebar\.js"><\/script>/);
  assert.match(html, /type="module" src="\.\/js\/router-bootstrap\.js"/);
  for (const asset of ['owntime-logo-white.webp', 'ownerinc-logo-white.png', 'casa-logo-white.svg', 'Raleway-Italic.ttf', 'Raleway-BoldItalic.ttf']) await access(`public/cards-pos/assets/${asset}`);
  await access('public/cards-pos/assets/guest/guest-cover.jpg');
  for (const asset of ['owner-cover.png', 'ownerinc-logo.svg', 'ownerinc-logo-footer.png', 'icon-cleaning.svg', 'icon-support.svg', 'icon-pet.svg', 'icon-food.svg', 'icon-chef.svg', 'icon-cleaning-extra.svg', 'icon-trainer.svg', 'icon-babysitter.svg', 'icon-car.svg', 'Raleway-Variable.woff2']) await access(`public/cards-pos/assets/owner/${asset}`);
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
  assert.match(app, /previewLabel.*250,68.*175,1/);
});

test('editor and history retain the source field and view contract', () => {
  for (const field of ['heroTitle', 'heroEmphasis', 'salutation', 'greeting', 'stayInfo', 'experienceTitle', 'experienceBody', 'consumptionTitle', 'consumptionBody', 'notIncludedBody', 'contact']) {
    assert.match(html, new RegExp(`data-field="${field}"`));
    assert.match(app, new RegExp(field));
  }
  assert.doesNotMatch(html, /data-field="heroBrand"/);
  for (const id of ['editorView', 'historyView', 'cardCanvas', 'historySearch', 'historyList', 'historyEmpty']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /data-view="history"/);
  assert.match(app, /duplicate/);
  assert.match(app, /method: 'DELETE'/);
  for (const field of ['heroTitle', 'heroEmphasis', 'heroBrand', 'salutation', 'greeting', 'stayInfo', 'address', 'includedIntro', 'includedTitle', 'cleaning', 'support', 'paidTitle', 'utilities', 'pet', 'servicesIntro', 'gastronomy', 'chef', 'extraCleaning', 'babysitter', 'trainer', 'carWash', 'hostNote', 'footerLabel', 'contact', 'footerEmail']) {
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
  assert.match(router, /path === '\/cards-pos\.html'\) return user\.pos_cards_access === true/);
  assert.match(router, /if \(!routeAllowed\(url\.pathname, user\)\) throw/);
  assert.match(app, /export function mount\(page\)/);
});

test('history edits replace only the target draft media and preserve the other template', () => {
  assert.match(app, /const targetDraft = draftStore\.get\(card\.template\)/);
  assert.match(app, /targetDraft\?\.mediaUrl\?\.startsWith\('blob:'\)/);
  assert.match(app, /draftStore\.loadSaved\(card, mediaUrl\)/);
});

test('preview escapes user values, validates image uploads, and preserves export composition', () => {
  assert.match(app, /function esc/);
  assert.match(app, /innerHTML = .*esc\(/s);
  for (const type of ['image/png', 'image/jpeg', 'image/webp']) assert.match(app, new RegExp(type.replace('/', '\\/')));
  assert.match(app, /value < 500/);
  assert.match(app, /GUEST_COVER_ASSET|OWNER_COVER_ASSET/);
  assert.match(app, /function renderFooter/);
  assert.match(app, /footer-phone-editable/);
  assert.match(app, /address-line/);
  assert.match(css, /background: #eae8e0/);
  assert.match(css, /\.owner-body \{[^}]*background: #fff/);
  assert.match(app, /owner-host-note/);
  for (const marker of ['owner-included', 'owner-paid', 'owner-services-grid', 'owner-footer-contact']) assert.match(app, new RegExp(marker));
  assert.match(css, /\.owner-services-grid \{[^}]*grid-template-columns:/);
  assert.doesNotMatch(css, /\.owner-host-note \{[^}]*transform:/);
  assert.match(app, /GUEST_COVER_ASSET = '\.\/cards-pos\/assets\/guest\/guest-cover\.jpg'/);
  assert.match(app, /owner-cover\.png/);
  assert.match(app, /ownerinc-logo-footer\.png/);
  assert.match(css, /aspect-ratio: 1448 \/ 2347/);
  assert.match(css, /aspect-ratio: 1448 \/ 3361/);
  assert.match(css, /grid-template-rows: 21\.15442% minmax\(0, 1fr\) 8\.74740%/);
  assert.match(css, /grid-template-rows: 30\.59% minmax\(0, 1fr\) 13\.08%/);
  assert.match(css, /font-family: ['"]Raleway['"]/);
  assert.match(css, /@page owner-page/);
  assert.match(css, /@page owner-page \{ size: 108mm 250\.68mm/);
  assert.match(css, /gold-rule/);
  assert.match(css, /@media print/);
  assert.match(css, /@page guest-page \{ size: 108mm 175\.1mm/);
  assert.match(app, /if \(available <= 0\) return/);
  assert.match(app, /Math\.max\(0, available - 1\) \/ copy\.scrollHeight/);
  assert.match(app, /querySelectorAll\('img'\)\.forEach\(\(image\) => page\.listen\(image, 'load', fitCardBody/);
  assert.match(app, /async function waitForCardAssets/);
  assert.match(app, /typeof root\.querySelector === 'function'/);
  assert.match(app, /window\.html2canvas/);
  assert.match(app, /new window\.jspdf\.jsPDF/);
  assert.match(app, /pdf\.addImage/);
  assert.match(app, /pdf\.save/);
  assert.match(app, /setAttribute\('aria-hidden', 'true'\)/);
  assert.match(app, /const fileName = pdfFileName\(\)/);
  assert.doesNotMatch(app, /window\.print/);
  assert.match(html, /html2canvas\/1\.4\.1\/html2canvas\.min\.js/);
  assert.match(html, /jspdf\/2\.5\.1\/jspdf\.umd\.min\.js/);
  assert.doesNotMatch(app, /copy\.style\.width = `\$\{100 \/ scale\}%`/);
  assert.match(css, /\.card-copy \{[^}]*height: max-content; flex: none;/);
  assert.match(css, /\.card-copy > \* \{ flex-shrink: 0; \}/);
  assert.match(css, /\.benefit-box \.inline-copy \{[^}]*margin-bottom:\s*19px;/);
  assert.match(css, /\.guest-card \{ page: guest-page; height: 175\.1mm/);
  assert.match(css, /\.owner-card \{ page: owner-page; width: 108mm; height: 250\.68mm/);
  assert.match(css, /page-break-inside: avoid/);
  assert.match(css, /break-inside: avoid/);
  assert.match(css, /break-after: avoid-page/);
  assert.match(app, /const available = body\.clientHeight - parseFloat\(styles\.paddingTop\) - parseFloat\(styles\.paddingBottom\)/);
  assert.doesNotMatch(app, /current\.template !== 'convite_owner'\) return/);
  assert.match(app, /text\.replace\(\/\[\^\\d\+\(\)\.\\s-\]\//);
});

test('Figma frames keep their proportions, address, photos, and editable phone footer', () => {
  assert.match(app, /const ADDRESS_LABEL = 'Como chegar:'/);
  assert.match(app, /const ADDRESS_TEXT = 'Rua João XXIII, 222, Centro - Gramado'/);
  assert.match(app, /function renderAddress/);
  assert.match(app, /renderAddress\(\)/g);
  assert.match(app, /address-line"><strong>\$\{ADDRESS_LABEL\}<\/strong> <span>\$\{ADDRESS_TEXT\}<\/span>/);
  assert.match(app, /FOOTER_ASSET/);
  assert.match(app, /footer-phone-editable.*phoneFromContact/);
  assert.match(app, /current\.mediaUrl \|\| (?:GUEST|OWNER)_COVER_ASSET/);
  assert.match(html, /Telefone/);
  assert.match(css, /\.footer-phone-backdrop/);
  assert.match(css, /\.footer-phone-editable/);
  assert.match(css, /container-type: inline-size/);
  assert.match(css, /font-size: 1\.105cqw/);
  assert.match(css, /left: 5\.28%; top: 61\.72%/);
  assert.match(css, /\.footer-phone-editable \{ font-size: 1\.2mm; \}/);
  assert.match(css, /border-radius: 10% \/ 20%/);
  assert.match(app, /ownerinc-logo\.svg/);
  assert.match(css, /\.address-line \{[^}]*white-space: nowrap/);
  assert.match(css, /\.address-line \{[^}]*text-align: left !important/);
  assert.match(css, /\.address-line span \{ font-weight: 400; \}/);
  assert.doesNotMatch(app, /replaceFooterWithAsset/);
});

test('rich text fields expose a native toolbar and a strict HTML allowlist', () => {
  assert.match(app, /function sanitizeRichHtml/);
  assert.match(app, /const RICH_TAG_PATTERN/);
  assert.match(app, /contentEditable/);
  assert.match(app, /dataset\.maxlength/);
  assert.doesNotMatch(app, /container\.textContent\.slice\(0, maxLength\)/);
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
  assert.match(app, /if \(saving \|\| activeMediaPromise \|\| exportInProgress\) return/);
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
  assert.match(app, /draftStore\.loadSaved\(card, mediaUrl\)/);
});

test('Cards Pós history ignores stale search responses', () => {
  assert.match(app, /let historyRequest = 0/);
  assert.match(app, /const requestToken = \+\+historyRequest/);
  assert.match(app, /const isCurrent = \(\) => page\.active && requestToken === historyRequest/);
  assert.match(app, /if \(!isCurrent\(\)\) return false/);
});

test('Cards Pós history exposes pagination for more than one page of saved cards', () => {
  assert.match(html, /id="historyPagination"/);
  assert.match(app, /fetchAPIPage\(`\/api\/pos-cards\/cards\?search=\$\{search\}&limit=\$\{HISTORY_PAGE_SIZE\}&offset=\$\{query\.offset\}`\)/);
  assert.match(app, /const total = result\.total \?\? cards\.length/);
  assert.match(app, /renderHistoryPagination\(total, requestToken\)/);
});

function guestHarness(width = 600, overrides = {}) {
  const captured = {};
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { textContent: '', classList: { toggle() {}, contains: () => true } });
    return elements.get(id);
  };
  const card = {
    style: {}, innerHTML: '',
    getBoundingClientRect: () => ({ width, height: width * 2347 / 1448 }),
    querySelector: () => null, querySelectorAll: () => [], removeAttribute() {},
    cloneNode() { return { ...this, style: {} }; },
  };
  const document = {
    fonts: { ready: Promise.resolve() },
    getElementById: id => id === 'cardCanvas' ? card : element(id),
    querySelectorAll: () => [], body: { append() {} },
    createElement: () => ({ setAttribute() {}, append() {}, remove() { captured.removed = true; } }),
  };
  const page = overrides.lifecycle || {
    active: true, beforeLeave() {}, listen() {}, cleanup() {}, frame: callback => callback(),
    wait: promise => Promise.resolve(promise),
    objectURL: () => 'blob:validation',
    image: async () => ({ complete: true, naturalWidth: 800, naturalHeight: 800, decode: async () => {} }),
  };
  Object.assign(page, overrides.page);
  const window = {
    addEventListener() {}, removeEventListener() {},
    html2canvas: async (clone, options) => {
      captured.render = options;
      captured.size = { ...clone.style };
      return { toDataURL: () => 'data:image/png;base64,test' };
    },
    jspdf: { jsPDF: class {
      constructor(options) { captured.pdf = options; }
      addImage(...args) { captured.image = args; }
      save(name) { captured.name = name; }
    } },
  };
  const source = app.slice(app.indexOf('const $ ='), app.indexOf('page.wait(document.fonts?.ready).then'));
  const normalizeRichHtml = value => String(value ?? '').replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '').replace(/\s(on\w+|style|href)=(?:"[^"]*"|'[^']*')/gi, '');
  const revoked = [];
  const api = vm.runInNewContext(`${source}\n({ current, guestDefaults, loadValues, updateRichField, exportPdf, upload, renderMediaStatus });`, {
    document, page, window, normalizeRichHtml,
    moduleRichTextToPlainText: value => String(value ?? '').replace(/<[^>]*>/g, ''),
    URL: { revokeObjectURL: url => revoked.push(url) },
    fetchAPI: overrides.fetchAPI || (async () => ({ id: 'replacement' })),
    fetchAPIAsset: overrides.fetchAPIAsset || (async () => 'blob:replacement'),
  });
  return { ...api, card, captured, element, revoked, page };
}

test('failed photo replacement keeps the previous media and support feedback through PDF export', async () => {
  for (const failure of ['post', 'asset', 'decode']) {
    const error = Object.assign(new Error('Request not allowed.'), { requestId: 'support-123' });
    const h = guestHarness(600, {
      fetchAPI: async () => { if (failure === 'post') throw error; return { id: 'replacement' }; },
      fetchAPIAsset: async () => { if (failure === 'asset') throw error; return 'blob:replacement'; },
      page: { image: async src => {
        if (failure === 'decode' && src === 'blob:replacement') throw error;
        return { complete: true, naturalWidth: 800, naturalHeight: 800 };
      } },
    });
    h.current.mediaId = 'previous';
    h.current.mediaUrl = 'blob:previous';
    await h.upload({ type: 'image/jpeg', size: 1000 });
    assert.equal(h.current.mediaId, 'previous');
    assert.equal(h.current.mediaUrl, 'blob:previous');
    const message = h.element('mediaStatus').textContent;
    assert.match(message, /A imagem anterior foi mantida/);
    assert.match(message, /support-123/);
    assert.doesNotMatch(message, /Request not allowed/);
    assert.ok(h.revoked.includes('blob:validation'));
    assert.ok(!h.revoked.includes('blob:previous'));
    if (failure === 'decode') assert.ok(h.revoked.includes('blob:replacement'));
    await h.exportPdf();
    assert.equal(h.element('mediaStatus').textContent, message);
    assert.match(h.element('status').textContent, /PDF baixado/);
    assert.equal(h.element('saveButton').disabled, false);
  }
});

test('photo replacement commits only when ready, retries and scopes feedback to its template', async () => {
  let resolveImage;
  let fail = true;
  const h = guestHarness(600, {
    fetchAPI: async () => { if (fail) throw new Error('offline'); return { id: 'replacement' }; },
    page: { image: src => src === 'blob:validation'
      ? Promise.resolve({ naturalWidth: 800, naturalHeight: 800 })
      : new Promise(resolve => { resolveImage = resolve; }) },
  });
  h.current.mediaId = 'previous';
  h.current.mediaUrl = 'blob:previous';
  await h.upload({ type: 'image/jpeg', size: 1000 });
  const failure = h.element('mediaStatus').textContent;
  h.current.template = 'convite_owner'; h.renderMediaStatus();
  assert.equal(h.element('mediaStatus').textContent, '');
  h.current.template = 'convite_owntime'; h.renderMediaStatus();
  assert.equal(h.element('mediaStatus').textContent, failure);
  fail = false;
  const upload = h.upload({ type: 'image/jpeg', size: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.current.mediaUrl, 'blob:previous');
  await h.exportPdf();
  assert.equal(h.captured.pdf, undefined);
  resolveImage({ complete: true, naturalWidth: 800, naturalHeight: 800 });
  await upload;
  assert.equal(h.current.mediaId, 'replacement');
  assert.equal(h.current.mediaUrl, 'blob:replacement');
  assert.ok(h.revoked.includes('blob:previous'));
  assert.match(h.element('mediaStatus').textContent, /Imagem adicionada/);
});

test('invalid local photos never reach upload and remain retryable', async () => {
  for (const file of [{ type: 'text/plain', size: 10 }, { type: 'image/png', size: 4 * 1024 * 1024 }]) {
    let calls = 0;
    const h = guestHarness(600, { fetchAPI: async () => { calls++; } });
    await h.upload(file);
    assert.equal(calls, 0);
    assert.match(h.element('mediaStatus').textContent, /Não foi possível aplicar/);
    assert.equal(h.element('imageInput').disabled, false);
  }
  assert.match(app, /const file = event\.target\.files\?\.\[0\];\s*event\.target\.value = '';/);
});

test('disposing the real lifecycle during decode revokes the staged photo without committing or updating detached feedback', async () => {
  const lifecycleSource = await readFile('public/js/page-lifecycle.js', 'utf8');
  const lifecycle = vm.runInNewContext(`${lifecycleSource.replace(/^export /gm, '')}\ncreatePageLifecycle()`, {
    window: { history: {} }, AbortController, DOMException, URL,
    setTimeout, clearTimeout, requestAnimationFrame: setImmediate, cancelAnimationFrame: clearImmediate,
  });
  let finishDecode;
  const decoding = new Promise(resolve => { finishDecode = resolve; });
  const h = guestHarness(600, {
    lifecycle,
    page: {
      objectURL: () => 'blob:validation',
      image: async src => ({ complete: true, naturalWidth: 800, naturalHeight: 800,
        decode: src === 'blob:replacement' ? () => decoding : undefined }),
    },
  });
  h.current.mediaId = 'previous'; h.current.mediaUrl = 'blob:previous';
  const pending = h.upload({ type: 'image/png', size: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.current.mediaId, 'previous');
  const feedback = h.element('mediaStatus').textContent;
  lifecycle.dispose();
  await pending;
  finishDecode();
  assert.equal(h.current.mediaId, 'previous');
  assert.notEqual(h.current.mediaUrl, 'blob:replacement');
  assert.equal(h.element('mediaStatus').textContent, feedback);
  assert.ok(h.revoked.includes('blob:replacement'));
});

test('desktop rich editor input updates the active draft and rerenders the preview', () => {
  const { current, updateRichField, card } = guestHarness();
  const field = {
    innerHTML: '<strong>Texto editado</strong>',
    dataset: { field: 'greeting', richEditor: 'true' },
    getAttribute: name => name === 'aria-multiline' ? 'true' : null,
  };
  updateRichField(field);
  assert.equal(current.values.greeting, '<strong>Texto editado</strong>');
  assert.match(card.innerHTML, /<strong>Texto editado<\/strong>/);
});

test('Guest Frame 1 keeps saved rich text and media, adds safe salutation and uses the official logo', () => {
  const { current, loadValues, card } = guestHarness();
  loadValues();
  assert.match(card.innerHTML, /<h2>Um convite<em>a viver o seu tempo<\/em><\/h2>/);
  assert.match(card.innerHTML, /Você é nosso convidado para viver uma experiência no <strong>Owntime Home Club Gramado:<\/strong>/);
  assert.match(card.innerHTML, /Alimentação, bebidas e serviços sob demanda serão cobrados à parte\./);
  assert.doesNotMatch(card.innerHTML, /on demand/);

  loadValues({ heroTitle: 'Este é um convite', heroEmphasis: 'para viver o seu tempo', greeting: '<strong>Convite salvo</strong>', heroBrand: 'Nome anterior', foodInfo: 'Texto antigo' });
  assert.equal(current.values.heroTitle, 'Este é um convite');
  assert.equal(current.values.heroEmphasis, 'para viver o seu tempo');
  assert.equal(current.values.greeting, '<strong>Convite salvo</strong>');
  assert.equal(current.values.heroBrand, 'Nome anterior');
  assert.equal(current.values.notIncludedBody, 'Texto antigo');
  assert.equal(current.values.salutation, 'Olá, Nome Sobrenome.');
  assert.match(card.innerHTML, /guest-salutation">Olá, Nome Sobrenome\./);
  assert.match(card.innerHTML, /<strong>Convite salvo<\/strong>/);
  assert.match(card.innerHTML, /guest-wordmark"><img src="\.\/cards-pos\/assets\/owntime-logo-white.webp" alt="Owntime"/);
  assert.doesNotMatch(card.innerHTML, /Nome anterior/);
  assert.match(card.innerHTML, /guest\/guest-cover\.jpg/);

  current.mediaUrl = 'blob:uploaded-guest-photo';
  loadValues({ salutation: '<img src=x onerror=alert(1)>Olá, <strong>Ana</strong>.' });
  assert.match(card.innerHTML, /guest-salutation">Olá, <strong>Ana<\/strong>\./);
  assert.doesNotMatch(card.innerHTML, /onerror|src=x/);
  assert.match(card.innerHTML, /src="blob:uploaded-guest-photo"/);
  loadValues({ salutation: '' });
  assert.equal(current.values.salutation, '');
});

test('Guest PDF uses the reference resolution at any viewport and retains the physical page size', async () => {
  for (const width of [320, 600]) {
    const { exportPdf, captured, current } = guestHarness(width);
    current.name = 'Convite Ana';
    await exportPdf();
    assert.equal(captured.size.width, '1448px');
    assert.equal(captured.size.height, '2347px');
    assert.equal(captured.render.width, 1448);
    assert.equal(captured.render.height, 2347);
    assert.equal(captured.render.scale, 1);
    assert.equal(captured.pdf.format.join(','), '108,175.1');
    assert.equal(captured.name, 'convite-ana.pdf');
    assert.equal(captured.removed, true);
  }
  for (const width of [320, 600]) {
    const { exportPdf, captured, current } = guestHarness(width);
    current.template = 'convite_owner';
    current.name = 'Owner';
    await exportPdf();
    assert.equal(captured.render.width, 1448);
    assert.equal(captured.render.height, 3361);
    assert.equal(captured.render.scale, 1);
    assert.equal(captured.pdf.format.join(','), '108,250.68');
  }
});
