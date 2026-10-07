import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_news_schedules_original_actor_evidence" AS ENUM('not_recorded');
  CREATE TYPE "public"."enum_news_migration_runs_progress_state" AS ENUM('preparing', 'reconciled', 'conflict');
  CREATE TYPE "public"."enum_news_migration_runs_admission_state" AS ENUM('open', 'sealed');
  CREATE TYPE "public"."enum_news_migration_runs_commit_outcome" AS ENUM('acknowledged', 'unknown');
  CREATE TYPE "public"."enum_news_migration_items_entity_kind" AS ENUM('asset', 'history', 'document', 'home', 'schedule');
  CREATE TYPE "public"."enum_news_migration_items_state" AS ENUM('planned', 'applied', 'verified', 'conflict');
  CREATE TYPE "public"."enum_news_migration_items_commit_outcome" AS ENUM('acknowledged', 'unknown');
  CREATE TABLE "news_migration_runs" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"manifest_sha256" varchar NOT NULL,
  	"source_instance" varchar NOT NULL,
  	"source_fingerprint" varchar NOT NULL,
  	"authority_epoch" numeric NOT NULL,
  	"progress_state" "enum_news_migration_runs_progress_state" DEFAULT 'preparing' NOT NULL,
  	"admission_state" "enum_news_migration_runs_admission_state" DEFAULT 'open' NOT NULL,
  	"commit_outcome" "enum_news_migration_runs_commit_outcome" DEFAULT 'acknowledged' NOT NULL,
  	"reconciliation_sequence" varchar,
  	"reconciliation_chain_sha256" varchar,
  	"reconciliation_sha256" varchar,
  	"destination_fingerprint" varchar,
  	"unresolved_exceptions" jsonb DEFAULT '[]'::jsonb,
  	"sealed_sequence" varchar,
  	"sealed_chain_sha256" varchar,
  	"sealed_at" timestamp(3) with time zone,
  	"activation_epoch" numeric,
  	"drain_receipt_sha256" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "news_migration_items" (
  	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  	"run_id" varchar NOT NULL,
  	"manifest_sha256" varchar NOT NULL,
  	"entity_kind" "enum_news_migration_items_entity_kind" NOT NULL,
  	"source_id" varchar NOT NULL,
  	"expected_hash" varchar NOT NULL,
  	"destination_id" varchar,
  	"observed_hash" varchar,
  	"state" "enum_news_migration_items_state" DEFAULT 'planned' NOT NULL,
  	"commit_outcome" "enum_news_migration_items_commit_outcome" DEFAULT 'acknowledged' NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "news_schedules" ALTER COLUMN "version_id" DROP NOT NULL;
  ALTER TABLE "news_schedules" ALTER COLUMN "actor_uid" DROP NOT NULL;
  ALTER TABLE "news_schedules" ADD COLUMN "source_schedule_key" varchar;
  ALTER TABLE "news_schedules" ADD COLUMN "source_revision_id" varchar;
  ALTER TABLE "news_schedules" ADD COLUMN "import_run_id" varchar;
  ALTER TABLE "news_schedules" ADD COLUMN "import_manifest_sha256" varchar;
  ALTER TABLE "news_schedules" ADD COLUMN "import_authority_epoch" numeric;
  ALTER TABLE "news_schedules" ADD COLUMN "original_scheduled_at" varchar;
  ALTER TABLE "news_schedules" ADD COLUMN "original_actor_evidence" "enum_news_schedules_original_actor_evidence";
  ALTER TABLE "news_schedules" ADD COLUMN "source_snapshot" jsonb;
  ALTER TABLE "news_schedules" ADD COLUMN "source_snapshot_hash" varchar;
  ALTER TABLE "news_schedules" ADD COLUMN "native_snapshot_hash" varchar;
  ALTER TABLE "legacy_news_revisions" ADD COLUMN "metadata_basis" jsonb;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "news_migration_runs_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "news_migration_items_id" uuid;
  CREATE UNIQUE INDEX "news_migration_runs_manifest_sha256_idx" ON "news_migration_runs" USING btree ("manifest_sha256");
  CREATE INDEX "news_migration_runs_updated_at_idx" ON "news_migration_runs" USING btree ("updated_at");
  CREATE INDEX "news_migration_runs_created_at_idx" ON "news_migration_runs" USING btree ("created_at");
  CREATE INDEX "news_migration_items_run_id_idx" ON "news_migration_items" USING btree ("run_id");
  CREATE INDEX "news_migration_items_manifest_sha256_idx" ON "news_migration_items" USING btree ("manifest_sha256");
  CREATE INDEX "news_migration_items_updated_at_idx" ON "news_migration_items" USING btree ("updated_at");
  CREATE INDEX "news_migration_items_created_at_idx" ON "news_migration_items" USING btree ("created_at");
  CREATE UNIQUE INDEX "manifestSha256_entityKind_sourceId_idx" ON "news_migration_items" USING btree ("manifest_sha256","entity_kind","source_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_news_migration_runs_fk" FOREIGN KEY ("news_migration_runs_id") REFERENCES "public"."news_migration_runs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_news_migration_items_fk" FOREIGN KEY ("news_migration_items_id") REFERENCES "public"."news_migration_items"("id") ON DELETE cascade ON UPDATE no action;
  CREATE UNIQUE INDEX "news_schedules_source_schedule_key_idx" ON "news_schedules" USING btree ("source_schedule_key");
  CREATE INDEX "news_schedules_import_run_id_idx" ON "news_schedules" USING btree ("import_run_id");
  CREATE INDEX "payload_locked_documents_rels_news_migration_runs_id_idx" ON "payload_locked_documents_rels" USING btree ("news_migration_runs_id");
   CREATE INDEX "payload_locked_documents_rels_news_migration_items_id_idx" ON "payload_locked_documents_rels" USING btree ("news_migration_items_id");`)

  // Native Payload schema deliberately keeps BIGINT counters as text/varchar
  // so they round-trip through JavaScript as exact decimal strings. Keep this
  // SQL beside the generated snapshot; do not model these as Payload numbers.
  await db.execute(sql`
    ALTER TABLE public.news_migration_runs
      ADD CONSTRAINT news_migration_runs_manifest_sha256_check
        CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
      ADD CONSTRAINT news_migration_runs_source_fingerprint_check
        CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
      ADD CONSTRAINT news_migration_runs_source_instance_check
        CHECK (length(source_instance) BETWEEN 1 AND 128),
      ADD CONSTRAINT news_migration_runs_epoch_integer_check
        CHECK (authority_epoch >= 1 AND authority_epoch < 2147483647 AND trunc(authority_epoch) = authority_epoch),
      ADD CONSTRAINT news_migration_runs_reconciliation_sequence_check
        CHECK (reconciliation_sequence IS NULL OR CASE
          WHEN reconciliation_sequence ~ '^(0|[1-9][0-9]*)$' THEN CASE
            WHEN length(reconciliation_sequence) <= 19
              THEN reconciliation_sequence::numeric <= 9223372036854775807::numeric
            ELSE false END
          ELSE false END),
      ADD CONSTRAINT news_migration_runs_sealed_sequence_check
        CHECK (sealed_sequence IS NULL OR CASE
          WHEN sealed_sequence ~ '^(0|[1-9][0-9]*)$' THEN CASE
            WHEN length(sealed_sequence) <= 19
              THEN sealed_sequence::numeric <= 9223372036854775807::numeric
            ELSE false END
          ELSE false END),
      ADD CONSTRAINT news_migration_runs_reconciliation_pair_check
        CHECK ((reconciliation_sequence IS NULL) = (reconciliation_chain_sha256 IS NULL)),
      ADD CONSTRAINT news_migration_runs_reconciliation_hashes_check
        CHECK ((reconciliation_chain_sha256 IS NULL OR reconciliation_chain_sha256 ~ '^[0-9a-f]{64}$')
          AND (reconciliation_sha256 IS NULL OR reconciliation_sha256 ~ '^[0-9a-f]{64}$')
          AND (destination_fingerprint IS NULL OR destination_fingerprint ~ '^[0-9a-f]{64}$')),
      ADD CONSTRAINT news_migration_runs_exceptions_array_check
        CHECK (unresolved_exceptions IS NOT NULL AND jsonb_typeof(unresolved_exceptions) = 'array'),
      ADD CONSTRAINT news_migration_runs_seal_pair_check
        CHECK ((sealed_sequence IS NULL) = (sealed_chain_sha256 IS NULL)
          AND (sealed_sequence IS NULL) = (sealed_at IS NULL)
          AND (admission_state <> 'open' OR (activation_epoch IS NULL AND drain_receipt_sha256 IS NULL
            AND sealed_sequence IS NULL AND sealed_chain_sha256 IS NULL AND sealed_at IS NULL))),
      ADD CONSTRAINT news_migration_runs_seal_hashes_check
        CHECK ((sealed_chain_sha256 IS NULL OR sealed_chain_sha256 ~ '^[0-9a-f]{64}$')
          AND (drain_receipt_sha256 IS NULL OR drain_receipt_sha256 ~ '^[0-9a-f]{64}$')),
      ADD CONSTRAINT news_migration_seal_complete CHECK (
        admission_state <> 'sealed' OR (
          progress_state = 'reconciled' AND commit_outcome = 'acknowledged'
          AND reconciliation_sequence IS NOT NULL AND reconciliation_chain_sha256 IS NOT NULL
          AND reconciliation_sha256 IS NOT NULL AND destination_fingerprint IS NOT NULL
          AND sealed_sequence IS NOT NULL AND sealed_chain_sha256 IS NOT NULL AND sealed_at IS NOT NULL
          AND activation_epoch IS NOT NULL
          AND CASE WHEN reconciliation_sequence ~ '^(0|[1-9][0-9]*)$'
            AND sealed_sequence ~ '^(0|[1-9][0-9]*)$'
            AND length(reconciliation_sequence) <= 19 AND length(sealed_sequence) <= 19
            THEN sealed_sequence::numeric >= reconciliation_sequence::numeric ELSE false END
          AND activation_epoch = authority_epoch + 1 AND drain_receipt_sha256 IS NOT NULL
        ));

    ALTER TABLE public.news_migration_items
      ADD CONSTRAINT news_migration_items_run_uuid_check
        CHECK (run_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
      ADD CONSTRAINT news_migration_items_manifest_sha256_check
        CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
      ADD CONSTRAINT news_migration_items_expected_hash_check
        CHECK (expected_hash ~ '^[0-9a-f]{64}$'),
      ADD CONSTRAINT news_migration_items_observed_hash_check
        CHECK (observed_hash IS NULL OR observed_hash ~ '^[0-9a-f]{64}$'),
      ADD CONSTRAINT news_migration_items_source_identity_check
        CHECK (length(source_id) BETWEEN 1 AND 128 AND CASE entity_kind
          WHEN 'asset' THEN source_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          WHEN 'document' THEN source_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          WHEN 'history' THEN source_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{12}$'
          WHEN 'home' THEN source_id = 'news-home'
          WHEN 'schedule' THEN source_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
          ELSE false END),
      ADD CONSTRAINT news_migration_items_destination_id_check
        CHECK (destination_id IS NULL OR length(destination_id) BETWEEN 1 AND 128),
      ADD CONSTRAINT news_migration_items_verified_consistency_check
        CHECK (state <> 'verified' OR (observed_hash IS NOT NULL
          AND observed_hash = expected_hash AND commit_outcome = 'acknowledged'));

    ALTER TABLE public.news_schedules
      ADD CONSTRAINT news_schedules_actor_uid_check
        CHECK (actor_uid IS NULL OR length(actor_uid) BETWEEN 1 AND 128),
      ADD CONSTRAINT news_schedules_import_epoch_check
        CHECK (import_authority_epoch IS NULL OR (import_authority_epoch >= 1
          AND import_authority_epoch < 2147483647 AND trunc(import_authority_epoch) = import_authority_epoch)),
      ADD CONSTRAINT news_schedules_snapshot_hash_check
        CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
      ADD CONSTRAINT news_schedules_import_provenance_shape_check
        CHECK (CASE WHEN state = 'suspended' THEN
          actor_uid IS NULL AND version_id IS NOT NULL AND source_schedule_key IS NOT NULL
          AND source_revision_id IS NOT NULL AND import_run_id IS NOT NULL
          AND import_manifest_sha256 IS NOT NULL AND import_authority_epoch IS NOT NULL
          AND original_scheduled_at IS NOT NULL AND original_actor_evidence IS NOT DISTINCT FROM 'not_recorded'
          AND source_snapshot IS NOT NULL AND jsonb_typeof(source_snapshot) = 'object'
          AND source_snapshot_hash IS NOT NULL AND native_snapshot_hash IS NOT NULL
          AND source_revision_id = version_id
          AND import_run_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND source_revision_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND document_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          AND import_manifest_sha256 ~ '^[0-9a-f]{64}$'
          AND source_snapshot_hash ~ '^[0-9a-f]{64}$'
          AND native_snapshot_hash ~ '^[0-9a-f]{64}$'
          AND snapshot_hash = native_snapshot_hash
          AND original_scheduled_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
          AND source_schedule_key = document_id || '/' || source_revision_id || '/' || original_scheduled_at
          AND length(source_schedule_key) <= 128
        ELSE actor_uid IS NOT NULL AND version_id IS NOT NULL
          AND source_schedule_key IS NULL AND source_revision_id IS NULL AND import_run_id IS NULL
          AND import_manifest_sha256 IS NULL AND import_authority_epoch IS NULL
          AND original_scheduled_at IS NULL AND original_actor_evidence IS NULL
          AND source_snapshot IS NULL AND source_snapshot_hash IS NULL AND native_snapshot_hash IS NULL
        END);

    ALTER TABLE public.legacy_news_revisions
      ADD CONSTRAINT legacy_news_revisions_metadata_basis_check
        CHECK (metadata_basis IS NULL OR metadata_basis = CASE
          WHEN original_published_at IS NULL
            THEN '{"title":"document_snapshot","category":"document_snapshot","publishedAt":"unknown"}'::jsonb
          ELSE '{"title":"document_snapshot","category":"document_snapshot","publishedAt":"published_pointer"}'::jsonb
        END);
  `)
}

export async function down(_args: MigrateDownArgs): Promise<void> {
  throw new Error('unsupported_downgrade:owner_news_migration_data_and_schema_floor')
}
