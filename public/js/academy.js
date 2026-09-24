import { fetchAPI, fetchAPIPage } from './auth.js';
import { clear, element, safeHttpUrl, setBusy, showState } from './ui.js';
import { readOffset, renderPagination, setPaginationBusy } from './pagination.js';
import { renderBlocks } from './cms-block-renderer.js';

const requests = { fetchAPI, fetchAPIPage };
const renderContent = renderBlocks;
export function mount(page) {
const { fetchAPI, fetchAPIPage } = page.bindAPI(requests);
const renderBlocks = (node, blocks, options) => renderContent(node, blocks, { ...options, signal: page.signal });
const history = page.history;
const location = page.location;
page.cleanup(() => { ++coursesRequest; });

const container = document.getElementById('academy-content');
const filters = document.getElementById('academy-filters');
const pagination = document.getElementById('academy-pagination');
const PAGE_SIZE = 20;
let categories = [];
let coursesRequest = 0;

function updateUrl(category = '', offset = 0) {
  const url = new URL(location.href);
  category ? url.searchParams.set('category', category) : url.searchParams.delete('category');
  offset ? url.searchParams.set('offset', String(offset)) : url.searchParams.delete('offset');
  history.replaceState({}, '', url);
}

function normalizeCategories(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter(category => typeof category === 'string')
    .map(category => category.trim())
    .filter(Boolean))];
}

function categoryLabel(category) {
  return ['all', 'todos'].includes(category.toLocaleLowerCase('pt-BR')) ? `${category} (categoria)` : category;
}

function focusDescriptor(node) {
  if (!node?.isConnected) return null;
  if (node.closest?.('#academy-filters')) return { kind: 'category', value: node.dataset.category || '', node };
  if (node.closest?.('#academy-pagination')) return { kind: 'pagination', label: node.textContent.trim(), node };
  return null;
}

function hasInertAncestor(node) {
  let current = node?.parentNode;
  while (current) {
    if (current.inert) return true;
    current = current.parentNode;
  }
  return false;
}

function visibleFocusTarget(node) {
  return Boolean(node && node !== document.body && node.isConnected !== false
    && !node.hidden && !node.disabled && !node.inert && !hasInertAncestor(node) && node.style?.display !== 'none'
    && !node.closest?.('[hidden], .hidden, [aria-hidden="true"]'));
}

function focusFallback(state) {
  const target = [
    filters?.querySelector('button'),
    container?.querySelector('a, button'),
    container?.querySelector('h1, h2, h3, [role="heading"]'),
    state?.querySelector('button'),
    state,
    document.querySelector('main h1, main h2, main h3, main [role="heading"]'),
  ].find(visibleFocusTarget);
  if (target === state && target.tabIndex < 0) target.tabIndex = -1;
  target?.focus();
}

function restoreFocus(descriptor, state) {
  if (!descriptor) return;
  const current = document.activeElement;
  if (current?.isConnected && current !== document.body && current !== descriptor.node) return;
  if (descriptor.kind === 'category') {
    const target = [...filters.querySelectorAll('button')].find(button => button.dataset.category === descriptor.value && visibleFocusTarget(button));
    if (target) target.focus();
    else focusFallback(state);
  } else {
    const target = [...pagination.querySelectorAll('button')].find(button => button.textContent.trim() === descriptor.label && visibleFocusTarget(button));
    if (target) target.focus();
    else focusFallback(state);
  }
}

function focusStateRetry(state, descriptor) {
  if (!state) return;
  const current = document.activeElement;
  const currentUnavailable = !visibleFocusTarget(current);
  if (!descriptor && !currentUnavailable) return;
  if (descriptor && !currentUnavailable && current !== descriptor.node) return;
  if (descriptor?.kind === 'category') {
    const target = [...filters.querySelectorAll('button')]
      .find(button => button.dataset.category === descriptor.value && visibleFocusTarget(button));
    if (target) {
      target.focus();
      return;
    }
  }
  if (descriptor?.kind === 'pagination') {
    const target = [...pagination.querySelectorAll('button')]
      .find(button => button.textContent.trim() === descriptor.label && visibleFocusTarget(button));
    if (target) {
      target.focus();
      return;
    }
  }
  const retry = state.querySelector('button');
  if (visibleFocusTarget(retry)) retry.focus();
  else focusFallback(state);
}

function paginationStillCurrent(requestToken, category, offset) {
  const query = new URLSearchParams(location.search);
  return requestToken === coursesRequest
    && (query.get('category')?.trim() || '') === category
    && readOffset(query, PAGE_SIZE) === offset;
}

function setFiltersBusy(busy) {
  setBusy(filters, busy);
  filters?.querySelectorAll('button').forEach(button => { button.disabled = busy; });
}

function renderFilters(requestToken = coursesRequest) {
  const selected = new URLSearchParams(location.search).get('category')?.trim() || '';
  clear(filters);
  [{ value: '', label: 'Todos' }, ...categories.map(value => ({ value, label: categoryLabel(value) }))].forEach(({ value, label }) => {
    filters.append(element('button', {
      className: `badge category-filter ${value === selected ? 'badge-gold' : 'badge-gray'}`,
      type: 'button', text: label, 'data-category': value, 'aria-pressed': String(value === selected),
      on: { click: () => {
        if (requestToken !== coursesRequest) return;
        updateUrl(value);
        loadCourses();
      } },
    }));
  });
  setFiltersBusy(false);
}

async function loadCourses() {
  const requestedFocus = focusDescriptor(document.activeElement);
  const requestToken = ++coursesRequest;
  setBusy(container, true);
  setFiltersBusy(true);
  setPaginationBusy(pagination, true);
  try {
    const query = new URLSearchParams(location.search);
    const offset = readOffset(query, PAGE_SIZE);
    const category = query.get('category')?.trim() || '';
    if (query.get('offset') !== (offset ? String(offset) : '')) updateUrl(category, offset);
    const request = new URLSearchParams({ active: 'true', limit: String(PAGE_SIZE), offset: String(offset) });
    if (category) request.set('category', category);
    const [result, categoryList] = await Promise.all([
      fetchAPIPage(`/api/academy?${request}`),
      fetchAPI('/api/academy/categories'),
    ]);
    if (requestToken !== coursesRequest) return;
    const courses = (Array.isArray(result.data) ? result.data : []).filter(course => course.active !== false);
    categories = normalizeCategories(categoryList);
    renderFilters(requestToken);
    const total = Number(result.total ?? courses.length);
    if (!courses.length && offset > 0) {
      updateUrl(category, 0);
      return loadCourses();
    }
    if (!courses.length) {
      clear(pagination);
      const state = showState(container, 'Nenhum curso disponível no momento.');
      restoreFocus(requestedFocus, state);
      return state;
    }
    const groups = courses.reduce((map, course) => {
      const category = course.category || 'Geral';
      map.set(category, [...(map.get(category) || []), course]);
      return map;
    }, new Map());
    clear(container);
    groups.forEach((items, category) => {
      const section = element('section', { className: 'content-section' });
      section.append(element('h2', { text: category }));
      const grid = element('div', { className: 'card-grid' });
      items.forEach(course => {
        const href = safeHttpUrl(course.url);
        const title = href
          ? element('a', { className: 'card-title card-link-title', href, target: '_blank', rel: 'noopener noreferrer', text: course.title })
          : element('div', { className: 'card-title', text: course.title });
        const content = element('div', { className: 'card-copy cms-public-content' });
        renderBlocks(content, course.content_blocks, { fallbackText: course.description || '' });
        const card = element('article', { className: 'card link-card' }, [
          title,
          content,
          element(href ? 'a' : 'span', href
            ? { className: 'card-link-label', href, target: '_blank', rel: 'noopener noreferrer', text: 'Acessar curso →' }
            : { className: 'card-link-label', text: 'Link indisponível' }),
        ]);
        grid.append(card);
      });
      section.append(grid);
      container.append(section);
    });
    renderPagination(pagination, total, offset, PAGE_SIZE, nextOffset => {
      if (!paginationStillCurrent(requestToken, category, offset)) return;
      updateUrl(category, nextOffset);
      loadCourses();
    });
    restoreFocus(requestedFocus);
  } catch {
    if (requestToken === coursesRequest) {
      focusStateRetry(showState(container, 'Não foi possível carregar os cursos. Verifique sua conexão.', loadCourses), requestedFocus);
    }
  } finally {
    if (requestToken === coursesRequest) {
      setBusy(container, false);
      setFiltersBusy(false);
      setPaginationBusy(pagination, false);
    }
  }
}

page.listen(window, 'popstate', loadCourses);
loadCourses();
}
