// Task-owned Chrome, production renderer/private API, serialized PGlite.
// No real Firebase, remote players, existing services or native infrastructure.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPagesDatabaseHarness, pageDocument, cargoA } from '../database/check-pages.mjs';
import { featureDocument, referenceDocument, referenceIds, referenceMedia } from '../helpers/pages-reference-document.mjs';
import { createPagesMediaFixtures } from '../helpers/pages-media-fixtures.mjs';
import { pagesBrowserContext, pagesBrowserReady } from '../helpers/pages-browser.mjs';
for (const key of ['PGLITE_MODULE_PATH','PLAYWRIGHT_MODULE_PATH','AXE_MODULE_PATH','FFMPEG_PATH','FFPROBE_PATH']) if (!process.env[key]) throw new Error(`Set external ${key}`);
const { chromium } = await import(pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href);
const { default: AxeBuilder } = await import(pathToFileURL(resolve(process.env.AXE_MODULE_PATH)).href);
const require = createRequire(new URL('../../api/package.json', import.meta.url)), express = require('express');
const { resolveAppearance, appearanceIssues } = require('./pages/appearance');
const publicRoot = fileURLToPath(new URL('../../public/', import.meta.url));
const output = resolve(process.env.RENDERER_V3_VISUAL_OUTPUT || join(tmpdir(), 'opencode', 'pages-renderer-v3'));
await mkdir(output, { recursive: true });
const h = await createPagesDatabaseHarness({ v3WritesEnabled: true });
let browser, media;
const results = [], errors = [], blocked = [], youtube = [];
const strictReferenceTypography = process.argv.includes('--strict-reference-typography');
const prose = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const allBlocks = doc => doc.sections.flatMap(s => s.rows.flatMap(r => r.columns.flatMap(c => c.blocks)));
async function api(method, path, body, actor = 'author') {
  const r = await h.api(method, path, body, actor);
  assert.ok(r.status >= 200 && r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`); return r.body;
}
async function create(document) {
  const { id } = await api('post', '', { template_id: 'comunicado', client_mutation_id: randomUUID() });
  if (document) await save(id, document);
  return id;
}
async function save(id, document) {
  const w = await api('get', `/${id}/workspace`);
  await api('put', `/${id}/draft`, { expected_version: w.version, document, client_mutation_id: randomUUID() });
  return api('get', `/${id}/workspace`);
}
async function publish(id) {
  const w = await api('get', `/${id}/workspace`);
  await api('post', `/${id}/publish`, { expected_version: w.version, revision_id: w.draft_revision_id, client_mutation_id: randomUUID() }, 'publisher'); return w;
}
async function upload(id, kind) {
  let r = h.request.post(`/api/pages/${id}/media`).set('Authorization', 'Bearer author').field('client_mutation_id', randomUUID());
  if (kind === 'image') { const image = referenceMedia()[0]; r = r.attach('image', image.bytes, image.file_name); }
  else r = r.field('kind', kind).attach('file', media.files[kind === 'gif' ? 'synthetic.gif' : 'synthetic.mp3'].path);
  const response = await r; assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.media_id;
}
async function visit(path, uid = 'author') {
  const visit = await pagesBrowserContext(browser, { uid, width: 1600, errors });
  visit.youtubeAllowed = false; visit.youtube = [];
  await visit.context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === h.origin || url.hostname === 'www.gstatic.com') return route.fallback();
    if (url.hostname === 'www.youtube-nocookie.com') {
      const record = { url: url.href, afterConsent: visit.youtubeAllowed }; youtube.push(record); visit.youtube.push(record);
      if (!visit.youtubeAllowed) { blocked.push(url.href); return route.abort('blockedbyclient'); }
      // Local stub only AFTER informed click. Never contact or claim live player.
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="pt-BR"><title>Player sintético</title><body>Player interceptado, sem reprodução</body></html>' });
    }
    blocked.push(url.href); return route.abort('blockedbyclient');
  });
  await visit.page.goto(h.origin + path); return visit;
}
const rgb = hex => `rgb(${[1,3,5].map(n => parseInt(hex.slice(n,n+2),16)).join(', ')})`;
async function pair(locator) { return locator.evaluate(n => { const s = getComputedStyle(n); return { foreground: s.color, background: s.backgroundColor, size: s.fontSize, weight: s.fontWeight }; }); }
async function ready(page) { await page.locator('html[data-renderer-ready=true]').waitFor(); await page.evaluate(() => document.fonts.ready); }
async function frames(page) { await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); }
try {
  media = await createPagesMediaFixtures();
  const id = await create(), imageA = await upload(id, 'image'), imageB = await upload(id, 'image'), gifId = await upload(id, 'gif'), audioId = await upload(id, 'audio');
  const doc = featureDocument(); doc.metadata.title = 'Renderer v3 sintético'; doc.metadata.audience.job_title_ids = [cargoA];
  const blocks = allBlocks(doc), gallery = blocks.find(b => b.type === 'gallery');
  Object.assign(blocks.find(b => b.type === 'image'), { media_id: imageA, alt: 'Imagem sintética', caption: 'Imagem privada', credit: 'Fixture' });
  Object.assign(gallery, { style: { font: 'manrope', scale: 'large', align: 'start', palette: 'brand' }, appearance: { foreground: '#214B39' }, items: [
    { id: randomUUID(), kind: 'image', media_id: imageA, alt: 'Primeira', caption: 'Legenda da galeria', credit: 'Fixture A' },
    { id: randomUUID(), kind: 'gif', media_id: gifId, alt: 'Animação sintética', caption: 'GIF privado', credit: 'Fixture GIF' },
    { id: randomUUID(), kind: 'image', media_id: imageB, alt: 'Última', caption: '', credit: '' },
  ] });
  const audio = blocks.find(b => b.type === 'audio'); audio.media_id = audioId; audio.transcript = 'Áudio sintético de teste.';
  const faq = blocks.find(b => b.type === 'faq'); faq.items.forEach((item, i) => { item.answer = prose(`Resposta sintética ${i + 1}.`); });
  const embed = { id: randomUUID(), type: 'video_embed', provider: 'youtube', video_id: 'dQw4w9WgXcQ', title: 'Vídeo sintético', transcript: 'Transcrição sintética, sem reprodução ao vivo.' };
  const rich = { id: randomUUID(), type: 'rich_text', appearance: { background: '#FFFFFF', foreground: '#000000', scale: 'standard', icon: 'shirt' }, tags: ['Local'], content: prose('Marca segura') };
  rich.content.content[0].content[0].marks = [{ type: 'text_color', attrs: { color: '#123456' } }, { type: 'highlight', attrs: { color: '#EEEEEE' } }, { type: 'link', attrs: { href: '/profile.html' } }];
  rich.content.content[0].content.push({type:'text',text:' Link herdado',marks:[{type:'link',attrs:{href:'/profile.html'}}]});
  rich.content.content.push({type:'heading',attrs:{level:2},content:[{type:'text',text:'Título padrão 20px'}]});
  const column = doc.sections[0].rows[0].columns[0];
  column.blocks.push(rich, embed, { id: randomUUID(), type: 'button', label: 'Focar vídeo externo', preset: 'secondary', action: { type: 'video', value: embed.id } },
    { id: randomUUID(), type: 'callout', tone: 'attention', icon: 'alert', content: prose('Par interno canônico'), appearance: { foreground: '#123456', background: '#FFFFFF' } });
  // A generic empty section unrelated to the source fixture, not test-only CSS.
  const empty = { id: randomUUID(), label: 'Âncora vazia', rows: [{ id: randomUUID(), layout: 'single', columns: [{ id: randomUUID(), blocks: [] }] }] };
  doc.sections.splice(1, 0, empty);
  const workspace = await save(id, doc); await publish(id);
  assert.deepEqual(appearanceIssues(doc), []);
  const reference = referenceDocument(); reference.metadata.audience.job_title_ids = [cargoA]; const referenceId = await create(reference);
  const editing = structuredClone(reference);editing.metadata.title='Layout v3 em edição';
  const editingColumn=editing.sections.at(-1).rows[0].columns[0];editingColumn.blocks=[{id:randomUUID(),type:'rich_text',content:prose('Coluna principal de edição')}];
  // The editor's new marks are Task 13, not silently introduced by this renderer
  // check. This separate known-block fixture tests only actual editing geometry.
  function legacyMarks(node){if(node.marks)node.marks=node.marks.filter(m=>!['text_color','highlight'].includes(m.type));(node.content||[]).forEach(legacyMarks);}
  allBlocks(editing).forEach(block=>{if(block.content)legacyMarks(block.content);});
  const editingId=await create(editing);
  const legacyIds = [];
  const emptyV1=pageDocument('Âncora v1 vazia');emptyV1.sections[0].rows[0].columns[0].blocks=[];const emptyV1Id=await create(emptyV1);
  for (const version of [1,2]) {
    const legacy = pageDocument(`Legado v${version}`); legacy.schema_version = version; legacy.template.version = version;
    if (version === 2) legacy.sections.push({ ...structuredClone(empty), id: randomUUID(), rows: [{ id: randomUUID(), layout: 'single', columns: [{ id: randomUUID(), blocks: [] }] }] });
    const legacyId = await create(legacy), legacyMedia = await upload(legacyId, 'image');
    const col = legacy.sections[0].rows[0].columns[0]; col.blocks.push({ id: randomUUID(), type: 'image', media_id: legacyMedia, alt: 'Legado', caption: 'Legenda antiga', credit: 'Crédito antigo' });
    if (version === 2) { col.blocks[1].style = { palette: 'brand', scale: 'large', font: 'manrope', align: 'start' }; col.blocks.push({ id: randomUUID(), type: 'button', label: 'Legado', preset: 'primary', destination: { type: 'section', value: legacy.sections[0].id } }); }
    await save(legacyId, legacy); await publish(legacyId); legacyIds.push(legacyId);
  }
  h.app.get('/__renderer-v3', (_req,res) => res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Renderer sintético</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/pages.css"><style>*{box-sizing:border-box}body{margin:0;font-family:var(--font-sans)}#reader{width:1044px;max-width:100%}.lifecycle{width:1044px;max-width:100%}</style></head><body class="pages-page"><main><div id="reader" class="pages-preview-frame"></div><div id="lifecycle" class="lifecycle"></div></main><script type="module">
    import {createPagesAPI} from '/pages/api.js';
    import {createPageLifecycle} from '/js/page-lifecycle.js';
    import {renderDocument,richNode,imageFigure,mediaFigure,applyBlockStyle} from '/pages/renderer.js';
    import {renderV3Block} from '/pages/render-blocks-v3.js';
    const page=createPageLifecycle(),api=createPagesAPI(page),params=new URL(location.href).searchParams,id=params.get('id');
    const w=await api.workspace(id),doc=w.draft.document,mode=params.get('mode'),opts={api,pageId:id,document:doc,staged:mode!=='revision',revisionId:mode==='revision'?w.draft_revision_id:undefined,signal:page.signal};
    const cleanup=renderDocument({host:document.getElementById('reader'),...opts}); page.cleanup(cleanup);
    let gallery,figure;
    const fixture={doc,dispose:()=>page.dispose(),defaults(value){Object.assign(doc.presentation.defaults,value);cleanup();page.cleanup(renderDocument({host:document.getElementById('reader'),...opts}));},async gallery(){
      gallery=structuredClone(doc.sections.flatMap(s=>s.rows.flatMap(r=>r.columns.flatMap(c=>c.blocks))).find(b=>b.type==='gallery'));
      const host=document.getElementById('lifecycle');host.classList.add('pages-document');host.dataset.schemaVersion='3';
      const wrapper=document.createElement('div');wrapper.className='pages-rendered-block';applyBlockStyle(wrapper,gallery,doc);
      figure=renderV3Block(gallery,{...opts,richNode,imageFigure,mediaFigure,resolveBlock:()=>gallery});wrapper.append(figure.node);host.replaceChildren(wrapper);page.cleanup(figure.dispose);
    },reorder(){gallery.items.reverse();figure.refresh();},replace(){gallery.items[0].media_id=${JSON.stringify(imageA)};figure.refresh();},remove(){gallery.items=[];figure.refresh();},galleryDispose(){figure.dispose();},captionLegacy(){delete gallery.appearance;figure.refresh();},get galleryNode(){return figure.node;}};
    globalThis.fixture=fixture;document.documentElement.dataset.rendererReady='true';
  </script></body></html>`));
  // Same shell route simulation as the existing friendly URL check, not Nginx.
  h.app.get(/^\/conteudos\/[a-z0-9]+(-[a-z0-9]+)*$/, (_req,res) => res.sendFile(join(publicRoot, 'pages.html')));
  h.app.use(express.static(publicRoot));
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || 'chrome' });
  {
    const v = await visit(`/conteudos/${workspace.slug}`, 'reader'), { page } = v;
    await pagesBrowserReady(page); await page.locator('.pages-document h1').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.pages-v3-gallery img:not([hidden])')].every(n => n.complete && n.naturalWidth > 0));
    assert.equal(v.youtube.length, 0, 'ZERO YouTube requests before consent'); assert.equal(await page.locator('iframe').count(), 0);
    assert.equal(await page.locator('link[rel=preconnect][href*=youtube],img[src*=youtube]').count(), 0);
    await page.getByRole('button', { name: 'Focar vídeo externo', exact: true }).click();
    assert.equal(await page.locator('[data-pages-video-consent]').evaluate(n => document.activeElement === n), true);
    assert.equal(v.youtube.length, 0, 'video action only focuses consent, never creates player');
    const faqDetails = page.locator('.pages-v3-faq > details');
    await faqDetails.nth(0).locator('summary').focus(); await page.keyboard.press('Enter');
    await faqDetails.nth(1).locator('summary').focus(); await page.keyboard.press('Space');
    assert.deepEqual(await faqDetails.evaluateAll(nodes => nodes.map(n => n.open)), [true,true]);
    assert.deepEqual((await api('get', `/${id}`, undefined, 'reader')).document, doc, 'native expansion never persisted');
    const checked = resolveAppearance(doc, gallery, 'caption'), caption = await pair(page.locator('.pages-v3-gallery figcaption').first());
    assert.deepEqual(caption, { foreground: rgb(checked.foreground), background: rgb(checked.background), size: '14px', weight: '400' });
    const imagePair = await pair(page.locator(`[data-block-id="${referenceIds.imageBlock}"] figcaption`));
    assert.equal(imagePair.foreground, rgb(doc.presentation.defaults.foreground));
    const marked = page.locator(`[data-block-id="${rich.id}"] [data-pages-rich-run]`);
    assert.equal((await pair(marked)).background, rgb('#EEEEEE')); assert.equal((await pair(marked.locator('a'))).foreground, rgb('#123456'));
    assert.equal((await pair(page.locator(`[data-block-id="${rich.id}"] a`).last())).foreground,rgb(resolveAppearance(doc,rich,'link').foreground));
    assert.equal((await pair(page.locator(`[data-block-id="${rich.id}"] .pages-block-icon`))).foreground,rgb(resolveAppearance(doc,rich).accent));
    const callout = column.blocks.find(b => b.type === 'callout'), inner = await pair(page.locator('.pages-callout'));
    assert.equal(inner.foreground, rgb(resolveAppearance(doc, callout).foreground)); assert.equal(inner.background, rgb(resolveAppearance(doc, callout).background));
    if (strictReferenceTypography) assert.equal((await pair(page.locator('.pages-document > header h1'))).size, '32px');
    else {
      const expectedTitleSize = doc.template.id === 'guia-interno' ? '14px' : '32px';
      assert.equal((await pair(page.locator('.pages-document > header h1'))).size, expectedTitleSize, 'canonical guide metadata is distinct from its 36px cover');
      if (expectedTitleSize !== '32px') results.push({ intentionalDifference: 'guide metadata heading 14px, historical generic assertion 32px retained with --strict-reference-typography' });
    }
    const audioNode = page.locator('audio'); assert.equal(await audioNode.getAttribute('src'), null); assert.equal(await audioNode.evaluate(n => n.autoplay), false);
    const galleryGif = page.locator('.pages-v3-gallery .pages-private-media'); assert.equal(await galleryGif.locator('img').getAttribute('src'), null);
    await galleryGif.getByRole('button', { name: 'Iniciar animação', exact: true }).click();
    await galleryGif.locator('img').waitFor({ state: 'visible' }); assert.match(await galleryGif.locator('img').getAttribute('src'), /^blob:/);
    await galleryGif.getByRole('button', { name: 'Parar animação', exact: true }).click(); assert.equal(await galleryGif.locator('img').getAttribute('src'), null);
    const audit = await new AxeBuilder({ page }).include('.pages-document').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    assert.deepEqual(audit.violations.map(v => ({ id:v.id,nodes:v.nodes.map(n=>n.target) })), []);
    const sectionLink = page.getByRole('link', { name: 'Ver guia completo', exact: true }); await sectionLink.click();
    assert.equal((await pair(sectionLink.locator('..'))).background,rgb(doc.presentation.defaults.background),'button preset must not turn its outer wrapper into a full-width color stripe');
    assert.equal(new URL(page.url()).pathname, `/conteudos/${workspace.slug}`); assert.equal(new URL(page.url()).hash, `#section-${referenceIds.orientationsSection}`);
    v.youtubeAllowed = true; const playerRequest=page.waitForEvent('requestfinished', { predicate:r => new URL(r.url()).hostname === 'www.youtube-nocookie.com' });
    await page.locator('[data-pages-video-consent]').click(); await page.locator('iframe').waitFor(); await playerRequest;
    assert.equal(v.youtube.length, 1); assert.equal(v.youtube[0].afterConsent, true); assert.doesNotMatch(v.youtube[0].url, /autoplay=1/);
    await page.locator('[data-pages-video-unload]').click(); assert.equal(await page.locator('iframe').count(), 0);
    await page.screenshot({ path: join(output,'reader-desktop.png'), fullPage:true });
    results.push({ scenario:'published friendly shell, independent keyboard FAQ, real private image/GIF, canonical computed pairs and marks, action focuses consent, ZERO pre-click YouTube / one post-click local stub', pass:true });
    await v.context.close();
  }
  for (const mode of ['staged','revision']) {
    const v = await visit(`/__renderer-v3?id=${id}&mode=${mode}`), {page} = v; await ready(page);
    const original = await page.locator('#reader article').evaluate(n => n.outerHTML.replace(/blob:[^"]+/g,'blob:asset'));
    for (const width of [1044,390,180]) {
      await page.locator('#reader').evaluate((n,width) => { n.style.width=width+'px'; }, width); await frames(page);
      const geometry = await page.locator('#reader .pages-row-aside_right').evaluate(n => { const r=n.children[1].getBoundingClientRect(),l=n.children[0].getBoundingClientRect(),surface=n.closest('.pages-document');return {right:r.width,gap:r.x-l.right,stacked:r.y>=l.bottom,overflow:document.documentElement.scrollWidth>innerWidth,localOverflow:surface.scrollWidth>surface.clientWidth}; });
      if (width === 1044) { assert.equal(geometry.right,260); assert.equal(geometry.gap,20); }
      else assert.equal(geometry.stacked,true,`${mode} ${width}: surface stacking despite desktop viewport`);
      assert.equal(geometry.overflow,false);
      assert.equal(geometry.localOverflow,false,`${mode} ${width}: no overflow inside the narrow surface`);
      assert.equal(await page.locator('#reader .pages-row-two_equal').evaluate(n => n.children[1].getBoundingClientRect().y >= n.children[0].getBoundingClientRect().bottom), width !== 1044);
      assert.equal(await page.locator(`#section-${empty.id}`).evaluate(n => n.getBoundingClientRect().height),0);
      await page.screenshot({path:join(output,`${mode}-${width}.png`),fullPage:true});
    }
    await page.getByRole('link',{name:'Ver guia completo',exact:true}).click();assert.equal(new URL(page.url()).hash,'');
    assert.equal(v.youtube.length,0); assert.ok(original.includes('pages-v3-gallery')); assert.ok(original.includes('pages-v3-faq'));
    await page.evaluate(()=>fixture.defaults({scale:'large',font:'oswald',foreground:'#112233',background:'#FFFFFF'}));
    assert.equal((await pair(page.locator(`#reader [data-block-id="${rich.id}"] h2`))).size,'20px','explicit standard block must not inherit ancestor large heading rule');
    if (strictReferenceTypography) {
      assert.equal((await pair(page.locator('#reader header h1'))).size,'32px');assert.equal((await pair(page.locator('#reader header .pages-summary'))).size,'16px');
    } else {
      assert.equal((await pair(page.locator('#reader header h1'))).size,doc.template.id==='guia-interno'?'14px':'32px');
      assert.equal((await pair(page.locator('#reader header .pages-summary'))).size,doc.template.id==='guia-interno'?'12px':'16px');
    }
    assert.equal((await pair(page.locator('#reader header'))).foreground,rgb('#112233'));
    await page.evaluate(()=>fixture.dispose()); assert.equal(await page.evaluate(()=>globalThis.__pagesObjectURLs.size),0);
    results.push({scenario:`same shared DOM ${mode}, 260px/gap20 desktop, 390/180 surface stacking, zero empty anchor height, preview section focus/no history, disposal`,pass:true}); await v.context.close();
  }
  {
    const v=await visit(`/page-editor.html?id=${editingId}`),{page}=v;await pagesBrowserReady(page);await page.locator('.pages-editor-row .pages-row-aside_right').waitFor();
    const surface=page.locator('.pages-edit-surface');
    for(const width of [900,390,180]){
      if(strictReferenceTypography) await surface.evaluate((n,w)=>{n.style.width=w+'px';n.style.maxWidth='none';},width);
      else await page.locator('.pages-v2-viewport').evaluate((n,w)=>{n.style.width=w+'px';},width);
      await frames(page);
      if(!strictReferenceTypography)assert.equal(await surface.evaluate(n=>n.clientWidth),width,'resize the authoritative viewport; its observer owns surface width');
      const layout=await page.locator('.pages-editor-row .pages-row-aside_right').evaluate(n=>{const a=n.children[0].getBoundingClientRect(),b=n.children[1].getBoundingClientRect();return{right:b.width,gap:b.left-a.right,stacked:b.top>=a.bottom};});
      if(width===900){assert.equal(layout.right,260);assert.equal(layout.gap,20);}else assert.equal(layout.stacked,true);
    }
    await v.context.close();results.push({scenario:'actual existing editor known-block v3 aside_right grid: 260/gap20 and surface-only 390/180 stacking; no new authoring UI',pass:true});
  }
  {
    const v=await visit(`/__renderer-v3?id=${referenceId}`),{page}=v;await ready(page);
    assert.equal(await page.locator(`#section-${referenceIds.gallerySection}`).evaluate(n=>n.getBoundingClientRect().height),0);
    assert.equal(await page.locator('[data-pages-placeholder]').count(),1,'honest audio placeholder only; no invented upload/gallery');
    await page.evaluate(()=>fixture.dispose());await v.context.close();results.push({scenario:'exact reference draft keeps empty gallery anchor and honest null audio; no invented content',pass:true});
  }
  {
    const v=await visit(`/__renderer-v3?id=${id}`),{page,context}=v;await ready(page);
    await page.waitForFunction(()=>[...document.querySelectorAll('#reader img:not([hidden])')].every(n=>n.complete&&n.naturalWidth));
    await page.evaluate(()=>fixture.gallery());await page.waitForFunction(()=>[...fixture.galleryNode.querySelectorAll('img:not([hidden])')].every(n=>n.complete&&n.naturalWidth));
    await page.evaluate(()=>{globalThis.originalGalleryNodes=[...fixture.galleryNode.children];fixture.reorder();});
    assert.equal(await page.evaluate(()=>[...fixture.galleryNode.children].every((n,i)=>n===originalGalleryNodes[2-i])),true);
    await page.evaluate(()=>fixture.captionLegacy());
    const caption = await pair(page.locator('#lifecycle figcaption').filter({hasText:'Legenda da galeria'}));
    assert.equal(caption.foreground,rgb('#6C706D')); assert.equal(caption.background,rgb('#E8F1E9'));assert.equal(caption.size,'14px');
    const invalid=structuredClone(doc);delete allBlocks(invalid).find(b=>b.type==='gallery').appearance;
    assert.ok(appearanceIssues(invalid).some(i=>i.path.includes('.caption')&&i.ratio<4.5),'computed legacy pair matches actual API AA failure, no silent recolor');
    // Hold real authorized bytes, then remove the gallery while its private GET is pending.
    let release,entered;const held=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
    await context.route(`**/api/pages/${id}/media/${imageA}*`,async route=>{const response=await route.fetch();entered();await held;await route.fulfill({response}).catch(()=>{});},{times:1});
    await page.evaluate(()=>fixture.replace());await started;await page.evaluate(()=>fixture.remove());release();await frames(page);
    assert.equal(await page.locator('#lifecycle img').count(),0);
    await page.evaluate(()=>{fixture.galleryDispose();fixture.dispose();});assert.equal(await page.evaluate(()=>globalThis.__pagesObjectURLs.size),0);
    results.push({scenario:'actual gallery keyed reorder, computed legacy caption 4.355695 AA fail, real held private response remove/dispose with no blobs',pass:true});await context.close();
  }
  for (const [index,id] of legacyIds.entries()) {
    const v=await visit(`/__renderer-v3?id=${id}`),{page}=v;await ready(page);
    assert.equal(await page.locator('#reader article').getAttribute('data-schema-version'),null);
    assert.equal(await page.locator('#reader [data-pages-rich-run],#reader .pages-block-icon').count(),0);
    const old=await pair(page.locator('#reader figcaption'));assert.deepEqual(old,{foreground:rgb('#6C706D'),background:'rgba(0, 0, 0, 0)',size:'14px',weight:'400'});
    if(index===1){assert.equal((await pair(page.locator('#reader .pages-rendered-block').nth(1))).background,rgb('#E8F1E9'));assert.equal(await page.locator('[data-legacy=true]').count(),1);assert.equal(await page.locator('[data-legacy=true] svg').count(),0);}
    if(index===1){const sections=await page.locator('#reader article > section').all();assert.equal(await sections.at(-1).evaluate(n=>n.getBoundingClientRect().height),0);}
    await page.evaluate(()=>fixture.dispose());
    if(index===0){await page.goto(`${h.origin}/__renderer-v3?id=${emptyV1Id}`);await ready(page);assert.equal(await page.locator('#reader article > section').evaluate(n=>n.getBoundingClientRect().height),0);await page.evaluate(()=>fixture.dispose());}
    await v.context.close();results.push({scenario:`v${index+1} unchanged legacy DOM markers/palette/caption and generic zero-height empty section`,pass:true});
  }
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);assert.ok(youtube.every(r=>r.afterConsent));
  await writeFile(join(output,'results.json'),JSON.stringify({results,errors,blocked,youtube,evidence:'Production renderer + private HTTP/API/files/serialized PGlite; synthetic Firebase. YouTube post-click local stub only, zero pre-click requests. Native PostgreSQL/Nginx/Firebase and final workspace visual acceptance PENDING.'},null,2));
  console.log(`Pages renderer v3 PASS: ${results.length} Chrome scenarios; ZERO pre-click YouTube, ${youtube.length} post-click local stub; zero JS errors/outbound access; artifacts: ${output}`);
} catch(error) {
  await writeFile(join(output,'failure.json'),JSON.stringify({results,errors,blocked,youtube,error:error.stack},null,2));
  for(const [index,page] of (browser?.contexts().flatMap(c=>c.pages())||[]).entries())if(!page.isClosed())await page.screenshot({path:join(output,`failure-${index}.png`),fullPage:true}).catch(()=>{});
  throw error;
} finally {await browser?.close();await media?.close();await h.close();}
