import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  createTask9ChildEnvironment,
  parseTask9EnvironmentSnapshot,
  validateTask9Environment,
  validateTask9PrivateDirectory,
  validateTask9Snapshot,
} from './task9-environment.mjs'
import { validateTask9EnvironmentAtChildBoundary } from './task9-environment-preflight.mjs'

const localAppData = 'C:\\Users\\Task9Operator\\AppData\\Local'
const privateRoot = path.win32.join(localAppData, 'Temp', 'opencode')

function validEnvironment(directory = path.win32.join(privateRoot, 'ownerinc-task9-r12-fixture')) {
  return {
    LOCALAPPDATA: localAppData,
    NODE_ENV: 'development',
    NEXT_TELEMETRY_DISABLED: '1',
    PAYLOAD_SECRET: 'payload-secret-fixture-value-0123456789abcdef',
    PAYLOAD_TO_PORTAL_SECRET: 'payload-to-portal-fixture-value-0123456789',
    PORTAL_TO_PAYLOAD_SECRET: 'portal-to-payload-fixture-value-0123456789',
    TASK9_PRIVATE_DIR: directory,
    CMS_UPLOAD_DIR: path.win32.join(directory, 'uploads'),
    CMS_DATABASE_URL: 'postgresql://cms_runtime@127.0.0.1:55441/cms_task9_test',
    TASK9_PORTAL_DATABASE_URL: 'postgresql://portal_api@127.0.0.1:55441/portal_task9_test',
    PORTAL_PUBLIC_URL: 'http://127.0.0.1:19091',
    PORTAL_INTERNAL_URL: 'http://127.0.0.1:19091',
  }
}

test('known R12-style approved root and loopback/database identities remain valid', () => {
  const result = validateTask9Environment(validEnvironment())
  assert.equal(result.valid, true)
  assert.deepEqual(result.reasonCodes, [])
  assert.ok(Object.values(result.checks).every(Boolean))
})

test('saved R12/R13 legacy OS and private-path keys are recognized but not part of child config', () => {
  const snapshot = {
    ...validEnvironment(),
    PATH: 'legacy-path', SystemRoot: 'legacy-root', TEMP: 'legacy-temp', TMP: 'legacy-tmp',
    USERPROFILE: 'legacy-profile', APPDATA: 'legacy-appdata', ComSpec: 'legacy-comspec', PATHEXT: 'legacy-pathext',
    TASK9_WEBPACK: 'legacy-flag',
  }
  const result = validateTask9Snapshot(snapshot)
  assert.equal(result.valid, true)
  assert.deepEqual(result.reasonCodes, [])
  assert.equal(parseTask9EnvironmentSnapshot(JSON.stringify(snapshot)).valid, true)
})

test('malformed snapshot parsing returns only a fixed code, never parser content', () => {
  const result = parseTask9EnvironmentSnapshot('{"private-value":"do-not-print"')
  assert.equal(result.valid, false)
  assert.deepEqual(result.reasonCodes, ['TASK9_SNAPSHOT_INVALID'])
  assert.ok(!JSON.stringify(result).includes('do-not-print'))
})

test('Windows path separator and case normalization preserves only the same immediate private parent', () => {
  const directory = 'c:/USERS/task9operator/AppData/Local/Temp/opencode/ownerinc-task9-case-fixture'
  assert.deepEqual(validateTask9PrivateDirectory(directory, localAppData), { valid: true, reasonCodes: [] })
  const nested = path.win32.join(privateRoot, 'nested', 'ownerinc-task9-fixture')
  assert.deepEqual(validateTask9PrivateDirectory(nested, localAppData), {
    valid: false,
    reasonCodes: ['PRIVATE_DIR_PARENT_MISMATCH'],
  })
})

test('stale snapshot LOCALAPPDATA reproduces the R13 pre-start rejection', () => {
  const r13Directory = path.win32.join(privateRoot, 'ownerinc-task9-native-destinations-r13-fixture')
  const staleSnapshot = {
    ...validEnvironment(r13Directory),
    LOCALAPPDATA: 'D:\\LegacyUser\\AppData\\Local',
    TASK9_PRIVATE_DIR: r13Directory,
  }

  const result = validateTask9Environment(staleSnapshot)
  assert.equal(result.valid, false)
  assert.deepEqual(result.reasonCodes, ['PRIVATE_DIR_PARENT_MISMATCH'])
  assert.equal(result.checks.portalPublicOriginMatches, true)
  assert.equal(result.checks.portalInternalOriginMatches, true)
  assert.equal(result.checks.cmsDatabaseIdentityMatches, true)
  assert.equal(result.checks.portalDatabaseIdentityMatches, true)
})

test('production child builder replaces stale private root and upload path with the validated launcher root', () => {
  const directory = path.win32.join(privateRoot, 'ownerinc-task9-native-destinations-r13-fixture')
  const snapshot = {
    ...validEnvironment(directory),
    LOCALAPPDATA: 'D:\\LegacyUser\\AppData\\Local',
    TASK9_PRIVATE_DIR: 'D:\\LegacyUser\\Temp\\opencode\\ownerinc-task9-old-fixture',
    CMS_UPLOAD_DIR: 'D:\\LegacyUser\\Temp\\old-uploads',
    TASK9_WEBPACK: 'snapshot-value-is-never-authoritative',
  }
  const result = createTask9ChildEnvironment({
    parentEnvironment: { LOCALAPPDATA: localAppData },
    snapshotEnvironment: snapshot,
    directory,
    webpack: false,
  })

  assert.equal(result.environment.LOCALAPPDATA, localAppData)
  assert.equal(result.environment.TASK9_PRIVATE_DIR, directory)
  assert.equal(result.environment.CMS_UPLOAD_DIR, path.win32.join(directory, 'uploads'))
  assert.equal(result.environment.TASK9_WEBPACK, undefined)
  assert.equal(result.validation.valid, true)
  assert.deepEqual(result.validation.reasonCodes, [])
  const webpackRun = createTask9ChildEnvironment({
    parentEnvironment: { LOCALAPPDATA: localAppData },
    snapshotEnvironment: snapshot,
    directory,
    webpack: true,
  })
  assert.equal(webpackRun.environment.TASK9_WEBPACK, '1')
  assert.equal(webpackRun.validation.valid, true)
})

test('snapshot config cannot override canonical root or inject ambient database secrets', () => {
  const directory = path.win32.join(privateRoot, 'ownerinc-task9-env-isolation-fixture')
  const snapshot = { ...validEnvironment(directory), LOCALAPPDATA: 'D:\\Snapshot\\Root', PATH: 'snapshot-path-must-not-be-used' }
  const parentEnvironment = {
    LOCALAPPDATA: localAppData,
    PATH: 'trusted-parent-path',
    CMS_DATABASE_URL: 'postgresql://wrong@192.0.2.10:9999/production',
    PAYLOAD_SECRET: 'ambient-parent-secret',
    TASK9_PRIVATE_DIR: 'D:\\ambient\\private',
    AMBIENT_PRIVATE_SENTINEL: 'must-not-cross-the-launch-boundary',
    NODE_OPTIONS: '--require=C:\\untrusted\\preload.cjs',
    NODE_PATH: 'C:\\untrusted\\modules',
    LD_PRELOAD: '/untrusted/preload.so',
    DYLD_INSERT_LIBRARIES: '/untrusted/inject.dylib',
    BASH_ENV: '/untrusted/bashrc',
    PYTHONPATH: '/untrusted/python',
  }
  const result = createTask9ChildEnvironment({ parentEnvironment, snapshotEnvironment: snapshot, directory })

  assert.equal(Object.keys(result.environment).filter(key => key.toLowerCase() === 'localappdata').length, 1)
  assert.equal(result.environment.LOCALAPPDATA, localAppData)
  assert.equal(result.environment.PATH, 'trusted-parent-path')
  assert.equal(result.environment.CMS_DATABASE_URL, snapshot.CMS_DATABASE_URL)
  assert.equal(result.environment.PAYLOAD_SECRET, snapshot.PAYLOAD_SECRET)
  assert.notEqual(result.environment.PAYLOAD_SECRET, parentEnvironment.PAYLOAD_SECRET)
  assert.equal(result.environment.AMBIENT_PRIVATE_SENTINEL, undefined)
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'PYTHONPATH']) {
    assert.equal(result.environment[key], undefined, `parent ${key} must not cross the closed child-env boundary`)
  }
  assert.equal(result.validation.valid, true)
})

test('the exact final builder environment validates in a pure spawned Node child and rejects an unknown key', () => {
  const directory = path.win32.join(privateRoot, 'ownerinc-task9-spawn-boundary-fixture')
  const built = createTask9ChildEnvironment({
    parentEnvironment: { ...process.env, LOCALAPPDATA: localAppData },
    snapshotEnvironment: validEnvironment(directory),
    directory,
    webpack: true,
  })
  assert.equal(built.validation.valid, true)

  const windowsKeys = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SystemDrive', 'USERDOMAIN', 'USERNAME', 'WINDIR']
  if (process.platform === 'win32') {
    for (const key of windowsKeys) {
      const inherited = Object.keys(process.env).find(candidate => candidate.toLowerCase() === key.toLowerCase())
      assert.ok(inherited, `Windows parent should expose trusted ${key}`)
      assert.equal(built.environment[key], process.env[inherited])
    }
  }

  const childResult = validateTask9EnvironmentAtChildBoundary(built.environment)
  assert.deepEqual(childResult, { valid: true, reasonCodes: [] })

  const maliciousResult = validateTask9EnvironmentAtChildBoundary({
    ...built.environment,
    TASK9_UNRECOGNIZED_SENTINEL: 'must-not-be-accepted',
  })
  assert.deepEqual(maliciousResult, {
    valid: false,
    reasonCodes: ['TASK9_RUNTIME_KEY_UNSUPPORTED'],
  })
  assert.ok(!JSON.stringify(maliciousResult).includes('TASK9_UNRECOGNIZED_SENTINEL'))
  assert.ok(!JSON.stringify(maliciousResult).includes('must-not-be-accepted'))
})

test('non-loopback and missing portal endpoints have distinct safe reason codes', () => {
  const nonLoopback = validEnvironment()
  nonLoopback.PORTAL_PUBLIC_URL = 'http://192.0.2.8:19091'
  assert.deepEqual(validateTask9Environment(nonLoopback).reasonCodes, ['PORTAL_PUBLIC_URL_NOT_LOOPBACK'])

  const missingPublic = validEnvironment()
  delete missingPublic.PORTAL_PUBLIC_URL
  assert.deepEqual(validateTask9Environment(missingPublic).reasonCodes, ['PORTAL_PUBLIC_URL_MISSING'])

  const missingInternal = validEnvironment()
  delete missingInternal.PORTAL_INTERNAL_URL
  assert.deepEqual(validateTask9Environment(missingInternal).reasonCodes, ['PORTAL_INTERNAL_URL_MISSING'])
})

test('database project and role isolation failures are separately identified', () => {
  const wrongCms = validEnvironment()
  wrongCms.CMS_DATABASE_URL = 'postgresql://cms_runtime@127.0.0.1:55441/other_test'
  assert.deepEqual(validateTask9Environment(wrongCms).reasonCodes, ['CMS_DATABASE_IDENTITY_INVALID'])

  const wrongPortal = validEnvironment()
  wrongPortal.TASK9_PORTAL_DATABASE_URL = 'postgresql://portal_api@127.0.0.1:55441/cms_task9_test'
  assert.deepEqual(validateTask9Environment(wrongPortal).reasonCodes, ['PORTAL_DATABASE_IDENTITY_INVALID'])
})

test('builder does not normalize an invalid project identity from the saved snapshot', () => {
  const directory = path.win32.join(privateRoot, 'ownerinc-task9-isolation-reject-fixture')
  const snapshot = validEnvironment(directory)
  snapshot.TASK9_PORTAL_DATABASE_URL = 'postgresql://portal_api@127.0.0.1:55441/production'
  const result = createTask9ChildEnvironment({
    parentEnvironment: { LOCALAPPDATA: localAppData },
    snapshotEnvironment: snapshot,
    directory,
  })

  assert.equal(result.environment.TASK9_PORTAL_DATABASE_URL, snapshot.TASK9_PORTAL_DATABASE_URL)
  assert.deepEqual(result.validation.reasonCodes, ['PORTAL_DATABASE_IDENTITY_INVALID'])
})

test('database URL query, fragment, and non-PostgreSQL protocol cannot override the validated identity', () => {
  for (const suffix of ['?host=192.0.2.8', '#other-database']) {
    const environment = validEnvironment()
    environment.CMS_DATABASE_URL += suffix
    assert.deepEqual(validateTask9Environment(environment).reasonCodes, ['CMS_DATABASE_IDENTITY_INVALID'])
  }

  const wrongProtocol = validEnvironment()
  wrongProtocol.TASK9_PORTAL_DATABASE_URL = 'mysql://portal_api@127.0.0.1:55441/portal_task9_test'
  assert.deepEqual(validateTask9Environment(wrongProtocol).reasonCodes, ['PORTAL_DATABASE_IDENTITY_INVALID'])
})

test('snapshot environment is closed: execution injection settings and unknown names reject without echoing names', () => {
  const directory = path.win32.join(privateRoot, 'ownerinc-task9-closed-snapshot-fixture')
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'BASH_ENV', 'PYTHONPATH']) {
    const snapshot = { ...validEnvironment(directory), [key]: 'fixture-injection-value' }
    const result = createTask9ChildEnvironment({
      parentEnvironment: { LOCALAPPDATA: localAppData, PATH: 'trusted-parent-path' },
      snapshotEnvironment: snapshot,
      directory,
    })
    assert.equal(result.validation.valid, false)
    assert.ok(result.validation.reasonCodes.includes('TASK9_SNAPSHOT_EXECUTION_SETTING_REJECTED'))
    assert.ok(!JSON.stringify(result.validation).includes(key))
    assert.equal(result.environment[key], undefined)
  }

  const unknownSnapshot = { ...validEnvironment(directory), UNRECOGNIZED_PRIVATE_SETTING: 'must-not-cross' }
  const unknownResult = createTask9ChildEnvironment({
    parentEnvironment: { LOCALAPPDATA: localAppData },
    snapshotEnvironment: unknownSnapshot,
    directory,
  })
  assert.deepEqual(unknownResult.validation.reasonCodes, ['TASK9_SNAPSHOT_KEY_UNSUPPORTED'])
  assert.equal(unknownResult.environment.UNRECOGNIZED_PRIVATE_SETTING, undefined)
  assert.ok(!JSON.stringify(unknownResult.validation).includes('UNRECOGNIZED_PRIVATE_SETTING'))
})

test('runtime guard rejects unknown keys without including their names in diagnostics', () => {
  const environment = { ...validEnvironment(), PRIVATE_UNKNOWN_MARKER: 'never-print' }
  const result = validateTask9Environment(environment)
  assert.equal(result.valid, false)
  assert.ok(result.reasonCodes.includes('TASK9_RUNTIME_KEY_UNSUPPORTED'))
  assert.ok(!JSON.stringify(result).includes('PRIVATE_UNKNOWN_MARKER'))
  assert.ok(!JSON.stringify(result).includes('never-print'))
})

test('runtime guard fails closed if a process is directly launched with an execution injection variable', () => {
  const environment = { ...validEnvironment(), NODE_OPTIONS: '--require=unsafe-preload' }
  const result = validateTask9Environment(environment)
  assert.equal(result.valid, false)
  assert.ok(result.reasonCodes.includes('TASK9_EXECUTION_SETTING_PRESENT'))
  assert.ok(!JSON.stringify(result).includes('unsafe-preload'))
})

test('launcher rejects a private-root mismatch before loading pg or reading saved state', async () => {
  const source = await readFile(new URL('./run-task9.mjs', import.meta.url), 'utf8')
  const privateGuard = source.indexOf('const privateDirectoryValidation =')
  const pgLoad = source.indexOf("createRequire(path.join(root, 'api/package.json'))('pg')")
  const stateRead = source.indexOf("ownerinc-payload-local-validation-20261002", privateGuard)

  assert.ok(privateGuard >= 0)
  assert.ok(pgLoad > privateGuard)
  assert.ok(stateRead > privateGuard)
})

test('launcher spawns with the exact validated builder object and adds no later environment merge', async () => {
  const source = await readFile(new URL('./run-task9.mjs', import.meta.url), 'utf8')
  const builderCall = source.indexOf('createTask9ChildEnvironment({')
  const builderValidation = source.indexOf('if (!environmentValidation.valid)', builderCall)
  const spawn = source.indexOf('spawnSync(process.execPath, args, { cwd:', builderValidation)
  const productionRun = source.indexOf("run(`${mode.slice(2)}-${Date.now()}`", spawn)

  assert.ok(builderCall >= 0)
  assert.ok(builderValidation > builderCall)
  assert.ok(spawn > builderValidation)
  assert.ok(productionRun > spawn)
  assert.match(source.slice(spawn, source.indexOf('\n}', spawn)), /env: environment/u)
  assert.match(source.slice(productionRun, source.indexOf('\n', productionRun)), /, env, task9ParentSpawnBudget\(mode\)\)/u)
})
