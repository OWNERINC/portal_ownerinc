import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import test from 'node:test'
import {
  expectedPortalPageUploadChunkBytes,
  streamPortalPageBytes,
  validatePortalPageUploadInit,
} from '../../../src/portal-pages/upload-service'

const MiB = 1024 * 1024

test('upload policy accepts the exact declared limits and rejects one byte over before allocating file data', () => {
  for (const [mimeType, bytes] of [
    ['image/jpeg', 15 * MiB], ['image/png', 15 * MiB], ['image/webp', 15 * MiB],
    ['application/pdf', 100 * MiB], ['video/mp4', 500 * MiB], ['video/webm', 500 * MiB],
  ] as const) {
    const upload = validatePortalPageUploadInit({ originalName: 'arquivo', mimeType, bytes })
    assert.equal(upload.bytes, bytes)
    assert.equal(upload.chunkCount, Math.ceil(bytes / (5 * MiB)))
  }
  for (const [mimeType, bytes] of [
    ['image/jpeg', 15 * MiB + 1], ['application/pdf', 100 * MiB + 1],
    ['video/mp4', 500 * MiB + 1], ['video/quicktime', 1], ['video/mov', 1],
  ]) assert.throws(() => validatePortalPageUploadInit({ originalName: 'arquivo', mimeType, bytes }))
  assert.equal(expectedPortalPageUploadChunkBytes(500 * MiB, 100, 99), 5 * MiB)
  assert.throws(() => expectedPortalPageUploadChunkBytes(500 * MiB, 100, 100))
})

test('500 MiB generated source is consumed and hashed through backpressure without a whole-file buffer', { timeout: 120_000 }, async () => {
  const totalBytes = 500 * MiB
  const window = Buffer.alloc(64 * 1024, 0x61)
  const expectedHash = createHash('sha256')
  for (let remaining = totalBytes; remaining > 0; remaining -= window.length) expectedHash.update(window)
  let produced = 0
  let writes = 0
  let sinkBytes = 0
  let maxWriteBytes = 0
  let maxQueuedBytes = 0
  const source = Readable.from((function* () {
    for (let remaining = totalBytes; remaining > 0; remaining -= window.length) {
      produced++
      yield window
    }
  })(), { objectMode: false, highWaterMark: window.length })
  const sink = new Writable({
    highWaterMark: window.length,
    write(chunk, _encoding, callback) {
      writes++
      sinkBytes += chunk.length
      maxWriteBytes = Math.max(maxWriteBytes, chunk.length)
      maxQueuedBytes = Math.max(maxQueuedBytes, this.writableLength)
      queueMicrotask(callback)
    },
  })

  const result = await streamPortalPageBytes([source], sink, totalBytes)
  assert.equal(result.bytes, totalBytes)
  assert.equal(result.sha256, expectedHash.digest('hex'))
  assert.equal(sinkBytes, totalBytes)
  assert.ok(writes > 0 && writes <= totalBytes / window.length)
  assert.ok(maxWriteBytes <= window.length)
  assert.ok(maxQueuedBytes <= window.length * 2)
  assert.ok(produced - writes <= 4, 'source production remains close to downstream consumption under backpressure')
})
