import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
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
  await Promise.all([mkdir(dirs.uploads, { mode: 0o700 }), mkdir(dirs.evidence, { mode: 0o700 })])
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

test('the Task 4 runner rejects NODE_ENV=development before adapter initialization', async () => {
  await withPrivateDirs(async dirs => {
    const result = run(['--check-config'], environment({ NODE_ENV: 'development',
      PAYLOAD_TEST_UPLOAD_DIR: dirs.uploads, PAYLOAD_TEST_EVIDENCE_DIR: dirs.evidence }))
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /test_environment_required/u)
    assert.doesNotMatch(result.stdout + result.stderr, /postgresql:\/\/|local-only-test-password/iu)
  })
})

test('Linux private stat validators reject broad modes and wrong owners but Windows claims only portable checks', async () => {
  const support = await import('../support/integration-config.mjs') as {
    validatePrivateDirectoryStat?: (info: unknown, options: { platform: string; uid: number }) => string
    validatePrivateEvidenceFileStat?: (info: unknown, options: { platform: string; uid: number }) => string
  }
  assert.equal(typeof support.validatePrivateDirectoryStat, 'function')
  assert.equal(typeof support.validatePrivateEvidenceFileStat, 'function')
  const directory = (uid: number, mode: number, symbolicLink = false) => ({ uid, mode,
    isDirectory: () => true, isFile: () => false, isSymbolicLink: () => symbolicLink })
  const file = (uid: number, mode: number, symbolicLink = false) => ({ uid, mode,
    isDirectory: () => false, isFile: () => true, isSymbolicLink: () => symbolicLink })
  const options = { platform: 'linux', uid: 501 }
  assert.equal(support.validatePrivateDirectoryStat!(directory(501, 0o40700), options), 'linux_owner_mode_verified')
  for (const mode of [0o40755, 0o40777]) {
    assert.throws(() => support.validatePrivateDirectoryStat!(directory(501, mode), options), { code: 'private_directory_unsafe' })
  }
  assert.throws(() => support.validatePrivateDirectoryStat!(directory(502, 0o40700), options), { code: 'private_directory_unsafe' })
  assert.throws(() => support.validatePrivateDirectoryStat!(directory(501, 0o40700, true), options), { code: 'private_directory_invalid' })
  assert.equal(support.validatePrivateEvidenceFileStat!(file(501, 0o100600), options), 'linux_owner_mode_verified')
  for (const mode of [0o100644, 0o100666]) {
    assert.throws(() => support.validatePrivateEvidenceFileStat!(file(501, mode), options), { code: 'private_evidence_file_unsafe' })
  }
  assert.throws(() => support.validatePrivateEvidenceFileStat!(file(502, 0o100600), options), { code: 'private_evidence_file_unsafe' })
  assert.throws(() => support.validatePrivateEvidenceFileStat!(file(501, 0o100600, true), options), { code: 'private_evidence_file_invalid' })
  const portable = { platform: 'win32', uid: 501 }
  assert.equal(support.validatePrivateDirectoryStat!(directory(502, 0o40777), portable), 'portable_path_type_only')
  assert.equal(support.validatePrivateEvidenceFileStat!(file(502, 0o100666), portable), 'portable_path_type_only')
})

test('private evidence writer atomically replaces exact outputs with restrictive mode on Linux', async () => {
  const support = await import('../support/private-evidence.mjs') as {
    ensurePrivateDirectory?: (directory: string) => Promise<void>
    writePrivateEvidence?: (filePath: string, value: string) => Promise<void>
    readPrivateEvidence?: (filePath: string) => Promise<string>
  }
  assert.equal(typeof support.ensurePrivateDirectory, 'function')
  assert.equal(typeof support.writePrivateEvidence, 'function')
  assert.equal(typeof support.readPrivateEvidence, 'function')
  await withPrivateDirs(async dirs => {
    const fixtureDir = path.join(dirs.uploads, 'portal-pages')
    await mkdir(fixtureDir, { mode: 0o755 })
    await support.ensurePrivateDirectory!(fixtureDir)
    if (process.platform === 'linux') assert.equal((await stat(fixtureDir)).mode & 0o777, 0o700)
    const target = path.join(dirs.evidence, 'private-result.json')
    await support.writePrivateEvidence!(target, '{"runId":"first"}\n')
    await chmod(target, 0o600)
    await support.writePrivateEvidence!(target, '{"runId":"second"}\n')
    assert.equal(await support.readPrivateEvidence!(target), '{"runId":"second"}\n')
    if (process.platform === 'linux') assert.equal((await stat(target)).mode & 0o777, 0o600)
    assert.doesNotMatch(await readFile(target, 'utf8'), /secret|postgresql:/iu)
    assert.deepEqual((await readdir(dirs.evidence)).sort(), ['private-result.json'])
  })
})

test('acceptance aggregation fails missing, duplicate and invalid cases; NOT_EXECUTED blocks PASS', async () => {
  const support = await import('../integration/portal-page-editorial-cases.mjs') as {
    expectedNativeAcceptanceCases?: readonly string[]
    expectedBrowserAcceptanceCases?: readonly string[]
    aggregateAcceptanceCases?: (expected: readonly string[], actual: Array<Record<string, unknown>>) => {
      status: string; cases: Array<{ name: string; status: string }>
    }
  }
  assert.equal(typeof support.aggregateAcceptanceCases, 'function')
  assert.ok(support.expectedNativeAcceptanceCases?.includes('direct REST publish and historical restore requests remain denied'))
  assert.ok(support.expectedNativeAcceptanceCases?.includes('old exact preview remains on its saved Version after a subsequent publication'))
  assert.ok(support.expectedNativeAcceptanceCases?.includes('fresh asset Range requests are denied after editor permission or session revocation'))
  assert.ok(support.expectedNativeAcceptanceCases?.includes('complete media MIME-role matrix accepts every supported native role'))
  assert.ok(support.expectedNativeAcceptanceCases?.includes('wrong MIME role and incomplete media are rejected before publication'))
  assert.ok(support.expectedBrowserAcceptanceCases?.includes('native Versions and diff navigation remain available'))
  assert.ok(support.expectedBrowserAcceptanceCases?.includes('native block insertion and reordering remain available and persist'))
  assert.ok(support.expectedBrowserAcceptanceCases?.includes('existing News controls smoke: preview, scheduling and legacy history render'))
  const expected = ['first required case', 'second required case']
  const pass = support.aggregateAcceptanceCases!(expected, expected.map(name => ({ name, status: 'PASS', detail: 'passed' })))
  assert.equal(pass.status, 'PASS')
  assert.equal(support.aggregateAcceptanceCases!(expected, [{ name: expected[0], status: 'PASS' }]).status, 'FAIL')
  assert.equal(support.aggregateAcceptanceCases!(expected, [{ name: expected[0], status: 'PASS' },
    { name: expected[0], status: 'PASS' }, { name: expected[1], status: 'PASS' }]).status, 'FAIL')
  assert.equal(support.aggregateAcceptanceCases!(expected, [{ name: expected[0], status: 'INVALID' },
    { name: expected[1], status: 'PASS' }]).status, 'FAIL')
  assert.equal(support.aggregateAcceptanceCases!(expected, [{ name: expected[0], status: 'PASS' },
    { name: expected[1], status: 'NOT_EXECUTED' }]).status, 'NOT_EXECUTED')
  assert.equal(support.aggregateAcceptanceCases!(expected, [{ name: expected[0], status: 'PASS' },
    { name: expected[1], status: 'SKIP' }]).status, 'NOT_EXECUTED')
  assert.equal(support.aggregateAcceptanceCases!(expected, [{ name: expected[0], status: 'FAIL' },
    { name: expected[1], status: 'PASS' }]).status, 'FAIL')
  assert.equal(support.aggregateAcceptanceCases!([], []).status, 'FAIL', 'an accidentally empty registry must not claim PASS')
})

test('configured disposable directories must be Linux-owned and private before execute preflight succeeds', async () => {
  if (process.platform !== 'linux') return
  await withPrivateDirs(async dirs => {
    await chmod(dirs.uploads, 0o755)
    const result = run(['--check-config'], environment({ PAYLOAD_TEST_UPLOAD_DIR: dirs.uploads,
      PAYLOAD_TEST_EVIDENCE_DIR: dirs.evidence }))
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /private_directory_unsafe/u)
  })
})

test('stale cleanup removes only an exact safe allowlist and rejects unsafe existing files without reading them', async () => {
  const support = await import('../support/private-evidence.mjs') as {
    removeStalePrivateEvidenceFiles?: (directory: string, names: string[]) => Promise<void>
  }
  assert.equal(typeof support.removeStalePrivateEvidenceFiles, 'function')
  await withPrivateDirs(async dirs => {
    const stale = path.join(dirs.evidence, 'portal-page-editorial-browser.json')
    const unrelated = path.join(dirs.evidence, 'keep-me.json')
    await Promise.all([writeFile(stale, '{"old":true}\n', { mode: 0o600 }),
      writeFile(unrelated, '{"keep":true}\n', { mode: 0o600 })])
    await support.removeStalePrivateEvidenceFiles!(dirs.evidence, ['portal-page-editorial-browser.json'])
    await assert.rejects(stat(stale), { code: 'ENOENT' })
    assert.equal(await readFile(unrelated, 'utf8'), '{"keep":true}\n')

    const unsafe = path.join(dirs.evidence, 'portal-page-editorial-storage-state.json')
    await writeFile(unsafe, '{"cookie":"must-not-read"}\n', { mode: 0o600 })
    if (process.platform === 'linux') await chmod(unsafe, 0o644)
    if (process.platform === 'linux') {
      await assert.rejects(support.removeStalePrivateEvidenceFiles!(dirs.evidence,
        ['portal-page-editorial-storage-state.json']), { code: 'private_evidence_file_unsafe' })
      assert.equal((await stat(unsafe)).mode & 0o777, 0o644)
    }
  })
})

test('execute aborts on an unsafe stale handoff before writing migration evidence or spawning adapters', async () => {
  await withPrivateDirs(async dirs => {
    const staleHandoff = path.join(dirs.evidence, 'portal-page-editorial-browser.json')
    await mkdir(staleHandoff, { mode: 0o700 })
    const result = run(['--execute'], environment({ PAYLOAD_TEST_UPLOAD_DIR: dirs.uploads,
      PAYLOAD_TEST_EVIDENCE_DIR: dirs.evidence }))
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /private_evidence_file_invalid/u)
    await assert.rejects(stat(path.join(dirs.evidence, 'portal-page-editorial-migration.json')), { code: 'ENOENT' })
    assert.equal((await stat(staleHandoff)).isDirectory(), true)
  })
})

test('Task 4 runner and handoff source order keeps stale checks ahead of adapters and handoff after native PASS', async () => {
  const runnerSource = await readFile(new URL('../integration/run-portal-page-editorial.mjs', import.meta.url), 'utf8')
  const nativeSource = await readFile(new URL('../integration/portal-page-editorial-native.ts', import.meta.url), 'utf8')
  const browserSource = await readFile(new URL('../integration/portal-page-editorial-browser.mjs', import.meta.url), 'utf8')
  const controlsSource = await readFile(new URL('../integration/portal-page-editorial-controls.mjs', import.meta.url), 'utf8')
  const uploadSource = await readFile(new URL('../integration/portal-page-editorial-upload.mjs', import.meta.url), 'utf8')
  const registry = await import('../integration/portal-page-editorial-cases.mjs') as {
    expectedNativeAcceptanceCases: readonly string[]
    expectedBrowserAcceptanceCases: readonly string[]
  }
  const nativeNames = [...nativeSource.matchAll(/await acceptance\('([^']+)'/gu)].map(match => match[1])
  assert.deepEqual(nativeNames, registry.expectedNativeAcceptanceCases,
    'every native acceptance operation must be named in the exhaustive registry')
  const controlNames = [...controlsSource.matchAll(/collect\('([^']+)'/gu)].map(match => match[1])
  const expectedControls = registry.expectedBrowserAcceptanceCases.filter(name => controlNames.includes(name))
  assert.deepEqual(controlNames, expectedControls, 'every editorial control browser case must be registered')
  assert.match(controlsSource, /assertCaseRegistry\(results\)/u)
  assert.match(uploadSource, /assertCaseRegistry\(results\)/u,
    'dynamic upload/reorder loops must return exactly the registered required cases')

  const staleCleanup = runnerSource.indexOf('await removeStalePrivateEvidenceFiles(config.evidenceDir, staleTask4Artifacts)')
  const migration = runnerSource.indexOf("runChild('migration'")
  assert.ok(staleCleanup >= 0 && migration > staleCleanup, 'stale evidence must be validated/removed before the migration adapter starts')
  assert.match(runnerSource, /readIntegrationConfig\(process\.env\)/u)

  const nativeGuard = nativeSource.indexOf('guard.readIntegrationConfig(guardEnv)')
  const nativePayloadImport = nativeSource.indexOf("import('payload')")
  assert.ok(nativeGuard >= 0 && nativePayloadImport > nativeGuard, 'native adapter import must follow strict disposable config checks')
  const nativeAggregate = nativeSource.indexOf('aggregateAcceptanceCases(expectedNativeAcceptanceCases, cases)')
  const stateWrite = nativeSource.indexOf('writePrivateEvidence(storageStateFile')
  const noHandoffOnFailure = nativeSource.indexOf("if (status !== 'PASS')")
  assert.ok(nativeAggregate >= 0 && noHandoffOnFailure > nativeAggregate && stateWrite > noHandoffOnFailure,
    'native handoff/storage state must be created only after the complete registry is PASS')

  const browserConfig = browserSource.indexOf('readIntegrationConfig(process.env)')
  const privateHandoffRead = browserSource.indexOf('readPrivateEvidence(handoffPath)')
  const validatedHandoff = browserSource.indexOf('const handoff = await readHandoff(checked)')
  const playwrightImport = browserSource.indexOf('await import(pathToFileURL(handoff.playwrightModule).href)')
  assert.ok(browserConfig >= 0 && privateHandoffRead >= 0 && validatedHandoff > browserConfig && playwrightImport > validatedHandoff,
    'browser credentials must be validated before importing the browser module')
  assert.match(runnerSource, /aggregate\.status !== 'PASS'/u,
    'overall runner exit status must be derived from the fail-closed aggregation result')
})
