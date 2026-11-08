import { fetchAPI } from './auth.js';
import { clear, element, safeHttpUrl, setBusy, showState } from './ui.js';

const requests = { fetchAPI };
export function mount(page) {
  const { fetchAPI } = page.bindAPI(requests);
page.cleanup(() => { ++remindersRequest; ++academyRequest; });

const TIME_ZONE = 'America/Sao_Paulo';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const greeting = document.getElementById('dashboard-greeting');
if (greeting) {
  const hour = Number(new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  greeting.textContent = `${hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite'}. Vamos nos conectar?`;
}

function civilDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  return parts.reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
}

function civilDateOrdinal(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : NaN;
}

function daysUntil(value) {
  const today = civilDateKey();
  const todayKey = `${today.year}-${today.month}-${today.day}`;
  const difference = civilDateOrdinal(value) - civilDateOrdinal(todayKey);
  return Number.isFinite(difference) ? Math.max(0, Math.round(difference / 86400000)) : 0;
}

function reminderContentHref(reminder) {
  const id = typeof reminder?.id === 'string' && UUID_PATTERN.test(reminder.id)
    ? reminder.id.toLowerCase() : null;
  if (!id) return './reminders.html';
  const expected = `/reminders.html#reminder-${id}`;
  return reminder.content_url === expected ? reminder.content_url : expected;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `./assets/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

function storyCard({ title, category, description, href, newTab, course, continuing }) {
  const titleNode = href
    ? element('a', {
      className: 'dashboard-story-card-title', href,
      ...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
    }, [element('strong', { text: title })])
    : element('strong', { text: title });
  const body = element('div', { className: 'dashboard-story-card-body' }, [
    element('small', { text: ['Academy', category].filter(Boolean).join(' · ') }),
    titleNode,
  ]);
  if (description) {
    const copy = element('div', { className: 'dashboard-story-card-copy' });
    copy.append(element('p', { text: description }));
    body.append(copy);
  }
  if (course.delivery_mode === 'internal') {
    const total = Math.max(0, Number(course.total_lessons) || 0);
    const completed = Math.min(total, Math.max(0, Number(course.completed_lessons) || 0));
    body.append(element('small', { text: `${completed} de ${total} aulas concluídas` }));
    if (total) body.append(element('progress', { className: 'dashboard-course-progress', value: completed, max: total, 'aria-label': `Progresso: ${title}` }));
  }
  body.append(element('a', {
    className: 'btn btn-primary dashboard-course-action', href,
    text: newTab ? 'Acessar curso externo ↗' : continuing ? 'Continuar curso' : 'Conhecer curso',
    ...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
  }));
  const key = /^icon-0[1-6]$/.test(course.icon_key) ? course.icon_key : 'symbol';
  return element('article', { className: 'dashboard-story-card' }, [
    element('img', { className: 'dashboard-course-cover', src: `./assets/academy/${key}.svg`, alt: '', width: 640, height: 360 }), body,
  ]);
}

function reminderCard(reminder, days) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(reminder.next_occurrence || '')
    ? new Date(`${reminder.next_occurrence}T12:00:00Z`) : null;
  const valid = date && Number.isFinite(date.valueOf());
  const tile = element('div', { className: 'dashboard-reminder-date', 'aria-hidden': 'true' }, [
    element('strong', { text: valid ? new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, day: '2-digit' }).format(date) : '—' }),
    element('span', { text: valid ? new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, month: 'short' }).format(date).replace('.', '').toLocaleUpperCase('pt-BR') : '' }),
  ]);
  const copy = element('div', { className: 'dashboard-reminder-copy' }, [
    element('a', { href: reminderContentHref(reminder), text: reminder.title }),
    element('p', { text: valid ? days === 0 ? 'Hoje' : `Em ${days} ${days === 1 ? 'dia' : 'dias'}` : 'Data a confirmar' }),
  ]);
  if (reminder.description) copy.append(element('p', { text: reminder.description }));
  return element('article', { className: 'dashboard-reminder' }, [tile, copy]);
}

const remindersContainer = document.getElementById('reminders-list');
let remindersRequest = 0;
async function loadReminders() {
  if (!remindersContainer || !page.active) return;
  const requestToken = ++remindersRequest;
  setBusy(remindersContainer, true);
  try {
    const reminders = await fetchAPI('/api/reminders/upcoming?days=7');
    if (requestToken !== remindersRequest) return;
    const upcoming = reminders.map(reminder => {
      return { reminder, days: daysUntil(reminder.next_occurrence) };
    });
    if (!upcoming.length) return showState(remindersContainer, 'Nenhum lembrete destinado a você nos próximos 7 dias.');
    clear(remindersContainer);
    upcoming.forEach(({ reminder, days }) => remindersContainer.append(reminderCard(reminder, days)));
  } catch {
    if (requestToken === remindersRequest) showState(remindersContainer, 'Não foi possível carregar os lembretes. Verifique sua conexão.', loadReminders);
  } finally {
    if (requestToken === remindersRequest) setBusy(remindersContainer, false);
  }
}

const quickLinks = document.getElementById('quick-links');
const links = [
  ['book-open', 'Conhecimento', './knowledge.html'],
  ['bell', 'Lembretes', './reminders.html'],
  ['graduation-cap', 'Academy', './academy.html'],
];
if (quickLinks) {
  links.forEach(([iconName, label, href]) => quickLinks.append(element('a', { className: 'dashboard-area-card', href }, [
    icon(iconName),
    element('span', { className: 'dashboard-area-card-copy' }, [
      element('strong', { text: label }),
    ]),
  ])));
}

const academySection = document.getElementById('academy-preview');
let academyRequest = 0;
async function loadAcademy() {
  if (!academySection || !page.active) return;
  const requestToken = ++academyRequest;
  const focused = academySection.contains(document.activeElement) ? document.activeElement : null;
  const renderState = (message, retry) => {
    const restoreFocus = focused && document.activeElement === focused;
    const state = showState(academySection, message, retry);
    if (restoreFocus && state) {
      const target = state.querySelector('button') || state;
      if (target === state) state.tabIndex = -1;
      target.focus();
    }
  };
  setBusy(academySection, true);
  try {
    let courses = (await fetchAPI('/api/academy/continue?limit=1')).filter(course => course.active !== false).slice(0, 1);
    if (requestToken !== academyRequest) return;
    const continuing = courses.length > 0;
    if (!continuing) courses = (await fetchAPI('/api/academy?active=true&limit=1')).filter(course => course.active !== false).slice(0, 1);
    if (requestToken !== academyRequest) return;
    const heading = document.getElementById('academy-heading');
    if (heading) heading.textContent = continuing ? 'Continue de onde parou' : 'Comece a aprender';
    if (!courses.length) return renderState('Nenhum curso disponível no momento.');
    const restoreFocus = focused && document.activeElement === focused;
    clear(academySection);
    courses.forEach(course => {
      const href = course.delivery_mode === 'internal'
        ? `./academy.html?course=${encodeURIComponent(course.id)}${continuing && course.resume_lesson_id ? `&lesson=${encodeURIComponent(course.resume_lesson_id)}` : ''}`
        : safeHttpUrl(course.url) || './academy.html';
      academySection.append(storyCard({
        title: course.title,
        category: course.category || 'Desenvolvimento',
        description: course.description || '',
        href,
        newTab: course.delivery_mode !== 'internal' && Boolean(safeHttpUrl(course.url)),
        course, continuing,
      }));
    });
    if (restoreFocus) academySection.querySelector('a')?.focus();
  } catch {
    if (requestToken === academyRequest) renderState('Não foi possível carregar os cursos.', loadAcademy);
  } finally {
    if (requestToken === academyRequest) setBusy(academySection, false);
  }
}

page.listen(window, 'pageshow', event => {
  if (!event.persisted) return;
  void Promise.all([loadReminders(), loadAcademy()]);
});

void Promise.all([loadReminders(), loadAcademy()]);
}
