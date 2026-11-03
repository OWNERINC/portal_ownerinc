import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Academy runner and helper load without a database and keep only Academy contracts', async () => {
  const [helper, runner, runnerSource, helperSource] = await Promise.all([
    import('../../tests/helpers/academy-integration.mjs'),
    import('../../scripts/test-academy.mjs?static-contract'),
    readFile('scripts/test-academy.mjs', 'utf8'),
    readFile('tests/helpers/academy-integration.mjs', 'utf8'),
  ]);

  assert.equal(typeof helper.createAcademyHttp, 'function');
  assert.equal(typeof helper.createAcademyIntegration, 'function');
  assert.equal(typeof helper.connectApprovedAcademyDatabase, 'function');
  assert.equal(typeof helper.requireDisposableAcademyDatabase, 'function');
  assert.equal(typeof runner.registerAcademyIntegrationTests, 'function');
  assert.deepEqual(runner.academyRunnerContracts, [
    'catalog-audience-preview',
    'progress-uid-cas-media-version',
    'management-activation-and-media',
    'concurrent-limits-and-reorder',
    'reorder-create-lock-race',
    'audit-rollback-and-historical-preservation',
  ]);
  assert.doesNotMatch(runnerSource, /cms_documents|cms_revisions|cms_assets|enforceCmsAssetRetention|\/api\/cms/);
  assert.match(helperSource, /requireDisposableMigrationEnvironment/);
  assert.match(helperSource, /MIGRATION_DATABASE_URL/);
  assert.match(helperSource, /app\.use\('\/api\/cms', \(req, res\) => res\.status\(404\)/);

  const saved = {
    disposable: process.env.MIGRATION_TEST_DISPOSABLE,
    database: process.env.MIGRATION_DATABASE_URL,
  };
  delete process.env.MIGRATION_TEST_DISPOSABLE;
  delete process.env.MIGRATION_DATABASE_URL;
  try {
    assert.throws(() => helper.requireDisposableAcademyDatabase(), /MIGRATION_TEST_DISPOSABLE=true/);
  } finally {
    if (saved.disposable === undefined) delete process.env.MIGRATION_TEST_DISPOSABLE;
    else process.env.MIGRATION_TEST_DISPOSABLE = saved.disposable;
    if (saved.database === undefined) delete process.env.MIGRATION_DATABASE_URL;
    else process.env.MIGRATION_DATABASE_URL = saved.database;
  }
});

test('Academy disposable connection closes when the cluster identity is rejected', async () => {
  const saved = {
    nodeEnv: process.env.NODE_ENV,
    disposable: process.env.MIGRATION_TEST_DISPOSABLE,
    database: process.env.MIGRATION_DATABASE_URL,
    cluster: process.env.MIGRATION_TEST_CLUSTER_ID,
  };
  process.env.NODE_ENV = 'test';
  process.env.MIGRATION_TEST_DISPOSABLE = 'true';
  process.env.MIGRATION_DATABASE_URL = 'postgresql://not-used@example.invalid/never-connect';
  process.env.MIGRATION_TEST_CLUSTER_ID = '7704035034504839201';
  let released = false;
  let ended = false;
  class FakePool {
    async connect() {
      return {
        query: async () => ({ rows: [{ database_name: 'portal', cluster_id: 'other-cluster' }] }),
        release() { released = true; },
      };
    }
    async end() { ended = true; }
  }
  try {
    await assert.rejects(
      () => import('../../tests/helpers/academy-integration.mjs').then(({ connectApprovedAcademyDatabase }) =>
        connectApprovedAcademyDatabase(FakePool)),
      /approved disposable cluster/,
    );
    assert.equal(released, true);
    assert.equal(ended, true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      const envKey = { nodeEnv: 'NODE_ENV', disposable: 'MIGRATION_TEST_DISPOSABLE', database: 'MIGRATION_DATABASE_URL', cluster: 'MIGRATION_TEST_CLUSTER_ID' }[key];
      if (value === undefined) delete process.env[envKey];
      else process.env[envKey] = value;
    }
  }
});
