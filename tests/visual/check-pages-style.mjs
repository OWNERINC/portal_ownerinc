// Disposable SQL/HTTP + actual Chrome/PM; owned loopback, synthetic identity only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createPagesDatabaseHarness,pageDocument} from '../database/check-pages.mjs';
import {pagesBrowserContext,pagesBrowserReady,pagesEditorInsert,pagesEditorPreview} from '../helpers/pages-browser.mjs';
import {upgradeDocument} from '../../public/pages/document-v3.js';
for(const key of ['PGLITE_MODULE_PATH','PLAYWRIGHT_MODULE_PATH'])if(!process.env[key])throw Error(`Set external ${key}`);
const {chromium}=await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const require=createRequire(new URL('../../api/package.json',import.meta.url)),express=require('express');
const h=await createPagesDatabaseHarness({v3WritesEnabled:true}),errors=[],outbound=[],results=[];
const output=resolve(process.env.STYLE_VISUAL_OUTPUT||join(tmpdir(),'opencode','pages-style'));await mkdir(output,{recursive:true});
let browser;
const blocks=doc=>doc.sections.flatMap(s=>s.rows.flatMap(r=>r.columns.flatMap(c=>c.blocks)));
async function api(method,path,body){const r=await h.api(method,path,body,'super');assert.ok(r.status>=200&&r.status<300,`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);return r.body;}
async function create(doc){const {id}=await api('post','',{template_id:'comunicado',client_mutation_id:randomUUID()});const w=await api('get',`/${id}/workspace`);await api('put',`/${id}/draft`,{expected_version:w.version,client_mutation_id:randomUUID(),document:doc});return id;}
async function save(page,id){const r=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname===`/api/pages/${id}/draft`);await page.getByRole('button',{name:/Salvar rascunho/}).click();assert.equal((await r).status(),200);await page.locator('#page-editor-root[data-save-state=saved]').waitFor();return(await api('get',`/${id}/workspace`)).draft.document;}
async function visit(id){const v=await pagesBrowserContext(browser,{width:1600,errors});await v.context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===h.origin||url.hostname==='www.gstatic.com')return route.fallback();outbound.push(url.href);return route.abort('blockedbyclient');});await v.page.goto(`${h.origin}/page-editor.html?id=${id}`);await pagesBrowserReady(v.page);return v;}
async function style(page){
  await page.getByRole('button',{name:'Estilo da página',exact:true}).click();
  const panel=page.getByRole('dialog',{name:'Estilo da página',exact:true});
  await panel.locator('[data-apply-style]').scrollIntoViewIfNeeded();
  const hit=await panel.locator('[data-apply-style]').evaluate(n=>{
    const r=n.getBoundingClientRect(),s=getComputedStyle(n,'::after');
    return {width:r.width,height:r.height,top:s.top,bottom:s.bottom,
      above:document.elementFromPoint(r.x+r.width/2,r.y-3.5)===n,
      below:document.elementFromPoint(r.x+r.width/2,r.bottom+3.5)===n};
  });
  if(!hit.above||!hit.below)console.log('Apply hit diagnostic',await panel.locator('[data-apply-style]').evaluate(n=>{const r=n.getBoundingClientRect(),d=n.closest('dialog');return{button:r.toJSON(),dialog:d.getBoundingClientRect().toJSON(),scroll:d.scrollTop,above:document.elementFromPoint(r.x+r.width/2,r.y-3.5)?.outerHTML,below:document.elementFromPoint(r.x+r.width/2,r.bottom+3.5)?.outerHTML};}));
  assert.deepEqual(hit,{width:129,height:36,top:'-4px',bottom:'-4px',above:true,below:true},'source paint and genuine 44px hit region');
  await panel.getByRole('tab',{name:'Tema',exact:true}).scrollIntoViewIfNeeded();
  return panel;
}
async function roundOneChecks(){
  const only=process.env.STYLE_FIX_CASE;
  if(!only||only==='reset')for(const type of ['callout','button']){
    const original=upgradeDocument(pageDocument(`Pinned ${type}`)),block=blocks(original)[0];
    original.presentation.defaults.font='oswald';original.presentation.defaults.foreground='#112233';original.presentation.defaults.background='#FAFAFA';
    block.appearance={font:'source-serif-4'};
    if(type==='callout')Object.assign(block,{type,tone:'info',icon:'alert'});
    else{delete block.content;Object.assign(block,{type,label:'Continue',preset:'primary',action:{type:'url',value:'/pages.html'}});}
    const id=await create(original),v=await visit(id),p=v.page;await p.locator(`[data-block-id="${block.id}"] .pages-select-block`).waitFor();
    const outer=p.locator(`.pages-editor-block[data-block-id="${block.id}"]`);
    const pair=locator=>locator.evaluate(n=>{const s=getComputedStyle(n);return [s.color,s.backgroundColor];});
    const outerBefore=await pair(outer);
    async function preview(){await pagesEditorPreview(p,'desktop');const wrapper=p.locator(`.pages-preview-frame [data-block-id="${block.id}"]`);await wrapper.waitFor();const colors=[await pair(wrapper),await pair(wrapper.locator(type==='callout'?'.pages-callout':'.pages-content-button'))];await pagesEditorPreview(p,'edit');return colors;}
    const beforePreview=await preview();
    await p.getByRole('combobox',{name:'Tipografia',exact:true}).selectOption('inherit');
    assert.deepEqual(await pair(outer),outerBefore,`${type}: property reset must not copy inner colors onto outer wrapper`);
    assert.deepEqual(await preview(),beforePreview,`${type}: both shared preview pairs stay exact`);
    assert.equal(await p.getByRole('combobox',{name:'Tipografia',exact:true}).inputValue(),'manrope');
    const saved=await save(p,id);assert.deepEqual(blocks(saved)[0].style,block.style);assert.equal(blocks(saved)[0].appearance,undefined);
    await p.getByRole('button',{name:'Desfazer exclusão',exact:true}).click();assert.equal(await p.getByRole('combobox',{name:'Tipografia',exact:true}).inputValue(),'source-serif-4');assert.deepEqual(await preview(),beforePreview);assert.equal(await p.getByRole('button',{name:'Desfazer exclusão',exact:true,includeHidden:true}).isDisabled(),true);
    const advanced=p.locator('.pages-inspector-advanced');await advanced.locator('summary').first().click();await advanced.getByRole('button',{name:'Usar padrão da página — substituir cores e tipografia legadas',exact:true}).click();
    assert.notDeepEqual(await pair(outer),outerBefore,'only the explicit full opt-out changes legacy outer colors');
    await p.getByRole('button',{name:'Desfazer exclusão',exact:true}).click();assert.deepEqual(await pair(outer),outerBefore);assert.equal(await p.getByRole('combobox',{name:'Tipografia',exact:true}).inputValue(),'source-serif-4');assert.equal(await p.getByRole('button',{name:'Desfazer exclusão',exact:true,includeHidden:true}).isDisabled(),true);
    await v.context.close();
  }
  if(!only||only==='size')for(const type of ['image','gif','gallery']){
    const document=upgradeDocument(pageDocument(`Size ${type}`)),previous=blocks(document)[0];
    const media={media_id:null,alt:'Synthetic placeholder',caption:'Fixed caption',credit:'Synthetic credit'};
    const block=type==='gallery'?{id:previous.id,type,items:[{id:randomUUID(),kind:'image',...media}]}:{id:previous.id,type,...media};
    document.sections[0].rows[0].columns[0].blocks=[block];
    const id=await create(document),v=await visit(id),p=v.page;await p.locator(`[data-block-id="${block.id}"] .pages-select-block`).waitFor();
    const size=p.getByRole('combobox',{name:'Tamanho',exact:true});assert.equal(await size.isDisabled(),true,`${type} size has no applicable content effect`);
    await size.evaluate(n=>{n.value='large';n.dispatchEvent(new Event('change',{bubbles:true}));});assert.equal(await size.inputValue(),'not-applicable');assert.equal(await p.locator('#page-editor-root').getAttribute('data-save-state'),'saved');
    assert.deepEqual((await api('get',`/${id}/workspace`)).draft.document,document);
    await pagesEditorPreview(p,'desktop');assert.deepEqual(await p.locator('.pages-preview-frame figcaption').evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).fontSize)),['14px']);await v.context.close();
  }
  if(!only||only==='ime')for(const kind of ['page','inline']){
    const document=pageDocument(`Hex IME ${kind}`),id=await create(document),v=await visit(id),p=v.page;await p.locator('.ProseMirror').waitFor();
    let panel;
    if(kind==='page')panel=await style(p);
    else{const pm=p.locator('.ProseMirror');await pm.click();await pm.press('Control+Home');for(let i=0;i<3;i++)await pm.press('Shift+ArrowRight');await p.getByRole('button',{name:'Cor do texto selecionado',exact:true}).click();panel=p.getByRole('dialog',{name:'Cor do texto selecionado',exact:true});}
    const input=panel.getByRole('textbox'),apply=panel.getByRole('button',{name:kind==='page'?'✓ Aplicar estilo':'Aplicar cor',exact:true});
    await input.fill('invalid');await input.evaluate(n=>n.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''})));await p.waitForTimeout(650);
    await input.evaluate(n=>{n.value='#112233';n.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));const apply=n.closest('dialog').querySelector('[data-apply-style]')||[...n.closest('dialog').querySelectorAll('button')].find(b=>b.textContent==='Aplicar cor');apply.dispatchEvent(new MouseEvent('click',{bubbles:true}));});
    assert.deepEqual((await api('get',`/${id}/workspace`)).draft.document,document);
    await input.evaluate(n=>{n.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'#112233'}));n.value='#112233';n.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:false}));});
    await p.waitForFunction(()=>{const d=document.querySelector('dialog[open]'),input=d?.querySelector('input');return input?.getAttribute('aria-invalid')==='false'&&[...d.querySelectorAll('button')].some(b=>['✓ Aplicar estilo','Aplicar cor'].includes(b.textContent)&&!b.disabled);});
    assert.equal(await p.locator('#page-editor-root').getAttribute('data-save-state'),'saved');await apply.click();assert.equal(await p.locator('#page-editor-root').getAttribute('data-save-state'),'dirty');await p.getByRole('button',{name:'Desfazer exclusão',exact:true}).click();assert.equal(await p.locator('#page-editor-root').getAttribute('data-save-state'),'saved');await v.context.close();
  }
}
try{
  h.app.use(express.static(fileURLToPath(new URL('../../public/',import.meta.url))));browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});
  await roundOneChecks();results.push('round 1: property-local pinned reset and explicit full opt-out, unchanged callout/button outer+inner preview pairs/undo, image/GIF/gallery size inapplicable and 14px captions, page/inline IME end+immediate input ordering');
  const original=pageDocument('Style integration'),id=await create(original),{page,context}=await visit(id),rich=page.locator('.ProseMirror').first();await rich.waitFor();
  await rich.evaluate(n=>{globalThis.styleIdentity={node:n,view:n.pmViewDesc};});
  let panel=await style(page);const retiredPanel=await panel.evaluateHandle(n=>({node:n,apply:n.querySelector('[data-apply-style]'),input:n.querySelector('input')}));await panel.getByRole('tab',{name:'Tipografia',exact:true}).click();await panel.getByRole('combobox',{name:'Fonte da página',exact:true}).selectOption('oswald');await page.keyboard.press('Escape');
  await retiredPanel.evaluate(({node,apply,input})=>{if(node.isConnected)throw Error('Expected retired panel');input.value='#FFFFFF';input.dispatchEvent(new Event('input',{bubbles:true}));apply.dispatchEvent(new MouseEvent('click',{bubbles:true}));});await retiredPanel.dispose();
  assert.equal(await page.locator('#page-editor-root').getAttribute('data-save-state'),'saved');assert.equal(await page.getByRole('button',{name:'Desfazer exclusão',exact:true,includeHidden:true}).isDisabled(),true);
  assert.deepEqual((await api('get',`/${id}/workspace`)).draft.document,original);
  results.push('cancel leaves exact legacy JSON/history clean');
  panel=await style(page);await panel.getByRole('button',{name:'✓ Aplicar estilo',exact:true}).click();assert.equal(await page.locator('#page-editor-root').getAttribute('data-save-state'),'saved');
  panel=await style(page);await panel.getByRole('tab',{name:'Tema',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await panel.getByRole('tab',{name:'Tipografia',exact:true}).evaluate(n=>n===document.activeElement),true);
  await panel.getByRole('combobox',{name:'Fonte da página',exact:true}).selectOption('oswald');await panel.getByRole('combobox',{name:'Tamanho da página',exact:true}).selectOption('large');
  await panel.getByRole('tab',{name:'Cores',exact:true}).click();await panel.getByRole('textbox',{name:'Cor personalizada',exact:true}).fill('url(https://invalid.test)');assert.equal(await panel.getByRole('button',{name:'✓ Aplicar estilo',exact:true}).isDisabled(),true);
  await panel.getByRole('textbox',{name:'Cor personalizada',exact:true}).fill(' #123abc ');
  const applyBox=await panel.locator('[data-apply-style]').boundingBox();
  await page.mouse.click(applyBox.x+applyBox.width/2,applyBox.y-3.5);
  await page.getByRole('dialog',{name:'Estilo da página',exact:true}).waitFor({state:'detached'});
  assert.equal(await rich.evaluate(n=>n===styleIdentity.node&&n.pmViewDesc===styleIdentity.view),true);
  await page.getByRole('button',{name:'Desfazer exclusão',exact:true}).click();assert.equal(await page.locator('#page-editor-root').getAttribute('data-save-state'),'saved','one undo restores exact pre-upgrade document');
  await page.keyboard.press('Control+y');let persisted=await save(page,id);assert.equal(persisted.schema_version,3);assert.equal(persisted.presentation.defaults.font,'oswald');assert.equal(persisted.presentation.defaults.accent,'#123ABC');assert.equal(blocks(persisted)[0].style.font,'manrope');
  panel=await style(page);assert.equal(await panel.getByRole('combobox',{name:'Fonte da página',exact:true}).inputValue(),'oswald');assert.equal(await panel.getByRole('textbox',{name:'Cor personalizada de destaque',exact:true}).inputValue(),'#123ABC');
  await panel.evaluate(n=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const box=await panel.boundingBox(),trigger=await page.getByRole('button',{name:'Estilo da página',exact:true}).boundingBox();assert.equal(Math.round(box.width),400);assert.equal(Math.round(box.x),Math.round(Math.max(16,Math.min(trigger.x+10,1600-416))));assert.equal(Math.round(box.y-trigger.y-trigger.height),0);assert.equal(Math.round(box.height),663);
  await page.screenshot({path:join(output,'style-panel.png')});await page.keyboard.press('Escape');
  await pagesEditorInsert(page,'Adicionar texto');const added=page.locator('[data-block-type=rich_text]').last(),addedId=await added.getAttribute('data-block-id');await added.locator('.ProseMirror').fill('New inherited content');
  assert.equal(await added.getAttribute('data-font'),'oswald');persisted=await save(page,id);assert.equal(blocks(persisted).find(b=>b.id===addedId).style,undefined);
  await page.reload();await pagesBrowserReady(page);await page.locator(`[data-block-id="${addedId}"] .pages-select-block`).click();const inspector=page.locator('.pages-style-inspector');
  await inspector.getByRole('combobox',{name:'Tipografia',exact:true}).selectOption('source-serif-4');
  await inspector.getByRole('combobox',{name:'Tamanho',exact:true}).selectOption('small');
  await inspector.getByRole('combobox',{name:'Alinhamento',exact:true}).selectOption('center');
  await inspector.getByRole('group',{name:'Cores de fundo',exact:true}).getByRole('button',{name:'#F7F6F2',exact:true}).click();
  await inspector.getByRole('textbox',{name:'Tags do bloco',exact:true}).fill('Cultura, Guia');await inspector.getByRole('textbox',{name:'Tags do bloco',exact:true}).press('Tab');
  await inspector.getByRole('combobox',{name:'Ícone',exact:true}).selectOption('coffee');
  await inspector.getByRole('textbox',{name:'Tags do bloco',exact:true}).fill('Cultura,,Guia');await inspector.getByRole('textbox',{name:'Tags do bloco',exact:true}).press('Tab');assert.equal(await inspector.getByRole('textbox',{name:'Tags do bloco',exact:true}).inputValue(),'Cultura, Guia');
  persisted=await save(page,id);let block=blocks(persisted).find(b=>b.id===addedId);assert.deepEqual(block.appearance,{font:'source-serif-4',scale:'small',align:'center',background:'#F7F6F2',icon:'coffee'});assert.deepEqual(block.tags,['Cultura','Guia']);assert.deepEqual(persisted.metadata.tags,original.metadata.tags);
  panel=await style(page);await panel.locator('[data-theme-palette=editorial]').click();await panel.getByRole('combobox',{name:'Fonte da página',exact:true}).selectOption('manrope');await panel.getByRole('button',{name:'✓ Aplicar estilo',exact:true}).click();assert.equal(await page.locator(`[data-block-id="${addedId}"]`).getAttribute('data-font'),'source-serif-4');
  await inspector.getByRole('combobox',{name:'Fundo do bloco',exact:true}).selectOption('none');persisted=await save(page,id);assert.equal(blocks(persisted).find(b=>b.id===addedId).appearance.background,'none');
  await inspector.getByRole('combobox',{name:'Largura do bloco',exact:true}).selectOption('half');assert.equal(await page.locator('.pages-row-two_equal').count(),1);
  await inspector.locator('.pages-inspector-advanced > summary').click();const destinations=await inspector.getByRole('combobox',{name:'Coluna de destino',exact:true}).locator('option').evaluateAll(nodes=>nodes.map(n=>n.value));await inspector.getByRole('combobox',{name:'Coluna de destino',exact:true}).selectOption(destinations[1]);await inspector.getByRole('button',{name:'Mover para destino',exact:true}).click();assert.equal(await page.locator('.pages-row-two_equal > .pages-column').last().locator(`[data-block-id="${addedId}"]`).count(),1);
  await inspector.getByRole('combobox',{name:'Largura do bloco',exact:true}).selectOption('full');await page.getByRole('dialog',{name:'Unir colunas?',exact:true}).getByRole('button',{name:'Cancelar',exact:true}).click();assert.equal(await page.locator('.pages-row-two_equal').count(),1);
  await inspector.getByRole('combobox',{name:'Largura do bloco',exact:true}).selectOption('full');await page.getByRole('dialog',{name:'Unir colunas?',exact:true}).getByRole('button',{name:'Unir colunas',exact:true}).click();assert.equal(await page.locator('.pages-row-two_equal').count(),0);
  if(!await inspector.locator('.pages-inspector-advanced').evaluate(n=>n.open))await inspector.locator('.pages-inspector-advanced > summary').click();await inspector.getByRole('button',{name:'Usar padrão da página para este bloco',exact:true}).click();assert.equal(await page.locator(`[data-block-id="${addedId}"]`).getAttribute('data-font'),'manrope');
  persisted=await save(page,id);assert.equal(persisted.presentation.defaults.palette,'editorial');assert.equal(persisted.presentation.defaults.foreground,'#3C352E');assert.equal(persisted.presentation.defaults.background,'#F0ECE5');assert.equal(persisted.presentation.defaults.accent,'#9E583E');results.push('real page defaults reopen/reload, inherited insertion, preserved override, all inspector properties and bounded width cancel/merge');
  await inspector.getByRole('button',{name:'Duplicar',exact:true}).click();assert.equal(await page.locator('[data-block-type=rich_text]').count(),3);await inspector.locator('.pages-inspector-advanced > summary').click();await inspector.getByRole('button',{name:'Excluir',exact:true}).click();assert.equal(await page.locator('[data-block-type=rich_text]').count(),2);await page.getByRole('button',{name:'Desfazer exclusão',exact:true}).click();assert.equal(await page.locator('[data-block-type=rich_text]').count(),3);await page.getByRole('button',{name:'Desfazer exclusão',exact:true}).click();assert.equal(await page.locator('[data-block-type=rich_text]').count(),2);assert.equal(await page.locator('#page-editor-root').getAttribute('data-save-state'),'saved');
  // A fresh legacy document proves the color + opt-in upgrade is one entry.
  const inlineOriginal=pageDocument('Atomic inline'),inlineId=await create(inlineOriginal),inline=await visit(inlineId),ip=inline.page,pm=ip.locator('.ProseMirror').first();await pm.waitFor();
  await pm.evaluate(n=>{globalThis.inlineIdentity={node:n,view:n.pmViewDesc};});await pm.click();await pm.press('Control+Home');await pm.press('Shift+ArrowRight');await pm.press('Shift+ArrowRight');await pm.press('Shift+ArrowRight');
  const selected=await ip.evaluate(()=>getSelection().toString());assert.ok(selected.length);
  await ip.getByRole('button',{name:'Cor do texto selecionado',exact:true}).click();let color=ip.getByRole('dialog',{name:'Cor do texto selecionado',exact:true});await color.getByRole('textbox',{name:'Cor hexadecimal',exact:true}).fill('bad');assert.equal(await color.getByRole('button',{name:'Aplicar cor',exact:true}).isDisabled(),true);await ip.keyboard.press('Escape');assert.equal(await ip.locator('#page-editor-root').getAttribute('data-save-state'),'saved');
  await ip.getByRole('button',{name:'Cor do texto selecionado',exact:true}).click();color=ip.getByRole('dialog',{name:'Cor do texto selecionado',exact:true});await color.getByRole('textbox',{name:'Cor hexadecimal',exact:true}).fill(' #112233 ');await color.getByRole('button',{name:'Aplicar cor',exact:true}).click();
  assert.equal(await pm.locator('[data-pages-text_color="#112233"]').textContent(),selected);assert.equal(await ip.evaluate(()=>getSelection().toString()),selected);assert.equal(await pm.evaluate(n=>n===inlineIdentity.node&&n.pmViewDesc===inlineIdentity.view),true);
  await ip.getByRole('button',{name:'Desfazer exclusão',exact:true}).click();assert.equal(await pm.locator('[data-pages-text_color]').count(),0);assert.equal(await ip.locator('#page-editor-root').getAttribute('data-save-state'),'saved');assert.equal(await ip.getByRole('button',{name:'Desfazer exclusão',exact:true,includeHidden:true}).isDisabled(),true);
  await ip.keyboard.press('Control+y');persisted=await save(ip,inlineId);assert.equal(persisted.schema_version,3);
  await ip.getByRole('button',{name:'Realce do texto selecionado',exact:true}).click();color=ip.getByRole('dialog',{name:'Realce do texto selecionado',exact:true});await color.getByRole('button',{name:'#F7F6F2',exact:true}).click();assert.equal(await pm.locator('[data-pages-highlight="#F7F6F2"]').textContent(),selected);
  await ip.getByRole('button',{name:'Cor do texto selecionado',exact:true}).click();await ip.getByRole('dialog',{name:'Cor do texto selecionado',exact:true}).getByRole('button',{name:'Remover cor',exact:true}).click();assert.equal(await pm.locator('[data-pages-text_color]').count(),0);assert.equal(await pm.locator('[data-pages-highlight]').count(),1);
  await save(ip,inlineId);await ip.reload();await pagesBrowserReady(ip);assert.equal(await ip.locator('[data-pages-highlight="#F7F6F2"]').textContent(),selected);await inline.context.close();
  results.push('selected rich text color/highlight safe normalized hex, cancel, preserved PM selection/view, atomic v3 upgrade + one undo, removal and SQL roundtrip');
  const faqDoc=upgradeDocument(pageDocument('FAQ selection'));
  const answer=text=>({type:'doc',content:[{type:'paragraph',content:[{type:'text',text}]}]});
  const faq={id:randomUUID(),type:'faq',items:[{id:randomUUID(),question:'First',answer:answer('First answer')},{id:randomUUID(),question:'Second',answer:answer('Second answer')}]};faqDoc.sections[0].rows[0].columns[0].blocks.push(faq);
  const faqId=await create(faqDoc),fv=await visit(faqId),fp=fv.page,faqPM=fp.locator(`[data-faq-answer="${faq.items[1].id}"] .ProseMirror`);await fp.locator(`[data-media-item-id="${faq.items[1].id}"] > summary`).click();await faqPM.waitFor();
  await faqPM.evaluate(n=>{globalThis.faqStyleIdentity={node:n,view:n.pmViewDesc};});await faqPM.click();await faqPM.press('Control+Home');for(let i=0;i<6;i++)await faqPM.press('Shift+ArrowRight');
  await fp.getByRole('button',{name:'Cor do texto selecionado',exact:true}).click();color=fp.getByRole('dialog',{name:'Cor do texto selecionado',exact:true});await color.getByRole('textbox',{name:'Cor hexadecimal',exact:true}).fill('#FFFFFF');assert.match(await color.getByRole('status').textContent(),/Contraste AA insuficiente/);await color.getByRole('button',{name:'Aplicar cor',exact:true}).click();
  assert.equal(await faqPM.locator('[data-pages-text_color="#FFFFFF"]').textContent(),'Second');assert.equal(await fp.locator(`[data-faq-answer="${faq.items[0].id}"] [data-pages-text_color]`).count(),0);
  await fp.keyboard.press('Control+z');assert.equal(await faqPM.locator('[data-pages-text_color]').count(),0);assert.equal(await faqPM.evaluate(n=>n===document.activeElement&&n===faqStyleIdentity.node&&n.pmViewDesc===faqStyleIdentity.view),true);await fp.keyboard.press('Control+y');
  persisted=await save(fp,faqId);let w=await api('get',`/${faqId}/workspace`);const aa=await h.api('post',`/${faqId}/publish`,{expected_version:w.version,revision_id:w.draft_revision_id,client_mutation_id:randomUUID()},'super');assert.equal(aa.status,400);assert.equal(aa.body.reason,'color_contrast_required');
  // Native long IME blocks foreign inspector and inline actions without leaving
  // a fake unsaved select value. Physical-device IME remains a separate gate.
  const tags=fp.getByRole('textbox',{name:'Tags do bloco',exact:true});await tags.focus();const cdp=await fv.context.newCDPSession(fp);await cdp.send('Input.imeSetComposition',{text:'一',selectionStart:1,selectionEnd:1});await fp.waitForTimeout(650);
  await fp.getByRole('combobox',{name:'Tipografia',exact:true}).evaluate(n=>{n.value='oswald';n.dispatchEvent(new Event('change',{bubbles:true}));});assert.equal(await fp.getByRole('combobox',{name:'Tipografia',exact:true}).inputValue(),'manrope');
  await cdp.send('Input.insertText',{text:'一'});await fp.waitForTimeout(30);await tags.press('Tab');await cdp.detach();persisted=await save(fp,faqId);assert.deepEqual(blocks(persisted).find(b=>b.id===faq.id).tags,['一']);
  // A retired inspector with the same current block UUID cannot mutate/upgrade.
  const retired=await fp.getByRole('combobox',{name:'Tipografia',exact:true}).evaluateHandle(n=>n);await fp.getByRole('combobox',{name:'Ícone',exact:true}).selectOption('users');await save(fp,faqId);
  await retired.evaluate(n=>{if(n.isConnected)throw Error('Expected retired control');n.value='oswald';n.dispatchEvent(new Event('change',{bubbles:true}));});assert.equal(await fp.locator('#page-editor-root').getAttribute('data-save-state'),'saved');await retired.dispose();
  panel=await style(fp);await panel.getByRole('tab',{name:'Cores',exact:true}).click();await panel.getByRole('combobox',{name:'Propriedade da cor',exact:true}).selectOption('background');await panel.getByRole('textbox',{name:'Cor personalizada',exact:true}).fill('#FFFFFF');await panel.getByRole('combobox',{name:'Propriedade da cor',exact:true}).selectOption('foreground');await panel.getByRole('textbox',{name:'Cor personalizada',exact:true}).fill('#FFFFFF');assert.match(await panel.getByRole('status').textContent(),/Contraste AA insuficiente/);await fp.keyboard.press('Escape');
  await fv.context.close();results.push('selected FAQ second answer only, canonical live AA + real HTTP publication rejection, PM view/bookmark undo, long CDP native IME, retired same-ID inspector');
  const offId=await create(pageDocument('Writer disabled'));
  const ov=await pagesBrowserContext(browser,{width:1600,errors});await ov.context.route(`**/api/pages/${offId}/workspace`,async route=>{const r=await route.fetch(),body=await r.json();body.document_support.write_versions=[1,2];await route.fulfill({response:r,json:body});});await ov.page.goto(`${h.origin}/page-editor.html?id=${offId}`);await pagesBrowserReady(ov.page);await ov.page.locator('.ProseMirror').waitFor();
  panel=await style(ov.page);assert.equal(await panel.getByRole('button',{name:'✓ Aplicar estilo',exact:true}).isDisabled(),true);await ov.page.keyboard.press('Escape');assert.equal(await ov.page.getByRole('combobox',{name:'Tipografia',exact:true}).isDisabled(),true);assert.equal(await ov.page.getByRole('button',{name:'Cor do texto selecionado',exact:true}).isDisabled(),true);assert.equal(await ov.page.locator('#page-editor-root').getAttribute('data-save-state'),'saved');await ov.context.close();
  results.push('server document_support blocks new style controls and inline opt-in before v3 upgrade');
  const ro=await visit(id);await ro.context.route(`**/api/pages/${id}/workspace`,async route=>{const r=await route.fetch(),body=await r.json();body.document_support.write_versions=[1,2];await route.fulfill({response:r,json:body});});await ro.page.reload();await pagesBrowserReady(ro.page);await ro.page.getByText('Edição indisponível para esta versão do documento.',{exact:true}).waitFor();assert.equal(await ro.page.locator('.ProseMirror').count(),0);assert.equal(await ro.page.getByRole('button',{name:'Estilo da página',exact:true}).count(),0);await ro.context.close();
  results.push('existing v3 document is truly readonly with writer disabled; no editable PM or style opt-in');
  await context.close();assert.deepEqual(errors,[]);assert.deepEqual(outbound,[]);console.log(`PASS ${results.length} style scenarios`);
}finally{await writeFile(join(output,'results.json'),JSON.stringify({results,errors,outbound},null,2));await browser?.close();await h.close();}
