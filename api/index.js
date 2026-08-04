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
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300 }));
app.use(express.json({ limit: '100kb' }));

// Serve arquivos de upload (fotos de perfil)
app.use('/uploads', express.static('/app/uploads'));

// Rotas
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/users',     require('./routes/users'));
app.use('/api/job-titles', require('./routes/job-titles'));
app.use('/api/knowledge', require('./routes/knowledge'));
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/academy',   require('./routes/academy'));
app.use('/api/benefits',  require('./routes/benefits'));
app.use('/api/ombudsman', require('./routes/ombudsman'));
app.use('/api/upload',    require('./routes/upload'));
app.use('/api/solides',   require('./routes/solides'));
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
