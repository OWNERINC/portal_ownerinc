import { snapshotHash, sha256 } from '../../scripts/owner-news-payload/contract.mjs';
export const ids = Object.freeze({ document: '11111111-1111-4111-8111-111111111111', published: '22222222-2222-4222-8222-222222222222',
  draft: '33333333-3333-4333-8333-333333333333', scheduled: '44444444-4444-4444-8444-444444444444',
  image: '55555555-5555-4555-8555-555555555555', pdf: '66666666-6666-4666-8666-666666666666', video: '77777777-7777-4777-8777-777777777777' });
export const timestamp = '2026-09-01T12:00:00.123456Z';
export function sourceFixture() {
  return { exportedAt: '2026-10-06T12:00:00.000000Z', source: { instanceId: 'synthetic-local', authority: { mode: 'frozen', epoch: 2 } },
    documents: [{ id: ids.document, content_type: 'announcement', source_id: null, title: 'Synthetic document', category: '',
      published_revision_id: ids.published, draft_revision_id: ids.draft, scheduled_revision_id: null, scheduled_at: null,
      published_at: timestamp, created_by: null, updated_by: null, created_at: timestamp, updated_at: timestamp }],
    revisions: [{ id: ids.published, document_id: ids.document, version: 1, status: 'published', blocks: [{ type: 'paragraph', text: 'Synthetic body.' }], editorial: null, created_by: null, created_at: timestamp },
      { id: ids.draft, document_id: ids.document, version: 2, status: 'draft', blocks: [],
        editorial: { version: 1, kind: 'article', summary: '', author: '', source_label: '', source_date: null }, created_by: null, created_at: timestamp }],
    home: { singleton: true, version: 1, draft: null, published: null, updated_by: null, updated_at: timestamp, published_at: null }, assets: [] };
}
export function mediaFixture(id, mime, bytes = Buffer.from('%PDF-synthetic')) {
  return { id, storageKey: id, originalName: 'synthetic', mime, size: bytes.length, uploadedBy: null, createdAt: timestamp, updatedAt: timestamp,
    deletingAt: null, metadataHash: snapshotHash({}), storedSha256: null, sha256: sha256(bytes), relativePath: `assets/${id}`, sharedWithContentTypes: [] };
}
export function everyLegacyBlock() {
  return [
    { type: 'heading', text: 'Heading', level: 1, layout: 'wide' }, { type: 'paragraph', text: 'Body\nsecond line', typography: 'serif' },
    { type: 'list', items: ['One', 'Two'], ordered: true, layout: 'left', typography: 'sans' },
    { type: 'callout', tone: 'warning', title: 'Title', text: 'Text', typography: 'serif' },
    { type: 'quote', text: 'Quote', attribution: 'Synthetic attribution', layout: 'right' },
    { type: 'profile', name: 'Synthetic profile', role: 'Role', text: 'Text', asset_id: ids.image, alt: 'Synthetic image' },
    { type: 'image', asset_id: ids.image, alt: 'Synthetic image', caption: 'Caption', credit: 'Credit', usage: 'cover', layout: 'full' },
    { type: 'divider' }, { type: 'link', label: 'Synthetic link', url: 'https://example.invalid/', new_tab: false },
    { type: 'pdf', asset_id: ids.pdf, title: 'Synthetic PDF', usage: 'edition' },
    { type: 'video', asset_id: ids.video, title: 'Synthetic video' },
  ];
}
