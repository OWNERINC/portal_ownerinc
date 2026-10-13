// Service-free preflight. Never loads .env, local TaskN state, pg or Payload.
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

export class IntegrationGuardError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// The integrated fixture has no caller-selected database URL, volume or authority.
// It is a separate opt-in contract; the older host-side preflight remains intact.
export const functionalFallbacks = Object.freeze([
  'DATABASE_URL', 'MIGRATION_DATABASE_URL', 'API_DATABASE_URL', 'CRON_DATABASE_URL',
  'CMS_DATABASE_URL', 'CMS_ADMIN_DATABASE_URL', 'CMS_RUNTIME_DATABASE_URL',
  'CMS_MIGRATION_DATABASE_URL', 'CMS_OBSERVER_DATABASE_URL', 'OWNER_NEWS_CONTROL_DATABASE_URL',
  'FIREBASE_PROJECT_ID', 'FIREBASE_AUTH_EMULATOR_HOST', 'GOOGLE_APPLICATION_CREDENTIALS',
  'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY', 'PORTAL_PUBLIC_URL', 'PORTAL_INTERNAL_URL',
  'CMS_INTERNAL_URL', 'CMS_UPLOAD_DIR', 'UPLOAD_DIR', 'PAYLOAD_SECRET',
  'PAYLOAD_TO_PORTAL_SECRET', 'PORTAL_TO_PAYLOAD_SECRET', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME',
  'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
  'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'PYTHONPATH',
]);

export function assertFunctionalEnvironment(env) {
  if (env.MIGRATION_TEST_DISPOSABLE !== 'true') reject('disposable_required');
  if (env.NODE_ENV !== 'test') reject('test_environment_required');
  if (functionalFallbacks.some(key => Object.hasOwn(env, key)) ||
      Object.keys(env).some(key => key.startsWith('PAYLOAD_TEST_'))) reject('functional_external_override_refused');
}

export function readFunctionalConfig(env, root = repositoryRoot) {
  assertFunctionalEnvironment(env);
  const permitted = new Set(['PAYLOAD_FUNCTIONAL_PRIVATE_PARENT', 'PAYLOAD_FUNCTIONAL_API_IMAGE',
    'PAYLOAD_FUNCTIONAL_CMS_IMAGE', 'PAYLOAD_FUNCTIONAL_EMULATOR_IMAGE',
    'PAYLOAD_FUNCTIONAL_HTTPS_PORT', 'PAYLOAD_FUNCTIONAL_CERTIFICATE', 'PAYLOAD_FUNCTIONAL_PRIVATE_KEY',
    'PAYLOAD_FUNCTIONAL_PLAYWRIGHT_MODULE', 'PAYLOAD_FUNCTIONAL_BROWSER_EXECUTABLE']);
  if (Object.keys(env).some(key => key.startsWith('PAYLOAD_FUNCTIONAL_') && !permitted.has(key))) {
    reject('functional_unknown_setting');
  }
  if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA || '')) reject('functional_source_revision_required');
  const image = key => {
    const value = env[key];
    if (typeof value !== 'string' || !/^(?:sha256:|ghcr\.io\/ownerinc\/ownerinc-portal-(?:api|cms|firebase-emulator)@sha256:)[0-9a-f]{64}$/.test(value)) {
      reject('functional_immutable_image_required');
    }
    return value;
  };
  const apiImage = image('PAYLOAD_FUNCTIONAL_API_IMAGE'), cmsImage = image('PAYLOAD_FUNCTIONAL_CMS_IMAGE');
  const emulatorImage = image('PAYLOAD_FUNCTIONAL_EMULATOR_IMAGE');
  if (new Set([apiImage, cmsImage, emulatorImage]).size !== 3) reject('functional_distinct_images_required');
  const portText = env.PAYLOAD_FUNCTIONAL_HTTPS_PORT || '';
  // Reserve an ephemeral loopback listener at execution time, without a
  // check-close-rebind race. Prepared port 0 is a template, never runtime origin.
  if (portText !== '0') {
    reject('functional_https_port_invalid');
  }
  const privateParent = privatePath(env.PAYLOAD_FUNCTIONAL_PRIVATE_PARENT, root, 'functional');
  const file = key => {
    const value = env[key];
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) reject('functional_absolute_file_required');
    return privatePath(value,root,'functional_file');
  };
  return Object.freeze({ commit: env.GITHUB_SHA, apiImage, cmsImage, emulatorImage,
    privateParent, httpsPort: Number(portText), certificate: file('PAYLOAD_FUNCTIONAL_CERTIFICATE'),
    privateKey: file('PAYLOAD_FUNCTIONAL_PRIVATE_KEY'), playwrightModule: file('PAYLOAD_FUNCTIONAL_PLAYWRIGHT_MODULE'),
    browserExecutable: env.PAYLOAD_FUNCTIONAL_BROWSER_EXECUTABLE === undefined ? null : file('PAYLOAD_FUNCTIONAL_BROWSER_EXECUTABLE') });
}

export async function checkFunctionalParent(config, root = repositoryRoot) {
  try {
    const parent = await checkPrivateDirectory(config.privateParent);
    const info = await lstat(parent);
    if (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0)) {
      reject('functional_private_parent_unsafe');
    }
    const checkout = await realpath(root);
    if (overlaps(parent, checkout) || overlaps(checkout, parent)) reject('functional_directory_alias');
    return parent;
  } catch (error) {
    if (error instanceof IntegrationGuardError) throw error;
    reject('functional_private_parent_unavailable');
  }
}

function reject(code) { throw new IntegrationGuardError(code); }

function databaseTarget(value, label) {
  if (typeof value !== 'string' || !value) reject(`${label}_database_required`);
  let url;
  try { url = new URL(value); } catch { reject(`${label}_database_invalid`); }
  // Initial portable runner is host-side, for explicitly supplied loopback targets.
  // Query options can override host/database in pg, so they are never accepted.
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username
      || url.search || url.hash || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    reject(`${label}_database_invalid`);
  }
  const database = url.pathname.slice(1);
  if (!/^[a-z][a-z0-9_]*$/.test(database)
      || !/(?:^|_)(?:test|dev)(?:_|$)/.test(database)) reject(`${label}_database_not_disposable`);
  // pg otherwise inherits PGPORT when the URI omits its port. Compare and return
  // the same effective target so ambient driver defaults cannot defeat isolation.
  if (!url.port) url.port = '5432';
  // Normalize loopback aliases; different users/URI schemes are not isolation.
  return { url: url.href, identity: `loopback:${url.port}/${database}` };
}

function overlaps(a, b) {
  const relative = path.relative(a, b);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function privatePath(value, root, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) reject(`${label}_directory_required`);
  const result = path.resolve(value);
  if (overlaps(root, result) || overlaps(result, root)) reject(`${label}_directory_not_private`);
  return result;
}

export function readIntegrationConfig(env, root = repositoryRoot) {
  if (env.MIGRATION_TEST_DISPOSABLE !== 'true') reject('disposable_required');
  if (!['test', 'development'].includes(env.NODE_ENV)) reject('test_environment_required');
  const portal = databaseTarget(env.PAYLOAD_TEST_PORTAL_DATABASE_URL, 'portal');
  const cms = databaseTarget(env.PAYLOAD_TEST_CMS_DATABASE_URL, 'cms');
  if (portal.identity === cms.identity) reject('distinct_databases_required');
  const uploads = privatePath(env.PAYLOAD_TEST_UPLOAD_DIR, root, 'uploads');
  const evidence = privatePath(env.PAYLOAD_TEST_EVIDENCE_DIR, root, 'evidence');
  if (overlaps(uploads, evidence) || overlaps(evidence, uploads)) reject('distinct_directories_required');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(env.PAYLOAD_TEST_RUN_ID || '')) {
    reject('synthetic_run_id_required');
  }
  return Object.freeze({ portalDatabaseURL: portal.url, cmsDatabaseURL: cms.url,
    uploadDir: uploads, evidenceDir: evidence, runId: env.PAYLOAD_TEST_RUN_ID });
}

async function checkPrivateDirectory(directory) {
  let current = directory;
  // A user's home may itself be a dotfiles Git repository. Explicit scratch
  // directories under the OS temp root do not become source fixtures for that
  // reason; still reject a checkout inside temp and all symlink ancestors.
  const temporaryRoot = await realpath(tmpdir());
  const inTemp = overlaps(temporaryRoot, await realpath(directory));
  while (true) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) reject('private_directory_invalid');
    const git = await lstat(path.join(current, '.git')).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (git && (!inTemp || overlaps(temporaryRoot, await realpath(current)))) reject('private_directory_in_checkout');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return realpath(directory);
}

export async function checkIntegrationDirectories(config, root = repositoryRoot) {
  try {
    const [uploads, evidence, checkout] = await Promise.all([
      checkPrivateDirectory(config.uploadDir), checkPrivateDirectory(config.evidenceDir), realpath(root),
    ]);
    if (overlaps(checkout, uploads) || overlaps(uploads, checkout)
        || overlaps(checkout, evidence) || overlaps(evidence, checkout)
        || overlaps(uploads, evidence) || overlaps(evidence, uploads)) reject('private_directory_alias');
  } catch (error) {
    if (error instanceof IntegrationGuardError) throw error;
    // Filesystem errors contain private paths. Only a fixed code crosses the CLI.
    reject('private_directory_unavailable');
  }
}
