import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import {
  assertApprovedMigrationCluster, assertEmptyMigrationDatabase, requireDisposableMigrationEnvironment,
} from './migration-test-guards.mjs';

const require = createRequire(new URL('../api/package.json', import.meta.url));
require('dotenv').config({ path: new URL('../.env', import.meta.url) });
requireDisposableMigrationEnvironment();

const { Pool } = require('pg');
const { provision, provisionRoles } = require('../api/db/provision');
const { expectedVersions, verifyMigrations } = require('../api/db/verify-migrations');

const representedVersions = new Set([
  '001_initial_schema',
  '002_reliable_notifications',
  '003_governance',
  '004_operational_hardening',
  '005_notification_claim_state',
  '006_user_erasure',
  '007_solides_employee_links',
  '008_solides_link_hardening',
  '009_job_titles',
  '010_autocard',
  '011_cron_alert_state',
  '012_autocard_media_crop',
  '013_job_title_catalog',
  '017_pos_cards',
  '018_pos_card_storage_key',
  '020_profile_photo_crop',
  '021_bulk_user_imports',
  '022_bulk_user_import_validation',
  '023_pos_owner_cards',
  '029_autocard_media_safety',
  '031_contract_invariants',
  '032_user_import_identity',
]);
const nonEditorialMigrations = [
  '016_remove_ombudsman',
  '024_job_title_page_access',
  '025_pending_registrations',
  '026_firebase_enable_pending',
  '027_pending_registration_cleanup',
  '028_firebase_cleanup_queue',
  '030_dho_job_title_catalog',
  '039_ethics_acceptances',
];
const omittedEditorialVersions = [
  '015_cms_editor',
  '019_cms_asset_deletion_state',
  '033_academy_learning',
  '034_owner_news_editorial',
  '035_owner_news_polls',
  '038_disable_legacy_editorial_writes',
];

const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const client = await pool.connect();
try {
  await assertApprovedMigrationCluster(client);
  const existing = await client.query(`SELECT n.nspname AS schema_name, c.relname AS object_name, c.relkind AS object_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND left(n.nspname, 3) <> 'pg_'
    UNION ALL
    SELECT nspname AS schema_name, NULL AS object_name, 'schema' AS object_kind
    FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public')
      AND left(nspname, 3) <> 'pg_'`);
  assertEmptyMigrationDatabase(existing.rows);

  await client.query('BEGIN');
  try {
    await provisionRoles(client);
    await client.query(await readFile(new URL('../api/db/schema.sql', import.meta.url), 'utf8'));
    const schemaLedger = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(
      schemaLedger.rows.map(({ version }) => version),
      [...representedVersions],
      'schema.sql must represent only the non-editorial bootstrap versions in the readiness fixture',
    );
    for (const version of nonEditorialMigrations) {
      await client.query(await readFile(new URL(`../api/db/migrations/${version}.sql`, import.meta.url), 'utf8'));
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        [version],
      );
    }
    for (const version of omittedEditorialVersions) {
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        [version],
      );
    }
    const represented = await client.query('SELECT version FROM schema_migrations ORDER BY version');
    assert.deepEqual(
      represented.rows.map(({ version }) => version),
      expectedVersions,
      'Synthetic readiness ledger must represent schema.sql plus non-editorial migrations and omitted editorial versions',
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  await provision();
  const editorialRelations = await client.query(`SELECT
    to_regclass('public.cms_documents') AS cms_documents,
    to_regclass('public.cms_revisions') AS cms_revisions,
    to_regclass('public.cms_assets') AS cms_assets,
    to_regclass('public.owner_news_home') AS owner_news_home,
    to_regclass('public.owner_news_polls') AS owner_news_polls,
    to_regclass('public.owner_news_poll_options') AS owner_news_poll_options,
    to_regclass('public.owner_news_poll_votes') AS owner_news_poll_votes`);
  assert.deepEqual(editorialRelations.rows, [{
    cms_documents: null,
    cms_revisions: null,
    cms_assets: null,
    owner_news_home: null,
    owner_news_polls: null,
    owner_news_poll_options: null,
    owner_news_poll_votes: null,
  }]);

  await verifyMigrations();
  console.log('migration readiness: no editorial relations; verifier accepted synthetic test ledger');
} finally {
  client.release();
  await pool.end();
}
