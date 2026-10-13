import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRecoveryProgress } from '../../scripts/integration/payload-preauthority-progress.mjs';
import { qualifyCandidate } from '../../scripts/lib/payload-candidate-qualification.mjs';
import { FixtureFailure } from '../../scripts/integration/payload-preauthority-command.mjs';
import { createRecoveryFailureReportFields } from '../../scripts/integration/payload-preauthority-recovery-flow.mjs';

async function fixture(t) {
  const parent = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  const root = await mkdtemp(path.join(parent, 'recovery-progress-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkpoint = path.join(root, 'progress.json');
  const lines = [];
  const alerts = [];
  let now = 100;
  return { root, checkpoint, lines, alerts, progress: createRecoveryProgress({ checkpoint,
    writeConsole: line => lines.push(line), alert: line => alerts.push(line), clock: () => now++ }) };
}

test('real serialization and checkpoint redact unknown labels, fake child output and exception text', async t => {
  const f = await fixture(t);
  const secret = 'https://user:password@private.invalid/sql?token=secret';
  f.progress.transition(secret, secret);
  f.progress.substep(secret);
  const error = new Error(secret);
  assert.throws(() => f.progress.command({ category: secret, role: secret, substep: secret, timeoutMs: 900000 }, () => {
    throw error;
  }), value => value === error);
  assert.equal(f.progress.command({ category: 'docker', timeoutMs: 180000 }, () => Buffer.from(secret)).toString(), secret);
  f.progress.finish('failed');
  const records = f.lines.map(line => JSON.parse(line));
  assert.equal(records.at(-1).event, 'stage_end');
  assert.ok(records.length >= 4);
  for (const [index, record] of records.entries()) {
    assert.deepEqual(Object.keys(record), ['schemaVersion', 'artifactKind', 'qualifiesAcceptance', 'sequence',
      'elapsedMs', 'stage', 'substep', 'fixtureRole', 'event', 'commandCategory', 'timeoutMs', 'outcome', 'firstFailure']);
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.artifactKind, 'diagnostic-progress');
    assert.equal(record.qualifiesAcceptance, false);
    assert.equal(record.sequence, index + 1);
    assert.ok(Number.isSafeInteger(record.elapsedMs) && record.elapsedMs >= 0);
    assert.ok(index === 0 || record.elapsedMs >= records[index - 1].elapsedMs);
    assert.ok(Buffer.byteLength(JSON.stringify(record)) < 1024);
  }
  assert.ok(!f.lines.join('').includes(secret));
  assert.deepEqual(records.filter(record => record.event === 'command_end').map(record => record.outcome), ['failed', 'completed']);
  assert.equal(records.find(record => record.event === 'command_begin').commandCategory, 'unknown');
  assert.equal(records.find(record => record.event === 'command_begin').stage, 'unknown');
  assert.equal(records.find(record => record.event === 'command_begin').substep, 'unknown');
  assert.equal(records.find(record => record.event === 'command_begin').fixtureRole, 'unknown');
  assert.deepEqual(JSON.parse(await readFile(f.checkpoint, 'utf8')), records.at(-1));
  assert.deepEqual(await readdir(f.root), ['progress.json']);
});

test('command begin checkpoint precedes execution; end preserves result/error and exact selected timeout', async t => {
  const f = await fixture(t);
  f.progress.transition('prepare', 'source');
  f.progress.substep('payload_initialize_isolated');
  const before = f.lines.length;
  f.progress.transition('prepare', 'source');
  f.progress.substep('payload_initialize_isolated');
  assert.equal(f.lines.length, before, 'unchanged stage and substep are deduplicated');
  const value = { privateOutput: 'not serialized' };
  assert.equal(f.progress.command({ category: 'control', timeoutMs: 123456 }, () => {
    assert.equal(JSON.parse(f.lines.at(-1)).event, 'command_begin');
    assert.equal(JSON.parse(f.lines.at(-1)).timeoutMs, 123456);
    return value;
  }), value);
  const last = JSON.parse(await readFile(f.checkpoint, 'utf8'));
  assert.equal(last.event, 'command_end');
  assert.equal(last.outcome, 'completed');
  assert.equal(last.fixtureRole, 'source');
});

test('a real child interrupted after begin leaves an atomic, nonqualifying latest checkpoint', async t => {
  const f = await fixture(t);
  const moduleUrl = new URL('../../scripts/integration/payload-preauthority-progress.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { createRecoveryProgress } from ${JSON.stringify(moduleUrl)}; const p=createRecoveryProgress({checkpoint:${JSON.stringify(f.checkpoint)}}); p.transition('first_actual_restore','target'); p.command({category:'coordinator_restore',timeoutMs:900000},()=>process.exit(7));`],
  { encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 7, child.stderr);
  const raw = await readFile(f.checkpoint);
  assert.equal(JSON.parse(raw).event, 'command_begin');
  assert.equal(JSON.parse(raw).qualifiesAcceptance, false);
  const expectedRun = { commit: 'a'.repeat(40), runId: '123', runAttempt: '1' };
  const expectedImages = Object.fromEntries(['api', 'cron', 'cms'].map(service =>
    [service, `ghcr.io/ownerinc/ownerinc-portal-${service}@sha256:${'b'.repeat(64)}`]));
  assert.throws(() => qualifyCandidate({ candidateBytes: Buffer.from(JSON.stringify({schemaVersion: 1, ...expectedRun, images: expectedImages})),
    reportBytes: raw, expectedRun, expectedImages }), /invalid_recovery_report_shape/u);
});

test('diagnostic write failure cannot replace an operational failure or skip a hold (operation doubles)', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'not-a-directory'), 'private secret');
  const alerts = [];
  const p = createRecoveryProgress({ checkpoint: path.join(f.root, 'not-a-directory', 'progress.json'),
    writeConsole: () => {}, alert: line => alerts.push(line) });
  const primary = new Error('secret primary error');
  let held = false;
  assert.throws(() => p.command({ category: 'docker', timeoutMs: 180000 }, () => { throw primary; }), error => error === primary);
  await p.boundary('failure_holds', async () => { held = true; });
  assert.equal(held, true);
  assert.deepEqual(alerts, ['Payload recovery diagnostic progress unavailable.\n']);
});

test('latest hold checkpoint retains only the first normalized failure despite later context and failure changes', async t => {
  const f = await fixture(t);
  const first = { stage: 'quiescent_snapshot', substep: 'snapshot_compare_quiescent', fixtureRole: 'source' };
  f.progress.transition('restart_writers', 'target');
  f.progress.failure({ stage: first.stage, substep: first.substep, role: first.fixtureRole, errorCode: 'private ignored error' });
  f.progress.transition('second_actual_restore', 'leaseTarget');
  f.progress.failure({ stage: 'second_actual_restore', substep: 'verify_restored_authority', role: 'leaseTarget' });
  await f.progress.boundary('failure_holds', async () => {
    const checkpoint = JSON.parse(await readFile(f.checkpoint, 'utf8'));
    assert.equal(checkpoint.event, 'boundary_begin');
    assert.equal(checkpoint.commandCategory, 'failure_holds');
    assert.equal(checkpoint.stage, 'second_actual_restore');
    assert.deepEqual(checkpoint.firstFailure, first);
  });
  const records = f.lines.map(line => JSON.parse(line));
  const captured = records.findIndex(record => record.event === 'failure_captured');
  for (const record of records.slice(captured)) {
    assert.deepEqual(record.firstFailure, first);
    assert.ok(Buffer.byteLength(JSON.stringify(record) + '\n') <= 1024);
  }
  assert.doesNotMatch(f.lines.join(''), /private ignored error/u);
});

test('first-failure labels are finite and remain latched when the initial checkpoint write fails', async t => {
  const f = await fixture(t);
  const blocked = path.join(f.root, 'blocked');
  await writeFile(blocked, 'private fixture');
  const checkpoint = path.join(blocked, 'progress.json');
  const lines = [];
  const alerts = [];
  const progress = createRecoveryProgress({ checkpoint, writeConsole: line => lines.push(line), alert: line => alerts.push(line) });
  const secret = 'https://user:password@private.invalid/private-project';
  progress.failure({ stage: secret, substep: secret, role: secret, errorCode: secret });
  await rm(blocked);
  progress.failure({ stage: 'first_actual_restore', substep: 'compare_restored_stores', role: 'target' });
  await progress.boundary('failure_holds', async () => {
    assert.deepEqual(JSON.parse(await readFile(checkpoint, 'utf8')).firstFailure,
      { stage: 'unknown', substep: 'unknown', fixtureRole: 'unknown' });
  });
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line) <= 1024);
    assert.deepEqual(JSON.parse(line).firstFailure, { stage: 'unknown', substep: 'unknown', fixtureRole: 'unknown' });
    assert.ok(!line.includes(secret));
  }
  assert.deepEqual(alerts, ['Payload recovery diagnostic progress unavailable.\n']);
});

test('actual runner wrapper preserves command options and reports the resolved timeout (command transport double)', async t => {
  const f = await fixture(t);
  const source = await readFile('scripts/test-payload-preauthority-recovery.mjs', 'utf8');
  const body = source.slice(source.indexOf('function run(command,'), source.indexOf('function text(result)'));
  const calls = [];
  const run = new Function('progress', 'runFixtureCommand', 'python', 'repository', 'safeEnvironment', 'activeSubstep', 'privateCommandEvidence',
    `${body}\nreturn run;`)(f.progress, (...args) => { calls.push(args); return 'secret child output'; },
    'python3', '/private/checkout', value => value, 'fixture_full_smoke', []);
  const args = ['https://private.invalid/?secret=password'];
  for (const timeout of [undefined, 0, 900000, 123456]) {
    const input = Buffer.from('private SQL');
    assert.equal(run('private-command', args, { timeout, input, maxBuffer: 777, env: { SECRET: 'password' } }), 'secret child output');
    const [, observedArgs, options] = calls.at(-1);
    assert.equal(observedArgs, args);
    assert.equal(options.timeout, timeout);
    assert.equal(options.input, input);
    assert.equal(options.maxBuffer, 777);
    assert.deepEqual(options.env, { SECRET: 'password' });
    assert.equal(JSON.parse(f.lines.at(-1)).timeoutMs, timeout || 180000);
  }
  run('private-command', args, { controlCommandContext: 'private SQL', smokeCommandContext: 'password' });
  assert.equal(JSON.parse(f.lines.at(-1)).commandCategory, 'unknown');
  assert.doesNotMatch(f.lines.join(''), /password|private-command|secret child output|private SQL/u);
});

test('actual runner failure block freezes the primary before holds and retains snapshot priority despite diagnostic I/O failure', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'blocked'), 'not a directory');
  const source = await readFile('scripts/test-payload-preauthority-recovery.mjs', 'utf8');
  const contextBody = source.slice(source.indexOf('function progressFailureContext('), source.indexOf('function composeArgs('));
  assert.match(contextBody, /function progressFailureContext/u);
  const marker = '} catch (error) {';
  const start = source.lastIndexOf(marker);
  const end = source.indexOf('\n}\n\nlet reportWritten', start);
  assert.ok(start > 0 && end > start);
  const catchBody = source.slice(start + marker.length, end);
  // Execute the real catch block; only operational holds/evidence are doubled.
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('progress', 'FixtureFailure', 'createRecoveryFailureReportFields', 'failureReportFields', 'observeHold', `
    const error = new FixtureFailure(failureReportFields ? 'restart_failure' : 'original_failure',
      { substep: failureReportFields ? 'snapshot_restart_writers' : 'compare_restored_stores' });
    let stage=failureReportFields ? 'restart_writers_source' : 'first_actual_restore';
    let activeSubstep=error.diagnostic.substep, preserveFixture=false, report;
    const trace=[], fixtureRoot='/private/fixture', runtimeRefs=[{role:'source',project:'private-generated-source'}],
      privateCommandEvidence=[], runIdentity={}, images={}, safeChecks={}, negativeCases=[];
    ${contextBody}
    const restoreAcceptanceProgress={first:{coordinatorReturnedSuccessfully:true}};
    const holdFailedRecoveryFixtures=async()=>{trace.push('hold');await observeHold();stage='changed_by_hold';activeSubstep='changed_by_hold';return [];};
    const persistPrivateCommandEvidence=async()=>{throw new Error('private evidence failure');};
    const privateSnapshotEvidence={persist:async()=>{throw new Error('private snapshot failure');}};
    const recoveryProgress={}, createRecoveryProgressReport=()=>({});
    ${catchBody}
    return {report,trace};
  `);
  for (const ioFailure of [false, true]) {
    for (const earlier of [null, { failedStage: 'quiescent_snapshot_private-generated-source', failedSubstep: 'snapshot_compare_quiescent', failureCode: 'snapshot_failed' }]) {
      const lines = [];
      const checkpoint = path.join(f.root, ioFailure ? 'blocked' : '.', `progress-${Boolean(earlier)}.json`);
      const progress = createRecoveryProgress({ checkpoint, writeConsole: line => lines.push(line), alert: () => {} });
      progress.transition(earlier ? 'restart_writers' : 'first_actual_restore', earlier ? 'source' : 'global');
      progress.substep(earlier ? 'snapshot_restart_writers' : 'compare_restored_stores');
      const firstFailure = { stage: earlier ? 'quiescent_snapshot' : 'first_actual_restore',
        substep: earlier ? 'snapshot_compare_quiescent' : 'compare_restored_stores', fixtureRole: earlier ? 'source' : 'global' };
      const { report, trace } = await execute(progress, FixtureFailure, createRecoveryFailureReportFields, earlier, async () => {
        const record = JSON.parse(ioFailure ? lines.at(-1) : await readFile(checkpoint, 'utf8'));
        assert.equal(record.event, 'boundary_begin');
        assert.equal(record.commandCategory, 'failure_holds');
        assert.equal(record.stage, earlier ? 'restart_writers' : 'first_actual_restore');
        assert.deepEqual(record.firstFailure, firstFailure);
      });
      assert.deepEqual(trace, ['hold']);
      assert.equal(report.failedStage, earlier?.failedStage || 'first_actual_restore');
      assert.equal(report.failedSubstep, earlier?.failedSubstep || 'compare_restored_stores');
      assert.equal(report.failureCode, earlier?.failureCode || 'original_failure');
      assert.equal(report.evidence.privateRunnerErrorEvidenceRetained, false);
      assert.equal(report.evidence.privateSnapshotEvidenceRetained, false);
      const records = lines.map(line => JSON.parse(line));
      for (const record of records.slice(records.findIndex(record => record.event === 'failure_captured'))) {
        assert.deepEqual(record.firstFailure, firstFailure);
        assert.ok(Buffer.byteLength(JSON.stringify(record) + '\n') <= 1024);
      }
      assert.doesNotMatch(lines.join(''), /private-generated-source|\/private\/fixture|private evidence failure|private snapshot failure|changed_by_hold|original_failure|snapshot_failed/u);
    }
  }
});

test('dynamic failure stages map only exact known runtime identities, never arbitrary sanitized prefixes', async t => {
  const f = await fixture(t);
  const source = await readFile('scripts/test-payload-preauthority-recovery.mjs', 'utf8');
  const body = source.slice(source.indexOf('function progressFailureContext('), source.indexOf('function composeArgs('));
  const normalize = new Function('runtimeRefs', `${body}\nreturn progressFailureContext;`)([
    { role: 'source', project: 'private-source-project' }, { role: 'target', project: 'private-target-project' },
  ]);
  assert.deepEqual(normalize('quiescent_snapshot_private-source-project', 'snapshot_compare_quiescent'),
    { stage: 'quiescent_snapshot', substep: 'snapshot_compare_quiescent', role: 'source' });
  assert.deepEqual(normalize('restart_writers_target', 'snapshot_restart_writers'),
    { stage: 'restart_writers', substep: 'snapshot_restart_writers', role: 'target' });
  const malicious = 'quiescent_snapshot_private_unrecognized_token';
  f.progress.failure(normalize(malicious, 'secret_sql_or_error_text'));
  const record = JSON.parse(await readFile(f.checkpoint, 'utf8'));
  assert.deepEqual(record.firstFailure, { stage: 'unknown', substep: 'unknown', fixtureRole: 'global' });
  assert.doesNotMatch(f.lines.join(''), /private-source-project|private-target-project|unrecognized_token|secret_sql_or_error_text/u);
});

test('terminal-report write failure emits a closed diagnostic, preserves the failed report, and cannot announce PASS', async t => {
  const f = await fixture(t);
  const source = await readFile('scripts/test-payload-preauthority-recovery.mjs', 'utf8');
  const terminal = source.slice(source.indexOf('let reportWritten = false;'));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('progress', 'report', 'writeReport', 'console', 'process', terminal);
  for (const status of ['passed', 'failed']) {
    const report = { status, failureCode: 'original_failure' };
    const output = [];
    const processDouble = {};
    await execute(f.progress, report, async () => { throw new Error('secret filesystem path'); },
      { error: line => output.push(line), log: line => output.push(line) }, processDouble);
    assert.equal(processDouble.exitCode, 1);
    assert.deepEqual(report, { status, failureCode: 'original_failure' });
    assert.deepEqual(output, ['Payload recovery terminal report unavailable.']);
    assert.equal(JSON.parse(f.lines.at(-1)).outcome, 'failed');
  }
});

test('diagnostic checkpoint cannot overwrite the final report even with a colliding configured path', async t => {
  const f = await fixture(t);
  await writeFile(f.checkpoint, 'original qualification report');
  const alerts = [];
  const progress = createRecoveryProgress({ checkpoint: f.checkpoint, reportPath: f.checkpoint,
    writeConsole: () => {}, alert: line => alerts.push(line) });
  progress.transition('validate_inputs');
  assert.equal(await readFile(f.checkpoint, 'utf8'), 'original qualification report');
  assert.equal(alerts.length, 1);
});

test('workflow keeps the final report artifact exact and uploads only an explicit separate nonqualifying checkpoint', async () => {
  const source = await readFile('.github/workflows/ci.yml', 'utf8');
  const recovery = source.slice(source.indexOf('      - name: Run disposable four-store'), source.indexOf('      - name: Upload redacted preauthority'));
  assert.match(recovery, /timeout-minutes: 60/u);
  assert.match(recovery, /PAYLOAD_RECOVERY_PROGRESS="\$RECOVERY_PROGRESS"/u);
  const report = source.slice(source.indexOf('      - name: Upload redacted preauthority'), source.indexOf('      - name: Upload nonqualifying'));
  assert.match(report, /path: \$\{\{ runner.temp \}\}\/payload-preauthority-recovery-report.json\n/u);
  assert.doesNotMatch(report, /progress|path: \|/u);
  const diagnostic = source.slice(source.indexOf('      - name: Upload nonqualifying'), source.indexOf('      - name: Create recovery-qualified'));
  assert.match(diagnostic, /always\(\)/u);
  assert.match(diagnostic, /continue-on-error: true/u);
  assert.match(diagnostic, /path: \$\{\{ runner.temp \}\}\/payload-preauthority-recovery-progress.json\n/u);
  assert.doesNotMatch(diagnostic, /fixtures|\*\*|path: \|/u);
  assert.match(source, /--candidate candidate.json --report "\$RECOVERY_REPORT"/u);
});
