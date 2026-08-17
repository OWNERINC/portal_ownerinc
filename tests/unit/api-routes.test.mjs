import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const calls = [];
let solidesLink = null;
let solidesPayload = null;
const pool = {
  async query(sql, params = []) {
    calls.push({ sql, params });
    if (/FROM solides_employee_links WHERE user_uid/.test(sql)) return { rows: solidesLink ? [solidesLink] : [] };
    if (/INSERT INTO solides_employee_links/.test(sql)) return { rows: [{
      user_uid: params[0], employee_id: params[1], external_id: params[2], employer_scope: params[3],
      status: params[4], matched_by: params[5],
    }] };
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: 0 }] };
    return { rows: [] };
  },
  async connect() {
    return { query: this.query.bind(this), release() {} };
  },
};

const dbPath = require.resolve('./db');
const authPath = require.resolve('./middleware/auth');
const policy = require('./middleware/policy');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
require.cache[authPath] = {
  id: authPath,
  filename: authPath,
  loaded: true,
  exports: {
    authMiddleware(req, res, next) {
      req.id = 'test-request';
      req.user = req.get('x-test-admin') === 'true'
        ? { uid: 'admin-1', role: 'admin', contract_type: 'clt', is_pj: false, permissions: { manageReminders: true, manageAcademy: true, manageSolides: true } }
        : { uid: 'viewer-1', role: 'viewer', contract_type: 'clt', is_pj: false, permissions: {} };
      next();
    },
    can: policy.can,
  },
};
const solidesPath = require.resolve('./integrations/solides');
const solides = require(solidesPath);
require.cache[solidesPath] = {
  id: solidesPath,
  filename: solidesPath,
  loaded: true,
  exports: {
    ...solides,
    solidesCheck: async () => ({ ok: true, status: 200, durationMs: 1, shape: { kind: 'object' } }),
    solidesJson: async () => solidesPayload,
  },
};

const express = require('express');
const request = require('supertest');
const app = express();
app.use(express.json());
app.use('/api/reminders', require('./routes/reminders'));
app.use('/api/academy', require('./routes/academy'));
app.use('/api/solides', require('./routes/solides'));

test.beforeEach(() => {
  calls.length = 0;
  solidesLink = null;
  solidesPayload = null;
  process.env.SOLIDES_RELEASE_STAGE = 'off';
  delete process.env.SOLIDES_PILOT_UIDS;
});

test('CMS route modules are registered without exposing a public asset mount', async () => {
  const source = await readFile('api/index.js', 'utf8');
  assert.match(source, /app\.use\('\/api\/cms',\s+require\('\.\/routes\/cms'\)\)/);
  assert.match(source, /app\.use\('\/api\/cms\/assets',\s+require\('\.\/routes\/cms-assets'\)\)/);
  assert.doesNotMatch(source, /express\.static\([^)]*cms/i);
});

test('ordinary reminder reads are always active and audience scoped', async () => {
  const response = await request(app).get('/api/reminders');
  assert.equal(response.status, 200);
  assert.match(calls[0].sql, /active = TRUE/);
  assert.match(calls[0].sql, /target_users/);
  assert.deepEqual(calls[0].params, ['clt', 'viewer-1']);
});

test('upcoming reminders are scoped and require the fixed seven-day contract', async () => {
  assert.equal((await request(app).get('/api/reminders/upcoming')).status, 400);
  calls.length = 0;
  const response = await request(app).get('/api/reminders/upcoming?days=7');
  assert.equal(response.status, 200);
  assert.match(calls[0].sql, /active = TRUE/);
  assert.match(calls[0].sql, /target_users/);
  assert.deepEqual(calls[0].params, ['clt', 'viewer-1']);
});

test('only reminder managers can request inactive and all-audience records', async () => {
  assert.equal((await request(app).get('/api/reminders?all=true')).status, 403);
  const response = await request(app).get('/api/reminders?all=true').set('x-test-admin', 'true');
  assert.equal(response.status, 200);
  assert.doesNotMatch(calls.at(-2).sql, /active = TRUE/);
});

test('ordinary academy reads are active-only and unsafe URLs fail before SQL', async () => {
  assert.equal((await request(app).get('/api/academy')).status, 200);
  assert.match(calls[0].sql, /active = TRUE/);
  calls.length = 0;
  const response = await request(app)
    .post('/api/academy')
    .set('x-test-admin', 'true')
    .send({ title: 'Unsafe', url: 'javascript:alert(1)' });
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test('Sólides tools are undiscoverable until an explicit release stage grants access', async () => {
  assert.equal((await request(app).get('/api/solides/me/status')).status, 404);
  assert.equal(calls.length, 0);

  process.env.SOLIDES_RELEASE_STAGE = 'pilot';
  process.env.SOLIDES_PILOT_UIDS = 'viewer-1';
  const response = await request(app).get('/api/solides/me/status');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { available: true, stage: 'pilot', linked: false, linkStatus: 'missing' });
  assert.equal(calls.length, 1);
});

test('Sólides internal stage exposes administration but not employee tools', async () => {
  process.env.SOLIDES_RELEASE_STAGE = 'internal';
  assert.equal((await request(app).get('/api/solides/me/status').set('x-test-admin', 'true')).status, 404);
  assert.equal((await request(app).get('/api/solides/admin/status')).status, 404);
  assert.equal((await request(app).get('/api/solides/admin/status').set('x-test-admin', 'true')).status, 200);
  const probe = await request(app).post('/api/solides/admin/probe').set('x-test-admin', 'true').send({});
  assert.equal(probe.status, 200);
  assert.equal(probe.body.employeeProbeEnabled, false);
  assert.equal('token' in probe.body, false);
});

test('Sólides employee probe covers every prepared read-only service without response data', async () => {
  process.env.SOLIDES_RELEASE_STAGE = 'internal';
  solidesLink = { employee_id: '42', status: 'pending' };
  const probe = await request(app).post('/api/solides/admin/probe').set('x-test-admin', 'true').send({ userUid: 'viewer-1' });
  assert.equal(probe.status, 200);
  assert.deepEqual(probe.body.checks.map(({ name }) => name), [
    'employer.test', 'employer.employee', 'punch.summary', 'punch.history', 'punch.hoursBalance', 'employer.adjustments',
  ]);
  assert.equal(JSON.stringify(probe.body).includes('employeeId'), false);
});

test('Sólides administration remains gated across the release matrix', async () => {
  for (const stage of ['off', 'internal', 'pilot', 'general', 'manager', 'write']) {
    process.env.SOLIDES_RELEASE_STAGE = stage;
    const response = await request(app).get('/api/solides/admin/status').set('x-test-admin', 'true');
    assert.equal(response.status, stage === 'off' ? 404 : 200, stage);
  }
});

test('Sólides adjustments discard foreign, unidentified, and free-text data', async () => {
  process.env.SOLIDES_RELEASE_STAGE = 'pilot';
  process.env.SOLIDES_PILOT_UIDS = 'viewer-1';
  solidesLink = { employee_id: '42', status: 'verified' };
  solidesPayload = { content: [
    { id: 1, employeeId: 42, reason: 'private', notes: 'private', status: 'APROVADO' },
    { id: 2, employeeId: 99, reason: 'foreign' },
    { id: 3, reason: 'unidentified' },
  ] };

  const response = await request(app).get('/api/solides/me/adjustments?from=2026-01-01&to=2026-12-31');
  assert.equal(response.status, 200);
  assert.equal(response.body.entries.length, 1);
  assert.equal(response.body.entries[0].id, '1');
  assert.equal('reason' in response.body.entries[0], false);
  assert.equal('notes' in response.body.entries[0], false);
});

test('Sólides personal routes keep every response scoped to the linked employee', async () => {
  process.env.SOLIDES_RELEASE_STAGE = 'pilot';
  process.env.SOLIDES_PILOT_UIDS = 'viewer-1';
  solidesLink = { employee_id: '42', status: 'verified' };

  solidesPayload = { content: [
    { employeeId: 99, status: 'APPROVED' },
    { employeeId: 42, status: 'APPROVED', startDateTimestamp: '2026-07-21T09:00:00-03:00' },
  ] };
  const summary = await request(app).get('/api/solides/me/summary?date=2026-07-21');
  assert.equal(summary.status, 200);
  assert.deepEqual(summary.body.entries.map((entry) => entry.employeeId), ['42']);

  solidesPayload = { content: [
    { id: 1, employeeId: 99, photoIn: 'foreign' },
    { id: 2, employeeId: 42, photoIn: 'private', locationIn: { latitude: 1 } },
  ], totalElements: 2 };
  const punches = await request(app).get('/api/solides/me/punches?from=2026-07-01&to=2026-07-21&limit=50&offset=0');
  assert.equal(punches.status, 200);
  assert.deepEqual(punches.body.entries.map((entry) => entry.id), ['2']);
  assert.equal(punches.headers['x-total-count'], undefined);
  assert.equal('photoIn' in punches.body.entries[0], false);
  assert.equal('locationIn' in punches.body.entries[0], false);

  solidesPayload = { content: [
    { employeeId: 99, hoursBalanceInMinutes: 9999 },
    { employeeId: 42, hoursBalanceInMinutes: 75 },
  ] };
  const balance = await request(app).get('/api/solides/me/hours-balance?from=2026-07-01&to=2026-07-21');
  assert.equal(balance.status, 200);
  assert.equal(balance.body.hoursBalanceInMinutes, 75);

  solidesPayload = { id: 99, name: 'Foreign employee' };
  assert.equal((await request(app).get('/api/solides/me/schedule')).status, 503);

  solidesPayload = { id: 42, name: 'Former employee', fired: true };
  assert.equal((await request(app).get('/api/solides/me/schedule')).status, 503);

  solidesPayload = { id: 42, name: 'Linked employee', cpf: 'private', currentWorkSchedule: null };
  const schedule = await request(app).get('/api/solides/me/schedule');
  assert.equal(schedule.status, 200);
  assert.equal(schedule.body.employee.employeeId, '42');
  assert.equal('cpf' in schedule.body.employee, false);
  assert.equal(calls.some(({ sql }) => /UPDATE solides_employee_links SET last_seen_at = NOW\(\)/.test(sql)), true);
});

test('Sólides links cannot skip the pending verification step', async () => {
  process.env.SOLIDES_RELEASE_STAGE = 'internal';
  const response = await request(app).put('/api/solides/admin/links/viewer-1').set('x-test-admin', 'true').send({
    employeeId: '42', externalId: null, employerScope: 'default', status: 'verified', matchedBy: 'manual',
  });
  assert.equal(response.status, 409);
  assert.match(response.body.error, /pending/);
});

test('Sólides verifies the upstream employee before releasing a pending link', async () => {
  process.env.SOLIDES_RELEASE_STAGE = 'internal';
  solidesLink = { employee_id: '42', status: 'pending' };
  const body = { employeeId: '42', externalId: 'owner-42', employerScope: 'default', status: 'verified', matchedBy: 'external_id' };

  solidesPayload = { id: 99, externalId: 'owner-42' };
  const mismatch = await request(app).put('/api/solides/admin/links/viewer-1').set('x-test-admin', 'true').send(body);
  assert.equal(mismatch.status, 409);

  solidesPayload = { id: 42, externalId: 'owner-42', cpf: 'private' };
  const verified = await request(app).put('/api/solides/admin/links/viewer-1').set('x-test-admin', 'true').send(body);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.status, 'verified');
  assert.equal('cpf' in verified.body, false);
});
