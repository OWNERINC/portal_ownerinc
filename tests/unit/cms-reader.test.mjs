import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  addPublishedBlocks, getPublishedAnnouncement, getPublishedBlocksBatch,
  isPublicCmsRow, listPublishedAnnouncements, publishedBodyText,
} = require('../../api/cms/reader');

function poolFor({ document, blocks = [], assets = [], sourceExists = true, sourceActive = true,
  recheckSourceActive = sourceActive, removeOnRecheck = false, recheckDocument = document } = {}) {
  const calls = [];
  let connections = 0;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/scheduled\.status = 'scheduled'/.test(sql)) {
        const scheduledAt = document?.scheduled_at && new Date(document.scheduled_at).getTime();
        return scheduledAt && scheduledAt <= Date.now()
          ? { rows: [{ ...document, scheduled_blocks: document.scheduled_blocks ?? blocks }] }
          : { rows: [] };
      }
      if (/FROM cms_assets/.test(sql)) {
        const requested = new Set((params[0] || []).map(id => String(id).toLowerCase()));
        return {
          rows: assets.filter(asset => requested.has(String(asset.id).toLowerCase())
            && asset.storage_key !== null
            && asset.deleting_at == null
            && (asset.byte_size === undefined || (asset.byte_size >= 1 && asset.byte_size <= 52428800))),
        };
      }
      if (/FOR UPDATE OF s/.test(sql)) {
        const sourceIds = params[0] || [];
        return {
          rows: sourceExists && !removeOnRecheck ? sourceIds.map(id => ({
            source_id: id,
            source_active: recheckSourceActive,
            document_id: recheckDocument?.id || null,
            published_revision_id: recheckDocument?.published_revision_id
              && (recheckDocument.published_revision_status || 'published') === 'published'
              ? recheckDocument.published_revision_id : null,
          })) : [],
        };
      }
      if (/FOR UPDATE OF d, r/.test(sql)) {
        if (removeOnRecheck || !recheckDocument?.id) return { rows: [] };
        const published = recheckDocument.published_revision_id
          && (recheckDocument.published_revision_status || 'published') === 'published';
        return {
          rows: published ? [{
            id: recheckDocument.id,
            published_revision_id: recheckDocument.published_revision_id,
          }] : [],
        };
      }
      if (/FROM (knowledge_base|academy|benefits|reminders) s/.test(sql)) {
        const sourceIds = params[1] || [];
        return {
          rows: sourceExists ? sourceIds.map(sourceId => ({
            source_id: sourceId,
            source_active: sourceActive,
            document_id: document?.id || null,
            published_revision_id: document?.published_revision_id
              && (document.published_revision_status || 'published') === 'published'
              ? document.published_revision_id : null,
            blocks: document?.published_revision_id
              && (document.published_revision_status || 'published') === 'published' ? blocks : null,
          })) : [],
        };
      }
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: 1 }] };
      if (/SELECT d\.id, d\.title/.test(sql)) {
        const published = document?.published_revision_id
          && (document.published_revision_status || 'published') === 'published';
        return {
          rows: published
            ? [{ id: document.id, title: document.title, category: '', published_at: null,
              published_revision_id: document.published_revision_id, blocks }]
            : [],
        };
      }
      return { rows: [] };
    },
    release() {},
  };
  return {
    calls,
    async connect() {
      connections += 1;
      return client;
    },
    get connections() {
      return connections;
    },
  };
}

test('reader returns only a published revision and normalizes its blocks', async () => {
  const pool = poolFor({
    document: {
      id: 'doc-1', published_revision_id: 'pub-1', draft_revision_id: 'draft-1',
      scheduled_revision_id: 'scheduled-1', scheduled_at: new Date(Date.now() + 60000),
    },
    blocks: [{ type: 'heading', text: 'Published', level: 2 }],
  });

  const result = await getPublishedBlocksBatch(pool, 'knowledge', ['source-1', 'source-2']);
  assert.deepEqual(result.get('source-1'), [{ type: 'heading', text: 'Published', level: 2 }]);
  assert.deepEqual(result.get('source-2'), [{ type: 'heading', text: 'Published', level: 2 }]);
  const promotion = pool.calls.find(({ sql }) => /scheduled\.status = 'scheduled'/.test(sql));
  assert.deepEqual(promotion.params[2], ['source-1', 'source-2']);
  assert.equal(pool.connections, 3);
});

test('draft-only and future scheduled documents block legacy fallback', async () => {
  const draftOnly = poolFor({ document: { id: 'doc-1', draft_revision_id: 'draft-1' } });
  const draftResult = await getPublishedBlocksBatch(draftOnly, 'academy', ['source-1']);
  assert.equal(draftResult.has('source-1'), true);
  assert.equal(draftResult.get('source-1'), null);

  const future = poolFor({ document: {
    id: 'doc-2', published_revision_id: null, scheduled_revision_id: 'scheduled-2',
    scheduled_at: new Date(Date.now() + 60000),
  } });
  const futureResult = await getPublishedBlocksBatch(future, 'benefit', ['source-2']);
  assert.equal(futureResult.has('source-2'), true);
  assert.equal(futureResult.get('source-2'), null);
});

test('a source deleted between the source read and CMS recheck is discarded', async () => {
  const pool = poolFor({ sourceExists: false });
  const result = await addPublishedBlocks(pool, [{ id: 'source-1', title: 'Deleted', content: 'Legacy body' }], 'knowledge');
  const [row] = result;
  assert.deepEqual(result, []);
  assert.equal(isPublicCmsRow(row), false);
});

test('a source removed before the final locked recheck is discarded', async () => {
  const pool = poolFor({
    document: { id: 'doc-deleted', published_revision_id: 'pub-deleted' },
    blocks: [{ type: 'paragraph', text: 'Must not return' }],
    removeOnRecheck: true,
  });
  const result = await addPublishedBlocks(pool, [{ id: 'source-deleted', title: 'Deleted' }], 'knowledge');
  assert.deepEqual(result, []);
  const recheckIndex = pool.calls.findIndex(({ sql }) => /FOR UPDATE OF s/.test(sql));
  const lockIndex = pool.calls.findIndex(({ sql }) => /pg_advisory_xact_lock/.test(sql));
  assert.ok(lockIndex >= 0 && lockIndex < recheckIndex);
});

test('an active CMS source becoming inactive before recheck is not public', async () => {
  const pool = poolFor({
    document: { id: 'doc-inactive', published_revision_id: 'pub-inactive' },
    blocks: [{ type: 'paragraph', text: 'Must not return' }],
    recheckSourceActive: false,
  });
  const [row] = await addPublishedBlocks(pool, [{
    id: 'source-inactive', active: true, description: 'Legacy body',
  }], 'academy');
  assert.equal(row.active, false);
  assert.equal(isPublicCmsRow(row), false);
});

test('inactive sources are never public even when their CMS publication is valid', async () => {
  const pool = poolFor({
    document: { id: 'doc-inactive', published_revision_id: 'pub-inactive' },
    blocks: [{ type: 'paragraph', text: 'Must not return' }],
    sourceActive: false,
  });
  const [row] = await addPublishedBlocks(pool, [{
    id: 'source-inactive', active: false, description: 'Legacy body',
  }], 'benefit');
  assert.equal(isPublicCmsRow(row), false);
});

test('a legacy source becoming CMS-managed before recheck hides the legacy body', async () => {
  const pool = poolFor({
    recheckDocument: { id: 'doc-created', published_revision_id: 'pub-created' },
  });
  const result = await addPublishedBlocks(pool, [{
    id: 'source-legacy', title: 'Legacy', content: 'Legacy body',
  }], 'knowledge');
  assert.equal(result.length, 1);
  assert.equal(result[0].content, '');
  assert.equal('content_blocks' in result[0], false);
  assert.equal(isPublicCmsRow(result[0]), false);
});

test('a CMS document whose publication pointer has a non-published status stays hidden', async () => {
  const pool = poolFor({
    document: { id: 'doc-invalid-status', published_revision_id: 'revision-1', published_revision_status: 'draft' },
    blocks: [{ type: 'paragraph', text: 'Should stay hidden' }],
  });
  const [row] = await addPublishedBlocks(pool, [{ id: 'source-1', title: 'Managed', content: 'Legacy body' }], 'knowledge');
  assert.equal(row.cms_managed, true);
  assert.equal(row.content, '');
  assert.equal(isPublicCmsRow(row), false);
});

test('due scheduled revisions replace the old publication and leave an audit trail', async () => {
  const pool = poolFor({
    document: {
      id: 'doc-3', published_revision_id: 'old-3', scheduled_revision_id: 'scheduled-3',
      scheduled_at: new Date(Date.now() - 60000),
    },
    blocks: [{ type: 'paragraph', text: 'Now published' }],
  });
  const result = await getPublishedBlocksBatch(pool, 'reminder', ['source-3']);
  assert.deepEqual(result.get('source-3'), [{ type: 'paragraph', text: 'Now published' }]);
  const statements = pool.calls.map(({ sql }) => sql);
  assert.ok(statements.findIndex((sql) => /SET status = 'archived'/.test(sql))
    < statements.findIndex((sql) => /SET status = 'published'/.test(sql)));
  assert.ok(statements.some((sql) => /INSERT INTO audit_log/.test(sql)));
});

test('invalid due scheduled assets are archived without replacing the publication', async () => {
  const assetId = '550e8400-e29b-41d4-a716-446655440000';
  const pool = poolFor({
    document: {
      id: 'doc-invalid', published_revision_id: 'old-revision',
      scheduled_revision_id: 'scheduled-invalid', scheduled_at: new Date(Date.now() - 60000),
      scheduled_blocks: [{ type: 'pdf', asset_id: assetId, title: 'Missing file' }],
    },
    blocks: [{ type: 'paragraph', text: 'Previous publication' }],
  });

  const result = await getPublishedBlocksBatch(pool, 'knowledge', ['source-invalid']);
  assert.deepEqual(result.get('source-invalid'), [{ type: 'paragraph', text: 'Previous publication' }]);
  assert.ok(pool.calls.some(({ sql }) => /SET status = 'archived'/.test(sql)));
  assert.ok(pool.calls.some(({ sql }) => /SET scheduled_revision_id = NULL/.test(sql)));
  assert.ok(pool.calls.some(({ sql }) => /cms\.document\.schedule_invalid/.test(sql)));
  assert.equal(pool.calls.some(({ sql }) => /SET status = 'published'/.test(sql)), false);
});

test('invalid due scheduled blocks are archived without entering a promotion loop', async () => {
  const pool = poolFor({
    document: {
      id: 'doc-invalid-blocks', published_revision_id: null,
      scheduled_revision_id: 'scheduled-invalid-blocks', scheduled_at: new Date(Date.now() - 60000),
      scheduled_blocks: [{ type: 'paragraph', text: '<script>bad</script>' }],
    },
  });

  const result = await getPublishedBlocksBatch(pool, 'knowledge', ['source-invalid-blocks']);
  assert.equal(result.get('source-invalid-blocks'), null);
  assert.equal(pool.calls.filter(({ sql }) => /cms\.document\.schedule_invalid/.test(sql)).length, 1);
  assert.equal(pool.calls.some(({ sql }) => /SET status = 'published'/.test(sql)), false);
});

test('invalid published blocks are never returned as raw HTML or script content', async () => {
  const pool = poolFor({
    document: { id: 'doc-1', published_revision_id: 'pub-1' },
    blocks: [{ type: 'paragraph', text: '<script>alert(1)</script>' }],
  });
  const result = await getPublishedBlocksBatch(pool, 'reminder', ['source-1']);
  assert.equal(result.has('source-1'), true);
  assert.equal(result.get('source-1'), null);
});

test('published asset validation rejects missing, incompatible, deleting, and oversized assets', async () => {
  const assetId = '550e8400-e29b-41d4-a716-446655440000';
  const blocks = [{ type: 'pdf', asset_id: assetId, title: 'Guide' }];
  const asset = { id: assetId, mime_type: 'application/pdf', storage_key: 'asset', byte_size: 1, deleting_at: null };
  for (const assets of [
    [],
    [{ ...asset, mime_type: 'image/png' }],
    [{ ...asset, deleting_at: new Date().toISOString() }],
    [{ ...asset, byte_size: 52428801 }],
  ]) {
    const pool = poolFor({
      document: { id: 'doc-asset', published_revision_id: 'pub-asset' },
      blocks,
      assets,
    });
    const result = await getPublishedBlocksBatch(pool, 'knowledge', ['source-1']);
    assert.equal(result.get('source-1'), null);
  }
});

test('batch validation checks shared asset references with one asset query', async () => {
  const assetId = '550e8400-e29b-41d4-a716-446655440000';
  const blocks = [{ type: 'pdf', asset_id: assetId, title: 'Guide' }];
  const pool = poolFor({
    document: { id: 'doc-batch', published_revision_id: 'pub-batch' },
    blocks: [{ type: 'pdf', asset_id: assetId, title: 'Guide' }],
    assets: [{ id: assetId, mime_type: 'application/pdf', storage_key: 'asset', byte_size: 1, deleting_at: null }],
  });
  const result = await addPublishedBlocks(pool, [
    { id: 'source-1', title: 'One' },
    { id: 'source-2', title: 'Two' },
  ], 'knowledge');
  assert.deepEqual(result.map(row => row.content_blocks), [blocks, blocks]);
  assert.equal(pool.calls.filter(({ sql }) => /FROM cms_assets/.test(sql)).length, 1);
});

test('validated body projection never falls back to legacy text for managed content', () => {
  assert.equal(publishedBodyText({
    cms_managed: true,
    content: 'Legacy body',
    content_blocks: [{ type: 'paragraph', text: '<script>bad</script>' }],
  }), '');
  assert.equal(publishedBodyText({
    cms_managed: true,
    content: 'Legacy body',
    content_blocks: [{ type: 'paragraph', text: 'Published body' }],
  }), 'Published body');
  assert.equal(publishedBodyText({ content: 'Legacy body' }), 'Legacy body');
});

test('area mappings preserve legacy rows and add content_blocks only when published', async () => {
  const routeFiles = {
    knowledge: 'api/routes/knowledge.js',
    academy: 'api/routes/academy.js',
    benefit: 'api/routes/benefits.js',
    reminder: 'api/routes/reminders.js',
  };
  for (const [contentType, file] of Object.entries(routeFiles)) {
    const source = await readFile(file, 'utf8');
    assert.match(source, new RegExp(`addPublishedBlocks\\(pool, [^,]+, ['"]${contentType}['"]\\)`), contentType);
    assert.match(source, /content_blocks|addPublishedBlocks/, contentType);
  }
  const reader = await readFile('api/cms/reader.js', 'utf8');
  assert.match(reader, /getPublishedBlocksBatch/);
  assert.match(reader, /getPublishedBlocksBatch\(pool, contentType, rows\.map/);
  assert.doesNotMatch(reader, /getPublishedBlocks\(pool/);
  assert.doesNotMatch(reader, /Promise\.all\(rows\.map/);
  const legacy = { id: 'legacy', title: 'Legacy' };
  const fallbackPool = poolFor();
  assert.deepEqual(await addPublishedBlocks(fallbackPool, [legacy], 'knowledge'), [legacy]);
});

test('announcements require authentication and query published revisions only', async () => {
  const [route, index] = await Promise.all([
    readFile('api/routes/announcements.js', 'utf8'),
    readFile('api/index.js', 'utf8'),
  ]);
  assert.match(route, /router\.get\('\/', authMiddleware/);
  assert.match(route, /listPublishedAnnouncements/);
  assert.match(index, /app\.use\('\/api\/announcements', require\('\.\/routes\/announcements'\)\)/);

  const pool = poolFor({
    document: {
      id: 'announcement-1', title: 'Visible', published_revision_id: 'published-1',
      published_revision_status: 'published',
    },
    blocks: [{ type: 'heading', text: '  Visible  ' }],
  });
  const result = await listPublishedAnnouncements(pool, 50, 0);
  assert.equal(result.rows[0].id, 'announcement-1');
  assert.deepEqual(result.rows[0].content_blocks, [{ type: 'heading', text: 'Visible', level: 2 }]);
  assert.ok(pool.calls.some(({ sql }) => /r\.status = 'published'/.test(sql)));
  assert.ok(pool.calls.some(({ sql }) => /d\.content_type = 'announcement'/.test(sql)));
});

test('announcement detail is authenticated and published-only', async () => {
  const route = await readFile('api/routes/announcements.js', 'utf8');
  const reader = await readFile('api/cms/reader.js', 'utf8');
  assert.match(route, /router\.get\('\/:id', authMiddleware/);
  assert.match(route, /uuid\(req\.params\.id\)/);
  assert.match(route, /getPublishedAnnouncement/);
  assert.match(reader, /JOIN cms_revisions r[\s\S]*ON r\.id = d\.published_revision_id AND r\.status = 'published'[\s\S]*WHERE d\.id = \$1 AND d\.content_type = 'announcement'/);
  assert.doesNotMatch(reader, /getPublishedAnnouncement[\s\S]*draft_revision_id/);
});

test('announcement detail returns normalized published blocks', async () => {
  const pool = poolFor({
    document: {
      id: 'announcement-1', title: 'Visible', published_revision_id: 'published-1',
      published_revision_status: 'published',
    },
    blocks: [{ type: 'heading', text: '  Visible  ' }],
  });
  const result = await getPublishedAnnouncement(pool, 'announcement-1');
  assert.deepEqual(result.content_blocks, [{ type: 'heading', text: 'Visible', level: 2 }]);
});

test('announcement list discards rows unpublished before the final locked recheck', async () => {
  const pool = poolFor({
    document: {
      id: 'announcement-removed', title: 'Removed', published_revision_id: 'published-removed',
      published_revision_status: 'published',
    },
    blocks: [{ type: 'paragraph', text: 'Must not return' }],
    removeOnRecheck: true,
  });
  const result = await listPublishedAnnouncements(pool, 50, 0);
  assert.deepEqual(result, { count: 0, rows: [] });
  const recheckIndex = pool.calls.findIndex(({ sql }) => /FOR UPDATE OF d, r/.test(sql));
  const lockIndex = pool.calls.findIndex(({ sql }) => /pg_advisory_xact_lock/.test(sql));
  assert.ok(lockIndex >= 0 && lockIndex < recheckIndex);
});

test('announcement detail returns no row when unpublished before the final locked recheck', async () => {
  const pool = poolFor({
    document: {
      id: 'announcement-removed', title: 'Removed', published_revision_id: 'published-removed',
      published_revision_status: 'published',
    },
    blocks: [{ type: 'paragraph', text: 'Must not return' }],
    removeOnRecheck: true,
  });
  assert.equal(await getPublishedAnnouncement(pool, 'announcement-removed'), null);
  assert.ok(pool.calls.some(({ sql }) => /FOR UPDATE OF d, r/.test(sql)));
});

test('announcement detail discards a response when its published revision changes', async () => {
  const pool = poolFor({
    document: {
      id: 'announcement-revised', title: 'Revised', published_revision_id: 'published-old',
      published_revision_status: 'published',
    },
    recheckDocument: {
      id: 'announcement-revised', published_revision_id: 'published-new',
      published_revision_status: 'published',
    },
    blocks: [{ type: 'paragraph', text: 'Old body' }],
  });
  assert.equal(await getPublishedAnnouncement(pool, 'announcement-revised'), null);
});

test('announcement readers return no row when the pointer is not published', async () => {
  const pool = poolFor({
    document: {
      id: 'announcement-draft', title: 'Draft', published_revision_id: 'draft-1',
      published_revision_status: 'draft',
    },
    blocks: [],
  });
  assert.deepEqual((await listPublishedAnnouncements(pool, 50, 0)).rows, []);
  assert.equal(await getPublishedAnnouncement(pool, 'announcement-draft'), null);
});
