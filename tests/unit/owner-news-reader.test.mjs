import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeedbackHarness, deferred, drain, TestEvent } from '../helpers/frontend-feedback-harness.mjs';

const modules = [
  { path: 'public/js/cms-block-renderer.js', exports: 'renderBlocks, cleanupRenderedBlocks, validateBlocks' },
  { path: 'public/js/owner-news/model.js', exports: 'getNewsPresentation, normalizeEditorial, estimateNewsReadTime' },
  { path: 'public/js/owner-news/reader-view.js', exports: 'renderNewsArticle' },
];
const asset = '11111111-1111-4111-8111-111111111111';
const pdf = '22222222-2222-4222-8222-222222222222';
const editorial = { version: 1, kind: 'article', summary: 'Resumo.', author: 'Redação', source_label: '', source_date: null };
test('anterior/próxima mantém um único retorno ao catálogo', async () => {
  const base = 'https://portal.test/announcements.html?category=Cultura&offset=24';
  const h = await createFeedbackHarness('announcements', { mount: false, url: base, modules: [
    { path: 'public/js/owner-news/navigation.js', exports: 'createNewsNavigation' },
  ] });
  const routes = [];
  const navigation = h.context.createNewsNavigation({
    page: h.page, overlay: h.node('news-reader-overlay'),
    onRoute: async route => { routes.push(route); },
  });
  h.page.history.replaceState({ retained: 'state' }, '', base);
  await navigation.open(asset);
  const length = h.window.history.length;
  await navigation.jump(pdf);
  assert.equal(h.window.history.length, length);
  assert.equal(h.window.history.state.retained, 'state');
  assert.equal(new URL(h.page.location.href).searchParams.get('id'), pdf);
  navigation.close(); navigation.close(); await drain();
  assert.equal(h.page.location.href, base);
  assert.equal(routes.at(-1).id, null);
  assert.ok(h.node('news-reader-overlay').classList.contains('hidden'));
  h.window.history.forward(); await drain();
  assert.equal(new URL(h.page.location.href).searchParams.get('id'), pdf);
  assert.equal(h.node('news-reader-overlay').classList.contains('hidden'), false);
  navigation.dispose(); h.page.dispose();
});

test('retry de imagem e PDF preserva o corpo e revoga respostas tardias', async () => {
  const { h, root } = await setup();
  const cleanup = h.context.renderNewsArticle(root, { title: 'Mídia sintética', editorial, content_blocks: [
    { type: 'paragraph', text: 'Corpo preservado.' },
    { type: 'image', asset_id: asset, alt: 'Imagem' },
    { type: 'pdf', asset_id: pdf, title: 'Edição', usage: 'edition' },
  ] });
  const body = root.querySelector('.cms-block');
  h.latest(asset).reject(new Error('offline')); await drain();
  root.querySelector('.cms-asset-error button').click();
  assert.equal(root.querySelector('.cms-block'), body);
  h.latest(asset).resolve('blob:retried-image'); await drain();
  root.querySelector('img').dispatchEvent(new TestEvent('error'));
  assert.ok(h.revoked.includes('blob:retried-image'), 'decode failure releases its blob before retry');
  const imageRetry = root.querySelector('.cms-asset-error button'); imageRetry.click();
  const lateImage = h.latest(asset);
  const details = root.querySelector('details'); details.open = true; details.dispatchEvent(new TestEvent('toggle'));
  h.latest(pdf).reject(new Error('offline')); await drain();
  root.querySelector('.cms-pdf-block button').click();
  const pending = h.latest(pdf);
  cleanup();
  const requests = h.requests.length; imageRetry.click();
  assert.equal(h.requests.length, requests, 'retry is inert after disposal');
  pending.resolve('blob:retried-late-pdf'); lateImage.resolve('blob:retried-late-image'); await drain();
  assert.ok(h.revoked.includes('blob:retried-image'));
  assert.ok(h.revoked.includes('blob:retried-late-pdf'));
  assert.ok(h.revoked.includes('blob:retried-late-image'));
  h.page.dispose();
});

for (const firstReady of [false, true]) test(`leitor montado preserva catálogo e descarta detalhe/mídia tardios (primeiro pronto: ${firstReady})`, async () => {
  const base = 'https://portal.test/announcements.html?category=Cultura&offset=24';
  const h = await createFeedbackHarness('announcements', { url: base });
  const story = (id, title, content_blocks = []) => ({ id, title, editorial, content_blocks, category: 'Cultura' });
  h.requests.find(r => r.kind === 'list').resolve({ data: [story(asset, 'Primeira')], total: 25 });
  h.latest('/home').resolve(null); h.latest('limit=1&offset=0').resolve([]);
  h.latest('/categories').resolve({ total: 25, categories: [{ name: 'Cultura', count: 25 }] }); await drain();
  const card = h.node(`news-card-${asset}`), link = card.querySelector('a');
  h.window.scrollY = 720; link.focus(); link.click();
  assert.equal(h.node('news-reader-dialog').getAttribute('aria-label'), 'Leitura da Owner News');
  assert.equal(h.doc.activeElement, h.node('news-reader-close'));
  const first = h.requests.find(r => r.path === `/api/announcements/${asset}`);
  const firstArticle = story(asset, 'Primeira', [{ type: 'image', asset_id: asset, alt: 'Capa', usage: 'cover' }]);
  if (firstReady) { first.resolve(firstArticle); await drain(); }
  h.latest('/navigation').resolve({ previous: null, next: { id: pdf, title: 'Segunda' } }); await drain();
  const oldMedia = h.requests.find(r => r.kind === 'asset');
  const next = h.node('news-reader-next'); next.focus(); next.click();
  if (!firstReady) assert.equal(first.options.signal.aborted, true);
  if (oldMedia) assert.equal(oldMedia.options.signal.aborted, true);
  const second = h.requests.find(r => r.path === `/api/announcements/${pdf}`);
  second.resolve(story(pdf, 'Segunda', [{ type: 'paragraph', text: 'Corpo da segunda.' }])); await drain();
  const title = h.node('news-reader-title');
  assert.equal(title.textContent, 'Segunda');
  assert.equal(title.tagName, 'H1');
  assert.equal(h.doc.activeElement, next, 'async article never steals control focus');
  h.latest('/navigation').reject(new Error('offline')); await drain();
  assert.match(h.node('news-reader-content').textContent, /Corpo da segunda/);
  h.node('news-reader-navigation-status').querySelector('button').click();
  h.latest('/navigation').resolve({ previous: { id: asset }, next: null }); await drain();
  assert.equal(h.node('news-reader-title'), title, 'navigation retry preserves composition');
  if (!firstReady) first.resolve(firstArticle);
  else oldMedia.resolve('blob:late-first-cover');
  await drain();
  if (firstReady) assert.ok(h.revoked.includes('blob:late-first-cover'));
  assert.equal(h.node('news-reader-title'), title);
  h.doc.dispatchEvent(new TestEvent('keydown', { key: 'Escape' }));
  h.node('news-reader-close').click(); await drain();
  assert.equal(h.page.location.href, base);
  assert.equal(h.node(`news-card-${asset}`), card);
  assert.equal(h.requests.filter(r => r.kind === 'list').length, 1);
  assert.equal(h.doc.activeElement, link);
  assert.equal(h.window.scrollY, 720);
  assert.equal(h.node('news-reader-content').children.length, 0);
  h.window.history.forward(); await drain();
  assert.equal(new URL(h.page.location.href).searchParams.get('id'), pdf);
  assert.equal(h.node('news-reader-overlay').classList.contains('hidden'), false);
  h.page.dispose();
  assert.equal(h.requests.filter(r => r.path === `/api/announcements/${pdf}`).at(-1).options.signal.aborted, true);
  assert.equal(h.latest('/navigation').options.signal.aborted, true);
});

test('URL direta mantém Voltar durante loader/404, retry de detalhe e fallback de foco', async () => {
  const h = await createFeedbackHarness('announcements', { url: `https://portal.test/announcements.html?id=${asset}` });
  h.requests.find(r => r.kind === 'list').resolve({ data: [], total: 0 });
  h.latest('/home').resolve(null); h.latest('limit=1&offset=0').resolve([]); h.latest('/categories').resolve({ total: 0, categories: [] });
  h.requests.find(r => r.path === `/api/announcements/${asset}`).reject(new Error('offline'));
  h.latest('/navigation').resolve({ previous: null, next: null }); await drain();
  h.node('news-reader-content').querySelector('button').click();
  h.requests.filter(r => r.path === `/api/announcements/${asset}`).at(-1).reject(Object.assign(new Error('gone'), { status: 404 }));
  h.latest('/navigation').resolve({ previous: null, next: null }); await drain();
  assert.match(h.node('news-reader-content').textContent, /Esta matéria não está mais disponível/);
  assert.equal(h.node('news-reader-content').querySelector('button'), null);
  assert.equal(h.node('news-reader-dialog').getAttribute('aria-labelledby'), null);
  h.node('news-reader-close').click(); await drain();
  assert.equal(h.window.history.length, 1);
  assert.equal(h.page.location.search, '');
  assert.equal(h.doc.activeElement, h.node('news-catalog-title'));
  h.page.dispose();
});

for (const interacted of [false, true]) test(`retorno aguarda catálogo e respeita interação posterior (${interacted})`, async () => {
  const h = await createFeedbackHarness('announcements', { mount: false, modules: [
    { path: 'public/js/owner-news/navigation.js', exports: 'createNewsNavigation' },
  ] });
  const pending = deferred();
  const navigation = h.context.createNewsNavigation({ page: h.page, overlay: h.node('news-reader-overlay'),
    onRoute: route => route.id ? Promise.resolve() : pending.promise });
  h.window.scrollY = 500;
  await navigation.open(asset);
  navigation.close(); await drain();
  assert.notEqual(h.doc.activeElement, h.node('news-catalog-title'), 'catalog loading must settle first');
  if (interacted) { h.window.dispatchEvent(new TestEvent('wheel')); h.window.scrollY = 100; }
  pending.resolve(); await drain();
  if (interacted) {
    assert.notEqual(h.doc.activeElement, h.node('news-catalog-title'));
    assert.equal(h.window.scrollY, 100);
  } else {
    assert.equal(h.doc.activeElement, h.node('news-catalog-title'), 'missing/withdrawn card uses the catalog heading');
    assert.equal(h.window.scrollY, 500);
  }
  h.page.dispose();
});
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
