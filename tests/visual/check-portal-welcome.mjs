// Local real UI/Knowledge SQL/API; synthetic Firebase, reminders and Academy fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { knowledgeDocumentAPI } from '../helpers/knowledge-document-api.mjs';

for (const name of ['WELCOME_VISUAL_OUTPUT', 'PLAYWRIGHT_MODULE_PATH', 'AXE_MODULE_PATH']) {
  if (!process.env[name]) throw new Error(`Set ${name}`);
}
const output = resolve(process.env.WELCOME_VISUAL_OUTPUT);
await mkdir(output);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express');
const h = await knowledgeDocumentAPI({ uploadDir: output });
const ethicsID = '550e8400-e29b-41d4-a716-446655440090';
await h.db.query(`INSERT INTO knowledge_base(id,title,category,content,document,updated_at)
  VALUES($1,'Código de Ética e Conduta','Institucional','Orientações para nossa atuação.', '{"kind":"ethics"}','2020-01-01'),
  ('550e8400-e29b-41d4-a716-446655440010','Uniformes — exemplo de teste','Uniformes','Orientações de uso.',NULL,NOW())`, [ethicsID]);
h.state.users.set('reader', { ...h.state.users.get('reader'), name: 'Marina Andrade',
  autocard_access: false, pos_cards_access: false });
h.state.users.set('manager', { ...h.state.users.get('manager'), name: 'Paulo Santos',
  permissions: { manageAcademy: true }, job_title_active: true,
  job_title_access: { autocard: true, posCards: true } });
const site = express();
site.get('/api/reminders/upcoming', (_req, res) => res.json([]));
site.get(['/api/academy', '/api/academy/categories', '/api/academy/continue'], (_req, res) => res.set('X-Total-Count', '0').json([]));
// Match Nginx: static assets do not consume the Express API rate budget.
site.use((req, res, next) => /^\/(?:api|uploads)(?:\/|$)/.test(req.path) ? h.app(req, res, next) : next());
site.use(express.static(fileURLToPath(new URL('../../public/', import.meta.url))));
const server = createServer(site);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const results = [], errors = [];
let browser;
async function openContext(width, uid = 'reader') {
  const context = await browser.newContext({ viewport: { width, height: 850 }, reducedMotion: 'reduce' });
  await context.route('**/js/firebase-config.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    export const auth = { currentUser: { uid: ${JSON.stringify(uid)}, getIdToken: async () => ${JSON.stringify(uid)} },
      authStateReady: async () => {}, app: { name: '[DEFAULT]', options: { apiKey: 'fixture' } } };
  ` }));
  await context.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: `
      export function onAuthStateChanged(auth, callback) { queueMicrotask(() => callback(auth.currentUser)); return () => {}; }
      export async function signOut() {}
      export async function updateProfile() {}
    `,
  }));
  const page = await context.newPage(), requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname.startsWith('/api/')) requests.push(url.pathname + url.search);
  });
  return { context, page, requests };
}
async function dashboard(page) {
  await page.goto(`${origin}/dashboard.html`);
  await page.getByRole('link', { name: 'Ler Código de Ética', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('#reminders-list')?.textContent.includes('Carregando'));
}
async function checkLayout(page, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, label);
  const covers = page.locator('main img[src$="ethics-cover.svg"]');
  assert.equal(await covers.count(), 1);
  await covers.evaluate(image => image.decode());
  const dimensions = await covers.evaluate(image => ({ width: image.naturalWidth, height: image.naturalHeight,
    ratio: image.getBoundingClientRect().width / image.getBoundingClientRect().height }));
  assert.equal(dimensions.width, 960);
  assert.equal(dimensions.height, 540);
  assert.ok(Math.abs(dimensions.ratio - 16 / 9) < 0.02);
}
async function assertNoAcademy(page, requests) {
  assert.equal(await page.locator('.sidebar-nav a[href$="academy.html"]').count(), 0);
  assert.equal(await page.locator('main a[href*="academy.html"]').count(), 0);
  assert.equal(requests.some(path => path.startsWith('/api/academy')), false);
}
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  for (const width of [320, 390, 1366]) {
    const { context, page, requests } = await openContext(width);
    await dashboard(page);
    assert.match(await page.locator('#dashboard-greeting').textContent(), /Marina/);
    assert.doesNotMatch(await page.locator('#dashboard-greeting').textContent(), /Andrade/);
    await assertNoAcademy(page, requests);
    for (const target of ['autocard.html', 'cards-pos.html', 'admin.html']) {
      assert.equal(await page.locator(`main a[href$="${target}"]`).count(), 0);
    }
    for (const target of ['knowledge.html', 'reminders.html', 'pages.html', 'profile.html']) {
      assert.ok(await page.locator(`main a[href$="${target}"]`).count() >= 1);
    }
    await checkLayout(page, `${width} Dashboard overflow`);
    await page.addScriptTag({ path: resolve(process.env.AXE_MODULE_PATH) });
    const audit = await page.evaluate(async () => {
      const result = await axe.run('main', { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } });
      return { violations: result.violations, incomplete: result.incomplete };
    });
    await writeFile(join(output, `axe-${width}.json`), JSON.stringify(audit, null, 2));
    assert.deepEqual(audit.violations, [], `${width} accessibility violations`);
    await page.screenshot({ path: join(output, `dashboard-${width}.png`), fullPage: true });
    const link = page.getByRole('link', { name: 'Ler Código de Ética', exact: true });
    assert.equal(await link.getAttribute('href'), `./knowledge.html?article=${ethicsID}`);
    await link.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await link.evaluate(node => document.activeElement === node), true);
    assert.notEqual(await link.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
    await page.keyboard.press('Enter');
    await page.locator('.knowledge-ethics section').nth(26).waitFor({ state: 'attached' });
    assert.equal(await page.locator('.knowledge-ethics table').count(), 3);
    await page.goBack();
    await page.getByRole('link', { name: 'Ler Código de Ética', exact: true }).waitFor();
    const before = requests.length;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.waitForFunction(() => document.querySelector('#ethics-preview')?.getAttribute('aria-busy') !== 'true');
    assert.ok(requests.slice(before).some(path => path === '/api/knowledge?limit=1'));
    await assertNoAcademy(page, requests);
    results.push({ width, personalized: true, cover: true, overflow: false, keyboard: true, officialReader: true,
      history: true, simulatedBFCacheEvent: true, axeViolations: 0, axeIncomplete: audit.incomplete.length });
    await context.close();
  }
  {
    const { context, page, requests } = await openContext(1366, 'manager');
    await dashboard(page);
    for (const target of ['autocard.html', 'cards-pos.html', 'admin.html']) {
      assert.equal(await page.locator(`main a[href$="${target}"]`).count(), 1);
    }
    await assertNoAcademy(page, requests);
    await page.screenshot({ path: join(output, 'dashboard-admin-1366.png'), fullPage: true });
    await page.goto(`${origin}/admin.html?tab=academy`);
    await page.getByRole('tab', { name: 'Academy', exact: true }).waitFor();
    assert.equal(await page.getByRole('tab', { name: 'Academy', exact: true }).getAttribute('aria-selected'), 'true');
    await page.getByRole('button', { name: 'Novo curso', exact: true }).waitFor();
    await page.goto(`${origin}/academy.html`);
    await page.getByRole('heading', { name: 'Comece por aqui', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.academy-groups')?.textContent.includes('Carregando'));
    assert.equal(await page.locator('.sidebar-nav a[href$="academy.html"]').count(), 0);
    results.push({ adminTools: true, academyAdminTabRetained: true, academyDirectPageRetained: true,
      academyData: 'explicit empty synthetic fixtures, not service integration' });
    await context.close();
  }
  {
    const user = h.state.users.get('reader');
    h.state.users.set('reader', { ...user, name: '<img src=x> Teste', job_title_active: true,
      job_title_access: { autocard: true, posCards: false } });
    const { context, page } = await openContext(390);
    await dashboard(page);
    assert.equal(await page.locator('#dashboard-greeting img').count(), 0);
    assert.ok((await page.locator('#dashboard-greeting').textContent()).includes('<img'));
    assert.equal(await page.locator('main a[href$="autocard.html"]').count(), 1);
    assert.equal(await page.locator('main a[href$="cards-pos.html"]').count(), 0);
    assert.equal(await page.locator('main a[href$="admin.html"]').count(), 0);
    results.push({ literalName: true, partialToolPermissions: true });
    await context.close();
    h.state.users.set('reader', user);
  }
  {
    const { context, page } = await openContext(390);
    let mode = 'error', release, started;
    const held = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { started = resolve; });
    await context.route('**/api/knowledge?limit=1', async route => {
      if (mode === 'error') return route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } });
      if (mode === 'absent') return route.fulfill({ json: [{ id: ethicsID, title: 'Not ethics', document: null }] });
      if (mode === 'hold') { started(); await held; }
      return route.continue().catch(() => {});
    });
    await page.goto(`${origin}/dashboard.html`);
    const retry = page.locator('#ethics-preview').getByRole('button', { name: 'Tentar novamente', exact: true });
    await retry.waitFor();
    assert.ok((await page.locator('#reminders-list').textContent()).includes('Nenhuma notificação'));
    mode = 'success';
    await retry.focus();
    await page.keyboard.press('Enter');
    const link = page.getByRole('link', { name: 'Ler Código de Ética', exact: true });
    await link.waitFor();
    assert.equal(await link.evaluate(node => document.activeElement === node), true);
    mode = 'absent';
    await page.reload();
    await page.waitForFunction(() => /indisponível/.test(document.querySelector('#ethics-preview')?.textContent || ''));
    assert.equal(await page.getByRole('link', { name: 'Ler Código de Ética', exact: true }).count(), 0);
    await page.screenshot({ path: join(output, 'dashboard-unavailable-390.png'), fullPage: true });
    mode = 'hold';
    await page.reload();
    await pending;
    await page.locator('#quick-links a[href$="knowledge.html"]').click();
    await page.locator('.article-card-ethics').waitFor();
    release();
    await page.waitForFunction(() => document.querySelector('.article-card-ethics') !== null);
    assert.equal(await page.locator('#ethics-preview').count(), 0);
    assert.equal(await page.locator('.article-card').count(), 2);
    await checkLayout(page, 'Knowledge overflow');
    await page.locator('#search').fill('Uniformes');
    await page.waitForFunction(() => document.querySelectorAll('.article-card').length === 1
      && !document.querySelector('.article-card-ethics'));
    results.push({ errorIsolation: true, retryKeyboardFocus: true, wrongDescriptorUnavailable: true,
      pendingNavigation: true, categorySearchRespected: true });
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'results.json'), JSON.stringify({ results, errors,
    limits: 'Chrome emulated viewports; synthetic Firebase profiles, notifications and Academy data; real Knowledge SQL/API and UI. BFCache uses persisted pageshow simulation.' }, null, 2));
  console.log(`Portal welcome browser: ${results.length} scenarios PASS; ${output}`);
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({ error: error.message, results, errors }, null, 2));
  for (const [index, page] of (browser?.contexts().flatMap(context => context.pages()) || []).entries()) {
    await page.screenshot({ path: join(output, `failure-${index}.png`), fullPage: true }).catch(() => {});
    await writeFile(join(output, `failure-${index}.txt`), await page.locator('body').innerText().catch(() => ''));
  }
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await h.close();
}
