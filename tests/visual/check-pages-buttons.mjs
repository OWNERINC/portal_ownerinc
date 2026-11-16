// Task-owned loopback Chrome + actual component, API/auth lifecycle and PGlite.
// Never opens/reloads user tabs or connects to an existing service.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPagesDatabaseHarness, pageDocument } from '../database/check-pages.mjs';
import { upgradeDocument } from '../../public/pages/document-v3.js';
import { referenceMedia } from '../helpers/pages-reference-document.mjs';
import { pagesBrowserContext } from '../helpers/pages-browser.mjs';
for (const key of ['PGLITE_MODULE_PATH','PLAYWRIGHT_MODULE_PATH']) if (!process.env[key]) throw new Error(`Set external ${key}`);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const require = createRequire(new URL('../../api/package.json', import.meta.url)), express = require('express');
const output = resolve(process.env.BUTTONS_VISUAL_OUTPUT || join(tmpdir(), 'opencode', 'pages-buttons'));
await mkdir(output, { recursive: true });
const h = await createPagesDatabaseHarness({ v3WritesEnabled: true });
const errors = [], blocked = [], results = [];
let browser;
async function api(method, path, body, actor = 'author') {
  const response = await h.api(method, path, body, actor);
  assert.ok(response.status >= 200 && response.status < 300, `${method} ${path}: ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}
try {
  const created = await api('post', '', { template_id: 'comunicado', client_mutation_id: randomUUID() });
  const asset = referenceMedia()[0];
  const uploaded = await h.request.post(`/api/pages/${created.id}/media`).set('Authorization','Bearer author').field('client_mutation_id',randomUUID()).attach('image',asset.bytes,asset.file_name);
  assert.equal(uploaded.status, 201);
  const mediaId = uploaded.body.media_id;
  const document = upgradeDocument(pageDocument('Botões sintéticos'));
  const column = document.sections[0].rows[0].columns[0];
  column.blocks.push({ id: randomUUID(), type: 'button', label: 'Ver guia completo', preset: 'primary', action: { type: 'section', value: document.sections[0].id } },
    { id: randomUUID(), type: 'button', label: 'Baixar material', preset: 'secondary', action: { type: 'download', media_id: mediaId, kind: 'image', file_name: 'guia.webp' } });
  let workspace = await api('get', `/${created.id}/workspace`);
  await api('put', `/${created.id}/draft`, { expected_version: workspace.version, document, client_mutation_id: randomUUID() });
  workspace = await api('get', `/${created.id}/workspace`);
  await api('post', `/${created.id}/publish`, { expected_version: workspace.version, revision_id: workspace.draft_revision_id, client_mutation_id: randomUUID() }, 'publisher');
  const downloadPath = `/api/pages/${created.id}/media/${mediaId}/download`;
  // This document exists only on this disposable server. Components and requests
  // below are the production exports; no screenshot-only substitute or UI globals.
  h.app.get('/__buttons', (_req,res) => res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/pages.css"><style>body.pages-page{width:auto;margin:24px;font-family:var(--font-sans)}#commands{display:flex;flex-wrap:wrap;gap:24px}input{max-width:100%}</style></head><body class="pages-page"><main><div id="reader"></div><div id="commands"></div><label>Arquivo sintético <input type="file" id="file"></label></main><script type="module">
    import { createPagesAPI } from '/pages/api.js';
    import { createPageLifecycle } from '/js/page-lifecycle.js';
    import { createPageButton } from '/pages/button.js';
    import { renderDocument } from '/pages/renderer.js';
    const page = createPageLifecycle(), api = createPagesAPI(page), id = ${JSON.stringify(created.id)};
    const read = await api.read(id);
    page.cleanup(renderDocument({host:document.getElementById('reader'),document:read.document,api,pageId:id}));
    const commands = document.getElementById('commands');
    if (new URL(location.href).searchParams.has('author')) {
      let workspace = await api.workspace(id);
      for (const command of ['upload','save']) {
        const component = createPageButton({label:command==='upload'?'Enviar arquivo':'Salvar rascunho',preset:command==='upload'?'upload':'primary',context:{
          command, canAuthor:workspace.capabilities.edit, signal:page.signal,
          async onCommand({command,signal}) {
            if(signal.aborted) throw new DOMException('Aborted','AbortError');
            if(command==='upload') {
              const file=document.getElementById('file').files[0]; if(!file) throw new Error('Selecione um arquivo');
              const ack=await api.upload(id,file,crypto.randomUUID());
              return {acknowledged:!!ack.media_id};
            }
            const ack=await api.save(id,{expected_version:workspace.version,document:workspace.draft.document,client_mutation_id:crypto.randomUUID()});
            workspace=await api.workspace(id); return {acknowledged:!!ack.draft_revision_id};
          }
        }}); commands.append(component.node); page.cleanup(component.dispose);
      }
      const video = createPageButton({label:'Assistir ao vídeo',preset:'video',action:{type:'video',value:'fixture-video'},context:{resolveBlock:()=>({type:'video_embed'}),activateVideo(){throw new Error('Consent renderer not mounted');},signal:page.signal}});
      commands.append(video.node); page.cleanup(video.dispose);
    } else document.getElementById('file').parentElement.remove();
    // Only test-owned explicit disposal; auth.js also rejects stale session bytes.
    document.addEventListener('fixture-dispose',()=>page.dispose(),{once:true});
    document.documentElement.dataset.ready='true';
  </script></body></html>`));
  h.app.get('/login.html', (_req,res) => res.type('html').send('<!doctype html><html><title>Login sintético</title><body>Login sintético</body></html>'));
  h.app.use(express.static(fileURLToPath(new URL('../../public/', import.meta.url))));
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  async function visit(uid, width = 1366) {
    const visit = await pagesBrowserContext(browser, { uid, width, errors });
    await visit.context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === h.origin || url.hostname === 'www.gstatic.com') return route.fallback();
      blocked.push(url.href); return route.abort('blockedbyclient');
    });
    await visit.page.goto(`${h.origin}/__buttons${uid === 'author' ? '?author=1' : ''}`);
    await visit.page.locator('html[data-ready=true]').waitFor(); await visit.page.evaluate(() => document.fonts.ready);
    return visit;
  }
  {
    const {page,context} = await visit('reader'); let downloads = 0, requests = 0;
    page.on('download',()=>downloads++); page.on('request',request=>{if(new URL(request.url()).pathname===downloadPath) requests++;});
    const button = page.getByRole('button',{name:'Baixar material',exact:true});
    const before = await button.boundingBox();
    assert.equal(before.height,44);
    await button.focus();
    const focus = await button.evaluate(node=>{const s=getComputedStyle(node);return {width:s.outlineWidth,gap:s.outlineOffset,style:s.outlineStyle};});
    assert.deepEqual(focus,{width:'2px',gap:'2px',style:'solid'});
    let release, entered;
    const held = new Promise(done=>{release=done;}), started = new Promise(done=>{entered=done;});
    await context.route(`**${downloadPath}`, async route=>{ entered(); await held; await route.fulfill({status:503,contentType:'application/json',body:'{"error":"synthetic failure"}'}).catch(()=>{}); }, {times:1});
    await button.click(); await started;
    const busy = await button.boundingBox(); assert.deepEqual(busy,before,'busy retains measured geometry');
    await button.evaluate(node=>{node.click();node.click();}); assert.equal(requests,1);
    release(); await page.waitForFunction(()=>document.querySelector('.pages-button-status') && [...document.querySelectorAll('.pages-button-status')].some(n=>n.textContent.includes('Não foi possível')));
    assert.equal(downloads,0); assert.equal(await button.isEnabled(),true);
    const downloaded = page.waitForEvent('download'); await button.click(); const download = await downloaded;
    assert.equal(download.suggestedFilename(),'guia.webp'); assert.equal(downloads,1);
    assert.equal(new URL(page.url()).pathname,'/__buttons');
    assert.equal(await page.evaluate(()=>globalThis.__pagesObjectURLs.size),0);
    await page.getByRole('link',{name:'Ver guia completo',exact:true}).click(); assert.match(page.url(),/#section-/);
    results.push({scenario:'real private blob download, focus/44px, held error+retry/double click, no URL navigation or leaked blobs',pass:true}); await context.close();
  }
  for (const width of [360,402,768,1366,1600]) {
    const {page,context} = await visit('author',width);
    const upload = page.getByRole('button',{name:'Enviar arquivo',exact:true}), save = page.getByRole('button',{name:'Salvar rascunho',exact:true});
    await page.locator('#file').setInputFiles({name:'synthetic.webp',mimeType:'image/webp',buffer:asset.bytes});
    let release, entered;
    const held=new Promise(done=>{release=done;}), started=new Promise(done=>{entered=done;});
    await context.route(`**/api/pages/${created.id}/draft`,async route=>{entered();await held;await route.continue().catch(()=>{});},{times:1});
    const before=await save.boundingBox(); await save.click();await started;
    assert.deepEqual(await save.boundingBox(),before);assert.equal(await save.getAttribute('aria-label'),'Salvar rascunho');
    release();await page.getByRole('button',{name:'Salvo',exact:true}).waitFor();
    const ack=await api('get',`/${created.id}/workspace`);assert.ok(ack.draft_revision_id);
    const sent=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/pages/${created.id}/media`&&r.request().method()==='POST');
    await upload.click();assert.equal((await sent).status(),201);
    await page.waitForFunction(()=>[...document.querySelectorAll('[role=status]')].some(n=>n.textContent==='Envio confirmado.'));
    for(const node of await page.locator('.pages-action-button').all()) {
      assert.equal((await node.boundingBox()).height,44);
      const type = await node.evaluate(n=>({font:getComputedStyle(n).fontFamily,size:getComputedStyle(n).fontSize}));
       assert.match(type.font,/Manrope/);assert.equal(type.size,await node.evaluate(n=>n.closest('.pages-document[data-schema-version="3"]')?'16px':'13px'));
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    const colors=await page.getByRole('button',{name:'Salvo',exact:true}).evaluate(n=>({background:getComputedStyle(n).backgroundColor,color:getComputedStyle(n).color}));
    assert.deepEqual(colors,{background:'rgb(233, 241, 235)',color:'rgb(52, 95, 80)'});
    await page.screenshot({path:join(output,`buttons-${width}.png`),fullPage:true});
    results.push({scenario:'source component vocabulary, real private upload/save ACK and responsive 44px geometry',width,pass:true});await context.close();
  }
  for(const exit of ['dispose','account']) {
    const {page,context}=await visit('reader');let downloads=0;page.on('download',()=>downloads++);
    let release,entered;const held=new Promise(done=>{release=done;}),started=new Promise(done=>{entered=done;});
    await context.route(`**${downloadPath}`,async route=>{const response=await route.fetch();entered();await held;await route.fulfill({response}).catch(()=>{});},{times:1});
    await page.getByRole('button',{name:'Baixar material',exact:true}).click();await started;
    if(exit==='dispose')await page.evaluate(()=>document.dispatchEvent(new Event('fixture-dispose')));
    else {await page.evaluate(()=>globalThis.__fixtureChangeUser('outsider'));await page.waitForURL('**/login.html**');}
    release();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    assert.equal(downloads,0);assert.equal(await page.evaluate(()=>globalThis.__pagesObjectURLs.size),0);
    results.push({scenario:`held real private response discarded on ${exit}`,pass:true});await context.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  await writeFile(join(output,'results.json'),JSON.stringify({results,errors,blocked,evidence:'Chrome + actual component/private API/auth lifecycle/serialized PGlite. Synthetic Firebase; native PostgreSQL/Nginx gates PENDING.'},null,2));
  console.log(`Pages buttons PASS: ${results.length} Chrome scenarios, zero JS errors/outbound requests; artifacts: ${output}`);
} catch(error) {
  await writeFile(join(output,'failure.json'),JSON.stringify({results,errors,blocked,error:error.stack},null,2));
  for(const [index,page] of (browser?.contexts().flatMap(c=>c.pages())||[]).entries())if(!page.isClosed())await page.screenshot({path:join(output,`failure-${index}.png`),fullPage:true}).catch(()=>{});
  throw error;
} finally {await browser?.close();await h.close();}
