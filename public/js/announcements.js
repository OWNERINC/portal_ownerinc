import { fetchAPI, fetchAPIPage } from './auth.js';
import { clear, element, setBusy, showState } from './ui.js';
import { readOffset, renderPagination, setPaginationBusy } from './pagination.js';
import { cleanupRenderedBlocks } from './cms-block-renderer.js';
import { composeNewsFeed, renderNewsCard, renderNewsCategories, renderNewsOpening } from './owner-news/catalog.js';
import { createNewsPoll } from './owner-news/poll.js';
import { getNewsPresentation } from './owner-news/model.js';
import { renderNewsArticle } from './owner-news/reader-view.js';
import { createNewsNavigation } from './owner-news/navigation.js';

const requests = { fetchAPI, fetchAPIPage };
export function mount(page) {
const { fetchAPI, fetchAPIPage } = page.bindAPI(requests);
const history = page.history;
const location = page.location;
page.cleanup(() => { ++announcementsRequest; ++highlightRequest; ++homeRequest; ++categoriesRequest; clearContent(list); });

const list = document.getElementById('announcements-list');
const pagination = document.getElementById('announcements-pagination');
const PAGE_SIZE = 24;
let announcementsRequest = 0;
const highlight = document.getElementById('news-highlight');
const categories = document.getElementById('news-categories');
let highlightRequest = 0;
let categoriesRequest = 0;
let homeRequest = 0;
let cardDisposers = [];
let categoryCounts = null;
let publishedHome = null;
let latestArticle = null;
let pollRequest = 0, pollController, pollComponent, pollId, pollAbsent = false;
const pollSlot = element('div', { className: 'news-poll-slot' });
const pollStatus = element('div', { className: 'news-poll-loader' });
pollSlot.append(pollStatus);
page.cleanup(() => { ++pollRequest; pollController?.abort(); pollComponent?.dispose(); pollSlot.remove(); });
const homeStatus = document.getElementById('news-opening-status');
const highlightStatus = document.getElementById('news-highlight-status');
const feedStatus = document.getElementById('news-feed-status');
const categoriesStatus = document.getElementById('news-categories-status');
const fallbackHome = { version: 1, eyebrow: 'OWNER NEWS · DESTAQUE', headline: 'Histórias que\nnos conectam', summary: 'Pessoas, ideias e cultura da Ownerinc.' };

const overlay = document.getElementById('news-reader-overlay');
const reader = document.getElementById('news-reader-content');
const dialog = document.getElementById('news-reader-dialog');
const neighborStatus = document.getElementById('news-reader-navigation-status');
const previous = document.getElementById('news-reader-previous');
const next = document.getElementById('news-reader-next');
let readerId = null, readerCategory = '', readerRequest = 0, neighborRequest = 0;
let readerController, disposeArticle;
let neighbors = {};
let catalogKey = null, catalogLoading;
const navigation = createNewsNavigation({ page, overlay, onRoute: async ({ id }) => {
  const key = catalogRouteKey();
  if (key !== catalogKey) { catalogLoading = loadAnnouncements(); updateCategories(); }
  await Promise.allSettled([catalogLoading, loadReader(id)]);
} });
page.listen(document.getElementById('news-reader-close'), 'click', navigation.close);
for (const [button, direction] of [[previous, 'previous'], [next, 'next']]) {
  page.listen(button, 'click', () => { if (neighbors[direction]?.id) void navigation.jump(neighbors[direction].id); });
}
page.cleanup(() => { ++readerRequest; ++neighborRequest; readerController?.abort(); disposeArticle?.(); });

function catalogRouteKey() {
  const query = new URLSearchParams(location.search);
  return JSON.stringify([query.get('category') || '', readOffset(query, PAGE_SIZE)]);
}

function readerLabel(ready = false) {
  if (ready) { dialog.removeAttribute('aria-label'); dialog.setAttribute('aria-labelledby', 'news-reader-title'); }
  else { dialog.removeAttribute('aria-labelledby'); dialog.setAttribute('aria-label', 'Leitura da Owner News'); }
}

async function loadNeighbors(id, category, token, signal) {
  const request = ++neighborRequest;
  clear(neighborStatus);
  previous.disabled = true; next.disabled = true; neighbors = {};
  const query = new URLSearchParams();
  if (category) query.set('category', category);
  const current = () => page.active && token === readerRequest && request === neighborRequest && !signal.aborted;
  try {
    const value = await fetchAPI(`/api/announcements/${encodeURIComponent(id)}/navigation${query.size ? `?${query}` : ''}`, { signal });
    if (!current()) return;
    neighbors = value;
    previous.disabled = !value.previous?.id; next.disabled = !value.next?.id;
  } catch {
    if (current()) showState(neighborStatus, 'Não foi possível carregar anterior e próxima.', () => {
      if (current()) void loadNeighbors(id, category, token, signal);
    });
  }
}

async function loadReader(id, retry = false) {
  const category = new URLSearchParams(location.search).get('category') || '';
  if (id === readerId && category === readerCategory && !retry) return;
  readerId = id; readerCategory = category;
  const token = ++readerRequest;
  readerController?.abort(); disposeArticle?.(); disposeArticle = null;
  clear(reader); clear(neighborStatus); readerLabel();
  previous.disabled = true; next.disabled = true; neighbors = {};
  if (!id) return;
  readerController = new AbortController();
  const { signal } = readerController;
  const current = () => page.active && token === readerRequest && !signal.aborted;
  showState(reader, 'Carregando matéria…');
  const detail = (async () => {
    try {
      const article = await fetchAPI(`/api/announcements/${encodeURIComponent(id)}`, { signal });
      if (!current()) return;
      disposeArticle = renderNewsArticle(reader, article, { signal: page.signal });
      readerLabel(true);
    } catch (error) {
      if (!current()) return;
      showState(reader, error.status === 404 ? 'Esta matéria não está mais disponível.' : 'Não foi possível carregar a matéria.',
        error.status === 404 ? undefined : () => { if (current()) void loadReader(id, true); });
    }
  })();
  await Promise.allSettled([detail, loadNeighbors(id, category, token, signal)]);
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

function positionPoll() {
  const query = new URLSearchParams(location.search);
  const cards = [...list.querySelectorAll('.news-card')];
  const feed = composeNewsFeed(cards, pollAbsent ? null : pollSlot, {
    offset: readOffset(query, PAGE_SIZE), category: query.get('category') || '',
  });
  const index = feed.indexOf(pollSlot);
  if (index < 0) pollSlot.remove();
  else {
    list.classList.add('news-mosaic');
    const children = [...list.children];
    const slotIndex = children.indexOf(pollSlot);
    const after = feed[index + 1] || null;
    if (slotIndex < 0 || (children[slotIndex + 1] || null) !== after) list.insertBefore(pollSlot, after);
  }
}

async function loadPoll() {
  const token = ++pollRequest;
  pollController?.abort(); pollController = new AbortController();
  const current = () => page.active && token === pollRequest && !pollController.signal.aborted;
  clear(pollStatus);
  if (!pollComponent) showState(pollStatus, 'Carregando enquete…');
  setBusy(pollStatus, true); positionPoll();
  try {
    const { poll } = await fetchAPI('/api/announcements/polls/current', { signal: pollController.signal });
    if (!current()) return;
    pollAbsent = !poll;
    if (!poll || poll.id !== pollId) {
      pollComponent?.dispose(); pollComponent?.node.remove(); pollComponent = null; pollId = poll?.id;
      if (poll) {
        pollComponent = createNewsPoll({ page, poll });
        pollSlot.insertBefore(pollComponent.node, pollStatus);
      }
    } else pollComponent.update(poll);
    clear(pollStatus); positionPoll();
  } catch {
    if (current()) {
      pollAbsent = false;
      showState(pollStatus, 'Não foi possível atualizar a enquete.', () => { if (current()) void loadPoll(); });
      positionPoll();
    }
  } finally { if (current()) setBusy(pollStatus, false); }
}

async function loadHome() {
  const token = ++homeRequest;
  if (homeStatus) clear(homeStatus);
  try {
    const home = await fetchAPI('/api/announcements/home');
    if (token !== homeRequest) return;
    publishedHome = home?.content ?? null;
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
  catalogKey = catalogRouteKey();
  positionPoll();
  const focusAtStart = document.activeElement;
  const requestedFocus = focusDescriptor(focusAtStart);
  const requestToken = ++announcementsRequest;
  if (feedStatus) clear(feedStatus);
  if (!list.children.length) showState(list, 'Carregando publicações…');
  setBusy(list, true);
  setPaginationBusy(pagination, true);
  try {
    const query = new URLSearchParams(location.search);
    const offset = readOffset(query, PAGE_SIZE);
    if (query.get('offset') !== (offset ? String(offset) : '')) {
      const url = new URL(location.href);
      offset ? url.searchParams.set('offset', String(offset)) : url.searchParams.delete('offset');
      history.replaceState({ ...window.history.state }, '', url);
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
      history.replaceState({ ...window.history.state }, '', url);
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
    positionPoll();
    renderPagination(pagination, Number(result.total ?? announcements.length), offset, PAGE_SIZE, nextOffset => {
      if (requestToken !== announcementsRequest) return;
      const url = new URL(location.href);
      nextOffset ? url.searchParams.set('offset', String(nextOffset)) : url.searchParams.delete('offset');
      history.pushState({ ...window.history.state }, '', url);
      void navigation.sync();
    });
    restorePaginationFocus(requestedFocus, state);
  } catch {
    if (requestToken === announcementsRequest) {
      pagination?.replaceChildren();
      const target = (list.querySelector('.news-card') || pollSlot.parentNode === list) && feedStatus ? feedStatus : list;
      const state = showState(target, 'Não foi possível carregar a publicação. Verifique sua conexão ou volte às editorias.', () => { if (page.active && requestToken === announcementsRequest) loadAnnouncements(); });
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

page.listen(document.getElementById('main-content'), 'click', event => {
  const link = event.target.closest('a');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || url.pathname !== location.pathname || url.hash) return;
  event.preventDefault();
  if (url.searchParams.has('id')) {
    void navigation.open(url.searchParams.get('id'));
    return;
  }
  history.pushState({ ...window.history.state }, '', url);
  void navigation.sync();
});
page.listen(window, 'pagehide', () => {
  ++announcementsRequest;
  ++highlightRequest;
  ++homeRequest;
  ++categoriesRequest;
  ++pollRequest;
  pollController?.abort();
  pollComponent?.dispose(); pollComponent?.node.remove(); pollComponent = null; pollId = null;
  clearContent(list);
});
page.listen(window, 'pageshow', event => {
  if (event.persisted) { loadAnnouncements(); loadHome(); loadHighlight(); loadCategories(); loadPoll(); }
});
updateOpening();
void navigation.sync();
loadHome();
loadHighlight();
loadCategories();
loadPoll();
}
