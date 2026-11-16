// Publication-only v3 parity through actual controls and owned HTTP/SQL.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createPagesDatabaseHarness, pageDocument } from '../database/check-pages.mjs';
import { pagesBrowserContext, pagesBrowserReady, pagesEditorInsert } from '../helpers/pages-browser.mjs';
import { upgradeDocument } from '../../public/pages/document-v3.js';

for (const key of ['PGLITE_MODULE_PATH', 'PLAYWRIGHT_MODULE_PATH']) if (!process.env[key]) throw Error(`Set external ${key}`);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const require = createRequire(new URL('../../api/package.json', import.meta.url)), express = require('express');
const h = await createPagesDatabaseHarness({ v3WritesEnabled: true });
const output = resolve(process.env.PREFLIGHT_VISUAL_OUTPUT || join(tmpdir(), 'opencode', 'pages-publication-preflight'));
await mkdir(output, { recursive: true });
const results = [], errors = [], payloads = [];
let browser;
const key = () => ({ client_mutation_id: randomUUID() });
async function api(method, path, body, actor = 'super') {
  const response = await h.api(method, path, body, actor);
  assert.ok(response.status >= 200 && response.status < 300, `${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}
async function create(doc) {
  const { id } = await api('post', '', { template_id: 'comunicado', ...key() });
  await api('put', `/${id}/draft`, { expected_version: 0, ...key(), document: doc });
  return id;
}
async function visit(id) {
  const view = await pagesBrowserContext(browser, { width: 1600, errors });
  view.page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith(`/${id}/publish`)) payloads.push({ id, body: request.postDataJSON() });
  });
  await view.page.goto(`${h.origin}/page-editor.html?id=${id}`); await pagesBrowserReady(view.page);
  await view.page.locator('#page-editor-root[data-save-state=saved]').waitFor();
  return view;
}
async function save(page, id) {
  const response = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith(`/${id}/draft`));
  await page.getByRole('button', { name: 'Salvar rascunho', exact: true }).click();
  assert.equal((await response).status(), 200);
  await page.locator('#page-editor-root[data-save-state=saved]').waitFor();
  return api('get', `/${id}/workspace`);
}
async function review(page) {
  await page.getByRole('button', { name: 'Publicar', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Pronto para compartilhar?' });
  await dialog.waitFor();
  await page.waitForFunction(() => !document.querySelector('.pages-review-checks input').disabled);
  return dialog;
}
const publish = dialog => dialog.getByRole('button', { name: 'Publicar página', exact: true });
try {
  h.app.use(express.static(fileURLToPath(new URL('../../public/', import.meta.url))));
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const doc = upgradeDocument(pageDocument('FAQ sem texto auxiliar'));
  doc.sections[0].rows[0].columns[0].blocks = [];
  const id = await create(doc), { page, context } = await visit(id);
  await pagesEditorInsert(page, 'Adicionar FAQ');
  await page.getByRole('button', { name: 'Adicionar pergunta', exact: true }).click();
  await page.getByRole('textbox', { name: 'Pergunta', exact: true }).fill('Como consultar este guia?');
  await page.locator('[data-faq-answer] .ProseMirror').fill('Leia a resposta completa desta FAQ sintética.');
  const saved = await save(page, id);
  const blocks = saved.draft.document.sections[0].rows[0].columns[0].blocks;
  assert.deepEqual(blocks.map(block => block.type), ['faq']);
  assert.equal(blocks[0].items[0].question, 'Como consultar este guia?');
  await page.reload(); await pagesBrowserReady(page);
  await page.locator('#page-editor-root[data-save-state=saved]').waitFor();
  const dialog = await review(page);
  assert.equal(await publish(dialog).isEnabled(), true, 'FAQ-only saved revision is publishable');
  assert.equal(await publish(dialog).getAttribute('title'), '');
  await page.screenshot({ path: join(output, 'faq-only-review.png') });
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/${id}/publish`));
  await publish(dialog).click(); assert.equal((await response).status(), 200); await dialog.waitFor({ state: 'hidden' });
  const head = await api('get', `/${id}/workspace`);
  assert.equal(head.published_revision_id, saved.draft_revision_id);
  assert.deepEqual(payloads.filter(p => p.id === id).map(p => p.body.revision_id), [saved.draft_revision_id]);
  await context.close();
  const reader = await pagesBrowserContext(browser, { uid: 'reader', width: 1366, errors });
  await reader.page.goto(`${h.origin}/pages.html?id=${id}`); await pagesBrowserReady(reader.page);
  const faq = reader.page.locator('.pages-v3-faq details'); await faq.waitFor();
  await faq.locator('summary').click();
  assert.match(await faq.innerText(), /Leia a resposta completa desta FAQ sintética/);
  assert.equal(await faq.evaluate(node => node.open), true);
  assert.deepEqual((await api('get', `/${id}`, undefined, 'reader')).document, saved.draft.document);
  assert.equal((await h.api('get', `/${id}`, undefined, 'outsider')).status, 404);
  await reader.page.screenshot({ path: join(output, 'faq-only-reader.png') }); await reader.context.close();
  results.push({ scenario: 'FAQ inserted/authored in UI, explicit save, reload, review, exact publication and authorized reader', revision: saved.draft_revision_id });

  const incomplete = upgradeDocument(pageDocument('Blocos incompletos'));
  incomplete.sections[0].rows[0].columns[0].blocks.push(
    { id: randomUUID(), type: 'gallery', items: [] },
    { id: randomUUID(), type: 'gallery', items: [{ id: randomUUID(), kind: 'gif', media_id: null, alt: '', caption: '', credit: '' }] },
    { id: randomUUID(), type: 'faq', items: [] },
    { id: randomUUID(), type: 'faq', items: [{ id: randomUUID(), question: '', answer: { type: 'doc', content: [{ type: 'paragraph' }] } }] },
    { id: randomUUID(), type: 'video_embed', provider: 'youtube', video_id: 'aB3_-dE6Fg7', title: '', transcript: '' },
  );
  const invalidId = await create(incomplete), invalid = await visit(invalidId), p = invalid.page;
  await p.locator('.ProseMirror').first().fill('Texto válido não completa os outros blocos.');
  const invalidSaved = await save(p, invalidId);
  const d = await review(p), action = publish(d);
  assert.equal(await action.isDisabled(), true);
  const issues = await action.getAttribute('title');
  for (const pattern of [/Galeria \(bloco 2\).*adicione/, /Galeria \(bloco 3\), item 1.*arquivo/, /Galeria \(bloco 3\), item 1.*alternativo/,
    /FAQ \(bloco 4\).*adicione/, /FAQ \(bloco 5\), item 1.*pergunta/, /FAQ \(bloco 5\), item 1.*resposta/,
    /Vídeo incorporado \(bloco 6\).*título/, /Vídeo incorporado \(bloco 6\).*transcrição/]) assert.match(issues, pattern);
  const descriptionId = await action.getAttribute('aria-describedby');
  assert.equal(await p.locator(`#${descriptionId}`).textContent(), issues, 'same actionable messages exposed to assistive technology');
  await d.getByRole('checkbox', { name: 'Conteúdo revisado pelo responsável', exact: true }).check();
  await action.dispatchEvent('click'); // Defensive handler must also reject scripted activation.
  assert.equal(await action.isDisabled(), true);
  assert.deepEqual(payloads.filter(p => p.id === invalidId), [], 'no publication POST for incomplete blocks');
  const invalidHead = await api('get', `/${invalidId}/workspace`);
  assert.equal(invalidHead.published_revision_id, null);
  assert.equal(invalidHead.draft_revision_id, invalidSaved.draft_revision_id);
  await p.screenshot({ path: join(output, 'incomplete-review.png') }); await invalid.context.close();
  results.push({ scenario: 'incomplete gallery/FAQ/embed save as drafts; block/item/field preflight before POST, optional checks cannot bypass', issues, publicationPosts: 0 });
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'results.json'), JSON.stringify({ results, payloads, errors, browser: browser.version(), evidence: 'Actual Chrome, production modules, HTTP/SQL in serialized PGlite, synthetic identity, owned loopback. Native services and visual acceptance remain pending.' }, null, 2));
  console.log(`Pages publication preflight PASS: ${results.length} scenario groups; artifacts: ${output}`);
} catch (error) {
  for (const [i, page] of (browser?.contexts().flatMap(c => c.pages()) || []).entries()) if (!page.isClosed()) await page.screenshot({ path: join(output, `failure-${i}.png`), fullPage: true }).catch(() => {});
  throw error;
} finally { await browser?.close(); await h.close(); }
