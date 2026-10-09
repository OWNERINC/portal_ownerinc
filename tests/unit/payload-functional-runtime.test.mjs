import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,mkdir,writeFile,readFile,rm,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCompose,fixtureIdentity,hash,materializeFunctionalRuntime,validateComposeContract }
  from '../../scripts/integration/payload-functional-fixture.mjs';
import { reserveFunctionalForwarder } from '../../scripts/integration/payload-functional-forwarder.mjs';

async function template(t) {
  const parent=process.platform==='win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA,'Temp','opencode') : tmpdir();
  const scratch=await mkdtemp(path.join(parent,'payload-functional-runtime-unit-'));t.after(()=>rm(scratch,{recursive:true,force:true}));
  const identity=fixtureIdentity('134cfd81-7f0d-47ca-a4fb-c9cabd069c0f'),directory=path.join(scratch,identity.project);
  await mkdir(directory,{mode:0o700});
  const config={httpsPort:0,apiImage:'sha256:'+'a'.repeat(64),cmsImage:'sha256:'+'b'.repeat(64),emulatorImage:'sha256:'+'c'.repeat(64)};
  const secrets=Object.fromEntries(['portalAdmin','portalRuntime','portalCron','cmsAdmin','cmsMigrator','cmsRuntime','payload','toPortal','toPayload','bulk']
    .map((key,index)=>[key,index.toString(16).repeat(64)]));
  // Only artifact binding is under test here: these are not TLS credentials and
  // this unit lease cannot be admitted by readFunctionalLease for execution.
  const cert=Buffer.from('synthetic-certificate-binding-unit-only'),key=Buffer.from('synthetic-key-binding-unit-only');
  const manifest=buildCompose(identity,config,directory,secrets);
  for(const [name,body] of Object.entries({'compose.json':JSON.stringify(manifest),'cert.pem':cert,'key.pem':key}))
    await writeFile(path.join(directory,name),body,{mode:0o600,flag:'wx'});
  return {identity,directory,config,tls:{certificateHash:hash(cert),keyHash:hash(key)},manifest,
    fileHashes:{'compose.json':hash(JSON.stringify(manifest)),'cert.pem':hash(cert),'key.pem':hash(key)}};
}

test('runtime artifacts derive one stable TLS origin from the real reserved listener; templates are never executed (synthetic private lease unit)',async t=>{
  const lease=await template(t),forwarder=await reserveFunctionalForwarder();t.after(()=>forwarder.stop());
  // FS-read seam avoids claiming admission of this synthetic lease (in
  // particular, the shared Task3 reader refuses this Windows user's Git HOME).
  const runtime=await materializeFunctionalRuntime(lease,forwarder,readFile),origin=forwarder.origin;
  assert.equal(runtime.config.httpsPort,forwarder.port);assert.equal(lease.config.httpsPort,0);
  assert.equal(runtime.directory,path.join(lease.directory,'runtime'));
  validateComposeContract(runtime.manifest,lease.identity,runtime.config,runtime.directory);
  for(const role of ['cms','cms-migrate','api']) assert.equal(runtime.manifest.services[role].environment.PORTAL_PUBLIC_URL,origin);
  assert.equal(runtime.manifest.services.api.environment.CORS_ORIGINS,origin);
  for(const service of Object.values(runtime.manifest.services)) assert.equal(Object.hasOwn(service,'ports'),false);
  const firebase=await readFile(path.join(runtime.directory,'firebase-config.js'),'utf8');
  assert.ok(firebase.includes(JSON.stringify(origin)));assert.ok(!firebase.includes('https://127.0.0.1:0'));
  assert.ok((await readFile(path.join(runtime.directory,'nginx.conf'),'utf8')).includes(origin));
  const binding=JSON.parse(await readFile(path.join(runtime.directory,'transport-binding.json'),'utf8'));
  assert.equal(binding.origin,origin);assert.equal(binding.runnerPid,process.pid);assert.equal(binding.runId,lease.identity.runId);
  for(const [name,digest] of Object.entries(binding.hashes)) {
    assert.equal(hash(await readFile(path.join(runtime.directory,name))),digest);
    if(process.platform!=='win32') assert.equal((await stat(path.join(runtime.directory,name))).mode & 0o077,0);
  }
  assert.equal(JSON.parse(await readFile(path.join(lease.directory,'compose.json'),'utf8')).services.api.environment.PORTAL_PUBLIC_URL,'https://127.0.0.1:0');
  await assert.rejects(materializeFunctionalRuntime(lease,forwarder,readFile),/run_directory_collision/);
});

test('actual tampering of protected artifact bodies rejects original lease fingerprints; self-reported changed hash cannot authorize an operational target (read seam only)',async t=>{
  const lease=await template(t),forwarder=await reserveFunctionalForwarder();t.after(()=>forwarder.stop());
  const keyPath=path.join(lease.directory,'key.pem'),original=await readFile(keyPath);
  await writeFile(keyPath,'changed-synthetic-private-key-unit-only');
  await assert.rejects(materializeFunctionalRuntime(lease,forwarder,readFile),{code:'functional_tls_identity_invalid'});
  await writeFile(keyPath,original);
  const changed=structuredClone(lease.manifest);changed.services.api.environment.PORTAL_PUBLIC_URL='https://external.invalid';
  const bytes=JSON.stringify(changed);await writeFile(path.join(lease.directory,'compose.json'),bytes);
  await assert.rejects(materializeFunctionalRuntime(lease,forwarder,readFile),{code:'functional_artifact_hash_mismatch'});
  await assert.rejects(materializeFunctionalRuntime({...lease,fileHashes:{...lease.fileHashes,'compose.json':hash(bytes)}},forwarder,readFile),
    {code:'functional_compose_contract_invalid'});
});

test('false desired listener/config bindings, changed TLS artifacts and an already-closed real listener fail before runtime materialization',async t=>{
  const lease=await template(t),forwarder=await reserveFunctionalForwarder();t.after(()=>forwarder.stop());
  for(const changed of [{...forwarder,port:forwarder.port+1},{...forwarder,origin:'https://external.invalid'},
    {...forwarder,assertHealthy:()=>({address:'0.0.0.0',port:forwarder.port,pid:process.pid})},
    {...forwarder,assertHealthy:()=>({address:'127.0.0.1',port:forwarder.port,pid:process.pid+1})}]) {
    await assert.rejects(materializeFunctionalRuntime(lease,changed,readFile),{code:'functional_runtime_listener_binding_invalid'});
  }
  await assert.rejects(materializeFunctionalRuntime({...lease,config:{...lease.config,httpsPort:19443}},forwarder,readFile),{code:'functional_runtime_listener_binding_invalid'});
  await assert.rejects(materializeFunctionalRuntime({...lease,tls:{...lease.tls,keyHash:'e'.repeat(64)}},forwarder,readFile),{code:'functional_tls_identity_invalid'});
  await forwarder.stop();forwarder.assertStopped();
  await assert.rejects(materializeFunctionalRuntime(lease,forwarder,readFile),{code:'functional_forwarder_listener_closed'});
});
