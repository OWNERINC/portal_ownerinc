const { randomUUID } = require('node:crypto');
const { validateSolidesEnvironment } = require('../integrations/solides-config');

function validateEnvironment(env) {
  if (env.FIREBASE_AUTH_EMULATOR_HOST && env.NODE_ENV !== 'development') {
    throw new Error('FIREBASE_AUTH_EMULATOR_HOST is only allowed when NODE_ENV=development');
  }
  const emulator = env.NODE_ENV === 'development' && env.FIREBASE_AUTH_EMULATOR_HOST;
  const required = ['DATABASE_URL', 'FIREBASE_PROJECT_ID', 'BULK_IMPORT_WORKER_SECRET', ...(emulator ? [] : ['FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'])];
  const missing = required.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if (String(env.BULK_IMPORT_WORKER_SECRET).length < 32) throw new Error('BULK_IMPORT_WORKER_SECRET must contain at least 32 characters');
  if (env.PORT && (!/^\d+$/.test(env.PORT) || Number(env.PORT) > 65535)) throw new Error('Invalid environment variable: PORT');
  for (const origin of allowedOrigins(env)) new URL(origin);
  validateSolidesEnvironment(env);
}

function allowedOrigins(env) {
  return (env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean).map(normalizeOrigin);
}

function normalizeOrigin(origin) {
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`Invalid CORS origin: ${origin}`);
  }
  return parsed.origin;
}

function configureTrustProxy(app) {
  app.set('trust proxy', 1);
}

function requestContext(req, res, next) {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

const SAFE_5XX_REASONS = new Set(['firebase_identity_indeterminate']);

function safeResponses(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 500) {
      console.error(JSON.stringify({ service: 'api', event: 'handled_error', requestId: req.id, error: body?.error || 'unknown' }));
      const reason = SAFE_5XX_REASONS.has(body?.reason) ? { reason: body.reason } : {};
      return json({ error: 'Internal server error.', ...reason, requestId: req.id });
    }
    if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
      return json({ ...body, requestId: req.id });
    }
    return json(body);
  };
  next();
}

function firstForwarded(value) {
  return String(value || '').split(',')[0].trim();
}

function requestOrigin(req) {
  const protocol = firstForwarded(req.get('x-forwarded-proto')) || req.protocol;
  const host = firstForwarded(req.get('x-forwarded-host')) || req.get('host');
  const port = firstForwarded(req.get('x-forwarded-port'));
  if (!protocol || !host) return null;
  try {
    const url = new URL(`${protocol}://${host}`);
    if (port && !url.port && /^\d{1,5}$/.test(port)) url.port = port;
    return url.origin;
  } catch {
    return null;
  }
}

function cors(allowlist) {
  const allowed = new Set(allowlist);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (!origin) return next();

    let normalizedOrigin;
    try {
      normalizedOrigin = normalizeOrigin(origin);
    } catch {
      return res.status(403).json({ error: 'Request not allowed.', requestId: req.id });
    }
    if (normalizedOrigin !== requestOrigin(req) && !allowed.has(normalizedOrigin)) {
      return res.status(403).json({ error: 'Request not allowed.', requestId: req.id });
    }

    res.setHeader('Access-Control-Allow-Origin', normalizedOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Expose-Headers', 'X-Total-Count');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const buckets = new Map();
  let requests = 0;
  return (req, res, next) => {
    const now = Date.now();
    requests += 1;
    if (requests % 1000 === 0) {
      for (const [id, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(id);
    }
    const id = key(req);
    const current = buckets.get(id);
    const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
    bucket.count += 1;
    buckets.set(id, bucket);
    if (bucket.count > max) return res.status(429).json({ error: 'Too many requests.', requestId: req.id });
    next();
  };
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const invalidJson = err.type === 'entity.parse.failed';
  const status = invalidJson ? 400 : err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
  console.error(JSON.stringify({ service: 'api', event: 'request_error', requestId: req.id, status, error: err.message }));
  res.status(status).json({
    error: invalidJson ? 'Invalid JSON.' : status === 413 ? 'Payload too large.' : 'Internal server error.',
    requestId: req.id,
  });
}

module.exports = {
  allowedOrigins, configureTrustProxy, cors, errorHandler, normalizeOrigin, rateLimit, requestContext, requestOrigin, safeResponses,
  validateEnvironment,
};
