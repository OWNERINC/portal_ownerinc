import { can, getCurrentUserDoc, fetchAPI, logout } from './auth.js';
import { auth } from './firebase-config.js';
import { createPageLifecycle } from './page-lifecycle.js';
import { canLeavePageUI, commitPageLeaveUI, closePageDialogs, disposePageUI, preparePageUI } from './ui.js';

export const routes = Object.freeze({
  '/dashboard.html': './dashboard.js',
  '/knowledge.html': './knowledge.js',
  '/academy.html': './academy.js',
  '/announcements.html': './announcements.js',
  '/reminders.html': './reminders.js',
  '/profile.html': './profile.js',
  '/admin.html': './admin.js',
  '/cms.html': './cms.js',
  '/autocard.html': '../autocard/entry.js',
  '/cards-pos.html': '../cards-pos/app.js',
  '/benefits.html': './benefits.js',
  '/solides.html': './solides.js',
});
const HISTORY_KEY = 'portalNavigation';
const styles = new Map();
const scripts = new Map();
let activePage;
let activeURL;
let position = 0;
let transition = null;
let started = false;
let traversal = null;
let errorNode;
let pageClasses = [];
let localHistoryEvent = false;
let restoration = 0;
let authorizationVersion = 0;
const positions = new Map();

export function navigationURL(event, base = location.href) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = event.target?.closest?.('a[href]');
  if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self') || anchor.relList?.contains('external')) return null;
  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('#')) return null;
  const url = new URL(href, base);
  return url.origin === new URL(base).origin && routes[url.pathname] ? url : null;
}

export function routeAllowed(path, user) {
  if (!user) return false;
  if (path === '/admin.html') return user.role === 'admin';
  if (path === '/cms.html') return user.role === 'admin' && ['manageKnowledge', 'manageAcademy', 'manageBenefits', 'manageReminders'].some(permission => can(user, permission));
  if (path === '/autocard.html') return user.autocard_access === true;
  if (path === '/cards-pos.html') return user.pos_cards_access === true;
  return Boolean(routes[path]);
}

function canLeave() { return (!activePage || activePage.canLeave()) && canLeavePageUI(); }

function disposeCurrentPage() {
  activePage?.dispose(); activePage = null;
  disposePageUI();
  document.querySelectorAll('[data-page-overlay]').forEach(node => {
    node.replaceChildren(); node.remove();
  });
  document.querySelectorAll('.topbar-actions').forEach(node => { node.replaceChildren(); node.remove(); });
  document.getElementById('main-content').replaceChildren();
  errorNode?.remove(); errorNode = null;
}

function dispatchLocalHistory() {
  localHistoryEvent = true;
  try { window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state })); }
  finally { localHistoryEvent = false; }
}

export async function requestLogout() {
  if (traversal || !canLeave()) return;
  const leaving = activePage;
  if (!await commitPageLeaveUI() || activePage !== leaving) return;
  transition?.abort();
  disposeCurrentPage();
  await logout();
}

function recordPosition() {
  const focused = document.activeElement;
  positions.set(position, {
    x: window.scrollX, y: window.scrollY,
    focus: focused?.id || null,
  });
}

function writeHistory(method, state, title, url) {
  recordPosition();
  if (method === 'pushState') position += 1;
  window.history[method]({ ...state, [HISTORY_KEY]: position }, title, url);
  activeURL = new URL(location.href);
}

const pageHistory = {
  pushState: (state, title, url) => writeHistory('pushState', state, title, url),
  replaceState: (state, title, url) => writeHistory('replaceState', state, title, url),
};

function showError(error, retry, initial = false) {
  errorNode?.remove();
  errorNode = document.createElement('section');
  errorNode.className = 'empty-state portal-navigation-error';
  errorNode.setAttribute('role', 'alert');
  const text = document.createElement('p');
  text.textContent = error.status === 403 ? 'Você não possui acesso a esta área.'
    : initial ? 'Não foi possível abrir esta área. Tente novamente.' : 'Não foi possível abrir esta área. Sua página foi preservada.';
  const button = document.createElement('button');
  button.className = 'btn btn-ghost'; button.type = 'button'; button.textContent = 'Tentar novamente';
  button.addEventListener('click', retry);
  errorNode.append(text, button);
  const main = document.getElementById('main-content');
  main.removeAttribute('data-route-pending');
  if (initial) main.replaceChildren(errorNode);
  else document.querySelector('.topbar').after(errorNode);
}

function pageOverlays(doc) {
  return [...doc.body.children].filter(node => !node.matches('script, .portal-wrapper, .skip-link, .sidebar-overlay, .portal-navigation-error'));
}

function resource(node, parent) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('O recurso demorou para carregar.')), 20000);
    function finish(error) {
      clearTimeout(timer); node.onload = null; node.onerror = null;
      if (error) { node.remove(); reject(error); } else resolve(node);
    }
    node.onload = () => finish();
    node.onerror = () => finish(new Error('Não foi possível carregar um recurso da página.'));
    parent.append(node);
  });
}

async function prepareStyles(doc, url) {
  const selected = [];
  for (const link of doc.querySelectorAll('link[rel="stylesheet"]')) {
    const href = new URL(link.getAttribute('href'), url).href;
    if (!styles.has(href)) {
      const node = link.cloneNode(); node.href = href; node.media = 'not all';
      const promise = resource(node, document.head).catch(error => { styles.delete(href); throw error; });
      styles.set(href, promise);
    }
    selected.push(styles.get(href));
  }
  return Promise.all(selected);
}

function activateStyles(selected, doc) {
  const next = new Set(selected);
  next.forEach(node => {
    node.media = 'all';
    if (node.parentNode !== document.head) document.head.append(node);
  });
  document.querySelectorAll('link[rel="stylesheet"]').forEach(node => {
    if (!next.has(node)) node.media = 'not all';
  });
  document.querySelectorAll('style[data-page-style]').forEach(node => node.remove());
  doc.querySelectorAll('head style').forEach(style => {
    const node = style.cloneNode(true); node.dataset.pageStyle = ''; document.head.append(node);
  });
}

async function prepareScripts(doc) {
  for (const source of doc.querySelectorAll('script[src^="https://"]')) {
    const url = source.src;
    const available = url.includes('/html2canvas/') ? window.html2canvas
      : url.includes('/jspdf/') ? window.jspdf?.jsPDF
        : url.includes('/lucide@') ? window.lucide : null;
    if (available) continue;
    if (!source.integrity || !/^https:\/\/(cdnjs\.cloudflare\.com|unpkg\.com)\//.test(url)) throw new Error('Dependência não reconhecida.');
    if (!scripts.has(url)) {
      // DOMParser scripts (and their clones) are inert. Create a fresh element.
      const node = document.createElement('script');
      node.src = url; node.integrity = source.integrity;
      node.crossOrigin = source.crossOrigin || 'anonymous'; node.async = true;
      scripts.set(url, resource(node, document.head).catch(error => { scripts.delete(url); throw error; }));
    }
    await scripts.get(url);
  }
}

function restorePosition(page, url, saved) {
  const version = ++restoration;
  const interaction = new AbortController();
  let touched = false;
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, () => { touched = true; }, { signal: interaction.signal, once: true, passive: true });
  }
  page.cleanup(() => interaction.abort());
  void Promise.resolve().then(() => page.ready()).then(() => {
    interaction.abort();
    if (!page.active || touched || version !== restoration) return;
    let hashId = '';
    try { hashId = decodeURIComponent(url.hash.slice(1)); } catch (_) { /* Invalid fragment stays a native URL. */ }
    const target = document.getElementById(saved?.focus || hashId) || document.getElementById('main-content');
    if (target && !target.closest('[hidden], .hidden, [inert]')) {
      if (!target.hasAttribute('tabindex')) target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
    if (saved) window.scrollTo(saved.x, saved.y);
    else if (hashId) document.getElementById(hashId)?.scrollIntoView();
    else window.scrollTo(0, 0);
  });
}

function mountPage(module, user, url, saved) {
  const page = createPageLifecycle({ user, history: null });
  // Popstate changes the browser URL before a cross-area traversal can be
  // accepted. Loaders must keep reading the committed page's query meanwhile.
  page.location = {
    get href() { return activeURL.href; }, get search() { return activeURL.search; },
    get hash() { return activeURL.hash; }, get pathname() { return activeURL.pathname; },
    get origin() { return activeURL.origin; },
  };
  page.history = Object.fromEntries(['pushState', 'replaceState'].map(method => [method, (...args) => {
    if (page.active && activePage === page && !traversal) pageHistory[method](...args);
  }]));
  activePage = page;
  document.getElementById('main-content').removeAttribute('data-route-pending');
  preparePageUI();
  try { module.mount(page); }
  catch (error) { page.dispose(); activePage = null; throw error; }
  restorePosition(page, url, saved);
}

function commit(doc, selectedStyles, module, user, url, saved) {
  disposeCurrentPage();
  pageOverlays(doc).forEach(node => { node.dataset.pageOverlay = ''; document.body.append(document.importNode(node, true)); });
  const incoming = doc.getElementById('main-content');
  const main = document.getElementById('main-content');
  main.replaceChildren(...incoming.childNodes);
  main.className = incoming.className;
  const topbar = document.querySelector('.topbar');
  [...topbar.children].forEach(node => { if (!node.classList.contains('mobile-menu-toggle')) node.remove(); });
  topbar.append(...doc.querySelector('.topbar').childNodes);
  document.body.classList.remove(...pageClasses);
  pageClasses = [...doc.body.classList];
  document.body.classList.add(...pageClasses);
  document.title = doc.title;
  activateStyles(selectedStyles, doc);
  document.querySelectorAll('.sidebar-nav a').forEach(link => {
    const selected = new URL(link.href).pathname === url.pathname;
    link.classList.toggle('active', selected);
    if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  document.dispatchEvent(new Event('portal:navigated'));
  mountPage(module, user, url, saved);
}

export async function navigate(destination, { historyPosition = null, initial = false } = {}) {
  const url = new URL(destination, location.href);
  if (!routes[url.pathname] || traversal) return false;
  restoration += 1;
  // Leave confirmation is delayed until preparation completes, so an editor
  // remains usable on network failure and changes made during loading are checked.
  transition?.abort();
  const controller = new AbortController(); transition = controller;
  const validation = ++authorizationVersion;
  const { signal } = controller;
  let committed = false;
  let revoked = false;
  try {
    // Observe preparation errors immediately, but never let them bypass an
    // authoritative access change returned by the independent session request.
    const preparation = Promise.all([
      fetch(url.href, { signal, headers: { Accept: 'text/html' } }),
      import(routes[url.pathname]),
    ]).then(value => ({ value }), error => ({ error }));
    const user = await getCurrentUserDoc();
    // Cancellation stops navigation, not a still-current authorization result.
    // A newer validation or another account owns its own decision instead.
    if (validation === authorizationVersion && user && auth.currentUser?.uid === user.uid
      && activePage?.user.uid === user.uid && !routeAllowed(activeURL.pathname, user)) {
      revoked = true;
      disposeCurrentPage();
      showError({ status: 403 }, () => navigate('./dashboard.html'), true);
    }
    if (signal.aborted) return false;
    if (!user) { disposeCurrentPage(); window.location.replace(`./login.html?reason=session&next=${encodeURIComponent(url.pathname + url.search + url.hash)}`); return false; }
    if (auth.currentUser?.uid !== user.uid) return false;
    controller.validatedUid = user.uid;
    if (!routeAllowed(url.pathname, user)) throw Object.assign(new Error('Acesso restrito.'), { status: 403 });
    if (url.pathname === '/solides.html' && !(await fetchAPI('/api/solides/me/status', { signal })).linked) throw Object.assign(new Error('Acesso restrito.'), { status: 403 });
    const prepared = await preparation;
    if (signal.aborted) return false;
    if (prepared.error) throw prepared.error;
    const [response, module] = prepared.value;
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) throw new Error('Página indisponível.');
    if (typeof module.mount !== 'function') throw new Error('Inicialização da página indisponível.');
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    if (!doc.querySelector('main#main-content') || !doc.querySelector('.topbar')) throw new Error('Página inválida.');
    const [selectedStyles] = await Promise.all([prepareStyles(doc, url), prepareScripts(doc)]);
    if (auth.currentUser?.uid !== user.uid) throw new DOMException('A sessão mudou.', 'AbortError');
    if (signal.aborted || !canLeave()) return false;
    const leaving = activePage;
    if (!await commitPageLeaveUI() || signal.aborted || activePage !== leaving) return false;
    recordPosition();
    if (historyPosition !== null) {
      disposePageUI(); activePage?.dispose();
      document.querySelector('.main-content').inert = true;
      await traverseTo(historyPosition);
      if (signal.aborted) return false;
      position = historyPosition;
      activeURL = url;
    } else if (!initial) writeHistory('pushState', {}, '', url);
    committed = true;
    commit(doc, selectedStyles, module, user, url, positions.get(historyPosition));
    return true;
  } catch (error) {
    console.error('[Portal] falha ao abrir a área', {
      path: url.pathname,
      message: error?.message,
      stack: error?.stack,
      status: error?.status,
    });
    if (!signal.aborted && error.name !== 'AbortError') showError(error, () => navigate(url, { historyPosition, initial: initial || committed }), initial || committed || revoked);
    return false;
  } finally {
    if (transition === controller) {
      document.querySelector('.main-content').inert = document.body.classList.contains('sidebar-open');
      transition = null;
    }
  }
}

function traverseTo(index) {
  const current = window.history.state?.[HISTORY_KEY];
  if (current === index) return Promise.resolve();
  return new Promise(resolve => {
    traversal = { index, resolve };
    window.history.go(index - current);
  });
}

async function onPopState(event) {
  if (localHistoryEvent) return;
  const index = event.state?.[HISTORY_KEY];
  if (traversal) {
    event.stopImmediatePropagation();
    if (index === traversal.index) { const { resolve } = traversal; traversal = null; resolve(); }
    else window.history.go(traversal.index - index);
    return;
  }
  const url = new URL(location.href);
  if (!Number.isInteger(index)) return; // Entries outside the shell retain native behavior.
  if (url.pathname === activeURL.pathname && canLeave()) {
    if (!activePage) {
      event.stopImmediatePropagation();
      position = index; activeURL = url;
      void navigate(url, { initial: true });
      return;
    }
    const leaving = activePage;
    const discard = commitPageLeaveUI();
    if (discard !== true) {
      event.stopImmediatePropagation();
      transition?.abort(); recordPosition();
      await traverseTo(position);
      if (!await discard || activePage !== leaving) return;
      await traverseTo(index);
      position = index; activeURL = url;
      closePageDialogs(); dispatchLocalHistory();
      restorePosition(leaving, url, positions.get(index));
      return;
    }
    transition?.abort(); recordPosition(); position = index; activeURL = url;
    closePageDialogs();
    if (activePage) restorePosition(activePage, url, positions.get(index));
    return; // Page-local query/hash loaders retain their existing semantics.
  }
  event.stopImmediatePropagation();
  transition?.abort();
  const previous = position;
  await traverseTo(previous);
  if (url.pathname === activeURL.pathname) return; // A rejected page-local edit guard.
  await navigate(url, { historyPosition: index });
}

export async function startRouter() {
  if (started) return;
  started = true;
  activeURL = new URL(location.href);
  position = window.history.state?.[HISTORY_KEY] ?? 0;
  window.history.replaceState({ ...window.history.state, [HISTORY_KEY]: position }, '', location.href);
  window.history.scrollRestoration = 'manual';
  pageClasses = [...document.body.classList].filter(name => !name.startsWith('sidebar-'));
  pageOverlays(document).forEach(node => { node.dataset.pageOverlay = ''; });
  document.querySelectorAll('head style').forEach(node => { node.dataset.pageStyle = ''; });
  document.querySelectorAll('link[rel="stylesheet"]').forEach(node => styles.set(node.href, Promise.resolve(node)));
  window.addEventListener('popstate', onPopState, true);
  window.addEventListener('hashchange', event => {
    if (traversal || location.pathname !== activeURL.pathname) { event.stopImmediatePropagation(); return; }
    if (!Number.isInteger(window.history.state?.[HISTORY_KEY])) {
      recordPosition(); position += 1;
      window.history.replaceState({ [HISTORY_KEY]: position }, '', location.href);
    }
    activeURL = new URL(location.href);
  }, true);
  document.addEventListener('click', async event => {
    const url = navigationURL(event);
    if (!url) return;
    if (url.pathname === activeURL.pathname) {
      if (url.search === activeURL.search && url.hash) return;
      event.preventDefault();
      if (!activePage) { if (!traversal) void navigate(url, { initial: url.href === location.href }); return; }
      if (traversal || !canLeave()) return;
      const leaving = activePage;
      if (!await commitPageLeaveUI() || activePage !== leaving) return;
      transition?.abort(); closePageDialogs();
      if (url.href !== location.href) pageHistory.pushState({}, '', url);
      dispatchLocalHistory();
      return;
    }
    event.preventDefault();
    if (!traversal) void navigate(url);
  });
  window.addEventListener('beforeunload', event => {
    if (!activePage?.busy) return;
    event.preventDefault(); event.returnValue = '';
  });
  window.addEventListener('pagehide', () => { transition?.abort(); activePage?.dispose(); disposePageUI(); });
  window.addEventListener('pageshow', event => { if (event.persisted) void navigate(location.href, { initial: true }); });
  new MutationObserver(() => {
    // Auth removes this same-account visual marker on definitive session loss.
    if (!document.documentElement.dataset.authSnapshot) {
      if (transition?.validatedUid) transition.abort();
      disposeCurrentPage();
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-auth-snapshot'] });
  // Initial markup is a public template. Validation precedes any page mount.
  const boot = new AbortController(); transition = boot;
  authorizationVersion += 1;
  const initialURL = new URL(activeURL);
  try {
    const [user, module] = await Promise.all([getCurrentUserDoc(), import(routes[initialURL.pathname])]);
    if (boot.signal.aborted) return;
    if (!user) { window.location.replace(`./login.html?reason=session&next=${encodeURIComponent(initialURL.pathname + initialURL.search + initialURL.hash)}`); return; }
    boot.validatedUid = user.uid;
    if (!routeAllowed(activeURL.pathname, user)) throw Object.assign(new Error('Acesso restrito.'), { status: 403 });
    if (activeURL.pathname === '/solides.html' && !(await fetchAPI('/api/solides/me/status')).linked) throw Object.assign(new Error('Acesso restrito.'), { status: 403 });
    await prepareScripts(document);
    if (boot.signal.aborted || auth.currentUser?.uid !== user.uid) return;
    mountPage(module, user, activeURL);
  } catch (error) { if (!boot.signal.aborted) showError(error, () => navigate(initialURL, { initial: true }), true); }
  finally { if (transition === boot) transition = null; }
}
