import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const apiRoot = fileURLToPath(new URL('../../api/', import.meta.url));
const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express');
const supertest = require('supertest');
const policy = require('./middleware/policy');
const { requestContext, errorHandler } = require('./middleware/security');

export const actors = {
  manager: { uid: 'manager-fixture', role: 'admin', permissions: { manageUsers: true } },
  superadmin: { uid: 'super-fixture', role: 'admin', permissions: { superAdmin: true } },
  viewer: { uid: 'viewer-fixture', role: 'viewer', permissions: {} },
  'viewer-flags': { uid: 'viewer-flags-fixture', role: 'viewer', permissions: { manageUsers: true, superAdmin: true } },
  admin: { uid: 'admin-fixture', role: 'admin', permissions: {} },
  'other-manager': { uid: 'other-fixture', role: 'admin', permissions: { manageReminders: true } },
  'string-manager': { uid: 'string-fixture', role: 'admin', permissions: { manageUsers: 'true', superAdmin: 'true' } },
  'manager-string-super': { uid: 'mixed-fixture', role: 'admin', permissions: { manageUsers: true, superAdmin: 'true' } },
};

// Execute entire route modules, without require-cache mutation or loading the
// real DB/Firebase/SMTP services. Validation, policy, Express and qs stay real.
async function loadRoute(name, dependencies) {
  const filename = path.join(apiRoot, 'routes', `${name}.js`);
  const source = await readFile(filename, 'utf8');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const scopedRequire = dependency => dependencies.has(dependency) ? dependencies.get(dependency) : localRequire(dependency);
  new Function('require', 'module', 'exports', 'process', source)(scopedRequire, module, module.exports, { env: {} });
  return module.exports;
}

export async function createAdminFilterHarness(t) {
  const state = {
    sql: [], connections: 0, releases: 0, fail: null,
    users: { rows: [], total: 0 }, titles: { rows: [], total: 0 }, audit: { rows: [], total: 0 },
  };
  const pool = {
    async query(sql, params = []) {
      const call = { sql, params: structuredClone(params) };
      state.sql.push(call);
      if (state.fail?.(call)) throw new Error('Synthetic administrative read failure');
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql) || /^\s*INSERT INTO audit_log/.test(sql)) return { rows: [] };
      const result = /\bFROM audit_log\b/.test(sql) ? state.audit
        : /\bFROM job_titles\b/.test(sql) ? state.titles
          : /\bFROM users\b/.test(sql) ? state.users : null;
      if (!result) throw new Error(`Unmocked administrative SQL: ${sql}`);
      // Scripted DB results only: this double deliberately does not emulate SQL
      // filtering, grouping, collation or timezone evaluation.
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: result.total, count: result.total }] };
      return { rows: structuredClone(result.rows) };
    },
    async connect() {
      state.connections++;
      return { query: pool.query, release() { state.releases++; } };
    },
  };
  const unexpected = () => { throw new Error('Mutation/external service invoked by a read-contract test'); };
  const auth = {
    authMiddleware(req, res, next) {
      const token = req.get('authorization')?.replace(/^Bearer /, '');
      if (!actors[token]) return res.status(401).json({ error: 'Unauthorized.', requestId: req.id });
      req.user = structuredClone(actors[token]);
      next();
    },
    can: policy.can,
    firebaseAuth: new Proxy({}, { get: () => unexpected }),
  };
  const dependencies = new Map([
    ['../db', pool], ['../middleware/auth', auth],
    ['node:fs/promises', new Proxy({}, { get: () => unexpected })],
    ['../services/user-invitation', {
      compensateCreatedInvitedUser: unexpected, createInvitedUser: unexpected,
      enableActiveUser: unexpected, lockFirebaseIdentity: unexpected,
    }],
  ]);
  const app = express(); // Express 4 default extended query parser, as in index.js.
  app.use(requestContext);
  app.use('/api/users', await loadRoute('users', dependencies));
  app.use('/api/job-titles', await loadRoute('job-titles', dependencies));
  app.use(errorHandler);
  const server = createServer(app);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const request = supertest(`http://127.0.0.1:${server.address().port}`);
  return {
    app, state,
    get(url, actor = 'superadmin') {
      const call = request.get(url);
      return actor ? call.set('Authorization', `Bearer ${actor}`) : call;
    },
    reset() { state.sql.length = 0; state.connections = 0; state.releases = 0; state.fail = null; },
  };
}
