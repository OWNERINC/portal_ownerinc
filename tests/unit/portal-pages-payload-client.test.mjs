import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPortalPagesClient } = require('../../api/portal-pages/payload-client');
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
