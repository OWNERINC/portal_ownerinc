import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

test('migrations are numbered, ordered, and tracked by a ledger', async () => {
  const files = (await readdir('api/db/migrations')).filter((file) => file.endsWith('.sql')).sort();
  assert.deepEqual(files, ['001_initial_schema.sql', '002_reliable_notifications.sql', '003_governance.sql', '004_operational_hardening.sql', '005_notification_claim_state.sql', '006_user_erasure.sql', '007_solides_employee_links.sql', '008_solides_link_hardening.sql', '009_job_titles.sql', '010_autocard.sql', '011_cron_alert_state.sql', '012_autocard_media_crop.sql']);

  const runner = await readFile('api/db/migrate.js', 'utf8');
  assert.match(runner, /CREATE TABLE IF NOT EXISTS schema_migrations/);
  assert.match(runner, /pg_advisory_lock/);
  assert.match(runner, /BEGIN/);
  assert.match(runner, /INSERT INTO schema_migrations/);
});

test('Sólides links are unique, reviewable, and removed with the Portal user', async () => {
  const [schema, migration, hardening] = await Promise.all([
    readFile('api/db/schema.sql', 'utf8'), readFile('api/db/migrations/007_solides_employee_links.sql', 'utf8'),
    readFile('api/db/migrations/008_solides_link_hardening.sql', 'utf8'),
  ]);
  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS solides_employee_links/);
    assert.match(source, /REFERENCES users\(uid\) ON DELETE CASCADE/);
    assert.match(source, /status IN \('pending', 'verified', 'disabled', 'conflict'\)/);
  }
  for (const source of [schema, hardening]) {
    assert.match(source, /UNIQUE \(employee_id\)/);
    assert.match(source, /employer_scope = 'default'/);
    assert.doesNotMatch(source, /status <> 'verified' OR \(verified_by IS NOT NULL/);
  }
});

test('governance schema matches the upgrade migration', async () => {
  const schema = await readFile('api/db/schema.sql', 'utf8');
  const migration = await readFile('api/db/migrations/003_governance.sql', 'utf8');
  for (const source of [schema, migration]) {
    assert.match(source, /status IN \('new', 'in_review', 'resolved'\)/);
    assert.match(source, /resolved_at/);
    assert.match(source, /assigned_to/);
    assert.match(source, /internal_notes/);
    assert.match(source, /knowledge_base_content_lengths/);
    assert.match(source, /ombudsman_content_lengths/);
    assert.match(source, /notifications_log_history_idx/);
  }
});

test('notification schema enforces one durable occurrence per channel', async () => {
  const schema = await readFile('api/db/schema.sql', 'utf8');
  const migration = await readFile('api/db/migrations/002_reliable_notifications.sql', 'utf8');

  for (const status of ['pending', 'sending', 'sent', 'failed', 'skipped']) assert.match(schema, new RegExp(`'${status}'`));
  assert.match(schema, /UNIQUE \(reminder_id, user_uid, scheduled_date, channel\)/);
  assert.match(schema, /channel IN \('email', 'whatsapp'\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS cron_status/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS audit_log/);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS notifications_log_occurrence_key/);
});

test('cron schema stores deduplicated operational alert state', async () => {
  const schema = await readFile('api/db/schema.sql', 'utf8');
  const migration = await readFile('api/db/migrations/011_cron_alert_state.sql', 'utf8');
  assert.match(schema, /alert_signature/);
  assert.match(schema, /alert_sent_at/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS alert_signature/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS alert_sent_at/);
});

test('AutoCard crop schema is safe for fresh installs and upgrades', async () => {
  const [schema, migration] = await Promise.all([
    readFile('api/db/schema.sql', 'utf8'), readFile('api/db/migrations/012_autocard_media_crop.sql', 'utf8'),
  ]);
  for (const source of [schema, migration]) {
    assert.match(source, /media_crop\s+JSONB/);
    assert.match(source, /\{"x":0\.5,"y":0\.5,"zoom":1\}/);
    assert.match(source, /jsonb_typeof\(media_crop\) = 'object'/);
    assert.match(source, /jsonb_typeof\(media_crop->'x'\) = 'number'/);
    assert.match(source, /jsonb_typeof\(media_crop->'y'\) = 'number'/);
    assert.match(source, /jsonb_typeof\(media_crop->'zoom'\) = 'number'/);
  }
  assert.match(migration, /SET media_crop = '\{"x":0\.5,"y":0\.5,"zoom":1\}'::jsonb\s+WHERE media_crop IS NULL/);
  assert.match(migration, /ALTER COLUMN media_crop SET DEFAULT/);
  assert.match(migration, /ALTER COLUMN media_crop SET NOT NULL/);
  assert.match(schema, /'012_autocard_media_crop'/);
});

test('domain constraints are present on fresh installs and upgrades', async () => {
  const sources = `${await readFile('api/db/schema.sql', 'utf8')}\n${await readFile('api/db/migrations/002_reliable_notifications.sql', 'utf8')}\n${await readFile('api/db/migrations/004_operational_hardening.sql', 'utf8')}`;
  assert.match(sources, /role IN \('viewer', 'admin'\)/);
  assert.match(sources, /contract_type IN \('clt', 'pj'\)/);
  assert.match(sources, /pj_due_day BETWEEN 1 AND 31/);
  assert.match(sources, /channel IN \('email', 'whatsapp', 'both'\)/);
  assert.match(sources, /users_contract_consistency/);
  assert.match(sources, /users_email_unique/);
  assert.match(sources, /ON DELETE SET NULL/);
});

test('job titles are managed independently and remain assigned when deactivated', async () => {
  const [schema, migration] = await Promise.all([
    readFile('api/db/schema.sql', 'utf8'), readFile('api/db/migrations/009_job_titles.sql', 'utf8'),
  ]);
  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS job_titles/);
    assert.match(source, /job_titles_name_lower_unique/);
    assert.match(source, /job_title_id\s+UUID\s+REFERENCES job_titles\(id\) ON DELETE RESTRICT/);
    assert.match(source, /active\s+BOOLEAN\s+NOT NULL DEFAULT TRUE/);
  }
  assert.match(migration, /INSERT INTO job_titles/);
});
