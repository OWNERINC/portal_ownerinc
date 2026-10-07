import assert from 'node:assert/strict'
import test from 'node:test'
import { task9ProxyHeaders } from '../integration/task9-proxy-headers.mjs'

test('Task9 proxy uses the external authority for Host and X-Forwarded-Host without bypassing Origin', () => {
  const incoming = {
    host: '127.0.0.1:19091',
    origin: 'http://127.0.0.1:19091',
    'x-forwarded-host': 'attacker.invalid:443',
    'x-forwarded-port': '443',
    connection: 'keep-alive',
    'content-type': 'text/plain',
  }
  const forwarded = task9ProxyHeaders(incoming, 'http://127.0.0.1:19091')

  assert.equal(forwarded.host, '127.0.0.1:19091')
  assert.equal(forwarded['x-forwarded-host'], '127.0.0.1:19091')
  assert.equal(forwarded.origin, 'http://127.0.0.1:19091')
  assert.equal(Object.hasOwn(forwarded, 'x-forwarded-port'), false)
  assert.equal(Object.hasOwn(forwarded, 'connection'), false)
  assert.equal(forwarded['content-type'], 'text/plain')
  assert.equal(incoming['x-forwarded-host'], 'attacker.invalid:443', 'the caller headers are not mutated')
})
