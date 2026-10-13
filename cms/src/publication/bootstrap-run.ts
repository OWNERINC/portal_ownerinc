/** The narrow column set required by the SECURITY DEFINER bootstrap function.
 * Keep this aligned with its explicit INSERT column list. cms_control gets no
 * table-level INSERT and cms_controller gets no table INSERT at all. */
export const NEWS_MIGRATION_RUN_BOOTSTRAP_INSERT_COLUMNS = Object.freeze([
  'id',
  'manifest_sha256',
  'source_instance',
  'source_fingerprint',
  'authority_epoch',
  'progress_state',
  'admission_state',
  'commit_outcome',
  'unresolved_exceptions',
] as const)

export const NEWS_MIGRATION_BOOTSTRAP_RUN_SIGNATURE =
  'public.owner_news_bootstrap_run(uuid,text,text,text,integer)' as const

/** Canonical SQL for the controller-only run bootstrap RPC. This is database
 * protocol DDL, not a Payload/runtime helper. Keep all object references
 * qualified: SECURITY DEFINER execution uses a fixed search_path and no
 * dynamic SQL. */
export function buildNewsMigrationBootstrapRunDDL(): string {
  return `
CREATE OR REPLACE FUNCTION public.owner_news_bootstrap_run(
  p_run_id uuid,
  p_manifest_sha256 text,
  p_source_instance text,
  p_source_fingerprint text,
  p_authority_epoch integer
) RETURNS TABLE(id uuid)
LANGUAGE plpgsql
CALLED ON NULL INPUT
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $owner_news_bootstrap$
DECLARE
  head_sequence bigint;
  head_chain_sha256 text;
  head_coverage_version integer;
  head_write_barrier text;
  head_barrier_run_id uuid;
  head_barrier_epoch integer;
  head_barrier_receipt_sha256 text;
  run_by_id public.news_migration_runs%ROWTYPE;
  run_by_manifest public.news_migration_runs%ROWTYPE;
  run_id_found boolean;
  manifest_found boolean;
BEGIN
  -- current_user is cms_control inside SECURITY DEFINER. session_user is the
  -- authenticated connection principal and intentionally cannot be replaced
  -- by SET ROLE or by invoking the function as its owner.
  IF session_user IS DISTINCT FROM 'cms_controller' THEN
    RAISE EXCEPTION 'owner_news_bootstrap_controller_required' USING ERRCODE = '42501';
  END IF;

  IF p_run_id IS NULL
     OR p_manifest_sha256 IS NULL OR p_manifest_sha256 !~ '^[0-9a-f]{64}$'
     OR p_source_instance IS NULL OR length(p_source_instance) NOT BETWEEN 1 AND 128
     OR p_source_fingerprint IS NULL OR p_source_fingerprint !~ '^[0-9a-f]{64}$'
     OR p_authority_epoch IS NULL OR p_authority_epoch < 1 OR p_authority_epoch >= 2147483647 THEN
    RAISE EXCEPTION 'owner_news_bootstrap_invalid_identity' USING ERRCODE = '22023';
  END IF;

  -- This is the common serialization point for protocol/content writes. It
  -- must precede every row lock in this function.
  PERFORM pg_catalog.pg_advisory_xact_lock(7194030);

  BEGIN
    SELECT head.sequence, head.chain_sha256, head.coverage_version, head.write_barrier,
        head.barrier_run_id, head.barrier_epoch, head.barrier_receipt_sha256
      INTO STRICT head_sequence, head_chain_sha256, head_coverage_version, head_write_barrier,
        head_barrier_run_id, head_barrier_epoch, head_barrier_receipt_sha256
      FROM public.owner_news_mutation_head AS head
      WHERE head.singleton IS TRUE
      FOR UPDATE;
  EXCEPTION
    WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
      RAISE EXCEPTION 'owner_news_bootstrap_head_unavailable' USING ERRCODE = '55000';
  END;

  IF head_sequence IS NULL OR head_sequence < 0
     OR head_chain_sha256 IS NULL OR head_chain_sha256 !~ '^[0-9a-f]{64}$'
     OR head_coverage_version IS NULL OR head_coverage_version NOT IN (0, 1) THEN
    RAISE EXCEPTION 'owner_news_bootstrap_head_invalid' USING ERRCODE = '55000';
  END IF;
  IF head_write_barrier IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'owner_news_bootstrap_barrier_closed' USING ERRCODE = '55000';
  END IF;
  IF head_barrier_run_id IS NOT NULL OR head_barrier_epoch IS NOT NULL
     OR head_barrier_receipt_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'owner_news_bootstrap_head_invalid' USING ERRCODE = '55000';
  END IF;

  SELECT runs.* INTO run_by_id
    FROM public.news_migration_runs AS runs
    WHERE runs.id = p_run_id
    FOR UPDATE;
  run_id_found := FOUND;

  SELECT runs.* INTO run_by_manifest
    FROM public.news_migration_runs AS runs
    WHERE runs.manifest_sha256 = p_manifest_sha256
    FOR UPDATE;
  manifest_found := FOUND;

  IF run_id_found THEN
    IF NOT manifest_found
       OR run_by_id.id IS DISTINCT FROM run_by_manifest.id
       OR run_by_id.id IS DISTINCT FROM p_run_id
       OR run_by_id.manifest_sha256 IS DISTINCT FROM p_manifest_sha256
       OR run_by_id.source_instance IS DISTINCT FROM p_source_instance
       OR run_by_id.source_fingerprint IS DISTINCT FROM p_source_fingerprint
       OR run_by_id.authority_epoch IS DISTINCT FROM p_authority_epoch::numeric THEN
      RAISE EXCEPTION 'owner_news_bootstrap_identity_conflict' USING ERRCODE = '40001';
    END IF;

    -- Idempotent success performs no INSERT/UPDATE and does not touch either
    -- timestamp. Mutable progress may have advanced since the original call.
    RETURN QUERY SELECT run_by_id.id AS id;
    RETURN;
  END IF;

  IF manifest_found THEN
    RAISE EXCEPTION 'owner_news_bootstrap_identity_conflict' USING ERRCODE = '40001';
  END IF;

  RETURN QUERY
    INSERT INTO public.news_migration_runs AS inserted (
      id,
      manifest_sha256,
      source_instance,
      source_fingerprint,
      authority_epoch,
      progress_state,
      admission_state,
      commit_outcome,
      unresolved_exceptions
    ) VALUES (
      p_run_id,
      p_manifest_sha256,
      p_source_instance,
      p_source_fingerprint,
      p_authority_epoch,
      'preparing',
      'open',
      'acknowledged',
      '[]'::jsonb
    )
    RETURNING inserted.id AS id;
END;
$owner_news_bootstrap$;

REVOKE ALL ON FUNCTION public.owner_news_bootstrap_run(uuid,text,text,text,integer) FROM PUBLIC, cms_runtime;
GRANT EXECUTE ON FUNCTION public.owner_news_bootstrap_run(uuid,text,text,text,integer) TO cms_controller;
ALTER FUNCTION public.owner_news_bootstrap_run(uuid,text,text,text,integer) OWNER TO cms_control;
GRANT INSERT (${NEWS_MIGRATION_RUN_BOOTSTRAP_INSERT_COLUMNS.join(', ')})
  ON TABLE public.news_migration_runs TO cms_control;
`
}
