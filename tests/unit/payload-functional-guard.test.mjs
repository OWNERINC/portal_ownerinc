import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp,mkdir,rm,symlink,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { assertFunctionalEnvironment,checkFunctionalParent,functionalFallbacks,readFunctionalConfig } from '../../cms/tests/support/integration-config.mjs';
import { assertPlaywrightManifest,buildCompose,cleanChildEnvironment,firebaseConfigSource,fixtureIdentity,nginxConfigSource,validateTLS,validateComposeContract } from '../../scripts/integration/payload-functional-fixture.mjs';
import { assertContainerBinding,assertFreshResources,assertPhysicalTargets,assertVolumeBinding } from '../../scripts/integration/payload-functional-targets.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(new URL('../../api/package.json',import.meta.url));
const runId='134cfd81-7f0d-47ca-a4fb-c9cabd069c0f';
const commit='a'.repeat(40);
const image=n=>'sha256:'+String(n).repeat(64);
function environment(directory=path.resolve(tmpdir(),'functional-private-parent')) {
  return {NODE_ENV:'test',MIGRATION_TEST_DISPOSABLE:'true',GITHUB_SHA:commit,
    PAYLOAD_FUNCTIONAL_PRIVATE_PARENT:directory,PAYLOAD_FUNCTIONAL_API_IMAGE:image(1),PAYLOAD_FUNCTIONAL_CMS_IMAGE:image(2),
    PAYLOAD_FUNCTIONAL_EMULATOR_IMAGE:image(3),PAYLOAD_FUNCTIONAL_HTTPS_PORT:'0',
    PAYLOAD_FUNCTIONAL_CERTIFICATE:path.join(directory,'cert.pem'),PAYLOAD_FUNCTIONAL_PRIVATE_KEY:path.join(directory,'key.pem'),
    PAYLOAD_FUNCTIONAL_PLAYWRIGHT_MODULE:path.join(directory,'isolated-playwright','index.mjs')};
}

for(const key of functionalFallbacks) test(`functional guard refuses ambient ${key} even when empty`,()=>{
  assert.throws(()=>readFunctionalConfig({...environment(),[key]:''}),{code:'functional_external_override_refused'});
});

test('functional target configuration has no DB/authority/path fallback and rejects mutable images',()=>{
  for(const [changes,code] of [
    [{NODE_ENV:'production'},'test_environment_required'],[{NODE_ENV:'development'},'test_environment_required'],
    [{MIGRATION_TEST_DISPOSABLE:'TRUE'},'disposable_required'],[{GITHUB_SHA:'main'},'functional_source_revision_required'],
    [{PAYLOAD_FUNCTIONAL_API_IMAGE:'ownerinc-portal-api:latest'},'functional_immutable_image_required'],
    [{PAYLOAD_FUNCTIONAL_CMS_IMAGE:image(1)},'functional_distinct_images_required'],
    [{PAYLOAD_FUNCTIONAL_HTTPS_PORT:'80'},'functional_https_port_invalid'],
    [{PAYLOAD_FUNCTIONAL_HTTPS_PORT:'65536'},'functional_https_port_invalid'],
    [{PAYLOAD_FUNCTIONAL_HTTPS_PORT:'019443'},'functional_https_port_invalid'],
    [{PAYLOAD_FUNCTIONAL_HTTPS_PORT:'19443'},'functional_https_port_invalid'],
    [{PAYLOAD_FUNCTIONAL_PRIVATE_PARENT:root},'functional_directory_not_private'],
    [{PAYLOAD_FUNCTIONAL_PRIVATE_KEY:'relative.pem'},'functional_absolute_file_required'],
    [{PAYLOAD_FUNCTIONAL_AUTHORITY:'payload'},'functional_unknown_setting'],
    [{PAYLOAD_TEST_PORTAL_DATABASE_URL:'postgresql://production.invalid/ownerinc_cms'},'functional_external_override_refused'],
  ]) assert.throws(()=>readFunctionalConfig({...environment(),...changes}),{code});
  const config=readFunctionalConfig(environment());
   assert.equal(config.httpsPort,0);assert.equal(config.browserExecutable,null);
  assert.equal(Object.hasOwn(config,'databaseURL'),false);
});

test('no secrets, inherited Node options or Docker overrides reach a child',()=>{
  const env=cleanChildEnvironment({PATH:'tool-path',HOME:'private-home',NODE_OPTIONS:'inject',DATABASE_URL:'secret',DOCKER_HOST:'remote',GITHUB_SHA:commit});
  assert.deepEqual(env,{PATH:'tool-path',HOME:'private-home'});
});

test('browser tool must match the actual existing isolated Playwright package/version contract',()=>{
  const modulePath=path.resolve(tmpdir(),'isolated-tool','node_modules','playwright','index.mjs');
  const manifest={name:'playwright',version:'1.62.1'};
  assertPlaywrightManifest(modulePath,manifest);
  for(const value of [{name:'synthetic-browser',version:'1.62.1'},{...manifest,version:'latest'},{...manifest,version:'1.61.0'}])
    assert.throws(()=>assertPlaywrightManifest(modulePath,value),{code:'functional_playwright_package_invalid'});
  assert.throws(()=>assertPlaywrightManifest(path.join(path.dirname(modulePath),'fake-browser.mjs'),manifest),{code:'functional_playwright_package_invalid'});
});

test('fresh identity is UUID namespaced, two physical clusters are required despite CMS canonical name',()=>{
  const identity=fixtureIdentity(runId);
  assert.equal(identity.cmsDatabase,'ownerinc_cms');
  assert.match(identity.portalDatabase,/^portal_functional_test_/);
  assert.match(identity.firebaseProject,/^demo-oc-cms-/);assert.ok(identity.firebaseProject.length<=30);
  assert.equal(new Set(Object.values(identity.volumes)).size,4);
  assert.throws(()=>fixtureIdentity('production'),{code:'functional_run_id_invalid'});
  const portal={database:identity.portalDatabase,role:'portal_admin',systemIdentifier:'1234567890123456789',serverAddress:'172.28.0.2',serverPort:5432,empty:true};
  const cms={...portal,database:'ownerinc_cms',role:'cms_admin',systemIdentifier:'1234567890123456790',serverAddress:'172.28.0.3'};
  assertPhysicalTargets(identity,portal,cms);
  for(const changed of [{systemIdentifier:portal.systemIdentifier},{serverAddress:portal.serverAddress},{empty:false},{role:'cms_runtime'},
    {database:identity.portalDatabase},{serverPort:5433},{systemIdentifier:'unknown'}]) {
    assert.throws(()=>assertPhysicalTargets(identity,portal,{...cms,...changed}),{code:'functional_physical_targets_not_independent'});
  }
});

test('labels cannot authorize external/bind/reused volumes or a database port',()=>{
  const identity=fixtureIdentity(runId);
  const labels={'com.docker.compose.project':identity.project,'ownerinc.functional.run':runId,'ownerinc.functional.role':'cms-db'};
  const volume={Name:identity.volumes['cms-db'],Driver:'local',Options:null,Labels:labels};
  assertVolumeBinding(identity,'cms-db',volume);
  for(const change of [{Name:'production_cms_data'},{Driver:'nfs'},{Options:{device:'/existing-data'}},{Labels:{...labels,'ownerinc.functional.run':'other'}}])
    assert.throws(()=>assertVolumeBinding(identity,'cms-db',{...volume,...change}),{code:'functional_volume_binding_mismatch'});
  const container={Name:'/'+identity.containers['cms-db'],Image:image(9),Config:{Labels:labels},
    HostConfig:{Privileged:false,NetworkMode:`${identity.project}-network`,PortBindings:{}},
    NetworkSettings:{Networks:{[`${identity.project}-network`]:{NetworkID:'a'.repeat(64)}}},
    Mounts:[{Type:'volume',Name:identity.volumes['cms-db'],Destination:'/var/lib/postgresql/data',RW:true}]};
  assertContainerBinding(identity,'cms-db',container,image(9));
  assert.throws(()=>assertContainerBinding(identity,'cms-db',{...container,Mounts:[{...container.Mounts[0],Type:'bind'}]},image(9)),{code:'functional_container_mount_mismatch'});
  assert.throws(()=>assertContainerBinding(identity,'cms-db',{...container,HostConfig:{...container.HostConfig,PortBindings:{'5432/tcp':[{HostIp:'127.0.0.1'}]}}},image(9)),{code:'functional_unexpected_published_port'});
  for(const key of ['containers','volumes','networks']) assert.throws(()=>assertFreshResources(identity,{containers:'',volumes:'',networks:'',[key]:'existing'}),{code:'functional_existing_resources_refused'});
});

test('Compose uses only own volume names, immutable images, no worker, no schema/protocol automatic init',()=>{
  const identity=fixtureIdentity(runId),config=readFunctionalConfig(environment());
  const secret=Object.fromEntries(['portalAdmin','portalRuntime','portalCron','cmsAdmin','cmsMigrator','cmsRuntime','payload','toPortal','toPayload','bulk'].map(key=>[key,key+'-synthetic-unit-only']));
  const compose=buildCompose(identity,config,config.privateParent,secret);
  assert.equal(compose.name,identity.project);
  assert.equal(compose.networks.fixture.internal,true);assert.equal(compose.networks.fixture.driver,'bridge');
  assert.equal(Object.keys(compose.services).length,9);
  for(const role of ['worker','cron','cms-worker','cms-control-roles','finalizer']) assert.equal(Object.hasOwn(compose.services,role),false);
  for(const [name,service] of Object.entries(compose.services)) {
    assert.equal(Object.hasOwn(service,'build'),false);
    assert.equal(service.restart,'no');
    assert.equal(service.container_name,identity.containers[name]);
    assert.equal(Object.hasOwn(service,'ports'),false);
  }
  assert.equal(Object.hasOwn(compose.services.nginx,'ports'),false);
  assert.equal(compose.services.nginx.volumes.length,4);
  assert.equal(compose.services.nginx.volumes.some(value=>value.endsWith(':/fixture:ro')),false,'lease/secrets never bind mounted wholesale');
  assert.equal(compose.services.api.environment.RUN_MIGRATIONS,'false');
  assert.equal(compose.services.api.environment.NODE_ENV,'test');
  assert.equal(compose.services.api.environment.MIGRATION_TEST_DISPOSABLE,'true');
  assert.equal(compose.services.cms.environment.NODE_ENV,'production');
  assert.equal(compose.services.api.environment.FIREBASE_PROJECT_ID,identity.firebaseProject);
  assert.equal(compose.services.cms.environment.CMS_DATABASE_URL.includes('@cms-db:5432/ownerinc_cms'),true);
  for(const [role,volume] of Object.entries(compose.volumes)) {
    assert.equal(volume.name,identity.volumes[role]);assert.equal(Object.hasOwn(volume,'external'),false);
  }
  assert.doesNotMatch(JSON.stringify(compose),/freeze|activate-payload|owner_news_bootstrap|finalize-news/);
});

test('materialized port matches actual API emulator gate and still emits the actual secure host cookie',()=>{
  const identity=fixtureIdentity(runId),config={...readFunctionalConfig(environment()),httpsPort:19443};
  const secret=Object.fromEntries(['portalAdmin','portalRuntime','portalCron','cmsAdmin','cmsMigrator','cmsRuntime','payload','toPortal','toPayload','bulk']
    .map((key,index)=>[key,index.toString(16).repeat(64)]));
  const compose=buildCompose(identity,config,config.privateParent,secret),env=compose.services.api.environment;
  const {validateEnvironment,authEmulatorEnabled}=require('./middleware/security.js');
  const {editorialCookieConfig}=require('./editorial-session/origin.js');
  assert.equal(authEmulatorEnabled(env),true);validateEnvironment(env);
  assert.equal(authEmulatorEnabled({...env,NODE_ENV:'production'}),false);
  assert.throws(()=>validateEnvironment({...env,NODE_ENV:'production'}),/only allowed/);
  assert.deepEqual(editorialCookieConfig(env),{origin:'https://127.0.0.1:19443',name:'__Host-ownerinc-editorial',
    options:{httpOnly:true,secure:true,sameSite:'lax',path:'/'}});
});

test('self-reported hashes never authorize an altered template, writer command or external target',()=>{
  const identity=fixtureIdentity(runId),config=readFunctionalConfig(environment());
  const keys=['portalAdmin','portalRuntime','portalCron','cmsAdmin','cmsMigrator','cmsRuntime','payload','toPortal','toPayload','bulk'];
  const secret=Object.fromEntries(keys.map((key,index)=>[key,index.toString(16).repeat(64)]));
  const build=()=>buildCompose(identity,config,config.privateParent,secret);
  validateComposeContract(build(),identity,config,config.privateParent);
  for(const mutate of [value=>{value.volumes['cms-db'].external=true;},value=>{value.services.cms.command=['native-writer'];},
    value=>{value.services.cms.environment.CMS_DATABASE_URL='postgresql://remote.invalid/ownerinc_cms';},
    value=>{value.services['cms-worker']=value.services.cms;},value=>{value.services.nginx.ports=['0.0.0.0:443:443'];},
    value=>{value.services.api.environment.NODE_OPTIONS='--import=untrusted';}]) {
    const observed=build();mutate(observed);
    assert.throws(()=>validateComposeContract(observed,identity,config,config.privateParent),{code:'functional_compose_contract_invalid'});
  }
});

test('fixture TLS/emulator configuration retains actual route guards and uses unmodified SDK',async()=>{
  const source=await readFile(path.join(root,'nginx/nginx.conf'),'utf8');
  const firebase=firebaseConfigSource(fixtureIdentity(runId),'https://127.0.0.1:19443');
  assert.match(firebase,/initializeAuth\(app/);assert.match(firebase,/connectAuthEmulator\(auth, "https:\/\/127\.0\.0\.1:19443"/);
  assert.doesNotMatch(firebase,/prod|task9-uid|synthetic-browser-cookie|signOut\s*=/);
  const nginx=nginxConfigSource(source,firebase);
  assert.match(nginx,/listen 443 ssl/);assert.match(nginx,/connect-src 'self';/);
  for(const boundary of ['location ^~ /api/internal/ { return 404; }','location = /_next/image { return 404; }',
    'location ^~ /editorial/api/portal-news/ { return 404; }','if ($cross_site_request) { return 403; }']) assert.ok(nginx.includes(boundary));
  assert.match(nginx,/proxy_pass http:\/\/emulator:9099/);
  assert.throws(()=>firebaseConfigSource({firebaseProject:'production-project'},'https://127.0.0.1:19443'),{code:'functional_firebase_config_invalid'});
  assert.throws(()=>firebaseConfigSource(fixtureIdentity(runId),'https://remote.example.test'),{code:'functional_firebase_config_invalid'});
  assert.throws(()=>validateTLS(Buffer.from('not a certificate'),Buffer.from('not a private key')),{code:'functional_tls_identity_invalid'});
});

test('parent guard rejects symlinks, missing roots and another checkout without contacting services',async t=>{
  const parent=process.platform==='win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA,'Temp','opencode') : tmpdir();
  const directory=await mkdtemp(path.join(parent,'payload-functional-unit-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const privateParent=path.join(directory,'private');await mkdir(privateParent,{mode:0o700});
  assert.equal(await checkFunctionalParent(readFunctionalConfig(environment(privateParent))),privateParent);
  await assert.rejects(checkFunctionalParent(readFunctionalConfig(environment(path.join(directory,'missing')))),{code:'functional_private_parent_unavailable'});
  const alias=path.join(directory,'alias');await symlink(privateParent,alias,process.platform==='win32' ? 'junction' : 'dir');
  await assert.rejects(checkFunctionalParent(readFunctionalConfig(environment(alias))),{code:'private_directory_invalid'});
  await mkdir(path.join(privateParent,'.git'));
  await assert.rejects(checkFunctionalParent(readFunctionalConfig(environment(privateParent))),{code:'private_directory_in_checkout'});
});

test('production is refused before Docker, browser module, certificate or lease access',()=>{
  const result=spawnSync(process.execPath,['scripts/test-payload-integration.mjs','--execute','--lease',path.join(tmpdir(),'missing','lease.json')],{
    cwd:root,encoding:'utf8',timeout:10000,env:{...cleanChildEnvironment(),NODE_ENV:'production',MIGRATION_TEST_DISPOSABLE:'true'}});
  assert.equal(result.status,1);assert.match(result.stderr,/test_environment_required/);
  assert.doesNotMatch(result.stderr,/missing|postgres|docker|certificate|password/i);
  assert.throws(()=>assertFunctionalEnvironment({NODE_ENV:'test',MIGRATION_TEST_DISPOSABLE:'true',DOCKER_HOST:'ssh://production.invalid'}),{code:'functional_external_override_refused'});
});
