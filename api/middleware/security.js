const { randomUUID } = require('node:crypto');
const { validateSolidesEnvironment } = require('../integrations/solides-config');

function validateEnvironment(env) {
  const emulator = env.NODE_ENV === 'development' && env.FIREBASE_AUTH_EMULATOR_HOST;
  const required = ['DATABASE_URL', 'FIREBASE_PROJECT_ID', ...(emulator ? [] : ['FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'])];
  const missing = required.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if (env.PORT && (!/^\d+$/.test(env.PORT) || Number(env.PORT) > 65535)) throw new Error('Invalid environment variable: PORT');
  for (const origin of allowedOrigins(env)) new URL(origin);
  validateSolidesEnvironment(env);
}

function allowedOrigins(env) {
  return (env.CORS_ORIGINS || '').split(',').map((origin) => origin.trim()).filter(Boolean);
}

function configureTrustProxy(app) {
  app.set('trust proxy', 1);
}

function requestContext(req, res, next) {
  req.id = randomUUID();
  res.setHeader('X-Request-Id', req.id);
  next();
}

function safeResponses(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 500) {
      console.error(JSON.stringify({ service: 'api', event: 'handled_error', requestId: req.id, error: body?.error || 'unknown' }));
      return json({ error: 'Internal server error.', requestId: req.id });
    }
    if (res.statusCode >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
      return json({ ...body, requestId: req.id });
    }
    return json(body);
  };
  next();
}

function cors(allowlist) {
  const allowed = new Set(allowlist);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (!origin) return next();

    let sameOrigin = false;
    try {
      const protocol = req.get('x-forwarded-proto')?.split(',')[0].trim() || req.protocol;
      sameOrigin = origin === `${protocol}://${req.get('host')}`;
    } catch {
      return res.status(403).json({ error: 'Request not allowed.', requestId: req.id });
    }
    if (!sameOrigin && !allowed.has(origin)) {
      return res.status(403).json({ error: 'Request not allowed.', requestId: req.id });
    }

    res.setHeader('Access-Control-Allow-Origin', origin);
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
  const status = err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
  console.error(JSON.stringify({ service: 'api', event: 'request_error', requestId: req.id, status, error: err.message }));
  res.status(status).json({ error: status === 413 ? 'Payload too large.' : 'Internal server error.', requestId: req.id });
}

module.exports = {
  allowedOrigins, configureTrustProxy, cors, errorHandler, rateLimit, requestContext, safeResponses,
  validateEnvironment,
};
