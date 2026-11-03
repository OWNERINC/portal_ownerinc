import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cms = require('../../api/cms/revisions');
const { addPublishedBlocks, isPublicCmsRow, promoteDueScheduled } = require('../../api/cms/reader');
const { deleteCmsSource } = require('../../api/cms/sources');
const { reminderForDelivery } = require('../../cron/checkReminders');

const assetId = '550e8400-e29b-41d4-a716-446655440000';

function readerPool(rows, assetFixtures = null) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/FOR UPDATE OF s/.test(sql)) {
        const requested = new Set((params[0] || []).map(String));
        return { rows: rows
          .filter(row => requested.has(String(row.source_id)))
          .map(row => ({
            source_id: row.source_id,
            document_id: row.document_id || null,
            published_revision_id: row.published_revision_id || null,
          })) };
      }
      if (/FROM (knowledge_base|academy|benefits|reminders) s/.test(sql)) {
        const requested = new Set((params[1] || []).map(String));
        return { rows: rows.filter(row => requested.has(String(row.source_id))) };
      }
      if (/FROM cms_assets/.test(sql)) {
        const blocks = rows.flatMap(row => row.blocks || []);
        const candidates = assetFixtures === null
          ? (params[0] || []).map(id => ({
            id,
            mime_type: blocks.find(block => block.asset_id === id)?.type === 'pdf' ? 'application/pdf' : 'image/png',
            storage_key: id,
            byte_size: 1,
            deleting_at: null,
          }))
          : assetFixtures;
        return {
          rows: candidates.filter(asset => (params[0] || []).map(String).includes(String(asset.id))
            && asset.storage_key !== null && asset.deleting_at == null
            && asset.byte_size >= 1 && asset.byte_size <= 52428800),
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    calls,
    async connect() { return client; },
  };
}

test('stale publish and schedule selections resolve to 409 before changing state', () => {
  const document = { draft_revision_id: 'draft-current' };
  assert.equal(cms.resolveDraftRevisionId(document), 'draft-current');
  assert.equal(cms.resolveDraftRevisionId(document, 'draft-current'), 'draft-current');
  assert.equal(cms.resolveDraftRevisionId({
    draft_revision_id: '550e8400-e29b-41d4-a716-446655440000',
  }, '550E8400-E29B-41D4-A716-446655440000'), '550e8400-e29b-41d4-a716-446655440000');
  assert.throws(() => cms.resolveDraftRevisionId(document, 'draft-old'), error => error.status === 409);
  assert.throws(() => cms.resolveDraftRevisionId({ draft_revision_id: null }), error => error.status === 409);
});

test('unschedule archives the scheduled revision when a newer draft exists', () => {
  assert.deepEqual(cms.unscheduleRevisionState({
    scheduled_revision_id: 'scheduled-1', draft_revision_id: 'draft-2',
  }), {
    scheduledRevisionId: 'scheduled-1', draftRevisionId: 'draft-2', preserveDraft: true,
  });
  assert.deepEqual(cms.unscheduleRevisionState({ scheduled_revision_id: 'scheduled-1', draft_revision_id: null }), {
    scheduledRevisionId: 'scheduled-1', draftRevisionId: 'scheduled-1', preserveDraft: false,
  });
  assert.equal(cms.unscheduleRevisionState({
    scheduled_revision_id: '550e8400-e29b-41d4-a716-446655440000',
    draft_revision_id: '550E8400-E29B-41D4-A716-446655440000',
  }).preserveDraft, false);
});

test('unpublish withdraws both published and scheduled revisions without selecting a draft', () => {
  assert.deepEqual(cms.withdrawalState({
    published_revision_id: 'published-1', scheduled_revision_id: 'scheduled-2', draft_revision_id: 'draft-3',
  }), { publishedRevisionId: 'published-1', scheduledRevisionId: 'scheduled-2' });
});

test('reader strips legacy body when a CMS document has no valid publication', async () => {
  const pool = readerPool([{
    source_id: 'source-1', document_id: 'document-1', blocks: null,
  }]);
  const [row] = await addPublishedBlocks(pool, [{ id: 'source-1', title: 'Article', content: 'Legacy body' }], 'knowledge');
  assert.equal(row.cms_managed, true);
  assert.equal(row.content, '');
  assert.equal('content_blocks' in row, false);
  assert.equal(isPublicCmsRow(row), false);
});

test('public circulation keeps legacy rows and excludes every unpublished CMS row', async () => {
  assert.equal(isPublicCmsRow({ id: 'legacy' }), true);
  assert.equal(isPublicCmsRow({ id: 'published', cms_managed: true, content_blocks: [] }), true);
  for (const contentType of ['knowledge', 'academy', 'benefit', 'reminder']) {
    const pool = readerPool([{ source_id: `hidden-${contentType}`, document_id: 'document-1', blocks: null }]);
    const [row] = await addPublishedBlocks(pool, [{ id: `hidden-${contentType}`, title: 'Hidden', content: 'Legacy' }], contentType);
    assert.equal(isPublicCmsRow(row), false, contentType);
  }
});

test('reader uses validated published blocks for body output and summaries', async () => {
  const pool = readerPool([{
    source_id: 'source-1', document_id: 'document-1',
    blocks: [{ type: 'paragraph', text: 'Published body' }, { type: 'pdf', asset_id: assetId, title: 'Guide' }],
  }]);
  const [row] = await addPublishedBlocks(pool, [{ id: 'source-1', title: 'Article', content: 'Legacy body' }], 'knowledge');
  assert.deepEqual(row.content_blocks, [
    { type: 'paragraph', text: 'Published body' }, { type: 'pdf', asset_id: assetId, title: 'Guide' },
  ]);
  assert.equal(row.content, '');
});

test('source deletion removes CMS circulation but leaves assets for retention', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('DELETE FROM knowledge_base')) return { rows: [{ id: 'source-1' }] };
      return { rows: [] };
    },
  };
  assert.deepEqual(await deleteCmsSource(db, 'knowledge', 'source-1'), { id: 'source-1' });
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  const sourceDelete = calls.findIndex(({ sql }) => sql.startsWith('DELETE FROM knowledge_base'));
  const documentDelete = calls.findIndex(({ sql }) => sql.includes('DELETE FROM cms_documents'));
  assert.ok(sourceDelete > 0 && sourceDelete < documentDelete);
  assert.equal(calls.some(({ sql }) => sql.includes('DELETE FROM cms_assets')), false);
});

test('reminder delivery contract uses the own description snapshot', () => {
  const reminder = { id: 'reminder-1', title: 'Own reminder', description: 'Own body', active: true };
  assert.equal(reminderForDelivery(reminder), reminder);
  assert.equal(reminderForDelivery(reminder).description, 'Own body');
});
