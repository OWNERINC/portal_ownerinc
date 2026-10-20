import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createUploadClient, readCompleteMedia, validateUploadFile } from '../../src/admin/portal-pages/upload-client'
import type { CompleteMedia, MediaKind, UploadProgress } from '../../src/admin/portal-pages/upload-client'

const MiB = 1024 * 1024
const CHUNK = 5 * MiB
const uploadID = '11111111-1111-4111-8111-111111111111'
const mediaID = '22222222-2222-4222-8222-222222222222'
const token = 'A'.repeat(43)
const hash = 'a'.repeat(64)
const completedAt = '2026-10-19T10:00:00.000Z'

type Call = { url: string; init?: RequestInit }

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function initReceipt(overrides: Record<string, unknown> = {}) {
  return { id: uploadID, token, chunkSize: CHUNK, chunkCount: 1, bytes: 3, mimeType: 'image/png', ...overrides }
}

function completeReceipt(overrides: Record<string, unknown> = {}) {
  return { id: uploadID, state: 'complete', mimeType: 'image/png', bytes: 3, sha256: hash, completedAt, ...overrides }
}

function collectionReceipt(overrides: Record<string, unknown> = {}) {
  return { id: mediaID, state: 'complete', mimeType: 'image/png', filesize: 3, sha256: hash, completedAt, ...overrides }
}

function virtualFile(size: number, name = 'photo.png', type = 'image/png') {
  const slices: Array<{ start: number; end: number; blob: Blob }> = []
  const blobs = new Map<number, Blob>()
  const forbiddenReads: string[] = []
  const file = {
    name, type, size,
    slice(start = 0, end = size) {
      assert.ok(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start)
      const length = end - start
      assert.ok(length <= CHUNK, `slice exceeded ${CHUNK} bytes: ${length}`)
      let blob = blobs.get(length)
      if (!blob) {
        blob = new Blob([new Uint8Array(length)], { type })
        blobs.set(length, blob)
      }
      slices.push({ start, end, blob })
      return blob
    },
    async arrayBuffer() { forbiddenReads.push('arrayBuffer'); throw new Error('whole-file read forbidden') },
    async text() { forbiddenReads.push('text'); throw new Error('whole-file read forbidden') },
    stream() { forbiddenReads.push('stream'); throw new Error('whole-file read forbidden') },
  } as unknown as File
  return { file, slices, forbiddenReads }
}

function options(fetch: typeof globalThis.fetch, onProgress: (progress: UploadProgress) => void = () => {},
  sleeps: number[] = []) {
  return { fetch, sleep: async (ms: number, signal: AbortSignal) => {
    assert.equal(signal.aborted, false, 'retry sleep must be abortable')
    sleeps.push(ms)
  }, random: () => 0.5, onProgress }
}

function routes(overrides: { bytes?: number; mimeType?: string; chunk?: (index: number, call: Call) => Response | Promise<Response>;
  complete?: () => Response | Promise<Response> } = {}) {
  const calls: Call[] = []
  let active = 0
  let maxActive = 0
  const bytes = overrides.bytes ?? 3
  const mimeType = overrides.mimeType ?? 'image/png'
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call = { url: String(input), init }
    calls.push(call)
    active += 1
    maxActive = Math.max(maxActive, active)
    try {
      if (call.url === '/editorial/api/portal-page-uploads/init') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return json({ id: uploadID, token, chunkSize: CHUNK, chunkCount: Math.ceil(bytes / CHUNK),
          bytes: body.bytes, mimeType: body.mimeType }, 201)
      }
      const chunkMatch = call.url.match(/\/portal-page-uploads\/([^/]+)\/chunks\/(\d+)$/u)
      if (chunkMatch) return overrides.chunk?.(Number(chunkMatch[2]), call) ?? json({ id: uploadID,
        index: Number(chunkMatch[2]), received: true, duplicate: false, sha256: hash })
      if (call.url === `/editorial/api/portal-page-uploads/${uploadID}/complete`) {
        return overrides.complete?.() ?? json({ id: uploadID, state: 'complete', mimeType, bytes, sha256: hash, completedAt })
      }
      if (call.url === `/editorial/api/portal-page-media/${mediaID}?depth=0`) return json(collectionReceipt({ mimeType, filesize: bytes }))
      throw new Error(`unexpected route: ${call.url}`)
    } finally { active -= 1 }
  }
  return { fetch, calls, get active() { return active }, get maxActive() { return maxActive } }
}

test('closed extension fallback never accepts generic MIME', () => {
  assert.deepEqual(validateUploadFile({ name: 'image.jpeg', type: 'image/jpeg', size: 1 }, 'image'),
    { mimeType: 'image/jpeg', bytes: 1 })
  assert.deepEqual(validateUploadFile({ name: 'image.png', type: 'image/png', size: 1 }, 'image'),
    { mimeType: 'image/png', bytes: 1 })
  assert.deepEqual(validateUploadFile({ name: 'image.webp', type: 'image/webp', size: 1 }, 'image'),
    { mimeType: 'image/webp', bytes: 1 })
  assert.deepEqual(validateUploadFile({ name: 'doc.pdf', type: 'application/pdf', size: 1 }, 'pdf'),
    { mimeType: 'application/pdf', bytes: 1 })
  assert.deepEqual(validateUploadFile({ name: 'clip.mp4', type: 'video/mp4', size: 1 }, 'video'),
    { mimeType: 'video/mp4', bytes: 1 })
  assert.deepEqual(validateUploadFile({ name: 'clip.webm', type: 'video/webm', size: 1 }, 'video'),
    { mimeType: 'video/webm', bytes: 1 })
  assert.deepEqual(validateUploadFile({ name: 'Foto.JPG', type: '', size: 1 }, 'image'),
    { mimeType: 'image/jpeg', bytes: 1 })
  assert.throws(() => validateUploadFile({ name: 'foto.jpg', type: 'application/octet-stream', size: 1 }, 'image'))
  assert.throws(() => validateUploadFile({ name: 'video.mov', type: 'video/quicktime', size: 1 }, 'video'))
  for (const invalid of [
    { name: 'image.svg', type: 'image/svg+xml', size: 1 },
    { name: 'image.gif', type: 'image/gif', size: 1 },
    { name: 'page.html', type: 'text/html', size: 1 },
    { name: 'image.png', type: 'image/jpeg', size: 1 },
    { name: 'image.png', type: '', size: 0 },
    { name: 'video.mp4', type: 'video/mp4', size: 500 * MiB + 1 },
    { name: 'image.webp', type: 'image/webp', size: 15 * MiB + 1 },
    { name: 'document.pdf', type: 'application/pdf', size: 100 * MiB + 1 },
  ]) {
    const kind: MediaKind = invalid.name.endsWith('.pdf') ? 'pdf' : invalid.name.endsWith('.mp4') ? 'video' : 'image'
    assert.throws(() => validateUploadFile(invalid, kind), invalid.name)
  }
})

test('500 MiB video uses 100 sequential 5 MiB Blob slices without whole-file reads or forbidden headers', async () => {
  const bytes = 500 * MiB
  const { file, slices, forbiddenReads } = virtualFile(bytes, 'long.mp4', 'video/mp4')
  const calls: Call[] = []
  let active = 0
  let maxActive = 0
  const progress: UploadProgress[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    active += 1
    maxActive = Math.max(active, maxActive)
    try {
      if (String(input).endsWith('/init')) return json(initReceipt({ bytes, chunkCount: 100, mimeType: 'video/mp4' }), 201)
      const chunk = String(input).match(/\/chunks\/(\d+)$/u)
      if (chunk) {
        const body = init?.body
        assert.ok(body instanceof Blob)
        assert.ok(body.size <= CHUNK)
        assert.equal((init?.headers as Record<string, string>)['Content-Type'], 'application/octet-stream')
        assert.equal(Object.keys(init?.headers as Record<string, unknown>).some(key => key.toLowerCase() === 'content-length'), false)
        assert.equal(body instanceof FormData, false)
        await Promise.resolve()
        return json({ id: uploadID, index: Number(chunk[1]), received: true, duplicate: false, sha256: hash })
      }
      if (String(input).endsWith('/complete')) return json(completeReceipt({ mimeType: 'video/mp4', bytes }))
      throw new Error('unexpected_route')
    } finally { active -= 1 }
  }
  const client = createUploadClient(options(fetch, item => progress.push(item)))
  const result = await client.start(file, 'video')

  assert.equal(result.bytes, bytes)
  assert.equal(slices.length, 100)
  assert.deepEqual(slices.map((slice, index) => [slice.start, slice.end]),
    Array.from({ length: 100 }, (_, index) => [index * CHUNK, (index + 1) * CHUNK]))
  assert.ok(slices.every(slice => slice.blob instanceof Blob && slice.blob.size === CHUNK))
  assert.equal(maxActive, 1)
  assert.equal(active, 0)
  assert.equal(calls.length, 102)
  assert.equal(forbiddenReads.length, 0)
  assert.equal(progress.at(-1)?.phase, 'ready')
  assert.equal(progress.at(-1)?.confirmedBytes, bytes)
  assert.equal(calls.every(call => !Object.keys(call.init?.headers as Record<string, unknown> ?? {})
    .some(key => key.toLowerCase() === 'content-length')), true)
})

test('the final partial chunk is sliced and acknowledged at its exact byte size', async () => {
  const bytes = CHUNK + 7
  const { file, slices } = virtualFile(bytes, 'partial.mp4', 'video/mp4')
  const api = routes({ bytes, mimeType: 'video/mp4' })
  const client = createUploadClient(options(api.fetch))

  assert.equal((await client.start(file, 'video')).bytes, bytes)
  assert.deepEqual(slices.map(slice => [slice.start, slice.end]), [[0, CHUNK], [CHUNK, bytes]])
  assert.deepEqual(slices.map(slice => slice.blob.size), [CHUNK, 7])
})

test('init validates exact UUID, private token syntax, chunk size/count, bytes and MIME before any chunk', async () => {
  const { file } = virtualFile(3)
  for (const overrides of [
    { id: 'not-a-uuid' }, { token: 'secret-token' }, { chunkSize: CHUNK - 1 }, { chunkCount: 2 },
    { bytes: 4 }, { mimeType: 'image/jpeg' },
  ]) {
    let chunkRequests = 0
    const fetch: typeof globalThis.fetch = async (input) => {
      if (String(input).endsWith('/init')) return json(initReceipt(overrides), 201)
      chunkRequests += 1
      return json({ id: uploadID, index: 0, received: true, duplicate: false, sha256: hash })
    }
    const observed: UploadProgress[] = []
    const client = createUploadClient(options(fetch, value => observed.push(value)))
    await assert.rejects(client.start(file, 'image'))
    assert.equal(chunkRequests, 0)
    assert.equal(JSON.stringify(observed).includes(token), false)
  }
})

test('chunk acknowledgement validates identity, index, received, duplicate and required SHA-256', async () => {
  const { file } = virtualFile(3)
  for (const body of [
    { id: mediaID, index: 0, received: true, duplicate: false, sha256: hash },
    { id: uploadID, index: 1, received: true, duplicate: false, sha256: hash },
    { id: uploadID, index: 0, received: false, duplicate: false, sha256: hash },
    { id: uploadID, index: 0, received: true, duplicate: false },
    { id: uploadID, index: 0, received: true, duplicate: true, sha256: 'bad-hash' },
  ]) {
    const fetch: typeof globalThis.fetch = async input => String(input).endsWith('/init')
      ? json(initReceipt(), 201) : json(body)
    await assert.rejects(createUploadClient(options(fetch)).start(file, 'image'))
  }
})

test('duplicate chunk acknowledgement advances confirmed bytes once without requiring a response hash', async () => {
  const { file } = virtualFile(3)
  const progress: UploadProgress[] = []
  const api = routes({ chunk: () => json({ id: uploadID, index: 0, received: true, duplicate: true }) })
  const client = createUploadClient(options(api.fetch, item => progress.push(item)))

  await client.start(file, 'image')
  const confirmed = progress.filter(item => item.phase === 'uploading' && item.confirmedBytes === 3)
  assert.equal(confirmed.length, 1)
  assert.equal(progress.at(-1)?.phase, 'ready')
})

test('network-lost acknowledgement retries the identical chunk body and reconciles its duplicate acknowledgement', async () => {
  const { file } = virtualFile(CHUNK + 1, 'retry.mp4', 'video/mp4')
  const bodies: Array<BodyInit | null | undefined> = []
  let chunkAttempts = 0
  const sleeps: number[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/init')) return json(initReceipt({ bytes: CHUNK + 1, chunkCount: 2, mimeType: 'video/mp4' }), 201)
    if (url.includes('/chunks/0')) {
      bodies.push(init?.body)
      if (chunkAttempts++ === 0) throw new TypeError('private network detail')
      return json({ id: uploadID, index: 0, received: true, duplicate: true })
    }
    if (url.includes('/chunks/1')) return json({ id: uploadID, index: 1, received: true, duplicate: false, sha256: hash })
    if (url.endsWith('/complete')) return json(completeReceipt({ bytes: CHUNK + 1, mimeType: 'video/mp4' }))
    throw new Error('unexpected_route')
  }
  const progress: UploadProgress[] = []
  const client = createUploadClient(options(fetch, item => progress.push(item), sleeps))

  await client.start(file, 'video')
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0], bodies[1], 'retry must reuse the same Blob slice')
  assert.deepEqual(sleeps, [1050])
  assert.equal(progress.some(item => item.confirmedBytes === CHUNK && item.index === 1), true)
  assert.equal(progress.at(-1)?.confirmedBytes, CHUNK + 1)
})

test('complete validates the exact upload identity, MIME, byte size, SHA-256 and ISO timestamp', async () => {
  const { file } = virtualFile(3)
  for (const overrides of [
    { id: mediaID }, { state: 'uploading' }, { mimeType: 'image/jpeg' }, { bytes: 4 },
    { sha256: 'f'.repeat(63) }, { completedAt: 'yesterday' }, { extra: 'forbidden' },
  ]) {
    const fetch: typeof globalThis.fetch = async input => String(input).endsWith('/init')
      ? json(initReceipt(), 201) : String(input).endsWith('/complete') ? json(completeReceipt(overrides))
        : json({ id: uploadID, index: 0, received: true, duplicate: false, sha256: hash })
    await assert.rejects(createUploadClient(options(fetch)).start(file, 'image'))
  }
})

test('same-origin POST and chunk request bodies use only the required protocol fields', async () => {
  const { file } = virtualFile(3)
  const api = routes()
  const client = createUploadClient(options(api.fetch))
  await client.start(file, 'image')

  const init = api.calls[0]!
  assert.equal(init.url, '/editorial/api/portal-page-uploads/init')
  assert.equal(init.init?.method, 'POST')
  assert.equal(init.init?.credentials, 'same-origin')
  assert.deepEqual(init.init?.headers, { 'Content-Type': 'application/json' })
  assert.deepEqual(JSON.parse(String(init.init?.body)), { originalName: 'photo.png', mimeType: 'image/png', bytes: 3 })
  const chunk = api.calls.find(call => call.url.includes('/chunks/'))!
  assert.equal(chunk.init?.method, 'PUT')
  assert.equal(chunk.init?.credentials, 'same-origin')
  assert.deepEqual(chunk.init?.headers, { 'Content-Type': 'application/octet-stream', 'x-portal-page-upload-token': token })
  assert.ok(chunk.init?.body instanceof Blob)
  assert.equal(chunk.init?.body instanceof FormData, false)
  const complete = api.calls.find(call => call.url.endsWith('/complete'))!
  assert.equal(complete.init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(complete.init?.body)), { token })
  for (const call of api.calls) {
    assert.equal(call.init?.credentials, 'same-origin')
    assert.equal(Object.keys(call.init?.headers as Record<string, unknown> ?? {})
      .some(key => key.toLowerCase() === 'content-length'), false)
  }
})

test('readCompleteMedia uses authenticated no-store collection GET and maps filesize to bytes', async () => {
  let received: Call | undefined
  const fetch: typeof globalThis.fetch = async (input, init) => {
    received = { url: String(input), init }
    return json(collectionReceipt())
  }
  const signal = new AbortController().signal

  assert.deepEqual(await readCompleteMedia(mediaID, 'image', signal, fetch), {
    id: mediaID, state: 'complete', mimeType: 'image/png', bytes: 3, sha256: hash, completedAt,
  } satisfies CompleteMedia)
  assert.equal(received?.url, `/editorial/api/portal-page-media/${mediaID}?depth=0`)
  assert.equal(received?.init?.method, undefined)
  assert.equal(received?.init?.credentials, 'same-origin')
  assert.equal(received?.init?.cache, 'no-store')
  assert.equal(received?.init?.signal, signal)
})

test('a deliberate new start after completion creates a fresh sequential upload session', async () => {
  const firstFile = virtualFile(3, 'first.png').file
  const secondFile = virtualFile(3, 'second.png').file
  const ids = [uploadID, mediaID]
  let currentID = ''
  let initCount = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/init')) {
      const body = JSON.parse(String(init?.body)) as { bytes: number; mimeType: string }
      currentID = ids[initCount]!
      initCount += 1
      return json(initReceipt({ id: currentID, bytes: body.bytes, mimeType: body.mimeType }), 201)
    }
    const chunkMatch = url.match(/\/portal-page-uploads\/([^/]+)\/chunks\/(\d+)$/u)
    if (chunkMatch) return json({ id: chunkMatch[1], index: Number(chunkMatch[2]), received: true,
      duplicate: false, sha256: hash })
    const completeMatch = url.match(/\/portal-page-uploads\/([^/]+)\/complete$/u)
    if (completeMatch) return json(completeReceipt({ id: completeMatch[1] }))
    throw new Error(`unexpected route: ${url}`)
  }
  const client = createUploadClient(options(fetch))

  const first = await client.start(firstFile, 'image')
  const second = await client.start(secondFile, 'image')

  assert.equal(first.id, uploadID)
  assert.equal(second.id, mediaID)
  assert.equal(initCount, 2)
  assert.equal((await client.retry()).id, mediaID)
})

test('collection reread rejects wrong ID, uploading state, incompatible MIME, invalid hash, and invalid date', async () => {
  for (const overrides of [
    { id: uploadID }, { state: 'uploading' }, { mimeType: 'video/mp4' }, { sha256: 'x'.repeat(64) },
    { completedAt: 'not-a-date' }, { filesize: 0 },
  ]) {
    const fetch: typeof globalThis.fetch = async () => json(collectionReceipt(overrides))
    await assert.rejects(readCompleteMedia(mediaID, 'image', new AbortController().signal, fetch))
  }
})

test('chunk retries are bounded to initial plus three transient attempts and never retry permanent failures', async () => {
  const { file } = virtualFile(3)
  const cases = [
    { name: 'upload_busy', status: 409, code: 'upload_busy', attempts: 4 },
    { name: '429', status: 429, code: 'upload_limit_reached', attempts: 4 },
    { name: '503', status: 503, code: 'upload_unavailable', attempts: 4 },
    { name: 'chunk_conflict', status: 409, code: 'chunk_conflict', attempts: 1 },
    { name: 'invalid token', status: 401, code: 'invalid_upload_token', attempts: 1 },
    { name: 'forbidden', status: 403, code: 'forbidden', attempts: 1 },
    { name: 'bad request', status: 400, code: 'invalid_chunk', attempts: 1 },
    { name: 'missing', status: 404, code: 'upload_not_found', attempts: 1 },
    { name: 'too large', status: 413, code: 'media_too_large', attempts: 1 },
    { name: 'unsupported', status: 415, code: 'unsupported_media', attempts: 1 },
    { name: 'disk', status: 507, code: 'insufficient_disk_space', attempts: 1 },
  ]
  for (const item of cases) {
    let attempts = 0
    const sleeps: number[] = []
    const fetch: typeof globalThis.fetch = async input => {
      if (String(input).endsWith('/init')) return json(initReceipt(), 201)
      if (String(input).includes('/chunks/')) {
        attempts += 1
        return json({ error: item.code, message: 'ignored' }, item.status)
      }
      return json(completeReceipt())
    }
    await assert.rejects(createUploadClient(options(fetch, () => {}, sleeps)).start(file, 'image'))
    assert.equal(attempts, item.attempts, item.name)
    assert.equal(sleeps.length, item.attempts - 1, item.name)
    if (item.attempts === 4) assert.deepEqual(sleeps, [1050, 2050, 4050], item.name)
  }
})

test('init network loss is never retried and requires a conscious new initiation', async () => {
  const { file } = virtualFile(3)
  let calls = 0
  const fetch: typeof globalThis.fetch = async () => { calls += 1; throw new TypeError('private raw network message') }
  const client = createUploadClient(options(fetch))
  await assert.rejects(client.start(file, 'image'), error => {
    assert.equal((error as Error).message.includes('private raw network message'), false)
    assert.match((error as Error).message, /reserva|pendente|iniciar/iu)
    return true
  })
  assert.equal(calls, 1)
  await assert.rejects(client.retry())
  assert.equal(calls, 1)
})

test('complete transient failures use bounded retries with the same upload identity and token', async () => {
  const { file } = virtualFile(3)
  let attempts = 0
  const completeBodies: string[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/init')) return json(initReceipt(), 201)
    if (String(input).includes('/chunks/')) return json({ id: uploadID, index: 0, received: true, duplicate: false, sha256: hash })
    if (String(input).endsWith('/complete')) {
      attempts += 1
      completeBodies.push(String(init?.body))
      return attempts < 4 ? json({ error: 'upload_busy', message: 'ignored' }, 503) : json(completeReceipt())
    }
    throw new Error('unexpected_route')
  }
  const sleeps: number[] = []
  const result = await createUploadClient(options(fetch, () => {}, sleeps)).start(file, 'image')
  assert.equal(result.id, uploadID)
  assert.equal(attempts, 4)
  assert.deepEqual(completeBodies, Array(4).fill(JSON.stringify({ token })))
  assert.deepEqual(sleeps, [1050, 2050, 4050])
})

test('manual retry resumes the last unacknowledged chunk without reinitializing or resending confirmed chunks', async () => {
  const { file, slices } = virtualFile(CHUNK + 1, 'resume.mp4', 'video/mp4')
  let initCalls = 0
  let chunkZeroCalls = 0
  let chunkOneCalls = 0
  let allowRetry = false
  const chunkHeaders: Array<Record<string, string>> = []
  const sleeps: number[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/init')) {
      initCalls += 1
      return json(initReceipt({ bytes: CHUNK + 1, chunkCount: 2, mimeType: 'video/mp4' }), 201)
    }
    if (url.endsWith('/chunks/0')) {
      chunkZeroCalls += 1
      return json({ id: uploadID, index: 0, received: true, duplicate: false, sha256: hash })
    }
    if (url.endsWith('/chunks/1')) {
      chunkOneCalls += 1
      chunkHeaders.push(init?.headers as Record<string, string>)
      if (!allowRetry) return json({ error: 'upload_busy', message: 'ignored' }, 409)
      return json({ id: uploadID, index: 1, received: true, duplicate: false, sha256: hash })
    }
    if (url.endsWith('/complete')) return json(completeReceipt({ bytes: CHUNK + 1, mimeType: 'video/mp4' }))
    throw new Error('unexpected_route')
  }
  const progress: UploadProgress[] = []
  const client = createUploadClient(options(fetch, item => progress.push(item), sleeps))

  await assert.rejects(client.start(file, 'video'))
  assert.equal(initCalls, 1)
  assert.equal(chunkZeroCalls, 1)
  assert.equal(chunkOneCalls, 4, 'one initial plus three automatic transient retries')
  assert.equal(progress.at(-1)?.confirmedBytes, CHUNK)
  allowRetry = true
  const complete = await client.retry()

  assert.equal(complete.bytes, CHUNK + 1)
  assert.equal(initCalls, 1, 'manual retry must keep the existing reservation')
  assert.equal(chunkZeroCalls, 1, 'confirmed chunk must not be resent')
  assert.equal(chunkOneCalls, 5, 'manual retry resumes at the unacknowledged index')
  assert.ok(chunkHeaders.every(headers => headers['x-portal-page-upload-token'] === token))
  assert.deepEqual(slices.map(slice => [slice.start, slice.end]), [
    [0, CHUNK], [CHUNK, CHUNK + 1], [CHUNK, CHUNK + 1],
  ])
  assert.equal(progress.at(-1)?.confirmedBytes, CHUNK + 1)
})

test('manual retry can resume complete validation with the same token after bounded transient attempts', async () => {
  const { file } = virtualFile(3)
  let initCalls = 0
  let chunkCalls = 0
  let completeCalls = 0
  let allowRetry = false
  const bodies: string[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/init')) { initCalls += 1; return json(initReceipt(), 201) }
    if (url.includes('/chunks/')) {
      chunkCalls += 1
      return json({ id: uploadID, index: 0, received: true, duplicate: false, sha256: hash })
    }
    if (url.endsWith('/complete')) {
      completeCalls += 1
      bodies.push(String(init?.body))
      return !allowRetry && completeCalls <= 4
        ? json({ error: 'upload_busy', message: 'ignored' }, 503) : json(completeReceipt())
    }
    throw new Error('unexpected_route')
  }
  const client = createUploadClient(options(fetch))

  await assert.rejects(client.start(file, 'image'))
  assert.equal(initCalls, 1)
  assert.equal(chunkCalls, 1)
  assert.equal(completeCalls, 4)
  allowRetry = true
  assert.equal((await client.retry()).state, 'complete')
  assert.equal(initCalls, 1)
  assert.equal(chunkCalls, 1)
  assert.equal(completeCalls, 5)
  assert.ok(bodies.every(body => body === JSON.stringify({ token })))
})

test('cancel aborts and settles the active chunk before a fresh-controller authenticated DELETE', async () => {
  const { file } = virtualFile(3)
  let enteredChunk!: () => void
  const chunkStarted = new Promise<void>(resolve => { enteredChunk = resolve })
  const calls: Call[] = []
  let chunkSignal: AbortSignal | undefined
  let deleteSignal: AbortSignal | undefined
  let active = 0
  let maxActive = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    active += 1
    maxActive = Math.max(active, maxActive)
    try {
      if (url.endsWith('/init')) return json(initReceipt(), 201)
      if (url.includes('/chunks/')) {
        chunkSignal = init?.signal as AbortSignal
        enteredChunk()
        return await new Promise<Response>((_resolve, reject) => chunkSignal!.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        }, { once: true }))
      }
      if (init?.method === 'DELETE') {
        deleteSignal = init.signal as AbortSignal
        return json({ id: uploadID, cancelled: true })
      }
      throw new Error('unexpected_route')
    } finally { active -= 1 }
  }
  const client = createUploadClient(options(fetch))
  const started = client.start(file, 'image').catch(() => undefined)
  await chunkStarted
  assert.equal(await client.cancel(), 'cancelled')
  await started

  assert.equal(chunkSignal?.aborted, true)
  assert.ok(deleteSignal)
  assert.notEqual(deleteSignal, chunkSignal)
  assert.equal(deleteSignal?.aborted, false)
  assert.equal(maxActive, 1)
  const deletion = calls.find(call => call.init?.method === 'DELETE')!
  assert.equal(deletion.url, `/editorial/api/portal-page-uploads/${uploadID}`)
  assert.deepEqual(JSON.parse(String(deletion.init?.body)), { token })
  assert.equal(deletion.init?.credentials, 'same-origin')
})

test('same-tick cancel activations share one cancellation request', async () => {
  const { file } = virtualFile(3)
  let chunkStarted!: () => void
  let deleteStarted!: () => void
  const chunkReady = new Promise<void>(resolve => { chunkStarted = resolve })
  const deleteReady = new Promise<void>(resolve => { deleteStarted = resolve })
  let releaseDelete!: (response: Response) => void
  const pendingDelete = new Promise<Response>(resolve => { releaseDelete = resolve })
  let deleteCount = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/init')) return json(initReceipt(), 201)
    if (url.includes('/chunks/')) return new Promise<Response>((_resolve, reject) => {
      chunkStarted()
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
    if (init?.method === 'DELETE') {
      deleteCount += 1
      deleteStarted()
      return pendingDelete
    }
    throw new Error('unexpected_route')
  }
  const client = createUploadClient(options(fetch))
  const running = client.start(file, 'image').catch(() => undefined)
  await chunkReady
  const first = client.cancel()
  const second = client.cancel()
  assert.equal(first, second)
  await deleteReady
  assert.equal(deleteCount, 1)
  releaseDelete(json({ id: uploadID, cancelled: true }))
  assert.equal(await first, 'cancelled')
  await running
})

test('media_already_complete during cancellation rereads the collection and returns complete without deleting elsewhere', async () => {
  const pendingFile = virtualFile(3).file
  let collectionReads = 0
  // Start is held at the chunk request until cancel aborts it.
  let chunkStarted!: () => void
  const ready = new Promise<void>(resolve => { chunkStarted = resolve })
  const racing = createUploadClient(options(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/init')) return json(initReceipt(), 201)
    if (url.includes('/chunks/')) return new Promise<Response>((_resolve, reject) => {
      chunkStarted()
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
    if (init?.method === 'DELETE') return json({ error: 'media_already_complete', message: 'ignored' }, 409)
    if (url === `/editorial/api/portal-page-media/${uploadID}?depth=0`) {
      collectionReads += 1
      return json(collectionReceipt({ id: uploadID }))
    }
    throw new Error('unexpected_route')
  }))
  const running = racing.start(pendingFile, 'image').catch(() => undefined)
  await ready
  assert.equal(await racing.cancel(), 'complete')
  assert.deepEqual(await racing.retry(), { id: uploadID, state: 'complete', mimeType: 'image/png',
    bytes: 3, sha256: hash, completedAt } satisfies CompleteMedia)
  await running
  assert.equal(collectionReads, 1)
})

test('exhausted transient cancellation stays pending and never announces cancelled', async () => {
  const { file } = virtualFile(3)
  let enteredChunk!: () => void
  const chunkStarted = new Promise<void>(resolve => { enteredChunk = resolve })
  const progress: UploadProgress[] = []
  let deletes = 0
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith('/init')) return json(initReceipt(), 201)
    if (url.includes('/chunks/')) return new Promise<Response>((_resolve, reject) => {
      enteredChunk()
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
    if (init?.method === 'DELETE') {
      deletes += 1
      throw new TypeError('network')
    }
    throw new Error('unexpected_route')
  }
  const client = createUploadClient(options(fetch, item => progress.push(item)))
  const running = client.start(file, 'image').catch(() => undefined)
  await chunkStarted
  assert.equal(await client.cancel(), 'pending')
  await running
  assert.equal(deletes, 4)
  assert.equal(progress.some(item => item.phase === 'cancelled'), false)
  assert.equal(progress.at(-1)?.phase, 'error')
})

test('dispose aborts, attempts best-effort authenticated cancellation, then removes retry credentials', async () => {
  const { file } = virtualFile(3)
  const calls: Call[] = []
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    if (String(input).endsWith('/init')) return json(initReceipt(), 201)
    if (String(input).includes('/chunks/')) return json({ error: 'upload_busy', message: 'ignored' }, 409)
    if (init?.method === 'DELETE') return json({ id: uploadID, cancelled: true })
    throw new Error('unexpected_route')
  }
  const client = createUploadClient(options(fetch))
  await assert.rejects(client.start(file, 'image'))
  client.dispose()
  const before = calls.length
  await assert.rejects(client.retry())
  await Promise.resolve()
  assert.equal(calls.length, before, 'retry after dispose must not use the cleared token')
  const deletion = calls.find(call => call.init?.method === 'DELETE')
  assert.ok(deletion, 'dispose should attempt cleanup before clearing references')
  assert.deepEqual(JSON.parse(String(deletion.init?.body)), { token })
})
