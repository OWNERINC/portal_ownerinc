import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../api/package.json', import.meta.url));
require('dotenv').config({ path: new URL('../.env', import.meta.url) });
if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
const { Pool } = require('pg');
const { migrate } = require('../api/db/migrate');

await migrate();
await migrate();

const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
try {
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
  const activeTitles = await pool.query('SELECT name FROM job_titles WHERE active = TRUE ORDER BY lower(name)');
  assert.deepEqual(activeTitles.rows.map(({ name }) => name), canonicalNames.slice().sort((a, b) => a.toLocaleLowerCase('pt-BR').localeCompare(b.toLocaleLowerCase('pt-BR'))));
  const mappedTitles = await pool.query(`SELECT jt.name, COUNT(u.uid)::integer AS assigned_users
    FROM job_titles jt LEFT JOIN users u ON u.job_title_id = jt.id
    WHERE lower(jt.name) IN ('analista de dho', 'gerente de dho', 'analista de rh sênior', 'gerente de rh')
    GROUP BY jt.name ORDER BY lower(jt.name)`);
  const mappedByName = new Map(mappedTitles.rows.map((row) => [row.name, row.assigned_users]));
  assert.equal(mappedByName.get('Analista de DHO'), 0);
  assert.equal(mappedByName.get('Gerente de DHO'), 0);
  assert.ok(mappedByName.has('Analista de RH Sênior'));
  assert.ok(mappedByName.has('Gerente de RH'));
  const unmappedDho = await pool.query(`SELECT name, active FROM job_titles
    WHERE lower(name) IN ('assistente de dho', 'coordenador de dho') ORDER BY lower(name)`);
  for (const row of unmappedDho.rows) assert.equal(row.active, false);
  const tables = await pool.query(`SELECT to_regclass('public.audit_log') AS audit,
    to_regclass('public.cron_status') AS cron, to_regclass('public.notifications_log') AS notifications,
    to_regclass('public.solides_employee_links') AS solides_links,
     to_regclass('public.job_titles') AS job_titles,
     to_regclass('public.autocard_cards') AS autocard_cards,
     to_regclass('public.autocard_media') AS autocard_media`);
  assert.equal(tables.rows[0].audit, 'audit_log');
  assert.equal(tables.rows[0].cron, 'cron_status');
  assert.equal(tables.rows[0].notifications, 'notifications_log');
  assert.equal(tables.rows[0].solides_links, 'solides_employee_links');
  assert.equal(tables.rows[0].job_titles, 'job_titles');
  assert.equal(tables.rows[0].autocard_cards, 'autocard_cards');
  assert.equal(tables.rows[0].autocard_media, 'autocard_media');
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
    has_table_privilege('portal_cron', 'public.audit_log', 'SELECT,INSERT,UPDATE,DELETE') AS audit_privileges`);
  assert.equal(privileges.rows[0].cards_select, true);
  assert.equal(privileges.rows[0].media_select_delete, true);
  assert.equal(privileges.rows[0].audit_privileges, true);
  console.log('migration integration: ok');
} finally {
  await pool.end();
}
