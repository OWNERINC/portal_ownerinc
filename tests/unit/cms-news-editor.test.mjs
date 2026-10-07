import assert from 'node:assert/strict';
import test from 'node:test';
import { createMountedHarness, drain, TestEvent } from '../helpers/cms-harness.mjs';

const button = (root, text) => root.querySelectorAll('button').find(node => node.textContent === text);
const meta = summary => ({ version: 1, kind: 'article', summary, author: '', source_label: '', source_date: null });
const doc = { id: 'news-a', title: 'Matéria sintética', content_type: 'announcement', draft_revision_id: 'draft-a' };
test('Payload authority exposes migration/read-only history without editable legacy blocks or actions', async t => {
  const h = await createMountedHarness('cms', { authority: { mode: 'payload', epoch: 2 } }); t.after(() => h.page.dispose());
  h.latest('/documents?').resolve({ data: [], total: 0 }); await drain();
  button(h.node('content-types'), 'Owner News').click(); h.latest('/documents?').resolve({ data: [doc], total: 1 }); await drain();
  assert.equal(h.node('owner-news-authority').hidden, false); assert.match(h.node('owner-news-authority').textContent, /usa o Payload/);
  assert.equal(h.node('owner-news-payload-entry').hidden, true, 'runtime unavailable hides the entry link');
  assert.equal(h.node('new-document').disabled, true);
  h.node('document-list').querySelector('button').click(); h.latest('/documents/news-a').resolve({ document: doc, draft: { blocks: [{ type: 'paragraph', text: 'Histórico anterior.' }] } }); await drain();
  assert.match(h.node('editor-root').textContent, /somente leitura/); assert.match(h.node('preview-root').textContent, /Histórico anterior/);
  assert.equal(h.editorCallbacks.length, 0); assert.equal(h.node('publish-document').disabled, true); assert.equal(h.node('save-draft').disabled, true);
  assert.equal(h.node('load-history').disabled, false); assert.equal(h.doc.querySelector('.cms-inspector').inert, false);
  const count = h.requests.length; h.node('save-draft').click(); h.node('publish-document').click(); await drain(); assert.equal(h.requests.length, count);
});
async function setup(t, editorial = meta('Resumo do rascunho')) {
  const h = await createMountedHarness();
  t.after(() => h.page.dispose());
  h.latest('/documents?').resolve({ data: [], total: 0 }); await drain();
  button(h.node('content-types'), 'Owner News').click();
  h.latest('/documents?').resolve({ data: [doc], total: 1 }); await drain();
  h.node('document-list').querySelector('button').click();
  h.latest('/documents/news-a').resolve({ document: doc,
    draft: { id: 'draft-a', blocks: [{ type: 'paragraph', text: 'Corpo sintético.' }], editorial },
    published: { blocks: [], editorial: meta('Resumo publicado isolado') } });
  await drain();
  return h;
}

test('news metadata belongs to selected revision and publish uses the saved snapshot revision', async t => {
  const h = await setup(t);
  const summary = h.node('cms-editorial-fields')?.querySelector('[name="summary"]');
  assert.ok(summary, 'editorial summary control exists');
  assert.equal(summary.value, 'Resumo do rascunho');
  h.input(summary, 'Resumo alterado');
  h.node('publish-document').click();
  const save = h.latest('/draft');
  assert.deepEqual(JSON.parse(save.options.body), { blocks: [{ type: 'paragraph', text: 'Corpo sintético.' }], editorial: meta('Resumo alterado') });
  save.resolve({ document: doc, revision: { id: 'saved-news', ...JSON.parse(save.options.body) } }); await drain();
  assert.deepEqual(JSON.parse(h.latest('/publish').options.body), { revision_id: 'saved-news' });
  h.latest('/publish').resolve({ document: doc, revision: { id: 'saved-news' } }); await drain();
});

test('legacy null metadata stays null until explicit preparation, without borrowing published fields', async t => {
  const h = await setup(t, null);
  const root = h.node('cms-editorial-fields');
  assert.ok(root);
  assert.equal(root.querySelector('[name="summary"]'), null);
  button(root, 'Preparar matéria editorial').click();
  assert.equal(root.querySelector('[name="summary"]').value, '');
  assert.equal(root.querySelector('[name="author"]').value, '');
  h.node('publish-document').click();
  assert.equal(h.matching('/publish').length, 0);
  assert.match(h.node('cms-error').textContent, /Resumo/);
});

test('metadata autosave snapshots retain newer edits and civil dates in the queued save', async t => {
  const h = await setup(t);
  const root = h.node('cms-editorial-fields');
  h.input(root.querySelector('[name="summary"]'), 'Primeiro resumo');
  await h.runTimers();
  const first = h.latest('/draft');
  h.input(root.querySelector('[name="summary"]'), 'Segundo resumo');
  h.input(root.querySelector('[name="source_date"]'), '2026-05-01');
  assert.equal(JSON.parse(first.options.body).editorial.summary, 'Primeiro resumo');
  first.resolve({ document: doc, revision: { id: 'first', ...JSON.parse(first.options.body) } }); await drain();
  const second = h.latest('/draft');
  assert.notEqual(first, second);
  assert.equal(JSON.parse(second.options.body).editorial.summary, 'Segundo resumo');
  assert.equal(JSON.parse(second.options.body).editorial.source_date, '2026-05-01');
  assert.notEqual(h.node('save-state').textContent, 'Rascunho salvo');
  second.resolve({ document: doc, revision: { id: 'second', ...JSON.parse(second.options.body) } }); await drain();
  assert.equal(h.node('save-state').textContent, 'Rascunho salvo');
});

test('announcement palette, cover reorder, optional fields and typography serialize through real controls', async t => {
  const h = await setup(t);
  const root = h.node('editor-root');
  assert.ok(button(root, '+ Citação'));
  assert.ok(button(root, '+ Perfil'));
  button(root, '+ Imagem').click();
  root.querySelectorAll('.cms-block-select')[1].click();
  const fields = h.node('inspector-block-settings');
  for (const [name, value] of Object.entries({ asset_id: '550e8400-e29b-41d4-a716-446655440002', alt: 'Capa sintética', usage: 'cover', layout: 'full', caption: ' ', credit: '' })) h.input(fields.querySelector(`[name="${name}"]`), value);
  button(root.querySelectorAll('.cms-editor-block')[1], 'Subir').click();
  h.node('save-draft').click();
  const saved = JSON.parse(h.latest('/draft').options.body);
  assert.deepEqual(saved.blocks[0], { type: 'image', asset_id: '550e8400-e29b-41d4-a716-446655440002', alt: 'Capa sintética', usage: 'cover', layout: 'full' });
  assert.equal(saved.blocks[1].type, 'paragraph');
  h.latest('/draft').resolve({ document: doc, revision: { id: 'cover', ...saved } }); await drain();
  button(root, '+ Citação').click();
  root.querySelectorAll('.cms-block-select')[2].click();
  h.input(fields.querySelector('[name="attribution"]'), 'Pessoa sintética');
  h.input(fields.querySelector('[name="typography"]'), 'sans');
  h.input(fields.querySelector('[name="layout"]'), 'left');
  button(root, '+ Perfil').click();
  root.querySelectorAll('.cms-block-select')[3].click();
  for (const name of ['name', 'role', 'text', 'alt', 'asset_id', 'asset', 'layout', 'typography']) assert.ok(fields.querySelector(`[name="${name}"]`), name);
  h.node('save-draft').click();
  const last = JSON.parse(h.latest('/draft').options.body);
  assert.equal(last.blocks[2].attribution, 'Pessoa sintética');
  assert.equal(last.blocks[2].typography, 'sans');
  assert.equal(last.blocks[2].layout, 'left');
  assert.deepEqual(last.blocks[3], { type: 'profile', name: 'Nome da pessoa' });
});

test('news preview releases private assets before replacement and upload retains preview while blocking navigation', async t => {
  const h = await setup(t);
  const root = h.node('editor-root');
  button(root, '+ Perfil').click(); root.querySelectorAll('.cms-block-select')[1].click();
  const fields = h.node('inspector-block-settings');
  h.input(fields.querySelector('[name="alt"]'), 'Retrato sintético');
  const input = fields.querySelector('[name="asset"]');
  input.files = [{ name: 'synthetic.png' }]; input.dispatchEvent(new TestEvent('change'));
  const before = h.node('preview-root').textContent;
  assert.equal(h.node('save-draft').disabled, true);
  assert.equal(h.node('publish-document').disabled, true);
  button(h.node('owner-news-sections'), 'Página inicial').click();
  assert.equal(h.node('owner-news-settings').hidden, true);
  assert.equal(h.node('preview-root').textContent, before);
  h.latest('/api/cms/assets').resolve({ id: '550e8400-e29b-41d4-a716-446655440002' }); await drain();
  h.latest('/assets/550e8400').resolve('blob:profile'); await drain();
  const pending = h.latest('/assets/550e8400');
  h.input(h.node('cms-editorial-fields').querySelector('[name="summary"]'), 'Outra prévia');
  assert.ok(h.revoked.includes('blob:profile'));
  assert.equal(pending.options.signal.aborted, true);
  const late = h.latest('/assets/550e8400');
  h.context.confirmResult = true;
  button(h.node('owner-news-sections'), 'Página inicial').click();
  assert.equal(late.options.signal.aborted, true);
  late.resolve('blob:late'); await drain();
  assert.ok(h.revoked.includes('blob:late'));
});

async function openHome(h) {
  button(h.node('owner-news-sections'), 'Página inicial').click();
  const content = { version: 1, eyebrow: 'Chamada sintética', headline: 'Título sintético', summary: 'Resumo sintético' };
  h.latest('/owner-news/home').resolve({ version: 3, draft: content, published: null }); await drain();
  return { root: h.node('owner-news-settings'), content };
}

test('home separates draft and publish, preserves conflict values, and guards discard before clearing selection', async t => {
  const h = await setup(t);
  const { root, content } = await openHome(h);
  const summary = root.querySelector('[name="summary"]');
  h.input(summary, 'Abertura local');
  assert.equal(button(root, 'Publicar').disabled, true);
  assert.equal(h.page.canLeave(), false);
  button(h.node('owner-news-sections'), 'Matérias').click();
  assert.equal(root.hidden, false);
  assert.equal(summary.value, 'Abertura local');
  root.querySelector('form').dispatchEvent(new TestEvent('submit'));
  const save = h.latest('/home/draft');
  assert.deepEqual(JSON.parse(save.options.body), { expected_version: 3, content: { ...content, summary: 'Abertura local' } });
  assert.equal(h.matching('/home/publish').length, 0);
  assert.equal(h.page.canLeave(), false);
  save.reject(Object.assign(new Error('conflict'), { status: 409 })); await drain();
  assert.equal(summary.value, 'Abertura local');
  assert.match(root.textContent, /outra sessão/);
  assert.equal(button(root, 'Recarregar versão atual').hidden, false);
  button(root, 'Recarregar versão atual').click();
  assert.equal(h.matching('/owner-news/home').length, 2, 'cancelled reload must not fetch');
  h.context.confirmResult = true;
  button(root, 'Recarregar versão atual').click();
  h.latest('/owner-news/home').resolve({ version: 4, draft: content, published: null }); await drain();
  button(root, 'Publicar').click();
  assert.deepEqual(JSON.parse(h.latest('/home/publish').options.body), { expected_version: 4 });
  h.latest('/home/publish').resolve({ version: 5, draft: null, published: content }); await drain();
  assert.equal(button(root, 'Publicar').disabled, true);
  assert.match(root.textContent, /Abertura publicada/);
});

test('home loader and detached controls cannot restore state after subarea disposal', async t => {
  const h = await setup(t);
  button(h.node('owner-news-sections'), 'Página inicial').click();
  const pending = h.latest('/owner-news/home');
  const oldForm = h.node('owner-news-settings').querySelector('form');
  button(h.node('owner-news-sections'), 'Matérias').click();
  assert.equal(pending.options.signal.aborted, true);
  pending.resolve({ version: 1, draft: null, published: null }); await drain();
  oldForm.dispatchEvent(new TestEvent('submit'));
  assert.equal(h.node('owner-news-settings').children.length, 0);
  assert.equal(h.matching('/home/draft').length, 0);
  assert.equal(h.node('new-document').disabled, false);
});

test('editorial publication validation rejects profiles without biography and duplicate media roles', async t => {
  const h = await setup(t);
  const validate = h.context.editorialPublicationError;
  assert.match(validate(meta('Resumo'), [{ type: 'profile', name: 'Pessoa' }]), /corpo/);
  assert.equal(validate(meta('Resumo'), [{ type: 'profile', name: 'Pessoa', text: 'Biografia sintética' }]), '');
  assert.match(validate(null, [{ type: 'image', usage: 'cover' }, { type: 'image', usage: 'cover' }]), /apenas uma/);
  assert.match(validate(meta('Resumo'), [{ type: 'pdf', usage: 'edition' }, { type: 'pdf', usage: 'edition' }]), /apenas um PDF/);
});

test('home draft save succeeds without publishing and transient failure retains editable local values for retry', async t => {
  const h = await setup(t);
  const { root, content } = await openHome(h);
  h.input(root.querySelector('[name="headline"]'), 'Primeira linha\nSegunda linha');
  const form = root.querySelector('form');
  form.dispatchEvent(new TestEvent('submit'));
  h.latest('/home/draft').reject(new Error('offline')); await drain();
  assert.equal(root.querySelector('[name="headline"]').value, 'Primeira linha\nSegunda linha');
  assert.equal(root.querySelector('[name="headline"]').disabled, false);
  assert.equal(button(root, 'Salvar rascunho').disabled, false);
  form.dispatchEvent(new TestEvent('submit'));
  const saved = { ...content, headline: 'Primeira linha\nSegunda linha' };
  assert.deepEqual(JSON.parse(h.latest('/home/draft').options.body), { expected_version: 3, content: saved });
  h.latest('/home/draft').resolve({ version: 4, draft: saved, published: null }); await drain();
  assert.equal(h.matching('/home/publish').length, 0);
  assert.equal(h.page.canLeave(), true);
  assert.equal(button(root, 'Publicar').disabled, false);
  button(root, 'Publicar').click();
  assert.deepEqual(JSON.parse(h.latest('/home/publish').options.body), { expected_version: 4 });
});

test('discarding article edits is confirmed before clearing and stale profile uploads cannot reach the next document', async t => {
  const h = await setup(t);
  button(h.node('editor-root'), '+ Perfil').click();
  h.node('editor-root').querySelectorAll('.cms-block-select')[1].click();
  const staleUpload = h.node('inspector-block-settings').querySelector('[name="asset"]');
  button(h.node('owner-news-sections'), 'Página inicial').click();
  assert.equal(h.node('editor-heading').textContent, doc.title);
  assert.equal(h.node('owner-news-settings').hidden, true);
  h.context.confirmResult = true;
  button(h.node('owner-news-sections'), 'Página inicial').click();
  button(h.node('content-types'), 'Base de Conhecimento').click();
  const next = { id: 'knowledge-b', title: 'Documento seguinte', content_type: 'knowledge' };
  h.latest('/documents?').resolve({ data: [next], total: 1 }); await drain();
  h.node('document-list').querySelector('button').click();
  h.latest('/documents/knowledge-b').resolve({ document: next, draft: { blocks: [{ type: 'paragraph', text: 'Outra revisão' }] } }); await drain();
  assert.equal(button(h.node('editor-root'), '+ Perfil'), undefined);
  assert.equal(h.node('inspector-block-settings').querySelector('[name="layout"]'), null);
  staleUpload.files = [{ name: 'stale.png' }]; staleUpload.dispatchEvent(new TestEvent('change'));
  h.latest('/api/cms/assets').resolve({ id: '550e8400-e29b-41d4-a716-446655440002' }); await drain();
  assert.equal(h.node('save-state').textContent, 'Salvo');
  assert.equal(h.timers.size, 0);
  h.node('save-draft').click();
  assert.deepEqual(JSON.parse(h.latest('/draft').options.body).blocks, [{ type: 'paragraph', text: 'Outra revisão' }]);
});
