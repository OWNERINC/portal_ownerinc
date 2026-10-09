import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';

const mountDefinitions = Object.freeze({
  portalPostgres: { composeKey: 'postgres_data', mounts: [
    { service: 'postgres', destination: '/var/lib/postgresql/data', required: true },
  ] },
  portalUploads: { composeKey: 'uploads_data', mounts: [
    { service: 'api', destination: '/app/uploads', required: true },
    { service: 'cron', destination: '/app/uploads', required: true },
  ] },
  cmsPostgres: { composeKey: 'cms_postgres_data', mounts: [
    { service: 'cms-postgres', destination: '/var/lib/postgresql/data', required: true },
  ] },
  cmsUploads: { composeKey: 'cms_uploads_data', mounts: [
    { service: 'cms', destination: '/var/lib/ownerinc-cms/media', required: true },
    { service: 'cms-worker', destination: '/var/lib/ownerinc-cms/media', required: false },
  ] },
});

export const FIXTURE_STOP_TIMEOUT_SECONDS = 120;
export const FIXTURE_STOP_COMMAND_MARGIN_MS = 30_000;

export function fixtureStopCommandTimeoutMs(writerCount) {
  if (!Number.isSafeInteger(writerCount) || writerCount < 1 || writerCount > 3) {
    throw new Error('invalid_fixture_writer_count');
  }
  // Budget for Compose stopping each requested writer serially, plus bounded
  // client/orchestration overhead. The CLI timeout remains the per-writer cap.
  return writerCount * FIXTURE_STOP_TIMEOUT_SECONDS * 1000 + FIXTURE_STOP_COMMAND_MARGIN_MS;
}

export function normalizePgDumpForSnapshot(dump) {
  const original = Buffer.isBuffer(dump) ? dump : Buffer.from(dump);
  // Work byte-for-byte through a one-byte string encoding. Only the paired
  // psql safety commands at the pg_dump prologue/trailer are volatile; backup
  // artifacts are captured by the coordinator and never pass through here.
  const lines = original.toString('latin1').split('\n');
  const lineText = line => line.endsWith('\r') ? line.slice(0, -1) : line;
  const marker = line => lineText(line).match(/^\\(restrict|unrestrict) ([^\s]+)$/u);
  const prologue = index => lines.slice(0, index).every(raw => {
    const line = lineText(raw).trim();
    return line === '' || line.startsWith('--');
  });
  const trailer = index => lines.slice(index + 1).every(raw => lineText(raw).trim() === '');

  let restrictIndex = -1;
  let restrictKey = null;
  let unrestrictIndex = -1;
  let unrestrictKey = null;
  for (let index = 0; index < lines.length; index += 1) {
    const match = marker(lines[index]);
    if (!match) continue;
    if (match[1] === 'restrict' && restrictIndex < 0 && prologue(index)) {
      restrictIndex = index;
      restrictKey = match[2];
    }
    if (match[1] === 'unrestrict' && trailer(index)) {
      unrestrictIndex = index;
      unrestrictKey = match[2];
    }
  }
  if (restrictIndex < 0 || unrestrictIndex < 0) return original;
  if (restrictKey !== unrestrictKey || restrictIndex >= unrestrictIndex) {
    throw new Error('invalid_pg_dump_snapshot_restriction_pair');
  }
  return Buffer.from(lines.filter((_line, index) => index !== restrictIndex && index !== unrestrictIndex)
    .join('\n'), 'latin1');
}

export function createFixtureProjectNames({ runId, runAttempt }) {
  if (!/^\d+$/.test(String(runId)) || !/^\d+$/.test(String(runAttempt))) throw new Error('invalid_run_identity');
  const nonce = randomBytes(5).toString('hex');
  const prefix = `payload-preauth-${String(runId).slice(-8)}-${String(runAttempt).slice(-4)}-${nonce}`;
  return { source: `${prefix}-source`, target: `${prefix}-target` };
}

export function legacyAnnouncementLookupSql(documentId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(documentId || '')) {
    throw new Error('invalid_legacy_announcement_id');
  }
  return `SELECT json_build_object('title',d.title,'blocks',r.blocks,'editorial',r.editorial)::text FROM cms_documents d JOIN cms_revisions r ON r.id=d.published_revision_id WHERE d.id='${documentId}'`;
}

export function validateRecoveryInputs({ platform, uid, images, runId, runAttempt, commit, dockerEnvironment = {} }) {
  if (platform !== 'linux' || uid !== 0) throw new Error('disposable_linux_root_runner_required');
  if (!candidateImagesValid(images)) throw new Error('immutable_candidate_images_required');
  if (!/^[0-9a-f]{40}$/.test(commit || '') || !/^\d+$/.test(String(runId || '')) ||
      !/^\d+$/.test(String(runAttempt || ''))) throw new Error('github_run_identity_required');
  if (Object.keys(dockerEnvironment).some(name => name.startsWith('DOCKER_') && dockerEnvironment[name])) {
    throw new Error('docker_endpoint_override_forbidden');
  }
  return true;
}

export function createInventory({ project, root, trustedSourceInventoryIdentities = [] }) {
  if (!/^payload-preauth-[a-z0-9-]+-(source|target|lease)$/.test(project)) throw new Error('non_disposable_project');
  if (!path.isAbsolute(root) || path.resolve(root) !== root) throw new Error('noncanonical_fixture_root');
  if (!Array.isArray(trustedSourceInventoryIdentities) ||
      trustedSourceInventoryIdentities.some(value => !/^[0-9a-f]{64}$/.test(value)) ||
      [...trustedSourceInventoryIdentities].sort().join(',') !== [...new Set(trustedSourceInventoryIdentities)].sort().join(',')) {
    throw new Error('invalid_fixture_trust');
  }
  const runtime = path.join(root, 'runtime');
  const volumes = Object.fromEntries(Object.entries(mountDefinitions).map(([key, definition]) => [key, {
    name: `${project}_${definition.composeKey}`,
    composeKey: definition.composeKey,
    mounts: definition.mounts.map(mount => ({ ...mount })),
  }]));
  const document = {
    schemaVersion: 1,
    project,
    paths: {
      root,
      runtime,
      releases: path.join(root, 'releases'),
      currentRelease: path.join(root, 'current-release'),
      lock: path.join(runtime, 'deploy.lock'),
      admissionClosed: `${path.join(runtime, 'deploy.lock')}.admission-closed`,
      backupRoots: [path.join(root, 'backups')],
      preRestoreBackupRoot: path.join(root, 'restore-protection'),
      environmentFile: path.join(runtime, 'fixture.runtime.conf'),
      composeOverride: path.join(runtime, 'compose.fixture.yaml'),
      payloadOverride: path.join(runtime, 'compose.payload.production.yaml'),
    },
    volumes,
    trustedSourceInventoryIdentities: [...trustedSourceInventoryIdentities].sort(),
  };
  // The inventory helper canonicalizes recursively; mirror Python's sorted-key compact JSON.
  const canonical = JSON.stringify(sortKeys(document));
  return { document, identity: createHash('sha256').update(canonical).digest('hex') };
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  return value;
}

export async function writeProtectedInventory(runtimeDirectory, document) {
  const target = path.join(runtimeDirectory, 'payload-control-inventory.json');
  await writeFile(target, `${JSON.stringify(sortKeys(document))}\n`, { flag: 'wx', mode: 0o600 });
  await chmod(target, 0o600);
  return target;
}

export function createSyntheticIdentity(runId, attempt) {
  return `fixture-${runId}-${attempt}-${randomBytes(8).toString('hex')}`;
}

export function createSyntheticValues() {
  const bytes = randomBytes(48).toString('base64url');
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { bytes, firebasePrivateKey: privateKey };
}

export function candidateImagesValid(images) {
  return images && Object.keys(images).sort().join(',') === 'api,cms,cron' &&
    Object.entries(images).every(([service, reference]) => new RegExp(`^ghcr\\.io/ownerinc/ownerinc-portal-${service}@sha256:[0-9a-f]{64}$`).test(reference));
}
