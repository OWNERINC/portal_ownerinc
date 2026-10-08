import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { verifyPreauthorityCatalogReadOnly } from './finalize-news-protocol'
import { NEWS_MUTATION_TABLES } from '../src/publication/mutation-ledger'

const require = createRequire(import.meta.url)
const { Client } = require('pg') as { Client: new (options: { connectionString: string }) => {
  connect(): Promise<void>
  query(sql: string): Promise<{ rows: Record<string, unknown>[] }>
  end(): Promise<void>
} }

const fail = (): never => { throw new Error('preauthority_catalog_verification_failed') }

/** Pure decision helper shared with the unit tests; it is not a seal or coverage claim. */
export function assertPreauthorityCatalogState(protocolStatus: unknown, mutationRows: unknown): void {
  if (protocolStatus !== 'absent' || typeof mutationRows !== 'bigint' || mutationRows !== 0n) fail()
}

async function main(): Promise<void> {
  const url = process.env.CMS_ADMIN_DATABASE_URL
  if (!url || process.env.CMS_DATABASE_URL || process.env.DATABASE_URL) fail()
  const client = new Client({ connectionString: url as string })
  let connected = false
  try {
    await client.connect()
    connected = true
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '10min'")
    await client.query("SET LOCAL search_path = pg_catalog, public")
    const native = await verifyPreauthorityCatalogReadOnly(client)
    if (NEWS_MUTATION_TABLES.length !== 39) fail()
    const counts = await client.query(`SELECT COALESCE(SUM(row_count), 0)::text AS row_count FROM (
      ${NEWS_MUTATION_TABLES.map(name => `SELECT count(*) AS row_count FROM public."${name}"`).join('\nUNION ALL\n')}
    ) AS preauthority_news_rows`)
    const rowCountText = counts.rows[0]?.row_count
    if (typeof rowCountText !== 'string' || !/^(0|[1-9][0-9]*)$/.test(rowCountText)) fail()
    assertPreauthorityCatalogState(native.protocolStatus, BigInt(rowCountText as string))
    await client.query('ROLLBACK')
    process.stdout.write(`${JSON.stringify({
      phase: 'preauthority',
      protocolStatus: native.protocolStatus,
      coverageApplicability: native.coverageApplicability,
      migrationNames: native.migrationNames,
      migrationFingerprint: native.migrationFingerprint,
      nativeCatalogFingerprint: native.nativeCatalogFingerprint,
      newsMutationRows: 0,
      ready: false,
      admissionActivated: false,
      cutoverCertified: false,
    })}\n`)
  } catch {
    try { if (connected) await client.query('ROLLBACK') } catch { /* preserve the fixed failure */ }
    fail()
  } finally {
    try { await client.end() } catch { /* never expose driver details */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => {
    process.stderr.write('preauthority catalog verification failed\n')
    process.exitCode = 1
  })
}
