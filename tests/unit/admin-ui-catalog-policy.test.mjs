import assert from 'node:assert/strict';
import test from 'node:test';
import { createAdminUIHarness, drain, manager, superadmin, titleFixtures, titleId, TestEvent } from '../helpers/admin-ui-harness.mjs';

const account = (overrides = {}) => ({ uid: 'target', name: 'Pessoa de teste', email: 'person@example.test', role: 'viewer', permissions: {}, ...overrides });
const button = (root, label) => [...root.querySelectorAll('button')].find(node => node.textContent === label);
const options = (h, id) => [...h.node(id).options].map(item => ({ value: item.value, label: item.textContent }));
const catalogRequests = h => h.requests.filter(item => item.path.startsWith('/api/job-titles?all=true&limit=100'));

test('invitation waits for the complete 105-title catalog, deduplicates loaders and retries without publishing a partial page', async t => {
  const h = await createAdminUIHarness(t); const titles = titleFixtures();
  await h.click('btn-new-user'); await h.click('btn-new-user');
  assert.equal(catalogRequests(h).length, 1);
  assert.equal(h.node('modal-user').classList.contains('hidden'), true);
  await h.resolve(catalogRequests(h)[0], titles.slice(0, 100), 105);
  assert.equal(options(h, 'u-job-title').length, 1);
  assert.equal(options(h, 'users-job-title-id').length, 1);
  assert.equal(h.node('modal-user').classList.contains('hidden'), true);
  await h.reject(catalogRequests(h).at(-1));
  assert.match(h.node('job-title-options-feedback').textContent, /Nenhuma opção parcial/);
  const retry = button(h.node('job-title-options-feedback'), 'Tentar novamente'); retry.click(); await drain();
  await h.catalog(titles);
  assert.equal(h.node('modal-user').classList.contains('hidden'), false);
  assert.equal(options(h, 'u-job-title').length, 105, '104 active titles plus empty selection');
  assert.ok(options(h, 'u-job-title').some(item => item.value === titleId(105)));
  assert.ok(!options(h, 'u-job-title').some(item => item.value === titleId(104)));
  assert.equal(options(h, 'users-job-title-id').length, 106, 'filter also includes inactive titles');
  assert.equal(h.node('u-role').disabled, true);
  const count = h.requests.length; retry.click(); await drain(); assert.equal(h.requests.length, count);
  await h.submit('user-form', { 'u-name': 'Convidado sintético', 'u-email': 'invite@example.test', 'u-job-title': titleId(105), 'u-contract': 'clt' });
  const invitation = h.latest('/api/users'); assert.equal(invitation.options.method, 'POST');
  assert.equal(JSON.parse(invitation.options.body).job_title_id, titleId(105));
  assert.equal('permissions' in JSON.parse(invitation.options.body), false);
  assert.equal(h.page.busy, true);
  assert.equal(h.page.canLeave(), false, 'real lifecycle still fences pending writes');
});

test('editing waits for options and includes the assigned inactive title without treating the account as disabled', async t => {
  const h = await createAdminUIHarness(t);
  await h.resolve(h.latest('/api/users?'), [account({ job_title_id: titleId(104), job_title: 'Cargo 104', job_title_active: false })]);
  const row = h.node('users-tbody').querySelector('tr');
  assert.match(row.textContent, /Cargo inativo: vínculo mantido/);
  assert.match(row.textContent, /Ativo/);
  button(row, 'Editar').click(); await drain();
  assert.equal(h.node('modal-user').classList.contains('hidden'), true);
  await h.catalog();
  assert.equal(h.node('modal-user').classList.contains('hidden'), false);
  assert.equal(h.node('u-job-title').value, titleId(104));
  assert.equal(options(h, 'u-job-title').length, 106);
  assert.match(h.node('user-job-title-help').textContent, /vínculo permanece.*conta não foi desativada/);
  await h.submit('user-form', { 'u-name': 'Nome alterado' });
  const request = h.latest('/api/users/target'); assert.equal(request.options.method, 'PUT');
  assert.equal(JSON.parse(request.options.body).job_title_id, titleId(104));
  assert.equal('role' in JSON.parse(request.options.body), false);
});

test('known missing assignment ID and label survive catalog reconciliation without silently changing the user', async t => {
  const h = await createAdminUIHarness(t);
  await h.resolve(h.latest('/api/users?'), [account({ job_title_id: titleId(999), job_title: 'Cargo legado conhecido', job_title_active: false })]);
  button(h.node('users-tbody'), 'Editar').click(); await drain(); await h.catalog();
  assert.equal(h.node('u-job-title').value, titleId(999));
  assert.ok(options(h, 'u-job-title').some(item => item.value === titleId(999) && item.label === 'Cargo legado conhecido'));
});

test('approval has every active option beyond page one; rejection does not depend on title lookup', async t => {
  const h = await createAdminUIHarness(t, { search: '?tab=registrations' });
  const registration = { id: titleId(501), name: 'Novo cadastro', email: 'registration@example.test', state: 'confirmed', created_at: '2026-09-29T12:00:00Z' };
  await h.resolve(h.latest('/api/registrations?'), [registration]);
  button(h.node('registrations-tbody'), 'Rejeitar').click(); await drain();
  assert.equal(h.node('modal-registration').classList.contains('hidden'), false);
  await h.click('modal-registration-cancel');
  button(h.node('registrations-tbody'), 'Analisar').click(); await drain();
  assert.equal(h.node('modal-registration').classList.contains('hidden'), true);
  assert.equal(catalogRequests(h).length, 1);
  await h.catalog();
  assert.equal(h.node('modal-registration').classList.contains('hidden'), false);
  assert.equal(options(h, 'registration-job-title').length, 105);
  assert.ok(options(h, 'registration-job-title').some(item => item.value === titleId(105)));
  assert.ok(!options(h, 'registration-job-title').some(item => item.value === titleId(104)));
  await h.submit('registration-form', { 'registration-job-title': titleId(105) });
  const request = h.latest(`/api/registrations/${registration.id}/approve`);
  assert.equal(JSON.parse(request.options.body).job_title_id, titleId(105));
  assert.equal(h.page.busy, true);
});

test('filtered/paginated title table never feeds forms or changes their selected options', async t => {
  const h = await createAdminUIHarness(t); await h.catalog();
  await h.click('btn-new-user');
  h.node('u-job-title').value = titleId(105);
  await h.click('modal-user-cancel');
  h.node('registration-job-title').value = titleId(101);
  h.node('users-job-title-id').value = titleId(104);
  const before = ['u-job-title', 'registration-job-title', 'users-job-title-id'].map(id => ({ id, options: options(h, id), value: h.node(id).value }));
  await h.click('tab-job-titles');
  await h.submit('titles-filters', { 'titles-q': 'Somente um', 'titles-active': 'false' });
  await h.resolve(h.latest('/api/job-titles?all=true&limit=50'), [{ id: titleId(104), name: 'Tabela filtrada', active: false }], 55);
  button(h.node('job-titles-pagination'), 'Próxima').click(); await drain();
  assert.match(h.latest('/api/job-titles?all=true&limit=50').path, /offset=50/);
  await h.resolve(h.latest('/api/job-titles?all=true&limit=50'), [{ id: titleId(999), name: 'Página isolada', active: false }], 55);
  for (const saved of before) { assert.deepEqual(options(h, saved.id), saved.options); assert.equal(h.node(saved.id).value, saved.value); }
  assert.equal(catalogRequests(h).length, 2);
});

for (const mutation of ['create', 'edit', 'toggle']) test(`title ${mutation} invalidates the complete catalog independently and preserves valid selections`, async t => {
  const h = await createAdminUIHarness(t, { search: '?tab=job-titles&titles_q=literal&titles_page=2' });
  const titles = titleFixtures(); await h.catalog(titles);
  h.node('users-job-title-id').value = titleId(104);
  h.node('u-job-title').value = titleId(105);
  h.node('registration-job-title').value = titleId(102);
  await h.resolve(h.latest('/api/job-titles?all=true&limit=50'), [titles[104]], 55);
  if (mutation === 'toggle') button(h.node('job-titles-tbody'), 'Desativar').click();
  else {
    if (mutation === 'edit') button(h.node('job-titles-tbody'), 'Editar').click();
    else await h.click('btn-new-job-title');
    await h.submit('job-title-form', { 'job-title-name': 'Cargo atualizado' });
  }
  await drain();
  const write = [...h.requests].reverse().find(item => item.options.method);
  assert.equal(write.options.method, mutation === 'create' ? 'POST' : 'PUT');
  write.resolve({ id: titleId(106) }); await drain();
  assert.equal(catalogRequests(h).length, 3);
  assert.match(h.latest('/api/job-titles?all=true&limit=50').path, /offset=50&q=literal/);
  const updated = [...titles, { id: titleId(106), name: 'Cargo novo', active: true }];
  await h.catalog(updated);
  assert.equal(options(h, 'users-job-title-id').length, 107);
  assert.equal(h.node('users-job-title-id').value, titleId(104));
  assert.equal(h.node('u-job-title').value, titleId(105));
  assert.equal(h.node('registration-job-title').value, titleId(102));
  assert.ok(options(h, 'u-job-title').some(item => item.value === titleId(106)));
});

for (const late of ['success', 'failure']) test(`old catalog ${late} cannot publish options, errors or release a newer generation`, async t => {
  const h = await createAdminUIHarness(t, { search: '?tab=job-titles' });
  const old = catalogRequests(h)[0];
  await h.click('btn-new-job-title'); await h.submit('job-title-form', { 'job-title-name': 'Nova geração' });
  h.latest('/api/job-titles').resolve({ id: titleId(1) }); await drain();
  const newer = catalogRequests(h).at(-1); assert.notEqual(newer, old);
  if (late === 'success') await h.resolve(old, [{ id: titleId(999), name: 'Obsoleto', active: true }]);
  else await h.reject(old);
  assert.match(h.node('job-title-options-feedback').textContent, /Carregando todos/);
  await h.click('tab-users'); await h.click('btn-new-user');
  assert.equal(catalogRequests(h).length, 2, 'old finally did not release the new pending promise');
  await h.catalog();
  assert.doesNotMatch(h.node('users-job-title-id').textContent, /Obsoleto/);
  assert.equal(h.node('modal-user').classList.contains('hidden'), false);
});

test('catalog failure/disposal never opens a partial editor and a tab switch cancels pending editor intent', async t => {
  const h = await createAdminUIHarness(t); await h.click('btn-new-user');
  await h.click('tab-job-titles'); await h.catalog();
  assert.equal(h.node('modal-user').classList.contains('hidden'), true);
  const other = await createAdminUIHarness(t); await other.click('btn-new-user');
  const pending = catalogRequests(other)[0], old = other.node('job-title-options-feedback').textContent;
  other.page.dispose(); await other.reject(pending);
  assert.equal(other.node('job-title-options-feedback').textContent, old);
  assert.equal(other.node('modal-user').classList.contains('hidden'), true);
  assert.equal(options(other, 'u-job-title').length, 1);
});

for (const [label, user] of [['manager', manager], ['superadmin', superadmin], ['string super flag', { ...manager, permissions: { manageUsers: true, superAdmin: 'true' } }]]) {
  test(`${label}: action matrix matches own/protected/disabled boolean policy and keeps the server authoritative`, async t => {
    const h = await createAdminUIHarness(t, { user }); await h.catalog();
    const targets = [
      account({ uid: user.uid, name: 'Própria conta', role: user.role, permissions: user.permissions }),
      account({ uid: 'super', name: 'Super protegido', role: 'admin', permissions: { superAdmin: true, accountDisabled: true } }),
      account({ uid: 'plain', name: 'Conta ativa' }),
      account({ uid: 'disabled', name: 'Conta desativada', permissions: { accountDisabled: true }, firebase_enable_pending: true }),
      account({ uid: 'string-disabled', name: 'Flag textual', permissions: { accountDisabled: 'true' }, firebase_enable_pending: true }),
      account({ uid: 'string-super', name: 'Não é super', role: 'admin', permissions: { superAdmin: 'true', accountDisabled: true } }),
      account({ uid: 'pending', name: 'Conta pendente', firebase_enable_pending: true }),
      account({ uid: 'viewer-flag', name: 'Leitor não super', role: 'viewer', permissions: { superAdmin: true, accountDisabled: true } }),
    ];
    await h.resolve(h.latest('/api/users?'), targets);
    const rows = h.node('users-tbody').querySelectorAll('tr');
    const isSuper = user.permissions.superAdmin === true;
    for (const [i, row] of rows.entries()) {
      const edit = button(row, 'Editar'), status = button(row, i === 1 || i === 3 || i === 4 || i === 5 || i === 7 ? 'Reativar' : 'Desativar'), erase = button(row, 'Anonimizar');
      assert.equal(edit.disabled, i === 1 && !isSuper);
      assert.equal(status.disabled, i === 0 || (i === 1 && !isSuper));
      if (isSuper) assert.equal(erase.disabled, ![3, 5, 7].includes(i));
      else assert.equal(erase, undefined);
      if (edit.disabled || status.disabled) {
        const explanation = h.node(status.getAttribute('aria-describedby'));
        assert.ok(explanation.textContent.includes(i === 0 ? 'própria conta' : 'Somente um superadministrador'));
        const count = h.requests.length;
        (edit.disabled ? edit : status).dispatchEvent(new TestEvent('click'));
        await drain(); assert.equal(h.requests.length, count);
      }
    }
    assert.match(rows[3].textContent, /Desativado/); assert.doesNotMatch(rows[3].textContent, /Habilitação pendente/);
    assert.match(rows[4].textContent, /Desativado/); assert.doesNotMatch(rows[4].textContent, /Habilitação pendente/);
    assert.match(rows[6].textContent, /Habilitação pendente/);
    assert.equal(h.requests.some(item => item.path.startsWith('/api/users/audit')), isSuper);
    button(rows[0], 'Editar').click(); await drain();
    assert.equal(h.node('modal-user').classList.contains('hidden'), false);
    assert.equal(h.node('u-role').disabled, true, 'own privilege fields remain locked');
    await h.submit('user-form', { 'u-name': 'Nome próprio alterado', 'u-contract': 'clt' });
    const selfWrite = h.latest(`/api/users/${user.uid}`);
    assert.equal('permissions' in JSON.parse(selfWrite.options.body), false);
    assert.equal('role' in JSON.parse(selfWrite.options.body), false);
    selfWrite.resolve({}); await drain();
    await h.resolve(h.latest('/api/users?'), targets);
    if (isSuper) {
      const protectedRow = h.node('users-tbody').querySelectorAll('tr')[1];
      button(protectedRow, 'Reativar').click(); await drain();
      assert.equal(h.latest('/api/users/super/reactivate').options.method, 'PUT', 'no last-super inference from filtered counts');
      h.latest('/api/users/super/reactivate').resolve({}); await drain();
      await h.resolve(h.latest('/api/users?'), targets);
      button(h.node('users-tbody').querySelectorAll('tr')[3], 'Anonimizar').click(); await drain();
      assert.equal(h.latest('/api/users/disabled/personal-data').options.method, 'DELETE');
      assert.match(h.confirms.at(-1), /Apagar permanentemente.*histórico operacional/);
    }
  });
}

test('without manageUsers no sensitive list/catalog requests are issued even for truthy string permissions', async t => {
  for (const permissions of [{}, { manageAcademy: true }, { manageUsers: 'true', superAdmin: 'true' }]) {
    const h = await createAdminUIHarness(t, { user: { ...manager, permissions } });
    await h.submit('users-filters', { 'users-q': 'not-authorized' });
    await h.submit('audit-filters', { 'audit-action': 'user.update' });
    assert.equal(h.requests.some(item => item.path.startsWith('/api/users') || item.path.startsWith('/api/job-titles')), false);
    assert.equal(h.node('audit-panel').hidden, true);
  }
});

test('real full mount preserves deferred Sólides intent, newer tab selection and other list loaders', async t => {
  for (const newer of [false, true]) {
    const user = { ...manager, permissions: { manageUsers: true, manageAcademy: true, manageBenefits: true, manageSolides: true } };
    const h = await createAdminUIHarness(t, { search: '?tab=solides&users_q=mantido', user });
    assert.equal(new URL(h.location.href).searchParams.get('tab'), 'solides');
    const discovery = h.latest('/api/solides/admin/status');
    if (newer) await h.click('tab-academy');
    discovery.resolve({ stage: 'fixture', links: { total: 0, verified: 0, conflicts: 0 }, pilotUsers: 0 }); await drain();
    assert.equal(new URL(h.location.href).searchParams.get('tab'), newer ? 'academy' : 'solides');
    assert.equal(h.node(newer ? 'section-academy' : 'section-solides').hidden, false);
    assert.equal(new URL(h.location.href).searchParams.get('users_q'), 'mantido');
    await h.click('tab-benefits'); assert.ok(h.latest('/api/benefits?all=true&limit=50'));
    await h.click('tab-registrations'); assert.ok(h.latest('/api/registrations?status=pending&limit=50'));
  }
});

test('catalog completion preserves an explicit unsubmitted Todos selection instead of restoring the applied cargo', async t => {
  const h = await createAdminUIHarness(t, { search: `?tab=users&users_job_title_id=${titleId(104)}` });
  assert.equal(h.node('users-job-title-id').value, titleId(104));
  h.node('users-job-title-id').value = '';
  await h.catalog();
  assert.equal(h.node('users-job-title-id').value, '');
  assert.equal(new URL(h.location.href).searchParams.get('users_job_title_id'), titleId(104), 'unsubmitted controls do not change applied filters');
});

test('an unexpectedly empty second catalog page is an incomplete load, never a successful partial catalog', async t => {
  const h = await createAdminUIHarness(t); await h.click('btn-new-user');
  await h.resolve(catalogRequests(h)[0], titleFixtures(100), 105);
  await h.resolve(catalogRequests(h).at(-1), [], 105);
  assert.match(h.node('job-title-options-feedback').textContent, /Nenhuma opção parcial/);
  assert.equal(options(h, 'u-job-title').length, 1);
  assert.equal(h.node('modal-user').classList.contains('hidden'), true);
});

test('a title becoming inactive is removed from invitation and approval but retained for its existing assigned editor', async t => {
  const h = await createAdminUIHarness(t); const titles = titleFixtures(); await h.catalog(titles);
  await h.resolve(h.latest('/api/users?'), [account({ job_title_id: titleId(105), job_title: 'Cargo 105', job_title_active: true })]);
  button(h.node('users-tbody'), 'Editar').click(); await drain(); await h.click('modal-user-cancel');
  h.node('registration-job-title').value = titleId(105);
  await h.click('tab-job-titles'); await h.resolve(h.latest('/api/job-titles?all=true&limit=50'), [titles[104]]);
  button(h.node('job-titles-tbody'), 'Desativar').click(); await drain();
  h.latest(`/api/job-titles/${titleId(105)}`).resolve({}); await drain();
  await h.catalog(titles.map(title => title.id === titleId(105) ? { ...title, active: false } : title));
  assert.equal(h.node('u-job-title').value, titleId(105), 'existing assignment remains');
  assert.equal(h.node('registration-job-title').value, '', 'new approval cannot assign inactive title');
  assert.match(h.node('user-job-title-help').textContent, /Cargo inativo/);
  await h.click('tab-users'); await h.click('btn-new-user');
  assert.ok(!options(h, 'u-job-title').some(item => item.value === titleId(105)));
});
