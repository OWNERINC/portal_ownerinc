import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const sourceFiles = [
  'api/index.js', 'api/middleware/policy.js', 'api/middleware/validation.js',
  'api/db/schema.sql', 'api/db/provision.js', 'cron/retention.js',
  'public/admin.html', 'public/js/admin.js', '.env.example', 'docker-compose.yml',
];

test('Ombudsman route, page, permission, table, grants, and retention are absent from active source', async () => {
  await assert.rejects(access('api/routes/ombudsman.js'));
  await assert.rejects(access('public/ombudsman.html'));
  await assert.rejects(access('public/js/ombudsman.js'));
  const source = (await Promise.all(sourceFiles.map((file) => readFile(file, 'utf8')))).join('\n');
  assert.doesNotMatch(source, /ombudsman|Ouvidoria|viewOmbudsman|OMBUDSMAN/i);
  assert.match(source, /audit_log/);
  assert.match(source, /notifications_log/);
});

test('migration 016 is numbered, destructive, and idempotent', async () => {
  const migration = await readFile('api/db/migrations/016_remove_ombudsman.sql', 'utf8');
  assert.match(migration, /permissions = permissions - 'viewOmbudsman'/i);
  assert.match(migration, /DROP INDEX IF EXISTS ombudsman_workflow_idx;/i);
  assert.match(migration, /DROP TABLE IF EXISTS ombudsman CASCADE;/i);
  assert.equal((migration.match(/DROP TABLE IF EXISTS ombudsman CASCADE;/gi) || []).length, 1);
});
