import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createRouterHarness, deferred, drain, Node, TestEvent } from '../helpers/router-harness.mjs';

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

test('BFCache keeps the mounted page lifecycle and does not remount on persisted pageshow', async () => {
  const h = await createRouterHarness();
  const mounts = h.mounts.length;
  h.window.dispatchEvent(new TestEvent('pagehide', { persisted: true }));
  h.window.dispatchEvent(new TestEvent('test-page-event'));
  assert.equal(h.events.length, 1);

  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  await drain();
  assert.equal(h.mounts.length, mounts);
  assert.equal(h.disposed.length, 0);

  h.window.dispatchEvent(new TestEvent('pagehide', { persisted: false }));
  assert.equal(h.disposed.length, 1);
  h.window.dispatchEvent(new TestEvent('test-page-event'));
  assert.equal(h.events.length, 1);
});

test('BFCache aborts pending navigation without replacing the preserved page', async () => {
  const h = await createRouterHarness();
  const preservedMain = h.doc.getElementById('main-content');
  const preservedHeading = preservedMain.querySelector('h1');
  const preservedMounts = h.mounts.length;
  const first = deferred();
  let firstSignal;
  h.context.fetchOverride = (url, options) => {
    firstSignal = options.signal;
    return first.promise;
  };

  const pendingNavigation = h.router.navigate('/academy.html');
  await drain();
  assert.ok(firstSignal, 'navigation must start an abortable fetch');
  h.window.dispatchEvent(new TestEvent('pagehide', { persisted: true }));
  assert.equal(firstSignal.aborted, true);
  first.resolve({ ok: true, headers: new Map([['content-type', 'text/html']]), text: async () => '/academy.html' });
  assert.equal(await pendingNavigation, false);
  assert.equal(h.mounts.length, preservedMounts);
  assert.equal(h.doc.getElementById('main-content'), preservedMain);
  assert.equal(h.doc.getElementById('main-content').querySelector('h1'), preservedHeading);

  const second = deferred();
  let secondSignal;
  h.context.fetchOverride = (url, options) => {
    secondSignal = options.signal;
    return second.promise;
  };
  const rejectedNavigation = h.router.navigate('/knowledge.html');
  await drain();
  h.window.dispatchEvent(new TestEvent('pagehide', { persisted: true }));
  assert.equal(secondSignal.aborted, true);
  second.reject(new Error('late failure'));
  assert.equal(await rejectedNavigation, false);
  h.window.dispatchEvent(new TestEvent('pageshow', { persisted: true }));
  await drain();
  assert.equal(h.mounts.length, preservedMounts);
  assert.equal(h.doc.getElementById('main-content'), preservedMain);
  assert.equal(h.doc.getElementById('main-content').querySelector('h1'), preservedHeading);

  h.window.dispatchEvent(new TestEvent('pagehide', { persisted: false }));
  assert.equal(h.disposed.length, 1);
  h.window.dispatchEvent(new TestEvent('test-page-event'));
  assert.equal(h.events.length, 0);
});

test('signed-out direct links keep the destination query and fragment through login', async () => {
  const destination = '/knowledge.html?q=normas&article=one#pdf';
  const h = await createRouterHarness({ initialURL: `https://portal.test${destination}`, user: null });
  const redirect = new URL(h.location.redirect, h.location.href);
  assert.equal(redirect.pathname, '/login.html');
  assert.equal(redirect.searchParams.get('next'), destination);
  assert.equal(h.mounts.length, 0);
});

test('friendly Pages boot and SPA navigation use a fixed template/module while retaining actual history', async () => {
  const destination = '/conteudos/codigo-de-vestimenta?from=direct#section-test';
  const direct = await createRouterHarness({ initialURL: `https://portal.test${destination}` });
  assert.equal(direct.mounts[0].name, './pages.js');
  assert.equal(direct.scope.location.pathname, '/conteudos/codigo-de-vestimenta');
  assert.equal(direct.router.routeAllowed('/conteudos/a/b', direct.context.user), false);
  assert.equal(direct.router.routeAllowed('/conteudos/codigo-de-vestimenta', null), false);
  const h = await createRouterHarness();
  h.page('/pages.html', { styles: ['./css/pages.css'] });
  assert.equal(await h.router.navigate(destination), true);
  assert.equal(new URL(h.requests.at(-1).url).pathname, '/pages.html');
  assert.equal(h.scope.location.pathname, '/conteudos/codigo-de-vestimenta');
  assert.equal(h.scope.location.hash, '#section-test');
  assert.equal(h.resources.at(-1).href, 'https://portal.test/css/pages.css');
  const anchor = new Node('a', h.doc, { href: './dashboard.html' });
  assert.equal(h.router.navigationURL(new TestEvent('click', { target: anchor })).pathname, '/dashboard.html');
  const fragment = h.click('#section-next'); await drain();
  assert.equal(fragment.defaultPrevented, true, 'base-displaced fragments stay within the actual page');
  assert.equal(h.location.pathname, '/conteudos/codigo-de-vestimenta');
  assert.equal(h.scope.location.hash, '#section-next');
  await h.router.navigate('/page-editor.html?id=test');
  h.history.back(); await drain();
  assert.equal(h.scope.location.pathname, '/conteudos/codigo-de-vestimenta');
  h.history.forward(); await drain();
  assert.equal(h.scope.location.pathname, '/page-editor.html');
  assert.equal(h.doc.baseURI, 'https://portal.test/', 'self base remains stable across later native traversals');
  assert.equal(h.router.navigationURL(new TestEvent('click', { target: new Node('a', h.doc, { href: '/conteudos/a/b' }) })), null);
  assert.equal(await h.router.navigate('https://outside.test/conteudos/valid'), false);
  const anonymous = await createRouterHarness({ initialURL: `https://portal.test${destination}`, user: null });
  assert.equal(anonymous.location.redirect, `/login.html?reason=session&next=${encodeURIComponent(destination)}`);
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

test('after leaving a Pages alias, repaired fragments do not consult dirty leave guards or discard UI', async () => {
  const h = await createRouterHarness();
  await h.router.navigate('/conteudos/guia');
  await h.router.navigate('/page-editor.html?id=retained');
  const page = h.scope, mounts = h.mounts.length, requests = h.requests.length;
  const calls = { page: 0, ui: 0, discard: 0, close: 0 };
  page.beforeLeave(() => { calls.page++; return false; });
  h.context.canLeavePageUI = () => { calls.ui++; return false; };
  h.context.commitPageLeaveUI = () => { calls.discard++; return false; };
  h.context.closePageDialogs = () => { calls.close++; };
  const event = h.click('#main-content'); await drain();
  assert.equal(event.defaultPrevented, true, 'only repair the base-displaced native fragment');
  assert.equal(h.scope.location.pathname, '/page-editor.html');
  assert.equal(h.scope.location.search, '?id=retained');
  assert.equal(h.scope.location.hash, '#main-content');
  assert.deepEqual(calls, { page: 0, ui: 0, discard: 0, close: 0 });
  assert.equal(h.doc.activeElement, h.doc.getElementById('main-content'));
  assert.equal(h.scope, page); assert.equal(page.active, true);
  assert.equal(h.mounts.length, mounts); assert.equal(h.requests.length, requests);
  const entries = h.entries.length;
  h.click('#main-content'); await drain();
  assert.equal(h.entries.length, entries, 'repeating the fragment must not duplicate history');
  h.click('/page-editor.html?id=another#main-content'); await drain();
  assert.equal(calls.page, 1, 'real same-page query changes still consult dirty guards');
  assert.equal(h.scope.location.search, '?id=retained');
  assert.equal(await h.router.navigate('/dashboard.html'), false, 'cross-page navigation remains guarded');
  assert.equal(calls.page, 2);
});

test('after leaving a Pages alias, a repaired skip link focuses immediately while a mutation stays pending', async () => {
  const h = await createRouterHarness();
  await h.router.navigate('/conteudos/guia');
  await h.router.navigate('/page-editor.html?id=busy');
  const page = h.scope, saving = deferred();
  const request = page.bindAPI({ fetchAPI: () => saving.promise }).fetchAPI('/api/pages/busy/draft', { method: 'PUT' });
  const anchor = new Node('a', h.doc, { href: '#main-content' }); anchor.focus();
  try {
    assert.equal(page.busy, true);
    h.click('#main-content'); await drain();
    assert.equal(page.location.hash, '#main-content');
    assert.equal(h.doc.activeElement, h.doc.getElementById('main-content'), 'focus must not await page.ready()/the pending save');
    assert.equal(page.busy, true, 'the originating mutation remains pending');
    assert.equal(h.scope, page); assert.equal(page.active, true);
    h.click('/page-editor.html?id=other'); await drain();
    assert.equal(page.location.search, '?id=busy', 'query changes remain blocked by the pending mutation');
    assert.equal(await h.router.navigate('/dashboard.html'), false);
    await h.router.requestLogout(); assert.equal(h.context.loggedOut, undefined);
  } finally { saving.resolve({ saved: true }); await request; }
  assert.equal(page.busy, false);
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
  await h.router.navigate('/profile.html');
  h.context.uiLeaveAllowed = false;
  const oldMain = h.doc.getElementById('main-content').children[0];
  assert.equal(await h.router.navigate('/dashboard.html'), false);
  h.history.go(-1); await drain();
  assert.equal(h.location.pathname, '/profile.html');
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

test('authorization is server-validated and denied tools never mount, including revoked current areas', async () => {
  const h = await createRouterHarness();
  h.context.user = { uid: 'user-1', role: 'viewer', permissions: {}, autocard_access: false, pos_cards_access: false };
  for (const path of ['/admin.html', '/autocard.html', '/cards-pos.html']) {
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
