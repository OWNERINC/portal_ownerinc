import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createEditorState } from '../../public/pages/state.js';
import { canPages, publicationIssues } from '../../public/pages/model.js';
import { upgradeDocument } from '../../public/pages/document-v3.js';
const require = createRequire(import.meta.url);
const { createTemplate } = require('../../api/pages/templates');
function workspace() { return { id: 'page', version: 0, draft_revision_id: 'r0', published_revision_id: null, draft: { document: createTemplate() }, capabilities: { edit: true, publish: true, archive: true } }; }
function deferred() { let resolve, reject; const promise = new Promise((r,j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }

test('review category edit retains reviewed head until exact save ACK and clears pending', async () => {
  const w = workspace(); w.draft.document = upgradeDocument(w.draft.document); w.document_support = {write_versions:[1,2,3]};
  const state = createEditorState(w), reviewed = state.workspace.draft_revision_id;
  state.transact({group:'review:category'}, doc => {doc.metadata.category='Pessoas e cultura';});
  assert.equal(state.publishable,false); assert.equal(state.workspace.draft_revision_id,reviewed);
  await state.save({save:async(_id,payload)=>{assert.equal(payload.document.metadata.category,'Pessoas e cultura');return{version:1,draft_revision_id:'new-review'};}});
  assert.notEqual(state.workspace.draft_revision_id,reviewed); assert.equal(state.pending,null); assert.equal(state.publishable,true);
});

test('native-field IME metadata groups through long pauses and an ordinary save retains subsequent field edits',async()=>{
  const s=createEditorState(workspace()), original=s.document.metadata.title;
  s.closeHistoryGroup();s.transact({group:'metadata:title',composing:true,time:0,beforeSelection:null},d=>{d.metadata.title='一';});
  s.transact({group:'metadata:title',composing:true,time:650,beforeSelection:null},d=>{d.metadata.title='一二';});s.closeHistoryGroup();
  assert.equal(s.undo(),true);assert.equal(s.document.metadata.title,original);assert.equal(s.selection,null);s.redo();
  const held=deferred();let sent;const saving=s.save({save:(_id,p)=>{sent=p;return held.promise;}});
  s.transact({group:'metadata:title',beforeSelection:null},d=>{d.metadata.title='一二x';});held.resolve({version:1,draft_revision_id:'r1'});await saving;
  assert.equal(sent.document.metadata.title,'一二');assert.equal(s.document.metadata.title,'一二x');assert.equal(s.status,'dirty');assert.equal(s.undo(),true);assert.equal(s.dirty,false);
});

test('global transactions survive save/ack without rewinding workspace; legacy changed records real before', async () => {
  const s = createEditorState(workspace()), title = s.document.metadata.title;
  assert.equal(s.transact({ group: 'title' }, d => { d.metadata.title = 'B'; }), true);
  await s.save({ save: async () => ({ version: 1, draft_revision_id: 'r1', slug: 'b' }) });
  assert.equal(s.undo(), true); assert.equal(s.document.metadata.title, title); assert.equal(s.workspace.version, 1); assert.equal(s.workspace.slug, 'b'); assert.equal(s.dirty, true);
  assert.equal(s.redo(), true); assert.equal(s.dirty, false);
  s.document.metadata.summary = 'legacy'; s.changed(); assert.equal(s.undo(), true); assert.notEqual(s.document.metadata.summary, 'legacy');
  const before = structuredClone(s.document);
  assert.throws(() => s.transact({}, d => { d.metadata.title = 'discard'; throw new Error('cancel'); })); assert.deepEqual(s.document, before);
  assert.equal(s.transact({}, d => { d.metadata.title = 'discard'; return false; }), false); assert.deepEqual(s.document, before);
});
test('undo guards saving/uploads/conflict/readonly, ambiguous pending remains byte identical', async () => {
  const s = createEditorState(workspace()); s.transact({}, d => { d.metadata.title = 'B'; });
  const pending = deferred(), saving = s.save({ save: () => pending.promise }); assert.equal(s.undo(), false);
  pending.reject(new Error('lost')); await assert.rejects(saving); const bytes = JSON.stringify(s.pending);
  assert.equal(s.undo(), true); assert.equal(s.dirty, false); assert.equal(s.publishable, false); assert.equal(JSON.stringify(s.pending), bytes);
  assert.equal(s.transact({}, d => { d.metadata.title = 'C'; }), true); assert.equal(s.canRedo, false); assert.equal(JSON.stringify(s.pending), bytes);
  s.uploadStart(); assert.equal(s.undo(), false); s.uploadEnd();
  await assert.rejects(s.save({ save: async () => { throw Object.assign(new Error(), {status:409}); } })); assert.equal(s.undo(), false);
  const readonly = workspace(); readonly.capabilities.edit = false; const r = createEditorState(readonly);
  assert.equal(r.transact({}, d => { d.metadata.title = 'bad'; }), false); assert.equal(r.undo(), false);
});
test('v3 floor begins only at actual ack, including ambiguous retry, never modifies pending', async () => {
  for (const ambiguous of [false, true]) {
    const w = workspace(); w.document_support = {read_versions:[1,2,3],write_versions:[1,2,3]}; const s = createEditorState(w), old = structuredClone(s.document);
    s.replace(upgradeDocument(s.document)); assert.equal(s.undo(), true); assert.deepEqual(s.document, old); s.redo();
    let bytes;
    if (ambiguous) { await assert.rejects(s.save({save:async (_id,p) => { bytes = JSON.stringify(p); throw new Error('lost'); }})); s.undo(); assert.deepEqual(s.document, old); }
    await s.save({save:async (_id,p) => { if (bytes) assert.equal(JSON.stringify(p), bytes); return {version:1,draft_revision_id:'v3'}; }});
    if (!ambiguous) s.undo();
    assert.equal(s.document.schema_version,3); assert.deepEqual(s.document, upgradeDocument(old));
    s.transact({}, d => {d.metadata.title='floor';});
    await s.save({save:async (_id,p) => {assert.equal(p.document.schema_version,3); return {version:2,draft_revision_id:'v3b'};}});
  }
});

test('v2 undo, selections, grouping and ACK floor retain only content, not workspace metadata', async () => {
  const w=workspace(); w.draft.document.schema_version=2; w.draft.document.template.version=2;
  w.document_support={read_versions:[1,2,3],write_versions:[1,2,3]};
  const s=createEditorState(w), original=structuredClone(s.document), mark={blockId:'text',itemId:'answer',from:2,to:3};
  s.transact({group:'title',time:0,beforeSelection:mark,selection:{...mark,from:4}},d=>{d.metadata.title='B';});
  s.transact({group:'title',time:500,selection:{...mark,from:5}},d=>{d.metadata.title='C';});
  s.closeHistoryGroup();s.replace(upgradeDocument(s.document));
  s.undo();assert.equal(s.document.schema_version,2);s.redo();
  await s.save({save:async()=>({version:7,draft_revision_id:'ack',slug:'fixed',document_support:{read_versions:[1,2,3],write_versions:[1,2,3]}})});
  assert.equal(s.undo(),true);assert.equal(s.document.schema_version,3);assert.equal(s.replace(s.document),false,'floor normalization is not an extra content edit');
  assert.equal(s.undo(),true);assert.deepEqual(s.document,upgradeDocument(original));assert.deepEqual(s.selection,mark);
  const selected=s.selection;selected.from=999;assert.equal(s.selection.from,2);
  assert.equal(s.workspace.version,7);assert.equal(s.workspace.slug,'fixed');assert.equal(s.canUndo,false);
  s.redo();s.redo();assert.equal(s.dirty,false);
});

test('only server ack changes saved baseline; in-flight newer edits cannot be lost', async () => {
  const state = createEditorState(workspace()), pending = deferred(); let calls = 0;
  state.document.metadata.title = 'First edit'; state.changed();
  const save = state.save({ save: async () => { calls++; return pending.promise; } });
  assert.equal(state.status, 'saving'); assert.equal(state.publishable, false);
  assert.equal(await state.save({ save: () => { calls++; } }), false);
  state.document.metadata.title = 'Newer edit'; state.changed();
  pending.resolve({ version: 1, draft_revision_id: 'r1', published_revision_id: null }); await save;
  assert.equal(calls, 1); assert.equal(state.workspace.version, 1);
  assert.equal(state.document.metadata.title, 'Newer edit'); assert.equal(state.status, 'dirty'); assert.equal(state.dirty, true);
  await state.save({ save: async (_id, body) => { assert.equal(body.expected_version, 1); assert.equal(body.document.metadata.title, 'Newer edit'); return { version: 2, draft_revision_id: 'r2', published_revision_id: null }; } });
  assert.equal(state.status, 'saved'); assert.equal(state.publishable, true);
});

test('ambiguous save retries reuse exact snapshot/key, then retain newer edits', async () => {
  const state = createEditorState(workspace()); state.document.metadata.title = 'Original'; state.changed();
  let original;
  await assert.rejects(state.save({ save: async (_id, body) => { original = structuredClone(body); throw new Error('lost response'); } }));
  assert.equal(state.status, 'failure'); assert.equal(state.publishable, false);
  state.document.metadata.title = 'After failure'; state.changed();
  await state.save({ save: async (_id, body) => { assert.deepEqual(body, original); return { version: 1, draft_revision_id: 'r1' }; } });
  assert.equal(state.document.metadata.title, 'After failure'); assert.equal(state.dirty, true);
});

test('conflicts block further saves; failed validation allows a corrected new snapshot; pending uploads block publishing', async () => {
  const state = createEditorState(workspace()); state.document.metadata.title = 'Changed'; state.changed();
  await assert.rejects(state.save({ save: async () => { throw Object.assign(new Error(), { status: 409 }); } }));
  assert.equal(state.status, 'conflict'); assert.equal(await state.save({ save() { assert.fail(); } }), false);
  const fresh = createEditorState(workspace()); fresh.document.metadata.title = 'Bad'; fresh.changed();
  await assert.rejects(fresh.save({ save: async () => { throw Object.assign(new Error(), { status: 400 }); } }));
  assert.equal(fresh.pending, null);
  fresh.document.metadata.title = 'Corrected'; fresh.changed();
  await fresh.save({ save: async (_id, body) => { assert.equal(body.document.metadata.title, 'Corrected'); return { version: 1, draft_revision_id: 'r1' }; } });
  fresh.uploadStart(); assert.equal(fresh.publishable, false); fresh.uploadEnd(); assert.equal(fresh.publishable, true);
});

test('returning to the old baseline cannot settle an ambiguous save or enable publication; retry reconciles its original snapshot', async () => {
  const state = createEditorState(workspace()), baseline = structuredClone(state.document);
  state.document.metadata.title = 'Snapshot B'; state.changed();
  let submitted;
  await assert.rejects(state.save({ save: async (_id, body) => { submitted = structuredClone(body); throw new Error('lost acknowledgement'); } }));
  state.replace(baseline);
  assert.equal(state.dirty, false);
  assert.equal(state.status, 'failure');
  assert.equal(state.publishable, false);
  assert.deepEqual(state.pending, submitted);
  const retry = deferred();
  const saving = state.save({ save: async (_id, body) => { assert.deepEqual(body, submitted); return retry.promise; } });
  assert.equal(state.status, 'saving'); assert.equal(state.publishable, false);
  retry.resolve({ version: 1, draft_revision_id: 'r1', published_revision_id: null });
  await saving;
  assert.equal(state.pending, null); assert.equal(state.workspace.version, 1);
  assert.deepEqual(state.document, baseline);
  assert.equal(state.dirty, true); assert.equal(state.status, 'dirty'); assert.equal(state.publishable, false);
  await state.save({ save: async (_id, body) => {
    assert.notEqual(body.client_mutation_id, submitted.client_mutation_id);
    assert.equal(body.expected_version, 1); assert.deepEqual(body.document, baseline);
    return { version: 2, draft_revision_id: 'r2', published_revision_id: null };
  } });
  assert.equal(state.status, 'saved'); assert.equal(state.publishable, true);
});

test('frontend Pages permissions are stricter than shared truthy helpers and publication validates active destinations', () => {
  assert.equal(canPages({ role: 'admin', permissions: { editPages: 'true' } }, 'editPages'), false);
  assert.equal(canPages({ role: 'viewer', permissions: { superAdmin: true } }, 'editPages'), false);
  assert.equal(canPages({ role: 'admin', permissions: { superAdmin: true } }, 'editPages'), true);
  const doc = createTemplate(); doc.metadata.audience.job_title_ids = ['cargo'];
  assert.deepEqual(publicationIssues(doc, [{ id: 'cargo', active: true }]), []);
  assert.ok(publicationIssues(doc, [{ id: 'cargo', active: false }]).length);
});

test('document support preserves a v3 head and capabilities, exposing edit unavailability without upgrading legacy on load', async () => {
  const w = workspace(); w.draft.document = upgradeDocument(w.draft.document);
  w.document_support = { read_versions: [1,2,3], write_versions: [1,2] };
  const before = structuredClone(w), state = createEditorState(w);
  assert.deepEqual(state.document, before.draft.document);
  assert.equal(state.editable, false);
  assert.equal(state.editingUnavailableReason, 'document_version_disabled');
  assert.deepEqual(state.workspace.capabilities, before.capabilities);
  state.document.metadata.title = 'Retained local edit'; state.changed();
  assert.equal(await state.save({ save() { assert.fail('disabled writer must not submit a new snapshot'); } }), false);
  assert.equal(state.dirty, true);
  assert.equal(createEditorState(workspace()).document.schema_version, 1);
});

test('support metadata and ack cannot alter immutable pending retry or discard edits newer than the snapshot', async () => {
  const w = workspace(); w.draft.document = upgradeDocument(w.draft.document);
  w.document_support = { read_versions: [1,2,3], write_versions: [1,2,3] };
  const state = createEditorState(w); state.document.metadata.category = 'Snapshot category'; state.changed();
  let submitted;
  await assert.rejects(state.save({ save: async (_id, body) => { submitted = structuredClone(body); throw new Error('ambiguous response'); } }));
  assert.throws(() => { state.pending.document.metadata.category = 'tampered'; }, TypeError);
  state.document.metadata.category = 'Newer category'; state.changed();
  const support = { read_versions: [1,2,3], write_versions: [1,2] };
  state.acknowledge({ version: 0, published_revision_id: null, document_support: support });
  support.write_versions.push(3);
  assert.equal(state.editable, false);
  assert.deepEqual(state.pending, submitted);
  await state.save({ save: async (_id, body) => { assert.deepEqual(body, submitted); return { version: 1, draft_revision_id: 'r1', published_revision_id: null, document_support: { read_versions: [1,2,3], write_versions: [1,2] } }; } });
  assert.equal(state.workspace.version, 1); assert.equal(state.document.metadata.category, 'Newer category');
  assert.equal(state.dirty, true); assert.equal(state.pending, null);
});

test('version gate and downgrade conflicts retain exact pending payload and dirty leave-guard state', async () => {
  for (const reason of ['document_version_disabled', 'schema_downgrade_conflict']) {
    const w = workspace(); w.draft.document = upgradeDocument(w.draft.document);
    w.document_support = { read_versions: [1,2,3], write_versions: [1,2,3] };
    const state = createEditorState(w); state.document.metadata.category = 'Unsaved'; state.changed();
    let sent;
    await assert.rejects(state.save({ save: async (_id, body) => { sent = structuredClone(body); throw Object.assign(new Error(reason), { status: 409, reason }); } }));
    assert.deepEqual(state.pending, sent); assert.equal(Object.isFrozen(state.pending), true);
    assert.equal(state.dirty, true); assert.equal(state.status, 'conflict'); assert.equal(state.publishable, false);
    assert.equal(await state.save({ save() { assert.fail('conflict requires explicit resolution'); } }), false);
    assert.equal(state.workspace.version, 0); assert.equal(state.document.schema_version, 3);
  }
});
