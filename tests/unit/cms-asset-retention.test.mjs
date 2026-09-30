import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cmsAssetRetentionDays } from '../../cron/cms-asset-retention.js';

const retentionSource = await readFile('cron/cms-asset-retention.js', 'utf8');

test('lesson draft retains its real file; source deletion removes CMS references and leaves cleanup to retention', async t => {
  const { deleteCmsSource } = createRequire(import.meta.url)('../../api/cms/sources');
  const { enforceCmsAssetRetention } = await import('../../cron/cms-asset-retention.js');
  const uploadDirectory = await mkdtemp(path.join(os.tmpdir(), 'lesson-retention-'));
  t.after(() => rm(uploadDirectory, { recursive: true, force: true }));
  await mkdir(path.join(uploadDirectory, 'cms-private'));
  const file = path.join(uploadDirectory, 'cms-private', 'lesson-material');
  await writeFile(file, '%PDF-1.4\n%%EOF');
  const asset = { id: 'asset', storage_key: 'lesson-material' };
  let revisions = [{ content_type: 'academy_lesson', source_id: 'lesson', status: 'draft', blocks: [{ asset_id: 'asset' }] }];
  let deleted = false;
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push(sql);
      if (sql.includes('DELETE FROM academy_lessons')) return { rows: [{ id: params[0] }] };
      if (sql.includes('DELETE FROM cms_documents')) {
        revisions = revisions.filter(row => row.content_type !== params[0] || row.source_id !== params[1]);
        return { rows: [] };
      }
      if (sql.includes('SELECT a.id')) {
        assert.match(sql, /jsonb_array_elements\(r.blocks\)/);
        assert.doesNotMatch(sql, /r.status|content_type/);
        return { rows: revisions.length ? [] : [asset] };
      }
      if (sql.includes('SET deleting_at = NOW()')) return { rows: [asset] };
      if (sql.includes('DELETE FROM cms_assets')) { deleted = true; return { rowCount: 1 }; }
      return { rows: [] };
    }, release() {},
  };
  const pool = { connect: async () => client };
  const env = { UPLOAD_DIR: uploadDirectory };
  assert.equal((await enforceCmsAssetRetention(pool, env)).deletedFiles, 0);
  assert.match(await readFile(file, 'utf8'), /^%PDF/);
  calls.length = 0;
  assert.deepEqual(await deleteCmsSource(client, 'academy_lesson', 'lesson'), { id: 'lesson' });
  assert.match(calls[0], /pg_advisory_xact_lock/);
  assert.equal(revisions.length, 0);
  assert.equal(deleted, false);
  assert.match(await readFile(file, 'utf8'), /^%PDF/);
  const result = await enforceCmsAssetRetention(pool, env);
  assert.equal(result.deletedFiles, 1);
  assert.equal(result.deletedRows, 1);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('CMS asset retention keeps a bounded configurable orphan window', () => {
  assert.equal(cmsAssetRetentionDays({}), 30);
  assert.equal(cmsAssetRetentionDays({ CMS_ASSET_ORPHAN_RETENTION_DAYS: '7' }), 7);
  assert.throws(() => cmsAssetRetentionDays({ CMS_ASSET_ORPHAN_RETENTION_DAYS: '0' }), /between 1 and 3650/);
  assert.throws(() => cmsAssetRetentionDays({ CMS_ASSET_ORPHAN_RETENTION_DAYS: '3651' }), /between 1 and 3650/);
});

test('CMS asset retention compares revision asset references case-insensitively', () => {
  assert.equal((retentionSource.match(/lower\(block->>'asset_id'\)/g) || []).length, 3);
  assert.doesNotMatch(retentionSource, /WHERE block->>'asset_id'\s*=\s*a\.id::text/);
  assert.doesNotMatch(retentionSource, /WHERE block->>'asset_id'\s*=\s*\$1::text/);
});

test('CMS asset retention queries only unreferenced revisions and deletes safely', async () => {
  const queries = [];
  const client = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT a.id')) return { rows: [{ id: 'asset-1', storage_key: 'key-1' }] };
      if (sql.includes('SET deleting_at = NOW()')) return { rowCount: 1, rows: [{ id: 'asset-1', storage_key: 'key-1' }] };
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
  assert.ok(queries.some(({ sql }) => sql.includes('SET deleting_at = NOW()')));
  assert.ok(queries.some(({ sql }) => sql.includes('deleting_at IS NOT NULL')));
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
      if (sql.includes('SET deleting_at = NOW()')) return { rowCount: 1, rows: [{ id: 'asset-1', storage_key: 'key-1' }] };
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

test('CMS asset retention clears a reservation when finalization fails after unlink', async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('SELECT a.id')) return { rows: [{ id: 'asset-1', storage_key: 'key-1' }] };
      if (sql.includes('SET deleting_at = NOW()')) return { rowCount: 1, rows: [{ id: 'asset-1', storage_key: 'key-1' }] };
      if (sql.includes('DELETE FROM cms_assets')) throw new Error('simulated finalization failure');
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const fileSystem = {
    async access() {},
    async unlink() {},
  };
  const result = await (await import('../../cron/cms-asset-retention.js')).enforceCmsAssetRetention(
    { async connect() { return client; } },
    { UPLOAD_DIR: '/tmp/uploads' },
    fileSystem,
  );

  assert.equal(result.finalizeFailures, 1);
  assert.ok(queries.some(sql => sql.includes('UPDATE cms_assets SET deleting_at = NULL')));
});
