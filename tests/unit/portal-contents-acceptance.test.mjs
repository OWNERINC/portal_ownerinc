import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REQUIRED_CASES,
  aggregateEvidence,
  checkEnvironment,
  createNotExecutedEvidence,
} from '../../scripts/test-portal-contents-acceptance.mjs';

const COMMIT = '55bd6c66ba2bb49a3e9cf5c3768538bde5c471d5';
const RUN_ID = 'c965d4c0-5fbe-47ef-949d-23e5cc6fbacc';
const VALID_ENVIRONMENT = 'disposable-local; Docker stack; Firebase Auth Emulator (not production)';

function evidence(caseName, status = 'PASS', overrides = {}) {
  return {
    case: caseName,
    commit: COMMIT,
    runId: RUN_ID,
    environment: VALID_ENVIRONMENT,
    browser: 'Chromium 140.0; manual DevTools',
    viewport: '1440x900',
    scenario: `Executed ${caseName} against the disposable local services.`,
    status,
    artifact: null,
    notes: 'Synthetic fixture only; no production claim.',
    ...overrides,
  };
}

test('the acceptance matrix contains each required service/browser case exactly once', () => {
  assert.deepEqual(REQUIRED_CASES, [
    'live-auth-gate',
    'catalog-routing',
    'native-image',
    'native-range',
    'long-video-renewal',
    'media-failure-recovery',
    'large-pdf',
    'auth-exit-cross-tab',
    'gallery-keyboard',
    'screen-reader-gallery',
    'embeds-effective-csp',
    'layout-mobile',
    'bfcache-cleanup',
    'owner-news-regression',
    'editorial-accessibility',
  ]);
});

test('an unexecuted required browser case prevents aggregate PASS', () => {
  const records = REQUIRED_CASES.map(name => evidence(name));
  records.find(row => row.case === 'screen-reader-gallery').status = 'NOT_EXECUTED';
  assert.equal(aggregateEvidence(records).status, 'NOT_EXECUTED');
  assert.equal(aggregateEvidence(records).exitCode, 2);
});

test('the aggregate rejects missing, duplicate, and extra cases with FAIL precedence', () => {
  assert.equal(aggregateEvidence([]).status, 'NOT_EXECUTED', 'an empty manifest is incomplete, not a pass');

  const records = REQUIRED_CASES.map(name => evidence(name));
  assert.equal(aggregateEvidence(records.slice(1)).exitCode, 2, 'a missing execution remains NOT_EXECUTED');
  assert.equal(aggregateEvidence([...records, records[0]]).exitCode, 1, 'duplicates are invalid evidence');
  assert.equal(aggregateEvidence([...records, evidence('unapproved-case')]).exitCode, 1, 'extra cases are invalid evidence');

  records.find(row => row.case === 'native-range').status = 'FAIL';
  assert.equal(aggregateEvidence(records).status, 'FAIL');
  assert.equal(aggregateEvidence(records).exitCode, 1);
});

test('invalid status, missing metadata, and unexpected record keys cannot aggregate as PASS', () => {
  const cases = REQUIRED_CASES.map(name => evidence(name));

  const invalidStatus = structuredClone(cases);
  invalidStatus[0].status = 'SKIP';
  assert.equal(aggregateEvidence(invalidStatus).exitCode, 1);

  const missingMetadata = structuredClone(cases);
  delete missingMetadata[0].viewport;
  assert.equal(aggregateEvidence(missingMetadata).exitCode, 1);

  const extraKey = structuredClone(cases);
  extraKey[0].cookie = 'must never be included';
  assert.equal(aggregateEvidence(extraKey).exitCode, 1);
});

test('mocked harness evidence cannot be labelled as a live PASS', () => {
  const records = REQUIRED_CASES.map(name => evidence(name));
  records[0].browser = 'unit-test harness (mocked)';
  assert.equal(aggregateEvidence(records).status, 'FAIL');
  assert.equal(aggregateEvidence(records).exitCode, 1);
});

test('artifact metadata rejects remote URLs and paths escaping the private evidence directory', () => {
  for (const artifact of ['https://example.test/trace.har', '../outside.png', 'C:\\Users\\private\\trace.har', '\\\\server\\share\\trace.har']) {
    const records = REQUIRED_CASES.map(name => evidence(name));
    records[0].artifact = artifact;
    assert.equal(aggregateEvidence(records).exitCode, 1, artifact);
  }
});

test('check-only evidence is always NOT_EXECUTED and can never satisfy the aggregate', () => {
  const records = createNotExecutedEvidence({
    commit: COMMIT,
    runId: RUN_ID,
    environment: 'local preflight only; Docker/browser not executed',
    reason: 'docker_engine_unavailable',
  });
  assert.equal(records.length, REQUIRED_CASES.length);
  assert.ok(records.every(row => row.status === 'NOT_EXECUTED' && row.artifact === null));
  assert.equal(aggregateEvidence(records).status, 'NOT_EXECUTED');
  assert.equal(aggregateEvidence(records).exitCode, 2);
});

test('the check-config CLI validates explicit guards but never reports acceptance or writes evidence', async t => {
  const { mkdtemp, rm, lstat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const evidenceDir = await mkdtemp(join(tmpdir(), 'portal-contents-cli-'));
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['scripts/test-portal-contents-acceptance.mjs', '--check-config'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORTAL_CONTENTS_TEST_DISPOSABLE: 'true',
      PORTAL_CONTENTS_TEST_BASE_URL: 'http://127.0.0.1:8080',
      PORTAL_CONTENTS_TEST_RUN_ID: RUN_ID,
      PORTAL_CONTENTS_TEST_EVIDENCE_DIR: resolve(evidenceDir),
    },
    timeout: 10_000,
  });
  assert.equal(result.status, 2);
  const output = JSON.parse(result.stdout);
  assert.equal(output.configStatus, 'CONFIG_VALID');
  assert.equal(output.status, 'NOT_EXECUTED');
  assert.ok(output.cases.every(row => row.status === 'NOT_EXECUTED'));
  await assert.rejects(lstat(join(evidenceDir, 'portal-contents-acceptance.json')), { code: 'ENOENT' });
});

test('aggregate CLI reads explicit records and exits 2 for an incomplete run', async t => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const evidenceDir = await mkdtemp(join(tmpdir(), 'portal-contents-aggregate-'));
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));
  const records = createNotExecutedEvidence({ commit: COMMIT, runId: RUN_ID,
    environment: 'local disposable stack unavailable; no service or browser run', reason: 'docker_engine_unavailable' });
  await writeFile(join(evidenceDir, 'portal-contents-acceptance.json'), `${JSON.stringify(records)}\n`, { flag: 'wx' });
  const result = spawnSync(process.execPath, ['scripts/test-portal-contents-acceptance.mjs', '--aggregate'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORTAL_CONTENTS_TEST_DISPOSABLE: 'true',
      PORTAL_CONTENTS_TEST_BASE_URL: 'http://127.0.0.1:8080',
      PORTAL_CONTENTS_TEST_RUN_ID: RUN_ID,
      PORTAL_CONTENTS_TEST_EVIDENCE_DIR: resolve(evidenceDir),
    },
    timeout: 10_000,
  });
  assert.equal(result.status, 2);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'NOT_EXECUTED');
  assert.ok(output.cases.every(row => row.status === 'NOT_EXECUTED'));

  const invalidConfig = spawnSync(process.execPath, ['scripts/test-portal-contents-acceptance.mjs', '--aggregate'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORTAL_CONTENTS_TEST_DISPOSABLE: 'true',
      PORTAL_CONTENTS_TEST_BASE_URL: 'http://127.0.0.1:8080',
      PORTAL_CONTENTS_TEST_RUN_ID: RUN_ID,
      PORTAL_CONTENTS_TEST_EVIDENCE_DIR: resolve(evidenceDir),
    },
    timeout: 10_000,
  });
  assert.equal(invalidConfig.status, 1, 'invalid aggregate configuration is an invalid run, not an omission');
  const invalidOutput = JSON.parse(invalidConfig.stdout);
  assert.equal(invalidOutput.status, 'FAIL');
  assert.equal(invalidOutput.configStatus, 'INVALID');
});

test('test environment guard accepts only explicit loopback URLs, UUIDv4 and external evidence directories', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const evidenceDir = await mkdtemp(join(tmpdir(), 'portal-contents-acceptance-'));
  t.after(() => rm(evidenceDir, { recursive: true, force: true }));
  const environment = {
    NODE_ENV: 'test',
    PORTAL_CONTENTS_TEST_DISPOSABLE: 'true',
    PORTAL_CONTENTS_TEST_BASE_URL: 'http://127.0.0.1:8080',
    PORTAL_CONTENTS_TEST_RUN_ID: RUN_ID,
    PORTAL_CONTENTS_TEST_EVIDENCE_DIR: resolve(evidenceDir),
  };
  assert.equal((await checkEnvironment(environment)).runId, RUN_ID);

  for (const [key, value] of [
    ['NODE_ENV', 'development'],
    ['PORTAL_CONTENTS_TEST_DISPOSABLE', 'false'],
    ['PORTAL_CONTENTS_TEST_BASE_URL', 'https://portal.example.com'],
    ['PORTAL_CONTENTS_TEST_BASE_URL', 'file://127.0.0.1/'],
    ['PORTAL_CONTENTS_TEST_BASE_URL', 'http://localhost.evil.test:8080'],
    ['PORTAL_CONTENTS_TEST_RUN_ID', 'not-a-uuid'],
    ['PORTAL_CONTENTS_TEST_EVIDENCE_DIR', resolve(process.cwd(), 'tests')],
  ]) {
    assert.notEqual(await checkEnvironment({ ...environment, [key]: value }).then(() => true, () => false), true,
      `${key}=${value} must be rejected`);
  }
});
