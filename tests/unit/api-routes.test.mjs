import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const calls = [];
let solidesLink = null;
let solidesPayload = null;
const contentRows = { academy: [], benefits: [], knowledge: [], reminders: [] };
let cmsRows = [];
let deliveryRows = [];
let deliveryCount = 0;
let cronStatus = null;
const pool = {
  async query(sql, params = []) {
    calls.push({ sql, params });
    if (/FROM solides_employee_links WHERE user_uid/.test(sql)) return { rows: solidesLink ? [solidesLink] : [] };
    if (/INSERT INTO solides_employee_links/.test(sql)) return { rows: [{
      user_uid: params[0], employee_id: params[1], external_id: params[2], employer_scope: params[3],
      status: params[4], matched_by: params[5],
    }] };
    if (/FOR UPDATE OF s/.test(sql)) {
      const sourceIds = params[0] || [];
      return { rows: sourceIds.map(sourceId => ({
        source_id: sourceId,
        source_active: Object.values(contentRows).flat().find(row => row.id === sourceId)?.active !== false,
        document_id: null,
      })) };
    }
    if (/FROM (knowledge_base|academy|benefits|reminders) s/.test(sql)) {
      const contentKeys = { academy: 'academy', benefit: 'benefits', knowledge: 'knowledge', reminder: 'reminders' };
      const contentKey = contentKeys[params[0]];
      const sourceIds = params[1] || [];
      return {
        rows: (contentKey ? contentRows[contentKey] : []).filter(row => sourceIds.includes(row.id)).map(row => {
          const document = cmsRows.find(item => item.content_type === params[0] && item.source_id === row.id);
          return {
            source_id: row.id,
            source_active: row.active !== false,
            document_id: document ? document.document_id || 'cms-document' : null,
            blocks: document?.published ? document.blocks : null,
          };
        }),
      };
    }
    if (/SELECT d\.source_id, r\.blocks/.test(sql)) {
      const [contentType, sourceIds] = params;
      return { rows: cmsRows
        .filter(row => row.content_type === contentType && sourceIds.includes(row.source_id))
        .map(row => ({ source_id: row.source_id, blocks: row.published ? row.blocks : null })) };
    }
    if (/FROM cron_status/.test(sql)) return { rows: cronStatus ? [cronStatus] : [] };
    const tableNames = { academy: 'academy', benefits: 'benefits', knowledge: 'knowledge_base', reminders: 'reminders' };
    const table = Object.entries(tableNames).find(([, tableName]) => new RegExp(`FROM ${tableName}\\b`).test(sql))?.[0];
    if (/^\s*SELECT/i.test(sql) && table && !/COUNT\(\*\)/.test(sql)) {
      let rows = /WHERE id = \$1/.test(sql)
        ? contentRows[table].filter(row => row.id === params[0])
        : contentRows[table];
      if (table === 'reminders' && /WHERE id = \$1 AND active = TRUE/.test(sql)) {
        const [id, audience, uid] = params;
        rows = rows.filter((row) => row.active !== false
          && (params.length < 3 || row.target_users === 'all' || row.target_users === audience
            || (Array.isArray(row.target_users) && row.target_users.includes(uid))));
      }
      return { rows };
    }
    if (/COUNT\(\*\)/.test(sql)) {
      return { rows: [{ count: /FROM notifications_log/.test(sql) ? deliveryCount : 0 }] };
    }
    if (/SELECT notifications_log\.id/.test(sql)) return { rows: deliveryRows };
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
        ? { uid: 'admin-1', role: 'admin', contract_type: 'clt', is_pj: false, permissions: { manageReminders: true, manageAcademy: true, manageBenefits: true, manageKnowledge: true, manageSolides: true } }
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
app.use('/api/benefits', require('./routes/benefits'));
app.use('/api/knowledge', require('./routes/knowledge'));
app.use('/api/solides', require('./routes/solides'));

test.beforeEach(() => {
  calls.length = 0;
  solidesLink = null;
  solidesPayload = null;
  for (const rows of Object.values(contentRows)) rows.length = 0;
  cmsRows = [];
  deliveryRows = [];
  deliveryCount = 0;
  cronStatus = null;
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
  const read = calls.find(({ sql }) => /FROM reminders/.test(sql));
  assert.match(read.sql, /active = TRUE/);
  assert.match(read.sql, /target_users/);
  assert.deepEqual(read.params, ['clt', 'viewer-1']);
});

test('upcoming reminders are scoped and require the fixed seven-day contract', async () => {
  assert.equal((await request(app).get('/api/reminders/upcoming')).status, 400);
  calls.length = 0;
  const response = await request(app).get('/api/reminders/upcoming?days=7');
  assert.equal(response.status, 200);
  const read = calls.find(({ sql }) => /FROM reminders/.test(sql));
  assert.match(read.sql, /active = TRUE/);
  assert.match(read.sql, /target_users/);
  assert.deepEqual(read.params, ['clt', 'viewer-1']);
});

test('reminder details are authenticated, scoped, active, CMS-visible, and linkable', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  contentRows.reminders.push({
    id, title: 'Detalhe', description: 'Conteúdo', active: true, target_users: 'all', trigger_day: 10,
  });

  const invalid = await request(app).get('/api/reminders/not-an-id');
  assert.equal(invalid.status, 404);
  assert.deepEqual(invalid.body, { error: 'Reminder not found.', requestId: 'test-request' });
  assert.equal(calls.length, 0);

  const response = await request(app).get(`/api/reminders/${id}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.id, id);
  assert.equal(response.body.content_url, `/reminders.html#reminder-${id}`);
  const read = calls.find(({ sql }) => /SELECT \* FROM reminders/.test(sql));
  assert.ok(read);
  assert.match(read.sql, /id = \$1 AND active = TRUE/);
  assert.match(read.sql, /cms_documents/);
  assert.match(read.sql, /target_users/);
  assert.deepEqual(read.params, [id, 'clt', 'viewer-1']);

  for (const change of [
    { active: false, target_users: 'all' },
    { active: true, target_users: ['another-user'] },
  ]) {
    contentRows.reminders[0] = { ...contentRows.reminders[0], ...change };
    calls.length = 0;
    const hidden = await request(app).get(`/api/reminders/${id}`);
    assert.equal(hidden.status, 404, JSON.stringify(change));
  }

  contentRows.reminders[0] = { ...contentRows.reminders[0], active: true, target_users: 'all' };
  cmsRows = [{ content_type: 'reminder', source_id: id, published: false, blocks: [] }];
  calls.length = 0;
  const unpublished = await request(app).get(`/api/reminders/${id}`);
  assert.equal(unpublished.status, 404);
});

test('cron status exposes heartbeat, execution state, and delivery state separately', async () => {
  cronStatus = {
    name: 'reminders', heartbeat_at: '2026-08-17T12:00:00.000Z', last_error: null,
    attempted_count: 2, sent_count: 1, failed_count: 1, skipped_count: 0,
    execution_status: 'succeeded', delivery_status: 'partial_failure',
  };
  const response = await request(app).get('/api/reminders/cron-status').set('x-test-admin', 'true');
  assert.equal(response.status, 200);
  assert.equal(response.body.execution_status, 'succeeded');
  assert.equal(response.body.delivery_status, 'partial_failure');
  assert.equal(response.body.heartbeat_at, cronStatus.heartbeat_at);
  const read = calls.find(({ sql }) => /FROM cron_status/.test(sql));
  assert.match(read.sql, /CASE[\s\S]*execution_status/);
  assert.match(read.sql, /CASE[\s\S]*delivery_status/);
});

test('reminder writes reject empty or malformed audiences and channels absent from the form', async () => {
  for (const target of [[], ['has space'], ['valid.uid', 'valid.uid']]) {
    calls.length = 0;
    const response = await request(app)
      .post('/api/reminders')
      .set('x-test-admin', 'true')
      .send({ title: 'Reminder', trigger_day: 10, target_users: target, channel: 'email' });
    assert.equal(response.status, 400, JSON.stringify(target));
    assert.equal(calls.length, 0, JSON.stringify(target));
  }
  calls.length = 0;
  const channel = await request(app)
    .post('/api/reminders')
    .set('x-test-admin', 'true')
    .send({ title: 'Reminder', trigger_day: 10, target_users: 'all', channel: 'both' });
  assert.equal(channel.status, 400);
  assert.equal(calls.length, 0);
});

test('delivery history returns reminder, recipient, reason, stable ID, and pagination fields', async () => {
  const reminderId = '00000000-0000-4000-8000-000000000001';
  deliveryRows = [{
    id: '00000000-0000-4000-8000-000000000002', reminder_id: reminderId,
    scheduled_date: '2026-08-17', status: 'failed', attempt_count: 2,
  }];
  deliveryCount = 1;
  const response = await request(app)
    .get('/api/reminders/deliveries?limit=20&offset=20&status=failed&reminder_id=00000000-0000-4000-8000-000000000001');
  assert.equal(response.status, 403);
  const adminResponse = await request(app)
    .get('/api/reminders/deliveries?limit=20&offset=20&status=failed&reminder_id=00000000-0000-4000-8000-000000000001')
    .set('x-test-admin', 'true');
  assert.equal(adminResponse.status, 200);
  assert.equal(adminResponse.headers['x-total-count'], '1');
  assert.equal(adminResponse.body[0].content_url, `/reminders.html#reminder-${reminderId}`);
  const history = calls.find(({ sql }) => /SELECT notifications_log\.id/.test(sql));
  assert.ok(history);
  assert.match(history.sql, /scheduled_date::text AS scheduled_date/);
  assert.match(history.sql, /LEFT JOIN reminders/);
  assert.match(history.sql, /LEFT JOIN users/);
  assert.match(history.sql, /last_error AS reason/);
  assert.match(history.sql, /ORDER BY notifications_log\.scheduled_date/);
  assert.deepEqual(history.params, ['failed', '00000000-0000-4000-8000-000000000001', 20, 20]);
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

test('public CMS lists, categories, counts, and details exclude unpublished documents', async () => {
  const legacyId = '00000000-0000-4000-8000-000000000001';
  const hiddenId = '00000000-0000-4000-8000-000000000002';
  contentRows.academy.push(
    { id: legacyId, category: 'Legacy', active: true },
    { id: hiddenId, category: 'Hidden', active: true },
  );
  contentRows.benefits.push(
    { id: legacyId, category: 'Legacy', active: true },
    { id: hiddenId, category: 'Hidden', active: true },
  );
  contentRows.knowledge.push(
    { id: legacyId, category: 'Legacy', title: 'Legacy', content: 'Body' },
    { id: hiddenId, category: 'Hidden', title: 'Hidden', content: 'Body' },
  );
  contentRows.reminders.push({
    id: hiddenId, title: 'Hidden reminder', active: true, target_users: ['all'], trigger_day: 1,
  });
  cmsRows.push(
    { content_type: 'academy', source_id: hiddenId, published: false, blocks: [] },
    { content_type: 'benefit', source_id: hiddenId, published: false, blocks: [] },
    { content_type: 'knowledge', source_id: hiddenId, published: false, blocks: [] },
    { content_type: 'reminder', source_id: hiddenId, published: false, blocks: [] },
  );

  for (const path of ['/api/academy', '/api/benefits']) {
    const response = await request(app).get(`${path}?limit=1&offset=0`);
    assert.equal(response.status, 200, path);
    assert.deepEqual(response.body.map(row => row.id), [legacyId], path);
    assert.equal(response.headers['x-total-count'], '1', path);
    const categories = await request(app).get(`${path}/categories`);
    assert.deepEqual(categories.body, ['Legacy'], path);
  }

  const allAcademy = await request(app).get('/api/academy?all=true').set('x-test-admin', 'true');
  const allBenefits = await request(app).get('/api/benefits?all=true').set('x-test-admin', 'true');
  assert.equal(allAcademy.status, 200);
  assert.equal(allBenefits.status, 200);
  assert.equal(allAcademy.body.length, 2);
  assert.equal(allBenefits.body.length, 2);
  assert.equal((await request(app).get(`/api/knowledge/${hiddenId}`)).status, 404);
  const knowledge = await request(app).get('/api/knowledge?limit=1&offset=0');
  assert.equal(knowledge.status, 200);
  assert.deepEqual(knowledge.body.map(row => row.id), [legacyId]);
  assert.equal(knowledge.headers['x-total-count'], '1');
  const search = await request(app).get('/api/knowledge?q=body&limit=1&offset=0');
  assert.equal(search.status, 200);
  assert.deepEqual(search.body.map(row => row.id), [legacyId]);
  assert.equal(search.headers['x-total-count'], '1');
  const reminders = await request(app).get('/api/reminders?limit=1&offset=0');
  assert.equal(reminders.status, 200);
  assert.deepEqual(reminders.body, []);
  assert.equal(reminders.headers['x-total-count'], '0');
});

test('category filters trim persisted whitespace for Knowledge, Academy, and Benefits', async () => {
  const id = '00000000-0000-4000-8000-000000000003';
  contentRows.knowledge.push({ id, category: ' Finance ', title: 'Knowledge', content: 'Body' });
  contentRows.academy.push({ id, category: ' Finance ', title: 'Academy', active: true });
  contentRows.benefits.push({ id, category: ' Finance ', company: 'Benefits', active: true });

  for (const [path, table] of [
    ['/api/knowledge', 'knowledge_base'],
    ['/api/academy', 'academy'],
    ['/api/benefits', 'benefits'],
  ]) {
    calls.length = 0;
    const response = await request(app).get(`${path}?category=Finance&limit=20&offset=0`);
    assert.equal(response.status, 200, path);
    const read = calls.find(({ sql }) => new RegExp(`FROM ${table}\\b`).test(sql) && /btrim\(/.test(sql));
    assert.ok(read, `${path} must trim its category filter`);
    assert.deepEqual(read.params, ['Finance']);
  }
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
