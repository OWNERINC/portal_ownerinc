import { requireAuth, fetchAPI, fetchAPIPage } from './auth.js';
import { clear, element, setBusy, showState } from './ui.js';
import { readOffset, renderPagination, setPaginationBusy } from './pagination.js';
import { renderBlocks } from './cms-block-renderer.js';

const user = await requireAuth();
if (!user) throw new Error('Authentication required');

const list = document.getElementById('announcements-list');
const pagination = document.getElementById('announcements-pagination');
const PAGE_SIZE = 10;
let announcementsRequest = 0;

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
  setBusy(list, true);
  setPaginationBusy(pagination, true);
  try {
    const query = new URLSearchParams(location.search);
    const announcementId = query.get('id');
    if (announcementId) {
      const announcement = await fetchAPI(`/api/announcements/${encodeURIComponent(announcementId)}`);
      if (requestToken !== announcementsRequest) return;
      clear(list);
      pagination?.replaceChildren();
      const article = element('article', { className: 'card announcement-card' }, [
        element('div', { className: 'card-heading' }, [
          element('h2', { className: 'card-title', text: announcement.title }),
          element('span', { className: 'badge badge-gold', text: announcement.category || 'Comunicado' }),
        ]),
      ]);
      const content = element('div', { className: 'cms-public-content' });
      renderBlocks(content, announcement.content_blocks, { fallbackText: 'Este anúncio não possui conteúdo disponível.' });
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
    const result = await fetchAPIPage(`/api/announcements?limit=${PAGE_SIZE}&offset=${offset}`);
    if (requestToken !== announcementsRequest) return;
    const announcements = Array.isArray(result.data) ? result.data : [];
    if (!announcements.length && offset > 0) {
      const url = new URL(location.href);
      url.searchParams.delete('offset');
      history.replaceState({}, '', url);
      return loadAnnouncements();
    }
    clear(list);
    const state = !announcements.length ? showState(list, 'Nenhum anúncio publicado.') : null;
    announcements.forEach(announcement => {
      const article = element('article', { className: 'card announcement-card' }, [
        element('div', { className: 'card-heading' }, [
          element('h2', { className: 'card-title' }, [
            element('a', { href: `?id=${encodeURIComponent(announcement.id)}`, text: announcement.title }),
          ]),
          element('span', { className: 'badge badge-gold', text: announcement.category || 'Comunicado' }),
        ]),
      ]);
      const content = element('div', { className: 'cms-public-content' });
      renderBlocks(content, announcement.content_blocks, { fallbackText: 'Este anúncio não possui conteúdo disponível.' });
      article.append(content);
      list.append(article);
    });
    renderPagination(pagination, Number(result.total ?? announcements.length), offset, PAGE_SIZE, nextOffset => {
      if (requestToken !== announcementsRequest) return;
      const url = new URL(location.href);
      nextOffset ? url.searchParams.set('offset', String(nextOffset)) : url.searchParams.delete('offset');
      history.pushState({}, '', url);
      loadAnnouncements();
    });
    restorePaginationFocus(requestedFocus, state);
  } catch {
    if (requestToken === announcementsRequest) {
      const state = showState(list, 'Não foi possível carregar os anúncios. Verifique sua conexão.', loadAnnouncements);
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

window.addEventListener('popstate', loadAnnouncements);
loadAnnouncements();
