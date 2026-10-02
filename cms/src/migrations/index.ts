import type { MigrateDownArgs, MigrateUpArgs } from '@payloadcms/db-postgres'

// Empty registry: schema migrations are introduced by later tasks via the Payload CLI.
export const migrations: {
  name: string
  up: (args: MigrateUpArgs) => Promise<void>
  down: (args: MigrateDownArgs) => Promise<void>
}[] = []
