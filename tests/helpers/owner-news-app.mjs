import { readFileSync } from 'node:fs';
import { createRequire, Module } from 'node:module';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express');

export function ownerNewsApp(pool, adminUid = 'home-admin') {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.id = 'owner-news-test'; next(); });
  for (const [prefix, file] of [['/api/announcements', './routes/announcements'], ['/api/cms/owner-news', './routes/owner-news-admin']]) {
    const path = require.resolve(file);
    const route = new Module(path);
    const routeRequire = createRequire(path);
    route.require = name => {
      if (name === '../db') return pool;
      if (name === '../middleware/auth') return { authMiddleware(req, res, next) {
        const token = req.get('Authorization');
        if (!['Bearer admin', 'Bearer employee'].includes(token)) return res.sendStatus(401);
        req.user = token === 'Bearer admin'
          ? { uid: adminUid, role: 'admin', permissions: { manageKnowledge: true } }
          : { uid: 'home-employee', role: 'employee', permissions: {} };
        next();
      } };
      return routeRequire(name);
    };
    route._compile(readFileSync(path, 'utf8'), path);
    app.use(prefix, route.exports);
  }
  app.use((error, req, res, next) => res.status(500).json({ error: error.message }));
  return app;
}
