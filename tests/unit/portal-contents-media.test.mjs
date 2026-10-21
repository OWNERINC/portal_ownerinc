import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentsHarness, createContentsClock, createContentsBroadcastBus } from '../helpers/portal-contents-harness.mjs';
import { ASSET_ID, PAGE_ID, REVISION_ID, clone, pageFixture } from '../helpers/portal-contents-fixtures.mjs';
import { TestEvent, drain } from '../helpers/frontend-feedback-harness.mjs';

const ok = () => new Response(null, { status: 204 });
const errorResponse = (status, headers = {}) => new Response(null, { status, headers });
const contextFor = signal => ({ signal, isCurrent: () => true, onReload() {} });

async function acquire(h, signal = new AbortController().signal, statuses = []) {
  const lease = h.modules.mediaSession.acquireContentsMediaLease({ signal, isCurrent: () => true,
    onStatus: status => statuses.push(status) });
  return { lease, statuses };
}

test('media issue is bodyless, coalesced, and renews from request start without making navigation busy', async () => {
  const clock = createContentsClock();
  const h = await createContentsHarness({ clock });
  const { lease } = await acquire(h);
  const first = lease.ensureFresh();
  const joined = lease.ensureFresh();
  assert.equal(h.pendingIssues.length, 1);
  assert.equal(h.pendingIssues[0].path, '/api/contents/media-session');
  assert.equal(h.pendingIssues[0].options.method, 'POST');
  assert.equal(Object.hasOwn(h.pendingIssues[0].options, 'body'), false);
  assert.equal(h.pendingIssues[0].options.credentials, 'same-origin');
  assert.equal(h.pendingIssues[0].options.cache, 'no-store');
  assert.equal(h.page.busy, false);
  await clock.advance(10_000);
  h.pendingIssues[0].resolve(ok());
  await Promise.all([first, joined]);
  await clock.advance(229_999);
  assert.equal(h.pendingIssues.length, 1);
  await clock.advance(1);
  assert.equal(h.pendingIssues.length, 2, 'the renewal boundary is 240 seconds after issue start, not response completion');
  assert.deepEqual(h.pendingIssues.map(item => Object.hasOwn(item.options, 'body')), [false, false]);
});

test('only an exact 204 grants media preparation; issue timeout and JSON success fail closed', async () => {
  const clock = createContentsClock();
  const h = await createContentsHarness({ clock });
  const { lease, statuses } = await acquire(h);
  const timedOut = lease.ensureFresh();
  const timeoutAssertion = assert.rejects(timedOut);
  await clock.advance(15_000);
  await timeoutAssertion;
  assert.equal(lease.isPrepared(), false);
  assert.ok(statuses.includes('unavailable'));

  const retried = lease.ensureFresh({ force: true });
  h.pendingIssues.at(-1).resolve(Response.json({ expiresAt: 'ignored' }, { status: 200 }));
  await assert.rejects(retried);
  assert.equal(lease.isPrepared(), false, 'an envelope is not a cookie lease');
  assert.ok(statuses.includes('unavailable'));
});

test('leases share an issuance, disposing one does not cancel another, and a remount issues again', async () => {
  const h = await createContentsHarness();
  const first = await acquire(h);
  const second = await acquire(h);
  const a = first.lease.ensureFresh();
  const b = second.lease.ensureFresh();
  assert.equal(h.pendingIssues.length, 1);
  first.lease.release();
  assert.equal(h.pendingIssues[0].options.signal.aborted, false);
  h.pendingIssues[0].resolve(ok());
  await Promise.all([a, b]);
  second.lease.release();
  assert.equal(h.clock.pending.length, 0);
  assert.equal(h.pendingClears.length, 0, 'view disposal never clears the shared cookie');

  const remount = await acquire(h);
  const next = remount.lease.ensureFresh();
  assert.equal(h.pendingIssues.length, 2, 'the next mounted view performs its own POST');
  h.pendingIssues[1].resolve(ok());
  await next;
});

test('hidden paused views do not renew proactively, but hidden playing video does', async () => {
  const paused = await createContentsHarness({ clock: createContentsClock() });
  const a = await acquire(paused);
  const ready = a.lease.ensureFresh();
  paused.pendingIssues[0].resolve(ok());
  await ready;
  paused.visibility(true);
  await paused.advance(240_000);
  assert.equal(paused.pendingIssues.length, 1);

  const playing = await createContentsHarness({ clock: createContentsClock() });
  const b = await acquire(playing);
  const initial = b.lease.ensureFresh();
  playing.pendingIssues[0].resolve(ok());
  await initial;
  playing.visibility(true);
  b.lease.setPlaying(true);
  await playing.advance(240_000);
  assert.equal(playing.pendingIssues.length, 2);
});

test('visibility, focus and online recovery recheck an overdue visible lease', async () => {
  const h = await createContentsHarness({ clock: createContentsClock() });
  const { lease } = await acquire(h);
  const initial = lease.ensureFresh();
  h.pendingIssues[0].resolve(ok());
  await initial;
  h.visibility(true);
  await h.advance(240_000);
  assert.equal(h.pendingIssues.length, 1);
  h.visibility(false);
  assert.equal(h.pendingIssues.length, 2);
  h.pendingIssues[1].resolve(ok());
  await drain();
  await h.advance(240_000);
  assert.equal(h.pendingIssues.length, 3);
  h.pendingIssues[2].resolve(errorResponse(503));
  await drain();
  h.window.dispatchEvent(new TestEvent('focus'));
  assert.equal(h.pendingIssues.length, 4);
  h.pendingIssues[3].resolve(ok());
  await drain();
});

test('Retry-After seconds is a minimum, retry delays are bounded, and online starts a stopped sequence', async () => {
  const h = await createContentsHarness({ clock: createContentsClock() });
  const { lease } = await acquire(h);
  const initial = lease.ensureFresh();
  h.pendingIssues[0].resolve(errorResponse(429, { 'Retry-After': '10' }));
  await assert.rejects(initial);
  await h.advance(9_999);
  assert.equal(h.pendingIssues.length, 1);
  await h.advance(1);
  assert.equal(h.pendingIssues.length, 2);
  h.pendingIssues[1].resolve(errorResponse(503));
  await drain();
  await h.advance(15_000);
  assert.equal(h.pendingIssues.length, 3);
  h.pendingIssues[2].resolve(errorResponse(503));
  await drain();
  await h.advance(30_000);
  assert.equal(h.pendingIssues.length, 4);
  h.pendingIssues[3].resolve(errorResponse(503));
  await drain();
  await h.advance(60_000);
  assert.equal(h.pendingIssues.length, 4, 'automatic issue stops after 5/15/30 retries');
  h.window.dispatchEvent(new TestEvent('online'));
  assert.equal(h.pendingIssues.length, 5);
  h.pendingIssues[4].resolve(ok());
  await drain();
});

test('Retry-After HTTP dates are treated as a minimum before the bounded retry', async () => {
  const clock = createContentsClock();
  const h = await createContentsHarness({ clock });
  const { lease } = await acquire(h);
  const initial = lease.ensureFresh();
  const retryAt = new Date(clock.now() + 20_000).toUTCString();
  h.pendingIssues[0].resolve(errorResponse(429, { 'Retry-After': retryAt }));
  await assert.rejects(initial);
  await h.advance(19_999);
  assert.equal(h.pendingIssues.length, 1);
  await h.advance(1);
  assert.equal(h.pendingIssues.length, 2);
  h.pendingIssues[1].resolve(ok());
  await drain();
});

test('clear is synchronous locally, bodyless, joined, and keeps the barrier blocked after DELETE failure', async () => {
  const h = await createContentsHarness();
  const { lease, statuses } = await acquire(h);
  const issue = lease.ensureFresh();
  h.pendingIssues[0].resolve(ok());
  await issue;
  const one = h.modules.mediaSession.clearContentsMediaSession();
  const two = h.modules.mediaSession.clearContentsMediaSession();
  assert.equal(one, two);
  assert.equal(lease.isPrepared(), false);
  assert.ok(statuses.includes('expired'));
  assert.equal(h.pendingClears.length, 1);
  assert.equal(h.pendingClears[0].options.method, 'DELETE');
  assert.equal(Object.hasOwn(h.pendingClears[0].options, 'body'), false);
  assert.equal(h.pendingClears[0].options.credentials, 'same-origin');
  assert.equal(h.pendingClears[0].options.cache, 'no-store');
  h.pendingClears[0].resolve(errorResponse(503));
  await assert.rejects(one);
  const blocked = lease.ensureFresh({ force: true });
  await assert.rejects(blocked);
  assert.equal(h.pendingIssues.length, 1);
  const retryClear = h.modules.mediaSession.clearContentsMediaSession();
  h.pendingClears[1].resolve(ok());
  await retryClear;
});

test('late same-tab POST completion after DELETE requires a second DELETE before barrier release', async () => {
  const h = await createContentsHarness();
  const { lease } = await acquire(h);
  const issue = lease.ensureFresh();
  h.pendingIssues[0].ignoreAbort = true;
  const clear = h.modules.mediaSession.clearContentsMediaSession();
  assert.equal(h.pendingClears.length, 1);
  h.pendingClears[0].resolve(ok());
  await drain();
  let clearDone = false;
  clear.finally(() => { clearDone = true; });
  await drain();
  assert.equal(clearDone, false, 'clear waits for the old same-tab issue to settle');
  h.pendingIssues[0].resolve(ok());
  await assert.rejects(issue);
  await drain();
  assert.equal(h.pendingClears.length, 2);
  h.pendingClears[1].resolve(ok());
  await clear;
  assert.equal(clearDone, true);
  const nextLease = await acquire(h);
  const nextIssue = nextLease.lease.ensureFresh();
  assert.equal(h.pendingIssues.length, 2);
  h.pendingIssues[1].resolve(ok());
  await nextIssue;
});

test('aborted in-flight POST is followed by a second DELETE because abort cannot prove non-issuance', async () => {
  const h = await createContentsHarness();
  const { lease } = await acquire(h);
  const issue = lease.ensureFresh();
  const clear = h.modules.mediaSession.clearContentsMediaSession();
  assert.equal(h.pendingClears.length, 1);
  h.pendingClears[0].resolve(ok());
  await assert.rejects(issue, { name: 'AbortError' });
  await drain();
  assert.equal(h.pendingClears.length, 2);
  h.pendingClears[1].resolve(ok());
  await clear;
});

test('cross-tab invalidation carries no identity, does not echo, and requires validation plus a new issue', async () => {
  const bus = createContentsBroadcastBus();
  const first = await createContentsHarness({ broadcastBus: bus });
  const second = await createContentsHarness({ broadcastBus: bus });
  const a = await acquire(first);
  const ready = a.lease.ensureFresh();
  first.pendingIssues[0].resolve(ok());
  await ready;
  second.modules.mediaSession.invalidateContentsMediaSession({ broadcast: true });
  assert.equal(first.identity.validated, false);
  assert.equal(first.pendingIssues.length, 1);
  assert.equal(first.pendingClears.length, 0);

  first.notifyIdentity({ uid: 'user-a', generation: 3, validated: true });
  const next = await acquire(first);
  const pending = next.lease.ensureFresh();
  assert.equal(first.pendingIssues.length, 2);
  first.pendingIssues[1].resolve(ok());
  await pending;

  const oldEvent = bus.createChannel('ownerinc-contents-invalidation');
  const payload = { generation: 'opaque-previous-generation' };
  oldEvent.postMessage(payload);
  oldEvent.postMessage(payload);
  assert.equal(first.identity.validated, false, 'duplicate old events are deduplicated and never restore the old lease');
  assert.equal(first.pendingIssues.length, 2);
  oldEvent.close();
});

test('storage fallback tolerates unavailable storage when BroadcastChannel is available', async () => {
  const bus = createContentsBroadcastBus();
  const sender = await createContentsHarness({ broadcastBus: bus, storageAvailable: false });
  const receiver = await createContentsHarness({ broadcastBus: bus, storageAvailable: false });
  const lease = (await acquire(receiver)).lease;
  sender.modules.mediaSession.invalidateContentsMediaSession({ broadcast: true });
  assert.equal(receiver.identity.validated, false);
  assert.equal(lease.isPrepared(), false);
  assert.deepEqual(Object.keys(bus.messages[0]), ['generation']);
  assert.equal(JSON.stringify(bus.messages).includes('user-a'), false);
  assert.equal(bus.storageEvents.length, 0, 'BroadcastChannel does not create an availability or credential storage entry');
});

test('storage-event invalidation works when BroadcastChannel is unavailable', async () => {
  const bus = createContentsBroadcastBus();
  const sender = await createContentsHarness({ broadcastBus: bus, broadcastChannel: false });
  const receiver = await createContentsHarness({ broadcastBus: bus, broadcastChannel: false });
  sender.modules.mediaSession.invalidateContentsMediaSession({ broadcast: true });
  assert.equal(receiver.identity.validated, false);
});

test('asset URLs are lowercase, revision-bound and restricted to this DTO reference set', async () => {
  const h = await createContentsHarness();
  const dto = pageFixture({ id: PAGE_ID.toUpperCase(), revision: { id: REVISION_ID.toUpperCase(), status: 'published' },
    content_blocks: [{ type: 'image', asset_id: ASSET_ID.toUpperCase(), alt: 'Figura' }] });
  assert.equal(h.modules.mediaSession.assetURL(dto, ASSET_ID.toUpperCase()),
    `/api/contents/assets/${PAGE_ID}/${REVISION_ID}/${ASSET_ID}`);
  assert.throws(() => h.modules.mediaSession.assetURL(dto, '018f47a2-7b3c-7a11-8a2c-000000000001'));
  assert.throws(() => h.modules.mediaSession.assetURL({ ...dto, asset_scope: 'portal-pages-preview' }, ASSET_ID));
});

test('identity loss, disposal and navigation while issuing cannot publish a stale native URL', async () => {
  const h = await createContentsHarness();
  const root = h.document.createElement('section');
  h.document.body.append(root);
  const rendered = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'image', asset_id: ASSET_ID, alt: 'Alt visível', caption: 'Legenda preservada' },
  ] }), {}, contextFor(new AbortController().signal));
  let current = true;
  const controller = new AbortController();
  const activation = h.modules.media.activateContentsMedia(rendered.media, {
    context: { signal: controller.signal, isCurrent: () => current, onReload() {} },
  });
  const img = root.querySelector('img');
  assert.ok(img, 'semantic image and alt text exist before activation');
  assert.equal(img.hasAttribute('src'), false, 'no protected image URL exists before a current 204');
  current = false;
  h.pendingIssues[0].resolve(ok());
  await drain();
  assert.equal(img.hasAttribute('src'), false);
  activation.dispose();
});

test('image failure keeps accessible alt and caption and offers bounded recovery', async () => {
  const h = await createContentsHarness();
  const root = h.document.createElement('section'); h.document.body.append(root);
  const view = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'image', asset_id: ASSET_ID, alt: 'Alt descritivo', caption: 'Legenda legível' },
  ] }), {}, {});
  const activation = h.modules.media.activateContentsMedia(view.media, { context: contextFor(new AbortController().signal) });
  assert.equal(root.querySelector('img[src]'), null);
  h.pendingIssues[0].resolve(ok());
  await drain();
  const img = root.querySelector('img');
  assert.equal(img.getAttribute('alt'), 'Alt descritivo');
  assert.equal(img.getAttribute('src'), `/api/contents/assets/${PAGE_ID}/${REVISION_ID}/${ASSET_ID}`);
  img.dispatchEvent(new TestEvent('error'));
  await drain();
  assert.equal(root.querySelector('figcaption').textContent, 'Legenda legível');
  assert.equal(img.getAttribute('alt'), 'Alt descritivo', 'failure leaves the accessible name on the native image');
  assert.ok(root.querySelector('button.contents-media-retry'));
  assert.equal(h.pendingIssues.length, 1, 'one element failure does not trigger an automatic retry loop');
  root.querySelector('button.contents-media-retry').click();
  assert.equal(h.pendingIssues.length, 2, 'a user gets one forced recovery for this failure generation');
  h.pendingIssues[1].resolve(ok());
  await drain();
  activation.dispose();
});

test('native video preserves source during renewal, clamps recovery time, handles rejected play and disposes sound', async () => {
  const h = await createContentsHarness({ clock: createContentsClock() });
  const root = h.document.createElement('section'); h.document.body.append(root);
  const view = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'video', asset_id: ASSET_ID, title: 'Treinamento' },
  ] }), {}, {});
  const activation = h.modules.media.activateContentsMedia(view.media, { context: contextFor(new AbortController().signal) });
  h.pendingIssues[0].resolve(ok()); await drain();
  const video = root.querySelector('video');
  const source = video.getAttribute('src');
  assert.equal(video.controls, true);
  assert.equal(video.playsInline, true);
  assert.equal(video.preload, 'metadata');
  assert.equal(video.hasAttribute('autoplay'), false);
  await h.advance(240_000);
  assert.equal(h.pendingIssues.length, 2);
  assert.equal(video.getAttribute('src'), source, 'routine renewal never resets an open stream or currentTime');
  h.pendingIssues[1].resolve(ok()); await drain();
  assert.equal(video.getAttribute('src'), source);

  video.currentTime = 70;
  video.duration = 42;
  video.paused = false;
  video.dispatchEvent(new TestEvent('error'));
  await drain();
  assert.equal(video.paused, true);
  assert.equal(h.pendingIssues.length, 3);
  h.pendingIssues[2].resolve(ok()); await drain();
  video.dispatchEvent(new TestEvent('loadedmetadata'));
  await drain();
  assert.equal(video.currentTime, 42);
  video.playResult = Promise.reject(new Error('autoplay rejected'));
  video.playResult.catch(() => {});
  video.dispatchEvent(new TestEvent('error'));
  await drain();
  assert.equal(h.pendingIssues.length, 4);
  h.pendingIssues[3].resolve(ok()); await drain();
  video.dispatchEvent(new TestEvent('loadedmetadata'));
  await drain();
  assert.match(root.querySelector('.contents-media-status').textContent, /A reprodução não pôde ser iniciada/u);
  activation.dispose();
  assert.equal(video.paused, true);
  assert.equal(video.hasAttribute('src'), false);
  assert.ok(video.loadCount >= 1);
});

test('PDF hrefs remain absent until prepared and expired ordinary clicks renew without popup creation', async () => {
  const h = await createContentsHarness({ clock: createContentsClock() });
  h.window.open = () => { throw new Error('media must not create a popup'); };
  const root = h.document.createElement('section'); h.document.body.append(root);
  const view = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'pdf', asset_id: ASSET_ID, title: 'Manual do Portal' },
  ] }), {}, {});
  const activation = h.modules.media.activateContentsMedia(view.media, { context: contextFor(new AbortController().signal) });
  h.visibility(true);
  const open = root.querySelector('.contents-pdf-open');
  const download = root.querySelector('.contents-pdf-download');
  assert.equal(open.hasAttribute('href'), false);
  assert.equal(download.hasAttribute('href'), false);
  h.pendingIssues[0].resolve(ok()); await drain();
  assert.equal(open.getAttribute('target'), '_blank');
  assert.equal(open.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(download.hasAttribute('download'), true);
  assert.equal(open.getAttribute('href'), `/api/contents/assets/${PAGE_ID}/${REVISION_ID}/${ASSET_ID}`);
  await h.advance(300_000);
  assert.equal(open.hasAttribute('href'), false);
  const click = new TestEvent('click', { bubbles: true });
  open.dispatchEvent(click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(h.pendingIssues.length, 2);
  h.pendingIssues[1].resolve(ok()); await drain();
  assert.match(root.querySelector('.contents-pdf-status').textContent, /PDF pronto\. Clique novamente/u);
  assert.equal(open.getAttribute('href'), `/api/contents/assets/${PAGE_ID}/${REVISION_ID}/${ASSET_ID}`);
  assert.match(root.textContent, /A visualização em outra aba pode expirar após cinco minutos/u);
  activation.dispose();
});

test('embeds are lazy, canonical-provider-only, sandboxed and retain a provider fallback link', async () => {
  const h = await createContentsHarness();
  const root = h.document.createElement('section'); h.document.body.append(root);
  const dto = pageFixture({ content_blocks: [
    { type: 'embed', provider: 'vimeo', url: 'https://player.vimeo.com/video/123', title: 'Vídeo externo' },
  ] });
  const view = h.modules.reader.renderReader(root, dto, {}, {});
  h.modules.media.activateContentsMedia(view.media, { context: contextFor(new AbortController().signal) });
  const iframe = root.querySelector('iframe');
  assert.equal(iframe.getAttribute('src'), dto.content_blocks[0].url);
  assert.equal(iframe.loading, 'lazy');
  assert.equal(iframe.getAttribute('sandbox'), 'allow-scripts allow-same-origin allow-presentation');
  assert.equal(iframe.getAttribute('allow'), 'fullscreen; picture-in-picture; encrypted-media');
  assert.equal(iframe.getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin');
  assert.equal(iframe.allowFullscreen, true);
  assert.equal(root.querySelector('.contents-embed-fallback').getAttribute('href'), dto.content_blocks[0].url);
  assert.equal(h.pendingIssues.length, 0, 'approved embeds do not require the private media cookie');
});

test('known expiry pauses video, disables PDF, and renewal does not silently resume playback', async () => {
  const h = await createContentsHarness({ clock: createContentsClock() });
  const root = h.document.createElement('section'); h.document.body.append(root);
  const view = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'video', asset_id: ASSET_ID, title: 'Aula' },
    { type: 'pdf', asset_id: ASSET_ID, title: 'Anexo' },
  ] }), {}, {});
  const activation = h.modules.media.activateContentsMedia(view.media, { context: contextFor(new AbortController().signal) });
  h.pendingIssues[0].resolve(ok()); await drain();
  h.visibility(true);
  const video = root.querySelector('video');
  const pdf = root.querySelector('.contents-pdf-open');
  video.paused = false;
  await h.advance(300_000);
  assert.equal(video.paused, true);
  const source = video.getAttribute('src');
  assert.ok(source, 'expiry pauses native playback without discarding the recoverable source');
  assert.equal(pdf.hasAttribute('href'), false);
  const videoStatus = root.querySelectorAll('.contents-media-status')[0];
  const retry = videoStatus.querySelector('button');
  retry.click();
  assert.equal(h.pendingIssues.length, 2);
  h.pendingIssues[1].resolve(ok()); await drain();
  assert.equal(video.getAttribute('src'), source, 'explicit renewal keeps the same native stream URL');
  assert.equal(video.paused, true, 'expiry recovery does not automatically resume playback');
  assert.equal(videoStatus.isConnected, false, 'the video recovery message clears when renewal succeeds');
  activation.dispose();
});

test('media binding disposal removes native sources and never buffers a protected asset', async () => {
  const h = await createContentsHarness();
  const root = h.document.createElement('section'); h.document.body.append(root);
  const view = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'image', asset_id: ASSET_ID, alt: 'Imagem' },
    { type: 'video', asset_id: ASSET_ID, title: 'Vídeo' },
  ] }), {}, {});
  const activation = h.modules.media.activateContentsMedia(view.media, { context: contextFor(new AbortController().signal) });
  h.pendingIssues[0].resolve(ok()); await drain();
  assert.equal(h.requests.some(item => item.path.includes('/assets/')), false);
  assert.equal(root.querySelectorAll('img[src], video[src]').length, 2);
  activation.dispose();
  assert.equal(root.querySelectorAll('img[src], video[src]').length, 0);
  assert.equal(h.pendingClears.length, 0);
});

test('catalog media activation shares one lease for all covers and activates only the current list revision', async () => {
  const h = await createContentsHarness();
  const root = h.document.createElement('section'); h.document.body.append(root);
  const dto = pageFixture({ cover: { asset_id: ASSET_ID, alt: 'Capa' }, content_blocks: [] });
  const view = h.modules.catalog.renderCatalog(root, { data: [dto], total: 1 }, {});
  const binding = h.modules.media.activateContentsMedia(view.media, { context: contextFor(new AbortController().signal) });
  assert.equal(root.querySelector('img[src]'), null);
  assert.equal(h.pendingIssues.length, 1);
  h.pendingIssues[0].resolve(ok()); await drain();
  assert.equal(root.querySelector('img').loading, 'lazy');
  binding.dispose();
});

test('coordinator is independent of page mutation tracking and stale identities cannot renew', async () => {
  const h = await createContentsHarness({ clock: createContentsClock() });
  const statuses = [];
  const { lease } = await acquire(h, new AbortController().signal, statuses);
  const first = lease.ensureFresh();
  h.pendingIssues[0].resolve(ok()); await first;
  h.notifyIdentity({ uid: 'user-b', generation: 2, validated: false });
  assert.equal(lease.isPrepared(), false);
  await assert.rejects(lease.ensureFresh());
  assert.equal(h.page.busy, false);
  assert.equal(h.pendingIssues.length, 1);
  assert.ok(statuses.includes('expired'));
});

test('the fake-clock harness exposes chronological timer ordering for lease races', async () => {
  const clock = createContentsClock(100);
  const order = [];
  clock.setTimeout(() => order.push('late'), 20);
  clock.setTimeout(() => order.push('early'), 10);
  await clock.advance(20);
  assert.deepEqual(order, ['early', 'late']);
  assert.equal(clock.now(), 120);
});
