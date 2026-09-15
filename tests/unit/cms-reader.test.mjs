import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  addPublishedBlocks, getPublishedAnnouncement, getPublishedBlocksBatch,
  listPublishedAnnouncements, publishedBodyText,
} = require('../../api/cms/reader');

function poolFor({ document, blocks = [], assets = [] } = {}) {
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
      if (/FROM cms_assets/.test(sql)) return { rows: assets };
      if (/SELECT d\.source_id, r\.blocks/.test(sql)) {
        if (!document?.id) return { rows: [] };
        return { rows: (params[1] || []).map((sourceId) => ({
          source_id: sourceId,
          document_id: document.id,
          blocks: document.published_revision_id
            && (document.published_revision_status || 'published') === 'published' ? blocks : null,
        })) };
      }
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: 1 }] };
      if (/SELECT d\.id, d\.title/.test(sql)) {
        const published = document?.published_revision_id
          && (document.published_revision_status || 'published') === 'published';
        return {
          rows: published
            ? [{ id: document.id, title: document.title, category: '', published_at: null, blocks }]
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
  assert.equal(pool.connections, 1);
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
    blocks: [],
  });
  const result = await listPublishedAnnouncements(pool, 50, 0);
  assert.equal(result.rows[0].id, 'announcement-1');
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
