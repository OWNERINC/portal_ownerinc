import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFirebaseIdentityFixtures,
  FirebaseFixtureError,
  readFirebaseFixtureConfig,
} from '../../cms/tests/support/firebase-auth-fixtures.mjs';

const runId = 'db40e1f4-0670-43d1-96b0-1d3163c5c8a1';
const projectId = 'demo-ownerinc-payload-test';
const integrationConfig = { runId };
const env = {
  PAYLOAD_TEST_FIREBASE_PROJECT_ID: projectId,
  PAYLOAD_TEST_FIREBASE_AUTH_EMULATOR_URL: 'http://127.0.0.1:9299',
};
const jwt = (uid, verified, aud = projectId) => {
  const payload = Buffer.from(JSON.stringify({
    aud, iss: `https://securetoken.google.com/${aud}`, sub: uid,
    email_verified: verified,
  })).toString('base64url');
  return `header.${payload}.signature`;
};

function mockFixtureServices({ wrongProject = false, failDeleteCount = 0, failUpdate = false, loseSignupResponse = false } = {}) {
  const calls = [];
  const users = new Map();
  let next = 0;
  let deletesToFail = failDeleteCount;
  const fetchImpl = async (url, options) => {
    const action = new URL(url).pathname.split(':').at(-1);
    const body = JSON.parse(options.body);
    calls.push({ action, body, headers: options.headers, redirect: options.redirect });
    if (action === 'signUp') {
      next++;
      const uid = `uid-${next}`;
      users.set(uid, { uid, email: body.email, displayName: body.displayName, emailVerified: false });
      const aud = wrongProject ? 'demo-other-project' : projectId;
      if (loseSignupResponse && next === 1) throw new Error('private_lost_response');
      return Response.json({ localId: uid, idToken: jwt(uid, false, aud), refreshToken: `refresh-${next}` });
    }
    if (action === 'signInWithPassword') {
      const user = [...users.values()].find(value => value.email === body.email);
      return Response.json({
        localId: user.uid,
        idToken: jwt(user.uid, user.emailVerified),
        refreshToken: 'synthetic-refresh-token',
      });
    }
    throw new Error('unexpected_action');
  };
  const adminAuth = {
    async verifyIdToken(token) {
      const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
      return { ...claims, uid: claims.sub };
    },
    async getUserByEmail(email) {
      const user = [...users.values()].find(value => value.email === email);
      if (!user) throw Object.assign(new Error('not found'), { code: 'auth/user-not-found' });
      return { ...user };
    },
    async getUser(uid) {
      const user = users.get(uid);
      if (!user) throw Object.assign(new Error('not found'), { code: 'auth/user-not-found' });
      return { ...user };
    },
    async updateUser(uid, patch) {
      if (failUpdate) throw new Error('private-admin-detail');
      Object.assign(users.get(uid), patch);
      return { ...users.get(uid) };
    },
    async deleteUser(uid) {
      if (deletesToFail > 0) {
        deletesToFail--;
        throw new Error('private-delete-detail');
      }
      users.delete(uid);
    },
  };
  return { calls, users, fetchImpl, adminAuth };
}

test('fixture config accepts only an explicit local demo emulator target and run UUID', () => {
  assert.deepEqual(readFirebaseFixtureConfig(env, integrationConfig), {
    origin: 'http://127.0.0.1:9299', projectId, runId,
  });
  for (const patch of [
    { PAYLOAD_TEST_FIREBASE_PROJECT_ID: 'ownerinc-production' },
    { PAYLOAD_TEST_FIREBASE_PROJECT_ID: 'demo-ownerinc', PAYLOAD_TEST_FIREBASE_AUTH_EMULATOR_URL: 'https://127.0.0.1:9299' },
    { PAYLOAD_TEST_FIREBASE_PROJECT_ID: 'demo-ownerinc', PAYLOAD_TEST_FIREBASE_AUTH_EMULATOR_URL: 'http://firebase.example:9299' },
    { PAYLOAD_TEST_FIREBASE_PROJECT_ID: 'demo-ownerinc', PAYLOAD_TEST_FIREBASE_AUTH_EMULATOR_URL: 'http://127.0.0.1' },
    { PAYLOAD_TEST_FIREBASE_PROJECT_ID: 'demo-ownerinc', PAYLOAD_TEST_FIREBASE_AUTH_EMULATOR_URL: 'http://127.0.0.1:9299/path' },
  ]) {
    assert.throws(() => readFirebaseFixtureConfig({ ...env, ...patch }, integrationConfig), FirebaseFixtureError);
  }
});

test('identity fixtures bind requests and decoded token claims to the requested project', async () => {
  const config = readFirebaseFixtureConfig(env, integrationConfig);
  const services = mockFixtureServices();
  const fixtures = await createFirebaseIdentityFixtures(config, {
    ...services,
    passwordFactory: () => 'synthetic-password-long-enough',
  });
  assert.deepEqual(Object.keys(fixtures.identities), ['editorA', 'editorB', 'viewer', 'unverified']);
  assert.equal(fixtures.identities.editorA.emailVerified, true);
  assert.equal(fixtures.identities.unverified.emailVerified, false);
  assert.equal(fixtures.identities.editorA.email, `payload-${runId}-editora@example.invalid`);
  assert(services.calls.every(call => call.headers['x-firebase-gmpid'] === projectId));
  assert.equal(services.calls.filter(call => call.action === 'signUp').length, 4);
  assert.equal(services.calls.filter(call => call.action === 'signInWithPassword').length, 4);
  assert.equal(services.users.size, 4);
  await fixtures.cleanup();
  await fixtures.cleanup();
  assert.equal(services.users.size, 0);
});

test('helper rejects wrong aud/iss project and cleans only the just-created fixture', async () => {
  const services = mockFixtureServices({ wrongProject: true });
  await assert.rejects(createFirebaseIdentityFixtures(readFirebaseFixtureConfig(env, integrationConfig), {
    ...services,
    passwordFactory: () => 'synthetic-password-long-enough',
  }), error => error instanceof FirebaseFixtureError && error.code === 'firebase_fixture_signup_token_project_mismatch');
  assert.equal(services.users.size, 0);
  assert.deepEqual([...services.calls.map(call => call.action)], ['signUp']);
});

test('fixture preflight refuses a reused run email and never deletes the pre-existing UID', async () => {
  const services = mockFixtureServices();
  services.users.set('not-this-run', {
    uid: 'not-this-run', email: `payload-${runId}-editora@example.invalid`,
    displayName: 'unowned', emailVerified: false,
  });
  await assert.rejects(createFirebaseIdentityFixtures(readFirebaseFixtureConfig(env, integrationConfig), {
    ...services,
    passwordFactory: () => 'synthetic-password-long-enough',
  }), error => error instanceof FirebaseFixtureError && error.code === 'firebase_fixture_email_collision');
  assert.equal(services.users.get('not-this-run').displayName, 'unowned');
  assert.equal(services.calls.length, 0);
});

test('lost signup response cleans only the account carrying this run marker', async () => {
  const services = mockFixtureServices({ loseSignupResponse: true });
  await assert.rejects(createFirebaseIdentityFixtures(readFirebaseFixtureConfig(env, integrationConfig), {
    ...services,
    passwordFactory: () => 'synthetic-password-long-enough',
  }), error => error instanceof FirebaseFixtureError
      && error.code === 'firebase_fixture_signup_unavailable'
      && error.cleanupComplete === true);
  assert.equal(services.users.size, 0);
  assert.deepEqual(services.calls.map(call => call.action), ['signUp']);
});

test('Admin SDK state, not client update response, is the email verification oracle', async () => {
  const services = mockFixtureServices({ failUpdate: true });
  await assert.rejects(createFirebaseIdentityFixtures(readFirebaseFixtureConfig(env, integrationConfig), {
    ...services,
    passwordFactory: () => 'synthetic-password-long-enough',
  }), error => error instanceof FirebaseFixtureError
      && error.code === 'firebase_fixture_setup_failed'
      && !error.message.includes('private-admin-detail'));
  assert.equal(services.users.size, 0);
  assert.deepEqual([...services.calls.map(call => call.action)], ['signUp']);
});

test('incomplete exact-UID cleanup exposes a sanitized in-memory retry and retains only pending records', async () => {
  const services = mockFixtureServices({ failDeleteCount: 1 });
  const fixtures = await createFirebaseIdentityFixtures(readFirebaseFixtureConfig(env, integrationConfig), {
    ...services,
    passwordFactory: () => 'synthetic-password-long-enough',
  });
  let failed;
  try { await fixtures.cleanup(); } catch (error) { failed = error; }
  assert(failed instanceof FirebaseFixtureError);
  assert.equal(failed.code, 'firebase_fixture_cleanup_incomplete');
  assert.equal(failed.pendingCleanupCount, 1);
  assert.equal(typeof failed.retryCleanup, 'function');
  assert(!failed.message.includes('private-delete-detail'));
  assert.equal(services.users.size, 1);
  await failed.retryCleanup();
  assert.equal(failed.pendingCleanupCount, 0);
  assert.equal(services.users.size, 0);
  await fixtures.cleanup();
});
