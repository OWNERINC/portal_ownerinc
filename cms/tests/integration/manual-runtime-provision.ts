import test from 'node:test'
import { run } from '../../scripts/provision-db.js'

const marker = process.env.PAYLOAD_MANUAL_RUNTIME_MARKER
const url = new URL(process.env.CMS_DATABASE_URL || 'http://invalid')
if (!/^[0-9a-f]{32}$/u.test(marker || '') || url.hostname !== '127.0.0.1' ||
  url.pathname !== '/ownerinc_cms' || decodeURIComponent(url.username) !== 'cms_migrator' || !url.password) {
  throw new Error('manual_runtime_provision_contract_invalid')
}

test('manual runtime reapplies runtime grants', async () => {
  try { await run('--grants', process.env) }
  catch (error) {
    let reason = 'database_error', sqlstate = 'none'
    try {
      const message = error instanceof Error ? error.message : ''
      if (message === 'Unsafe CMS database role') reason = 'unsafe_role'
      const value = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null
      if (typeof value === 'string' && /^[0-9A-Z]{5}$/u.test(value)) sqlstate = value
    } catch { /* Keep bounded fallbacks. */ }
    process.stderr.write(`MANUAL_RUNTIME_PROVISION_DIAGNOSTIC reason=${reason} sqlstate=${sqlstate}\n`)
    throw error
  }
})
