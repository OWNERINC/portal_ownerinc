import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const {
  canClaimImportIdentity, decideImportIdentity, parseCsv, validateRows,
} = require('./services/bulk-user-import');

test('bulk parser handles UTF-8 BOM and quoted commas without dependencies', () => {
  const rows = parseCsv('\uFEFFname,email,job_title,contract_type,pj_due_day,phone\n"José, Silva",jose@example.com,Analista,pj,15,+55 61 9999-9999');
  assert.deepEqual(rows[0], { name: 'José, Silva', email: 'jose@example.com', job_title: 'Analista', contract_type: 'pj', pj_due_day: '15', phone: '+55 61 9999-9999' });
});

test('bulk invitation panel provides a documented parseable CSV template', async () => {
  const [html, csv] = await Promise.all([
    readFile('public/admin.html', 'utf8'),
    readFile('public/modelo-convites-usuarios.csv', 'utf8'),
  ]);
  assert.match(html, /href="\.\/modelo-convites-usuarios\.csv"[^>]*download/);
  for (const guidance of ['name', 'email', 'job_title', 'contract_type', 'pj_due_day', 'phone', '500']) {
    assert.match(html, new RegExp(guidance));
  }
  assert.equal(csv.split(/\r?\n/, 1)[0], 'name,email,job_title,contract_type,pj_due_day,phone');
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.contract_type), ['clt', 'pj']);
});

test('bulk validation marks duplicates and inactive or unknown titles per row', () => {
  const titles = new Map([['analista', { id: 'title-1' }]]);
  const rows = validateRows([
    { name: 'A', email: 'a@example.com', job_title: 'Analista', contract_type: 'clt', pj_due_day: '', phone: '' },
    { name: 'B', email: 'a@example.com', job_title: 'Inativo', contract_type: 'clt', pj_due_day: '', phone: '' },
  ], titles, new Set());
  assert.equal(rows[0].status, 'ready');
  assert.deepEqual(rows[1].errors, ['duplicate_email', 'unknown_or_inactive_job_title']);
});

test('bulk validation normalizes every CLT day and rejects invalid PJ days consistently', () => {
  const titles = new Map([['analista', { id: 'title-1' }]]);
  const rows = validateRows([
    { name: 'CLT', email: 'clt@example.com', job_title: 'Analista', contract_type: 'clt', pj_due_day: 'not-a-day', phone: '' },
    { name: 'PJ', email: 'pj@example.com', job_title: 'Analista', contract_type: 'pj', pj_due_day: '32', phone: '' },
    { name: 'PJ ok', email: 'pj-ok@example.com', job_title: 'Analista', contract_type: 'pj', pj_due_day: '07', phone: '' },
  ], titles, new Set());
  assert.equal(rows[0].status, 'ready');
  assert.equal(rows[0].pj_due_day, '');
  assert.equal(rows[1].status, 'invalid');
  assert.deepEqual(rows[1].errors, ['pj_due_day']);
  assert.equal(rows[2].status, 'ready');
  assert.equal(rows[2].pj_due_day, '7');
});

test('bulk parser rejects malformed column counts and more than 500 users', () => {
  assert.throws(() => parseCsv('name,email,job_title,contract_type,pj_due_day,phone\na,b,c,clt,'), /exactly six columns/);
  const header = 'name,email,job_title,contract_type,pj_due_day,phone';
  assert.throws(() => parseCsv(`${header}\n${Array.from({ length: 501 }, (_, i) => `n${i},a${i}@x.com,t,clt,,`).join('\n')}`), /more than 500/);
});

test('bulk validation tolerates malformed confirmation rows and never accepts privileges', () => {
  const titles = new Map([['analista', { id: 'title-1' }]]);
  const rows = validateRows([null, { name: 'A', email: 'a@example.com', job_title: 'Analista', contract_type: 'clt', pj_due_day: '', role: 'admin', permissions: { superAdmin: true } }], titles);
  assert.equal(rows[0].status, 'invalid');
  assert.ok(rows[0].errors.includes('email'));
  assert.equal(rows[1].status, 'ready');
  assert.equal(rows[1].role, undefined);
  assert.equal(rows[1].permissions, undefined);
});

test('bulk jobs keep active rows queued and retry only completed jobs with eligible failures', async () => {
  const source = await readFile('api/routes/user-imports.js', 'utf8');
  assert.match(source, /loadExistingEmails/);
  assert.match(source, /uuid\(req\.params\.id\)/);
  assert.match(source, /j\.created_by=\$3/);
  assert.match(source, /created_by = \$3/);
  assert.match(source, /status\(410\)/);
  assert.match(source, /status !== 'completed'/);
  assert.match(source, /status IN \('pending', 'processing'\)/);
  assert.match(source, /status = 'failed' AND attempt_count < 3/);
  assert.match(source, /role: 'viewer'/);
  assert.match(source, /permissions: \{\}/);
});

test('import worker lock clauses put LIMIT before FOR UPDATE SKIP LOCKED', async () => {
  const source = await readFile('api/routes/user-imports.js', 'utf8');
  const query = source.match(/SELECT id FROM user_import_jobs[\s\S]*?FOR UPDATE SKIP LOCKED`\)/)?.[0] || '';
  assert.ok(query, 'worker query was not found');
  assert.ok(query.indexOf('ORDER BY created_at') < query.indexOf('LIMIT 1'));
  assert.ok(query.indexOf('LIMIT 1') < query.indexOf('FOR UPDATE SKIP LOCKED'));
  assert.doesNotMatch(query, /ORDER BY created_at\s+FOR UPDATE SKIP LOCKED\s+LIMIT/);
});

test('unresolved identity states stay processing and cannot consume an attempt', () => {
  const pending = decideImportIdentity({
    knownUid: 'uid-1',
    email: 'ana@example.com',
    pending: null,
    localUser: null,
    queuedCleanup: true,
    firebaseUser: { uid: 'uid-1', email: 'ana@example.com', disabled: true, emailVerified: true },
  });
  const registration = decideImportIdentity({
    knownUid: null,
    email: 'ana@example.com',
    pending: { firebase_uid: 'pending-1' },
    localUser: null,
    queuedCleanup: false,
    firebaseUser: null,
  });
  const indeterminate = decideImportIdentity({
    knownUid: 'uid-1',
    email: 'ana@example.com',
    pending: null,
    localUser: null,
    queuedCleanup: false,
    firebaseUser: { uid: 'uid-1', email: 'ana@example.com', disabled: false, emailVerified: true },
  });
  const reusable = decideImportIdentity({
    knownUid: 'uid-1',
    email: 'ana@example.com',
    pending: null,
    localUser: null,
    queuedCleanup: false,
    firebaseUser: { uid: 'uid-1', email: 'ana@example.com', disabled: true, emailVerified: true },
  });
  const missing = decideImportIdentity({
    knownUid: 'uid-1',
    email: 'ana@example.com',
    pending: null,
    localUser: null,
    queuedCleanup: false,
    firebaseUser: null,
  });

  assert.equal(pending.state, 'pending_cleanup');
  assert.equal(registration.state, 'pending_registration');
  assert.equal(indeterminate.state, 'indeterminate');
  assert.equal(canClaimImportIdentity(pending.state), false);
  assert.equal(canClaimImportIdentity(registration.state), false);
  assert.equal(canClaimImportIdentity(indeterminate.state), false);
  assert.equal(canClaimImportIdentity(reusable.state), true);
  assert.equal(canClaimImportIdentity(missing.state), true);
});

test('a local user without the import UID is always a duplicate', () => {
  const withoutUid = decideImportIdentity({
    knownUid: null,
    email: 'ana@example.com',
    pending: null,
    localUser: { uid: 'uid-1', email: 'ana@example.com' },
    queuedCleanup: false,
    firebaseUser: null,
  });
  const matchingUid = decideImportIdentity({
    knownUid: 'uid-1',
    email: 'ana@example.com',
    pending: null,
    localUser: { uid: 'uid-1', email: 'ana@example.com' },
    queuedCleanup: false,
    firebaseUser: null,
  });

  assert.deepEqual(withoutUid, { state: 'duplicate', uid: 'uid-1' });
  assert.deepEqual(matchingUid, { state: 'invited', uid: 'uid-1' });
});

test('import reconciliation locks before local references and the claim recheck gates attempts', async (t) => {
  const routePath = require.resolve('./routes/user-imports');
  const dbPath = require.resolve('./db');
  const authPath = require.resolve('./middleware/auth');
  const pendingPath = require.resolve('./services/pending-registration');
  const invitationPath = require.resolve('./services/user-invitation');
  const originals = new Map([
    [routePath, require.cache[routePath]],
    [dbPath, require.cache[dbPath]],
    [authPath, require.cache[authPath]],
    [pendingPath, require.cache[pendingPath]],
    [invitationPath, require.cache[invitationPath]],
  ]);
  const steps = [];
  let processMode = false;
  let failedUpdate = false;
  const firebaseAuth = {
    getUserByEmail: async () => { steps.push('firebase:lookup'); return { uid: 'uid-1', email: 'ana@example.com', disabled: true, emailVerified: true }; },
    getUser: async (uid) => {
      steps.push('firebase:lookup');
      return uid === 'uid-2' ? { uid, email: 'ambiguous@example.com', disabled: false, emailVerified: true } : null;
    },
  };
  const processClient = {
    query: async (sql) => {
      steps.push(sql);
      if (sql.startsWith('SELECT id FROM user_import_jobs')) return { rows: [{ id: 'job-1' }] };
      if (sql.startsWith('SELECT user_import_rows.*')) return {
        rows: [{ id: 'row-2', job_id: 'job-1', email: 'ambiguous@example.com', firebase_uid: 'uid-2', attempt_count: 3, status: 'processing' }],
      };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  };
  const pool = {
    connect: async () => {
      if (processMode) return processClient;
      return {
        query: async (sql) => {
          steps.push(sql);
          if (sql.includes('FROM pending_registrations')) return { rows: [] };
          if (sql.includes('FROM users')) return { rows: [] };
          if (sql.includes('FROM firebase_cleanup_queue')) return { rows: [] };
          if (sql.startsWith('UPDATE user_import_rows')) return { rowCount: 1 };
          return { rows: [], rowCount: 1 };
        },
        release() {},
      };
    },
    query: async (sql) => {
      if (sql.includes("SET status = 'failed'")) failedUpdate = true;
      if (sql.includes('UPDATE user_import_jobs') && sql.includes('RETURNING status')) return { rows: [{ status: 'queued' }] };
      return { rows: [], rowCount: 1 };
    },
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: { authMiddleware: (req, res, next) => next(), firebaseAuth },
  };
  require.cache[pendingPath] = {
    id: pendingPath,
    filename: pendingPath,
    loaded: true,
    exports: { expirePendingRegistrations: async () => ({ deleted: 0, failed: 0 }) },
  };
  delete require.cache[invitationPath];
  delete require.cache[routePath];
  const { claimImportRow, processPending, reconcileImportIdentity } = require(routePath);

  t.after(() => {
    for (const [path, original] of originals) {
      if (original) require.cache[path] = original;
      else delete require.cache[path];
    }
  });

  const reconciliation = await reconcileImportIdentity({
    pool,
    row: { id: 'row-1', email: 'ana@example.com', firebase_uid: null },
    requestId: 'request-id',
  });
  assert.deepEqual(reconciliation, { state: 'reusable', uid: 'uid-1' });
  const identityLock = steps.findIndex((step) => typeof step === 'string' && step.includes('pg_advisory_xact_lock'));
  const pendingRead = steps.findIndex((step) => typeof step === 'string' && step.includes('FROM pending_registrations'));
  const userRead = steps.findIndex((step) => typeof step === 'string' && step.includes('FROM users'));
  const firebaseLookup = steps.indexOf('firebase:lookup');
  assert.ok(identityLock >= 0 && identityLock < pendingRead && identityLock < userRead && identityLock < firebaseLookup);

  const queuedSteps = [];
  const queuedClient = {
    query: async (sql) => {
      queuedSteps.push(sql);
      if (sql.includes('FROM firebase_cleanup_queue')) return { rows: [{ firebase_uid: 'uid-1' }] };
      if (sql.includes('FROM pending_registrations') || sql.includes('FROM users')) return { rows: [] };
      return { rows: [], rowCount: 1 };
    },
  };
  const queued = await claimImportRow({ client: queuedClient, row: { id: 'row-1', email: 'ana@example.com', firebase_uid: 'uid-1' } });
  assert.deepEqual(queued, { state: 'pending_cleanup', uid: 'uid-1' });
  assert.equal(queuedSteps.some((step) => typeof step === 'string' && step.includes('attempt_count = attempt_count + 1')), false);

  processMode = true;
  const workerResult = await processPending('request-id');
  processMode = false;
  assert.equal(workerResult.status, 'queued');
  assert.equal(workerResult.failed, 0);
  assert.equal(failedUpdate, false);
});

test('worker restores a pending import row after an indeterminate identity claim', async (t) => {
  const routePath = require.resolve('./routes/user-imports');
  const dbPath = require.resolve('./db');
  const authPath = require.resolve('./middleware/auth');
  const pendingPath = require.resolve('./services/pending-registration');
  const invitationPath = require.resolve('./services/user-invitation');
  const originals = new Map([
    [routePath, require.cache[routePath]],
    [dbPath, require.cache[dbPath]],
    [authPath, require.cache[authPath]],
    [pendingPath, require.cache[pendingPath]],
    [invitationPath, require.cache[invitationPath]],
  ]);
  const events = [];
  const row = {
    id: 'row-1', job_id: 'job-1', row_number: 2, name: 'Ana Silva', email: 'ana@example.com',
    job_title: 'Analista', contract_type: 'clt', pj_due_day: null, phone: '',
    firebase_uid: null, attempt_count: 0, status: 'pending',
  };
  let connectionIndex = 0;
  const client = (name) => ({
    query: async (sql, params) => {
      events.push({ name, sql, params });
      if (sql === 'COMMIT' || sql === 'ROLLBACK' || sql === 'BEGIN') return { rows: [], rowCount: 1 };
      if (name === 'process' && sql.startsWith('SELECT id FROM user_import_jobs')) return { rows: [{ id: 'job-1' }] };
      if (name === 'process' && sql.startsWith('SELECT user_import_rows.*')) return { rows: [row] };
      if (sql.startsWith('SELECT id FROM job_titles') || sql.startsWith('SELECT 1 FROM job_titles')) return { rows: [{ id: 'title-1' }], rowCount: 1 };
      if (sql.includes('attempt_count = attempt_count + 1')) return { rows: [{ id: row.id, attempt_count: 1 }], rowCount: 1 };
      if (sql.includes('FROM users') || sql.includes('FROM firebase_cleanup_queue')) return { rows: [], rowCount: 0 };
      if (sql.startsWith('UPDATE user_import_rows')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release: (discard) => events.push({ name, release: discard }),
  });
  const processClient = client('process');
  const reconcileClient = client('reconcile');
  const claimClient = client('claim');
  const restoreClient = client('restore');
  const pool = {
    connect: async () => [processClient, reconcileClient, claimClient, restoreClient][connectionIndex++],
    query: async (sql, params) => {
      events.push({ name: 'pool', sql, params });
      if (sql.includes('UPDATE user_import_jobs') && sql.includes('RETURNING status')) return { rows: [{ status: 'queued' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };

  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: {
      authMiddleware: (req, res, next) => next(),
      firebaseAuth: { getUserByEmail: async () => null, getUser: async () => null },
    },
  };
  require.cache[pendingPath] = {
    id: pendingPath, filename: pendingPath, loaded: true,
    exports: { expirePendingRegistrations: async () => ({ deleted: 0, failed: 0 }) },
  };
  require.cache[invitationPath] = {
    id: invitationPath, filename: invitationPath, loaded: true,
    exports: {
      compensateCreatedInvitedUser: async () => {},
      createInvitedUser: async () => {
        const error = new Error('Firebase identity requires reconciliation.');
        error.code = 'FIREBASE_IDENTITY_INDETERMINATE';
        throw error;
      },
      enableActiveUser: async () => ({ state: 'active' }),
      lockPendingRegistrationIdentity: async (_client, { email, uid }) => ({ registration: null, email, uid }),
      processFirebaseCleanup: async () => ({ deleted: 0, failed: 0 }),
      reconcilePendingFirebaseEnables: async () => ({ resolved: 0, failed: 0 }),
    },
  };
  delete require.cache[routePath];
  const { processPending } = require(routePath);

  t.after(() => {
    for (const [path, original] of originals) {
      if (original) require.cache[path] = original;
      else delete require.cache[path];
    }
  });

  const result = await processPending('request-id');
  assert.deepEqual(result, { processed: 0, failed: 0, jobId: 'job-1', status: 'queued' });
  const claim = events.find((event) => event.name === 'claim' && event.sql.includes('attempt_count = attempt_count + 1'));
  const restore = events.find((event) => event.name === 'restore' && event.sql.includes('attempt_count = $4'));
  assert.ok(claim);
  assert.ok(restore);
  assert.deepEqual([restore.params[3], restore.params[5]], [0, 1]);
  assert.equal(events.some((event) => event.sql?.includes("SET status = 'failed'")), false);
});

test('ambiguous import reconciliation commit keeps the row processing and discards the connection', async (t) => {
  const routePath = require.resolve('./routes/user-imports');
  const dbPath = require.resolve('./db');
  const authPath = require.resolve('./middleware/auth');
  const pendingPath = require.resolve('./services/pending-registration');
  const invitationPath = require.resolve('./services/user-invitation');
  const originals = new Map([
    [routePath, require.cache[routePath]],
    [dbPath, require.cache[dbPath]],
    [authPath, require.cache[authPath]],
    [pendingPath, require.cache[pendingPath]],
    [invitationPath, require.cache[invitationPath]],
  ]);
  const clientQueries = [];
  const poolQueries = [];
  let released;
  const client = {
    query: async (sql) => {
      clientQueries.push(sql);
      if (sql === 'COMMIT') throw new Error('connection lost after commit');
      return { rows: [], rowCount: 1 };
    },
    release: (discard) => { released = discard; },
  };
  const pool = {
    connect: async () => client,
    query: async (sql, params) => {
      poolQueries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
  require.cache[authPath] = {
    id: authPath, filename: authPath, loaded: true,
    exports: {
      authMiddleware: (req, res, next) => next(),
      firebaseAuth: { getUserByEmail: async () => null, getUser: async () => null },
    },
  };
  require.cache[pendingPath] = {
    id: pendingPath, filename: pendingPath, loaded: true,
    exports: { expirePendingRegistrations: async () => ({ deleted: 0, failed: 0 }) },
  };
  require.cache[invitationPath] = {
    id: invitationPath, filename: invitationPath, loaded: true,
    exports: {
      lockPendingRegistrationIdentity: async (_client, { email, uid }) => ({ registration: null, email, uid }),
      createInvitedUser: async () => {},
      enableActiveUser: async () => ({ state: 'active' }),
      compensateCreatedInvitedUser: async () => {},
      processFirebaseCleanup: async () => ({ deleted: 0, failed: 0 }),
      reconcilePendingFirebaseEnables: async () => ({ resolved: 0, failed: 0 }),
    },
  };
  delete require.cache[routePath];
  const { reconcileImportIdentity } = require(routePath);

  t.after(() => {
    for (const [path, original] of originals) {
      if (original) require.cache[path] = original;
      else delete require.cache[path];
    }
  });

  const result = await reconcileImportIdentity({
    pool,
    row: { id: 'row-1', email: 'ana@example.com', firebase_uid: null },
    requestId: 'request-id',
  });
  assert.deepEqual(result, { state: 'indeterminate', uid: null });
  assert.equal(released, true);
  assert.ok(poolQueries.some(({ sql }) => sql.includes("status = 'processing'")));
  assert.equal(clientQueries.filter((sql) => sql === 'COMMIT').length, 1);
});

test('bulk job persistence is scoped to the authenticated administrator and clears expired jobs', async () => {
  const source = await readFile('public/js/admin.js', 'utf8');
  assert.match(source, /ownerinc-active-import-job:/);
  assert.match(source, /BULK_JOB_STORAGE_KEY_PREFIX\}\$\{me\.uid\}/);
  assert.match(source, /error\.status === 404 \|\| error\.status === 410/);
  assert.match(source, /pollBulkJob\(bulkJobId\)/);
});
