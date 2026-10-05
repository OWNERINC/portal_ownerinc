import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeedbackHarness, installAuthTransport, deferred, drain, TestEvent } from '../helpers/frontend-feedback-harness.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const version = '22222222-2222-4222-8222-222222222222';
const user = { uid: 'editor-a', role: 'admin', permissions: { manageKnowledge: true } };
const story = (status, source = 'payload') => ({ id, title: 'Revisão exata', content_version: 2, asset_scope: 'owner-news-preview',
  preview_revision: { id: version, source, status }, content_blocks: [
    { type: 'image', asset_id: id, alt: 'Privada', usage: 'cover' },
    { type: 'rich_text', nodes: [{ type: 'paragraph', children: [{ type: 'text', text: 'Texto salvo.', marks: ['bold'] }] }] },
  ] });
async function setup(search = `?id=${id}&version=${version}`, actor = user, realAuth = false) {
  const h = await createFeedbackHarness('news-preview', { mount: false, url: `https://portal.test/news-preview.html${search}`, modules: [
    { path: 'public/js/owner-news/model.js', exports: 'getNewsPresentation, normalizeEditorial, estimateNewsReadTime' },
    { path: 'public/js/owner-news/reader-view.js', exports: 'renderNewsArticle' },
    { path: 'public/js/news-preview.js', exports: 'mountNewsPreview' },
  ] });
  h.context.can = (u, permission) => u?.role === 'admin' && u.permissions?.[permission] === true;
  if (realAuth) h.transport = await installAuthTransport(h, actor.uid);
  h.page.user = actor; h.context.mountNewsPreview(h.page); await drain(); return h;
}
test('preview query and editorial permission fail closed before reading a revision', async () => {
  for (const query of ['', `?id=${id}`, `?id=${id}&version=now`, `?id=${id}&version=${version}&source=remote`,
    `?id=${id}&version=${version}&token=secret`, `?id=${id}&id=${id}&version=${version}`, `?id=${id}&version=${version}&source=`]) {
    const h = await setup(query); assert.equal(h.requests.length, 0); assert.match(h.node('news-preview-status').textContent, /inválid/); h.page.dispose();
  }
  const h = await setup(undefined, { uid: 'reader', role: 'viewer' });
  assert.equal(h.requests.length, 0); assert.match(h.node('news-preview-status').textContent, /permissão/); h.page.dispose();
});

for (const phase of ['json', 'blob']) test(`real auth epoch blocks cross-account completion during ${phase} decode, even before router disposal`, async () => {
  const h = await setup(undefined, user, true);
  const { requests, changeUser, created } = h.transport;
  requests[0].resolve(Response.json(user)); await drain();
  const body = deferred();
  if (phase === 'json') requests[1].resolve({ ok: true, status: 200, headers: new Headers(), json: () => body.promise });
  else {
    requests[1].resolve(Response.json(story('draft'))); await drain();
    requests[2].resolve({ ok: true, status: 200, headers: new Headers(), blob: () => body.promise });
  }
  await drain(); changeUser('editor-b');
  assert.equal(h.node('main-content').children.length, 0, 'real auth immediately clears old-account content');
  body.resolve(phase === 'json' ? story('draft') : new Blob(['private'])); await drain();
  assert.equal(h.node('main-content').children.length, 0);
  assert.equal(created.length, 0, 'old-account bytes never become a blob URL');
  h.page.dispose();
});

test('source=legacy accepts the unchanged v1 body and legacy private-media default', async () => {
  const h = await setup(`?id=${id}&version=${version}&source=legacy`);
  h.latest('/api/users/me').resolve(user); await drain();
  h.latest('/preview/').resolve({ id, title: 'Legado', editorial: null, content_blocks: [
    { type: 'image', asset_id: id, alt: 'Legada' }, { type: 'paragraph', text: 'Texto legado.' },
  ] }); await drain();
  assert.match(h.node('news-preview-status').textContent, /Histórico anterior à migração/);
  assert.match(h.node('news-preview-content').textContent, /Texto legado/);
  assert.equal(h.requests.at(-1).path, `/api/cms/assets/${id}`); h.page.dispose();
});
test('exact persisted URL, private cover and honest status for draft/published/legacy/absent metadata', async () => {
  for (const [status, source, expected] of [['draft', 'payload', /Conteúdo não publicado/], ['published', 'payload', /salva como publicada/],
    ['published', 'legacy', /Histórico anterior à migração/], ['scheduled', 'legacy', /agendada/], [null, 'payload', /Revisão salva/]]) {
    const h = await setup(`?id=${id}&version=${version}&source=${source}`);
    h.latest('/api/users/me').resolve(user); await drain();
    assert.equal(h.requests.at(-1).path, `/api/announcements/preview/${id}?version=${version}&source=${source}`);
    const data = story(status, source); if (!status) delete data.preview_revision;
    h.requests.at(-1).resolve(data); await drain();
    assert.match(h.node('news-preview-status').textContent, expected);
    if (status !== 'draft') assert.doesNotMatch(h.node('news-preview-status').textContent, /Conteúdo não publicado/);
    assert.equal(h.doc.querySelectorAll('h1').length, 1);
    assert.equal(h.node('news-preview-title').tagName, 'H2');
    assert.match(h.node('news-preview-content').textContent, /Texto salvo/);
    assert.equal(h.requests.at(-1).path, `/api/announcements/preview/assets/${id}`);
    h.page.dispose(); h.requests.at(-1).resolve('blob:late-preview'); await drain();
    assert.ok(h.revoked.includes('blob:late-preview')); assert.equal(h.node('news-preview-content').children.length, 0);
  }
});
test('permission loss clears content and media; local retry preserves query and does not save', async () => {
  const h = await setup(); h.latest('/api/users/me').resolve(user); await drain();
  h.latest('/preview/').reject(new Error('offline')); await drain();
  const retry = h.node('news-preview-status').querySelector('button'); retry.focus(); retry.click();
  assert.equal(h.doc.activeElement, h.node('news-preview-status'));
  h.latest('/api/users/me').resolve(user); await drain();
  h.latest('/preview/').resolve(story('draft')); await drain();
  assert.equal(h.doc.activeElement, h.node('news-preview-status'), 'async success does not move focus');
  h.latest('/assets/').resolve('blob:loaded'); await drain();
  h.window.dispatchEvent(new TestEvent('focus')); await drain();
  assert.equal(h.node('news-preview-content').children.length, 0); assert.ok(h.revoked.includes('blob:loaded'));
  h.latest('/api/users/me').resolve({ ...user, permissions: {} }); await drain();
  assert.match(h.node('news-preview-status').textContent, /permissão/);
  assert.equal(h.requests.filter(r => r.path.includes('/preview/') && r.kind === 'api').length, 2);
  assert.ok(h.requests.every(r => !r.options.method || r.options.method === 'GET')); h.page.dispose();
});
test('preview refuses mismatched metadata, revoked permission and late old-account responses', async () => {
  for (const data of [story('draft', 'legacy'), { ...story('draft'), id: version }, { ...story('draft'), asset_scope: 'owner-news' },
    { ...story('draft'), preview_revision: { id, source: 'payload', status: 'draft' } }]) {
    const h = await setup(); h.latest('/api/users/me').resolve(user); await drain(); h.latest('/preview/').resolve(data); await drain();
    assert.equal(h.node('news-preview-content').children.length, 0); assert.equal(h.requests.filter(r => r.kind === 'asset').length, 0); h.page.dispose();
  }
  for (const status of [403, 404]) {
    const h = await setup(); h.latest('/api/users/me').resolve(user); await drain();
    h.latest('/preview/').reject(Object.assign(new Error('gone'), { status })); await drain();
    assert.equal(h.node('news-preview-content').children.length, 0); assert.equal(h.node('news-preview-status').querySelector('button'), null); h.page.dispose();
  }
  const h = await setup(); h.latest('/api/users/me').resolve(user); await drain(); const pending = h.latest('/preview/');
  h.page.dispose(); pending.resolve(story('draft')); await drain();
  assert.equal(pending.options.signal.aborted, true); assert.equal(h.node('news-preview-content').children.length, 0);
  assert.equal(h.requests.filter(r => r.kind === 'asset').length, 0);
  const changed = await setup(); changed.latest('/api/users/me').resolve({ ...user, uid: 'editor-b' }); await drain();
  assert.equal(changed.requests.length, 1); assert.equal(changed.node('news-preview-content').children.length, 0); changed.page.dispose();
});
