import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixtureComposePath = fileURLToPath(new URL('./editorial-admin-session-fixture.compose.yml', import.meta.url));
export const fixtureReadinessPath = fileURLToPath(new URL('./editorial-admin-session-readiness.mjs', import.meta.url));
export const fixtureOrigin = 'https://editorial-admin-session.test';

const prohibitedFallbacks = Object.freeze([
  'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'API_DATABASE_URL', 'CRON_DATABASE_URL',
  'POSTGRES_USER', 'POSTGRES_PASSWORD', 'PORTAL_API_DB_PASSWORD', 'PORTAL_CRON_DB_PASSWORD',
  'FIREBASE_PROJECT_ID', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS', 'BULK_IMPORT_WORKER_SECRET', 'PAYLOAD_TO_PORTAL_SECRET',
  'PORTAL_TO_PAYLOAD_SECRET', 'PORTAL_PUBLIC_URL', 'CORS_ORIGINS', 'CMS_INTERNAL_URL',
  'FIXTURE_PROJECT_NAME', 'RUN_MIGRATIONS', 'MIGRATION_ONLY',
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
]);
const psqlVariableNames = new Set(['email', 'hash', 'name', 'uid']);
const firebaseResponseKeyAllowlist = new Set([
  'kind', 'localId', 'email', 'emailVerified', 'idToken', 'refreshToken', 'expiresIn',
  'isNewUser', 'users', 'error', 'displayName', 'photoUrl', 'providerUserInfo',
]);
const firebaseContractCheckAllowlist = new Set([
  'signupHasLocalId', 'signInUidMatches', 'freshIdTokenPresent',
  'lookupHasSingleUser', 'lookupUidMatches', 'lookupEmailVerified',
]);

export function validateIntegrationInputs(env) {
  if (env.NODE_ENV !== 'test' || env.MIGRATION_TEST_DISPOSABLE !== 'true') {
    throw new Error('disposable test mode is required');
  }
  const commit = env.GITHUB_SHA;
  if (!/^[0-9a-f]{40}$/.test(commit || '')) throw new Error('checked-out commit is invalid');
  if (env.PORTAL_TEST_API_IMAGE !== `ownerinc-portal-api:${commit}`) {
    throw new Error('built API image must match the checked-out commit');
  }
  if (!/^demo-ownerinc-[0-9]+-[0-9]+$/.test(env.PORTAL_TEST_FIREBASE_PROJECT_ID || '')) {
    throw new Error('a unique Firebase demo project id is required');
  }
  const suppliedFallback = prohibitedFallbacks.find(name => Object.hasOwn(env, name));
  if (suppliedFallback) throw new Error(`unexpected external test fallback: ${suppliedFallback}`);
  return { commit, apiImage: env.PORTAL_TEST_API_IMAGE, firebaseProjectId: env.PORTAL_TEST_FIREBASE_PROJECT_ID };
}

export function createFixtureProjectName() {
  return `editorial-admin-session-${randomUUID().replaceAll('-', '')}`;
}

export function safeFirebaseResponseKeys(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.keys(body).filter(key => firebaseResponseKeyAllowlist.has(key)).sort();
}

export function safeFirebaseContractChecks(checks) {
  if (!checks || typeof checks !== 'object' || Array.isArray(checks)) return {};
  return Object.fromEntries(Object.entries(checks)
    .filter(([key, value]) => firebaseContractCheckAllowlist.has(key) &&
      (typeof value === 'boolean' || value === null)));
}

export function buildPsqlInvocation(sql, variables = {}) {
  if (typeof sql !== 'string' || !sql.trim()) throw new Error('fixture SQL is required');
  const args = ['exec', '-T', 'postgres', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'portal_admin', '-d', 'portal_fixture'];
  for (const [key, value] of Object.entries(variables)) {
    if (!/^[a-z_][a-z0-9_]*$/.test(key) || !psqlVariableNames.has(key) || typeof value !== 'string' || value.includes('\0')) {
      throw new Error('invalid fixture SQL binding');
    }
    args.push('-v', `${key}=${value}`);
  }
  args.push('-f', '-');
  return { args, input: sql.endsWith('\n') ? sql : `${sql}\n` };
}

export function validateExpiredSessionReplacement({
  baselineCount,
  databaseCount,
  expiredHashPresent,
  freshHash,
  persistedFreshState,
}) {
  if (!Number.isSafeInteger(baselineCount) || baselineCount < 0 ||
    !Number.isSafeInteger(databaseCount) || databaseCount !== baselineCount + 1 ||
    expiredHashPresent !== false || typeof freshHash !== 'string' || !freshHash ||
    persistedFreshState !== `${freshHash}|true|true`) {
    throw new Error('expired session replacement state mismatch');
  }
  return true;
}

export function inspectFirebaseIdentityProgress({ signup, accountUpdate, signIn, accountLookup }) {
  // accounts:update is checked for HTTP success by the caller; its optional
  // response fields do not prove the persisted verification state or mint a token.
  void accountUpdate;
  const checks = {
    signupHasLocalId: typeof signup?.localId === 'string' && signup.localId.length > 0,
    signInUidMatches: signIn === undefined ? null : signIn?.localId === signup?.localId,
    freshIdTokenPresent: signIn === undefined ? null :
      typeof signIn?.idToken === 'string' && signIn.idToken.length > 0,
    lookupHasSingleUser: accountLookup === undefined ? null :
      Array.isArray(accountLookup?.users) && accountLookup.users.length === 1,
    lookupUidMatches: accountLookup === undefined ? null :
      Array.isArray(accountLookup?.users) && accountLookup.users.length === 1 &&
      accountLookup.users[0]?.localId === signup?.localId,
    lookupEmailVerified: accountLookup === undefined ? null :
      Array.isArray(accountLookup?.users) && accountLookup.users.length === 1 &&
      accountLookup.users[0]?.emailVerified === true,
  };
  const failed = (diagnosticOperation, failedCheck, contractFailure) => ({
    ok: false,
    diagnosticOperation,
    failedCheck,
    contractFailure,
    checks,
  });

  if (!checks.signupHasLocalId) {
    return failed('firebase_emulator_signup', 'firebase_emulator_signup_identity_missing', 'signup_identity_missing');
  }
  if (signIn !== undefined && !checks.signInUidMatches) {
    return failed('firebase_emulator_signin', 'firebase_emulator_signin_identity_mismatch', 'signin_identity_mismatch');
  }
  if (signIn !== undefined && !checks.freshIdTokenPresent) {
    return failed('firebase_emulator_signin', 'firebase_emulator_signin_id_token_missing', 'signin_id_token_missing');
  }
  if (accountLookup !== undefined && !checks.lookupHasSingleUser) {
    return failed('firebase_emulator_lookup', 'firebase_emulator_lookup_user_missing', 'lookup_user_missing');
  }
  if (accountLookup !== undefined && !checks.lookupUidMatches) {
    return failed('firebase_emulator_lookup', 'firebase_emulator_lookup_identity_mismatch', 'lookup_identity_mismatch');
  }
  if (accountLookup !== undefined && !checks.lookupEmailVerified) {
    return failed('firebase_emulator_lookup', 'firebase_emulator_lookup_email_unverified', 'lookup_email_unverified');
  }
  return {
    ok: true,
    checks,
    ...(signIn !== undefined && accountLookup !== undefined
      ? { identity: { uid: signup.localId, idToken: signIn.idToken } }
      : {}),
  };
}

export async function finalizeFixture({ failed, fixtureStarted, cleanup, removePrivateFiles }) {
  if (failed) {
    return {
      resourceState: fixtureStarted ? 'preserved_for_diagnosis' : 'not_started',
      cleanupFailed: false,
    };
  }
  try {
    if (fixtureStarted) await cleanup();
    await removePrivateFiles();
    return { resourceState: 'cleaned', cleanupFailed: false };
  } catch {
    return { resourceState: 'cleanup_failed_preserved', cleanupFailed: true };
  }
}

export async function createFixtureEnvironment({ projectName, apiImage, firebaseProjectId, directory }) {
  const randomSecret = (bytes = 32) => randomBytes(bytes).toString('hex');
  const values = {
    FIXTURE_PROJECT_NAME: projectName,
    PORTAL_TEST_API_IMAGE: apiImage,
    FIREBASE_PROJECT_ID: firebaseProjectId,
    POSTGRES_PASSWORD: randomSecret(),
    PORTAL_API_DB_PASSWORD: randomSecret(),
    PORTAL_CRON_DB_PASSWORD: randomSecret(),
    BULK_IMPORT_WORKER_SECRET: randomSecret(),
    PAYLOAD_TO_PORTAL_SECRET: randomSecret(40),
    PORTAL_TO_PAYLOAD_SECRET: randomSecret(40),
  };
  const contents = `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
  const envFile = path.join(directory, 'fixture.env');
  await writeFile(envFile, contents, { mode: 0o600, flag: 'wx' });
  return { envFile, values };
}
