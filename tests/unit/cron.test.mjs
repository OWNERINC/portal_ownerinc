import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { promoteScheduledRevisions, reminderForDelivery } = require('../../cron/checkReminders');
const {
  enforceAutocardMediaRetention,
  isSafePosCardStorageKey,
  isSafeStorageKey,
} = require('../../cron/autocard-media-retention');

test('scheduled promotion is transactional, archives before publishing, and audits', async () => {
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT d\.id, d\.published_revision_id/.test(sql)) {
        return { rows: [{ id: 'doc-1', published_revision_id: 'old-1', scheduled_revision_id: 'new-1' }] };
      }
      return { rows: [] };
    },
  };

  assert.equal(await promoteScheduledRevisions(db, new Date('2026-08-17T12:00:00Z')), 1);
  const sql = calls.map(({ sql: statement }) => statement);
  assert.equal(sql[0], 'BEGIN');
  assert.ok(sql.findIndex((statement) => /SET status = 'archived'/.test(statement))
    < sql.findIndex((statement) => /SET status = 'published'/.test(statement)));
  assert.ok(sql.some((statement) => /UPDATE cms_documents/.test(statement)));
  assert.ok(sql.some((statement) => /INSERT INTO audit_log/.test(statement)));
  assert.equal(sql.at(-1), 'COMMIT');
});

test('cron uses published reminder blocks for text while keeping delivery controls', async () => {
  const source = await readFile('cron/checkReminders.js', 'utf8');
  assert.match(source, /blocksToText\(reminder\.cms_blocks\)/);
  assert.match(source, /LEFT JOIN cms_documents/);
  assert.match(source, /revision\.status = 'published'/);
  assert.match(source, /claim\(db, reminder\.id, user\.uid, scheduledDate, channel\)/);
  assert.match(source, /resolveTargets\(reminder\.target_users, users\)/);
  assert.match(source, /channelsFor\(reminder\.channel\)/);
  assert.match(source, /notifications_log/);
});

test('cron keeps legacy reminder text when published blocks render empty', () => {
  const reminder = { description: 'Legacy description', cms_blocks: [{ type: 'divider' }] };
  assert.equal(reminderForDelivery(reminder), reminder);
  assert.equal(reminderForDelivery({
    ...reminder,
    cms_blocks: [{ type: 'image', asset_id: '550e8400-e29b-41d4-a716-446655440000', alt: 'Banner' }],
  }).description, 'Legacy description');
  assert.equal(reminderForDelivery({
    ...reminder,
    cms_blocks: [{ type: 'paragraph', text: 'Published description' }],
  }).description, 'Published description');
});

test('cron image contains the shared CMS reader at its actual import path', async () => {
  const [compose, dockerfile, workflow, cronSource, reader, blocks] = await Promise.all([
    readFile('docker-compose.yml', 'utf8'),
    readFile('cron/Dockerfile', 'utf8'),
    readFile('.github/workflows/ci.yml', 'utf8'),
    readFile('cron/checkReminders.js', 'utf8'),
    readFile('api/cms/reader.js', 'utf8'),
    readFile('api/cms/blocks.js', 'utf8'),
  ]);
  assert.match(compose, /context: \.[\s\S]*dockerfile: cron\/Dockerfile/);
  assert.match(workflow, /docker build --tag ownerinc-portal-cron:\$\{GITHUB_SHA\} --file cron\/Dockerfile \./);
  assert.doesNotMatch(workflow, /docker build --tag ownerinc-portal-cron:\$\{GITHUB_SHA\} cron\s*$/m);
  assert.match(dockerfile, /COPY --chown=node:node api\/cms\/ \/api\/cms\//);
  assert.match(cronSource, /require\('\.\.\/api\/cms\/reader'\)/);
  assert.match(reader, /require\('\.\/blocks'\)/);
  assert.match(blocks, /function blocksToText/);
});

test('Pos-Cards retention accepts only UUID WebP keys and keeps namespaces isolated', async () => {
  assert.equal(isSafePosCardStorageKey('pos-card-123e4567-e89b-12d3-a456-426614174000.webp'), true);
  assert.equal(isSafeStorageKey('pos-card-123e4567-e89b-12d3-a456-426614174000.webp'), true);
  for (const key of [
    'pos-card-123E4567-E89B-12D3-A456-426614174000.webp',
    'pos-card-123e4567-e89b-12d3-a456-42661417400.webp',
    'pos-card-123e4567-e89b-12d3-a456-426614174000.jpg',
    'pos-card-123e4567-e89b-12d3-a456-426614174000.webp.bak',
    'pos-card-123e4567-e89b-12d3-a456-426614174000/other.webp',
  ]) assert.equal(isSafePosCardStorageKey(key), false, key);

  const retention = await readFile('cron/autocard-media-retention.js', 'utf8');
  assert.match(retention, /pos_card_media/);
  assert.match(retention, /pos_cards/);
  assert.match(retention, /pg_try_advisory_lock/);
  assert.match(retention, /pos_card_media_invalid_storage_key/);
  assert.match(retention, /isSafeAutocardStorageKey/);
});

test('retention deletes mixed AutoCard and Pos-Cards orphans independently', async () => {
  const uploadDirectory = await mkdtemp(path.join(tmpdir(), 'ownerinc-retention-'));
  const autocardKey = 'autocard-123e4567-e89b-12d3-a456-426614174000.webp';
  const posCardKey = 'pos-card-223e4567-e89b-12d3-a456-426614174000.webp';
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ pg_try_advisory_lock: true }] };
      if (/DELETE FROM autocard_media/.test(sql)) return { rows: [{ id: 'auto-media', storage_key: autocardKey }] };
      if (/DELETE FROM pos_card_media/.test(sql)) return { rows: [{ id: 'pos-media', storage_key: posCardKey }] };
      if (/FROM autocard_media/.test(sql)) return { rows: [{ id: 'auto-media', storage_key: autocardKey }] };
      if (/FROM pos_card_media/.test(sql)) return { rows: [{ id: 'pos-media', storage_key: posCardKey }] };
      if (/INSERT INTO audit_log/.test(sql)) return { rows: [{ id: 'audit-1' }] };
      if (/UPDATE audit_log/.test(sql)) return { rowCount: 1, rows: [] };
      return { rows: [] };
    },
  };

  try {
    await Promise.all([
      writeFile(path.join(uploadDirectory, autocardKey), 'autocard'),
      writeFile(path.join(uploadDirectory, posCardKey), 'pos-card'),
    ]);
    const result = await enforceAutocardMediaRetention({ db, uploadDirectory, retentionDays: 7 });

    assert.deepEqual(result, { deletedRows: 2, deletedFiles: 2, fileFailures: 0, retentionDays: 7 });
    await assert.rejects(readFile(path.join(uploadDirectory, autocardKey)));
    await assert.rejects(readFile(path.join(uploadDirectory, posCardKey)));
    assert.deepEqual(calls.find(({ sql }) => /DELETE FROM autocard_media/.test(sql)).params, [['auto-media']]);
    assert.deepEqual(calls.find(({ sql }) => /DELETE FROM pos_card_media/.test(sql)).params, [['pos-media']]);
  } finally {
    await rm(uploadDirectory, { recursive: true, force: true });
  }
});
