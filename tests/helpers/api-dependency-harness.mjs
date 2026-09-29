import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
const apiRoot = fileURLToPath(new URL('../../api/', import.meta.url));
const express = apiRequire('express');
const supertest = apiRequire('supertest');
const security = apiRequire('./middleware/security');
const users = {
  manager: { uid: 'dependency-manager', role: 'admin', permissions: { manageReminders: true, manageKnowledge: true } },
  reader: { uid: 'dependency-reader', role: 'viewer', permissions: {} },
};

// Execute complete, unmodified CommonJS source with explicit external seams.
// A synthetic process prevents dotenv/credential/environment access. Express,
// body-parser, qs, Multer, Sharp, policy, validation and audit helpers stay real.
async function loadSource(relative, dependencies) {
  const filename = path.join(apiRoot, relative);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  const request = name => dependencies.has(name) ? dependencies.get(name) : localRequire(name);
  const execute = new Function('require', 'module', 'exports', '__filename', '__dirname', 'process', await readFile(filename, 'utf8'));
  execute(request, module, module.exports, filename, path.dirname(filename), { env: { UPLOAD_DIR: '/dependency-fixture/uploads' } });
  return module.exports;
}

export async function createDependencyHarness(t) {
  const state = {
    sql: [], verifiedTokens: [], files: new Map(), writes: [], opens: [], assets: new Map(),
    references: [], connections: 0, releases: 0, incoming: [],
  };
  const pool = {
    async query(sql, params = []) {
      state.sql.push({ sql, params });
      if (/FROM users u/.test(sql)) return { rows: Object.values(users).filter(user => user.uid === params[0]).map(user => structuredClone(user)) };
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: 0 }] };
      if (/FROM notifications_log|FROM cms_documents/.test(sql) && !/jsonb_array_elements/.test(sql)) return { rows: [] };
      if (/INSERT INTO reminders/.test(sql)) return { rows: [{
        id: randomUUID(), title: params[0], description: params[1], trigger_day: params[2],
        target_users: JSON.parse(params[3]), channel: params[4], active: params[5], created_by: params[6],
      }] };
      if (/SELECT photo_url FROM users/.test(sql)) return { rows: [{ photo_url: '' }] };
      if (/INSERT INTO cms_assets/.test(sql)) {
        const asset = {
          id: randomUUID(), storage_key: params[0], original_name: params[1], mime_type: params[2],
          byte_size: params[3], uploaded_by: params[4], created_at: '2026-09-29T12:00:00Z',
        };
        state.assets.set(asset.id, asset);
        return { rows: [asset] };
      }
      if (/FROM cms_assets WHERE id = \$1 AND deleting_at IS NULL/.test(sql)) {
        const asset = state.assets.get(params[0]);
        return { rows: asset && !asset.deleting_at ? [asset] : [] };
      }
      if (/jsonb_array_elements\(r.blocks\)/.test(sql)) return { rows: state.references };
      if (/^(BEGIN|COMMIT|ROLLBACK)$|pg_advisory_xact_lock|INSERT INTO audit_log|UPDATE users SET photo_url/.test(sql)) return { rows: [] };
      throw new Error(`Unmocked SQL in dependency regression: ${sql}`);
    },
    async connect() {
      state.connections++;
      return { query: pool.query, release() { state.releases++; } };
    },
  };
  const files = {
    async mkdir() {},
    async writeFile(target, buffer, options) {
      assert.ok(Buffer.isBuffer(buffer), 'real memoryStorage must supply a Buffer');
      assert.equal(options.flag, 'wx');
      assert.equal(state.files.has(target), false);
      state.writes.push(target);
      state.files.set(target, Buffer.from(buffer));
    },
    async unlink(target) { state.files.delete(target); },
    async open(target) {
      state.opens.push(target);
      const buffer = state.files.get(target);
      assert.ok(buffer, 'only a persisted fixture asset may be opened');
      return { createReadStream: () => Readable.from([buffer]), async close() {} };
    },
  };
  const auth = await loadSource('middleware/auth.js', new Map([
    ['../db', pool],
    ['firebase-admin/app', { getApps: () => [{}], cert() { throw new Error('No credentials in dependency tests'); }, initializeApp() { throw new Error('No Firebase initialization'); } }],
    ['firebase-admin/auth', { getAuth: () => ({
      async verifyIdToken(token, checkRevoked) {
        state.verifiedTokens.push({ token, checkRevoked });
        if (!users[token]) throw new Error('Invalid fixture token');
        return { uid: users[token].uid, email_verified: true };
      },
    }) }],
  ]));
  const dependencies = new Map([
    ['../db', pool], ['../middleware/auth', auth], ['node:fs/promises', files],
  ]);
  const actualRoutes = new Map();
  for (const name of ['reminders', 'cms', 'upload', 'cms-assets']) {
    actualRoutes.set(`./routes/${name}`, await loadSource(`routes/${name}.js`, dependencies));
  }
  // Load the real index so JSON sizes, query defaults, request IDs, error
  // responses and private-static denials cannot drift into a copied test app.
  // Unrelated routes are inert: no SMTP, Firebase SDK, PostgreSQL or services.
  const indexSource = await readFile(path.join(apiRoot, 'index.js'), 'utf8');
  const indexDependencies = new Map([
    ['dotenv', { config() {} }], ['./db', pool],
    ['./middleware/security', { ...security, validateEnvironment() {}, allowedOrigins: () => [] }],
  ]);
  // Observe only the body's passage through the real bulk JSON parser, without
  // loading the import worker or claiming to test its persistence contract.
  const bulkProbe = express.Router();
  bulkProbe.post('/__dependency-parser-probe', (req, res) => res.json({ titleLength: req.body.title.length }));
  for (const [, name] of indexSource.matchAll(/require\('(\.\/routes\/[^']+)'\)/g)) {
    indexDependencies.set(name, actualRoutes.get(name) || (name === './routes/user-imports'
      ? { router: bulkProbe, internalRouter: express.Router() } : express.Router()));
  }
  const app = await loadSource('index.js', indexDependencies);
  const server = createServer((req, res) => { state.incoming.push(req); app(req, res); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return { app, state, server, port: address.port, request: supertest(`http://127.0.0.1:${address.port}`) };
}
