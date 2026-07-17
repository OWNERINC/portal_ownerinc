import { requireAuth, renderUserInTopbar, fetchAPI } from './auth.js';

const user = await requireAuth();
if (!user) throw new Error('not authenticated');

renderUserInTopbar(user);
if (user.role === 'admin') document.getElementById('admin-link').style.display = '';

const container = document.getElementById('academy-content');

try {
  const courses = await fetchAPI('/api/academy?active=true');

  if (courses.length === 0) {
    container.innerHTML = '<p class="empty-state">Nenhum curso disponível no momento.</p>';
    return;
  }

  // Agrupar por categoria
  const byCategory = {};
  courses.forEach(c => {
    const cat = c.category || 'Geral';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(c);
  });

  container.innerHTML = Object.entries(byCategory).map(([cat, items]) => `
    <div class="page-header" style="margin-bottom:16px">
      <h1>${cat}</h1>
    </div>
    <div class="card-grid" style="margin-bottom:32px">
      ${items.map(c => `
        <a href="${c.url}" target="_blank" rel="noopener" class="card" style="text-decoration:none; cursor:pointer">
          <div class="card-title">🎓 ${c.title}</div>
          <p style="font-size:13px; color:var(--text-secondary); margin-top:4px">${c.description || ''}</p>
          <span style="font-size:12px; color:var(--primary); margin-top:12px; display:inline-block">Acessar curso →</span>
        </a>
      `).join('')}
    </div>
  `).join('');

} catch {
  container.innerHTML = '<p class="empty-state">Erro ao carregar cursos.</p>';
}
