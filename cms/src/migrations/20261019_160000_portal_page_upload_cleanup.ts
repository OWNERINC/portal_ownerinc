import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TABLE "portal_page_upload_cleanup" (
      "upload_id" uuid PRIMARY KEY NOT NULL,
      "status" varchar NOT NULL DEFAULT 'pending',
      "next_attempt_at" timestamp(3) with time zone,
      "attempt_count" integer NOT NULL DEFAULT 0,
      "last_error_code" varchar,
      "created_at" timestamp(3) with time zone NOT NULL DEFAULT now(),
      "updated_at" timestamp(3) with time zone NOT NULL DEFAULT now(),
      CONSTRAINT "portal_page_upload_cleanup_status_check"
        CHECK (
          ("status" = 'pending' AND "next_attempt_at" IS NOT NULL)
          OR ("status" = 'done' AND "next_attempt_at" IS NULL)
        ),
      CONSTRAINT "portal_page_upload_cleanup_attempt_count_check" CHECK ("attempt_count" >= 0),
      CONSTRAINT "portal_page_upload_cleanup_error_code_check" CHECK (
        "last_error_code" IS NULL OR "last_error_code" IN (
          'invalid_media_file', 'upload_incomplete', 'upload_unavailable', 'storage_unavailable',
          'disk_unavailable', 'cleanup_failed', 'upload_not_found', 'media_already_complete'
        )
      )
    );`)
  await db.execute(sql`
    CREATE INDEX "portal_page_upload_cleanup_due_idx"
    ON "portal_page_upload_cleanup" ("next_attempt_at", "upload_id");`)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  const result = await db.execute(sql`
    SELECT
      EXISTS (SELECT 1 FROM "portal_page_upload_cleanup" WHERE "status" = 'pending') AS "has_pending",
      EXISTS (SELECT 1 FROM "portal_page_media" WHERE "state" = 'uploading') AS "has_uploading";`)
  const rows = (result as unknown as { rows?: Array<Record<string, unknown>> }).rows
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.has_pending !== 'boolean' ||
    typeof rows[0]?.has_uploading !== 'boolean') {
    throw new Error('Cannot verify page upload cleanup before rollback; inspect the cleanup queue and media rows, then retry.')
  }
  if (rows[0].has_pending || rows[0].has_uploading) {
    throw new Error('Cannot roll back page upload cleanup while pending cleanup or uploading media exists; reconcile or cancel page uploads first.')
  }
  await db.execute(sql`DROP TABLE "portal_page_upload_cleanup";`)
}
