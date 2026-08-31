import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../cron/package.json', import.meta.url));
const { triggerUserImports } = require('./user-imports');

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
