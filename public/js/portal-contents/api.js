import { authenticatedFetch, getContentsIdentity } from '../auth.js';
import { MAX_COLLECTION_BYTES, MAX_DETAIL_BYTES, MAX_OFFSET, MAX_TOTAL, PAGE_SIZE, isCanonicalSlug, validateCategories, validateDetail, validateList } from './dto.js';

const AUTH_ERROR_BODY_LIMIT = 16 * 1024;

function abortError() { return new DOMException('A solicitação foi cancelada.', 'AbortError'); }

function isCurrent(page, context) {
  return page.active && !context?.signal?.aborted && (typeof context?.isCurrent !== 'function' || context.isCurrent());
}

function assertCurrent(page, context) {
  if (!isCurrent(page, context)) throw abortError();
  const identity = getContentsIdentity();
  if (identity?.validated !== true || typeof identity.uid !== 'string' || !identity.uid) throw abortError();
}

function failure(status, reason) {
  let message = 'Conteúdos temporariamente indisponíveis.';
  let safeReason = 'unavailable';
  if (status === 400 || reason === 'invalid_contents') {
    message = 'Não foi possível abrir este conteúdo com segurança.';
    safeReason = 'invalid_contents';
    status = 400;
  } else if (status === 404) {
    message = 'Este conteúdo não está mais disponível.';
    safeReason = 'not_found';
  } else if (status === 401) {
    safeReason = 'session';
  } else if (status === 403) {
    safeReason = 'access_denied';
  } else status = 503;
  return Object.assign(new Error(message), { status, reason: safeReason,
    code: safeReason === 'invalid_contents' ? 'invalid_contents' : 'contents_unavailable' });
}

function safeError(error) {
  if (error?.name === 'AbortError') return error;
  if (error?.code === 'invalid_contents') return failure(400, 'invalid_contents');
  if (error?.status === 404) return failure(404, 'not_found');
  if (error?.status === 400) return failure(400, 'invalid_contents');
  if (error?.status === 401) return failure(401, 'session');
  if (error?.status === 403) return failure(403, 'access_denied');
  return failure(503, 'unavailable');
}

export async function readBoundedJSON(response, { signal, maxBytes } = {}) {
  const reader = response?.body?.getReader?.();
  if (!reader || !Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('Resposta inválida.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw abortError();
    for (;;) {
      const { value, done } = await reader.read();
      if (signal?.aborted) throw abortError();
      if (done) break;
      if (!value || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) throw new Error('Resposta inválida.');
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Resposta excede o limite.');
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    if (signal?.aborted) throw abortError();
    return JSON.parse(parts.join(''));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    try { reader.releaseLock(); } catch { /* Already released by a cancelled stream. */ }
  }
}

async function discardErrorBody(response, signal) {
  if (!response?.body) return;
  try { await readBoundedJSON(response, { signal, maxBytes: AUTH_ERROR_BODY_LIMIT }); }
  catch { await response.body.cancel().catch(() => {}); }
}

async function requestJSON(page, path, context, maxBytes) {
  assertCurrent(page, context);
  let response;
  try {
    response = await authenticatedFetch(path, {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: context?.signal,
      authErrorBodyLimit: AUTH_ERROR_BODY_LIMIT,
    });
    assertCurrent(page, context);
    if (!response?.ok) {
      await discardErrorBody(response, context?.signal);
      assertCurrent(page, context);
      throw failure(response?.status, response?.status === 404 ? 'not_found' : 'unavailable');
    }
    const value = await readBoundedJSON(response, { signal: context?.signal, maxBytes });
    assertCurrent(page, context);
    return value;
  } catch (error) {
    if (!isCurrent(page, context) || error?.name === 'AbortError') throw abortError();
    throw safeError(error);
  }
}

function parseTotalCount(response) {
  const value = response?.headers?.get?.('X-Total-Count');
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) throw failure(400, 'invalid_contents');
  const total = Number(value);
  if (!Number.isSafeInteger(total) || total > MAX_TOTAL) throw failure(400, 'invalid_contents');
  return total;
}

export function createContentsAPI(page) {
  return {
    async list({ category = null, offset = 0 } = {}, context) {
      try {
        assertCurrent(page, context);
        if ((category !== null && !isCanonicalSlug(category)) || !Number.isSafeInteger(offset)
          || offset < 0 || offset > MAX_OFFSET) throw failure(400, 'invalid_contents');
        const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
        if (category !== null) query.set('category', category);
        const url = `/api/contents/?${query.toString()}`;
        const response = await authenticatedFetch(url, {
          method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: context?.signal,
          authErrorBodyLimit: AUTH_ERROR_BODY_LIMIT,
        });
        assertCurrent(page, context);
        if (!response?.ok) {
          await discardErrorBody(response, context?.signal);
          assertCurrent(page, context);
          throw failure(response?.status, response?.status === 404 ? 'not_found' : 'unavailable');
        }
        const total = parseTotalCount(response);
        const data = await readBoundedJSON(response, { signal: context?.signal, maxBytes: MAX_COLLECTION_BYTES });
        assertCurrent(page, context);
        const result = validateList(data, total, PAGE_SIZE);
        assertCurrent(page, context);
        return result;
      } catch (error) {
        if (!isCurrent(page, context) || error?.name === 'AbortError') throw abortError();
        throw safeError(error);
      }
    },

    async categories(context) {
      try {
        const data = await requestJSON(page, '/api/contents/categories', context, MAX_COLLECTION_BYTES);
        assertCurrent(page, context);
        const result = validateCategories(data);
        assertCurrent(page, context);
        return result;
      } catch (error) {
        if (!isCurrent(page, context) || error?.name === 'AbortError') throw abortError();
        throw safeError(error);
      }
    },

    async detail(slug, context) {
      try {
        assertCurrent(page, context);
        if (!isCanonicalSlug(slug)) throw failure(400, 'invalid_contents');
        const data = await requestJSON(page, `/api/contents/${slug}`, context, MAX_DETAIL_BYTES);
        assertCurrent(page, context);
        const result = validateDetail(data, slug);
        assertCurrent(page, context);
        return result;
      } catch (error) {
        if (!isCurrent(page, context) || error?.name === 'AbortError') throw abortError();
        throw safeError(error);
      }
    },
  };
}
