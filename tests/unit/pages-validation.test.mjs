import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { validateDocument, validateMutation, safeLink, PagesError } = require('../../api/pages/validation');
const { createTemplate } = require('../../api/pages/templates');
const { mayEdit, mayReview } = require('../../api/pages/access');
const { normalizePermissions } = require('../../api/middleware/policy');
const block = doc => doc.sections[0].rows[0].columns[0].blocks[0];
const invalid = fn => assert.throws(fn, error => error instanceof PagesError && error.status === 400);

test('Pages template is a persistent-schema example, explicitly not official policy', () => {
  const source = createTemplate(), normalized = validateDocument(source);
  assert.deepEqual(normalized.document, source);
  assert.match(source.metadata.summary, /Não é uma política oficial/);
  assert.deepEqual(normalized.jobTitleIds, []);
  invalid(() => validateDocument(source, { publishing: true }));
  source.metadata.audience.job_title_ids = [randomUUID()];
  assert.doesNotThrow(() => validateDocument(source, { publishing: true }));
});

test('strict validator rejects unknown keys, aliases, global duplicate identities, shape confusion and unsupported media', () => {
  const changes = [
    doc => { doc.unknown = true; }, doc => { doc.schema_version = 2; }, doc => { doc.template.id = 'news'; },
    doc => { doc.presentation.theme = 'custom'; }, doc => { doc.metadata.title = 'x'.repeat(201); },
    doc => { doc.metadata.audience.type = 'all'; }, doc => { doc.metadata.audience.job_title_ids = ['not-an-id']; },
    doc => { doc.metadata.tags = Array(21).fill('tag'); }, doc => { doc.sections[0].rows[0].id = doc.sections[0].id; },
    doc => { block(doc).type = 'video'; }, doc => { block(doc).html = '<script>'; },
    doc => { block(doc).content.content = [null]; }, doc => { block(doc).content.content = [{ type: 'paragraph', content: ['bad'] }]; },
    doc => { doc.sections[0].rows[0].columns[0].blocks = [null]; }, doc => { block(doc).content.content = [{ type: 'image', attrs: { src: '/x' } }]; },
    doc => { block(doc).content.content[0].attrs.level = 1; }, doc => { block(doc).content.marks = []; },
  ];
  for (const change of changes) { const doc = createTemplate(); change(doc); invalid(() => validateDocument(doc)); }
});

test('safe links reject scripts, protocol-relative, credentials, whitespace, backslashes and controls', () => {
  for (const href of ['https://example.test/path?q=1#x','/pages.html?id=123','/']) assert.equal(safeLink(href), true, href);
  for (const href of ['javascript:alert(1)','http://example.test','//example.test','/\\example.test','https://u:p@example.test','https://example.test/\nfoo',' https://example.test','data:text/html,hi']) {
    assert.equal(safeLink(href), false, href);
    const doc = createTemplate(); block(doc).content.content[1].content[0].marks = [{ type: 'link', attrs: { href } }];
    invalid(() => validateDocument(doc));
  }
});

test('bounded lists, text, images, identifiers and request size are enforced without PM UI dependencies', () => {
  const doc = createTemplate();
  const paragraph = { type: 'paragraph', content: [{ type: 'text', text: 'Item', marks: [{ type: 'strong' }, { type: 'underline' }] }] };
  const list = child => ({ type: 'bullet_list', content: [{ type: 'list_item', content: [paragraph, ...(child ? [child] : [])] }] });
  block(doc).content.content = [list(list())]; validateDocument(doc);
  block(doc).content.content = [list(list(list()))]; invalid(() => validateDocument(doc));
  block(doc).content.content = [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(100001) }] }]; invalid(() => validateDocument(doc));
  const huge = createTemplate(); huge.metadata.extra = 'x'.repeat(1024 * 1024);
  assert.throws(() => validateDocument(huge), { status: 413 });
  const imageDoc = createTemplate(); imageDoc.metadata.audience.job_title_ids = [randomUUID()];
  imageDoc.sections[0].rows[0].columns[0].blocks.push({ id: randomUUID(), type: 'image', media_id: randomUUID(), alt: '', caption: '', credit: '' });
  validateDocument(imageDoc); assert.throws(() => validateDocument(imageDoc, { publishing: true }), { reason: 'image_alt_required' });
  imageDoc.sections[0].rows[0].columns[0].blocks[1].alt = 'Descrição'; validateDocument(imageDoc, { publishing: true });
  imageDoc.metadata.audience.job_title_ids.push(imageDoc.metadata.audience.job_title_ids[0].toUpperCase()); invalid(() => validateDocument(imageDoc));
});

test('mutations require exact version and UUID retry identity', () => {
  const body = { expected_version: 0, client_mutation_id: randomUUID(), document: createTemplate() };
  validateMutation(body, 'draft');
  invalid(() => validateMutation({ ...body, expected_version: -1 }, 'draft'));
  invalid(() => validateMutation({ ...body, client_mutation_id: 'retry' }, 'draft'));
  invalid(() => validateMutation({ ...body, force: true }, 'draft'));
});

test('strict permissions never permit another author, even for superadmin; publisher reviews without editing', () => {
  const own = { author_uid: 'a' }, other = { author_uid: 'b' };
  const superadmin = { uid: 'a', role: 'admin', permissions: { superAdmin: true } };
  assert.equal(mayEdit(superadmin, own), true); assert.equal(mayEdit(superadmin, other), false);
  assert.equal(mayEdit(superadmin, { author_uid: null }), false);
  const review = { uid: 'p', role: 'admin', permissions: { publishPages: true } };
  assert.equal(mayReview(review, other), true); assert.equal(mayEdit(review, other), false);
  for (const user of [{ uid: 'a', role: 'viewer', permissions: { editPages: true } }, { uid: 'a', role: 'admin', permissions: { editPages: 'true', superAdmin: 'true' } }]) assert.equal(mayEdit(user, own), false);
  assert.deepEqual(Object.fromEntries(Object.entries(normalizePermissions({ editPages: true })).filter(([key]) => key.endsWith('Pages'))), { editPages: true, publishPages: false });
});
