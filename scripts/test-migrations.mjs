import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(new URL('../api/package.json', import.meta.url));
require('dotenv').config({ path: new URL('../.env', import.meta.url) });
if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
const { Pool } = require('pg');
const { migrate } = require('../api/db/migrate');

await migrate();
await migrate();

const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const client = await pool.connect();
const fixtureUids = [];
let legacyObjectsCreated = false;
try {
  await client.query(`CREATE TABLE ombudsman (
    id BIGSERIAL PRIMARY KEY,
    message TEXT NOT NULL DEFAULT ''
  )`);
  await client.query('CREATE INDEX ombudsman_workflow_idx ON ombudsman (id)');
  legacyObjectsCreated = true;

  const permissionFixtureUid = `migration-fixture-permissions-${randomUUID()}`;
  fixtureUids.push(permissionFixtureUid);
  await client.query(`INSERT INTO users (uid, email, name, permissions)
    VALUES ($1, $2, $3, $4::jsonb)`, [
    permissionFixtureUid,
    `${permissionFixtureUid}@example.com`,
    'Migration Fixture Permissions',
    JSON.stringify({ viewOmbudsman: true, viewDashboard: true }),
  ]);
  const removalMigration = await readFile(
    new URL('../api/db/migrations/016_remove_ombudsman.sql', import.meta.url),
    'utf8',
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await client.query('BEGIN');
    try {
      await client.query(removalMigration);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  const permissionFixture = await client.query(
    'SELECT permissions FROM users WHERE uid = $1',
    [permissionFixtureUid],
  );
  assert.deepEqual(permissionFixture.rows[0]?.permissions, { viewDashboard: true });
  const removedObjects = await client.query(`SELECT to_regclass('public.ombudsman') AS ombudsman,
    to_regclass('public.ombudsman_workflow_idx') AS ombudsman_workflow_idx`);
  assert.equal(removedObjects.rows[0].ombudsman, null);
  assert.equal(removedObjects.rows[0].ombudsman_workflow_idx, null);

  const versions = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(versions.rows.map(({ version }) => version), [
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
    '015_cms_editor',
    '016_remove_ombudsman',
    '017_pos_cards',
    '018_pos_card_storage_key',
    '019_cms_asset_deletion_state',
    '020_profile_photo_crop',
    '021_bulk_user_imports',
    '022_bulk_user_import_validation',
  ]);
  const canonicalNames = [
    'Analista Administrativo', 'Analista de Cobrança', 'Analista de Engenharia',
    'Analista de Pós-Vendas', 'Analista de RH Sênior',
    'Analista de Departamento Pessoal', 'Analista Financeiro',
    'Analista Financeiro Sênior', 'Assistente Administrativo',
    'Auxiliar de Limpeza', 'CEO', 'Consultor de Vendas',
    'Consultora de Pós-Vendas', 'Consultora de Pós-Vendas Júnior',
    'Consultora de Pós-Vendas Pleno', 'Coordenador Central de Férias',
    'Coordenador de Compras', 'Coordenador de Contratos', 'Coordenador de Sala',
    'Coordenador Financeiro', 'Coordenador de Pós-Vendas',
    'Coordenadora Administrativa', 'Coordenadora de Planejamento',
    'Coordenadora de Projetos', 'Coordenadora de Vendas', 'Design',
    'Diretor Comercial', 'Diretor de Incorporação', 'Diretor de Marketing',
    'Engenheiro Civil', 'Especialista de Controladoria',
    'Especialista de Marketing', 'Garçom', 'Garçom Sênior', 'Garçonete',
    'Gerente Administrativo', 'Gerente Comercial', 'Gerente de Marketing',
    'Gerente de Obra', 'Gerente de Pós-Vendas', 'Gerente de Promoção',
    'Gerente de RH', 'Jovem Aprendiz', 'Líder de Promoção', 'Motorista',
    'Promotor de Vendas', 'Recepcionista', 'Redator', 'SDR', 'Social Media',
  ];
  const legacyTitles = await pool.query(`SELECT id, name FROM job_titles
    WHERE lower(name) IN ('analista de dho', 'gerente de dho')`);
  const legacyTitleIds = new Map(legacyTitles.rows.map(({ name, id }) => [name, id]));
  assert.ok(legacyTitleIds.has('Analista de DHO'));
  assert.ok(legacyTitleIds.has('Gerente de DHO'));
  const fixtureUsers = [
    {
      uid: `migration-fixture-analista-${randomUUID()}`,
      email: `migration-fixture-analista-${randomUUID()}@example.com`,
      name: 'Migration Fixture Analista DHO',
      jobTitleId: legacyTitleIds.get('Analista de DHO'),
    },
    {
      uid: `migration-fixture-gerente-${randomUUID()}`,
      email: `migration-fixture-gerente-${randomUUID()}@example.com`,
      name: 'Migration Fixture Gerente DHO',
      jobTitleId: legacyTitleIds.get('Gerente de DHO'),
    },
  ];
  for (const user of fixtureUsers) {
    fixtureUids.push(user.uid);
    await pool.query(`INSERT INTO users (uid, email, name, job_title_id)
      VALUES ($1, $2, $3, $4)`, [user.uid, user.email, user.name, user.jobTitleId]);
  }
  const removedCatalogMigration = await pool.query(
    "DELETE FROM schema_migrations WHERE version = '013_job_title_catalog'",
  );
  assert.equal(removedCatalogMigration.rowCount, 1);
  await migrate();
  const reappliedVersions = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(reappliedVersions.rows.map(({ version }) => version), [
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
    '015_cms_editor',
    '016_remove_ombudsman',
    '017_pos_cards',
    '018_pos_card_storage_key',
    '019_cms_asset_deletion_state',
    '020_profile_photo_crop',
    '021_bulk_user_imports',
    '022_bulk_user_import_validation',
  ]);
  const activeTitles = await pool.query('SELECT name FROM job_titles WHERE active = TRUE');
  const sortCatalogNames = (names) => names.slice().sort((a, b) => a.toLocaleLowerCase('pt-BR').localeCompare(b.toLocaleLowerCase('pt-BR')));
  assert.deepEqual(sortCatalogNames(activeTitles.rows.map(({ name }) => name)), sortCatalogNames(canonicalNames));
  const mappedTitles = await pool.query(`SELECT jt.name, COUNT(u.uid)::integer AS assigned_users
    FROM job_titles jt LEFT JOIN users u ON u.job_title_id = jt.id
    WHERE lower(jt.name) IN ('analista de dho', 'gerente de dho', 'analista de rh sênior', 'gerente de rh')
    GROUP BY jt.name ORDER BY lower(jt.name)`);
  const mappedByName = new Map(mappedTitles.rows.map((row) => [row.name, row.assigned_users]));
  assert.equal(mappedByName.get('Analista de DHO'), 0);
  assert.equal(mappedByName.get('Gerente de DHO'), 0);
  assert.ok(mappedByName.get('Analista de RH Sênior') >= 1);
  assert.ok(mappedByName.get('Gerente de RH') >= 1);
  const fixtureAssignments = await pool.query(`SELECT u.uid, jt.name
    FROM users u JOIN job_titles jt ON jt.id = u.job_title_id
    WHERE u.uid = ANY($1::text[]) ORDER BY u.uid`, [fixtureUids]);
  const assignmentsByUid = new Map(fixtureAssignments.rows.map(({ uid, name }) => [uid, name]));
  assert.equal(assignmentsByUid.get(fixtureUsers[0].uid), 'Analista de RH Sênior');
  assert.equal(assignmentsByUid.get(fixtureUsers[1].uid), 'Gerente de RH');
  const unmappedDho = await pool.query(`SELECT name, active FROM job_titles
    WHERE lower(name) IN ('assistente de dho', 'coordenador de dho') ORDER BY lower(name)`);
  assert.deepEqual(unmappedDho.rows, [
    { name: 'Assistente de DHO', active: false },
    { name: 'Coordenador de DHO', active: false },
  ]);
  const tables = await pool.query(`SELECT to_regclass('public.audit_log') AS audit,
    to_regclass('public.ombudsman') AS ombudsman,
    to_regclass('public.ombudsman_workflow_idx') AS ombudsman_workflow_idx,
    to_regclass('public.cron_status') AS cron, to_regclass('public.notifications_log') AS notifications,
    to_regclass('public.solides_employee_links') AS solides_links,
      to_regclass('public.job_titles') AS job_titles,
      to_regclass('public.autocard_cards') AS autocard_cards,
      to_regclass('public.autocard_media') AS autocard_media,
      to_regclass('public.cms_documents') AS cms_documents,
      to_regclass('public.cms_revisions') AS cms_revisions,
      to_regclass('public.cms_assets') AS cms_assets,
      to_regclass('public.pos_cards') AS pos_cards,
      to_regclass('public.pos_card_media') AS pos_card_media`);
  assert.equal(tables.rows[0].audit, 'audit_log');
  assert.equal(tables.rows[0].ombudsman, null);
  assert.equal(tables.rows[0].ombudsman_workflow_idx, null);
  assert.equal(tables.rows[0].cron, 'cron_status');
  assert.equal(tables.rows[0].notifications, 'notifications_log');
  assert.equal(tables.rows[0].solides_links, 'solides_employee_links');
  assert.equal(tables.rows[0].job_titles, 'job_titles');
  assert.equal(tables.rows[0].autocard_cards, 'autocard_cards');
  assert.equal(tables.rows[0].autocard_media, 'autocard_media');
  assert.equal(tables.rows[0].cms_documents, 'cms_documents');
  assert.equal(tables.rows[0].cms_revisions, 'cms_revisions');
  assert.equal(tables.rows[0].cms_assets, 'cms_assets');
  assert.equal(tables.rows[0].pos_cards, 'pos_cards');
  assert.equal(tables.rows[0].pos_card_media, 'pos_card_media');
  const profileCropColumn = await pool.query(`SELECT is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'photo_crop'`);
  assert.equal(profileCropColumn.rows[0]?.is_nullable, 'NO');
  assert.match(profileCropColumn.rows[0]?.column_default || '', /0\.5/);
  const storageConstraint = await pool.query(`SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE conname = 'pos_card_media_storage_key_check'`);
  const storageConstraintDefinition = (storageConstraint.rows[0]?.definition || '').replaceAll('\\\\', '\\');
  const canonicalStoragePattern = '^pos-card-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.webp$';
  assert.ok(storageConstraintDefinition.includes(canonicalStoragePattern), storageConstraintDefinition);
  await assert.rejects(
    client.query(`INSERT INTO pos_card_media (storage_key, content_type, byte_size)
      VALUES ('pos-card-dead.webp', 'image/webp', 1)`),
    /pos_card_media_storage_key_check/,
  );
  const cmsConstraints = await pool.query(`SELECT conname
    FROM pg_constraint
    WHERE conname IN (
      'cms_documents_content_type_check', 'cms_revisions_status_check',
      'cms_revisions_blocks_check', 'cms_documents_published_revision_id_fkey',
      'cms_documents_draft_revision_id_fkey', 'cms_documents_scheduled_revision_id_fkey'
    ) ORDER BY conname`);
  assert.deepEqual(cmsConstraints.rows.map(({ conname }) => conname), [
    'cms_documents_content_type_check',
    'cms_documents_draft_revision_id_fkey',
    'cms_documents_published_revision_id_fkey',
    'cms_documents_scheduled_revision_id_fkey',
    'cms_revisions_blocks_check',
    'cms_revisions_status_check',
  ]);
  const cropColumn = await pool.query(`SELECT is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'autocard_cards' AND column_name = 'media_crop'`);
  assert.equal(cropColumn.rows[0]?.is_nullable, 'NO');
  assert.match(cropColumn.rows[0]?.column_default || '', /0\.5/);
  const roles = await pool.query("SELECT rolname FROM pg_roles WHERE rolname IN ('portal_api', 'portal_cron') ORDER BY rolname");
  assert.deepEqual(roles.rows.map(({ rolname }) => rolname), ['portal_api', 'portal_cron']);
  const privileges = await pool.query(`SELECT
    has_table_privilege('portal_cron', 'public.autocard_cards', 'SELECT') AS cards_select,
    has_table_privilege('portal_cron', 'public.autocard_media', 'SELECT,DELETE') AS media_select_delete,
    has_table_privilege('portal_api', 'public.cms_documents', 'SELECT,INSERT,UPDATE,DELETE') AS api_cms_documents,
    has_table_privilege('portal_api', 'public.cms_revisions', 'SELECT,INSERT,UPDATE,DELETE') AS api_cms_revisions,
    has_table_privilege('portal_api', 'public.cms_assets', 'SELECT,INSERT,UPDATE,DELETE') AS api_cms_assets,
     has_table_privilege('portal_cron', 'public.cms_documents', 'SELECT,UPDATE') AS cron_cms_documents,
     has_table_privilege('portal_cron', 'public.cms_revisions', 'SELECT,UPDATE') AS cron_cms_revisions,
     has_table_privilege('portal_cron', 'public.cms_assets', 'SELECT,DELETE') AS cron_cms_assets,
    has_table_privilege('portal_api', 'public.pos_cards', 'SELECT,INSERT,UPDATE,DELETE') AS api_pos_cards,
    has_table_privilege('portal_api', 'public.pos_card_media', 'SELECT,INSERT,UPDATE,DELETE') AS api_pos_card_media,
    has_table_privilege('portal_cron', 'public.pos_cards', 'SELECT') AS cron_pos_cards,
    has_table_privilege('portal_cron', 'public.pos_card_media', 'SELECT,DELETE') AS cron_pos_card_media,
    has_table_privilege('portal_cron', 'public.audit_log', 'SELECT,INSERT,UPDATE,DELETE') AS audit_privileges`);
  assert.equal(privileges.rows[0].cards_select, true);
  assert.equal(privileges.rows[0].media_select_delete, true);
  assert.equal(privileges.rows[0].api_cms_documents, true);
  assert.equal(privileges.rows[0].api_cms_revisions, true);
  assert.equal(privileges.rows[0].api_cms_assets, true);
  assert.equal(privileges.rows[0].cron_cms_documents, true);
  assert.equal(privileges.rows[0].cron_cms_revisions, true);
  assert.equal(privileges.rows[0].cron_cms_assets, true);
  assert.equal(privileges.rows[0].api_pos_cards, true);
  assert.equal(privileges.rows[0].api_pos_card_media, true);
  assert.equal(privileges.rows[0].cron_pos_cards, true);
  assert.equal(privileges.rows[0].cron_pos_card_media, true);
  assert.equal(privileges.rows[0].audit_privileges, true);
  console.log('migration integration: ok');
} finally {
  try {
    if (legacyObjectsCreated) {
      await client.query('DROP INDEX IF EXISTS ombudsman_workflow_idx');
      await client.query('DROP TABLE IF EXISTS ombudsman CASCADE');
    }
    if (fixtureUids.length) {
      await client.query('DELETE FROM users WHERE uid = ANY($1::text[])', [fixtureUids]);
    }
  } finally {
    client.release();
    await pool.end();
  }
}
