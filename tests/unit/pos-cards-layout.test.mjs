import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createFeedbackHarness, deferred, drain } from '../helpers/frontend-feedback-harness.mjs';

const source = await readFile('public/cards-pos/card-geometry.js', 'utf8');
const { CARD_GEOMETRY, fitPreview } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('whole-art mode fits both dimensions at every viewport without changing print geometry', () => {
  for (const frame of Object.values(CARD_GEOMETRY)) {
    for (const available of [{ width: 720, height: 400 }, { width: 320, height: 300 }, { width: 270, height: 450 }]) {
      for (const mode of ['fit', 'desktop', 'mobile']) {
        const result = fitPreview(frame, available, mode);
        assert.ok(result.width <= available.width + 0.001);
        assert.ok(result.height <= available.height + 0.001);
        assert.ok(Math.abs(result.width / result.height - frame.width / frame.height) < 0.0001);
      }
    }
  }
  const expanded = fitPreview(CARD_GEOMETRY.convite_owner, { width: 600, height: 300 }, 'width');
  assert.equal(expanded.width, 600);
  assert.ok(expanded.height > 300);
  assert.equal(CARD_GEOMETRY.convite_owner.pdfHeight, 250.68);
  assert.equal(CARD_GEOMETRY.convite_owntime.pdfHeight, 175.1);
  assert.equal(fitPreview(CARD_GEOMETRY.convite_owner, { width: 0, height: 0 }).scale, 0);
});

async function layoutHarness(t) {
  const { observePreviewLayout } = await import(pathToFileURL('public/cards-pos/preview-layout.js').href);
  const lifecycleSource = await readFile('public/js/page-lifecycle.js', 'utf8');
  const { createPageLifecycle } = await import('data:text/javascript;base64,' + Buffer.from(lifecycleSource).toString('base64'));
  const previous = Object.fromEntries(['ResizeObserver', 'window', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'].map(key => [key, globalThis[key]]));
  let page;
  t.after(() => {
    page?.dispose();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  const observed = [], properties = new Map(), frames = new Map(), writes = [];
  const state = { disconnected: false, mobile: false, mode: 'fit', frame: CARD_GEOMETRY.convite_owner, height: 400, notifyOnWrite: false };
  let resized, frameId = 0, height = '';
  globalThis.ResizeObserver = class { constructor(callback) { resized = callback; } observe(node) { observed.push(node); } disconnect() { state.disconnected = true; } };
  globalThis.window = Object.assign(new EventTarget(), { history: {}, innerHeight: 800, scrollY: 0, matchMedia: () => ({ matches: state.mobile }), visualViewport: Object.assign(new EventTarget(), { height: 800 }) });
  globalThis.requestAnimationFrame = callback => { const id = ++frameId; frames.set(id, callback); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.getComputedStyle = () => ({ paddingLeft: '24px', paddingRight: '24px', paddingTop: '24px', paddingBottom: '24px' });
  const container = {
    clientWidth: 500,
    get clientHeight() { return parseFloat(this.style.height) || state.height; },
    getBoundingClientRect: () => ({ top: 240 - window.scrollY }),
    style: { get height() { return height; }, set height(value) { height = state.roundSerialization && value ? `${Number(parseFloat(value).toFixed(3))}px` : value; writes.push(['height', value]); }, removeProperty(key) { this[key] = ''; } },
  };
  const toolbar = {};
  page = createPageLifecycle();
  const update = observePreviewLayout({ container, toolbar, frame: () => state.frame, mode: () => state.mode,
    wrapper: { style: { setProperty(key, value) { properties.set(key, parseFloat(value)); writes.push([key, value]); if (state.notifyOnWrite) resized(); } } }, page,
  });
  return { state, observed, properties, frames, writes, container, toolbar, update, page, resized: () => resized(),
    flush() { const pending = [...frames]; frames.clear(); pending.forEach(([, fn]) => fn()); } };
}

test('preview uses the padded content box, updates after model/toolbar/viewport resize, and disconnects', async t => {
  const h = await layoutHarness(t);
  const { state, observed, properties, container, toolbar, update } = h;
  assert.deepEqual(observed, [container, toolbar]);
  assert.ok(properties.get('--preview-height') <= 352);
  assert.ok(properties.get('--preview-width') <= 452);
  state.mode = 'width'; h.resized();
  assert.ok(properties.get('--preview-height') <= 352, 'observer must not write synchronously');
  h.flush();
  assert.ok(Math.abs(properties.get('--preview-width') - 452) < 0.001);
  assert.ok(properties.get('--preview-height') > 352);
  state.mode = 'fit'; state.mobile = true; const result = update();
  assert.equal(result.height, properties.get('--preview-height'), 'explicit updater still returns measured geometry');
  assert.equal(container.style.height, '544px');
  assert.ok(properties.get('--preview-height') <= 496);
  // Page scroll must not continually resize the art while reading/editing.
  window.scrollY = 120; update();
  assert.equal(container.style.height, '544px');
  window.visualViewport.height = 500;
  window.visualViewport.dispatchEvent(new Event('resize')); h.flush();
  assert.equal(container.style.height, '244px');
  assert.ok(properties.get('--preview-height') <= 196);
  state.mobile = false; state.frame = CARD_GEOMETRY.convite_owntime; update();
  assert.equal(container.style.height, '');
  assert.ok(properties.get('--preview-height') <= 352);
  h.page.dispose();
  assert.equal(state.disconnected, true);
});

test('observer notifications coalesce and feedback from style writes converges to zero further writes', async t => {
  const h = await layoutHarness(t);
  h.state.mode = 'width'; h.state.notifyOnWrite = true;
  const baseline = h.writes.length;
  for (let i = 0; i < 100; i++) h.resized();
  assert.equal(h.frames.size, 1); assert.equal(h.writes.length, baseline);
  h.flush(); assert.equal(h.frames.size, 1, 'one resulting size notification, not recursive synchronous writes');
  const changed = h.writes.length; assert.ok(changed > baseline);
  h.flush(); assert.equal(h.frames.size, 0); assert.equal(h.writes.length, changed);
  for (let frame = 0; frame < 60; frame++) { h.resized(); h.flush(); }
  assert.equal(h.writes.length, changed, '60 unchanged measurements must not rewrite CSS');
  h.state.mobile = true; h.update(); const mobileWrites = h.writes.length;
  h.update(); window.scrollY = 120; h.update();
  assert.equal(h.writes.length, mobileWrites, 'stable document-relative top does not resize while scrolling');
});

test('hidden preview returns at both model ratios and disposal cancels and invalidates queued callbacks', async t => {
  const h = await layoutHarness(t);
  h.container.clientWidth = 0; h.state.height = 0; h.update();
  assert.equal(h.properties.get('--preview-width'), 0);
  for (const frame of Object.values(CARD_GEOMETRY)) {
    for (const mode of ['fit', 'width']) {
      h.state.frame = frame; h.state.mode = mode;
      h.container.clientWidth = 360; h.state.height = 520;
      h.resized(); h.flush();
      const width = h.properties.get('--preview-width'), height = h.properties.get('--preview-height');
      assert.ok(Math.abs(width / height - frame.width / frame.height) < 0.00001);
      assert.ok(width <= 312); if (mode === 'fit') assert.ok(height <= 472);
    }
  }
  window.dispatchEvent(new Event('resize'));
  const retainedCallback = [...h.frames.values()][0]; assert.equal(h.frames.size, 1);
  h.page.dispose(); assert.equal(h.frames.size, 0); assert.equal(h.state.disconnected, true);
  const count = h.writes.length;
  h.container.clientWidth = 900; retainedCallback(); h.resized(); h.update();
  assert.equal(h.frames.size, 0); assert.equal(h.writes.length, count);
});

test('fractional mobile measurements do not repeat writes when CSS serialization rounds the assigned height', async t => {
  const h = await layoutHarness(t);
  h.state.mobile = true; h.state.roundSerialization = true;
  window.visualViewport.height = 800.123456;
  h.update(); const count = h.writes.length;
  for (let frame = 0; frame < 60; frame++) { h.resized(); h.flush(); }
  assert.equal(h.writes.length, count);
  assert.equal(h.container.style.height, '544.123px');
  h.state.mobile = false; h.update(); assert.equal(h.container.style.height, '');
  h.state.mobile = true; h.update(); assert.equal(h.container.style.height, '544.123px');
});

test('mounted Cards Pós recalculates after fonts and restores the preview when returning from hidden history', async t => {
  const fonts = deferred();
  const h = await createFeedbackHarness('cards-pos', { fonts: fonts.promise }); t.after(() => h.page.dispose());
  const container = h.doc.querySelector('.preview-stage'), wrapper = h.doc.querySelector('.preview-artboard');
  const before = wrapper.style.getPropertyValue('--preview-width');
  container.clientWidth = 180;
  fonts.resolve(); await drain();
  assert.notEqual(wrapper.style.getPropertyValue('--preview-width'), before);
  assert.equal(parseFloat(wrapper.style.getPropertyValue('--preview-width')), 180);
  h.doc.querySelector('[data-view="history"]').click();
  container.clientWidth = 0; container.clientHeight = 0;
  h.observers.forEach(observer => observer.callback()); await h.flushFrames();
  assert.equal(wrapper.style.getPropertyValue('--preview-width'), '0px');
  container.clientWidth = 420; container.clientHeight = 420;
  h.doc.querySelector('[data-view="editor"]').click();
  assert.equal(wrapper.style.getPropertyValue('--preview-width'), before);
});
