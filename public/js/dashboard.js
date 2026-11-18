import { fetchAPI } from './auth.js';
import { clear, element, setBusy, showState } from './ui.js';

const requests = { fetchAPI };
export function mount(page) {
  const { fetchAPI } = page.bindAPI(requests);
page.cleanup(() => { ++remindersRequest; ++ethicsRequest; });
const user = page.user || {};

const TIME_ZONE = 'America/Sao_Paulo';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const greeting = document.getElementById('dashboard-greeting');
if (greeting) {
  const hour = Number(new Intl.DateTimeFormat('pt-BR', { timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  const salutation = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';
  const name = typeof user.name === 'string' ? user.name.trim().split(/\s+/)[0] : '';
  greeting.textContent = `${salutation}${name ? `, ${name}` : ''}. Boas-vindas ao Conecta.`;
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
    if (requestToken !== remindersRequest || !page.active) return;
    const upcoming = reminders.map(reminder => {
      return { reminder, days: daysUntil(reminder.next_occurrence) };
    });
    if (!upcoming.length) return showState(remindersContainer, 'Nenhuma notificação destinada a você nos próximos 7 dias.');
    clear(remindersContainer);
    upcoming.forEach(({ reminder, days }) => remindersContainer.append(reminderCard(reminder, days)));
  } catch {
    if (requestToken === remindersRequest && page.active) showState(remindersContainer, 'Não foi possível carregar as notificações. Verifique sua conexão.', loadReminders);
  } finally {
    if (requestToken === remindersRequest && page.active) setBusy(remindersContainer, false);
  }
}

const quickLinks = document.getElementById('quick-links');
const links = [
  ['book-open', 'Conhecimento', './knowledge.html', 'Consulte documentos, orientações e materiais de referência da Ownerinc.'],
  ['bell', 'Notificações', './reminders.html', 'Acompanhe os avisos e as datas destinados a você.'],
  ['layout-template', 'Pages', './pages.html', 'Leia as páginas internas compartilhadas com o seu perfil.'],
  ['user', 'Meu Perfil', './profile.html', 'Atualize seu nome, sua foto e os dados da sua conta.'],
];
function appendLinks(container, entries) {
  if (!container) return;
  clear(container);
  entries.forEach(([iconName, label, href, description]) => container.append(element('a', { className: 'dashboard-area-card', href }, [
    icon(iconName),
    element('span', { className: 'dashboard-area-card-copy' }, [
      element('strong', { text: label }),
      element('span', { text: description }),
    ]),
  ])));
}
appendLinks(quickLinks, links);

const tools = [];
if (user.autocard_access === true) tools.push(['layout-template', 'AutoCard', './autocard.html', 'Crie e exporte cards com os modelos disponíveis.']);
if (user.pos_cards_access === true) tools.push(['badge-check', 'Cards Pós', './cards-pos.html', 'Crie convites e confirmações de reserva em PDF.']);
if (user.role === 'admin') tools.push(['settings-2', 'Admin', './admin.html', 'Gerencie as áreas autorizadas para sua conta.']);
const toolsSection = document.getElementById('dashboard-tools');
if (toolsSection) {
  toolsSection.hidden = tools.length === 0;
  appendLinks(document.getElementById('tool-links'), tools);
}

const ethicsSection = document.getElementById('ethics-preview');
let ethicsRequest = 0;
async function loadEthics() {
  if (!ethicsSection || !page.active) return;
  const requestToken = ++ethicsRequest;
  const focused = ethicsSection.contains(document.activeElement) ? document.activeElement : null;
  const renderState = (message, retry) => {
    const restoreFocus = focused && document.activeElement === focused;
    const state = showState(ethicsSection, message, retry);
    if (restoreFocus && state) {
      const target = state.querySelector('button') || state;
      if (target === state) state.tabIndex = -1;
      target.focus();
    }
  };
  setBusy(ethicsSection, true);
  try {
    const [article] = await fetchAPI('/api/knowledge?limit=1');
    if (requestToken !== ethicsRequest || !page.active) return;
    if (article?.document?.kind !== 'ethics' || typeof article.id !== 'string' || !UUID_PATTERN.test(article.id)) {
      return renderState('O Código de Ética está temporariamente indisponível.');
    }
    const restoreFocus = focused && document.activeElement === focused;
    const action = element('a', {
      className: 'btn btn-primary dashboard-ethics-action',
      href: `./knowledge.html?article=${encodeURIComponent(article.id)}`,
      text: 'Ler Código de Ética',
    });
    clear(ethicsSection).append(action);
    if (restoreFocus) action.focus();
  } catch {
    if (requestToken === ethicsRequest && page.active) renderState('Não foi possível carregar o Código de Ética. Verifique sua conexão.', loadEthics);
  } finally {
    if (requestToken === ethicsRequest && page.active) setBusy(ethicsSection, false);
  }
}

page.listen(window, 'pageshow', event => {
  if (!event.persisted) return;
  void Promise.all([loadReminders(), loadEthics()]);
});

void Promise.all([loadReminders(), loadEthics()]);
}
