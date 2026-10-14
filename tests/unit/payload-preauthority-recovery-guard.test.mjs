import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { readFile, mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { awaitFixtureProxyAvailability } from '../../scripts/integration/payload-preauthority-snapshot-runtime.mjs';
import {
  candidateImagesValid, createFixtureProjectNames, createInventory, legacyAnnouncementLookupSql,
  normalizePgDumpForSnapshot, validateRecoveryInputs, writeProtectedInventory,
} from '../../scripts/integration/payload-preauthority-fixture.mjs';

const digest = (service, value) => `ghcr.io/ownerinc/ownerinc-portal-${service}@sha256:${value.repeat(64)}`;

test('recovery inputs are bound to a root-owned disposable Linux run and immutable published images', () => {
  const images = { api: digest('api', 'a'), cron: digest('cron', 'b'), cms: digest('cms', 'c') };
  assert.equal(candidateImagesValid(images), true);
  assert.equal(validateRecoveryInputs({
    platform: 'linux', uid: 0, images, commit: 'd'.repeat(40), runId: '12345', runAttempt: '2',
  }), true);

  assert.throws(() => validateRecoveryInputs({
    platform: 'linux', uid: 1000, images, commit: 'd'.repeat(40), runId: '12345', runAttempt: '2',
  }), /disposable_linux_root_runner_required/u);
  assert.throws(() => validateRecoveryInputs({
    platform: 'linux', uid: 0, images: { ...images, cms: 'ghcr.io/ownerinc/ownerinc-portal-cms:latest' },
    commit: 'd'.repeat(40), runId: '12345', runAttempt: '2',
  }), /immutable_candidate_images_required/u);
  assert.throws(() => validateRecoveryInputs({
    platform: 'linux', uid: 0, images, commit: 'd'.repeat(40), runId: '12345', runAttempt: '2',
    dockerEnvironment: { DOCKER_HOST: 'tcp://attacker.invalid:2375' },
  }), /docker_endpoint_override_forbidden/u);
  assert.equal(candidateImagesValid({ ...images, api: 'ghcr.io/ownerinc/ownerinc-portal-api:latest' }), false);
  assert.equal(candidateImagesValid({ ...images, cms: 'ghcr.io/other/ownerinc-portal-cms@sha256:' + 'c'.repeat(64) }), false);
});

test('fixture inventory uses isolated projects, explicit four-volume mounts, and explicit trust identity', () => {
  const runIdentity = { commit: 'd'.repeat(40), runId: '12345678901234567890', runAttempt: '987654321' };
  // Exercise the exact object passed by the recovery runner, not a helper-only shape.
  const names = createFixtureProjectNames(runIdentity);
  assert.notEqual(names.source, names.target);
  assert.match(names.source, /^payload-preauth-[a-z0-9-]+-source$/u);
  assert.match(names.target, /^payload-preauth-[a-z0-9-]+-target$/u);
  assert.ok(names.source.length <= 63 && names.target.length <= 63);
  assert.doesNotMatch(`${names.source} ${names.target}`, /ownerinc-portal-prod|production/iu);

  const root = path.resolve(os.tmpdir(), 'preauthority-guard-fixture');
  const source = createInventory({ project: names.source, root });
  const target = createInventory({ project: names.target, root: `${root}-target`,
    trustedSourceInventoryIdentities: [source.identity] });
  assert.equal(source.document.trustedSourceInventoryIdentities.length, 0);
  assert.deepEqual(target.document.trustedSourceInventoryIdentities, [source.identity]);
  assert.notEqual(source.identity, target.identity);
  assert.equal(source.document.schemaVersion, 2);
  assert.deepEqual(source.document.environmentFileOwner, { uid: 0, gid: 0 });
  assert.deepEqual(Object.keys(source.document.volumes).sort(), [
    'cmsPostgres', 'cmsUploads', 'portalPostgres', 'portalUploads',
  ]);
  assert.equal(source.document.volumes.portalPostgres.name, `${names.source}_postgres_data`);
  assert.deepEqual(source.document.volumes.portalUploads.mounts.map(item => item.service), ['api', 'cron']);
  assert.equal(source.document.volumes.cmsUploads.mounts.find(item => item.service === 'cms-worker').required, false);
  assert.throws(() => createInventory({ project: 'ownerinc-portal-prod', root }), /non_disposable_project/u);
  assert.throws(() => createFixtureProjectNames({ runId: 'not-a-run', runAttempt: '1' }), /invalid_run_identity/u);
});

test('real JS inventory-v2 producer is accepted by real Python protected-file loader and owner validator', async t => {
  const candidates = process.env.PYTHON ? [process.env.PYTHON] : process.platform === 'win32' ? ['python','python3'] : ['python3','python'];
  const python = candidates.find(command => spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0);
  if (!python) return t.skip('Python 3 unavailable; actual inventory consumer requires Python 3');
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'inventory-v2-producer-'));
  const canonicalPath = spawnSync(python, ['-c', 'import os,sys; print(os.path.realpath(sys.argv[1]))', temporary],
    { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 30_000 });
  assert.equal(canonicalPath.status, 0, canonicalPath.stderr);
  const root = canonicalPath.stdout.trim();
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const projects = createFixtureProjectNames({ commit: 'a'.repeat(40), runId: '731', runAttempt: '1' });
  const source = createInventory({ project: projects.source, root });
  const runtime = source.document.paths.runtime;
  await mkdir(runtime, { mode: 0o700 });
  const file = await writeProtectedInventory(runtime, source.document);
  await writeFile(source.document.paths.environmentFile, 'FIXTURE_VALUE=synthetic\n', { mode: 0o600 });
  await chmod(source.document.paths.environmentFile, 0o600);
  // Ownership participates in the identity before emission. The on-disk JSON is
  // byte-identical to the actual producer output, not handwritten test data.
  const raw = await readFile(file, 'utf8');
  assert.equal(createHash('sha256').update(raw.trimEnd()).digest('hex'), source.identity);
  const script = String.raw`
import copy, importlib.util, json, os, stat, sys, types
spec=importlib.util.spec_from_file_location('inventory_real',sys.argv[1])
I=importlib.util.module_from_spec(spec); spec.loader.exec_module(I)
file,environment,expected_hash=sys.argv[2:]
native_root=os.name!='nt' and os.getuid()==0 and os.getgid()==0
simulated=not native_root
real_os=os
original_lstat=os.lstat
original_fstat=os.fstat
def mapped(info,owner=(0,0)):
    values={name:getattr(info,name) for name in dir(info) if name.startswith('st_')}
    values['st_uid'],values['st_gid']=owner
    # NT has no POSIX mode/uid contract. Simulate that metadata explicitly,
    # while all path/type/link/inode and read/open checks still use real files.
    if real_os.name=='nt':
        values['st_mode']=stat.S_IFDIR|0o700 if stat.S_ISDIR(info.st_mode) else stat.S_IFREG|0o600
    return types.SimpleNamespace(**values)
if simulated:
    # Test-local POSIX metadata view only. Production module/file is unchanged.
    I.os=types.SimpleNamespace(**{name:getattr(real_os,name) for name in dir(real_os) if name!='name'})
    I.os.name='posix'
    I.os.lstat=lambda path:mapped(original_lstat(path))
    I.os.fstat=lambda fd:mapped(original_fstat(fd))
loaded=I.load(file)
assert loaded['schemaVersion']==2
assert loaded['environmentFileOwner']=={'uid':0,'gid':0}
assert I.identity(loaded)==expected_hash
I.verify_environment_file(environment,loaded['environmentFileOwner'])
def rejected(code,action):
    try: action()
    except I.InventoryError as error: assert str(error)==code,(str(error),code)
    else: raise AssertionError('invalid inventory accepted')
v1=copy.deepcopy(loaded); v1['schemaVersion']=1; del v1['environmentFileOwner']
rejected('unsupported_inventory_version',lambda:I.validate(v1))
missing=copy.deepcopy(loaded); del missing['environmentFileOwner']
rejected('invalid_inventory_shape',lambda:I.validate(missing))
wrong=copy.deepcopy(loaded); wrong['environmentFileOwner']={'uid':1000,'gid':1000}
rejected('invalid_environment_file_owner',lambda:I.validate(wrong))
bool_owner=copy.deepcopy(loaded); bool_owner['environmentFileOwner']={'uid':False,'gid':0}
rejected('invalid_environment_file_owner',lambda:I.validate(bool_owner))
# Always exercise the real POSIX owner predicate, including native root runs,
# using an explicit test metadata view rather than chowning system-owned paths.
if not simulated:
    I.os=types.SimpleNamespace(**{name:getattr(real_os,name) for name in dir(real_os) if name!='name'})
    I.os.name='posix'
I.os.lstat=lambda path:mapped(original_lstat(path),(1000,1000) if real_os.path.normpath(path)==real_os.path.normpath(environment) else (0,0))
rejected('unsafe_environment_owner',lambda:I.verify_environment_file(environment,{'uid':0,'gid':0}))
print(json.dumps({'identity':I.identity(loaded),'metadataSimulated':simulated,'posixOwnerMismatchRejected':True}))
`;
  const result = spawnSync(python, ['-c', script, path.resolve('ops/payload-control-inventory.py'),
    file, source.document.paths.environmentFile, source.identity], {
    encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.identity, source.identity);
  assert.equal(proof.posixOwnerMismatchRejected, true);
  t.diagnostic(proof.metadataSimulated
    ? 'Actual producer/file/Python loader; POSIX uid/gid/mode metadata explicitly simulated for local non-root/Windows account'
    : 'Actual producer/file/Python loader with native root POSIX metadata; mismatch uses test-local metadata view');
});

test('Task 3 provisions the documented CMS control-role baseline before native migrations without installing protocol', async () => {
  const runner = await readFile('scripts/test-payload-preauthority-recovery.mjs', 'utf8');
  const overlay = await readFile('scripts/integration/payload-preauthority-fixture.compose.yml', 'utf8');
  const compose = await readFile('docker-compose.payload.yml', 'utf8');
  const runbook = await readFile('docs/operations/owner-news-payload-migration.md', 'utf8');
  const provisionStart = runner.indexOf('async function provisionProject(runtime)');
  const provisionEnd = runner.indexOf('\nfunction syntheticUid', provisionStart);
  assert.ok(provisionStart >= 0 && provisionEnd > provisionStart);
  const setup = runner.slice(provisionStart, provisionEnd);
  const coordinator = await readFile('scripts/integration/payload-preauthority-initialize.mjs', 'utf8');
  const controller = await readFile('ops/payload-control-runtime.py', 'utf8');
  const initializeStart = controller.indexOf('    def initialize_isolated(self):');
  const initializeEnd = controller.indexOf('\n    def run(self):', initializeStart);
  assert.ok(initializeStart >= 0 && initializeEnd > initializeStart);
  const initialize = controller.slice(initializeStart, initializeEnd);
  assert.match(setup, /await initializePreauthority\(\{ runtime, runIdentity, images, run, withLease \}\)/u);
  assert.match(coordinator, /path\.join\(runtime\.directory, 'payload-operations-guard'\)/u);
  assert.match(coordinator, /\['initialize-isolated', runtime\.payloadRelease, request\]/u);
  assert.match(coordinator, /flag: 'wx', mode: 0o600/u);
  assert.match(coordinator, /verifyInitializerCheckout\(\{ runIdentity, run \}\)/u);
  assert.match(coordinator, /'safe\.directory=', '-c', `safe\.directory=\$\{checkout\}`/u);
  assert.match(coordinator, /run\('git', \[\.\.\.scoped, 'rev-parse', selector\], \{ cwd: checkout \}\)/u);
  assert.match(coordinator, /actualCommit = observe\('HEAD'\)/u);
  const capture = initialize.indexOf('self._capture_initial_b0(');
  const grants = initialize.indexOf("'portal_grants_pending'");
  const portalMigrate = initialize.indexOf("'-T', 'migrate'");
  const ordinaryProvision = initialize.indexOf("'cms-provision'");
  const roleBootstrap = initialize.indexOf("'cms-control-roles'");
  const migration = initialize.indexOf("'cms-migrate'");
  assert.ok(capture >= 0 && grants > capture && portalMigrate > grants && ordinaryProvision > portalMigrate,
    'B0 capture/signing and signed pre-grant stage precede normal grants and all CMS provisioning writes');
  assert.ok(ordinaryProvision >= 0 && roleBootstrap > ordinaryProvision && migration > roleBootstrap,
    'ordinary CMS role setup, control-role bootstrap, then native migration must be ordered explicitly');
  assert.ok(/--profile', 'cms-control-roles'/u.test(initialize.slice(roleBootstrap - 35, roleBootstrap + 35)),
    'the one-shot role service is selected only for its targeted run');
  assert.ok(/scripts\/provision-db\.ts', '--bootstrap-control'/u.test(initialize),
    'the fixture explicitly selects the existing bootstrap command rather than default read-only verification');
  assert.doesNotMatch(initialize, /--finalize-protocol|--upgrade-protocol/u,
    'the preauthority fixture must not install protocol to make role verification pass');
  assert.ok(initialize.indexOf('self._initial_floor_observations()', migration) > migration);
  assert.ok(initialize.indexOf('self.install_floor_commit()', migration) > migration);
  const observations = controller.slice(controller.indexOf('    def _initial_floor_observations'),
    controller.indexOf('    def install_floor_commit'));
  assert.match(observations, /self\._install_role_verification\(\)/u);
  assert.match(observations, /'--verify-runtime'/u);
  assert.match(observations, /_verify_cms\(self\.release_path, catalog=True\)/u);
  assert.ok(setup.indexOf("await awaitService(runtime, 'cms')") > setup.indexOf('await initializePreauthority'));
  assert.ok(setup.indexOf('await seedProject(runtime)') > setup.indexOf("await awaitService(runtime, 'cms')"));
  assert.doesNotMatch(setup, /GRANT SELECT|persist_current_release_marker/u,
    'setup no longer substitutes an ad-hoc grant or direct pointer write for the signed ops transaction');

  assert.ok(/CMS_CONTROLLER_PASSWORD=\$\{credentials\.cmsController\}/u.test(runner),
    'the synthetic controller credential is placed in the private fixture environment');
  assert.ok(/cmsController: secret\(\)/u.test(runner),
    'the controller credential is synthetic and generated for each fixture');
  assert.ok(/cms-control-roles:[\s\S]*?CMS_CONTROLLER_PASSWORD:[\s\S]*?--verify-control/u.test(compose),
    'the reusable profiled service scopes the controller credential to role verification/bootstrap');
  assert.ok(/profiles: \[cms-control-roles\]/u.test(compose));
  assert.ok(/cms-control-roles:[\s\S]*?networks: \[backend\]/u.test(overlay));
  assert.ok(runbook.includes('scripts/provision-db.ts --bootstrap-control` antes da migration\nnativa'),
    'the fixture follows the existing documented pre-migration provisioning phase');
});

test('legacy announcement lookup is bound to a captured source document UUID', () => {
  const sourceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const targetSeedId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const query = legacyAnnouncementLookupSql(sourceId);
  assert.match(query, new RegExp(`WHERE d\\.id='${sourceId}'$`, 'u'));
  assert.doesNotMatch(query, /LIKE|project|WHERE d\.title/u);
  assert.notEqual(query, legacyAnnouncementLookupSql(targetSeedId));
  assert.throws(() => legacyAnnouncementLookupSql('not-a-uuid'), /invalid_legacy_announcement_id/u);
});

test('fixture creates pinned read-only loopback/backend nginx after API/CMS readiness and before any writer observation or seed', async () => {
  const runner=await readFile('scripts/test-payload-preauthority-recovery.mjs','utf8');
  const setup=runner.slice(runner.indexOf('async function provisionProject(runtime)'),runner.indexOf('\nfunction syntheticUid'));
  const creation=setup.indexOf("['up', '--detach', '--no-deps', '--no-recreate', '--no-build', '--pull', 'never', 'nginx']");
  assert.ok(creation>setup.indexOf("await awaitService(runtime, 'cms')"));
  assert.ok(creation<setup.indexOf('observeFixtureWriters(runtime)'));
  assert.ok(setup.indexOf('runtime.fixtureNginxIdentity = preparedWriters.nginx')>creation);
  assert.ok(setup.indexOf('await assertFixtureFullSmoke(runtime)')<setup.indexOf('await seedProject(runtime)'));
  assert.equal((runner.match(/runtime\.fixtureNginxIdentity =/gu)||[]).length,1,'never replace the saved identity to satisfy a later smoke');
  assert.doesNotMatch(runner,/await awaitService\(runtime, 'nginx'\)/u);
  const compose=await readFile('docker-compose.yml','utf8');
  const nginx=compose.slice(compose.indexOf('\n  nginx:\n'),compose.indexOf('\n  cron:\n'));
  assert.match(nginx,/image: nginx:alpine@sha256:[a-f0-9]{64}/u);
  assert.match(nginx,/\.\/public:\/usr\/share\/nginx\/html:ro/u);
  assert.match(nginx,/\.\/nginx\/nginx\.conf:\/etc\/nginx\/conf\.d\/default\.conf:ro/u);
  assert.doesNotMatch(nginx,/healthcheck:/u);
  const overlay=await readFile('scripts/integration/payload-preauthority-fixture.compose.yml','utf8');
  assert.match(overlay,/nginx:\n\s+ports:\n\s+- "127\.0\.0\.1:\$\{HTTP_PORT:\?\}:80"\n\s+networks: \[backend\]/u);
});

test('both positive restores require the full fixture gate before target snapshot and coordinator, preserving negatives and POST-restore smoke', async () => {
  const runner=await readFile('scripts/test-payload-preauthority-recovery.mjs','utf8');
  assert.match(runner,/verifyProxy: awaitFixtureProxy/u);
  assert.match(runner,/environment: fixtureEnv\(runtime\.project, runtime, runtime\.payloadRelease\)/u);
  assert.match(runner,/execute: run/u);
  for(const [phase,label,backup] of [['first','first_target_before','targetBackup'],['second','second_target_before','secondName']]){
    const start=runner.indexOf(`setStage('${phase}_actual_restore')`);
    const end=runner.indexOf(`restoreAcceptanceProgress.${phase}.coordinatorReturnedSuccessfully = true`,start);
    const call=runner.slice(start,end);
    assert.ok(call.indexOf('await assertFixtureFullSmoke(target, () => {')>=0);
    assert.ok(call.indexOf('await assertFixtureFullSmoke')<call.indexOf(`snapshot(target, '${label}')`));
    assert.ok(call.indexOf(`snapshot(target, '${label}')`)<call.indexOf(`coordinator(target, target.project, 'restore', target.payloadRelease, ${backup})`));
  }
  assert.ok(runner.indexOf('safeChecks.allNegativeCasesRejectedBeforeRestore = true')<runner.indexOf("setStage('first_actual_restore')"));
  const coordinator=await readFile('scripts/payload-operations.sh','utf8');
  assert.match(coordinator,/BASE_URL=\$RESTORE_BASE_URL bash "\$root\/scripts\/smoke\.sh"/u);
});

test('real loopback HTTP availability checks exact assigned proxy port and running identity without a nginx healthcheck (not full smoke or Docker evidence)', async t => {
  let status=200;let requests=0;
  const server=createServer((req,res)=>{
    requests++;
    assert.equal(req.url,'/api/ready');
    res.writeHead(status);res.end('body intentionally not used by availability');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{server.closeAllConnections();server.close();});
  const port=server.address().port;
  const runtime={project:'payload-preauth-block2-1-1-source',port,baseUrl:`http://127.0.0.1:${port}`};
  const id='d'.repeat(64);
  const value={Id:id,Config:{Labels:{'com.docker.compose.project':runtime.project,'com.docker.compose.service':'nginx','com.docker.compose.oneoff':'False'}},
    State:{Status:'running',Running:true,Paused:false,Restarting:false},
    NetworkSettings:{Ports:{'80/tcp':[{HostIp:'127.0.0.1',HostPort:String(port)}]}}};
  let inspections=0;
  await awaitFixtureProxyAvailability(runtime,id,observed=>{assert.equal(observed,id);inspections++;return value;});
  assert.equal(inspections,2);assert.equal(requests,1);
  for(const mutate of [
    v=>{v.Id='e'.repeat(64);},v=>{v.Config.Labels['com.docker.compose.service']='api';},v=>{v.State.Status='exited';},
  ]){
    const changed=structuredClone(value);mutate(changed);
    await assert.rejects(awaitFixtureProxyAvailability(runtime,id,()=>changed),{code:'fixture_nginx_identity_invalid'});
  }
  const wrongPort=structuredClone(value);wrongPort.NetworkSettings.Ports['80/tcp'][0].HostPort=String(port===65535?port-1:port+1);
  await assert.rejects(awaitFixtureProxyAvailability(runtime,id,()=>wrongPort),{code:'fixture_nginx_port_invalid'});
  await assert.rejects(awaitFixtureProxyAvailability({...runtime,baseUrl:runtime.baseUrl+'/'},id,()=>value),{code:'fixture_nginx_endpoint_invalid'});
  assert.equal(requests,1,'identity, port and endpoint refusal occurs before any request');
  status=503;
  await assert.rejects(awaitFixtureProxyAvailability(runtime,id,()=>value),{code:'fixture_nginx_http_unavailable'});
  assert.equal(requests,9,'eight bounded availability attempts; API/container running is not HTTP success');
  status=200;let after=0;
  await assert.rejects(awaitFixtureProxyAvailability(runtime,id,()=>{
    after++;return after===1?value:{...value,State:{...value.State,Status:'exited',Running:false}};
  }),{code:'fixture_nginx_identity_invalid'});
});

test('snapshot normalization removes only the paired pg_dump boundary keys and retains row/sequence data', () => {
  const dump = (key, row = 'before', sequence = 17) => [
    '-- PostgreSQL database dump', '', `\\restrict ${key}`, '-- Dumped by pg_dump',
    'COPY public.fixture_rows (value) FROM stdin;',
    '\\restrict literal-copy-row', '\\unrestrict literal-copy-row', '\\.',
    `INSERT INTO public.fixture_rows (value) VALUES ('${row}');`,
    `SELECT pg_catalog.setval('public.fixture_rows_id_seq', ${sequence}, true);`,
    '-- PostgreSQL database dump complete', '', `\\unrestrict ${key}`, '',
  ].join('\n');
  const first = normalizePgDumpForSnapshot(Buffer.from(dump('key-first')));
  const repeated = normalizePgDumpForSnapshot(Buffer.from(dump('key-second')));
  assert.deepEqual(repeated, first, 'different random psql restriction keys must not alter snapshot identity');
  const retained = first.toString('utf8');
  assert.match(retained, /\\restrict literal-copy-row\n\\unrestrict literal-copy-row/u,
    'COPY payload lines that resemble psql commands must remain untouched');
  assert.notDeepEqual(normalizePgDumpForSnapshot(Buffer.from(dump('key-third', 'after'))), first,
    'changed database rows must remain visible to snapshot comparison');
  assert.notDeepEqual(normalizePgDumpForSnapshot(Buffer.from(dump('key-fourth', 'before', 18))), first,
    'changed sequence state must remain visible to snapshot comparison');
  assert.deepEqual(normalizePgDumpForSnapshot(Buffer.from('plain dump without psql controls\n')),
    Buffer.from('plain dump without psql controls\n'));
});

test('roles-only pg_dumpall normalizes paired keys before the exact cluster completion trailer', () => {
  const dump = (key, role = 'portal_api', newline = '\n') => [
    '--', '-- PostgreSQL database cluster dump', '--', '', `\\restrict ${key}`, '',
    `CREATE ROLE ${role};`, `ALTER ROLE ${role} WITH LOGIN;`,
    `\\unrestrict ${key}`, '', '--', '-- PostgreSQL database cluster dump complete', '--', '', '',
  ].join(newline);
  const first = normalizePgDumpForSnapshot(dump('first'));
  assert.deepEqual(normalizePgDumpForSnapshot(dump('second')), first);
  assert.deepEqual(normalizePgDumpForSnapshot(dump('first', 'portal_api', '\r\n')),
    normalizePgDumpForSnapshot(dump('second', 'portal_api', '\r\n')));
  assert.notDeepEqual(normalizePgDumpForSnapshot(dump('third', 'portal_cron')), first);
  assert.match(first.toString(), /CREATE ROLE portal_api;\nALTER ROLE portal_api WITH LOGIN;/u);
  assert.throws(() => normalizePgDumpForSnapshot(dump('first').replace('\\unrestrict first', '\\unrestrict other')),
    /invalid_pg_dump_snapshot_restriction_pair/u);
  for (const changed of [dump('first') + 'SELECT 1;\n', dump('first').replace('cluster dump complete', 'arbitrary comment')]) {
    assert.deepEqual(normalizePgDumpForSnapshot(changed), Buffer.from(changed));
  }
});
