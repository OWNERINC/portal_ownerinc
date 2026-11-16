// Chrome + real Pages API/serialized PGlite. Only identity and static Nginx
// shell routing are simulated; no existing services or external requests.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPagesDatabaseHarness, pageDocument, cargoA } from '../database/check-pages.mjs';
import { pagesBrowserContext, pagesBrowserReady, pagesEditorPreview } from '../helpers/pages-browser.mjs';

for (const key of ['PGLITE_MODULE_PATH', 'PLAYWRIGHT_MODULE_PATH']) if (!process.env[key]) throw new Error(`Set external ${key}`);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express');
const publicRoot = fileURLToPath(new URL('../../public/', import.meta.url));
const output = resolve(process.env.FRIENDLY_VISUAL_OUTPUT || join(tmpdir(), 'opencode', 'pages-friendly-route'));
await mkdir(output, { recursive: true });
const h = await createPagesDatabaseHarness();
const results = [], errors = [], assetFailures = [], blocked = [];
let browser;
// Use the actual acceptance route/SQL with the existing synthetic auth boundary.
const ethicsFile = new URL('../../api/routes/ethics.js', import.meta.url);
const ethicsRequire = createRequire(ethicsFile), ethicsModule = { exports: {} };
new Function('require', 'module', 'exports', await readFile(ethicsFile, 'utf8'))(name => name === '../db' ? h.pool
  : name === '../middleware/auth' ? { authMiddleware: h.authenticate } : ethicsRequire(name), ethicsModule, ethicsModule.exports);
h.app.use('/api/ethics', ethicsModule.exports);
// Simulation of the limited static-shell rule, NOT evidence of native nginx -t.
h.app.get(/^\/conteudos\/[a-z0-9]+(-[a-z0-9]+)*$/, (_req, res) => res.sendFile(join(publicRoot, 'pages.html')));
h.app.use('/conteudos/', (_req, res) => res.sendStatus(404));
h.app.use(express.static(publicRoot));

async function api(method, path, body, actor = 'author') {
  const response = await h.api(method, path, body, actor);
  assert.ok(response.status >= 200 && response.status < 300, `${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}
async function visit(uid) {
  const visit = await pagesBrowserContext(browser, { uid, errors });
  const { context, page } = visit;
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === h.origin || url.hostname === 'www.gstatic.com') return route.fallback();
    blocked.push(url.href); return route.abort('blockedbyclient');
  });
  // Persist synthetic identity through full-document login/Ethics redirects.
  await context.route('**/js/firebase-config.js', route => route.fulfill({ contentType: 'text/javascript', body: `
    const listeners = new Set(), account = uid => uid ? { uid, getIdToken: async () => uid } : null;
    const saved = sessionStorage.getItem('__friendlyUid');
    export const auth = { currentUser: account(saved === null ? ${JSON.stringify(uid)} : saved), app: { name: '[DEFAULT]', options: { apiKey: 'fixture' } }, authStateReady: async () => {} };
    globalThis.__fixtureAuth = auth; globalThis.__fixtureListeners = listeners;
    globalThis.__fixtureChangeUser = uid => { sessionStorage.setItem('__friendlyUid', uid || ''); auth.currentUser = account(uid); for (const listener of listeners) listener(auth.currentUser); };
  ` }));
  await context.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: `
    export function onAuthStateChanged(auth, callback) { globalThis.__fixtureListeners.add(callback); queueMicrotask(() => callback(auth.currentUser)); return () => globalThis.__fixtureListeners.delete(callback); }
    export async function signOut() { globalThis.__fixtureChangeUser(null); }
    export async function updateProfile() {}
    export async function signInWithEmailAndPassword(_auth, email) { globalThis.__fixtureChangeUser(email.split('@')[0]); }
  ` }));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === h.origin && /\.(?:js|css|svg|woff2?|ttf)$/.test(url.pathname) && response.status() !== 200) assetFailures.push({ url: url.pathname, status: response.status() });
  });
  return visit;
}
async function read(page, title = 'Código de vestimenta sintético') {
  await pagesBrowserReady(page);
  await page.locator('.pages-document h1').filter({ hasText: title }).waitFor({ state: 'visible' });
}
async function spaLink(page, href, text = 'Destino sintético') {
  await page.evaluate(({ href, text }) => { const a = document.createElement('a'); a.href = href; a.textContent = text; document.querySelector('main').append(a); }, { href, text });
  await page.getByRole('link', { name: text, exact: true }).click();
}
async function markShell(page) {
  await page.evaluate(() => { globalThis.__friendlyDocument = document; globalThis.__friendlySidebar = document.querySelector('.sidebar'); });
}
async function sameShell(page) {
  assert.equal(await page.evaluate(() => document === globalThis.__friendlyDocument && document.querySelector('.sidebar') === globalThis.__friendlySidebar), true);
  assert.equal(await page.locator('.sidebar-nav a[title="Dashboard"]').evaluate(a => new URL(a.href).pathname), '/dashboard.html');
  assert.equal(await page.locator('.sidebar-brand img').first().evaluate(img => img.complete && img.naturalWidth > 0), true);
}
try {
  const created = await api('post', '', { template_id: 'comunicado', client_mutation_id: randomUUID() });
  let workspace = await api('get', `/${created.id}/workspace`);
  const document = pageDocument('Código de vestimenta sintético');
  document.schema_version = 2; document.template.version = 2;
  document.sections[0].rows[0].columns[0].blocks.push({ id: randomUUID(), type: 'button', label: 'Ver seção sintética', preset: 'primary',
    destination: { type: 'section', value: document.sections[0].id } });
  await api('put', `/${created.id}/draft`, { expected_version: workspace.version, document, client_mutation_id: randomUUID() });
  workspace = await api('get', `/${created.id}/workspace`);
  await api('post', `/${created.id}/publish`, { expected_version: workspace.version, revision_id: workspace.draft_revision_id, client_mutation_id: randomUUID() }, 'publisher');
  const slug = workspace.slug;
  assert.ok(slug, 'use the persisted slug, never guess from title');
  const path = `/conteudos/${slug}`, hash = `#section-${document.sections[0].id}`;
  // Existing fixture actors remain synthetic; no new production auth hooks.
  await h.db.query('UPDATE users SET job_title_id = NULL WHERE uid = $1', ['forged']);
  const inactiveCargo = randomUUID();
  await h.db.query('INSERT INTO job_titles(id,name,active) VALUES($1,$2,FALSE)', [inactiveCargo, 'Cargo sintético inativo']);
  await h.db.query('UPDATE users SET job_title_id = $1 WHERE uid = $2', [inactiveCargo, 'other']);
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });

  // Direct visit is deliberately first, before any SPA navigation.
  {
    const { context, page } = await visit('reader');
    const response = await page.goto(`${h.origin}${path}?from=direct${hash}`);
    assert.equal(response.status(), 200); await read(page);
    assert.equal(new URL(page.url()).hash, hash);
    assert.equal(await page.locator('.sidebar-nav a[title="Pages"]').getAttribute('aria-current'), 'page');
    await page.reload(); await read(page);
    assert.equal(await page.locator(`[id="${hash.slice(1)}"]`).count(), 1, 'deep section exists after refresh');
    await page.evaluate(() => { globalThis.__friendlyArticle = document.querySelector('.pages-document'); });
    let reads = 0;
    const onRead = request => { if (new URL(request.url()).pathname === `/api/pages/by-slug/${slug}`) reads++; };
    page.on('request', onRead);
    await spaLink(page, '#main-content', 'Fragmento sintético');
    await page.waitForURL(url => url.hash === '#main-content');
    await page.waitForFunction(() => document.activeElement?.id === 'main-content');
    await page.goBack(); await page.waitForURL(url => url.hash === hash);
    assert.equal(await page.evaluate(() => document.querySelector('.pages-document') === globalThis.__friendlyArticle), true, 'same-alias fragments retain the mounted article');
    assert.equal(reads, 0, 'hash/back does not refetch the publication'); page.off('request', onRead);
    await markShell(page);
    await page.locator('.sidebar-nav a[title="Dashboard"]').click();
    await page.waitForURL(url => url.pathname === '/dashboard.html'); await pagesBrowserReady(page);
    assert.equal(new URL(page.url()).pathname, '/dashboard.html'); await sameShell(page);
    await page.goBack(); await read(page); await sameShell(page);
    await page.goForward(); await page.waitForURL(url => url.pathname === '/dashboard.html'); await pagesBrowserReady(page); await sameShell(page);
    results.push({ scenario: 'direct authenticated + refresh/hash + sidebar/back/forward in one shell', pass: true });
    await context.close();
  }
  {
    // Real shell/router + actual production section button. Unlike a standalone
    // component page, this detects duplicate portalNavigation indices/stale URL.
    const { context, page } = await visit('author');
    await page.goto(`${h.origin}/dashboard.html`); await pagesBrowserReady(page); await markShell(page);
    await spaLink(page, path); await read(page);
    const pageIndex = await page.evaluate(() => history.state.portalNavigation);
    await page.evaluate(() => { globalThis.__friendlyArticle = document.querySelector('.pages-document'); });
    await page.getByRole('link', { name: 'Ver seção sintética', exact: true }).click();
    await page.waitForURL(url => url.pathname === path && url.hash === hash);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => history.state.portalNavigation), pageIndex + 1, 'section entries must belong to the shell history, not copy its old index');
    assert.equal(await page.evaluate(() => document.querySelector('.pages-document') === globalThis.__friendlyArticle), true);
    await page.waitForFunction(id => document.activeElement?.id === id, hash.slice(1));
    await page.locator('.sidebar-nav a[title="Meu Perfil"]').click();
    await page.waitForURL(url => url.pathname === '/profile.html'); await page.locator('#p-bio').waitFor(); await sameShell(page);
    assert.equal(await page.evaluate(() => history.state.portalNavigation), pageIndex + 2);
    // Jump over the section entry, then restore it and the other area in order.
    await page.evaluate(() => history.go(-2)); await page.waitForURL(url => url.pathname === path && !url.hash); await read(page);
    assert.equal(await page.evaluate(() => history.state.portalNavigation), pageIndex);
    await page.goForward(); await page.waitForURL(url => url.pathname === path && url.hash === hash);
    await page.waitForFunction(id => document.activeElement?.id === id, hash.slice(1));
    assert.equal(await page.evaluate(() => history.state.portalNavigation), pageIndex + 1);
    await page.goForward(); await page.waitForURL(url => url.pathname === '/profile.html'); await page.locator('#p-bio').waitFor();
    const marker = 'DIRTY-PROFILE-AFTER-SECTION'; await page.locator('#p-bio').fill(marker);
    await page.evaluate(() => { globalThis.__friendlyProfileField = document.getElementById('p-bio'); });
    let dialogs = 0, accept = false;
    const onDialog = dialog => { dialogs++; void (accept ? dialog.accept() : dialog.dismiss()); };
    page.on('dialog', onDialog);
    const declined = page.waitForEvent('dialog'); await page.evaluate(() => history.go(-2)); await declined;
    await page.waitForURL(url => url.pathname === '/profile.html');
    assert.equal(await page.evaluate(() => history.state.portalNavigation), pageIndex + 2);
    assert.equal(await page.locator('#p-bio').inputValue(), marker);
    assert.equal(await page.locator('#p-bio').evaluate(node => node === globalThis.__friendlyProfileField), true);
    assert.equal(dialogs, 1, 'declined traversal keeps the originating dirty profile and exact URL/index');
    accept = true; await page.evaluate(() => history.go(-2));
    await page.waitForURL(url => url.pathname === path && !url.hash); await read(page); await sameShell(page);
    await page.goForward(); await page.waitForURL(url => url.pathname === path && url.hash === hash);
    await page.goForward(); await page.waitForURL(url => url.pathname === '/profile.html'); await page.locator('#p-bio').waitFor();
    assert.equal(await page.locator('#p-bio').inputValue(), '', 'accepted traversal discarded only the dirty profile, not the history destination');
    page.off('dialog', onDialog);
    results.push({ scenario: 'real section button→profile: distinct shell indices, multi-Back/Forward, declined/accepted dirty traversal and focus restoration', pass: true });
    await context.close();
  }
  {
    const { context, page } = await visit('author');
    const revisionPreview = `/pages.html?id=${created.id}&preview=1&revision_id=${workspace.draft_revision_id}`;
    await page.goto(`${h.origin}${revisionPreview}`); await read(page);
    const before = await page.evaluate(() => ({ url: location.href, length: history.length, index: history.state.portalNavigation }));
    await page.getByRole('link', { name: 'Ver seção sintética', exact: true }).click();
    await page.waitForFunction(id => document.activeElement?.id === id, hash.slice(1));
    assert.deepEqual(await page.evaluate(() => ({ url: location.href, length: history.length, index: history.state.portalNavigation })), before, 'authorized saved-revision preview is focus-only');
    await spaLink(page, `/page-editor.html?id=${created.id}`); await page.locator('.ProseMirror').first().waitFor();
    const rich = page.locator('.ProseMirror').first(); await rich.click(); await rich.press('Control+End'); await rich.pressSequentially(' DIRTY-STAGED-PREVIEW');
    await pagesEditorPreview(page,'desktop');
    const stagedBefore = await page.evaluate(() => ({ url: location.href, length: history.length, index: history.state.portalNavigation }));
    let dialogs = 0; const onDialog = dialog => { dialogs++; void dialog.dismiss(); }; page.on('dialog', onDialog);
    await page.getByRole('link', { name: 'Ver seção sintética', exact: true }).click();
    await page.waitForFunction(id => document.activeElement?.id === id, hash.slice(1));
    assert.deepEqual(await page.evaluate(() => ({ url: location.href, length: history.length, index: history.state.portalNavigation })), stagedBefore, 'staged editor preview is focus-only even when dirty');
    assert.equal(dialogs, 0); await pagesEditorPreview(page,'edit');
    assert.match(await rich.innerText(), /DIRTY-STAGED-PREVIEW/);
    page.off('dialog', onDialog);
    results.push({ scenario: 'actual shell saved-revision and dirty staged-editor section buttons focus only, no history/URL/guard change', pass: true });
    await context.close();
  }
  {
    const { context, page } = await visit('author');
    await page.goto(`${h.origin}/dashboard.html`); await pagesBrowserReady(page);
    assert.equal(await page.locator('base').count(), 0, 'starts with the real dashboard without a base tag');
    await markShell(page);
    let documents = 0; page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++; });
    await spaLink(page, `${path}${hash}`); await read(page); await sameShell(page);
    assert.equal(await page.locator('.sidebar-nav a[title="Pages"]').getAttribute('aria-current'), 'page');
    const resources = await page.evaluate(() => [...document.querySelectorAll('[src], svg use[href], link[href]')].map(n => n.getAttribute('src') || n.getAttribute('href')).filter(Boolean).map(value => new URL(value, document.baseURI).pathname));
    assert.equal(resources.some(value => value.startsWith('/conteudos/')), false, 'relative shell assets resolve at root even when arriving from dashboard');
    await spaLink(page, `/page-editor.html?id=${created.id}`); await page.locator('.ProseMirror').first().waitFor({ state: 'visible' });
    await sameShell(page);
    await page.getByRole('link', { name: 'Voltar à gestão de Pages', exact: true }).click();
    await page.getByRole('heading', { name: 'Gerenciar Pages', exact: true }).waitFor({ state: 'visible' });
    await page.goBack(); await page.locator('.ProseMirror').first().waitFor({ state: 'visible' });
    await page.goBack(); await read(page); await sameShell(page);
    await page.getByRole('link', { name: 'Voltar às Pages', exact: true }).click();
    await page.getByRole('heading', { name: 'Pages', exact: true }).waitFor({ state: 'visible' });
    const catalogRead = page.getByRole('link', { name: 'Código de vestimenta sintético', exact: true });
    assert.match(await catalogRead.getAttribute('href'), /^\/pages\.html\?id=/, 'current list DTO has no alias; retain the UUID fallback, root-relative');
    await catalogRead.click(); await read(page); await sameShell(page);
    assert.equal(documents, 0, 'SPA visits never fetch a new document');
    results.push({ scenario: 'dashboard without base → alias → editor/catalog + Back + root assets, no document navigation', pass: true });
    await context.close();
  }
  {
    const { context, page } = await visit('author');
    await page.goto(`${h.origin}/dashboard.html`); await pagesBrowserReady(page);
    await markShell(page);
    await spaLink(page, path); await read(page);
    await spaLink(page, `/page-editor.html?id=${created.id}`);
    const rich = page.locator('.ProseMirror').first(); await rich.waitFor({ state: 'visible' });
    await rich.evaluate(node => { globalThis.__friendlyDirtyEditor = node; });
    const marker = ' FRAGMENTO-DIRTY-SINTÉTICO';
    await rich.click(); await rich.press('Control+End'); await rich.pressSequentially(marker);
    await page.locator('#page-editor-root[data-save-state="dirty"]').waitFor({ state: 'visible' });
    let confirmations = 0, workspaceLoads = 0;
    page.on('dialog', dialog => { confirmations++; void dialog.dismiss(); });
    page.on('request', request => { if (new URL(request.url()).pathname === `/api/pages/${created.id}/workspace`) workspaceLoads++; });
    await page.locator('a.skip-link').focus(); await page.keyboard.press('Enter');
    await page.waitForURL(url => url.pathname === '/page-editor.html' && url.hash === '#main-content', { timeout: 3000 });
    await page.waitForFunction(() => document.activeElement?.id === 'main-content', null, { timeout: 3000 });
    assert.equal(confirmations, 0, 'dirty skip link must not ask to discard');
    assert.match(await rich.innerText(), /FRAGMENTO-DIRTY-SINTÉTICO/);
    assert.equal(await rich.evaluate(node => node === globalThis.__friendlyDirtyEditor), true);
    const declinedLeave = page.waitForEvent('dialog');
    await spaLink(page, '/dashboard.html', 'Saída real sintética'); await declinedLeave;
    assert.equal(confirmations, 1, 'a real page change still asks before discarding dirty state');
    assert.equal(new URL(page.url()).pathname, '/page-editor.html');

    let release, entered;
    const held = new Promise(done => { release = done; }), started = new Promise(done => { entered = done; });
    await context.route(`**/api/pages/${created.id}/draft`, async route => { entered(); await held; await route.continue().catch(() => {}); }, { times: 1 });
    const saved = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/pages/${created.id}/draft`);
    try {
      await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click(); await started;
      await page.locator('#page-editor-root[data-save-state="saving"]').waitFor({ state: 'visible' });
      await page.locator('a.skip-link').focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement?.id === 'main-content', null, { timeout: 3000 });
      assert.equal(new URL(page.url()).hash, '#main-content');
      assert.equal(await page.locator('#page-editor-root').getAttribute('data-save-state'), 'saving', 'focus works before releasing the real save');
      await page.getByRole('link', { name: 'Saída real sintética', exact: true }).click();
      await page.waitForFunction(() => document.getElementById('toast')?.textContent.includes('Aguarde'));
      assert.equal(new URL(page.url()).pathname, '/page-editor.html', 'real navigation stays blocked during save');
      assert.equal(confirmations, 1); assert.equal(workspaceLoads, 0);
      assert.equal(await rich.evaluate(node => node === globalThis.__friendlyDirtyEditor), true); await sameShell(page);
    } finally { release(); }
    assert.equal((await saved).status(), 200);
    await page.locator('#page-editor-root[data-save-state="saved"]').waitFor({ state: 'visible' });
    const persisted = await api('get', `/${created.id}/workspace`);
    assert.match(JSON.stringify(persisted.draft.document), /FRAGMENTO-DIRTY-SINTÉTICO/, 'the original pending mutation still commits to its own draft');
    results.push({ scenario: 'dashboard→alias→dirty/busy editor: skip-link focus without discard/remount, real leave still guarded, held save commits', pass: true });
    await context.close();
  }
  for (const uid of ['outsider', 'super', 'forged', 'other']) {
    const { context, page } = await visit(uid);
    const response = await page.goto(`${h.origin}${path}`); assert.equal(response.status(), 200);
    await page.locator('#pages-root [role="alert"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.pages-document').count(), 0);
    assert.equal((await h.api('get', `/by-slug/${slug}`, undefined, uid)).status, 404);
    results.push({ scenario: 'ineligible account receives uniform API404, no private DOM', uid, pass: true });
    await context.close();
  }
  {
    const { context, page } = await visit('reader');
    let fail = true;
    await context.route(`**/api/pages/by-slug/${slug}`, route => fail ? route.fulfill({ status: 503, json: { error: 'Falha sintética' } }) : route.continue());
    await page.goto(`${h.origin}${path}`); await page.locator('#pages-root [role="alert"]').waitFor({ state: 'visible' });
    fail = false; await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await read(page);
    await page.goto(`${h.origin}/conteudos/alias-inexistente`); await page.locator('#pages-root [role="alert"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.pages-document').count(), 0);
    for (const invalid of ['/conteudos/a/b', '/conteudos/%2fadmin', '/conteudos/UPPER', '/conteudos/a/']) assert.equal((await page.goto(`${h.origin}${invalid}`)).status(), 404, invalid);
    results.push({ scenario: 'API failure/retry + missing alias + invalid paths HTTP404 (static simulation)', pass: true });
    await context.close();
  }
  {
    const { context, page } = await visit(null);
    const destination = `${path}?from=login${hash}`;
    await page.goto(`${h.origin}${destination}`);
    await page.waitForURL(url => url.pathname === '/login.html');
    assert.equal(new URL(page.url()).searchParams.get('next'), destination);
    await page.locator('#email').fill('noethics@example.test'); await page.locator('#password').fill('synthetic-only');
    await page.locator('#submit-btn').click();
    await page.waitForURL(url => url.pathname === '/ethics.html');
    await page.locator('#ethics-content').waitFor({ state: 'visible' });
    assert.equal(new URL(page.url()).searchParams.get('next'), destination);
    assert.equal(await page.locator('#ethics-checkbox').isDisabled(), true);
    await page.locator('#ethics-reader').focus(); await page.keyboard.press('Control+End');
    await page.waitForFunction(() => !document.getElementById('ethics-checkbox').disabled);
    await page.locator('#ethics-checkbox').check(); await page.locator('#ethics-accept').click();
    await page.waitForURL(url => url.pathname === path && url.hash === hash); await read(page);
    assert.equal((await h.db.query('SELECT count(*)::int AS count FROM ethics_acceptances WHERE user_uid = $1', ['noethics'])).rows[0].count, 1);
    results.push({ scenario: 'anonymous direct → actual login form → actual Ethics read/choice/SQL → original alias/query/hash', pass: true });
    await context.close();
  }
  {
    await h.db.query('DELETE FROM ethics_acceptances WHERE user_uid = $1', ['noethics']);
    const { context, page } = await visit('noethics');
    await page.goto(`${h.origin}${path}${hash}`); await page.waitForURL(url => url.pathname === '/ethics.html');
    assert.equal(new URL(page.url()).searchParams.get('next'), `${path}${hash}`);
    assert.equal(await page.locator('.pages-document').count(), 0);
    results.push({ scenario: 'signed-in direct alias still requires Ethics', pass: true });
    await context.close();
  }
  {
    const { context, page } = await visit('reader');
    await page.goto(`${h.origin}${path}`); await read(page);
    let release; const pending = new Promise(resolve => { release = resolve; });
    await context.route(`**/api/pages/by-slug/${slug}`, async route => { await pending; await route.fulfill({ status: 200, json: { document, id: created.id } }).catch(() => {}); }, { times: 1 });
    await spaLink(page, '/pages.html'); await page.waitForURL(url => url.pathname === '/pages.html'); await pagesBrowserReady(page);
    const request = page.waitForRequest(`**/api/pages/by-slug/${slug}`);
    await spaLink(page, path); await request;
    await page.evaluate(() => __fixtureChangeUser('outsider'));
    release(); await page.waitForURL(url => url.pathname === '/login.html');
    await page.waitForURL(url => url.pathname === path);
    await page.locator('#pages-root [role="alert"]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.pages-document').count(), 0);
    results.push({ scenario: 'account change during pending alias read purges old DOM and reauthorizes new account', pass: true });
    await context.close();
  }
  for (const uid of ['disabled', 'unverified']) {
    const { context, page } = await visit(uid);
    await page.goto(`${h.origin}${path}`); await page.waitForURL(url => url.pathname === '/login.html');
    assert.equal(await page.locator('.pages-document').count(), 0);
    assert.equal(new URL(page.url()).searchParams.get('next'), path);
    results.push({ scenario: 'existing account denial retained', uid, pass: true }); await context.close();
  }
  assert.deepEqual(errors, [], 'browser runtime errors');
  assert.deepEqual(assetFailures, [], 'all requested local script/style/image/font assets must be 200');
  await writeFile(join(output, 'results.json'), JSON.stringify({ results, errors, assetFailures, blocked, evidence: 'Real Chrome/Pages API/serialized PGlite + synthetic Firebase. Static alias server simulates Nginx; native nginx -t remains a separate gate.' }, null, 2));
  console.log(`Pages friendly route PASS: ${results.length} scenarios; zero JS/asset errors; artifacts: ${output}`);
} catch (error) {
  const pages = await Promise.all((browser?.contexts().flatMap(context => context.pages()) || []).filter(page => !page.isClosed()).map(async page => ({ url: page.url(), state: await page.evaluate(() => ({ active: document.activeElement?.outerHTML, base: document.baseURI, sections: [...document.querySelectorAll('.pages-document section')].map(n => n.id) })).catch(() => null) })));
  await writeFile(join(output, 'failure.json'), JSON.stringify({ results, errors, assetFailures, blocked, pages, error: error.stack }, null, 2));
  for (const [index, page] of (browser?.contexts().flatMap(context => context.pages()) || []).entries()) if (!page.isClosed()) await page.screenshot({ path: join(output, `failure-${index}.png`), fullPage: true }).catch(() => {});
  throw error;
} finally { await browser?.close(); await h.close(); }
