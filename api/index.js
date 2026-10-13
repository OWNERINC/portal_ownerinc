require('dotenv').config();
const express = require('express');
const pool = require('./db');
const {
  allowedOrigins, configureTrustProxy, cors, errorHandler, rateLimit, requestContext, safeResponses, validateEnvironment,
} = require('./middleware/security');

validateEnvironment(process.env);

const app = express();

configureTrustProxy(app);
app.disable('x-powered-by');
app.use(requestContext);
app.use(safeResponses);
app.use(cors(allowedOrigins(process.env)));
// Session boundaries own their 16 KiB parser, before the legacy CMS's larger parser.
// Optional bridge configuration is checked on requests, never during Portal startup.
const { firebaseAuth, createAuthMiddleware } = require('./middleware/auth');
// Authenticated service traffic has bounded per-operation quotas inside its router.
app.use('/api/internal/editorial', require('./routes/editorial-internal').createEditorialInternalRouter({ db: pool, firebaseAuth }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));
app.use('/api/cms/session', require('./routes/editorial-session').createEditorialSessionRouter({ db: pool, firebaseAuth, createAuthMiddleware }));
app.use('/api/cms/v2/session', require('./routes/editorial-admin-session').createEditorialAdminSessionRouter({ db: pool, firebaseAuth, createAuthMiddleware }));
// CMS block documents are bounded separately; keep the smaller default for every other JSON API.
app.use('/api/cms', express.json({ limit: '6mb' }));
app.use('/api/users/bulk', express.json({ limit: '1mb' }));
app.use(express.json({ limit: '100kb' }));

// Only profile-photo filenames are public; generated card media stays behind
// its authenticated API route.
app.use('/uploads/cms-private', (req, res) => res.sendStatus(404));
app.use('/uploads', (req, res, next) => {
  if (/^\/pos-card-[0-9a-f-]+\.webp$/i.test(req.path)) return res.sendStatus(404);
  if (/^\/autocard-[0-9a-f-]+\.webp$/i.test(req.path)) return res.sendStatus(404);
  if (!/^\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/i.test(req.path)) return res.sendStatus(404);
  return next();
});
app.use('/uploads', express.static('/app/uploads'));

// Rotas
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/users',     require('./routes/users'));
app.use('/api/registrations', require('./routes/registrations'));
const userImports = require('./routes/user-imports');
app.use('/api/users/bulk', userImports.router);
app.use('/api/internal/user-imports', userImports.internalRouter);
app.use('/api/job-titles', require('./routes/job-titles'));
app.use('/api/knowledge', require('./routes/knowledge'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/academy',   require('./routes/academy'));
app.use('/api/benefits',  require('./routes/benefits'));
app.use('/api/announcements', require('./routes/announcements'));
app.use('/api/upload',    require('./routes/upload'));
app.use('/api/solides',   require('./routes/solides'));
app.use('/api/cms',       require('./routes/cms'));
app.use('/api/cms/assets', require('./routes/cms-assets'));
app.use('/api/cms/owner-news', require('./routes/owner-news-admin'));
const posCardsRoutes = require('./routes/pos-cards');
app.use('/api/pos-cards', posCardsRoutes);
// AutoCard is mounted at its namespaced path and at its legacy asset paths so
// the migrated browser bundle can keep its existing /api/cards and /api/media URLs.
const autocardRoutes = require('./routes/autocard');
app.use('/api/autocard', autocardRoutes);
app.use('/api', (req, res, next) => {
  if (req.path === '/cards' || req.path.startsWith('/cards/') || req.path === '/media' || req.path.startsWith('/media/')) {
    return autocardRoutes(req, res, next);
  }
  return next();
});

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch (error) {
    console.error(JSON.stringify({ service: 'api', event: 'readiness_failed', error: error.message }));
    res.status(503).json({ status: 'unavailable' });
  }
});

app.use(errorHandler);

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(JSON.stringify({ service: 'api', event: 'started', port: Number(PORT) })));
}

module.exports = app;
