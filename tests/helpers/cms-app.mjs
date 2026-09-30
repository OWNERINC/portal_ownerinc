import { createRequire } from 'node:module';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const Module = require('node:module');
const express = require('express');

// Exercise real Express handlers and transactions with a caller-owned pg seam.
export function cmsApp(pool, user = { uid: 'cms-test-admin', role: 'admin', permissions: { manageKnowledge: true } }) {
  const routePath = require.resolve('./routes/cms');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (parent?.filename === routePath && request === '../db') return pool;
    if (parent?.filename === routePath && request === '../middleware/auth') {
      return { authMiddleware(req, res, next) { req.user = user; next(); } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let router;
  try {
    delete require.cache[routePath];
    router = require('./routes/cms');
  } finally {
    delete require.cache[routePath];
    Module._load = originalLoad;
  }
  const app = express();
  app.use(express.json({ limit: '6mb' }));
  app.use((req, res, next) => { req.id = 'cms-test-request'; next(); });
  app.use('/api/cms', router);
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  return app;
}
