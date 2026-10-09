import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const POLICY_PATH = '/etc/ownerinc/payload-candidate/production-policy.json';
export const TOOL_ROOT = '/opt/ownerinc/lib/payload-candidate';
export const REGISTRY = '/var/lib/ownerinc/payload-candidate/records';
const WORK_ROOT = '/var/lib/ownerinc/payload-candidate/work';
const REPOSITORY = 'OWNERINC/portal_ownerinc';
const WORKFLOW = '.github/workflows/ci.yml';
const CONTRACT = 'payload-preauthority-recovery-v1';
const TOOL_FILES = Object.freeze(['ops/payload-candidate-verifier.py', 'scripts/register-payload-candidate-admission.mjs',
  'scripts/package-payload-candidate.mjs', 'scripts/lib/payload-candidate-qualification.mjs']);
const ROLES = ['candidate', 'qualified', 'report'];
const SERVICES = ['api', 'cron', 'cms'];
const MAX_JSON = 1024 * 1024;
const MAX_ARCHIVE = 10 * MAX_JSON;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
const matches = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const isHash = value => matches(value, /^[0-9a-f]{64}$/u);
const isId = value => matches(value, /^[1-9][0-9]{0,19}$/u);
function shape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) fail('invalid_admission_shape');
}
function canonicalPath(value) {
  if (!matches(value, /^\/[A-Za-z0-9_./-]{1,4095}$/u) || path.posix.normalize(value) !== value || value.includes('//')) {
    fail('unsafe_admission_path');
  }
  return value;
}

// Independent bootstrap parser: no imports from packager/candidate before the
// root policy has authenticated the installed closure. Duplicate escaped keys fail.
export function parseAdmissionJson(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_JSON) fail('invalid_admission_json');
  let text; let value;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    value = JSON.parse(text, (_key, item) => {
      if (typeof item === 'number' && !Number.isSafeInteger(item)) fail('invalid_admission_number');
      return item;
    });
  } catch { fail('invalid_admission_json'); }
  let index = 0;
  const whitespace = () => { while (index < text.length && /\s/u.test(text[index])) index++; };
  const string = () => {
    const start = index++;
    while (text[index] !== '"') { if (text[index++] === '\\') index++; }
    return JSON.parse(text.slice(start, ++index));
  };
  const walk = (depth = 0) => {
    if (depth > 32) fail('admission_nesting_exceeded');
    whitespace();
    if (text[index] === '{') {
      index++; whitespace(); const seen = new Set();
      if (text[index] !== '}') {
        while (true) {
          whitespace(); const key = string();
          if (seen.has(key)) fail('duplicate_admission_field');
          seen.add(key); whitespace(); index++; walk(depth + 1); whitespace();
          if (text[index] !== ',') break;
          index++;
        }
      }
      index++;
    } else if (text[index] === '[') {
      index++; whitespace();
      if (text[index] !== ']') {
        while (true) { walk(depth + 1); whitespace(); if (text[index] !== ',') break; index++; }
      }
      index++;
    } else if (text[index] === '"') string();
    else {
      const start = index;
      while (index < text.length && !/[\s,\]}]/u.test(text[index])) index++;
      if (/^[\-0-9]/u.test(text[start]) && /[.eE]/u.test(text.slice(start, index))) fail('invalid_admission_number');
    }
  };
  walk();
  return value;
}

export function validateAdmissionPolicy(policy) {
  shape(policy, ['schemaVersion', 'kind', 'environment', 'repository', 'repositoryId', 'workflow', 'workflowId',
    'approvedRevisions', 'toolchain']);
  if (policy.schemaVersion !== 1) fail('unsupported_admission_policy');
  if (policy.kind !== 'ownerinc-payload-candidate-policy-v1' || policy.environment !== 'production' ||
      policy.repository !== REPOSITORY || policy.workflow !== WORKFLOW || !isId(policy.repositoryId) || !isId(policy.workflowId)) {
    fail('invalid_admission_policy');
  }
  if (!Array.isArray(policy.approvedRevisions) || !policy.approvedRevisions.length || policy.approvedRevisions.length > 128) {
    fail('invalid_approved_revisions');
  }
  const seen = new Set();
  for (const revision of policy.approvedRevisions) {
    shape(revision, ['commit', 'workflowSha256']);
    if (!matches(revision.commit, /^[0-9a-f]{40}$/u) || !isHash(revision.workflowSha256) || seen.has(revision.commit)) {
      fail('invalid_approved_revisions');
    }
    seen.add(revision.commit);
  }
  shape(policy.toolchain, ['files', 'executables']); shape(policy.toolchain.files, TOOL_FILES);
  if (!Object.values(policy.toolchain.files).every(isHash)) fail('invalid_admission_toolchain');
  shape(policy.toolchain.executables, ['node', 'git', 'python', 'gitRemoteHttps']); const paths = new Set();
  for (const [role, executable] of Object.entries(policy.toolchain.executables)) {
    shape(executable, ['path', 'sha256']); const selected = canonicalPath(executable.path);
    if (!isHash(executable.sha256) || paths.has(selected) || (role === 'git' && path.posix.basename(selected) !== 'git') ||
        (role === 'gitRemoteHttps' && selected !== `${TOOL_ROOT}/bin/git-remote-https`)) {
      fail('invalid_admission_toolchain');
    }
    paths.add(selected);
  }
  return policy;
}

export function validateAdmissionRecord(record) {
  shape(record, ['schemaVersion', 'kind', 'environment', 'policySha256', 'repository', 'repositoryId', 'workflow',
    'workflowId', 'workflowSha256', 'commit', 'runId', 'runAttempt', 'images', 'artifacts', 'qualificationContract',
    'candidateSha256', 'qualifiedManifestSha256', 'recoveryReportSha256', 'sourceTreeSha', 'sourceArchiveSha256',
    'archiveSha256', 'archiveBytes', 'deploymentAuthorized']);
  if (record.schemaVersion !== 1 || record.kind !== 'payload-candidate-admission-record-v1' ||
      record.environment !== 'production' || record.repository !== REPOSITORY || record.workflow !== WORKFLOW ||
      record.qualificationContract !== CONTRACT || record.deploymentAuthorized !== false ||
      !isId(record.repositoryId) || !isId(record.workflowId)) fail('invalid_admission_record');
  for (const key of ['policySha256', 'workflowSha256', 'candidateSha256', 'qualifiedManifestSha256', 'recoveryReportSha256',
    'sourceArchiveSha256', 'archiveSha256']) if (!isHash(record[key])) fail('invalid_admission_hash');
  if (!matches(record.commit, /^[0-9a-f]{40}$/u) || !matches(record.sourceTreeSha, /^[0-9a-f]{40}$/u) ||
      !isId(record.runId) || !isId(record.runAttempt) || !Number.isSafeInteger(record.archiveBytes) ||
      record.archiveBytes < 1 || record.archiveBytes > MAX_ARCHIVE) fail('invalid_admission_identity');
  shape(record.images, SERVICES);
  for (const service of SERVICES) {
    if (!matches(record.images[service], new RegExp(`^ghcr\\.io/ownerinc/ownerinc-portal-${service}@sha256:[0-9a-f]{64}$`, 'u'))) {
      fail('invalid_admission_images');
    }
  }
  shape(record.artifacts, ROLES);
  for (const role of ROLES) {
    shape(record.artifacts[role], ['id', 'digest']);
    if (!isId(record.artifacts[role].id) || !matches(record.artifacts[role].digest, /^sha256:[0-9a-f]{64}$/u)) {
      fail('invalid_admission_artifacts');
    }
  }
  if (new Set(ROLES.map(role => record.artifacts[role].id)).size !== 3) fail('invalid_admission_artifacts');
  return record;
}

// In-memory test seam only. This cannot install/admit a caller-provided record.
// The CLI supplies only the hash-verified installed packager and protected inputs.
export async function reconstructAdmission(policyRaw, request, {
  packager, checkout, output, token, fetchImpl, workflowBytes, bundleBytes,
}) {
  const policy = validateAdmissionPolicy(parseAdmissionJson(policyRaw));
  packager.validatePackageRequest(request);
  const revision = policy.approvedRevisions.find(item => item.commit === request.commit);
  if (!revision) fail('candidate_revision_not_approved');
  if (!Buffer.isBuffer(workflowBytes) || !workflowBytes.length || workflowBytes.length > MAX_JSON ||
      hash(workflowBytes) !== revision.workflowSha256) fail('approved_workflow_bytes_mismatch');
  if (!Buffer.isBuffer(bundleBytes) || bundleBytes.length < 1 || bundleBytes.length > MAX_ARCHIVE) fail('invalid_admission_archive');
  const receipt = await packager.packageCandidate(request, { checkout, output, token, fetchImpl });
  // Read the derived package, not supplied sidecars/receipt. Bind the complete gzip
  // stream, including timestamps/headers: semantic tar equivalence is insufficient.
  const derived = await readOrdinaryOutput(path.join(output, 'payload-candidate.tar.gz'));
  if (!derived.equals(bundleBytes) || receipt.archiveSha256 !== hash(derived) || receipt.archiveBytes !== derived.length) {
    fail('admission_archive_not_reconstructed');
  }
  if (receipt.repository !== policy.repository || String(receipt.repositoryId) !== policy.repositoryId ||
      receipt.workflow !== policy.workflow || String(receipt.workflowId) !== policy.workflowId ||
      receipt.deploymentAuthorized !== false || receipt.commit !== request.commit ||
      receipt.runId !== request.runId || receipt.runAttempt !== request.runAttempt ||
      ROLES.some(role => receipt.artifacts?.[role]?.id !== request.artifactIds[role])) fail('admission_authenticated_binding_mismatch');
  const record = {
    schemaVersion: 1, kind: 'payload-candidate-admission-record-v1', environment: 'production', policySha256: hash(policyRaw),
    repository: policy.repository, repositoryId: policy.repositoryId, workflow: policy.workflow, workflowId: policy.workflowId,
    workflowSha256: revision.workflowSha256, commit: receipt.commit, runId: receipt.runId, runAttempt: receipt.runAttempt,
    images: receipt.images, artifacts: Object.fromEntries(ROLES.map(role => [role,
      { id: receipt.artifacts[role].id, digest: receipt.artifacts[role].digest }])),
    qualificationContract: receipt.qualificationContract, candidateSha256: receipt.candidateSha256,
    qualifiedManifestSha256: receipt.qualifiedManifestSha256, recoveryReportSha256: receipt.recoveryReportSha256,
    sourceTreeSha: receipt.sourceTreeSha, sourceArchiveSha256: receipt.sourceArchiveSha256,
    archiveSha256: receipt.archiveSha256, archiveBytes: receipt.archiveBytes, deploymentAuthorized: false,
  };
  return validateAdmissionRecord(record);
}

async function readOrdinaryOutput(filename) {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size < 1 || info.size > MAX_ARCHIVE) fail('invalid_admission_archive');
    return await readBounded(file, MAX_ARCHIVE);
  } finally { await file.close(); }
}

export function checkFileMetadata(info, modes = [0o600]) {
  if (!info.isFile() || info.nlink !== 1) fail('unsafe_admission_file');
  if (info.uid !== 0 || info.gid !== 0) fail('unsafe_admission_owner');
  if (!modes.includes(info.mode & 0o7777)) fail('unsafe_admission_permissions');
}
export function checkDirectoryMetadata(info, privateDirectory = false) {
  if (!info.isDirectory() || info.uid !== 0 || info.gid !== 0 || info.mode & 0o7022 ||
      (privateDirectory && (info.mode & 0o7777) !== 0o700)) fail('unsafe_admission_ancestry');
}
async function ancestry(filename, privateParent = false) {
  canonicalPath(filename);
  if (await realpath(filename) !== filename) fail('unsafe_admission_path');
  let parent = path.dirname(filename); let first = true;
  while (true) {
    checkDirectoryMetadata(await lstat(parent), privateParent && first);
    if (parent === '/') break;
    parent = path.dirname(parent); first = false;
  }
}
const fingerprint = info => [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs, info.mode, info.uid, info.gid, info.nlink].join(':');
async function readBounded(file, limit) {
  const chunks = []; let total = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
    if (!bytesRead) break;
    total += bytesRead;
    if (total > limit) fail('admission_file_limit_exceeded');
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks);
}
async function protectedBytes(filename, limit, modes = [0o600]) {
  await ancestry(filename);
  const before = await lstat(filename, { bigint: true });
  checkFileMetadata(await lstat(filename), modes);
  if (before.size < 1n || before.size > BigInt(limit)) fail('admission_file_limit_exceeded');
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat({ bigint: true });
    checkFileMetadata(await file.stat(), modes);
    if (fingerprint(before) !== fingerprint(opened)) fail('admission_file_changed');
    const result = await readBounded(file, limit);
    if (BigInt(result.length) !== opened.size || fingerprint(await file.stat({ bigint: true })) !== fingerprint(opened) ||
        fingerprint(await lstat(filename, { bigint: true })) !== fingerprint(opened)) fail('admission_file_changed');
    await ancestry(filename);
    return result;
  } finally { await file.close(); }
}
async function protectedDirectory(filename) {
  canonicalPath(filename);
  if (await realpath(filename) !== filename) fail('unsafe_admission_path');
  checkDirectoryMetadata(await lstat(filename), true);
  await ancestry(filename);
}

async function installedTools(policy) {
  if (fileURLToPath(import.meta.url) !== `${TOOL_ROOT}/scripts/register-payload-candidate-admission.mjs`) fail('admission_tool_not_installed');
  for (const [relative, expected] of Object.entries(policy.toolchain.files)) {
    const raw = await protectedBytes(`${TOOL_ROOT}/${relative}`, 2 * MAX_JSON, [relative.endsWith('.py') ? 0o755 : 0o644]);
    if (hash(raw) !== expected) fail('installed_admission_tool_mismatch');
  }
  for (const executable of Object.values(policy.toolchain.executables)) {
    if (hash(await protectedBytes(executable.path, 200 * MAX_JSON, [0o755])) !== executable.sha256) {
      fail('installed_admission_executable_mismatch');
    }
  }
  if (await realpath(process.execPath) !== policy.toolchain.executables.node.path) fail('admission_interpreter_mismatch');
}

function safeProcessEnvironment(policy, home) {
  const directory = path.dirname(policy.toolchain.executables.git.path);
  return { PATH: directory, HOME: home, LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_EXEC_PATH: `${TOOL_ROOT}/bin` };
}
async function fetchOfficialSource(policy, work, commit, token) {
  if (typeof token !== 'string' || !token.trim() || /\s/u.test(token)) fail('github_authentication_required');
  const executable = policy.toolchain.executables.git.path;
  const env = safeProcessEnvironment(policy, work);
  const args = ['--no-replace-objects', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=',
    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'http.followRedirects=false'];
  const git = (parameters, authenticate = false) => {
    // Scoped to the exact official repository URL and only the fetch child. No
    // token in argv, on disk, credential helpers, other Git stages or redirects.
    const selectedEnv = authenticate ? { ...env, GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `http.https://github.com/${REPOSITORY}.git.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` } : env;
    return execFileSync(executable, [...args, ...parameters],
      { cwd: work, env: selectedEnv, timeout: 120_000, maxBuffer: 200 * MAX_JSON, stdio: ['ignore', 'pipe', 'pipe'] });
  };
  const checkout = path.join(work, 'source.git');
  git(['init', '--bare', '--template=', checkout]);
  // A new bare repo has no hooks, attributes overrides or inherited origin config.
  git(['--git-dir=' + checkout, 'fetch', '--no-tags', '--depth=1', '--', `https://github.com/${REPOSITORY}.git`, commit], true);
  git(['--git-dir=' + checkout, 'fsck', '--strict', '--no-reflogs', commit]);
  const workflowBytes = git(['--git-dir=' + checkout, 'show', `${commit}:${WORKFLOW}`]);
  return { checkout, workflowBytes };
}

async function syncDirectory(filename) {
  const directory = await open(filename, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { checkDirectoryMetadata(await directory.stat(), true); await directory.sync(); }
  finally { await directory.close(); }
}

async function persistRecord(record, recheck) {
  // Private helpers only: callers cannot install arbitrary JSON through an export.
  validateAdmissionRecord(record); await protectedDirectory(REGISTRY);
  const filename = `${REGISTRY}/${record.archiveSha256}.${record.policySha256}.json`;
  const pending = `${REGISTRY}/.pending-${randomUUID()}`;
  const bytes = Buffer.from(JSON.stringify(record) + '\n');
  const file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { checkFileMetadata(await file.stat()); await file.writeFile(bytes); await file.sync(); }
  finally { await file.close(); }
  await recheck(); await protectedDirectory(REGISTRY);
  // link is atomic and refuses an existing destination, unlike rename. The brief
  // nlink=2 interval fails closed in the reader; the pending link is then removed.
  // On any failure, existing records and pending evidence are never overwritten.
  await link(pending, filename);
  await unlink(pending);
  await syncDirectory(REGISTRY);
  if (!(await protectedBytes(filename, MAX_JSON)).equals(bytes)) fail('admission_record_write_mismatch');
  await recheck();
  return record;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const flags = ['--environment', '--repository', '--commit', '--run-id', '--run-attempt',
    '--candidate-artifact-id', '--qualified-artifact-id', '--report-artifact-id', '--archive'];
  const selected = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!flags.includes(args[index]) || Object.hasOwn(selected, args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) {
      fail('invalid_admission_arguments');
    }
    selected[args[index]] = args[index + 1];
  }
  if (Object.keys(selected).length !== flags.length || selected['--environment'] !== 'production' ||
      selected['--repository'] !== REPOSITORY) fail('invalid_admission_arguments');
  if (process.platform !== 'linux' || process.getuid() !== 0 || process.geteuid() !== 0) fail('root_posix_admission_required');
  if (Object.keys(process.env).some(key => /^(?:NODE_.*|LD_.*|DYLD_.*|PYTHON.*|GIT_.*|SSL_.*|OPENSSL_.*)$/u.test(key)) ||
      process.execArgv.length !== 0) fail('unsafe_admission_process_environment');
  const policyRaw = await protectedBytes(POLICY_PATH, MAX_JSON);
  const policy = validateAdmissionPolicy(parseAdmissionJson(policyRaw));
  await installedTools(policy);
  const request = { repository: REPOSITORY, commit: selected['--commit'], runId: selected['--run-id'], runAttempt: selected['--run-attempt'],
    artifactIds: Object.fromEntries(ROLES.map(role => [role, selected[`--${role}-artifact-id`]])) };
  // Every reachable non-builtin module is a fixed, hash-verified installed file.
  const packager = await import(pathToFileURL(`${TOOL_ROOT}/scripts/package-payload-candidate.mjs`).href);
  packager.validatePackageRequest(request);
  if (!policy.approvedRevisions.some(item => item.commit === request.commit)) fail('candidate_revision_not_approved');
  const token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (typeof token !== 'string' || !token.trim() || /\s/u.test(token)) fail('github_authentication_required');
  const bundleBytes = await protectedBytes(selected['--archive'], MAX_ARCHIVE);
  await protectedDirectory(WORK_ROOT); await protectedDirectory(REGISTRY);
  const work = `${WORK_ROOT}/${randomUUID()}`;
  await mkdir(work, { mode: 0o700 }); await protectedDirectory(work);
  const { checkout, workflowBytes } = await fetchOfficialSource(policy, work, request.commit, token);
  // A+B uses execFile('git') internally. Confine that resolution and its HOME to
  // the approved executable's protected directory and the new private workspace.
  const previous = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { PATH: path.dirname(policy.toolchain.executables.git.path), HOME: work, TMPDIR: work });
  let record;
  try {
    record = await reconstructAdmission(policyRaw, request, { packager, checkout, output: `${work}/derived`, token, workflowBytes, bundleBytes });
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  const recheck = async () => {
    if (!(await protectedBytes(POLICY_PATH, MAX_JSON)).equals(policyRaw)) fail('admission_policy_changed');
    await installedTools(policy);
    if (!(await protectedBytes(selected['--archive'], MAX_ARCHIVE)).equals(bundleBytes)) fail('admission_archive_changed');
  };
  return persistRecord(record, recheck);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(record => console.log(JSON.stringify({ ...record,
    admissionRecordSha256: hash(Buffer.from(JSON.stringify(record) + '\n')) }))).catch(() => {
    console.error('Candidate admission registration failed closed.'); process.exitCode = 1;
  });
}
