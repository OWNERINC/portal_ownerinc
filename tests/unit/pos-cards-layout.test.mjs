import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

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

test('preview uses the padded content box, updates after model/toolbar/viewport resize, and disconnects', async t => {
  const { observePreviewLayout } = await import(pathToFileURL('public/cards-pos/preview-layout.js').href);
  const previous = { ResizeObserver: globalThis.ResizeObserver, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  const observed = [], listeners = [], cleanups = [], properties = new Map();
  let disconnected = false, resized, mobile = false, mode = 'fit', frame = CARD_GEOMETRY.convite_owner;
  globalThis.ResizeObserver = class { constructor(callback) { resized = callback; } observe(node) { observed.push(node); } disconnect() { disconnected = true; } };
  globalThis.window = { innerHeight: 800, scrollY: 0, matchMedia: () => ({ matches: mobile }), visualViewport: { height: 800 } };
  globalThis.getComputedStyle = () => ({ paddingLeft: '24px', paddingRight: '24px', paddingTop: '24px', paddingBottom: '24px' });
  const container = {
    clientWidth: 500,
    get clientHeight() { return parseFloat(this.style.height) || 400; },
    getBoundingClientRect: () => ({ top: 240 - window.scrollY }),
    style: { height: '', removeProperty(key) { this[key] = ''; } },
  };
  const toolbar = {};
  const update = observePreviewLayout({ container, toolbar, frame: () => frame, mode: () => mode,
    wrapper: { style: { setProperty: (key, value) => properties.set(key, parseFloat(value)) } },
    page: { listen: (...args) => listeners.push(args), cleanup: fn => cleanups.push(fn) },
  });
  assert.deepEqual(observed, [container, toolbar]);
  assert.ok(properties.get('--preview-height') <= 352);
  assert.ok(properties.get('--preview-width') <= 452);
  mode = 'width'; resized();
  assert.ok(Math.abs(properties.get('--preview-width') - 452) < 0.001);
  assert.ok(properties.get('--preview-height') > 352);
  mode = 'fit'; mobile = true; update();
  assert.equal(container.style.height, '544px');
  assert.ok(properties.get('--preview-height') <= 496);
  // Page scroll must not continually resize the art while reading/editing.
  window.scrollY = 120; update();
  assert.equal(container.style.height, '544px');
  window.visualViewport.height = 500;
  listeners.find(([target]) => target === window.visualViewport)[2]();
  assert.equal(container.style.height, '244px');
  assert.ok(properties.get('--preview-height') <= 196);
  mobile = false; frame = CARD_GEOMETRY.convite_owntime; update();
  assert.equal(container.style.height, '');
  assert.ok(properties.get('--preview-height') <= 352);
  cleanups.forEach(fn => fn());
  assert.equal(disconnected, true);
});
