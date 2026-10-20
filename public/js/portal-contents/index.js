import { getContentsIdentity, subscribeContentsIdentity } from '../auth.js';
import { createContentsAPI } from './api.js';
import { renderCatalog, renderCategories } from './catalog.js';
import { MAX_OFFSET, PAGE_SIZE, isCanonicalSlug } from './dto.js';
import { renderReader } from './reader.js';

export function parseContentsLocation(search) {
  const params = new URLSearchParams(search);
  for (const key of ['slug', 'category', 'page']) {
    if (params.getAll(key).length > 1) return { kind: 'invalid', href: null };
  }
  const slug = params.get('slug');
  const category = params.get('category');
  const rawPage = params.get('page');
  if (slug !== null && !isCanonicalSlug(slug)) return { kind: 'invalid', href: null };
  if (category !== null && !isCanonicalSlug(category)) return { kind: 'invalid', href: null };
  if (rawPage !== null && !/^[1-9][0-9]*$/u.test(rawPage)) return { kind: 'invalid', href: null };
  const page = rawPage === null ? 1 : Number(rawPage);
  const offset = (page - 1) * PAGE_SIZE;
  if (!Number.isSafeInteger(page) || !Number.isSafeInteger(offset) || offset > MAX_OFFSET) {
    return { kind: 'invalid', href: null };
  }
  if (slug !== null) return { kind: 'reader', slug, href: `/contents.html?slug=${slug}` };
  const query = new URLSearchParams();
  if (category) query.set('category', category);
  if (page !== 1) query.set('page', String(page));
  const serialized = query.toString();
  return { kind: 'catalog', category, page, offset,
    href: `/contents.html${serialized ? `?${serialized}` : ''}` };
}

function abortError() { return new DOMException('A visualização foi substituída.', 'AbortError'); }

function identityIsValid(identity) {
  return identity?.validated === true && typeof identity.uid === 'string' && identity.uid.length > 0
    && Number.isSafeInteger(identity.generation);
}

function sameIdentity(left, right) {
  return left?.uid === right?.uid && left?.generation === right?.generation
    && left?.validated === right?.validated;
}

function makeElement(document, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setCategoryFailure(nav, onReload) {
  if (!nav) return;
  const message = makeElement(document, 'p', 'contents-category-error', 'Não foi possível carregar as categorias.');
  const retry = makeElement(document, 'button', 'contents-retry', 'Tentar novamente');
  retry.type = 'button';
  retry.addEventListener('click', onReload);
  nav.replaceChildren(message, retry);
}

export function mount(page) {
  const document = globalThis.document;
  const window = globalThis.window;
  const container = document.getElementById('contents-root');
  const shellHeading = document.getElementById('contents-title');
  const status = document.getElementById('contents-status');
  let root = document.getElementById('contents-view');
  if (!root && container) {
    root = document.createElement('div');
    root.id = 'contents-view';
    container.append(root);
  }
  const api = createContentsAPI(page);
  let generation = 0;
  let active = null;
  let renderedView = null;
  let lastCatalogHref = '/contents.html';
  let categories = [];
  let categoriesLoaded = false;
  let categoriesFailed = false;
  let knownIdentity = getContentsIdentity();

  function clearView() {
    active?.controller.abort();
    active = null;
    try { renderedView?.dispose?.(); } catch { /* A view cleanup cannot retain the prior route. */ }
    renderedView = null;
    root?.replaceChildren();
    container?.removeAttribute('aria-busy');
    if (shellHeading && !shellHeading.isConnected) container?.prepend(shellHeading);
  }

  function current(run) {
    if (!page.active || !run || active !== run || run.controller.signal.aborted || run.id !== generation) return false;
    const identity = getContentsIdentity();
    return identityIsValid(identity) && identity.uid === run.identity.uid && identity.generation === run.identity.generation;
  }

  function setLoading(run) {
    if (!status || !root || !current(run)) return;
    status.textContent = 'Carregando conteúdos…';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    container?.setAttribute('aria-busy', 'true');
    const placeholder = makeElement(document, 'div', 'contents-loading-placeholder');
    placeholder.setAttribute('aria-hidden', 'true');
    root.replaceChildren(placeholder);
  }

  function statusLink(message, label, href) {
    if (!status) return;
    status.replaceChildren(makeElement(document, 'span', '', message));
    const link = makeElement(document, 'a', 'contents-status-link', label);
    link.setAttribute('href', href);
    status.append(link);
  }

  function statusRetry(message, run, { focusHeading = false, categoryOnly = false } = {}) {
    if (!status) return;
    status.replaceChildren(makeElement(document, 'span', '', message));
    const retry = makeElement(document, 'button', 'contents-retry', 'Tentar novamente');
    retry.type = 'button';
    retry.addEventListener('click', () => {
      if (categoryOnly) startCategoriesOnly();
      else startRoute(true);
    });
    status.append(retry);
    if (focusHeading) status.setAttribute('data-focus-on-reload', 'true');
    void run;
  }

  function showLoadFailure(error, run) {
    if (!current(run) || error?.name === 'AbortError') return;
    root?.replaceChildren();
    container?.removeAttribute('aria-busy');
    if (!status) return;
    if (run.state.kind === 'reader' && error?.status === 404) {
      statusLink('Este conteúdo não está mais disponível.', 'Voltar ao catálogo', lastCatalogHref);
      return;
    }
    if (error?.status === 400 || error?.code === 'invalid_contents' || run.state.kind === 'invalid') {
      statusLink('Não foi possível abrir este conteúdo com segurança.', 'Voltar ao catálogo', lastCatalogHref);
      return;
    }
    statusRetry('Conteúdos temporariamente indisponíveis.', run);
  }

  function showCategoryFailure(error, run) {
    if (!current(run) || error?.name === 'AbortError') return;
    const nav = root?.querySelector('#contents-categories');
    setCategoryFailure(nav, startCategoriesOnly);
  }

  function startCategoriesOnly() {
    const run = active;
    if (!run || run.state.kind !== 'catalog' || !current(run)) return;
    const load = page.bindAPI({ loadCategories }).loadCategories;
    void load(run.state.href, { method: 'GET', signal: run.controller.signal }).catch(error => showCategoryFailure(error, run));
  }

  async function loadCategories(_path, { signal } = {}) {
    const run = active;
    if (!run || run.state.kind !== 'catalog') return;
    const context = { signal, isCurrent: () => current(run), onReload: startCategoriesOnly };
    const result = await api.categories(context);
    if (!current(run)) throw abortError();
    categories = result;
    categoriesLoaded = true;
    categoriesFailed = false;
    const nav = root?.querySelector('#contents-categories');
    if (nav) renderCategories(nav, categories, run.state.category, context);
  }

  async function loadView(_path, { signal } = {}) {
    const run = active;
    if (!run) return;
    const context = { signal, isCurrent: () => current(run), onReload: () => startRoute(true) };
    if (run.state.kind === 'invalid') {
      showLoadFailure({ status: 400, code: 'invalid_contents' }, run);
      return;
    }
    if (run.state.kind === 'reader') {
      const dto = await api.detail(run.state.slug, context);
      if (!current(run)) throw abortError();
      shellHeading?.remove();
      renderedView = renderReader(root, dto, { returnHref: lastCatalogHref }, context);
      if (!current(run)) throw abortError();
      document.title = `${dto.title} — Conteúdos — Portal Ownerinc`;
      container?.removeAttribute('aria-busy');
      if (status) status.textContent = 'Conteúdo aberto.';
      return;
    }
    const result = await api.list({ category: run.state.category, offset: run.state.offset }, context);
    if (!current(run)) throw abortError();
    shellHeading?.remove();
    renderedView = renderCatalog(root, { ...result, category: run.state.category, page: run.state.page }, context);
    if (!current(run)) throw abortError();
    if (categoriesLoaded) renderCategories(root.querySelector('#contents-categories'), categories, run.state.category, context);
    if (categoriesFailed) setCategoryFailure(root.querySelector('#contents-categories'), startCategoriesOnly);
    container?.removeAttribute('aria-busy');
    document.title = 'Conteúdos — Portal Ownerinc';
    if (status) {
      if (result.total === 0 && run.state.category) statusLink('Nenhum conteúdo nesta categoria.', 'Todas', '/contents.html');
      else if (result.total === 0) status.textContent = 'Nenhum conteúdo publicado no momento.';
      else if (!result.data.length) status.textContent = 'Nenhum conteúdo nesta página.';
      else status.textContent = 'Conteúdos carregados.';
    }
  }

  const tracked = page.bindAPI({ loadView, loadCategories });

  function startRoute(fromRetry = false) {
    clearView();
    generation += 1;
    const state = parseContentsLocation(page.location?.search || window.location?.search || '');
    if (state.kind === 'catalog') {
      lastCatalogHref = state.href;
      categories = [];
      categoriesLoaded = false;
      categoriesFailed = false;
    }
    const identity = getContentsIdentity();
    const run = { id: generation, state, identity: { uid: identity?.uid, generation: identity?.generation },
      controller: new AbortController() };
    active = run;
    if (!identityIsValid(identity)) {
      if (status) status.textContent = '';
      return;
    }
    const currentHref = `${page.location?.pathname || '/contents.html'}${page.location?.search || ''}`;
    if (state.href && currentHref !== state.href) {
      page.history?.replaceState?.(window.history?.state, '', state.href);
    }
    if (fromRetry) status?.setAttribute('data-focus-on-reload', 'true');
    setLoading(run);
    const options = { method: 'GET', signal: run.controller.signal };
    void tracked.loadView(state.href || '/contents.html', options).then(() => {
      if (!current(run)) return;
      if (status?.getAttribute('data-focus-on-reload') === 'true') {
        status.removeAttribute('data-focus-on-reload');
        renderedView?.heading?.focus?.();
      }
    }).catch(error => showLoadFailure(error, run));
    if (state.kind === 'catalog') {
      void tracked.loadCategories(state.href, options).catch(error => {
        if (current(run)) categoriesFailed = true;
        showCategoryFailure(error, run);
      });
    }
  }

  function loadCurrent() { startRoute(false); }

  function onIdentity(identity) {
    if (sameIdentity(identity, knownIdentity)) return;
    knownIdentity = identity;
    clearView();
    generation += 1;
    categories = [];
    categoriesLoaded = false;
    categoriesFailed = false;
    if (status) status.replaceChildren();
    if (root) root.replaceChildren();
    if (identityIsValid(identity)) startRoute(false);
  }

  const unsubscribe = subscribeContentsIdentity(onIdentity);
  page.cleanup(() => {
    unsubscribe?.();
    clearView();
    generation += 1;
    if (status) status.replaceChildren();
  });
  page.listen(window, 'popstate', loadCurrent);
  loadCurrent();
}
