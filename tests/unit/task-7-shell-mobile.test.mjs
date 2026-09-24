import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { mountSource, activePageDouble } from '../helpers/page-mount.mjs';

const [ui, sidebar, tokens, layout, components, dashboardHome, knowledgeCss, cmsCss, profile, dashboard, knowledge, academy, announcements, renderer, nginx] = await Promise.all([
  readFile('public/js/ui.js', 'utf8'),
  readFile('public/js/sidebar.js', 'utf8'),
  readFile('public/css/tokens.css', 'utf8'),
  readFile('public/css/layout.css', 'utf8'),
  readFile('public/css/components.css', 'utf8'),
  readFile('public/css/dashboard-home.css', 'utf8'),
  readFile('public/css/knowledge.css', 'utf8'),
  readFile('public/css/cms.css', 'utf8'),
  readFile('public/js/profile.js', 'utf8'),
  readFile('public/js/dashboard.js', 'utf8'),
  readFile('public/js/knowledge.js', 'utf8'),
  readFile('public/js/academy.js', 'utf8'),
  readFile('public/js/announcements.js', 'utf8'),
  readFile('public/js/cms-block-renderer.js', 'utf8'),
  readFile('nginx/nginx.conf', 'utf8'),
]);

function fakeElement(tag) {
  return {
    tagName: tag.toUpperCase(),
    attributes: new Map(),
    children: [],
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {},
  };
}

function loadElement() {
  const document = {
    createElement: fakeElement,
    querySelectorAll: () => [],
    addEventListener() {},
    body: { children: [], classList: { add() {}, remove() {} } },
    activeElement: null,
  };
  const context = {
    document,
    window: { addEventListener() {}, confirm: () => true },
    URL,
    FormData,
    WeakMap,
    Map,
    Set,
    Symbol,
  };
  const source = ui.replace(/^export /gm, '') + '\nglobalThis.buildElement = element;';
  vm.runInNewContext(source, context, { filename: 'ui.js' });
  return context.buildElement;
}

function createTestNode(document, tag = 'div', id = '') {
  const listeners = new Map();
  const classes = new Set();
  let text = '';
  const node = {
    ownerDocument: document,
    tagName: tag.toUpperCase(),
    id,
    attributes: new Map(),
    children: [],
    parentNode: null,
    dataset: {},
    style: {},
    hidden: false,
    disabled: false,
    inert: false,
    isConnected: true,
    value: '',
    files: [],
    tabIndex: 0,
    classList: {
      add(...values) { values.forEach(value => classes.add(value)); },
      remove(...values) { values.forEach(value => classes.delete(value)); },
      toggle(value, force) {
        const next = force === undefined ? !classes.has(value) : force;
        if (next) classes.add(value); else classes.delete(value);
        return next;
      },
      contains(value) { return classes.has(value); },
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
      if (name === 'id') this.id = String(value);
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
    },
    removeAttribute(name) { this.attributes.delete(name); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    hasAttribute(name) { return this.attributes.has(name); },
    append(...children) {
      children.flat().filter(Boolean).forEach(child => {
        child.parentNode = this;
        child.isConnected = this.isConnected;
        this.children.push(child);
      });
    },
    prepend(...children) {
      children.flat().filter(Boolean).reverse().forEach(child => {
        child.parentNode = this;
        child.isConnected = this.isConnected;
        this.children.unshift(child);
      });
    },
    replaceChildren(...children) {
      this.children.forEach(child => { child.isConnected = false; });
      this.children = [];
      text = '';
      this.append(...children);
    },
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    dispatch(type, event = {}) {
      (listeners.get(type) || []).forEach(handler => handler({ target: this, preventDefault() {}, ...event }));
    },
    focus() {
      let current = this;
      while (current) {
        if (current.disabled || current.inert) return;
        current = current.parentNode;
      }
      document.activeElement = this;
      this.focused = true;
    },
    hasChildNodes() { return this.children.length > 0 || Boolean(text); },
    closest(selector) {
      let current = this;
      while (current) {
       if (selector.startsWith('#') && current.id === selector.slice(1)) return current;
       if (selector === '.sidebar' && current.classList.contains('sidebar')) return current;
       if (selector === 'section, main' && ['SECTION', 'MAIN'].includes(current.tagName)) return current;
        if (selector === '[hidden], .hidden, [aria-hidden="true"]'
          && (current.hidden || current.classList.contains('hidden') || current.getAttribute('aria-hidden') === 'true')) return current;
       current = current.parentNode;
      }
      return null;
    },
    querySelectorAll(selector) {
      const matches = [];
      const visit = child => {
        const button = child.tagName === 'BUTTON';
        const anchor = child.tagName === 'A';
        const match = selector === 'button'
          ? button
          : selector === 'a'
            ? anchor
            : selector === 'a, button'
              ? (anchor || button)
            : selector === 'a[href], button:not([disabled])'
              ? (anchor || (button && !child.disabled))
              : selector === 'button:not([disabled])'
                ? (button && !child.disabled)
                : selector === 'form'
                  ? child.tagName === 'FORM'
                  : selector === 'a.active'
                    ? (anchor && child.classList.contains('active'))
                    : false;
        if (match) matches.push(child);
        child.children.forEach(visit);
      };
      this.children.forEach(visit);
      return matches;
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
  };
  Object.defineProperty(node, 'className', {
    get() { return [...classes].join(' '); },
    set(value) { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach(item => classes.add(item)); },
  });
  Object.defineProperty(node, 'textContent', {
    get() { return text || this.children.map(child => child.textContent).join(''); },
    set(value) { text = String(value ?? ''); this.children = []; },
  });
  return node;
}

function createTestDocument() {
  const document = {
    activeElement: null,
    listeners: new Map(),
    createElement(tag) { return createTestNode(document, tag); },
    addEventListener(type, handler) { document.listeners.set(type, handler); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  document.body = createTestNode(document, 'body');
  document.activeElement = document.body;
  return document;
}

function register(document, node, map) {
  if (node.id) map.set(node.id, node);
  return node;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function loadAcademyHarness() {
  const document = createTestDocument();
  const nodes = new Map();
  const container = register(document, createTestNode(document, 'main', 'academy-content'), nodes);
  const filters = register(document, createTestNode(document, 'div', 'academy-filters'), nodes);
  const pagination = register(document, createTestNode(document, 'div', 'academy-pagination'), nodes);
  document.body.append(container, filters, pagination);
  document.getElementById = id => nodes.get(id) || null;
  const location = { href: 'https://portal.test/academy.html' };
  Object.defineProperty(location, 'search', { get() { return new URL(this.href).search; } });
  const history = { replaceState(_, __, href) { location.href = String(href); } };
  const requests = [];
  let activeRequest;
  const context = {
    document,
    window: { addEventListener() {} },
    location,
    history,
    URL,
    URLSearchParams,
    Map,
    Set,
    Number,
    String,
    Array,
    console,
    fetchAPIPage: () => {
      activeRequest = { page: deferred(), categories: deferred() };
      requests.push(activeRequest);
      return activeRequest.page.promise;
    },
    fetchAPI: () => activeRequest.categories.promise,
    requireAuth: async () => ({}),
    setBusy(node, busy) { node?.setAttribute('aria-busy', String(busy)); },
     setPaginationBusy(node, busy) {
       node?.setAttribute('aria-busy', String(busy));
       node?.querySelectorAll('button').forEach(button => { button.disabled = busy || button.dataset.paginationBoundaryDisabled === 'true'; });
     },
    clear(node) { node.replaceChildren(); return node; },
    element(tag, options = {}, children = []) {
      const node = createTestNode(document, tag);
      Object.entries(options).forEach(([key, value]) => {
        if (key === 'className') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'on') Object.entries(value).forEach(([event, handler]) => node.addEventListener(event, handler));
        else if (value !== undefined && value !== null) node.setAttribute(key, value);
      });
      node.append(...(Array.isArray(children) ? children : [children]));
      return node;
    },
    safeHttpUrl: value => /^https?:/.test(value) ? value : null,
    renderBlocks() {},
    showState(node, message, retry) {
      const state = createTestNode(document, 'div');
      state.textContent = message;
      if (retry) state.append(context.element('button', { text: 'Retry', on: { click: retry } }));
      context.clear(node).append(state);
      return state;
    },
    readOffset(search, limit) {
      const value = Number(search.get('offset') || 0);
      return Number.isInteger(value) && value >= 0 ? Math.floor(value / limit) * limit : 0;
    },
     renderPagination(node, total, offset, limit, onPage) {
       context.paginationCallback = onPage;
       context.clear(node);
       if (total <= limit) return;
       const pageCount = Math.ceil(total / limit);
       const page = Math.min(Math.floor(offset / limit), pageCount - 1);
       const previous = context.element('button', { text: 'Anterior', type: 'button', on: { click: () => onPage(Math.max(0, page - 1) * limit) } });
       previous.disabled = page === 0;
       previous.dataset.paginationBoundaryDisabled = String(previous.disabled);
       const next = context.element('button', { text: 'Próxima', type: 'button', on: { click: () => onPage((page + 1) * limit) } });
       next.disabled = page >= pageCount - 1;
       next.dataset.paginationBoundaryDisabled = String(next.disabled);
       node.append(previous, context.element('span', { text: `Página ${page + 1} de ${pageCount}` }), next);
     },
  };
  const source = academy
    .replace(/^import[^\n]+\n/gm, '')
    .replace(/const user = await requireAuth\(\);\nif \(!user\) throw new Error\('Authentication required'\);\n/, '')
    .replace(/\nloadCourses\(\);\n}\s*$/, '\n}');
  vm.runInNewContext(mountSource(source, 'globalThis.loadCourses = loadCourses;'), context, { filename: 'academy.js' });
  return { context, document, nodes, container, filters, pagination, location, requests };
}

function loadAnnouncementsHarness() {
  const document = createTestDocument();
  const nodes = new Map();
  const list = register(document, createTestNode(document, 'div', 'announcements-list'), nodes);
  const pagination = register(document, createTestNode(document, 'div', 'announcements-pagination'), nodes);
  document.body.append(list, pagination);
  document.getElementById = id => nodes.get(id) || null;
  const location = { href: 'https://portal.test/announcements.html' };
  Object.defineProperty(location, 'search', { get() { return new URL(this.href).search; } });
  const history = {
    replaceState(_, __, href) { location.href = String(href); },
    pushState(_, __, href) { location.href = String(href); },
  };
  const requests = [];
  let activeRequest;
  const context = {
    document,
    window: { listeners: new Map(), addEventListener(type, handler) { this.listeners.set(type, handler); } },
    location,
    history,
    URL,
    URLSearchParams,
    Map,
    Set,
    Number,
    String,
    Array,
    console,
    fetchAPIPage: () => {
      activeRequest = { page: deferred() };
      requests.push(activeRequest);
      return activeRequest.page.promise;
    },
    fetchAPI: async () => ({}),
    requireAuth: async () => ({}),
    clear(node) { node.replaceChildren(); return node; },
    setBusy(node, busy) { node?.setAttribute('aria-busy', String(busy)); },
    setPaginationBusy(node, busy) {
      node.setAttribute('aria-busy', String(busy));
      node.querySelectorAll('button').forEach(button => { button.disabled = busy || button.dataset.paginationBoundaryDisabled === 'true'; });
    },
    element(tag, options = {}, children = []) {
      const node = createTestNode(document, tag);
      Object.entries(options).forEach(([key, value]) => {
        if (key === 'className') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'on') Object.entries(value).forEach(([event, handler]) => node.addEventListener(event, handler));
        else if (value !== undefined && value !== null) node.setAttribute(key, value);
      });
      node.append(...(Array.isArray(children) ? children : [children]));
      return node;
    },
    showState(node, message) {
      const state = context.element('div', { role: 'status', text: message });
      context.clear(node).append(state);
      return state;
    },
    readOffset(search, limit) {
      const value = Number(search.get('offset') || 0);
      return Number.isInteger(value) && value >= 0 ? Math.floor(value / limit) * limit : 0;
    },
    renderBlocks() {},
    cleanupRenderedBlocks() {},
    blocksToText: blocks => (blocks || []).map(block => block.text || '').join('\n'),
    renderPagination(node, total, offset, limit, onPage) {
      context.paginationCallback = onPage;
      context.clear(node);
      if (total <= limit) return;
      const previous = context.element('button', { text: 'Anterior' });
      previous.disabled = offset === 0;
      previous.dataset.paginationBoundaryDisabled = String(previous.disabled);
      const next = context.element('button', { text: 'Próxima' });
      next.disabled = offset + limit >= total;
      next.dataset.paginationBoundaryDisabled = String(next.disabled);
      node.append(previous, next);
    },
  };
  const source = announcements
    .replace(/^import[^\n]+\n/gm, '')
    .replace(/const user = await requireAuth\(\);\nif \(!user\) throw new Error\('Authentication required'\);\n/, '')
    .replace(/\nloadAnnouncements\(\);\nloadHighlight\(\);\nloadCategories\(\);\n}\s*$/, '\n}');
  vm.runInNewContext(mountSource(source, 'globalThis.loadAnnouncements = loadAnnouncements;'), context, { filename: 'announcements.js' });
  assert.equal(requests.length, 0, 'page loads are explicitly driven and awaited by each test');
  return { context, document, list, pagination, location, requests };
}

function loadKnowledgeHarness({ canManage = false } = {}) {
  const document = createTestDocument();
  const nodes = new Map();
  const ids = [
    ['button', 'btn-new'], ['input', 'search'], ['div', 'categories'], ['div', 'articles-list'],
    ['div', 'articles-pagination'], ['article', 'article-view'], ['div', 'modal-article'], ['form', 'article-form'],
    ['input', 'f-pdf'], ['input', 'f-pdf-state'], ['p', 'f-pdf-status'], ['button', 'f-pdf-remove'], ['textarea', 'f-content'],
    ['div', 'article-content'], ['h2', 'article-title'], ['span', 'article-category'], ['div', 'article-admin-bar'],
    ['span', 'modal-article-title'], ['input', 'f-title'], ['input', 'f-category'], ['button', 'modal-article-save'],
    ['button', 'modal-article-close'], ['button', 'modal-article-cancel'], ['button', 'btn-back'],
  ];
  ids.forEach(([tag, id]) => register(document, createTestNode(document, tag, id), nodes));
  const modal = nodes.get('modal-article');
  modal.className = 'modal-backdrop hidden';
  nodes.get('article-view').hidden = true;
  nodes.get('f-pdf').files = [];
  nodes.get('article-form').reportValidity = () => true;
  const main = createTestNode(document, 'main');
  const pageHeading = createTestNode(document, 'h1', 'knowledge-heading');
  main.append(pageHeading);
  document.body.append(main, ...nodes.values());
  document.getElementById = id => nodes.get(id) || null;
  document.querySelector = selector => selector.startsWith('main') ? pageHeading : null;
  const location = { href: 'https://portal.test/knowledge.html' };
  Object.defineProperty(location, 'search', { get() { return new URL(this.href).search; } });
  const history = {
    replaceState(_, __, href) { location.href = String(href); },
    pushState(_, __, href) { location.href = String(href); },
  };
  const listRequests = [];
  let activeListRequest;
  const detail = deferred();
  const detailRequests = [];
  const uploadRequests = [];
  const deleteRequests = [];
  const articleDeleteRequests = [];
  const saveRequests = [];
  const window = { listeners: new Map(), addEventListener(type, handler) { this.listeners.set(type, handler); }, confirm: () => true };
  const context = {
    document,
    window,
    location,
    history,
    URL,
    URLSearchParams,
    Map,
    Set,
    Number,
    String,
    Array,
    FormData,
    console,
    user: {},
    confirm: () => true,
    requireAuth: async () => ({}),
    showToast() {},
     can: () => canManage,
     setPaginationBusy(node, busy) {
       node?.setAttribute('aria-busy', String(busy));
       node?.querySelectorAll('button').forEach(button => { button.disabled = busy || button.dataset.paginationBoundaryDisabled === 'true'; });
     },
    fetchAPIPage: () => {
      activeListRequest = { page: deferred(), categories: deferred() };
      listRequests.push(activeListRequest);
      return activeListRequest.page.promise;
    },
     fetchAPI: (path, options = {}) => {
       if (path.endsWith('/categories')) return activeListRequest.categories.promise;
      if (path === '/api/cms/assets') {
        const request = deferred();
        uploadRequests.push(request);
        return request.promise;
      }
       if (path.startsWith('/api/cms/assets/')) {
         const request = deferred();
         deleteRequests.push(request);
         return request.promise;
       }
       if (path.startsWith('/api/knowledge/') && options.method === 'DELETE') {
         const request = deferred();
         articleDeleteRequests.push(request);
         return request.promise;
       }
       if (path === '/api/knowledge' || options.method === 'PUT') {
         const request = deferred();
         saveRequests.push({ path, options, ...request });
         return request.promise;
      }
       const request = detailRequests.length ? deferred() : detail;
       detailRequests.push(request);
       return request.promise;
    },
    clear(node) { node?.replaceChildren(); return node; },
    setBusy(node, busy) { node?.setAttribute('aria-busy', String(busy)); },
    element(tag, options = {}, children = []) {
      const node = createTestNode(document, tag);
      Object.entries(options).forEach(([key, value]) => {
        if (key === 'className') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'on') Object.entries(value).forEach(([event, handler]) => node.addEventListener(event, handler));
        else if (value !== undefined && value !== null) node.setAttribute(key, value);
      });
      node.append(...(Array.isArray(children) ? children : [children]));
      return node;
    },
    openDialog(node, focus) { node.classList.remove('hidden'); focus?.focus(); },
    closeDialog(node, force = false) {
      if (!force && !context.canCloseDialog(node)) return false;
      node.classList.add('hidden');
      return true;
    },
    setDialogCloseGuard(node, guard, { canLeave = guard } = {}) { node.closeGuard = guard; node.leaveGuard = canLeave; },
    canCloseDialog(node) {
      if (node.leaveGuard?.() === false) return false;
      if (node.formDirty && !context.window.confirm('Descartar alterações não salvas?')) return false;
      return node.closeGuard?.() !== false;
    },
    showState(node, message, retry) {
      const state = context.element('div', { role: retry ? 'alert' : 'status' }, [context.element('p', { text: message })]);
      if (retry) state.append(context.element('button', { text: 'Retry', on: { click: retry } }));
      context.clear(node).append(state);
      return state;
    },
    readOffset(search, limit) {
      const value = Number(search.get('offset') || 0);
      return Number.isInteger(value) && value >= 0 ? Math.floor(value / limit) * limit : 0;
    },
     renderPagination(node, total, offset, limit, onPage) {
       context.paginationCallback = onPage;
       context.clear(node);
       if (total <= limit) return;
       const pageCount = Math.ceil(total / limit);
       const page = Math.min(Math.floor(offset / limit), pageCount - 1);
       const previous = context.element('button', { text: 'Anterior', on: { click: () => onPage(Math.max(0, page - 1) * limit) } });
       previous.disabled = page === 0;
       previous.dataset.paginationBoundaryDisabled = String(previous.disabled);
       const next = context.element('button', { text: 'Próxima', on: { click: () => onPage((page + 1) * limit) } });
       next.disabled = page >= pageCount - 1;
       next.dataset.paginationBoundaryDisabled = String(next.disabled);
       node.append(previous, context.element('span', { text: `Página ${page + 1} de ${pageCount}` }), next);
     },
    blocksToText: blocks => blocks.map(block => block.text || '').join('\n'),
    renderBlocks(node, blocks, { fallbackText = '' } = {}) {
      context.clear(node);
      if (!Array.isArray(blocks) || !blocks.length) {
        if (fallbackText) node.append(context.element('p', { text: fallbackText }));
        return false;
      }
      blocks.forEach(block => node.append(context.element('p', { text: block.text || '' })));
      return true;
    },
  };
  const source = knowledge
    .replace(/^import[^\n]+\n/gm, '')
    .replace(/const user = await requireAuth\(\);\nif \(!user\) throw new Error\('Authentication required'\);\n/, '')
    .replace(/\nloadArticles\(\);\n}\s*$/, '\n}');
  vm.runInNewContext(mountSource(source, 'globalThis.loadArticles = loadArticles; globalThis.openArticle = openArticle; globalThis.editArticle = editArticle; globalThis.newArticle = newArticle; globalThis.deleteArticle = deleteArticle;'), context, { filename: 'knowledge.js' });
  return { context, document, nodes, location, listRequests, detail, detailRequests, uploadRequests, deleteRequests, articleDeleteRequests, saveRequests, window, pageHeading };
}

function loadUiHarness() {
  const document = createTestDocument();
  const trigger = createTestNode(document, 'button');
  const main = createTestNode(document, 'main');
  const dialog = createTestNode(document, 'div');
  const form = createTestNode(document, 'form');
  form.formValue = 'clean';
  dialog.append(form);
  dialog.className = 'hidden';
  document.body.append(main, dialog);
  document.querySelector = selector => selector.startsWith('main') ? main : null;
  class FakeFormData {
    constructor(node) { this.node = node; }
    entries() { return [['value', this.node.formValue]]; }
  }
  const context = {
    document,
    window: { confirm: () => true, addEventListener() {} },
    FormData: FakeFormData,
    URL,
    WeakMap,
    Map,
    Set,
    Symbol,
  };
  const source = ui.replace(/^export /gm, '') + '\nglobalThis.openDialog = openDialog; globalThis.closeDialog = closeDialog; globalThis.canCloseDialog = canCloseDialog; globalThis.setDialogCloseGuard = setDialogCloseGuard;';
  vm.runInNewContext(source, context, { filename: 'ui.js' });
  return { context, document, trigger, dialog, form };
}

function loadProfileCropHarness() {
  const document = createTestDocument();
  const nodes = new Map();
  const ids = [
    ['form', 'profile-form'], ['button', 'btn-save'], ['button', 'avatar-circle'], ['input', 'photo-input'],
    ['span', 'avatar-hint'], ['p', 'photo-feedback'], ['p', 'profile-feedback'], ['button', 'adjust-photo'],
    ['button', 'remove-photo'], ['button', 'btn-reset-pw'], ['p', 'pw-feedback'], ['dialog', 'photo-crop-dialog'],
    ['div', 'photo-crop-frame'], ['img', 'photo-crop-img'], ['button', 'photo-crop-close'],
    ['button', 'photo-crop-reset'], ['button', 'photo-crop-apply'], ['img', 'avatar-img'],
    ['span', 'avatar-initials'], ['input', 'p-name'], ['h1', 'profile-heading'],
  ];
  ids.forEach(([tag, id]) => register(document, createTestNode(document, tag, id), nodes));
  const profileForm = nodes.get('profile-form');
  const cropDialog = nodes.get('photo-crop-dialog');
  const cropFrame = nodes.get('photo-crop-frame');
  const cropImage = nodes.get('photo-crop-img');
  const cropCloseButton = nodes.get('photo-crop-close');
  const cropResetButton = nodes.get('photo-crop-reset');
  const cropApplyButton = nodes.get('photo-crop-apply');
  const avatarButton = nodes.get('avatar-circle');
  const adjustPhotoButton = nodes.get('adjust-photo');
  const removePhotoButton = nodes.get('remove-photo');
  const resetPasswordButton = nodes.get('btn-reset-pw');
  const opener = createTestNode(document, 'button');
  cropFrame.clientWidth = 100;
  cropFrame.clientHeight = 100;
  cropImage.naturalWidth = 200;
  cropImage.naturalHeight = 200;
  cropDialog.open = false;
  cropDialog.showModal = () => { cropDialog.open = true; };
  cropDialog.close = () => { cropDialog.open = false; };
  cropFrame.setPointerCapture = () => {};
  cropFrame.releasePointerCapture = () => {};
  document.body.append(...nodes.values(), opener);
  document.getElementById = id => nodes.get(id) || null;
  document.querySelector = selector => selector.startsWith('main') ? nodes.get('profile-heading') : null;
  const saveRequests = [];
  const source = [
    profile.slice(profile.indexOf('function setProfileActionsBusy'), profile.indexOf('\n\n// ── Avatar')),
    profile.slice(profile.indexOf('function avatarPhotoUrl'), profile.indexOf('\n\n// ── Upload')),
    profile.slice(profile.indexOf('function setFeedback'), profile.indexOf('\nif (Object.keys(user).length)')),
    profile.slice(profile.indexOf('function cropMetrics'), profile.indexOf('\nadjustPhotoButton.addEventListener')),
  ].join('\n');
  const listeners = profile.slice(profile.indexOf('adjustPhotoButton.addEventListener'), profile.lastIndexOf('}'));
  const context = {
    document,
    URL,
    location: { origin: 'https://portal.test' },
    page: activePageDouble,
    DEFAULT_MEDIA_CROP: { x: 0.5, y: 0.5, zoom: 1 },
    profileForm,
    saveButton: nodes.get('btn-save'),
    avatarButton,
    photoInput: nodes.get('photo-input'),
    avatarHint: nodes.get('avatar-hint'),
    photoFeedback: nodes.get('photo-feedback'),
    profileFeedback: nodes.get('profile-feedback'),
    adjustPhotoButton,
    removePhotoButton,
    resetPasswordButton,
    resetPasswordFeedback: nodes.get('pw-feedback'),
    cropDialog,
    cropFrame,
    cropImage,
    cropCloseButton,
    cropResetButton,
    cropApplyButton,
    profileActionButtons: [nodes.get('btn-save'), avatarButton, adjustPhotoButton, removePhotoButton, resetPasswordButton, cropCloseButton, cropResetButton, cropApplyButton],
    user: { name: 'User', email: 'user@example.test', photo_url: 'https://example.test/avatar.jpg', photo_crop: { x: 0.5, y: 0.5, zoom: 1 } },
    cropRenderStyle: () => 'transform: translate(0px, 0px)',
    dragMediaCrop: (value, { dx, dy }) => ({ ...value, x: value.x + dx / 100, y: value.y + dy / 100 }),
    normalizeMediaCrop: value => ({ x: Number(value?.x ?? 0.5), y: Number(value?.y ?? 0.5), zoom: Number(value?.zoom ?? 1) }),
    renderAvatar() {},
    showToast() {},
    fetchAPI(path, options) {
      const request = deferred();
      saveRequests.push({ path, options, ...request });
      return request.promise;
    },
  };
  vm.runInNewContext(`const cropFrameTabIndex = 0; const cropFramePointerEvents = ''; let avatarRenderToken = 0; let profileActionBusy = false; let cropDraft = null; let cropDrag = null; let cropOpener = null; let profileCrop = { x: 0.5, y: 0.5, zoom: 1 };
${source}
${listeners}
globalThis.profileCropHarness = { openCropDialog, closeCropDialog, saveCrop, draft: () => cropDraft && { ...cropDraft }, saved: () => ({ ...profileCrop }), busy: () => profileActionBusy };`, context, { filename: 'profile.js' });
  return { context, document, nodes, cropDialog, cropFrame, cropImage, cropCloseButton, cropResetButton, cropApplyButton, adjustPhotoButton, avatarButton, opener, saveRequests, harness: context.profileCropHarness };
}

function loadSidebarHarness() {
  const document = createTestDocument();
  const nodes = new Map();
  const navigation = createTestNode(document, 'aside');
  navigation.className = 'sidebar';
  const toggle = register(document, createTestNode(document, 'button', 'sidebar-toggle'), nodes);
  const link = createTestNode(document, 'a');
  link.setAttribute('href', './dashboard.html');
  const topbar = createTestNode(document, 'header');
  topbar.className = 'topbar';
  const mainContent = createTestNode(document, 'div');
  mainContent.className = 'main-content';
  navigation.append(toggle, link);
  document.body.append(navigation, mainContent);
  document.querySelector = selector => ({ '.sidebar': navigation, '.topbar': topbar, '.main-content': mainContent, '.sidebar-brand': null }[selector] || null);
  document.getElementById = id => nodes.get(id) || null;
  const media = { matches: true, listeners: [], addEventListener(_, handler) { this.listeners.push(handler); } };
  const context = {
    document,
    window: { matchMedia: () => media },
    localStorage: { values: new Map(), getItem(key) { return this.values.get(key) || null; }, setItem(key, value) { this.values.set(key, value); } },
  };
  vm.runInNewContext(sidebar.replace(/\(function \(\) \{/, '(function () {'), context, { filename: 'sidebar.js' });
  const mobileToggle = topbar.children[0];
  const overlay = document.body.children.find(child => child.className === 'sidebar-overlay');
  return { context, document, sidebar: navigation, toggle, link, topbar, mainContent, mobileToggle, overlay, media };
}

function cssColor(source, token) {
  const match = source.match(new RegExp(`${token}:\\s*#([0-9A-Fa-f]{6})`));
  assert.ok(match, `missing color token ${token}`);
  return match[1];
}

function luminance(hex) {
  const channels = hex.match(/../g).map(value => Number.parseInt(value, 16) / 255).map(value => (
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(first, second) {
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

test('element emits real HTML boolean attributes instead of truthy false strings', () => {
  const element = loadElement();
  const button = element('button', { disabled: false, hidden: false, required: false, 'aria-hidden': false });
  const video = element('video', { controls: '' });

  assert.equal(button.attributes.has('disabled'), false);
  assert.equal(button.attributes.has('hidden'), false);
  assert.equal(button.attributes.has('required'), false);
  assert.equal(button.attributes.get('aria-hidden'), 'false');
  assert.equal(video.attributes.get('controls'), '');
});

test('shared pagination busy state preserves first/last page button limits', async () => {
  const source = await readFile('public/js/pagination.js', 'utf8');
  const document = createTestDocument();
  document.createElement = tag => createTestNode(document, tag);
  const context = { document, Math, Number, String, Boolean };
  vm.runInNewContext(`${source.replace(/^export /gm, '')}\nglobalThis.renderPagination = renderPagination; globalThis.setPaginationBusy = setPaginationBusy;`, context, { filename: 'pagination.js' });

  const firstPage = createTestNode(document, 'div');
  context.renderPagination(firstPage, 40, 0, 20, () => {});
  context.setPaginationBusy(firstPage, true);
  context.setPaginationBusy(firstPage, false);
  const firstButtons = firstPage.querySelectorAll('button');
  assert.deepEqual(firstButtons.map(button => button.disabled), [true, false]);
  firstButtons[1].focus();
  firstButtons[0].focus();
  assert.equal(document.activeElement, firstButtons[1]);

  const lastPage = createTestNode(document, 'div');
  context.renderPagination(lastPage, 40, 20, 20, () => {});
  context.setPaginationBusy(lastPage, true);
  context.setPaginationBusy(lastPage, false);
  assert.deepEqual(lastPage.querySelectorAll('button').map(button => button.disabled), [false, true]);
});

test('fake DOM rejects focus on disabled nodes and inert ancestors', () => {
  const document = createTestDocument();
  const inertParent = createTestNode(document, 'div');
  const child = createTestNode(document, 'button');
  inertParent.append(child);
  document.body.append(inertParent);
  inertParent.inert = true;
  child.focus();
  assert.equal(document.activeElement, document.body);
  inertParent.inert = false;
  child.disabled = true;
  child.focus();
  assert.equal(document.activeElement, document.body);
  child.disabled = false;
  child.focus();
  assert.equal(document.activeElement, child);
});

test('shell keeps a named collapse control visible and exposes state to assistive technology', () => {
  assert.match(sidebar, /collapsed \? 'Expandir menu' : 'Recolher menu'/);
  assert.match(sidebar, /toggle\?\.setAttribute\('aria-expanded', String\(expanded\)\)/);
  assert.match(sidebar, /sidebar\.setAttribute\('aria-hidden', String\(isMobile && !drawerOpen\)\)/);
  assert.match(sidebar, /sidebar\.inert = isMobile && !drawerOpen/);
  assert.match(sidebar, /mainContent\.inert = isMobile && drawerOpen/);
  assert.match(sidebar, /mobileMedia\.addEventListener\('change'/);
  const collapsedToggle = layout.match(/body\.sidebar-collapsed \.sidebar-toggle\s*\{([^}]*)\}/)?.[1] || '';
  assert.match(collapsedToggle, /position:\s*absolute/);
  assert.doesNotMatch(collapsedToggle, /display:\s*none/);
  assert.match(layout, /\.sidebar :focus-visible/);
});

test('CSP-safe typography and contrast tokens do not depend on remote font loading', () => {
  assert.doesNotMatch(tokens, /@font-face|fonts\.gstatic\.com|Raleway/);
  assert.match(tokens, /--font-display:\s*Arial, sans-serif/);
  assert.match(nginx, /font-src 'self'/);
  assert.ok(contrast(cssColor(tokens, '--text-secondary'), cssColor(tokens, '--bg')) >= 4.5);
  assert.ok(contrast(cssColor(tokens, '--focus'), cssColor(tokens, '--bg')) >= 3);
});

test('requests keep current content pending and reject stale filtered responses', () => {
  for (const [source, token] of [[dashboard, 'announcementsRequest'], [dashboard, 'remindersRequest'], [dashboard, 'academyRequest'], [knowledge, 'articlesRequest'], [academy, 'coursesRequest'], [announcements, 'announcementsRequest']]) {
    assert.match(source, new RegExp(`let ${token} = 0`));
    assert.match(source, /setBusy\(/);
    assert.match(source, /finally/);
    assert.match(source, /requestToken !==/);
  }
  assert.doesNotMatch(knowledge.slice(knowledge.indexOf('async function loadArticles'), knowledge.indexOf('\n\nfunction newArticle')), /showState\(listNode, 'Carregando artigos/);
  assert.doesNotMatch(academy.slice(academy.indexOf('async function loadCourses'), academy.indexOf('\n\nwindow.addEventListener')), /showState\(container, 'Carregando cursos/);
  assert.match(knowledge, /if \(!articles\.length && offset > 0\)/);
  assert.match(academy, /if \(!courses\.length && offset > 0\)/);
  assert.match(announcements, /if \(!announcements\.length && offset > 0\)/);
  assert.match(knowledge, /function normalizeCategories/);
  assert.match(academy, /function normalizeCategories/);
  assert.match(profile, /const initialFocus = document\.activeElement/);
  assert.match(profile, /const focusLost =/);
  assert.match(profile, /profileFormSnapshot/);
  assert.match(profile, /changedDuringRequest/);
  assert.match(profile, /hasPendingFormChanges/);
});

test('focus fallback helpers reject inert targets and inert ancestors', () => {
  for (const source of [knowledge, academy, announcements]) {
    assert.match(source, /function hasInertAncestor/);
    assert.match(source, /!node\.inert && !hasInertAncestor\(node\)/);
  }
  assert.match(ui, /function hasUnavailableAncestor/);
  assert.match(ui, /!node\.disabled && !node\.inert && !hasUnavailableAncestor\(node\)/);
});

test('catalog cards and dashboard stories never put CMS links inside another anchor', () => {
  assert.match(dashboard, /return element\('article', \{ className: 'dashboard-story-card'/);
  assert.match(academy, /const card = element\('article', \{ className: 'card link-card'/);
  assert.doesNotMatch(dashboard, /element\(href \? 'a'/);
  assert.match(renderer, /Abrir PDF em nova aba/);
  assert.match(renderer, /A acessibilidade do arquivo depende do documento PDF original/);
});

test('mobile shell retains zoom, reflow, keyboard focus, and reduced-motion invariants', async () => {
  const pages = await Promise.all(['dashboard', 'knowledge', 'academy', 'announcements', 'profile'].map(page => readFile(`public/${page}.html`, 'utf8')));
  for (const html of pages) {
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/);
    assert.doesNotMatch(html, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1/i);
  }
  assert.match(`${layout}\n${components}\n${dashboardHome}\n${knowledgeCss}`, /@media \(max-width: 768px\)/);
  assert.match(`${layout}\n${components}\n${dashboardHome}\n${knowledgeCss}`, /@media \(max-width: 420px\)/);
  assert.match(dashboardHome, /@media \(max-width: 390px\)/, '320px view has a narrow dashboard rule');
  assert.match(layout, /\.main-content, body\.sidebar-collapsed \.main-content \{ margin-left: 0; min-width: 0; \}/);
  assert.match(layout, /\.topbar-title[^}]*overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(layout, /\.topbar-title \{[^}]*text-overflow:\s*ellipsis/);
  assert.match(`${layout}\n${components}\n${dashboardHome}\n${knowledgeCss}`, /prefers-reduced-motion:\s*reduce/);
  assert.match(`${components}\n${dashboardHome}\n${knowledgeCss}\n${cmsCss}`, /overflow-wrap:\s*anywhere/);
  assert.match(components, /\.cms-pdf-frame\s*\{[^}]*height:\s*min\(80dvh/);
  assert.match(cmsCss, /\.cms-pdf-frame\s*\{[^}]*width:\s*100%/);
  assert.match(`${components}\n${knowledgeCss}`, /outline:\s*3px solid var\(--focus\)/);
});

test('initial navigation keeps Benefits and Sólides out while Academy remains a catalog', async () => {
  const [generator, dashboardHtml, academyHtml, benefitsHtml] = await Promise.all([
    readFile('scripts/generate-public-shell.mjs', 'utf8'),
    readFile('public/dashboard.html', 'utf8'),
    readFile('public/academy.html', 'utf8'),
    readFile('public/benefits.html', 'utf8'),
  ]);
  const pages = generator.match(/const pages = \[[\s\S]*?\n\];/)?.[0] || '';
  assert.doesNotMatch(pages, /benefits|solides/i);
  assert.doesNotMatch(dashboardHtml, /benefits\.html|Benefícios|solides\.html|Sólides/);
  assert.match(academyHtml, /Filtrar cursos por categoria/);
  assert.match(benefitsHtml, /id="benefits-content"/);
});

test('Academy ignores stale filter and pagination handlers while a newer request is pending', async () => {
  const harness = loadAcademyHarness();
  const firstLoad = harness.context.loadCourses();
  harness.requests[0].page.resolve({ data: [{ active: true, title: 'Curso', category: 'Geral', url: 'https://example.test' }], total: 40 });
  harness.requests[0].categories.resolve(['todos', 'Geral']);
  await firstLoad;

  const oldFilter = harness.filters.children.find(button => button.dataset.category === 'todos');
  const oldPagination = harness.context.paginationCallback;
  const oldUrl = harness.location.href;
  const secondLoad = harness.context.loadCourses();
  assert.equal(oldFilter.disabled, true);
  oldFilter.dispatch('click');
  oldPagination(20);
  assert.equal(harness.location.href, oldUrl);

  harness.requests[1].page.resolve({ data: [{ active: true, title: 'Curso atual', category: 'Geral', url: 'https://example.test' }], total: 40 });
  harness.requests[1].categories.resolve(['todos', 'Geral']);
  await secondLoad;
  assert.equal(harness.filters.children.find(button => button.dataset.category === 'todos').textContent, 'todos (categoria)');
});

test('Academy restores pagination focus to the category fallback when a page becomes single or empty', async () => {
  const loadPage = async (harness, result) => {
    const request = harness.context.loadCourses();
    const pending = harness.requests.at(-1);
    pending.page.resolve(result);
    pending.categories.resolve(['todos', 'Geral']);
    await request;
  };

  const single = loadAcademyHarness();
  await loadPage(single, { data: [{ active: true, title: 'Curso', category: 'Geral', url: 'https://example.test' }], total: 40 });
   single.pagination.querySelectorAll('button').find(button => !button.disabled).focus();
  await loadPage(single, { data: [{ active: true, title: 'Último curso', category: 'Geral', url: 'https://example.test' }], total: 1 });
  assert.equal(single.document.activeElement.closest('#academy-filters'), single.filters);

  const empty = loadAcademyHarness();
  await loadPage(empty, { data: [{ active: true, title: 'Curso', category: 'Geral', url: 'https://example.test' }], total: 40 });
   empty.pagination.querySelectorAll('button').find(button => !button.disabled).focus();
  await loadPage(empty, { data: [], total: 0 });
  assert.equal(empty.document.activeElement.closest('#academy-filters'), empty.filters);
});

test('Academy falls back when a total change makes the equivalent pagination button disabled', async () => {
  const harness = loadAcademyHarness();
  const first = harness.context.loadCourses();
  harness.requests[0].page.resolve({ data: [{ active: true, title: 'Primeiro', category: 'Geral', url: 'https://example.test' }], total: 40 });
  harness.requests[0].categories.resolve(['Geral']);
  await first;

  const next = harness.pagination.querySelectorAll('button').find(button => button.textContent === 'Próxima');
  next.focus();
  harness.context.paginationCallback(20);
  const second = harness.requests[1];
  second.page.resolve({ data: [{ active: true, title: 'Último', category: 'Geral', url: 'https://example.test' }], total: 35 });
  second.categories.resolve(['Geral']);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.document.activeElement.closest('#academy-filters'), harness.filters);
  assert.equal(harness.pagination.querySelectorAll('button').find(button => button.textContent === 'Próxima').disabled, true);
});

test('Academy focuses the retry button after an initial load error', async () => {
  const harness = loadAcademyHarness();
  const request = harness.context.loadCourses();
  harness.requests[0].page.reject(new Error('network'));
  harness.requests[0].categories.resolve([]);
  await request;

  const state = harness.container.children[0];
  const retry = state.children[0];
  assert.equal(harness.document.activeElement, retry);
  assert.equal(retry.disabled, false);
  assert.equal(retry.hidden, false);
  assert.equal(retry.inert, false);
});

test('Academy focuses the replacement retry button after a repeated retry error', async () => {
  const harness = loadAcademyHarness();
  const first = harness.context.loadCourses();
  harness.requests[0].page.reject(new Error('network'));
  harness.requests[0].categories.resolve([]);
  await first;

  const oldRetry = harness.container.children[0].children[0];
  oldRetry.focus();
  oldRetry.isConnected = false;
  oldRetry.dispatch('click');
  harness.requests[1].page.reject(new Error('network again'));
  harness.requests[1].categories.resolve([]);
  await new Promise(resolve => setImmediate(resolve));

  const replacement = harness.container.children[0].children[0];
  assert.notEqual(replacement, oldRetry);
  assert.equal(harness.document.activeElement, replacement);
  assert.equal(replacement.disabled, false);
  assert.equal(replacement.hidden, false);
  assert.equal(replacement.inert, false);
});

test('Announcements preserves pagination focus and boundary buttons after a deferred page load', async () => {
  const harness = loadAnnouncementsHarness();
  const firstLoad = harness.context.loadAnnouncements();
  harness.requests[0].page.resolve({
    data: [{ id: 'announcement-1', title: 'Primeiro', category: 'Geral', content_blocks: [] }],
    total: 20,
  });
  await firstLoad;

  const oldNext = harness.pagination.querySelectorAll('button')[1];
  oldNext.focus();
  harness.context.paginationCallback(10);
  assert.match(harness.location.href, /offset=10/);
  assert.equal(harness.requests.length, 2);
   harness.requests[1].page.resolve({
     data: [{ id: 'announcement-2', title: 'Segundo', category: 'Geral', content_blocks: [] }],
     total: 15,
   });
   await new Promise(resolve => setImmediate(resolve));

   const buttons = harness.pagination.querySelectorAll('button');
   assert.equal(harness.document.activeElement.textContent, 'Segundo');
   assert.deepEqual(buttons.map(button => button.disabled), [false, true]);
});

test('Announcements restores pagination focus to the list or empty state when controls disappear', async () => {
  const single = loadAnnouncementsHarness();
  const first = single.context.loadAnnouncements();
  single.requests[0].page.resolve({ data: [{ id: 'one', title: 'Primeiro', content_blocks: [] }], total: 20 });
  await first;
   single.pagination.querySelectorAll('button').find(button => !button.disabled).focus();
  const second = single.context.loadAnnouncements();
  single.requests[1].page.resolve({ data: [{ id: 'last', title: 'Último', content_blocks: [] }], total: 1 });
  await second;
  assert.equal(single.document.activeElement.tagName, 'A');
  assert.equal(single.document.activeElement.textContent, 'Último');

  const empty = loadAnnouncementsHarness();
  const initial = empty.context.loadAnnouncements();
  empty.requests[0].page.resolve({ data: [{ id: 'one', title: 'Primeiro', content_blocks: [] }], total: 20 });
  await initial;
   empty.pagination.querySelectorAll('button').find(button => !button.disabled).focus();
  const emptyPage = empty.context.loadAnnouncements();
  empty.requests[1].page.resolve({ data: [], total: 0 });
  await emptyPage;
  assert.match(empty.document.activeElement.textContent, /Nenhuma publicação nesta editoria/);
});

test('Knowledge preserves legacy fallback, hides list pagination in detail, and does not steal moved focus', async () => {
  const harness = loadKnowledgeHarness();
  const search = harness.nodes.get('search');
  search.focus();
  const request = harness.context.openArticle('article-1', false);
  search.focus();
  harness.detail.resolve({ id: 'article-1', title: 'Artigo legado', category: 'Geral', content: 'Texto legado', content_blocks: [] });
  await request;

  assert.equal(harness.document.activeElement, search);
  assert.equal(harness.nodes.get('articles-pagination').hidden, true);
  assert.equal(harness.nodes.get('article-content').children[0].textContent, 'Texto legado');
  assert.equal(harness.nodes.get('article-view').hidden, false);
});

test('Knowledge 404/null detail responses return to visible list controls without stealing moved focus', async () => {
  const notFound = loadKnowledgeHarness();
  const search = notFound.nodes.get('search');
  search.focus();
  const missing = notFound.context.openArticle('missing', false);
  search.focus();
  notFound.detail.reject({ status: 404 });
  await missing;
  assert.equal(notFound.document.activeElement, search);
  assert.equal(notFound.nodes.get('article-view').hidden, true);

  const empty = loadKnowledgeHarness();
  const emptySearch = empty.nodes.get('search');
  emptySearch.focus();
  const emptyRequest = empty.context.openArticle('empty', false);
  emptySearch.focus();
  empty.detail.resolve(null);
  await emptyRequest;
  assert.equal(empty.document.activeElement, emptySearch);
  assert.equal(empty.nodes.get('articles-pagination').hidden, false);
});

test('Knowledge keeps moved focus on detail errors and ignores stale filtered results', async () => {
  const failed = loadKnowledgeHarness();
  const search = failed.nodes.get('search');
  search.focus();
  const detailRequest = failed.context.openArticle('broken', false);
  search.focus();
  failed.detail.reject(new Error('network'));
  await detailRequest;
  assert.equal(failed.document.activeElement, search);
  assert.equal(failed.nodes.get('article-title').textContent, 'Não foi possível carregar o artigo.');

  const filtered = loadKnowledgeHarness();
  const filteredSearch = filtered.nodes.get('search');
  filteredSearch.value = 'antigo';
  filteredSearch.dispatch('input');
  const first = filtered.listRequests[0];
  filteredSearch.value = 'atual';
  filteredSearch.dispatch('input');
  const second = filtered.listRequests[1];
  second.page.resolve({ data: [{ id: 'current', title: 'Atual', category: 'Geral', content: 'Atual' }], total: 1 });
  second.categories.resolve(['all']);
  first.page.resolve({ data: [{ id: 'old', title: 'Antigo', category: 'Geral', content: 'Antigo' }], total: 1 });
  first.categories.resolve(['all']);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(filtered.location.href, /q=atual/);
  assert.match(filtered.nodes.get('articles-list').textContent, /Atual/);
  assert.doesNotMatch(filtered.nodes.get('articles-list').textContent, /Antigo/);
});

test('Knowledge delete from detail restores a visible list destination instead of the hidden delete button', async () => {
  const harness = loadKnowledgeHarness({ canManage: true });
  const detailRequest = harness.context.openArticle('article-1', false);
  harness.detail.resolve({ id: 'article-1', title: 'Artigo', category: 'Geral', content: 'Texto', content_blocks: [] });
  await detailRequest;

  const deleteButton = harness.nodes.get('article-admin-bar').children[1];
  deleteButton.focus();
  const deleting = harness.context.deleteArticle('article-1');
  assert.equal(harness.articleDeleteRequests.length, 1);
  harness.articleDeleteRequests[0].resolve({});
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.listRequests.length, 1);
  harness.listRequests[0].page.resolve({ data: [{ id: 'remaining', title: 'Restante', category: 'Geral', content: 'Texto' }], total: 1 });
  harness.listRequests[0].categories.resolve(['all']);
  await deleting;

  assert.equal(harness.nodes.get('article-view').hidden, true);
  assert.equal(harness.document.activeElement, harness.pageHeading);
  assert.notEqual(harness.document.activeElement, deleteButton);
  assert.equal(harness.pageHeading.tabIndex, -1);
});

test('Knowledge ignores a stale detail DELETE after navigation to another article', async () => {
  const harness = loadKnowledgeHarness({ canManage: true });
  const firstArticle = harness.context.openArticle('article-1', false);
  harness.detail.resolve({ id: 'article-1', title: 'Artigo antigo', category: 'Geral', content: 'Antigo', content_blocks: [] });
  await firstArticle;

  const oldDeleteButton = harness.nodes.get('article-admin-bar').children[1];
  oldDeleteButton.focus();
  const deleting = harness.context.deleteArticle('article-1');
  assert.equal(oldDeleteButton.disabled, true);

  const secondArticle = harness.context.openArticle('article-2');
  assert.equal(harness.detailRequests.length, 2);
  harness.detailRequests[1].resolve({ id: 'article-2', title: 'Artigo novo', category: 'Geral', content: 'Novo', content_blocks: [] });
  await secondArticle;
  assert.match(harness.location.href, /article=article-2/);
  assert.equal(harness.nodes.get('article-title').textContent, 'Artigo novo');

  harness.articleDeleteRequests[0].resolve({});
  await deleting;
  await new Promise(resolve => setImmediate(resolve));
  assert.match(harness.location.href, /article=article-2/);
  assert.equal(harness.nodes.get('article-title').textContent, 'Artigo novo');
  assert.equal(harness.listRequests.length, 0);
});

test('Knowledge ignores stale pagination callbacks after a newer page request starts', async () => {
  const harness = loadKnowledgeHarness();
  const firstLoad = harness.context.loadArticles();
  harness.listRequests[0].page.resolve({ data: [{ id: 'article-1', title: 'Artigo', category: 'Geral', content: 'Texto' }], total: 40 });
  harness.listRequests[0].categories.resolve(['all']);
  await firstLoad;

  const oldPagination = harness.context.paginationCallback;
  const oldUrl = harness.location.href;
  const secondLoad = harness.context.loadArticles();
  oldPagination(20);
  assert.equal(harness.location.href, oldUrl);
  harness.listRequests[1].page.resolve({ data: [{ id: 'article-2', title: 'Artigo atual', category: 'Geral', content: 'Atual' }], total: 40 });
  harness.listRequests[1].categories.resolve(['all']);
  await secondLoad;
});

test('Knowledge restores pagination focus to categories when a page becomes single or empty', async () => {
  const loadPage = async (harness, result) => {
    const request = harness.context.loadArticles();
    const pending = harness.listRequests.at(-1);
    pending.page.resolve(result);
    pending.categories.resolve(['all']);
    await request;
  };

  const single = loadKnowledgeHarness();
  await loadPage(single, { data: [{ id: 'one', title: 'Primeiro', category: 'Geral', content: 'Texto' }], total: 40 });
   single.nodes.get('articles-pagination').querySelectorAll('button').find(button => !button.disabled).focus();
  await loadPage(single, { data: [{ id: 'last', title: 'Último', category: 'Geral', content: 'Texto' }], total: 1 });
  assert.equal(single.document.activeElement.closest('#categories'), single.nodes.get('categories'));

  const empty = loadKnowledgeHarness();
  await loadPage(empty, { data: [{ id: 'one', title: 'Primeiro', category: 'Geral', content: 'Texto' }], total: 40 });
   empty.nodes.get('articles-pagination').querySelectorAll('button').find(button => !button.disabled).focus();
  await loadPage(empty, { data: [], total: 0 });
  assert.equal(empty.document.activeElement.closest('#categories'), empty.nodes.get('categories'));
});

test('Knowledge falls back when a total change makes the equivalent pagination button disabled', async () => {
  const harness = loadKnowledgeHarness();
  const first = harness.context.loadArticles();
  harness.listRequests[0].page.resolve({ data: [{ id: 'one', title: 'Primeiro', category: 'Geral', content: 'Texto' }], total: 40 });
  harness.listRequests[0].categories.resolve(['all']);
  await first;

  const next = harness.nodes.get('articles-pagination').querySelectorAll('button').find(button => button.textContent === 'Próxima');
  next.focus();
  harness.context.paginationCallback(20);
  const second = harness.listRequests[1];
  second.page.resolve({ data: [{ id: 'last', title: 'Último', category: 'Geral', content: 'Texto' }], total: 25 });
  second.categories.resolve(['all']);
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.document.activeElement.closest('#categories'), harness.nodes.get('categories'));
  assert.equal(harness.nodes.get('articles-pagination').querySelectorAll('button').find(button => button.textContent === 'Próxima').disabled, true);
});

test('Knowledge disables editor fields for the full deferred save and preserves the modal on failure', async () => {
  const harness = loadKnowledgeHarness();
  harness.nodes.get('modal-article').classList.remove('hidden');
  const form = harness.nodes.get('article-form');
  harness.nodes.get('f-title').value = 'Título';
  harness.nodes.get('f-category').value = 'Categoria';
  harness.nodes.get('f-content').value = 'Conteúdo';
  form.dispatch('submit', { currentTarget: form });
  assert.equal(harness.saveRequests.length, 1);
  assert.equal(harness.nodes.get('f-title').disabled, true);
  assert.equal(harness.nodes.get('f-category').disabled, true);
  assert.equal(harness.nodes.get('f-content').disabled, true);
  assert.equal(harness.nodes.get('modal-article-save').disabled, true);
  assert.equal(harness.nodes.get('modal-article').closeGuard(), false);

  harness.saveRequests[0].reject(new Error('save failed'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.nodes.get('f-title').disabled, false);
  assert.equal(harness.nodes.get('f-category').disabled, false);
  assert.equal(harness.nodes.get('f-content').disabled, false);
  assert.equal(harness.nodes.get('modal-article-save').disabled, false);
  assert.equal(harness.nodes.get('modal-article').classList.contains('hidden'), false);
});

test('Knowledge popstate restores the previous URL when dirty modal navigation is cancelled', () => {
  const harness = loadKnowledgeHarness();
  const modal = harness.nodes.get('modal-article');
  modal.classList.remove('hidden');
  modal.formDirty = true;
  const previousUrl = harness.location.href;
  harness.window.confirm = () => false;
  harness.location.href = `${previousUrl}?article=next`;
  harness.window.listeners.get('popstate')();
  assert.equal(harness.location.href, previousUrl);
  assert.equal(modal.classList.contains('hidden'), false);
});

test('Knowledge back navigation from a detail view restores focus to visible list controls', async () => {
  const harness = loadKnowledgeHarness();
  const detail = harness.context.openArticle('article-1', false);
  harness.detail.resolve({ id: 'article-1', title: 'Artigo', category: 'Geral', content: 'Texto', content_blocks: [] });
  await detail;
  const detailTitle = harness.nodes.get('article-title');
  assert.equal(harness.document.activeElement, detailTitle);

  harness.location.href = 'https://portal.test/knowledge.html';
  harness.window.listeners.get('popstate')();
  assert.equal(harness.listRequests.length, 1);
  harness.listRequests[0].page.resolve({ data: [{ id: 'remaining', title: 'Restante', category: 'Geral', content: 'Texto' }], total: 1 });
  harness.listRequests[0].categories.resolve(['Geral']);
  await new Promise(resolve => setImmediate(resolve));

  assert.notEqual(harness.document.activeElement, detailTitle);
  assert.equal(harness.document.activeElement.closest('#article-view'), null);
  assert.equal(harness.document.activeElement.disabled, false);
  assert.equal(harness.document.activeElement.inert, false);
});

test('Knowledge back navigation exposes a visible list retry state when loading fails', async () => {
  const harness = loadKnowledgeHarness();
  const detail = harness.context.openArticle('article-1', false);
  harness.detail.resolve({ id: 'article-1', title: 'Artigo', category: 'Geral', content: 'Texto', content_blocks: [] });
  await detail;

  const detailTitle = harness.nodes.get('article-title');
  harness.location.href = 'https://portal.test/knowledge.html';
  harness.window.listeners.get('popstate')();
  assert.equal(harness.nodes.get('article-view').hidden, true);
  assert.equal(harness.nodes.get('articles-list').hidden, false);
  assert.equal(harness.nodes.get('categories').hidden, false);
  assert.equal(harness.nodes.get('articles-pagination').hidden, false);

  harness.listRequests[0].page.reject(new Error('network'));
  harness.listRequests[0].categories.resolve(['Geral']);
  await new Promise(resolve => setImmediate(resolve));

  const state = harness.nodes.get('articles-list').children[0];
  assert.match(state.textContent, /Não foi possível carregar os artigos/);
  assert.equal(state.getAttribute('role'), 'alert');
  assert.equal(harness.document.activeElement, state.querySelector('button'));
  assert.notEqual(harness.document.activeElement, detailTitle);
  assert.equal(harness.document.activeElement.closest('#article-view'), null);
});

test('Knowledge blocks PDF close while pending and deletes a newly uploaded asset before closing', async () => {
  const harness = loadKnowledgeHarness();
  const pdfInput = harness.nodes.get('f-pdf');
  pdfInput.files = [{ type: 'application/pdf', size: 10 }];
  pdfInput.dispatch('change');
  assert.equal(harness.nodes.get('modal-article').closeGuard(), false);

  harness.uploadRequests[0].resolve({ id: 'asset-1', original_name: 'manual.pdf' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(harness.nodes.get('f-pdf-status').textContent, /Selecionado: manual\.pdf/);

  harness.nodes.get('f-pdf-remove').focus();
  assert.equal(harness.nodes.get('modal-article').closeGuard(), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.deleteRequests.length, 1);
  harness.deleteRequests[0].resolve({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.nodes.get('modal-article').classList.contains('hidden'), true);
  assert.equal(harness.document.activeElement, harness.nodes.get('f-pdf'));
});

test('Knowledge moves focus to the PDF input when synchronous removal hides the focused remove button', () => {
  const harness = loadKnowledgeHarness();
  harness.context.editArticle({ id: 'article-1', title: 'Artigo', category: 'Geral', content: '', content_blocks: [
    { type: 'pdf', asset_id: 'persisted-pdf', title: 'manual.pdf' },
  ] });
  const remove = harness.nodes.get('f-pdf-remove');
  remove.focus();
  remove.dispatch('click');
  assert.equal(harness.document.activeElement, harness.nodes.get('f-pdf'));
  assert.equal(remove.hidden, true);
});

test('Knowledge treats a referenced-asset DELETE conflict as preserved, never as a client-side deletion', async () => {
  const harness = loadKnowledgeHarness();
  const input = harness.nodes.get('f-pdf');
  input.files = [{ type: 'application/pdf', size: 10 }];
  input.dispatch('change');
  harness.uploadRequests[0].resolve({ id: 'referenced-asset', original_name: 'manual.pdf' });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.nodes.get('modal-article').closeGuard(), false);
  await new Promise(resolve => setImmediate(resolve));
  harness.deleteRequests[0].reject({ status: 409, reason: 'referenced', message: 'referenced' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.nodes.get('modal-article').classList.contains('hidden'), true);
});

test('Knowledge keeps pending PDF cleanup in the session and retries 202/already-deleting results', async () => {
  const upload = async (harness, id) => {
    const input = harness.nodes.get('f-pdf');
    input.files = [{ type: 'application/pdf', size: 10 }];
    input.dispatch('change');
    harness.uploadRequests[0].resolve({ id, original_name: 'manual.pdf' });
    await new Promise(resolve => setImmediate(resolve));
  };

  const pending = loadKnowledgeHarness();
  await upload(pending, 'pending-asset');
  pending.nodes.get('modal-article').classList.remove('hidden');
  pending.nodes.get('f-pdf-remove').focus();
  assert.equal(pending.nodes.get('modal-article').closeGuard(), false);
  await new Promise(resolve => setImmediate(resolve));
  pending.deleteRequests[0].resolve({ error: 'Asset cleanup is pending.', reason: 'pending' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.nodes.get('modal-article').classList.contains('hidden'), false);
  assert.match(pending.nodes.get('f-pdf-status').textContent, /ainda está pendente/);
  assert.equal(pending.nodes.get('modal-article').closeGuard(), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.deleteRequests.length, 2);
  pending.deleteRequests[1].resolve({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(pending.nodes.get('modal-article').classList.contains('hidden'), true);

  const inProgress = loadKnowledgeHarness();
  await upload(inProgress, 'in-progress-asset');
  inProgress.nodes.get('modal-article').classList.remove('hidden');
  inProgress.nodes.get('f-pdf-remove').focus();
  assert.equal(inProgress.nodes.get('modal-article').closeGuard(), false);
  await new Promise(resolve => setImmediate(resolve));
  inProgress.deleteRequests[0].reject({ status: 409, reason: 'already_deleting', message: 'already deleting' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inProgress.nodes.get('modal-article').classList.contains('hidden'), false);
  assert.match(inProgress.nodes.get('f-pdf-status').textContent, /já está em andamento/);
});

test('Knowledge deletes a stale PDF upload that resolves after a newer valid selection', async () => {
  const harness = loadKnowledgeHarness();
  const input = harness.nodes.get('f-pdf');
  const file = { type: 'application/pdf', size: 10 };

  input.files = [file];
  input.dispatch('change');
  input.files = [file];
  input.dispatch('change');
  assert.equal(harness.uploadRequests.length, 2);

  harness.uploadRequests[1].resolve({ id: 'newer-asset', original_name: 'newer.pdf' });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(harness.nodes.get('f-pdf-status').textContent, /Selecionado: newer\.pdf/);

  harness.uploadRequests[0].resolve({ id: 'stale-asset', original_name: 'stale.pdf' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.deleteRequests.length, 1);
  harness.deleteRequests[0].resolve({});
  await new Promise(resolve => setImmediate(resolve));
  assert.match(harness.nodes.get('f-pdf-status').textContent, /Selecionado: newer\.pdf/);
  assert.equal(JSON.parse(harness.nodes.get('f-pdf-state').value).selected, 'newer-asset');
});

test('Knowledge invalid PDF selection invalidates an active upload and cleans its late response', async () => {
  const harness = loadKnowledgeHarness();
  const input = harness.nodes.get('f-pdf');
  input.files = [{ type: 'application/pdf', size: 10 }];
  input.dispatch('change');
  input.files = [{ type: 'text/plain', size: 10 }];
  input.dispatch('change');
  assert.match(harness.nodes.get('f-pdf-status').textContent, /PDF válido/);

  harness.uploadRequests[0].resolve({ id: 'invalidated-asset', original_name: 'late.pdf' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.deleteRequests.length, 1);
  harness.deleteRequests[0].resolve({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(input.disabled, false);
  assert.equal(JSON.parse(harness.nodes.get('f-pdf-state').value).pending, false);
});

test('Knowledge switches a newly created article to PUT before retrying pending PDF cleanup', async () => {
  const harness = loadKnowledgeHarness();
  const input = harness.nodes.get('f-pdf');
  const form = harness.nodes.get('article-form');
  harness.nodes.get('modal-article').classList.remove('hidden');
  harness.nodes.get('f-title').value = 'Novo artigo';
  harness.nodes.get('f-category').value = 'Geral';
  harness.nodes.get('f-content').value = 'Conteúdo';

  const upload = async (id, name) => {
    input.files = [{ type: 'application/pdf', size: 10 }];
    input.dispatch('change');
    harness.uploadRequests.at(-1).resolve({ id, original_name: name });
    await new Promise(resolve => setImmediate(resolve));
  };

  await upload('first-asset', 'first.pdf');
  await upload('selected-asset', 'selected.pdf');
  assert.equal(harness.deleteRequests.length, 1);
  harness.deleteRequests[0].resolve({ reason: 'pending' });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  form.dispatch('submit', { currentTarget: form });
  assert.equal(harness.saveRequests[0].options.method, 'POST');
  harness.saveRequests[0].resolve({ id: 'created-article' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.deleteRequests.length, 2);
  harness.deleteRequests[1].resolve({ reason: 'pending' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.nodes.get('modal-article').classList.contains('hidden'), false);
  assert.equal(harness.nodes.get('modal-article-title').textContent, 'Editar Artigo');

  form.dispatch('submit', { currentTarget: form });
  assert.equal(harness.saveRequests[1].path, '/api/knowledge/created-article');
  assert.equal(harness.saveRequests[1].options.method, 'PUT');
  harness.saveRequests[1].resolve({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.deleteRequests.length, 3);
  harness.deleteRequests[2].resolve({});
  await new Promise(resolve => setImmediate(resolve));
  if (harness.listRequests[0]) {
    harness.listRequests[0].page.resolve({ data: [], total: 0 });
    harness.listRequests[0].categories.resolve(['all']);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(harness.nodes.get('modal-article').classList.contains('hidden'), true);
});

test('Knowledge cleans every replaced PDF asset on close and keeps only the saved asset', async () => {
  const upload = async (harness, id, name) => {
    const input = harness.nodes.get('f-pdf');
    input.files = [{ type: 'application/pdf', size: 10 }];
    input.dispatch('change');
    harness.uploadRequests.at(-1).resolve({ id, original_name: name });
    await new Promise(resolve => setImmediate(resolve));
  };

  const closing = loadKnowledgeHarness();
  await upload(closing, 'asset-a', 'a.pdf');
  closing.nodes.get('f-pdf').files = [{ type: 'application/pdf', size: 10 }];
  closing.nodes.get('f-pdf').dispatch('change');
  closing.uploadRequests.at(-1).resolve({ id: 'asset-b', original_name: 'b.pdf' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closing.deleteRequests.length, 1);
  closing.deleteRequests[0].resolve({});
  await new Promise(resolve => setImmediate(resolve));
  closing.nodes.get('f-pdf-remove').focus();
  assert.equal(closing.nodes.get('modal-article').closeGuard(), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closing.deleteRequests.length, 2);
  closing.deleteRequests[1].resolve({});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closing.nodes.get('modal-article').classList.contains('hidden'), true);

  const saving = loadKnowledgeHarness();
  await upload(saving, 'asset-a', 'a.pdf');
  saving.nodes.get('f-pdf').files = [{ type: 'application/pdf', size: 10 }];
  saving.nodes.get('f-pdf').dispatch('change');
  saving.uploadRequests.at(-1).resolve({ id: 'asset-b', original_name: 'b.pdf' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saving.deleteRequests.length, 1);
  saving.deleteRequests[0].resolve({});
  await new Promise(resolve => setImmediate(resolve));
  saving.nodes.get('article-form').dispatch('submit', { currentTarget: saving.nodes.get('article-form') });
  saving.saveRequests[0].resolve({ id: 'saved-article' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saving.deleteRequests.length, 1);
  if (saving.listRequests[0]) {
    saving.listRequests[0].page.resolve({ data: [], total: 0 });
    saving.listRequests[0].categories.resolve(['all']);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saving.nodes.get('modal-article').classList.contains('hidden'), true);
});

test('dialog close guards block unsafe close and restore focus only after visible close', () => {
  const harness = loadUiHarness();
  harness.trigger.focus();
  harness.context.openDialog(harness.dialog, harness.trigger);
  harness.context.setDialogCloseGuard(harness.dialog, () => false);
  assert.equal(harness.context.closeDialog(harness.dialog), false);
  assert.equal(harness.dialog.classList.contains('hidden'), false);

  harness.context.setDialogCloseGuard(harness.dialog, () => true);
  assert.equal(harness.context.closeDialog(harness.dialog), true);
  assert.equal(harness.dialog.classList.contains('hidden'), true);
  assert.equal(harness.document.activeElement, harness.trigger);
});

test('dialog dirty state asks before close and keeps the modal open when discarded navigation is cancelled', () => {
  const harness = loadUiHarness();
  harness.context.openDialog(harness.dialog, harness.trigger);
  harness.form.formValue = 'changed';
  harness.context.window.confirm = () => false;
  assert.equal(harness.context.canCloseDialog(harness.dialog), false);
  assert.equal(harness.context.closeDialog(harness.dialog), false);
  assert.equal(harness.dialog.classList.contains('hidden'), false);

  harness.context.window.confirm = () => true;
  assert.equal(harness.context.closeDialog(harness.dialog), true);
  assert.equal(harness.dialog.classList.contains('hidden'), true);
});

test('profile action keeps moved focus and falls back from a hidden avatar remove button', async () => {
  const document = createTestDocument();
  const removeButton = createTestNode(document, 'button');
  const avatarButton = createTestNode(document, 'button');
  const movedControl = createTestNode(document, 'input');
  const avatarImage = createTestNode(document, 'img', 'avatar-img');
  avatarImage.complete = true;
  const initials = createTestNode(document, 'span', 'avatar-initials');
  const adjustButton = createTestNode(document, 'button');
  const photoInput = createTestNode(document, 'input');
  const nodes = new Map([
    ['avatar-img', avatarImage],
    ['avatar-initials', initials],
  ]);
  document.getElementById = id => nodes.get(id) || null;
  const pending = deferred();
  const source = profile.slice(profile.indexOf('function setProfileActionsBusy'), profile.indexOf('\n\n// ── Upload'));
  const context = {
    document,
    profileActionButtons: [removeButton, avatarButton],
    page: activePageDouble,
    profileForm: null,
    photoInput,
    cropFrame: null,
    avatarButton,
    adjustPhotoButton: adjustButton,
    removePhotoButton: removeButton,
    user: { email: 'user@example.test', photo_url: 'https://example.test/avatar.jpg' },
    profileCrop: {},
    cropRenderStyle: () => '',
    normalizeMediaCrop: value => value || {},
    URL,
    location: { origin: 'https://portal.test' },
  };
  vm.runInNewContext(`const cropFrameTabIndex = 0; const cropFramePointerEvents = ''; let avatarRenderToken = 0; let profileActionBusy = false; let profileCrop = {};\n${source}\nglobalThis.runProfileAction = runProfileAction; globalThis.renderAvatar = renderAvatar;`, context, { filename: 'profile.js' });
  context.renderAvatar('https://example.test/avatar.jpg', 'User');
  removeButton.focus();
  const action = context.runProfileAction(async () => {
    await pending.promise;
    context.user.photo_url = '';
    context.renderAvatar('', 'User');
  });
  pending.resolve();
  await action;
  assert.equal(document.activeElement, avatarButton);
  assert.equal(removeButton.hidden, true);

  removeButton.hidden = false;
  removeButton.focus();
  const movedAction = context.runProfileAction(() => pending.promise);
  movedControl.focus();
  await movedAction;
  assert.equal(document.activeElement, movedControl);
});

test('profile ignores an old avatar load after the photo has been removed', () => {
  const document = createTestDocument();
  const removeButton = createTestNode(document, 'button');
  const avatarButton = createTestNode(document, 'button');
  const avatarImage = createTestNode(document, 'img', 'avatar-img');
  avatarImage.complete = false;
  const initials = createTestNode(document, 'span', 'avatar-initials');
  const adjustButton = createTestNode(document, 'button');
  const photoInput = createTestNode(document, 'input');
  const nodes = new Map([['avatar-img', avatarImage], ['avatar-initials', initials]]);
  document.getElementById = id => nodes.get(id) || null;
  const source = profile.slice(profile.indexOf('function setProfileActionsBusy'), profile.indexOf('\n\n// ── Upload'));
  const context = {
    document,
    profileActionButtons: [removeButton, avatarButton],
    profileForm: null,
    photoInput,
    cropFrame: null,
    avatarButton,
    adjustPhotoButton: adjustButton,
    removePhotoButton: removeButton,
    user: { email: 'user@example.test', photo_url: 'https://example.test/avatar.jpg' },
    profileCrop: {},
    cropRenderStyle: () => 'transform: translate(1px, 1px)',
    page: activePageDouble,
    normalizeMediaCrop: value => value || {},
    URL,
    location: { origin: 'https://portal.test' },
  };
  vm.runInNewContext(`const cropFrameTabIndex = 0; const cropFramePointerEvents = ''; let avatarRenderToken = 0; let profileActionBusy = false; let profileCrop = {}; ${source}\nglobalThis.renderAvatar = renderAvatar;`, context, { filename: 'profile.js' });
  context.renderAvatar(context.user.photo_url, 'User');
  assert.equal(avatarImage.style.display, '');
  context.user.photo_url = '';
  context.renderAvatar('', 'User');
  avatarImage.dispatch('load');
  assert.equal(avatarImage.src, '');
  assert.equal(avatarImage.style.display, 'none');
});

test('profile crop freezes the draft during deferred save and guards cancel/close focus', async () => {
  const harness = loadProfileCropHarness();
  harness.opener.focus();
  harness.harness.openCropDialog();
  harness.cropFrame.focus();
  harness.cropFrame.dispatch('pointerdown', { clientX: 10, clientY: 10, pointerId: 1 });
  harness.cropFrame.dispatch('pointermove', { clientX: 30, clientY: 20, pointerId: 1 });
  harness.cropFrame.dispatch('pointerup', { clientX: 30, clientY: 20, pointerId: 1 });
  const captured = harness.harness.draft();

  const save = harness.harness.saveCrop();
  assert.equal(harness.saveRequests.length, 1);
  assert.deepEqual(JSON.parse(harness.saveRequests[0].options.body).photo_crop, JSON.parse(JSON.stringify(captured)));
  assert.equal(harness.harness.busy(), true);
  assert.equal(harness.cropFrame.inert, true);
  assert.equal(harness.cropFrame.getAttribute('aria-disabled'), 'true');
  assert.equal(harness.cropFrame.style.pointerEvents, 'none');
  assert.equal(harness.cropFrame.tabIndex, -1);
  assert.equal(harness.cropApplyButton.disabled, true);

  let cancelled = false;
  harness.cropFrame.dispatch('pointerdown', { clientX: 0, clientY: 0, pointerId: 2 });
  harness.cropFrame.dispatch('keydown', { key: 'ArrowRight', preventDefault() { cancelled = true; } });
  harness.cropResetButton.dispatch('click');
  harness.cropDialog.dispatch('cancel', { preventDefault() { cancelled = true; } });
  assert.equal(cancelled, true);
  assert.equal(JSON.stringify(harness.harness.draft()), JSON.stringify(captured));
  assert.equal(harness.cropDialog.open, true);
  assert.equal(harness.harness.closeCropDialog(), false);
  assert.equal(harness.cropDialog.open, true);

  harness.opener.disabled = true;
  harness.saveRequests[0].resolve({ photo_crop: { x: 0, y: 0, zoom: 1 } });
  await save;
  assert.equal(JSON.stringify(harness.harness.saved()), JSON.stringify(captured));
  assert.equal(harness.cropDialog.open, false);
  assert.equal(harness.harness.draft(), null);
  assert.equal(harness.document.activeElement, harness.avatarButton);
});

test('mobile sidebar synchronizes drawer accessibility state and restores its opener', () => {
  const harness = loadSidebarHarness();
  const { sidebar: navigation, mobileToggle, overlay, mainContent, document, media, toggle } = harness;
  assert.equal(navigation.getAttribute('aria-hidden'), 'true');
  assert.equal(navigation.inert, true);
  assert.equal(overlay.getAttribute('aria-hidden'), 'true');

  mobileToggle.focus();
  mobileToggle.dispatch('click');
  assert.equal(navigation.getAttribute('aria-hidden'), 'false');
  assert.equal(navigation.inert, false);
  assert.equal(mainContent.inert, true);
  assert.equal(mobileToggle.getAttribute('aria-expanded'), 'true');

  harness.link.focus();
  harness.link.dispatch('click');
  assert.equal(document.activeElement, harness.link);
  mobileToggle.dispatch('click');
  overlay.dispatch('click');
  assert.equal(mainContent.inert, false);
  assert.equal(document.activeElement, mobileToggle);

  media.matches = false;
  media.listeners[0]({ matches: false });
  toggle.dispatch('click');
  assert.equal(toggle.getAttribute('aria-label'), 'Expandir menu');
  assert.equal(navigation.getAttribute('aria-hidden'), 'false');
  assert.equal(navigation.inert, false);

  harness.link.focus();
  media.matches = true;
  media.listeners[0]({ matches: true });
  assert.equal(document.activeElement, mobileToggle);
  assert.equal(navigation.getAttribute('aria-hidden'), 'true');
});
