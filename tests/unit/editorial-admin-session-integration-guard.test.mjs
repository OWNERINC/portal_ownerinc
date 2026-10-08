import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildPsqlInvocation, finalizeFixture, fixtureComposePath, fixtureOrigin, fixtureReadinessPath,
  validateExpiredSessionReplacement, validateIntegrationInputs,
} from '../../scripts/integration/editorial-admin-session-fixture.mjs';

const read = file => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const { authEmulatorEnabled, validateEnvironment } = require('./middleware/security');

function validInputs(overrides = {}) {
  return {
    NODE_ENV: 'test',
    MIGRATION_TEST_DISPOSABLE: 'true',
    GITHUB_SHA: 'a'.repeat(40),
    PORTAL_TEST_API_IMAGE: `ownerinc-portal-api:${'a'.repeat(40)}`,
    PORTAL_TEST_FIREBASE_PROJECT_ID: 'demo-ownerinc-123456-1',
    ...overrides,
  };
}

test('API-v2 integration inputs fail closed before fixture startup', () => {
  const accepted = validInputs();
  assert.deepEqual(validateIntegrationInputs(accepted), {
    commit: 'a'.repeat(40),
    apiImage: `ownerinc-portal-api:${'a'.repeat(40)}`,
    firebaseProjectId: 'demo-ownerinc-123456-1',
  });
  for (const input of [
    validInputs({ NODE_ENV: 'production' }),
    validInputs({ MIGRATION_TEST_DISPOSABLE: 'false' }),
    validInputs({ PORTAL_TEST_FIREBASE_PROJECT_ID: 'ownerinc-portal-interno-prod' }),
    validInputs({ PORTAL_TEST_FIREBASE_PROJECT_ID: 'demo-ownerinc-portal' }),
    validInputs({ PORTAL_TEST_API_IMAGE: 'ghcr.io/ownerinc/ownerinc-portal-api:latest' }),
    validInputs({ GITHUB_SHA: 'b'.repeat(40) }),
    validInputs({ DATABASE_URL: 'postgresql://production/fallback' }),
    validInputs({ MIGRATION_DATABASE_URL: 'postgresql://production/fallback' }),
    validInputs({ FIREBASE_CLIENT_EMAIL: 'service-account@example.invalid' }),
    validInputs({ FIREBASE_PRIVATE_KEY: 'not-a-real-key' }),
    validInputs({ PORTAL_PUBLIC_URL: 'https://portal.ownerinc.com.br' }),
    validInputs({ GOOGLE_APPLICATION_CREDENTIALS: 'fallback.json' }),
    validInputs({ DOCKER_HOST: 'tcp://production.example.invalid:2376' }),
    validInputs({ DOCKER_CONTEXT: 'production' }),
  ]) assert.throws(() => validateIntegrationInputs(input));
  assert.equal(fixtureOrigin, 'https://editorial-admin-session.test');
});

test('fixture SQL uses psql stdin with allowlisted value bindings instead of -c interpolation', () => {
  const value = `uid'); SELECT 'untrusted`;
  const invocation = buildPsqlInvocation("SELECT :'uid'", { uid: value });
  assert.equal(invocation.input, "SELECT :'uid'\n");
  assert.ok(invocation.args.includes(`uid=${value}`));
  assert.deepEqual(invocation.args.slice(-4), ['-v', `uid=${value}`, '-f', '-']);
  assert.ok(!invocation.args.includes('-c'));
  assert.throws(() => buildPsqlInvocation('SELECT 1', { secret: 'value' }), /invalid fixture SQL binding/);
  assert.throws(() => buildPsqlInvocation('SELECT 1', { uid: 'contains\0null' }), /invalid fixture SQL binding/);
  assert.throws(() => buildPsqlInvocation('', {}), /fixture SQL is required/);
});

test('fresh issue replaces one expired row: DB count is baseline plus one, distinct from two HTTP issues', () => {
  const replacement = {
    baselineCount: 4,
    databaseCount: 5,
    expiredHashPresent: false,
    freshHash: 'fresh-hash',
    persistedFreshState: 'fresh-hash|t|t',
  };
  assert.equal(validateExpiredSessionReplacement(replacement), true);

  assert.throws(() => validateExpiredSessionReplacement({ ...replacement, databaseCount: 6 }),
    /expired session replacement state mismatch/,
    'the previous baseline-plus-two DB-row oracle is incorrect because expiry cleanup deletes the first row');
  assert.throws(() => validateExpiredSessionReplacement({ ...replacement, expiredHashPresent: true }),
    /expired session replacement state mismatch/);
  assert.throws(() => validateExpiredSessionReplacement({ ...replacement, persistedFreshState: 'other-hash|t|t' }),
    /expired session replacement state mismatch/);
  assert.throws(() => validateExpiredSessionReplacement({ ...replacement, persistedFreshState: 'fresh-hash|f|t' }),
    /expired session replacement state mismatch/);
  assert.throws(() => validateExpiredSessionReplacement({ ...replacement, persistedFreshState: 'fresh-hash|t|f' }),
    /expired session replacement state mismatch/);
});

test('failed integration preserves disposable fixture and private environment; successful run cleans both', async () => {
  let cleanupCalls = 0;
  let removeCalls = 0;
  const retained = await finalizeFixture({
    failed: true,
    fixtureStarted: true,
    cleanup: async () => { cleanupCalls += 1; },
    removePrivateFiles: async () => { removeCalls += 1; },
  });
  assert.deepEqual(retained, { resourceState: 'preserved_for_diagnosis', cleanupFailed: false });
  assert.equal(cleanupCalls, 0);
  assert.equal(removeCalls, 0);

  const completed = await finalizeFixture({
    failed: false,
    fixtureStarted: true,
    cleanup: async () => { cleanupCalls += 1; },
    removePrivateFiles: async () => { removeCalls += 1; },
  });
  assert.deepEqual(completed, { resourceState: 'cleaned', cleanupFailed: false });
  assert.equal(cleanupCalls, 1);
  assert.equal(removeCalls, 1);

  const cleanupFailure = await finalizeFixture({
    failed: false,
    fixtureStarted: true,
    cleanup: async () => { throw new Error('redacted'); },
    removePrivateFiles: async () => { removeCalls += 1; },
  });
  assert.deepEqual(cleanupFailure, { resourceState: 'cleanup_failed_preserved', cleanupFailed: true });
  assert.equal(removeCalls, 1, 'private fixture values remain available if Compose cleanup fails');
});

test('integration runs the built API image against isolated real PostgreSQL and Firebase Auth Emulator', async () => {
  const [compose, runner, readiness, authSource, securitySource, verify, packageText, dockerfile] = await Promise.all([
    readFile(fixtureComposePath, 'utf8'),
    read('scripts/test-editorial-admin-session-integration.mjs'),
    readFile(fixtureReadinessPath, 'utf8'),
    read('api/middleware/auth.js'),
    read('api/middleware/security.js'),
    read('scripts/verify.mjs'),
    read('package.json'),
    read('firebase-emulator/Dockerfile'),
  ]);

  assert.match(compose, /postgres:16-alpine@sha256:[0-9a-f]{64}/);
  assert.match(compose, /dockerfile: firebase-emulator\/Dockerfile/);
  assert.match(dockerfile, /firebase-tools@15\.19\.0/);
  assert.match(compose, /--project", "\$\{FIREBASE_PROJECT_ID:\?\}"/,
    'the existing emulator image must run with the unique demo project, not its production-default CMD project');
  assert.match(compose, /image: \$\{PORTAL_TEST_API_IMAGE:\?\}/);
  assert.match(compose, /MIGRATION_DATABASE_URL: postgresql:\/\/portal_admin:/);
  assert.match(compose, /DATABASE_URL: postgresql:\/\/portal_api:/);
  assert.match(compose, /RUN_MIGRATIONS: "true"/);
  assert.match(compose, /FIREBASE_AUTH_EMULATOR_HOST: firebase-auth:9099/);
  assert.match(compose, /PORTAL_PUBLIC_URL: https:\/\/editorial-admin-session\.test/);
  assert.match(compose, /ports:\n\s+- "127\.0\.0\.1::9099"[\s\S]*?readiness:/);
  assert.match(compose, /ports:\n\s+- "127\.0\.0\.1::3000"/);
  const postgresService = compose.slice(compose.indexOf('  postgres:'), compose.indexOf('  firebase-auth:'));
  assert.doesNotMatch(postgresService, /ports:/,
    'the disposable database must not be published to the host');
  assert.match(readiness, /request\.method !== 'GET' \|\| request\.url !== '\/editorial\/ready'/);
  assert.match(readiness, /\{"status":"ready"\}/);
  assert.match(authSource, /const emulator = authEmulatorEnabled\(process\.env\)/);
  assert.match(securitySource, /env\.NODE_ENV === 'test'[\s\S]*env\.MIGRATION_TEST_DISPOSABLE === 'true'[\s\S]*\^demo-/);
  assert.match(runner, /--context', 'default'[\s\S]*context', 'inspect', 'default/);
  assert.match(runner, /unix:[\s\S]*docker\\\.sock/);
  assert.match(runner, /child\.stdin\.end\(input \?\? ''\)/);
  assert.match(runner, /buildPsqlInvocation\(sql, vars\)[\s\S]*input: invocation\.input/);
  assert.match(runner, /fixtureResourceState: resourceState/);
  assert.match(runner, /fixtureProjectName: projectName/);
  assert.match(runner, /expiredHashPresent = await databaseQuery\('verify_expired_session_removed_on_fresh_issue'/);
  assert.match(runner, /persistedFreshState = await databaseQuery\('verify_fresh_session_persisted'/);

  for (const path of [
    '/api/cms/v2/session',
    '/api/internal/editorial/admin/session/resolve',
  ]) assert.ok(runner.includes(path), `missing real HTTP route ${path}`);
  for (const expected of [
    'issued.status, 201', 'resolved.status, 200', 'privateResolved.status, 200', 'revoked.status, 204',
    'expiredResolution.status, 401', 'privateExpiredResolution.status, 401',
    'freshResolved.status, 200', 'stale.status, 401', 'privateStale.status, 401',
    'refused.status, 503', 'httpIssuanceCount, 2', 'authorityAfter, \'legacy|1\'',
    'has_table_privilege', 'pg_stat_activity', 'token_hash', 'emailVerified: true',
  ]) assert.ok(runner.includes(expected), `missing acceptance assertion ${expected}`);
  assert.doesNotMatch(runner, /SET\s+LOCAL\s+ROLE|supertest|DATABASE_URL\s*\|\|/i,
    'integration must exercise actual API DB credentials, not SET ROLE, supertest, or a database-url fallback');
  assert.match(runner, /getSetCookie\(\)[\s\S]*Secure[\s\S]*HttpOnly/);
  assert.match(runner, /doesNotMatch\(setCookie/);
  assert.match(runner, /Domain=/,
    'the issued __Host cookie must be tested for absence of a Domain attribute');
  assert.match(runner, /createHash\('sha256'\)\.update\(cookieValue\)/);
  assert.match(runner, /UPDATE cms_editor_sessions SET expires_at = NOW\(\) - INTERVAL '1 second'[\s\S]*WHERE token_hash = :'hash' AND user_uid = :'uid'/);
  assert.match(runner, /SELECT \(expires_at <= NOW\(\)\)::text \|\| '\|' \|\| \(revoked_at IS NULL\)::text/);
  assert.match(runner, /SELECT \(expires_at > NOW\(\)\)::text \|\| '\|' \|\| \(revoked_at IS NOT NULL\)::text/);
  assert.match(runner, /clearCookies[\s\S]*SameSite=Lax[\s\S]*Domain=/);
  assert.match(runner, /validateExpiredSessionReplacement\([\s\S]*baselineCount: Number\(sessionCountBefore\)[\s\S]*databaseCount: Number\(sessionCountAfterFreshIssue\)/);
  assert.match(runner, /Number\(sessionCountBeforeRefusal\), Number\(sessionCountBefore\) \+ 1/);
  assert.match(runner, /finalizeFixture\([\s\S]*failed: Boolean\(failure\)/);
  assert.match(runner, /dockerCompose\('fixture_cleanup',[\s\S]*--rmi', 'local'[\s\S]*--volumes/);
  assert.doesNotMatch(runner, /psql'[^\n]*'-c'|args\.push\('-c'/,
    'psql variables must be interpolated from stdin, not via psql -c');

  const scripts = JSON.parse(packageText).scripts;
  assert.equal(scripts.verify, 'node scripts/verify.mjs');
  assert.match(verify, /filesUnder\('tests\/unit', '\.test\.mjs'\)/);
  assert.doesNotMatch(verify, /test-editorial-admin-session-integration\.mjs/,
    'external Docker service startup remains outside npm run verify');
});

test('Firebase Auth Emulator is enabled in test only with a marked disposable demo project and no credentials fallback', () => {
  const valid = {
    NODE_ENV: 'test',
    MIGRATION_TEST_DISPOSABLE: 'true',
    DATABASE_URL: 'postgresql://portal_api@postgres/portal_fixture',
    FIREBASE_PROJECT_ID: 'demo-ownerinc-123456-1',
    FIREBASE_AUTH_EMULATOR_HOST: 'firebase-auth:9099',
    BULK_IMPORT_WORKER_SECRET: 'x'.repeat(40),
    SOLIDES_RELEASE_STAGE: 'off',
  };
  assert.equal(authEmulatorEnabled(valid), true);
  assert.doesNotThrow(() => validateEnvironment(valid));
  assert.equal(authEmulatorEnabled({ ...valid, NODE_ENV: 'production' }), false);
  assert.throws(() => validateEnvironment({ ...valid, NODE_ENV: 'production' }), /FIREBASE_AUTH_EMULATOR_HOST/);
  assert.throws(() => validateEnvironment({ ...valid, MIGRATION_TEST_DISPOSABLE: 'false' }), /FIREBASE_AUTH_EMULATOR_HOST/);
  assert.throws(() => validateEnvironment({ ...valid, FIREBASE_PROJECT_ID: 'ownerinc-portal-interno-prod' }), /FIREBASE_AUTH_EMULATOR_HOST/);
  assert.throws(() => validateEnvironment({ ...valid, FIREBASE_PRIVATE_KEY: 'credential fallback' }), /FIREBASE_AUTH_EMULATOR_HOST/);
  assert.doesNotThrow(() => validateEnvironment({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://localhost/portal_dev',
    FIREBASE_PROJECT_ID: 'ownerinc-dev',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
    BULK_IMPORT_WORKER_SECRET: 'x'.repeat(40),
    SOLIDES_RELEASE_STAGE: 'off',
  }));
});
