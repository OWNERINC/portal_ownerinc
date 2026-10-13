import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  FIXTURE_STOP_COMMAND_MARGIN_MS,
  FIXTURE_STOP_TIMEOUT_SECONDS,
  fixtureStopCommandTimeoutMs,
} from '../../scripts/integration/payload-preauthority-fixture.mjs';

const recoveryRunner = await readFile(new URL('../../scripts/test-payload-preauthority-recovery.mjs', import.meta.url), 'utf8');

test('stop subprocess deadline covers the per-writer cap serially plus bounded margin', () => {
  assert.equal(FIXTURE_STOP_TIMEOUT_SECONDS, 120);
  assert.equal(FIXTURE_STOP_COMMAND_MARGIN_MS, 30_000);
  assert.equal(fixtureStopCommandTimeoutMs(1), 150_000);
  assert.equal(fixtureStopCommandTimeoutMs(3), 390_000);
  assert.throws(() => fixtureStopCommandTimeoutMs(0), /invalid_fixture_writer_count/u);
  assert.throws(() => fixtureStopCommandTimeoutMs(4), /invalid_fixture_writer_count/u);
});

test('quiescence uses the matching bounded stop flag and verifies all writers before snapshots', () => {
  assert.match(recoveryRunner, /timeout: fixtureStopCommandTimeoutMs\(writers\.length\)/u);
  assert.match(recoveryRunner, /'--timeout', String\(FIXTURE_STOP_TIMEOUT_SECONDS\)/u);
  assert.match(recoveryRunner, /setStage\(`quiescent_snapshot_\$\{runtime\.project\}`\)/u);

  const stop = recoveryRunner.indexOf("substep: 'snapshot_stop_writers'");
  const verify = recoveryRunner.indexOf("setSubstep('snapshot_verify_writers_stopped')");
  const snapshot = recoveryRunner.indexOf('const first = snapshot(runtime)');
  assert.ok(stop >= 0 && verify > stop && snapshot > verify,
    'snapshot capture must follow successful stop and explicit no-running-writers verification');
  assert.match(recoveryRunner, /composeCall\(runtime, \['ps', '--status', 'running', '--services'\]\)/u);
});
