import test from 'node:test';
import assert from 'node:assert/strict';
import { styleDefaults, normalizeDefaults, parseLocalTags, styleCandidate, themePalettes, createInspector, openStylePanel, openInlineColorPanel } from '../../public/pages/editor-style.js';
import { pageDocument } from '../database/check-pages.mjs';
import { upgradeDocument } from '../../public/pages/document-v3.js';
import { resolveAppearance } from '../../public/pages/appearance.js';
import { validateDocument } from '../../api/pages/validation.js';
import { FixtureNode, TestEvent, drain } from '../helpers/frontend-feedback-harness.mjs';
import { referenceDocument } from '../helpers/pages-reference-document.mjs';

function dom(t){
  const previous={document:globalThis.document,window:globalThis.window};
  const doc=new FixtureNode('document');doc.ownerDocument=doc;doc.documentElement=doc;
  doc.createElement=tag=>new FixtureNode(tag,doc);doc.body=doc.createElement('body');doc.append(doc.body);doc.activeElement=doc.body;
  globalThis.document=doc;globalThis.window=new FixtureNode('window',doc);
  t.after(()=>{globalThis.document=previous.document;globalThis.window=previous.window;});
  return {doc,page:{active:true,cleanup(){}}};
}

test('image/GIF/gallery size is explicitly inapplicable in its ordered inspector slot', t=>{
  const {doc}=dom(t);
  for(const type of ['image','gif','gallery']){
    const document=upgradeDocument(pageDocument('Media size')),block=document.sections[0].rows[0].columns[0].blocks[0];block.type=type;
    const before=JSON.stringify(document),changes=[];
    const inspector=createInspector({document,block,onAppearance:patch=>changes.push(patch)});doc.body.append(inspector.node);
    assert.deepEqual(inspector.node.children.slice(0,4).map(n=>n.firstElementChild.textContent),['Tipografia','Tamanho','Alinhamento','Largura']);
    const size=inspector.node.querySelectorAll('select').find(n=>n.getAttribute('aria-label')==='Tamanho');
    assert.equal(size.disabled,true,type);assert.equal(size.value,'not-applicable');
    assert.match(size.parentElement.textContent,/14 px/);
    size.value='large';size.dispatchEvent(new TestEvent('change'));assert.deepEqual(changes,[]);assert.equal(size.value,'not-applicable');
    assert.equal(JSON.stringify(document),before);inspector.dispose();inspector.node.remove();
  }
});

test('guide size options describe each prospective scale, including returning from small/large to standard', t=>{
  const {doc}=dom(t), document=referenceDocument();
  const blocks=document.sections.flatMap(s=>s.rows.flatMap(r=>r.columns.flatMap(c=>c.blocks)));
  for(const [index, standard] of [[0,14],[1,15],[2,13],[4,12],[5,12]]){
    const block=blocks[index];
    for(const scale of ['standard','small','standard','large','standard']){
      block.appearance={...block.appearance,scale};
      const before=JSON.stringify(document);
      const inspector=createInspector({document,block});doc.body.append(inspector.node);
      const size=inspector.node.querySelectorAll('select').find(n=>n.getAttribute('aria-label')==='Tamanho');
      const options=Object.fromEntries(size.children.map(n=>[n.getAttribute('value'),n.textContent]));
      assert.equal(options.standard,`Texto do modelo · ${standard} px`,`${block.type} currently ${scale}`);
      assert.match(options.small,/14 px$/);assert.match(options.large,/19,2 px$/);
      assert.equal(JSON.stringify(document),before,'building prospective labels cannot change appearance');
      inspector.dispose();inspector.node.remove();
    }
  }
});

for(const kind of ['page','inline'])test(`${kind} hex IME end + immediate final input reconciles local validity after native cleanup`,async t=>{
  const {doc,page}=dom(t),document=pageDocument('IME local'),before=JSON.stringify(document),applied=[];let composing=false;
  const bindNative=control=>{
    control.addEventListener('compositionstart',()=>{composing=true;});
    control.addEventListener('compositionend',()=>queueMicrotask(()=>{composing=false;}));
  };
  const panel=kind==='page'?openStylePanel({page,document,onApply:value=>applied.push(value),canAct:()=>!composing,bindNative}):openInlineColorPanel({page,mark:'text_color',onApply:value=>applied.push(value),canAct:()=>!composing,bindNative});
  const input=panel.dialog.querySelector('input'),apply=panel.dialog.querySelectorAll('button').find(n=>n.textContent===(kind==='page'?'✓ Aplicar estilo':'Aplicar cor'));
  input.value='bad';input.dispatchEvent(new TestEvent('input'));assert.equal(apply.disabled,true);
  input.dispatchEvent(new TestEvent('compositionstart'));input.value='#112233';input.dispatchEvent(new TestEvent('input',{isComposing:true}));
  apply.dispatchEvent(new TestEvent('click'));assert.deepEqual(applied,[]);
  input.dispatchEvent(new TestEvent('compositionend'));input.value='#112233';input.dispatchEvent(new TestEvent('input',{isComposing:false}));
  await drain();assert.equal(apply.disabled,false);assert.equal(input.getAttribute('aria-invalid'),'false');assert.equal(JSON.stringify(document),before);
  apply.click();assert.equal(applied.length,1);assert.equal(kind==='page'?applied[0].accent:applied[0],'#112233');panel.close();
});

test('style draft preserves legacy defaults and explicit white; palettes contain actual three source colors', () => {
  const doc = pageDocument('Styles'), before = JSON.stringify(doc);
  assert.equal(styleDefaults(doc).background, '#FFFEFB');
  const v3 = upgradeDocument(doc); v3.presentation.defaults.background = '#FFFFFF';
  assert.equal(styleDefaults(v3).background, '#FFFFFF');
  assert.deepEqual(themePalettes.conecta.colors, ['#2A275E','#E84F1C','#F7F6F2']);
  assert.equal(JSON.stringify(doc), before);
  assert.equal(normalizeDefaults({ ...styleDefaults(v3), accent: ' #abcdef ' }).accent, '#ABCDEF');
  assert.equal(normalizeDefaults({ ...styleDefaults(v3), accent: 'url(x)' }), null);
  assert.equal(normalizeDefaults({ ...styleDefaults(v3), scale: '20px' }), null);
});

test('local tags reject empty, repeated, oversized and NUL without silently saving a different value', () => {
  assert.deepEqual(parseLocalTags(' Cultura , Guia '), ['Cultura','Guia']);
  assert.deepEqual(parseLocalTags(''), []);
  for (const raw of ['a,,b', 'a,a', 'a,', 'x'.repeat(41), 'x\0', Array.from({length:21},(_,i)=>String(i)).join(',')]) assert.equal(parseLocalTags(raw), null);
});

test('style candidate is atomic, validated, opt-in and preserves pinned overrides', () => {
  const doc = pageDocument('Styles'), before = JSON.stringify(doc), block = doc.sections[0].rows[0].columns[0].blocks[0];
  assert.equal(styleCandidate(doc, next => { next.presentation.defaults.accent = next.presentation.defaults.accent; }), null);
  const next = styleCandidate(doc, next => { next.presentation.defaults.font = 'oswald'; });
  validateDocument(next); assert.equal(next.schema_version, 3); assert.equal(JSON.stringify(doc), before);
  assert.equal(resolveAppearance(next, next.sections[0].rows[0].columns[0].blocks[0]).font, 'manrope');
  const inherit = styleCandidate(next, value => { delete value.sections[0].rows[0].columns[0].blocks[0].style; });
  assert.equal(resolveAppearance(inherit, inherit.sections[0].rows[0].columns[0].blocks[0]).font, 'oswald');
  assert.equal(block.appearance, undefined);
  assert.equal(styleCandidate(doc, value => { value.sections[0].rows[0].columns[0].blocks[0].tags = ['x'.repeat(41)]; }), null);
  assert.equal(styleCandidate(doc, value => { value.presentation.defaults.foreground = 'url(x)'; }), null);
});

test('style and inline candidates cannot exceed aggregate v3 accounting after upgrade', () => {
  const doc=pageDocument('Budget');
  doc.sections[0].rows[0].columns[0].blocks[0].content.content[0].content[0].text='x'.repeat(99500);
  validateDocument(doc);const before=JSON.stringify(doc);
  assert.equal(styleCandidate(doc,value=>{value.sections[0].rows[0].columns[0].blocks[0].tags=Array.from({length:20},(_,i)=>'y'.repeat(38)+i);}),null);
  assert.equal(JSON.stringify(doc),before);
  for(const key of ['font','scale','align','foreground','background','accent','icon'])assert.equal(styleCandidate(doc,value=>{value.sections[0].rows[0].columns[0].blocks[0].appearance={[key]:'arbitrary-css'};}),null,key);
});

test('generic appearance icon does not collide with the callout legacy icon', () => {
  const doc=upgradeDocument(pageDocument('Callout'));
  const block=doc.sections[0].rows[0].columns[0].blocks[0];Object.assign(block,{type:'callout',tone:'info',icon:'alert'});
  const next=styleCandidate(doc,value=>{value.sections[0].rows[0].columns[0].blocks[0].appearance={icon:'coffee'};});
  validateDocument(next);const current=next.sections[0].rows[0].columns[0].blocks[0];assert.equal(current.icon,'alert');assert.equal(current.appearance.icon,'coffee');
});
