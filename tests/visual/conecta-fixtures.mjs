// Local visual fixtures only: never imported by public code or production services.
import { user, users, jobTitles, articles, benefits, autocards, posCards } from './conecta-content.mjs';
import { academyFixtures, lessonFixture } from './conecta-academy-fixtures.mjs';
export { user } from './conecta-content.mjs';

function civilDay(now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const value = type => parts.find(part => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
const addDays = (day, count) => new Date(Date.parse(`${day}T12:00:00Z`) + count * 86400000).toISOString().slice(0, 10);
const normalize = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
const includes = (value, query) => normalize(value).includes(normalize(query));

function page(items, params, envelope = false) {
  const number = (name, fallback) => /^\d+$/.test(params.get(name) || '') && Number.isSafeInteger(Number(params.get(name))) ? Number(params.get(name)) : fallback;
  const offset = number('offset', 0), limit = number('limit', items.length);
  const entries = items.slice(offset, offset + limit);
  return { data: envelope ? { entries } : entries, total: items.length };
}
const single = data => data === undefined ? undefined : { data, total: null };
const categories = items => [...new Set(items.map(item => item.category))];

function reminderFixtures(today) {
  return [
    ['Encontro de boas-vindas', 'Conheça as pessoas da equipe e leve suas dúvidas sobre os primeiros dias. Confirme horário e local com a liderança.', 1, 'all'],
    ['Atualização cadastral', 'Revise seus dados no perfil e confirme se os canais de contato estão atualizados. Não envie documentos pessoais em canais abertos.', 2, 'all'],
    ['Integração da equipe', 'Compartilhe um aprendizado da semana e converse sobre os próximos passos da área. Atividade ilustrativa, sem convocação real.', 3, 'all'],
    ['Retome sua trilha na Academy', 'Continue a formação Primeiros passos na Ownerinc e consulte os artigos de integração para organizar suas dúvidas.', 5, 'all'],
    ['Organização da nota fiscal', 'Exemplo de lembrete para prestadores: confira o procedimento oficial e o prazo combinado antes de emitir documentos.', 6, 'pj'],
    ['Conversa de desenvolvimento', 'Prepare exemplos de entregas e oportunidades de melhoria para a próxima conversa com a liderança.', 12, 'clt'],
  ].map(([title, description, offset, target_users], index) => {
    const date = addDays(today, offset);
    const id = `550e8400-e29b-41d4-a716-44665544000${index}`;
    return { id, title, description: `${description} Lembrete demonstrativo, sem envio real.`,
      next_occurrence: date, next_date: date, trigger_day: Number(date.slice(-2)), active: true,
      target_users, channel: 'email', content_url: `/reminders.html#reminder-${id}`, created_at: `${addDays(today, -10)}T12:00:00Z` };
  });
}

function deliveriesFixture(reminders, today) {
  return reminders.slice(0, 4).map((reminder, index) => ({
    id: `delivery-${index + 1}`, reminder_id: reminder.id, reminder_title: reminder.title, content_url: reminder.content_url,
    recipient_name: users[index].name, recipient_email: users[index].email, user_uid: users[index].uid,
    scheduled_date: addDays(today, -index), channel: 'email', status: ['sent', 'sent', 'failed', 'pending'][index],
    reason: 'Simulação local; nenhuma mensagem foi enviada.', attempt_count: index === 3 ? 0 : 1,
  }));
}

function selectResponse(url, now) {
  const path = url.pathname, params = url.searchParams, today = civilDay(now);
  const exact = (item, key) => !params.get(key) || String(item[key]) === params.get(key);
  const search = (item, fields, key = 'search') => !params.get(key) || fields.some(field => includes(item[field], params.get(key)));
  const dated = (day, from = 'from', to = 'to') => (!params.get(from) || day >= params.get(from)) && (!params.get(to) || day <= params.get(to));
  const active = item => exact(item, 'active') && (params.get('all') === 'true' || item.active !== false);
  if (path === '/api/users/me') return single(user);
  if (path === '/api/users') return page(users.filter(item => search(item, ['name', 'email'], 'q') && ['role', 'state', 'job_title_id'].every(key => exact(item, key))), params);
  if (path === '/api/job-titles' || path === '/api/academy/job-titles') {
    return page(jobTitles.filter(item => search(item, ['name'], 'q') && (params.has('active') ? exact(item, 'active') : params.get('all') === 'true' || item.active)), params);
  }
  if (path === '/api/registrations') return page([
    { id: 'registration-1', name: 'Ana Ribeiro', email: 'ana@example.test', status: 'pending', state: 'confirmed', state_label: 'E-mail confirmado · demonstração', created_at: `${addDays(today, -1)}T12:00:00Z` },
    { id: 'registration-2', name: 'Diego Souza', email: 'diego@example.test', status: 'pending', state: 'pending', state_label: 'Cadastro recebido · demonstração', created_at: `${addDays(today, -2)}T12:00:00Z` },
  ].filter(item => exact(item, 'status')), params);
  if (path === '/api/users/audit') return page(['user.create', 'job_title.update', 'registration.approve'].map((action, index) => ({
    id: `audit-${index + 1}`, action, actor_name: `${user.name} · exemplo`, target_type: index === 1 ? 'job_title' : 'user',
    target_id: index === 1 ? jobTitles[0].id : users[index + 1].uid, request_id: `preview-${index + 1}`, created_at: `${addDays(today, -index)}T12:00:00Z`,
  })).filter(item => exact(item, 'action') && dated(item.created_at.slice(0, 10))), params);

  if (path === '/api/knowledge/categories') return single(categories(articles));
  if (path === '/api/knowledge') return page(articles.filter(item => exact(item, 'category') && search(item, ['title', 'content'], 'q') && search(item, ['title', 'content'])), params);
  const article = path.match(/^\/api\/knowledge\/([^/]+)$/);
  if (article) return single(articles.find(item => item.id === article[1]));

  if (path === '/api/benefits/categories') return single(categories(benefits));
  if (path === '/api/benefits') return page(benefits.filter(item => active(item) && exact(item, 'category') && search(item, ['company', 'description'])), params);

  const reminders = reminderFixtures(today);
  if (path === '/api/reminders/cron-status') return single({
    heartbeat_at: now.toISOString(), execution_status: 'success', sent_count: 0, failed_count: 0,
    last_error: null, message: 'Heartbeat demonstrativo; nenhum cron foi executado.',
  });
  if (path === '/api/reminders/deliveries') return page(deliveriesFixture(reminders, today).filter(item =>
    ['status', 'channel', 'reminder_id', 'user_uid'].every(key => exact(item, key)) && dated(item.scheduled_date, 'scheduled_from', 'scheduled_to')), params);
  if (path === '/api/reminders/upcoming') {
    const days = /^\d+$/.test(params.get('days') || '') ? Math.min(366, Number(params.get('days'))) : 7;
    return page(reminders.filter(item => item.active && (item.target_users === 'all' || item.target_users === user.contract_type) && item.next_occurrence <= addDays(today, days)), params);
  }
  if (path === '/api/reminders') return page(reminders.filter(active), params);
  const reminder = path.match(/^\/api\/reminders\/([^/]+)$/);
  if (reminder) return single(reminders.find(item => item.id === reminder[1]));

  const views = academyFixtures();
  const courses = views.map(view => view.course).filter(item => (!params.get('group') || item.learning_group === params.get('group')) && active(item));
  if (path === '/api/academy/categories') return single(categories(courses));
  if (path === '/api/academy/continue') return page(courses.filter(item => item.resume_lesson_id), params);
  if (path === '/api/academy') return page(courses.filter(item => exact(item, 'category') && search(item, ['title', 'description'])), params);
  const lesson = path.match(/^\/api\/academy\/lessons\/([^/]+)$/);
  if (lesson) return single(lessonFixture(lesson[1], views));
  const course = path.match(/^\/api\/academy\/([^/]+)$/);
  if (course) return single(views.find(view => view.course.id === course[1]));

  for (const [tool, cards] of [['autocard', autocards], ['pos-cards', posCards]]) {
    if (path === `/api/${tool}/cards`) return page(cards.filter(item => exact(item, 'template') && search(item, ['name'])), params);
    const prefix = `/api/${tool}/cards/`;
    if (path.startsWith(prefix)) return single(cards.find(item => item.id === path.slice(prefix.length)));
  }

  // These read-only envelopes illustrate existing UI, not an active integration.
  if (path === '/api/solides/admin/status') return single({ enabled: false, available: false });
  if (path === '/api/solides/me/status') return single({ linked: true, demo: true });
  if (path === '/api/solides/me/summary') return single({
    entries: [{ startAt: `${today}T11:00:00Z`, endAt: null }], dataAsOf: now.toISOString(), demo: true,
  });
  if (path === '/api/solides/me/hours-balance') return single({ hoursBalanceInMinutes: 90, demo: true });
  if (path === '/api/solides/me/schedule') return single({ employee: { schedule: {
    name: 'Jornada demonstrativa · sem vínculo real', days: [2, 3, 4, 5, 6].map(day => ({ day, shifts: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }] })),
  } }, demo: true });
  if (path === '/api/solides/me/adjustments') return single({ entries: [{ id: 'adjustment-1', status: 'APROVADO', startAt: `${addDays(today, -2)}T11:00:00Z`, endAt: `${addDays(today, -2)}T12:00:00Z` }].filter(item => dated(item.startAt.slice(0, 10))), demo: true });
  if (path === '/api/solides/me/punches') return page([0, 1, 2, 3, 4].map(offset => {
    const day = addDays(today, -offset);
    return { id: `punch-${offset}`, date: `${day}T12:00:00Z`, dateIn: `${day}T11:00:00Z`, dateOut: offset ? `${day}T20:00:00Z` : null, status: 'Demonstração' };
  }).filter(item => dated(item.date.slice(0, 10))), params, true);
  return undefined;
}

export function fixtureResponse(url, now = new Date()) {
  // Consumers must not be able to edit shared records by reference.
  const response = selectResponse(url, now);
  return response === undefined ? undefined : structuredClone(response);
}

export function fixtureData(url) {
  return fixtureResponse(url)?.data;
}
