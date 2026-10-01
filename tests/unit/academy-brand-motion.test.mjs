import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function load(file, names, context) {
  const source = (await readFile(file, 'utf8')).replace(/^export /gm, '');
  vm.runInNewContext(`${source}\nObject.assign(globalThis, { ${names} });`, context, { filename: file });
}

test('brand loader only follows manifest filenames and rejects active SVG content', async () => {
  const requested = [];
  const svg = key => `<svg viewBox="0 0 1 1"><g data-part="1"><path fill="currentColor"/></g></svg>`;
  const context = {
    fetch: async (url) => {
      requested.push(url);
      if (url.endsWith('manifest.json')) return { ok: true, async json() { return { assets: ['symbol', 'icon-01', 'icon-02', 'icon-03', 'icon-04', 'icon-05', 'icon-06', 'logo-dark', 'logo-light'].map(key => ({ key, file: `${key}.svg` })) }; } };
      return { ok: true, async text() { return url.endsWith('icon-01.svg') ? '<svg><script>alert(1)</script></svg>' : svg('symbol'); } };
    },
    DOMParser: class { parseFromString(text) {
      const dangerous = /script/i.test(text);
      const node = { localName: 'svg', attributes: [], setAttribute() {}, removeAttribute() {}, cloneNode() { return this; }, querySelector(selector) { return dangerous && selector === 'script,foreignObject,image,style,use,iframe,link' ? {} : null; }, querySelectorAll() { return []; } };
      return { documentElement: node, querySelector() { return null; } };
    } },
  };
  await load('public/academy/brand.js', 'loadBrandAssets', context);
  await assert.rejects(context.loadBrandAssets(), /Vetor/);
  assert.deepEqual(requested, ['./assets/academy/manifest.json', './assets/academy/symbol.svg', './assets/academy/icon-01.svg']);
});

test('motion uses approved timing, cancels on abort, and renders reduced motion final state', async () => {
  const animations = [];
  const node = { style: {}, dataset: {}, animate(keyframes, options) { const animation = { keyframes, options, cancel() { this.cancelled = true; }, finished: Promise.resolve() }; animations.push(animation); return animation; } };
  const root = { querySelectorAll(selector) { return selector === '[data-motion-part]' ? [node] : []; } };
  const controller = new AbortController();
  const context = { window: { matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; } } };
  await load('public/academy/motion.js', 'mountAcademyMotion, playCompletion', context);
  const dispose = context.mountAcademyMotion(root, { signal: controller.signal });
  assert.equal(animations[0].options.duration, 600);
  assert.equal(animations[0].options.delay, 0);
  controller.abort();
  assert.equal(animations[0].cancelled, true);
  dispose();
  const reducedNode = { style: {}, dataset: {}, animate() { throw new Error('não deve animar'); } };
  const reducedRoot = { querySelectorAll() { return [reducedNode]; } };
  context.mountAcademyMotion(reducedRoot, { reducedMotion: true });
  assert.equal(reducedNode.style.opacity, '1');
  assert.equal(reducedNode.style.transform, 'none');
});

test('motion marks each part once and does not animate after disposal', async () => {
  const animations = [];
  const first = { style: {}, dataset: {}, animate() { const animation = { cancel() {}, finished: Promise.resolve() }; animations.push(animation); return animation; } };
  const second = { style: {}, dataset: {}, animate() { const animation = { cancel() {}, finished: Promise.resolve() }; animations.push(animation); return animation; } };
  const root = { querySelectorAll() { return [first, second]; } };
  const context = { window: { matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; } } };
  await load('public/academy/motion.js', 'mountAcademyMotion', context);
  const dispose = context.mountAcademyMotion(root);
  assert.equal(animations.length, 2);
  root.querySelectorAll = () => [first, second];
  dispose();
  assert.equal(animations.length, 2);
  assert.equal(first.style.opacity, '1');
  assert.equal(second.style.opacity, '1');
});

test('brand clones remove IDs and preserve explicit ARIA semantics', async () => {
  const part = { removeAttribute() {}, setAttribute() {} };
  const source = {
    cloneNode() { return { ...this, querySelectorAll() { return [part]; }, removeAttribute() {}, setAttribute(name, value) { this[name] = value; } }; },
    querySelectorAll() { return []; }, removeAttribute() {}, setAttribute() {},
  };
  const context = {};
  await load('public/academy/brand.js', 'createBrandIcon', context);
  const decorative = context.createBrandIcon(new Map([['icon-01', source]]), 'icon-01');
  assert.equal(decorative['aria-hidden'], 'true');
  const labelled = context.createBrandIcon(new Map([['icon-01', source]]), 'icon-01', { decorative: false, label: 'Ícone' });
  assert.equal(labelled.role, 'img');
  assert.equal(labelled['aria-label'], 'Ícone');
});

test('completion motion is finite and cancelled by the classroom signal', async () => {
  const animations = [];
  const node = { style: {}, animate(keyframes, options) { const animation = { keyframes, options, cancel() { this.cancelled = true; }, finished: Promise.resolve() }; animations.push(animation); return animation; } };
  const media = { matches: false, addEventListener() {}, removeEventListener() {} };
  const context = { window: { matchMedia() { return media; } } };
  await load('public/academy/motion.js', 'mountAcademyMotion, playCompletion', context);
  const signal = new AbortController();
  context.playCompletion({ querySelector() { return node; } }, { signal: signal.signal });
  assert.equal(animations[0].options.duration, 450);
  signal.abort();
  assert.equal(animations[0].cancelled, true);
});

test('view integration protects CMS covers and prevents filter remount entry replay', async () => {
  const view = await readFile('public/academy/view-utils.js', 'utf8');
  const app = await readFile('public/academy/app.js', 'utf8');
  const catalog = await readFile('public/academy/catalog-view.js', 'utf8');
  assert.match(view, /course\.cover_asset_id \?\s*\{ 'data-authoritative-cover': 'true' \}/);
  assert.match(view, /data-brand-fallback/);
  assert.match(app, /catalogEntryPending/);
  assert.match(catalog, /reducedMotion: !entryMotion/);
  assert.match(catalog, /academyCatalogFocus/);
  assert.match(catalog, /aria-busy/);
  assert.match(view, /if \(course\.cover_asset_id\)/);
});
