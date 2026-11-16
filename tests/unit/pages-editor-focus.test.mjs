import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=(await readFile('public/pages/editor-panels.js','utf8')).replace(/^import[^\n]+\n/gm,'').replace(/^export /gm,'');
function harness() {
  const window={innerWidth:390,innerHeight:820,visualViewport:{width:390,height:430,offsetLeft:0,offsetTop:24},getComputedStyle:n=>({visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible',...n.style})};
  const context=vm.createContext({window});vm.runInContext(source,context);
  const node=(rect,parentElement=null,style={})=>({isConnected:true,disabled:false,style,parentElement,closest:()=>null,getClientRects:()=>[rect],getBoundingClientRect:()=>rect,focus(){},matches:()=>true});
  return {context,node,window};
}
const box=(left,top,width,height)=>({left,top,right:left+width,bottom:top+height,width,height});

test('focus targets intersect the visual viewport, not merely the layout viewport',()=>{
  const {context,node}=harness();
  assert.equal(context.visibleFocusTarget(node(box(20,100,100,40))),true);
  assert.equal(context.visibleFocusTarget(node(box(20,500,100,40))),false,'below reduced viewport');
  assert.equal(context.visibleFocusTarget(node(box(20,-100,100,40))),false,'scrolled above viewport');
  assert.equal(context.visibleFocusTarget(node(box(20,0,100,20))),false,'above offsetTop');
  assert.equal(context.visibleFocusTarget(node(box(20,-27,100,74))),false,'a small sliver of an otherwise clipped editor is not a visible return target');
  assert.equal(context.visibleFocusTarget(node(box(400,100,100,40))),false,'horizontal offscreen');
});

test('clipped and visually hidden openers cannot win over a visible fallback',()=>{
  const {context,node}=harness();
  const clip=node(box(0,100,200,100),null,{overflowY:'hidden'});
  assert.equal(context.visibleFocusTarget(node(box(20,220,100,40),clip)),false);
  assert.equal(context.visibleFocusTarget(node(box(20,120,100,40),clip)),true);
  assert.equal(context.visibleFocusTarget(node(box(20,120,100,40),null,{visibility:'hidden'})),false);
  assert.equal(context.visibleFocusTarget(node(box(20,120,100,40),null,{opacity:'0'})),false);
});

test('close focus prefers an already visible fallback, otherwise reveals a retained target in the reduced viewport',()=>{
  const {context,node,window}=harness(),offscreen=node(box(20,-200,100,60)),fallback=node(box(20,40,44,44));
  let focused;
  offscreen.focus=()=>{focused=offscreen;};fallback.focus=()=>{focused=fallback;};
  assert.equal(context.restoreVisibleFocus([offscreen,fallback]),fallback);assert.equal(focused,fallback);
  let y=-200,scrolled=0;
  offscreen.getBoundingClientRect=()=>box(20,y,100,60);
  offscreen.scrollIntoView=()=>{scrolled++;y=380;};
  window.scrollBy=({top})=>{y-=top;};
  assert.equal(context.restoreVisibleFocus([offscreen]),offscreen);assert.equal(focused,offscreen);assert.equal(scrolled,1);
  const visible=offscreen.getBoundingClientRect();assert.ok(visible.top>=24&&visible.bottom<=454);
});
