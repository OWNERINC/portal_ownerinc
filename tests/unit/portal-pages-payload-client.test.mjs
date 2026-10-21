import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPortalPagesClient, validInput } = require('../../api/portal-pages/payload-client');
const { readPortalPageResult } = require('../../api/portal-pages/payload-dto');

const pageID = '018f47a2-7b3c-7a11-8a2c-1234567890ab';
const versionID = '018f47a2-7b3c-7a11-8a2c-1234567890ac';
const assetID = '018f47a2-7b3c-7a11-8a2c-1234567890ad';
const secret = 'portal-to-payload-secret'.padEnd(40, 'x');
const actor = { uid: 'portal-reader', email: 'reader@example.invalid', name: null, canManageKnowledge: false };
const page = {
  id: pageID, slug: 'published-policy', title: 'Published policy', summary: '', cover: null, categories: [],
  published_at: '2026-10-19T10:00:00.000Z', content_version: 1, asset_scope: 'portal-pages',
  content_blocks: [{ type: 'divider' }], revision: { id: versionID, status: 'published' },
};
const assetHeaders = (length, overrides = {}) => ({
  'content-type': 'application/pdf', 'content-length': String(length), 'accept-ranges': 'bytes',
  'content-disposition': `inline; filename="${assetID}.pdf"`, 'cache-control': 'private,no-store',
  'x-content-type-options': 'nosniff', ...overrides,
});

function trackAbortSignal() {
  const listeners = new Set();
  return {
    aborted: false,
    listeners,
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
    abort() {
      this.aborted = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

function makeAssetClient({ body, length = 4, idleTimeoutMs = 100, headers = {}, signal = trackAbortSignal() }) {
  let fetchSignal;
  const client = createPortalPagesClient({ baseURL: 'https://cms.invalid', secret, idleTimeoutMs,
    fetchImpl: async (_url, init) => {
      fetchSignal = init.signal;
      return new Response(body, { headers: assetHeaders(length, headers) });
    },
  });
  return {
    signal,
    get fetchSignal() { return fetchSignal; },
    asset: () => client.asset({ pageId: pageID, revisionId: versionID, assetId: assetID, preview: false, range: null }, actor, { signal }),
  };
}

function jsonResponse(value, headers = {}) {
  return new Response(JSON.stringify(value), { status: 200,
    headers: { 'content-type': 'application/json', ...headers } });
}

test('API DTO validator rejects extra fields, wrong scope/revision, unknown blocks, and oversized content', () => {
  assert.equal(readPortalPageResult('detail', page, { slug: page.slug }), page);
  for (const bad of [
    { ...page, storageKey: '/private/path' },
    { ...page, asset_scope: 'owner-news' },
    { ...page, revision: { id: versionID, status: 'draft' } },
    { ...page, content_blocks: [{ type: 'divider', style: 'red' }] },
    { ...page, content_blocks: [{ type: 'image', asset_id: assetID, alt: 'x', url: 'https://bad.invalid' }] },
    { ...page, slug: 'Not Canonical' },
  ]) assert.throws(() => readPortalPageResult('detail', bad, { slug: page.slug }));
})

test('client makes only bounded service POSTs, validates the DTO, and never forwards browser identity headers', async () => {
  const seen = [];
  const client = createPortalPagesClient({ baseURL: 'https://cms.internal.invalid/', secret,
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return jsonResponse({ rows: [page], count: 1 });
    },
  });
  const result = await client.list({ limit: 50, offset: 0 }, actor, { requestId: 'request-01' });
  assert.deepEqual(result, { rows: [page], count: 1 });
  assert.equal(seen[0].url, 'https://cms.internal.invalid/editorial/api/portal-pages/list');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.redirect, 'error');
  assert.equal(seen[0].init.cache, 'no-store');
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${secret}`);
  assert.equal(seen[0].init.headers['X-Request-ID'], 'request-01');
  assert.equal(Object.keys(seen[0].init.headers).some(key => ['Origin', 'Cookie', 'Sec-Fetch-Site'].includes(key)), false);
  const body = JSON.parse(seen[0].init.body);
  assert.deepEqual(body, { actor, input: { limit: 50, offset: 0 } });
})

test('request header timeout is bounded and JSON streaming uses idle—not total—timeout', async () => {
  const stalled = createPortalPagesClient({ baseURL: 'https://cms.invalid', secret, headerTimeoutMs: 10, idleTimeoutMs: 50,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('private timeout')), { once: true })),
  });
  await assert.rejects(stalled.categories({}, actor), error => error.status === 503 && !/private timeout/.test(error.message));

  const delayedJSON = JSON.stringify({ rows: [page], count: 1 });
  const bytes = Buffer.from(delayedJSON);
  let offset = 0;
  const streaming = createPortalPagesClient({ baseURL: 'https://cms.invalid', secret, headerTimeoutMs: 10, idleTimeoutMs: 100,
    fetchImpl: async () => new Response(new ReadableStream({ async pull(controller) {
      if (offset >= bytes.length) return controller.close();
      await new Promise(resolve => setTimeout(resolve, 12));
      controller.enqueue(bytes.subarray(offset, offset + 20)); offset += 20;
    } }), { headers: { 'content-type': 'application/json' } }),
  });
  const result = await streaming.list({ limit: 1, offset: 0 }, actor);
  assert.equal(result.rows[0].id, pageID);
  assert.ok(Math.ceil(bytes.length / 20) * 12 > 10, 'the complete transfer exceeds the header timeout without being aborted');
})

test('asset client validates 206 headers and streams/cancels without buffering the file', async () => {
  const data = Buffer.from('PDF DATA');
  const client = createPortalPagesClient({ baseURL: 'https://cms.invalid', secret,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.input, { pageId: pageID, revisionId: versionID, assetId: assetID, preview: false, range: 'bytes=1-4' });
      return new Response(data.subarray(1, 5), { status: 206, headers: {
        'content-type': 'application/pdf', 'content-length': '4', 'content-range': 'bytes 1-4/8',
        'accept-ranges': 'bytes', 'content-disposition': `inline; filename="${assetID}.pdf"`,
        'cache-control': 'private,no-store', 'x-content-type-options': 'nosniff',
      } });
    },
  });
  const result = await client.asset({ pageId: pageID, revisionId: versionID, assetId: assetID, preview: false, range: 'bytes=1-4' }, actor);
  assert.equal(result.status, 206);
  assert.equal(result.headers['Content-Range'], 'bytes 1-4/8');
  assert.deepEqual(Buffer.from(await new Response(result.body).arrayBuffer()), data.subarray(1, 5));
})

test('asset rejects >500 MiB, QuickTime, malformed lengths and wrong ranges before streaming', async () => {
  const cases = [
    { status: 200, headers: { 'content-length': String(500 * 1024 * 1024 + 1), 'content-type': 'video/mp4' } },
    { status: 200, headers: { 'content-length': '8', 'content-type': 'video/quicktime' } },
    { status: 206, headers: { 'content-length': '4,4', 'content-type': 'application/pdf', 'content-range': 'bytes 1-4/8' } },
  ];
  for (const entry of cases) {
    const client = createPortalPagesClient({ baseURL: 'https://cms.invalid', secret,
      fetchImpl: async () => new Response('12345678', { status: entry.status, headers: {
        ...entry.headers, 'accept-ranges': 'bytes', 'content-disposition': `inline; filename="${assetID}.pdf"`,
        'cache-control': 'private,no-store', 'x-content-type-options': 'nosniff',
      } }),
    });
    await assert.rejects(client.asset({ pageId: pageID, revisionId: versionID, assetId: assetID, preview: false, range: null }, actor), error => error.status === 503);
  }
})

test('per-read idle timeout rejects and cancels an asset stream', async () => {
  let cancelled = false;
  const client = createPortalPagesClient({ baseURL: 'https://cms.invalid', secret, idleTimeoutMs: 10,
    fetchImpl: async () => new Response(new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } }), {
      status: 200, headers: { 'content-length': '8', 'content-type': 'application/pdf', 'accept-ranges': 'bytes',
        'content-disposition': `inline; filename="${assetID}.pdf"`, 'cache-control': 'private,no-store', 'x-content-type-options': 'nosniff' },
    }),
  });
  const result = await client.asset({ pageId: pageID, revisionId: versionID, assetId: assetID, preview: false, range: null }, actor);
  const reader = result.body.getReader();
  await assert.rejects(reader.read());
  assert.equal(cancelled, true);
})

test('asset CMS JSON errors map only exact bounded forbidden/not_found bodies and never expose backend details', async () => {
  const valid = [
    { status: 403, error: 'forbidden', mapped: 403 },
    { status: 404, error: 'not_found', mapped: 404 },
  ];
  for (const entry of valid) {
    const client = createPortalPagesClient({ baseURL: 'https://cms.invalid', secret,
      fetchImpl: async () => Response.json({ error: entry.error }, { status: entry.status }),
    });
    await assert.rejects(client.asset({ pageId: pageID, revisionId: versionID, assetId: assetID, preview: false, range: null }, actor),
      error => error.status === entry.mapped && !/CMS|detail|private/i.test(error.message));
  }

  const invalid = [
    { status: 403, body: Response.json({ error: 'not_found' }, { status: 403 }) },
    { status: 404, body: Response.json({ error: 'not_found', detail: 'private CMS detail' }, { status: 404 }) },
    { status: 403, body: new Response('{"error":"forbidden"}', { status: 403, headers: { 'content-type': 'text/plain' } }) },
    { status: 404, body: new Response('{', { status: 404, headers: { 'content-type': 'application/json' } }) },
    { status: 403, body: new Response('{"error":"forbidden"}', { status: 403, headers: {
      'content-type': 'application/json', 'content-length': '1025',
    } }) },
    { status: 500, body: Response.json({ error: 'forbidden' }, { status: 500 }) },
  ];
  for (const entry of invalid) {
    const client = createPortalPagesClient({ baseURL: 'https://cms.invalid', secret, fetchImpl: async () => entry.body });
    await assert.rejects(client.asset({ pageId: pageID, revisionId: versionID, assetId: assetID, preview: false, range: null }, actor),
      error => error.status === 503 && !/private CMS detail|forbidden|not_found/i.test(error.message));
  }

  let oversizedBodyCancelled = 0;
  const oversizedBody = new Response(new ReadableStream({ cancel() { oversizedBodyCancelled++; } }, { highWaterMark: 0 }), {
    status: 403, headers: { 'content-type': 'application/json', 'content-length': '1025' },
  });
  const oversizedClient = createPortalPagesClient({ baseURL: 'https://cms.invalid', secret,
    fetchImpl: async () => oversizedBody,
  });
  await assert.rejects(oversizedClient.asset({ pageId: pageID, revisionId: versionID, assetId: assetID, preview: false, range: null }, actor),
    error => error.status === 503);
  assert.equal(oversizedBodyCancelled, 1, 'oversized CMS error bodies are cancelled before returning the safe 503');
});

test('availability DTO is exact, distinct from list pagination, and carries the caller deadline into CMS', async () => {
  const seen = [];
  const client = createPortalPagesClient({ baseURL: 'https://cms.invalid', secret,
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return jsonResponse({ available: true });
    },
  });
  const deadlineAt = Date.now() + 4000;
  assert.deepEqual(await client.availability({}, actor, { signal: new AbortController().signal,
    requestId: 'availability-01', deadlineAt }), { available: true });
  assert.equal(seen[0].url, 'https://cms.invalid/editorial/api/portal-pages/availability');
  assert.deepEqual(JSON.parse(seen[0].init.body), { actor, input: {} });
  assert.equal(seen[0].init.headers['X-Request-Deadline'], String(deadlineAt));
  assert.equal(seen[0].init.signal.aborted, false);
  assert.equal(validInput('availability', {}), true);
  assert.equal(validInput('availability', { limit: 1 }), false);

  for (const value of [{ available: 1 }, { available: true, count: 1 }, [], null]) {
    const invalid = createPortalPagesClient({ baseURL: 'https://cms.invalid', secret,
      fetchImpl: async () => jsonResponse(value),
    });
    await assert.rejects(invalid.availability({}, actor), error => error.status === 503);
  }
});

test('caller deadline bounds the CMS header wait and aborts the service request', async () => {
  let signal;
  const client = createPortalPagesClient({ baseURL: 'https://cms.invalid', secret, headerTimeoutMs: 5000,
    fetchImpl: (_url, init) => {
      signal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    },
  });
  await assert.rejects(client.availability({}, actor, { deadlineAt: Date.now() + 20 }), error => error.status === 503);
  assert.equal(signal.aborted, true);
});

test('caller deadline aborts a stalled JSON response body instead of waiting for the idle timeout', async () => {
  let cancelled = false;
  const client = createPortalPagesClient({ baseURL: 'https://cms.invalid', secret, idleTimeoutMs: 5000,
    fetchImpl: async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(Buffer.from('{"available":')); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } }),
  });
  const startedAt = Date.now();
  await assert.rejects(client.availability({}, actor, { deadlineAt: startedAt + 30 }), error => error.status === 503);
  assert.ok(Date.now() - startedAt < 1000, 'the read budget interrupts a stalled body well before idle timeout');
  assert.equal(cancelled, true);
});

test('asset stream reaches exact EOF once, releases request listeners, and clears its idle timeout without aborting', async () => {
  const source = new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('PDF!')); controller.close(); },
  }, { highWaterMark: 0 });
  const state = makeAssetClient({ body: source, length: 4, idleTimeoutMs: 20 });
  const result = await state.asset();
  const reader = result.body.getReader();
  assert.deepEqual(Buffer.from((await reader.read()).value), Buffer.from('PDF!'));
  assert.equal((await reader.read()).done, true);
  assert.equal(state.signal.listeners.size, 0);
  assert.equal(state.fetchSignal.aborted, false, 'normal EOF does not abort a completed fetch');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(state.fetchSignal.aborted, false, 'the completed stream leaves no idle timer behind');
});

test('asset stream overrun, underrun, and reader rejection error downstream and clean resources once', async () => {
  const cases = [
    {
      name: 'overrun', length: 4,
      body: new ReadableStream({ pull(controller) { controller.enqueue(Buffer.from('12345')); } }, { highWaterMark: 0 }),
      reads: 1,
    },
    {
      name: 'underrun', length: 4,
      body: new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('123')); controller.close(); } }, { highWaterMark: 0 }),
      reads: 2,
    },
    {
      name: 'reader rejection', length: 4,
      body: new ReadableStream({ pull() { throw new Error('private reader failure'); } }, { highWaterMark: 0 }),
      reads: 1,
    },
  ];
  for (const entry of cases) {
    const state = makeAssetClient({ body: entry.body, length: entry.length });
    const result = await state.asset();
    const reader = result.body.getReader();
    if (entry.name === 'underrun') assert.equal((await reader.read()).value.byteLength, 3);
    for (let index = 0; index < entry.reads - (entry.name === 'underrun' ? 1 : 0); index++) {
      await assert.rejects(reader.read());
    }
    assert.equal(state.fetchSignal.aborted, true, `${entry.name} aborts the upstream fetch`);
    assert.equal(state.signal.listeners.size, 0, `${entry.name} removes request listeners`);
    await reader.cancel().catch(() => {});
    assert.equal(state.signal.listeners.size, 0, `${entry.name} cleanup is idempotent`);
  }
});

test('asset idle timeout, bad success headers, consumer cancel, and request abort cancel upstream and release listeners', async () => {
  const idleSource = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { idleCancelled++; } }, { highWaterMark: 0 });
  let idleCancelled = 0;
  const idle = makeAssetClient({ body: idleSource, length: 4, idleTimeoutMs: 10 });
  const idleResult = await idle.asset();
  await assert.rejects(idleResult.body.getReader().read());
  assert.equal(idleCancelled, 1);
  assert.equal(idle.fetchSignal.aborted, true);
  assert.equal(idle.signal.listeners.size, 0);

  let headerCancelled = 0;
  const badHeaders = makeAssetClient({
    body: new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { headerCancelled++; } }, { highWaterMark: 0 }),
    headers: { 'content-type': 'video/quicktime' },
  });
  await assert.rejects(badHeaders.asset(), error => error.status === 503);
  assert.equal(headerCancelled, 1, 'header validation failure cancels the created response body');
  assert.equal(badHeaders.fetchSignal.aborted, true);
  assert.equal(badHeaders.signal.listeners.size, 0);

  let consumerCancelled = 0;
  const consumer = makeAssetClient({
    body: new ReadableStream({ pull(controller) { controller.enqueue(Buffer.from('PDF!')); }, cancel() { consumerCancelled++; } }, { highWaterMark: 0 }),
  });
  const consumerResult = await consumer.asset();
  const consumerReader = consumerResult.body.getReader();
  await consumerReader.read();
  await consumerReader.cancel();
  assert.equal(consumerCancelled, 1);
  assert.equal(consumer.fetchSignal.aborted, true);
  assert.equal(consumer.signal.listeners.size, 0);

  let requestCancelled = 0;
  const requestAbort = trackAbortSignal();
  const aborted = makeAssetClient({
    body: new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { requestCancelled++; } }, { highWaterMark: 0 }),
    signal: requestAbort,
  });
  const abortedResult = await aborted.asset();
  const abortedReader = abortedResult.body.getReader();
  const pendingRead = abortedReader.read();
  requestAbort.abort();
  await assert.rejects(pendingRead);
  assert.equal(requestCancelled, 1);
  assert.equal(aborted.fetchSignal.aborted, true);
  assert.equal(requestAbort.listeners.size, 0);
});
