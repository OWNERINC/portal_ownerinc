import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistrationApiHarness, registrationData } from '../helpers/registration-api-harness.mjs';

test('recovery preserves an old pending identity, password, name and age without any email', async t => {
  const h = await createRegistrationApiHarness(t);
  await h.http('/api/auth/register', registrationData);
  const original = { ...h.state.registration };
  const start = h.calls.firebase.length;
  assert.equal(await h.service.recoverPendingRegistration({ pool: h.pool, data: { ...registrationData, name: 'Outra Pessoa', password: 'outra senha escolhida' } }), true);
  assert.deepEqual(h.state.registration, original);
  assert.equal(h.state.identity.password, registrationData.password);
  assert.equal(h.calls.firebase.slice(start).some(call => ['createUser', 'updateUser'].includes(call.method)), false);
  assert.equal(h.calls.mail.length, 0);
});

test('recovery does not adopt or delete an orphan and never reopens reviewed or cleanup-pending applications', async t => {
  const h = await createRegistrationApiHarness(t);
  await h.http('/api/auth/register', registrationData);
  const pending = { ...h.state.registration };
  for (const registration of [null, { ...pending, status: 'approved' }, { ...pending, status: 'rejected' }, { ...pending, firebase_cleanup_pending: true }]) {
    h.state.registration = registration;
    const start = h.calls.firebase.length;
    assert.equal(await h.service.recoverPendingRegistration({ pool: h.pool, data: registrationData }), false);
    assert.equal(h.calls.firebase.length, start);
    assert.deepEqual(h.state.registration, registration);
  }
  h.state.registration = pending;
  h.state.cleanup = true;
  assert.equal(await h.service.recoverPendingRegistration({ pool: h.pool, data: registrationData }), false);
  h.state.cleanup = false;
  h.state.user = { uid: 'another-admitted-uid', email: registrationData.email };
  assert.equal(await h.service.recoverPendingRegistration({ pool: h.pool, data: registrationData }), false);
});

test('recovery reconstructs only a missing pending identity and updates only its UID', async t => {
  const h = await createRegistrationApiHarness(t);
  await h.http('/api/auth/register', registrationData);
  h.state.registration.firebase_uid = 'missing-fixture';
  const original = { ...h.state.registration };
  h.state.identity = null;
  const start = h.calls.sql.length;
  const password = '  nova senha escolhida  ';
  assert.equal(await h.service.recoverPendingRegistration({ pool: h.pool, data: { ...registrationData, name: 'Nome alterado', password } }), true);
  assert.deepEqual(h.state.registration, { ...original, firebase_uid: 'employee-fixture' });
  assert.equal(h.state.identity.password, password);
  assert.equal(h.state.identity.displayName, original.name);
  assert.equal(h.state.identity.disabled, true);
  assert.equal(h.state.identity.emailVerified, false);
  const update = h.calls.sql.slice(start).find(call => call.sql.startsWith('UPDATE pending_registrations'));
  assert.match(update.sql, /SET firebase_uid = \$1 WHERE/);
  assert.doesNotMatch(update.sql, /SET.*name|created_at =|reviewed_at =/);
  assert.doesNotMatch(JSON.stringify(h.calls.sql), /nova senha escolhida/);
});

test('ambiguous recovery commit queues the newly created UID and discards its connection without deleting it', async t => {
  const h = await createRegistrationApiHarness(t);
  await h.http('/api/auth/register', registrationData);
  h.state.registration.firebase_uid = 'missing-fixture';
  h.state.identity = null;
  h.state.failCommit = true;
  assert.equal(await h.service.recoverPendingRegistration({ pool: h.pool, data: registrationData }), false);
  assert.equal(h.state.cleanup, true);
  assert.equal(h.calls.firebase.some(call => call.method === 'deleteUser'), false);
  assert.ok(h.calls.releases.includes(true));
  const queued = h.calls.sql.find(call => call.sql.startsWith('INSERT INTO firebase_cleanup_queue'));
  assert.equal(queued.params[0], 'employee-fixture');
});

test('legacy password recovery rejects a mismatched identity without enabling or sending email', async t => {
  const h = await createRegistrationApiHarness(t);
  await h.http('/api/auth/register', registrationData);
  h.state.identity.email = 'other@example.test';
  assert.equal(await h.service.requestPendingRegistrationPassword({ pool: h.pool, email: registrationData.email }), false);
  assert.equal(h.calls.mail.length, 0);
  assert.equal(h.calls.firebase.some(call => call.method === 'updateUser'), false);
});

test('recovery compensates a newly created identity when the final row changed or update affected no rows', async t => {
  for (const scenario of ['changed', 'no-update']) {
    await t.test(scenario, async sub => {
      const h = await createRegistrationApiHarness(sub);
      await h.http('/api/auth/register', registrationData);
      h.state.registration.firebase_uid = 'missing-fixture';
      h.state.identity = null;
      h.state.noUpdate = scenario === 'no-update';
      h.state.failSql = sql => {
        if (scenario === 'changed' && sql.startsWith('SELECT id, firebase_uid')
            && sql.includes('WHERE id = $1 FOR UPDATE') && !sql.includes('NOWAIT')) {
          h.state.registration.status = 'rejected';
        }
        return false;
      };
      assert.equal(await h.service.recoverPendingRegistration({ pool: h.pool, data: registrationData }), false);
      assert.equal(h.state.registration.firebase_uid, 'missing-fixture');
      assert.equal(h.state.registration.status, 'pending');
      assert.equal(h.state.cleanup, true, 'new UID is queued when cleanup cannot safely prove absence of references');
      assert.equal(h.calls.sql.find(call => call.sql.startsWith('INSERT INTO firebase_cleanup_queue')).params[0], 'employee-fixture');
      assert.equal(h.calls.mail.length, 0);
    });
  }
});
