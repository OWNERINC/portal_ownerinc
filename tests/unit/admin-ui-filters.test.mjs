import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminUIHarness, drain, manager, superadmin, titleFixtures, titleId, TestEvent } from '../helpers/admin-ui-harness.mjs';

const account = (overrides = {}) => ({ uid: 'target', name: 'Pessoa de teste', email: 'person@example.test', role: 'viewer', permissions: {}, ...overrides });
const event = (overrides = {}) => ({ created_at: '2026-09-29T01:30:00Z', actor_name: 'Nome atual', action: 'user.update', target_type: 'user', target_id: 'target', request_id: 'request-fixture', ...overrides });
const query = request => Object.fromEntries(new URL(request.path, 'https://portal.test').searchParams);
const button = (root, text) => [...root.querySelectorAll('button')].find(node => node.textContent === text);
const listCases = [
  { key: 'users', tab: 'users', endpoint: '/api/users?', tbody: 'users-tbody', pager: 'users-pagination', data: name => [account({ name })] },
  { key: 'titles', tab: 'job-titles', endpoint: '/api/job-titles?all=true&limit=50', tbody: 'job-titles-tbody', pager: 'job-titles-pagination', data: name => [{ id: titleId(1), name, active: true }] },
  { key: 'audit', tab: 'users', endpoint: '/api/users/audit?', tbody: 'audit-tbody', pager: 'audit-pagination', data: name => [event({ actor_name: name })] },
];

test('real admin markup mounts through the router with direct namespaced filters and independent totals', async t => {
  const h = await createAdminUIHarness(t, { user: superadmin, search: `?tab=users&users_q=50%25_%5C&users_role=admin&users_state=disabled&users_job_title_id=${titleId(104)}&users_page=2&titles_q=Outro&titles_active=false&titles_page=3&audit_action=new.action&audit_from=2018-11-04&audit_to=2018-11-04&audit_page=2#main-content` });
  assert.ok(h.page?.active);
  assert.deepEqual(query(h.latest('/api/users?')), { limit: '50', offset: '50', q: '50%_\\', role: 'admin', state: 'disabled', job_title_id: titleId(104) });
  assert.deepEqual(query(h.latest('/api/users/audit?')), { limit: '50', offset: '50', action: 'new.action', from: '2018-11-04', to: '2018-11-04' });
  assert.equal(h.node('users-job-title-id').value, titleId(104), 'URL ID exists even before catalog resolution');
  await h.resolve(h.latest('/api/users?'), [account()], 55);
  assert.match(h.node('users-pagination').textContent, /Página 2 de 2 · 55 resultados/);
  await h.resolve(h.latest('/api/users/audit?'), [event()], 151);
  assert.match(h.node('audit-pagination').textContent, /Página 2 de 4 · 151 resultados/);
  await h.catalog();
  assert.equal(h.node('users-job-title-id').value, titleId(104));
  assert.match(h.node('users-job-title-id').textContent, /Cargo 104 \(inativo\)/);
  await h.click('tab-job-titles');
  assert.deepEqual(query(h.latest('/api/job-titles?all=true&limit=50')), { all: 'true', limit: '50', offset: '100', q: 'Outro', active: 'false' });
  assert.equal(h.node('titles-q').value, 'Outro');
  assert.equal(h.location.hash, '#main-content');
  assert.equal(typeof h.history.state.portalNavigation, 'number');
});

for (const [id, value, expected] of [
  ['users-q', '  %_\\nome  ', { q: '%_\\nome' }], ['users-role', 'viewer', { role: 'viewer' }],
  ['users-state', 'enable_pending', { state: 'enable_pending' }], ['users-job-title-id', titleId(105), { job_title_id: titleId(105) }],
]) test(`isolated ${id} applies server-side and omits empty filters`, async t => {
  const h = await createAdminUIHarness(t); await h.catalog();
  await h.submit('users-filters', { [id]: value });
  assert.deepEqual(query(h.latest('/api/users?')), { limit: '50', offset: '0', ...expected });
  assert.equal(h.node(id).getAttribute('aria-invalid'), null);
  assert.equal(h.node('users-filters').querySelectorAll('button').some(item => item.disabled), false);
});

for (const c of listCases) {
  test(`${c.key}: apply/reset/page/back/forward restore same-tab controls and only their namespace`, async t => {
    const h = await createAdminUIHarness(t, { user: superadmin, search: `?tab=${c.tab}&users_page=2&titles_page=2&audit_page=2` });
    const field = `${c.key}-${c.key === 'audit' ? 'action' : 'q'}`;
    await h.submit(`${c.key}-filters`, { [field]: 'literal_%' });
    assert.equal(query(h.latest(c.endpoint)).offset, '0');
    for (const other of listCases.filter(item => item.key !== c.key)) assert.equal(new URL(h.location.href).searchParams.get(`${other.key}_page`), '2');
    await h.resolve(h.latest(c.endpoint), c.data('Página um'), 105);
    button(h.node(c.pager), 'Próxima').click(); await drain();
    assert.equal(query(h.latest(c.endpoint)).offset, '50');
    await h.resolve(h.latest(c.endpoint), c.data('Página dois'), 105);
    await h.click(`${c.key}-clear`);
    assert.equal(h.node(field).value, '');
    assert.equal(query(h.latest(c.endpoint)).offset, '0');
    await h.back();
    assert.equal(h.node(field).value, 'literal_%');
    assert.equal(query(h.latest(c.endpoint)).offset, '50');
    await h.resolve(h.latest(c.endpoint), c.data('Restaurado'), 105);
    assert.match(h.node(c.tbody).textContent, /Restaurado/);
    await h.back(); assert.equal(query(h.latest(c.endpoint)).offset, '0');
    await h.forward(); assert.equal(query(h.latest(c.endpoint)).offset, '50');
    assert.equal(h.mounts.length, 1, 'same-tab traversal never remounts the panel');
    assert.equal(typeof h.history.state.portalNavigation, 'number');
  });

  for (const late of ['success', 'error']) test(`${c.key}: late ${late}, old pagination/retry and disposal cannot overwrite the current list`, async t => {
    const h = await createAdminUIHarness(t, { user: superadmin, search: `?tab=${c.tab}` });
    const first = h.latest(c.endpoint);
    await h.resolve(first, c.data('Original'), 105);
    const oldNext = button(h.node(c.pager), 'Próxima');
    const oldRow = button(h.node(c.tbody), 'Editar');
    const field = `${c.key}-${c.key === 'audit' ? 'action' : 'q'}`;
    await h.submit(`${c.key}-filters`, { [field]: 'antigo' }); const old = h.latest(c.endpoint);
    assert.equal(h.node(c.tbody).querySelectorAll('button').length, 0, 'old actions removed during fetch');
    assert.equal(h.node(c.tbody).getAttribute('aria-busy'), 'true');
    await h.submit(`${c.key}-filters`, { [field]: 'atual' }); const current = h.latest(c.endpoint);
    const count = h.requests.length; oldNext.click(); oldRow?.click(); await drain();
    assert.equal(h.requests.length, count);
    if (late === 'success') await h.resolve(old, c.data('Obsoleto'), 999);
    else await h.reject(old);
    assert.equal(h.node(c.tbody).getAttribute('aria-busy'), 'true', 'old finally cannot release current loading');
    await h.reject(current);
    const retry = button(h.node(c.tbody), 'Tentar novamente'); assert.ok(retry);
    retry.click(); await drain(); const retried = h.latest(c.endpoint);
    await h.resolve(retried, c.data('Atual'), 51);
    const after = h.requests.length; retry.click(); oldNext.click(); await drain(); assert.equal(h.requests.length, after);
    assert.match(h.node(c.tbody).textContent, /Atual/);
    assert.match(h.node(c.pager).textContent, /51 resultados/);
    await h.submit(`${c.key}-filters`, { [field]: 'antigo2' }); const older = h.latest(c.endpoint);
    await h.submit(`${c.key}-filters`, { [field]: 'atual2' });
    await h.resolve(h.latest(c.endpoint), c.data('Mais recente'), 25);
    if (late === 'success') await h.resolve(older, c.data('Obsoleto tardio'), 999);
    else await h.reject(older);
    assert.match(h.node(c.tbody).textContent, /Mais recente/);
    assert.doesNotMatch(h.node(c.tbody).textContent, /Obsoleto|Não foi possível/);
    assert.match(h.node(c.pager).textContent, /25 resultados/);
    await h.submit(`${c.key}-filters`, { [field]: 'descarte' }); const disposed = h.latest(c.endpoint);
    const text = h.node(c.tbody).textContent; h.page.dispose();
    await h.resolve(disposed, c.data('Não renderizar'), 1);
    assert.equal(h.node(c.tbody).textContent, text);
  });

  test(`${c.key}: an empty removed page recovers the last valid page exactly once`, async t => {
    const h = await createAdminUIHarness(t, { user: superadmin, search: `?tab=${c.tab}&${c.key}_page=9` });
    await h.resolve(h.latest(c.endpoint), [], 55);
    assert.equal(query(h.latest(c.endpoint)).offset, '50');
    await h.resolve(h.latest(c.endpoint), [], 0);
    assert.equal(h.requests.filter(item => item.path.startsWith(c.endpoint)).length, 2);
    assert.match(h.node(c.tbody).textContent, /Nenhum resultado/);
    assert.equal(new URL(h.location.href).searchParams.get(`${c.key}_page`), null);
    assert.match(h.node(c.pager).textContent, /Página 1 de 1/);
  });
}

test('malformed direct query is normalized without duplicate, structured or out-of-range API parameters', async t => {
  const h = await createAdminUIHarness(t, { user: superadmin, search: '?tab=users&users_q=a&users_q=b&users_role[]=admin&users_state=invalid&users_job_title_id=oops&users_page=Infinity&titles_page=-2&titles_active=x&audit_action[]=x&audit_from=2026-02-30&audit_to=0000-01-01&audit_page=20002&unrelated=keep' });
  assert.deepEqual(query(h.latest('/api/users?')), { limit: '50', offset: '0' });
  assert.deepEqual(query(h.latest('/api/users/audit?')), { limit: '50', offset: '0' });
  assert.equal(h.location.search, '?tab=users&unrelated=keep');
  assert.equal(h.node('users-role').value, '');
});

test('audit validates actual civil dates and order, accepts unknown exact actions and renders safe current actors in São Paulo', async t => {
  const h = await createAdminUIHarness(t, { user: superadmin });
  const count = h.requests.length;
  for (const fields of [
    { 'audit-from': '2026-02-30', 'audit-to': '' },
    { 'audit-from': '1900-02-29', 'audit-to': '' },
    { 'audit-from': '0000-01-01', 'audit-to': '' },
    { 'audit-from': '2026-09-30', 'audit-to': '2026-09-29' },
  ]) {
    await h.submit('audit-filters', fields);
    assert.equal(h.requests.length, count);
    assert.ok(h.node('audit-from-error').textContent || h.node('audit-to-error').textContent);
  }
  await h.submit('audit-filters', { 'audit-action': 'new.unrecognized_action', 'audit-from': '2000-02-29', 'audit-to': '2000-02-29' });
  assert.deepEqual(query(h.latest('/api/users/audit?')), { limit: '50', offset: '0', action: 'new.unrecognized_action', from: '2000-02-29', to: '2000-02-29' });
  await h.resolve(h.latest('/api/users/audit?'), [event({ actor_name: '<img src=x onerror=alert(1)>', action: 'new.unrecognized_action' }), event({ actor_name: null }), event({ action: 'constructor', created_at: '2018-11-04T03:30:00Z' })]);
  const text = h.node('audit-tbody').textContent;
  assert.match(text, /28\/09\/2026.*22:30/);
  assert.match(text, /<img src=x onerror=alert\(1\)>/);
  assert.match(text, /Sistema ou conta removida/);
  assert.match(text, /Ação administrativa · new.unrecognized_action/);
  assert.match(text, /Usuário atualizado · user.update/);
  assert.match(text, /Ação administrativa · constructor/);
  assert.match(text, /04\/11\/2018.*01:30/);
  assert.match(text, /request-fixture/);
  assert.equal(h.node('audit-tbody').querySelector('img'), null);
});

test('CSV field label and descriptions cover UTF-8, columns, examples, limit and preview without changing the preview ticket', async t => {
  const h = await createAdminUIHarness(t);
  assert.equal(h.doc.querySelector('label[for="bulk-csv"]').textContent, 'Arquivo CSV de convites');
  const help = h.node('bulk-csv').getAttribute('aria-describedby').split(' ').map(id => h.node(id).textContent).join(' ');
  for (const word of ['UTF-8', '500', 'Pré-visualize', 'name', 'email', 'job_title', 'contract_type', 'pj_due_day', 'phone', 'remova as duas linhas']) assert.ok(help.includes(word), word);
  h.node('bulk-csv').files = [{ text: async () => 'name,email' }];
  h.node('bulk-csv').dispatchEvent(new TestEvent('change'));
  await h.click('bulk-preview-button'); const old = h.latest('/api/users/bulk/preview');
  h.node('bulk-csv').files = [{ text: async () => 'different' }]; h.node('bulk-csv').dispatchEvent(new TestEvent('change'));
  old.resolve({ total: 1, ready: 1, rows: [{ row_number: 1, name: 'Obsoleto', status: 'ready' }] }); await drain();
  assert.equal(h.node('bulk-confirm-button').disabled, true);
  assert.equal(h.node('bulk-preview').hidden, true);
});

test('invalid and overlong form values have associated errors and never issue a request', async t => {
  const h = await createAdminUIHarness(t, { user: superadmin });
  for (const [key, field, value] of [['users', 'q', 'x'.repeat(201)], ['titles', 'q', 'x'.repeat(201)], ['audit', 'action', 'x'.repeat(121)]]) {
    const count = h.requests.length;
    await h.submit(`${key}-filters`, { [`${key}-${field}`]: value });
    const input = h.node(`${key}-${field}`);
    assert.equal(h.requests.length, count);
    assert.equal(input.getAttribute('aria-invalid'), 'true');
    assert.equal(input.getAttribute('aria-describedby'), `${key}-${field}-error`);
    assert.ok(h.node(`${key}-${field}-error`).textContent);
    assert.equal(h.doc.activeElement, input);
  }
  h.node('audit-action').value = '';
  h.node('audit-from').validity = { badInput: true };
  const count = h.requests.length; await h.submit('audit-filters');
  assert.equal(h.requests.length, count);
  assert.equal(h.node('audit-from').getAttribute('aria-invalid'), 'true');
});

test('zero totals, stable removed-page recovery and reload preserve the server count and selected URL', async t => {
  const h = await createAdminUIHarness(t, { search: '?tab=users&users_q=teste&users_page=8' });
  await h.resolve(h.latest('/api/users?'), [], 55);
  assert.equal(query(h.latest('/api/users?')).offset, '50');
  await h.resolve(h.latest('/api/users?'), [account()], 55);
  assert.match(h.node('users-pagination').textContent, /Página 2 de 2 · 55 resultados/);
  const reloaded = await createAdminUIHarness(t, { search: h.location.search });
  assert.deepEqual(query(reloaded.latest('/api/users?')), query(h.latest('/api/users?')));
  assert.equal(reloaded.node('users-q').value, 'teste');
  await reloaded.resolve(reloaded.latest('/api/users?'), [], 0);
  await reloaded.resolve(reloaded.latest('/api/users?'), [], 0);
  assert.match(reloaded.node('users-pagination').textContent, /Página 1 de 1 · 0 resultados/);
});

test('users and audit requests remain independent while both filters are changed and settled in reverse order', async t => {
  const h = await createAdminUIHarness(t, { user: superadmin });
  await h.submit('users-filters', { 'users-q': 'User query', 'users-role': 'admin', 'users-state': 'active' });
  const users = h.latest('/api/users?');
  await h.submit('audit-filters', { 'audit-action': 'job_title.update', 'audit-from': '0001-01-01', 'audit-to': '9999-12-31' });
  const audit = h.latest('/api/users/audit?');
  await h.resolve(audit, [event()], 102);
  await h.resolve(users, [account({ name: 'User query result' })], 58);
  assert.match(h.node('users-tbody').textContent, /User query result/);
  assert.match(h.node('audit-tbody').textContent, /Nome atual/);
  assert.match(h.node('users-pagination').textContent, /58 resultados/);
  assert.match(h.node('audit-pagination').textContent, /102 resultados/);
  assert.equal(new URL(h.location.href).searchParams.get('users_q'), 'User query');
  assert.equal(new URL(h.location.href).searchParams.get('audit_action'), 'job_title.update');
});

test('same-path links without a tab or with an invalid tab still reload the normalized selected section', async t => {
  const h = await createAdminUIHarness(t);
  await h.resolve(h.latest('/api/users?'), [account({ name: 'Antes' })]);
  // Use the real router's link listener, not a synthetic pop callback.
  for (const tab of ['', '&tab=not-allowed']) {
    const anchor = h.doc.createElement('a'); anchor.setAttribute('href', `https://portal.test/admin.html?users_q=Depois${tab}`);
    h.doc.dispatchEvent(new TestEvent('click', { target: anchor })); await drain();
    assert.equal(query(h.latest('/api/users?')).q, 'Depois');
    assert.equal(h.node('users-q').value, 'Depois');
    assert.equal(new URL(h.location.href).searchParams.get('tab'), 'users');
    await h.resolve(h.latest('/api/users?'), [account({ name: 'Depois' })]);
    assert.match(h.node('users-tbody').textContent, /Depois/);
  }
});
