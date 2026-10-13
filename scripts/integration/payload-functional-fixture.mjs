// Dedicated fresh fixture only. No base Compose, recovery adapter or authority writer.
import { createHash, randomBytes, randomUUID, X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { lstat, readFile, realpath, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertFunctionalEnvironment, checkFunctionalParent, IntegrationGuardError, readFunctionalConfig } from '../../cms/tests/support/integration-config.mjs';
import { createSecurityContext, createSecureDirectory, writeSecureFile } from '../payload-preview/security.mjs';
import { disabledProviderEnvironment } from './payload-functional-isolation.mjs';
import { postgresImage,nginxImage } from './payload-functional-base-images.mjs';
export { postgresImage,nginxImage } from './payload-functional-base-images.mjs';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const fail = code => { throw new IntegrationGuardError(code); };
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const playwrightVersion = '1.62.1'; // Existing isolated CI tool version; no install/auto-resolution.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const roles = ['portal-db', 'cms-db', 'emulator', 'portal-migrate', 'cms-provision', 'cms-migrate', 'api', 'cms', 'nginx'];
const volumeRoles = ['portal-db', 'cms-db', 'portal-uploads', 'cms-uploads'];
export function fixtureIdentity(runId) {
  if (!uuid.test(runId)) fail('functional_run_id_invalid');
  const suffix = runId.replaceAll('-', '');
  const project = `ownerinc-payload-functional-${suffix}`;
  return Object.freeze({ runId, project, firebaseProject: `demo-oc-cms-${suffix.slice(0,16)}`,
    portalDatabase: `portal_functional_test_${suffix}`, cmsDatabase: 'ownerinc_cms',
    containers: Object.fromEntries(roles.map(role => [role, `${project}-${role}`])),
    volumes: Object.fromEntries(volumeRoles.map(role => [role, `${project}-${role}`])) });
}

export function cleanChildEnvironment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    ['path','systemroot','windir','temp','tmp','userprofile','appdata','localappdata','comspec','pathext','home','programfiles']
      .includes(key.toLowerCase())));
}

export async function runProcess(command, args, { input, timeout = 30000, env = cleanChildEnvironment(), cwd = root } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe','pipe','pipe'], windowsHide: true });
    let output = Buffer.alloc(0), overflow = false, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => {
      if (output.length + chunk.length > 4 * 1024 * 1024) { overflow = true; child.kill('SIGKILL'); }
      else output = Buffer.concat([output, chunk]);
    });
    // Never echo raw diagnostics, args, stderr, SQL or secrets.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {}); child.stdin.end(input || '');
    child.once('error', () => { clearTimeout(timer); reject(new IntegrationGuardError('functional_process_unavailable')); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut || overflow || signal || code !== 0) reject(new IntegrationGuardError(timedOut ? 'functional_process_timeout' : overflow ? 'functional_process_output_limit' : 'functional_process_failed'));
      else resolve(output.toString('utf8').trim());
    });
  });
}

async function regularFile(filename, { privateFile = false } = {}) {
  let current = filename;
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail('functional_reparse_path_refused');
    if (current === filename && (!info.isFile() || info.nlink !== 1)) fail('functional_regular_file_required');
    if (current === filename && privateFile && process.platform !== 'win32' &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid())) fail('functional_private_file_unsafe');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  // Reuse the importer's read-only descriptor/path binding. This neither claims
  // an import capability nor reads authority, content bundles or run state.
  const {readPrivateBytes}=await import('../owner-news-payload/files.mjs');
  return readPrivateBytes(filename,512*1024*1024).catch(()=>fail('functional_private_file_changed'));
}

export function assertPlaywrightManifest(modulePath,manifest) {
  if(!['index.mjs','index.js'].includes(path.basename(modulePath)) ||
    manifest?.name!=='playwright' || manifest.version!==playwrightVersion) fail('functional_playwright_package_invalid');
}

async function browserToolBinding(config) {
  const packageBytes=await regularFile(path.join(path.dirname(config.playwrightModule),'package.json'));
  let manifest;try {manifest=JSON.parse(packageBytes.toString('utf8'));} catch {fail('functional_playwright_package_invalid');}
  assertPlaywrightManifest(config.playwrightModule,manifest);
  return {playwright:hash(await regularFile(config.playwrightModule)),playwrightPackage:hash(packageBytes),
    browser:config.browserExecutable ? hash(await regularFile(config.browserExecutable)) : null};
}

export function validateTLS(certBytes, keyBytes, now = Date.now()) {
  try {
    const cert = new X509Certificate(certBytes), key = createPrivateKey(keyBytes);
    const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
    if (!cert.checkIP('127.0.0.1') || Date.parse(cert.validFrom) > now || Date.parse(cert.validTo) <= now ||
      !publicKey.equals(cert.publicKey.export({ type: 'spki', format: 'der' })) ||
      !cert.verify(cert.publicKey)) fail('functional_tls_identity_invalid');
    return { certificateHash: hash(certBytes), keyHash: hash(keyBytes),
      spki: createHash('sha256').update(publicKey).digest('base64') };
  } catch { fail('functional_tls_identity_invalid'); }
}

export function firebaseConfigSource(identity, origin) {
  // Real, unmodified Firebase SDK. Only environment configuration differs from production.
  if (!/^demo-oc-cms-[0-9a-f]{16}$/.test(identity.firebaseProject) || !/^https:\/\/127\.0\.0\.1:[0-9]+$/.test(origin)) fail('functional_firebase_config_invalid');
  return `import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';\n` +
    `import { browserLocalPersistence, connectAuthEmulator, initializeAuth } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';\n` +
    `const app = initializeApp(${JSON.stringify({ apiKey: 'functional-emulator-only', authDomain: 'localhost', projectId: identity.firebaseProject })});\n` +
    `export const auth = initializeAuth(app, { persistence: browserLocalPersistence });\n` +
    `connectAuthEmulator(auth, ${JSON.stringify(origin)}, { disableWarnings: true });\n`;
}

export function nginxConfigSource(source, firebaseSource) {
  if (typeof firebaseSource !== 'string' || !source.includes('listen 80;') || !source.includes('http://api:3000') || !source.includes('http://cms:3001')) fail('functional_nginx_contract_changed');
  // Reuse all production route/CSP/Origin boundaries. TLS and emulator transport are fixture-only.
  return source.replace('listen 80;', 'listen 443 ssl;\n    ssl_certificate /fixture/cert.pem;\n    ssl_certificate_key /fixture/key.pem;')
    .replace("connect-src 'self' http://127.0.0.1:9099 http://localhost:9099 https://*.googleapis.com https://*.firebaseio.com;", "connect-src 'self';")
    .replace('index index.html;', `index index.html;
    location = /js/firebase-config.js { default_type application/javascript; return 200 ${JSON.stringify(firebaseSource).replaceAll('$','\\$')}; }
    location ^~ /identitytoolkit.googleapis.com/ { proxy_pass http://emulator:9099; proxy_set_header Host $http_host; }
    location ^~ /securetoken.googleapis.com/ { proxy_pass http://emulator:9099; proxy_set_header Host $http_host; }
    location ^~ /emulator/ { return 404; }`);
}

export function buildCompose(identity, config, directory, secrets) {
  const origin = `https://127.0.0.1:${config.httpsPort}`;
  const labels = role => ({ 'ownerinc.functional.run': identity.runId, 'ownerinc.functional.role': role });
  const databaseURL = (role, password, service, database) => `postgresql://${role}:${password}@${service}:5432/${database}`;
  const service = (role, image, extra) => ({ image, container_name: identity.containers[role], labels: labels(role), restart: 'no', networks: ['fixture'], ...extra,
    ...(!['portal-db','cms-db','nginx'].includes(role) ? {environment:{...disabledProviderEnvironment,...extra.environment}} : {}) });
  const healthcheck = db => ({ test: ['CMD-SHELL', `pg_isready -U ${db === 'portal-db' ? 'portal_admin' : 'cms_admin'} -d ${db === 'portal-db' ? identity.portalDatabase : identity.cmsDatabase}`], interval: '2s', timeout: '3s', retries: 45 });
  const cmsEnv = { NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    CMS_DATABASE_URL: databaseURL('cms_runtime', secrets.cmsRuntime, 'cms-db', identity.cmsDatabase),
    PAYLOAD_SECRET: secrets.payload, PORTAL_PUBLIC_URL: origin, PORTAL_INTERNAL_URL: 'http://api:3000',
    PAYLOAD_TO_PORTAL_SECRET: secrets.toPortal, PORTAL_TO_PAYLOAD_SECRET: secrets.toPayload, CMS_UPLOAD_DIR: '/var/lib/ownerinc-cms/media' };
  const portalSecrets = { PORTAL_API_DB_PASSWORD: secrets.portalRuntime, PORTAL_CRON_DB_PASSWORD: secrets.portalCron,
    MIGRATION_DATABASE_URL: databaseURL('portal_admin', secrets.portalAdmin, 'portal-db', identity.portalDatabase) };
  const services = {
    'portal-db': service('portal-db', postgresImage, { environment: { POSTGRES_USER: 'portal_admin', POSTGRES_DB: identity.portalDatabase, POSTGRES_PASSWORD: secrets.portalAdmin },
      volumes: ['portal-db:/var/lib/postgresql/data'], healthcheck: healthcheck('portal-db') }),
    'cms-db': service('cms-db', postgresImage, { environment: { POSTGRES_USER: 'cms_admin', POSTGRES_DB: identity.cmsDatabase, POSTGRES_PASSWORD: secrets.cmsAdmin },
      volumes: ['cms-db:/var/lib/postgresql/data'], healthcheck: healthcheck('cms-db') }),
    emulator: service('emulator', config.emulatorImage, { command: ['firebase','emulators:start','--only','auth','--project',identity.firebaseProject] }),
    'portal-migrate': service('portal-migrate', config.apiImage, { environment: { ...portalSecrets, NODE_ENV: 'test', RUN_MIGRATIONS: 'true', MIGRATION_ONLY: 'true' }, command: ['true'] }),
    'cms-provision': service('cms-provision', config.cmsImage, { environment: {
      CMS_DATABASE_URL: databaseURL('cms_admin', secrets.cmsAdmin, 'cms-db', identity.cmsDatabase), CMS_MIGRATOR_PASSWORD: secrets.cmsMigrator, CMS_RUNTIME_PASSWORD: secrets.cmsRuntime },
      command: ['node','--import','tsx','scripts/provision-db.ts','--provision'] }),
    'cms-migrate': service('cms-migrate', config.cmsImage, { environment: { ...cmsEnv, CMS_DATABASE_URL: databaseURL('cms_migrator', secrets.cmsMigrator, 'cms-db', identity.cmsDatabase) },
      command: ['sh','-ec','node --import tsx scripts/provision-db.ts --verify-migrator && npm run migrate && node --import tsx scripts/provision-db.ts --grants'] }),
    api: service('api', config.apiImage, { environment: { NODE_ENV: 'test', MIGRATION_TEST_DISPOSABLE:'true', ...portalSecrets, RUN_MIGRATIONS: 'false', PORT: '3000',
      DATABASE_URL: databaseURL('portal_api', secrets.portalRuntime, 'portal-db', identity.portalDatabase),
      FIREBASE_PROJECT_ID: identity.firebaseProject, FIREBASE_AUTH_EMULATOR_HOST: 'emulator:9099', PORTAL_PUBLIC_URL: origin, CORS_ORIGINS: origin,
      PAYLOAD_TO_PORTAL_SECRET: secrets.toPortal, PORTAL_TO_PAYLOAD_SECRET: secrets.toPayload,
      BULK_IMPORT_WORKER_SECRET: secrets.bulk, CMS_INTERNAL_URL: 'http://cms:3001', SOLIDES_RELEASE_STAGE: 'off', UPLOAD_DIR: '/app/uploads' },
      volumes: ['portal-uploads:/app/uploads'] }),
    cms: service('cms', config.cmsImage, { environment: cmsEnv, volumes: ['cms-uploads:/var/lib/ownerinc-cms/media'],
      command: ['sh','-ec','node --import tsx scripts/provision-db.ts --verify-runtime && exec node node_modules/next/dist/bin/next start --port 3001'] }),
    nginx: service('nginx', nginxImage, { volumes: [
      `${path.join(root,'public').replaceAll('\\','/')}:/usr/share/nginx/html:ro`,
      `${path.join(directory,'nginx.conf').replaceAll('\\','/')}:/etc/nginx/conf.d/default.conf:ro`,
      `${path.join(directory,'cert.pem').replaceAll('\\','/')}:/fixture/cert.pem:ro`,
      `${path.join(directory,'key.pem').replaceAll('\\','/')}:/fixture/key.pem:ro` ] }),
  };
  return { name: identity.project, services, networks: { fixture: { name: `${identity.project}-network`, driver:'bridge',internal:true,labels: labels('network') } },
    volumes: Object.fromEntries(volumeRoles.map(role => [role, { name: identity.volumes[role], labels: labels(role) }])) };
}

export function validateComposeContract(observed,identity,config,directory) {
  // Reconstruct the exact reviewed template, not just a self-reported file hash.
  // It cannot introduce external volumes, arbitrary commands, an authority writer,
  // worker, protocol finalizer or a different database through an edited lease.
  try {
    const services=observed.services;
    const secrets={portalAdmin:services['portal-db'].environment.POSTGRES_PASSWORD,
      portalRuntime:services.api.environment.PORTAL_API_DB_PASSWORD,portalCron:services.api.environment.PORTAL_CRON_DB_PASSWORD,
      cmsAdmin:services['cms-db'].environment.POSTGRES_PASSWORD,cmsMigrator:services['cms-provision'].environment.CMS_MIGRATOR_PASSWORD,
      cmsRuntime:services['cms-provision'].environment.CMS_RUNTIME_PASSWORD,payload:services.cms.environment.PAYLOAD_SECRET,
      toPortal:services.cms.environment.PAYLOAD_TO_PORTAL_SECRET,toPayload:services.cms.environment.PORTAL_TO_PAYLOAD_SECRET,
      bulk:services.api.environment.BULK_IMPORT_WORKER_SECRET};
    if(Object.values(secrets).some(value=>typeof value!=='string' || !/^[0-9a-f]{64}$/.test(value)) ||
      new Set(Object.values(secrets)).size!==Object.keys(secrets).length ||
      JSON.stringify(observed)!==JSON.stringify(buildCompose(identity,config,directory,secrets))) fail('functional_compose_contract_invalid');
  } catch {fail('functional_compose_contract_invalid');}
}

export async function checkoutBinding() {
  const commit = await runProcess('git', ['rev-parse','HEAD']);
  const diff = await runProcess('git', ['diff','--binary','HEAD']);
  const tree = [];
  async function scan(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const filename = path.join(directory, name), info = await lstat(filename);
      if (info.isSymbolicLink()) fail('functional_source_symlink_refused');
      if (info.isDirectory()) await scan(filename);
      else if (info.isFile()) tree.push([path.relative(root,filename).replaceAll('\\','/'), hash(await readFile(filename))]);
    }
  }
  await scan(path.join(root,'public'));
  const ownedSources = (await readdir(path.join(root,'scripts/integration'))).filter(name => name.startsWith('payload-functional-'));
  const cases = (await readdir(path.join(root,'cms/tests/integration'))).filter(name => name.startsWith('functional-'));
  for (const filename of [...ownedSources.map(name => path.join(root,'scripts/integration',name)), ...cases.map(name => path.join(root,'cms/tests/integration',name)),
    path.join(root,'scripts/test-payload-integration.mjs'), path.join(root,'cms/tests/support/integration-config.mjs'), path.join(root,'nginx/nginx.conf')]) {
    tree.push([path.relative(root,filename).replaceAll('\\','/'), hash(await readFile(filename))]);
  }
  return { commit, diffHash: hash(diff), sourceHash: hash(JSON.stringify(tree)) };
}

export async function prepareFunctionalLease(env) {
  const config = readFunctionalConfig(env), parent = await checkFunctionalParent(config);
  // Runtime execution is Linux-only in this first slice; prepare is service-free and portable.
  const binding = await checkoutBinding();
  if (binding.commit !== config.commit) fail('functional_checkout_revision_mismatch');
  const cert = await regularFile(config.certificate), key = await regularFile(config.privateKey, { privateFile: true });
  const tls = validateTLS(cert,key);
  const toolHashes=await browserToolBinding(config);
  const playwrightRoot = await realpath(path.dirname(config.playwrightModule));
  if (playwrightRoot.startsWith(path.resolve(root) + path.sep)) fail('functional_isolated_playwright_required');
  const identity = fixtureIdentity(randomUUID()), security = createSecurityContext();
  const directory = await createSecureDirectory(parent, identity.project, security);
  const secrets = Object.fromEntries(['portalAdmin','portalRuntime','portalCron','cmsAdmin','cmsMigrator','cmsRuntime','payload','toPortal','toPayload','bulk'].map(name => [name,randomBytes(32).toString('hex')]));
  const firebaseSource = firebaseConfigSource(identity, `https://127.0.0.1:${config.httpsPort}`);
  const files = { 'cert.pem': cert.toString('utf8'), 'key.pem': key.toString('utf8'),
    'nginx.conf': nginxConfigSource(await readFile(path.join(root,'nginx/nginx.conf'),'utf8'), firebaseSource),
    'firebase-config.js': firebaseSource,
    'compose.json': JSON.stringify(buildCompose(identity,config,directory,secrets),null,2) };
  const fileHashes = {};
  for (const [name,body] of Object.entries(files)) { await writeSecureFile(path.join(directory,name),body,security); fileHashes[name] = hash(body); }
  const lease = { schemaVersion: 1, phase: 'preauthority', identity, config, binding, tls, fileHashes,toolHashes,
    preparedAt: new Date().toISOString(), nonce: randomBytes(32).toString('hex') };
  await writeSecureFile(path.join(directory,'lease.json'),JSON.stringify(lease,null,2),security);
  return path.join(directory,'lease.json');
}

// Optional reader is only an offline test seam. Execution never supplies one;
// production admission uses the same private descriptor/path reader as the lease.
export async function materializeFunctionalRuntime(lease,forwarder,readArtifact=filename=>regularFile(filename,{privateFile:true})) {
  const listener=forwarder.assertHealthy(),port=listener.port;
  if(lease.config.httpsPort!==0 || listener.address!=='127.0.0.1' || listener.pid!==process.pid ||
    !Number.isInteger(port) || port<1024 || port>65535 || port!==forwarder.port ||
    forwarder.origin!==`https://127.0.0.1:${port}`) fail('functional_runtime_listener_binding_invalid');
  const templateBytes=await readArtifact(path.join(lease.directory,'compose.json'));
  if(hash(templateBytes)!==lease.fileHashes?.['compose.json']) fail('functional_artifact_hash_mismatch');
  const template=JSON.parse(templateBytes.toString('utf8'));
  validateComposeContract(template,lease.identity,lease.config,lease.directory);
  // Only the lease's existing fixture secrets are reused. No environment loader,
  // caller-selected target, credentials or operational configuration is admitted.
  const services=template.services,secrets={portalAdmin:services['portal-db'].environment.POSTGRES_PASSWORD,
    portalRuntime:services.api.environment.PORTAL_API_DB_PASSWORD,portalCron:services.api.environment.PORTAL_CRON_DB_PASSWORD,
    cmsAdmin:services['cms-db'].environment.POSTGRES_PASSWORD,cmsMigrator:services['cms-provision'].environment.CMS_MIGRATOR_PASSWORD,
    cmsRuntime:services['cms-provision'].environment.CMS_RUNTIME_PASSWORD,payload:services.cms.environment.PAYLOAD_SECRET,
    toPortal:services.cms.environment.PAYLOAD_TO_PORTAL_SECRET,toPayload:services.cms.environment.PORTAL_TO_PAYLOAD_SECRET,
    bulk:services.api.environment.BULK_IMPORT_WORKER_SECRET};
  const cert=await readArtifact(path.join(lease.directory,'cert.pem'));
  const key=await readArtifact(path.join(lease.directory,'key.pem'));
  if(hash(cert)!==lease.tls.certificateHash || hash(key)!==lease.tls.keyHash) fail('functional_tls_identity_invalid');
  const config={...lease.config,httpsPort:port},security=createSecurityContext();
  const directory=await createSecureDirectory(lease.directory,'runtime',security);
  const firebase=firebaseConfigSource(lease.identity,forwarder.origin);
  const manifest=buildCompose(lease.identity,config,directory,secrets);
  validateComposeContract(manifest,lease.identity,config,directory);
  const files={'cert.pem':cert,'key.pem':key,'firebase-config.js':firebase,
    'nginx.conf':nginxConfigSource(await readFile(path.join(root,'nginx/nginx.conf'),'utf8'),firebase),
    'compose.json':JSON.stringify(manifest,null,2)};
  const hashes={};
  for(const [name,body] of Object.entries(files)) {await writeSecureFile(path.join(directory,name),body,security);hashes[name]=hash(body);}
  await writeSecureFile(path.join(directory,'transport-binding.json'),JSON.stringify({runId:lease.identity.runId,
    runnerPid:process.pid,origin:forwarder.origin,kind:'host_loopback_tcp_to_internal_nginx',hashes},null,2),security);
  forwarder.assertHealthy();
  return {...lease,directory,config,manifest};
}

export async function readFunctionalLease(filename, env) {
  assertFunctionalEnvironment(env); // Before reading private configuration or calling Docker.
  if (!path.isAbsolute(filename || '') || path.basename(filename) !== 'lease.json') fail('functional_lease_path_invalid');
  // POSIX ownership/permissions are mandatory before executing any mutable fixture operation.
  if (process.platform !== 'linux') fail('functional_linux_execution_required');
  const directory = path.dirname(filename), info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) fail('functional_private_directory_unsafe');
  let lease;
  try { lease = JSON.parse((await regularFile(filename,{ privateFile: true })).toString('utf8')); }
  catch { fail('functional_lease_invalid'); }
  if (JSON.stringify(Object.keys(lease).sort()) !== JSON.stringify(['schemaVersion','phase','identity','config','binding','tls','fileHashes','toolHashes','preparedAt','nonce'].sort()) ||
    lease.schemaVersion !== 1 || lease.phase !== 'preauthority' || !/^[0-9a-f]{64}$/.test(lease.nonce)) fail('functional_lease_invalid');
  const identity = fixtureIdentity(lease.identity?.runId);
  if (JSON.stringify(identity) !== JSON.stringify(lease.identity) || path.basename(directory) !== identity.project) fail('functional_lease_identity_mismatch');
  const settings = { NODE_ENV: 'test', MIGRATION_TEST_DISPOSABLE: 'true', GITHUB_SHA: lease.config?.commit,
    PAYLOAD_FUNCTIONAL_PRIVATE_PARENT: lease.config?.privateParent, PAYLOAD_FUNCTIONAL_API_IMAGE: lease.config?.apiImage,
    PAYLOAD_FUNCTIONAL_CMS_IMAGE: lease.config?.cmsImage, PAYLOAD_FUNCTIONAL_EMULATOR_IMAGE: lease.config?.emulatorImage,
    PAYLOAD_FUNCTIONAL_HTTPS_PORT: String(lease.config?.httpsPort), PAYLOAD_FUNCTIONAL_CERTIFICATE: lease.config?.certificate,
    PAYLOAD_FUNCTIONAL_PRIVATE_KEY: lease.config?.privateKey, PAYLOAD_FUNCTIONAL_PLAYWRIGHT_MODULE: lease.config?.playwrightModule };
  if (lease.config?.browserExecutable !== null) settings.PAYLOAD_FUNCTIONAL_BROWSER_EXECUTABLE = lease.config?.browserExecutable;
  for(const [key,value] of Object.entries(env)) {
    if(key.startsWith('PAYLOAD_FUNCTIONAL_') && settings[key]!==value) fail('functional_execution_environment_override');
  }
  const validated = readFunctionalConfig(settings);
  if (JSON.stringify(validated) !== JSON.stringify(lease.config) || path.dirname(directory) !== await checkFunctionalParent(validated)) fail('functional_lease_config_mismatch');
  if (env.GITHUB_SHA && env.GITHUB_SHA !== validated.commit) fail('functional_checkout_revision_mismatch');
  const current = await checkoutBinding();
  if (current.commit!==validated.commit || JSON.stringify(current) !== JSON.stringify(lease.binding)) fail('functional_checkout_changed');
  const expected = ['cert.pem','key.pem','nginx.conf','firebase-config.js','compose.json'];
  if (JSON.stringify(Object.keys(lease.fileHashes).sort()) !== JSON.stringify(expected.sort())) fail('functional_artifact_inventory_mismatch');
  for (const name of expected) if (hash(await regularFile(path.join(directory,name),{ privateFile: true })) !== lease.fileHashes[name]) fail('functional_artifact_hash_mismatch');
  const compose=JSON.parse(await readFile(path.join(directory,'compose.json'),'utf8'));
  validateComposeContract(compose,identity,validated,directory);
  const firebaseSource=firebaseConfigSource(identity,`https://127.0.0.1:${validated.httpsPort}`);
  if(await readFile(path.join(directory,'firebase-config.js'),'utf8')!==firebaseSource ||
    await readFile(path.join(directory,'nginx.conf'),'utf8')!==nginxConfigSource(await readFile(path.join(root,'nginx/nginx.conf'),'utf8'),firebaseSource)) fail('functional_ingress_contract_changed');
  const tls = validateTLS(await readFile(path.join(directory,'cert.pem')),await readFile(path.join(directory,'key.pem')));
  if (JSON.stringify(tls) !== JSON.stringify(lease.tls)) fail('functional_tls_identity_invalid');
  if(JSON.stringify(await browserToolBinding(validated))!==JSON.stringify(lease.toolHashes)) fail('functional_browser_tool_changed');
  // Load only an explicitly supplied, already installed isolated Playwright module.
  let playwright;
  try {
    const imported = await import(pathToFileURL(validated.playwrightModule).href);
    playwright = imported.chromium ? imported : imported.default;
  } catch { fail('functional_playwright_unavailable'); }
  if (!playwright.chromium?.launch) fail('functional_playwright_unavailable');
  const claim = await open(path.join(directory,'consumed.json'),'wx',0o600).catch(() => fail('functional_lease_already_consumed'));
  try { await claim.writeFile(JSON.stringify({ nonce: lease.nonce, claimedAt: new Date().toISOString() })); await claim.sync(); } finally { await claim.close(); }
  return { ...lease, directory, playwright };
}
