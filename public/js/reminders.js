import { requireAuth, showToast, can, fetchAPI, fetchAPIPage } from './auth.js';
import { clear, closeDialog, element, openDialog } from './ui.js';
import { renderBlocks } from './cms-block-renderer.js';

const user = await requireAuth();
if (!user) throw new Error('Authentication required');
const canManage = can(user, 'manageReminders');
if (canManage) {
  document.getElementById('btn-new-reminder').style.display = '';
  document.getElementById('th-actions').textContent = 'Ações';
  document.getElementById('delivery-manager').hidden = false;
}

const tbody = document.getElementById('reminders-tbody');
const remindersPagination = document.getElementById('reminders-pagination');
const reminderDetail = document.getElementById('reminder-detail');
const reminderDetailTitle = document.getElementById('reminder-detail-title');
const reminderDetailMeta = document.getElementById('reminder-detail-meta');
const reminderDetailContent = document.getElementById('reminder-detail-content');
const modal = document.getElementById('modal-reminder');
const form = document.getElementById('reminder-form');
let reminders = [];
let editingId = null;
let page = 0;
let totalReminders = 0;
let remindersRequest = 0;
let deliveriesPage = 0;
let deliveriesTotal = 0;
const PAGE_SIZE = 50;
const DELIVERY_PAGE_SIZE = 20;
const TIME_ZONE = 'America/Sao_Paulo';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const REMINDER_HASH_PATTERN = /^#reminder-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
let deliveriesRequest = 0;
let reminderDetailRequest = 0;

function reminderContentHref(reminder) {
  const id = typeof reminder?.id === 'string' && UUID_PATTERN.test(reminder.id)
    ? reminder.id.toLowerCase() : null;
  if (!id) return null;
  const expected = `/reminders.html#reminder-${id}`;
  return reminder.content_url === expected ? reminder.content_url : expected;
}

function reminderIdFromHash(hash = window.location.hash) {
  const match = REMINDER_HASH_PATTERN.exec(hash);
  return match ? match[1].toLowerCase() : null;
}

function formatCivilDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return '—';
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(date.valueOf()) ? '—' : new Intl.DateTimeFormat('pt-BR', {
    timeZone: TIME_ZONE, day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(date);
}

function formatTimestamp(value) {
  if (value === null || value === undefined) return '—';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : new Intl.DateTimeFormat('pt-BR', {
    timeZone: TIME_ZONE, dateStyle: 'short', timeStyle: 'short',
  }).format(date);
}

function tableState(message, retry) {
  if (remindersPagination) clear(remindersPagination);
  const cell = element('td', { colspan: '6', className: 'empty-state', role: retry ? 'alert' : 'status', text: message });
  if (retry) {
    cell.append(document.createElement('br'), element('button', { className: 'btn btn-ghost', type: 'button', text: 'Tentar novamente', on: { click: retry } }));
  }
  clear(tbody).append(element('tr', {}, cell));
}

function targetLabel(target) {
  if (target === 'all') return 'Todos';
  if (target === 'pj') return 'Apenas PJ';
  if (target === 'clt') return 'Apenas CLT';
  return Array.isArray(target) ? `${target.length} usuários específicos` : 'Específicos';
}

function addCell(row, text, className) {
  const cell = element('td');
  cell.append(className ? element('span', { className, text }) : document.createTextNode(text));
  row.append(cell);
}

function renderTable() {
  if (!reminders.length) return tableState('Nenhum lembrete cadastrado.');
  clear(tbody);
  reminders.forEach(reminder => {
    const row = element('tr');
    const contentHref = reminderContentHref(reminder);
    const titleContent = element('strong', { text: reminder.title });
    const title = element('td', { className: 'break-text' }, [contentHref
      ? element('a', { href: contentHref, 'aria-label': `Abrir conteúdo: ${reminder.title}` }, titleContent)
      : titleContent]);
    if (contentHref) row.id = `reminder-${reminder.id.toLowerCase()}`;
    const content = element('div', { className: 'table-detail reminder-content' });
    renderBlocks(content, reminder.content_blocks, { fallbackText: reminder.description || '' });
    if (content.childNodes.length) title.append(content);
    row.append(title);
    addCell(row, `Dia ${reminder.trigger_day}`);
    addCell(row, targetLabel(reminder.target_users));
    addCell(row, reminder.channel || '—', 'badge badge-gray');
    addCell(row, reminder.active ? 'Ativo' : 'Inativo', `badge ${reminder.active ? 'badge-green' : 'badge-gray'}`);
    const actions = element('td', { className: 'table-actions' });
    if (canManage) actions.append(
      element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Editar', 'aria-label': `Editar lembrete: ${reminder.title}`, on: { click: () => editReminder(reminder) } }),
      element('button', { className: 'btn btn-danger btn-sm', type: 'button', text: 'Excluir', 'aria-label': `Excluir lembrete: ${reminder.title}`, on: { click: () => deleteReminder(reminder.id) } }),
    );
    row.append(actions);
    tbody.append(row);
  });
  if (!remindersPagination) return;
  const pagination = clear(remindersPagination);
  const pageCount = Math.max(1, Math.ceil(totalReminders / PAGE_SIZE));
  if (pageCount > 1) {
    pagination.append(
      element('button', { className: 'btn btn-ghost', type: 'button', text: 'Anterior', ...(page === 0 ? { disabled: '' } : {}), on: { click: () => { page -= 1; loadReminders(); } } }),
      element('span', { text: `Página ${page + 1} de ${pageCount}` }),
      element('button', { className: 'btn btn-ghost', type: 'button', text: 'Próxima', ...(page >= pageCount - 1 ? { disabled: '' } : {}), on: { click: () => { page += 1; loadReminders(); } } }),
    );
  }
}

function focusReminderDetail() {
  reminderDetail?.focus({ preventScroll: false });
}

function renderReminderDetailState(message, retry) {
  if (!reminderDetail) return;
  reminderDetail.hidden = false;
  reminderDetailTitle.textContent = 'Detalhe do lembrete';
  reminderDetailMeta.textContent = '';
  clear(reminderDetailContent).append(element('p', { text: message }));
  if (retry) reminderDetailContent.append(element('button', {
    className: 'btn btn-ghost', type: 'button', text: 'Tentar novamente', on: { click: retry },
  }));
  focusReminderDetail();
}

function renderReminderDetail(reminder) {
  if (!reminderDetail) return;
  reminderDetail.hidden = false;
  reminderDetailTitle.textContent = reminder.title || 'Lembrete';
  reminderDetailMeta.textContent = `Dia ${reminder.trigger_day || '—'} · ${targetLabel(reminder.target_users)}`;
  renderBlocks(reminderDetailContent, reminder.content_blocks, { fallbackText: reminder.description || '' });
  if (!reminderDetailContent.childNodes.length) {
    reminderDetailContent.append(element('p', { text: 'Este lembrete não possui conteúdo publicado.' }));
  }
  focusReminderDetail();
}

async function loadReminderDetail() {
  if (!reminderDetail) return;
  const id = reminderIdFromHash();
  const requestToken = ++reminderDetailRequest;
  if (!id) {
    reminderDetail.hidden = true;
    clear(reminderDetailContent);
    return;
  }
  reminderDetail.hidden = false;
  reminderDetailTitle.textContent = 'Carregando lembrete…';
  reminderDetailMeta.textContent = '';
  clear(reminderDetailContent).append(element('p', { className: 'loading-state', text: 'Carregando conteúdo…' }));
  try {
    const detail = await fetchAPI(`/api/reminders/${encodeURIComponent(id)}`);
    if (requestToken !== reminderDetailRequest || reminderIdFromHash() !== id) return;
    renderReminderDetail(detail);
  } catch (error) {
    if (requestToken !== reminderDetailRequest || reminderIdFromHash() !== id) return;
    renderReminderDetailState(
      error.status === 404
        ? 'Este lembrete não está disponível para sua conta.'
        : 'Não foi possível carregar este lembrete.',
      () => loadReminderDetail(),
    );
  }
}

async function loadReminders(reset = false) {
  if (reset) page = 0;
  const requestToken = ++remindersRequest;
  const requestPage = page;
  const requestPath = `${canManage ? '/api/reminders?all=true' : '/api/reminders'}${canManage ? '&' : '?'}limit=${PAGE_SIZE}&offset=${requestPage * PAGE_SIZE}`;
  tableState('Carregando lembretes…');
  try {
    const result = await fetchAPIPage(requestPath);
    if (requestToken !== remindersRequest) return;
    const loaded = result.data || [];
    const loadedTotal = result.total ?? loaded.length;
    if (!loaded.length && requestPage > 0) {
      const lastPage = Math.max(0, Math.ceil(loadedTotal / PAGE_SIZE) - 1);
      const fallbackPage = Math.min(requestPage - 1, lastPage);
      if (fallbackPage !== requestPage) {
        page = fallbackPage;
        return loadReminders();
      }
    }
    if (requestToken !== remindersRequest) return;
    page = requestPage;
    reminders = loaded;
    totalReminders = loadedTotal;
    renderTable();
  } catch {
    if (requestToken === remindersRequest) tableState('Não foi possível carregar os lembretes.', () => loadReminders());
  }
}

async function loadDeliveryManager() {
  if (!canManage) return;
  const requestToken = ++deliveriesRequest;
  const requestPage = deliveriesPage;
  const deliveriesBody = document.getElementById('deliveries-tbody');
  try {
    const params = new URLSearchParams({ limit: String(DELIVERY_PAGE_SIZE), offset: String(requestPage * DELIVERY_PAGE_SIZE) });
    const filters = {
      status: document.getElementById('delivery-status').value,
      channel: document.getElementById('delivery-channel').value,
      reminder_id: document.getElementById('delivery-reminder').value.trim(),
      user_uid: document.getElementById('delivery-user').value.trim(),
      scheduled_from: document.getElementById('delivery-from').value,
      scheduled_to: document.getElementById('delivery-to').value,
    };
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
    const [{ data: deliveries, total }, cron] = await Promise.all([
      fetchAPIPage(`/api/reminders/deliveries?${params}`),
      fetchAPI('/api/reminders/cron-status'),
    ]);
    if (requestToken !== deliveriesRequest) return;
    const loaded = deliveries || [];
    const loadedTotal = total ?? loaded.length;
    if (!loaded.length && requestPage > 0) {
      const lastPage = Math.max(0, Math.ceil(loadedTotal / DELIVERY_PAGE_SIZE) - 1);
      const fallbackPage = Math.min(requestPage - 1, lastPage);
      if (fallbackPage !== requestPage) {
        deliveriesPage = fallbackPage;
        return loadDeliveryManager();
      }
    }
    if (requestToken !== deliveriesRequest) return;
    deliveriesPage = requestPage;
    deliveriesTotal = loadedTotal;
    clear(deliveriesBody);
    if (!loaded.length) {
      deliveriesBody.append(element('tr', {}, element('td', { colspan: '7', className: 'empty-state', text: 'Nenhuma entrega registrada.' })));
    } else {
      loaded.forEach(delivery => {
        const contentHref = reminderContentHref({ id: delivery.reminder_id, content_url: delivery.content_url });
        const reminderLabel = delivery.reminder_title || delivery.reminder_id || 'Lembrete removido';
        const recipient = [delivery.recipient_name, delivery.recipient_email].filter(Boolean).join(' · ')
          || delivery.user_uid || 'Usuário removido';
        deliveriesBody.append(element('tr', {}, [
          element('td', { text: formatCivilDate(delivery.scheduled_date) }),
          element('td', { className: 'break-text' }, contentHref
            ? element('a', { href: contentHref, text: reminderLabel })
            : document.createTextNode(reminderLabel)),
          element('td', { className: 'break-text', text: recipient }),
          element('td', { text: delivery.channel || '—' }),
          element('td', {}, element('span', { className: `badge ${delivery.status === 'sent' ? 'badge-green' : delivery.status === 'failed' ? 'badge-red' : 'badge-gray'}`, text: delivery.status || '—' })),
          element('td', { className: 'break-text', text: delivery.reason || delivery.last_error || '—' }),
          element('td', { text: String(delivery.attempt_count || 0) }),
        ]));
      });
    }
    const deliveryPaginationElement = document.getElementById('deliveries-pagination');
    if (deliveryPaginationElement) clear(deliveryPaginationElement);
    const deliveryPagination = deliveryPaginationElement;
    const pageCount = Math.max(1, Math.ceil(deliveriesTotal / DELIVERY_PAGE_SIZE));
    if (deliveryPagination && pageCount > 1) {
      deliveryPagination.append(
        element('button', { className: 'btn btn-ghost', type: 'button', text: 'Anterior', ...(deliveriesPage === 0 ? { disabled: '' } : {}), on: { click: () => { deliveriesPage -= 1; loadDeliveryManager(); } } }),
        element('span', { text: `Página ${deliveriesPage + 1} de ${pageCount}` }),
        element('button', { className: 'btn btn-ghost', type: 'button', text: 'Próxima', ...(deliveriesPage >= pageCount - 1 ? { disabled: '' } : {}), on: { click: () => { deliveriesPage += 1; loadDeliveryManager(); } } }),
      );
    }
    const health = document.getElementById('cron-health');
    if (!health) return;
    if (!cron) {
      health.textContent = 'Cron sem heartbeat';
      health.className = 'badge badge-gray';
    } else {
      const heartbeat = new Date(cron.heartbeat_at);
      const stale = Number.isNaN(heartbeat.valueOf()) || Date.now() - heartbeat.valueOf() > 26 * 60 * 60 * 1000;
      const executionFailed = cron.execution_status === 'failed' || (!cron.execution_status && !!cron.last_error);
      const deliveryFailed = Number(cron.failed_count) > 0;
      const unhealthy = executionFailed || stale;
      const timestamp = formatTimestamp(cron.heartbeat_at);
      health.textContent = unhealthy
        ? (stale ? 'Cron atrasado' : 'Cron com falha')
        : deliveryFailed
          ? `Cron ativo · ${timestamp} · ${cron.failed_count} falha(s) de entrega`
          : `Cron ativo · ${timestamp}`;
      health.className = `badge ${unhealthy ? 'badge-gray' : deliveryFailed ? 'badge-red' : 'badge-green'}`;
      health.title = cron.execution_error || cron.last_error
        || `Execução: ${cron.execution_status || 'concluída'} · Entrega: ${cron.delivery_status || 'sem dados'} · Último sucesso: ${formatTimestamp(cron.last_success_at)}`;
    }
  } catch {
    if (requestToken !== deliveriesRequest) return;
    const state = element('td', { colspan: '7', className: 'empty-state', role: 'alert', text: 'Não foi possível carregar o histórico. ' });
    state.append(element('button', { className: 'btn btn-ghost', type: 'button', text: 'Tentar novamente', on: { click: loadDeliveryManager } }));
    clear(deliveriesBody).append(element('tr', {}, state));
    const health = document.getElementById('cron-health');
    if (health) health.textContent = 'Cron indisponível';
  }
}

function newReminder() {
  editingId = null;
  form.reset();
  document.getElementById('r-target').value = 'all';
  document.getElementById('r-uids').value = '';
  syncTargetFields();
  document.getElementById('r-channel').value = 'email';
  document.getElementById('r-active').checked = true;
  document.getElementById('modal-reminder-title').textContent = 'Novo Lembrete';
  openDialog(modal, document.getElementById('r-title'));
}

function editReminder(reminder) {
  editingId = reminder.id;
  document.getElementById('modal-reminder-title').textContent = 'Editar Lembrete';
  document.getElementById('r-title').value = reminder.title || '';
  document.getElementById('r-desc').value = reminder.description || '';
  document.getElementById('r-day').value = reminder.trigger_day;
  const target = typeof reminder.target_users === 'string' ? reminder.target_users : 'uids';
  document.getElementById('r-target').value = target;
  document.getElementById('r-uids').value = Array.isArray(reminder.target_users) ? reminder.target_users.join('\n') : '';
  syncTargetFields();
  document.getElementById('r-channel').value = 'email';
  document.getElementById('r-active').checked = !!reminder.active;
  openDialog(modal, document.getElementById('r-title'));
}

function syncTargetFields() {
  const isIndividual = document.getElementById('r-target').value === 'uids';
  document.getElementById('individual-target-group').hidden = !isIndividual;
  document.getElementById('r-uids').required = isIndividual;
}

function readTargetUsers() {
  const target = document.getElementById('r-target').value;
  if (target !== 'uids') return target;
  const values = document.getElementById('r-uids').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  if (!values.length || values.length > 500 || new Set(values).size !== values.length || values.some(value => !UID_PATTERN.test(value))) {
    throw new Error('Informe UIDs válidos, únicos e um por linha.');
  }
  return values;
}

async function deleteReminder(id) {
  if (!confirm('Excluir este lembrete?')) return;
  try {
    await fetchAPI(`/api/reminders/${encodeURIComponent(id)}`, { method: 'DELETE' });
    showToast('Lembrete excluído.');
    await loadReminders(true);
  } catch (error) {
    showToast(`Não foi possível excluir: ${error.message}`);
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  let targetUsers;
  try { targetUsers = readTargetUsers(); } catch (error) { showToast(error.message); return; }
  const data = {
    title: document.getElementById('r-title').value.trim(),
    description: document.getElementById('r-desc').value.trim(),
    trigger_day: Number(document.getElementById('r-day').value),
    target_users: targetUsers,
    channel: document.getElementById('r-channel').value,
    active: document.getElementById('r-active').checked,
  };
  const save = document.getElementById('modal-reminder-save');
  save.disabled = true;
  save.textContent = 'Salvando…';
  try {
    await fetchAPI(editingId ? `/api/reminders/${encodeURIComponent(editingId)}` : '/api/reminders', {
      method: editingId ? 'PUT' : 'POST', body: JSON.stringify(data),
    });
    closeDialog(modal, true);
    showToast(editingId ? 'Lembrete atualizado.' : 'Lembrete criado.');
    await loadReminders(true);
  } catch (error) {
    showToast(`Não foi possível salvar: ${error.message}`);
  } finally {
    save.disabled = false;
    save.textContent = 'Salvar';
  }
});

document.getElementById('btn-new-reminder').addEventListener('click', newReminder);
document.getElementById('modal-reminder-close').addEventListener('click', () => closeDialog(modal));
document.getElementById('modal-reminder-cancel').addEventListener('click', () => closeDialog(modal));
document.getElementById('r-target').addEventListener('change', syncTargetFields);
document.getElementById('delivery-filters').addEventListener('submit', event => { event.preventDefault(); deliveriesPage = 0; loadDeliveryManager(); });
document.getElementById('delivery-clear').addEventListener('click', () => {
  document.getElementById('delivery-filters').reset();
  deliveriesPage = 0;
  loadDeliveryManager();
});
syncTargetFields();
window.addEventListener('hashchange', loadReminderDetail);
loadReminders(true);
loadDeliveryManager();
loadReminderDetail();
