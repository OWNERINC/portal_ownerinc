// Task-owned listeners + Chrome. Real editor, PM, HTTP/SQL and persistence;
// Firebase identity only is synthetic. No external network or existing services.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPagesDatabaseHarness, pageDocument } from '../database/check-pages.mjs';
import { pagesBrowserContext, pagesBrowserReady, pagesEditorOrganize, pagesEditorInsert } from '../helpers/pages-browser.mjs';
import { referenceMedia } from '../helpers/pages-reference-document.mjs';
for (const key of ['PGLITE_MODULE_PATH','PLAYWRIGHT_MODULE_PATH']) if (!process.env[key]) throw Error(`Set external ${key}`);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const require = createRequire(new URL('../../api/package.json', import.meta.url)), express = require('express');
const output = resolve(process.env.INSERTION_VISUAL_OUTPUT || join(tmpdir(), 'opencode', 'pages-insertion'));
await mkdir(output, { recursive: true });
const h = await createPagesDatabaseHarness({ v3WritesEnabled: true }), errors = [], results = [];
let browser;
const blocks = doc => doc.sections.flatMap(s => s.rows.flatMap(r => r.columns.flatMap(c => c.blocks)));
const rich = text => ({ id: randomUUID(), type: 'rich_text', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } });
async function api(method, path, body) { const r = await h.api(method, path, body, 'super'); assert.ok(r.status >= 200 && r.status < 300, `${method} ${path} ${r.status} ${JSON.stringify(r.body)}`); return r.body; }
async function create(doc) {
  const { id } = await api('post', '', { template_id: 'comunicado', client_mutation_id: randomUUID() });
  const w = await api('get', `/${id}/workspace`); await api('put', `/${id}/draft`, { expected_version: w.version, client_mutation_id: randomUUID(), document: doc }); return id;
}
async function visit(id) { const v = await pagesBrowserContext(browser, { width: 1600, errors }); await v.page.goto(h.origin + `/page-editor.html?id=${id}`); await pagesBrowserReady(v.page); await v.page.locator('.ProseMirror').first().waitFor(); return v; }
async function save(page, id) {
  const pending = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/pages/${id}/draft`);
  await page.getByRole('button', { name: /Salvar rascunho/ }).click(); assert.equal((await pending).status(), 200); await page.locator('#page-editor-root[data-save-state=saved]').waitFor();
  return (await api('get', `/${id}/workspace`)).draft.document;
}
async function drag(page, source, target, { cancel = false, below = false } = {}) {
  await source.scrollIntoViewIfNeeded(); await target.scrollIntoViewIfNeeded();
  const a = await source.boundingBox(), b = await target.boundingBox(); assert.ok(a && b);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 7, a.y + a.height / 2 + 7, { steps: 4 }); await page.waitForTimeout(120);
  await page.mouse.move(b.x + b.width / 2, b.y + b.height * (below ? 0.9 : 0.5), { steps: 24 }); await page.waitForTimeout(250);
  if (cancel) await page.keyboard.press('Escape'); await page.mouse.up(); await page.waitForTimeout(100);
}
try {
  h.app.use(express.static(fileURLToPath(new URL('../../public/', import.meta.url))));
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  const doc = pageDocument('Insertion integration'); doc.schema_version = 2; doc.template.version = 2;
  const a = rich('Anchor A'), b = rich('Anchor B'), c = rich('Other section');
  const section = doc.sections[0], row = section.rows[0], column = row.columns[0]; column.blocks = [a,b];
  const other = { id: randomUUID(), label: 'Other', rows: [{ id: randomUUID(), layout: 'single', columns: [{ id: randomUUID(), blocks: [c] }] }] }; doc.sections.push(other);
  const id = await create(doc), { page, context } = await visit(id);
  const select = block => page.locator(`[data-block-id="${block.id}"] .pages-select-block`).click();
  const panel = () => page.getByRole('dialog', { name: 'O que você quer adicionar?' });
  const pm = page.locator(`[data-block-id="${a.id}"] .ProseMirror`);
  await pm.evaluate(n => { globalThis.identity = { node: n, view: n.pmViewDesc }; });
  await select(a); await page.getByRole('button', { name: 'Inserir bloco', exact: true }).click();
  assert.equal(await panel().locator('.pages-insert-panel-content > .pages-insert-actions > button').count(), 7);
  const primary=panel().locator('.pages-insert-panel-content > .pages-insert-actions > button');
  const primaryGeometry=await primary.evaluateAll(nodes=>nodes.map(n=>{
    const icon=n.querySelector('svg').getBoundingClientRect();
    return {height:n.getBoundingClientRect().height,icon:{x:icon.x,y:icon.y,width:icon.width,height:icon.height},title:n.querySelector('span').textContent};
  }));
  assert.deepEqual(primaryGeometry.map(r=>r.title),['Texto','Imagem ou GIF','Vídeo','Áudio','Galeria','Duas colunas','Destaque ou botão']);
  for(const [i,r]of primaryGeometry.entries()){
    assert.equal(r.height,64);assert.equal(r.icon.width,16);assert.equal(r.icon.height,16);
    if(i)assert.equal(r.icon.y-primaryGeometry[i-1].icon.y-primaryGeometry[i-1].icon.height,48);
  }
  // Native Tab/Enter scroll the real additional controls into view, without
  // shifting/compressing the seven source rows or using programmatic clicks.
  await panel().getByRole('searchbox',{name:'Buscar bloco'}).focus();
  for(let i=0;i<7;i++)await page.keyboard.press('Tab');
  assert.equal(await primary.last().evaluate(n=>n===document.activeElement),true);
  await page.keyboard.press('Tab');
  const extras=panel().locator('summary').filter({hasText:'Outros blocos'});
  const focusedVisible=loc=>loc.evaluate(n=>{const r=n.getBoundingClientRect(),d=n.closest('dialog').getBoundingClientRect();return n===document.activeElement&&r.top>=d.top&&r.bottom<=d.bottom;});
  assert.equal(await focusedVisible(extras),true);
  await page.keyboard.press('Enter');await page.keyboard.press('Tab');
  assert.equal(await focusedVisible(panel().getByRole('button',{name:'Adicionar FAQ',exact:true})),true);
  await page.keyboard.press('Tab');
  assert.equal(await focusedVisible(panel().getByRole('button',{name:'Adicionar separador',exact:true})),true);
  await page.keyboard.press('Tab');
  assert.equal(await focusedVisible(panel().getByRole('combobox',{name:'Ponto de inserção'})),true);
  assert.ok(await panel().locator('.pages-insert-panel-content').evaluate(n=>n.scrollTop>0),'extra controls require real native body scrolling under the retained heading');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button',{name:'Inserir bloco',exact:true}).evaluate(n=>n===document.activeElement),true);
  assert.deepEqual((await api('get',`/${id}/workspace`)).draft.document,doc);
  await page.getByRole('button',{name:'Inserir bloco',exact:true}).click();
  results.push({scenario:'source row geometry/capitalization and native keyboard scroll to FAQ/separator/insertion point',pass:true,primaryGeometry});
  await panel().getByRole('searchbox', { name: 'Buscar bloco' }).fill('naoexiste'); await panel().getByText('Nenhum bloco encontrado.', { exact: true }).waitFor();
  await panel().getByRole('searchbox', { name: 'Buscar bloco' }).fill('botao'); await panel().getByRole('button', { name: 'Adicionar botão', exact: true }).waitFor();
  const combined = panel().getByRole('button', { name: 'Destaque ou botão', exact: true }), choices = panel().getByRole('group', { name: 'Escolha destaque ou botão', exact: true });
  assert.equal(await combined.getAttribute('aria-expanded'), 'true', 'search disclosure must be announced');
  assert.equal(await combined.getAttribute('aria-controls'), await choices.getAttribute('id')); assert.ok(await choices.getAttribute('id'));
  await panel().getByRole('searchbox', { name: 'Buscar bloco' }).fill('naoexiste');
  assert.equal(await panel().locator('[aria-label="Destaque ou botão"]').getAttribute('aria-expanded'), 'false');
  await panel().getByRole('searchbox', { name: 'Buscar bloco' }).fill(''); assert.equal(await combined.getAttribute('aria-expanded'), 'false');
  await page.keyboard.press('Escape'); assert.equal(await page.getByRole('button', { name: 'Inserir bloco', exact: true }).evaluate(n => n === document.activeElement), true);
  await page.getByRole('button', { name: 'Inserir bloco', exact: true }).click();
  await panel().getByRole('button', { name: 'Destaque ou botão', exact: true }).click();
  await panel().getByRole('button', { name: 'Adicionar botão', exact: true }).press('Enter');
  let order = await page.locator(`[data-column-id="${column.id}"] > [data-block-id]`).evaluateAll(ns => ns.map(n => n.dataset.blockId));
  assert.equal(order[0], a.id); assert.equal(order[2], b.id); const buttonId = order[1];
  await select(b); await page.getByRole('button', { name: 'Inserir bloco', exact: true }).click();
  await panel().locator('summary').filter({hasText:'Outros blocos'}).click();
  await panel().getByRole('combobox', { name: 'Ponto de inserção' }).selectOption('before');
  await panel().getByRole('button', { name: 'Adicionar texto', exact: true }).click();
  order = await page.locator(`[data-column-id="${column.id}"] > [data-block-id]`).evaluateAll(ns => ns.map(n => n.dataset.blockId)); assert.equal(order[3], b.id);
  await select(a); await pagesEditorInsert(page, 'Adicionar duas colunas');
  assert.equal(await page.locator(`[data-row-id="${row.id}"] [data-column-id]`).count(), 1, 'new group did not convert selected row');
  const newRowId = await page.locator('.pages-editor-section').first().locator('[data-row-id]').nth(1).getAttribute('data-row-id');
  const newCols = await page.locator(`[data-row-id="${newRowId}"] [data-column-id]`).evaluateAll(ns => ns.map(n => n.dataset.columnId)); assert.equal(newCols.length, 2);
  await page.locator(`[data-column-id="${newCols[1]}"]`).getByRole('button', { name: 'Inserir nesta coluna' }).click();
  await panel().getByRole('button', { name: 'Adicionar texto', exact: true }).click();
  assert.equal(await page.locator(`[data-column-id="${newCols[1]}"] > [data-block-id]`).count(), 1);
  await select(a); await page.getByRole('combobox', { name: 'Largura do bloco' }).selectOption('half');
  await page.getByRole('combobox', { name: 'Largura do bloco' }).selectOption('full'); await page.getByRole('dialog', { name: 'Unir colunas?' }).getByRole('button', { name: 'Cancelar', exact: true }).click();
  assert.equal(await page.locator(`[data-row-id="${row.id}"] [data-column-id]`).count(), 2);
  await page.keyboard.press('Control+z'); assert.equal(await page.locator(`[data-row-id="${row.id}"] [data-column-id]`).count(), 1, 'merge cancel had no history entry');
  await page.keyboard.press('Control+y');
  await pagesEditorOrganize(page);
  const layout = page.locator(`[data-row-id="${row.id}"] select`).first(); await layout.selectOption('aside_right');
  assert.equal(await page.locator(`[data-row-id="${row.id}"] .pages-row`).getAttribute('class'), 'pages-row pages-row-aside_right');
  await layout.selectOption('single'); await page.getByRole('dialog', { name: 'Unir colunas?' }).getByRole('button', { name: 'Unir colunas', exact: true }).click();
  order = await page.locator(`[data-column-id="${column.id}"] > [data-block-id]`).evaluateAll(ns => ns.map(n => n.dataset.blockId)); assert.ok(order.includes(buttonId)); assert.equal(order.at(-1), b.id);
  assert.equal(await pm.evaluate(n => n === identity.node && n.pmViewDesc === identity.view), true);
  const persisted = await save(page, id); assert.equal(persisted.schema_version, 3); assert.equal(persisted.sections[0].rows[1].layout, 'two_equal');
  await page.reload(); await pagesBrowserReady(page); await pm.waitFor();
  assert.deepEqual(await page.locator('.pages-editor-block').evaluateAll(ns => ns.map(n => n.dataset.blockId)), blocks(persisted).map(b => b.id));
  results.push({ scenario: 'catalog/search/combined keyboard, before/after point, actual new group/empty column, width/merge cancel/undo/aside, PM identity and SQL reload', pass: true });
  console.log('PASS point/catalog/layout/history/PM/SQL persistence');
  // Actual session zoom, not a synthetic transform. The section rail remains
  // unscaled (Task 14); scaling its clipped 220px box would miss the real handle.
  for (const scale of [0.5,1,1.5]) {
    await pagesEditorOrganize(page); await select(a); await page.getByRole('combobox', { name: 'Largura do bloco' }).selectOption('half');
    const cols = await page.locator(`[data-row-id="${row.id}"] [data-column-id]`).evaluateAll(ns => ns.map(n => n.dataset.columnId));
    await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption(String(scale * 100));
    await drag(page, page.locator(`[data-block-id="${a.id}"] .pages-drag-handle`), page.locator(`[data-column-id="${cols[1]}"]`));
    assert.equal(await page.locator(`[data-column-id="${cols[1]}"] > [data-block-id="${a.id}"]`).count(), 1, `block mouse drop ${scale}`);
    await page.keyboard.press('Control+z'); assert.equal(await page.locator(`[data-column-id="${cols[0]}"] > [data-block-id="${a.id}"]`).count(), 1);
    assert.equal(await page.locator('.pages-v2-section-list').evaluate(n => getComputedStyle(n).transform), 'none', 'section rail must not zoom with content');
    await drag(page, page.locator(`[data-section-sort-id="${section.id}"] .pages-section-drag-handle`), page.locator(`[data-section-sort-id="${other.id}"]`), { below: true });
    assert.deepEqual(await page.locator('.pages-blocks > [data-section-id]').evaluateAll(ns => ns.map(n => n.dataset.sectionId)), [other.id,section.id], `section mouse drop ${scale}`);
    await page.keyboard.press('Control+z');
    await drag(page, page.locator(`[data-section-sort-id="${section.id}"] .pages-section-drag-handle`), page.locator(`[data-section-sort-id="${other.id}"]`), { cancel: true, below: true });
    assert.deepEqual(await page.locator('[data-section-sort-id]').evaluateAll(ns => ns.map(n => n.dataset.sectionSortId)), [section.id,other.id], 'Escape drop restores nav');
    await page.screenshot({ path: join(output, `insertion-${scale}.png`), fullPage: true });
    console.log(`PASS actual pointer/block + unscaled section drag at ${scale * 100}% session zoom`);
    results.push({ scenario: `mouse block and section drop + Escape restoration at ${scale * 100}% session zoom`, pass: true });
  }
  await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('100');
  const nav = page.locator(`[data-structure-section="${section.id}"]`); await nav.focus(); await nav.press('Alt+ArrowDown');
  assert.deepEqual(await page.locator('.pages-blocks > [data-section-id]').evaluateAll(ns => ns.map(n => n.dataset.sectionId)), [other.id,section.id]);
  await page.locator(`[data-structure-section="${section.id}"]`).press('Alt+ArrowUp');
  assert.deepEqual(await page.locator('.pages-blocks > [data-section-id]').evaluateAll(ns => ns.map(n => n.dataset.sectionId)), [section.id,other.id]);
  await page.locator(`[data-section-sort-id="${section.id}"] details summary`).click();
  await page.getByRole('button', { name: `Descer seção ${section.label}`, exact: true }).click();
  assert.deepEqual(await page.locator('.pages-blocks > [data-section-id]').evaluateAll(ns => ns.map(n => n.dataset.sectionId)), [other.id,section.id]);
  await page.keyboard.press('Control+z');
  assert.deepEqual(await page.locator('.pages-blocks > [data-section-id]').evaluateAll(ns => ns.map(n => n.dataset.sectionId)), [section.id,other.id]);
  await select(a); await page.getByRole('button', { name: 'Inserir bloco', exact: true }).click();
  await panel().getByRole('searchbox', { name: 'Buscar bloco' }).fill('FAQ'); await panel().getByRole('button', { name: 'Adicionar FAQ', exact: true }).click();
  await select(a); await pagesEditorInsert(page, 'Adicionar galeria');
  const withPlaceholders = await save(page, id); assert.deepEqual(blocks(withPlaceholders).filter(b => ['faq','gallery'].includes(b.type)).map(b => b.items), [[],[]]);
  // Upload begins from a captured point, even if active selection changes while
  // actual SQL registration is pending. No reference before the real ACK.
  await select(a); await page.getByRole('button', { name: 'Inserir bloco', exact: true }).click();
  const chooser = page.waitForEvent('filechooser'); await panel().getByRole('button', { name: 'Adicionar imagem ou GIF', exact: true }).click();
  const asset = referenceMedia()[0]; let release, entered; const held = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  await context.route(`**/api/pages/${id}/media`, async route => { entered(); await held; await route.continue(); }, { times: 1 });
  await (await chooser).setFiles({ name: asset.file_name, mimeType: 'image/webp', buffer: asset.bytes }); await started;
  await select(c); assert.equal(await page.locator('[data-block-type=image]').count(), 0); release();
  await page.locator('[data-block-type=image]').waitFor(); const uploaded = await save(page, id);
  const originBlocks = uploaded.sections.find(s => s.id === section.id).rows[0].columns[0].blocks;
  assert.equal(originBlocks.findIndex(b => b.type === 'image'), originBlocks.findIndex(b => b.id === a.id) + 1);
  assert.equal(blocks(uploaded).filter(b => b.type === 'image').length, 1);
  const sql = await h.db.query('SELECT count(*)::int AS count FROM page_revision_media WHERE revision_id = (SELECT draft_revision_id FROM pages WHERE id = $1)', [id]); assert.equal(sql.rows[0].count, 1);
  await context.close(); results.push({ scenario: 'section Alt+arrows, valid v3-only empty placeholders, actual upload ACK captured origin and SQL reference', pass: true }); console.log('PASS keyboard/placeholders/upload stable point + media SQL');
  const disabled = await createPagesDatabaseHarness();
  try {
    disabled.app.use(express.static(fileURLToPath(new URL('../../public/', import.meta.url))));
    const created = await disabled.api('post', '', { template_id: 'comunicado', client_mutation_id: randomUUID() }, 'super'); assert.equal(created.status, 201);
    const v = await pagesBrowserContext(browser, { width: 1600, errors });
    await v.page.goto(disabled.origin + `/page-editor.html?id=${created.body.id}`); await pagesBrowserReady(v.page); await v.page.locator('.ProseMirror').first().waitFor();
    await v.page.getByRole('button', { name: 'Inserir bloco', exact: true }).click();
    const p = v.page.getByRole('dialog', { name: 'O que você quer adicionar?' });
    assert.equal(await p.getByRole('button', { name: 'Adicionar galeria', exact: true }).isDisabled(), true);
    await p.getByRole('searchbox', { name: 'Buscar bloco' }).fill('FAQ'); assert.equal(await p.getByRole('button', { name: 'Adicionar FAQ', exact: true }).isDisabled(), true);
    await v.page.keyboard.press('Escape'); await pagesEditorOrganize(v.page);
    assert.equal(await v.page.locator('option[value=aside_right]').first().isDisabled(), true);
    const unchanged = await disabled.api('get', `/${created.body.id}/workspace`, undefined, 'super'); assert.deepEqual(unchanged.body.document_support.write_versions, [1,2]); assert.equal(unchanged.body.draft.document.schema_version, 1);
    await v.context.close(); results.push({ scenario: 'actual default-false router support disables v3 insertion/layout and retains v1', pass: true }); console.log('PASS default-false actual router/UI v3 gating');
  } finally { await disabled.close(); }
  // Clean saved near-budget draft: the real image ACK is registered, but the
  // candidate reference exceeds document bytes. Recovery is NOT a dirty edit.
  const budgetDoc = pageDocument('Clean upload placement recovery'); budgetDoc.schema_version = 2; budgetDoc.template.version = 2;
  const budgetContent = Array.from({ length: 470 }, () => ({ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: '/' + 'a'.repeat(2047) } }] }));
  blocks(budgetDoc)[0].content = { type: 'doc', content: [{ type: 'paragraph', content: budgetContent }] };
  budgetContent[0].text += 'x'.repeat(1048446 - Buffer.byteLength(JSON.stringify(budgetDoc)));
  const budgetId = await create(budgetDoc), v = await visit(budgetId);
  const undoRecovery = v.page.locator('.pages-recovery-actions button').filter({ hasText: 'Desfazer exclusão' });
  let workspaceRequests = 0, uploadRequests = 0;
  v.page.on('request', request => { if (new URL(request.url()).pathname === `/api/pages/${budgetId}/workspace`) workspaceRequests++; if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/pages/${budgetId}/media`) uploadRequests++; });
  // This HTTP-saveable fixture has 130 bytes of headroom: half-width fits,
  // while a new two-column row and uploaded image reference do not. The exact
  // 50-byte-headroom half-width rejection is covered by the pure unit fixture.
  await v.page.getByRole('combobox', { name: 'Largura do bloco' }).selectOption('half');
  assert.equal(await v.page.locator('.pages-editor-row [data-column-id]').count(), 2); await undoRecovery.click();
  assert.equal(await v.page.locator('.pages-editor-row [data-column-id]').count(), 1);
  assert.equal(await v.page.getByRole('combobox', { name: 'Largura do bloco' }).inputValue(), 'full');
  await pagesEditorInsert(v.page, 'Adicionar duas colunas');
  assert.equal(await v.page.locator('.pages-editor-row').count(), 1); assert.equal(await undoRecovery.isDisabled(), true);
  const uploadedAck = v.page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/pages/${budgetId}/media`);
  await v.page.locator('input[type=file]').setInputFiles({ name: asset.file_name, mimeType: 'image/webp', buffer: asset.bytes }); assert.equal((await uploadedAck).status(), 201);
  const recovery = v.page.getByRole('button', { name: 'Escolher destino para arquivo enviado', exact: true }); await recovery.waitFor();
  assert.equal(await v.page.locator('#page-editor-root').getAttribute('data-save-state'), 'saved');
  await v.page.getByRole('button', { name: 'Página', exact: true }).click();
  assert.equal(await v.page.getByRole('button', { name: /Salvar rascunho/ }).isDisabled(), true);
  assert.equal(await undoRecovery.isDisabled(), true);
  let prompt; v.page.once('dialog', async dialog => { prompt = dialog.message(); await dialog.dismiss(); });
  await v.page.getByRole('button', { name: 'Recarregar versão salva', exact: true }).click(); await v.page.waitForTimeout(100);
  assert.match(prompt || '', /arquivo já enviado/i); assert.match(prompt, /não.*desfeit/i);
  assert.equal(workspaceRequests, 0); assert.equal(await recovery.isVisible(), true);
  await v.page.getByRole('button', { name: 'Arquivar', exact: true }).click(); assert.equal(await v.page.locator('dialog[open]').count(), 0); assert.equal(await recovery.isVisible(), true);
  await recovery.click(); await v.page.getByRole('dialog', { name: 'Escolha um novo destino', exact: true }).waitFor(); await v.page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  v.page.once('dialog', dialog => dialog.accept());
  const reload = v.page.waitForResponse(r => new URL(r.url()).pathname === `/api/pages/${budgetId}/workspace`);
  await v.page.getByRole('button', { name: 'Recarregar versão salva', exact: true }).click(); assert.equal((await reload).status(), 200); await pagesBrowserReady(v.page);
  assert.equal(workspaceRequests, 1); assert.equal(uploadRequests, 1); assert.equal(await recovery.isVisible(), false);
  const media = await h.db.query('SELECT (SELECT count(*)::int FROM page_media WHERE page_id = $1) AS files, (SELECT count(*)::int FROM page_revision_media WHERE page_id = $1) AS refs', [budgetId]);
  assert.deepEqual(media.rows[0], { files: 1, refs: 0 }, 'explicit abandonment never deletes the ACKed file or fabricates a revision reference');
  await v.context.close(); results.push({ scenario: 'near-byte-limit layout/row commands stay clean; real upload ACK unplaced on CLEAN draft, cancelled reload retains handle/archive blocked, explicit reload abandons placement only', pass: true }); console.log('PASS R1 clean pending placement/reload/archive + final candidate budgets + ARIA disclosure');
  assert.deepEqual(errors, []); await writeFile(join(output, 'results.json'), JSON.stringify({ synthetic: true, results, errors }, null, 2));
} finally { await browser?.close(); await h.close(); }
