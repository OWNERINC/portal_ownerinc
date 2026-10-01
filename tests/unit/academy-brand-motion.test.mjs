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
  const node = { style: {}, animate(keyframes, options) { const animation = { keyframes, options, cancel() { this.cancelled = true; }, finished: Promise.resolve() }; animations.push(animation); return animation; } };
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
  const reducedNode = { style: {}, animate() { throw new Error('não deve animar'); } };
  const reducedRoot = { querySelectorAll() { return [reducedNode]; } };
  context.mountAcademyMotion(reducedRoot, { reducedMotion: true });
  assert.equal(reducedNode.style.opacity, '1');
  assert.equal(reducedNode.style.transform, 'none');
});
