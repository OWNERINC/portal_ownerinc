import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { FixtureNode, parseInto, TestEvent } from './frontend-feedback-harness.mjs';
import { deferred } from './router-harness.mjs';
import { pageFixture } from './portal-contents-fixtures.mjs';

const moduleFiles = [
  ['dto', 'public/js/portal-contents/dto.js', 'validatePortalPageDTO, validateDetail, validateList, validateCategories, isCanonicalSlug, PAGE_SIZE, MAX_OFFSET, MAX_TOTAL, MAX_BLOCKS, MAX_NODES, MAX_CONTENT_BYTES, MAX_DETAIL_BYTES, MAX_COLLECTION_BYTES, LAYOUTS'],
  ['richText', 'public/js/portal-contents/rich-text.js', 'renderRichText'],
  ['api', 'public/js/portal-contents/api.js', 'readBoundedJSON, createContentsAPI, contentsErrorMessage'],
  ['catalog', 'public/js/portal-contents/catalog.js', 'renderCatalog, renderCategories'],
  ['reader', 'public/js/portal-contents/reader.js', 'renderReader'],
  ['index', 'public/js/portal-contents/index.js', 'parseContentsLocation, mount'],
];

function responseFor(path) {
  if (path === '/api/contents/categories') return Response.json([]);
  if (path.startsWith('/api/contents/?')) return new Response('[]', { headers: { 'X-Total-Count': '0' } });
  if (path.startsWith('/api/contents/')) return Response.json(pageFixture({ content_blocks: [] }));
  return Response.json({});
}

export async function createContentsHarness({ url = '/contents.html', request, identity, clock, mount = false } = {}) {
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
  const context = vm.createContext({
    document, window, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, DOMException,
    Response, ReadableStream, Uint8Array, console,
    setTimeout: clock?.setTimeout || setTimeout,
    clearTimeout: clock?.clearTimeout || clearTimeout,
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
  const page = context.createPageLifecycle({ user: { uid: currentIdentity?.uid }, history });
  page.location = location;
  page.history = history;
  function notifyIdentity(next) {
    currentIdentity = next;
    for (const listener of [...identityListeners]) listener(next);
  }
  function mountPage() { modules.index.mount(page); }
  function dispose() { page.dispose(); }
  if (mount) mountPage();
  return { document, window, page, modules, mount: mountPage, dispose, requests, entries, history, location,
    get identity() { return currentIdentity; }, notifyIdentity,
    async ready() { await page.ready(); },
    async popstate(next) {
      history.pushState(history.state, '', next);
      window.dispatchEvent(new TestEvent('popstate', { state: history.state }));
      await page.ready();
    },
  };
}
