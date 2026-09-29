import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createFeedbackHarness, deferred, drain } from '../helpers/frontend-feedback-harness.mjs';

const source = await readFile('public/autocard/asset-catalog.js', 'utf8');
const { ICON_ASSETS, ILLUSTRATION_ASSETS, searchAssets } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const expose = 'globalThis.probe = { selectTemplate, exportCard, saveCard, revision: () => editRevision, current: () => current };';
async function mounted(t, options) { const h = await createFeedbackHarness('autocard', { expose, ...options }); t.after(() => h.page.dispose()); return h; }

test('presentation catalogs preserve every canonical ID/order and give each item Portuguese search metadata', async () => {
  const api = await readFile('api/routes/autocard.js', 'utf8');
  for (const [mode, name, assets, count] of [['icon', 'icons', ICON_ASSETS, 38], ['illustration', 'illustrations', ILLUSTRATION_ASSETS, 16]]) {
    const ids = [...api.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]+)\\]\\)`))[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
    assert.deepEqual(assets.map(item => item.id), ids); assert.equal(assets.length, count);
    for (const item of assets) {
      assert.ok(item.title && item.aliases); assert.notEqual(item.title, item.id);
      assert.ok(searchAssets(mode, item.id).some(match => match.id === item.id));
      assert.ok(searchAssets(mode, item.title).some(match => match.id === item.id));
    }
    for (const query of [' aniversário ', 'ANIVERSARIO', 'cake']) assert.ok(searchAssets(mode, query).some(item => item.id === 'cake'));
    assert.equal(searchAssets(mode, 'inexistente-xyz').length, 0);
  }
  for (const query of ['alerta', ' ALERT ', 'triangle-alert']) assert.ok(searchAssets('icon', query).some(item => item.id === 'triangle-alert'));
  for (const query of ['páscoa', 'PASCOA', 'rabbit']) assert.equal(searchAssets('illustration', query)[0].id, 'rabbit');
});

test('mounted libraries explain no matches, clear/reopen search and persist IDs without editing on same selection', async t => {
  const h = await mounted(t); h.context.probe.selectTemplate('aniversariante');
  for (const [button, field, count] of [['iconButton', 'icon', 38], ['illustrationButton', 'illustration', 16]]) {
    h.node(button).click();
    assert.equal(h.node('assetGrid').querySelectorAll('button').length, count);
    h.input('assetSearch', 'inexistente');
    assert.equal(h.node('assetGrid').children.length, 0);
    assert.match(h.node('assetSearchStatus').textContent, /Nenhum.*para esta busca/);
    assert.equal(h.node('assetSearchStatus').getAttribute('role'), 'status');
    assert.equal(h.node('assetSearchClear').hidden, false);
    h.node('assetSearchClear').click();
    assert.equal(h.node('assetSearch').value, '');
    assert.equal(h.doc.activeElement, h.node('assetSearch'));
    assert.equal(h.node('assetGrid').children.length, count);
    assert.equal(h.node('assetSearchStatus').textContent, '');
    h.input('assetSearch', 'ANIVERSÁRIO');
    const cake = h.doc.querySelector('[data-asset="cake"]');
    assert.match(cake.getAttribute('aria-label'), /Bolo de aniversário/);
    assert.equal(cake.type, 'button');
    const before = h.context.probe.revision(), previous = h.context.probe.current()[field];
    cake.click(); assert.equal(h.context.probe.current()[field], 'cake');
    assert.equal(h.context.probe.revision(), before + (previous === 'cake' ? 0 : 1));
    assert.equal(h.node('assetDialog').open, false);
    h.node(button).click(); assert.equal(h.node('assetSearch').value, '');
    const revision = h.context.probe.revision(); h.doc.querySelector('[data-asset="cake"]').click();
    assert.equal(h.context.probe.revision(), revision);
  }
  h.node('iconButton').click(); h.input('assetSearch', 'alerta');
  const revision = h.context.probe.revision();
  h.doc.querySelector('[data-asset="triangle-alert"]').click();
  assert.equal(h.context.probe.revision(), revision + 1);
  const saving = h.context.probe.saveCard();
  const request = h.latest('/api/autocard/cards');
  const payload = JSON.parse(request.options.body);
  assert.equal(payload.icon, 'triangle-alert'); assert.equal(payload.illustration, 'cake');
  request.resolve({ id: 'saved' }); await saving;
});

test('PNG reports generation then download requested only after current capture clicks, restoring its button', async t => {
  const fonts = deferred(); const h = await mounted(t, { fonts: fonts.promise });
  h.context.probe.selectTemplate('comunicado');
  const exportPromise = h.context.probe.exportCard();
  assert.equal(h.node('exportButton').textContent, 'Gerando PNG…');
  assert.equal(h.node('exportButton').disabled, true);
  assert.equal(h.node('toast').textContent, 'Gerando PNG…');
  await h.context.probe.exportCard(); assert.equal(h.captures.length, 0, 'duplicate invocation cannot start capture');
  fonts.resolve(); await drain();
  assert.equal(h.captures.length, 1); assert.equal(h.doc.downloads.length, 0);
  assert.equal(h.captures[0].options.width * h.captures[0].options.scale, 1080);
  h.captures[0].resolve({ toDataURL: () => 'data:image/png;base64,synthetic' }); await exportPromise;
  assert.equal(h.doc.downloads.length, 1);
  assert.equal(h.node('toast').textContent, 'PNG gerado; download solicitado ao navegador.');
  assert.equal(h.node('exportButton').textContent, 'Exportar PNG'); assert.equal(h.node('exportButton').disabled, false);
});

for (const change of ['edit', 'document', 'dispose', 'capture failure', 'decode failure', 'overflow']) {
  test(`PNG never announces success after ${change} and leaves independent media feedback intact`, async t => {
    const h = await mounted(t); h.context.probe.selectTemplate('comunicado');
    h.node('mediaStatus').textContent = 'Falha anterior de mídia; imagem preservada.';
    if (change === 'decode failure') h.node('cardCanvas').querySelector('img').decode = () => Promise.reject(new Error('bad image'));
    const exporting = h.context.probe.exportCard(); await drain();
    if (change !== 'decode failure') {
      assert.equal(h.captures.length, 1);
      if (change === 'edit') h.input('field-titulo', 'Edição posterior');
      if (change === 'document') h.context.probe.selectTemplate('vaga');
      if (change === 'dispose') h.page.dispose();
      if (change === 'overflow') h.node('cardCanvas').querySelector('.card-shell').scrollHeight = 900;
      if (change === 'capture failure') h.captures[0].reject(new Error('capture failed'));
      else h.captures[0].resolve({ toDataURL: () => 'data:image/png;base64,old' });
    }
    await exporting;
    assert.equal(h.doc.downloads.length, 0); assert.doesNotMatch(h.node('toast').textContent, /PNG gerado/);
    if (change !== 'dispose') {
      assert.equal(h.node('exportButton').textContent, 'Exportar PNG');
      assert.equal(h.node('exportButton').disabled, change === 'overflow');
    }
    if (!['document', 'dispose'].includes(change)) assert.equal(h.node('mediaStatus').textContent, 'Falha anterior de mídia; imagem preservada.');
  });
}
