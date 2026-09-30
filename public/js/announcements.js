import { fetchAPI, fetchAPIPage } from './auth.js';
import { clear, element, setBusy, showState } from './ui.js';
import { readOffset, renderPagination, setPaginationBusy } from './pagination.js';
import { blocksToText, renderBlocks, cleanupRenderedBlocks } from './cms-block-renderer.js';
import { renderNewsCard, renderNewsCategories, renderNewsOpening } from './owner-news/catalog.js';
import { getNewsPresentation } from './owner-news/model.js';

const requests = { fetchAPI, fetchAPIPage };
const renderContent = renderBlocks;
export function mount(page) {
const { fetchAPI, fetchAPIPage } = page.bindAPI(requests);
const renderBlocks = (node, blocks, options) => renderContent(node, blocks, { ...options, signal: page.signal });
const history = page.history;
const location = page.location;
page.cleanup(() => { ++announcementsRequest; ++highlightRequest; ++homeRequest; ++categoriesRequest; clearContent(list); });

const list = document.getElementById('announcements-list');
const pagination = document.getElementById('announcements-pagination');
const PAGE_SIZE = 24;
let announcementsRequest = 0;
const highlight = document.getElementById('news-highlight');
const categories = document.getElementById('news-categories');
const index = document.getElementById('news-index');
let highlightRequest = 0;
let categoriesRequest = 0;
let homeRequest = 0;
let cardDisposers = [];
let categoryCounts = null;
let publishedHome = null;
let latestArticle = null;
const homeStatus = document.getElementById('news-opening-status');
const highlightStatus = document.getElementById('news-highlight-status');
const feedStatus = document.getElementById('news-feed-status');
const categoriesStatus = document.getElementById('news-categories-status');
const fallbackHome = { version: 1, eyebrow: 'OWNER NEWS · DESTAQUE', headline: 'Histórias que\nnos conectam', summary: 'Pessoas, ideias e cultura da Ownerinc.' };

function articleMeta(announcement) {
  const text = blocksToText(announcement.content_blocks).trim();
  const minutes = Math.max(1, Math.ceil(text.split(/\s+/).filter(Boolean).length / 200));
  const date = new Date(announcement.published_at);
  return [announcement.category || 'Ownerinc', Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: 'numeric', month: 'short', year: 'numeric',
  }).format(date), `${minutes} min de leitura`].filter(Boolean).join(' · ');
}

function clearContent(container) {
  if (container === list) { cardDisposers.forEach(dispose => dispose()); cardDisposers = []; }
  container?.querySelectorAll('.news-cover, .cms-public-content').forEach(cleanupRenderedBlocks);
  if (container) clear(container);
}

function updateOpening() {
  renderNewsOpening(highlight, publishedHome || (latestArticle ? {
    ...fallbackHome, headline: latestArticle.title, summary: getNewsPresentation(latestArticle).summary,
  } : fallbackHome));
}

async function loadHome() {
  const token = ++homeRequest;
  if (homeStatus) clear(homeStatus);
  try {
    const home = await fetchAPI('/api/announcements/home');
    if (token !== homeRequest) return;
    publishedHome = home;
    updateOpening();
  } catch {
    if (token === homeRequest) {
      updateOpening();
      if (homeStatus) showState(homeStatus, 'Não foi possível atualizar a abertura.', () => { if (page.active && token === homeRequest) loadHome(); });
    }
  }
}

async function loadHighlight() {
  if (!highlight) return;
  const token = ++highlightRequest;
  if (highlightStatus) clear(highlightStatus);
  try {
    const result = await fetchAPI('/api/announcements?kind=article&limit=1&offset=0');
    if (token !== highlightRequest) return;
    latestArticle = result[0] || null;
    updateOpening();
  } catch {
    if (token === highlightRequest && highlightStatus) showState(highlightStatus, 'Não foi possível atualizar o destaque.', () => { if (page.active && token === highlightRequest) loadHighlight(); });
  }
}

function updateCategories() {
  if (categoryCounts) renderNewsCategories(categories, categoryCounts, new URLSearchParams(location.search).get('category') || '');
}

async function loadCategories() {
  if (!categories) return;
  const token = ++categoriesRequest;
  if (categoriesStatus) clear(categoriesStatus);
  try {
    const values = await fetchAPI('/api/announcements/categories?kind=article&with_counts=true');
    if (token !== categoriesRequest) return;
    categoryCounts = values;
    updateCategories();
  } catch {
    if (token === categoriesRequest) showState(categoriesStatus || categories, 'Não foi possível carregar as editorias.', () => { if (page.active && token === categoriesRequest) loadCategories(); });
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
  if (feedStatus) clear(feedStatus);
  if (!list.children.length) showState(list, 'Carregando publicações…');
  setBusy(list, true);
  setPaginationBusy(pagination, true);
  try {
    const query = new URLSearchParams(location.search);
    const announcementId = query.get('id');
    if (index) index.hidden = Boolean(announcementId);
    if (announcementId) {
      const announcement = await fetchAPI(`/api/announcements/${encodeURIComponent(announcementId)}`);
      if (requestToken !== announcementsRequest) return;
      clearContent(list);
      list.classList.remove('news-mosaic');
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
    const params = new URLSearchParams({ kind: 'article', limit: '24', offset: String(offset) });
    if (category) params.set('category', category);
    const result = await fetchAPIPage(`/api/announcements?${params}`);
    if (requestToken !== announcementsRequest) return;
    const announcements = Array.isArray(result.data) ? result.data : [];
    if (!announcements.length && offset > 0) {
      const url = new URL(location.href);
      url.searchParams.delete('offset');
      history.replaceState({}, '', url);
      return loadAnnouncements();
    }
    clearContent(list);
    list.classList.add('news-mosaic');
    const state = !announcements.length ? showState(list, 'Nenhuma publicação nesta editoria.') : null;
    announcements.forEach((announcement, articleIndex) => {
      const card = renderNewsCard(announcement, { index: offset + articleIndex, signal: page.signal });
      cardDisposers.push(card.dispose);
      list.append(card.node);
    });
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
      const target = list.querySelector('.news-card, .news-detail') && feedStatus ? feedStatus : list;
      const state = showState(target, 'Não foi possível carregar a publicação. Verifique sua conexão ou volte às editorias.', () => { if (page.active && requestToken === announcementsRequest) loadAnnouncements(); });
      const query = new URLSearchParams(location.search);
      if (query.has('id')) {
        query.delete('id');
        state.append(element('a', { className: 'news-back', href: `./announcements.html${query.toString() ? `?${query}` : ''}`, text: '← Voltar às publicações' }));
      }
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

page.listen(window, 'popstate', () => { loadAnnouncements(); updateCategories(); });
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
  updateCategories();
});
page.listen(window, 'pagehide', () => {
  ++announcementsRequest;
  ++highlightRequest;
  ++homeRequest;
  ++categoriesRequest;
  clearContent(list);
});
page.listen(window, 'pageshow', event => {
  if (event.persisted) { loadAnnouncements(); loadHome(); loadHighlight(); loadCategories(); }
});
updateOpening();
loadAnnouncements();
loadHome();
loadHighlight();
loadCategories();
}
