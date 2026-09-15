import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);

test('pending registration stores no password and sends a verification link', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const mailerPath = require.resolve('../../api/integrations/password-reset-email');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const originalAuth = require.cache[authPath];
  const mailer = require(mailerPath);
  const originalSendVerificationEmail = mailer.sendVerificationEmail;
  const calls = [];
  let created;
   let deleted;

  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
      createUser: async (data) => { created = data; return { uid: 'pending-uid' }; },
      generateEmailVerificationLink: async () => 'https://example.test/verify',
      deleteUser: async (uid) => { deleted = uid; },
    } },
  };
  mailer.sendVerificationEmail = async (message) => { calls.push(message); return {}; };
  delete require.cache[servicePath];
  const { createPendingRegistration, verificationSettings } = require(servicePath);
  const client = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
    return { rows: [] };
  } };

  t.after(() => {
    delete require.cache[servicePath];
    mailer.sendVerificationEmail = originalSendVerificationEmail;
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  const result = await createPendingRegistration({
    client,
    data: { name: 'Ana Silva', email: 'ana@example.com' },
  });

  assert.deepEqual(result, { uid: 'pending-uid' });
  assert.deepEqual(verificationSettings({ PORTAL_PUBLIC_URL: 'https://staging.example.test' }), { url: 'https://staging.example.test/login.html' });
  assert.throws(() => verificationSettings({ PORTAL_PUBLIC_URL: 'javascript:alert(1)' }), /invalid/i);
  assert.equal(created.disabled, true);
  assert.equal(created.emailVerified, false);
  assert.equal(typeof created.password, 'string');
  assert.equal(created.password.length, 64);
  assert.match(calls.find((call) => call?.sql?.includes('pending_registrations'))?.sql, /pending_registrations/);
  assert.equal(calls.find((call) => call?.to)?.to, 'ana@example.com');
  assert.equal(calls.find((call) => call?.to)?.link, 'https://example.test/verify');
  assert.equal(deleted, undefined);
  assert.doesNotMatch(JSON.stringify(calls.filter((call) => call?.to)), /secret-password/);
});

test('pending registration refuses a local duplicate before creating Firebase', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const mailerPath = require.resolve('../../api/integrations/password-reset-email');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const originalAuth = require.cache[authPath];
  const mailer = require(mailerPath);
  const originalSendVerificationEmail = mailer.sendVerificationEmail;
  let createCalls = 0;
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
      createUser: async () => { createCalls += 1; return { uid: 'unexpected' }; },
      generateEmailVerificationLink: async () => 'https://example.test/verify',
    } },
  };
  mailer.sendVerificationEmail = async () => {};
  delete require.cache[servicePath];
  const { createPendingRegistration } = require(servicePath);
  const client = {
    query: async (sql) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }], rowCount: 1 };
      if (sql.includes('FROM users')) return { rows: [{ uid: 'local-uid' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };

  t.after(() => {
    delete require.cache[servicePath];
    mailer.sendVerificationEmail = originalSendVerificationEmail;
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  await assert.rejects(
    createPendingRegistration({ client, data: { name: 'Ana Silva', email: 'ana@example.com' } }),
    (error) => error.code === 'REGISTRATION_ALREADY_EXISTS',
  );
  assert.equal(createCalls, 0);
});

test('first password link is sent only after email confirmation for a pending registration', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const mailerPath = require.resolve('../../api/integrations/password-reset-email');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const originalAuth = require.cache[authPath];
  const mailer = require(mailerPath);
  const originalSendRegistrationPassword = mailer.sendRegistrationPassword;
  const messages = [];

  require.cache[authPath] = {
     id: authPath, filename: authPath, loaded: true,
     exports: { firebaseAuth: {
       getUser: async () => ({ uid: 'pending-uid', email: 'ana@example.com', emailVerified: true, disabled: true }),
       getUserByEmail: async () => ({ uid: 'pending-uid', emailVerified: true, disabled: true }),
      generatePasswordResetLink: async () => 'https://example.test/first-password',
    } },
  };
  mailer.sendRegistrationPassword = async (message) => { messages.push(message); };
  delete require.cache[servicePath];
  const { requestPendingRegistrationPassword } = require(servicePath);
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.startsWith('SELECT id, firebase_uid')) return {
        rows: [{ id: 'registration-id', firebase_uid: 'pending-uid', email: 'ana@example.com', name: 'Ana Silva', status: 'pending', firebase_cleanup_pending: false }],
        rowCount: 1,
      };
      if (sql.includes('firebase_cleanup_queue')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = { connect: async () => client };

  t.after(() => {
    delete require.cache[servicePath];
    mailer.sendRegistrationPassword = originalSendRegistrationPassword;
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  assert.equal(await requestPendingRegistrationPassword({ pool, email: 'ana@example.com' }), true);
  assert.equal(messages[0].to, 'ana@example.com');
  assert.match(messages[0].link, /first-password/);
  assert.ok(queries.some(({ sql }) => sql.includes('status') && sql.includes('pending_registrations')));
});

test('registration side effects are capped before acquiring more database connections', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const originalAuth = require.cache[authPath];
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true, exports: { firebaseAuth: {} },
  };
  delete require.cache[servicePath];
  const { withRegistrationOperation } = require(servicePath);
  const releases = [];
  const held = Promise.all([1, 2].map(() => withRegistrationOperation(() => new Promise(resolve => releases.push(resolve)))));
  await new Promise(resolve => setImmediate(resolve));

  t.after(() => {
    delete require.cache[servicePath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  assert.equal(releases.length, 2);
  await assert.rejects(withRegistrationOperation(async () => {}), (error) => error.code === 'REGISTRATION_BUSY');
  releases.forEach(resolve => resolve());
  await held;
  await assert.doesNotReject(withRegistrationOperation(async () => {}));
});

test('duplicate registration recovers a disabled Firebase orphan even after verification', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const mailerPath = require.resolve('../../api/integrations/password-reset-email');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const originalAuth = require.cache[authPath];
  const mailer = require(mailerPath);
  const originalSendVerificationEmail = mailer.sendVerificationEmail;
  const calls = [];

  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
      getUserByEmail: async () => ({ uid: 'orphan-uid', disabled: true, emailVerified: true }),
      generateEmailVerificationLink: async () => 'https://example.test/recover',
    } },
  };
  mailer.sendVerificationEmail = async (message) => calls.push(message);
  delete require.cache[servicePath];
  const { recoverPendingRegistration } = require(servicePath);
  const query = async (sql) => {
    calls.push(sql);
    if (sql.startsWith('SELECT id, firebase_uid')) return { rows: [] };
    if (sql.startsWith('SELECT 1 FROM firebase_cleanup_queue')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('SELECT 1 FROM users')) return { rowCount: 0 };
    if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
    return { rows: [], rowCount: 1 };
  };
  const pool = { connect: async () => ({ query, release() {} }) };

  t.after(() => {
    delete require.cache[servicePath];
    mailer.sendVerificationEmail = originalSendVerificationEmail;
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  assert.equal(await recoverPendingRegistration({
    pool, data: { name: 'Ana Silva', email: 'ana@example.com' }, requestId: 'request-id',
  }), true);
  assert.ok(calls.some((sql) => typeof sql === 'string' && sql.includes('INSERT INTO pending_registrations')));
  assert.deepEqual(calls.find((call) => call?.to), { to: 'ana@example.com', name: 'Ana Silva', link: 'https://example.test/recover' });
  const pendingReads = calls.reduce((indexes, call, index) => {
    if (typeof call === 'string' && call.startsWith('SELECT id, firebase_uid')) indexes.push(index);
    return indexes;
  }, []);
  const emailLock = calls.findIndex((call) => typeof call === 'string' && call.includes('pg_advisory_xact_lock'));
  assert.equal(pendingReads.length, 1);
  assert.ok(emailLock < pendingReads[0]);
});

test('registration recovery refuses a local duplicate even when Firebase is missing', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const originalAuth = require.cache[authPath];
  let firebaseLookupCalls = 0;
  let createCalls = 0;
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
      getUserByEmail: async () => { firebaseLookupCalls += 1; return null; },
      createUser: async () => { createCalls += 1; return { uid: 'unexpected' }; },
    } },
  };
  delete require.cache[servicePath];
  const { recoverPendingRegistration } = require(servicePath);
  const client = {
    query: async (sql) => {
      if (sql.startsWith('SELECT id, firebase_uid')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('SELECT 1 FROM users')) return { rows: [{ uid: 'local-uid' }], rowCount: 1 };
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

  assert.equal(await recoverPendingRegistration({
    pool, data: { name: 'Ana Silva', email: 'ana@example.com' }, requestId: 'request-id',
  }), false);
  assert.equal(firebaseLookupCalls, 0);
  assert.equal(createCalls, 0);
});

test('ambiguous recovery commit never deletes the Firebase identity', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const mailerPath = require.resolve('../../api/integrations/password-reset-email');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const originalAuth = require.cache[authPath];
  const mailer = require(mailerPath);
  const originalSendVerificationEmail = mailer.sendVerificationEmail;
   let deleted;

  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
      getUserByEmail: async () => null,
      createUser: async () => ({ uid: 'ambiguous-uid' }),
      generateEmailVerificationLink: async () => 'https://example.test/recover',
      deleteUser: async (uid) => { deleted = uid; },
    } },
  };
  mailer.sendVerificationEmail = async () => {};
  delete require.cache[servicePath];
  const { recoverPendingRegistration } = require(servicePath);
  const pool = {
    query: async () => ({ rowCount: 1 }),
    connect: async () => ({
    async query(sql) {
      if (sql.startsWith('SELECT id, firebase_uid')) return { rows: [] };
      if (sql.startsWith('SELECT 1 FROM firebase_cleanup_queue')) return { rows: [], rowCount: 0 };
      if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
      if (sql === 'COMMIT') throw new Error('connection lost after commit');
      return { rows: [], rowCount: 1 };
    },
    release() {},
    }),
  };

  t.after(() => {
    delete require.cache[servicePath];
    mailer.sendVerificationEmail = originalSendVerificationEmail;
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  assert.equal(await recoverPendingRegistration({
    pool, data: { name: 'Ana Silva', email: 'ana@example.com' }, requestId: 'request-id',
  }), false);
  assert.equal(deleted, undefined);
});

test('pending registration returns its Firebase UID for post-rollback compensation', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const mailerPath = require.resolve('../../api/integrations/password-reset-email');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const originalAuth = require.cache[authPath];
  const mailer = require(mailerPath);
  const originalSendVerificationEmail = mailer.sendVerificationEmail;

  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
      createUser: async () => ({ uid: 'failed-pending-uid' }),
      generateEmailVerificationLink: async () => 'https://example.test/verify',
      deleteUser: async () => {},
    } },
  };
  mailer.sendVerificationEmail = async () => { throw new Error('smtp unavailable'); };
  delete require.cache[servicePath];
  const { createPendingRegistration } = require(servicePath);

  t.after(() => {
    delete require.cache[servicePath];
    mailer.sendVerificationEmail = originalSendVerificationEmail;
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  await assert.rejects(
    createPendingRegistration({
        client: { query: async () => ({ rows: [] }) },
        data: { name: 'Ana Silva', email: 'ana@example.com' },
    }),
    (error) => error.message === 'smtp unavailable' && error.firebaseUid === 'failed-pending-uid',
  );
});

test('failed Firebase compensation is deferred to the post-rollback queue', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const mailerPath = require.resolve('../../api/integrations/password-reset-email');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const originalAuth = require.cache[authPath];
  const mailer = require(mailerPath);
  const originalSendVerificationEmail = mailer.sendVerificationEmail;
  const queries = [];

  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
      createUser: async () => ({ uid: 'cleanup-pending-uid' }),
      generateEmailVerificationLink: async () => 'https://example.test/verify',
      deleteUser: async () => { throw new Error('Firebase unavailable'); },
      updateUser: async () => {},
    } },
  };
  mailer.sendVerificationEmail = async () => { throw new Error('smtp unavailable'); };
  delete require.cache[servicePath];
  const { createPendingRegistration } = require(servicePath);
  const client = { query: async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('COUNT(*)')) return { rows: [{ count: 0 }] };
    if (sql.includes('FROM users')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  } };

  t.after(() => {
    delete require.cache[servicePath];
    mailer.sendVerificationEmail = originalSendVerificationEmail;
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  await assert.rejects(createPendingRegistration({
    client, data: { name: 'Ana Silva', email: 'ana@example.com' }, requestId: 'request-id',
  }), (error) => error.firebaseUid === 'cleanup-pending-uid');
  assert.equal(queries.some(({ sql }) => sql.includes('firebase_cleanup_pending = TRUE')), false);
});

test('approval enables a viewer only after assigning an active job title', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const invitationPath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  const originalInvitation = require.cache[invitationPath];
  const firebaseCalls = [];

  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
      getUser: async () => ({ emailVerified: true }),
      updateUser: async (...args) => firebaseCalls.push(args),
    } },
  };
  delete require.cache[invitationPath];
  delete require.cache[servicePath];
  const { approvePendingRegistration } = require(servicePath);
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
       if (sql.startsWith('SELECT id, firebase_uid') || sql.startsWith('SELECT * FROM pending_registrations')) return { rows: [{ id: 'registration-id', firebase_uid: 'uid-1', email: 'ana@example.com', name: 'Ana Silva', status: 'pending', firebase_cleanup_pending: false }] };
       if (sql.startsWith('SELECT 1 FROM job_titles')) return { rowCount: 1 };
       if (sql.startsWith('SELECT 1 FROM users')) return { rowCount: 0 };
       if (sql.startsWith('SELECT uid, email, permissions') || sql.startsWith('SELECT uid, permissions')) return { rows: [{ uid: 'uid-1', email: 'ana@example.com', permissions: {}, firebase_enable_pending: true }] };
      return { rows: [], rowCount: 1 };
    },
  };

  t.after(() => {
    delete require.cache[servicePath];
    if (originalInvitation) require.cache[invitationPath] = originalInvitation;
    else delete require.cache[invitationPath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  assert.deepEqual(await approvePendingRegistration({
    client, id: 'registration-id', jobTitleId: 'job-title-id', contractType: 'clt', pjDueDay: null,
    reviewerUid: 'admin-uid', requestId: 'request-id',
  }), { status: 'approved', state: 'active' });
  assert.deepEqual(firebaseCalls, [['uid-1', { disabled: false }]]);
  const userInsert = queries.find(({ sql }) => sql.includes('INSERT INTO users'));
  assert.match(userInsert.sql, /'viewer'/);
   assert.deepEqual(userInsert.params.slice(3, 6), ['clt', false, null]);
   assert.match(userInsert.sql, /'\{\}'::jsonb/);
   assert.ok(queries.some(({ sql }) => sql.includes('registration.approve')));
   const rowLocks = queries.reduce((indexes, { sql }, index) => {
     if (sql.includes('FROM pending_registrations WHERE id = $1 FOR UPDATE')) indexes.push(index);
     return indexes;
   }, []);
   const identityLock = queries.findIndex(({ sql }) => sql.includes('pg_advisory_xact_lock'));
   assert.ok(rowLocks.length >= 2 && identityLock < rowLocks[0] && rowLocks[0] < rowLocks[1]);
});

test('approval refuses an unverified registration before enabling Firebase', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const originalAuth = require.cache[authPath];
  const firebaseCalls = [];

  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
      getUser: async () => ({ emailVerified: false }),
      updateUser: async (...args) => firebaseCalls.push(args),
    } },
  };
  delete require.cache[servicePath];
  const { approvePendingRegistration } = require(servicePath);
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(sql);
       if (sql.startsWith('SELECT id, firebase_uid') || sql.startsWith('SELECT * FROM pending_registrations')) return { rows: [{ id: 'registration-id', firebase_uid: 'uid-3', email: 'ana@example.com', name: 'Ana Silva', status: 'pending', firebase_cleanup_pending: false }] };
      if (sql.startsWith('SELECT 1 FROM job_titles')) return { rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  t.after(() => {
    delete require.cache[servicePath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  await assert.rejects(
     approvePendingRegistration({ client, id: 'registration-id', jobTitleId: 'job-title-id', contractType: 'clt', pjDueDay: null, reviewerUid: 'admin-uid', requestId: 'request-id' }),
    (error) => error.code === 'EMAIL_NOT_VERIFIED',
  );
  assert.equal(firebaseCalls.length, 0);
  assert.equal(queries.some((sql) => sql.includes('INSERT INTO users')), false);
});

test('ambiguous approval commit returns a reconcile state and discards the connection', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const originalAuth = require.cache[authPath];
  const firebaseCalls = [];
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
      getUser: async () => ({ emailVerified: true }),
      updateUser: async (...args) => firebaseCalls.push(args),
    } },
  };
  delete require.cache[servicePath];
  const { approvePendingRegistration } = require(servicePath);
  const client = {
    query: async (sql) => {
       if (sql.startsWith('SELECT id, firebase_uid') || sql.startsWith('SELECT * FROM pending_registrations')) return { rows: [{ id: 'registration-id', firebase_uid: 'uid-ambiguous', email: 'ana@example.com', name: 'Ana Silva', status: 'pending', firebase_cleanup_pending: false }] };
      if (sql.startsWith('SELECT 1 FROM job_titles')) return { rowCount: 1 };
      if (sql.startsWith('SELECT 1 FROM users')) return { rowCount: 0 };
      if (sql === 'COMMIT') throw new Error('connection lost after commit');
      return { rows: [], rowCount: 1 };
    },
  };
  t.after(() => {
    delete require.cache[servicePath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  const result = await approvePendingRegistration({
    client, id: 'registration-id', jobTitleId: 'job-title-id', contractType: 'clt', pjDueDay: null,
    reviewerUid: 'admin-uid', requestId: 'request-id',
  });
  assert.deepEqual(result, { status: 'approval_pending_reconcile', state: 'enable_pending' });
  assert.equal(result.discardClient, true);
  assert.deepEqual(firebaseCalls, []);
});

test('approval persists PJ contract and never accepts an invalid PJ day', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const invitationPath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  const originalInvitation = require.cache[invitationPath];
  const firebaseCalls = [];
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
      getUser: async () => ({ emailVerified: true }),
      updateUser: async (...args) => firebaseCalls.push(args),
    } },
  };
  delete require.cache[invitationPath];
  delete require.cache[servicePath];
  const { approvePendingRegistration } = require(servicePath);
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
       if (sql.startsWith('SELECT id, firebase_uid') || sql.startsWith('SELECT * FROM pending_registrations')) return { rows: [{ id: 'registration-id', firebase_uid: 'uid-pj', email: 'pj@example.com', name: 'PJ User', status: 'pending', firebase_cleanup_pending: false }] };
       if (sql.startsWith('SELECT 1 FROM job_titles')) return { rowCount: 1 };
       if (sql.startsWith('SELECT 1 FROM users')) return { rowCount: 0 };
       if (sql.startsWith('SELECT uid, email, permissions') || sql.startsWith('SELECT uid, permissions')) return { rows: [{ uid: 'uid-pj', email: 'pj@example.com', permissions: {}, firebase_enable_pending: true }] };
      return { rows: [], rowCount: 1 };
    },
  };

  t.after(() => {
    delete require.cache[servicePath];
    if (originalInvitation) require.cache[invitationPath] = originalInvitation;
    else delete require.cache[invitationPath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  await assert.rejects(
    approvePendingRegistration({ client, id: 'registration-id', jobTitleId: 'job-title-id', contractType: 'pj', pjDueDay: 32, reviewerUid: 'admin-uid', requestId: 'request-id' }),
    (error) => error.code === 'INVALID_CONTRACT',
  );
  assert.equal(queries.length, 0);
  assert.equal(firebaseCalls.length, 0);

  await approvePendingRegistration({ client, id: 'registration-id', jobTitleId: 'job-title-id', contractType: 'pj', pjDueDay: 15, reviewerUid: 'admin-uid', requestId: 'request-id' });
  const userInsert = queries.find(({ sql }) => sql.includes('INSERT INTO users'));
  assert.deepEqual(userInsert.params.slice(3, 6), ['pj', true, 15]);
  assert.deepEqual(firebaseCalls, [['uid-pj', { disabled: false }]]);
});

test('rejection preserves the disabled boundary and removes Firebase identity', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const invitationPath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  const originalInvitation = require.cache[invitationPath];
   let deleted;

  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
       getUser: async () => ({ email: 'ana@example.com' }),
      deleteUser: async (uid) => { deleted = uid; },
    } },
  };
  delete require.cache[invitationPath];
  delete require.cache[servicePath];
  const { rejectPendingRegistration } = require(servicePath);
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(sql);
       if (sql.includes('email, name') || sql.startsWith('SELECT * FROM pending_registrations')) return { rows: [{ id: 'registration-id', firebase_uid: 'uid-2', email: 'ana@example.com', name: 'Ana Silva', status: 'pending', firebase_cleanup_pending: false }] };
      if (sql.startsWith('SELECT 1 FROM users')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
  };
  const pool = { query: async () => ({ rows: [], rowCount: 1 }), connect: async () => client };

  t.after(() => {
    delete require.cache[servicePath];
    if (originalInvitation) require.cache[invitationPath] = originalInvitation;
    else delete require.cache[invitationPath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

   const rejectionResult = await rejectPendingRegistration({
     client, pool, id: 'registration-id', reviewerUid: 'admin-uid', reason: 'Não pertence à equipe', requestId: 'request-id',
   });
    assert.deepEqual(rejectionResult, { status: 'rejected', state: 'rejected' });
  assert.equal(deleted, 'uid-2');
  assert.ok(queries.some((sql) => sql.includes("status = 'rejected'")));
  assert.ok(queries.some((sql) => sql.includes('registration.reject')));
   const rowLocks = queries.reduce((indexes, sql, index) => {
     if (sql.includes('FROM pending_registrations WHERE id = $1 FOR UPDATE')) indexes.push(index);
     return indexes;
   }, []);
   const identityLock = queries.findIndex((sql) => sql.includes('pg_advisory_xact_lock'));
   assert.ok(rowLocks.length >= 2 && identityLock < rowLocks[0] && rowLocks[0] < rowLocks[1]);
});

test('rejection keeps the cleanup marker when Firebase deletion fails', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const invitationPath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  const originalInvitation = require.cache[invitationPath];
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
      getUser: async () => ({ email: 'ana@example.com' }),
      deleteUser: async () => { throw new Error('Firebase unavailable'); },
      updateUser: async () => {},
    } },
  };
  delete require.cache[invitationPath];
  delete require.cache[servicePath];
  const { rejectPendingRegistration } = require(servicePath);
  const queries = [];
  const client = {
    query: async (sql) => {
      queries.push(sql);
       if (sql.startsWith('SELECT id, firebase_uid') || sql.startsWith('SELECT * FROM pending_registrations')) return { rows: [{ id: 'registration-id', firebase_uid: 'uid-2', email: 'ana@example.com', name: 'Ana Silva', status: 'pending', firebase_cleanup_pending: false }] };
      if (sql.startsWith('SELECT 1 FROM users')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    },
  };
  const pool = { query: async () => ({ rows: [], rowCount: 1 }), connect: async () => client };

  t.after(() => {
    delete require.cache[servicePath];
    if (originalInvitation) require.cache[invitationPath] = originalInvitation;
    else delete require.cache[invitationPath];
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  assert.deepEqual(await rejectPendingRegistration({
     client, pool, id: 'registration-id', reviewerUid: 'admin-uid', reason: 'Não pertence à equipe', requestId: 'request-id',
   }), { status: 'rejected', state: 'cleanup_pending' });
  assert.ok(queries.some((sql) => sql.includes('firebase_cleanup_pending = TRUE')));
  assert.equal(queries.some((sql) => sql.startsWith('DELETE FROM pending_registrations')), false);
});

test('ambiguous rejection commit reconciles the marker and cleanup queue on a new connection', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const invitationPath = require.resolve('../../api/services/user-invitation');
  const originalAuth = require.cache[authPath];
  const originalInvitation = require.cache[invitationPath];
  const registration = {
    id: 'registration-id',
    firebase_uid: 'uid-ambiguous',
    email: 'ana@example.com',
    name: 'Ana Silva',
    status: 'pending',
    firebase_cleanup_pending: false,
  };
  let deleted = false;
  const originalQueries = [];
  const recoveryQueries = [];
  let originalRelease;
  let recoveryRelease;
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: { firebaseAuth: {
      getUser: async () => { deleted = true; throw new Error('cleanup must wait for reconciliation'); },
      deleteUser: async () => { deleted = true; },
    } },
  };
  delete require.cache[invitationPath];
  delete require.cache[servicePath];
  const { rejectPendingRegistration } = require(servicePath);
  const originalClient = {
    query: async (sql) => {
      originalQueries.push(sql);
      if (sql.startsWith('SELECT id, firebase_uid') || sql.startsWith('SELECT * FROM pending_registrations')) {
        return { rows: [registration], rowCount: 1 };
      }
      if (sql.startsWith('SELECT 1 FROM users')) return { rows: [], rowCount: 0 };
      if (sql === 'COMMIT') throw new Error('connection lost after commit');
      return { rows: [], rowCount: 1 };
    },
    release: (force) => { originalRelease = force; },
  };
  const recoveryClient = {
    query: async (sql) => {
      recoveryQueries.push(sql);
      if (sql.startsWith('SELECT id, firebase_uid') || sql.startsWith('SELECT * FROM pending_registrations')) {
        return { rows: [registration], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
    release: (force) => { recoveryRelease = force; },
  };
  const pool = {
    connect: async () => recoveryClient,
    query: async () => ({ rows: [], rowCount: 1 }),
  };

  t.after(() => {
    delete require.cache[servicePath];
    delete require.cache[invitationPath];
    if (originalInvitation) require.cache[invitationPath] = originalInvitation;
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  const result = await rejectPendingRegistration({
    client: originalClient,
    pool,
    id: 'registration-id',
    reviewerUid: 'admin-uid',
    reason: 'Não pertence à equipe',
    requestId: 'request-id',
  });
  assert.deepEqual(result, { status: 'rejection_pending_reconcile', state: 'cleanup_pending' });
  assert.equal(result.discardClient, true);
  assert.equal(originalRelease, undefined);
  assert.equal(recoveryRelease, undefined);
  assert.equal(deleted, false);
  assert.equal(originalQueries.some((sql) => sql.startsWith('DELETE FROM pending_registrations')), false);
  assert.ok(recoveryQueries.some((sql) => sql.includes('firebase_cleanup_pending = TRUE')));
  assert.ok(recoveryQueries.some((sql) => sql.includes('firebase_cleanup_queue')));
});

test('registration contracts exist in API and UI', async () => {
  const [auth, registrations, login, loginScript, admin, adminScript, migration, provision, service] = await Promise.all([
    readFile('api/routes/auth.js', 'utf8'),
    readFile('api/routes/registrations.js', 'utf8'),
    readFile('public/login.html', 'utf8'),
    readFile('public/js/login.js', 'utf8'),
    readFile('public/admin.html', 'utf8'),
    readFile('public/js/admin.js', 'utf8'),
    readFile('api/db/migrations/025_pending_registrations.sql', 'utf8'),
    readFile('api/db/provision.js', 'utf8'),
    readFile('api/services/pending-registration.js', 'utf8'),
  ]);
  assert.match(auth, /router\.post\('\/register'/);
  assert.match(auth, /registrationLimit/);
  assert.match(auth, /status\(202\)\.json\(registrationAccepted\)/);
  assert.match(auth, /status\(503\)\.json\(\{ error: 'Cadastro temporariamente indisponível\.'/);
  assert.match(auth, /withRegistrationOperation/);
  assert.match(auth, /withRegistrationOperation\(\(\) => requestPendingRegistrationPassword/);
  assert.match(auth, /error\.code === 'REGISTRATION_BUSY'/);
  assert.match(auth, /REGISTRATION_ALREADY_EXISTS/);
  assert.match(registrations, /router\.post\('\/:id\/approve'/);
  assert.match(registrations, /router\.post\('\/:id\/reject'/);
  assert.match(registrations, /manageUsers/);
  assert.match(login, /id="register-link"/);
  assert.match(login, /id="register-section"/);
  assert.match(login, /registration-password-section/);
  assert.match(login, /Primeiro acesso: criar senha/);
  assert.match(loginScript, /Se o cadastro puder ser processado/);
  assert.doesNotMatch(loginScript, /Enviamos um link para confirmar seu e-mail/);
  assert.doesNotMatch(login.match(/<form class="register-section"[\s\S]*?<\/form>/)?.[0] || '', /Esqueci minha senha/);
  assert.match(admin, /Solicitações de cadastro/);
  assert.match(adminScript, /result\?\.state === 'cleanup_pending'/);
  assert.match(adminScript, /Rejeição registrada; limpeza pendente/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS pending_registrations/);
  assert.match(provision, /ON pending_registrations TO portal_api/);
  assert.match(service, /recoverPendingRegistration/);
});

test('registration UI accepts only the exact 202 received contract', async () => {
  const login = await readFile('public/js/login.js', 'utf8');
  const register = login.slice(login.indexOf("registerSection.addEventListener('submit'"));
  assert.match(login, /response\.status !== 202/);
  assert.match(login, /body\.status !== 'accepted'/);
  assert.match(login, /body\.state !== 'received'/);
  assert.match(register, /await requireAcceptedRegistration\(response\)/);
  assert.doesNotMatch(register, /response\.ok/);
  assert.ok(register.indexOf('await requireAcceptedRegistration(response)') < register.indexOf('registerSection.reset()'));
});

test('retention keeps the row and identity locks while cleanup checks references', async (t) => {
  const authPath = require.resolve('../../api/middleware/auth');
  const invitationPath = require.resolve('../../api/services/user-invitation');
  const servicePath = require.resolve('../../api/services/pending-registration');
  const originalAuth = require.cache[authPath];
  const originalInvitation = require.cache[invitationPath];
  const steps = [];
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: { firebaseAuth: { getUser: async () => { steps.push('firebase:lookup'); return null; } } },
  };
  delete require.cache[invitationPath];
  delete require.cache[servicePath];
  const { expirePendingRegistrations } = require(servicePath);
  let rowRead = 0;
  const client = {
    query: async (sql) => {
      steps.push(sql);
       if (sql.includes('FROM pending_registrations WHERE id')) {
         rowRead += 1;
         return { rows: [{ id: 'registration-id', firebase_uid: 'uid-1', email: 'ana@example.com', name: 'Ana Silva', status: 'rejected', created_at: '2024-01-01T00:00:00.000Z', created_at_key: '2024-01-01T00:00:00.000Z' }] };
       }
       if (sql.startsWith('SELECT id, firebase_uid, email, status')) return { rows: [{ id: 'registration-id', firebase_uid: 'uid-1', email: 'ana@example.com', status: 'rejected', created_at_key: '2024-01-01T00:00:00.000Z' }] };
       if (sql.startsWith('SELECT id, firebase_uid, email, name')) return { rows: [{ id: 'registration-id', firebase_uid: 'uid-1', email: 'ana@example.com', name: 'Ana Silva', status: 'rejected', created_at: '2024-01-01T00:00:00.000Z' }] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = { connect: async () => client };

  t.after(() => {
    delete require.cache[servicePath];
    delete require.cache[invitationPath];
    if (originalInvitation) require.cache[invitationPath] = originalInvitation;
    if (originalAuth) require.cache[authPath] = originalAuth;
    else delete require.cache[authPath];
  });

  assert.deepEqual(await expirePendingRegistrations({ pool, retentionDays: 30, requestId: 'request-id' }), { deleted: 1, failed: 0 });
  assert.equal(rowRead, 2);
   const rowLocks = steps.reduce((indexes, step, index) => {
     if (typeof step === 'string' && step.includes('FROM pending_registrations WHERE id = $1 FOR UPDATE')) indexes.push(index);
     return indexes;
   }, []);
   const identityLock = steps.findIndex((step) => typeof step === 'string' && step.includes('pg_advisory_xact_lock'));
   const firebaseLookup = steps.indexOf('firebase:lookup');
   assert.ok(rowLocks.length >= 2 && identityLock < rowLocks[0] && rowLocks[0] < rowLocks[1]);
  assert.equal(steps.filter((step) => step === 'BEGIN').length, 1);
   assert.ok(rowLocks[1] < firebaseLookup);
});
