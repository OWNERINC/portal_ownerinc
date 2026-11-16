import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { featureDocument, referenceDocument, referenceIds } from '../helpers/pages-reference-document.mjs';

const require = createRequire(import.meta.url);
const { validateDocument, PagesError } = require('../../api/pages/validation');
const { createTemplate } = require('../../api/pages/templates');
const id = n => `abcdefab-1234-4000-8000-${n.toString(16).padStart(12, '0')}`;
const prose = (text = '') => ({ type: 'doc', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] });
const allBlocks = doc => doc.sections.flatMap(s => s.rows.flatMap(r => r.columns.flatMap(c => c.blocks)));
const find = (doc, type) => allBlocks(doc).find(block => block.type === type);
const column = doc => doc.sections[0].rows[0].columns[0];
const add = (doc, block) => { column(doc).blocks.push(block); return block; };
function minimal(...blocks) {
  const doc = featureDocument();
  doc.sections = [doc.sections[0]];
  column(doc).blocks = blocks;
  return doc;
}
const button = action => ({ id: id(1), type: 'button', label: 'Abrir', preset: 'primary', action });
const gallery = () => ({ id: id(2), type: 'gallery', items: [{ id: id(3), kind: 'image', media_id: id(4), alt: 'Descrição', caption: '', credit: '' }] });
const faq = () => ({ id: id(5), type: 'faq', items: [{ id: id(6), question: 'Pergunta?', answer: prose('Resposta') }] });
const embed = () => ({ id: id(7), type: 'video_embed', provider: 'youtube', video_id: 'aB3_-dE6Fg7', title: 'Vídeo', transcript: 'Transcrição' });
const media = type => ({ id: id(8), type, media_id: id(9), title: 'Título', transcript: 'Transcrição', ...(type === 'video' ? { captions: [{ start_ms: 0, end_ms: 1000, text: 'Legenda' }] } : {}) });
const invalid = (doc, options, reason) => assert.throws(() => validateDocument(doc, options), error =>
  error instanceof PagesError && error.status === 400 && (!reason || error.reason === reason));
function rejectChanges(make, changes, options) {
  for (const change of changes) { const doc = make(); change(doc); invalid(doc, options); }
}

test('v3 projects private gallery and download references, not null placeholders', () => {
  const doc = featureDocument();
  add(doc, button({ type: 'download', media_id: id(90), kind: 'audio', file_name: 'guia.mp3' }));
  const original = structuredClone(doc);
  const value = validateDocument(doc);
  assert.equal(value.document.schema_version, 3);
  assert.equal(new Set(value.mediaIds).size, value.mediaIds.length);
  assert.deepEqual(value.mediaIds, [id(90), referenceIds.syntheticImageMedia]);
  assert.equal(value.mediaRefs.length, 3);
  assert.ok(value.mediaRefs.every(ref => ['image', 'gif', 'audio', 'video'].includes(ref.kind)));
  assert.deepEqual(value.jobTitleIds, doc.metadata.audience.job_title_ids);
  assert.deepEqual(doc, original);
  assert.notEqual(value.document, doc);
  assert.throws(() => validateDocument({ ...doc, extra: true }), { reason: 'invalid_document' });
  assert.doesNotThrow(() => validateDocument(referenceDocument()));
});

test('v3 accepts exactly the approved schema/template pairs and empty category has no authorization effect', () => {
  for (const [name, version] of [['comunicado', 3], ['owner-news', 2], ['guia-interno', 1]]) {
    const doc = minimal({ id: id(1), type: 'rich_text', content: prose('Conteúdo') });
    doc.template = { id: name, version }; doc.metadata.category = '';
    assert.deepEqual(validateDocument(doc, { publishing: true }).jobTitleIds, doc.metadata.audience.job_title_ids);
    doc.metadata.audience.job_title_ids = [];
    invalid(doc, { publishing: true }, 'publication_incomplete');
  }
  rejectChanges(featureDocument, [d => { d.schema_version = '3'; }, d => { d.schema_version = 4; },
    d => { d.template.version = 2; }, d => { d.template = { id: 'owner-news', version: 1 }; },
    d => { d.template = { id: 'comunicado', version: 2 }; }, d => { d.template.id = 'other'; }]);
});

test('v3 rejects null/string/array shape confusion and strict unknown keys as PagesError400', () => {
  for (const value of [null, undefined, 'document', [], 3, true]) invalid(value);
  const circular = featureDocument(); circular.extra = circular; invalid(circular);
  rejectChanges(featureDocument, [
    d => { d.template = null; }, d => { d.metadata = 'x'; }, d => { d.presentation = []; },
    d => { d.metadata.audience = null; }, d => { d.presentation.defaults = null; },
    d => { d.sections = [null]; }, d => { d.sections[0].rows = ['x']; },
    d => { d.sections[0].rows[0].columns = [null]; }, d => { column(d).blocks = [null]; },
    d => { d.template.extra = true; }, d => { d.metadata.extra = true; },
    d => { d.metadata.audience.extra = true; }, d => { d.presentation.extra = true; },
    d => { d.presentation.defaults.extra = true; }, d => { d.sections[0].extra = true; },
    d => { d.sections[0].rows[0].extra = true; }, d => { column(d).extra = true; },
    d => { find(d, 'rich_text').html = '<p>no</p>'; },
  ]);
});

test('v3 metadata has strict text, tag and audience bounds', () => {
  rejectChanges(featureDocument, [
    d => { delete d.metadata.category; }, d => { d.metadata.category = null; }, d => { d.metadata.category = 'x'.repeat(81); },
    d => { d.metadata.title = 'x'.repeat(201); }, d => { d.metadata.summary = 'x'.repeat(1001); },
    d => { d.metadata.title = '\0'; }, d => { d.metadata.tags = null; },
    d => { d.metadata.tags = Array.from({ length: 21 }, (_, i) => `${i}`); },
    d => { d.metadata.tags = ['', 'valid']; }, d => { d.metadata.tags = ['  ']; },
    d => { d.metadata.tags = ['a', 'a']; }, d => { d.metadata.tags = ['x'.repeat(41)]; },
    d => { d.metadata.tags = [1]; }, d => { d.metadata.audience.type = 'all'; },
    d => { d.metadata.audience.job_title_ids = [id(1), id(1).toUpperCase()]; },
    d => { d.metadata.audience.job_title_ids = [null]; },
    d => { d.metadata.audience.job_title_ids = Array.from({ length: 101 }, (_, i) => id(i)); },
  ]);
  const doc = minimal();
  Object.assign(doc.metadata, { title: 'x'.repeat(200), summary: 'x'.repeat(1000), category: 'x'.repeat(80), tags: Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(40, 'x')) });
  doc.metadata.audience.job_title_ids = Array.from({ length: 100 }, (_, i) => id(i));
  validateDocument(doc);
});

test('v3 normalizes all graph/item/reference/audience UUIDs and hex colors without touching text or input', () => {
  const doc = minimal(faq(), gallery(), embed(), button({ type: 'video', value: id(7).toUpperCase() }));
  doc.metadata.title = id(77).toUpperCase();
  doc.metadata.audience.job_title_ids = [id(88).toUpperCase()];
  doc.presentation.defaults.accent = '#ab12ef';
  find(doc, 'faq').appearance = { foreground: '#abcdef', background: 'none', accent: '#aabbcc' };
  find(doc, 'faq').items[0].answer.content[0].content[0].marks = [
    { type: 'text_color', attrs: { color: '#abcdef' } }, { type: 'highlight', attrs: { color: '#aabbcc' } },
  ];
  for (const s of doc.sections) { s.id = s.id.toUpperCase(); for (const r of s.rows) { r.id = r.id.toUpperCase(); for (const c of r.columns) {
    c.id = c.id.toUpperCase(); for (const b of c.blocks) { b.id = b.id.toUpperCase(); for (const item of b.items || []) { item.id = item.id.toUpperCase(); if (item.media_id) item.media_id = item.media_id.toUpperCase(); } }
  } } }
  const original = structuredClone(doc), result = validateDocument(doc), normalized = result.document;
  assert.deepEqual(doc, original);
  assert.equal(normalized.metadata.title, doc.metadata.title);
  assert.equal(normalized.presentation.defaults.accent, '#AB12EF');
  assert.deepEqual(find(normalized, 'faq').appearance, { foreground: '#ABCDEF', background: 'none', accent: '#AABBCC' });
  assert.deepEqual(find(normalized, 'faq').items[0].answer.content[0].content[0].marks.map(m => m.attrs.color), ['#ABCDEF', '#AABBCC']);
  assert.equal(find(normalized, 'button').action.value, id(7));
  assert.deepEqual(result.mediaIds, [id(4)]);
  assert.deepEqual(result.jobTitleIds, [id(88)]);
  for (const s of normalized.sections) { assert.equal(s.id, s.id.toLowerCase()); for (const r of s.rows) { assert.equal(r.id, r.id.toLowerCase()); for (const c of r.columns) {
    assert.equal(c.id, c.id.toLowerCase()); for (const b of c.blocks) { assert.equal(b.id, b.id.toLowerCase()); for (const item of b.items || []) assert.equal(item.id, item.id.toLowerCase()); }
  } } }
  const refs = minimal(media('audio'), button({ type: 'download', media_id: id(9).toUpperCase(), kind: 'audio', file_name: 'a.mp3' }));
  find(refs, 'audio').media_id = id(9).toUpperCase();
  const value = validateDocument(refs);
  assert.equal(find(value.document, 'audio').media_id, id(9));
  assert.equal(find(value.document, 'button').action.media_id, id(9));
  assert.deepEqual(value.mediaIds, [id(9)]);
});

test('v3 appearance and defaults use closed enums and solid hex only; callout icon remains independent', () => {
  const doc = minimal({ id: id(1), type: 'callout', tone: 'success', icon: 'check', content: prose('Ok') });
  for (const icon of ['none', 'info', 'alert', 'check', 'arrow', 'download', 'play', 'upload', 'coffee', 'users', 'headphones', 'shirt']) {
    column(doc).blocks[0].appearance = { icon }; validateDocument(doc);
  }
  for (const font of ['manrope', 'source-serif-4', 'oswald']) {
    doc.presentation.defaults.font = font;
    column(doc).blocks[0].style = { font, align: 'end', scale: 'large', palette: 'warm' };
    column(doc).blocks[0].appearance = { font, align: 'center', scale: 'small', foreground: '#ffffff', background: 'none', accent: '#000000' };
    validateDocument(doc);
  }
  for (const palette of ['conecta', 'editorial', 'neutro']) { doc.presentation.defaults.palette = palette; validateDocument(doc); }
  rejectChanges(featureDocument, [
    d => { d.presentation.theme = 'other'; }, d => { d.presentation.defaults.font = 'serif'; },
    d => { d.presentation.defaults.scale = 1; }, d => { d.presentation.defaults.align = 'left'; },
    d => { d.presentation.defaults.palette = 'brand'; }, d => { delete d.presentation.defaults.accent; },
    ...['red', '#fff', '#000000ff', '#abcdef\n', 'url(https://evil.test)', '#abcdef;display:none', '<style>', 'none', null].map(color => d => { d.presentation.defaults.foreground = color; }),
    d => { find(d, 'rich_text').appearance = null; }, d => { find(d, 'rich_text').appearance = { extra: 1 }; },
    d => { find(d, 'rich_text').appearance = { icon: 'html' }; }, d => { find(d, 'rich_text').appearance = { foreground: 'none' }; },
    d => { find(d, 'rich_text').style = { align: 'start' }; },
    d => { find(d, 'rich_text').style = { font: 'manrope', align: 'start', scale: 'standard', palette: 'conecta' }; },
    d => { find(d, 'rich_text').tags = ['same', 'same']; }, d => { find(d, 'rich_text').tags = ['x'.repeat(41)]; },
  ]);
  column(doc).blocks[0].icon = 'coffee'; invalid(doc);
});

test('v3 sidebar layout requires exactly two columns and all graph/item IDs are globally unique case-insensitively', () => {
  rejectChanges(featureDocument, [
    d => { d.sections[0].rows[0].layout = 'aside_right'; }, d => { d.sections[0].rows[0].layout = 'two_equal'; },
    d => { d.sections[0].rows[0].layout = 'aside_left'; }, d => { d.sections[0].rows[0].id = d.sections[0].id.toUpperCase(); },
    d => { find(d, 'gallery').items[0].id = find(d, 'faq').items[0].id.toUpperCase(); },
    d => { find(d, 'faq').items[0].id = find(d, 'image').id.toUpperCase(); },
    d => { find(d, 'gallery').items[0].id = 'not-uuid'; }, d => { column(d).id = null; },
    d => { column(d).id += '\n'; }, d => { find(d, 'image').media_id += '\n'; },
    d => { d.metadata.audience.job_title_ids[0] += '\n'; },
    d => { find(d, 'button').action.value += '\n'; },
  ]);
  const doc = minimal(gallery(), button({ type: 'section', value: referenceIds.coverSection.toUpperCase() }));
  assert.equal(find(validateDocument(doc).document, 'button').action.value, referenceIds.coverSection);
});

test('v3 gallery validates kinds, strict item shape and limits; empty/null placeholders are draft-only', () => {
  const doc = minimal(gallery(), { id: id(88), type: 'rich_text', content: prose('Content') });
  validateDocument(doc, { publishing: true });
  find(doc, 'gallery').items = []; validateDocument(doc); invalid(doc, { publishing: true });
  rejectChanges(() => minimal(gallery()), [
    d => { find(d, 'gallery').items = null; }, d => { find(d, 'gallery').items = [null]; },
    d => { find(d, 'gallery').items[0].kind = 'video'; }, d => { find(d, 'gallery').items[0].extra = true; },
    d => { find(d, 'gallery').items[0].media_id = 'url'; }, d => { find(d, 'gallery').items[0].alt = 'x'.repeat(301); },
    d => { find(d, 'gallery').items[0].caption = 'x'.repeat(1001); }, d => { find(d, 'gallery').items[0].credit = 'x'.repeat(301); },
    d => { const item = find(d, 'gallery').items[0]; find(d, 'gallery').items = Array.from({ length: 51 }, (_, i) => ({ ...item, id: id(100 + i) })); },
  ]);
  const fifty = minimal(gallery());
  const item = find(fifty, 'gallery').items[0];
  find(fifty, 'gallery').items = Array.from({ length: 50 }, (_, i) => ({ ...item, id: id(100 + i), kind: i % 2 ? 'image' : 'gif' }));
  assert.equal(validateDocument(fifty).mediaRefs.length, 50);
  find(doc, 'gallery').items = [{ ...item, media_id: null }];
  assert.deepEqual(validateDocument(doc).mediaRefs, []); invalid(doc, { publishing: true }, 'media_not_ready');
  find(doc, 'gallery').items[0].media_id = id(4); find(doc, 'gallery').items[0].alt = ' ';
  invalid(doc, { publishing: true }, 'image_alt_required');
});

test('v3 FAQ answers are meaningful publication content; every published item must be complete', () => {
  validateDocument(minimal(faq()), { publishing: true });
  const doc = minimal(faq());
  find(doc, 'faq').items[0].question = ''; validateDocument(doc); invalid(doc, { publishing: true });
  find(doc, 'faq').items[0].question = '?'; find(doc, 'faq').items[0].answer = prose();
  add(doc, { id: id(88), type: 'rich_text', content: prose('Other content must not hide incomplete answer') });
  validateDocument(doc); invalid(doc, { publishing: true });
  find(doc, 'faq').items = []; validateDocument(doc); invalid(doc, { publishing: true });
  rejectChanges(() => minimal(faq()), [
    d => { find(d, 'faq').items = [null]; }, d => { find(d, 'faq').items[0].question = 'x'.repeat(201); },
    d => { find(d, 'faq').items[0].answer = null; }, d => { find(d, 'faq').items[0].answer = prose(); find(d, 'faq').items[0].answer.extra = 1; },
    d => { find(d, 'faq').items[0].extra = true; }, d => { find(d, 'faq').items[0].answer = { type: 'paragraph' }; },
    d => { const item = find(d, 'faq').items[0]; find(d, 'faq').items = Array.from({ length: 51 }, (_, i) => ({ ...item, id: id(100 + i) })); },
  ]);
});

test('v3 YouTube embed uses identity only, never raw URLs/HTML/providers; publishing needs title and transcript', () => {
  validateDocument(minimal(embed(), { id: id(88), type: 'rich_text', content: prose('Content') }), { publishing: true });
  rejectChanges(() => minimal(embed()), [
    ...['https://youtube.com/watch?v=aB3_-dE6Fg7', 'https://youtube.com.evil.test/watch?v=aB3_-dE6Fg7', 'javascript:alert(1)', '<iframe>', 'aB3_-dE6Fg', 'aB3_-dE6Fg78', 'aB3_-dE6Fg!', 'aB3_-dE6Fg7\n'].map(value => d => { find(d, 'video_embed').video_id = value; }),
    ...['YouTube', 'youtube.com.evil.test', '<iframe>', 'url(youtube)', null].map(value => d => { find(d, 'video_embed').provider = value; }),
    d => { find(d, 'video_embed').url = 'https://youtube.com'; }, d => { find(d, 'video_embed').title = 'x'.repeat(201); },
    d => { find(d, 'video_embed').transcript = 'x'.repeat(20001); },
  ]);
  for (const field of ['title', 'transcript']) { const doc = minimal(embed()); find(doc, 'video_embed')[field] = ' '; validateDocument(doc); invalid(doc, { publishing: true }); }
});

test('v3 button targets resolve after traversal, require correct target kind and reject all extra action keys', () => {
  for (const target of [embed(), media('video')]) {
    const doc = minimal(button({ type: 'video', value: target.id.toUpperCase() }), target);
    assert.equal(find(validateDocument(doc).document, 'button').action.value, target.id);
  }
  for (const value of ['https://example.test/path', '/pages.html?id=123#section']) validateDocument(minimal(button({ type: 'url', value })));
  rejectChanges(() => minimal(button({ type: 'url', value: '/' })), [
    d => { find(d, 'button').destination = { type: 'url', value: '/' }; }, d => { delete find(d, 'button').action; },
    d => { find(d, 'button').action = null; }, d => { find(d, 'button').action = { type: 'upload', value: '/' }; },
    d => { find(d, 'button').action.extra = true; }, d => { find(d, 'button').action.media_id = id(4); },
    ...['javascript:alert(1)', '//evil.test', 'http://evil.test', '/\\evil.test', 'https://u:p@evil.test', '/a\nb'].map(value => d => { find(d, 'button').action.value = value; }),
    d => { find(d, 'button').label = ' '; }, d => { find(d, 'button').label = 'x'.repeat(121); }, d => { find(d, 'button').preset = 'custom'; },
    d => { find(d, 'button').action = { type: 'section', value: id(44) }; },
    d => { find(d, 'button').action = { type: 'section', value: find(d, 'button').id }; },
    d => { find(d, 'button').action = { type: 'video', value: referenceIds.coverSection }; },
    d => { find(d, 'button').action = { type: 'video', value: id(44) }; },
    d => { add(d, media('audio')); find(d, 'button').action = { type: 'video', value: id(8) }; },
  ]);
});

test('v3 downloads project each kind and reject hostile filenames, extension mismatch and placeholders', () => {
  const extensions = { image: 'webp', gif: 'gif', audio: 'mp3', video: 'mp4' };
  for (const [kind, ext] of Object.entries(extensions)) {
    const result = validateDocument(minimal(button({ type: 'download', media_id: id(4).toUpperCase(), kind, file_name: `guia.${ext}` })));
    assert.deepEqual(result.mediaRefs, [{ id: id(4), kind }]);
  }
  const make = () => minimal(button({ type: 'download', media_id: id(4), kind: 'image', file_name: 'guia.webp' }));
  rejectChanges(make, [
    ...['../guia.webp', 'path/guia.webp', 'path\\guia.webp', 'guia\r\n.webp', 'a\u007f.webp', 'a\0.webp', 'guia.png', 'guia.WEBP', 'guia.webp.exe', '', 'x'.repeat(121)].map(value => d => { find(d, 'button').action.file_name = value; }),
    d => { find(d, 'button').action.media_id = null; }, d => { find(d, 'button').action.kind = 'document'; },
    d => { find(d, 'button').action.value = '/'; }, d => { delete find(d, 'button').action.file_name; },
  ]);
  const doc = minimal(gallery(), button({ type: 'download', media_id: id(4), kind: 'audio', file_name: 'a.mp3' }));
  assert.deepEqual(validateDocument(doc).mediaRefs, [{ id: id(4), kind: 'image' }, { id: id(4), kind: 'audio' }]);
  assert.deepEqual(validateDocument(doc).mediaIds, [id(4)]);
});

test('v3 private image/gif/audio/video placeholders never create references and never publish', () => {
  for (const type of ['image', 'gif', 'audio', 'video']) {
    const block = ['image', 'gif'].includes(type) ? { id: id(8), type, media_id: id(9), alt: 'Alt', caption: '', credit: '' } : media(type);
    const doc = minimal({ id: id(1), type: 'rich_text', content: prose('Content') }, block);
    assert.deepEqual(validateDocument(doc, { publishing: true }).mediaRefs, [{ id: id(9), kind: type }]);
    block.media_id = null; assert.deepEqual(validateDocument(doc).mediaRefs, []); invalid(doc, { publishing: true }, 'media_not_ready');
    for (const value of ['', undefined, 'https://evil.test/file']) { block.media_id = value; invalid(doc); }
  }
});

test('v3 private media accessibility and cue bounds remain strict', () => {
  for (const type of ['audio', 'video']) {
    const doc = minimal({ id: id(1), type: 'rich_text', content: prose('Content') }, media(type));
    find(doc, type).transcript = ''; validateDocument(doc); invalid(doc, { publishing: true }, 'media_accessibility_required');
  }
  rejectChanges(() => minimal(media('video')), [
    d => { find(d, 'video').captions = null; }, d => { find(d, 'video').captions = [null]; },
    d => { find(d, 'video').captions = Array(501).fill({ start_ms: 0, end_ms: 1, text: '' }); },
    d => { find(d, 'video').captions[0].start_ms = -1; }, d => { find(d, 'video').captions[0].end_ms = 0; },
    d => { find(d, 'video').captions[0].end_ms = 120001; }, d => { find(d, 'video').captions[0].end_ms = 1.5; },
    d => { find(d, 'video').captions[0].extra = true; }, d => { find(d, 'video').captions[0].text = '<b>bad</b>'; },
    d => { find(d, 'video').captions[0].text = '-->'; }, d => { find(d, 'video').captions[0].text = 'x'.repeat(1001); },
    d => { find(d, 'video').captions.push({ start_ms: 999, end_ms: 2000, text: 'Overlap' }); },
  ]);
  const doc = minimal(media('video')); find(doc, 'video').captions = [];
  validateDocument(doc); invalid(doc, { publishing: true }, 'media_accessibility_required');
});

test('v3 restricted PM permits six unique safe marks, normalizes colors and rejects arbitrary attrs/keys', () => {
  const make = () => minimal({ id: id(1), type: 'rich_text', content: prose('Text') });
  const marked = d => find(d, 'rich_text').content.content[0].content[0];
  const doc = make(); marked(doc).marks = [{ type: 'strong' }, { type: 'em' }, { type: 'underline' }, { type: 'link', attrs: { href: '/' } }, { type: 'text_color', attrs: { color: '#abcdef' } }, { type: 'highlight', attrs: { color: '#123abc' } }];
  validateDocument(doc);
  rejectChanges(make, [
    ...[null, 'strong', [null], [{ type: 'strong' }, { type: 'strong' }], [{ type: 'strike' }], [{ type: 'strong', attrs: {} }], [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }], [{ type: 'text_color', attrs: null }], [{ type: 'highlight', attrs: { color: 'url(https://evil.test)' } }], [{ type: 'text_color', attrs: { color: '#fff', extra: 1 } }], [{ type: 'strong', extra: true }], Array.from({ length: 7 }, () => ({ type: 'strong' }))].map(value => d => { marked(d).marks = value; }),
    d => { marked(d).attrs = {}; }, d => { marked(d).content = []; }, d => { marked(d).text = ''; },
    d => { find(d, 'rich_text').content.content = [null]; }, d => { find(d, 'rich_text').content.content = ['text']; },
    d => { find(d, 'rich_text').content.content[0].attrs = {}; },
    d => { find(d, 'rich_text').content.content = [{ type: 'heading', attrs: { level: 1 } }]; },
    d => { find(d, 'rich_text').content.content = [{ type: 'ordered_list', attrs: { order: 100001 }, content: [{ type: 'list_item', content: [{ type: 'paragraph' }] }] }]; },
    d => { find(d, 'rich_text').content.content = [{ type: 'image', attrs: { src: '/' } }]; },
    d => { find(d, 'rich_text').content = { type: 'doc', content: [] }; },
  ]);
  const list = child => ({ type: 'bullet_list', content: [{ type: 'list_item', content: [{ type: 'paragraph' }, ...(child ? [child] : [])] }] });
  find(doc, 'rich_text').content.content = [list(list())]; validateDocument(doc);
  find(doc, 'rich_text').content.content = [list(list(list()))]; invalid(doc);
});

test('v3 global char budgets aggregate FAQ, questions, category, tags, gallery, marks and captions', () => {
  const doc = minimal(faq());
  doc.metadata = { title: '', summary: '', category: '', tags: [], audience: doc.metadata.audience };
  doc.sections[0].label = '';
  const item = find(doc, 'faq').items[0]; item.question = '';
  item.answer = prose('x'.repeat(100000)); validateDocument(doc);
  item.question = '?'; invalid(doc); item.question = '';
  doc.metadata.category = 'c'; invalid(doc); doc.metadata.category = '';
  doc.metadata.tags = ['t']; invalid(doc); doc.metadata.tags = [];
  find(doc, 'faq').tags = ['b']; invalid(doc); delete find(doc, 'faq').tags;
  for (const field of ['alt', 'caption', 'credit']) {
    const block = gallery(); Object.assign(block.items[0], { alt: '', caption: '', credit: '', [field]: 'x' });
    add(doc, block); invalid(doc); column(doc).blocks.pop();
  }
  const video = media('video'); video.title = ''; video.transcript = ''; video.captions[0].text = 'x';
  add(doc, video); invalid(doc); column(doc).blocks.pop();
  item.answer.content[0].content[0].marks = [{ type: 'highlight', attrs: { color: '#abcdef' } }]; invalid(doc);
  item.answer.content[0].content[0].marks = [{ type: 'link', attrs: { href: '/' } }]; invalid(doc);
  const aggregate = minimal(faq());
  find(aggregate, 'faq').items = Array.from({ length: 2 }, (_, i) => ({ id: id(100 + i), question: '?', answer: prose('x'.repeat(51000)) }));
  invalid(aggregate);
});

test('v3 global node budgets include FAQ nodes and marks, not independent per answer', () => {
  const doc = minimal(faq());
  doc.metadata = { title: '', summary: '', category: '', tags: [], audience: doc.metadata.audience }; doc.sections[0].label = '';
  const item = find(doc, 'faq').items[0]; item.question = '';
  item.answer = { type: 'doc', content: Array.from({ length: 19999 }, () => ({ type: 'paragraph' })) };
  validateDocument(doc);
  item.answer.content.push({ type: 'paragraph' }); invalid(doc);
  item.answer.content.pop(); item.answer.content.pop();
  item.answer.content[0].content = [{ type: 'hard_break' }]; validateDocument(doc);
  item.answer.content[0].content[0].marks = [{ type: 'strong' }]; invalid(doc);
  item.answer = { type: 'doc', content: Array.from({ length: 10000 }, () => ({ type: 'paragraph' })) };
  find(doc, 'faq').items.push({ ...structuredClone(item), id: id(123) }); invalid(doc);
});

test('v3 section/row/block/byte limits are global and accept their exact boundaries', () => {
  const doc = minimal();
  const section = doc.sections[0];
  doc.sections = Array.from({ length: 20 }, (_, i) => ({ ...structuredClone(section), id: id(1000 + i), rows: [{ id: id(2000 + i), layout: 'single', columns: [{ id: id(3000 + i), blocks: [] }] }] }));
  validateDocument(doc); doc.sections.push({ ...section, id: id(9999) }); invalid(doc);
  const rows = minimal();
  rows.sections[0].rows = Array.from({ length: 100 }, (_, i) => ({ id: id(1000 + i), layout: 'single', columns: [{ id: id(2000 + i), blocks: [] }] }));
  validateDocument(rows); rows.sections[0].rows.push({ id: id(9998), layout: 'single', columns: [{ id: id(9999), blocks: [] }] }); invalid(rows);
  const blocks = minimal(...Array.from({ length: 100 }, (_, i) => ({ id: id(1000 + i), type: 'divider' })));
  validateDocument(blocks); add(blocks, { id: id(9999), type: 'divider' }); invalid(blocks);
  for (const change of [d => { d.sections = []; }, d => { d.sections[0].rows = []; }, d => { d.sections[0].label = 'x'.repeat(201); }]) { const d = minimal(); change(d); invalid(d); }
  const huge = featureDocument(); huge.extra = 'x'.repeat(1024 * 1024);
  assert.throws(() => validateDocument(huge), { status: 413, reason: 'document_too_large' });
});

test('v3 publication requires title, meaningful content and audience before real contrast gating', () => {
  const doc = minimal({ id: id(1), type: 'rich_text', content: prose('Content') });
  doc.presentation.defaults.foreground = doc.presentation.defaults.background;
  validateDocument(doc); invalid(doc, { publishing: true }, 'color_contrast_required');
  for (const change of [d => { d.metadata.title = ' '; }, d => { d.metadata.audience.job_title_ids = []; }, d => { column(d).blocks = [{ id: id(1), type: 'divider' }, button({ type: 'url', value: '/' })]; column(d).blocks[0].id = id(2); }]) {
    const d = structuredClone(doc); change(d); invalid(d, { publishing: true }, 'publication_incomplete');
  }
  for (const block of [gallery(), media('audio'), media('video'), embed()]) invalid(minimal(block), { publishing: true }, 'publication_incomplete');
});

test('v3 publishing checks legacy caption and credit subwrappers for images, GIFs and gallery items', () => {
  for (const type of ['image', 'gif', 'gallery']) for (const field of ['caption', 'credit']) {
    const item = { id: id(3), kind: 'image', media_id: id(4), alt: 'Alt', caption: '', credit: '', [field]: 'Visible text' };
    const value = type === 'gallery' ? { id: id(2), type, items: [item] }
      : { id: id(2), type, media_id: id(4), alt: 'Alt', caption: '', credit: '', [field]: 'Visible text' };
    value.style = { font: 'manrope', scale: 'large', align: 'start', palette: 'brand' };
    const doc = minimal({ id: id(1), type: 'rich_text', content: prose('Content') }, value);
    const bytes = JSON.stringify(doc); validateDocument(doc);
    invalid(doc, { publishing: true }, 'color_contrast_required'); assert.equal(JSON.stringify(doc), bytes);
    value.appearance = { foreground: '#214b39' }; validateDocument(doc, { publishing: true });
    value.appearance.foreground = '#E8F1E9'; invalid(doc, { publishing: true }, 'color_contrast_required');
    value.appearance = { background: '#FFFFFF' }; validateDocument(doc, { publishing: true });
  }
});

test('v3 every block keeps strict keys and required fields independent of optional common fields', () => {
  const samples = [
    { id: id(1), type: 'rich_text', content: prose('Text') },
    { id: id(1), type: 'callout', content: prose('Text'), tone: 'info', icon: 'none' },
    ...['image', 'gif'].map(type => ({ id: id(1), type, media_id: id(2), alt: '', caption: '', credit: '' })),
    media('audio'), media('video'), gallery(), faq(), embed(), button({ type: 'url', value: '/' }),
    { id: id(1), type: 'divider' },
  ];
  for (const sample of samples) {
    const doc = minimal(structuredClone(sample));
    const block = column(doc).blocks[0];
    block.appearance = {}; block.tags = Array.from({ length: 20 }, (_, i) => `tag${i}`);
    block.style = { align: 'start', scale: 'standard', palette: 'neutral', font: 'manrope' };
    validateDocument(doc);
    block.extra = true; invalid(doc); delete block.extra;
    for (const field of Object.keys(sample)) {
      const value = block[field]; delete block[field]; invalid(doc); block[field] = value;
    }
    for (const field of ['style', 'appearance', 'tags']) {
      const value = block[field]; block[field] = null; invalid(doc); block[field] = value;
    }
    block.tags.push('overflow'); invalid(doc);
  }
});

test('v3 PM accepts boundary headings, ordered lists and marked breaks but rejects structural/attribute confusion', () => {
  const make = content => minimal({ id: id(1), type: 'rich_text', content });
  const item = { type: 'list_item', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Text' }] }] };
  for (const level of [2, 3]) validateDocument(make({ type: 'doc', content: [{ type: 'heading', attrs: { level }, content: [{ type: 'text', text: 'Title' }, { type: 'hard_break', marks: [{ type: 'highlight', attrs: { color: '#abcdef' } }] }] }] }));
  for (const order of [1, 100000]) validateDocument(make({ type: 'doc', content: [{ type: 'ordered_list', attrs: { order }, content: [item] }] }));
  const bad = [
    { type: 'doc', attrs: {}, content: [{ type: 'paragraph' }] },
    { type: 'doc', content: [{ type: 'paragraph', marks: [] }] },
    { type: 'doc', content: [{ type: 'heading', attrs: null }] },
    { type: 'doc', content: [{ type: 'heading', attrs: { level: 2, extra: true } }] },
    { type: 'doc', content: [{ type: 'bullet_list', attrs: {}, content: [item] }] },
    { type: 'doc', content: [{ type: 'bullet_list', content: [] }] },
    { type: 'doc', content: [{ type: 'ordered_list', attrs: { order: 0 }, content: [item] }] },
    { type: 'doc', content: [{ type: 'ordered_list', attrs: { order: 1.5 }, content: [item] }] },
    { type: 'doc', content: [{ type: 'ordered_list', content: [{ type: 'paragraph' }] }] },
    { type: 'doc', content: [{ type: 'bullet_list', content: [{ type: 'list_item', content: [{ type: 'heading', attrs: { level: 2 } }] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'hard_break', attrs: {} }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'hard_break', text: 'x' }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: '/', target: '_blank' } }] }] }] },
    { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'highlight', attrs: { color: '#abcdef\n' } }] }] }] },
  ];
  for (const content of bad) invalid(make(content));
});

test('v3 FAQ fifty-item limit is inclusive and per-item publication checks cannot borrow another answer', () => {
  const doc = minimal(faq());
  find(doc, 'faq').items = Array.from({ length: 50 }, (_, i) => ({ id: id(100 + i), question: `Question ${i}`, answer: prose('Answer') }));
  validateDocument(doc, { publishing: true });
  find(doc, 'faq').items[49].answer = prose('  ');
  validateDocument(doc); invalid(doc, { publishing: true }, 'publication_incomplete');
});

test('legacy v1/v2 still reject new layout/appearance/marks/templates and preserve existing styles/media/buttons', () => {
  for (const template of ['comunicado', 'owner-news']) {
    const original = createTemplate(template); assert.deepEqual(validateDocument(original).document, original);
    const changes = [d => { column(d).blocks[0].appearance = { icon: 'coffee' }; },
      d => { d.metadata.category = ''; }, d => { column(d).blocks[0].content.content[0].content[0].marks = [{ type: 'highlight', attrs: { color: '#abcdef' } }]; },
      d => { const row = d.sections[0].rows[0]; row.layout = 'aside_right'; row.columns.push({ id: id(99), blocks: [] }); },
      d => { d.template = { id: 'guia-interno', version: 1 }; },
    ];
    rejectChanges(() => createTemplate(template), changes);
  }
  const old = createTemplate('owner-news');
  add(old, { ...media('video'), captions: null }); // Existing legacy draft normalization must not change.
  add(old, { id: id(99), type: 'divider', style: { align: 'start', scale: 'standard', font: 'manrope', palette: 'brand' } });
  assert.deepEqual(validateDocument(old).document, old);
});
