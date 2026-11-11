// Shared synthetic identity boundary for independent Pages browser checks.
import assert from 'node:assert/strict';

export async function pagesBrowserContext(browser, { uid = 'super', width = 1366, errors = [], touch = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: width > 1000 ? 900 : 840 }, reducedMotion: 'reduce', hasTouch: touch });
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
  await page.getByRole('dialog', { name: 'O que você quer adicionar?' }).getByRole('button', { name, exact: true }).click();
}
export async function pagesEditorMore(page) {
  if (page.viewportSize().width < 600) {
    const menu = page.locator('.pages-v2-overflow');
    if (!await menu.evaluate(node => node.open)) await menu.locator('summary').click();
  }
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
