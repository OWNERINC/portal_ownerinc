import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

test('committed browser editor and MIT notices exactly match pinned, reproducible build (read-only)', async () => {
  const result = spawnSync(process.execPath, ['scripts/build-pages.mjs','--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /no writes/);
  const notices = await readFile('public/pages/vendor/LICENSES.txt', 'utf8');
  assert.doesNotMatch(notices, /\r/, 'generated notices use LF just like the committed Git blob');
});

test('Pages migration mirrors bootstrap structure, remains outside bootstrap ledger, and grants no cron or mutable revision access', async () => {
  const [migration, schema, provision] = await Promise.all(['api/db/migrations/040_pages.sql','api/db/schema.sql','api/db/provision.js'].map(file => readFile(file,'utf8')));
  const start = 'CREATE TABLE IF NOT EXISTS pages (';
  const normalize = value => value.replace(/^--.*$/gm,'').replace(/\n+/g,'\n').trim();
  assert.equal(normalize(schema.slice(schema.indexOf(start), schema.indexOf('-- The legacy catalog seed'))), normalize(migration.slice(migration.indexOf(start), migration.lastIndexOf('DO $$ BEGIN'))));
  assert.doesNotMatch(schema, /\('040_pages'\)/);
  assert.doesNotMatch(schema, /\('041_pages_media'\)/);
  assert.match(provision, /GRANT SELECT, INSERT, UPDATE ON pages TO portal_api/);
  assert.match(provision, /GRANT SELECT, INSERT ON page_revisions, page_revision_job_titles, page_media, page_revision_media, page_requests TO portal_api/);
  assert.doesNotMatch(provision, /GRANT[^;]*\bpages\b[^;]*TO portal_cron/);
  assert.match(migration, /FOREIGN KEY\(page_id, media_id\) REFERENCES page_media\(page_id, id\)/);
});
test('041 expands only Pages with null-safe typed metadata and preserves append-only grants', async () => {
  const source = await readFile('api/db/migrations/041_pages_media.sql','utf8');
  assert.match(source, /schema_version IN \(1,2\)/);
  assert.match(source, /ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'image'/);
  assert.match(source, /duration_ms BETWEEN 1 AND 600000/);
  assert.match(source, /\) IS TRUE\)/);
  assert.doesNotMatch(source.replace(/^--.*$/gm,''), /\bGRANT\b|\bREVOKE\b|UPDATE\s+(?:page_revisions|page_media)|\bDELETE\b|DROP TABLE/i);
});
