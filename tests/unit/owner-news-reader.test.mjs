import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeedbackHarness, drain, TestEvent } from '../helpers/frontend-feedback-harness.mjs';

const modules = [
  { path: 'public/js/cms-block-renderer.js', exports: 'renderBlocks, cleanupRenderedBlocks, validateBlocks' },
  { path: 'public/js/owner-news/model.js', exports: 'getNewsPresentation, normalizeEditorial, estimateNewsReadTime' },
  { path: 'public/js/owner-news/reader-view.js', exports: 'renderNewsArticle' },
];
const asset = '11111111-1111-4111-8111-111111111111';
const pdf = '22222222-2222-4222-8222-222222222222';
const editorial = { version: 1, kind: 'article', summary: 'Resumo.', author: 'Redação', source_label: '', source_date: null };
async function setup() {
  const h = await createFeedbackHarness('announcements', { mount: false, modules });
  const root = h.doc.createElement('article'); h.doc.body.append(root);
  return { h, root };
}

test('capa é renderizada uma vez e a resposta de mídia tardia é descartada', async () => {
  const h = await createFeedbackHarness('announcements', { mount: false, modules: [
    { path: 'public/js/cms-block-renderer.js', exports: 'renderBlocks, cleanupRenderedBlocks, validateBlocks' },
    { path: 'public/js/owner-news/model.js', exports: 'getNewsPresentation, normalizeEditorial, estimateNewsReadTime' },
    { path: 'public/js/owner-news/reader-view.js', exports: 'renderNewsArticle' },
  ] });
  const root = h.doc.createElement('article'); h.doc.body.append(root);
  const asset = '11111111-1111-4111-8111-111111111111';
  const cleanup = h.context.renderNewsArticle(root, {
    title: 'Matéria sintética', category: 'Cultura', published_at: null,
    editorial: { version: 1, kind: 'article', summary: 'Resumo.', author: 'Redação', source_label: '', source_date: null },
    content_blocks: [
      { type: 'image', asset_id: asset, alt: 'Capa', usage: 'cover' },
      { type: 'paragraph', text: 'Corpo nativo.', typography: 'sans' },
      { type: 'quote', text: 'Uma fala.', attribution: 'Pessoa' },
      { type: 'pdf', asset_id: '22222222-2222-4222-8222-222222222222', title: 'Edição', usage: 'edition' },
    ],
  }, { signal: h.page.signal });
  assert.equal(h.requests.filter(request => request.kind === 'asset').length, 1);
  assert.match(root.textContent, /Resumo\./);
  assert.match(root.textContent, /Corpo nativo\./);
  assert.equal(root.querySelectorAll('blockquote').length, 1);
  assert.equal(root.querySelectorAll('details').length, 1);
  const pending = h.latest(asset);
  cleanup(); pending.resolve('blob:late-news-cover'); await drain();
  assert.equal(root.children.length, 0);
  assert.ok(h.revoked.includes('blob:late-news-cover'));
  h.page.dispose();
});

test('perfil, imagem inline e legenda usam assets privados e são revogados na troca', async () => {
  const { h, root } = await setup();
  const cleanup = h.context.renderNewsArticle(root, { title: 'Pessoas', editorial, content_blocks: [
    { type: 'heading', text: 'Seção', level: 1 },
    { type: 'profile', name: 'Pessoa', role: 'Cargo', text: 'Biografia.', asset_id: asset, alt: 'Retrato', layout: 'left', typography: 'sans' },
    { type: 'image', asset_id: pdf, alt: 'Paisagem', caption: 'Legenda.', credit: 'Crédito.', layout: 'right' },
    { type: 'quote', text: 'Fala.', attribution: 'Pessoa' },
  ] }, { signal: h.page.signal });
  assert.equal(root.querySelectorAll('h1').length, 1);
  assert.equal(root.querySelectorAll('h2').length, 1);
  assert.equal(root.querySelector('.cms-profile-image').getAttribute('alt'), 'Retrato');
  assert.match(root.querySelector('.cms-profile').textContent, /PessoaCargoBiografia\./);
  assert.match(root.querySelector('figcaption').textContent, /Legenda\. · Crédito\./);
  assert.equal(root.querySelector('cite').textContent, 'Pessoa');
  assert.ok(root.querySelector('.news-block--left.news-block--sans'));
  assert.ok(root.querySelector('.news-block--right'));
  assert.equal(h.requests.length, 2);
  for (const [index, request] of h.requests.entries()) {
    assert.match(request.path, /^\/api\/cms\/assets\//);
    request.resolve(`blob:media-${index}`);
  }
  await drain();
  cleanup(); cleanup();
  assert.equal(h.revoked.length, 2);
  assert.ok(h.requests.every(request => request.options.signal.aborted));
  h.context.renderNewsArticle(root, { title: 'Outra', editorial, content_blocks: [] }, { signal: h.page.signal });
  cleanup();
  assert.match(root.textContent, /Outra/);
  h.page.dispose();
  assert.equal(root.children.length, 0);
});

test('datas civis, publicação em São Paulo, autoria e leitura ausente são explícitas', async () => {
  const { h, root } = await setup();
  let cleanup = h.context.renderNewsArticle(root, { title: 'Sem capa', editorial: { ...editorial, author: '', source_date: '2026-05-01', source_label: 'Edição de maio' },
    published_at: '2026-05-01T01:00:00Z', read_time_minutes: null, content_blocks: [] }, { preview: true });
  assert.ok(root.querySelector('.news-article-hero--no-cover'));
  assert.equal(root.querySelectorAll('h1').length, 0);
  assert.equal(root.querySelector('#news-preview-title').tagName, 'H2');
  assert.match(root.textContent, /Por Owner News/);
  assert.match(root.textContent, /Publicado na fonte: 01\/05\/2026/);
  assert.match(root.textContent, /Publicado no Portal: 30\/04\/2026/);
  assert.doesNotMatch(root.textContent, /min de leitura|Invalid Date/);
  cleanup();
  cleanup = h.context.renderNewsArticle(root, { title: 'Edição', editorial: { ...editorial, kind: 'edition' }, published_at: 'inválida', content_blocks: [
    { type: 'pdf', asset_id: pdf, title: 'Documento', usage: 'edition' },
  ] });
  assert.match(root.textContent, /Edição em PDF/);
  assert.doesNotMatch(root.textContent, /min de leitura|Publicado no Portal/);
  cleanup(); h.page.dispose();
});

test('PDF complementar abre uma vez; toggle e resposta tardios não sobrevivem ao cleanup', async () => {
  const { h, root } = await setup();
  const article = { title: 'PDF', editorial, content_blocks: [{ type: 'pdf', asset_id: pdf, title: 'Edição', usage: 'edition' }] };
  let cleanup = h.context.renderNewsArticle(root, article);
  let details = root.querySelector('details');
  assert.equal(h.requests.length, 0);
  cleanup(); details.open = true; details.dispatchEvent(new TestEvent('toggle'));
  assert.equal(h.requests.length, 0);
  cleanup = h.context.renderNewsArticle(root, article);
  details = root.querySelector('details');
  details.open = true; details.dispatchEvent(new TestEvent('toggle'));
  details.open = false; details.dispatchEvent(new TestEvent('toggle'));
  details.open = true; details.dispatchEvent(new TestEvent('toggle'));
  assert.equal(h.requests.length, 1);
  cleanup(); h.latest(pdf).resolve('blob:late-pdf'); await drain();
  assert.ok(h.revoked.includes('blob:late-pdf'));
  assert.equal(root.children.length, 0);
  h.page.dispose();
});

test('legado não duplica capa; marcação é rejeitada nos blocos e nunca interpretada no título', async () => {
  const { h, root } = await setup();
  let cleanup = h.context.renderNewsArticle(root, { title: '<img src=x>', content_blocks: [
    { type: 'image', asset_id: asset, alt: 'Capa legada' }, { type: 'paragraph', text: 'Texto legado.' },
  ] });
  assert.equal(root.querySelectorAll('img').length, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(root.querySelector('h1').textContent, '<img src=x>');
  cleanup();
  for (const block of [
    { type: 'quote', text: '<script>alert(1)</script>' },
    { type: 'profile', name: '<b>Nome</b>', asset_id: asset, alt: 'Retrato' },
    { type: 'image', asset_id: asset, alt: 'Imagem', caption: '<img src=x>' },
    { type: 'paragraph', text: 'Texto', layout: 'full injected', typography: 'sans injected' },
  ]) {
    cleanup = h.context.renderNewsArticle(root, { title: 'Seguro', editorial, content_blocks: [block] });
    assert.equal(root.querySelectorAll('.cms-block').length, 0);
    assert.equal(root.querySelectorAll('script').length, 0);
    assert.equal(root.querySelectorAll('.injected').length, 0);
    cleanup();
  }
  assert.equal(h.requests.length, 1);
  h.page.dispose();
});

test('signal já abortado não monta nem solicita mídia', async () => {
  const { h, root } = await setup();
  h.page.dispose();
  const cleanup = h.context.renderNewsArticle(root, { title: 'Cancelada', editorial, content_blocks: [
    { type: 'image', asset_id: asset, alt: 'Capa', usage: 'cover' },
  ] }, { signal: h.page.signal });
  assert.equal(root.children.length, 0);
  assert.equal(h.requests.length, 0);
  cleanup();
});

test('renderer comum mantém blocos legados e descarte dos novos tipos sem depender do reader', async () => {
  const { h, root } = await setup();
  assert.equal(h.context.renderBlocks(root, [
    { type: 'paragraph', text: 'Texto genérico.' },
    { type: 'image', asset_id: asset, alt: 'Imagem legada' },
    { type: 'image', asset_id: pdf, alt: 'Imagem com legenda', caption: 'Legenda.', credit: 'Crédito.' },
    { type: 'profile', name: 'Pessoa', text: 'Biografia.', asset_id: asset, alt: 'Foto' },
    { type: 'quote', text: 'Fala.', attribution: 'Pessoa' },
  ], { signal: h.page.signal }), true);
  assert.equal(root.querySelectorAll('figure').length, 1);
  assert.equal(root.querySelectorAll('img').length, 3);
  assert.equal(root.querySelectorAll('section').length, 1);
  assert.equal(root.querySelector('blockquote').textContent, 'Fala.Pessoa');
  h.requests[0].resolve('blob:generic-image'); await drain();
  h.page.dispose();
  assert.ok(h.revoked.includes('blob:generic-image'));
  h.requests[1].resolve('blob:late-caption-image');
  h.requests[2].resolve('blob:late-profile'); await drain();
  assert.ok(h.revoked.includes('blob:late-caption-image'));
  assert.ok(h.revoked.includes('blob:late-profile'));
  assert.ok(h.requests.every(request => request.options.signal.aborted));
  assert.match(root.textContent, /Texto genérico\./);
});

test('abort da página descarta mídia pendente, capa adjacente e estimativa local', async () => {
  const { h, root } = await setup();
  h.context.renderNewsArticle(root, { title: 'Amostra', editorial, content_blocks: [
    { type: 'image', asset_id: asset, alt: 'Capa', usage: 'cover', caption: 'Legenda única.', credit: 'Crédito único.' },
    { type: 'paragraph', text: 'palavra '.repeat(201), layout: 'full' },
  ] }, { signal: h.page.signal });
  assert.equal(root.querySelectorAll('img').length, 1);
  assert.equal(root.textContent.split('Legenda única.').length, 2);
  assert.equal(root.querySelector('.news-article-cover-credit').textContent, 'Legenda única. · Crédito único.');
  assert.match(root.textContent, /2 min de leitura/);
  h.page.dispose();
  assert.equal(root.children.length, 0);
  h.latest(asset).resolve('blob:late-page'); await drain();
  assert.ok(h.revoked.includes('blob:late-page'));
  assert.ok(h.latest(asset).options.signal.aborted);
});
