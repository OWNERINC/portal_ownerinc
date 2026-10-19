import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "portal_page_media" ALTER COLUMN "sha256" DROP NOT NULL;`)
  await db.execute(sql`
   ALTER TABLE "portal_page_media"
   ADD CONSTRAINT "portal_page_media_lifecycle_check"
   CHECK (
     ("state" = 'uploading' AND "sha256" IS NULL AND "completed_at" IS NULL)
     OR
     ("state" = 'complete' AND "sha256" IS NOT NULL AND "sha256" ~ '^[0-9a-f]{64}$' AND "completed_at" IS NOT NULL)
   );`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "portal_page_media" DROP CONSTRAINT "portal_page_media_lifecycle_check";`)
  await db.execute(sql`
   ALTER TABLE "portal_page_media" ALTER COLUMN "sha256" SET NOT NULL;`)
}
