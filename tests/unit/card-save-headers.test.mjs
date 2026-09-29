import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { createFeedbackHarness, drain } from '../helpers/frontend-feedback-harness.mjs';

const require = createRequire(new URL('../../api/package.json', import.meta.url));
const express = require('express');
const authSource = (await readFile('public/js/auth.js', 'utf8')).replace(/^import[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
const fixtureToken = 'card-header-fixture';

async function probeServer(t) {
  const received = [];
  const app = express();
  app.use((req, res, next) => {
    if (req.get('authorization') !== `Bearer ${fixtureToken}`) return res.status(403).json({ error: 'Fixture authorization denied.' });
    next();
  });
  app.post('/api/:tool/media', express.raw({ type: () => true }), (req, res) => {
    received.push({ path: req.path, method: req.method, headers: req.headers, rawHeaders: req.rawHeaders, body: req.body });
    res.status(201).json({ id: 'fixture-media' });
  });
  app.use(express.json());
  app.all('/api/:tool/cards/:id?', (req, res) => {
    received.push({ path: req.path, method: req.method, headers: req.headers, rawHeaders: req.rawHeaders, body: req.body });
    if (!req.body?.template) return res.status(400).json({ error: 'JSON body was not parsed.' });
    res.status(req.method === 'POST' ? 201 : 200).json({ ...req.body, id: req.params.id || 'fixture-card' });
  });
  const server = createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
  return { base: `http://127.0.0.1:${server.address().port}`, received };
}

// Auth source is complete and unchanged except ES module linkage. Firebase and
// storage are explicit doubles; fetch/Headers serialization and Express parsing
// are real. This probe does not stand in for API authorization or persistence.
function authenticatedClient(h, base) {
  const sent = [];
  const values = new Map();
  const auth = { currentUser: { uid: 'fixture-user', getIdToken: async () => fixtureToken }, authStateReady: async () => {} };
  const context = vm.createContext({
    auth, document: h.doc, URL, URLSearchParams, DOMException, console,
    window: { location: { href: `${base}/autocard.html`, replace() {} } },
    sessionStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
    onAuthStateChanged: () => () => {}, signOut: async () => { auth.currentUser = null; }, updateProfile: async () => {},
    fetch: (path, options) => { sent.push({ path, options }); return fetch(new URL(path, base), options); },
  });
  vm.runInContext(`${authSource}\nglobalThis.api = { fetchAPI };`, context, { filename: 'public/js/auth.js' });
  return { api: context.api, sent };
}

async function composeRequest(h, client, request) {
  assert.ok(request, 'the real mounted caller must dispatch its request');
  try { request.resolve(await client.api.fetchAPI(request.path, request.options)); }
  catch (error) { request.reject(error); }
  await drain();
}

for (const [tool, template] of [
  ...['comunicado', 'vaga', 'aniversariante', 'novo_funcionario'].map(template => ['autocard', template]),
  ...['convite_owntime', 'convite_owner'].map(template => ['cards-pos', template]),
]) test(`${tool} ${template} POST/PUT caller composes one JSON Content-Type with the real auth helper`, { timeout: 10000 }, async t => {
  const probe = await probeServer(t);
  const expose = tool === 'autocard'
    ? 'globalThis.cardProbe = { selectTemplate, save: saveCard, current: () => current };'
    : 'globalThis.cardProbe = { selectTemplate: switchModule, save: () => saveWithName("Convite de teste"), current: () => current };';
  const h = await createFeedbackHarness(tool, { expose }); t.after(() => h.page.dispose());
  const client = authenticatedClient(h, probe.base);
  h.context.cardProbe.selectTemplate(template);
  for (const method of ['POST', 'PUT']) {
    const saving = h.context.cardProbe.save(); saving.catch(() => {});
    const request = h.requests.at(-1);
    const payload = JSON.parse(request.options.body);
    assert.equal(request.options.method, method);
    assert.equal(payload.template, template);
    if (tool === 'autocard') assert.deepEqual(Object.keys(payload).sort(), ['icon', 'illustration', 'mediaCrop', 'mediaId', 'mediaSize', 'mode', 'name', 'template', 'values', 'variant']);
    else assert.deepEqual(Object.keys(payload).sort(), ['mediaId', 'name', 'template', 'values']);
    await composeRequest(h, client, request); await saving;
    const received = probe.received.at(-1), outgoing = client.sent.at(-1);
    assert.equal(received.headers['content-type'], 'application/json');
    assert.equal(received.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'content-type').length, 1);
    assert.equal(Object.keys(outgoing.options.headers).filter(key => key.toLowerCase() === 'content-type').length, 1);
    assert.equal(received.headers.authorization, `Bearer ${fixtureToken}`);
    assert.equal(received.method, method); assert.deepEqual(received.body, payload);
    assert.equal(h.context.cardProbe.current().editingId, 'fixture-card');
    assert.equal(h.node('saveButton').disabled, false);
    if (method === 'PUT') assert.ok(received.path.endsWith('/fixture-card'));
  }
});

for (const tool of ['autocard', 'cards-pos']) test(`${tool} binary upload caller keeps its MIME and original bytes through auth composition`, { timeout: 10000 }, async t => {
  const probe = await probeServer(t);
  const expose = tool === 'autocard' ? 'globalThis.cardProbe = { upload, selectTemplate };' : 'globalThis.cardProbe = { upload };';
  const h = await createFeedbackHarness(tool, { expose }); t.after(() => h.page.dispose());
  const client = authenticatedClient(h, probe.base);
  h.context.URL.createObjectURL = () => 'blob:fixture-local';
  h.context.Image = class {
    naturalWidth = 800; naturalHeight = 800; complete = true;
    set src(value) { if (value) queueMicrotask(() => this.onload?.()); }
  };
  if (tool === 'autocard') h.context.cardProbe.selectTemplate('aniversariante');
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 4]);
  const file = new Blob([bytes], { type: 'image/png' });
  const uploading = h.context.cardProbe.upload(file); uploading.catch(() => {}); await drain();
  const request = h.requests.find(item => item.options.method === 'POST');
  assert.ok(request); assert.equal(request.options.body, file);
  await composeRequest(h, client, request);
  const asset = h.requests.find(item => item.kind === 'asset');
  if (asset) asset.resolve('blob:fixture-remote');
  await drain(); await uploading;
  const received = probe.received.at(-1);
  assert.equal(received.headers['content-type'], 'image/png');
  assert.deepEqual(received.body, Buffer.from(bytes));
  assert.equal(Object.keys(client.sent.at(-1).options.headers).filter(key => key.toLowerCase() === 'content-type').length, 1);
});

test('the real parser probe detects the duplicate JSON MIME regression rather than accepting an ignored body', async t => {
  const probe = await probeServer(t);
  const response = await fetch(`${probe.base}/api/autocard/cards`, {
    method: 'POST', body: JSON.stringify({ template: 'comunicado' }),
    headers: { Authorization: `Bearer ${fixtureToken}`, 'Content-Type': 'application/json', 'content-type': 'application/json' },
  });
  assert.equal(response.status, 400);
  assert.equal(probe.received[0].headers['content-type'], 'application/json, application/json');
  assert.deepEqual(probe.received[0].body, {});
});
