// Hosted-CI transport only. Does not retag images, rewrite sources or authorize releases.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { appendFile, chmod, mkdtemp, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CI_BASE_PINS = Object.freeze([
  ['postgres', '16-alpine', '57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777'],
  ['nginx', 'alpine', '4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752'],
  ['node', '24.12.0-alpine3.23', 'c921b97d4b74f51744057454b306b418cf693865e73b8100559189605f6955b8'],
  ['node', '24-alpine3.23', '9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2'],
  ['golang', '1.26.9-alpine3.23', '96123126ac58e910f4dd3619a8901e2fb6d1ad84b59b1232cac7c9ea65a8f888'],
].map(row => Object.freeze(row)));
const fail = code => { throw new Error(code); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hubHosts = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io', 'registry.hub.docker.com']);
export const HUB_AUTH_KEYS = Object.freeze(['https://index.docker.io/v1/', 'https://index.docker.io/v1',
  'docker.io', 'index.docker.io', 'registry-1.docker.io', 'registry.hub.docker.com',
  'https://docker.io', 'https://registry-1.docker.io']);

function hubKey(key) {
  if (typeof key !== 'string') fail('invalid_ci_docker_configuration');
  try {
    const url = new URL(key.includes('://') ? key : 'https://' + key);
    return hubHosts.has(url.hostname.toLowerCase());
  } catch { fail('invalid_ci_docker_configuration'); }
}

// Pure transformation; secrets are neither decoded nor returned in diagnostics.
// Docker CLI 28 getConfiguredCredentialStore returns a PRESENT per-host helper,
// including an empty string, before consulting the global store. Empty overrides
// select file-store for Hub only; keeping the helper map also prevents autodetect.
export function isolatedDockerConfiguration(original) {
  if (!object(original) || (original.currentContext && original.currentContext !== 'default')) {
    fail('unsupported_ci_docker_configuration');
  }
  if (original.credsStore !== undefined && typeof original.credsStore !== 'string') fail('invalid_ci_docker_configuration');
  const copy = structuredClone(original);
  const keys = new Set(HUB_AUTH_KEYS);
  for (const field of ['auths', 'credHelpers']) {
    if (copy[field] !== undefined && !object(copy[field])) fail('invalid_ci_docker_configuration');
    for (const key of Object.keys(copy[field] || {})) {
      if (hubKey(key)) { keys.add(key); delete copy[field][key]; }
    }
  }
  copy.credHelpers ||= {};
  for (const key of keys) copy.credHelpers[key] = '';
  return copy;
}

const format = '{{json .RepoDigests}}|{{.Id}}|{{.Os}}|{{.Architecture}}';
function normalizeDigestReference(value) {
  if (typeof value !== 'string') fail('invalid_ci_image_identity');
  return value.replace(/^docker\.io\/library\//u, '').replace(/^library\//u, '');
}
export function checkedImageIdentity(raw, expectedReference) {
  const parts = raw.toString('utf8').trim().split('|');
  if (parts.length !== 4 || !/^sha256:[0-9a-f]{64}$/u.test(parts[1]) || parts[2] !== 'linux' || parts[3] !== 'amd64') {
    fail('invalid_ci_image_identity');
  }
  let digests;
  try { digests = JSON.parse(parts[0]); } catch { fail('invalid_ci_image_identity'); }
  if (!Array.isArray(digests) || !digests.length || !digests.every(value => typeof value === 'string') ||
      !digests.some(value => normalizeDigestReference(value) === normalizeDigestReference(expectedReference))) {
    fail('missing_ci_digest_reference');
  }
  return parts[1];
}

// Test seam: command execution is mocked only by callers in offline unit tests.
// In the CLI every pull and inspect is a real Docker command using the private config.
export async function pullPinnedBases(run, configDirectory, log = console.log) {
  for (const [name, tag, digest] of CI_BASE_PINS) {
    const mirror = `mirror.gcr.io/library/${name}:${tag}@sha256:${digest}`;
    const canonical = `${name}:${tag}@sha256:${digest}`;
    const command = async (args, code) => {
      try { return await run('docker', ['--config', configDirectory, ...args]); }
      catch { fail(code); }
    };
    await command(['pull', '--platform=linux/amd64', mirror], 'ci_exact_mirror_pull_failed');
    const mirrorId = checkedImageIdentity(await command(['image', 'inspect', '--format', format, mirror], 'ci_mirror_inspect_failed'),
      `mirror.gcr.io/library/${name}@sha256:${digest}`);
    // A tag is not a canonical RepoDigest. Only this real canonical pull can
    // populate/verify the canonical @digest identity used by unchanged consumers.
    await command(['pull', '--platform=linux/amd64', canonical], 'ci_canonical_digest_pull_failed');
    const canonicalId = checkedImageIdentity(await command(['image', 'inspect', '--format', format, canonical], 'ci_canonical_inspect_failed'),
      `${name}@sha256:${digest}`);
    if (mirrorId !== canonicalId) fail('ci_mirror_canonical_identity_mismatch');
    log(`Prepared CI base: ${name}@sha256:${digest} image=${canonicalId}`);
  }
}

function runDocker(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const chunks = []; let size = 0; let rejected = false;
    const timer = setTimeout(() => { rejected = true; child.kill('SIGKILL'); reject(new Error('ci_docker_command_timeout')); }, 180_000);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) { rejected = true; child.kill('SIGKILL'); reject(new Error('ci_docker_output_limit')); }
      else chunks.push(chunk);
    });
    // Drain private upstream diagnostics; never echo token endpoints or credentials.
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); reject(new Error('ci_docker_command_unavailable')); });
    child.on('close', status => {
      clearTimeout(timer);
      if (!rejected) { if (status === 0) resolve(Buffer.concat(chunks)); else reject(new Error('ci_docker_command_failed')); }
    });
  });
}

async function existingConfig(filename) {
  let file;
  try { file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024 || info.mode & 0o022 ||
        (info.uid !== process.getuid() && info.uid !== 0)) fail('unsafe_ci_docker_configuration');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

export async function main(args = process.argv.slice(2)) {
  if (args.length || process.platform !== 'linux' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
      process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT || !path.isAbsolute(process.env.HOME || '') ||
      !path.isAbsolute(process.env.RUNNER_TEMP || '') || /[\r\n]/u.test(process.env.RUNNER_TEMP) ||
      !path.isAbsolute(process.env.GITHUB_ENV || '')) fail('hosted_ci_registry_context_required');
  const sourceDirectory = process.env.DOCKER_CONFIG || path.join(process.env.HOME, '.docker');
  if (!path.isAbsolute(sourceDirectory)) fail('unsafe_ci_docker_configuration');
  const original = await existingConfig(path.join(sourceDirectory, 'config.json'));
  const config = isolatedDockerConfiguration(original);
  const directory = await mkdtemp(path.join(process.env.RUNNER_TEMP, 'portal-ci-docker-'));
  await chmod(directory, 0o700);
  await writeFile(path.join(directory, 'config.json'), JSON.stringify(config) + '\n', { flag: 'wx', mode: 0o600 });
  // Only the default local context is accepted; no copied credential store, context
  // symlink, certificate or remote Docker endpoint. Other config fields stay intact.
  const context = await runDocker('docker', ['--config', directory, 'context', 'show']);
  if (context.toString('utf8').trim() !== 'default') fail('unexpected_ci_docker_context');
  const version = (await runDocker('docker', ['--config', directory, 'version', '--format', '{{.Server.Version}}'])).toString('utf8').trim();
  const storage = (await runDocker('docker', ['--config', directory, 'info', '--format', '{{.Driver}}|{{json .DriverStatus}}'])).toString('utf8').trim().split('|');
  if (!/^[A-Za-z0-9.+-]{1,80}$/u.test(version) || storage.length !== 2 || !/^[a-z0-9_-]{1,40}$/u.test(storage[0])) {
    fail('invalid_ci_engine_metadata');
  }
  const status = JSON.parse(storage[1]);
  if (!Array.isArray(status)) fail('invalid_ci_engine_metadata');
  const snapshotter = status.some(item => Array.isArray(item) && item[0] === 'driver-type' && item[1] === 'io.containerd.snapshotter.v1');
  console.log(`CI Docker engine: version=${version} driver=${storage[0]} snapshotter=${snapshotter}`);
  await pullPinnedBases(runDocker, directory);
  await appendFile(process.env.GITHUB_ENV, `DOCKER_CONFIG=${directory}\n`);
  // No config/path/credential data on stdout. GHCR login in later steps writes
  // into this private configuration. Credentialed pre-pulls populate the local
  // daemon; root recovery deliberately receives no DOCKER_* configuration.
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    const reasons = new Set(['unsupported_ci_docker_configuration',
      'invalid_ci_docker_configuration', 'invalid_ci_image_identity', 'missing_ci_digest_reference',
      'ci_exact_mirror_pull_failed', 'ci_mirror_inspect_failed', 'ci_canonical_digest_pull_failed',
      'ci_canonical_inspect_failed', 'ci_mirror_canonical_identity_mismatch', 'unsafe_ci_docker_configuration',
      'hosted_ci_registry_context_required', 'unexpected_ci_docker_context', 'invalid_ci_engine_metadata']);
    console.error(`CI registry preparation failed closed: ${reasons.has(error.message) ? error.message : 'ci_registry_preparation_failed'}`);
    process.exitCode = 1;
  });
}
