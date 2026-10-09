import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { candidateImagesValid } from './payload-preauthority-fixture.mjs';

const canonical = value => JSON.stringify(value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);

// Fixed CI-only namespace. Never derive private storage from RUNNER_TEMP, the
// checkout, an operator argument, or a production app root.
export const PRIVATE_RECOVERY_BASE = '/var/lib/ownerinc-payload-recovery-ci';
const privateBaseMarker = 'ownerinc-payload-recovery-ci-private-base-v1\n';
const checkoutDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function assertProtectedRecoveryDirectory(info, privateDirectory = false) {
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 ||
      (info.mode & 0o022) !== 0 || (privateDirectory && (info.mode & 0o7777) !== 0o700)) {
    throw new Error('unsafe_recovery_private_ancestry');
  }
}

export async function validateRecoveryPrivateAncestry(directory, privateDirectory = false) {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || await realpath(directory) !== directory) {
    throw new Error('unsafe_recovery_private_ancestry');
  }
  let current = directory;
  while (true) {
    assertProtectedRecoveryDirectory(await lstat(current), current === directory && privateDirectory);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export async function createPrivateRecoveryRoot({ runId, runAttempt }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.getgid?.() !== 0) {
    throw new Error('disposable_linux_root_runner_required');
  }
  if (typeof runId !== 'string' || typeof runAttempt !== 'string' ||
      !/^[1-9][0-9]{0,19}$/u.test(runId) || !/^[1-9][0-9]{0,19}$/u.test(runAttempt)) {
    throw new Error('invalid_run_identity');
  }
  process.umask(0o077);
  // Verify before the first write; no recursive mkdir, chown or permission
  // repair of /var/lib, runnerhome, an existing foreign directory, or ancestors.
  await validateRecoveryPrivateAncestry(path.dirname(PRIVATE_RECOVERY_BASE));
  const marker = path.join(PRIVATE_RECOVERY_BASE, '.namespace');
  let created = false;
  try {
    await mkdir(PRIVATE_RECOVERY_BASE, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await validateRecoveryPrivateAncestry(PRIVATE_RECOVERY_BASE, true);
  if (created) await writeFile(marker, privateBaseMarker, { mode: 0o600, flag: 'wx' });
  const info = await lstat(marker);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== 0 || info.gid !== 0 ||
      (info.mode & 0o7777) !== 0o600 || await readFile(marker, 'utf8') !== privateBaseMarker) {
    throw new Error('unsafe_recovery_private_namespace');
  }
  for (const name of await readdir(PRIVATE_RECOVERY_BASE)) {
    if (name === '.namespace') continue;
    if (!/^run-[1-9][0-9]{0,19}-[1-9][0-9]{0,19}-[0-9a-f]{32}$/u.test(name)) {
      throw new Error('unsafe_recovery_private_namespace');
    }
    await validateRecoveryPrivateAncestry(path.join(PRIVATE_RECOVERY_BASE, name), true);
  }
  const directory = path.join(PRIVATE_RECOVERY_BASE, `run-${runId}-${runAttempt}-${randomBytes(16).toString('hex')}`);
  await mkdir(directory, { mode: 0o700 }); // Exclusive: even a nonce collision is rejection, never reuse.
  await validateRecoveryPrivateAncestry(directory, true);
  return directory; // No catch/delete: partial/failed evidence remains for reconciliation.
}

function assertCheckoutMetadata(info, owner, directory) {
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) ||
      (info.uid !== 0 && info.uid !== owner.uid) || (info.gid !== 0 && info.gid !== owner.gid) || (info.mode & 0o002) !== 0) {
    throw new Error('unsafe_initializer_checkout');
  }
}

async function checkoutIdentity(checkout) {
  if (!path.isAbsolute(checkout) || await realpath(checkout) !== checkout ||
      (process.env.GITHUB_WORKSPACE && process.env.GITHUB_WORKSPACE !== checkout)) {
    throw new Error('unsafe_initializer_checkout');
  }
  const owner = await lstat(checkout);
  if (owner.uid !== 0 && (owner.uid < 1000 || owner.uid === 65534)) throw new Error('unsafe_initializer_checkout');
  const records = [];
  const remember = (selected, info) => records.push([selected, info.dev, info.ino, info.uid, info.gid, info.mode, info.size, info.mtimeMs]);
  let current = checkout;
  while (true) {
    const info = await lstat(current);
    assertCheckoutMetadata(info, owner, true);
    remember(current, info);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  // A linked/replaced .git file, symlink, bare checkout or external alternate
  // object store is not this CI checkout. Inspect metadata, never credentials.
  const gitDirectory = path.join(checkout, '.git');
  async function visit(selected) {
    const info = await lstat(selected);
    assertCheckoutMetadata(info, owner, info.isDirectory());
    if (info.uid !== owner.uid || info.gid !== owner.gid) throw new Error('unsafe_initializer_checkout');
    remember(selected, info);
    if (info.isDirectory()) {
      for (const name of (await readdir(selected)).sort()) {
        const relative = path.relative(gitDirectory, path.join(selected, name)).split(path.sep).join('/');
        if (['commondir', 'objects/info/alternates', 'info/grafts', 'refs/replace'].includes(relative)) {
          throw new Error('unsafe_initializer_checkout');
        }
        await visit(path.join(selected, name));
      }
    }
  }
  assertCheckoutMetadata(await lstat(gitDirectory), owner, true);
  await visit(gitDirectory);
  return canonical(records);
}

export async function verifyInitializerCheckout({ runIdentity, run }) {
  // Location comes from this loaded source module, not untrusted cwd/uid/env.
  // GITHUB_WORKSPACE, if retained by sudo, must match rather than redirect it.
  const checkout = checkoutDirectory;
  const before = await checkoutIdentity(checkout);
  const scoped = ['-c', 'safe.directory=', '-c', `safe.directory=${checkout}`, '-C', checkout];
  const observe = selector => run('git', [...scoped, 'rev-parse', selector], { cwd: checkout }).toString('utf8').trim();
  if (observe('--is-bare-repository') !== 'false' || observe('--show-toplevel') !== checkout) {
    throw new Error('unsafe_initializer_checkout');
  }
  const actualCommit = observe('HEAD');
  if (actualCommit !== runIdentity.commit || !/^[0-9a-f]{40}$/u.test(actualCommit) || await checkoutIdentity(checkout) !== before) {
    throw new Error('initializer_checkout_mismatch');
  }
  return actualCommit;
}

export function initializationRequest({ commit, runId, runAttempt }, images) {
  if (typeof commit !== 'string' || typeof runId !== 'string' || typeof runAttempt !== 'string' ||
      !/^[0-9a-f]{40}$/u.test(commit || '') || !/^[1-9][0-9]{0,19}$/u.test(runId || '') ||
      !/^[1-9][0-9]{0,19}$/u.test(runAttempt || '') || !candidateImagesValid(images)) {
    throw new Error('invalid_initializer_candidate');
  }
  return `${canonical({ schemaVersion: 1, purpose: 'isolated-recovery-producer',
    commit, runId, runAttempt, images })}\n`;
}

export function legacySourceMaterial(images) {
  if (!candidateImagesValid(images)) throw new Error('invalid_initializer_candidate');
  const manifest = `API_IMAGE=${images.api}\nCRON_IMAGE=${images.cron}\n`;
  const sha256 = createHash('sha256').update(manifest).digest('hex');
  // This is a content-addressed fixture namespace, NOT a production git SHA.
  return { manifest, sha256, releaseId: sha256.slice(0, 40) };
}

export async function initializePreauthority({ runtime, runIdentity, images, run, withLease }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0 || process.getgid?.() !== 0 ||
      !/^payload-preauth-[0-9]+-[0-9]+-[0-9a-f]{10}-(source|target|lease)$/u.test(runtime.project)) {
    throw new Error('disposable_linux_root_runner_required');
  }
  const raw = initializationRequest(runIdentity, images);
  const actualCommit = await verifyInitializerCheckout({ runIdentity, run });
  if (actualCommit !== runIdentity.commit || path.basename(runtime.payloadRelease) !== actualCommit) {
    throw new Error('initializer_checkout_mismatch');
  }
  await validateRecoveryPrivateAncestry(runtime.directory, true);
  const request = path.join(runtime.directory, 'payload-initialize-request.json');
  try {
    await writeFile(request, raw, { flag: 'wx', mode: 0o600 });
    await chmod(request, 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await lstat(request);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== 0 || info.gid !== 0 ||
        (info.mode & 0o777) !== 0o600 || (await readFile(request, 'utf8')) !== raw) {
      throw new Error('initializer_request_mismatch');
    }
    // An exact interrupted request is explicit retry, not a new candidate or
    // adoption of an initialized project. Terminal retry must fully reverify
    // the same closed/stopped floor, not return merely because pointer matches.
  }
  return withLease(runtime, runtime.project, path.join(runtime.directory, 'payload-operations-guard'),
    ['initialize-isolated', runtime.payloadRelease, request], {
      release: runtime.payloadRelease, substep: 'payload_initialize_isolated',
      timeout: 15 * 60_000, preservePrivateErrorEvidence: true,
    });
}
