import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_news_schedules_target" AS ENUM('news-articles', 'news-home');
  CREATE TYPE "public"."enum_news_schedules_action" AS ENUM('publish', 'unpublish');
  CREATE TYPE "public"."enum_news_schedules_state" AS ENUM('pending', 'published', 'unpublished', 'cancelled', 'rejected');
  CREATE TYPE "public"."enum_news_audit_action" AS ENUM('draft_saved', 'published', 'unpublished', 'scheduled', 'schedule_cancelled', 'schedule_rejected');
  CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline', 'publish-news-snapshot');
  CREATE TYPE "public"."enum_payload_jobs_log_state" AS ENUM('failed', 'succeeded');
  CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline', 'publish-news-snapshot');
  CREATE TABLE "news_schedules" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "target" "enum_news_schedules_target" NOT NULL,
    "document_id" varchar NOT NULL,
    "action" "enum_news_schedules_action" NOT NULL,
    "version_id" varchar NOT NULL,
    "snapshot" jsonb NOT NULL,
    "snapshot_hash" varchar NOT NULL,
    "scheduled_at" timestamp(3) with time zone NOT NULL,
    "actor_uid" varchar NOT NULL,
    "generation" numeric NOT NULL,
    "state" "enum_news_schedules_state" DEFAULT 'pending' NOT NULL,
    "job_id" varchar,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "news_audit" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "action" "enum_news_audit_action" NOT NULL,
    "document_id" varchar NOT NULL,
    "version_id" varchar,
    "actor_uid" varchar NOT NULL,
    "requested_by_uid" varchar NOT NULL,
    "details" jsonb NOT NULL,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "payload_jobs_log" (
    "_order" integer NOT NULL,
    "_parent_id" uuid NOT NULL,
    "id" varchar PRIMARY KEY NOT NULL,
    "executed_at" timestamp(3) with time zone NOT NULL,
    "completed_at" timestamp(3) with time zone NOT NULL,
    "task_slug" "enum_payload_jobs_log_task_slug" NOT NULL,
    "task_i_d" varchar NOT NULL,
    "input" jsonb,
    "output" jsonb,
    "state" "enum_payload_jobs_log_state" NOT NULL,
    "error" jsonb
  );

  CREATE TABLE "payload_jobs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "input" jsonb,
    "completed_at" timestamp(3) with time zone,
    "total_tried" numeric DEFAULT 0,
    "has_error" boolean DEFAULT false,
    "error" jsonb,
    "task_slug" "enum_payload_jobs_task_slug",
    "queue" varchar DEFAULT 'default',
    "wait_until" timestamp(3) with time zone,
    "processing" boolean DEFAULT false,
    "concurrency_key" varchar,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "news_schedules_id" uuid;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "news_audit_id" uuid;
  ALTER TABLE "payload_jobs_log" ADD CONSTRAINT "payload_jobs_log_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."payload_jobs"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "news_schedules_document_id_idx" ON "news_schedules" USING btree ("document_id");
  CREATE INDEX "news_schedules_scheduled_at_idx" ON "news_schedules" USING btree ("scheduled_at");
  CREATE UNIQUE INDEX "news_schedules_job_id_idx" ON "news_schedules" USING btree ("job_id");
  CREATE INDEX "news_schedules_updated_at_idx" ON "news_schedules" USING btree ("updated_at");
  CREATE INDEX "news_schedules_created_at_idx" ON "news_schedules" USING btree ("created_at");
  CREATE INDEX "news_audit_document_id_idx" ON "news_audit" USING btree ("document_id");
  CREATE INDEX "news_audit_updated_at_idx" ON "news_audit" USING btree ("updated_at");
  CREATE INDEX "news_audit_created_at_idx" ON "news_audit" USING btree ("created_at");
  CREATE INDEX "payload_jobs_log_order_idx" ON "payload_jobs_log" USING btree ("_order");
  CREATE INDEX "payload_jobs_log_parent_id_idx" ON "payload_jobs_log" USING btree ("_parent_id");
  CREATE INDEX "payload_jobs_completed_at_idx" ON "payload_jobs" USING btree ("completed_at");
  CREATE INDEX "payload_jobs_total_tried_idx" ON "payload_jobs" USING btree ("total_tried");
  CREATE INDEX "payload_jobs_has_error_idx" ON "payload_jobs" USING btree ("has_error");
  CREATE INDEX "payload_jobs_task_slug_idx" ON "payload_jobs" USING btree ("task_slug");
  CREATE INDEX "payload_jobs_queue_idx" ON "payload_jobs" USING btree ("queue");
  CREATE INDEX "payload_jobs_wait_until_idx" ON "payload_jobs" USING btree ("wait_until");
  CREATE INDEX "payload_jobs_processing_idx" ON "payload_jobs" USING btree ("processing");
  CREATE UNIQUE INDEX "payload_jobs_concurrency_key_idx" ON "payload_jobs" USING btree ("concurrency_key");
  CREATE INDEX "payload_jobs_updated_at_idx" ON "payload_jobs" USING btree ("updated_at");
  CREATE INDEX "payload_jobs_created_at_idx" ON "payload_jobs" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_news_schedules_fk" FOREIGN KEY ("news_schedules_id") REFERENCES "public"."news_schedules"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_news_audit_fk" FOREIGN KEY ("news_audit_id") REFERENCES "public"."news_audit"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_news_schedules_id_idx" ON "payload_locked_documents_rels" USING btree ("news_schedules_id");
  CREATE INDEX "payload_locked_documents_rels_news_audit_id_idx" ON "payload_locked_documents_rels" USING btree ("news_audit_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "news_schedules" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "news_audit" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload_jobs_log" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload_jobs" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "news_schedules" CASCADE;
  DROP TABLE "news_audit" CASCADE;
  DROP TABLE "payload_jobs_log" CASCADE;
  DROP TABLE "payload_jobs" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_news_schedules_fk";

  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_news_audit_fk";

  DROP INDEX "payload_locked_documents_rels_news_schedules_id_idx";
  DROP INDEX "payload_locked_documents_rels_news_audit_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "news_schedules_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "news_audit_id";
  DROP TYPE "public"."enum_news_schedules_target";
  DROP TYPE "public"."enum_news_schedules_action";
  DROP TYPE "public"."enum_news_schedules_state";
  DROP TYPE "public"."enum_news_audit_action";
  DROP TYPE "public"."enum_payload_jobs_log_task_slug";
  DROP TYPE "public"."enum_payload_jobs_log_state";
  DROP TYPE "public"."enum_payload_jobs_task_slug";`)
}
