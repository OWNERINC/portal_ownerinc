import assert from 'node:assert/strict';
import { request } from 'node:http';
import test from 'node:test';
import { createRegistrationApiHarness, registrationData, registrationId, jobTitleId } from '../helpers/registration-api-harness.mjs';
import { deadline } from '../helpers/readiness-harness.mjs';

const approve = { job_title_id: jobTitleId, contract_type: 'clt' };
const approvalPath = `/api/registrations/${registrationId}/approve`;
const accepted = { status: 'accepted', state: 'received' };

function configure(t, values) {
  for (const [name, value] of Object.entries(values)) {
    const original = process.env[name];
    if (value === null) delete process.env[name];
    else process.env[name] = value;
    t.after(() => {
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    });
  }
}

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
  const profile = await h.http('/api/users/me', null, 'employee-fixture');
  assert.equal(profile.status, 200);
  assert.equal(profile.body.ethics_accepted, false);
  const privateArea = await h.http('/api/probe-private', null, 'employee-fixture');
  assert.equal(privateArea.status, 403);
  assert.equal(privateArea.body.reason, 'ethics-required');
  h.state.user.ethics_accepted = true;
  assert.equal((await h.http('/api/probe-private', null, 'employee-fixture')).status, 200);
  assert.deepEqual(h.calls.firebase.filter(call => call.method === 'updateUser').map(call => call.data), [{ disabled: false }]);
  assert.equal((await h.http(approvalPath, approve, 'admin-fixture')).status, 409);
});

test('HTTP registration rejects invalid payloads but does not block a sixth shared-IP attempt', async t => {
  const h = await createRegistrationApiHarness(t);
  for (const body of [{ name: 'Pessoa', email: registrationData.email }, { ...registrationData, role: 'admin' }, { ...registrationData, password: ' '.repeat(12) }]) {
    assert.equal((await h.http('/api/auth/register', body)).status, 400);
  }
  assert.equal(h.calls.firebase.length, 0);
  assert.equal((await h.http('/api/auth/register', registrationData)).status, 202);
  assert.equal((await h.http('/api/auth/register', registrationData)).status, 202);
  assert.equal((await h.http('/api/auth/register', registrationData)).status, 202);
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

test('HTTP registration has no default global hourly cap', async t => {
  configure(t, { MAX_PENDING_REGISTRATIONS_PER_HOUR: null });
  const h = await createRegistrationApiHarness(t);
  h.state.hourlyCount = 100000;
  assert.equal((await h.http('/api/auth/register', registrationData)).status, 202);
  assert.equal(h.calls.sql.some(call => call.sql.includes('COUNT(*)') && call.sql.includes('pending_registrations')), false);
});

for (const value of ['0', '-1', 'invalid', '1.5', '9007199254740992']) {
  test(`HTTP global quota ${value} disables counting and the global rate lock`, async t => {
    configure(t, { MAX_PENDING_REGISTRATIONS_PER_HOUR: value });
    const h = await createRegistrationApiHarness(t);
    h.state.hourlyCount = 100000;
    assert.equal((await h.http('/api/auth/register', registrationData)).status, 202);
    assert.equal(h.calls.sql.some(call => call.sql.includes('COUNT(*)') && call.sql.includes('pending_registrations')), false);
    assert.equal(h.calls.sql.some(call => call.sql.includes('pg_advisory_xact_lock') && call.params[0] === 7192028), false);
  });
}

test('HTTP registration waits for an operation slot without acquiring a database connection', async t => {
  const h = await createRegistrationApiHarness(t);
  let releaseFirst;
  let releaseSecond;
  const first = h.service.withRegistrationOperation(() => new Promise(resolve => { releaseFirst = resolve; }));
  const second = h.service.withRegistrationOperation(() => new Promise(resolve => { releaseSecond = resolve; }));
  let settled = false;
  const waiting = h.http('/api/auth/register', registrationData).then(result => { settled = true; return result; });
  try {
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(settled, false);
    assert.equal(h.calls.connects, 0);
    assert.equal(h.calls.sql.length, 0);
    releaseFirst();
    assert.equal((await waiting).status, 202);
  } finally {
    releaseFirst(); releaseSecond();
    await Promise.all([first, second, waiting]);
  }
});

test('HTTP registration IP budget is configurable and returns Retry-After without affecting recovery', async t => {
  configure(t, { REGISTRATION_MAX_ATTEMPTS_PER_IP_PER_HOUR: '3' });
  const h = await createRegistrationApiHarness(t);
  for (let i = 0; i < 3; i++) assert.equal((await h.http('/api/auth/register', registrationData)).status, 202);
  const result = await fetch(`${h.origin}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(registrationData),
  });
  assert.equal(result.status, 429);
  const retryAfter = Number(result.headers.get('Retry-After'));
  assert.ok(retryAfter > 0 && retryAfter <= 3600);
  assert.ok((await result.json()).requestId);
  for (let i = 0; i < 5; i++) {
    assert.equal((await h.http('/api/auth/password-reset', { email: 'missing@example.test' })).status, 202);
  }
  assert.equal((await h.http('/api/auth/password-reset', { email: 'missing@example.test' })).status, 429);
});

test('HTTP optional global quota keeps its lock and returns the remaining wait', async t => {
  configure(t, { MAX_PENDING_REGISTRATIONS_PER_HOUR: '150' });
  const h = await createRegistrationApiHarness(t);
  h.state.hourlyCount = 150;
  h.state.retryAfter = 47;
  const result = await fetch(`${h.origin}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(registrationData),
  });
  assert.equal(result.status, 429);
  assert.equal(result.headers.get('Retry-After'), '47');
  assert.ok((await result.json()).requestId);
  assert.ok(h.calls.sql.some(call => call.sql.includes('pg_advisory_xact_lock') && call.params[0] === 7192028));
  assert.equal(h.calls.firebase.length, 0);
});

test('HTTP full waiting queue returns a safe busy reason and a short retry time', async t => {
  const h = await createRegistrationApiHarness(t);
  const releases = [];
  const held = [1, 2].map(() => h.service.withRegistrationOperation(() => new Promise(resolve => releases.push(resolve))));
  await new Promise(resolve => setImmediate(resolve));
  const queued = Array.from({ length: 100 }, () => h.service.withRegistrationOperation(async () => {}, { wait: true }));
  try {
    const result = await fetch(`${h.origin}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(registrationData),
    });
    assert.equal(result.status, 503);
    assert.equal(result.headers.get('Retry-After'), '5');
    const body = await result.json();
    assert.equal(body.reason, 'registration_busy');
    assert.equal(body.error, 'Internal server error.');
    assert.ok(body.requestId);
    assert.equal(h.calls.connects, 0);
  } finally {
    releases.forEach(release => release());
    await Promise.all([...held, ...queued]);
  }
});

test('HTTP disconnect cancels waiting registration before database or Firebase work', async t => {
  const h = await createRegistrationApiHarness(t);
  const releases = [];
  const held = [1, 2].map(() => h.service.withRegistrationOperation(() => new Promise(resolve => releases.push(resolve))));
  await new Promise(resolve => setImmediate(resolve));
  let started, closed;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const responseClosed = new Promise(resolve => { closed = resolve; });
  h.state.onRequest = (req, res) => {
    res.once('close', closed);
    started();
  };
  const pending = request(`${h.origin}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
  });
  pending.on('error', () => {}); // Client deliberately destroys its socket.
  pending.end(JSON.stringify(registrationData));
  try {
    await deadline(requestStarted, 'queued HTTP request must reach the API');
    pending.destroy();
    await deadline(responseClosed, 'disconnect must close the server response');
    assert.equal(h.calls.connects, 0);
    assert.equal(h.calls.firebase.length, 0);
  } finally {
    h.state.onRequest = null;
    pending.destroy();
    releases.forEach(release => release());
    await Promise.all(held);
  }
  assert.equal((await h.http('/api/auth/register', registrationData)).status, 202);
  assert.equal(h.calls.connects, 1, 'the disconnected request never runs later');
  assert.equal(h.calls.firebase.filter(call => call.method === 'createUser').length, 1);
});

test('HTTP failed registrations retain admission until rollback and client release finish', async t => {
  const h = await createRegistrationApiHarness(t);
  let allRequested, rollingBack;
  const arrived = new Promise(resolve => { allRequested = resolve; });
  const twoRollbacks = new Promise(resolve => { rollingBack = resolve; });
  let requests = 0;
  h.state.onRequest = () => { if (++requests === 6) allRequested(); };
  h.state.failSql = sql => sql.startsWith('SELECT 1 FROM users');
  const rollbacks = [];
  let delay = true;
  h.state.beforeQuery = async sql => {
    if (sql !== 'ROLLBACK' || !delay) return;
    await new Promise(resolve => {
      rollbacks.push(resolve);
      if (rollbacks.length === 2) rollingBack();
    });
  };
  const pending = Array.from({ length: 6 }, () => h.http('/api/auth/register', registrationData));
  try {
    await deadline(Promise.all([arrived, twoRollbacks]), 'all requests arrive while two rollbacks are held');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.connects, 2, 'queued requests cannot acquire connections while failed operations still own theirs');
    assert.equal(h.calls.releases.length, 0);
  } finally {
    delay = false;
    rollbacks.forEach(resolve => resolve());
    const results = await Promise.all(pending);
    assert.ok(results.every(result => result.status === 503));
  }
  assert.equal(h.calls.connects, 6);
  assert.equal(h.calls.releases.length, 6);
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
