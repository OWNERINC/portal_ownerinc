import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { guardEnvironment, ownedContainer, boundedCommand, qualify, PG16_IMAGE } from '../../scripts/integration/payload-legacy-security-pg16.mjs';

const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', PAYLOAD_LEGACY_SECURITY_DISPOSABLE: '1' };
const python = (process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'])
  .find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);

test('legacy PG16 qualification refuses non-disposable, remote and non-hosted contexts before commands', async () => {
  guardEnvironment(env, 'linux');
  for (const change of [{ PAYLOAD_LEGACY_SECURITY_DISPOSABLE: '' }, { RUNNER_ENVIRONMENT: 'self-hosted' },
    { GITHUB_ACTIONS: 'false' }, { DOCKER_HOST: 'tcp://remote' }, { DOCKER_CONTEXT: 'other' }, { GITHUB_RUN_ID: '0' }]) {
    let called = false;
    await assert.rejects(qualify({ env: { ...env, ...change }, platform: 'linux', command: () => { called = true; } }));
    assert.equal(called, false);
  }
  assert.throws(() => guardEnvironment(env, 'win32'));
});

test('cleanup ownership requires exact nonce, full ID, pinned image and isolated container shape', () => {
  const nonce = 'a'.repeat(24);
  const name = `payload-legacy-security-pg16-123-1-${nonce}`;
  const value = { Id: 'b'.repeat(64), Name: `/${name}`,
    Config: { Image: PG16_IMAGE, Labels: { 'io.ownerinc.test-scope': 'payload-legacy-security-pg16', 'io.ownerinc.test-nonce': nonce } },
    HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Binds: null, PortBindings: {}, Tmpfs: { '/var/lib/postgresql/data': 'rw', '/tmp': 'rw', '/var/run/postgresql': 'rw' } }, Mounts: [] };
  assert.equal(ownedContainer(value, name, nonce), value.Id);
  for (const mutate of [v => { v.Id = 'short'; }, v => { v.Config.Image = 'postgres:16'; },
    v => { v.Config.Labels['io.ownerinc.test-nonce'] = 'c'.repeat(24); },
    v => { v.HostConfig.NetworkMode = 'host'; }, v => { v.HostConfig.Binds = ['/production:/data']; },
    v => { v.HostConfig.PortBindings = { '5432/tcp': [] }; }, v => { v.Mounts = [{ Type: 'volume' }]; }]) {
    const wrong = structuredClone(value); mutate(wrong);
    assert.throws(() => ownedContainer(wrong, name, nonce));
  }
});

test('qualification command transport bounds output/time and never exposes child stderr', () => {
  assert.equal(boundedCommand(process.execPath, ['-e', 'process.stdout.write("ok")']), 'ok');
  for (const [source, options] of [
    ['process.stdout.write("x".repeat(4096))', { limit: 32 }],
    ['setTimeout(()=>{},10000)', { timeout: 50 }],
    ['console.error("SECRET");process.exit(1)', {}],
  ]) assert.throws(() => boundedCommand(process.execPath, ['-e', source], options), /^Error: legacy_security_qualification_command_failed$/u);
});

test('failed or interrupted creation cleans only the verified owned ID (Docker command doubles)', async () => {
  for (const failure of ['create_response_lost', 'fixture_setup', 'foreign_label']) {
    let container;
    const removed = [];
    const listeners = process.listenerCount('SIGTERM');
    const command = (program, args) => {
      if (program === 'python3') return 'SQL from actual bridge is tested by native gate';
      assert.equal(program, 'docker');
      if (args.join(' ') === 'context show') return 'default\n';
      if (args.join(' ') === 'context inspect default') return JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]);
      if (args[0] === 'run') {
        const name = args[args.indexOf('--name') + 1];
        const nonce = name.split('-').at(-1);
        container = { Id: 'a'.repeat(64), Name: `/${name}`,
          Config: { Image: PG16_IMAGE, Labels: { 'io.ownerinc.test-scope': 'payload-legacy-security-pg16',
            'io.ownerinc.test-nonce': failure === 'foreign_label' ? 'f'.repeat(24) : nonce } },
          HostConfig: { NetworkMode: 'none', ReadonlyRootfs: true, Binds: null, PortBindings: {},
            Tmpfs: { '/tmp': 'rw', '/var/lib/postgresql/data': 'rw', '/var/run/postgresql': 'rw' } }, Mounts: [] };
        if (failure === 'create_response_lost') throw new Error('synthetic transport timeout');
        return container.Id;
      }
      if (args[0] === 'inspect') return JSON.stringify([container]);
      if (args[0] === 'rm') { removed.push(args); return container.Id; }
      if (args[0] === 'exec' && args[3] === 'sh') return '';
      if (args[0] === 'exec' && args.at(-1) === 'postgres') {
        if (!command.versionSeen) { command.versionSeen = true; return '160000\n'; }
        throw new Error('synthetic fixture failure');
      }
      throw new Error('unexpected command');
    };
    await assert.rejects(qualify({ env, platform: 'linux', command }));
    assert.deepEqual(removed, failure === 'foreign_label' ? [] : [['rm', '--force', 'a'.repeat(64)]]);
    assert.equal(process.listenerCount('SIGTERM'), listeners);
  }
});

test('candidate PG16 gate runs before images without changing authenticated job/report contracts', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  const harness = await readFile('scripts/integration/payload-legacy-security-pg16.mjs', 'utf8');
  const bridge = await readFile('scripts/integration/payload-legacy-security-pg16-bridge.py', 'utf8');
  const packager = await readFile('scripts/package-payload-candidate.mjs', 'utf8');
  const name = 'Qualify legacy security observer with isolated PostgreSQL 16';
  const start = workflow.indexOf(`      - name: ${name}`);
  assert.ok(start > 0 && start < workflow.indexOf('      - name: Build production images'));
  const step = workflow.slice(start, workflow.indexOf('      - name:', start + 1));
  assert.match(step, /inputs\.publish_candidate_only == true && inputs\.cms_image_only != true/u);
  assert.match(step, /PAYLOAD_REQUIRE_NATIVE_LEGACY_SECURITY: "1"/u);
  assert.match(step, /PAYLOAD_LEGACY_SECURITY_DISPOSABLE: "1"/u);
  assert.match(step, /run: node --test tests\/unit\/payload-legacy-security-pg16\.test\.mjs/u);
  assert.doesNotMatch(step, /continue-on-error|always\(|\|\|/u);
  assert.match(bridge, /runtime\.portal_legacy_security_observation_sql\(\)/u);
  assert.match(bridge, /runtime\.check_portal_legacy_security_baseline\(/u);
  assert.doesNotMatch(bridge, /def portal_legacy_security_observation_sql|_psql_json\(/u);
  assert.match(harness, /--no-role-passwords/u);
  assert.match(harness, /normalizePgDumpForSnapshot/u);
  assert.doesNotMatch(harness, /prune|--publish|DATABASE_URL|supabase/u);
  assert.match(packager, /for \(const name of \(production \? requiredValidationSteps : historicalRequiredSteps\)\)/u);
  // Extra validate steps remain allowed while production authenticates the split publisher/qualifier jobs.
});

test('qualification bridge emits the actual runtime producer without contacting PostgreSQL', () => {
  const sql = boundedCommand(process.platform === 'win32' ? 'python' : 'python3',
    ['-I', '-S', '-B', 'scripts/integration/payload-legacy-security-pg16-bridge.py', '--sql'], { limit: 128 * 1024 });
  assert.match(sql, /BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;/u);
  assert.equal((sql.match(/has_column_privilege\(o\.role_oid,o\.oid,o\.subid::smallint,/gu) || []).length, 2);
  assert.match(sql, /portal-legacy-security-observation-refused/u);
  assert.ok(sql.trim().endsWith('ROLLBACK;'));
});

test('native bridge caller builds only the current v4 shared-cluster binding and v2 receipt', async t => {
  if (!python) return t.skip('Python 3 unavailable');
  const caller = await readFile('scripts/integration/payload-legacy-security-pg16.mjs', 'utf8');
  assert.match(caller, /python\('--check', JSON\.stringify\(\{ observation, profileObservation \}\)\)/u);
  assert.match(caller, /payload-legacy-security-pg16-bridge\.py/u);
  const source = String.raw`
import importlib.util,json,posixpath,sys
spec=importlib.util.spec_from_file_location('bridge_contract',sys.argv[1])
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
runtime=bridge.load_runtime()
runtime.os.path=posixpath;runtime.STATE.os.path=posixpath;runtime.INVENTORY.os.path=posixpath
observation={'database':{'systemIdentifier':'123456','databaseOid':'16384','databaseName':'portal'}}
body,approval,record,inventory,authority=bridge.build_current_contract(runtime,observation)
binding=body['installIntent']['binding'];creation=body['installIntent']['creation']
runtime.STATE.validate_production_correspondence(binding,approval,record,inventory,authority)
print(json.dumps({'bindingVersion':binding['bindingVersion'],'receiptVersion':creation['receiptVersion'],
 'algorithm':creation['fingerprintAlgorithm'],
 'sharedClusterMatches':runtime.STATE.canonical(binding['sharedCluster'])==runtime.STATE.canonical(inventory['databaseCluster'])},sort_keys=True))
`;
  const result = spawnSync(python, ['-I', '-S', '-B', '-c', source,
    'scripts/integration/payload-legacy-security-pg16-bridge.py'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), {
    algorithm: 'shared-cluster-container-mounts-v2', bindingVersion: 4,
    receiptVersion: 2, sharedClusterMatches: true,
  });
});

test('native isolated PG16 executes actual producer and validator with own-cluster cleanup', {
  skip: process.env.PAYLOAD_REQUIRE_NATIVE_LEGACY_SECURITY !== '1', timeout: 300_000,
}, () => {
  const result = spawnSync(process.execPath, ['scripts/integration/payload-legacy-security-pg16.mjs'], {
    encoding: 'utf8', timeout: 290_000, maxBuffer: 4096,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout) <= 1024);
  assert.deepEqual(JSON.parse(result.stdout), { kind: 'legacy-security-pg16-proof', sqlProducerExecuted: true,
    actualValidatorComparator: true, readOnlyFingerprintsUnchanged: true, privilegeCasesPassed: true,
    overflowRefused: true, isolatedClusterRemoved: true, productionAuthorized: false });
});
