import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createEditorState } from '../../public/pages/state.js';
import { canPages, publicationIssues } from '../../public/pages/model.js';
const require = createRequire(import.meta.url);
const { createTemplate } = require('../../api/pages/templates');
function workspace() { return { id: 'page', version: 0, draft_revision_id: 'r0', published_revision_id: null, draft: { document: createTemplate() }, capabilities: { edit: true, publish: true, archive: true } }; }
function deferred() { let resolve, reject; const promise = new Promise((r,j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }

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
