import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentsHarness } from '../helpers/portal-contents-harness.mjs';
import { clone, pageFixture } from '../helpers/portal-contents-fixtures.mjs';

const contextFor = (signal = new AbortController().signal, isCurrent = () => true) => ({ signal, isCurrent, onReload() {} });
const apiFrom = async options => {
  const harness = await createContentsHarness(options);
  return { harness, api: harness.modules.api.createContentsAPI(harness.page) };
};

test('bounded JSON cancels oversized chunks and rejects invalid UTF-8 and malformed JSON', async () => {
  const { harness, api } = await apiFrom();
  let cancelled = 0;
  const oversized = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(17)); },
    cancel() { cancelled += 1; },
  }, { highWaterMark: 0 }));
  await assert.rejects(harness.modules.api.readBoundedJSON(oversized, { signal: new AbortController().signal, maxBytes: 16 }));
  assert.equal(cancelled, 1);

  for (const bytes of [new Uint8Array([0xff, 0xfe]), new TextEncoder().encode('{')]) {
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }));
    await assert.rejects(harness.modules.api.readBoundedJSON(response, { maxBytes: 16 }));
  }
  await assert.rejects(harness.modules.api.readBoundedJSON(new Response(null), { maxBytes: 16 }));
  assert.ok(api);
});

test('bounded JSON honors abort during body read and rejects an already-aborted signal', async () => {
  const { harness } = await apiFrom();
  const already = new AbortController(); already.abort();
  await assert.rejects(harness.modules.api.readBoundedJSON(new Response('{}'), { signal: already.signal, maxBytes: 16 }), { name: 'AbortError' });
  const controller = new AbortController();
  let cancelled = 0;
  const response = new Response(new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { cancelled += 1; },
  }, { highWaterMark: 0 }));
  const pending = harness.modules.api.readBoundedJSON(response, { signal: controller.signal, maxBytes: 16 });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, 1);
});

test('bounded JSON rejects invalid or oversized declared lengths before reading and does not cancel completed bodies', async () => {
  const { harness } = await apiFrom();
  for (const contentLength of ['01', '-1', '+1', '1.5', '1, 1', '9007199254740992', '17']) {
    let pulls = 0;
    let cancelled = 0;
    const response = {
      headers: { get: name => name === 'Content-Length' ? contentLength : null },
      body: new ReadableStream({
        pull(controller) { pulls += 1; controller.enqueue(new TextEncoder().encode('{}')); controller.close(); },
        cancel() { cancelled += 1; },
      }, { highWaterMark: 0 }),
    };
    await assert.rejects(harness.modules.api.readBoundedJSON(response, { maxBytes: 16 }));
    assert.equal(pulls, 0, `Content-Length ${contentLength} must be rejected before reading`);
    assert.equal(cancelled, 1, `Content-Length ${contentLength} must cancel once`);
  }

  let cancelCalls = 0;
  let reads = 0;
  const malformedButConsumed = {
    headers: { get: () => null },
    body: { getReader: () => ({
      async read() {
        reads += 1;
        return reads === 1
          ? { value: new TextEncoder().encode('{'), done: false }
          : { value: undefined, done: true };
      },
      async cancel() { cancelCalls += 1; },
      releaseLock() {},
    }) },
  };
  await assert.rejects(harness.modules.api.readBoundedJSON(malformedButConsumed, { maxBytes: 16 }), error => error.name === 'SyntaxError');
  assert.equal(cancelCalls, 0, 'a fully consumed stream is not cancelled just because JSON parsing fails');

  const withoutLength = new Response('{"ok":true}');
  assert.equal((await harness.modules.api.readBoundedJSON(withoutLength, { maxBytes: 16 })).ok, true,
    'streamed responses may omit Content-Length');
});

test('contents API requests exact GET URLs with bounded auth options and returns only validated data/total', async () => {
  const { harness, api } = await apiFrom({ request: async (path, options) => {
    if (path.startsWith('/api/contents/?')) {
      return new Response(JSON.stringify([pageFixture({ content_blocks: [] })]), { headers: { 'X-Total-Count': '1' } });
    }
    if (path === '/api/contents/categories') return Response.json([{ id: '018f47a2-7b3c-7a11-8a2c-000000000001', slug: 'people', name: 'People', count: 1 }]);
    if (path === '/api/contents/published-policy') return Response.json(pageFixture());
    throw new Error('Unknown fixture path');
  } });
  const context = contextFor();
  const list = await api.list({ category: 'people', offset: 24 }, context);
  assert.equal(list.total, 1);
  assert.equal(list.data[0].slug, 'published-policy');
  assert.deepEqual(Object.keys(list).sort(), ['data', 'total']);
  const cats = await api.categories(context);
  assert.equal(cats[0].slug, 'people');
  const detail = await api.detail('published-policy', context);
  assert.equal(detail.slug, 'published-policy');
  assert.deepEqual(harness.requests.map(({ path }) => path), [
    '/api/contents/?limit=12&offset=24&category=people', '/api/contents/categories', '/api/contents/published-policy',
  ]);
  for (const entry of harness.requests) {
    assert.equal(entry.options.method, 'GET');
    assert.equal(entry.options.credentials, 'same-origin');
    assert.equal(entry.options.cache, 'no-store');
    assert.equal(entry.options.authErrorBodyLimit, 16384);
    assert.ok(entry.options.signal instanceof AbortSignal);
  }
  await assert.rejects(api.detail('Not-Slug', context), error => error.status === 400 && error.code === 'invalid_contents');
  assert.equal(harness.requests.length, 3, 'bad slugs never reach authenticatedFetch');
});

test('list count header is strict decimal text and response payload must be a raw array', async () => {
  for (const total of [null, '', '-1', '1.5', '1e2', ' 1 ', '+1', '01', '100001']) {
    const { api } = await apiFrom({ request: async () => ({
      ok: true, status: 200, headers: { get: () => total }, body: new Response('[]').body,
    }) });
    await assert.rejects(api.list({}, contextFor()), error => error.code === 'invalid_contents' && error.status === 400);
  }
  const envelope = await apiFrom({ request: async () => new Response(JSON.stringify({ rows: [], count: 0 }), {
    headers: { 'X-Total-Count': '0' },
  }) });
  await assert.rejects(envelope.api.list({}, contextFor()), error => error.code === 'invalid_contents');
});

test('invalid or missing X-Total-Count cancels a deferred response body before its first read', async () => {
  for (const total of [null, 'not-a-count']) {
    let pulls = 0;
    let cancelled = 0;
    const { api } = await apiFrom({ request: async () => ({
      ok: true,
      status: 200,
      headers: { get: name => name === 'X-Total-Count' ? total : null },
      body: new ReadableStream({
        pull() { pulls += 1; return new Promise(() => {}); },
        cancel() { cancelled += 1; },
      }, { highWaterMark: 0 }),
    }) });
    await assert.rejects(api.list({}, contextFor()), error => error.status === 400 && error.code === 'invalid_contents');
    assert.equal(pulls, 0, 'invalid count headers are checked before body reads');
    assert.equal(cancelled, 1, 'the unread response body is cancelled exactly once');
  }
});

test('stale list responses are cancelled before a body read when the run is superseded', async () => {
  let releaseResponse;
  let pulls = 0;
  let cancelled = 0;
  let current = true;
  const { api } = await apiFrom({ request: () => new Promise(resolve => { releaseResponse = resolve; }) });
  const pending = api.list({}, contextFor(new AbortController().signal, () => current));
  current = false;
  releaseResponse({
    ok: true,
    status: 200,
    headers: { get: name => name === 'X-Total-Count' ? '0' : null },
    body: new ReadableStream({
      pull() { pulls += 1; return new Promise(() => {}); },
      cancel() { cancelled += 1; },
    }, { highWaterMark: 0 }),
  });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(pulls, 0, 'stale responses are not read');
  assert.equal(cancelled, 1, 'the stale response body is cancelled once');
});

test('deferred response streams are cancelled exactly once when a current list run aborts mid-read', async () => {
  let releasePull;
  let pullStarted;
  const pullStartedPromise = new Promise(resolve => { pullStarted = resolve; });
  const gate = new Promise(resolve => { releasePull = resolve; });
  let cancelled = 0;
  const controller = new AbortController();
  const { api } = await apiFrom({ request: async () => new Response(new ReadableStream({
    async pull(stream) {
      pullStarted();
      await gate;
      try { stream.enqueue(new TextEncoder().encode('[]')); stream.close(); } catch { /* The stale reader already cancelled. */ }
    },
    cancel() { cancelled += 1; },
  }, { highWaterMark: 0 }), { headers: { 'X-Total-Count': '0' } }) });
  const pending = api.list({}, contextFor(controller.signal));
  await pullStartedPromise;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  releasePull();
  assert.equal(cancelled, 1);
});

test('list validates duplicate IDs, row limits, count consistency and aggregate bytes before returning', async () => {
  const base = pageFixture({ content_blocks: [] });
  for (const { rows, total } of [
    { rows: [base, clone(base)], total: 2 },
    { rows: [base], total: 0 },
    { rows: Array.from({ length: 13 }, (_, index) => ({ ...clone(base), id: `018f47a2-7b3c-7a11-8a2c-${String(index + 1).padStart(12, '0')}`, slug: `page-${index + 1}` })), total: 13 },
  ]) {
    const { api } = await apiFrom({ request: async () => new Response(JSON.stringify(rows), { headers: { 'X-Total-Count': String(total) } }) });
    await assert.rejects(api.list({}, contextFor()), error => error.code === 'invalid_contents');
  }
  const upper = { ...clone(base), id: base.id.toUpperCase(), slug: 'page-upper' };
  const { api } = await apiFrom({ request: async () => new Response(JSON.stringify([base, upper]), { headers: { 'X-Total-Count': '2' } }) });
  assert.equal((await api.list({}, contextFor())).data.length, 2, 'duplicate UUID check follows the API case-sensitive set rule');
});

test('categories are validated independently and oversized transport is cancelled before JSON parsing', async () => {
  let cancelled = 0;
  const { api } = await apiFrom({ request: async path => {
    if (path === '/api/contents/categories') return Response.json([{ id: '018f47a2-7b3c-7a11-8a2c-000000000001', slug: 'a', name: 'A', count: 1 }]);
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)); },
      cancel() { cancelled += 1; },
    }, { highWaterMark: 0 }), { headers: { 'content-length': '1', 'X-Total-Count': '1' } });
  } });
  assert.equal((await api.categories(contextFor())).length, 1);
  await assert.rejects(api.list({}, contextFor()), error => error.status === 503 && !/Response|limit|private/i.test(error.message));
  assert.equal(cancelled, 1, 'the actual chunk cap is enforced even when Content-Length lies');
});

test('list transport counts whitespace bytes at the exact collection boundary and rejects cap plus one', async () => {
  const encoded = JSON.stringify([pageFixture({ content_blocks: [] })]);
  const exactBody = `${encoded}${' '.repeat(16 * 1024 * 1024 - Buffer.byteLength(encoded))}`;
  const exact = await apiFrom({ request: async () => new Response(exactBody, { headers: { 'X-Total-Count': '1' } }) });
  assert.equal((await exact.api.list({}, contextFor())).data.length, 1);
  const tooLarge = await apiFrom({ request: async () => new Response(`${exactBody} `, { headers: { 'X-Total-Count': '1' } }) });
  await assert.rejects(tooLarge.api.list({}, contextFor()), error => error.status === 503);
});

test('detail validates exact route slug and accepts whitespace overhead only up to the 6 MiB transport cap', async () => {
  const dto = pageFixture({ content_blocks: [] });
  const detailBytes = JSON.stringify(dto);
  const exact = `${detailBytes}${' '.repeat(6 * 1024 * 1024 - Buffer.byteLength(detailBytes))}`;
  const { api } = await apiFrom({ request: async () => new Response(exact) });
  assert.equal((await api.detail(dto.slug, contextFor())).slug, dto.slug);

  const tooLarge = await apiFrom({ request: async () => new Response(`${detailBytes}${' '.repeat(6 * 1024 * 1024 - Buffer.byteLength(detailBytes) + 1)}`) });
  await assert.rejects(tooLarge.api.detail(dto.slug, contextFor()), error => error.status === 503);
  const wrongSlug = await apiFrom({ request: async () => Response.json(dto) });
  await assert.rejects(wrongSlug.api.detail('other-page', contextFor()), error => error.code === 'invalid_contents');
});

test('transport, parse and DTO failures map to fixed safe errors without backend text', async () => {
  const cases = [
    { response: new Response('backend password details', { status: 503 }), status: 503, message: 'Conteúdos temporariamente indisponíveis.' },
    { response: new Response('secret error', { status: 400 }), status: 400, message: 'Não foi possível abrir este conteúdo com segurança.' },
    { response: new Response('private', { status: 404 }), status: 404, message: 'Este conteúdo não está mais disponível.' },
  ];
  for (const entry of cases) {
    const { api } = await apiFrom({ request: async () => entry.response });
    await assert.rejects(api.detail('published-policy', contextFor()), error => {
      assert.equal(error.status, entry.status);
      assert.equal(error.message, entry.message);
      assert.doesNotMatch(error.message, /backend|password|secret|private/u);
      return true;
    });
  }
  const offline = await apiFrom({ request: async () => { throw new Error('private transport implementation'); } });
  await assert.rejects(offline.api.categories(contextFor()), error => error.status === 503 && !/private transport/u.test(error.message));
});

test('every supported API status keeps its exact sanitized code and distinct fixed Portuguese message', async () => {
  const expected = new Map([
    [400, ['Não foi possível abrir este conteúdo com segurança.', 'invalid_contents']],
    [401, ['Sua sessão não está mais válida. Entre novamente para continuar.', 'session']],
    [403, ['Você não tem permissão para visualizar este conteúdo.', 'access_denied']],
    [404, ['Este conteúdo não está mais disponível.', 'not_found']],
    [409, ['O conteúdo mudou durante a leitura. Atualize e tente novamente.', 'conflict']],
    [413, ['Este conteúdo excede o limite permitido para leitura.', 'too_large']],
    [429, ['Muitas solicitações. Aguarde um instante e tente novamente.', 'rate_limited']],
    [503, ['Conteúdos temporariamente indisponíveis.', 'unavailable']],
  ]);
  for (const [status, [message, code]] of expected) {
    const { api } = await apiFrom({ request: async () => new Response('private server detail', { status }) });
    await assert.rejects(api.detail('published-policy', contextFor()), error => {
      assert.equal(error.status, status);
      assert.equal(error.message, message);
      assert.equal(error.code, code);
      assert.deepEqual(Object.keys(error).sort(), ['code', 'status']);
      assert.equal(Object.hasOwn(error, 'reason'), false, 'server reason fields never cross the reader API boundary');
      assert.doesNotMatch(error.message, /private server detail/u);
      return true;
    });
  }
});

test('identity or view generation change after a delayed complete body prevents API result commit', async () => {
  const chunk = new Promise(resolve => { globalThis.releaseDelayedChunk = resolve; });
  let nowCurrent = true;
  const bodyBytes = new TextEncoder().encode(JSON.stringify([pageFixture({ content_blocks: [] })]));
  const { api } = await apiFrom({ request: async () => new Response(new ReadableStream({
    async pull(controller) {
      await chunk;
      controller.enqueue(bodyBytes);
      controller.close();
    },
  }, { highWaterMark: 0 }), { headers: { 'X-Total-Count': '1' } }) });
  const pending = api.list({}, contextFor(new AbortController().signal, () => nowCurrent));
  await new Promise(resolve => setImmediate(resolve));
  nowCurrent = false;
  globalThis.releaseDelayedChunk();
  delete globalThis.releaseDelayedChunk;
  await assert.rejects(pending, { name: 'AbortError' });
});
