import { requireAuth, fetchAPI } from './auth.js';
import { blocksToText, renderBlocks } from './cms-block-renderer.js';
import { clear, element, safeHttpUrl, setBusy, showState } from './ui.js';

const user = await requireAuth();
if (!user) throw new Error('Authentication required');

const TIME_ZONE = 'America/Sao_Paulo';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const editorialImages = [
  ['https://images.unsplash.com/photo-1497366811353-6870744d04b2?auto=format&fit=crop&w=600&q=80', 'Sala de trabalho iluminada'],
  ['https://images.unsplash.com/photo-1516321318423-f06f85e504b3?auto=format&fit=crop&w=600&q=80', 'Notebook aberto sobre uma mesa'],
  ['https://images.unsplash.com/photo-1524758631624-e2822e304c36?auto=format&fit=crop&w=600&q=80', 'Pessoas trabalhando em uma mesa'],
];

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'recentemente' : new Intl.DateTimeFormat('pt-BR', {
    timeZone: TIME_ZONE, day: '2-digit', month: 'short',
  }).format(date).replace('.', '');
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

function excerpt(blocks, fallback) {
  return (blocksToText(blocks).replace(/\s+/g, ' ').trim() || fallback).slice(0, 180);
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `./assets/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

function storyCard({ title, category, description, blocks, href, newTab, image, alt, meta }) {
  const titleNode = href
    ? element('a', {
      className: 'dashboard-story-card-title', href,
      ...(newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
    }, [element('strong', { text: title })])
    : element('strong', { text: title });
  const body = element('div', { className: 'dashboard-story-card-body' }, [
    titleNode,
    element('small', { text: [category, meta].filter(Boolean).join(' · ') }),
  ]);
  if (blocks || description) {
    const copy = element('div', { className: 'dashboard-story-card-copy' });
    if (blocks) renderBlocks(copy, blocks, { fallbackText: description || '' });
    else copy.append(element('p', { text: description }));
    body.append(copy);
  }
  const children = image
    ? [element('img', { src: image, alt, width: 600, height: 360, loading: 'lazy' }), body]
    : [body];
  return element('article', { className: 'dashboard-story-card' }, children);
}

function renderHero(announcement) {
  if (!announcement) return;
  const title = document.getElementById('dashboard-hero-title');
  const eyebrow = document.getElementById('dashboard-hero-eyebrow');
  const description = document.getElementById('dashboard-hero-description');
  const meta = document.getElementById('dashboard-hero-meta');
  if (title) title.textContent = announcement.title;
  if (eyebrow) eyebrow.textContent = `Edição da semana · ${announcement.category || 'Ownerinc'}`;
  if (description) description.textContent = excerpt(announcement.content_blocks, 'Uma leitura curta para organizar o que importa e levar boas ideias para a rotina.');
  if (meta) meta.textContent = `Publicado ${formatDate(announcement.published_at)}`;
}

const announcementsPreview = document.getElementById('announcements-preview');
let announcementsRequest = 0;
async function loadAnnouncements() {
  if (!announcementsPreview) return;
  const requestToken = ++announcementsRequest;
  setBusy(announcementsPreview, true);
  try {
    const announcements = (await fetchAPI('/api/announcements?limit=3&offset=0')).slice(0, 3);
    if (requestToken !== announcementsRequest) return;
    if (!announcements.length) return showState(announcementsPreview, 'Nenhum anúncio publicado.');
    renderHero(announcements[0]);
    clear(announcementsPreview);
    announcements.forEach((announcement, index) => announcementsPreview.append(storyCard({
      title: announcement.title,
      category: announcement.category || 'Comunicado',
      blocks: announcement.content_blocks,
      href: './announcements.html',
      image: editorialImages[index % editorialImages.length][0],
      alt: editorialImages[index % editorialImages.length][1],
      meta: formatDate(announcement.published_at),
    })));
  } catch {
    if (requestToken === announcementsRequest) showState(announcementsPreview, 'Não foi possível carregar os anúncios.', loadAnnouncements);
  } finally {
    if (requestToken === announcementsRequest) setBusy(announcementsPreview, false);
  }
}

const remindersContainer = document.getElementById('reminders-list');
let remindersRequest = 0;
async function loadReminders() {
  if (!remindersContainer) return;
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
    upcoming.forEach(({ reminder, days }) => remindersContainer.append(storyCard({
      title: reminder.title,
      category: days === 0 ? 'Hoje' : `Em ${days} ${days === 1 ? 'dia' : 'dias'}`,
      description: reminder.description || '',
      blocks: reminder.content_blocks,
      href: reminderContentHref(reminder),
    })));
  } catch {
    if (requestToken === remindersRequest) showState(remindersContainer, 'Não foi possível carregar os lembretes. Verifique sua conexão.', loadReminders);
  } finally {
    if (requestToken === remindersRequest) setBusy(remindersContainer, false);
  }
}

const quickLinks = document.getElementById('quick-links');
const links = [
  ['book-open', 'Base de Conhecimento', 'Regras e boas práticas da empresa', './knowledge.html'],
  ['bell', 'Lembretes', 'Datas importantes e vencimentos', './reminders.html'],
  ['graduation-cap', 'Academy', 'Cursos e treinamentos', './academy.html'],
];
if (quickLinks) {
  links.forEach(([iconName, label, description, href]) => quickLinks.append(element('a', { className: 'dashboard-area-card', href }, [
    icon(iconName),
    element('span', { className: 'dashboard-area-card-copy' }, [
      element('strong', { text: label }),
      element('span', { text: description }),
    ]),
  ])));
}

const academySection = document.getElementById('academy-preview');
let academyRequest = 0;
async function loadAcademy() {
  if (!academySection) return;
  const requestToken = ++academyRequest;
  setBusy(academySection, true);
  try {
    const courses = (await fetchAPI('/api/academy?active=true&limit=3')).filter(course => course.active !== false).slice(0, 3);
    if (requestToken !== academyRequest) return;
    if (!courses.length) return showState(academySection, 'Nenhum curso disponível no momento.');
    clear(academySection);
    courses.forEach((course, index) => {
      const href = safeHttpUrl(course.url) || './academy.html';
      academySection.append(storyCard({
        title: course.title,
        category: course.category || 'Desenvolvimento',
        description: course.description || '',
        blocks: course.content_blocks,
        href,
        newTab: Boolean(safeHttpUrl(course.url)),
        image: editorialImages[index % editorialImages.length][0],
        alt: editorialImages[index % editorialImages.length][1],
      }));
    });
  } catch {
    if (requestToken === academyRequest) showState(academySection, 'Não foi possível carregar os cursos.', loadAcademy);
  } finally {
    if (requestToken === academyRequest) setBusy(academySection, false);
  }
}

await Promise.all([loadAnnouncements(), loadReminders(), loadAcademy()]);
