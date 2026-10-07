// Test-only Firebase Auth Emulator fixtures. Never points to production Firebase.
import { randomBytes } from 'node:crypto';

const API_KEY = 'fake-api-key';
const roles = Object.freeze([
  { name: 'editorA', verified: true },
  { name: 'editorB', verified: true },
  { name: 'viewer', verified: true },
  { name: 'unverified', verified: false },
]);

export class FirebaseFixtureError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function fail(code) { throw new FirebaseFixtureError(code); }

export function readFirebaseFixtureConfig(env, integrationConfig) {
  const projectId = env.PAYLOAD_TEST_FIREBASE_PROJECT_ID;
  if (typeof projectId !== 'string' || !/^demo-[a-z0-9-]{1,55}$/.test(projectId)) {
    fail('firebase_emulator_demo_project_required');
  }

  let url;
  try { url = new URL(env.PAYLOAD_TEST_FIREBASE_AUTH_EMULATOR_URL); }
  catch { fail('firebase_emulator_url_invalid'); }
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash
      || url.pathname !== '/' || !url.port
      || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    fail('firebase_emulator_loopback_required');
  }
  if (!integrationConfig || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(integrationConfig.runId || '')) {
    fail('synthetic_run_id_required');
  }

  return Object.freeze({ origin: url.origin, projectId, runId: integrationConfig.runId });
}

function endpoint(config, action) {
  return `${config.origin}/identitytoolkit.googleapis.com/v1/accounts:${action}?key=${API_KEY}`;
}

async function request(fetchImpl, config, url, body, code) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-firebase-gmpid': config.projectId },
      body: JSON.stringify(body),
    });
  } catch {
    fail(`${code}_unavailable`);
  }
  if (!response?.ok) fail(`${code}_http_${Number.isInteger(response?.status) ? response.status : 'error'}`);
  try { return await response.json(); }
  catch { fail(`${code}_invalid_response`); }
}

function tokenClaims(token, config, code) {
  try {
    const sections = token.split('.');
    if (sections.length !== 3 || !sections[1]) fail(`${code}_invalid_token`);
    const claims = JSON.parse(Buffer.from(sections[1], 'base64url').toString('utf8'));
    if (claims.aud !== config.projectId
        || claims.iss !== `https://securetoken.google.com/${config.projectId}`) {
      fail(`${code}_token_project_mismatch`);
    }
    return claims;
  } catch (error) {
    if (error instanceof FirebaseFixtureError) throw error;
    fail(`${code}_invalid_token`);
  }
}

function assertIdentity(value, code, config, expectedEmailVerified) {
  if (typeof value?.localId !== 'string' || !value.localId
      || typeof value.idToken !== 'string' || !value.idToken) fail(`${code}_invalid_response`);
  const claims = tokenClaims(value.idToken, config, code);
  if (claims.sub !== value.localId
      || (expectedEmailVerified !== undefined && claims.email_verified !== expectedEmailVerified)) {
    fail(`${code}_identity_claim_mismatch`);
  }
}

function attachCleanupRetry(error, pendingCleanup, cleanupPending) {
  Object.defineProperty(error, 'pendingCleanupCount', { get: () => pendingCleanup.size, enumerable: false });
  Object.defineProperty(error, 'retryCleanup', { value: cleanupPending, enumerable: false });
  return error;
}

export async function createFirebaseIdentityFixtures(config, {
  fetchImpl = globalThis.fetch,
  adminAuth,
  passwordFactory = () => randomBytes(32).toString('base64url'),
} = {}) {
  if (typeof fetchImpl !== 'function') fail('firebase_fixture_fetch_unavailable');
  if (!config) fail('firebase_fixture_config_invalid');
  config = readFirebaseFixtureConfig({
    PAYLOAD_TEST_FIREBASE_AUTH_EMULATOR_URL: config.origin,
    PAYLOAD_TEST_FIREBASE_PROJECT_ID: config.projectId,
  }, { runId: config.runId });
  if (!adminAuth || typeof adminAuth.getUser !== 'function'
      || typeof adminAuth.updateUser !== 'function' || typeof adminAuth.deleteUser !== 'function'
      || typeof adminAuth.verifyIdToken !== 'function') {
    fail('firebase_fixture_admin_auth_required');
  }

  const fixtures = Object.create(null);
  const pendingCleanup = new Set();
  async function remove(record) {
    let account;
    try {
      account = record.uid ? await adminAuth.getUser(record.uid) : await adminAuth.getUserByEmail(record.email);
    } catch (error) {
      if (error?.code === 'auth/user-not-found') return;
      throw error;
    }
    if (account.email !== record.email || account.displayName !== record.marker
        || (record.uid && account.uid !== record.uid)) fail('firebase_fixture_cleanup_identity_mismatch');
    await adminAuth.deleteUser(account.uid);
  }
  async function cleanupPending() {
    const records = [...pendingCleanup];
    const outcomes = await Promise.allSettled(records.map(remove));
    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') pendingCleanup.delete(records[index]);
    });
    if (pendingCleanup.size) fail('firebase_fixture_cleanup_incomplete');
  }

  try {
    for (const role of roles) {
      const email = `payload-${config.runId}-${role.name.toLowerCase()}@example.invalid`;
      try {
        await adminAuth.getUserByEmail(email);
        fail('firebase_fixture_email_collision');
      } catch (error) {
        if (error instanceof FirebaseFixtureError) throw error;
        if (error?.code !== 'auth/user-not-found') fail('firebase_fixture_preflight_unavailable');
      }
    }
    for (const role of roles) {
      const email = `payload-${config.runId}-${role.name.toLowerCase()}@example.invalid`;
      const marker = `payload-task15-fixture:${config.runId}:${role.name}`;
      const password = passwordFactory();
      if (typeof password !== 'string' || password.length < 20) fail('firebase_fixture_password_invalid');
      const cleanupRecord = { uid: null, email, marker };
      pendingCleanup.add(cleanupRecord);
      const created = await request(fetchImpl, config, endpoint(config, 'signUp'), {
        email, password, displayName: marker, returnSecureToken: true,
      }, 'firebase_fixture_signup');
      if (typeof created?.localId !== 'string' || !created.localId) fail('firebase_fixture_signup_invalid_response');
      cleanupRecord.uid = created.localId;
      assertIdentity(created, 'firebase_fixture_signup', config, false);

      let account = await adminAuth.getUser(created.localId);
      if (account.uid !== created.localId || account.email !== email || account.displayName !== marker) {
        fail('firebase_fixture_admin_identity_mismatch');
      }
      if (role.verified && account.emailVerified !== true) {
        await adminAuth.updateUser(created.localId, { emailVerified: true });
        account = await adminAuth.getUser(created.localId);
      }
      if (account.emailVerified !== role.verified) fail('firebase_fixture_email_verification_mismatch');

      const authenticated = await request(fetchImpl, config, endpoint(config, 'signInWithPassword'), {
        email, password, returnSecureToken: true,
      }, 'firebase_fixture_signin');
      assertIdentity(authenticated, 'firebase_fixture_signin', config, role.verified);
      if (authenticated.localId !== created.localId) fail('firebase_fixture_signin_identity_mismatch');
      let decoded;
      try { decoded = await adminAuth.verifyIdToken(authenticated.idToken); }
      catch { fail('firebase_fixture_admin_token_rejected'); }
      if (decoded.aud !== config.projectId
          || decoded.iss !== `https://securetoken.google.com/${config.projectId}`
          || decoded.uid !== created.localId
          || decoded.email_verified !== role.verified) {
        fail('firebase_fixture_admin_token_project_mismatch');
      }
      fixtures[role.name] = Object.freeze({
        role: role.name,
        uid: authenticated.localId,
        email,
        password,
        idToken: authenticated.idToken,
        refreshToken: authenticated.refreshToken,
        emailVerified: account.emailVerified,
      });
    }
  } catch (error) {
    const safeError = error instanceof FirebaseFixtureError
      ? error : new FirebaseFixtureError('firebase_fixture_setup_failed');
    try { await cleanupPending(); }
    catch {
      throw attachCleanupRetry(
        new FirebaseFixtureError(`${safeError.code}_cleanup_incomplete`), pendingCleanup, cleanupPending,
      );
    }
    Object.defineProperty(safeError, 'cleanupComplete', { value: true, enumerable: false });
    throw safeError;
  }

  let cleaned = false;
  return Object.freeze({
    projectId: config.projectId,
    runId: config.runId,
    identities: Object.freeze(fixtures),
    async cleanup() {
      if (cleaned) return;
      try { await cleanupPending(); }
      catch {
        throw attachCleanupRetry(new FirebaseFixtureError('firebase_fixture_cleanup_incomplete'), pendingCleanup, cleanupPending);
      }
      cleaned = true;
    },
  });
}
