// Task 15: actual modal + HTTP/SQL, synthetic accounts, owned loopback only.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createPagesDatabaseHarness,cargoA,cargoB,pageDocument} from '../database/check-pages.mjs';
import {pagesBrowserContext,pagesBrowserReady,pagesBrowserReflow} from '../helpers/pages-browser.mjs';
import {referenceDocument,referenceIds} from '../helpers/pages-reference-document.mjs';
import {upgradeDocument} from '../../public/pages/document-v3.js';
for(const key of ['PGLITE_MODULE_PATH','PLAYWRIGHT_MODULE_PATH','AXE_MODULE_PATH','PAGES_REFERENCE_DIR'])if(!process.env[key])throw Error(`Set external ${key}`);
const {chromium}=await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const {default:AxeBuilder}=await import(pathToFileURL(resolve(process.env.AXE_MODULE_PATH)).href);
const require=createRequire(new URL('../../api/package.json',import.meta.url)),express=require('express');
const h=await createPagesDatabaseHarness({v3WritesEnabled:true}),results=[],errors=[],payloads=[];
const output=resolve(process.env.REVIEW_VISUAL_OUTPUT||join(tmpdir(),'opencode','pages-review-task15'));
await mkdir(output,{recursive:true});let browser;
const key=()=>({client_mutation_id:randomUUID()});
async function api(method,path,body,actor='super'){const r=await h.api(method,path,body,actor);assert.ok(r.status>=200&&r.status<300,`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);return r.body;}
async function create(doc){const {id}=await api('post','',{template_id:doc.template.id,...key()});await api('put',`/${id}/draft`,{expected_version:0,...key(),document:doc});return id;}
async function visit(id,uid='super'){
  const v=await pagesBrowserContext(browser,{width:1600,uid,errors});
  // Test-only observation/injection; the served production module has no hook.
  await v.context.route('**/pages/editor.js',async route=>{const source=await readFile(new URL('../../public/pages/editor.js',import.meta.url),'utf8');await route.fulfill({contentType:'text/javascript',body:source.replace('  void load();\n}', '  globalThis.__reviewTest=()=>({state,update});\n  void load();\n}')});});
  await v.page.setViewportSize({width:1600,height:1160});await v.page.goto(`${h.origin}/page-editor.html?id=${id}`);await pagesBrowserReady(v.page);
  await v.page.locator('#page-editor-root[data-save-state=saved]').waitFor();return v;
}
async function open(p){await p.getByRole('button',{name:'Publicar',exact:true}).click();const d=p.getByRole('dialog',{name:'Pronto para compartilhar?'});await d.waitFor();await p.waitForFunction(()=>!document.querySelector('.pages-review-checks input').disabled);return d;}
const pub=d=>d.getByRole('button',{name:'Publicar página',exact:true});
const personal=d=>d.getByRole('checkbox',{name:'Prévia de celular conferida',exact:true});
async function saved(p,d){await d.getByRole('button',{name:'Salvar rascunho',exact:true}).click();await p.locator('#page-editor-root[data-save-state=saved]').waitFor();}
const rect=l=>l.evaluate(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};});
const near=(a,b,label,tolerance=2)=>{for(const k of ['x','y','width','height'])assert.ok(Math.abs(a[k]-b[k])<=tolerance,`${label}.${k}: ${a[k]} != ${b[k]}`);};
try{
  h.app.use(express.static(fileURLToPath(new URL('../../public/',import.meta.url))));browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});
  const manifest=JSON.parse(await readFile(new URL('../fixtures/pages-reference/manifest.json',import.meta.url),'utf8')).find(r=>r.id==='desktop-review');
  const original=await readFile(join(process.env.PAGES_REFERENCE_DIR,manifest.png));assert.equal(createHash('sha256').update(original).digest('hex'),manifest.sha256);
  const doc=referenceDocument();doc.metadata.audience.job_title_ids=[cargoA];const referenceId=await create(doc);
  const reference=await visit(referenceId),rp=reference.page;
  await rp.locator(`[data-block-id="${referenceIds.introductionBlock}"] .ProseMirror`).click();
  const rd=await open(rp);await rp.evaluate(()=>document.fonts.ready);await rp.mouse.move(800,100);
  const geometry={dialog:await rect(rd),title:await rect(rd.getByRole('textbox',{name:'Título',exact:true})),category:await rect(rd.getByRole('combobox',{name:'Categoria',exact:true})),visibility:await rect(rd.getByRole('button',{name:/Visibilidade/})),back:await rect(rd.getByRole('button',{name:'Voltar à edição',exact:true})),publish:await rect(pub(rd))};
  await rp.screenshot({path:join(output,'desktop-review-1600.png')});
  for(const [name,id] of [['dialog','review-dialog'],['title','title-field'],['category','category-field'],['visibility','visibility-field'],['back','back-to-editor'],['publish','publish-page']])near(geometry[name],manifest.regions.find(r=>r.id===id),name,name==='back'?4:2);
  assert.equal(await pub(rd).isDisabled(),true,'actual audio placeholder remains unpublishable');
  const disabledPaint=await pub(rd).evaluate(n=>{const s=getComputedStyle(n);return{background:s.backgroundColor,color:s.color,cursor:s.cursor};});
  assert.notEqual(disabledPaint.background,'rgb(42, 39, 94)','unavailable publish must not paint as the enabled primary action');
  assert.equal(disabledPaint.cursor,'not-allowed');
  await pub(rd).hover();assert.equal(await pub(rd).evaluate(n=>getComputedStyle(n).backgroundColor),disabledPaint.background,'hover cannot restore enabled colors on a disabled action');
  assert.doesNotMatch(await rd.innerText(),/Protótipo:/);assert.match(await rd.locator('.pages-review-url').innerText(),/^\/conteudos\//);
  await pagesBrowserReflow(rp,AxeBuilder,'review-source-sized');await rd.getByRole('button',{name:'Fechar revisão',exact:true}).click();
  assert.equal(await rp.getByRole('button',{name:'Publicar',exact:true}).evaluate(n=>n===document.activeElement),true);
  await reference.context.close();results.push({scenario:'unchanged source SHA, 1600x1160 real fixture modal anchors, disabled/hover presentation, placeholder validation and close/focus',geometry,disabledPaint});

  const id=await create(upgradeDocument(pageDocument('Revisão editável'))),v=await visit(id),p=v.page;
  let d=await open(p),w=await api('get',`/${id}/workspace`);const alias=w.slug;
  const enabledPaint=await pub(d).evaluate(n=>{const s=getComputedStyle(n);return{background:s.backgroundColor,color:s.color};});
  assert.equal(enabledPaint.background,'rgb(42, 39, 94)');assert.notEqual(enabledPaint.color,disabledPaint.color);
  // The review session must invalidate even after its DOM has been removed.
  await personal(d).check();await d.getByRole('button',{name:'Voltar à edição',exact:true}).click();
  const beforeClosedEdit=await p.evaluate(()=>JSON.stringify(__reviewTest().state.document));
  await p.evaluate(()=>{const {state}=__reviewTest();state.transact({closeGroup:true},doc=>{doc.metadata.title='Closed-modal edit';});state.undo();});
  assert.equal(await p.evaluate(()=>JSON.stringify(__reviewTest().state.document)),beforeClosedEdit);d=await open(p);assert.equal(await personal(d).isChecked(),false,'edit then undo while closed invalidates checks');
  await personal(d).check();await d.getByRole('button',{name:'Voltar à edição',exact:true}).click();
  await v.context.route(`**/api/pages/${id}/media`,route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"failed closed-modal upload"}'}),{times:1});
  await p.locator('.pages-add-tools input[type=file]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from('synthetic bytes intercepted before upload')});
  await p.getByRole('button',{name:'Cancelar upload não confirmado',exact:true}).click();
  assert.equal(await p.evaluate(()=>JSON.stringify(__reviewTest().state.document)),beforeClosedEdit);d=await open(p);assert.equal(await personal(d).isChecked(),false,'failed upload and cancel while closed invalidates checks');
  await personal(d).check();let preflightPosts=0;
  const countPost=request=>{if(request.method()==='POST'&&request.url().endsWith(`/${id}/publish`))preflightPosts++;};p.on('request',countPost);
  await v.context.route(`**/api/pages/${id}/workspace`,route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"preflight unavailable"}'}),{times:1});
  await pub(d).click();await d.locator('.pages-review-feedback').filter({hasText:'Não foi possível'}).waitFor();p.off('request',countPost);
  assert.equal(preflightPosts,0);assert.equal(await personal(d).isChecked(),false);assert.equal(await d.getByRole('textbox',{name:'Título',exact:true}).isEnabled(),true,'preflight failure is not an ambiguous write');
  await personal(d).check();await d.getByRole('textbox',{name:'Título',exact:true}).fill('Título revisado');
  assert.equal(await personal(d).isChecked(),false);assert.equal(await pub(d).isDisabled(),true);
  assert.equal((await api('get',`/${id}/workspace`)).draft_revision_id,w.draft_revision_id);
  await d.getByRole('combobox',{name:'Categoria',exact:true}).fill('Pessoas e cultura');
  await p.waitForFunction(()=>[...document.querySelectorAll('datalist option')].some(n=>n.value==='Pessoas e cultura'));
  await d.getByRole('combobox',{name:'Categoria',exact:true}).fill('Categoria livre Task 15');
  await d.getByRole('button',{name:/Visibilidade/}).click();await d.getByRole('checkbox',{name:'Cargo sintético B',exact:true}).check();await d.getByRole('checkbox',{name:'Cargo sintético A',exact:true}).uncheck();
  await d.getByRole('button',{name:/Visibilidade/}).click();await saved(p,d);
  w=await api('get',`/${id}/workspace`);assert.equal(w.draft.document.metadata.title,'Título revisado');assert.equal(w.draft.document.metadata.category,'Categoria livre Task 15');assert.deepEqual(w.draft.document.metadata.audience.job_title_ids,[cargoB]);assert.equal(w.slug,alias);
  assert.match(await d.locator('.pages-review-revision').innerText(),new RegExp(w.draft_revision_id));assert.equal(await pub(d).isEnabled(),true);
  // Outside-modal mutations and uploads use the real shared editor authority.
  await personal(d).check();await p.evaluate(()=>__reviewTest().state.transact({group:'outside'},doc=>{doc.metadata.title='Título externo';}));
  assert.equal(await d.getByRole('textbox',{name:'Título',exact:true}).inputValue(),'Título externo');assert.equal(await personal(d).isChecked(),false);assert.equal(await pub(d).isDisabled(),true);
  await p.keyboard.press('Escape');await d.waitFor({state:'hidden'});assert.equal(await p.locator('#page-editor-root').getAttribute('data-save-state'),'dirty');
  assert.equal(await p.getByRole('button',{name:'Salvar rascunho',exact:true}).evaluate(n=>n===document.activeElement),true,'dirty close returns to the available explicit save action');
  await p.getByRole('button',{name:'Salvar rascunho',exact:true}).click();await p.locator('#page-editor-root[data-save-state=saved]').waitFor();d=await open(p);
  await personal(d).check();await p.evaluate(()=>__reviewTest().state.uploadStart());assert.equal(await personal(d).isChecked(),false);assert.equal(await pub(d).isDisabled(),true);await p.evaluate(()=>__reviewTest().state.uploadEnd());
  // Save loss after a REAL COMMIT: later local bytes remain dirty after exact retry.
  await d.getByRole('textbox',{name:'Título',exact:true}).fill('ACK de rascunho perdido');let saveBytes;
  await v.context.route(`**/api/pages/${id}/draft`,async route=>{saveBytes=route.request().postData();const r=await route.fetch();assert.equal(r.status(),200);await route.fulfill({status:503,contentType:'application/json',body:'{"error":"lost save ACK"}'});},{times:1});
  await d.getByRole('button',{name:'Salvar rascunho',exact:true}).click();await p.locator('#page-editor-root[data-save-state=failure]').waitFor();assert.equal(await pub(d).isDisabled(),true);
  await d.getByRole('textbox',{name:'Título',exact:true}).fill('Depois do ACK perdido');
  const retrySave=p.waitForRequest(r=>r.method()==='PUT'&&r.url().endsWith(`/${id}/draft`));await d.getByRole('button',{name:'Salvar rascunho',exact:true}).click();assert.equal((await retrySave).postData(),saveBytes);
  await p.locator('#page-editor-root[data-save-state=dirty]').waitFor();assert.equal(await d.getByRole('textbox',{name:'Título',exact:true}).inputValue(),'Depois do ACK perdido');assert.equal(await pub(d).isDisabled(),true);await saved(p,d);
  // Definitive validation error: personal checks cannot bypass server validation.
  await personal(d).check();await h.pool.query('UPDATE job_titles SET active=false WHERE id=$1',[cargoB]);
  const rejected=p.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/${id}/publish`));
  await pub(d).click();const rejectedResponse=await rejected;assert.equal(rejectedResponse.status(),400);const failedPayload=rejectedResponse.request().postData();await d.locator('.pages-review-feedback').filter({hasText:/cargos|possível/}).waitFor();assert.equal(await personal(d).isChecked(),false);
  await h.pool.query('UPDATE job_titles SET active=true WHERE id=$1',[cargoB]);
  // Ambiguous publication after COMMIT: close/reopen retries identical key/CAS/revision.
  let first;await v.context.route(`**/api/pages/${id}/publish`,async route=>{first=route.request().postData();const r=await route.fetch();assert.equal(r.status(),200);await route.fulfill({status:503,contentType:'application/json',body:'{"error":"lost publish ACK"}'});},{times:1});
  await pub(d).click();await d.locator('.pages-review-revision').filter({hasText:'Publicação não confirmada'}).waitFor();assert.equal(await d.getByRole('textbox',{name:'Título',exact:true}).isDisabled(),true);
  assert.equal(first,failedPayload,'definitive failed publish and ambiguous retry retain the exact original snapshot/key');
  await h.pool.query('UPDATE job_titles SET active=false WHERE id=$1',[cargoB]);
  await d.getByRole('button',{name:'Voltar à edição',exact:true}).click();
  p.once('dialog',prompt=>prompt.dismiss());await p.getByRole('link',{name:'Voltar à gestão de Pages',exact:true}).click();
  assert.match(p.url(),new RegExp(id));assert.equal(await p.locator('#page-editor-root').isVisible(),true,'leave guard retains unresolved publication');d=await open(p);
  await d.getByRole('button',{name:/Visibilidade/}).click();
  assert.equal(await d.getByRole('checkbox',{name:/Cargo sintético B.*inativo/}).isChecked(),true);
  assert.equal(await pub(d).isEnabled(),true,'inactive cargo must not block exact uncertain receipt reconciliation');
  const retryPublish=p.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith(`/${id}/publish`));await pub(d).click();assert.equal((await retryPublish).postData(),first);await d.waitFor({state:'hidden'});
  payloads.push(JSON.parse(first));assert.deepEqual(Object.keys(JSON.parse(first)).sort(),['client_mutation_id','expected_version','revision_id']);
  w=await api('get',`/${id}/workspace`);assert.equal(w.published_revision_id,JSON.parse(first).revision_id);
  const audit=await h.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE target_id=$1 AND action='pages.publish'",[id]);assert.equal(audit.rows[0].n,1);
  assert.equal((await h.api('get',`/${id}`,undefined,'outsider')).status,404,'receipt replay does not grant reading to an inactive cargo');
  await h.pool.query('UPDATE job_titles SET active=true WHERE id=$1',[cargoB]);
  const reader=await api('get',`/by-slug/${alias}`,undefined,'outsider');assert.equal(reader.document.metadata.title,'Depois do ACK perdido');assert.equal(reader.document.metadata.category,'Categoria livre Task 15');assert.deepEqual(reader.document.metadata.audience.job_title_ids,[cargoB]);assert.equal((await h.api('get',`/${id}`,undefined,'reader')).status,404);
  await v.context.close();results.push({scenario:'title/category suggestions/free value/cargos roundtrip; closed edit/undo and failed upload/cancel invalidate checks; explicit save lost COMMIT retry; publication lost COMMIT + cargo deactivation + close/reopen exact retry/one audit; inactive reader denied; alias and reader audience',enabledPaint});

  const ro=await visit(id,'publisher'),r=ro.page;d=await open(r);
  assert.equal(await d.getByRole('textbox',{name:'Título',exact:true}).isDisabled(),true);assert.equal(await d.getByRole('combobox',{name:'Categoria',exact:true}).isDisabled(),true);
  await d.getByRole('textbox',{name:'Título',exact:true}).evaluate(node=>{node.value='Forged';node.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.equal(await d.getByRole('textbox',{name:'Título',exact:true}).inputValue(),'Depois do ACK perdido');
  await d.getByRole('button',{name:/Visibilidade/}).click();assert.equal(await d.getByRole('checkbox',{name:'Cargo sintético B',exact:true}).isDisabled(),true);
  await pub(d).click();await d.waitFor({state:'hidden'});await ro.context.close();results.push({scenario:'publisher-only disabled revision fields, existing saved revision publishes without edits'});
  // A real competing save is discovered on focus, and independently by CAS after preflight.
  const conflict=await visit(id),cp=conflict.page;d=await open(cp);await personal(d).check();w=await api('get',`/${id}/workspace`);w.draft.document.metadata.title='Outra aba';await api('put',`/${id}/draft`,{expected_version:w.version,...key(),document:w.draft.document});
  await cp.evaluate(()=>window.dispatchEvent(new Event('focus')));await d.locator('.pages-review-revision').filter({hasText:'outra sessão'}).waitFor();assert.equal(await personal(d).isChecked(),false);assert.equal(await pub(d).isDisabled(),true);await cp.keyboard.press('Escape');await conflict.context.close();
  const race=await visit(id),ap=race.page;d=await open(ap);
  await race.context.route(`**/api/pages/${id}/publish`,async route=>{const head=await api('get',`/${id}/workspace`);head.draft.document.metadata.category='Race';await api('put',`/${id}/draft`,{expected_version:head.version,...key(),document:head.draft.document});await route.continue();},{times:1});
  await pub(d).click();await d.locator('.pages-review-feedback').filter({hasText:'outra sessão'}).waitFor();assert.equal(await pub(d).isDisabled(),true);assert.equal((await api('get',`/${id}/workspace`)).draft.document.metadata.category,'Race');await race.context.close();
  results.push({scenario:'another-tab head invalidates on focus without replacement; actual save racing preflight returns CAS409 and blocks publish'});
  const lifecycle=await visit(id),lp=lifecycle.page;const beforeArchive=await api('get',`/${id}/workspace`);
  await lp.getByRole('button',{name:'Página',exact:true}).click();await lp.getByRole('button',{name:'Arquivar',exact:true}).click();
  await lp.getByRole('dialog',{name:'Arquivar Page',exact:true}).getByRole('button',{name:'Arquivar',exact:true}).click();
  await lp.locator('#page-editor-root[data-save-state=saved]').waitFor();await lp.getByRole('button',{name:'Página',exact:true}).click();
  await lp.getByRole('button',{name:'Restaurar',exact:true}).click();await lp.getByRole('dialog',{name:'Restaurar Page',exact:true}).getByRole('button',{name:'Restaurar como rascunho',exact:true}).click();
  await lp.locator('#page-editor-root[data-save-state=saved]').waitFor();const restored=await api('get',`/${id}/workspace`);
  assert.equal(restored.archived_at,null);assert.equal(restored.published_revision_id,null);assert.deepEqual(restored.draft.document,beforeArchive.draft.document);await lifecycle.context.close();
  results.push({scenario:'existing archive/restore UI roundtrip preserves draft and never republishes'});
  const legacyId=await create(pageDocument('Categoria em versão legada')),legacy=await visit(legacyId),lg=legacy.page;d=await open(lg);
  assert.equal((await api('get',`/${legacyId}/workspace`)).draft.document.schema_version,1);
  await d.getByRole('combobox',{name:'Categoria',exact:true}).fill('Nova categoria');await saved(lg,d);
  assert.equal((await api('get',`/${legacyId}/workspace`)).draft.document.schema_version,3);
  await pub(d).click();await d.waitFor({state:'hidden'});await legacy.context.close();
  results.push({scenario:'real category edit explicitly upgrades v1 with enabled writer; JSONB key order does not cause false preflight conflict'});
  assert.deepEqual(errors,[]);await writeFile(join(output,'results.json'),JSON.stringify({results,payloads,errors,evidence:'Actual Chrome/UI/HTTP/SQL, serialized PGlite; synthetic identities. No native services or six-board acceptance.'},null,2));
  console.log(`Pages review PASS: ${results.length} scenario groups; artifacts: ${output}`);
}catch(error){for(const [i,p] of (browser?.contexts().flatMap(c=>c.pages())||[]).entries())if(!p.isClosed())await p.screenshot({path:join(output,`failure-${i}.png`),fullPage:true}).catch(()=>{});throw error;}
finally{await browser?.close();await h.close();}
