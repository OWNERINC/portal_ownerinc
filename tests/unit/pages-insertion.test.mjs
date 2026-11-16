import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as commands from '../../public/pages/composition.js';
import { textBlock, allBlocks } from '../../public/pages/model.js';
import { referenceDocument, featureDocument } from '../helpers/pages-reference-document.mjs';
import { insertionPoint, resolveInsertionPoint } from '../../public/pages/editor-insert.js';
import { upgradeDocument } from '../../public/pages/document-v3.js';
const { validateDocument } = createRequire(import.meta.url)('../../api/pages/validation');
const { createTemplate } = createRequire(import.meta.url)('../../api/pages/templates');

function nearByteLimitDocument() {
  const doc = createTemplate(), content = Array.from({ length: 470 }, () => ({ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: '/' + 'a'.repeat(2047) } }] }));
  allBlocks(doc)[0].content = { type: 'doc', content: [{ type: 'paragraph', content }] };
  content[0].text += 'x'.repeat(1048526 - Buffer.byteLength(JSON.stringify(doc)));
  assert.equal(Buffer.byteLength(JSON.stringify(doc)), 1048526); validateDocument(doc);
  return doc;
}

test('new two-column group inserts before a stable row, without converting it', () => {
  const doc = referenceDocument(), section = doc.sections[0], before = structuredClone(section.rows[0]);
  const next = commands.insertColumns(doc, { sectionId: section.id, beforeRowId: before.id });
  assert.equal(next.sections[0].rows[0].layout, 'two_equal');
  assert.deepEqual(next.sections[0].rows[1], before);
  const appended = commands.insertColumns(doc, { sectionId: section.id });
  assert.equal(appended.sections[0].rows.at(-1).layout, 'two_equal'); assert.deepEqual(appended.sections[0].rows[0], before);
  assert.deepEqual(doc, referenceDocument()); validateDocument(next);
});
test('invalid insertion/index/duplicate identities/limits are pure no-ops without upgrading v1', () => {
  const doc = createTemplate(), before = structuredClone(doc), col = doc.sections[0].rows[0].columns[0];
  for (const index of [-1, 0.5, col.blocks.length + 1, NaN, undefined]) assert.equal(commands.insertAt(doc, { columnId: col.id, index, block: textBlock() }), null);
  assert.equal(commands.insertAt(doc, { columnId: 'missing', index: 0, block: textBlock() }), null);
  assert.equal(commands.insertAt(doc, { columnId: col.id, index: 0, block: { ...textBlock(), id: doc.sections[0].id } }), null);
  assert.equal(commands.insertColumns(doc, { sectionId: doc.sections[0].id, beforeRowId: 'missing' }), null);
  assert.deepEqual(doc, before);
  col.blocks = Array.from({ length: 100 }, textBlock);
  assert.equal(commands.insertAt(doc, { columnId: col.id, index: 0, block: textBlock() }), null);
  doc.sections[0].rows = Array.from({ length: 100 }, () => ({ ...structuredClone(doc.sections[0].rows[0]), id: crypto.randomUUID() }));
  assert.equal(commands.insertColumns(doc, { sectionId: doc.sections[0].id }), null);
});
test('width/layout conversions preserve IDs, left-to-right order and true v3 aside conversion', () => {
  const doc = createTemplate(), blockId = allBlocks(doc)[0].id, before = structuredClone(doc);
  const half = commands.setBlockWidth(doc, { blockId, width: 'half' });
  assert.equal(half.schema_version, 2); assert.equal(half.sections[0].rows[0].columns.length, 2);
  assert.equal(commands.setBlockWidth(half, { blockId, width: 'half' }), null);
  const row = half.sections[0].rows[0]; row.columns[1].blocks.push(textBlock());
  const aside = commands.compose(half, { type: 'layout', rowId: row.id, layout: 'aside_right' });
  assert.equal(aside.schema_version, 3); assert.equal(aside.sections[0].rows[0].columns.length, 2); validateDocument(aside);
  const full = commands.setBlockWidth(aside, { blockId, width: 'full' });
  assert.deepEqual(allBlocks(full).map(b => b.id), allBlocks(aside).map(b => b.id));
  assert.equal(full.sections[0].rows[0].columns[0].id, row.columns[0].id); validateDocument(full);
  assert.deepEqual(doc, before); assert.equal(commands.setBlockWidth(doc, { blockId, width: 'full' }), null);
  assert.equal(commands.setBlockWidth(doc, { blockId: 'missing', width: 'half' }), null);
});
test('structural candidates reject final byte-limit overflow, including v1 layout upgrade, without changing source', () => {
  const doc = nearByteLimitDocument(), before = JSON.stringify(doc), sectionId = doc.sections[0].id, rowId = doc.sections[0].rows[0].id, blockId = allBlocks(doc)[0].id;
  assert.equal(commands.insertColumns(doc, { sectionId }), null, 'new row must validate its final bytes');
  assert.equal(commands.setBlockWidth(doc, { blockId, width: 'half' }), null, 'half-width must validate its final bytes after conversion');
  assert.equal(commands.compose(doc, { type: 'layout', rowId, layout: 'two_equal' }), null);
  assert.equal(commands.compose(doc, { type: 'layout', rowId, layout: 'aside_right' }), null);
  assert.equal(commands.compose(doc, { type: 'row', sectionId }), null);
  assert.equal(commands.compose(doc, { type: 'section' }), null);
  assert.equal(JSON.stringify(doc), before); assert.equal(doc.schema_version, 1);
});
test('aside rejects legacy safe-link budgets that only overflow after v3 conversion; valid smaller conversion remains saveable', () => {
  const doc = createTemplate(); doc.schema_version = 2; doc.template.version = 2;
  const content = Array.from({ length: 60 }, () => ({ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: '/' + 'a'.repeat(1999) } }] }));
  allBlocks(doc)[0].content = { type: 'doc', content: [{ type: 'paragraph', content }] }; validateDocument(doc);
  assert.throws(() => validateDocument(upgradeDocument(doc)), { status: 400 }, 'fixture actually exceeds the v3 aggregate link budget');
  const before = JSON.stringify(doc), rowId = doc.sections[0].rows[0].id;
  assert.equal(commands.compose(doc, { type: 'layout', rowId, layout: 'aside_right' }), null);
  assert.equal(JSON.stringify(doc), before); assert.equal(doc.schema_version, 2);
  content.length = 40;
  const next = commands.compose(doc, { type: 'layout', rowId, layout: 'aside_right' }); assert.ok(next); validateDocument(next);
});
test('section reordering resolves UUID targets, preserves content and rejects no-op/missing targets', () => {
  const doc = referenceDocument(), ids = doc.sections.map(s => s.id);
  const next = commands.reorderSection(doc, { sectionId: ids[0], beforeSectionId: ids[2] });
  assert.deepEqual(next.sections.map(s => s.id), [ids[1], ids[0], ...ids.slice(2)]);
  for (const section of next.sections) assert.deepEqual(section, doc.sections.find(s => s.id === section.id));
  for (const section of next.sections) assert.equal(section, doc.sections.find(s => s.id === section.id), 'pure reorder retains content references');
  assert.equal(commands.reorderSection(doc, { sectionId: ids[0], beforeSectionId: ids[1] }), null);
  assert.equal(commands.reorderSection(doc, { sectionId: ids[0], beforeSectionId: 'missing' }), null);
  assert.equal(commands.reorderSection(doc, { sectionId: ids.at(-1) }), null);
});
test('points resolve current IDs, follow inserts before an anchor, and fail closed after deletion/move', () => {
  const doc = createTemplate(), block = allBlocks(doc)[0], columnId = doc.sections[0].rows[0].columns[0].id;
  const point = insertionPoint(doc, { blockId: block.id, side: 'before' });
  assert.equal(Object.isFrozen(point), true); assert.equal(resolveInsertionPoint(doc, point).index, 0);
  const inserted = commands.insertAt(doc, { columnId, index: 0, block: textBlock() });
  assert.equal(inserted.schema_version, 1, 'plain legacy text keeps v1');
  assert.equal(resolveInsertionPoint(inserted, point).index, 1);
  inserted.sections[0].rows[0].columns[0].blocks.pop(); assert.equal(resolveInsertionPoint(inserted, point), null);
  assert.equal(insertionPoint(doc, { blockId: 'missing' }), null);
  assert.equal(resolveInsertionPoint(doc, { ...point, columnId: 'missing' }), null);
});
test('duplicates regenerate block and FAQ/gallery item identities but preserve media, marks and legitimate destinations', () => {
  let doc = featureDocument();
  for (const type of ['faq', 'gallery', 'button']) {
    const original = allBlocks(doc).find(b => b.type === type), copy = commands.cloneBlock(original);
    assert.notEqual(copy.id, original.id);
    if (copy.items) copy.items.forEach((item, i) => { assert.notEqual(item.id, original.items[i].id); assert.deepEqual({ ...item, id: original.items[i].id }, original.items[i]); });
    if (type === 'button') assert.deepEqual(copy.action, original.action);
    const columnId = doc.sections[0].rows[0].columns[0].id;
    doc = commands.insertAt(doc, { columnId, index: 0, block: copy }); assert.ok(doc); validateDocument(doc);
    assert.equal(commands.insertAt(doc, { columnId, index: 0, block: original }), null);
  }
  const columnId = doc.sections[0].rows[0].columns[0].id;
  for (const type of ['gallery','faq']) {
    const reusedItems = structuredClone(allBlocks(doc).find(b => b.type === type)); reusedItems.id = crypto.randomUUID();
    assert.equal(commands.insertAt(doc, { columnId, index: 0, block: reusedItems }), null, 'fresh block ID does not permit reused item IDs');
  }
  const bad = commands.cloneBlock(allBlocks(doc).find(b => b.type === 'button')); bad.action = { type: 'section', value: crypto.randomUUID() };
  assert.equal(commands.insertAt(doc, { columnId, index: 0, block: bad }), null);
  const text = textBlock(); text.content.content[0].content = [{ type: 'text', text: 'x', marks: [{ type: 'script' }] }];
  assert.equal(commands.insertAt(doc, { columnId, index: 0, block: text }), null);
  text.content.content[0].content = [{ type: 'text', text: 'valid marks', marks: [{ type: 'text_color', attrs: { color: '#26204A' } }, { type: 'highlight', attrs: { color: '#FFFFFF' } }] }];
  const marked = commands.insertAt(doc, { columnId, index: 0, block: text }); assert.ok(marked); validateDocument(marked);
  assert.deepEqual(allBlocks(marked).find(b => b.id === text.id).content, text.content);
  text.content.content[0].content = [{ type: 'text', text: 'bad link', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }];
  assert.equal(commands.insertAt(doc, { columnId, index: 0, block: text }), null);
  text.content.content[0].content = [{ type: 'text', text: 'x'.repeat(100000) }];
  assert.equal(commands.insertAt(doc, { columnId, index: 0, block: text }), null);
});
