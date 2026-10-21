import assert from 'node:assert/strict';
import test from 'node:test';
import { createContentsHarness, createContentsClock, createContentsBroadcastBus } from '../helpers/portal-contents-harness.mjs';
import { ASSET_ID, PAGE_ID, REVISION_ID, clone, pageFixture } from '../helpers/portal-contents-fixtures.mjs';
import { TestEvent, deferred, drain } from '../helpers/frontend-feedback-harness.mjs';

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

test('late raw settlement retires timed-out processing and permits a force retry in either order', async () => {
  for (const settleRawFirst of [false, true]) {
    const h = await createContentsHarness({ clock: createContentsClock() });
    const { lease } = await acquire(h);
    const first = lease.ensureFresh();
    const firstRejected = assert.rejects(first);
    h.pendingIssues[0].ignoreAbort = true;

    if (settleRawFirst) h.pendingIssues[0].options.onRawTransportSettled({ status: 204 });
    await h.advance(15_000);
    await firstRejected;
    if (!settleRawFirst) h.pendingIssues[0].options.onRawTransportSettled({ status: 204 });

    const retry = lease.ensureFresh({ force: true });
    assert.equal(h.pendingIssues.length, 2, 'both completion orders release only the timed-out issue entry');
    h.pendingIssues[1].resolve(ok());
    await retry;
    assert.equal(lease.isPrepared(), true, 'the new exact-204 issue prepares the current lease');
    h.pendingIssues[0].resolve(ok());
    await drain();
    lease.release();
  }
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

test('two playing videos in one lease keep hidden proactive renewal active when only one pauses', async () => {
  const h = await createContentsHarness({ clock: createContentsClock() });
  const root = h.document.createElement('section'); h.document.body.append(root);
  const view = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'video', asset_id: ASSET_ID, title: 'Aula A' },
    { type: 'video', asset_id: ASSET_ID, title: 'Aula B' },
  ] }), {}, {});
  const activation = h.modules.media.activateContentsMedia(view.media, { context: contextFor(new AbortController().signal) });
  h.pendingIssues[0].resolve(ok()); await drain();
  const [videoA, videoB] = root.querySelectorAll('video');
  videoA.paused = false; videoA.dispatchEvent(new TestEvent('play'));
  videoB.paused = false; videoB.dispatchEvent(new TestEvent('play'));
  videoB.paused = true; videoB.dispatchEvent(new TestEvent('pause'));
  h.visibility(true);
  await h.advance(240_000);
  assert.equal(h.pendingIssues.length, 2, 'pausing B does not unregister A from the playing-resource set');
  h.pendingIssues[1].resolve(ok()); await drain();
  activation.dispose();
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

test('visibility recovery reissues a lease whose expiry was cleared while hidden, but not an old identity', async () => {
  const h = await createContentsHarness({ clock: createContentsClock() });
  const { lease } = await acquire(h);
  const initial = lease.ensureFresh();
  h.pendingIssues[0].resolve(ok()); await initial;
  h.visibility(true);
  await h.advance(300_000);
  assert.equal(lease.isPrepared(), false);
  assert.equal(h.pendingIssues.length, 1, 'a hidden paused lease does not renew on its timer');
  h.visibility(false);
  assert.equal(h.pendingIssues.length, 2, 'visible recovery reissues after hidden expiry cleared expiresAt');
  h.pendingIssues[1].resolve(ok()); await drain();
  h.visibility(true);
  await h.advance(300_000);
  h.notifyIdentity({ uid: 'user-b', generation: 2, validated: false });
  h.visibility(false);
  h.window.dispatchEvent(new TestEvent('focus'));
  assert.equal(h.pendingIssues.length, 2, 'old identity generations cannot issue on visibility or focus');
  lease.release();

  const disposed = await createContentsHarness({ clock: createContentsClock() });
  const disposedLease = (await acquire(disposed)).lease;
  const prepared = disposedLease.ensureFresh();
  disposed.pendingIssues[0].resolve(ok()); await prepared;
  disposedLease.release();
  disposed.visibility(true);
  await disposed.advance(300_000);
  disposed.visibility(false);
  disposed.window.dispatchEvent(new TestEvent('focus'));
  assert.equal(disposed.pendingIssues.length, 1, 'disposed views cannot reissue even after the hidden lease expires');
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

test('clear follows raw issue settlement without waiting for centralized auth handling to finish', async () => {
  const h = await createContentsHarness();
  const { lease } = await acquire(h);
  const issue = lease.ensureFresh();
  const issueAssertion = assert.rejects(issue, { name: 'AbortError' });
  h.pendingIssues[0].ignoreAbort = true;
  const clear = h.modules.mediaSession.clearContentsMediaSession();
  assert.equal(h.pendingClears.length, 1);
  h.pendingClears[0].resolve(ok());
  await drain();
  assert.equal(typeof h.pendingIssues[0].options.onRawTransportSettled, 'function',
    'the coordinator exposes a private settlement seam for authenticatedFetch');
  h.pendingIssues[0].options.onRawTransportSettled({ status: 204 });
  await drain();
  assert.equal(h.pendingClears.length, 2, 'the second DELETE can run while the authenticated request promise remains pending');
  h.pendingClears[1].resolve(ok());
  await clear;
  h.pendingIssues[0].resolve(ok());
  await issueAssertion;
});

test('old clear processing cannot retire a newer issue after its barrier completes', async () => {
  const h = await createContentsHarness();
  const { lease: oldLease } = await acquire(h);
  const oldIssue = oldLease.ensureFresh();
  const oldIssueAssertion = assert.rejects(oldIssue, { name: 'AbortError' });
  h.pendingIssues[0].ignoreAbort = true;

  const clear = h.modules.mediaSession.clearContentsMediaSession();
  h.pendingClears[0].resolve(ok());
  h.pendingIssues[0].options.onRawTransportSettled({ status: 204 });
  await drain();
  assert.equal(h.pendingClears.length, 2);
  h.pendingClears[1].resolve(ok());
  await clear;

  const { lease: nextLease } = await acquire(h);
  const nextIssue = nextLease.ensureFresh();
  assert.equal(h.pendingIssues.length, 2);
  h.pendingIssues[0].resolve(ok());
  await oldIssueAssertion;
  const joined = nextLease.ensureFresh();
  assert.equal(h.pendingIssues.length, 2, 'old finally does not clear the newer in-flight entry');
  h.pendingIssues[1].resolve(ok());
  await Promise.all([nextIssue, joined]);
  oldLease.release();
  nextLease.release();
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

test('a repeatedly failing native image offers one current-view content reload', async () => {
  const h = await createContentsHarness({ clock: createContentsClock() });
  let reloadCalls = 0;
  const viewContext = { ...contextFor(new AbortController().signal), onReload() { reloadCalls += 1; } };
  const root = h.document.createElement('section'); h.document.body.append(root);
  const view = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'image', asset_id: ASSET_ID, alt: 'Imagem persistente', caption: 'Legenda da imagem' },
  ] }), {}, viewContext);
  const activation = h.modules.media.activateContentsMedia(view.media, { context: viewContext });
  h.pendingIssues[0].resolve(ok()); await drain();
  const image = root.querySelector('.contents-native-image');
  image.dispatchEvent(new TestEvent('error'));
  root.querySelector('.contents-media-retry').click();
  h.pendingIssues[1].resolve(ok()); await drain();
  image.dispatchEvent(new TestEvent('error'));

  const reload = root.querySelector('.contents-media-reload');
  assert.ok(reload);
  assert.equal(reload.textContent, 'Recarregar conteúdo');
  assert.equal(image.hasAttribute('src'), false);
  await h.advance(240_000);
  assert.equal(h.pendingIssues.length, 3, 'the current lease performs its routine 240-second renewal');
  h.pendingIssues[2].resolve(ok()); await drain();
  assert.equal(image.hasAttribute('src'), false, 'routine ready never reassigns a terminal asset URL');
  assert.equal(root.querySelector('.contents-media-reload'), reload, 'routine ready preserves the terminal reload action');
  viewContext.isCurrent = () => false;
  reload.click();
  assert.equal(reloadCalls, 0, 'a stale media view cannot reload content');
  viewContext.isCurrent = () => true;
  reload.click(); reload.click();
  assert.equal(reloadCalls, 1, 'the current activation invokes onReload at most once');
  activation.dispose();
});

test('a terminal video failure stays terminal through routine ready and a fresh media activation resets it', async () => {
  const clock = createContentsClock();
  const h = await createContentsHarness({ clock });
  let viewContext = contextFor(new AbortController().signal);
  const root = h.document.createElement('section'); h.document.body.append(root);
  const dto = pageFixture({ content_blocks: [{ type: 'video', asset_id: ASSET_ID, title: 'Aula terminal' }] });
  let view = h.modules.reader.renderReader(root, dto, {}, viewContext);
  let activation = h.modules.media.activateContentsMedia(view.media, { context: viewContext });
  h.pendingIssues[0].resolve(ok()); await drain();
  const video = root.querySelector('video');
  video.paused = false;
  video.dispatchEvent(new TestEvent('play'));
  video.dispatchEvent(new TestEvent('error'));
  h.pendingIssues[1].resolve(ok()); await drain();
  video.dispatchEvent(new TestEvent('error'));
  const reload = root.querySelector('.contents-media-reload');
  assert.ok(reload);
  assert.equal(video.hasAttribute('src'), false);

  await h.advance(240_000);
  assert.equal(h.pendingIssues.length, 3);
  h.pendingIssues[2].resolve(ok()); await drain();
  assert.equal(video.hasAttribute('src'), false, 'routine ready cannot revive a terminal video');
  assert.equal(root.querySelector('.contents-media-reload'), reload);

  activation.dispose();
  viewContext = contextFor(new AbortController().signal);
  view = h.modules.reader.renderReader(root, dto, {}, viewContext);
  activation = h.modules.media.activateContentsMedia(view.media, { context: viewContext });
  assert.equal(h.pendingIssues.length, 4);
  const remounted = root.querySelector('video');
  assert.equal(remounted.hasAttribute('src'), false, 'the new view starts pending until its own 204');
  h.pendingIssues[3].resolve(ok()); await drain();
  assert.equal(remounted.hasAttribute('src'), true, 'a fresh view resets terminal resource state');
  activation.dispose();
});

test('play intent during initial video preparation does not suppress pending source activation', async () => {
  const h = await createContentsHarness();
  const root = h.document.createElement('section'); h.document.body.append(root);
  const viewContext = contextFor(new AbortController().signal);
  const view = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'video', asset_id: ASSET_ID, title: 'Aula inicial' },
  ] }), {}, viewContext);
  const activation = h.modules.media.activateContentsMedia(view.media, { context: viewContext });
  const video = root.querySelector('video');

  video.paused = false;
  video.dispatchEvent(new TestEvent('play'));
  assert.equal(video.hasAttribute('src'), false, 'protected video stays pending before a 204');
  h.pendingIssues[0].resolve(ok()); await drain();
  assert.equal(video.hasAttribute('src'), true, 'the initial ready activates the source despite the pending play intent');
  assert.equal(video.paused, false, 'the current play intent resumes after source activation');
  activation.dispose();
});

test('repeated PDF lease-preparation failure is terminal and survives routine renewal', async () => {
  const clock = createContentsClock();
  const h = await createContentsHarness({ clock });
  let reloadCalls = 0;
  const viewContext = { ...contextFor(new AbortController().signal), onReload() { reloadCalls += 1; } };
  const root = h.document.createElement('section'); h.document.body.append(root);
  const view = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'pdf', asset_id: ASSET_ID, title: 'Material terminal' },
  ] }), {}, viewContext);
  const activation = h.modules.media.activateContentsMedia(view.media, { context: viewContext });
  h.pendingIssues[0].resolve(errorResponse(503)); await drain();
  const firstRetry = root.querySelector('.contents-media-retry');
  assert.ok(firstRetry, 'initial transient preparation remains retryable');
  firstRetry.click();
  assert.equal(h.pendingIssues.length, 2);
  h.pendingIssues[1].resolve(errorResponse(503)); await drain();

  const reload = root.querySelector('.contents-media-reload');
  assert.ok(reload, 'a repeated PDF preparation failure reaches terminal state');
  assert.equal(root.querySelector('.contents-pdf-open').hasAttribute('href'), false);
  const unrelatedReady = activation.lease.ensureFresh({ force: true });
  assert.equal(h.pendingIssues.length, 3);
  h.pendingIssues[2].resolve(ok()); await unrelatedReady;
  await h.advance(240_000);
  assert.equal(h.pendingIssues.length, 4, 'the valid lease still performs its routine renewal');
  h.pendingIssues[3].resolve(ok()); await drain();
  assert.equal(root.querySelector('.contents-pdf-open').hasAttribute('href'), false,
    'ready cannot expose a terminally failed PDF');
  assert.equal(root.querySelector('.contents-media-reload'), reload, 'renewal preserves the validated reload action');
  reload.click();
  reload.click();
  assert.equal(reloadCalls, 1);
  activation.dispose();

  const nextContext = contextFor(new AbortController().signal);
  const nextView = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'pdf', asset_id: ASSET_ID, title: 'Material terminal' },
  ] }), {}, nextContext);
  const remount = h.modules.media.activateContentsMedia(nextView.media, { context: nextContext });
  assert.equal(h.pendingIssues.length, 5);
  const newPDF = root.querySelector('.contents-pdf-open');
  assert.equal(newPDF.hasAttribute('href'), false);
  h.pendingIssues[4].resolve(ok()); await drain();
  assert.equal(newPDF.hasAttribute('href'), true, 'a new view generation resets the PDF terminal state');
  remount.dispose();
});

test('repeated automatic PDF preparation failures become terminal but first 503 remains pending', async () => {
  const h = await createContentsHarness({ clock: createContentsClock() });
  const root = h.document.createElement('section'); h.document.body.append(root);
  const viewContext = contextFor(new AbortController().signal);
  const view = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'pdf', asset_id: ASSET_ID, title: 'Material com falha repetida' },
  ] }), {}, viewContext);
  const activation = h.modules.media.activateContentsMedia(view.media, { context: viewContext });

  h.pendingIssues[0].resolve(errorResponse(503)); await drain();
  assert.equal(root.querySelector('.contents-media-reload'), null,
    'one transient lease failure stays pending/recoverable');
  assert.ok(root.querySelector('.contents-media-retry'));

  await h.advance(5_000);
  assert.equal(h.pendingIssues.length, 2, 'the coordinator performs its first bounded automatic retry');
  h.pendingIssues[1].resolve(errorResponse(503)); await drain();
  assert.ok(root.querySelector('.contents-media-reload'),
    'a distinct repeated automatic lease failure transitions the PDF to terminal state');
  activation.dispose();
});

test('automatic recovery activates pending image, gallery, video and PDF once, without resetting an active video', async () => {
  const h = await createContentsHarness({ clock: createContentsClock() });
  const root = h.document.createElement('section'); h.document.body.append(root);
  const view = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'image', asset_id: ASSET_ID, alt: 'Capa de aula' },
    { type: 'gallery', images: [
      { asset_id: ASSET_ID, alt: 'Miniatura' },
      { asset_id: '018f47a2-7b3c-7a11-8a2c-000000000001', alt: 'Segunda miniatura' },
    ] },
    { type: 'video', asset_id: ASSET_ID, title: 'Aula' },
    { type: 'pdf', asset_id: ASSET_ID, title: 'Material' },
  ] }), {}, contextFor(new AbortController().signal));
  const gallery = h.modules.gallery.createContentsGallery({ page: h.page, rootHeading: () => view.heading });
  const activation = h.modules.media.activateContentsMedia(view.media,
    { context: contextFor(new AbortController().signal), gallery });
  h.pendingIssues[0].resolve(errorResponse(503)); await drain();
  await h.advance(5_000);
  assert.equal(h.pendingIssues.length, 2, 'the coordinator performs its bounded automatic retry');
  h.pendingIssues[1].resolve(ok()); await drain();

  const image = root.querySelector('.contents-native-image');
  const thumbnail = root.querySelector('.contents-gallery-thumbnail');
  const video = root.querySelector('video');
  const pdf = root.querySelector('.contents-pdf-open');
  assert.equal(image.hasAttribute('src'), true);
  assert.equal(thumbnail.hasAttribute('src'), true);
  assert.equal(video.hasAttribute('src'), true);
  assert.equal(pdf.hasAttribute('href'), true);
  assert.equal(root.querySelectorAll('.contents-gallery-thumbnail').length, 2, 'ready notifications do not duplicate gallery markup');

  video.currentTime = 37;
  const source = video.getAttribute('src');
  const renewal = activation.lease.ensureFresh({ force: true });
  assert.equal(h.pendingIssues.length, 3);
  h.pendingIssues[2].resolve(ok()); await renewal;
  assert.equal(video.getAttribute('src'), source, 'a repeated ready notification does not replace an active video source');
  assert.equal(video.currentTime, 37, 'a repeated ready notification does not reset playback position');
  activation.dispose(); gallery.dispose();
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

test('user pause clears recovery intent and stale loadedmetadata cannot restore until fresh-source generation', async () => {
  const h = await createContentsHarness({ clock: createContentsClock() });
  const root = h.document.createElement('section'); h.document.body.append(root);
  const view = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'video', asset_id: ASSET_ID, title: 'Aula com pausa manual' },
  ] }), {}, {});
  const activation = h.modules.media.activateContentsMedia(view.media, { context: contextFor(new AbortController().signal) });
  h.pendingIssues[0].resolve(ok()); await drain();
  const video = root.querySelector('video');

  video.paused = false;
  video.dispatchEvent(new TestEvent('play'));
  video.paused = true;
  video.dispatchEvent(new TestEvent('pause'));
  video.currentTime = 18;
  video.dispatchEvent(new TestEvent('error'));
  await drain();
  assert.equal(h.pendingIssues.length, 2);
  video.dispatchEvent(new TestEvent('loadedmetadata'));
  assert.equal(video.paused, true, 'a stale metadata event cannot resume before the replacement source is ready');

  h.pendingIssues[1].resolve(ok()); await drain();
  video.dispatchEvent(new TestEvent('loadedmetadata'));
  await drain();
  assert.equal(video.currentTime, 18);
  assert.equal(video.paused, true, 'a user pause remains authoritative after recovery');
  activation.dispose();
});

test('a recovery pause preserves current play intent until matching metadata, then resumes once', async () => {
  const h = await createContentsHarness({ clock: createContentsClock() });
  const root = h.document.createElement('section'); h.document.body.append(root);
  const view = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'video', asset_id: ASSET_ID, title: 'Aula em recuperação' },
  ] }), {}, {});
  const activation = h.modules.media.activateContentsMedia(view.media, { context: contextFor(new AbortController().signal) });
  h.pendingIssues[0].resolve(ok()); await drain();
  const video = root.querySelector('video');
  video.paused = false;
  video.currentTime = 12;
  video.dispatchEvent(new TestEvent('play'));
  video.dispatchEvent(new TestEvent('error'));
  video.dispatchEvent(new TestEvent('pause'));
  assert.equal(video.paused, true);
  h.pendingIssues[1].resolve(ok()); await drain();
  video.dispatchEvent(new TestEvent('loadedmetadata'));
  await drain();
  assert.equal(video.currentTime, 12);
  assert.equal(video.paused, false, 'the recovery pause did not erase the active play intent');
  activation.dispose();
});

test('a stale play promise cannot pause a newer user playback generation', async () => {
  const h = await createContentsHarness({ clock: createContentsClock() });
  const root = h.document.createElement('section'); h.document.body.append(root);
  const view = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'video', asset_id: ASSET_ID, title: 'Aula com duas intenções' },
  ] }), {}, {});
  const activation = h.modules.media.activateContentsMedia(view.media,
    { context: contextFor(new AbortController().signal) });
  h.pendingIssues[0].resolve(ok()); await drain();
  const video = root.querySelector('video');
  video.paused = false;
  video.currentTime = 9;
  video.dispatchEvent(new TestEvent('play'));
  video.dispatchEvent(new TestEvent('error'));
  h.pendingIssues[1].resolve(ok()); await drain();

  const pendingPlay = deferred();
  video.playResult = pendingPlay.promise;
  video.dispatchEvent(new TestEvent('loadedmetadata'));
  video.paused = true;
  video.dispatchEvent(new TestEvent('pause'));
  video.playResult = null;
  video.paused = false;
  video.dispatchEvent(new TestEvent('play'));
  pendingPlay.resolve();
  await drain();

  assert.equal(video.paused, false, 'the old play completion cannot pause the newer user playback');
  activation.dispose();
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

test('embed-only disposal clears and removes its iframe and provider fallback', async () => {
  const h = await createContentsHarness();
  const root = h.document.createElement('section'); h.document.body.append(root);
  const view = h.modules.reader.renderReader(root, pageFixture({ content_blocks: [
    { type: 'embed', provider: 'youtube', url: 'https://www.youtube.com/embed/abcdefghijk', title: 'Apresentação' },
  ] }), {}, {});
  const activation = h.modules.media.activateContentsMedia(view.media, { context: contextFor(new AbortController().signal) });
  const iframe = root.querySelector('iframe');
  const frame = root.querySelector('.contents-embed');
  assert.ok(iframe);
  assert.ok(frame);
  activation.dispose();
  assert.equal(iframe.hasAttribute('src'), false);
  assert.equal(iframe.isConnected, false);
  assert.equal(frame.isConnected, false);
  assert.equal(root.querySelector('.contents-embed-fallback'), null);
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
