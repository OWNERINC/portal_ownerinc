import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
export const registrationId = '11111111-1111-4111-8111-111111111111';
export const jobTitleId = '22222222-2222-4222-8222-222222222222';
export const registrationData = { name: 'Pessoa Teste', email: 'person@example.test', password: '  senha com espaços  ' };

// Real routers, services, policies and admission middleware. All external I/O
// is replaced before import. This fixture never loads .env or api/index.js.
export async function createRegistrationApiHarness(t) {
  const paths = ['./db', './middleware/auth', './integrations/password-reset-email',
    './services/user-invitation', './services/pending-registration', './routes/auth', './routes/registrations']
    .map(name => require.resolve(name));
  const originals = paths.map(modulePath => require.cache[modulePath]);
  t.after(() => paths.forEach((modulePath, index) => {
    if (originals[index]) require.cache[modulePath] = originals[index];
    else delete require.cache[modulePath];
  }));
  const inject = (name, exports) => {
    const modulePath = require.resolve(name);
    require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true, exports };
  };
  const state = { registration: null, identity: null, user: null, cleanup: false, failSql: null, failCommit: false, failCreate: null, failMail: false, failEnable: false, titleActive: true, changed: false, noUpdate: false };
  const calls = { sql: [], firebase: [], mail: [], releases: [] };
  const admin = { uid: 'admin-fixture', role: 'admin', permissions: { manageUsers: true }, ethics_accepted: true };
  const reader = { uid: 'reader-fixture', role: 'viewer', permissions: {}, ethics_accepted: true };
  const rows = values => ({ rows: values, rowCount: values.length });
  let snapshot;
  async function query(raw, params = []) {
    const sql = raw.replace(/\s+/g, ' ').trim();
    calls.sql.push({ sql, params });
    if (state.failSql && state.failSql(sql)) throw new Error(registrationData.password);
    if (sql === 'BEGIN') {
      snapshot = JSON.parse(JSON.stringify({ registration: state.registration, user: state.user }));
      return rows([]);
    }
    if (sql === 'ROLLBACK') {
      if (snapshot) Object.assign(state, snapshot);
      return rows([]);
    }
    if (sql === 'COMMIT') {
      if (state.failCommit) throw new Error('Ambiguous fixture commit');
      return rows([]);
    }
    if (sql.startsWith('SELECT pg_advisory')) return rows([]);
    if (sql.includes('COUNT(*)') && sql.includes('pending_registrations')) return rows([{ count: state.hourlyCount || 0, total: state.registration ? 1 : 0 }]);
    if (sql.startsWith('SELECT 1 FROM firebase_cleanup_queue')) return rows(state.cleanup ? [{}] : []);
    if (sql.startsWith('SELECT firebase_uid FROM firebase_cleanup_queue')) return rows([]);
    if (sql.startsWith('DELETE FROM firebase_cleanup_queue')) { state.cleanup = false; return rows([]); }
    if (sql.startsWith('INSERT INTO firebase_cleanup_queue')) { state.cleanup = true; return rows([{}]); }
    if (sql.startsWith('SELECT 1 FROM job_titles')) return rows(state.titleActive ? [{}] : []);
    if (sql.startsWith('SELECT id FROM pending_registrations')) return rows(state.registration ? [{ id: state.registration.id }] : []);
    if (sql.startsWith('SELECT id, firebase_uid') || sql.startsWith('SELECT id, firebase_uid, name')) {
      const row = state.registration && { ...state.registration };
      if (row && state.changed && sql.includes('WHERE id = $1 FOR UPDATE')) row.status = 'rejected';
      return rows(row ? [row] : []);
    }
    if (sql.startsWith('SELECT u.*')) return rows(params[0] === admin.uid ? [admin] : params[0] === reader.uid ? [reader] : state.user ? [{ ...state.user }] : []);
    if (sql.startsWith('SELECT status FROM pending_registrations')) return rows(state.registration ? [{ status: state.registration.status }] : []);
    if (sql.startsWith('SELECT uid, email, permissions')) return rows(state.user ? [{ ...state.user }] : []);
    if (sql.startsWith('SELECT uid, email FROM users')) return rows(state.user ? [{ ...state.user }] : []);
    if (sql.startsWith('SELECT 1 FROM users')) {
      if (!state.user) return rows([]);
      const disabled = state.user.permissions?.accountDisabled;
      if (sql.includes('accountDisabled') && (disabled === true || disabled === 'true' || state.user.firebase_enable_pending)) return rows([]);
      return rows([{}]);
    }
    if (sql.startsWith('INSERT INTO pending_registrations')) {
      state.registration = { id: registrationId, firebase_uid: params[0], email: params[1], name: params[2], status: 'pending', created_at: '2020-01-01T00:00:00Z', firebase_cleanup_pending: false };
      return rows([state.registration]);
    }
    if (sql.startsWith('INSERT INTO users')) {
      state.user = { uid: params[0], email: params[1], name: params[2], role: 'viewer', permissions: {}, firebase_enable_pending: true, ethics_accepted: false };
      return rows([state.user]);
    }
    if (sql.startsWith('UPDATE pending_registrations') && sql.includes("status = 'approved'")) {
      state.registration.status = 'approved';
      return rows([state.registration]);
    }
    if (sql.startsWith('UPDATE pending_registrations') && sql.includes('SET firebase_uid = $1')) {
      if (state.noUpdate) return rows([]);
      state.registration.firebase_uid = params[0];
      return rows([state.registration]);
    }
    if (sql.startsWith('UPDATE users SET firebase_enable_pending = FALSE')) {
      state.user.firebase_enable_pending = false;
      return rows([state.user]);
    }
    if (sql.startsWith('INSERT INTO audit_log')) return rows([{}]);
    throw new Error(`Unsupported fixture SQL: ${sql}`);
  }
  const client = { query, release(force) { calls.releases.push(force); } };
  const pool = { query, async connect() { return client; } };
  const missing = () => Object.assign(new Error('Missing fixture identity'), { code: 'auth/user-not-found' });
  const firebaseAuth = {
    async createUser(data) {
      calls.firebase.push({ method: 'createUser', data });
      if (state.failCreate) throw state.failCreate;
      if (state.identity) throw Object.assign(new Error('Duplicate fixture'), { code: 'auth/email-already-exists' });
      state.identity = { ...data, uid: 'employee-fixture' };
      return { ...state.identity };
    },
    async getUser(uid) {
      calls.firebase.push({ method: 'getUser', uid });
      if (!state.identity || state.identity.uid !== uid) throw missing();
      return { ...state.identity };
    },
    async getUserByEmail(email) {
      calls.firebase.push({ method: 'getUserByEmail', email });
      if (!state.identity || state.identity.email !== email) throw missing();
      return { ...state.identity };
    },
    async generateEmailVerificationLink() { throw new Error('Verification must not be generated'); },
    async generatePasswordResetLink(email) {
      calls.firebase.push({ method: 'generatePasswordResetLink', email });
      return 'https://example.test/reset';
    },
    async deleteUser(uid) { calls.firebase.push({ method: 'deleteUser', uid }); state.identity = null; },
    async updateUser(uid, data) {
      calls.firebase.push({ method: 'updateUser', uid, data });
      if (state.failEnable) throw new Error('Fixture enable failed');
      Object.assign(state.identity, data);
      return { ...state.identity };
    },
    // Synthetic tokens intentionally allow testing local admission separately
    // from the provider's disabled-user token checks.
    async verifyIdToken(token, revoked) {
      calls.firebase.push({ method: 'verifyIdToken', token, revoked });
      assert.equal(revoked, true);
      if (token === admin.uid || token === reader.uid) return { uid: token, email_verified: false };
      if (token === 'employee-fixture') return { uid: token, email_verified: false };
      throw new Error('Invalid fixture token');
    },
  };
  const authPath = require.resolve('./middleware/auth');
  const authRequire = createRequire(authPath);
  const authModule = { exports: {} };
  const factory = vm.runInThisContext(`(function(require,module,exports,process){${await readFile(authPath, 'utf8')}\n})`, { filename: authPath });
  factory(name => {
    if (name === 'firebase-admin/app') return { getApps: () => [{}] };
    if (name === 'firebase-admin/auth') return { getAuth: () => firebaseAuth };
    if (name === '../db') return pool;
    return authRequire(name);
  }, authModule, authModule.exports, process);
  inject('./middleware/auth', authModule.exports);
  inject('./db', pool);
  const mailer = require('./integrations/password-reset-email');
  const send = kind => async message => {
    if (state.failMail) throw new Error(registrationData.password);
    calls.mail.push({ kind, ...message });
  };
  inject('./integrations/password-reset-email', { ...mailer, sendVerificationEmail: async () => { throw new Error('Verification must not be sent'); }, sendRegistrationPassword: send('pending'), sendPasswordReset: send('active') });
  for (const name of ['./services/user-invitation', './services/pending-registration', './routes/auth', './routes/registrations']) delete require.cache[require.resolve(name)];
  const express = require('express');
  const security = require('./middleware/security');
  const app = express();
  app.use(express.json(), security.requestContext, security.safeResponses);
  app.use('/api/auth', require('./routes/auth'));
  app.use('/api/registrations', require('./routes/registrations'));
  app.get('/api/users/me', authModule.exports.authMiddleware, (request, response) => response.json(request.user));
  app.get('/api/probe-private', authModule.exports.authMiddleware, (request, response) => response.json({ allowed: true }));
  app.post('/probe/error', () => { throw new Error(registrationData.password); });
  app.use(security.errorHandler);
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function http(route, body, token) {
    const response = await fetch(origin + route, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  }
  const service = require('./services/pending-registration');
  return { state, calls, http, service, pool, client };
}
