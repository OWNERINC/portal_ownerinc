import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { normalizePgDumpForSnapshot } from './payload-preauthority-fixture.mjs';

export const PG16_IMAGE = 'postgres:16-alpine@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777';
const scope = 'payload-legacy-security-pg16';
const maxOutput = 4 * 1024 * 1024;
const bridge = fileURLToPath(new URL('./payload-legacy-security-pg16-bridge.py', import.meta.url));

export function guardEnvironment(env = process.env, platform = process.platform) {
  assert.equal(platform, 'linux');
  assert.equal(env.PAYLOAD_LEGACY_SECURITY_DISPOSABLE, '1');
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.match(env.GITHUB_RUN_ID || '', /^[1-9][0-9]{0,19}$/u);
  assert.match(env.GITHUB_RUN_ATTEMPT || '', /^[1-9][0-9]{0,19}$/u);
  assert.ok(!env.DOCKER_HOST && !env.DOCKER_CONTEXT);
}

export function boundedCommand(program, args, { input, limit = maxOutput, timeout = 30_000 } = {}) {
  const result = spawnSync(program, args, { input, encoding: 'utf8', timeout, maxBuffer: limit,
    killSignal: 'SIGKILL', windowsHide: true });
  if (result.error || result.signal || result.status !== 0 || Buffer.byteLength(result.stdout || '') > limit) {
    throw new Error('legacy_security_qualification_command_failed');
  }
  return result.stdout;
}

export function ownedContainer(value, name, nonce) {
  assert.match(name, /^payload-legacy-security-pg16-[1-9][0-9]*-[1-9][0-9]*-[a-f0-9]{24}$/u);
  assert.match(nonce, /^[a-f0-9]{24}$/u);
  assert.ok(name.endsWith(`-${nonce}`));
  assert.match(value.Id, /^[a-f0-9]{64}$/u);
  assert.equal(value.Name, `/${name}`);
  assert.equal(value.Config.Image, PG16_IMAGE);
  assert.equal(value.Config.Labels['io.ownerinc.test-scope'], scope);
  assert.equal(value.Config.Labels['io.ownerinc.test-nonce'], nonce);
  assert.equal(value.HostConfig.NetworkMode, 'none');
  assert.equal(value.HostConfig.ReadonlyRootfs, true);
  assert.ok(!value.HostConfig.Binds?.length);
  assert.ok(!Object.keys(value.HostConfig.PortBindings || {}).length);
  assert.ok((value.Mounts || []).every(mount => mount.Type === 'tmpfs'));
  assert.deepEqual(Object.keys(value.HostConfig.Tmpfs).sort(), ['/tmp', '/var/lib/postgresql/data', '/var/run/postgresql']);
  return value.Id;
}

export const FIXTURE_SQL = `
CREATE ROLE fixture_owner NOLOGIN;
CREATE ROLE fixture_member NOLOGIN;
CREATE ROLE portal_api LOGIN PASSWORD 'disposable-only-api-password';
CREATE ROLE portal_cron LOGIN PASSWORD 'disposable-only-cron-password';
CREATE DATABASE portal OWNER fixture_owner;
CREATE DATABASE legacy_security_other OWNER fixture_owner;
`;
const schema = `
SET ROLE fixture_owner;
CREATE TABLE public.cms_editor_sessions(id bigint);
CREATE TABLE public.user_import_jobs(id bigserial PRIMARY KEY, expires_at timestamptz);
CREATE TABLE public.fixture_null(id integer);
CREATE TABLE public.fixture_empty(id integer);
REVOKE ALL ON public.fixture_empty FROM fixture_owner;
CREATE TABLE public.fixture_public(id integer);
INSERT INTO public.user_import_jobs(expires_at) VALUES ('2030-01-01T00:00:00Z');
GRANT CONNECT ON DATABASE portal TO portal_api,portal_cron;
GRANT USAGE ON SCHEMA public TO portal_api,portal_cron;
GRANT SELECT(expires_at) ON public.user_import_jobs TO portal_cron;
GRANT USAGE,SELECT ON SEQUENCE public.user_import_jobs_id_seq TO portal_api;
GRANT SELECT ON public.fixture_public TO PUBLIC;
GRANT UPDATE ON public.fixture_public TO portal_api WITH GRANT OPTION;
CREATE FUNCTION public.fixture_function() RETURNS integer LANGUAGE sql IMMUTABLE AS 'SELECT 1';
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO portal_cron;
CREATE TABLE public.fixture_default(id integer);
RESET ROLE;
GRANT fixture_member TO portal_api WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
`;

function row(observation, kind, properties) {
  const matches = observation.records.filter(item => item.kind === kind && Object.entries(properties).every(([key, value]) => item[key] === value));
  assert.equal(matches.length, 1);
  return matches[0];
}

export async function qualify({ env = process.env, platform = process.platform, command = boundedCommand } = {}) {
  guardEnvironment(env, platform); // Before any Docker/process effect.
  assert.equal(command('docker', ['context', 'show']).trim(), 'default');
  const context = JSON.parse(command('docker', ['context', 'inspect', 'default']));
  assert.equal(context[0].Endpoints.docker.Host, 'unix:///var/run/docker.sock');
  const nonce = randomBytes(12).toString('hex');
  const name = `${scope}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${nonce}`;
  let id;
  let creationAttempted = false;
  let cleaned = false;
  let phase = 'create_cluster';
  const inspect = () => {
    const values = JSON.parse(command('docker', ['inspect', name]));
    assert.equal(values.length, 1);
    return ownedContainer(values[0], name, nonce);
  };
  const exec = (args, input, options = {}) => {
    assert.equal(inspect(), id);
    return command('docker', ['exec', '-i', id, ...args], { input, ...options });
  };
  const sql = (database, input) => {
    assert.ok(['postgres', 'portal', 'legacy_security_other'].includes(database));
    return exec(['psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], input);
  };
  const python = (mode, input) => command('python3', ['-I', '-S', '-B', bridge, mode], { input, limit: mode === '--sql' ? 128 * 1024 : 8192 });
  const compare = (observation, profileObservation) => JSON.parse(python('--check', JSON.stringify({ observation, profileObservation })));
  const fingerprint = () => {
    const hash = createHash('sha256');
    hash.update(normalizePgDumpForSnapshot(exec(['pg_dumpall', '-U', 'postgres', '--roles-only', '--no-role-passwords'])));
    for (const db of ['portal', 'legacy_security_other']) hash.update(normalizePgDumpForSnapshot(exec(['pg_dump', '-U', 'postgres', '-d', db, '--no-comments'])));
    return hash.digest('hex');
  };
  const producer = python('--sql');
  const observe = () => {
    const before = fingerprint();
    const result = JSON.parse(sql('portal', producer));
    assert.equal(fingerprint(), before, 'read-only collector changed fixture');
    return result;
  };
  const cleanup = () => {
    if (!creationAttempted || cleaned) return;
    const owned = inspect();
    if (id) assert.equal(owned, id);
    assert.equal(command('docker', ['rm', '--force', owned], { timeout: 10_000 }).trim(), owned);
    cleaned = true;
  };
  const interrupted = () => {
    try { cleanup(); } catch { /* Refuse unowned deletion; do not emit a proof. */ }
    process.exit(1);
  };
  process.once('SIGTERM', interrupted);
  process.once('SIGINT', interrupted);
  try {
    // Create a new cluster, never connect to the shared CI PostgreSQL service.
    creationAttempted = true;
    id = command('docker', ['run', '--detach', '--pull', 'never', '--name', name,
      '--label', `io.ownerinc.test-scope=${scope}`, '--label', `io.ownerinc.test-nonce=${nonce}`,
      '--network', 'none', '--read-only', '--memory', '768m', '--cpus', '1', '--pids-limit', '128',
      '--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,size=384m',
      '--tmpfs', '/var/run/postgresql:rw,nosuid,nodev,size=16m', '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m',
      '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', PG16_IMAGE]).trim();
    assert.equal(inspect(), id);
    phase = 'readiness';
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        exec(['sh', '-ceu', 'test "$(head -n 1 /var/lib/postgresql/data/postmaster.pid)" = 1; exec pg_isready -U postgres -d postgres'], undefined, { timeout: 2000 });
        ready = true; break;
      }
      catch { await delay(1000); }
    }
    assert.ok(ready, 'disposable PostgreSQL readiness failed');
    assert.equal(sql('postgres', 'SHOW server_version_num;').trim().slice(0, 2), '16');
    phase = 'fixture_setup';
    sql('postgres', FIXTURE_SQL);
    sql('portal', schema);
    sql('legacy_security_other', 'CREATE TABLE public.untouched(value integer); INSERT INTO public.untouched VALUES (42);');
    phase = 'baseline_observer';
    const base = observe();
    phase = 'baseline_assertions';
    assert.equal(row(base, 'role', { name: 'portal_api' }).login, true);
    assert.equal(row(base, 'role', { name: 'portal_api' }).superuser, false);
    const member = row(base, 'membership', { role: 'fixture_member', member: 'portal_api' });
    assert.deepEqual([member.admin, member.inherit, member.set], [false, true, false]);
    assert.equal(row(base, 'object', { objectType: 'table', name: 'fixture_null' }).aclNull, true);
    assert.equal(row(base, 'object', { objectType: 'table', name: 'fixture_empty' }).aclNull, false);
    assert.equal(row(base, 'effective', { objectType: 'column', name: 'user_import_jobs', subname: 'expires_at', role: 'portal_cron', privilege: 'SELECT' }).allowed, true);
    assert.equal(row(base, 'effective', { objectType: 'column', name: 'user_import_jobs', subname: 'expires_at', role: 'portal_cron', privilege: 'SELECT' }).grantable, false);
    assert.equal(row(base, 'effective', { objectType: 'sequence', name: 'user_import_jobs_id_seq', role: 'portal_api', privilege: 'USAGE' }).allowed, true);
    assert.equal(row(base, 'effective', { objectType: 'table', name: 'fixture_public', role: 'portal_cron', privilege: 'SELECT' }).allowed, true);
    assert.equal(row(base, 'effective', { objectType: 'table', name: 'fixture_public', role: 'portal_api', privilege: 'UPDATE' }).grantable, true);
    assert.equal(row(base, 'object', { objectType: 'default', name: 'fixture_owner', subname: 'r' }).aclNull, false);
    assert.equal(row(base, 'effective', { objectType: 'table', name: 'fixture_default', role: 'portal_cron', privilege: 'SELECT' }).allowed, true);
    assert.equal(row(base, 'object', { objectType: 'table', name: 'user_import_jobs' }).owner, 'fixture_owner');
    phase = 'baseline_comparator';
    const matched = compare(base, base); // Explicitly synthetic internal fixture profile, not approval.
    assert.equal(matched.profileMatches, true);
    for (const field of ['credentialVerified', 'clusterRoleMutationAuthorized', 'rollbackAuthorized', 'installationExecuted', 'deploymentAuthorized']) assert.equal(matched[field], false);
    assert.ok(compare(base, null).blockers.includes('legacy_capability_profile_unapproved'));
    assert.ok(matched.blockers.includes('legacy_runtime_role_membership_unsupported'));
    assert.ok(matched.blockers.includes('legacy_runtime_grant_options_unsupported'));
    phase = 'negative_fixture_setup';
    sql('portal', `ALTER ROLE portal_api CREATEDB; ALTER ROLE portal_cron SET search_path=public;
      ALTER TABLE public.fixture_public ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.fixture_empty OWNER TO portal_api;
      GRANT SELECT ON public.cms_editor_sessions TO portal_api;`);
    sql('legacy_security_other', 'GRANT SELECT ON public.untouched TO portal_cron;');
    phase = 'negative_observer';
    const changed = observe();
    phase = 'negative_comparator';
    const mismatched = compare(changed, base);
    assert.equal(mismatched.profileMatches, false);
    for (const blocker of ['legacy_runtime_role_attributes_unsafe', 'legacy_role_settings_unsupported',
      'legacy_security_mechanism_unsupported', 'legacy_runtime_role_ownership_unsupported',
      'legacy_shared_role_dependencies', 'legacy_session_capability_mismatch']) assert.ok(mismatched.blockers.includes(blocker), blocker);
    // Actual catalog overflow: 700 narrow tables exceed 20k effective records.
    // Production limits and SQL are not patched or substituted.
    phase = 'overflow_fixture_setup';
    sql('portal', `DO $$ BEGIN FOR i IN 1..700 LOOP EXECUTE format('CREATE TABLE public.overflow_%s(id integer)',i); END LOOP; END $$;`);
    phase = 'overflow_observer';
    const overflow = observe();
    assert.deepEqual(overflow, { kind: 'portal-legacy-security-observation-refused' });
    let refused = false;
    try { compare(overflow, null); } catch { refused = true; }
    assert.ok(refused);
  } catch {
    throw new Error(`legacy_security_pg16_qualification_failed:${phase}`);
  } finally {
    // Reconcile even a timed-out create; never delete by a prefix selector.
    try { cleanup(); } catch { throw new Error('legacy_security_pg16_qualification_failed:cleanup'); } finally {
      process.removeListener('SIGTERM', interrupted);
      process.removeListener('SIGINT', interrupted);
    }
  }
  assert.ok(cleaned);
  return { kind: 'legacy-security-pg16-proof', sqlProducerExecuted: true, actualValidatorComparator: true,
    readOnlyFingerprintsUnchanged: true, privilegeCasesPassed: true, overflowRefused: true,
    isolatedClusterRemoved: true, productionAuthorized: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) process.exitCode = 1;
  else qualify().then(proof => console.log(JSON.stringify(proof))).catch(error => {
    console.error(/^legacy_security_pg16_qualification_failed:[a-z_]+$/u.test(error.message)
      ? error.message : 'legacy_security_pg16_qualification_failed:guard');
    process.exitCode = 1;
  });
}
