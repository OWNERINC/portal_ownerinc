import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
export const drain = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

export class TestEvent {
  constructor(type, values = {}) { Object.assign(this, { type, button: 0, defaultPrevented: false }, values); }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.propagationStopped = true; }
  stopImmediatePropagation() { this.stopped = true; }
}

function styleDeclaration() {
  const values = new Map();
  const camelCase = property => property.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
  return {
    setProperty(property, value, priority = '') {
      values.set(property, { value: String(value), priority: String(priority) });
      this[camelCase(property)] = String(value);
    },
    getPropertyValue(property) { return values.get(property)?.value || this[camelCase(property)] || ''; },
    getPropertyPriority(property) { return values.get(property)?.priority || ''; },
    removeProperty(property) {
      const previous = this.getPropertyValue(property);
      values.delete(property);
      delete this[camelCase(property)];
      return previous;
    },
  };
}

class Events {
  listeners = new Map();
  addEventListener(type, fn, options = {}) {
    const list = this.listeners.get(type) || [];
    const entry = { fn, once: options.once, capture: options === true || options.capture };
    list.push(entry); this.listeners.set(type, list);
    options.signal?.addEventListener('abort', () => this.removeEventListener(type, fn), { once: true });
  }
  removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(entry => entry.fn !== fn)); }
  dispatchEvent(event) {
    event.target ||= this;
    for (const entry of [...(this.listeners.get(event.type) || [])].sort((a, b) => Number(b.capture) - Number(a.capture))) {
      if (event.stopped) break;
      if (!(this.listeners.get(event.type) || []).includes(entry)) continue;
      if (entry.once) this.removeEventListener(event.type, entry.fn);
      entry.fn(event);
    }
    return !event.defaultPrevented;
  }
}

export class Node extends Events {
  constructor(tag, owner, attrs = {}) {
    super(); this.tagName = tag.toUpperCase(); this.ownerDocument = owner;
    this.children = []; this.dataset = {}; this.attrs = {}; this.className = ''; this.style = styleDeclaration();
    if (this.tagName === 'DIALOG') this.open = false;
    Object.entries(attrs).forEach(([key, value]) => this.setAttribute(key, value));
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, on) => { if (on ?? !this.classList.contains(name)) this.classList.add(name); else this.classList.remove(name); },
      [Symbol.iterator]: () => this.className.split(/\s+/).filter(Boolean)[Symbol.iterator](),
    };
  }
  get childNodes() { return this.children; }
  get nodeType() { return this.tagName === '#TEXT' ? 3 : this.tagName === '#FRAGMENT' ? 11 : 1; }
  get textContent() { return (this._text || '') + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get isConnected() { return this === this.ownerDocument?.documentElement || Boolean(this.parentNode?.isConnected); }
  setAttribute(key, value) {
    this.attrs[key] = String(value);
    if (key === 'class') this.className = String(value);
    else if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
    else this[key] = String(value);
  }
  getAttribute(key) { return key === 'class' ? this.className : this.attrs[key] ?? null; }
  hasAttribute(key) { return Object.hasOwn(this.attrs, key); }
  removeAttribute(key) { delete this.attrs[key]; }
  append(...nodes) {
    for (const node of nodes) {
      if (node?.nodeType === 11) { this.append(...[...node.children]); node.children = []; continue; }
      node.remove(); node.parentNode = this;
      const adopt = child => { child.ownerDocument = this.ownerDocument; child.children.forEach(adopt); };
      adopt(node); this.children.push(node); this.ownerDocument?.appended?.(node);
    }
  }
  prepend(node) { node.remove(); node.parentNode = this; this.children.unshift(node); }
  insertBefore(node, before) { node.remove(); node.parentNode = this; const at = this.children.indexOf(before); this.children.splice(at < 0 ? this.children.length : at, 0, node); }
  replaceChildren(...nodes) { [...this.children].forEach(node => node.remove()); this.append(...nodes); }
  remove() { if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(node => node !== this); this.parentNode = null; } }
  after(node) { this.parentNode?.insertBefore(node, this.parentNode.children[this.parentNode.children.indexOf(this) + 1]); }
  cloneNode(deep = false) {
    const node = new Node(this.tagName, this.ownerDocument, this.attrs);
    Object.assign(node, { className: this.className, dataset: { ...this.dataset }, textContent: this.textContent, href: this.href, src: this.src, integrity: this.integrity, media: this.media });
    if (this.tagName === 'SCRIPT') node.inertScript = true;
    if (deep) node.append(...this.children.map(child => child.cloneNode(true)));
    return node;
  }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    if (selector.includes(' ')) {
      const parts = selector.split(' '); return this.matches(parts.pop()) && Boolean(this.parentNode?.closest(parts.join(' ')));
    }
    if (selector === '[data-page-overlay]') return 'pageOverlay' in this.dataset;
    if (selector === 'style[data-page-style]') return this.tagName === 'STYLE' && 'pageStyle' in this.dataset;
    if (selector === 'link[rel="stylesheet"]') return this.tagName === 'LINK' && this.rel === 'stylesheet';
    if (selector === 'script[src^="https://"]') return this.tagName === 'SCRIPT' && this.src?.startsWith('https://');
    if (selector === 'a[href]') return this.tagName === 'A' && !!this.href;
    if (selector === '[hidden]' || selector === '[inert]') return Boolean(this[selector.slice(1, -1)]);
    const attribute = /^(\w+)?\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) return (!attribute[1] || this.tagName === attribute[1].toUpperCase())
      && this.hasAttribute(attribute[2]) && (attribute[3] === undefined || this.getAttribute(attribute[2]) === attribute[3]);
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.includes('#')) { const [tag, id] = selector.split('#'); return (!tag || this.tagName === tag.toUpperCase()) && this.id === id; }
    return this.tagName === selector.toUpperCase();
  }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) || null; }
  querySelectorAll(selector) { return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  click() { this.dispatchEvent(new TestEvent('click')); }
  scrollIntoView() { this.scrolled = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new TestEvent('close')); }
  pause() { this.pauseCount = (this.pauseCount || 0) + 1; this.paused = true; }
  load() { this.loadCount = (this.loadCount || 0) + 1; }
}

function makeDocument(path, styles = [], dependencies = []) {
  const doc = new Events();
  doc.documentElement = new Node('html', doc); doc.documentElement.dataset.authSnapshot = 'true';
  doc.head = new Node('head', doc); doc.body = new Node('body', doc);
  doc.documentElement.append(doc.head, doc.body);
  doc.createElement = tag => new Node(tag, doc);
  doc.createTextNode = text => { const node = new Node('#text', doc); node.textContent = text; return node; };
  doc.createDocumentFragment = () => new Node('#fragment', doc);
  doc.querySelectorAll = selector => doc.documentElement.querySelectorAll(selector);
  doc.querySelector = selector => doc.documentElement.querySelector(selector);
  doc.getElementById = id => doc.querySelector(`#${id}`);
  doc.importNode = (node, deep) => {
    const copy = node.cloneNode(deep);
    const adopt = node => { node.ownerDocument = doc; node.children.forEach(adopt); };
    adopt(copy); return copy;
  };
  doc.title = path;
  const wrapper = new Node('div', doc, { class: 'portal-wrapper' });
  const sidebar = new Node('aside', doc, { class: 'sidebar' });
  const nav = new Node('ul', doc, { class: 'sidebar-nav' });
  for (const name of ['dashboard', 'knowledge', 'academy', 'announcements', 'contents', 'profile', 'admin', 'cms', 'autocard', 'cards-pos']) {
    nav.append(new Node('a', doc, { href: `https://portal.test/${name}.html`, ...(name === 'contents' ? { class: 'contents-link' } : {}) }));
  }
  sidebar.append(nav);
  const outer = new Node('div', doc, { class: 'main-content' });
  const topbar = new Node('header', doc, { class: 'topbar' });
  topbar.append(new Node('button', doc, { class: 'mobile-menu-toggle' }), new Node('span', doc, { class: 'topbar-title' }));
  const main = new Node('main', doc, { id: 'main-content', class: 'page-body' });
  if (path === '/contents.html') {
    const root = new Node('section', doc, { id: 'contents-root', class: 'portal-contents', 'aria-label': 'Conteúdos' });
    root.append(new Node('h1', doc, { id: 'contents-title', tabindex: '-1' }));
    root.append(new Node('p', doc, { id: 'contents-status', role: 'status', 'aria-live': 'polite' }));
    root.append(new Node('div', doc, { id: 'contents-view' }));
    main.append(root);
  } else main.append(new Node('h1', doc, { id: `heading-${path}` }));
  outer.append(topbar, main); wrapper.append(sidebar, outer); doc.body.append(wrapper);
  styles.forEach(href => doc.head.append(new Node('link', doc, { rel: 'stylesheet', href })));
  dependencies.forEach(src => doc.head.append(new Node('script', doc, { src, integrity: 'test-integrity' })));
  return doc;
}

export async function createRouterHarness({ initialURL = 'https://portal.test/dashboard.html', user, autoStart = true, realUI = false,
  moduleOverrides = {} } = {}) {
  const doc = makeDocument(new URL(initialURL).pathname);
  const window = new Events();
  const location = { href: initialURL, replace(url) { this.redirect = url; } };
  for (const key of ['pathname', 'search', 'hash', 'origin']) Object.defineProperty(location, key, { get() { return new URL(this.href)[key]; } });
  const entries = [{ url: location.href, state: null }]; let cursor = 0;
  const history = {
    get state() { return entries[cursor].state; },
    get length() { return entries.length; },
    back() { this.go(-1); },
    forward() { this.go(1); },
    pushState(state, _, url) { entries.splice(++cursor); entries.push({ url: new URL(url, location.href).href, state }); location.href = entries[cursor].url; },
    replaceState(state, _, url) { entries[cursor] = { url: new URL(url, location.href).href, state }; location.href = entries[cursor].url; },
    go(delta) {
      queueMicrotask(() => {
        const next = cursor + delta; if (next < 0 || next >= entries.length) return;
        cursor = next; location.href = entries[cursor].url;
        window.dispatchEvent(new TestEvent('popstate', { state: history.state }));
      });
    },
  };
  Object.assign(window, { location, history, scrollX: 0, scrollY: 0, scrollTo(x, y) { this.scrollX = x; this.scrollY = y; } });
  const mounts = [], disposed = [], events = [], resources = [], requests = [];
  const modules = new Map(); const pages = new Map();
  const observers = [];
  let currentScope;
  const defaultUser = { uid: 'user-1', role: 'admin', permissions: { superAdmin: true }, autocard_access: true, pos_cards_access: true };
  const initialUser = user === undefined ? defaultUser : user;
  const storageValues = new Map();
  const sessionStorage = {
    getItem(key) { return storageValues.get(key) ?? null; },
    setItem(key, value) { storageValues.set(key, String(value)); },
    removeItem(key) { storageValues.delete(key); },
  };
  const auth = {
    currentUser: initialUser?.uid ? { uid: initialUser.uid, getIdToken: async () => `token-${initialUser.uid}` } : null,
    app: { name: '[DEFAULT]', options: { apiKey: 'router-harness-key' } },
    authStateReady: async () => {},
  };
  const context = vm.createContext({
    document: doc, window, location, URL, URLSearchParams, AbortController, DOMException, TextEncoder, TextDecoder,
    Response, ReadableStream, Uint8Array, console,
    setTimeout, clearTimeout, requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    Event: TestEvent, PopStateEvent: TestEvent,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.target = null; }
    },
    can: (user, permission) => Boolean(user.permissions?.superAdmin || user.permissions?.[permission]),
    user: initialUser,
    auth,
    sessionStorage,
    getCurrentUserDoc: async () => context.user,
    fetchAPI: async () => ({ linked: true }),
    logout: async () => { context.loggedOut = true; },
    canLeavePageUI: () => context.uiLeaveAllowed !== false,
    commitPageLeaveUI: () => true,
    closePageDialogs() {}, disposePageUI() {}, preparePageUI() {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (context.fetchOverride) return context.fetchOverride(url, options);
      return { ok: true, headers: new Map([['content-type', 'text/html']]), text: async () => new URL(url, location.href).pathname };
    },
    DOMParser: class { parseFromString(path) { return pages.get(path)?.() || makeDocument(path); } },
    loadModule: async name => {
      if (Object.hasOwn(moduleOverrides, name)) return moduleOverrides[name];
      if (!modules.has(name)) modules.set(name, { mount(page) {
        currentScope = page; mounts.push({ name, page });
        page.listen(window, 'test-page-event', () => events.push(name));
        page.cleanup(() => disposed.push(name));
        context.onMount?.(name, page);
      } });
      return modules.get(name);
    },
  });
  const authListeners = new Set();
  context.onAuthStateChanged = (_auth, listener) => {
    authListeners.add(listener);
    listener(context.auth.currentUser);
    return () => authListeners.delete(listener);
  };
  context.signOut = async () => {
    context.auth.currentUser = null;
    for (const listener of [...authListeners]) listener(null);
  };
  context.setAuthUser = next => {
    context.auth.currentUser = next?.uid ? { uid: next.uid, getIdToken: async () => `token-${next.uid}` } : null;
    for (const listener of [...authListeners]) listener(context.auth.currentUser);
  };
  context.notifyMutationObservers = () => {
    for (const observer of observers) if (observer.target) observer.callback([], observer);
  };
  context.updateProfile = async () => {};
  context.revokeEditorialSession = async () => {};
  window.confirm = () => context.confirmResult !== false;
  context.FormData = class {
    constructor(form) { this.form = form; this.parts = []; }
    append(name, value) { this.parts.push([name, value]); }
    entries() { return this.form ? this.form.querySelectorAll('[name]').map(node => [node.name, node.value || '']) : this.parts; }
  };
  doc.appended = node => {
    if (!['LINK', 'SCRIPT'].includes(node.tagName) || !node.onload) return;
    if (node.inertScript) throw new Error('A DOMParser script clone cannot execute');
    resources.push(node);
    const finish = () => {
      if (context.resourceFailure) node.onerror?.();
      else {
        if (node.src?.includes('/html2canvas/')) window.html2canvas = () => {};
        node.onload?.();
      }
    };
    if (context.resourcePause) context.resourcePause.then(finish);
    else queueMicrotask(finish);
  };
  const lifecycle = (await readFile('public/js/page-lifecycle.js', 'utf8')).replace(/^export /gm, '');
  const source = (await readFile('public/js/router.js', 'utf8')).replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '')
    .replace(/import\(routes\[([^\]]+)\]\)/g, 'loadModule(routes[$1])');
  if (realUI) vm.runInContext((await readFile('public/js/ui.js', 'utf8')).replace(/^export /gm, ''), context);
  vm.runInContext(`${lifecycle}\n${source}\nglobalThis.router = { startRouter, navigate, requestLogout, navigationURL, routeAllowed, routes };`, context);
  if (autoStart) { await context.router.startRouter(); await drain(); }
  return {
    context, doc, window, location, history, entries, mounts, disposed, events, resources, requests, modules,
    router: context.router, moduleOverrides, get scope() { return currentScope; },
    async loadRealAuthHooks() {
      const load = async (file, exports, namespace) => {
        const source = (await readFile(file, 'utf8'))
          .replace(/^import[^\n]*\n/gmu, '')
          .replace(/^export\s+/gmu, '');
        vm.runInContext(`(() => { ${source}\n globalThis.${namespace} = { ${exports} }; Object.assign(globalThis, globalThis.${namespace}); })();`,
          context, { filename: file });
      };
      await load('public/js/content-length.js', 'parseContentLength', '__routerAuthDependencies');
      await load('public/js/portal-contents/availability.js', 'configureContentsAvailability, probeContentsAvailability, resetContentsAvailability', '__routerAuthAvailability');
      await load('public/js/portal-contents/media-session.js', 'configureContentsMediaSession, acquireContentsMediaLease, clearContentsMediaSession, invalidateContentsMediaSession, assetURL', '__routerAuthMedia');
      const authSource = (await readFile('public/js/auth.js', 'utf8'))
        .replace(/^import[\s\S]*?;\s*/gmu, '')
        .replace(/^export\s+/gmu, '');
      vm.runInContext(`(() => { ${authSource}\n globalThis.__routerAuth = { getCurrentUserDoc, getContentsIdentity, subscribeContentsIdentity,
        authenticatedFetch, fetchAPI, fetchAPIPage, fetchAPIAsset, logout, requireAuth, can,
        configureContentsAvailability, probeContentsAvailability, resetContentsAvailability,
        configureContentsMediaSession, acquireContentsMediaLease, clearContentsMediaSession,
        invalidateContentsMediaSession }; Object.assign(globalThis, globalThis.__routerAuth); })();`,
        context, { filename: 'public/js/auth.js' });
      return context.__routerAuth;
    },
    async loadContentsModule({ request, realModules = false } = {}) {
      const listeners = new Set();
      const requests = [];
      let identity = null;
      if (!realModules) {
        identity = { uid: context.user?.uid || 'user-1', generation: 1, validated: true };
        context.getContentsIdentity = () => identity;
        context.subscribeContentsIdentity = listener => { listeners.add(listener); return () => listeners.delete(listener); };
        context.authenticatedFetch = (path, options = {}) => { requests.push({ path, options }); return request(path, options); };
        // Isolated reader-router tests use explicit media doubles. Whole-shell
        // integration opts into the complete production module graph below.
        context.createContentsGallery = () => ({ open() {}, close() {}, dispose() {} });
        context.activateContentsMedia = () => ({ dispose() {} });
      }
      const moduleFiles = [
        ['dto', 'public/js/portal-contents/dto.js', 'validatePortalPageDTO, validateDetail, validateList, validateCategories, isCanonicalSlug, PAGE_SIZE, MAX_OFFSET, MAX_TOTAL, MAX_BLOCKS, MAX_NODES, MAX_CONTENT_BYTES, MAX_DETAIL_BYTES, MAX_COLLECTION_BYTES, LAYOUTS'],
        ['richText', 'public/js/portal-contents/rich-text.js', 'renderRichText'],
        ['contentLength', 'public/js/content-length.js', 'parseContentLength'],
        ['api', 'public/js/portal-contents/api.js', 'readBoundedJSON, createContentsAPI, contentsErrorMessage'],
        ['catalog', 'public/js/portal-contents/catalog.js', 'renderCatalog, renderCategories'],
        ['reader', 'public/js/portal-contents/reader.js', 'renderReader'],
      ];
      context.__contentsModules = {};
      if (realModules) {
        const ui = (await readFile('public/js/ui.js', 'utf8')).replace(/^export\s+/gmu, '');
        vm.runInContext(`(() => { ${ui}\n globalThis.__contentsModules = globalThis.__contentsModules || {};\n globalThis.__contentsModules.ui = { registerPageDialog, closePageDialogs, openDialog };\n Object.assign(globalThis, globalThis.__contentsModules.ui); })();`,
          context, { filename: 'public/js/ui.js' });
        moduleFiles.push(
          ['gallery', 'public/js/portal-contents/gallery.js', 'createContentsGallery'],
          ['media', 'public/js/portal-contents/media.js', 'activateContentsMedia'],
        );
      }
      moduleFiles.push(['index', 'public/js/portal-contents/index.js', 'parseContentsLocation, mount']);
      for (const [name, file, exports] of moduleFiles) {
        const feature = (await readFile(file, 'utf8')).replace(/^import[^\n]*\n/gmu, '').replace(/^export\s+/gmu, '');
        vm.runInContext(`(() => { ${feature}\n globalThis.__contentsModules.${name} = { ${exports} }; Object.assign(globalThis, globalThis.__contentsModules.${name}); })();`,
          context, { filename: file });
      }
      const contentsModule = { mount(page) {
        currentScope = page; mounts.push({ name: './portal-contents/index.js', page });
        return context.__contentsModules.index.mount(page);
      } };
      moduleOverrides['./portal-contents/index.js'] = contentsModule;
      return { module: contentsModule, modules: context.__contentsModules, requests,
        notifyIdentity(next) {
          identity = next;
          for (const listener of [...listeners]) listener(identity);
        } };
    },
    page(path, { styles = [], scripts = [], setup } = {}) {
      pages.set(path, () => { const doc = makeDocument(path, styles, scripts); setup?.(doc); return doc; });
    },
    notifyAuthChange() { observers.filter(observer => observer.target === doc.documentElement).forEach(observer => observer.callback()); },
    click(path, options = {}) {
      const { button = 0, ...eventOptions } = options;
      const anchor = new Node('a', doc, { href: path });
      const event = new TestEvent('click', { target: anchor, button, ...eventOptions }); doc.dispatchEvent(event); return event;
    },
  };
}
