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
  const result = await db.execute(sql`
   SELECT EXISTS (SELECT 1 FROM "portal_page_media" WHERE "state" = 'uploading') AS "has_uploading";`)
  const rows = (result as unknown as { rows?: Array<Record<string, unknown>> }).rows
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.has_uploading !== 'boolean') {
    throw new Error('Cannot verify active Portal page uploads before rollback; inspect portal_page_media and retry.')
  }
  if (rows[0].has_uploading) {
    throw new Error('Uploading Portal page media must be reconciled or cancelled before rolling back its lifecycle migration.')
  }
  await db.execute(sql`
   ALTER TABLE "portal_page_media" DROP CONSTRAINT "portal_page_media_lifecycle_check";`)
  await db.execute(sql`
   ALTER TABLE "portal_page_media" ALTER COLUMN "sha256" SET NOT NULL;`)
}
