import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cmsAssetRetentionDays } from '../../cron/cms-asset-retention.js';

test('CMS asset retention keeps a bounded configurable orphan window', () => {
  assert.equal(cmsAssetRetentionDays({}), 30);
  assert.equal(cmsAssetRetentionDays({ CMS_ASSET_ORPHAN_RETENTION_DAYS: '7' }), 7);
  assert.throws(() => cmsAssetRetentionDays({ CMS_ASSET_ORPHAN_RETENTION_DAYS: '0' }), /between 1 and 3650/);
  assert.throws(() => cmsAssetRetentionDays({ CMS_ASSET_ORPHAN_RETENTION_DAYS: '3651' }), /between 1 and 3650/);
});

test('CMS asset retention queries only unreferenced revisions and deletes safely', async () => {
  const queries = [];
  const client = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT a.id')) return { rows: [{ id: 'asset-1', storage_key: 'key-1' }] };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const db = {
    async connect() {
      return client;
    },
  };
  const uploadDirectory = await mkdtemp(path.join(os.tmpdir(), 'cms-retention-'));
  await mkdir(path.join(uploadDirectory, 'cms-private'));
  const module = await import('../../cron/cms-asset-retention.js');
  try {
    await module.enforceCmsAssetRetention(db, { CMS_ASSET_ORPHAN_RETENTION_DAYS: '30', UPLOAD_DIR: uploadDirectory });
  } finally {
    await rm(uploadDirectory, { recursive: true, force: true });
  }
  assert.match(queries.find(({ sql }) => sql.includes('SELECT a.id')).sql, /jsonb_array_elements\(r\.blocks\)/);
  assert.match(queries.find(({ sql }) => sql.includes('DELETE FROM cms_assets')).sql, /NOT EXISTS/);
  assert.ok(queries.some(({ sql }) => sql.includes('pg_advisory_xact_lock')));
});

test('CMS asset retention skips a missing private upload directory', async () => {
  let connected = false;
  const db = { async connect() { connected = true; return null; } };
  const module = await import('../../cron/cms-asset-retention.js');
  const result = await module.enforceCmsAssetRetention(db, {
    CMS_ASSET_ORPHAN_RETENTION_DAYS: '30',
    UPLOAD_DIR: path.join(os.tmpdir(), 'missing-cms-retention-directory'),
  });
  assert.equal(result.skipped, true);
  assert.equal(connected, false);
});

test('CMS asset retention does not delete a row if the upload directory disappears mid-run', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('SELECT a.id')) return { rows: [{ id: 'asset-1', storage_key: 'key-1' }] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  let accessCount = 0;
  const fileSystem = {
    async access() {
      accessCount += 1;
      if (accessCount > 1) throw new Error('directory disappeared');
    },
    async unlink() {
      const error = new Error('missing');
      error.code = 'ENOENT';
      throw error;
    },
  };
  const module = await import('../../cron/cms-asset-retention.js');
  await assert.rejects(
    module.enforceCmsAssetRetention({ async connect() { return client; } }, { UPLOAD_DIR: '/tmp/uploads' }, fileSystem),
    /private upload directory became unavailable/,
  );
  assert.equal(queries.some(sql => sql.includes('DELETE FROM cms_assets')), false);
});
