import assert from 'node:assert/strict'
import test from 'node:test'
import type { PortalPageDescriptor } from '../../src/portal-pages/read-file.js'
import { parsePortalPageRange, portalPageMediaResponse } from '../../src/portal-pages/read-file.js'

const pdfID = '018f47a2-7b3c-7a11-8a2c-1234567890b3'
const pdf = Buffer.from('%PDF-1.7\nfixture\n%%EOF\n')

function media(filesize = pdf.length, mimeType: 'application/pdf' | 'video/mp4' = 'application/pdf') {
  const extension = mimeType === 'application/pdf' ? 'pdf' : 'mp4'
  return { id: pdfID, storageKey: `${pdfID}.${extension}`, mimeType, filesize,
    sha256: 'a'.repeat(64), state: 'complete' as const }
}

function descriptor(bytes: Buffer, size = bytes.length) {
  let closed = 0
  let reads = 0
  const handle: PortalPageDescriptor = {
    stat: async () => ({ size, isFile: () => true }),
    read: async (buffer, offset, length, position) => {
      reads++
      const available = Math.min(length, Math.max(0, bytes.length - position))
      bytes.copy(buffer as Buffer, offset, position, position + available)
      return { bytesRead: available, buffer: buffer as Buffer }
    },
    close: async () => { closed++ },
  }
  return { handle, get reads() { return reads }, get closed() { return closed } }
}

test('range parser accepts full, suffix, open-ended and bounded ranges; rejects malformed, multiple and unsatisfiable ranges', () => {
  assert.deepEqual(parsePortalPageRange(null, 10), { start: 0, end: 9, partial: false })
  assert.deepEqual(parsePortalPageRange('bytes=2-4', 10), { start: 2, end: 4, partial: true })
  assert.deepEqual(parsePortalPageRange('bytes=-3', 10), { start: 7, end: 9, partial: true })
  assert.deepEqual(parsePortalPageRange('bytes=4-', 10), { start: 4, end: 9, partial: true })
  assert.deepEqual(parsePortalPageRange('bytes=0-99', 10), { start: 0, end: 9, partial: true })
  for (const range of ['bytes=10-', 'bytes=4-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,2-3', 'items=1-2', 'bytes=9007199254740992-']) {
    assert.equal(parsePortalPageRange(range, 10), null)
  }
})

test('private media returns full 200, byte-range 206, suffix ranges and 416 without leaking paths', async () => {
  const first = descriptor(pdf)
  const full = await portalPageMediaResponse({ media: media(), openDescriptor: async () => first.handle })
  assert.equal(full.status, 200)
  assert.equal(full.headers['Content-Length'], String(pdf.length))
  assert.equal(full.headers['Accept-Ranges'], 'bytes')
  assert.equal(full.headers['Cache-Control'], 'private,no-store')
  assert.equal(full.headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(full.headers['Content-Disposition'], `inline; filename="${pdfID}.pdf"`)
  assert.ok(!JSON.stringify(full.headers).includes('storageKey'))
  assert.deepEqual(Buffer.from(await new Response(full.body).arrayBuffer()), pdf)
  assert.equal(first.closed, 1)

  const selected = descriptor(pdf)
  const partial = await portalPageMediaResponse({ media: media(), range: 'bytes=-4', openDescriptor: async () => selected.handle })
  assert.equal(partial.status, 206)
  assert.equal(partial.headers['Content-Range'], `bytes ${pdf.length - 4}-${pdf.length - 1}/${pdf.length}`)
  assert.deepEqual(Buffer.from(await new Response(partial.body).arrayBuffer()), pdf.subarray(-4))
  assert.equal(selected.closed, 1)

  const rejected = descriptor(pdf)
  const unsatisfiable = await portalPageMediaResponse({ media: media(), range: 'bytes=0-1,3-4', openDescriptor: async () => rejected.handle })
  assert.equal(unsatisfiable.status, 416)
  assert.equal(unsatisfiable.headers['Content-Range'], `bytes */${pdf.length}`)
  assert.equal(unsatisfiable.headers['Content-Length'], '0')
  assert.equal(unsatisfiable.body, null)
  assert.equal(rejected.closed, 1)
})

test('images ignore Range and do not advertise byte ranges', async () => {
  const pngID = '018f47a2-7b3c-7a11-8a2c-1234567890b4'
  const image = { id: pngID, storageKey: `${pngID}.png`, mimeType: 'image/png' as const, filesize: pdf.length,
    sha256: 'b'.repeat(64), state: 'complete' as const }
  const opened = descriptor(pdf)
  const result = await portalPageMediaResponse({ media: image, range: 'bytes=0-1', openDescriptor: async () => opened.handle })
  assert.equal(result.status, 200)
  assert.equal(result.headers['Accept-Ranges'], undefined)
  assert.equal(result.headers['Content-Range'], undefined)
  await result.body?.cancel()
  assert.equal(opened.closed, 1)
})

test('500 MiB video metadata streams bounded 64 KiB reads without allocating the object', async () => {
  const size = 500 * 1024 * 1024
  const video = descriptor(Buffer.alloc(64 * 1024), size)
  const response = await portalPageMediaResponse({ media: media(size, 'video/mp4'), openDescriptor: async () => video.handle })
  assert.equal(response.status, 200)
  assert.equal(response.headers['Content-Length'], String(size))
  const reader = response.body!.getReader()
  const first = await reader.read()
  assert.equal(first.value?.byteLength, 64 * 1024)
  await reader.cancel()
  assert.equal(video.closed, 1)
})

test('a paused consumer pulls exactly one 64 KiB chunk on demand and cancellation closes once', async () => {
  const bytes = Buffer.alloc(256 * 1024)
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251
  const opened = descriptor(bytes)
  const response = await portalPageMediaResponse({ media: media(bytes.length), openDescriptor: async () => opened.handle })
  const reader = response.body!.getReader()
  assert.equal(opened.reads, 0, 'opening the response must not prefetch file data')
  const first = await reader.read()
  assert.equal(first.value?.byteLength, 64 * 1024)
  assert.equal(opened.reads, 1, 'the first demand should cause exactly one bounded descriptor read')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(opened.reads, 1, 'a paused consumer must not trigger a speculative next chunk')
  const second = await reader.read()
  assert.equal(second.value?.byteLength, 64 * 1024)
  assert.equal(opened.reads, 2)
  await reader.cancel()
  assert.equal(opened.closed, 1)
})

test('abort and consumer cancellation close the exact descriptor', async () => {
  const abortFixture = descriptor(pdf)
  const abort = new AbortController()
  const aborted = await portalPageMediaResponse({ media: media(), signal: abort.signal, openDescriptor: async () => abortFixture.handle })
  const abortedReader = aborted.body!.getReader()
  abort.abort()
  await assert.rejects(abortedReader.read())
  assert.equal(abortFixture.closed, 1)

  const cancelFixture = descriptor(pdf)
  const cancelled = await portalPageMediaResponse({ media: media(), openDescriptor: async () => cancelFixture.handle })
  await cancelled.body?.cancel()
  assert.equal(cancelFixture.closed, 1)
})
