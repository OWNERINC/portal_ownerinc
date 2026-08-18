import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { blocksToText, validateBlocks } = require('../../api/cms/blocks');
const { canManageCms } = require('../../api/cms/permissions');

const assetId = '550e8400-e29b-41d4-a716-446655440000';

test('validateBlocks accepts and normalizes every CMS block type', () => {
  const blocks = validateBlocks([
    { type: 'heading', text: '  Title  ', level: 2 },
    { type: 'paragraph', text: 'Body' },
    { type: 'list', items: ['One', 'Two'], ordered: true },
    { type: 'callout', tone: 'warning', title: 'Attention', text: 'Read this.' },
    { type: 'image', asset_id: assetId.toUpperCase(), alt: 'A chart' },
    { type: 'divider' },
    { type: 'link', label: 'Open portal', url: 'https://portal.example.test/help', new_tab: true },
    { type: 'pdf', asset_id: assetId, title: 'Policy' },
    { type: 'video', url: 'https://cdn.example.test/intro.mp4', title: 'Intro' },
  ]);

  assert.deepEqual(blocks, [
    { type: 'heading', text: 'Title', level: 2 },
    { type: 'paragraph', text: 'Body' },
    { type: 'list', items: ['One', 'Two'], ordered: true },
    { type: 'callout', tone: 'warning', title: 'Attention', text: 'Read this.' },
    { type: 'image', asset_id: assetId, alt: 'A chart' },
    { type: 'divider' },
    { type: 'link', label: 'Open portal', url: 'https://portal.example.test/help', new_tab: true },
    { type: 'pdf', asset_id: assetId, title: 'Policy' },
    { type: 'video', url: 'https://cdn.example.test/intro.mp4', title: 'Intro' },
  ]);
});

test('validateBlocks rejects malformed blocks, content, URLs, and asset IDs', () => {
  const invalidBlocks = [
    { type: 'unknown', text: 'Nope' },
    { type: 'paragraph', text: '<script>alert(1)</script>' },
    { type: 'paragraph', text: 'x'.repeat(5001) },
    { type: 'paragraph', text: 'Hello', extra: true },
    { type: 'heading', text: 'Title', level: 7 },
    { type: 'list', items: [] },
    { type: 'list', items: ['<b>unsafe</b>'] },
    { type: 'callout', tone: 'danger', text: 'Nope' },
    { type: 'callout', tone: 'info', title: '<script>alert(1)</script>', text: 'Nope' },
    { type: 'callout', tone: 'info', title: 'x'.repeat(201), text: 'Nope' },
    { type: 'callout', tone: 'info', title: 42, text: 'Nope' },
    { type: 'image', asset_id: 'not-a-uuid', alt: 'Image' },
    { type: 'image', asset_id: assetId, alt: '' },
    { type: 'divider', text: 'unexpected' },
    { type: 'link', label: 'Bad', url: 'http://example.test' },
    { type: 'link', label: 'Bad', url: 'javascript:alert(1)' },
    { type: 'pdf', asset_id: assetId, title: '' },
    { type: 'video', url: 'https://video.example.test/a.mp4', asset_id: assetId },
    { type: 'video', url: 'data:text/html,unsafe' },
  ];

  for (const block of invalidBlocks) assert.equal(validateBlocks([block]), null, JSON.stringify(block));
  assert.equal(validateBlocks(null), null);
  assert.equal(validateBlocks(new Array(101).fill({ type: 'divider' })), null);
});

test('blocksToText produces safe reminder text and omits visual-only blocks', () => {
  const blocks = [
    { type: 'heading', text: 'Reminder' },
    { type: 'paragraph', text: 'Plain body' },
    { type: 'list', items: ['First', 'Second'], ordered: false },
    { type: 'callout', title: 'Note', tone: 'info', text: 'Important' },
    { type: 'image', asset_id: assetId, alt: 'Ignored image' },
    { type: 'divider' },
    { type: 'link', label: 'Read more', url: 'https://example.test/read' },
    { type: 'pdf', asset_id: assetId, title: 'Guide' },
    { type: 'video', url: 'https://example.test/video.mp4', title: 'Walkthrough' },
  ];

  assert.equal(blocksToText(blocks), [
    'Reminder', 'Plain body', '- First\n- Second', 'Note: Important',
    'Read more: https://example.test/read', 'Guide', 'Walkthrough',
  ].join('\n\n'));
  assert.equal(blocksToText([{ type: 'paragraph', text: '<script>bad</script>' }]), '');
});

test('validateBlocks rejects an oversized aggregate CMS payload', () => {
  const oversized = Array.from({ length: 100 }, () => ({
    type: 'list',
    items: Array.from({ length: 100 }, () => '\u0800'.repeat(500)),
    ordered: false,
  }));
  assert.equal(validateBlocks(oversized), null);
});

test('canManageCms maps CMS areas to existing permissions', () => {
  const user = { role: 'admin', permissions: { manageKnowledge: true, manageBenefits: true } };
  assert.equal(canManageCms(user, 'knowledge'), true);
  assert.equal(canManageCms(user, 'announcement'), true);
  assert.equal(canManageCms(user, 'benefit'), true);
  assert.equal(canManageCms(user, 'academy'), false);
  assert.equal(canManageCms(user, 'reminder'), false);
  assert.equal(canManageCms(user, 'unknown'), false);
  assert.equal(canManageCms({ role: 'viewer', permissions: { manageKnowledge: true } }, 'knowledge'), false);
  assert.equal(canManageCms({ role: 'admin', permissions: { superAdmin: true } }, 'reminder'), true);
});
