import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { referenceDocument, featureDocument, referenceIds, referenceMedia } from '../helpers/pages-reference-document.mjs';

const manifest = JSON.parse(await readFile(new URL('../fixtures/pages-reference/manifest.json', import.meta.url), 'utf8'));
const blocksOf = doc => doc.sections.flatMap(s => s.rows.flatMap(r => r.columns.flatMap(c => c.blocks)));
const plainText = node => node.text || (node.type === 'hard_break' ? '\n' : (node.content || []).map(plainText).join(''));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('fixture is isolated, stable and has the reference selection', () => {
  const a = referenceDocument(), b = referenceDocument();
  assert.deepEqual(a, b);
  a.metadata.title = 'Alterado';
  assert.notEqual(a.metadata.title, b.metadata.title);
  assert.equal(b.sections.length, 5);
  const blocks = b.sections.flatMap(s => s.rows.flatMap(r => r.columns.flatMap(c => c.blocks)));
  assert.ok(blocks.some(block => block.id === referenceIds.introductionBlock));
  assert.deepEqual(new Set(blocks.map(block => block.type)),
    new Set(['rich_text', 'audio', 'faq']));
  const features = blocksOf(featureDocument());
  assert.deepEqual(new Set(features.map(block => block.type)),
    new Set(['rich_text', 'image', 'audio', 'gallery', 'faq', 'button']));
});

test('visual geometry uses an empty gallery, aside_right and the four pictured icons', () => {
  const doc = referenceDocument();
  const gallery = doc.sections.find(s => s.id === referenceIds.gallerySection);
  assert.equal(gallery.rows.length, 1);
  assert.equal(gallery.rows[0].layout, 'single');
  assert.equal(gallery.rows[0].columns.length, 1);
  assert.deepEqual(gallery.rows[0].columns[0].blocks, []);
  const aside = doc.sections.find(s => s.id === referenceIds.faqSection).rows[0];
  assert.equal(aside.layout, 'aside_right');
  assert.deepEqual(aside.columns.map(c => c.blocks.map(b => b.id)), [[referenceIds.faqBlock], [referenceIds.audioBlock]]);
  const blocks = blocksOf(doc);
  for (const [blockId, icon] of [
    [referenceIds.coverBlock, 'shirt'], [referenceIds.dailyBlock, 'coffee'],
    [referenceIds.meetingsBlock, 'users'], [referenceIds.audioBlock, 'headphones'],
  ]) assert.equal(blocks.find(b => b.id === blockId).appearance.icon, icon);
});

test('feature fixture independently fills the same gallery IDs with explicit synthetic media references', () => {
  const visual = referenceDocument(), a = featureDocument(), b = featureDocument();
  assert.deepEqual(a, b);
  assert.deepEqual(a.metadata, visual.metadata);
  assert.deepEqual(a.sections.map(s => s.id), visual.sections.map(s => s.id));
  const galleryOf = doc => doc.sections.find(s => s.id === referenceIds.gallerySection);
  const gallery = galleryOf(a), emptyGallery = galleryOf(visual);
  const withoutFeatures = featureDocument();
  galleryOf(withoutFeatures).rows[0].columns[0].blocks = [];
  assert.deepEqual(withoutFeatures, visual);
  assert.equal(gallery.rows[0].id, emptyGallery.rows[0].id);
  assert.equal(gallery.rows[0].columns[0].id, emptyGallery.rows[0].columns[0].id);
  const blocks = gallery.rows[0].columns[0].blocks;
  assert.deepEqual(blocks.map(b => [b.id, b.type]), [
    [referenceIds.imageBlock, 'image'], [referenceIds.galleryBlock, 'gallery'], [referenceIds.guideButton, 'button'],
  ]);
  assert.deepEqual(blocks[2].action, { type: 'section', value: referenceIds.orientationsSection });
  assert.equal(blocks[1].items[0].id, referenceIds.galleryItem);
  const references = [blocks[0].media_id, blocks[1].items[0].media_id];
  assert.ok(references.length > 0);
  assert.ok(references.every(id => id === referenceIds.syntheticImageMedia));
  assert.ok(references.every(id => referenceMedia().some(media => media.id === id && media.synthetic === true)));
  const ids = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.id && value !== a.template) { assert.match(value.id, uuid); ids.push(value.id); }
    for (const child of Object.values(value)) visit(child);
  }
  visit(a);
  assert.equal(new Set(ids).size, ids.length);
  assert.doesNotMatch(JSON.stringify(a), /upload(ed|_complete|_status)|blob:|https?:|hidden|display:none/);
  a.metadata.tags.push('Alterado');
  blocks[1].items[0].alt = 'Alterado';
  blocksOf(a).find(b => b.id === referenceIds.introductionBlock).content.content[0].content[0].text = 'Alterado';
  gallery.rows[0].columns[0].blocks.push({ id: 'Alterado' });
  assert.deepEqual(featureDocument(), b);
  assert.deepEqual(referenceDocument(), visual);
  emptyGallery.rows[0].columns[0].blocks.push({ id: 'Mutação visual' });
  blocksOf(visual).find(b => b.id === referenceIds.introductionBlock).content.content[0].content[0].marks[0].type = 'Mutação visual';
  assert.deepEqual(featureDocument(), b);
  assert.ok(Buffer.byteLength(JSON.stringify(b)) < 1024 * 1024);
});

test('guide v3 fixes the approved metadata, defaults, copy and nested identities', () => {
  const doc = referenceDocument();
  assert.equal(doc.schema_version, 3);
  assert.deepEqual(doc.template, { id: 'guia-interno', version: 1 });
  assert.equal(doc.metadata.title, 'Código de vestimenta');
  assert.equal(doc.metadata.category, 'Pessoas e cultura');
  assert.ok(doc.metadata.category.length <= 80);
  assert.equal(doc.metadata.summary, 'Um guia para combinar conforto, identidade e cuidado no nosso dia a dia.');
  assert.deepEqual(doc.metadata.tags, ['Cultura', 'Guia']);
  assert.deepEqual(doc.metadata.audience, { type: 'job_titles', job_title_ids: [referenceIds.jobTitle] });
  assert.deepEqual(doc.presentation, { theme: 'conecta', defaults: {
    font: 'manrope', scale: 'standard', align: 'start', palette: 'conecta',
    foreground: '#26204A', background: '#FFFFFF', accent: '#E84F1C',
  } });
  assert.deepEqual(doc.sections.map(s => s.label), ['Capa', 'Introdução', 'Orientações', 'Galeria', 'Dúvidas frequentes']);
  const blocks = blocksOf(doc);
  const intro = blocks.find(b => b.id === referenceIds.introductionBlock);
  assert.equal(intro.appearance.foreground, '#2A275E');
  assert.deepEqual(intro.content.content[0].content[0].marks, [
    { type: 'strong' }, { type: 'text_color', attrs: { color: '#E84F1C' } },
  ]);
  assert.equal(plainText(intro.content.content[0]), 'Para cada momento, uma escolha');
  assert.equal(plainText(intro.content.content[1]), 'Este exemplo mostra como criar orientações claras sem começar do zero. Troque os textos, escolha as imagens e adapte cada seção à sua equipe.');
  assert.equal(plainText(blocks.find(b => b.id === referenceIds.coverBlock).content.content[0]), 'Vestir-se bem é\nsentir-se à vontade.');
  assert.deepEqual(doc.sections[2].rows.map(r => r.layout), ['two_equal']);
  assert.deepEqual(blocks.filter(b => b.type === 'faq')[0].items.map(i => i.question), [
    'Posso adaptar as orientações à minha rotina?', 'Onde encontro a política oficial?',
  ]);
  const ids = [];
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.id && value !== doc.template) { assert.match(value.id, uuid); ids.push(value.id); }
    for (const child of Object.values(value)) visit(child);
  }
  visit(doc);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of Object.values(referenceIds)) assert.match(id, uuid);
  for (const key of ['introductionSection', 'introductionBlock', 'faqItem']) assert.ok(ids.includes(referenceIds[key]));
  const fresh = referenceDocument();
  intro.content.content[0].content[0].text = 'Mutação profunda';
  blocks.find(b => b.type === 'faq').items[0].answer.content.push({ type: 'paragraph' });
  assert.equal(plainText(blocksOf(fresh).find(b => b.id === referenceIds.introductionBlock).content.content[0]), 'Para cada momento, uma escolha');
  assert.equal(blocksOf(fresh).find(b => b.type === 'faq').items[0].answer.content.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(fresh)) < 1024 * 1024);
  assert.ok(blocks.length < 100);
  assert.ok(doc.sections.flatMap(s => s.rows).length < 100);
  assert.doesNotMatch(JSON.stringify(fresh), /Owner News|sintético|não oficial/);
});

test('all rich text and FAQ answers use restricted ProseMirror nodes and marks', () => {
  function visit(node) {
    assert.ok(['doc', 'heading', 'paragraph', 'text', 'hard_break'].includes(node.type));
    if (node.type === 'heading') assert.ok([2, 3].includes(node.attrs.level));
    if (node.type === 'text') assert.equal(typeof node.text, 'string');
    for (const mark of node.marks || []) {
      assert.ok(['strong', 'text_color'].includes(mark.type));
      if (mark.type === 'text_color') assert.match(mark.attrs.color, /^#[0-9A-F]{6}$/);
    }
    for (const child of node.content || []) visit(child);
  }
  for (const block of [...blocksOf(referenceDocument()), ...blocksOf(featureDocument())]) {
    if (block.type === 'rich_text') visit(block.content);
    if (block.type === 'faq') for (const item of block.items) visit(item.answer);
  }
});

test('unpictured media and FAQ answers stay honest draft placeholders; synthetic bytes are opt-in', () => {
  const blocks = blocksOf(referenceDocument());
  const placeholders = blocks.flatMap(b => b.type === 'gallery' ? b.items : [b]).filter(b => 'media_id' in b);
  assert.equal(placeholders.length, 1);
  assert.ok(placeholders.every(b => b.media_id === null));
  assert.equal(blocks.find(b => b.type === 'audio').transcript, '');
  assert.equal(blocks.find(b => b.type === 'audio').title, 'Prefere ouvir?');
  assert.ok(blocks.find(b => b.type === 'faq').items.every(i => plainText(i.answer) === ''));
  const a = referenceMedia(), b = referenceMedia();
  assert.deepEqual(a, b);
  assert.equal(a.length, 1);
  assert.equal(a[0].id, referenceIds.syntheticImageMedia);
  assert.equal(a[0].kind, 'image');
  assert.equal(a[0].mime_type, 'image/png');
  assert.equal(a[0].file_name, 'synthetic-reference.png');
  assert.equal(a[0].synthetic, true);
  assert.ok(Buffer.isBuffer(a[0].bytes));
  assert.deepEqual([...a[0].bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(a[0].bytes.readUInt32BE(16), a[0].width);
  assert.equal(a[0].bytes.readUInt32BE(20), a[0].height);
  const idat = a[0].bytes.indexOf(Buffer.from('IDAT'));
  assert.ok(inflateSync(a[0].bytes.subarray(idat + 4, idat + 4 + a[0].bytes.readUInt32BE(idat - 4))).length > 0);
  a[0].bytes.fill(0);
  assert.notDeepEqual(a, b);
  assert.deepEqual(referenceMedia(), b);
});

test('manifest pins six original basenames, exact sizes, distinct states and measured geometry', () => {
  assert.equal(manifest.length, 6);
  assert.equal(new Set(manifest.map(e => e.id)).size, 6);
  assert.equal(new Set(manifest.map(e => e.sha256)).size, 6);
  assert.deepEqual(manifest.map(({ id, source, png }) => [id, source, png]), [
    ['editable-buttons', 'EDITOR V2 · Assets · Botões editáveis.svg', 'reference-1.png'],
    ['desktop-contextual', 'EDITOR V2 · Desktop · Edição contextual.svg', 'reference-2.png'],
    ['desktop-style', 'EDITOR V2 · Desktop · Estilo e cores.svg', 'reference-3.png'],
    ['desktop-insert', 'EDITOR V2 · Desktop · Inserir bloco.svg', 'reference-4.png'],
    ['desktop-review', 'EDITOR V2 · Desktop · Revisar publicação.svg', 'reference-5.png'],
    ['mobile-content', 'EDITOR V2 · Mobile · Painel inferior.svg', 'reference-6.png'],
  ]);
  assert.deepEqual(manifest.map(e => [e.width, e.height]), [[1600, 480], [1600, 1160], [1600, 1160], [1600, 1160], [1600, 1160], [390, 820]]);
  assert.deepEqual(manifest.map(e => e.state.panel), ['button-specimens', 'block', 'page-style', 'insert-block', 'review-publication', 'bottom-sheet']);
  for (const [index, entry] of manifest.entries()) {
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'source', 'png', 'width', 'height', 'sha256', 'state', 'regions', 'anchors'].sort());
    assert.equal(entry.png, `reference-${index + 1}.png`);
    for (const name of [entry.png, entry.source]) { assert.equal(basename(name), name); assert.doesNotMatch(name, /[/\\:]/); }
    assert.match(entry.source, /^EDITOR V2 · (Assets|Desktop|Mobile) · .+\.svg$/);
    assert.match(entry.sha256, /^[0-9a-f]{64}$/);
    assert.ok(entry.regions.length >= 3);
    assert.ok(entry.anchors.length >= 2);
    assert.equal(new Set(entry.regions.map(r => r.id)).size, entry.regions.length);
    for (const r of entry.regions) {
      assert.ok([r.x, r.y, r.width, r.height].every(Number.isFinite));
      assert.ok(r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0);
      assert.ok(r.x + r.width <= entry.width && r.y + r.height <= entry.height);
      assert.match(r.measurement, /^(rect|path) /);
    }
    for (const a of entry.anchors) {
      assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
      assert.ok(a.x >= 0 && a.x <= entry.width && a.y >= 0 && a.y <= entry.height);
      assert.match(a.measurement, /^(rect|path) /);
    }
    if (entry.state.device !== 'assets') {
      assert.equal(entry.state.selection.section, referenceIds.introductionSection);
      assert.equal(entry.state.selection.block, referenceIds.introductionBlock);
      assert.deepEqual(entry.state.scroll, { x: 0, y: 0 });
      assert.equal(entry.state.zoom, 100);
      assert.equal(entry.state.draft, 'saved-synthetic');
    }
  }
  const mobile = manifest.find(e => e.state.device === 'mobile');
  assert.equal(mobile.state.copyOverride.block, referenceIds.introductionBlock);
  assert.equal(mobile.state.copyOverride.paragraph, 1);
  assert.equal(mobile.state.copyOverride.text, 'Troque os textos e adapte cada seção à sua equipe.');
  assert.equal(mobile.state.headingColorOverride, '#2A275E');
  assert.deepEqual(manifest[1].regions.find(r => r.id === 'canvas'), {
    id: 'canvas', x: 248, y: 188, width: 1044, height: 944,
    measurement: 'rect transform=translate(248 188) width=1044 height=944',
  });
  assert.deepEqual(mobile.regions.find(r => r.id === 'bottom-sheet'), {
    id: 'bottom-sheet', x: 0, y: 431, width: 390, height: 389,
    measurement: 'path transform=translate(0 431) M0 389v-373 rounded top at y=0 width=390',
  });
});

async function checkExternalReference(directory, entry) {
  const bytes = await readFile(join(directory, entry.png));
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], entry.png);
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR', entry.png);
  assert.equal(bytes.readUInt32BE(16), entry.width, entry.png);
  assert.equal(bytes.readUInt32BE(20), entry.height, entry.png);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.png);
}

test('configured external references match all six actual PNG hashes and dimensions', {
  skip: !process.env.PAGES_REFERENCE_DIR && 'PAGES_REFERENCE_DIR absent: external fidelity NOT verified; no replacement golden is generated',
}, async () => {
  for (const entry of manifest) await checkExternalReference(process.env.PAGES_REFERENCE_DIR, entry);
});

test('a configured missing reference fails hard instead of accepting an implementation golden', async () => {
  await assert.rejects(checkExternalReference(fileURLToPath(new URL('../fixtures/pages-reference/', import.meta.url)), {
    ...manifest[0], png: 'deliberately-missing-reference.png',
  }), { code: 'ENOENT' });
});
