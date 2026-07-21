import { requireAuth, renderUserInTopbar, fetchAPI } from './auth.js';
import { clear, element, showState } from './ui.js';

const user = await requireAuth();
if (!user) throw new Error('Authentication required');
renderUserInTopbar(user);
if (user.role === 'admin') document.getElementById('admin-link').style.display = '';

const container = document.getElementById('benefits-content');
async function loadBenefits() {
  showState(container, 'Carregando benefícios…');
  try {
    const benefits = (await fetchAPI('/api/benefits?active=true')).filter(item => item.active !== false);
    if (!benefits.length) return showState(container, 'Nenhum benefício disponível no momento.');
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
          element('div', { className: 'card-title', text: `🎁 ${benefit.company}` }),
          element('p', { className: 'benefit-description', text: benefit.description || '' }),
        ]);
        if (benefit.instructions) card.append(element('p', { className: 'info-panel', text: `Como usar: ${benefit.instructions}` }));
        grid.append(card);
      });
      section.append(grid);
      container.append(section);
    });
  } catch {
    showState(container, 'Não foi possível carregar os benefícios. Verifique sua conexão.', loadBenefits);
  }
}

loadBenefits();
