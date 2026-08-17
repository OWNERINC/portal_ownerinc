import { requireAuth, showToast, can, fetchAPI, fetchAPIPage } from './auth.js';
import { clear, closeDialog, element, openDialog } from './ui.js';
import { blocksToText } from './cms-block-renderer.js';

const user = await requireAuth();
if (!user) throw new Error('Authentication required');
const canManage = can(user, 'manageReminders');
if (canManage) {
  document.getElementById('btn-new-reminder').style.display = '';
  document.getElementById('th-actions').textContent = 'Ações';
  document.getElementById('delivery-manager').hidden = false;
}

const tbody = document.getElementById('reminders-tbody');
const modal = document.getElementById('modal-reminder');
const form = document.getElementById('reminder-form');
let reminders = [];
let editingId = null;
let page = 0;
let totalReminders = 0;
let deliveriesPage = 0;
let deliveriesTotal = 0;
const DELIVERY_PAGE_SIZE = 20;

function tableState(message, retry) {
  clear(document.getElementById('reminders-pagination'));
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
    const title = element('td', { className: 'break-text' }, [element('strong', { text: reminder.title })]);
    const description = reminder.description || blocksToText(reminder.content_blocks);
    if (description) title.append(element('span', { className: 'table-detail', text: description }));
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
  const pagination = clear(document.getElementById('reminders-pagination'));
  const pageCount = Math.max(1, Math.ceil(totalReminders / 50));
  if (pageCount > 1) {
    pagination.append(
      element('button', { className: 'btn btn-ghost', type: 'button', text: 'Anterior', ...(page === 0 ? { disabled: '' } : {}), on: { click: () => { page -= 1; loadReminders(); } } }),
      element('span', { text: `Página ${page + 1} de ${pageCount}` }),
      element('button', { className: 'btn btn-ghost', type: 'button', text: 'Próxima', ...(page >= pageCount - 1 ? { disabled: '' } : {}), on: { click: () => { page += 1; loadReminders(); } } }),
    );
  }
}

async function loadReminders(reset = false) {
  if (reset) page = 0;
  tableState('Carregando lembretes…');
  try {
    const separator = canManage ? '&' : '?';
    const result = await fetchAPIPage(`${canManage ? '/api/reminders?all=true' : '/api/reminders'}${separator}limit=50&offset=${page * 50}`);
    reminders = result.data;
    totalReminders = result.total || reminders.length;
    renderTable();
  } catch {
    tableState('Não foi possível carregar os lembretes.', loadReminders);
  }
}

async function loadDeliveryManager() {
  if (!canManage) return;
  const deliveriesBody = document.getElementById('deliveries-tbody');
  try {
    const params = new URLSearchParams({ limit: String(DELIVERY_PAGE_SIZE), offset: String(deliveriesPage * DELIVERY_PAGE_SIZE) });
    const filters = {
      status: document.getElementById('delivery-status').value,
      channel: document.getElementById('delivery-channel').value,
      user_uid: document.getElementById('delivery-user').value.trim(),
      scheduled_from: document.getElementById('delivery-from').value,
      scheduled_to: document.getElementById('delivery-to').value,
    };
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
    const [{ data: deliveries, total }, cron] = await Promise.all([
      fetchAPIPage(`/api/reminders/deliveries?${params}`),
      fetchAPI('/api/reminders/cron-status'),
    ]);
    deliveriesTotal = total ?? deliveries.length;
    clear(deliveriesBody);
    if (!deliveries.length) {
      deliveriesBody.append(element('tr', {}, element('td', { colspan: '5', className: 'empty-state', text: 'Nenhuma entrega registrada.' })));
    } else {
      deliveries.forEach(delivery => {
        const date = delivery.scheduled_date ? new Date(`${delivery.scheduled_date}T00:00:00`) : null;
        deliveriesBody.append(element('tr', {}, [
          element('td', { text: date && !Number.isNaN(date.valueOf()) ? new Intl.DateTimeFormat('pt-BR').format(date) : '—' }),
          element('td', { className: 'break-text', text: delivery.user_uid || '—' }),
          element('td', { text: delivery.channel || '—' }),
          element('td', {}, element('span', { className: `badge ${delivery.status === 'sent' ? 'badge-green' : 'badge-gray'}`, text: delivery.status || '—' })),
          element('td', { text: String(delivery.attempt_count || 0) }),
        ]));
      });
    }
    const deliveryPagination = clear(document.getElementById('deliveries-pagination'));
    const pageCount = Math.max(1, Math.ceil(deliveriesTotal / DELIVERY_PAGE_SIZE));
    if (pageCount > 1) {
      deliveryPagination.append(
        element('button', { className: 'btn btn-ghost', type: 'button', text: 'Anterior', ...(deliveriesPage === 0 ? { disabled: '' } : {}), on: { click: () => { deliveriesPage -= 1; loadDeliveryManager(); } } }),
        element('span', { text: `Página ${deliveriesPage + 1} de ${pageCount}` }),
        element('button', { className: 'btn btn-ghost', type: 'button', text: 'Próxima', ...(deliveriesPage >= pageCount - 1 ? { disabled: '' } : {}), on: { click: () => { deliveriesPage += 1; loadDeliveryManager(); } } }),
      );
    }
    const health = document.getElementById('cron-health');
    if (!cron) {
      health.textContent = 'Cron sem heartbeat';
      health.className = 'badge badge-gray';
    } else {
      const heartbeat = new Date(cron.heartbeat_at);
      const stale = Number.isNaN(heartbeat.valueOf()) || Date.now() - heartbeat.valueOf() > 26 * 60 * 60 * 1000;
      const unhealthy = !!cron.last_error || stale;
      health.textContent = unhealthy ? (stale ? 'Cron atrasado' : 'Cron com falha') : `Cron ativo · ${new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(heartbeat)}`;
      health.className = `badge ${unhealthy ? 'badge-gray' : 'badge-green'}`;
      health.title = cron.last_error || `Último sucesso: ${cron.last_success_at || 'não registrado'}`;
    }
  } catch {
    const state = element('td', { colspan: '5', className: 'empty-state', role: 'alert', text: 'Não foi possível carregar o histórico. ' });
    state.append(element('button', { className: 'btn btn-ghost', type: 'button', text: 'Tentar novamente', on: { click: loadDeliveryManager } }));
    clear(deliveriesBody).append(element('tr', {}, state));
    document.getElementById('cron-health').textContent = 'Cron indisponível';
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
  document.getElementById('r-channel').value = reminder.channel || 'email';
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
  const values = document.getElementById('r-uids').value.split(/\s+/).map(value => value.trim()).filter(Boolean);
  if (!values.length || values.length > 500 || new Set(values).size !== values.length || values.some(value => value.length > 128)) {
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
loadReminders(true);
loadDeliveryManager();
