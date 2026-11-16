import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { FixtureNode, TestEvent } from '../helpers/frontend-feedback-harness.mjs';
const require = createRequire(import.meta.url);
const { createTemplate, listTemplates } = require('../../api/pages/templates');
const { validateDocument, validateMutation } = require('../../api/pages/validation');
const {typographyMetrics,appearanceIssues}=require('../../api/pages/appearance');
async function controls() {
  const source = (await readFile('public/pages/editor-workspace.js','utf8')).replace(/^import[^\n]+\n/gm,'').replace(/^export /gm,'');
  const context = vm.createContext({});
  vm.runInContext(`${source}\nglobalThis.controls={createModelDraftController,viewportGeometry};`,context);
  return context.controls;
}
test('guide is a real independently allocated v3 recipe, filtered by the default-off writer', () => {
  assert.equal(listTemplates().some(t=>t.id==='guia-interno'),false);
  assert.equal(listTemplates({v3WritesEnabled:true}).find(t=>t.id==='guia-interno')?.schema_version,3);
  const a=createTemplate('guia-interno'), b=createTemplate('guia-interno');
  assert.equal(a.schema_version,3); assert.equal(a.sections.length,5);
  assert.notEqual(a.sections[0].id,b.sections[0].id);
  assert.deepEqual(a.metadata.audience.job_title_ids,[]);
  assert.match(a.metadata.summary,/ilustrativo|oficial/i);
  assert.doesNotThrow(()=>validateDocument(a));
  assert.doesNotThrow(()=>validateMutation({template_id:'guia-interno',client_mutation_id:'e2d00000-0000-4000-8000-000000000001'},'create'));
});
test('guide sizes are canonical, including the real cover AA size; non-guide and legacy styles stay unchanged',()=>{
  const doc=createTemplate('guia-interno'),cover=doc.sections[0].rows[0].columns[0].blocks[0],intro=doc.sections[1].rows[0].columns[0].blocks[0];
  assert.equal(typographyMetrics(doc,cover).h2,36);assert.equal(typographyMetrics(doc,intro).body,15);
  cover.content.content=[{type:'heading',attrs:{level:2},content:[{type:'text',text:'Large AA',marks:[{type:'text_color',attrs:{color:'#888888'}}]}]}];
  assert.equal(appearanceIssues(doc).some(i=>i.path.startsWith('sections[0]')),false,'36px cover uses large-text AA, not fictitious 20px');
  doc.presentation.defaults.foreground='#888888';assert.equal(appearanceIssues(doc).some(i=>i.path==='metadata.title'),true,'compact shared metadata title really is 14px, so requires normal-text AA');doc.presentation.defaults.foreground='#26204A';
  cover.style={font:'manrope',align:'start',scale:'standard',palette:'neutral'};
  assert.equal(typographyMetrics(doc,cover).h2,20);assert.equal(typographyMetrics(doc,cover).body,16);
  doc.template.id='comunicado';delete cover.style;assert.equal(typographyMetrics(doc,cover).h2,20);
});
test('model creation never creates on open; cancel keeps state; ambiguous retry reuses key and navigation retry reuses ACK', async () => {
  const {createModelDraftController}=await controls(); let allow=false, calls=[], navigations=[], n=0, fail=true, busy=[];
  const controller=createModelDraftController({newId:()=>`key-${++n}`,canAct:()=>true,beforeCreate:()=>allow,
    create:async payload=>{calls.push({...payload});if(fail)throw Error('lost ACK');return{id:'new-draft'};},
    navigate:async ack=>{navigations.push(ack.id);return false;},onBusy:value=>busy.push(value)});
  assert.equal(calls.length,0);
  assert.equal(await controller.choose('guia-interno'),false);assert.equal(calls.length,0);
  allow=true;await assert.rejects(controller.choose('guia-interno'),/lost ACK/);
  fail=false;await controller.choose('guia-interno');await controller.choose('guia-interno');
  assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1]);assert.equal(n,1);
  assert.deepEqual(navigations,['new-draft','new-draft']);assert.deepEqual(busy,[true,false,true,false,true,false]);
});
test('model duplicate/inactive actions cannot create and a late disposed ACK cannot navigate', async () => {
  const {createModelDraftController}=await controls();let resolve,calls=0,navigated=0;
  const c=createModelDraftController({newId:()=> 'one',canAct:()=>true,beforeCreate:()=>true,create:()=>{calls++;return new Promise(r=>resolve=r);},navigate:()=>navigated++,onBusy:()=>{}});
  const pending=c.choose('comunicado');assert.equal(await c.choose('comunicado'),false);assert.equal(calls,1);
  c.dispose();resolve({id:'new'});await pending;assert.equal(navigated,0);
});
test('five zooms measure scaled scroll extents without modifying content and mobile is exactly 390 CSS pixels', async () => {
  const {viewportGeometry}=await controls();
  for(const zoom of [50,75,100,125,150])for(const available of [810,1044]){
    const desktop=viewportGeometry({device:'desktop',zoom,available,height:944});
    assert.equal(desktop.width,available);assert.equal(desktop.scaledWidth,available*zoom/100);assert.equal(desktop.scaledHeight,944*zoom/100);
    assert.equal(viewportGeometry({device:'mobile',zoom,available,height:944}).width,390);
  }
  assert.throws(()=>viewportGeometry({device:'desktop',zoom:90,available:1044,height:944}));
});

async function structureHarness(t) {
  const document = new FixtureNode('document'); document.ownerDocument = document;
  document.createElement = tag => new FixtureNode(tag, document);
  document.createElementNS = (_, tag) => document.createElement(tag);
  document.body = document.createElement('body'); document.append(document.body);
  const window = new FixtureNode('window', document);
  window.matchMedia = () => Object.assign(new FixtureNode('media', document), { matches: false });
  const root = document.createElement('div'); document.body.append(root);
  const calls = [], sortables = [], observers = []; let allowed = true;
  class ResizeObserver {
    nodes = new Set();
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(node) { this.nodes.add(node); }
    unobserve(node) { this.nodes.delete(node); }
    disconnect() { this.nodes.clear(); }
  }
  const context = vm.createContext({ document, window, ResizeObserver, applyBlockStyle() {}, restoreVisibleFocus() {},
    openEditorPanel({ content }) { const dialog = document.createElement('dialog'); document.body.append(dialog); dialog.append(content); return { close() { dialog.remove(); } }; },
  });
  for (const [file, names] of [['dom','el,button'], ['editor-workspace','createEditorWorkspace']]) {
    const source = (await readFile(`public/pages/${file}.js`, 'utf8')).replace(/^import[^\n]+\n/gm,'').replace(/^export /gm,'');
    vm.runInContext(`(() => { ${source}\nObject.assign(globalThis,{${names}}); })()`, context);
  }
  const doc = createTemplate('guia-interno');
  const options = Object.fromEntries(['header','actions','metadata','modes','toolbar','editorHost','previewHost','add','feedback'].map(key => [key, document.createElement('div')]));
  const primary = document.createElement('div'); primary.className = 'pages-primary-actions'; options.header.append(primary);
  const workspace = context.createEditorWorkspace({ ...options, root, page: {}, canReorder: () => allowed,
    sortableFactory(host, config) { const sortable = { host, config, destroy() {} }; sortables.push(sortable); return sortable; },
    onReorderSection(value) { calls.push(JSON.parse(JSON.stringify(value))); return true; },
  });
  workspace.refresh(doc, true); workspace.rebuildStructure(doc); t.after(() => workspace.dispose());
  return { workspace, root, document, doc, calls, sortables, observers, allow(value) { allowed = value; } };
}

test('context clearance reserves measured unscaled toolbar height at every zoom and device', async t => {
  const h = await structureHarness(t);
  const tools = h.document.createElement('div'), block = h.document.createElement('div');
  h.root.append(block);
  const surface = h.root.querySelector('.pages-editor-surface');
  for (const height of [52, 96]) {
    tools.offsetHeight = height;
    h.workspace.placeContextTools(tools, block);
    for (const device of ['desktop', 'mobile']) for (const zoom of [50,75,100,125,150]) {
      h.workspace.setViewport({ device, zoom });
      const reserved = parseFloat(surface.style.getPropertyValue('--pages-context-space'));
      assert.equal(reserved, Math.max(44 / (zoom / 100) + 28, (height + 4) / (zoom / 100) + 16), `${device}/${zoom}: measured ${height}px toolbar`);
      assert.ok(reserved * zoom / 100 > height + 16 * zoom / 100, 'text clears toolbar anchored 16 scaled pixels inside block');
    }
  }
  const observer = h.observers.find(item => item.nodes.has(tools));
  assert.ok(observer, 'toolbar metrics are observed, not assumed stable after mount');
  h.workspace.setViewport({ device: 'desktop', zoom: 50 });
  tools.offsetHeight = 120; observer.callback();
  assert.equal(parseFloat(surface.style.getPropertyValue('--pages-context-space')), 264);
  h.workspace.placeContextTools(null, null);
  assert.equal(observer.nodes.has(tools), false, 'retired toolbar is unobserved');
  h.workspace.placeContextTools(tools, block); h.workspace.dispose();
  assert.ok(h.observers.every(item => item.nodes.size === 0), 'disposal disconnects all measurement observers');
});

test('organizing state travels with the structure through dialog reparenting and rebuilds', async t => {
  const h = await structureHarness(t), structure = h.workspace.structure;
  const organize = structure.querySelectorAll('button').find(n => n.getAttribute('aria-label') === 'Organizar estrutura');
  assert.equal(structure.dataset.organizing, 'false');
  organize.click(); assert.equal(structure.dataset.organizing, 'true'); assert.equal(h.root.dataset.organizing, 'true');
  h.root.querySelector('.pages-structure-toggle').click();
  assert.equal(structure.parentElement.tagName, 'DIALOG');
  organize.click(); assert.equal(structure.dataset.organizing, 'false'); assert.equal(h.root.dataset.organizing, 'false');
  organize.click(); h.workspace.rebuildStructure(h.doc); assert.equal(structure.dataset.organizing, 'true');
  assert.equal(organize.getAttribute('aria-pressed'), 'true');
});

test('section actions preserve UUID reorder contract, boundaries, permission and keyboard focus', async t => {
  const h = await structureHarness(t), entries = h.workspace.structure.querySelectorAll('.pages-v2-section-entry');
  assert.equal(entries[0].querySelector('details').className, 'pages-v2-section-position');
  assert.equal(entries[0].querySelectorAll('button').find(n => n.getAttribute('aria-label') === 'Subir seção Capa').disabled, true);
  const down = entries[0].querySelectorAll('button').find(n => n.getAttribute('aria-label') === 'Descer seção Capa'); down.click();
  assert.deepEqual(h.calls.pop(), { sectionId: h.doc.sections[0].id, beforeSectionId: h.doc.sections[2].id });
  assert.equal(h.document.activeElement.dataset.structureSection, h.doc.sections[0].id);
  const link = entries[1].querySelector('[data-structure-section]');
  link.dispatchEvent(new TestEvent('keydown', { altKey: true, key: 'ArrowUp' }));
  assert.deepEqual(h.calls.pop(), { sectionId: h.doc.sections[1].id, beforeSectionId: h.doc.sections[0].id });
  const handle = entries[0].querySelector('.pages-section-drag-handle');
  handle.dispatchEvent(new TestEvent('keydown', { altKey: true, key: 'ArrowUp' })); assert.equal(h.calls.length, 0);
  h.allow(false); down.click(); assert.equal(h.calls.length, 0);
  const sortable = h.sortables.at(-1); assert.equal(sortable.config.onMove(), false);
  const before = [...sortable.host.children]; sortable.host.append(before[0]);
  sortable.config.onEnd({ item: before[0] }); assert.deepEqual([...sortable.host.children], before);
  assert.equal(h.document.activeElement.dataset.structureSection, h.doc.sections[0].id);
});
