import { can, fetchAPI, fetchAPIPage } from './auth.js';
import { canLeavePageUI, clear, closeDialog, element, openDialog, safeHttpUrl, setDialogCloseGuard, protectForm } from './ui.js';

const requests = { fetchAPI, fetchAPIPage };
export function mount(page) {
const { fetchAPI, fetchAPIPage } = page.bindAPI(requests);
const showToast = page.toast;
const setTimeout = page.timeout;
const history = page.history;
const location = page.location;
const me = page.user;
let activeTab = null;
let solidesAdminStatus = null;
let solidesAdminAvailable = false;
let solidesDiscoveryPending = can(me, 'manageSolides');
const TABS = [
  ['users', 'Usuários', 'manageUsers'],
  ['registrations', 'Solicitações', 'manageUsers'],
  ['job-titles', 'Cargos', 'manageUsers'],
  ['academy', 'Academy', 'manageAcademy'],
];
const pages = {};
let users = [];
let courses = [];
let benefits = [];
let editingUserId = null;
let editingCourseId = null;
let editingBenefitId = null;
let solidesLinks = [];
let jobTitles = [];
let registrations = [];
let editingJobTitleId = null;
let reviewingRegistration = null;
let registrationReviewAction = 'approve';
const AUDIT_PAGE_SIZE = 50;
let bulkPreviewRows = [];
let bulkJobId = null;
const BULK_JOB_STORAGE_KEY_PREFIX = 'ownerinc-active-import-job:';

const markJobTitleClean = protectForm(document.getElementById('job-title-form'), page);

function tableState(tbodyId, columns, message, retry) {
  if (!page.active) return;
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
  document.getElementById('job-title-autocard').checked = title?.page_access?.autocard === true;
  document.getElementById('job-title-pos-cards').checked = title?.page_access?.posCards === true;
  document.getElementById('job-title-editor').hidden = false;
  document.getElementById('job-title-name').focus();
  markJobTitleClean();
}

function hideJobTitleEditor() {
  editingJobTitleId = null;
  document.getElementById('job-title-editor').hidden = true;
  markJobTitleClean();
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

async function discoverAdminFeatures() {
  solidesAdminAvailable = false;
  solidesAdminStatus = null;
  if (!can(me, 'manageSolides')) return;
  try {
    solidesAdminStatus = await fetchAPI('/api/solides/admin/status');
    solidesAdminAvailable = true;
  } catch {
    // The API intentionally hides Sólides while its release stage is off.
  } finally {
    solidesDiscoveryPending = false;
  }
}

async function toggleJobTitle(title) {
  if (title.active && !confirm(`Desativar o cargo "${title.name}"? Usuários atuais manterão o cargo, mas perderão o acesso derivado dele.`)) return;
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
  if (!page.active) return;
  const tabs = TABS.filter(([, , permission]) => can(me, permission));
  if (can(me, 'manageBenefits')) tabs.push(['benefits', 'Benefícios']);
  if (solidesAdminAvailable) tabs.push(['solides', 'Sólides']);
  const container = document.getElementById('admin-tabs');
  const allowed = new Set(tabs.map(([id]) => `tab-${id}`));
  [...container.children].forEach(node => { if (!allowed.has(node.id)) node.remove(); });
  if (!tabs.length) {
    container.append(element('p', { className: 'empty-state', text: 'Nenhuma permissão administrativa configurada.' }));
    return;
  }
  tabs.forEach(([id, label], index) => {
    const button = document.getElementById(`tab-${id}`) || element('button', {
    className: 'admin-tab', id: `tab-${id}`, role: 'tab', type: 'button', text: label,
    'aria-controls': `section-${id}`, 'aria-selected': 'false', tabindex: '-1',
    on: { click: () => switchTab(id, true) },
    });
    if (container.children[index] !== button) container.insertBefore(button, container.children[index] || null);
  });
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
  const preserveRequest = requested === 'solides' && solidesDiscoveryPending;
  const selected = tabs.some(([id]) => id === requested) ? requested
    : tabs.some(([id]) => id === activeTab) ? activeTab : tabs[0][0];
  if (selected === activeTab && (requested === selected || preserveRequest)) return;
  switchTab(selected, false, preserveRequest);
}

function switchTab(id, push = false, preserveRequest = false) {
  if (!page.active || !document.getElementById(`tab-${id}`)) return;
  if (push && (!page.canLeave() || !canLeavePageUI())) return;
  if (activeTab === id && new URLSearchParams(location.search).get('tab') === id) return;
  if (!preserveRequest) {
    const url = new URL(location.href);
    url.searchParams.set('tab', id);
    history[push ? 'pushState' : 'replaceState']({}, '', url);
  }
  if (activeTab === id) return;
  activeTab = id;
  document.querySelectorAll('[role="tab"]').forEach(tab => {
    const active = tab.id === `tab-${id}`;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('.admin-section').forEach(section => { section.hidden = section.id !== `section-${id}`; });
  if (id === 'users') {
    loadUsers();
    if (can(me, 'superAdmin')) loadAudit();
  }
  if (id === 'registrations') loadRegistrations();
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
    if (!page.active) return;
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
        const disabled = user.state === 'disabled' || user.permissions?.accountDisabled === true;
        const enablePending = !disabled && (user.state === 'enable_pending' || user.firebase_enable_pending === true);
        const stateLabel = disabled ? 'Desativado' : enablePending ? 'Habilitação pendente' : 'Ativo';
        tbody.append(element('tr', {}, [
          cell(user.name || '—'), cell(user.email || '—'),
          cell(user.role === 'admin' ? 'Administrador' : 'Leitor', `badge ${user.role === 'admin' ? 'badge-gold' : 'badge-gray'}`),
          cell(isPJ ? 'PJ' : 'CLT', `badge ${isPJ ? 'badge-gold' : 'badge-gray'}`), cell(user.job_title || '—'), cell(isPJ ? user.pj_due_day || '—' : '—'),
          cell(stateLabel, `badge ${disabled || enablePending ? 'badge-gray' : 'badge-green'}`),
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

async function loadRegistrations() {
  tableState('registrations-tbody', 5, 'Carregando solicitações…');
  try {
    pages.registrations ||= 0;
    const result = await fetchAPIPage(`/api/registrations?status=pending&limit=50&offset=${pages.registrations * 50}`);
    registrations = result.data;
    if (!registrations.length) return tableState('registrations-tbody', 5, 'Nenhuma solicitação pendente.');
    const format = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    const tbody = clear(document.getElementById('registrations-tbody'));
    registrations.forEach(registration => tbody.append(element('tr', {}, [
      cell(registration.name), cell(registration.email), cell(registration.state_label || 'Cadastro recebido', `badge ${registration.state === 'confirmed' ? 'badge-green' : 'badge-gray'}`), cell(format.format(new Date(registration.created_at))),
      actions(
        element('button', { className: 'btn btn-primary btn-sm', type: 'button', text: 'Analisar', 'aria-label': `Analisar cadastro: ${registration.name}`, on: { click: () => openRegistrationReview(registration, 'approve') } }),
        element('button', { className: 'btn btn-danger btn-sm', type: 'button', text: 'Rejeitar', 'aria-label': `Rejeitar cadastro: ${registration.name}`, on: { click: () => openRegistrationReview(registration, 'reject') } }),
      ),
    ])));
    serverPagination('registrations', result.total ?? registrations.length, 'registrations-pagination', loadRegistrations);
  } catch {
    tableState('registrations-tbody', 5, 'Não foi possível carregar as solicitações.', loadRegistrations);
  }
}

async function openRegistrationReview(registration, action) {
  reviewingRegistration = registration;
  registrationReviewAction = action;
  if (!jobTitles.length) await loadJobTitles();
  if (!page.active) return;
  const titleSelect = document.getElementById('registration-job-title');
  clear(titleSelect).append(element('option', { value: '', text: 'Selecione um cargo' }));
  jobTitles.filter(title => title.active).forEach(title => titleSelect.append(element('option', { value: title.id, text: title.name })));
  document.getElementById('modal-registration-title').textContent = action === 'approve' ? 'Aprovar cadastro' : 'Rejeitar cadastro';
  document.getElementById('registration-summary').textContent = `${registration.name} · ${registration.email}`;
  document.getElementById('registration-contract-group').hidden = action !== 'approve';
  document.getElementById('registration-contract').value = 'clt';
  document.getElementById('registration-pj-day-group').hidden = true;
  document.getElementById('registration-pj-day').value = '';
  document.getElementById('registration-pj-day').required = false;
  document.getElementById('registration-job-title-group').hidden = action !== 'approve';
  titleSelect.required = action === 'approve';
  document.getElementById('registration-reason-group').hidden = action !== 'reject';
  document.getElementById('registration-reason').value = '';
  document.getElementById('registration-form-feedback').textContent = '';
  document.getElementById('modal-registration-save').textContent = action === 'approve' ? 'Aprovar cadastro' : 'Rejeitar cadastro';
  document.getElementById('modal-registration-save').className = action === 'approve' ? 'btn btn-primary' : 'btn btn-danger';
  openDialog(document.getElementById('modal-registration'), titleSelect);
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

function persistBulkJobId(id) {
  try {
    const key = `${BULK_JOB_STORAGE_KEY_PREFIX}${me.uid}`;
    if (id) localStorage.setItem(key, id);
    else localStorage.removeItem(key);
  } catch (_) {
    // The job remains available while this page is open when storage is unavailable.
  }
}

function renderBulkJob(job) {
  const feedback = document.getElementById('bulk-import-feedback');
  const retryable = (job.rows || []).some(row => row.status === 'failed' && row.attempt_count < 3);
  const processed = (job.invited_count || 0) + (job.failed_count || 0) + (job.ignored_count || 0);
  feedback.textContent = `Processamento: ${processed} de ${job.total_count || 0} linhas, ${job.invited_count || 0} convidados, ${job.failed_count || 0} falhas, ${job.ignored_count || 0} ignoradas e ${job.pending_count || 0} em andamento.`;
  document.getElementById('bulk-retry-button').hidden = job.status !== 'completed' || !retryable;
  const preview = clear(document.getElementById('bulk-preview'));
  preview.hidden = false;
  const table = element('table', {}, element('tbody'));
  table.querySelector('tbody').append(...(job.rows || []).map(row => {
    const errors = Array.isArray(row.validation_errors) ? row.validation_errors : [];
    const errorText = row.last_error || (errors.length ? errors.join(', ') : '');
    const label = row.status === 'invited' ? 'Convidado' : row.status === 'failed' ? `Falha${errorText ? `: ${errorText}` : ''}` : row.status === 'pending' ? 'Pendente' : row.status === 'processing' ? 'Processando' : `Ignorada${errorText ? `: ${errorText}` : ''}`;
    return element('tr', {}, [
      cell(row.row_number), cell(row.name || '—'), cell(row.email || '—'), cell(label, `badge ${row.status === 'invited' ? 'badge-green' : row.status === 'failed' ? 'badge-gray' : 'badge-gray'}`),
    ]);
  }));
  preview.append(element('div', { className: 'table-wrapper' }, table));
}

async function pollBulkJob(jobId = bulkJobId) {
  if (!jobId) return;
  const feedback = document.getElementById('bulk-import-feedback');
  try {
    const job = await fetchAPI(`/api/users/bulk/${encodeURIComponent(jobId)}`);
    if (jobId !== bulkJobId) return;
    renderBulkJob(job);
    if (job.status !== 'completed') return setTimeout(() => pollBulkJob(jobId), 3000);
    await loadUsers();
  } catch (error) {
    feedback.textContent = `Não foi possível consultar o processamento: ${error.message}`;
    if (error.status === 404 || error.status === 410) {
      bulkJobId = null;
      persistBulkJobId(null);
    }
  }
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
    bulkJobId = job.id;
    persistBulkJobId(bulkJobId);
    document.getElementById('bulk-import-panel').hidden = false;
    feedback.textContent = job.status === 'completed' ? 'Importação concluída; nenhuma linha estava pronta.' : 'Importação enfileirada.';
    document.getElementById('bulk-confirm-button').disabled = true;
    pollBulkJob(bulkJobId);
  } catch (error) { feedback.textContent = error.message; }
});
document.getElementById('bulk-retry-button').addEventListener('click', async () => {
  try {
    const job = await fetchAPI(`/api/users/bulk/${encodeURIComponent(bulkJobId)}/retry`, { method: 'POST' });
    document.getElementById('bulk-retry-button').hidden = true;
    document.getElementById('bulk-import-feedback').textContent = job.retried ? 'Falhas elegíveis reenfileiradas.' : 'Não há falhas elegíveis para tentar novamente.';
    pollBulkJob(bulkJobId);
  }
  catch (error) {
    if (error.status === 404 || error.status === 410) {
      bulkJobId = null;
      persistBulkJobId(null);
    }
    document.getElementById('bulk-import-feedback').textContent = error.message;
  }
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
    const result = await fetchAPI(editingUserId ? `/api/users/${encodeURIComponent(editingUserId)}` : '/api/users', {
      method: editingUserId ? 'PUT' : 'POST', body: JSON.stringify(data),
    });
    closeDialog(document.getElementById('modal-user'), true);
    showToast(isInvite
      ? result?.invitation?.state === 'accepted_by_smtp'
        ? 'Convite encaminhado ao serviço de e-mail. Confirme o recebimento na caixa de entrada.'
        : 'Conta criada. Confirme o recebimento do convite na caixa de entrada.'
      : 'Usuário atualizado.');
    await loadUsers();
  } catch (error) {
    feedback.style.color = 'var(--danger)';
    feedback.textContent = error.reason === 'firebase_identity_referenced'
      ? 'Este e-mail pertence a um cadastro pendente. Resolva a solicitação antes de enviar outro convite.'
      : error.reason === 'firebase_cleanup_pending'
        ? 'A limpeza desta identidade ainda está pendente. Tente novamente após a reconciliação.'
        : error.reason === 'firebase_identity_indeterminate'
          ? 'Não foi possível confirmar a identidade Firebase. Tente novamente em instantes.'
          : error.status === 409
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
  if (!isPJ) document.getElementById('u-pjday').value = '';
});
document.getElementById('registration-contract').addEventListener('change', event => {
  const isPJ = event.target.value === 'pj';
  document.getElementById('registration-pj-day-group').hidden = !isPJ;
  document.getElementById('registration-pj-day').required = isPJ;
  if (!isPJ) document.getElementById('registration-pj-day').value = '';
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
    document.getElementById('solides-link-form').reset();
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
        page_access: {
          autocard: document.getElementById('job-title-autocard').checked,
          posCards: document.getElementById('job-title-pos-cards').checked,
        },
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
document.getElementById('registration-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity() || !reviewingRegistration) return;
  const save = document.getElementById('modal-registration-save');
  const feedback = document.getElementById('registration-form-feedback');
  save.disabled = true;
  feedback.textContent = '';
  const endpoint = registrationReviewAction === 'approve'
    ? `/api/registrations/${encodeURIComponent(reviewingRegistration.id)}/approve`
    : `/api/registrations/${encodeURIComponent(reviewingRegistration.id)}/reject`;
  const body = registrationReviewAction === 'approve'
    ? {
      job_title_id: document.getElementById('registration-job-title').value,
      contract_type: document.getElementById('registration-contract').value,
      pj_due_day: document.getElementById('registration-contract').value === 'pj'
        ? Number(document.getElementById('registration-pj-day').value) : null,
    }
    : { reason: document.getElementById('registration-reason').value.trim() || null };
  try {
    const result = await fetchAPI(endpoint, { method: 'POST', body: JSON.stringify(body) });
    closeDialog(document.getElementById('modal-registration'), true);
    showToast(registrationReviewAction === 'approve'
      ? result?.state === 'enable_pending' ? 'Cadastro aprovado; habilitação pendente.' : 'Cadastro aprovado e ativo.'
      : result?.state === 'cleanup_pending' ? 'Rejeição registrada; limpeza pendente.' : 'Cadastro rejeitado.');
    reviewingRegistration = null;
    await loadRegistrations();
  } catch (error) {
    feedback.textContent = error.status === 409 ? 'Esta solicitação já foi analisada.' : error.status === 400
      ? 'Informe um contrato válido, o dia PJ quando aplicável e um cargo ativo.' : `Não foi possível concluir: ${error.message}`;
  } finally {
    save.disabled = false;
  }
});
document.getElementById('btn-new-course').addEventListener('click', () => courseDialog());
document.getElementById('btn-new-benefit').addEventListener('click', () => benefitDialog());
[['user', 'modal-user'], ['registration', 'modal-registration'], ['course', 'modal-course'], ['benefit', 'modal-benefit']].forEach(([name, modalId]) => {
  setDialogCloseGuard(document.getElementById(modalId), () => !page.busy);
  document.getElementById(`${modalId}-close`).addEventListener('click', () => closeDialog(document.getElementById(modalId)));
  document.getElementById(`${modalId}-cancel`).addEventListener('click', () => closeDialog(document.getElementById(modalId)));
});
page.listen(window, 'popstate', () => {
  const requested = new URLSearchParams(location.search).get('tab');
  if (document.getElementById(`tab-${requested}`)) switchTab(requested);
});
buildTabs();
if (can(me, 'manageUsers') && activeTab !== 'job-titles') void loadJobTitles();
void discoverAdminFeatures().then(() => { if (page.active) buildTabs(); });
try {
  const savedJobId = localStorage.getItem(`${BULK_JOB_STORAGE_KEY_PREFIX}${me.uid}`);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(savedJobId || '')) {
    bulkJobId = savedJobId;
    document.getElementById('bulk-import-panel').hidden = false;
    pollBulkJob(bulkJobId);
  }
} catch (_) {
  // A reload still keeps the current job in memory when storage is unavailable.
}
}
