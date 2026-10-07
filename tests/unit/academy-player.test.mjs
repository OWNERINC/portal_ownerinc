import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { createLessonPlayer } from '../../public/academy/player.js';
import { loadYouTubeAPI } from '../../public/academy/youtube-player.js';

class Target {
  listeners = new Map();
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(fn); }
  removeEventListener(name, fn) { this.listeners.get(name)?.delete(fn); }
  fire(name) { for (const fn of [...(this.listeners.get(name) || [])]) fn({ target: this }); }
  count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
class Element extends Target {
  constructor(tag, doc) { super(); this.tagName = tag; this.ownerDocument = doc; this.children = []; this.attributes = new Map(); this.paused = true; this.currentTime = 0; this.duration = 600; this.ended = false; }
  setAttribute(key, value) { this.attributes.set(key, value); }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); if (key === 'src') this.src = ''; }
  append(child) { child.parent = this; this.children.push(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
  pause() { const was = this.paused; this.paused = true; if (!was) this.fire('pause'); }
  load() { this.loaded = true; }
}
function fixture() {
  let now = 0, next = 0;
  const timers = new Map();
  const schedule = (fn, ms, interval) => { const id = ++next; timers.set(id, { fn, at: now + ms, interval }); return id; };
  const doc = new Target();
  doc.hidden = false;
  doc.createElement = tag => new Element(tag, doc);
  doc.head = doc.createElement('head');
  doc.getElementById = id => doc.head.children.find(element => element.id === id) || null;
  doc.defaultView = {
    location: { origin: 'https://portal.example:8443' },
    setTimeout: (fn, ms) => schedule(fn, ms, 0), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: id => timers.delete(id),
  };
  const instances = [];
  function install() {
    doc.defaultView.YT = { Player: class {
      constructor(iframe, options) { this.iframe = iframe; this.options = options; this.time = 0; this.destroyed = 0; this.seeks = []; instances.push(this); }
      getCurrentTime() { return this.time; }
      getDuration() { return 600; }
      getIframe() { return this.iframe; }
      seekTo(seconds, allow) { this.seeks.push([seconds, allow]); this.time = seconds; }
      pauseVideo() { this.state(2); }
      destroy() { this.destroyed++; this.iframe.remove(); }
      ready() { this.time = Number(new URL(this.iframe.src).searchParams.get('start')); this.options.events.onReady({ target: this }); }
      state(data) { this.options.events.onStateChange({ target: this, data }); }
      error(data) { this.options.events.onError({ target: this, data }); }
    } };
    doc.defaultView.onYouTubeIframeAPIReady?.();
  }
  function tick(ms) {
    const end = now + ms;
    for (;;) {
      const entry = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      const [id, timer] = entry; now = timer.at;
      if (timer.interval) timer.at += timer.interval; else timers.delete(id);
      timer.fn();
    }
    now = end;
  }
  const host = () => { const element = doc.createElement('div'); element.setAttribute('aria-label', 'Introdução à Ownerinc'); return element; };
  return { doc, host, install, instances, tick, timers };
}
const youtube = { type: 'youtube', video_id: 'abcdefghijk' };
const file = { type: 'file', url: 'https://media.example/aula.webm?token=test' };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

// Model the official iframe_api bootstrap's consequential behavior: it sets
// loading before requesting a second script, whose failure does not clear it.
function bootstrapFixture(f) {
  const win = f.doc.defaultView;
  const requests = { bootstrap: 0, widget: 0 };
  function execute() {
    const script = f.doc.head.children.at(-1);
    if (script.src === 'https://www.youtube.com/iframe_api') {
      requests.bootstrap++;
      if (!win.YT) win.YT = { loading: 0, loaded: 0 };
      if (!win.YT.loading) {
        win.YT.loading = 1;
        const queue = [];
        win.YT.ready = callback => { if (win.YT.loaded) callback(); else queue.push(callback); };
        win.onYTReady = () => { win.YT.loaded = 1; queue.forEach(callback => callback()); };
        const widget = f.doc.createElement('script');
        widget.id = 'www-widgetapi-script';
        widget.src = 'https://www.youtube.com/s/player/test/www-widgetapi.vflset/www-widgetapi.js';
        widget.async = true;
        f.doc.head.append(widget);
        requests.widget++;
      }
    } else {
      assert.equal(script.id, 'www-widgetapi-script');
      requests.widget++;
    }
    script.fire('load');
    return f.doc.getElementById('www-widgetapi-script');
  }
  function complete() {
    win.YT.Player = class {};
    win.YT.loaded = 1;
    win.onYTReady?.();
    win.onYouTubeIframeAPIReady?.();
  }
  return { execute, complete, requests };
}

test('official bootstrap retries a failed secondary widget without replacing its namespace', async () => {
  const f = fixture(), bootstrap = bootstrapFixture(f), win = f.doc.defaultView;
  let callbacks = 0;
  const previous = () => callbacks++;
  win.onYouTubeIframeAPIReady = previous;
  const first = loadYouTubeAPI(f.doc), failed = assert.rejects(first, /demorou/);
  const staleCallback = win.onYouTubeIframeAPIReady;
  const failedWidget = bootstrap.execute(), namespace = win.YT;
  const readyQueue = namespace.ready;
  let queuedCalls = 0;
  namespace.ready(() => queuedCalls++);
  failedWidget.fire('error');
  assert.equal(namespace.loading, 1);
  f.tick(15000); await failed;
  const retry = loadYouTubeAPI(f.doc);
  const retryWidget = bootstrap.execute();
  assert.deepEqual(bootstrap.requests, { bootstrap: 1, widget: 2 });
  assert.notEqual(retryWidget, failedWidget);
  assert.equal(failedWidget.parent, null);
  assert.equal(win.YT, namespace); assert.equal(namespace.ready, readyQueue);
  const currentCallback = win.onYouTubeIframeAPIReady;
  staleCallback(); assert.equal(win.onYouTubeIframeAPIReady, currentCallback);
  bootstrap.complete(); assert.equal(await retry, namespace);
  assert.equal(queuedCalls, 1);
  assert.equal(callbacks, 1); assert.equal(win.onYouTubeIframeAPIReady, previous);
  assert.equal(f.timers.size, 0);
});

test('secondary recovery remains bounded across repeated failures and consumer abort does not reset shared state', async () => {
  const f = fixture(), bootstrap = bootstrapFixture(f), controller = new AbortController();
  const consumer = createLessonPlayer({ host: f.host(), media: youtube, signal: controller.signal });
  const aborted = assert.rejects(consumer, { name: 'AbortError' });
  const shared = loadYouTubeAPI(f.doc), failed = assert.rejects(shared, /demorou/);
  const widget = bootstrap.execute();
  controller.abort(); await aborted;
  assert.equal(f.doc.defaultView.YT.loading, 1); assert.ok(widget.parent);
  f.tick(15000); await failed;
  assert.equal(f.timers.size, 0); assert.equal(bootstrap.requests.widget, 1);
  const second = loadYouTubeAPI(f.doc), failedAgain = assert.rejects(second, /demorou/);
  bootstrap.execute(); f.tick(15000); await failedAgain;
  f.tick(60000); assert.deepEqual(bootstrap.requests, { bootstrap: 1, widget: 2 });
  assert.equal(f.timers.size, 0);
  const third = loadYouTubeAPI(f.doc); bootstrap.execute(); bootstrap.complete(); await third;
  assert.deepEqual(bootstrap.requests, { bootstrap: 1, widget: 3 });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const state of ['pre-existing partial', 'replacement partial', 'ready before timeout']) test(`secondary recovery preserves ${state} provider`, async () => {
  const f = fixture(), bootstrap = bootstrapFixture(f), win = f.doc.defaultView;
  if (state === 'pre-existing partial') win.YT = { loading: 1, loaded: 0, ready() {} };
  const pending = loadYouTubeAPI(f.doc), failed = assert.rejects(pending, /demorou/);
  const widget = bootstrap.execute();
  if (state === 'replacement partial') win.YT = { loading: 1, loaded: 0, ready() {} };
  if (state === 'ready before timeout') { win.YT.Player = class {}; win.YT.loaded = 1; }
  const namespace = win.YT, snapshot = { ...namespace };
  f.tick(15000); await failed;
  assert.equal(win.YT, namespace); assert.deepEqual(win.YT, snapshot);
  if (widget) assert.ok(widget.parent);
  if (state === 'ready before timeout') {
    assert.equal(await loadYouTubeAPI(f.doc), namespace);
    assert.deepEqual(bootstrap.requests, { bootstrap: 1, widget: 1 });
  }
  assert.equal(f.timers.size, 0);
});

test('late widget completion after timeout is reused without another bootstrap or state reset', async () => {
  const f = fixture(), bootstrap = bootstrapFixture(f);
  const pending = loadYouTubeAPI(f.doc), failed = assert.rejects(pending, /demorou/);
  bootstrap.execute(); f.tick(15000); await failed;
  bootstrap.complete();
  const namespace = f.doc.defaultView.YT;
  assert.equal(await loadYouTubeAPI(f.doc), namespace);
  assert.deepEqual(bootstrap.requests, { bootstrap: 1, widget: 1 });
  assert.equal(f.timers.size, 0);
});

test('secondary recovery does not remove a pre-existing widget element', async () => {
  const f = fixture(), bootstrap = bootstrapFixture(f);
  const external = f.doc.createElement('script');
  external.id = 'www-widgetapi-script'; external.src = 'https://www.youtube.com/s/player/external/www-widgetapi.js';
  f.doc.head.append(external);
  const pending = loadYouTubeAPI(f.doc), failed = assert.rejects(pending, /demorou/);
  bootstrap.execute(); f.tick(15000); await failed;
  assert.ok(external.parent); assert.equal(f.doc.defaultView.YT.loading, 1);
  assert.equal(f.timers.size, 0);
});

test('secondary retry script error cleans up and a later explicit retry still succeeds', async () => {
  const f = fixture(), bootstrap = bootstrapFixture(f);
  const first = loadYouTubeAPI(f.doc), timedOut = assert.rejects(first, /demorou/);
  const widget = bootstrap.execute(); f.tick(15000); await timedOut;
  const second = loadYouTubeAPI(f.doc), failed = assert.rejects(second, /carregar/);
  const retryScript = bootstrap.execute();
  assert.equal(retryScript.src, widget.src);
  retryScript.fire('error'); await failed;
  assert.equal(retryScript.count(), 0); assert.equal(retryScript.parent, null); assert.equal(f.timers.size, 0);
  const third = loadYouTubeAPI(f.doc); bootstrap.execute(); bootstrap.complete(); await third;
  assert.deepEqual(bootstrap.requests, { bootstrap: 1, widget: 3 });
});

test('external namespace replacing a failed bootstrap is not used for widget recovery', async () => {
  const f = fixture(), bootstrap = bootstrapFixture(f);
  const first = loadYouTubeAPI(f.doc), timedOut = assert.rejects(first, /demorou/);
  bootstrap.execute(); f.tick(15000); await timedOut;
  const external = { loading: 1, loaded: 0, ready() {} };
  f.doc.defaultView.YT = external;
  const retry = loadYouTubeAPI(f.doc), failed = assert.rejects(retry, /demorou/);
  assert.equal(f.doc.head.children.at(-1).src, 'https://www.youtube.com/iframe_api');
  bootstrap.execute(); f.tick(15000); await failed;
  assert.equal(f.doc.defaultView.YT, external); assert.equal(external.loading, 1);
  assert.deepEqual(bootstrap.requests, { bootstrap: 2, widget: 1 });
});

test('shared loader, existing callback preserved and two sequential lessons use one script', async () => {
  const f = fixture(); let called = 0;
  const previous = () => called++;
  f.doc.defaultView.onYouTubeIframeAPIReady = previous;
  const a = loadYouTubeAPI(f.doc), b = loadYouTubeAPI(f.doc);
  assert.equal(a, b); assert.equal(f.doc.head.children.length, 1);
  assert.equal(f.doc.head.children[0].src, 'https://www.youtube.com/iframe_api');
  f.install(); await a;
  assert.equal(called, 1); assert.equal(f.doc.defaultView.onYouTubeIframeAPIReady, previous);
  for (const startSeconds of [137, 42]) {
    const host = f.host(); const result = createLessonPlayer({ host, media: youtube, startSeconds });
    await flush(); const player = f.instances.at(-1); player.ready(); const handle = await result;
    assert.deepEqual(Object.keys(handle).sort(), ['destroy', 'getPosition', 'pause', 'seek']);
    assert.equal(handle.getPosition(), startSeconds);
    const url = new URL(player.iframe.src);
    assert.equal(url.origin, 'https://www.youtube-nocookie.com');
    assert.equal(url.searchParams.get('origin'), 'https://portal.example:8443');
    assert.equal(url.searchParams.get('autoplay'), '0');
    assert.equal(player.options.playerVars.start, startSeconds);
    assert.equal(player.iframe.getAttribute('title'), 'Introdução à Ownerinc');
    assert.equal(player.iframe.getAttribute('referrerpolicy'), 'strict-origin-when-cross-origin');
    assert.equal(player.iframe.getAttribute('allow'), 'fullscreen');
    assert.equal(player.iframe.getAttribute('allowfullscreen'), '');
    handle.destroy(); handle.destroy(); assert.equal(player.destroyed, 1); assert.equal(host.children.length, 0);
  }
  assert.equal(f.doc.head.children.length, 1); assert.equal(f.timers.size, 0); assert.equal(f.doc.count(), 0);
});

test('concurrent consumers: abort rejects promptly without cancelling the other loader consumer', async () => {
  const f = fixture(), controller = new AbortController();
  const first = createLessonPlayer({ host: f.host(), media: youtube, signal: controller.signal });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = createLessonPlayer({ host: f.host(), media: youtube });
  controller.abort(); await rejected;
  assert.equal(f.instances.length, 0); assert.equal(f.doc.head.children.length, 1);
  f.install(); await flush(); assert.equal(f.instances.length, 1);
  f.instances[0].ready(); (await second).destroy(); assert.equal(f.timers.size, 0);
});

test('abort all consumers before API arrival leaves no orphan player', async () => {
  const f = fixture(), controller = new AbortController();
  const pending = createLessonPlayer({ host: f.host(), media: youtube, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' }); controller.abort(); await rejected;
  f.install(); await flush(); assert.equal(f.instances.length, 0); assert.equal(f.timers.size, 0);
});

for (const kind of ['timeout', 'script error']) test(`loader ${kind} clears cache, restores callback and permits bounded retry`, async () => {
  const f = fixture(); let previousCalls = 0;
  const previous = () => previousCalls++;
  f.doc.defaultView.onYouTubeIframeAPIReady = previous;
  const first = loadYouTubeAPI(f.doc), late = f.doc.defaultView.onYouTubeIframeAPIReady;
  const failed = assert.rejects(first, /Tente novamente/);
  if (kind === 'timeout') f.tick(15000); else f.doc.head.children[0].fire('error');
  await failed; assert.equal(f.doc.head.children.length, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.doc.defaultView.onYouTubeIframeAPIReady, previous);
  const second = loadYouTubeAPI(f.doc), current = f.doc.defaultView.onYouTubeIframeAPIReady;
  late(); assert.equal(f.doc.defaultView.onYouTubeIframeAPIReady, current);
  f.install(); await second; assert.equal(previousCalls, 1);
});

test('abort during player readiness and late ready are cleaned up', async () => {
  const f = fixture(); f.install(); const controller = new AbortController(); const host = f.host();
  const pending = createLessonPlayer({ host, media: youtube, signal: controller.signal });
  const failed = assert.rejects(pending, { name: 'AbortError' });
  await flush(); const player = f.instances[0]; controller.abort(); await failed;
  player.ready(); player.state(1); player.error(150);
  assert.equal(player.destroyed, 1); assert.equal(host.children.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.doc.count(), 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('YouTube position polling stops on pause, buffering, visibility and destroy; end only notifies', async () => {
  const f = fixture(); f.install(); const positions = [], pauses = []; let ended = 0;
  const pending = createLessonPlayer({ host: f.host(), media: youtube, onPosition: p => positions.push(p), onPause: () => pauses.push(positions.at(-1)), onEnded: () => ended++ });
  await flush(); const player = f.instances[0]; player.ready(); const handle = await pending;
  player.time = 18; player.state(1); f.tick(1000); assert.deepEqual(positions, [18]);
  f.doc.hidden = true; f.doc.fire('visibilitychange'); f.tick(5000); assert.equal(positions.length, 1);
  f.doc.hidden = false; f.doc.fire('visibilitychange'); f.tick(1000); assert.equal(positions.length, 2);
  player.state(3); f.tick(1000); assert.equal(positions.length, 2);
  handle.seek(79); assert.deepEqual(player.seeks, [[79, true]]);
  player.state(1); handle.pause(); const count = positions.length; f.tick(3000); assert.equal(positions.length, count);
  assert.deepEqual(pauses, [79], 'pause callback follows its position event');
  player.state(0); assert.equal(ended, 1); handle.destroy(); player.state(0); assert.equal(ended, 1);
  assert.equal(f.timers.size, 0); assert.equal(f.doc.count(), 0);
});

for (const code of [101, 150, 2]) test(`YouTube error ${code} before and after ready reports once and never ends`, async () => {
  for (const ready of [false, true]) {
    const f = fixture(); f.install(); const errors = []; let ended = 0;
    const pending = createLessonPlayer({ host: f.host(), media: youtube, onError: e => errors.push(e), onEnded: () => ended++ });
    const rejected = ready ? null : assert.rejects(pending, error => error.code === code);
    await flush(); const player = f.instances[0]; if (ready) { player.ready(); await pending; }
    player.error(code); if (rejected) await rejected; player.error(code); player.state(0);
    assert.equal(errors.length, 1); assert.equal(errors[0].code, code); assert.equal(ended, 0);
    assert.equal(f.timers.size, 0); assert.equal(f.doc.count(), 0); assert.equal(player.destroyed, 1);
  }
});

test('YouTube readiness timeout destroys player and allows another lesson', async () => {
  const f = fixture(); f.install(); const errors = [];
  const pending = createLessonPlayer({ host: f.host(), media: youtube, onError: e => errors.push(e) });
  const failed = assert.rejects(pending, /demorou/); await flush(); f.tick(15000); await failed;
  f.instances[0].ready(); assert.equal(errors.length, 1); assert.equal(f.timers.size, 0);
  const retry = createLessonPlayer({ host: f.host(), media: youtube }); await flush(); f.instances[1].ready(); (await retry).destroy();
});

test('HTML5 metadata restores actual saved position without play, exposes same handle and cleans resources', async () => {
  const f = fixture(), host = f.host(), positions = [], pauses = []; let ended = 0;
  const pending = createLessonPlayer({ host, media: file, startSeconds: 123, onPosition: p => positions.push(p), onPause: () => pauses.push(positions.at(-1)), onEnded: () => ended++ });
  const video = host.children[0]; assert.equal(video.autoplay, false); assert.equal(video.controls, true); assert.equal(video.preload, 'metadata');
  video.fire('loadedmetadata'); const handle = await pending;
  assert.equal(video.currentTime, 123); assert.equal(video.paused, true);
  assert.deepEqual(Object.keys(handle).sort(), ['destroy', 'getPosition', 'pause', 'seek']);
  video.paused = false; video.fire('playing'); f.tick(1000); assert.deepEqual(positions, [123]);
  f.doc.hidden = true; f.doc.fire('visibilitychange'); f.tick(2000); assert.equal(positions.length, 1);
  f.doc.hidden = false; f.doc.fire('visibilitychange'); f.tick(1000); assert.equal(positions.length, 2);
  video.fire('waiting'); f.doc.fire('visibilitychange'); f.tick(2000); assert.equal(positions.length, 2);
  video.fire('playing');
  handle.seek(156); video.fire('seeked'); assert.equal(handle.getPosition(), 156);
  handle.pause(); const count = positions.length; f.tick(1000); assert.equal(positions.length, count);
  assert.deepEqual(pauses, [156], 'pause callback follows its position event');
  video.ended = true; video.fire('ended'); assert.equal(ended, 1);
  handle.destroy(); handle.destroy(); video.fire('ended'); assert.equal(ended, 1);
  assert.equal(host.children.length, 0); assert.equal(video.src, ''); assert.equal(video.loaded, true);
  assert.equal(video.count(), 0); assert.equal(f.doc.count(), 0); assert.equal(f.timers.size, 0);
});

for (const kind of ['abort', 'timeout', 'error']) test(`HTML5 ${kind} before metadata cleans listeners and settles`, async () => {
  const f = fixture(), host = f.host(), controller = new AbortController(), errors = [];
  const pending = createLessonPlayer({ host, media: file, signal: controller.signal, onError: e => errors.push(e) });
  const failed = assert.rejects(pending, kind === 'abort' ? { name: 'AbortError' } : /Tente novamente/);
  const video = host.children[0];
  if (kind === 'abort') controller.abort(); else if (kind === 'timeout') f.tick(15000); else video.fire('error');
  await failed; video.fire('loadedmetadata'); assert.equal(errors.length, kind === 'abort' ? 0 : 1);
  assert.equal(video.count(), 0); assert.equal(f.doc.count(), 0); assert.equal(f.timers.size, 0); assert.equal(host.children.length, 0);
});

test('unsupported media, unsafe URLs and pre-aborted lesson do not create elements', async () => {
  const f = fixture(), host = f.host(), controller = new AbortController(); controller.abort();
  await assert.rejects(createLessonPlayer({ host, media: youtube, signal: controller.signal }), { name: 'AbortError' });
  for (const media of [{ type: 'other' }, { type: 'youtube', video_id: '../bad' }, { type: 'file', url: 'http://media.example/a.mp4' }, { type: 'file', url: 'https://user:pass@media.example/a.mp4' }]) {
    await assert.rejects(createLessonPlayer({ host, media }), TypeError);
  }
  assert.equal(host.children.length, 0); assert.equal(f.doc.head.children.length, 0);
});

test('loader error propagates to each consumer and removes abort observers', async () => {
  const f = fixture(), controller = new AbortController(), errors = [];
  const pending = createLessonPlayer({ host: f.host(), media: youtube, signal: controller.signal, onError: error => errors.push(error) });
  const failed = assert.rejects(pending, /carregar/);
  f.doc.head.children[0].fire('error'); await failed;
  assert.equal(errors.length, 1); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(f.timers.size, 0); assert.equal(f.instances.length, 0);
});

test('YouTube constructor exception releases iframe, listeners and readiness timer', async () => {
  const f = fixture(), host = f.host(), controller = new AbortController(), errors = [];
  f.doc.defaultView.YT = { Player: class { constructor() { throw new Error('provider construction failed'); } } };
  await assert.rejects(createLessonPlayer({ host, media: youtube, signal: controller.signal, onError: error => errors.push(error) }), /construction failed/);
  assert.equal(errors.length, 1); assert.equal(host.children.length, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.doc.count(), 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

for (const type of ['youtube', 'file']) test(`${type}: abort after readiness silences callbacks and clears resources`, async () => {
  const f = fixture(), host = f.host(), controller = new AbortController(), positions = [];
  f.install();
  const pending = createLessonPlayer({ host, media: type === 'youtube' ? youtube : file, signal: controller.signal, onPosition: p => positions.push(p) });
  await flush();
  if (type === 'youtube') f.instances[0].ready(); else host.children[0].fire('loadedmetadata');
  const handle = await pending;
  if (type === 'youtube') f.instances[0].state(1); else { host.children[0].paused = false; host.children[0].fire('playing'); }
  controller.abort(); handle.pause(); handle.seek(20); f.tick(2000);
  assert.equal(positions.length, 0); assert.equal(host.children.length, 0); assert.equal(f.timers.size, 0);
  assert.equal(f.doc.count(), 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('HTML5 runtime failure reports once, destroys media and never ends the lesson', async () => {
  const f = fixture(), host = f.host(), errors = []; let ended = 0;
  const pending = createLessonPlayer({ host, media: file, onError: error => errors.push(error), onEnded: () => ended++ });
  const video = host.children[0]; video.fire('loadedmetadata'); await pending;
  video.paused = false; video.fire('playing'); video.fire('error'); video.fire('error'); video.fire('ended');
  assert.equal(errors.length, 1); assert.equal(ended, 0); assert.equal(video.count(), 0);
  assert.equal(f.timers.size, 0); assert.equal(host.children.length, 0);
});

test('Nginx permits only required YouTube origins and preserves referrer policy and LF', () => {
  const config = readFileSync(new URL('../../nginx/nginx.conf', import.meta.url), 'utf8');
  assert.ok(!config.includes('\r'));
  assert.match(config, /add_header Content-Security-Policy \$portal_csp always;/);
  const policyMap = config.match(/map \$uri \$portal_csp\s*\{([^}]+)\}/);
  assert.ok(policyMap, 'Portal CSP map must be present');
  const defaultPolicy = policyMap[1].match(/\bdefault\s+"([^"]+)";/);
  assert.ok(defaultPolicy, 'Portal routes must retain the default CSP');
  const csp = defaultPolicy[1];
  const directives = Object.fromEntries(csp.split(';').map(value => value.trim().split(/\s+/)).map(([key, ...values]) => [key, values]));
  assert.deepEqual(directives['script-src'], ["'self'", 'https://unpkg.com', 'https://www.gstatic.com', 'https://cdnjs.cloudflare.com', 'https://www.youtube.com', 'https://s.ytimg.com']);
  assert.deepEqual(directives['frame-src'], ['https://*.firebaseapp.com', 'blob:', 'https://www.youtube.com', 'https://www.youtube-nocookie.com']);
  assert.match(config, /Referrer-Policy "strict-origin-when-cross-origin" always/);
});
