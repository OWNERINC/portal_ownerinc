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
    persistedFreshState !== `${freshHash}|t|t`) {
    throw new Error('expired session replacement state mismatch');
  }
  return true;
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
