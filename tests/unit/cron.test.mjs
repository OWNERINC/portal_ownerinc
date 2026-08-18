import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { promoteScheduledRevisions, reminderForDelivery } = require('../../cron/checkReminders');

test('scheduled promotion is transactional, archives before publishing, and audits', async () => {
  const calls = [];
  const db = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT d\.id, d\.published_revision_id/.test(sql)) {
        return { rows: [{ id: 'doc-1', published_revision_id: 'old-1', scheduled_revision_id: 'new-1' }] };
      }
      return { rows: [] };
    },
  };

  assert.equal(await promoteScheduledRevisions(db, new Date('2026-08-17T12:00:00Z')), 1);
  const sql = calls.map(({ sql: statement }) => statement);
  assert.equal(sql[0], 'BEGIN');
  assert.ok(sql.findIndex((statement) => /SET status = 'archived'/.test(statement))
    < sql.findIndex((statement) => /SET status = 'published'/.test(statement)));
  assert.ok(sql.some((statement) => /UPDATE cms_documents/.test(statement)));
  assert.ok(sql.some((statement) => /INSERT INTO audit_log/.test(statement)));
  assert.equal(sql.at(-1), 'COMMIT');
});

test('cron uses published reminder blocks for text while keeping delivery controls', async () => {
  const source = await readFile('cron/checkReminders.js', 'utf8');
  assert.match(source, /blocksToText\(reminder\.cms_blocks\)/);
  assert.match(source, /LEFT JOIN cms_documents/);
  assert.match(source, /revision\.status = 'published'/);
  assert.match(source, /claim\(db, reminder\.id, user\.uid, scheduledDate, channel\)/);
  assert.match(source, /resolveTargets\(reminder\.target_users, users\)/);
  assert.match(source, /channelsFor\(reminder\.channel\)/);
  assert.match(source, /notifications_log/);
});

test('cron keeps legacy reminder text when published blocks render empty', () => {
  const reminder = { description: 'Legacy description', cms_blocks: [{ type: 'divider' }] };
  assert.equal(reminderForDelivery(reminder), reminder);
  assert.equal(reminderForDelivery({
    ...reminder,
    cms_blocks: [{ type: 'image', asset_id: '550e8400-e29b-41d4-a716-446655440000', alt: 'Banner' }],
  }).description, 'Legacy description');
  assert.equal(reminderForDelivery({
    ...reminder,
    cms_blocks: [{ type: 'paragraph', text: 'Published description' }],
  }).description, 'Published description');
});

test('cron image contains the shared CMS reader at its actual import path', async () => {
  const [compose, dockerfile, workflow, cronSource, reader, blocks] = await Promise.all([
    readFile('docker-compose.yml', 'utf8'),
    readFile('cron/Dockerfile', 'utf8'),
    readFile('.github/workflows/ci.yml', 'utf8'),
    readFile('cron/checkReminders.js', 'utf8'),
    readFile('api/cms/reader.js', 'utf8'),
    readFile('api/cms/blocks.js', 'utf8'),
  ]);
  assert.match(compose, /context: \.[\s\S]*dockerfile: cron\/Dockerfile/);
  assert.match(workflow, /docker build --tag ownerinc-portal-cron:\$\{GITHUB_SHA\} --file cron\/Dockerfile \./);
  assert.doesNotMatch(workflow, /docker build --tag ownerinc-portal-cron:\$\{GITHUB_SHA\} cron\s*$/m);
  assert.match(dockerfile, /COPY --chown=node:node api\/cms\/ \/api\/cms\//);
  assert.match(cronSource, /require\('\.\.\/api\/cms\/reader'\)/);
  assert.match(reader, /require\('\.\/blocks'\)/);
  assert.match(blocks, /function blocksToText/);
});
