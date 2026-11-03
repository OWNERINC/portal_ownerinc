import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCompose, fail, fixtureIdentity, hash } from '../../scripts/integration/payload-functional-fixture.mjs';
import * as targets from '../../scripts/integration/payload-functional-targets.mjs';
import * as isolation from '../../scripts/integration/payload-functional-isolation.mjs';
import { functionalCases, newFunctionalReport, runFunctionalCase, finishFunctionalReport } from '../../cms/tests/integration/functional-matrix.mjs';
import { readFunctionalConfig } from '../../cms/tests/support/integration-config.mjs';
import { functionalBaseImages } from '../../scripts/integration/payload-functional-base-images.mjs';
import { functionalMigrationDiagnostic, validateFunctionalMigrationDiagnostic } from '../../scripts/integration/payload-functional-diagnostics.mjs';
import { fixtureEnvironment, executionReserve, qualifyEditorial, editorialFailureDetail,
  validateEditorialFailureReport } from '../../scripts/integration/payload-editorial-ci.mjs';

const source = await readFile(new URL('../../scripts/integration/payload-functional-run.mjs', import.meta.url), 'utf8');
// Execute the actual runner AND private wait/binding/digest/cleanup/report helpers.
// Only imported I/O dependencies are doubled; there is no production test API.
const body = source.slice(source.indexOf('const delay=')).replace('export async function executeFunctionalLease', 'async function executeFunctionalLease');
const canary = 'PRIVATE_PARENT_DIAGNOSTIC_CANARY';
const children = ['portal-migrate', 'cms-provision', 'cms-migrate'];
const childOperations = ['pre-role-forwarder-health', 'database-bindings', 'portal-system-identity', 'cms-system-identity', 'compose-up', 'role-bindings'];
const pairs = [...children.flatMap(role => childOperations.map(operation => [role, operation])),
  ...['news-digest', 'authority-baseline', 'pre-runtime-forwarder-health'].map(operation => ['post-migrations', operation])];
const systemQuery = 'SELECT system_identifier::text FROM pg_control_system();';
const failure = code => Object.assign(new Error(canary), { code, cause: canary, stderr: canary, sql: canary });

function runnerFixture(options = {}) {
  const { at, mismatch, digestFailure, cleanupFails = false, signal = false, outside, phase = 'editorial' } = options;
  const error = Object.hasOwn(options, 'error') ? options.error : failure('functional_process_failed');
  const parent = path.join(process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir(), 'functional-parent-no-io');
  const env = fixtureEnvironment({ PATH: process.env.PATH, HOME: parent, GITHUB_SHA: 'a'.repeat(40),
    PAYLOAD_FUNCTIONAL_PRIVATE_PARENT: parent, PAYLOAD_FUNCTIONAL_CERTIFICATE: path.join(parent, 'cert.pem'),
    PAYLOAD_FUNCTIONAL_PRIVATE_KEY: path.join(parent, 'key.pem'), PAYLOAD_FUNCTIONAL_PLAYWRIGHT_MODULE: path.join(parent, 'tools', 'index.mjs'),
    PAYLOAD_FUNCTIONAL_BROWSER_EXECUTABLE: path.join(parent, 'chromium'), PAYLOAD_FUNCTIONAL_API_IMAGE: `sha256:${'1'.repeat(64)}`,
    PAYLOAD_FUNCTIONAL_CMS_IMAGE: `sha256:${'2'.repeat(64)}`, PAYLOAD_FUNCTIONAL_EMULATOR_IMAGE: `sha256:${'3'.repeat(64)}` });
  const config = readFunctionalConfig(env), identity = fixtureIdentity('134cfd81-7f0d-47ca-a4fb-c9cabd069c0f');
  const directory = path.join(parent, identity.project), leasePath = path.join(directory, 'lease.json');
  const binding = { commit: config.commit, diffHash: hash(''), sourceHash: 'b'.repeat(64) };
  const lease = { identity, directory, phase, config: { ...config, phase }, binding };
  const secrets = Object.fromEntries(['portalAdmin', 'portalRuntime', 'portalCron', 'cmsCluster', 'cmsAdmin', 'cmsMigrator',
    'cmsRuntime', 'cmsController', 'cmsObserver', 'payload', 'toPortal', 'toPayload', 'bulk'].map(key => [key, 'f'.repeat(64)]));
  const runtimeLease = { ...lease, config: { ...lease.config, httpsPort: 19443 }, directory: path.join(directory, 'runtime') };
  runtimeLease.manifest = buildCompose(identity, runtimeLease.config, runtimeLease.directory, secrets);
  const images = { api: config.apiImage, cms: config.cmsImage, emulator: config.emulatorImage,
    postgres: functionalBaseImages.postgres.platforms.amd64.configDigest, nginx: functionalBaseImages.nginx.platforms.amd64.configDigest };
  const labels = role => ({ 'com.docker.compose.project': identity.project, 'ownerinc.functional.run': identity.runId, 'ownerinc.functional.role': role });
  const network = { Name: `${identity.project}-network`, Id: 'd'.repeat(64), Driver: 'bridge', Scope: 'local', Internal: true, Labels: labels('network') };
  const stores = { portal: { database: identity.portalDatabase, role: 'portal_admin', systemIdentifier: '1234567890123456', serverAddress: '172.20.0.2', serverPort: 5432, empty: true },
    cms: { database: identity.cmsDatabase, role: phase === 'editorial' ? 'cms_cluster' : 'cms_admin', systemIdentifier: '2234567890123456', serverAddress: '172.20.0.3', serverPort: 5432, empty: true } };
  const containers = Object.fromEntries(Object.keys(identity.containers).map(role => {
    const imageRole = role.endsWith('-db') ? 'postgres' : ['portal-migrate', 'api'].includes(role) ? 'api'
      : ['cms-provision', 'cms-migrate', 'cms'].includes(role) ? 'cms' : role;
    const mount = { 'portal-db': ['portal-db', '/var/lib/postgresql/data'], 'cms-db': ['cms-db', '/var/lib/postgresql/data'],
      api: ['portal-uploads', '/app/uploads'], cms: ['cms-uploads', '/var/lib/ownerinc-cms/media'] }[role];
    return [identity.containers[role], { Name: '/' + identity.containers[role], Image: images[imageRole],
      Config: { Labels: labels(role), Env: Object.entries(runtimeLease.manifest.services[role].environment || {}).map(([k, v]) => `${k}=${v}`) },
      HostConfig: { NetworkMode: network.Name }, NetworkSettings: { Ports: {}, Networks: { [network.Name]: {
        NetworkID: network.Id, IPAddress: stores[role.split('-')[0]]?.serverAddress || '172.20.0.4' } } },
      Mounts: mount ? [{ Type: 'volume', Name: identity.volumes[mount[0]], Destination: mount[1], RW: true }] : [] }];
  }));
  const trace = [], persisted = [], processDouble = new EventEmitter();
  let cleaning = false, health = 0, networkChecks = 0, currentRole, digestQueries = 0, fired = 0, signalSent = false;
  const mark = (kind, ...values) => trace.push({ cleaning, kind, values });
  const boundary = (role, operation) => {
    mark('boundary', role, operation);
    if (signal && !signalSent) { signalSent = true; processDouble.emit('SIGTERM'); }
    if (at?.[0] === role && at[1] === operation) { fired++; throw error; }
  };
  const forwarder = { origin: 'https://127.0.0.1:19443', pid: 4242,
    assertHealthy() {
      if (health++ === 0) { mark('initial-health'); return; }
      const index = health - 2;
      if (index < 3) { currentRole = children[index]; boundary(currentRole, 'pre-role-forwarder-health'); }
      else boundary('post-migrations', 'pre-runtime-forwarder-health');
    },
    async stop() { cleaning = true; mark('forwarder-stop'); if (cleanupFails) throw failure('functional_forwarder_still_running'); },
    assertStopped() { mark('forwarder-stopped'); },
    async activate() { mark('activate'); if (outside === 'inspected_internal_nginx_binding') throw error; return { target: 'synthetic' }; },
    async recheck() { mark('recheck'); },
  };
  const docker = async args => {
    mark('docker', args);
    if (args[0] === 'network') {
      const index = networkChecks++;
      if (index >= 1 && index <= 6) boundary(children[Math.floor((index - 1) / 2)], index % 2 ? 'database-bindings' : 'role-bindings');
      return JSON.stringify([network]);
    }
    if (args[0] === 'inspect') return JSON.stringify([containers[args[1]]]);
    if (args[0] === 'volume') {
      const role = Object.keys(identity.volumes).find(role => identity.volumes[role] === args[2]);
      return JSON.stringify([{ Name: args[2], Driver: 'local', Labels: labels(role) }]);
    }
    if (args[0] === 'ps') return 'owned-container-id';
    assert.fail('unexpected doubled docker call');
  };
  const compose = async (args, options) => {
    mark('compose', args, options);
    if (args[0] === 'config') {
      if (outside === 'resolved_fixture_configuration') throw error;
      const resolved = structuredClone(runtimeLease.manifest);
      for (const service of Object.values(resolved.services)) service.networks = { fixture: {} };
      return JSON.stringify(resolved);
    }
    if (args[0] === 'ps') return args.includes('--status') ? '' : JSON.stringify({ Health: 'healthy' });
    if (args[0] === 'stop') { if (cleanupFails) throw failure('functional_process_timeout'); return ''; }
    if (args[0] === 'up') {
      if (args.includes('--exit-code-from')) boundary(args.at(-1), 'compose-up');
      if (outside === 'real_runtime_start' && args.includes('nginx')) throw error;
      return '';
    }
    assert.equal(args[0], 'exec');
    const store = args[2].startsWith('portal') ? 'portal' : 'cms', sql = options.input.slice(0, -1);
    if (sql.startsWith('SELECT json_build_object')) return JSON.stringify(stores[store]);
    if (sql === systemQuery) {
      boundary(currentRole, `${store}-system-identity`);
      return mismatch === `${currentRole}/${store}` ? '9999999999999999' : stores[store].systemIdentifier;
    }
    if (sql.includes('SELECT c.relname')) boundary('post-migrations', 'news-digest');
    if (++digestQueries === digestFailure) throw error;
    if (sql.includes('SELECT c.relname')) return mismatch === 'inventory' ? 'private_table' : 'news_articles\nnews_media';
    if (sql.includes('mode||')) return mismatch === 'authority' ? 'native|2' : 'legacy|1';
    return 'synthetic rows';
  };
  const deps = { assert: { ...assert, equal(actual, expected, ...args) {
    if (expected === 'legacy|1') boundary('post-migrations', 'authority-baseline');
    return assert.equal(actual, expected, ...args);
  } }, path, hash, fail, functionalMigrationDiagnostic, ...targets, ...isolation,
  newFunctionalReport, runFunctionalCase, finishFunctionalReport, process: processDouble,
  readFunctionalLease: async () => lease,
  reserveFunctionalForwarder: async () => { if (outside === 'loopback_listener_reservation') throw error; return forwarder; },
  materializeFunctionalRuntime: async () => runtimeLease,
  dockerPreflight: async () => ({ docker, images, imageEnvironments: Object.fromEntries(Object.keys(images).map(key => [key, {}])) }),
  composeClient: () => compose, functionalNginxVerifier: () => () => assert.fail('no socket verifier runs'),
  httpsFixtureClient: () => ({}), readFile: async () => Buffer.from('synthetic-certificate'),
  assertFunctionalHTTPSReadiness: async (_client, _forwarder, options) => {
    mark('readiness', options); if (outside === 'real_https_readiness') throw error;
    return { listenerObserved: true, tlsVerifiedReadiness: true };
  }, createSyntheticAccounts: async () => ({}),
  runEditorialContracts: async ({ report }) => {
    if (outside === 'editorial_browser_contracts') throw error;
    report.editorialAdmission = { kind: 'synthetic-fixture-only', productionGateE: false, protocol: 'canonical-finalizer-fixture-empty-baseline' };
    for (const contract of functionalCases.filter(item => item.phase === 'editorial')) {
      await runFunctionalCase(report, contract.scenarioId, async () => contract.requiredChecks.map(check => ({ check, passed: true })));
    }
  }, runSessionContracts: () => assert.fail('not a preauthority success probe'), runBrowserContracts: () => assert.fail('no browser runs'),
  open: async (filename, flags, mode) => {
    mark('persist-open', filename, flags, mode);
    return { writeFile: async raw => persisted.push(JSON.parse(raw)), sync: async () => mark('persist-sync'), close: async () => mark('persist-close') };
  } };
  const execute = new Function(...Object.keys(deps), `${body}\nreturn executeFunctionalLease;`)(...Object.values(deps));
  let result, notBefore;
  return { trace, persisted, lease, images, get fired() { return fired; },
    async run() {
      notBefore = Date.now(); result = await execute(leasePath, env);
      assert.equal(processDouble.listenerCount('SIGINT'), 0); assert.equal(processDouble.listenerCount('SIGTERM'), 0);
      assert.deepEqual(persisted, [result.report]);
      assert.deepEqual(trace.filter(item => item.kind.startsWith('persist')).map(item => item.kind), ['persist-open', 'persist-sync', 'persist-close']);
      return result;
    },
    expected() { return { runId: identity.runId, source: binding, images, notBefore, notAfter: Date.now() + 1000 }; },
    async publicFailure() {
      let calls = 0;
      const expected = this.expected();
      const caught = await qualifyEditorial(env, { deadline: expected.notAfter + executionReserve,
        now: () => calls ? expected.notAfter : notBefore, binding: async () => binding,
        read: async name => name === leasePath ? lease : persisted[0],
        run: async () => ++calls === 1
          ? { code: 0, stdout: `payload-functional: PREPARED; services not contacted; acceptance INCOMPLETE\nlease: ${leasePath}\n`, stderr: '' }
          : { code: result.code, stderr: canary, stdout: canary },
      }).then(() => assert.fail('failure promoted'), error => error);
      assert.equal(calls, 2); assert.equal(caught.message, 'runner_failed');
      assert.ok(!editorialFailureDetail(caught).includes(canary));
      return editorialFailureDetail(caught);
    },
  };
}

test('actual runner success preserves operation order, SQL roles, commands, timeouts and the 4/44 inventory', async () => {
  const f = runnerFixture(), { code, report } = await f.run();
  assert.equal(code, 2); assert.equal(report.failure, undefined); assert.equal(report.productionValidated, false);
  assert.equal(report.cases.filter(item => item.status === 'PASS').length, 4);
  assert.equal(report.cases.filter(item => item.status === 'INCOMPLETE').length, 44);
  assert.deepEqual(f.trace.filter(item => item.kind === 'boundary').map(item => item.values), pairs);
  const commands = f.trace.filter(item => item.kind === 'compose').map(item => item.values);
  assert.deepEqual(commands.filter(([args]) => args[0] === 'up'), [
    [['up', '--detach', '--no-build', '--pull', 'never', 'portal-db', 'cms-db', 'emulator'], { timeout: 120000 }],
    ...children.map(role => [['up', '--no-build', '--pull', 'never', '--abort-on-container-exit', '--exit-code-from', role, role], { timeout: 240000 }]),
    [['up', '--detach', '--no-build', '--pull', 'never', 'api', 'cms', 'nginx'], { timeout: 120000 }],
  ]);
  assert.deepEqual(commands.find(([args]) => args[0] === 'stop'),
    [['stop', '--timeout', '30', ...Object.keys(f.lease.identity.containers)], { timeout: 330000 }]);
  const sql = commands.filter(([args]) => args[0] === 'exec');
  assert.equal(sql.length, 13); // two physical checks, six identities, whole five-query digest
  for (const [args, options] of sql) {
    const portal = args[2] === 'portal-db';
    assert.deepEqual(args, ['exec', '-T', portal ? 'portal-db' : 'cms-db', 'sh', '-ec',
      'export PGPASSWORD="$POSTGRES_PASSWORD"; exec psql -h "$HOSTNAME" "$@"', 'sh', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
      '-U', portal ? 'portal_admin' : 'cms_cluster', '-d', portal ? f.lease.identity.portalDatabase : f.lease.identity.cmsDatabase, '-f', '-']);
    assert.deepEqual(Object.keys(options), ['input']); assert.ok(options.input.endsWith('\n'));
  }
  assert.deepEqual(sql.slice(2, 8).map(([, options]) => options.input), Array(6).fill(systemQuery + '\n'));
});

for (const [role, operation] of pairs) test(`actual runner captures ${role}/${operation}, stops execution, persists and formats the original failure`, async () => {
  const baseline = runnerFixture(); await baseline.run();
  const f = runnerFixture({ at: [role, operation], cleanupFails: true }), { code, report } = await f.run();
  assert.equal(code, 1); assert.equal(f.fired, 1);
  assert.deepEqual(report.failure, { stage: 'explicit_fixture_migrations', reason: 'functional_execution_failed', role, operation, cause: 'functional_process_failed' });
  assert.equal(report.cleanup, 'owned_stop_failed_preserved'); assert.equal(report.transportCleanup, 'owned_listener_stop_failed');
  assert.ok(report.cases.every(item => item.status === 'INCOMPLETE')); assert.equal(report.productionValidated, false);
  const prior = baseline.trace.filter(item => !item.cleaning), actual = f.trace.filter(item => !item.cleaning);
  const index = prior.findIndex(item => item.kind === 'boundary' && item.values[0] === role && item.values[1] === operation);
  assert.deepEqual(actual, prior.slice(0, index + 1), 'no subsequent execution command after the failing boundary');
  assert.deepEqual(validateEditorialFailureReport(report, f.expected()), { ...report.failure, cleanup: report.cleanup, transportCleanup: report.transportCleanup });
  const detail = await f.publicFailure();
  assert.ok(detail.endsWith(`; runnerRole=${role}; runnerOperation=${operation}; runnerCause=functional_process_failed`));
  assert.ok(detail.includes('reportedCleanup=owned_stop_failed_preserved'));
});

test('actual identity and authority assertions and every digest SQL failure retain their parent boundary', async () => {
  for (const role of children) for (const store of ['portal', 'cms']) {
    const f = runnerFixture({ mismatch: `${role}/${store}` }), { report } = await f.run();
    assert.deepEqual(report.failure, { stage: 'explicit_fixture_migrations', reason: 'functional_execution_failed', role,
      operation: `${store}-system-identity`, cause: 'assertion_failed' });
  }
  for (const [mismatch, operation, cause] of [['authority', 'authority-baseline', 'assertion_failed'],
    ['inventory', 'news-digest', 'functional_news_inventory_invalid']]) {
    const f = runnerFixture({ mismatch }), { report } = await f.run();
    assert.deepEqual(report.failure, { stage: 'explicit_fixture_migrations', reason: 'functional_execution_failed', role: 'post-migrations', operation, cause });
  }
  for (let digestFailure = 1; digestFailure <= 5; digestFailure++) {
    const f = runnerFixture({ digestFailure }), { report } = await f.run();
    assert.equal(report.failure.role, 'post-migrations'); assert.equal(report.failure.operation, 'news-digest');
  }
});

test('other stages and signal-only failure retain historical shape with no stale migration role', async () => {
  for (const outside of ['loopback_listener_reservation', 'resolved_fixture_configuration', 'real_runtime_start',
    'inspected_internal_nginx_binding', 'real_https_readiness', 'editorial_browser_contracts']) {
    const f = runnerFixture({ outside }), { report } = await f.run();
    assert.deepEqual(report.failure, { stage: outside, reason: 'functional_execution_failed' });
  }
  const interrupted = runnerFixture({ signal: true }), { report } = await interrupted.run();
  assert.deepEqual(report.failure, { stage: 'runner_interrupted', reason: 'functional_execution_interrupted' });
  const primary = runnerFixture({ signal: true, at: ['portal-migrate', 'pre-role-forwarder-health'] });
  assert.equal((await primary.run()).report.failure.role, 'portal-migrate');
  const preauthority = runnerFixture({ phase: 'preauthority', at: ['cms-migrate', 'compose-up'] });
  assert.equal((await preauthority.run()).report.failure.operation, 'compose-up');
  const cleanupOnly = runnerFixture({ cleanupFails: true });
  assert.deepEqual((await cleanupOnly.run()).report.failure, { stage: 'owned_forwarder_stop', reason: 'functional_transport_cleanup_failed' });
});

test('cause classification reads only allowlisted own data; hostile errors never replace the primary stage or expose private data', async () => {
  let touched = 0;
  const trap = () => { touched++; throw new Error(canary); };
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const errors = [new Error(canary), canary, null, undefined, 1, Symbol(canary), Object.create({ code: 'functional_process_failed' }),
    Object.defineProperty({}, 'code', { get: trap }), { code: { toString: trap, [Symbol.toPrimitive]: trap } },
    new Proxy({}, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap }), revoked.proxy,
    failure('functional_process_failed\n'), failure('functional_attacker_value'), failure('ERR_ASSERTION_private')];
  for (const error of errors) {
    const f = runnerFixture({ at: ['cms-provision', 'compose-up'], error, cleanupFails: true });
    const { report } = await f.run();
    assert.equal(report.failure.cause, 'unexpected_failure'); assert.equal(report.failure.role, 'cms-provision');
    assert.ok(!JSON.stringify(report).includes(canary));
  }
  for (const code of ['functional_process_unavailable', 'functional_process_timeout', 'functional_process_output_limit', 'functional_process_failed', 'ERR_ASSERTION']) {
    const error = Object.defineProperties({ code }, { message: { get: trap }, cause: { get: trap }, toString: { value: trap } });
    const f = runnerFixture({ at: ['cms-migrate', 'compose-up'], error, cleanupFails: true });
    assert.equal((await f.run()).report.failure.cause, code === 'ERR_ASSERTION' ? 'assertion_failed' : code);
  }
  assert.equal(touched, 0);
});

test('all guard causes are grounded in the actual producer sources and tuple validation is closed', async () => {
  const helper = await readFile(new URL('../../scripts/integration/payload-functional-diagnostics.mjs', import.meta.url), 'utf8');
  const guards = [...helper.slice(helper.indexOf('const guardCodes'), helper.indexOf('const causes')).matchAll(/'([a-z_]+)'/gu)].map(match => match[1]);
  const producers = (await Promise.all(['payload-functional-run.mjs', 'payload-functional-targets.mjs', 'payload-functional-isolation.mjs',
    'payload-functional-forwarder.mjs'].map(name => readFile(new URL(`../../scripts/integration/${name}`, import.meta.url), 'utf8')))).join('\n');
  for (const code of guards) {
    assert.ok(producers.includes(`'${code}'`), code);
    assert.equal(functionalMigrationDiagnostic('portal-migrate', 'database-bindings', failure(code)).cause, code);
  }
  const processSource = await readFile(new URL('../../scripts/integration/payload-functional-fixture.mjs', import.meta.url), 'utf8');
  const processCodes = [...helper.slice(helper.indexOf('const processCodes'), helper.indexOf('const guardCodes')).matchAll(/'(functional_process_[a-z_]+)'/gu)].map(match => match[1]);
  assert.equal(processCodes.length, 4);
  for (const code of processCodes) assert.ok(processSource.includes(`'${code}'`), code);
  assert.equal(functionalMigrationDiagnostic('cms', 'compose-up', failure('functional_process_failed')), null);
  for (const role of [...children, 'post-migrations']) for (const operation of [...childOperations, 'news-digest', 'authority-baseline', 'pre-runtime-forwarder-health']) {
    const valid = pairs.some(pair => pair[0] === role && pair[1] === operation);
    assert.equal(Boolean(validateFunctionalMigrationDiagnostic({ role, operation, cause: 'unexpected_failure' })), valid);
  }
  const tuple = { role: 'post-migrations', operation: 'news-digest', cause: 'unexpected_failure' };
  for (const value of [{ ...tuple, cause: 'functional_arbitrary_private' }, { ...tuple, private: canary }, { ...tuple, operation: undefined },
    Object.assign(Object.create({ role: tuple.role }), { operation: tuple.operation, cause: tuple.cause }),
    Object.defineProperty({ ...tuple }, 'cause', { get() { assert.fail('getter invoked'); } })]) {
    assert.equal(validateFunctionalMigrationDiagnostic(value), null);
  }
});
