import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const runner = fileURLToPath(new URL('../integration/run-portal-page-editorial.mjs', import.meta.url))
const root = fileURLToPath(new URL('../../..', import.meta.url))

async function withPrivateDirs(work: (dirs: { uploads: string; evidence: string }) => Promise<void>) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'portal-page-editorial-guard-'))
  const dirs = { uploads: path.join(base, 'uploads'), evidence: path.join(base, 'evidence') }
  await Promise.all([mkdir(dirs.uploads), mkdir(dirs.evidence)])
  try { await work(dirs) } finally { await rm(base, { recursive: true, force: true }) }
}

function environment(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH || '',
    NODE_ENV: 'test', MIGRATION_TEST_DISPOSABLE: 'true',
    PAYLOAD_TEST_PORTAL_DATABASE_URL: 'postgresql://portal_test:local-only-test-password@127.0.0.1:55471/portal_pages_portal_test',
    PAYLOAD_TEST_CMS_DATABASE_URL: 'postgresql://cms_test:local-only-test-password@127.0.0.1:55471/portal_pages_cms_test',
    PAYLOAD_TEST_UPLOAD_DIR: 'C:\\Temp\\portal-page-uploads',
    PAYLOAD_TEST_EVIDENCE_DIR: 'C:\\Temp\\portal-page-evidence',
    PAYLOAD_TEST_RUN_ID: 'f1fdcf87-48ef-4b79-8146-ff8bbd9ef212',
    ...overrides,
  }
}

function run(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [runner, ...args], { cwd: root, env: env as NodeJS.ProcessEnv, encoding: 'utf8', timeout: 10_000 })
}

test('missing disposable opt-in and unknown runner arguments fail before any Payload initialization', () => {
  const missing = run(['--check-config'], environment({ MIGRATION_TEST_DISPOSABLE: 'false' }))
  assert.notEqual(missing.status, 0)
  assert.match(missing.stdout + missing.stderr, /NOT_EXECUTED|disposable_required/u)
  assert.doesNotMatch(missing.stdout + missing.stderr, /password|secret|postgresql:\/\//iu)

  const unknown = run(['--check-config', '--reset'], environment())
  assert.notEqual(unknown.status, 0)
  assert.match(unknown.stdout + unknown.stderr, /unknown_argument|NOT_EXECUTED/u)
  assert.doesNotMatch(unknown.stdout + unknown.stderr, /password|secret|postgresql:\/\//iu)
})

test('remote, aliased and runtime-fallback database targets are rejected without connection attempts', async () => {
  await withPrivateDirs(async dirs => {
    const validDirectories = { PAYLOAD_TEST_UPLOAD_DIR: dirs.uploads, PAYLOAD_TEST_EVIDENCE_DIR: dirs.evidence }
    const remote = run(['--check-config'], environment({ ...validDirectories,
      PAYLOAD_TEST_CMS_DATABASE_URL: 'postgresql://cms_test:local-only@database.example.test/portal_pages_cms_test' }))
    assert.notEqual(remote.status, 0)
    assert.match(remote.stdout + remote.stderr, /NOT_EXECUTED|cms_database_invalid/u)

    const alias = run(['--check-config'], environment({ ...validDirectories,
      PAYLOAD_TEST_CMS_DATABASE_URL: 'postgresql://cms_test:local-only@localhost:55471/portal_pages_portal_test' }))
    assert.notEqual(alias.status, 0)
    assert.match(alias.stdout + alias.stderr, /NOT_EXECUTED|distinct_databases_required/u)

    const fallback = run(['--check-config'], environment({ ...validDirectories, CMS_DATABASE_URL: 'postgresql://runtime.invalid/not-used' }))
    assert.notEqual(fallback.status, 0)
    assert.match(fallback.stdout + fallback.stderr, /NOT_EXECUTED|runtime_database_fallback_refused/u)
    assert.doesNotMatch(remote.stdout + remote.stderr + alias.stdout + alias.stderr + fallback.stdout + fallback.stderr,
      /local-only|runtime\.invalid|postgresql:\/\//iu)
  })
})

test('checkout aliases and upload/evidence directory overlap are refused', async () => {
  await withPrivateDirs(async dirs => {
    const inCheckout = run(['--check-config'], environment({ PAYLOAD_TEST_UPLOAD_DIR: root,
      PAYLOAD_TEST_EVIDENCE_DIR: dirs.evidence }))
    assert.notEqual(inCheckout.status, 0)
    assert.match(inCheckout.stdout + inCheckout.stderr, /NOT_EXECUTED|directory_not_private|private_directory/u)

    const overlap = run(['--check-config'], environment({ PAYLOAD_TEST_UPLOAD_DIR: dirs.uploads,
      PAYLOAD_TEST_EVIDENCE_DIR: dirs.uploads }))
    assert.notEqual(overlap.status, 0)
    assert.match(overlap.stdout + overlap.stderr, /NOT_EXECUTED|distinct_directories_required|private_directory_alias/u)
  })
})

test('valid check-only config reports NOT_EXECUTED and never claims acceptance', async () => {
  await withPrivateDirs(async dirs => {
    const result = run(['--check-config'], environment({ PAYLOAD_TEST_UPLOAD_DIR: dirs.uploads,
      PAYLOAD_TEST_EVIDENCE_DIR: dirs.evidence }))
    assert.equal(result.status, 0, result.stderr)
    const evidence = JSON.parse(result.stdout) as { runId: string; status: string; cases: Array<{ name: string; status: string; detail: string }> }
    assert.equal(evidence.runId, 'f1fdcf87-48ef-4b79-8146-ff8bbd9ef212')
    assert.equal(evidence.status, 'NOT_EXECUTED')
    assert.ok(evidence.cases.length > 0)
    assert.ok(evidence.cases.every(item => item.status === 'NOT_EXECUTED'))
    assert.match(evidence.cases[0]!.detail, /configuration|not executed/iu)
    assert.doesNotMatch(result.stdout, /local-only-test-password|postgresql:\/\//iu)
  })
})
