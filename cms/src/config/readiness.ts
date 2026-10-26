import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { requireCmsTransaction, withCmsTransaction } from '../publication/transaction'

type ReadinessFile = { sync(): Promise<void>; close(): Promise<void> }
type ReadinessFileSystem = {
  open(filename: string, flags: 'wx', mode: number): Promise<ReadinessFile>
  unlink(filename: string): Promise<void>
}

/** Proves the configured mounted storage accepts a durable private file. The
 * probe is always removed and contains no content or identity data. */
export async function assertCmsStorageReady(directory: string,
  fileSystem: ReadinessFileSystem = fs, id: () => string = randomUUID): Promise<void> {
  const filename = path.join(directory, `.ownerinc-ready-${id()}`)
  let file: ReadinessFile | undefined
  let created = false
  let primary: unknown
  try {
    file = await fileSystem.open(filename, 'wx', 0o600)
    created = true
    await file.sync()
  } catch (error) {
    primary = error
    throw error
  } finally {
    await file?.close().catch(() => {})
    if (created) {
      try { await fileSystem.unlink(filename) }
      catch (error) { if (primary === undefined) throw error }
    }
  }
}

const requiredRelations = ['payload_migrations', 'portal_editors', 'news_articles', '_news_articles_v',
  'news_media', 'news_home', '_news_home_v', 'news_schedules', 'owner_news_mutation_head'] as const

export function assertCmsSchemaCatalog(row: unknown): void {
  if (!row || typeof row !== 'object') throw new Error('cms_readiness_schema_incomplete')
  const values = row as Record<string, unknown>
  if (Object.keys(values).length !== requiredRelations.length || requiredRelations.some(name => values[name] !== name)) {
    throw new Error('cms_readiness_schema_incomplete')
  }
}

export async function assertCmsDatabaseReady(payload: Payload): Promise<void> {
  await withCmsTransaction(payload, undefined, async req => {
    const db = await requireCmsTransaction(payload, req)
    const result = await db.execute(sql`SELECT
      to_regclass('public.payload_migrations')::text AS payload_migrations,
      to_regclass('public.portal_editors')::text AS portal_editors,
      to_regclass('public.news_articles')::text AS news_articles,
      to_regclass('public._news_articles_v')::text AS _news_articles_v,
      to_regclass('public.news_media')::text AS news_media,
      to_regclass('public.news_home')::text AS news_home,
      to_regclass('public._news_home_v')::text AS _news_home_v,
      to_regclass('public.news_schedules')::text AS news_schedules,
      to_regclass('public.owner_news_mutation_head')::text AS owner_news_mutation_head`)
    if (result.rows.length !== 1) throw new Error('cms_readiness_schema_incomplete')
    assertCmsSchemaCatalog(result.rows[0])
  })
}
