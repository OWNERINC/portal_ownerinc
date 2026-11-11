// Editor V2: real browser, isolated SQL/API and synthetic Firebase identity.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPagesDatabaseHarness, cargoA } from '../database/check-pages.mjs';
import { pagesBrowserContext, pagesBrowserReady, pagesBrowserReflow, pagesEditorMore } from '../helpers/pages-browser.mjs';

for (const name of ['PGLITE_MODULE_PATH','PLAYWRIGHT_MODULE_PATH','AXE_MODULE_PATH']) if (!process.env[name]) throw new Error(`Set external ${name}`);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const { default: AxeBuilder } = await import(pathToFileURL(resolve(process.env.AXE_MODULE_PATH)).href);
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express');
const output = resolve(process.env.V2_VISUAL_OUTPUT || join(tmpdir(), 'opencode', 'pages-editor-v2'));
await mkdir(output, { recursive: true });
const results = [], errors = [];
const h = await createPagesDatabaseHarness();
h.app.use(express.static(fileURLToPath(new URL('../../public/', import.meta.url))));
let browser;
async function api(method, path, body, actor = 'super') {
  const response = await h.api(method, path, body, actor);
  assert.ok(response.status >= 200 && response.status < 300, `${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}
async function pageProperties(page, width) {
  await pagesEditorMore(page);
  if (width < 1100) await page.getByRole('button', { name: 'Propriedades', exact: true }).click();
  else await page.getByRole('button', { name: 'Página', exact: true }).click();
}
async function closeSheet(page, width) {
  if (width < 1100) await page.getByRole('button', { name: 'Fechar propriedades', exact: true }).click();
}
async function save(page, id) {
  await pagesEditorMore(page);
  const request = page.waitForResponse(value => value.request().method() === 'PUT' && new URL(value.url()).pathname === `/api/pages/${id}/draft`);
  await page.getByRole('button', { name: /Salvar rascunho/ }).click(); assert.equal((await request).status(), 200);
}
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  for (const width of (process.env.V2_WIDTHS ? process.env.V2_WIDTHS.split(',').map(Number) : [360,390,402,768,1366,1600,1920])) {
    const created = await api('post', '', { template_id: 'owner-news', client_mutation_id: randomUUID() });
    const id = created.id;
    let workspace = await api('get', `/${id}/workspace`);
    workspace.draft.document.metadata.audience.job_title_ids = [cargoA];
    await api('put', `/${id}/draft`, { expected_version: workspace.version, client_mutation_id: randomUUID(), document: workspace.draft.document });
    const visit = await pagesBrowserContext(browser, { width, errors });
    const page = visit.page;
    await page.setViewportSize({ width, height: width === 390 ? 820 : width === 1600 ? 1160 : 900 });
    await page.goto(`${h.origin}/page-editor.html?id=${id}`); await pagesBrowserReady(page);
    const rich = page.locator('.ProseMirror').first(); await rich.waitFor({ state: 'visible' });
    await rich.evaluate(node => { globalThis.__v2FirstProse = node; });
    assert.equal(await page.locator('body.pages-editor-active').count(), 1);
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    const backTarget = await page.getByRole('link', { name: 'Voltar à gestão de Pages', exact: true }).boundingBox();
    assert.ok(backTarget.width >= 44 && backTarget.height >= 44, 'back link has a full touch target');
    await pagesBrowserReflow(page, AxeBuilder, `v2-editing-${width}`);
    await page.screenshot({ path: join(output, `editing-${width}.png`) });
    await pagesEditorMore(page);
    await page.getByRole('button', { name: 'Inserir bloco', exact: true }).click();
    const insert = page.getByRole('dialog', { name: 'O que você quer adicionar?' });
    await insert.waitFor({ state: 'visible' });
    await pagesBrowserReflow(page, AxeBuilder, `v2-insert-${width}`);
    await page.screenshot({ path: join(output, `insert-${width}.png`) });
    await insert.getByRole('searchbox', { name: 'Buscar bloco' }).fill('áudio');
    assert.equal(await insert.getByRole('button', { name: 'Adicionar áudio', exact: true }).isVisible(), true);
    assert.equal(await insert.getByRole('button', { name: 'Adicionar texto', exact: true }).isVisible(), false);
    await page.keyboard.press('Escape');
    const opener = width < 600 ? page.locator('.pages-v2-overflow > summary') : page.getByRole('button', { name: 'Inserir bloco', exact: true });
    assert.equal(await opener.evaluate(node => node === document.activeElement), true);
    await pagesEditorMore(page);
    await page.getByRole('button', { name: 'Estilo da página', exact: true }).click();
    const style = page.getByRole('dialog', { name: 'Estilo da página', exact: true });
    await pagesBrowserReflow(page, AxeBuilder, `v2-style-${width}`);
    await page.screenshot({ path: join(output, `style-${width}.png`) });
    await style.getByRole('combobox', { name: 'Fonte dos blocos existentes' }).selectOption('source-serif-4');
    await style.getByRole('button', { name: 'Quente', exact: true }).click();
    await style.getByRole('button', { name: 'Aplicar aos blocos existentes' }).click();
    assert.equal(await rich.evaluate(node => node === globalThis.__v2FirstProse), true);
    await save(page, id);
    workspace = await api('get', `/${id}/workspace`);
    const blocks = workspace.draft.document.sections.flatMap(s => s.rows.flatMap(r => r.columns.flatMap(c => c.blocks)));
    assert.ok(blocks.every(block => block.style.font === 'source-serif-4' && block.style.palette === 'warm'));
    await pageProperties(page, width);
    const title = page.getByRole('textbox', { name: 'Título', exact: true });
    await title.fill(`V2 sintético ${width}`); await save(page, id);
    await closeSheet(page, width);
    if (width < 600) {
      assert.equal(await page.locator('.pages-v2-overflow > summary').evaluate(node => node === document.activeElement), true, 'Page properties returns to the visible phone menu summary');
      await pageProperties(page, width); await page.keyboard.press('Escape');
      assert.equal(await page.locator('.pages-v2-overflow > summary').evaluate(node => node === document.activeElement), true, 'Escape restores visible Page-properties opener');
      await pageProperties(page, width); await page.getByRole('button', { name: 'Concluir edição', exact: true }).click();
      assert.equal(await page.locator('.pages-v2-overflow > summary').evaluate(node => node === document.activeElement), true, 'Concluir edição restores visible Page-properties opener');
    }
    await page.locator('.pages-select-block').first().click();
    if (width < 1100) {
      await page.getByRole('button', { name: 'Estilo', exact: true }).click();
      await page.getByRole('combobox', { name: 'Fonte', exact: true }).selectOption('manrope');
      await pagesBrowserReflow(page, AxeBuilder, `v2-bottom-sheet-${width}`);
      await page.screenshot({ path: join(output, `bottom-sheet-${width}.png`) });
      await page.getByRole('button', { name: 'Posição', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Mover para destino', exact: true }).isVisible(), true);
      await page.getByRole('button', { name: 'Conteúdo', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Negrito', exact: true }).isVisible(), true);
      await page.getByRole('button', { name: 'Concluir edição', exact: true }).click();
    }
    await rich.click(); await rich.press('Control+End'); await rich.pressSequentially(' TEXTO-V2');
    await page.getByRole('button', { name: 'Negrito', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Negrito', exact: true }).getAttribute('aria-pressed'), 'true', 'live formatting state follows the current caret');
    if (width === 1600) {
      await page.getByLabel('Mais opções de texto', { exact: true }).click();
      const list = page.getByRole('button', { name: 'Lista', exact: true });
      assert.ok((await list.boundingBox()).height < 90, 'overflow formatting remains a readable control');
      await list.click(); assert.ok(await rich.locator('ul li').count());
      await page.getByRole('button', { name: 'Remover lista', exact: true }).click();
      assert.equal(await rich.locator('ul li').count(), 0);
      await page.getByLabel('Mais opções de texto', { exact: true }).click();
    }
    assert.equal(await rich.evaluate(node => node === globalThis.__v2FirstProse), true);
    await closeSheetIfOpen(page, width);
    await save(page, id);
    await page.getByRole('button', { name: 'Publicar', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Pronto para compartilhar?' });
    await review.waitFor({ state: 'visible' });
    assert.match(await review.innerText(), /Cargo sintético A/);
    await pagesBrowserReflow(page, AxeBuilder, `v2-review-${width}`);
    await page.screenshot({ path: join(output, `review-${width}.png`) });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /Prévia mobile/ }).click();
    await page.locator('.pages-document').waitFor({ state: 'visible' });
    await pagesBrowserReflow(page, AxeBuilder, `v2-preview-${width}`);
    await page.getByRole('button', { name: 'Editar', exact: true }).click();
    assert.match(await rich.innerText(), /TEXTO-V2/);
    await page.getByRole('link', { name: 'Voltar à gestão de Pages', exact: true }).click();
    await page.getByRole('heading', { name: 'Gerenciar Pages', exact: true }).waitFor({ state: 'visible' });
    assert.equal(await page.locator('body.pages-editor-active').count(), 0);
    assert.notEqual(await page.locator('.sidebar').evaluate(node => getComputedStyle(node).display), 'none', 'Portal sidebar styling restored (mobile may be translated offscreen)');
    results.push({ width, scenario: 'workspace + insertion/search + global preset persistence + PM identity + sheet + review + preview + shell cleanup/axe', pass: true });
    await visit.context.close();

    if ([390,1600].includes(width)) {
      const readonly = await pagesBrowserContext(browser, { width, uid: 'publisher', errors });
      const reviewPage = readonly.page;
      await reviewPage.goto(`${h.origin}/page-editor.html?id=${id}`); await pagesBrowserReady(reviewPage);
      await reviewPage.locator('.pages-document').waitFor({ state: 'visible' });
      assert.equal(await reviewPage.locator('.ProseMirror').count(), 0);
      assert.equal(await reviewPage.getByRole('button', { name: 'Inserir bloco', exact: true }).count(), 0);
      assert.equal(await reviewPage.getByRole('button', { name: /Salvar rascunho/ }).count(), 0);
      await pageProperties(reviewPage, width);
      assert.equal(await reviewPage.getByRole('textbox', { name: 'Título', exact: true }).isDisabled(), true);
      await closeSheetIfOpen(reviewPage, width);
      await pagesBrowserReflow(reviewPage, AxeBuilder, `v2-readonly-${width}`);
      await reviewPage.getByRole('button', { name: 'Publicar', exact: true }).click();
      const confirmation = reviewPage.getByRole('dialog', { name: 'Pronto para compartilhar?' });
      await confirmation.waitFor({ state: 'visible' });
      assert.match(await confirmation.innerText(), /Cargo sintético A/);
      await reviewPage.keyboard.press('Escape');
      await readonly.context.close();
      results.push({ width, scenario: 'publisher reviews another author without editing; metadata disabled; current saved revision can enter publish review', pass: true });
    }
    if (width === 1600) {
      const resize = await pagesBrowserContext(browser, { width, errors });
      const resized = resize.page;
      await resized.goto(`${h.origin}/page-editor.html?id=${id}`); await pagesBrowserReady(resized);
      await pageProperties(resized, 1600);
      const name = resized.locator('.pages-metadata-title input'); await name.fill('Edição sintética preservada no resize');
      const prose = resized.locator('.ProseMirror').first(); await prose.click(); await prose.press('Control+End'); await prose.pressSequentially(' REDIMENSIONAR-V2');
      await prose.evaluate(node => { globalThis.__resizeProse = node; });
      for (const nextWidth of [390,1366,768,1600]) {
        await resized.setViewportSize({ width: nextWidth, height: nextWidth < 600 ? 820 : 900 });
        await resized.waitForFunction(() => document.querySelector('.ProseMirror') === globalThis.__resizeProse);
        assert.equal(await name.inputValue(), 'Edição sintética preservada no resize');
        assert.match(await prose.innerText(), /REDIMENSIONAR-V2/);
        await pagesBrowserReflow(resized, AxeBuilder, `v2-dirty-resize-${nextWidth}`);
      }
      await prose.click(); await prose.press('Control+z'); assert.doesNotMatch(await prose.innerText(), /REDIMENSIONAR-V2/);
      await resize.context.close();
      results.push({ scenario: 'dirty text/title and PM identity/history survive desktop/phone/tablet reparenting', pass: true });
    }
  }
  assert.deepEqual(errors, [], 'browser runtime errors');
  await writeFile(join(output, 'results.json'), JSON.stringify({ results, errors, evidence: 'Real Chrome/Pages UI/API/serialized PGlite. Synthetic Firebase; not production or physical devices.' }, null, 2));
  console.log(`Pages V2 PASS: ${results.length} scenarios, ${new Set(results.filter(item => item.width).map(item => item.width)).size} widths; artifacts: ${output}`);
} catch (error) {
  for (const [index, page] of (browser?.contexts().flatMap(context => context.pages()) || []).entries()) if (!page.isClosed()) await page.screenshot({ path: join(output, `failure-${index}.png`), fullPage: true }).catch(() => {});
  throw error;
} finally { await browser?.close(); await h.close(); }
async function closeSheetIfOpen(page, width) {
  if (width < 1100 && await page.getByRole('button', { name: 'Fechar propriedades', exact: true }).isVisible()) await closeSheet(page, width);
}
