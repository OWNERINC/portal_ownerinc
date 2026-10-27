import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { observeOrRestartWriters, assertWriterIdentities } from '../../scripts/integration/payload-preauthority-writer-restart.mjs';
import { WRITER_RESTART_CONTEXT, WRITER_RESTART_SUCCESS, encodeWriterRestartFailure,
  parseWriterRestartFailure, writerCommandFailureReason, writerServices, parseWriterObservation } from '../../scripts/integration/payload-preauthority-writer-restart-protocol.mjs';
import { runFixtureCommand, createFixtureCommandFailure, createLeasedCommandInvocation } from '../../scripts/integration/payload-preauthority-command.mjs';
import { createRecoveryFailureReportFields, runSnapshotAndRestart } from '../../scripts/integration/payload-preauthority-recovery-flow.mjs';
import { producedLinuxRecoveryFixture } from './payload-preauthority-snapshot-producer-fixture.mjs';
import { assertRecoveryFixtureConfiguration, serializeWriterRestartRequest } from '../../scripts/integration/payload-preauthority-snapshot-runtime.mjs';
import { assertConversionFixtureConfiguration } from '../../scripts/integration/payload-logical-snapshot-conversion-probe.mjs';

const produced = producedLinuxRecoveryFixture();
const request = JSON.parse(produced.restartResume.input);
// Keep the existing producer fixture unchanged. The runtime caller now supplies
// a fourth observed ID; exercise the same serializer used by production on the
// actual inventory/Compose-produced configuration, not a hand-authored config.
request.identities.nginx = 'd'.repeat(64);
const resumeInput = serializeWriterRestartRequest(request.configuration, 'restart', request.identities);
const services = ['api', 'cron', 'cms', 'nginx'];
test('four-service fixture identity contract includes nginx and accepts its full-ID observation beyond 256 bytes', () => {
  assert.deepEqual(writerServices, ['api','cron','cms','nginx']);
  const identities = {api:'a'.repeat(64),cron:'b'.repeat(64),cms:'c'.repeat(64),nginx:'d'.repeat(64)};
  const wire = JSON.stringify(identities)+'\n';
  assert.ok(Buffer.byteLength(wire)>256);
  assert.doesNotThrow(() => assertWriterIdentities(identities));
  assert.deepEqual(parseWriterObservation(wire), identities);
});
function fixture({ mode = 'restart', mutate = () => {}, failStart = null } = {}) {
  const data = structuredClone(request);
  data.mode = mode;
  if (mode === 'observe') data.identities = null;
  const events = [];
  const ids = request.identities;
  const states = Object.fromEntries(services.map(service => [service, {
    Id: ids[service], Config: { Labels: { 'com.docker.compose.project': produced.project,
      'com.docker.compose.service': service, 'com.docker.compose.oneoff': 'False' } },
    State: { Status: mode === 'observe' ? 'running' : 'exited', Running: mode === 'observe', Paused: false, Restarting: false },
  }]));
  const responses = Object.fromEntries(services.map(service => [service, `${ids[service]}\n`]));
  mutate({ data, states, responses });
  let current;
  const operations = {
    step: (phase, service, state) => { current = { phase, service, state }; events.push(current); },
    compose: args => { events.push({ compose: args }); assert.deepEqual(args.slice(0,4), ['ps','--all','--quiet','--no-trunc']); return Buffer.from(responses[args.at(-1)]); },
    docker: args => {
      events.push({ docker: args });
      const service = services.find(s => ids[s] === args[1]);
      assert.ok(service, 'never select a new ID');
      if (args[0] === 'inspect') return Buffer.from(JSON.stringify([states[service]]));
      assert.equal(args[0], 'start', 'no create/up/pull/restart/relabel or dependency traversal');
      if (failStart === service) throw Object.assign(new Error('private failure'), { restartReason: 'command_failed' });
      states[service].State = { Status: 'running', Running: true, Paused: false, Restarting: false };
      return Buffer.from(ids[service]);
    },
  };
  return { data, states, events, operations, current: () => current };
}

test('production producer observe/resume inputs carry identical Compose, project, release and sanitized commit binding', () => {
  assert.deepEqual(JSON.parse(produced.restartObserve.input).configuration, request.configuration);
  assert.equal(JSON.parse(produced.restartObserve.input).identities, null);
  assert.equal(produced.restartResume.env.PAYLOAD_RECOVERY_COMMIT, produced.commit);
  assert.deepEqual(request.configuration.composeArgs, JSON.parse(produced.wire.input).composeArgs);
  const wire = JSON.stringify(JSON.parse(resumeInput).identities)+'\n';
  assert.deepEqual(parseWriterObservation(wire), request.identities);
  const canonical = wire.trimEnd();
  for (const bad of [
    JSON.stringify({...request.identities, nginx:request.identities.api})+'\n',
    JSON.stringify({...request.identities, extra:'private'})+'\n',
    JSON.stringify({api:request.identities.api,cron:request.identities.cron,cms:request.identities.cms})+'\n',
    canonical, wire.slice(0,-3), wire+' '.repeat(513),
    canonical.slice(0,-1)+`,"nginx":"${request.identities.nginx}"}\n`,
  ]) assert.equal(parseWriterObservation(bad),null);
});

test('observe captures only running non-one-off writers; resume prevalidates all and starts/verifies those exact IDs without migration dependencies', () => {
  const observation = fixture({ mode: 'observe' });
  const observed = observeOrRestartWriters(observation.data, observation.operations);
  assert.deepEqual(observed, request.identities);
  assert.equal(observation.events.filter(e => e.docker?.[0] === 'start').length, 0);
  const resume = fixture();
  assert.deepEqual(observeOrRestartWriters(resume.data, resume.operations), observed);
  const firstStart = resume.events.findIndex(e => e.docker?.[0] === 'start');
  assert.equal(resume.events.slice(0, firstStart).filter(e => e.docker?.[0] === 'inspect').length, 4);
  assert.deepEqual(resume.events.filter(e => e.docker?.[0] === 'start').map(e => e.docker), services.map(s => ['start', observed[s]]));
  assert.equal(resume.events.filter(e => e.docker?.[0] === 'inspect').length, 8);
});

test('missing/ambiguous/replaced containers, invalid labels and every unexpected state fail before any start, with finite observation attribution', () => {
  const cases = [
    ['missing', value => { value.responses.cms = ''; }],
    ['ambiguous', value => { value.responses.cms += `${'e'.repeat(64)}\n`; }],
    ['identity_invalid', value => { value.responses.cms = `${'e'.repeat(64)}\n`; }],
    ['response_invalid', value => { value.responses.cms = 'private/path'; }],
    ['identity_invalid', value => { value.states.cms.Id = 'e'.repeat(64); }],
    ...['project', 'service', 'oneoff'].map(key => ['identity_invalid', value => { value.states.cms.Config.Labels[`com.docker.compose.${key}`] = 'foreign'; }]),
    ...['created','running','paused','dead','restarting','removing','unknown'].map(state => ['state_invalid', value => { value.states.cms.State.Status = state; }]),
  ];
  for (const [reason, mutate] of cases) {
    const f = fixture({ mutate });
    assert.throws(() => observeOrRestartWriters(f.data, f.operations), { restartReason: reason });
    assert.equal(f.events.some(e => e.docker?.[0] === 'start'), false);
    assert.equal(f.current().service, 'cms');
  }
  for (const invalid of [null, {}, { ...request.identities, cms: request.identities.api }, { ...request.identities, private: 'data' }]) {
    assert.throws(() => assertWriterIdentities(invalid));
  }
});

test('missing, swapped, duplicated or foreign fourth nginx rejects the whole set before ANY start', () => {
  const cases = [
    ['missing', f => { f.responses.nginx=''; }],
    ['identity_invalid', f => { f.responses.nginx='e'.repeat(64)+'\n'; }],
    ['identity_invalid', f => { f.responses.nginx=request.identities.api+'\n'; }],
    ...['project','service','oneoff'].map(key=>['identity_invalid', f => { f.states.nginx.Config.Labels[`com.docker.compose.${key}`]='foreign'; }]),
    ['state_invalid', f => { f.states.nginx.State.Status='created'; }],
  ];
  for(const [reason,mutate] of cases){
    const f=fixture({mutate});
    assert.throws(()=>observeOrRestartWriters(f.data,f.operations),{restartReason:reason});
    assert.equal(f.events.some(e=>e.docker?.[0]==='start'),false);
    assert.equal(f.current().service,'nginx');
  }
  const nginxFailure=fixture({failStart:'nginx'});
  assert.throws(()=>observeOrRestartWriters(nginxFailure.data,nginxFailure.operations),{restartReason:'command_failed'});
  assert.deepEqual(nginxFailure.current(),{phase:'start',service:'nginx',state:'exited'});
  assert.equal(nginxFailure.events.filter(e=>e.docker?.[0]==='start').length,4);
  const post=fixture();const docker=post.operations.docker;
  post.operations.docker=args=>{const result=docker(args);if(args[0]==='start'&&args[1]===request.identities.nginx)post.states.nginx.State.Status='exited';return result;};
  assert.throws(()=>observeOrRestartWriters(post.data,post.operations),{restartReason:'state_invalid'});
  assert.deepEqual(post.current(),{phase:'verify',service:'nginx',state:'exited'});
});

test('each of the four container identities and running flags is validated before ANY start, regardless of its position', () => {
  for(const service of services){
    for(const mutate of [
      value=>{value.responses[service]='';},
      value=>{value.states[service].Config.Labels['com.docker.compose.project']='foreign';},
      value=>{value.states[service].State.Paused=true;},
      value=>{value.states[service].State.Restarting=true;},
      value=>{value.states[service].State.Running=true;},
    ]){
      const f=fixture({mutate});
      assert.throws(()=>observeOrRestartWriters(f.data,f.operations));
      assert.equal(f.events.some(event=>event.docker?.[0]==='start'),false);
      assert.equal(f.current().service,service);
    }
  }
});

test('partial start failure is attributed precisely, never retries/recreates or claims success; post-start stopped state fails verification', () => {
  const f = fixture({ failStart: 'cron' });
  assert.throws(() => observeOrRestartWriters(f.data, f.operations), { restartReason: 'command_failed' });
  assert.deepEqual(f.current(), { phase: 'start', service: 'cron', state: 'exited' });
  assert.equal(f.events.some(e => e.docker?.[0] === 'start' && e.docker[1] === request.identities.cms), false);
  const verify = fixture();
  const docker = verify.operations.docker;
  verify.operations.docker = args => {
    const result = docker(args);
    if (args[0] === 'start') verify.states.api.State = { Status:'exited', Running:false, Paused:false, Restarting:false };
    return result;
  };
  assert.throws(() => observeOrRestartWriters(verify.data, verify.operations), { restartReason: 'state_invalid' });
  assert.deepEqual(verify.current(), { phase:'verify', service:'api', state:'exited' });
});

test('restart codec accepts only exact-context, canonical complete clean failures and actual wrapper publishes no private text', async () => {
  const value = { phase:'inventory', reason:'missing', service:'cms', state:'unknown' };
  const wire = encodeWriterRestartFailure(value);
  assert.deepEqual(parseWriterRestartFailure(wire, { context:WRITER_RESTART_CONTEXT, status:2 }), value);
  for (const overrides of [{context:'other'}, {status:1}, {errorCode:'ENOENT'}, {signal:'SIGTERM'}, {stdout:'private'}]) {
    assert.equal(parseWriterRestartFailure(wire, {context:WRITER_RESTART_CONTEXT,status:2,...overrides}), null);
  }
  for (const bad of [wire.trimEnd(), wire + 'private\n', wire.replace('missing','private'), wire.replace('cms','foreign')]) {
    assert.equal(parseWriterRestartFailure(bad, {context:WRITER_RESTART_CONTEXT,status:2}), null);
  }
  let error;
  try { runFixtureCommand(process.execPath,['-e',`process.stderr.write(${JSON.stringify(wire)});process.exitCode=2`], {
    writerRestartCommandContext:WRITER_RESTART_CONTEXT, writerRestartMode:'restart',
  }); } catch (caught) { error = caught; }
  assert.equal(error.code,'writer_restart_cms_inventory_missing');
  assert.equal(error.diagnostic.substep,'snapshot_restart_inventory_cms');
  const outcome = await runSnapshotAndRestart(async () => { throw {code:'snapshot_primary'}; }, async () => {throw error;});
  assert.equal(createRecoveryFailureReportFields(outcome).failureCode,'snapshot_primary');
  assert.equal(createRecoveryFailureReportFields(outcome).failureContext.writerRestart.failureCode,error.code);
  for (const [stdout, stderr] of [['', ''], [WRITER_RESTART_SUCCESS,'private\n'], ['private', '']]) {
    assert.throws(() => runFixtureCommand(process.execPath,['-e',`process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)})`], {
      writerRestartCommandContext:WRITER_RESTART_CONTEXT, writerRestartMode:'restart',
    }), {code:'writer_restart_protocol_invalid'});
  }
  for (const invalid of ['', '{}\n', JSON.stringify({...request.identities, cms: request.identities.api})+'\n', JSON.stringify(request.identities)]) {
    assert.throws(() => runFixtureCommand(process.execPath,['-e',`process.stdout.write(${JSON.stringify(invalid)})`], {
      writerRestartCommandContext:WRITER_RESTART_CONTEXT, writerRestartMode:'observe',
    }), {code:'writer_restart_protocol_invalid'});
  }
});

test('known failed Docker/Compose messages map to finite reasons only; unknown raw stderr is private', () => {
  const error = createFixtureCommandFailure({status:1,stderr:Buffer.from('private')});
  assert.equal(writerCommandFailureReason(error,Buffer.from('cms is missing dependency cms-migrate\n'),{compose:true}),'compose_dependency_missing');
  assert.equal(writerCommandFailureReason(error,Buffer.from('cms is missing dependency cms-migrate\n')),'command_failed');
  assert.equal(writerCommandFailureReason(error,Buffer.from('no such service: cms\n'),{compose:true}),'compose_service_unknown');
  assert.equal(writerCommandFailureReason(error,Buffer.from('no container to start\n'),{compose:true}),'compose_no_container');
  assert.equal(writerCommandFailureReason(error,Buffer.from(`Error response from daemon: No such container: ${'a'.repeat(64)}\n`)),'docker_container_missing');
  const evidence = [];
  createFixtureCommandFailure({status:1,stderr:Buffer.from('private path and data')}, {preservePrivateErrorEvidence:true,privateCommandEvidence:evidence});
  assert.equal(evidence[0].stderr.toString(),'private path and data');
  assert.equal(writerCommandFailureReason(error,evidence[0].stderr),'command_failed');
});

test('actual restart executable consumes actual producer JSON/environment and fails unleased before Docker effects', () => {
  assert.throws(() => runFixtureCommand(process.execPath,[path.resolve('scripts/integration/payload-preauthority-writer-restart.mjs')], {
    input:resumeInput,env:produced.environment,writerRestartCommandContext:WRITER_RESTART_CONTEXT,writerRestartMode:'restart',
  }), {code:'writer_restart_all_lease_lease_invalid'});
});

test('actual producer and executable cover all three real provisioned fixtures; conversion remains source-only and cross-role bindings reject', () => {
  for (const {role, wire, environment} of produced.restartFixtures) {
    const configuration = JSON.parse(wire.input).configuration;
    assert.doesNotThrow(() => assertRecoveryFixtureConfiguration(configuration, environment, ['source','target','lease-target']));
    if (role === 'source') assert.doesNotThrow(() => assertConversionFixtureConfiguration(configuration,environment));
    else assert.throws(() => assertConversionFixtureConfiguration(configuration,environment), {probeReason:'configuration_runtime_invalid'});
    assert.throws(() => runFixtureCommand(process.execPath,[path.resolve('scripts/integration/payload-preauthority-writer-restart.mjs')], {
      input:wire.input,env:environment,writerRestartCommandContext:WRITER_RESTART_CONTEXT,writerRestartMode:'observe',
    }), {code:'writer_restart_all_lease_lease_invalid'});
    const other = { ...configuration, project: configuration.project.replace(/-(source|target|lease)$/u,'-foreign') };
    assert.throws(() => assertRecoveryFixtureConfiguration(other,environment,['source','target','lease-target']), {probeReason:'configuration_project_invalid'});
  }
});

test('runner observes IDs before stop and invokes tested restart producer under lease after conversion success, retaining readiness and report gates', async () => {
  const runner = await readFile('scripts/test-payload-preauthority-recovery.mjs','utf8');
  const section = runner.slice(runner.indexOf('async function assertQuiescentSnapshotStable'),runner.indexOf('async function stopWriters'));
  assert.ok(section.indexOf('observeFixtureWriters(runtime)') < section.indexOf("['stop', '--timeout'"));
  assert.ok(section.indexOf('conversionProbeCommandContext: CONVERSION_PROBE_CONTEXT') < section.indexOf("quiescentSnapshotComparison = 'passed'"));
  assert.ok(section.indexOf("quiescentSnapshotComparison = 'passed'") < section.indexOf("mode: 'restart', identities: observedWriters"));
  assert.doesNotMatch(section,/composeWithLease\(runtime, \['start'/u);
  assert.match(section,/writerRestartCommandContext: WRITER_RESTART_CONTEXT/u);
  assert.match(section,/for \(const service of writers\.filter\(service => service !== 'nginx'\)\) await awaitService\(runtime, service\)/u);
  assert.match(section,/await awaitFixtureProxy\(runtime, observedWriters\.nginx\)/u);
});

test('actual Compose service model gates CMS and shared-cluster initializer receipts only created candidate services', async () => {
  const compose = await readFile('docker-compose.payload.yml','utf8');
  const cms = compose.slice(compose.indexOf('\n  cms:\n'),compose.indexOf('\nvolumes:\n'));
  assert.match(cms,/cms-migrate:\n\s+condition: service_completed_successfully/u);
  const runtime = await readFile('ops/payload-control-runtime.py','utf8');
  const create = runtime.slice(runtime.indexOf('def _initialize_resources'),runtime.indexOf('def _initial_floor_observations'));
  assert.match(create,/\['up', '--no-start', '--no-recreate', '--no-build', '--no-deps', '--pull', 'never', service\]/u);
  assert.match(create,/\(\('cms', 'api', 'cron'\) if shared else \('cms-postgres', 'cms'\)\)/u);
  assert.doesNotMatch(compose,/\n  cms-postgres:|cms_postgres_data|\n  cms-worker:/u);
  assert.match(runtime,/\['run', '--rm', '--no-deps', '--pull', 'never', '-T', 'cms-migrate'\]/u);
});

// Linux-only full executable/lease/Docker transport regression uses a fake Docker
// binary, never a daemon. Native FD9 and actual producer/consumer are NOT doubled.
test('native Linux Bash/flock → real restart CLI → fake Docker observes then resumes same IDs with real sanitized producer environment', {
  skip: process.platform !== 'linux' || process.getuid?.() !== 0 ? 'requires native Linux root lease ABI; fake Docker only, no daemon' : false,
}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'writer-restart-'));
  try {
    const directory = path.join(root,'source','runtime');
    const { mkdir } = await import('node:fs/promises'); await mkdir(directory,{recursive:true});
    const lock = path.join(directory,'deploy.lock'); await writeFile(lock,'',{mode:0o600});
    // Only the protected disposable filesystem root is relocated from the real
    // producer. Compose/env/commit keys and arguments remain its actual contract.
    const input = resumeInput.replaceAll('/private/disposable',root);
    const environment = Object.fromEntries(Object.entries(produced.environment).map(([key,value]) => [key,value.replaceAll('/private/disposable',root)]));
    environment.PATH = `${root}:${environment.PATH}`;
    const stateFile = path.join(root,'state.json');
    const callFile = path.join(root,'calls.jsonl');
    await writeFile(stateFile,JSON.stringify(Object.fromEntries(services.map(s=>[s,'running']))));
    const fake = `#!${process.execPath}\nconst fs=require('fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(callFile)},JSON.stringify({args,home:process.env.HOME,ambient:process.env.GITHUB_SHA})+'\\n');
const ids=${JSON.stringify(request.identities)},project=${JSON.stringify(produced.project)};let state=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}));
if(args[0]==='compose'){if(args.includes('start')){process.stderr.write('cms is missing dependency cms-migrate\\n');process.exit(1)}process.stdout.write(ids[args.at(-1)]+'\\n')}
else {let s=Object.keys(ids).find(s=>ids[s]===args[1]);if(args[0]==='start'){state[s]='running';fs.writeFileSync(${JSON.stringify(stateFile)},JSON.stringify(state));process.stdout.write(ids[s]+'\\n')}
else if(args[0]==='inspect')process.stdout.write(JSON.stringify([{Id:ids[s],Config:{Labels:{'com.docker.compose.project':project,'com.docker.compose.service':s,'com.docker.compose.oneoff':'False'}},State:{Status:state[s],Running:state[s]==='running',Paused:false,Restarting:false}}]));else process.exit(1)}\n`;
    const binary = path.join(root,'docker'); await writeFile(binary,fake); await chmod(binary,0o700);
    const invocation = createLeasedCommandInvocation(lock,process.execPath,[path.resolve('scripts/integration/payload-preauthority-writer-restart.mjs')]);
    const observed = runFixtureCommand(invocation.command,invocation.args,{
      input:produced.restartObserve.input.replaceAll('/private/disposable',root),env:environment,
      writerRestartCommandContext:WRITER_RESTART_CONTEXT,writerRestartMode:'observe',
    });
    assert.deepEqual(JSON.parse(observed),request.identities);
    // Only the Docker state is a double; simulate the already-tested stop path.
    await writeFile(stateFile,JSON.stringify(Object.fromEntries(services.map(s=>[s,'exited']))));
    const resumed = JSON.parse(input); resumed.identities = JSON.parse(observed);
    const output = runFixtureCommand(invocation.command,invocation.args,{input:JSON.stringify(resumed),env:environment,writerRestartCommandContext:WRITER_RESTART_CONTEXT,writerRestartMode:'restart'});
    assert.equal(output.toString(),WRITER_RESTART_SUCCESS);
    const calls = (await readFile(callFile,'utf8')).trim().split('\n').map(JSON.parse);
    assert.deepEqual(calls.filter(c=>c.args[0]==='start').map(c=>c.args),services.map(s=>['start',request.identities[s]]));
    for(const call of calls){assert.equal(call.home,'/root');assert.equal(call.ambient,undefined);}
    const expected = services.map(s=>['compose',...JSON.parse(input).configuration.composeArgs,'ps','--all','--quiet','--no-trunc',s]);
    assert.deepEqual(calls.filter(c=>c.args[0]==='compose').map(c=>c.args),[...expected,...expected]);
  } finally {await rm(root,{recursive:true,force:true});}
});
