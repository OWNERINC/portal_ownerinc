import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { actors, createAdminFilterHarness } from '../helpers/admin-filter-harness.mjs';

const require = createRequire(import.meta.url);
const { civilDate, literalSubstring } = require('../../api/admin-list-filters');
const titleId = '00000000-0000-4000-8000-000000000001';
const normalize = sql => sql.replace(/\s+/g, ' ').trim();
const where = sql => normalize(sql).match(/\bWHERE (.*?)(?: GROUP BY | ORDER BY |$)/)?.[1] || '';
const query = values => `?${new URLSearchParams(values)}`;
const escapeClause = "ESCAPE E'\\\\'";
const userState = "CASE WHEN u.permissions->>'accountDisabled' = 'true' THEN 'disabled' WHEN u.firebase_enable_pending IS TRUE THEN 'enable_pending' ELSE 'active' END";

function statements(h, table) {
  const calls = h.state.sql.filter(call => call.sql.includes(`FROM ${table}`));
  const count = calls.find(call => /SELECT COUNT\(\*\)/.test(call.sql));
  const list = calls.find(call => !/SELECT COUNT\(\*\)/.test(call.sql));
  assert.ok(count && list, `expected count and list for ${table}`);
  return { count, list };
}
function assertQuery(h, table, conditions, params, { limit = 50, offset = 0 } = {}) {
  const { count, list } = statements(h, table);
  assert.equal(where(count.sql), conditions);
  assert.equal(where(list.sql), conditions, 'count and list must share the entire predicate');
  assert.deepEqual(count.params, params);
  assert.deepEqual(list.params, [...params, limit, offset]);
  assert.ok(normalize(list.sql).endsWith(`LIMIT $${params.length + 1} OFFSET $${params.length + 2}`));
  for (const call of [count, list]) {
    const placeholders = [...new Set([...call.sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1])))].sort((a, b) => a - b);
    assert.deepEqual(placeholders, call.params.map((_, i) => i + 1));
  }
  return { count, list };
}
function assertError(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.body.requestId, response.headers['x-request-id']);
  assert.deepEqual(Object.keys(response.body).sort(), ['error', 'requestId']);
}

test('literal search helper escapes percent, underscore and backslash; civil dates do not use JS year coercion', () => {
  assert.equal(literalSubstring('  50%_\\Path  '), '%50\\%\\_\\\\Path%');
  for (const date of ['0001-01-01', '0004-02-29', '0400-02-29', '2000-02-29', '2024-02-29', '9999-12-31']) assert.equal(civilDate(date), true, date);
  for (const date of ['0000-01-01', '0100-02-29', '1900-02-29', '2100-02-29', '2026-02-29', '2024-02-30', '2026-04-31', '10000-01-01', null, ['2024-01-01']]) assert.equal(civilDate(date), false, String(date));
});

test('unfiltered users retain stable order, null/inactive job titles, total headers and the minimal transactional read audit', async t => {
  const h = await createAdminFilterHarness(t);
  h.state.users = { total: 55, rows: [
    { uid: 'no-title', name: 'Ana', email: 'ana@example.test', role: 'viewer', job_title_id: null, job_title: null, job_title_active: null, permissions: {}, firebase_enable_pending: false, state: 'active' },
    { uid: 'inactive-title', name: 'Ana', email: 'other@example.test', role: 'viewer', job_title_id: titleId, job_title: 'Cargo inativo', job_title_active: false, permissions: {}, firebase_enable_pending: false, state: 'active' },
  ] };
  const response = await h.get('/api/users?limit=2&offset=50', 'manager');
  assert.equal(response.status, 200); assert.deepEqual(response.body, h.state.users.rows);
  assert.equal(response.headers['x-total-count'], '55');
  const { list } = assertQuery(h, 'users', '', [], { limit: 2, offset: 50 });
  assert.match(list.sql, /LEFT JOIN job_titles jt ON jt.id = u.job_title_id/);
  assert.match(list.sql, /jt.active AS job_title_active/);
  assert.ok(normalize(list.sql).includes(`${userState} AS state`));
  assert.match(normalize(list.sql), /ORDER BY u.name, u.uid LIMIT/);
  const audit = h.state.sql.find(call => /INSERT INTO audit_log/.test(call.sql));
  assert.deepEqual(audit.params, [actors.manager.uid, 'user.list', null, response.headers['x-request-id'], JSON.stringify({ limit: 2, offset: 50, resultCount: 2 })]);
  assert.equal(h.state.sql[0].sql, 'BEGIN'); assert.equal(h.state.sql.at(-1).sql, 'COMMIT');
  assert.ok(h.state.sql.indexOf(audit) > h.state.sql.indexOf(list));
  assert.equal(h.state.connections, 1); assert.equal(h.state.releases, 1);
});

for (const [name, filters, expectedWhere, params] of [
  ['name or email', { q: '  ANA@Example.test  ' }, `(u.name ILIKE $1 ${escapeClause} OR u.email ILIKE $1 ${escapeClause})`, ['%ANA@Example.test%']],
  ['viewer role', { role: 'viewer' }, 'u.role = $1', ['viewer']],
  ['admin role', { role: 'admin' }, 'u.role = $1', ['admin']],
  ['job title', { job_title_id: titleId }, 'u.job_title_id = $1', [titleId]],
  ...['active', 'disabled', 'enable_pending'].map(state => [state, { state }, `(${userState}) = $1`, [state]]),
  ['combined', { q: '  50%_\\Path  ', role: 'admin', state: 'active', job_title_id: titleId }, `(u.name ILIKE $1 ${escapeClause} OR u.email ILIKE $1 ${escapeClause}) AND u.role = $2 AND u.job_title_id = $3 AND (${userState}) = $4`, ['%50\\%\\_\\\\Path%', 'admin', titleId, 'active']],
]) test(`users ${name} filter is parameterized identically before list pagination and count`, async t => {
  const h = await createAdminFilterHarness(t);
  h.state.users.total = 17;
  const response = await h.get(`/api/users${query({ ...filters, limit: '7', offset: '14' })}`);
  assert.equal(response.status, 200); assert.deepEqual(response.body, []); assert.equal(response.headers['x-total-count'], '17');
  const { list } = assertQuery(h, 'users', expectedWhere, params, { limit: 7, offset: 14 });
  if (filters.q) assert.ok(!list.sql.includes(filters.q.trim()), 'raw query text must not enter SQL');
  const audit = h.state.sql.find(call => /INSERT INTO audit_log/.test(call.sql));
  assert.deepEqual(JSON.parse(audit.params[4]), { limit: 7, offset: 14, resultCount: 0 });
});

test('user state filtering uses disabled text-true precedence, a boolean pending flag and active ELSE for missing JSON keys', async t => {
  const h = await createAdminFilterHarness(t);
  for (const state of ['disabled', 'enable_pending', 'active']) {
    h.reset();
    assert.equal((await h.get(`/api/users?state=${state}`)).status, 200);
    const { list, count } = statements(h, 'users');
    assert.equal(normalize(list.sql).split(userState).length - 1, 2, 'identical CASE in the projection and predicate');
    assert.equal(normalize(count.sql).split(userState).length - 1, 1);
    // ->> treats stored JSON boolean true and JSON string "true" consistently;
    // a NULL/missing key does not match WHEN, so pending/ELSE remains reachable.
    assert.match(list.sql, /permissions->>'accountDisabled' = 'true'/);
    assert.doesNotMatch(where(list.sql), /NOT \(|accountDisabled.*<>|accountDisabled.*!=/);
  }
});

for (const [name, filters, expectedWhere, params] of [
  ['default active only', {}, 'jt.active = $1', [true]],
  ['legacy all false', { all: 'false' }, 'jt.active = $1', [true]],
  ['legacy all true', { all: 'true' }, '', []],
  ['explicit active true', { active: 'true' }, 'jt.active = $1', [true]],
  ['explicit inactive', { active: 'false' }, 'jt.active = $1', [false]],
  ['active wins over all true', { active: 'true', all: 'true' }, 'jt.active = $1', [true]],
  ['inactive wins over all true', { active: 'false', all: 'true' }, 'jt.active = $1', [false]],
  ['inactive wins over all false', { active: 'false', all: 'false' }, 'jt.active = $1', [false]],
  ['name alone', { q: '  Gestão  ' }, `jt.name ILIKE $1 ${escapeClause} AND jt.active = $2`, ['%Gestão%', true]],
  ['name with all true', { q: 'Gestão', all: 'true' }, `jt.name ILIKE $1 ${escapeClause}`, ['%Gestão%']],
  ['combined', { q: '  50%_\\Path  ', active: 'false', all: 'true' }, `jt.name ILIKE $1 ${escapeClause} AND jt.active = $2`, ['%50\\%\\_\\\\Path%', false]],
]) test(`job titles ${name} preserves precedence, all-assignee counts and stable grouped paging`, async t => {
  const h = await createAdminFilterHarness(t);
  h.state.titles = { total: 105, rows: [{ id: titleId, name: 'Gestão', active: false, page_access: {}, user_count: 55 }] };
  const response = await h.get(`/api/job-titles${query({ ...filters, limit: '100', offset: '100' })}`, 'manager');
  assert.equal(response.status, 200); assert.deepEqual(response.body, h.state.titles.rows);
  assert.equal(response.headers['x-total-count'], '105');
  const { list } = assertQuery(h, 'job_titles', expectedWhere, params, { limit: 100, offset: 100 });
  assert.match(normalize(list.sql), /COUNT\(u.uid\)::integer AS user_count FROM job_titles jt LEFT JOIN users u ON u.job_title_id = jt.id/);
  assert.match(normalize(list.sql), /GROUP BY jt.id ORDER BY lower\(jt.name\), jt.id LIMIT/);
  assert.doesNotMatch(list.sql, /accountDisabled|firebase_enable_pending|u.role|u.permissions/);
  assert.equal(h.state.connections, 0);
});

test('blank optional search is a no-op and search wildcard or SQL punctuation never becomes query syntax', async t => {
  const h = await createAdminFilterHarness(t);
  for (const [endpoint, table] of [['/api/users', 'users'], ['/api/job-titles?all=true', 'job_titles']]) {
    const separator = endpoint.includes('?') ? '&' : '?';
    for (const value of ['', ' \t ', '%', '_', '\\', "' OR TRUE --", 'ação_%\\', 'x'.repeat(200)]) {
      h.reset();
      assert.equal((await h.get(`${endpoint}${separator}q=${encodeURIComponent(value)}`)).status, 200);
      const { list, count } = statements(h, table);
      assert.deepEqual(count.params, value.trim() ? [literalSubstring(value)] : []);
      assert.deepEqual(list.params, [...count.params, 50, 0]);
      assert.equal(where(count.sql), where(list.sql));
      const predicate = table === 'users' ? `(u.name ILIKE $1 ${escapeClause} OR u.email ILIKE $1 ${escapeClause})` : `jt.name ILIKE $1 ${escapeClause}`;
      assert.equal(where(list.sql), value.trim() ? predicate : '');
    }
  }
});

test('users retain the existing UUID v1–v5 validator and the maximum accepted list bounds', async t => {
  const h = await createAdminFilterHarness(t);
  for (const version of [1, 2, 3, 4, 5]) {
    h.reset(); const id = `ABCDEFAB-1234-${version}234-ABCD-123456ABCDEF`;
    const response = await h.get(`/api/users${query({ job_title_id: id, limit: '100', offset: '1000000' })}`);
    assert.equal(response.status, 200);
    assertQuery(h, 'users', 'u.job_title_id = $1', [id], { limit: 100, offset: 1000000 });
  }
});

test('unfiltered audit exposes only existing fields plus the current actor name, retaining null actors and deterministic ordering', async t => {
  const h = await createAdminFilterHarness(t);
  const event = { id: 'event-a', actor_uid: 'actor-a', action: 'user.update', target_type: 'user', target_id: 'target-a', request_id: 'old-request', details: { fields: ['name'] }, created_at: '2026-09-29T12:00:00Z', actor_name: 'Nome atual' };
  h.state.audit = { total: 102, rows: [event, { ...event, id: 'event-b', actor_uid: null, actor_name: null }] };
  const response = await h.get('/api/users/audit?limit=2&offset=100');
  assert.equal(response.status, 200); assert.deepEqual(response.body, h.state.audit.rows); assert.equal(response.headers['x-total-count'], '102');
  const { list } = assertQuery(h, 'audit_log', '', [], { limit: 2, offset: 100 });
  const sql = normalize(list.sql);
  assert.equal(sql.slice(0, sql.indexOf(' FROM')), 'SELECT a.id, a.actor_uid, a.action, a.target_type, a.target_id, a.request_id, a.details, a.created_at, ua.name AS actor_name');
  assert.match(sql, /LEFT JOIN users ua ON ua.uid = a.actor_uid/);
  assert.match(sql, /ORDER BY a.created_at DESC, a.id LIMIT/);
  assert.equal(h.state.sql.length, 2, 'audit read adds no identity snapshots or write operations');
});

for (const [name, filters, expectedWhere, params] of [
  ['action', { action: 'vendor.future_action' }, 'a.action = $1', ['vendor.future_action']],
  ['from', { from: '0001-01-01' }, "a.created_at >= ($1::date::timestamp AT TIME ZONE 'America/Sao_Paulo')", ['0001-01-01']],
  ['to', { to: '9999-12-31' }, "a.created_at < (($1::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')", ['9999-12-31']],
  ['combined DST day', { action: 'user.update', from: '2018-11-04', to: '2018-11-04' }, "a.action = $1 AND a.created_at >= ($2::date::timestamp AT TIME ZONE 'America/Sao_Paulo') AND a.created_at < (($3::date + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')", ['user.update', '2018-11-04', '2018-11-04']],
]) test(`audit ${name} uses an identical filtered total and parameterized São Paulo civil boundaries`, async t => {
  const h = await createAdminFilterHarness(t); h.state.audit.total = 10;
  const response = await h.get(`/api/users/audit${query({ ...filters, limit: '3', offset: '9' })}`);
  assert.equal(response.status, 200); assert.deepEqual(response.body, []); assert.equal(response.headers['x-total-count'], '10');
  const { list } = assertQuery(h, 'audit_log', expectedWhere, params, { limit: 3, offset: 9 });
  assert.doesNotMatch(list.sql, /23:59|INTERVAL|86400|24 hours|BETWEEN/i);
  for (const value of Object.values(filters)) assert.ok(!list.sql.includes(value));
});

test('audit accepts valid leap/early/late civil days and exact unknown action strings without normalizing them', async t => {
  const h = await createAdminFilterHarness(t);
  for (const date of ['0001-01-01', '0004-02-29', '0400-02-29', '2000-02-29', '2024-02-29', '2019-02-16', '9999-12-31']) {
    h.reset(); assert.equal((await h.get(`/api/users/audit${query({ from: date, to: date })}`)).status, 200);
    assert.deepEqual(statements(h, 'audit_log').count.params, [date, date]);
  }
  for (const action of ['x'.repeat(120), 'unknown.future.code', ' spaced.code ', "literal_%\\' OR TRUE --"]) {
    h.reset(); assert.equal((await h.get(`/api/users/audit${query({ action })}`)).status, 200);
    const { list, count } = statements(h, 'audit_log');
    assert.deepEqual(count.params, [action]); assert.equal(where(list.sql), 'a.action = $1');
    assert.ok(!list.sql.includes(action));
  }
});

for (const [endpoint, invalidQueries] of [
  ['/api/users', [
    { q: 'x'.repeat(201) }, { role: 'superadmin' }, { role: '' }, { role: 'Admin' }, { state: 'pending' }, { state: '' },
    { job_title_id: '' }, { job_title_id: 'no-cargo' }, { job_title_id: '00000000-0000-7000-8000-000000000001' }, { job_title_id: '00000000-0000-4000-7000-000000000001' },
  ]],
  ['/api/job-titles', [{ q: 'x'.repeat(201) }, { active: '' }, { active: '0' }, { active: 'TRUE' }, { all: '' }, { all: '1' }, { all: 'TRUE' }, { active: 'true', all: 'bad' }]],
  ['/api/users/audit', [
    { action: '' }, { action: '   ' }, { action: 'x'.repeat(121) }, { from: '2026-09-30', to: '2026-09-29' },
    ...['', '2026-02-29', '2024-02-30', '2026-04-31', '1900-02-29', '2100-02-29', '0100-02-29', '0000-01-01', '10000-01-01', '-001-01-01', '2026-00-01', '2026-13-01', '2026-01-00', '2026-01-32', '2026-1-01', '2026-01-1', '2026-01-01T00:00:00Z', ' 2026-01-01 ', 'Infinity'].flatMap(date => [{ from: date }, { to: date }]),
  ]],
]) test(`${endpoint} rejects invalid filters before touching the DB`, async t => {
  const h = await createAdminFilterHarness(t);
  for (const filters of invalidQueries) {
    h.reset(); const response = await h.get(endpoint + query(filters));
    assertError(response, 400); assert.equal(h.state.sql.length, 0, JSON.stringify(filters)); assert.equal(h.state.connections, 0);
  }
});

for (const [endpoint, validFilters] of [
  ['/api/users', { q: 'Ana', role: 'viewer', state: 'active', job_title_id: titleId }],
  ['/api/job-titles', { q: 'Gestão', active: 'false', all: 'true' }],
  ['/api/users/audit', { action: 'user.list', from: '2026-01-01', to: '2026-12-31' }],
]) test(`${endpoint} rejects repeated, array, object, unknown filters and invalid pagination through the real query parser`, async t => {
  const h = await createAdminFilterHarness(t); assert.equal(h.app.get('query parser'), 'extended');
  const filters = { ...validFilters, limit: '50', offset: '0' };
  for (const [key, value] of Object.entries(filters)) {
    const encoded = encodeURIComponent(value);
    for (const malformed of [`${key}=${encoded}&${key}=${encoded}`, `${key}[]=${encoded}`, `${key}[nested]=${encoded}`]) {
      h.reset(); assertError(await h.get(`${endpoint}?${malformed}`), 400);
      assert.equal(h.state.sql.length, 0, malformed); assert.equal(h.state.connections, 0);
    }
  }
  for (const malformed of ['unknown=1', 'superadmin=true', 'users_page=2', 'limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=NaN', 'offset=-1', 'offset=1.5', 'offset=1000001']) {
    h.reset(); assertError(await h.get(`${endpoint}?${malformed}`), 400);
    assert.equal(h.state.sql.length, 0, malformed); assert.equal(h.state.connections, 0);
  }
});

test('administrative permission gates remain distinct, boolean-strict and ahead of any database work', async t => {
  const h = await createAdminFilterHarness(t);
  for (const actor of [null, ...Object.keys(actors)]) {
    for (const endpoint of ['/api/users', '/api/job-titles', '/api/users/audit']) {
      h.reset();
      const allowed = endpoint.endsWith('/audit') ? actor === 'superadmin' : ['superadmin', 'manager', 'manager-string-super'].includes(actor);
      const response = await h.get(endpoint, actor);
      if (allowed) { assert.equal(response.status, 200); assert.ok(h.state.sql.length > 0); }
      else {
        assertError(response, actor ? 403 : 401);
        assert.equal(h.state.sql.length, 0); assert.equal(h.state.connections, 0);
        assertError(await h.get(`${endpoint}?unknown=1`, actor), actor ? 403 : 401);
        assert.equal(h.state.sql.length, 0);
      }
    }
  }
});

test('user read failures roll back and release their connection without a successful response or query leakage', async t => {
  const h = await createAdminFilterHarness(t);
  for (const fail of [sql => /SELECT u.uid/.test(sql), sql => /SELECT COUNT/.test(sql), sql => /INSERT INTO audit_log/.test(sql)]) {
    h.reset(); h.state.fail = call => fail(call.sql);
    const response = await h.get('/api/users?q=confidential-search');
    assertError(response, 500); assert.equal(response.body.error, 'Internal server error.');
    assert.doesNotMatch(JSON.stringify(response.body), /confidential|Synthetic|SELECT/);
    assert.equal(h.state.sql.at(-1).sql, 'ROLLBACK'); assert.ok(!h.state.sql.some(call => call.sql === 'COMMIT'));
    assert.equal(h.state.releases, 1);
  }
});
