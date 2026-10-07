import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../../public/js/editorial-session-watch.js', import.meta.url), 'utf8');
const authSource = await readFile(new URL('../../public/js/auth.js', import.meta.url), 'utf8');
const strip = source => source.replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
const drain = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function harness({ ready = Promise.resolve() } = {}) {
  const callbacks = new Set(), states = [], timers = new Map(), requests = [], redirects = [], signs = [];
  const document = new EventTarget(), window = new EventTarget();
  const main = { children: ['private'], replaceChildren(...nodes) { this.children = nodes; } };
  Object.assign(document, { visibilityState: 'visible', documentElement: { dataset: {} }, querySelector: () => main,
    createElement: () => ({ children: [], listeners: {}, setAttribute() {}, append(...nodes) { this.children.push(...nodes); }, addEventListener(type, fn) { this.listeners[type] = fn; } }) });
  window.location = { href: 'https://portal.test/cms.html', replace: url => redirects.push(url) };
  const auth = { currentUser: { uid: 'a' }, authStateReady: () => ready };
  const h = { now: Date.now(), response: () => Response.json({ uid: 'a', expiresAt: new Date(h.now + 7200000).toISOString() }),
    change(uid) { auth.currentUser = uid ? { uid } : null; callbacks.forEach(fn => fn()); }, callbacks, states, timers, requests, redirects, signs, document, window, main, auth };
  const context = vm.createContext({ auth, document, window, URL, URLSearchParams, AbortController, DOMException,
    Date: class extends Date { static now() { return h.now; } },
    onAuthStateChanged: (_, fn) => { callbacks.add(fn); return () => callbacks.delete(fn); },
    fetch: (...args) => { requests.push(args); return Promise.resolve().then(() => h.response(...args)); },
    setTimeout: (fn, ms) => { const id = timers.size + 1; timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id),
    sessionStorage: { getItem() { return null; }, removeItem() {} }, signOut: async () => { signs.push(auth.currentUser?.uid); h.change(null); } });
  vm.runInContext(`${strip(source)}\nglobalThis.watch = watchEditorialSession;`, context);
  h.start = () => context.watch({ onState: state => states.push(state) });
  h.loadAuth = () => { vm.runInContext(`${strip(authSource)}\nglobalThis.logout = logout;`, context); return context.logout; };
  return h;
}
test('watch waits for initial Firebase readiness, checks exact UID/fixed expiry and cleans listeners/timers', async () => {
  const ready = deferred(), h = harness({ ready: ready.promise }), watch = h.start();
  await drain(); assert.equal(h.requests.length, 0);
  ready.resolve(); await drain(); assert.equal(h.states.at(-1).status, 'ready'); assert.equal(h.timers.size, 1);
  h.response = () => Response.json({ reason: 'editorial_permission_denied' }, { status: 403 });
  h.window.dispatchEvent(new Event('focus')); await drain(); assert.equal(h.states.at(-1).status, 'denied');
  watch.stop(); assert.equal(h.callbacks.size, 0); assert.equal(h.timers.size, 0);
  const count = h.requests.length; h.window.dispatchEvent(new Event('focus')); await drain(); assert.equal(h.requests.length, count);
});
test('watch account switch/cross-tab logout revokes; network failures stay honest and retryable without Firebase signOut', async () => {
  for (const uid of ['b', null]) {
    const h = harness(), watch = h.start(); await drain();
    h.response = () => { throw new Error('offline'); }; h.change(uid); await drain();
    assert.equal(h.states.at(-1).status, 'error'); assert.equal(h.requests.at(-1)[1].method, 'DELETE'); assert.deepEqual(h.signs, []);
    h.response = () => new Response(null, { status: 204 }); await watch.revalidate();
    assert.equal(h.states.at(-1).status, 'denied'); watch.stop();
  }
});
test('known UID changes and fixed expiry hide content before a pending network response', async () => {
  for (const change of ['uid', 'expiry']) {
    const h = harness(), watch = h.start(); await drain(); assert.equal(h.states.at(-1).status, 'ready');
    const pending = deferred(); h.response = () => pending.promise;
    if (change === 'uid') h.change('b');
    else { h.now += 7200000; void watch.revalidate(); }
    assert.equal(h.states.at(-1).status, 'denied', change);
    await drain(); assert.equal(h.states.at(-1).status, 'denied', 'pending transport must not reveal content');
    pending.resolve(new Response(null, { status: change === 'uid' ? 204 : 401 })); await drain();
    assert.equal(h.states.at(-1).status, 'denied'); watch.stop(); assert.equal(h.timers.size, 0);
  }
});
test('logout never signs out a new UID while DELETE settles, and failed DELETE exposes retry not success', async () => {
  const pending = deferred(), h = harness(); h.response = () => pending.promise;
  const logout = h.loadAuth(), exit = logout(); h.change('b'); pending.resolve(new Response(null, { status: 204 })); await exit;
  assert.deepEqual(h.signs, []); assert.equal(h.window.location.href, 'https://portal.test/cms.html');
  const failed = harness(); failed.response = () => Response.json({}, { status: 503 }); await failed.loadAuth()();
  assert.deepEqual(failed.signs, []); assert.match(failed.main.children[0].children[0].textContent, /Não foi possível confirmar/);
  const retry = failed.main.children[0].children[1]; failed.change('b'); failed.response = () => new Response(null, { status: 204 }); retry.listeners.click(); await drain();
  assert.deepEqual(failed.signs, []);
});
test('entry only navigates after same-account session ACK', async () => {
  const text = await readFile(new URL('../../public/js/editorial-entry.js', import.meta.url), 'utf8');
  const nodes = { 'editorial-enter': {}, 'editorial-entry-status': {} }, assigned = [], pending = deferred(); let click, guard;
  const auth = { currentUser: { uid: 'a' } };
  const context = vm.createContext({ document: { getElementById: id => nodes[id] }, auth, window: { location: { assign: url => assigned.push(url) } },
    waitForEditorialRevocation: async () => {}, authenticatedFetch: async (path, options) => { assert.equal(path, '/api/cms/session'); assert.equal(options.body, '{}'); return pending.promise; } });
  vm.runInContext(`${strip(text)}\nglobalThis.mountEntry = mount;`, context);
  context.mountEntry({ user: { uid: 'a' }, active: true, beforeLeave: fn => { guard = fn; }, listen: (_, __, fn) => { click = fn; } });
  click(); await drain(); assert.equal(guard(), false); assert.deepEqual(assigned, []);
  auth.currentUser = { uid: 'b' }; pending.resolve(Response.json({ uid: 'a' }, { status: 201 })); await drain(); assert.deepEqual(assigned, []);
});

test('BFCache lifecycle hides before suspension, ignores late validation and revalidates on restoration', async () => {
  const h = harness(), watch = h.start(); await drain();
  const late = deferred(); h.response = () => late.promise; void watch.revalidate(); await drain();
  h.window.dispatchEvent(new Event('pagehide'));
  assert.equal(h.states.at(-1).status, 'denied');
  late.resolve(Response.json({ uid: 'a', expiresAt: new Date(h.now + 7200000).toISOString() })); await drain();
  assert.equal(h.states.at(-1).status, 'denied', 'late ACK cannot reveal cached content');
  const count = h.requests.length; h.window.dispatchEvent(new Event('focus')); await drain(); assert.equal(h.requests.length, count);
  h.response = () => Response.json({}, { status: 401 });
  const restored = Object.assign(new Event('pageshow'), { persisted: true }); h.window.dispatchEvent(restored); await drain();
  assert.equal(h.requests.length, count + 1); assert.equal(h.states.at(-1).status, 'denied');
  watch.stop(); const stoppedCount = h.requests.length;
  h.window.dispatchEvent(restored); await drain(); assert.equal(h.requests.length, stoppedCount); assert.equal(h.timers.size, 0);
});
