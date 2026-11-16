// Owned loopback only: actual editor/PM + API/SQL/private bytes. Firebase identity
// is synthetic; no live YouTube player, native infrastructure or existing service.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPagesDatabaseHarness, pageDocument } from '../database/check-pages.mjs';
import { pagesBrowserContext, pagesBrowserReady, pagesEditorInsert, pagesEditorPreview } from '../helpers/pages-browser.mjs';
import { referenceMedia } from '../helpers/pages-reference-document.mjs';
import { createPagesMediaFixtures } from '../helpers/pages-media-fixtures.mjs';
import { upgradeDocument } from '../../public/pages/document-v3.js';
for (const key of ['PGLITE_MODULE_PATH','PLAYWRIGHT_MODULE_PATH','FFMPEG_PATH','FFPROBE_PATH']) if (!process.env[key]) throw Error(`Set external ${key}`);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const require = createRequire(new URL('../../api/package.json', import.meta.url)), express = require('express');
const output = resolve(process.env.MEDIA_VISUAL_OUTPUT || join(tmpdir(),'opencode','pages-editor-media'));
await mkdir(output,{recursive:true});
const h = await createPagesDatabaseHarness({v3WritesEnabled:true}), fixtures = await createPagesMediaFixtures(), errors=[], results=[], outbound=[];
let browser;
const blocks = doc => doc.sections.flatMap(s=>s.rows.flatMap(r=>r.columns.flatMap(c=>c.blocks)));
const rich = text => ({type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}]});
async function api(method,path,body,uid='super') { const r=await h.api(method,path,body,uid);assert.ok(r.status>=200&&r.status<300,`${method} ${path} ${r.status} ${JSON.stringify(r.body)}`);return r.body; }
async function create(doc) { const {id}=await api('post','',{template_id:'comunicado',client_mutation_id:randomUUID()});const w=await api('get',`/${id}/workspace`);await api('put',`/${id}/draft`,{expected_version:w.version,client_mutation_id:randomUUID(),document:doc});return id; }
async function visit(path,uid='super') {
  const v=await pagesBrowserContext(browser,{width:1600,errors,uid});
  await v.context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===h.origin||url.hostname==='www.gstatic.com')return route.fallback();outbound.push(url.href);return route.abort('blockedbyclient');});
  await v.page.goto(h.origin+path);await pagesBrowserReady(v.page);return v;
}
async function save(page,id) {const response=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname===`/api/pages/${id}/draft`);await page.getByRole('button',{name:/Salvar rascunho/}).click();assert.equal((await response).status(),200);await page.locator('#page-editor-root[data-save-state=saved]').waitFor();return (await api('get',`/${id}/workspace`)).draft.document;}
const image=referenceMedia()[0];
const imageFile=name=>({name,mimeType:'image/webp',buffer:image.bytes});
const genericFile=page=>page.getByLabel('Selecionar imagem estática ou mídia GIF, MP3, MP4',{exact:true});
async function setFile(page,input,files,id,status=201) {const r=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`/api/pages/${id}/media`);await input.setInputFiles(files);assert.equal((await r).status(),status);}
try {
  h.app.use(express.static(fileURLToPath(new URL('../../public/',import.meta.url))));
  browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});
  const doc=upgradeDocument(pageDocument('Media authoring integration'));
  const text=blocks(doc)[0];text.content=rich('Stored colors survive');text.content.content[0].content[0].marks=[{type:'text_color',attrs:{color:'#26204A'}},{type:'highlight',attrs:{color:'#FFFFFF'}}];
  const faq={id:randomUUID(),type:'faq',items:[{id:randomUUID(),question:'Question one',answer:rich('Answer one')},{id:randomUUID(),question:'Question two',answer:rich('Answer two')}]};
  doc.sections[0].rows[0].columns[0].blocks.push(faq);
  const id=await create(doc),{page,context}=await visit(`/page-editor.html?id=${id}`);await page.locator('.ProseMirror').first().waitFor();
  assert.equal(await page.locator('[data-pages-text_color="#26204A"]').count(),1);
  await page.locator(`[data-block-id="${text.id}"] .ProseMirror`).press('End');await page.keyboard.type(' edited');
  await page.locator(`[data-block-id="${text.id}"] .ProseMirror`).evaluate(n=>{const data=new DataTransfer();data.setData('text/html','<span data-pages-text_color="#112233"> safe-color </span><span data-pages-highlight="url(https://evil.test)"> plain-invalid </span>');n.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});
  assert.equal(await page.locator('[data-pages-text_color="#112233"]').count(),1);assert.equal(await page.locator('[data-pages-highlight^="url"]').count(),0);
  // FAQ actual views: editing the second item + context formatting must not touch
  // the first item. Reordering never substitutes a new EditorView.
  const answer=page.locator(`[data-faq-answer="${faq.items[1].id}"] .ProseMirror`);
  await page.locator(`[data-media-item-id="${faq.items[1].id}"] > summary`).click();
  await answer.evaluate(n=>{globalThis.faqIdentity={node:n,view:n.pmViewDesc};});await answer.click();await answer.press('End');await page.keyboard.type(' updated');
  await page.getByRole('button',{name:'Negrito',exact:true}).click();await page.keyboard.type(' bold');
  const second=page.locator(`[data-media-item-id="${faq.items[1].id}"]`);await second.getByRole('button',{name:'Subir item',exact:true}).click();
  await answer.click();await answer.press('End');await page.keyboard.type(' reordered');assert.equal(await answer.evaluate(n=>n===faqIdentity.node&&n.pmViewDesc===faqIdentity.view),true);
  await page.keyboard.press('Control+z');assert.equal(await answer.textContent(),'Answer two updated bold');assert.equal(await answer.evaluate(n=>n===document.activeElement),true,'history restores the item bookmark');await page.keyboard.press('Control+y');
  const question=second.getByRole('textbox',{name:'Pergunta',exact:true});await question.focus();const cdp=await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text:'一',selectionStart:1,selectionEnd:1});await page.waitForTimeout(650);await cdp.send('Input.imeSetComposition',{text:'一二',selectionStart:2,selectionEnd:2});
  await page.keyboard.press('Control+z');assert.match(await question.inputValue(),/一二/);await cdp.send('Input.insertText',{text:'一二'});await page.waitForTimeout(50);await page.keyboard.press('Control+z');assert.equal(await question.inputValue(),'Question two');await question.fill('Question two changed');await cdp.detach();
  await page.locator(`[data-block-id="${faq.id}"]`).getByRole('button',{name:'Adicionar pergunta',exact:true}).click();
  const faqItems=page.locator(`[data-block-id="${faq.id}"] [data-media-item-id]`);await faqItems.last().getByRole('textbox',{name:'Pergunta',exact:true}).fill('New question');await faqItems.last().locator('.ProseMirror').fill('New answer');
  const savedFAQ=await save(page,id);assert.deepEqual(blocks(savedFAQ).find(b=>b.id===faq.id).items.map(i=>i.question),['Question two changed','Question one','New question']);
  assert.ok(blocks(savedFAQ).find(b=>b.id===faq.id).items[0].answer.content[0].content.some(n=>n.marks?.some(m=>m.type==='strong')));
  const retiredFAQ=await faqItems.last().evaluateHandle(host=>({host,actions:[...host.querySelectorAll('button')].filter(n=>['Subir item','Descer item','Remover item'].includes(n.textContent))}));
  await faqItems.last().getByRole('button',{name:'Remover item',exact:true}).click();assert.equal(await faqItems.count(),2);await page.getByRole('button',{name:'Desfazer exclusão',exact:true}).click();assert.equal(await faqItems.count(),3);assert.equal(await answer.evaluate(n=>n===faqIdentity.node&&n.pmViewDesc===faqIdentity.view),true);
  const faqOrder=await faqItems.evaluateAll(nodes=>nodes.map(n=>n.dataset.mediaItemId));
  await retiredFAQ.evaluate(({host,actions})=>{if(host.isConnected)throw Error('Old FAQ entry must be detached');for(const n of actions)n.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
  assert.deepEqual(await faqItems.evaluateAll(nodes=>nodes.map(n=>n.dataset.mediaItemId)),faqOrder);assert.equal(await page.locator('#page-editor-root').getAttribute('data-save-state'),'saved');
  await page.keyboard.press('Control+y');assert.equal(await faqItems.count(),2,'stale callbacks preserved FAQ redo');await page.getByRole('button',{name:'Desfazer exclusão',exact:true}).click();assert.equal(await faqItems.count(),3);await retiredFAQ.dispose();
  results.push({scenario:'stored v3 marks, second FAQ view/context B, reorder identity, global item bookmark + real CDP native IME, new FAQ item',pass:true});console.log('PASS actual FAQ identity/focus/history/context/IME + stored color marks');
  await pagesEditorInsert(page,'Adicionar galeria');const gallery=page.locator('[data-block-type=gallery]'),galleryId=await gallery.getAttribute('data-block-id');
  const picker=page.getByLabel('Adicionar imagens à galeria',{exact:true});assert.equal(await picker.getAttribute('accept'),'image/jpeg,image/png,image/webp,image/gif');assert.equal(await picker.getAttribute('multiple'),'');
  const cleanBefore=(await api('get',`/${id}/workspace`)).draft.document;
  await picker.setInputFiles([]);assert.equal(await page.locator('[data-media-item-id]').count(),3);
  let requests=0;const keys=[];
  await context.route(`**/api/pages/${id}/media`,async route=>{requests++;keys.push(/name="client_mutation_id"\r\n\r\n([^\r]+)/.exec(route.request().postDataBuffer()?.toString())?.[1]);if(requests===2)return route.fulfill({status:415,contentType:'application/json',body:'{"error":"invalid_media","reason":"invalid_media"}'});return route.continue();});
  await picker.setInputFiles([imageFile('first.webp'),imageFile('second.webp'),{name:'synthetic.gif',mimeType:'image/gif',buffer:fixtures.files['synthetic.gif'].buffer}]);
  await page.getByRole('button',{name:'Tentar upload novamente',exact:true}).waitFor();assert.equal(requests,2);assert.equal(await page.locator('.pages-v3-gallery figure').count(),1);
  const partial=await h.db.query('SELECT count(*)::int AS count FROM page_media WHERE page_id=$1',[id]);assert.equal(partial.rows[0].count,1);
  await page.getByRole('button',{name:'Tentar upload novamente',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.pages-v3-gallery figure').length===3);assert.equal(requests,4);assert.equal(keys[1],keys[2]);
  const items=page.locator('.pages-v2-content-fields [data-media-item-id]');
  for(let i=0;i<3;i++){await items.nth(i).getByRole('textbox',{name:'Texto alternativo',exact:true}).fill(`Gallery alt ${i}`);await items.nth(i).getByRole('textbox',{name:'Legenda',exact:true}).fill(`Caption ${i}`);await items.nth(i).getByRole('textbox',{name:'Crédito',exact:true}).fill(`Credit ${i}`);}
  const firstId=await items.first().getAttribute('data-media-item-id');await items.first().getByRole('button',{name:'Descer item',exact:true}).click();
  const moved=page.locator(`.pages-v2-content-fields [data-media-item-id="${firstId}"]`);await moved.getByRole('textbox',{name:'Legenda',exact:true}).fill('After reorder caption');
  let persisted=await save(page,id);const beforeReplace=blocks(persisted).find(b=>b.id===galleryId).items[1].media_id;
  await setFile(page,moved.getByLabel('Substituir imagem da galeria',{exact:true}),{name:'bad.webp',mimeType:'image/webp',buffer:Buffer.from('not a real image')},id,415);
  await page.getByRole('button',{name:'Cancelar upload não confirmado',exact:true}).click();assert.equal((await api('get',`/${id}/workspace`)).draft.document.sections[0].rows[0].columns[0].blocks.find(b=>b.id===galleryId).items[1].media_id,beforeReplace);
  // Actual image replacement is committed to this stable item, not a new block.
  await setFile(page,moved.getByLabel('Substituir imagem da galeria',{exact:true}),imageFile('replacement.webp'),id);persisted=await save(page,id);assert.notEqual(blocks(persisted).find(b=>b.id===galleryId).items[1].media_id,beforeReplace);
  // Drop the actual response AFTER COMMIT. Retry the same per-file key; never
  // register it again automatically or roll back/delete its confirmed bytes.
  const beforeLost=await h.db.query('SELECT count(*)::int AS count FROM page_media WHERE page_id=$1',[id]);
  let lostKey,retryKey;
  await context.route(`**/api/pages/${id}/media`,async route=>{lostKey=/name="client_mutation_id"\r\n\r\n([^\r]+)/.exec(route.request().postDataBuffer()?.toString())?.[1];const response=await route.fetch();assert.equal(response.status(),201);await route.abort('failed');},{times:1});
  await moved.getByLabel('Substituir imagem da galeria',{exact:true}).setInputFiles(imageFile('lost-ack.webp'));await page.getByRole('button',{name:'Tentar upload novamente',exact:true}).waitFor();
  const afterLost=await h.db.query('SELECT count(*)::int AS count FROM page_media WHERE page_id=$1',[id]);assert.equal(afterLost.rows[0].count,beforeLost.rows[0].count+1);
  await page.waitForTimeout(100);assert.equal(requests,6,'no automatic retry after lost COMMIT response');
  await context.route(`**/api/pages/${id}/media`,async route=>{retryKey=/name="client_mutation_id"\r\n\r\n([^\r]+)/.exec(route.request().postDataBuffer()?.toString())?.[1];await route.continue();},{times:1});
  await page.getByRole('button',{name:'Tentar upload novamente',exact:true}).click();await page.waitForFunction(()=>document.querySelector('button')&&!Array.from(document.querySelectorAll('button')).find(n=>n.textContent==='Tentar upload novamente'&&!n.hidden));assert.equal(retryKey,lostKey);
  const afterRetry=await h.db.query('SELECT count(*)::int AS count FROM page_media WHERE page_id=$1',[id]);assert.equal(afterRetry.rows[0].count,afterLost.rows[0].count);persisted=await save(page,id);
  const retiredGallery=await moved.evaluateHandle(host=>({host,actions:[...host.querySelectorAll('button')].filter(n=>['Subir item','Descer item','Remover item','Substituir imagem da galeria'].includes(n.textContent))}));
  await moved.getByRole('button',{name:'Remover item',exact:true}).click();assert.equal(await page.locator('.pages-v3-gallery figure').count(),2);await page.getByRole('button',{name:'Desfazer exclusão',exact:true}).click();assert.equal(await page.locator('.pages-v3-gallery figure').count(),3);
  const galleryOrder=await items.evaluateAll(nodes=>nodes.map(n=>n.dataset.mediaItemId));
  await retiredGallery.evaluate(({host,actions})=>{if(host.isConnected)throw Error('Old gallery entry must be detached');for(const n of actions)n.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
  assert.deepEqual(await items.evaluateAll(nodes=>nodes.map(n=>n.dataset.mediaItemId)),galleryOrder);assert.equal(await page.locator('#page-editor-root').getAttribute('data-save-state'),'saved');
  await page.keyboard.press('Control+y');assert.equal(await page.locator('.pages-v3-gallery figure').count(),2,'stale callbacks preserved gallery redo');await page.getByRole('button',{name:'Desfazer exclusão',exact:true}).click();assert.equal(await page.locator('.pages-v3-gallery figure').count(),3);await retiredGallery.dispose();
  const afterRemoveUndo=await h.db.query('SELECT count(*)::int AS count FROM page_media WHERE page_id=$1',[id]);assert.equal(afterRemoveUndo.rows[0].count,afterRetry.rows[0].count,'local removal/undo never deletes registered historical bytes');
  await page.reload();await pagesBrowserReady(page);await page.locator(`[data-block-id="${galleryId}"] .pages-select-block`).click();
  assert.equal(await page.locator(`.pages-v2-content-fields [data-media-item-id="${firstId}"]`).getByRole('textbox',{name:'Legenda',exact:true}).inputValue(),'After reorder caption');
  assert.equal(await page.locator('.pages-v3-gallery figure').count(),3);assert.equal(blocks(cleanBefore).some(b=>b.type==='gallery'),false);
  results.push({scenario:'actual serial multifile gallery registration, partial MIME failure/retry same key, per-item reorder/alt/caption/credit, failed + successful replacement, SQL save/reload',pass:true});console.log('PASS actual gallery partial/retry/replace/order/SQL reload');
  // Video source form is local until a valid ID. Cancel and invalid input are inert.
  await pagesEditorInsert(page,'Adicionar vídeo');let form=page.getByRole('dialog',{name:'Adicionar vídeo',exact:true});await form.getByRole('button',{name:'Cancelar',exact:true}).click();assert.equal(await page.locator('[data-block-type=video_embed]').count(),0);
  await pagesEditorInsert(page,'Adicionar vídeo');form=page.getByRole('dialog',{name:'Adicionar vídeo',exact:true});await form.getByRole('combobox',{name:'Fonte do vídeo'}).selectOption('youtube');await form.getByRole('textbox',{name:'URL do YouTube'}).fill('https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ');await form.getByRole('button',{name:'Confirmar fonte'}).click();await form.getByRole('alert').filter({hasText:'URL HTTPS'}).waitFor();assert.equal(await page.locator('[data-block-type=video_embed]').count(),0);
  await form.getByRole('textbox',{name:'URL do YouTube'}).fill('https://youtu.be/dQw4w9WgXcQ?si=discard');await form.getByRole('button',{name:'Confirmar fonte'}).click();
  const embedId=await page.locator('[data-block-type=video_embed]').getAttribute('data-block-id');await page.getByRole('textbox',{name:'Título da mídia',exact:true}).fill('External video');await page.getByRole('textbox',{name:'Transcrição (obrigatória para publicar)',exact:true}).fill('External transcript');
  await page.getByRole('button',{name:'Trocar fonte do vídeo',exact:true}).click();form=page.getByRole('dialog',{name:'Trocar fonte do vídeo',exact:true});await form.getByRole('button',{name:'Cancelar',exact:true}).click();assert.equal(await page.locator(`[data-block-id="${embedId}"]`).getAttribute('data-block-type'),'video_embed');
  await save(page,id);assert.deepEqual(outbound,[],'no third-party thumbnail/player/network during authoring');
  await page.getByRole('button',{name:'Trocar fonte do vídeo',exact:true}).click();form=page.getByRole('dialog',{name:'Trocar fonte do vídeo',exact:true});const chooser=page.waitForEvent('filechooser');await form.getByRole('button',{name:'Confirmar fonte',exact:true}).click();await (await chooser).setFiles([]);assert.equal(await page.locator(`[data-block-id="${embedId}"]`).getAttribute('data-block-type'),'video_embed');
  await page.getByRole('button',{name:'Trocar fonte do vídeo',exact:true}).click();form=page.getByRole('dialog',{name:'Trocar fonte do vídeo',exact:true});const chooseMP4=page.waitForEvent('filechooser');await form.getByRole('button',{name:'Confirmar fonte',exact:true}).click();assert.equal(await genericFile(page).getAttribute('accept'),'video/mp4,.mp4');
  const mp4Response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`/api/pages/${id}/media`);await (await chooseMP4).setFiles(fixtures.files['synthetic.mp4'].path);assert.equal((await mp4Response).status(),201);await page.locator(`[data-block-id="${embedId}"][data-block-type=video]`).waitFor();
  await page.getByRole('textbox',{name:'Legendas sincronizadas JSON',exact:true}).fill('[{"start_ms":0,"end_ms":1000,"text":"Private caption"}]');await page.getByRole('textbox',{name:'Legendas sincronizadas JSON',exact:true}).press('Tab');
  persisted=await save(page,id);assert.equal(blocks(persisted).find(b=>b.id===embedId).type,'video');assert.equal(blocks(persisted).find(b=>b.id===embedId).transcript,'External transcript');
  await page.locator('.pages-recovery-actions').getByRole('button',{name:'Desfazer exclusão',exact:true}).click();assert.equal(await page.locator(`[data-block-id="${embedId}"]`).getAttribute('data-block-type'),'video');
  await page.locator('.pages-recovery-actions').getByRole('button',{name:'Desfazer exclusão',exact:true}).click();assert.equal(await page.locator(`[data-block-id="${embedId}"]`).getAttribute('data-block-type'),'video_embed');await page.keyboard.press('Control+y');await page.keyboard.press('Control+y');
  // A second external video remains alongside the real private MP4.
  await pagesEditorInsert(page,'Adicionar vídeo');form=page.getByRole('dialog',{name:'Adicionar vídeo',exact:true});await form.getByRole('combobox',{name:'Fonte do vídeo'}).selectOption('youtube');await form.getByRole('textbox',{name:'URL do YouTube'}).fill('https://youtube.com/shorts/aaaaaaaaaaa');await form.getByRole('button',{name:'Confirmar fonte'}).click();await page.getByRole('textbox',{name:'Título da mídia',exact:true}).fill('YouTube warning');await page.getByRole('textbox',{name:'Transcrição (obrigatória para publicar)',exact:true}).fill('Transcript');
  await pagesEditorInsert(page,'Adicionar áudio');
  // The audio picker has already been opened by insertion; use its named input.
  assert.equal(await genericFile(page).getAttribute('accept'),'audio/mpeg,.mp3');await setFile(page,genericFile(page),fixtures.files['synthetic.mp3'].path,id);
  await page.getByRole('textbox',{name:'Transcrição (obrigatória para publicar)',exact:true}).fill('Private audio transcript');
  // Standalone image/GIF and typed replace use the same registration authority.
  await pagesEditorInsert(page,'Adicionar imagem ou GIF');await setFile(page,genericFile(page),imageFile('standalone.webp'),id);await page.getByRole('textbox',{name:'Texto alternativo (obrigatório para publicar)',exact:true}).fill('Standalone image');
  await pagesEditorInsert(page,'Adicionar imagem ou GIF');await setFile(page,genericFile(page),fixtures.files['synthetic.gif'].path,id);await page.getByRole('textbox',{name:'Texto alternativo (obrigatório para publicar)',exact:true}).fill('Standalone GIF');
  persisted=await save(page,id);const types=new Set(blocks(persisted).map(b=>b.type));for(const type of ['rich_text','faq','gallery','video_embed','video','audio','image','gif'])assert.ok(types.has(type),type);
  await page.reload();await pagesBrowserReady(page);await page.locator('.ProseMirror').first().waitFor();await pagesEditorPreview(page,'desktop');
  assert.equal(await page.locator('.pages-preview-frame iframe').count(),0);assert.deepEqual(outbound,[]);
  await page.screenshot({path:join(output,'media-preview.png'),fullPage:true});
  const w=await api('get',`/${id}/workspace`);await api('post',`/${id}/publish`,{expected_version:w.version,revision_id:w.draft_revision_id,client_mutation_id:randomUUID()});
  const read=await visit(`/pages.html?id=${id}`,'reader'),reader=read.page;await reader.locator('.pages-document').waitFor();
  assert.equal(await reader.locator('.pages-v3-gallery figure').count(),3);assert.deepEqual(await reader.locator('.pages-v3-gallery figcaption').allTextContents(),['Caption 1Crédito: Credit 1','After reorder captionCrédito: Credit 0','Caption 2 · Credit 2']);
  const details=reader.locator('.pages-v3-faq details');assert.equal(await details.count(),3);await details.first().locator('summary').click();await details.nth(1).locator('summary').click();assert.equal(await details.first().evaluate(n=>n.open),true);assert.equal(await details.nth(1).evaluate(n=>n.open),true);
  assert.equal(await reader.locator('iframe').count(),0);assert.deepEqual(outbound,[]);
  for(const label of ['Carregar áudio','Carregar vídeo']) await reader.getByRole('button',{name:label,exact:true}).click();
  await reader.waitForFunction(()=>[...document.querySelectorAll('audio,video')].every(n=>n.src.startsWith('blob:')&&n.readyState>=1));
  assert.equal(await reader.locator('video track[kind=captions]').count(),1);assert.equal(await reader.locator('video').getAttribute('autoplay'),null);
  const mediaSQL=await h.db.query('SELECT count(*)::int AS count FROM page_revision_media WHERE revision_id=$1',[w.draft_revision_id]);assert.equal(mediaSQL.rows[0].count,7);
  for(const kind of ['audio','video']) {const block=blocks(persisted).find(b=>b.type===kind);const denied=await h.api('get',`/${id}/media/${block.media_id}`,undefined,'outsider');assert.equal(denied.status,404);}
  await reader.screenshot({path:join(output,'media-reader.png'),fullPage:true});await read.context.close();await context.close();
  results.push({scenario:'source warning/invalid/cancel, stable-ID real MP4 replacement+undo, typed MP3/image/GIF, all-type save/reload/preview/published cargo reader, private guard/no third-party pre-consent',pass:true});console.log('PASS all media typed/source/MP4 + persisted preview/published reader/private guards');
  // Account disposal while a serial batch is pending: guards restore synthetic
  // DOM changes, no second request/ref can leak into the new identity/visit.
  const lateDoc=upgradeDocument(pageDocument('Late batch disposal')),lateGallery={id:randomUUID(),type:'gallery',items:[]},lateFAQ={id:randomUUID(),type:'faq',items:[{id:randomUUID(),question:'Guarded question',answer:rich('Guarded answer')}]};lateDoc.sections[0].rows[0].columns[0].blocks.push(lateGallery,lateFAQ);
  const lateId=await create(lateDoc),late=await visit(`/page-editor.html?id=${lateId}`);await late.page.locator(`[data-block-id="${lateGallery.id}"] .pages-select-block`).click();
  let release,entered,lateRequests=0;const held=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
  await late.context.route(`**/api/pages/${lateId}/media`,async route=>{lateRequests++;entered();await held;await route.continue().catch(()=>{});});
  await late.page.getByLabel('Adicionar imagens à galeria',{exact:true}).setInputFiles([imageFile('late-one.webp'),imageFile('late-two.webp')]);await started;
  const guarded=late.page.getByRole('textbox',{name:'Pergunta',exact:true,includeHidden:true});assert.equal(await guarded.isDisabled(),true);await guarded.evaluate(n=>{n.value='Unrecorded';n.dispatchEvent(new InputEvent('input',{bubbles:true}));});assert.equal(await guarded.inputValue(),'Guarded question');
  await late.page.evaluate(()=>__fixtureChangeUser('outsider'));release();await late.page.waitForTimeout(150);assert.equal(lateRequests,1);assert.equal(await late.page.locator('.pages-v2-workspace').count(),0);assert.equal(await late.page.evaluate(()=>__pagesObjectURLs.size),0);
  const lateW=await api('get',`/${lateId}/workspace`);assert.deepEqual(blocks(lateW.draft.document).find(b=>b.id===lateGallery.id).items,[]);await late.context.close();
  results.push({scenario:'held serial batch + native question upload guard + account disposal cancels remaining bytes/views/blobs without refs',pass:true});console.log('PASS held batch native guard/account disposal/no late refs');
  const legacyId=await create(pageDocument('Legacy paste guard')),legacy=await visit(`/page-editor.html?id=${legacyId}`),legacyPM=legacy.page.locator('.ProseMirror').first();await legacyPM.waitFor();await legacyPM.click();await legacyPM.press('End');
  const legacyText=await legacyPM.textContent();await legacyPM.evaluate(n=>{const data=new DataTransfer();data.setData('text/html','<span data-pages-text_color="#112233">must not create v3 marks</span>');n.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));});
  assert.equal(await legacyPM.textContent(),legacyText);assert.equal(await legacy.page.locator('[data-pages-text_color]').count(),0);await legacyPM.press('End');await legacy.page.keyboard.type(' legacy edit');const legacySaved=await save(legacy.page,legacyId);assert.equal(legacySaved.schema_version,1);await legacy.context.close();
  results.push({scenario:'actual clipboard own-data color normalization/paste sanitization in v3; color paste rejected in legacy, ordinary v1 edit/save retained',pass:true});console.log('PASS controlled color DOM/paste and legacy v1 edit/save');
  assert.deepEqual(errors,[]);await writeFile(join(output,'results.json'),JSON.stringify({synthetic:true,results,errors,outbound,limits:'PGlite serial, synthetic auth, Chrome; no live external player/native infrastructure'},null,2));
} finally {await browser?.close();await fixtures.close();await h.close();}
