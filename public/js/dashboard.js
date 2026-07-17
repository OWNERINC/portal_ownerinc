import { requireAuth, renderUserInTopbar, fetchAPI } from './auth.js';

const user = await requireAuth();
if (!user) throw new Error('not authenticated');

renderUserInTopbar(user);

if (user.role === 'admin') {
  document.getElementById('admin-link').style.display = '';
}

const today = new Date();
const isPJ = user.contract_type === 'pj' || user.is_pj;

// ── Card Nota Fiscal (PJ) ────────────────────────────────────────────────────

if (isPJ) {
  const pjCard   = document.getElementById('pj-card');
  const pjStatus = document.getElementById('pj-status');
  const dueDay   = user.pj_due_day || 5;
  const dueDate  = new Date(today.getFullYear(), today.getMonth(), dueDay);
  const diff     = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));
  pjCard.style.display = '';
  if (diff > 0) {
    pjStatus.textContent = `Vencimento em ${diff} dia(s) — dia ${dueDay} deste mês.`;
  } else if (diff === 0) {
    pjStatus.textContent = '⚠️ Vence hoje! Emita sua nota fiscal.';
    pjCard.style.borderColor = 'var(--danger)';
  } else {
    pjStatus.textContent = `✅ Nota do mês: prazo passou (dia ${dueDay}).`;
    pjCard.style.borderColor = 'var(--success)';
  }
}

// ── Widget Sólides (CLT) ─────────────────────────────────────────────────────

if (!isPJ) {
  document.getElementById('solides-card').style.display = '';
  document.getElementById('solides-status').textContent =
    'Verifique seus registros de ponto e frequência.';
}

// ── Lembretes próximos 7 dias ────────────────────────────────────────────────

const day = today.getDate();
const container = document.getElementById('reminders-list');

try {
  const allReminders = await fetchAPI('/api/reminders?active=true');
  const upcoming = allReminders
    .map(r => ({ ...r, diff: r.trigger_day - day }))
    .filter(r => r.diff >= 0 && r.diff <= 7);

  if (upcoming.length === 0) {
    container.innerHTML = '<p class="empty-state">Nenhum lembrete nos próximos 7 dias.</p>';
  } else {
    container.innerHTML = upcoming.sort((a, b) => a.diff - b.diff).map(r => `
      <div class="card">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px">
          <div class="card-title" style="margin:0">${r.title}</div>
          <span class="badge ${r.diff === 0 ? 'badge-red' : 'badge-gold'}">
            ${r.diff === 0 ? 'Hoje' : `Em ${r.diff}d`}
          </span>
        </div>
        <p style="font-size:13px; color:var(--text-secondary)">${r.description || ''}</p>
      </div>
    `).join('');
  }
} catch {
  container.innerHTML = '<p class="empty-state">Erro ao carregar lembretes.</p>';
}

// ── Quick Links dinâmicos ────────────────────────────────────────────────────

const PJ_LINKS = [
  { icon: '📄', label: 'Emitir Nota Fiscal',   desc: 'Acesse o portal da sua contabilidade', url: '#',                         external: true },
  { icon: '📚', label: 'Base de Conhecimento', desc: 'Regras e boas práticas da empresa',    url: './knowledge.html'                         },
  { icon: '🔔', label: 'Lembretes',            desc: 'Datas importantes e vencimentos',       url: './reminders.html'                         },
  { icon: '🎓', label: 'Academy',              desc: 'Cursos e treinamentos',                 url: './academy.html'                           },
];

const CLT_LINKS = [
  { icon: '⏱', label: 'Sólides — Ponto',      desc: 'Registro de frequência',                url: 'https://app.solides.com.br', external: true },
  { icon: '🎁', label: 'Benefícios',           desc: 'Parceiros e clube de vantagens',        url: './benefits.html'                           },
  { icon: '📚', label: 'Base de Conhecimento', desc: 'Regras e boas práticas da empresa',    url: './knowledge.html'                           },
  { icon: '🔔', label: 'Lembretes',            desc: 'Datas importantes e vencimentos',       url: './reminders.html'                           },
  { icon: '🎓', label: 'Academy',              desc: 'Cursos e treinamentos',                 url: './academy.html'                             },
];

const links = isPJ ? PJ_LINKS : CLT_LINKS;
document.getElementById('quick-links').innerHTML = links.map(l =>
  `<a href="${l.url}" class="card"${l.external ? ' target="_blank" rel="noopener"' : ''}
      style="text-decoration:none; cursor:pointer">
    <div class="card-title">${l.icon} ${l.label}</div>
    <p style="font-size:13px; color:var(--text-secondary)">${l.desc}</p>
  </a>`
).join('');

// ── Vitrine Academy (3 primeiros cursos ativos) ──────────────────────────────

try {
  const courses = await fetchAPI('/api/academy?active=true&limit=3');
  if (courses.length > 0) {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="page-header" style="margin-top:40px">
        <h1>Academy</h1>
        <a href="./academy.html" style="font-size:13px; color:var(--primary)">Ver todos →</a>
      </div>
      <div class="card-grid">
        ${courses.map(c => `
          <a href="${c.url}" target="_blank" rel="noopener" class="card" style="text-decoration:none">
            <div class="card-title">🎓 ${c.title}</div>
            <p style="font-size:13px; color:var(--text-secondary)">${c.description || c.category || ''}</p>
          </a>
        `).join('')}
      </div>
    `;
    document.querySelector('.page-body').appendChild(wrap);
  }
} catch {
  // Academy ainda sem dados — silencioso
}
