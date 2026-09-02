import { requireAuth, fetchAPI, fetchAPIPage } from './auth.js';
import { clear, element, safeHttpUrl, showState } from './ui.js';
import { readOffset, renderPagination } from './pagination.js';
import { renderBlocks } from './cms-block-renderer.js';

const user = await requireAuth();
if (!user) throw new Error('Authentication required');

const container = document.getElementById('academy-content');
const filters = document.getElementById('academy-filters');
const pagination = document.getElementById('academy-pagination');
const PAGE_SIZE = 20;
let categories = [];

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
      on: { click: () => { updateUrl(value); loadCourses(); } },
    }));
  });
}

async function loadCourses() {
  showState(container, 'Carregando cursos…');
  try {
    const query = new URLSearchParams(location.search);
    const offset = readOffset(query, PAGE_SIZE);
    const request = new URLSearchParams({ active: 'true', limit: String(PAGE_SIZE), offset: String(offset) });
    if (query.get('category')) request.set('category', query.get('category'));
    const [result, categoryList] = await Promise.all([
      fetchAPIPage(`/api/academy?${request}`),
      fetchAPI('/api/academy/categories'),
    ]);
    const courses = result.data.filter(course => course.active !== false);
    categories = categoryList;
    renderFilters();
    if (!courses.length) return showState(container, 'Nenhum curso disponível no momento.');
    const categories = Map.groupBy ? Map.groupBy(courses, course => course.category || 'Geral') : courses.reduce((map, course) => {
      const category = course.category || 'Geral';
      map.set(category, [...(map.get(category) || []), course]);
      return map;
    }, new Map());
    clear(container);
    categories.forEach((items, category) => {
      const section = element('section', { className: 'content-section' });
      section.append(element('h2', { text: category }));
      const grid = element('div', { className: 'card-grid' });
      items.forEach(course => {
        const href = safeHttpUrl(course.url);
        const card = element(href ? 'a' : 'article', href ? {
          className: 'card link-card', href, target: '_blank', rel: 'noopener noreferrer',
        } : { className: 'card' }, [
          element('div', { className: 'card-title', text: course.title }),
          element('span', { className: 'card-link-label', text: href ? 'Acessar curso →' : 'Link indisponível' }),
        ]);
        const content = element('div', { className: 'card-copy cms-public-content' });
        renderBlocks(content, course.content_blocks, { fallbackText: course.description || '' });
        card.insertBefore(content, card.lastElementChild);
        grid.append(card);
      });
      section.append(grid);
      container.append(section);
    });
    renderPagination(pagination, Number(result.total ?? courses.length), offset, PAGE_SIZE, nextOffset => {
      updateUrl(query.get('category') || '', nextOffset);
      loadCourses();
    });
  } catch {
    showState(container, 'Não foi possível carregar os cursos. Verifique sua conexão.', loadCourses);
  }
}

window.addEventListener('popstate', loadCourses);
loadCourses();
