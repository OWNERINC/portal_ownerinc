import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { runFinalizer, getFinalizerFailureDiagnostic, formatFinalizerFailureDiagnostic } from '../../scripts/finalize-news-protocol.js'
import { serializeManualFinalizerDiagnostic } from '../../../scripts/integration/payload-manual-diagnostics.mjs'

export async function runManualRuntimeFinalizer(operation: () => Promise<unknown> = () => runFinalizer(process.env),
  report: (line: string) => void = line => { process.stderr.write(`${line}\n`) }): Promise<void> {
  try {
    const result = await operation()
    assert.deepEqual(result, { installed: true, ready: false, coverageVersion: 0 })
  } catch (error) {
    const line = serializeManualFinalizerDiagnostic(error, getFinalizerFailureDiagnostic(error), formatFinalizerFailureDiagnostic)
    try { if (line) report(line) } catch { /* Reporting failure must still fail the fixture without raw error text. */ }
    // node:test serializes thrown errors, including message/stack/cause and
    // assertion actual/expected fields. Never rethrow the original object.
    throw new Error('manual_runtime_finalizer_failed')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let valid = false
  try {
    const marker = process.env.PAYLOAD_MANUAL_RUNTIME_MARKER
    const url = new URL(process.env.CMS_ADMIN_DATABASE_URL || 'http://invalid')
    valid = /^[0-9a-f]{32}$/u.test(marker || '') && url.hostname === '127.0.0.1'
      && url.pathname === '/ownerinc_cms' && decodeURIComponent(url.username) === 'cms_admin' && Boolean(url.password)
  } catch { /* Malformed configuration is never printed by URL/URI errors. */ }
  if (!valid) throw new Error('manual_runtime_finalizer_contract_invalid')
  test('manual runtime installs the canonical protocol', () => runManualRuntimeFinalizer())
}
