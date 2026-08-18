import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const forbiddenSurface = /ombudsman|Ouvidoria|ouvidoria|viewOmbudsman/i;
const explicitlyExcluded = new Map([
  ['api/db/migrations/001_initial_schema.sql', 'historical schema migration'],
  ['api/db/migrations/003_governance.sql', 'historical schema migration'],
  ['api/db/migrations/016_remove_ombudsman.sql', 'intentional removal migration'],
  ['api/db/verify-migrations.js', 'intentional release-gate removal assertion'],
  ['scripts/test-migrations.mjs', 'intentional removal integration test'],
  ['tests/unit/ombudsman-removal.test.mjs', 'the invariant being executed'],
  ['tests/unit/api-security.test.mjs', 'specific negative permission invariant'],
  ['tests/unit/frontend-invariants.test.mjs', 'specific negative frontend invariant'],
  ['tests/unit/schema-invariants.test.mjs', 'specific negative schema invariant'],
  ['docs/reports/2026-08-18-ombudsman-removal.md', 'the removal report'],
]);

// Dated audits, reports, designs, and plans preserve historical state rather than current contracts.
const isDatedHistoricalDocument = (file) => /^docs\/(?:reviews|reports|design|superpowers\/plans)\/\d{4}-\d{2}-\d{2}-.+/.test(file)
  || /^\.superpowers\/sdd\/\d{4}-\d{2}-\d{2}-.+/.test(file);
const isGeneratedArtifact = (file) => /(^|\/)\.worktrees(\/|$)/.test(file);

const isCurrentSurfaceFile = (file) => !explicitlyExcluded.has(file)
  && !isDatedHistoricalDocument(file)
  && !isGeneratedArtifact(file);

const trackedCurrentSurface = async () => {
  // git ls-files limits this to tracked files, so untracked artifacts cannot enter the scan.
  const { stdout } = await execFileAsync('git', ['-C', repositoryRoot, 'ls-files', '-z'], { encoding: 'utf8' });
  return stdout.split('\0').filter(Boolean).filter(isCurrentSurfaceFile);
};

const surfaceSentinels = [
  '.codex/config.toml', '.env.example', 'api/db/docker-entrypoint.sh',
  'api/db/schema.sql', 'api/Dockerfile', 'deploy.sh', 'docs/product/brief.md',
  'firebase-emulator/Dockerfile', 'nginx/nginx.conf', 'ops/deploy-from-ci.sh',
  'public/assets/icon-branco.svg', 'public/autocard/styles.css',
  'scripts/backup.sh', 'tests/unit/api-routes.test.mjs', '.github/workflows/ci.yml',
];

test('Ombudsman route, page, permission, table, grants, and retention are absent from active source', async () => {
  await assert.rejects(access('api/routes/ombudsman.js'));
  await assert.rejects(access('public/ombudsman.html'));
  await assert.rejects(access('public/js/ombudsman.js'));
  const sourceFiles = await trackedCurrentSurface();
  assert.deepEqual(surfaceSentinels.filter((file) => !sourceFiles.includes(file)), []);
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
  const verification = await readFile('api/db/verify-migrations.js', 'utf8');
  assert.match(verification, /to_regclass\('public\.ombudsman'\) AS ombudsman/);
  assert.match(verification, /to_regclass\('public\.ombudsman_workflow_idx'\) AS ombudsman_workflow_idx/);
  assert.match(verification, /Ombudsman removal schema\/runtime checks are incomplete/);
});
