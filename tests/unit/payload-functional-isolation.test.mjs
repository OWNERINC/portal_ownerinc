import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { assertContainerNetwork,assertFixtureNetwork,assertImageEnvironment,assertNoOperationalImageFiles,
  assertResolvedContainerEnvironment,assertResolvedFixtureConfig,disabledProviderEnvironment,imageFileProbeArguments,probeImageFiles }
  from '../../scripts/integration/payload-functional-isolation.mjs';
import { buildCompose,fixtureIdentity } from '../../scripts/integration/payload-functional-fixture.mjs';

const identity=fixtureIdentity('134cfd81-7f0d-47ca-a4fb-c9cabd069c0f'),imageId='sha256:'+'a'.repeat(64);
const pathEnv='PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const imageConfig=role=>({Env:[pathEnv,'NODE_VERSION=24.12.0','YARN_VERSION=1.22.22',
  ...(role==='cms' ? ['NODE_ENV=production','NEXT_TELEMETRY_DISABLED=1'] : [])],
  WorkingDir:{api:'/app',cms:'/app/cms',emulator:'/workspace'}[role]});

test('image Config.Env admits only known safe base values; operational secrets/targets are denied even when overridden or empty',()=>{
  for(const role of ['api','cms','emulator']) {
    const observed=imageConfig(role);assertImageEnvironment(role,observed);
    for(const entry of ['FIREBASE_PROJECT_ID=production-project','FIREBASE_PRIVATE_KEY=private-unit-only','SMTP_ADDRESS=remote.invalid',
      'SMTP_PASSWORD=private-unit-only','SENDGRID_API_KEY=private-unit-only','RESEND_API_KEY=private-unit-only',
      'DATABASE_URL=postgresql://private@remote.invalid/live','PORTAL_PUBLIC_URL=https://production.invalid',
      'GOOGLE_APPLICATION_CREDENTIALS=/app/credentials.json','SOLIDES_RELEASE_STAGE=write','DOTENV_CONFIG_PATH=/app/private.env',
      'NODE_OPTIONS=--import=private','HTTPS_PROXY=https://private.invalid','SMTP_PASSWORD=','FIREBASE_PROJECT_ID=','UNKNOWN_CONFIGURATION=']) {
      const value={...observed,Env:[...observed.Env,entry]};
      assert.throws(()=>assertImageEnvironment(role,value),error=>{
        assert.equal(error.code,'functional_image_operational_environment_refused');
        assert.doesNotMatch(error.message,/private-unit|remote.invalid|production-project|SMTP|FIREBASE/);return true;
      });
    }
  }
});

test('safe image env remains separate from fixture overrides; actual merged Config.Env must match exactly',()=>{
  const config=imageConfig('api'),base=assertImageEnvironment('api',config),overlay={...disabledProviderEnvironment,
    NODE_ENV:'test',MIGRATION_TEST_DISPOSABLE:'true',FIREBASE_PROJECT_ID:identity.firebaseProject,FIREBASE_AUTH_EMULATOR_HOST:'emulator:9099'};
  const actual=Object.entries({...base,...overlay}).map(([key,value])=>`${key}=${value}`);
  assertResolvedContainerEnvironment({Env:actual},base,overlay);
  for(const mutate of [values=>values.push('INHERITED_OPERATIONAL_VALUE=private'),values=>values.push(actual[0]),
    values=>values.splice(values.findIndex(value=>value.startsWith('FIREBASE_PROJECT_ID=')),1,'FIREBASE_PROJECT_ID=production-project'),
    values=>values.splice(values.findIndex(value=>value.startsWith('SMTP_ADDRESS=')),1,'SMTP_ADDRESS=external.invalid')]) {
    const values=[...actual];mutate(values);assert.throws(()=>assertResolvedContainerEnvironment({Env:values},base,overlay));
  }
  assert.throws(()=>assertImageEnvironment('api',{...config,WorkingDir:'/app/unknown'}),{code:'functional_image_runtime_paths_invalid'});
  assert.throws(()=>assertImageEnvironment('cms',{...imageConfig('cms'),Volumes:{'/app/cms':{}}}),{code:'functional_image_runtime_paths_invalid'});
});

test('internal bridge plus exact singleton membership is mandatory; adding an egress network is rejected',()=>{
  const name=`${identity.project}-network`,networkId='b'.repeat(64);
  const network={Name:name,Id:networkId,Driver:'bridge',Scope:'local',Internal:true,Options:{},
    Labels:{'com.docker.compose.project':identity.project,'ownerinc.functional.run':identity.runId,'ownerinc.functional.role':'network'}};
  assertFixtureNetwork(identity,network);
  for(const change of [{Internal:false},{Driver:'host'},{Scope:'swarm'},{Options:{'com.docker.network.bridge.enable_ip_masquerade':'true'}}])
    assert.throws(()=>assertFixtureNetwork(identity,{...network,...change}),{code:'functional_internal_network_required'});
  const container={HostConfig:{NetworkMode:name},NetworkSettings:{Networks:{[name]:{NetworkID:networkId}}}};
  assertContainerNetwork(identity,container,networkId);
  assert.throws(()=>assertContainerNetwork(identity,{...container,NetworkSettings:{Networks:{...container.NetworkSettings.Networks,external:{NetworkID:'c'.repeat(64)}}}},networkId),{code:'functional_attached_network_mismatch'});
  assert.throws(()=>assertContainerNetwork(identity,container,'d'.repeat(64)),{code:'functional_attached_network_mismatch'});
});

function mockedFiles(files={}) {
  return {lstat:async filename=>{
    if(Object.hasOwn(files,filename)) return {isDirectory:()=>true,isSymbolicLink:()=>false};
    throw Object.assign(new Error('private path diagnostics'),{code:'ENOENT'});
  },readdir:async filename=>files[filename]};
}

test('the runtime image probe refuses embedded dotenv/credential files by existence, never reading body (FS double)',async()=>{
  const fs=mockedFiles({'/':[],'/app':['index.js','.env.example'],'/app/api':[],'/app/cms':[]});
  await assertNoOperationalImageFiles(fs,'api','/app');
  for(const filename of ['.env','.env.production','.env.production.local','.env.local','.env.test','.env.development',
    'service-account.json','service_account_prod.json','application_default_credentials.json','credentials.json']) {
    for(const root of ['/','/app','/app/api','/app/cms','/workspace','/root/.config/gcloud']) {
      await assert.rejects(assertNoOperationalImageFiles(mockedFiles({[root]:[filename]}),'api','/app'),/functional_image_files_refused/);
    }
  }
  await assert.rejects(assertNoOperationalImageFiles({...fs,lstat:async()=>({isDirectory:()=>true,isSymbolicLink:()=>true})},'api','/app'),/functional_image_files_refused/);
  await assert.rejects(assertNoOperationalImageFiles(fs,'cms','/app'),/functional_image_files_refused/);
});

test('exact Node script sent to future Docker runs the same guarded probe; app entrypoint, healthchecks, writes and networking never run (Docker/FS doubles)',async()=>{
  const args=imageFileProbeArguments(imageId,'cms');
  assert.deepEqual(args.slice(0,-2),['run','--rm','--network','none','--read-only','--no-healthcheck','--user','0:0','--cap-drop','ALL',
    '--security-opt','no-new-privileges','--entrypoint','/usr/local/bin/node',imageId]);
  assert.equal(args.at(-2),'-e');
  assert.doesNotMatch(args.at(-1),/readFile|dotenv|SMTP_PASSWORD|index\.js|listen\(/);
  let output='',exitCode;
  const process={cwd:()=>'/app/cms',stdout:{write:value=>{output+=value;}},set exitCode(value){exitCode=value;}};
  await vm.runInNewContext(args.at(-1),{require:specifier=>{assert.equal(specifier,'node:fs/promises');return mockedFiles({'/app/cms':[]});},process});
  assert.equal(output,'functional_image_files_clean');assert.equal(exitCode,undefined);
  output='';
  await vm.runInNewContext(args.at(-1),{require:()=>mockedFiles({'/app/cms':['.env.local']}),process});
  assert.equal(output,'');assert.equal(exitCode,1);
  await probeImageFiles(async passed=>{assert.deepEqual(passed,args);return 'functional_image_files_clean';},imageId,'cms');
  for(const docker of [async()=> 'unexpected-private-output',async()=>{throw new Error('raw-secret diagnostics');}]) {
    await assert.rejects(probeImageFiles(docker,imageId,'cms'),{code:'functional_image_files_refused'});
  }
});

test('resolved Compose contract retains internal networking, zero Docker publication and provider blanks (resolver-shaped double)',()=>{
  const config={apiImage:imageId,cmsImage:'sha256:'+'b'.repeat(64),emulatorImage:'sha256:'+'c'.repeat(64),httpsPort:19443};
  const secrets=Object.fromEntries(['portalAdmin','portalRuntime','portalCron','cmsAdmin','cmsMigrator','cmsRuntime','payload','toPortal','toPayload','bulk']
    .map((key,index)=>[key,index.toString(16).repeat(64)]));
  const manifest=buildCompose(identity,config,'/private-unit-only',secrets);
  const resolved=JSON.parse(JSON.stringify(manifest));
  for(const [role,service] of Object.entries(resolved.services)) {
    service.networks={fixture:null};
    if(!Object.hasOwn(service,'command')) service.command=null;
  }
  assertResolvedFixtureConfig(resolved,manifest);
  for(const role of ['api','cms','emulator','portal-migrate','cms-provision','cms-migrate'])
    for(const key of Object.keys(disabledProviderEnvironment)) assert.equal(resolved.services[role].environment[key],'');
  for(const mutate of [value=>{value.networks.fixture.internal=false;},value=>{value.networks.egress={};},
    value=>{value.services.api.networks.external={};},value=>{value.services.api.environment.SMTP_ADDRESS='external.invalid';},
    value=>{value.services.api.env_file=['/private.env'];},value=>{value.services.api.command=[];},
    value=>{value.services.nginx.ports=[{host_ip:'127.0.0.1',target:443,published:'19443'}];}]) {
    const value=JSON.parse(JSON.stringify(resolved));mutate(value);
    assert.throws(()=>assertResolvedFixtureConfig(value,manifest),{code:'functional_resolved_compose_mismatch'});
  }
});
