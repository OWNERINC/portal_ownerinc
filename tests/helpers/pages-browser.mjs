// Shared synthetic identity boundary for independent Pages browser checks.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { featureDocument, referenceMedia } from './pages-reference-document.mjs';
import { createPagesMediaFixtures } from './pages-media-fixtures.mjs';

// Full functional fixture: register real private bytes before assigning references.
// Never use this for source-equivalence captures or import it into product code.
export async function pagesFeatureDocument(h, id, cargo, actor = 'super') {
  const fixtures = await createPagesMediaFixtures();
  try {
    const image = referenceMedia()[0], media = {};
    for (const [kind, bytes, name] of [['image', image.bytes, image.file_name], ['audio', fixtures.files['synthetic.mp3'].buffer, 'synthetic.mp3']]) {
      const request = h.request.post(`/api/pages/${id}/media`).set('Authorization', `Bearer ${actor}`).field('client_mutation_id', randomUUID());
      if (kind !== 'image') request.field('kind', kind);
      const response = await request.attach(kind === 'image' ? 'image' : 'file', bytes, name);
      assert.equal(response.status, 201, JSON.stringify(response.body));
      media[kind] = response.body.media_id;
    }
    const document = featureDocument();
    document.metadata.audience.job_title_ids = [cargo];
    for (const block of document.sections.flatMap(s => s.rows.flatMap(r => r.columns.flatMap(c => c.blocks)))) {
      if (block.type === 'image') Object.assign(block, { media_id: media.image, alt: 'Imagem sintética integrada', caption: 'Legenda integrada', credit: 'Teste local' });
      if (block.type === 'audio') Object.assign(block, { media_id: media.audio, transcript: 'Tom sintético, sem voz.' });
      if (block.type === 'gallery') for (const item of block.items) Object.assign(item, { media_id: media.image, alt: 'Galeria sintética integrada', caption: 'Galeria integrada', credit: 'Teste local' });
      if (block.type === 'faq') for (const item of block.items) item.answer = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Resposta sintética integrada.' }] }] };
    }
    return document;
  } finally { await fixtures.close(); }
}

export async function pagesBrowserContext(browser, { uid = 'super', width = 1366, errors = [], touch = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width > 1000 ? 900 : 840 }, reducedMotion: 'reduce', hasTouch: touch });
  // Registered before local Firebase fulfillments: real outbound traffic is
  // always denied, including when reusing this helper for history regressions.
  await context.route('**/*', route => ['127.0.0.1','localhost','[::1]'].includes(new URL(route.request().url()).hostname) ? route.fallback() : route.abort('blockedbyclient'));
  await context.route('**/js/firebase-config.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    const listeners = new Set();
    const account = uid => uid ? { uid, getIdToken: async () => uid } : null;
    export const auth = { currentUser: account(${JSON.stringify(uid)}), app: { name: '[DEFAULT]', options: { apiKey: 'fixture' } }, authStateReady: async () => {} };
    globalThis.__fixtureAuth = auth;
    globalThis.__fixtureListeners = listeners;
    globalThis.__fixtureChangeUser = uid => { auth.currentUser = account(uid); for (const listener of listeners) listener(auth.currentUser); };
  ` }));
  await context.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: `
    export function onAuthStateChanged(auth, callback) { globalThis.__fixtureListeners.add(callback); queueMicrotask(() => callback(auth.currentUser)); return () => globalThis.__fixtureListeners.delete(callback); }
    export async function signOut() { globalThis.__fixtureChangeUser(null); }
    export async function updateProfile() {}
    export async function signInWithEmailAndPassword() { throw new Error('Real sign-in is outside this synthetic Pages harness'); }
  ` }));
  await context.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    globalThis.__pagesObjectURLs = new Set();
    URL.createObjectURL = value => { const url = create(value); globalThis.__pagesObjectURLs.add(url); return url; };
    URL.revokeObjectURL = url => { globalThis.__pagesObjectURLs.delete(url); return revoke(url); };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  return { page, context };
}

export async function pagesBrowserReady(page) {
  await page.waitForFunction(() => document.querySelector('main') && !document.querySelector('main').hasAttribute('data-route-pending'));
  await page.evaluate(() => document.fonts.ready);
}

export async function pagesEditorPageProperties(page) {
  await pagesEditorMore(page);
  if (page.viewportSize().width < 1100) await page.getByRole('button', { name: 'Propriedades', exact: true }).click();
  else await page.getByRole('button', { name: 'Página', exact: true }).click();
}
export async function pagesEditorInsert(page, name) {
  await pagesEditorMore(page);
  await page.getByRole('button', { name: 'Inserir bloco', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'O que você quer adicionar?' });
  if (['Adicionar destaque','Adicionar botão'].includes(name)) await dialog.getByRole('button', { name: 'Destaque ou botão', exact: true }).click();
  if (['Adicionar FAQ','Adicionar separador'].includes(name)) await dialog.locator('summary').filter({ hasText: 'Outros blocos' }).click();
  await dialog.getByRole('button', { name, exact: true }).click();
}
export async function pagesEditorMore(page) {
  if (page.viewportSize().width < 600) {
    const menu = page.locator('.pages-v2-overflow');
    if (!await menu.evaluate(node => node.open)) await menu.locator(':scope > summary').click();
  }
}
export async function pagesEditorPreview(page, mode) {
  // Preview is now alongside Blocks/Publish on phones, outside More actions.
  const more=page.locator('.pages-v2-overflow');
  if(page.viewportSize().width<600&&await more.evaluate(node=>node.open))await more.locator(':scope > summary').click();
  const menu=page.locator('.pages-v2-preview-menu');
  if(!await menu.evaluate(n=>n.open))await menu.locator('summary').click();
  await menu.locator(`[data-preview-mode="${mode}"]`).click();
}
export async function pagesEditorOrganize(page) {
  if (page.viewportSize().width < 1100) await page.getByRole('button', { name: 'Blocos', exact: true }).click();
  const toggle = page.getByRole('button', { name: 'Organizar estrutura', exact: true });
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
  if (page.viewportSize().width < 1100) await page.keyboard.press('Escape');
}

export async function pagesBrowserReflow(page, AxeBuilder, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label}: horizontal overflow`);
  assert.equal(await page.locator('main h1:visible').count(), 1, `${label}: one visible H1 (editor heading is hidden in preview)`);
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(audit.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), [], `${label}: accessibility`);
}
