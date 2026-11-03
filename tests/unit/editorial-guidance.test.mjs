import assert from 'node:assert/strict';
import test from 'node:test';
import { createKnowledgeEditorialHarness, editor, drain } from '../helpers/knowledge-editorial-harness.mjs';

const legacyArticle = { id: 'article-a', title: 'Política', category: 'DHO', content: 'Texto legado editável', cms_managed: false };
const managedArticle = { ...legacyArticle, cms_managed: true, content: 'Texto próprio editável' };
const compactText = node => node.textContent.replace(/\s+/g, ' ').trim();

test('Knowledge editor exposes only simple text guidance and no PDF controls', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  await h.showArticle(legacyArticle);
  assert.equal(h.node('modal-article').classList.contains('hidden'), false);
  assert.equal(h.node('f-content').disabled, false);
  assert.equal(h.node('f-content').required, true);
  assert.equal(h.node('f-content').value, legacyArticle.content);
  assert.match(compactText(h.node('f-content-help')), /texto simples.*editável/i);
  assert.match(compactText(h.node('article-editor-help')), /título, categoria e texto simples/i);
  assert.equal(h.node('f-pdf'), null);
  assert.equal(h.node('f-pdf-state'), null);
  assert.equal(h.node('f-pdf-status'), null);
  assert.equal(h.node('f-pdf-remove'), null);
  assert.deepEqual(h.node('f-content').getAttribute('aria-describedby').split(/\s+/), ['f-content-help']);
  for (const [id, help] of [['f-title', 'article-editor-help'], ['f-category', 'article-editor-help'], ['f-content', 'f-content-help']]) {
    assert.ok(h.doc.querySelector(`label[for="${id}"]`), `${id}: native label`);
    assert.ok(h.node(id).getAttribute('aria-describedby').split(/\s+/).includes(help), `${id}: helper association`);
  }
  h.input('f-title', ' Título atualizado '); h.input('f-category', ' Categoria '); h.input('f-content', ' Texto simples atualizado ');
  await h.submit();
  assert.equal(h.latest('/api/knowledge/article-a').options.method, 'PUT');
  assert.deepEqual(JSON.parse(h.latest('/api/knowledge/article-a').options.body), { title: 'Título atualizado', category: 'Categoria', content: 'Texto simples atualizado' });
});

test('Knowledge keeps text editable regardless of legacy editorial markers', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  await h.showArticle(managedArticle);
  assert.equal(h.node('f-content').disabled, false);
  assert.equal(h.node('f-content').required, true);
  assert.equal(h.node('f-content').value, managedArticle.content);
  h.input('f-title', ' Novo título '); h.input('f-category', ' Nova categoria '); h.node('f-content').value = 'Never overwrite managed content';
  await h.submit();
  assert.deepEqual(JSON.parse(h.latest('/api/knowledge/article-a').options.body), { title: 'Novo título', category: 'Nova categoria', content: 'Never overwrite managed content' });
});

test('Knowledge draft navigation keeps unsaved text protected', async t => {
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

test('Knowledge save protects navigation and preserves failed edits', async t => {
  const h = await createKnowledgeEditorialHarness(t);
  await h.showArticle(managedArticle);
  h.input('f-title', 'Título editado'); await h.submit();
  const save = h.latest('/api/knowledge/article-a');
  assert.equal(await h.router.navigate('/dashboard.html'), false);
  assert.equal(h.location.pathname, '/knowledge.html');
  assert.equal(h.page.active, true);
  assert.equal(h.confirms.length, 0);
  save.reject(new Error('save failed')); await drain();
  assert.equal(h.node('f-content').disabled, false);
  assert.equal(h.node('f-title').disabled, false);
  assert.equal(h.node('f-title').value, 'Título editado');
});
