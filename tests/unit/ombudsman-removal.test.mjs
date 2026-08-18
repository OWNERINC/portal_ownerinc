import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const forbiddenSurface = /ombudsman|Ouvidoria|ouvidoria|viewOmbudsman/i;
const explicitlyExcluded = new Set([
  // These migrations are immutable historical evidence, not the current schema surface.
  'api/db/migrations/001_initial_schema.sql',
  'api/db/migrations/003_governance.sql',
  // The report and this test must name the removal to verify and explain it.
  'docs/reports/2026-08-18-ombudsman-removal.md',
  'tests/unit/ombudsman-removal.test.mjs',
]);

// Dated audits, reports, designs, and plans preserve historical state rather than current contracts.
const isDatedHistoricalDocument = (file) => /^docs\/(?:reviews|reports|design|superpowers\/plans)\/\d{4}-\d{2}-\d{2}-.+/.test(file);

const isCurrentSurfaceFile = (file) => {
  if (explicitlyExcluded.has(file) || isDatedHistoricalDocument(file)) return false;
  return /^public\/.*\.(?:html|js)$/i.test(file)
    || /^(?:api|cron)\/.*\.js$/i.test(file)
    || file === '.env.example'
    || file === 'docker-compose.yml'
    || /^docs\/(?:product|architecture|operations)\/.+/.test(file);
};

const trackedCurrentSurface = async () => {
  // git ls-files limits this to tracked files, so .worktrees and generated untracked artifacts cannot leak in.
  const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, 'ls-files', '-z'], { encoding: 'utf8' });
  return stdout.split('\0').filter(Boolean).filter(isCurrentSurfaceFile);
};

test('Ombudsman route, page, permission, table, grants, and retention are absent from active source', async () => {
  await assert.rejects(access('api/routes/ombudsman.js'));
  await assert.rejects(access('public/ombudsman.html'));
  await assert.rejects(access('public/js/ombudsman.js'));
  const sourceFiles = await trackedCurrentSurface();
  const source = (await Promise.all(
    sourceFiles.map((file) => readFile(`${repositoryRoot}/${file}`, 'utf8')),
  )).join('\n');
  assert.doesNotMatch(source, forbiddenSurface);
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
