import assert from 'node:assert/strict';
import test from 'node:test';
import { createKnowledgeEditorialHarness, editor, drain } from '../helpers/knowledge-editorial-harness.mjs';

const PDF = '550e8400-e29b-41d4-a716-446655440001';
const TEMP_PDF = '550e8400-e29b-41d4-a716-446655440002';
const blocks = [{ type: 'paragraph', text: 'Corpo preservado' }];
const legacyArticle = { id: 'article-a', title: 'Política', category: 'DHO', content: 'Texto legado editável', cms_managed: false };
const managedArticle = { ...legacyArticle, cms_managed: true, content: 'Não deve substituir os blocos', content_blocks: blocks };
const compactText = node => node.textContent.replace(/\s+/g, ' ').trim();

test('Knowledge legacy guidance keeps simple text required/editable with native help associations', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  await h.showArticle(legacyArticle);
  assert.equal(h.node('modal-article').classList.contains('hidden'), false);
  assert.equal(h.node('f-content').disabled, false);
  assert.equal(h.node('f-content').required, true);
  assert.equal(h.node('f-content').value, legacyArticle.content);
  assert.match(compactText(h.node('f-content-help')), /texto simples.*editável/i);
  assert.match(compactText(h.node('article-editor-help')), /título, categoria e anexo PDF/i);
  assert.equal(h.node('article-cms-help'), null);
  assert.equal(h.node('article-cms-link'), null);
  assert.deepEqual(h.node('f-content').getAttribute('aria-describedby').split(/\s+/), ['f-content-help']);
  for (const [id, help] of [['f-title', 'article-editor-help'], ['f-category', 'article-editor-help'], ['f-content', 'f-content-help'], ['f-pdf', 'f-pdf-status']]) {
    assert.ok(h.doc.querySelector(`label[for="${id}"]`), `${id}: native label`);
    assert.ok(h.node(id).getAttribute('aria-describedby').split(/\s+/).includes(help), `${id}: helper association`);
  }
  h.input('f-title', ' Título atualizado '); h.input('f-category', ' Categoria '); h.input('f-content', ' Texto simples atualizado ');
  await h.submit();
  assert.equal(h.latest('/api/knowledge/article-a').options.method, 'PUT');
  assert.deepEqual(JSON.parse(h.latest('/api/knowledge/article-a').options.body), { title: 'Título atualizado', category: 'Categoria', content: 'Texto simples atualizado' });
});

test('Knowledge managed content remains protected without exposing a CMS entry point', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  await h.showArticle(managedArticle);
  assert.equal(h.node('f-content').disabled, true);
  assert.equal(h.node('f-content').required, false);
  assert.equal(h.node('f-content').value, '');
  assert.match(compactText(h.node('f-content-help')), /conteúdo editorial estruturado.*desabilitado/i);
  assert.equal(h.node('article-cms-help'), null);
  assert.equal(h.node('article-cms-link'), null);
  h.input('f-title', ' Novo título '); h.input('f-category', ' Nova categoria '); h.node('f-content').value = 'Never overwrite managed content';
  await h.submit();
  assert.deepEqual(JSON.parse(h.latest('/api/knowledge/article-a').options.body), { title: 'Novo título', category: 'Nova categoria' });
  assert.deepEqual(managedArticle.content_blocks, blocks);
});

test('Knowledge dirty navigation keeps the draft when leaving is declined', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  await h.showArticle(managedArticle);
  h.input('f-title', 'Título não salvo');
  h.context.confirmResult = false;
  assert.equal(await h.router.navigate('/dashboard.html'), false);
  assert.equal(h.location.pathname, '/knowledge.html');
  assert.equal(h.page.active, true);
  assert.equal(h.confirms.length, 1);
  assert.equal(h.node('f-title').value, 'Título não salvo');
  assert.equal(h.requests.some(call => call.options.method === 'PUT'), false);
});

test('Knowledge in-flight save blocks navigation and failed save keeps protected content', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  await h.showArticle(managedArticle);
  h.input('f-title', 'Título editado'); await h.submit();
  const save = h.latest('/api/knowledge/article-a');
  assert.equal(await h.router.navigate('/dashboard.html'), false);
  assert.equal(h.location.pathname, '/knowledge.html');
  assert.equal(h.page.active, true);
  assert.equal(h.confirms.length, 0);
  save.reject(new Error('save failed')); await drain();
  assert.equal(h.node('f-content').disabled, true);
  assert.equal(h.node('f-title').disabled, false);
  assert.equal(h.node('article-cms-link'), null);
  assert.equal(h.node('f-title').value, 'Título editado');
});

test('Knowledge staged PDF cleanup waits for confirmed navigation without exposing an editor link', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  await h.showArticle(managedArticle);
  const upload = await h.uploadPdf();
  upload.resolve({ id: TEMP_PDF, original_name: 'synthetic.pdf' }); await drain();
  h.context.confirmResult = false;
  assert.equal(await h.router.navigate('/dashboard.html'), false);
  assert.equal(h.requests.filter(call => call.options.method === 'DELETE').length, 0);
  assert.equal(h.location.pathname, '/knowledge.html');
  h.context.confirmResult = true;
  const leaving = h.router.navigate('/dashboard.html'); await drain();
  const cleanup = h.latest(`/api/cms/assets/${TEMP_PDF}`);
  assert.equal(cleanup.options.method, 'DELETE');
  cleanup.resolve({ deleted: true });
  assert.equal(await leaving, true);
  assert.equal(h.node('article-cms-link'), null);
});

for (const action of ['keep', 'remove', 'replace']) {
  test(`Knowledge PDF ${action} only alters its own attachment fields, not body/blocks`, async t => {
    const h = await createKnowledgeEditorialHarness(t);
    const article = { ...managedArticle, content_blocks: [...blocks, { type: 'pdf', asset_id: PDF, title: 'PDF original' }] };
    const before = structuredClone(article);
    await h.showArticle(article);
    h.latest(`/api/cms/assets/${PDF}`).resolve('blob:private-pdf'); await drain();
    if (action === 'remove') { h.node('f-pdf-remove').click(); await drain(); }
    if (action === 'replace') { (await h.uploadPdf()).resolve({ id: TEMP_PDF, original_name: 'replacement.pdf' }); await drain(); }
    await h.submit();
    assert.deepEqual(JSON.parse(h.latest('/api/knowledge/article-a').options.body), {
      title: article.title, category: article.category,
      ...(action === 'remove' ? { pdf_asset_id: null } : {}),
      ...(action === 'replace' ? { pdf_asset_id: TEMP_PDF, pdf_title: 'replacement.pdf' } : {}),
    });
    assert.deepEqual(article, before);
    assert.equal(h.requests.some(call => call.path === `/api/cms/assets/${PDF}` && call.options.method === 'DELETE'), false, 'never delete an existing referenced asset from this editor');
  });
}
