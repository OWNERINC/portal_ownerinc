import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

test('native Pages recovery rehearsal rejects missing authorization before connecting or creating artifacts', () => {
  const env = { ...process.env, NODE_ENV: 'production' };
  for (const key of ['MIGRATION_DATABASE_URL','MIGRATION_TEST_DISPOSABLE','MIGRATION_TEST_CLUSTER_ID']) delete env[key];
  const result = spawnSync(process.execPath, ['scripts/test-pages-recovery.mjs'], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot run with NODE_ENV=production/);
});
test('native Pages recovery rehearsal refuses an unapproved database name before connecting', () => {
  const result = spawnSync(process.execPath, ['scripts/test-pages-recovery.mjs'], { encoding: 'utf8', env: { ...process.env,
    NODE_ENV: 'test', MIGRATION_TEST_DISPOSABLE: 'true', MIGRATION_TEST_CLUSTER_ID: '1234567890123456789',
    MIGRATION_DATABASE_URL: 'postgresql://fixture:synthetic-only@127.0.0.1:1/not_the_recovery_database' } });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /dedicated empty database/);
});
for (const override of ['host=localhost', 'port=2']) {
  test(`native Pages recovery refuses URL connection overrides before connecting: ${override}`, () => {
    const result = spawnSync(process.execPath, ['scripts/test-pages-recovery.mjs'], { encoding: 'utf8', timeout: 10000, env: { ...process.env,
      NODE_ENV: 'test', MIGRATION_TEST_DISPOSABLE: 'true', MIGRATION_TEST_CLUSTER_ID: '1234567890123456789',
      MIGRATION_DATABASE_URL: `postgresql://fixture:synthetic-only@127.0.0.1:1/portal_test_pages_recovery?${override}` } });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /must not contain connection overrides/);
  });
}
test('native Pages recovery refuses omitted URL port instead of inheriting PGPORT', () => {
  const result = spawnSync(process.execPath, ['scripts/test-pages-recovery.mjs'], { encoding: 'utf8', timeout: 10000, env: { ...process.env,
    NODE_ENV: 'test', MIGRATION_TEST_DISPOSABLE: 'true', MIGRATION_TEST_CLUSTER_ID: '1234567890123456789', PGPORT: '1',
    MIGRATION_DATABASE_URL: 'postgresql://fixture:synthetic-only@127.0.0.1/portal_test_pages_recovery' } });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /explicit port/);
});
for (const authority of ['127.0.0.1:1', 'fixture@127.0.0.1:1']) {
  test(`native Pages recovery refuses inherited credentials: ${authority}`, () => {
    const result = spawnSync(process.execPath, ['scripts/test-pages-recovery.mjs'], { encoding: 'utf8', timeout: 10000, env: { ...process.env,
      NODE_ENV: 'test', MIGRATION_TEST_DISPOSABLE: 'true', MIGRATION_TEST_CLUSTER_ID: '1234567890123456789',
      PGUSER: 'inherited-fixture', PGPASSWORD: 'inherited-synthetic-only',
      MIGRATION_DATABASE_URL: `postgresql://${authority}/portal_test_pages_recovery` } });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /explicit username and password/);
  });
}
test('CI recovery uses a separate disposable database and keeps main-only deployment gates', async () => {
  const [workflow, script] = await Promise.all(['.github/workflows/ci.yml', 'scripts/test-pages-recovery.mjs'].map(path => readFile(path, 'utf8')));
  assert.match(workflow, /CREATE DATABASE portal_test_pages_recovery/);
  assert.match(workflow, /run: node scripts\/test-pages-recovery\.mjs/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(script, /assertApprovedMigrationCluster\(client\)/);
  assert.match(script, /assertEmptyMigrationDatabase\(existing\.rows\)/);
  assert.doesNotMatch(script, /DROP DATABASE|TRUNCATE|ssh\s|portal\.ownerinc\.com\.br/);
});
test('CI installs and checks real media tools before verify instead of skipping decode tests', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  const install = workflow.indexOf('sudo apt-get install --yes --no-install-recommends ffmpeg');
  assert.ok(install >= 0 && install < workflow.indexOf('- run: npm run verify'));
  assert.match(workflow, /command -v ffmpeg/);
  assert.match(workflow, /command -v ffprobe/);
});
test('CI pins the validation OS and installs PostgreSQL 16 clients before rehearsal', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  const validate = workflow.slice(workflow.indexOf('  validate:'), workflow.indexOf('  deploy-production:'));
  assert.match(validate, /runs-on: ubuntu-24\.04/);
  assert.match(validate, /apt-get install[^\n]*postgresql-client-16/);
  assert.match(validate, /\/usr\/lib\/postgresql\/16\/bin\/pg_dump --version/);
  assert.match(validate, /\/usr\/lib\/postgresql\/16\/bin\/pg_restore --version/);
});
test('recovery compares full schemas against a pre-upgrade restored reference without filtering constraints', async () => {
  const script = await readFile('scripts/test-pages-recovery.mjs', 'utf8');
  const reference = script.indexOf('const restoredBaselineSchema = await schemaSnapshot()');
  assert.ok(reference > script.indexOf('await legacyPreparation(); await restore(beforePages)'));
  assert.ok(reference < script.indexOf('await migrate(); await verifyMigrations()'));
  assert.match(script, /assert\.deepEqual\(await schemaSnapshot\(\), restoredBaselineSchema/);
  assert.match(script, /constraints: constraints\.rows, indexes: indexes\.rows/);
});
test('native recovery executes the unique receiver SQL rather than an independent cleanup implementation', async () => {
  const [script, receiver] = await Promise.all(['scripts/test-pages-recovery.mjs', 'ops/deploy-from-ci.sh'].map(path => readFile(path, 'utf8')));
  assert.equal([...receiver.matchAll(/<<'PAGES_RECOVERY_SQL'\n([\s\S]*?)\nPAGES_RECOVERY_SQL/g)].length, 1);
  assert.match(script, /new URL\('\.\.\/ops\/deploy-from-ci\.sh', import\.meta\.url\)/);
  assert.match(script, /client\.query\(recoverySql\)/);
  assert.doesNotMatch(script, /ALTER TABLE pages DROP CONSTRAINT|`DROP TABLE \$\{table\}`/);
  for (const label of ['no-Pages no-op', '040-only recovery', 'partial relations', 'nonordinary relation', 'external dependency', 'nonempty pages', 'nonempty page_requests', 'insufficient role', 'RLS-hidden row']) {
    assert.ok(script.includes(label), `native coverage: ${label}`);
  }
  assert.match(script, /catch \(error\) \{ await client\.query\('ROLLBACK'\); throw error; \}/);
});
