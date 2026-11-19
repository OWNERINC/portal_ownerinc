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
  greeting.textContent = `${salutation}${name ? `, ${name}` : ''}.`;
}

function mountOpeningVideo() {
  const player = document.getElementById('dashboard-video-frame');
  const poster = document.getElementById('dashboard-video-poster');
  const button = document.getElementById('dashboard-video-load');
  const status = document.getElementById('dashboard-video-status');
  if (!player || !poster || !button || !status) return;
  let iframe, timer;
  let detachFrameListeners = () => {};

  function clearPlayer() {
    clearTimeout(timer);
    timer = null;
    detachFrameListeners();
    detachFrameListeners = () => {};
    iframe?.removeAttribute('src');
    iframe?.remove();
    iframe = null;
  }

  function reset(message = '', restoreFocus = false) {
    const focused = iframe && document.activeElement === iframe;
    clearPlayer();
    if (!page.active) return;
    poster.hidden = false;
    button.disabled = false;
    setBusy(player, false);
    status.textContent = message;
    status.hidden = !message;
    if (restoreFocus && focused) button.focus();
  }

  function load() {
    if (!page.active || iframe) return;
    const frame = element('iframe', {
      src: 'https://www.youtube-nocookie.com/embed/VAhBJOKc3-s?autoplay=0&rel=0&playsinline=1',
      title: 'Owntime Home Club Gramado — Andamento das Obras (Maio 2026)',
      allow: 'encrypted-media; picture-in-picture; fullscreen',
      allowfullscreen: true, tabindex: '0',
      referrerpolicy: 'strict-origin-when-cross-origin',
      sandbox: 'allow-scripts allow-same-origin allow-presentation',
    });
    const loaded = () => {
      if (!page.active || iframe !== frame) return;
      clearTimeout(timer);
      timer = null;
      setBusy(player, false);
      status.textContent = '';
      status.hidden = true;
    };
    const failed = () => {
      if (page.active && iframe === frame) reset('Não foi possível carregar o vídeo. Tente novamente ou abra no YouTube.', true);
    };
    frame.addEventListener('load', loaded);
    frame.addEventListener('error', failed);
    detachFrameListeners = () => {
      frame.removeEventListener('load', loaded);
      frame.removeEventListener('error', failed);
    };
    iframe = frame;
    poster.hidden = true;
    button.disabled = true;
    setBusy(player, true);
    status.textContent = 'Carregando vídeo do YouTube…';
    status.hidden = false;
    player.append(frame);
    timer = page.timeout(() => {
      if (iframe === frame) reset('O carregamento está demorando. Tente novamente ou abra no YouTube.', true);
    }, 15000);
    frame.focus();
  }

  page.listen(button, 'click', load);
  page.listen(window, 'pagehide', () => reset());
  page.cleanup(clearPlayer);
}
mountOpeningVideo();

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
  ['book-open', 'Conhecimento', './knowledge.html'],
  ['bell', 'Notificações', './reminders.html'],
  ['layout-template', 'Pages', './pages.html'],
  ['user', 'Meu Perfil', './profile.html'],
];
function appendLinks(container, entries) {
  if (!container) return;
  clear(container);
  entries.forEach(([iconName, label, href]) => container.append(element('a', { className: 'dashboard-area-card', href }, [
    icon(iconName),
    element('span', { className: 'dashboard-area-card-copy' }, [
      element('strong', { text: label }),
    ]),
  ])));
}
appendLinks(quickLinks, links);

const tools = [];
if (user.autocard_access === true) tools.push(['layout-template', 'AutoCard', './autocard.html']);
if (user.pos_cards_access === true) tools.push(['badge-check', 'Cards Pós', './cards-pos.html']);
if (user.role === 'admin') tools.push(['settings-2', 'Admin', './admin.html']);
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
