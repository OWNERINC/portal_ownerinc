import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPsqlInvocation, createFixtureEnvironment, createFixtureProjectName, finalizeFixture,
  fixtureComposePath, fixtureOrigin, validateExpiredSessionReplacement, validateIntegrationInputs,
} from './integration/editorial-admin-session-fixture.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const apiBase = 'http://127.0.0.1';
const reportName = 'editorial-admin-session-report.json';
const safeChecks = [];
let stage = 'validate_disposable_inputs';
let fixtureDirectory;
let fixtureEnvFile;
let projectName;
let bridgeSecret;
let fixtureMayExist = false;
let resourceState = 'not_started';

function fail(stageName) {
  stage = stageName;
  throw new Error(stageName);
}

async function runProcess(command, args, { timeoutMs = 30000, capture = true, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let timedOut = false;
    const append = chunk => {
      if (!capture || stdout.length >= 1024 * 1024) return;
      stdout += chunk.toString('utf8').slice(0, 1024 * 1024 - stdout.length);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error('fixture_process_unavailable'));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut || code !== 0) reject(new Error('fixture_process_failed'));
      else resolve(stdout.trim());
    });
  });
}

function composeArgs(args) {
  return [
    'compose', '--project-directory', root, '--project-name', projectName,
    '--env-file', fixtureEnvFile, '--file', fixtureComposePath, ...args,
  ];
}

async function dockerCompose(stageName, args, options) {
  stage = stageName;
  try { return await runProcess('docker', ['--context', 'default', ...composeArgs(args)], options); }
  catch { fail(stageName); }
}

async function assertLocalDockerContext() {
  stage = 'local_docker_endpoint_guard';
  let endpoint;
  try {
    endpoint = await runProcess('docker', [
      '--context', 'default', 'context', 'inspect', 'default',
      '--format', '{{ (index .Endpoints "docker").Host }}',
    ], { timeoutMs: 15000 });
  } catch { fail('local_docker_endpoint_guard'); }
  if (!/^unix:\/\/(?:\/var\/run|\/run)\/docker\.sock$/.test(endpoint)) fail('local_docker_endpoint_guard');
  record('default_docker_context_uses_local_unix_socket');
}

async function databaseQuery(stageName, sql, vars = {}) {
  const invocation = buildPsqlInvocation(sql, vars);
  return dockerCompose(stageName, invocation.args, { timeoutMs: 30000, input: invocation.input });
}

async function waitForApi(origin) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/ready`, { signal: AbortSignal.timeout(2000), cache: 'no-store' });
      if (response.status === 200 && (await response.json()).status === 'ready') return;
      await response.body?.cancel();
    } catch { /* Retry startup without logging response details. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  fail('api_readiness_timeout');
}

async function readResponse(response) {
  const text = await response.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

function record(check) {
  safeChecks.push(check);
}

async function psqlReadIdentity(uid) {
  const row = await databaseQuery('seed_synthetic_portal_admin', `
    INSERT INTO users(uid, email, name, role, permissions)
    VALUES (:'uid', :'email', :'name', 'admin', jsonb_build_object('manageAcademy', true, 'manageBenefits', true))
    RETURNING uid`, {
    uid,
    email: `${uid}@example.test`,
    name: 'Synthetic editorial admin fixture',
  });
  assert.equal(row, uid);
}

async function createFirebaseIdentity(authOrigin, projectId) {
  const makeRequest = async (suffix, body) => {
    const response = await fetch(`${authOrigin}/identitytoolkit.googleapis.com/v1/${suffix}?key=emulator-api-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const decoded = await readResponse(response);
    if (!response.ok || !decoded) fail('firebase_emulator_identity_setup');
    return decoded;
  };
  const identity = await makeRequest('accounts:signUp', {
    email: `editorial-${randomUUID()}@example.test`,
    password: randomUUID().replaceAll('-', '') + 'A9!',
    returnSecureToken: true,
  });
  const verified = await makeRequest('accounts:update', {
    idToken: identity.idToken,
    emailVerified: true,
    returnSecureToken: true,
  });
  assert.equal(verified.localId, identity.localId);
  assert.equal(verified.emailVerified, true);
  assert.ok(verified.idToken);
  assert.ok(projectId.startsWith('demo-'));
  return { uid: verified.localId, idToken: verified.idToken };
}

async function apiRequest(origin, pathname, { method = 'GET', token, cookie, body, internal = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  if (internal) headers.Authorization = `Bearer ${bridgeSecret}`;
  if (['POST', 'DELETE'].includes(method) && !internal) headers.Origin = fixtureOrigin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${origin}${pathname}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  });
}

async function runIntegration() {
  let httpIssuanceCount = 0;
  const input = validateIntegrationInputs(process.env);
  record('disposable_inputs_and_demo_project_validated');
  await assertLocalDockerContext();
  projectName = createFixtureProjectName();
  fixtureDirectory = await mkdtemp(path.join(os.tmpdir(), `${projectName}-`));
  const { envFile, values } = await createFixtureEnvironment({
    projectName,
    apiImage: input.apiImage,
    firebaseProjectId: input.firebaseProjectId,
    directory: fixtureDirectory,
  });
  fixtureEnvFile = envFile;
  bridgeSecret = values.PAYLOAD_TO_PORTAL_SECRET;

  stage = 'built_api_image_presence';
  await runProcess('docker', ['--context', 'default', 'image', 'inspect', input.apiImage], { timeoutMs: 30000, capture: false });
  record('built_api_image_matches_checked_out_commit');

  fixtureMayExist = true;
  await dockerCompose('isolated_fixture_startup', ['up', '--detach', '--build', '--wait', '--wait-timeout', '240'], { timeoutMs: 360000, capture: false });
  record('disposable_postgres_and_firebase_auth_emulator_started');

  const apiPort = await dockerCompose('api_fixture_port_discovery', ['port', 'api', '3000']);
  const authPort = await dockerCompose('firebase_fixture_port_discovery', ['port', 'firebase-auth', '9099']);
  const apiMatch = /^127\.0\.0\.1:(\d+)$/.exec(apiPort);
  const authMatch = /^127\.0\.0\.1:(\d+)$/.exec(authPort);
  if (!apiMatch || !authMatch) fail('fixture_ports_not_loopback_only');
  const apiOrigin = `${apiBase}:${apiMatch[1]}`;
  const authOrigin = `${apiBase}:${authMatch[1]}`;
  await waitForApi(apiOrigin);
  record('actual_api_image_ready_over_http');

  const identity = await createFirebaseIdentity(authOrigin, input.firebaseProjectId);
  await psqlReadIdentity(identity.uid);
  record('firebase_emulator_signed_identity_and_portal_admin_seeded');

  const authorityBefore = await databaseQuery('authority_before_session_flow',
    'SELECT mode || \'|\' || epoch::text FROM owner_news_authority WHERE singleton = TRUE');
  assert.equal(authorityBefore, 'legacy|1');

  stage = 'runtime_role_grants';
  const grants = await databaseQuery(stage, `SELECT
    has_table_privilege('portal_api', 'public.cms_editor_sessions', 'SELECT')
    AND has_table_privilege('portal_api', 'public.cms_editor_sessions', 'INSERT')
    AND has_table_privilege('portal_api', 'public.cms_editor_sessions', 'UPDATE')
    AND has_table_privilege('portal_api', 'public.cms_editor_sessions', 'DELETE')
    AND NOT has_table_privilege('portal_api', 'public.cms_editor_sessions', 'TRUNCATE')
    AND NOT has_table_privilege('portal_cron', 'public.cms_editor_sessions', 'INSERT')`);
  assert.equal(grants, 't');

  const sessionCountBefore = await databaseQuery('session_count_before_issue',
    'SELECT COUNT(*)::text FROM cms_editor_sessions WHERE user_uid = :\'uid\'', { uid: identity.uid });

  stage = 'http_issue_session';
  const issued = await apiRequest(apiOrigin, '/api/cms/v2/session', {
    method: 'POST', token: identity.idToken, body: {},
  });
  assert.equal(issued.status, 201);
  httpIssuanceCount += 1;
  const issuedBody = await readResponse(issued);
  assert.equal(issuedBody?.actor?.version, 2);
  assert.equal(issuedBody?.actor?.uid, identity.uid);
  assert.equal(issuedBody?.actor?.capabilities?.manageAcademy, true);
  const setCookies = issued.headers.getSetCookie();
  assert.equal(setCookies.length, 1);
  const setCookie = setCookies[0];
  const cookiePair = setCookie.split(';', 1)[0];
  const cookieName = cookiePair.split('=', 1)[0];
  const cookieValue = cookiePair.slice(cookieName.length + 1);
  assert.equal(cookieName, '__Host-ownerinc-editorial');
  assert.ok(cookieValue.length > 32);
  assert.match(setCookie, /(?:^|;\s*)Secure(?:;|$)/i);
  assert.match(setCookie, /(?:^|;\s*)HttpOnly(?:;|$)/i);
  assert.match(setCookie, /(?:^|;\s*)Path=\/(?:;|$)/i);
  assert.match(setCookie, /(?:^|;\s*)SameSite=Lax(?:;|$)/i);
  assert.doesNotMatch(setCookie, /(?:^|;\s*)Domain=/i);
  const sessionCountAfterFirstIssue = await databaseQuery('first_issuance_session_count',
    'SELECT COUNT(*)::text FROM cms_editor_sessions WHERE user_uid = :\'uid\'', { uid: identity.uid });
  assert.equal(Number(sessionCountAfterFirstIssue), Number(sessionCountBefore) + 1);
  record('http_201_host_only_secure_httponly_https_origin_cookie');

  const tokenHash = createHash('sha256').update(cookieValue).digest('hex');
  const storedHash = await databaseQuery('session_hash_only_storage', `
    SELECT token_hash FROM cms_editor_sessions
    WHERE token_hash = :'hash' AND user_uid = :'uid' AND revoked_at IS NULL AND expires_at > NOW()`, {
    hash: tokenHash,
    uid: identity.uid,
  });
  assert.equal(storedHash, tokenHash);
  assert.notEqual(storedHash, cookieValue);
  const schemaColumns = await databaseQuery('session_cookie_absent_from_database', `
    SELECT array_agg(column_name::text ORDER BY ordinal_position)::text
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'cms_editor_sessions'`);
  assert.equal(schemaColumns, '{token_hash,user_uid,expires_at,revoked_at,created_at}');
  const runtimeConnections = await databaseQuery('api_uses_portal_api_role', `
    SELECT EXISTS (SELECT 1 FROM pg_stat_activity
      WHERE datname = current_database() AND usename = 'portal_api' AND backend_type = 'client backend')`);
  assert.equal(runtimeConnections, 't');
  record('database_stores_only_sha256_hash_and_api_connects_as_portal_api');

  stage = 'http_resolve_session';
  const cookieHeader = `${cookieName}=${cookieValue}`;
  const resolved = await apiRequest(apiOrigin, '/api/cms/v2/session', { cookie: cookieHeader });
  assert.equal(resolved.status, 200);
  const resolvedBody = await readResponse(resolved);
  assert.equal(resolvedBody?.actor?.uid, identity.uid);
  assert.equal(resolvedBody?.actor?.capabilities?.manageAcademy, true);

  stage = 'private_http_resolve_session';
  const privateResolved = await apiRequest(apiOrigin, '/api/internal/editorial/admin/session/resolve', {
    method: 'POST', cookie: undefined, body: { cookie: cookieValue }, internal: true,
  });
  assert.equal(privateResolved.status, 200);
  const privateBody = await readResponse(privateResolved);
  assert.equal(privateBody?.actor?.uid, identity.uid);
  assert.equal(privateBody?.actor?.capabilities?.manageBenefits, true);
  record('http_200_public_and_private_session_resolution');

  const updatedIdentity = await databaseQuery('permission_reload_seed', `
    UPDATE users SET permissions = jsonb_build_object('manageAcademy', false, 'manageBenefits', true)
    WHERE uid = :'uid' RETURNING uid`, { uid: identity.uid });
  assert.equal(updatedIdentity, identity.uid);
  const reloaded = await apiRequest(apiOrigin, '/api/cms/v2/session', { cookie: cookieHeader });
  assert.equal(reloaded.status, 200);
  const reloadedBody = await readResponse(reloaded);
  assert.equal(reloadedBody?.actor?.capabilities?.manageAcademy, false);
  assert.equal(reloadedBody?.actor?.capabilities?.manageBenefits, true);
  record('permissions_reloaded_from_portal_database');

  stage = 'force_fixture_session_expiry';
  const expired = await databaseQuery(stage, `
    UPDATE cms_editor_sessions SET expires_at = NOW() - INTERVAL '1 second'
    WHERE token_hash = :'hash' AND user_uid = :'uid' AND revoked_at IS NULL
    RETURNING token_hash`, { hash: tokenHash, uid: identity.uid });
  assert.equal(expired, tokenHash);
  const expiredState = await databaseQuery('verify_session_expired_not_revoked', `
    SELECT (expires_at <= NOW())::text || '|' || (revoked_at IS NULL)::text
    FROM cms_editor_sessions WHERE token_hash = :'hash' AND user_uid = :'uid'`, {
    hash: tokenHash,
    uid: identity.uid,
  });
  assert.equal(expiredState, 't|t');
  const expiredResolution = await apiRequest(apiOrigin, '/api/cms/v2/session', { cookie: cookieHeader });
  assert.equal(expiredResolution.status, 401);
  const privateExpiredResolution = await apiRequest(apiOrigin, '/api/internal/editorial/admin/session/resolve', {
    method: 'POST', body: { cookie: cookieValue }, internal: true,
  });
  assert.equal(privateExpiredResolution.status, 401);
  record('expired_unrevoked_session_rejected_by_public_and_private_routes');

  stage = 'http_issue_fresh_session_for_revocation';
  const freshIssue = await apiRequest(apiOrigin, '/api/cms/v2/session', {
    method: 'POST', token: identity.idToken, body: {},
  });
  assert.equal(freshIssue.status, 201);
  httpIssuanceCount += 1;
  const freshIssueBody = await readResponse(freshIssue);
  assert.equal(freshIssueBody?.actor?.capabilities?.manageAcademy, false);
  assert.equal(freshIssueBody?.actor?.capabilities?.manageBenefits, true);
  const freshSetCookies = freshIssue.headers.getSetCookie();
  assert.equal(freshSetCookies.length, 1);
  const freshSetCookie = freshSetCookies[0];
  const freshCookiePair = freshSetCookie.split(';', 1)[0];
  const freshCookieName = freshCookiePair.split('=', 1)[0];
  const freshCookieValue = freshCookiePair.slice(freshCookieName.length + 1);
  assert.equal(freshCookieName, cookieName);
  assert.ok(freshCookieValue.length > 32);
  const freshCookieHeader = `${freshCookieName}=${freshCookieValue}`;
  const freshTokenHash = createHash('sha256').update(freshCookieValue).digest('hex');
  const sessionCountAfterFreshIssue = await databaseQuery('fresh_issuance_session_count',
    'SELECT COUNT(*)::text FROM cms_editor_sessions WHERE user_uid = :\'uid\'', { uid: identity.uid });
  const expiredHashPresent = await databaseQuery('verify_expired_session_removed_on_fresh_issue', `
    SELECT EXISTS (SELECT 1 FROM cms_editor_sessions
      WHERE token_hash = :'hash' AND user_uid = :'uid')`, {
    hash: tokenHash,
    uid: identity.uid,
  });
  const persistedFreshState = await databaseQuery('verify_fresh_session_persisted', `
    SELECT token_hash || '|' || (expires_at > NOW())::text || '|' || (revoked_at IS NULL)::text
    FROM cms_editor_sessions WHERE token_hash = :'hash' AND user_uid = :'uid'`, {
    hash: freshTokenHash,
    uid: identity.uid,
  });
  assert.equal(httpIssuanceCount, 2, 'the public session route issued exactly two HTTP sessions');
  assert.equal(validateExpiredSessionReplacement({
    baselineCount: Number(sessionCountBefore),
    databaseCount: Number(sessionCountAfterFreshIssue),
    expiredHashPresent: expiredHashPresent === 't',
    freshHash: freshTokenHash,
    persistedFreshState,
  }), true);
  const freshResolved = await apiRequest(apiOrigin, '/api/cms/v2/session', { cookie: freshCookieHeader });
  assert.equal(freshResolved.status, 200);
  const freshResolvedBody = await readResponse(freshResolved);
  assert.equal(freshResolvedBody?.actor?.uid, identity.uid);
  assert.equal(freshResolvedBody?.actor?.capabilities?.manageAcademy, false);
  assert.equal(freshResolvedBody?.actor?.capabilities?.manageBenefits, true);
  record('second_fresh_session_uses_reloaded_permissions_and_is_unexpired_unrevoked');

  stage = 'http_revoke_session';
  const revoked = await apiRequest(apiOrigin, '/api/cms/v2/session', {
    method: 'DELETE', cookie: freshCookieHeader, body: {},
  });
  assert.equal(revoked.status, 204);
  const clearCookies = revoked.headers.getSetCookie();
  assert.equal(clearCookies.length, 1);
  const clearCookie = clearCookies[0];
  assert.equal(clearCookie.split(';', 1)[0], `${cookieName}=`);
  assert.match(clearCookie, /(?:^|;\s*)Expires=Thu, 01 Jan 1970 00:00:00 GMT(?:;|$)/i);
  assert.match(clearCookie, /(?:^|;\s*)Secure(?:;|$)/i);
  assert.match(clearCookie, /(?:^|;\s*)HttpOnly(?:;|$)/i);
  assert.match(clearCookie, /(?:^|;\s*)Path=\/(?:;|$)/i);
  assert.match(clearCookie, /(?:^|;\s*)SameSite=Lax(?:;|$)/i);
  assert.doesNotMatch(clearCookie, /(?:^|;\s*)Domain=/i);
  const revokedState = await databaseQuery('verify_session_revoked_before_expiry', `
    SELECT (expires_at > NOW())::text || '|' || (revoked_at IS NOT NULL)::text
    FROM cms_editor_sessions WHERE token_hash = :'hash' AND user_uid = :'uid'`, {
    hash: freshTokenHash,
    uid: identity.uid,
  });
  assert.equal(revokedState, 't|t');
  const stale = await apiRequest(apiOrigin, '/api/cms/v2/session', { cookie: freshCookieHeader });
  assert.equal(stale.status, 401);
  const privateStale = await apiRequest(apiOrigin, '/api/internal/editorial/admin/session/resolve', {
    method: 'POST', body: { cookie: freshCookieValue }, internal: true,
  });
  assert.equal(privateStale.status, 401);
  record('future_expiring_revoked_session_clears_cookie_and_old_cookie_fails_public_and_private');

  const sessionCountBeforeRefusal = await databaseQuery('refusal_baseline_session_count',
    'SELECT COUNT(*)::text FROM cms_editor_sessions WHERE user_uid = :\'uid\'', { uid: identity.uid });
  assert.equal(Number(sessionCountBeforeRefusal), Number(sessionCountBefore) + 1);
  await dockerCompose('disable_readiness_fixture', ['stop', 'readiness']);
  const refused = await apiRequest(apiOrigin, '/api/cms/v2/session', {
    method: 'POST', token: identity.idToken, body: {},
  });
  assert.equal(refused.status, 503);
  const sessionCountAfterRefusal = await databaseQuery('refusal_session_count',
    'SELECT COUNT(*)::text FROM cms_editor_sessions WHERE user_uid = :\'uid\'', { uid: identity.uid });
  assert.equal(sessionCountAfterRefusal, sessionCountBeforeRefusal);
  assert.equal(httpIssuanceCount, 2, 'readiness refusal does not add an HTTP session issuance');
  record('unavailable_readiness_refuses_issuance_without_session_write');

  const authorityAfter = await databaseQuery('authority_after_session_flow',
    'SELECT mode || \'|\' || epoch::text FROM owner_news_authority WHERE singleton = TRUE');
  assert.equal(authorityAfter, authorityBefore);
  assert.equal(authorityAfter, 'legacy|1');
  record('legacy_authority_epoch_unchanged');
}

async function writeReport(status, failedCheck = null) {
  const reportDirectory = path.resolve(process.env.RUNNER_TEMP || os.tmpdir());
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = path.join(reportDirectory, reportName);
  const contents = {
    schemaVersion: 1,
    component: 'editorial-admin-session-v2',
    status,
    checks: safeChecks,
    failedCheck,
    fixtureProjectName: projectName || null,
    fixtureResourceState: resourceState,
  };
  await writeFile(reportPath, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  return reportPath;
}

let failure = null;
try {
  await runIntegration();
} catch {
  failure = stage;
} finally {
  const finalization = await finalizeFixture({
    failed: Boolean(failure),
    fixtureStarted: fixtureMayExist,
    cleanup: async () => dockerCompose('fixture_cleanup', [
      'down', '--rmi', 'local', '--volumes', '--remove-orphans', '--timeout', '10',
    ], { timeoutMs: 60000, capture: false }),
    removePrivateFiles: async () => {
      if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
    },
  });
  resourceState = finalization.resourceState;
  bridgeSecret = undefined;
  if (finalization.cleanupFailed && !failure) failure = 'fixture_cleanup';
}

try {
  const reportPath = await writeReport(failure ? 'failed' : 'passed', failure);
  if (failure) {
    console.error(`editorial admin session integration failed at ${failure}; redacted report: ${reportPath}`);
    process.exitCode = 1;
  } else {
    console.log('editorial admin session integration: passed; redacted report recorded');
  }
} catch {
  console.error(`editorial admin session integration failed at ${failure || 'report_write'}; redacted report unavailable`);
  process.exitCode = 1;
}
