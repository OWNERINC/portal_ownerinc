import { requireAuth, getCachedUserSnapshot, showToast, can, fetchAPI, fetchAPIPage } from './auth.js';
import { clear, closeDialog, element, openDialog, safeHttpUrl } from './ui.js';

const cachedUser = getCachedUserSnapshot();
let me = cachedUser;
let solidesAdminStatus = null;
const TABS = [
  ['users', 'Usuários', 'manageUsers'],
  ['job-titles', 'Cargos', 'manageUsers'],
  ['academy', 'Academy', 'manageAcademy'],
  ['benefits', 'Benefícios', 'manageBenefits'],
];
if (me && can(me, 'manageSolides')) TABS.push(['solides', 'Sólides', 'manageSolides']);
const pages = {};
let users = [];
let courses = [];
let benefits = [];
let editingUserId = null;
let editingCourseId = null;
let editingBenefitId = null;
let solidesLinks = [];
let jobTitles = [];
let editingJobTitleId = null;
const AUDIT_PAGE_SIZE = 50;
let bulkPreviewRows = [];
let bulkJobId = null;

if (me) buildTabs(false);
me = await requireAuth(true);
if (!me) throw new Error('Administrator access required');
if (can(me, 'manageSolides')) {
  try { solidesAdminStatus = await fetchAPI('/api/solides/admin/status'); } catch (error) {
    if (error.status !== 404) console.warn('Sólides admin discovery failed');
  }
  if (!TABS.some(([id]) => id === 'solides')) TABS.push(['solides', 'Sólides', 'manageSolides']);
}

function tableState(tbodyId, columns, message, retry) {
  const pagination = document.getElementById(tbodyId.replace(/-tbody$/, '-pagination'));
  if (pagination) clear(pagination);
  const cell = element('td', { colspan: String(columns), className: 'empty-state', role: retry ? 'alert' : 'status', text: message });
  if (retry) cell.append(document.createElement('br'), element('button', { className: 'btn btn-ghost', type: 'button', text: 'Tentar novamente', on: { click: retry } }));
  clear(document.getElementById(tbodyId)).append(element('tr', {}, cell));
}

function cell(text, className) {
  const td = element('td', { className: 'break-text' });
  td.append(className ? element('span', { className, text: String(text) }) : document.createTextNode(String(text)));
  return td;
}

function actions(...buttons) {
  return element('td', { className: 'table-actions' }, buttons);
}

function paginate(key, items, paginationId, renderRows) {
  const total = Math.max(1, Math.ceil(items.length / 50));
  pages[key] = Math.min(pages[key] || 0, total - 1);
  renderRows(items.slice(pages[key] * 50, pages[key] * 50 + 50));
  const node = clear(document.getElementById(paginationId));
  if (items.length <= 50) return;
  node.append(
    element('button', { className: 'btn btn-ghost', type: 'button', text: 'Anterior', ...(pages[key] === 0 ? { disabled: '' } : {}), on: { click: () => { pages[key] -= 1; paginate(key, items, paginationId, renderRows); } } }),
    element('span', { text: `Página ${pages[key] + 1} de ${total}` }),
    element('button', { className: 'btn btn-ghost', type: 'button', text: 'Próxima', ...(pages[key] === total - 1 ? { disabled: '' } : {}), on: { click: () => { pages[key] += 1; paginate(key, items, paginationId, renderRows); } } }),
  );
}

function serverPagination(key, total, paginationId, load) {
  const pageCount = Math.max(1, Math.ceil(total / 50));
  const node = clear(document.getElementById(paginationId));
  if (pageCount === 1) return;
  node.append(
    element('button', { className: 'btn btn-ghost', type: 'button', text: 'Anterior', ...(pages[key] === 0 ? { disabled: '' } : {}), on: { click: () => { pages[key] -= 1; load(); } } }),
    element('span', { text: `Página ${pages[key] + 1} de ${pageCount}` }),
    element('button', { className: 'btn btn-ghost', type: 'button', text: 'Próxima', ...(pages[key] >= pageCount - 1 ? { disabled: '' } : {}), on: { click: () => { pages[key] += 1; load(); } } }),
  );
}

function renderJobTitleOptions(selectedId = '') {
  const select = document.getElementById('u-job-title');
  if (!select) return;
  clear(select).append(element('option', { value: '', text: 'Sem cargo definido' }));
  jobTitles.filter(title => title.active || title.id === selectedId).forEach(title => select.append(
    element('option', { value: title.id, text: title.active ? title.name : `${title.name} (inativo)` })
  ));
  select.value = selectedId || '';
}

function showJobTitleEditor(title = null) {
  editingJobTitleId = title?.id || null;
  document.getElementById('job-title-name').value = title?.name || '';
  document.getElementById('job-title-active').checked = title ? !!title.active : true;
  document.getElementById('job-title-editor').hidden = false;
  document.getElementById('job-title-name').focus();
}

function hideJobTitleEditor() {
  editingJobTitleId = null;
  document.getElementById('job-title-editor').hidden = true;
}

function renderJobTitles() {
  const tbody = clear(document.getElementById('job-titles-tbody'));
  if (!jobTitles.length) return tableState('job-titles-tbody', 4, 'Nenhum cargo cadastrado.');
  jobTitles.forEach(title => tbody.append(element('tr', {}, [
    cell(title.name),
    cell(title.user_count || 0),
    cell(title.active ? 'Ativo' : 'Inativo', `badge ${title.active ? 'badge-green' : 'badge-gray'}`),
    actions(
      element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Editar', 'aria-label': `Editar cargo: ${title.name}`, on: { click: () => showJobTitleEditor(title) } }),
      element('button', { className: title.active ? 'btn btn-danger btn-sm' : 'btn btn-ghost btn-sm', type: 'button', text: title.active ? 'Desativar' : 'Ativar', 'aria-label': `${title.active ? 'Desativar' : 'Ativar'} cargo: ${title.name}`, on: { click: () => toggleJobTitle(title) } }),
    ),
  ])));
}

async function loadJobTitles() {
  tableState('job-titles-tbody', 4, 'Carregando cargos…');
  try {
    const result = await fetchAPIPage('/api/job-titles?all=true&limit=100&offset=0');
    jobTitles = result.data;
    renderJobTitles();
    renderJobTitleOptions(document.getElementById('u-job-title')?.value || '');
  } catch {
    tableState('job-titles-tbody', 4, 'Não foi possível carregar os cargos.', loadJobTitles);
  }
}

async function toggleJobTitle(title) {
  if (title.active && !confirm(`Desativar o cargo "${title.name}"? Usuários atuais manterão o cargo.`)) return;
  try {
    await fetchAPI(`/api/job-titles/${encodeURIComponent(title.id)}`, {
      method: 'PUT', body: JSON.stringify({ name: title.name, active: !title.active }),
    });
    showToast(title.active ? 'Cargo desativado.' : 'Cargo ativado.');
    await loadJobTitles();
  } catch (error) {
    showToast(`Não foi possível atualizar o cargo: ${error.message}`);
  }
}

function buildTabs(activate = true) {
  const tabs = TABS.filter(([, , permission]) => can(me, permission));
  const container = clear(document.getElementById('admin-tabs'));
  if (!tabs.length) {
    container.append(element('p', { className: 'empty-state', text: 'Nenhuma permissão administrativa configurada.' }));
    return;
  }
  tabs.forEach(([id, label]) => container.append(element('button', {
    className: 'admin-tab', id: `tab-${id}`, role: 'tab', type: 'button', text: label,
    'aria-controls': `section-${id}`, 'aria-selected': 'false', tabindex: '-1',
    on: { click: () => switchTab(id, true) },
  })));
  if (!container.dataset.keyboardBound) {
    container.dataset.keyboardBound = 'true';
    container.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...container.querySelectorAll('[role="tab"]')];
      const current = buttons.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].click();
      buttons[next].focus();
    });
  }
  if (!activate) return;
  const requested = new URLSearchParams(location.search).get('tab');
  switchTab(tabs.some(([id]) => id === requested) ? requested : tabs[0][0]);
}

function switchTab(id, push = false) {
  document.querySelectorAll('[role="tab"]').forEach(tab => {
    const active = tab.id === `tab-${id}`;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.admin-section').forEach(section => { section.hidden = section.id !== `section-${id}`; });
  const url = new URL(location.href);
  url.searchParams.set('tab', id);
  history[push ? 'pushState' : 'replaceState']({}, '', url);
  if (id === 'users') {
    loadUsers();
    if (can(me, 'superAdmin')) loadAudit();
  }
  if (id === 'job-titles') loadJobTitles();
  if (id === 'academy') loadCourses();
  if (id === 'benefits') loadBenefits();
  if (id === 'solides') loadSolides();
}

function renderSolidesStatus() {
  document.getElementById('solides-stage').textContent = solidesAdminStatus.stage;
  const container = clear(document.getElementById('solides-admin-status'));
  for (const [title, value] of [
    ['Vínculos', solidesAdminStatus.links.total],
    ['Verificados', solidesAdminStatus.links.verified],
    ['Conflitos', solidesAdminStatus.links.conflicts],
    ['Piloto', `${solidesAdminStatus.pilotUsers} usuários`],
  ]) container.append(element('article', { className: 'card' }, [
    element('div', { className: 'card-title', text: title }), element('p', { className: 'card-copy', text: String(value) }),
  ]));
}

async function loadSolidesUsers() {
  const select = document.getElementById('solides-user');
  if (select.options.length) return;
  let offset = 0;
  let total = 1;
  while (offset < total) {
    const result = await fetchAPIPage(`/api/solides/admin/users?limit=100&offset=${offset}`);
    total = result.total ?? result.data.length;
    result.data.forEach(user => {
      const option = document.createElement('option');
      option.value = user.uid;
      option.textContent = `${user.name || user.email} — ${user.email}`;
      select.append(option);
    });
    if (!result.data.length) break;
    offset += result.data.length;
  }
}

async function loadSolides() {
  tableState('solides-links-tbody', 5, 'Carregando vínculos…');
  try {
    pages.solides ||= 0;
    const [linksResult, , refreshedStatus] = await Promise.all([
      fetchAPIPage(`/api/solides/admin/links?limit=50&offset=${pages.solides * 50}`), loadSolidesUsers(),
      fetchAPI('/api/solides/admin/status'),
    ]);
    solidesAdminStatus = refreshedStatus;
    solidesLinks = linksResult.data;
    renderSolidesStatus();
    if (!solidesLinks.length) {
      clear(document.getElementById('solides-pagination'));
      return tableState('solides-links-tbody', 5, 'Nenhum vínculo cadastrado.');
    }
    const tbody = clear(document.getElementById('solides-links-tbody'));
    solidesLinks.forEach(link => tbody.append(element('tr', {}, [
      cell(link.name || link.email), cell(link.employee_id), cell(link.external_id || '—'), cell(link.status),
      actions(
        element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Editar', 'aria-label': `Editar vínculo: ${link.name || link.email}`, on: { click: () => editSolidesLink(link) } }),
        element('button', { className: 'btn btn-danger btn-sm', type: 'button', text: 'Remover', 'aria-label': `Remover vínculo: ${link.name || link.email}`, on: { click: () => deleteSolidesLink(link.user_uid) } }),
      ),
    ])));
    serverPagination('solides', linksResult.total || 0, 'solides-pagination', loadSolides);
  } catch {
    tableState('solides-links-tbody', 5, 'Não foi possível carregar os vínculos.', loadSolides);
  }
}

function editSolidesLink(link) {
  document.getElementById('solides-user').value = link.user_uid;
  document.getElementById('solides-employee-id').value = link.employee_id;
  document.getElementById('solides-external-id').value = link.external_id || '';
  document.getElementById('solides-link-status').value = link.status;
  document.getElementById('solides-employee-id').focus();
}

async function deleteSolidesLink(uid) {
  if (!confirm('Remover este vínculo com a Sólides?')) return;
  try {
    await fetchAPI(`/api/solides/admin/links/${encodeURIComponent(uid)}`, { method: 'DELETE' });
    showToast('Vínculo removido.');
    await loadSolides();
  } catch (error) { showToast(`Não foi possível remover: ${error.message}`); }
}

async function runSolidesProbe() {
  const button = document.getElementById('solides-probe');
  const output = clear(document.getElementById('solides-probe-result'));
  button.disabled = true;
  button.textContent = 'Testando…';
  try {
    const userUid = document.getElementById('solides-user').value || undefined;
    const report = await fetchAPI('/api/solides/admin/probe', {
      method: 'POST', body: JSON.stringify(userUid ? { userUid } : {}),
    });
    report.checks.forEach(check => output.append(element('article', { className: 'card' }, [
      element('div', { className: 'card-heading' }, [
        element('div', { className: 'card-title', text: check.name }),
        element('span', { className: `badge ${check.ok ? 'badge-green' : 'badge-red'}`, text: check.ok ? 'OK' : String(check.status || check.error || 'Falha') }),
      ]),
      element('p', { className: 'card-copy', text: `${check.durationMs} ms · ${check.shape?.kind || 'sem resposta'}` }),
    ])));
  } catch (error) {
    output.append(element('p', { className: 'empty-state', role: 'alert', text: `Não foi possível executar o teste: ${error.message}` }));
  } finally {
    button.disabled = false;
    button.textContent = 'Testar conexão';
  }
}

async function loadUsers() {
  tableState('users-tbody', 8, 'Carregando usuários…');
  try {
    pages.users ||= 0;
    const result = await fetchAPIPage(`/api/users?limit=50&offset=${pages.users * 50}`);
    users = result.data;
    if (!users.length) return tableState('users-tbody', 8, 'Nenhum usuário cadastrado.');
    const tbody = clear(document.getElementById('users-tbody'));
    users.forEach(user => {
        const isPJ = user.contract_type === 'pj' || user.is_pj;
        const disabled = user.permissions?.accountDisabled === true;
        tbody.append(element('tr', {}, [
          cell(user.name || '—'), cell(user.email || '—'),
          cell(user.role === 'admin' ? 'Administrador' : 'Leitor', `badge ${user.role === 'admin' ? 'badge-gold' : 'badge-gray'}`),
          cell(isPJ ? 'PJ' : 'CLT', `badge ${isPJ ? 'badge-gold' : 'badge-gray'}`), cell(user.job_title || '—'), cell(isPJ ? user.pj_due_day || '—' : '—'),
          cell(disabled ? 'Desativado' : 'Ativo', `badge ${disabled ? 'badge-gray' : 'badge-green'}`),
          actions(
            element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Editar', 'aria-label': `Editar usuário: ${user.name || user.email}`, on: { click: () => editUser(user) } }),
            element('button', { className: disabled ? 'btn btn-ghost btn-sm' : 'btn btn-danger btn-sm', type: 'button', text: disabled ? 'Reativar' : 'Desativar', 'aria-label': `${disabled ? 'Reativar' : 'Desativar'} usuário: ${user.name || user.email}`, on: { click: () => disabled ? reactivateUser(user.uid) : deleteUser(user.uid) } }),
            ...(disabled && can(me, 'superAdmin') && !user.email.endsWith('@invalid.local')
               ? [element('button', { className: 'btn btn-danger btn-sm', type: 'button', text: 'Anonimizar', 'aria-label': `Anonimizar usuário: ${user.name || user.email}`, on: { click: () => eraseUserData(user.uid) } })]
              : []),
          ),
        ]));
    });
    serverPagination('users', result.total || users.length, 'users-pagination', loadUsers);
  } catch {
    tableState('users-tbody', 8, 'Não foi possível carregar os usuários.', loadUsers);
  }
}

function renderBulkPreview(report) {
  bulkPreviewRows = report.rows;
  const preview = clear(document.getElementById('bulk-preview'));
  preview.hidden = false;
  preview.append(element('p', { className: 'card-copy', text: `${report.total} linhas · ${report.ready} prontas · ${report.total - report.ready} ignoradas` }));
  const table = element('table', {}, element('tbody'));
  table.querySelector('tbody').append(...report.rows.map(row => element('tr', {}, [
    cell(row.row_number), cell(row.name || '—'), cell(row.email || '—'), cell(row.job_title || '—'),
    cell(row.status === 'ready' ? 'Pronta' : row.status === 'duplicate' ? 'Duplicada' : `Inválida: ${row.errors.join(', ')}`, `badge ${row.status === 'ready' ? 'badge-green' : 'badge-gray'}`),
  ])));
  preview.append(element('div', { className: 'table-wrapper' }, table));
  document.getElementById('bulk-confirm-button').disabled = report.ready === 0;
}

async function pollBulkJob() {
  const feedback = document.getElementById('bulk-import-feedback');
  try {
    const job = await fetchAPI(`/api/users/bulk/${encodeURIComponent(bulkJobId)}`);
    const invited = job.invited_count || 0;
    const failed = job.failed_count || 0;
    feedback.textContent = `Processamento: ${invited} convidados, ${failed} falhas de ${job.ready_count}.`;
    document.getElementById('bulk-retry-button').hidden = failed === 0;
    if (job.status !== 'completed') return setTimeout(pollBulkJob, 3000);
    await loadUsers();
  } catch (error) { feedback.textContent = `Não foi possível consultar o processamento: ${error.message}`; }
}

document.getElementById('btn-bulk-users').addEventListener('click', () => { document.getElementById('bulk-import-panel').hidden = false; });
document.getElementById('bulk-preview-button').addEventListener('click', async () => {
  const file = document.getElementById('bulk-csv').files[0];
  const feedback = document.getElementById('bulk-import-feedback');
  if (!file) { feedback.textContent = 'Selecione um arquivo CSV.'; return; }
  try { renderBulkPreview(await fetchAPI('/api/users/bulk/preview', { method: 'POST', body: JSON.stringify({ csv: await file.text() }) })); }
  catch (error) { feedback.textContent = error.message; }
});
document.getElementById('bulk-confirm-button').addEventListener('click', async () => {
  if (!bulkPreviewRows.length || !confirm('Confirmar a criação e o envio dos convites para as linhas prontas?')) return;
  const feedback = document.getElementById('bulk-import-feedback');
  try {
    const job = await fetchAPI('/api/users/bulk/confirm', { method: 'POST', body: JSON.stringify({ rows: bulkPreviewRows }) });
    bulkJobId = job.id; feedback.textContent = 'Importação enfileirada.'; document.getElementById('bulk-confirm-button').disabled = true; pollBulkJob();
  } catch (error) { feedback.textContent = error.message; }
});
document.getElementById('bulk-retry-button').addEventListener('click', async () => {
  try { await fetchAPI(`/api/users/bulk/${encodeURIComponent(bulkJobId)}/retry`, { method: 'POST' }); document.getElementById('bulk-retry-button').hidden = true; pollBulkJob(); }
  catch (error) { document.getElementById('bulk-import-feedback').textContent = error.message; }
});

async function loadAudit() {
  const panel = document.getElementById('audit-panel');
  const tbody = document.getElementById('audit-tbody');
  panel.hidden = false;
  try {
    pages.audit ||= 0;
    const result = await fetchAPIPage(`/api/users/audit?limit=${AUDIT_PAGE_SIZE}&offset=${pages.audit * AUDIT_PAGE_SIZE}`);
    const events = result.data;
    clear(tbody);
    if (!events.length) {
      clear(document.getElementById('audit-pagination'));
      tbody.append(element('tr', {}, element('td', { colspan: '4', className: 'empty-state', text: 'Nenhum evento administrativo registrado.' })));
      return;
    }
    const format = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    events.forEach(event => tbody.append(element('tr', {}, [
      cell(format.format(new Date(event.created_at))),
      cell(event.actor_uid || 'Sistema'),
      cell(event.action || '—'),
      cell([event.target_type, event.target_id].filter(Boolean).join(': ') || '—'),
    ])));
    serverPagination('audit', result.total ?? events.length, 'audit-pagination', loadAudit);
  } catch {
    const state = element('td', { colspan: '4', className: 'empty-state', role: 'alert', text: 'Não foi possível carregar a auditoria. ' });
    state.append(element('button', { className: 'btn btn-ghost', type: 'button', text: 'Tentar novamente', on: { click: loadAudit } }));
    clear(tbody).append(element('tr', {}, state));
  }
}

function resetPermissions() {
  ['p-super', 'p-users', 'p-knowledge', 'p-reminders', 'p-academy', 'p-benefits', 'p-solides'].forEach(id => {
    const input = document.getElementById(id);
    input.checked = false;
    input.disabled = false;
  });
}

function setUserFields(user = {}) {
  document.getElementById('u-name').value = user.name || '';
  document.getElementById('u-email').value = user.email || '';
  renderJobTitleOptions(user.job_title_id || '');
  document.getElementById('u-role').value = user.role || 'viewer';
  const contract = user.contract_type || (user.is_pj ? 'pj' : 'clt');
  document.getElementById('u-contract').value = contract;
  document.getElementById('u-pjday').value = user.pj_due_day || '';
  document.getElementById('u-phone').value = user.phone || '';
  document.getElementById('pj-day-group').hidden = contract !== 'pj';
  document.getElementById('u-pjday').required = contract === 'pj';
  document.getElementById('u-email').readOnly = !!editingUserId;
  document.getElementById('user-form-help').hidden = !!editingUserId;
  document.getElementById('modal-user-save').textContent = editingUserId ? 'Salvar' : 'Enviar convite';
  document.getElementById('user-form-feedback').textContent = '';
  document.getElementById('u-job-title').required = !editingUserId;
  const mayEditPrivileges = can(me, 'superAdmin') && user.uid !== me.uid;
  document.getElementById('u-role').disabled = !mayEditPrivileges;
  resetPermissions();
  const permissions = user.permissions || {};
  const permissionMap = { 'p-super': 'superAdmin', 'p-users': 'manageUsers', 'p-knowledge': 'manageKnowledge', 'p-reminders': 'manageReminders', 'p-academy': 'manageAcademy', 'p-benefits': 'manageBenefits', 'p-solides': 'manageSolides' };
  Object.entries(permissionMap).forEach(([id, permission]) => { document.getElementById(id).checked = !!permissions[permission]; });
  document.getElementById('permissions-group').hidden = !(document.getElementById('u-role').value === 'admin' && mayEditPrivileges);
}

function newUser() {
  editingUserId = null;
  document.getElementById('user-form').reset();
  document.getElementById('modal-user-title').textContent = 'Convidar usuário';
  setUserFields();
  openDialog(document.getElementById('modal-user'), document.getElementById('u-name'));
}

function editUser(user) {
  editingUserId = user.uid;
  document.getElementById('modal-user-title').textContent = 'Editar usuário';
  setUserFields(user);
  openDialog(document.getElementById('modal-user'), document.getElementById('u-name'));
}

async function deleteUser(uid) {
  if (!confirm('Desativar este usuário? O acesso será revogado.')) return;
  try {
    await fetchAPI(`/api/users/${encodeURIComponent(uid)}`, { method: 'DELETE' });
    showToast('Usuário desativado.');
    await loadUsers();
  } catch (error) {
    showToast(`Não foi possível desativar: ${error.message}`);
  }
}

async function reactivateUser(uid) {
  try {
    await fetchAPI(`/api/users/${encodeURIComponent(uid)}/reactivate`, { method: 'PUT' });
    showToast('Usuário reativado.');
    await loadUsers();
  } catch (error) {
    showToast(`Não foi possível reativar: ${error.message}`);
  }
}

async function eraseUserData(uid) {
  if (!confirm('Apagar permanentemente nome, contato, foto e identidade Firebase deste usuário? O histórico operacional será preservado de forma pseudonimizada.')) return;
  try {
    await fetchAPI(`/api/users/${encodeURIComponent(uid)}/personal-data`, { method: 'DELETE' });
    showToast('Dados pessoais anonimizados.');
    await loadUsers();
  } catch (error) {
    showToast(`Não foi possível anonimizar: ${error.message}`);
  }
}

document.getElementById('user-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const contract = document.getElementById('u-contract').value;
  const role = document.getElementById('u-role').value;
  const data = {
    name: document.getElementById('u-name').value.trim(),
    contract_type: contract, is_pj: contract === 'pj',
    pj_due_day: contract === 'pj' ? Number(document.getElementById('u-pjday').value) || null : null,
    job_title_id: document.getElementById('u-job-title').value || null,
    phone: document.getElementById('u-phone').value.trim(),
  };
  if (!editingUserId) {
    data.email = document.getElementById('u-email').value.trim();
  }
  if (can(me, 'superAdmin') && editingUserId !== me.uid) {
    data.role = role;
    data.permissions = role === 'admin' ? {
      superAdmin: document.getElementById('p-super').checked,
      manageUsers: document.getElementById('p-users').checked,
      manageReminders: document.getElementById('p-reminders').checked,
      manageAcademy: document.getElementById('p-academy').checked,
      manageBenefits: document.getElementById('p-benefits').checked,
      manageSolides: document.getElementById('p-solides').checked,
    } : {};
    if (document.getElementById('p-knowledge').checked) data.permissions.manageKnowledge = true;
  }
  const save = document.getElementById('modal-user-save');
  const feedback = document.getElementById('user-form-feedback');
  const isInvite = !editingUserId;
  save.disabled = true;
  save.textContent = isInvite ? 'Enviando convite…' : 'Salvando…';
  feedback.textContent = '';
  feedback.style.color = '';
  try {
    await fetchAPI(editingUserId ? `/api/users/${encodeURIComponent(editingUserId)}` : '/api/users', {
      method: editingUserId ? 'PUT' : 'POST', body: JSON.stringify(data),
    });
    closeDialog(document.getElementById('modal-user'), true);
    showToast(isInvite ? `Convite enviado para ${data.email}.` : 'Usuário atualizado.');
    await loadUsers();
  } catch (error) {
    feedback.style.color = 'var(--danger)';
    feedback.textContent = error.status === 409
      ? 'Este e-mail já está cadastrado. Verifique a lista de usuários antes de tentar novamente.'
      : isInvite
        ? 'Não foi possível enviar o convite. Nenhuma conta foi criada; tente novamente.'
        : `Não foi possível salvar: ${error.message}`;
  } finally {
    save.disabled = false;
    save.textContent = isInvite ? 'Enviar convite' : 'Salvar';
  }
});

async function loadCourses() {
  tableState('academy-tbody', 4, 'Carregando cursos…');
  try {
    pages.academy ||= 0;
    const result = await fetchAPIPage(`/api/academy?all=true&limit=50&offset=${pages.academy * 50}`);
    courses = result.data;
    if (!courses.length) return tableState('academy-tbody', 4, 'Nenhum curso cadastrado.');
    {
      const tbody = clear(document.getElementById('academy-tbody'));
      courses.forEach(course => tbody.append(element('tr', {}, [
        cell(course.title || '—'), cell(course.category || '—', 'badge badge-gray'),
        cell(course.active ? 'Ativo' : 'Inativo', `badge ${course.active ? 'badge-green' : 'badge-gray'}`),
        actions(
          element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Editar', 'aria-label': `Editar curso: ${course.title}`, on: { click: () => editCourse(course) } }),
          element('button', { className: 'btn btn-danger btn-sm', type: 'button', text: 'Excluir', 'aria-label': `Excluir curso: ${course.title}`, on: { click: () => deleteCourse(course.id) } }),
        ),
      ])));
    }
    serverPagination('academy', result.total ?? courses.length, 'academy-pagination', loadCourses);
  } catch {
    tableState('academy-tbody', 4, 'Não foi possível carregar os cursos.', loadCourses);
  }
}

function courseDialog(course) {
  editingCourseId = course?.id || null;
  document.getElementById('modal-course-title').textContent = course ? 'Editar Curso' : 'Novo Curso';
  document.getElementById('c-title').value = course?.title || '';
  document.getElementById('c-category').value = course?.category || '';
  document.getElementById('c-desc').value = course?.description || '';
  document.getElementById('c-url').value = course?.url || '';
  document.getElementById('c-order').value = course?.order || courses.length + 1;
  document.getElementById('c-active').checked = course ? !!course.active : true;
  openDialog(document.getElementById('modal-course'), document.getElementById('c-title'));
}

function editCourse(course) { courseDialog(course); }
async function deleteCourse(id) {
  if (!confirm('Excluir este curso?')) return;
  try { await fetchAPI(`/api/academy/${encodeURIComponent(id)}`, { method: 'DELETE' }); showToast('Curso excluído.'); await loadCourses(); }
  catch (error) { showToast(`Não foi possível excluir: ${error.message}`); }
}

document.getElementById('course-form').addEventListener('submit', async event => {
  event.preventDefault();
  const urlInput = document.getElementById('c-url');
  urlInput.setCustomValidity(safeHttpUrl(urlInput.value.trim()) ? '' : 'Use uma URL http:// ou https:// válida.');
  if (!event.currentTarget.reportValidity()) return;
  const data = { title: document.getElementById('c-title').value.trim(), category: document.getElementById('c-category').value.trim(), description: document.getElementById('c-desc').value.trim(), url: safeHttpUrl(urlInput.value.trim()), order: Number(document.getElementById('c-order').value) || 1, active: document.getElementById('c-active').checked };
  const save = document.getElementById('modal-course-save');
  save.disabled = true;
  save.textContent = 'Salvando…';
  try {
    await fetchAPI(editingCourseId ? `/api/academy/${encodeURIComponent(editingCourseId)}` : '/api/academy', { method: editingCourseId ? 'PUT' : 'POST', body: JSON.stringify(data) });
    closeDialog(document.getElementById('modal-course'), true); showToast(editingCourseId ? 'Curso atualizado.' : 'Curso criado.'); await loadCourses();
  } catch (error) { showToast(`Não foi possível salvar: ${error.message}`); }
  finally { save.disabled = false; save.textContent = 'Salvar'; }
});

async function loadBenefits() {
  tableState('benefits-tbody', 5, 'Carregando benefícios…');
  try {
    pages.benefits ||= 0;
    const result = await fetchAPIPage(`/api/benefits?all=true&limit=50&offset=${pages.benefits * 50}`);
    benefits = result.data;
    if (!benefits.length) return tableState('benefits-tbody', 5, 'Nenhum benefício cadastrado.');
    {
      const tbody = clear(document.getElementById('benefits-tbody'));
      benefits.forEach(benefit => tbody.append(element('tr', {}, [
        cell(benefit.company || '—'), cell(benefit.category || '—', 'badge badge-gray'), cell(benefit.description || '—'),
        cell(benefit.active ? 'Ativo' : 'Inativo', `badge ${benefit.active ? 'badge-green' : 'badge-gray'}`),
        actions(
          element('button', { className: 'btn btn-ghost btn-sm', type: 'button', text: 'Editar', 'aria-label': `Editar benefício: ${benefit.company}`, on: { click: () => benefitDialog(benefit) } }),
          element('button', { className: 'btn btn-danger btn-sm', type: 'button', text: 'Excluir', 'aria-label': `Excluir benefício: ${benefit.company}`, on: { click: () => deleteBenefit(benefit.id) } }),
        ),
      ])));
    }
    serverPagination('benefits', result.total ?? benefits.length, 'benefits-pagination', loadBenefits);
  } catch {
    tableState('benefits-tbody', 5, 'Não foi possível carregar os benefícios.', loadBenefits);
  }
}

function benefitDialog(benefit) {
  editingBenefitId = benefit?.id || null;
  document.getElementById('modal-benefit-title').textContent = benefit ? 'Editar Benefício' : 'Novo Benefício';
  document.getElementById('b-company').value = benefit?.company || '';
  document.getElementById('b-category').value = benefit?.category || '';
  document.getElementById('b-desc').value = benefit?.description || '';
  document.getElementById('b-instructions').value = benefit?.instructions || '';
  document.getElementById('b-order').value = benefit?.order || benefits.length + 1;
  document.getElementById('b-active').checked = benefit ? !!benefit.active : true;
  openDialog(document.getElementById('modal-benefit'), document.getElementById('b-company'));
}

async function deleteBenefit(id) {
  if (!confirm('Excluir este benefício?')) return;
  try { await fetchAPI(`/api/benefits/${encodeURIComponent(id)}`, { method: 'DELETE' }); showToast('Benefício excluído.'); await loadBenefits(); }
  catch (error) { showToast(`Não foi possível excluir: ${error.message}`); }
}

document.getElementById('benefit-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const data = { company: document.getElementById('b-company').value.trim(), category: document.getElementById('b-category').value.trim(), description: document.getElementById('b-desc').value.trim(), instructions: document.getElementById('b-instructions').value.trim(), order: Number(document.getElementById('b-order').value) || 1, active: document.getElementById('b-active').checked };
  const save = document.getElementById('modal-benefit-save');
  save.disabled = true;
  save.textContent = 'Salvando…';
  try {
    await fetchAPI(editingBenefitId ? `/api/benefits/${encodeURIComponent(editingBenefitId)}` : '/api/benefits', { method: editingBenefitId ? 'PUT' : 'POST', body: JSON.stringify(data) });
    closeDialog(document.getElementById('modal-benefit'), true); showToast(editingBenefitId ? 'Benefício atualizado.' : 'Benefício criado.'); await loadBenefits();
  } catch (error) { showToast(`Não foi possível salvar: ${error.message}`); }
  finally { save.disabled = false; save.textContent = 'Salvar'; }
});

document.getElementById('u-contract').addEventListener('change', event => {
  const isPJ = event.target.value === 'pj';
  document.getElementById('pj-day-group').hidden = !isPJ;
  document.getElementById('u-pjday').required = isPJ;
});
document.getElementById('u-role').addEventListener('change', event => { document.getElementById('permissions-group').hidden = !(event.target.value === 'admin' && can(me, 'superAdmin')); });
document.getElementById('p-super').addEventListener('change', event => {
  ['p-users', 'p-knowledge', 'p-reminders', 'p-academy', 'p-benefits', 'p-solides'].forEach(id => { document.getElementById(id).checked = event.target.checked; document.getElementById(id).disabled = event.target.checked; });
});
document.getElementById('solides-link-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const externalId = document.getElementById('solides-external-id').value.trim();
  const save = document.getElementById('solides-link-save');
  save.disabled = true;
  try {
    await fetchAPI(`/api/solides/admin/links/${encodeURIComponent(document.getElementById('solides-user').value)}`, {
      method: 'PUT',
      body: JSON.stringify({
        employeeId: document.getElementById('solides-employee-id').value,
        externalId: externalId || null,
        employerScope: 'default',
        status: document.getElementById('solides-link-status').value,
        matchedBy: externalId ? 'external_id' : 'manual',
      }),
    });
    showToast('Vínculo Sólides salvo.');
    event.currentTarget.reset();
    await loadSolides();
  } catch (error) { showToast(`Não foi possível salvar: ${error.message}`); }
  finally { save.disabled = false; }
});
document.getElementById('solides-probe').addEventListener('click', runSolidesProbe);
document.getElementById('btn-new-user').addEventListener('click', newUser);
document.getElementById('btn-new-job-title').addEventListener('click', () => showJobTitleEditor());
document.getElementById('job-title-cancel').addEventListener('click', hideJobTitleEditor);
document.getElementById('job-title-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;
  const save = event.currentTarget.querySelector('button[type="submit"]');
  const editing = Boolean(editingJobTitleId);
  save.disabled = true;
  try {
    await fetchAPI(editingJobTitleId ? `/api/job-titles/${encodeURIComponent(editingJobTitleId)}` : '/api/job-titles', {
      method: editingJobTitleId ? 'PUT' : 'POST',
      body: JSON.stringify({
        name: document.getElementById('job-title-name').value.trim(),
        active: document.getElementById('job-title-active').checked,
      }),
    });
    hideJobTitleEditor();
    showToast(editing ? 'Cargo atualizado.' : 'Cargo criado.');
    await loadJobTitles();
  } catch (error) {
    showToast(error.status === 409 ? 'Esse cargo já existe.' : `Não foi possível salvar o cargo: ${error.message}`);
  } finally {
    save.disabled = false;
  }
});
document.getElementById('btn-new-course').addEventListener('click', () => courseDialog());
document.getElementById('btn-new-benefit').addEventListener('click', () => benefitDialog());
[['user', 'modal-user'], ['course', 'modal-course'], ['benefit', 'modal-benefit']].forEach(([name, modalId]) => {
  document.getElementById(`${modalId}-close`).addEventListener('click', () => closeDialog(document.getElementById(modalId)));
  document.getElementById(`${modalId}-cancel`).addEventListener('click', () => closeDialog(document.getElementById(modalId)));
});
window.addEventListener('popstate', () => {
  const requested = new URLSearchParams(location.search).get('tab');
  if (document.getElementById(`tab-${requested}`)) switchTab(requested);
});
if (can(me, 'manageUsers')) await loadJobTitles();
buildTabs();
