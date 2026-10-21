import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRouterHarness, deferred, drain, Node, TestEvent } from '../helpers/router-harness.mjs';
import { ASSET_ID, pageFixture } from '../helpers/portal-contents-fixtures.mjs';

test('editorial external and shell entry links respect cancelled global leave guards before navigation', async () => {
  for (const href of ['/editorial/', '/editorial/admin', '/editorial-entry.html']) {
    const h = await createRouterHarness();
    h.scope.beforeLeave(() => false);
    const old = h.scope, link = new Node('a', h.doc, { href }); h.doc.body.append(link);
    const event = new TestEvent('click', { target: link, button: 0 }); h.doc.dispatchEvent(event); await drain();
    assert.equal(event.defaultPrevented, true); assert.equal(h.scope, old); assert.equal(old.active, true);
    assert.equal(h.location.pathname, '/dashboard.html');
  }
});

test('Owner News reconciles the real router forced close before async Back/Forward and double close', async () => {
  const h = await createRouterHarness({ realUI: true });
  await h.router.navigate('/announcements.html?category=Cultura&offset=24');
  const source = (await readFile('public/js/owner-news/navigation.js', 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(`${source}\nglobalThis.createNewsNavigation = createNewsNavigation;`, h.context);
  const overlay = new Node('div', h.doc, { id: 'news-reader-overlay', class: 'hidden', 'data-page-overlay': '' });
  overlay.append(new Node('button', h.doc, { id: 'news-reader-close' })); h.doc.body.append(overlay);
  const catalog = h.doc.getElementById('main-content');
  const card = new Node('article', h.doc, { id: 'news-card-first' });
  const link = new Node('a', h.doc, { href: './announcements.html?id=first' }); card.append(link); catalog.append(card);
  link.focus(); h.window.scrollY = 640;
  h.scope.history.replaceState({ retained: 'yes' }, '', h.location.href);
  const routes = [];
  const catalogReady = deferred();
  const navigation = h.context.createNewsNavigation({ page: h.scope, overlay, onRoute: async route => {
    routes.push(route);
    await Promise.allSettled([route.id ? Promise.resolve() : catalogReady.promise, Promise.resolve()]);
  } });
  await navigation.open('first'); await navigation.jump('second');
  assert.equal(h.entries.length, 3);
  assert.equal(h.history.state.retained, 'yes');
  navigation.close(); navigation.close();
  assert.match(h.location.search, /id=second/, 'native traversal is asynchronous');
  await drain();
  assert.equal(h.location.search, '?category=Cultura&offset=24');
  assert.equal(h.doc.activeElement, catalog, 'router restores main for an ID-less origin while local onRoute is pending');
  catalogReady.resolve(); await drain();
  assert.equal(h.doc.activeElement, link);
  assert.equal(h.window.scrollY, 640);
  assert.equal(h.doc.getElementById('main-content'), catalog);
  assert.ok(overlay.classList.contains('hidden'));
  h.history.forward(); await drain();
  assert.equal(overlay.classList.contains('hidden'), false);
  assert.equal(routes.at(-1).id, 'second');
  assert.equal(h.doc.body.classList.contains('modal-open'), true);
  // Same-ID traversal still forces close in the router; sync must reopen it.
  h.scope.history.pushState({ ...h.history.state }, '', h.location.href + '&extra=1');
  h.history.back(); await drain();
  assert.equal(overlay.classList.contains('hidden'), false);
  assert.equal(h.doc.activeElement.id, 'news-reader-close');
  await h.router.navigate('/dashboard.html');
  assert.equal(overlay.isConnected, false);
  assert.equal(h.doc.body.classList.contains('modal-open'), false);
});

for (const action of ['missing-card', 'pointerdown', 'keydown']) test(`Owner News async return handles ${action} after router focus restoration`, async () => {
  const h = await createRouterHarness({ realUI: true });
  await h.router.navigate('/announcements.html?category=Cultura&offset=24');
  const source = (await readFile('public/js/owner-news/navigation.js', 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(`${source}\nglobalThis.createNewsNavigation = createNewsNavigation;`, h.context);
  const overlay = new Node('div', h.doc, { id: 'news-reader-overlay', class: 'hidden', 'data-page-overlay': '' });
  overlay.append(new Node('button', h.doc, { id: 'news-reader-close' })); h.doc.body.append(overlay);
  const catalog = h.doc.getElementById('main-content');
  const heading = new Node('h2', h.doc, { id: 'news-catalog-title', tabindex: '-1' });
  const card = new Node('article', h.doc, { id: 'news-card-first' });
  const link = new Node('a', h.doc, { href: './announcements.html?id=first' }); card.append(link);
  const other = new Node('button', h.doc, { id: 'another-control' }); catalog.append(heading, card, other);
  link.focus(); h.window.scrollY = 640;
  const ready = deferred();
  const navigation = h.context.createNewsNavigation({ page: h.scope, overlay, onRoute: async route => {
    await Promise.allSettled([route.id ? Promise.resolve() : ready.promise, Promise.resolve()]);
  } });
  await navigation.open('first');
  if (action === 'missing-card') card.remove();
  navigation.close(); await drain();
  assert.equal(h.doc.activeElement, catalog);
  if (action !== 'missing-card') {
    h.window.dispatchEvent(new TestEvent(action, { target: other, key: 'Tab' }));
    other.focus(); h.window.scrollY = 120;
  }
  ready.resolve(); await drain();
  assert.equal(h.doc.activeElement, action === 'missing-card' ? heading : other);
  assert.equal(h.window.scrollY, action === 'missing-card' ? 640 : 120);
  h.scope.dispose();
});

test('all shell destinations mount repeatedly with one document, sidebar, topbar, main and cached modules', async () => {
  const h = await createRouterHarness();
  const nodes = ['.sidebar', '.topbar', '.main-content', '#main-content'].map(selector => h.doc.querySelector(selector));
  const menuButton = nodes[1].querySelector('.mobile-menu-toggle');
  for (const path of [...Object.keys(h.router.routes), '/dashboard.html', '/admin.html', '/dashboard.html']) {
    assert.equal(await h.router.navigate(path), true, path);
    nodes.forEach((node, i) => assert.equal(h.doc.querySelector(['.sidebar', '.topbar', '.main-content', '#main-content'][i]), node));
    assert.equal(h.doc.querySelector('.mobile-menu-toggle'), menuButton);
    h.events.length = 0;
    h.window.dispatchEvent(new TestEvent('test-page-event'));
    assert.equal(h.events.length, 1, 'departed page listeners must be removed');
  }
  assert.equal(h.modules.size, Object.keys(h.router.routes).length);
  assert.equal(h.disposed.length, h.mounts.length - 1);
});

test('contents is admitted by the active-user router without using availability as route authorization', async () => {
  const h = await createRouterHarness();
  const featureCSS = 'https://portal.test/css/portal-contents.css';
  h.page('/contents.html', { styles: [featureCSS] });
  const main = h.doc.getElementById('main-content');
  assert.equal(h.router.routes['/contents.html'], './portal-contents/index.js');
  assert.equal(h.router.routeAllowed('/contents.html', h.context.user), true);
  assert.equal(await h.router.navigate('/contents.html?slug=published-policy'), true);
  assert.equal(h.location.pathname, '/contents.html');
  assert.equal(h.location.search, '?slug=published-policy');
  assert.equal(h.doc.getElementById('main-content'), main, 'the persistent shell keeps its original main element');
  assert.equal(h.scope.active, true);
  assert.equal(h.requests.filter(request => String(request.url).includes('/api/contents/availability')).length, 0);
  const activeStylesheet = h.doc.querySelectorAll('link[rel="stylesheet"]').find(link => link.href === featureCSS);
  assert.equal(activeStylesheet?.media, 'all');
  await h.router.navigate('/knowledge.html');
  assert.equal(activeStylesheet.media, 'not all', 'the page-local reader stylesheet is disabled outside its route');
});

test('real Contents module crosses the persistent shell and a BFCache restore remounts only after live auth', { timeout: 10_000 }, async () => {
  const viewer = { uid: 'user-1', role: 'viewer', permissions: {}, autocard_access: false, pos_cards_access: false };
  const secondViewer = { uid: 'user-2', role: 'viewer', permissions: {}, autocard_access: false, pos_cards_access: false };
  const h = await createRouterHarness({ initialURL: 'https://portal.test/contents.html?slug=published-policy', user: viewer, autoStart: false });
  h.page('/contents.html');
  let validations = 0;
  let availabilityReads = 0;
  let mediaIssues = 0;
  let activeViewer = viewer;
  h.context.fetchOverride = async (url, options = {}) => {
    const pathname = new URL(url, h.location.href).pathname;
    if (pathname === '/api/users/me') { validations += 1; return Response.json(activeViewer); }
    if (pathname === '/api/contents/availability') { availabilityReads += 1; return Response.json({ available: true }); }
    if (pathname === '/api/contents/media-session' && options.method === 'POST') {
      mediaIssues += 1;
      return new Response(null, { status: 204 });
    }
    if (pathname === '/api/contents/media-session' && options.method === 'DELETE') return new Response(null, { status: 204 });
    if (pathname === '/api/contents/categories') return Response.json([]);
    if (pathname === '/api/contents/published-policy') return Response.json(pageFixture({
      slug: 'published-policy', title: 'Política publicada',
      content_blocks: [
        { type: 'image', asset_id: ASSET_ID, alt: 'Imagem de política' },
        { type: 'gallery', images: [
          { asset_id: ASSET_ID, alt: 'Imagem da galeria' },
          { asset_id: ASSET_ID, alt: 'Segunda imagem da galeria' },
        ] },
        { type: 'video', asset_id: ASSET_ID, title: 'Vídeo de política' },
      ],
    }));
    if (pathname.endsWith('.html')) return { ok: true, headers: new Map([['content-type', 'text/html']]), text: async () => pathname };
    throw new Error(`unexpected ${pathname}`);
  };

  await h.loadRealAuthHooks();
  const feature = await h.loadContentsModule({ realModules: true });
  await h.router.startRouter();
  await h.scope.ready();
  await drain();

  const shell = ['.sidebar', '.topbar', '.main-content', '#main-content'].map(selector => h.doc.querySelector(selector));
  const hiddenLink = h.doc.querySelector('.contents-link');
  assert.ok(hiddenLink);
  hiddenLink.hidden = true;
  assert.equal(hiddenLink.hidden, true, 'availability visibility can hide the nav while route access remains independent');
  assert.equal(h.router.routeAllowed('/contents.html', viewer), true, 'navigation visibility is not route authorization');
  assert.equal(h.doc.querySelector('#contents-view h1')?.textContent, 'Política publicada',
    JSON.stringify({ main: h.doc.getElementById('main-content')?.textContent,
      requests: h.requests.map(row => ({ url: row.url, status: row.options?.method })) }));
  assert.ok(feature.modules.index, 'the real Contents module is in the router module graph');

  const firstThumbnail = h.doc.querySelector('.contents-gallery-thumbnail');
  const firstVideo = h.doc.querySelector('.contents-native-video');
  assert.ok(firstThumbnail?.getAttribute('src'), 'the real gallery prepares native image URLs');
  assert.ok(firstVideo?.getAttribute('src'), 'the real media module prepares a native video URL');
  firstVideo.paused = false;
  firstVideo.dispatchEvent(new TestEvent('play'));
  h.doc.body.style.setProperty('overflow', 'clip');
  h.doc.body.style.setProperty('padding-inline-end', '3px');
  h.doc.documentElement.style.setProperty('overflow', 'auto');
  h.doc.querySelector('.contents-gallery-trigger').click();
  await drain();
  const firstDialog = h.doc.querySelector('dialog[data-page-overlay]');
  assert.equal(firstDialog?.open, true);
  assert.equal(h.doc.body.style.getPropertyValue('overflow'), 'hidden', 'the active gallery owns its scroll lock');

  let lastContentsVideo = firstVideo;
  for (let iteration = 0; iteration < 10; iteration += 1) {
    for (const path of ['/announcements.html', '/academy.html', '/contents.html?slug=published-policy']) {
      assert.equal(await h.router.navigate(path), true, path);
      await h.scope.ready();
      await drain();
      shell.forEach((node, index) => assert.equal(
        h.doc.querySelector(['.sidebar', '.topbar', '.main-content', '#main-content'][index]), node,
      ));
      const contentsMounted = path.startsWith('/contents.html');
      assert.equal(h.window.listeners.get('popstate').length, contentsMounted ? 2 : 1,
        `${path} owns exactly its route-scoped popstate listener`);
      assert.equal(h.doc.querySelectorAll('[data-page-overlay]').length, contentsMounted ? 1 : 0,
        `${path} owns no overlays from another route`);
      if (contentsMounted) {
        lastContentsVideo = h.doc.querySelector('.contents-native-video');
        assert.ok(lastContentsVideo?.getAttribute('src'), 'each Contents mount prepares its native video');
      } else if (lastContentsVideo) {
        assert.equal(lastContentsVideo.paused, true, 'every Contents exit pauses native playback');
        assert.equal(lastContentsVideo.getAttribute('src'), null, 'every Contents exit clears the private source');
        assert.equal(lastContentsVideo.listeners.get('play')?.length, 0, 'every Contents exit removes media listeners');
        lastContentsVideo = null;
      }
      if (iteration === 0 && path === '/announcements.html') {
        assert.equal(firstDialog.open, false, 'leaving Contents closes the gallery before removing its page');
        assert.equal(firstDialog.isConnected, false, 'the owned overlay does not survive route disposal');
        assert.equal(h.doc.body.style.getPropertyValue('overflow'), 'clip', 'the pre-existing body scroll style is restored');
        assert.equal(h.doc.body.style.getPropertyValue('padding-inline-end'), '3px');
        assert.equal(h.doc.documentElement.style.getPropertyValue('overflow'), 'auto');
        assert.equal(firstVideo.paused, true, 'leaving Contents pauses native playback');
        assert.ok(firstVideo.pauseCount > 0);
        assert.equal(firstVideo.getAttribute('src'), null, 'leaving Contents clears the private native source');
        assert.equal(firstVideo.listeners.get('play')?.length, 0, 'playback listeners are removed with the page');
        assert.equal(firstThumbnail.listeners.get('load')?.length, 0, 'gallery listeners are removed with the page');
        assert.equal(firstThumbnail.listeners.get('error')?.length, 0);
        assert.equal(h.window.listeners.get('popstate').length, 1, 'only the persistent router listener remains outside Contents');
      }
    }
  }
  assert.equal(mediaIssues, 11, 'each new Contents mount prepares a new lease');

  const priorScope = h.scope;
  const validationsBeforeRestore = validations;
  const issuesBeforeRestore = mediaIssues;
  const availabilityBeforeRestore = availabilityReads;
  h.window.dispatchEvent(new TestEvent('pagehide'));
  assert.equal(priorScope.active, false);
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  await drain();
  await h.scope.ready();
  await drain();
  assert.notEqual(h.scope, priorScope, 'the router listener remounts instead of reusing cached DOM');
  assert.ok(validations > validationsBeforeRestore, 'restoration performs fresh /users/me validation');
  assert.ok(availabilityReads > availabilityBeforeRestore, 'a restored document rechecks availability, not just identity');
  assert.ok(mediaIssues > issuesBeforeRestore, 'restoration obtains a fresh media issuance');
  assert.equal(h.window.listeners.get('pageshow').length, 1, 'no feature-specific BFCache boot listener is installed');
  assert.equal(h.doc.querySelectorAll('[data-page-overlay]').length, 1, 'only the current Contents mount owns an overlay');
  assert.equal(h.doc.querySelector('dialog[data-page-overlay]').open, false, 'the current gallery dialog is closed');

  const oldHeading = h.doc.querySelector('#contents-view h1');
  activeViewer = secondViewer;
  h.context.setAuthUser({ uid: secondViewer.uid });
  h.context.notifyMutationObservers();
  assert.equal(oldHeading.isConnected, false, 'an identity change cannot retain the prior account DOM');
  assert.equal(h.scope.active, false, 'identity invalidation disposes the previous route lifecycle');
  assert.equal(h.doc.querySelectorAll('[data-page-overlay]').length, 0, 'identity invalidation removes the current overlay too');
  assert.equal(h.window.listeners.get('popstate').length, 1, 'identity invalidation releases the Contents listener');
  h.scope.dispose();
});

test('signed-out direct links keep the destination query and fragment through login', async () => {
  const destination = '/knowledge.html?q=normas&article=one#pdf';
  const h = await createRouterHarness({ initialURL: `https://portal.test${destination}`, user: null });
  const redirect = new URL(h.location.redirect, h.location.href);
  assert.equal(redirect.pathname, '/login.html');
  assert.equal(redirect.searchParams.get('next'), destination);
  assert.equal(h.mounts.length, 0);
});

test('late loaders reject promptly, timers stop, and stale private assets are revoked on dispose', async () => {
  const h = await createRouterHarness();
  const pending = deferred(), asset = deferred();
  const revoked = [];
  h.context.URL = class extends URL { static revokeObjectURL(url) { revoked.push(url); } };
  const api = h.scope.bindAPI({ fetchAPI: () => pending.promise, fetchAPIAsset: () => asset.promise });
  const load = api.fetchAPI('/api/read');
  const image = api.fetchAPIAsset('/api/asset');
  const rejected = Promise.all([assert.rejects(load, { name: 'AbortError' }), assert.rejects(image, { name: 'AbortError' })]);
  let fired = false;
  h.scope.timeout(() => { fired = true; }, 15);
  await h.router.navigate('/academy.html');
  await rejected;
  asset.resolve('blob:late'); pending.resolve({ stale: true });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(revoked, ['blob:late']);
  assert.equal(fired, false);
});

test('pending mutations block clicks, logout and Back, and duplicate writes never reach the API', async () => {
  const h = await createRouterHarness();
  await h.router.navigate('/profile.html');
  const saving = deferred(); let writes = 0;
  const { fetchAPI } = h.scope.bindAPI({ fetchAPI: () => { writes++; return saving.promise; } });
  const request = fetchAPI('/api/users/me', { method: 'PUT' });
  await assert.rejects(fetchAPI('/api/users/me', { method: 'PUT' }), /andamento/);
  assert.equal(writes, 1);
  assert.equal(await h.router.navigate('/academy.html'), false);
  await h.router.requestLogout(); assert.equal(h.context.loggedOut, undefined);
  h.history.go(-1); await drain();
  assert.equal(h.location.pathname, '/profile.html');
  assert.equal(h.entries.length, 2, 'rejecting Back must not add a duplicate entry');
  saving.resolve({}); await request;
  h.history.go(-1); await drain();
  assert.equal(h.location.pathname, '/dashboard.html');
});

test('history preserves page-local query/filter state, scroll, and focus across routes', async () => {
  const h = await createRouterHarness();
  await h.router.navigate('/knowledge.html?q=normas&category=DHO');
  const focus = h.doc.getElementById('heading-/knowledge.html'); focus.focus();
  h.scope.history.pushState({ article: true }, '', '/knowledge.html?q=normas&category=DHO&article=one');
  h.window.scrollY = 540;
  await h.router.navigate('/academy.html?category=Cursos');
  h.history.go(-1); await drain();
  assert.equal(h.location.search, '?q=normas&category=DHO&article=one');
  assert.equal(h.window.scrollY, 540);
  assert.equal(h.doc.activeElement.id, focus.id);
  const mounted = h.mounts.length;
  h.history.go(-1); await drain();
  assert.equal(h.location.search, '?q=normas&category=DHO');
  assert.equal(h.mounts.length, mounted, 'same-page queries are handled by the mounted page');
  h.history.go(2); await drain();
  assert.equal(h.location.pathname, '/academy.html');
});

test('same-page Owner News links keep their existing scroll and focus behavior without Contents opt-in', async () => {
  const h = await createRouterHarness();
  await h.router.navigate('/announcements.html?category=Cultura');
  await drain(); await h.scope.ready();
  const heading = h.doc.getElementById('heading-/announcements.html');
  heading.focus();
  h.window.scrollY = 275;
  const event = h.click('/announcements.html?category=News');
  await drain();
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.location.search, '?category=News');
  assert.equal(h.window.scrollY, 275, 'the new Contents restoration hook does not scroll other pages');
  assert.equal(h.doc.activeElement.id, heading.id, 'the new hook does not replace Owner News focus behavior');
});

test('Academy catalog return metadata coexists with the real router history index across areas', async () => {
  const h = await createRouterHarness();
  const catalog = 'https://portal.test/academy.html?initial_offset=20&role_category=Vendas';
  await h.router.navigate(catalog);
  const scope = h.scope;
  scope.history.pushState({ ...h.history.state, academyCatalog: catalog }, '', '/academy.html?course=one');
  scope.history.pushState({ ...h.history.state }, '', '/academy.html?course=one&lesson=first');
  await h.router.navigate('/knowledge.html');
  h.history.go(-1); await drain();
  assert.equal(h.location.search, '?course=one&lesson=first');
  assert.equal(h.history.state.academyCatalog, catalog);
  const mounts = h.mounts.length;
  h.history.go(-1); await drain();
  assert.equal(h.location.search, '?course=one');
  assert.equal(h.history.state.academyCatalog, catalog);
  assert.equal(h.mounts.length, mounts, 'local history keeps the mounted shell');
});

test('cancelled dirty dialogs retain the page and history entry; confirmation is checked after preparation', async () => {
  const h = await createRouterHarness();
  await h.router.navigate('/cms.html');
  h.context.uiLeaveAllowed = false;
  const oldMain = h.doc.getElementById('main-content').children[0];
  assert.equal(await h.router.navigate('/dashboard.html'), false);
  h.history.go(-1); await drain();
  assert.equal(h.location.pathname, '/cms.html');
  assert.equal(h.doc.getElementById('main-content').children[0], oldMain);
  assert.equal(h.entries.length, 2);
  h.context.uiLeaveAllowed = true;
  h.history.go(-1); await drain();
  assert.equal(h.location.pathname, '/dashboard.html');
});

test('loaders retain their query scope while a cross-page Back is being corrected', async () => {
  const h = await createRouterHarness();
  await h.router.navigate('/knowledge.html?q=retained');
  const page = h.scope;
  h.history.go(-1);
  await Promise.resolve();
  assert.equal(h.location.pathname, '/dashboard.html', 'native history moves before the router can accept it');
  assert.equal(page.location.pathname, '/knowledge.html');
  assert.equal(page.location.search, '?q=retained');
  page.history.replaceState({}, '', '/knowledge.html?q=late');
  assert.equal(h.location.pathname, '/dashboard.html', 'a pending old loader cannot overwrite the target entry');
  await drain();
  assert.equal(h.location.pathname, '/dashboard.html');
});

test('superseded navigation and transient authentication failure keep the previous page until ready', async () => {
  const h = await createRouterHarness();
  const slow = deferred();
  const oldContent = h.doc.getElementById('main-content').children[0];
  h.context.fetchOverride = url => new URL(url).pathname === '/academy.html' ? slow.promise
    : Promise.resolve({ ok: true, headers: new Map([['content-type', 'text/html']]), text: async () => new URL(url).pathname });
  const first = h.router.navigate('/academy.html');
  assert.equal(h.doc.getElementById('main-content').children[0], oldContent);
  await h.router.navigate('/knowledge.html');
  slow.resolve({ ok: true, headers: new Map([['content-type', 'text/html']]), text: async () => '/academy.html' });
  assert.equal(await first, false);
  assert.equal(h.location.pathname, '/knowledge.html');
  h.context.getCurrentUserDoc = async () => { throw new Error('offline'); };
  const current = h.scope;
  assert.equal(await h.router.navigate('/admin.html'), false);
  assert.equal(current.active, true);
  assert.equal(h.location.pathname, '/knowledge.html');
  assert.ok(h.doc.querySelector('.portal-navigation-error').querySelector('button'));
});

test('route preparation announces loading and failures preserve the old page until the exact retry succeeds', async () => {
  const h = await createRouterHarness();
  const main = h.doc.getElementById('main-content');
  const draft = new Node('input', h.doc, { id: 'unsaved-route-draft', value: 'keep this draft' });
  main.append(draft);
  const previous = h.scope;
  let unavailable = true;
  h.context.fetchOverride = async url => unavailable
    ? { ok: false, status: 503, headers: new Map([['content-type', 'text/html']]), text: async () => '' }
    : { ok: true, headers: new Map([['content-type', 'text/html']]), text: async () => new URL(url).pathname };
  const destination = '/academy.html?course=onboarding#lesson-two';
  const pending = h.router.navigate(destination);
  const loading = h.doc.querySelector('.portal-navigation-loading');
  assert.ok(loading);
  assert.equal(loading.getAttribute('role'), 'status');
  assert.equal(loading.getAttribute('aria-live'), 'polite');
  assert.equal(loading.textContent, 'Carregando a área solicitada…');
  assert.equal(main.querySelector('#unsaved-route-draft'), draft);
  assert.equal(previous.active, true);

  assert.equal(await pending, false);
  const error = h.doc.querySelector('.portal-navigation-error');
  assert.equal(error.getAttribute('role'), 'alert');
  assert.match(error.querySelector('p').textContent, /temporariamente indisponível/);
  assert.equal(h.location.pathname, '/dashboard.html');
  assert.equal(main.querySelector('#unsaved-route-draft'), draft);
  assert.equal(draft.value, 'keep this draft');
  assert.equal(previous.active, true);

  unavailable = false;
  error.querySelector('button').click();
  await drain();
  await drain();
  assert.equal(h.requests.at(-1).url, `https://portal.test${destination}`);
  assert.equal(h.location.pathname, '/academy.html');
  assert.equal(h.location.search, '?course=onboarding');
  assert.equal(h.location.hash, '#lesson-two');
});

test('authorization is server-validated and denied tools never mount, including revoked current areas', async () => {
  const h = await createRouterHarness();
  h.context.user = { uid: 'user-1', role: 'viewer', permissions: {}, autocard_access: false, pos_cards_access: false };
  for (const path of ['/admin.html', '/cms.html', '/autocard.html', '/cards-pos.html']) {
    assert.equal(await h.router.navigate(path), false);
  }
  assert.equal(h.mounts.length, 1);
  h.context.user = { ...h.context.user, role: 'admin' };
  await h.router.navigate('/admin.html');
  const scope = h.scope;
  h.context.user = { ...h.context.user, role: 'viewer' };
  await h.router.navigate('/autocard.html');
  assert.equal(scope.active, false);
  assert.equal(h.doc.getElementById('main-content').children[0].getAttribute('role'), 'alert');
});

test('styles are ready before mounting, style failures preserve content, dependencies load once', async () => {
  const h = await createRouterHarness();
  const src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  h.page('/autocard.html', { styles: ['/autocard/styles.css'], scripts: [src] });
  const previous = h.scope;
  h.context.resourceFailure = true;
  assert.equal(await h.router.navigate('/autocard.html'), false);
  assert.equal(previous.active, true);
  assert.equal(h.location.pathname, '/dashboard.html');
  h.context.resourceFailure = false;
  assert.equal(await h.router.navigate('/autocard.html'), true);
  const loaded = h.resources.length;
  await h.router.navigate('/dashboard.html');
  await h.router.navigate('/autocard.html');
  assert.equal(h.resources.length, loaded, 'cached CSS and libraries are reused');
});

test('native modifier/download/external/fragment semantics survive, and current sidebar links do not reload', async () => {
  const h = await createRouterHarness();
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { defaultPrevented: true }]) {
    const anchor = new Node('a', h.doc, { href: '/knowledge.html' });
    assert.equal(h.router.navigationURL(new TestEvent('click', { target: anchor, ...options })), null);
  }
  for (const [href, attrs] of [['#section', {}], ['https://outside.test/knowledge.html', {}], ['/knowledge.html', { download: 'file' }], ['/knowledge.html', { target: '_blank' }]]) {
    assert.equal(h.router.navigationURL(new TestEvent('click', { target: new Node('a', h.doc, { href, ...attrs }) })), null);
  }
  const same = h.click('/dashboard.html');
  assert.equal(same.defaultPrevented, true);
  assert.equal(h.mounts.length, 1);
});

test('a UID change during resource preparation cannot mount the previously validated profile', async () => {
  const h = await createRouterHarness();
  const css = deferred();
  h.context.resourcePause = css.promise;
  h.page('/profile.html', { styles: ['/profile.css'] });
  const previous = h.scope;
  const loading = h.router.navigate('/profile.html');
  await drain();
  assert.equal(previous.active, true);
  assert.equal(h.mounts.length, 1, 'styles and authorization must be ready before mount');
  h.context.auth.currentUser = { uid: 'different-user' };
  css.resolve();
  assert.equal(await loading, false);
  assert.equal(h.mounts.length, 1);
});

test('CMS guard blocks in-flight work, confirms only unsaved edits, and disposal cancels autosave', async () => {
  const source = await readFile('public/js/cms.js', 'utf8');
  let guard, dispose, confirms = 0;
  const cancelled = [];
  const context = vm.createContext({
    page: { beforeLeave(fn) { guard = fn; }, cleanup(fn) { dispose = fn; } },
    saving: false, actionBusy: false, creatingDocument: false, assetUploading: 0, saveInFlight: null,
     dirty: false, newDocumentDirty: false, saveQueued: false, saveTimer: 42,
     homeEditor: null, editorialFields: null, previewCleanup: null,
     selectionToken: 0, documentsRequestToken: 0, historyRequestToken: 0, creationRequestToken: 0, editorGeneration: 0,
      newsAuthorityRequest: 1,
     showToast() {}, clearTimeout(id) { cancelled.push(id); },
    window: { confirm() { confirms++; return false; } },
  });
  vm.runInContext(source.slice(source.indexOf('page.beforeLeave('), source.indexOf('function setError(')), context);
  assert.equal(guard(), true);
  for (const field of ['saving', 'actionBusy', 'creatingDocument', 'assetUploading', 'saveInFlight']) {
    context[field] = true; assert.equal(guard(), false); context[field] = false;
  }
  assert.equal(confirms, 0, 'confirmation cannot abandon a write');
  context.dirty = true;
  assert.equal(guard(), false); assert.equal(confirms, 1);
  assert.equal(context.dirty, true, 'a guard never clears the draft');
  const pendingAuthorityRequest = context.newsAuthorityRequest;
  dispose();
  assert.deepEqual(cancelled, [42]);
  assert.equal(context.saveTimer, null);
  assert.equal(context.selectionToken, 1);
  assert.equal(context.newsAuthorityRequest, pendingAuthorityRequest + 1,
    'cleanup invalidates in-flight Owner News authority and availability responses');
});

test('the CMS renderer aborts assets and revokes late blobs when the page signal ends', async () => {
  const h = await createRouterHarness();
  const pending = deferred(), revoked = [];
  const host = new Node('div', h.doc); h.doc.getElementById('main-content').append(host);
  let requestedSignal;
  const source = (await readFile('public/js/cms-block-renderer.js', 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
  const context = vm.createContext({
    document: h.doc, AbortController, TextEncoder,
    URL: class extends URL { static revokeObjectURL(url) { revoked.push(url); } },
    MutationObserver: class { observe() {} disconnect() {} },
    clear(node) { node.replaceChildren(); return node; },
    element(tag, options = {}, children = []) { const node = new Node(tag, h.doc, options); node.append(...children); return node; },
    safeHttpUrl: value => value,
    fetchAPIAsset(path, { signal }) { requestedSignal = signal; return pending.promise; },
  });
  vm.runInContext((await readFile('public/js/owner-news/asset-path.mjs', 'utf8')).replace(/^export /gm, ''), context);
  vm.runInContext(source, context);
  const page = new AbortController();
  context.renderBlocks(host, [{ type: 'image', asset_id: '550e8400-e29b-41d4-a716-446655440000', alt: 'Cover' }], { signal: page.signal });
  const image = host.children[0];
  page.abort();
  assert.equal(requestedSignal.aborted, true);
  pending.resolve('blob:late-cms'); await drain();
  assert.deepEqual(revoked, ['blob:late-cms']);
  assert.equal(image.src, undefined);
});

test('Admin reconciles identical tabs by node identity, activates before secondary feature discovery', async () => {
  const h = await createRouterHarness();
  const source = await readFile('public/js/admin.js', 'utf8');
  const container = new Node('div', h.doc, { id: 'admin-tabs' }); h.doc.body.append(container);
  const switched = [];
  const context = vm.createContext({
    document: h.doc, page: { active: true }, me: { permissions: { manageUsers: true } },
    TABS: [['users', 'Usuários', 'manageUsers'], ['academy', 'Academy', 'manageAcademy']],
    solidesAdminAvailable: false, activeTab: null, location: { search: '' }, URLSearchParams, Set,
    can: (user, permission) => !!user.permissions[permission],
    switchTab(id) { switched.push(id); context.activeTab = id; context.location.search = `?tab=${id}`; },
    element(tag, options) { const node = new Node(tag, h.doc); for (const [key, value] of Object.entries(options)) { if (key === 'className') node.className = value; else if (key !== 'on') node.setAttribute(key, value); } return node; },
  });
  vm.runInContext(source.slice(source.indexOf('function buildTabs('), source.indexOf('function switchTab(')), context);
  context.buildTabs(); const users = container.children[0]; users.focus();
  context.buildTabs(); context.buildTabs();
  assert.equal(container.children[0], users);
  assert.equal(h.doc.activeElement, users);
  assert.deepEqual(switched, ['users']);
  context.me.permissions.manageAcademy = true; context.buildTabs();
  assert.equal(container.children[0], users);
  assert.equal(container.children.length, 2);
  assert.ok(source.lastIndexOf('buildTabs();') > source.indexOf('buildTabs();\nif (can(me'));
  assert.match(source, /buildTabs\(\);\nif \(can\(me[\s\S]*void discoverAdminFeatures/);
});
