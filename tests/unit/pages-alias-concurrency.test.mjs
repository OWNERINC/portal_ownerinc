import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { waitForAliasLock } from '../../scripts/test-pages-alias-concurrency.mjs';

test('native alias race refuses missing disposable authorization before opening a connection', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { testPagesAliasConcurrency } from './scripts/test-pages-alias-concurrency.mjs'; await testPagesAliasConcurrency();"], {
    encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_ENV: 'production', MIGRATION_TEST_DISPOSABLE: '' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot run with NODE_ENV=production/);
});

test('lock observer rejects a completed operation instead of treating fast serialization as concurrency', async () => {
  await assert.rejects(waitForAliasLock({ query: async () => ({ rows: [] }) }, 1, 2, 'advisory', { settled: true }),
    /settled without observed advisory contention/);
});

test('lock observer times out without evidence instead of reporting success after a delay', async () => {
  await assert.rejects(waitForAliasLock({ query: async () => ({ rows: [] }) }, 1, 2, 'advisory', { settled: false }, 0),
    /Timed out observing advisory contention/);
});
