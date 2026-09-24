import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const source = await readFile('public/js/cms-editor-values.js', 'utf8');
const { normalizeEditorBlocks } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
test('opcionais vazios são omitidos sem mutar o editor', () => {
  const original = [{ type: 'video', url: 'https://example.test/video.mp4', title: '  ' }];
  assert.deepEqual(normalizeEditorBlocks(original), [{ type: 'video', url: 'https://example.test/video.mp4' }]);
  assert.equal(original[0].title, '  ');
  assert.equal(normalizeEditorBlocks([{ type: 'pdf', asset_id: 'id', title: '' }])[0].title, '');
});
