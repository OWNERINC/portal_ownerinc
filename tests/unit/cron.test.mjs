import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const sentEmails = [];
const successfulEmail = (payload) => {
  sentEmails.push(payload);
  return { accepted: [payload.to], rejected: [] };
};
let sendEmailImplementation = successfulEmail;
const sendEmailPath = require.resolve('../../cron/sendEmail');
require.cache[sendEmailPath] = {
  id: sendEmailPath,
  filename: sendEmailPath,
  loaded: true,
  exports: { sendEmail: async payload => sendEmailImplementation(payload) },
};
const {
  checkReminders, processDate, processOccurrence, promoteScheduledRevisions, recoverInterruptedDeliveries, reminderForDelivery,
} = require('../../cron/checkReminders');
const { canRecover, checkHealth, healthSignature, isExecutionRunning } = require('../../cron/health');
const {
  enforceAutocardMediaRetention,
  isSafePosCardStorageKey,
  isSafeStorageKey,
} = require('../../cron/autocard-media-retention');

test.beforeEach(() => {
  sentEmails.length = 0;
  sendEmailImplementation = successfulEmail;
});

function reminderRunFixture(lastScheduledDate = '2026-08-16', candidate = null) {
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ pg_try_advisory_lock: true }] };
      if (/last_scheduled_date::text/.test(sql)) return { rows: [{ last_scheduled_date: lastScheduledDate }] };
      if (candidate && /INSERT INTO notifications_log/.test(sql)) {
        return { rows: [{ id: 'log-1', attempt_count: 1 }] };
      }
      if (candidate && /FROM reminders reminder/.test(sql)) return { rows: [candidate.reminder] };
      if (candidate && /FROM users/.test(sql)) return { rows: [candidate.user] };
      return { rows: [] };
    },
    release() {},
  };
  return { calls, pool: { async connect() { return db; } } };
}

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
  assert.match(source, /resolveTargets\(reminder\.target_users, \[currentUser\]\)/);
  assert.match(source, /channelsFor\(reminder\.channel\)\.includes\(channel\)/);
  assert.match(source, /FOR UPDATE OF reminder/);
  assert.match(source, /FROM users[\s\S]*FOR UPDATE/);
  assert.match(source, /COALESCE\(permissions->>'accountDisabled', ''\) <> 'true'/);
  assert.match(source, /firebase_enable_pending IS NOT TRUE/);
  assert.match(source, /accountDisabled === 'true'/);
  assert.match(source, /firebase_enable_pending === true/);
  assert.match(source, /notifications_log/);
  assert.match(source, /RETURNING id/);
  assert.match(source, /WHERE id = \$1/);
  assert.match(source, /error\?\.code === '23503'/);
  assert.match(source, /last_scheduled_date::text AS last_scheduled_date/);
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
      if (/FROM users/.test(sql)) return { rows: [{
        uid: 'user-1', email: 'user@example.com', name: 'User', contract_type: 'clt', is_pj: false,
      }] };
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
   assert.equal(finish.params.at(-1), 'content_not_published');
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
        if (/FROM users/.test(sql)) return { rows: [{
          uid: 'user-1', email: 'user@example.com', name: 'User', contract_type: 'clt', is_pj: false,
        }] };
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

test('cron locks the current recipient snapshot and skips concurrent deactivation or ineligible recipients', async () => {
  for (const mode of [
    'updated-email', 'concurrent-disabled', 'concurrent-disabled-string', 'enable-pending',
    'disabled', 'removed', 'no-email', 'audience-changed',
  ]) {
    sentEmails.length = 0;
    const calls = [];
    const db = {
      async query(sql, params = []) {
        calls.push({ sql, params });
        if (/INSERT INTO notifications_log/.test(sql)) return { rows: [{ id: 'log-1', attempt_count: 1 }] };
        if (/FROM users/.test(sql)) {
          return { rows: ['disabled', 'removed'].includes(mode) ? [] : [{
            uid: 'user-1', email: mode === 'no-email' ? '' : 'fresh@example.com',
            name: 'Fresh', contract_type: 'clt', is_pj: false,
            ...(mode === 'concurrent-disabled' ? { permissions: { accountDisabled: true } } : {}),
            ...(mode === 'concurrent-disabled-string' ? { permissions: { accountDisabled: 'true' } } : {}),
            ...(mode === 'enable-pending' ? { firebase_enable_pending: true } : {}),
          }] };
        }
        if (/FROM reminders reminder/.test(sql)) return { rows: [{
          id: '550e8400-e29b-41d4-a716-446655440000', title: 'Current', description: 'Body', active: true,
          trigger_day: 17, target_users: mode === 'audience-changed' ? ['other-user'] : ['user-1'],
          channel: 'email', cms_document_id: null,
        }] };
        return { rows: [] };
      },
    };
    const result = await processOccurrence(
      db,
      { id: '550e8400-e29b-41d4-a716-446655440000', title: 'Stale', description: 'Old body' },
      { uid: 'user-1', email: 'stale@example.com', name: 'Stale' },
      '2026-08-17', 'email',
    );
    const userQuery = calls.find(({ sql }) => /FROM users/.test(sql));
    const reminderQuery = calls.find(({ sql }) => /FROM reminders reminder/.test(sql));
    assert.match(userQuery.sql, /FOR UPDATE/);
    assert.match(userQuery.sql, /permissions/);
    assert.match(userQuery.sql, /firebase_enable_pending/);
    if (reminderQuery) assert.ok(calls.indexOf(reminderQuery) < calls.indexOf(userQuery));
    if (mode === 'updated-email') {
      assert.equal(result, 'sent');
      assert.equal(sentEmails[0].to, 'fresh@example.com');
    } else {
      assert.equal(result, 'skipped', mode);
      assert.deepEqual(sentEmails, [], mode);
      const finish = calls.find(({ sql }) => /UPDATE notifications_log/.test(sql) && /SET status = \$2/.test(sql));
      const reason = {
        'concurrent-disabled': 'recipient_disabled',
        'concurrent-disabled-string': 'recipient_disabled',
        'enable-pending': 'recipient_enablement_pending',
        disabled: 'recipient_removed',
        removed: 'recipient_removed',
        'no-email': 'recipient_missing_email',
        'audience-changed': 'recipient_not_in_audience',
      }[mode];
      assert.equal(finish.params[2], reason, mode);
    }
  }
});

test('cron propagates operational delivery errors without finalizing a delivery', async () => {
  const previousUrl = process.env.PORTAL_PUBLIC_URL;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.PORTAL_PUBLIC_URL = 'http://portal.example.test';
  process.env.NODE_ENV = 'production';
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO notifications_log/.test(sql)) return { rows: [{ id: 'log-1', attempt_count: 1 }] };
      if (/FROM users/.test(sql)) return { rows: [{
        uid: 'user-1', email: 'user@example.com', name: 'User', contract_type: 'clt', is_pj: false,
      }] };
      if (/FROM reminders reminder/.test(sql)) return { rows: [{
        id: '550e8400-e29b-41d4-a716-446655440000', title: 'Operational', description: 'Body', active: true,
        trigger_day: 17, target_users: ['user-1'], channel: 'email', cms_document_id: null,
      }] };
      return { rows: [] };
    },
  };

  try {
    await assert.rejects(
      processOccurrence(
        db,
        { id: '550e8400-e29b-41d4-a716-446655440000', title: 'Operational', description: 'Body' },
        { uid: 'user-1', email: 'user@example.com', name: 'User' },
        '2026-08-17', 'email',
      ),
      /Invalid PORTAL_PUBLIC_URL/,
    );
  } finally {
    if (previousUrl === undefined) delete process.env.PORTAL_PUBLIC_URL;
    else process.env.PORTAL_PUBLIC_URL = previousUrl;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
  assert.deepEqual(sentEmails, []);
  assert.ok(calls.some(({ sql }) => sql === 'ROLLBACK'));
  assert.doesNotMatch(calls.map(({ sql }) => sql).join('\n'), /finished_at = NOW\(\)/);
});

test('cron propagates finalization errors instead of hiding them as delivery results', async () => {
  const finishError = new Error('ledger unavailable');
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO notifications_log/.test(sql)) return { rows: [{ id: 'log-1', attempt_count: 1 }] };
      if (/FROM reminders reminder/.test(sql)) return { rows: [{
        id: '550e8400-e29b-41d4-a716-446655440000', title: 'Finish error', description: 'Body',
        active: true, trigger_day: 17, target_users: ['user-1'], channel: 'email', cms_document_id: null,
      }] };
      if (/FROM users/.test(sql)) return { rows: [{
        uid: 'user-1', email: 'user@example.com', name: 'User', contract_type: 'clt', is_pj: false,
        permissions: {},
      }] };
      if (/UPDATE notifications_log/.test(sql) && /SET status = \$2/.test(sql)) throw finishError;
      return { rows: [] };
    },
  };

  await assert.rejects(
    processOccurrence(
      db,
      { id: '550e8400-e29b-41d4-a716-446655440000', title: 'Finish error', description: 'Body' },
      { uid: 'user-1', email: 'user@example.com', name: 'User' },
      '2026-08-17', 'email',
    ),
    finishError,
  );
  assert.equal(sentEmails.length, 1);
  assert.ok(calls.some(({ sql }) => sql === 'ROLLBACK'));
});

test('cron finishes a claimed log after reminder deletion nulls its foreign key', async () => {
  const calls = [];
  const log = { id: 'log-1', reminder_id: 'reminder-1' };
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO notifications_log/.test(sql)) return { rows: [{ id: log.id }] };
      if (/FROM users/.test(sql)) return { rows: [{
        uid: 'user-1', email: 'user@example.com', name: 'User', contract_type: 'clt', is_pj: false,
      }] };
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
   assert.deepEqual(finish.params, ['log-1', 'skipped', 'reminder_removed']);
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
      if (/FROM users/.test(sql)) return { rows: [{
        uid: 'user-1', email: 'user@example.com', name: 'User', contract_type: 'clt', is_pj: false,
      }] };
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

test('cron idempotence keeps one occurrence and one delivery after a repeated run', async () => {
  let status = 'pending';
  let claimCount = 0;
  const db = {
    async query(sql, params = []) {
      if (/INSERT INTO notifications_log/.test(sql)) {
        claimCount += 1;
        if (status !== 'pending') return { rows: [] };
        status = 'sending';
        return { rows: [{ id: 'log-1', attempt_count: 1 }] };
      }
      if (/FROM users/.test(sql)) return { rows: [{
        uid: 'user-1', email: 'user@example.com', name: 'User', contract_type: 'clt', is_pj: false,
      }] };
      if (/FROM reminders reminder/.test(sql)) return { rows: [{
        id: '550e8400-e29b-41d4-a716-446655440000', title: 'Repeated', description: 'Body',
        active: true, trigger_day: 17, target_users: ['user-1'], channel: 'email', cms_document_id: null,
      }] };
      if (/UPDATE notifications_log/.test(sql) && /SET status = \$2/.test(sql)) status = params[1];
      return { rows: [] };
    },
  };
  const reminder = { id: '550e8400-e29b-41d4-a716-446655440000', title: 'Repeated', description: 'Body' };
  const user = { uid: 'user-1', email: 'user@example.com', name: 'User' };

  assert.equal(await processOccurrence(db, reminder, user, '2026-08-17', 'email'), 'sent');
  assert.equal(await processOccurrence(db, reminder, user, '2026-08-17', 'email'), null);
  assert.equal(claimCount, 2);
  assert.equal(sentEmails.length, 1);
});

test('cron retries known transient SMTP failures with the durable occurrence attempt count', async () => {
  let status = 'pending';
  let attemptCount = 0;
  let sendAttempts = 0;
  sendEmailImplementation = async payload => {
    sendAttempts += 1;
    if (sendAttempts === 1) {
      return { rejected: ['user@example.com'], responseCode: 451 };
    }
    if (sendAttempts === 2) {
      const error = new Error('try again');
      error.responseCode = 421;
      throw error;
    }
    return successfulEmail(payload);
  };
  const db = {
    async query(sql, params = []) {
      if (/INSERT INTO notifications_log/.test(sql)) {
        if (status !== 'pending' || attemptCount >= 3) return { rows: [] };
        status = 'sending';
        attemptCount += 1;
        return { rows: [{ id: 'log-1', attempt_count: attemptCount }] };
      }
      if (/FROM users/.test(sql)) return { rows: [{
        uid: 'user-1', email: 'user@example.com', name: 'User', contract_type: 'clt', is_pj: false,
      }] };
      if (/FROM reminders reminder/.test(sql)) return { rows: [{
        id: '550e8400-e29b-41d4-a716-446655440000', title: 'Retry', description: 'Body',
        active: true, trigger_day: 17, target_users: ['user-1'], channel: 'email', cms_document_id: null,
      }] };
      if (/UPDATE notifications_log/.test(sql) && /SET status = 'pending'/.test(sql)) status = 'pending';
      if (/UPDATE notifications_log/.test(sql) && /SET status = \$2/.test(sql)) status = params[1];
      return { rows: [] };
    },
  };

  const result = await processOccurrence(
    db,
    { id: '550e8400-e29b-41d4-a716-446655440000', title: 'Retry', description: 'Body' },
    { uid: 'user-1', email: 'user@example.com', name: 'User' },
    '2026-08-17', 'email',
  );
  assert.equal(result, 'sent');
  assert.equal(sendAttempts, 3);
  assert.equal(attemptCount, 3);
  assert.equal(sentEmails.length, 1);
});

test('cron treats accepted plus transient SMTP evidence as ambiguous and does not retry', async () => {
  const calls = [];
  sendEmailImplementation = async payload => ({
    accepted: [payload.to], rejected: [], responseCode: 451,
  });
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO notifications_log/.test(sql)) return { rows: [{ id: 'log-1', attempt_count: 1 }] };
      if (/FROM reminders reminder/.test(sql)) return { rows: [{
        id: '550e8400-e29b-41d4-a716-446655440000', title: 'Ambiguous', description: 'Body',
        active: true, trigger_day: 17, target_users: ['user-1'], channel: 'email', cms_document_id: null,
      }] };
      if (/FROM users/.test(sql)) return { rows: [{
        uid: 'user-1', email: 'user@example.com', name: 'User', contract_type: 'clt', is_pj: false,
        permissions: {},
      }] };
      return { rows: [] };
    },
  };

  await assert.rejects(
    processOccurrence(
      db,
      { id: '550e8400-e29b-41d4-a716-446655440000', title: 'Ambiguous', description: 'Body' },
      { uid: 'user-1', email: 'user@example.com', name: 'User' },
      '2026-08-17', 'email',
    ),
    /SMTP delivery result is ambiguous/,
  );
  assert.equal(calls.filter(({ sql }) => /UPDATE notifications_log/.test(sql)).length, 0);
  assert.equal(calls.filter(({ sql }) => /INSERT INTO notifications_log/.test(sql)).length, 1);
});

test('cron finalizes a pending retry when the reminder disappears before the next claim', async () => {
  const calls = [];
  let claimCount = 0;
  let reminderReads = 0;
  sendEmailImplementation = async () => {
    const error = new Error('try again');
    error.responseCode = 451;
    throw error;
  };
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/INSERT INTO notifications_log/.test(sql)) {
        claimCount += 1;
        if (claimCount === 1) return { rows: [{ id: 'log-1', attempt_count: 1 }] };
        const error = new Error('reminder no longer exists');
        error.code = '23503';
        throw error;
      }
      if (/FROM reminders reminder/.test(sql)) {
        reminderReads += 1;
        return reminderReads === 1 ? { rows: [{
          id: '550e8400-e29b-41d4-a716-446655440000', title: 'Removed', description: 'Body',
          active: true, trigger_day: 17, target_users: ['user-1'], channel: 'email', cms_document_id: null,
        }] } : { rows: [] };
      }
      if (/FROM users/.test(sql)) return { rows: [{
        uid: 'user-1', email: 'user@example.com', name: 'User', contract_type: 'clt', is_pj: false,
        permissions: {},
      }] };
      return { rows: [] };
    },
  };

  const result = await processOccurrence(
    db,
    { id: '550e8400-e29b-41d4-a716-446655440000', title: 'Removed', description: 'Body' },
    { uid: 'user-1', email: 'user@example.com', name: 'User' },
    '2026-08-17', 'email',
  );

  assert.equal(result, 'skipped');
  const finish = calls.find(({ sql }) => /SET status = \$2/.test(sql));
  assert.deepEqual(finish.params, ['log-1', 'skipped', 'reminder_removed']);
  assert.equal(claimCount, 2);
  assert.equal(sentEmails.length, 0);
});

test('cron isolates a permanent recipient failure and delivers the remaining candidates', async () => {
  sendEmailImplementation = async payload => {
    if (payload.to === 'failed@example.com') {
      const error = new Error('recipient rejected');
      error.responseCode = 550;
      throw error;
    }
    return successfulEmail(payload);
  };
  const db = {
    async query(sql, params = []) {
      if (/INSERT INTO notifications_log/.test(sql)) return { rows: [{ id: `log-${params[1]}`, attempt_count: 1 }] };
      if (/FROM users/.test(sql) && /FOR UPDATE/.test(sql)) {
        return { rows: params[0] === 'failed'
          ? [{ uid: 'failed', email: 'failed@example.com', name: 'Failed', contract_type: 'clt', is_pj: false }]
          : [{ uid: 'ok', email: 'ok@example.com', name: 'OK', contract_type: 'clt', is_pj: false }] };
      }
      if (/FROM reminders reminder/.test(sql)) return { rows: [{
        id: '550e8400-e29b-41d4-a716-446655440000', title: 'Isolated', description: 'Body',
        active: true, trigger_day: 17, target_users: 'all', channel: 'email', cms_document_id: null,
      }] };
      if (/SELECT uid, email, name/.test(sql)) return { rows: [
        { uid: 'failed', email: 'failed@example.com', name: 'Failed' },
        { uid: 'ok', email: 'ok@example.com', name: 'OK' },
      ] };
      return { rows: [] };
    },
  };

  assert.deepEqual(await processDate(db, '2026-08-17'), {
    attempted: 2, sent: 1, failed: 1, skipped: 0,
  });
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, 'ok@example.com');
});

test('cron recovers interrupted sends conservatively and does not reset attempts', async () => {
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/status IN \('sending', 'pending'\)/.test(sql)) {
        return { rows: [{ id: 'orphan-sending-1' }, { id: 'orphan-pending-1' }] };
      }
      if (/status = 'sending'/.test(sql)) return { rows: [{ id: 'sending-1' }] };
      if (/attempt_count >=/.test(sql)) return { rows: [{ id: 'exhausted-1' }] };
      return { rows: [] };
    },
  };
  assert.deepEqual(await recoverInterruptedDeliveries(db), {
    attempted: 4, sent: 0, failed: 2, skipped: 2,
  });
  assert.match(calls[0].sql, /status IN \('sending', 'pending'\)/);
  assert.doesNotMatch(calls[0].sql, /claimed_at < /);
  assert.match(calls[0].sql, /last_error = CASE/);
  assert.match(calls[0].sql, /reminder_removed/);
  assert.match(calls[0].sql, /recipient_removed/);
  assert.match(calls[1].sql, /status = 'sending'/);
  assert.match(calls[1].sql, /claimed_at < NOW\(\) - INTERVAL '1 hour'/);
  assert.match(calls[1].sql, /reminder_id IS NOT NULL/);
  assert.doesNotMatch(calls[1].sql, /last_error = CASE/);
  assert.deepEqual(calls[2].params, [3]);
});

test('cron execution with no candidates records no delivery attempts', async () => {
  const db = {
    async query(sql) {
      if (/FROM reminders reminder/.test(sql)) return { rows: [] };
      if (/SELECT uid, email, name/.test(sql)) return { rows: [] };
      return { rows: [] };
    },
  };
  assert.deepEqual(await processDate(db, '2026-08-17'), {
    attempted: 0, sent: 0, failed: 0, skipped: 0,
  });
});

test('checkReminders records heartbeat and separates partial delivery from execution success', async () => {
  const run = reminderRunFixture();
  const processedDates = [];
  const result = await checkReminders(new Date('2026-08-17T12:00:00Z'), {
    pool: run.pool,
    recoverInterruptedDeliveries: async () => {},
    promoteScheduledRevisions: async () => {},
    processDate: async (_db, date) => {
      processedDates.push(date);
      return { attempted: 2, sent: 1, failed: 1, skipped: 0 };
    },
  });

  assert.deepEqual(result, { attempted: 2, sent: 1, failed: 1, skipped: 0 });
  assert.deepEqual(processedDates, ['2026-08-17']);
  assert.equal(run.calls.filter(({ sql }) => /SET heartbeat_at = NOW\(\) WHERE name/.test(sql)).length, 1);
  const started = run.calls.find(({ sql }) => /INSERT INTO cron_status/.test(sql));
  assert.doesNotMatch(started.sql, /last_error = NULL/);
  const progress = run.calls.find(({ sql }) => /last_scheduled_date = \$2/.test(sql));
  assert.deepEqual(progress.params, ['reminders', '2026-08-17', 2, 1, 1, 0]);
  const completed = run.calls.find(({ sql }) => /last_finished_at = NOW\(\)/.test(sql));
  assert.match(completed.sql, /last_success_at = NOW\(\)/);
  assert.match(completed.sql, /last_error = NULL/);

  const emptyRun = reminderRunFixture();
  const empty = await checkReminders(new Date('2026-08-17T12:00:00Z'), {
    pool: emptyRun.pool,
    recoverInterruptedDeliveries: async () => {},
    promoteScheduledRevisions: async () => {},
  });
  assert.deepEqual(empty, { attempted: 0, sent: 0, failed: 0, skipped: 0 });
  const emptyCompleted = emptyRun.calls.find(({ sql }) => /last_finished_at = NOW\(\)/.test(sql));
  assert.deepEqual(emptyCompleted.params.slice(2), [0, 0, 0, 0]);
});

test('checkReminders records SMTP failures as delivery results while completing execution', async () => {
  const reminderId = '550e8400-e29b-41d4-a716-446655440000';
  const run = reminderRunFixture('2026-08-16', {
    reminder: {
      id: reminderId, title: 'SMTP failure', description: 'Body', active: true,
      trigger_day: 17, target_users: 'all', channel: 'email', cms_document_id: null,
    },
    user: {
      uid: 'user-1', email: 'user@example.com', name: 'User', contract_type: 'clt', is_pj: false,
      permissions: {},
    },
  });
  sendEmailImplementation = async () => {
    const error = new Error('recipient rejected');
    error.responseCode = 550;
    throw error;
  };

  const result = await checkReminders(new Date('2026-08-17T12:00:00Z'), {
    pool: run.pool,
    recoverInterruptedDeliveries: async () => {},
    promoteScheduledRevisions: async () => {},
  });

  assert.deepEqual(result, { attempted: 1, sent: 0, failed: 1, skipped: 0 });
  const completed = run.calls.find(({ sql }) => /last_finished_at = NOW\(\)/.test(sql));
  assert.match(completed.sql, /last_success_at = NOW\(\)/);
  assert.ok(run.calls.some(({ sql }) => /UPDATE notifications_log/.test(sql)));
});

test('checkReminders includes reaper recoveries in delivery totals without no-candidates status', async () => {
  const run = reminderRunFixture();
  const result = await checkReminders(new Date('2026-08-17T12:00:00Z'), {
    pool: run.pool,
    recoverInterruptedDeliveries: async () => ({ attempted: 2, sent: 0, failed: 1, skipped: 1 }),
    promoteScheduledRevisions: async () => {},
    processDate: async () => ({ attempted: 0, sent: 0, failed: 0, skipped: 0 }),
  });

  assert.deepEqual(result, { attempted: 2, sent: 0, failed: 1, skipped: 1 });
  const completed = run.calls.find(({ sql }) => /last_finished_at = NOW\(\)/.test(sql));
  assert.deepEqual(completed.params.slice(2), [2, 0, 1, 1]);
});

test('checkReminders propagates operational errors as execution failures', async () => {
  const run = reminderRunFixture();
  const operationalError = new Error('database unavailable');
  await assert.rejects(
    checkReminders(new Date('2026-08-17T12:00:00Z'), {
      pool: run.pool,
      recoverInterruptedDeliveries: async () => {},
      promoteScheduledRevisions: async () => {},
      processDate: async () => { throw operationalError; },
    }),
    operationalError,
  );
  const failed = run.calls.find(({ sql }) => /last_error = \$3/.test(sql));
  assert.equal(failed.params[2], 'database unavailable');
  assert.doesNotMatch(run.calls.map(({ sql }) => sql).join('\n'), /last_success_at = NOW\(\)/);
  assert.ok(run.calls.some(({ sql }) => sql === 'SELECT pg_advisory_unlock($1)'));
});

test('health signatures alert on execution failures and recover after heartbeat health returns', async () => {
  assert.equal(healthSignature(null), 'missing');
  assert.equal(healthSignature({ execution_error: 'database unavailable', fresh: true }), 'failed');
  assert.equal(healthSignature({ fresh: false }), 'stale-heartbeat');
  assert.equal(healthSignature({ fresh: true }), null);
  assert.equal(healthSignature({ running: true, fresh: true }), 'running');
  assert.equal(healthSignature({ running: true, fresh: true, execution_error: 'old failure' }), 'running');
  assert.equal(isExecutionRunning({ last_started_at: '2026-08-17T12:00:00Z', last_finished_at: null }), true);
  assert.equal(canRecover({ running: true, fresh: true, execution_succeeded: false }), false);
  assert.equal(canRecover({
    fresh: true, execution_succeeded: true,
    last_started_at: '2026-08-17T12:00:00Z', last_finished_at: '2026-08-17T12:30:00Z',
    last_success_at: '2026-08-17T11:30:00Z',
  }), false);
  assert.equal(healthSignature({ execution_error: 'Worker status missing', alert_signature: 'missing' }), 'missing');

  const rows = [
    {
      name: 'reminders', heartbeat_at: '2026-08-17T12:00:00.000Z',
      last_started_at: '2026-08-17T11:00:00.000Z', last_finished_at: '2026-08-17T11:30:00.000Z',
      last_success_at: '2026-08-17T10:30:00.000Z', execution_error: 'database unavailable',
      execution_succeeded: false, running: false, fresh: true, alert_signature: null,
    },
    {
      name: 'user-imports', heartbeat_at: '2026-08-17T12:00:00.000Z',
      last_started_at: '2026-08-17T11:00:00.000Z', last_finished_at: '2026-08-17T11:30:00.000Z',
      last_success_at: '2026-08-17T11:30:00.000Z', execution_error: null,
      execution_succeeded: true, running: false, fresh: true, alert_signature: null,
    },
    {
      name: 'retention', heartbeat_at: '2026-08-17T12:00:00.000Z',
      last_started_at: '2026-08-17T11:00:00.000Z', last_finished_at: '2026-08-17T11:30:00.000Z',
      last_success_at: '2026-08-17T11:30:00.000Z', execution_error: null,
      execution_succeeded: true, running: false, fresh: true, alert_signature: null,
    },
  ];
  const calls = [];
  const alerts = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/FROM cron_status/.test(sql)) return { rows };
      return { rows: [] };
    },
  };
  await assert.rejects(
    checkHealth({
      pool: db,
      sendOperationalAlert: async payload => { alerts.push(payload); return true; },
    }),
    /reminders/,
  );
  assert.equal(alerts[0].subject, 'falha no worker');
  assert.match(alerts[0].text, /database unavailable/);
  assert.ok(calls.some(({ sql }) => /UPDATE cron_status SET alert_signature/.test(sql)));
  const healthQuery = calls.find(({ sql }) => /FROM cron_status/.test(sql));
  assert.match(healthQuery.sql, /heartbeat_at/);
  assert.match(healthQuery.sql, /AS running/);
  assert.match(healthQuery.sql, /AS execution_succeeded/);

  rows[0].execution_error = null;
  rows[0].running = true;
  rows[0].execution_succeeded = false;
  rows[0].last_finished_at = null;
  rows[0].last_success_at = '2026-08-17T10:30:00.000Z';
  rows[0].alert_signature = 'failed';
  alerts.length = 0;
  await checkHealth({
    pool: db,
    sendOperationalAlert: async payload => { alerts.push(payload); return true; },
  });
  assert.deepEqual(alerts, []);
  assert.equal(calls.filter(({ sql }) => /alert_signature = NULL/.test(sql)).length, 0);

  rows[0].running = false;
  rows[0].execution_succeeded = true;
  rows[0].last_finished_at = '2026-08-17T12:30:00.000Z';
  rows[0].last_success_at = '2026-08-17T12:30:00.000Z';
  await checkHealth({
    pool: db,
    sendOperationalAlert: async payload => { alerts.push(payload); return true; },
  });
  assert.equal(alerts[0].subject, 'worker recuperado');
  assert.ok(calls.some(({ sql }) => /alert_signature = NULL/.test(sql)));
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
