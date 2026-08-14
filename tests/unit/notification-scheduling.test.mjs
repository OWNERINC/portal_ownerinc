import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { dueDateKeys, normalizeDateKey, reminderMatchesDate, resolveTargets } = require('../../cron/scheduling');
const { retentionDays } = require('../../cron/retention');
const { autocardMediaRetentionDays, isSafeStorageKey } = require('../../cron/autocard-media-retention');

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

test('retention windows are bounded and configurable', () => {
  assert.deepEqual(retentionDays({}), { notifications: 730, ombudsman: 730, audit: 1825 });
  assert.throws(() => retentionDays({ AUDIT_RETENTION_DAYS: '0' }), /between 30 and 3650/);
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
