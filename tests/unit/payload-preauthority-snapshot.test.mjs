import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRecoveryFailureReportFields } from '../../scripts/integration/payload-preauthority-recovery-flow.mjs';
import { runFixtureCommand, FixtureFailure } from '../../scripts/integration/payload-preauthority-command.mjs';
import { POST_RESTORE_HOLD_CONTEXT, POST_RESTORE_HOLD_TIMEOUT_MS, POST_RESTORE_HOLD_SERVICES,
  POST_RESTORE_ADMISSION_TIMEOUT_SECONDS, POST_RESTORE_ADMISSION_KILL_GRACE_SECONDS,
  parseFixtureFailureHold } from '../../scripts/integration/payload-preauthority-snapshot-hold.mjs';
import { FIXTURE_STOP_TIMEOUT_SECONDS, FIXTURE_STOP_COMMAND_MARGIN_MS } from '../../scripts/integration/payload-preauthority-fixture.mjs';
import { normalizePgDumpForSnapshot } from '../../scripts/integration/payload-preauthority-fixture.mjs';
import { assertRecoveryCondition, assertRecoverySnapshots, createPrivateSnapshotEvidence,
  sanitizeSnapshotMismatch, snapshotComponents, holdFailedRecoveryFixtures,
  postRestoreFixtureHoldScript } from '../../scripts/integration/payload-preauthority-snapshot.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const baseline = () => Object.fromEntries(snapshotComponents.map(name => [name, hash(`private-${name}`)]));

test('every store/schema mismatch emits only its finite component and two hashes, never a diff', () => {
  for (const component of snapshotComponents) {
    const expected = baseline();
    const actual = { ...expected, [component]: hash('private-altered-row-sequence-schema-file') };
    assert.throws(() => assertRecoverySnapshots(expected, actual), error => {
      const report = createRecoveryFailureReportFields({ primaryError: error, primarySubstep: 'snapshot_cms_media' });
      assert.equal(report.failureCode, 'restored_snapshot_mismatch');
      assert.equal(report.failedSubstep, 'compare_restored_stores');
      assert.deepEqual(report.snapshotMismatch, [{ component, expectedHash: expected[component], actualHash: actual[component] }]);
      assert.doesNotMatch(JSON.stringify(report), /private-|snapshot_cms_media/u);
      return true;
    });
  }
  assert.doesNotThrow(() => assertRecoverySnapshots(baseline(), baseline()));
  assert.throws(() => assertRecoverySnapshots(baseline(), baseline(), { changed: true }), { code: 'restore_target_unchanged' });
  assert.doesNotThrow(() => assertRecoverySnapshots(baseline(), { ...baseline(), cmsDatabase: hash('new-row') }, { changed: true }));
});

test('snapshot comparison fails closed on missing/additional components or non-digests', () => {
  for (const malformed of [{}, { ...baseline(), cmsSchema: undefined }, { ...baseline(), secret: 'private' },
    { ...baseline(), portalDatabase: 'private-raw-data' }]) {
    assert.throws(() => assertRecoverySnapshots(malformed, malformed), { code: 'recovery_snapshot_shape_invalid' });
  }
  for (const value of [[], [{ component: 'private', expectedHash: hash('a'), actualHash: hash('b') }],
    [{ component: 'cmsSchema', expectedHash: 'raw', actualHash: hash('b') }],
    [{ component: 'cmsSchema', expectedHash: hash('a'), actualHash: hash('a') }]]) {
    assert.equal(sanitizeSnapshotMismatch(value), null);
  }
  const item = { component: 'cmsSchema', expectedHash: hash('a'), actualHash: hash('b'), raw: 'private-data' };
  assert.equal(sanitizeSnapshotMismatch([item, item]), null);
  assert.deepEqual(Object.keys(sanitizeSnapshotMismatch([item])[0]), ['component', 'expectedHash', 'actualHash']);
});

test('private pg_dump evidence retains row/sequence/schema changes without SQL rewriting', () => {
  const raw = `-- fixture\nINSERT INTO public.sessions (id, data) VALUES ('private-id', 'private-data');\nSELECT pg_catalog.setval('public.fixture_id_seq', 42, true);\n`;
  const original = hash(normalizePgDumpForSnapshot(raw));
  for (const modified of [raw.replace('private-data', 'changed'), raw.replace(', 42,', ', 43,'), raw.replace('true);', 'false);')]) {
    assert.notEqual(hash(normalizePgDumpForSnapshot(modified)), original);
  }
  const schema = 'CREATE TABLE public.fixture (id integer, CONSTRAINT fixture_check CHECK (((id > 0) AND (id < 10))));\n';
  const altered = schema.replace('id < 10', 'id < 11');
  assert.notEqual(hash(normalizePgDumpForSnapshot(schema)), hash(normalizePgDumpForSnapshot(altered)));
  // Private evidence intentionally retains formatting; it is not the logical acceptance hash.
  const regrouped = schema.replace('((id > 0) AND (id < 10))', '(id > 0 AND id < 10)');
  assert.notEqual(hash(normalizePgDumpForSnapshot(schema)), hash(normalizePgDumpForSnapshot(regrouped)));
});

test('assertion codes distinguish post-coordinator authority/document/worker failures', () => {
  for (const code of ['restored_authority_mismatch', 'source_announcement_invalid',
    'restored_source_document_mismatch', 'restored_target_document_present', 'restored_worker_hold_failed']) {
    assert.doesNotThrow(() => assertRecoveryCondition(code, true));
    assert.throws(() => assertRecoveryCondition(code, false), error => {
      assert.equal(createRecoveryFailureReportFields({ primaryError: error }).failedSubstep, code);
      return true;
    });
  }
  assert.throws(() => assertRecoveryCondition('private-value', false), /unsupported_recovery_assertion/u);
});

test('private evidence is bounded, explicitly truncated, and stored separately from public metadata', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'private-recovery-snapshots-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = createPrivateSnapshotEvidence();
  assert.equal(await evidence.persist(root), false);
  assert.throws(() => evidence.capture('../../unsafe', 'cmsSchema', 'private'), /invalid_snapshot_evidence_label/u);
  assert.throws(() => evidence.capture('first_source_after', 'private', 'private'), /invalid_snapshot_evidence_label/u);
  evidence.capture('first_source_after', 'cmsSchema', 'private-source-schema');
  evidence.capture('first_target_after', 'cmsSchema', Buffer.alloc(1024 * 1024 + 3, 'x'));
  assert.equal(await evidence.persist(root), true);
  const directory = path.join(root, 'private-snapshots');
  assert.deepEqual((await readdir(directory)).sort(), ['first_source_after-cmsSchema.bin', 'first_target_after-cmsSchema.bin', 'manifest.json']);
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest[0].truncated, false);
  assert.equal(manifest[1].truncated, true);
  assert.equal(manifest[1].originalBytes, 1024 * 1024 + 3);
  assert.equal((await stat(path.join(directory, manifest[1].file))).size, 1024 * 1024);
  assert.equal(await readFile(path.join(directory, manifest[0].file), 'utf8'), 'private-source-schema');
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, 'manifest.json'))).mode & 0o777, 0o600);
  }
});

test('runner marks coordinator return before comparisons and retains all six components at both restores', async () => {
  const runner = await readFile('scripts/test-payload-preauthority-recovery.mjs', 'utf8');
  for (const ordinal of ['first', 'second']) {
    assert.ok(runner.indexOf(`restoreAcceptanceProgress.${ordinal}.coordinatorReturnedSuccessfully = true`)
      < runner.indexOf(`restoreAcceptanceProgress.${ordinal}.fullSnapshotComparisonPassed = true`));
    for (const suffix of ['target_before', 'target_after', 'source_after']) assert.ok(runner.includes(`'${ordinal}_${suffix}'`));
  }
  assert.match(runner, /assertRecoverySnapshots\(sourceAfter, targetAfter\)/u);
  assert.match(runner, /assertRecoverySnapshots\(secondSourceAfter, secondTargetAfter\)/u);
  assert.match(runner, /privateSnapshotEvidence\.persist\(fixtureRoot\)/u);
  assert.match(runner, /pg_dump --data-only --column-inserts --no-owner --no-privileges/u);
  assert.match(runner, /pg_dump --schema-only --no-owner --no-privileges/u);
  assert.match(runner, /holdFailedRecoveryFixtures\(runtimeRefs/u);
  assert.match(runner, /withLease\(runtime, runtime\.project, 'bash', \['-c', postRestoreFixtureHoldScript/u);
});

test('post-restore hold attempts every fixture and reports failure without masking acceptance failure', async () => {
  const primary = new Error('private-primary');
  const calls = [];
  const result = await holdFailedRecoveryFixtures([1,2,3], async fixture => {
    calls.push(fixture);
    if (fixture === 1) throw Error('private-guard-or-stop');
    return { admissionClosed: fixture === 3, writersStopped: true, secret: 'private' };
  });
  assert.deepEqual(calls, [1,2,3]);
  assert.deepEqual(result, [
    { fixture: 'source', attempted: true, admissionClosed: false, writersStopped: false },
    { fixture: 'target', attempted: true, admissionClosed: false, writersStopped: true },
    { fixture: 'leaseTarget', attempted: true, admissionClosed: true, writersStopped: true },
  ]);
  assert.equal(primary.message, 'private-primary');
  assert.doesNotMatch(JSON.stringify(result), /private|secret/u);
  assert.ok(postRestoreFixtureHoldScript.indexOf('close-admission') < postRestoreFixtureHoldScript.indexOf('stop --timeout'));
  assert.match(postRestoreFixtureHoldScript, /set \+e/u);
  assert.doesNotMatch(postRestoreFixtureHoldScript, /open-admission|start|up -d/u);
});

test('actual fixture hold shell stops writers even when close-admission rejects', async t => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  if (spawnSync(bash, ['--version'], { stdio: 'ignore' }).status !== 0) return t.skip('bash unavailable');
  const root = await mkdtemp(path.join(os.tmpdir(), 'fixture-hold-shell-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'hold.sh'), postRestoreFixtureHoldScript);
  await writeFile(path.join(root, 'guard'), `#!/usr/bin/env bash
[[ $# == 3 && $1 == close-admission && -z $3 ]] || exit 97
printf 'guard\\n' >> "$PWD/calls"
printf 'irrelevant-stdout\\n'
if [[ \${HANG_GUARD:-false} == true ]]; then sleep 20; fi
if [[ $FAIL_GUARD == true ]]; then printf 'private-guard-stderr\\n' >&2; exit 2; fi
`, { mode: 0o755 });
  await writeFile(path.join(root, 'compose'), `#!/usr/bin/env bash
[[ "$*" == 'stop --timeout 120 nginx api cron cms cms-worker' ]] || exit 98
printf 'stop\\n' >> "$PWD/calls"
if [[ $FAIL_STOP == true ]]; then exit 3; fi
`, { mode: 0o755 });
  for (const [guard, stop, status, stdout] of [
    ['false','false',0,'PAYLOAD_FIXTURE_FAILURE_HOLD admission_status=0 stop_status=0'],
    ['true','false',2,'PAYLOAD_FIXTURE_FAILURE_HOLD admission_status=2 stop_status=0'],
    ['false','true',2,'PAYLOAD_FIXTURE_FAILURE_HOLD admission_status=0 stop_status=3'],
    ['true','true',2,'PAYLOAD_FIXTURE_FAILURE_HOLD admission_status=2 stop_status=3'],
  ]) {
    await writeFile(path.join(root, 'calls'), '');
    const result = spawnSync(bash, ['-c', 'bash "$PWD/hold.sh" "$PWD/guard" "$PWD/release" "$PWD/compose"'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, FAIL_GUARD: guard, FAIL_STOP: stop }, timeout: 30_000,
    });
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout.trim(), stdout);
    assert.equal(await readFile(path.join(root, 'calls'), 'utf8'), 'guard\nstop\n');
    // Exercise the same throwing wrapper used by withLease, not spawnSync-only.
    const evidence = [];
    const options = { cwd: root, env: { ...process.env, FAIL_GUARD: guard, FAIL_STOP: stop },
      timeout: POST_RESTORE_HOLD_TIMEOUT_MS, fixtureFailureHoldContext: POST_RESTORE_HOLD_CONTEXT,
      failureCode: 'post_restore_fixture_hold_failed', preservePrivateErrorEvidence: true,
      privateCommandEvidence: evidence };
    const outcome = await holdFailedRecoveryFixtures([{}], () => {
      const output = runFixtureCommand(bash, ['-c', 'bash "$PWD/hold.sh" "$PWD/guard" "$PWD/release" "$PWD/compose"'], options);
      return parseFixtureFailureHold(output, { status: 0 });
    });
    assert.equal(outcome[0].admissionClosed, guard === 'false');
    assert.equal(outcome[0].writersStopped, stop === 'false');
    if (guard === 'true') assert.equal(evidence.length, 1, 'private guard stderr survives the throw');
  }
  // Allow Git Bash/guard startup under the full parallel suite, then require
  // an actual started guard to hit its synthetic deadline. 100ms could expire
  // before the guard ran at all; neither production timeout is changed here.
  await writeFile(path.join(root, 'hold.sh'), postRestoreFixtureHoldScript
    .replace('120s', '2s').replace('--kill-after=10s', '--kill-after=1s'));
  await writeFile(path.join(root, 'calls'), '');
  const timed = await holdFailedRecoveryFixtures([{}], () => {
    runFixtureCommand(bash, ['-c', 'bash "$PWD/hold.sh" "$PWD/guard" "$PWD/release" "$PWD/compose"'], {
      cwd: root, env: { ...process.env, FAIL_GUARD: 'false', FAIL_STOP: 'false', HANG_GUARD: 'true' },
      timeout: 15_000, fixtureFailureHoldContext: POST_RESTORE_HOLD_CONTEXT,
    });
  });
  assert.equal(timed[0].admissionClosed, false);
  assert.equal(timed[0].writersStopped, true, 'guard closure deadline still permits stopping writers');
  assert.equal(await readFile(path.join(root, 'calls'), 'utf8'), 'guard\nstop\n');
});

test('hold budget includes all five requested services plus bounded admission closure and kill grace', async () => {
  assert.deepEqual(POST_RESTORE_HOLD_SERVICES, ['nginx','api','cron','cms','cms-worker']);
  assert.equal(POST_RESTORE_HOLD_TIMEOUT_MS, POST_RESTORE_HOLD_SERVICES.length * FIXTURE_STOP_TIMEOUT_SECONDS * 1000
    + (POST_RESTORE_ADMISSION_TIMEOUT_SECONDS + POST_RESTORE_ADMISSION_KILL_GRACE_SECONDS) * 1000
    + FIXTURE_STOP_COMMAND_MARGIN_MS);
  assert.equal(POST_RESTORE_HOLD_TIMEOUT_MS, 760_000);
  assert.match(postRestoreFixtureHoldScript, /timeout --signal=TERM --kill-after=10s 120s/u);
  const runner = await readFile('scripts/test-payload-preauthority-recovery.mjs', 'utf8');
  assert.match(runner, /timeout: POST_RESTORE_HOLD_TIMEOUT_MS/u);
  assert.match(runner, /fixtureFailureHoldContext: POST_RESTORE_HOLD_CONTEXT/u);
  assert.doesNotMatch(runner, /timeout: 7 \* 60_000/u);
});

test('malformed/absent status is closed on success and failure; arbitrary stdout never leaves the wrapper', async () => {
  const primary = new FixtureFailure('restored_snapshot_mismatch', { substep: 'compare_restored_stores' });
  const before = createRecoveryFailureReportFields({ primaryError: primary });
  const malformed = ['', 'private-output\n',
    'private-output\nPAYLOAD_FIXTURE_FAILURE_HOLD admission_status=0 stop_status=0\n',
    'PAYLOAD_FIXTURE_FAILURE_HOLD admission_status=0 stop_status=0\nprivate-secret\n',
    'PAYLOAD_FIXTURE_FAILURE_HOLD admission_status=256 stop_status=0\n',
    'PAYLOAD_FIXTURE_FAILURE_HOLD admission_status=00 stop_status=0\n',
    'PAYLOAD_FIXTURE_FAILURE_HOLD admission_status=-1 stop_status=0\n'];
  for (const status of [0,2]) {
    for (const stdout of [...malformed,
      status === 0 ? 'PAYLOAD_FIXTURE_FAILURE_HOLD admission_status=2 stop_status=0\n'
        : 'PAYLOAD_FIXTURE_FAILURE_HOLD admission_status=0 stop_status=0\n']) {
      let wrapperFailure;
      const result = await holdFailedRecoveryFixtures([{}], () => {
        try {
          runFixtureCommand(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(stdout)},()=>process.exit(${status}))`], {
            fixtureFailureHoldContext: POST_RESTORE_HOLD_CONTEXT,
          });
        } catch (error) { wrapperFailure = error; throw error; }
      });
      assert.ok(wrapperFailure instanceof FixtureFailure, 'malformed protocol must actually throw, even on process exit 0');
      assert.equal(wrapperFailure.fixtureFailureHold, undefined);
      if (status === 0) assert.equal(wrapperFailure.code, 'post_restore_fixture_hold_protocol_invalid');
      assert.equal(result[0].admissionClosed, false);
      assert.equal(result[0].writersStopped, false);
      assert.doesNotMatch(JSON.stringify(result), /private-output|private-secret/u);
    }
  }
  assert.equal(parseFixtureFailureHold('PAYLOAD_FIXTURE_FAILURE_HOLD admission_status=0 stop_status=0\n',
    { status: 0, errorCode: 'ETIMEDOUT' }), null);
  assert.equal(parseFixtureFailureHold('PAYLOAD_FIXTURE_FAILURE_HOLD admission_status=2 stop_status=0\n',
    { status: 43 }), null);
  // Outside explicit context, the generic wrapper does not attach a hold result.
  assert.throws(() => runFixtureCommand(process.execPath, ['-e',
    "process.stdout.write('PAYLOAD_FIXTURE_FAILURE_HOLD admission_status=2 stop_status=0\\n',()=>process.exit(2))"]), error => {
    assert.equal(error.fixtureFailureHold, undefined);
    return true;
  });
  assert.deepEqual(createRecoveryFailureReportFields({ primaryError: primary }), before);
});
