import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { buildNewsMutationTriggersDDL, NEWS_MUTATION_TRIGGER_TABLES, NEWS_MUTATION_OWNER_FRAGMENTS } from '../../src/publication/mutation-triggers'
import { NEWS_MUTATION_LEDGER_DDL, NEWS_MUTATION_TABLES } from '../../src/publication/mutation-ledger'
import { buildNewsMigrationBootstrapRunDDL, NEWS_BOOTSTRAP_OWNER_FRAGMENTS } from '../../src/publication/bootstrap-run'
import { NEWS_MIGRATION_ITEM_BINDING_DDL, NEWS_BINDING_OWNER_FRAGMENTS, canonicalTriggerDefinitions,
  extractCanonicalFunctionBodies } from '../../scripts/finalize-news-protocol'
import { observerRelationProvisioningSQL, observerRelationOnlyProvisioningSQL,
  buildNewsProtocolObserverProvisioningSQL } from '../../scripts/news-protocol-observer-contract'

const ddl = buildNewsMutationTriggersDDL()

test('observer literal split preserves independently captured published aggregates', () => {
  // Captured from 1310efc and compared with the scope-amendment saved bytes
  // before editing the observer module, for both explicit database inputs.
  const expected = [
    ['ownerinc', 'ee99196efddd4b6f4e7d04f770f3052a23ee49fe26b12d3b2b0cbff596a74e91', 'e6f98f71f6a58ba04be95c2bcd9c4254ff0dfe2ce3e9b531cf3c0d9a41979ca6'],
    ['portal_main', '8d5e90707f05069b6fbeb4ac584be78e5a864c636e0b8e185778d3ab83e565fc', 'eccc25466b1bdc6a98ed279e977c92a370cc94f4a003328428016944e68bff2d'],
  ]
  const hash = (sql: string) => createHash('sha256').update(sql).digest('hex')
  for (const [database, relationHash, aggregateHash] of expected) {
    assert.equal(hash(observerRelationProvisioningSQL(database!)), relationHash)
    assert.equal(hash(buildNewsProtocolObserverProvisioningSQL(database!)), aggregateHash)
    const relationOnly = observerRelationOnlyProvisioningSQL(database!)
    assert.doesNotMatch(relationOnly, /ON FUNCTIONS|SET (?:LOCAL )?ROLE|CREATE ROLE/u)
    assert.match(relationOnly, /ALTER DEFAULT PRIVILEGES[^;]*ON TABLES/u)
    assert.match(relationOnly, /ALTER DEFAULT PRIVILEGES[^;]*ON SEQUENCES/u)
    const legacyLines = observerRelationProvisioningSQL(database!).split('\n')
    const omitted = legacyLines.filter(line => line.includes('ON FUNCTIONS'))
    assert.deepEqual(omitted, ['ALTER DEFAULT PRIVILEGES FOR ROLE cms_migrator IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM cms_observer;'])
    assert.equal(relationOnly, legacyLines.filter(line => !line.includes('ON FUNCTIONS')).join('\n'))
  }
})

test('owner fragments preserve independently captured 1310efc aggregate, body and 80-trigger bytes', () => {
  // Captured from git-show 1310efcf9efbc47ce7a159c89e336f89a5122b0f before
  // refactoring. Do not regenerate these expectations from the current builders.
  const hash = (value: string) => createHash('sha256').update(value).digest('hex')
  assert.equal(hash(ddl), '3ba4a65081597dc509e186e2139f20861d4cf469189d314796e49eb49a73eec6')
  assert.equal(hash(buildNewsMigrationBootstrapRunDDL()), 'b6deead27fd3e315392db836d2cd53855c61a182ece69f8d5da799089343d66d')
  assert.equal(hash(NEWS_MIGRATION_ITEM_BINDING_DDL), '577a64b4a247a5f23af711a5672d8effbab7f7f3aec02403464dc1c643cfb627')
  const expected = new Map([
    ['owner_news_mutation_guard_stmt', 'a78b49c80342746d2a0c316d95af2469f08b320d13439c4aca339db0bd12e332'],
    ['owner_news_mutation_capture_row', '585f9f3d3fd2daaff59ba9e4399113505bb143eae7a21f6a0e005e2b8d9709d2'],
    ['owner_news_seal_run', 'bf3916410814f0cba4c542ddfc692f1510e93afe95da695444cd8bd36bc2624b'],
    ['owner_news_migration_item_binding_guard', 'e90203d4bd2bdc012b045bf47bca26fe15277d6296cfd8a347f948c817d549a3'],
    ['owner_news_bootstrap_run', 'f64559022a5f9252db4aaceab52a301e9c18ba27aa99c184040d09f00be0cab4'],
  ])
  const fragments = [NEWS_MUTATION_OWNER_FRAGMENTS, NEWS_BINDING_OWNER_FRAGMENTS, NEWS_BOOTSTRAP_OWNER_FRAGMENTS]
  const bodies = extractCanonicalFunctionBodies(fragments.map(value => value.functionCreate).join('\n'), [...expected.keys()])
  assert.deepEqual(new Map([...bodies].map(([name, body]) => [name, hash(body)])), expected)
  assert.equal(canonicalTriggerDefinitions.size, 80)
  assert.equal(hash(JSON.stringify([...canonicalTriggerDefinitions])), '023d759e96f567fb7e8a89b3adb45f5063097148c0d50a050d78817754bb870e')
  for (const part of fragments) {
    assert.doesNotMatch(part.functionCreate, /ALTER FUNCTION|GRANT|REVOKE/u)
    assert.doesNotMatch(part.functionACL, /CREATE|ALTER|ON (?:TABLE|SCHEMA)|DEFAULT PRIVILEGES/u)
    assert.doesNotMatch(part.relationGrants, /FUNCTION|ON SCHEMA|OWNER TO/u)
    assert.doesNotMatch(part.triggers, /CREATE OR REPLACE FUNCTION|OWNER TO|GRANT|REVOKE/u)
  }
  const emittedTriggers = fragments.map(value => value.triggers).join('\n')
  assert.equal([...emittedTriggers.matchAll(/CREATE TRIGGER/gu)].length, 80)
  // Compare the literal trigger statements to the compatibility aggregate too.
  const triggerStatements = (value: string) => value.match(/CREATE TRIGGER[\s\S]*?EXECUTE FUNCTION[^;]+;/gu)
  assert.deepEqual(triggerStatements(emittedTriggers), triggerStatements(ddl + NEWS_MIGRATION_ITEM_BINDING_DDL))
})

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
  for (const table of ['news_articles', 'news_media', 'news_home']) assert.ok(NEWS_MUTATION_TABLES.includes(table))
  assert.ok(NEWS_MUTATION_TABLES.includes('news_schedules'), 'manual preflight proves this covered table stays empty')
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
  assert.match(probe, /INSERT INTO public\.news_media/u)
  assert.match(probe, /INSERT INTO public\.news_home/u)
  assert.match(probe, /ROLLBACK[\s\S]*?headAfterWrites\.sequence === '7'/u)
  assert.match(probe, /DELETE FROM public\.news_articles/u)
})
