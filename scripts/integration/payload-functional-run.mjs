import assert from 'node:assert/strict';
import { readFile, open } from 'node:fs/promises';
import path from 'node:path';
import { fail, hash, readFunctionalLease,materializeFunctionalRuntime } from './payload-functional-fixture.mjs';
import { assertContainerBinding, assertPhysicalTargets, assertVolumeBinding, composeClient, dockerPreflight, fixtureSQL, inspectPhysicalTarget } from './payload-functional-targets.mjs';
import { createSyntheticAccounts, httpsFixtureClient } from './payload-functional-http.mjs';
import { finishFunctionalReport, newFunctionalReport, runFunctionalCase } from '../../cms/tests/integration/functional-matrix.mjs';
import { runBrowserContracts, runSessionContracts } from '../../cms/tests/integration/functional-preauthority.mjs';
import { assertFixtureNetwork,assertContainerNetwork,assertResolvedContainerEnvironment,assertResolvedFixtureConfig } from './payload-functional-isolation.mjs';
import { reserveFunctionalForwarder,functionalNginxVerifier } from './payload-functional-forwarder.mjs';
import { assertFunctionalHTTPSReadiness } from './payload-functional-readiness.mjs';

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function waitDatabase(compose,role) {
  const deadline=Date.now()+90000;
  while(Date.now()<deadline) {
    try {
      const data=JSON.parse(await compose(['ps','--all','--format','json',role]));
      const row=Array.isArray(data) ? data[0] : data;
      if(row?.Health==='healthy') return;
      if(row?.State==='exited') fail('functional_database_start_failed');
    } catch(error) {if(error.code==='functional_database_start_failed') throw error;}
    await delay(1000);
  }
  fail('functional_database_readiness_timeout');
}

async function newsDigest(sql) {
  const names=(await sql('cms',`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND
    (c.relname ~ '^(news_|_news_|legacy_news_)' OR c.relname IN ('payload_jobs','payload_locked_documents','payload_locked_documents_rels')) ORDER BY c.relname;`)).split('\n');
  if(!names.includes('news_articles') || !names.includes('news_media') || names.some(name=>!/^[_a-z][_a-z0-9]*$/.test(name))) fail('functional_news_inventory_invalid');
  const entries=[];
  for(const name of names) {
    // Bounded command transport hashes actual rows including Versions/locks/jobs, not headings or counts alone.
    const rows=await sql('cms',`SELECT row_to_json(t)::text FROM public."${name}" t ORDER BY row_to_json(t)::text COLLATE "C";`);
    entries.push({name,hash:hash(rows)});
  }
  const legacy=await sql('portal',`SELECT row_to_json(t)::text FROM cms_documents t WHERE content_type='announcement' ORDER BY id;`);
  const authority=await sql('portal',`SELECT mode||'|'||epoch::text FROM owner_news_authority WHERE singleton=true;`);
  return {hash:hash(JSON.stringify({entries,legacyHash:hash(legacy),authority})),authority};
}

async function verifyBindings(lease,docker,images,roles,isolation) {
  const network=JSON.parse(await docker(['network','inspect',`${lease.identity.project}-network`]))[0];
  assertFixtureNetwork(lease.identity,network);
  for(const role of roles) {
    const imageRole=role.endsWith('-db') ? 'postgres' : ['portal-migrate','api'].includes(role) ? 'api' :
      ['cms-provision','cms-migrate','cms'].includes(role) ? 'cms' : role;
    const image=images[imageRole];
    const observed=JSON.parse(await docker(['inspect',lease.identity.containers[role]]))[0];
    assertContainerBinding(lease.identity,role,observed,image);
    assertContainerNetwork(lease.identity,observed,network.Id);
    assertResolvedContainerEnvironment(observed.Config,isolation.imageEnvironments[imageRole],isolation.manifest.services[role].environment);
  }
  const existingVolumeRoles=roles.some(role=>role==='api') ? Object.keys(lease.identity.volumes) : ['portal-db','cms-db'];
  for(const role of existingVolumeRoles) assertVolumeBinding(lease.identity,role,JSON.parse(await docker(['volume','inspect',lease.identity.volumes[role]]))[0]);
}

async function stopOwnedServices(lease,compose,docker,images) {
  const roles=[];
  // Do not act on an exact-name collision/replacement merely because a Compose
  // document lists it. Inspect current ownership before any stop operation.
  for(const [role,name] of Object.entries(lease.identity.containers)) {
    const existing=await docker(['ps','-aq','--filter',`name=^/${name}$`]);
    if(!existing) continue;
    const image=role.endsWith('-db') ? images.postgres : ['portal-migrate','api'].includes(role) ? images.api :
      ['cms-provision','cms-migrate','cms'].includes(role) ? images.cms : images[role];
    assertContainerBinding(lease.identity,role,JSON.parse(await docker(['inspect',name]))[0],image);
    roles.push(role);
  }
  if(roles.length) await compose(['stop','--timeout','30',...roles],{timeout:330000});
  const running=await compose(['ps','--status','running','-q']);
  if(running) fail('functional_owned_process_still_running');
}

async function persistReport(lease,report) {
  const filename=path.join(lease.directory,'functional-acceptance-report.json');
  const handle=await open(filename,'wx',0o600);
  try {await handle.writeFile(JSON.stringify(report,null,2)+'\n');await handle.sync();} finally {await handle.close();}
}

export async function executeFunctionalLease(filename,env) {
  const lease=await readFunctionalLease(filename,env);
  const report=newFunctionalReport(lease.identity.runId);
  report.source={...lease.binding}; report.startedAt=new Date().toISOString();
  let compose,docker,images,forwarder,runtimeLease,created=false,interrupted=false,stage='loopback_listener_reservation';
  const onSignal=()=>{interrupted=true;void forwarder?.stop();};
  process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
  try {
    forwarder=await reserveFunctionalForwarder();
    if(interrupted) fail('functional_runner_interrupted');
    stage='runtime_transport_materialization';runtimeLease=await materializeFunctionalRuntime(lease,forwarder);
    stage='docker_preflight';const preflight=await dockerPreflight(runtimeLease);
    ({docker,images}=preflight); report.images=images;
    compose=composeClient(runtimeLease);
    const isolation={imageEnvironments:preflight.imageEnvironments,manifest:runtimeLease.manifest};
    stage='resolved_fixture_configuration';
    assertResolvedFixtureConfig(JSON.parse(await compose(['config','--format','json'])),isolation.manifest);
    forwarder.assertHealthy();stage='fresh_database_start';created=true;
    // Never --build/--pull, never reuse volumes, and no application writer before physical checks.
    await compose(['up','--detach','--no-build','--pull','never','portal-db','cms-db','emulator'],{timeout:120000});
    await waitDatabase(compose,'portal-db');await waitDatabase(compose,'cms-db');
    await verifyBindings(lease,docker,images,['portal-db','cms-db','emulator'],isolation);
    const sql=fixtureSQL(compose,lease.identity);
    stage='physical_targets_before_ddl';
    const portal=await inspectPhysicalTarget(sql,'portal'),cms=await inspectPhysicalTarget(sql,'cms');
    assertPhysicalTargets(lease.identity,portal,cms);
    // Bind both SQL observations to the inspected container network address.
    for(const [role,target] of [['portal-db',portal],['cms-db',cms]]) {
      const observed=JSON.parse(await docker(['inspect',lease.identity.containers[role]]))[0];
      const networks=Object.values(observed.NetworkSettings.Networks);
      assert.equal(networks.length,1);assert.equal(target.serverAddress,networks[0].IPAddress);
    }
    report.targetBindings={portalSystemIdentifierHash:hash(portal.systemIdentifier),cmsSystemIdentifierHash:hash(cms.systemIdentifier),
      independentClusters:true,freshBeforeDDL:true};
    stage='explicit_fixture_migrations';
    for(const role of ['portal-migrate','cms-provision','cms-migrate']) {
      forwarder.assertHealthy();
      await verifyBindings(lease,docker,images,['portal-db','cms-db'],isolation);
      assert.equal(await sql('portal',`SELECT system_identifier::text FROM pg_control_system();`),portal.systemIdentifier);
      assert.equal(await sql('cms',`SELECT system_identifier::text FROM pg_control_system();`),cms.systemIdentifier);
      await compose(['up','--no-build','--pull','never','--abort-on-container-exit','--exit-code-from',role,role],{timeout:240000});
      await verifyBindings(lease,docker,images,[role],isolation);
    }
    const before=await newsDigest(sql);assert.equal(before.authority,'legacy|1');
    forwarder.assertHealthy();stage='real_runtime_start';
    await compose(['up','--detach','--no-build','--pull','never','api','cms','nginx'],{timeout:120000});
    await verifyBindings(lease,docker,images,['api','cms','nginx'],isolation);
    stage='inspected_internal_nginx_binding';
    const target=await forwarder.activate(functionalNginxVerifier(lease.identity,docker,images.nginx));
    const origin=forwarder.origin;
    const client=httpsFixtureClient(origin,await readFile(path.join(lease.directory,'cert.pem')));
    stage='real_https_readiness';const readiness=await assertFunctionalHTTPSReadiness(client,forwarder);
    report.transport={kind:'host_loopback_tcp_to_internal_nginx',origin,runnerPid:forwarder.pid,
      targetBindingHash:hash(JSON.stringify(target)),...readiness,containerPublishedPorts:false};
    report.layers={portalApi:'REAL',firebase:'NOT_EXECUTED',cms:'REAL',nginx:'REAL',browser:'NOT_EXECUTED'};
    await forwarder.recheck();stage='synthetic_identity_setup';const accounts=await createSyntheticAccounts(client,lease.identity,sql);
    report.layers.firebase='REAL';
    await forwarder.recheck();stage='http_session_contracts';await runSessionContracts({report,client,accounts,sql,origin});
    await forwarder.recheck();stage='real_browser_contracts';await runBrowserContracts({lease,report,client,accounts,sql,origin});
    report.layers.browser='REAL';
    await runFunctionalCase(report,'OPS-preauthority-integrity',async()=>{
      await forwarder.recheck();
      await verifyBindings(lease,docker,images,Object.keys(lease.identity.containers),isolation);
      const after=await newsDigest(sql);assert.equal(after.authority,'legacy|1');assert.equal(after.hash,before.hash);
      const containers=(await docker(['ps','-aq','--filter',`label=com.docker.compose.project=${lease.identity.project}`])).split('\n').filter(Boolean);
      assert.equal(containers.length,Object.keys(lease.identity.containers).length);
      assert.equal(await sql('cms',`SELECT to_regclass('public.owner_news_mutation_head') IS NULL;`),'t');
      report.integrity={beforeNewsHash:before.hash,afterNewsHash:after.hash,authorityMode:'legacy',authorityEpoch:1};
      return [{check:'news_rows_versions_jobs_unchanged',passed:true},{check:'authority_legacy_epoch_one',passed:true},
        {check:'independent_fresh_physical_targets',passed:true},{check:'protocol_worker_import_absent',passed:true}];
    });
  } catch {
    report.failure={stage,reason:'functional_execution_failed'};
    // Setup failure is not an executed scenario; pending cases stay INCOMPLETE.
  } finally {
    stage='owned_forwarder_stop';
    if(forwarder) {
      try {await forwarder.stop();forwarder.assertStopped();report.transportCleanup='owned_listener_and_sockets_closed';}
      catch {report.transportCleanup='owned_listener_stop_failed';report.failure ||= {stage,reason:'functional_transport_cleanup_failed'};}
    } else report.transportCleanup='no_listener_created';
    stage='owned_process_stop';
    if(created && compose) {
      try {
        await stopOwnedServices(runtimeLease,compose,docker,images);
        report.cleanup='owned_services_stopped_volumes_and_evidence_retained';
      } catch {report.cleanup='owned_stop_failed_preserved';report.failure ||= {stage,reason:'functional_cleanup_failed'};}
    } else report.cleanup='no_services_created';
    if(interrupted) report.failure ||= {stage:'runner_interrupted',reason:'functional_execution_interrupted'};
    process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);
    report.finishedAt=new Date().toISOString();
    let code=finishFunctionalReport(report);
    if(report.failure || report.cleanup==='owned_stop_failed_preserved'){report.status='FAIL';code=1;}
    await persistReport(lease,report);
    return {code,report};
  }
}
