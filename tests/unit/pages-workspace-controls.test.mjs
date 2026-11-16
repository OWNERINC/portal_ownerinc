import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
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
