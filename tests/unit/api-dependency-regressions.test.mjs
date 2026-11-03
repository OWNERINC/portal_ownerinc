import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { apiRequire, createDependencyHarness } from '../helpers/api-dependency-harness.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const MANAGER = 'Bearer manager';
const READER = 'Bearer reader';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const businessQueries = h => h.state.sql.filter(call => !/FROM users u/.test(call.sql));

function boundedError(response, status, message) {
  assert.equal(response.status, status, response.text);
  assert.match(response.headers['content-type'], /application\/json/);
  assert.match(response.headers['x-request-id'], UUID);
  assert.deepEqual(response.body, { error: message, requestId: response.headers['x-request-id'] });
  assert.ok(Buffer.byteLength(response.text) < 180);
  assert.doesNotMatch(response.text, /stack|node_modules|dependency-fixture|SQL|Buffer|boundary/i);
}

function uploadPhoto(h, buffer = PNG, field = 'photo') {
  return h.request.post('/api/upload/photo').set('Authorization', READER)
    .attach(field, buffer, { filename: 'profile.png', contentType: 'image/png' });
}

test('real Express query parsing preserves strict duplicate/nested/malformed filter rejection', async t => {
  const h = await createDependencyHarness(t);
  assert.equal(h.app.get('query parser'), 'extended');
  const invalidQueries = [
    'limit=1&limit=2', 'limit[]=1', 'limit[amount]=1', 'offset=-1', 'offset=1.5',
    'limit=NaN', 'limit=101', 'limit=%ZZ', 'unknown=x', 'status=sent&status=failed',
    'status[isBuffer]=true', 'status[constructor][isBuffer]=true', 'status[0]=sent,failed',
    'status[]=sent&status[]=failed', 'reminder_id=not-a-uuid', 'user_uid=user%40example.test',
    'scheduled_from=2026-02-29', 'scheduled_from=2026-09-30&scheduled_to=2026-09-29',
  ];
  for (const query of invalidQueries) {
    const response = await h.request.get(`/api/reminders/deliveries?${query}`).set('Authorization', MANAGER);
    boundedError(response, 400, 'Invalid request.');
    assert.equal(businessQueries(h).length, 0, query);
  }
  const good = await h.request.get('/api/reminders/deliveries?limit=20&offset=40&status=sent&channel=whatsapp&user_uid=uid._%3A-123&scheduled_from=2024-02-29&scheduled_to=2024-02-29').set('Authorization', MANAGER);
  assert.equal(good.status, 200);
  assert.equal(good.headers['x-total-count'], '0');
  assert.deepEqual(good.body, []);
  const list = businessQueries(h).find(call => /SELECT notifications_log.id/.test(call.sql));
  assert.deepEqual(list.params, ['sent', 'whatsapp', 'uid._:-123', '2024-02-29', '2024-02-29', 20, 40]);
  assert.ok(h.state.verifiedTokens.every(call => call.checkRevoked === true));
});

test('real JSON parsing rejects malformed and non-object JSON with bounded request IDs', async t => {
  const h = await createDependencyHarness(t);
  for (const body of ['{"title":', '"scalar"', '{"title":"secret-marker", trailing}']) {
    const response = await h.request.post('/api/reminders').set('Authorization', MANAGER).type('json').send(body);
    boundedError(response, 400, 'Invalid JSON.');
    assert.doesNotMatch(response.text, /secret-marker/);
  }
  assert.equal(h.state.verifiedTokens.length, 0, 'global JSON parser rejects malformed bodies before routes');
  assert.equal(h.state.sql.length, 0);
  boundedError(await h.request.post('/api/reminders').set('Authorization', MANAGER).send([]), 400, 'Invalid request.');
  const good = await h.request.post('/api/reminders').set('Authorization', MANAGER)
    .send({ title: '  Lembrete de teste  ', trigger_day: 10, target_users: ['uid._:-123'], channel: 'email' });
  assert.equal(good.status, 201);
  assert.equal(good.body.title, 'Lembrete de teste');
  assert.deepEqual(good.body.target_users, ['uid._:-123']);
  assert.match(good.headers['x-request-id'], UUID);
  assert.ok(h.state.sql.some(call => /INSERT INTO audit_log/.test(call.sql) && call.params[4] === good.headers['x-request-id']));
});

test('JSON size limits remain 100 KiB by default and 1 MiB for bulk imports', async t => {
  const h = await createDependencyHarness(t);
  for (const [route, size] of [['/api/reminders', 100 * 1024], ['/api/users/bulk', 1024 * 1024]]) {
    const response = await h.request.post(route).set('Authorization', MANAGER).type('json').send(JSON.stringify({ title: 'x'.repeat(size) }));
    boundedError(response, 413, 'Payload too large.');
  }
  assert.equal(h.state.sql.length, 0);
  assert.equal(h.state.verifiedTokens.length, 0);
  const bulk = await h.request.post('/api/users/bulk/__dependency-parser-probe')
    .send({ title: 'x'.repeat(1024 * 1024 - 100) });
  assert.equal(bulk.status, 200, 'bulk accepts a body just below its own limit, above the default');
  assert.equal(bulk.body.titleLength, 1024 * 1024 - 100);
});

test('profile multipart uses real memoryStorage and Sharp to normalize a valid synthetic image', async t => {
  const h = await createDependencyHarness(t);
  const response = await uploadPhoto(h);
  assert.equal(response.status, 200);
  assert.match(path.basename(response.body.url), /^[0-9a-f-]{36}\.webp$/);
  assert.equal(h.state.writes.length, 1);
  const normalized = h.state.files.get(h.state.writes[0]);
  const metadata = await apiRequire('sharp')(normalized).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(metadata.width, 1);
  assert.equal(metadata.height, 1);
  assert.notDeepEqual(normalized, PNG);
  const update = h.state.sql.find(call => /UPDATE users SET photo_url/.test(call.sql));
  assert.deepEqual(update.params, ['dependency-reader', response.body.url]);
  assert.match(update.sql, /photo_crop/);
  assert.equal(h.state.connections, h.state.releases);
});

test('missing, empty, malformed and oversized profile images keep bounded 400/413 responses', async t => {
  const h = await createDependencyHarness(t);
  boundedError(await h.request.post('/api/upload/photo').set('Authorization', READER), 400, 'Image is required.');
  for (const buffer of [Buffer.alloc(0), Buffer.from('<svg><script>not-an-image</script></svg>'), Buffer.from('ffd8ff3c7363726970743e', 'hex'), Buffer.concat([PNG, Buffer.from('trailing')])]) {
    boundedError(await uploadPhoto(h, buffer), 400, 'Only valid JPEG, PNG, or WebP images are allowed.');
  }
  boundedError(await uploadPhoto(h, Buffer.alloc(500 * 1024 + 1, 0x61)), 413, 'Payload too large.');
  assert.equal(h.state.connections, 0);
  assert.equal(h.state.writes.length, 0);
  assert.equal((await uploadPhoto(h)).status, 200, 'a rejected image does not poison the next request');
});

test('the existing unexpected profile field path remains a sanitized 500, not a guessed 400', async t => {
  const h = await createDependencyHarness(t);
  boundedError(await uploadPhoto(h, PNG, 'unexpected'), 500, 'Internal server error.');
  assert.equal(h.state.connections, 0);
  assert.equal(h.state.writes.length, 0);
});

test('profile authentication runs before multipart parsing and storage', async t => {
  const h = await createDependencyHarness(t);
  const route = '/api/upload/photo';
  const unauthenticated = await h.request.post(route).set('Content-Type', 'multipart/form-data').send('invalid multipart without boundary');
  boundedError(unauthenticated, 401, 'Authentication required.');
  const expired = await h.request.post(route).set('Authorization', 'Bearer invalid').set('Content-Type', 'multipart/form-data').send('invalid multipart');
  boundedError(expired, 401, 'Invalid or expired token.');
  assert.equal(h.state.connections, 0);
  assert.equal(h.state.writes.length, 0);
  assert.equal(businessQueries(h).length, 0);
});
