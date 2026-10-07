import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { NEWS_MUTATION_LEDGER_DDL, NEWS_MUTATION_TABLES } from '../../src/publication/mutation-ledger.ts'
import { buildNewsMutationTriggersDDL } from '../../src/publication/mutation-triggers.ts'
import { grantsSQL, runtimeProtocolPrivilegesVerifySQL, runtimeProtocolFunctionsVerifySQL } from '../../scripts/provision-db.ts'

const fail = (code) => { throw Object.assign(new Error(code), { safeCode: code }) }
const quoteIdent = (value) => `"${value.replaceAll('"', '""')}"`
const zero = '0'.repeat(64)
const hexA = 'a'.repeat(64)
const uuidA = 'a1000000-0000-4000-8000-000000000001'
const statePath = join(process.env.LOCALAPPDATA ?? '', 'Temp', 'opencode', 'ownerinc-payload-local-validation-20261002', 'state.json')
const protocolRelations = ['owner_news_mutation_head', 'owner_news_mutation_events', 'news_migration_runs']

function requestedDatabase(argv) {
  if (argv.length !== 3 || argv[0] !== '--run' || argv[1] !== '--database'
    || !/^cms_protocol_test_[0-9a-f]{8}$/u.test(argv[2])) {
    fail('explicit_new_database_required')
  }
  return argv[2]
}

function assert(condition, code) { if (!condition) fail(code) }
async function connect(config) {
  const client = new pg.Client({ ...config, connectionTimeoutMillis: 5000, query_timeout: 8000 })
  await client.connect()
  await client.query(`SET statement_timeout = '5s'`)
  return client
}

async function one(client, sql, values = []) {
  const result = await client.query(sql, values)
  return result.rows[0]
}

async function expectSqlError(client, sql, code, values = []) {
  try { await client.query(sql, values) } catch (error) {
    if (error.code === code) return error
    fail(`unexpected_sql_error_${error.code || 'unknown'}`)
  }
  fail('expected_sql_denial_missing')
}

async function assertRoleIsolation(client, label) {
  const names = ['cms_runtime', 'cms_control', 'cms_controller']
  const membership = await client.query(`SELECT parent.rolname AS parent, member.rolname AS member
    FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
    JOIN pg_roles member ON member.oid=m.member
    WHERE parent.rolname = ANY($1::text[]) OR member.rolname = ANY($1::text[])`, [names])
  assert(membership.rows.length === 0, `${label}_role_membership_not_isolated`)
  const result = await client.query(`SELECT rolname,rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
    FROM pg_roles WHERE rolname=ANY($1::text[])`, [names])
  const roles = new Map(result.rows.map(row => [row.rolname, row]))
  assert(roles.size === names.length, `${label}_role_missing`)
  for (const name of names) {
    const role = roles.get(name)
    assert(!role.rolsuper && !role.rolcreatedb && !role.rolcreaterole && !role.rolreplication && !role.rolbypassrls,
      `${label}_${name}_admin_attribute`)
    assert(role.rolcanlogin === (name === 'cms_runtime'), `${label}_${name}_login_attribute`)
  }
}

async function assertRuntimePrivilegeBoundary(client, label, { enforce = true } = {}) {
  await assertRoleIsolation(client, label)
  await client.query('SET SESSION AUTHORIZATION cms_runtime')
  try {
    const privileges = await one(client, `SELECT
      has_table_privilege('cms_runtime','public.owner_news_mutation_head','SELECT') AS head_select,
      has_table_privilege('cms_runtime','public.owner_news_mutation_events','SELECT') AS event_select,
      (has_table_privilege('cms_runtime','public.owner_news_mutation_head','INSERT') OR has_table_privilege('cms_runtime','public.owner_news_mutation_head','UPDATE') OR
       has_table_privilege('cms_runtime','public.owner_news_mutation_head','DELETE') OR has_table_privilege('cms_runtime','public.owner_news_mutation_head','TRUNCATE')) AS head_write,
      (has_table_privilege('cms_runtime','public.owner_news_mutation_events','INSERT') OR has_table_privilege('cms_runtime','public.owner_news_mutation_events','UPDATE') OR
       has_table_privilege('cms_runtime','public.owner_news_mutation_events','DELETE') OR has_table_privilege('cms_runtime','public.owner_news_mutation_events','TRUNCATE')) AS event_write,
      has_table_privilege('cms_runtime','public.news_migration_runs','UPDATE') AS run_table_update,
      has_table_privilege('cms_runtime','public.news_migration_runs','INSERT') AS run_table_insert,
      has_column_privilege('cms_runtime','public.news_migration_runs','progress_state','UPDATE') AS ordinary_update,
      has_column_privilege('cms_runtime','public.news_migration_runs','reconciliation_sequence','UPDATE') AS reconciliation_sequence_update,
      has_column_privilege('cms_runtime','public.news_migration_runs','reconciliation_chain_sha256','UPDATE') AS reconciliation_chain_update,
      has_column_privilege('cms_runtime','public.news_migration_runs','sealed_sequence','UPDATE') AS sealed_sequence_update,
      has_column_privilege('cms_runtime','public.news_migration_runs','sealed_chain_sha256','UPDATE') AS sealed_chain_update,
      has_column_privilege('cms_runtime','public.news_migration_runs','sealed_at','UPDATE') AS sealed_at_update,
      has_column_privilege('cms_runtime','public.news_migration_runs','activation_epoch','UPDATE') AS activation_epoch_update,
      has_column_privilege('cms_runtime','public.news_migration_runs','drain_receipt_sha256','UPDATE') AS receipt_update,
      has_sequence_privilege('cms_runtime','public.cms_protocol_fixture_ordinary_seq','USAGE') AS ordinary_sequence_usage,
      has_sequence_privilege('cms_runtime','public.cms_protocol_fixture_ordinary_seq','SELECT') AS ordinary_sequence_select,
      has_sequence_privilege('cms_runtime','public.cms_protocol_fixture_ordinary_seq','UPDATE') AS ordinary_sequence_update,
      has_schema_privilege('cms_control','public','USAGE') AS control_usage,
      has_schema_privilege('cms_controller','public','USAGE') AS controller_usage,
      has_schema_privilege('cms_control','public','CREATE') AS control_create,
      has_function_privilege('cms_controller','public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text)','EXECUTE') AS controller_seal,
      has_function_privilege('cms_runtime','public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text)','EXECUTE') AS runtime_seal,
      has_function_privilege('cms_runtime','public.owner_news_mutation_capture_row()','EXECUTE') AS runtime_capture`)
    const privilegeOracle = await one(client, runtimeProtocolPrivilegesVerifySQL)
    const functionOracle = await one(client, runtimeProtocolFunctionsVerifySQL)
    if (!enforce) {
      console.log(`BASELINE ${label} privilege_oracle=${privilegeOracle.safe} function_oracle=${functionOracle.safe} run_table_update=${privileges.run_table_update} run_insert=${privileges.run_table_insert} ordinary_sequence_usage=${privileges.ordinary_sequence_usage}`)
      return { privileges, privilegeOracle: privilegeOracle.safe, functionOracle: functionOracle.safe }
    }

    assert(privileges.head_select && privileges.event_select && !privileges.head_write && !privileges.event_write, `${label}_runtime_ledger_privilege`)
    assert(!privileges.run_table_update && privileges.ordinary_update, `${label}_runtime_run_update_scope`)
    for (const field of ['reconciliation_sequence_update', 'reconciliation_chain_update', 'sealed_sequence_update',
      'sealed_chain_update', 'sealed_at_update', 'activation_epoch_update', 'receipt_update']) {
      assert(!privileges[field], `${label}_runtime_proof_column_${field}`)
    }
    assert(privileges.control_usage && privileges.controller_usage && !privileges.control_create, `${label}_control_schema_privilege`)
    assert(privileges.controller_seal && !privileges.runtime_seal && !privileges.runtime_capture, `${label}_runtime_function_privilege`)
    assert(privilegeOracle.safe === true, `${label}_production_privilege_oracle_failed`)
    assert(functionOracle.safe === true, `${label}_production_function_oracle_failed`)
    assert(privileges.ordinary_sequence_usage && privileges.ordinary_sequence_select && !privileges.ordinary_sequence_update,
      `${label}_ordinary_sequence_grant_wrong`)

    await expectSqlError(client, 'UPDATE public.owner_news_mutation_head SET sequence=sequence WHERE singleton', '42501')
    await expectSqlError(client, `INSERT INTO public.owner_news_mutation_events(sequence,table_name,operation,row_key,transaction_id,previous_sha256,event_sha256)
      VALUES (99,'news_articles','INSERT','x','x',$1,$1)`, '42501', [zero])
    for (const field of ['admission_state', 'reconciliation_sequence', 'reconciliation_chain_sha256',
      'sealed_sequence', 'sealed_chain_sha256', 'sealed_at', 'activation_epoch', 'drain_receipt_sha256']) {
      await expectSqlError(client, `UPDATE public.news_migration_runs SET ${field}=${field} WHERE id='a1000000-0000-4000-8000-000000000001'`, '42501')
    }
    await expectSqlError(client, `SELECT * FROM public.owner_news_seal_run($1::uuid,$2,1,0,$3,$4,'fixture')`, '42501',
      ['a1000000-0000-4000-8000-000000000001', 'a'.repeat(64), zero, 'a'.repeat(64)])
    await expectSqlError(client, 'ALTER TABLE public.news_articles DISABLE TRIGGER owner_news_mutation_guard_stmt', '42501')
    await expectSqlError(client, 'CREATE FUNCTION public.protocol_probe() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$', '42501')
    const truncate = await expectSqlError(client, 'TRUNCATE public.news_articles', '55000')
    assert(truncate.message.includes('owner_news_truncate_forbidden'), `${label}_truncate_not_trigger_rejected`)
  } finally {
    await client.query('RESET SESSION AUTHORIZATION')
  }
}

const pass = (label) => console.log(`PASS ${label}`)

async function protocolSequenceCatalog(client) {
  const owned = await client.query(`SELECT seq.relname AS sequence_name, table_rel.relname AS table_name, attr.attname AS column_name
    FROM pg_class seq JOIN pg_depend dep ON dep.objid=seq.oid AND dep.classid='pg_class'::regclass
      AND dep.refclassid='pg_class'::regclass AND dep.deptype IN ('a','i')
    JOIN pg_class table_rel ON table_rel.oid=dep.refobjid
    JOIN pg_namespace n ON n.oid=table_rel.relnamespace
    LEFT JOIN pg_attribute attr ON attr.attrelid=table_rel.oid AND attr.attnum=dep.refobjsubid
    WHERE seq.relkind='S' AND n.nspname='public' AND table_rel.relname=ANY($1::text[])
    ORDER BY table_rel.relname,seq.relname`, [protocolRelations])
  const defaults = await client.query(`SELECT c.relname AS table_name, a.attname AS column_name,
      pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS expression
    FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=d.adnum
    WHERE n.nspname='public' AND c.relname=ANY($1::text[])
      AND pg_catalog.lower(pg_catalog.pg_get_expr(d.adbin,d.adrelid)) LIKE '%nextval(%'
    ORDER BY c.relname,a.attname`, [protocolRelations])
  return { owned: owned.rows, nextvalDefaults: defaults.rows }
}

async function assertNativeTextCounterConstraints(client) {
  const headBefore = await one(client, 'SELECT sequence::text FROM public.owner_news_mutation_head WHERE singleton')
  const eventsBefore = await one(client, 'SELECT count(*)::int AS count FROM public.owner_news_mutation_events')
  for (const field of ['reconciliation_sequence', 'sealed_sequence']) {
    for (const value of ['00', '-1', '9223372036854775808', 'not-a-counter']) {
      await expectSqlError(client, `UPDATE public.news_migration_runs SET ${field}=$1 WHERE id=$2::uuid`,
        '23514', [value, uuidA])
    }
  }
  const row = await one(client, 'SELECT reconciliation_sequence FROM public.news_migration_runs WHERE id=$1::uuid', [uuidA])
  const headAfter = await one(client, 'SELECT sequence::text FROM public.owner_news_mutation_head WHERE singleton')
  const eventsAfter = await one(client, 'SELECT count(*)::int AS count FROM public.owner_news_mutation_events')
  assert(row.reconciliation_sequence === '0', 'invalid_text_counter_changed_fixture')
  assert(headAfter.sequence === headBefore.sequence && eventsAfter.count === eventsBefore.count,
    'invalid_text_counter_emitted_mutation')
}

async function run() {
  const database = requestedDatabase(process.argv.slice(2))
  const state = JSON.parse(await readFile(statePath, 'utf8'))
  const password = state?.passwords?.postgres
  if (typeof password !== 'string' || password.length < 32) fail('private_pg_credential_missing')
  const adminConfig = { host: '127.0.0.1', port: 55441, user: 'postgres', password, database: 'postgres' }
  let phase = 'connect_admin'
  const admin = await connect(adminConfig)
  let target
  try {
    phase = 'server_identity'
    const server = await one(admin, 'SELECT current_user, current_database(), version()')
    assert(server.current_user === 'postgres' && server.current_database === 'postgres', 'unexpected_admin_identity')
    assert(server.version.startsWith('PostgreSQL 16.'), 'postgres_16_required')
    console.log(`SERVER ${server.version.split(' ').slice(0, 2).join(' ')}`)

    phase = 'database_absence_check'
    const existingDb = await one(admin, 'SELECT 1 FROM pg_database WHERE datname = $1', [database])
    assert(!existingDb, 'target_database_already_exists')
    phase = 'role_preflight'
    const roles = await admin.query(`SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
      FROM pg_roles WHERE rolname IN ('cms_control','cms_controller','cms_runtime') ORDER BY rolname`)
    const byName = new Map(roles.rows.map(role => [role.rolname, role]))
    assert(byName.has('cms_runtime'), 'cms_runtime_role_missing')
    for (const roleName of ['cms_control', 'cms_controller']) {
      const found = byName.get(roleName)
      if (!found) {
        await admin.query(`CREATE ROLE ${quoteIdent(roleName)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`)
        continue
      }
      assert(!found.rolcanlogin && !found.rolsuper && !found.rolcreatedb && !found.rolcreaterole
        && !found.rolreplication && !found.rolbypassrls, `existing_${roleName}_role_not_safe`)
    }
    await assertRoleIsolation(admin, 'cluster_preflight')
    await admin.query(`CREATE DATABASE ${quoteIdent(database)}`)
    pass('new_database_created')

    phase = 'fixture'
    target = await connect({ ...adminConfig, database })
    await target.query('REVOKE ALL ON SCHEMA public FROM PUBLIC')
    await target.query('GRANT USAGE ON SCHEMA public TO cms_runtime')
    await target.query(`CREATE TABLE public.news_migration_runs (
      id uuid PRIMARY KEY, manifest_sha256 text NOT NULL, source_instance text NOT NULL,
      source_fingerprint text NOT NULL, authority_epoch integer NOT NULL,
      progress_state text NOT NULL, admission_state text NOT NULL, commit_outcome text NOT NULL,
      reconciliation_sequence varchar CHECK (reconciliation_sequence IS NULL OR CASE
        WHEN reconciliation_sequence ~ '^(0|[1-9][0-9]*)$' THEN CASE
          WHEN length(reconciliation_sequence) <= 19 THEN reconciliation_sequence::numeric <= 9223372036854775807::numeric
          ELSE false END ELSE false END),
      reconciliation_chain_sha256 varchar,
      reconciliation_sha256 varchar, destination_fingerprint varchar,
      unresolved_exceptions jsonb NOT NULL DEFAULT '[]'::jsonb,
      sealed_sequence varchar CHECK (sealed_sequence IS NULL OR CASE
        WHEN sealed_sequence ~ '^(0|[1-9][0-9]*)$' THEN CASE
          WHEN length(sealed_sequence) <= 19 THEN sealed_sequence::numeric <= 9223372036854775807::numeric
          ELSE false END ELSE false END),
      sealed_chain_sha256 varchar, sealed_at timestamptz,
      activation_epoch integer, drain_receipt_sha256 varchar,
      CHECK ((reconciliation_sequence IS NULL) = (reconciliation_chain_sha256 IS NULL)),
      CHECK ((sealed_sequence IS NULL) = (sealed_chain_sha256 IS NULL)
        AND (sealed_sequence IS NULL) = (sealed_at IS NULL)),
      CHECK (admission_state <> 'sealed' OR (progress_state='reconciled' AND commit_outcome='acknowledged'
        AND reconciliation_sequence IS NOT NULL AND reconciliation_chain_sha256 IS NOT NULL
        AND reconciliation_sha256 IS NOT NULL AND destination_fingerprint IS NOT NULL
        AND sealed_sequence IS NOT NULL AND sealed_chain_sha256 IS NOT NULL AND sealed_at IS NOT NULL
        AND CASE WHEN reconciliation_sequence ~ '^(0|[1-9][0-9]*)$' AND sealed_sequence ~ '^(0|[1-9][0-9]*)$'
          AND length(reconciliation_sequence) <= 19 AND length(sealed_sequence) <= 19
          THEN sealed_sequence::numeric >= reconciliation_sequence::numeric ELSE false END
        AND activation_epoch=authority_epoch+1 AND drain_receipt_sha256 IS NOT NULL))
    )`)
    await target.query(`CREATE TABLE public.news_migration_items (id uuid PRIMARY KEY, marker text)`)
    for (const table of NEWS_MUTATION_TABLES) {
      if (table === 'news_migration_runs' || table === 'news_migration_items') continue
      await target.query(`CREATE TABLE public.${quoteIdent(table)} (id uuid PRIMARY KEY, marker text)`)
    }
    await target.query('CREATE TABLE public.payload_migrations (id uuid PRIMARY KEY, name text)')
    await target.query('CREATE SEQUENCE public.cms_protocol_fixture_ordinary_seq')
    await target.query(`INSERT INTO public.news_migration_runs
      (id,manifest_sha256,source_instance,source_fingerprint,authority_epoch,progress_state,admission_state,commit_outcome,
       reconciliation_sequence,reconciliation_chain_sha256,reconciliation_sha256,destination_fingerprint,unresolved_exceptions)
      VALUES ($1::uuid,$2::text,'protocol-fixture',$2::text,1,'reconciled','open','acknowledged','0',$3::text,$2::text,$2::text,'[]'::jsonb)`, [uuidA, hexA, zero])
    phase = 'protocol_sequence_precheck'
    const sequenceBeforeProtocolDdl = await protocolSequenceCatalog(target)
    assert(sequenceBeforeProtocolDdl.owned.length === 0 && sequenceBeforeProtocolDdl.nextvalDefaults.length === 0,
      'protocol_sequence_exists_before_protocol_ddl')
    await target.query(NEWS_MUTATION_LEDGER_DDL)
    // These grants are test-fixture privileges only; the disposable database has
    // dummy relations, never the installed Payload schema or service data.
    for (const table of NEWS_MUTATION_TABLES) {
      await target.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${quoteIdent(table)} TO cms_runtime`)
    }
    await target.query('GRANT TRUNCATE ON public.news_articles TO cms_runtime')

    phase = 'builder'
    await target.query(buildNewsMutationTriggersDDL())
    pass('builder_applied_all_39_relations')
    const sequenceAfterProtocolDdl = await protocolSequenceCatalog(target)
    assert(sequenceAfterProtocolDdl.owned.length === 0 && sequenceAfterProtocolDdl.nextvalDefaults.length === 0,
      'protocol_ddl_created_owned_sequence_or_nextval_default')
    console.log(`PROTOCOL_SEQUENCE_CATALOG before=${sequenceBeforeProtocolDdl.owned.length} after=${sequenceAfterProtocolDdl.owned.length} nextval_defaults=${sequenceAfterProtocolDdl.nextvalDefaults.length}`)
    const pg16Hash = await one(target, `SELECT encode(pg_catalog.sha256(pg_catalog.convert_to('abc','UTF8')),'hex') AS digest`)
    assert(pg16Hash.digest === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'pg16_sha256_vector_mismatch')
    console.log(`SHA256_VECTOR abc=${pg16Hash.digest}`)

    phase = 'triggers'
    const triggerState = await one(target, `SELECT count(*)::int AS total,
      count(*) FILTER (WHERE tgenabled='A')::int AS always_enabled
      FROM pg_trigger WHERE NOT tgisinternal AND (tgname='owner_news_mutation_guard_stmt' OR tgname='owner_news_mutation_capture_row')`)
    assert(triggerState.total === NEWS_MUTATION_TABLES.length * 2 && triggerState.always_enabled === NEWS_MUTATION_TABLES.length * 2, 'trigger_inventory_incomplete')
    const initialHead = await one(target, 'SELECT sequence::text,chain_sha256,coverage_version,write_barrier FROM public.owner_news_mutation_head WHERE singleton')
    assert(initialHead.sequence === '0' && initialHead.chain_sha256 === zero && initialHead.coverage_version === 0, 'coverage_must_remain_zero')
    await assertNativeTextCounterConstraints(target)
    pass('native_varchar_counter_constraints_reject_malformed_overflow_and_noncanonical_values')
    pass('all_triggers_always_enabled_coverage_zero')

    phase = 'runtime_mutations'
    await target.query('SET SESSION AUTHORIZATION cms_runtime')
    const article = 'a2000000-0000-4000-8000-000000000001'
    await target.query('INSERT INTO public.news_articles(id,marker) VALUES ($1,$2)', [article, 'before'])
    await target.query('UPDATE public.news_articles SET marker=marker WHERE id=$1', [article])
    await target.query("UPDATE public.news_articles SET marker='after' WHERE id=$1", [article])
    await target.query("UPDATE public.news_articles SET marker='before' WHERE id=$1", [article])
    await target.query('DELETE FROM public.news_articles WHERE id=$1', [article])
    await target.query('BEGIN')
    await target.query('INSERT INTO public.news_articles(id,marker) VALUES ($1,$2)', ['a2000000-0000-4000-8000-000000000002', 'rollback'])
    await target.query('ROLLBACK')
    const headAfterWrites = await one(target, 'SELECT sequence::text,chain_sha256,coverage_version FROM public.owner_news_mutation_head WHERE singleton')
    assert(headAfterWrites.sequence === '5' && headAfterWrites.coverage_version === 0, 'mutation_sequence_or_coverage_incorrect')
    await target.query('RESET SESSION AUTHORIZATION')
    await target.query(`CREATE FUNCTION public.protocol_test_bookkeeping(value bigint, hash text) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
      BEGIN
        UPDATE public.news_migration_runs SET sealed_sequence=value,sealed_chain_sha256=hash,
          sealed_at=pg_catalog.clock_timestamp(),reconciliation_sequence=value::text,
          reconciliation_chain_sha256=hash WHERE id='${uuidA}'::uuid;
      END $$`)
    await target.query('REVOKE ALL ON FUNCTION public.protocol_test_bookkeeping(bigint,text) FROM PUBLIC')
    await target.query('ALTER FUNCTION public.protocol_test_bookkeeping(bigint,text) OWNER TO cms_control')
    await target.query('GRANT EXECUTE ON FUNCTION public.protocol_test_bookkeeping(bigint,text) TO cms_controller,cms_runtime')
    const beforeControllerBookkeeping = await one(target, 'SELECT sequence::text FROM public.owner_news_mutation_head WHERE singleton')
    await target.query('SET SESSION AUTHORIZATION cms_controller')
    await target.query('SELECT public.protocol_test_bookkeeping(0,$1)', [hexA])
    await target.query('RESET SESSION AUTHORIZATION')
    const afterControllerBookkeeping = await one(target, 'SELECT sequence::text FROM public.owner_news_mutation_head WHERE singleton')
    assert(afterControllerBookkeeping.sequence === beforeControllerBookkeeping.sequence, 'cms_controller_bookkeeping_was_logged')
    await target.query('SET SESSION AUTHORIZATION cms_runtime')
    await target.query('SELECT public.protocol_test_bookkeeping(1,$1)', ['b'.repeat(64)])
    await target.query('RESET SESSION AUTHORIZATION')
    const afterRuntimeBookkeeping = await one(target, 'SELECT sequence::text FROM public.owner_news_mutation_head WHERE singleton')
    assert(afterRuntimeBookkeeping.sequence === String(BigInt(beforeControllerBookkeeping.sequence) + 1n), 'runtime_bookkeeping_was_exempted')
    const events = await target.query(`SELECT sequence::text,event_id::text,table_name,operation,row_key,transaction_id,
      before_sha256,after_sha256,previous_sha256,event_sha256,
      encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_array(1,previous_sha256,sequence::text,
        event_id::text,table_name,operation,row_key,transaction_id,before_sha256,after_sha256)::text,'UTF8')),'hex') AS recomputed
      FROM public.owner_news_mutation_events ORDER BY sequence`)
    assert(events.rows.length === 6, 'rollback_or_runtime_bookkeeping_mutation_not_logged')
    let previous = zero
    for (let index = 0; index < events.rows.length; index++) {
      const event = events.rows[index]
      assert(event.sequence === String(index + 1), 'mutation_sequence_gap')
      assert(event.previous_sha256 === previous, 'mutation_previous_hash_mismatch')
      assert(event.event_sha256 === event.recomputed, 'mutation_event_hash_mismatch')
      previous = event.event_sha256
    }
    const afterImage = events.rows[0].after_sha256
    const expectedImage = await one(target, `SELECT encode(pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_object('id',$1::uuid,'marker','before')::text,'UTF8')),'hex') AS digest`, [article])
    assert(afterImage === expectedImage.digest, 'row_image_hash_mismatch')
    pass('insert_noop_edit_undo_delete_rollback_hash_chain_and_session_user_bookkeeping')

    phase = 'pre_grants_security'
    const headBeforeGrants = await one(target, 'SELECT sequence::text,chain_sha256 FROM public.owner_news_mutation_head WHERE singleton')
    const countBeforeGrants = await one(target, 'SELECT count(*)::int AS count FROM public.owner_news_mutation_events')
    const preGrants = await assertRuntimePrivilegeBoundary(target, 'pre_grants', { enforce: false })
    assert(preGrants.privilegeOracle === false, 'pre_grants_default_run_privileges_not_observed')
    pass('pre_grants_baseline_captured_without_runtime_mutation')

    phase = 'actual_production_grants_sql'
    await target.query(grantsSQL)
    pass('actual_provision_db_grants_sql_executed_once')

    phase = 'post_grants_security'
    const postGrantFirst = await assertRuntimePrivilegeBoundary(target, 'post_grants_first')
    pass('post_grants_first_effective_privilege_and_denial_checks')
    await target.query(grantsSQL)
    const postGrantSecond = await assertRuntimePrivilegeBoundary(target, 'post_grants_second')
    assert(JSON.stringify(postGrantFirst) === JSON.stringify(postGrantSecond), 'actual_grants_sql_not_idempotent')
    pass('actual_provision_db_grants_sql_idempotent_twice')
    const headAfterGrants = await one(target, 'SELECT sequence::text,chain_sha256 FROM public.owner_news_mutation_head WHERE singleton')
    const countAfterGrants = await one(target, 'SELECT count(*)::int AS count FROM public.owner_news_mutation_events')
    assert(headAfterGrants.sequence === headBeforeGrants.sequence && headAfterGrants.chain_sha256 === headBeforeGrants.chain_sha256
      && countAfterGrants.count === countBeforeGrants.count, 'post_grants_changed_protected_ledger')
    pass('post_grants_runtime_ledger_proof_function_sequence_and_ddl_denials')

    phase = 'barrier'
    await target.query(`UPDATE public.owner_news_mutation_head SET write_barrier='frozen',barrier_run_id=$1::uuid,
      barrier_epoch=1,barrier_receipt_sha256=$2 WHERE singleton`, [uuidA,hexA])
    await target.query('SET SESSION AUTHORIZATION cms_runtime')
    const barrierError = await expectSqlError(target, `INSERT INTO public.news_articles(id,marker) VALUES ('a2000000-0000-4000-8000-000000000003','blocked')`, '55000')
    assert(barrierError.message.includes('owner_news_mutations_blocked'), 'write_barrier_not_enforced')
    await target.query('RESET SESSION AUTHORIZATION')
    await target.query(`UPDATE public.owner_news_mutation_head SET write_barrier='open',barrier_run_id=NULL,
      barrier_epoch=NULL,barrier_receipt_sha256=NULL WHERE singleton`)
    pass('closed_barrier_rejects_runtime_write')

    phase = 'seal_coverage_gate'
    // Align the native text run proof exactly with the mutation head so the only
    // remaining denial is coverage_version=0, after the text/bigint comparison.
    const current = await one(target, 'SELECT sequence::text,chain_sha256,coverage_version,write_barrier FROM public.owner_news_mutation_head WHERE singleton')
    await target.query('SET SESSION AUTHORIZATION cms_controller')
    await target.query('SELECT public.protocol_test_bookkeeping($1::bigint,$2)', [current.sequence,current.chain_sha256])
    await target.query('RESET SESSION AUTHORIZATION')
    const sealTarget = await one(target, 'SELECT reconciliation_sequence,reconciliation_chain_sha256 FROM public.news_migration_runs WHERE id=$1::uuid', [uuidA])
    assert(current.coverage_version === 0 && current.write_barrier === 'open'
      && sealTarget.reconciliation_sequence === current.sequence
      && sealTarget.reconciliation_chain_sha256 === current.chain_sha256, 'seal_text_counter_fixture_not_head_aligned')
    const sealRunBefore = await one(target, `SELECT admission_state,activation_epoch,drain_receipt_sha256,sealed_sequence,
      sealed_chain_sha256,sealed_at,reconciliation_sequence,reconciliation_chain_sha256
      FROM public.news_migration_runs WHERE id=$1::uuid`, [uuidA])
    await target.query('SET SESSION AUTHORIZATION cms_controller')
    const sealError = await expectSqlError(target, `SELECT * FROM public.owner_news_seal_run($1::uuid,$2,1,$3::bigint,$4,$5,'fixture')`,
      '40001', [uuidA,hexA,current.sequence,current.chain_sha256,hexA])
    assert(sealError.message.includes('migration_seal_head_conflict'), 'coverage_zero_seal_failure_not_explicit')
    await target.query('RESET SESSION AUTHORIZATION')
    const sealRunAfter = await one(target, `SELECT admission_state,activation_epoch,drain_receipt_sha256,sealed_sequence,
      sealed_chain_sha256,sealed_at,reconciliation_sequence,reconciliation_chain_sha256
      FROM public.news_migration_runs WHERE id=$1::uuid`, [uuidA])
    assert(JSON.stringify(sealRunAfter) === JSON.stringify(sealRunBefore), 'coverage_zero_seal_mutated_run')
    const finalHead = await one(target, 'SELECT sequence::text,chain_sha256,coverage_version,write_barrier FROM public.owner_news_mutation_head WHERE singleton')
    assert(finalHead.coverage_version === 0 && finalHead.write_barrier === 'open'
      && finalHead.sequence === current.sequence && finalHead.chain_sha256 === current.chain_sha256,
    'coverage_or_barrier_promoted_or_seal_mutated_head')
    pass('seal_text_bigint_match_reached_coverage_zero_denial_without_function_mutation')
    pass(`complete database=${database} relations=${NEWS_MUTATION_TABLES.length} events=${events.rows.length}`)
  } catch (error) {
    console.log(`FAIL phase=${phase} code=${error.safeCode || error.code || error.name || 'unknown'}`)
    process.exitCode = 1
  } finally {
    await target?.end().catch(() => {})
    await admin.end().catch(() => {})
  }
}

run().catch(error => {
  console.log(`FAIL phase=bootstrap code=${error.safeCode || error.code || error.name || 'unknown'}`)
  process.exitCode = 1
})
