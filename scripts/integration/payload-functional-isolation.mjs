import { IntegrationGuardError } from '../../cms/tests/support/integration-config.mjs';
import { functionalBaseImages } from './payload-functional-base-images.mjs';

const reject=code=>{throw new IntegrationGuardError(code);};
const nodeRoles=new Set(['api','cms','emulator']);
const safePath='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const workdirs={api:'/app',cms:'/app/cms',emulator:'/workspace'};
export const disabledProviderEnvironment=Object.freeze(Object.fromEntries([
  'FIREBASE_CLIENT_EMAIL','FIREBASE_PRIVATE_KEY','GOOGLE_APPLICATION_CREDENTIALS',
  'SMTP_ADDRESS','SMTP_PORT','SMTP_USERNAME','SMTP_PASSWORD','SMTP_DOMAIN','SMTP_SENDER_EMAIL',
  'SMTP_ENABLE_STARTTLS_AUTO','SMTP_OPENSSL_VERIFY_MODE','SENDGRID_API_KEY','RESEND_API_KEY',
].map(key=>[key,''])));

export function parseContainerEnvironment(values) {
  if(!Array.isArray(values)) reject('functional_image_environment_invalid');
  const result={};
  for(const entry of values) {
    if(typeof entry!=='string' || entry.includes('\0')) reject('functional_image_environment_invalid');
    const index=entry.indexOf('='),key=entry.slice(0,index);
    if(index<1 || !/^[A-Z][A-Z0-9_]*$/.test(key) || Object.hasOwn(result,key)) reject('functional_image_environment_invalid');
    result[key]=entry.slice(index+1);
  }
  return result;
}

export function assertImageEnvironment(role,config,image) {
  const env=parseContainerEnvironment(config?.Env);
  if(Object.hasOwn(functionalBaseImages,role)) {
    const base=functionalBaseImages[role],platform=Object.hasOwn(base.platforms,image?.architecture) ? base.platforms[image.architecture] : null;
    if(image?.reference!==base.reference || image?.os!=='linux' || !platform || image.id!==platform.configDigest || config.WorkingDir!=='/') {
      reject('functional_base_image_binding_mismatch');
    }
    const expected=parseContainerEnvironment(base.env);
    if(JSON.stringify(Object.keys(env).sort())!==JSON.stringify(Object.keys(expected).sort()) ||
      Object.keys(expected).some(key=>env[key]!==expected[key])) reject('functional_image_operational_environment_refused');
    return env;
  }
  const rules={PATH:value=>value===safePath,HOME:value=>['/root','/home/node'].includes(value),
    LANG:value=>['C','C.UTF-8','en_US.utf8','en_US.UTF-8'].includes(value)};
  if(nodeRoles.has(role)) {
    Object.assign(rules,{NODE_VERSION:value=>/^24\.\d+\.\d+$/.test(value),YARN_VERSION:value=>/^1\.22\.\d+$/.test(value)});
    if(config.WorkingDir!==workdirs[role] || Object.keys(config.Volumes || {}).length) reject('functional_image_runtime_paths_invalid');
    if(role==='cms') Object.assign(rules,{NODE_ENV:value=>value==='production',NEXT_TELEMETRY_DISABLED:value=>value==='1'});
  } else reject('functional_image_role_invalid');
  // Operational values are refused even if Compose would override them or they
  // are empty. Never reflect the key/value (or Config.Env) in diagnostics.
  if(Object.entries(env).some(([key,value])=>!Object.hasOwn(rules,key) || !rules[key](value))) reject('functional_image_operational_environment_refused');
  if(env.PATH!==safePath) reject('functional_image_environment_invalid');
  return env;
}

export function assertResolvedContainerEnvironment(config,imageEnvironment,overlay={}) {
  const actual=parseContainerEnvironment(config?.Env),expected={...imageEnvironment,...overlay};
  const keys=Object.keys(expected).sort();
  if(JSON.stringify(Object.keys(actual).sort())!==JSON.stringify(keys) || keys.some(key=>actual[key]!==expected[key])) {
    reject('functional_resolved_environment_mismatch');
  }
}

export function assertResolvedFixtureConfig(observed,manifest) {
  const rejectConfig=()=>reject('functional_resolved_compose_mismatch');
  const services=observed?.services,networks=observed?.networks,network=networks?.fixture;
  if(!services || JSON.stringify(Object.keys(services).sort())!==JSON.stringify(Object.keys(manifest.services).sort()) ||
    !networks || JSON.stringify(Object.keys(networks))!==JSON.stringify(['fixture']) ||
    network.internal!==true || network.driver!=='bridge' || network.external || network.name!==manifest.networks.fixture.name) rejectConfig();
  for(const [role,expected] of Object.entries(manifest.services)) {
    const service=services[role],actualEnv=service.environment || {},expectedEnv=expected.environment || {};
    if(service.image!==expected.image || service.container_name!==expected.container_name || service.network_mode || service.build ||
      service.env_file || JSON.stringify(Object.keys(service.networks || {}))!==JSON.stringify(['fixture']) ||
      JSON.stringify(Object.keys(actualEnv).sort())!==JSON.stringify(Object.keys(expectedEnv).sort()) ||
      Object.keys(expectedEnv).some(key=>actualEnv[key]!==expectedEnv[key]) ||
      // Compose 5.1.4 emits command:null for an inherited image CMD. Only that
      // exact normalization is equivalent to absence; [] is not inherited CMD.
      JSON.stringify(service.command ?? undefined)!==JSON.stringify(expected.command)) rejectConfig();
    if((service.ports || []).length) rejectConfig();
  }
}

export function assertNoPublishedPorts(container) {
  if(Object.keys(container?.HostConfig?.PortBindings || {}).length || container?.HostConfig?.PublishAllPorts ||
    !container?.NetworkSettings || Object.values(container.NetworkSettings.Ports || {}).some(value=>value!==null)) {
    reject('functional_unexpected_published_port');
  }
}

export function assertFixtureNetwork(identity,observed) {
  if(observed?.Name!==`${identity.project}-network` || !/^[0-9a-f]{64}$/.test(observed.Id || '') ||
    observed.Driver!=='bridge' || observed.Scope!=='local' || observed.Internal!==true || observed.Ingress===true ||
    Object.keys(observed.Options || {}).length ||
    observed.Labels?.['com.docker.compose.project']!==identity.project ||
    observed.Labels?.['ownerinc.functional.run']!==identity.runId || observed.Labels?.['ownerinc.functional.role']!=='network') {
    reject('functional_internal_network_required');
  }
}

export function assertContainerNetwork(identity,container,networkId) {
  const name=`${identity.project}-network`,networks=container?.NetworkSettings?.Networks;
  if(!networks || JSON.stringify(Object.keys(networks))!==JSON.stringify([name]) ||
    !/^[0-9a-f]{64}$/.test(networks[name]?.NetworkID || '') ||
    networkId!==undefined && networks[name].NetworkID!==networkId ||
    ![name,networks[name]?.NetworkID].includes(container?.HostConfig?.NetworkMode)) {
    reject('functional_attached_network_mismatch');
  }
}

// Shared by the actual image probe and its offline FS mock tests. It checks
// existence/names only: no dotenv, credentials or file contents are read.
export async function assertNoOperationalImageFiles(fs,role,cwd) {
  const expected={api:'/app',cms:'/app/cms',emulator:'/workspace'};
  if(!Object.hasOwn(expected,role) || cwd!==expected[role]) throw new Error('functional_image_files_refused');
  const roots=['/','/app','/app/api','/app/cms','/workspace','/root','/home/node',
    '/root/.config/gcloud','/home/node/.config/gcloud'];
  for(const directory of roots) {
    let info;
    try {info=await fs.lstat(directory);} catch(error) {if(error.code==='ENOENT') continue;throw new Error('functional_image_files_refused');}
    if(!info.isDirectory() || info.isSymbolicLink()) throw new Error('functional_image_files_refused');
    const names=await fs.readdir(directory);
    if(names.some(name=>/^\.env(?:$|\.(?!(?:example|sample)$))/i.test(name) ||
      /^(?:service[-_]?account(?:[-_.].*)?|application_default_credentials|credentials)\.json$/i.test(name))) {
      throw new Error('functional_image_files_refused');
    }
  }
}

export function imageFileProbeArguments(imageId,role) {
  if(!/^sha256:[0-9a-f]{64}$/.test(imageId) || !nodeRoles.has(role)) reject('functional_image_probe_invalid');
  const script=`(${assertNoOperationalImageFiles.toString()})(require('node:fs/promises'),${JSON.stringify(role)},process.cwd())`+
    `.then(()=>process.stdout.write('functional_image_files_clean')).catch(()=>{process.exitCode=1;});`;
  return ['run','--rm','--network','none','--read-only','--no-healthcheck','--user','0:0','--cap-drop','ALL','--security-opt','no-new-privileges',
    '--entrypoint','/usr/local/bin/node',imageId,'-e',script];
}

export async function probeImageFiles(docker,imageId,role) {
  try {
    if(await docker(imageFileProbeArguments(imageId,role))!=='functional_image_files_clean') reject('functional_image_files_refused');
  } catch {reject('functional_image_files_refused');}
}
