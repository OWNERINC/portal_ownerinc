import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile('public/cards-pos/inline-editor.js', 'utf8');
const { createInlineEditor } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const { attachRichInput, normalizeRichHtml, richTextLength } = await import('../..//public/cards-pos/rich-text.js');
const { collectEditableFields } = await import('../..//public/cards-pos/field-registry.js');
function node() { const listeners = new Map(); return { hidden: true, value: '', append() {}, setAttribute() {}, addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener() {}, querySelector(selector) { return selector.includes('apply') ? this.apply : selector.includes('cancel') ? this.cancel : selector.includes('previous') ? this.previous : selector.includes('next') ? this.next : this.field; }, dispatch(type) { listeners.get(type)?.(); }, focus() {} }; }

test('contratos mobile do editor estão presentes e a camada é irmã da arte', async () => {
  const html = await readFile('public/cards-pos.html', 'utf8');
  assert.match(html, /card-inline-layer/);
  assert.match(source, /createInlineEditor/);
});

test('apply/cancel/previous/next têm comportamento e commit único', () => {
  const root = node(); root.field = node(); root.apply = node(); root.cancel = node(); root.previous = node(); root.next = node();
  const commits = [];
  const editor = createInlineEditor({ root, fields: [{ template: 'convite_owntime', key: 'a', label: 'A' }, { template: 'convite_owntime', key: 'b', label: 'B' }], getTemplate: () => 'convite_owntime', readValue: (_, key) => key.toUpperCase(), onCommit: value => commits.push(value), normalizeValue: value => value });
  assert.equal(editor.open('a'), true); root.field.value = 'novo'; root.field.dispatch('input'); assert.equal(editor.hasPendingChanges(), true); root.cancel.dispatch('click'); assert.equal(commits.length, 0);
  editor.open('a'); root.field.value = 'commit'; root.apply.dispatch('click'); assert.equal(commits.length, 1); editor.open('a'); root.next.dispatch('click'); assert.equal(root.hidden, false); editor.dispose();
});

test('rich input preserves the last valid HTML, blocks composition flush, and counts Unicode', () => {
  const listeners = new Map();
  const field = { innerHTML: '<strong>ok</strong>', innerText: 'ok', addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener() {} };
  globalThis.getSelection = () => ({ toString: () => '' });
  const controller = attachRichInput({ node: field, maxLength: 3, page: { listen(target, type, fn) { target.addEventListener(type, fn); } } });
  field.innerHTML = '<strong>novo</strong>'; field.innerText = 'novo'; listeners.get('input')({});
  assert.equal(field.innerHTML, '<strong>ok</strong>');
  listeners.get('compositionstart')({}); assert.equal(controller.flush(), false); listeners.get('compositionend')({});
  controller.sync(); assert.equal(richTextLength('<strong>á🙂</strong>'), 2); controller.dispose();
});

test('inline editor keeps permitted rich HTML in contenteditable without literal tags', () => {
  const listeners = new Map();
  const field = { innerHTML: '', contentEditable: 'true', addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener() {}, setAttribute() {}, focus() {} };
  const action = () => ({ addEventListener(type, fn) { this.handler = fn; }, removeEventListener() {}, click() { this.handler?.(); } });
  const buttons = { apply: action(), cancel: action(), previous: action(), next: action() };
  const root = { hidden: true, append() {}, querySelector(selector) { if (selector === '#card-inline-field') return field; if (selector.includes('apply')) return buttons.apply; if (selector.includes('cancel')) return buttons.cancel; if (selector.includes('previous')) return buttons.previous; if (selector.includes('next')) return buttons.next; return null; } };
  const commits = [];
  const editor = createInlineEditor({ root, fields: [{ template: 'convite_owntime', key: 'body', multiline: true, maxLength: 40 }], getTemplate: () => 'convite_owntime', readValue: () => '<strong>texto</strong>', normalizeValue: value => normalizeRichHtml(value, { multiline: true }), onCommit: value => commits.push(value) });
  assert.equal(editor.open('body'), true);
  assert.equal(field.innerHTML, '<strong>texto</strong>');
  assert.doesNotMatch(field.innerHTML, /&lt;strong&gt;/);
  field.innerHTML = '<strong>novo</strong><br>linha'; listeners.get('input')?.();
  buttons.apply.click();
  assert.equal(commits[0].value, '<strong>novo</strong><br>linha');
  editor.dispose();
});

test('field registry preserves multiline Guest and Owner editors after textarea replacement', () => {
  const make = (owner = false) => ({ tagName: 'DIV', dataset: owner ? { ownerField: 'body', multiline: 'true', maxlength: '40' } : { field: 'body', multiline: 'true', maxlength: '40' }, hasAttribute: name => owner ? name === 'data-owner-field' : name === 'data-field', getAttribute: name => name === 'aria-multiline' ? 'true' : 'body', maxLength: 0, classList: { contains: () => true }, closest: () => ({ childNodes: [] }) });
  const fields = collectEditableFields({ querySelectorAll: () => [make(), make(true)] });
  assert.deepEqual(fields.map(field => field.multiline), [true, true]);
  assert.deepEqual(fields.map(field => field.maxLength), [40, 40]);
});
