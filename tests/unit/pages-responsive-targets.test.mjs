import test from 'node:test';
import assert from 'node:assert/strict';
import { assertResponsiveTargets } from '../visual/pages-editor-responsive-targets.mjs';

const geometry=()=>({width:640,tools:{y:100,bottom:156},viewport:{y:200},overflow:false,controls:[{
  name:'Native select',x:24,y:106,right:68,bottom:150,width:44,height:44,disabled:false,
  target:{x:24,y:106,right:68,bottom:150,width:44,height:44},edges:[{hit:true},{hit:true},{hit:true},{hit:true}],
}]});
const failures=g=>{const errors=[];assertResponsiveTargets(g,(ok,message)=>{if(!ok)errors.push(message);},'all zooms');return errors;};

test('the shared matrix target assertions reject clipping, overlap and native-select edge misses',()=>{
  assert.deepEqual(failures(geometry()),[]);
  const edge=geometry();edge.controls[0].edges[2].hit=false;
  assert.ok(failures(edge).some(m=>m.includes('target edge hits Native select')));
  const overlap=geometry();overlap.controls.push({...overlap.controls[0],name:'Neighbor'});
  assert.ok(failures(overlap).some(m=>m.includes('adjacent toolbar targets overlap')));
  const clip=geometry();clip.controls[0].target.bottom=160;
  assert.ok(failures(clip).some(m=>m.includes('effective target local containment')));
});

test('disabled controls cannot waive target geometry or collisions',()=>{
  const g=geometry();g.controls[0].disabled=true;g.controls[0].edges[0].hit=false;
  assert.deepEqual(failures(g),[],'disabled edge samples are recorded, not claimed activatable');
  g.controls[0].target.width=43;
  assert.ok(failures(g).some(m=>m.includes('44px target')));
  g.controls.push({...g.controls[0],name:'Disabled neighbor'});
  assert.ok(failures(g).some(m=>m.includes('adjacent toolbar targets overlap')));
});
