import { APIError, fetchAPI, fetchAPIPage, requireAuth, renderUserInTopbar } from './auth.js';
import { clear, element, showState } from './ui.js';

const user = await requireAuth();
if (!user) throw new Error('Authentication required');
renderUserInTopbar(user);

try {
  const status = await fetchAPI('/api/solides/me/status');
  if (!status.linked) window.location.replace('./dashboard.html');
} catch (error) {
  if (error instanceof APIError && error.status === 404) window.location.replace('./dashboard.html');
  else throw error;
}

const now = new Date();
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
const monthStart = `${today.slice(0, 8)}01`;
const fromInput = document.getElementById('history-from');
const toInput = document.getElementById('history-to');
fromInput.value = monthStart;
toInput.value = today;
fromInput.max = today;
toInput.max = today;

function formatDateTime(value) {
  return value ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : '—';
}

function formatMinutes(value) {
  if (!Number.isFinite(value)) return 'Não disponível';
  const sign = value < 0 ? '−' : value > 0 ? '+' : '';
  const absolute = Math.abs(value);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

async function loadSummary() {
  const todaySummary = document.getElementById('today-summary');
  try {
    const summary = await fetchAPI(`/api/solides/me/summary?date=${today}`);
    const latest = summary.entries.at(-1);
    todaySummary.textContent = latest
      ? `Entrada ${formatDateTime(latest.startAt)} · Saída ${formatDateTime(latest.endAt)}`
      : 'Nenhuma marcação retornada para hoje.';
    document.getElementById('data-freshness').textContent = `Atualizado em ${formatDateTime(summary.dataAsOf)}.`;
  } catch {
    todaySummary.textContent = 'Não foi possível consultar o resumo.';
  }
}

async function loadBalance() {
  const balance = document.getElementById('hours-balance');
  try {
    const hours = await fetchAPI(`/api/solides/me/hours-balance?from=${monthStart}&to=${today}`);
    balance.textContent = formatMinutes(hours.hoursBalanceInMinutes);
  } catch {
    balance.textContent = 'Não disponível';
  }
}

async function loadSchedule() {
  const scheduleSummary = document.getElementById('schedule-summary');
  const scheduleDays = document.getElementById('schedule-days');
  try {
    const schedule = await fetchAPI('/api/solides/me/schedule');
    scheduleSummary.textContent = schedule.employee.schedule?.name || 'Escala não informada.';
    clear(scheduleDays);
    const dayNames = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
    const days = schedule.employee.schedule?.days || [];
    if (!days.length) showState(scheduleDays, 'Nenhuma jornada semanal retornada.');
    else days.forEach((day) => scheduleDays.append(element('article', { className: 'card' }, [
      element('div', { className: 'card-title', text: dayNames[(Number(day.day) + 6) % 7] || `Dia ${day.day}` }),
      element('p', { className: 'card-copy', text: day.shifts.map((shift) => `${shift.start}–${shift.end}`).join(' · ') || 'Sem expediente' }),
    ])));
  } catch {
    scheduleSummary.textContent = 'Não disponível';
    showState(scheduleDays, 'Não foi possível consultar a escala.', loadSchedule);
  }
}

async function loadOverview() {
  await Promise.all([loadSummary(), loadBalance(), loadSchedule()]);
}

async function loadAdjustments() {
  const container = document.getElementById('adjustments-list');
  const year = today.slice(0, 4);
  try {
    const result = await fetchAPI(`/api/solides/me/adjustments?from=${year}-01-01&to=${year}-12-31`);
    if (!result.entries.length) return showState(container, 'Nenhuma ocorrência registrada neste ano.');
    clear(container);
    result.entries.forEach(adjustment => container.append(element('article', { className: 'card' }, [
      element('div', { className: 'card-heading' }, [
        element('div', { className: 'card-title', text: 'Ocorrência de jornada' }),
        element('span', { className: `badge ${adjustment.status === 'APROVADO' ? 'badge-green' : adjustment.status === 'REPROVADO' ? 'badge-red' : 'badge-gold'}`, text: adjustment.status || 'Não informado' }),
      ]),
      element('p', { className: 'card-copy', text: `${formatDateTime(adjustment.startAt)} até ${formatDateTime(adjustment.endAt)}` }),
    ])));
  } catch {
    showState(container, 'Não foi possível carregar férias e ajustes.', loadAdjustments);
  }
}

const historyMore = document.getElementById('history-more');
const historyPageSize = 50;
let historyEntries = [];
let historyOffset = 0;

function renderHistory(entries) {
  const container = document.getElementById('punch-history');
  if (!entries.length) return showState(container, 'Nenhuma marcação encontrada no período.');
  const table = element('table');
  table.append(element('caption', { text: 'Marcações retornadas pela Sólides' }));
  const head = element('thead');
  const headingRow = element('tr');
  for (const label of ['Data', 'Entrada', 'Saída', 'Status']) headingRow.append(element('th', { text: label, scope: 'col' }));
  head.append(headingRow);
  const body = element('tbody');
  entries.forEach((entry) => {
    const row = element('tr');
    for (const value of [formatDateTime(entry.date), formatDateTime(entry.dateIn), formatDateTime(entry.dateOut), entry.status || 'Não informado']) {
      row.append(element('td', { text: value }));
    }
    body.append(row);
  });
  table.append(head, body);
  clear(container).append(table);
}

async function loadHistory(reset = true) {
  const container = document.getElementById('punch-history');
  if (reset) {
    historyEntries = [];
    historyOffset = 0;
    historyMore.hidden = true;
    showState(container, 'Carregando histórico…');
  } else {
    historyMore.disabled = true;
    historyMore.textContent = 'Carregando…';
  }
  try {
    const { data, total } = await fetchAPIPage(`/api/solides/me/punches?from=${encodeURIComponent(fromInput.value)}&to=${encodeURIComponent(toInput.value)}&limit=${historyPageSize}&offset=${historyOffset}`);
    historyEntries.push(...data.entries);
    historyOffset += historyPageSize;
    renderHistory(historyEntries);
    historyMore.hidden = total === null ? data.entries.length < historyPageSize : historyEntries.length >= total;
  } catch {
    if (reset) showState(container, 'Não foi possível carregar o histórico.', () => loadHistory(true));
  } finally {
    historyMore.disabled = false;
    historyMore.textContent = 'Carregar mais';
  }
}

document.getElementById('history-filter').addEventListener('submit', (event) => {
  event.preventDefault();
  loadHistory(true);
});
historyMore.addEventListener('click', () => loadHistory(false));

await Promise.all([loadOverview(), loadAdjustments(), loadHistory()]);
