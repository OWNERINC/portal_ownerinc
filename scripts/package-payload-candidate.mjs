import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, inflateRawSync } from 'node:zlib';
import {
  parseEvidenceJson, reject, sha256, validateQualifiedCandidate, validateRunIdentity,
} from './lib/payload-candidate-qualification.mjs';

export const CANDIDATE_REPOSITORY = 'OWNERINC/portal_ownerinc';
export const CANDIDATE_WORKFLOW = '.github/workflows/ci.yml';
const maxZipBytes = 2 * 1024 * 1024;
const maxSourceBytes = 200 * 1024 * 1024;
const maxReleaseBytes = 10 * 1024 * 1024; // Existing receiver limit; this tool never sends it.
const artifactDefinitions = Object.freeze({
  candidate: { name: 'payload-release-candidate', file: 'candidate.json' },
  qualified: { name: 'payload-recovery-qualified-candidate', file: 'qualified-candidate.json' },
  report: { name: 'payload-preauthority-recovery-report', file: 'payload-preauthority-recovery-report.json' },
});
const requiredSteps = Object.freeze([
  'Build production images',
  'Test editorial admin session v2 against disposable PostgreSQL and Firebase Auth',
  'Scan API image', 'Scan cron image', 'Scan CMS image',
  'Reject high or critical production dependency vulnerabilities', 'Generate SPDX SBOMs',
  'Publish immutable images', 'Publish CMS immutable image',
  'Run disposable four-store preauthority recovery on published digests',
  'Create recovery-qualified candidate manifest',
]);
const reservedPaths = new Set(['.ci-commit', '.ci-images', '.image-env', '.ci-candidate.json', '.ci-qualification.json',
  '.ci-recovery-report.json', '.ci-provenance.json', 'package-receipt.json']);
const numericId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value);
const apiId = value => Number.isSafeInteger(value) && value > 0 ? String(value) : '';
const repositoryMatches = value => typeof value === 'string' && value.toLowerCase() === CANDIDATE_REPOSITORY.toLowerCase();
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

export function validatePackageRequest(request) {
  if (!request || !repositoryMatches(request.repository)) reject('untrusted_candidate_repository');
  validateRunIdentity({ commit: request.commit, runId: request.runId, runAttempt: request.runAttempt });
  if (!request.artifactIds || Object.keys(request.artifactIds).sort().join(',') !== 'candidate,qualified,report' ||
      Object.values(request.artifactIds).some(value => !numericId(value)) || new Set(Object.values(request.artifactIds)).size !== 3) {
    reject('invalid_candidate_artifact_ids');
  }
  if (Object.keys(request).some(key => !['repository', 'commit', 'runId', 'runAttempt', 'artifactIds'].includes(key))) {
    reject('untrusted_package_inputs');
  }
}

// Only metadata fetched by authenticatedGithubCandidate may cross the production
// CLI boundary. This pure validator is exported for offline adversarial tests;
// satisfying its shape alone does NOT authenticate a caller-supplied JSON file.
export function validateGithubRun(request, { repository, workflow, run, jobs }) {
  validatePackageRequest(request);
  if (!repositoryMatches(repository?.full_name) || repository.fork !== false || !apiId(repository.id) ||
      !repositoryMatches(run?.repository?.full_name) || run.repository.id !== repository.id ||
      !repositoryMatches(run?.head_repository?.full_name) || run.head_repository.id !== repository.id) {
    reject('github_repository_binding_mismatch');
  }
  if (workflow?.path !== CANDIDATE_WORKFLOW || !apiId(workflow.id) || run.workflow_id !== workflow.id ||
      run.path !== CANDIDATE_WORKFLOW) reject('github_workflow_binding_mismatch');
  if (apiId(run.id) !== request.runId || apiId(run.run_attempt) !== request.runAttempt || run.head_sha !== request.commit ||
      run.event !== 'workflow_dispatch' || typeof run.head_branch !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,240}$/u.test(run.head_branch) || run.head_branch.includes('..') ||
      run.status !== 'completed' || run.conclusion !== 'success') reject('github_run_not_qualified');
  if (!Array.isArray(jobs)) reject('invalid_github_jobs');
  const validateJobs = jobs.filter(job => job.name === 'validate');
  const deployJobs = jobs.filter(job => job.name === 'Deploy production');
  if (validateJobs.length !== 1 || deployJobs.length !== 1 || deployJobs[0].conclusion !== 'skipped' ||
      jobs.some(job => job.name !== 'validate' && job.name !== 'Deploy production')) reject('unexpected_candidate_jobs');
  const job = validateJobs[0];
  if (job.status !== 'completed' || job.conclusion !== 'success' || job.head_sha !== request.commit ||
      apiId(job.run_id) !== request.runId || apiId(job.run_attempt) !== request.runAttempt || !Array.isArray(job.steps)) {
    reject('github_validation_job_not_passed');
  }
  for (const name of requiredSteps) {
    const steps = job.steps.filter(step => step.name === name);
    if (steps.length !== 1 || steps[0].status !== 'completed' || steps[0].conclusion !== 'success') {
      reject('github_candidate_gate_not_passed');
    }
  }
  const start = Date.parse(job.started_at); const end = Date.parse(job.completed_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) reject('invalid_github_attempt_window');
  return { repositoryId: repository.id, workflowId: workflow.id, start, end };
}

export function validateGithubArtifact(request, role, artifact, trust) {
  const definition = artifactDefinitions[role];
  const created = Date.parse(artifact?.created_at);
  if (!definition || apiId(artifact?.id) !== request.artifactIds[role] || artifact.name !== definition.name ||
      artifact.expired !== false || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 ||
      artifact.size_in_bytes > maxZipBytes || !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest || '') ||
      apiId(artifact.workflow_run?.id) !== request.runId || artifact.workflow_run.head_sha !== request.commit ||
      artifact.workflow_run.repository_id !== trust.repositoryId || artifact.workflow_run.head_repository_id !== trust.repositoryId ||
      !Number.isFinite(created) || created < trust.start || created > trust.end) reject('github_artifact_binding_mismatch');
}

async function boundedBody(response, limit) {
  if (!response.body) reject('github_response_unavailable');
  const chunks = []; let length = 0;
  try {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > limit) reject('github_response_limit_exceeded');
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    if (error.message === 'github_response_limit_exceeded') throw error;
    reject('github_response_read_failed');
  }
  return Buffer.concat(chunks);
}

function safeDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { reject('unsafe_artifact_download_redirect'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !['.blob.core.windows.net', '.githubusercontent.com'].some(suffix => url.hostname.endsWith(suffix))) {
    reject('unsafe_artifact_download_redirect');
  }
  return url.href;
}

export async function authenticatedGithubCandidate(request, { token, fetchImpl = fetch } = {}) {
  validatePackageRequest(request);
  if (typeof token !== 'string' || !token.trim() || /\s/u.test(token)) reject('github_authentication_required');
  const prefix = `https://api.github.com/repos/${CANDIDATE_REPOSITORY}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ownerinc-candidate-packager' };
  const requestApi = async route => {
    let response;
    try { response = await fetchImpl(`${prefix}${route}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(30_000) }); }
    catch { reject('github_request_failed'); }
    return response;
  };
  const json = async route => {
    const response = await requestApi(route);
    if (response.status !== 200) reject('github_api_request_rejected');
    return parseEvidenceJson(await boundedBody(response, 1024 * 1024));
  };
  const repository = await json('');
  const workflow = await json('/actions/workflows/ci.yml');
  const run = await json(`/actions/runs/${request.runId}/attempts/${request.runAttempt}`);
  const jobs = [];
  for (let page = 1; page <= 10; page++) {
    const response = await json(`/actions/runs/${request.runId}/attempts/${request.runAttempt}/jobs?per_page=100&page=${page}`);
    if (!Array.isArray(response.jobs) || response.jobs.length > 100) reject('invalid_github_jobs');
    jobs.push(...response.jobs);
    if (response.jobs.length < 100) break;
    if (page === 10) reject('github_jobs_limit_exceeded');
  }
  const trust = validateGithubRun(request, { repository, workflow, run, jobs });
  const commit = await json(`/git/commits/${request.commit}`);
  if (commit.sha !== request.commit || !/^[0-9a-f]{40}$/u.test(commit.tree?.sha || '')) reject('github_source_binding_mismatch');
  const artifacts = {}; const evidence = {};
  for (const role of ['candidate', 'qualified', 'report']) {
    const artifact = await json(`/actions/artifacts/${request.artifactIds[role]}`);
    validateGithubArtifact(request, role, artifact, trust);
    let response = await requestApi(`/actions/artifacts/${request.artifactIds[role]}/zip`);
    if (response.status !== 302) reject('github_artifact_download_not_redirected');
    const location = safeDownloadUrl(response.headers.get('location'));
    // Never forward the GitHub credential to the signed storage URL.
    try { response = await fetchImpl(location, { redirect: 'manual', signal: AbortSignal.timeout(30_000) }); }
    catch { reject('github_artifact_download_failed'); }
    if (response.status !== 200) reject('github_artifact_download_failed');
    const zipBytes = await boundedBody(response, maxZipBytes);
    if (`sha256:${sha256(zipBytes)}` !== artifact.digest || zipBytes.length !== artifact.size_in_bytes) {
      reject('github_artifact_digest_mismatch');
    }
    evidence[`${role}Bytes`] = readSingleArtifactZip(zipBytes, artifactDefinitions[role].file);
    artifacts[role] = { id: request.artifactIds[role], name: artifact.name, digest: artifact.digest,
      createdAt: artifact.created_at, sizeInBytes: artifact.size_in_bytes };
  }
  const candidate = parseEvidenceJson(evidence.candidateBytes);
  const expectedRun = { commit: request.commit, runId: request.runId, runAttempt: request.runAttempt };
  const qualified = validateQualifiedCandidate({ ...evidence, expectedRun, expectedImages: candidate.images });
  return { evidence, qualified, treeSha: commit.tree.sha, provenance: {
    schemaVersion: 1, kind: 'github-api-verified-candidate-package', deploymentAuthorized: false,
    repository: CANDIDATE_REPOSITORY, repositoryId: trust.repositoryId,
    workflow: CANDIDATE_WORKFLOW, workflowId: trust.workflowId, ...expectedRun,
    qualificationContract: qualified.qualificationContract, images: qualified.images,
    artifacts, candidateSha256: sha256(evidence.candidateBytes),
    qualifiedManifestSha256: sha256(evidence.qualifiedBytes), recoveryReportSha256: sha256(evidence.reportBytes),
    sourceTreeSha: commit.tree.sha,
  } };
}

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Artifact downloads are never extracted to disk. Accept one ordinary, bounded
// JSON entry only; use the central-directory sizes (data descriptors are allowed).
export function readSingleArtifactZip(zip, filename) {
  if (!Buffer.isBuffer(zip) || zip.length < 22 || zip.length > maxZipBytes) reject('invalid_artifact_zip');
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 65557); at--) {
    if (zip.readUInt32LE(at) === 0x06054b50 && at + 22 + zip.readUInt16LE(at + 20) === zip.length) { end = at; break; }
  }
  if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) ||
      zip.readUInt16LE(end + 8) !== 1 || zip.readUInt16LE(end + 10) !== 1) reject('invalid_artifact_zip');
  const centralSize = zip.readUInt32LE(end + 12); const at = zip.readUInt32LE(end + 16);
  if (at + centralSize !== end || centralSize < 46 || zip.readUInt32LE(at) !== 0x02014b50) reject('invalid_artifact_zip');
  const flags = zip.readUInt16LE(at + 8); const method = zip.readUInt16LE(at + 10);
  const compressedSize = zip.readUInt32LE(at + 20); const size = zip.readUInt32LE(at + 24);
  const nameSize = zip.readUInt16LE(at + 28); const extraSize = zip.readUInt16LE(at + 30); const commentSize = zip.readUInt16LE(at + 32);
  const local = zip.readUInt32LE(at + 42); const mode = zip.readUInt32LE(at + 38) >>> 16;
  if (46 + nameSize + extraSize + commentSize !== centralSize || zip.readUInt16LE(at + 34) ||
      flags & ~0x0808 || ![0, 8].includes(method) || size < 1 || size > 1024 * 1024 ||
      compressedSize > maxZipBytes || ![0, 0x8000].includes(mode & 0xf000) ||
      zip.subarray(at + 46, at + 46 + nameSize).toString('utf8') !== filename || local + 30 > at ||
      zip.readUInt32LE(local) !== 0x04034b50) reject('unsafe_artifact_zip_entry');
  const localNameSize = zip.readUInt16LE(local + 26); const localExtraSize = zip.readUInt16LE(local + 28);
  const start = local + 30 + localNameSize + localExtraSize;
  if (zip.readUInt16LE(local + 6) !== flags || zip.readUInt16LE(local + 8) !== method ||
      start + compressedSize > at || zip.subarray(local + 30, local + 30 + localNameSize).toString('utf8') !== filename) {
    reject('invalid_artifact_zip');
  }
  let bytes;
  try { bytes = method === 0 ? zip.subarray(start, start + compressedSize)
    : inflateRawSync(zip.subarray(start, start + compressedSize), { maxOutputLength: 1024 * 1024 }); }
  catch { reject('invalid_artifact_zip'); }
  if (bytes.length !== size || crc32(bytes) !== zip.readUInt32LE(at + 16)) reject('invalid_artifact_zip');
  return Buffer.from(bytes);
}

function safeSourcePath(name) {
  if (!name || name.includes('\\') || /[\x00-\x1f\x7f]/u.test(name) || name.startsWith('/') || /^[A-Za-z]:/u.test(name) ||
      name.split('/').some((part, index, parts) => part === '..' || part === '.' || (!part && index !== parts.length - 1))) {
    reject('unsafe_source_archive_path');
  }
  const parts = name.replace(/\/$/u, '').split('/');
  if (parts.some(part => ['.git', 'node_modules', '__pycache__', 'ownerinc-novo-agente'].includes(part)) ||
      parts.some(part => /^(?:\.env(?:\..*)?|env\.json|state\.json|compose\.env|.*\.(?:pem|key|p12|pfx|dump))$/iu.test(part) && part !== '.env.example') ||
      reservedPaths.has(name)) reject('private_or_reserved_source_path');
}

function tarNumber(header, offset, length) {
  const text = header.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/su, '').trim();
  if (text && !/^[0-7]+$/u.test(text)) reject('invalid_source_tar');
  const value = parseInt(text || '0', 8);
  if (!Number.isSafeInteger(value) || value < 0) reject('invalid_source_tar');
  return value;
}
const tarString = (header, offset, length) => header.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/su, '');

// Only this complete public-template assignment is not key material. Do not
// exempt .env.example itself or match just the marker/body substring. This changes
// the scan view only: the archive and tree/blob comparison retain original bytes.
const publicFirebaseTemplateLine = `FIREBASE_PRIVATE_KEY="${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\\nSUA_CHAVE_AQUI\\n${['-----END', 'PRIVATE KEY-----'].join(' ')}\\n"`;
function sourceSecretScanText(name, content) {
  const text = content.toString('utf8');
  if (name !== '.env.example') return text;
  const lines = text.split('\n');
  const templateIndexes = lines.flatMap((line, index) =>
    line === publicFirebaseTemplateLine || line === `${publicFirebaseTemplateLine}\r` ? [index] : []);
  if (templateIndexes.length !== 1) return text;
  lines[templateIndexes[0]] = '';
  return lines.join('\n');
}

function paxFields(bytes) {
  const fields = {}; let at = 0;
  while (at < bytes.length) {
    const space = bytes.indexOf(32, at);
    const sizeText = bytes.subarray(at, space).toString('ascii');
    if (space < at || !/^[1-9][0-9]*$/u.test(sizeText)) reject('invalid_source_tar_pax');
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size <= space - at + 2 || at + size > bytes.length || bytes[at + size - 1] !== 10) reject('invalid_source_tar_pax');
    const entry = bytes.subarray(space + 1, at + size - 1).toString('utf8'); const equals = entry.indexOf('=');
    if (equals < 1 || Object.hasOwn(fields, entry.slice(0, equals))) reject('invalid_source_tar_pax');
    fields[entry.slice(0, equals)] = entry.slice(equals + 1); at += size;
  }
  return fields;
}

export function inspectSourceArchive(archive, commit) {
  if (!Buffer.isBuffer(archive) || archive.length < 1024 || archive.length > maxSourceBytes || archive.length % 512) reject('invalid_source_tar');
  const entries = []; const seen = new Set(); let at = 0; let pendingPath = null; let foundCommit = false;
  while (at + 512 <= archive.length) {
    const header = archive.subarray(at, at + 512);
    if (header.every(byte => byte === 0)) {
      if (pendingPath || archive.length - at < 1024 || !archive.subarray(at).every(byte => byte === 0) || !foundCommit) reject('invalid_source_tar');
      return { entries, endOffset: at };
    }
    const expectedChecksum = tarNumber(header, 148, 8);
    const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (expectedChecksum !== actualChecksum) reject('invalid_source_tar');
    if (header.subarray(257, 263).toString('ascii') !== 'ustar\0' || header.subarray(263, 265).toString('ascii') !== '00') reject('invalid_source_tar');
    const size = tarNumber(header, 124, 12); const mode = tarNumber(header, 100, 8);
    const type = header[156] ? String.fromCharCode(header[156]) : '0';
    const prefix = tarString(header, 345, 155); const rawName = `${prefix ? `${prefix}/` : ''}${tarString(header, 0, 100)}`;
    const start = at + 512; const next = start + Math.ceil(size / 512) * 512;
    if (next > archive.length) reject('invalid_source_tar');
    const content = archive.subarray(start, start + size);
    if (type === 'g' || type === 'x') {
      safeSourcePath(rawName);
      const fields = paxFields(content);
      if (type === 'g') {
        if (foundCommit || Object.keys(fields).join(',') !== 'comment' || fields.comment !== commit) reject('source_commit_mismatch');
        foundCommit = true;
      } else {
        if (pendingPath || Object.keys(fields).some(key => !['path', 'mtime'].includes(key)) || !fields.path) reject('invalid_source_tar_pax');
        pendingPath = fields.path; safeSourcePath(pendingPath);
      }
    } else {
      const name = pendingPath || rawName; pendingPath = null;
      safeSourcePath(rawName); safeSourcePath(name);
      if (!['0', '5'].includes(type) || tarString(header, 157, 100) || mode & 0o7000 ||
          (type === '5' && size !== 0) || seen.has(name.replace(/\/$/u, ''))) reject('unsafe_source_tar_entry');
      seen.add(name.replace(/\/$/u, ''));
      if (type === '0') {
        const text = sourceSecretScanText(name, content);
        if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|SENDGRID_API_KEY=SG\.[A-Za-z0-9_-]{10,}|SMTP_PASSWORD=re_[A-Za-z0-9_-]{10,}|(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/u.test(text)) {
          reject('source_archive_secret_detected');
        }
      }
      entries.push({ name, type, mode, bytes: content });
    }
    at = next;
  }
  reject('invalid_source_tar');
}

export function tarFile(name, bytes) {
  if (!Buffer.isBuffer(bytes) || Buffer.byteLength(name) > 100) reject('invalid_package_tar_entry');
  const header = Buffer.alloc(512);
  header.write(name); header.write('0000600\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124); header.write('00000000000\0', 136);
  header.fill(32, 148, 156); header[156] = 48; header.write('ustar\0', 257); header.write('00', 263);
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

export function assembleCandidatePackage(sourceArchive, authenticated) {
  const { entries, endOffset } = inspectSourceArchive(sourceArchive, authenticated.qualified.commit);
  for (const required of ['docker-compose.yml', 'docker-compose.payload.yml', 'public/index.html', 'nginx/nginx.conf', 'api/db/migrate.js']) {
    if (!entries.some(entry => entry.type === '0' && entry.name === required)) reject('incomplete_candidate_source');
  }
  const provenance = { ...authenticated.provenance, sourceArchiveSha256: sha256(sourceArchive), sourceArchiveBytes: sourceArchive.length };
  const files = {
    '.ci-commit': Buffer.from(authenticated.qualified.commit),
    '.ci-images': Buffer.from(['api', 'cron', 'cms'].map(service => authenticated.qualified.images[service]).join('\n') + '\n'),
    '.ci-candidate.json': authenticated.evidence.candidateBytes,
    '.ci-qualification.json': authenticated.evidence.qualifiedBytes,
    '.ci-recovery-report.json': authenticated.evidence.reportBytes,
    '.ci-provenance.json': jsonBytes(provenance),
  };
  const tar = Buffer.concat([sourceArchive.subarray(0, endOffset), ...Object.entries(files).map(([name, bytes]) => tarFile(name, bytes)), Buffer.alloc(1024)]);
  const archive = gzipSync(tar, { level: 9 });
  if (archive.length > maxReleaseBytes) reject('candidate_release_archive_limit_exceeded');
  return { archive, receipt: { ...provenance, archiveFile: 'payload-candidate.tar.gz', archiveSha256: sha256(archive), archiveBytes: archive.length } };
}

function exactGitSource(checkout, commit, treeSha) {
  // No shell, worktree data, replace refs, ambient git endpoint/config overrides
  // or inherited GIT_* environment. Only the immutable, API-confirmed tree is used.
  const env = Object.fromEntries(['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP']
    .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const git = args => execFileSync('git', ['--no-replace-objects', '-c', 'tar.umask=0022',
    '-c', 'core.attributesFile=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'), ...args],
    { cwd: checkout, env, timeout: 60_000, maxBuffer: maxSourceBytes, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    // Verify object contents as well as ref names; a corrupt local object store
    // must not masquerade as the GitHub-confirmed tree by retaining old filenames.
    git(['fsck', '--strict', '--no-reflogs', commit]);
    if (git(['rev-parse', '--verify', `${commit}^{commit}`]).toString('utf8').trim() !== commit ||
        git(['rev-parse', '--verify', `${commit}^{tree}`]).toString('utf8').trim() !== treeSha) reject('local_source_binding_mismatch');
    const archive = git(['archive', '--format=tar', commit, '--', '.', ':(exclude)ownerinc-novo-agente/**']);
    const expected = new Map();
    for (const record of git(['ls-tree', '-r', '-z', '--full-tree', commit]).toString('utf8').split('\0').filter(Boolean)) {
      const match = record.match(/^(100644|100755) blob ([0-9a-f]{40})\t([^\x00]+)$/u);
      const name = record.slice(record.indexOf('\t') + 1);
      if (name === 'ownerinc-novo-agente' || name.startsWith('ownerinc-novo-agente/')) continue;
      if (!match) reject('unsupported_source_tree_entry');
      expected.set(match[3], { hash: match[2], mode: match[1] === '100755' ? 0o755 : 0o644 });
    }
    const observed = inspectSourceArchive(archive, commit).entries.filter(entry => entry.type === '0');
    if (observed.length !== expected.size || observed.some(entry => {
      const hash = createHash('sha1').update(Buffer.from(`blob ${entry.bytes.length}\0`)).update(entry.bytes).digest('hex');
      return expected.get(entry.name)?.hash !== hash || expected.get(entry.name)?.mode !== entry.mode;
    })) reject('source_archive_tree_mismatch');
    return archive;
  } catch (error) {
    if (['local_source_binding_mismatch', 'unsupported_source_tree_entry', 'source_archive_tree_mismatch',
      'private_or_reserved_source_path', 'source_archive_secret_detected'].includes(error.message)) throw error;
    reject('exact_git_archive_failed');
  }
}

export async function packageCandidate(request, { checkout, output, token, fetchImpl = fetch } = {}) {
  if (!path.isAbsolute(checkout || '') || !path.isAbsolute(output || '') || path.resolve(output) !== output ||
      await realpath(checkout) !== checkout || await realpath(path.dirname(output)) !== path.dirname(output)) reject('unsafe_package_paths');
  const authenticated = await authenticatedGithubCandidate(request, { token, fetchImpl });
  const source = exactGitSource(checkout, request.commit, authenticated.treeSha);
  const result = assembleCandidatePackage(source, authenticated);
  // An exclusive output directory prevents overwriting any user's evidence. No
  // extracted archive member is ever used as a filesystem path by this tool.
  await mkdir(output, { mode: 0o700 });
  await writeFile(path.join(output, 'payload-candidate.tar.gz'), result.archive, { flag: 'wx', mode: 0o600 });
  await writeFile(path.join(output, 'package-receipt.json'), jsonBytes(result.receipt), { flag: 'wx', mode: 0o600 });
  return result.receipt;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const values = {}; const flags = ['--repository', '--commit', '--run-id', '--run-attempt', '--candidate-artifact-id',
    '--qualified-artifact-id', '--report-artifact-id', '--checkout', '--output'];
  for (let index = 0; index < args.length; index += 2) {
    if (!flags.includes(args[index]) || Object.hasOwn(values, args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) reject('invalid_package_arguments');
    values[args[index]] = args[index + 1];
  }
  if (flags.filter(flag => flag !== '--repository').some(flag => !values[flag])) reject('invalid_package_arguments');
  return packageCandidate({ repository: values['--repository'] || CANDIDATE_REPOSITORY,
    commit: values['--commit'], runId: values['--run-id'], runAttempt: values['--run-attempt'],
    artifactIds: { candidate: values['--candidate-artifact-id'], qualified: values['--qualified-artifact-id'], report: values['--report-artifact-id'] },
  }, { checkout: values['--checkout'], output: values['--output'], token: env.GH_TOKEN || env.GITHUB_TOKEN });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(receipt => console.log(JSON.stringify(receipt))).catch(() => {
    // Never serialize tokens, signed download URLs, upstream bodies or git stderr.
    console.error('Candidate packaging failed closed; authenticated artifacts and exact source are required.'); process.exitCode = 1;
  });
}
