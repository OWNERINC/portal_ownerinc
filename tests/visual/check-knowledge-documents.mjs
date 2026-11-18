// Real Knowledge UI, API, middleware and PostgreSQL-WASM; synthetic Firebase identities.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { knowledgeDocumentAPI } from '../helpers/knowledge-document-api.mjs';

for (const name of ['KNOWLEDGE_PACKAGE', 'PLAYWRIGHT_MODULE_PATH', 'KNOWLEDGE_VISUAL_OUTPUT']) {
  if (!process.env[name]) throw new Error(`Set ${name}`);
}
const root = resolve(process.env.KNOWLEDGE_PACKAGE), output = resolve(process.env.KNOWLEDGE_VISUAL_OUTPUT);
await mkdir(output);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { importDocuments } = require('./knowledge/import');
const { articles } = JSON.parse(await readFile(join(root, 'import.json'), 'utf8'));
const provenance = JSON.parse(await readFile('tests/fixtures/ethics-official-provenance.json', 'utf8'));
const h = await knowledgeDocumentAPI({ uploadDir: root });
await importDocuments({ pool: h.pool, uploadDir: root, articles, batch: 'visual-knowledge', apply: true });
// Mirror Nginx: only API/uploads reach Express and its real rate limiter.
// Serving frontend assets through the API would exhaust its budget artificially.
const express = require('express');
const site = express();
site.use((req, res, next) => /^\/(?:api|uploads)(?:\/|$)/.test(req.path) ? h.app(req, res, next) : next());
site.use(express.static(fileURLToPath(new URL('../../public/', import.meta.url))));
const server = createServer(site);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const errors = [], results = [];
const responses = [];
let browser;
async function contextFor(width) {
  const context = await browser.newContext({ viewport: { width, height: 850 }, reducedMotion: 'reduce' });
  await context.route('**/js/firebase-config.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    export const auth = { currentUser: { uid: 'reader', getIdToken: async () => 'reader' }, authStateReady: async () => {},
      app: { name: '[DEFAULT]', options: { apiKey: 'fixture' } } };
  ` }));
  await context.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({
    contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: `
      export function onAuthStateChanged(auth, callback) { queueMicrotask(() => callback(auth.currentUser)); return () => {}; }
      export async function signOut() {}
      export async function updateProfile() {}
    `,
  }));
  await context.addInitScript(() => {
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    globalThis.__liveBlobs = new Set();
    URL.createObjectURL = blob => { const url = create(blob); __liveBlobs.add(url); return url; };
    URL.revokeObjectURL = url => { __liveBlobs.delete(url); return revoke(url); };
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === origin) responses.push({ path: url.pathname, status: response.status() });
  });
  return { context, page };
}
async function catalog(page) {
  await page.goto(`${origin}/knowledge.html`);
  await page.locator('.article-card').nth(8).waitFor();
  assert.equal(await page.locator('.article-card').count(), 9);
  assert.equal(await page.locator('.article-document-cover').count(), 8);
  assert.equal(await page.locator('.article-ethics-cover').count(), 1);
  const institutional = page.locator('.article-card').first();
  assert.equal(await institutional.evaluate(node => node.classList.contains('article-card-ethics')), true);
  assert.equal(await institutional.locator('.card-title').textContent(), articles.find(article => article.document.kind === 'ethics').title);
  const cover = institutional.locator('.article-ethics-cover');
  assert.equal(await cover.getAttribute('alt'), '');
  assert.equal(await cover.getAttribute('src'), './assets/conecta/ethics-cover.svg');
  await readyImage(cover);
  assert.deepEqual(await cover.evaluate(node => [node.naturalWidth, node.naturalHeight]), [960, 540]);
  assert.ok(await cover.evaluate(node => Math.abs(node.clientWidth / node.clientHeight - 960 / 540) < .02), 'cover keeps its aspect ratio');
}
async function openArticle(page, article) {
  await page.getByRole('button', { name: new RegExp(article.title.replace(/[()]/g, '\\$&')) }).click();
  await page.waitForFunction(title => document.getElementById('article-title')?.textContent === title, article.title);
}
async function readyImage(image) {
  await image.scrollIntoViewIfNeeded();
  await image.page().waitForFunction(node => node.complete && node.naturalWidth > 0, await image.elementHandle());
  await image.evaluate(node => node.decode());
  await image.scrollIntoViewIfNeeded();
}
async function noOverflow(page, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, label);
}
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  for (const width of [320, 390, 1366]) {
    const { context, page } = await contextFor(width);
    await catalog(page);
    await readyImage(page.locator('.article-document-cover').first());
    await noOverflow(page, `${width}: catalog`);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(output, `catalog-${width}.png`), fullPage: true });
    const institutional = page.locator('.article-card-ethics');
    await institutional.focus();
    assert.equal(await institutional.evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
    await page.keyboard.press('Enter');
    await page.locator('.knowledge-ethics section').nth(26).waitFor({ state: 'attached' });
    await page.locator('#btn-back').click();
    await openArticle(page, articles[0]);
    const figures = page.locator('.knowledge-document-page');
    await figures.nth(67).waitFor({ state: 'attached' });
    assert.equal(await figures.count(), 68);
    const first = figures.first();
    await readyImage(first.locator('img'));
    await noOverflow(page, `${width}: PDF`);
    assert.ok(await page.locator('.knowledge-document-image[src]').count() < 12, 'lazy loading');
    await page.screenshot({ path: join(output, `reader-${width}.png`) });
    const enlarge = first.getByRole('button', { name: 'Ampliar página 1 de 68', exact: true });
    await enlarge.click();
    const dialog = page.locator('.knowledge-zoom');
    await dialog.waitFor();
    await readyImage(dialog.locator('img'));
    await dialog.getByRole('button', { name: 'Tamanho real', exact: true }).click();
    assert.equal(await dialog.locator('.knowledge-zoom-viewport').evaluate(node => node.scrollWidth > node.clientWidth), true);
    await page.screenshot({ path: join(output, `zoom-${width}.png`) });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(await enlarge.evaluate(node => document.activeElement === node), true);
    await first.locator('summary').click();
    assert.ok((await first.locator('details p').textContent()).length > 0);
    const oldBlobs = await page.evaluate(() => [...__liveBlobs]);
    await page.locator('#btn-back').click();
    assert.equal(await page.locator('.knowledge-document').count(), 0);
    assert.equal(await page.evaluate(old => old.some(url => __liveBlobs.has(url)), oldBlobs), false);
    await openArticle(page, articles[8]);
    await page.locator('.knowledge-ethics section').nth(26).waitFor({ state: 'attached' });
    const texts = await page.locator('.knowledge-ethics').evaluate(host => [...host.querySelectorAll('p,h2,li,th,td')]
      .map(node => node.textContent.trim().replace(/\s+/g, ' ')));
    assert.equal(texts.length, provenance.normalizedTextCount);
    assert.equal(createHash('sha256').update(JSON.stringify(texts)).digest('hex'), provenance.normalizedTextSha256);
    assert.equal(await page.locator('.knowledge-ethics table').count(), 3);
    await noOverflow(page, `${width}: ethics`);
    await page.screenshot({ path: join(output, `ethics-${width}.png`) });
    results.push({ width, catalog: 9, pdfCovers: 8, ethicsCovers: 1, ethicsFirst: true,
      ethicsKeyboard: true, pages: 68, zoom: true, keyboard: true, disposal: true, ethicsParity: true, overflow: false });
    await context.close();
  }
  {
    const { context, page } = await contextFor(1366);
    for (const article of articles.filter(a => a.document.kind === 'pdf')) {
      const manifest = JSON.parse(await readFile(join(root, 'knowledge-private', article.document.key, 'manifest.json'), 'utf8'));
      await page.goto(`${origin}/knowledge.html?article=${article.id}`);
      const figures = page.locator('.knowledge-document-page');
      await figures.nth(manifest.pages.length - 1).waitFor({ state: 'attached' });
      assert.equal(await figures.count(), manifest.pages.length);
      const sample = manifest.pages.reduce((a, b) => a.text.length > b.text.length ? a : b);
      const figure = figures.nth(sample.number - 1);
      await readyImage(figure.locator('img'));
      await figure.locator('summary').click();
      assert.equal(await figure.locator('details p').textContent(), sample.text);
      await figure.screenshot({ path: join(output, `${article.id}-page-${sample.number}.png`) });
      results.push({ title: article.title, pages: manifest.pages.length, textSample: sample.number });
    }
    await context.close();
  }
  {
    const { context, page } = await contextFor(390);
    const base = `/api/knowledge/${articles[0].id}/document`;
    let fail = true;
    await context.route(`**${base}/pages/1`, route => fail
      ? route.fulfill({ status: 503, json: { error: 'Fixture offline' } }) : route.continue());
    await page.goto(`${origin}/knowledge.html?article=${articles[0].id}`);
    const first = page.locator('.knowledge-document-page').first();
    const retry = first.getByRole('button', { name: 'Tentar novamente' });
    await retry.waitFor();
    fail = false;
    await retry.click();
    await readyImage(first.locator('img'));
    // Navigate away while an authenticated image is still in flight.
    await page.locator('#btn-back').click();
    let release, started;
    const hold = new Promise(resolve => { release = resolve; });
    const pending = new Promise(resolve => { started = resolve; });
    await context.route(`**${base}/pages/1`, async route => {
      started(); await hold;
      await route.continue().catch(() => {});
    });
    await openArticle(page, articles[0]);
    await pending;
    await page.locator('#btn-back').click();
    release();
    await openArticle(page, articles[8]);
    await page.locator('.knowledge-ethics section').nth(26).waitFor({ state: 'attached' });
    assert.equal(await page.locator('.knowledge-document-page').count(), 0);
    await context.close();
    results.push({ retry: true, lateResponseNavigation: true });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(responses.filter(response => response.status === 429), [], 'real API rate limit');
  await writeFile(join(output, 'results.json'), JSON.stringify({ results, errors, responses,
    transport: 'PGlite and real UI/API/rate limiter; static assets outside API; synthetic Firebase' }, null, 2));
  console.log(`Knowledge browser: ${results.length} scenarios PASS; ${output}`);
} catch (error) {
  const pages = browser?.contexts().flatMap(context => context.pages()) || [];
  await writeFile(join(output, 'failure.json'), JSON.stringify({
    error: error.message, results, errors, responses,
    pages: await Promise.all(pages.map(async page => ({
      url: page.url(), text: await page.locator('body').innerText().catch(() => ''),
    }))),
  }, null, 2));
  for (const [index, page] of pages.entries()) {
    await page.screenshot({ path: join(output, `failure-${index}.png`) }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await h.close();
}
