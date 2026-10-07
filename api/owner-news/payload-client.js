const { randomUUID } = require('node:crypto');
const { validInput, validActor, readResult, unavailable } = require('./payload-dto');
const MiB = 1024 * 1024;
const paths = Object.freeze(Object.fromEntries(['list', 'detail', 'categories', 'navigation', 'home', 'preview', 'asset'].map(action => [action, `/editorial/api/portal-news/${action}`])));
const safeError = status => Object.assign(new Error(status === 503 ? 'news_unavailable' : status === 404 ? 'not_found' : 'forbidden'), { status, code: status === 503 ? 'news_unavailable' : status === 404 ? 'not_found' : 'forbidden' });
function createPayloadNewsClient({ baseURL, secret, fetchImpl = globalThis.fetch, timeoutMs = 5000 }) {
  let origin;
  try {
    const url = new URL(baseURL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || typeof secret !== 'string' || secret.length < 32 || /[\r\n]/u.test(secret) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw unavailable();
    origin = url.origin;
  } catch { throw unavailable(); }
  async function request(action, input, actor, { signal, requestId } = {}) {
    if (!validInput(action, input) || !validActor(actor)) throw unavailable();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    const clean = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    let response;
    try {
      response = await fetchImpl(`${origin}${paths[action]}`, { method: 'POST', cache: 'no-store', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', 'X-Request-ID': typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId) ? requestId : randomUUID() },
        body: JSON.stringify({ actor, input }) });
      if (controller.signal.aborted) throw unavailable();
      if (!response.ok && !(action === 'asset' && response.status === 416)) {
        await response.body?.cancel().catch(() => {});
        throw safeError([403, 404].includes(response.status) ? response.status : 503);
      }
      return { response, controller, clean };
    } catch (error) { controller.abort(); clean(); await response?.body?.cancel().catch(() => {}); throw [403, 404].includes(error.status) ? error : unavailable(); }
  }
  async function query(action, input, actor, options) {
    if (!Object.hasOwn(paths, action) || action === 'asset') throw unavailable();
    const { response, controller, clean } = await request(action, input, actor, options);
    let reader;
    const abortRead = () => { if (reader) void reader.cancel().catch(() => {}); };
    try {
      const max = action === 'list' ? (input.limit * 6 + 1) * MiB : ['detail', 'preview'].includes(action) ? 6 * MiB : action === 'categories' ? MiB : 64 * 1024;
      const size = response.headers.get('content-length');
      if (size !== null && (!/^\d+$/u.test(size) || Number(size) > max)) throw unavailable();
      if (!/^application\/json(?:;|$)/iu.test(response.headers.get('content-type') || '') || !response.body) throw unavailable();
      reader = response.body.getReader(); controller.signal.addEventListener('abort', abortRead, { once: true });
      if (controller.signal.aborted) throw unavailable();
      const chunks = []; let bytes = 0;
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength; if (bytes > max || controller.signal.aborted) throw unavailable(); chunks.push(Buffer.from(value));
      }
      if (controller.signal.aborted) throw unavailable();
      return readResult(action, JSON.parse(Buffer.concat(chunks).toString('utf8')), input);
    } catch { controller.abort(); if (reader) await reader.cancel().catch(() => {}); else await response.body?.cancel().catch(() => {}); throw unavailable(); }
    finally { controller.signal.removeEventListener('abort', abortRead); reader?.releaseLock(); clean(); }
  }
  async function asset(input, actor, options) {
    const { response, controller, clean } = await request('asset', input, actor, options);
    let reader, output;
    const abortRead = () => { if (reader) void reader.cancel().catch(() => {}); if (output) { output.error(unavailable()); output = null; } clean(); };
    const cancel = async () => { controller.signal.removeEventListener('abort', abortRead); output = null; controller.abort(); if (reader) await reader.cancel().catch(() => {}); else await response.body?.cancel().catch(() => {}); clean(); };
    try {
      const headers = { 'Cache-Control': 'private,no-store', 'X-Content-Type-Options': 'nosniff' };
      const length = response.headers.get('content-length');
      if (!length || !/^\d+$/u.test(length) || Number(length) > 50 * MiB) throw unavailable();
      headers['Content-Length'] = length;
      if (response.status === 416) {
        const range = response.headers.get('content-range');
        if (length !== '0' || !/^bytes \*\/\d+$/u.test(range || '') || Number(range.split('/')[1]) > 50 * MiB) throw unavailable();
        headers['Content-Range'] = range; await cancel(); return { status: 416, headers, body: null };
      }
      const mime = response.headers.get('content-type'), disposition = response.headers.get('content-disposition');
      if (![200, 206].includes(response.status) || Number(length) < 1 || !['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'video/mp4', 'video/webm', 'video/quicktime'].includes(mime) || !/^inline; filename="[a-zA-Z0-9._-]+"$/u.test(disposition || '') || !response.body) throw unavailable();
      headers['Content-Type'] = mime; headers['Content-Disposition'] = disposition;
      if (response.headers.get('accept-ranges') === 'bytes') headers['Accept-Ranges'] = 'bytes';
      if (response.status === 206) {
        const range = response.headers.get('content-range'), match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(range || '');
        if (!match || Number(match[3]) > 50 * MiB || Number(match[2]) >= Number(match[3]) || Number(match[2]) - Number(match[1]) + 1 !== Number(length)) throw unavailable();
        headers['Content-Range'] = range;
      }
      reader = response.body.getReader(); let bytes = 0;
      const body = new ReadableStream({ start(c) { output = c; controller.signal.addEventListener('abort', abortRead, { once: true }); if (controller.signal.aborted) abortRead(); }, async pull(c) {
        try {
          const { done, value } = await reader.read();
          if (controller.signal.aborted) throw unavailable();
          if (done) { if (bytes !== Number(length)) throw unavailable(); c.close(); output = null; controller.signal.removeEventListener('abort', abortRead); clean(); return; }
          bytes += value.byteLength; if (bytes > Number(length) || bytes > 50 * MiB) throw unavailable(); c.enqueue(value);
        } catch { if (output) c.error(unavailable()); await cancel(); }
      }, cancel }, { highWaterMark: 0 });
      return { status: response.status, headers, body };
    } catch { await cancel(); throw unavailable(); }
  }
  return { query, asset };
}
module.exports = { createPayloadNewsClient };
