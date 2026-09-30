import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const server = require('../../api/owner-news/editorial');
const backend = require('../../api/cms/blocks');
const loadModule = source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const browser = await loadModule(await readFile('public/js/owner-news/model.js', 'utf8'));
const frontend = await loadModule((await readFile('public/js/cms-block-renderer.js', 'utf8'))
  .replace(/^import .*;\r?\n/gm, ''));
const { normalizeEditorBlocks } = await loadModule(await readFile('public/js/cms-editor-values.js', 'utf8'));
const asset = '11111111-1111-4111-8111-111111111111';
const meta = { version: 1, kind: 'article', summary: 'Chamada.', author: 'Redação',
  source_label: 'Edição 4 · Maio de 2026', source_date: null };
const paragraph = { type: 'paragraph', text: 'Corpo.' };
const image = { type: 'image', asset_id: asset, alt: 'Retrato' };
const pdf = { type: 'pdf', asset_id: asset, title: 'Documento' };

test('editorial normalization has identical strict civil-date and plain-text contracts', () => {
  for (const model of [server, browser]) {
    assert.deepEqual(model.normalizeEditorial(meta), meta);
    assert.deepEqual(model.normalizeEditorial({ ...meta, author: ' ', summary: ' Chamada. ' }), { ...meta, author: '' });
    assert.equal(model.normalizeEditorial({ ...meta, source_date: '2024-02-29' }).source_date, '2024-02-29');
    for (const value of [null, undefined, [], {}, { ...meta, version: '1' }, { ...meta, kind: 'other' },
      { ...meta, source_date: '2026-02-29' }, { ...meta, source_date: '2026-04-31' },
      { ...meta, source_date: '2026-05' }, { ...meta, source_date: '2026-05-01T00:00:00Z' },
      { ...meta, author: 'Nome\nCargo' }, { ...meta, source_label: 'x'.repeat(201) },
      { ...meta, author: 'x'.repeat(201) }, { ...meta, summary: 'x'.repeat(1001) },
      { ...meta, summary: '<script' }, { ...meta, summary: '<b>Texto</b>' },
      { ...meta, summary: 'onclick=alert(1)' }, { ...meta, asset_id: asset }]) {
      assert.equal(model.normalizeEditorial(value), null, JSON.stringify(value));
    }
  }
});

test('both block validators preserve flat references, declarative attributes and legacy absence', () => {
  const fixtures = [paragraph, image, pdf,
    { ...paragraph, typography: 'sans', layout: 'wide' },
    { type: 'quote', text: 'Citação.', attribution: 'Pessoa', typography: 'serif', layout: 'full' },
    { type: 'profile', name: 'Pessoa', role: 'Cargo', text: 'Biografia.', asset_id: asset, alt: 'Retrato', layout: 'left' },
    { type: 'profile', name: 'Pessoa' },
    { ...image, usage: 'cover', caption: 'Legenda', credit: 'Crédito', layout: 'right' },
    { ...pdf, usage: 'edition', layout: 'content' }];
  assert.deepEqual(backend.validateBlocks(fixtures), fixtures);
  assert.deepEqual(frontend.validateBlocks(fixtures), fixtures);
  for (const invalid of [{ ...paragraph, typography: 'Comic Sans' }, { ...image, typography: 'serif' },
    { ...paragraph, layout: 'position:fixed' }, { ...paragraph, layout: null },
    { ...paragraph, html: '<script>x</script>' }, { ...paragraph, text: '<script' },
    { ...image, caption: 'x'.repeat(1001) }, { ...image, credit: 'x'.repeat(301) },
    { ...image, caption: '' }, { ...image, usage: 'edition' }, { ...pdf, usage: 'cover' },
    { type: 'profile', name: 'Pessoa', asset_id: asset }, { type: 'profile', name: 'Pessoa', alt: 'Retrato' },
    { type: 'profile', name: 'Pessoa', asset_id: 'bad', alt: 'Retrato' },
    { type: 'profile', name: 'Pessoa', role: '' }, { type: 'profile', name: 'Pessoa', role: 'a\nb' },
    { type: 'profile', name: 'Pessoa', text: 'x'.repeat(5001) },
    { type: 'quote', text: '' }, { type: 'quote', text: 'Texto', attribution: '' },
    { type: 'quote', text: 'Texto', attribution: 'a\nb' }, { type: 'quote', text: 'Texto', extra: true }]) {
    assert.equal(backend.validateBlocks([invalid]), null, JSON.stringify(invalid));
    assert.equal(frontend.validateBlocks([invalid]), null, JSON.stringify(invalid));
  }
  const text = [{ type: 'quote', text: 'Citação.' }, { type: 'profile', name: 'Pessoa', text: 'Biografia.' }];
  assert.equal(backend.blocksToText(text), 'Citação.\n\nBiografia.');
  assert.equal(frontend.blocksToText(text), backend.blocksToText(text));
});

test('editor removes empty optional text without mutating drafts or hiding invalid enum values', () => {
  const input = [{ ...image, caption: ' ', credit: '' }, { type: 'quote', text: 'Texto', attribution: '' },
    { type: 'profile', name: 'Pessoa', role: '', text: ' ', asset_id: '', alt: '' }];
  const copy = structuredClone(input);
  assert.deepEqual(normalizeEditorBlocks(input), [image, { type: 'quote', text: 'Texto' }, { type: 'profile', name: 'Pessoa' }]);
  assert.deepEqual(input, copy);
  assert.deepEqual(normalizeEditorBlocks([{ type: 'toString' }]), [{ type: 'toString' }]);
  assert.equal(backend.validateBlocks(normalizeEditorBlocks([{ ...paragraph, layout: '' }])), null);
  assert.equal(backend.validateBlocks(normalizeEditorBlocks([{ type: 'profile', name: 'Pessoa', asset_id: asset, alt: '' }])), null);
});

test('publication requires native body and summary or an edition PDF, while null remains legacy', () => {
  const { validateNewsRevision: validate } = server;
  assert.ok(validate([], meta));
  assert.ok(validate([paragraph], null, { publishing: true }));
  assert.equal(validate([paragraph], undefined), null);
  assert.equal(validate([], meta, { publishing: true }), null);
  assert.equal(validate([paragraph], { ...meta, summary: '' }, { publishing: true }), null);
  for (const block of [paragraph, { type: 'quote', text: 'Texto' }, { type: 'profile', name: 'Pessoa', text: 'Bio' }, { type: 'list', items: ['Item'] }]) {
    assert.ok(validate([block], meta, { publishing: true }));
  }
  assert.equal(validate([{ type: 'heading', text: 'Título' }, image], meta, { publishing: true }), null);
  assert.equal(validate([paragraph], { ...meta, kind: 'edition' }, { publishing: true }), null);
  assert.ok(validate([pdf], { ...meta, kind: 'edition' }, { publishing: true }));
  assert.equal(validate([{ ...image, usage: 'cover' }, { ...image, usage: 'cover' }], meta), null);
  assert.equal(validate([{ ...pdf, usage: 'edition' }, { ...pdf, usage: 'edition' }], null), null);
});

test('combined normalized blocks and editorial enforce the exact 5 MiB UTF-8 boundary', () => {
  const blocks = Array.from({ length: 35 }, () => ({ type: 'list', ordered: false,
    items: Array.from({ length: 100 }, () => '界'.repeat(498)) }));
  const max = 5 * 1024 * 1024;
  const bytes = Buffer.byteLength(JSON.stringify({ blocks, editorial: meta }));
  // Fill with a valid extra paragraph to land exactly on the aggregate byte limit.
  blocks.push({ type: 'paragraph', text: 'a'.repeat(max - bytes - 31) });
  assert.equal(Buffer.byteLength(JSON.stringify({ blocks, editorial: meta })), max);
  assert.ok(server.validateNewsRevision(blocks, meta));
  assert.equal(server.validateNewsRevision(blocks, { ...meta, summary: `${meta.summary}a` }), null);
});

test('reading estimates share fixtures and exclude media, metadata and PDF titles', () => {
  const blocks = [{ type: 'paragraph', text: 'palavra '.repeat(401) }, { ...pdf, usage: 'edition' }];
  for (const model of [server, browser]) {
    assert.equal(model.estimateNewsReadTime(blocks, meta), 3);
    assert.equal(model.estimateNewsReadTime(blocks, { ...meta, kind: 'edition' }), null);
    assert.equal(model.estimateNewsReadTime(blocks, null), null);
    assert.equal(model.estimateNewsReadTime([image], meta), null);
    assert.equal(model.estimateNewsReadTime([{ type: 'quote', text: 'a '.repeat(200) }, { type: 'profile', name: 'Nome', text: 'b' }], meta), 2);
    assert.equal(model.estimateNewsReadTime([{ type: 'list', items: ['Um', 'Dois'] }], meta), 1);
  }
  assert.equal(server.announcementKind({ content_blocks: [pdf] }), 'edition');
  assert.equal(server.announcementKind({ blocks: [paragraph] }), 'article');
  assert.equal(server.announcementKind({ blocks: [pdf], editorial: meta }), 'article');
});

test('presentation only removes explicit cover and companion and never infers authorship', () => {
  const cover = { ...image, usage: 'cover' };
  const companion = { ...pdf, usage: 'edition' };
  assert.deepEqual(browser.getNewsPresentation({ content_blocks: [cover, paragraph, companion], editorial: meta }), {
    cover, body: [paragraph], companion, summary: meta.summary, author: meta.author,
    sourceLabel: meta.source_label, sourceDate: null,
  });
  const legacy = browser.getNewsPresentation({ content_blocks: [image, { ...paragraph, text: 'Por Pessoa' }, pdf] });
  assert.equal(legacy.cover, image);
  assert.equal(legacy.body.length, 3);
  assert.equal(legacy.author, 'Owner News');
  assert.equal(legacy.summary, 'Por Pessoa');
  assert.equal(browser.getNewsPresentation({ content_blocks: [image], editorial: { ...meta, author: '' } }).cover, null);
  assert.equal(browser.getNewsPresentation({}).author, 'Owner News');
});
