// Disposable TEST topology only. No production discovery, approvals or collector.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess } from './payload-functional-fixture.mjs';
import { postgresImage, nginxImage } from './payload-functional-base-images.mjs';
import { normalizePgDumpForSnapshot } from './payload-preauthority-fixture.mjs';

export const nodeImage = 'node:24.12.0-alpine3.23@sha256:c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8';
const scope = 'payload-fence';
const logical = ['ownerinc-portal-backend', 'ownerinc-portal-egress', 'ownerinc_proxy'];
const roles = ['nginx', 'api', 'cms', 'cron', 'postgres', 'proxy', 'probe', 'foreign'];
const routes = ['/', '/api/ready', '/editorial/ready'];
const origin = 'https://fence.invalid:8443';
const closedBody = 'fixture-upstream-unavailable\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const now = () => Math.floor(performance.now());
const bridge = fileURLToPath(new URL('./payload-fence-topology-bridge.py', import.meta.url));
const databaseNames = ['portal', 'ownerinc_cms'];
const dbRoles = ['postgres'];
const imageFor = role => dbRoles.includes(role) ? postgresImage : role === 'nginx' ? nginxImage : nodeImage;
const attachments = role => role === 'nginx' ? [0, 2] : ['api', 'cron'].includes(role) ? [0, 1] : ['proxy', 'probe', 'foreign'].includes(role) ? [2] : [0];

export function guardEnvironment(env = process.env, platform = process.platform) {
  assert.equal(platform, 'linux');
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.PAYLOAD_FENCE_TOPOLOGY_DISPOSABLE, '1');
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[key] || '', /^[1-9][0-9]{0,19}$/u);
  assert.ok(!env.DOCKER_HOST && !env.DOCKER_CONTEXT);
}

export function assertOwnedContainer(value, entry, fixture, { partial = false, configured = false } = {}) {
  assert.match(value.Id, /^[a-f0-9]{64}$/u);
  if (entry.id) assert.equal(value.Id, entry.id);
  assert.equal(value.Name, `/${entry.name}`);
  assert.equal(value.Config.Image, imageFor(entry.role));
  assert.equal(value.Image, fixture.images[imageFor(entry.role)]);
  assert.equal(value.Config.Labels['io.ownerinc.test-scope'], scope);
  assert.equal(value.Config.Labels['io.ownerinc.test-nonce'], fixture.nonce);
  assert.equal(value.Config.Labels['com.docker.compose.project'], entry.project);
  assert.equal(value.Config.Labels['com.docker.compose.service'], entry.role);
  assert.equal(value.HostConfig.ReadonlyRootfs, true);
  assert.equal(value.HostConfig.Privileged, false);
  assert.ok(!value.HostConfig.Binds?.length);
  assert.deepEqual(value.HostConfig.PortBindings || {}, {});
  assert.ok(value.Mounts.every(m => m.Type === 'tmpfs'));
  const allowed = dbRoles.includes(entry.role) ? ['/fixture', '/var/lib/postgresql/data', '/var/run/postgresql'] : ['/fixture'];
  assert.deepEqual(Object.keys(value.HostConfig.Tmpfs || {}).sort(), allowed.sort());
  // Moby v28.5.1 container_operations.go updateContainerNetworkSettings and
  // ConnectToNetwork(!Running) retain configuration without allocating endpoints.
  // Only creation/cleanup may resolve an empty operational ID through the exact
  // owned network key. Callers re-inspect these networks first. Running/stopped
  // observations still require actual populated IDs; no projection fabricates IDs.
  const actualNetworks = Object.entries(value.NetworkSettings.Networks).map(([key, endpoint]) => {
    if (endpoint.NetworkID !== '') return endpoint.NetworkID;
    assert.ok(configured || partial);
    assert.equal(value.State.Status, 'created');
    for (const field of ['Running', 'Paused', 'Restarting', 'Dead']) assert.equal(value.State[field], false);
    for (const field of ['EndpointID', 'IPAddress', 'GlobalIPv6Address']) assert.equal(endpoint[field], '');
    const network = fixture.networks.find(n => n.name === key || n.id === key);
    assert.ok(network);
    return network.id;
  }).sort();
  const expectedNetworks = attachments(entry.role).map(i => fixture.networks[i].id).sort();
  // The one explicitly owned bypass is observable, never normalized away.
  if (entry.role === 'api' && actualNetworks.includes(fixture.networks[2].id)) expectedNetworks.push(fixture.networks[2].id);
  if (partial) {
    assert.ok(actualNetworks.every(id => expectedNetworks.includes(id)));
    assert.ok(fixture.networks.some(n => n.id === value.HostConfig.NetworkMode || n.name === value.HostConfig.NetworkMode));
  } else assert.deepEqual(actualNetworks, expectedNetworks.sort());
  return value;
}

export function assertOwnedNetwork(value, entry, fixture) {
  assert.match(value.Id, /^[a-f0-9]{64}$/u);
  if (entry.id) assert.equal(value.Id, entry.id);
  assert.equal(value.Name, entry.name);
  assert.equal(value.Labels['io.ownerinc.test-scope'], scope);
  assert.equal(value.Labels['io.ownerinc.test-nonce'], fixture.nonce);
  assert.equal(value.Driver, 'bridge');
  assert.equal(value.Internal, entry.index === 0);
  assert.deepEqual(value.Options || {}, {});
  return value;
}

// No row/query text, settings values or addresses leave these catalog predicates.
export const observationSQL = `
BEGIN READ ONLY;
SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s';
SELECT json_build_object(
 'database',json_build_object('systemIdentifier',(SELECT system_identifier::text FROM pg_catalog.pg_control_system()),
   'databaseOid',(SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database()),'databaseName',current_database()),
 'clients',(SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid()),
 'activeQueries',(SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid() AND state='active'),
 'openTransactions',(SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname=current_database() AND backend_type='client backend' AND pid<>pg_backend_pid() AND xact_start IS NOT NULL),
 'preparedTransactions',(SELECT count(*) FROM pg_catalog.pg_prepared_xacts WHERE database=current_database()),
 'backgroundWriters',(SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE backend_type NOT IN
   ('client backend','autovacuum launcher','autovacuum worker','background writer','checkpointer','walwriter','archiver','logical replication launcher')),
 'backgroundCoverageComplete',current_setting('server_version_num')::int BETWEEN 160000 AND 169999
   AND current_setting('shared_preload_libraries')='' AND current_setting('session_preload_libraries')=''
   AND current_setting('local_preload_libraries')='' AND NOT pg_is_in_recovery()
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_subscription)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_replication_slots)
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_extension WHERE extname<>'plpgsql')
   AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
);
COMMIT;`;

const stub = `require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');s.end('{"status":"ready"}');}).listen(Number(process.argv[1]),'0.0.0.0')`;
const proxyScript = `const fs=require('fs'),https=require('https'),http=require('http');
https.createServer({key:fs.readFileSync('/fixture/key.pem'),cert:fs.readFileSync('/fixture/cert.pem')},(q,s)=>{
 const r=http.get({host:process.env.FIXTURE_UPSTREAM,port:8080,path:q.url,timeout:2000},u=>{s.writeHead(u.statusCode,u.headers);u.pipe(s)});
 r.on('timeout',()=>r.destroy());r.on('error',()=>{s.writeHead(502,{'content-type':'text/plain'});s.end(${JSON.stringify(closedBody)})});
}).listen(8443,'0.0.0.0');`;
const probeScript = `const https=require('https'),fs=require('fs'),crypto=require('crypto');
const r=https.get(process.argv[1],{ca:fs.readFileSync('/fixture/cert.pem'),rejectUnauthorized:true,timeout:4000},s=>{
 const verified=s.socket.authorized;
 let b=Buffer.alloc(0);s.on('data',x=>{b=Buffer.concat([b,x]);if(b.length>4096)process.exit(2)});
 s.on('end',()=>console.log(JSON.stringify({status:s.statusCode,bodySha256:crypto.createHash('sha256').update(b).digest('hex'),tlsVerified:verified,redirected:s.statusCode>=300&&s.statusCode<400,transportError:'none'})));
});r.on('timeout',()=>r.destroy());r.on('error',()=>process.exit(2));`;

export function projectSnapshot(rawContainers, rawNetworks, fixture) {
  const entries = Object.values(fixture.containers);
  assert.equal(rawContainers.length, entries.length); assert.equal(rawNetworks.length, 3);
  const byId = new Map(rawContainers.map(v => [v.Id, v]));
  assert.equal(byId.size, entries.length);
  for (const e of entries) assertOwnedContainer(byId.get(e.id), e, fixture);
  const netIds = fixture.networks.map(n => n.id);
  const containers = entries.filter(e => !['proxy', 'probe', 'foreign'].includes(e.role)).map(e => {
    const v = byId.get(e.id), nets = Object.values(v.NetworkSettings.Networks);
    const aliasesApproved = nets.every(n => (n.Aliases || []).every(a => [e.name, e.role, v.Id.slice(0, 12)].includes(a)));
    return { id: v.Id, service: e.role, imageId: v.Image.replace(/^sha256:/u, ''), image: v.Config.Image,
      receiptSha256: e.receipt, networks: nets.map(n => n.NetworkID), volumeKeys: [], status: v.State.Status,
      running: v.State.Running, paused: v.State.Paused, restarting: v.State.Restarting, dead: v.State.Dead,
      oneOff: v.Config.Labels['com.docker.compose.oneoff'] !== 'False', projectMatches: v.Config.Labels['com.docker.compose.project'] === fixture.project,
      nginxNameMatches: e.role === 'nginx' && v.Name === `/${fixture.containers.nginx.name}`,
      networkMode: netIds.includes(v.HostConfig.NetworkMode) || fixture.networks.some(n => n.name === v.HostConfig.NetworkMode) ? 'bridge' : 'other',
      publishedPorts: Object.keys(v.HostConfig.PortBindings || {}).length !== 0, aliasesApproved };
  });
  const host = entries.map(e => ({ id: e.id, portalProject: e.project === fixture.project,
    portalNameClaim: e.project === fixture.project, portalVolumeConsumer: false })); // All actual mounts checked tmpfs-only above.
  const networks = fixture.networks.map(e => {
    const v = rawNetworks.find(n => n.Id === e.id); assertOwnedNetwork(v, e, fixture);
    const endpoints = Object.keys(v.Containers || {}).map(id => {
      const entry = entries.find(c => c.id === id); assert.ok(entry, 'unregistered endpoint');
      return { id, relevant: entry.role !== 'foreign' };
    });
    assert.ok(endpoints.length <= 256);
    return { name: logical[e.index], id: v.Id, driver: v.Driver, internal: v.Internal,
      optionsApproved: Object.keys(v.Options || {}).length === 0, endpoints };
  });
  return { host, containers, networks };
}

export async function cleanupOwnedResources(fixture, { inspect, inspectNetwork, docker, removePrivate }) {
  const failures = new Set();
  for (const e of Object.values(fixture.containers).reverse()) {
    if (!e.attempted) continue;
    let operation = 'container_inspect';
    try {
      const v = await inspect(e); // Includes exact ID, image, nonce, project and isolation checks.
      operation = 'container_remove';
      await docker(['rm', '--force', v.Id], { timeout: 10000 }); e.attempted = false;
    } catch { failures.add(operation); }
  }
  for (const e of [...fixture.networks].reverse()) {
    if (!e.attempted) continue;
    let operation = 'network_inspect';
    try {
      const v = await inspectNetwork(e);
      operation = 'network_not_empty'; assert.deepEqual(v.Containers || {}, {});
      operation = 'network_remove';
      await docker(['network', 'rm', v.Id], { timeout: 10000 }); e.attempted = false;
    } catch { failures.add(operation); }
  }
  try { await removePrivate(); } catch { failures.add('private_remove'); }
  if (failures.size) {
    const error = new Error('fence_topology_cleanup_refused');
    error.cleanupFailures = [...failures].sort();
    throw error;
  }
}

const phases = new Set(('guard preflight tls create_networks create_network_command create_network_inspect create_containers create_container_command create_container_connect create_container_inspect create_container_start configure_http readiness reachable_without_ports closed_private_readiness bypass baseline_fingerprint_capture baseline_database_identity baseline_fence_classifier baseline_fingerprint_comparison held_transaction prepared_transaction final_observation none').split(' '));
const cleanupCodes = new Set(['container_inspect', 'container_remove', 'network_inspect', 'network_not_empty', 'network_remove', 'private_remove', 'unknown']);
export class FenceQualificationError extends Error {
  constructor(primaryPhase, failures = []) {
    const primary = phases.has(primaryPhase) ? primaryPhase : 'guard';
    const cleanup = [...new Set(failures.map(code => cleanupCodes.has(code) ? code : 'unknown'))].sort();
    super(`fence_topology_qualification_failed:${primary};cleanup:${cleanup.join(',') || 'none'}`);
    this.primaryPhase = primary;
    this.cleanupFailures = cleanup;
  }
}

// Release follows the actual classifier observation, never elapsed sleep time.
// Each supplied operation is bounded by the fixture command/deadline transport.
export async function withHeldTransaction({ start, ready, assertHeld, observe, release, finished }) {
  try {
    await start();
    await ready();
    await assertHeld();
    const result = await observe();
    await assertHeld();
    return result;
  } finally {
    await release(); // Also reconciles an ambiguously successful detached start.
    await finished();
  }
}

export async function qualify({ env = process.env, platform = process.platform, command = runProcess } = {}) {
  try { guardEnvironment(env, platform); } catch { throw new FenceQualificationError('guard'); }
  const started = now();
  let phase = 'preflight', directory, cleaning = false, cleanupDeadline = 0, primaryFailure = null, cleanupFailures = [];
  const bounded = (program, args, options = {}) => {
    const remaining = (cleaning ? cleanupDeadline : started + 270000) - now();
    assert.ok(remaining > 0, 'fixture deadline');
    return command(program, args, { ...options, timeout: Math.min(options.timeout || 10000, remaining) });
  };
  const fixture = { nonce: randomBytes(12).toString('hex'), images: {}, containers: {}, networks: [] };
  fixture.project = `${scope}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${fixture.nonce}`;
  const docker = (args, options) => bounded('docker', ['--context', 'default', ...args], options);
  const inspect = async e => assertOwnedContainer(JSON.parse(await docker(['inspect', e.id || e.name]))[0], e, fixture);
  const inspectConfigured = async (e, partial) => {
    // Exact network name->ID binding must still exist before configuration keys
    // can be used for a not-yet-started container. No name-only authority.
    for (const network of fixture.networks) await inspectNetwork(network);
    return assertOwnedContainer(JSON.parse(await docker(['inspect', e.id || e.name]))[0], e, fixture, { partial, configured: true });
  };
  const inspectForCleanup = e => inspectConfigured(e, true);
  const inspectNetwork = async e => assertOwnedNetwork(JSON.parse(await docker(['network', 'inspect', e.id || e.name]))[0], e, fixture);
  const exec = async (role, args, input) => { const e = fixture.containers[role]; await inspect(e); return docker(['exec', '-i', e.id, ...args], { input, timeout: 10000 }); };
  const sql = (databaseName, input) => exec('postgres', ['psql', '-XqAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', databaseName], input);
  const write = (role, name, input) => exec(role, ['sh', '-ceu', `umask 077; cat > /fixture/${name}`], input);
  const stop = async role => { const e = fixture.containers[role]; await inspect(e); await docker(['stop', '--time', '3', e.id], { timeout: 6000 }); };
  const observe = async () => {
    assert.ok(now() - started < 285000, 'fixture deadline');
    assert.ok(!interrupted);
    const scoped = (await docker(['ps', '--all', '--no-trunc', '--filter', `label=io.ownerinc.test-nonce=${fixture.nonce}`, '--format', '{{.ID}}'])).split('\n').filter(Boolean).sort();
    assert.deepEqual(scoped, Object.values(fixture.containers).map(e => e.id).sort());
    const cs = []; for (const e of Object.values(fixture.containers)) cs.push(await inspect(e));
    const ns = []; for (const e of fixture.networks) ns.push(await inspectNetwork(e));
    return projectSnapshot(cs, ns, fixture);
  };
  const dbObserve = async () => {
    const rows = [];
    for (const databaseName of databaseNames) rows.push({ service: `postgres:${databaseName}`, containerId: fixture.containers.postgres.id,
      ...JSON.parse(await sql(databaseName, observationSQL)) });
    return rows;
  };
  const probe = async () => {
    const requests = [];
    for (const route of routes) requests.push({ route, origin, method: 'GET', ...JSON.parse(await exec('probe', ['node', '-e', probeScript, origin + route])) });
    return requests;
  };
  const cleanup = async () => {
    cleaning = true; cleanupDeadline = now() + 60000;
    await cleanupOwnedResources(fixture, { inspect: inspectForCleanup, inspectNetwork, docker,
      removePrivate: async () => { if (directory) await rm(directory, { recursive: true, force: true }); } });
  };
  let interrupted = false;
  const onSignal = () => { interrupted = true; }; // Main path reaches finally; no concurrent cleanup races.
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  try {
    const context = JSON.parse(await docker(['context', 'inspect', 'default']))[0];
    assert.equal(context.Endpoints.docker.Host, 'unix:///var/run/docker.sock');
    assert.equal(await docker(['info', '--format', '{{.OSType}}']), 'linux');
    for (const image of [postgresImage, nginxImage, nodeImage]) {
      const v = JSON.parse(await docker(['image', 'inspect', image]))[0];
      assert.match(v.Id, /^sha256:[a-f0-9]{64}$/u); fixture.images[image] = v.Id;
    }
    phase = 'tls'; directory = await mkdtemp(path.join(os.tmpdir(), 'payload-fence-'));
    await chmod(directory, 0o700);
    await bounded('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=fence.invalid',
      '-addext', 'subjectAltName=DNS:fence.invalid', '-keyout', path.join(directory, 'key.pem'), '-out', path.join(directory, 'cert.pem')]);
    await chmod(path.join(directory, 'key.pem'), 0o600);
    const cert = await readFile(path.join(directory, 'cert.pem'), 'utf8'), key = await readFile(path.join(directory, 'key.pem'), 'utf8');
    phase = 'create_networks';
    for (let index = 0; index < 3; index++) {
      const e = { index, name: `${fixture.project}-net-${index}`, attempted: true }; fixture.networks.push(e);
      phase = 'create_network_command';
      e.id = await docker(['network', 'create', '--driver', 'bridge', ...(index === 0 ? ['--internal'] : []),
        '--label', `io.ownerinc.test-scope=${scope}`, '--label', `io.ownerinc.test-nonce=${fixture.nonce}`, e.name]);
      phase = 'create_network_inspect'; await inspectNetwork(e);
    }
    phase = 'create_containers';
    for (const role of roles) {
      const e = { role, name: `${fixture.project}-${role}`, project: ['proxy', 'probe', 'foreign'].includes(role) ? `${fixture.project}-external` : fixture.project, attempted: true };
      fixture.containers[role] = e;
      const args = ['create', '--pull', 'never', '--name', e.name, '--hostname', role,
        '--label', `io.ownerinc.test-scope=${scope}`, '--label', `io.ownerinc.test-nonce=${fixture.nonce}`,
        '--label', `com.docker.compose.project=${e.project}`, '--label', `com.docker.compose.service=${role}`,
        '--label', 'com.docker.compose.oneoff=False', '--network', fixture.networks[attachments(role)[0]].id,
        '--network-alias', role === 'proxy' ? 'fence.invalid' : role,
        '--read-only', '--security-opt', 'no-new-privileges:true', '--memory', dbRoles.includes(role) ? '256m' : '96m',
        '--cpus', '0.5', '--pids-limit', '64', '--tmpfs', '/fixture:rw,nosuid,nodev,size=8m,mode=1777'];
      if (dbRoles.includes(role)) args.push('--tmpfs', '/var/lib/postgresql/data:rw,nosuid,nodev,size=128m', '--tmpfs', '/var/run/postgresql:rw,nosuid,nodev,size=8m',
        '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', '--env', 'POSTGRES_DB=portal', imageFor(role), '-c', 'max_prepared_transactions=4', '-c', 'shared_buffers=16MB');
      else if (role === 'nginx') args.push('--entrypoint', 'sh', imageFor(role), '-c', 'while [ ! -f /fixture/start ]; do sleep 0.1; done; exec nginx -c /fixture/nginx.conf -g "daemon off;"');
      else args.push('--entrypoint', 'node', imageFor(role), '-e', 'setInterval(()=>{},1000)');
      phase = 'create_container_command'; e.id = await docker(args);
      phase = 'create_container_connect';
      for (const index of attachments(role).slice(1)) await docker(['network', 'connect', '--alias', role, fixture.networks[index].id, e.id]);
      phase = 'create_container_inspect'; await inspectConfigured(e, false);
      e.receipt = hash(JSON.stringify({ testOnly: true, id: e.id, role, image: fixture.images[imageFor(role)], nonce: fixture.nonce }));
      phase = 'create_container_start'; await docker(['start', e.id]);
    }
    phase = 'configure_http';
    await write('nginx', 'nginx.conf', `pid /fixture/nginx.pid; error_log /dev/null; events {} http { access_log off; client_body_temp_path /fixture/client; proxy_temp_path /fixture/proxy; fastcgi_temp_path /fixture/fastcgi; uwsgi_temp_path /fixture/uwsgi; scgi_temp_path /fixture/scgi; server { listen 8080; location /editorial/ { proxy_pass http://cms:3001; } location / { proxy_pass http://api:3000; } } }`);
    for (const role of ['api', 'cms', 'foreign']) await docker(['exec', '-d', fixture.containers[role].id, 'node', '-e', stub, role === 'cms' ? '3001' : '3000']);
    await write('nginx', 'start', 'start');
    await write('proxy', 'key.pem', key); await write('proxy', 'cert.pem', cert); await write('probe', 'cert.pem', cert);
    const nginx = await inspect(fixture.containers.nginx);
    const upstream = Object.values(nginx.NetworkSettings.Networks).find(n => n.NetworkID === fixture.networks[2].id).IPAddress;
    await docker(['exec', '-d', '--env', `FIXTURE_UPSTREAM=${upstream}`, fixture.containers.proxy.id, 'node', '-e', proxyScript]);
    phase = 'readiness';
    let ready = false, cmsDatabaseCreated = false;
    for (let attempt = 0; attempt < 20; attempt++) {
      assert.ok(!interrupted && now() - started < 260000);
      try {
        await sql('portal', 'SELECT 1;');
        if (!cmsDatabaseCreated) { await sql('portal', 'CREATE DATABASE ownerinc_cms;'); cmsDatabaseCreated = true; }
        await sql('ownerinc_cms', 'SELECT 1;');
        const rs = await probe(); assert.ok(rs.every(r => r.status === 200)); ready = true; break;
      }
      catch { await delay(500); }
    }
    assert.ok(ready);
    const foreignFingerprint = async () => {
      const v = await inspect(fixture.containers.foreign);
      const response = await exec('probe', ['node', '-e', `require('http').get('http://foreign:3000',s=>{let b='';s.on('data',x=>b+=x);s.on('end',()=>console.log(b))}).on('error',()=>process.exit(1))`]);
      return hash(JSON.stringify([v.Id, v.Config, v.HostConfig, v.NetworkSettings, v.State.StartedAt, response]));
    };
    const foreignBefore = await foreignFingerprint();
    const fingerprints = async () => {
      const data = [];
      data.push(normalizePgDumpForSnapshot(await exec('postgres', ['pg_dumpall', '-U', 'postgres', '--roles-only', '--no-role-passwords'])));
      for (const databaseName of databaseNames) data.push(normalizePgDumpForSnapshot(
        await exec('postgres', ['pg_dump', '-U', 'postgres', '-d', databaseName])));
      return hash(data.join('\n'));
    };
    const ctx = Object.fromEntries(['inventoryIdentity', 'stateSha256', 'installBindingSha256', 'sourceApprovalSha256', 'policySha256', 'recordSha256', 'nonce'].map(k => [k, hash(`TEST:${fixture.nonce}:${k}`)]));
    Object.assign(ctx, { sequence: 1, pid: process.pid, processStart: 1, device: 1, inode: 1 }); // Explicitly synthetic, not a real production lease/journal.
    const closure = { kind: 'portal-public-closure-profile-v1', context: ctx, origin, observerSha256: hash('TEST:probe'), nonDockerCoverageVerified: false,
      routes: routes.map(route => ({ route, status: 502, bodySha256: hash(closedBody) })) };
    // Approval intentions fixed above; bind only verified owned creation IDs, not subsequently observed changes.
    const first = await observe();
    const identityKeys = ['id', 'service', 'imageId', 'image', 'receiptSha256', 'networks', 'volumeKeys'];
    const topology = { kind: 'portal-fence-topology-v1', context: ctx,
      containers: first.containers.map(c => Object.fromEntries(identityKeys.map(k => [k, c[k]]))),
      networks: fixture.networks.map(n => ({ name: logical[n.index], id: n.id, relevantEndpointIds: n.index === 0 ? [fixture.containers.postgres.id] : n.index === 2 ? ['proxy', 'probe'].map(r => fixture.containers[r].id) : [] })),
      databases: (await dbObserve()).map(({ service, containerId, database: d }) => ({ service, containerId, database: d })) };
    const check = async (mode = 'destructive') => {
      assert.ok(!interrupted);
      const begin = now(), pass1 = await observe(), dbs = await dbObserve(), sent = now();
      const requests = await probe(), received = now(), pass2 = await observe(), ended = now();
      assert.ok(ended - begin <= 30000);
      const observation = { kind: 'portal-fence-observation-v1', mode, context: ctx, started: begin, ended,
        passes: [pass1, pass2], databases: dbs, external: { observerSha256: closure.observerSha256,
          independent: true, nonce: ctx.nonce, started: sent, ended: received, requests } }; // Separate container vantage ONLY.
      const result = JSON.parse(await bounded('python3', ['-I', '-S', '-B', bridge], { input: JSON.stringify({ testOnly: true, observation, context: ctx, topology, closure, now: now() }) }));
      for (const k of ['destructiveOperationAuthorized', 'installationExecuted', 'deploymentAuthorized']) assert.equal(result[k], false);
      assert.ok(result.blockers.includes('fence_external_topology_unverified'));
      return result;
    };
    phase = 'reachable_without_ports';
    assert.ok((await probe()).every(r => r.status === 200 && r.tlsVerified));
    assert.ok((await check()).blockers.includes('fence_nginx_not_stopped'));
    phase = 'closed_private_readiness'; await stop('nginx');
    assert.ok((await probe()).every(r => r.status === 502 && r.bodySha256 === hash(closedBody)));
    for (const role of ['api', 'cms']) assert.equal(await exec(role, ['node', '-e', `fetch('http://127.0.0.1:${role === 'api' ? 3000 : 3001}/${role === 'api' ? 'api' : 'editorial'}/ready').then(async r=>{if(r.status!==200)process.exit(1);console.log((await r.json()).status)}).catch(()=>process.exit(1))`]), 'ready');
    const privateCheck = await check('private-readiness');
    assert.ok(privateCheck.blockers.includes('fence_private_readiness_not_destructive')); assert.ok(privateCheck.blockers.includes('fence_writer_not_stopped'));
    phase = 'bypass';
    await docker(['network', 'connect', '--alias', 'api', fixture.networks[2].id, fixture.containers.api.id]);
    assert.equal(await exec('probe', ['node', '-e', `fetch('http://api:3000/api/ready').then(r=>console.log(r.status)).catch(()=>process.exit(1))`]), '200');
    assert.ok((await check()).blockers.includes('fence_alternative_ingress_detected'));
    await docker(['network', 'disconnect', fixture.networks[2].id, fixture.containers.api.id]);
    for (const role of ['api', 'cms', 'cron']) await stop(role);
    phase = 'baseline_fingerprint_capture';
    const before = await fingerprints();
    phase = 'baseline_database_identity';
    const physical = await dbObserve();
    assert.equal(physical[0].database.systemIdentifier, physical[1].database.systemIdentifier);
    assert.notEqual(physical[0].database.databaseOid, physical[1].database.databaseOid);
    assert.ok(physical.every(d => d.backgroundCoverageComplete && d.clients === 0 && d.preparedTransactions === 0));
    phase = 'baseline_fence_classifier';
    assert.deepEqual((await check()).blockers, ['fence_external_topology_unverified']);
    phase = 'baseline_fingerprint_comparison';
    assert.equal(await fingerprints(), before);
    phase = 'held_transaction';
    // The exact psql connection remains in its transaction until explicit release.
    // The 90s watchdog is failure-only, never the synchronization mechanism.
    await write('postgres', 'hold-wait.sh', `set -eu
touch /fixture/hold-ready
i=0
while [ ! -f /fixture/hold-release ]; do
  i=$((i+1)); if [ "$i" -ge 900 ]; then touch /fixture/hold-expired; exit 1; fi
  sleep 0.1
done
`);
    await write('postgres', 'hold.sql', "BEGIN;\nSET LOCAL idle_in_transaction_session_timeout='95s';\nSELECT 1;\n\\! sh /fixture/hold-wait.sh\nROLLBACK;\n");
    const waitMarker = async name => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const state = await exec('postgres', ['sh', '-c', `if [ -f /fixture/hold-expired ]; then echo expired; elif [ -f /fixture/${name} ]; then echo ready; else echo waiting; fi`]);
        assert.notEqual(state, 'expired');
        if (state === 'ready') return;
        await delay(100);
      }
      throw new Error('held_transaction_marker_timeout');
    };
    const assertHeld = async () => {
      await exec('postgres', ['sh', '-ceu', 'test ! -f /fixture/hold-expired; test ! -f /fixture/hold-done']);
       const observed = JSON.parse(await sql('portal', observationSQL));
      assert.equal(observed.clients, 1); assert.equal(observed.openTransactions, 1);
    };
    await withHeldTransaction({
      start: async () => {
        await inspect(fixture.containers.postgres);
        await docker(['exec', '-d', fixture.containers.postgres.id, 'sh', '-c',
          'psql -XqAt -v ON_ERROR_STOP=1 -U postgres -d portal -f /fixture/hold.sql >/dev/null 2>&1 && touch /fixture/hold-done || touch /fixture/hold-expired']);
      },
      ready: () => waitMarker('hold-ready'), assertHeld,
      observe: async () => assert.ok((await check()).blockers.includes('fence_database_not_quiescent')),
      release: () => write('postgres', 'hold-release', 'release'),
      finished: () => waitMarker('hold-done'),
    });
    phase = 'prepared_transaction';
    const gid = `fence_${fixture.nonce}`;
    await sql('portal', `BEGIN; SELECT 1; PREPARE TRANSACTION '${gid}';`);
    assert.equal(JSON.parse(await sql('portal', observationSQL)).preparedTransactions, 1);
    assert.ok((await check()).blockers.includes('fence_database_not_quiescent'));
    await sql('portal', `ROLLBACK PREPARED '${gid}';`);
    phase = 'final_observation';
    assert.deepEqual((await check()).blockers, ['fence_external_topology_unverified']);
    assert.equal(await fingerprints(), before); assert.equal(await foreignFingerprint(), foreignBefore);
    assert.ok(!interrupted);
  } catch {
    primaryFailure = phase;
  } finally {
    try { await cleanup(); } catch (error) { cleanupFailures = Array.isArray(error?.cleanupFailures) ? error.cleanupFailures : ['unknown']; }
    finally { process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal); }
  }
  if (primaryFailure || cleanupFailures.length) throw new FenceQualificationError(primaryFailure || 'none', cleanupFailures);
  return { kind: 'fence-topology-proof', actualDockerProjectionValidated: true, noPublishedPortsYetReachable: true,
    knownProxyRouteClosedAfterNginxStop: true, privateStubReadinessWhileClosed: true, alternativeIngressDetected: true,
    realDatabaseQuiescenceObserved: true, foreignFixtureUnchanged: true, ownedResourcesRemoved: true,
    applicationReadinessQualified: false, productionExternalCoverageVerified: false, completeProductionFenceProof: false, productionAuthorized: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) process.exitCode = 1;
  else qualify().then(proof => console.log(JSON.stringify(proof))).catch(error => {
    console.error(error instanceof FenceQualificationError ? error.message : 'fence_topology_qualification_failed:guard;cleanup:none'); process.exitCode = 1;
  });
}
