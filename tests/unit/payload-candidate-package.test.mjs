import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync, gunzipSync } from 'node:zlib';
import { RECOVERY_CHECKS, RECOVERY_NEGATIVES, qualifyCandidate, sha256 } from '../../scripts/lib/payload-candidate-qualification.mjs';
import {
  CANDIDATE_REPOSITORY, assembleCandidatePackage, authenticatedGithubCandidate, crc32,
  inspectSourceArchive, main, packageCandidate, readSingleArtifactZip, tarFile,
  validateGithubArtifact, validateGithubRun, validatePackageRequest,
} from '../../scripts/package-payload-candidate.mjs';

const bytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const steps = ['Build production images', 'Test editorial admin session v2 against disposable PostgreSQL and Firebase Auth',
  'Scan API image', 'Scan cron image', 'Scan CMS image', 'Reject high or critical production dependency vulnerabilities',
  'Generate SPDX SBOMs', 'Publish immutable images', 'Publish CMS immutable image',
  'Run disposable four-store preauthority recovery on published digests', 'Create recovery-qualified candidate manifest'];

function zipFile(name, content, { method = 8, mode = 0o100600 } = {}) {
  const nameBytes = Buffer.from(name); const compressed = method === 0 ? content : deflateRawSync(content);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8); local.writeUInt32LE(crc32(content), 14); local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(content.length, 22); local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4);
  central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc32(content), 16);
  central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE((mode << 16) >>> 0, 38);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBytes.length, 12); end.writeUInt32LE(local.length + nameBytes.length + compressed.length, 16);
  return Buffer.concat([local, nameBytes, compressed, central, nameBytes, end]);
}
function fixture(commit = 'a'.repeat(40), treeSha = 'e'.repeat(40)) {
  const request = { repository: CANDIDATE_REPOSITORY, commit, runId: '12345678901', runAttempt: '2',
    artifactIds: { candidate: '111', qualified: '112', report: '113' } };
  const expectedRun = { commit, runId: request.runId, runAttempt: request.runAttempt };
  const expectedImages = Object.fromEntries(['api', 'cron', 'cms'].map((role, index) =>
    [role, `ghcr.io/ownerinc/ownerinc-portal-${role}@sha256:${String(index + 1).repeat(64)}`]));
  const candidateBytes = bytes({ schemaVersion: 1, ...expectedRun, images: expectedImages });
  const reportBytes = bytes({ schemaVersion: 1, status: 'passed', run: expectedRun, images: expectedImages,
    sourceInventoryIdentity: 'b'.repeat(64), targetInventoryIdentity: 'c'.repeat(64),
    checks: Object.fromEntries(RECOVERY_CHECKS.map(key => [key, true])),
    negativeCases: RECOVERY_NEGATIVES.map(name => ({ name, rejected: true, targetContentUnchanged: true,
      ...(['unexpected_schema', 'weak_native_constraint', 'materialized_view', 'migration_ledger_mismatch'].includes(name)
        ? { fixtureDdlCleaned: true } : name === 'target_changed_after_restore_preflight' ? { raceInjectedAfterLeaseReservation: true } : {}),
    })),
    recoveryProgress: Object.fromEntries(['source', 'target', 'leaseTarget'].map(key =>
      [key, { initialCmsHealthPassed: true, writersRestartedHealthy: true, quiescentSnapshotComparison: 'passed' }])),
    restoreAcceptanceProgress: Object.fromEntries(['first', 'second'].map(key =>
      [key, { coordinatorReturnedSuccessfully: true, fullSnapshotComparisonPassed: true }])),
    evidence: { kind: 'redacted-metadata-only', privateFixtureRetainedForRunnerLifetime: false },
  });
  const qualifiedBytes = bytes(qualifyCandidate({ candidateBytes, reportBytes, expectedRun, expectedImages }));
  const repository = { id: 7, full_name: CANDIDATE_REPOSITORY, fork: false };
  const workflow = { id: 8, path: '.github/workflows/ci.yml' };
  const run = { id: Number(request.runId), run_attempt: 2, workflow_id: 8, path: workflow.path,
    repository, head_repository: repository, head_sha: commit, head_branch: 'feat/payload-cms-final',
    event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
  const jobs = [{ name: 'validate', run_id: run.id, run_attempt: 2, head_sha: commit, status: 'completed', conclusion: 'success',
    started_at: '2026-10-09T10:00:00Z', completed_at: '2026-10-09T11:00:00Z',
    steps: steps.map(name => ({ name, status: 'completed', conclusion: 'success' })),
  }, { name: 'Deploy production', status: 'completed', conclusion: 'skipped' }];
  const zips = { candidate: zipFile('candidate.json', candidateBytes), qualified: zipFile('qualified-candidate.json', qualifiedBytes),
    report: zipFile('payload-preauthority-recovery-report.json', reportBytes) };
  const names = { candidate: 'payload-release-candidate', qualified: 'payload-recovery-qualified-candidate', report: 'payload-preauthority-recovery-report' };
  const artifacts = Object.fromEntries(Object.keys(zips).map(role => [role, {
    id: Number(request.artifactIds[role]), name: names[role], expired: false, size_in_bytes: zips[role].length,
    digest: `sha256:${sha256(zips[role])}`, created_at: '2026-10-09T10:50:00Z',
    workflow_run: { id: run.id, repository_id: 7, head_repository_id: 7, head_sha: commit },
  }]));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('https://fixture.blob.core.windows.net/')) {
      assert.equal(options.headers, undefined, 'GitHub token must never be sent to storage');
      return new Response(zips[url.split('/').at(-1)], { status: 200 });
    }
    assert.equal(options.headers.Authorization, 'Bearer fixture-test-token');
    assert.equal(options.redirect, 'manual');
    const base = `https://api.github.com/repos/${CANDIDATE_REPOSITORY}`;
    assert.ok(url.startsWith(base));
    const route = url.slice(base.length);
    let value;
    if (route === '') value = repository;
    else if (route === '/actions/workflows/ci.yml') value = workflow;
    else if (route === `/actions/runs/${request.runId}/attempts/2`) value = run;
    else if (route === `/actions/runs/${request.runId}/attempts/2/jobs?per_page=100&page=1`) value = { jobs };
    else if (route === `/git/commits/${commit}`) value = { sha: commit, tree: { sha: treeSha } };
    else {
      const role = Object.keys(artifacts).find(key => route === `/actions/artifacts/${request.artifactIds[key]}` ||
        route === `/actions/artifacts/${request.artifactIds[key]}/zip`);
      assert.ok(role, `unexpected fixture API route: ${route}`);
      if (route.endsWith('/zip')) return new Response(null, { status: 302, headers: { location: `https://fixture.blob.core.windows.net/${role}` } });
      value = artifacts[role];
    }
    return new Response(bytes(value), { status: 200 });
  };
  return { request, repository, workflow, run, jobs, artifacts, zips, calls, fetchImpl, token: 'fixture-test-token' };
}

test('authenticated API selection binds repo/workflow/SHA/run/attempt/exact artifact IDs and bytes', async () => {
  const f = fixture(); const result = await authenticatedGithubCandidate(f.request, f);
  assert.equal(result.qualified.commit, f.request.commit);
  assert.equal(result.provenance.deploymentAuthorized, false);
  assert.equal(result.provenance.artifacts.qualified.id, '112');
  assert.equal(result.provenance.recoveryReportSha256, sha256(result.evidence.reportBytes));
  assert.equal(f.calls.filter(call => call.url.includes('/attempts/2')).length, 2);
  assert.equal(f.calls.filter(call => call.url.endsWith('/zip')).length, 3);
});

for (const [name, mutate] of [
  ['different repo', f => { f.run.repository = { id: 9, full_name: 'other/portal_ownerinc' }; }],
  ['fork producer', f => { f.repository.fork = true; }],
  ['different workflow', f => { f.run.workflow_id = 99; }],
  ['different workflow path', f => { f.run.path = '.github/workflows/untrusted.yml'; }],
  ['different head SHA', f => { f.run.head_sha = 'b'.repeat(40); }],
  ['different attempt', f => { f.run.run_attempt = 1; }],
  ['failed run', f => { f.run.conclusion = 'failure'; }],
  ['cancelled run', f => { f.run.conclusion = 'cancelled'; }],
  ['running run', f => { f.run.status = 'in_progress'; }],
  ['push event', f => { f.run.event = 'push'; }],
  ['missing gate', f => { f.jobs[0].steps.pop(); }],
  ['false scan', f => { f.jobs[0].steps.find(step => step.name === 'Scan CMS image').conclusion = 'failure'; }],
  ['duplicate gate', f => { f.jobs[0].steps.push(f.jobs[0].steps[0]); }],
  ['wrong validation attempt', f => { f.jobs[0].run_attempt = 1; }],
  ['deploy not skipped', f => { f.jobs[1].conclusion = 'success'; }],
  ['unexpected job', f => { f.jobs.push({ name: 'untrusted' }); }],
]) test(`authenticated packaging rejects ${name} before artifact downloads`, async () => {
  const f = fixture(); mutate(f);
  await assert.rejects(authenticatedGithubCandidate(f.request, f));
  assert.equal(f.calls.some(call => call.url.includes('/actions/artifacts/')), false);
});
for (const [name, mutate] of [
  ['wrong id', f => { f.artifacts.qualified.id = 999; }],
  ['wrong name', f => { f.artifacts.qualified.name = 'payload-release-candidate'; }],
  ['wrong run', f => { f.artifacts.qualified.workflow_run.id = 999; }],
  ['wrong head repo', f => { f.artifacts.qualified.workflow_run.head_repository_id = 99; }],
  ['wrong SHA', f => { f.artifacts.qualified.workflow_run.head_sha = 'b'.repeat(40); }],
  ['old attempt window', f => { f.artifacts.qualified.created_at = '2026-10-09T09:50:00Z'; }],
  ['expired', f => { f.artifacts.qualified.expired = true; }],
  ['missing digest', f => { delete f.artifacts.qualified.digest; }],
  ['tampered archive', f => { f.zips.qualified = Buffer.from(f.zips.qualified); f.zips.qualified[45] ^= 1; }],
]) test(`authenticated packaging rejects artifact ${name}`, async () => {
  const f = fixture(); mutate(f); await assert.rejects(authenticatedGithubCandidate(f.request, f));
});
test('offline fabricated metadata is not an accepted CLI input or authentication substitute', async () => {
  const f = fixture();
  assert.throws(() => validatePackageRequest({ ...f.request, trusted: true }), /untrusted_package_inputs/u);
  await assert.rejects(authenticatedGithubCandidate(f.request, { fetchImpl: f.fetchImpl }), /authentication_required/u);
  await assert.rejects(main(['--trusted-json', 'fabricated.json']), /invalid_package_arguments/u);
  assert.throws(() => validatePackageRequest({ ...f.request, repository: 'attacker/portal_ownerinc' }), /untrusted_candidate_repository/u);
  assert.throws(() => validatePackageRequest({ ...f.request, artifactIds: { candidate: '111', report: '111', qualified: '112' } }));
  const trust = validateGithubRun(f.request, f);
  assert.throws(() => validateGithubArtifact(f.request, 'qualified', { ...f.artifacts.qualified, expired: true }, trust));
});
test('authenticated artifact transport still rejects a fabricated qualification or failed report with consistent ZIP hashes', async () => {
  for (const role of ['qualified', 'report']) {
    const f = fixture();
    const filename = role === 'qualified' ? 'qualified-candidate.json' : 'payload-preauthority-recovery-report.json';
    const value = JSON.parse(readSingleArtifactZip(f.zips[role], filename));
    if (role === 'qualified') value.qualificationContract = 'fabricated-contract'; else value.status = 'failed';
    f.zips[role] = zipFile(filename, bytes(value));
    f.artifacts[role].digest = `sha256:${sha256(f.zips[role])}`;
    f.artifacts[role].size_in_bytes = f.zips[role].length;
    await assert.rejects(authenticatedGithubCandidate(f.request, f));
  }
});
test('authentication failures, JSON redirects and oversized API bodies fail closed', async () => {
  for (const response of [new Response('private upstream error', { status: 401 }),
    new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
    new Response(Buffer.alloc(1024 * 1024 + 1), { status: 200 })]) {
    const f = fixture();
    await assert.rejects(authenticatedGithubCandidate(f.request, { token: f.token, fetchImpl: async () => response }));
  }
});
test('signed storage redirect is restricted and never inherits credentials', async () => {
  for (const location of ['http://fixture.blob.core.windows.net/file', 'https://evil.example/file',
    'https://api.github.com/file', 'https://user:password@fixture.blob.core.windows.net/file',
    'https://fixture.blob.core.windows.net:444/file']) {
    const f = fixture(); const original = f.fetchImpl;
    f.fetchImpl = async (url, options) => url.endsWith('/zip') ? new Response(null, { status: 302, headers: { location } }) : original(url, options);
    await assert.rejects(authenticatedGithubCandidate(f.request, f), /unsafe_artifact_download_redirect/u);
  }
});
test('artifact ZIP traversal, links, CRC failure, bomb and extra entries fail without extraction', () => {
  const content = Buffer.from('{"test":true}');
  for (const method of [0, 8]) assert.deepEqual(readSingleArtifactZip(zipFile('candidate.json', content, { method }), 'candidate.json'), content);
  for (const name of ['../candidate.json', '/candidate.json', 'sub/candidate.json', 'candidate.json\0']) {
    assert.throws(() => readSingleArtifactZip(zipFile(name, content), 'candidate.json'));
  }
  assert.throws(() => readSingleArtifactZip(zipFile('candidate.json', content, { mode: 0o120777 }), 'candidate.json'));
  const corrupted = zipFile('candidate.json', content, { method: 0 }); corrupted[30 + Buffer.byteLength('candidate.json')] ^= 1;
  assert.throws(() => readSingleArtifactZip(corrupted, 'candidate.json'));
  const multiple = zipFile('candidate.json', content); multiple.writeUInt16LE(2, multiple.length - 22 + 10);
  assert.throws(() => readSingleArtifactZip(multiple, 'candidate.json'));
  assert.throws(() => readSingleArtifactZip(zipFile('candidate.json', Buffer.alloc(1024 * 1024 + 1)), 'candidate.json'));
});

function sourceTar(commit, extra = []) {
  const entry = `comment=${commit}\n`; let length = Buffer.byteLength(entry) + 3;
  while (Buffer.byteLength(`${length} ${entry}`) !== length) length = Buffer.byteLength(`${length} ${entry}`);
  const pax = tarFile('pax_global_header', Buffer.from(`${length} ${entry}`));
  pax[156] = 'g'.charCodeAt(0); checksum(pax);
  const required = ['docker-compose.yml', 'docker-compose.payload.yml', 'public/index.html', 'nginx/nginx.conf', 'api/db/migrate.js'];
  return Buffer.concat([pax, ...required.map(name => tarFile(name, Buffer.from('synthetic source'))), ...extra, Buffer.alloc(1024)]);
}
function checksum(header) {
  header.fill(32, 148, 156);
  header.write(`${header.subarray(0, 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')}\0 `, 148);
}
test('source archive requires exact git SHA, ordinary paths, no links/secrets/private paths', () => {
  const commit = 'a'.repeat(40); assert.equal(inspectSourceArchive(sourceTar(commit), commit).entries.length, 5);
  assert.throws(() => inspectSourceArchive(sourceTar(commit), 'b'.repeat(40)), /source_commit_mismatch/u);
  for (const name of ['../escape', '/escape', 'a/../escape', 'C:/escape', 'a\\escape', '.env', 'secrets/service.pem',
    'node_modules/x', '.git/config', '.ci-images', '.image-env', 'ownerinc-novo-agente/x']) {
    assert.throws(() => inspectSourceArchive(sourceTar(commit, [tarFile(name, Buffer.from('x'))]), commit));
  }
  for (const type of ['1', '2', '3', '6']) {
    const unsafe = tarFile('linked', Buffer.from('x')); unsafe[156] = type.charCodeAt(0); checksum(unsafe);
    assert.throws(() => inspectSourceArchive(sourceTar(commit, [unsafe]), commit), /unsafe_source_tar_entry/u);
  }
  const syntheticKeyMarker = ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ');
  for (const name of ['private.txt', 'private.dat', '.env.example']) {
    assert.throws(() => inspectSourceArchive(sourceTar(commit, [tarFile(name, Buffer.from(syntheticKeyMarker))]), commit), /secret_detected/u);
  }
  assert.throws(() => inspectSourceArchive(sourceTar(commit, [tarFile('docker-compose.yml', Buffer.from('duplicate'))]), commit), /unsafe_source_tar_entry/u);
});
test('actual root env example packages byte-for-byte with its exact public Firebase template', async () => {
  const envExample = await readFile(new URL('../../.env.example', import.meta.url));
  const f = fixture(); const source = sourceTar(f.request.commit, [tarFile('.env.example', envExample)]);
  const inspected = inspectSourceArchive(source, f.request.commit);
  assert.deepEqual(inspected.entries.find(entry => entry.name === '.env.example').bytes, envExample);
  const authenticated = await authenticatedGithubCandidate(f.request, f);
  const packaged = assembleCandidatePackage(source, authenticated);
  assert.equal(packaged.receipt.deploymentAuthorized, false);
  assert.equal(packaged.receipt.sourceArchiveSha256, sha256(source));
  assert.ok(gunzipSync(packaged.archive).includes(envExample), 'the scanner exception must never rewrite source bytes');
});
test('only the complete known root assignment is excepted, never arbitrary placeholder text or real key material', async () => {
  const example = (await readFile(new URL('../../.env.example', import.meta.url))).toString('utf8');
  const line = example.split('\n').find(value => value.startsWith('FIREBASE_PRIVATE_KEY='));
  assert.ok(line);
  const { privateKey } = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const keyBody = privateKey.trim().split('\n').slice(1, -1).join('');
  const variants = [
    `${example}\n${privateKey}`, // A known placeholder does not hide a surrounding real PEM.
    example.replace(line, line.replace('SUA_CHAVE_AQUI', keyBody)),
    example.replace(line, `#${line}`),
    example.replace(line, `${line} # unknown template context`),
    example.replace(line, line.replace('FIREBASE_PRIVATE_KEY=', 'OTHER_PRIVATE_KEY=')),
    example.replace(line, line.replace('SUA_CHAVE_AQUI', `SUA_CHAVE_AQUI\\n${keyBody}`)),
    `${example}\n${line}\n`, // Duplicate assignment is not the known template.
  ];
  const commit = 'a'.repeat(40);
  for (const value of variants) {
    assert.throws(() => inspectSourceArchive(sourceTar(commit, [tarFile('.env.example', Buffer.from(value))]), commit), /source_archive_secret_detected/u);
  }
  for (const name of ['nested/.env.example', 'example.txt']) {
    assert.throws(() => inspectSourceArchive(sourceTar(commit, [tarFile(name, Buffer.from(example))]), commit), /source_archive_secret_detected/u);
  }
});
test('full actual HEAD git archive passes source inspection read-only with public placeholders intact', () => {
  const cwd = new URL('../../', import.meta.url);
  const git = args => execFileSync('git', ['--no-replace-objects', '-c', 'tar.umask=0022', ...args],
    { cwd, timeout: 60_000, maxBuffer: 200 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const commit = git(['rev-parse', '--verify', 'HEAD^{commit}']).toString('utf8').trim();
  const source = git(['archive', '--format=tar', commit, '--', '.', ':(exclude)ownerinc-novo-agente/**']);
  const inspected = inspectSourceArchive(source, commit);
  const example = git(['show', `${commit}:.env.example`]);
  assert.deepEqual(inspected.entries.find(entry => entry.name === '.env.example').bytes, example);
  assert.ok(inspected.entries.some(entry => entry.name === 'public/js/firebase-config.js'));
});
test('package preserves exact evidence bytes and exports a non-authorizing archive receipt', async () => {
  const f = fixture(); const authenticated = await authenticatedGithubCandidate(f.request, f);
  const result = assembleCandidatePackage(sourceTar(f.request.commit), authenticated);
  assert.equal(result.receipt.archiveSha256, sha256(result.archive));
  assert.equal(result.receipt.deploymentAuthorized, false);
  const tar = gunzipSync(result.archive);
  const file = name => {
    for (let offset = 0; offset + 512 <= tar.length; ) {
      const header = tar.subarray(offset, offset + 512);
      const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/su, '').trim() || '0', 8);
      if (header.subarray(0, 100).toString('utf8').replace(/\0.*$/su, '') === name) return tar.subarray(offset + 512, offset + 512 + size);
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    assert.fail(`missing generated package file ${name}`);
  };
  assert.deepEqual(file('.ci-qualification.json'), authenticated.evidence.qualifiedBytes);
  assert.deepEqual(file('.ci-candidate.json'), authenticated.evidence.candidateBytes);
  assert.deepEqual(file('.ci-recovery-report.json'), authenticated.evidence.reportBytes);
  assert.equal(file('.ci-images').toString().trim().split('\n').length, 3);
  assert.deepEqual(JSON.parse(file('.ci-provenance.json')).artifacts, authenticated.provenance.artifacts);
  // The source-only inspector must not accept a package as a new source archive.
  assert.throws(() => inspectSourceArchive(tar, f.request.commit), /private_or_reserved_source_path/u);
});

test('real git archive packages the API-confirmed commit, not HEAD/worktree, and never overwrites output', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'candidate-package-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args, input) => execFileSync('git', args, { cwd: root, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(['init', '--bare', '.']);
  const blob = git(['hash-object', '-w', '--stdin'], 'immutable fixture source\n');
  const envExample = await readFile(new URL('../../.env.example', import.meta.url));
  const envBlob = git(['hash-object', '-w', '--stdin'], envExample);
  const tree = entries => git(['mktree'], entries.join('\n') + '\n');
  const apiDb = tree([`100644 blob ${blob}\tmigrate.js`]);
  const api = tree([`040000 tree ${apiDb}\tdb`]);
  const nginx = tree([`100644 blob ${blob}\tnginx.conf`]);
  const publicTree = tree([`100644 blob ${blob}\tindex.html`]);
  const treeSha = tree([`100644 blob ${envBlob}\t.env.example`, `040000 tree ${api}\tapi`, `100644 blob ${blob}\tdocker-compose.payload.yml`,
    `100644 blob ${blob}\tdocker-compose.yml`, `040000 tree ${nginx}\tnginx`, `040000 tree ${publicTree}\tpublic`]);
  // Only disposable fixture objects: no commit/ref is written in the project.
  const commit = git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', treeSha], 'fixture\n');
  const f = fixture(commit, treeSha); const output = path.join(root, 'package');
  await writeFile(path.join(root, '.env'), 'untracked fixture secret never archived');
  const receipt = await packageCandidate(f.request, { ...f, checkout: root, output });
  const archive = await readFile(path.join(output, 'payload-candidate.tar.gz'));
  assert.equal(receipt.archiveSha256, sha256(archive));
  assert.equal(gunzipSync(archive).includes(Buffer.from('untracked fixture secret')), false);
  assert.ok(gunzipSync(archive).includes(Buffer.from('immutable fixture source')));
  assert.ok(gunzipSync(archive).includes(envExample));
  await assert.rejects(packageCandidate(f.request, { ...f, checkout: root, output }), { code: 'EEXIST' });
  const wrongTree = fixture(commit, 'f'.repeat(40));
  await assert.rejects(packageCandidate(wrongTree.request, { ...wrongTree, checkout: root, output: path.join(root, 'wrong') }), /local_source_binding_mismatch/u);
  // An archive may not omit a committed path through a local info/attributes
  // override, even though git archive itself reports success.
  await writeFile(path.join(root, 'info', 'attributes'), 'public/index.html export-ignore\n');
  await assert.rejects(packageCandidate(f.request, { ...f, checkout: root, output: path.join(root, 'omitted') }), /source_archive_tree_mismatch/u);
  await rm(path.join(root, 'info', 'attributes'));
  // A real reserved-path collision in the committed source remains blocked;
  // fixing the earlier test never made .ci-images an admissible source member.
  const collisionTree = tree([...git(['ls-tree', treeSha]).split('\n'), `100644 blob ${blob}\t.ci-images`]);
  const collisionCommit = git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', collisionTree], 'reserved fixture\n');
  const collision = fixture(collisionCommit, collisionTree);
  await assert.rejects(packageCandidate(collision.request, { ...collision, checkout: root, output: path.join(root, 'collision') }), /private_or_reserved_source_path/u);
  await assert.rejects(access(path.join(root, 'collision')), { code: 'ENOENT' });
  const { privateKey } = generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  for (const value of [Buffer.concat([envExample, Buffer.from(`\n${privateKey}`)]),
    Buffer.from(envExample.toString('utf8').replace('SUA_CHAVE_AQUI', privateKey.trim().split('\n').slice(1, -1).join('')))]) {
    const secretBlob = git(['hash-object', '-w', '--stdin'], value);
    const secretTree = tree(git(['ls-tree', treeSha]).split('\n').map(record =>
      record.endsWith('\t.env.example') ? `100644 blob ${secretBlob}\t.env.example` : record));
    const secretCommit = git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', secretTree], 'private fixture\n');
    const secret = fixture(secretCommit, secretTree); const secretOutput = path.join(root, `secret-${secretBlob}`);
    await assert.rejects(packageCandidate(secret.request, { ...secret, checkout: root, output: secretOutput }), /source_archive_secret_detected/u);
    await assert.rejects(access(secretOutput), { code: 'ENOENT' });
  }
});
