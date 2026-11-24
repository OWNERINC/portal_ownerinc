import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { apiRequire, deadline, load, response, routes } from '../helpers/readiness-harness.mjs';

const Pool = apiRequire('pg-pool');
const empty = () => ({ rows: [], rowCount: 0 });
const row = value => ({ rows: value ? [{ ...value }] : [], rowCount: value ? 1 : 0 });

function harness({ max = 1, count = 0, mode = 'success' } = {}) {
  const accounts = new Map(), firebase = new Map(), queue = new Set(), registrations = new Map();
  const events = [], held = new Set(), releases = [], errors = [], enabled = [];
  let reached, unblock;
  const ready = new Promise(resolve => { reached = resolve; });
  const barrier = new Promise(resolve => { unblock = resolve; });
  let creates = 0, injected = false;
  class MemoryClient extends EventEmitter {
    constructor() { super(); this._queryable = true; this._ending = false; this.staged = new Map(); }
    connect(callback) { queueMicrotask(() => callback(null)); }
    end(callback) { this._ending = true; queueMicrotask(() => { this.emit('end'); callback?.(); }); }
    query(sql, params = [], callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      const work = Promise.resolve().then(() => {
        assert.ok(!this._ending, 'discarded client must not be reused');
        const text = sql.replace(/\s+/g, ' ').trim();
        events.push(text);
        if (text === 'BEGIN') { this.open = true; return empty(); }
        if (text === 'COMMIT') {
          const creation = [...this.staged.values()].some(user => !accounts.has(user.uid));
          const lose = !injected && (mode === 'creation-commit-lost' && creation || mode === 'enable-commit-lost' && !creation);
          for (const [uid, user] of this.staged) accounts.set(uid, user);
          this.staged.clear(); this.open = false;
          if (lose) { injected = true; throw new Error('Synthetic COMMIT ACK lost'); }
          return empty();
        }
        if (text === 'ROLLBACK') {
          if (['rollback-lost', 'enable-rollback-lost'].includes(mode)) throw new Error('Synthetic ROLLBACK lost');
          this.staged.clear(); this.open = false; return empty();
        }
        if (text.startsWith('SELECT pg_advisory_xact_lock')) return empty();
        if (text === 'SELECT 1' || text.startsWith('SELECT 1 FROM job_titles')) return row({ value: 1 });
        if (text.startsWith('SELECT 1 FROM users')) return row(accounts.get(params[0]));
        if (text.startsWith('SELECT uid FROM users WHERE lower(email)')) return empty();
        if (text.startsWith('INSERT INTO users')) {
          const user = { uid: params[0], email: params[1], permissions: {}, firebase_enable_pending: true };
          this.staged.set(user.uid, user);
          return row(user);
        }
        if (text.startsWith('INSERT INTO audit_log')) {
          if (mode === 'creation-rollback' || mode === 'rollback-lost') throw new Error('Synthetic audit failure');
          return row({ id: 'audit' });
        }
        if (text.startsWith('SELECT uid, email, permissions')) {
          if (text.includes('WHERE firebase_enable_pending = TRUE')) return { rows: [...accounts.values()], rowCount: accounts.size };
          return row(this.staged.get(params[0]) || accounts.get(params[0]));
        }
        if (text.startsWith('UPDATE users SET firebase_enable_pending')) {
          if (text.includes('= FALSE') && ['enable-update-error', 'enable-rollback-lost'].includes(mode)) throw new Error('Synthetic enable SQL failure');
          const user = { ...accounts.get(params[0]), firebase_enable_pending: text.includes('= TRUE') };
          assert.ok(user.uid);
          if (this.open) this.staged.set(user.uid, user);
          else accounts.set(user.uid, user);
          return row(user);
        }
        if (text.startsWith('SELECT uid, email FROM users')) return row(accounts.get(params[0]));
        if (text.startsWith('SELECT id, firebase_uid')) {
          return row([...registrations.values()].find(item => item.id === params[0] || item.firebase_uid === params[1]));
        }
        if (text.startsWith('UPDATE pending_registrations')) {
          registrations.get(params[0]).status = 'approved';
          return row({});
        }
        if (text.includes('FROM pending_registrations')) return empty();
        if (text.startsWith('SELECT firebase_uid, reason FROM firebase_cleanup_queue')) {
          return { rows: [...queue].map(firebase_uid => ({ firebase_uid, reason: 'test' })), rowCount: queue.size };
        }
        if (text.startsWith('UPDATE firebase_cleanup_queue')) return row({});
        if (text.startsWith('SELECT email FROM pending_registrations')) return empty();
        if (text.startsWith('SELECT firebase_uid FROM firebase_cleanup_queue')) return empty();
        if (text.startsWith('INSERT INTO firebase_cleanup_queue')) { queue.add(params[0]); return row({}); }
        if (text.startsWith('DELETE FROM firebase_cleanup_queue')) { queue.delete(params[0]); return empty(); }
        throw new Error(`Unexpected readiness SQL: ${text}`);
      });
      if (callback) { work.then(value => callback(null, value), callback); return; }
      return work;
    }
  }
  const pool = new Pool({ Client: MemoryClient, ...(max ? { max } : {}), idleTimeoutMillis: 0 });
  pool.on('error', error => errors.push(error));
  pool.on('acquire', client => { assert.equal(held.has(client), false); held.add(client); });
  pool.on('release', (discard, client) => {
    assert.equal(held.delete(client), true, 'each acquisition has exactly one release');
    releases.push(Boolean(discard));
    events.push(discard ? 'release:discard' : 'release');
  });
  const firebaseAuth = {
    async createUser(data) {
      assert.equal(data.disabled, true);
      const uid = `uid-${++creates}`;
      firebase.set(uid, { uid, email: data.email, disabled: true });
      if (creates === count) reached();
      await barrier;
      return { uid };
    },
    async generatePasswordResetLink() { return 'https://example.invalid/reset'; },
    async updateUser(uid, data) {
      if (mode === 'firebase-error' && !data.disabled) throw new Error('Synthetic enable failure');
      assert.ok(firebase.has(uid));
      firebase.set(uid, { ...firebase.get(uid), ...data });
      if (!data.disabled) enabled.push(uid);
    },
    async getUser(uid) { return firebase.get(uid); },
    async deleteUser(uid) { firebase.delete(uid); },
  };
  const service = load('api/services/user-invitation.js', {
    '../middleware/auth': { firebaseAuth },
    '../integrations/password-reset-email': {
      portalLoginUrl: () => 'https://example.invalid/login',
      sendInvitation: async () => ({ accepted: ['synthetic@example.invalid'] }),
      smtpAcceptanceAuditDetails: () => ({ state: 'accepted_by_smtp' }),
    },
  });
  const registered = routes();
  const states = [];
  load('api/routes/users.js', {
    express: { Router: () => registered.router }, '../db': pool,
    '../middleware/auth': { authMiddleware() {}, firebaseAuth },
    '../services/user-invitation': {
      ...service,
      async enableActiveUser(options) {
        const result = await service.enableActiveUser(options);
        states.push(result.state);
        return result;
      },
    },
  });
  const pending = load('api/services/pending-registration.js', {
    '../middleware/auth': { firebaseAuth },
    '../integrations/password-reset-email': {},
    './user-invitation': service,
  });
  const approvalRoutes = routes();
  load('api/routes/registrations.js', {
    express: { Router: () => approvalRoutes.router }, '../db': pool,
    '../middleware/auth': { authMiddleware() {}, can: load('api/middleware/policy.js').can },
    '../services/pending-registration': pending,
  });
  return {
    pool, accounts, firebase, queue, ready, unblock, held, releases, errors, states, events, enabled, service,
    async approve() {
      const id = '10000000-0000-4000-8000-000000000002';
      const uid = 'approval';
      registrations.set(id, { id, firebase_uid: uid, email: 'approval@example.invalid', name: 'Approval', status: 'pending' });
      firebase.set(uid, { uid, email: 'approval@example.invalid', disabled: true });
      const res = response();
      let error;
      await approvalRoutes.find('post', '/:id/approve')({
        id: 'approve', user: { uid: 'admin', role: 'admin', permissions: { manageUsers: true } },
        params: { id }, body: { job_title_id: '10000000-0000-4000-8000-000000000001', contract_type: 'clt' },
      }, res, caught => { error = caught; });
      return { res, error };
    },
    seed(uid = 'existing') {
      accounts.set(uid, { uid, email: `${uid}@example.invalid`, permissions: {}, firebase_enable_pending: true });
      firebase.set(uid, { uid, email: `${uid}@example.invalid`, disabled: true });
    },
    async invite(i) {
      const res = response();
      let error;
      await registered.find('post', '/')({
        id: `invite-${i}`, user: { uid: 'admin', role: 'admin', permissions: { manageUsers: true } },
        body: { name: `Synthetic ${i}`, email: `invite-${i}@example.invalid`, job_title_id: '10000000-0000-4000-8000-000000000001' },
      }, res, caught => { error = caught; });
      return { res, error };
    },
  };
}

for (const max of [2, undefined]) {
  test(`pool-size concurrent admin invitations and SELECT 1 settle with ${max || 'default 10'} slots`, async () => {
    const count = max || 10;
    const h = harness({ max: max || 0, count });
    // undefined must test pg-pool's default, not an increased maximum.
    if (!max) assert.equal(h.pool.options.max, 10);
    const jobs = Array.from({ length: count }, (_, i) => h.invite(i));
    await deadline(h.ready, 'creation barrier not reached');
    const read = h.pool.query('SELECT 1');
    h.unblock();
    try {
      const results = await deadline(Promise.all([...jobs, read]), 'pool saturated: invitations/read did not settle');
      for (const { res, error } of results.slice(0, count)) {
        assert.equal(error, undefined);
        assert.equal(res.statusCode, 201);
      }
      assert.deepEqual(h.states, Array(count).fill('active'));
      assert.equal(h.enabled.length, count);
      assert.ok([...h.accounts.values()].every(user => !user.firebase_enable_pending));
      assert.ok([...h.firebase.values()].every(user => !user.disabled));
      assert.equal(h.pool.options.max, count);
      assert.equal(h.held.size, 0);
      assert.equal(h.pool.waitingCount, 0);
      assert.equal(h.pool.idleCount, h.pool.totalCount);
      assert.equal(h.releases.length, count * 2 + 1);
      assert.deepEqual(h.errors, []);
    } finally {
      // On a red run do not free another owner's client or add pool slots.
      if (!h.held.size) await h.pool.end();
    }
  });
}

for (const mode of ['creation-rollback', 'rollback-lost', 'creation-commit-lost', 'firebase-error', 'enable-update-error', 'enable-rollback-lost', 'enable-commit-lost']) {
  test(`single-slot invitation ${mode}: compensation does not acquire while retaining a client`, async () => {
    const h = harness({ count: 1, mode });
    const job = h.invite(0);
    await deadline(h.ready, 'creation barrier not reached');
    h.unblock();
    try {
      const { res, error } = await deadline(job, `${mode} compensation did not settle`);
      if (mode.startsWith('creation') || mode === 'rollback-lost') assert.ok(error);
      else assert.equal(res.statusCode, 201);
      assert.equal(h.held.size, 0);
      assert.equal(h.pool.waitingCount, 0);
      assert.equal(h.pool.idleCount, h.pool.totalCount);
      assert.deepEqual(h.errors, []);
      if (mode.includes('lost')) assert.equal(h.releases.filter(Boolean).length, 1);
      else assert.ok(h.releases.every(discard => !discard));
      if (mode === 'creation-rollback') assert.equal(h.firebase.size, 0);
      else {
        assert.equal(h.firebase.get('uid-1').disabled, true);
        if (h.accounts.has('uid-1')) assert.equal(h.accounts.get('uid-1').firebase_enable_pending, true);
      }
      if (mode === 'creation-commit-lost' || mode === 'rollback-lost') assert.equal(h.queue.has('uid-1'), true);
    } finally {
      if (!h.held.size) await h.pool.end();
    }
  });
}

test('enable reconciliation releases its selection client before enabling with a single-slot pool', async () => {
  const h = harness();
  h.seed();
  try {
    const result = await deadline(h.service.reconcilePendingFirebaseEnables({ pool: h.pool }), 'reconciliation retained its selection client');
    assert.deepEqual(result, { resolved: 1, failed: 0 });
    assert.equal(h.accounts.get('existing').firebase_enable_pending, false);
    assert.equal(h.firebase.get('existing').disabled, false);
    assert.equal(h.held.size, 0);
    assert.deepEqual(h.releases, [false, false]);
  } finally {
    if (!h.held.size) await h.pool.end();
  }
});

test('provided enable client is never released by helper or followed by a nested pool acquisition', async () => {
  const h = harness({ mode: 'enable-commit-lost' });
  h.seed();
  const client = await h.pool.connect();
  try {
    const result = await deadline(h.service.enableActiveUser({
      pool: h.pool, client, uid: 'existing', email: 'existing@example.invalid',
    }), 'provided-client recovery acquired another slot');
    assert.equal(result.state, 'enable_pending');
    assert.equal(result.discardClient, true);
    assert.equal(h.held.size, 1);
    assert.deepEqual(h.releases, []);
    assert.equal(h.pool.waitingCount, 0);
    assert.equal(h.firebase.get('existing').disabled, true);
    // The actual owner finishes recovery after discarding its unusable client.
    client.release(result.discardClient);
    await result.afterRelease();
    assert.equal(h.accounts.get('existing').firebase_enable_pending, true);
    assert.equal(h.held.size, 0);
    assert.deepEqual(h.releases, [true, false]);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), { state: 'enable_pending' });
  } finally {
    if (!h.held.size) await h.pool.end();
  }
});

test('approval caller discards its provided connection before pending-marker recovery after persisted COMMIT/ACK loss', async () => {
  const h = harness({ mode: 'enable-commit-lost' });
  try {
    const { res, error } = await deadline(h.approve(), 'approval recovery retained the provided client');
    assert.equal(error, undefined);
    assert.deepEqual(JSON.parse(JSON.stringify(res.body)), { status: 'approved_pending_enable', state: 'enable_pending' });
    assert.equal(h.accounts.get('approval').firebase_enable_pending, true);
    assert.equal(h.firebase.get('approval').disabled, true);
    assert.equal(h.held.size, 0);
    assert.equal(h.pool.waitingCount, 0);
    assert.deepEqual(h.releases, [true, false]);
  } finally {
    if (!h.held.size) await h.pool.end();
  }
});

test('provided usable client persists pending marker itself after a confirmed rollback', async () => {
  const h = harness({ mode: 'enable-update-error' });
  h.seed();
  const client = await h.pool.connect();
  try {
    const result = await deadline(h.service.enableActiveUser({
      pool: h.pool, client, uid: 'existing', email: 'existing@example.invalid',
    }), 'safe provided client was ignored for recovery');
    assert.deepEqual(result, { state: 'enable_pending' });
    assert.equal(h.accounts.get('existing').firebase_enable_pending, true);
    assert.equal(h.firebase.get('existing').disabled, true);
    assert.equal(h.held.size, 1);
    assert.equal(h.pool.waitingCount, 0);
    assert.deepEqual(h.releases, []);
    client.release();
    assert.deepEqual(h.releases, [false]);
  } finally {
    if (!h.held.size) await h.pool.end();
  }
});

test('cleanup queue releases its selection client before acquiring a cleanup transaction', async () => {
  const h = harness();
  h.firebase.set('queued', { uid: 'queued', email: 'queued@example.invalid', disabled: true });
  h.queue.add('queued');
  try {
    const result = await deadline(h.service.processFirebaseCleanup({ pool: h.pool }), 'cleanup queue retained its selection client');
    assert.deepEqual(result, { deleted: 1, failed: 0 });
    assert.equal(h.firebase.size, 0);
    assert.equal(h.queue.size, 0);
    assert.equal(h.held.size, 0);
    assert.equal(h.pool.waitingCount, 0);
    assert.deepEqual(h.releases, [false, false]);
  } finally {
    if (!h.held.size) await h.pool.end();
  }
});
