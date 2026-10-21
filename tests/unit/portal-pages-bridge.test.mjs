import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire, Module } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const apiRequire = createRequire(new URL('../../api/package.json', import.meta.url));
const express = apiRequire('express');
const request = apiRequire('supertest');
const { requestContext } = require('../../api/middleware/security.js');
const authSource = await readFile(new URL('../../api/middleware/auth.js', import.meta.url), 'utf8');
const apiIndexSource = await readFile(new URL('../../api/index.js', import.meta.url), 'utf8');
const contentsURL = new URL('../../api/routes/contents.js', import.meta.url);
const contentsFilename = fileURLToPath(contentsURL);
const contentsModule = new Module(contentsFilename);
const contentsRequire = createRequire(contentsFilename);
contentsModule.require = name => name === '../db' ? {} : name === '../middleware/auth'
  ? { authMiddleware() {}, firebaseAuth: {} } : contentsRequire(name);
contentsModule._compile(await readFile(contentsURL, 'utf8'), contentsFilename);
const { createContentsRouter } = contentsModule.exports;

const origin = 'https://portal.example.test';
const pageID = '018f47a2-7b3c-7a11-8a2c-1234567890ab';
const versionID = '018f47a2-7b3c-7a11-8a2c-1234567890ac';
const assetID = '018f47a2-7b3c-7a11-8a2c-1234567890ad';
const reader = { uid: 'reader-a', email: 'reader@example.test', name: 'Reader', role: 'user', permissions: {} };
const editor = { uid: 'editor-a', email: 'editor@example.test', name: 'Editor', role: 'admin', permissions: { manageKnowledge: true } };
const page = {
  id: pageID, slug: 'published-policy', title: 'Published policy', summary: '', cover: null, categories: [],
  published_at: '2026-10-19T10:00:00.000Z', content_version: 1, asset_scope: 'portal-pages',
  content_blocks: [{ type: 'divider' }], revision: { id: versionID, status: 'published' },
};
const preview = { ...page, asset_scope: 'portal-pages-preview', revision: { id: versionID, status: 'draft' } };
const env = { NODE_ENV: 'production', PORTAL_PUBLIC_URL: origin };

function loadAuthModule(state) {
  const filename = new URL('../../api/middleware/auth.js', import.meta.url);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  new Function('require', 'module', 'exports', authSource)(name => {
    if (name === 'firebase-admin/app') return { getApps: () => [1] };
    if (name === 'firebase-admin/auth') return { getAuth: () => state.firebaseAuth };
    if (name === '../db') return state.db;
    return localRequire(name);
  }, module, module.exports);
  return module.exports;
}

function fixture(settings = env) {
  const users = new Map([[reader.uid, reader], [editor.uid, editor]]);
  const calls = [];
  const state = { users, calls, firebaseError: null, activeFailure: null, issued: [], verified: [], settings };
  state.db = { async query(sql, values = []) {
    calls.push({ sql, values });
    if (state.activeFailure) throw state.activeFailure;
    if (sql.includes('FROM users u')) return { rows: users.has(values[0]) ? [users.get(values[0])] : [] };
    if (sql.includes('FROM pending_registrations')) return { rows: [] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  state.firebaseAuth = {
    async verifyIdToken(token, checkRevoked) {
      calls.push({ firebase: 'verifyIdToken', token, checkRevoked });
      assert.equal(checkRevoked, true);
      if (state.firebaseError) throw state.firebaseError;
      const uid = token === 'bearer-reader' ? reader.uid : token === 'bearer-editor' ? editor.uid : null;
      if (!uid) throw Object.assign(new Error('private token details'), { code: 'auth/invalid-id-token' });
      return { uid, email_verified: true };
    },
    async createSessionCookie(token, options) {
      calls.push({ firebase: 'createSessionCookie', token, options });
      state.issued.push({ token, options });
      if (state.firebaseError) throw state.firebaseError;
      return token === 'bearer-editor' ? 'editor.session.cookie' : 'reader.session.cookie';
    },
    async verifySessionCookie(cookie, checkRevoked) {
      calls.push({ firebase: 'verifySessionCookie', cookie, checkRevoked });
      state.verified.push({ cookie, checkRevoked });
      assert.equal(checkRevoked, true);
      if (state.firebaseError) throw state.firebaseError;
      const uid = cookie === 'reader.session.cookie' ? reader.uid : cookie === 'editor.session.cookie' ? editor.uid : null;
      if (!uid) throw Object.assign(new Error('private cookie details'), { code: 'auth/invalid-session-cookie' });
      return { uid, email_verified: true };
    },
  };

  state.payloadCalls = [];
  state.payloadCallOptions = [];
  state.listImpl = null;
  state.availabilityImpl = null;
  state.payloadClient = {
    async list(input, actor, options) {
      state.payloadCalls.push({ action: 'list', input, actor });
      state.payloadCallOptions.push(options);
      return state.listImpl ? state.listImpl(input, actor, options) : { rows: [page], count: 9 };
    },
    async availability(input, actor, options) {
      state.payloadCalls.push({ action: 'availability', input, actor });
      state.payloadCallOptions.push(options);
      return state.availabilityImpl ? state.availabilityImpl(input, actor, options) : { available: true };
    },
    async categories(input, actor) { state.payloadCalls.push({ action: 'categories', input, actor }); return [{ id: pageID, slug: 'policies', name: 'Policies', count: 2 }]; },
    async detail(input, actor) { state.payloadCalls.push({ action: 'detail', input, actor }); return input.slug === page.slug ? page : null; },
    async preview(input, actor) { state.payloadCalls.push({ action: 'preview', input, actor }); return input.pageId === pageID && input.versionId === versionID ? preview : null; },
    async asset(input, actor, options) {
      state.payloadCalls.push({ action: 'asset', input, actor, options });
      if (state.assetError) throw state.assetError;
      return { status: 206, headers: { 'Cache-Control': 'private,no-store', 'Content-Length': '4', 'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${assetID}.pdf"`, 'Accept-Ranges': 'bytes', 'Content-Range': 'bytes 1-4/8',
        'X-Content-Type-Options': 'nosniff' },
      body: new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([37, 80, 68, 70])); controller.close(); } }) };
    },
  };

  const auth = loadAuthModule(state);
  const authenticate = auth.createAuthMiddleware({ firebaseAuth: state.firebaseAuth, db: state.db });
  state.authenticate = authenticate;
  state.buildRequest = ({ payloadClient = state.payloadClient, payloadClientFactory } = {}) => {
    const app = express();
    app.use(requestContext);
    app.use('/api/contents', createContentsRouter({ db: state.db, firebaseAuth: state.firebaseAuth, authenticate,
      payloadClient, payloadClientFactory, env: settings }));
    return request(app);
  };
  const app = express();
  app.use(requestContext);
  app.use((req, res, next) => {
    if (state.captureSignalCleanup) {
      const requestListeners = new Set(req.listeners('aborted'));
      const responseListeners = new Set(res.listeners('close'));
      res.once('close', () => setImmediate(() => {
        state.requestSignalListenersCleaned = !req.listeners('aborted').some(listener => !requestListeners.has(listener))
          && !res.listeners('close').some(listener => !responseListeners.has(listener));
      }));
    }
    next();
  });
  app.use('/api/contents', createContentsRouter({ db: state.db, firebaseAuth: state.firebaseAuth, authenticate,
    payloadClient: state.payloadClient, env: settings }));
  state.app = app;
  state.request = request(app);
  state.withBearer = call => call.set('Authorization', 'Bearer bearer-reader');
  const localDevelopment = settings.NODE_ENV === 'development' && /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/u.test(settings.PORTAL_PUBLIC_URL || '');
  const mediaCookieName = localDevelopment ? 'ownerinc-content-media-dev' : '__Secure-ownerinc-content-media';
  state.cookie = uid => `${mediaCookieName}=${uid === 'editor' ? 'editor.session.cookie' : 'reader.session.cookie'}`;
  return state;
}

test('availability is authenticated, exact, bodyless, and independent of editorial permission', async () => {
  const state = fixture();
  assert.equal((await state.request.get('/api/contents/availability')).status, 401);

  const response = await state.withBearer(state.request.get('/api/contents/availability'));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { available: true });
  assert.deepEqual(Object.keys(response.body), ['available']);
  assert.equal(response.headers['cache-control'], 'private,no-store');
  assert.deepEqual(state.payloadCalls[0].input, {});
  assert.equal(state.payloadCalls[0].actor.canManageKnowledge, false);
  assert.equal(state.payloadCallOptions[0].signal instanceof AbortSignal, true);
  assert.equal(typeof state.payloadCallOptions[0].requestId, 'string');
  assert.equal(Number.isSafeInteger(state.payloadCallOptions[0].deadlineAt), true);
  assert.equal(state.payloadCalls[0].action, 'availability');

  for (const url of ['/api/contents/availability?extra=1', '/api/contents/availability?x=1&x=2']) {
    assert.equal((await state.withBearer(state.request.get(url))).status, 400, url);
  }
  assert.equal((await state.withBearer(state.request.get('/api/contents/availability').send({ unexpected: true }))).status, 400);
  assert.equal((await state.withBearer(state.request.get('/api/contents/availability').set('Transfer-Encoding', 'chunked').send('x'))).status, 400);
  assert.equal(state.payloadCalls.length, 1, 'invalid query/body never reaches Payload');
});

test('availability distinguishes empty from inconsistent and unavailable Payload results', async () => {
  const state = fixture();
  state.availabilityImpl = async () => ({ available: false });
  const empty = await state.withBearer(state.request.get('/api/contents/availability'));
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { available: false });

  const invalidResults = [
    null,
    { available: 'true' },
    { available: true, count: 1 },
    { available: false, rows: [] },
    [],
  ];
  for (const invalid of invalidResults) {
    state.availabilityImpl = async () => invalid;
    const response = await state.withBearer(state.request.get('/api/contents/availability'));
    assert.equal(response.status, 503);
    assert.equal(response.body.reason, 'portal_pages_unavailable');
    assert.equal(response.text.includes('count'), false);
    assert.equal(response.text.includes('content_blocks'), false);
  }

  state.availabilityImpl = async () => { throw new Error('private Payload client exception'); };
  const failed = await state.withBearer(state.request.get('/api/contents/availability'));
  assert.equal(failed.status, 503);
  assert.equal(failed.body.reason, 'portal_pages_unavailable');
  assert.doesNotMatch(failed.text, /private Payload|Published policy|reader-a|count/u);
});

test('availability rejects disabled and unapproved users through the real authentication middleware', async () => {
  const disabled = fixture();
  disabled.users.set(reader.uid, { ...reader, permissions: { accountDisabled: true } });
  const disabledResponse = await disabled.withBearer(disabled.request.get('/api/contents/availability'));
  assert.equal(disabledResponse.status, 403);
  assert.equal(disabled.payloadCalls.length, 0);

  const unapproved = fixture();
  unapproved.users.delete(reader.uid);
  unapproved.db.query = async (sql, values = []) => {
    if (sql.includes('FROM users u')) return { rows: [] };
    if (sql.includes('FROM pending_registrations')) return { rows: [{ status: 'pending' }] };
    throw new Error(`Unexpected SQL: ${sql} ${values}`);
  };
  const pendingResponse = await unapproved.withBearer(unapproved.request.get('/api/contents/availability'));
  assert.equal(pendingResponse.status, 403);
  assert.equal(pendingResponse.body.reason, 'pending-approval');
  assert.equal(unapproved.payloadCalls.length, 0);
});

test('availability factory failures and client timeouts fail closed without disclosing private details', async () => {
  const state = fixture();
  const factoryRequest = state.buildRequest({ payloadClient: null,
    payloadClientFactory: () => { throw new Error('secret factory configuration'); } });
  const factoryError = await state.withBearer(factoryRequest.get('/api/contents/availability'));
  assert.equal(factoryError.status, 503);
  assert.equal(factoryError.body.reason, 'portal_pages_unavailable');
  assert.doesNotMatch(factoryError.text, /secret factory|client|actor|reader-a/u);

  state.availabilityImpl = async () => { throw Object.assign(new Error('private timeout details'), { code: 'ETIMEDOUT', status: 504 }); };
  const timeout = await state.withBearer(state.request.get('/api/contents/availability'));
  assert.equal(timeout.status, 503);
  assert.equal(timeout.body.reason, 'portal_pages_unavailable');
  assert.doesNotMatch(timeout.text, /private timeout|ETIMEDOUT|reader-a/u);
});

test('availability aborts Payload work on client disconnect and static route precedes slug detail', async () => {
  const state = fixture();
  state.availabilityImpl = (_input, _actor, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      state.disconnectedSignalAborted = options.signal.aborted;
      reject(Object.assign(new Error('request aborted'), { name: 'AbortError' }));
    }, { once: true });
    state.disconnectReady = true;
  });
  // Exercise the real HTTP close/abort hooks without starting external services.
  state.captureSignalCleanup = true;
  const server = state.app.listen(0);
  try {
    const address = server.address();
    const controller = new AbortController();
    const responsePromise = fetch(`http://127.0.0.1:${address.port}/api/contents/availability`, {
      headers: { Authorization: 'Bearer bearer-reader' }, signal: controller.signal,
    }).catch(error => error);
    for (let attempt = 0; attempt < 20 && !state.disconnectReady; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(state.disconnectReady, true, 'availability must dispatch the existence query');
    controller.abort();
    await responsePromise;
    for (let attempt = 0; attempt < 20 && !state.disconnectedSignalAborted; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(state.disconnectedSignalAborted, true);
    for (let attempt = 0; attempt < 20 && state.requestSignalListenersCleaned === undefined; attempt += 1) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(state.requestSignalListenersCleaned, true, 'abort and close listeners must be removed after disconnect');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  const staticState = fixture();
  const staticResponse = await staticState.withBearer(staticState.request.get('/api/contents/availability'));
  assert.equal(staticResponse.status, 200);
  assert.equal(staticState.payloadCalls[0].action, 'availability', 'availability must use the dedicated early-exit CMS action');
});

function cookieFor(response, expectedName) {
  const value = response.headers['set-cookie']?.find(cookie => cookie.startsWith(`${expectedName}=`));
  assert.ok(value, `expected ${expectedName} Set-Cookie`);
  return value;
}

test('API mounts Portal content reads before global JSON parsers and keeps the CMS bodyless boundary', () => {
  const route = apiIndexSource.indexOf("app.use('/api/contents'");
  const parser = apiIndexSource.indexOf('app.use(express.json({ limit: \'100kb\' }))');
  assert.notEqual(route, -1);
  assert.notEqual(parser, -1);
  assert.ok(route < parser);
});

test('published JSON routes require Bearer auth, route static paths before slug, and keep bounded query contracts', async () => {
  const state = fixture();
  assert.equal((await state.request.get('/api/contents/')).status, 401);
  assert.equal((await state.request.get('/api/contents/categories')).status, 401);
  assert.equal((await state.request.get(`/api/contents/preview/${pageID}?version=${versionID}`).set('Cookie', state.cookie())).status, 401);

  const list = await state.withBearer(state.request.get('/api/contents/?limit=1&offset=0&category=policies'));
  assert.equal(list.status, 200);
  assert.deepEqual(list.body, [page]);
  assert.equal(list.headers['x-total-count'], '9');
  assert.equal(list.headers['cache-control'], 'private,no-store');
  assert.deepEqual(state.payloadCalls[0], { action: 'list', input: { limit: 1, offset: 0, category: 'policies' },
    actor: { uid: reader.uid, email: reader.email, name: reader.name, canManageKnowledge: false } });

  const categories = await state.withBearer(state.request.get('/api/contents/categories'));
  assert.deepEqual(categories.body, [{ id: pageID, slug: 'policies', name: 'Policies', count: 2 }]);
  assert.equal(state.payloadCalls[1].action, 'categories', 'static categories must not fall through to /:slug');
  const detail = await state.withBearer(state.request.get('/api/contents/published-policy'));
  assert.deepEqual(detail.body, page);
  assert.equal(state.payloadCalls[2].input.slug, 'published-policy');

  for (const url of ['/api/contents/?limit=0', '/api/contents/?limit=51', '/api/contents/?offset=1000001',
    '/api/contents/?category=Not-Slug', '/api/contents/?limit=1&limit=2', '/api/contents/?unknown=1']) {
    assert.equal((await state.withBearer(state.request.get(url))).status, 400, url);
  }
  assert.equal((await state.withBearer(state.request.get('/api/contents/').send({ unexpected: true }))).status, 400,
    'normal JSON routes reject request bodies');
});

test('exact saved preview requires manageKnowledge and passes only the verified actor and UUIDs', async () => {
  const state = fixture();
  const denied = await state.request.get(`/api/contents/preview/${pageID}?version=${versionID}`).set('Authorization', 'Bearer bearer-reader');
  assert.equal(denied.status, 403);
  assert.equal(state.payloadCalls.length, 0);

  const result = await state.request.get(`/api/contents/preview/${pageID}?version=${versionID}`).set('Authorization', 'Bearer bearer-editor');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, preview);
  assert.deepEqual(state.payloadCalls[0], { action: 'preview', input: { pageId: pageID, versionId: versionID },
    actor: { uid: editor.uid, email: editor.email, name: editor.name, canManageKnowledge: true } });
  for (const url of [`/api/contents/preview/${pageID}`, `/api/contents/preview/${pageID}?version=${versionID}&version=${pageID}`,
    `/api/contents/preview/not-a-uuid?version=${versionID}`, `/api/contents/preview/${pageID}?version=${versionID}&source=legacy`]) {
    assert.equal((await state.request.get(url).set('Authorization', 'Bearer bearer-editor')).status, 400, url);
  }
});

test('media-session issues a five-minute Firebase cookie only for same-origin, bodyless authenticated requests', async () => {
  const state = fixture();
  assert.equal((await state.request.post('/api/contents/media-session').set('Origin', origin)).status, 401);
  assert.equal((await state.request.post('/api/contents/media-session').set('Authorization', 'Bearer bearer-reader')).status, 403);
  const body = await state.request.post('/api/contents/media-session').set('Origin', origin).set('Sec-Fetch-Site', 'cross-site')
    .set('Authorization', 'Bearer bearer-reader');
  assert.equal(body.status, 403);
  const rejectedBody = await state.request.post('/api/contents/media-session').set('Origin', origin)
    .set('Authorization', 'Bearer bearer-reader').send({ token: 'must-not-be-accepted' });
  assert.equal(rejectedBody.status, 400);
  assert.equal(state.issued.length, 0);

  const issued = await state.request.post('/api/contents/media-session').set('Origin', origin)
    .set('Authorization', 'Bearer bearer-reader');
  assert.equal(issued.status, 204);
  assert.equal(issued.text, '');
  assert.deepEqual(state.issued.at(-1), { token: 'bearer-reader', options: { expiresIn: 300000 } });
  const header = cookieFor(issued, '__Secure-ownerinc-content-media');
  assert.match(header, /; Path=\/api\/contents\/assets;/);
  assert.match(header, /; Max-Age=300;/);
  const expiresAt = Date.parse(header.match(/; Expires=([^;]+)/u)[1]);
  assert.ok(Math.abs(expiresAt - (Date.now() + 300_000)) < 3000, 'Expires is five minutes from issuance');
  assert.match(header, /; HttpOnly; Secure; SameSite=Strict$/);
  assert.equal(JSON.stringify(issued.body).includes('session.cookie'), false);
});

test('development cookie name is restricted to localhost HTTP; logout is same-origin and idempotently clears its path', async () => {
  const local = fixture({ NODE_ENV: 'development', PORTAL_PUBLIC_URL: 'http://localhost:8080' });
  const issued = await local.request.post('/api/contents/media-session').set('Origin', 'http://localhost:8080')
    .set('Authorization', 'Bearer bearer-editor');
  assert.equal(issued.status, 204);
  const header = cookieFor(issued, 'ownerinc-content-media-dev');
  assert.match(header, /; Path=\/api\/contents\/assets;/);
  assert.match(header, /; HttpOnly; SameSite=Strict$/);
  assert.doesNotMatch(header, /; Secure(?:;|$)/);

  const logout = await local.request.delete('/api/contents/media-session').set('Origin', 'http://localhost:8080');
  assert.equal(logout.status, 204);
  assert.match(cookieFor(logout, 'ownerinc-content-media-dev'), /; Path=\/api\/contents\/assets;/);
  assert.match(cookieFor(logout, 'ownerinc-content-media-dev'), /Expires=Thu, 01 Jan 1970/);
  assert.equal((await local.request.delete('/api/contents/media-session').set('Origin', 'http://evil.example')).status, 403);
  assert.equal((await local.request.delete('/api/contents/media-session').set('Origin', 'http://localhost:8080').send({ x: 1 })).status, 400);
});

test('asset reads use only a verified media cookie, re-check active identity, and preserve bounded range headers', async () => {
  const state = fixture();
  const assetPath = `/api/contents/assets/${pageID}/${versionID}/${assetID}`;
  assert.equal((await state.request.get(assetPath).set('Authorization', 'Bearer bearer-reader')).status, 401,
    'a Firebase bearer must not substitute for the media cookie');
  const response = await state.request.get(assetPath).set('Cookie', state.cookie()).set('Range', 'bytes=1-4')
    .buffer(true).parse((incoming, callback) => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => callback(null, Buffer.concat(chunks)));
    });
  assert.equal(response.status, 206);
  assert.equal(response.body.toString(), '%PDF');
  assert.equal(response.headers['content-range'], 'bytes 1-4/8');
  assert.equal(response.headers['cache-control'], 'private,no-store');
  assert.equal(state.verified.length, 1);
  assert.deepEqual(state.verified[0], { cookie: 'reader.session.cookie', checkRevoked: true });
  assert.deepEqual(state.payloadCalls[0].input, { pageId: pageID, revisionId: versionID, assetId: assetID, preview: false, range: 'bytes=1-4' });
  assert.deepEqual(state.payloadCalls[0].actor, { uid: reader.uid, email: reader.email, name: reader.name, canManageKnowledge: false });
  assert.equal(state.payloadCalls[0].options.signal instanceof AbortSignal, true);
});

test('invalid, duplicate, revoked, expired, and unknown media cookies are rejected and cleared', async () => {
  const state = fixture();
  const assetPath = `/api/contents/assets/${pageID}/${versionID}/${assetID}`;
  assert.equal((await state.request.get(assetPath)).status, 401);

  for (const cookie of ['__Secure-ownerinc-content-media=reader.session.cookie; __Secure-ownerinc-content-media=other.cookie',
    '__Secure-ownerinc-content-media=invalid cookie']) {
    const response = await state.request.get(assetPath).set('Cookie', cookie);
    assert.equal(response.status, 401);
    assert.match(cookieFor(response, '__Secure-ownerinc-content-media'), /Expires=Thu, 01 Jan 1970/);
  }

  for (const code of ['auth/session-cookie-expired', 'auth/session-cookie-revoked', 'auth/invalid-session-cookie']) {
    state.firebaseError = Object.assign(new Error('private Firebase detail'), { code });
    const response = await state.request.get(assetPath).set('Cookie', state.cookie());
    assert.equal(response.status, 401);
    assert.match(cookieFor(response, '__Secure-ownerinc-content-media'), /Expires=Thu, 01 Jan 1970/);
    assert.doesNotMatch(response.text, /private Firebase detail/);
  }

  state.firebaseError = null;
  state.users.delete(reader.uid);
  state.db.query = async sql => sql.includes('pending_registrations') ? { rows: [] } : { rows: [] };
  const inactive = await state.request.get(assetPath).set('Cookie', state.cookie());
  assert.equal(inactive.status, 403, 'the current Portal account state is checked after Firebase verification');

  const disabled = fixture();
  disabled.users.set(reader.uid, { ...reader, permissions: { accountDisabled: true } });
  assert.equal((await disabled.request.get(assetPath).set('Cookie', disabled.cookie())).status, 403,
    'Firebase validity does not override the current Portal disabled state');
});

test('preview asset cookies require an active manageKnowledge editor and exact asset input', async () => {
  const state = fixture();
  const previewAsset = `/api/contents/assets/preview/${pageID}/${versionID}/${assetID}`;
  const denied = await state.request.get(previewAsset).set('Cookie', state.cookie());
  assert.equal(denied.status, 403);
  assert.equal(state.payloadCalls.length, 0);

  const accepted = await state.request.get(previewAsset).set('Cookie', state.cookie('editor'));
  assert.equal(accepted.status, 206);
  assert.equal(state.payloadCalls[0].input.preview, true);
  assert.equal(state.payloadCalls[0].input.revisionId, versionID);
  assert.equal(state.payloadCalls[0].actor.uid, editor.uid);
  assert.equal(state.payloadCalls[0].options.signal instanceof AbortSignal, true);
  assert.equal((await state.request.get(`/api/contents/assets/not-a-uuid/${versionID}/${assetID}`).set('Cookie', state.cookie())).status, 400);

  state.assetError = Object.assign(new Error('not found'), { status: 404 });
  const stale = await state.request.get(`/api/contents/assets/${pageID}/${versionID}/${assetID}`).set('Cookie', state.cookie());
  assert.equal(stale.status, 404);
});

test('same-origin media configuration and bodyless checks fail closed without leaking service/Firebase values', async () => {
  for (const settings of [
    { NODE_ENV: 'production', PORTAL_PUBLIC_URL: 'http://portal.example.test' },
    { NODE_ENV: 'development', PORTAL_PUBLIC_URL: 'http://portal.example.test' },
    { NODE_ENV: 'production', PORTAL_PUBLIC_URL: 'https://portal.example.test/path' },
  ]) {
    const state = fixture(settings);
    const response = await state.request.post('/api/contents/media-session').set('Origin', settings.PORTAL_PUBLIC_URL)
      .set('Authorization', 'Bearer bearer-reader');
    assert.equal(response.status, 503);
    assert.doesNotMatch(response.text, /Bearer|secret|cookie/i);
  }
});
