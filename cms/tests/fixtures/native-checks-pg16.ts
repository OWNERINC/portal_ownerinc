// Captured from pg_get_constraintdef after executing all six real migration up()
// functions through Drizzle PgDialect in PGlite 0.2.17 (PostgreSQL 16.4/WASM).
// No live catalog is an expected source: these are observed regression inputs.
// Metadata CHECK bytes also match the PG16.14 Linux run 37889449231 SHA-256.
export const nativeChecksPg16: Readonly<Record<string, string>> = {
  legacy_news_revisions_metadata_basis_check: `CHECK (((metadata_basis IS NULL) OR (metadata_basis =
CASE
    WHEN (original_published_at IS NULL) THEN '{"title": "document_snapshot", "category": "document_snapshot", "publishedAt": "unknown"}'::jsonb
    ELSE '{"title": "document_snapshot", "category": "document_snapshot", "publishedAt": "published_pointer"}'::jsonb
END)))`,
  news_migration_items_destination_id_check: 'CHECK (((destination_id IS NULL) OR ((length((destination_id)::text) >= 1) AND (length((destination_id)::text) <= 128))))',
  news_migration_items_expected_hash_check: "CHECK (((expected_hash)::text ~ '^[0-9a-f]{64}$'::text))",
  news_migration_items_manifest_sha256_check: "CHECK (((manifest_sha256)::text ~ '^[0-9a-f]{64}$'::text))",
  news_migration_items_observed_hash_check: "CHECK (((observed_hash IS NULL) OR ((observed_hash)::text ~ '^[0-9a-f]{64}$'::text)))",
  news_migration_items_run_uuid_check: "CHECK (((run_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))",
  news_migration_items_source_identity_check: `CHECK ((((length((source_id)::text) >= 1) AND (length((source_id)::text) <= 128)) AND
CASE entity_kind
    WHEN 'asset'::enum_news_migration_items_entity_kind THEN ((source_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)
    WHEN 'document'::enum_news_migration_items_entity_kind THEN ((source_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text)
    WHEN 'history'::enum_news_migration_items_entity_kind THEN ((source_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$'::text)
    WHEN 'home'::enum_news_migration_items_entity_kind THEN ((source_id)::text = 'news-home'::text)
    WHEN 'schedule'::enum_news_migration_items_entity_kind THEN ((source_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(.[0-9]{1,6})?Z$'::text)
    ELSE false
END))`,
  news_migration_items_verified_consistency_check: "CHECK (((state <> 'verified'::enum_news_migration_items_state) OR ((observed_hash IS NOT NULL) AND ((observed_hash)::text = (expected_hash)::text) AND (commit_outcome = 'acknowledged'::enum_news_migration_items_commit_outcome))))",
  news_migration_runs_epoch_integer_check: 'CHECK (((authority_epoch >= (1)::numeric) AND (authority_epoch < (2147483647)::numeric) AND (trunc(authority_epoch) = authority_epoch)))',
  news_migration_runs_exceptions_array_check: "CHECK (((unresolved_exceptions IS NOT NULL) AND (jsonb_typeof(unresolved_exceptions) = 'array'::text)))",
  news_migration_runs_manifest_sha256_check: "CHECK (((manifest_sha256)::text ~ '^[0-9a-f]{64}$'::text))",
  news_migration_runs_reconciliation_hashes_check: "CHECK ((((reconciliation_chain_sha256 IS NULL) OR ((reconciliation_chain_sha256)::text ~ '^[0-9a-f]{64}$'::text)) AND ((reconciliation_sha256 IS NULL) OR ((reconciliation_sha256)::text ~ '^[0-9a-f]{64}$'::text)) AND ((destination_fingerprint IS NULL) OR ((destination_fingerprint)::text ~ '^[0-9a-f]{64}$'::text))))",
  news_migration_runs_reconciliation_pair_check: 'CHECK (((reconciliation_sequence IS NULL) = (reconciliation_chain_sha256 IS NULL)))',
  news_migration_runs_reconciliation_sequence_check: `CHECK (((reconciliation_sequence IS NULL) OR
CASE
    WHEN ((reconciliation_sequence)::text ~ '^(0|[1-9][0-9]*)$'::text) THEN
    CASE
        WHEN (length((reconciliation_sequence)::text) <= 19) THEN ((reconciliation_sequence)::numeric <= ('9223372036854775807'::bigint)::numeric)
        ELSE false
    END
    ELSE false
END))`,
  news_migration_runs_seal_hashes_check: "CHECK ((((sealed_chain_sha256 IS NULL) OR ((sealed_chain_sha256)::text ~ '^[0-9a-f]{64}$'::text)) AND ((drain_receipt_sha256 IS NULL) OR ((drain_receipt_sha256)::text ~ '^[0-9a-f]{64}$'::text))))",
  news_migration_runs_seal_pair_check: "CHECK ((((sealed_sequence IS NULL) = (sealed_chain_sha256 IS NULL)) AND ((sealed_sequence IS NULL) = (sealed_at IS NULL)) AND ((admission_state <> 'open'::enum_news_migration_runs_admission_state) OR ((activation_epoch IS NULL) AND (drain_receipt_sha256 IS NULL) AND (sealed_sequence IS NULL) AND (sealed_chain_sha256 IS NULL) AND (sealed_at IS NULL)))))",
  news_migration_runs_sealed_sequence_check: `CHECK (((sealed_sequence IS NULL) OR
CASE
    WHEN ((sealed_sequence)::text ~ '^(0|[1-9][0-9]*)$'::text) THEN
    CASE
        WHEN (length((sealed_sequence)::text) <= 19) THEN ((sealed_sequence)::numeric <= ('9223372036854775807'::bigint)::numeric)
        ELSE false
    END
    ELSE false
END))`,
  news_migration_runs_source_fingerprint_check: "CHECK (((source_fingerprint)::text ~ '^[0-9a-f]{64}$'::text))",
  news_migration_runs_source_instance_check: 'CHECK (((length((source_instance)::text) >= 1) AND (length((source_instance)::text) <= 128)))',
  news_migration_seal_complete: `CHECK (((admission_state <> 'sealed'::enum_news_migration_runs_admission_state) OR ((progress_state = 'reconciled'::enum_news_migration_runs_progress_state) AND (commit_outcome = 'acknowledged'::enum_news_migration_runs_commit_outcome) AND (reconciliation_sequence IS NOT NULL) AND (reconciliation_chain_sha256 IS NOT NULL) AND (reconciliation_sha256 IS NOT NULL) AND (destination_fingerprint IS NOT NULL) AND (sealed_sequence IS NOT NULL) AND (sealed_chain_sha256 IS NOT NULL) AND (sealed_at IS NOT NULL) AND (activation_epoch IS NOT NULL) AND
CASE
    WHEN (((reconciliation_sequence)::text ~ '^(0|[1-9][0-9]*)$'::text) AND ((sealed_sequence)::text ~ '^(0|[1-9][0-9]*)$'::text) AND (length((reconciliation_sequence)::text) <= 19) AND (length((sealed_sequence)::text) <= 19)) THEN ((sealed_sequence)::numeric >= (reconciliation_sequence)::numeric)
    ELSE false
END AND (activation_epoch = (authority_epoch + (1)::numeric)) AND (drain_receipt_sha256 IS NOT NULL))))`,
  news_schedules_actor_uid_check: 'CHECK (((actor_uid IS NULL) OR ((length((actor_uid)::text) >= 1) AND (length((actor_uid)::text) <= 128))))',
  news_schedules_import_epoch_check: 'CHECK (((import_authority_epoch IS NULL) OR ((import_authority_epoch >= (1)::numeric) AND (import_authority_epoch < (2147483647)::numeric) AND (trunc(import_authority_epoch) = import_authority_epoch))))',
  news_schedules_import_provenance_shape_check: `CHECK (
CASE
    WHEN (state = 'suspended'::enum_news_schedules_state) THEN ((actor_uid IS NULL) AND (version_id IS NOT NULL) AND (source_schedule_key IS NOT NULL) AND (source_revision_id IS NOT NULL) AND (import_run_id IS NOT NULL) AND (import_manifest_sha256 IS NOT NULL) AND (import_authority_epoch IS NOT NULL) AND (original_scheduled_at IS NOT NULL) AND (NOT (original_actor_evidence IS DISTINCT FROM 'not_recorded'::enum_news_schedules_original_actor_evidence)) AND (source_snapshot IS NOT NULL) AND (jsonb_typeof(source_snapshot) = 'object'::text) AND (source_snapshot_hash IS NOT NULL) AND (native_snapshot_hash IS NOT NULL) AND ((source_revision_id)::text = (version_id)::text) AND ((import_run_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((source_revision_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((document_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((import_manifest_sha256)::text ~ '^[0-9a-f]{64}$'::text) AND ((source_snapshot_hash)::text ~ '^[0-9a-f]{64}$'::text) AND ((native_snapshot_hash)::text ~ '^[0-9a-f]{64}$'::text) AND ((snapshot_hash)::text = (native_snapshot_hash)::text) AND ((original_scheduled_at)::text ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(.[0-9]{1,6})?Z$'::text) AND ((source_schedule_key)::text = (((((document_id)::text || '/'::text) || (source_revision_id)::text) || '/'::text) || (original_scheduled_at)::text)) AND (length((source_schedule_key)::text) <= 128))
    ELSE ((actor_uid IS NOT NULL) AND (version_id IS NOT NULL) AND (source_schedule_key IS NULL) AND (source_revision_id IS NULL) AND (import_run_id IS NULL) AND (import_manifest_sha256 IS NULL) AND (import_authority_epoch IS NULL) AND (original_scheduled_at IS NULL) AND (original_actor_evidence IS NULL) AND (source_snapshot IS NULL) AND (source_snapshot_hash IS NULL) AND (native_snapshot_hash IS NULL))
END)`,
  news_schedules_snapshot_hash_check: "CHECK (((snapshot_hash)::text ~ '^[0-9a-f]{64}$'::text))",
}
