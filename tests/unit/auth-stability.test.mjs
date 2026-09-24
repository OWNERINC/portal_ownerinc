import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const authSource = await readFile(new URL('../../public/js/auth.js', import.meta.url), 'utf8');
const shellSource = await readFile(new URL('../../public/js/auth-shell.js', import.meta.url), 'utf8');
const snapshotKey = 'ownerinc-auth-snapshot';
const firebaseKey = 'firebase:authUser:test-key:[DEFAULT]';
const account = uid => ({ uid, getIdToken: async () => `token-${uid}` });
const userDoc = (uid = 'a', overrides = {}) => ({
  uid, role: 'admin', name: 'Private name', email: `${uid}@example.test`,
  permissions: { manageUsers: true, manageKnowledge: true },
  autocard_access: true, pos_cards_access: true, ...overrides,
});
const visualSnapshot = (uid = 'a', overrides = {}) => ({
  version: 2, uid, firebaseStorageKey: firebaseKey, savedAt: Date.now() - 86400000,
  user: { uid }, role: 'admin', permissions: { manageUsers: true, manageKnowledge: true },
  autocardAccess: true, posCardsAccess: true, cmsAccess: true, ...overrides,
});
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function storage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function harness({ uid = 'a', persistedUid = uid, snapshot = visualSnapshot(uid), ready, fetchImpl, signOutImpl, loadModule = true } = {}) {
  const listeners = [];
  const redirects = [];
  const requests = [];
  let signouts = 0;
  const main = { children: ['existing content'], replaceChildren(...children) { this.children = children; } };
  const auth = {
    currentUser: uid ? account(uid) : null,
    app: { name: '[DEFAULT]', options: { apiKey: 'test-key' } },
    authStateReady: () => ready || Promise.resolve(),
  };
  const sessionStorage = storage(snapshot ? { [snapshotKey]: JSON.stringify(snapshot) } : {});
  const localStorage = storage(persistedUid ? { [firebaseKey]: JSON.stringify({ uid: persistedUid }) } : {});
  const document = {
    documentElement: { dataset: {} }, body: main,
    querySelector: selector => selector === 'main' ? main : null,
    createElement: () => ({ setAttribute() {}, addEventListener() {}, append() {} }),
  };
  const location = {
    href: 'https://portal.example.test/admin.html',
    replace: url => redirects.push(url), reload() {},
  };
  function changeUser(nextUid) {
    auth.currentUser = nextUid ? account(nextUid) : null;
    for (const listener of listeners) listener(auth.currentUser);
  }
  const context = vm.createContext({
    auth, document, sessionStorage, localStorage, window: { location }, location,
    URL, URLSearchParams, DOMException, setTimeout, console,
    onAuthStateChanged: (_auth, callback) => { listeners.push(callback); return () => {}; },
    signOut: async () => { signouts += 1; changeUser(null); await signOutImpl?.(); },
    updateProfile: async () => {},
    fetch: async (...args) => {
      requests.push(args);
      return fetchImpl ? fetchImpl(...args) : response(userDoc(auth.currentUser.uid));
    },
  });
  vm.runInContext(shellSource, context);
  if (loadModule) {
    const source = authSource.replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
    vm.runInContext(`${source}\nglobalThis.api = { requireAuth, getCurrentUserDoc, getCachedUserSnapshot, authenticatedFetch, fetchAPI, fetchAPIPage, fetchAPIAsset, logout };`, context);
  }
  return {
    api: context.api, auth, sessionStorage, localStorage, document, main, requests, redirects, location,
    changeUser, listeners, get signouts() { return signouts; },
  };
}

test('early shell retains old same-account navigation, but rejects legacy, mismatched and signed-out snapshots', () => {
  const valid = harness({ loadModule: false });
  assert.equal(valid.document.documentElement.dataset.authSnapshot, 'true');
  assert.equal(valid.document.documentElement.dataset.portalRole, 'admin');
  assert.equal(valid.document.documentElement.dataset.authState, 'pending');
  for (const options of [
    { uid: 'b', snapshot: visualSnapshot('a') },
    { uid: null, snapshot: visualSnapshot('a') },
    { snapshot: visualSnapshot('a', { version: 1 }) },
  ]) {
    const h = harness({ ...options, loadModule: false });
    assert.equal(h.document.documentElement.dataset.portalRole, undefined);
    assert.equal(h.sessionStorage.getItem(snapshotKey), null);
  }
});

test('cached helper waits for Firebase identity and exposes only same-account visual data', async () => {
  const ready = deferred();
  const h = harness({ ready: ready.promise });
  assert.equal(h.api.getCachedUserSnapshot(), null);
  const validation = h.api.getCurrentUserDoc();
  ready.resolve();
  assert.equal((await validation).name, 'Private name');
  const cached = h.api.getCachedUserSnapshot();
  assert.equal(cached.uid, 'a');
  assert.equal(cached.role, 'admin');
  assert.equal(cached.permissions.manageUsers, true);
  assert.equal(cached.name, undefined);
  assert.equal(cached.email, undefined);
  cached.permissions.manageUsers = false;
  assert.equal(h.api.getCachedUserSnapshot().permissions.manageUsers, true);
  assert.equal(JSON.parse(h.sessionStorage.getItem(snapshotKey)).user.name, undefined);
  h.changeUser('b');
  assert.equal(h.api.getCachedUserSnapshot(), null);
  assert.equal(h.document.documentElement.dataset.portalRole, undefined);
});

test('concurrent validations share one request, subsequent validation refreshes revoked permissions', async () => {
  const pending = deferred();
  let first = true;
  const h = harness({ fetchImpl: () => {
    if (first) { first = false; return pending.promise; }
    return response(userDoc('a', { role: 'viewer', permissions: {}, autocard_access: false, pos_cards_access: false }));
  } });
  const results = [h.api.getCurrentUserDoc(), h.api.requireAuth(), h.api.requireAuth(true)];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 1);
  pending.resolve(response(userDoc()));
  assert.ok((await Promise.all(results)).every(user => user.uid === 'a'));
  assert.equal(h.document.documentElement.dataset.authState, 'ready');
  assert.equal(await h.api.requireAuth(true), null);
  assert.equal(h.requests.length, 2);
  assert.equal(h.document.documentElement.dataset.portalRole, 'viewer');
  assert.equal(h.document.documentElement.dataset.autocardAccess, 'false');
  assert.equal(h.document.documentElement.dataset.posCardsAccess, 'false');
  assert.equal(h.document.documentElement.dataset.cmsAccess, 'false');
  assert.match(h.redirects.at(-1), /dashboard\.html/);
});

test('network and 5xx failures preserve visual permissions without authenticating content; retry validates again', async () => {
  for (const failure of [new TypeError('offline'), response({ error: 'unavailable' }, 503)]) {
    let failing = true;
    const h = harness({ fetchImpl: () => {
      if (!failing) return response(userDoc());
      if (failure instanceof Error) throw failure;
      return failure.clone();
    } });
    assert.equal(await h.api.requireAuth(), null);
    assert.equal(h.document.documentElement.dataset.portalRole, 'admin');
    assert.equal(h.document.documentElement.dataset.authSnapshot, 'true');
    assert.equal(h.document.documentElement.dataset.authState, 'error');
    assert.notEqual(h.sessionStorage.getItem(snapshotKey), null);
    assert.equal(h.signouts, 0);
    assert.equal(h.redirects.length, 0);
    assert.equal(h.main.children[0].className, 'empty-state auth-error-state');
    await assert.rejects(h.api.getCurrentUserDoc());
    failing = false;
    assert.equal((await h.api.getCurrentUserDoc()).uid, 'a');
    assert.equal(h.document.documentElement.dataset.authState, 'ready');
  }
});

test('resource 403 does not invalidate the session; 401 and definitive session 403 do', async () => {
  const resource = harness({ fetchImpl: () => response({ error: 'Permission denied' }, 403) });
  await assert.rejects(resource.api.fetchAPI('/api/users'), error => error.status === 403);
  assert.equal(resource.signouts, 0);
  assert.notEqual(resource.sessionStorage.getItem(snapshotKey), null);
  for (const [path, status, body] of [
    ['/api/users', 401, {}],
    ['/api/users/me', 403, {}],
    ['/api/users', 403, { reason: 'account-disabled' }],
    ['/api/users', 403, { reason: 'pending-approval' }],
    ['/api/users', 403, { reason: 'enable-pending' }],
    ['/api/users', 403, { reason: 'email-not-verified' }],
  ]) {
    const h = harness({ fetchImpl: () => response(body, status) });
    await assert.rejects(h.api.fetchAPI(path), error => error.status === status);
    assert.equal(h.signouts, 1);
    assert.equal(h.sessionStorage.getItem(snapshotKey), null);
    assert.equal(h.document.documentElement.dataset.portalRole, undefined);
    assert.match(h.redirects.at(-1), /login\.html\?reason=/);
    assert.equal(h.api.getCachedUserSnapshot(), null);
  }
});

test('late validation cannot restore permissions after logout, remote logout or account switch', async () => {
  for (const endSession of [h => h.api.logout(), h => h.changeUser(null), h => h.changeUser('b')]) {
    const pending = deferred();
    const h = harness({ fetchImpl: () => pending.promise });
    const result = h.api.requireAuth();
    await new Promise(resolve => setImmediate(resolve));
    await endSession(h);
    pending.resolve(response(userDoc()));
    assert.equal(await result, null);
    assert.equal(h.sessionStorage.getItem(snapshotKey), null);
    assert.equal(h.document.documentElement.dataset.portalRole, undefined);
    assert.equal(h.main.children.length, 0);
    assert.equal(h.listeners.length, 1);
  }
});

test('old-account success or denial cannot overwrite or sign out a newly validated account', async () => {
  for (const status of [200, 401, 403]) {
    const pending = deferred();
    let calls = 0;
    const h = harness({ fetchImpl: () => ++calls === 1 ? pending.promise : response(userDoc('b', { role: 'viewer' })) });
    const oldRequest = h.api.requireAuth();
    await new Promise(resolve => setImmediate(resolve));
    h.changeUser('b');
    assert.equal((await h.api.getCurrentUserDoc()).uid, 'b');
    pending.resolve(response(status === 200 ? userDoc() : { reason: 'account-disabled' }, status));
    assert.equal(await oldRequest, null);
    assert.equal(h.signouts, 0);
    assert.equal(h.document.documentElement.dataset.portalRole, 'viewer');
    assert.equal(JSON.parse(h.sessionStorage.getItem(snapshotKey)).uid, 'b');
  }
});

test('a mismatched API identity never authenticates or enters the visual cache', async () => {
  const h = harness({ fetchImpl: () => response(userDoc('b')) });
  assert.equal(await h.api.requireAuth(), null);
  assert.equal(h.sessionStorage.getItem(snapshotKey), null);
  assert.equal(h.api.getCachedUserSnapshot(), null);
  assert.equal(h.document.documentElement.dataset.portalRole, undefined);
});

test('Firebase UID mismatch is removed at module load, before readiness or any profile request', async () => {
  const ready = deferred();
  const h = harness({ ready: ready.promise });
  // The shell saw A in local persistence; Firebase has already selected B.
  const other = harness({ uid: 'b', persistedUid: 'a', snapshot: visualSnapshot('a'), ready: ready.promise });
  assert.equal(other.sessionStorage.getItem(snapshotKey), null);
  assert.equal(other.document.documentElement.dataset.portalRole, undefined);
  assert.equal(other.api.getCachedUserSnapshot(), null);
  h.auth.currentUser = account('b');
  ready.resolve();
  const user = await h.api.getCurrentUserDoc();
  assert.equal(user.uid, 'b');
  assert.equal(h.api.getCachedUserSnapshot().uid, 'b');
});

test('remote logout without requests clears visible private content and redirects immediately', async () => {
  const h = harness();
  await h.api.requireAuth();
  h.changeUser(null);
  assert.equal(h.main.children.length, 0);
  assert.equal(h.sessionStorage.getItem(snapshotKey), null);
  assert.equal(h.api.getCachedUserSnapshot(), null);
  assert.match(h.redirects.at(-1), /login\.html\?reason=session/);
  const signedOut = harness({ uid: null });
  assert.equal(await signedOut.api.getCurrentUserDoc(), null);
  assert.equal(await signedOut.api.requireAuth(), null);
  assert.equal(signedOut.requests.length, 0);
});

test('a slow token cannot send a write for the previous account', async () => {
  const token = deferred();
  const h = harness();
  h.auth.currentUser.getIdToken = () => token.promise;
  const write = h.api.fetchAPI('/api/users/me', { method: 'PUT', body: '{"name":"old-account"}' });
  const rejected = assert.rejects(write, error => error.name === 'AbortError');
  await new Promise(resolve => setImmediate(resolve));
  h.changeUser('b');
  token.resolve('token-a');
  await rejected;
  assert.equal(h.requests.length, 0);
});

test('a switch at the fetch helper await boundary cannot send a write as the new account', async () => {
  const h = harness();
  await h.api.getCurrentUserDoc();
  const count = h.requests.length;
  const write = h.api.fetchAPI('/api/users/me', { method: 'PUT', body: '{"name":"old-account"}' });
  h.changeUser('b');
  await assert.rejects(write, error => error.name === 'AbortError');
  assert.equal(h.requests.length, count);
});

test('a decoded response cannot repopulate a logged-out session and a late denial cannot sign out another account', async () => {
  for (const status of [200, 403]) {
    const decoded = deferred();
    const h = harness({ fetchImpl: () => ({
      ok: status === 200, status, headers: new Headers(),
      json: () => decoded.promise, clone: () => ({ json: () => decoded.promise }),
    }) });
    const result = h.api.requireAuth();
    await new Promise(resolve => setImmediate(resolve));
    h.changeUser('b');
    decoded.resolve(status === 200 ? userDoc() : { reason: 'account-disabled' });
    assert.equal(await result, null);
    assert.equal(h.signouts, 0);
    assert.equal(h.auth.currentUser.uid, 'b');
    assert.equal(h.sessionStorage.getItem(snapshotKey), null);
  }
});

test('settling old work does not remove the new account single-flight validation', async () => {
  const old = deferred();
  const current = deferred();
  const h = harness({ fetchImpl: (_path, options) => options.headers.Authorization === 'Bearer token-a' ? old.promise : current.promise });
  const oldResult = h.api.requireAuth();
  await new Promise(resolve => setImmediate(resolve));
  h.changeUser('b');
  const currentResult = h.api.getCurrentUserDoc();
  await new Promise(resolve => setImmediate(resolve));
  old.resolve(response(userDoc()));
  assert.equal(await oldResult, null);
  const joined = h.api.getCurrentUserDoc();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.length, 2);
  current.resolve(response(userDoc('b')));
  assert.equal((await currentResult).uid, 'b');
  assert.equal((await joined).uid, 'b');
});

test('logout followed by same-account login fences late success, and slow logout does not redirect a new account', async () => {
  const pending = deferred();
  let calls = 0;
  const h = harness({ fetchImpl: () => ++calls === 1 ? pending.promise : response(userDoc('a', { role: 'viewer' })) });
  const oldResult = h.api.requireAuth();
  await new Promise(resolve => setImmediate(resolve));
  await h.api.logout();
  h.changeUser('a');
  await h.api.getCurrentUserDoc();
  pending.resolve(response(userDoc()));
  assert.equal(await oldResult, null);
  assert.equal(h.document.documentElement.dataset.portalRole, 'viewer');

  const signout = deferred();
  const slow = harness({ signOutImpl: () => signout.promise });
  const leaving = slow.api.logout();
  slow.changeUser('b');
  signout.resolve();
  await leaving;
  assert.equal(slow.location.href, 'https://portal.example.test/admin.html');
});

test('transient token errors keep the visual shell; invalid tokens clear it', async () => {
  for (const code of ['auth/network-request-failed', 'auth/user-token-expired', 'auth/user-disabled']) {
    const h = harness();
    h.auth.currentUser.getIdToken = async () => { throw Object.assign(new Error(code), { code }); };
    assert.equal(await h.api.requireAuth(), null);
    assert.equal(h.requests.length, 0);
    const transient = code === 'auth/network-request-failed';
    assert.equal(h.sessionStorage.getItem(snapshotKey) !== null, transient);
    assert.equal(h.signouts, transient ? 0 : 1);
  }
});

test('storage failure retains only in-memory visual hints, never a content fallback', async () => {
  let offline = false;
  const h = harness({ snapshot: null, fetchImpl: () => {
    if (offline) throw new TypeError('offline');
    return response(userDoc());
  } });
  h.sessionStorage.setItem = h.sessionStorage.getItem = h.sessionStorage.removeItem = () => { throw new Error('blocked'); };
  assert.equal((await h.api.requireAuth()).uid, 'a');
  offline = true;
  assert.equal(await h.api.requireAuth(), null);
  assert.equal(h.document.documentElement.dataset.portalRole, 'admin');
  assert.equal(h.api.getCachedUserSnapshot().role, 'admin');
  assert.equal(h.api.getCachedUserSnapshot().name, undefined);
  h.changeUser(null);
  assert.equal(h.api.getCachedUserSnapshot(), null);
});

test('non-rendering validation preserves the current view on outages and fetch helper response contracts remain compatible', async () => {
  const h = harness({ fetchImpl: () => { throw new TypeError('offline'); } });
  await assert.rejects(h.api.getCurrentUserDoc(), /offline/);
  assert.deepEqual(h.main.children, ['existing content']);

  const headers = new Headers({ 'X-Total-Count': '42' });
  const paged = harness({ fetchImpl: () => new Response('[{"id":1}]', { headers }) });
  const page = await paged.api.fetchAPIPage('/api/users?limit=1');
  assert.equal(page.total, 42);
  assert.equal(page.data[0].id, 1);
  assert.equal(paged.requests[0][1].headers.Authorization, 'Bearer token-a');
  const noContent = harness({ fetchImpl: () => new Response(null, { status: 204 }) });
  assert.equal(await noContent.api.fetchAPI('/api/users/one', { method: 'DELETE' }), null);
  const asset = harness({ fetchImpl: () => new Response(new Blob(['asset'])) });
  const url = await asset.api.fetchAPIAsset('/api/assets/one');
  assert.match(url, /^blob:/);
  URL.revokeObjectURL(url);
});
