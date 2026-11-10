// Loopback-only browser integration: real page, shared auth helpers, Express
// routes and middleware; Firebase identities and SQL transport are fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ethicsHarness, term } from '../helpers/ethics-api.mjs';

if (!process.env.PLAYWRIGHT_MODULE_PATH || !process.env.AXE_MODULE_PATH) throw new Error('Set external PLAYWRIGHT_MODULE_PATH and AXE_MODULE_PATH');
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const { default: AxeBuilder } = await import(pathToFileURL(resolve(process.env.AXE_MODULE_PATH)).href);
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express');
const { app, state } = await ethicsHarness();
app.get('/dashboard.html', (_req, res) => res.type('html').send('<!doctype html><html lang="pt-BR"><title>Portal fixture</title><main><h1>Portal liberado</h1></main></html>'));
app.get('/probe.html', (_req, res) => res.type('html').send(`<!doctype html><html lang="pt-BR"><title>Protected fixture</title><main></main><script type="module">
  import { requireAuth } from '/js/auth.js';
  const user = await requireAuth();
  if (user) document.querySelector('main').textContent = 'Área protegida: ' + user.uid;
</script></html>`));
app.use(express.static(fileURLToPath(new URL('../../public/', import.meta.url))));
const server = createServer(app);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const output = resolve(process.env.VISUAL_OUTPUT || join(tmpdir(), 'opencode', 'ethics-acceptance'));
await mkdir(output, { recursive: true });
let browser;
const results = [];
const errors = [];

async function contextFor(uid = 'viewer') {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  await context.route('**/js/firebase-config.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    const listeners = new Set();
    const account = uid => uid ? { uid, getIdToken: async () => uid } : null;
    const saved = sessionStorage.getItem('__fixtureUid');
    export const auth = { currentUser: account(saved === null ? ${JSON.stringify(uid)} : saved), app: { name: '[DEFAULT]', options: { apiKey: 'fixture' } }, authStateReady: async () => {} };
    globalThis.__fixtureAuth = auth;
    globalThis.__fixtureListeners = listeners;
    globalThis.__fixtureChangeUser = uid => { sessionStorage.setItem('__fixtureUid', uid || ''); auth.currentUser = account(uid); for (const listener of listeners) listener(auth.currentUser); };
  ` }));
  await context.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: `
    export function onAuthStateChanged(auth, callback) { globalThis.__fixtureListeners.add(callback); queueMicrotask(() => callback(auth.currentUser)); return () => globalThis.__fixtureListeners.delete(callback); }
    export async function signOut() { globalThis.__fixtureSignouts = (globalThis.__fixtureSignouts || 0) + 1; globalThis.__fixtureChangeUser(null); }
    export async function updateProfile() {}
    export async function signInWithEmailAndPassword() { globalThis.__fixtureChangeUser('viewer'); }
  ` }));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  return { context, page };
}
async function loaded(page) {
  await page.waitForURL(url => url.pathname === '/ethics.html');
  await page.locator('#ethics-content').waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
}
async function readAndCheck(page) {
  const checkbox = page.locator('#ethics-checkbox');
  const button = page.locator('#ethics-accept');
  assert.equal(await checkbox.isDisabled(), true);
  assert.equal(await button.isDisabled(), true);
  await page.locator('#ethics-reader').focus();
  await page.keyboard.press('Control+End');
  await page.waitForFunction(() => !document.getElementById('ethics-checkbox').disabled);
  assert.equal(await button.isDisabled(), true);
  await page.keyboard.press('Tab');
  assert.equal(await checkbox.evaluate(node => document.activeElement === node), true);
  await page.keyboard.press('Space');
  assert.equal(await checkbox.isChecked(), true);
  assert.equal(await button.isDisabled(), false);
}
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome', ignoreDefaultArgs: ['--disable-back-forward-cache'] });
  // Login and direct loads exercise the same gate for all existing roles.
  for (const uid of ['viewer', 'admin', 'super']) {
    state.acceptances.clear();
    const { context, page } = await contextFor(uid);
    await page.goto(`${origin}/login.html?next=${encodeURIComponent('/probe.html?tab=1#content')}`);
    await loaded(page);
    assert.equal(new URL(page.url()).searchParams.get('next'), '/probe.html?tab=1#content');
    assert.equal(await page.locator('#ethics-checkbox').isDisabled(), true);
    assert.equal(await page.evaluate(() => __fixtureAuth.currentUser.uid), uid);
    await page.goto(`${origin}/probe.html?tab=1#content`);
    await loaded(page);
    await readAndCheck(page);
    await page.locator('#ethics-accept').click();
    await page.waitForURL(url => url.pathname === '/probe.html' && url.search === '?tab=1' && url.hash === '#content');
    await page.waitForFunction(() => document.querySelector('main').textContent.startsWith('Área protegida:'));
    assert.equal(state.acceptances.size, 1);
    // The server owns the saved choice, including on another browser context.
    const second = await contextFor(uid);
    await second.page.goto(`${origin}/ethics.html?next=/probe.html`);
    await second.page.waitForURL(url => url.pathname === '/probe.html');
    await second.page.waitForFunction(() => document.querySelector('main').textContent.startsWith('Área protegida:'));
    await second.context.close();
    // Any protected API denial must also move back to the term, not to logout.
    state.acceptances.clear();
    await page.evaluate(async () => {
      const { fetchAPI } = await import('/js/auth.js');
      await fetchAPI('/api/protected').catch(() => {});
    });
    await loaded(page);
    assert.equal(await page.evaluate(() => __fixtureAuth.currentUser.uid), uid);
    results.push({ scenario: 'login/direct/API gate, acceptance and second browser', uid, pass: true });
    await context.close();
  }
  for (const width of [320, 360, 402, 768, 1366, 1920]) {
    state.acceptances.clear();
    const { context, page } = await contextFor();
    await page.setViewportSize({ width, height: width > 1000 ? 768 : 740 });
    await page.goto(`${origin}/ethics.html`);
    await loaded(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${width}: overflow`);
    const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    assert.deepEqual(audit.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), [], `${width}: accessibility`);
    assert.match(await page.locator('#ethics-notice').textContent(), /demonstração/);
    await page.screenshot({ path: join(output, `ethics-${width}.png`), fullPage: true });
    await readAndCheck(page);
    await page.locator('#ethics-checkbox').uncheck();
    assert.equal(await page.locator('#ethics-accept').isDisabled(), true);
    results.push({ scenario: 'reflow, keyboard and WCAG A/AA', width, violations: 0, pass: true });
    await context.close();
  }
  {
    state.acceptances.clear();
    const { context, page } = await contextFor();
    let failRead = true;
    await context.route('**/api/ethics', route => failRead ? route.fulfill({ status: 503, json: { error: 'Fixture failure' } }) : route.continue());
    await page.goto(`${origin}/ethics.html?next=/probe.html`);
    await page.locator('#ethics-retry').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#ethics-content').isVisible(), false);
    failRead = false;
    await page.locator('#ethics-retry').click();
    await loaded(page);
    await readAndCheck(page);
    let failSave = true;
    await context.route('**/api/ethics/accept', route => failSave ? route.fulfill({ status: 503, json: { error: 'Fixture failure' } }) : route.continue());
    await page.locator('#ethics-accept').click();
    await page.waitForFunction(() => document.getElementById('ethics-error').textContent.includes('Não foi possível confirmar'));
    assert.equal(state.acceptances.size, 0);
    assert.equal(await page.locator('#ethics-checkbox').isChecked(), true);
    assert.equal(await page.locator('#ethics-accept').isDisabled(), false);
    failSave = false;
    await page.locator('#ethics-accept').click();
    await page.waitForURL(url => url.pathname === '/probe.html');
    assert.equal(state.acceptances.size, 1);
    results.push({ scenario: 'load and save failures, explicit retry', pass: true });
    await context.close();
  }
  {
    state.acceptances.clear();
    const { context, page } = await contextFor();
    await page.goto(`${origin}/ethics.html`);
    await loaded(page);
    await readAndCheck(page);
    await context.route('**/api/ethics/accept', route => route.fulfill({ status: 409, json: { error: 'Changed', reason: 'ethics-version-changed' } }));
    await page.locator('#ethics-accept').click();
    await page.getByRole('button', { name: 'Carregar termo atualizado' }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('#ethics-accept').isDisabled(), true);
    await page.getByRole('button', { name: 'Carregar termo atualizado' }).click();
    await loaded(page);
    assert.equal(await page.locator('#ethics-checkbox').isChecked(), false);
    assert.equal(await page.locator('#ethics-checkbox').isDisabled(), true);
    assert.equal(state.acceptances.size, 0);
    await page.locator('#ethics-logout').click();
    await page.waitForURL(url => url.pathname === '/login.html');
    results.push({ scenario: 'version conflict resets reading/choice; logout without acceptance', pass: true });
    await context.close();
  }
  {
    state.acceptances.clear();
    const { context, page } = await contextFor();
    await page.goto(`${origin}/ethics.html?next=https://external.test/admin.html`);
    await loaded(page);
    await readAndCheck(page);
    let release;
    const wait = new Promise(resolve => { release = resolve; });
    let started;
    const submitted = new Promise(resolve => { started = resolve; });
    await context.route('**/api/ethics/accept', async route => {
      started();
      await wait;
      await route.fulfill({ json: { accepted: true, version: term.version, contentHash: term.contentHash } });
    });
    await page.locator('#ethics-accept').click();
    await submitted;
    assert.equal(await page.locator('#ethics-accept').isDisabled(), true);
    await page.evaluate(() => __fixtureChangeUser('super'));
    release();
    await page.waitForFunction(() => globalThis.__fixtureAuth?.currentUser?.uid === 'super' && document.getElementById('ethics-content')?.hidden === false);
    await loaded(page);
    assert.equal(await page.evaluate(() => __fixtureAuth.currentUser.uid), 'super');
    assert.equal(state.acceptances.size, 0);
    assert.equal(await page.locator('#ethics-checkbox').isDisabled(), true);
    assert.equal(new URL(page.url()).origin, origin);
    results.push({ scenario: 'account switch fences late save and unsafe return URL', pass: true });
    await context.close();
  }
  {
    state.acceptances.clear();
    const { context, page } = await contextFor();
    await page.goto(`${origin}/ethics.html`);
    await loaded(page);
    // A real history return, followed by a deterministic persisted-pageshow
    // dispatch, covers both browser cache policies and the BFCache callback.
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.href = '/dashboard.html';
      link.textContent = 'History test navigation';
      document.body.append(link);
      link.click();
    });
    await page.waitForURL(url => url.pathname === '/dashboard.html');
    await page.goBack();
    await loaded(page);
    assert.equal(await page.locator('#ethics-checkbox').isDisabled(), true);
    const fresh = page.waitForResponse(response => new URL(response.url()).pathname === '/api/ethics');
    await page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    });
    await fresh;
    await loaded(page);
    await readAndCheck(page);
    assert.equal(state.acceptances.size, 0);
    results.push({ scenario: 'history and BFCache restore revalidate and restore functional reading', pass: true });
    await context.close();
  }
  assert.deepEqual(errors, [], 'browser runtime errors');
  await writeFile(join(output, 'results.json'), JSON.stringify({ results, errors, transport: 'mock PostgreSQL and Firebase; real UI/API' }, null, 2));
  console.log(`Ethics browser integration: ${results.length} scenarios passed; artifacts: ${output}`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
