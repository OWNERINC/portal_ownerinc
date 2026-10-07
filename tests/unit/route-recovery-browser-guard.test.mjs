import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PREVIEW_ID,
  PREVIEW_VERSION,
  SYNTHETIC_UID,
  classifyRouteRecoveryPath,
  compareStaticResponseBytes,
  expectedBlockedExternalResource,
  firebaseStubSource,
  isAllowlistedFirebaseModule,
  parseLoopbackBaseUrl,
  resolveRouteRecoveryAPI,
  runWithBoundedBrowserClose,
  syntheticUser,
} from '../fixtures/route-recovery-browser.mjs';

test('route-recovery runner base URL accepts only explicit HTTP loopback origins', () => {
  assert.equal(parseLoopbackBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
  assert.equal(parseLoopbackBaseUrl('http://localhost:8080/'), 'http://localhost:8080');
  assert.equal(parseLoopbackBaseUrl('http://[::1]:8080'), 'http://[::1]:8080');
  for (const value of [
    'https://127.0.0.1:8080',
    'http://portal.example.test',
    'http://192.168.1.4:8080',
    'http://127.0.0.1:8080/nested',
    'http://user:password@127.0.0.1:8080',
    'http://127.0.0.1:8080/?next=production',
  ]) assert.throws(() => parseLoopbackBaseUrl(value), /loopback|HTTP/);
});

test('synthetic Portal profiles have one stable UID and role-specific API permissions', () => {
  const admin = syntheticUser('admin');
  const viewer = syntheticUser('viewer');
  assert.equal(admin.uid, SYNTHETIC_UID);
  assert.equal(viewer.uid, SYNTHETIC_UID);
  assert.equal(admin.role, 'admin');
  assert.equal(viewer.role, 'viewer');
  assert.equal(admin.permissions.superAdmin, true);
  assert.deepEqual(viewer.permissions, {});
  assert.throws(() => syntheticUser('production'), /Unsupported synthetic role/);
});

test('API fixtures are GET/HEAD-only, explicit, and include visible page content', () => {
  const usersMe = resolveRouteRecoveryAPI({ url: 'http://127.0.0.1:8080/api/users/me', role: 'viewer' });
  assert.equal(usersMe.kind, 'fixture');
  assert.equal(usersMe.body.uid, SYNTHETIC_UID);
  assert.equal(usersMe.body.role, 'viewer');

  const head = resolveRouteRecoveryAPI({ url: 'http://127.0.0.1:8080/api/users/me', method: 'HEAD' });
  assert.equal(head.kind, 'fixture');
  const write = resolveRouteRecoveryAPI({
    url: 'http://127.0.0.1:8080/api/users', method: 'POST', role: 'admin',
  });
  assert.equal(write.kind, 'denied-write');
  assert.equal(write.status, 405);

  const docs = resolveRouteRecoveryAPI({
    url: 'http://127.0.0.1:8080/api/cms/documents?type=knowledge&limit=50&offset=0',
  });
  assert.equal(docs.kind, 'fixture');
  assert.equal(Array.isArray(docs.body), true, 'fetchAPIPage fixtures must mirror the API JSON array plus X-Total-Count contract.');
  assert.equal(docs.body[0].title, 'Synthetic CMS Document Fixture');
  assert.equal(docs.total, 1);

  const knowledge = resolveRouteRecoveryAPI({
    url: 'http://127.0.0.1:8080/api/knowledge?limit=50&offset=0',
  });
  assert.deepEqual(knowledge.body.map(item => item.title), ['Synthetic Knowledge Fixture']);
  assert.equal(knowledge.total, 1);
  assert.equal(resolveRouteRecoveryAPI({
    url: 'http://127.0.0.1:8080/api/knowledge/categories',
  }).total, undefined, 'Non-paginated category routes must not invent X-Total-Count.');

  const benefits = resolveRouteRecoveryAPI({
    url: 'http://127.0.0.1:8080/api/benefits?active=true&limit=20&offset=0',
  });
  assert.equal(benefits.kind, 'fixture');
  assert.equal(Array.isArray(benefits.body), true);
  assert.equal(benefits.body[0].company, 'Synthetic Benefits Partner');
  assert.equal(benefits.body[0].active, true);
  assert.deepEqual(benefits.body[0].content_blocks, [{
    type: 'paragraph', text: 'Synthetic benefit body.',
  }]);
  assert.equal(benefits.total, 1);
  const benefitCategories = resolveRouteRecoveryAPI({
    url: 'http://127.0.0.1:8080/api/benefits/categories',
  });
  assert.deepEqual(benefitCategories.body, ['Synthetic QA']);
  assert.equal(benefitCategories.total, undefined);

  const preview = resolveRouteRecoveryAPI({
    url: `http://127.0.0.1:8080/api/announcements/preview/${PREVIEW_ID}?version=${PREVIEW_VERSION}&source=payload`,
  });
  assert.equal(preview.kind, 'fixture');
  assert.equal(preview.body.content_blocks[0].nodes[0].children[0].text, 'Synthetic saved preview body.');

  const punches = resolveRouteRecoveryAPI({
    url: 'http://127.0.0.1:8080/api/solides/me/punches?from=2026-10-01&to=2026-10-07&limit=50&offset=0',
  });
  assert.deepEqual(punches.body.entries.map(entry => entry.status), ['Synthetic fixture']);
  assert.equal(punches.total, 1);

  const unknown = resolveRouteRecoveryAPI({ url: 'http://127.0.0.1:8080/api/not-fixtured' });
  assert.equal(unknown.kind, 'unknown-api');
  assert.equal(unknown.status, 404);
  assert.equal(resolveRouteRecoveryAPI({ url: 'http://127.0.0.1:8080/api' }).kind, 'unknown-api');
});

test('network path guard rejects encoded delimiters, traversal and double-encoding before API routing', () => {
  const attacks = [
    '/api%2fusers/me', '/api%2Fusers/me', '/api%5cusers/me', '/api%5Cusers/me',
    '/api/%2e%2e/users/me', '/%2e%2e/api/users/me', '/api/../users/me',
    '/api\\users/me', '//api/users/me', '/api//users/me',
    '/%252fapi/users/me', '/api%252fusers/me', '/%25252fapi/users/me',
    '/%252e%252e/api/users/me', '/%25252e%25252e/api/users/me',
  ];
  for (const pathname of attacks) {
    assert.equal(classifyRouteRecoveryPath(pathname).kind, 'unsafe-path', pathname);
  }
  assert.deepEqual(classifyRouteRecoveryPath('/api/users/me'), { kind: 'api', pathname: '/api/users/me' });

  const encodedApi = resolveRouteRecoveryAPI({ url: 'http://127.0.0.1:8080/api%2fusers/me' });
  assert.equal(encodedApi.kind, 'unsafe-path');
  assert.equal(encodedApi.status, 400);
  const unknownApiPath = '/api/unknown-route-recovery-endpoint';
  assert.equal(classifyRouteRecoveryPath(unknownApiPath).kind, 'api');
  assert.equal(resolveRouteRecoveryAPI({ url: `http://127.0.0.1:8080${unknownApiPath}` }).kind, 'unknown-api');
});

test('editorial availability fixture is a legitimate legacy/unavailable response', () => {
  const availability = resolveRouteRecoveryAPI({ url: 'http://127.0.0.1:8080/api/cms/session/availability' });
  assert.deepEqual(availability.body, {
    mode: 'legacy', epoch: 1, activated: false, runtimeReady: false, canEnter: false,
  });
});

test('static source comparator preserves BOM bytes and rejects a same-length wrong HTML body', () => {
  const local = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<!doctype html>\n<title>CMS1</title>\n')]);
  const exact = compareStaticResponseBytes(local, Buffer.from(local));
  assert.equal(exact.matches, true);
  assert.equal(exact.localBytes, local.byteLength);
  assert.equal(exact.localSha256, exact.responseSha256);

  const wrongShell = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<!doctype html>\n<title>HOME</title>\n')]);
  const mismatch = compareStaticResponseBytes(local, wrongShell);
  assert.equal(mismatch.localBytes, mismatch.responseBytes, 'A length-only check would miss this wrong-body regression.');
  assert.equal(mismatch.matches, false);
  assert.notEqual(mismatch.localSha256, mismatch.responseSha256);
});

test('bounded browser cleanup retains primary errors and surfaces cleanup-only failures', async () => {
  const primary = new Error('primary acceptance failure');
  const secondary = new Error('browser close failure');
  await assert.rejects(runWithBoundedBrowserClose({ close: async () => { throw secondary; } }, async () => { throw primary; }, 100), error => {
    assert.equal(error, primary);
    assert.equal(error.cleanupError, secondary);
    return true;
  });

  await assert.rejects(runWithBoundedBrowserClose({ close: async () => { throw secondary; } }, async () => 'passed', 100), error => error === secondary);
  await assert.rejects(runWithBoundedBrowserClose({ close: () => new Promise(() => {}) }, async () => 'passed', 15),
    /browser\.close exceeded 15ms cleanup limit/);
});

test('Firebase stubs are restricted to the versioned Firebase app/auth SDK modules', () => {
  const app = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
  const auth = 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
  assert.equal(isAllowlistedFirebaseModule(app), true);
  assert.equal(isAllowlistedFirebaseModule(auth), true);
  assert.match(firebaseStubSource(auth), /route-recovery-synthetic-user/);
  assert.equal(firebaseStubSource('https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js'), null);
  assert.equal(firebaseStubSource('https://evil.example.test/firebase-auth.js'), null);
});

test('known dashboard fallback photos are classified as expected blocks, never network allowlists', () => {
  const exact = 'https://images.unsplash.com/photo-1497366811353-6870744d04b2?auto=format&fit=crop&w=600&q=80';
  assert.equal(expectedBlockedExternalResource(exact), 'dashboard-editorial-fallback');
  assert.equal(expectedBlockedExternalResource(exact.replace('w=600', 'w=1200')), null);
  assert.equal(expectedBlockedExternalResource('https://images.unsplash.com/photo-unexpected'), null);
  assert.equal(expectedBlockedExternalResource('https://example.test/image.jpg'), null);
});
