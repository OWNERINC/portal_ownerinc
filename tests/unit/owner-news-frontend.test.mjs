import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createFeedbackHarness, TestEvent, drain } from '../helpers/frontend-feedback-harness.mjs';
import { cmsAssetEndpoint } from '../../public/js/owner-news/asset-path.mjs';

const imageID = '11111111-1111-4111-8111-111111111111';
const coverID = '22222222-2222-4222-8222-222222222222';

const news = await readFile('public/js/announcements.js', 'utf8');
const dashboard = await readFile('public/js/dashboard.js', 'utf8');
const syntheticStory = (id, extra = {}) => ({ id, title: `Matéria ${id}`, category: 'Cultura',
  published_at: '2026-09-30T01:00:00Z', content_blocks: [], ...extra });

test('enquete não altera os offsets do catálogo', async t => {
  const h = await createFeedbackHarness('announcements', { mount: false, modules: [
    { path: 'public/js/owner-news/catalog.js', exports: 'composeNewsFeed' },
  ] }); t.after(() => h.page.dispose());
  const articles = Array.from({ length: 5 }, (_, i) => ({ id: String(i) }));
  const poll = h.doc.createElement('article');
  assert.deepEqual(Array.from(h.context.composeNewsFeed(articles, poll)), [...articles.slice(0, 3), poll, ...articles.slice(3)]);
  assert.equal(h.context.composeNewsFeed(articles, poll, { offset: 24 }).length, 5);
  assert.equal(h.context.composeNewsFeed(articles, poll, { category: 'Cultura' }).length, 5);
  assert.equal(h.context.composeNewsFeed(articles.slice(0, 2), poll).at(-1), poll);
  assert.equal(articles.length, 5);
});

test('montagem real filtra artigos, ignora categoria obsoleta e pagina/volta', async t => {
  const h = await createFeedbackHarness('announcements'); t.after(() => h.page.dispose());
  const old = h.requests.find(r => r.kind === 'list');
  assert.equal(old.path, '/api/announcements?kind=article&limit=24&offset=0');
  h.latest('/categories').resolve({ total: 30, categories: [{ name: 'Cultura', count: 30 }] });
  h.latest('/home').resolve(null);
  h.latest('limit=1&offset=0').resolve([syntheticStory('global', { editorial: { summary: 'Resumo global sintético' } })]);
  await drain();
  h.node('news-categories').querySelectorAll('a')[1].click();
  const filtered = h.requests.filter(r => r.kind === 'list').at(-1);
  assert.match(filtered.path, /category=Cultura/);
  filtered.resolve({ data: [syntheticStory('current')], total: 30 }); await drain();
  old.resolve({ data: [syntheticStory('stale')], total: 30 }); await drain();
  assert.ok(h.node('news-card-current')); assert.equal(h.node('news-card-stale'), null);
  assert.match(h.node('news-highlight').textContent, /Resumo global sintético/);
  h.node('announcements-pagination').querySelectorAll('button').at(-1).click();
  assert.equal(new URL(h.page.location.href).searchParams.get('offset'), '24');
  h.requests.filter(r => r.kind === 'list').at(-1).resolve({ data: [syntheticStory('next')], total: 30 }); await drain();
  h.window.history.back(); await drain();
  assert.equal(new URL(h.page.location.href).searchParams.has('offset'), false);
  h.requests.filter(r => r.kind === 'list').at(-1).resolve({ data: [syntheticStory('back')], total: 30 }); await drain();
  assert.ok(h.node('news-card-back')); assert.equal(h.node('news-card-next'), null);
});

test('home independente usa fallback e retry sem apagar feed/categorias', async t => {
  const h = await createFeedbackHarness('announcements'); t.after(() => h.page.dispose());
  h.latest('/categories').resolve({ total: 1, categories: [{ name: 'Cultura', count: 1 }] });
  h.requests.find(r => r.kind === 'list').resolve({ data: [syntheticStory('only')], total: 1 });
  h.latest('limit=1&offset=0').resolve([syntheticStory('global')]);
  h.latest('/home').reject(new Error('offline')); await drain();
  assert.ok(h.node('news-card-only')); assert.match(h.node('news-highlight').textContent, /Matéria global/);
  const before = h.requests.filter(r => r.kind === 'list').length;
  h.node('news-opening-status').querySelector('button').click();
  h.latest('/home').resolve({ content: { version: 1, eyebrow: 'EDIÇÃO', headline: 'Abertura\naprovada', summary: 'Resumo da abertura' } }); await drain();
  assert.match(h.node('news-highlight').textContent, /Abertura\naprovada/);
  assert.equal(h.requests.filter(r => r.kind === 'list').length, before);
  assert.match(h.node('news-categories').textContent, /Cultura.*1/);
});

test('feed vazio, retry e recuperação de offset mantêm loaders independentes', async t => {
  const h = await createFeedbackHarness('announcements', { url: 'https://portal.test/announcements.html?offset=48' });
  t.after(() => h.page.dispose());
  h.latest('/categories').resolve({ total: 0, categories: [] }); await drain();
  h.requests.find(r => r.kind === 'list').reject(new Error('offline')); await drain();
  assert.match(h.node('news-categories').textContent, /Todas/);
  h.node('announcements-list').querySelector('button').click();
  h.requests.filter(r => r.kind === 'list').at(-1).resolve({ data: [], total: 0 }); await drain();
  assert.equal(new URL(h.page.location.href).searchParams.has('offset'), false);
  h.requests.filter(r => r.kind === 'list').at(-1).resolve({ data: [], total: 0 }); await drain();
  assert.match(h.node('announcements-list').textContent, /Nenhuma publicação/);
  assert.equal(h.node('announcements-pagination').children.length, 0);
});

test('capas reais usam apenas mídia da capa e revogam blobs retidos/tardios', async t => {
  const h = await createFeedbackHarness('announcements'); t.after(() => h.page.dispose());
  const image = { type: 'image', asset_id: '11111111-1111-4111-8111-111111111111', alt: 'Capa sintética', usage: 'cover', caption: 'Legenda privada', credit: 'Crédito privado' };
  h.requests.find(r => r.kind === 'list').resolve({ data: [syntheticStory('cover', { content_blocks: [image] }), syntheticStory('brand')], total: 2 }); await drain();
  const card = h.node('news-card-cover');
  assert.equal(card.dataset.variant, '0'); assert.equal(h.node('news-card-brand').dataset.variant, '1');
  assert.equal(card.querySelectorAll('a').length, 1); assert.equal(card.querySelector('figcaption'), null);
  assert.match(h.node('news-card-brand').textContent, /Owner News/);
  const asset = h.requests.find(r => r.kind === 'asset'); asset.resolve('blob:cover'); await drain();
  assert.equal(card.querySelector('img').src, 'blob:cover');
  h.popstate('/announcements.html?category=Outra', {});
  h.requests.filter(r => r.kind === 'list').at(-1).resolve({ data: [syntheticStory('late', { content_blocks: [image] })], total: 1 }); await drain();
  assert.ok(h.revoked.includes('blob:cover'));
  const late = h.requests.filter(r => r.kind === 'asset').at(-1);
  h.page.dispose(); late.resolve('blob:late'); await drain();
  assert.ok(h.revoked.includes('blob:late'));
});
function section(source, start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('categorias codificam nomes, contagens e seleção sem carregar conteúdo', async t => {
  const h = await createFeedbackHarness('announcements', { url: 'https://portal.test/announcements.html?category=Pessoas%20%26%20cultura&offset=24' });
  t.after(() => h.page.dispose());
  h.latest('/categories').resolve({ total: 12, categories: [{ name: 'Pessoas & cultura', count: 8 }] }); await drain();
  const links = h.node('news-categories').querySelectorAll('a');
  assert.equal(links[0].href, './announcements.html');
  assert.equal(links[1].getAttribute('aria-current'), 'page');
  const url = new URL(links[1].href, h.page.location.href);
  assert.equal(url.searchParams.get('category'), 'Pessoas & cultura');
  assert.equal(url.searchParams.has('offset'), false);
  assert.match(links[1].textContent, /8/);
});

test('abertura publicada precede destaque global e respostas antigas são ignoradas', async t => {
  const h = await createFeedbackHarness('announcements'); t.after(() => h.page.dispose());
  const oldHome = h.latest('/home'), oldHighlight = h.latest('limit=1&offset=0');
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  h.latest('/home').resolve({ content: { version: 1, eyebrow: 'EDIÇÃO', headline: 'Abertura atual', summary: 'Resumo aprovado' } });
  h.latest('limit=1&offset=0').resolve([syntheticStory('global')]); await drain();
  oldHome.resolve({ headline: 'Obsoleta' }); oldHighlight.resolve([syntheticStory('old')]); await drain();
  assert.match(h.node('news-highlight').textContent, /Abertura atual/);
  assert.doesNotMatch(h.node('news-highlight').textContent, /Obsoleta|Matéria global/);
});

test('dashboard protected covers revoke stale and retained object URLs', async () => {
  const h = await createFeedbackHarness('dashboard', { mount: false });
  const pending = deferred();
  const revoked = [];
  const paths = [];
  const context = vm.createContext({
    announcementsRequest: 1, newsImageUrls: new Set(), URL: { revokeObjectURL: url => revoked.push(url) },
    fetchAPIAsset: path => { paths.push(path); return pending.promise; }, encodeURIComponent,
    validateNewsBlocks: h.context.validateNewsBlocks, cmsAssetEndpoint,
  });
  vm.runInContext(section(dashboard, 'function releaseNewsImages(', "page.listen(window, 'pagehide'"), context);
  const image = { isConnected: true };
  context.loadNewsImage(image, { content_blocks: [{ type: 'image', asset_id: imageID, alt: 'Fotografia' }] });
  context.announcementsRequest++;
  pending.resolve('blob:stale');
  await pending.promise;
  assert.equal(paths[0], `/api/cms/assets/${imageID}`);
  assert.equal(image.src, './assets/logo-branco.svg');
  assert.deepEqual(revoked, ['blob:stale']);
  context.newsImageUrls.add('blob:current');
  context.releaseNewsImages();
  assert.deepEqual(revoked, ['blob:stale', 'blob:current']);
  assert.equal(context.newsImageUrls.size, 0);
  image.src = 'blob:withdrawn';
  context.loadNewsImage(image);
  assert.equal(image.src, './assets/logo-branco.svg');
  assert.equal(paths.length, 1);
  h.page.dispose();
});

test('dashboard clears a withdrawn hero on an empty refresh and restores it for a new publication', async t => {
  const h = await createFeedbackHarness('dashboard'); t.after(() => h.page.dispose());
  const hero = h.doc.querySelector('.dashboard-hero'), link = h.doc.querySelector('.dashboard-hero-copy a');
  const cover = h.doc.querySelector('.dashboard-hero > img');
  assert.equal(hero.dataset.state, 'loading');
  assert.equal(link.hidden, true);
  assert.match(h.node('dashboard-hero-description').textContent, /Carregando/);
  assert.equal(h.latest('/api/announcements?').path, '/api/announcements?kind=article&limit=3&offset=0');
  const story = { id: 'old', title: 'Old story', editorial: { summary: 'Resumo editorial sintético' }, published_at: '2026-09-29T12:00:00Z', content_blocks: [
    { type: 'image', asset_id: imageID, alt: 'Corpo' },
    { type: 'image', asset_id: coverID, alt: 'Capa', usage: 'cover' },
  ] };
  h.latest('/api/announcements?').resolve([story]); await drain();
  assert.equal(hero.dataset.state, 'populated');
  assert.equal(h.node('dashboard-hero-title').textContent, 'Old story');
  assert.equal(h.node('dashboard-hero-description').textContent, 'Resumo editorial sintético');
  assert.match(h.node('announcements-preview').textContent, /Resumo editorial sintético/);
  assert.equal(link.href, './announcements.html?id=old');
  assert.equal(link.hidden, false); assert.equal(cover.hidden, false);
  assert.equal(h.node('dashboard-news-section').hidden, false);
  const assets = h.requests.filter(item => item.kind === 'asset');
  assert.equal(assets.length, 2);
  assert.ok(assets.every(request => request.path.endsWith(`/${coverID}`)));
  assets[0].resolve('blob:hero'); assets[1].resolve('blob:rail'); await drain();
  assert.equal(cover.src, 'blob:hero');
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  assert.equal(hero.dataset.state, 'loading');
  assert.ok(h.revoked.includes('blob:hero') && h.revoked.includes('blob:rail'));
  h.latest('/api/announcements?').resolve([]); await drain();
  assert.equal(hero.dataset.state, 'empty');
  assert.equal(h.node('dashboard-hero-title').textContent, 'Owner News');
  assert.equal(link.href, '#quick-links'); assert.equal(link.textContent, 'Acessar áreas');
  assert.equal(link.hidden, false); assert.equal(cover.hidden, true);
  assert.equal(cover.src, './assets/logo-branco.svg');
  assert.equal(h.node('dashboard-news-section').hidden, true);
  assert.equal(h.node('announcements-preview').children.length, 0);
  assert.equal(h.doc.querySelectorAll('h1').length, 1);
  assert.equal(h.node('quick-links').querySelectorAll('a').length, 3);
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  h.latest('/api/announcements?').resolve([{ ...story, id: 'new', title: 'New story', content_blocks: [] }]); await drain();
  assert.equal(hero.dataset.state, 'populated');
  assert.equal(h.node('dashboard-hero-title').textContent, 'New story');
  assert.equal(link.href, './announcements.html?id=new');
  assert.equal(cover.hidden, false); assert.equal(h.node('dashboard-news-section').hidden, false);
  assert.equal(h.node('announcements-preview').children.length, 1);
});

test('dashboard initial markup is loading, empty styles are compact and a query error offers a scoped retry', async t => {
  const h = await createFeedbackHarness('dashboard'); t.after(() => h.page.dispose());
  const css = await readFile('public/css/dashboard-home.css', 'utf8');
  assert.match(h.html, /data-state="loading" aria-busy="true"/);
  assert.doesNotMatch(h.html, />Ler publicação</);
  assert.match(css, /\.dashboard-hero:not\(\[data-state="populated"\]\) \{ min-height: 0; \}/);
  assert.match(css, /\.dashboard-hero:not\(\[data-state="populated"\]\) \.dashboard-hero-copy \{\s*width: 100%;\s*min-height: 0;\s*padding: 24px;/);
  h.latest('/api/announcements?').reject(new Error('offline')); await drain();
  const hero = h.doc.querySelector('.dashboard-hero'), retry = h.node('dashboard-hero-retry');
  assert.equal(hero.dataset.state, 'error'); assert.equal(retry.hidden, false);
  assert.match(h.node('dashboard-hero-description').textContent, /Não foi possível/);
  assert.doesNotMatch(h.node('dashboard-hero-description').textContent, /Nenhuma/);
  assert.equal(h.doc.querySelector('.dashboard-hero-copy a').hidden, true);
  retry.click(); const count = h.requests.length; retry.click();
  assert.equal(h.requests.length, count, 'a hidden retry cannot start another loading query');
  assert.equal(hero.dataset.state, 'loading'); assert.equal(retry.hidden, true);
  h.latest('/api/announcements?').resolve([]); await drain();
  assert.equal(hero.dataset.state, 'empty'); assert.equal(hero.getAttribute('aria-busy'), 'false');
});

for (const outcome of ['success', 'failure']) test(`dashboard ignores stale ${outcome} and disposes pending private covers`, async t => {
  const h = await createFeedbackHarness('dashboard'); t.after(() => h.page.dispose());
  const old = h.latest('/api/announcements?');
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  h.latest('/api/announcements?').resolve([{ id: 'new', title: 'Current', content_blocks: [{ type: 'image', asset_id: imageID, alt: 'Capa' }] }]); await drain();
  if (outcome === 'success') old.resolve([]); else old.reject(new Error('old error'));
  await drain(); assert.equal(h.node('dashboard-hero-title').textContent, 'Current');
  const assets = h.requests.filter(item => item.kind === 'asset');
  h.page.dispose(); assets.forEach((item, i) => item.resolve(`blob:late-${i}`)); await drain();
  assert.ok(h.revoked.includes('blob:late-0'));
  assert.notEqual(h.doc.querySelector('.dashboard-hero > img').src, 'blob:late-0');
});

test('reader preserves pagination/category URLs, retry, history and private media cleanup', async () => {
  assert.match(news, /params\.set\('category', category\)/);
  assert.match(news, /history\.pushState/);
  assert.match(await readFile('public/js/owner-news/navigation.js', 'utf8'), /page\.listen\(window, 'popstate'/);
  assert.match(news, /requestToken !== announcementsRequest/);
  assert.match(news, /forEach\(cleanupRenderedBlocks\)/);
  assert.match(news, /requestToken === announcementsRequest\) loadAnnouncements\(\)/);
  assert.match(dashboard, /announcements\.html\?id=\$\{encodeURIComponent\(announcement\.id\)\}/);
});

test('mosaico substitui display grid legado e mantém quebras responsivas', async () => {
  const css = await readFile('public/css/owner-news.css', 'utf8');
  assert.match(css, /\.news-mosaic \{ display: block; columns: 230px;/);
  assert.match(css, /max-width: 560px[^\n]*column-count: 2/);
  assert.match(css, /max-width: 359px[^\n]*column-count: 1/);
  assert.match(css, /\.news-reader\.hidden \{ display: none; \}/);
});

test('refresh com falha conserva cards e categorias; retries antigos ficam inertes', async t => {
  const h = await createFeedbackHarness('announcements'); t.after(() => h.page.dispose());
  h.requests.find(r => r.kind === 'list').resolve({ data: [syntheticStory('kept')], total: 1 });
  h.latest('/categories').resolve({ total: 1, categories: [{ name: 'Cultura', count: 1 }] }); await drain();
  const card = h.node('news-card-kept');
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  assert.equal(h.node('news-card-kept'), card);
  h.requests.filter(r => r.kind === 'list').at(-1).reject(new Error('offline'));
  h.latest('/categories').reject(new Error('offline')); await drain();
  assert.equal(h.node('news-card-kept'), card);
  assert.match(h.node('news-categories').textContent, /Cultura/);
  const oldRetry = h.node('news-feed-status').querySelector('button');
  oldRetry.click();
  const count = h.requests.length;
  oldRetry.click(); assert.equal(h.requests.length, count);
  h.requests.filter(r => r.kind === 'list').at(-1).resolve({ data: [], total: 0 }); await drain();
  oldRetry.click(); assert.equal(h.requests.length, count);
  assert.equal(h.node('news-card-kept'), null);
});

test('links mantêm Ctrl/Cmd nativos e detalhe atual retorna ao filtro', async t => {
  const h = await createFeedbackHarness('announcements', { url: 'https://portal.test/announcements.html?category=Cultura' });
  t.after(() => h.page.dispose());
  h.requests.find(r => r.kind === 'list').resolve({ data: [syntheticStory('detail')], total: 1 }); await drain();
  const link = h.node('news-card-detail').querySelector('a');
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const click = new TestEvent('click', { bubbles: true, button: 0, [modifier]: true });
    link.dispatchEvent(click); assert.equal(click.defaultPrevented, false);
    assert.equal(h.window.history.length, 1);
  }
  link.click();
  assert.equal(new URL(h.page.location.href).searchParams.get('category'), 'Cultura');
  h.requests.find(r => r.path === '/api/announcements/detail').resolve(syntheticStory('detail', { content_blocks: [{ type: 'paragraph', text: 'Corpo sintético do detalhe.' }] })); await drain();
  assert.match(h.node('news-reader-content').textContent, /Corpo sintético/);
  assert.equal(h.node('announcements-pagination').children.length, 0);
  h.node('news-reader-close').click(); await drain();
  assert.equal(new URL(h.page.location.href).searchParams.has('id'), false);
  assert.equal(new URL(h.page.location.href).searchParams.get('category'), 'Cultura');
});

test('sem home ou publicações, abertura usa copy contratada sem reserva vazia', async t => {
  const h = await createFeedbackHarness('announcements'); t.after(() => h.page.dispose());
  h.latest('/home').resolve(null); h.latest('limit=1&offset=0').resolve([]);
  h.requests.find(r => r.kind === 'list').resolve({ data: [], total: 0 }); await drain();
  assert.match(h.node('news-highlight').textContent, /Histórias que\nnos conectam/);
  assert.equal(h.node('news-opening-status').children.length, 0);
  assert.equal(h.node('news-highlight-status').children.length, 0);
});
