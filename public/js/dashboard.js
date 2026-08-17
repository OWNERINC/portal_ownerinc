import { requireAuth, fetchAPI } from './auth.js';
import { clear, element, safeHttpUrl, showState } from './ui.js';
import { renderBlocks } from './cms-block-renderer.js';

const user = await requireAuth();
if (!user) throw new Error('Authentication required');

const spotlight = document.getElementById('home-spotlight');
const spotlightItems = [
  { eyebrow: 'Ownerinc', title: 'Seu portal interno', copy: 'Acesse conteúdos, benefícios e recursos para sua jornada.' },
  { eyebrow: 'Dica rápida', title: 'Mantenha seu perfil atualizado', copy: 'Revise seus dados para facilitar a comunicação interna.', href: './profile.html', action: 'Abrir perfil' },
];
let spotlightIndex = 0;
let spotlightTimer = null;

function renderSpotlight() {
  if (!spotlight || !spotlightItems.length) return;
  const current = spotlightItems[spotlightIndex];
  const dots = spotlightItems.map((_, index) => element('button', {
    className: `home-spotlight-dot${index === spotlightIndex ? ' active' : ''}`,
    type: 'button',
    'aria-label': `Mostrar destaque ${index + 1}`,
    'aria-current': index === spotlightIndex ? 'true' : 'false',
    on: { click: () => { spotlightIndex = index; renderSpotlight(); restartSpotlight(); } },
  }));
  const action = current.href ? element('a', { className: 'card-link-label', href: current.href, text: current.action }) : null;
  clear(spotlight).append(element('article', { className: 'card home-spotlight-card' }, [
    element('div', {}, [
      element('div', { className: 'home-spotlight-eyebrow', text: current.eyebrow }),
      element('h2', { className: 'home-spotlight-title', text: current.title }),
      element('p', { className: 'home-spotlight-copy', text: current.copy }),
    ]),
    element('div', { className: 'home-spotlight-footer' }, [
      element('div', { className: 'home-spotlight-dots' }, dots),
      element('div', { className: 'home-spotlight-controls' }, [
        element('button', { className: 'btn btn-ghost home-spotlight-control', type: 'button', 'aria-label': 'Destaque anterior', text: '‹', on: { click: () => { spotlightIndex = (spotlightIndex - 1 + spotlightItems.length) % spotlightItems.length; renderSpotlight(); restartSpotlight(); } } }),
        element('button', { className: 'btn btn-ghost home-spotlight-control', type: 'button', 'aria-label': 'Próximo destaque', text: '›', on: { click: () => { spotlightIndex = (spotlightIndex + 1) % spotlightItems.length; renderSpotlight(); restartSpotlight(); } } }),
      ]),
      ...(action ? [action] : []),
    ]),
  ]));
}

function stopSpotlight() { if (spotlightTimer) { clearInterval(spotlightTimer); spotlightTimer = null; } }
function restartSpotlight() {
  stopSpotlight();
  if (spotlightItems.length > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    spotlightTimer = setInterval(() => { spotlightIndex = (spotlightIndex + 1) % spotlightItems.length; renderSpotlight(); }, 7000);
  }
}

renderSpotlight();
if (spotlight) {
  spotlight.addEventListener('pointerenter', stopSpotlight);
  spotlight.addEventListener('pointerleave', restartSpotlight);
  spotlight.addEventListener('focusin', stopSpotlight);
  spotlight.addEventListener('focusout', event => { if (!spotlight.contains(event.relatedTarget)) restartSpotlight(); });
  document.addEventListener('visibilitychange', () => document.hidden ? stopSpotlight() : restartSpotlight());
}

const isPJ = user.contract_type === 'pj' || user.is_pj;

const remindersContainer = document.getElementById('reminders-list');
const announcementsPreview = document.getElementById('announcements-preview');
async function loadAnnouncements() {
  showState(announcementsPreview, 'Carregando anúncios…');
  try {
    const announcements = (await fetchAPI('/api/announcements?limit=3&offset=0')).slice(0, 3);
    if (!announcements.length) return showState(announcementsPreview, 'Nenhum anúncio publicado.');
    clear(announcementsPreview);
    announcements.forEach(announcement => {
      const card = element('article', { className: 'card announcement-card' }, [
        element('div', { className: 'card-heading' }, [
          element('div', { className: 'card-title', text: announcement.title }),
          element('span', { className: 'badge badge-gold', text: announcement.category || 'Comunicado' }),
        ]),
      ]);
      const content = element('div', { className: 'card-copy cms-public-content' });
      renderBlocks(content, announcement.content_blocks, { fallbackText: 'Comunicado publicado.' });
      card.append(content);
      announcementsPreview.append(card);
    });
  } catch {
    showState(announcementsPreview, 'Não foi possível carregar os anúncios.', loadAnnouncements);
  }
}
async function loadReminders() {
  showState(remindersContainer, 'Carregando lembretes…');
  try {
    const reminders = await fetchAPI('/api/reminders/upcoming?days=7');
    const upcoming = reminders.map(reminder => {
      const occurrence = new Date(`${reminder.next_occurrence}T00:00:00Z`);
      const days = Math.max(0, Math.round((occurrence - new Date()) / 86400000));
      return { reminder, occurrence: { date: occurrence, days } };
    });
    if (!upcoming.length) return showState(remindersContainer, 'Nenhum lembrete destinado a você nos próximos 7 dias.');
    const next = upcoming[0];
    spotlightItems.push({
      eyebrow: 'Próximo lembrete',
      title: next.reminder.title,
      copy: next.occurrence.days === 0 ? 'Vence hoje.' : `Vence em ${next.occurrence.days} ${next.occurrence.days === 1 ? 'dia' : 'dias'}.`,
      href: './reminders.html',
      action: 'Ver lembretes',
    });
    renderSpotlight();
    restartSpotlight();
    clear(remindersContainer);
    upcoming.forEach(({ reminder, occurrence }) => {
      const heading = element('div', { className: 'card-title', text: reminder.title });
      const badge = element('span', {
        className: `badge ${occurrence.days === 0 ? 'badge-red' : 'badge-gold'}`,
        text: occurrence.days === 0 ? 'Hoje' : `Em ${occurrence.days} ${occurrence.days === 1 ? 'dia' : 'dias'}`,
      });
      const top = element('div', { className: 'card-heading' }, [heading, badge]);
      const content = element('div', { className: 'card-copy reminder-content' });
      renderBlocks(content, reminder.content_blocks, { fallbackText: reminder.description || '' });
      remindersContainer.append(element('article', { className: 'card' }, [top, content]));
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
    spotlightItems.push({
      eyebrow: 'Academy',
      title: courses[0].title,
      copy: courses[0].description || courses[0].category || 'Confira os cursos disponíveis para você.',
      href: './academy.html',
      action: 'Ver Academy',
    });
    renderSpotlight();
    restartSpotlight();
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

await Promise.all([loadAnnouncements(), loadReminders(), loadAcademy()]);
