import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { buildNewsProtocolObserverProvisioningSQL } from '../../scripts/news-protocol-observer-contract.js'
import { runNewsProtocolAudit } from '../../scripts/verify-news-protocol.js'

const action = process.env.PAYLOAD_MANUAL_RUNTIME_PROTOCOL_ACTION
const marker = process.env.PAYLOAD_MANUAL_RUNTIME_MARKER
const adminURL = new URL(process.env.CMS_ADMIN_DATABASE_URL || 'http://invalid')
const observerURL = new URL(process.env.CMS_OBSERVER_DATABASE_URL || 'http://invalid')
const observerPassword = process.env.CMS_OBSERVER_PASSWORD || ''
if (!/^[0-9a-f]{32}$/u.test(marker || '') || !['provision-observer', 'audit'].includes(action || '') ||
  !['127.0.0.1'].includes(adminURL.hostname) || adminURL.pathname !== '/ownerinc_cms' ||
  observerURL.hostname !== adminURL.hostname || observerURL.port !== adminURL.port ||
  observerURL.pathname !== '/ownerinc_cms' || decodeURIComponent(adminURL.username) !== 'cms_admin' ||
  decodeURIComponent(observerURL.username) !== 'cms_observer' || observerURL.password !== observerPassword || observerPassword.length < 32) {
  throw new Error('manual_runtime_protocol_contract_invalid')
}

test(`manual runtime protocol ${action}`, async () => {
  let stage = action === 'audit' ? 'audit' : 'connect'
  try {
    if (action === 'audit') {
      const report = await runNewsProtocolAudit(process.env)
      assert.equal(report.status, 'PASS')
      assert.equal(report.catalogValid, true)
      assert.equal(report.installed, true)
      assert.equal(report.observedCoverageVersion, 1)
      assert.equal(report.observerRole, 'cms_observer')
      return
    }
    const require = createRequire(import.meta.url)
    const { Client } = require('pg') as { Client: new (options: object) => {
      connect(): Promise<void>; query(sql: string): Promise<unknown>; end(): Promise<void>
    } }
    const client = new Client({ connectionString: adminURL.href, connectionTimeoutMillis: 5000 })
    try {
      await client.connect()
      stage = 'provision'
      await client.query(buildNewsProtocolObserverProvisioningSQL(observerPassword))
    } finally { await client.end() }
  } catch (error) {
    let sqlstate = 'none'
    try {
      const value = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : null
      if (typeof value === 'string' && /^[0-9A-Z]{5}$/u.test(value)) sqlstate = value
    } catch { /* Keep the bounded fallback. */ }
    process.stderr.write(`MANUAL_RUNTIME_PROTOCOL_DIAGNOSTIC action=${action} stage=${stage} sqlstate=${sqlstate}\n`)
    throw error
  }
})
