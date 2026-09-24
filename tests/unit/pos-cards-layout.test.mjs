import assert from 'node:assert/strict'; import test from 'node:test'; import { readFile } from 'node:fs/promises'; import { pathToFileURL } from 'node:url';
const source = await readFile('public/cards-pos/card-geometry.js', 'utf8'); const { CARD_GEOMETRY, fitPreview } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
test('geometria lógica não depende do bounding box', () => { const r = fitPreview(CARD_GEOMETRY.convite_owner, { width: 400, height: 300 }, 'desktop'); assert.ok(r.scale <= 1); assert.equal(CARD_GEOMETRY.convite_owntime.pdfHeight, 175.1); assert.equal(fitPreview(CARD_GEOMETRY.convite_owner, { width: 0, height: 0 }).scale, 0); });
test('layout observa o container e desconecta no cleanup', async () => {
  const layoutSource = await readFile('public/cards-pos/preview-layout.js', 'utf8');
  const { observePreviewLayout } = await import(pathToFileURL('public/cards-pos/preview-layout.js').href);
  let observed = 0; let disconnected = 0;
  globalThis.ResizeObserver = class { observe() { observed += 1; } disconnect() { disconnected += 1; } };
  globalThis.window = {};
  const container = { clientWidth: 500, clientHeight: 600 }; const style = { setProperty() {} }; const cleanups = [];
  observePreviewLayout({ container, frame: CARD_GEOMETRY.convite_owntime, wrapper: { style }, page: { listen() {}, cleanup(fn) { cleanups.push(fn); } } });
  assert.equal(observed, 1); cleanups[0](); assert.equal(disconnected, 1);
});
