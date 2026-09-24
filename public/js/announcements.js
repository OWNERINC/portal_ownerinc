import { fetchAPI, fetchAPIPage } from './auth.js';
import { clear, element, setBusy, showState } from './ui.js';
import { readOffset, renderPagination, setPaginationBusy } from './pagination.js';
import { blocksToText, renderBlocks, cleanupRenderedBlocks } from './cms-block-renderer.js';

const requests = { fetchAPI, fetchAPIPage };
const renderContent = renderBlocks;
export function mount(page) {
const { fetchAPI, fetchAPIPage } = page.bindAPI(requests);
const renderBlocks = (node, blocks, options) => renderContent(node, blocks, { ...options, signal: page.signal });
const history = page.history;
const location = page.location;
page.cleanup(() => { ++announcementsRequest; ++highlightRequest; ++categoriesRequest; clearContent(list); clearContent(highlight); });

const list = document.getElementById('announcements-list');
const pagination = document.getElementById('announcements-pagination');
const PAGE_SIZE = 10;
let announcementsRequest = 0;
const highlight = document.getElementById('news-highlight');
const categories = document.getElementById('news-categories');
const index = document.getElementById('news-index');
let highlightRequest = 0;
let categoriesRequest = 0;

function articleMeta(announcement) {
  const text = blocksToText(announcement.content_blocks).trim();
  const minutes = Math.max(1, Math.ceil(text.split(/\s+/).filter(Boolean).length / 200));
  const date = new Date(announcement.published_at);
  return [announcement.category || 'Ownerinc', Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: 'numeric', month: 'short', year: 'numeric',
  }).format(date), `${minutes} min de leitura`].filter(Boolean).join(' · ');
}

function articleCard(announcement, featured = false) {
  const cover = element('div', { className: 'news-cover' });
  const image = announcement.content_blocks?.find(block => block.type === 'image');
  renderBlocks(cover, image ? [image] : [], { fallbackText: 'Owner News' });
  const firstText = announcement.content_blocks?.find(block => ['paragraph', 'callout'].includes(block.type));
  const excerpt = (firstText?.text || blocksToText(announcement.content_blocks)).replace(/\s+/g, ' ').trim();
  return element('article', { className: `news-card${featured ? ' news-feature' : ''}` }, [
    cover,
    element('div', {}, [
      element('p', { className: 'news-meta', text: `${featured ? 'Mais recente · ' : ''}${articleMeta(announcement)}` }),
      element('h2', {}, [element('a', { href: `?id=${encodeURIComponent(announcement.id)}`, text: announcement.title })]),
      element('p', { className: 'news-excerpt', text: excerpt.length > 190 ? `${excerpt.slice(0, 187)}…` : excerpt }),
    ]),
  ]);
}

function clearContent(container) {
  container?.querySelectorAll('.news-cover, .cms-public-content').forEach(cleanupRenderedBlocks);
  if (container) clear(container);
}

async function loadHighlight() {
  if (!highlight) return;
  const token = ++highlightRequest;
  setBusy(highlight, true);
  try {
    const result = await fetchAPI('/api/announcements?limit=1&offset=0');
    if (token !== highlightRequest) return;
    clearContent(highlight);
    if (result[0]) highlight.append(articleCard(result[0], true));
  } catch {
    if (token === highlightRequest) showState(highlight, 'Não foi possível carregar o destaque.', loadHighlight);
  } finally {
    if (token === highlightRequest) setBusy(highlight, false);
  }
}

async function loadCategories() {
  if (!categories) return;
  const token = ++categoriesRequest;
  try {
    const values = await fetchAPI('/api/announcements/categories');
    if (token !== categoriesRequest) return;
    const selected = new URLSearchParams(location.search).get('category') || '';
    const focused = categories.contains(document.activeElement) ? document.activeElement.textContent : null;
    clear(categories);
    ['', ...new Set([...values, ...(selected ? [selected] : [])])].forEach(category => {
      const query = new URLSearchParams();
      if (category) query.set('category', category);
      categories.append(element('a', {
        href: `./announcements.html${query.toString() ? `?${query}` : ''}`,
        text: category || 'Todas', ...(selected === category ? { 'aria-current': 'page' } : {}),
      }));
    });
    if (focused) [...categories.querySelectorAll('a')].find(link => link.textContent === focused)?.focus();
  } catch {
    if (token === categoriesRequest) showState(categories, 'Não foi possível carregar as editorias.', loadCategories);
  }
}

function focusDescriptor(node) {
  if (!node?.isConnected || !node.closest?.('#announcements-pagination')) return null;
  return { label: node.textContent.trim(), node };
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
    list?.querySelector('a, button'),
    list?.querySelector('h1, h2, h3, [role="heading"]'),
    state?.querySelector('button'),
    state,
    document.querySelector('main h1, main h2, main h3, main [role="heading"]'),
  ].find(visibleFocusTarget);
  if (target === state && target.tabIndex < 0) target.tabIndex = -1;
  target?.focus();
}

function restorePaginationFocus(descriptor, state) {
  if (!descriptor) return;
  const current = document.activeElement;
  if (current?.isConnected && current !== document.body && current !== descriptor.node) return;
  const target = [...(pagination?.querySelectorAll('button') || [])]
    .find(button => button.textContent.trim() === descriptor.label && visibleFocusTarget(button));
  if (target) target.focus();
  else focusFallback(state);
}

async function loadAnnouncements() {
  const focusAtStart = document.activeElement;
  const requestedFocus = focusDescriptor(focusAtStart);
  const requestToken = ++announcementsRequest;
  clearContent(list);
  showState(list, 'Carregando publicações…');
  setBusy(list, true);
  setPaginationBusy(pagination, true);
  try {
    const query = new URLSearchParams(location.search);
    const announcementId = query.get('id');
    if (index) index.hidden = Boolean(announcementId);
    if (announcementId) {
      const announcement = await fetchAPI(`/api/announcements/${encodeURIComponent(announcementId)}`);
      if (requestToken !== announcementsRequest) return;
      clear(list);
      pagination?.replaceChildren();
      query.delete('id');
      const article = element('article', { className: 'news-detail' }, [
        element('a', { className: 'news-back', href: `./announcements.html${query.toString() ? `?${query}` : ''}`, text: '← Voltar às publicações' }),
        element('h2', { text: announcement.title }),
        element('p', { className: 'news-meta', text: articleMeta(announcement) }),
      ]);
      const content = element('div', { className: 'cms-public-content' });
      renderBlocks(content, announcement.content_blocks, { fallbackText: 'Esta publicação não possui conteúdo disponível.' });
      article.append(content);
      list.append(article);
      article.tabIndex = -1;
      const currentFocus = document.activeElement;
      if (currentFocus === focusAtStart || currentFocus === document.body || !currentFocus?.isConnected) article.focus();
      return;
    }
    const offset = readOffset(query, PAGE_SIZE);
    if (query.get('offset') !== (offset ? String(offset) : '')) {
      const url = new URL(location.href);
      offset ? url.searchParams.set('offset', String(offset)) : url.searchParams.delete('offset');
      history.replaceState({}, '', url);
    }
    const category = query.get('category');
    const result = await fetchAPIPage(`/api/announcements?limit=${PAGE_SIZE}&offset=${offset}${category ? `&category=${encodeURIComponent(category)}` : ''}`);
    if (requestToken !== announcementsRequest) return;
    const announcements = Array.isArray(result.data) ? result.data : [];
    if (!announcements.length && offset > 0) {
      const url = new URL(location.href);
      url.searchParams.delete('offset');
      history.replaceState({}, '', url);
      return loadAnnouncements();
    }
    clear(list);
    const state = !announcements.length ? showState(list, 'Nenhuma publicação nesta editoria.') : null;
    announcements.forEach(announcement => list.append(articleCard(announcement)));
    renderPagination(pagination, Number(result.total ?? announcements.length), offset, PAGE_SIZE, nextOffset => {
      if (requestToken !== announcementsRequest) return;
      const url = new URL(location.href);
      nextOffset ? url.searchParams.set('offset', String(nextOffset)) : url.searchParams.delete('offset');
      history.pushState({}, '', url);
      loadAnnouncements();
    });
    restorePaginationFocus(requestedFocus, state);
    if (focusAtStart?.closest?.('.news-detail') && (document.activeElement === document.body || !document.activeElement?.isConnected)) focusFallback(state);
  } catch {
    if (requestToken === announcementsRequest) {
      pagination?.replaceChildren();
      const state = showState(list, 'Não foi possível carregar a publicação. Verifique sua conexão ou volte às editorias.', loadAnnouncements);
      if (new URLSearchParams(location.search).has('id')) list.append(element('a', { className: 'news-back', href: './announcements.html', text: '← Voltar às publicações' }));
      const current = document.activeElement;
      if (!current?.isConnected || current === document.body) state?.querySelector('button')?.focus();
    }
  } finally {
    if (requestToken === announcementsRequest) {
      setBusy(list, false);
      setPaginationBusy(pagination, false);
    }
  }
}

page.listen(window, 'popstate', () => { loadAnnouncements(); loadCategories(); });
page.listen(document.getElementById('main-content'), 'click', event => {
  const link = event.target.closest('a');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || url.pathname !== location.pathname || url.hash) return;
  event.preventDefault();
  if (url.searchParams.has('id')) {
    const current = new URLSearchParams(location.search);
    for (const key of ['category', 'offset']) {
      if (current.has(key)) url.searchParams.set(key, current.get(key));
    }
  }
  history.pushState({}, '', url);
  loadAnnouncements();
  loadCategories();
});
page.listen(window, 'pagehide', () => {
  ++announcementsRequest;
  ++highlightRequest;
  ++categoriesRequest;
  clearContent(list);
  clearContent(highlight);
});
page.listen(window, 'pageshow', event => {
  if (event.persisted) { loadAnnouncements(); loadHighlight(); loadCategories(); }
});
loadAnnouncements();
loadHighlight();
loadCategories();
}
