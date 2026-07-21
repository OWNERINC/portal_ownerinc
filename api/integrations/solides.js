const { setTimeout: delay } = require('node:timers/promises');
const { readSolidesConfig } = require('./solides-config');

const MAX_JSON_BYTES = 5 * 1024 * 1024;

async function readLimitedText(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) throw new SolidesError('Sólides response is too large');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new SolidesError('Sólides response is too large');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

class SolidesError extends Error {
  constructor(message, upstreamStatus) {
    super(message);
    this.name = 'SolidesError';
    this.upstreamStatus = upstreamStatus;
  }
}

function serviceBaseUrl(service, config) {
  if (service === 'employer') return config.employerBaseUrl;
  if (service === 'punch') return config.punchBaseUrl;
  if (service === 'report' && config.reportBaseUrl) return config.reportBaseUrl;
  throw new SolidesError('Sólides service is not configured');
}

function buildUrl(baseUrl, path, query) {
  const base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const url = new URL(path.replace(/^\//, ''), base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) throw new SolidesError('Invalid Sólides endpoint');
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

function retryable(status) {
  return status === 429 || status >= 500;
}

function responseShape(text) {
  try {
    const body = JSON.parse(text);
    if (Array.isArray(body)) return { kind: 'array', count: body.length };
    if (body && typeof body === 'object') return {
      kind: Array.isArray(body.content) ? 'page' : 'object',
      count: Array.isArray(body.content) ? body.content.length : undefined,
      hasTotal: Number.isFinite(body.totalElements),
    };
    return { kind: typeof body };
  } catch { return { kind: 'non-json' }; }
}

async function solidesCheck(service, path, { query, config = readSolidesConfig(), fetchImpl = fetch } = {}) {
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(buildUrl(serviceBaseUrl(service, config), path, query), {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Basic ${config.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const text = await readLimitedText(response);
    return { ok: response.ok, status: response.status, durationMs: Date.now() - startedAt, shape: responseShape(text) };
  } catch (error) {
    return {
      ok: false,
      status: error instanceof SolidesError ? error.upstreamStatus || null : null,
      durationMs: Date.now() - startedAt,
      error: error?.name === 'TimeoutError' ? 'timeout' : 'network',
    };
  }
}

async function solidesJson(service, path, { query, attempts = 3, config = readSolidesConfig(), fetchImpl = fetch } = {}) {
  const url = buildUrl(serviceBaseUrl(service, config), path, query);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Basic ${config.token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) {
        if (attempt < attempts && retryable(response.status)) {
          const retryAfter = Number(response.headers.get('retry-after'));
          await delay(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 10000) : 250 * (2 ** (attempt - 1)));
          continue;
        }
        throw new SolidesError('Sólides request failed', response.status);
      }
      const text = await readLimitedText(response);
      try { return JSON.parse(text); } catch { throw new SolidesError('Sólides returned invalid JSON'); }
    } catch (error) {
      if (error instanceof SolidesError) throw error;
      if (attempt === attempts) throw new SolidesError('Sólides is unavailable');
      await delay(250 * (2 ** (attempt - 1)));
    }
  }
  throw new SolidesError('Sólides is unavailable');
}

module.exports = { SolidesError, buildUrl, readLimitedText, responseShape, solidesCheck, solidesJson };
