'use strict';

const { randomUUID } = require('node:crypto');
const { MIME_EXTENSIONS, readPortalPageResult, unavailable } = require('./payload-dto');

const MiB = 1024 * 1024;
const MAX_ASSET_BYTES = 500 * MiB;
const actions = Object.freeze(['list', 'categories', 'detail', 'preview', 'asset']);
const requestIDPattern = /^[A-Za-z0-9._:-]{1,128}$/u;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function safeError(status = 503) {
  const code = status === 404 ? 'not_found' : status === 403 ? 'forbidden' : status === 400 ? 'invalid_request' : 'portal_pages_unavailable';
  return Object.assign(new Error(code), { status, code });
}
function validActor(actor) {
  return actor !== null && typeof actor === 'object' && !Array.isArray(actor) && Object.keys(actor).length === 4
    && typeof actor.uid === 'string' && actor.uid.length > 0 && actor.uid.length <= 128
    && typeof actor.email === 'string' && actor.email.length > 0 && actor.email.length <= 320
    && (actor.name === null || typeof actor.name === 'string') && typeof actor.canManageKnowledge === 'boolean';
}
function validInput(action, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const exact = (required, optional = []) => Object.keys(input).every(key => required.includes(key) || optional.includes(key))
    && required.every(key => Object.hasOwn(input, key));
  const id = value => typeof value === 'string' && new RegExp(`^${UUID}$`, 'iu').test(value);
  if (action === 'list') return exact(['limit', 'offset'], ['category']) && Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 50
    && Number.isSafeInteger(input.offset) && input.offset >= 0 && input.offset <= 1_000_000
    && (!Object.hasOwn(input, 'category') || (typeof input.category === 'string' && input.category.length <= 160 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.category)));
  if (action === 'categories') return exact([]);
  if (action === 'detail') return exact(['slug']) && typeof input.slug === 'string' && input.slug.length <= 160 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(input.slug);
  if (action === 'preview') return exact(['pageId', 'versionId']) && id(input.pageId) && id(input.versionId);
  if (action === 'asset') return exact(['pageId', 'revisionId', 'assetId', 'preview', 'range']) && id(input.pageId) && id(input.revisionId) && id(input.assetId)
    && typeof input.preview === 'boolean' && (input.range === null || (typeof input.range === 'string' && input.range.length <= 200));
  return false;
}

function parseRange(value, size) {
  if (value === null) return { start: 0, end: size - 1, partial: false };
  if (typeof value !== 'string' || value.length > 200) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last)) || (first === null && last === 0)) return null;
  const start = first ?? Math.max(0, size - last);
  const end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
  if (start < 0 || start >= size || end < start) return null;
  return { start, end, partial: true };
}

function readWithIdleTimeout(reader, controller, idleTimeoutMs, timers = null) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timers?.delete(timer);
      controller.abort();
      reject(unavailable());
    }, idleTimeoutMs);
    timers?.add(timer);
  });
  return Promise.race([reader.read(), timeout]).finally(() => {
    clearTimeout(timer);
    timers?.delete(timer);
  });
}

async function readJSONResponse(response, controller, maxBytes, idleTimeoutMs) {
  const contentType = response.headers.get('content-type') || '';
  const declared = response.headers.get('content-length');
  if (!/^application\/json(?:\s*;|$)/iu.test(contentType) || !response.body ||
    (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes))) throw unavailable();
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await readWithIdleTimeout(reader, controller, idleTimeoutMs);
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes || controller.signal.aborted) throw unavailable();
      chunks.push(Buffer.from(part.value));
    }
    if ((declared !== null && Number(declared) !== bytes) || controller.signal.aborted) throw unavailable();
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch { controller.abort(); await reader.cancel().catch(() => {}); throw unavailable(); }
  finally { reader.releaseLock(); }
}

function createPortalPagesClient({ baseURL, secret, fetchImpl = globalThis.fetch, headerTimeoutMs = 5000,
  idleTimeoutMs = 30_000 } = {}) {
  let origin;
  try {
    const url = new URL(baseURL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      typeof secret !== 'string' || secret.length < 32 || /[\r\n]/u.test(secret) || typeof fetchImpl !== 'function' ||
      !Number.isSafeInteger(headerTimeoutMs) || headerTimeoutMs < 1 || !Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1) throw unavailable();
    origin = url.origin;
  } catch { throw unavailable(); }

  async function request(action, input, actor, { signal, requestId } = {}) {
    if (!actions.includes(action) || !validInput(action, input) || !validActor(actor)) throw unavailable();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const correlation = typeof requestId === 'string' && requestIDPattern.test(requestId) ? requestId : randomUUID();
    const body = JSON.stringify({ actor, input });
    if (Buffer.byteLength(body, 'utf8') > 16 * 1024) { signal?.removeEventListener('abort', abort); throw unavailable(); }
    let timer;
    let response;
    let fetchPromise;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, headerTimeoutMs);
    });
    let externalAbortListener;
    const externalAbort = signal ? new Promise((_, reject) => {
      externalAbortListener = () => reject(unavailable());
      if (signal.aborted) externalAbortListener();
      else signal.addEventListener('abort', externalAbortListener, { once: true });
    }) : new Promise(() => {});
    try {
      fetchPromise = Promise.resolve().then(() => fetchImpl(`${origin}/editorial/api/portal-pages/${action}`, {
        method: 'POST', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'X-Request-ID': correlation,
          Accept: action === 'asset' ? 'application/octet-stream' : 'application/json', 'Accept-Encoding': 'identity' },
        body,
      }));
      response = await Promise.race([fetchPromise, timeout, externalAbort]);
      clearTimeout(timer);
      if (controller.signal.aborted) throw unavailable();
      return { response, controller, cleanup: () => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (externalAbortListener) signal?.removeEventListener('abort', externalAbortListener);
      } };
    } catch (error) {
      clearTimeout(timer);
      controller.abort();
      signal?.removeEventListener('abort', abort);
      if (externalAbortListener) signal?.removeEventListener('abort', externalAbortListener);
      fetchPromise?.then(late => late.body?.cancel().catch(() => {})).catch(() => {});
      await response?.body?.cancel().catch(() => {});
      if (signal?.aborted) throw unavailable();
      throw error?.status ? error : unavailable();
    }
  }

  async function query(action, input, actor, options) {
    if (action === 'asset' || !actions.includes(action)) throw unavailable();
    const { response, controller, cleanup } = await request(action, input, actor, options);
    try {
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw safeError([400, 403, 404].includes(response.status) ? response.status : 503);
      }
      const maxBytes = action === 'list' || action === 'categories' ? 16 * MiB : 6 * MiB;
      const result = await readJSONResponse(response, controller, maxBytes, idleTimeoutMs);
      if (controller.signal.aborted) throw unavailable();
      return readPortalPageResult(action, result, input);
    } catch (error) {
      controller.abort();
      await response.body?.cancel().catch(() => {});
      throw error?.status ? error : unavailable();
    } finally { cleanup(); }
  }

  async function asset(input, actor, options = {}) {
    const { response, controller, cleanup } = await request('asset', input, actor, options);
    let reader;
    let bytes = 0;
    let outputController;
    let outputState = 'open';
    let cleanupPromise;
    const idleTimers = new Set();
    const cleanupResources = ({ cancelUpstream = true, abortFetch = true } = {}) => {
      if (cleanupPromise) return cleanupPromise;
      cleanupPromise = (async () => {
        for (const timer of idleTimers) clearTimeout(timer);
        idleTimers.clear();
        controller.signal.removeEventListener('abort', abort);
        cleanup();
        if (abortFetch && !controller.signal.aborted) controller.abort();
        try {
          if (cancelUpstream) {
            if (reader) await reader.cancel().catch(() => {});
            else await response.body?.cancel().catch(() => {});
          }
        } finally {
          try { reader?.releaseLock(); } catch {}
        }
      })();
      return cleanupPromise;
    };
    const setOutputState = (state, error) => {
      if (outputState !== 'open') return false;
      outputState = state;
      const target = outputController;
      outputController = null;
      if (state === 'closed') target?.close();
      else if (state === 'errored') target?.error(error || unavailable());
      return true;
    };
    const abort = () => {
      setOutputState('errored', unavailable());
      void cleanupResources();
    };
    try {
      if (response.status === 403 || response.status === 404) {
        let body;
        try {
          const encoding = (response.headers.get('content-encoding') || 'identity').toLowerCase();
          if (encoding !== 'identity' || !response.body) throw unavailable();
          body = await readJSONResponse(response, controller, 1024, idleTimeoutMs);
        } catch {
          await cleanupResources();
          throw safeError(503);
        }
        const expected = response.status === 403 ? 'forbidden' : 'not_found';
        const exact = body !== null && typeof body === 'object' && !Array.isArray(body)
          && Object.keys(body).length === 1 && body.error === expected;
        if (!exact) {
          await cleanupResources();
          throw safeError(503);
        }
        await cleanupResources({ cancelUpstream: true, abortFetch: true });
        throw safeError(response.status);
      }
      const length = response.headers.get('content-length');
      const cache = response.headers.get('cache-control') || '';
      if (!length || !/^\d+$/u.test(length) || Number(length) > MAX_ASSET_BYTES ||
        !/private/iu.test(cache) || !/no-store/iu.test(cache) || response.headers.get('x-content-type-options')?.toLowerCase() !== 'nosniff' ||
        ![200, 206, 416].includes(response.status) || (response.headers.get('content-encoding') || 'identity').toLowerCase() !== 'identity') throw unavailable();
      const declaredLength = Number(length);
      if (response.status === 416) {
        const contentRange = response.headers.get('content-range') || '';
        const match = /^bytes \*\/(\d+)$/u.exec(contentRange);
        if (declaredLength !== 0 || !match || Number(match[1]) < 1 || Number(match[1]) > MAX_ASSET_BYTES
          || input.range === null || parseRange(input.range, Number(match[1])) !== null) throw unavailable();
        await cleanupResources();
        return { status: 416, headers: { 'Cache-Control': 'private,no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Length': '0', 'Content-Range': contentRange }, body: null };
      }
      if (declaredLength < 1) throw unavailable();
      const mime = response.headers.get('content-type') || '';
      if (!Object.hasOwn(MIME_EXTENSIONS, mime) || !response.body) throw unavailable();
      const disposition = response.headers.get('content-disposition') || '';
      if (!new RegExp(`^inline; filename="${UUID}\\.${MIME_EXTENSIONS[mime]}"$`, 'iu').test(disposition)) throw unavailable();
      const supportsRange = mime === 'application/pdf' || mime === 'video/mp4' || mime === 'video/webm';
      const acceptRanges = response.headers.get('accept-ranges');
      if ((supportsRange && acceptRanges !== 'bytes') || (!supportsRange && acceptRanges !== null)) throw unavailable();
      let contentRange;
      if (response.status === 206) {
        contentRange = response.headers.get('content-range') || '';
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(contentRange);
        if (!supportsRange || input.range === null || !match) throw unavailable();
        const start = Number(match[1]), end = Number(match[2]), total = Number(match[3]);
        const expected = parseRange(input.range, total);
        if (!expected?.partial || start !== expected.start || end !== expected.end || total > MAX_ASSET_BYTES || end >= total
          || end - start + 1 !== declaredLength || end < start) throw unavailable();
      } else {
        if (response.headers.has('content-range') || (supportsRange && input.range !== null)
          || declaredLength > MAX_ASSET_BYTES) throw unavailable();
      }
      reader = response.body.getReader();
      const headers = { 'Cache-Control': 'private,no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Length': length, 'Content-Type': mime, 'Content-Disposition': disposition };
      if (acceptRanges === 'bytes') headers['Accept-Ranges'] = 'bytes';
      if (contentRange) headers['Content-Range'] = contentRange;
      const body = new ReadableStream({
        start(streamController) {
          outputController = streamController;
          controller.signal.addEventListener('abort', abort, { once: true });
          if (controller.signal.aborted) abort();
        },
        async pull(streamController) {
          if (outputState !== 'open') return;
          try {
            const part = await readWithIdleTimeout(reader, controller, idleTimeoutMs, idleTimers);
            if (outputState !== 'open' || controller.signal.aborted) return;
            if (part.done) {
              if (bytes !== declaredLength) throw unavailable();
              if (setOutputState('closed')) await cleanupResources({ cancelUpstream: false, abortFetch: false });
              return;
            }
            bytes += part.value.byteLength;
            if (bytes > declaredLength || bytes > MAX_ASSET_BYTES) throw unavailable();
            streamController.enqueue(part.value);
          } catch {
            setOutputState('errored', unavailable());
            await cleanupResources();
          }
        },
        async cancel() {
          setOutputState('cancelled');
          await cleanupResources();
        },
      }, { highWaterMark: 0 });
      return { status: response.status, headers, body };
    } catch (error) {
      await cleanupResources();
      throw error?.status ? error : unavailable();
    }
  }

  return {
    list: (input, actor, options) => query('list', input, actor, options),
    categories: (input, actor, options) => query('categories', input, actor, options),
    detail: (input, actor, options) => query('detail', input, actor, options),
    preview: (input, actor, options) => query('preview', input, actor, options),
    asset,
    query,
  };
}

function createPortalPagesClientFromEnv(env = process.env, options = {}) {
  return createPortalPagesClient({ baseURL: env.CMS_INTERNAL_URL, secret: env.PORTAL_TO_PAYLOAD_SECRET, ...options });
}

module.exports = { createPortalPagesClient, createPortalPagesClientFromEnv, parseRange, validActor, validInput };
