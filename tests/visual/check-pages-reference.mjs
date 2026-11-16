// Six fresh source states, production components and owned loopback only.
// Exit 1 means fidelity differences remain; all six reports are still produced.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';
import { createPagesDatabaseHarness, pageDocument, cargoA } from '../database/check-pages.mjs';
import { pagesBrowserContext, pagesBrowserReady } from '../helpers/pages-browser.mjs';
import { referenceDocument, referenceIds as ids, referenceMedia } from '../helpers/pages-reference-document.mjs';
import { compareCaptures, comparisonRegions, expectedAnchors, loadPNG, prepareOutput, sha256, validateReference } from './compare-pages-reference.mjs';
import { expectedText } from './pages-reference-text.mjs';
import { referenceInventory } from './pages-reference-inventory.mjs';

const required = ['PAGES_REFERENCE_DIR','PAGES_REFERENCE_OUTPUT','PNGJS_MODULE_PATH','PGLITE_MODULE_PATH','PLAYWRIGHT_MODULE_PATH','PAGES_REFERENCE_BROWSER_VERSION'];
for (const key of required) if (!process.env[key]) throw Error(`Set ${key}; comparison cannot skip mandatory evidence`);
const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../fixtures/pages-reference/manifest.json', import.meta.url), 'utf8'));
assert.equal(manifest.length, 6);
const PNG = await loadPNG(process.env.PNGJS_MODULE_PATH);
// Validate every original before starting a browser, SQL or creating output.
for (const entry of manifest) await validateReference(process.env.PAGES_REFERENCE_DIR, entry, PNG.sync.read);
const output = await prepareOutput(process.env.PAGES_REFERENCE_OUTPUT, process.env.PAGES_REFERENCE_DIR, root);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const require = createRequire(new URL('../../api/package.json', import.meta.url)), express = require('express');
let h = await createPagesDatabaseHarness({ v3WritesEnabled: true });
const captures = [], buttonStates = [], errors = [], outbound = [];
let browser;
const key = () => ({ client_mutation_id: randomUUID() });
async function api(method, path, body) {
  const r = await h.api(method, path, body, 'super');
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function create(document) {
  const { id } = await api('post', '', { template_id: document.template.id, ...key() });
  await api('put', `/${id}/draft`, { expected_version: 0, document, ...key() });
  return id;
}
async function visit(width, height) {
  const v = await pagesBrowserContext(browser, { width, errors, touch: width < 600 });
  await v.page.setViewportSize({ width, height });
  // Only our listener, not arbitrary loopback services. Firebase module stubs
  // registered by pagesBrowserContext are explicitly fulfilled locally.
  await v.context.route('**/*', route => {
    const u = new URL(route.request().url());
    if (u.origin === h.origin || u.origin === 'https://www.gstatic.com') return route.fallback();
    outbound.push(u.href); return route.abort('blockedbyclient');
  });
  return v;
}
const block = id => `.pages-editor-block[data-block-id="${id}"]`;
const selectors = {
  header: '.pages-v2-header', toolbar: '.pages-v2-tools', structure: '.pages-v2-structure', canvas: '.pages-editor-surface',
  'selected-block': block(ids.introductionBlock), 'context-toolbar': '.pages-v2-viewport > .pages-format-tools',
  'audio-placeholder': block(ids.audioBlock), inspector: '.pages-v2-inspector',
  'inspector-font': '.pages-v2-inspector select[aria-label="Tipografia"]', 'inspector-size': '.pages-v2-inspector select[aria-label="Tamanho"]',
  'inspector-align': '.pages-inspector-group[data-inspector-section=style] > .pages-field select[aria-label="Alinhamento"]', 'inspector-width': '.pages-v2-inspector select[aria-label="Largura do bloco"]',
  'inspector-fill': '.pages-v2-inspector select[aria-label="Fundo do bloco"]', 'inspector-tags': '.pages-v2-inspector input[aria-label="Tags do bloco"]',
  'inspector-icon': '.pages-v2-inspector select[aria-label="Ícone"]', 'daily-card': block(ids.dailyBlock), 'meetings-card': block(ids.meetingsBlock), faq: block(ids.faqBlock),
  'style-popover': '.pages-page-style-panel', 'style-tabs': '.pages-style-tabs', 'font-example': '.pages-style-sample',
  'selected-palette': '[data-theme-palette=conecta]', 'custom-color': '[aria-label="Cor personalizada de destaque"]', 'apply-style': '[data-apply-style]',
  'insert-popover': '.pages-insert-panel', 'insert-search': '.pages-insert-panel input',
  'review-dialog': '.pages-publication-dialog', 'visibility-field': '.pages-review-visibility',
  'bottom-sheet': '.pages-v2-inspector', typography: '[aria-label="Tipografia e tamanho"]', background: '.pages-v2-inspector select[aria-label="Fundo do bloco"]',
};
function locator(p, name) {
  if(name.startsWith('insert-icon-'))return p.locator('.pages-insert-panel-content > .pages-insert-actions > .pages-insert-item > svg').nth(Number(name.slice(-1)));
  if(name==='title-field')return p.getByRole('dialog',{name:'Pronto para compartilhar?'}).getByRole('textbox',{name:'Título',exact:true});
  if(name==='category-field')return p.getByRole('dialog',{name:'Pronto para compartilhar?'}).getByRole('combobox',{name:'Categoria',exact:true});
  const buttons = { 'insert-trigger': 'Inserir bloco', 'style-trigger': 'Estilo da página', 'back-to-editor': 'Voltar à edição', 'publish-page': 'Publicar página', 'finish-editing': 'Concluir edição' };
  if (buttons[name]) return p.getByRole('button', { name: buttons[name], exact: true });
  if (['primary','secondary','video','upload','confirmed'].includes(name)) return p.locator(`#specimen-${name} .pages-action-button`);
  return p.locator(selectors[name] || `[data-missing-reference-region="${name}"]`);
}
async function rectangle(loc, name) {
  if (await loc.count() !== 1) return { name, visible: false, reason: `locator count ${await loc.count()}` };
  return loc.evaluate((n, name) => {
    const b = n.getBoundingClientRect(), s = getComputedStyle(n);
    return { name, x: b.x, y: b.y, width: b.width, height: b.height, visible: s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0 };
  }, name);
}
async function settle(p) {
  await p.evaluate(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); });
}
async function inventory(p) {
  return p.evaluate(referenceInventory);
}
async function capture(entry, p, documentId) {
  await settle(p);
  assert.equal(await p.evaluate(() => devicePixelRatio), 1, 'deviceScaleFactor 1 required');
  const regions = comparisonRegions(manifest, entry), geometry = [];
  for (const r of regions) {
    if (r.id === 'backdrop') geometry.push(await p.evaluate(() => ({ name: 'backdrop', x: 0, y: 0, width: innerWidth, height: innerHeight, visible: !!document.querySelector('dialog[open]') })));
    else if (r.id === 'preview') {
      const canvas = await rectangle(p.locator('.pages-v2-center'), 'preview'), sheet = await rectangle(p.locator('.pages-v2-inspector'), 'sheet');
      geometry.push({ ...canvas, height: sheet.y - canvas.y, measurement: 'visible canvas clipped at DOM sheet top' });
    } else geometry.push(await rectangle(locator(p, r.id), r.id));
  }
  const mappings = {
    'primary-top-left': ['primary'], 'specimens-divider': ['divider'], 'canvas-top-left': ['canvas'], 'selection-origin': ['selected-block'],
    'font-control': ['inspector-font'], 'inspector-top-left': ['inspector'], 'style-trigger': ['style-trigger'], 'style-top-left': ['style-popover'],
    'insert-trigger-bottom': ['insert-trigger','bottom-left'], 'search-top-left': ['insert-search'], 'review-top-left': ['review-dialog'],
    'publish-bottom-right': ['publish-page','bottom-right'], 'sheet-origin': ['bottom-sheet'], 'finish-top-left': ['finish-editing'],
  };
  const anchors = [];
  for (const a of entry.anchors) {
    const [id, corner] = mappings[a.id], g = id === 'divider' ? await rectangle(p.locator('#specimens-divider'), id) : geometry.find(g => g.name === id) || await rectangle(locator(p, id), id);
    anchors.push({ name: a.id, x: g.x + (corner === 'bottom-right' ? g.width : 0), y: g.y + (corner?.startsWith('bottom') ? g.height : 0), visible: g.visible });
  }
  // Attach provenance to JS objects only: no attributes, classes, paint or state edits.
  for(const r of regions){
    const loc=locator(p,r.id);
    if(await loc.count()===1)await loc.evaluate((n,id)=>{n.__referenceRegions=[...(n.__referenceRegions||[]),id];},r.id);
  }
  if(entry.id==='mobile-content')await p.locator('.pages-v2-center').evaluate(n=>{n.__referenceRegions=[...(n.__referenceRegions||[]),'preview'];});
  const {text,underlyingDOM} = await inventory(p);
  const textChecks=expectedText(entry.id).map(({region,text})=>({region,text}));
  const regionText=regions.map(r=>({id:r.id,items:text.filter(t=>t.regions.includes(r.id))}));
  const path = join(output, `${entry.id}.png`);
  await p.screenshot({ path, fullPage: false, animations: 'disabled', caret: 'hide' });
  const state = await p.evaluate(() => ({ deviceScaleFactor: devicePixelRatio, scroll: { x: scrollX, y: scrollY }, focus: document.activeElement?.outerHTML.slice(0, 400), selection: getSelection()?.toString(), formatControls:[...document.querySelectorAll('.pages-format-tools [aria-pressed]')].map(n=>({name:n.getAttribute('aria-label'),pressed:n.getAttribute('aria-pressed')})), fonts: [...document.fonts].filter(f => f.status === 'loaded').map(f => ({ family: f.family, weight: f.weight, status: f.status })), innerScroll: [...document.querySelectorAll('.pages-v2-viewport,.pages-v2-inspector')].map(n => ({ className: n.className, x: n.scrollLeft, y: n.scrollTop })) }));
  captures.push({ id: entry.id, path, documentId, regions, geometry, expectedAnchors: expectedAnchors(entry), anchors, textChecks, text, underlyingDOM, regionText, state,
    viewport: { name: 'viewport', x: 0, y: 0, ...p.viewportSize() } });
}

// Layout scaffold only: all button DOM, icons, paint and state transitions come
// from production createPageButton/pages.css. No specimen skin/width overrides.
function buttonsHTML(id, mediaId) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/pages.css"><style>
  body.pages-page{margin:0;background:#FEFDFB;font-family:var(--font-sans);font-size:16px;color:#2A275E}.board{padding:40px;height:400px;box-sizing:content-box}.board h1{margin:0;font-size:26px;line-height:36px;font-weight:700}.intro{margin:24px 0 0;font-size:14px;color:#6C706D;line-height:20px}.specimens{display:grid;grid-template-columns:repeat(5,1fr);gap:24px;margin-top:24px}.specimen-label{font-size:11px;line-height:16px;color:#6C706D;margin:0 0 9px;font-weight:600}.slot{height:52px}#specimens-divider{border:0;background:#E1E2DD;height:1px;margin:19px 0 24px}.notes{display:grid;grid-template-columns:repeat(3,1fr);gap:32px}.notes h2{font-size:14px;line-height:20px;margin:0 0 8px}.notes p{font-size:12px;line-height:17px;color:#6C706D;margin:0}.board footer{font-size:11px;color:#6C706D;margin-top:48px}.video-fixture{margin:40px}
  </style></head><body class="pages-page"><main class="board"><h1>Botões que completam o conteúdo</h1><p class="intro">Componentes editáveis na identidade do Conecta. Altura 44 px, ícones Lucide e rótulos claros.</p><div class="specimens">${[['primary','PRIMÁRIO'],['secondary','SECUNDÁRIO'],['video','VÍDEO'],['upload','ENVIO'],['confirmed','CONFIRMADO']].map(([key,label])=>`<section id="specimen-${key}"><p class="specimen-label">${label}</p><div class="slot"></div></section>`).join('')}</div><hr id="specimens-divider"><div class="notes"><section><h2>Foco visível</h2><p>Contorno contrastante de 2 px e espaço de 2 px ao redor.</p></section><section><h2>Estados consistentes</h2><p>Carregando mantém o tamanho. Desabilitado não recebe clique.</p></section><section><h2>Acessibilidade</h2><p>Ação por verbo. Ícone acompanha texto; não depende só da cor.</p></section></div><footer>Componentes de produção · API e ACK locais reais · Identidades sintéticas.</footer></main><input id="file" type="file" hidden><section class="video-fixture" id="video-target"></section><script type="module">
  import {createPagesAPI} from '/pages/api.js';
  import {createPageLifecycle} from '/js/page-lifecycle.js';
  import {createPageButton} from '/pages/button.js';
  import {renderDocument} from '/pages/renderer.js';
  const page=createPageLifecycle(),api=createPagesAPI(page),id=${JSON.stringify(id)},mediaId=${JSON.stringify(mediaId)};
  let workspace=await api.workspace(id);
  const doc=structuredClone(workspace.draft.document),section=doc.sections[0];
  const video={id:'e2d00000-0000-4000-8000-000000000099',type:'video_embed',provider:'youtube',video_id:'dQw4w9WgXcQ',title:'Vídeo sintético',transcript:''};
  // Separate functional destination below the 480px vocabulary board, never a source golden.
  doc.schema_version=3;doc.presentation={theme:'conecta',defaults:{font:'manrope',scale:'standard',align:'start',palette:'conecta',foreground:'#26204A',background:'#FFFFFF',accent:'#E84F1C'}};doc.metadata.category='';section.rows[0].columns[0].blocks=[video];
  const host=document.getElementById('video-target');page.cleanup(renderDocument({host,document:doc,api,pageId:id,staged:true}));
  const context={api,pageId:id,staged:true,host,signal:page.signal,canAuthor:true,
    async onCommand({command}){if(command==='upload'){const file=document.getElementById('file').files[0];const ack=await api.upload(id,file,crypto.randomUUID());return {acknowledged:!!ack.media_id};}const ack=await api.save(id,{expected_version:workspace.version,document:workspace.draft.document,client_mutation_id:crypto.randomUUID()});workspace=await api.workspace(id);return {acknowledged:!!ack.draft_revision_id};},
    resolveBlock:()=>video,activateVideo(){host.querySelector('[data-pages-video-consent]').focus();}
  };
  const items={primary:{label:'Ver guia completo',action:{type:'section',value:section.id}},secondary:{label:'Baixar material',preset:'secondary',action:{type:'download',media_id:mediaId,kind:'image',file_name:'guia.webp'}},video:{label:'Assistir ao vídeo',preset:'video',action:{type:'video',value:video.id}},upload:{label:'Enviar arquivo',preset:'upload',context:{...context,command:'upload'}},confirmed:{label:'Salvar',context:{...context,command:'save'}}};
  const components={};for(const [key,options]of Object.entries(items)){const c=createPageButton({context,...options});components[key]=c;document.querySelector('#specimen-'+key+' .slot').append(c.node);page.cleanup(c.dispose);}
  // Public test-owned controls only; never mutate dataset/CSS/labels to mimic states.
  globalThis.specimens={disable(value){Object.values(components).forEach(c=>c.setDisabled(value));}};
  document.documentElement.dataset.ready='true';
  </script></body></html>`;
}

async function buttonVisit() {
  const id = await create(pageDocument('Vocabulário de botões sintético'));
  const asset = referenceMedia()[0];
  const response = await h.request.post(`/api/pages/${id}/media`).set('Authorization','Bearer super').field('client_mutation_id',randomUUID()).attach('image',asset.bytes,asset.file_name);
  assert.equal(response.status, 201);
  const route = `/__reference-buttons/${id}`;
  h.app.get(route, (_req,res) => res.type('html').send(buttonsHTML(id, response.body.media_id)));
  const v = await visit(1600, 480);
  await v.page.goto(`${h.origin}${route}`); await v.page.locator('html[data-ready=true]').waitFor(); await settle(v.page);
  return { ...v, id, asset, mediaId: response.body.media_id };
}
async function buttons(entry) {
  for (const state of ['default-confirmed','hover','focus','loading','disabled']) {
    const v = await buttonVisit(), p = v.page;
    try {
      const save = p.locator('#specimen-confirmed button');
      const beforeSave = await api('get', `/${v.id}/workspace`);
      await save.click(); await p.getByRole('button',{name:'Salvo',exact:true}).waitFor();
      const saved = await api('get', `/${v.id}/workspace`); assert.equal(saved.version, beforeSave.version + 1);
      const evidence = { state, documentId: v.id, revisionId: saved.draft_revision_id };
      if (state === 'hover') await locator(p,'primary').hover();
      else if (state === 'focus') { await locator(p,'primary').focus(); await p.keyboard.press('Tab'); assert.equal(await locator(p,'secondary').evaluate(n=>n===document.activeElement),true); evidence.focus = await locator(p,'secondary').evaluate(n=>{const s=getComputedStyle(n);return {width:s.outlineWidth,offset:s.outlineOffset,style:s.outlineStyle};}); assert.deepEqual(evidence.focus,{width:'2px',offset:'2px',style:'solid'}); }
      else if (state === 'loading') {
        let release, started; const held = new Promise(r=>{release=r;}), entered = new Promise(r=>{started=r;});
        const endpoint = `/api/pages/${v.id}/media/${v.mediaId}/download`;
        let requests=0; p.on('request',r=>{if(new URL(r.url()).pathname===endpoint)requests++;});
        await v.context.route(`**${endpoint}*`, async route=>{const response=await route.fetch(); assert.equal(response.status(),200); started(); await held; await route.fulfill({response}).catch(()=>{});},{times:1});
        const before = await rectangle(locator(p,'secondary'),'secondary');
        await locator(p,'secondary').click(); await entered;
        assert.equal(await locator(p,'secondary').getAttribute('aria-busy'),'true');
        assert.deepEqual(await rectangle(locator(p,'secondary'),'secondary'),before);
        await locator(p,'secondary').evaluate(n=>{n.click();n.click();}); assert.equal(requests,1);
        await p.mouse.move(1590,470); await p.screenshot({path:join(output,'buttons-loading.png'),caret:'hide'});
        const downloaded=p.waitForEvent('download'); release(); const download=await downloaded; assert.equal(download.suggestedFilename(),'guia.webp');
        evidence.realResponseHeld=true;evidence.requests=requests;evidence.geometry=before;evidence.download=download.suggestedFilename();
      } else if (state === 'disabled') {
        await p.evaluate(()=>specimens.disable(true));
        let actions=0; p.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/pages/'))actions++;});
        const beforeURL=p.url(), before=await api('get',`/${v.id}/workspace`);
        await p.locator('.pages-action-button').evaluateAll(nodes=>nodes.forEach(n=>n.click())); await settle(p);
        assert.equal(actions,0);assert.equal(p.url(),beforeURL);assert.deepEqual(await api('get',`/${v.id}/workspace`),before);
        evidence.requests=actions;evidence.allDisabled=await p.locator('.pages-action-button').evaluateAll(ns=>ns.every(n=>n.getAttribute('aria-disabled')==='true'));assert.equal(evidence.allDisabled,true);
      }
      if (state === 'default-confirmed') {
        await p.mouse.move(1590,470); await p.evaluate(()=>document.activeElement.blur()); await capture(entry,p,v.id);
        // Production upload ACK and video consent focus, after source capture.
        await locator(p,'primary').click();
        assert.equal(await p.locator('#video-target section[id^="section-"]').evaluate(n=>n===document.activeElement),true);
        evidence.sectionFocused=true;
        await p.locator('#file').setInputFiles({name:v.asset.file_name,mimeType:v.asset.mime_type,buffer:v.asset.bytes});
        const uploaded=p.waitForResponse(r=>new URL(r.url()).pathname===`/api/pages/${v.id}/media`&&r.request().method()==='POST');
        await locator(p,'upload').click(); assert.equal((await uploaded).status(),201);
        await p.waitForFunction(()=>document.querySelector('#specimen-upload [role=status]').textContent==='Envio confirmado.');
        await locator(p,'video').click();assert.equal(await p.locator('#video-target [data-pages-video-consent]').evaluate(n=>n===document.activeElement),true);assert.equal(await p.locator('iframe').count(),0);
        evidence.uploadACK=true;evidence.videoConsentFocused=true;
      } else if (state !== 'loading') {
        if(state==='disabled')await p.mouse.move(1590,470);
        await p.screenshot({path:join(output,`buttons-${state}.png`),caret:'hide'});
      }
      buttonStates.push(evidence);
    } finally { await v.context.close(); }
  }
}

try {
  h.app.use(express.static(fileURLToPath(new URL('../../public/',import.meta.url))));
  browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL||'chrome'});
  assert.equal(browser.version(),process.env.PAGES_REFERENCE_BROWSER_VERSION,'Pinned browser version mismatch; explicitly review a new version');
  for(const entry of manifest) {
    if(entry.id==='editable-buttons'){await buttons(entry);continue;}
    // Fresh SQL namespace too: alias reservations from another capture must not
    // change the review URL or leak prior fixture mutations into this state.
    await h.close(); h=await createPagesDatabaseHarness({v3WritesEnabled:true});
    h.app.use(express.static(fileURLToPath(new URL('../../public/',import.meta.url))));
    const document=referenceDocument();document.metadata.audience.job_title_ids=[cargoA];
    if(entry.id==='mobile-content'){
      const intro=document.sections[1].rows[0].columns[0].blocks[0];
      intro.content.content[entry.state.copyOverride.paragraph].content[0].text=entry.state.copyOverride.text;
      intro.content.content[0].content[0].marks.find(m=>m.type==='text_color').attrs.color=entry.state.headingColorOverride;
    }
    const id=await create(document),v=await visit(entry.width,entry.height),p=v.page;
    try {
      await p.goto(`${h.origin}/page-editor.html?id=${id}`);await pagesBrowserReady(p);await p.locator('#page-editor-root[data-save-state=saved]').waitFor();
      const pm=p.locator(`${block(ids.introductionBlock)} .ProseMirror`);await pm.click();
      await pm.press(entry.id==='mobile-content'?'Control+End':'Control+Home');await pm.press(entry.id==='mobile-content'?'ArrowLeft':'ArrowRight');
      if(entry.id==='desktop-style')await p.getByRole('button',{name:'Estilo da página',exact:true}).click();
      if(entry.id==='desktop-insert')await p.getByRole('button',{name:'Inserir bloco',exact:true}).click();
      if(entry.id==='desktop-review'){
        await p.getByRole('button',{name:'Publicar',exact:true}).click();await p.waitForFunction(()=>document.querySelector('.pages-review-checks input')&&!document.querySelector('.pages-review-checks input').disabled);
        assert.equal(await p.getByRole('button',{name:'Publicar página',exact:true}).isDisabled(),true,'Honest source placeholders cannot publish');
      }
      if(entry.id==='mobile-content')await p.getByRole('button',{name:'Conteúdo',exact:true}).click();
      await p.mouse.move(entry.width-10,entry.id==='mobile-content'?120:100);
      await p.evaluate(()=>{window.scrollTo(0,0);document.querySelector('.pages-v2-viewport').scrollTop=0;document.querySelector('.pages-v2-viewport').scrollLeft=0;});
      await capture(entry,p,id);
      assert.deepEqual((await api('get',`/${id}/workspace`)).draft.document,document,'Captures never mutate the source document');
    } finally { await v.context.close(); }
  }
  assert.deepEqual(errors,[]);assert.deepEqual(outbound,[]);
  const provenance={browser:browser.version(),node:process.version,platform:process.platform,deviceScaleFactor:1,sourceDirectory:resolve(process.env.PAGES_REFERENCE_DIR),output,
    decoder:resolve(process.env.PNGJS_MODULE_PATH),decoderSHA256:sha256(await readFile(process.env.PNGJS_MODULE_PATH)),captures,buttonStates,errors,outbound,
    limits:['Synthetic Firebase and serialized disposable PGlite only','Native PG16/concurrency/restore, Nginx, physical keyboard/IME/touch/zoom pending','Source wordmark glyph and canonical purple/source gray remain differences','No user acceptance; no production deployment']};
  await writeFile(join(output,'captures.json'),JSON.stringify(provenance,null,2));
  const results=await compareCaptures({manifest,sourceDirectory:process.env.PAGES_REFERENCE_DIR,output,captures,PNG});
  await writeFile(join(output,'results.json'),JSON.stringify(results,null,2));
  const artifacts=[];
  async function index(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await index(path);else artifacts.push({path,sha256:sha256(await readFile(path))});}}
  await index(output);
  const textContractPath=join(root,'tests/visual/pages-reference-text.mjs');
  await writeFile(join(output,'artifacts.json'),JSON.stringify({sources:results.results.map(r=>r.source),manifest:{path:join(root,'tests/fixtures/pages-reference/manifest.json'),sha256:sha256(await readFile(join(root,'tests/fixtures/pages-reference/manifest.json')))},textContract:{path:textContractPath,sha256:sha256(await readFile(textContractPath))},artifacts},null,2));
  console.log(JSON.stringify({status:results.status,output,boards:results.results.map(r=>({id:r.id,geometryFailures:r.regions.filter(x=>!x.geometry.pass).map(x=>x.id),anchorFailures:r.anchors.failures,gapFailures:r.gaps.measurements.filter(g=>!g.pass),textFailures:r.textChecks.filter(x=>!x.pass),pixelReview:r.regions.filter(x=>x.pixels.changed>0).length})),buttonStates},null,2));
  if(!results.pass)process.exitCode=1;
} catch(error) {
  await writeFile(join(output,'failure.json'),JSON.stringify({error:error.stack,captures,buttonStates,errors,outbound},null,2));
  for(const [i,p]of(browser?.contexts().flatMap(c=>c.pages())||[]).entries())if(!p.isClosed())await p.screenshot({path:join(output,`failure-${i}.png`)}).catch(()=>{});
  throw error;
} finally {await browser?.close();await h.close();}
