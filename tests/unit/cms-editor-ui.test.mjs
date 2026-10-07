import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const source = await readFile('public/js/cms-editor-values.js', 'utf8');
const { normalizeEditorBlocks } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
test('opcionais vazios são omitidos sem mutar o editor', () => {
  const original = [{ type: 'video', url: 'https://example.test/video.mp4', title: '  ' }];
  assert.deepEqual(normalizeEditorBlocks(original), [{ type: 'video', url: 'https://example.test/video.mp4' }]);
  assert.equal(original[0].title, '  ');
  assert.equal(normalizeEditorBlocks([{ type: 'pdf', asset_id: 'id', title: '' }])[0].title, '');
});

test('paleta oferece somente tipos editáveis e preserva contratos editoriais carregados', async () => {
  const require = createRequire(import.meta.url);
  const { validateBlocks } = require('../../api/cms/blocks');
  const renderer = await readFile('public/js/cms-block-renderer.js', 'utf8');
  const { BLOCK_TYPES } = await import('data:text/javascript;base64,' + Buffer.from(
    `import { cmsAssetEndpoint } from '${new URL('../../public/js/owner-news/asset-path.mjs', import.meta.url).href}';\n`
      + renderer.replace(/^import .*;\r?\n/gm, ''),
  ).toString('base64'));
  const editor = await readFile('public/js/cms-block-editor.js', 'utf8');
  const element = (tag, attributes = {}, children = []) => ({
    tag, ...attributes, children: [...children],
    append(...nodes) { this.children.push(...nodes); },
    addEventListener() {},
  });
  const context = { BLOCK_TYPES, validateBlocks, normalizeEditorBlocks, structuredClone, element,
    clear(node) { node.children = []; return node; } };
  vm.runInNewContext(editor.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
    + '\nglobalThis.createBlockEditor = createBlockEditor;', context);
  const initial = [{ type: 'quote', text: 'Citação.' }, { type: 'profile', name: 'Pessoa' }];
  const root = element('div');
  const instance = context.createBlockEditor({ root, initialBlocks: initial });
  const buttons = root.children[0].children;
  assert.deepEqual(buttons.map(button => button.text), [
    '+ Título', '+ Parágrafo', '+ Lista', '+ Destaque', '+ Imagem',
    '+ Separador', '+ Link', '+ PDF', '+ Vídeo',
  ]);
  assert.ok(BLOCK_TYPES.includes('quote') && BLOCK_TYPES.includes('profile'));
  assert.deepEqual(instance.getBlocks(), initial);
  buttons.find(button => button.text === '+ Parágrafo').on.click();
  const saved = validateBlocks(normalizeEditorBlocks(instance.getBlocks()));
  assert.ok(saved);
  assert.deepEqual(saved.slice(0, 2), initial);
  assert.equal(saved[2].type, 'paragraph');
});
