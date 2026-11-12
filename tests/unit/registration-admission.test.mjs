import assert from 'node:assert/strict';
import test from 'node:test';
import { createRegistrationApiHarness } from '../helpers/registration-api-harness.mjs';

test('admission ignores email verification but still requires a valid unrevoked token and active admitted account', async t => {
  const h = await createRegistrationApiHarness(t);
  assert.equal((await h.http('/api/users/me')).status, 401);
  assert.equal((await h.http('/api/users/me', null, 'invalid')).status, 401);
  assert.equal((await h.http('/api/users/me', null, 'employee-fixture')).status, 403);
  h.state.registration = { status: 'pending' };
  assert.equal((await h.http('/api/users/me', null, 'employee-fixture')).body.reason, 'pending-approval');
  h.state.user = { uid: 'employee-fixture', role: 'viewer', permissions: {}, firebase_enable_pending: false };
  assert.equal((await h.http('/api/users/me', null, 'employee-fixture')).status, 200);
  for (const accountDisabled of [true, 'true']) {
    h.state.user.permissions = { accountDisabled };
    assert.equal((await h.http('/api/users/me', null, 'employee-fixture')).body.reason, 'account-disabled');
  }
  h.state.user.permissions = {};
  h.state.user.firebase_enable_pending = true;
  assert.equal((await h.http('/api/users/me', null, 'employee-fixture')).body.reason, 'enable-pending');
  assert.ok(h.calls.firebase.filter(call => call.method === 'verifyIdToken').every(call => call.revoked === true));
});
