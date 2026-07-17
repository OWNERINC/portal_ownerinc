import { requireAuth, renderUserInTopbar, fetchAPI } from './auth.js';

const user = await requireAuth();
if (!user) throw new Error('not authenticated');

renderUserInTopbar(user);
if (user.role === 'admin') document.getElementById('admin-link').style.display = '';

const container = document.getElementById('benefits-content');

try {
  const items = await fetchAPI('/api/benefits?active=true');

  if (items.length === 0) {
    container.innerHTML = '<p class="empty-state">Nenhum benefício disponível no momento.</p>';
  } else {
    const byCategory = {};
    items.forEach(b => {
      const cat = b.category || 'Geral';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(b);
    });

    container.innerHTML = Object.entries(byCategory).map(([cat, benefits]) => `
      <div class="page-header" style="margin-bottom:16px">
        <h1>${cat}</h1>
      </div>
      <div class="card-grid" style="margin-bottom:32px">
        ${benefits.map(b => `
          <div class="card">
            <div class="card-title">🎁 ${b.company}</div>
            <p style="font-size:14px; color:var(--espresso); margin-top:6px; font-weight:500">${b.description || ''}</p>
            ${b.instructions ? `
              <div style="margin-top:10px; padding:8px 10px; background:var(--bg); border-radius:var(--radius-sm); font-size:12px; color:var(--text-secondary)">
                ℹ️ ${b.instructions}
              </div>
            ` : ''}
          </div>
        `).join('')}
      </div>
    `).join('');
  }

} catch {
  container.innerHTML = '<p class="empty-state">Erro ao carregar benefícios.</p>';
}
