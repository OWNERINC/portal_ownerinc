import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createRouterHarness, deferred, drain, Node, TestEvent } from '../helpers/router-harness.mjs';

const viewer = { uid: 'user-1', role: 'viewer', permissions: {} };

function privateDialog(h) {
  const dialog = new Node('div', h.doc, { id: 'private-dialog', 'data-page-overlay': '' });
  const form = new Node('form', h.doc);
  const field = new Node('input', h.doc, { name: 'email', value: 'private@example.test' });
  form.append(field); dialog.append(form); h.doc.body.append(dialog);
  h.context.openDialog(dialog, field);
  let calls = 0;
  h.scope.listen(h.window, 'private-listener', () => calls++);
  h.scope.listen(dialog, 'private-listener', () => calls++);
  return { dialog, field, calls: () => calls };
}

function assertPurged(h, previous, overlay) {
  assert.equal(previous.active, false);
  assert.equal(overlay.dialog.isConnected, false);
  assert.equal(overlay.dialog.children.length, 0);
  assert.equal(h.doc.getElementById('private-dialog'), null);
  assert.equal(h.doc.querySelectorAll('[data-page-overlay]').length, 0);
  h.window.dispatchEvent(new TestEvent('private-listener'));
  overlay.dialog.dispatchEvent(new TestEvent('private-listener'));
  assert.equal(overlay.calls(), 0);
  assert.equal(h.doc.body.classList.contains('modal-open'), false);
}

test('review 1/2: authoritative revocation purges Admin even when destination HTML fails first or stays pending', async () => {
  for (const order of ['html-first', 'auth-first', 'destination-denied']) {
    const h = await createRouterHarness({ realUI: true });
    await h.router.navigate('/admin.html');
    const previous = h.scope;
    const overlay = privateDialog(h);
    const html = deferred(), auth = deferred();
    h.context.fetchOverride = () => html.promise;
    h.context.getCurrentUserDoc = () => auth.promise;
    const navigation = h.router.navigate(order === 'destination-denied' ? '/cms.html' : '/dashboard.html');
    if (order !== 'auth-first') html.reject(new Error('HTML offline'));
    await drain();
    assert.equal(previous.active, true, 'preparation failure alone cannot revoke access');
    auth.resolve(viewer);
    await drain();
    assertPurged(h, previous, overlay);
    assert.equal(h.doc.getElementById('main-content').children[0].getAttribute('role'), 'alert');
    if (order === 'auth-first') html.reject(new Error('HTML offline'));
    assert.equal(await navigation, false);
    assert.equal(h.mounts.length, 2, 'the denied/unavailable destination never mounts');
  }
});

test('review 1: a cancelled route still applies its current authorization, but an older/account-mismatched result cannot revoke a newer page', async () => {
  const h = await createRouterHarness();
  await h.router.navigate('/admin.html');
  const oldAuth = deferred();
  h.context.getCurrentUserDoc = () => oldAuth.promise;
  const pending = h.router.navigate('/academy.html');
  h.click('/admin.html'); // Same-page intent cancels only navigation.
  await drain();
  const previous = h.scope;
  oldAuth.resolve(viewer); await pending;
  assert.equal(previous.active, false);

  h.context.getCurrentUserDoc = async () => h.context.user;
  await h.router.navigate('/admin.html');
  const lateAuth = deferred();
  h.context.getCurrentUserDoc = () => lateAuth.promise;
  const stale = h.router.navigate('/academy.html');
  h.context.getCurrentUserDoc = async () => h.context.user;
  await h.router.navigate('/cms.html');
  const newer = h.scope;
  lateAuth.resolve(viewer); await stale;
  assert.equal(newer.active, true);
  assert.equal(h.location.pathname, '/cms.html');

  const otherAccount = deferred();
  h.context.getCurrentUserDoc = () => otherAccount.promise;
  const switching = h.router.navigate('/admin.html');
  h.context.auth.currentUser = { uid: 'user-2' };
  otherAccount.resolve(viewer); await switching;
  assert.equal(newer.active, true, 'the auth observer, not an old-account response, owns session disposal');
});

test('review 2: session loss removes private overlays even when auth already cleared main, and clears unmounted overlay DOM too', async () => {
  const h = await createRouterHarness({ realUI: true });
  await h.router.navigate('/admin.html');
  const previous = h.scope;
  const overlay = privateDialog(h);
  h.doc.getElementById('main-content').replaceChildren(); // auth.js clears main first.
  delete h.doc.documentElement.dataset.authSnapshot;
  h.context.auth.currentUser = null;
  h.notifyAuthChange();
  assertPurged(h, previous, overlay);
  assert.equal(h.doc.getElementById('main-content').children.length, 0);
  const leftover = new Node('div', h.doc, { 'data-page-overlay': '' });
  leftover.append(new Node('input', h.doc, { value: 'private' })); h.doc.body.append(leftover);
  h.notifyAuthChange();
  assert.equal(leftover.isConnected, false, 'purge must not depend on activePage still existing');
});

async function knowledgeWithStagedPdf() {
  const h = await createRouterHarness({ realUI: true });
  const deletes = [];
  const upload = deferred();
  Object.assign(h.context, {
    fetchAPIPage: async () => ({ data: [], total: 0 }),
    fetchAPI: (path, options = {}) => {
      if (options.method === 'POST') return upload.promise;
      if (options.method === 'DELETE') { const call = deferred(); deletes.push({ path, ...call }); return call.promise; }
      return Promise.resolve([]);
    },
    renderBlocks() {}, blocksToText: () => '', readOffset: () => 0,
    renderPagination() {}, setPaginationBusy() {},
  });
  const script = (await readFile('public/js/knowledge.js', 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
  vm.runInContext(`${script}\nglobalThis.knowledgeMount = mount;`, h.context);
  h.modules.set('./knowledge.js', { mount: page => { h.context.currentKnowledgePage = page; h.context.knowledgeMount(page); } });
  h.page('/knowledge.html', { setup(doc) {
    const main = doc.getElementById('main-content');
    for (const id of ['search', 'categories', 'articles-list', 'articles-pagination', 'article-view', 'article-content', 'article-title', 'article-category', 'article-admin-bar', 'btn-back']) {
      main.append(new Node('div', doc, { id }));
    }
    doc.querySelector('.topbar').append(new Node('button', doc, { id: 'btn-new' }));
    const modal = new Node('div', doc, { id: 'modal-article', class: 'hidden' });
    const form = new Node('form', doc, { id: 'article-form' });
    for (const id of ['f-title', 'f-category', 'f-content', 'f-pdf', 'f-pdf-state']) form.append(new Node('input', doc, { id, name: id }));
    for (const id of ['modal-article-title', 'f-pdf-status', 'f-pdf-remove', 'modal-article-save', 'modal-article-close', 'modal-article-cancel']) modal.append(new Node('button', doc, { id }));
    modal.append(form); doc.body.append(modal);
  } });
  assert.equal(await h.router.navigate('/knowledge.html'), true);
  await drain();
  h.doc.getElementById('article-form').reset = () => {
    h.doc.getElementById('article-form').querySelectorAll('input').forEach(input => { input.value = ''; });
  };
  h.doc.getElementById('btn-new').click();
  h.doc.getElementById('f-title').value = 'Unsaved article';
  const input = h.doc.getElementById('f-pdf');
  input.files = [{ name: 'staged.pdf', type: 'application/pdf', size: 100 }];
  input.dispatchEvent(new TestEvent('change'));
  upload.resolve({ id: 'staged-pdf', original_name: 'staged.pdf' }); await drain();
  return { h, deletes, selected: () => JSON.parse(h.doc.getElementById('f-pdf-state').value).selected };
}

test('review 3: Back/Cancel keeps the actual Knowledge staged PDF; committed discard waits for cleanup and survives cleanup failure', async () => {
  const { h, deletes, selected } = await knowledgeWithStagedPdf();
  const page = h.context.currentKnowledgePage;
  h.context.confirmResult = false;
  h.history.go(-1); await drain();
  assert.equal(h.location.pathname, '/knowledge.html');
  assert.equal(deletes.length, 0, 'preflight must never DELETE an uploaded asset');
  assert.equal(selected(), 'staged-pdf');
  assert.equal(page.active, true);
  assert.equal(h.doc.getElementById('modal-article').classList.contains('hidden'), false);

  h.context.confirmResult = true;
  const failed = h.router.navigate('/dashboard.html'); await drain();
  assert.equal(deletes.length, 1);
  assert.equal(page.active, true, 'the request must finish before page disposal');
  deletes[0].reject(new Error('offline'));
  assert.equal(await failed, false);
  assert.equal(selected(), 'staged-pdf');
  assert.equal(h.location.pathname, '/knowledge.html');
  const accepted = h.router.navigate('/dashboard.html'); await drain();
  deletes[1].resolve({ deleted: true });
  assert.equal(await accepted, true);
  assert.equal(page.active, false);
  assert.equal(h.doc.getElementById('modal-article'), null);
});

test('review 3: same-page history and logout use committed discard rather than mutating preflight', async () => {
  for (const action of ['history', 'logout']) {
    const { h, deletes, selected } = await knowledgeWithStagedPdf();
    const page = h.context.currentKnowledgePage;
    if (action === 'history') page.history.pushState({}, '', '/knowledge.html?q=one');
    h.context.confirmResult = false;
    if (action === 'history') h.history.go(-1); else await h.router.requestLogout();
    await drain();
    assert.equal(deletes.length, 0);
    assert.equal(selected(), 'staged-pdf');
    h.context.confirmResult = true;
    const done = action === 'logout' ? h.router.requestLogout() : (h.history.go(-1), Promise.resolve());
    await drain();
    assert.equal(deletes.length, 1);
    deletes[0].resolve({ deleted: true }); await done; await drain();
    if (action === 'logout') assert.equal(h.context.loggedOut, true);
    else {
      assert.equal(h.location.search, '');
      assert.equal(h.doc.getElementById('modal-article').classList.contains('hidden'), true);
    }
  }
});

test('review 3: local modal close confirms before cleanup and closes once only after successful deletion', async () => {
  const { h, deletes, selected } = await knowledgeWithStagedPdf();
  let confirmations = 0;
  h.window.confirm = () => { confirmations++; return h.context.confirmResult; };
  h.context.confirmResult = false;
  h.doc.getElementById('modal-article-close').click(); await drain();
  assert.equal(deletes.length, 0);
  assert.equal(selected(), 'staged-pdf');
  h.context.confirmResult = true;
  h.doc.getElementById('modal-article-close').click(); await drain();
  assert.equal(deletes.length, 1);
  assert.equal(h.doc.getElementById('modal-article').classList.contains('hidden'), false);
  deletes[0].resolve({ deleted: true }); await drain();
  assert.equal(h.doc.getElementById('modal-article').classList.contains('hidden'), true);
  assert.equal(confirmations, 2, 'cleanup completion must not ask for consent a second time');
});

test('review 4: saving Owner updates only its submitted snapshot and keeps Guest edits protected', async () => {
  const source = await readFile('public/cards-pos/app.js', 'utf8');
  const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
  const writes = [], guards = [], unload = [];
  const context = vm.createContext({
    guestDefaults: { heroTitle: 'Guest', heroBrand: 'Brand' }, ownerDefaults: { heroTitle: 'Owner', heroBrand: 'Brand' },
    page: { busy: false, beforeLeave: guard => guards.push(guard), listen: (_, type, fn) => { if (type === 'beforeunload') unload.push(fn); }, cleanup() {} },
    window: { confirm: () => false, prompt: () => 'Saved card' },
    $: () => ({}), setStatus() {}, updateToolbarState() {}, updateModuleControls() {}, loadValues() {},
    richTextToPlainText: value => value,
    fetchAPI(path, options) { const call = deferred(); writes.push({ path, options, ...call }); return call.promise; },
  });
  vm.runInContext([
    section('let current =', 'const HISTORY_PAGE_SIZE'),
    section('function activeValues()', 'function richTextLength'),
    section('function switchModule(', 'function replaceMediaUrl'),
    section('async function save()', 'function renderHistory('),
    source.slice(source.lastIndexOf("for (const template of ['convite_owntime'"), source.lastIndexOf('}')),
  ].join('\n'), context);
  assert.equal(guards[0](), true);
  vm.runInContext("current.values.heroTitle = 'Guest edits'; switchModule('convite_owner'); current.ownerValues.heroTitle = 'Owner submitted';", context);
  const saving = context.save();
  assert.equal(JSON.parse(writes[0].options.body).template, 'convite_owner');
  assert.equal(JSON.parse(writes[0].options.body).values.heroTitle, 'Owner submitted');
  vm.runInContext("current.ownerValues.heroTitle = 'Owner newer edit';", context);
  writes[0].resolve({ id: 'owner-id', name: 'Saved card' }); await saving;
  assert.equal(guards[0](), false, 'both inactive Guest and newer Owner edits remain unsaved');
  const saveOwner = context.save(); writes[1].resolve({ id: 'owner-id' }); await saveOwner;
  assert.equal(guards[0](), false, 'saving Owner cannot mark Guest as saved');
  const event = new TestEvent('beforeunload'); unload[0](event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(vm.runInContext('current.values.heroTitle', context), 'Guest edits');
  vm.runInContext("switchModule('convite_owntime');", context);
  const failed = context.save(); writes[2].reject(new Error('offline')); await failed;
  assert.equal(guards[0](), false, 'failed saves cannot change either clean baseline');
});

test('review 5: same-path clicks during boot restart a real mount instead of leaving hidden pending content', async () => {
  for (const path of ['/dashboard.html', '/dashboard.html?q=initial']) {
    const h = await createRouterHarness({ autoStart: false });
    h.doc.getElementById('main-content').setAttribute('data-route-pending', '');
    const validation = deferred();
    h.context.getCurrentUserDoc = () => validation.promise;
    const boot = h.router.startRouter();
    const event = h.click(path);
    assert.equal(event.defaultPrevented, true);
    validation.resolve(h.context.user);
    await boot; await drain();
    assert.equal(h.mounts.length, 1);
    assert.equal(h.scope.active, true);
    assert.equal(h.doc.getElementById('main-content').hasAttribute('data-route-pending'), false);
    assert.equal(h.location.search, new URL(path, h.location.href).search);
  }
});

test('review 6: deferred Sólides discovery honors the requested tab and never overwrites a newer selection', async () => {
  const source = await readFile('public/js/admin.js', 'utf8');
  for (const selection of [null, 'academy', 'users', 'unavailable']) {
    const h = await createRouterHarness({ initialURL: 'https://portal.test/admin.html?tab=solides', realUI: true });
    const main = h.doc.getElementById('main-content');
    main.append(new Node('div', h.doc, { id: 'admin-tabs' }));
    for (const tab of ['users', 'academy', 'solides']) main.append(new Node('section', h.doc, { id: `section-${tab}`, class: 'admin-section' }));
    const status = deferred(), loaded = [];
    Object.assign(h.context, {
      page: h.scope, me: { permissions: { manageUsers: true, manageAcademy: true, manageSolides: true } },
      history: h.scope.history,
      fetchAPI: () => status.promise,
      loadUsers: () => loaded.push('users'), loadCourses: () => loaded.push('academy'), loadSolides: () => loaded.push('solides'),
    });
    vm.runInContext(`let activeTab = null; let solidesAdminStatus = null; let solidesAdminAvailable = false; let solidesDiscoveryPending = true;
const TABS = [['users', 'Users', 'manageUsers'], ['academy', 'Academy', 'manageAcademy']];
${source.slice(source.indexOf('async function discoverAdminFeatures('), source.indexOf('async function toggleJobTitle('))}
${source.slice(source.indexOf('function buildTabs('), source.indexOf('function renderSolidesStatus('))}
buildTabs(); globalThis.discovered = discoverAdminFeatures().then(() => buildTabs());`, h.context);
    assert.deepEqual(loaded, ['users'], 'an immediate fallback tab cannot wait on feature discovery');
    assert.equal(h.scope.location.search, '?tab=solides');
    const users = h.doc.getElementById('tab-users');
    if (selection && selection !== 'unavailable') h.doc.getElementById(`tab-${selection}`).click();
    if (selection === 'unavailable') status.reject(new Error('feature disabled')); else status.resolve({ stage: 'internal' });
    await h.context.discovered;
    assert.equal(h.doc.getElementById('tab-users'), users, 'reconciliation retains existing tab nodes');
    const expected = selection === 'unavailable' ? 'users' : selection || 'solides';
    assert.equal(new URLSearchParams(h.scope.location.search).get('tab'), expected);
    assert.equal(h.doc.getElementById(`tab-${expected}`).getAttribute('aria-selected'), 'true');
    assert.equal(loaded.filter(tab => tab === 'users').length, 1);
  }
});
