import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  addPublishedBlocks, getPublishedBlocks, listPublishedAnnouncements,
} = require('../../api/cms/reader');

function poolFor({ document, blocks = [] } = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT id, published_revision_id/.test(sql)) return { rows: document ? [document] : [] };
      if (/SELECT blocks/.test(sql)) return { rows: blocks.length ? [{ blocks }] : [] };
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ count: 1 }] };
      if (/SELECT d\.id, d\.title/.test(sql)) return { rows: [{ id: document?.id, title: document?.title, category: '', published_at: null, blocks }] };
      return { rows: [] };
    },
    release() {},
  };
  return {
    calls,
    async connect() {
      return client;
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

  assert.deepEqual(await getPublishedBlocks(pool, 'knowledge', 'source-1'), [
    { type: 'heading', text: 'Published', level: 2 },
  ]);
  assert.equal(pool.calls.filter(({ sql }) => /SELECT blocks/.test(sql)).length, 1);
});

test('draft-only and future scheduled documents use legacy fallback', async () => {
  const draftOnly = poolFor({ document: { id: 'doc-1', draft_revision_id: 'draft-1' } });
  assert.equal(await getPublishedBlocks(draftOnly, 'academy', 'source-1'), null);

  const future = poolFor({ document: {
    id: 'doc-2', published_revision_id: null, scheduled_revision_id: 'scheduled-2',
    scheduled_at: new Date(Date.now() + 60000),
  } });
  assert.equal(await getPublishedBlocks(future, 'benefit', 'source-2'), null);
});

test('due scheduled revisions replace the old publication and leave an audit trail', async () => {
  const pool = poolFor({
    document: {
      id: 'doc-3', published_revision_id: 'old-3', scheduled_revision_id: 'scheduled-3',
      scheduled_at: new Date(Date.now() - 60000),
    },
    blocks: [{ type: 'paragraph', text: 'Now published' }],
  });
  assert.deepEqual(await getPublishedBlocks(pool, 'reminder', 'source-3'), [
    { type: 'paragraph', text: 'Now published' },
  ]);
  const statements = pool.calls.map(({ sql }) => sql);
  assert.ok(statements.findIndex((sql) => /SET status = 'archived'/.test(sql))
    < statements.findIndex((sql) => /SET status = 'published'/.test(sql)));
  assert.ok(statements.some((sql) => /INSERT INTO audit_log/.test(sql)));
});

test('invalid published blocks are never returned as raw HTML or script content', async () => {
  const pool = poolFor({
    document: { id: 'doc-1', published_revision_id: 'pub-1' },
    blocks: [{ type: 'paragraph', text: '<script>alert(1)</script>' }],
  });
  assert.equal(await getPublishedBlocks(pool, 'reminder', 'source-1'), null);
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

  const pool = poolFor({ document: { id: 'announcement-1', title: 'Visible' }, blocks: [] });
  const result = await listPublishedAnnouncements(pool, 50, 0);
  assert.equal(result.rows[0].id, 'announcement-1');
  assert.ok(pool.calls.some(({ sql }) => /r\.status = 'published'/.test(sql)));
  assert.ok(pool.calls.some(({ sql }) => /d\.content_type = 'announcement'/.test(sql)));
});
