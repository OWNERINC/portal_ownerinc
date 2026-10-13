import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertSingleTestPassed, nestedTestEnvironment, runNestedTest } from '../helpers/payload-nested-test.mjs';

test('nested test environment removes only the reserved Node worker context without mutating its caller', () => {
  const inherited = { NODE_TEST_CONTEXT: 'child-v8', PATH: 'fixture-path', HOME: 'fixture-home',
    NODE_OPTIONS: '--no-warnings', FIXTURE_VALUE: 'preserve' };
  assert.deepEqual(nestedTestEnvironment(inherited), { PATH: 'fixture-path', HOME: 'fixture-home',
    NODE_OPTIONS: '--no-warnings', FIXTURE_VALUE: 'preserve' });
  assert.equal(inherited.NODE_TEST_CONTEXT, 'child-v8');
});

test('nested retry adapter runs the exact planned test with inherited child-v8 context', () => {
  const name = 'retry adapter uses only the stage-reviewed grant range and revalidates B0/lease/targets without effects';
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const result = runNestedTest('tests/unit/payload-install-transition.test.mjs', name, {
    cwd, env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' },
  });
  assertSingleTestPassed(result, name);
});

test('nested Node child-v8 run executes exactly the selected test and refuses failure, skip or zero tests', async t => {
  const parent = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  const directory = await mkdtemp(path.join(parent, 'payload-nested-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture.test.mjs');
  const receipt = path.join(directory, 'execution.txt');
  const name = 'reviewed nested fixture [exact]';
  await writeFile(file, `
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import test from 'node:test';
test(${JSON.stringify(name)}, { skip: process.env.FIXTURE_MODE === 'skip' }, () => {
  appendFileSync(${JSON.stringify(receipt)}, 'executed\\n');
  assert.equal(process.env.NODE_TEST_CONTEXT, 'child-v8'); // New worker belongs to the child runner.
  assert.notEqual(process.env.FIXTURE_MODE, 'fail', 'synthetic nested failure');
});
test('unselected test must not execute', () => { throw Error('wrong name pattern'); });
`);
  const run = (mode, selected = name) => runNestedTest(file, selected, {
    cwd: directory, env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8', FIXTURE_MODE: mode },
  });
  const successful = run('pass');
  assertSingleTestPassed(successful, name);
  assert.equal(await readFile(receipt, 'utf8'), 'executed\n', 'exit 0 alone does not prove execution');
  const failed = run('fail');
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^not ok 1 - reviewed nested fixture \[exact\]/mu);
  assert.throws(() => assertSingleTestPassed(failed, name));
  assert.equal(await readFile(receipt, 'utf8'), 'executed\nexecuted\n');
  const skipped = run('skip');
  assert.equal(skipped.status, 0);
  assert.match(skipped.stdout, /^# skipped 1\r?$/mu);
  assert.throws(() => assertSingleTestPassed(skipped, name));
  const absent = run('pass', 'missing planned test');
  assert.equal(absent.status, 0);
  assert.match(absent.stdout, /^1\.\.0\r?$/mu, 'no named subtest executed; Node may still count the file wrapper as PASS');
  assert.throws(() => assertSingleTestPassed(absent, 'missing planned test'));
  assert.throws(() => assertSingleTestPassed({ ...successful, stdout: '' }, name));
  assert.equal(await readFile(receipt, 'utf8'), 'executed\nexecuted\n');
});
