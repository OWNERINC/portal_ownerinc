import test from 'node:test';
import assert from 'node:assert/strict';
import { createDraftHistory } from '../../public/pages/history.js';
const doc = title => ({ metadata: { title } });
test('snapshots and bookmarks are isolated; no-op, redo branch and clear', () => {
  const original = doc('A'), h = createDraftHistory({ document: original }); original.metadata.title = 'mutated';
  const selection = { blockId: 'faq', itemId: 'answer', from: 2, to: 3 };
  assert.equal(h.commit(doc('A')), false);
  assert.equal(h.commit(doc('B'), { selection, beforeSelection: { ...selection, from: 1 } }), true); selection.from = 99;
  const before = h.undo(); assert.equal(before.document.metadata.title, 'A'); assert.equal(before.selection.itemId, 'answer'); assert.equal(before.selection.from, 1);
  before.document.metadata.title = 'tamper';
  assert.equal(h.redo().selection.from, 2);
  h.undo(); h.commit(doc('C')); assert.equal(h.redo(), null);
  h.clear(); assert.equal(h.undo(), null); assert.equal(h.commit(doc('C')), false);
});
test('typing groups through 500ms, closes explicitly, and IME spans longer pauses', () => {
  const h = createDraftHistory({ document: doc('A') });
  h.commit(doc('B'), { group: 'title', time: 0 }); h.commit(doc('C'), { group: 'title', time: 500 });
  h.commit(doc('D'), { group: 'title', time: 1001 }); assert.equal(h.undo().document.metadata.title, 'C');
  h.redo(); h.closeGroup(); h.commit(doc('E'), { group: 'title', time: 1002 }); assert.equal(h.undo().document.metadata.title, 'D'); h.redo();
  h.closeGroup(); h.commit(doc('F'), { group: 'ime', time: 2000, composing: true });
  h.commit(doc('G'), { group: 'ime', time: 9000, composing: true }); h.closeGroup();
  h.commit(doc('H'), { group: 'ime', time: 9001 }); assert.equal(h.undo().document.metadata.title, 'G'); assert.equal(h.undo().document.metadata.title, 'E');
});
test('transaction count and serialized byte caps evict oldest, retaining one oversized transaction', () => {
  const h = createDraftHistory({ document: doc('A'), maxEntries: 2 });
  for (const title of ['B','C','D']) h.commit(doc(title));
  assert.equal(h.undo().document.metadata.title, 'C'); assert.equal(h.undo().document.metadata.title, 'B'); assert.equal(h.undo(), null);
  assert.equal(h.redo().document.metadata.title, 'C'); assert.equal(h.redo().document.metadata.title, 'D');
  const small = createDraftHistory({ document: doc('A'), maxBytes: 100 });
  small.commit(doc('B')); small.commit(doc('X'.repeat(1000))); assert.equal(small.undo().document.metadata.title, 'B'); assert.equal(small.undo(), null);
  assert.equal(small.redo().document.metadata.title.length, 1000);
});
test('explicit null nontext selection does not inherit the previous text bookmark; commands and no-op boundaries split groups', () => {
  const h=createDraftHistory({document:doc('A')}), mark={blockId:'b',from:1,to:2};
  h.commit(doc('B'),{group:'text',selection:mark,time:0});
  h.commit(doc('B'),{closeGroup:true});
  h.commit(doc('C'),{group:'text',time:1,beforeSelection:null,selection:null});
  assert.equal(h.undo().selection,null);assert.equal(h.undo().document.metadata.title,'A');
});
test('structural command boundaries preserve the typing groups on each side and false-command fallback adds no entry', () => {
  const h=createDraftHistory({document:doc('')});
  h.commit(doc('a'),{group:'text',time:0});h.closeGroup();
  assert.equal(h.commit(doc('a'),{closeGroup:true}),false,'an inapplicable first command has no content entry');
  h.commit(doc('a\n'),{group:'text',time:1,closeGroup:true});
  h.commit(doc('a\nb'),{group:'text',time:2});
  assert.equal(h.undo().document.metadata.title,'a\n');assert.equal(h.undo().document.metadata.title,'a');assert.equal(h.undo().document.metadata.title,'');
});
