import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { upgradeDocument, editV3 } from '../../public/pages/document-v3.js';
import { resolveAppearance, normalizeHex } from '../../public/pages/appearance.js';
import { allBlocks } from '../../public/pages/model.js';
import { defaultStyle } from '../../public/pages/composition.js';
import { referenceDocument } from '../helpers/pages-reference-document.mjs';
const require = createRequire(import.meta.url);
const { createTemplate } = require('../../api/pages/templates');
const { validateDocument } = require('../../api/pages/validation');

test('upgrade pins legacy colors; new blocks inherit, cancel is byte-stable', () => {
  const doc = createTemplate('owner-news'), bytes = JSON.stringify(doc);
  const next = upgradeDocument(doc), old = allBlocks(next)[0];
  assert.equal(JSON.stringify(doc), bytes);
  assert.equal(old.id, allBlocks(doc)[0].id);
  assert.deepEqual(old.style, allBlocks(doc)[0].style || defaultStyle());
  next.presentation.defaults.font = 'oswald';
  assert.equal(resolveAppearance(next, old).font, old.style.font);
  assert.equal(resolveAppearance(next, { type: 'rich_text' }).font, 'oswald');
  assert.equal(editV3(doc, () => false), null);
  assert.equal(normalizeHex(' #e84f1c '), '#E84F1C');
  assert.equal(normalizeHex('url(https://example.test)'), null);
});

test('upgrade maps only supported templates, retains IDs/content/typed media/styles/actions and pins neutral colors', () => {
  for (const template of ['comunicado', 'owner-news']) {
    const doc = createTemplate(template), before = JSON.stringify(doc);
    const blocks = allBlocks(doc); blocks[0].style = { font: 'source-serif-4', align: 'end', scale: 'small', palette: 'warm' };
    const source = JSON.stringify(doc), next = upgradeDocument(doc);
    assert.equal(next.schema_version, 3); assert.equal(next.template.version, template === 'comunicado' ? 3 : 2);
    assert.equal(next.metadata.category, '');
    assert.deepEqual(next.presentation.defaults, { font: 'manrope', scale: 'standard', align: 'start', palette: 'conecta', foreground: '#2A275E', background: '#FFFEFB', accent: '#E84F1C' });
    assert.equal(JSON.stringify(doc), source); assert.notEqual(source, before);
    assert.deepEqual(allBlocks(next).map(b => b.id), blocks.map(b => b.id));
    assert.deepEqual(allBlocks(next).map(b => resolveAppearance(next, b)), blocks.map(b => resolveAppearance(doc, b)), 'every legacy wrapper retains effective appearance');
    assert.deepEqual(allBlocks(next)[0].content, blocks[0].content); assert.deepEqual(allBlocks(next)[0].style, blocks[0].style);
    for (const [index, b] of allBlocks(next).entries()) if (b.type === 'button') { assert.deepEqual(b.action, blocks[index].destination); assert.equal('destination' in b, false); }
    validateDocument(next);
    const neutral = allBlocks(next).find(b => b.style.palette === 'neutral');
    if (neutral) { next.presentation.defaults.foreground = '#FFFFFF'; next.presentation.defaults.background = '#000000'; assert.equal(resolveAppearance(next, neutral).foreground, '#2A275E'); assert.equal(resolveAppearance(next, neutral).background, '#FFFEFB'); }
  }
  const doc = createTemplate(); doc.schema_version = 2; doc.template.version = 2;
  const media = { id: 'abcdefab-1234-4000-8000-000000000001', type: 'audio', media_id: 'abcdefab-1234-4000-8000-000000000002', title: 'Audio', transcript: 'Transcript' };
  doc.sections[0].rows[0].columns[0].blocks.push(media);
  const upgraded = upgradeDocument(doc); assert.deepEqual(allBlocks(upgraded)[1], { ...media, style: defaultStyle() }); validateDocument(upgraded);
});

test('v3 clone is independent and preserves explicit overrides without adding legacy styles', () => {
  const doc = referenceDocument(), bytes = JSON.stringify(doc), next = upgradeDocument(doc);
  assert.deepEqual(next, doc); assert.notEqual(next, doc); next.presentation.defaults.font = 'oswald';
  assert.equal(JSON.stringify(doc), bytes);
  const added = { id: 'new-block', type: 'rich_text', appearance: { font: 'source-serif-4', foreground: '#112233' } };
  next.sections[0].rows[0].columns[0].blocks.push(added);
  assert.equal(resolveAppearance(next, added).font, 'source-serif-4'); assert.equal(resolveAppearance(next, added).foreground, '#112233');
});

test('upgrading a legacy brand image preserves its caption/credit pair and newly rejects only v3 publication', () => {
  const doc = createTemplate(); doc.schema_version = 2; doc.template.version = 2;
  doc.metadata.audience.job_title_ids = ['abcdefab-1234-4000-8000-000000000001'];
  const image = { id: 'abcdefab-1234-4000-8000-000000000002', type: 'image', media_id: 'abcdefab-1234-4000-8000-000000000003',
    alt: 'Alt', caption: 'Caption', credit: 'Credit', style: { font: 'manrope', scale: 'standard', align: 'start', palette: 'brand' } };
  doc.sections[0].rows[0].columns[0].blocks.push(image);
  const bytes = JSON.stringify(doc); validateDocument(doc, { publishing: true });
  const before = resolveAppearance(doc, image, 'caption'), next = upgradeDocument(doc), upgradedImage = allBlocks(next)[1];
  assert.equal(before.foreground, '#6C706D'); assert.equal(before.background, '#E8F1E9');
  assert.deepEqual(resolveAppearance(next, upgradedImage, 'caption'), before);
  assert.deepEqual(upgradedImage, image); assert.equal(JSON.stringify(doc), bytes);
  validateDocument(next);
  assert.throws(() => validateDocument(next, { publishing: true }), { status: 400, reason: 'color_contrast_required' });
  assert.equal(JSON.stringify(doc), bytes);
});

test('edit returns null for cancel, true-without-change, void no-op and reversible mutations, never upgrade alone', () => {
  for (const doc of [createTemplate(), createTemplate('owner-news'), referenceDocument()]) {
    const bytes = JSON.stringify(doc);
    for (const change of [() => false, () => true, () => {}, d => { const old = d.metadata.title; d.metadata.title = 'temp'; d.metadata.title = old; }, d => { d.metadata.title = 'cancelled'; return false; }]) {
      assert.equal(editV3(doc, change), null); assert.equal(JSON.stringify(doc), bytes);
    }
    const next = editV3(doc, d => { d.metadata.title = 'Changed'; });
    assert.equal(next.schema_version, 3); assert.equal(next.metadata.title, 'Changed'); assert.equal(JSON.stringify(doc), bytes);
    assert.throws(() => editV3(doc, d => { d.metadata.title = 'discarded'; throw new Error('stop'); }), /stop/); assert.equal(JSON.stringify(doc), bytes);
  }
});
