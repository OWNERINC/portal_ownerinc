import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { FixtureNode, TestEvent, deferred, drain } from '../helpers/frontend-feedback-harness.mjs';

const require = createRequire(import.meta.url);
const { createTemplate } = require('../../api/pages/templates');
const { validateDocument } = require('../../api/pages/validation');
import { upgradeDocument } from '../../public/pages/document-v3.js';
import { resolveAppearance } from '../../public/pages/appearance.js';

// Execute the real editor, model, state, DOM helpers and lifecycle. Only the
// browser rendering engine (PM/media) and network are controlled seams.
async function harness(t, { dialogs, support, document: initialDocument, mobile = false, registered = [] } = {}) {
  const doc = new FixtureNode('document'); doc.ownerDocument = doc; doc.documentElement = doc;
  doc.createElement = tag => new FixtureNode(tag, doc);
  doc.createElementNS = (_, tag) => doc.createElement(tag);
  doc.createDocumentFragment = () => doc.createElement('fragment');
  doc.createTextNode = text => { const node = doc.createElement('#text'); node.textContent = text; return node; };
  doc.getElementById = id => doc.querySelector(`#${id}`);
  doc.body = doc.createElement('body'); doc.append(doc.body); doc.activeElement = doc.body;
  const root = doc.createElement('div'); root.setAttribute('id', 'page-editor-root'); doc.body.append(root);
  const window = new FixtureNode('window', doc); window.confirm = () => false;
  const media = [];
  window.innerHeight = 820;
  window.matchMedia = query => { const match = new FixtureNode('media',doc); match.matches=mobile; match.media=query; media.push(match); return match; };
  window.visualViewport = new FixtureNode('viewport',doc); window.visualViewport.height=820; window.visualViewport.offsetTop=0;
  let location = new URL('https://portal.test/page-editor.html?id=first');
  const workspaces = [], uploads = [], editors = [], figures = [], sortables = [];
  const api = {
    async workspace(id) { workspaces.push(id); return { id, version: 0, draft_revision_id: `revision-${id}`, published_revision_id: null,
      draft: { document: initialDocument ? structuredClone(initialDocument) : createTemplate() }, media:structuredClone(registered), document_support: support, capabilities: { edit: true, publish: true, archive: true } }; },
    async cargos() { return []; },
    async templates() { return []; },
    upload(id, file, key) { const pending = { id, file, key, ...deferred() }; uploads.push(pending); return pending.promise; },
  };
  const context = vm.createContext({ document: doc, window, URL, URLSearchParams, TextEncoder, queueMicrotask, crypto: { randomUUID }, console,
    AbortController, DOMException, setTimeout, clearTimeout, cancelAnimationFrame() {}, createPagesAPI: () => api,
    createSortable: (host, options) => { const sortable = { host, options, destroy() {} }; sortables.push(sortable); return sortable; }, applyBlockStyle() {}, richNode() {},
    createRichEditor({ content, blockId, itemId, onChange, onFocus, onSelection, isLayoutDragging, historyCommands }) {
      const editor = { content, itemId, historyCommands, bookmark: () => ({blockId,...(itemId ? {itemId} : {}),from:1,to:1}), sync(content) { this.content = content; }, destroyed: 0, destroy() { this.destroyed++; }, onChange, onFocus, onSelection, isLayoutDragging, marks: new Set(), active(mark) { return this.marks.has(mark); }, focus() {} }; editors.push(editor); return editor;
    },
    imageFigure() { const figure = { node: doc.createElement('figure'), destroyed: 0, dispose() { figure.destroyed++; } }; figures.push(figure); return figure; },
    mediaFigure(block, options) { const figure = { node: doc.createElement('figure'), block, options, refreshed: 0, destroyed: 0, refresh() { figure.refreshed++; }, dispose() { figure.destroyed++; } }; figures.push(figure); return figure; },
    renderDocument: () => () => {}, openPagesDialog(options) { if (dialogs) { dialogs.push(options); return {}; } assert.fail('This test does not open dialogs'); },
  });
  async function load(file, names, transform = source => source) {
    const source = transform((await readFile(file, 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, ''));
    vm.runInContext(`(() => { ${source}\nObject.assign(globalThis, { ${names} }); })();`, context, { filename: file });
  }
  await load('public/js/page-lifecycle.js', 'createPageLifecycle');
  await load('public/pages/appearance.js', 'normalizeHex, resolveAppearance, appearanceIssues, typographyMetrics', source => source.replace(/^export \{[^\n]+\};/gm, ''));
  await load('public/pages/model.js', 'clone, newId, allBlocks, blockList, textBlock, publicationIssues, safeLink');
  await load('public/pages/drag-guard.js', 'compositionDropGuard');
  await load('public/pages/composition.js', 'compose, findBlock, findColumn, columns, genericBlock, defaultStyle, adjacentMove, insertAt, insertColumns, reorderSection, setBlockWidth, cloneBlock');
  await load('public/pages/document-v3.js', 'upgradeDocument, editV3, parseYouTubeURL');
  await load('public/pages/history.js', 'createDraftHistory');
  await load('public/pages/dom.js', 'el, button, link, field, errorText, showError');
  await load('public/pages/state.js', 'createEditorState');
  await load('public/pages/dialog.js', 'mountPagesDialog');
  await load('public/pages/editor-review.js', 'openReview, reviewSession');
  await load('public/pages/editor-panels.js', 'openEditorPanel, watchVisualViewport, visibleFocusTarget, restoreVisibleFocus');
  await load('public/pages/editor-menus.js', 'createEditorMenus');
  await load('public/pages/editor-workspace.js', 'createEditorWorkspace, createModelDraftController, editorAction, editorIcon');
  await load('public/pages/button.js', 'createPageButton');
  await load('public/pages/editor-insert.js', 'openInsertPanel, insertionPoint, resolveInsertionPoint');
  await load('public/pages/editor-media.js', 'createBlockFields, mediaAccept, mediaKind');
  await load('public/pages/editor-destinations.js', 'createDestinationFields, destinationCandidate, registeredMedia');
  await load('public/pages/editor-style.js', 'openStylePanel, createInspector, openInlineColorPanel, styleCandidate');
  context.renderV3Block = () => ({ node: doc.createElement('div'), refresh() {}, dispose() {} });
  context.v3Icon = () => null;
  await load('public/pages/editor.js', 'mountPageEditor', source => source.replace('  void load();\n}',
    '  globalThis.inspectEditor = () => ({ state, uploadRetry, loadSequence, documentURL, renderBlocks });\n  globalThis.reloadEditor = load;\n  void load();\n}'));
  const page = context.createPageLifecycle({ user: { uid: 'author' } });
  Object.defineProperty(page, 'location', { get: () => location });
  context.mountPageEditor(page); await drain(); t.after(() => page.dispose());
  assert.ok(root.querySelector('.pages-metadata-title'),root.textContent);
  return { page, root, window, media, api, workspaces, uploads, editors, figures, sortables, compositionDropGuard: context.compositionDropGuard,
    get state() { return context.inspectEditor().state; },
    get retry() { return context.inspectEditor().uploadRetry; },
    reconcile() { context.inspectEditor().renderBlocks(); },
    async pop(url) { location = new URL(url, location); window.dispatchEvent(new TestEvent('popstate', { state: null })); await drain(); },
    async replaceWithoutGuard(url) { location = new URL(url, location); await context.reloadEditor(); await drain(); },
    async upload(type = 'image/png') {
      const input = root.querySelector('input[type="file"]');
      input.files = [{ type, size: 100, name: 'synthetic.mp4' }]; input.dispatchEvent(new TestEvent('change')); await drain();
      return uploads.at(-1);
    },
  };
}

test('button download/video form stages, validates, upgrades in one undo and retires old-visit controls', async t => {
  const document=createTemplate('owner-news'), media={id:randomUUID(),kind:'image'};
  const h=await harness(t,{document,registered:[media],support:{read_versions:[1,2,3],write_versions:[1,2,3]}});
  const buttons=()=>h.state.document.sections.flatMap(s=>s.rows.flatMap(r=>r.columns.flatMap(c=>c.blocks))).filter(b=>b.type==='button');
  const id=buttons()[0].id;
  h.root.querySelector(`[data-block-id="${id}"]`).querySelector('.pages-select-block').click();
  const control=name=>h.root.querySelectorAll('select,input').find(n=>n.getAttribute('aria-label')===name);
  const change=(name,value)=>{const n=control(name);assert.ok(n,name);n.value=value;n.dispatchEvent(new TestEvent('change'));return n;};
  const apply=()=>h.root.querySelectorAll('button').find(n=>n.textContent==='Aplicar destino');
  const before=JSON.stringify(h.state.document);
  const retired=change('Tipo de destino','download'), retiredApply=apply();
  assert.equal(JSON.stringify(h.state.document),before); assert.equal(h.state.canUndo,false);
  change('Arquivo da página',media.id); change('Nome do arquivo para download','../bad.webp'); apply().click();
  assert.equal(JSON.stringify(h.state.document),before);
  change('Nome do arquivo para download','material.webp'); apply().click();
  assert.equal(h.state.document.schema_version,3); assert.equal(buttons()[0].action.kind,'image'); validateDocument(h.state.document);
  const committed=JSON.stringify(h.state.document);
  h.state.workspace.capabilities.edit=false; change('Tipo de destino','video'); apply().click(); assert.equal(JSON.stringify(h.state.document),committed);
  h.state.workspace.capabilities.edit=true;
  h.state.undo(); h.reconcile(); assert.equal(JSON.stringify(h.state.document),before); assert.equal(h.state.canUndo,false);
  h.state.redo(); h.reconcile(); assert.equal(buttons()[0].action.file_name,'material.webp');
  h.state.workspace.media=[];h.reconcile(); assert.match(h.root.textContent,/Arquivo ausente ou incompatível/);
  const preserved=JSON.stringify(h.state.document); change('Tipo de destino','video'); apply().click(); assert.equal(JSON.stringify(h.state.document),preserved);
  h.state.acknowledge({version:0,document_support:{read_versions:[1,2,3],write_versions:[]}});
  retired.value='download'; retired.dispatchEvent(new TestEvent('change')); retiredApply.click(); assert.equal(JSON.stringify(h.state.document),preserved);
  await h.replaceWithoutGuard('?id=second'); const fresh=JSON.stringify(h.state.document);
  retired.value='download';retired.dispatchEvent(new TestEvent('change'));retiredApply.click();assert.equal(JSON.stringify(h.state.document),fresh);
});

test('default-off button action selection never opts a legacy document into v3',async t=>{
  const h=await harness(t,{document:createTemplate('owner-news')});
  const block=h.root.querySelector('[data-block-type="button"]');block.querySelector('.pages-select-block').click();
  const target=h.root.querySelectorAll('select').find(n=>n.getAttribute('aria-label')==='Tipo de destino'),before=JSON.stringify(h.state.document);
  for(const type of ['download','video']){assert.equal(target.querySelectorAll('option').find(n=>n.value===type).disabled,true);target.value=type;target.dispatchEvent(new TestEvent('change'));}
  assert.equal(JSON.stringify(h.state.document),before);assert.equal(h.state.canUndo,false);
});

test('video authoring resolves live blocks and prevents deleting a referenced target; removed targets remain explicit',async t=>{
  const document=createTemplate('owner-news'),video={id:randomUUID(),type:'video',media_id:randomUUID(),title:'Alvo',transcript:'Texto',captions:[]};
  document.sections[0].rows[0].columns[0].blocks.push(video);
  const h=await harness(t,{document,support:{read_versions:[1,2,3],write_versions:[1,2,3]}});
  const choose=id=>h.root.querySelector(`[data-block-id="${id}"]`).querySelector('.pages-select-block').click();
  h.root.querySelector('[data-block-type="button"]').querySelector('.pages-select-block').click();
  const blockId=h.root.querySelector('[data-block-type="button"]').dataset.blockId;
  const change=(name,value)=>{const node=h.root.querySelectorAll('select').find(n=>n.getAttribute('aria-label')===name);node.value=value;node.dispatchEvent(new TestEvent('change'));};
  change('Tipo de destino','video');change('Vídeo da página',video.id);
  h.root.querySelectorAll('button').find(n=>n.textContent==='Aplicar destino').click();validateDocument(h.state.document);
  const before=JSON.stringify(h.state.document);choose(video.id);
  h.root.querySelectorAll('button').find(n=>n.textContent==='Excluir').click();assert.equal(JSON.stringify(h.state.document),before);
  h.state.transact({},doc=>{const list=doc.sections[0].rows[0].columns[0].blocks;list.splice(list.findIndex(b=>b.id===video.id),1);});h.reconcile();choose(blockId);
  assert.match(h.root.textContent,/Vídeo de destino removido/);
  change('Tipo de destino',h.state.document.sections[0].id);validateDocument(h.state.document);
});

test('mobile sheet owns viewport subscriptions only while active; tabs, rotation, history and disposal retain document/views', async t => {
  const h=await harness(t,{mobile:true}), before=JSON.stringify(h.state.document), pm=h.editors[0];
  const sheet=h.root.querySelector('.pages-v2-inspector'), viewport=h.window.visualViewport;
  const click=name=>h.root.querySelectorAll('button').find(n=>n.textContent===name).click();
  const signal=height=>{viewport.height=height;viewport.dispatchEvent(new TestEvent('resize'));};
  click('Concluir edição');signal(400);assert.equal(sheet.style.getPropertyValue('--pages-visible-height'),'');
  pm.onFocus();assert.equal(sheet.style.getPropertyValue('--pages-visible-height'),'400px');
  for(const label of ['Estilo','Posição','Conteúdo'])click(label);
  signal(500);assert.equal(sheet.style.getPropertyValue('--pages-visible-height'),'500px');
  for(const match of h.media){match.matches=false;match.dispatchEvent(new TestEvent('change'));}
  assert.equal(sheet.style.getPropertyValue('--pages-visible-height'),'');signal(600);assert.equal(sheet.style.getPropertyValue('--pages-visible-height'),'');
  for(const match of h.media){match.matches=true;match.dispatchEvent(new TestEvent('change'));}
  assert.equal(sheet.style.getPropertyValue('--pages-visible-height'),'600px');
  await h.pop('?id=first#mobile');assert.equal(h.root.dataset.inspectorOpen,'false');assert.equal(sheet.style.getPropertyValue('--pages-visible-height'),'');
  pm.onFocus();h.page.dispose();signal(300);assert.equal(sheet.style.getPropertyValue('--pages-visible-height'),'');
  assert.equal(JSON.stringify(h.state.document),before);assert.equal(pm.destroyed,1);
});

test('compact typography uses one guarded appearance transaction and retired inputs cannot modify the retained view', async t => {
  const h=await harness(t,{mobile:true,support:{read_versions:[1,2,3],write_versions:[1,2,3]}}),before=JSON.stringify(h.state.document),pm=h.editors[0];
  const pick=()=>h.root.querySelectorAll('select').find(n=>n.getAttribute('aria-label')==='Tipografia e tamanho');
  const retired=pick();retired.value='oswald:small';retired.dispatchEvent(new TestEvent('change'));
  const appearance=h.state.document.sections[0].rows[0].columns[0].blocks[0].appearance;
  assert.equal(appearance.font,'oswald');assert.equal(appearance.scale,'small');
  assert.equal(h.state.undo(),true);h.reconcile();assert.equal(JSON.stringify(h.state.document),before);assert.equal(h.state.canUndo,false);
  retired.value='source-serif-4:large';retired.dispatchEvent(new TestEvent('change'));assert.equal(JSON.stringify(h.state.document),before);
  h.state.acknowledge({version:0,document_support:{read_versions:[1,2,3],write_versions:[]}});
  const disabled=pick();assert.equal(disabled.disabled,true);disabled.value='oswald:large';disabled.dispatchEvent(new TestEvent('change'));assert.equal(JSON.stringify(h.state.document),before);
  assert.equal(h.editors[0],pm);assert.equal(pm.destroyed,0);
});

test('fragment-only native history preserves dirty state and editor instances; accepted document Back/Forward still reloads', async t => {
  const h = await harness(t), original = h.state, editor = h.editors[0];
  const title = h.root.querySelector('.pages-metadata-title').querySelector('input'); title.value = 'Unsaved local title'; title.dispatchEvent(new TestEvent('input'));
  for (const fragment of ['#main-content', '#another', '']) {
    await h.pop(`?id=first${fragment}`);
    assert.equal(h.state, original); assert.equal(h.state.document.metadata.title, 'Unsaved local title');
    assert.equal(h.state.status, 'dirty'); assert.equal(editor.destroyed, 0); assert.equal(h.workspaces.length, 1);
  }
  assert.equal(h.page.canLeave(), false, 'query/document leave remains guarded');
  h.window.confirm = () => true; assert.equal(h.page.canLeave(), true);
  await h.pop('?id=second'); assert.equal(h.state.workspace.id, 'second'); assert.equal(editor.destroyed, 1);
  await h.pop('?id=first'); assert.equal(h.state.workspace.id, 'first');
  assert.deepEqual(h.workspaces, ['first', 'second', 'first']);
});

test('default writer support disables v3 catalog/layout before any upgrade; synthetic change is rejected', async t => {
  const h = await harness(t), doc = h.root.ownerDocument, before = JSON.stringify(h.state.document);
  h.root.querySelectorAll('button').find(n => n.textContent === 'Inserir bloco').click();
  for (const name of ['Adicionar galeria','Adicionar FAQ']) assert.equal(doc.querySelectorAll('button').find(n => n.getAttribute('aria-label') === name).disabled, true);
  doc.querySelectorAll('button').find(n => n.getAttribute('aria-label') === 'Fechar O que você quer adicionar?').click();
  const layout = h.root.querySelectorAll('select').find(n => n.getAttribute('aria-label') === 'Colunas da linha 1');
  assert.equal(layout.querySelectorAll('option').find(n => n.value === 'aside_right').disabled, true);
  layout.value = 'aside_right'; layout.dispatchEvent(new TestEvent('change'));
  assert.equal(JSON.stringify(h.state.document), before); assert.equal(h.state.canUndo, false);
});

test('upload with removed captured anchor retains ACKed file for explicit new destination, never appends silently or reuploads', async t => {
  const dialogs = [], h = await harness(t, { dialogs }), pending = await h.upload(), mediaId = randomUUID();
  h.state.transact({}, doc => { doc.sections[0].rows[0].columns[0].blocks.length = 0; });
  pending.resolve({ media_id: mediaId, page_id:'first', kind:'image' }); await drain();
  assert.equal(h.state.workspace.media.some(m=>m.id===mediaId&&m.kind==='image'),true,'acknowledged unplaced upload remains selectable');
  assert.equal(h.state.document.sections[0].rows[0].columns[0].blocks.length, 0);
  const place = h.root.querySelectorAll('button').find(n => n.textContent === 'Escolher destino para arquivo enviado'); assert.equal(place.hidden, false);
  place.click(); assert.equal(dialogs.length, 1);
  const destination = dialogs[0].content.querySelector('select'); destination.value = h.state.document.sections[0].rows[0].columns[0].id;
  await dialogs[0].action(); assert.equal(h.uploads.length, 1);
  assert.equal(h.state.document.sections[0].rows[0].columns[0].blocks[0].media_id, mediaId);
  assert.equal(place.hidden, true); assert.equal(h.state.undo(), true);
  assert.equal(h.state.document.sections[0].rows[0].columns[0].blocks.length, 0);
});

test('rejected v3 link-budget conversion leaves legacy document, view and single timeline unchanged', async t => {
  const document = createTemplate(); document.schema_version = 2; document.template.version = 2;
  document.sections[0].rows[0].columns[0].blocks[0].content = { type: 'doc', content: [{ type: 'paragraph', content: Array.from({ length: 60 }, () => ({ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: '/' + 'a'.repeat(1999) } }] })) }] };
  validateDocument(document);
  const h = await harness(t, { document, support: { read_versions: [1,2,3], write_versions: [1,2,3] } }), before = JSON.stringify(h.state.document), pm = h.editors[0];
  const layout = h.root.querySelectorAll('select').find(n => n.getAttribute('aria-label') === 'Colunas da linha 1');
  layout.value = 'aside_right'; layout.dispatchEvent(new TestEvent('change'));
  assert.equal(JSON.stringify(h.state.document), before); assert.equal(layout.value, 'single');
  assert.equal(h.state.dirty, false); assert.equal(h.state.canUndo, false); assert.equal(h.state.pending, null);
  assert.equal(h.editors[0], pm); assert.equal(pm.destroyed, 0);
});

test('near-byte-limit columns and half-width are cancelled before v1 replacement or any history entry', async t => {
  const document = createTemplate(), content = Array.from({ length: 470 }, () => ({ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: '/' + 'a'.repeat(2047) } }] }));
  document.sections[0].rows[0].columns[0].blocks[0].content = { type: 'doc', content: [{ type: 'paragraph', content }] };
  content[0].text += 'x'.repeat(1048526 - Buffer.byteLength(JSON.stringify(document))); validateDocument(document);
  const h = await harness(t, { document }), before = JSON.stringify(h.state.document), pm = h.editors[0];
  const width = h.root.querySelectorAll('select').find(n => n.getAttribute('aria-label') === 'Largura do bloco');
  width.value = 'half'; width.dispatchEvent(new TestEvent('change')); assert.equal(width.value, 'full');
  h.root.querySelectorAll('button').find(n => n.textContent === 'Inserir bloco').click();
  h.root.ownerDocument.querySelectorAll('button').find(n => n.getAttribute('aria-label') === 'Adicionar duas colunas').click();
  assert.equal(JSON.stringify(h.state.document), before); assert.equal(h.state.document.schema_version, 1);
  assert.equal(h.state.dirty, false); assert.equal(h.state.status, 'saved'); assert.equal(h.state.canUndo, false); assert.equal(h.state.canRedo, false);
  assert.equal(h.editors[0], pm); assert.equal(pm.destroyed, 0);
});

test('clean draft with ACKed unplaced upload requires explicit reload abandonment and blocks archive without losing recovery', async t => {
  const document = createTemplate(), meta = document.metadata, section = document.sections[0];
  const count = meta.title.length + meta.summary.length + meta.tags.join('').length + section.label.length;
  section.rows[0].columns[0].blocks[0].content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(100000 - count) }] }] };
  validateDocument(document);
  const dialogs = [], h = await harness(t, { dialogs, document }), original = h.state, pm = h.editors[0];
  const pending = await h.upload('audio/mpeg'); pending.resolve({ media_id: randomUUID() }); await drain();
  const click = name => h.root.querySelectorAll('button').find(n => n.textContent === name).click();
  const place = h.root.querySelectorAll('button').find(n => n.textContent === 'Escolher destino para arquivo enviado');
  assert.equal(place.hidden, false); assert.equal(original.dirty, false); assert.equal(original.status, 'saved'); assert.equal(original.canUndo, false); assert.equal(original.pending, null);
  const confirmations = []; h.window.confirm = message => { confirmations.push(message); return false; };
  assert.equal(h.page.canLeave(), false); confirmations.length = 0;
  click('Recarregar versão salva'); await drain();
  assert.equal(confirmations.length, 1, 'clean placement must prompt before reload');
  assert.match(confirmations[0], /arquivo já enviado/i); assert.match(confirmations[0], /não.*desfeit/i);
  assert.equal(h.workspaces.length, 1); assert.equal(h.state, original); assert.equal(place.hidden, false); assert.equal(pm.destroyed, 0);
  click('Arquivar'); assert.equal(dialogs.length, 0, 'unresolved placement must block archive, not open its action');
  click('Escolher destino para arquivo enviado'); assert.equal(dialogs.length, 1, 'the original uploaded-file handle remains recoverable');
  h.window.confirm = () => true; click('Recarregar versão salva'); await drain();
  assert.equal(h.workspaces.length, 2); assert.notEqual(h.state, original); assert.equal(pm.destroyed, 1);
  assert.equal(h.root.querySelectorAll('button').find(n => n.textContent === 'Escolher destino para arquivo enviado').hidden, true);
  assert.equal(h.uploads.length, 1, 'abandonment did not reupload or claim a rollback');
});

test('search-disclosed combined choices synchronize aria-expanded and aria-controls with actual visibility', async t => {
  const h = await harness(t), doc = h.root.ownerDocument;
  h.root.querySelectorAll('button').find(n => n.textContent === 'Inserir bloco').click();
  const combined = doc.querySelectorAll('button').find(n => n.getAttribute('aria-label') === 'Destaque ou botão');
  const group = doc.querySelectorAll('[role="group"]').find(n => n.getAttribute('aria-label') === 'Escolha destaque ou botão');
  assert.ok(group.id || group.getAttribute('id'));
  assert.equal(combined.getAttribute('aria-controls'), group.id || group.getAttribute('id'));
  const search = doc.querySelector('input[type="search"]');
  for (const [query, visible] of [['botao',true],['naoexiste',false],['',false]]) {
    search.value = query; search.dispatchEvent(new TestEvent('input'));
    assert.equal(group.hidden, !visible); assert.equal(combined.getAttribute('aria-expanded'), String(visible));
  }
  combined.click(); assert.equal(group.hidden, false); assert.equal(combined.getAttribute('aria-expanded'), 'true');
  combined.click(); assert.equal(group.hidden, true); assert.equal(combined.getAttribute('aria-expanded'), 'false');
});

test('one timeline owns PM, style, insertion/deletion and metadata; latest-ID callbacks and silent sync preserve retained views', async t => {
  const h = await harness(t), pm = h.editors[0], before = JSON.stringify(h.state.document);
  const text = value => ({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:value}]}]});
  pm.onChange(text('typed A'), {selection:pm.bookmark(),beforeSelection:pm.bookmark()});
  const font = h.root.querySelectorAll('select').find(n => n.getAttribute('aria-label') === 'Fonte'); font.value='oswald'; font.dispatchEvent(new TestEvent('change'));
  pm.onChange(text('after clone'), {selection:pm.bookmark(),beforeSelection:pm.bookmark(),closeGroup:true});
  assert.equal(h.state.document.sections[0].rows[0].columns[0].blocks[0].content.content[0].content[0].text,'after clone');
  assert.equal(pm.historyCommands.undo(),true); assert.equal(pm.content.content[0].content[0].text,'typed A');
  assert.equal(pm.historyCommands.undo(),true); assert.equal(h.state.document.schema_version,1);
  assert.equal(pm.historyCommands.undo(),true); assert.equal(JSON.stringify(h.state.document),before); assert.equal(pm.destroyed,0);
  assert.equal(pm.historyCommands.redo(),true);
  const title = h.root.querySelector('.pages-metadata-title input'); title.value='metadata'; title.dispatchEvent(new TestEvent('input'));
  assert.equal(pm.historyCommands.redo(),false); assert.equal(pm.historyCommands.undo(),true); assert.equal(title.value,h.state.document.metadata.title);
});

test('history reconciles every existing field family after cloned replacement, without stale block callbacks', async t => {
  const h=await harness(t), doc=h.root.ownerDocument;
  const click=text=>{const node=doc.querySelectorAll('button').find(n=>n.textContent===text||n.getAttribute('aria-label')===text);assert.ok(node,text);node.click();};
  const change=(node,value,type='input')=>{node.value=value;node.dispatchEvent(new TestEvent(type));};
  const undo=()=>{assert.equal(h.state.undo(),true);};
  const recover=()=>click('Desfazer exclusão');
  click('Inserir bloco');click('Adicionar botão');
  const buttonId=h.state.document.sections[0].rows[0].columns[0].blocks.at(-1).id;
  const current=id=>h.state.document.sections.flatMap(s=>s.rows.flatMap(r=>r.columns.flatMap(c=>c.blocks))).find(b=>b.id===id);
  const control=name=>doc.querySelectorAll('select').find(n=>n.getAttribute('aria-label')===name);
  const label=doc.querySelectorAll('input').find(n=>n.value==='Saiba mais');change(label,'Label');recover();assert.equal(current(buttonId).label,'Saiba mais');assert.equal(label.value,'Saiba mais');
  change(label,'Latest label');assert.equal(current(buttonId).label,'Latest label');
  change(control('Estilo do botão'),'secondary','change');recover();assert.equal(current(buttonId).preset,'primary');assert.equal(control('Estilo do botão').value,'primary');
  click('Inserir bloco');click('Adicionar destaque');const calloutId=h.state.document.sections[0].rows[0].columns[0].blocks.at(-1).id;
  change(control('Tom'),'success','change');recover();assert.equal(current(calloutId).tone,'info');assert.equal(control('Tom').value,'info');
  const pending=await h.upload('video/mp4');pending.resolve({media_id:randomUUID()});await drain();const videoId=h.state.document.sections[0].rows[0].columns[0].blocks.at(-1).id;
  const cues=doc.querySelectorAll('textarea').find(n=>n.getAttribute('aria-label')==='Legendas sincronizadas JSON');
  change(cues,'[{"start_ms":0,"end_ms":1000,"text":"cue"}]','change');recover();assert.equal(current(videoId).captions.length,0);assert.equal(cues.value,'[]');
  const section=doc.querySelectorAll('input').find(n=>n.getAttribute('aria-label')==='Nome da seção 1'), old=section.value;
  change(section,'Rename');recover();assert.equal(h.state.document.sections[0].label,old);
  assert.ok(h.editors.every(e=>e.destroyed===0));
  // Direct state callers remain supported too; they do not maintain a second
  // recovery stack. The mounted path above additionally reconciles the DOM.
  h.state.transact({},d=>{d.metadata.tags=['one'];});undo();assert.equal(h.state.document.metadata.tags.length,0);
});

test('native fields disable and reconcile during upload/ambiguity or disabled support, but retain newer edits during ordinary save', async t => {
  const h=await harness(t), title=h.root.querySelector('.pages-metadata-title input'), summary=h.root.querySelector('.pages-metadata-summary textarea');
  const input=(node,value)=>{node.value=value;node.dispatchEvent(new TestEvent('input',{bubbles:true}));};
  input(title,'Before upload');const pending=await h.upload();
  assert.equal(title.disabled,true);assert.equal(summary.disabled,true);
  input(title,'DOM only');assert.equal(title.value,'Before upload');assert.equal(h.state.document.metadata.title,'Before upload');
  pending.reject(new Error('unknown upload'));await drain();assert.ok(h.retry);assert.equal(title.disabled,true);
  input(title,'Unknown DOM');assert.equal(title.value,'Before upload');
  h.root.querySelectorAll('button').find(n=>n.textContent==='Cancelar upload não confirmado').click();assert.equal(title.disabled,false);
  input(title,'Submitted');let submitted;const held=deferred();
  const saving=h.state.save({save:(_id,p)=>{submitted=p;return held.promise;}});
  assert.equal(title.disabled,false,'ordinary in-flight save must not disable content');
  input(title,'Newer');input(summary,'Newer summary');held.resolve({version:1,draft_revision_id:'r1'});await saving;
  assert.equal(submitted.document.metadata.title,'Submitted');assert.equal(title.value,'Newer');assert.equal(h.state.document.metadata.title,'Newer');assert.equal(h.state.status,'dirty');
  await h.state.save({save:async(_id,p)=>{assert.equal(p.document.metadata.title,title.value);return {version:2,draft_revision_id:'r2'};}});assert.equal(h.state.status,'saved');
  h.state.acknowledge({version:2,document_support:{read_versions:[1,2,3],write_versions:[]}});
  assert.equal(title.disabled,true);assert.equal(summary.disabled,true);input(title,'Readonly DOM');assert.equal(title.value,'Newer');assert.equal(h.state.document.metadata.title,'Newer');
});

test('keyed native block/section bindings remain operation-aware while moved out of the inspector and restore readonly DOM changes',async t=>{
  const h=await harness(t),doc=h.root.ownerDocument;
  h.root.querySelectorAll('button').find(n=>n.textContent==='Inserir bloco').click();doc.querySelectorAll('button').find(n=>n.getAttribute('aria-label')==='Adicionar botão').click();
  const label=doc.querySelectorAll('input').find(n=>n.value==='Saiba mais'),preset=doc.querySelectorAll('select').find(n=>n.getAttribute('aria-label')==='Estilo do botão');
  h.root.querySelector('.pages-select-block').click();assert.equal(h.root.contains(label),false,'inspector really detached the keyed fields');
  const pending=await h.upload('video/mp4');assert.equal(label.disabled,true);assert.equal(preset.disabled,true);
  label.value='Blocked label';label.dispatchEvent(new TestEvent('input'));assert.equal(label.value,'Saiba mais');
  pending.resolve({media_id:randomUUID()});await drain();assert.equal(label.disabled,false);
  const videoTitle=doc.querySelectorAll('input').find(n=>n.value==='synthetic.mp4'),transcript=doc.querySelectorAll('textarea').find(n=>n.getAttribute('maxlength')==='20000'),cues=doc.querySelectorAll('textarea').find(n=>n.getAttribute('aria-label')==='Legendas sincronizadas JSON');
  const section=doc.querySelectorAll('input').find(n=>n.getAttribute('aria-label')==='Nome da seção 1'),originalSection=section.value;
  h.state.acknowledge({version:0,document_support:{read_versions:[1,2,3],write_versions:[]}});
  for(const [node,value,type] of [[label,'Wrong','input'],[preset,'secondary','change'],[videoTitle,'Wrong','input'],[transcript,'Wrong','input'],[cues,'not JSON','change'],[section,'Wrong','input']]) {
    assert.equal(node.disabled,true);node.value=value;node.dispatchEvent(new TestEvent(type));
  }
  assert.equal(label.value,'Saiba mais');assert.equal(preset.value,'primary');assert.equal(videoTitle.value,'synthetic.mp4');assert.equal(transcript.value,'');assert.equal(cues.value,'[]');assert.equal(section.value,originalSection);
});

for (const [selector,key] of [['.pages-metadata-title input','title'],['.pages-metadata-summary textarea','summary']]) {
  test(`native ${key} long IME blocks global undo and ends as one transaction`,async t=>{
    const h=await harness(t), control=h.root.querySelector(selector), original=control.value, pm=h.editors[0];
    control.dispatchEvent(new TestEvent('compositionstart',{bubbles:true}));
    control.value='一';control.dispatchEvent(new TestEvent('input',{bubbles:true,isComposing:true}));
    await new Promise(resolve=>setTimeout(resolve,650));
    control.value='一二';control.dispatchEvent(new TestEvent('input',{bubbles:true,isComposing:true}));
    const shortcut=new TestEvent('keydown',{bubbles:true,key:'z',ctrlKey:true,isComposing:true});control.dispatchEvent(shortcut);
    assert.equal(shortcut.defaultPrevented,true);assert.equal(h.state.document.metadata[key],'一二');assert.equal(control.value,'一二');
    assert.equal(pm.historyCommands.undo(),false,'toolbar/bridge also sees native composition');
    control.dispatchEvent(new TestEvent('compositionend',{bubbles:true}));await drain();
    assert.equal(pm.historyCommands.undo(),true);assert.equal(control.value,original);assert.equal(h.state.document.metadata[key],original);
    assert.equal(pm.historyCommands.redo(),true);assert.equal(control.value,'一二');
    control.value='一二x';control.dispatchEvent(new TestEvent('input',{bubbles:true}));assert.equal(pm.historyCommands.undo(),true);assert.equal(control.value,'一二','explicit end splits subsequent ordinary typing');
  });
}

test('block drag uses pointer fallback and its scoped PM guard cannot serialize block chrome into prose', async t => {
  const h = await harness(t), editor = h.editors[0], sortable = h.sortables[0], before = JSON.stringify(h.state.document);
  assert.equal(sortable.options.forceFallback, true);
  const guard = h.compositionDropGuard(editor.isLayoutDragging);
  const ordinary = new TestEvent('drop');
  assert.equal(guard(null, ordinary), false, 'ordinary rich-text drops retain PM behavior');
  sortable.options.onStart(); assert.equal(editor.isLayoutDragging(), true);
  assert.equal(h.root.dataset.layoutDragging, 'true', 'visible toolbar yields pointer hit-testing during block drag');
  let prevented = 0, stopped = 0;
  assert.equal(guard(null, { preventDefault() { prevented++; }, stopPropagation() { stopped++; } }), true);
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  const block = h.state.document.sections[0].rows[0].columns[0].blocks[0];
  sortable.options.onEnd({ item: { dataset: { blockId: block.id } }, to: sortable.host });
  assert.equal(editor.isLayoutDragging(), false); assert.equal(guard(null, ordinary), false);
  assert.equal(h.root.dataset.layoutDragging, 'false', 'toolbar hit-testing restored after drop');
  assert.equal(JSON.stringify(h.state.document), before, 'no-op block drop must not alter prose, schema version or dirty state');
  assert.equal(editor.destroyed, 0, 'keyed PM instance survives');
});
test('section Sortable shares the PM drop guard and restores an invalid UUID drop without a history entry', async t => {
  const h = await harness(t), pm = h.editors[0], before = JSON.stringify(h.state.document);
  const sortable = h.sortables.find(s => s.host.classList.contains('pages-v2-section-list'));
  assert.ok(sortable); assert.equal(sortable.options.forceFallback, true);
  sortable.options.onStart(); assert.equal(pm.isLayoutDragging(), true);
  const event = new TestEvent('drop'); assert.equal(h.compositionDropGuard(pm.isLayoutDragging)(null, event), true);
  sortable.options.onEnd({ item: { dataset: { sectionSortId: 'missing' } } });
  assert.equal(pm.isLayoutDragging(), false); assert.equal(h.state.canUndo, false);
  assert.equal(JSON.stringify(h.state.document), before); assert.equal(pm.destroyed, 0);
});

test('existing button section options reconcile after section insertion/rename without recreating keyed PM or button controls', async t => {
  const h = await harness(t), pm = h.editors[0];
   const click = text => { if (text.startsWith('Adicionar ') && text !== 'Adicionar seção') h.root.querySelectorAll('button').find(node => node.textContent === 'Inserir bloco').click(); const button = h.root.ownerDocument.querySelectorAll('button').find(node => node.getAttribute('aria-label') === text || node.textContent === text); assert.ok(button, text); button.click(); };
  click('Adicionar botão');
  const target = h.root.querySelectorAll('select').find(node => node.getAttribute('aria-label') === 'Tipo de destino'); assert.ok(target);
  click('Adicionar seção');
  const section = h.state.document.sections[1];
  assert.equal(h.root.querySelectorAll('select').find(node => node.getAttribute('aria-label') === 'Tipo de destino'), target);
  assert.ok(target.querySelectorAll('option').some(node => node.value === section.id));
  const label = h.root.querySelectorAll('input').find(node => node.getAttribute('aria-label') === 'Nome da seção 2'); label.value = 'Seção recém-criada'; label.dispatchEvent(new TestEvent('input'));
  assert.equal(target.querySelectorAll('option').find(node => node.value === section.id).textContent, 'Seção: Seção recém-criada');
  target.value = section.id; target.dispatchEvent(new TestEvent('change'));
  const block = h.state.document.sections[0].rows[0].columns[0].blocks.find(item => item.type === 'button');
  assert.equal(block.destination.type, 'section'); assert.equal(block.destination.value, section.id);
  assert.equal(h.editors[0], pm); assert.equal(pm.destroyed, 0);
});

test('editor chrome groups header, metadata, structure and block controls without changing an opened document', async t => {
  const h = await harness(t), before = JSON.stringify(h.state.document);
  assert.equal(h.root.querySelector('h1').textContent, 'Editar Page');
  assert.ok(h.root.querySelector('.pages-v2-header').contains(h.root.querySelector('.pages-save-status')));
  assert.equal(h.root.querySelector('.pages-primary-actions').querySelectorAll('button').length, 4, 'preview menu has the three real modes plus Publish');
  assert.equal(h.root.querySelector('.pages-secondary-actions').querySelectorAll('button').length, 3, 'explicit Save is retained with reload/archive in Page properties');
  assert.ok(h.root.querySelector('.pages-secondary-actions').contains(h.root.querySelector('.pages-action-button')));
  for (const key of ['title', 'summary']) assert.ok(h.root.querySelector(`.pages-metadata-${key}`));
  for (const header of ['pages-section-header', 'pages-row-header']) {
    const node = h.root.querySelector(`.${header}`);
    assert.ok(node.querySelector('.pages-field'));
    assert.ok(node.querySelector('.pages-structure-actions'));
  }
  const header = h.root.querySelector('.pages-block-header'), handle = header.querySelector('.pages-drag-handle');
  assert.equal(header.parentElement.getAttribute('data-block-type'), 'rich_text');
  assert.ok(handle.classList.contains('btn'));
  assert.equal(handle.getAttribute('aria-label'), 'Arrastar bloco; use Subir, Descer ou destino pelo teclado');
  assert.equal(header.querySelector('.pages-select-block').textContent, 'Selecionar texto 1');
  assert.equal(h.root.querySelector('input[type="file"]').getAttribute('accept'), 'image/jpeg,image/png,image/webp,image/gif,audio/mpeg,video/mp4');
  assert.equal(JSON.stringify(h.state.document), before); assert.equal(h.state.dirty, false);
});

test('V2 mounts a dedicated workspace without changing the document and restores the Portal shell on disposal', async t => {
  const h = await harness(t), original = JSON.stringify(h.state.document);
  assert.ok(h.root.querySelector('.pages-v2-workspace'));
  assert.ok(h.root.querySelector('.pages-v2-structure'));
  assert.ok(h.root.querySelector('.pages-v2-inspector'));
  assert.ok(h.root.ownerDocument.body.classList.contains('pages-editor-active'));
  assert.equal(JSON.stringify(h.state.document), original);
  assert.equal(h.state.dirty, false);
  h.page.dispose();
  assert.equal(h.root.ownerDocument.body.classList.contains('pages-editor-active'), false);
});

test('V2 style cancel is inert; bulk apply persists supported block presets atomically without global inheritance', async t => {
  const h = await harness(t), pm = h.editors[0], doc = h.root.ownerDocument;
  const click = text => { const control = doc.querySelectorAll('button').find(node => node.textContent === text || node.getAttribute('aria-label') === text); assert.ok(control, text); control.click(); };
  const before = JSON.stringify(h.state.document);
  click('Estilo da página');
  click('Abrir presets legados');
  const font = doc.querySelectorAll('select').find(node => node.getAttribute('aria-label') === 'Fonte dos blocos existentes');
  font.value = 'oswald'; font.dispatchEvent(new TestEvent('change'));
  click('Fechar Estilo da página');
  assert.equal(JSON.stringify(h.state.document), before); assert.equal(h.state.dirty, false);
  click('Estilo da página');
  click('Abrir presets legados');
  const nextFont = doc.querySelectorAll('select').find(node => node.getAttribute('aria-label') === 'Fonte dos blocos existentes');
  nextFont.value = 'source-serif-4';
  doc.querySelectorAll('select').find(node => node.getAttribute('aria-label') === 'Escala dos blocos existentes').value = 'standard';
  doc.querySelector('[data-palette-value="warm"]').click();
  const old = h.state.document;
  click('Aplicar aos blocos existentes');
  assert.notEqual(h.state.document, old);
  assert.equal(old.sections[0].rows[0].columns[0].blocks[0].style, undefined, 'old working snapshot was not mutated');
  assert.equal(h.state.document.sections[0].rows[0].columns[0].blocks[0].style.font, 'source-serif-4');
  assert.equal(h.state.document.sections[0].rows[0].columns[0].blocks[0].style.palette, 'warm');
  assert.equal(h.state.document.presentation.font, 'manrope', 'no invented document-level theme or inheritance');
  click('Inserir bloco'); click('Adicionar botão');
  const blocks = h.state.document.sections[0].rows[0].columns[0].blocks;
  assert.equal(blocks.at(-1).style, undefined, 'later insertion keeps the established default');
  assert.equal(h.editors[0], pm); assert.equal(pm.destroyed, 0);
});

test('V2 inspector reuses keyed block fields rather than cloning inputs or document state on selection', async t => {
  const h = await harness(t), doc = h.root.ownerDocument;
  h.root.querySelectorAll('button').find(node => node.textContent === 'Inserir bloco').click();
  doc.querySelectorAll('button').find(node => node.getAttribute('aria-label') === 'Adicionar botão').click();
  const target = h.root.querySelectorAll('select').find(node => node.getAttribute('aria-label') === 'Tipo de destino');
  const before = JSON.stringify(h.state.document);
  h.root.querySelectorAll('.pages-select-block')[0].click();
  h.root.querySelectorAll('.pages-select-block')[1].click();
  assert.equal(h.root.querySelectorAll('select').find(node => node.getAttribute('aria-label') === 'Tipo de destino'), target);
  assert.equal(h.root.querySelectorAll('select').filter(node => node.getAttribute('aria-label') === 'Tipo de destino').length, 1);
  assert.equal(JSON.stringify(h.state.document), before);
  assert.equal(h.editors[0].destroyed, 0);
});

test('Task13 defaults and inspector inheritance are opt-in atomic, readonly gated and retire same-ID controls', async t => {
  const h=await harness(t,{support:{read_versions:[1,2,3],write_versions:[1,2,3]}}),doc=h.root.ownerDocument;
  const click=text=>{const node=doc.querySelectorAll('button').find(n=>n.textContent===text||n.getAttribute('aria-label')===text);assert.ok(node,text);node.click();};
  const select=(name,value)=>{const node=doc.querySelectorAll('select').find(n=>n.getAttribute('aria-label')===name);assert.ok(node,name);node.value=value;node.dispatchEvent(new TestEvent('change'));return node;};
  const before=JSON.stringify(h.state.document),pm=h.editors[0];
  click('Estilo da página');select('Fonte da página','oswald');click('Fechar Estilo da página');assert.equal(JSON.stringify(h.state.document),before);assert.equal(h.state.canUndo,false);
  click('Estilo da página');select('Fonte da página','oswald');click('✓ Aplicar estilo');assert.equal(h.state.document.schema_version,3);assert.equal(h.state.document.presentation.defaults.font,'oswald');
  assert.equal(h.state.document.sections[0].rows[0].columns[0].blocks[0].style.font,'manrope');
  click('Desfazer exclusão');assert.equal(JSON.stringify(h.state.document),before);assert.equal(h.state.canUndo,false);
  h.state.redo();h.reconcile();
  const retired=select('Tipografia','source-serif-4');const currentBlock=()=>h.state.document.sections[0].rows[0].columns[0].blocks[0];
  assert.equal(currentBlock().appearance.font,'source-serif-4');
  select('Ícone','coffee');const old=JSON.stringify(h.state.document);retired.value='oswald';retired.dispatchEvent(new TestEvent('change'));assert.equal(JSON.stringify(h.state.document),old);
  select('Tipografia','inherit');assert.equal(currentBlock().style.font,'manrope');assert.equal(currentBlock().appearance.font,undefined);assert.equal(currentBlock().appearance.icon,'coffee');
  assert.equal(h.editors[0],pm);assert.equal(pm.destroyed,0);validateDocument(h.state.document);
  const readonly=await harness(t,{support:{read_versions:[1,2,3],write_versions:[1,2]}}),font=readonly.root.querySelectorAll('select').find(n=>n.getAttribute('aria-label')==='Tipografia');
  assert.equal(font.disabled,true);const readBefore=JSON.stringify(readonly.state.document);font.value='oswald';font.dispatchEvent(new TestEvent('change'));assert.equal(JSON.stringify(readonly.state.document),readBefore);assert.equal(readonly.state.canUndo,false);assert.equal(font.value,'manrope');
});

test('Task13 property-only reset preserves legacy callout/button outer and inner colors and has one undo', async t => {
  for(const type of ['callout','button']){
    const initial=upgradeDocument(createTemplate()),block=initial.sections[0].rows[0].columns[0].blocks[0];
    initial.presentation.defaults.font='oswald';
    if(type==='callout')Object.assign(block,{type,tone:'info',icon:'alert'});
    else {delete block.content;Object.assign(block,{type,label:'Continue',preset:'primary',action:{type:'url',value:'/pages.html'}});}
    block.appearance={font:'source-serif-4'};const pinned=structuredClone(block.style);
    const h=await harness(t,{document:initial,support:{read_versions:[1,2,3],write_versions:[1,2,3]}});
    const current=()=>h.state.document.sections[0].rows[0].columns[0].blocks[0];
    const colors=()=>[current(),{...current(),type:'rich_text'}].map(value=>{const a=resolveAppearance(h.state.document,value);return [a.foreground,a.background,a.accent];});
    const before=JSON.stringify(h.state.document),beforeColors=colors();
    const font=h.root.querySelectorAll('select').find(n=>n.getAttribute('aria-label')==='Tipografia');
    assert.equal(font.querySelectorAll('option').find(n=>n.value==='inherit').textContent,'Remover ajuste (manter estilo legado)');
    font.value='inherit';font.dispatchEvent(new TestEvent('change'));
    assert.deepEqual(colors(),beforeColors,type);assert.equal(JSON.stringify(current().style),JSON.stringify(pinned),type);assert.equal(current().appearance,undefined);assert.equal(resolveAppearance(h.state.document,current()).font,'manrope');
    assert.equal(h.state.undo(),true);h.reconcile();assert.equal(JSON.stringify(h.state.document),before);assert.equal(h.state.canUndo,false);
    const full=h.root.querySelectorAll('button').find(n=>n.textContent==='Usar padrão da página — substituir cores e tipografia legadas');assert.ok(full);full.click();
    assert.equal(current().style,undefined);assert.equal(current().appearance,undefined);assert.equal(resolveAppearance(h.state.document,{...current(),type:'rich_text'}).font,'oswald');
    const fontOverride=h.root.querySelectorAll('select').find(n=>n.getAttribute('aria-label')==='Tipografia');fontOverride.value='manrope';fontOverride.dispatchEvent(new TestEvent('change'));
    const inherit=h.root.querySelectorAll('select').find(n=>n.getAttribute('aria-label')==='Tipografia');assert.equal(inherit.querySelectorAll('option').find(n=>n.value==='inherit').textContent,'Usar padrão da página');inherit.value='inherit';inherit.dispatchEvent(new TestEvent('change'));
    assert.equal(resolveAppearance(h.state.document,current()).font,'oswald');assert.equal(current().style,undefined);
  }
});

test('Task13 image/GIF/gallery inapplicable size cannot upgrade a legacy document or create history', async t=>{
  for(const type of ['image','gif','gallery']){
    let initial=createTemplate();if(type==='gallery')initial=upgradeDocument(initial);
    else if(type==='gif'){initial.schema_version=2;initial.template.version=2;}
    const previous=initial.sections[0].rows[0].columns[0].blocks[0],media={media_id:randomUUID(),alt:'Alt',caption:'Caption',credit:'Credit'};
    initial.sections[0].rows[0].columns[0].blocks=[type==='gallery'?{id:previous.id,type,items:[{id:randomUUID(),kind:'image',...media}]}:{id:previous.id,type,...media}];
    validateDocument(initial);
    const h=await harness(t,{document:initial,support:{read_versions:[1,2,3],write_versions:[1,2,3]}}),before=JSON.stringify(h.state.document);
    const size=h.root.querySelectorAll('select').find(n=>n.getAttribute('aria-label')==='Tamanho');assert.equal(size.disabled,true,type);
    size.value='large';size.dispatchEvent(new TestEvent('change'));assert.equal(size.value,'not-applicable');assert.equal(JSON.stringify(h.state.document),before);assert.equal(h.state.canUndo,false);
  }
});

test('V2 loader failure restores shell navigation; retry reenters the dedicated workspace', async t => {
  const h = await harness(t), originalLoader = h.api.workspace;
  h.api.workspace = async () => { throw Object.assign(new Error('Synthetic workspace unavailable'), { status: 404 }); };
  await h.replaceWithoutGuard('?id=missing');
  assert.equal(h.root.ownerDocument.body.classList.contains('pages-editor-active'), false);
  assert.ok(h.root.querySelector('[role="alert"]'));
  h.api.workspace = originalLoader;
  await h.replaceWithoutGuard('?id=first');
  assert.equal(h.root.ownerDocument.body.classList.contains('pages-editor-active'), true);
  assert.ok(h.root.querySelector('.pages-v2-workspace'));
});

test('V2 moved formatting controls reflect caret marks without rebuilding the toolbar', async t => {
  const h = await harness(t), pm = h.editors[0];
  const bold = h.root.querySelector('[data-mark="strong"]'), italic = h.root.querySelector('[data-mark="em"]');
  assert.equal(bold.getAttribute('aria-pressed'), 'false');
  pm.marks.add('strong'); pm.onSelection();
  assert.equal(bold.getAttribute('aria-pressed'), 'true');
  assert.equal(italic.getAttribute('aria-pressed'), 'false');
  pm.marks.delete('strong'); pm.marks.add('em'); pm.onSelection();
  assert.equal(bold.getAttribute('aria-pressed'), 'false');
  assert.equal(italic.getAttribute('aria-pressed'), 'true');
  assert.equal(h.root.querySelector('[data-mark="strong"]'), bold);
  assert.equal(pm.destroyed, 0);
});

test('localized presentation options retain enum values and keyed editors; selection-only updates preserve toolbar controls', async t => {
  const h = await harness(t), pm = h.editors[0];
  h.root.querySelector('.pages-select-block').click();
  const control = name => h.root.querySelector('.pages-legacy-presentation').querySelectorAll('select').find(node => node.getAttribute('aria-label') === name);
  for (const [name, value, label] of [['Alinhamento','center','Centralizado'], ['Escala','large','Grande'], ['Paleta','warm','Quente'], ['Fonte','oswald','Oswald']]) {
    const select = control(name);
    assert.equal(select.querySelectorAll('option').find(node => node.value === value).textContent, label);
    select.value = value; select.dispatchEvent(new TestEvent('change'));
  }
  const block = h.state.document.sections[0].rows[0].columns[0].blocks[0];
  assert.equal(block.style.align, 'center'); assert.equal(block.style.scale, 'large');
  assert.equal(block.style.palette, 'warm'); assert.equal(block.style.font, 'oswald');
  assert.equal(h.editors[0], pm); assert.equal(pm.destroyed, 0);
  const font = control('Fonte'), label = h.root.querySelectorAll('input').find(node => node.getAttribute('aria-label') === 'Nome da seção 1');
  pm.onSelection(); assert.equal(control('Fonte'), font, 'text selection only updates active marks, not toolbar nodes');
  label.value = 'Seção renomeada'; label.dispatchEvent(new TestEvent('input'));
  assert.equal(control('Fonte'), font, 'ordinary metadata changes do not rebuild the selected toolbar');
  assert.ok(h.root.querySelector('.pages-toolbar-presentation'));
  assert.equal(h.root.querySelector('.pages-format-tools').querySelectorAll('.pages-toolbar-group').length, 6);
});

test('button and callout fields display Portuguese options without changing their saved values', async t => {
  const h = await harness(t), pm = h.editors[0];
  const click = text => { h.root.querySelectorAll('button').find(node => node.textContent === 'Inserir bloco').click(); h.root.ownerDocument.querySelectorAll('button').find(node => node.getAttribute('aria-label') === text).click(); };
  const control = name => h.root.querySelectorAll('select').find(node => node.getAttribute('aria-label') === name);
  click('Adicionar botão');
  const preset = control('Estilo do botão');
  assert.equal(preset.querySelectorAll('option').find(node => node.value === 'secondary').textContent, 'Secundário');
  preset.value = 'secondary'; preset.dispatchEvent(new TestEvent('change'));
  assert.equal(h.state.document.sections[0].rows[0].columns[0].blocks.find(block => block.type === 'button').preset, 'secondary');
  click('Adicionar destaque');
  assert.equal(h.root.querySelector('[data-block-type="callout"]').getAttribute('aria-label').split(': ')[1], 'Destaque');
  const tone = control('Tom'); assert.equal(tone.querySelectorAll('option').find(node => node.value === 'attention').textContent, 'Atenção');
  tone.value = 'attention'; tone.dispatchEvent(new TestEvent('change'));
  assert.equal(h.state.document.sections[0].rows[0].columns[0].blocks.find(block => block.type === 'callout').tone, 'attention');
  assert.equal(control('Ícone').querySelectorAll('option').find(node => node.value === 'none').textContent, 'Sem ícone');
  assert.equal(pm.destroyed, 0);
});

test('keyed media fields and load resolver see captions in the current state after composed copy replacement', async t => {
  const h = await harness(t), pm = h.editors[0], pending = await h.upload('video/mp4');
  pending.resolve({ media_id: randomUUID() }); await drain();
  const figure = h.figures[0], before = figure.options.resolveBlock();
  h.root.querySelectorAll('button').find(node => node.textContent === 'Adicionar seção').click();
  assert.notEqual(figure.options.resolveBlock(), before, 'composition really replaced/cloned the document');
  const cues = h.root.querySelectorAll('textarea').find(node => node.getAttribute('aria-label') === 'Legendas sincronizadas JSON');
  cues.value = JSON.stringify([{ start_ms: 0, end_ms: 1000, text: 'Legenda na cópia atual' }]); cues.dispatchEvent(new TestEvent('change'));
  assert.equal(figure.options.resolveBlock().captions[0].text, 'Legenda na cópia atual'); assert.equal(before.captions.length, 0);
  assert.ok(figure.refreshed >= 2); assert.equal(pm.destroyed, 0);
});

test('held upload survives skip-link/hash Back/Forward and completes only on its originating document; disposal cleans resources', async t => {
  const h = await harness(t), origin = h.state, upload = await h.upload();
  assert.equal(origin.uploads, 1); assert.equal(h.page.canLeave(), false);
  await h.pop('?id=first#main-content'); await h.pop('?id=first');
  assert.equal(h.state, origin); assert.equal(origin.uploads, 1); assert.equal(h.workspaces.length, 1);
  upload.resolve({ media_id: randomUUID() }); await drain();
  assert.equal(origin.uploads, 0); assert.equal(origin.document.sections[0].rows[0].columns[0].blocks.length, 2);
  assert.equal(origin.status, 'dirty'); assert.equal(h.figures.length, 1);
  h.page.dispose();
  assert.ok(h.editors.every(editor => editor.destroyed === 1)); assert.equal(h.figures[0].destroyed, 1);
  await h.pop('?id=third'); assert.equal(h.workspaces.length, 1, 'disposed history listener cannot reload');
});

for (const outcome of ['success', 'failure']) {
  test(`stale upload ${outcome} cannot alter a replacement document, retry UI or its pending counter`, async t => {
    const h = await harness(t), origin = h.state, stale = await h.upload();
    // Deliberately supersede the workspace at the loader seam, even though normal
    // navigation is blocked. Late transport callbacks must still be harmless.
    await h.replaceWithoutGuard('?id=second');
    const replacement = h.state, current = await h.upload(), before = h.root.textContent;
    assert.notEqual(replacement, origin); assert.equal(replacement.uploads, 1);
    if (outcome === 'success') stale.resolve({ media_id: randomUUID() }); else stale.reject(new Error('late old failure'));
    await drain();
    assert.equal(origin.uploads, 0); assert.equal(replacement.uploads, 1);
    assert.equal(h.state, replacement); assert.equal(h.retry, null); assert.equal(h.root.textContent, before);
    assert.equal(origin.document.sections[0].rows[0].columns[0].blocks.length, 1);
    assert.equal(replacement.document.sections[0].rows[0].columns[0].blocks.length, 1);
    assert.equal(h.figures.length, 0);
    current.resolve({ media_id: randomUUID() }); await drain();
    assert.equal(replacement.uploads, 0); assert.equal(replacement.document.sections[0].rows[0].columns[0].blocks.length, 2);
  });

  test(`disposal during upload ignores late ${outcome} and balances only its original counter`, async t => {
    const h = await harness(t), origin = h.state, pending = await h.upload(), before = h.root.textContent;
    h.page.dispose();
    if (outcome === 'success') pending.resolve({ media_id: randomUUID() }); else pending.reject(new Error('late disposed failure'));
    await drain();
    assert.equal(origin.uploads, 0); assert.equal(h.root.textContent, before); assert.equal(h.retry, null);
    assert.equal(h.figures.length, 0); assert.ok(h.editors.every(editor => editor.destroyed === 1));
    assert.equal(origin.document.sections[0].rows[0].columns[0].blocks.length, 1);
  });
}

const mediaSupport = { read_versions: [1,2,3], write_versions: [1,2,3] };
function mediaDoc(type, items = []) { const doc = upgradeDocument(createTemplate()); const block = { id: randomUUID(), type, items }; doc.sections[0].rows[0].columns[0].blocks.push(block); return { doc, block }; }
const richAnswer = text => ({ type: 'doc', content: [{ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) }] });
const named = (doc, name, tag = 'button') => doc.querySelectorAll(tag).find(n => n.getAttribute('aria-label') === name || n.textContent === name);

test('gallery serial partial upload retains ACKs; retry uses same key and target; replacement failure/cancel does not mutate refs', async t => {
  const { doc, block } = mediaDoc('gallery'), h = await harness(t, { document: doc, support: mediaSupport }), dom = h.root.ownerDocument;
  const current = () => h.state.document.sections[0].rows[0].columns[0].blocks.find(b => b.id === block.id);
  h.root.querySelectorAll('.pages-select-block')[1].click();
  const picker = named(dom,'Adicionar imagens à galeria','input'), before = JSON.stringify(h.state.document);
  picker.files = []; picker.dispatchEvent(new TestEvent('change')); assert.equal(JSON.stringify(h.state.document),before); assert.equal(h.state.canUndo,false);
  picker.files = [1,2,3].map(i => ({ type: 'image/png', size: 100, name: `${i}.png` })); picker.dispatchEvent(new TestEvent('change')); await drain();
  assert.equal(h.uploads.length,1); assert.equal(current().items.length,0);
  const first = randomUUID(); h.uploads[0].resolve({media_id:first}); await drain(); assert.equal(current().items[0].media_id,first); assert.equal(h.uploads.length,2);
  h.uploads[1].reject(Object.assign(Error('MIME rejected'),{status:415})); await drain(); assert.equal(current().items.length,1); assert.equal(h.uploads.length,2);
  const failedKey = h.uploads[1].key; named(dom,'Tentar upload novamente').click(); await drain(); assert.equal(h.uploads[2].key,failedKey);
  h.uploads[2].resolve({media_id:randomUUID()}); await drain(); assert.equal(current().items.length,2); assert.equal(h.uploads.length,4);
  h.uploads[3].resolve({media_id:randomUUID()}); await drain(); assert.equal(current().items.length,3);
  const itemId=current().items[0].id, firstFields=dom.querySelector(`[data-media-item-id="${itemId}"]`);
  const alt=named(firstFields,'Texto alternativo','input'); alt.value='First alt';alt.dispatchEvent(new TestEvent('input'));
  named(firstFields,'Descer item').click(); assert.equal(current().items[1].id,itemId);
  alt.value='After reorder';alt.dispatchEvent(new TestEvent('input')); assert.equal(current().items[1].alt,'After reorder'); assert.equal(current().items[0].alt,'');
  const replace=named(firstFields,'Substituir imagem da galeria','input'); replace.files=[{type:'image/png',size:100,name:'replace.png'}];replace.dispatchEvent(new TestEvent('change'));await drain();
  h.uploads.at(-1).reject(Error('unknown COMMIT'));await drain();assert.equal(current().items[1].media_id,first);named(dom,'Cancelar upload não confirmado').click();
  assert.equal(current().items[1].media_id,first);validateDocument(h.state.document);
});

test('FAQ views and native questions are item-keyed across reorder, history and long IME; removing/disposal destroys only intended views', async t => {
  const a={id:randomUUID(),question:'First',answer:richAnswer('A')},b={id:randomUUID(),question:'Second',answer:richAnswer('B')};
  const {doc,block}=mediaDoc('faq',[a,b]),h=await harness(t,{document:doc,support:mediaSupport}),dom=h.root.ownerDocument;
  const current=()=>h.state.document.sections[0].rows[0].columns[0].blocks.find(i=>i.id===block.id);
  const editor=h.editors.find(e=>e.itemId===b.id),first=h.editors.find(e=>e.itemId===a.id);editor.onFocus();
  const mark=editor.bookmark();editor.onChange(richAnswer('B edited'),{beforeSelection:mark,selection:mark,closeGroup:true});
  assert.equal(current().items[1].answer.content[0].content[0].text,'B edited');
  const fields=dom.querySelector(`[data-media-item-id="${b.id}"]`);named(fields,'Subir item').click(); assert.equal(current().items[0].id,b.id);
  editor.onChange(richAnswer('B after reorder'),{beforeSelection:mark,selection:mark,closeGroup:true});assert.equal(current().items[0].answer.content[0].content[0].text,'B after reorder');
  assert.equal(editor.historyCommands.undo(),true);assert.equal(editor.content.content[0].content[0].text,'B edited');assert.equal(h.state.selection.itemId,b.id);assert.equal(editor.destroyed,0);assert.equal(first.destroyed,0);
  const question=named(fields,'Pergunta','input');question.dispatchEvent(new TestEvent('compositionstart'));question.value='一';question.dispatchEvent(new TestEvent('input',{isComposing:true}));
  await new Promise(r=>setTimeout(r,650));question.value='一二';question.dispatchEvent(new TestEvent('input',{isComposing:true}));assert.equal(editor.historyCommands.undo(),false);
  question.dispatchEvent(new TestEvent('compositionend'));await drain();assert.equal(editor.historyCommands.undo(),true);assert.equal(question.value,'Second');assert.equal(editor.historyCommands.redo(),true);assert.equal(question.value,'一二');
  named(fields,'Remover item').click();assert.equal(editor.destroyed,1);assert.equal(first.destroyed,0);
  assert.equal(first.historyCommands.undo(),true);assert.equal(current().items.length,2);assert.equal(first.destroyed,0);assert.equal(h.editors.filter(e=>e.itemId===b.id).length,2);
  h.page.dispose();assert.ok(h.editors.every(e=>e.destroyed===1));
});

test('named gallery target removed while waiting retains an ACK for placement; stale/disposed batch cannot upload remaining files', async t => {
  const {doc,block}=mediaDoc('gallery'),h=await harness(t,{document:doc,support:mediaSupport}),dom=h.root.ownerDocument;
  h.root.querySelectorAll('.pages-select-block')[1].click();const picker=named(dom,'Adicionar imagens à galeria','input');
  picker.files=[1,2].map(i=>({type:'image/png',size:100,name:`${i}.png`}));picker.dispatchEvent(new TestEvent('change'));await drain();
  h.state.transact({},d=>{d.sections[0].rows[0].columns[0].blocks=d.sections[0].rows[0].columns[0].blocks.filter(b=>b.id!==block.id);});
  h.uploads[0].resolve({media_id:randomUUID()});await drain();assert.equal(h.uploads.length,1);assert.equal(named(dom,'Escolher destino para arquivo enviado').hidden,false);
  assert.equal(h.state.document.sections[0].rows[0].columns[0].blocks.length,1);
});

test('video source form never persists invalid IDs or raw URLs, capability check precedes upgrade, replacement cancel is inert', async t => {
  const dialogs=[],h=await harness(t,{dialogs,support:mediaSupport}),dom=h.root.ownerDocument;
  const before=JSON.stringify(h.state.document);named(dom,'Inserir bloco').click();named(dom,'Adicionar vídeo').click();assert.equal(dialogs.length,1);assert.equal(JSON.stringify(h.state.document),before);
  const form=dialogs[0],source=named(form.content,'Fonte do vídeo','select'),address=named(form.content,'URL do YouTube','input');source.value='youtube';address.value='https://evil.test/watch?v=dQw4w9WgXcQ';await assert.rejects(form.action(),/URL HTTPS/);assert.equal(JSON.stringify(h.state.document),before);
  address.value='https://youtu.be/dQw4w9WgXcQ?si=discard';await form.action();const embed=h.state.document.sections[0].rows[0].columns[0].blocks.at(-1);assert.equal(embed.type,'video_embed');assert.equal(embed.video_id,'dQw4w9WgXcQ');assert.equal(h.state.document.schema_version,3);assert.equal('url' in embed,false);
  named(dom,'Trocar fonte do vídeo').click();assert.equal(dialogs.length,2);const after=JSON.stringify(h.state.document);assert.equal(JSON.stringify(h.state.document),after);validateDocument(h.state.document);
  const disabledDialogs=[],disabled=await harness(t,{dialogs:disabledDialogs}),disabledDOM=disabled.root.ownerDocument;const legacy=JSON.stringify(disabled.state.document);named(disabledDOM,'Inserir bloco').click();named(disabledDOM,'Adicionar vídeo').click();
  named(disabledDialogs[0].content,'Fonte do vídeo','select').value='youtube';named(disabledDialogs[0].content,'URL do YouTube','input').value='https://youtu.be/dQw4w9WgXcQ';await assert.rejects(disabledDialogs[0].action(),/escrita v3/);assert.equal(JSON.stringify(disabled.state.document),legacy);assert.equal(disabled.state.canUndo,false);
});

test('stale native/file controls from a disposed workspace cannot upload into the next visit even when block IDs repeat', async t => {
  const {doc}=mediaDoc('gallery');doc.sections[0].rows[0].columns[0].blocks.push({id:randomUUID(),type:'faq',items:[]});
  const h=await harness(t,{document:doc,support:mediaSupport}),dom=h.root.ownerDocument;
  h.root.querySelectorAll('.pages-select-block')[1].click();const galleryPicker=named(dom,'Adicionar imagens à galeria','input'),generic=h.root.querySelector('input[type="file"]'),oldAction=named(dom,'Adicionar pergunta');
  await h.replaceWithoutGuard('?id=second');const before=JSON.stringify(h.state.document);
  for(const picker of [galleryPicker,generic]) {picker.files=[{type:'image/png',size:100,name:'old-picker.png'}];picker.dispatchEvent(new TestEvent('change'));}
  oldAction.click();
  await drain();assert.equal(h.uploads.length,0);assert.equal(JSON.stringify(h.state.document),before);
});

test('support removed during gallery registration retains ACK placement instead of mutating an unavailable v3 document', async t => {
  const {doc}=mediaDoc('gallery'),h=await harness(t,{document:doc,support:mediaSupport}),dom=h.root.ownerDocument;
  h.root.querySelectorAll('.pages-select-block')[1].click();const picker=named(dom,'Adicionar imagens à galeria','input'),before=JSON.stringify(h.state.document);
  picker.files=[{type:'image/png',size:100,name:'registered.webp'}];picker.dispatchEvent(new TestEvent('change'));await drain();
  h.state.acknowledge({version:0,document_support:{read_versions:[1,2,3],write_versions:[1,2]}});h.uploads[0].resolve({media_id:randomUUID()});await drain();
  assert.equal(JSON.stringify(h.state.document),before);assert.equal(h.state.canUndo,false);assert.equal(named(dom,'Escolher destino para arquivo enviado').hidden,false);assert.equal(h.uploads.length,1);
});

for (const type of ['gallery','faq']) {
  test(`${type} remove/undo invalidates detached item actions even when the same item ID is restored`, async t => {
    const items=[0,1,2].map(i=>type==='faq'?{id:randomUUID(),question:`Question ${i}`,answer:richAnswer(`Answer ${i}`)}:{id:randomUUID(),kind:'image',media_id:randomUUID(),alt:`Alt ${i}`,caption:'',credit:''});
    const {doc,block}=mediaDoc(type,items),h=await harness(t,{document:doc,support:mediaSupport}),dom=h.root.ownerDocument;
    h.root.querySelectorAll('.pages-select-block')[1].click();
    const current=()=>h.state.document.sections[0].rows[0].columns[0].blocks.find(b=>b.id===block.id),itemId=items[1].id;
    const oldHost=dom.querySelector(`[data-media-item-id="${itemId}"]`),oldActions=['Subir item','Descer item','Remover item'].map(label=>named(oldHost,label));
    const oldPicker=type==='gallery'?named(oldHost,'Substituir imagem da galeria','input'):null;
    const oldReplace=type==='gallery'?named(oldHost,'Substituir imagem da galeria'):null;
    named(oldHost,'Remover item').click();assert.equal(current().items.length,2);
    named(dom,'Desfazer exclusão').click();assert.equal(current().items.length,3);
    const restored=dom.querySelector(`[data-media-item-id="${itemId}"]`);assert.notEqual(restored,oldHost);assert.equal(h.root.contains(oldHost),false);
    const before=h.state.document,selection=JSON.stringify(h.state.selection),history=[h.state.canUndo,h.state.canRedo];
    for(const control of oldActions) {
      control.dispatchEvent(new TestEvent('click'));
      assert.equal(h.state.document,before,`${control.textContent} must not mutate the revived item`);
      assert.deepEqual([h.state.canUndo,h.state.canRedo],history,'stale callback must not consume redo or add history');
      assert.equal(JSON.stringify(h.state.selection),selection);
    }
    // Even accidental reattachment cannot revive this generation's callbacks.
    restored.parentElement.append(oldHost);
    for(const control of oldActions) control.dispatchEvent(new TestEvent('click'));
    assert.equal(h.state.document,before);assert.deepEqual([h.state.canUndo,h.state.canRedo],history);oldHost.remove();
    if(oldPicker) {
      let reopened=0;oldPicker.click=()=>{reopened++;};oldReplace.dispatchEvent(new TestEvent('click'));
      await Promise.resolve();oldPicker.files=[{type:'image/png',size:100,name:'stale.png'}];oldPicker.dispatchEvent(new TestEvent('change'));await drain();
      assert.equal(reopened,0);assert.equal(h.uploads.length,0);assert.equal(h.state.document,before);
    }
    named(restored,'Descer item').click();assert.equal(current().items[2].id,itemId);assert.equal(h.state.canRedo,false);
    named(dom,'Desfazer exclusão').click();assert.equal(current().items[1].id,itemId);
    named(dom.querySelector(`[data-media-item-id="${itemId}"]`),'Remover item').click();assert.equal(current().items.length,2,'replacement controls remain functional');
  });
}

test('a delayed FAQ EditorView callback cannot edit an undo-restored item through its destroyed entry', async t => {
  const item={id:randomUUID(),question:'Question',answer:richAnswer('Original')},{doc,block}=mediaDoc('faq',[item]);
  const h=await harness(t,{document:doc,support:mediaSupport}),dom=h.root.ownerDocument,oldEditor=h.editors.find(e=>e.itemId===item.id);
  named(dom.querySelector(`[data-media-item-id="${item.id}"]`),'Remover item').click();named(dom,'Desfazer exclusão').click();
  const before=h.state.document,history=[h.state.canUndo,h.state.canRedo];assert.equal(oldEditor.destroyed,1);
  await Promise.resolve();oldEditor.onChange(richAnswer('Late old view'),{selection:oldEditor.bookmark(),beforeSelection:oldEditor.bookmark()});
  assert.equal(h.state.document,before);assert.deepEqual([h.state.canUndo,h.state.canRedo],history);
  const liveEditor=h.editors.filter(e=>e.itemId===item.id).at(-1);assert.notEqual(liveEditor,oldEditor);
  liveEditor.onChange(richAnswer('Current view'),{selection:liveEditor.bookmark(),beforeSelection:liveEditor.bookmark()});
  assert.equal(h.state.document.sections[0].rows[0].columns[0].blocks.find(b=>b.id===block.id).items[0].answer.content[0].content[0].text,'Current view');
});

test('a gallery replace ACK from a discarded item generation cannot replace its recreated same-ID item', async t => {
  const item={id:randomUUID(),kind:'image',media_id:randomUUID(),alt:'Original',caption:'',credit:''},{doc,block}=mediaDoc('gallery',[item]);
  const h=await harness(t,{document:doc,support:mediaSupport}),dom=h.root.ownerDocument;
  h.root.querySelectorAll('.pages-select-block')[1].click();const picker=named(dom,'Substituir imagem da galeria','input');
  picker.files=[{type:'image/png',size:100,name:'late-replace.png'}];picker.dispatchEvent(new TestEvent('change'));await drain();assert.equal(h.uploads.length,1);
  // Normal UI blocks history during an upload. Simulate reconciliation at the
  // state seam to prove the asynchronous target also retains entry identity.
  h.state.transact({},d=>{d.sections[0].rows[0].columns[0].blocks.find(b=>b.id===block.id).items=[];});h.reconcile();
  h.state.transact({},d=>{d.sections[0].rows[0].columns[0].blocks.find(b=>b.id===block.id).items=[structuredClone(item)];});h.reconcile();
  const before=h.state.document;h.uploads[0].resolve({media_id:randomUUID()});await drain();
  assert.equal(h.state.document,before);assert.equal(h.state.document.sections[0].rows[0].columns[0].blocks.find(b=>b.id===block.id).items[0].media_id,item.media_id);
  assert.equal(named(dom,'Escolher destino para arquivo enviado').hidden,false,'known ACK retains explicit placement recovery');assert.equal(h.uploads.length,1);assert.equal(h.retry,null);
});
