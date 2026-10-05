import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
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

function uploadAsset(h, buffer = PNG, { field = 'asset', contentType = 'image/png', filename = 'asset.png' } = {}) {
  return h.request.post('/api/cms/assets').set('Authorization', MANAGER).attach(field, buffer, { filename, contentType });
}

test('real index starts without optional CMS env and confines bridge unavailability to editorial routes', async t => {
  const h = await createDependencyHarness(t);
  for (const route of ['/api/cms/session', '/api/internal/editorial/authority']) {
    const response = await h.request.get(route);
    assert.equal(response.status, 503);
    assert.equal(response.body.reason, 'editorial_unavailable');
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  assert.equal(h.state.sql.length, 0);
  assert.equal((await h.request.get('/api/health')).status, 200);
  assert.equal((await h.request.get('/api/reminders/deliveries?limit=20').set('Authorization', MANAGER)).status, 200);
});

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

test('the CMS query boundary rejects duplicate and object filters before business SQL', async t => {
  const h = await createDependencyHarness(t);
  for (const query of ['type=knowledge&type=academy', 'type[isBuffer]=x', 'source_id[]=x', 'status=unknown', 'limit[0]=5']) {
    boundedError(await h.request.get(`/api/cms/documents?${query}`).set('Authorization', MANAGER), 400, 'Invalid request.');
  }
  assert.equal(businessQueries(h).length, 0);
  const response = await h.request.get('/api/cms/documents?type=knowledge&limit=50&offset=0').set('Authorization', MANAGER);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, []);
  assert.equal(response.headers['x-total-count'], '0');
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

test('JSON size limits remain 100 KiB default, 1 MiB bulk and 6 MiB CMS', async t => {
  const h = await createDependencyHarness(t);
  for (const [route, size] of [['/api/reminders', 100 * 1024], ['/api/users/bulk', 1024 * 1024], ['/api/cms/documents', 6 * 1024 * 1024]]) {
    const response = await h.request.post(route).set('Authorization', MANAGER).type('json').send(JSON.stringify({ title: 'x'.repeat(size) }));
    boundedError(response, 413, 'Payload too large.');
  }
  assert.equal(h.state.sql.length, 0);
  assert.equal(h.state.verifiedTokens.length, 0);
  const bulk = await h.request.post('/api/users/bulk/__dependency-parser-probe')
    .send({ title: 'x'.repeat(1024 * 1024 - 100) });
  assert.equal(bulk.status, 200, 'bulk accepts a body just below its own limit, above the default');
  assert.equal(bulk.body.titleLength, 1024 * 1024 - 100);
  // A body just below CMS's own parser limit exceeds both smaller parsers.
  // The real route must reject title length rather than return a parser 413.
  const cms = await h.request.post('/api/cms/documents').set('Authorization', MANAGER)
    .send({ type: 'announcement', title: 'x'.repeat(6 * 1024 * 1024 - 100) });
  boundedError(cms, 400, 'Invalid request.');
  assert.equal(businessQueries(h).length, 0);
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

test('authentication and CMS authorization run before multipart parsing and storage', async t => {
  const h = await createDependencyHarness(t);
  for (const route of ['/api/upload/photo', '/api/cms/assets']) {
    const unauthenticated = await h.request.post(route).set('Content-Type', 'multipart/form-data').send('invalid multipart without boundary');
    boundedError(unauthenticated, 401, 'Authentication required.');
    const expired = await h.request.post(route).set('Authorization', 'Bearer invalid').set('Content-Type', 'multipart/form-data').send('invalid multipart');
    boundedError(expired, 401, 'Invalid or expired token.');
  }
  const forbidden = await h.request.post('/api/cms/assets').set('Authorization', READER).set('Content-Type', 'multipart/form-data').send('invalid multipart');
  boundedError(forbidden, 403, 'Permission denied.');
  assert.equal(h.state.connections, 0);
  assert.equal(h.state.writes.length, 0);
  assert.equal(businessQueries(h).length, 0);
});

test('CMS rejects wrong or multiple file fields and unexpected text parts with real Multer', async t => {
  const h = await createDependencyHarness(t);
  boundedError(await uploadAsset(h, PNG, { field: 'photo' }), 400, 'Invalid request.');
  boundedError(await uploadAsset(h).attach('asset', PNG, 'second.png'), 400, 'Invalid request.');
  boundedError(await uploadAsset(h).attach('other', PNG, 'other.png'), 400, 'Invalid request.');
  boundedError(await uploadAsset(h).field('title', 'unexpected field'), 400, 'Invalid request.');
  boundedError(await h.request.post('/api/cms/assets').set('Authorization', MANAGER), 400, 'Invalid request.');
  assert.equal(h.state.connections, 0);
  assert.equal(h.state.writes.length, 0);
});

test('CMS rejects malformed/truncated multipart and MIME/signature mismatches with bounded 400s', async t => {
  const h = await createDependencyHarness(t);
  const boundary = 'dependency-regression-boundary';
  const truncated = `--${boundary}\r\nContent-Disposition: form-data; name="asset"; filename="truncated.png"\r\nContent-Type: image/png\r\n\r\n`;
  boundedError(await h.request.post('/api/cms/assets').set('Authorization', MANAGER)
    .set('Content-Type', `multipart/form-data; boundary=${boundary}`).send(Buffer.concat([Buffer.from(truncated), PNG])), 400, 'Invalid request.');
  boundedError(await h.request.post('/api/cms/assets').set('Authorization', MANAGER)
    .set('Content-Type', 'multipart/form-data').send('missing boundary'), 400, 'Invalid request.');
  boundedError(await uploadAsset(h, PNG, { contentType: 'image/jpeg' }), 400, 'Invalid request.');
  boundedError(await uploadAsset(h, Buffer.from('<script>invalid</script>')), 400, 'Invalid request.');
  boundedError(await uploadAsset(h, Buffer.alloc(0)), 400, 'Invalid request.');
  assert.equal(h.state.connections, 0);
  assert.equal(h.state.writes.length, 0);
  assert.equal((await uploadAsset(h)).status, 201);
});

test('CMS uploads stay private, audited and readable only through matching active published references', async t => {
  const h = await createDependencyHarness(t);
  const uploaded = await uploadAsset(h);
  assert.equal(uploaded.status, 201);
  assert.match(uploaded.body.id, UUID);
  assert.deepEqual(Object.keys(uploaded.body).sort(), ['byte_size', 'created_at', 'id', 'mime_type', 'original_name']);
  assert.equal(uploaded.body.mime_type, 'image/png');
  assert.equal(uploaded.body.byte_size, PNG.length);
  assert.deepEqual(h.state.files.get(h.state.writes[0]), PNG);
  assert.ok(h.state.sql.some(call => /INSERT INTO audit_log/.test(call.sql) && call.params[1] === 'cms.asset.upload'
    && call.params[3] === uploaded.body.id && call.params[4] === uploaded.headers['x-request-id']));
  const endpoint = `/api/cms/assets/${uploaded.body.id}`;
  boundedError(await h.request.get(endpoint), 401, 'Authentication required.');
  boundedError(await h.request.get(endpoint).set('Authorization', READER), 403, 'Permission denied.');
  const published = { content_type: 'reminder', revision_id: 'revision-a', published_revision_id: 'revision-a', status: 'published',
    blocks: [{ type: 'image', asset_id: uploaded.body.id, alt: 'Fixture' }],
    block_type: 'image', reminder_active: true, reminder_target_users: 'all' };
  for (const changes of [
    { status: 'draft' }, { published_revision_id: 'another-revision' },
    { reminder_active: false }, { reminder_target_users: ['somebody-else'] }, { block_type: 'pdf' },
    { blocks: [{ type: 'invalid' }] },
  ]) {
    h.state.references = [{ ...published, ...changes }];
    boundedError(await h.request.get(endpoint).set('Authorization', READER), 403, 'Permission denied.');
  }
  assert.equal(h.state.opens.length, 0, 'private files are not opened before the reference/audience check');
  h.state.references = [published];
  const read = await h.request.get(endpoint).set('Authorization', READER);
  assert.equal(read.status, 200);
  assert.equal(read.headers['content-type'], 'image/png');
  assert.equal(read.headers['x-content-type-options'], 'nosniff');
  assert.equal(read.headers['content-length'], String(PNG.length));
  assert.deepEqual(read.body, PNG);
  assert.equal(h.state.opens.length, 1);
  assert.ok(h.state.sql.some(call => /pg_advisory_xact_lock/.test(call.sql)));
  const asset = h.state.assets.get(uploaded.body.id);
  asset.deleting_at = '2026-09-29T12:00:00Z';
  boundedError(await h.request.get(endpoint).set('Authorization', READER), 404, 'Asset not found.');
  assert.equal((await h.request.get(`/uploads/cms-private/${asset.storage_key}`)).status, 404);
  assert.equal(h.state.opens.length, 1);
  assert.equal(h.state.connections, h.state.releases);
});

test('an interrupted multipart socket cannot persist a partial asset or poison the next valid upload', { timeout: 10000 }, async t => {
  const h = await createDependencyHarness(t);
  const boundary = 'interrupted-upload';
  const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="asset"; filename="partial.png"\r\nContent-Type: image/png\r\n\r\n`);
  const client = httpRequest({ hostname: '127.0.0.1', port: h.port, path: '/api/cms/assets', method: 'POST', headers: {
    Authorization: MANAGER, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': prefix.length + 10000,
  } });
  client.on('error', () => {}); // A deliberate client abort may emit ECONNRESET.
  t.after(() => client.destroy());
  client.write(prefix);
  const deadline = Date.now() + 3000;
  while (!h.state.incoming[0]?.listenerCount('data') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  const incoming = h.state.incoming[0];
  assert.ok(incoming?.listenerCount('data'), 'real Multer must have started consuming the upload before interruption');
  const received = once(incoming, 'data');
  client.write(PNG);
  await received;
  const aborted = once(incoming, 'aborted');
  client.destroy();
  await aborted;
  assert.equal(h.state.connections, 0);
  assert.equal(h.state.writes.length, 0);
  const next = await uploadAsset(h);
  assert.equal(next.status, 201);
  assert.equal(h.state.writes.length, 1);
  assert.deepEqual(h.state.files.get(h.state.writes[0]), PNG);
});
