// Real UI + shared auth + Pages API + ephemeral PostgreSQL and private files.
// Firebase identities are synthetic. No production services, credentials or data.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPagesDatabaseHarness, pageDocument } from '../database/check-pages.mjs';
import { pagesEditorPageProperties } from '../helpers/pages-browser.mjs';

for (const name of ['PLAYWRIGHT_MODULE_PATH', 'AXE_MODULE_PATH', 'PGLITE_MODULE_PATH']) {
  if (!process.env[name]) throw new Error(`Set external ${name}; no production environment is used`);
}
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const { default: AxeBuilder } = await import(pathToFileURL(resolve(process.env.AXE_MODULE_PATH)).href);
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express');
const sharp = require('sharp');
const h = await createPagesDatabaseHarness();
h.app.use(express.static(fileURLToPath(new URL('../../public/', import.meta.url))));
const output = resolve(process.env.VISUAL_OUTPUT || join(tmpdir(), 'opencode', 'pages-editor'));
await mkdir(output, { recursive: true });
const results = [];
const errors = [];
let browser;

async function api(method, path, body, actor = 'super') {
  const response = await h.api(method, path, body, actor);
  assert.ok(response.status >= 200 && response.status < 300, `${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}

async function contextFor(uid = 'super', width = 1366) {
  const context = await browser.newContext({ viewport: { width, height: width > 1000 ? 900 : 840 }, reducedMotion: 'reduce' });
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
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  return { context, page };
}

async function ready(page) {
  await page.waitForFunction(() => document.querySelector('main') && !document.querySelector('main').hasAttribute('data-route-pending'));
  await page.evaluate(() => document.fonts.ready);
}

async function reflow(page, label) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${label}: horizontal page overflow`);
  assert.equal(await page.locator('main h1').count(), 1, `${label}: exactly one h1`);
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  assert.deepEqual(audit.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })), [], `${label}: accessibility`);
}

async function titleInput(page) {
  await page.locator('.pages-v2-inspector').waitFor({ state: 'attached' });
  await pagesEditorPageProperties(page);
  const input = page.getByRole('textbox', { name: /Título|Nome da página/i }).first();
  await input.waitFor({ state: 'visible' });
  return input;
}

try {
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const created = await api('post', '', { template_id: 'comunicado', client_mutation_id: randomUUID() });
  const id = created.id;
  let workspace = await api('get', `/${id}/workspace`);
  const original = pageDocument('Comunicado publicado — teste sintético');
  original.sections[0].rows[0].columns[0].blocks[0].content.content[0].content[0].text += ' <img src=x onerror=alert(1)> permanece texto.';
  await api('put', `/${id}/draft`, { expected_version: workspace.version, client_mutation_id: randomUUID(), document: original });
  workspace = await api('get', `/${id}/workspace`);
  await api('post', `/${id}/publish`, { expected_version: workspace.version, client_mutation_id: randomUUID(), revision_id: workspace.draft_revision_id });

  const editor = await contextFor();
  await editor.page.goto(`${h.origin}/page-editor.html?id=${id}`);
  await ready(editor.page);
  const title = await titleInput(editor.page);
  assert.equal(await title.inputValue(), original.metadata.title);
  await editor.page.locator('.ProseMirror').first().waitFor({ state: 'visible' });
  const rich = editor.page.locator('.ProseMirror').first();
  await rich.click();
  await rich.press('Control+a');
  await editor.page.getByRole('button', { name: /Negrito/i }).click();
  assert.ok(await rich.locator('strong').count(), 'toolbar formats selected text visually');
  const imageBuffer = await sharp({ create: { width: 120, height: 80, channels: 3, background: '#2A275E' } }).png().toBuffer();
  const imageResponse = editor.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/pages/${id}/media`);
  await editor.page.getByLabel(/^Selecionar imagem estática/).setInputFiles({ name: 'imagem-sintetica.png', mimeType: 'image/png', buffer: imageBuffer });
  const uploadedImage = await imageResponse;
  assert.equal(uploadedImage.status(), 201, await uploadedImage.text());
  const alt = editor.page.getByRole('textbox', { name: /Texto alternativo/i });
  await alt.waitFor({ state: 'visible' });
  await alt.fill('Imagem sintética do comunicado');
  await pagesEditorPageProperties(editor.page);
  await title.fill('Novo comunicado — rascunho sintético');
  const saveResponse = editor.page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/pages/${id}/draft` && response.status() === 200);
  await editor.page.getByRole('button', { name: /Salvar rascunho/i }).click();
  await saveResponse;
  await editor.page.getByText(/^Salvo(?:\b|$)/).first().waitFor({ state: 'visible' });
  assert.equal((await api('get', `/${id}`, undefined, 'reader')).document.metadata.title, original.metadata.title, 'save must not alter publication');
  await editor.page.getByRole('button', { name: /Prévia mobile/i }).click();
  await editor.page.getByRole('heading', { name: 'Novo comunicado — rascunho sintético', exact: true }).waitFor({ state: 'visible' });
  const previewImage = editor.page.getByRole('img', { name: 'Imagem sintética do comunicado' });
  await previewImage.waitFor({ state: 'visible' });
  await previewImage.evaluate(image => image.decode());
  assert.equal(await previewImage.evaluate(image => image.naturalWidth), 120);
  await editor.page.getByRole('button', { name: /^Editar$/i }).click();
  assert.equal(await title.inputValue(), 'Novo comunicado — rascunho sintético');
  results.push({ scenario: 'real editor, selected rich text, private image upload, mobile preview, save and publication isolation', pass: true });

  const reader = await contextFor('reader');
  await reader.page.goto(`${h.origin}/pages.html?id=${id}`);
  await ready(reader.page);
  await reader.page.getByRole('heading', { name: original.metadata.title, exact: true }).waitFor({ state: 'visible' });
  assert.equal(await reader.page.locator('main img[src="x"]').count(), 0, 'unsafe-looking text must not create HTML');
  assert.match(await reader.page.locator('main').innerText(), /<img src=x onerror=alert\(1\)>/);
  await reader.context.close();

  const publishResponse = editor.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/pages/${id}/publish` && response.status() === 200);
  await editor.page.getByRole('button', { name: /^Publicar(?: alterações)?$/i }).click();
  const dialog = editor.page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.match(await dialog.innerText(), /Cargo sintético A/);
  await dialog.getByRole('button', { name: /Confirmar publicação|Publicar agora|Publicar/i }).click();
  await publishResponse;
  assert.equal((await api('get', `/${id}`, undefined, 'reader')).document.metadata.title, 'Novo comunicado — rascunho sintético');
  results.push({ scenario: 'publish confirmation with real reviewed revision and cargo', pass: true });

  // Hold one save in transit: double click must not send a second mutation and
  // any later text that the UI permits must remain outside the saved baseline.
  await pagesEditorPageProperties(editor.page);
  let releaseSave;
  let saveStarted;
  const heldSave = new Promise(done => { releaseSave = done; });
  const enteredSave = new Promise(done => { saveStarted = done; });
  let heldRequests = 0;
  const holdHandler = async route => { heldRequests++; saveStarted(); await heldSave; await route.continue(); };
  await editor.context.route(`**/api/pages/${id}/draft`, holdHandler);
  await title.fill('Fotografia enviada durante gravação');
  const heldResponse = editor.page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes(`/${id}/draft`) && response.status() === 200);
  await editor.page.getByRole('button', { name: /Salvar rascunho/i }).evaluate(button => { button.click(); button.click(); });
  await enteredSave;
  const permitsTyping = !await title.isDisabled();
  if (permitsTyping) await title.fill('Alteração posterior à fotografia enviada');
  releaseSave();
  await heldResponse;
  await editor.context.unroute(`**/api/pages/${id}/draft`, holdHandler);
  assert.equal(heldRequests, 1, 'double click must not issue duplicate saves');
  assert.equal((await api('get', `/${id}/workspace`)).draft.document.metadata.title, 'Fotografia enviada durante gravação');
  if (permitsTyping) assert.equal(await title.inputValue(), 'Alteração posterior à fotografia enviada');
  results.push({ scenario: 'pending save, duplicate suppression and snapshot baseline', permitsTyping, pass: true });

  // Save failure preserves edits and permits an explicit retry.
  await title.fill('Rascunho preservado após falha de rede');
  let failSave = true;
  await editor.context.route(`**/api/pages/${id}/draft`, route => failSave ? route.fulfill({ status: 503, json: { error: 'Falha sintética de rede', requestId: 'synthetic-network' } }) : route.continue());
  await editor.page.getByRole('button', { name: /Salvar rascunho/i }).click();
  await editor.page.getByText(/Falha|Não foi possível|Erro ao salvar/i).first().waitFor({ state: 'visible' });
  assert.equal(await title.inputValue(), 'Rascunho preservado após falha de rede');
  failSave = false;
  const retry = editor.page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes(`/${id}/draft`) && response.status() === 200);
  await editor.page.getByRole('button', { name: /Salvar rascunho/i }).click();
  await retry;
  results.push({ scenario: 'network failure and explicit retry preserve local content', pass: true });

  // The server commits B, but its response is lost. Returning locally to saved A
  // must not announce success or permit publishing until B is reconciled.
  await editor.context.unroute(`**/api/pages/${id}/draft`);
  const oldBaseline = await title.inputValue();
  let lostResponse = true;
  const loseCommittedResponse = async route => {
    if (!lostResponse) return route.continue();
    lostResponse = false;
    const response = await route.fetch();
    assert.equal(response.status(), 200, await response.text());
    await route.abort('failed');
  };
  await editor.context.route(`**/api/pages/${id}/draft`, loseCommittedResponse);
  await title.fill('Salvo no servidor, resposta perdida');
  await editor.page.getByRole('button', { name: /Salvar rascunho/i }).click();
  await editor.page.getByText(/Falha ao salvar|Não foi possível salvar|Erro ao salvar/i).first().waitFor({ state: 'visible' });
  assert.equal((await api('get', `/${id}/workspace`)).draft.document.metadata.title, 'Salvo no servidor, resposta perdida');
  await title.fill(oldBaseline);
  assert.equal(await editor.page.getByRole('button', { name: /^Publicar(?: alterações)?$/i }).isDisabled(), true);
  const unsettledStatus = (await editor.page.getByRole('status').allTextContents()).join(' ');
  assert.match(unsettledStatus, /Falha|não confirmado|Não foi possível|Erro/i, 'unknown save outcome cannot become Salvo');
  const reconciled = editor.page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes(`/${id}/draft`) && response.status() === 200);
  await editor.page.getByRole('button', { name: /Salvar rascunho/i }).click();
  await reconciled;
  assert.equal(await title.inputValue(), oldBaseline, 'reconciliation must not replace the newer local value');
  assert.equal(await editor.page.getByRole('button', { name: /^Publicar(?: alterações)?$/i }).isDisabled(), true, 'local A still differs from acknowledged B');
  const saveLocalAgain = editor.page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes(`/${id}/draft`) && response.status() === 200);
  await editor.page.getByRole('button', { name: /Salvar rascunho/i }).click();
  await saveLocalAgain;
  await editor.context.unroute(`**/api/pages/${id}/draft`, loseCommittedResponse);
  results.push({ scenario: 'committed response loss, return to old baseline, blocked publication and idempotent reconciliation', pass: true });

  // A second edit session advances the version; the first session cannot overwrite.
  workspace = await api('get', `/${id}/workspace`);
  await api('put', `/${id}/draft`, { expected_version: workspace.version, client_mutation_id: randomUUID(), document: pageDocument('Outra sessão já salvou') });
  await title.fill('Alteração local que não pode ser perdida');
  const conflict = editor.page.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes(`/${id}/draft`) && response.status() === 409);
  await editor.page.getByRole('button', { name: /Salvar rascunho/i }).click();
  await conflict;
  assert.equal(await title.inputValue(), 'Alteração local que não pode ser perdida');
  assert.equal((await api('get', `/${id}/workspace`)).draft.document.metadata.title, 'Outra sessão já salvou');
  results.push({ scenario: 'two sessions produce explicit CAS conflict without local loss', pass: true });
  await editor.context.close();

  // Native fragment navigation is not a document switch. It must not remount
  // the editor or invalidate the state which owns an in-flight image upload.
  const navigation = await contextFor();
  const nav = navigation.page;
  await nav.goto(`${h.origin}/page-editor.html?id=${id}`);
  await ready(nav);
  const navTitle = await titleInput(nav);
  await navTitle.fill('Edição deve sobreviver à âncora');
  let workspaceLoads = 0;
  nav.on('request', request => { if (new URL(request.url()).pathname === `/api/pages/${id}/workspace`) workspaceLoads++; });
  nav.on('dialog', dialog => dialog.accept());
  await nav.locator('a.skip-link').focus();
  await nav.keyboard.press('Enter');
  await nav.waitForURL(url => url.hash === '#main-content');
  await nav.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(workspaceLoads, 0, 'skip link must not reload workspace');
  assert.equal(await navTitle.inputValue(), 'Edição deve sobreviver à âncora');
  await nav.goBack();
  await nav.waitForURL(url => url.pathname === '/page-editor.html' && !url.hash);
  await nav.goForward();
  await nav.waitForURL(url => url.hash === '#main-content');
  assert.equal(workspaceLoads, 0, 'hash Back/Forward must not remount');
  assert.equal(await navTitle.inputValue(), 'Edição deve sobreviver à âncora');

  let releaseUpload;
  let uploadStarted;
  const heldUpload = new Promise(done => { releaseUpload = done; });
  const enteredUpload = new Promise(done => { uploadStarted = done; });
  const uploadHandler = async route => { uploadStarted(); await heldUpload; await route.continue(); };
  await navigation.context.route(`**/api/pages/${id}/media`, uploadHandler);
  const uploadFinished = nav.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/pages/${id}/media`);
  await nav.getByLabel(/^Selecionar imagem estática/).setInputFiles({ name: 'imagem-apos-ancora.png', mimeType: 'image/png', buffer: imageBuffer });
  await enteredUpload;
  await nav.evaluate(() => {
    const target = document.createElement('div'); target.id = 'pages-upload-anchor';
    document.querySelector('main').append(target); location.hash = '#pages-upload-anchor';
  });
  await nav.waitForURL(url => url.hash === '#pages-upload-anchor');
  await nav.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  assert.equal(workspaceLoads, 0, 'pending upload hash navigation must retain its workspace');
  assert.equal(await navTitle.inputValue(), 'Edição deve sobreviver à âncora');
  releaseUpload();
  assert.equal((await uploadFinished).status(), 201);
  await navigation.context.unroute(`**/api/pages/${id}/media`, uploadHandler);
  const navAlt = nav.getByRole('textbox', { name: /Texto alternativo/i });
  await navAlt.waitFor({ state: 'visible' });
  await navAlt.fill('Imagem recebida após navegação por âncora');
  const navSaved = nav.waitForResponse(response => response.request().method() === 'PUT' && response.url().includes(`/${id}/draft`) && response.status() === 200);
  await nav.getByRole('button', { name: /Salvar rascunho/i }).click();
  await navSaved;
  const navigatedWorkspace = await api('get', `/${id}/workspace`);
  assert.equal(navigatedWorkspace.draft.document.metadata.title, 'Edição deve sobreviver à âncora');
  const savedBlocks = navigatedWorkspace.draft.document.sections.flatMap(section => section.rows.flatMap(row => row.columns.flatMap(column => column.blocks)));
  assert.ok(savedBlocks.some(block => block.type === 'image' && block.alt === 'Imagem recebida após navegação por âncora'));
  results.push({ scenario: 'dirty skip-link/hash Back/Forward and held upload preserve originating editor state', pass: true });
  await navigation.context.close();

  for (const width of [360, 402, 768, 1366, 1920]) {
    const edit = await contextFor('super', width);
    await edit.page.goto(`${h.origin}/page-editor.html?id=${id}`);
    await ready(edit.page);
    await titleInput(edit.page);
    await reflow(edit.page, `editor-${width}`);
    await edit.page.screenshot({ path: join(output, `editor-${width}.png`), fullPage: true });
    const read = await contextFor('reader', width);
    await read.page.goto(`${h.origin}/pages.html?id=${id}`);
    await ready(read.page);
    await read.page.getByRole('heading', { name: 'Novo comunicado — rascunho sintético', exact: true }).waitFor({ state: 'visible' });
    await reflow(read.page, `reader-${width}`);
    await read.page.screenshot({ path: join(output, `reader-${width}.png`), fullPage: true });
    results.push({ scenario: 'editor/reader reflow and WCAG A/AA', width, pass: true });
    await edit.context.close();
    await read.context.close();
  }
  assert.deepEqual(errors, [], 'browser runtime errors');
  await writeFile(join(output, 'results.json'), JSON.stringify({ results, errors, evidence: 'Chrome, real UI/auth middleware/Pages API/PostgreSQL WASM; synthetic Firebase identities; not production/Firebase/Nginx or native PostgreSQL integration' }, null, 2));
  console.log(`Pages browser integration PASS: ${results.length} scenarios; artifacts: ${output}`);
} finally {
  await browser?.close();
  await h.close();
}
