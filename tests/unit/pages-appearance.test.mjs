import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { normalizeHex, resolveAppearance, appearanceIssues } from '../../public/pages/appearance.js';
import { publicationIssues } from '../../public/pages/model.js';
import { referenceDocument } from '../helpers/pages-reference-document.mjs';

const require = createRequire(import.meta.url);
const api = require('../../api/pages/appearance');
const { validateDocument } = require('../../api/pages/validation');
const root = 'sections[0].rows[0].columns[0].blocks[0]';
const prose = (text, marks = [], type = 'paragraph', level = 2) => ({ type: 'doc', content: [
  { type, ...(type === 'heading' ? { attrs: { level } } : {}), content: [{ type: 'text', text, marks }] },
] });
function document(block = { type: 'rich_text', content: prose('Text') }) {
  const doc = referenceDocument(); doc.metadata.summary = ''; doc.metadata.tags = [];
  doc.sections = [doc.sections[0]]; doc.sections[0].rows[0].columns[0].blocks = [block];
  Object.assign(doc.presentation.defaults, { foreground: '#000000', background: '#FFFFFF' });
  return doc;
}
const block = doc => doc.sections[0].rows[0].columns[0].blocks[0];
const mark = (type, color) => ({ type, attrs: { color } });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('hex normalization accepts only trimmed solid six-digit colors', () => {
  for (const value of [' #e84f1c ', '#abcdef', '#ABCDEF']) assert.equal(normalizeHex(value), value.trim().toUpperCase());
  for (const value of [null, 3, {}, '#fff', '#ffffffff', 'none', 'red', 'url(https://example.test)', '#abcdef; color:red']) assert.equal(normalizeHex(value), null);
});

test('inheritance, legacy palettes, transparent page background and typed wrappers are independent', () => {
  const doc = document(); Object.assign(doc.presentation.defaults, { font: 'oswald', scale: 'large', align: 'end', foreground: '#123456', background: '#ABCDEF' });
  const b = block(doc); b.appearance = { icon: 'coffee', accent: '#ff0000' };
  assert.deepEqual(resolveAppearance(doc, b), { font: 'oswald', scale: 'large', align: 'end', foreground: '#123456', background: '#ABCDEF', accent: '#FF0000', icon: 'coffee' });
  for (const [palette, foreground, background] of [['neutral', '#2A275E', '#FFFEFB'], ['brand', '#214B39', '#E8F1E9'], ['warm', '#5A3B19', '#F8EEDB']]) {
    b.style = { font: 'manrope', scale: 'standard', align: 'start', palette };
    assert.equal(resolveAppearance(doc, b).foreground, foreground); assert.equal(resolveAppearance(doc, b).background, background);
  }
  b.appearance.background = 'none'; assert.equal(resolveAppearance(doc, b).background, '#ABCDEF');
  b.type = 'callout'; b.tone = 'attention'; b.icon = 'alert'; delete b.appearance.background;
  assert.equal(resolveAppearance(doc, b).foreground, '#5A3B19'); assert.equal(resolveAppearance(doc, b).icon, 'coffee');
  b.type = 'button'; b.preset = 'primary'; delete b.style;
  assert.equal(resolveAppearance(doc, b).foreground, '#ABCDEF'); assert.equal(resolveAppearance(doc, b).background, '#123456');
  b.appearance = { foreground: '#111111', background: '#EEEEEE' };
  assert.equal(resolveAppearance(doc, b).foreground, '#111111'); assert.equal(resolveAppearance(doc, b).background, '#EEEEEE');
});

test('named link part shares the checker precedence, independent of decorative accents and block foreground', () => {
  const doc = document(), b = block(doc); doc.presentation.defaults.foreground = '#123456';
  b.appearance = { foreground: '#FFFFFF', accent: '#000000' };
  for (const resolver of [api.resolveAppearance, resolveAppearance]) {
    assert.equal(resolver(doc, b, 'link').foreground, '#123456');
    b.style = { palette: 'brand' }; assert.equal(resolver(doc, b, 'link').foreground, '#2A275E'); delete b.style;
  }
});

test('WCAG uses unrounded sRGB luminance; 3/4.5 thresholds follow actual heading/strong sizes', () => {
  const doc = document(); block(doc).appearance = { foreground: '#777777' };
  let issues = appearanceIssues(doc); assert.equal(issues.length, 1); near(issues[0].ratio, 4.478089453577214);
  assert.equal(issues[0].path, `${root}.content.content[0].content[0]`); assert.equal(issues[0].reason, 'color_contrast_required');
  block(doc).appearance.foreground = '#767676'; assert.deepEqual(appearanceIssues(doc), []);
  block(doc).appearance.foreground = '#949494'; block(doc).content = prose('Heading', [], 'heading'); assert.deepEqual(appearanceIssues(doc), []);
  block(doc).appearance.foreground = '#959595'; assert.equal(appearanceIssues(doc).length, 1);
  block(doc).appearance.foreground = '#777777'; block(doc).content = prose('H3', [], 'heading', 3); assert.equal(appearanceIssues(doc).length, 1, '17.6px bold is not large');
  block(doc).content = prose('Strong', [{ type: 'strong' }]); assert.equal(appearanceIssues(doc).length, 1, '16px bold is not large');
  block(doc).appearance.scale = 'large'; assert.deepEqual(appearanceIssues(doc), [], '19.2px bold is large');
  block(doc).content = prose('Normal'); assert.equal(appearanceIssues(doc).length, 1, '19.2px normal is not large');
  block(doc).content = prose('Large heading', [], 'heading', 3); assert.deepEqual(appearanceIssues(doc), []);
  block(doc).appearance.scale = 'small'; assert.equal(appearanceIssues(doc).length, 1, '16.1px heading is not large');
  block(doc).appearance = { foreground: '#0A0A0A', background: '#0B0B0B' };
  const linear = c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  near(appearanceIssues(doc)[0].ratio, (linear(11 / 255) + .05) / (linear(10 / 255) + .05));
});

test('each real run resolves marks, links, FAQ question/answer, highlights and none backgrounds deterministically', () => {
  const doc = document({ type: 'faq', items: [{ question: 'Question', answer: prose('Answer', [mark('text_color', '#FFFFFF'), mark('highlight', '#FFFFFF'), { type: 'link', attrs: { href: '/' } }]) }] });
  let issues = appearanceIssues(doc); assert.deepEqual(issues.map(i => i.path), [`${root}.items[0].answer.content[0].content[0]`]);
  block(doc).appearance = { foreground: '#FFFFFF', background: 'none' };
  issues = appearanceIssues(doc); assert.deepEqual(issues.map(i=>i.path),[`${root}.items[0].question`,`${root}.items[0].answer.content[0].content[0]`,`${root}.section_label`]);
  block(doc).items[0].answer = prose('Safe highlight', [mark('text_color', '#FFFFFF'), mark('highlight', '#000000')]);
  assert.deepEqual(appearanceIssues(doc).map(i=>i.path),[`${root}.items[0].question`,`${root}.section_label`]);
  const b = { type: 'rich_text', content: prose('Link', [{ type: 'link', attrs: { href: '/' } }]), appearance: { background: '#000000', foreground: '#FFFFFF', accent: '#FFFFFF' } };
  const linked = document(b); assert.equal(appearanceIssues(linked).length, 1, 'link uses page text, not decorative accent or block foreground');
  b.content.content[0].content.push({ type: 'text', text: 'Repeated', marks: [{ type: 'link', attrs: { href: '/' } }] });
  assert.equal(appearanceIssues(linked).length, 2, 'do not deduplicate separate runs');
  b.content.content[0].content[0].marks.push(mark('text_color', '#FFFFFF'));
  assert.equal(appearanceIssues(linked).length, 1, 'explicit text color overrides link');
});

test('button and callout pairs cannot hide behind safe page defaults; tags/captions/media text are checked', () => {
  for (const b of [
    { type: 'button', preset: 'primary', label: 'Go' },
    { type: 'callout', tone: 'attention', icon: 'alert', content: prose('Warning') },
    { type: 'gallery', items: [{ caption: 'Caption', credit: 'Credit' }] },
    { type: 'audio', title: 'Audio', transcript: 'Transcript' },
    { type: 'video_embed', title: 'Video', transcript: 'Transcript' },
  ]) {
    b.appearance = { foreground: '#FFFFFF', background: '#FFFFFF' };
    const issues = appearanceIssues(document(b)); assert.ok(issues.length > 0, b.type); assert.ok(issues.every(i => i.path.startsWith(root)));
  }
  const doc = document({ type: 'divider', tags: ['Tag'], appearance: { foreground: '#FFFFFF' } });
  assert.equal(appearanceIssues(doc)[0].path, `${root}.tags[0]`);
  const safe = document({ type: 'callout', tone: 'attention', content: prose('Safe tone') });
  safe.presentation.defaults.foreground = '#FFFFFF'; safe.metadata.title = '';
  assert.deepEqual(appearanceIssues(safe), [], 'callout owns its actual tone pair');
});

test('caption/credit subwrappers preserve legacy muted text and share explicit v3 override precedence', () => {
  for (const type of ['image', 'gif', 'gallery']) {
    const b = { type, caption: 'Caption', credit: 'Credit', items: [{ caption: 'Caption', credit: 'Credit' }],
      style: { font: 'manrope', scale: 'large', align: 'start', palette: 'brand' } };
    const doc = document(b), bytes = JSON.stringify(doc);
    assert.equal(resolveAppearance(doc, b).foreground, '#214B39');
    assert.equal(resolveAppearance(doc, b, 'caption').foreground, '#6C706D');
    assert.equal(resolveAppearance(doc, b, 'caption').scale, 'small', 'figcaption is 14px even on large blocks');
    assert.equal(resolveAppearance(doc, b, 'caption').background, '#E8F1E9');
    const paths = type === 'gallery' ? [`${root}.items[0].caption`, `${root}.items[0].credit`] : [`${root}.caption`, `${root}.credit`];
    for (const implementation of [{ resolveAppearance, appearanceIssues }, api]) {
      const issues = implementation.appearanceIssues(doc);
      assert.deepEqual(issues.map(i => i.path), paths);
      issues.forEach(issue => near(issue.ratio, 4.355695473806927));
      assert.equal(implementation.resolveAppearance(doc, b, 'caption').foreground, '#6C706D');
    }
    assert.equal(JSON.stringify(doc), bytes);
    b.appearance = { icon: 'info', accent: '#FFFFFF' };
    doc.presentation.defaults.foreground = '#FFFFFF'; doc.metadata.title = '';
    assert.equal(resolveAppearance(doc, b, 'caption').foreground, '#6C706D', 'unrelated overrides/page defaults do not unpin caption text');
    b.appearance.background = '#FFFFFF'; assert.deepEqual(appearanceIssues(doc), [], 'caption background follows the real block override');
    b.appearance.background = 'none'; assert.equal(resolveAppearance(doc, b, 'caption').background, '#FFFFFF');
    delete b.appearance.background; b.appearance.foreground = '#214b39';
    assert.equal(resolveAppearance(doc, b, 'caption').foreground, '#214B39'); assert.deepEqual(appearanceIssues(doc), []);
    b.appearance.foreground = '#e8f1e9'; assert.equal(appearanceIssues(doc).length, 2);
    delete b.style; delete b.appearance.foreground; doc.presentation.defaults.foreground = '#123456';
    assert.equal(resolveAppearance(doc, b, 'caption').foreground, '#123456', 'new v3 caption inherits page text when no legacy style exists');
    doc.schema_version = 2; b.appearance.foreground = '#FFFFFF';
    assert.equal(resolveAppearance(doc, b, 'caption').foreground, '#6C706D', 'legacy readers ignore v3 overrides');
  }
  for (const [palette, ratio] of [['neutral', 4.985900424542937], ['brand', 4.355695473806927], ['warm', 4.368645858806542]]) {
    const doc = document({ type: 'image', caption: 'Caption', credit: 'Credit',
      style: { font: 'manrope', scale: 'large', align: 'start', palette } });
    assert.equal(resolveAppearance(doc, block(doc), 'caption').foreground, '#6C706D');
    const issues = appearanceIssues(doc); assert.equal(issues.length, ratio < 4.5 ? 2 : 0);
    issues.forEach(issue => near(issue.ratio, ratio));
  }
});

test('API/generated browser parity over JSON corpus, no mutation, no retroactive legacy gate', () => {
  const corpus = [];
  for (const scale of ['small', 'standard', 'large']) for (const type of ['paragraph', 'heading']) for (const color of ['#767676', '#777777', '#949494', '#959595']) {
    const doc = document(); block(doc).content = prose('Run', [], type); block(doc).appearance = { scale, foreground: color }; corpus.push(doc);
  }
  corpus.push(referenceDocument(), document({ type: 'faq', items: [{ question: 'FAQ', answer: prose('Run', [mark('highlight', '#000000')]) }] }));
  for (const type of ['rich_text', 'callout', 'button', 'faq']) for (const background of ['#FFFFFF', '#000000', 'none']) {
    corpus.push(document({ type, tone: 'attention', preset: 'primary', label: 'Button', content: prose('Marked', [mark('text_color', '#ABABAB'), mark('highlight', '#EFEFEF'), { type: 'link', attrs: { href: '/' } }]),
      items: [{ question: 'Question', answer: prose('Link', [{ type: 'link', attrs: { href: '/' } }]) }], appearance: { background, foreground: '#777777', icon: 'coffee' } }));
  }
  for (const doc of corpus) {
    const bytes = JSON.stringify(doc); const copy = JSON.parse(bytes);
    assert.deepEqual(api.appearanceIssues(copy), appearanceIssues(doc));
    assert.deepEqual(api.resolveAppearance(copy, block(copy)), resolveAppearance(doc, block(doc)));
    assert.equal(JSON.stringify(doc), bytes);
  }
  for (const type of ['image', 'gif', 'gallery']) for (const foreground of [undefined, '#214B39', '#FFFFFF']) {
    const doc = document({ type, caption: 'Caption', credit: 'Credit', items: [{ caption: 'Caption', credit: 'Credit' }],
      style: { font: 'manrope', scale: 'standard', align: 'start', palette: 'brand' }, appearance: foreground ? { foreground } : {} });
    assert.deepEqual(api.appearanceIssues(JSON.parse(JSON.stringify(doc))), appearanceIssues(doc));
    assert.deepEqual(api.resolveAppearance(doc, block(doc), 'caption'), resolveAppearance(doc, block(doc), 'caption'));
  }
  for (const value of [' #abcdef ', '#fff', null]) assert.equal(api.normalizeHex(value), normalizeHex(value));
  const doc = document(); doc.presentation.defaults.foreground = '#FFFFFF';
  for (const version of [1, 2]) { doc.schema_version = version; assert.deepEqual(appearanceIssues(doc), []); }
});

test('API publication AA gate evaluates individual marks/FAQ/buttons/callouts after structure, and drafts remain editable', () => {
  const id = n => `abcdefab-1234-4000-8000-${String(n).padStart(12, '0')}`;
  const cases = [
    { type: 'rich_text', content: prose('Low contrast run', [mark('text_color', '#FFFFFF')]) },
    { type: 'rich_text', content: prose('Low contrast highlight', [mark('highlight', '#000000')]) },
    { type: 'callout', tone: 'info', icon: 'none', content: prose('Callout'), appearance: { foreground: '#E8F1E9' } },
    { type: 'button', preset: 'primary', label: 'Button', action: { type: 'url', value: '/' }, appearance: { foreground: '#000000', background: '#000000' } },
    { type: 'faq', items: [{ id: id(2), question: 'Question', answer: prose('Low answer', [mark('text_color', '#FFFFFF')]) }] },
    { type: 'faq', appearance: { foreground: '#FFFFFF' }, items: [{ id: id(2), question: 'Question', answer: prose('Safe answer', [mark('text_color', '#000000')]) }] },
  ];
  for (const sample of cases) {
    const doc = document({ id: id(1), ...sample });
    if (sample.type === 'button') doc.sections[0].rows[0].columns[0].blocks.push({ id: id(3), type: 'rich_text', content: prose('Content') });
    const bytes = JSON.stringify(doc); validateDocument(doc);
    assert.throws(() => validateDocument(doc, { publishing: true }), { status: 400, reason: 'color_contrast_required' });
    assert.equal(JSON.stringify(doc), bytes);
    block(doc).extra = true;
    assert.throws(() => validateDocument(doc, { publishing: true }), { status: 400, reason: 'invalid_document' });
  }
  for (const [type, color, passes] of [['paragraph', '#767676', true], ['paragraph', '#777777', false], ['heading', '#949494', true], ['heading', '#959595', false]]) {
    const doc = document({ id: id(1), type: 'rich_text', content: prose('Boundary', [], type), appearance: { foreground: color } });
    if (passes) validateDocument(doc, { publishing: true });
    else assert.throws(() => validateDocument(doc, { publishing: true }), { status: 400, reason: 'color_contrast_required' });
  }
});

test('decorative accent is not text, but using that color in a run is checked; all legacy versions bypass AA', () => {
  const doc = document(); doc.presentation.defaults.accent = '#FFFFFF';
  assert.deepEqual(appearanceIssues(doc), []);
  block(doc).content.content[0].content[0].marks = [mark('text_color', doc.presentation.defaults.accent)];
  assert.equal(appearanceIssues(doc).length, 1);
  const { createTemplate } = require('../../api/pages/templates');
  for (const version of [1, 2]) {
    const old = createTemplate(); old.schema_version = version; old.template.version = version;
    old.metadata.audience.job_title_ids = ['abcdefab-1234-4000-8000-000000000001'];
    const oldBlock = old.sections[0].rows[0].columns[0].blocks[0];
    if (version === 2) oldBlock.style = { font: 'manrope', scale: 'small', align: 'start', palette: 'warm' };
    assert.deepEqual(appearanceIssues(old), []); validateDocument(old, { publishing: true });
  }
});

test('publication warnings expose exact run paths only for v3', () => {
  const doc = document(); block(doc).appearance = { foreground: '#FFFFFF' };
  const issues = publicationIssues(doc, [{ id: doc.metadata.audience.job_title_ids[0], active: true }]);
  assert.ok(issues.some(issue => issue.includes(`${root}.content.content[0].content[0]`) && issue.includes('AA')));
  doc.schema_version = 2; assert.deepEqual(publicationIssues(doc, [{ id: doc.metadata.audience.job_title_ids[0], active: true }]), []);
});

test('legacy source colors and typography remain unchanged; SVG palettes use separately scoped v3 tokens', async () => {
  const css = await readFile('public/css/pages.css', 'utf8'), tokens = await readFile('public/css/tokens.css', 'utf8');
  assert.match(tokens, /--text: #2A275E;/); assert.match(tokens, /--surface: #FFFEFB;/);
  assert.match(tokens, /--text-secondary: #6C706D;/);
  assert.match(css, /\.pages-editor-block figcaption, \.pages-document figcaption \{ font-size: \.875rem;[^\n]*color: var\(--text-secondary\);/);
  assert.match(css, /\.pages-credit \{ display: block; \}/);
  assert.match(css, /\[data-palette=brand\] \{ background: #e8f1e9; color: #214b39; \}/);
  assert.match(css, /\[data-palette=warm\] \{ background: #f8eedb; color: #5a3b19; \}/);
  assert.match(css, /\.pages-page\[data-schema-version="3"\]/);
  for (const color of ['#2A275E', '#E84F1C', '#F7F6F2', '#3C352E', '#9E583E', '#F0ECE5', '#262626', '#6B7280', '#F5F5F5']) assert.ok(css.includes(color));
});
