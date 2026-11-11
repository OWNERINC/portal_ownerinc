import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { FixtureNode, TestEvent, deferred, drain } from '../helpers/frontend-feedback-harness.mjs';

const require = createRequire(import.meta.url);
const { createTemplate } = require('../../api/pages/templates');

// Execute the real editor, model, state, DOM helpers and lifecycle. Only the
// browser rendering engine (PM/media) and network are controlled seams.
async function harness(t) {
  const doc = new FixtureNode('document'); doc.ownerDocument = doc;
  doc.createElement = tag => new FixtureNode(tag, doc);
  doc.createElementNS = (_, tag) => doc.createElement(tag);
  doc.createDocumentFragment = () => doc.createElement('fragment');
  doc.createTextNode = text => { const node = doc.createElement('#text'); node.textContent = text; return node; };
  doc.getElementById = id => doc.querySelector(`#${id}`);
  doc.body = doc.createElement('body'); doc.append(doc.body); doc.activeElement = doc.body;
  const root = doc.createElement('div'); root.setAttribute('id', 'page-editor-root'); doc.body.append(root);
  const window = new FixtureNode('window', doc); window.confirm = () => false;
  let location = new URL('https://portal.test/page-editor.html?id=first');
  const workspaces = [], uploads = [], editors = [], figures = [], sortables = [];
  const api = {
    async workspace(id) { workspaces.push(id); return { id, version: 0, draft_revision_id: `revision-${id}`, published_revision_id: null,
      draft: { document: createTemplate() }, capabilities: { edit: true, publish: true, archive: true } }; },
    async cargos() { return []; },
    upload(id, file, key) { const pending = { id, file, key, ...deferred() }; uploads.push(pending); return pending.promise; },
  };
  const context = vm.createContext({ document: doc, window, URL, URLSearchParams, crypto: { randomUUID }, console,
    AbortController, DOMException, setTimeout, clearTimeout, cancelAnimationFrame() {}, createPagesAPI: () => api,
    createSortable: (host, options) => { const sortable = { host, options, destroy() {} }; sortables.push(sortable); return sortable; }, applyBlockStyle() {},
    createRichEditor({ onChange, onSelection, isLayoutDragging }) {
      const editor = { destroyed: 0, destroy() { this.destroyed++; }, onChange, onSelection, isLayoutDragging, marks: new Set(), active(mark) { return this.marks.has(mark); }, focus() {} }; editors.push(editor); return editor;
    },
    imageFigure() { const figure = { node: doc.createElement('figure'), destroyed: 0, dispose() { figure.destroyed++; } }; figures.push(figure); return figure; },
    mediaFigure(block, options) { const figure = { node: doc.createElement('figure'), block, options, refreshed: 0, destroyed: 0, refresh() { figure.refreshed++; }, dispose() { figure.destroyed++; } }; figures.push(figure); return figure; },
    renderDocument: () => () => {}, openPagesDialog() { assert.fail('This test does not open dialogs'); },
  });
  async function load(file, names, transform = source => source) {
    const source = transform((await readFile(file, 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, ''));
    vm.runInContext(`(() => { ${source}\nObject.assign(globalThis, { ${names} }); })();`, context, { filename: file });
  }
  await load('public/js/page-lifecycle.js', 'createPageLifecycle');
  await load('public/pages/model.js', 'clone, newId, allBlocks, blockList, textBlock, publicationIssues, safeLink');
  await load('public/pages/drag-guard.js', 'compositionDropGuard');
  await load('public/pages/composition.js', 'compose, findBlock, findColumn, columns, genericBlock, defaultStyle, adjacentMove');
  await load('public/pages/dom.js', 'el, button, link, field, errorText, showError');
  await load('public/pages/state.js', 'createEditorState');
  await load('public/pages/editor-panels.js', 'openEditorPanel');
  await load('public/pages/editor-workspace.js', 'createEditorWorkspace, editorAction, editorIcon');
  await load('public/pages/editor.js', 'mountPageEditor', source => source.replace('  void load();\n}',
    '  globalThis.inspectEditor = () => ({ state, uploadRetry, loadSequence, documentURL });\n  globalThis.reloadEditor = load;\n  void load();\n}'));
  const page = context.createPageLifecycle({ user: { uid: 'author' } });
  Object.defineProperty(page, 'location', { get: () => location });
  context.mountPageEditor(page); await drain(); t.after(() => page.dispose());
  return { page, root, window, api, workspaces, uploads, editors, figures, sortables, compositionDropGuard: context.compositionDropGuard,
    get state() { return context.inspectEditor().state; },
    get retry() { return context.inspectEditor().uploadRetry; },
    async pop(url) { location = new URL(url, location); window.dispatchEvent(new TestEvent('popstate', { state: null })); await drain(); },
    async replaceWithoutGuard(url) { location = new URL(url, location); await context.reloadEditor(); await drain(); },
    async upload(type = 'image/png') {
      const input = root.querySelector('input[type="file"]');
      input.files = [{ type, size: 100, name: 'synthetic.mp4' }]; input.dispatchEvent(new TestEvent('change')); await drain();
      return uploads.at(-1);
    },
  };
}

test('fragment-only native history preserves dirty state and editor instances; accepted document Back/Forward still reloads', async t => {
  const h = await harness(t), original = h.state, editor = h.editors[0];
  const title = h.root.querySelector('.pages-metadata-title').querySelector('input'); title.value = 'Unsaved local title'; title.dispatchEvent(new TestEvent('input'));
  for (const fragment of ['#main-content', '#another', '']) {
    await h.pop(`?id=first${fragment}`);
    assert.equal(h.state, original); assert.equal(h.state.document.metadata.title, 'Unsaved local title');
    assert.equal(h.state.status, 'dirty'); assert.equal(editor.destroyed, 0); assert.equal(h.workspaces.length, 1);
  }
  assert.equal(h.page.canLeave(), false, 'query/document leave remains guarded');
  h.window.confirm = () => true; assert.equal(h.page.canLeave(), true);
  await h.pop('?id=second'); assert.equal(h.state.workspace.id, 'second'); assert.equal(editor.destroyed, 1);
  await h.pop('?id=first'); assert.equal(h.state.workspace.id, 'first');
  assert.deepEqual(h.workspaces, ['first', 'second', 'first']);
});

test('block drag uses pointer fallback and its scoped PM guard cannot serialize block chrome into prose', async t => {
  const h = await harness(t), editor = h.editors[0], sortable = h.sortables[0], before = JSON.stringify(h.state.document);
  assert.equal(sortable.options.forceFallback, true);
  const guard = h.compositionDropGuard(editor.isLayoutDragging);
  const ordinary = new TestEvent('drop');
  assert.equal(guard(null, ordinary), false, 'ordinary rich-text drops retain PM behavior');
  sortable.options.onStart(); assert.equal(editor.isLayoutDragging(), true);
  let prevented = 0, stopped = 0;
  assert.equal(guard(null, { preventDefault() { prevented++; }, stopPropagation() { stopped++; } }), true);
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  const block = h.state.document.sections[0].rows[0].columns[0].blocks[0];
  sortable.options.onEnd({ item: { dataset: { blockId: block.id } }, to: sortable.host });
  assert.equal(editor.isLayoutDragging(), false); assert.equal(guard(null, ordinary), false);
  assert.equal(JSON.stringify(h.state.document), before, 'no-op block drop must not alter prose, schema version or dirty state');
  assert.equal(editor.destroyed, 0, 'keyed PM instance survives');
});

test('existing button section options reconcile after section insertion/rename without recreating keyed PM or button controls', async t => {
  const h = await harness(t), pm = h.editors[0];
   const click = text => { if (text.startsWith('Adicionar ') && text !== 'Adicionar seção') h.root.querySelectorAll('button').find(node => node.textContent === 'Inserir bloco').click(); const button = h.root.ownerDocument.querySelectorAll('button').find(node => node.getAttribute('aria-label') === text || node.textContent === text); assert.ok(button, text); button.click(); };
  click('Adicionar botão');
  const target = h.root.querySelectorAll('select').find(node => node.getAttribute('aria-label') === 'Tipo de destino'); assert.ok(target);
  click('Adicionar seção');
  const section = h.state.document.sections[1];
  assert.equal(h.root.querySelectorAll('select').find(node => node.getAttribute('aria-label') === 'Tipo de destino'), target);
  assert.ok(target.querySelectorAll('option').some(node => node.value === section.id));
  const label = h.root.querySelectorAll('input').find(node => node.getAttribute('aria-label') === 'Nome da seção 2'); label.value = 'Seção recém-criada'; label.dispatchEvent(new TestEvent('input'));
  assert.equal(target.querySelectorAll('option').find(node => node.value === section.id).textContent, 'Seção: Seção recém-criada');
  target.value = section.id; target.dispatchEvent(new TestEvent('change'));
  const block = h.state.document.sections[0].rows[0].columns[0].blocks.find(item => item.type === 'button');
  assert.equal(block.destination.type, 'section'); assert.equal(block.destination.value, section.id);
  assert.equal(h.editors[0], pm); assert.equal(pm.destroyed, 0);
});

test('editor chrome groups header, metadata, structure and block controls without changing an opened document', async t => {
  const h = await harness(t), before = JSON.stringify(h.state.document);
  assert.equal(h.root.querySelector('h1').textContent, 'Editar Page');
  assert.ok(h.root.querySelector('.pages-v2-header').contains(h.root.querySelector('.pages-save-status')));
  assert.equal(h.root.querySelector('.pages-primary-actions').querySelectorAll('button').length, 2);
  assert.equal(h.root.querySelector('.pages-secondary-actions').querySelectorAll('button').length, 2);
  for (const key of ['title', 'summary']) assert.ok(h.root.querySelector(`.pages-metadata-${key}`));
  for (const header of ['pages-section-header', 'pages-row-header']) {
    const node = h.root.querySelector(`.${header}`);
    assert.ok(node.querySelector('.pages-field'));
    assert.ok(node.querySelector('.pages-structure-actions'));
  }
  const header = h.root.querySelector('.pages-block-header'), handle = header.querySelector('.pages-drag-handle');
  assert.equal(header.parentElement.getAttribute('data-block-type'), 'rich_text');
  assert.ok(handle.classList.contains('btn'));
  assert.equal(handle.getAttribute('aria-label'), 'Arrastar bloco; use Subir, Descer ou destino pelo teclado');
  assert.equal(header.querySelector('.pages-select-block').textContent, 'Selecionar texto 1');
  assert.equal(h.root.querySelector('input[type="file"]').getAttribute('accept'), 'image/jpeg,image/png,image/webp,image/gif,audio/mpeg,video/mp4');
  assert.equal(JSON.stringify(h.state.document), before); assert.equal(h.state.dirty, false);
});

test('V2 mounts a dedicated workspace without changing the document and restores the Portal shell on disposal', async t => {
  const h = await harness(t), original = JSON.stringify(h.state.document);
  assert.ok(h.root.querySelector('.pages-v2-workspace'));
  assert.ok(h.root.querySelector('.pages-v2-structure'));
  assert.ok(h.root.querySelector('.pages-v2-inspector'));
  assert.ok(h.root.ownerDocument.body.classList.contains('pages-editor-active'));
  assert.equal(JSON.stringify(h.state.document), original);
  assert.equal(h.state.dirty, false);
  h.page.dispose();
  assert.equal(h.root.ownerDocument.body.classList.contains('pages-editor-active'), false);
});

test('V2 style cancel is inert; bulk apply persists supported block presets atomically without global inheritance', async t => {
  const h = await harness(t), pm = h.editors[0], doc = h.root.ownerDocument;
  const click = text => { const control = doc.querySelectorAll('button').find(node => node.textContent === text || node.getAttribute('aria-label') === text); assert.ok(control, text); control.click(); };
  const before = JSON.stringify(h.state.document);
  click('Estilo da página');
  const font = doc.querySelectorAll('select').find(node => node.getAttribute('aria-label') === 'Fonte dos blocos existentes');
  font.value = 'oswald'; font.dispatchEvent(new TestEvent('change'));
  click('Fechar Estilo da página');
  assert.equal(JSON.stringify(h.state.document), before); assert.equal(h.state.dirty, false);
  click('Estilo da página');
  const nextFont = doc.querySelectorAll('select').find(node => node.getAttribute('aria-label') === 'Fonte dos blocos existentes');
  nextFont.value = 'source-serif-4';
  doc.querySelectorAll('select').find(node => node.getAttribute('aria-label') === 'Escala dos blocos existentes').value = 'standard';
  doc.querySelector('[data-palette-value="warm"]').click();
  const old = h.state.document;
  click('Aplicar aos blocos existentes');
  assert.notEqual(h.state.document, old);
  assert.equal(old.sections[0].rows[0].columns[0].blocks[0].style, undefined, 'old working snapshot was not mutated');
  assert.equal(h.state.document.sections[0].rows[0].columns[0].blocks[0].style.font, 'source-serif-4');
  assert.equal(h.state.document.sections[0].rows[0].columns[0].blocks[0].style.palette, 'warm');
  assert.equal(h.state.document.presentation.font, 'manrope', 'no invented document-level theme or inheritance');
  click('Inserir bloco'); click('Adicionar botão');
  const blocks = h.state.document.sections[0].rows[0].columns[0].blocks;
  assert.equal(blocks.at(-1).style, undefined, 'later insertion keeps the established default');
  assert.equal(h.editors[0], pm); assert.equal(pm.destroyed, 0);
});

test('V2 inspector reuses keyed block fields rather than cloning inputs or document state on selection', async t => {
  const h = await harness(t), doc = h.root.ownerDocument;
  h.root.querySelectorAll('button').find(node => node.textContent === 'Inserir bloco').click();
  doc.querySelectorAll('button').find(node => node.getAttribute('aria-label') === 'Adicionar botão').click();
  const target = h.root.querySelectorAll('select').find(node => node.getAttribute('aria-label') === 'Tipo de destino');
  const before = JSON.stringify(h.state.document);
  h.root.querySelectorAll('.pages-select-block')[0].click();
  h.root.querySelectorAll('.pages-select-block')[1].click();
  assert.equal(h.root.querySelectorAll('select').find(node => node.getAttribute('aria-label') === 'Tipo de destino'), target);
  assert.equal(h.root.querySelectorAll('select').filter(node => node.getAttribute('aria-label') === 'Tipo de destino').length, 1);
  assert.equal(JSON.stringify(h.state.document), before);
  assert.equal(h.editors[0].destroyed, 0);
});

test('V2 loader failure restores shell navigation; retry reenters the dedicated workspace', async t => {
  const h = await harness(t), originalLoader = h.api.workspace;
  h.api.workspace = async () => { throw Object.assign(new Error('Synthetic workspace unavailable'), { status: 404 }); };
  await h.replaceWithoutGuard('?id=missing');
  assert.equal(h.root.ownerDocument.body.classList.contains('pages-editor-active'), false);
  assert.ok(h.root.querySelector('[role="alert"]'));
  h.api.workspace = originalLoader;
  await h.replaceWithoutGuard('?id=first');
  assert.equal(h.root.ownerDocument.body.classList.contains('pages-editor-active'), true);
  assert.ok(h.root.querySelector('.pages-v2-workspace'));
});

test('V2 moved formatting controls reflect caret marks without rebuilding the toolbar', async t => {
  const h = await harness(t), pm = h.editors[0];
  const bold = h.root.querySelector('[data-mark="strong"]'), italic = h.root.querySelector('[data-mark="em"]');
  assert.equal(bold.getAttribute('aria-pressed'), 'false');
  pm.marks.add('strong'); pm.onSelection();
  assert.equal(bold.getAttribute('aria-pressed'), 'true');
  assert.equal(italic.getAttribute('aria-pressed'), 'false');
  pm.marks.delete('strong'); pm.marks.add('em'); pm.onSelection();
  assert.equal(bold.getAttribute('aria-pressed'), 'false');
  assert.equal(italic.getAttribute('aria-pressed'), 'true');
  assert.equal(h.root.querySelector('[data-mark="strong"]'), bold);
  assert.equal(pm.destroyed, 0);
});

test('localized presentation options retain enum values and keyed editors; selection-only updates preserve toolbar controls', async t => {
  const h = await harness(t), pm = h.editors[0];
  h.root.querySelector('.pages-select-block').click();
  const control = name => h.root.querySelectorAll('select').find(node => node.getAttribute('aria-label') === name);
  for (const [name, value, label] of [['Alinhamento','center','Centralizado'], ['Escala','large','Grande'], ['Paleta','warm','Quente'], ['Fonte','oswald','Oswald']]) {
    const select = control(name);
    assert.equal(select.querySelectorAll('option').find(node => node.value === value).textContent, label);
    select.value = value; select.dispatchEvent(new TestEvent('change'));
  }
  const block = h.state.document.sections[0].rows[0].columns[0].blocks[0];
  assert.equal(block.style.align, 'center'); assert.equal(block.style.scale, 'large');
  assert.equal(block.style.palette, 'warm'); assert.equal(block.style.font, 'oswald');
  assert.equal(h.editors[0], pm); assert.equal(pm.destroyed, 0);
  const font = control('Fonte'), label = h.root.querySelectorAll('input').find(node => node.getAttribute('aria-label') === 'Nome da seção 1');
  pm.onSelection(); assert.equal(control('Fonte'), font, 'text selection only updates active marks, not toolbar nodes');
  label.value = 'Seção renomeada'; label.dispatchEvent(new TestEvent('input'));
  assert.equal(control('Fonte'), font, 'ordinary metadata changes do not rebuild the selected toolbar');
  assert.ok(h.root.querySelector('.pages-toolbar-presentation'));
  assert.equal(h.root.querySelector('.pages-format-tools').querySelectorAll('.pages-toolbar-group').length, 5);
});

test('button and callout fields display Portuguese options without changing their saved values', async t => {
  const h = await harness(t), pm = h.editors[0];
  const click = text => { h.root.querySelectorAll('button').find(node => node.textContent === 'Inserir bloco').click(); h.root.ownerDocument.querySelectorAll('button').find(node => node.getAttribute('aria-label') === text).click(); };
  const control = name => h.root.querySelectorAll('select').find(node => node.getAttribute('aria-label') === name);
  click('Adicionar botão');
  const preset = control('Estilo do botão');
  assert.equal(preset.querySelectorAll('option').find(node => node.value === 'secondary').textContent, 'Secundário');
  preset.value = 'secondary'; preset.dispatchEvent(new TestEvent('change'));
  assert.equal(h.state.document.sections[0].rows[0].columns[0].blocks.find(block => block.type === 'button').preset, 'secondary');
  click('Adicionar destaque');
  assert.equal(h.root.querySelector('[data-block-type="callout"]').getAttribute('aria-label').split(': ')[1], 'Destaque');
  const tone = control('Tom'); assert.equal(tone.querySelectorAll('option').find(node => node.value === 'attention').textContent, 'Atenção');
  tone.value = 'attention'; tone.dispatchEvent(new TestEvent('change'));
  assert.equal(h.state.document.sections[0].rows[0].columns[0].blocks.find(block => block.type === 'callout').tone, 'attention');
  assert.equal(control('Ícone').querySelectorAll('option').find(node => node.value === 'none').textContent, 'Sem ícone');
  assert.equal(pm.destroyed, 0);
});

test('keyed media fields and load resolver see captions in the current state after composed copy replacement', async t => {
  const h = await harness(t), pm = h.editors[0], pending = await h.upload('video/mp4');
  pending.resolve({ media_id: randomUUID() }); await drain();
  const figure = h.figures[0], before = figure.options.resolveBlock();
  h.root.querySelectorAll('button').find(node => node.textContent === 'Adicionar seção').click();
  assert.notEqual(figure.options.resolveBlock(), before, 'composition really replaced/cloned the document');
  const cues = h.root.querySelectorAll('textarea').find(node => node.getAttribute('aria-label') === 'Legendas sincronizadas JSON');
  cues.value = JSON.stringify([{ start_ms: 0, end_ms: 1000, text: 'Legenda na cópia atual' }]); cues.dispatchEvent(new TestEvent('change'));
  assert.equal(figure.options.resolveBlock().captions[0].text, 'Legenda na cópia atual'); assert.equal(before.captions.length, 0);
  assert.ok(figure.refreshed >= 2); assert.equal(pm.destroyed, 0);
});

test('held upload survives skip-link/hash Back/Forward and completes only on its originating document; disposal cleans resources', async t => {
  const h = await harness(t), origin = h.state, upload = await h.upload();
  assert.equal(origin.uploads, 1); assert.equal(h.page.canLeave(), false);
  await h.pop('?id=first#main-content'); await h.pop('?id=first');
  assert.equal(h.state, origin); assert.equal(origin.uploads, 1); assert.equal(h.workspaces.length, 1);
  upload.resolve({ media_id: randomUUID() }); await drain();
  assert.equal(origin.uploads, 0); assert.equal(origin.document.sections[0].rows[0].columns[0].blocks.length, 2);
  assert.equal(origin.status, 'dirty'); assert.equal(h.figures.length, 1);
  h.page.dispose();
  assert.ok(h.editors.every(editor => editor.destroyed === 1)); assert.equal(h.figures[0].destroyed, 1);
  await h.pop('?id=third'); assert.equal(h.workspaces.length, 1, 'disposed history listener cannot reload');
});

for (const outcome of ['success', 'failure']) {
  test(`stale upload ${outcome} cannot alter a replacement document, retry UI or its pending counter`, async t => {
    const h = await harness(t), origin = h.state, stale = await h.upload();
    // Deliberately supersede the workspace at the loader seam, even though normal
    // navigation is blocked. Late transport callbacks must still be harmless.
    await h.replaceWithoutGuard('?id=second');
    const replacement = h.state, current = await h.upload(), before = h.root.textContent;
    assert.notEqual(replacement, origin); assert.equal(replacement.uploads, 1);
    if (outcome === 'success') stale.resolve({ media_id: randomUUID() }); else stale.reject(new Error('late old failure'));
    await drain();
    assert.equal(origin.uploads, 0); assert.equal(replacement.uploads, 1);
    assert.equal(h.state, replacement); assert.equal(h.retry, null); assert.equal(h.root.textContent, before);
    assert.equal(origin.document.sections[0].rows[0].columns[0].blocks.length, 1);
    assert.equal(replacement.document.sections[0].rows[0].columns[0].blocks.length, 1);
    assert.equal(h.figures.length, 0);
    current.resolve({ media_id: randomUUID() }); await drain();
    assert.equal(replacement.uploads, 0); assert.equal(replacement.document.sections[0].rows[0].columns[0].blocks.length, 2);
  });

  test(`disposal during upload ignores late ${outcome} and balances only its original counter`, async t => {
    const h = await harness(t), origin = h.state, pending = await h.upload(), before = h.root.textContent;
    h.page.dispose();
    if (outcome === 'success') pending.resolve({ media_id: randomUUID() }); else pending.reject(new Error('late disposed failure'));
    await drain();
    assert.equal(origin.uploads, 0); assert.equal(h.root.textContent, before); assert.equal(h.retry, null);
    assert.equal(h.figures.length, 0); assert.ok(h.editors.every(editor => editor.destroyed === 1));
    assert.equal(origin.document.sections[0].rows[0].columns[0].blocks.length, 1);
  });
}
