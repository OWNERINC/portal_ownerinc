import { fetchAPI, fetchAPIPage } from './auth.js';
import { clear, element, showState } from './ui.js';
import { readOffset, renderPagination } from './pagination.js';
import { renderBlocks } from './cms-block-renderer.js';

const requests = { fetchAPI, fetchAPIPage };
const renderContent = renderBlocks;
export function mount(page) {
const { fetchAPI, fetchAPIPage } = page.bindAPI(requests);
const renderBlocks = (node, blocks, options) => renderContent(node, blocks, { ...options, signal: page.signal });
const history = page.history;
const location = page.location;
page.cleanup(() => { ++benefitsRequest; });

const container = document.getElementById('benefits-content');
const filters = document.getElementById('benefits-filters');
const pagination = document.getElementById('benefits-pagination');
const PAGE_SIZE = 20;
let categories = [];
let benefitsRequest = 0;

function updateUrl(category = '', offset = 0) {
  const url = new URL(location.href);
  category ? url.searchParams.set('category', category) : url.searchParams.delete('category');
  offset ? url.searchParams.set('offset', String(offset)) : url.searchParams.delete('offset');
  history.replaceState({}, '', url);
}

function renderFilters() {
  const selected = new URLSearchParams(location.search).get('category') || '';
  clear(filters);
  ['Todos', ...categories].forEach(category => {
    const value = category === 'Todos' ? '' : category;
    filters.append(element('button', {
      className: `badge category-filter ${value === selected ? 'badge-gold' : 'badge-gray'}`,
      type: 'button', text: category, 'aria-pressed': String(value === selected),
      on: { click: () => { updateUrl(value); loadBenefits(); } },
    }));
  });
}

async function loadBenefits() {
  const requestToken = ++benefitsRequest;
  showState(container, 'Carregando benefícios…');
  try {
    const query = new URLSearchParams(location.search);
    const offset = readOffset(query, PAGE_SIZE);
    const request = new URLSearchParams({ active: 'true', limit: String(PAGE_SIZE), offset: String(offset) });
    if (query.get('category')) request.set('category', query.get('category'));
    const [result, categoryList] = await Promise.all([
      fetchAPIPage(`/api/benefits?${request}`),
      fetchAPI('/api/benefits/categories'),
    ]);
    if (requestToken !== benefitsRequest) return;
    const benefits = (result.data || []).filter(item => item.active !== false);
    categories = categoryList || [];
    renderFilters();
    const total = Number(result.total ?? benefits.length);
    if (!benefits.length && offset > 0) {
      updateUrl(query.get('category') || '', 0);
      return loadBenefits();
    }
    if (!benefits.length) {
      clear(pagination);
      return showState(container, 'Nenhum benefício disponível no momento.');
    }
    const categories = benefits.reduce((map, benefit) => {
      const category = benefit.category || 'Geral';
      map.set(category, [...(map.get(category) || []), benefit]);
      return map;
    }, new Map());
    clear(container);
    categories.forEach((items, category) => {
      const section = element('section', { className: 'content-section' }, [element('h2', { text: category })]);
      const grid = element('div', { className: 'card-grid' });
      items.forEach(benefit => {
        const card = element('article', { className: 'card' }, [
          element('div', { className: 'card-title', text: benefit.company }),
        ]);
        const content = element('div', { className: 'benefit-description cms-public-content' });
        renderBlocks(content, benefit.content_blocks, { fallbackText: benefit.description || '' });
        card.append(content);
        if (benefit.instructions) card.append(element('p', { className: 'info-panel', text: `Como usar: ${benefit.instructions}` }));
        grid.append(card);
      });
      section.append(grid);
      container.append(section);
    });
    renderPagination(pagination, total, offset, PAGE_SIZE, nextOffset => {
      updateUrl(query.get('category') || '', nextOffset);
      loadBenefits();
    });
  } catch {
    if (requestToken === benefitsRequest) {
      showState(container, 'Não foi possível carregar os benefícios. Verifique sua conexão.', loadBenefits);
    }
  }
}

page.listen(window, 'popstate', loadBenefits);
loadBenefits();
}
