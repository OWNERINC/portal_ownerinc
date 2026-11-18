import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
export const { term } = require('./ethics');
const express = require('express');
const security = require('./middleware/security');

export async function knowledgeDocumentAPI({ uploadDir }) {
  if (!process.env.PGLITE_MODULE_PATH) throw new Error('Set an external PGLITE_MODULE_PATH');
  const { PGlite } = await import(pathToFileURL(resolve(process.env.PGLITE_MODULE_PATH)).href);
  const db = new PGlite();
  const schema = await readFile(new URL('../../api/db/schema.sql', import.meta.url), 'utf8');
  await db.exec(`CREATE TABLE users(uid TEXT PRIMARY KEY); INSERT INTO users VALUES('reader'),('manager'),('pending');
    ${schema.match(/CREATE TABLE IF NOT EXISTS knowledge_base \([\s\S]*?\n\);/)[0]}
    ${schema.match(/CREATE TABLE IF NOT EXISTS audit_log \([\s\S]*?\n\);/)[0]}`);
  const users = new Map([
    ['reader', { uid: 'reader', name: 'Leitor', role: 'viewer', permissions: {}, ethics_accepted: true }],
    ['manager', { uid: 'manager', name: 'Gestor', role: 'admin', permissions: { manageKnowledge: true }, ethics_accepted: true }],
    ['pending', { uid: 'pending', role: 'viewer', permissions: {}, ethics_accepted: false }],
  ]);
  const state = { sql: [], users };
  const pool = {
    async query(sql, args = []) {
      state.sql.push({ sql, args });
      if (/FROM users u/.test(sql)) return { rows: users.has(args[0]) ? [users.get(args[0])] : [] };
      if (/FROM pending_registrations/.test(sql)) return { rows: [] };
      if (/SELECT accepted_at FROM ethics_acceptances/.test(sql)) return { rows: users.get(args[0])?.ethics_accepted ? [{ accepted_at: '2026-11-18T00:00:00Z' }] : [] };
      return db.query(sql, args);
    },
    async connect() { return { query: pool.query, release() {} }; },
  };
  async function load(relative, dependencies) {
    const filename = fileURLToPath(new URL(`../../api/${relative}`, import.meta.url));
    const localRequire = createRequire(filename), module = { exports: {} };
    new Function('require','module','exports','__filename','__dirname','process', await readFile(filename, 'utf8'))(
      name => dependencies.has(name) ? dependencies.get(name) : localRequire(name),
      module, module.exports, filename, dirname(filename), { env: { UPLOAD_DIR: uploadDir } });
    return module.exports;
  }
  const auth = await load('middleware/auth.js', new Map([
    ['../db', pool], ['firebase-admin/app', { getApps: () => [{}] }],
    ['firebase-admin/auth', { getAuth: () => ({ async verifyIdToken(token, revoked) {
      if (!revoked || !users.has(token)) throw new Error('Invalid fixture identity');
      return { uid: token, email_verified: true };
    } }) }],
  ]));
  const dependencies = new Map([['../db', pool], ['../middleware/auth', auth]]);
  const knowledge = await load('routes/knowledge.js', dependencies);
  const ethics = await load('routes/ethics.js', dependencies);
  const usersRouter = express.Router();
  usersRouter.get('/me', auth.authMiddleware, (req, res) => res.json(req.user));
  const indexDependencies = new Map([
    ['dotenv', { config() {} }], ['./db', pool],
    ['./middleware/security', { ...security, validateEnvironment() {}, allowedOrigins: () => [] }],
  ]);
  const indexSource = await readFile(new URL('../../api/index.js', import.meta.url), 'utf8');
  for (const [, name] of indexSource.matchAll(/require\('(\.\/routes\/[^']+)'\)/g)) {
    indexDependencies.set(name, name === './routes/knowledge' ? knowledge : name === './routes/ethics' ? ethics
      : name === './routes/users' ? usersRouter : name === './routes/user-imports'
      ? { router: express.Router(), internalRouter: express.Router() } : express.Router());
  }
  const app = await load('index.js', indexDependencies);
  return { app, pool, db, state, close: () => db.close() };
}
