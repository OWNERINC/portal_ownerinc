// Task 17 integration seam: actual UI/PM -> HTTP -> SQL -> reload -> shared
// preview -> exact publication -> cargo reader. Feature fixture, never a golden.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPagesDatabaseHarness, cargoA } from '../database/check-pages.mjs';
import { referenceIds as ids, referenceMedia } from '../helpers/pages-reference-document.mjs';
import { pagesBrowserContext, pagesBrowserReady, pagesEditorInsert, pagesEditorPreview, pagesFeatureDocument } from '../helpers/pages-browser.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const blocks = doc => doc.sections.flatMap(s => s.rows.flatMap(r => r.columns.flatMap(c => c.blocks)));
const textNodes = node => node.type === 'text' ? [node] : (node.content || []).flatMap(textNodes);
const key = () => ({ client_mutation_id: randomUUID() });

export async function checkPagesFeatureRoundtrip(browser, output) {
  await mkdir(output, { recursive: true });
  const h = await createPagesDatabaseHarness({ v3WritesEnabled: true });
  const results = [], errors = [], contexts = [], requests = [], legacyEvidence = [];
  const api = async (method, path, body, actor = 'super') => {
    const r = await h.api(method, path, body, actor);
    assert.ok(r.status >= 200 && r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const workspace = id => api('get', `/${id}/workspace`);
  const visit = async (path, uid = 'super') => {
    const v = await pagesBrowserContext(browser, { width: 1600, uid, errors }); contexts.push(v.context);
    v.context.setDefaultTimeout(15000);
    v.page.on('request', r => { if (new URL(r.url()).origin === h.origin && r.method() !== 'GET') requests.push({ method: r.method(), path: new URL(r.url()).pathname, body: r.postData()?.startsWith('{') ? r.postDataJSON() : 'multipart' }); });
    await v.page.goto(h.origin + path); await pagesBrowserReady(v.page); return v;
  };
  const save = async (p, id) => {
    const response = p.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/pages/${id}/draft`);
    await p.keyboard.press('Control+s'); assert.equal((await response).status(), 200);
    await p.locator('#page-editor-root[data-save-state=saved]').waitFor(); return workspace(id);
  };
  try {
    h.app.use(require('express').static(fileURLToPath(new URL('../../public/', import.meta.url))));
    // Legacy screenshot + computed-style invariance across open/cancel/no-op/
    // preview. The first successful opt-in remains one undo before explicit save.
    for (const template of ['comunicado', 'owner-news']) {
      const { id } = await api('post', '', { template_id: template, ...key() });
      const before = await workspace(id), v = await visit(`/page-editor.html?id=${id}`), p = v.page;
      // Fit the complete legacy document: locator screenshots taller than a
      // scroll-clipped canvas include unrelated viewport pixels after auto-scroll.
      await p.setViewportSize({ width: 1600, height: 2400 });
      await p.locator('.ProseMirror').first().waitFor();
      const capture = async name => {
        await pagesEditorPreview(p, 'desktop'); await p.locator('.pages-document').waitFor();
        await p.evaluate(() => document.fonts.ready);
        const computed = await p.locator('.pages-document').evaluate(n => [...n.querySelectorAll('p,h2,h3,figcaption')].map(el => { const s = getComputedStyle(el); return [el.textContent, s.fontFamily, s.fontSize, s.color, s.backgroundColor, s.textAlign]; }));
        const png = await p.locator('.pages-document').screenshot({ path: join(output, `${template}-${name}.png`), animations: 'disabled', caret: 'hide' });
        await pagesEditorPreview(p, 'edit'); return { computed, hash: createHash('sha256').update(png).digest('hex') };
      };
      const initial = await capture('before');
      await p.getByRole('button', { name: 'Estilo da página', exact: true }).click(); await p.keyboard.press('Escape');
      await p.getByRole('button', { name: 'Estilo da página', exact: true }).click();
      await p.getByRole('button', { name: '✓ Aplicar estilo', exact: true }).click();
      assert.equal(await p.locator('#page-editor-root').getAttribute('data-save-state'), 'saved');
      const after = await capture('after'); assert.deepEqual(after.computed, initial.computed); assert.equal(after.hash, initial.hash, `${template}: unchanged preview pixels`);
      assert.deepEqual(await workspace(id), before);
      await p.getByRole('button', { name: 'Estilo da página', exact: true }).click();
      await p.getByRole('combobox', { name: 'Fonte da página', exact: true }).selectOption('oswald');
      await p.getByRole('button', { name: '✓ Aplicar estilo', exact: true }).click();
      assert.equal(await p.locator('#page-editor-root').getAttribute('data-save-state'), 'dirty');
      assert.deepEqual(await workspace(id), before, 'successful local opt-in is not a write');
      await p.getByRole('button', { name: 'Desfazer exclusão', exact: true }).click();
      assert.equal(await p.locator('#page-editor-root').getAttribute('data-save-state'), 'saved');
      const undone = await capture('undo');
      assert.equal(undone.hash, initial.hash, `${template}: undo restores preview pixels`);
      legacyEvidence.push({ template, viewport: p.viewportSize(), before: initial, after, undo: undone });
      await p.keyboard.press('Control+y'); assert.equal((await save(p, id)).draft.document.schema_version, 3);
      await v.context.close(); results.push(`${template}: exact legacy pixels/computed/SQL across cancel/no-op/preview; atomic undo, explicit v3 save`);
    }

    const { id, slug } = await api('post', '', { template_id: 'guia-interno', ...key() });
    const feature = await pagesFeatureDocument(h, id, cargoA);
    await api('put', `/${id}/draft`, { expected_version: 0, ...key(), document: feature });
    const v = await visit(`/page-editor.html?id=${id}`), p = v.page;
    const select = async blockId => p.locator(`[data-block-id="${blockId}"] .pages-select-block`).click();
    const intro = p.locator(`[data-block-id="${ids.introductionBlock}"] .ProseMirror`);
    await intro.waitFor();
    await intro.evaluate(n => { globalThis.__integratedPM = { n, view: n.pmViewDesc }; });
    await intro.click(); await intro.press('Control+End'); await intro.press('Home'); await intro.press('Shift+End');
    const selection = await p.evaluate(() => getSelection().toString()); assert.ok(selection.length);
    for (const name of ['Negrito', 'Itálico', 'Sublinhado']) await p.getByRole('button', { name, exact: true }).click();
    await p.getByRole('button', { name: 'Link', exact: true }).click();
    await p.getByRole('dialog', { name: 'Link no texto selecionado' }).getByRole('textbox').fill('/pages.html');
    await p.getByRole('button', { name: 'Aplicar link', exact: true }).click();
    for (const [name, hex] of [['Cor do texto selecionado', '#123456'], ['Realce do texto selecionado', '#F7F6F2']]) {
      await p.getByRole('button', { name, exact: true }).click(); const panel = p.getByRole('dialog', { name, exact: true });
      await panel.getByRole('textbox', { name: 'Cor hexadecimal' }).fill(hex); await panel.getByRole('button', { name: 'Aplicar cor', exact: true }).click();
    }
    const inspector = p.locator('.pages-style-inspector');
    for (const [name, value] of [['Tipografia','source-serif-4'], ['Tamanho','large'], ['Alinhamento','center'], ['Fundo do bloco','#FFFFFF'], ['Ícone','check']]) await inspector.getByRole('combobox', { name, exact: true }).selectOption(value);
    await inspector.getByRole('textbox', { name: 'Tags do bloco' }).fill('Integração, Guia'); await inspector.getByRole('textbox', { name: 'Tags do bloco' }).press('Tab');
    await inspector.getByRole('combobox', { name: 'Largura do bloco' }).selectOption('half');
    await inspector.getByRole('button', { name: 'Duplicar', exact: true }).click();
    await p.getByRole('button', { name: 'Desfazer exclusão', exact: true }).click(); await p.keyboard.press('Control+y');
    const duplicated = await p.locator('[data-block-type=rich_text]').count(); assert.equal(duplicated, 5);
    await p.getByRole('button', { name: 'Organizar estrutura', exact: true }).click();
    await p.locator(`[data-section-id="${ids.gallerySection}"]`).getByRole('button', { name: 'Subir seção', exact: true }).click();
    await p.getByRole('button', { name: 'Organizar estrutura', exact: true }).click();
    await select(ids.galleryBlock);
    const image = referenceMedia()[0];
    const uploaded = p.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/${id}/media`));
    await p.getByLabel('Adicionar imagens à galeria', { exact: true }).setInputFiles({ name: image.file_name, mimeType: image.mime_type, buffer: image.bytes }); const uploadResponse=await uploaded; assert.equal(uploadResponse.status(), 201);
    const uploadedMedia=(await uploadResponse.json()).media_id;
    const item = p.locator('.pages-v2-content-fields [data-media-item-id]').last();
    await item.getByRole('textbox', { name: 'Texto alternativo', exact: true }).fill('Nova imagem integrada');
    await item.getByRole('textbox', { name: 'Legenda', exact: true }).fill('Nova legenda integrada');
    await item.getByRole('textbox', { name: 'Crédito', exact: true }).fill('Autoria sintética');
    await item.getByRole('button', { name: 'Subir item', exact: true }).click();
    await p.locator(`[data-media-item-id="${ids.faqItem}"] > summary`).click();
    const faq = p.locator(`[data-media-item-id="${ids.faqItem}"]`);
    await faq.getByRole('textbox', { name: 'Pergunta', exact: true }).fill('Pergunta integrada?'); await faq.locator('.ProseMirror').fill('Resposta editada no fluxo integrado.');
    await select(ids.guideButton); await p.getByRole('textbox', { name: 'Rótulo', exact: true }).fill('Ir às orientações');
    await p.getByRole('combobox', { name: 'Estilo do botão', exact: true }).selectOption('text');
    await p.getByRole('combobox', { name: 'Tipo de destino', exact: true }).selectOption(ids.orientationsSection);
    await pagesEditorInsert(p, 'Adicionar vídeo'); const source = p.getByRole('dialog', { name: 'Adicionar vídeo', exact: true });
    await source.getByRole('combobox', { name: 'Fonte do vídeo' }).selectOption('youtube'); await source.getByRole('textbox', { name: 'URL do YouTube' }).fill('https://youtu.be/aaaaaaaaaaa?si=discard'); await source.getByRole('button', { name: 'Inserir vídeo', exact: true }).click();
    await p.getByRole('textbox', { name: 'Título da mídia', exact: true }).fill('Vídeo integrado'); await p.getByRole('textbox', { name: 'Transcrição (obrigatória para publicar)', exact: true }).fill('Transcrição sintética.');
    const embedId=await p.locator('[data-block-type=video_embed].is-selected').getAttribute('data-block-id');
    await pagesEditorInsert(p,'Adicionar botão');
    const downloadId=await p.locator('[data-block-type=button].is-selected').getAttribute('data-block-id');
    await p.getByRole('textbox',{name:'Rótulo',exact:true}).fill('Baixar evidência sintética');
    await p.getByRole('combobox',{name:'Tipo de destino',exact:true}).selectOption('download');
    await p.getByRole('combobox',{name:'Arquivo da página',exact:true}).selectOption(uploadedMedia);
    await p.getByRole('textbox',{name:'Nome do arquivo para download',exact:true}).fill('evidencia.webp');
    await p.getByRole('button',{name:'Aplicar destino',exact:true}).click();
    await p.locator('.pages-v2-inspector').screenshot({path:join(output,'download-authored-inspector.png')});
    await pagesEditorInsert(p,'Adicionar botão');
    const videoButtonId=await p.locator('[data-block-type=button].is-selected').getAttribute('data-block-id');
    await p.getByRole('textbox',{name:'Rótulo',exact:true}).fill('Assistir ao vídeo integrado');
    await p.getByRole('combobox',{name:'Tipo de destino',exact:true}).selectOption('video');
    await p.getByRole('combobox',{name:'Vídeo da página',exact:true}).selectOption(embedId);
    await p.getByRole('button',{name:'Aplicar destino',exact:true}).click();
    await p.locator('.pages-v2-inspector').screenshot({path:join(output,'video-authored-inspector.png')});
    await p.getByRole('button', { name: 'Estilo da página', exact: true }).click(); const style = p.getByRole('dialog', { name: 'Estilo da página', exact: true });
    await style.getByRole('combobox', { name: 'Fonte da página', exact: true }).selectOption('oswald'); await style.getByRole('button', { name: '✓ Aplicar estilo', exact: true }).click();
    assert.equal(await intro.evaluate(n => n === __integratedPM.n && n.pmViewDesc === __integratedPM.view), true);
    await save(p, id);
    await p.getByRole('button', { name: 'Publicar', exact: true }).click(); let review = p.getByRole('dialog', { name: 'Pronto para compartilhar?' });
    await review.getByRole('textbox', { name: 'Título', exact: true }).fill('Guia integrado Task 17'); await review.getByRole('combobox', { name: 'Categoria', exact: true }).fill('Integração');
    await p.keyboard.press('Escape');
    const saved = await save(p, id), document = saved.draft.document, savedBlocks = blocks(document), changed = savedBlocks.find(b => b.id === ids.introductionBlock);
    const selectedNode = textNodes(changed.content).find(n => n.text === selection); assert.ok(selectedNode, 'same actual selected text roundtrips');
    for (const mark of ['strong','em','underline','link','text_color','highlight']) assert.ok(selectedNode.marks.some(m => m.type === mark), mark);
    assert.deepEqual(selectedNode.marks.find(m => m.type === 'text_color').attrs, { color: '#123456' });
    assert.deepEqual(selectedNode.marks.find(m => m.type === 'highlight').attrs, { color: '#F7F6F2' });
    assert.deepEqual(selectedNode.marks.find(m => m.type === 'link').attrs, { href: '/pages.html' });
    assert.deepEqual(changed.appearance, { ...blocks(feature).find(b => b.id === changed.id).appearance, font: 'source-serif-4', scale: 'large', align: 'center', background: '#FFFFFF', icon: 'check' });
    assert.deepEqual(changed.tags, ['Integração','Guia']); assert.equal(document.presentation.defaults.font, 'oswald');
    assert.equal(document.sections[2].id, ids.gallerySection); assert.equal(document.sections[1].rows[0].layout, 'two_equal');
    assert.equal(savedBlocks.find(b => b.type === 'gallery').items[0].caption, 'Nova legenda integrada'); assert.equal(savedBlocks.find(b => b.type === 'faq').items[0].question, 'Pergunta integrada?');
    const embed = savedBlocks.find(b => b.type === 'video_embed');
    assert.deepEqual(savedBlocks.find(b=>b.id===downloadId).action,{type:'download',media_id:uploadedMedia,kind:'image',file_name:'evidencia.webp'});
    assert.deepEqual(savedBlocks.find(b=>b.id===videoButtonId).action,{type:'video',value:embedId});
    assert.equal(embed.provider, 'youtube'); assert.equal(embed.video_id, 'aaaaaaaaaaa');
    assert.equal(document.metadata.category, 'Integração'); assert.equal(saved.slug, slug);
    assert.deepEqual((await h.db.query('SELECT document FROM page_revisions WHERE id=$1', [saved.draft_revision_id])).rows[0].document, document);
    const mediaIds = [...new Set(savedBlocks.flatMap(b => [b.media_id, b.action?.media_id, ...(b.items || []).map(i => i.media_id)]).filter(Boolean))].sort();
    assert.deepEqual((await h.db.query('SELECT media_id FROM page_revision_media WHERE revision_id=$1 ORDER BY media_id', [saved.draft_revision_id])).rows.map(r => r.media_id), mediaIds);
    await p.reload(); await pagesBrowserReady(p); await intro.waitFor();
    await select(downloadId); assert.equal(await p.getByRole('combobox',{name:'Arquivo da página',exact:true}).inputValue(),uploadedMedia);
    assert.equal(await p.getByRole('textbox',{name:'Nome do arquivo para download',exact:true}).inputValue(),'evidencia.webp');
    await select(videoButtonId); assert.equal(await p.getByRole('combobox',{name:'Vídeo da página',exact:true}).inputValue(),embedId);
    await select(ids.introductionBlock); assert.equal(await inspector.getByRole('combobox', { name: 'Tipografia', exact: true }).inputValue(), 'source-serif-4');
    await pagesEditorPreview(p, 'desktop'); await p.locator('.pages-document').waitFor();
    assert.equal(await p.locator('.pages-preview-frame .pages-v3-gallery figure').count(), 2); assert.equal(await p.locator('.pages-preview-frame iframe').count(), 0);
    const previewStyle = await p.locator(`.pages-preview-frame [data-block-id="${ids.introductionBlock}"]`).evaluate(n => { const s = getComputedStyle(n); return [s.fontFamily,s.textAlign,s.backgroundColor]; });
    const renderedMarks = async page => page.locator(`.pages-document [data-block-id="${ids.introductionBlock}"] [data-pages-rich-run]`).evaluateAll((nodes, text) => {
      const n = nodes.find(n => n.textContent === text), s = n && getComputedStyle(n);
      return n && { text: n.textContent, color: s.color, background: s.backgroundColor, strong: !!n.querySelector('strong'), em: !!n.querySelector('em'), underline: !!n.querySelector('u'), href: n.querySelector('a')?.getAttribute('href') };
    }, selection);
    const marks = { text: selection, color: 'rgb(18, 52, 86)', background: 'rgb(247, 246, 242)', strong: true, em: true, underline: true, href: '/pages.html' };
    assert.deepEqual(await renderedMarks(p), marks);
    const exerciseActions=async page=>{
      const download=page.waitForEvent('download'); await page.getByRole('button',{name:'Baixar evidência sintética',exact:true}).click();
      const file=await download; assert.equal(file.suggestedFilename(),'evidencia.webp'); assert.equal(await file.failure(),null);
      await page.getByRole('button',{name:'Assistir ao vídeo integrado',exact:true}).click();
      assert.equal(await page.locator(`.pages-document [data-block-id="${embedId}"] [data-pages-video-consent]`).evaluate(n=>n===document.activeElement),true);
      assert.equal(await page.locator('iframe').count(),0,'video action focuses explicit consent without contacting YouTube');
    };
    await exerciseActions(p);
    await p.screenshot({ path: join(output, 'feature-preview-1600.png'), fullPage: true }); await pagesEditorPreview(p, 'edit');
    await p.getByRole('button', { name: 'Publicar', exact: true }).click(); review = p.getByRole('dialog', { name: 'Pronto para compartilhar?' });
    const publication = p.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/${id}/publish`));
    await review.getByRole('button', { name: 'Publicar página', exact: true }).click(); assert.equal((await publication).status(), 200);
    const publishRequest = requests.find(r => r.path === `/api/pages/${id}/publish`); assert.equal(publishRequest.body.revision_id, saved.draft_revision_id); assert.deepEqual(Object.keys(publishRequest.body).sort(), ['client_mutation_id','expected_version','revision_id']);
    const read = await visit(`/pages.html?id=${id}`, 'reader'), reader = read.page; await reader.locator('.pages-document').waitFor();
    assert.deepEqual((await api('get', `/by-slug/${slug}`, undefined, 'reader')).document, document);
    assert.deepEqual(await renderedMarks(reader), marks);
    assert.deepEqual(await reader.locator(`[data-block-id="${ids.introductionBlock}"]`).evaluate(n => { const s = getComputedStyle(n); return [s.fontFamily,s.textAlign,s.backgroundColor]; }), previewStyle);
    assert.equal(await reader.locator('.pages-v3-gallery figure').count(), 2); await reader.getByText('Pergunta integrada?', { exact: true }).click(); await reader.getByText('Resposta editada no fluxo integrado.', { exact: true }).waitFor();
    await reader.getByRole('button', { name: 'Carregar áudio', exact: true }).click(); await reader.waitForFunction(() => document.querySelector('audio')?.src.startsWith('blob:'));
    await exerciseActions(reader);
    await reader.getByRole('link', { name: 'Ir às orientações', exact: true }).click(); assert.ok(reader.url().includes(ids.orientationsSection));
    assert.equal(await reader.locator('iframe').count(), 0);
    // Normalize only scroll for a useful diagnostic capture after anchor action.
    await reader.evaluate(() => { window.scrollTo(0,0); });
    await reader.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    await reader.screenshot({ path: join(output, 'feature-reader-1600.png'), fullPage: true });
    const denied = await visit(`/pages.html?id=${id}`, 'outsider'); assert.equal(await denied.page.locator('.pages-document').count(), 0); assert.equal((await h.api('get', `/by-slug/${slug}`, undefined, 'outsider')).status, 404);
    await read.context.close(); await denied.context.close();
    await p.reload(); await pagesBrowserReady(p); await intro.waitFor(); await intro.click(); await intro.press('Control+End'); await intro.pressSequentially(' RASCUNHO POSTERIOR'); await save(p, id);
    assert.deepEqual((await api('get', `/${id}`, undefined, 'reader')).document, document, 'later draft never changes published feature snapshot');
    await v.context.close(); results.push('full feature graph edited via real controls, marks/properties/gallery/FAQ/embed/buttons/order/duplicate/width/history; SQL save/reload/preview/exact review publication/cargo/alias; later draft isolated');

    // Each response failure gets its own editor visit, retaining the actual dirty
    // feature document. Timedout is a transport injection, not a real slow server.
    for (const failure of [400,403,404,409,413,'timedout']) {
      const before = await workspace(id), f = await visit(`/page-editor.html?id=${id}`), page = f.page;
      const pm = page.locator('.ProseMirror').first(); await pm.waitFor(); await pm.click(); await pm.press('Control+End'); await pm.pressSequentially(` UNSAVED-${failure}`);
      let intercepted; const seen = new Promise(done => { intercepted = done; });
      await f.context.route(`**/api/pages/${id}/draft`, async route => { intercepted(); if (failure === 'timedout') await route.abort('timedout'); else await route.fulfill({ status: failure, json: { error: 'synthetic_failure', reason: failure === 409 ? 'version_conflict' : 'synthetic_failure' } }); });
      await page.keyboard.press('Control+s'); await seen;
      await page.waitForFunction(() => !['saving','saved'].includes(document.querySelector('#page-editor-root')?.dataset.saveState));
      assert.match(await pm.textContent(), new RegExp(`UNSAVED-${failure}`)); assert.deepEqual(await workspace(id), before);
      await f.context.close(); results.push(`isolated ${failure}: failed save preserves dirty feature text and exact SQL head`);
    }
    assert.deepEqual(errors, []);
    console.log(`Pages feature roundtrip PASS: ${results.length} groups`);
    return results;
  } catch (error) {
    console.error(error);
    for (const [i, context] of contexts.entries()) for (const page of context.pages()) if (!page.isClosed()) await page.screenshot({ path: join(output, `failure-${i}.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await writeFile(join(output, 'results.json'), JSON.stringify({ results, errors, requests, legacyEvidence, browser: browser.version(), evidence: 'Chrome feature 1600x900 / legacy 1600x2400; real API/SQL/bytes, serialized PGlite; synthetic token verification; injected transport failures; no final visual acceptance' }, null, 2));
    // Close only this test's server/database and browser contexts.
    await h.close(); for (const context of contexts) await context.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  try { await checkPagesFeatureRoundtrip(browser, resolve(process.env.FEATURE_VISUAL_OUTPUT || join(tmpdir(), 'opencode', 'pages-feature-roundtrip'))); }
  finally { await browser.close(); }
}
