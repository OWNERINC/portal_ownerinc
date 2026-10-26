import assert from 'node:assert/strict'
import test from 'node:test'
import { runFinalizer } from '../../scripts/finalize-news-protocol.js'

const marker = process.env.PAYLOAD_MANUAL_RUNTIME_MARKER
const url = new URL(process.env.CMS_ADMIN_DATABASE_URL || 'http://invalid')
if (!/^[0-9a-f]{32}$/u.test(marker || '') || url.hostname !== '127.0.0.1' ||
  url.pathname !== '/ownerinc_cms' || decodeURIComponent(url.username) !== 'cms_admin' || !url.password) {
  throw new Error('manual_runtime_finalizer_contract_invalid')
}

test('manual runtime installs the canonical protocol', async () => {
  try {
    const result = await runFinalizer(process.env)
    assert.deepEqual(result, { installed: true, ready: false, coverageVersion: 0 })
  } catch (error) {
    let code: unknown
    try { code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null } catch { code = null }
    if (typeof code === 'string' && /^canonical_function_mismatch:(?:[a-z0-9_]+:(?:sig|sec|owner|config|source|bootstrap)=(?:true|false)(?::(?:sig|sec|owner|config|source|bootstrap)=(?:true|false))*,?)+$/u.test(code)) {
      process.stderr.write(`MANUAL_RUNTIME_FINALIZER_DIAGNOSTIC code=${code}\n`)
    }
    throw error
  }
})
