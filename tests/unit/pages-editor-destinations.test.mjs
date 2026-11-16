import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { destinationCandidate } from '../../public/pages/editor-destinations.js';
import { pageDocument } from '../database/check-pages.mjs';
import { genericBlock } from '../../public/pages/composition.js';
import { validateDocument } from '../../api/pages/validation.js';

function fixture() {
  const document=pageDocument(), button=genericBlock('button');
  document.schema_version=2; document.template.version=2;
  document.sections[0].rows[0].columns[0].blocks.push(button);
  return {document,button};
}
test('each registered download kind upgrades atomically and passes the independent strict server validator',()=>{
  for(const [kind,extension] of [['image','webp'],['gif','gif'],['audio','mp3'],['video','mp4']]) {
    const {document,button}=fixture(), before=JSON.stringify(document), media=[{id:randomUUID(),kind}];
    const action={type:'download',media_id:media[0].id,kind,file_name:`Material.${extension}`};
    const next=destinationCandidate(document,button.id,action,media,true);
    assert.ok(next); assert.equal(next.schema_version,3); validateDocument(next);
    assert.equal(JSON.stringify(document),before);
    assert.equal(destinationCandidate(document,button.id,action,media,false),null);
    assert.equal(destinationCandidate(next,button.id,action,media,true),null,'no-op does not create history');
    for(const file_name of ['../file.'+extension,'a\\b.'+extension,'a\u0085.'+extension,'.'+extension,' .'+extension,'a.pdf','a.'+extension.toUpperCase(),'a'.repeat(121)+'.'+extension])
      assert.equal(destinationCandidate(document,button.id,{...action,file_name},media,true),null,file_name);
    assert.equal(destinationCandidate(document,button.id,action,[],true),null,'missing/foreign inventory');
    assert.equal(destinationCandidate(document,button.id,{...action,kind:'pdf'},media,true),null);
    assert.equal(destinationCandidate(document,button.id,action,[{...media[0],kind:kind==='audio'?'video':'audio'}],true),null);
  }
});
test('video actions resolve only live same-document video/embed IDs; URL/section retain legacy version',()=>{
  const {document,button}=fixture();
  const video={id:randomUUID(),type:'video',media_id:randomUUID(),title:'Vídeo',transcript:'Texto',captions:[]};
  document.sections[0].rows[0].columns[0].blocks.push(video);
  const action={type:'video',value:video.id};
  validateDocument(destinationCandidate(document,button.id,action,[],true));
  for(const value of [randomUUID(),button.id,document.sections[0].id]) assert.equal(destinationCandidate(document,button.id,{...action,value},[],true),null);
  assert.equal(destinationCandidate(document,button.id,action,[],false),null);
  const legacy=destinationCandidate(document,button.id,{type:'section',value:document.sections[0].id},[],false);
  assert.equal(legacy.schema_version,2); validateDocument(legacy);
  const v3=destinationCandidate(document,button.id,action,[],true);
  const target=v3.sections[0].rows[0].columns[0].blocks.find(b=>b.id===video.id);
  delete target.media_id; delete target.captions; Object.assign(target,{type:'video_embed',provider:'youtube',video_id:'aaaaaaaaaaa'});
  const changed=destinationCandidate(v3,button.id,{type:'url',value:'/pages.html'},[],true);
  validateDocument(destinationCandidate(changed,button.id,action,[],true));
  assert.equal(destinationCandidate(document,button.id,{type:'url',value:'javascript:alert(1)'},[],true),null);
});
