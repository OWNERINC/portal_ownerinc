import assert from 'node:assert/strict';
import test from 'node:test';
import { createMountedHarness, drain, TestEvent } from '../helpers/cms-harness.mjs';

const PDF = '550e8400-e29b-41d4-a716-446655440001';
const IMAGE = '550e8400-e29b-41d4-a716-446655440002';
const docA = {
  id: 'document-a', title: 'Documento A', content_type: 'knowledge', category: 'Categoria A',
  draft_revision_id: 'draft-a', published_revision_id: 'published-a', published_at: '2026-09-28T12:00:00Z',
};
const docB = { id: 'document-b', title: 'Documento B', content_type: 'knowledge', category: 'Categoria B', draft_revision_id: 'draft-b' };
const blocksA = [
  { type: 'paragraph', text: 'Conteúdo exclusivo de A' },
  { type: 'pdf', asset_id: PDF, title: 'PDF de A' },
  { type: 'image', asset_id: IMAGE, alt: 'Imagem de A' },
];
const blocksB = [{ type: 'paragraph', text: 'Conteúdo exclusivo de B' }];
const view = (document, blocks) => ({ document: { ...document }, draft: { id: document.draft_revision_id, blocks: structuredClone(blocks) } });
const revisions = (count = 50, total = 75) => ({
  data: Array.from({ length: count }, (_, index) => ({ version: total - index, status: 'draft', created_at: '2026-09-28T12:00:00Z' })), total,
});
const button = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);
const documentButton = (h, title) => h.node('document-list').querySelectorAll('button').find(node => node.textContent.startsWith(title));
const typeButton = (h, type) => button(h.node('content-types'), type);
const plain = value => JSON.parse(JSON.stringify(value));

async function setup(t, { resolveList = true } = {}) {
  const h = await createMountedHarness();
  t.after(() => h.page.dispose());
  if (resolveList) {
    h.latest('/documents?').resolve({ data: [docA, docB], total: 2 });
    await drain();
  }
  return h;
}

async function openA(h, { history = true, blocks = blocksA } = {}) {
  documentButton(h, docA.title).click();
  h.latest('/documents/document-a').resolve(view(docA, blocks));
  await drain();
  if (history) {
    h.latest('/document-a/revisions?').resolve(revisions());
    await drain();
  }
}

function assertCleared(h, { save = 'Selecione um documento', editor = /Selecione um documento/ } = {}) {
  assert.equal(h.node('save-state').textContent, save);
  assert.match(h.node('editor-root').textContent, editor);
  assert.equal(h.node('editor-heading').textContent, 'Selecione um documento');
  assert.equal(h.node('editor-status').textContent, 'Nenhum');
  assert.equal(h.node('editor-status').className, 'badge badge-gray');
  assert.equal(h.node('preview-root').textContent, 'A prévia aparecerá aqui.');
  assert.equal(h.node('preview-root').querySelectorAll('img, iframe, video').length, 0);
  assert.equal(h.node('revision-history').textContent, 'Selecione um documento.');
  assert.equal(h.node('revision-history-pagination').children.length, 0);
  assert.equal(h.node('inspector-block-settings').dataset.selectedIndex, undefined);
  for (const id of ['inspector-type', 'inspector-category', 'inspector-published']) assert.equal(h.node(id).textContent, '—');
  for (const id of ['save-draft', 'publish-document', 'unpublish-document', 'schedule-document', 'unschedule-document', 'load-history']) {
    assert.equal(h.node(id).disabled, true, `${id} must have no old selection to act on`);
  }
  assert.equal(h.node('scheduled-at').value, '');
}

test('CMS is initially neutral while the document list loads or fails', async t => {
  const h = await setup(t, { resolveList: false });
  assert.match(h.html, /id="save-state"[^>]*>Selecione um documento<\/span>/);
  assertCleared(h);
  assert.match(h.node('document-list').textContent, /Carregando documentos/);
  h.latest('/documents?').reject(new Error('list unavailable'));
  await drain();
  assertCleared(h);
  assert.match(h.node('document-list').textContent, /Não foi possível carregar os documentos/);
});

test('A with more than 50 revisions to an empty area clears every selection-derived presentation and resource', async t => {
  const h = await setup(t);
  await openA(h);
  h.latest(`/assets/${PDF}`).resolve('blob:a-pdf');
  await drain();
  const pendingImage = h.latest(`/assets/${IMAGE}`);
  assert.equal(h.node('preview-root').querySelector('iframe').src, 'blob:a-pdf');
  assert.equal(h.node('save-state').textContent, 'Salvo');
  assert.match(h.node('revision-history').textContent, /v75/);
  assert.match(h.node('revision-history-pagination').textContent, /Página 1 de 2/);
  const oldNext = button(h.node('revision-history-pagination'), 'Próxima');
  h.node('editor-root').querySelectorAll('.cms-block-select')[1].click();
  assert.equal(h.node('inspector-block-settings').dataset.selectedIndex, '1');
  h.node('scheduled-at').value = '2026-10-01T10:00';
  h.node('unpublish-document').click();
  h.latest('/unpublish').reject(new Error('mutation unavailable'));
  await drain();
  assert.equal(h.node('cms-error').hidden, false);

  // The renderer must release resources before replacing its still-connected
  // preview. The MutationObserver double intentionally does not fire here.
  const preview = h.node('preview-root');
  const replace = preview.replaceChildren.bind(preview);
  preview.replaceChildren = (...nodes) => {
    assert.ok(h.revoked.includes('blob:a-pdf'));
    assert.equal(pendingImage.options.signal.aborted, true);
    replace(...nodes);
  };
  typeButton(h, 'Owner News').click();
  assertCleared(h);
  assert.equal(h.node('cms-error').hidden, true);
  assert.equal(h.node('cms-error').textContent, '');
  assert.equal(typeButton(h, 'Owner News').getAttribute('aria-current'), 'true');
  assert.match(h.latest('/documents?').path, /type=announcement&limit=50&offset=0$/);
  const count = h.requests.length;
  oldNext.click();
  assert.equal(h.requests.length, count);
  h.latest('/documents?').resolve({ data: [], total: 0 });
  pendingImage.resolve('blob:late-a-image');
  await drain();
  assertCleared(h);
  assert.match(h.node('document-list').textContent, /Nenhum documento nesta área/);
  assert.ok(h.revoked.includes('blob:late-a-image'));
  assert.equal(h.node('new-document').disabled, false);
});

for (const outcome of ['success', 'failure']) {
  test(`late A revision ${outcome} cannot restore history after changing to an empty area`, async t => {
    const h = await setup(t);
    await openA(h, { blocks: blocksA.slice(0, 1) });
    button(h.node('revision-history-pagination'), 'Próxima').click();
    const oldHistory = h.latest('/document-a/revisions?');
    assert.match(oldHistory.path, /offset=50$/);
    assert.match(h.node('revision-history').textContent, /Carregando histórico/);
    assert.equal(h.node('revision-history-pagination').children.length, 0);
    typeButton(h, 'Owner News').click();
    assertCleared(h);
    h.latest('/documents?').resolve({ data: [], total: 0 });
    if (outcome === 'success') oldHistory.resolve(revisions(25));
    else oldHistory.reject(new Error('old history failure'));
    await drain();
    assertCleared(h);
    // Returning to A must start history at zero rather than retaining offset 50.
    typeButton(h, 'Base de Conhecimento').click();
    h.latest('/documents?').resolve({ data: [docA], total: 1 });
    await drain();
    await openA(h, { history: false, blocks: blocksA.slice(0, 1) });
    assert.match(h.latest('/document-a/revisions?').path, /offset=0$/);
  });
}

test('selecting B immediately removes A; a failed B stays empty and can retry the same document', async t => {
  const h = await setup(t);
  await openA(h);
  const oldHistoryRefresh = h.node('load-history');
  oldHistoryRefresh.click();
  const lateAHistory = h.latest('/document-a/revisions?');
  const oldEditor = h.editorCallbacks[0];
  const oldInput = h.node('inspector-block-settings').querySelector('textarea');
  const oldAsset = h.latest(`/assets/${PDF}`);
  const originalBlocks = plain(oldEditor.initialBlocks);
  h.node('scheduled-at').value = '2026-10-01T12:00';
  documentButton(h, docB.title).click();
  const firstB = h.latest('/documents/document-b');
  assertCleared(h, { save: 'Carregando…', editor: /Carregando documento/ });
  assert.equal(oldAsset.options.signal.aborted, true);
  assert.equal(documentButton(h, docB.title).getAttribute('aria-current'), 'true');
  lateAHistory.resolve(revisions());
  oldAsset.reject(new Error('late asset failure'));
  await drain();
  assertCleared(h, { save: 'Carregando…', editor: /Carregando documento/ });
  firstB.reject(new Error('B failed'));
  await drain();
  assertCleared(h, { save: 'Erro ao carregar', editor: /Não foi possível abrir este documento/ });
  assert.equal(h.node('cms-error').hidden, false);
  assert.equal(typeButton(h, 'Owner News').disabled, false, 'failure releases the existing loading guard');
  const retry = button(h.node('editor-root'), 'Tentar novamente');
  retry.click();
  assert.equal(h.matching('/documents/document-b').length, 2);
  assert.equal(h.node('cms-error').hidden, true);
  assertCleared(h, { save: 'Carregando…', editor: /Carregando documento/ });
  h.latest('/documents/document-b').resolve(view(docB, blocksB));
  await drain();
  assert.equal(h.node('editor-heading').textContent, docB.title);
  assert.match(h.node('preview-root').textContent, /Conteúdo exclusivo de B/);
  assert.doesNotMatch(h.node('preview-root').textContent, /exclusivo de A/);
  assert.equal(h.node('inspector-category').textContent, 'Categoria B');
  assert.equal(h.node('cms-error').hidden, true);
  assert.match(h.latest('/document-b/revisions?').path, /offset=0$/);
  h.latest('/document-b/revisions?').resolve(revisions(1, 1));
  await drain();
  const count = h.requests.length;
  retry.click();
  assert.equal(h.requests.length, count, 'the retry from B failure is stale after a new request succeeds');
  oldEditor.onSelect(0, blocksA[0]);
  oldEditor.onChange([{ type: 'paragraph', text: 'Stale change from A' }]);
  h.input(oldInput, 'Detached A field');
  assert.equal(h.node('save-state').textContent, 'Salvo');
  assert.match(h.node('preview-root').textContent, /Conteúdo exclusivo de B/);
  assert.equal(h.node('inspector-block-settings').querySelector('textarea').value, 'Conteúdo exclusivo de B');
  assert.equal(h.timers.size, 0);

  h.input(h.node('inspector-block-settings').querySelector('textarea'), 'Novo texto de B');
  await h.runTimers();
  const save = h.latest('/draft');
  assert.equal(save.path, '/api/cms/documents/document-b/draft');
  assert.deepEqual(JSON.parse(save.options.body).blocks, [{ type: 'paragraph', text: 'Novo texto de B' }]);
  assert.deepEqual(plain(oldEditor.initialBlocks), originalBlocks, 'new editor callbacks do not mutate A');
});

test('late A revision failure cannot overwrite B history and old A pagers cannot query B', async t => {
  const h = await setup(t);
  await openA(h, { blocks: blocksA.slice(0, 1) });
  const oldNext = button(h.node('revision-history-pagination'), 'Próxima');
  h.node('load-history').click();
  const oldHistory = h.latest('/document-a/revisions?');
  documentButton(h, docB.title).click();
  h.latest('/documents/document-b').resolve(view(docB, blocksB));
  await drain();
  h.latest('/document-b/revisions?').resolve(revisions(1, 3));
  await drain();
  oldHistory.reject(new Error('late A failure'));
  const count = h.requests.length;
  oldNext.click();
  await drain();
  assert.equal(h.requests.length, count);
  assert.match(h.node('revision-history').textContent, /v3/);
  assert.doesNotMatch(h.node('revision-history').textContent, /Não foi possível|v75/);
});

test('dirty internal navigation remains blocked and cancelled external leave retains the draft', async t => {
  const h = await setup(t);
  await openA(h, { blocks: blocksA.slice(0, 1) });
  const input = h.node('inspector-block-settings').querySelector('textarea');
  h.input(input, 'Rascunho que deve permanecer');
  const count = h.requests.length;
  typeButton(h, 'Owner News').click();
  documentButton(h, docB.title).click();
  assert.equal(h.requests.length, count);
  assert.equal(h.confirms, 0, 'internal navigation blocks; it does not invent a discard prompt');
  assert.equal(h.page.canLeave(), false);
  assert.equal(h.confirms, 1);
  assert.equal(input.value, 'Rascunho que deve permanecer');
  assert.equal(h.node('editor-heading').textContent, docA.title);
  assert.equal(h.node('save-state').textContent, 'Alterações pendentes');
  assert.match(h.node('preview-root').textContent, /Rascunho que deve permanecer/);
  assert.match(h.node('revision-history').textContent, /v75/);
  assert.equal(h.node('inspector-category').textContent, 'Categoria A');
  assert.equal(h.timers.size, 1, 'the existing autosave remains armed after cancelling leave');
});

test('pending autosaves still coalesce edits and block selection reset without discarding newer edits', async t => {
  const h = await setup(t);
  await openA(h, { blocks: blocksA.slice(0, 1) });
  const input = h.node('inspector-block-settings').querySelector('textarea');
  h.input(input, 'Primeira edição');
  h.node('save-draft').click();
  const firstSave = h.latest('/draft');
  h.input(input, 'Edição mais recente');
  const count = h.requests.length;
  typeButton(h, 'Owner News').click();
  documentButton(h, docB.title).click();
  assert.equal(h.requests.length, count);
  assert.equal(h.page.canLeave(), false);
  assert.equal(h.confirms, 0, 'no confirmation may abandon an in-flight write');
  assert.equal(h.node('editor-heading').textContent, docA.title);
  firstSave.resolve({ document: { ...docA, draft_revision_id: 'first-saved' }, revision: { id: 'first-saved' } });
  await drain();
  assert.equal(h.matching('/draft').length, 2);
  const secondSave = h.latest('/draft');
  assert.deepEqual(JSON.parse(firstSave.options.body).blocks, [{ type: 'paragraph', text: 'Primeira edição' }]);
  assert.deepEqual(JSON.parse(secondSave.options.body).blocks, [{ type: 'paragraph', text: 'Edição mais recente' }]);
  assert.equal(h.page.canLeave(), false);
  secondSave.resolve({ document: { ...docA, draft_revision_id: 'second-saved' }, revision: { id: 'second-saved' } });
  await drain();
  assert.equal(h.node('save-state').textContent, 'Rascunho salvo');
  assert.match(h.node('preview-root').textContent, /Edição mais recente/);
  assert.equal(h.page.canLeave(), true);
  typeButton(h, 'Owner News').click();
  assertCleared(h);
});

test('publication keeps the saved revision contract and blocks selection during the mutation', async t => {
  const h = await setup(t);
  await openA(h, { blocks: blocksA.slice(0, 1) });
  h.node('publish-document').click();
  h.latest('/draft').resolve({ document: { ...docA, draft_revision_id: 'saved-to-publish' }, revision: { id: 'saved-to-publish' } });
  await drain();
  const publish = h.latest('/publish');
  assert.deepEqual(JSON.parse(publish.options.body), { revision_id: 'saved-to-publish' });
  const count = h.requests.length;
  typeButton(h, 'Owner News').click();
  documentButton(h, docB.title).click();
  assert.equal(h.requests.length, count);
  assert.equal(h.page.canLeave(), false);
  assert.equal(h.confirms, 0);
  assert.equal(h.node('editor-heading').textContent, docA.title);
  publish.resolve({ document: { ...docA, draft_revision_id: null, published_revision_id: 'saved-to-publish' }, revision: { id: 'saved-to-publish' } });
  await drain();
  assert.equal(h.node('save-state').textContent, 'Publicado');
  assert.equal(h.node('editor-status').textContent, 'Publicado');
  assert.equal(h.page.canLeave(), true);
});

test('asset upload ownership blocks internal and external transitions rather than being reset', async t => {
  const h = await setup(t);
  await openA(h);
  h.node('editor-root').querySelectorAll('.cms-block-select')[2].click();
  const input = h.node('inspector-block-settings').querySelector('input[type="file"]');
  input.files = [{ name: 'test.png' }];
  input.dispatchEvent(new TestEvent('change'));
  const upload = h.requests.find(request => request.path === '/api/cms/assets' && request.options.method === 'POST');
  assert.ok(upload);
  const count = h.requests.length;
  typeButton(h, 'Owner News').click();
  documentButton(h, docB.title).click();
  assert.equal(h.requests.length, count);
  assert.equal(h.page.canLeave(), false);
  assert.equal(h.confirms, 0);
  assert.equal(h.node('editor-heading').textContent, docA.title);
  assert.equal(h.node('inspector-block-settings').dataset.selectedIndex, '2');
  upload.reject(new Error('test upload failure'));
  await drain();
  assert.equal(h.page.canLeave(), true);
  typeButton(h, 'Owner News').click();
  assertCleared(h);
});

test('real CMS lifecycle disposal aborts loaders, cancels autosave and invalidates editor callbacks', async t => {
  const h = await setup(t);
  await openA(h, { history: false });
  const history = h.latest('/document-a/revisions?');
  const asset = h.latest(`/assets/${PDF}`);
  const oldEditor = h.editorCallbacks[0];
  h.input(h.node('inspector-block-settings').querySelector('textarea'), 'Edição antes de sair');
  assert.equal(h.timers.size, 1);
  const before = { preview: h.node('preview-root').textContent, history: h.node('revision-history').textContent, save: h.node('save-state').textContent };
  h.page.dispose();
  assert.equal(h.timers.size, 0);
  assert.equal(history.options.signal.aborted, true);
  assert.equal(asset.options.signal.aborted, true);
  history.resolve(revisions());
  asset.resolve('blob:after-dispose');
  oldEditor.onChange(blocksB);
  oldEditor.onSelect(0, blocksB[0]);
  await drain();
  assert.deepEqual({ preview: h.node('preview-root').textContent, history: h.node('revision-history').textContent, save: h.node('save-state').textContent }, before);
  assert.ok(h.revoked.includes('blob:after-dispose'));
  assert.equal(h.matching('/draft').length, 0);
});

for (const outcome of ['success', 'failure']) {
  test(`a late document ${outcome} cannot replace the disposed CMS selection`, async t => {
    const h = await setup(t);
    documentButton(h, docB.title).click();
    const pending = h.latest('/documents/document-b');
    const before = { editor: h.node('editor-root').textContent, preview: h.node('preview-root').textContent, save: h.node('save-state').textContent };
    h.page.dispose();
    assert.equal(pending.options.signal.aborted, true);
    if (outcome === 'success') pending.resolve(view(docB, blocksB));
    else pending.reject(new Error('late document failure'));
    await drain();
    assert.deepEqual({ editor: h.node('editor-root').textContent, preview: h.node('preview-root').textContent, save: h.node('save-state').textContent }, before);
    assert.equal(h.matching('/revisions?').length, 0);
    assert.equal(h.editorCallbacks.length, 0);
  });
}
