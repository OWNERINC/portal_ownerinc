import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { open, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildObserverAuditLease } from './news-protocol-observer-audit.mjs'
import {
  assertBackendIdentity,
  authorizeDockerPreflight,
  buildNativeStateEvidence,
  compareNativeStateEvidence,
  createAtomicRollbackEvidenceRecord,
  decodeWindowsPowerShellStdout,
  recordAtomicRollbackCheck,
  recordAtomicRollbackComparison,
  recordAtomicRollbackSnapshot,
  recordFinalizerCliEvidence,
  assertDirectRunInsertDenialEvidence,
  assertNoBootstrapRunInsertPrivileges,
  hasSingleBootstrapGrantAbortMarker,
  inspectPreflight,
  isExpectedPublicFunctionRejection,
  leaseDocument,
  runClaimedAttempt,
  validateLease,
  validatePrivateAclSnapshot,
  validatePrivateLeaseLocation,
  validatePrivatePosixStat,
  validateWindowsAncestorChain,
  validateWindowsProfileIdentity,
  powershellScriptWithUtf8Output,
} from './protocol-finalizer.mjs'

test('rollback fixture accepts only the exact sanitized intended finalizer rejection', () => {
  const output = [
    'CMS news protocol finalization failed; inspect target privately and use manual recovery for partial state',
    'CMS news protocol diagnostic: phase=verify-installed reason=public_function_execute_outside_allowlist sqlstate=none',
  ].join('\n')
  assert.equal(isExpectedPublicFunctionRejection(1, output), true)
  assert.equal(isExpectedPublicFunctionRejection(0, output), false)
  assert.equal(isExpectedPublicFunctionRejection(2, output), false)
  assert.equal(isExpectedPublicFunctionRejection(1, output.replace('public_function_execute_outside_allowlist', 'trigger_definition_mismatch')), false)
  assert.equal(isExpectedPublicFunctionRejection(1, 'stdout says reason=public_function_execute_outside_allowlist'), false)
  assert.equal(isExpectedPublicFunctionRejection(1, `${output}\nreason=public_function_execute_outside_allowlist`), false)
  assert.equal(isExpectedPublicFunctionRejection(1, `${output}\nCMS news protocol diagnostic: phase=verify-installed reason=public_function_execute_outside_allowlist sqlstate=none`), false)
  assert.equal(isExpectedPublicFunctionRejection(1, output.replace('phase=verify-installed ', 'phase=verify-installed secret=private ')), false)
})

test('V1-to-V2 DDL rollback failure diagnostic is recognized without retaining output', () => {
  const record = {}
  recordFinalizerCliEvidence(record, {
    status: 1, output: [
      'CMS news protocol finalization failed; inspect target privately and use manual recovery for partial state',
      'CMS news protocol diagnostic: phase=protocol-bootstrap-ddl reason=database_error sqlstate=P0001',
    ].join('\n'),
  })
  assert.equal(record.finalizerCli.diagnosticStatus, 'parsed')
  assert.deepEqual(record.finalizerCli.diagnostic, {
    phase: 'protocol-bootstrap-ddl', reason: 'database_error', sqlstate: 'P0001',
  })
  assert.equal(JSON.stringify(record).includes('finalization failed'), false)
})

test('V1 rollback proof requires absent effective INSERT privileges and denial with unchanged snapshots', () => {
  assert.equal(assertNoBootstrapRunInsertPrivileges({ tableInsert: false,
    effectiveColumnInsert: [], explicitColumnInsert: [] }), true)
  for (const invalid of [
    { tableInsert: true, effectiveColumnInsert: [], explicitColumnInsert: [] },
    { tableInsert: false, effectiveColumnInsert: ['id'], explicitColumnInsert: [] },
    { tableInsert: false, effectiveColumnInsert: [], explicitColumnInsert: ['id'] },
    { tableInsert: false, effectiveColumnInsert: null, explicitColumnInsert: [] },
  ]) assert.throws(() => assertNoBootstrapRunInsertPrivileges(invalid),
    { code: 'cms_control_bootstrap_insert_privileges_persisted' })

  const summary = { headSequence: '0', headChainSha256: 'a'.repeat(64), runRowsSha256: 'b'.repeat(64),
    eventRowsSha256: 'c'.repeat(64), catalogSha256: 'd'.repeat(64) }
  assert.equal(assertDirectRunInsertDenialEvidence({ sqlstate: '42501', rollbackSucceeded: true,
    before: summary, after: { ...summary } }), true)
  assert.throws(() => assertDirectRunInsertDenialEvidence({ sqlstate: '23505', rollbackSucceeded: true,
    before: summary, after: summary }), { code: 'direct_run_insert_not_denied_by_privilege' })
  assert.throws(() => assertDirectRunInsertDenialEvidence({ sqlstate: '42501', rollbackSucceeded: false,
    before: summary, after: summary }), { code: 'direct_run_insert_denial_changed_protocol_state' })
  assert.throws(() => assertDirectRunInsertDenialEvidence({ sqlstate: '42501', rollbackSucceeded: true,
    before: summary, after: { ...summary, eventRowsSha256: 'e'.repeat(64) } }),
  { code: 'direct_run_insert_denial_changed_protocol_state' })
})

test('V1 upgrade abort marker requires exactly one nontransactional post-GRANT observation', () => {
  assert.equal(hasSingleBootstrapGrantAbortMarker({ value: '1', is_called: true }), true)
  for (const marker of [
    { value: '0', is_called: false },
    { value: '1', is_called: false },
    { value: '2', is_called: true },
    { value: 'invalid', is_called: true },
    null,
  ]) assert.equal(hasSingleBootstrapGrantAbortMarker(marker), false)
})

function runInjectedFinalizerCli(output, exitCode = 1) {
  const child = spawnSync(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(output)}); process.exitCode=${exitCode}`], {
    encoding: 'utf8', timeout: 5000, windowsHide: true,
  })
  return {
    status: child.status ?? 'spawn-error', signal: child.signal || null,
    timedOut: child.error?.code === 'ETIMEDOUT', output: `${child.stdout || ''}${child.stderr || ''}`,
  }
}

function fixtureNativeSnapshot(seed) {
  const evidence = buildNativeStateEvidence({
    expectedTables: ['native_fixture'], actualTables: ['native_fixture'],
    schema: { marker: seed },
    data: [{ tableName: 'native_fixture', rowCount: '2', canonicalRows: `private rows ${seed}` }],
    migrationLedger: [{ name: `fixture-migration-${seed}`, batch: seed }],
  })
  evidence.nativeSequenceStateSha256 = createHash('sha256').update(`sequence ${seed}`).digest('hex')
  evidence.nativeSequenceState = [{ sequenceName: 'native_fixture_seq', lastValue: String(seed), isCalled: true }]
  return evidence
}

test('rollback report builder retains valid unexpected CLI diagnostics and before/after hashes before rejecting the intended fault', () => {
  const diagnostic = 'CMS news protocol diagnostic: phase=verify-installed reason=trigger_definition_mismatch sqlstate=none'
    + ' trigger_index=0 expected_count=80 observed_count=80 matched_count=1 relation_schema_match=yes enabled_match=yes'
    + ' function_name_match=yes function_schema_match=yes function_identity_match=yes event_mask=62 expected_event_mask=62'
    + ' attribute_count=0 attribute_type_match=yes attribute_text_shape_match=yes argument_count=0 argument_bytes=0'
    + ' no_condition=yes definition_exact=no definition_normalized=no'
  const output = [
    'CMS news protocol finalization failed; inspect target privately and use manual recovery for partial state',
    diagnostic,
  ].join('\n')
  const injected = runInjectedFinalizerCli(output)
  const record = createAtomicRollbackEvidenceRecord()
  recordFinalizerCliEvidence(record, injected)
  recordAtomicRollbackCheck(record, 'protocolCreateTableObserved', true)
  recordAtomicRollbackCheck(record, 'persistedProtocolObjects', false)
  const before = fixtureNativeSnapshot(1)
  const after = fixtureNativeSnapshot(1)
  recordAtomicRollbackSnapshot(record, 'before', before)
  recordAtomicRollbackSnapshot(record, 'after', after)
  recordAtomicRollbackComparison(record, compareNativeStateEvidence(before, after))

  assert.equal(record.expectedPublicFunctionRejection, false)
  assert.equal(record.roguePublicFunctionRejected, false)
  assert.equal(record.finalizerCli.exitCode, 1)
  assert.equal(record.finalizerCli.termination, 'exit')
  assert.equal(record.finalizerCli.diagnosticStatus, 'parsed')
  assert.deepEqual(record.finalizerCli.diagnostic, {
    phase: 'verify-installed', reason: 'trigger_definition_mismatch', sqlstate: 'none',
    triggerDetails: {
      trigger_index: 0, expected_count: 80, observed_count: 80, matched_count: 1,
      relation_schema_match: true, enabled_match: true, function_name_match: true,
      function_schema_match: true, function_identity_match: true, event_mask: 62,
      expected_event_mask: 62, attribute_count: 0, attribute_type_match: true,
      attribute_text_shape_match: true, argument_count: 0, argument_bytes: 0,
      no_condition: true, definition_exact: false, definition_normalized: false,
    },
  })
  assert.equal(record.protocolCreateTableObserved, true)
  assert.equal(record.persistedProtocolObjects, false)
  assert.equal(record.nativeStateCompared, true)
  assert.equal(record.nativeStateUnchanged, true)
  assert.equal(record.nativeBefore.schemaSha256, record.nativeAfter.schemaSha256)
  assert.equal(record.nativeBefore.rowsSha256, record.nativeAfter.rowsSha256)
  assert.equal(record.nativeBefore.sequencesSha256, record.nativeAfter.sequencesSha256)
  assert.equal(record.nativeBefore.migrationLedgerSha256, record.nativeAfter.migrationLedgerSha256)
  assert.equal(JSON.stringify(record).includes('private rows'), false)
})

test('rollback report builder retains differing snapshot hashes without claiming native state unchanged', () => {
  const record = createAtomicRollbackEvidenceRecord()
  const before = fixtureNativeSnapshot(1)
  const after = fixtureNativeSnapshot(2)
  recordAtomicRollbackSnapshot(record, 'before', before)
  recordAtomicRollbackSnapshot(record, 'after', after)
  recordAtomicRollbackComparison(record, compareNativeStateEvidence(before, after))
  assert.equal(record.nativeStateCompared, true)
  assert.equal(record.nativeStateUnchanged, false)
  assert.notEqual(record.nativeBefore.schemaSha256, record.nativeAfter.schemaSha256)
  assert.notEqual(record.nativeBefore.rowsSha256, record.nativeAfter.rowsSha256)
  assert.notEqual(record.nativeBefore.sequencesSha256, record.nativeAfter.sequencesSha256)
  assert.notEqual(record.nativeBefore.migrationLedgerSha256, record.nativeAfter.migrationLedgerSha256)
})

test('rollback CLI evidence hashes missing/malformed or malicious output without retaining its contents', () => {
  const secret = 'synthetic-private-password'
  const malformedOutput = `CMS news protocol diagnostic: phase=verify-installed reason=${secret} sqlstate=none`
  const injected = runInjectedFinalizerCli(malformedOutput)
  const record = createAtomicRollbackEvidenceRecord()
  recordFinalizerCliEvidence(record, { ...injected, secrets: [secret] })
  assert.equal(record.finalizerCli.diagnosticStatus, 'malformed')
  assert.equal(record.finalizerCli.diagnostic, null)
  assert.match(record.finalizerCli.sanitizedOutputSha256, /^[0-9a-f]{64}$/u)
  assert.equal(JSON.stringify(record).includes(secret), false)
  assert.equal(JSON.stringify(record).includes(malformedOutput), false)

  const unknown = createAtomicRollbackEvidenceRecord()
  const unknownReason = runInjectedFinalizerCli('CMS news protocol diagnostic: phase=verify-installed reason=future_sensitive_reason sqlstate=none')
  recordFinalizerCliEvidence(unknown, unknownReason)
  assert.equal(unknown.finalizerCli.diagnosticStatus, 'unknown_enum')
  assert.equal(unknown.finalizerCli.diagnostic, null)
  assert.equal(JSON.stringify(unknown).includes('future_sensitive_reason'), false)

  const sqlState = createAtomicRollbackEvidenceRecord()
  recordFinalizerCliEvidence(sqlState, runInjectedFinalizerCli(
    'CMS news protocol diagnostic: phase=verify-installed reason=database_error sqlstate=42501'))
  assert.equal(sqlState.finalizerCli.diagnosticStatus, 'parsed')
  assert.equal(sqlState.finalizerCli.diagnostic.sqlstate, '42501')

  const missing = createAtomicRollbackEvidenceRecord()
  const noDiagnostic = runInjectedFinalizerCli('unstructured subprocess output')
  recordFinalizerCliEvidence(missing, noDiagnostic)
  assert.equal(missing.finalizerCli.diagnosticStatus, 'missing')
  assert.equal(missing.finalizerCli.diagnostic, null)
  assert.match(missing.finalizerCli.sanitizedOutputSha256, /^[0-9a-f]{64}$/u)
})

test('rollback report shows evidence unavailable when failure occurs before the after-snapshot', () => {
  const record = createAtomicRollbackEvidenceRecord()
  recordAtomicRollbackSnapshot(record, 'before', fixtureNativeSnapshot(1))
  assert.equal(record.nativeBefore !== null, true)
  assert.equal(record.nativeAfter, null)
  assert.equal(record.nativeStateCompared, false)
  assert.equal(record.nativeStateUnchanged, null)
  assert.equal(record.protocolCreateTableObserved, null)
  assert.equal(record.persistedProtocolObjects, null)
})

const lease = (overrides = {}) => ({
  ...buildObserverAuditLease({ runId: '8c72f420-c113-4a6c-9b8e-437a9dd0c5b7', nonce: 'c'.repeat(64),
    dockerContext: 'desktop-linux', dockerEndpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine',
    port: 56391, imageRef: 'postgres:16.4-alpine', imageId: `sha256:${'a'.repeat(64)}` }),
  schemaVersion: 2, scenario: 'fresh-v2', ...overrides,
})

const validObservation = () => ({
  contextName: 'desktop-linux', contextEndpoint: 'npipe:////./pipe/dockerDesktopLinuxEngine',
  dockerServerVersion: '27.5.1', projectResourcesExist: false,
  imageId: `sha256:${'a'.repeat(64)}`, imageRefAvailable: true,
  containerExists: false, volumeExists: false,
})

test('lease guard binds a unique project fixture, pinned cached PostgreSQL 16 image, and nonlegacy loopback port', () => {
  const bound = authorizeDockerPreflight(lease(), validObservation())
  assert.equal(bound.containerName, 'ownerinc-payload-observer-audit-8c72f420c113')
  assert.equal(bound.volumeName, 'ownerinc-payload-observer-audit-pgdata-8c72f420c113')
  assert.equal(bound.scenario, 'fresh-v2')
  assert.equal(bound.host, '127.0.0.1')
  assert.notEqual(bound.port, 55441)
  assert.equal(bound.imageId, `sha256:${'a'.repeat(64)}`)
})

test('lease refuses absent or colliding resources, uncached/different image, and a busy loopback port', () => {
  for (const observation of [
    { ...validObservation(), contextName: 'remote' },
    { ...validObservation(), contextEndpoint: 'tcp://remote:2376' },
    { ...validObservation(), dockerHostOverride: 'tcp://remote:2376' },
    { ...validObservation(), dockerContextOverride: 'remote' },
    { ...validObservation(), containerExists: true },
    { ...validObservation(), volumeExists: true },
    { ...validObservation(), imageRefAvailable: false },
    { ...validObservation(), imageId: `sha256:${'b'.repeat(64)}` },
    { ...validObservation(), portAvailable: false },
  ]) assert.throws(() => authorizeDockerPreflight(lease(), observation))
  for (const badLease of [
    { ...lease(), port: 55441 },
    { ...lease(), port: 19091 },
    { ...lease(), port: 19092 },
    { ...lease(), port: 9299 },
    { ...lease(), host: '0.0.0.0' },
    { ...lease(), volumeName: 'existing-project-volume' },
    { ...lease(), imageRef: 'postgres:17' },
    { ...lease(), imageId: 'postgres:16' },
  ]) assert.throws(() => validateLease(badLease))
})

function mockDockerInfoReaders(observation = validObservation()) {
  const calls = []
  return {
    calls,
    docker(args, options = {}) {
      calls.push({ kind: 'required', args })
      if (args[0] === 'context' && args[1] === 'show') return observation.contextName
      if (args[0] === 'context' && args[1] === 'inspect') {
        return [{ Endpoints: { docker: { Host: observation.contextEndpoint } } }]
      }
      if (args[0] === 'version') return observation.dockerServerVersion
      if (args[0] === 'ps' || args[0] === 'volume' && args[1] === 'ls') {
        return observation.projectResourcesExist ? 'resource-collision' : ''
      }
      throw new Error('unexpected mocked docker inspection')
    },
    dockerOptional(args) {
      calls.push({ kind: 'optional', args })
      if (args[0] === 'image' && args[1] === 'inspect') {
        return observation.imageRefAvailable === false ? null : [{
          Id: observation.imageId,
          RepoTags: observation.imageRefAvailable === true ? [lease().imageRef] : [],
        }]
      }
      if (args[0] === 'inspect') return observation.containerExists ? [{}] : null
      if (args[0] === 'volume' && args[1] === 'inspect') return observation.volumeExists ? [{}] : null
      throw new Error('unexpected mocked optional docker inspection')
    },
  }
}

test('saved raw lease passes both production preflight guards without normalized fields crossing authorization', () => {
  const preparedRaw = leaseDocument(validateLease(lease()))
  const savedRaw = JSON.stringify(preparedRaw)
  const firstRead = JSON.parse(savedRaw)
  const firstReaders = mockDockerInfoReaders()
  const firstTarget = inspectPreflight(firstRead, firstReaders)
  assert.equal(firstTarget.runId, lease().runId)
  assert.equal(firstTarget.containerName, lease().containerName)
  assert.equal(firstTarget.imageId, lease().imageId)
  assert.equal(firstReaders.calls.length, 8)

  // Model a later guarded read from the persisted JSON, not a serialized
  // normalized object; both production helpers must receive the strict raw keys.
  const subsequentRead = JSON.parse(savedRaw)
  const subsequentReaders = mockDockerInfoReaders()
  assert.equal(inspectPreflight(subsequentRead, subsequentReaders).volumeName, lease().volumeName)
  assert.equal(subsequentReaders.calls.length, 8)

  const normalized = validateLease(firstRead)
  assert.throws(() => inspectPreflight(normalized, mockDockerInfoReaders()), { code: 'lease_identity_invalid' })
  assert.throws(() => authorizeDockerPreflight(normalized, validObservation()), { code: 'lease_identity_invalid' })

  const malformedRawLeases = [
    { ...firstRead, unexpected: true },
    { ...firstRead, suffix: 'attacker-supplied' },
    { ...firstRead, runId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    { ...firstRead, containerName: 'attacker-container' },
    { ...firstRead, port: 55441 },
    { ...firstRead, dockerContext: 'attacker-context' },
    { ...firstRead, dockerEndpoint: 'tcp://remote:2376' },
    { ...firstRead, imageRef: 'postgres:17' },
    { ...firstRead, scenario: 'observer-audit' },
    { ...firstRead, schemaVersion: 1 },
  ]
  for (const malformed of malformedRawLeases) {
    const readers = mockDockerInfoReaders()
    assert.throws(() => inspectPreflight(malformed, readers))
    assert.equal(readers.calls.length, 0)
  }
  assert.throws(() => inspectPreflight(firstRead,
    mockDockerInfoReaders({ ...validObservation(), contextEndpoint: 'tcp://remote:2376' })),
  { code: 'lease_docker_context_mismatch' })
  assert.throws(() => inspectPreflight(firstRead,
    mockDockerInfoReaders({ ...validObservation(), imageId: `sha256:${'b'.repeat(64)}` })),
  { code: 'lease_postgres16_image_not_cached' })
  assert.throws(() => inspectPreflight({ ...firstRead, imageId: `sha256:${'b'.repeat(64)}` }, mockDockerInfoReaders()),
    { code: 'lease_postgres16_image_not_cached' })
  assert.throws(() => inspectPreflight({ ...firstRead, imageRef: 'postgres:16.4' }, mockDockerInfoReaders()),
    { code: 'lease_postgres16_image_not_cached' })
  assert.throws(() => inspectPreflight(firstRead,
    mockDockerInfoReaders({ ...validObservation(), containerExists: true })),
  { code: 'lease_resource_collision_refused' })
  assert.throws(() => inspectPreflight(firstRead,
    mockDockerInfoReaders({ ...validObservation(), projectResourcesExist: true })),
  { code: 'lease_resource_collision_refused' })
  assert.throws(() => validatePrivateLeaseLocation(
    `C:\\Users\\fixture-owner\\.ownerinc-payload-protocol-v2-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee\\lease.json`,
    firstRead.runId, 'C:\\Users\\fixture-owner'))
})

async function localAttemptFixture(t, existingArtifacts = []) {
  const runDirectory = await mkdtemp(path.join(tmpdir(), 'ownerinc-one-shot-test-'))
  t.after(() => rm(runDirectory, { recursive: true, force: true }))
  await writeFile(path.join(runDirectory, 'lease.json'), 'synthetic lease fixture')
  for (const name of existingArtifacts) await writeFile(path.join(runDirectory, name), 'prior attempt artifact')
  const events = []
  let successfulClaims = 0
  let reportWrites = 0
  const exclusiveWrite = async (filePath, contents, label) => {
    events.push(`${label}:open`)
    const handle = await open(filePath, 'wx', 0o600)
    try {
      await handle.writeFile(contents, 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    events.push(`${label}:written`)
  }
  return {
    runDirectory,
    events,
    get successfulClaims() { return successfulClaims },
    get reportWrites() { return reportWrites },
    storage: {
      verifyDirectory: async () => { events.push('directory:verified') },
      listDirectory: directory => readdir(directory),
      claim: async (filePath, contents) => {
        await exclusiveWrite(filePath, contents, 'claim')
        successfulClaims += 1
      },
      writeReport: async (filePath, contents) => {
        await exclusiveWrite(filePath, contents, 'report')
        reportWrites += 1
      },
    },
  }
}

test('one-shot execution rejects prior report or claim before callbacks and never overwrites report', async t => {
  for (const priorArtifact of ['report.json', 'execution.claim.json']) {
    const fixture = await localAttemptFixture(t, [priorArtifact])
    let preflightCalls = 0
    let resourceCalls = 0
    let migrationCalls = 0
    const report = { status: 'running', runId: lease().runId }
    await assert.rejects(runClaimedAttempt(lease(), fixture.runDirectory, report, () => 'guarded-preflight', async () => {
      preflightCalls += 1
      resourceCalls += 1
      migrationCalls += 1
    }, fixture.storage), { code: 'lease_attempt_artifacts_exist' })
    assert.equal(preflightCalls, 0)
    assert.equal(resourceCalls, 0)
    assert.equal(migrationCalls, 0)
    assert.equal(fixture.successfulClaims, 0)
    assert.equal(fixture.reportWrites, 0)
    assert.deepEqual((await readdir(fixture.runDirectory)).sort(), [priorArtifact, 'lease.json'].sort())
    if (priorArtifact === 'report.json') assert.equal(await readFile(path.join(fixture.runDirectory, priorArtifact), 'utf8'), 'prior attempt artifact')
  }
})

test('concurrent one-shot attempts have one exclusive claimant and only its callbacks proceed', async t => {
  const fixture = await localAttemptFixture(t)
  let preflightCalls = 0
  let resourceCalls = 0
  const attempt = () => runClaimedAttempt(lease(), fixture.runDirectory,
    { status: 'running', runId: lease().runId }, () => 'guarded-preflight', async () => {
      preflightCalls += 1
      inspectPreflight(JSON.parse(JSON.stringify(lease())), mockDockerInfoReaders())
      resourceCalls += 1
      return 'authorized-fixture-result'
    }, fixture.storage)
  const results = await Promise.allSettled([attempt(), attempt()])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const rejected = results.find(result => result.status === 'rejected')
  assert.ok(['lease_attempt_already_claimed', 'lease_attempt_artifacts_exist'].includes(rejected.reason.code))
  assert.equal(fixture.successfulClaims, 1)
  assert.equal(preflightCalls, 1)
  assert.equal(resourceCalls, 1)
  assert.equal(fixture.reportWrites, 1)
})

test('failed preflight retains its exclusive claim and writes one new failure report', async t => {
  const fixture = await localAttemptFixture(t)
  let stage = 'guarded-preflight'
  let dockerCalls = 0
  let resourceCalls = 0
  const report = { status: 'running', runId: lease().runId, stages: [], containerCreated: false, volumeCreated: false }
  const mockedReaders = mockDockerInfoReaders({ ...validObservation(), contextEndpoint: 'tcp://unexpected:2376' })
  await assert.rejects(runClaimedAttempt(lease(), fixture.runDirectory, report, () => stage, async () => {
    stage = 'guarded-preflight'
    dockerCalls += 1
    fixture.events.push('docker:preflight')
    inspectPreflight(JSON.parse(JSON.stringify(lease())), mockedReaders)
    resourceCalls += 1
  }, fixture.storage), { code: 'lease_docker_context_mismatch' })
  assert.equal(fixture.successfulClaims, 1)
  assert.equal(dockerCalls, 1)
  assert.equal(resourceCalls, 0)
  assert.equal(fixture.reportWrites, 1)
  assert.ok(fixture.events.indexOf('claim:written') < fixture.events.indexOf('docker:preflight'))
  assert.deepEqual((await readdir(fixture.runDirectory)).sort(), ['execution.claim.json', 'lease.json', 'report.json'].sort())
  const storedReport = JSON.parse(await readFile(path.join(fixture.runDirectory, 'report.json'), 'utf8'))
  assert.equal(storedReport.status, 'blocked_or_failed_fixture_preserved')
  assert.deepEqual(storedReport.failure, { stage: 'guarded-preflight', code: 'lease_docker_context_mismatch',
    sqlstate: null, stageResult: null })
})

test('lease schema rejects unknown and prototype-like keys before use', () => {
  assert.throws(() => validateLease({ ...lease(), unexpected: 'value' }))
  assert.throws(() => validateLease(JSON.parse('{"__proto__":{"unsafe":true},' +
    '"schemaVersion":1,"project":"ownerinc-payload-local","dockerContext":"desktop-linux",' +
    '"dockerEndpoint":"npipe:////./pipe/dockerDesktopLinuxEngine","runId":"8c72f420-c113-4a6c-9b8e-437a9dd0c5b7",' +
    '"containerName":"ownerinc-payload-finalizer-8c72f420c113",' +
    '"volumeName":"ownerinc-payload-finalizer-pgdata-8c72f420c113","host":"127.0.0.1","port":56391,' +
    '"imageRef":"postgres:16.4-alpine","imageId":"sha256:' + 'a'.repeat(64) + '"}')))
  const nullPrototype = Object.assign(Object.create(null), lease())
  assert.throws(() => validateLease(nullPrototype))
})

test('Windows private ACL validator accepts only protected current-user/system/admin entries', () => {
  const owner = 'S-1-5-21-100-200-300-1001'
  const safe = { ownerSid: owner, currentUserSid: owner, daclProtected: true, entries: [
    { sid: owner, type: 'Allow', rights: 'FullControl', inherited: false },
    { sid: 'S-1-5-18', type: 'Allow', rights: 'FullControl', inherited: false },
    { sid: 'S-1-5-32-544', type: 'Allow', rights: 'FullControl', inherited: false },
  ], daclPresent: true, daclNull: false, daclInspectable: true, daclEmpty: false, daclAceCount: 3,
  daclControlFlags: 'DiscretionaryAclPresent, DiscretionaryAclProtected, SelfRelative' }
  assert.equal(validatePrivateAclSnapshot(safe), true)
  for (const unsafe of [
    { ...safe, ownerSid: 'S-1-5-21-else' },
    { ...safe, daclProtected: false },
    { ...safe, entries: [...safe.entries, { sid: 'S-1-1-0', type: 'Allow', rights: 'Modify', inherited: true }] },
    { ...safe, entries: [...safe.entries, { sid: 'S-1-5-11', type: 'Allow', rights: 'FullControl', inherited: false }] },
    { ...safe, entries: [...safe.entries, { sid: 'S-1-5-21-999', type: 'Allow', rights: 'FullControl', inherited: false }] },
    { ...safe, entries: [...safe.entries, { sid: 'S-1-1-0', type: 'Allow', rights: 'Read', inherited: false }] },
  ]) assert.throws(() => validatePrivateAclSnapshot(unsafe))
})

test('Windows DACL validator distinguishes missing, null, uninspectable, and empty deny-all DACLs', () => {
  const owner = 'S-1-5-21-100-200-300-1001'
  const valid = { ownerSid: owner, currentUserSid: owner, daclProtected: true, reparse: false,
    daclPresent: true, daclNull: false, daclInspectable: true, daclEmpty: false, daclAceCount: 3,
    daclControlFlags: 'DiscretionaryAclPresent, DiscretionaryAclProtected, SelfRelative', entries: [
      { sid: owner, type: 'Allow', rights: 'FullControl', inherited: false },
      { sid: 'S-1-5-18', type: 'Allow', rights: 'FullControl', inherited: false },
      { sid: 'S-1-5-32-544', type: 'Allow', rights: 'FullControl', inherited: false },
    ] }
  assert.equal(validatePrivateAclSnapshot(valid), true)
  assert.throws(() => validatePrivateAclSnapshot({ ...valid, daclPresent: false, daclInspectable: false,
    daclAceCount: null, daclControlFlags: 'SelfRelative' })) // absent DACL: unrestricted, not an empty deny-all ACL
  assert.throws(() => validatePrivateAclSnapshot({ ...valid, daclNull: true, daclInspectable: false,
    daclAceCount: null })) // present NULL DACL: unrestricted
  assert.throws(() => validatePrivateAclSnapshot({ ...valid, daclControlFlags: undefined }))
  assert.throws(() => validatePrivateAclSnapshot({ ...valid, daclInspectable: false }))
  assert.throws(() => validatePrivateAclSnapshot({ ...valid, entries: [], daclAceCount: 0,
    daclEmpty: true })) // present, non-NULL empty DACL: deny-all; rejected separately
})

const windowsOwner = 'S-1-5-21-100-200-300-1001'
const windowsSystem = 'S-1-5-18'
const windowsAdmins = 'S-1-5-32-544'
const windowsTrustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
const windowsProfile = 'C:\\Users\\fixture-owner'

function windowsAncestorFixture() {
  const ace = (sid, rights, rightsMask, options = {}) => {
    const appliesToObject = options.appliesToObject ?? true
    const containerInherit = options.containerInherit ?? false
    const objectInherit = options.objectInherit ?? false
    const inheritOnly = options.inheritOnly ?? !appliesToObject
    return { sid, type: options.type || 'Allow', rights, rightsMask,
      inherited: options.inherited ?? false, appliesToObject, inheritOnly, containerInherit,
      objectInherit, noPropagateInherit: options.noPropagateInherit ?? false,
      inheritedToChild: containerInherit || objectInherit, tokenMatch: options.tokenMatch ?? false }
  }
  const leafEntries = [
    ace(windowsOwner, 'FullControl', 2032127, { containerInherit: true, objectInherit: true }),
    ace(windowsSystem, 'FullControl', 2032127, { containerInherit: true, objectInherit: true }),
    ace(windowsAdmins, 'FullControl', 2032127, { containerInherit: true, objectInherit: true }),
    ace('S-1-15-3-100', 'ExecuteFile, Synchronize', 0x100020),
  ]
  const ancestors = [
    { path: windowsProfile, depth: 0, reparse: false, ownerSid: windowsSystem, daclProtected: true, entries: leafEntries },
    { path: 'C:\\Users', depth: 1, reparse: false, ownerSid: windowsSystem, daclProtected: true, entries: [
      ace('S-1-5-11', 'AppendData', 0x4, { tokenMatch: true }),
      ace('S-1-1-0', 'ReadAndExecute, Synchronize', 0x1200a9, { tokenMatch: true }),
    ] },
    { path: 'C:\\', depth: 2, reparse: false, ownerSid: windowsTrustedInstaller, daclProtected: true, entries: [
      ace('S-1-5-11', 'AppendData', 0x4, { tokenMatch: true }),
      ace('S-1-5-32-545', 'ReadAndExecute, Synchronize', 0x1200a9, { tokenMatch: true }),
    ] },
  ]
  const inspectedAncestors = ancestors.map(node => ({ ...node, daclPresent: true, daclNull: false,
    daclInspectable: true, daclEmpty: false, daclAceCount: node.entries.length,
    daclControlFlags: 'DiscretionaryAclPresent, DiscretionaryAclProtected, SelfRelative' }))
  return { currentUserSid: windowsOwner, profilePath: windowsProfile,
    registeredProfilePath: 'c:\\users\\FIXTURE-OWNER', ancestors: inspectedAncestors }
}

test('Windows ancestor model accepts the protected SYSTEM-owned profile and proven append-only sibling creation', () => {
  assert.equal(validateWindowsAncestorChain(windowsAncestorFixture()), true)
  const leaf = { ownerSid: windowsOwner, currentUserSid: windowsOwner, daclProtected: true, reparse: false,
    daclPresent: true, daclNull: false, daclInspectable: true, daclEmpty: false, daclAceCount: 3,
    daclControlFlags: 'DiscretionaryAclPresent, DiscretionaryAclProtected, SelfRelative', entries: [
    { sid: windowsOwner, type: 'Allow', rights: 'FullControl', inherited: false },
    { sid: windowsSystem, type: 'Allow', rights: 'FullControl', inherited: false },
    { sid: windowsAdmins, type: 'Allow', rights: 'FullControl', inherited: false },
  ] }
  assert.equal(validatePrivateAclSnapshot(leaf), true)
})

test('inherit-only grandparent write is allowed only when the next inspected DACL blocks inheritance', () => {
  const input = windowsAncestorFixture()
  input.ancestors[2].entries.push({ sid: 'S-1-5-21-999-888-777-1004', type: 'Allow', rights: 'WriteDac', rightsMask: 0x40000,
    inherited: false, appliesToObject: false, inheritOnly: true, containerInherit: true, objectInherit: false,
    noPropagateInherit: false, inheritedToChild: true, tokenMatch: false })
  input.ancestors[2].daclAceCount = input.ancestors[2].entries.length
  assert.equal(validateWindowsAncestorChain(input), true)
})

test('the same dangerous grant is denied when it applies to the ancestor itself', () => {
  const input = windowsAncestorFixture()
  input.ancestors[2].entries.push({ sid: 'S-1-5-21-999-888-777-1004', type: 'Allow', rights: 'WriteDac', rightsMask: 0x40000,
    inherited: false, appliesToObject: true, inheritOnly: false, containerInherit: true, objectInherit: false,
    noPropagateInherit: false, inheritedToChild: true, tokenMatch: false })
  input.ancestors[2].daclAceCount = input.ancestors[2].entries.length
  assert.throws(() => validateWindowsAncestorChain(input))
})

test('an inheritable write ACE actually present on an unprotected descendant is denied', () => {
  const input = windowsAncestorFixture()
  input.ancestors[2].entries.push({ sid: 'S-1-5-21-999-888-777-1004', type: 'Allow', rights: 'WriteDac', rightsMask: 0x40000,
    inherited: false, appliesToObject: false, inheritOnly: true, containerInherit: true, objectInherit: false,
    noPropagateInherit: false, inheritedToChild: true, tokenMatch: false })
  input.ancestors[2].daclAceCount = input.ancestors[2].entries.length
  input.ancestors[1].daclProtected = false
  input.ancestors[1].entries.push({ sid: 'S-1-5-21-999-888-777-1004', type: 'Allow', rights: 'WriteDac', rightsMask: 0x40000,
    inherited: true, appliesToObject: true, inheritOnly: false, containerInherit: true, objectInherit: false,
    noPropagateInherit: false, inheritedToChild: true, tokenMatch: false })
  input.ancestors[1].daclAceCount = input.ancestors[1].entries.length
  assert.throws(() => validateWindowsAncestorChain(input))
})

test('profile inherit-only grant that reaches the initial new child is denied', () => {
  const input = windowsAncestorFixture()
  input.ancestors[0].entries.push({ sid: 'S-1-5-11', type: 'Allow', rights: 'WriteDac', rightsMask: 0x40000,
    inherited: false, appliesToObject: false, inheritOnly: true, containerInherit: true, objectInherit: false,
    noPropagateInherit: false, inheritedToChild: true, tokenMatch: true })
  input.ancestors[0].daclAceCount = input.ancestors[0].entries.length
  assert.throws(() => validateWindowsAncestorChain(input))
})

test('Windows ancestor model rejects untrusted grandparent DELETE_CHILD and WRITE_DACL despite a private leaf', () => {
  for (const rightsMask of [0x40, 0x40000]) {
    const input = windowsAncestorFixture()
    input.ancestors[2].entries.push({ sid: 'S-1-5-21-999-888-777-1004', type: 'Allow', rights: 'untrusted-write', rightsMask,
      inherited: true, appliesToObject: true, inheritOnly: false, containerInherit: true, objectInherit: false,
      noPropagateInherit: false, inheritedToChild: true, tokenMatch: false })
    input.ancestors[2].daclAceCount = input.ancestors[2].entries.length
    assert.throws(() => validateWindowsAncestorChain(input))
  }
  const denied = windowsAncestorFixture()
  denied.ancestors[1].entries.push({ sid: windowsOwner, type: 'Deny', rights: 'ChangePermissions', rightsMask: 0x40000,
    inherited: true, appliesToObject: true, inheritOnly: false, containerInherit: false, objectInherit: false,
    noPropagateInherit: false, inheritedToChild: false, tokenMatch: true })
  denied.ancestors[1].daclAceCount = denied.ancestors[1].entries.length
  assert.throws(() => validateWindowsAncestorChain(denied))
  const uninspectable = windowsAncestorFixture()
  uninspectable.ancestors[1].entries = []
  uninspectable.ancestors[1].daclAceCount = 0
  uninspectable.ancestors[1].daclEmpty = true
  assert.throws(() => validateWindowsAncestorChain(uninspectable))
  const missingState = windowsAncestorFixture()
  delete missingState.ancestors[2].daclPresent
  assert.throws(() => validateWindowsAncestorChain(missingState))
  for (const state of [
    { daclPresent: false, daclNull: false, daclInspectable: false, daclEmpty: false, daclAceCount: null,
      daclControlFlags: 'SelfRelative' },
    { daclPresent: true, daclNull: true, daclInspectable: false, daclEmpty: false, daclAceCount: null,
      daclControlFlags: 'DiscretionaryAclPresent, SelfRelative' },
    { daclPresent: true, daclNull: false, daclInspectable: false, daclEmpty: false, daclAceCount: null,
      daclControlFlags: 'DiscretionaryAclPresent, SelfRelative' },
  ]) {
    const malformed = windowsAncestorFixture()
    Object.assign(malformed.ancestors[1], state)
    assert.throws(() => validateWindowsAncestorChain(malformed))
  }
})

test('Windows ancestor model rejects path spoofing and any reparse ancestor', () => {
  assert.throws(() => validateWindowsProfileIdentity({ currentUserSid: windowsOwner,
    profilePath: windowsProfile, registeredProfilePath: 'C:\\Users\\other-profile' }))
  const input = windowsAncestorFixture()
  input.ancestors[1].reparse = true
  assert.throws(() => validateWindowsAncestorChain(input))
})

test('PowerShell stdout transport preserves non-ASCII profile paths and rejects legacy-codepage bytes', () => {
  const expected = { profilePath: 'C:\\Users\\Criação' }
  const utf8 = Buffer.from(JSON.stringify(expected), 'utf8')
  assert.deepEqual(JSON.parse(decodeWindowsPowerShellStdout(utf8)), expected)
  assert.throws(() => decodeWindowsPowerShellStdout(Buffer.from(JSON.stringify(expected), 'latin1')))

  const script = powershellScriptWithUtf8Output('Write-Output $env:USERPROFILE')
  assert.match(script, /\[Console\]::OutputEncoding\s*=\s*\$utf8NoBom/u)
  assert.match(script, /\$OutputEncoding\s*=\s*\$utf8NoBom/u)
  assert.ok(script.endsWith('Write-Output $env:USERPROFILE'))
})

test('lease location uses only the unique external-private-parent child and rejects old lease roots', () => {
  const runId = lease().runId
  const root = 'C:\\Users\\fixture-owner'
  const newLocation = `C:\\Users\\fixture-owner\\.ownerinc-payload-protocol-v2-${runId}\\lease.json`
  assert.equal(validatePrivateLeaseLocation(newLocation, runId, root), newLocation)
  assert.throws(() => validatePrivateLeaseLocation(
    `C:\\Users\\fixture-owner\\AppData\\Local\\Temp\\opencode\\ownerinc-payload-finalizer-${runId}\\lease.json`, runId, root))
})

test('POSIX private-file guard checks lstat kind, owner UID, mode, and symlink status', () => {
  assert.equal(validatePrivatePosixStat({ uid: 1000, mode: 0o100600, isFile: true, isSymbolicLink: false }, 'file', 1000), true)
  assert.throws(() => validatePrivatePosixStat({ uid: 1001, mode: 0o100600, isFile: true }, 'file', 1000))
  assert.throws(() => validatePrivatePosixStat({ uid: 1000, mode: 0o100644, isFile: true }, 'file', 1000))
  assert.throws(() => validatePrivatePosixStat({ uid: 1000, mode: 0o120700, isFile: false, isSymbolicLink: true }, 'file', 1000))
})

test('backend guard binds server address, internal port, and stable system identifier', () => {
  const target = { backendIPv4: '172.28.0.3' }
  const identity = { server_address: '172.28.0.3/32', server_port: 5432, system_identifier: '7654321098765432109' }
  assert.equal(assertBackendIdentity(target, identity), identity.system_identifier)
  assert.throws(() => assertBackendIdentity(target, { ...identity, server_address: '172.28.0.4' }))
  assert.throws(() => assertBackendIdentity(target, { ...identity, server_port: 56391 }))
  assert.throws(() => assertBackendIdentity(target, identity, '9876543210987654321'))
})

const nativeEvidenceInput = () => ({
  expectedTables: ['news_migration_runs', 'payload_migrations'],
  actualTables: ['payload_migrations', 'news_migration_runs'],
  schema: { columns: [{ table: 'news_migration_runs', definition: 'authority_epoch numeric' }], constraints: ['run-check'] },
  data: [
    { tableName: 'news_migration_runs', rowCount: '1', canonicalRows: '[{"authority_epoch":1,"id":"fixture"}]' },
    { tableName: 'payload_migrations', rowCount: '6', canonicalRows: '[{"batch":"1","name":"m1"}]' },
  ],
  migrationLedger: [{ name: 'm1', batch: '1' }, { name: 'm2', batch: '2' }],
})

test('native preservation evidence hashes complete canonical data/schema/ledger and keeps exact text counters', () => {
  const input = nativeEvidenceInput()
  const before = buildNativeStateEvidence(input)
  const identical = buildNativeStateEvidence(input)
  assert.equal(compareNativeStateEvidence(before, identical), true)
  assert.equal(before.tableCount, '2')
  assert.equal(before.tableRows.find(row => row.tableName === 'news_migration_runs').rowCount, '1')
  assert.match(before.dataSha256, /^[a-f0-9]{64}$/u)

  const rowChange = nativeEvidenceInput()
  rowChange.data[0].canonicalRows = '[{"authority_epoch":2,"id":"fixture"}]'
  assert.equal(compareNativeStateEvidence(before, buildNativeStateEvidence(rowChange)), false)
  const schemaChange = nativeEvidenceInput()
  schemaChange.schema.columns[0].definition = 'authority_epoch bigint'
  assert.equal(compareNativeStateEvidence(before, buildNativeStateEvidence(schemaChange)), false)
  const ledgerChange = nativeEvidenceInput()
  ledgerChange.migrationLedger[1].batch = '9223372036854775807'
  const exactCounter = buildNativeStateEvidence(ledgerChange)
  assert.equal(exactCounter.migrationLedgerSha256 === before.migrationLedgerSha256, false)
  assert.equal(exactCounter.migrationLedgerRows, '2')
  assert.throws(() => buildNativeStateEvidence({ ...input, actualTables: ['news_migration_runs'] }))
})
