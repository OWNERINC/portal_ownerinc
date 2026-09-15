import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('invitation audit persists only a sanitized SMTP acceptance correlation', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const mailerPath = require.resolve('../../api/integrations/password-reset-email');
  const servicePath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  const mailer = require(mailerPath);
  const originalSendInvitation = mailer.sendInvitation;

  const firebaseAuth = {
    createUser: async () => ({ uid: 'user-123' }),
    generatePasswordResetLink: async () => 'https://example.test/reset',
    updateUser: async () => {},
    deleteUser: async () => {},
  };
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.includes('FROM users')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO users')) return { rows: [{ uid: 'user-123' }], rowCount: 1 };
      return { rows: [{ uid: 'user-123' }] };
    },
  };
  const audits = [];

  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true, exports: { firebaseAuth },
  };
  mailer.sendInvitation = async () => ({
    messageId: '<portal-message@example.test>',
    response: '250 2.0.0 accepted by SMTP',
    accepted: ['recipient@example.test'],
    rejected: [],
  });
  delete require.cache[servicePath];
  const { createInvitedUser } = require(servicePath);

  t.after(() => {
    delete require.cache[servicePath];
    mailer.sendInvitation = originalSendInvitation;
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  const created = await createInvitedUser({
    client,
    data: { email: 'recipient@example.test', name: 'Recipient', contract_type: 'clt' },
    audit: async (action, targetId, details) => audits.push({ action, targetId, details }),
  });

  assert.deepEqual(created, { uid: 'user-123', invitation: { state: 'accepted_by_smtp' } });
   assert.equal(queries.length, 4);
   assert.match(queries[0], /hashtext\(\$1\)/);
   assert.match(queries[1], /FROM users/);
   assert.match(queries[2], /hashtext\(\$1\)/);
   assert.match(queries[3], /INSERT INTO users/);
  assert.deepEqual(audits, [{
    action: 'user.create',
    targetId: 'user-123',
    details: {
      role: 'viewer',
      invitation: {
        state: 'accepted_by_smtp',
        message_id: '<portal-message@example.test>',
        response_code: 250,
        accepted_count: 1,
        rejected_count: 0,
      },
    },
  }]);
  assert.doesNotMatch(JSON.stringify(audits), /recipient@example\.test|accepted by SMTP/);
});

test('admin UI does not represent SMTP acceptance as inbox delivery', async () => {
  const source = await readFile('public/js/admin.js', 'utf8');
  assert.match(source, /Convite encaminhado ao serviço de e-mail/);
  assert.match(source, /Confirme o recebimento na caixa de entrada/);
  assert.doesNotMatch(source, /Convite enviado para/);
});

test('local duplicate invitation is rejected before creating Firebase', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const mailerPath = require.resolve('../../api/integrations/password-reset-email');
  const servicePath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  const mailer = require(mailerPath);
  const originalSendInvitation = mailer.sendInvitation;
  let createCalls = 0;
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
      createUser: async () => { createCalls += 1; return { uid: 'unexpected' }; },
      generatePasswordResetLink: async () => 'https://example.test/reset',
    } },
  };
  mailer.sendInvitation = async () => ({ messageId: '<portal-message@example.test>', response: '250 2.0.0 accepted' });
  delete require.cache[servicePath];
  const { createInvitedUser } = require(servicePath);
  const client = {
    query: async (sql) => sql.includes('FROM users')
      ? { rows: [{ uid: 'local-uid' }], rowCount: 1 }
      : { rows: [], rowCount: 1 },
  };

  t.after(() => {
    delete require.cache[servicePath];
    mailer.sendInvitation = originalSendInvitation;
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  await assert.rejects(
    createInvitedUser({ client, data: { email: 'local@example.test', name: 'Local', contract_type: 'clt' } }),
    (error) => error.code === 'auth/email-already-exists'
      && error.importIdentityState === 'duplicate'
      && error.firebaseUid === 'local-uid',
  );
  assert.equal(createCalls, 0);
});

test('invitation reuses a disabled verified Firebase orphan after an interrupted commit', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const mailerPath = require.resolve('../../api/integrations/password-reset-email');
  const servicePath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  const mailer = require(mailerPath);
  const originalSendInvitation = mailer.sendInvitation;
  const firebaseAuth = {
    createUser: async () => { const error = new Error('exists'); error.code = 'auth/email-already-exists'; throw error; },
     getUserByEmail: async () => ({ uid: 'orphan-123', email: 'orphan@example.test', disabled: true, emailVerified: true }),
    generatePasswordResetLink: async () => 'https://example.test/reset',
  };
   const client = {
     query: async (sql) => {
       if (sql.includes('INSERT INTO users')) return { rows: [{ uid: 'orphan-123' }] };
       if (sql.includes('FROM users') || sql.includes('FROM pending_registrations') || sql.includes('firebase_cleanup_queue')) return { rows: [], rowCount: 0 };
       return { rows: [], rowCount: 1 };
     },
   };

  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { firebaseAuth } };
  mailer.sendInvitation = async () => ({ messageId: '<portal-message@example.test>', response: '250 2.0.0 accepted' });
  delete require.cache[servicePath];
  const { createInvitedUser } = require(servicePath);

  t.after(() => {
    delete require.cache[servicePath];
    mailer.sendInvitation = originalSendInvitation;
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  const created = await createInvitedUser({ client, data: { email: 'orphan@example.test', name: 'Orphan', contract_type: 'clt' } });
  assert.equal(created.uid, 'orphan-123');
  assert.equal(created.firebaseCreated, false);
});

test('ambiguous Firebase invitation marks a discovered non-reusable identity without deleting it', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  let deleted = false;
  let lookupMode = 'found';
  const firebaseAuth = {
    createUser: async () => { throw new Error('network response lost'); },
    getUserByEmail: async () => {
      if (lookupMode === 'fail') {
        const error = new Error('lookup unavailable');
        error.code = 'auth/network-request-failed';
        throw error;
      }
      return { uid: 'ambiguous-uid', email: 'ambiguous@example.test', disabled: false, emailVerified: true };
    },
    deleteUser: async () => { deleted = true; },
  };
  const client = { query: async () => ({ rows: [], rowCount: 0 }) };

  require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { firebaseAuth } };
  delete require.cache[servicePath];
  const { createInvitedUser } = require(servicePath);

  t.after(() => {
    delete require.cache[servicePath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  await assert.rejects(
    createInvitedUser({ client, data: { email: 'ambiguous@example.test', name: 'Ambiguous', contract_type: 'clt' } }),
    (error) => error.code === 'FIREBASE_IDENTITY_INDETERMINATE'
      && error.identityIndeterminate === true
      && error.firebaseIdentityState === 'indeterminate'
      && error.firebaseUid === 'ambiguous-uid',
  );
  assert.equal(deleted, false);

  lookupMode = 'fail';
  await assert.rejects(
    createInvitedUser({ client, data: { email: 'ambiguous@example.test', name: 'Ambiguous', contract_type: 'clt' } }),
    (error) => error.code === 'FIREBASE_IDENTITY_INDETERMINATE'
      && error.identityIndeterminate === true
      && error.firebaseUid === undefined,
  );
});

test('Firebase cleanup queue deletes identities and then removes its row', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  let deleted;
  const steps = [];
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
     exports: { firebaseAuth: {
       getUser: async (uid) => { steps.push('firebase:lookup'); return { uid, email: 'queued@example.test' }; },
       deleteUser: async (uid) => { steps.push('firebase:delete'); deleted = uid; },
     } },
  };
  delete require.cache[servicePath];
  const { processFirebaseCleanup } = require(servicePath);
  const client = {
    query: async (sql) => {
       steps.push(sql);
       if (sql.startsWith('SELECT firebase_uid')) return { rows: [{ firebase_uid: 'queued-uid' }] };
       return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = {
    connect: async () => client,
    query: async (sql) => sql.startsWith('SELECT EXISTS')
      ? { rows: [{ user_exists: false, registration_exists: false }] }
      : { rowCount: 1 },
  };

  t.after(() => {
    delete require.cache[servicePath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  assert.deepEqual(await processFirebaseCleanup({ pool, requestId: 'request-id' }), { deleted: 1, failed: 0 });
  assert.equal(deleted, 'queued-uid');
   const identityLock = steps.findIndex((step) => typeof step === 'string' && step.includes('pg_advisory_xact_lock'));
   const userReferences = steps.findIndex((step) => typeof step === 'string' && step.startsWith('SELECT uid, email FROM users'));
   const firebaseLookup = steps.indexOf('firebase:lookup');
   const pendingRowLocks = steps.filter((step) => typeof step === 'string' && step.includes('FROM pending_registrations WHERE id') && step.includes('FOR UPDATE'));
   assert.ok(identityLock >= 0 && identityLock < userReferences && identityLock < firebaseLookup);
   assert.ok(pendingRowLocks.every((step) => steps.indexOf(step) > identityLock));
});

test('Firebase cleanup keeps an identity referenced by a concurrent local operation', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  let deleted = false;
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
      getUser: async () => ({ email: 'referenced@example.test' }),
      deleteUser: async () => { deleted = true; },
    } },
  };
  delete require.cache[servicePath];
  const { processFirebaseCleanup } = require(servicePath);
  const client = {
    query: async (sql) => {
      if (sql.startsWith('SELECT firebase_uid')) return { rows: [{ firebase_uid: 'referenced-uid', reason: 'compensation' }] };
      if (sql.startsWith('SELECT uid, email FROM users')) return { rows: [{ uid: 'referenced-uid', email: 'referenced@example.test' }] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = { connect: async () => client, query: async () => ({ rowCount: 1 }) };

  t.after(() => {
    delete require.cache[servicePath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  assert.deepEqual(await processFirebaseCleanup({ pool, requestId: 'request-id' }), { deleted: 1, failed: 0 });
  assert.equal(deleted, false);
});

test('Firebase cleanup ignores another local UID that only shares the email', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  let deleted;
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
      getUser: async () => ({ uid: 'created-uid', email: 'same@example.test' }),
      deleteUser: async (uid) => { deleted = uid; },
    } },
  };
  delete require.cache[servicePath];
  const { cleanupFirebaseIdentity } = require(servicePath);
  const client = {
    query: async (sql) => {
      if (sql.startsWith('SELECT id, firebase_uid')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT uid, email FROM users')) return sql.includes('lower(email)')
        ? { rows: [{ uid: 'other-uid', email: 'same@example.test' }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
      if (sql.includes('FROM pending_registrations')) return { rows: [], rowCount: 0 };
      if (sql.includes('firebase_cleanup_queue')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = { connect: async () => client };

  t.after(() => {
    delete require.cache[servicePath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  assert.deepEqual(await cleanupFirebaseIdentity({
    pool, uid: 'created-uid', email: 'same@example.test', requestId: 'request-id',
  }), { state: 'deleted', queueRemoved: true });
  assert.equal(deleted, 'created-uid');
});

test('identity cleanup shares deterministic email and UID advisory locks', async () => {
  const [invitation, pending, users] = await Promise.all([
    readFile('api/services/user-invitation.js', 'utf8'),
    readFile('api/services/pending-registration.js', 'utf8'),
    readFile('api/routes/users.js', 'utf8'),
  ]);
  assert.match(invitation, /firebase-identity:/);
  assert.match(invitation, /email:\$\{String\(email\)/);
   assert.match(invitation, /uid:\$\{String\((?:uid|value)\)/);
  assert.match(invitation, /pending_registrations/);
  assert.match(pending, /lockFirebaseIdentity/);
  assert.match(users, /lockFirebaseIdentity/);
});

test('Firebase queue and reconciliation lock clauses put LIMIT before FOR UPDATE SKIP LOCKED', async () => {
  const source = await readFile('api/services/user-invitation.js', 'utf8');
  const clauses = [...source.matchAll(/ORDER BY created_at[\s\S]*?FOR UPDATE SKIP LOCKED/g)].map(([clause]) => clause);
  assert.equal(clauses.length, 2);
  clauses.forEach((clause) => {
    assert.ok(clause.indexOf('LIMIT') < clause.indexOf('FOR UPDATE SKIP LOCKED'));
    assert.doesNotMatch(clause, /FOR UPDATE SKIP LOCKED\s+LIMIT/);
  });
});

test('active Firebase enable is serialized with the local account decision', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  const firebaseCalls = [];
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: { updateUser: async (...args) => firebaseCalls.push(args) } },
  };
  delete require.cache[servicePath];
  const { enableActiveUser } = require(servicePath);
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(sql);
       if (sql.startsWith('SELECT uid, email, permissions')) return { rows: [{ uid: 'active-uid', email: 'active@example.test', permissions: {}, firebase_enable_pending: true }] };
      return { rows: [], rowCount: 1 };
    },
  };

  t.after(() => {
    delete require.cache[servicePath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

   assert.deepEqual(await enableActiveUser({ client, uid: 'active-uid', email: 'active@example.test', requestId: 'request-id' }), { state: 'active' });
   assert.deepEqual(firebaseCalls, [['active-uid', { disabled: false }]]);
   assert.ok(queries.indexOf('BEGIN') < queries.findIndex((sql) => sql.startsWith('SELECT uid, email, permissions')));
   assert.ok(queries.findIndex((sql) => sql.startsWith('SELECT uid, email, permissions')) < queries.findIndex((sql) => sql.startsWith('UPDATE users')));
});

test('active Firebase enable never reactivates a locally disabled account', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  const firebaseCalls = [];
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: { updateUser: async (...args) => firebaseCalls.push(args) } },
  };
  delete require.cache[servicePath];
  const { enableActiveUser } = require(servicePath);
  const client = {
     query: async (sql) => sql.startsWith('SELECT uid, email, permissions')
       ? { rows: [{ uid: 'disabled-uid', email: 'disabled@example.test', permissions: { accountDisabled: true }, firebase_enable_pending: true }] }
      : { rows: [], rowCount: 1 },
  };

  t.after(() => {
    delete require.cache[servicePath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

   assert.deepEqual(await enableActiveUser({ client, uid: 'disabled-uid', email: 'disabled@example.test', requestId: 'request-id' }), {
    state: 'enable_pending', skipped: true, reason: 'account_disabled',
  });
  assert.deepEqual(firebaseCalls, []);
});

test('ambiguous Firebase enable keeps the local pending marker and discards the connection', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  const firebaseCalls = [];
  const poolQueries = [];
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: { updateUser: async (...args) => firebaseCalls.push(args) } },
  };
  delete require.cache[servicePath];
  const { enableActiveUser } = require(servicePath);
  const client = {
    query: async (sql) => {
       if (sql.startsWith('SELECT uid, email, permissions')) return { rows: [{ uid: 'ambiguous-uid', email: 'ambiguous@example.test', permissions: {}, firebase_enable_pending: true }] };
      if (sql === 'COMMIT') throw new Error('connection lost after commit');
      return { rows: [], rowCount: 1 };
    },
  };
  const pool = { query: async (sql) => { poolQueries.push(sql); return { rowCount: 1 }; } };

  t.after(() => {
    delete require.cache[servicePath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

   const result = await enableActiveUser({ pool, client, uid: 'ambiguous-uid', email: 'ambiguous@example.test', requestId: 'request-id' });
  assert.equal(result.state, 'enable_pending');
  assert.equal(result.discardClient, true);
  assert.deepEqual(firebaseCalls, [
    ['ambiguous-uid', { disabled: false }],
    ['ambiguous-uid', { disabled: true }],
  ]);
  assert.ok(poolQueries.some((sql) => sql.includes('firebase_enable_pending = TRUE')));
});

test('Firebase enable reconciliation skips a locally disabled account', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  const updateCalls = [];
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: {
      firebaseAuth: {
        getUser: async () => { throw new Error('must not inspect disabled identity'); },
        updateUser: async (...args) => updateCalls.push(args),
      },
    },
  };
  delete require.cache[servicePath];
  const { reconcilePendingFirebaseEnables } = require(servicePath);
  const client = {
    query: async (sql) => {
       if (sql.startsWith('SELECT uid, email, permissions')) return { rows: [{ uid: 'disabled-uid', email: 'disabled@example.test', permissions: { accountDisabled: true } }] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = { connect: async () => client };

  t.after(() => {
    delete require.cache[servicePath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  assert.deepEqual(await reconcilePendingFirebaseEnables({ pool, requestId: 'request-id' }), { resolved: 0, failed: 0 });
  assert.deepEqual(updateCalls, []);
});

test('ambiguous Firebase enable reconciliation discards its transaction connection', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  const releaseArgs = [];
  const queries = [];
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: { updateUser: async () => {} } },
  };
  delete require.cache[servicePath];
  const { reconcilePendingFirebaseEnables } = require(servicePath);
  const client = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.startsWith('SELECT uid, email, permissions')) {
        return { rows: [{ uid: 'ambiguous-uid', email: 'ambiguous@example.test', permissions: {} }] };
      }
      if (sql === 'COMMIT') throw new Error('connection lost after commit');
      return { rows: [], rowCount: 1 };
    },
    release: (force) => releaseArgs.push(force),
  };
  const pool = { connect: async () => client };

  t.after(() => {
    delete require.cache[servicePath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  await assert.rejects(
    reconcilePendingFirebaseEnables({ pool, requestId: 'request-id' }),
    /connection lost after commit/,
  );
  assert.deepEqual(releaseArgs, [true]);
  assert.equal(queries.filter((sql) => sql === 'ROLLBACK').length, 0);
});
