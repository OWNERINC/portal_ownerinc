import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../cron/package.json', import.meta.url));
const { cleanupFirebaseUsers, cleanupPendingRegistrations, reconcileFirebaseEnables, triggerUserImports } = require('./user-imports');
const { noteWorkerResultFailures } = require('./worker-status');

test('cron worker status turns partial failures into an operational error', () => {
  assert.equal(noteWorkerResultFailures(null, 'worker', { failed: 0 }), null);
  assert.match(noteWorkerResultFailures(null, 'worker', { failed: 2 }).message, /2 failed/);
  const existing = new Error('existing');
  assert.equal(noteWorkerResultFailures(existing, 'worker', { failed: 2 }), existing);
});

test('cron worker trigger uses the internal API secret and reports failures', async () => {
  let request;
  const result = await triggerUserImports({ BULK_IMPORT_API_URL: 'http://api:3000', BULK_IMPORT_WORKER_SECRET: 'secret' }, async (...args) => {
    request = args;
    return { ok: true, json: async () => ({ processed: 1 }) };
  });
  assert.deepEqual(result, { processed: 1 });
  assert.equal(request[0], 'http://api:3000/api/internal/user-imports/process');
  assert.equal(request[1].headers['x-worker-secret'], 'secret');
  await assert.rejects(() => triggerUserImports({ BULK_IMPORT_API_URL: 'http://api:3000', BULK_IMPORT_WORKER_SECRET: 'secret' }, async () => ({ ok: false, status: 404 })), /HTTP 404/);
});

test('cron worker triggers pending registration retention through the internal API', async () => {
  let request;
  const result = await cleanupPendingRegistrations({ BULK_IMPORT_API_URL: 'http://api:3000', BULK_IMPORT_WORKER_SECRET: 'secret' }, async (...args) => {
    request = args;
    return { ok: true, json: async () => ({ deleted: 2, failed: 0 }) };
  });
  assert.deepEqual(result, { deleted: 2, failed: 0 });
  assert.equal(request[0], 'http://api:3000/api/internal/user-imports/registrations/retention');
  assert.equal(request[1].headers['x-worker-secret'], 'secret');
});

test('cron worker retries pending Firebase enables through the internal API', async () => {
  let request;
  const result = await reconcileFirebaseEnables({ BULK_IMPORT_API_URL: 'http://api:3000', BULK_IMPORT_WORKER_SECRET: 'secret' }, async (...args) => {
    request = args;
    return { ok: true, json: async () => ({ resolved: 1, failed: 0 }) };
  });
  assert.deepEqual(result, { resolved: 1, failed: 0 });
  assert.equal(request[0], 'http://api:3000/api/internal/user-imports/firebase-enables');
  assert.equal(request[1].headers['x-worker-secret'], 'secret');
});

test('cron worker retries Firebase cleanup through the internal API', async () => {
  let request;
  const result = await cleanupFirebaseUsers({ BULK_IMPORT_API_URL: 'http://api:3000', BULK_IMPORT_WORKER_SECRET: 'secret' }, async (...args) => {
    request = args;
    return { ok: true, json: async () => ({ deleted: 1, failed: 0 }) };
  });
  assert.deepEqual(result, { deleted: 1, failed: 0 });
  assert.equal(request[0], 'http://api:3000/api/internal/user-imports/firebase-cleanup');
  assert.equal(request[1].headers['x-worker-secret'], 'secret');
});
