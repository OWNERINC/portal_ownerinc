import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorState } from '../../public/pages/state.js';
import { createReviewSession, reviewURL } from '../../public/pages/editor-review.js';
import { referenceDocument } from '../helpers/pages-reference-document.mjs';

function setup(edit = true) {
  const state = createEditorState({ id: 'page-id', version: 7, slug: null, draft_revision_id: 'r7',
    capabilities: { edit, publish: true }, document_support: { write_versions: [1,2,3] }, draft: { document: referenceDocument() } });
  return { state, review: createReviewSession(state) };
}
test('each revisioned review field invalidates checks and exact snapshot until save ACK', async () => {
  for (const key of ['title','category','audience']) {
    const { state, review } = setup(); review.check(0, true);
    state.transact({group:`review:${key}`}, doc => { doc.metadata[key] = key === 'audience' ? {type:'job_titles',job_title_ids:[]} : 'Updated'; });
    review.refresh(); assert.deepEqual(review.snapshot.checks, [false,false,false]); assert.equal(review.ready, false);
    assert.equal(state.workspace.draft_revision_id, 'r7'); assert.throws(() => review.payload());
    await state.save({save:async()=>({version:8,draft_revision_id:'r8',slug:'confirmed'})});
    review.refresh(); assert.equal(review.snapshot.revisionId,'r8'); assert.equal(review.ready,true);
    assert.deepEqual(review.snapshot.checks,[false,false,false]);
    assert.deepEqual(review.payload(), {expected_version:8,revision_id:'r8',client_mutation_id:review.pending.client_mutation_id});
  }
});
test('external content/version changes, uploads and failures reset personal checks; stale remote head is never adopted', () => {
  const {state,review}=setup(); review.check(1,true); state.uploadStart(); review.refresh();
  assert.equal(review.ready,false); assert.deepEqual(review.snapshot.checks,[false,false,false]); state.uploadEnd(); review.refresh();
  review.check(2,true); state.workspace.version++; review.refresh(); assert.deepEqual(review.snapshot.checks,[false,false,false]);
  review.check(0,true); review.verify({version:99,draft_revision_id:'other',draft:{document:state.document}});
  assert.equal(review.ready,false); assert.equal(state.workspace.draft_revision_id,'r7'); assert.deepEqual(review.snapshot.checks,[false,false,false]);
});
test('failed and ambiguous publication keep frozen exact CAS/key; re-open can reuse session; conflict blocks retry', () => {
  const {state,review}=setup(); const payload=review.payload(); review.failed(new Error('ACK lost'));
  assert.equal(review.uncertain,true); assert.equal(review.payload(),payload); assert.ok(Object.isFrozen(payload));
  assert.throws(()=>{payload.revision_id='new';},TypeError);
  assert.equal(review.verify({version:8,draft_revision_id:'r7',draft:{document:state.document}}),true,'uncertain retry must reconcile its receipt rather than preflight the consumed CAS');
  assert.equal(review.payload(),payload); review.failed({status:409}); assert.equal(review.ready,false); assert.throws(()=>review.payload());
});
test('personal checks are optional, copied, never persist or authorize; publisher-only can review saved revision', () => {
  const {state,review}=setup(false); const bytes=JSON.stringify(state.document); assert.equal(review.ready,true);
  review.check(0,true); review.snapshot.checks[0]=false; assert.equal(review.snapshot.checks[0],true);
  assert.equal(state.transact({},doc=>{doc.metadata.title='bad';}),false); assert.equal(JSON.stringify(state.document),bytes);
  assert.equal(review.payload().revision_id,'r7'); review.failed({status:400}); assert.equal(review.uncertain,false);
});
test('only confirmed alias is shown; title never fabricates an URL', () => {
  const {state}=setup(); assert.equal(reviewURL(state.workspace),'/pages.html?id=page-id');
  state.workspace.slug='confirmed-original'; state.document.metadata.title='Renamed';
  assert.equal(reviewURL(state.workspace),'/conteudos/confirmed-original');
});
test('JSONB object-key order is immaterial but content/array order and capabilities remain bound', () => {
  const {state,review}=setup();const doc=state.document;
  const reordered=Object.fromEntries(Object.entries(doc).reverse());
  reordered.metadata=Object.fromEntries(Object.entries(doc.metadata).reverse());
  assert.equal(review.verify({...state.workspace,draft:{document:reordered}}),true);
  assert.equal(review.ready,true);
  assert.equal(review.verify({...state.workspace,capabilities:{publish:false},draft:{document:reordered}}),false);
  assert.equal(review.ready,false);
});
test('a failed preflight has no ambiguous publication to reconcile or lock', () => {
  const {review}=setup();review.check(0,true);review.failed(new Error('preflight network failure'),false);
  assert.equal(review.pending,null);assert.equal(review.uncertain,false);assert.equal(review.ready,true);
  assert.deepEqual(review.snapshot.checks,[false,false,false]);
});
test('review invalidation observes state while no modal exists, including edit/undo and completed upload', () => {
  const {state,review}=setup();const original=JSON.stringify(state.document);
  review.check(0,true);state.transact({},doc=>{doc.metadata.title='Temporary edit';});state.undo();
  assert.equal(JSON.stringify(state.document),original);assert.deepEqual(review.snapshot.checks,[false,false,false]);
  review.check(1,true);state.uploadStart();state.uploadEnd();
  assert.equal(state.publishable,true);assert.deepEqual(review.snapshot.checks,[false,false,false]);
});
test('state subscription invalidates checks without destroying an uncertain publication payload', () => {
  const {state,review}=setup();const payload=review.payload();review.failed(new Error('lost ACK'));
  state.uploadStart();state.uploadEnd();
  assert.equal(review.uncertain,true);assert.equal(review.pending,payload);assert.equal(review.payload(),payload);
});
