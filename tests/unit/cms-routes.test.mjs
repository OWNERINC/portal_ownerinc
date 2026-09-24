import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
const Module = apiRequire('node:module');
const express = apiRequire('express');
const supertest = apiRequire('supertest');
const { withAudit } = require('../../api/route-utils');
const cms = await readFile('api/routes/cms.js', 'utf8');
const assets = await readFile('api/routes/cms-assets.js', 'utf8');
const index = await readFile('api/index.js', 'utf8');
const nginx = await readFile('nginx/nginx.conf', 'utf8');
const permissions = await readFile('api/cms/permissions.js', 'utf8');
const blocks = await readFile('api/cms/blocks.js', 'utf8');
const knowledge = await readFile('api/routes/knowledge.js', 'utf8');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Timed out waiting for the fake CMS asset transaction.');
}

function createAssetDeleteHarness({ finalizeFailures = 0 } = {}) {
  const reserveStart = assets.indexOf('async function reserveUnreferencedAsset');
  const readerStart = assets.indexOf('async function canReadAsset');
  const assetId = '11111111-1111-4111-8111-111111111111';
  const state = {
    asset: { id: assetId, storage_key: 'asset-1', deleting_at: null },
    reference: false,
    filePresent: true,
    deleted: false,
    finalizeFailures,
    lockOwner: null,
    lockWaiters: [],
    unlinkCalls: 0,
    writerPromise: null,
    unlinkGate: null,
  };

  function releaseLock(transaction) {
    if (state.lockOwner !== transaction) return;
    const next = state.lockWaiters.shift();
    if (next) {
      state.lockOwner = next.transaction;
      next.resolve();
    } else {
      state.lockOwner = null;
    }
  }

  function acquireLock(transaction) {
    if (!state.lockOwner || state.lockOwner === transaction) {
      state.lockOwner = transaction;
      return Promise.resolve();
    }
    return new Promise(resolve => state.lockWaiters.push({ transaction, resolve }));
  }

  function createClient() {
    const transaction = {};
    return {
      async query(sql, values = []) {
        if (sql === 'BEGIN') return { rows: [] };
        if (sql.includes('pg_advisory_xact_lock')) {
          await acquireLock(transaction);
          return { rows: [] };
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          releaseLock(transaction);
          return { rows: [] };
        }
        if (sql.startsWith('ROLLBACK TO SAVEPOINT') || sql.startsWith('RELEASE SAVEPOINT')) return { rows: [] };
        if (sql.includes('SELECT id, storage_key, deleting_at')) {
          return { rows: state.asset ? [{ ...state.asset }] : [] };
        }
        if (sql.includes('DELETE FROM cms_assets')) {
          if (state.finalizeFailures > 0) {
            state.finalizeFailures -= 1;
            throw new Error('simulated finalize failure');
          }
          if (state.reference || !state.asset?.deleting_at) return { rows: [] };
          const deleted = { id: state.asset.id };
          state.asset = null;
          state.deleted = true;
          return { rows: [deleted] };
        }
        if (sql.includes('SELECT 1') && sql.includes('jsonb_array_elements')) {
          return { rows: state.reference ? [{ present: 1 }] : [] };
        }
        if (sql.includes('SET deleting_at = NOW()')) {
          if (!state.asset || state.asset.deleting_at) return { rows: [] };
          state.asset.deleting_at = 'reserved';
          return { rows: [{ id: state.asset.id, storage_key: state.asset.storage_key }] };
        }
        if (sql.includes('SET deleting_at = NULL')) {
          if (state.asset) state.asset.deleting_at = null;
          return { rows: [] };
        }
        return { rows: [] };
      },
      release() {},
    };
  }

  const pool = { connect: async () => createClient() };
  const fileSystem = {
    async unlink(file) {
      state.unlinkCalls += 1;
      if (!state.filePresent) {
        const error = new Error('missing asset');
        error.code = 'ENOENT';
        throw error;
      }
      if (state.unlinkGate) await state.unlinkGate.promise;
      state.filePresent = false;
      if (state.onUnlink) state.onUnlink();
    },
  };
  const lockCmsAssets = db => db.query('SELECT pg_advisory_xact_lock($1)', [7193029]);
  const deleteUnreferencedAsset = new Function(
    'pool', 'fsp', 'path', 'privateDirectory', 'lockCmsAssets',
    `${assets.slice(reserveStart, readerStart)}\nreturn deleteUnreferencedAsset;`,
  )(pool, fileSystem, path, '/private/cms', lockCmsAssets);

  async function attemptReferenceWrite() {
    const db = await pool.connect();
    await db.query('BEGIN');
    await lockCmsAssets(db);
    const { rows } = await db.query(
      `SELECT id, storage_key, deleting_at
         FROM cms_assets
        WHERE id = $1
        FOR UPDATE`,
      [assetId],
    );
    if (!rows[0]) {
      await db.query('ROLLBACK');
      return false;
    }
    state.reference = true;
    await db.query('COMMIT');
    return true;
  }

  return {
    assetId,
    deleteUnreferencedAsset,
    fileSystem,
    request: { user: { uid: 'admin-1' }, id: 'request-1' },
    state,
    attemptReferenceWrite,
  };
}

function createAssetRouterSeam() {
  const assetId = '22222222-2222-4222-8222-222222222222';
  const state = {
    mode: 'deleted',
    connectCalls: 0,
    unlinkCalls: 0,
    auditCalls: 0,
  };
  const users = {
    'admin-1': {
      uid: 'admin-1', role: 'admin', permissions: { manageKnowledge: true },
    },
    'user-1': {
      uid: 'user-1', role: 'employee', permissions: {},
    },
  };
  const pool = {
    async query(sql, values = []) {
      if (sql.includes('FROM users u')) return { rows: users[values[0]] ? [{ ...users[values[0]] }] : [] };
      if (sql.includes('FROM pending_registrations')) return { rows: [] };
      return { rows: [] };
    },
    async connect() {
      state.connectCalls += 1;
      return {
        async query(sql) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK'
            || sql.startsWith('SAVEPOINT') || sql.startsWith('ROLLBACK TO') || sql.startsWith('RELEASE SAVEPOINT')
            || sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
          if (sql.includes('INSERT INTO audit_log')) {
            state.auditCalls += 1;
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('SELECT id, storage_key, deleting_at')) {
            if (state.mode === 'not_found') return { rows: [] };
            return {
              rows: [{
                id: assetId,
                storage_key: 'router-asset-1',
                deleting_at: state.mode === 'already_deleting' ? new Date().toISOString() : null,
              }],
            };
          }
          if (sql.includes('DELETE FROM cms_assets')) {
            if (state.mode === 'pending') throw new Error('simulated finalization failure');
            return { rows: [{ id: assetId }], rowCount: 1 };
          }
          if (sql.includes('SELECT 1') && sql.includes('jsonb_array_elements')) {
            return { rows: state.mode === 'referenced' ? [{ present: 1 }] : [], rowCount: state.mode === 'referenced' ? 1 : 0 };
          }
          if (sql.includes('SET deleting_at = NOW()')) return { rows: [{ id: assetId, storage_key: 'router-asset-1' }], rowCount: 1 };
          if (sql.includes('SET deleting_at = NULL')) return { rows: [], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        },
        release() {},
      };
    },
  };
  const fileSystem = {
    async unlink() {
      state.unlinkCalls += 1;
      if (state.mode === 'missing_file') {
        const error = new Error('missing asset');
        error.code = 'ENOENT';
        throw error;
      }
    },
  };
  const routePath = apiRequire.resolve('./routes/cms-assets');
  const authPath = apiRequire.resolve('./middleware/auth');
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (parent?.filename === routePath && request === '../db') return pool;
    if (parent?.filename === routePath && request === 'node:fs/promises') return fileSystem;
    if (parent?.filename === authPath && request === '../db') return pool;
    if (parent?.filename === authPath && request === 'firebase-admin/app') {
      return { cert: value => value, getApps: () => [], initializeApp() {} };
    }
    if (parent?.filename === authPath && request === 'firebase-admin/auth') {
      return {
        getAuth: () => ({
          async verifyIdToken(token) {
            if (token === 'allowed') return { uid: 'admin-1', email_verified: true };
            if (token === 'denied') return { uid: 'user-1', email_verified: true };
            throw new Error('invalid token');
          },
        }),
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let router;
  try {
    delete require.cache[routePath];
    delete require.cache[authPath];
    router = apiRequire('./routes/cms-assets');
  } finally {
    delete require.cache[routePath];
    delete require.cache[authPath];
    Module._load = originalLoad;
  }
  return { assetId, router, state };
}

test('CMS routes are authenticated and mounted at the required API boundaries', () => {
  assert.match(index, /app\.use\('\/api\/cms',\s+require\('\.\/routes\/cms'\)\)/);
  assert.match(index, /app\.use\('\/api\/cms\/assets',\s+require\('\.\/routes\/cms-assets'\)\)/);
  assert.ok((cms.match(/authMiddleware/g) || []).length >= 7);
  assert.match(assets, /router\.post\('\/', authMiddleware/);
  assert.match(assets, /router\.delete\('\/:id', authMiddleware/);
  assert.match(assets, /router\.get\('\/:id', authMiddleware/);
});

test('DELETE asset router runs through Express auth, permission, UUID, and cleanup responses', async () => {
  const seam = createAssetRouterSeam();
  const app = express();
  app.use((req, res, next) => { req.id = 'router-test-request'; next(); });
  app.use('/api/cms/assets', seam.router);
  const request = supertest(app);
  const endpoint = `/api/cms/assets/${seam.assetId}`;

  assert.equal((await request.delete(endpoint)).status, 401);
  assert.equal((await request.delete(endpoint).set('Authorization', 'Bearer denied')).status, 403);
  assert.equal((await request.delete('/api/cms/assets/not-an-asset').set('Authorization', 'Bearer allowed')).status, 400);

  seam.state.mode = 'referenced';
  assert.equal((await request.delete(endpoint).set('Authorization', 'Bearer allowed')).status, 409);

  seam.state.mode = 'pending';
  const pending = await request.delete(endpoint).set('Authorization', 'Bearer allowed');
  assert.equal(pending.status, 202);
  assert.equal(pending.body.reason, 'pending');

  seam.state.mode = 'deleted';
  assert.equal((await request.delete(endpoint).set('Authorization', 'Bearer allowed')).status, 204);
  assert.equal(seam.state.unlinkCalls, 2);
  assert.ok(seam.state.auditCalls >= 4);
});

test('document endpoints validate query and body contracts and use Task 1 permissions', () => {
  assert.match(cms, /parseListQuery\(req\.query/);
  assert.match(cms, /oneOf\(\.\.\.CONTENT_TYPES\)/);
  assert.match(cms, /source_id: \(sourceId\) => uuid\(sourceId\)/);
  assert.match(cms, /canManageCms\(req\.user, req\.body\.type\)/);
  assert.match(cms, /validateBlocks\(req\.body\.blocks\)/);
  assert.match(cms, /const types = manageableTypes\(user\)/);
  assert.match(permissions, /knowledge: 'manageKnowledge'/);
  assert.match(permissions, /announcement: 'manageKnowledge'/);
  assert.match(permissions, /academy: 'manageAcademy'/);
  assert.match(permissions, /benefit: 'manageBenefits'/);
  assert.match(permissions, /reminder: 'manageReminders'/);
  assert.match(cms, /router\.get\('\/documents\/:id\/revisions', authMiddleware/);
  assert.match(cms, /ORDER BY version DESC/);
  assert.match(cms, /X-Total-Count/);
});

test('document mutations are transactional, audited, and preserve revision immutability', () => {
  for (const action of ['cms.document.create', 'cms.revision.draft', 'cms.document.publish', 'cms.document.schedule', 'cms.document.unpublish', 'cms.document.unschedule', 'cms.revision.delete']) {
    assert.match(cms, new RegExp(`withAudit\\(pool, req, '${action}'`), action);
  }
  assert.match(cms, /SELECT COALESCE\(MAX\(version\), 0\) \+ 1/);
  assert.match(cms, /INSERT INTO cms_revisions/);
  assert.match(cms, /UPDATE cms_revisions SET status = 'archived'/);
  assert.match(cms, /UPDATE cms_revisions SET status = 'published'/);
  assert.match(cms, /UPDATE cms_revisions SET status = 'scheduled'/);
  assert.doesNotMatch(cms, /UPDATE cms_revisions SET blocks/);
  assert.match(cms, /FOR UPDATE/);
  assert.match(cms, /scheduled_at: futureIso/);
  assert.match(cms, /timestamp > Date\.now\(\)/);
  assert.match(cms, /revision\.status !== 'draft'/);
  assert.match(cms, /status = 'draft' RETURNING id, document_id/);
  assert.match(cms, /router\.delete\('\/documents\/:id\/schedule', authMiddleware/);
  assert.match(cms, /cms\.document\.unschedule/);
  assert.match(cms, /const body = req\.body === undefined \? \{\} : req\.body/);
  assert.match(cms, /resolveDraftRevisionId\(document, body\.revision_id\)/);
  assert.match(cms, /UPDATE cms_revisions SET status = 'draft'/);
  assert.match(cms, /validateAssetReferences\(db, blocks\)/);
  assert.match(cms, /FROM cms_assets[\s\S]*storage_key IS NOT NULL[\s\S]*byte_size BETWEEN/);
  assert.match(cms, /ASSET_MIMES\[type\]\.has\(asset\.mime_type\)/);
});

test('CMS draft saves share the asset-retention advisory lock', () => {
  assert.match(cms, /CMS_ASSET_RETENTION_LOCK = 7193029/);
  assert.match(cms, /pg_advisory_xact_lock\(\$1\)/);
});

test('CMS revision history returns metadata without replaying block payloads', () => {
  const historyQuery = cms.match(/SELECT id, document_id, version, status, created_by, created_at[\s\S]*?ORDER BY version DESC/);
  assert.ok(historyQuery);
  assert.doesNotMatch(historyQuery[0], /blocks/);
});

test('CMS revision history binds limit before offset', () => {
  assert.match(cms, /const limitIndex = values\.length \+ 1;\s+const offsetIndex = values\.length \+ 2;/);
  assert.match(cms, /LIMIT \$\$\{limitIndex\} OFFSET \$\$\{offsetIndex\}[\s\S]*\[\.\.\.values, page\.limit, page\.offset\]/);
});

test('protected assets validate signatures, use UUID storage keys, audit uploads, and hide filesystem paths', () => {
  assert.match(assets, /multer\.memoryStorage\(\)/);
  assert.match(assets, /MAX_ASSET_SIZE = 50 \* 1024 \* 1024/);
  assert.match(assets, /MAX_PDF_SIZE = 100 \* 1024 \* 1024/);
  assert.match(assets, /fileSize: MAX_PDF_SIZE/);
  assert.match(assets, /detectedMime\(req\.file\.buffer\)/);
  assert.match(assets, /mimeType !== req\.file\.mimetype/);
  assert.match(assets, /mimeType === 'application\/pdf' \? MAX_PDF_SIZE : MAX_ASSET_SIZE/);
  assert.match(assets, /req\.file\.size > maxSize[\s\S]*status\(413\)/);
  assert.match(assets, /crypto\.randomUUID\(\)/);
  assert.match(assets, /withAudit\(pool, req, 'cms\.asset\.upload'/);
  assert.match(assets, /canReadAsset\(db, req\.user, asset\)/);
  assert.match(assets, /lockCmsAssets\(db\)/);
  assert.match(assets, /fsp\.open\(path\.join\(privateDirectory, asset\.storage_key\), 'r'\)/);
  assert.match(assets, /file\.createReadStream\(\)/);
  assert.match(assets, /LIMIT_FILE_SIZE/);
  assert.match(assets, /status\(413\)/);
  assert.match(assets, /LIMIT_UNEXPECTED_FILE/);
  assert.match(assets, /LIMIT_FILE_COUNT/);
  assert.match(assets, /Unexpected end of form/);
  assert.match(assets, /isMalformedMultipart/);
  assert.match(assets, /instanceof multer\.MulterError/);
  assert.doesNotMatch(assets, /json\([^\n]*storage_key/);
  assert.doesNotMatch(assets, /res\.json\([^\n]*uploadDirectory/);
  assert.match(assets, /CROSS JOIN LATERAL jsonb_array_elements\(r\.blocks\)/);
  assert.match(assets, /r\.status IN \('draft', 'published', 'scheduled'\)/);
  assert.match(assets, /published_revision_id === row\.revision_id/);
  assert.match(assets, /academy_active === true/);
  assert.match(assets, /benefit_active === true/);
  assert.match(assets, /reminderIsVisible\(row, user\)/);
  assert.doesNotMatch(assets, /asset\.uploaded_by === user\.uid/);
  const uploadStart = assets.indexOf('function uploadMiddleware');
  const authCheck = assets.indexOf('if (!manageable(req.user)) return forbidden(req, res);', uploadStart);
  const parserCall = assets.indexOf("upload.single('asset')", uploadStart);
  assert.ok(uploadStart >= 0 && authCheck >= 0 && authCheck < parserCall);
  assert.match(assets, /fieldNameSize: 100/);
  assert.match(assets, /fieldSize: 1024/);
  assert.match(assets, /fields: 0/);
  assert.match(assets, /parts: 2/);
  assert.doesNotMatch(assets, /headerPairs/);
  assert.match(index, /uploads\/cms-private/);
});

test('asset cleanup is authenticated, audited, locked, reference-safe, and resumable', () => {
  assert.match(assets, /cms\.asset\.delete\.reserve/);
  assert.match(assets, /cms\.asset\.delete\.finalize/);
  assert.match(assets, /reserveUnreferencedAsset/);
  assert.match(assets, /finalizeUnreferencedAsset/);
  assert.match(assets, /router\.delete\('\/:id', authMiddleware/);
  assert.match(assets, /if \(!manageable\(req\.user\)\) return forbidden\(req, res\);/);
  assert.match(assets, /SET deleting_at = NOW\(\)/);
  assert.match(assets, /UPDATE cms_assets SET deleting_at = NULL/);
  assert.match(assets, /CROSS JOIN LATERAL jsonb_array_elements\(r\.blocks\)/);
  assert.match(assets, /lower\(block->>'asset_id'\) = lower\(\$1::text\)/);
  assert.equal((assets.match(/lower\(block->>'asset_id'\) = lower\(\$1::text\)/g) || []).length, 4);
  assert.match(assets, /Asset is still referenced by CMS content/);
  assert.match(assets, /status: 404, body: \{ error: 'Asset not found\.'/);
  assert.match(assets, /status: 409, body: \{ error: 'Asset is still referenced/);
  assert.match(assets, /reason: 'not_found'/);
  assert.match(assets, /reason: 'referenced'/);
  assert.match(assets, /reason: 'already_deleting'/);
  assert.match(assets, /status: 204/);
  assert.match(assets, /status: 202, body: \{ error: 'Asset cleanup is pending\.'/);
  assert.match(assets, /reason: 'pending'/);
  assert.match(assets, /return reservationIsActive\(asset\.deleting_at\) \? \{ asset, deleting: true \} : \{ asset, retry: true \}/);
  assert.match(assets, /return reserved\[0\] \? \{ asset: reserved\[0\] \} : \{ asset, deleting: true \}/);
  assert.match(assets, /if \(deleted\?\.referenced\)/);
  assert.match(assets, /UPDATE cms_assets SET deleting_at = NULL WHERE id = \$1 AND deleting_at IS NOT NULL/);
  assert.match(assets, /path\.basename\(storageKey\) !== storageKey/);
  assert.match(assets, /fileSystem\.unlink\(path\.join\(directory, storageKey\)\)/);
  assert.match(assets, /error\.code === 'ENOENT'/);
  const deleteStart = assets.indexOf('async function deleteUnreferencedAsset');
  const lock = assets.indexOf('await lockCmsAssets(client)', deleteStart);
  const unlink = assets.indexOf('await fileSystem.unlink(path.join(directory, storageKey))', deleteStart);
  const finalize = assets.indexOf('finalizeUnreferencedAsset(client, assetId', unlink);
  const pending = assets.indexOf("status: 202, body: { error: 'Asset cleanup is pending.'", finalize);
  assert.ok(deleteStart >= 0 && lock >= 0 && unlink > lock && finalize > unlink && pending > finalize);
  assert.equal(assets.indexOf('clearAssetDeleteReservation', pending), -1);
});

test('DELETE asset helpers reserve only unreferenced rows and finalize with a second reference check', async () => {
  const reserveStart = assets.indexOf('async function reserveUnreferencedAsset');
  const finalizeStart = assets.indexOf('async function finalizeUnreferencedAsset');
  const auditStart = assets.indexOf('async function auditAssetAction', finalizeStart);
  const helpers = new Function('lockCmsAssets', `${assets.slice(reserveStart, finalizeStart)}\n${assets.slice(finalizeStart, auditStart)}\nreturn { reserveUnreferencedAsset, finalizeUnreferencedAsset };`)(
    async db => { db.lockCount += 1; },
  );
  const asset = { id: '11111111-1111-4111-8111-111111111111', storage_key: 'asset-1', deleting_at: null };
  const queries = [];
  const db = {
    lockCount: 0,
    referenced: false,
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes('SELECT id, storage_key, deleting_at')) return { rows: [asset] };
      if (sql.includes('DELETE FROM cms_assets')) return { rows: this.referenced ? [] : [{ id: asset.id }] };
      if (sql.includes('SELECT 1') && sql.includes('jsonb_array_elements')) return { rows: this.referenced ? [{ present: 1 }] : [] };
      if (sql.includes('SET deleting_at = NOW()')) return { rows: [asset] };
      return { rows: [] };
    },
  };

  assert.deepEqual(await helpers.reserveUnreferencedAsset(db, asset.id), { asset });
  assert.equal(db.lockCount, 1);
  assert.ok(queries.some(({ sql }) => sql.includes('CROSS JOIN LATERAL jsonb_array_elements')));
  assert.deepEqual(await helpers.finalizeUnreferencedAsset(db, asset.id), { id: asset.id });
  assert.equal(db.lockCount, 2);
  assert.match(queries.at(-1).sql, /NOT EXISTS/);
  assert.match(queries.at(-1).sql, /lower\(block->>'asset_id'\) = lower\(\$1::text\)/);

  asset.deleting_at = 'marked';
  db.referenced = true;
  queries.length = 0;
  assert.deepEqual(await helpers.finalizeUnreferencedAsset(db, asset.id), { referenced: true });
  assert.ok(queries.some(({ sql }) => sql.includes('SET deleting_at = NULL')));
  asset.deleting_at = null;

  db.referenced = true;
  queries.length = 0;
  assert.deepEqual(await helpers.reserveUnreferencedAsset(db, asset.id), { referenced: true, cleared: false });
  assert.equal(queries.some(({ sql }) => sql.includes('SET deleting_at = NOW()')), false);
});

test('DELETE asset retry reuses a failed reservation and clears it when an uppercase reference appears', async () => {
  const reserveStart = assets.indexOf('async function reserveUnreferencedAsset');
  const finalizeStart = assets.indexOf('async function finalizeUnreferencedAsset');
  const auditStart = assets.indexOf('async function auditAssetAction', finalizeStart);
  const helpers = new Function('lockCmsAssets', `${assets.slice(reserveStart, finalizeStart)}
${assets.slice(finalizeStart, auditStart)}
return { reserveUnreferencedAsset, finalizeUnreferencedAsset };`)(
    async db => { db.lockCount += 1; },
  );
  const assetId = '11111111-1111-4111-8111-111111111111';
  const asset = { id: assetId, storage_key: 'asset-1', deleting_at: null };
  const queries = [];
  const db = {
    lockCount: 0,
    reference: null,
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes('SELECT id, storage_key, deleting_at')) return { rows: [{ ...asset }] };
      if (sql.includes('DELETE FROM cms_assets')) return { rows: [{ id: asset.id }] };
      if (sql.includes('SELECT 1') && sql.includes('jsonb_array_elements')) {
        return { rows: this.reference && this.reference.toLowerCase() === String(values[0]).toLowerCase() ? [{ present: 1 }] : [] };
      }
      if (sql.includes('SET deleting_at = NOW()')) {
        asset.deleting_at = 'marked';
        return { rows: [{ id: asset.id, storage_key: asset.storage_key }] };
      }
      if (sql.includes('SET deleting_at = NULL')) {
        asset.deleting_at = null;
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  assert.equal((await helpers.reserveUnreferencedAsset(db, assetId)).retry, undefined);
  assert.equal(asset.deleting_at, 'marked');
  const retry = await helpers.reserveUnreferencedAsset(db, assetId);
  assert.equal(retry.retry, true);
  assert.equal(retry.asset.storage_key, 'asset-1');
  assert.equal(queries.some(({ sql }) => sql.includes('SET deleting_at = NOW()')), true);
  assert.deepEqual(await helpers.finalizeUnreferencedAsset(db, assetId), { id: asset.id });

  asset.deleting_at = 'marked';
  queries.length = 0;
  db.reference = assetId.toUpperCase();
  const referenced = await helpers.reserveUnreferencedAsset(db, assetId.toUpperCase());
  assert.deepEqual(referenced, { referenced: true, cleared: true });
  assert.equal(asset.deleting_at, null);
  assert.equal(queries.some(({ sql }) => sql.includes('DELETE FROM cms_assets')), false);
});

test('DELETE asset reservation exposes contention separately from a retryable marker', async () => {
  const reserveStart = assets.indexOf('async function reserveUnreferencedAsset');
  const finalizeStart = assets.indexOf('async function finalizeUnreferencedAsset');
  const reserve = new Function('lockCmsAssets', `${assets.slice(reserveStart, finalizeStart)}\nreturn reserveUnreferencedAsset;`)(
    async () => {},
  );
  const asset = { id: '11111111-1111-4111-8111-111111111111', storage_key: 'asset-1', deleting_at: null };
  const db = {
    async query(sql) {
      if (sql.includes('SELECT id, storage_key, deleting_at')) return { rows: [asset] };
      if (sql.includes('SELECT 1') && sql.includes('jsonb_array_elements')) return { rows: [] };
      if (sql.includes('SET deleting_at = NOW()')) return { rows: [] };
      return { rows: [] };
    },
  };
  assert.deepEqual(await reserve(db, asset.id), { asset, deleting: true });
  asset.deleting_at = new Date(Date.now() - 61 * 1000).toISOString();
  assert.deepEqual(await reserve(db, asset.id), { asset, retry: true });
});

test('DELETE asset serialization preserves a reference that wins the race and rejects a late writer', async () => {
  const preserved = createAssetDeleteHarness();
  assert.equal(await preserved.attemptReferenceWrite(), true);
  const preservedResult = await preserved.deleteUnreferencedAsset(preserved.request, preserved.assetId);
  assert.equal(preservedResult.status, 409);
  assert.equal(preserved.state.unlinkCalls, 0);
  assert.equal(preserved.state.filePresent, true);

  const racing = createAssetDeleteHarness();
  racing.state.onUnlink = () => { racing.state.writerPromise = racing.attemptReferenceWrite(); };
  const result = await racing.deleteUnreferencedAsset(racing.request, racing.assetId);
  assert.equal(result.status, 204);
  assert.equal(await racing.state.writerPromise, false);
  assert.equal(racing.state.reference, false);
  assert.equal(racing.state.filePresent, false);
  assert.equal(racing.state.deleted, true);
});

test('DELETE asset contention gives one caller ownership and prevents duplicate unlink work', async () => {
  const harness = createAssetDeleteHarness();
  harness.state.unlinkGate = deferred();
  const first = harness.deleteUnreferencedAsset(harness.request, harness.assetId);
  await waitFor(() => harness.state.unlinkCalls === 1);

  const second = harness.deleteUnreferencedAsset(harness.request, harness.assetId);
  await waitFor(() => harness.state.lockWaiters.length === 1);
  harness.state.unlinkGate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.status, 204);
  assert.equal(secondResult.status, 404);
  assert.equal(harness.state.unlinkCalls, 1);
  assert.doesNotMatch(JSON.stringify(secondResult), /already_deleting/);
});

test('DELETE asset finalization failure remains retryable after the file is gone', async () => {
  const harness = createAssetDeleteHarness({ finalizeFailures: 1 });
  const firstResult = await harness.deleteUnreferencedAsset(harness.request, harness.assetId);

  assert.equal(firstResult.status, 202);
  assert.equal(firstResult.body.reason, 'pending');
  assert.equal(harness.state.asset.deleting_at, null);
  assert.equal(harness.state.deleted, false);
  assert.equal(harness.state.filePresent, false);

  const retryResult = await harness.deleteUnreferencedAsset(harness.request, harness.assetId);
  assert.equal(retryResult.status, 204);
  assert.equal(harness.state.unlinkCalls, 2);
  assert.equal(harness.state.asset, null);
  assert.equal(harness.state.deleted, true);
});

test('CMS list totals count all matching documents and Nginx scopes the large upload body limit', () => {
  assert.match(cms, /SELECT COUNT\(\*\)::integer AS count/);
  assert.match(cms, /res\.set\('X-Total-Count', String\(count\)\)/);
  assert.doesNotMatch(cms, /String\(rows\.length\)/);

  const cmsLocation = nginx.indexOf('location = /api/cms/assets');
  const cmsUploadLocation = nginx.indexOf('location = /api/cms/assets/');
  const cmsReadLocation = nginx.indexOf('location ^~ /api/cms/assets/');
  const genericApi = nginx.indexOf('location /api/');
  assert.ok(cmsLocation >= 0 && cmsUploadLocation > cmsLocation
    && cmsReadLocation > cmsUploadLocation && cmsReadLocation < genericApi);
  assert.match(nginx, /location = \/api\/cms\/assets[\s\S]*client_max_body_size 101m;[\s\S]*proxy_request_buffering off;[\s\S]*limit_req zone=uploads[\s\S]*proxy_pass \$api_upstream/);
  assert.match(nginx, /location = \/api\/cms\/assets\/[\s\S]*client_max_body_size 101m;[\s\S]*proxy_request_buffering off;[\s\S]*limit_req zone=uploads[\s\S]*proxy_pass \$api_upstream/);
  assert.match(nginx, /location \^~ \/api\/cms\/assets\/[\s\S]*client_max_body_size 100k;[\s\S]*limit_req zone=media_reads[\s\S]*proxy_pass \$api_upstream/);
  assert.match(nginx, /frame-src https:\/\/\*\.firebaseapp\.com blob:/);
  assert.doesNotMatch(nginx, /location[^\n]*\/uploads\/cms-private/);
});

test('CMS JSON transport is bounded separately from the normal API', () => {
  assert.match(index, /app\.use\('\/api\/cms', express\.json\(\{ limit: '6mb' \}\)\)/);
  assert.match(index, /express\.json\(\{ limit: '100kb' \}\)/);
  assert.match(blocks, /MAX_CMS_PAYLOAD_BYTES = 5 \* 1024 \* 1024/);
  assert.match(blocks, /normalized\.every\(Boolean\)/);
  assert.match(blocks, /Buffer\.byteLength\(JSON\.stringify\(normalized\), 'utf8'\)/);
  assert.match(nginx, /location \^~ \/api\/cms\/[\s\S]*client_max_body_size 6m;/);
  assert.match(nginx, /location = \/api\/cms\/assets[\s\S]*client_max_body_size 101m;/);
});

test('missing Knowledge updates return 404 without a success audit payload', () => {
  assert.match(knowledge, /if \(!existing\.rows\[0\]\) return null;/);
  assert.match(knowledge, /if \(!result \|\| !result\.row\) return res\.status\(404\)/);
});

test('withAudit treats a missing update as a committed no-op', async () => {
  const calls = [];
  const pool = {
    async connect() {
      return {
        async query(sql) {
          calls.push(sql);
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const result = await withAudit(
    pool,
    { user: { uid: 'admin-1' }, id: 'request-1' },
    'knowledge.update',
    'knowledge',
    async () => null,
  );
  assert.equal(result, null);
  assert.equal(calls.some(sql => /INSERT INTO audit_log/.test(sql)), false);
  assert.equal(calls.at(-1), 'COMMIT');
});
