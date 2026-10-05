import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_legacy_news_revisions_original_status" AS ENUM('draft', 'published', 'scheduled', 'archived');
  CREATE TABLE "legacy_news_revisions" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "legacy_document_id" varchar NOT NULL,
    "legacy_revision_id" varchar NOT NULL,
    "original_version" numeric NOT NULL,
    "original_created_at" varchar NOT NULL,
    "original_actor_uid" varchar,
    "original_status" "enum_legacy_news_revisions_original_status" NOT NULL,
    "original_title" varchar NOT NULL,
    "original_category" varchar,
    "original_published_at" varchar,
    "original_body" jsonb NOT NULL,
    "original_editorial" jsonb,
    "content_hash" varchar NOT NULL,
    "provenance_hash" varchar NOT NULL,
    "updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
    "created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  CREATE TABLE "legacy_news_revisions_rels" (
    "id" serial PRIMARY KEY NOT NULL,
    "order" integer,
    "parent_id" uuid NOT NULL,
    "path" varchar NOT NULL,
    "news_media_id" uuid
  );

  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "legacy_news_revisions_id" uuid;
  ALTER TABLE "legacy_news_revisions_rels" ADD CONSTRAINT "legacy_news_revisions_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."legacy_news_revisions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "legacy_news_revisions_rels" ADD CONSTRAINT "legacy_news_revisions_rels_news_media_fk" FOREIGN KEY ("news_media_id") REFERENCES "public"."news_media"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "legacy_news_revisions_legacy_document_id_idx" ON "legacy_news_revisions" USING btree ("legacy_document_id");
  CREATE INDEX "legacy_news_revisions_legacy_revision_id_idx" ON "legacy_news_revisions" USING btree ("legacy_revision_id");
  CREATE INDEX "legacy_news_revisions_updated_at_idx" ON "legacy_news_revisions" USING btree ("updated_at");
  CREATE INDEX "legacy_news_revisions_created_at_idx" ON "legacy_news_revisions" USING btree ("created_at");
  CREATE UNIQUE INDEX "legacyDocumentId_legacyRevisionId_idx" ON "legacy_news_revisions" USING btree ("legacy_document_id","legacy_revision_id");
  CREATE INDEX "legacy_news_revisions_rels_order_idx" ON "legacy_news_revisions_rels" USING btree ("order");
  CREATE INDEX "legacy_news_revisions_rels_parent_idx" ON "legacy_news_revisions_rels" USING btree ("parent_id");
  CREATE INDEX "legacy_news_revisions_rels_path_idx" ON "legacy_news_revisions_rels" USING btree ("path");
  CREATE INDEX "legacy_news_revisions_rels_news_media_id_idx" ON "legacy_news_revisions_rels" USING btree ("news_media_id");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_legacy_news_revisions_fk" FOREIGN KEY ("legacy_news_revisions_id") REFERENCES "public"."legacy_news_revisions"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_legacy_news_revisions_id_idx" ON "payload_locked_documents_rels" USING btree ("legacy_news_revisions_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_legacy_news_revisions_fk";
   ALTER TABLE "legacy_news_revisions" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "legacy_news_revisions_rels" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "legacy_news_revisions" CASCADE;
  DROP TABLE "legacy_news_revisions_rels" CASCADE;

  DROP INDEX "payload_locked_documents_rels_legacy_news_revisions_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "legacy_news_revisions_id";
  DROP TYPE "public"."enum_legacy_news_revisions_original_status";`)
}
