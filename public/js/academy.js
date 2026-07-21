import { requireAuth, renderUserInTopbar, fetchAPI } from './auth.js';
import { clear, element, safeHttpUrl, showState } from './ui.js';

const user = await requireAuth();
if (!user) throw new Error('Authentication required');
renderUserInTopbar(user);
if (user.role === 'admin') document.getElementById('admin-link').style.display = '';

const container = document.getElementById('academy-content');
async function loadCourses() {
  showState(container, 'Carregando cursos…');
  try {
    const courses = (await fetchAPI('/api/academy?active=true')).filter(course => course.active !== false);
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
          element('div', { className: 'card-title', text: `🎓 ${course.title}` }),
          element('p', { className: 'card-copy', text: course.description || '' }),
          element('span', { className: 'card-link-label', text: href ? 'Acessar curso →' : 'Link indisponível' }),
        ]);
        grid.append(card);
      });
      section.append(grid);
      container.append(section);
    });
  } catch {
    showState(container, 'Não foi possível carregar os cursos. Verifique sua conexão.', loadCourses);
  }
}

loadCourses();
