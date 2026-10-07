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
