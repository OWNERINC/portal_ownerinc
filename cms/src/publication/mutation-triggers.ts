import { NEWS_MUTATION_TABLES } from './mutation-ledger'

const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`
const qualifiedTable = (table: string): string => `public.${quoteIdentifier(table)}`
const bookkeepingColumns = [
  'reconciliation_sequence',
  'reconciliation_chain_sha256',
  'sealed_sequence',
  'sealed_chain_sha256',
  'sealed_at',
] as const
const bookkeepingArray = `ARRAY[${bookkeepingColumns.map(value => `'${value}'`).join(',')}]::text[]`

/**
 * SQL for the migration owner. The caller must first provision cms_control as a
 * distinct NOLOGIN role and cms_controller as the private control connection
 * role; neither role receives a password or other credential from this module.
 * This is executable migration SQL, not a runtime installer.
 */
export function buildNewsMutationTriggersDDL(): string {
  const triggerInstall = NEWS_MUTATION_TABLES.map(table => {
    const quoted = quoteIdentifier(table)
    const qualified = qualifiedTable(table)
    return `
DROP TRIGGER IF EXISTS owner_news_mutation_guard_stmt ON ${qualified};
CREATE TRIGGER owner_news_mutation_guard_stmt
BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${qualified}
FOR EACH STATEMENT EXECUTE FUNCTION public.owner_news_mutation_guard_stmt();
DROP TRIGGER IF EXISTS owner_news_mutation_capture_row ON ${qualified};
CREATE TRIGGER owner_news_mutation_capture_row
AFTER INSERT OR UPDATE OR DELETE ON ${qualified}
FOR EACH ROW EXECUTE FUNCTION public.owner_news_mutation_capture_row();
ALTER TABLE ${qualified} ENABLE ALWAYS TRIGGER owner_news_mutation_guard_stmt;
ALTER TABLE ${qualified} ENABLE ALWAYS TRIGGER owner_news_mutation_capture_row;`
  }).join('\n')

  return `
-- Requires PostgreSQL 16's built-in pg_catalog.sha256(bytea); no extension is
-- installed implicitly. Integration must verify the exact function on PG16.
CREATE OR REPLACE FUNCTION public.owner_news_mutation_guard_stmt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $owner_news$
DECLARE
  barrier text;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(7194030);
  SELECT write_barrier INTO barrier
    FROM public.owner_news_mutation_head WHERE singleton = TRUE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owner_news_mutation_ledger_unavailable' USING ERRCODE = '55000';
  END IF;
  IF barrier <> 'open' AND current_user <> 'cms_control' THEN
    RAISE EXCEPTION 'owner_news_mutations_blocked' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'owner_news_truncate_forbidden' USING ERRCODE = '55000';
  END IF;
  RETURN NULL;
END;
$owner_news$;

CREATE OR REPLACE FUNCTION public.owner_news_mutation_capture_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $owner_news$
DECLARE
  old_json jsonb;
  new_json jsonb;
  before_hash text;
  after_hash text;
  previous_hash text;
  event_hash text;
  row_key text;
  event_uuid uuid := pg_catalog.gen_random_uuid();
  next_sequence bigint;
BEGIN
  IF TG_OP <> 'INSERT' THEN old_json := pg_catalog.to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_json := pg_catalog.to_jsonb(NEW); END IF;
  IF old_json IS NOT NULL THEN
    before_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(old_json::text, 'UTF8')), 'hex');
  END IF;
  IF new_json IS NOT NULL THEN
    after_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(new_json::text, 'UTF8')), 'hex');
  END IF;
  row_key := COALESCE(new_json->>'id', old_json->>'id');
  IF row_key IS NULL THEN
    RAISE EXCEPTION 'owner_news_mutation_primary_key_missing' USING ERRCODE = '55000';
  END IF;

  SELECT sequence, chain_sha256 INTO next_sequence, previous_hash
    FROM public.owner_news_mutation_head WHERE singleton = TRUE FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'owner_news_mutation_ledger_unavailable' USING ERRCODE = '55000';
  END IF;
  next_sequence := next_sequence + 1;
  event_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_array(1, previous_hash, next_sequence::text, event_uuid::text,
      TG_TABLE_NAME, TG_OP, row_key, pg_catalog.txid_current()::text,
      before_hash, after_hash)::text, 'UTF8')), 'hex');

  -- session_user is deliberately used here: current_user is cms_control in this
  -- SECURITY DEFINER function and cannot distinguish normal writes from control.
  IF TG_TABLE_NAME = 'news_migration_runs' AND session_user = 'cms_controller'
     AND (old_json - ${bookkeepingArray}) = (new_json - ${bookkeepingArray})
     AND old_json IS DISTINCT FROM new_json THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.owner_news_mutation_events
    (sequence, event_id, table_name, operation, row_key, transaction_id,
     before_sha256, after_sha256, previous_sha256, event_sha256)
  VALUES (next_sequence, event_uuid, TG_TABLE_NAME, TG_OP, row_key,
    pg_catalog.txid_current()::text, before_hash, after_hash, previous_hash, event_hash);
  UPDATE public.owner_news_mutation_head
    SET sequence = next_sequence, chain_sha256 = event_hash
    WHERE singleton = TRUE;
  RETURN NULL;
END;
$owner_news$;

REVOKE ALL ON FUNCTION public.owner_news_mutation_guard_stmt() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.owner_news_mutation_capture_row() FROM PUBLIC;
REVOKE ALL ON public.owner_news_mutation_head, public.owner_news_mutation_events FROM PUBLIC;
REVOKE ALL ON public.owner_news_mutation_head, public.owner_news_mutation_events FROM cms_runtime;
GRANT USAGE ON SCHEMA public TO cms_control, cms_controller;
ALTER FUNCTION public.owner_news_mutation_guard_stmt() OWNER TO cms_control;
ALTER FUNCTION public.owner_news_mutation_capture_row() OWNER TO cms_control;
GRANT SELECT ON public.owner_news_mutation_head, public.owner_news_mutation_events TO cms_runtime;
GRANT SELECT, UPDATE ON public.owner_news_mutation_head TO cms_control;
GRANT INSERT ON public.owner_news_mutation_events TO cms_control;
GRANT SELECT ON public.news_migration_runs TO cms_control;
REVOKE UPDATE ON public.news_migration_runs FROM PUBLIC;
REVOKE UPDATE ON public.news_migration_runs FROM cms_runtime;
GRANT UPDATE (progress_state, commit_outcome, reconciliation_sha256,
  destination_fingerprint, unresolved_exceptions) ON public.news_migration_runs TO cms_runtime;
GRANT UPDATE (admission_state, activation_epoch, drain_receipt_sha256,
  reconciliation_sequence, reconciliation_chain_sha256,
  sealed_sequence, sealed_chain_sha256, sealed_at) ON public.news_migration_runs TO cms_control;

${triggerInstall}

CREATE OR REPLACE FUNCTION public.owner_news_seal_run(
  run uuid, manifest text, epoch integer, expected_seq bigint,
  expected_chain text, drain_receipt text, actor_uid text
) RETURNS TABLE(id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $owner_news$
DECLARE
  run_row public.news_migration_runs%ROWTYPE;
  head_sequence bigint;
  head_chain text;
  head_coverage integer;
  head_barrier text;
  head_found boolean;
  final_sequence bigint;
  final_chain text;
BEGIN
  -- Must precede every row lock: same serialization point as every content/job write.
  PERFORM pg_catalog.pg_advisory_xact_lock(7194030);
  SELECT sequence, chain_sha256, coverage_version, write_barrier
    INTO head_sequence, head_chain, head_coverage, head_barrier
    FROM public.owner_news_mutation_head WHERE singleton = TRUE FOR UPDATE;
  head_found := FOUND;

  SELECT runs.* INTO run_row FROM public.news_migration_runs AS runs
    WHERE runs.id = run FOR UPDATE;
  IF NOT FOUND OR run_row.id <> run OR run_row.manifest_sha256 <> manifest
     OR run_row.authority_epoch <> epoch OR run_row.admission_state <> 'open'
     OR run_row.progress_state <> 'reconciled' OR run_row.commit_outcome <> 'acknowledged'
     OR expected_seq IS NULL OR expected_seq < 0
     OR run_row.reconciliation_sequence IS NULL
     OR (CASE WHEN run_row.reconciliation_sequence ~ '^(0|[1-9][0-9]*)$'
          THEN CASE WHEN length(run_row.reconciliation_sequence) <= 19
            THEN run_row.reconciliation_sequence::numeric <= 9223372036854775807::numeric
            ELSE false END
          ELSE false END) IS NOT TRUE
     OR run_row.reconciliation_sequence IS DISTINCT FROM expected_seq::text
     OR run_row.reconciliation_chain_sha256 IS DISTINCT FROM expected_chain
     OR run_row.source_fingerprint IS NULL OR run_row.source_fingerprint !~ '^[0-9a-f]{64}$'
     OR run_row.reconciliation_sha256 IS NULL OR run_row.reconciliation_sha256 !~ '^[0-9a-f]{64}$'
     OR run_row.destination_fingerprint IS NULL OR run_row.destination_fingerprint !~ '^[0-9a-f]{64}$'
     OR run_row.unresolved_exceptions IS NULL
     OR jsonb_typeof(run_row.unresolved_exceptions) <> 'array'
     OR run_row.unresolved_exceptions <> '[]'::jsonb
     OR expected_chain !~ '^[0-9a-f]{64}$'
     OR drain_receipt !~ '^[0-9a-f]{64}$'
     OR actor_uid IS NULL OR actor_uid = '' THEN
    RAISE EXCEPTION 'migration_seal_run_conflict' USING ERRCODE = '40001';
  END IF;
  -- Migration-native BIGINT counters are varchar to preserve exact JS strings.
  -- Compare only after bounded lexical/range validation and stringify the typed
  -- bigint argument; never cast arbitrary stored text to bigint/numeric.
  IF NOT head_found OR head_coverage <> 1 OR head_barrier <> 'open'
     OR head_sequence <> expected_seq OR head_chain <> expected_chain THEN
    RAISE EXCEPTION 'migration_seal_head_conflict' USING ERRCODE = '40001';
  END IF;

  -- The immediate seal CHECK requires every seal field in this first UPDATE.
  -- Its AFTER trigger logs this mutation while the barrier is still open.
  UPDATE public.news_migration_runs SET
    admission_state = 'sealed', activation_epoch = epoch + 1,
    drain_receipt_sha256 = drain_receipt, sealed_sequence = expected_seq::text,
    sealed_chain_sha256 = expected_chain, sealed_at = pg_catalog.clock_timestamp()
    WHERE news_migration_runs.id = run;

  SELECT sequence, chain_sha256 INTO final_sequence, final_chain
    FROM public.owner_news_mutation_head WHERE singleton = TRUE FOR UPDATE;
  -- This second write changes only explicitly exempt bookkeeping columns. The
  -- event trigger checks session_user=cms_controller and its exact changed set.
  UPDATE public.news_migration_runs SET
    sealed_sequence = final_sequence::text, sealed_chain_sha256 = final_chain
    WHERE news_migration_runs.id = run;

  UPDATE public.owner_news_mutation_head SET write_barrier = 'sealed',
    barrier_run_id = run, barrier_epoch = epoch, barrier_receipt_sha256 = drain_receipt
    WHERE singleton = TRUE;
  RETURN QUERY SELECT run;
END;
$owner_news$;

REVOKE ALL ON FUNCTION public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text) FROM cms_runtime;
GRANT EXECUTE ON FUNCTION public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text) TO cms_controller;
ALTER FUNCTION public.owner_news_seal_run(uuid,text,integer,bigint,text,text,text) OWNER TO cms_control;
`
}

/** Immutable view of the required relation inventory for migration tests. */
export const NEWS_MUTATION_TRIGGER_TABLES: readonly string[] = NEWS_MUTATION_TABLES
