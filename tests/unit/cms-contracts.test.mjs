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

function readerPool(rows) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT d\.source_id, r\.blocks/.test(sql)) return { rows };
      if (/FROM cms_assets/.test(sql)) {
        const blocks = rows.flatMap(row => row.blocks || []);
        return {
          rows: (params[0] || []).map(id => ({
            id,
            mime_type: blocks.find(block => block.asset_id === id)?.type === 'pdf' ? 'application/pdf' : 'image/png',
            storage_key: id,
            byte_size: 1,
            deleting_at: null,
          })),
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

test('reminder delivery never falls back to legacy text for a managed CMS document', () => {
  assert.equal(reminderForDelivery({
    description: 'Legacy body', cms_document_id: 'document-1', cms_blocks: [{ type: 'divider' }],
  }), null);
  assert.equal(reminderForDelivery({ description: 'Legacy body', cms_blocks: [{ type: 'divider' }] }).description, 'Legacy body');
});

test('scheduled promotion and retention share the CMS asset lock before row work', async () => {
  const pool = readerPool([]);
  await promoteDueScheduled(await pool.connect(), new Date('2026-09-14T12:00:00Z'));
  assert.match(pool.calls[0].sql, /pg_advisory_xact_lock/);
  const [cms, reader, retention] = await Promise.all([
    readFile('api/routes/cms.js', 'utf8'),
    readFile('api/cms/reader.js', 'utf8'),
    readFile('cron/cms-asset-retention.js', 'utf8'),
  ]);
  assert.ok(cms.indexOf('lockCmsMutation(db)') < cms.indexOf('findDocument(db, req.user, req.params.id, true)'));
  assert.ok(reader.indexOf('await lockCmsAssets(db);') < reader.indexOf('SELECT d.id, d.published_revision_id'));
  assert.ok(retention.indexOf('pg_advisory_lock') < retention.indexOf('const reserved = await reserveCmsAssets'));
});

test('public reminder reads promote due CMS schedules before visibility filtering', async () => {
  const [reminders, knowledge, academy, benefits] = await Promise.all([
    readFile('api/routes/reminders.js', 'utf8'),
    readFile('api/routes/knowledge.js', 'utf8'),
    readFile('api/routes/academy.js', 'utf8'),
    readFile('api/routes/benefits.js', 'utf8'),
  ]);
  assert.match(reminders, /promoteDueScheduledForPool/);
  assert.ok(reminders.indexOf('await promoteDueScheduledForPool') < reminders.indexOf('const { rows } = await pool.query(`SELECT \* FROM reminders'));
  assert.match(reminders, /filter\(isPublicCmsRow\)/);
  assert.match(knowledge, /filter\(isPublicCmsRow\)/);
  assert.match(knowledge, /if \(!isPublicCmsRow\(row\)\)/);
  assert.match(academy, /filter\(isPublicCmsRow\)/);
  assert.match(benefits, /filter\(isPublicCmsRow\)/);
  assert.match(academy, /X-Total-Count', String\(visible\.length\)/);
  assert.match(benefits, /X-Total-Count', String\(visible\.length\)/);
});
