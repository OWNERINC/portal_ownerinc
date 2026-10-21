import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const authSource = await readFile(new URL('../../public/js/auth.js', import.meta.url), 'utf8');
const shellSource = await readFile(new URL('../../public/js/auth-shell.js', import.meta.url), 'utf8');
const contentLengthSource = await readFile(new URL('../../public/js/content-length.js', import.meta.url), 'utf8').catch(() => '');
const snapshotKey = 'ownerinc-auth-snapshot';
const firebaseKey = 'firebase:authUser:test-key:[DEFAULT]';
const CONTENTS_AUTH_BODY_LIMIT = 16 * 1024;
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
function trackedResponse({ status = 403, contentLength, bytes = new TextEncoder().encode('{"error":"private body"}') } = {}) {
  let pulls = 0;
  let sourceCancellations = 0;
  let sent = false;
  let cloneCalls = 0;
  let clonePullBaseline;
  let cloneBodyCancels = 0;
  let cloneReaderAcquisitions = 0;
  let cloneReaderReads = 0;
  let cloneReaderCancels = 0;
  let resolveSourceCancellation;
  const sourceCancellation = new Promise(resolve => { resolveSourceCancellation = resolve; });
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (contentLength !== undefined) headers.set('Content-Length', String(contentLength));
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      if (sent) controller.close();
      else { sent = true; controller.enqueue(bytes); }
    },
    cancel() { sourceCancellations += 1; resolveSourceCancellation(); },
  }, { highWaterMark: 0 });
  const response = new Response(body, { status, headers });
  const nativeClone = response.clone.bind(response);
  Object.defineProperty(response, 'clone', { value() {
    cloneCalls += 1;
    const clone = nativeClone();
    const cloneBody = clone.body;
    const nativeBodyCancel = cloneBody.cancel.bind(cloneBody);
    Object.defineProperty(cloneBody, 'cancel', { value(...args) {
      cloneBodyCancels += 1;
      return nativeBodyCancel(...args);
    } });
    const nativeGetReader = cloneBody.getReader.bind(cloneBody);
    Object.defineProperty(cloneBody, 'getReader', { value(...args) {
      cloneReaderAcquisitions += 1;
      const reader = nativeGetReader(...args);
      const nativeRead = reader.read.bind(reader);
      Object.defineProperty(reader, 'read', { value(...readArgs) {
        cloneReaderReads += 1;
        return nativeRead(...readArgs);
      } });
      const nativeReaderCancel = reader.cancel.bind(reader);
      Object.defineProperty(reader, 'cancel', { value(...cancelArgs) {
        cloneReaderCancels += 1;
        return nativeReaderCancel(...cancelArgs);
      } });
      return reader;
    } });
    queueMicrotask(() => { clonePullBaseline = pulls; });
    return clone;
  } });
  return {
    response,
    sourceCancellation,
    get pulls() { return pulls; },
    get sourceCancellations() { return sourceCancellations; },
    get cloneCalls() { return cloneCalls; },
    get clonePullBaseline() { return clonePullBaseline; },
    get cloneBodyCancels() { return cloneBodyCancels; },
    get cloneReaderAcquisitions() { return cloneReaderAcquisitions; },
    get cloneReaderReads() { return cloneReaderReads; },
    get cloneReaderCancels() { return cloneReaderCancels; },
  };
}
async function settleWithin(promise, label) {
  let timer;
  try {
    await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle`)), 300);
    })]);
  } finally {
    clearTimeout(timer);
  }
}
function storage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

function harness({ uid = 'a', persistedUid = uid, snapshot = visualSnapshot(uid), ready, fetchImpl, signOutImpl,
  revokeImpl, clearMediaImpl, loadModule = true } = {}) {
  const listeners = [];
  const redirects = [];
  const requests = [];
  const availabilityConfigurations = [];
  const mediaConfigurations = [];
  const mediaInvalidations = [];
  const mediaClearCalls = [];
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
    createElement: () => {
      const listeners = new Map();
      return {
        children: [], attrs: {},
        setAttribute(name, value) { this.attrs[name] = String(value); },
        addEventListener(type, listener) { listeners.set(type, listener); },
        append(...children) { this.children.push(...children); },
        click() { listeners.get('click')?.({ target: this }); },
      };
    },
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
    URL, URLSearchParams, DOMException, TextDecoder, setTimeout, console,
    configureContentsAvailability: options => availabilityConfigurations.push(options),
    onAuthStateChanged: (_auth, callback) => { listeners.push(callback); return () => {}; },
    signOut: async () => { signouts += 1; changeUser(null); await signOutImpl?.(); },
    updateProfile: async () => {},
    revokeEditorialSession: (...args) => revokeImpl ? revokeImpl(...args) : Promise.resolve(), // Transport covered by editorial-entry tests.
    configureContentsMediaSession: options => mediaConfigurations.push(options),
    invalidateContentsMediaSession: options => mediaInvalidations.push(options),
    clearContentsMediaSession: () => { mediaClearCalls.push(true); return clearMediaImpl ? clearMediaImpl() : Promise.resolve(); },
     fetch: async (...args) => {
      requests.push(args);
      return fetchImpl ? fetchImpl(...args) : response(userDoc(auth.currentUser.uid));
    },
  });
  if (contentLengthSource) {
    const parserSource = contentLengthSource.replace(/^export\s+/gmu, '');
    vm.runInContext(`${parserSource}\nglobalThis.parseContentLength = parseContentLength;`, context,
      { filename: 'public/js/content-length.js' });
  }
  vm.runInContext(shellSource, context);
  if (loadModule) {
    const source = authSource.replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
    vm.runInContext(`${source}\nglobalThis.api = { requireAuth, getCurrentUserDoc, getCachedUserSnapshot, authenticatedFetch, fetchAPI, fetchAPIPage, fetchAPIAsset, logout, getContentsIdentity: typeof getContentsIdentity === 'function' ? getContentsIdentity : null, subscribeContentsIdentity: typeof subscribeContentsIdentity === 'function' ? subscribeContentsIdentity : null };`, context);
  }
  return {
    api: context.api, auth, sessionStorage, localStorage, document, main, requests, redirects, location, availabilityConfigurations, context,
    mediaConfigurations, mediaInvalidations, mediaClearCalls,
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

test('contents identity is live-validation-only; visual snapshots cannot validate or reveal navigation', async () => {
  const h = harness();
  assert.equal(typeof h.api.getContentsIdentity, 'function');
  assert.equal(typeof h.api.subscribeContentsIdentity, 'function');
  assert.equal(h.availabilityConfigurations.length, 1);
  assert.equal(h.availabilityConfigurations[0].request, h.api.authenticatedFetch);
  assert.equal(h.api.getContentsIdentity().validated, false);
  h.listeners[0](h.auth.currentUser);
  assert.equal(h.api.getCachedUserSnapshot().uid, 'a', 'the visual snapshot remains available for existing hints');
  assert.equal(h.api.getContentsIdentity().validated, false, 'reading the snapshot must not validate identity');
  assert.equal(JSON.parse(h.sessionStorage.getItem(snapshotKey)).validated, undefined);

  const identities = [];
  h.api.subscribeContentsIdentity(value => identities.push(value));
  const initialGeneration = h.api.getContentsIdentity().generation;
  await h.api.getCurrentUserDoc();
  const validated = h.api.getContentsIdentity();
  assert.deepEqual({ ...validated }, { uid: 'a', generation: initialGeneration, validated: true });
  assert.equal(identities.at(-1).validated, true);
  assert.equal(Object.isFrozen(validated), true);

  h.changeUser('b');
  const changed = h.api.getContentsIdentity();
  assert.equal(changed.uid, 'b');
  assert.equal(changed.validated, false, 'identity changes synchronously clear the validated gate');
  assert.ok(changed.generation > validated.generation);
  assert.equal(identities.at(-1).validated, false);
});

test('media coordinator receives authenticated issue, raw bodyless clear transport and auth-owned revalidation', async () => {
  let holdValidation = false;
  const revalidation = deferred();
  const h = harness({ fetchImpl: (path, options) => {
    if (path === '/api/users/me' && holdValidation) return revalidation.promise;
    return response(userDoc(h?.auth.currentUser.uid || 'a'));
  } });
  assert.equal(h.mediaConfigurations.length, 1);
  const media = h.mediaConfigurations[0];
  assert.equal(media.request, h.api.authenticatedFetch);
  assert.equal(media.clearRequest, h.context.fetch);
  assert.equal(media.getIdentity, h.api.getContentsIdentity);
  await h.api.getCurrentUserDoc();
  assert.equal(h.api.getContentsIdentity().validated, true);
  const before = h.mediaInvalidations.length;
  holdValidation = true;
  media.invalidateIdentity();
  assert.equal(h.api.getContentsIdentity().validated, false, 'remote invalidation is synchronous');
  assert.ok(h.api.getContentsIdentity().generation > 0);
  assert.equal(h.mediaInvalidations.length, before, 'receiving a broadcast does not echo another broadcast');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests.filter(([path]) => path === '/api/users/me').length, 2,
    'the receiving tab starts fresh /users/me identity validation before new media use');
  revalidation.resolve(response(userDoc('a')));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.api.getContentsIdentity().validated, true);
  assert.equal(h.signouts, 0);
});

test('logout clears media and revokes editorial state together; a failed clear retains retry and blocks signOut', async () => {
  const calls = [];
  let clearAttempt = 0;
  let signOuts = 0;
  const failedClear = deferred();
  const h = harness({
    revokeImpl: () => { calls.push('editorial'); return Promise.resolve(); },
    clearMediaImpl: () => { calls.push('media'); return clearAttempt++ === 0 ? failedClear.promise : Promise.resolve(); },
    signOutImpl: async () => { signOuts += 1; },
  });
  const logout = h.api.logout();
  assert.deepEqual(calls, ['editorial', 'media'], 'both revocations start before either is awaited');
  assert.equal(h.api.getContentsIdentity().validated, false);
  failedClear.reject(new Error('private clear detail'));
  await logout;
  assert.equal(signOuts, 0, 'Firebase signOut waits for successful media and editorial clearing');
  assert.match(h.main.children[0].children[0].textContent, /conteúdo foi ocultado/u);
  assert.equal(h.main.children[0].children[1].textContent, 'Tentar encerrar novamente');

  calls.length = 0;
  h.main.children[0].children[1].click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['editorial', 'media']);
  assert.equal(signOuts, 1);
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

test('API errors preserve support reference for JSON and authenticated media without ending a resource-denied session', async () => {
  for (const method of ['fetchAPI', 'fetchAPIPage', 'fetchAPIAsset']) {
    const h = harness({ fetchImpl: () => response({ error: 'Request not allowed.', requestId: 'support-123' }, 403) });
    await assert.rejects(h.api[method]('/api/pos-cards/media'), error => {
      assert.equal(error.status, 403);
      assert.equal(error.requestId, 'support-123');
      return true;
    });
    assert.equal(h.signouts, 0);
    assert.equal(h.redirects.length, 0);
  }
  const h = harness({ fetchImpl: () => response({ error: 'Unavailable' }, 503) });
  await assert.rejects(h.api.fetchAPI('/api/pos-cards/media'), error => error.requestId === undefined);
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

test('remote logout clears visible content immediately and redirects after editorial revocation', async () => {
  const h = harness();
  await h.api.requireAuth();
  h.changeUser(null);
  await new Promise(resolve => setImmediate(resolve));
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

test('authErrorBodyLimit is opt-in, strips before fetch, bounds auth clones, and preserves a nonfatal 403 response', async () => {
  let cancelled = 0;
  let rawOptions;
  const h = harness({ fetchImpl: (_path, options) => {
    rawOptions = options;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(16 * 1024 + 1)); controller.close(); },
      cancel() { cancelled += 1; },
    }, { highWaterMark: 0 }), { status: 403, headers: { 'content-type': 'application/json' } });
  } });
  const response = await h.api.authenticatedFetch('/api/contents/published-policy', { authErrorBodyLimit: 16384 });
  assert.equal(response.status, 403);
  assert.equal(Object.hasOwn(rawOptions, 'authErrorBodyLimit'), false, 'the private option never reaches native fetch');
  assert.equal(h.signouts, 0, 'an oversized unrecognized resource 403 remains nonfatal');
  assert.equal(await response.text().then(text => text.length), 16 * 1024 + 1, 'the original response remains readable to bounded API code');
  assert.equal(cancelled, 0, 'the nonfatal original body is not cancelled behind the caller');
});

test('bounded opt-in auth decode still ends 401 sessions and cancels the unauthorized original body', async () => {
  let cancelled = 0;
  let rawOptions;
  const h = harness({ fetchImpl: (_path, options) => {
    rawOptions = options;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(16 * 1024 + 1)); },
      cancel() { cancelled += 1; },
    }, { highWaterMark: 0 }), { status: 401, headers: { 'content-type': 'application/json' } });
  } });
  await assert.rejects(h.api.authenticatedFetch('/api/contents/published-policy', { authErrorBodyLimit: 16384 }), error => error.status === 401);
  assert.equal(Object.hasOwn(rawOptions, 'authErrorBodyLimit'), false);
  assert.equal(h.signouts, 1, '401 ends the validated session even when its body cannot be parsed');
  assert.equal(cancelled, 1, 'fatal unauthorized bodies are cancelled after session handling');
});

test('opt-in auth Content-Length precheck rejects before clone reads and cancels only the clone tee branch', async () => {
  const invalidLengths = [
    '16385', '', '01', '-1', '+1', '1.5', '1e2', '1, 1', '9007199254740992',
  ];
  for (const contentLength of invalidLengths) {
    const tracked = trackedResponse({ contentLength });
    const h = harness({ fetchImpl: () => tracked.response });
    const result = await h.api.authenticatedFetch('/api/contents/published-policy', {
      authErrorBodyLimit: CONTENTS_AUTH_BODY_LIMIT,
    });
    assert.equal(result.status, 403);
    assert.equal(h.signouts, 0, 'a nonfatal resource 403 keeps the session');
    assert.equal(tracked.cloneCalls, 1, 'the 403 path creates one cloned branch for bounded auth inspection');
    assert.equal(tracked.cloneReaderAcquisitions, 0, 'the clone reader is never acquired for a rejected header');
    assert.equal(tracked.cloneReaderReads, 0, 'the bounded clone performs zero body reads before rejection');
    assert.equal(tracked.cloneBodyCancels, 1, 'the rejected clone branch is cancelled once');
    assert.equal(typeof tracked.clonePullBaseline, 'number', 'the native tee prefetch baseline is recorded');
    assert.equal(tracked.pulls, tracked.clonePullBaseline,
      `Content-Length ${JSON.stringify(contentLength)} causes no additional source pulls beyond native tee setup`);

    // The clone cancellation promise waits for the original tee branch. Cancelling
    // that caller-owned branch must release both branches and the source promptly.
    await settleWithin(result.body.cancel(), `tee cancellation for ${JSON.stringify(contentLength)}`);
    await settleWithin(tracked.sourceCancellation, `source cancellation for ${JSON.stringify(contentLength)}`);
    assert.equal(tracked.pulls, tracked.clonePullBaseline, 'cancelling the two branches does not pull additional bytes');
    assert.equal(tracked.sourceCancellations, 1, 'the tee source is cancelled exactly once after both owners cancel');
  }
});

test('opt-in auth decoder preserves valid, absent and understated-header caller branches', async () => {
  const validBytes = new TextEncoder().encode('{"reason":"resource-denied","error":"private body"}');
  for (const contentLength of [String(validBytes.byteLength), undefined]) {
    const tracked = trackedResponse({ bytes: validBytes, contentLength });
    const h = harness({ fetchImpl: () => tracked.response });
    const result = await h.api.authenticatedFetch('/api/contents/published-policy', {
      authErrorBodyLimit: CONTENTS_AUTH_BODY_LIMIT,
    });
    assert.equal(result.status, 403);
    assert.equal(h.signouts, 0);
    assert.ok(tracked.pulls > tracked.clonePullBaseline, 'valid and absent lengths keep the streaming JSON path');
    assert.ok(tracked.cloneReaderReads > 0);
    assert.equal(tracked.cloneBodyCancels, 0);
    assert.equal(await result.text(), new TextDecoder().decode(validBytes), 'the original response remains readable');
  }

  const oversizedBytes = new Uint8Array(CONTENTS_AUTH_BODY_LIMIT + 1).fill(0x78);
  for (const contentLength of [undefined, '1']) {
    const oversized = trackedResponse({ bytes: oversizedBytes, contentLength });
    const h = harness({ fetchImpl: () => oversized.response });
    const result = await h.api.authenticatedFetch('/api/contents/published-policy', {
      authErrorBodyLimit: CONTENTS_AUTH_BODY_LIMIT,
    });
    assert.equal(result.status, 403);
    assert.equal(h.signouts, 0);
    assert.equal(oversized.cloneReaderReads, 1,
      'the actual-byte cap rejects the first oversized chunk without asking the clone for another read');
    assert.equal(oversized.cloneReaderCancels, 1, 'stream overflow cancels the clone reader once');
    assert.equal(oversized.cloneBodyCancels, 0);
    assert.equal((await result.arrayBuffer()).byteLength, oversizedBytes.byteLength,
      'byte overflow cancels only the auth clone; the caller keeps the complete original body');
  }
});

test('malformed opt-in 401 stays sanitized and normal auth cancels the original tee branch', async () => {
  const tracked = trackedResponse({ status: 401, contentLength: '1, 1' });
  const h = harness({ fetchImpl: () => tracked.response });
  await assert.rejects(h.api.authenticatedFetch('/api/contents/published-policy', {
    authErrorBodyLimit: CONTENTS_AUTH_BODY_LIMIT,
  }), error => {
    assert.equal(error.status, 401);
    assert.doesNotMatch(error.message, /private body/u);
    return true;
  });
  await settleWithin(tracked.sourceCancellation, 'fatal 401 tee cancellation');
  assert.equal(tracked.cloneCalls, 1);
  assert.equal(tracked.cloneReaderAcquisitions, 0);
  assert.equal(tracked.cloneReaderReads, 0);
  assert.equal(tracked.cloneBodyCancels, 1);
  assert.equal(tracked.pulls, tracked.clonePullBaseline,
    'malformed auth JSON causes no extra pulls beyond the native tee prefetch');
  assert.equal(tracked.sourceCancellations, 1, 'existing auth semantics cancel the original branch exactly once');
  assert.equal(h.signouts, 1);
});
