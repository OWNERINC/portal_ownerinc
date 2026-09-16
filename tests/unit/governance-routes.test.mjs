import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  boolean, httpUrl, integer, mayViewAll, oneOf, parseListQuery, targetUsers,
  text, uuid, validBody,
} = require('../../api/route-utils');

test('strict payload validation rejects unknown, missing, oversized, and malformed fields', () => {
  const schema = { title: text(10, true), active: boolean, order: integer(0, 10), channel: oneOf('email') };
  assert.equal(validBody({ title: 'Valid', active: true, order: 0, channel: 'email' }, schema, ['title']), true);
  assert.equal(validBody({ active: true }, schema, ['title']), false);
  assert.equal(validBody({ title: undefined }, schema, ['title']), false);
  assert.equal(validBody({ title: '           ' }, schema, ['title']), false);
  assert.equal(validBody({ title: 'Valid', surprise: true }, schema, ['title']), false);
  assert.equal(validBody({ title: 'Valid', active: 'true' }, schema, ['title']), false);
  assert.equal(httpUrl('javascript:alert(1)'), false);
  assert.equal(httpUrl('https://ownerinc.com'), true);
  assert.equal(uuid('e7fa4cd2-70f5-4d75-a77f-b17b5caedfa9'), true);
  assert.equal(targetUsers(['uid-1', 'uid-2']), true);
  assert.equal(targetUsers(['uid-1', 'uid-1']), false);
  assert.equal(targetUsers([1]), false);
});

test('pagination is capped and all-content visibility requires the matching manager permission', () => {
  assert.deepEqual(parseListQuery({}), { limit: 50, offset: 0 });
  assert.deepEqual(parseListQuery({ limit: '100', offset: '10' }), { limit: 100, offset: 10 });
  assert.equal(parseListQuery({ limit: '101' }), null);
  assert.equal(parseListQuery({ unknown: '1' }), null);
  assert.equal(mayViewAll({ role: 'viewer', permissions: { manageBenefits: true } }, 'manageBenefits', 'true'), false);
  assert.equal(mayViewAll({ role: 'admin', permissions: { manageBenefits: true } }, 'manageBenefits', 'true'), true);
  assert.equal(mayViewAll({ role: 'admin', permissions: { manageBenefits: true } }, 'manageBenefits', undefined), false);
});

test('scoped routes delegate failures and privileged changes to the audit helper', async () => {
  for (const name of ['knowledge', 'reminders', 'academy', 'benefits', 'job-titles']) {
    const source = await readFile(`api/routes/${name}.js`, 'utf8');
    assert.match(source, /next\(error\)/, `${name} must use generic error handling`);
  }
  for (const name of ['knowledge', 'reminders', 'academy', 'benefits', 'job-titles']) {
    const source = await readFile(`api/routes/${name}.js`, 'utf8');
    assert.match(source, /withAudit/, `${name} must audit privileged mutations`);
    assert.match(source, /X-Total-Count/, `${name} must expose pagination totals`);
  }
});

test('privileged user listing is strict, paginated, counted, and audited', async () => {
  const users = await readFile('api/routes/users.js', 'utf8');
  assert.match(users, /parseListQuery\(req\.query\)/);
  assert.match(users, /LIMIT \$1 OFFSET \$2/);
  assert.match(users, /X-Total-Count/);
  assert.match(users, /user\.list/);
  assert.match(users, /sendInvitation/);
  assert.doesNotMatch(users, /req\.body\.password/);
  for (const action of ['create', 'update', 'disable', 'reactivate']) assert.match(users, new RegExp(`user\\.${action}`));
  const jobTitles = await readFile('api/routes/job-titles.js', 'utf8');
  assert.match(jobTitles, /manageUsers/);
  assert.match(jobTitles, /job_title\.create/);
  assert.match(jobTitles, /job_title\.update/);
  assert.match(jobTitles, /active = TRUE/);
});

test('admin invitations expose actionable Firebase identity conflicts', async () => {
  const [users, admin] = await Promise.all([
    readFile('api/routes/users.js', 'utf8'),
    readFile('public/js/admin.js', 'utf8'),
  ]);
  assert.match(users, /FIREBASE_IDENTITY_REFERENCED/);
  assert.match(users, /FIREBASE_CLEANUP_PENDING/);
  assert.match(users, /FIREBASE_IDENTITY_INDETERMINATE/);
  assert.match(users, /reason: 'firebase_identity_referenced'/);
  assert.match(users, /reason: 'firebase_cleanup_pending'/);
  assert.match(users, /reason: 'firebase_identity_indeterminate'/);
  assert.match(admin, /firebase_identity_referenced/);
  assert.match(admin, /firebase_cleanup_pending/);
  assert.match(admin, /firebase_identity_indeterminate/);
});

test('user status commits reconcile through a new connection before Firebase compensation', async () => {
  const users = await readFile('api/routes/users.js', 'utf8');
  const reactivate = users.slice(users.indexOf("router.put('/:uid/reactivate'"), users.indexOf("router.put('/:uid'"));
  const disable = users.slice(users.indexOf("router.delete('/:uid',"));
  for (const route of [reactivate, disable]) {
    assert.match(route, /commitAttempted/);
    assert.match(route, /commitCompleted/);
    assert.match(route, /reconcileFirebaseAccountStatus/);
    assert.match(route, /failedClient\?\.release\(true\)/);
    assert.ok(route.indexOf('reconcileFirebaseAccountStatus') < route.indexOf('next(err)'));
  }
  assert.match(users, /SELECT permissions->>'accountDisabled' AS account_disabled/);
  assert.match(users, /lockFirebaseIdentity/);
  assert.match(reactivate, /firebase_enable_pending = FALSE/);
  const reconciliation = users.slice(users.indexOf('async function reconcileFirebaseAccountStatus'), users.indexOf('async function stageStoredPhoto'));
  assert.match(reconciliation, /pool\.connect\(\)/);
  assert.match(reconciliation, /FOR UPDATE/);
  assert.match(reconciliation, /firebaseAuth\.updateUser/);
  assert.ok(reconciliation.indexOf('lockFirebaseIdentity') < reconciliation.indexOf('firebaseAuth.updateUser'));
});

test('Firebase account reconciliation holds the row and identity locks through the external update', async (t) => {
  const routePath = require.resolve('../../api/routes/users');
  const dbPath = require.resolve('../../api/db');
  const authPath = require.resolve('../../api/middleware/auth');
  const invitationPath = require.resolve('../../api/services/user-invitation');
  const originals = new Map([
    [routePath, require.cache[routePath]],
    [dbPath, require.cache[dbPath]],
    [authPath, require.cache[authPath]],
    [invitationPath, require.cache[invitationPath]],
  ]);
  const steps = [];
  let failFirebase = false;
  const firebaseAuth = {
    updateUser: async () => {
      steps.push('firebase:update');
      if (failFirebase) throw new Error('Firebase unavailable');
    },
  };
  const clients = [];
  const makeClient = () => ({
    query: async (sql) => {
      steps.push(sql);
      if (sql.startsWith('SELECT email')) return { rows: [{ email: 'ana@example.com' }] };
      if (sql.startsWith('SELECT uid, email')) return { rows: [{ uid: 'uid-1', email: 'ana@example.com' }] };
      if (sql.startsWith('SELECT permissions')) return { rows: [{ account_disabled: 'true' }] };
      return { rows: [], rowCount: 1 };
    },
    release() {},
  });
  const pool = { connect: async () => { const client = makeClient(); clients.push(client); return client; } };
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: { authMiddleware: (req, res, next) => next(), firebaseAuth },
  };
  require.cache[invitationPath] = {
    id: invitationPath,
    filename: invitationPath,
    loaded: true,
    exports: {
      compensateCreatedInvitedUser: async () => {},
      createInvitedUser: async () => {},
      enableActiveUser: async () => ({ state: 'active' }),
      lockFirebaseIdentity: async (client, identity) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [identity.uid]);
      },
    },
  };
  delete require.cache[routePath];
  const { reconcileFirebaseAccountStatus } = require(routePath);

  t.after(() => {
    delete require.cache[routePath];
    for (const [path, original] of originals) {
      if (original) require.cache[path] = original;
      else delete require.cache[path];
    }
  });

  assert.equal(await reconcileFirebaseAccountStatus('uid-1', 'request-id'), true);
  const rowLock = steps.findIndex((step) => typeof step === 'string' && step.startsWith('SELECT uid, email'));
  const identityLock = steps.findIndex((step) => typeof step === 'string' && step.includes('pg_advisory_xact_lock'));
  const statusRead = steps.findIndex((step) => typeof step === 'string' && step.startsWith('SELECT permissions'));
  const firebaseUpdate = steps.indexOf('firebase:update');
  const commit = steps.indexOf('COMMIT');
  assert.ok(identityLock < rowLock && rowLock < statusRead && statusRead < firebaseUpdate && firebaseUpdate < commit);

  steps.length = 0;
  failFirebase = true;
  assert.equal(await reconcileFirebaseAccountStatus('uid-1', 'request-id'), false);
  assert.ok(steps.includes('ROLLBACK'));
});

test('public content routes provide server-side filters and category metadata', async () => {
  const [knowledge, academy, benefits] = await Promise.all([
    readFile('api/routes/knowledge.js', 'utf8'),
    readFile('api/routes/academy.js', 'utf8'),
    readFile('api/routes/benefits.js', 'utf8'),
  ]);
  assert.match(knowledge, /router\.get\('\/categories'/);
  assert.match(knowledge, /publishedBodyText/);
  assert.doesNotMatch(knowledge, /CMS_BODY_SQL/);
  assert.match(knowledge, /btrim\(knowledge_base\.category\) = \$\$\{values\.length\}/);
  assert.match(knowledge, /router\.get\('\/:id'/);
  assert.match(knowledge, /pdf_asset_id/);
  assert.match(knowledge, /syncKnowledgePdf/);
  assert.doesNotMatch(knowledge, /DELETE FROM cms_documents/);
  assert.match(academy, /router\.get\('\/categories'/);
  assert.match(academy, /btrim\(academy\.category\) = \$1/);
  assert.match(benefits, /router\.get\('\/categories'/);
  assert.match(benefits, /btrim\(benefits\.category\) = \$1/);
});
