import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

export function nestedTestEnvironment(environment) {
  const child = { ...environment };
  // Node 24 treats this inherited worker marker as a recursive run and skips
  // all files. Remove only that reserved marker, not ordinary application env.
  delete child.NODE_TEST_CONTEXT;
  return child;
}

export function runNestedTest(file, name, { cwd, env = process.env } = {}) {
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap',
    `--test-name-pattern=^${escapeRegex(name)}$`, file], {
    cwd, env: nestedTestEnvironment(env), encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024,
  });
}

export function assertSingleTestPassed(result, name) {
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /^TAP version 13\r?$/mu);
  assert.match(result.stdout, new RegExp(`^ok 1 - ${escapeRegex(name)}\\r?$`, 'mu'));
  const plans = [...result.stdout.matchAll(/^1\.\.(\d+)\r?$/gmu)];
  assert.equal(plans.length, 1, 'missing or ambiguous TAP plan');
  assert.equal(Number(plans[0][1]), 1);
  for (const [counter, expected] of Object.entries({ tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 })) {
    const values = [...result.stdout.matchAll(new RegExp(`^# ${counter} (\\d+)\\r?$`, 'gmu'))];
    assert.equal(values.length, 1, `missing or ambiguous TAP counter: ${counter}`);
    assert.equal(Number(values[0][1]), expected, `unexpected TAP counter: ${counter}`);
  }
}
