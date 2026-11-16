// Owned loopback, real editor/API/SQL, synthetic identities. No physical-keyboard claim.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createPagesDatabaseHarness,cargoA} from '../database/check-pages.mjs';
import {pagesBrowserContext,pagesBrowserReady,pagesBrowserReflow,pagesEditorPreview,pagesEditorMore,pagesFeatureDocument} from '../helpers/pages-browser.mjs';
import {referenceDocument,referenceIds as ids} from '../helpers/pages-reference-document.mjs';
for(const key of ['PGLITE_MODULE_PATH','PLAYWRIGHT_MODULE_PATH','AXE_MODULE_PATH','PAGES_REFERENCE_DIR'])assert.ok(process.env[key],`Set external ${key}`);
const {chromium}=await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const {default:AxeBuilder}=await import(pathToFileURL(resolve(process.env.AXE_MODULE_PATH)).href);
const require=createRequire(new URL('../../api/package.json',import.meta.url)),express=require('express');
const manifest=JSON.parse(await readFile(new URL('../fixtures/pages-reference/manifest.json',import.meta.url),'utf8'));
const source=manifest.find(x=>x.id==='mobile-content');
assert.equal(createHash('sha256').update(await readFile(join(process.env.PAGES_REFERENCE_DIR,source.png))).digest('hex'),source.sha256);
const output=resolve(process.env.MOBILE_VISUAL_OUTPUT||join(tmpdir(),'opencode','pages-mobile-task16'));
await mkdir(output,{recursive:true});
const h=await createPagesDatabaseHarness({v3WritesEnabled:true}),results=[],geometry=[],errors=[];
let browser,p;
const key=()=>({client_mutation_id:randomUUID()});
async function api(method,path,body){const r=await h.api(method,path,body,'super');assert.ok(r.status>=200&&r.status<300,`${method} ${path}: ${r.status}`);return r.body;}
const rect=loc=>loc.evaluate(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};});
const near=(a,b,name,t=2)=>assert.ok(Math.abs(a-b)<=t,`${name}: ${a} expected ${b} ±${t}`);
const settle=()=>p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
const draft=()=>p.evaluate(()=>JSON.stringify(__mobileState.document));
const sameViews=()=>p.evaluate(()=>__mobileViews.every(({node,view})=>node.isConnected&&node.pmViewDesc===view));
async function foregroundRoundtrip() {
  const {id}=await api('post','',{template_id:'guia-interno',...key()});
  const doc=await pagesFeatureDocument(h,id,cargoA);
  doc.presentation.defaults.foreground='#123456';
  delete doc.sections[0].rows[0].columns[0].blocks[0].appearance.foreground;
  const intro=doc.sections[1].rows[0].columns[0].blocks[0];intro.appearance.foreground='#174A2B';
  intro.content.content[0].content[0].marks=[{type:'strong'}];
  await api('put',`/${id}/draft`,{expected_version:0,...key(),document:doc});
  const v=await pagesBrowserContext(browser,{width:390,errors}),page=v.page;
  await page.setViewportSize({width:390,height:820});await page.goto(`${h.origin}/page-editor.html?id=${id}`);await pagesBrowserReady(page);await page.locator('.ProseMirror').first().waitFor();
  const colors=async(prefix,suffix)=>Promise.all([ids.coverBlock,ids.introductionBlock].map(id=>page.locator(`${prefix} [data-block-id="${id}"] ${suffix}`).evaluate(n=>getComputedStyle(n).color)));
  assert.deepEqual(await colors('.pages-v2-canvas','.ProseMirror p'),['rgb(18, 52, 86)','rgb(23, 74, 43)'],'standard guide respects page and block foreground before editing');
  await pagesEditorMore(page);await page.getByRole('button',{name:'Estilo da página',exact:true}).click();
  const style=page.getByRole('dialog',{name:'Estilo da página',exact:true});await style.getByRole('tab',{name:'Cores',exact:true}).click();await style.getByRole('combobox',{name:'Propriedade da cor',exact:true}).selectOption('foreground');await style.getByRole('textbox',{name:'Cor personalizada',exact:true}).fill('#334455');await style.getByRole('button',{name:'✓ Aplicar estilo',exact:true}).click();
  const expected=['rgb(51, 68, 85)','rgb(23, 74, 43)'];
  assert.deepEqual(await colors('.pages-v2-canvas','.ProseMirror p'),expected);
  await page.keyboard.press('Control+s');await page.locator('#page-editor-root[data-save-state=saved]').waitFor();
  const saved=await api('get',`/${id}/workspace`);assert.equal(saved.draft.document.presentation.defaults.foreground,'#334455');assert.equal(saved.draft.document.presentation.defaults.scale,'standard');assert.equal(saved.draft.document.sections[1].rows[0].columns[0].blocks[0].appearance.foreground,'#174A2B');
  await page.reload();await pagesBrowserReady(page);await page.locator('.ProseMirror').first().waitFor();assert.deepEqual(await colors('.pages-v2-canvas','.ProseMirror p'),expected);
  assert.equal(await page.locator('[data-guide-block=cover]').count(),1);assert.equal(await page.locator(`[data-block-id="${ids.introductionBlock}"]`).getAttribute('data-guide-block'),'rich_text');
  await pagesEditorPreview(page,'mobile');assert.deepEqual(await colors('.pages-preview-frame','p'),expected);
  await api('post',`/${id}/publish`,{expected_version:saved.version,revision_id:saved.draft_revision_id,...key()});
  const reader=await pagesBrowserContext(browser,{width:390,uid:'reader',errors});await reader.page.goto(`${h.origin}/pages.html?id=${id}`);await pagesBrowserReady(reader.page);await reader.page.locator('.pages-document').waitFor();
  const actual=await Promise.all([ids.coverBlock,ids.introductionBlock].map(id=>reader.page.locator(`.pages-document [data-block-id="${id}"] p`).evaluate(n=>getComputedStyle(n).color)));assert.deepEqual(actual,expected);
  assert.equal(await reader.page.locator('.pages-v3-gallery figure').count(),1,'full feature gallery survives mobile roundtrip');
  assert.equal(await reader.page.locator('.pages-v3-faq details').count(),2);
  assert.deepEqual((await h.api('get',`/${id}`,undefined,'reader')).body.document,saved.draft.document);
  await reader.page.screenshot({path:join(output,'feature-reader-390.png'),fullPage:true});
  geometry.push({foreground:{scale:'standard',page:'#334455',block:'#174A2B',edit:expected,preview:expected,reader:actual}});
  await v.context.close();await reader.context.close();results.push('standard-scale guide page foreground UI edit/save/reload + pinned block override agree in mobile editor, preview and authorized published reader');
}
try {
  h.app.use(express.static(fileURLToPath(new URL('../../public/',import.meta.url))));
  browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});
  await foregroundRoundtrip();
  const {id}=await api('post','',{template_id:'comunicado',...key()});
  const document=referenceDocument();document.metadata.audience.job_title_ids=[];
  const intro=document.sections[1].rows[0].columns[0].blocks[0];
  intro.content.content[source.state.copyOverride.paragraph].content[0].text=source.state.copyOverride.text;
  intro.content.content[0].content[0].marks.find(m=>m.type==='text_color').attrs.color=source.state.headingColorOverride;
  await api('put',`/${id}/draft`,{expected_version:0,...key(),document});
  const initialServer=JSON.stringify((await api('get',`/${id}/workspace`)).draft.document);
  const v=await pagesBrowserContext(browser,{width:390,touch:true,errors});p=v.page;
  await v.context.addInitScript(()=>{
    const vv=visualViewport,add=vv.addEventListener.bind(vv),remove=vv.removeEventListener.bind(vv),listeners=new Map();
    vv.addEventListener=(type,fn,opts)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);add(type,fn,opts);};
    vv.removeEventListener=(type,fn,opts)=>{listeners.get(type)?.delete(fn);remove(type,fn,opts);};
    globalThis.__viewportListeners=()=>[...listeners.values()].reduce((n,set)=>n+set.size,0);
    globalThis.__keyboard=(height,top=0)=>{Object.defineProperty(vv,'height',{configurable:true,value:height});Object.defineProperty(vv,'offsetTop',{configurable:true,value:top});vv.dispatchEvent(new Event('resize'));};
    globalThis.__keyboardOff=()=>{delete vv.height;delete vv.offsetTop;vv.dispatchEvent(new Event('resize'));};
  });
  await v.context.route('**/pages/editor.js',async route=>{
    const code=await readFile(new URL('../../public/pages/editor.js',import.meta.url),'utf8');
    await route.fulfill({contentType:'text/javascript',body:code.replace('  void load();\n}','  globalThis.__mobileStateGetter=()=>state;\n  globalThis.__mobileBookmark=()=>activeEditor()?.bookmark();\n  void load();\n}')});
  });
  // Optional RED replay serves preserved task-start sources, without overwriting work.
  if(process.env.MOBILE_BEFORE_DIR)for(const file of ['pages/editor-workspace.js','pages/editor-style.js','pages/editor-panels.js','css/pages-editor-v2.css'])await v.context.route(`**/${file}`,async route=>route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:await readFile(join(process.env.MOBILE_BEFORE_DIR,'public',file),'utf8')}));
  if(process.env.MOBILE_FOCUS_BEFORE_DIR)for(const file of ['pages/editor-workspace.js','pages/editor-panels.js'])await v.context.route(`**/${file}`,async route=>route.fulfill({contentType:'text/javascript',body:await readFile(join(process.env.MOBILE_FOCUS_BEFORE_DIR,'public',file),'utf8')}));
  await p.setViewportSize({width:390,height:820});await p.goto(`${h.origin}/page-editor.html?id=${id}`);await pagesBrowserReady(p);await p.locator('.ProseMirror').first().waitFor();
  await p.evaluate(()=>{globalThis.__mobileState=__mobileStateGetter();globalThis.__mobileViews=[...document.querySelectorAll('.ProseMirror')].map(node=>({node,view:node.pmViewDesc}));});
  const initial=await draft(),pm=p.locator(`[data-block-id="${ids.introductionBlock}"] .ProseMirror`),sheet=p.locator('.pages-v2-inspector');
  await pm.click();await pm.press('Control+End');await pm.press('ArrowLeft');
  await p.getByRole('button',{name:'Conteúdo',exact:true}).click();await settle();
  const done=p.getByRole('button',{name:'Concluir edição',exact:true});
  const doneBox=await rect(done);assert.ok(doneBox.y>=0&&doneBox.y+doneBox.height<=820,'Content Done reachable without scrolling');
  assert.equal(await sheet.evaluate(n=>n.scrollTop),0);
  const typography=p.getByRole('combobox',{name:'Tipografia e tamanho',exact:true});
  assert.equal(await typography.locator('option:checked').textContent(),'Manrope · 16 px');
  for(const name of ['Negrito','Itálico','Sublinhado','Link'])assert.equal(await p.getByRole('button',{name,exact:true}).isVisible(),true);
  assert.equal(await p.locator('.pages-v2-tools .pages-v2-preview-menu').isVisible(),true,'Preview is grouped with Blocks and Publish');
  const close=p.getByRole('button',{name:'Fechar propriedades',exact:true});
  assert.equal(await close.evaluate(n=>{const b=n.getBoundingClientRect();return n.contains(document.elementFromPoint(b.left-10,b.top+b.height/2));}),true,'compact X retains a 44px effective target');
  const anchors={header:await rect(p.locator('.pages-v2-header')),toolbar:await rect(p.locator('.pages-v2-tools')),'selected-block':await rect(p.locator(`[data-block-id="${ids.introductionBlock}"]`)),'bottom-sheet':await rect(sheet),typography:await rect(typography),background:await rect(p.getByRole('combobox',{name:'Fundo do bloco',exact:true})),'finish-editing':doneBox};
  geometry.push({source390:anchors});
  await p.mouse.move(380,120);await p.screenshot({path:join(output,'mobile-content-390.png')});
  for(const [name,actual] of Object.entries(anchors)){
    const expected=source.regions.find(r=>r.id===name);for(const dimension of ['x','y','width','height'])near(actual[dimension],expected[dimension],`${name}.${dimension}`,['header','toolbar','bottom-sheet'].includes(name)?2:4);
  }
  results.push('source hash; actual 390×820 anchors, compact B/I/U/Link + combined typography/background/Done, zero sheet scroll');
  const bookmark=await p.evaluate(()=>__mobileBookmark());
  await p.getByRole('button',{name:'Estilo',exact:true}).click();assert.equal(await p.getByRole('combobox',{name:'Tipografia',exact:true}).isVisible(),true);assert.equal(await p.getByRole('combobox',{name:'Formato do texto',exact:true}).isVisible(),true);
  await p.getByRole('button',{name:'Posição',exact:true}).click();await p.getByText('Opções avançadas',{exact:true}).click();assert.equal(await p.getByRole('combobox',{name:'Composição da linha',exact:true}).isVisible(),true);
  await p.getByRole('button',{name:'Conteúdo',exact:true}).click();assert.deepEqual(await p.evaluate(()=>__mobileBookmark()),bookmark);assert.equal(await sameViews(),true);assert.equal(await draft(),initial);
  await done.click();assert.equal(await sheet.isVisible(),false);assert.equal(await p.evaluate(()=>__viewportListeners()),0);assert.equal(await p.getByRole('dialog',{name:/propriedades/i}).count(),0);assert.equal(await pm.evaluate(n=>document.activeElement===n),true,'Done returns focus to the visible retained editor');
  for(const reduced of [false,true]){
    await pm.click();await p.getByRole('button',{name:'Conteúdo',exact:true}).click();
    if(reduced)await p.evaluate(()=>__keyboard(430,24));
    await done.focus();await p.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await settle();
    const before=await rect(pm);assert.ok(before.y+before.height<0,'opener really scrolled offscreen before close');
    await done.click();await settle();
    const focused=await p.evaluate(()=>{const node=document.activeElement,b=node.getBoundingClientRect(),vv=visualViewport;return {tag:node.tagName,top:b.top,bottom:b.bottom,left:b.left,right:b.right,viewportTop:vv.offsetTop,viewportBottom:vv.offsetTop+vv.height,viewportLeft:vv.offsetLeft,viewportRight:vv.offsetLeft+vv.width};});
    geometry.push({offscreenClose:{reduced,before,focused}});
    assert.notEqual(focused.tag,'BODY');assert.ok(focused.top>=focused.viewportTop&&focused.bottom<=focused.viewportBottom&&focused.left>=focused.viewportLeft&&focused.right<=focused.viewportRight,'close reveals the full focus target when it fits the visual viewport');
    assert.equal(await sheet.isVisible(),false);assert.equal(await sameViews(),true);assert.equal(await draft(),initial);
    if(reduced)await p.evaluate(()=>__keyboardOff());
  }
  results.push('offscreen opener revealed or visible fallback focused after normal/reduced-viewport close; measured focus geometry, PM identity and exact bytes');
  await pm.click();await pm.press('Control+End');await pm.press('Shift+Home');await p.getByRole('button',{name:'Negrito',exact:true}).click();assert.notEqual(await draft(),initial);
  await p.getByRole('button',{name:'Link',exact:true}).click();assert.equal(await p.getByRole('dialog',{name:'Link no texto selecionado'}).isVisible(),true);await p.keyboard.press('Escape');assert.equal(await sheet.isVisible(),true,'nested Escape leaves sheet');
  await p.keyboard.press('Escape');assert.equal(await sheet.isVisible(),false);assert.equal(await sameViews(),true);
  await pm.focus();await p.keyboard.press('Control+z');assert.equal(await draft(),initial);
  for(const [name,mark] of [['Itálico','em'],['Sublinhado','underline']]){
    await pm.press('Control+End');await pm.press('Shift+Home');await p.getByRole('button',{name,exact:true}).click();
    const content=JSON.parse(await draft()).sections[1].rows[0].columns[0].blocks[0].content;
    assert.ok(JSON.stringify(content).includes(`"type":"${mark}"`));await p.keyboard.press('Control+z');assert.equal(await draft(),initial);
  }
  await pm.press('Control+End');await pm.press('Shift+Home');await p.getByRole('button',{name:'Link',exact:true}).click();
  await p.getByRole('dialog',{name:'Link no texto selecionado'}).getByRole('textbox').fill('/pages.html');await p.getByRole('button',{name:'Aplicar link',exact:true}).click();
  assert.ok((await draft()).includes('"href":"/pages.html"'));await p.keyboard.press('Control+z');assert.equal(await draft(),initial);
  await typography.selectOption('oswald:small');await p.getByRole('combobox',{name:'Fundo do bloco',exact:true}).selectOption('#F7F6F2');
  const changed=await draft();assert.equal(JSON.parse(changed).sections[1].rows[0].columns[0].blocks[0].appearance.font,'oswald');
  await done.click();assert.equal(await draft(),changed);assert.equal(await p.locator('#page-editor-root').getAttribute('data-save-state'),'dirty');assert.equal(JSON.stringify((await api('get',`/${id}/workspace`)).draft.document),initialServer,'Done did not save');
  await p.keyboard.press('Control+s');await p.locator('#page-editor-root[data-save-state=saved]').waitFor();assert.deepEqual((await api('get',`/${id}/workspace`)).draft.document,JSON.parse(changed));assert.equal(await sameViews(),true);
  results.push('tabs retain PM selection/identity; actual mark/link nested Escape; combined font/scale + background persist only on explicit save');
  for(const width of [360,390,402,768,1366,1600,1920]){
    await p.setViewportSize({width,height:width<1100?820:1160});await pm.click();await settle();
    if(width<1100){await p.getByRole('button',{name:'Conteúdo',exact:true}).click();const b=await rect(done);assert.ok(b.y>=0&&b.y+b.height<=820);}
    await pagesBrowserReflow(p,AxeBuilder,`Task16 width ${width}`);assert.equal(await sameViews(),true);assert.equal(await draft(),changed);
    geometry.push({width,paper:await rect(p.locator('.pages-editor-surface')),sheet:await rect(sheet)});
  }
  results.push('360/390/402/768/1366/1600/1920: visible controls, axe A/AA, reflow, exact draft and every PM view');
  await p.setViewportSize({width:390,height:820});await pm.click();await pm.press('Control+Home');await pm.press('Shift+ArrowRight');await p.getByRole('button',{name:'Conteúdo',exact:true}).click();
  await pm.focus();await p.evaluate(()=>{document.querySelector('#page-editor-root').style.setProperty('--pages-safe-bottom','34px');__keyboard(430,24);});await settle();
  let b=await rect(sheet);assert.ok(b.y>=24&&b.y+b.height<=454);assert.equal(await sheet.evaluate(n=>getComputedStyle(n).paddingBottom),'34px');
  const caret=await p.evaluate(()=>{const r=getSelection().getRangeAt(0).getBoundingClientRect();return {top:r.top,bottom:r.bottom};});assert.ok(caret.top>=24&&caret.bottom<=b.y,'real retained PM selection scrolls above simulated keyboard sheet');
  await done.focus();await settle();b=await rect(done);assert.ok(b.y>=24&&b.y+b.height<=454,'focused Done above simulated keyboard');
  await p.keyboard.press('Shift+Tab');const focused=await p.evaluate(()=>{const b=document.activeElement.getBoundingClientRect();return {top:b.top,bottom:b.bottom};});assert.ok(focused.top>=24&&focused.bottom<=454);
  await p.getByRole('button',{name:'Link',exact:true}).click();const linkDialog=p.getByRole('dialog',{name:'Link no texto selecionado'});await linkDialog.getByRole('textbox').focus();await settle();b=await rect(linkDialog);assert.ok(b.y>=24&&b.y+b.height<=454,'nested Link form fits reduced viewport');await p.keyboard.press('Escape');assert.equal(await sheet.isVisible(),true);
  await p.getByRole('button',{name:'Estilo',exact:true}).click();await p.getByRole('button',{name:'Cor do texto selecionado',exact:true}).click();const nested=p.getByRole('dialog',{name:'Cor do texto selecionado',exact:true});await settle();b=await rect(nested);assert.ok(b.y>=24&&b.y+b.height<=454,'nested color dialog uses visual viewport');await p.keyboard.press('Escape');assert.equal(await sheet.isVisible(),true);
  await p.evaluate(()=>__keyboardOff());await p.setViewportSize({width:820,height:390});await p.getByRole('button',{name:'Conteúdo',exact:true}).click();await done.focus();b=await rect(done);assert.ok(b.y>=0&&b.y+b.height<=390);
  await p.setViewportSize({width:1600,height:1160});assert.equal(await p.evaluate(()=>__viewportListeners()),0);assert.equal(await sameViews(),true);assert.equal(await draft(),changed);
  results.push('simulated visualViewport height430/offset24 + safe-area34; focused controls/nested panel reachable; 820×390 rotation; desktop removes hooks');
  // 200% reflow equivalent: 1366×900 physical viewport / 2 CSS pixels. This is
  // explicitly not evidence of a native browser zoom gesture or physical keyboard.
  await p.setViewportSize({width:683,height:450});await pm.click();await p.getByRole('button',{name:'Conteúdo',exact:true}).click();await done.focus();await pagesBrowserReflow(p,AxeBuilder,'200% equivalent reflow 683×450');b=await rect(done);assert.ok(b.y>=0&&b.y+b.height<=450);
  await p.evaluate(()=>{history.pushState({},'','#sheet-back');});await p.goBack();assert.equal(await sheet.isVisible(),false);assert.equal(await p.evaluate(()=>__viewportListeners()),0);assert.equal(await draft(),changed);assert.equal(await sameViews(),true);
  await pm.focus();await p.evaluate(()=>__fixtureChangeUser('outsider'));await p.waitForFunction(()=>!document.querySelector('.pages-v2-workspace'));assert.equal(await p.evaluate(()=>__viewportListeners()),0);
  results.push('200% equivalent reflow + axe; actual Back closes sheet without data loss; account disposal removes viewport hooks');
  await p.reload();await pagesBrowserReady(p);await p.locator('.ProseMirror').first().waitFor();assert.deepEqual(await p.evaluate(()=>__mobileStateGetter().document),JSON.parse(changed));
  results.push('fresh authenticated synthetic reload reads the exact explicitly saved document');
  await v.context.close();assert.deepEqual(errors,[]);
  console.log(`PASS ${results.length} mobile scenario groups`);
} catch(error) {if(p)await p.screenshot({path:join(output,'failure.png')}).catch(()=>{});throw error;}
finally {await writeFile(join(output,'results.json'),JSON.stringify({source,results,geometry,errors,limits:['physical keyboard/touch/IME pending','native browser zoom gesture pending; 200% equivalent reflow tested','native PostgreSQL/Firebase/Nginx pending']},null,2));await browser?.close();await h.close();}
