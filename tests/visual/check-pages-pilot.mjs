// Independent real Chrome + API/SQL/private media acceptance for the synthetic pilot.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPagesDatabaseHarness, cargoA } from '../database/check-pages.mjs';
import { createPagesMediaFixtures } from '../helpers/pages-media-fixtures.mjs';
import { pagesBrowserContext, pagesBrowserReady, pagesBrowserReflow, pagesEditorPageProperties, pagesEditorInsert, pagesEditorOrganize } from '../helpers/pages-browser.mjs';

for (const variable of ['PLAYWRIGHT_MODULE_PATH', 'AXE_MODULE_PATH', 'PGLITE_MODULE_PATH']) {
  if (!process.env[variable]) throw new Error(`Set external ${variable}; no production access is used`);
}
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const { default: AxeBuilder } = await import(pathToFileURL(resolve(process.env.AXE_MODULE_PATH)).href);
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express');
const output = resolve(process.env.PILOT_VISUAL_OUTPUT || join(tmpdir(), 'opencode', 'pages-pilot'));
await mkdir(output, { recursive: true });
const results = [], errors = [];
let browser, h, fixtures;
const key = () => ({ client_mutation_id: randomUUID() });

async function api(method, path, body, actor = 'super') {
  const response = await h.api(method, path, body, actor);
  assert.ok(response.status >= 200 && response.status < 300, `${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}
const blocks = doc => doc.sections.flatMap(section => section.rows.flatMap(row => row.columns.flatMap(column => column.blocks)));
async function context(uid = 'super', width = 1366) { return pagesBrowserContext(browser, { uid, width, errors }); }
async function saveUI(page, id) {
  const response = page.waitForResponse(value => value.request().method() === 'PUT' && new URL(value.url()).pathname === `/api/pages/${id}/draft`);
  await page.getByRole('button', { name: /Salvar rascunho/i }).click();
  const saved = await response;
  assert.equal(saved.status(), 200, await saved.text());
  await page.getByText(/^Salvo$/).waitFor({ state: 'visible' });
}

try {
  fixtures = await createPagesMediaFixtures();
  h = await createPagesDatabaseHarness();
  h.app.use(express.static(fileURLToPath(new URL('../../public/', import.meta.url))));
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const creator = await context();
  await creator.page.goto(`${h.origin}/pages.html?manage=1`);
  await pagesBrowserReady(creator.page);
  await creator.page.getByRole('combobox', { name: 'Modelo da página', exact: true }).selectOption('owner-news');
  await creator.page.getByRole('button', { name: /Criar comunicado|Criar página/i }).click();
  const createDialog = creator.page.getByRole('dialog');
  await createDialog.waitFor({ state: 'visible' });
  assert.match(await createDialog.innerText(), /sintétic|fictíci/i);
  const creation = creator.page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/pages');
  await createDialog.getByRole('button', { name: 'Criar rascunho', exact: true }).click();
  const createResponse = await creation;
  assert.equal(createResponse.status(), 201, await createResponse.text());
  const id = (await createResponse.json()).id;
  await creator.page.waitForURL(url => url.pathname === '/page-editor.html' && url.searchParams.get('id') === id);
  await creator.page.locator('.ProseMirror').first().waitFor({ state: 'visible' });
  await creator.context.close();
  results.push({ scenario: 'select synthetic Owner News template in the real management catalog and create/open its draft', pass: true });
  let workspace = await api('get', `/${id}/workspace`);
  workspace.draft.document.metadata.audience.job_title_ids = [cargoA];
  await api('put', `/${id}/draft`, { ...key(), expected_version: workspace.version, document: workspace.draft.document });
  const editor = await context();
  await editor.page.goto(`${h.origin}/page-editor.html?id=${id}`);
  await pagesBrowserReady(editor.page);
  await editor.page.locator('.ProseMirror').first().waitFor({ state: 'visible' });

  // Exercise real controls, not only the nested JSON representation.
  const firstBlock = editor.page.locator('.pages-editor-block').first();
  const firstBlockId = await firstBlock.getAttribute('data-block-id');
  const firstRich = firstBlock.locator('.ProseMirror');
  await firstRich.evaluate(node => { globalThis.__originalPilotEditor = node; });
  await firstRich.click();
  await firstRich.press('Control+End');
  await firstRich.pressSequentially(' MARCADOR-UNDO-PILOTO');
  await pagesEditorOrganize(editor.page);
  await editor.page.getByRole('combobox', { name: /Colunas da linha/ }).first().selectOption('two_equal');
  const firstRow = editor.page.locator('.pages-editor-row').first();
  const leftColumn = await firstRow.locator('[data-column-id]').nth(0).getAttribute('data-column-id');
  const rightColumn = await firstRow.locator('[data-column-id]').nth(1).getAttribute('data-column-id');
  await editor.page.getByRole('combobox', { name: 'Coluna de destino', exact: true }).selectOption(rightColumn);
  await editor.page.getByRole('button', { name: 'Mover para destino', exact: true }).click();
  await editor.page.locator(`[data-column-id="${rightColumn}"] [data-block-id="${firstBlockId}"]`).waitFor({ state: 'visible' });
  assert.equal(await firstRich.evaluate(node => node === globalThis.__originalPilotEditor), true, 'column movement retains the actual ProseMirror DOM instance');
  await firstRich.click();
  await firstRich.press('Control+z');
  assert.doesNotMatch(await firstRich.innerText(), /MARCADOR-UNDO-PILOTO/, 'text undo history survives layout and movement');
  const proseBeforeDrag = await firstRich.innerText();
  await editor.page.getByRole('combobox', { name: 'Coluna de destino', exact: true }).selectOption(leftColumn);
  await editor.page.getByRole('button', { name: 'Mover para destino', exact: true }).click();
  const handle = editor.page.locator(`[data-block-id="${firstBlockId}"] .pages-drag-handle`);
  const drop = editor.page.locator(`[data-column-id="${rightColumn}"]`);
  await handle.scrollIntoViewIfNeeded();
  const pointerStart = await handle.boundingBox(), pointerEnd = await drop.boundingBox();
  assert.ok(pointerStart && pointerEnd);
  const sourcePoint = { x: pointerStart.x + Math.min(pointerStart.width / 2, 40), y: pointerStart.y + pointerStart.height / 2 };
  const targetPoint = { x: pointerEnd.x + pointerEnd.width / 2, y: pointerEnd.y + Math.min(pointerEnd.height / 2, 60) };
  await editor.page.mouse.move(sourcePoint.x, sourcePoint.y);
  await editor.page.mouse.down();
  for (let step = 1; step <= 12; step++) {
    await editor.page.mouse.move(sourcePoint.x + (targetPoint.x - sourcePoint.x) * step / 12, sourcePoint.y + (targetPoint.y - sourcePoint.y) * step / 12);
    await editor.page.evaluate(() => new Promise(done => requestAnimationFrame(done)));
  }
  await editor.page.mouse.up();
  await editor.page.locator(`[data-column-id="${rightColumn}"] [data-block-id="${firstBlockId}"]`).waitFor({ state: 'visible' });
  assert.equal(await firstRich.evaluate(node => node === globalThis.__originalPilotEditor), true, 'pointer movement retains the editor instance');
  assert.equal(await firstRich.innerText(), proseBeforeDrag, 'block drag must not drop serialized wrapper/buttons into ProseMirror text');
  await editor.page.getByRole('combobox', { name: /Colunas da linha/ }).first().selectOption('single');
  await editor.page.locator(`[data-column-id="${leftColumn}"] [data-block-id="${firstBlockId}"]`).waitFor({ state: 'visible' });
  await editor.page.getByRole('combobox', { name: 'Fonte', exact: true }).selectOption('source-serif-4');
  await pagesEditorInsert(editor.page, 'Adicionar destaque');
  const callout = editor.page.locator('.pages-editor-block[data-block-type="callout"] .ProseMirror');
  await callout.click();
  await callout.pressSequentially('Destaque sintético do piloto.');
  await pagesEditorInsert(editor.page, 'Adicionar botão');
  await pagesEditorInsert(editor.page, 'Adicionar separador');
  results.push({ scenario: 'real two-column controls, keyboard destination, lateral drag, lossless collapse, keyed PM undo and generic blocks/presets', pass: true });

  // Every accepted format enters through the actual editor and authenticated API.
  for (const [kind, name, mime] of [['gif', 'synthetic.gif', 'image/gif'], ['audio', 'synthetic.mp3', 'audio/mpeg'], ['video', 'synthetic.mp4', 'video/mp4']]) {
    const input = editor.page.locator(`input[type="file"][accept*="${mime}"]`);
    assert.equal(await input.count(), 1, `${kind}: explicit upload control`);
    const response = editor.page.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname === `/api/pages/${id}/media`);
    await input.setInputFiles({ name, mimeType: mime, buffer: fixtures.files[name].buffer });
    const uploaded = await response;
    assert.equal(uploaded.status(), 201, await uploaded.text());
    const ack = await uploaded.json();
    assert.equal(ack.kind, kind);
    const node = editor.page.locator('.pages-v2-inspector');
    if (kind === 'gif') await node.getByRole('textbox', { name: /Texto alternativo/i }).fill('Animação sintética de teste');
    else {
      await node.getByRole('textbox', { name: /Título/i }).fill(kind === 'audio' ? 'Tom sintético de teste' : 'Vídeo sintético de teste');
      await node.getByRole('textbox', { name: /Transcrição/i }).fill('Padrão de teste gerado localmente, com tom senoidal e sem fala.');
    }
  }
  // Composition clones the document, but a retained media figure must resolve
  // the current block when it later builds a caption track.
  await editor.page.getByRole('combobox', { name: 'Escala', exact: true }).selectOption('large');
  const retainedVideo = editor.page.locator('.pages-editor-block[data-block-type="video"]');
  const captionsField = editor.page.getByRole('textbox', { name: 'Legendas sincronizadas JSON', exact: true });
  await captionsField.fill(JSON.stringify([{ start_ms: 0, end_ms: 1500, text: 'Padrão de teste e tom sintético.' }]));
  await captionsField.press('Tab');
  await retainedVideo.getByRole('button', { name: 'Carregar vídeo', exact: true }).click();
  await retainedVideo.locator('track').waitFor({ state: 'attached' });
  await editor.page.waitForFunction(() => document.querySelector('.pages-editor-block video')?.textTracks[0]?.cues?.length > 0);
  assert.equal(await retainedVideo.locator('video').evaluate(node => node.textTracks[0].cues[0].text), 'Padrão de teste e tom sintético.');
  await retainedVideo.getByRole('button', { name: 'Descarregar mídia', exact: true }).click();
  results.push({ scenario: 'retained video reads caption edits from the current block after composition replaces the working document', pass: true });
  await saveUI(editor.page, id);
  workspace = await api('get', `/${id}/workspace`);
  assert.equal(workspace.draft.document.schema_version, 2);
  assert.ok(blocks(workspace.draft.document).some(item => item.type === 'callout'));
  assert.ok(blocks(workspace.draft.document).some(item => item.type === 'divider'));
  assert.equal(blocks(workspace.draft.document).find(item => item.id === firstBlockId).style.font, 'source-serif-4');
  assert.deepEqual(blocks(workspace.draft.document).filter(item => ['gif', 'audio', 'video'].includes(item.type)).map(item => item.type).sort(), ['audio', 'gif', 'video']);
  results.push({ scenario: 'synthetic recipe edited with real private GIF/MP3/MP4 uploads and saved', pass: true });

  // Add synchronized cues through the same draft API; playback tests inspect actual TextTrack cues.
  const doc = structuredClone(workspace.draft.document);
  const videoBlock = blocks(doc).find(item => item.type === 'video');
  videoBlock.captions = [{ start_ms: 0, end_ms: 1500, text: 'Padrão de teste e tom sintético.' }];
  const layoutRow = doc.sections[2].rows[0];
  if (layoutRow.layout === 'single') { layoutRow.layout = 'two_equal'; layoutRow.columns.push({ id: randomUUID(), blocks: [] }); }
  layoutRow.columns[1].blocks.push({ id: randomUUID(), type: 'rich_text', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Conteúdo da coluna direita após a esquerda.' }] }] } });
  await api('put', `/${id}/draft`, { ...key(), expected_version: workspace.version, document: doc });
  await editor.page.reload();
  await pagesBrowserReady(editor.page);
  await pagesEditorPageProperties(editor.page);
  await editor.page.getByRole('textbox', { name: /^Título$/ }).first().waitFor({ state: 'visible' });
  await editor.page.getByRole('button', { name: /Prévia mobile/i }).click();
  await editor.page.locator('.pages-document').waitFor({ state: 'visible' });
  await pagesBrowserReflow(editor.page, AxeBuilder, 'pilot-mobile-preview');
  await editor.page.screenshot({ path: join(output, 'pilot-preview-mobile.png'), fullPage: true });
  await editor.page.getByRole('button', { name: /^Publicar$/ }).click();
  const dialog = editor.page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.match(await dialog.innerText(), /Cargo sintético A/);
  const published = editor.page.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).pathname === `/api/pages/${id}/publish`);
  await dialog.getByRole('button', { name: /Confirmar publicação/i }).click();
  assert.equal((await published).status(), 200);
  results.push({ scenario: 'shared mobile preview and explicit revision/cargo publication confirmation', pass: true });
  await editor.context.close();

  const publishedDoc = (await api('get', `/${id}`, undefined, 'reader')).document;
  const target = publishedDoc.sections[2].id;
  const reader = await context('reader');
  const page = reader.page;
  const requests = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/pages')) requests.push(url.pathname + url.search); });
  await page.goto(`${h.origin}/pages.html?id=${id}#section-${target}`);
  await pagesBrowserReady(page);
  await page.locator(`#section-${target}`).waitFor({ state: 'visible' });
  await page.waitForFunction(id => {
    const node = document.getElementById(`section-${id}`), rect = node.getBoundingClientRect();
    return document.activeElement === node || (scrollY > 0 && rect.top >= 0 && rect.top < innerHeight);
  }, target);
  assert.equal(requests.filter(path => /\/media\//.test(path)).length, 0, 'no eager media request, including GIF under reduced motion');
  assert.equal(await page.locator('audio[autoplay],video[autoplay]').count(), 0);
  assert.equal(await page.locator('iframe').count(), 0);
  const downloadAudio = page.getByRole('button', { name: /Carregar áudio/i });
  await downloadAudio.click();
  const audio = page.locator('audio');
  await page.waitForFunction(() => document.querySelector('audio')?.readyState >= 2);
  assert.equal(await audio.evaluate(node => node.paused && node.controls), true, 'download must not start sound');
  await audio.evaluate(node => node.play());
  await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.2);
  await audio.evaluate(node => node.pause());
  const downloadVideo = page.getByRole('button', { name: /Carregar vídeo/i });
  await downloadVideo.click();
  const video = page.locator('video');
  await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
  assert.equal(await video.evaluate(node => node.paused && node.controls && node.playsInline), true);
  await video.evaluate(node => { if (node.textTracks[0]) node.textTracks[0].mode = 'showing'; return node.play(); });
  await page.waitForFunction(() => document.querySelector('video').currentTime > 0.2);
  await page.waitForFunction(() => document.querySelector('video').textTracks[0]?.cues?.length > 0);
  assert.equal(await video.evaluate(node => node.textTracks[0].cues[0].text), 'Padrão de teste e tom sintético.');
  await video.evaluate(node => node.pause());
  results.push({ scenario: 'user-triggered complete downloads; real MP3/MP4 decoding, progress and synchronized captions; no autoplay', pass: true });

  const startGif = page.getByRole('button', { name: /Iniciar animação/i });
  await startGif.click();
  const gif = page.getByRole('img', { name: 'Animação sintética de teste' });
  await gif.waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const image = document.querySelector('img[alt="Animação sintética de teste"]');
    return image?.getAttribute('src')?.startsWith('blob:') && image.complete && image.naturalWidth > 0;
  });
  await gif.evaluate(node => node.decode());
  assert.equal(await gif.evaluate(node => node.naturalWidth), 64);
  // drawImage(animatedImage) may expose only the default frame. Compare actual
  // rendered pixels instead of mistaking a canvas snapshot for playback.
  const firstFrame = await gif.screenshot({ animations: 'allow' });
  let animationChanged = false;
  for (let frame = 0; frame < 30; frame++) {
    await page.evaluate(() => new Promise(done => requestAnimationFrame(done)));
    if (!(await gif.screenshot({ animations: 'allow' })).equals(firstFrame)) { animationChanged = true; break; }
  }
  assert.equal(animationChanged, true, 'GIF must visibly change frames, not only decode a still image');
  const gifLoaded = requests.filter(path => /\/media\//.test(path)).length;
  assert.equal(gifLoaded, 3);
  await page.getByRole('button', { name: /Parar animação/i }).click();
  assert.equal(await page.locator('img[alt="Animação sintética de teste"][src^="blob:"]').count(), 0, 'stop GIF clears the animated source');
  results.push({ scenario: 'real animated GIF is opt-in and stoppable with reduced motion', pass: true });

  const readsBeforeHash = requests.filter(path => path === `/api/pages/${id}`).length;
  const sourceBeforeHash = await audio.getAttribute('src');
  const anchor = page.locator(`a[href$="#section-${publishedDoc.sections[3].id}"]`).first();
  await anchor.click();
  await page.waitForURL(url => url.hash === `#section-${publishedDoc.sections[3].id}`);
  await page.goBack();
  await page.waitForURL(url => url.hash === `#section-${target}`);
  await page.goForward();
  await page.waitForURL(url => url.hash === `#section-${publishedDoc.sections[3].id}`);
  assert.equal(requests.filter(path => path === `/api/pages/${id}`).length, readsBeforeHash, 'hash history must not refetch the document');
  assert.equal(await audio.getAttribute('src'), sourceBeforeHash, 'hash history retains the same mounted player');
  assert.equal(requests.filter(path => /\/media\//.test(path)).length, gifLoaded, 'hash history must not re-download media');
  results.push({ scenario: 'initial section deep link, index, hash Back/Forward retain document and media', pass: true });

  await page.evaluate(() => { globalThis.__oldPilotPlayers = [...document.querySelectorAll('audio,video')]; });
  await page.getByRole('link', { name: /Voltar às Pages/i }).click();
  await page.getByRole('heading', { name: 'Pages', exact: true }).waitFor({ state: 'visible' });
  assert.deepEqual(await page.evaluate(() => globalThis.__oldPilotPlayers.map(node => ({ paused: node.paused, src: node.getAttribute('src') }))), [{ paused: true, src: null }, { paused: true, src: null }]);
  assert.equal(await page.evaluate(() => globalThis.__pagesObjectURLs.size), 0, 'navigation releases media and VTT blob URLs');
  results.push({ scenario: 'query-changing navigation stops players, clears sources and revokes every blob', pass: true });
  await reader.context.close();

  const touchCreated = await api('post', '', { ...key(), template_id: 'owner-news' });
  const touch = await pagesBrowserContext(browser, { uid: 'super', width: 1366, errors, touch: true });
  await touch.page.goto(`${h.origin}/page-editor.html?id=${touchCreated.id}`);
  await pagesBrowserReady(touch.page);
  await touch.page.locator('.ProseMirror').first().waitFor({ state: 'visible' });
  await pagesEditorOrganize(touch.page);
  await touch.page.getByRole('combobox', { name: /Colunas da linha/ }).first().selectOption('two_equal');
  const touchBlock = touch.page.locator('.pages-editor-block').first(), touchId = await touchBlock.getAttribute('data-block-id');
  const touchText = await touchBlock.locator('.ProseMirror').innerText();
  const touchHandle = touchBlock.locator('.pages-drag-handle');
  await touchHandle.scrollIntoViewIfNeeded();
  const from = await touchHandle.boundingBox(), to = await touch.page.locator('.pages-editor-row').first().locator('[data-column-id]').nth(1).boundingBox();
  const rightId = await touch.page.locator('.pages-editor-row').first().locator('[data-column-id]').nth(1).getAttribute('data-column-id');
  assert.ok(from && to);
  const client = await touch.context.newCDPSession(touch.page);
  const start = { x: from.x + Math.min(from.width / 2, 40), y: from.y + from.height / 2 };
  const end = { x: to.x + to.width / 2, y: to.y + Math.min(to.height / 2, 60) };
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
  for (let step = 1; step <= 12; step++) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x + (end.x - start.x) * step / 12, y: start.y + (end.y - start.y) * step / 12, id: 1 }] });
    await touch.page.evaluate(() => new Promise(done => requestAnimationFrame(done)));
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touch.page.locator(`[data-column-id="${rightId}"] [data-block-id="${touchId}"]`).waitFor({ state: 'visible' });
  assert.equal(await touch.page.locator(`[data-block-id="${touchId}"] .ProseMirror`).innerText(), touchText, 'touch drag cannot alter prose');
  await pagesEditorInsert(touch.page, 'Adicionar botão');
  const existingButtonId = await touch.page.locator('.pages-editor-block.is-selected').getAttribute('data-block-id');
  await touch.page.getByRole('button', { name: 'Adicionar seção', exact: true }).click();
  const newSectionId = await touch.page.locator('.pages-editor-section').last().getAttribute('data-section-id');
  const existingDestination = touch.page.locator('.pages-v2-inspector').getByRole('combobox', { name: 'Tipo de destino', exact: true });
  assert.equal(await existingDestination.locator(`option[value="${newSectionId}"]`).count(), 1, 'a reused button sees newly added sections without reload');
  await existingDestination.selectOption(newSectionId);
  await saveUI(touch.page, touchCreated.id);
  const touchSaved = await api('get', `/${touchCreated.id}/workspace`);
  assert.equal(touchSaved.draft.document.sections[0].rows[0].columns[1].blocks[0].id, touchId);
  assert.equal(blocks(touchSaved.draft.document).find(block => block.id === existingButtonId).destination.value, newSectionId);
  await client.detach();
  await touch.context.close();
  results.push({ scenario: 'Chrome touch-input drag moves to an empty column, preserves prose and persists canonical order', pass: true });
  results.push({ scenario: 'keyed button reconciles section options after adding a section and persists its new destination', pass: true });

  for (const width of [360, 402, 768, 1366, 1920]) {
    const read = await context('reader', width);
    await read.page.goto(`${h.origin}/pages.html?id=${id}`);
    await pagesBrowserReady(read.page);
    await read.page.locator('.pages-document').waitFor({ state: 'visible' });
    await pagesBrowserReflow(read.page, AxeBuilder, `pilot-reader-${width}`);
    const expected = blocks(publishedDoc).map(block => block.id);
    const actual = await read.page.locator('.pages-document [data-block-id]').evaluateAll(nodes => nodes.map(node => node.dataset.blockId));
    assert.deepEqual(actual, expected, 'DOM reading order equals canonical model order at every viewport');
    const leftId = layoutRow.columns[0].blocks[0].id, rightId = layoutRow.columns[1].blocks[0].id;
    const left = await read.page.locator(`.pages-document [data-block-id="${leftId}"]`).boundingBox();
    const right = await read.page.locator(`.pages-document [data-block-id="${rightId}"]`).boundingBox();
    assert.ok(left && right);
    if (width <= 402) assert.ok(left.y < right.y && Math.abs(left.x - right.x) < 2, 'mobile stacks the entire left column before the right');
    if (width >= 1366) assert.ok(left.x < right.x, 'desktop has real adjacent columns, not a flattened list');
    await read.page.screenshot({ path: join(output, `pilot-reader-${width}.png`), fullPage: true });
    await read.context.close();
    results.push({ scenario: 'pilot reader order, reflow and WCAG A/AA', width, pass: true });
  }
  assert.deepEqual(errors, [], 'browser runtime errors');
  await writeFile(join(output, 'results.json'), JSON.stringify({ results, errors, evidence: 'Real Chrome/UI/API/SQL/private files and FFmpeg fixtures; serialized PostgreSQL WASM and synthetic Firebase; not native PG/Firebase/Nginx/physical-device acceptance.' }, null, 2));
  console.log(`Pages pilot browser PASS: ${results.length} scenarios; artifacts: ${output}`);
} catch (error) {
  for (const [index, page] of (browser?.contexts().flatMap(context => context.pages()) || []).entries()) {
    if (!page.isClosed()) {
      await page.screenshot({ path: join(output, `failure-${index}.png`), fullPage: true }).catch(() => {});
      await writeFile(join(output, `failure-${index}.txt`), await page.locator('main').innerText().catch(() => 'No main content')).catch(() => {});
    }
  }
  await writeFile(join(output, 'failure.json'), JSON.stringify({ results, errors, error: error.message }, null, 2));
  throw error;
} finally { await browser?.close(); await h?.close(); await fixtures?.close(); }
