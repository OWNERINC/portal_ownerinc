import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateRawSync, gunzipSync, gzipSync } from 'node:zlib';
import * as packager from '../../scripts/package-payload-candidate.mjs';
import { RECOVERY_CHECKS, RECOVERY_NEGATIVES, qualifyCandidate } from '../../scripts/lib/payload-candidate-qualification.mjs';
import {
  checkDirectoryMetadata, checkFileMetadata, main, parseAdmissionJson, reconstructAdmission,
  validateAdmissionPolicy, validateAdmissionRecord,
} from '../../scripts/register-payload-candidate-admission.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.from(JSON.stringify(value) + '\n');
const toolFiles = ['ops/payload-candidate-verifier.py', 'scripts/register-payload-candidate-admission.mjs',
  'scripts/package-payload-candidate.mjs', 'scripts/lib/payload-candidate-qualification.mjs'];
const workflowBytes = Buffer.from('# synthetic reviewed workflow fixture, NOT a real producer approval\n');
function policy(commit = 'a'.repeat(40)) {
  return {
    schemaVersion: 1, kind: 'ownerinc-payload-candidate-policy-v1', environment: 'production',
    repository: 'OWNERINC/portal_ownerinc', repositoryId: '7', workflow: '.github/workflows/ci.yml', workflowId: '8',
    approvedRevisions: [{ commit, workflowSha256: sha256(workflowBytes) }],
    toolchain: { files: Object.fromEntries(toolFiles.map(name => [name, 'd'.repeat(64)])),
      executables: Object.fromEntries(['node', 'git', 'python', 'gitRemoteHttps'].map(role =>
        [role, { path: role === 'gitRemoteHttps' ? '/opt/ownerinc/lib/payload-candidate/bin/git-remote-https' : `/trusted/bin/${role}`,
          sha256: 'e'.repeat(64) }])) },
  };
}
function record(selectedPolicy = policy(), bundle = Buffer.from('opaque synthetic gzip fixture')) {
  return {
    schemaVersion: 1, kind: 'payload-candidate-admission-record-v1', environment: 'production',
    policySha256: sha256(bytes(selectedPolicy)), repository: selectedPolicy.repository, repositoryId: selectedPolicy.repositoryId,
    workflow: selectedPolicy.workflow, workflowId: selectedPolicy.workflowId, workflowSha256: sha256(workflowBytes),
    commit: selectedPolicy.approvedRevisions[0].commit, runId: '12345678901', runAttempt: '2',
    images: Object.fromEntries(['api', 'cron', 'cms'].map((service, index) =>
      [service, `ghcr.io/ownerinc/ownerinc-portal-${service}@sha256:${String(index + 1).repeat(64)}`])),
    artifacts: Object.fromEntries(['candidate', 'qualified', 'report'].map((role, index) =>
      [role, { id: String(111 + index), digest: `sha256:${String(index + 4).repeat(64)}` }])),
    qualificationContract: 'payload-preauthority-recovery-v1', candidateSha256: 'a'.repeat(64),
    qualifiedManifestSha256: 'b'.repeat(64), recoveryReportSha256: 'c'.repeat(64), sourceTreeSha: 'e'.repeat(40),
    sourceArchiveSha256: 'f'.repeat(64), archiveSha256: sha256(bundle), archiveBytes: bundle.length, deploymentAuthorized: false,
  };
}

test('strict admission JSON rejects duplicate escaped keys, malformed numbers, UTF8 and nesting', () => {
  for (const raw of ['{"schemaVersion":1,"schemaVersion":1}', '{"a":1,"\\u0061":2}',
    '{"a":NaN}', '{"a":1e309}', '{"a":1.0}', '{"a":1e0}', '{"a":9007199254740992}',
    '['.repeat(34) + '1' + ']'.repeat(34)]) assert.throws(() => parseAdmissionJson(Buffer.from(raw)));
  assert.throws(() => parseAdmissionJson(Buffer.from([0xff])));
  assert.throws(() => parseAdmissionJson(Buffer.alloc(1024 * 1024 + 1)));
  assert.throws(() => parseAdmissionJson(Buffer.from('\uFEFF{}')));
  assert.deepEqual(parseAdmissionJson(bytes(policy())), policy());
});

const invalidPolicies = [
  ['unknown policy field including UID override', value => { value.uid = 0; }],
  ['boolean version', value => { value.schemaVersion = true; }],
  ['string version', value => { value.schemaVersion = '1'; }],
  ['unsupported version', value => { value.schemaVersion = 2; }],
  ['staging environment', value => { value.environment = 'staging'; }],
  ['wrong repository', value => { value.repository = 'other/repo'; }],
  ['wrong workflow', value => { value.workflow = '.github/workflows/other.yml'; }],
  ['numeric repository identity', value => { value.repositoryId = 7; }],
  ['boolean workflow identity', value => { value.workflowId = true; }],
  ['empty revisions', value => { value.approvedRevisions = []; }],
  ['too many revisions', value => { value.approvedRevisions = Array(129).fill(value.approvedRevisions[0]); }],
  ['duplicate SHA', value => { value.approvedRevisions.push(value.approvedRevisions[0]); }],
  ['branch wildcard', value => { value.approvedRevisions[0].commit = 'refs/heads/*'; }],
  ['workflow digest prefix instead of exact SHA256', value => { value.approvedRevisions[0].workflowSha256 = `sha256:${'a'.repeat(64)}`; }],
  ['unknown approval flag', value => { value.approvedRevisions[0].approved = true; }],
  ['tool hash malformed', value => { value.toolchain.files[toolFiles[0]] = 'A'.repeat(64); }],
  ['hash trailing newline', value => { value.toolchain.files[toolFiles[0]] += '\n'; }],
  ['ID trailing newline', value => { value.repositoryId += '\n'; }],
  ['missing closure module', value => { delete value.toolchain.files[toolFiles[2]]; }],
  ['additional module', value => { value.toolchain.files['candidate/tools.mjs'] = 'a'.repeat(64); }],
  ['executable path traversal', value => { value.toolchain.executables.node.path = '/trusted/../bin/node'; }],
  ['relative executable', value => { value.toolchain.executables.node.path = 'node'; }],
  ['malformed executable SHA', value => { value.toolchain.executables.node.sha256 = null; }],
  ['duplicate executable path', value => { value.toolchain.executables.node.path = value.toolchain.executables.git.path; }],
  ['Git PATH resolution mismatch', value => { value.toolchain.executables.git.path = '/trusted/bin/not-git'; }],
  ['unapproved remote helper path', value => { value.toolchain.executables.gitRemoteHttps.path = '/received/git-remote-https'; }],
];
for (const [name, mutate] of invalidPolicies) {
  test(`policy fails closed: ${name}`, () => {
    const value = policy(); mutate(value); assert.throws(() => validateAdmissionPolicy(value));
  });
}

test('records bind exact schemas, identities, three images, artifact ZIP hashes and false deploy authorization', () => {
  assert.equal(validateAdmissionRecord(record()).deploymentAuthorized, false);
  for (const mutate of [value => { value.approved = true; }, value => { value.environment = 'staging'; },
    value => { value.deploymentAuthorized = true; }, value => { value.schemaVersion = true; },
    value => { value.archiveBytes = '3'; }, value => { value.archiveBytes = 10 * 1024 * 1024 + 1; },
    value => { value.qualifiedManifestSha256 = null; }, value => { value.policySha256 = 'A'.repeat(64); },
    value => { value.commit = 'main'; }, value => { value.runAttempt = 2; },
    value => { value.images.cms = 'ghcr.io/ownerinc/ownerinc-portal-cms:latest'; },
    value => { value.artifacts.report.id = value.artifacts.qualified.id; },
    value => { value.artifacts.report.digest = 'b'.repeat(64); }, value => { value.artifacts.report.uid = 0; }]) {
    const value = record(); mutate(value); assert.throws(() => validateAdmissionRecord(value));
  }
});

const metadata = (mode, uid = 0, gid = 0, nlink = 1) => ({ mode, uid, gid, nlink,
  isFile: () => (mode & 0o170000) === 0o100000, isDirectory: () => (mode & 0o170000) === 0o040000 });
test('registrar POSIX metadata requires root:root exact modes and blocks links/writable ancestry', () => {
  checkFileMetadata(metadata(0o100600)); checkDirectoryMetadata(metadata(0o040755)); checkDirectoryMetadata(metadata(0o040700), true);
  for (const info of [metadata(0o100600, 1000), metadata(0o100600, 0, 1000), metadata(0o100644),
    metadata(0o100600, 0, 0, 2), metadata(0o120600), metadata(0o040600), metadata(0o101600)]) {
    assert.throws(() => checkFileMetadata(info));
  }
  for (const info of [metadata(0o040775), metadata(0o041777), metadata(0o040755, 1000),
    metadata(0o040755, 0, 1000), metadata(0o120755), metadata(0o044755)]) assert.throws(() => checkDirectoryMetadata(info));
  assert.throws(() => checkDirectoryMetadata(metadata(0o040755), true));
});
test('CLI has no local-JSON, UID, policy path, fixture, endpoint or checkout override', async () => {
  for (const flag of ['--trust-local-json', '--fixture', '--uid', '--policy', '--registry', '--endpoint', '--checkout', '--packager']) {
    await assert.rejects(main([flag, 'private-do-not-echo']), /invalid_admission_arguments/u);
  }
  await assert.rejects(main(['--environment', 'staging']), /invalid_admission_arguments/u);
});

function zipFile(filename, content) {
  const name = Buffer.from(filename); const compressed = deflateRawSync(content); const crc = packager.crc32(content);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(content.length, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + compressed.length, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}
const requiredSteps = ['Build production images', 'Test editorial admin session v2 against disposable PostgreSQL and Firebase Auth',
  'Scan API image', 'Scan cron image', 'Scan CMS image', 'Reject high or critical production dependency vulnerabilities', 'Generate SPDX SBOMs',
  'Publish immutable images', 'Publish CMS immutable image', 'Run disposable four-store preauthority recovery on published digests',
  'Create recovery-qualified candidate manifest'];

// Real disposable Git objects, synthetic reports and HTTP mocks. No live GitHub
// authentication, project commit/ref, production policy or root record is created.
async function transportFixture(t) {
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  const root = await realpath(await mkdtemp(path.join(parent, 'candidate-admission-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args, input) => execFileSync('git', args, { cwd: root, input, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-09T10:00:00Z', GIT_COMMITTER_DATE: '2026-10-09T10:00:00Z' },
    stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(['init', '--bare', '--template=']);
  const blob = git(['hash-object', '-w', '--stdin'], 'synthetic immutable source\n');
  const workflow = git(['hash-object', '-w', '--stdin'], workflowBytes);
  const tree = entries => git(['mktree'], entries.join('\n') + '\n');
  const api = tree([`040000 tree ${tree([`100644 blob ${blob}\tmigrate.js`])}\tdb`]);
  const treeSha = tree([`040000 tree ${tree([`040000 tree ${tree([`100644 blob ${workflow}\tci.yml`])}\tworkflows`])}\t.github`,
    `040000 tree ${api}\tapi`, `100644 blob ${blob}\tdocker-compose.yml`, `100644 blob ${blob}\tdocker-compose.payload.yml`,
    `040000 tree ${tree([`100644 blob ${blob}\tnginx.conf`])}\tnginx`, `040000 tree ${tree([`100644 blob ${blob}\tindex.html`])}\tpublic`]);
  const commit = git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', treeSha], 'disposable admission fixture\n');
  const selectedPolicy = policy(commit); const rawPolicy = bytes(selectedPolicy);
  const request = { repository: selectedPolicy.repository, commit, runId: '12345678901', runAttempt: '2',
    artifactIds: { candidate: '111', qualified: '112', report: '113' } };
  const identity = { commit, runId: request.runId, runAttempt: request.runAttempt }; const images = record().images;
  const candidateBytes = bytes({ schemaVersion: 1, ...identity, images });
  const reportBytes = bytes({ schemaVersion: 1, status: 'passed', run: identity, images,
    sourceInventoryIdentity: 'b'.repeat(64), targetInventoryIdentity: 'c'.repeat(64),
    checks: Object.fromEntries(RECOVERY_CHECKS.map(key => [key, true])),
    negativeCases: RECOVERY_NEGATIVES.map(name => ({ name, rejected: true, targetContentUnchanged: true,
      ...(['unexpected_schema', 'weak_native_constraint', 'materialized_view', 'migration_ledger_mismatch'].includes(name)
        ? { fixtureDdlCleaned: true } : name === 'target_changed_after_restore_preflight' ? { raceInjectedAfterLeaseReservation: true } : {}),
    })),
    recoveryProgress: Object.fromEntries(['source', 'target', 'leaseTarget'].map(role =>
      [role, { initialCmsHealthPassed: true, writersRestartedHealthy: true, quiescentSnapshotComparison: 'passed' }])),
    restoreAcceptanceProgress: Object.fromEntries(['first', 'second'].map(role =>
      [role, { coordinatorReturnedSuccessfully: true, fullSnapshotComparisonPassed: true }])),
    evidence: { kind: 'redacted-metadata-only', privateFixtureRetainedForRunnerLifetime: false },
  });
  const qualifiedBytes = bytes(qualifyCandidate({ candidateBytes, reportBytes, expectedRun: identity, expectedImages: images }));
  const zips = { candidate: zipFile('candidate.json', candidateBytes), qualified: zipFile('qualified-candidate.json', qualifiedBytes),
    report: zipFile('payload-preauthority-recovery-report.json', reportBytes) };
  const names = { candidate: 'payload-release-candidate', qualified: 'payload-recovery-qualified-candidate', report: 'payload-preauthority-recovery-report' };
  const repository = { id: 7, full_name: selectedPolicy.repository, fork: false };
  const workflowMeta = { id: 8, path: selectedPolicy.workflow };
  const run = { id: Number(request.runId), run_attempt: 2, repository, head_repository: repository,
    workflow_id: 8, path: selectedPolicy.workflow, head_sha: commit, head_branch: 'synthetic/fixture', event: 'workflow_dispatch',
    status: 'completed', conclusion: 'success' };
  const jobs = [{ name: 'validate', run_id: run.id, run_attempt: 2, head_sha: commit, status: 'completed', conclusion: 'success',
    started_at: '2026-10-09T10:00:00Z', completed_at: '2026-10-09T11:00:00Z',
    steps: requiredSteps.map(name => ({ name, status: 'completed', conclusion: 'success' })),
  }, { name: 'Deploy production', status: 'completed', conclusion: 'skipped' }];
  const artifacts = Object.fromEntries(Object.keys(zips).map(role => [role, { id: Number(request.artifactIds[role]), name: names[role],
    expired: false, size_in_bytes: zips[role].length, digest: `sha256:${sha256(zips[role])}`, created_at: '2026-10-09T10:50:00Z',
    workflow_run: { id: run.id, repository_id: 7, head_repository_id: 7, head_sha: commit } }]));
  const calls = []; const token = 'synthetic-test-token';
  const fetchImpl = async (url, options) => {
    calls.push(url);
    if (url.startsWith('https://fixture.blob.core.windows.net/')) {
      assert.equal(options.headers, undefined); return new Response(zips[url.split('/').at(-1)], { status: 200 });
    }
    assert.equal(options.headers.Authorization, `Bearer ${token}`); assert.equal(options.redirect, 'manual');
    const prefix = `https://api.github.com/repos/${selectedPolicy.repository}`; assert.ok(url.startsWith(prefix));
    const route = url.slice(prefix.length); let value;
    if (route === '') value = repository;
    else if (route === '/actions/workflows/ci.yml') value = workflowMeta;
    else if (route === `/actions/runs/${request.runId}/attempts/2`) value = run;
    else if (route === `/actions/runs/${request.runId}/attempts/2/jobs?per_page=100&page=1`) value = { jobs };
    else if (route === `/git/commits/${commit}`) value = { sha: commit, tree: { sha: treeSha } };
    else {
      const role = Object.keys(artifacts).find(key => route === `/actions/artifacts/${request.artifactIds[key]}` ||
        route === `/actions/artifacts/${request.artifactIds[key]}/zip`);
      assert.ok(role, `unexpected synthetic API route ${route}`);
      if (route.endsWith('/zip')) return new Response(null, { status: 302, headers: { location: `https://fixture.blob.core.windows.net/${role}` } });
      value = artifacts[role];
    }
    return new Response(bytes(value), { status: 200 });
  };
  const initialOutput = path.join(root, 'first');
  const receipt = await packager.packageCandidate(request, { checkout: root, output: initialOutput, token, fetchImpl });
  const bundleBytes = await readFile(path.join(initialOutput, 'payload-candidate.tar.gz'));
  return { root, rawPolicy, selectedPolicy, request, token, fetchImpl, calls, bundleBytes, receipt, jobs, zips, artifacts,
    options: output => ({ packager, checkout: root, output: path.join(root, output), token, fetchImpl, workflowBytes, bundleBytes }) };
}

test('HTTP-mocked reconstruction authenticates same selection twice and compares exact final gzip bytes', async t => {
  const f = await transportFixture(t); f.calls.length = 0;
  const admitted = await reconstructAdmission(f.rawPolicy, f.request, f.options('second'));
  assert.equal(admitted.policySha256, sha256(f.rawPolicy)); assert.equal(admitted.archiveSha256, sha256(f.bundleBytes));
  assert.equal(admitted.recoveryReportSha256, f.receipt.recoveryReportSha256);
  assert.equal(admitted.qualifiedManifestSha256, f.receipt.qualifiedManifestSha256);
  assert.equal(admitted.deploymentAuthorized, false);
  assert.equal(f.calls.filter(url => url.endsWith('/zip')).length, 3);
  assert.equal(f.bundleBytes.readUInt32LE(4), 0, 'gzip MTIME is deterministic, not a wall clock');
  assert.deepEqual(await readFile(path.join(f.root, 'second', 'payload-candidate.tar.gz')), f.bundleBytes);
  const source = gunzipSync(f.bundleBytes); const recompressed = gzipSync(source, { level: 1 });
  assert.ok(!recompressed.equals(f.bundleBytes));
  await assert.rejects(reconstructAdmission(f.rawPolicy, f.request, { ...f.options('semantic-only'), bundleBytes: recompressed }), /admission_archive_not_reconstructed/u);
  const timestampChanged = Buffer.from(f.bundleBytes); timestampChanged.writeUInt32LE(1, 4);
  await assert.rejects(reconstructAdmission(f.rawPolicy, f.request, { ...f.options('timestamp'), bundleBytes: timestampChanged }), /admission_archive_not_reconstructed/u);
});
test('HTTP-mocked auth cannot be replaced by forged sidecars, consistent fake ZIP hashes or a failed gate', async t => {
  const f = await transportFixture(t);
  await assert.rejects(reconstructAdmission(f.rawPolicy, f.request, { ...f.options('no-token'), token: undefined }), /github_authentication_required/u);
  await assert.rejects(reconstructAdmission(f.rawPolicy, f.request, { ...f.options('http-denied'), fetchImpl: async () =>
    new Response('private-upstream-do-not-echo', { status: 401 }) }), /github_api_request_rejected/u);
  const forged = Buffer.from(f.bundleBytes); forged[forged.length - 1] ^= 1;
  await assert.rejects(reconstructAdmission(f.rawPolicy, f.request, { ...f.options('forged'), bundleBytes: forged }), /admission_archive_not_reconstructed/u);
  f.jobs[0].steps.at(-1).conclusion = 'failure';
  await assert.rejects(reconstructAdmission(f.rawPolicy, f.request, f.options('failed-gate')), /github_candidate_gate_not_passed/u);
  f.jobs[0].steps.at(-1).conclusion = 'success';
  const failedReport = JSON.parse(packager.readSingleArtifactZip(f.zips.report, 'payload-preauthority-recovery-report.json'));
  failedReport.status = 'failed'; f.zips.report = zipFile('payload-preauthority-recovery-report.json', bytes(failedReport));
  f.artifacts.report.digest = `sha256:${sha256(f.zips.report)}`; f.artifacts.report.size_in_bytes = f.zips.report.length;
  await assert.rejects(reconstructAdmission(f.rawPolicy, f.request, f.options('consistent-fake-zip')));
});
test('approval is exact SHA/workflow bytes and official IDs, not workflow self-approval', async t => {
  const f = await transportFixture(t); f.calls.length = 0;
  const unapproved = policy('f'.repeat(40));
  await assert.rejects(reconstructAdmission(bytes(unapproved), f.request, f.options('unapproved')), /candidate_revision_not_approved/u);
  await assert.rejects(reconstructAdmission(f.rawPolicy, f.request, { ...f.options('workflow-tamper'), workflowBytes: Buffer.from('different') }), /approved_workflow_bytes_mismatch/u);
  assert.equal(f.calls.length, 0, 'reject before artifact requests');
  const wrongId = structuredClone(f.selectedPolicy); wrongId.repositoryId = '9';
  await assert.rejects(reconstructAdmission(bytes(wrongId), f.request, f.options('id-mismatch')), /admission_authenticated_binding_mismatch/u);
});

const python = (process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'])
  .find(command => spawnSync(command, ['--version'], { encoding: 'utf8' }).status === 0);
async function runPython(t, code) {
  if (!python) { t.skip('Python 3 unavailable'); return; }
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  const fixture = await mkdtemp(path.join(parent, 'admission-python-')); t.after(() => rm(fixture, { recursive: true, force: true }));
  const filename = path.join(fixture, 'fixture.json'); await writeFile(filename, bytes({ policy: policy(), record: record(), invalidPolicies: invalidPolicies.map(([, mutate]) => {
    const value = policy(); mutate(value); return value;
  }) }));
  const result = spawnSync(python, ['-I', '-B', '-c', String.raw`
import copy, hashlib, importlib.util, json, os, posixpath, stat, sys
from types import SimpleNamespace
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('admission', sys.argv[1])
V = importlib.util.module_from_spec(spec)
spec.loader.exec_module(V)
with open(sys.argv[2], 'rb') as stream:
    f = json.load(stream)
# POSIX semantics are mocked in this offline Windows test, never selected by a
# fixture/environment flag in the production helper.
patch.object(V.os, 'path', posixpath).start()
for name, value in [('O_NOFOLLOW', 0x20000), ('O_NONBLOCK', 0x800)]:
    if not hasattr(V.os, name): patch.object(V.os, name, value, create=True).start()
policy = f['policy']; record = f['record']
raw = (json.dumps(policy, separators=(',', ':')) + '\n').encode()
record['policySha256'] = hashlib.sha256(raw).hexdigest()
request = {key: record[key] for key in ('commit', 'runId', 'runAttempt', 'images')}
request['artifactIds'] = {role: record['artifacts'][role]['id'] for role in V.ROLES}
def expect(callback, code=None):
    try: callback()
    except V.AdmissionError as error:
        if code is not None: assert str(error) == code, (str(error), code)
    else: raise AssertionError('expected fail closed')
` + code, path.resolve('ops/payload-candidate-verifier.py'), filename], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test('Python policy/record contracts agree, reject duplicate keys and malformed versions/UIDs', async t => {
  await runPython(t, String.raw`
V.validate_policy(policy); V.validate_record(record)
for value in f['invalidPolicies']: expect(lambda: V.validate_policy(value))
for value in [b'{"a":1,"a":1}', b'{"a":1,"\\u0061":2}', b'{"a":NaN}', b'{"a":1.0}', b'{"a":1e0}', b'\xff', b'[]' * 600000]:
    expect(lambda: V.strict_json(value))
expect(lambda: V.strict_json(b'[' * 34 + b'1' + b']' * 34))
for field, value in [('uid', 0), ('schemaVersion', True), ('schemaVersion', '1'), ('archiveBytes', True),
                     ('deploymentAuthorized', True), ('policySha256', 'A' * 64), ('environment', 'staging')]:
    changed = copy.deepcopy(record); changed[field] = value
    expect(lambda: V.validate_record(changed))
`);
});
test('Python root record binding denies same-SHA different digests, wrong attempt/environment and rotated policy bytes', async t => {
  await runPython(t, String.raw`
good = V.verify_record_binding(raw, record, request, record['archiveSha256'], record['archiveBytes'])
assert good['deploymentAuthorized'] is False
assert good['qualifiedManifestSha256'] == record['qualifiedManifestSha256']
for field, value in [('commit', 'b' * 40), ('runAttempt', '3'), ('runId', '123')]:
    changed = copy.deepcopy(request); changed[field] = value
    expect(lambda: V.verify_record_binding(raw, record, changed, record['archiveSha256'], record['archiveBytes']))
changed = copy.deepcopy(request); changed['images']['cms'] = changed['images']['cms'][:-64] + '9' * 64
expect(lambda: V.verify_record_binding(raw, record, changed, record['archiveSha256'], record['archiveBytes']), 'admission_candidate_binding_mismatch')
changed = copy.deepcopy(request); changed['artifactIds']['report'] = '999'
expect(lambda: V.verify_record_binding(raw, record, changed, record['archiveSha256'], record['archiveBytes']))
expect(lambda: V.verify_record_binding(raw + b' ', record, request, record['archiveSha256'], record['archiveBytes']), 'admission_policy_binding_mismatch')
expect(lambda: V.verify_record_binding(raw, record, request, '9' * 64, record['archiveBytes']), 'admission_archive_binding_mismatch')
`);
});
test('Python read-only entrypoint requires protected root record; forged archive sidecars alone never authenticate', async t => {
  await runPython(t, String.raw`
archive = b'opaque synthetic gzip fixture'
record_bytes = (json.dumps(record) + '\n').encode()
record_path = V.REGISTRY + '/' + record['archiveSha256'] + '.' + record['policySha256'] + '.json'
reads = []
def read(filename, *args, **kwargs):
    reads.append(filename)
    if filename == V.POLICY_PATH: return raw
    if filename == '/protected/bundle': return archive
    if filename == record_path: return record_bytes
    raise FileNotFoundError('private-do-not-echo')
with patch.object(V.os, 'name', 'posix'), patch.object(V.os, 'geteuid', return_value=0, create=True), \
     patch.object(V.os, 'getuid', return_value=0, create=True), \
     patch.object(V, 'verify_installed_tools'), patch.object(V, 'read_protected', side_effect=read):
    verified = V.verify_candidate('/protected/bundle', request)
    assert verified['archiveSha256'] == record['archiveSha256']
    assert verified['admissionRecordSha256'] == hashlib.sha256(record_bytes).hexdigest()
    assert reads.index('/protected/bundle') < reads.index(record_path)
    record_bytes = b'{"approved":true,"deploymentAuthorized":false}'
    expect(lambda: V.verify_candidate('/protected/bundle', request), 'invalid_admission_shape')
    record_bytes = (json.dumps(record) + '\n').encode()
    def missing(filename, *args, **kwargs):
        if filename.startswith(V.REGISTRY): raise FileNotFoundError('missing root record')
        return read(filename, *args, **kwargs)
    with patch.object(V, 'read_protected', side_effect=missing):
        try: V.verify_candidate('/protected/bundle', request)
        except FileNotFoundError: pass
        else: raise AssertionError('forged sidecars without a root record must fail')
with patch.object(V.os, 'name', 'posix'), patch.object(V.os, 'geteuid', return_value=1000, create=True), \
     patch.object(V.os, 'getuid', return_value=1000, create=True):
    expect(lambda: V.verify_candidate('/protected/bundle', request), 'root_posix_admission_required')
`);
});
test('Python protected file checks reject symlink/hardlink owners modes and every writable ancestor without a fixture exemption', async t => {
  await runPython(t, String.raw`
def info(mode, uid=0, gid=0, links=1):
    return SimpleNamespace(st_mode=mode, st_uid=uid, st_gid=gid, st_nlink=links)
V.check_file_metadata(info(stat.S_IFREG | 0o600), (0o600,))
for item in [info(stat.S_IFREG | 0o600, 1000), info(stat.S_IFREG | 0o600, 0, 1000),
             info(stat.S_IFREG | 0o600, links=2), info(stat.S_IFLNK | 0o600),
             info(stat.S_IFREG | 0o644), info(stat.S_IFREG | 0o1600)]:
    expect(lambda: V.check_file_metadata(item, (0o600,)))
V.check_directory_metadata(info(stat.S_IFDIR | 0o755))
for item in [info(stat.S_IFDIR | 0o775), info(stat.S_IFDIR | 0o1777),
             info(stat.S_IFDIR | 0o755, 1000), info(stat.S_IFDIR | 0o755, 0, 1000), info(stat.S_IFLNK | 0o755)]:
    expect(lambda: V.check_directory_metadata(item))
with patch.object(V.os.path, 'realpath', side_effect=lambda value: value), \
     patch.object(V.os, 'lstat', return_value=info(stat.S_IFDIR | 0o755)) as check:
    V.verify_ancestry('/protected/private/file')
    assert [call.args[0] for call in check.call_args_list] == ['/protected/private', '/protected', '/']
    expect(lambda: V.verify_ancestry('/protected/private/file', True))
with patch.object(V.os.path, 'realpath', return_value='/different/file'):
    expect(lambda: V.verify_ancestry('/protected/private/file'), 'unsafe_admission_path')
for value in ['/protected/../file', '/protected//file', 'relative', '/protected/file/']:
    expect(lambda: V.canonical_path(value))
`);
});
test('Python installed closure rejects module/binary tampering and uninstalled helper path', async t => {
  await runPython(t, String.raw`
data = b'synthetic installed bytes'
for key in policy['toolchain']['files']: policy['toolchain']['files'][key] = hashlib.sha256(data).hexdigest()
for entry in policy['toolchain']['executables'].values(): entry['sha256'] = hashlib.sha256(data).hexdigest()
with patch.object(V, '__file__', V.TOOL_ROOT + '/ops/payload-candidate-verifier.py'), \
     patch.object(V.sys, 'executable', policy['toolchain']['executables']['python']['path']), \
     patch.object(V.os.path, 'realpath', side_effect=lambda value: value), \
     patch.object(V, 'read_protected', return_value=data):
    V.verify_installed_tools(policy)
    changed = copy.deepcopy(policy); changed['toolchain']['files'][V.TOOL_FILES[0]] = '9' * 64
    expect(lambda: V.verify_installed_tools(changed), 'installed_admission_tool_mismatch')
    changed = copy.deepcopy(policy); changed['toolchain']['executables']['git']['sha256'] = '9' * 64
    expect(lambda: V.verify_installed_tools(changed), 'installed_admission_executable_mismatch')
    with patch.object(V, '__file__', '/received/ops/payload-candidate-verifier.py'):
        expect(lambda: V.verify_installed_tools(policy), 'admission_tool_not_installed')
`);
});
test('Python protected read uses nofollow, stable descriptor metadata and rejects changed inode/content', async t => {
  await runPython(t, String.raw`
def info(inode=2, size=3):
    return SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_gid=0, st_nlink=1,
                           st_dev=1, st_ino=inode, st_size=size, st_mtime_ns=1, st_ctime_ns=1)
class Stream:
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def read(self, size): return b'abc'
with patch.object(V, 'verify_ancestry'), patch.object(V.os, 'lstat', return_value=info()), \
     patch.object(V.os, 'open', return_value=3) as opened, patch.object(V.os, 'fstat', return_value=info()), \
     patch.object(V.os, 'fdopen', return_value=Stream()), patch.object(V.os, 'close'):
    assert V.read_protected('/protected/file', 10) == b'abc'
    assert opened.call_args.args[1] & V.os.O_NOFOLLOW
    with patch.object(V.os, 'fstat', return_value=info(inode=4)):
        expect(lambda: V.read_protected('/protected/file', 10), 'admission_file_changed')
    with patch.object(V.os, 'fstat', side_effect=[info(), info(size=4)]):
        expect(lambda: V.read_protected('/protected/file', 10), 'admission_file_changed')
    expect(lambda: V.read_protected('/protected/file', 2), 'admission_file_limit_exceeded')
`);
});

test('registrar private persistence is atomic/no-overwrite, fsyncs file+directory and retains failed evidence (VM mocks only)', async t => {
  const source = await readFile(new URL('../../scripts/register-payload-candidate-admission.mjs', import.meta.url), 'utf8');
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  const fixture = await mkdtemp(path.join(parent, 'admission-vm-')); t.after(() => rm(fixture, { recursive: true, force: true }));
  const fixtureFile = path.join(fixture, 'module.json'); await writeFile(fixtureFile, bytes({ source, policy: policy(), record: record() }));
  const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', String.raw`
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
const f = JSON.parse(await readFile(process.argv[1], 'utf8'));
const sha = data => createHash('sha256').update(data).digest('hex');
const registry = '/var/lib/ownerinc/payload-candidate/records';
const root = '/opt/ownerinc/lib/payload-candidate';
const files = new Map(); const fileModes = new Map(); const effects = []; let unsafeRegistry = false; let changedDuringRead = false;
const info = (filename, big = false) => {
  const data = files.get(filename); const directory = !data;
  const mode = directory ? 0o040700 : 0o100000 | (fileModes.get(filename) || 0o600);
  const size = filename === '/protected/growing' ? 3 : data?.length || 0;
  return { uid: big ? 0n : 0, gid: big ? 0n : 0, mode: big ? BigInt(mode) : mode,
    nlink: big ? 1n : 1, size: big ? BigInt(size) : size,
    dev: big ? 1n : 1, ino: big ? (changedDuringRead ? 3n : 2n) : 2, mtimeNs: 1n, ctimeNs: 1n,
    isFile: () => !directory, isDirectory: () => directory };
};
const fsMock = {
  realpath: async filename => filename === process.execPath ? f.policy.toolchain.executables.node.path : filename,
  lstat: async (filename, options = {}) => {
    if (unsafeRegistry && filename === registry) return { ...info(filename), mode: 0o040777 };
    return info(filename, options.bigint);
  },
  open: async (filename, flags, mode) => {
    effects.push(['open', filename, flags, mode]);
    let offset = 0;
    if (mode !== undefined) files.set(filename, Buffer.alloc(0));
    return {
      stat: async options => info(filename, options?.bigint),
      writeFile: async data => { files.set(filename, Buffer.from(data)); effects.push(['write', filename]); },
      read: async buffer => {
        const data = files.get(filename); const count = Math.min(buffer.length, data.length - offset);
        data.copy(buffer, 0, offset, offset + count); offset += count; return { bytesRead: count };
      },
      sync: async () => { effects.push(['sync', filename]); }, close: async () => {},
    };
  },
  link: async (pending, filename) => {
    effects.push(['link', pending, filename]);
    if (files.has(filename)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    files.set(filename, files.get(pending));
  },
  unlink: async filename => { files.delete(filename); effects.push(['unlink', filename]); },
  mkdir: async () => {},
};
const context = vm.createContext({ Buffer, console, process, TextDecoder, URL });
// Export private functions only from the in-memory test copy. Production source
// has no fixture flags, path overrides or arbitrary-record writer export.
const module = new vm.SourceTextModule(f.source + '\nexport {persistRecord, protectedBytes, fetchOfficialSource, installedTools};', {
  context, initializeImportMeta: meta => { meta.url = 'file://' + root + '/scripts/register-payload-candidate-admission.mjs'; },
});
const commands = [];
await module.link(async specifier => {
  const namespace = specifier === 'node:fs/promises' ? fsMock : specifier === 'node:child_process' ? {
    execFileSync: (executable, args, options) => { commands.push({ executable, args, options }); return Buffer.from('synthetic workflow'); },
  } : specifier === 'node:url' ? { ...await import(specifier), fileURLToPath: value => new URL(value).pathname } : await import(specifier);
  return new vm.SyntheticModule(Object.keys(namespace), function () {
    for (const key of Object.keys(namespace)) this.setExport(key, namespace[key]);
  }, { context });
});
await module.evaluate(); const N = module.namespace;
let rechecks = 0; const record = f.record;
const filename = registry + '/' + record.archiveSha256 + '.' + record.policySha256 + '.json';
await N.persistRecord(record, async () => { rechecks++; });
assert.equal(rechecks, 2); assert.equal(JSON.parse(files.get(filename)).deploymentAuthorized, false);
assert.ok(effects.findIndex(item => item[0] === 'sync' && item[1].includes('.pending-')) < effects.findIndex(item => item[0] === 'link'));
assert.ok(effects.some(item => item[0] === 'sync' && item[1] === registry));
const original = Buffer.from(files.get(filename));
await assert.rejects(N.persistRecord(record, async () => {}), { code: 'EEXIST' });
assert.deepEqual(files.get(filename), original); assert.ok([...files.keys()].some(key => key.includes('.pending-')));
const other = { ...record, policySha256: '8'.repeat(64) };
await assert.rejects(N.persistRecord(other, async () => { throw new Error('policy changed'); }), /policy changed/);
assert.ok(!files.has(registry + '/' + other.archiveSha256 + '.' + other.policySha256 + '.json'));
await N.persistRecord(other, async () => {});
assert.deepEqual(files.get(filename), original, 'policy rotation preserves old evidence');
unsafeRegistry = true;
await assert.rejects(N.persistRecord(record, async () => {}), /unsafe_admission_ancestry/);
unsafeRegistry = false;
files.set('/protected/growing', Buffer.from('01234567890'));
await assert.rejects(N.protectedBytes('/protected/growing', 10), /admission_file_limit_exceeded/);
const selectedPolicy = f.policy;
await N.fetchOfficialSource(selectedPolicy, '/protected/work', record.commit, 'synthetic-git-token');
assert.equal(commands.length, 4);
assert.ok(commands.every(command => command.executable === selectedPolicy.toolchain.executables.git.path));
const fetchCommand = commands.find(command => command.args.includes('fetch'));
assert.ok(fetchCommand.args.includes('https://github.com/OWNERINC/portal_ownerinc.git'));
assert.ok(fetchCommand.args.includes('core.hooksPath=/dev/null'));
assert.ok(fetchCommand.args.includes('protocol.allow=never'));
assert.ok(fetchCommand.args.includes('http.followRedirects=false'));
assert.equal(fetchCommand.options.env.GIT_EXEC_PATH, root + '/bin');
assert.equal(fetchCommand.options.env.GIT_CONFIG_GLOBAL, '/dev/null');
assert.ok(!Object.hasOwn(fetchCommand.options.env, 'GH_TOKEN'));
assert.equal(fetchCommand.options.env.GIT_CONFIG_KEY_0, 'http.https://github.com/OWNERINC/portal_ownerinc.git.extraHeader');
assert.ok(fetchCommand.options.env.GIT_CONFIG_VALUE_0.endsWith(Buffer.from('x-access-token:synthetic-git-token').toString('base64')));
assert.ok(commands.filter(command => command !== fetchCommand).every(command => !Object.hasOwn(command.options.env, 'GIT_CONFIG_VALUE_0')));
assert.ok(commands.every(command => !command.args.join(' ').includes('synthetic-git-token')));
const installed = Buffer.from('synthetic installed tool bytes');
for (const relative of Object.keys(selectedPolicy.toolchain.files)) {
  const filename = root + '/' + relative; files.set(filename, installed);
  fileModes.set(filename, relative.endsWith('.py') ? 0o755 : 0o644);
  selectedPolicy.toolchain.files[relative] = sha(installed);
}
for (const executable of Object.values(selectedPolicy.toolchain.executables)) {
  files.set(executable.path, installed); fileModes.set(executable.path, 0o755); executable.sha256 = sha(installed);
}
await N.installedTools(selectedPolicy);
files.set(root + '/scripts/lib/payload-candidate-qualification.mjs', Buffer.from('tampered'));
await assert.rejects(N.installedTools(selectedPolicy), /installed_admission_tool_mismatch/);
`, fixtureFile], { encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('helper CLI errors remain redacted and reject every unknown/duplicate argument', () => {
  if (!python) return;
  const filename = path.resolve('ops/payload-candidate-verifier.py');
  for (const args of [['verify', '--fixture', 'secret-sentinel-private'], ['verify', '--archive', 'secret-sentinel-private'],
    ['verify', '--policy', 'secret-sentinel-private']]) {
    const result = spawnSync(python, ['-I', '-S', '-B', filename, ...args], { encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /secret-sentinel-private|Traceback|usage:/u);
  }
});

test('privileged APIs remain separate from receiver/legacy and contain no received-code execution or archive extraction', async () => {
  const helper = await readFile(new URL('../../ops/payload-candidate-verifier.py', import.meta.url), 'utf8');
  const registrar = await readFile(new URL('../../scripts/register-payload-candidate-admission.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(helper, /import (?:subprocess|tarfile|zipfile)|extractall|eval\(|exec\(/u);
  assert.match(registrar, /https:\/\/github\.com\/\$\{REPOSITORY\}\.git/u);
  assert.match(registrar, /await installedTools\(policy\);[\s\S]*const packager = await import/u);
  assert.match(registrar, /await file\.sync\(\)/u);
  assert.match(registrar, /await link\(pending, filename\)/u);
  assert.match(registrar, /await syncDirectory\(REGISTRY\)/u);
  assert.doesNotMatch(registrar, /rename\(|docker|deploy-from-ci|\.ci-provenance\.json/u);
});
