// Task-owned Chrome + real PM/state/editor and actual SQL/API. Only Firebase
// identity is synthetic; every listener/database belongs to this process.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPagesDatabaseHarness, pageDocument } from '../database/check-pages.mjs';
import { pagesBrowserContext, pagesBrowserReady, pagesEditorPageProperties, pagesEditorOrganize } from '../helpers/pages-browser.mjs';
import { upgradeDocument } from '../../public/pages/document-v3.js';
import { referenceMedia } from '../helpers/pages-reference-document.mjs';
for (const key of ['PGLITE_MODULE_PATH','PLAYWRIGHT_MODULE_PATH']) if (!process.env[key]) throw new Error(`Set external ${key}`);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const require = createRequire(new URL('../../api/package.json', import.meta.url)), express = require('express');
const { createPagesRouter } = require('./pages/router');
const output = resolve(process.env.HISTORY_VISUAL_OUTPUT || join(tmpdir(), 'opencode', 'pages-history'));
await mkdir(output, { recursive: true });
const h = await createPagesDatabaseHarness({ v3WritesEnabled: true }), results = [], errors = [], blocked = [];
let browser;
async function api(method, path, body) {
  const r = await h.api(method, path, body, 'super');
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`); return r.body;
}
async function create(document) {
  const { id } = await api('post', '', { template_id: 'comunicado', client_mutation_id: randomUUID() });
  if (document) { const w = await api('get', `/${id}/workspace`); await api('put', `/${id}/draft`, {expected_version:w.version,client_mutation_id:randomUUID(),document}); }
  return id;
}
async function visit(path, origin = h.origin, uid = 'super') {
  const v = await pagesBrowserContext(browser, { errors, width: 1600, uid });
  await v.context.route('**/*', route => {
    const url = new URL(route.request().url());
    // gstatic is fulfilled locally by pagesBrowserContext, never contacted.
    if (url.origin === origin || url.hostname === 'www.gstatic.com') return route.fallback();
    blocked.push(url.href); return route.abort('blockedbyclient');
  });
  await v.page.goto(origin + path); return v;
}
const blocks = doc => doc.sections.flatMap(s => s.rows.flatMap(r => r.columns.flatMap(c => c.blocks)));
const richDoc = text => ({type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}]});
async function key(page, key = 'Control+z') { await page.keyboard.press(key); }
async function advancedPosition(page) {
  await pagesEditorOrganize(page);
  const details = page.locator('.pages-inspector-advanced');
  if (!await details.evaluate(n => n.open)) await details.locator('summary').first().click();
}
async function saved(page, id) {
  const r = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/pages/${id}/draft`);
  await page.getByRole('button', {name:/Salvar rascunho/}).click(); assert.equal((await r).status(), 200);
  await page.locator('#page-editor-root[data-save-state=saved]').waitFor();
}
try {
  // Minimal integration surface for contracts not yet exposed as block UI (FAQ
  // item bookmarks and explicit v3 upgrade). All implementation is production
  // modules; the fixture supplies only wiring/inspection, never fake history.
  h.app.get('/__history', (_req, res) => res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"></head><body><div id="rich"></div><div id="standalone"></div><script type="module">
    import {createPagesAPI} from '/pages/api.js';
    import {createPageLifecycle} from '/js/page-lifecycle.js';
    import {createEditorState} from '/pages/state.js';
    import {createRichEditor} from '/pages/vendor/editor.js';
    import {upgradeDocument} from '/pages/document-v3.js';
    import {allBlocks} from '/pages/model.js';
    const page=createPageLifecycle(), api=createPagesAPI(page), id=new URL(location.href).searchParams.get('id');
    const state=createEditorState(await api.workspace(id));
    const get=()=>allBlocks(state.document)[0], itemId=get().items?.[0].id, blockId=get().id;
    const content=()=>itemId?get().items.find(i=>i.id===itemId).answer:get().content;
    let calls=0;const changes=[];
    const reconcile=()=>editor.sync(content(),state.selection);
    const travel=direction=>{if(editor.composing)return false;const result=state[direction]();if(result){reconcile();editor.focus();}return result;};
    const editor=createRichEditor({host:document.getElementById('rich'),content:content(),blockId,itemId,
      historyCommands:{undo:()=>travel('undo'),redo:()=>travel('redo')},onHistoryBoundary:()=>state.closeHistoryGroup(),
      onChange(content,meta){calls++;changes.push(meta);state.transact({...meta,group:blockId+':'+(itemId||'content')},doc=>{const b=allBlocks(doc).find(b=>b.id===blockId);if(itemId)b.items.find(i=>i.id===itemId).answer=content;else b.content=content;});}
    });
    const standalone=createRichEditor({host:document.getElementById('standalone'),content:{type:'doc',content:[{type:'paragraph'}]},onChange(){}});
    globalThis.fixture={state,editor,standalone,api,travel,reconcile,changes,upgrade(){state.replace(upgradeDocument(state.document));reconcile();},get calls(){return calls;}};
    page.cleanup(()=>{editor.destroy();standalone.destroy();});document.documentElement.dataset.ready='true';
  </script></body></html>`));
  h.app.use(express.static(fileURLToPath(new URL('../../public/', import.meta.url))));
  browser = await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL || 'chrome'});

  if (!process.env.HISTORY_FIX_CASE || process.env.HISTORY_FIX_CASE==='native-guards') {
    const id=await create(pageDocument('Native baseline')), {page,context}=await visit(`/page-editor.html?id=${id}`);await pagesBrowserReady(page);await page.locator('.ProseMirror').first().waitFor();
    await pagesEditorPageProperties(page);const title=page.getByRole('textbox',{name:'Título',exact:true}),summary=page.getByRole('textbox',{name:'Resumo',exact:true});
    await title.fill('Before upload');let release,entered;const held=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
    const asset=referenceMedia()[0];
    await context.route(`**/api/pages/${id}/media`,async route=>{entered();await held;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"unknown upload"}'}).catch(()=>{});},{times:1});
    try {
      await page.locator('input[type=file]').setInputFiles({name:asset.file_name,mimeType:'image/webp',buffer:asset.bytes});await started;
      assert.equal(await title.isDisabled(),true,'native title must disable while upload is held');assert.equal(await summary.isDisabled(),true);
      await title.evaluate(n=>{n.value='DOM-only upload';n.dispatchEvent(new InputEvent('input',{bubbles:true}));});assert.equal(await title.inputValue(),'Before upload');
    } finally {release();}
    await page.getByRole('button',{name:'Cancelar upload não confirmado',exact:true}).waitFor();assert.equal(await title.isDisabled(),true,'unknown upload stays locked');
    await summary.evaluate(n=>{n.value='DOM-only ambiguity';n.dispatchEvent(new InputEvent('input',{bubbles:true}));});assert.equal(await summary.inputValue(),pageDocument('Native baseline').metadata.summary);
    await page.getByRole('button',{name:'Cancelar upload não confirmado',exact:true}).click();assert.equal(await title.isDisabled(),false);
    const uploaded=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`/api/pages/${id}/media`);
    await page.locator('input[type=file]').setInputFiles({name:asset.file_name,mimeType:'image/webp',buffer:asset.bytes});assert.equal((await uploaded).status(),201);
    await page.waitForFunction(()=>!document.querySelector('.pages-metadata-title input').disabled);await pagesEditorPageProperties(page);await title.fill('Displayed and submitted');
    const submitted=page.waitForRequest(r=>r.method()==='PUT'&&new URL(r.url()).pathname===`/api/pages/${id}/draft`);await saved(page,id);
    assert.equal((await submitted).postDataJSON().document.metadata.title,await title.inputValue());assert.equal((await api('get',`/${id}/workspace`)).draft.document.metadata.title,await title.inputValue());
    assert.equal(await page.locator('#page-editor-root').getAttribute('data-save-state'),'saved');await context.close();
    // An ordinary in-flight save stays editable, even when its eventual ACK
    // changes writer support. The display must retain the actual newer draft.
    const v3id=await create(upgradeDocument(pageDocument('Support baseline'))), v=await visit(`/page-editor.html?id=${v3id}`);
    await pagesBrowserReady(v.page);await v.page.locator('.ProseMirror').first().waitFor();await pagesEditorPageProperties(v.page);
    const name=v.page.getByRole('textbox',{name:'Título',exact:true});await name.fill('Sent v3');
    let ackRelease,ackEntered;const ackHeld=new Promise(r=>{ackRelease=r;}),ackStarted=new Promise(r=>{ackEntered=r;});let payload;
    await v.context.route(`**/api/pages/${v3id}/draft`,async route=>{payload=route.request().postDataJSON();ackEntered();await ackHeld;const response=await route.fetch(),body=await response.json();body.document_support={read_versions:[1,2,3],write_versions:[1,2]};await route.fulfill({response,json:body}).catch(()=>{});},{times:1});
    try {
      await v.page.getByRole('button',{name:/Salvar rascunho/}).click();await ackStarted;assert.equal(await name.isDisabled(),false);
      await name.fill('Newer than ordinary save');
    } finally {ackRelease();}
    await v.page.waitForFunction(()=>document.querySelector('.pages-metadata-title input').disabled);
    assert.equal(payload.document.metadata.title,'Sent v3');assert.equal(await name.inputValue(),'Newer than ordinary save');
    await name.evaluate(n=>{n.value='Readonly DOM';n.dispatchEvent(new InputEvent('input',{bubbles:true}));});assert.equal(await name.inputValue(),'Newer than ordinary save');
    assert.equal(await v.page.locator('#page-editor-root').getAttribute('data-save-state'),'dirty');assert.equal(await v.page.getByRole('button',{name:/Salvar rascunho/}).isDisabled(),true);
    assert.equal((await api('get',`/${v3id}/workspace`)).draft.document.metadata.title,'Sent v3');await v.context.close();
    results.push({scenario:'R1 native operation locks reconcile display/state/submitted saved snapshot, and readonly ACK preserves newer ordinary-save edits',pass:true});console.log('PASS R1 native guards/display/snapshot/ordinary-save support ACK');
  }
  if (!process.env.HISTORY_FIX_CASE || process.env.HISTORY_FIX_CASE==='native-ime') {
    const id=await create(pageDocument('Native IME baseline')),{page,context}=await visit(`/page-editor.html?id=${id}`);await pagesBrowserReady(page);await page.locator('.ProseMirror').first().waitFor();await pagesEditorPageProperties(page);
    for (const name of ['Título','Resumo']) {
      const control=page.getByRole('textbox',{name,exact:true}), before=await control.inputValue();await control.focus();await control.press('Control+a');
      const cdp=await context.newCDPSession(page);await cdp.send('Input.imeSetComposition',{text:'一',selectionStart:1,selectionEnd:1});await page.waitForTimeout(650);
      await cdp.send('Input.imeSetComposition',{text:'一二',selectionStart:2,selectionEnd:2});assert.equal(await control.inputValue(),'一二');
      await key(page);assert.equal(await control.inputValue(),'一二',`${name}: active native IME must block global undo`);
      await cdp.send('Input.insertText',{text:'一二'});await page.waitForTimeout(50);await cdp.detach();await key(page);assert.equal(await control.inputValue(),before,`${name}: one undo reverts whole long composition`);
      await control.focus();await key(page,'Control+y');assert.equal(await control.inputValue(),'一二');
      await control.focus();await control.press('End');await control.pressSequentially('x');await key(page);assert.equal(await control.inputValue(),'一二',`${name}: explicit composition end splits later typing`);
    }
    await context.close();results.push({scenario:'R1 real Chrome CDP native title and textarea long IME, blocked pre-end undo, one-step undo/redo and post-end boundary',pass:true});console.log('PASS R1 native title/textarea actual IME');
  }
  if (!process.env.HISTORY_FIX_CASE || process.env.HISTORY_FIX_CASE==='structural') {
    const p=text=>({type:'paragraph',...(text?{content:[{type:'text',text}]}:{})}),item=text=>({type:'list_item',content:[p(text)]});
    for(const kind of ['paragraph Enter','paragraph Shift-Enter','paragraph Delete','list Enter','list Tab','list Shift-Tab']) {
      const doc=pageDocument('Structural '+kind);
      const content=kind.startsWith('paragraph')?{type:'doc',content:kind==='paragraph Delete'?[p('First'),p('Second')]:[p('')]}:{type:'doc',content:[{type:'bullet_list',content:kind==='list Shift-Tab'?[{type:'list_item',content:[p('First'),{type:'bullet_list',content:[item('Second')]}]}]:[item('First'),item('Second')]}]};
      blocks(doc)[0].content=content;const id=await create(doc),{page,context}=await visit(`/__history?id=${id}`);await page.locator('html[data-ready=true]').waitFor();
      const rich=page.locator('#rich .ProseMirror'),position=kind==='paragraph Delete'?6:kind.startsWith('paragraph')?1:18;
      await page.evaluate(({content,position})=>fixture.editor.sync(content,{from:position,to:position}),{content,position});await rich.focus();
      const snapshot=()=>page.evaluate(()=>fixture.state.document.sections[0].rows[0].columns[0].blocks[0].content);
      const before=await snapshot();await rich.pressSequentially('a');const typed=await snapshot();
      await rich.press(kind.slice(kind.indexOf(' ')+1).replace('Shift-','Shift+'));const structured=await snapshot();assert.notDeepEqual(structured,typed,kind+' actually changed structure');
      assert.equal(await page.evaluate(()=>fixture.changes.at(-1).closeGroup),true,kind+': actual PM transaction emits command boundary');
      await rich.pressSequentially('b');const after=await snapshot();await key(page);assert.deepEqual(await snapshot(),structured,kind+': first undo removes only later typing');
      await key(page);assert.deepEqual(await snapshot(),typed,kind+': second undo removes only structure');await key(page);assert.deepEqual(await snapshot(),before,kind+': third undo removes earlier typing');
      assert.equal(await page.evaluate(()=>fixture.state.canUndo),false,kind+': false-command fallback creates no extra entry');
      for(let i=0;i<3;i++)await key(page,'Control+y');assert.deepEqual(await snapshot(),after);await context.close();
    }
    results.push({scenario:'R1 real PM paragraph fallback Enter/hard break and list split/indent/outdent isolated between typing on global undo/redo',pass:true});console.log('PASS R1 PM structural keyboard boundaries/fallback');
  }

  if (!process.env.HISTORY_FIX_CASE) {
  // Actual mounted Editor V2, v2 document with two independent rich blocks.
  {
    const document = pageDocument('History integration'); document.schema_version=2; document.template.version=2;
    const a = blocks(document)[0]; a.content=richDoc('Block A');
    const b = {...structuredClone(a),id:randomUUID(),content:richDoc('Block B')}; document.sections[0].rows[0].columns[0].blocks.push(b);
    const id = await create(document), {page,context} = await visit(`/page-editor.html?id=${id}`);
    await pagesBrowserReady(page); await page.locator('.ProseMirror').first().waitFor();
    const pmA=page.locator(`[data-block-id="${a.id}"] .ProseMirror`), pmB=page.locator(`[data-block-id="${b.id}"] .ProseMirror`);
    await pmA.evaluate(n=>{globalThis.identity={a:n,av:n.pmViewDesc};});
    await pmB.evaluate(n=>{Object.assign(globalThis.identity,{b:n,bv:n.pmViewDesc});});
    assert.equal(await page.evaluate(()=>!!identity.av&&!!identity.bv),true,'real PM root view descriptors exist');
    await pmA.click(); await pmA.press('Control+End'); await pmA.pressSequentially(' typed');
    await page.locator(`[data-block-id="${b.id}"] .pages-select-block`).click();
    await advancedPosition(page);
    await page.locator('.pages-legacy-presentation > summary').click();
    await page.getByRole('combobox',{name:'Fonte',exact:true}).selectOption('oswald');
    await pagesEditorOrganize(page);
    await page.locator(`[data-block-id="${a.id}"] .pages-select-block`).click();
    await advancedPosition(page);
    await page.getByRole('button',{name:'Mover bloco para baixo',exact:true}).click();
    assert.deepEqual(await page.locator('.pages-editor-block').evaluateAll(ns=>ns.map(n=>n.dataset.blockId)),[b.id,a.id]);
    await pmA.focus(); await key(page);
    assert.deepEqual(await page.locator('.pages-editor-block').evaluateAll(ns=>ns.map(n=>n.dataset.blockId)),[a.id,b.id]);
    await page.getByLabel('Mais opções de texto',{exact:true}).click();
    await page.getByRole('button',{name:'Desfazer texto',exact:true}).click();
    assert.equal(await page.locator(`[data-block-id="${b.id}"]`).getAttribute('data-font'),'manrope');
    await key(page); assert.equal(await pmA.innerText(),'Block A');
    for (const shortcut of ['Control+Shift+z','Control+y','Control+Shift+z']) await key(page,shortcut);
    assert.match(await pmA.innerText(),/typed/); assert.deepEqual(await page.locator('.pages-editor-block').evaluateAll(ns=>ns.map(n=>n.dataset.blockId)),[b.id,a.id]);
    assert.equal(await pmA.evaluate(n=>n===identity.a&&n.pmViewDesc===identity.av),true);
    assert.equal(await pmB.evaluate(n=>n===identity.b&&n.pmViewDesc===identity.bv),true);
    // A stale block captured before style/move must not receive new content.
    await pmA.focus(); await pmA.press('Control+End'); await pmA.pressSequentially(' newest');
    await saved(page,id); let persisted=await api('get',`/${id}/workspace`);
    assert.match(JSON.stringify(blocks(persisted.draft.document).find(x=>x.id===a.id).content),/newest/);
    await pmA.focus(); await key(page); assert.doesNotMatch(await pmA.innerText(),/newest/);
    assert.equal(await page.locator('#page-editor-root').getAttribute('data-save-state'),'dirty');
    assert.equal(await page.getByRole('button',{name:'Publicar',exact:true}).isDisabled(),true);
    await key(page,'Control+y'); assert.equal(await page.locator('#page-editor-root').getAttribute('data-save-state'),'saved');
    // Structural history shares delete recovery and restores valid selection.
    await page.locator(`[data-block-id="${a.id}"] .pages-select-block`).click(); await advancedPosition(page); await page.getByRole('button',{name:'Duplicar',exact:true}).click();
    assert.equal(await page.locator('.ProseMirror').count(),3);
    await advancedPosition(page); await page.getByRole('button',{name:'Excluir',exact:true}).click(); assert.equal(await page.locator('.ProseMirror').count(),2);
    await page.getByRole('button',{name:'Desfazer exclusão',exact:true}).click(); assert.equal(await page.locator('.ProseMirror').count(),3);
    await key(page); assert.equal(await page.locator('.ProseMirror').count(),2);
    await pagesEditorPageProperties(page);
    const title=page.getByRole('textbox',{name:'Título',exact:true}); await title.fill('Changed metadata'); await key(page);
    assert.equal(await title.inputValue(),'History integration');
    await page.locator('[data-audience-summary]').click();
    const audience=page.getByRole('checkbox',{name:'Cargo sintético B',exact:true}); await audience.check(); await key(page); assert.equal(await audience.isChecked(),false);
    assert.equal(await page.locator('#page-editor-root').getAttribute('data-save-state'),'saved');
    await page.reload(); await pagesBrowserReady(page); await pmA.waitFor(); assert.match(await pmA.innerText(),/newest/);
    await page.screenshot({path:join(output,'mounted-history.png')});
    results.push({scenario:'mounted V2 cross-block typing/style/move undo3+redo keymap, retained EditorViews, latest-ID edit/save/SQL/reload, delete/duplicate/recovery, metadata/audience',pass:true});
    console.log('PASS mounted cross-block/metadata/SQL/reload');
    await context.close();
  }
  // Mounted explicit save ambiguity, upload/save/conflict locks and redo fork.
  {
    const id=await create(), {page,context}=await visit(`/page-editor.html?id=${id}`); await pagesBrowserReady(page);
    const rich=page.locator('.ProseMirror').first(); await rich.waitFor(); await rich.click(); await rich.press('Control+End'); await rich.pressSequentially(' ambiguous');
    let original, enter, release; const entered=new Promise(r=>{enter=r;}), held=new Promise(r=>{release=r;});
    await context.route(`**/api/pages/${id}/draft`,async route=>{original=route.request().postData();enter();await held;const response=await route.fetch();assert.equal(response.status(),200);await route.fulfill({status:503,contentType:'application/json',body:'{"error":"lost ACK after COMMIT"}'});},{times:1});
    await page.getByRole('button',{name:/Salvar rascunho/}).click(); await entered;
    await rich.focus(); await key(page); assert.match(await rich.innerText(),/ambiguous/,'saving blocks global undo'); release();
    await page.locator('#page-editor-root[data-save-state=failure]').waitFor();
    await rich.focus(); await key(page); assert.doesNotMatch(await rich.innerText(),/ambiguous/); assert.equal(await page.getByRole('button',{name:'Publicar',exact:true}).isDisabled(),true);
    await rich.press('Control+End'); await rich.pressSequentially(' fork'); await key(page,'Control+y'); assert.match(await rich.innerText(),/fork/); assert.doesNotMatch(await rich.innerText(),/ambiguous/);
    const retry=page.waitForRequest(r=>r.method()==='PUT'&&new URL(r.url()).pathname===`/api/pages/${id}/draft`);
    await page.getByRole('button',{name:/Salvar rascunho/}).click(); assert.equal((await retry).postData(),original);
    await page.locator('#page-editor-root[data-save-state=dirty]').waitFor();
    assert.match(JSON.stringify((await api('get',`/${id}/workspace`)).draft.document),/ambiguous/); assert.equal(await page.getByRole('button',{name:'Publicar',exact:true}).isDisabled(),true);
    // A held upload blocks undo and its ambiguous retry remains a guard.
    let uploadEnter, uploadRelease;const ue=new Promise(r=>{uploadEnter=r;}), uh=new Promise(r=>{uploadRelease=r;});
    await context.route(`**/api/pages/${id}/media`,async route=>{uploadEnter();await uh;await route.fulfill({status:503,contentType:'application/json',body:'{"error":"upload unknown"}'});},{times:1});
    await page.locator('input[type=file]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from('synthetic bytes intercepted before upload')}); await ue;
    await rich.focus();await key(page);assert.match(await rich.innerText(),/fork/); uploadRelease();
    await page.getByRole('button',{name:'Cancelar upload não confirmado',exact:true}).waitFor();
    await rich.focus();await key(page);assert.match(await rich.innerText(),/fork/);
    await page.getByRole('button',{name:'Cancelar upload não confirmado',exact:true}).click();
    const asset=referenceMedia()[0],uploadResponse=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`/api/pages/${id}/media`);
    await page.locator('input[type=file]').setInputFiles({name:asset.file_name,mimeType:'image/webp',buffer:asset.bytes});
    assert.equal((await uploadResponse).status(),201);await page.locator('[data-block-type=image]').waitFor();
    await page.waitForFunction(()=>!document.querySelector('.pages-recovery-actions button').disabled);
    await rich.focus();await key(page);assert.equal(await page.locator('[data-block-type=image]').count(),0);
    assert.equal((await h.db.query('SELECT COUNT(*)::int AS n FROM page_media WHERE page_id=$1',[id])).rows[0].n,1,'undo removes reference, never physical upload');
    await key(page,'Control+y');await page.locator('[data-block-type=image]').waitFor();
    await key(page);assert.equal(await page.locator('[data-block-type=image]').count(),0);
    // Independent real CAS edit creates a genuine conflict.
    const w=await api('get',`/${id}/workspace`); w.draft.document.metadata.summary='remote';await api('put',`/${id}/draft`,{expected_version:w.version,client_mutation_id:randomUUID(),document:w.draft.document});
    const conflict=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname===`/api/pages/${id}/draft`);
    await page.getByRole('button',{name:/Salvar rascunho/}).click();assert.equal((await conflict).status(),409);await page.locator('#page-editor-root[data-save-state=conflict]').waitFor();
    await rich.focus();await key(page);assert.match(await rich.innerText(),/fork/);
    results.push({scenario:'real COMMIT lost ACK/retry byte equality, post-undo fork, blocked save/upload/ambiguous upload, actual upload reference undo/redo without deleting stored bytes, real CAS conflict',pass:true});await context.close();
  }
  for (const ambiguous of [false,true]) {
    const id=await create(), {page,context}=await visit(`/__history?id=${id}`);await page.locator('html[data-ready=true]').waitFor();
    await page.evaluate(()=>fixture.upgrade());
    assert.equal(await page.evaluate(()=>fixture.travel('undo')),true);assert.equal(await page.evaluate(()=>fixture.state.document.schema_version),1);
    await page.evaluate(()=>fixture.travel('redo'));
    if(ambiguous){await context.route(`**/api/pages/${id}/draft`,async route=>{const r=await route.fetch();assert.equal(r.status(),200);await route.fulfill({status:503,contentType:'application/json',body:'{"error":"lost v3 ack"}'});},{times:1});
      await page.evaluate(async()=>{try{await fixture.state.save(fixture.api);}catch{}globalThis.frozen=JSON.stringify(fixture.state.pending);fixture.travel('undo');});
      assert.equal(await page.evaluate(()=>fixture.state.document.schema_version),1);
      await context.route(`**/api/pages/${id}/draft`,async route=>{assert.equal(route.request().postData(),await page.evaluate(()=>frozen));await route.continue();},{times:1});
    }
    assert.equal(await page.evaluate(()=>fixture.state.save(fixture.api)),true);
    if(!ambiguous)await page.evaluate(()=>fixture.travel('undo'));
    assert.equal(await page.evaluate(()=>fixture.state.document.schema_version),3);
    await page.evaluate(()=>fixture.state.transact({},d=>{d.metadata.title='post floor';}));
    assert.equal(await page.evaluate(()=>fixture.state.save(fixture.api)),true);
    assert.equal((await api('get',`/${id}/workspace`)).draft.document.schema_version,3);
    results.push({scenario:`actual v1 upgrade before/after v3 ACK floor, ${ambiguous?'lost COMMIT ACK retry':'direct ACK'}, no downgrade POST`,pass:true});await context.close();
  }
  {
    // Same actual persisted PGlite head, a second owned router with the default
    // writer flag off. Does not reconfigure any existing or production service.
    const id=await create(upgradeDocument(pageDocument('Read only v3 head')));
    const app=express();app.use(express.json());
    app.use('/api/pages',createPagesRouter({pool:h.pool,authenticate:h.authenticate,uploadDirectory:h.directory}));app.use(h.app);
    const server=createServer(app);await new Promise(done=>server.listen(0,'127.0.0.1',done));
    try {
      const origin=`http://127.0.0.1:${server.address().port}`;
      for(const uid of ['super','publisher']) {
        const {page,context}=await visit(`/page-editor.html?id=${id}`,origin,uid);await pagesBrowserReady(page);await page.locator('.pages-document').waitFor();
        assert.equal(await page.locator('.ProseMirror').count(),0);
        const save=page.getByRole('button',{name:/Salvar rascunho/});
        assert.equal(await save.count(),uid==='super'?1:0,'stable Save retained for author without v3 writer support; nonauthor cannot edit');
        if(uid==='super')assert.equal(await save.isDisabled(),true,'read-only Save cannot write');
        await pagesEditorPageProperties(page);assert.equal(await page.getByRole('textbox',{name:'Título',exact:true}).isDisabled(),true);
        await key(page);await context.close();
      }
      results.push({scenario:'actual v3 head with default writer disabled and nonauthor publisher remain read only, no PM/history editing',pass:true});
    } finally {server.closeAllConnections();await new Promise(done=>server.close(done));}
  }
  {
    const doc=upgradeDocument(pageDocument('FAQ bookmark')), itemId=randomUUID(), blockId=blocks(doc)[0].id;
    doc.sections[0].rows[0].columns[0].blocks=[{id:blockId,type:'faq',items:[{id:itemId,question:'Question',answer:richDoc('Answer')}]}];
    const id=await create(doc),{page,context}=await visit(`/__history?id=${id}`);await page.locator('html[data-ready=true]').waitFor();
    const rich=page.locator('#rich .ProseMirror');await rich.click();await rich.press('Control+End');
    await page.waitForFunction(()=>fixture.editor.bookmark().from===7);
    const beforeBookmark=await page.evaluate(()=>fixture.editor.bookmark());
    await rich.pressSequentially(' appended');
    await page.evaluate(()=>{globalThis.beforeCalls=fixture.calls;globalThis.view=document.querySelector('#rich .ProseMirror').pmViewDesc;});
    await key(page);assert.equal(await rich.innerText(),'Answer');
    assert.deepEqual(await page.evaluate(()=>fixture.state.selection),beforeBookmark);
    assert.equal(beforeBookmark.blockId,blockId);assert.equal(beforeBookmark.itemId,itemId);
    await key(page,'Control+y');assert.match(await rich.innerText(),/appended/);
    assert.equal(await page.evaluate(()=>fixture.calls===beforeCalls&&document.querySelector('#rich .ProseMirror').pmViewDesc===view),true,'sync is silent on same view');
    await page.evaluate(()=>fixture.editor.sync({type:'doc',content:[{type:'paragraph'}]},{blockId:'ignored',from:999,to:1000}));
    assert.equal(await page.evaluate(()=>fixture.editor.bookmark().from),1,'clamp past end');
    await page.evaluate(()=>fixture.reconcile());
    // Actual Chrome DOM composition events + PM transactions, with >500ms gap.
    await rich.focus();const cdp=await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition',{text:'一',selectionStart:1,selectionEnd:1});
    await page.waitForTimeout(650);
    await cdp.send('Input.imeSetComposition',{text:'一二',selectionStart:2,selectionEnd:2});
    assert.equal(await page.evaluate(()=>fixture.editor.composing),true,'Chrome started actual IME');
    const composingText=await rich.innerText();await key(page);assert.equal(await rich.innerText(),composingText,'active IME blocks undo');
    await cdp.send('Input.insertText',{text:'一二'});await page.waitForTimeout(50);await cdp.detach();
    await key(page);assert.doesNotMatch(await rich.innerText(),/一|二/,'one undo removes complete long IME group');
    await key(page,'Control+y');assert.match(await rich.innerText(),/一二/);
    // Standalone consumers still get the independent local PM fallback.
    const standalone=page.locator('#standalone .ProseMirror');await standalone.click();await standalone.pressSequentially('fallback');await key(page);assert.equal((await standalone.innerText()).trim(),'');
    await key(page,'Control+y');assert.equal(await standalone.innerText(),'fallback');
    assert.equal(await page.evaluate(()=>fixture.editor.mark('unsupported')),false);
    results.push({scenario:'actual PM FAQ item bookmarks, silent same-view sync/clamp, long IME grouping/end/guard, standalone fallback',pass:true});await context.close();
  }
  }
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  await writeFile(join(output,'results.json'),JSON.stringify({results,errors,blocked,limitations:['synthetic Firebase identity','serialized PGlite, not native PostgreSQL concurrency','owned Chrome on Windows, not final Task14 visual acceptance']},null,2)+'\n');
  console.log(`Pages history: ${results.length} Chrome/PM/PGlite scenarios passed; ${output}`);
} finally { await browser?.close(); await h.close(); }
