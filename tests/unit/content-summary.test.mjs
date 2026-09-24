import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = await readFile('public/js/content-summary.js', 'utf8');
const { summarizeContent } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
test('resumo limita Unicode e preserva texto literal', () => {
  assert.equal(summarizeContent([{ type: 'paragraph', text: 'A😀BCDE' }], '', 4), 'A😀B…');
  assert.equal(summarizeContent([{ type: 'paragraph', text: '<b>literal</b>' }]), '<b>literal</b>');
});
test('mídia sem texto permanece descobrível', () => assert.equal(summarizeContent([{ type: 'image', asset_id: 'local' }]), 'Material complementar disponível.'));
