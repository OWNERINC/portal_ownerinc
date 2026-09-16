import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const sentEmails = [];
const sendEmailPath = require.resolve('../../cron/sendEmail');
require.cache[sendEmailPath] = {
  id: sendEmailPath,
  filename: sendEmailPath,
  loaded: true,
  exports: { sendEmail: async payload => sentEmails.push(payload) },
};
const {
  processOccurrence, promoteScheduledRevisions, reminderForDelivery,
} = require('../../cron/checkReminders');
const {
  enforceAutocardMediaRetention,
  isSafePosCardStorageKey,
  isSafeStorageKey,
} = require('../../cron/autocard-media-retention');

test.beforeEach(() => {
  sentEmails.length = 0;
});

test('scheduled promotion is transactional, archives before publishing, and audits', async () => {
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT d\.id, d\.published_revision_id/.test(sql)) {
        return {
          rows: [{
            id: 'doc-1', published_revision_id: 'old-1', scheduled_revision_id: 'new-1',
            scheduled_blocks: [{ type: 'paragraph', text: 'Scheduled body' }],
          }],
        };
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
  assert.match(source, /reminderMatchesDate\(reminder\.trigger_day, scheduledDate\)/);
  assert.match(source, /resolveTargets\(reminder\.target_users, \[user\]\)/);
  assert.match(source, /channelsFor\(reminder\.channel\)\.includes\(channel\)/);
  assert.match(source, /FOR UPDATE OF reminder/);
  assert.match(source, /notifications_log/);
  assert.match(source, /RETURNING id/);
  assert.match(source, /WHERE id = \$1/);
  assert.match(source, /error\?\.code === '23503'/);
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

test('cron rechecks publication under the shared CMS lock before sending', async () => {
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
       if (/INSERT INTO notifications_log/.test(sql)) return { rows: [{ id: 'log-1' }] };
      if (/FROM reminders reminder/.test(sql)) {
        return { rows: [{
          id: 'reminder-1', title: 'No longer published', description: 'Stale body',
          active: true, trigger_day: 17, target_users: ['user-1'], channel: 'email',
          cms_document_id: 'document-1', published_revision_id: null,
        }] };
      }
      return { rows: [] };
    },
  };

  const result = await processOccurrence(db, {
    id: 'reminder-1', title: 'No longer published', description: 'Stale body',
    cms_document_id: 'document-1', cms_blocks: [{ type: 'paragraph', text: 'Stale body' }],
  }, { uid: 'user-1', email: 'user@example.com', name: 'User' }, '2026-08-17', 'email');

  assert.equal(result, 'skipped');
  assert.deepEqual(sentEmails, []);
  const lockIndex = calls.findIndex(({ sql }) => /pg_advisory_xact_lock/.test(sql));
  const validationIndex = calls.findIndex(({ sql }) => /FROM reminders reminder/.test(sql));
  const finish = calls.find(({ sql }) => /UPDATE notifications_log/.test(sql));
  assert.ok(lockIndex >= 0 && lockIndex < validationIndex);
  assert.deepEqual(calls[lockIndex].params, [7193029]);
  assert.equal(finish.params.at(-1), 'Reminder is no longer active or published');
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('cron skips a claimed occurrence when the current audience, date, channel, or active state changed', async () => {
  for (const changes of [
    { active: false },
    { trigger_day: 18 },
    { target_users: ['other-user'] },
    { channel: 'whatsapp' },
  ]) {
    const calls = [];
    const db = {
      async query(sql, params = []) {
        calls.push({ sql, params });
         if (/INSERT INTO notifications_log/.test(sql)) return { rows: [{ id: 'log-1' }] };
        if (/FROM reminders reminder/.test(sql)) {
          return { rows: [{
            id: 'reminder-1', title: 'Changed', description: 'Body', active: true,
            trigger_day: 17, target_users: ['user-1'], channel: 'email',
            cms_document_id: null, ...changes,
          }] };
        }
        return { rows: [] };
      },
    };
    const result = await processOccurrence(db, {
      id: 'reminder-1', title: 'Original', description: 'Body', cms_document_id: null,
    }, { uid: 'user-1', email: 'user@example.com', name: 'User' }, '2026-08-17', 'email');
    assert.equal(result, 'skipped', JSON.stringify(changes));
    assert.deepEqual(sentEmails, [], JSON.stringify(changes));
    assert.ok(calls.some(({ sql }) => /pg_advisory_xact_lock/.test(sql)), JSON.stringify(changes));
  }
});

test('cron finishes a claimed log after reminder deletion nulls its foreign key', async () => {
  const calls = [];
  const log = { id: 'log-1', reminder_id: 'reminder-1' };
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO notifications_log/.test(sql)) return { rows: [{ id: log.id }] };
      if (/FROM reminders reminder/.test(sql)) {
        log.reminder_id = null;
        return { rows: [] };
      }
      return { rows: [] };
    },
  };

  const result = await processOccurrence(db, {
    id: 'reminder-1', title: 'Deleted', description: 'Body', cms_document_id: null,
  }, { uid: 'user-1', email: 'user@example.com', name: 'User' }, '2026-08-17', 'email');

  assert.equal(result, 'skipped');
  assert.equal(log.reminder_id, null);
  assert.deepEqual(sentEmails, []);
  const finish = calls.find(({ sql }) => /finished_at = NOW\(\)/.test(sql));
  assert.ok(finish);
  assert.match(finish.sql, /WHERE id = \$1/);
  assert.deepEqual(finish.params, ['log-1', 'skipped', 'Reminder is no longer active or published']);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('cron isolates a missing reminder foreign key during claim and continues', async () => {
  const calls = [];
  let claimAttempts = 0;
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO notifications_log/.test(sql)) {
        claimAttempts += 1;
        if (claimAttempts === 1) {
          const error = new Error('reminder no longer exists');
          error.code = '23503';
          throw error;
        }
        return { rows: [{ id: 'log-2' }] };
      }
      if (/FROM reminders reminder/.test(sql)) {
        return { rows: [{
          id: 'reminder-2', title: 'Available', description: 'Body', active: true,
          trigger_day: 17, target_users: ['user-1'], channel: 'email', cms_document_id: null,
        }] };
      }
      return { rows: [] };
    },
  };
  const reminder = { id: 'reminder-2', title: 'Available', description: 'Body', cms_document_id: null };
  const user = { uid: 'user-1', email: 'user@example.com', name: 'User' };

  const missing = await processOccurrence(db, reminder, user, '2026-08-17', 'email');
  const available = await processOccurrence(db, reminder, user, '2026-08-17', 'email');

  assert.equal(missing, null);
  assert.equal(available, 'sent');
  assert.equal(claimAttempts, 2);
  assert.equal(sentEmails.length, 1);
  assert.equal(calls.filter(({ sql }) => sql === 'BEGIN').length, 1);
  assert.equal(calls.filter(({ sql }) => /finished_at = NOW\(\)/.test(sql)).length, 1);
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
