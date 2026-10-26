import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  addPublishedBlocks, getPublishedAnnouncement, getPublishedBlocksBatch,
  isPublicCmsRow, listPublishedAnnouncementCategories, listPublishedAnnouncements, publishedBodyText,
} = require('../../api/cms/reader');

function poolFor({ document, blocks = [], assets = [], sourceExists = true, sourceActive = true,
  recheckSourceActive = sourceActive, removeOnRecheck = false, recheckDocument = document } = {}) {
  const calls = [];
  let connections = 0;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM owner_news_authority')) return { rows: [{ mode: 'legacy', epoch: 1 }] };
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
      if (/FROM (knowledge_base|academy|academy_lessons|benefits|reminders) s/.test(sql)) {
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
            ? [{ id: document.id, title: document.title, category: '', published_at: document.published_at ?? null,
              published_revision_id: document.published_revision_id, blocks, editorial: document.editorial }]
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

test('lesson reader suppresses legacy fallback and rechecks ancestor activity', async () => {
  const source = { id: 'lesson', active: true, description: 'Legacy' };
  const draft = poolFor({ document: { id: 'document' } });
  const [unpublished] = await addPublishedBlocks(draft, [source], 'academy_lesson');
  assert.equal(unpublished.description, '');
  assert.equal(isPublicCmsRow(unpublished), false);
  const pool = poolFor({ document: { id: 'document', published_revision_id: 'published' },
    blocks: [{ type: 'paragraph', text: 'Material' }], recheckSourceActive: false });
  const [inactive] = await addPublishedBlocks(pool, [source], 'academy_lesson');
  assert.equal(isPublicCmsRow(inactive), false);
  const projections = pool.calls.filter(({ sql }) => /FROM academy_lessons s/.test(sql));
  assert.equal(projections.length, 2);
  for (const { sql } of projections) assert.match(sql, /s.active AND EXISTS[\s\S]*m.id = s.module_id AND m.active = TRUE AND a.active = TRUE/);
  const published = poolFor({ document: { id: 'document', published_revision_id: 'published' }, blocks: [] });
  const [visible] = await addPublishedBlocks(published, [source], 'academy_lesson');
  assert.equal(visible.description, '');
  assert.deepEqual(visible.content_blocks, []);
  assert.equal(isPublicCmsRow(visible), true);
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
    academy: 'api/academy/catalog.js',
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
  const [route, index, backend] = await Promise.all([
    readFile('api/routes/announcements.js', 'utf8'),
    readFile('api/index.js', 'utf8'),
    readFile('api/owner-news/backend.js', 'utf8'),
  ]);
  assert.match(route, /authenticate = authMiddleware/);
  assert.ok(route.indexOf('router.use(authenticate)') < route.indexOf("router.get('/',"));
  assert.match(backend, /listPublishedAnnouncements/);
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
  assert.match(route, /authenticate = authMiddleware/);
  assert.ok(route.indexOf('router.use(authenticate)') < route.indexOf("router.get('/:id',"));
  assert.match(route, /uuid\(req\.params\.id\)/);
  assert.match(await readFile('api/owner-news/backend.js', 'utf8'), /getPublishedAnnouncement/);
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

test('legacy announcement DTO canonicalizes PostgreSQL Date timestamps and rejects invalid timestamp types', async () => {
  const instant = new Date('2026-10-26T12:34:56.789Z');
  const valid = poolFor({ document: { id: 'announcement-date', title: 'Dated', published_at: instant,
    published_revision_id: 'published-date', published_revision_status: 'published' }, blocks: [{ type: 'paragraph', text: 'Body' }] });
  assert.equal((await listPublishedAnnouncements(valid, 1, 0)).rows[0].published_at, instant.toISOString());

  const invalid = poolFor({ document: { id: 'announcement-date', title: 'Dated', published_at: 123,
    published_revision_id: 'published-date', published_revision_status: 'published' }, blocks: [{ type: 'paragraph', text: 'Body' }] });
  await assert.rejects(listPublishedAnnouncements(invalid, 1, 0), /invalid_published_at/);
});

test('legacy lookahead uses bounded keyset chunks and continues past invalid and unstable rows', async () => {
  const newsId = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const raw = Array.from({ length: 103 }, (_, index) => ({
    id: newsId(index + 1), title: `Row ${index + 1}`, category: 'News',
    published_at: new Date(Date.UTC(2026, 0, 2, 0, 0, 0, -index)),
    published_revision_id: newsId(index + 1000), editorial: null,
    blocks: index < 100 ? [{ type: 'unknown' }] : [{ type: 'paragraph', text: `Body ${index + 1}` }],
  }));
  let reads = 0;
  const calls = [];
  const pool = {
    async connect() {
      return { release() {}, async query(sql, params = []) {
        calls.push({ sql, params });
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (sql.includes('FROM owner_news_authority')) return { rows: [{ mode: 'legacy', epoch: 1 }] };
        if (sql.includes("scheduled.status = 'scheduled'")) return { rows: [] };
        if (sql.includes('SELECT d.id, d.title')) {
          reads++;
          return { rows: raw.slice((reads - 1) * 4, reads * 4) };
        }
        if (sql.includes('FOR UPDATE OF d, r')) {
          return { rows: params[0].filter(value => value !== newsId(102)).map(value => ({
            id: value, published_revision_id: raw.find(row => row.id === value).published_revision_id,
          })) };
        }
        throw new Error(`Unexpected query: ${sql}`);
      } };
    },
  };
  const result = await listPublishedAnnouncements(pool, 2, 0, undefined, undefined, null,
    { exactTotal: false, scan: { maxRawRows: 101000, maxBatches: 1000 } });
  assert.deepEqual(result.rows.map(row => row.id), [newsId(101), newsId(103)]);
  assert.equal(result.count, 2);
  assert.deepEqual(result.scan, { rawRows: 103, batches: 26 });
  assert.equal(reads, 26);
  const selects = calls.filter(call => call.sql.includes('SELECT d.id, d.title'));
  assert.equal(selects.length, 26);
  assert.ok(selects.every(call => /date_trunc\('milliseconds', d\.published_at\) AS published_at_ms/u.test(call.sql)));
  assert.ok(selects.every(call => /ORDER BY date_trunc\('milliseconds', d\.published_at\) DESC NULLS LAST, d\.id\s+LIMIT \$\d+/u.test(call.sql)));
  assert.ok(selects.every(call => call.params.at(-1) === 4));
  assert.match(selects[1].sql, /date_trunc\('milliseconds', d\.published_at\) < \$1::timestamptz/u);
  assert.doesNotMatch(selects[1].sql, /OFFSET/u);
});

test('legacy private scan allowance caps SQL limit and stops before a second batch', async () => {
  const row = { id: '10000000-0000-4000-8000-000000000001', title: 'Invalid', category: '', published_at: new Date('2026-10-01T00:00:00Z'),
    published_revision_id: '10000000-0000-4000-8000-000000001001', editorial: null, blocks: [{ type: 'unknown' }] };
  const selects = [];
  const pool = { async connect() { return { release() {}, async query(sql, params = []) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM owner_news_authority')) return { rows: [{ mode: 'legacy', epoch: 1 }] };
    if (sql.includes("scheduled.status = 'scheduled'")) return { rows: [] };
    if (sql.includes('SELECT d.id, d.title')) { selects.push({ sql, params }); return { rows: [row].slice(0, params.at(-1)) }; }
    throw new Error(`Unexpected query: ${sql}`);
  } }; } };
  await assert.rejects(listPublishedAnnouncements(pool, 101, 0, undefined, 'article', null,
    { exactTotal: false, scan: { maxRawRows: 1, maxBatches: 1 } }), /announcement_scan_limit/);
  assert.equal(selects.length, 1);
  assert.equal(selects[0].params.at(-1), 1);
});

test('legacy list enforces aggregate DTO bytes and SQL never returns more than four raw documents', async () => {
  const newsId = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const largeBlocks = Array.from({ length: 100 }, () => ({ type: 'paragraph', text: 'x'.repeat(5000) }));
  const rows = Array.from({ length: 70 }, (_, index) => ({ id: newsId(index + 1), title: `Large ${index + 1}`, category: 'News',
    published_at: new Date(Date.UTC(2026, 0, 2, 0, 0, 0, -index)), published_revision_id: newsId(index + 1000), editorial: null, blocks: largeBlocks }));
  let reads = 0; const selects = [];
  const pool = { async connect() { return { release() {}, async query(sql, params = []) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM owner_news_authority')) return { rows: [{ mode: 'legacy', epoch: 1 }] };
    if (sql.includes("scheduled.status = 'scheduled'")) return { rows: [] };
    if (sql.includes('SELECT d.id, d.title')) { selects.push({ sql, params }); const start = reads++ * 4; return { rows: rows.slice(start, start + 4) }; }
    if (sql.includes('FOR UPDATE OF d, r')) return { rows: params[0].map(value => ({ id: value,
      published_revision_id: rows.find(row => row.id === value).published_revision_id })) };
    throw new Error(`Unexpected query: ${sql}`);
  } }; } };
  await assert.rejects(listPublishedAnnouncements(pool, 101, 0, undefined, undefined, null, { exactTotal: false }), /announcement_response_limit/);
  assert.ok(selects.length > 1);
  assert.ok(selects.every(call => call.params.at(-1) === 4));
});

test('legacy categories stream and discard four-row SQL chunks while preserving exact validated counts', async () => {
  const newsId = n => `40000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const rows = Array.from({ length: 9 }, (_, index) => ({ id: newsId(index + 1), title: `Category ${index + 1}`, category: index % 2 ? 'B' : 'A',
    published_at: new Date(Date.UTC(2026, 0, 2, 0, 0, 0, -index)), published_revision_id: newsId(index + 1000), editorial: null,
    blocks: [{ type: 'paragraph', text: `Body ${index + 1}` }] }));
  let reads = 0; const selects = [];
  const pool = { async connect() { return { release() {}, async query(sql, params = []) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM owner_news_authority')) return { rows: [{ mode: 'legacy', epoch: 1 }] };
    if (sql.includes("scheduled.status = 'scheduled'")) return { rows: [] };
    if (sql.includes('SELECT d.id, d.title')) { selects.push({ sql, params }); const start = reads++ * 4; return { rows: rows.slice(start, start + 4) }; }
    if (sql.includes('FOR UPDATE OF d, r')) return { rows: params[0].map(value => ({ id: value,
      published_revision_id: rows.find(row => row.id === value).published_revision_id })) };
    throw new Error(`Unexpected query: ${sql}`);
  } }; } };
  assert.deepEqual(await listPublishedAnnouncementCategories(pool, { withCounts: true }), {
    total: 9, categories: [{ name: 'A', count: 5 }, { name: 'B', count: 4 }],
  });
  assert.equal(selects.length, 3);
  assert.ok(selects.every(call => call.params.at(-1) === 4));
  assert.match(selects[1].sql, /date_trunc\('milliseconds', d\.published_at\) < \$1::timestamptz/u);
});

test('legacy categories fail closed at the cumulative raw-row and batch budget', async () => {
  const newsId = n => `50000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  let reads = 0;
  const pool = { async connect() { return { release() {}, async query(sql, params = []) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.includes('FROM owner_news_authority')) return { rows: [{ mode: 'legacy', epoch: 1 }] };
    if (sql.includes("scheduled.status = 'scheduled'")) return { rows: [] };
    if (sql.includes('SELECT d.id, d.title')) {
      const start = reads++ * 4 + 1;
      return { rows: Array.from({ length: 4 }, (_, index) => ({ id: newsId(start + index), title: 'Category', category: 'A',
        published_at: new Date(Date.UTC(2026, 0, 2, 0, 0, 0, -(start + index))), published_revision_id: newsId(start + index + 5000),
        editorial: null, blocks: [{ type: 'paragraph', text: 'Body' }] })) };
    }
    if (sql.includes('FOR UPDATE OF d, r')) return { rows: params[0].map(value => ({ id: value,
      published_revision_id: newsId(Number(value.slice(-12)) + 5000) })) };
    throw new Error(`Unexpected query: ${sql}`);
  } }; } };
  await assert.rejects(listPublishedAnnouncementCategories(pool, { withCounts: true }), /announcement_scan_limit/);
  assert.equal(reads, 1000);
});

test('legacy keysets canonicalize sub-millisecond timestamps without skips or duplicates across cursors', async () => {
  const newsId = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const canonical = '2026-10-26T12:34:56.789Z';
  const rows = Array.from({ length: 103 }, (_, index) => ({
    id: newsId(index + 1), title: `Micro ${index + 1}`, category: 'News',
    // These represent distinct PostgreSQL values that collapse to one public millisecond.
    database_published_at: `2026-10-26T12:34:56.789${String(999 - index).padStart(3, '0')}Z`,
    published_at_ms: new Date(canonical), published_revision_id: newsId(index + 1000),
    editorial: null, blocks: [{ type: 'paragraph', text: `Body ${index + 1}` }],
  }));
  assert.equal(new Set(rows.map(row => row.database_published_at)).size, 103);
  assert.ok(rows.every(row => new Date(row.database_published_at).toISOString() === canonical));
  const listCalls = [];
  const pool = {
    async connect() {
      return { release() {}, async query(sql, params = []) {
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (sql.includes('FROM owner_news_authority')) return { rows: [{ mode: 'legacy', epoch: 1 }] };
        if (sql.includes("scheduled.status = 'scheduled'")) return { rows: [] };
        if (sql.includes('SELECT d.id, d.title')) {
          listCalls.push({ sql, params });
          assert.match(sql, /date_trunc\('milliseconds', d\.published_at\) AS published_at_ms/u);
          assert.match(sql, /ORDER BY date_trunc\('milliseconds', d\.published_at\) DESC NULLS LAST, d\.id/u);
          if (sql.includes("date_trunc('milliseconds', d.published_at) IS NULL AND d.id >")) return { rows: [] };
          const boundaryId = params.length === 3 ? params[1] : null;
          return { rows: rows.filter(row => boundaryId === null || row.id > boundaryId).slice(0, params.at(-1))
            .map(({ database_published_at: _databaseTimestamp, ...row }) => row) };
        }
        if (sql.includes('FOR UPDATE OF d, r')) return { rows: params[0].map(value => ({
          id: value, published_revision_id: rows.find(row => row.id === value).published_revision_id,
        })) };
        throw new Error(`Unexpected query: ${sql}`);
      } };
    },
  };

  const first = await listPublishedAnnouncements(pool, 101, 0, undefined, undefined, null, { exactTotal: false });
  assert.equal(first.count, null);
  assert.equal(first.rows.length, 101);
  assert.ok(first.rows.every(row => row.published_at === canonical));
  const last = first.rows.at(-1);
  const boundary = { published_at: last.published_at, source: last.source, id: last.id };
  const second = await listPublishedAnnouncements(pool, 101, 0, undefined, undefined, boundary, { exactTotal: false });
  assert.equal(second.count, 2);
  assert.deepEqual([...first.rows, ...second.rows].map(row => row.id), rows.map(row => row.id));
  assert.equal(new Set([...first.rows, ...second.rows].map(row => row.id)).size, 103);

  const continued = listCalls.at(-1);
  assert.deepEqual(continued.params.slice(0, 2), [canonical, newsId(101)]);
  assert.match(continued.sql, /date_trunc\('milliseconds', d\.published_at\) < \$1::timestamptz/u);
  assert.match(continued.sql, /date_trunc\('milliseconds', d\.published_at\) = \$1::timestamptz AND d\.id > \$2::uuid/u);
  assert.doesNotMatch(continued.sql, /(?<!date_trunc\('milliseconds', )d\.published_at\s*[<=]/u);

  await listPublishedAnnouncements(pool, 1, 0, undefined, undefined,
    { published_at: '2026-10-26T12:34:56.789999Z', source: 'legacy', id: newsId(101) }, { exactTotal: false });
  assert.equal(listCalls.at(-1).params[0], canonical, 'incoming legacy boundaries use the same millisecond precision');

  await listPublishedAnnouncements(pool, 1, 0, undefined, undefined,
    { published_at: null, source: 'legacy', id: newsId(1) }, { exactTotal: false });
  const nullBoundary = listCalls.at(-1);
  assert.match(nullBoundary.sql, /date_trunc\('milliseconds', d\.published_at\) IS NULL AND d\.id > \$1::uuid/u);
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

test('invalid announcement editorial is excluded before pagination, count and detail', async () => {
  const pool = poolFor({ document: { id: 'doc', published_revision_id: 'pub', editorial: { version: 99 } }, blocks: [{ type: 'paragraph', text: 'Texto' }] });
  assert.deepEqual(await listPublishedAnnouncements(pool, 1, 0), { count: 0, rows: [] });
  assert.equal(await getPublishedAnnouncement(pool, 'doc'), null);
});

test('invalid scheduled editorial retires the schedule without touching the later draft or publication', async () => {
  const pool = poolFor({ document: { id: 'doc', content_type: 'announcement', published_revision_id: 'pub', draft_revision_id: 'later', scheduled_revision_id: 'scheduled', scheduled_at: new Date(Date.now() - 60000), scheduled_editorial: { version: 99 } }, blocks: [{ type: 'paragraph', text: 'Texto' }] });
  await listPublishedAnnouncements(pool, 10, 0);
  assert.ok(pool.calls.some(({ sql }) => sql.includes('cms.document.schedule_invalid')));
  assert.equal(pool.calls.some(({ sql }) => sql.includes("SET status = 'published'") || sql.includes('draft_revision_id =')), false);
});

test('published profile assets require image MIME and the effective 50 MiB bound', async () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  for (const [mime, size, valid] of [['image/png', 1, true], ['application/pdf', 1, false], ['image/png', 52428801, false]]) {
    const pool = poolFor({ document: { id: 'doc', published_revision_id: 'pub' }, blocks: [{ type: 'profile', name: 'Pessoa', asset_id: id, alt: 'Retrato' }], assets: [{ id, mime_type: mime, storage_key: 'private', byte_size: size }] });
    assert.equal(Boolean(await getPublishedAnnouncement(pool, 'doc')), valid);
  }
});
