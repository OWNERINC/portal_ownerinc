// Task 14: actual DOM/PM/SQL/HTTP. Owned loopback + synthetic identities only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createPagesDatabaseHarness} from '../database/check-pages.mjs';
import {pagesBrowserContext,pagesBrowserReady,pagesEditorPreview} from '../helpers/pages-browser.mjs';
import {referenceDocument,referenceIds as ids} from '../helpers/pages-reference-document.mjs';
for(const key of ['PGLITE_MODULE_PATH','PLAYWRIGHT_MODULE_PATH'])if(!process.env[key])throw Error(`Set external ${key}`);
const {chromium}=await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const require=createRequire(new URL('../../api/package.json',import.meta.url)),express=require('express');
const h=await createPagesDatabaseHarness({v3WritesEnabled:true}),results=[],errors=[],geometry=[];
const strictReferenceGeometry=process.argv.includes('--strict-reference-geometry');
const referenceDifferences=[];
const output=resolve(process.env.WORKSPACE_VISUAL_OUTPUT||join(tmpdir(),'opencode','pages-workspace'));
await mkdir(output,{recursive:true});let browser;
async function api(method,path,body,actor='super'){const r=await h.api(method,path,body,actor);assert.ok(r.status>=200&&r.status<300,`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);return r.body;}
const key=()=>({client_mutation_id:randomUUID()});
async function visit(id,options={}){const v=await pagesBrowserContext(browser,{width:1600,errors,...options});await v.page.setViewportSize({width:1600,height:1160});await v.page.goto(`${h.origin}/page-editor.html?id=${id}`);await pagesBrowserReady(v.page);return v;}
const box=locator=>locator.evaluate(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
const near=(actual,expected,label,tolerance=2)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${label}: expected ${expected} ±${tolerance}, got ${actual}`);
async function properties(p){await p.getByRole('button',{name:'Página',exact:true}).click();}
async function save(p){await properties(p);await p.getByRole('button',{name:'Salvar rascunho',exact:true}).click();await p.locator('#page-editor-root[data-save-state=saved]').waitFor();}
try{
  h.app.use(express.static(fileURLToPath(new URL('../../public/',import.meta.url))));
  browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});
  const {id}=await api('post','',{template_id:'comunicado',...key()});
  const document=referenceDocument();document.metadata.audience.job_title_ids=[];
  await api('put',`/${id}/draft`,{expected_version:0,...key(),document});
  const v=await pagesBrowserContext(browser,{width:1600,errors}),p=v.page;
  await v.context.route('**/pages/editor.js',async route=>{const source=await readFile(new URL('../../public/pages/editor.js',import.meta.url),'utf8');await route.fulfill({contentType:'text/javascript',body:source.replace('  void load();\n}', '  globalThis.__referenceDraft=()=>state.document;\n  void load();\n}')});});
  await p.setViewportSize({width:1600,height:1160});await p.goto(`${h.origin}/page-editor.html?id=${id}`);await pagesBrowserReady(p);await p.locator('.ProseMirror').first().waitFor();
  const introPM=p.locator(`[data-block-id="${ids.introductionBlock}"] .ProseMirror`);await introPM.click();await introPM.press('Control+Home');await introPM.press('ArrowRight');
  const draft=await p.evaluate(()=>JSON.stringify(__referenceDraft()));
  const unscaledToolbarWidth=Math.round((await box(p.locator('.pages-v2-viewport > .pages-format-tools'))).width);
  await p.locator('.ProseMirror').first().evaluate(n=>{globalThis.pmIdentity={node:n,view:n.pmViewDesc};globalThis.workspaceViews=[...document.querySelectorAll('.ProseMirror')].map(node=>({node,view:node.pmViewDesc}));});
  const header=await box(p.locator('.pages-v2-header')),tools=await box(p.locator('.pages-v2-tools')),paper=await box(p.locator('.pages-editor-surface'));
  geometry.push({header,tools,paper});assert.equal(header.height,72);assert.equal(tools.height,56);assert.deepEqual(paper,{x:248,y:188,width:1044,height:944});
  assert.equal(await p.locator('.pages-v2-structure').evaluate(n=>n.clientWidth),219);
  assert.equal((await box(p.locator('.pages-v2-brand'))).height,44,'original wordmark crop retains a full link target');
   // Tasks 1–3 use real targets, not overlapping invisible extensions.
   for(const selector of ['.pages-primary-actions > .btn','.pages-primary-actions > .pages-action-button','.pages-v2-preview-menu > summary','.pages-v2-structure > .btn']){
    const control=p.locator(selector),target=await box(control);geometry.push({targetSelector:selector,target});
    assert.ok(target.width>=44&&target.height>=44,`${selector}: real 44px target, not an overlapping extension`);
    assert.equal(await control.evaluate(n=>{const r=n.getBoundingClientRect();return [[.5,.5],[.05,.05],[.95,.05],[.05,.95],[.95,.95]].every(([x,y])=>n.contains(document.elementFromPoint(r.x+r.width*x,r.y+r.height*y)));}),true,`${selector}: center and inset corners receive pointer hits`);
  }
  const contentAnchors={};
  for(const [name,id] of Object.entries({intro:ids.introductionBlock,daily:ids.dailyBlock,meetings:ids.meetingsBlock,faq:ids.faqBlock,audio:ids.audioBlock}))contentAnchors[name]=await box(p.locator(`.pages-editor-block[data-block-id="${id}"]`));
  contentAnchors.faqRows=await p.locator('[data-block-type=faq] [data-media-item-id]').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {y:r.y,height:r.height};}));
  geometry.push({contentAnchors});
  await p.mouse.move(800,100);await p.screenshot({path:join(output,'desktop-editing-1600.png')});
  await p.getByRole('button',{name:'Estilo da página',exact:true}).click();
  const styleRect=await box(p.getByRole('dialog',{name:'Estilo da página',exact:true}));
  geometry.push({style:styleRect,inline:await p.getByRole('dialog',{name:'Estilo da página',exact:true}).getAttribute('style')});
  await p.screenshot({path:join(output,'desktop-style-1600.png')});await p.keyboard.press('Escape');
  await p.getByRole('button',{name:'Inserir bloco',exact:true}).click();
  const insertRect=await box(p.getByRole('dialog',{name:'O que você quer adicionar?',exact:true}));
  geometry.push({insert:insertRect,inline:await p.getByRole('dialog',{name:'O que você quer adicionar?',exact:true}).getAttribute('style'),trigger:await box(p.getByRole('button',{name:'Inserir bloco',exact:true}))});
  await p.screenshot({path:join(output,'desktop-insert-1600.png')});await p.keyboard.press('Escape');
  assert.deepEqual(styleRect,{x:360,y:118,width:400,height:663},'style panel matches the source, not just a recorded measurement');
  assert.deepEqual(insertRect,{x:24,y:118,width:380,height:621},'insert panel anchors at the actual trigger bottom');
  near(contentAnchors.intro.y,381,'intro top');near(contentAnchors.intro.y+contentAnchors.intro.height,555,'intro bottom');
  for(const name of ['daily','meetings']){near(contentAnchors[name].y,571,`${name} top`);near(contentAnchors[name].height,126,`${name} height`);}
  near(contentAnchors.faq.y,777,'FAQ top');near(contentAnchors.audio.y,777,'audio top');near(contentAnchors.audio.height,191,'audio height');
  near(contentAnchors.faqRows[0].y+contentAnchors.faqRows[0].height,851,'first FAQ rule');
  near(contentAnchors.faqRows[1].y+contentAnchors.faqRows[1].height,900,'second FAQ rule');
  for(const row of contentAnchors.faqRows)near(row.height,49,'collapsed FAQ density');
  assert.deepEqual(JSON.parse(draft).sections[1].rows[0].columns[0].blocks[0].tags,['Cultura','Guia']);
  assert.equal(await p.getByRole('textbox',{name:'Tags do bloco',exact:true}).inputValue(),'Cultura, Guia');
  assert.equal(await p.locator('.pages-editor-block > .pages-block-tags').count(),0,'persisted tags are edited in the inspector, without duplicated canvas badges');
  for(const selector of ['.pages-v2-preview-menu > summary','.pages-primary-actions > .btn','.pages-device-control']){
    const icon=p.locator(selector).locator('svg:not(.pages-device-chevron)');assert.equal(await icon.count(),1,`${selector}: local icon`);
    assert.equal(await icon.getAttribute('aria-hidden'),'true');assert.equal(await icon.getAttribute('focusable'),'false');
    near((await box(icon)).width,16,`${selector} icon width`,.1);
  }
  assert.equal(await p.getByRole('combobox',{name:'Dispositivo',exact:true}).evaluate(n=>parseFloat(getComputedStyle(n).paddingLeft)),32,'device text clears the local monitor icon');
  const deviceText=await p.getByRole('combobox',{name:'Dispositivo',exact:true}).evaluate(n=>{
    const style=getComputedStyle(n),context=document.createElement('canvas').getContext('2d');context.font=style.font;
    return {textWidth:context.measureText(n.selectedOptions[0].textContent).width,available:n.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),appearance:style.appearance};
  });
  assert.equal(deviceText.appearance,'none');assert.ok(deviceText.textWidth<=deviceText.available,`Desktop text must not be clipped by the chevron: ${JSON.stringify(deviceText)}`);
  assert.equal((await box(p.getByRole('button',{name:'Publicar',exact:true}))).width,100,'source compact publish action');
  results.push('1600 header72/bar56/rails220+280/paper1044x944; actual guide and native anchored panels captured');
  const editorSizes=await p.evaluate(ids=>({cover:getComputedStyle(document.querySelector(`[data-block-id="${ids.coverBlock}"] .ProseMirror h2`)).fontSize,intro:getComputedStyle(document.querySelector(`[data-block-id="${ids.introductionBlock}"] .ProseMirror p`)).fontSize,faq:getComputedStyle(document.querySelector(`[data-media-item-id="${ids.faqItem}"] > summary`)).fontSize}),ids);
  await pagesEditorPreview(p,'desktop');
  const previewSizes=await p.evaluate(ids=>({cover:getComputedStyle(document.querySelector(`.pages-document [data-block-id="${ids.coverBlock}"] h2`)).fontSize,intro:getComputedStyle(document.querySelector(`.pages-document [data-block-id="${ids.introductionBlock}"] p`)).fontSize,faq:getComputedStyle(document.querySelector(`.pages-document [data-faq-item-id="${ids.faqItem}"] h3`)).fontSize}),ids);
  assert.deepEqual(editorSizes,{cover:'36px',intro:'15px',faq:'12px'});assert.deepEqual(previewSizes,editorSizes);await pagesEditorPreview(p,'edit');
  results.push('guide editor/shared preview computed cover36/intro15/FAQ12 agree with canonical metrics, without changing legacy presets');
  for(const scale of ['small','large']){
    await introPM.click();const size=p.getByRole('combobox',{name:'Tamanho',exact:true});
    await size.selectOption(scale);assert.equal(await size.locator('option[value=standard]').textContent(),'Texto do modelo · 15 px');
    await size.selectOption('standard');assert.equal(await introPM.locator('p').evaluate(n=>getComputedStyle(n).fontSize),'15px');
    await p.keyboard.press('Control+z');await p.keyboard.press('Control+z');
    assert.equal(await p.evaluate(()=>JSON.stringify(__referenceDraft())),draft);
  }
  results.push('prospective guide scale labels remain truthful through small/large back to standard; undo retains original bytes');
  for(const width of [1600,1366])for(const zoom of [50,75,100,125,150])for(const device of ['desktop','mobile']){
    await p.setViewportSize({width,height:1160});await p.getByRole('combobox',{name:'Zoom',exact:true}).selectOption(String(zoom));await p.getByRole('combobox',{name:'Dispositivo',exact:true}).selectOption(device);
    await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const metrics=await p.locator('.pages-editor-surface').evaluate(n=>({clientWidth:n.clientWidth,offsetWidth:n.offsetWidth,width:n.getBoundingClientRect().width,height:n.offsetHeight,scaled:n.parentElement.getBoundingClientRect().toJSON(),scroll:{width:n.parentElement.parentElement.scrollWidth,height:n.parentElement.parentElement.scrollHeight,clientWidth:n.parentElement.parentElement.clientWidth,clientHeight:n.parentElement.parentElement.clientHeight}}));
    // CSS surface width is the actual 390px border-box; its inner content reflows.
    assert.equal(metrics.offsetWidth,device==='mobile'?390:width-556);
    assert.equal(metrics.clientWidth,device==='mobile'?390:width-556);
    assert.ok(Math.abs(metrics.width-metrics.offsetWidth*zoom/100)<.1);
    assert.ok(Math.abs(metrics.scaled.height-metrics.height*zoom/100)<1);
    assert.ok(Math.abs(metrics.scroll.width-Math.max(metrics.scroll.clientWidth,metrics.scaled.width))<2,'scroll width follows scaled paper');
    assert.ok(Math.abs(metrics.scroll.height-Math.max(metrics.scroll.clientHeight,metrics.scaled.height))<2,'scroll height follows scaled paper');
    assert.equal(await p.evaluate(()=>JSON.stringify(__referenceDraft())),draft);
    assert.equal(await p.locator('.ProseMirror').first().evaluate(n=>n===pmIdentity.node&&n.pmViewDesc===pmIdentity.view),true);
    if(device==='mobile')assert.equal(await p.locator('.pages-editor-row > .pages-row-two_equal').evaluate(n=>getComputedStyle(n).gridTemplateColumns.split(' ').length),1);
    geometry.push({width,zoom,device,metrics});
  }
  results.push('all five zooms x desktop/mobile x 1366/1600: measured extents, reflow, exact draft bytes and same PM view');
  await p.setViewportSize({width:390,height:820});assert.equal(await p.locator('.ProseMirror').first().evaluate(n=>n===pmIdentity.node&&n.pmViewDesc===pmIdentity.view),true);assert.equal(await p.evaluate(()=>JSON.stringify(__referenceDraft())),draft);
  await p.setViewportSize({width:1600,height:1160});await p.getByRole('combobox',{name:'Dispositivo',exact:true}).selectOption('desktop');await p.getByRole('combobox',{name:'Zoom',exact:true}).selectOption('100');
  // Real mouse coordinates through actual transforms, not a temporary CSS zoom.
  await p.evaluate(()=>{globalThis.dragEvents=[];for(const type of ['pointerdown','pointerup','choose','start','move','change','end','unchoose'])document.addEventListener(type,e=>dragEvents.push({type,target:e.target.className,x:e.clientX,y:e.clientY,from:e.from?.dataset.columnId,to:e.to?.dataset.columnId,old:e.oldIndex,next:e.newIndex}),true);});
  for(const width of [1600,1366])for(const device of ['desktop','mobile'])for(const zoom of [50,75,100,125,150]){
    await p.setViewportSize({width,height:1160});
    await p.getByRole('combobox',{name:'Dispositivo',exact:true}).selectOption(device);
    await p.getByRole('combobox',{name:'Zoom',exact:true}).selectOption(String(zoom));
    await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
    const daily=p.locator(`.pages-editor-block[data-block-id="${ids.dailyBlock}"]`),meeting=p.locator(`.pages-editor-block[data-block-id="${ids.meetingsBlock}"]`);
    // Hover actual editable content, not the block's reserved toolbar area.
    // The toolbar is a real pointer target, not a transparent hit extension.
    await meeting.scrollIntoViewIfNeeded();await daily.locator('.ProseMirror h2').hover();
    await p.locator('.pages-v2-viewport').evaluate(n=>{n.scrollLeft=0;});
    const from=await box(daily.locator('.pages-drag-handle')),to=await box(meeting);
    const hit=await p.evaluate(({x,y})=>document.elementFromPoint(x,y)?.outerHTML,{x:from.x+from.width/2,y:from.y+from.height/2});
    geometry.push({dragWidth:width,dragDevice:device,dragZoom:zoom,from,to,hit});assert.match(hit,/pages-drag-handle/);
    // Sortable's fallback samples the physical pointer every 50 ms. Dwell over
    // the real destination for two samples before release; never invoke onEnd.
    await p.mouse.move(from.x+from.width/2,from.y+from.height/2);await p.mouse.down();await p.mouse.move(to.x+30,to.y+to.height-8,{steps:24});
    assert.deepEqual(await p.locator('.pages-v2-viewport > .pages-format-tools').evaluate(n=>{const s=getComputedStyle(n);return {pointerEvents:s.pointerEvents,visibility:s.visibility,opacity:s.opacity,height:n.offsetHeight};}),{pointerEvents:'none',visibility:'visible',opacity:'1',height:52},'drag yields hit-testing without hiding formatting controls');
    await p.waitForTimeout(120);await p.mouse.up();
    assert.equal(await p.locator('#page-editor-root').getAttribute('data-layout-dragging'),'false');
    try{await p.waitForFunction(({daily,meeting})=>{const blocks=__referenceDraft().sections.flatMap(s=>s.rows.flatMap(r=>r.columns));return blocks.some(c=>c.blocks.some(b=>b.id===daily)&&c.blocks.some(b=>b.id===meeting));},{daily:ids.dailyBlock,meeting:ids.meetingsBlock},{timeout:5000});}
    catch(error){geometry.push({events:await p.evaluate(()=>dragEvents)});await p.screenshot({path:join(output,`failed-drop-${zoom}.png`)});throw Error(`Drop failed at ${zoom}%: ${error.message}`);}
    await p.keyboard.press('Control+z');assert.equal(await p.evaluate(()=>JSON.stringify(__referenceDraft())),draft);
    const pm=p.locator(`[data-block-id="${ids.introductionBlock}"] .ProseMirror`);await pm.click();await pm.press('Control+Home');await pm.press('Shift+ArrowRight');
    assert.equal(await pm.evaluate(()=>getSelection().toString().length),1);
    const toolbarWidth=Math.round((await box(p.locator('.pages-v2-viewport > .pages-format-tools'))).width);
    assert.equal(toolbarWidth,unscaledToolbarWidth,'context toolbar must not zoom across widths, devices and zoom levels');
    if(toolbarWidth!==329){
      if(!referenceDifferences.length)console.warn(`REFERENCE DIFFERENCE: toolbar ${toolbarWidth}px, source 329px (approved Task 1 real targets); strict check retained via --strict-reference-geometry`);
      referenceDifferences.push({width,device,zoom,expected:329,actual:toolbarWidth,reason:'Task 1 approved real 44px formatting targets widen the unscaled toolbar'});
    }
    if(strictReferenceGeometry)assert.equal(toolbarWidth,329,'strict source reference: context toolbar must not zoom');
    const textRect=await box(pm.locator('h2')),toolbarRect=await box(p.locator('.pages-v2-viewport > .pages-format-tools'));
    geometry.push({caretWidth:width,caretDevice:device,caretZoom:zoom,textRect,toolbarRect});
    if(textRect.y<toolbarRect.y+toolbarRect.height)await p.screenshot({path:join(output,`failed-caret-${width}-${device}-${zoom}.png`)});
    assert.ok(textRect.y>=toolbarRect.y+toolbarRect.height,'unscaled toolbar never covers the text/caret');
    await p.mouse.move(10,10);await daily.locator('.pages-drag-handle').focus();await p.keyboard.press('Tab');
    assert.equal(await daily.locator('.pages-select-block').evaluate(n=>document.activeElement===n),true);
    assert.equal(await daily.locator('.pages-block-header').evaluate(n=>getComputedStyle(n).opacity),'1','keyboard focus reveals the real target without hover');
    await p.keyboard.press('Enter');assert.equal(await daily.getAttribute('class').then(value=>value.includes('is-selected')),true);
    const cardText=await box(daily.locator('.ProseMirror h2')),cardTools=await box(p.locator('.pages-v2-viewport > .pages-format-tools'));
    geometry.push({cardWidth:width,cardDevice:device,cardZoom:zoom,cardText,cardTools});
    assert.ok(cardText.y>=cardTools.y+cardTools.height,'compact card text also clears the unscaled toolbar');
    if(zoom===50)await p.screenshot({path:join(output,`caret-clearance-${width}-${device}-${zoom}.png`)});
    assert.equal(await p.evaluate(()=>JSON.stringify(__referenceDraft())),draft);
    assert.equal(await p.locator('.ProseMirror').evaluateAll(nodes=>nodes.length===workspaceViews.length&&nodes.every((node,i)=>node===workspaceViews[i].node&&node.pmViewDesc===workspaceViews[i].view)),true,'all PM nodes and views survive drop, undo, selection and zoom');
  }
  results.push('actual pointer cross-column drop + global undo + caret selection at five zooms, both devices and 1366/1600; unscaled toolbar clears text; keyboard-only targets');
  await p.getByRole('combobox',{name:'Dispositivo',exact:true}).selectOption('desktop');
  await p.getByRole('combobox',{name:'Zoom',exact:true}).selectOption('100');
  const faq=p.locator(`[data-media-item-id="${ids.faqItem}"]`);assert.equal(await faq.evaluate(n=>n.open),false);
  await faq.locator('summary').click();assert.equal(await faq.evaluate(n=>n.open),true);await faq.locator('.ProseMirror').fill('Real retained answer');await p.keyboard.press('Control+z');await faq.locator('summary').click();
  results.push('FAQ collapsed display opens the real native question and keyed PM answer, with global undo');
  // Creation cancel/guard/failure and receipt replay after a real COMMIT.
  const oldURL=p.url();await p.getByRole('combobox',{name:'Modelo',exact:true}).focus();await p.keyboard.press('ArrowDown');await p.keyboard.press('Escape');
  // Native keyboard selection may open the explicit confirmation, but never creates.
  if(await p.getByRole('button',{name:'Cancelar',exact:true}).count())await p.getByRole('button',{name:'Cancelar',exact:true}).click();
  assert.equal((await api('get','/manage?limit=100')).length,1);
  const beforeCancel=await p.evaluate(()=>JSON.stringify(__referenceDraft()));
  await p.getByRole('combobox',{name:'Modelo',exact:true}).selectOption('guia-interno');assert.equal((await api('get','/manage?limit=100')).length,1);await p.getByRole('button',{name:'Cancelar',exact:true}).click();assert.equal(p.url(),oldURL);
  assert.equal(await p.evaluate(()=>JSON.stringify(__referenceDraft())),beforeCancel);assert.equal(await p.locator('.ProseMirror').first().evaluate(n=>n===pmIdentity.node&&n.pmViewDesc===pmIdentity.view),true);
  await p.locator(`[data-block-id="${ids.introductionBlock}"] .ProseMirror`).fill('Unsaved original');
  let prompts=0;const dismiss=dialog=>{prompts++;void dialog.dismiss();};p.on('dialog',dismiss);
  await p.getByRole('combobox',{name:'Modelo',exact:true}).selectOption('guia-interno');await p.getByRole('button',{name:'Criar novo rascunho',exact:true}).click();await p.waitForTimeout(50);assert.equal(prompts,1);assert.equal(p.url(),oldURL);assert.equal((await api('get','/manage?limit=100')).length,1);p.off('dialog',dismiss);
  const requests=[];let lose=true;
  await v.context.route('**/api/pages',async route=>{if(route.request().method()!=='POST')return route.fallback();requests.push(route.request().postDataJSON());const response=await route.fetch();if(lose){lose=false;await route.abort('failed');}else await route.fulfill({response});});
  const accept=dialog=>{prompts++;void dialog.accept();};p.on('dialog',accept);
  await p.getByRole('combobox',{name:'Modelo',exact:true}).selectOption('guia-interno');await p.getByRole('button',{name:'Criar novo rascunho',exact:true}).click();await p.waitForFunction(()=>document.querySelector('dialog[open] [role=alert]')?.textContent);
  await p.getByRole('button',{name:'Criar novo rascunho',exact:true}).waitFor({state:'visible'});assert.equal(p.url(),oldURL);
  // An acknowledged create followed by a failed shell preparation must retain
  // old URL/document/PM. A later explicit attempt navigates the same ACK, no POST.
  let navigationFailed=false;
  await v.context.route('**/page-editor.html*',route=>{navigationFailed=true;return route.fulfill({status:503,contentType:'text/plain',body:'owned synthetic navigation failure'});});
  await p.getByRole('button',{name:'Criar novo rascunho',exact:true}).click();await p.waitForFunction(()=>!document.querySelector('dialog[open]'));
  assert.equal(navigationFailed,true);assert.equal(p.url(),oldURL);assert.equal(await p.locator('.ProseMirror').first().evaluate(n=>n===pmIdentity.node&&n.pmViewDesc===pmIdentity.view),true);
  await v.context.unroute('**/page-editor.html*');
  await p.getByRole('combobox',{name:'Modelo',exact:true}).selectOption('guia-interno');await p.getByRole('button',{name:'Criar novo rascunho',exact:true}).click();await p.waitForURL(url=>url.searchParams.get('id')!==id);await pagesBrowserReady(p);await p.locator('.ProseMirror').first().waitFor();
  assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);assert.equal((await api('get','/manage?limit=100')).length,2);assert.equal(prompts,4,'one leave confirmation per explicit attempt, not a second prompt during navigation');
  const created=new URL(p.url()).searchParams.get('id'),w=await api('get',`/${created}/workspace`);assert.equal(w.draft.document.template.id,'guia-interno');assert.deepEqual(w.draft.document.metadata.audience.job_title_ids,[]);
  assert.equal((await api('get',`/${id}/workspace`)).draft.document.metadata.title,document.metadata.title);
  results.push('model opening/cancel/dirty guard create zero; real committed lost ACK retry same key creates exactly one NEW page; navigation failure preserves old views and reuses confirmed ACK');
  await p.locator('.ProseMirror').first().fill('Saved through component');await properties(p);await p.keyboard.press('Control+s');await p.locator('#page-editor-root[data-save-state=saved]').waitFor();assert.equal(await p.getByRole('button',{name:'Salvo',exact:true}).count(),1);await p.getByRole('textbox',{name:'Título',exact:true}).fill('New dirty title');assert.equal(await p.getByRole('button',{name:'Salvar rascunho',exact:true}).count(),1);assert.equal(await p.getByRole('button',{name:'Salvo',exact:true}).count(),0);
  results.push('Mod+S sends actual save ACK via shared component; later edits clear Saved confirmation');
  let releaseAck,confirmCommit;const held=new Promise(r=>releaseAck=r),committed=new Promise(r=>confirmCommit=r);
  await v.context.route(`**/api/pages/${created}/draft`,async route=>{const response=await route.fetch();confirmCommit();await held;await route.fulfill({response});});
  await p.getByRole('button',{name:'Salvar rascunho',exact:true}).click();await committed;
  await p.getByRole('textbox',{name:'Título',exact:true}).fill('Newer edit while save in flight');releaseAck();await p.locator('#page-editor-root[data-save-state=dirty]').waitFor();
  assert.equal(await p.getByRole('button',{name:'Salvo',exact:true}).count(),0);assert.equal((await api('get',`/${created}/workspace`)).draft.document.metadata.title,'New dirty title');
  await v.context.unroute(`**/api/pages/${created}/draft`);results.push('actual committed save ACK never claims Saved for newer unsaved edits');
  await save(p);await p.locator('.pages-v2-brand').click();await p.waitForURL('**/dashboard.html');assert.equal(await p.locator('body').evaluate(n=>n.classList.contains('pages-editor-active')),false);await p.goBack();await pagesBrowserReady(p);await p.locator('.ProseMirror').first().waitFor();assert.equal(await p.locator('body').evaluate(n=>n.classList.contains('pages-editor-active')),true);
  results.push('Portal shell restored on dashboard exit; browser Back remounts editor lifecycle');
  await v.context.close();
  const touch=await visit(id,{touch:true});
  const touchBlock=touch.page.locator(`.pages-editor-block[data-block-id="${ids.meetingsBlock}"]`);
  await touchBlock.locator('.ProseMirror h2').tap();assert.equal(await touchBlock.evaluate(n=>n.classList.contains('is-selected')),true);
  await touch.page.getByRole('button',{name:'Organizar estrutura',exact:true}).tap();
  assert.equal(await touchBlock.locator('.pages-block-header').evaluate(n=>getComputedStyle(n).opacity),'1');
  await touchBlock.locator('.pages-select-block').tap();await touch.context.close();
  results.push('touch context selects real canvas content and exposes organizing controls without hover');
  // Default-off route uses the actual store, not response-only UI simulation.
  const {createPagesRouter}=require('./pages/router');
  h.app.use('/api/pages-off',createPagesRouter({pool:h.pool,authenticate:h.authenticate,uploadDirectory:h.directory}));
  const templates=await h.request.get('/api/pages-off/templates').set('Authorization','Bearer super');assert.equal(templates.body.some(t=>t.id==='guia-interno'),false);assert.equal((await api('get','/templates')).some(t=>t.id==='guia-interno'),true);
  const counts=async()=> (await h.db.query('SELECT (SELECT count(*) FROM pages) AS pages,(SELECT count(*) FROM page_revisions) AS revisions,(SELECT count(*) FROM page_requests) AS requests,(SELECT count(*) FROM audit_log) AS audit')).rows;
  const beforeDisabled=await counts();
  const off=await h.request.post('/api/pages-off').set('Authorization','Bearer super').send({template_id:'guia-interno',...key()});assert.equal(off.status,409);assert.equal(off.body.reason,'document_version_disabled');
  assert.deepEqual(await counts(),beforeDisabled);
  const replay=await h.request.post('/api/pages-off').set('Authorization','Bearer super').send(requests[0]);assert.equal(replay.status,201);assert.equal(replay.body.id,created);
  assert.deepEqual(await counts(),beforeDisabled);
  results.push('default-off actual API rejects new guide with 409; authorized existing create receipt replays with writer off');
  const ro=await visit(created);await ro.context.route(`**/api/pages/${created}/workspace`,async route=>{const r=await route.fetch({url:`${h.origin}/api/pages-off/${created}/workspace`});await route.fulfill({response:r});});await ro.page.reload();await pagesBrowserReady(ro.page);await ro.page.getByText('Edição indisponível para esta versão do documento.',{exact:true}).waitFor();assert.equal(await ro.page.locator('.ProseMirror').count(),0);await ro.context.close();
  results.push('writer-off v3 head has visible reason and no editable PM');
  const publisher=await visit(created,{uid:'publisher'});await publisher.page.getByText('Modo de revisão. Apenas o autor pode editar, inclusive entre administradores.',{exact:true}).waitFor();assert.equal(await publisher.page.locator('.ProseMirror').count(),0);assert.equal(await publisher.page.getByRole('button',{name:'Salvar rascunho',exact:true}).count(),0);await pagesEditorPreview(publisher.page,'mobile');await publisher.context.close();results.push('publisher remains review-only; preview remains reachable with no save or authoring rights');
  const legacy=await api('post','',{template_id:'owner-news',...key()}),legacyVisit=await pagesBrowserContext(browser,{width:1600,errors}),lp=legacyVisit.page;
  const legacyWorkspace=await api('get',`/${legacy.id}/workspace`),legacyDocument=legacyWorkspace.draft.document;
  const twoColumnRow=legacyDocument.sections[2].rows[0];twoColumnRow.layout='two_equal';
  twoColumnRow.columns.push({id:randomUUID(),blocks:[{id:randomUUID(),type:'rich_text',content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'Segunda coluna v2, preservada durante o reflow.'}]}]}}]});
  await api('put',`/${legacy.id}/draft`,{expected_version:legacyWorkspace.version,...key(),document:legacyDocument});
  await legacyVisit.context.route('**/pages/editor.js',async route=>{const source=await readFile(new URL('../../public/pages/editor.js',import.meta.url),'utf8');await route.fulfill({contentType:'text/javascript',body:source.replace('  void load();\n}', '  globalThis.__referenceDraft=()=>state.document;\n  void load();\n}')});});
  await lp.goto(`${h.origin}/page-editor.html?id=${legacy.id}`);await pagesBrowserReady(lp);await lp.locator('.ProseMirror').first().waitFor();
  const legacyBytes=await lp.evaluate(()=>JSON.stringify(__referenceDraft()));assert.equal(JSON.parse(legacyBytes).schema_version,2);
  await lp.locator('.ProseMirror').evaluateAll(nodes=>{globalThis.legacyViews=nodes.map(node=>({node,view:node.pmViewDesc}));});
  const legacyRow=lp.locator('.pages-editor-row > .pages-row-two_equal').first();assert.equal(await legacyRow.count(),1);
  for(const width of [1600,1366])for(const device of ['desktop','mobile','desktop']){
    await lp.setViewportSize({width,height:1160});await lp.getByRole('combobox',{name:'Dispositivo',exact:true}).selectOption(device);
    const columns=await legacyRow.locator(':scope > .pages-column').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}));
    if(device==='mobile'){
      assert.equal(await lp.locator('.pages-editor-surface').evaluate(n=>n.clientWidth),390);
      near(columns[0].x,columns[1].x,'v2 stacked x',.1);assert.ok(columns[1].y>=columns[0].y+columns[0].height,'v2 columns physically stack at mobile390');
    }else{near(columns[0].y,columns[1].y,'v2 desktop columns retain same top',.1);assert.ok(columns[1].x>columns[0].x+columns[0].width);}
    assert.equal(await lp.evaluate(()=>JSON.stringify(__referenceDraft())),legacyBytes);
    assert.equal(await lp.locator('.ProseMirror').evaluateAll(nodes=>nodes.length===legacyViews.length&&nodes.every((node,i)=>node===legacyViews[i].node&&node.pmViewDesc===legacyViews[i].view)),true);
    geometry.push({legacyWidth:width,legacyDevice:device,columns});
    if(width===1600&&device==='mobile')await lp.screenshot({path:join(output,'legacy-v2-mobile390-in-desktop1600.png')});
  }
  assert.deepEqual((await api('get',`/${legacy.id}/workspace`)).draft.document,JSON.parse(legacyBytes));await legacyVisit.context.close();
  results.push('actual v2 two_equal stacks at mobile390 within 1600/1366 browser, restores desktop columns, retains exact JSON/schema and all PM views');
  assert.deepEqual(errors,[]);console.log(`PASS ${results.length} workspace scenarios`);
}finally{await writeFile(join(output,'results.json'),JSON.stringify({results,errors,geometry,referenceGeometry:{strict:strictReferenceGeometry,differences:referenceDifferences}},null,2));await browser?.close();await h.close();}
