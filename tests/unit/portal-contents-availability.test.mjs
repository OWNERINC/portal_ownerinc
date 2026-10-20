import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const availabilitySource = await readFile(new URL('../../public/js/portal-contents/availability.js', import.meta.url), 'utf8')
  .catch(() => null);
const generatedPages = [
  'dashboard', 'knowledge', 'reminders', 'academy', 'benefits', 'announcements', 'news-preview',
  'editorial-entry', 'profile', 'admin', 'cms', 'autocard', 'cards-pos', 'solides', 'contents',
];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function classList(initial = '') {
  const values = new Set(initial.split(/\s+/u).filter(Boolean));
  return {
    add(...tokens) { tokens.forEach(token => values.add(token)); },
    remove(...tokens) { tokens.forEach(token => values.delete(token)); },
    contains(token) { return values.has(token); },
    toggle(token, force) {
      const next = force === undefined ? !values.has(token) : force;
      if (next) values.add(token); else values.delete(token);
      return next;
    },
  };
}

class FakeNode extends EventTarget {
  constructor(document, tagName, options = {}) {
    super();
    this.ownerDocument = document;
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.hidden = options.hidden === true;
    this.disabled = options.disabled === true;
    this.inert = options.inert === true;
    this.tabIndex = options.tabIndex ?? 0;
    this.classList = classList(options.className || '');
    this.isConnected = true;
    this.id = options.id || '';
    this.focusCount = 0;
    if (options.href) this.setAttribute('href', options.href);
    if (options.ariaHidden) this.setAttribute('aria-hidden', 'true');
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) if (current === this) return true;
    return false;
  }

  closest(selector) {
    for (let current = this; current; current = current.parentNode) {
      if (selector.startsWith('.') && current.classList.contains(selector.slice(1))) return current;
      if (selector.startsWith('#') && current.id === selector.slice(1)) return current;
      if (selector === '[hidden], .hidden, [aria-hidden="true"], [inert]'
        && (current.hidden || current.classList.contains('hidden') || current.getAttribute('aria-hidden') === 'true' || current.inert)) return current;
    }
    return null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'hidden') this.hidden = true;
    if (name === 'inert') this.inert = true;
    if (name === 'tabindex') this.tabIndex = Number(value);
  }

  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === 'hidden') this.hidden = false;
    if (name === 'inert') this.inert = false;
  }

  focus() {
    for (let current = this; current; current = current.parentNode) {
      if (current.hidden || current.inert || current.disabled || current.classList.contains('hidden')
        || current.getAttribute('aria-hidden') === 'true') return;
    }
    this.focusCount += 1;
    this.ownerDocument.activeElement = this;
  }
}

function makeHarness() {
  if (!availabilitySource) assert.fail('availability gate module is missing, not a VM/import syntax failure');
  const document = new EventTarget();
  document.registrations = new Map();
  const addDocumentListener = document.addEventListener.bind(document);
  document.addEventListener = (type, listener, options) => {
    document.registrations.set(type, (document.registrations.get(type) || 0) + 1);
    return addDocumentListener(type, listener, options);
  };
  document.hidden = false;
  document.visibilityState = 'visible';
  document.body = new FakeNode(document, 'body');
  document.activeElement = document.body;
  const sidebar = new FakeNode(document, 'aside', { className: 'sidebar' });
  const link = new FakeNode(document, 'li', { className: 'contents-link', hidden: true });
  const anchor = new FakeNode(document, 'a', { href: './contents.html' });
  link.append(anchor);
  sidebar.append(link);
  const mobileToggle = new FakeNode(document, 'button', { className: 'mobile-menu-toggle' });
  const main = new FakeNode(document, 'main');
  const heading = new FakeNode(document, 'h1');
  main.append(heading);
  document.body.append(sidebar, mobileToggle, main);
  document.querySelector = selector => ({
    '.contents-link': link,
    '.mobile-menu-toggle': mobileToggle,
    '.sidebar': sidebar,
    'main h1': heading,
  }[selector] || null);

  const current = { uid: null, generation: 0, validated: false };
  const listeners = new Set();
  const requests = [];
  const identity = next => {
    Object.assign(current, next);
    for (const listener of listeners) listener(Object.freeze({ ...current }));
  };
  const request = (path, options) => {
    const pending = deferred();
    requests.push({ path, options, ...pending });
    return pending.promise;
  };
  const window = new EventTarget();
  window.registrations = new Map();
  const addWindowListener = window.addEventListener.bind(window);
  window.addEventListener = (type, listener, options) => {
    window.registrations.set(type, (window.registrations.get(type) || 0) + 1);
    return addWindowListener(type, listener, options);
  };
  const context = vm.createContext({
    document, window, AbortController, DOMException, TextDecoder, TextEncoder,
    ArrayBuffer, Uint8Array, ReadableStream, Response, JSON, Object, Promise, Error, TypeError,
  });
  const apiSource = availabilitySource.replace(/^export /gmu, '')
    + '\nglobalThis.contentsGate = { configureContentsAvailability, probeContentsAvailability, resetContentsAvailability, get state() { return state; } };';
  vm.runInContext(apiSource, context, { filename: 'availability.js' });
  const gate = context.contentsGate;
  const subscribeIdentity = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const options = { request, getIdentity: () => Object.freeze({ ...current }), subscribeIdentity, document, window };
  gate.configureContentsAvailability(options);
  return { gate, identity, requests, link, anchor, heading, mobileToggle, document, window, sidebar, listeners, options,
    dispatch(target, name) { target.dispatchEvent(new Event(name)); } };
}

async function drain() {
  await new Promise(resolve => setImmediate(resolve));
  await Promise.resolve();
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

test('availability gate exports only the expected integration entry points', () => {
  assert.ok(availabilitySource, 'the persistent availability module must exist');
  const harness = makeHarness();
  assert.equal(typeof harness.gate.probeContentsAvailability, 'function');
  assert.equal(typeof harness.gate.resetContentsAvailability, 'function');
  assert.equal(harness.document.registrations.get('portal:navigated'), 1);
  assert.equal(harness.document.registrations.get('visibilitychange'), 1);
  assert.equal(harness.window.registrations.get('online'), 1);
  harness.gate.configureContentsAvailability(harness.options);
  assert.equal(harness.document.registrations.get('portal:navigated'), 1, 'repeat configuration does not add a listener');
  assert.equal(harness.listeners.size, 1, 'repeat configuration does not resubscribe identity');
});

test('identity changes hide synchronously and fence late successful or failed probes', async () => {
  for (const settleLate of [
    request => request.resolve(jsonResponse({ available: true })),
    request => request.reject(new TypeError('late offline failure')),
  ]) {
    const harness = makeHarness();
    harness.identity({ uid: 'a', generation: 1, validated: true });
    assert.equal(harness.link.hidden, true, 'checking never leaves a cached visible link');
    assert.equal(harness.gate.state, 'checking');
    const first = harness.requests[0];
    assert.ok(first.options.signal instanceof AbortSignal);
    harness.identity({ uid: 'b', generation: 2, validated: false });
    assert.equal(first.options.signal.aborted, true);
    assert.equal(harness.link.hidden, true);
    assert.equal(harness.requests.length, 1, 'unvalidated identities do not launch probes');
    settleLate(first);
    await drain();
    assert.equal(harness.link.hidden, true, 'late work from an unvalidated former identity cannot reveal');

    harness.identity({ uid: 'b', generation: 2, validated: true });
    const current = harness.requests.at(-1);
    assert.equal(current.path, '/api/contents/availability');
    assert.equal(current.options.credentials, 'same-origin');
    assert.equal(current.options.cache, 'no-store');
    current.resolve(jsonResponse({ available: true }));
    await drain();
    assert.equal(harness.gate.state, 'available');
    assert.equal(harness.link.hidden, false);
  }
});

test('only one exact boolean availability key reveals; malformed, empty, denied and unavailable stay hidden', async () => {
  const invalidValues = [true, 1, [], { available: true, count: 1 }, { available: 'true' }, {}, null];
  for (const value of invalidValues) {
    const harness = makeHarness();
    harness.identity({ uid: 'a', generation: 1, validated: true });
    harness.requests[0].resolve(jsonResponse(value));
    await drain();
    assert.equal(harness.gate.state, 'unavailable');
    assert.equal(harness.link.hidden, true, `reject malformed availability payload ${JSON.stringify(value)}`);
  }

  for (const [status, expected] of [[401, 'denied'], [403, 'denied'], [503, 'unavailable']]) {
    const harness = makeHarness();
    harness.identity({ uid: 'a', generation: 1, validated: true });
    harness.requests[0].resolve(jsonResponse({ error: 'ignored' }, status));
    await drain();
    assert.equal(harness.gate.state, expected);
    assert.equal(harness.link.hidden, true, `${expected} status remains hidden`);
  }

  const empty = makeHarness();
  empty.identity({ uid: 'a', generation: 1, validated: true });
  empty.requests[0].resolve(jsonResponse({ available: false }));
  await drain();
  assert.equal(empty.gate.state, 'empty');
  assert.equal(empty.link.hidden, true, 'empty catalogue is not shown');
});

test('navigation, visibility and online triggers coalesce and recover only on demand', async () => {
  const harness = makeHarness();
  harness.identity({ uid: 'a', generation: 1, validated: true });
  assert.equal(harness.gate.state, 'checking');
  harness.dispatch(harness.document, 'portal:navigated');
  harness.dispatch(harness.window, 'online');
  harness.dispatch(harness.document, 'visibilitychange');
  await drain();
  assert.equal(harness.requests.length, 1, 'in-flight probes are coalesced');
  harness.requests[0].resolve(jsonResponse({ available: false }));
  await drain();
  assert.equal(harness.gate.state, 'empty');
  assert.equal(harness.link.hidden, true);

  harness.dispatch(harness.document, 'visibilitychange');
  assert.equal(harness.requests.length, 2, 'visible event permits recovery');
  harness.requests[1].reject(new TypeError('offline again'));
  await drain();
  assert.equal(harness.gate.state, 'unavailable');
  harness.dispatch(harness.window, 'online');
  assert.equal(harness.requests.length, 3, 'online event permits recovery');
  harness.requests[2].resolve(jsonResponse({ available: true }));
  await drain();
  assert.equal(harness.gate.state, 'available');
  assert.equal(harness.link.hidden, false);
  harness.document.hidden = true;
  harness.document.visibilityState = 'hidden';
  harness.dispatch(harness.document, 'visibilitychange');
  await drain();
  assert.equal(harness.requests.length, 3, 'hidden documents do not probe in the background');
  assert.doesNotMatch(availabilitySource, /setInterval|setTimeout/u, 'the gate does not poll');
});

test('reset aborts and hides synchronously; hiding a focused link falls back to visible content or drawer control', () => {
  const content = makeHarness();
  content.identity({ uid: 'a', generation: 1, validated: true });
  content.requests[0].resolve(jsonResponse({ available: true }));
  return drain().then(() => {
    content.anchor.focus();
    content.gate.resetContentsAvailability();
    assert.equal(content.link.hidden, true);
    assert.equal(content.gate.state, 'unknown');
    assert.equal(content.document.activeElement, content.heading);
    assert.equal(content.heading.getAttribute('tabindex'), '-1');
    content.heading.dispatchEvent(new Event('blur'));
    assert.equal(content.heading.getAttribute('tabindex'), null, 'fallback tabindex is temporary');

    const mobile = makeHarness();
    mobile.identity({ uid: 'a', generation: 1, validated: true });
    mobile.requests[0].resolve(jsonResponse({ available: true }));
    return drain().then(() => {
      mobile.document.body.classList.add('sidebar-open');
      mobile.anchor.focus();
      mobile.gate.resetContentsAvailability();
      assert.equal(mobile.link.hidden, true);
      assert.equal(mobile.document.activeElement, mobile.mobileToggle);
    });
  });
});

test('local reset generation fences same-identity late success and permits explicit recovery', async () => {
  const harness = makeHarness();
  harness.identity({ uid: 'a', generation: 1, validated: true });
  const stale = harness.requests[0];
  harness.gate.resetContentsAvailability();
  assert.equal(stale.options.signal.aborted, true);
  assert.equal(harness.link.hidden, true);
  stale.resolve(jsonResponse({ available: true }));
  await drain();
  assert.equal(harness.gate.state, 'unknown');
  assert.equal(harness.link.hidden, true);
  void harness.gate.probeContentsAvailability();
  await drain();
  assert.equal(harness.requests.length, 2);
  harness.requests[1].resolve(jsonResponse({ available: true }));
  await drain();
  assert.equal(harness.link.hidden, false);
});

test('oversized response body is cancelled at the 1024-byte limit and fails closed', async () => {
  const harness = makeHarness();
  harness.identity({ uid: 'a', generation: 1, validated: true });
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(1025)); },
    cancel() { cancelled = true; },
  });
  harness.requests[0].resolve({ status: 200, ok: true, body });
  await drain();
  await drain();
  assert.equal(harness.gate.state, 'unavailable');
  assert.equal(cancelled, true);
  assert.equal(harness.link.hidden, true);
});

test('all generated shells contain one hidden navigation gate after Owner News and before Profile', async () => {
  const documents = await Promise.all(generatedPages.map(async page => [page,
    await readFile(new URL(`../../public/${page}.html`, import.meta.url), 'utf8')
      .catch(() => null)]));
  for (const [page, html] of documents) {
    assert.ok(html, `${page}.html must exist before generator registration`);
    const items = [...html.matchAll(/<li\b[^>]*>[\s\S]*?<\/li>/gu)].map(match => match[0]);
    const contents = items.filter(item => /href="\.\/contents\.html"/u.test(item));
    assert.equal(contents.length, 1, `${page}.html has one contents link`);
    assert.match(contents[0], /class="contents-link"/u);
    assert.match(contents[0], /\shidden(?:\s|>)/u, `${page}.html starts with availability hidden`);
    assert.ok(html.indexOf('href="./announcements.html"') < html.indexOf('href="./contents.html"'));
    assert.ok(html.indexOf('href="./contents.html"') < html.indexOf('href="./profile.html"'));
    assert.equal(/href="\.\/contents\.html"[^>]*class="active"/u.test(contents[0]), page === 'contents');
  }

  const shell = documents.find(([page]) => page === 'contents')[1];
  assert.match(shell, /<title>Conteúdos — Portal Ownerinc<\/title>/u);
  assert.match(shell, /<body class="contents-page">/u);
  assert.match(shell, /<main class="page-body" id="main-content"[^>]*>/u);
  assert.match(shell, /<section id="contents-root" class="portal-contents" aria-label="Conteúdos">/u);
  assert.match(shell, /<h1 id="contents-title" tabindex="-1">Conteúdos<\/h1>/u);
  assert.match(shell, /<p id="contents-status" role="status" aria-live="polite">Carregando conteúdos…<\/p>/u);
  assert.match(shell, /<script type="module" src="\.\/js\/router-bootstrap\.js"><\/script>/u);
  assert.doesNotMatch(shell, /knowledge\.css|modal-article|articles-list|article-view/u);
});
