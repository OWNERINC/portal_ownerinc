import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { buildNewsMutationTriggersDDL, NEWS_MUTATION_TRIGGER_TABLES } from '../../src/publication/mutation-triggers'
import { NEWS_MUTATION_LEDGER_DDL, NEWS_MUTATION_TABLES } from '../../src/publication/mutation-ledger'

const ddl = buildNewsMutationTriggersDDL()

test('SQL builder consumes the canonical exact relation inventory with closed identifiers', () => {
  assert.deepEqual(NEWS_MUTATION_TRIGGER_TABLES, NEWS_MUTATION_TABLES)
  assert.equal(NEWS_MUTATION_TRIGGER_TABLES.length, 39)
  for (const table of NEWS_MUTATION_TABLES) {
    assert.ok(ddl.includes(`ON public."${table}"`), `missing quoted relation ${table}`)
    assert.ok(ddl.includes(`ALTER TABLE public."${table}" ENABLE ALWAYS TRIGGER owner_news_mutation_guard_stmt`))
    assert.ok(ddl.includes(`ALTER TABLE public."${table}" ENABLE ALWAYS TRIGGER owner_news_mutation_capture_row`))
  }
  assert.match(ddl, /BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON/)
  assert.match(ddl, /AFTER INSERT OR UPDATE OR DELETE ON/)
  assert.match(ddl, /owner_news_truncate_forbidden/)
  assert.match(ddl, /pg_advisory_xact_lock\(7194030\)/)
  // Coverage remains 0 in NEWS_MUTATION_LEDGER_DDL until the integrator proves
  // all native-write and installed-trigger cases against real PostgreSQL 16.
  assert.doesNotMatch(ddl, /coverage_version\s*=\s*1|coverage_version\)\s*VALUES\s*\([^)]*,\s*1/u)
})

test('row trigger hashes all mutations in the declared PostgreSQL JSONB domain', () => {
  assert.match(ddl, /AFTER EACH ROW|FOR EACH ROW EXECUTE FUNCTION public\.owner_news_mutation_capture_row/u)
  assert.match(ddl, /pg_catalog\.sha256\(pg_catalog\.convert_to\(old_json::text, 'UTF8'\)\)/)
  assert.match(ddl, /pg_catalog\.sha256\(pg_catalog\.convert_to\(new_json::text, 'UTF8'\)\)/)
  assert.match(ddl, /jsonb_build_array\(1, previous_hash, next_sequence::text, event_uuid::text/)
  assert.match(ddl, /TG_TABLE_NAME, TG_OP, row_key, pg_catalog\.txid_current\(\)::text/)
  assert.match(ddl, /UPDATE public\.owner_news_mutation_head\s+SET sequence = next_sequence, chain_sha256 = event_hash/u)
  assert.match(ddl, /old_json IS DISTINCT FROM new_json/)
})

test('actual mutation-ledger DDL creates no control sequence or nextval default', () => {
  assert.doesNotMatch(NEWS_MUTATION_LEDGER_DDL, /CREATE\s+(?:TEMP(?:ORARY)?\s+)?SEQUENCE|nextval\s*\(/iu)
  assert.match(NEWS_MUTATION_LEDGER_DDL, /event_id uuid UNIQUE NOT NULL DEFAULT gen_random_uuid\(\)/u)
  assert.match(NEWS_MUTATION_LEDGER_DDL, /sequence bigint NOT NULL DEFAULT 0/u)
  assert.match(NEWS_MUTATION_LEDGER_DDL, /sequence bigint PRIMARY KEY/u)
})

test('guard and function privileges separate runtime readers, migration owner and control connection', () => {
  assert.match(ddl, /SECURITY INVOKER\s+SET search_path = pg_catalog, public/u)
  assert.match(ddl, /SECURITY DEFINER\s+SET search_path = pg_catalog, public/u)
  assert.match(ddl, /barrier <> 'open' AND current_user <> 'cms_control'/)
  assert.match(ddl, /TG_TABLE_NAME = 'news_migration_runs' AND session_user = 'cms_controller'/)
  for (const field of ['reconciliation_sequence', 'reconciliation_chain_sha256', 'sealed_sequence', 'sealed_chain_sha256', 'sealed_at']) {
    assert.ok(ddl.includes(`'${field}'`), `bookkeeping exclusion lacks ${field}`)
  }
  assert.match(ddl, /GRANT SELECT ON public\.owner_news_mutation_head, public\.owner_news_mutation_events TO cms_runtime/)
  assert.match(ddl, /REVOKE ALL ON public\.owner_news_mutation_head, public\.owner_news_mutation_events FROM cms_runtime/)
  assert.match(ddl, /GRANT USAGE ON SCHEMA public TO cms_control, cms_controller/)
  assert.match(ddl, /REVOKE UPDATE ON public\.news_migration_runs FROM cms_runtime/)
  assert.match(ddl, /GRANT UPDATE \(progress_state, commit_outcome, reconciliation_sha256,[\s\S]*?unresolved_exceptions\) ON public\.news_migration_runs TO cms_runtime/u)
  assert.match(ddl, /REVOKE UPDATE ON public\.news_migration_runs FROM PUBLIC/)
  assert.match(ddl, /GRANT EXECUTE ON FUNCTION public\.owner_news_seal_run\([^;]+ TO cms_controller/u)
  assert.match(ddl, /REVOKE ALL ON FUNCTION public\.owner_news_seal_run\([^;]+ FROM PUBLIC/u)
  assert.match(ddl, /FROM cms_runtime/u)
  assert.doesNotMatch(ddl, /GRANT\s+UPDATE\s+ON\s+public\.news_migration_runs\s+TO\s+cms_runtime/u)
  assert.doesNotMatch(ddl, /CREATE EXTENSION|PASSWORD\s+['"]|DATABASE_URL|SECRET\s*=/iu)
})

test('seal validates reconciliation and coverage, logs complete run mutation before closing barrier', () => {
  const seal = ddl.slice(ddl.indexOf('CREATE OR REPLACE FUNCTION public.owner_news_seal_run'))
  assert.match(seal, /pg_advisory_xact_lock\(7194030\)[\s\S]*?owner_news_mutation_head WHERE singleton = TRUE FOR UPDATE[\s\S]*?news_migration_runs AS runs\s+WHERE runs\.id = run FOR UPDATE/u)
  assert.match(seal, /head_coverage <> 1 OR head_barrier <> 'open'/)
  assert.match(seal, /progress_state <> 'reconciled'/)
  assert.match(seal, /commit_outcome <> 'acknowledged'/)
  assert.match(seal, /unresolved_exceptions <> '\[\]'::jsonb/)
  assert.match(seal, /admission_state = 'sealed', activation_epoch = epoch \+ 1,[\s\S]*?sealed_at = pg_catalog\.clock_timestamp\(\)/u)
  assert.match(seal, /UPDATE public\.news_migration_runs SET[\s\S]*?sealed_sequence = final_sequence::text, sealed_chain_sha256 = final_chain/u)
  assert.match(seal, /UPDATE public\.owner_news_mutation_head SET write_barrier = 'sealed'/)
  assert.ok(seal.indexOf("admission_state = 'sealed'") < seal.indexOf("write_barrier = 'sealed'"))
  assert.match(seal, /RETURNS TABLE\(id uuid\)/)
  assert.match(seal, /SELECT runs\.\* INTO run_row FROM public\.news_migration_runs AS runs\s+WHERE runs\.id = run FOR UPDATE/u)
  assert.match(seal, /run_row\.reconciliation_sequence IS DISTINCT FROM expected_seq::text/u)
  assert.match(seal, /length\(run_row\.reconciliation_sequence\) <= 19[\s\S]*?run_row\.reconciliation_sequence::numeric <= 9223372036854775807::numeric/u)
  assert.match(seal, /sealed_sequence = expected_seq::text/u)
  assert.match(seal, /sealed_sequence = final_sequence::text/u)
  assert.ok(seal.indexOf('SELECT runs.* INTO run_row') < seal.indexOf('IF NOT head_found OR head_coverage'))
  assert.doesNotMatch(seal, /run_row\.reconciliation_sequence\s+IS DISTINCT FROM\s+expected_seq\b(?!::text)/u)
})

test('adversarial identifiers cannot be introduced via the exported inventory view', () => {
  assert.equal(NEWS_MUTATION_TRIGGER_TABLES, NEWS_MUTATION_TABLES)
  assert.ok(NEWS_MUTATION_TRIGGER_TABLES.every(name => /^[a-z_][a-z0-9_]*$/u.test(name)))
})

test('integration probe imports production grants SQL and checks memberships in both directions for all three roles', async () => {
  const probe = await readFile(new URL('../integration/mutation-sql.mjs', import.meta.url), 'utf8')
  assert.match(probe, /import \{ grantsSQL, runtimeProtocolPrivilegesVerifySQL, runtimeProtocolFunctionsVerifySQL \} from '\.\.\/\.\.\/scripts\/provision-db\.ts'/u)
  assert.match(probe, /await target\.query\(grantsSQL\)/u)
  assert.match(probe, /const names = \['cms_runtime', 'cms_control', 'cms_controller'\]/u)
  assert.match(probe, /parent\.rolname = ANY\(\$1::text\[\]\) OR member\.rolname = ANY\(\$1::text\[\]\)/u)
  assert.match(probe, /assertRuntimePrivilegeBoundary\(target, 'pre_grants', \{ enforce: false \}\)/u)
  assert.match(probe, /assertRuntimePrivilegeBoundary\(target, 'post_grants_first'\)/u)
  assert.match(probe, /assertRuntimePrivilegeBoundary\(target, 'post_grants_second'\)/u)
  assert.match(probe, /has_sequence_privilege\('cms_runtime','public\.cms_protocol_fixture_ordinary_seq','USAGE'\)/u)
  assert.match(probe, /protocolSequenceCatalog\(target\)/u)
  assert.match(probe, /pg_depend[\s\S]*?dep\.deptype IN \('a','i'\)/u)
  assert.match(probe, /pg_catalog\.lower\(pg_catalog\.pg_get_expr\(d\.adbin,d\.adrelid\)\) LIKE '%nextval\(%'/u)
  assert.match(probe, /reconciliation_sequence varchar CHECK/u)
  assert.match(probe, /'9223372036854775808'/u)
  assert.match(probe, /const current = await one\(target, 'SELECT sequence::text,chain_sha256,coverage_version,write_barrier FROM public\.owner_news_mutation_head WHERE singleton'\)/u)
  assert.match(probe, /sealTarget\.reconciliation_sequence === current\.sequence/u)
  assert.match(probe, /sealTarget\.reconciliation_chain_sha256\s*===\s*current\.chain_sha256/u)
  assert.match(probe, /current\.sequence,current\.chain_sha256,hexA/u)
  assert.match(probe, /sealRunAfter\) === JSON\.stringify\(sealRunBefore\)/u)
  assert.match(probe, /seal_text_bigint_match_reached_coverage_zero_denial_without_function_mutation/u)
  assert.match(probe, /VALUES \(\$1::uuid,\$2::text,'protocol-fixture',\$2::text,1,'reconciled','open','acknowledged','0',\$3::text,\$2::text,\$2::text/u)
  assert.doesNotMatch(probe, /NEWS_MIGRATION_CONTROL_COLUMNS_DDL/u)
})
