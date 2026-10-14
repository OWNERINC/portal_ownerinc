import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { guardEnvironment, assertOwnedContainer, assertOwnedNetwork, projectSnapshot, cleanupOwnedResources, withHeldTransaction, qualify, nodeImage, observationSQL } from '../../scripts/integration/payload-fence-topology.mjs';
import { postgresImage, nginxImage } from '../../scripts/integration/payload-functional-base-images.mjs';

const validEnv = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_RUN_ID: '12', GITHUB_RUN_ATTEMPT: '1', PAYLOAD_FENCE_TOPOLOGY_DISPOSABLE: '1' };
const source = readFileSync('scripts/integration/payload-fence-topology.mjs', 'utf8');
const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
function fixture() {
  const f = { nonce: 'a'.repeat(24), project: 'payload-fence-12-1-' + 'a'.repeat(24), images: {}, containers: {}, networks: [] };
  for (const image of [nodeImage, postgresImage, nginxImage]) f.images[image] = 'sha256:' + 'd'.repeat(64);
  for (let index = 0; index < 3; index++) f.networks.push({ index, id: String(index + 1).repeat(64), name: `${f.project}-net-${index}` });
  const cs = [];
  for (const [i, role] of ['nginx', 'api', 'cms', 'cron', 'postgres', 'cms-postgres', 'proxy', 'probe', 'foreign'].entries()) {
    const db = ['postgres', 'cms-postgres'].includes(role), external = ['proxy', 'probe', 'foreign'].includes(role);
    const e = { id: (i + 4).toString(16).repeat(64), role, project: external ? f.project + '-external' : f.project, name: f.project + '-' + role, receipt: 'e'.repeat(64) };
    f.containers[role] = e;
    const nets = role === 'nginx' ? [0, 2] : ['api', 'cron'].includes(role) ? [0, 1] : external ? [2] : [0];
    cs.push({ Id: e.id, Name: '/' + e.name, Image: 'sha256:' + 'd'.repeat(64),
      Config: { Image: db ? postgresImage : role === 'nginx' ? nginxImage : nodeImage,
        Labels: { 'io.ownerinc.test-scope': 'payload-fence', 'io.ownerinc.test-nonce': f.nonce, 'com.docker.compose.project': e.project, 'com.docker.compose.service': role, 'com.docker.compose.oneoff': 'False' } },
      HostConfig: { ReadonlyRootfs: true, Privileged: false, Binds: null, PortBindings: {}, NetworkMode: f.networks[nets[0]].id,
        Tmpfs: Object.fromEntries((db ? ['/fixture', '/var/lib/postgresql/data', '/var/run/postgresql'] : ['/fixture']).map(n => [n, 'rw'])) },
      Mounts: [], State: { Status: db || external ? 'running' : 'exited', Running: db || external, Paused: false, Restarting: false, Dead: false },
      NetworkSettings: { Networks: Object.fromEntries(nets.map(n => [f.networks[n].name, { NetworkID: f.networks[n].id, Aliases: [role] }])) } });
  }
  const ns = f.networks.map(e => ({ Id: e.id, Name: e.name, Labels: { 'io.ownerinc.test-scope': 'payload-fence', 'io.ownerinc.test-nonce': f.nonce },
    Driver: 'bridge', Internal: e.index === 0, Options: {}, Containers: Object.fromEntries(cs.filter(c => c.State.Running && Object.values(c.NetworkSettings.Networks).some(n => n.NetworkID === e.id)).map(c => [c.Id, {}])) }));
  return { f, cs, ns };
}

test('fence environment guard refuses before any command effect', async () => {
  guardEnvironment(validEnv, 'linux');
  for (const [key, value] of [['GITHUB_ACTIONS', 'false'], ['RUNNER_ENVIRONMENT', 'self-hosted'], ['PAYLOAD_FENCE_TOPOLOGY_DISPOSABLE', '0'], ['DOCKER_HOST', 'tcp://secret'], ['DOCKER_CONTEXT', 'other'], ['GITHUB_RUN_ID', '0']]) {
    let calls = 0;
    await assert.rejects(qualify({ env: { ...validEnv, [key]: value }, platform: 'linux', command: async () => { calls++; } }));
    assert.equal(calls, 0);
  }
  assert.throws(() => guardEnvironment(validEnv, 'win32'));
});

test('actual-inspect projection double preserves states, full IDs, mounts and relevant foreign boundaries', () => {
  const { f, cs, ns } = fixture();
  const p = projectSnapshot(cs, ns, f);
  assert.equal(p.containers.length, 6); assert.equal(p.host.length, 9);
  assert.equal(p.networks[2].endpoints.find(e => e.id === f.containers.foreign.id).relevant, false);
  assert.ok(p.containers.every(c => c.volumeKeys.length === 0 && !c.publishedPorts));
  assert.equal(p.containers.find(c => c.service === 'nginx').running, false);
  cs[1].State.Running = true; cs[1].State.Status = 'running';
  cs[1].NetworkSettings.Networks[f.networks[2].name] = { NetworkID: f.networks[2].id, Aliases: ['api'] };
  assert.ok(projectSnapshot(cs, ns, f).containers.find(c => c.service === 'api').networks.includes(f.networks[2].id));
});

test('ownership rejects replacement, secret-bearing mounts, ports, foreign networks and unknown endpoints', () => {
  for (const mutate of [v => v.Id = '0'.repeat(64), v => v.Image = 'sha256:' + '0'.repeat(64), v => v.Config.Labels['io.ownerinc.test-nonce'] = 'wrong',
    v => v.HostConfig.Binds = ['/secret:/secret'], v => v.HostConfig.PortBindings = { '80/tcp': [{}] }, v => v.Mounts.push({ Type: 'volume' }),
    v => v.NetworkSettings.Networks.other = { NetworkID: '0'.repeat(64) }]) {
    const { f, cs } = fixture(); mutate(cs[0]); assert.throws(() => assertOwnedContainer(cs[0], f.containers.nginx, f));
  }
  const { f, cs, ns } = fixture(); ns[2].Containers['0'.repeat(64)] = {};
  assert.throws(() => projectSnapshot(cs, ns, f));
  ns[0].Internal = false; assert.throws(() => assertOwnedNetwork(ns[0], f.networks[0], f));
});

test('real runtime bridge accepts synthetic projection only with the explicit non-Docker blocker', () => {
  const { f, cs, ns } = fixture(), snapshot = projectSnapshot(cs, ns, f);
  const context = Object.fromEntries(['inventoryIdentity', 'stateSha256', 'installBindingSha256', 'sourceApprovalSha256', 'policySha256', 'recordSha256', 'nonce'].map(k => [k, 'a'.repeat(64)]));
  Object.assign(context, { sequence: 1, pid: 1, processStart: 1, device: 1, inode: 1 });
  const databases = ['postgres', 'cms-postgres'].map(service => ({ service, containerId: f.containers[service].id,
    database: { systemIdentifier: '123', databaseOid: '123', databaseName: service === 'postgres' ? 'portal' : 'ownerinc_cms' },
    clients: 0, activeQueries: 0, openTransactions: 0, preparedTransactions: 0, backgroundWriters: 0, backgroundCoverageComplete: true }));
  const routes = ['/', '/api/ready', '/editorial/ready'].map(route => ({ route, status: 502, bodySha256: 'b'.repeat(64) }));
  const closure = { kind: 'portal-public-closure-profile-v1', context, origin: 'https://fence.invalid:8443', observerSha256: 'c'.repeat(64), nonDockerCoverageVerified: false, routes };
  const identity = ['id', 'service', 'imageId', 'image', 'receiptSha256', 'networks', 'volumeKeys'];
  const topology = { kind: 'portal-fence-topology-v1', context, containers: snapshot.containers.map(c => Object.fromEntries(identity.map(k => [k, c[k]]))),
    networks: snapshot.networks.map(n => ({ name: n.name, id: n.id, relevantEndpointIds: n.endpoints.filter(e => e.relevant).map(e => e.id) })),
    databases: databases.map(({ service, containerId, database }) => ({ service, containerId, database })) };
  const observation = { kind: 'portal-fence-observation-v1', mode: 'destructive', context, started: 1, ended: 3, passes: [snapshot, snapshot], databases,
    external: { observerSha256: closure.observerSha256, independent: true, nonce: context.nonce, started: 1, ended: 2,
      requests: routes.map(r => ({ ...r, origin: closure.origin, method: 'GET', tlsVerified: true, redirected: false, transportError: 'none' })) } };
  const run = value => spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-S', '-B', 'scripts/integration/payload-fence-topology-bridge.py'], { input: JSON.stringify(value), encoding: 'utf8', timeout: 10000 });
  const input = { testOnly: true, observation, context, topology, closure, now: 4 };
  const result = run(input); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).blockers, ['fence_external_topology_unverified']);
  databases[0].backgroundCoverageComplete = false;
  assert.ok(JSON.parse(run(input).stdout).blockers.includes('fence_background_writers_unverified'));
  const bad = run({ ...input, testOnly: false, password: 'do-not-print' });
  assert.notEqual(bad.status, 0); assert.equal(bad.stderr.trim(), 'fence_topology_bridge_refused'); assert.equal(bad.stdout, '');
});

test('native gate preserves pins, budgets, finite diagnostics and no production authority', () => {
  assert.ok(readFileSync('api/Dockerfile', 'utf8').includes(nodeImage));
  const step = workflow.split('      - name: Qualify isolated Portal fence topology\n')[1].split('      - name:')[0];
  assert.match(step, /timeout-minutes: 6/); assert.match(step, /inputs.publish_candidate_only == true && inputs.cms_image_only != true/);
  assert.match(step, /PAYLOAD_REQUIRE_NATIVE_FENCE_TOPOLOGY: "1"/);
  assert.ok(workflow.indexOf('Qualify isolated Portal fence topology') < workflow.indexOf('Build production images'));
  assert.match(source, /nonDockerCoverageVerified: false/);
  assert.match(source, /--pull', 'never/);
  assert.doesNotMatch(source, /docker\(\['(?:system|volume)', 'prune'|--publish|type=bind|rejectUnauthorized:false/u);
  assert.match(source, /ended - begin <= 30000/);
  assert.match(observationSQL, /pg_prepared_xacts/); assert.match(observationSQL, /pg_subscription/); assert.match(observationSQL, /pg_replication_slots/);
  assert.doesNotMatch(observationSQL, /pg_terminate_backend|ALTER |autovacuum\s*=\s*off/iu);
});

test('cleanup double refuses replaced resources, continues own cleanup and always removes private TLS material', async () => {
  const { f, cs, ns } = fixture();
  for (const e of Object.values(f.containers)) e.attempted = true;
  for (const e of f.networks) e.attempted = true;
  ns.forEach(n => n.Containers = {});
  const removed = []; let privateRemoved = false;
  cs[0].Config.Labels['io.ownerinc.test-nonce'] = 'replaced';
  await assert.rejects(cleanupOwnedResources(f, {
    inspect: async e => assertOwnedContainer(cs.find(c => c.Id === e.id), e, f),
    inspectNetwork: async e => assertOwnedNetwork(ns.find(n => n.Id === e.id), e, f),
    docker: async args => removed.push(args), removePrivate: async () => { privateRemoved = true; },
  }));
  assert.equal(privateRemoved, true);
  assert.equal(removed.filter(a => a[0] === 'rm').length, 8);
  assert.ok(!removed.some(a => a.includes(f.containers.nginx.id)));
  assert.ok(removed.every(a => /^[a-f0-9]{64}$/u.test(a.at(-1))));
});

for (const failure of ['connect', 'start', 'replacement']) test(`actual creation/finally path with Moby created shape: ${failure}`, async () => {
  const networks = new Map(), removed = []; let container;
  const command = async (program, args) => {
    if (program === 'openssl') {
      await writeFile(args[args.indexOf('-keyout') + 1], 'TEST-key');
      await writeFile(args[args.indexOf('-out') + 1], 'TEST-cert'); return '';
    }
    assert.equal(program, 'docker'); assert.deepEqual(args.slice(0, 2), ['--context', 'default']);
    const a = args.slice(2), labels = {};
    a.forEach((v, i) => { if (v === '--label') { const [k, val] = a[i + 1].split('='); labels[k] = val; } });
    if (a[0] === 'context') return JSON.stringify([{ Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]);
    if (a[0] === 'info') return 'linux';
    if (a[0] === 'image') return JSON.stringify([{ Id: 'sha256:' + 'd'.repeat(64) }]);
    if (a[0] === 'network' && a[1] === 'create') {
      const id = String(networks.size + 1).repeat(64);
      networks.set(id, { Id: id, Name: a.at(-1), Labels: labels, Driver: 'bridge', Internal: a.includes('--internal'), Options: {}, Containers: {} }); return id;
    }
    if (a[0] === 'network' && a[1] === 'inspect') return JSON.stringify([networks.get(a[2])]);
    if (a[0] === 'create') {
      container = structuredClone(fixture().cs[0]);
      container.Name = '/' + a[a.indexOf('--name') + 1]; container.Config.Labels = labels;
      const id = a[a.indexOf('--network') + 1]; container.HostConfig.NetworkMode = id;
      container.State.Status = 'created';
      container.NetworkSettings.Networks = { [networks.get(id).Name]: { NetworkID: '', EndpointID: '', IPAddress: '', GlobalIPv6Address: '', Aliases: ['nginx'] } };
      return container.Id;
    }
    if (a[0] === 'network' && a[1] === 'connect') {
      if (failure === 'replacement') container.Image = 'sha256:' + 'f'.repeat(64);
      if (failure !== 'start') throw new Error('SECRET failed attachment ID hostname');
      container.NetworkSettings.Networks[networks.get(a.at(-2)).Name] = { NetworkID: '', EndpointID: '', IPAddress: '', GlobalIPv6Address: '', Aliases: ['nginx'] };
      return '';
    }
    if (a[0] === 'start') throw new Error('SECRET start failure');
    if (a[0] === 'inspect') { assert.equal(a[1], container.Id); return JSON.stringify([container]); }
    if (a[0] === 'rm') {
      assert.equal(a[2], container.Id); removed.push(container.Id);
      for (const n of networks.values()) delete n.Containers[container.Id]; return container.Id;
    }
    if (a[0] === 'network' && a[1] === 'rm') {
      assert.deepEqual(networks.get(a[2]).Containers, {}); removed.push(a[2]); networks.delete(a[2]); return a[2];
    }
    assert.fail('unexpected command boundary');
  };
  await assert.rejects(qualify({ env: validEnv, platform: 'linux', command }), error => {
    assert.equal(error.primaryPhase, failure === 'start' ? 'create_container_start' : 'create_container_connect');
    assert.deepEqual(error.cleanupFailures, failure === 'replacement' ? ['container_inspect'] : []);
    assert.equal(error.message, `fence_topology_qualification_failed:${error.primaryPhase};cleanup:${failure === 'replacement' ? 'container_inspect' : 'none'}`);
    return true;
  });
  assert.equal(removed.length, failure === 'replacement' ? 3 : 4); assert.equal(networks.size, 0);
  assert.equal(new Set(removed).size, removed.length);
  if (failure === 'replacement') assert.ok(!removed.includes(container.Id));
});

test('partial cleanup still rejects replacement and foreign attachments; observation requires completion', () => {
  const { f, cs } = fixture();
  delete cs[0].NetworkSettings.Networks[f.networks[2].name];
  assert.throws(() => assertOwnedContainer(cs[0], f.containers.nginx, f));
  assertOwnedContainer(cs[0], f.containers.nginx, f, { partial: true });
  cs[0].NetworkSettings.Networks.foreign = { NetworkID: 'f'.repeat(64) };
  assert.throws(() => assertOwnedContainer(cs[0], f.containers.nginx, f, { partial: true }));
  delete cs[0].NetworkSettings.Networks.foreign;
  cs[0].Id = 'f'.repeat(64);
  assert.throws(() => assertOwnedContainer(cs[0], f.containers.nginx, f, { partial: true }));
});

test('Moby v28.5.1 created endpoint configuration has no operational NetworkID until start', () => {
  // Source-grounded shape, NOT a capture from the failed CI host:
  // moby/moby v28.5.1 daemon/container_operations.go:
  // updateContainerNetworkSettings retains EndpointSettings from create;
  // ConnectToNetwork(!Running) updates config without connectToNetwork allocation.
  // daemon/inspect.go copies those EndpointSettings into the inspect response.
  const { f, cs } = fixture();
  const value = cs[0]; value.State.Status = 'created';
  for (const endpoint of Object.values(value.NetworkSettings.Networks)) {
    Object.assign(endpoint, { NetworkID: '', EndpointID: '', IPAddress: '', GlobalIPv6Address: '' });
  }
  assertOwnedContainer(value, f.containers.nginx, f, { configured: true });
  assertOwnedContainer(value, f.containers.nginx, f, { partial: true });
  assert.throws(() => assertOwnedContainer(value, f.containers.nginx, f));
  value.State.Status = 'running'; value.State.Running = true;
  assert.throws(() => assertOwnedContainer(value, f.containers.nginx, f, { configured: true }));
  value.State.Status = 'created'; value.State.Running = false;
  const key = f.networks[0].name;
  value.NetworkSettings.Networks.unknown = value.NetworkSettings.Networks[key]; delete value.NetworkSettings.Networks[key];
  assert.throws(() => assertOwnedContainer(value, f.containers.nginx, f, { partial: true }));
});

test('cleanup keeps finite independent refusal and occupied-network diagnostics without raw errors', async () => {
  const { f } = fixture();
  f.containers = { nginx: { attempted: true } }; f.networks = [{ attempted: true }];
  await assert.rejects(cleanupOwnedResources(f, {
    inspect: async () => { throw new Error('SECRET container-id hostname'); },
    inspectNetwork: async () => ({ Containers: { 'SECRET-id': {} } }),
    docker: async () => assert.fail('must not remove refused or occupied resource'), removePrivate: async () => {},
  }), error => {
    assert.deepEqual(error.cleanupFailures, ['container_inspect', 'network_not_empty']);
    assert.ok(!error.message.includes('SECRET')); return true;
  });
});

test('held transaction release is controlled by classifier completion, not elapsed delay', async () => {
  const events = []; let completeObservation, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const operation = withHeldTransaction({
    start: async () => events.push('start'), ready: async () => events.push('ready'), assertHeld: async () => events.push('held'),
    observe: async () => { events.push('observe'); entered(); await new Promise(resolve => { completeObservation = resolve; }); return 'classified'; },
    release: async () => events.push('release'), finished: async () => events.push('finished'),
  });
  await enteredPromise;
  assert.deepEqual(events, ['start', 'ready', 'held', 'observe']);
  completeObservation(); assert.equal(await operation, 'classified');
  assert.deepEqual(events, ['start', 'ready', 'held', 'observe', 'held', 'release', 'finished']);
});

test('held transaction failure paths release and await completion without broad session termination', async () => {
  for (const failure of ['start', 'ready', 'assertHeld', 'observe', 'finished']) {
    const events = [], operations = {};
    for (const name of ['start', 'ready', 'assertHeld', 'observe', 'release', 'finished']) operations[name] = async () => {
      events.push(name); if (name === failure) throw new Error('injected');
    };
    await assert.rejects(withHeldTransaction(operations), /injected/);
    assert.ok(events.includes('release')); assert.equal(events.at(-1), 'finished');
  }
  assert.doesNotMatch(source, /pg_sleep\(15\)|delay\(16000\)|pg_terminate_backend/);
  assert.match(source, /idle_in_transaction_session_timeout='95s'/);
  assert.match(source, /hold-expired/);
});

test('native topology qualification (real Docker/PG/TLS, never a portable substitute)', { skip: process.env.PAYLOAD_REQUIRE_NATIVE_FENCE_TOPOLOGY !== '1', timeout: 340000 }, async () => {
  const proof = await qualify();
  assert.ok(Buffer.byteLength(JSON.stringify(proof)) <= 1024);
  assert.equal(proof.kind, 'fence-topology-proof');
  const trueKeys = ['actualDockerProjectionValidated', 'noPublishedPortsYetReachable', 'knownProxyRouteClosedAfterNginxStop', 'privateStubReadinessWhileClosed', 'alternativeIngressDetected', 'realDatabaseQuiescenceObserved', 'foreignFixtureUnchanged', 'ownedResourcesRemoved'];
  const falseKeys = ['applicationReadinessQualified', 'productionExternalCoverageVerified', 'completeProductionFenceProof', 'productionAuthorized'];
  assert.deepEqual(Object.keys(proof).sort(), ['kind', ...trueKeys, ...falseKeys].sort());
  for (const k of trueKeys) assert.equal(proof[k], true);
  for (const k of falseKeys) assert.equal(proof[k], false);
  console.log(JSON.stringify(proof));
});
