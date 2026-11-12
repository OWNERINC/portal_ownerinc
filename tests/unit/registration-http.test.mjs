import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistrationApiHarness, registrationData, registrationId, jobTitleId } from '../helpers/registration-api-harness.mjs';

const approve = { job_title_id: jobTitleId, contract_type: 'clt' };
const approvalPath = `/api/registrations/${registrationId}/approve`;
const accepted = { status: 'accepted', state: 'received' };

test('HTTP journey: chosen password, no verification, blocked before approval, admitted afterwards', async t => {
  const h = await createRegistrationApiHarness(t);
  let result = await h.http('/api/auth/register', registrationData);
  assert.deepEqual(result, { status: 202, body: accepted });
  assert.equal(h.state.identity.password, registrationData.password);
  assert.equal(h.state.identity.disabled, true);
  assert.equal(h.state.identity.emailVerified, false);
  assert.equal(h.calls.mail.length, 0);
  assert.doesNotMatch(JSON.stringify(h.calls.sql), /senha com espaços/);
  result = await h.http('/api/users/me', null, 'employee-fixture');
  assert.equal(result.status, 403);
  assert.equal(result.body.reason, 'pending-approval');

  const reads = h.calls.firebase.length;
  result = await h.http('/api/registrations', null, 'admin-fixture');
  assert.equal(result.status, 200);
  assert.equal(result.body[0].state, 'pending_approval');
  assert.equal(result.body[0].state_label, 'Pendente de aprovação');
  assert.equal(result.body[0].firebase_uid, undefined);
  assert.equal(h.calls.firebase.slice(reads).some(call => call.method === 'getUser'), false);
  assert.equal((await h.http('/api/registrations', null, 'reader-fixture')).status, 403);
  assert.equal((await h.http(approvalPath, approve, 'reader-fixture')).status, 403);
  h.state.titleActive = false;
  assert.equal((await h.http(approvalPath, approve, 'admin-fixture')).status, 400);
  h.state.titleActive = true;
  assert.equal((await h.http(approvalPath, { ...approve, contract_type: 'pj' }, 'admin-fixture')).status, 400);
  result = await h.http(approvalPath, approve, 'admin-fixture');
  assert.deepEqual(result, { status: 200, body: { status: 'approved', state: 'active' } });
  assert.equal(h.state.identity.password, registrationData.password);
  assert.equal(h.state.identity.emailVerified, false);
  assert.equal(h.state.identity.disabled, false);
  assert.equal(h.state.user.role, 'viewer');
  assert.deepEqual(h.state.user.permissions, {});
  assert.equal((await h.http('/api/users/me', null, 'employee-fixture')).status, 200);
  assert.deepEqual(h.calls.firebase.filter(call => call.method === 'updateUser').map(call => call.data), [{ disabled: false }]);
  assert.equal((await h.http(approvalPath, approve, 'admin-fixture')).status, 409);
});

test('HTTP registration rejects missing passwords and privileged fields; caps IP requests', async t => {
  const h = await createRegistrationApiHarness(t);
  for (const body of [{ name: 'Pessoa', email: registrationData.email }, { ...registrationData, role: 'admin' }, { ...registrationData, password: ' '.repeat(12) }]) {
    assert.equal((await h.http('/api/auth/register', body)).status, 400);
  }
  assert.equal(h.calls.firebase.length, 0);
  assert.equal((await h.http('/api/auth/register', registrationData)).status, 202);
  assert.equal((await h.http('/api/auth/register', registrationData)).status, 202);
  assert.equal((await h.http('/api/auth/register', registrationData)).status, 429);
});

test('HTTP repetition never changes pending password/name/age or reopens approval/rejection', async t => {
  const h = await createRegistrationApiHarness(t);
  await h.http('/api/auth/register', registrationData);
  const original = { ...h.state.registration };
  const repeat = { ...registrationData, name: 'Outra Pessoa', password: 'outra senha escolhida' };
  assert.deepEqual(await h.http('/api/auth/register', repeat), { status: 202, body: accepted });
  assert.deepEqual(h.state.registration, original);
  assert.equal(h.state.identity.password, registrationData.password);
  for (const status of ['approved', 'rejected']) {
    h.state.registration.status = status;
    assert.equal((await h.http('/api/auth/register', repeat)).status, 202);
    assert.equal(h.state.registration.status, status);
  }
  assert.equal(h.calls.mail.length, 0);
  assert.equal(h.calls.firebase.some(call => call.method === 'updateUser'), false);
});

test('HTTP registration rate window and operation cap return controlled failures', async t => {
  const h = await createRegistrationApiHarness(t);
  h.state.hourlyCount = 100000;
  assert.equal((await h.http('/api/auth/register', registrationData)).status, 429);
  let releaseFirst;
  let releaseSecond;
  const first = h.service.withRegistrationOperation(() => new Promise(resolve => { releaseFirst = resolve; }));
  const second = h.service.withRegistrationOperation(() => new Promise(resolve => { releaseSecond = resolve; }));
  try {
    assert.equal((await h.http('/api/auth/register', registrationData)).status, 503);
  } finally {
    releaseFirst(); releaseSecond();
    await Promise.all([first, second]);
  }
});

test('HTTP resubmission reconstructs a missing pending identity before attempting any duplicate insert', async t => {
  const h = await createRegistrationApiHarness(t);
  await h.http('/api/auth/register', registrationData);
  h.state.registration.firebase_uid = 'missing-fixture';
  h.state.identity = null;
  const original = { ...h.state.registration };
  const password = '  senha da nova tentativa  ';
  const result = await h.http('/api/auth/register', { ...registrationData, name: 'Outro Nome', password });
  assert.deepEqual(result, { status: 202, body: accepted });
  assert.equal(h.state.identity.password, password);
  assert.equal(h.state.identity.disabled, true);
  assert.deepEqual(h.state.registration, { ...original, firebase_uid: 'employee-fixture' });
  assert.equal(h.calls.sql.filter(call => call.sql.startsWith('INSERT INTO pending_registrations')).length, 1);
  h.state.registration.status = 'rejected';
  h.state.identity = null;
  assert.equal((await h.http('/api/auth/register', registrationData)).status, 202);
  assert.equal(h.state.identity, null);
  assert.equal(h.state.registration.status, 'rejected');
});

test('HTTP SQL failure compensates only after rollback and never exposes the password', async t => {
  const h = await createRegistrationApiHarness(t);
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args);
  t.after(() => { console.error = originalError; });
  h.state.failSql = sql => sql.startsWith('INSERT INTO pending_registrations');
  const result = await h.http('/api/auth/register', registrationData);
  assert.equal(result.status, 503);
  assert.equal(h.state.identity, null);
  assert.ok(h.calls.sql.some(call => call.sql === 'ROLLBACK'));
  assert.ok(h.calls.firebase.some(call => call.method === 'deleteUser'));
  assert.equal((await h.http('/probe/error', {})).status, 500);
  assert.doesNotMatch(JSON.stringify([logs, result]), /senha com espaços/);
});

test('HTTP ambiguous registration commit queues cleanup without deleting a potentially admitted identity', async t => {
  const h = await createRegistrationApiHarness(t);
  h.state.failCommit = true;
  assert.equal((await h.http('/api/auth/register', registrationData)).status, 503);
  assert.equal(h.state.cleanup, true);
  assert.ok(h.state.identity);
  assert.equal(h.calls.firebase.some(call => call.method === 'deleteUser'), false);
  assert.ok(h.calls.releases.includes(true));
});

test('HTTP provider failure never logs arbitrary error messages or error codes containing a password', async t => {
  const h = await createRegistrationApiHarness(t);
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args);
  t.after(() => { console.error = originalError; });
  h.state.failCreate = Object.assign(new Error(registrationData.password), { code: registrationData.password });
  const result = await h.http('/api/auth/register', registrationData);
  assert.equal(result.status, 503);
  assert.doesNotMatch(JSON.stringify([logs, result, h.calls.sql, h.calls.mail]), /senha com espaços/);
  assert.ok(JSON.stringify(logs).includes('pending_registration_failed'));
});

test('HTTP enable failure keeps approval but blocks admission until reconciliation', async t => {
  const h = await createRegistrationApiHarness(t);
  await h.http('/api/auth/register', registrationData);
  h.state.failEnable = true;
  assert.equal((await h.http(approvalPath, approve, 'admin-fixture')).body.state, 'enable_pending');
  assert.equal(h.state.user.firebase_enable_pending, true);
  const result = await h.http('/api/users/me', null, 'employee-fixture');
  assert.equal(result.status, 403);
  assert.equal(result.body.reason, 'enable-pending');
});

test('HTTP password recovery handles active unverified and legacy pending without enabling them', async t => {
  const h = await createRegistrationApiHarness(t);
  await h.http('/api/auth/register', registrationData);
  for (const route of ['/api/auth/password-reset', '/api/auth/registration-password']) {
    assert.deepEqual(await h.http(route, { email: registrationData.email }), { status: 202, body: { status: 'accepted' } });
    assert.equal(h.calls.mail.at(-1).kind, 'pending');
    assert.equal(h.state.identity.disabled, true);
  }
  assert.equal(h.calls.firebase.some(call => call.method === 'updateUser'), false);
  await h.http(approvalPath, approve, 'admin-fixture');
  assert.equal((await h.http('/api/auth/password-reset', { email: registrationData.email })).status, 202);
  assert.equal(h.calls.mail.at(-1).kind, 'active');
  assert.equal(h.state.identity.emailVerified, false);
});

test('HTTP password recovery is generic for nonexistent accounts', async t => {
  const h = await createRegistrationApiHarness(t);
  assert.deepEqual(await h.http('/api/auth/password-reset', { email: registrationData.email }), { status: 202, body: { status: 'accepted' } });
  assert.equal(h.calls.mail.length, 0);
});

test('HTTP password recovery is generic for rejected, cleanup, disabled, incomplete and failed SMTP', async t => {
  const h = await createRegistrationApiHarness(t);
  await h.http('/api/auth/register', registrationData);
  for (const change of [
    () => { h.state.registration.status = 'rejected'; },
    () => { h.state.registration.status = 'pending'; h.state.cleanup = true; },
    () => { h.state.cleanup = false; h.state.user = { uid: 'employee-fixture', permissions: { accountDisabled: true } }; },
    () => { h.state.identity.disabled = false; h.state.user.permissions = { accountDisabled: 'true' }; },
    () => { h.state.user.permissions = {}; h.state.user.firebase_enable_pending = true; },
  ]) {
    change();
    const result = await h.http('/api/auth/password-reset', { email: registrationData.email });
    assert.deepEqual(result, { status: 202, body: { status: 'accepted' } });
    assert.equal(h.calls.mail.length, 0);
  }
  h.state.user = null;
  h.state.identity.disabled = true;
  h.state.failMail = true;
  assert.equal((await h.http('/api/auth/registration-password', { email: registrationData.email })).status, 202);
  assert.equal(h.calls.mail.length, 0);
});
