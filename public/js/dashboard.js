import { requireAuth, renderUserInTopbar, fetchAPI } from './auth.js';
import { clear, element, safeHttpUrl, showState } from './ui.js';

const user = await requireAuth();
if (!user) throw new Error('Authentication required');
renderUserInTopbar(user);
if (user.role === 'admin') document.getElementById('admin-link').style.display = '';

const today = new Date();
const isPJ = user.contract_type === 'pj' || user.is_pj;
let solidesIntegration = null;

if (!isPJ) {
  try { solidesIntegration = await fetchAPI('/api/solides/me/status'); } catch (error) {
    if (error.status !== 404) console.warn('Sólides feature discovery failed');
  }
}

if (isPJ) {
  const card = document.getElementById('pj-card');
  const status = document.getElementById('pj-status');
  const dueDay = user.pj_due_day || 5;
  const dueDate = new Date(today.getFullYear(), today.getMonth(), Math.min(dueDay, new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()));
  const diff = Math.ceil((dueDate - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  card.style.display = '';
  status.textContent = diff > 0
    ? `Prazo informado: ${diff} ${diff === 1 ? 'dia' : 'dias'}, no dia ${dueDay}. Confirme o envio com a área responsável.`
    : diff === 0
      ? 'O prazo informado é hoje. Confirme o envio com a área responsável.'
      : `O prazo informado deste mês foi no dia ${dueDay}. Consulte a área responsável em caso de pendência.`;
} else {
  document.getElementById('solides-card').style.display = '';
  const link = document.getElementById('solides-link');
  if (solidesIntegration?.linked) {
    document.getElementById('solides-status').textContent = 'Consulte seu resumo de ponto, escala e banco de horas no Portal.';
    link.href = './solides.html';
    link.removeAttribute('target');
    link.removeAttribute('rel');
    link.textContent = 'Ver minha jornada →';
  } else {
    document.getElementById('solides-status').textContent = 'Verifique seus registros de ponto e frequência.';
  }
}

function isTargeted(reminder) {
  const target = reminder.target_users;
  if (target === 'all') return true;
  if (target === 'pj') return isPJ;
  if (target === 'clt') return !isPJ;
  return Array.isArray(target) && target.includes(user.uid);
}

function nextOccurrence(triggerDay) {
  for (let offset = 0; offset < 2; offset += 1) {
    const year = today.getFullYear();
    const month = today.getMonth() + offset;
    const lastDay = new Date(year, month + 1, 0).getDate();
    const occurrence = new Date(year, month, Math.min(Number(triggerDay), lastDay));
    occurrence.setHours(0, 0, 0, 0);
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    if (occurrence >= start) return { date: occurrence, days: Math.round((occurrence - start) / 86400000) };
  }
  return null;
}

const remindersContainer = document.getElementById('reminders-list');
async function loadReminders() {
  showState(remindersContainer, 'Carregando lembretes…');
  try {
    const reminders = await fetchAPI('/api/reminders?active=true');
    const upcoming = reminders
      .filter(reminder => reminder.active !== false && isTargeted(reminder))
      .map(reminder => ({ reminder, occurrence: nextOccurrence(reminder.trigger_day) }))
      .filter(item => item.occurrence && item.occurrence.days <= 7)
      .sort((a, b) => a.occurrence.days - b.occurrence.days);
    if (!upcoming.length) return showState(remindersContainer, 'Nenhum lembrete destinado a você nos próximos 7 dias.');
    clear(remindersContainer);
    upcoming.forEach(({ reminder, occurrence }) => {
      const heading = element('div', { className: 'card-title', text: reminder.title });
      const badge = element('span', {
        className: `badge ${occurrence.days === 0 ? 'badge-red' : 'badge-gold'}`,
        text: occurrence.days === 0 ? 'Hoje' : `Em ${occurrence.days} ${occurrence.days === 1 ? 'dia' : 'dias'}`,
      });
      const top = element('div', { className: 'card-heading' }, [heading, badge]);
      const description = element('p', { className: 'card-copy', text: reminder.description || '' });
      remindersContainer.append(element('article', { className: 'card' }, [top, description]));
    });
  } catch {
    showState(remindersContainer, 'Não foi possível carregar os lembretes. Verifique sua conexão.', loadReminders);
  }
}

const links = isPJ ? [
  ['📚', 'Base de Conhecimento', 'Regras e boas práticas da empresa', './knowledge.html'],
  ['🔔', 'Lembretes', 'Datas importantes e vencimentos', './reminders.html'],
  ['🎓', 'Academy', 'Cursos e treinamentos', './academy.html'],
] : [
  ['⏱', 'Sólides — Ponto', 'Registro de frequência', solidesIntegration?.linked ? './solides.html' : 'https://app.solides.com.br'],
  ['🎁', 'Benefícios', 'Parceiros e clube de vantagens', './benefits.html'],
  ['📚', 'Base de Conhecimento', 'Regras e boas práticas da empresa', './knowledge.html'],
  ['🔔', 'Lembretes', 'Datas importantes e vencimentos', './reminders.html'],
  ['🎓', 'Academy', 'Cursos e treinamentos', './academy.html'],
];

const quickLinks = document.getElementById('quick-links');
links.forEach(([icon, label, description, href]) => {
  const external = href.startsWith('http');
  quickLinks.append(element('a', {
    className: 'card link-card', href, ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
  }, [element('div', { className: 'card-title', text: `${icon} ${label}` }), element('p', { className: 'card-copy', text: description })]));
});

const academySection = document.getElementById('academy-preview');
async function loadAcademy() {
  showState(academySection, 'Carregando cursos…');
  try {
    const courses = (await fetchAPI('/api/academy?active=true&limit=3')).filter(course => course.active !== false).slice(0, 3);
    if (!courses.length) return showState(academySection, 'Nenhum curso disponível no momento.');
    const grid = element('div', { className: 'card-grid' });
    courses.forEach(course => {
      const href = safeHttpUrl(course.url);
      const card = element(href ? 'a' : 'article', href ? {
        className: 'card link-card', href, target: '_blank', rel: 'noopener noreferrer',
      } : { className: 'card' }, [
        element('div', { className: 'card-title', text: `🎓 ${course.title}` }),
        element('p', { className: 'card-copy', text: course.description || course.category || '' }),
      ]);
      grid.append(card);
    });
    clear(academySection).append(grid);
  } catch {
    showState(academySection, 'Não foi possível carregar os cursos.', loadAcademy);
  }
}

await Promise.all([loadReminders(), loadAcademy()]);
