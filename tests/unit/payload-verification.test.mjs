import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { containsPossibleSecret, filesUnder, run } from '../../scripts/verify.mjs';

test('offline syntax discovery includes public mjs and excludes generated/install trees', async t => {
  const temp = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();
  const root = await mkdtemp(path.join(temp, 'payload-verify-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['public', 'public/nested', 'public/node_modules', 'public/.next']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  for (const name of ['one.js', 'nested/two.mjs', 'ignored.ts', 'node_modules/vendor.js', '.next/build.js']) {
    await writeFile(path.join(root, 'public', name), 'export {};');
  }
  assert.deepEqual((await filesUnder(path.join(root, 'public'), ['.js', '.mjs']))
    .map(file => path.relative(root, file).replaceAll('\\', '/')), ['public/nested/two.mjs', 'public/one.js']);
});

test('CMS source extensions cannot hide a private key from the existing scanner', () => {
  const marker = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
  for (const extension of ['.ts', '.tsx', '.scss', '.mjs', '.js']) {
    assert.equal(containsPossibleSecret(`cms/source${extension}`, marker), true);
    assert.equal(containsPossibleSecret(`cms/source${extension}`, 'ordinary source'), false);
  }
});

test('verification preserves a child failure exit and rejects process timeout', () => {
  assert.throws(() => run(process.execPath, ['-e', 'process.exit(23)'], { timeout: 5000 }),
    error => error.exitCode === 23);
  assert.throws(() => run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 100 }),
    error => error.exitCode === 1);
});

async function testStage(platform, parallelism, failRoot = false) {
  const source = await readFile(new URL('../../scripts/verify.mjs', import.meta.url), 'utf8');
  const start = source.indexOf('async function checkTests() {');
  const end = source.indexOf('\nfunction checkCmsTypes()', start);
  assert.ok(start >= 0 && end > start);
  const files = ['tests/unit/first.test.mjs', 'tests/unit/nested/second.test.mjs'];
  const calls = [];
  const failure = new Error('root stage failed');
  // Execute the actual orchestration with process/discovery boundaries doubled.
  const execute = new Function('filesUnder', 'run', 'process', 'console', 'availableParallelism',
    `${source.slice(start, end)}\nreturn checkTests();`);
  const result = execute(async (...args) => {
    assert.deepEqual(args, ['tests/unit', '.test.mjs']);
    return files;
  }, (...args) => {
    calls.push(args);
    if (failRoot) throw failure;
  }, { platform, execPath: 'node-fixture' }, { log() {} }, () => parallelism);
  if (failRoot) await assert.rejects(result, error => error === failure);
  else await result;
  return { calls, files };
}

test('root orchestration bounds Windows file scheduling while preserving inventory, deadlines and CMS sequencing', async () => {
  for (const [platform, parallelism, expected] of [
    ['win32', 16, ['--test-concurrency=4']],
    ['win32', 4, ['--test-concurrency=3']],
    ['win32', 2, ['--test-concurrency=1']],
    ['win32', 1, ['--test-concurrency=1']],
    ['linux', 16, []], ['darwin', 16, []],
  ]) {
    const { calls, files } = await testStage(platform, parallelism);
    assert.deepEqual(calls, [
      ['node-fixture', ['--test', ...expected, ...files], { stdio: 'inherit', timeout: 600000 }],
      ['node-fixture', ['cms/scripts/test.mjs'], { stdio: 'inherit' }],
    ]);
  }
});

test('root failure still prevents the CMS stage with bounded Windows scheduling', async () => {
  const { calls } = await testStage('win32', 16, true);
  assert.equal(calls.length, 1);
});
