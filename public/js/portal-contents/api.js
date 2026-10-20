import { authenticatedFetch, getContentsIdentity } from '../auth.js';
import { parseContentLength } from '../content-length.js';
import { MAX_COLLECTION_BYTES, MAX_DETAIL_BYTES, MAX_OFFSET, MAX_TOTAL, PAGE_SIZE, isCanonicalSlug, validateCategories, validateDetail, validateList } from './dto.js';

const AUTH_ERROR_BODY_LIMIT = 16 * 1024;
const CONTENTS_ERROR_MESSAGES = Object.freeze({
  400: 'Não foi possível abrir este conteúdo com segurança.',
  401: 'Sua sessão não está mais válida. Entre novamente para continuar.',
  403: 'Você não tem permissão para visualizar este conteúdo.',
  404: 'Este conteúdo não está mais disponível.',
  409: 'O conteúdo mudou durante a leitura. Atualize e tente novamente.',
  413: 'Este conteúdo excede o limite permitido para leitura.',
  429: 'Muitas solicitações. Aguarde um instante e tente novamente.',
  503: 'Conteúdos temporariamente indisponíveis.',
});
const CONTENTS_ERROR_CODES = Object.freeze({
  400: 'invalid_contents',
  401: 'session',
  403: 'access_denied',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  429: 'rate_limited',
  503: 'unavailable',
});
const BODY_OWNERS = new WeakMap();

function abortError() { return new DOMException('A solicitação foi cancelada.', 'AbortError'); }

function isCurrent(page, context) {
  return page.active && !context?.signal?.aborted && (typeof context?.isCurrent !== 'function' || context.isCurrent());
}

function assertCurrent(page, context) {
  if (!isCurrent(page, context)) throw abortError();
  const identity = getContentsIdentity();
  if (identity?.validated !== true || typeof identity.uid !== 'string' || !identity.uid) throw abortError();
}

function supportedStatus(status) {
  return Number.isInteger(status) && Object.hasOwn(CONTENTS_ERROR_MESSAGES, status) ? status : 503;
}

export function contentsErrorMessage(error) {
  return CONTENTS_ERROR_MESSAGES[supportedStatus(error?.status)];
}

function failure(status) {
  const safeStatus = supportedStatus(status);
  return Object.assign(new Error(CONTENTS_ERROR_MESSAGES[safeStatus]), {
    status: safeStatus,
    code: CONTENTS_ERROR_CODES[safeStatus],
  });
}

function safeError(error) {
  if (error?.name === 'AbortError') return error;
  if (error?.code === 'invalid_contents') return failure(400);
  return failure(error?.status);
}

function bodyOwner(response) {
  const body = response?.body;
  if (!body || (typeof body !== 'object' && typeof body !== 'function')) return null;
  let state = BODY_OWNERS.get(body);
  if (!state) {
    state = { reader: null, cancelled: false, consumed: false };
    BODY_OWNERS.set(body, state);
  }
  return { body, state };
}

async function cancelOwnedBody(response) {
  const owned = bodyOwner(response);
  if (!owned || owned.state.cancelled || owned.state.consumed) return;
  owned.state.cancelled = true;
  try {
    if (owned.state.reader?.cancel) await owned.state.reader.cancel();
    else if (owned.body.cancel) await owned.body.cancel();
  } catch { /* Cancellation is best-effort; the response is already rejected. */ }
}

export async function readBoundedJSON(response, { signal, maxBytes } = {}) {
  const owned = bodyOwner(response);
  if (!owned) throw new Error('Resposta inválida.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || typeof owned.body.getReader !== 'function') {
    await cancelOwnedBody(response);
    throw new Error('Resposta inválida.');
  }
  let reader;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts = [];
  let size = 0;
  const abort = () => { void cancelOwnedBody(response); };
  try {
    reader = owned.body.getReader();
    owned.state.reader = reader;
    const declaredLength = parseContentLength(response?.headers?.get?.('Content-Length'), maxBytes);
    if (declaredLength.kind !== 'absent' && declaredLength.kind !== 'valid') {
      throw new Error('Resposta excede os limites declarados.');
    }
    if (signal?.aborted) throw abortError();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) throw abortError();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        owned.state.consumed = true;
        break;
      }
      if (signal?.aborted) throw abortError();
      if (!value || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) throw new Error('Resposta inválida.');
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Resposta excede o limite.');
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    if (signal?.aborted) throw abortError();
    return JSON.parse(parts.join(''));
  } catch (error) {
    if (!owned.state.consumed) await cancelOwnedBody(response);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    try { reader?.releaseLock(); } catch { /* Already released by a cancelled stream. */ }
  }
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
      await cancelOwnedBody(response);
      assertCurrent(page, context);
      throw failure(response?.status);
    }
    const value = await readBoundedJSON(response, { signal: context?.signal, maxBytes });
    assertCurrent(page, context);
    return value;
  } catch (error) {
    if (response) await cancelOwnedBody(response);
    if (!isCurrent(page, context) || error?.name === 'AbortError') throw abortError();
    throw safeError(error);
  }
}

function parseTotalCount(response) {
  const value = response?.headers?.get?.('X-Total-Count');
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(value)) throw failure(400);
  const total = Number(value);
  if (!Number.isSafeInteger(total) || total > MAX_TOTAL) throw failure(400);
  return total;
}

export function createContentsAPI(page) {
  return {
    async list({ category = null, offset = 0 } = {}, context) {
      let response;
      try {
        assertCurrent(page, context);
        if ((category !== null && !isCanonicalSlug(category)) || !Number.isSafeInteger(offset)
          || offset < 0 || offset > MAX_OFFSET) throw failure(400);
        const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
        if (category !== null) query.set('category', category);
        const url = `/api/contents/?${query.toString()}`;
        response = await authenticatedFetch(url, {
          method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: context?.signal,
          authErrorBodyLimit: AUTH_ERROR_BODY_LIMIT,
        });
        assertCurrent(page, context);
        if (!response?.ok) {
          await cancelOwnedBody(response);
          assertCurrent(page, context);
          throw failure(response?.status);
        }
        const total = parseTotalCount(response);
        const data = await readBoundedJSON(response, { signal: context?.signal, maxBytes: MAX_COLLECTION_BYTES });
        assertCurrent(page, context);
        const result = validateList(data, total, PAGE_SIZE);
        assertCurrent(page, context);
        return result;
      } catch (error) {
        if (response) await cancelOwnedBody(response);
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
        if (!isCanonicalSlug(slug)) throw failure(400);
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
