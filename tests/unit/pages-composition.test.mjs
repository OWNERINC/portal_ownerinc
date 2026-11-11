import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { createTemplate } = require('../../api/pages/templates');
const { validateDocument } = require('../../api/pages/validation');
const context = vm.createContext({ crypto: { randomUUID }, URL });
for (const file of ['model','composition','state']) {
  const source = (await readFile(`public/pages/${file}.js`, 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(source, context);
}
const call = (name, ...args) => { context.args = args; return vm.runInContext(`${name}(...args)`, context); };
const plain = value => JSON.parse(JSON.stringify(value));
const blocks = doc => doc.sections.flatMap(s => s.rows.flatMap(r => r.columns.flatMap(c => c.blocks)));

test('v1 opens byte-equal; invalid, no-op and cancelled composition never upgrades the source', () => {
  const doc = createTemplate(), before = JSON.stringify(doc), row = doc.sections[0].rows[0];
  assert.equal(call('compose', doc, { type: 'layout', rowId: row.id, layout: 'single' }), null);
  assert.equal(call('compose', doc, { type: 'move', blockId: row.columns[0].blocks[0].id, columnId: randomUUID() }), null);
  assert.equal(call('compose', doc, { type: 'style', blockId: row.columns[0].blocks[0].id, style: { color: 'red' } }), null);
  assert.equal(JSON.stringify(doc), before);
  assert.deepEqual(validateDocument(doc).document, doc);
});
test('first successful v2 action is an atomic copy preserving every existing UUID and immutable pending snapshot', () => {
  const doc = createTemplate(), pending = structuredClone(doc), row = doc.sections[0].rows[0];
  const next = plain(call('compose', doc, { type: 'layout', rowId: row.id, layout: 'two_equal' }));
  assert.equal(next.schema_version, 2); assert.deepEqual(next.template, { id: 'comunicado', version: 2 });
  assert.equal(next.sections[0].id, doc.sections[0].id); assert.equal(next.sections[0].rows[0].id, row.id);
  assert.deepEqual(next.sections[0].rows[0].columns[0], row.columns[0]); assert.deepEqual(doc, pending);
  assert.doesNotThrow(() => validateDocument(next));
});
test('stable-ID lateral/vertical moves and keyboard commands share canonical order; two-to-one concatenates without loss', () => {
  let doc = createTemplate(), row = doc.sections[0].rows[0];
  row.columns[0].blocks.push({ ...structuredClone(row.columns[0].blocks[0]), id: randomUUID() });
  const ids = blocks(doc).map(b => b.id);
  doc = plain(call('compose', doc, { type: 'layout', rowId: row.id, layout: 'two_equal' })); row = doc.sections[0].rows[0];
  doc = plain(call('compose', doc, { type: 'move', blockId: ids[0], columnId: row.columns[1].id }));
  assert.deepEqual(blocks(doc).map(b => b.id), [ids[1], ids[0]]);
  const keyboard = plain(call('adjacentMove', doc, ids[0], -1));
  const drag = { type: 'move', blockId: ids[0], columnId: row.columns[0].id, beforeId: ids[1] };
  assert.deepEqual(plain(call('compose', doc, keyboard)), plain(call('compose', doc, drag)));
  doc = plain(call('compose', doc, { type: 'layout', rowId: row.id, layout: 'single' }));
  assert.deepEqual(blocks(doc).map(b => b.id), [ids[1], ids[0]]); assert.equal(doc.sections[0].rows[0].columns.length, 1);
  assert.doesNotThrow(() => validateDocument(doc));
});
test('section/row commands resolve IDs after copies and reorder deterministically', () => {
  let doc = plain(call('compose', createTemplate(), { type: 'section', label: 'Outra seção' }));
  const sectionId = doc.sections[1].id;
  doc = plain(call('compose', doc, { type: 'row', sectionId }));
  const rowId = doc.sections[1].rows[1].id;
  doc = plain(call('compose', doc, { type: 'reorder', sectionId, rowId, delta: -1 }));
  assert.equal(doc.sections[1].rows[0].id, rowId);
  doc = plain(call('compose', doc, { type: 'reorder', sectionId, delta: -1 }));
  assert.equal(doc.sections[0].id, sectionId); assert.equal(call('findColumn', doc, randomUUID()), null);
});
test('finite block styles and all generic blocks validate, without relaxing any v1 restriction', () => {
  let doc = createTemplate(); const columnId = doc.sections[0].rows[0].columns[0].id;
  for (const type of ['callout','button','divider']) doc = plain(call('compose', doc, { type: 'insert', columnId, block: call('genericBlock', type) }));
  const id = blocks(doc)[0].id;
  for (const font of ['manrope','source-serif-4','oswald']) {
    doc = plain(call('compose', doc, { type: 'style', blockId: id, style: { align: 'center', scale: 'large', palette: 'brand', font } }));
    validateDocument(doc);
  }
  const v1 = structuredClone(doc); v1.schema_version = 1; v1.template.version = 1;
  assert.throws(() => validateDocument(v1), { status: 400 });
  const bad = structuredClone(doc); blocks(bad)[0].style.css = 'color:red'; assert.throws(() => validateDocument(bad), { status: 400 });
});
test('v2 accepts safe section/URL destinations only and rejects unknown/absent section targets', () => {
  const doc = createTemplate('owner-news'); validateDocument(doc);
  const button = blocks(doc).find(b => b.type === 'button');
  for (const value of ['https://example.test/path','/pages.html']) { button.destination = { type: 'url', value }; validateDocument(doc); }
  for (const destination of [{ type: 'section', value: randomUUID() }, { type: 'url', value: 'javascript:alert(1)' }, { type: 'url', value: '//evil.test' }, { type: 'section', value: '#arbitrary' }]) {
    button.destination = destination; assert.throws(() => validateDocument(doc), { status: 400 });
  }
});
test('v2 enforces 20 sections, 100 rows, 100 blocks, aggregate text, and unique identities', () => {
  let doc = createTemplate();
  for (let i = 1; i < 20; i++) doc = plain(call('compose', doc, { type: 'section' }));
  validateDocument(doc); assert.equal(call('compose', doc, { type: 'section' }), null);
  const extra = structuredClone(doc); extra.sections.push({ id: randomUUID(), label: '', rows: [{ id: randomUUID(), layout: 'single', columns: [{ id: randomUUID(), blocks: [] }] }] });
  assert.throws(() => validateDocument(extra), { status: 400 });
  const original = createTemplate('owner-news');
  for (const change of [
    d => { d.sections[1].id = d.sections[0].id; },
    d => { d.sections[0].rows = Array.from({ length: 101 }, () => ({ id: randomUUID(), layout: 'single', columns: [{ id: randomUUID(), blocks: [] }] })); },
    d => { d.sections[0].rows[0].columns[0].blocks = Array.from({ length: 101 }, () => ({ id: randomUUID(), type: 'divider' })); },
    d => { blocks(d)[0].content.content[1].content[0].text = 'x'.repeat(100000); },
  ]) { const bad = structuredClone(original); change(bad); assert.throws(() => validateDocument(bad), { status: 400 }); }
});
test('typed references and bounded caption/transcript accessibility are required at publication', () => {
  const doc = createTemplate('owner-news'); doc.metadata.audience.job_title_ids = [randomUUID()];
  const list = doc.sections[0].rows[0].columns[0].blocks;
  const audio = { id: randomUUID(), type: 'audio', media_id: randomUUID(), title: 'Áudio', transcript: 'Transcrição' };
  const video = { id: randomUUID(), type: 'video', media_id: randomUUID(), title: 'Vídeo', transcript: 'Descrição', captions: [{ start_ms: 0, end_ms: 1000, text: 'Legenda' }] };
  list.push(audio, video);
  assert.deepEqual(validateDocument(doc, { publishing: true }).mediaRefs, [{ id: audio.media_id, kind: 'audio' }, { id: video.media_id, kind: 'video' }]);
  video.captions[0].text = '<script>'; assert.throws(() => validateDocument(doc), { status: 400 });
  video.captions = []; validateDocument(doc); assert.throws(() => validateDocument(doc, { publishing: true }), { reason: 'media_accessibility_required' });
});
test('button-only pages remain incomplete for publication; a destination is not meaningful prose', () => {
  const doc = createTemplate('owner-news'); doc.metadata.audience.job_title_ids = [randomUUID()];
  doc.sections = [doc.sections[0]];
  doc.sections[0].rows[0].columns[0].blocks = [{ id: randomUUID(), type: 'button', label: 'Abrir', preset: 'primary', destination: { type: 'url', value: '/pages.html' } }];
  validateDocument(doc);
  assert.throws(() => validateDocument(doc, { publishing: true }), { reason: 'publication_incomplete' });
});
test('real state replacement commits composed copies and preserves the exact ambiguous pending payload', async () => {
  const original = createTemplate(), workspace = { id: randomUUID(), version: 0, draft_revision_id: randomUUID(), draft: { document: original }, capabilities: { edit: true, publish: true } };
  const state = call('createEditorState', workspace); assert.equal(state.dirty, false);
  const next = call('compose', state.document, { type: 'layout', rowId: original.sections[0].rows[0].id, layout: 'two_equal' });
  state.replace(next); assert.equal(state.document.schema_version, 2); assert.equal(state.dirty, true);
  await assert.rejects(state.save({ save: async () => { throw new Error('response lost'); } }));
  const pending = JSON.stringify(state.pending);
  const further = call('compose', state.document, { type: 'section' }); state.replace(further);
  assert.equal(state.document.sections.length, 2); assert.equal(JSON.stringify(state.pending), pending); assert.equal(state.publishable, false);
  assert.deepEqual(workspace.draft.document, original);
});
