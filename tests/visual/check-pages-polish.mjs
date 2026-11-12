// Independent editor geometry/style/a11y checks. Synthetic loopback data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createPagesDatabaseHarness, cargoA } from '../database/check-pages.mjs';
import { pagesBrowserContext, pagesBrowserReady, pagesBrowserReflow, pagesEditorOrganize, pagesEditorMore } from '../helpers/pages-browser.mjs';

for (const name of ['PGLITE_MODULE_PATH','PLAYWRIGHT_MODULE_PATH','AXE_MODULE_PATH']) if (!process.env[name]) throw new Error(`Set external ${name}`);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const { default: AxeBuilder } = await import(pathToFileURL(resolve(process.env.AXE_MODULE_PATH)).href);
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express');
const output = resolve(process.env.POLISH_VISUAL_OUTPUT || join(tmpdir(), 'opencode', 'pages-polish'));
await mkdir(output, { recursive: true });
const results = [], errors = [];
const h = await createPagesDatabaseHarness();
h.app.use(express.static(fileURLToPath(new URL('../../public/', import.meta.url))));
let browser;
async function api(method, path, body) {
  const response = await h.api(method, path, body, 'super');
  assert.ok(response.status >= 200 && response.status < 300, `${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}
const styleOf = locator => locator.evaluate(node => {
  const s = getComputedStyle(node), rect = node.getBoundingClientRect();
  return { font: s.fontFamily, radius: parseFloat(s.borderTopLeftRadius), height: rect.height, width: rect.width, align: s.textAlign, borderStyle: s.borderTopStyle, paddingLeft: parseFloat(s.paddingLeft), boxSizing: s.boxSizing };
});
async function separated(first, second, label) {
  const a = await first.boundingBox(), b = await second.boundingBox();
  assert.ok(a && b, label);
  const gap = Math.max(b.x - a.x - a.width, a.x - b.x - b.width, b.y - a.y - a.height, a.y - b.y - b.height);
  assert.ok(gap >= 5.5, `${label}: controls need a real gap, observed ${gap}px`);
}
try {
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const created = await api('post', '', { template_id: 'owner-news', client_mutation_id: randomUUID() });
  const id = created.id, workspace = await api('get', `/${id}/workspace`);
  const doc = workspace.draft.document;
  doc.metadata.audience.job_title_ids = [cargoA];
  const firstBlockId = doc.sections[0].rows[0].columns[0].blocks[0].id;
  doc.sections[0].rows[0].columns[0].blocks[0].style = { align: 'center', scale: 'large', palette: 'warm', font: 'oswald' };
  doc.sections[2].rows[0].layout = 'two_equal';
  doc.sections[2].rows[0].columns.push({ id: randomUUID(), blocks: [{ id: randomUUID(), type: 'callout', tone: 'info', icon: 'info', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Coluna de apoio sintética para conferir o alinhamento.' }] }] } }] });
  await api('put', `/${id}/draft`, { expected_version: workspace.version, client_mutation_id: randomUUID(), document: doc });
  for (const width of [360,402,768,1366,1920]) {
    const visit = await pagesBrowserContext(browser, { width, errors });
    const page = visit.page;
    await page.goto(`${h.origin}/page-editor.html?id=${id}`);
    await pagesBrowserReady(page);
    await page.locator('.ProseMirror').first().waitFor({ state: 'visible' });
    await pagesBrowserReflow(page, AxeBuilder, `polished-editor-idle-${width}`);
    await pagesEditorOrganize(page);
    const section = page.locator('.pages-editor-section').first(), row = section.locator('.pages-editor-row').first();
    const select = row.getByRole('combobox', { name: /Colunas da linha/ });
    const selectStyle = await styleOf(select);
    assert.match(selectStyle.font, /Manrope/i, 'select must use Conecta typography, not native browser font');
    assert.ok(selectStyle.radius >= 6 && selectStyle.height >= 43.5, 'select is a styled 44px control');
    assert.ok(selectStyle.paddingLeft >= 10 && selectStyle.borderStyle === 'solid');
    await separated(section.getByRole('button', { name: 'Subir seção', exact: true }), section.getByRole('button', { name: 'Descer seção', exact: true }), `section actions ${width}`);
    await separated(row.getByRole('button', { name: 'Subir linha', exact: true }), row.getByRole('button', { name: 'Descer linha', exact: true }), `row actions ${width}`);
    const block = page.locator(`[data-block-id="${firstBlockId}"]`);
    const handle = block.locator('.pages-drag-handle'), selection = block.locator('.pages-select-block');
    const handleStyle = await styleOf(handle), selectionStyle = await styleOf(selection);
    assert.match(handleStyle.font, /Manrope/i, 'presentation Oswald must not leak into drag controls');
    assert.match(selectionStyle.font, /Manrope/i, 'presentation Oswald must not leak into selection controls');
    assert.ok(handleStyle.height >= 43.5 && handleStyle.width >= 43.5 && selectionStyle.height >= 43.5);
    await separated(handle, selection, `block header ${width}`);
    await page.screenshot({ path: join(output, `editor-idle-${width}.png`), fullPage: true });
    await selection.click();
    if (width < 1100) await page.getByRole('button', { name: 'Estilo', exact: true }).click();
    const toolbar = page.getByRole('toolbar', { name: 'Ações do bloco selecionado' });
    await toolbar.waitFor({ state: 'visible' });
    for (const label of ['Coluna de destino','Alinhamento','Escala','Paleta','Fonte']) {
      if (width < 1100) await page.getByRole('button', { name: label === 'Coluna de destino' ? 'Posição' : 'Estilo', exact: true }).click();
      const control = toolbar.getByRole('combobox', { name: label, exact: true });
      const style = await styleOf(control);
      assert.match(style.font, /Manrope/i, `${label}: branded font`);
      assert.ok(style.height >= 43.5 && style.radius >= 6, `${label}: consistent control geometry`);
    }
    const font = toolbar.getByRole('combobox', { name: 'Fonte', exact: true });
    await font.selectOption('manrope');
    const snapshot = page.waitForResponse(response => response.request().method() === 'PUT' && new URL(response.url()).pathname === `/api/pages/${id}/draft`);
    await pagesEditorMore(page);
    await page.getByRole('button', { name: /Salvar rascunho/ }).click();
    assert.equal((await snapshot).status(), 200);
    assert.equal((await api('get', `/${id}/workspace`)).draft.document.sections[0].rows[0].columns[0].blocks[0].style.font, 'manrope');
    await pagesBrowserReflow(page, AxeBuilder, `polished-editor-selected-${width}`);
    await toolbar.getByRole('combobox', { name: 'Paleta', exact: true }).selectOption('brand');
    await pagesBrowserReflow(page, AxeBuilder, `polished-editor-brand-palette-${width}`);
    await page.getByRole('toolbar', { name: 'Ações do bloco selecionado' }).getByRole('combobox', { name: 'Paleta', exact: true }).selectOption('warm');
    await page.screenshot({ path: join(output, `editor-selected-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: /Prévia mobile/ }).click();
    await page.locator('.pages-document').waitFor({ state: 'visible' });
    await pagesBrowserReflow(page, AxeBuilder, `polished-editor-preview-${width}`);
    await page.getByRole('button', { name: /^Editar$/ }).click();
    await page.locator('.ProseMirror').first().waitFor({ state: 'visible' });
    results.push({ scenario: 'branded controls, action gaps, styled block isolation, selected toolbar, save and preview reflow/axe', width, pass: true });
    await visit.context.close();
    // Restore the styled fixture for the next viewport through the real draft API.
    const current = await api('get', `/${id}/workspace`);
    await api('put', `/${id}/draft`, { expected_version: current.version, client_mutation_id: randomUUID(), document: doc });
  }
  assert.deepEqual(errors, [], 'browser runtime errors');
  await writeFile(join(output, 'results.json'), JSON.stringify({ results, errors, evidence: 'Chrome/real editor/API/SQL; synthetic Firebase and serialized PGlite. Visual polish evidence, not production acceptance.' }, null, 2));
  console.log(`Pages visual polish PASS: ${results.length} viewports, idle/selected/preview states, branded geometry and WCAG A/AA; artifacts: ${output}`);
} catch (error) {
  for (const [index, page] of (browser?.contexts().flatMap(context => context.pages()) || []).entries()) {
    if (!page.isClosed()) await page.screenshot({ path: join(output, `failure-${index}.png`), fullPage: true }).catch(() => {});
  }
  throw error;
} finally { await browser?.close(); await h.close(); }
