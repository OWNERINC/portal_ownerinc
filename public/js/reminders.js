import { requireAuth, renderUserInTopbar, showToast, can, fetchAPI, fetchAPIPage } from './auth.js';
import { clear, closeDialog, element, openDialog } from './ui.js';

const user = await requireAuth();
if (!user) throw new Error('Authentication required');
renderUserInTopbar(user);
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

function tableState(message, retry) {
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
    if (reminder.description) title.append(element('span', { className: 'table-detail', text: reminder.description }));
    row.append(title);
    addCell(row, `Dia ${reminder.trigger_day}`);
    addCell(row, targetLabel(reminder.target_users));
    addCell(row, reminder.channel || '—', 'badge badge-gray');
    addCell(row, reminder.active ? 'Ativo' : 'Inativo', `badge ${reminder.active ? 'badge-green' : 'badge-gray'}`);
    const actions = element('td', { className: 'table-actions' });
    if (canManage) actions.append(
      element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Editar', on: { click: () => editReminder(reminder) } }),
      element('button', { className: 'btn btn-danger btn-sm', type: 'button', text: 'Excluir', on: { click: () => deleteReminder(reminder.id) } }),
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
    const [{ data: deliveries }, cron] = await Promise.all([
      fetchAPIPage('/api/reminders/deliveries?limit=10&offset=0'),
      fetchAPI('/api/reminders/cron-status'),
    ]);
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
  document.getElementById('r-target').value = typeof reminder.target_users === 'string' ? reminder.target_users : 'all';
  document.getElementById('r-channel').value = reminder.channel || 'email';
  document.getElementById('r-active').checked = !!reminder.active;
  openDialog(modal, document.getElementById('r-title'));
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
  const data = {
    title: document.getElementById('r-title').value.trim(),
    description: document.getElementById('r-desc').value.trim(),
    trigger_day: Number(document.getElementById('r-day').value),
    target_users: document.getElementById('r-target').value,
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
loadReminders(true);
loadDeliveryManager();
