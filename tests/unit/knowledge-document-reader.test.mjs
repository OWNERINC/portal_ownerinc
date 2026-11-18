import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function harness() {
  const source = (await readFile('public/js/knowledge-documents.js', 'utf8'))
    .replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, '');
  const calls = [], revoked = [], observers = [];
  const context = { AbortController, console,
    URL: { revokeObjectURL: url => revoked.push(url) },
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe() {} disconnect() {}
    },
  };
  vm.runInNewContext(`${source}\nglobalThis.create = createDocumentImages;`, context);
  const queue = context.create({ fetchAsset(url, options) {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    calls.push({ url, options, resolve, reject });
    return promise;
  } });
  const image = () => ({ src: '', removeAttribute(name) { if (name === 'src') this.src = ''; } });
  const visible = (node, value) => observers[0].callback([{ target: node, isIntersecting: value }]);
  const drain = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { queue, calls, revoked, image, visible, drain };
}

test('document images are lazy, bounded to two requests and discarded across disposal', async () => {
  const h = await harness();
  const images = [h.image(), h.image(), h.image()];
  images.forEach((image, i) => h.queue.observe(image, `/page/${i}`));
  assert.equal(h.calls.length, 0);
  images.forEach(image => h.visible(image, true));
  await h.drain();
  assert.equal(h.calls.length, 2);
  h.calls[0].resolve('blob:one'); await h.drain();
  assert.equal(images[0].src, 'blob:one');
  assert.equal(h.calls.length, 3);
  h.queue.dispose();
  assert.ok(h.calls[1].options.signal.aborted);
  h.calls[1].resolve('blob:late'); h.calls[2].resolve('blob:later'); await h.drain();
  assert.equal(images.every(image => !image.src), true);
  assert.deepEqual(h.revoked.sort(), ['blob:late', 'blob:later', 'blob:one']);
});

test('leaving the viewport releases images; failures retain an explicit retry', async () => {
  const h = await harness();
  const image = h.image(), states = [];
  const retry = h.queue.observe(image, '/page/1', state => states.push(state));
  h.visible(image, true);
  await h.drain();
  h.calls[0].reject(new Error('offline')); await h.drain();
  assert.equal(states.at(-1), 'error');
  retry(); await h.drain(); h.calls[1].resolve('blob:ready'); await h.drain();
  assert.equal(image.src, 'blob:ready');
  h.visible(image, false);
  assert.equal(image.src, '');
  assert.deepEqual(h.revoked, ['blob:ready']);
  h.visible(image, true);
  await h.drain();
  assert.equal(h.calls.length, 3);
  h.queue.dispose();
  h.calls[2].resolve('blob:disposed'); await h.drain();
  retry();
  assert.equal(h.calls.length, 3);
});
