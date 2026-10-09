import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { assertConversionFixtureConfiguration, verifyLinuxConversionPrerequisite } from '../../scripts/integration/payload-logical-snapshot-conversion-probe.mjs';
import { FixtureFailure } from '../../scripts/integration/payload-preauthority-command.mjs';
import { snapshotComponents } from '../../scripts/integration/payload-preauthority-snapshot.mjs';

const baseline = () => Object.fromEntries(snapshotComponents.map((component, index) => [component, String(index).repeat(64)]));
const rejection = () => new FixtureFailure('fixture_command_failed', {
  commandExitCode: 2, commandError: null, logicalSnapshotErrorIdentifier: 'logical_snapshot_unsupported_object',
});

test('conversion runtime configuration accepts only the existing disposable source project, paths and exact Compose arguments', () => {
  const runtimeDirectory = '/private/disposable/source/runtime';
  const project = 'payload-preauth-a-1-1-source';
  const release = '/private/disposable/source/releases/payload-candidate';
  const configuration = { project, runtimeDirectory, python: 'python3', composeArgs: [
    '--profile', 'notifications', '--env-file', `${runtimeDirectory}/fixture.runtime.conf`, '--env-file', `${release}/.image-env`,
    '-f', `${release}/docker-compose.yml`, '-f', `${release}/docker-compose.payload.yml`, '-f', `${runtimeDirectory}/compose.fixture.yaml`,
    '-f', `${runtimeDirectory}/compose.payload.production.yaml`, '--project-name', project, '--project-directory', release,
  ] };
  const environment = { COMPOSE_PROJECT_NAME: project, PORTAL_OPERATION_LOCK: `${runtimeDirectory}/deploy.lock`,
    PORTAL_OPERATION_LOCK_HELD: `${runtimeDirectory}/deploy.lock` };
  assert.doesNotThrow(() => assertConversionFixtureConfiguration(configuration, environment));
  for (const invalid of [
    { ...configuration, project: 'ownerinc-portal-prod' },
    { ...configuration, project: 'payload-preauth-a-1-1-target' },
    { ...configuration, runtimeDirectory: '/production/runtime' },
    { ...configuration, runtimeDirectory: '/private/disposable/source/../source/runtime' },
    { ...configuration, composeArgs: [...configuration.composeArgs, '--project-name', 'ownerinc-portal-prod'] },
    { ...configuration, composeArgs: configuration.composeArgs.map(value => value === project ? 'ownerinc-portal-prod' : value) },
    { ...configuration, composeArgs: configuration.composeArgs.map(value => value === release ? '/production/release' : value) },
    { ...configuration, composeArgs: configuration.composeArgs.map(value => value.endsWith('.runtime.conf') ? '/production/.env' : value) },
    { ...configuration, python: null },
  ]) assert.throws(() => assertConversionFixtureConfiguration(invalid, environment), /invalid_probe_configuration/u);
  for (const invalid of [{ ...environment, COMPOSE_PROJECT_NAME: 'ownerinc-portal-prod' },
    { ...environment, PORTAL_OPERATION_LOCK: '/production/deploy.lock' },
    { ...environment, PORTAL_OPERATION_LOCK_HELD: '' }]) {
    assert.throws(() => assertConversionFixtureConfiguration(configuration, invalid), /invalid_probe_configuration/u);
  }
});

// These callbacks are orchestration doubles, NOT PostgreSQL proof. The actual
// Linux recovery runner uses direct psql DDL/catalog SQL + the real capture/CLI.
function harness(overrides = {}) {
  const calls = []; const names = []; const steps = [];
  let snapshots = 0;
  const operations = {
    step: value => { steps.push(value); },
    assertStopped: async () => { calls.push('stopped'); },
    snapshot: async () => { calls.push(`snapshot${++snapshots}`); return baseline(); },
    create: async name => { calls.push('create'); names.push(name); },
    present: async name => { calls.push('present'); names.push(name); return true; },
    captureActual: async () => { calls.push('capture'); throw rejection(); },
    remove: async name => { calls.push('remove'); names.push(name); },
    ...overrides,
  };
  return { operations, calls, names, steps };
}

test('conversion orchestration requires stopped writers, presence, actual rejection, own cleanup and all-store equality in order', async () => {
  const h = harness();
  await verifyLinuxConversionPrerequisite(h.operations);
  assert.deepEqual(h.calls, ['stopped', 'snapshot1', 'create', 'present', 'capture', 'remove', 'stopped', 'snapshot2']);
  assert.deepEqual(h.steps, ['conversion_baseline', 'conversion_create', 'conversion_catalog_presence',
    'conversion_require_rejection', 'conversion_cleanup', 'conversion_compare_all_stores', 'conversion_compare_all_stores']);
  assert.match(h.names[0], /^fixture_conversion_[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/u);
  assert.equal(new Set(h.names).size, 1, 'cleanup addresses only this successfully created UUID fixture');
  const other = harness();
  await verifyLinuxConversionPrerequisite(other.operations);
  assert.notEqual(other.names[0], h.names[0], 'every invocation owns a fresh UUID, never a fixed or production name');
});

test('Linux DDL capability failure is the primary error, never a skip or rejection proof, and cannot DROP an uncreated object', async () => {
  for (const sqlState of ['58P01', '0A000', '42710']) {
    const primary = new FixtureFailure('fixture_command_failed', { sqlState, commandExitCode: 3 });
    const h = harness({ create: async () => { throw primary; } });
    await assert.rejects(verifyLinuxConversionPrerequisite(h.operations), error => error === primary);
    assert.deepEqual(h.calls, ['stopped', 'snapshot1', 'stopped', 'snapshot2']);
    assert.equal(h.steps.at(-1), 'conversion_create');
    assert.deepEqual(h.names, [], 'not even duplicate-object DDL may authorize cleanup');
  }
});

test('conversion presence failure never calls capture; cleanup is limited to the own created name', async () => {
  const h = harness({ present: async () => false });
  await assert.rejects(verifyLinuxConversionPrerequisite(h.operations), { code: 'logical_snapshot_conversion_presence_failed' });
  assert.equal(h.calls.includes('capture'), false);
  assert.deepEqual(h.calls, ['stopped', 'snapshot1', 'create', 'remove', 'stopped', 'snapshot2']);
  assert.equal(h.names[0], h.names[1]);
});

test('successful capture, SQL/transport failures and unrelated CLI failures cannot pass the conversion prerequisite', async () => {
  const failures = [
    new Error('logical_snapshot_unsupported_object'),
    new FixtureFailure('fixture_command_failed', { commandExitCode: 3, sqlState: '58P01' }),
    new FixtureFailure('fixture_command_failed', { commandExitCode: 1, logicalSnapshotErrorIdentifier: 'logical_snapshot_unsupported_object' }),
    new FixtureFailure('fixture_command_failed', { commandExitCode: 2, commandError: 'command_timeout', logicalSnapshotErrorIdentifier: 'logical_snapshot_unsupported_object' }),
    new FixtureFailure('fixture_command_failed', { commandExitCode: 2, commandSignal: 'SIGTERM', logicalSnapshotErrorIdentifier: 'logical_snapshot_unsupported_object' }),
    new FixtureFailure('fixture_command_failed', { commandExitCode: 2, logicalSnapshotErrorIdentifier: 'logical_snapshot_failed' }),
  ];
  for (const primary of failures) {
    const h = harness({ captureActual: async () => { throw primary; } });
    await assert.rejects(verifyLinuxConversionPrerequisite(h.operations), error => error === primary);
    assert.equal(h.calls.includes('remove'), true);
    assert.equal(h.calls.at(-1), 'snapshot2', 'cleanup is followed by original full baseline verification even after a primary failure');
  }
  const accepted = harness({ captureActual: async () => baseline() });
  await assert.rejects(verifyLinuxConversionPrerequisite(accepted.operations), { code: 'logical_snapshot_conversion_not_rejected' });
  assert.equal(accepted.calls.includes('remove'), true);
});

test('original failure survives cleanup or comparison failure; cleanup-only failure also fails closed', async () => {
  const primary = new FixtureFailure('primary_capture_failed');
  const cleanup = new FixtureFailure('cleanup_failed');
  const h = harness({ captureActual: async () => { throw primary; }, remove: async () => { throw cleanup; } });
  await assert.rejects(verifyLinuxConversionPrerequisite(h.operations), error => error === primary);
  assert.equal(h.steps.at(-1), 'conversion_require_rejection');
  const onlyCleanup = harness({ remove: async () => { throw cleanup; } });
  await assert.rejects(verifyLinuxConversionPrerequisite(onlyCleanup.operations), error => error === cleanup);
  assert.equal(onlyCleanup.steps.at(-1), 'conversion_cleanup');
  let snapshots = 0;
  const comparison = harness({ captureActual: async () => { throw primary; }, snapshot: async () => {
    if (++snapshots === 1) return baseline();
    throw new FixtureFailure('comparison_failed');
  } });
  await assert.rejects(verifyLinuxConversionPrerequisite(comparison.operations), error => error === primary);
  assert.equal(snapshots, 2);
});

test('post-cleanup comparison independently rejects changes in each of the six original components', async () => {
  for (const component of snapshotComponents) {
    let snapshots = 0;
    const h = harness({ snapshot: async () => ++snapshots === 1 ? baseline() : { ...baseline(), [component]: 'f'.repeat(64) } });
    await assert.rejects(verifyLinuxConversionPrerequisite(h.operations), error => {
      assert.equal(error.code, 'restored_snapshot_mismatch');
      assert.equal(error.snapshotMismatch[0].component, component);
      return true;
    });
    assert.equal(h.calls.includes('remove'), true);
  }
});

test('writers/baseline failure cannot authorize DDL; resumed writers cannot authorize equality', async () => {
  const primary = new FixtureFailure('logical_snapshot_conversion_writers_active');
  for (const operation of ['assertStopped', 'snapshot']) {
    const h = harness({ [operation]: async () => { throw primary; } });
    await assert.rejects(verifyLinuxConversionPrerequisite(h.operations), error => error === primary);
    assert.equal(h.calls.includes('create'), false);
    assert.equal(h.calls.includes('remove'), false);
  }
  let checks = 0;
  const resumed = harness({ assertStopped: async () => { if (++checks === 2) throw primary; } });
  await assert.rejects(verifyLinuxConversionPrerequisite(resumed.operations), error => error === primary);
  assert.equal(resumed.calls.includes('remove'), true);
  assert.equal(resumed.calls.includes('snapshot2'), false);
});

test('actual recovery runner wires direct Linux conversion prerequisite under lease before the existing quiescence flag and restart', async () => {
  const runner = await readFile('scripts/test-payload-preauthority-recovery.mjs', 'utf8');
  const checks = runner.match(/const safeChecks = \{([\s\S]*?)\n\};/u)?.[1];
  assert.ok(checks);
  assert.equal((checks.match(/: false,/gu) || []).length, 14, 'no fifteenth report check');
  const start = runner.indexOf('async function assertQuiescentSnapshotStable(runtime)');
  const end = runner.indexOf('function snapshotWithWritersStopped', start);
  const section = runner.slice(start, end === -1 ? runner.indexOf('\nasync function ', start + 1) : end);
  const probe = section.indexOf('payload-logical-snapshot-conversion-probe.mjs');
  assert.ok(probe > 0);
  assert.ok(section.indexOf("composeWithLease(runtime, ['stop'") < probe);
  assert.ok(section.indexOf("if (runtime.role === 'source')") < probe);
  assert.match(section, /withLease\(runtime, runtime\.project, process\.execPath/u);
  assert.match(section, /composeArgs: composeArgs\(runtime\.project, runtime\.payloadRelease, runtime, \[\]\)/u);
  assert.match(section, /timeout: 15 \* 60_000/u);
  const protocol = section.indexOf("conversion.toString('utf8') !== 'PAYLOAD_LINUX_CONVERSION_PREREQUISITE passed\\n'");
  assert.ok(probe < protocol);
  assert.ok(protocol < section.indexOf("quiescentSnapshotComparison = 'passed'"));
  assert.ok(protocol < section.indexOf('runtime.quiescentSnapshotStable = true'));
  assert.ok(section.indexOf('runtime.quiescentSnapshotStable = true') < section.indexOf("composeWithLease(runtime, ['start'"));
  assert.doesNotMatch(section, /negativeCases\.push|safeChecks\.[a-zA-Z]+\s*=/u);
  const probeCode = await readFile('scripts/integration/payload-logical-snapshot-conversion-probe.mjs', 'utf8');
  assert.match(probeCode, /process\.platform !== 'linux' \|\| process\.getuid\(\) !== 0/u);
  assert.match(probeCode, /payload-preauth-\[a-z0-9-\]\+-source/u);
  assert.match(probeCode, /fstatSync\(9, \{ bigint: true \}\)/u);
  assert.match(probeCode, /lease\.dev !== lock\.dev \|\| lease\.ino !== lock\.ino/u);
  assert.match(probeCode, /compose\(\['exec', '-T', 'postgres', 'psql'/u);
  assert.match(probeCode, /CREATE CONVERSION public\."\$\{name\}" FOR 'UTF8' TO 'LATIN1' FROM pg_catalog\.utf8_to_iso8859_1/u);
  assert.match(probeCode, /SELECT count\(\*\)::text FROM pg_conversion/u);
  assert.match(probeCode, /input: logicalSnapshotScript/u);
  assert.match(probeCode, /payload-logical-snapshot-cli\.mjs/u);
  assert.match(probeCode, /logicalSnapshotCommandContext: 'logical-snapshot-cli'/u);
  assert.match(section, /conversionProbeCommandContext: CONVERSION_PROBE_CONTEXT/u);
  assert.match(probeCode, /DROP CONVERSION public\."\$\{name\}"/u);
  assert.doesNotMatch(probeCode, /DROP CONVERSION IF EXISTS|nextval|t\.skip|nativeCatalogFingerprint|negativeCases/u);
});
