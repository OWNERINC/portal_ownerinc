import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(new URL('../api/package.json', import.meta.url));
require('dotenv').config({ path: new URL('../.env', import.meta.url) });
if (process.env.NODE_ENV === 'production') throw new Error('Migration integration test cannot run with NODE_ENV=production');
if (process.env.MIGRATION_TEST_DISPOSABLE !== 'true') throw new Error('MIGRATION_TEST_DISPOSABLE=true is required');
if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
const { Pool } = require('pg');
const { migrate } = require('../api/db/migrate');
const expectedVersions = [
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
  '023_pos_owner_cards',
  '024_job_title_page_access',
  '025_pending_registrations',
  '026_firebase_enable_pending',
  '027_pending_registration_cleanup',
  '028_firebase_cleanup_queue',
  '029_autocard_media_safety',
  '030_dho_job_title_catalog',
  '031_contract_invariants',
  '032_user_import_identity',
  '033_academy_learning',
];

// Explicit setup modes exercise both installation paths without dropping data.
// Each requires its own empty, approved disposable database.
const setupMode = process.env.MIGRATION_TEST_SETUP;
if (setupMode && !['upgrade', 'bootstrap'].includes(setupMode)) {
  throw new Error('MIGRATION_TEST_SETUP must be upgrade or bootstrap');
}

const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const client = await pool.connect();
const fixtureUids = [];
const fixtureTitleIds = [];
let legacyCourseId;
let legacyObjectsCreated = false;
try {
  if (setupMode) {
    const existing = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
    assert.equal(existing.rowCount, 0, 'Setup modes require an empty disposable database; no tables are dropped');
    await client.query('BEGIN');
    try {
      if (setupMode === 'bootstrap') {
        await client.query(await readFile(new URL('../api/db/schema.sql', import.meta.url), 'utf8'));
        const cms = await client.query("SELECT to_regclass('public.cms_documents') AS documents");
        assert.equal(cms.rows[0].documents, null);
      } else {
        await client.query(`CREATE TABLE schema_migrations (
          version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
        for (const version of expectedVersions.filter((version) => version < '033_academy_learning')) {
          await client.query(await readFile(new URL(`../api/db/migrations/${version}.sql`, import.meta.url), 'utf8'));
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        }
        const columns = await client.query(`SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'academy' AND column_name = 'delivery_mode'`);
        assert.equal(columns.rowCount, 0);
      }
      const pending = await client.query("SELECT version FROM schema_migrations WHERE version = '033_academy_learning'");
      assert.equal(pending.rowCount, 0);
      const legacy = await client.query(`INSERT INTO academy (title, url, active)
        VALUES ('Curso legado de teste', 'https://example.com/course', TRUE) RETURNING id`);
      legacyCourseId = legacy.rows[0].id;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      legacyCourseId = undefined;
      throw error;
    }
  }
  await migrate();
  const ledgerBeforeRepeat = await client.query('SELECT version, applied_at FROM schema_migrations ORDER BY version');
  await migrate();
  const ledgerAfterRepeat = await client.query('SELECT version, applied_at FROM schema_migrations ORDER BY version');
  assert.deepEqual(ledgerAfterRepeat.rows, ledgerBeforeRepeat.rows, 'Repeated migrate must not reapply migrations');
  if (legacyCourseId) {
    const legacy = await client.query(`SELECT title, url, active, delivery_mode, audience, learning_group,
      icon_key, instructor_name, updated_at IS NOT NULL AS has_updated_at FROM academy WHERE id = $1`, [legacyCourseId]);
    assert.deepEqual(legacy.rows, [{ title: 'Curso legado de teste', url: 'https://example.com/course',
      active: true, delivery_mode: 'external', audience: 'all', learning_group: 'initial',
      icon_key: 'icon-01', instructor_name: '', has_updated_at: true }]);
    console.log(`Academy ${setupMode}: legacy course preserved; migration 033 applied after CMS`);
  }

  // All behavior fixtures roll back, including on a failed assertion.
  await client.query('BEGIN');
  try {
    const academyTables = ['academy_course_job_titles', 'academy_modules', 'academy_lessons', 'academy_lesson_progress'];
    for (const table of academyTables) {
      const shape = await client.query('SELECT to_regclass($1) AS relation', [`public.${table}`]);
      assert.equal(shape.rows[0].relation, table);
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        const access = await client.query(`SELECT
          has_table_privilege('portal_api', $1, $2) AS api_allowed,
          has_table_privilege('portal_cron', $1, $2) AS cron_allowed`, [`public.${table}`, privilege]);
        assert.deepEqual(access.rows, [{ api_allowed: true, cron_allowed: false }], `${table}: ${privilege}`);
      }
    }
    async function rejectsSql(sql, values, code) {
      await client.query('SAVEPOINT academy_invalid');
      try {
        await assert.rejects(client.query(sql, values), (error) => error.code === code);
      } finally {
        await client.query('ROLLBACK TO SAVEPOINT academy_invalid');
        await client.query('RELEASE SAVEPOINT academy_invalid');
      }
    }
    const defaults = await client.query(`INSERT INTO academy (title, url)
      VALUES ('Curso externo de teste', 'https://example.com/course')
      RETURNING delivery_mode, audience, learning_group, icon_key, instructor_name`);
    assert.deepEqual(defaults.rows, [{ delivery_mode: 'external', audience: 'all', learning_group: 'initial',
      icon_key: 'icon-01', instructor_name: '' }]);
    const course = (await client.query(`INSERT INTO academy (title, delivery_mode, audience, active)
      VALUES ('Curso interno', 'internal', 'job_titles', FALSE) RETURNING id`)).rows[0].id;
    await rejectsSql("INSERT INTO academy (title) VALUES ('Externo sem URL')", [], '23514');
    await rejectsSql("INSERT INTO academy (title, delivery_mode, url) VALUES ('Interno com URL', 'internal', 'https://example.com')", [], '23514');
    const job = (await client.query('INSERT INTO job_titles (name) VALUES ($1) RETURNING id', [`Academy fixture ${randomUUID()}`])).rows[0].id;
    await client.query('INSERT INTO academy_course_job_titles (course_id, job_title_id) VALUES ($1, $2)', [course, job]);
    await rejectsSql('DELETE FROM job_titles WHERE id = $1', [job], '23503');
    await rejectsSql('INSERT INTO academy_course_job_titles (course_id, job_title_id) VALUES ($1, $2)', [course, randomUUID()], '23503');
    const module = (await client.query(`INSERT INTO academy_modules (course_id, title)
      VALUES ($1, 'Módulo') RETURNING id, active`, [course])).rows[0];
    assert.equal(module.active, false);
    for (const type of ['youtube', 'file']) {
      await rejectsSql('INSERT INTO academy_lessons (module_id, title, media_type) VALUES ($1, $2, $3)',
        [module.id, 'Sem mídia', type], '23514');
    }
    const lesson = (await client.query(`INSERT INTO academy_lessons (module_id, title, media_type, youtube_video_id)
      VALUES ($1, 'Aula', 'youtube', 'abcDEF12_-3') RETURNING id, active, media_version`, [module.id])).rows[0];
    assert.equal(lesson.active, false);
    assert.equal(lesson.media_version, 1);
    await client.query(`INSERT INTO academy_lessons (module_id, title, media_type, media_url)
      VALUES ($1, 'Arquivo', 'file', 'https://example.com/video.mp4')`, [module.id]);
    for (const [type, video, url] of [
      ['youtube', 'short', null], ['youtube', 'abcDEF12_-3', 'https://example.com/video.mp4'],
      ['file', null, 'http://example.com/video.mp4'], ['file', 'abcDEF12_-3', 'https://example.com/video.mp4'],
    ]) {
      await rejectsSql(`INSERT INTO academy_lessons (module_id, title, media_type, youtube_video_id, media_url)
        VALUES ($1, 'Mídia inválida', $2, $3, $4)`, [module.id, type, video, url], '23514');
    }
    // The CMS change must preserve all previous content types too.
    for (const type of ['knowledge', 'academy', 'academy_lesson', 'benefit', 'announcement', 'reminder']) {
      await client.query('INSERT INTO cms_documents (content_type, source_id, title) VALUES ($1, $2, $3)',
        [type, lesson.id, 'Documento de teste']);
    }
    await rejectsSql("INSERT INTO cms_documents (content_type, title) VALUES ('invalid', 'Tipo inválido')", [], '23514');
    const uids = [`academy-test-${randomUUID()}`, `academy-test-${randomUUID()}`];
    for (const uid of uids) {
      await client.query('INSERT INTO users (uid, email) VALUES ($1, $2)', [uid, `${uid}@example.com`]);
      await client.query(`INSERT INTO academy_lesson_progress (user_uid, lesson_id, media_version, position_seconds)
        VALUES ($1, $2, 1, 42)`, [uid, lesson.id]);
    }
    await client.query(`INSERT INTO academy_lesson_progress (user_uid, lesson_id, media_version, completed, completed_at)
      VALUES ($1, $2, 2, TRUE, NOW())`, [uids[0], lesson.id]);
    const progress = await client.query(`SELECT user_uid, media_version, position_seconds, completed, version
      FROM academy_lesson_progress WHERE lesson_id = $1 ORDER BY user_uid, media_version`, [lesson.id]);
    assert.equal(progress.rowCount, 3, 'Progress is distinct per user and media version');
    assert.deepEqual(progress.rows.find((row) => row.user_uid === uids[1]),
      { user_uid: uids[1], media_version: 1, position_seconds: 42, completed: false, version: 1 });
    await rejectsSql('INSERT INTO academy_lesson_progress (user_uid, lesson_id, media_version) VALUES ($1, $2, 1)',
      [uids[0], lesson.id], '23505');
    for (const change of ['position_seconds = -1', 'position_seconds = 86401', 'version = 0', 'media_version = 0',
      'completed = TRUE, completed_at = NULL', 'completed = FALSE, completed_at = NOW()']) {
      await rejectsSql(`UPDATE academy_lesson_progress SET ${change} WHERE user_uid = $1 AND media_version = 1`, [uids[0]], '23514');
    }
    await rejectsSql('INSERT INTO academy_lesson_progress (user_uid, lesson_id, media_version) VALUES ($1, $2, 1)',
      ['nonexistent-fixture-user', lesson.id], '23503');
    await client.query('DELETE FROM users WHERE uid = $1', [uids[0]]);
    assert.equal((await client.query('SELECT * FROM academy_lesson_progress WHERE lesson_id = $1', [lesson.id])).rowCount, 1);
    await client.query('DELETE FROM academy WHERE id = $1', [course]);
    for (const [table, column, id] of [
      ['academy_course_job_titles', 'course_id', course], ['academy_modules', 'course_id', course],
      ['academy_lessons', 'module_id', module.id], ['academy_lesson_progress', 'lesson_id', lesson.id],
    ]) {
      assert.equal((await client.query(`SELECT * FROM ${table} WHERE ${column} = $1`, [id])).rowCount, 0, `${table} cascades`);
    }
    assert.equal((await client.query('DELETE FROM job_titles WHERE id = $1', [job])).rowCount, 1);
  } finally {
    await client.query('ROLLBACK');
  }

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
  assert.deepEqual(versions.rows.map(({ version }) => version), expectedVersions);
  const canonicalNames = [
    'Analista Administrativo', 'Analista de Cobrança', 'Analista de Engenharia',
    'Analista de Pós-Vendas', 'Analista de DHO Sênior',
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
    'Gerente de DHO', 'Jovem Aprendiz', 'Líder de Promoção', 'Motorista',
    'Promotor de Vendas', 'Recepcionista', 'Redator', 'SDR', 'Social Media',
  ];
  const dhoMigration = await readFile(new URL('../api/db/migrations/030_dho_job_title_catalog.sql', import.meta.url), 'utf8');
  const overflowName = `RH ${'x'.repeat(117)}`;
  await client.query('ALTER TABLE job_titles DROP CONSTRAINT IF EXISTS job_titles_name_no_legacy_rh_check');
  await client.query('DROP INDEX IF EXISTS job_titles_name_lower_unique');
  const { rows: overflowRows } = await client.query(
    `INSERT INTO job_titles (name, active, page_access)
     VALUES ($1, TRUE, '{"autocard":true,"posCards":false}'::jsonb) RETURNING id, name, active, page_access`,
    [overflowName],
  );
  const overflowTitleId = overflowRows[0].id;
  fixtureTitleIds.push(overflowTitleId);
  await client.query('BEGIN');
  try {
    await assert.rejects(client.query(dhoMigration), /before mutation/);
  } finally {
    await client.query('ROLLBACK');
  }
  const untouchedOverflow = await client.query(
    'SELECT name, active, page_access FROM job_titles WHERE id = $1',
    [overflowTitleId],
  );
  assert.deepEqual(untouchedOverflow.rows[0], {
    name: overflowName,
    active: true,
    page_access: { autocard: true, posCards: false },
  });
  await client.query('DELETE FROM job_titles WHERE id = $1', [overflowTitleId]);
  await client.query(`ALTER TABLE job_titles ADD CONSTRAINT job_titles_name_no_legacy_rh_check CHECK (
    name !~* '(^|[^[:alnum:]_])RH([^[:alnum:]_]|$)'
  )`);
  await client.query('CREATE UNIQUE INDEX job_titles_name_lower_unique ON job_titles (btrim(lower(name)))');

  // These rows intentionally model the legacy-token input handled by migration 030.
  await client.query('ALTER TABLE job_titles DROP CONSTRAINT IF EXISTS job_titles_name_no_legacy_rh_check');
  await client.query('DROP INDEX IF EXISTS job_titles_name_lower_unique');
  const legacyTitleFixtures = [
    { name: ' Analista de RH Sênior ', active: true, pageAccess: { autocard: false, posCards: true }, expected: 'Analista de DHO Sênior' },
    { name: 'analista de rh sênior', active: false, pageAccess: { autocard: true, posCards: false }, expected: 'Analista de DHO Sênior' },
    { name: 'Gerente de RH', active: false, pageAccess: { autocard: true, posCards: false }, expected: 'Gerente de DHO' },
    { name: 'Analista de RH', active: true, pageAccess: { autocard: true, posCards: false }, expected: 'Analista de DHO' },
    { name: 'RH RH', active: true, pageAccess: { autocard: false, posCards: false }, expected: 'DHO DHO' },
    { name: 'Legacy DHO Merge', active: false, pageAccess: { autocard: false, posCards: true }, expected: 'Legacy DHO Merge', permissions: { viewDashboard: true } },
    { name: 'Legacy RH Merge', active: true, pageAccess: { autocard: true, posCards: false }, expected: 'Legacy DHO Merge', permissions: { manageKnowledge: true } },
    { name: 'RHub', active: true, pageAccess: { autocard: false, posCards: false }, expected: 'RHub' },
    { name: 'RHOps', active: true, pageAccess: { autocard: false, posCards: false }, expected: 'RHOps' },
    { name: 'ÁreaRH', active: true, pageAccess: { autocard: false, posCards: false }, expected: 'ÁreaRH' },
  ];
  for (const title of legacyTitleFixtures) {
    const { rows } = await client.query(
      `INSERT INTO job_titles (name, active, page_access)
       VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [title.name, title.active, JSON.stringify(title.pageAccess)],
    );
    title.id = rows[0].id;
    fixtureTitleIds.push(title.id);
  }
  const fixtureUsers = legacyTitleFixtures.map((title, index) => ({
    uid: `migration-fixture-dho-${index}-${randomUUID()}`,
    email: `migration-fixture-dho-${index}-${randomUUID()}@example.com`,
    name: `Migration Fixture DHO ${index}`,
    jobTitleId: title.id,
    expected: title.expected,
    permissions: title.permissions || {},
  }));
  for (const user of fixtureUsers) {
    fixtureUids.push(user.uid);
    await client.query(`INSERT INTO users (uid, email, name, job_title_id, permissions)
      VALUES ($1, $2, $3, $4, $5::jsonb)`, [user.uid, user.email, user.name, user.jobTitleId, JSON.stringify(user.permissions)]);
  }
  const removedCatalogMigration = await pool.query(
    "DELETE FROM schema_migrations WHERE version = '030_dho_job_title_catalog'",
  );
  assert.equal(removedCatalogMigration.rowCount, 1);
  await migrate();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await client.query('BEGIN');
    try {
      await client.query(dhoMigration);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  const reappliedVersions = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepEqual(reappliedVersions.rows.map(({ version }) => version), expectedVersions);
  const activeTitles = await pool.query('SELECT name FROM job_titles WHERE active = TRUE');
  const sortCatalogNames = (names) => names.slice().sort((a, b) => a.toLocaleLowerCase('pt-BR').localeCompare(b.toLocaleLowerCase('pt-BR')));
  assert.deepEqual(sortCatalogNames(activeTitles.rows.map(({ name }) => name)), sortCatalogNames(canonicalNames));
   const remainingLegacyTitles = await pool.query("SELECT name FROM job_titles WHERE btrim(name) ~* '(^|[^[:alnum:]_])rh([^[:alnum:]_]|$)'");
   assert.equal(remainingLegacyTitles.rowCount, 0);
  const mappedTitles = await pool.query(`SELECT jt.name, COUNT(u.uid)::integer AS assigned_users
    FROM job_titles jt LEFT JOIN users u ON u.job_title_id = jt.id
     WHERE btrim(lower(jt.name)) IN ('analista de dho', 'analista de dho sênior', 'gerente de dho')
     GROUP BY jt.name ORDER BY btrim(lower(jt.name))`);
  const mappedByName = new Map(mappedTitles.rows.map((row) => [row.name, row.assigned_users]));
  assert.ok(mappedByName.get('Analista de DHO') >= 1);
  assert.ok(mappedByName.get('Analista de DHO Sênior') >= 2);
  assert.ok(mappedByName.get('Gerente de DHO') >= 1);
  const fixtureAssignments = await pool.query(`SELECT u.uid, jt.name, u.permissions
    FROM users u JOIN job_titles jt ON jt.id = u.job_title_id
    WHERE u.uid = ANY($1::text[]) ORDER BY u.uid`, [fixtureUids]);
  const assignmentsByUid = new Map(fixtureAssignments.rows.map(({ uid, name, permissions }) => [uid, { name, permissions }]));
  for (const user of fixtureUsers) {
    assert.equal(assignmentsByUid.get(user.uid)?.name, user.expected);
    assert.deepEqual(assignmentsByUid.get(user.uid)?.permissions, user.permissions);
  }
  const mergedTitle = await pool.query(`SELECT active, page_access
    FROM job_titles WHERE btrim(lower(name)) = 'legacy dho merge'`);
  assert.deepEqual(mergedTitle.rows, [{ active: false, page_access: { autocard: true, posCards: true } }]);
  const dhoAccess = await pool.query(`SELECT name, active, page_access
    FROM job_titles
     WHERE btrim(lower(name)) IN ('analista de dho sênior', 'gerente de dho')`);
  const dhoAccessByName = new Map(dhoAccess.rows.map((row) => [row.name, row]));
  for (const name of ['Analista de DHO Sênior', 'Gerente de DHO']) {
    assert.equal(dhoAccessByName.get(name)?.active, true);
    assert.deepEqual(dhoAccessByName.get(name)?.page_access, { autocard: true, posCards: true });
  }
  const dhoNameConstraint = await pool.query(`SELECT conname, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'public.job_titles'::regclass
      AND conname = 'job_titles_name_no_legacy_rh_check'`);
  assert.equal(dhoNameConstraint.rows.length, 1);
  assert.match(dhoNameConstraint.rows[0].definition, /RH/);
  assert.match(dhoNameConstraint.rows[0].definition, /\[:alnum:\]_\]/);
  await assert.rejects(
    client.query(`INSERT INTO job_titles (name) VALUES ('Cargo RH legado')`),
    /job_titles_name_no_legacy_rh_check/,
  );
  const allowedTokenWords = await pool.query(`SELECT name, page_access
    FROM job_titles WHERE name IN ('RHub', 'RHOps', 'ÁreaRH')`);
  const allowedTokenWordsByName = new Map(allowedTokenWords.rows.map((row) => [row.name, row.page_access]));
  for (const name of ['RHub', 'RHOps', 'ÁreaRH']) {
    assert.deepEqual(allowedTokenWordsByName.get(name), { autocard: false, posCards: false });
  }
  const unmappedDho = await pool.query(`SELECT name, active FROM job_titles
     WHERE btrim(lower(name)) IN ('assistente de dho', 'coordenador de dho') ORDER BY btrim(lower(name))`);
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
       to_regclass('public.pos_card_media') AS pos_card_media,
       to_regclass('public.pending_registrations') AS pending_registrations,
       to_regclass('public.firebase_cleanup_queue') AS firebase_cleanup_queue`);
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
   assert.equal(tables.rows[0].pending_registrations, 'pending_registrations');
   assert.equal(tables.rows[0].firebase_cleanup_queue, 'firebase_cleanup_queue');
  const pendingColumns = await pool.query(`SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'pending_registrations'
    ORDER BY ordinal_position`);
  assert.deepEqual(pendingColumns.rows.map(({ column_name }) => column_name), [
    'id', 'firebase_uid', 'email', 'name', 'status', 'created_at', 'reviewed_at', 'reviewed_by', 'rejection_reason', 'firebase_cleanup_pending',
  ]);
  const pendingConstraints = await pool.query(`SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.pending_registrations'::regclass
      AND conname IN ('pending_registrations_reviewed_by_fkey', 'pending_registrations_status_check')
    ORDER BY conname`);
  assert.deepEqual(pendingConstraints.rows.map(({ conname }) => conname), [
    'pending_registrations_reviewed_by_fkey', 'pending_registrations_status_check',
  ]);
  const pendingIndex = await pool.query(`SELECT i.indisunique, i.indpred IS NOT NULL AS is_partial,
      pg_get_indexdef(i.indexrelid) LIKE '%lower(email)%' AS has_lower_email
    FROM pg_index i
    JOIN pg_class index_rel ON index_rel.oid = i.indexrelid
    WHERE i.indrelid = 'public.pending_registrations'::regclass
      AND index_rel.relname = 'pending_registrations_pending_email_unique'`);
  assert.deepEqual(pendingIndex.rows, [{ indisunique: true, is_partial: true, has_lower_email: true }]);
  const cleanupQueueColumns = await pool.query(`SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'firebase_cleanup_queue'
    ORDER BY ordinal_position`);
  assert.deepEqual(cleanupQueueColumns.rows.map(({ column_name }) => column_name), [
    'firebase_uid', 'reason', 'created_at', 'last_attempt_at', 'attempts', 'last_error',
  ]);
  const ledgerColumns = await pool.query(`SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'schema_migrations'
    ORDER BY ordinal_position`);
  assert.deepEqual(ledgerColumns.rows.map(({ column_name }) => column_name), ['version', 'applied_at']);
  const profileCropColumn = await pool.query(`SELECT is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'photo_crop'`);
  assert.equal(profileCropColumn.rows[0]?.is_nullable, 'NO');
  assert.match(profileCropColumn.rows[0]?.column_default || '', /0\.5/);
  const storageConstraint = await pool.query(`SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'public.pos_card_media'::regclass
      AND conname = 'pos_card_media_storage_key_check'`);
  const storageConstraintDefinition = (storageConstraint.rows[0]?.definition || '').replaceAll('\\\\', '\\');
  const canonicalStoragePattern = '^pos-card-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.webp$';
  assert.ok(storageConstraintDefinition.includes(canonicalStoragePattern), storageConstraintDefinition);
  await assert.rejects(
    client.query(`INSERT INTO pos_card_media (storage_key, content_type, byte_size)
      VALUES ('pos-card-dead.webp', 'image/webp', 1)`),
    /pos_card_media_storage_key_check/,
  );
  const autocardStorageConstraint = await pool.query(`SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'public.autocard_media'::regclass
      AND conname = 'autocard_media_storage_key_check'`);
  const autocardStorageConstraintDefinition = (autocardStorageConstraint.rows[0]?.definition || '').replaceAll('\\\\', '\\');
  const canonicalAutoCardStoragePattern = '^autocard-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.webp$';
  assert.ok(autocardStorageConstraintDefinition.includes(canonicalAutoCardStoragePattern), autocardStorageConstraintDefinition);
  await assert.rejects(
    client.query(`INSERT INTO autocard_media (storage_key, content_type, byte_size)
      VALUES ('autocard-dead.webp', 'image/webp', 1)`),
    /autocard_media_storage_key_check/,
  );
  await assert.rejects(
    client.query(`INSERT INTO autocard_cards (name, template, "values", icon)
      VALUES ('invalid icon fixture', 'comunicado', '{}'::jsonb, 'not_safe')`),
    /autocard_cards_icon_check/,
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
       (has_table_privilege('portal_cron', 'public.autocard_media', 'SELECT')
         AND has_table_privilege('portal_cron', 'public.autocard_media', 'DELETE')) AS media_select_delete,
       (has_table_privilege('portal_cron', 'public.users', 'SELECT')
         AND has_table_privilege('portal_cron', 'public.users', 'UPDATE')
         AND NOT has_table_privilege('portal_cron', 'public.users', 'INSERT')
         AND NOT has_table_privilege('portal_cron', 'public.users', 'DELETE')) AS cron_users_lock,
       (has_table_privilege('portal_cron', 'public.reminders', 'SELECT')
         AND has_table_privilege('portal_cron', 'public.reminders', 'UPDATE')
         AND NOT has_table_privilege('portal_cron', 'public.reminders', 'INSERT')
         AND NOT has_table_privilege('portal_cron', 'public.reminders', 'DELETE')) AS cron_reminders_lock,
      (has_table_privilege('portal_api', 'public.autocard_cards', 'SELECT')
        AND has_table_privilege('portal_api', 'public.autocard_cards', 'INSERT')
        AND has_table_privilege('portal_api', 'public.autocard_cards', 'UPDATE')
        AND has_table_privilege('portal_api', 'public.autocard_cards', 'DELETE')) AS api_autocard_cards,
      (has_table_privilege('portal_api', 'public.autocard_media', 'SELECT')
        AND has_table_privilege('portal_api', 'public.autocard_media', 'INSERT')
        AND has_table_privilege('portal_api', 'public.autocard_media', 'UPDATE')
        AND has_table_privilege('portal_api', 'public.autocard_media', 'DELETE')) AS api_autocard_media,
      (has_table_privilege('portal_api', 'public.cms_documents', 'SELECT')
        AND has_table_privilege('portal_api', 'public.cms_documents', 'INSERT')
        AND has_table_privilege('portal_api', 'public.cms_documents', 'UPDATE')
        AND has_table_privilege('portal_api', 'public.cms_documents', 'DELETE')) AS api_cms_documents,
      (has_table_privilege('portal_api', 'public.cms_revisions', 'SELECT')
        AND has_table_privilege('portal_api', 'public.cms_revisions', 'INSERT')
        AND has_table_privilege('portal_api', 'public.cms_revisions', 'UPDATE')
        AND has_table_privilege('portal_api', 'public.cms_revisions', 'DELETE')) AS api_cms_revisions,
      (has_table_privilege('portal_api', 'public.cms_assets', 'SELECT')
        AND has_table_privilege('portal_api', 'public.cms_assets', 'INSERT')
        AND has_table_privilege('portal_api', 'public.cms_assets', 'UPDATE')
        AND has_table_privilege('portal_api', 'public.cms_assets', 'DELETE')) AS api_cms_assets,
      (has_table_privilege('portal_api', 'public.pending_registrations', 'SELECT')
        AND has_table_privilege('portal_api', 'public.pending_registrations', 'INSERT')
        AND has_table_privilege('portal_api', 'public.pending_registrations', 'UPDATE')
        AND has_table_privilege('portal_api', 'public.pending_registrations', 'DELETE')) AS api_pending_registrations,
      (has_table_privilege('portal_cron', 'public.cms_documents', 'SELECT')
        AND has_table_privilege('portal_cron', 'public.cms_documents', 'UPDATE')) AS cron_cms_documents,
      (has_table_privilege('portal_cron', 'public.cms_revisions', 'SELECT')
        AND has_table_privilege('portal_cron', 'public.cms_revisions', 'UPDATE')) AS cron_cms_revisions,
      (has_table_privilege('portal_cron', 'public.cms_assets', 'SELECT')
         AND has_table_privilege('portal_cron', 'public.cms_assets', 'UPDATE')
         AND has_table_privilege('portal_cron', 'public.cms_assets', 'DELETE')) AS cron_cms_assets,
      (has_table_privilege('portal_api', 'public.pos_cards', 'SELECT')
        AND has_table_privilege('portal_api', 'public.pos_cards', 'INSERT')
        AND has_table_privilege('portal_api', 'public.pos_cards', 'UPDATE')
        AND has_table_privilege('portal_api', 'public.pos_cards', 'DELETE')) AS api_pos_cards,
      (has_table_privilege('portal_api', 'public.pos_card_media', 'SELECT')
        AND has_table_privilege('portal_api', 'public.pos_card_media', 'INSERT')
        AND has_table_privilege('portal_api', 'public.pos_card_media', 'UPDATE')
        AND has_table_privilege('portal_api', 'public.pos_card_media', 'DELETE')) AS api_pos_card_media,
    has_table_privilege('portal_cron', 'public.pos_cards', 'SELECT') AS cron_pos_cards,
      (has_table_privilege('portal_cron', 'public.pos_card_media', 'SELECT')
        AND has_table_privilege('portal_cron', 'public.pos_card_media', 'DELETE')) AS cron_pos_card_media,
       (has_table_privilege('portal_cron', 'public.user_import_jobs', 'DELETE')
         AND has_column_privilege('portal_cron', 'public.user_import_jobs', 'expires_at', 'SELECT')
         AND NOT has_table_privilege('portal_cron', 'public.user_import_jobs', 'SELECT')
         AND NOT has_table_privilege('portal_cron', 'public.user_import_jobs', 'INSERT')
         AND NOT has_table_privilege('portal_cron', 'public.user_import_jobs', 'UPDATE')) AS cron_user_import_jobs,
       (has_table_privilege('portal_cron', 'public.audit_log', 'SELECT')
        AND has_table_privilege('portal_cron', 'public.audit_log', 'INSERT')
        AND has_table_privilege('portal_cron', 'public.audit_log', 'UPDATE')
        AND has_table_privilege('portal_cron', 'public.audit_log', 'DELETE')) AS audit_privileges`);
  assert.equal(privileges.rows[0].cards_select, true);
  assert.equal(privileges.rows[0].media_select_delete, true);
  assert.equal(privileges.rows[0].cron_users_lock, true);
  assert.equal(privileges.rows[0].cron_reminders_lock, true);
  assert.equal(privileges.rows[0].api_autocard_cards, true);
  assert.equal(privileges.rows[0].api_autocard_media, true);
  assert.equal(privileges.rows[0].api_cms_documents, true);
  assert.equal(privileges.rows[0].api_cms_revisions, true);
  assert.equal(privileges.rows[0].api_cms_assets, true);
  assert.equal(privileges.rows[0].api_pending_registrations, true);
  assert.equal(privileges.rows[0].cron_cms_documents, true);
  assert.equal(privileges.rows[0].cron_cms_revisions, true);
  assert.equal(privileges.rows[0].cron_cms_assets, true);
  assert.equal(privileges.rows[0].api_pos_cards, true);
  assert.equal(privileges.rows[0].api_pos_card_media, true);
  assert.equal(privileges.rows[0].cron_pos_cards, true);
  assert.equal(privileges.rows[0].cron_pos_card_media, true);
  assert.equal(privileges.rows[0].cron_user_import_jobs, true);
  assert.equal(privileges.rows[0].audit_privileges, true);
  const contract = await pool.query(`SELECT
    (SELECT COUNT(*) = 0 FROM users
      WHERE contract_type IS NULL OR is_pj IS NULL
         OR contract_type NOT IN ('clt', 'pj')
         OR (contract_type = 'pj' AND (is_pj IS NOT TRUE OR pj_due_day IS NULL OR NOT (pj_due_day BETWEEN 1 AND 31)))
         OR (contract_type = 'clt' AND (is_pj IS NOT FALSE OR pj_due_day IS NOT NULL))) AS valid,
    EXISTS (SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'user_import_rows'
        AND column_name = 'firebase_uid' AND data_type = 'text') AS import_identity,
    EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.users'::regclass
        AND conname = 'users_contract_consistency') AS contract_constraint`);
  assert.equal(contract.rows[0].valid, true);
  assert.equal(contract.rows[0].import_identity, true);
  assert.equal(contract.rows[0].contract_constraint, true);
  const invalidContractUid = `migration-fixture-contract-${randomUUID()}`;
  fixtureUids.push(invalidContractUid);
  await assert.rejects(
    client.query(`INSERT INTO users (uid, email, name, contract_type, is_pj, pj_due_day)
      VALUES ($1, $2, $3, 'pj', FALSE, 1)`, [
      invalidContractUid,
      `${invalidContractUid}@example.com`,
      'Migration Fixture Invalid Contract',
    ]),
    /users_contract_consistency/,
  );
  console.log('migration integration: ok');
} finally {
  try {
    if (legacyCourseId) await client.query('DELETE FROM academy WHERE id = $1', [legacyCourseId]);
    if (legacyObjectsCreated) {
      await client.query('DROP INDEX IF EXISTS ombudsman_workflow_idx');
      await client.query('DROP TABLE IF EXISTS ombudsman CASCADE');
    }
    if (fixtureUids.length) {
      await client.query('DELETE FROM users WHERE uid = ANY($1::text[])', [fixtureUids]);
    }
    if (fixtureTitleIds.length) {
      await client.query('DELETE FROM job_titles WHERE id = ANY($1::uuid[])', [fixtureTitleIds]);
    }
    if (legacyObjectsCreated) {
      await client.query('CREATE UNIQUE INDEX IF NOT EXISTS job_titles_name_lower_unique ON job_titles (btrim(lower(name)))');
    }
  } finally {
    client.release();
    await pool.end();
  }
}
