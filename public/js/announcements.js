import { requireAuth, fetchAPIPage } from './auth.js';
import { clear, element, showState } from './ui.js';
import { renderPagination } from './pagination.js';
import { renderBlocks } from './cms-block-renderer.js';

const user = await requireAuth();
if (!user) throw new Error('Authentication required');

const list = document.getElementById('announcements-list');
const pagination = document.getElementById('announcements-pagination');
const PAGE_SIZE = 10;

async function loadAnnouncements() {
  showState(list, 'Carregando anúncios…');
  try {
    const query = new URLSearchParams(location.search);
    const offset = Math.max(0, Number(query.get('offset') || 0));
    const result = await fetchAPIPage(`/api/announcements?limit=${PAGE_SIZE}&offset=${offset}`);
    clear(list);
    if (!result.data.length) showState(list, 'Nenhum anúncio publicado.');
    result.data.forEach(announcement => {
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
    });
    renderPagination(pagination, Number(result.total ?? result.data.length), offset, PAGE_SIZE, nextOffset => {
      const url = new URL(location.href);
      nextOffset ? url.searchParams.set('offset', String(nextOffset)) : url.searchParams.delete('offset');
      history.pushState({}, '', url);
      loadAnnouncements();
    });
  } catch {
    showState(list, 'Não foi possível carregar os anúncios. Verifique sua conexão.', loadAnnouncements);
  }
}

window.addEventListener('popstate', loadAnnouncements);
loadAnnouncements();
