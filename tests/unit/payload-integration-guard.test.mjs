import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { checkIntegrationDirectories, readIntegrationConfig } from '../../cms/tests/support/integration-config.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temp = process.platform === 'win32' && process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : tmpdir();

async function fixture(t) {
  const directory = await mkdtemp(path.join(temp, 'payload-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const uploads = path.join(directory, 'uploads'), evidence = path.join(directory, 'evidence');
  await mkdir(uploads, { mode: 0o700 });
  await mkdir(evidence, { mode: 0o700 });
  return { directory, env: {
    NODE_ENV: 'test', MIGRATION_TEST_DISPOSABLE: 'true',
    PAYLOAD_TEST_PORTAL_DATABASE_URL: 'postgresql://fixture:synthetic@127.0.0.1:5432/portal_test',
    PAYLOAD_TEST_CMS_DATABASE_URL: 'postgresql://fixture:synthetic@127.0.0.1:5432/cms_test',
    PAYLOAD_TEST_UPLOAD_DIR: uploads, PAYLOAD_TEST_EVIDENCE_DIR: evidence,
    PAYLOAD_TEST_RUN_ID: '134cfd81-7f0d-47ca-a4fb-c9cabd069c0f',
  } };
}

test('portable Payload runner refuses implicit databases before loading services', () => {
  const result = spawnSync(process.execPath, ['scripts/test-payload-integration.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: { ...process.env, MIGRATION_TEST_DISPOSABLE: 'false' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /disposable_required/);
  assert.doesNotMatch(result.stderr, /postgres(?:ql)?:\/\//);
});

test('guard rejects ambiguous, production, implicit and aliased targets without a connection', async t => {
  const { env } = await fixture(t);
  const cases = [
    [{ MIGRATION_TEST_DISPOSABLE: 'TRUE' }, 'disposable_required'],
    [{ NODE_ENV: 'production' }, 'test_environment_required'],
    [{ PAYLOAD_TEST_PORTAL_DATABASE_URL: '', DATABASE_URL: env.PAYLOAD_TEST_PORTAL_DATABASE_URL }, 'portal_database_required'],
    [{ PAYLOAD_TEST_CMS_DATABASE_URL: 'not-a-url' }, 'cms_database_invalid'],
    [{ PAYLOAD_TEST_CMS_DATABASE_URL: 'postgresql://fixture@remote.invalid/cms_test' }, 'cms_database_invalid'],
    [{ PAYLOAD_TEST_CMS_DATABASE_URL: 'postgresql://fixture@localhost/cms_test?host=remote.invalid' }, 'cms_database_invalid'],
    [{ PAYLOAD_TEST_CMS_DATABASE_URL: 'postgresql://fixture@localhost/cms_test#fragment' }, 'cms_database_invalid'],
    [{ PAYLOAD_TEST_CMS_DATABASE_URL: 'postgresql://fixture@localhost/latest_news' }, 'cms_database_not_disposable'],
    [{ PAYLOAD_TEST_CMS_DATABASE_URL: 'postgresql://fixture@localhost/cms_production' }, 'cms_database_not_disposable'],
    [{ PAYLOAD_TEST_CMS_DATABASE_URL: 'postgresql://fixture@localhost/cms%5ftest' }, 'cms_database_not_disposable'],
    [{ PAYLOAD_TEST_CMS_DATABASE_URL: 'postgres://different@localhost/portal_test' }, 'distinct_databases_required'],
    [{ PAYLOAD_TEST_UPLOAD_DIR: path.join(root, 'public', 'private') }, 'uploads_directory_not_private'],
    [{ PAYLOAD_TEST_UPLOAD_DIR: root }, 'uploads_directory_not_private'],
    [{ PAYLOAD_TEST_UPLOAD_DIR: path.dirname(root) }, 'uploads_directory_not_private'],
    [{ PAYLOAD_TEST_UPLOAD_DIR: 'relative/path' }, 'uploads_directory_required'],
    [{ PAYLOAD_TEST_EVIDENCE_DIR: env.PAYLOAD_TEST_UPLOAD_DIR }, 'distinct_directories_required'],
    [{ PAYLOAD_TEST_EVIDENCE_DIR: path.join(env.PAYLOAD_TEST_UPLOAD_DIR, 'logs') }, 'distinct_directories_required'],
    [{ PAYLOAD_TEST_RUN_ID: 'real-user-id' }, 'synthetic_run_id_required'],
  ];
  for (const [overrides, code] of cases) {
    assert.throws(() => readIntegrationConfig({ ...env, ...overrides }), error => error.code === code, code);
  }
  await checkIntegrationDirectories(readIntegrationConfig(env));
});

test('filesystem preflight refuses missing storage and another checkout', async t => {
  const { directory, env } = await fixture(t);
  await assert.rejects(checkIntegrationDirectories(readIntegrationConfig({
    ...env, PAYLOAD_TEST_UPLOAD_DIR: path.join(directory, 'missing'),
  })), { code: 'private_directory_unavailable' });
  await mkdir(path.join(directory, '.git'));
  await assert.rejects(checkIntegrationDirectories(readIntegrationConfig(env)), { code: 'private_directory_in_checkout' });
});

test('implicit port is canonicalized against the real pg driver with inherited PGPORT', async t => {
  const { env } = await fixture(t);
  const { Client } = createRequire(new URL('../../api/package.json', import.meta.url))('pg');
  const previous = process.env.PGPORT;
  process.env.PGPORT = '6543';
  try {
    const portal = 'postgresql://fixture@127.0.0.1/shared_test';
    const cms = 'postgresql://fixture@127.0.0.1:6543/shared_test';
    // Demonstrate the real parser's inherited default without connecting.
    assert.equal(new Client({ connectionString: portal }).connectionParameters.port, 6543);
    const config = readIntegrationConfig({ ...env,
      PAYLOAD_TEST_PORTAL_DATABASE_URL: portal, PAYLOAD_TEST_CMS_DATABASE_URL: cms,
    });
    const portalTarget = new Client({ connectionString: config.portalDatabaseURL }).connectionParameters;
    const cmsTarget = new Client({ connectionString: config.cmsDatabaseURL }).connectionParameters;
    assert.equal(portalTarget.port, 5432);
    assert.equal(cmsTarget.port, 6543);
    assert.equal(portalTarget.database, cmsTarget.database);
    assert.throws(() => readIntegrationConfig({ ...env,
      PAYLOAD_TEST_PORTAL_DATABASE_URL: portal,
      PAYLOAD_TEST_CMS_DATABASE_URL: 'postgresql://fixture@127.0.0.1:5432/shared_test',
    }), { code: 'distinct_databases_required' });
  } finally {
    if (previous === undefined) delete process.env.PGPORT;
    else process.env.PGPORT = previous;
  }
});

test('filesystem preflight refuses symlink/junction storage aliases', async t => {
  const { directory, env } = await fixture(t);
  const alias = path.join(directory, 'alias');
  await symlink(env.PAYLOAD_TEST_UPLOAD_DIR, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(checkIntegrationDirectories(readIntegrationConfig({
    ...env, PAYLOAD_TEST_UPLOAD_DIR: alias,
  })), { code: 'private_directory_invalid' });
});

test('config check is not acceptance and default cannot pass an incomplete suite', async t => {
  const { directory, env } = await fixture(t);
  const invoke = args => spawnSync(process.execPath, ['scripts/test-payload-integration.mjs', ...args], {
    cwd: root, encoding: 'utf8', timeout: 10000, env: { ...process.env, ...env },
  });
  const checked = invoke(['--check-config']);
  assert.equal(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /CONFIG_VALID.*acceptance NOT_EXECUTED/);
  const acceptance = invoke([]);
  assert.equal(acceptance.status, 2);
  assert.match(acceptance.stderr, /acceptance_suite_not_implemented/);
  const prepare = invoke(['--prepare']);
  assert.equal(prepare.status, 1);
  assert.match(prepare.stderr, /unsupported_argument/);
  for (const result of [checked, acceptance, prepare]) {
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, /postgres(?:ql)?:\/\/|synthetic@|134cfd81/);
  }
  assert.deepEqual((await readdir(directory)).sort(), ['evidence', 'uploads']);
  assert.deepEqual(await readdir(env.PAYLOAD_TEST_UPLOAD_DIR), []);
  assert.deepEqual(await readdir(env.PAYLOAD_TEST_EVIDENCE_DIR), []);
});
