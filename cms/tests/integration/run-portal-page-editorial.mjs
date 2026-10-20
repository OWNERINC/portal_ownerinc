#!/usr/bin/env node
// Guarded, host-side Portal Pages acceptance. Preflight is intentionally the only
// code reachable before `--execute`; it never reads .env, imports Payload/pg,
// opens a socket, starts Docker, or falls back to runtime database settings.
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkIntegrationDirectories, readIntegrationConfig } from '../support/integration-config.mjs'
import { removeStalePrivateEvidenceFiles, writePrivateEvidence } from '../support/private-evidence.mjs'
import { aggregateAcceptanceCases } from './portal-page-editorial-cases.mjs'

const cmsRoot = fileURLToPath(new URL('../../', import.meta.url))
const allowedArgs = new Set(['--check-config', '--execute'])
const staleTask4Artifacts = Object.freeze([
  'portal-page-editorial-browser.json',
  'portal-page-editorial-storage-state.json',
  'portal-page-editorial-browser-result.json',
  'portal-page-editorial-native.json',
  'portal-page-editorial-migration.json',
  'portal-page-editorial-native-cases.json',
  'portal-page-editorial-result.json',
])
const args = process.argv.slice(2)
const runIDFromEnvironment = process.env.PAYLOAD_TEST_RUN_ID
const fallbackRunID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(runIDFromEnvironment || '')
  ? runIDFromEnvironment : 'unavailable'

function evidence(status, cases, runId = fallbackRunID) {
  return { runId, status, cases }
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function sanitizedGuardCode(error) {
  return error && typeof error === 'object' && typeof error.code === 'string' && /^[a-z0-9_]+$/u.test(error.code)
    ? error.code : 'integration_config_invalid'
}

function minimalEnvironment() {
  const allowed = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
    'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HOME'])
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())))
}

const reportPath = config => path.join(config.evidenceDir, 'portal-page-editorial-result.json')

async function runChild(label, command, childEnv, config) {
  const result = spawnSync(process.execPath, command, {
    cwd: cmsRoot,
    env: childEnv,
    encoding: 'utf8',
    timeout: 240_000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  })
  const summary = {
    command: label,
    status: result.status === 0 && !result.error && !result.signal ? 'PASS' : 'FAIL',
    detail: result.status === 0 && !result.error && !result.signal
      ? 'Disposable local command completed.' : 'Disposable local command failed; raw output was withheld.',
  }
  // Keep no raw child output: adapter errors can contain a full database URI or
  // local paths. The structured result is sufficient for this committed report.
  await writePrivateEvidence(path.join(config.evidenceDir, `portal-page-editorial-${label}.json`),
    `${JSON.stringify({ runId: config.runId, ...summary }, null, 2)}\n`)
  return summary
}

let mode
let config
try {
  if (args.length !== 1 || !allowedArgs.has(args[0])) {
    const unknown = args.find(value => !allowedArgs.has(value))
    emit(evidence('NOT_EXECUTED', [{ name: 'integration configuration', status: 'NOT_EXECUTED',
      detail: unknown ? 'unknown_argument' : 'exactly_one_mode_required' }]))
    process.exitCode = 2
  } else {
    mode = args[0]
    config = readIntegrationConfig(process.env)
    await checkIntegrationDirectories(config)
    if (mode === '--check-config') {
      emit(evidence('NOT_EXECUTED', [{ name: 'disposable fixture configuration', status: 'NOT_EXECUTED',
        detail: 'CONFIG_VALID; service and acceptance checks were not executed.' }], config.runId))
    } else {
      // Validate then remove only exact prior Task 4 outputs before migration,
      // Payload/adapter imports, or any browser/network activity can begin.
      await removeStalePrivateEvidenceFiles(config.evidenceDir, staleTask4Artifacts)
      const childEnv = {
        ...minimalEnvironment(),
        NODE_ENV: 'test',
        NEXT_TELEMETRY_DISABLED: '1',
        MIGRATION_TEST_DISPOSABLE: 'true',
        PAYLOAD_TEST_RUN_ID: config.runId,
        PAYLOAD_TEST_UPLOAD_DIR: config.uploadDir,
        PAYLOAD_TEST_EVIDENCE_DIR: config.evidenceDir,
        PAYLOAD_TEST_PORTAL_DATABASE_URL: config.portalDatabaseURL,
        PAYLOAD_TEST_CMS_DATABASE_URL: config.cmsDatabaseURL,
        CMS_DATABASE_URL: config.cmsDatabaseURL,
        CMS_UPLOAD_DIR: config.uploadDir,
        PAYLOAD_SECRET: randomBytes(36).toString('hex'),
        PAYLOAD_TO_PORTAL_SECRET: randomBytes(36).toString('hex'),
        PORTAL_TO_PAYLOAD_SECRET: randomBytes(36).toString('hex'),
        // Native acceptance runs under NODE_ENV=test; use an HTTPS-only synthetic
        // origin so Payload's non-development cookie policy remains intact.
        PORTAL_PUBLIC_URL: 'https://portal-test.invalid',
        PORTAL_INTERNAL_URL: 'http://127.0.0.1:3101',
      }
      if (config.playwrightModule) childEnv.PAYLOAD_TEST_PLAYWRIGHT_MODULE = config.playwrightModule
      if (childEnv.PAYLOAD_TO_PORTAL_SECRET === childEnv.PORTAL_TO_PAYLOAD_SECRET) {
        childEnv.PORTAL_TO_PAYLOAD_SECRET = randomBytes(36).toString('hex')
      }

      const migration = await runChild('migration', ['node_modules/payload/bin.js', 'migrate'], childEnv, config)
      let native = { command: 'native acceptance', status: 'NOT_EXECUTED', detail: 'migration did not complete.' }
      if (migration.status === 'PASS') {
        native = await runChild('native', ['--import', 'tsx', '--test', '--test-reporter=tap', '--test-force-exit',
          'tests/integration/portal-page-editorial-native.ts'], childEnv, config)
      }
      const browser = { name: 'browser acceptance', status: 'NOT_EXECUTED',
        detail: 'Run the dedicated browser entrypoint with the private fixture handoff after native fixture preparation.' }
      const cases = [
        { name: 'reviewed CMS migrations on the guarded CMS database', status: migration.status,
          detail: migration.detail },
        { name: 'real Payload/PostgreSQL editorial acceptance', status: native.status, detail: native.detail },
        browser,
      ]
      const aggregate = aggregateAcceptanceCases([
        'reviewed CMS migrations on the guarded CMS database',
        'real Payload/PostgreSQL editorial acceptance',
        'browser acceptance',
      ], cases)
      const report = evidence(aggregate.status, aggregate.cases, config.runId)
      await writePrivateEvidence(reportPath(config), `${JSON.stringify(report, null, 2)}\n`)
      emit(report)
      if (aggregate.status !== 'PASS') process.exitCode = aggregate.status === 'FAIL' ? 1 : 2
    }
  }
} catch (error) {
  const code = sanitizedGuardCode(error)
  const report = evidence('NOT_EXECUTED', [{ name: 'disposable fixture configuration', status: 'NOT_EXECUTED', detail: code }])
  emit(report)
  process.exitCode = 2
}
