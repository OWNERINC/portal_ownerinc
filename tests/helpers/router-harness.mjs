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
  stopImmediatePropagation() { this.stopped = true; }
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
    this.children = []; this.dataset = {}; this.attrs = {}; this.className = ''; this.style = {};
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
}

function makeDocument(path, styles = [], dependencies = []) {
  const doc = new Events();
  doc.documentElement = new Node('html', doc); doc.documentElement.dataset.authSnapshot = 'true';
  doc.head = new Node('head', doc); doc.body = new Node('body', doc);
  doc.documentElement.append(doc.head, doc.body);
  doc.createElement = tag => new Node(tag, doc);
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
  for (const name of ['dashboard', 'knowledge', 'academy', 'announcements', 'profile', 'admin', 'cms', 'autocard', 'cards-pos']) {
    nav.append(new Node('a', doc, { href: `https://portal.test/${name}.html` }));
  }
  sidebar.append(nav);
  const outer = new Node('div', doc, { class: 'main-content' });
  const topbar = new Node('header', doc, { class: 'topbar' });
  topbar.append(new Node('button', doc, { class: 'mobile-menu-toggle' }), new Node('span', doc, { class: 'topbar-title' }));
  const main = new Node('main', doc, { id: 'main-content', class: 'page-body' });
  main.append(new Node('h1', doc, { id: `heading-${path}` }));
  outer.append(topbar, main); wrapper.append(sidebar, outer); doc.body.append(wrapper);
  styles.forEach(href => doc.head.append(new Node('link', doc, { rel: 'stylesheet', href })));
  dependencies.forEach(src => doc.head.append(new Node('script', doc, { src, integrity: 'test-integrity' })));
  return doc;
}

export async function createRouterHarness({ initialURL = 'https://portal.test/dashboard.html', user, autoStart = true, realUI = false } = {}) {
  const doc = makeDocument('/dashboard.html');
  const window = new Events();
  const location = { href: initialURL, replace(url) { this.redirect = url; } };
  for (const key of ['pathname', 'search', 'hash', 'origin']) Object.defineProperty(location, key, { get() { return new URL(this.href)[key]; } });
  const entries = [{ url: location.href, state: null }]; let cursor = 0;
  const history = {
    get state() { return entries[cursor].state; },
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
  const context = vm.createContext({
    document: doc, window, location, URL, URLSearchParams, AbortController, DOMException, console,
    setTimeout, clearTimeout, requestAnimationFrame: fn => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    Event: TestEvent, PopStateEvent: TestEvent,
    MutationObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(target) { this.target = target; }
      disconnect() { this.target = null; }
    },
    can: (user, permission) => Boolean(user.permissions?.superAdmin || user.permissions?.[permission]),
    user: user === undefined ? { uid: 'user-1', role: 'admin', permissions: { superAdmin: true }, autocard_access: true, pos_cards_access: true } : user,
    auth: { currentUser: { uid: 'user-1' } },
    getCurrentUserDoc: async () => context.user,
    fetchAPI: async () => ({ linked: true }),
    logout: async () => { context.loggedOut = true; },
    canLeavePageUI: () => context.uiLeaveAllowed !== false,
    commitPageLeaveUI: () => true,
    closePageDialogs() {}, disposePageUI() {}, preparePageUI() {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (context.fetchOverride) return context.fetchOverride(url, options);
      return { ok: true, headers: new Map([['content-type', 'text/html']]), text: async () => new URL(url).pathname };
    },
    DOMParser: class { parseFromString(path) { return pages.get(path)?.() || makeDocument(path); } },
    loadModule: async name => {
      if (!modules.has(name)) modules.set(name, { mount(page) {
        currentScope = page; mounts.push({ name, page });
        page.listen(window, 'test-page-event', () => events.push(name));
        page.cleanup(() => disposed.push(name));
        context.onMount?.(name, page);
      } });
      return modules.get(name);
    },
  });
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
    router: context.router, get scope() { return currentScope; },
    page(path, { styles = [], scripts = [], setup } = {}) {
      pages.set(path, () => { const doc = makeDocument(path, styles, scripts); setup?.(doc); return doc; });
    },
    notifyAuthChange() { observers.filter(observer => observer.target === doc.documentElement).forEach(observer => observer.callback()); },
    click(path, options = {}) {
      const anchor = new Node('a', doc, { href: path, ...options });
      const event = new TestEvent('click', { target: anchor }); doc.dispatchEvent(event); return event;
    },
  };
}
