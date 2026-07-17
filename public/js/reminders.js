import { requireAuth, renderUserInTopbar, showToast, can, fetchAPI } from './auth.js';

const user = await requireAuth();
if (!user) throw new Error('not authenticated');
renderUserInTopbar(user);

const canManage = can(user, 'manageReminders');
if (user.role === 'admin') document.getElementById('admin-link').style.display = '';
if (canManage) {
  document.getElementById('btn-new-reminder').style.display = '';
  document.getElementById('th-actions').textContent = 'Ações';
}

let reminders = [];
let editingId = null;

async function loadReminders() {
  reminders = await fetchAPI('/api/reminders');
  renderTable();
}

function renderTable() {
  const tbody = document.getElementById('reminders-tbody');
  if (reminders.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Nenhum lembrete cadastrado.</td></tr>';
    return;
  }
  tbody.innerHTML = reminders.map(r => `
    <tr>
      <td><strong>${r.title}</strong><br><span style="font-size:12px;color:var(--text-secondary)">${r.description || ''}</span></td>
      <td>Dia ${r.trigger_day}</td>
      <td>${r.target_users === 'all' ? 'Todos' : r.target_users === 'pj' ? 'Apenas PJ' : r.target_users === 'clt' ? 'Apenas CLT' : 'Específicos'}</td>
      <td><span class="badge badge-gray">${r.channel}</span></td>
      <td><span class="badge ${r.active ? 'badge-green' : 'badge-gray'}">${r.active ? 'Ativo' : 'Inativo'}</span></td>
      <td>${canManage ? `
        <button class="btn btn-ghost btn-sm" onclick="window.__editReminder('${r.id}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="window.__deleteReminder('${r.id}')">Excluir</button>
      ` : ''}</td>
    </tr>
  `).join('');
}

document.getElementById('btn-new-reminder').addEventListener('click', () => {
  editingId = null;
  document.getElementById('modal-reminder-title').textContent = 'Novo Lembrete';
  document.getElementById('r-title').value = '';
  document.getElementById('r-desc').value = '';
  document.getElementById('r-day').value = '';
  document.getElementById('r-target').value = 'all';
  document.getElementById('r-channel').value = 'email';
  document.getElementById('r-active').checked = true;
  document.getElementById('modal-reminder').classList.remove('hidden');
});

window.__editReminder = id => {
  const r = reminders.find(x => x.id === id);
  editingId = id;
  document.getElementById('modal-reminder-title').textContent = 'Editar Lembrete';
  document.getElementById('r-title').value   = r.title;
  document.getElementById('r-desc').value    = r.description || '';
  document.getElementById('r-day').value     = r.trigger_day;
  document.getElementById('r-target').value  = r.target_users;
  document.getElementById('r-channel').value = r.channel;
  document.getElementById('r-active').checked = r.active;
  document.getElementById('modal-reminder').classList.remove('hidden');
};

window.__deleteReminder = async id => {
  if (!confirm('Excluir este lembrete?')) return;
  await fetchAPI(`/api/reminders/${id}`, { method: 'DELETE' });
  showToast('Lembrete excluído.');
  await loadReminders();
};

document.getElementById('modal-reminder-save').addEventListener('click', async () => {
  const title       = document.getElementById('r-title').value.trim();
  const description = document.getElementById('r-desc').value.trim();
  const trigger_day = parseInt(document.getElementById('r-day').value);
  const target_users= document.getElementById('r-target').value;
  const channel     = document.getElementById('r-channel').value;
  const active      = document.getElementById('r-active').checked;

  if (!title || !trigger_day || trigger_day < 1 || trigger_day > 31) {
    showToast('Título e dia válido são obrigatórios.');
    return;
  }

  try {
    const body = { title, description, trigger_day, target_users, channel, active };
    if (editingId) {
      await fetchAPI(`/api/reminders/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await fetchAPI('/api/reminders', { method: 'POST', body: JSON.stringify(body) });
    }
    document.getElementById('modal-reminder').classList.add('hidden');
    showToast(editingId ? 'Lembrete atualizado.' : 'Lembrete criado.');
    await loadReminders();
  } catch (err) {
    showToast('Erro: ' + err.message);
  }
});

['modal-reminder-close', 'modal-reminder-cancel'].forEach(id =>
  document.getElementById(id).addEventListener('click', () =>
    document.getElementById('modal-reminder').classList.add('hidden')
  )
);

loadReminders();
