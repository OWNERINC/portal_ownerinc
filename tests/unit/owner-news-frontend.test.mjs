import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const news = await readFile('public/js/announcements.js', 'utf8');
const dashboard = await readFile('public/js/dashboard.js', 'utf8');
function section(source, start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
}
function node(tag, attributes = {}, children = []) {
  return { tag, ...attributes, children, append(child) { this.children.push(child); } };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('editorial cards derive the first cover, first text, real ID and reading estimate', () => {
  const renders = [];
  const context = vm.createContext({
    element: node, Intl, encodeURIComponent,
    blocksToText: blocks => blocks.map(block => block.text || '').join(' '),
    renderBlocks: (target, blocks) => renders.push(blocks),
  });
  vm.runInContext(section(news, 'function articleMeta(', 'function clearContent('), context);
  const story = { id: 'real-id', title: 'Uma história', category: 'Cultura', published_at: '2026-09-22T12:00:00Z', content_blocks: [
    { type: 'heading', text: 'Título interno' }, { type: 'paragraph', text: 'Primeiro parágrafo.' },
    { type: 'image', asset_id: 'first', alt: 'Capa' }, { type: 'image', asset_id: 'second', alt: 'Outra' },
  ] };
  const card = context.articleCard(story, true);
  assert.equal(renders[0][0].asset_id, 'first');
  assert.equal(card.children[1].children[1].children[0].href, '?id=real-id');
  assert.equal(card.children[1].children[2].text, 'Primeiro parágrafo.');
  assert.match(card.children[1].children[0].text, /Mais recente.*1 min de leitura/);
  story.content_blocks = [{ type: 'paragraph', text: 'palavra '.repeat(401) }];
  assert.match(context.articleMeta(story), /3 min de leitura/);
  context.articleCard(story);
  assert.equal(renders[1].length, 0);
});

test('highlight always requests newest globally and discards a stale response', async () => {
  const first = deferred();
  const second = deferred();
  const calls = [];
  const highlight = node('section');
  const context = vm.createContext({
    highlight, highlightRequest: 0, setBusy() {}, showState() {},
    clearContent: target => { target.children = []; }, articleCard: story => story,
    fetchAPI: url => { calls.push(url); return calls.length === 1 ? first.promise : second.promise; },
  });
  vm.runInContext(section(news, 'async function loadHighlight(', 'async function loadCategories('), context);
  const a = context.loadHighlight();
  const b = context.loadHighlight();
  second.resolve([{ id: 'newest' }]);
  await b;
  first.resolve([{ id: 'old' }]);
  await a;
  assert.equal(highlight.children[0].id, 'newest');
  assert.deepEqual(calls, ['/api/announcements?limit=1&offset=0', '/api/announcements?limit=1&offset=0']);
});

test('category links encode names, reset pagination and expose the current category', async () => {
  const categories = node('nav');
  categories.contains = () => false;
  const context = vm.createContext({
    categories, categoriesRequest: 0, URLSearchParams, Set, document: {},
    location: { search: '?category=Pessoas%20%26%20cultura&offset=20' },
    fetchAPI: async () => ['Pessoas & cultura', 'Negócios'], element: node,
    clear: target => { target.children = []; }, showState() {},
  });
  vm.runInContext(section(news, 'async function loadCategories(', 'function focusDescriptor('), context);
  await context.loadCategories();
  assert.equal(categories.children[0].href, './announcements.html');
  assert.equal(categories.children[1]['aria-current'], 'page');
  const url = new URL(categories.children[1].href, 'https://portal.test/');
  assert.equal(url.searchParams.get('category'), 'Pessoas & cultura');
  assert.equal(url.searchParams.has('offset'), false);
});

test('dashboard protected covers revoke stale and retained object URLs', async () => {
  const pending = deferred();
  const revoked = [];
  const paths = [];
  const context = vm.createContext({
    announcementsRequest: 1, newsImageUrls: new Set(), URL: { revokeObjectURL: url => revoked.push(url) },
    fetchAPIAsset: path => { paths.push(path); return pending.promise; }, encodeURIComponent,
  });
  vm.runInContext(section(dashboard, 'function releaseNewsImages(', "page.listen(window, 'pagehide'"), context);
  const image = { isConnected: true };
  context.loadNewsImage(image, { content_blocks: [{ type: 'image', asset_id: 'asset-id', alt: 'Fotografia' }] });
  context.announcementsRequest++;
  pending.resolve('blob:stale');
  await pending.promise;
  assert.equal(paths[0], '/api/cms/assets/asset-id');
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
});

test('dashboard clears a withdrawn hero on an empty refresh and restores it for a new publication', async () => {
  const title = {};
  const link = {};
  const results = [[{ id: 'old', title: 'Old story' }], [], [{ id: 'new', title: 'New story' }]];
  const context = vm.createContext({
    announcementsPreview: node('div'), announcementsRequest: 0,
    document: {
      querySelector: selector => selector === '.dashboard-hero-copy a' ? link : null,
      getElementById: id => id === 'dashboard-hero-title' ? title : null,
    },
    fetchAPI: async () => results.shift(),
    setBusy() {}, releaseNewsImages() {}, loadNewsImage() {},
    clear: target => { target.children = []; },
    showState: (target, text) => { target.children = [text]; },
    storyCard: () => ({ querySelector() { return null; } }),
    excerpt: () => '', formatDate: () => '', encodeURIComponent,
  });
  vm.runInContext(section(dashboard, 'function renderHero(', 'const announcementsPreview'), context);
  vm.runInContext(section(dashboard, 'async function loadAnnouncements(', 'const remindersContainer'), context);
  await context.loadAnnouncements();
  assert.equal(title.textContent, 'Old story');
  await context.loadAnnouncements();
  assert.equal(title.textContent, 'Owner News');
  assert.equal(link.href, './announcements.html');
  assert.match(context.announcementsPreview.children[0], /Nenhuma publicação/);
  await context.loadAnnouncements();
  assert.equal(title.textContent, 'New story');
  assert.equal(link.href, './announcements.html?id=new');
});

test('reader filters before pagination, ignores stale pages and preserves category on next page', async () => {
  const requests = [];
  const list = node('div');
  const location = { href: 'https://portal.test/announcements.html?category=Cultura&offset=10' };
  Object.defineProperty(location, 'search', { get() { return new URL(this.href).search; } });
  const context = vm.createContext({
    list, pagination: { replaceChildren() {} }, index: {}, announcementsRequest: 0, PAGE_SIZE: 10,
    location, URL, URLSearchParams, document: { activeElement: {} },
    history: { replaceState(_, __, url) { location.href = String(url); }, pushState(_, __, url) { location.href = String(url); } },
    clearContent: target => { target.children = []; }, clear: target => { target.children = []; },
    setBusy() {}, setPaginationBusy() {}, showState() {}, focusDescriptor() {}, restorePaginationFocus() {},
    articleCard: story => story, readOffset: query => Number(query.get('offset') || 0),
    renderPagination: (_, total, offset, size, callback) => { context.nextPage = callback; },
    fetchAPIPage: url => { const request = { ...deferred(), url }; requests.push(request); return request.promise; },
  });
  vm.runInContext(section(news, 'async function loadAnnouncements(', "page.listen(window, 'popstate'"), context);
  const old = context.loadAnnouncements();
  location.href = 'https://portal.test/announcements.html?category=Pessoas%20%26%20cultura';
  const current = context.loadAnnouncements();
  requests[1].resolve({ data: [{ id: 'current' }], total: 30 });
  await current;
  requests[0].resolve({ data: [{ id: 'stale' }], total: 30 });
  await old;
  assert.equal(list.children[0].id, 'current');
  assert.equal(new URL(requests[1].url, location.href).searchParams.get('category'), 'Pessoas & cultura');
  context.nextPage(10);
  assert.equal(new URL(location.href).searchParams.get('category'), 'Pessoas & cultura');
  assert.equal(new URL(location.href).searchParams.get('offset'), '10');
  requests[2].resolve({ data: [{ id: 'next' }], total: 30 });
  await requests[2].promise;
});

test('reader preserves pagination/category URLs, retry, history and private media cleanup', () => {
  assert.match(news, /category=\$\{encodeURIComponent\(category\)\}/);
  assert.match(news, /history\.pushState/);
  assert.match(news, /page\.listen\(window, 'popstate'/);
  assert.match(news, /requestToken !== announcementsRequest/);
  assert.match(news, /forEach\(cleanupRenderedBlocks\)/);
  assert.match(news, /showState\(list,[^\n]+loadAnnouncements\)/);
  assert.match(dashboard, /announcements\.html\?id=\$\{encodeURIComponent\(announcement\.id\)\}/);
});
