import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
export const { term } = require('./ethics');
const express = require('express');
const supertest = require('supertest');

async function load(relative, dependencies) {
  const filename = fileURLToPath(new URL(`../../api/${relative}`, import.meta.url));
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', '__filename', '__dirname', await readFile(filename, 'utf8'))(
    name => dependencies.has(name) ? dependencies.get(name) : localRequire(name), module, module.exports, filename, dirname(filename),
  );
  return module.exports;
}

// Real Express, route, authentication middleware and acceptance SQL. Only
// Firebase verification and PostgreSQL transport are substituted, with no env.
export async function ethicsHarness() {
  const users = new Map([
    ['viewer', { uid: 'viewer', role: 'viewer', permissions: {} }],
    ['admin', { uid: 'admin', role: 'admin', permissions: { manageUsers: true } }],
    ['super', { uid: 'super', role: 'admin', permissions: { superAdmin: true } }],
  ]);
  const state = { users, acceptances: new Map(), sql: [], fail: false };
  const key = ([uid, version, hash]) => `${uid}:${version}:${hash}`;
  const db = { async query(sql, params) {
    state.sql.push({ sql, params });
    if (state.fail) throw new Error('Mock database unavailable');
    if (/FROM users u/.test(sql)) {
      const user = users.get(params[0]);
      return { rows: user ? [{ ...user, ethics_accepted: state.acceptances.has(key(params)) }] : [] };
    }
    if (/FROM pending_registrations/.test(sql)) return { rows: [] };
    if (/INSERT INTO ethics_acceptances/.test(sql)) {
      if (state.acceptances.has(key(params))) return { rows: [] };
      const accepted_at = '2026-11-10T15:00:00.000Z';
      state.acceptances.set(key(params), { accepted_at, is_mock: params[3] });
      return { rows: [{ accepted_at }] };
    }
    if (/SELECT accepted_at FROM ethics_acceptances/.test(sql)) return { rows: [state.acceptances.get(key(params))].filter(Boolean) };
    throw new Error(`Unmocked SQL: ${sql}`);
  } };
  const middleware = await load('middleware/auth.js', new Map([
    ['../db', db],
    ['firebase-admin/app', { getApps: () => [{}] }],
    ['firebase-admin/auth', { getAuth: () => ({ async verifyIdToken(token, revoked) {
      if (!revoked || !users.has(token)) throw new Error('Invalid token');
      return { uid: token, email_verified: true };
    } }) }],
  ]));
  const router = await load('routes/ethics.js', new Map([['../db', db], ['../middleware/auth', middleware]]));
  const app = express();
  app.use(express.json());
  app.use('/api/ethics', router);
  app.get('/api/users/me', middleware.authMiddleware, (req, res) => res.json(req.user));
  app.all('/api/protected', middleware.authMiddleware, (_req, res) => res.json({ protected: true }));
  app.use((error, _req, res, _next) => res.status(503).json({ error: error.message }));
  return { app, request: supertest(app), state, db };
}
