import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  civilDateKey, dueDateKeys, normalizeDateKey, reminderIsEligibleForDate, reminderMatchesDate,
  resolveTargets, zonedDateTime,
} = require('../../cron/scheduling');
const { isRetryableUnsent, reminderContentUrl } = require('../../cron/checkReminders');
const {
  classifySmtpCode, classifySmtpError, classifySmtpResult, smtpResponseCode,
} = require('../../cron/mailTransport');
const { reminderContentPath } = require('../../api/cms/blocks');
const { targetUsers } = require('../../api/route-utils');
const { retentionDays } = require('../../cron/retention');
const { autocardMediaRetentionDays, isSafeStorageKey } = require('../../cron/autocard-media-retention');

test('reminder retries include transient SMTP responses without retrying permanent auth errors', () => {
  assert.equal(isRetryableUnsent({ response: { statusCode: 429 } }), true);
  assert.equal(isRetryableUnsent({ response: { statusCode: 503 } }), true);
  assert.equal(isRetryableUnsent({ responseCode: 421 }), true);
  assert.equal(isRetryableUnsent({ responseCode: 451 }), true);
  assert.equal(isRetryableUnsent({ responseCode: 535 }), false);
  assert.equal(classifySmtpCode(550), 'permanent');
  assert.equal(classifySmtpError({ response: '451 4.3.0 Try again' }), 'retryable');
  assert.equal(classifySmtpError({ responseCode: 550 }), 'permanent');
  assert.equal(classifySmtpError({ code: 'ETIMEDOUT' }), 'retryable');
  assert.equal(classifySmtpResult(undefined, 'user@example.com'), 'unknown');
  assert.equal(classifySmtpResult({ responseCode: 550 }, 'user@example.com'), 'permanent');
  assert.equal(classifySmtpResult({ accepted: ['user@example.com'], responseCode: 550 }, 'user@example.com'), 'permanent');
  assert.equal(classifySmtpResult({ accepted: ['user@example.com'], responseCode: 451 }, 'user@example.com'), 'unknown');
  assert.equal(classifySmtpResult({ response: '250 queued' }, 'user@example.com'), 'unknown');
  assert.equal(classifySmtpResult({ accepted: ['user@example.com'] }, 'user@example.com'), 'accepted');
  assert.equal(classifySmtpResult({ rejected: ['user@example.com'], responseCode: 451 }, 'user@example.com'), 'retryable');
  assert.equal(classifySmtpResult({ rejected: ['user@example.com'] }, 'user@example.com'), 'permanent');
  assert.equal(classifySmtpResult({ accepted: [], rejected: [] }, 'user@example.com'), 'unknown');
  assert.equal(smtpResponseCode({ response: '550 5.1.1 rejected' }), 550);
});

test('SMTP recipient state conflicts are ambiguous and never retryable', () => {
  const recipient = 'user@example.com';
  assert.equal(classifySmtpResult({ accepted: [recipient], rejected: [recipient] }, recipient), 'unknown');
  assert.equal(classifySmtpResult({ accepted: [recipient], pending: [recipient], responseCode: 451 }, recipient), 'unknown');
  assert.equal(classifySmtpResult({ rejected: [recipient], pending: [recipient], responseCode: 451 }, recipient), 'unknown');
  assert.equal(classifySmtpError({ accepted: [recipient], rejected: [recipient], responseCode: 451 }, recipient), 'unknown');
});

test('catch-up uses Brasilia time and is bounded to seven completed schedule dates', () => {
  assert.deepEqual(
    dueDateKeys(new Date('2026-07-20T12:00:00Z'), '2026-07-17'),
    ['2026-07-18', '2026-07-19', '2026-07-20']
  );
  assert.deepEqual(
    dueDateKeys(new Date('2026-07-20T10:00:00Z'), null),
    ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19']
  );
});

test('catch-up accepts PostgreSQL DATE values returned as JavaScript Date objects', () => {
  assert.equal(normalizeDateKey(new Date('2026-07-20T00:00:00.000Z')), '2026-07-20');
  assert.deepEqual(dueDateKeys(new Date('2026-07-21T12:00:00.000Z'), new Date('2026-07-20T00:00:00.000Z')), ['2026-07-21']);
  assert.throws(() => normalizeDateKey('not-a-date'), /Invalid scheduled date/);
});

test('civil reminder dates and creation vigência stay in São Paulo', () => {
  assert.equal(civilDateKey(new Date('2026-07-21T02:00:00Z')), '2026-07-20');
  assert.equal(reminderIsEligibleForDate(new Date('2026-07-20T10:59:59Z'), '2026-07-20'), true);
  assert.equal(reminderIsEligibleForDate(new Date('2026-07-20T11:00:01Z'), '2026-07-20'), false);
  assert.equal(reminderIsEligibleForDate(new Date('2026-07-19T12:00:00Z'), '2026-07-20'), true);
  assert.equal(zonedDateTime('2026-07-20').toISOString(), '2026-07-20T11:00:00.000Z');
});

test('days 29 through 31 run on the last day of a short month', () => {
  for (const triggerDay of [29, 30, 31]) {
    assert.equal(reminderMatchesDate(triggerDay, '2026-02-28'), true);
  }
  assert.equal(reminderMatchesDate(31, '2026-04-30'), true);
  assert.equal(reminderMatchesDate(29, '2028-02-29'), true);
  assert.equal(reminderMatchesDate(29, '2026-02-27'), false);
});

test('target resolution isolates all, contract groups, and explicit UIDs', () => {
  const users = [
    { uid: 'clt', contract_type: 'clt', is_pj: false },
    { uid: 'pj', contract_type: 'pj', is_pj: true },
    { uid: 'legacy-pj', contract_type: 'clt', is_pj: true }
  ];

  assert.deepEqual(resolveTargets('all', users).map((user) => user.uid), ['clt', 'pj', 'legacy-pj']);
  assert.deepEqual(resolveTargets('pj', users).map((user) => user.uid), ['pj', 'legacy-pj']);
  assert.deepEqual(resolveTargets('clt', users).map((user) => user.uid), ['clt']);
  assert.deepEqual(resolveTargets(['pj', 'missing', 'pj'], users).map((user) => user.uid), ['pj']);
  assert.deepEqual(resolveTargets('unknown', users), []);
});

test('reminder audiences reject empty or malformed UIDs and keep the public content path constrained', () => {
  assert.equal(targetUsers([]), false);
  assert.equal(targetUsers(['valid.uid']), true);
  assert.equal(targetUsers(['has space']), false);
  assert.equal(targetUsers(['valid.uid', 'valid.uid']), false);
  const id = '550e8400-e29b-41d4-a716-446655440000';
  assert.equal(reminderContentPath(id.toUpperCase()), '/reminders.html#reminder-550e8400-e29b-41d4-a716-446655440000');
  assert.equal(reminderContentPath('not-an-id'), null);
  assert.equal(reminderContentUrl(id, { PORTAL_PUBLIC_URL: 'https://portal.example.test', NODE_ENV: 'production' }), 'https://portal.example.test/reminders.html#reminder-550e8400-e29b-41d4-a716-446655440000');
  assert.throws(() => reminderContentUrl(id, { PORTAL_PUBLIC_URL: 'http://portal.example.test', NODE_ENV: 'production' }), /Invalid PORTAL_PUBLIC_URL/);
});

test('retention windows are bounded and configurable', () => {
  assert.deepEqual(retentionDays({}), { notifications: 730, audit: 1825, pendingRegistrations: 730 });
  assert.throws(() => retentionDays({ AUDIT_RETENTION_DAYS: '0' }), /between 30 and 3650/);
});

test('import retention has only the privileges required by its DELETE predicate', async () => {
  const [retention, provision, verification] = await Promise.all([
    readFile('cron/retention.js', 'utf8'),
    readFile('api/db/provision.js', 'utf8'),
    readFile('api/db/verify-migrations.js', 'utf8'),
  ]);
  assert.match(retention, /DELETE FROM user_import_jobs WHERE expires_at < NOW\(\)/);
  assert.match(provision, /GRANT DELETE ON user_import_jobs TO portal_cron/);
  assert.match(provision, /GRANT SELECT \(expires_at\) ON user_import_jobs TO portal_cron/);
  assert.match(verification, /has_column_privilege\('portal_cron', 'public\.user_import_jobs', 'expires_at', 'SELECT'\)/);
  assert.match(verification, /NOT has_table_privilege\('portal_cron', 'public\.user_import_jobs', 'UPDATE'\)/);
});

test('AutoCard media orphan retention defaults and stays bounded', () => {
  assert.equal(autocardMediaRetentionDays({}), 7);
  assert.equal(autocardMediaRetentionDays({ AUTOCARD_MEDIA_ORPHAN_DAYS: '1' }), 1);
  assert.equal(autocardMediaRetentionDays({ AUTOCARD_MEDIA_ORPHAN_DAYS: '3650' }), 3650);
  assert.throws(() => autocardMediaRetentionDays({ AUTOCARD_MEDIA_ORPHAN_DAYS: '0' }), /between 1 and 3650/);
  assert.throws(() => autocardMediaRetentionDays({ AUTOCARD_MEDIA_ORPHAN_DAYS: '3651' }), /between 1 and 3650/);
  assert.throws(() => autocardMediaRetentionDays({ AUTOCARD_MEDIA_ORPHAN_DAYS: '1.5' }), /between 1 and 3650/);
});

test('AutoCard media storage keys require a UUID-shaped filename', () => {
  assert.equal(isSafeStorageKey('autocard-123e4567-e89b-12d3-a456-426614174000.webp'), true);
  for (const key of [
    'autocard-123E4567-E89B-12D3-A456-426614174000.webp',
    'autocard-123e4567-e89b-12d3-a456-42661417400.webp',
    'autocard-123e4567-e89b-12d3-a456-426614174000.jpg',
    'autocard-123e4567-e89b-12d3-a456-426614174000.webp.bak',
    'autocard-123e4567-e89b-12d3-a456-426614174000/other.webp',
    'autocard-123e4567-e89b-12d3-a456-426614174000.webp/..',
  ]) {
    assert.equal(isSafeStorageKey(key), false, key);
  }
});

test('AutoCard retention rethrows audit completion failures after logging them', async () => {
  const cleanup = await readFile('cron/autocard-media-retention.js', 'utf8');
  const failureStart = cleanup.indexOf("event: 'autocard_media_retention_audit_update_failed'");
  const successStart = cleanup.indexOf("event: 'autocard_media_retention_completed'");
  assert.ok(failureStart >= 0 && successStart > failureStart);
  const failureHandler = cleanup.slice(failureStart, successStart);
  assert.match(failureHandler, /throw error/);
  assert.doesNotMatch(failureHandler, /return details/);
});
