import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_news_schedules_state" ADD VALUE 'suspended';`)
}

export async function down(_args: MigrateDownArgs): Promise<void> {
  throw new Error('unsupported_downgrade:owner_news_suspended_schedule_state')
}
