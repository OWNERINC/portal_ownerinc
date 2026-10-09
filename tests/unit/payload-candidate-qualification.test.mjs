import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  QUALIFICATION_CONTRACT, RECOVERY_CHECKS, RECOVERY_NEGATIVES, parseEvidenceJson,
  qualifyCandidate, sha256, validateQualifiedCandidate,
} from '../../scripts/lib/payload-candidate-qualification.mjs';
import { main } from '../../scripts/qualify-payload-candidate.mjs';

const bytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
function fixture() {
  const expectedRun = { commit: 'a'.repeat(40), runId: '12345678901', runAttempt: '2' };
  const expectedImages = Object.fromEntries(['api', 'cron', 'cms'].map((key, index) =>
    [key, `ghcr.io/ownerinc/ownerinc-portal-${key}@sha256:${String(index + 1).repeat(64)}`]));
  const candidate = { schemaVersion: 1, ...expectedRun, images: expectedImages };
  const report = {
    schemaVersion: 1, status: 'passed', run: { ...expectedRun }, images: { ...expectedImages },
    sourceInventoryIdentity: 'b'.repeat(64), targetInventoryIdentity: 'c'.repeat(64),
    checks: Object.fromEntries(RECOVERY_CHECKS.map(key => [key, true])),
    negativeCases: RECOVERY_NEGATIVES.map(name => ({ name, rejected: true, targetContentUnchanged: true,
      ...(['unexpected_schema', 'weak_native_constraint', 'materialized_view', 'migration_ledger_mismatch'].includes(name)
        ? { fixtureDdlCleaned: true } : name === 'target_changed_after_restore_preflight'
          ? { raceInjectedAfterLeaseReservation: true } : {}),
    })),
    recoveryProgress: Object.fromEntries(['source', 'target', 'leaseTarget'].map(role =>
      [role, { initialCmsHealthPassed: true, writersRestartedHealthy: true, quiescentSnapshotComparison: 'passed' }])),
    restoreAcceptanceProgress: Object.fromEntries(['first', 'second'].map(role =>
      [role, { coordinatorReturnedSuccessfully: true, fullSnapshotComparisonPassed: true }])),
    evidence: { kind: 'redacted-metadata-only', privateFixtureRetainedForRunnerLifetime: false },
  };
  return { expectedRun, expectedImages, candidate, report,
    input: () => ({ expectedRun, expectedImages, candidateBytes: bytes(candidate), reportBytes: bytes(report) }) };
}

test('qualification binds exact report bytes and the explicit contract without mutating evidence', () => {
  const f = fixture(); const before = JSON.stringify(f.report);
  const qualified = qualifyCandidate(f.input());
  assert.equal(qualified.qualificationContract, QUALIFICATION_CONTRACT);
  assert.equal(qualified.recoveryReportSha256, sha256(f.input().reportBytes));
  assert.equal(JSON.stringify(f.report), before);
  assert.equal(RECOVERY_CHECKS.length, 14); assert.equal(RECOVERY_NEGATIVES.length, 11);
  assert.deepEqual(validateQualifiedCandidate({ ...f.input(), qualifiedBytes: bytes(qualified) }), qualified);
  const changedBytes = Buffer.from(JSON.stringify(f.report));
  assert.throws(() => validateQualifiedCandidate({ ...f.input(), reportBytes: changedBytes, qualifiedBytes: bytes(qualified) }), /binding_mismatch/u);
});

for (const [label, mutate] of [
  ['failed report', f => { f.report.status = 'failed'; }],
  ['unsupported report version', f => { f.report.schemaVersion = 2; }],
  ['unsupported candidate version', f => { f.candidate.schemaVersion = 2; }],
  ['extra report field', f => { f.report.secret = 'not-allowed'; }],
  ['missing checks', f => { delete f.report.checks; }],
  ['missing negative', f => { f.report.negativeCases.pop(); }],
  ['duplicate negative', f => { f.report.negativeCases[1] = f.report.negativeCases[0]; }],
  ['unexpected negative', f => { f.report.negativeCases[0].name = 'other'; }],
  ['wrong commit', f => { f.report.run.commit = 'd'.repeat(40); }],
  ['wrong run', f => { f.candidate.runId = '99'; }],
  ['wrong attempt', f => { f.report.run.runAttempt = '1'; }],
  ['zero attempt', f => { f.expectedRun.runAttempt = '0'; }],
  ['mutable image', f => { f.report.images.cms = 'ghcr.io/ownerinc/ownerinc-portal-cms:latest'; }],
  ['mixed digest', f => { f.report.images.cms = f.report.images.cms.replace(/3/gu, '4'); }],
  ['missing restore progress', f => { delete f.report.restoreAcceptanceProgress; }],
  ['missing race proof', f => { delete f.report.negativeCases.at(-1).raceInjectedAfterLeaseReservation; }],
  ['false race proof', f => { f.report.negativeCases.at(-1).raceInjectedAfterLeaseReservation = false; }],
  ['extra negative proof', f => { f.report.negativeCases[0].arbitrary = true; }],
  ['fixture retained', f => { f.report.evidence.privateFixtureRetainedForRunnerLifetime = true; }],
  ['same inventories', f => { f.report.targetInventoryIdentity = f.report.sourceInventoryIdentity; }],
]) test(`qualification rejects ${label}`, () => {
  const f = fixture(); mutate(f); assert.throws(() => qualifyCandidate(f.input()));
});

for (const key of RECOVERY_CHECKS) test(`qualification rejects missing/false check ${key}`, () => {
  for (const value of [false, 'true', undefined]) {
    const f = fixture(); if (value === undefined) delete f.report.checks[key]; else f.report.checks[key] = value;
    assert.throws(() => qualifyCandidate(f.input()));
  }
});
for (const name of RECOVERY_NEGATIVES) test(`qualification requires real negative flags for ${name}`, () => {
  for (const key of ['rejected', 'targetContentUnchanged', ...(['unexpected_schema', 'weak_native_constraint', 'materialized_view', 'migration_ledger_mismatch'].includes(name) ? ['fixtureDdlCleaned'] : [])]) {
    const f = fixture(); f.report.negativeCases.find(item => item.name === name)[key] = false;
    assert.throws(() => qualifyCandidate(f.input()));
  }
});
for (const restore of ['first', 'second']) test(`qualification requires both ${restore} restore proofs`, () => {
  for (const key of ['coordinatorReturnedSuccessfully', 'fullSnapshotComparisonPassed']) {
    const f = fixture(); f.report.restoreAcceptanceProgress[restore][key] = false;
    assert.throws(() => qualifyCandidate(f.input()));
  }
});
test('duplicate JSON keys, escaped duplicates, malformed bytes and deep input fail closed', () => {
  for (const input of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"nested":{"x":1,"x":2}}']) {
    assert.throws(() => parseEvidenceJson(Buffer.from(input)), /duplicate_evidence_field/u);
  }
  assert.throws(() => parseEvidenceJson(Buffer.from([0xff])));
  assert.throws(() => parseEvidenceJson(Buffer.from('{"x":1e999}')));
  assert.throws(() => parseEvidenceJson(Buffer.from('['.repeat(34) + '0' + ']'.repeat(34))), /nesting_exceeded/u);
});
test('qualified manifests with fabricated contract/hash/binding or unknown fields are rejected', () => {
  for (const key of ['qualificationContract', 'commit', 'runId', 'runAttempt', 'recoveryReportSha256', 'schemaVersion']) {
    const f = fixture(); const qualified = qualifyCandidate(f.input()); qualified[key] = 'fabricated';
    assert.throws(() => validateQualifiedCandidate({ ...f.input(), qualifiedBytes: bytes(qualified) }));
  }
});
test('CLI creates exclusively and cannot overwrite prior qualification or accept arbitrary inputs', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'candidate-qualification-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture(); const candidate = path.join(root, 'candidate.json'); const report = path.join(root, 'report.json');
  const output = path.join(root, 'qualified.json');
  await writeFile(candidate, f.input().candidateBytes); await writeFile(report, f.input().reportBytes);
  const env = { GITHUB_SHA: f.expectedRun.commit, GITHUB_RUN_ID: f.expectedRun.runId, GITHUB_RUN_ATTEMPT: f.expectedRun.runAttempt,
    API_IMAGE: f.expectedImages.api, CRON_IMAGE: f.expectedImages.cron, CMS_IMAGE: f.expectedImages.cms };
  const args = ['--candidate', candidate, '--report', report, '--output', output];
  const qualified = await main(args, env);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), qualified);
  await assert.rejects(main(args, env), { code: 'EEXIST' });
  await assert.rejects(main(['--trust-local-report'], env), /invalid_qualification_arguments/u);
});
