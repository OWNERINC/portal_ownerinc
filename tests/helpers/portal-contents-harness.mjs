import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { FixtureNode, parseInto, TestEvent } from './frontend-feedback-harness.mjs';
import { deferred, drain } from './router-harness.mjs';
import { pageFixture } from './portal-contents-fixtures.mjs';

const moduleFiles = [
  ['dto', 'public/js/portal-contents/dto.js', 'validatePortalPageDTO, validateDetail, validateList, validateCategories, isCanonicalSlug, PAGE_SIZE, MAX_OFFSET, MAX_TOTAL, MAX_BLOCKS, MAX_NODES, MAX_CONTENT_BYTES, MAX_DETAIL_BYTES, MAX_COLLECTION_BYTES, LAYOUTS'],
  ['mediaSession', 'public/js/portal-contents/media-session.js', 'configureContentsMediaSession, acquireContentsMediaLease, clearContentsMediaSession, invalidateContentsMediaSession, assetURL'],
  ['richText', 'public/js/portal-contents/rich-text.js', 'renderRichText'],
  ['contentLength', 'public/js/content-length.js', 'parseContentLength'],
  ['api', 'public/js/portal-contents/api.js', 'readBoundedJSON, createContentsAPI, contentsErrorMessage'],
  ['catalog', 'public/js/portal-contents/catalog.js', 'renderCatalog, renderCategories'],
  ['reader', 'public/js/portal-contents/reader.js', 'renderReader'],
  ['gallery', 'public/js/portal-contents/gallery.js', 'createContentsGallery'],
  ['media', 'public/js/portal-contents/media.js', 'activateContentsMedia'],
  ['index', 'public/js/portal-contents/index.js', 'parseContentsLocation, mount'],
];

export function createContentsClock(start = 1_900_000_000_000) {
  let current = start;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => current,
    setTimeout(fn, delay = 0) {
      const id = ++nextId;
      timers.set(id, { id, at: current + Math.max(0, Number(delay) || 0), fn });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = current + ms;
      for (;;) {
        const next = [...timers.values()].filter(timer => timer.at <= end)
          .sort((left, right) => left.at - right.at || left.id - right.id)[0];
        if (!next) break;
        timers.delete(next.id);
        current = next.at;
        next.fn();
        await drain();
      }
      current = end;
      await drain();
    },
    get pending() { return [...timers.values()].sort((a, b) => a.at - b.at); },
  };
}

export function createContentsBroadcastBus() {
  const channels = new Map();
  const storageListeners = new Set();
  const messages = [];
  const storageEvents = [];
  return {
    messages,
    storageEvents,
    createChannel(name) {
      const channel = { name, onmessage: null, listeners: new Set(), closed: false,
        addEventListener(type, listener) { if (type === 'message') this.listeners.add(listener); },
        removeEventListener(type, listener) { if (type === 'message') this.listeners.delete(listener); },
        postMessage(data) {
          messages.push(data);
          for (const peer of channels.get(name) || []) {
            if (peer === this || peer.closed) continue;
            const event = { data };
            peer.onmessage?.(event);
            for (const listener of peer.listeners) listener(event);
          }
        },
        close() { this.closed = true; channels.get(name)?.delete(this); },
      };
      if (!channels.has(name)) channels.set(name, new Set());
      channels.get(name).add(channel);
      return channel;
    },
    storage: {
      subscribe(listener) { storageListeners.add(listener); return () => storageListeners.delete(listener); },
      emit(event) { storageEvents.push({ key: event.key, newValue: event.newValue }); for (const listener of storageListeners) listener(event); },
    },
  };
}

function responseFor(path) {
  if (path === '/api/contents/categories') return Response.json([]);
  if (path.startsWith('/api/contents/?')) return new Response('[]', { headers: { 'X-Total-Count': '0' } });
  if (path.startsWith('/api/contents/')) return Response.json(pageFixture({ content_blocks: [] }));
  return Response.json({});
}

export async function createContentsHarness({ url = '/contents.html', request, identity, clock,
  broadcastBus = createContentsBroadcastBus(), broadcastChannel = true, storageAvailable = true,
  mount = false } = {}) {
  const markup = await readFile('public/contents.html', 'utf8');
  const document = new FixtureNode('document');
  document.ownerDocument = document;
  document.createElement = tag => new FixtureNode(tag, document);
  document.createElementNS = (_namespace, tag) => document.createElement(tag);
  document.createTextNode = text => { const node = document.createElement('#text'); node.textContent = text; return node; };
  document.createDocumentFragment = () => document.createElement('#fragment');
  document.getElementById = id => document.querySelector(`#${id}`);
  document.downloads = [];
  parseInto(document, markup);
  document.documentElement = document.querySelector('html');
  document.body = document.querySelector('body');
  document.activeElement = document.body;
  document.title = /<title>([^<]*)<\/title>/u.exec(markup)?.[1] || '';

  const window = new FixtureNode('window', document);
  window.innerWidth = 1280;
  window.scrollX = 0;
  window.scrollY = 0;
  window.scrollTo = (x, y) => { window.scrollX = x; window.scrollY = y; };
  document.documentElement.clientWidth = 1264;
  if (broadcastChannel) window.BroadcastChannel = class {
    constructor(name) { this.channel = broadcastBus.createChannel(name); }
    set onmessage(value) { this.channel.onmessage = value; }
    get onmessage() { return this.channel.onmessage; }
    addEventListener(type, listener) { this.channel.addEventListener(type, listener); }
    removeEventListener(type, listener) { this.channel.removeEventListener(type, listener); }
    postMessage(value) { this.channel.postMessage(value); }
    close() { this.channel.close(); }
  };
  if (storageAvailable) {
    const values = new Map();
    window.localStorage = {
      setItem(key, value) {
        values.set(key, String(value));
        broadcastBus.storage.emit({ key, newValue: String(value), storageArea: window.localStorage });
      },
      removeItem(key) {
        values.delete(key);
        broadcastBus.storage.emit({ key, newValue: null, storageArea: window.localStorage });
      },
    };
    broadcastBus.storage.subscribe(event => {
      if (event.storageArea !== window.localStorage) window.dispatchEvent(new TestEvent('storage', event));
    });
  }
  let currentURL = new URL(url, 'https://portal.test');
  const entries = [{ url: currentURL.href, state: { portalNavigation: 1 } }];
  let cursor = 0;
  const location = {};
  for (const key of ['href', 'origin', 'pathname', 'search', 'hash']) {
    Object.defineProperty(location, key, { get: () => currentURL[key] });
  }
  const history = {
    get state() { return entries[cursor].state; },
    get length() { return entries.length; },
    pushState(state, _title, href) {
      currentURL = new URL(href, currentURL);
      entries.splice(++cursor);
      entries.push({ url: currentURL.href, state });
    },
    replaceState(state, _title, href) {
      currentURL = new URL(href, currentURL);
      entries[cursor] = { url: currentURL.href, state };
    },
    back() { this.go(-1); },
    forward() { this.go(1); },
    go(delta) {
      const next = cursor + delta;
      if (next < 0 || next >= entries.length) return;
      cursor = next;
      currentURL = new URL(entries[cursor].url);
      window.dispatchEvent(new TestEvent('popstate', { state: entries[cursor].state }));
    },
  };
  Object.assign(window, { history, location, scrollX: 0, scrollY: 0, scrollTo(x, y) { this.scrollX = x; this.scrollY = y; } });

  let currentIdentity = typeof identity === 'function' ? identity() : identity || { uid: 'user-a', generation: 1, validated: true };
  const identityListeners = new Set();
  const getContentsIdentity = () => currentIdentity;
  const subscribeContentsIdentity = listener => { identityListeners.add(listener); return () => identityListeners.delete(listener); };
  const requests = [];
  const authenticatedFetch = (path, options = {}) => {
    const entry = { path, options, ...deferred() };
    requests.push(entry);
    if (request) return request(path, options, entry);
    return Promise.resolve(responseFor(path));
  };
  const activeClock = clock || createContentsClock();
  const context = vm.createContext({
    document, window, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, DOMException,
    Response, ReadableStream, Uint8Array, console, Event: TestEvent, CustomEvent: TestEvent,
    BroadcastChannel: window.BroadcastChannel || null,
    setTimeout: activeClock.setTimeout.bind(activeClock),
    clearTimeout: activeClock.clearTimeout.bind(activeClock),
    getComputedStyle: () => ({ paddingInlineEnd: '0px' }),
    authenticatedFetch, getContentsIdentity, subscribeContentsIdentity,
  });

  const lifecycleSource = (await readFile('public/js/page-lifecycle.js', 'utf8')).replace(/^export\s+/gmu, '');
  vm.runInContext(`(() => { ${lifecycleSource}\n globalThis.createPageLifecycle = createPageLifecycle; })();`, context, { filename: 'page-lifecycle.js' });
  const modules = {};
  for (const [name, path, exports] of moduleFiles) {
    let source = await readFile(path, 'utf8');
    source = source.replace(/^import[^\n]*\n/gmu, '').replace(/^export\s+/gmu, '');
    vm.runInContext(`(() => { ${source}\n globalThis.__contentsModules = globalThis.__contentsModules || {}; globalThis.__contentsModules.${name} = { ${exports} }; Object.assign(globalThis, globalThis.__contentsModules.${name}); })();`,
      context, { filename: path });
    modules[name] = context.__contentsModules[name];
  }
  const pendingIssues = [];
  const pendingClears = [];
  const mediaRequest = (path, options = {}) => {
    const entry = { path, options, ...deferred() };
    (options.method === 'DELETE' ? pendingClears : pendingIssues).push(entry);
    if (options.signal && !entry.ignoreAbort) {
      options.signal.addEventListener('abort', () => {
        if (entry.ignoreAbort) return;
        entry.reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    }
    return entry.promise;
  };
  const mediaSession = modules.mediaSession;
  mediaSession.configureContentsMediaSession({
    request: mediaRequest,
    clearRequest: mediaRequest,
    getIdentity: getContentsIdentity,
    subscribeIdentity: subscribeContentsIdentity,
    invalidateIdentity: () => notifyIdentity({ uid: currentIdentity?.uid || null,
      generation: (currentIdentity?.generation || 0) + 1, validated: false }),
    window,
    document,
    now: activeClock.now.bind(activeClock),
    setTimer: activeClock.setTimeout.bind(activeClock),
    clearTimer: activeClock.clearTimeout.bind(activeClock),
  });
  const modulesUiSource = (await readFile('public/js/ui.js', 'utf8')).replace(/^export\s+/gmu, '');
  vm.runInContext(`${modulesUiSource}\nglobalThis.__contentsModules.ui = { registerPageDialog, closePageDialogs };`, context,
    { filename: 'public/js/ui.js' });
  modules.ui = context.__contentsModules.ui;
  const page = context.createPageLifecycle({ user: { uid: currentIdentity?.uid }, history });
  page.location = location;
  page.history = history;
  function notifyIdentity(next) {
    currentIdentity = next;
    for (const listener of [...identityListeners]) listener(next);
  }
  function visibility(hidden) {
    document.hidden = Boolean(hidden);
    document.visibilityState = hidden ? 'hidden' : 'visible';
    document.dispatchEvent(new TestEvent('visibilitychange'));
  }
  function mountPage() { modules.index.mount(page); }
  function dispose() { page.dispose(); }
  if (mount) mountPage();
  return { document, window, page, modules, mount: mountPage, dispose, requests, entries, history, location,
    pendingIssues, pendingClears, mediaRequest, clock: activeClock, advance: activeClock.advance.bind(activeClock), visibility,
    get identity() { return currentIdentity; }, notifyIdentity,
    async ready() { await page.ready(); },
    async popstate(next) {
      history.pushState(history.state, '', next);
      window.dispatchEvent(new TestEvent('popstate', { state: history.state }));
      await page.ready();
    },
  };
}
