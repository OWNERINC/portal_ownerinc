import { requireAuth, renderUserInTopbar, showToast, can, fetchAPI } from './auth.js';
import { auth } from './firebase-config.js';
import { createUserWithEmailAndPassword }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';

const me = await requireAuth(true);
if (!me) throw new Error('not admin');
renderUserInTopbar(me);

// ── Tabs ──────────────────────────────────────────────────────────────────────

const TABS = [
  { id: 'users',     label: 'Usuários',   perm: 'manageUsers'   },
  { id: 'academy',   label: 'Academy',    perm: 'manageAcademy' },
  { id: 'benefits',  label: 'Benefícios', perm: 'manageBenefits' },
  { id: 'ombudsman', label: 'Ouvidoria',  perm: 'viewOmbudsman' },
];

let activeTab = null;

function buildTabs() {
  const container = document.getElementById('admin-tabs');
  const visible = TABS.filter(t => can(me, t.perm));
  if (visible.length === 0) {
    container.innerHTML = '<p style="color:var(--text-secondary);font-size:13px">Nenhuma permissão de admin configurada. Peça ao Super Admin para atribuir permissões à sua conta.</p>';
    return;
  }
  container.innerHTML = visible.map(t =>
    `<button class="admin-tab" data-tab="${t.id}">${t.label}</button>`
  ).join('');
  container.querySelectorAll('.admin-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  switchTab(visible[0].id);
}

function switchTab(tabId) {
  activeTab = tabId;
  document.querySelectorAll('.admin-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === tabId)
  );
  document.querySelectorAll('.admin-section').forEach(s =>
    s.style.display = s.id === `section-${tabId}` ? '' : 'none'
  );
  if (tabId === 'users')     loadUsers();
  if (tabId === 'academy')   loadCourses();
  if (tabId === 'benefits')  loadBenefits();
  if (tabId === 'ombudsman') loadOmbudsman();
}

// ── Users ─────────────────────────────────────────────────────────────────────

let users = [];
let editingUserId = null;

async function loadUsers() {
  users = await fetchAPI('/api/users');
  renderUsersTable();
}

function contractBadge(u) {
  const type = u.contract_type || (u.is_pj ? 'pj' : 'clt');
  return type === 'pj'
    ? '<span class="badge badge-gold">PJ</span>'
    : '<span class="badge badge-gray">CLT</span>';
}

function renderUsersTable() {
  const tbody = document.getElementById('users-tbody');
  if (users.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Nenhum usuário.</td></tr>';
    return;
  }
  tbody.innerHTML = users.map(u => `
    <tr>
      <td>${u.name || '—'}</td>
      <td>${u.email}</td>
      <td><span class="badge ${u.role === 'admin' ? 'badge-gold' : 'badge-gray'}">${u.role}</span></td>
      <td>${contractBadge(u)}</td>
      <td>${(u.contract_type === 'pj' || u.is_pj) ? (u.pj_due_day || '—') : '—'}</td>
      <td style="display:flex; gap:6px">
        <button class="btn btn-ghost btn-sm" onclick="window.__editUser('${u.uid}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="window.__deleteUser('${u.uid}')">Remover</button>
      </td>
    </tr>
  `).join('');
}

document.getElementById('u-contract').addEventListener('change', e => {
  document.getElementById('pj-day-group').style.display = e.target.value === 'pj' ? '' : 'none';
});

document.getElementById('u-role').addEventListener('change', e => {
  const isAdmin = e.target.value === 'admin';
  document.getElementById('permissions-group').style.display =
    (isAdmin && can(me, 'superAdmin')) ? '' : 'none';
});

document.getElementById('p-super').addEventListener('change', e => {
  const checked = e.target.checked;
  ['p-users','p-reminders','p-academy','p-benefits','p-ombudsman'].forEach(id => {
    const el = document.getElementById(id);
    el.checked = checked;
    el.disabled = checked;
  });
});

document.getElementById('btn-new-user').addEventListener('click', () => {
  editingUserId = null;
  document.getElementById('modal-user-title').textContent = 'Novo Usuário';
  ['u-name','u-email','u-password','u-phone','u-pjday'].forEach(id =>
    document.getElementById(id).value = ''
  );
  document.getElementById('u-role').value = 'viewer';
  document.getElementById('u-contract').value = 'clt';
  document.getElementById('pj-day-group').style.display = 'none';
  document.getElementById('password-group').style.display = '';
  document.getElementById('permissions-group').style.display = 'none';
  resetPermissionCheckboxes();
  document.getElementById('modal-user').classList.remove('hidden');
});

window.__editUser = uid => {
  const u = users.find(x => x.uid === uid);
  editingUserId = uid;
  document.getElementById('modal-user-title').textContent = 'Editar Usuário';
  document.getElementById('u-name').value  = u.name || '';
  document.getElementById('u-email').value = u.email;
  document.getElementById('u-role').value  = u.role;

  const contract = u.contract_type || (u.is_pj ? 'pj' : 'clt');
  document.getElementById('u-contract').value = contract;
  document.getElementById('pj-day-group').style.display = contract === 'pj' ? '' : 'none';
  document.getElementById('u-pjday').value = u.pj_due_day || '';
  document.getElementById('u-phone').value = u.phone || '';
  document.getElementById('password-group').style.display = 'none';

  const showPerms = u.role === 'admin' && can(me, 'superAdmin');
  document.getElementById('permissions-group').style.display = showPerms ? '' : 'none';
  if (showPerms) {
    const p = u.permissions || {};
    document.getElementById('p-super').checked       = !!p.superAdmin;
    document.getElementById('p-users').checked       = !!p.manageUsers;
    document.getElementById('p-reminders').checked   = !!p.manageReminders;
    document.getElementById('p-academy').checked     = !!p.manageAcademy;
    document.getElementById('p-benefits').checked    = !!p.manageBenefits;
    document.getElementById('p-ombudsman').checked   = !!p.viewOmbudsman;
    if (p.superAdmin) {
      ['p-users','p-reminders','p-academy','p-benefits','p-ombudsman'].forEach(id =>
        document.getElementById(id).disabled = true
      );
    }
  }
  document.getElementById('modal-user').classList.remove('hidden');
};

function resetPermissionCheckboxes() {
  ['p-super','p-users','p-reminders','p-academy','p-benefits','p-ombudsman'].forEach(id => {
    const el = document.getElementById(id);
    el.checked = false;
    el.disabled = false;
  });
}

window.__deleteUser = async uid => {
  if (!confirm('Remover este usuário? O acesso será perdido.')) return;
  try {
    await fetchAPI(`/api/users/${uid}`, { method: 'DELETE' });
    showToast('Usuário removido com sucesso.');
    await loadUsers();
  } catch (err) {
    showToast('Erro ao remover: ' + err.message);
  }
};

document.getElementById('modal-user-save').addEventListener('click', async () => {
  const name     = document.getElementById('u-name').value.trim();
  const email    = document.getElementById('u-email').value.trim();
  const password = document.getElementById('u-password').value;
  const role     = document.getElementById('u-role').value;
  const contract = document.getElementById('u-contract').value;
  const is_pj    = contract === 'pj';
  const pj_due_day = is_pj ? parseInt(document.getElementById('u-pjday').value) || null : null;
  const phone    = document.getElementById('u-phone').value.trim();

  if (!name || !email) { showToast('Nome e e-mail são obrigatórios.'); return; }

  const permissions = {};
  if (role === 'admin' && can(me, 'superAdmin')) {
    permissions.superAdmin      = document.getElementById('p-super').checked;
    permissions.manageUsers     = document.getElementById('p-users').checked || document.getElementById('p-super').checked;
    permissions.manageReminders = document.getElementById('p-reminders').checked || document.getElementById('p-super').checked;
    permissions.manageAcademy   = document.getElementById('p-academy').checked || document.getElementById('p-super').checked;
    permissions.manageBenefits  = document.getElementById('p-benefits').checked || document.getElementById('p-super').checked;
    permissions.viewOmbudsman   = document.getElementById('p-ombudsman').checked || document.getElementById('p-super').checked;
  }

  try {
    if (editingUserId) {
      await fetchAPI(`/api/users/${editingUserId}`, {
        method: 'PUT',
        body: JSON.stringify({ name, role, contract_type: contract, is_pj, pj_due_day, phone, permissions }),
      });
      showToast('Usuário atualizado.');
    } else {
      if (!password || password.length < 6) { showToast('Senha mínima de 6 caracteres.'); return; }
      // Cria no Firebase Auth, depois salva no PostgreSQL via API
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      await fetchAPI('/api/users', {
        method: 'POST',
        body: JSON.stringify({
          uid: cred.user.uid, name, email, role,
          contract_type: contract, is_pj, pj_due_day, phone,
          permissions: role === 'admin' ? permissions : {},
        }),
      });
      showToast('Usuário criado com sucesso.');
    }
    document.getElementById('modal-user').classList.add('hidden');
    await loadUsers();
  } catch (err) {
    const msgs = {
      'auth/email-already-in-use': 'Este e-mail já está cadastrado.',
      'auth/invalid-email': 'E-mail inválido.',
      'auth/weak-password': 'Senha muito fraca.',
    };
    showToast(msgs[err.code] || 'Erro ao salvar: ' + err.message);
  }
});

['modal-user-close','modal-user-cancel'].forEach(id =>
  document.getElementById(id).addEventListener('click', () =>
    document.getElementById('modal-user').classList.add('hidden')
  )
);

// ── Academy ───────────────────────────────────────────────────────────────────

let courses = [];
let editingCourseId = null;

async function loadCourses() {
  courses = await fetchAPI('/api/academy');
  renderCoursesTable();
}

function renderCoursesTable() {
  const tbody = document.getElementById('academy-tbody');
  if (courses.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Nenhum curso cadastrado.</td></tr>';
    return;
  }
  tbody.innerHTML = courses.map(c => `
    <tr>
      <td><strong>${c.title}</strong><br><span style="font-size:12px;color:var(--text-secondary)">${c.description || ''}</span></td>
      <td><span class="badge badge-gray">${c.category || '—'}</span></td>
      <td><span class="badge ${c.active ? 'badge-green' : 'badge-gray'}">${c.active ? 'Ativo' : 'Inativo'}</span></td>
      <td style="display:flex; gap:6px">
        <button class="btn btn-ghost btn-sm" onclick="window.__editCourse('${c.id}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="window.__deleteCourse('${c.id}')">Excluir</button>
      </td>
    </tr>
  `).join('');
}

document.getElementById('btn-new-course').addEventListener('click', () => {
  editingCourseId = null;
  document.getElementById('modal-course-title').textContent = 'Novo Curso';
  ['c-title','c-category','c-desc','c-url'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('c-order').value = courses.length + 1;
  document.getElementById('c-active').checked = true;
  document.getElementById('modal-course').classList.remove('hidden');
});

window.__editCourse = id => {
  const c = courses.find(x => x.id === id);
  editingCourseId = id;
  document.getElementById('modal-course-title').textContent = 'Editar Curso';
  document.getElementById('c-title').value    = c.title || '';
  document.getElementById('c-category').value = c.category || '';
  document.getElementById('c-desc').value     = c.description || '';
  document.getElementById('c-url').value      = c.url || '';
  document.getElementById('c-order').value    = c.order || 1;
  document.getElementById('c-active').checked = !!c.active;
  document.getElementById('modal-course').classList.remove('hidden');
};

window.__deleteCourse = async id => {
  if (!confirm('Excluir este curso?')) return;
  await fetchAPI(`/api/academy/${id}`, { method: 'DELETE' });
  showToast('Curso excluído.');
  await loadCourses();
};

document.getElementById('modal-course-save').addEventListener('click', async () => {
  const title       = document.getElementById('c-title').value.trim();
  const category    = document.getElementById('c-category').value.trim();
  const description = document.getElementById('c-desc').value.trim();
  const url         = document.getElementById('c-url').value.trim();
  const order       = parseInt(document.getElementById('c-order').value) || 1;
  const active      = document.getElementById('c-active').checked;

  if (!title || !url) { showToast('Título e URL são obrigatórios.'); return; }

  const data = { title, category, description, url, order, active };
  try {
    if (editingCourseId) {
      await fetchAPI(`/api/academy/${editingCourseId}`, { method: 'PUT', body: JSON.stringify(data) });
      showToast('Curso atualizado.');
    } else {
      await fetchAPI('/api/academy', { method: 'POST', body: JSON.stringify(data) });
      showToast('Curso criado.');
    }
    document.getElementById('modal-course').classList.add('hidden');
    await loadCourses();
  } catch (err) {
    showToast('Erro: ' + err.message);
  }
});

['modal-course-close','modal-course-cancel'].forEach(id =>
  document.getElementById(id).addEventListener('click', () =>
    document.getElementById('modal-course').classList.add('hidden')
  )
);

// ── Benefits ──────────────────────────────────────────────────────────────────

let benefits = [];
let editingBenefitId = null;

async function loadBenefits() {
  benefits = await fetchAPI('/api/benefits');
  renderBenefitsTable();
}

function renderBenefitsTable() {
  const tbody = document.getElementById('benefits-tbody');
  if (benefits.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Nenhum benefício cadastrado.</td></tr>';
    return;
  }
  tbody.innerHTML = benefits.map(b => `
    <tr>
      <td><strong>${b.company}</strong></td>
      <td><span class="badge badge-gray">${b.category || '—'}</span></td>
      <td>${b.description || '—'}</td>
      <td><span class="badge ${b.active ? 'badge-green' : 'badge-gray'}">${b.active ? 'Ativo' : 'Inativo'}</span></td>
      <td style="display:flex; gap:6px">
        <button class="btn btn-ghost btn-sm" onclick="window.__editBenefit('${b.id}')">Editar</button>
        <button class="btn btn-danger btn-sm" onclick="window.__deleteBenefit('${b.id}')">Excluir</button>
      </td>
    </tr>
  `).join('');
}

document.getElementById('btn-new-benefit').addEventListener('click', () => {
  editingBenefitId = null;
  document.getElementById('modal-benefit-title').textContent = 'Novo Benefício';
  ['b-company','b-category','b-desc','b-instructions'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('b-order').value = benefits.length + 1;
  document.getElementById('b-active').checked = true;
  document.getElementById('modal-benefit').classList.remove('hidden');
});

window.__editBenefit = id => {
  const b = benefits.find(x => x.id === id);
  editingBenefitId = id;
  document.getElementById('modal-benefit-title').textContent = 'Editar Benefício';
  document.getElementById('b-company').value      = b.company || '';
  document.getElementById('b-category').value     = b.category || '';
  document.getElementById('b-desc').value         = b.description || '';
  document.getElementById('b-instructions').value = b.instructions || '';
  document.getElementById('b-order').value        = b.order || 1;
  document.getElementById('b-active').checked     = !!b.active;
  document.getElementById('modal-benefit').classList.remove('hidden');
};

window.__deleteBenefit = async id => {
  if (!confirm('Excluir este benefício?')) return;
  await fetchAPI(`/api/benefits/${id}`, { method: 'DELETE' });
  showToast('Benefício excluído.');
  await loadBenefits();
};

document.getElementById('modal-benefit-save').addEventListener('click', async () => {
  const company      = document.getElementById('b-company').value.trim();
  const category     = document.getElementById('b-category').value.trim();
  const description  = document.getElementById('b-desc').value.trim();
  const instructions = document.getElementById('b-instructions').value.trim();
  const order        = parseInt(document.getElementById('b-order').value) || 1;
  const active       = document.getElementById('b-active').checked;

  if (!company) { showToast('Nome da empresa é obrigatório.'); return; }

  const data = { company, category, description, instructions, order, active };
  try {
    if (editingBenefitId) {
      await fetchAPI(`/api/benefits/${editingBenefitId}`, { method: 'PUT', body: JSON.stringify(data) });
      showToast('Benefício atualizado.');
    } else {
      await fetchAPI('/api/benefits', { method: 'POST', body: JSON.stringify(data) });
      showToast('Benefício criado.');
    }
    document.getElementById('modal-benefit').classList.add('hidden');
    await loadBenefits();
  } catch (err) {
    showToast('Erro: ' + err.message);
  }
});

['modal-benefit-close','modal-benefit-cancel'].forEach(id =>
  document.getElementById(id).addEventListener('click', () =>
    document.getElementById('modal-benefit').classList.add('hidden')
  )
);

// ── Ombudsman ─────────────────────────────────────────────────────────────────

async function loadOmbudsman() {
  const tbody = document.getElementById('ombudsman-tbody');
  try {
    const messages = await fetchAPI('/api/ombudsman');
    if (messages.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-state">Nenhuma mensagem recebida.</td></tr>';
      return;
    }
    const labels = { sugestao: 'Sugestão', reclamacao: 'Reclamação', denuncia: 'Denúncia' };
    tbody.innerHTML = messages.map(m => {
      const date = m.created_at ? new Date(m.created_at).toLocaleDateString('pt-BR') : '—';
      const cat  = labels[m.category] || m.category;
      return `<tr>
        <td><span class="badge badge-gray">${cat}</span></td>
        <td style="white-space:pre-wrap; max-width:400px">${m.message || ''}</td>
        <td style="white-space:nowrap">${date}</td>
      </tr>`;
    }).join('');
  } catch {
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state">Sem permissão para acessar a ouvidoria.</td></tr>';
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

buildTabs();
