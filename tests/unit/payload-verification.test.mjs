import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
