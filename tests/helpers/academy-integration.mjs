import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express');
const supertest = require('supertest');

// Mount only the real Academy router. There is deliberately no CMS route or
// dependency seam in this harness: a maintained-domain test must see a 404 for
// /api/cms rather than accidentally exercising editorial infrastructure.
export async function createAcademyHttp(t, pool, users) {
  const filename = new URL('../../api/routes/academy.js', import.meta.url);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const auth = {
    can: require('./middleware/policy').can,
    authMiddleware(req, res, next) {
      req.user = users[req.get('x-fixture-user')];
      req.id = 'academy-integration';
      if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
      next();
    },
  };
  const dependencies = new Map([['../db', pool], ['../middleware/auth', auth]]);
  new Function('require', 'module', 'exports', await readFile(filename, 'utf8'))( // eslint-disable-line no-new-func
    name => dependencies.has(name) ? dependencies.get(name) : localRequire(name), module, module.exports,
  );
  const app = express();
  app.use(express.json());
  app.use('/api/academy', module.exports);
  app.use('/api/cms', (req, res) => res.status(404).json({ error: 'Not found.' }));
  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    res.status(500).json({ error: 'Internal error', requestId: req.id });
  });
  const server = createServer(app);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { request: supertest(`http://127.0.0.1:${server.address().port}`) };
}
