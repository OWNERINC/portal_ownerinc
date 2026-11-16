import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { drain, TestEvent } from '../helpers/frontend-feedback-harness.mjs';
import { rendererHarness as harness } from '../helpers/pages-renderer-harness.mjs';
const require = createRequire(import.meta.url);
const { createTemplate } = require('../../api/pages/templates');

for (const kind of ['audio','video','gif']) test(`${kind} requires explicit load, never plays automatically, cancels/revokes late blobs and cleans sources on dispose`, async () => {
  const h = await harness();
  const block = { id: 'id', type: kind, media_id: 'media', title: 'Sintético', alt: 'Teste', transcript: 'Transcrição', captions: [{ start_ms: 0, end_ms: 1000, text: 'Legenda' }] };
  const figure = h.context.mediaFigure(block, h.options), media = figure.node.querySelector(kind === 'gif' ? 'img' : kind), [load,stop] = figure.node.querySelectorAll('button');
  assert.equal(h.requests.length, 0); assert.equal(media.hasAttribute('autoplay'), false); assert.equal(media.plays, 0);
  if (kind === 'gif') assert.equal(media.hidden, true, 'unloaded animation must not show a broken image');
  if (kind === 'video') assert.equal(media.hasAttribute('playsinline'), true);
  load.click(); assert.equal(h.requests.length, 1); const first = h.requests[0]; stop.click();
  assert.equal(first.args[2].signal.aborted, true); first.resolve('blob:late'); await drain(); assert.ok(h.revoked.includes('blob:late')); assert.equal(media.src, undefined);
  load.click(); h.requests[1].resolve('blob:ready'); await drain(); assert.equal(media.src, 'blob:ready'); assert.equal(media.plays, 0);
  if (kind === 'gif') assert.equal(media.hidden, false);
  if (kind === 'video') { assert.equal(figure.node.querySelectorAll('track').length, 1); assert.match(await h.created[0].blob.text(), /00:00:00.000 --> 00:00:01.000/); }
  const before = media.pauses; figure.dispose(); assert.ok(h.revoked.includes('blob:ready')); assert.equal(media.hasAttribute('src'), false);
  if (kind !== 'gif') assert.ok(media.pauses > before);
  else assert.equal(media.hidden, true);
  assert.equal(figure.node.querySelectorAll('track').length, 0);
});

test('shared renderer consumes legacy destinations and typed v3 actions, with canonical checked button colors and local video focus/load', async () => {
  const h = await harness();
  for (const schema of [2,3]) {
    const doc = createTemplate('owner-news'), section = doc.sections[0], videoId = randomUUID();
    doc.schema_version = schema;
    if (schema === 3) doc.presentation.defaults = { foreground: '#26204A', background: '#FFFFFF', font: 'manrope', scale: 'standard', align: 'start' };
    const blocks = section.rows[0].columns[0].blocks;
    blocks.push({ id: videoId, type: 'video', media_id: randomUUID(), title: 'Vídeo local', captions: [] });
    blocks.push({ id: randomUUID(), type: 'button', label: 'Ver guia completo', preset: 'primary', [schema === 3 ? 'action' : 'destination']: { type: 'section', value: section.id } });
    if (schema === 3) blocks.push({ id: randomUUID(), type: 'button', label: 'Assistir ao vídeo', preset: 'secondary', action: { type: 'video', value: videoId } });
    const host = h.doc.createElement('div'); h.doc.body.append(host);
    const dispose = h.context.renderDocument({ host, document: doc, ...h.options });
    const guide = host.querySelector('.pages-action-button'); assert.ok(guide); assert.match(guide.getAttribute('href'), /^https:\/\/portal.test\/conteudos\/teste#section-/);
    let historyWrites = 0; h.context.window.history.pushState = () => { historyWrites++; };
    const sectionClick = new TestEvent('click', { bubbles: true, button: 0 }); guide.dispatchEvent(sectionClick);
    assert.equal(historyWrites, 0, 'preview renderer must not write global history');
    assert.equal(sectionClick.defaultPrevented, true); assert.equal(h.doc.activeElement.id, `section-${section.id}`);
    if (schema === 2) { assert.equal(guide.dataset.legacy, 'true'); assert.equal(guide.querySelectorAll('svg').length, 0); }
    if (schema === 3) {
      assert.equal(guide.style.color, '#FFFFFF'); assert.equal(guide.style.backgroundColor, '#26204A');
      const videoButton = host.querySelectorAll('.pages-action-button')[1]; videoButton.click();
      assert.equal(h.requests.length, 1); assert.equal(h.doc.activeElement.tagName, 'VIDEO');
      h.requests[0].resolve('blob:video'); await drain(); assert.equal(host.querySelector('video').plays, 0);
    }
    assert.equal(host.querySelectorAll('iframe').length, 0); dispose();
  }
});
test('media load and subsequent caption refresh resolve the current composed state, not the original block closure', async () => {
  const h = await harness(), doc = createTemplate('owner-news'), id = randomUUID();
  doc.sections[0].rows[0].columns[0].blocks.push({ id, type: 'video', media_id: randomUUID(), title: 'Antes', transcript: '', captions: [] });
  const state = h.context.createEditorState({ draft: { document: doc }, capabilities: { edit: true } });
  const resolveBlock = () => h.context.findBlock(state.document, id)?.block;
  const figure = h.context.mediaFigure(resolveBlock(), { ...h.options, resolveBlock });
  state.replace(h.context.compose(state.document, { type: 'section' }));
  resolveBlock().captions = [{ start_ms: 0, end_ms: 1000, text: 'Legenda após composição' }];
  resolveBlock().title = 'Título atual'; resolveBlock().transcript = 'Transcrição atual'; figure.refresh();
  assert.match(figure.node.textContent, /Título atual/); assert.match(figure.node.textContent, /Transcrição atual/);
  figure.node.querySelectorAll('button')[0].click();
  // Even an edit while the authorized bytes are pending must use the newest cues.
  resolveBlock().captions[0].text = 'Legenda editada durante download';
  h.requests[0].resolve('blob:current'); await drain();
  assert.match(await h.created[0].blob.text(), /Legenda editada durante download/);
  resolveBlock().captions[0].text = 'Legenda enquanto carregado'; figure.refresh();
  assert.ok(h.revoked.includes(h.created[0].url)); assert.match(await h.created[1].blob.text(), /Legenda enquanto carregado/);
  assert.equal(figure.node.querySelector('video').src, 'blob:current', 'caption refresh preserves the media source');
  figure.dispose();
});
test('VTT serialization rejects unsafe, unordered, fractional, excessive and overlapping cues', async () => {
  const h = await harness(), valid = [{ start_ms: 0, end_ms: 1000, text: 'Legenda' }];
  assert.match(h.context.captionsVTT(valid), /^WEBVTT/);
  for (const cues of [[{ ...valid[0], text: '<b>HTML</b>' }], [{ ...valid[0], start_ms: 0.5 }], [valid[0], { ...valid[0], start_ms: 500 }], Array(501).fill(valid[0])]) assert.equal(h.context.captionsVTT(cues), null);
});
