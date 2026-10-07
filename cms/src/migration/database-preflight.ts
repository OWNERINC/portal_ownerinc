import pg from 'pg'
import { ImportPreflightError } from './preflight-error'
import { assertImportDatabaseIsolation, readImportDatabaseIdentity, sourceEpochMatches,
  type ImportDatabaseOptions, type ImportEnvironment } from './target'

export type ImportReadClient = {
  connect?: () => Promise<unknown>; end: () => Promise<unknown>
  query: (text: string) => Promise<{ rows: Record<string, unknown>[] }>
  on?: (event: 'error', listener: () => void) => unknown
}
export type ImportClientFactory = (options: ImportDatabaseOptions) => ImportReadClient
export const createImportReadClient: ImportClientFactory = options => new pg.Client({
  connectionString: options.connectionString, connectionTimeoutMillis: 5000, statement_timeout: 5000,
  query_timeout: 6000, application_name: 'owner-news-import-preflight',
}) as ImportReadClient

const identitySQL = `SELECT current_database() AS database_name,
  (SELECT oid::text FROM pg_catalog.pg_database WHERE datname = current_database()) AS database_oid,
  (SELECT system_identifier::text FROM pg_catalog.pg_control_system()) AS system_identifier,
  pg_catalog.pg_is_in_recovery() AS in_recovery,
  current_setting('transaction_read_only') AS transaction_read_only,
  to_regclass('public.cms_documents')::text AS legacy_documents,
  to_regclass('public.owner_news_authority')::text AS legacy_authority,
  to_regclass('public.news_articles')::text AS payload_articles,
  to_regclass('public.news_home')::text AS payload_home,
  to_regclass('public.news_media')::text AS payload_media`

async function inspectDatabase(options: ImportDatabaseOptions, isSource: boolean, connect: ImportClientFactory) {
  const client = connect(options)
  let connected = false, inTransaction = false
  client.on?.('error', () => {}) // Driver errors are never printed or serialized.
  try {
    await client.connect?.(); connected = true
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); inTransaction = true
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '5s'")
    const result = await client.query(identitySQL)
    if (result.rows.length !== 1) throw new ImportPreflightError('import_database_identity_unavailable')
    const row = result.rows[0]
    const identity = readImportDatabaseIdentity(row, options.databaseName)
    if (isSource ? row.legacy_documents !== 'cms_documents' || row.legacy_authority !== 'owner_news_authority' || row.payload_articles !== null
      : row.payload_articles !== 'news_articles' || row.payload_home !== 'news_home' || row.payload_media !== 'news_media' ||
        row.legacy_documents !== null || row.legacy_authority !== null) {
      throw new ImportPreflightError('import_database_schema_mismatch')
    }
    let authority: Record<string, unknown> | undefined
    if (isSource) {
      const authorities = await client.query('SELECT mode, epoch::text AS epoch FROM public.owner_news_authority WHERE singleton=TRUE')
      if (authorities.rows.length !== 1) throw new ImportPreflightError('import_source_authority_changed')
      authority = authorities.rows[0]
    }
    return { identity, authority }
  } catch (error) {
    if (error instanceof ImportPreflightError) throw error
    throw new ImportPreflightError(connected ? 'import_database_identity_unavailable' : 'import_database_unavailable')
  } finally {
    try { if (connected && inTransaction) await client.query('ROLLBACK') }
    catch {
      await client.end().catch(() => {})
      throw new ImportPreflightError('import_database_unavailable')
    }
    try { await client.end() }
    catch { throw new ImportPreflightError('import_database_unavailable') }
  }
}

/** Probes are read-only, independent and bounded. They do not re-export/fingerprint
 * source rows or read destination content. Missing control privileges fail closed. */
export async function preflightImportDatabases(environment: ImportEnvironment,
  expectedAuthority: { mode: string; epoch: number }, connect: ImportClientFactory = createImportReadClient) {
  const source = await inspectDatabase(environment.source, true, connect)
  const target = await inspectDatabase(environment.destination, false, connect)
  const physical = assertImportDatabaseIsolation(source.identity, target.identity)
  if (expectedAuthority.mode !== 'frozen' || !Number.isSafeInteger(expectedAuthority.epoch) || expectedAuthority.epoch < 1 ||
    source.authority?.mode !== 'frozen' || !sourceEpochMatches(source.authority.epoch, expectedAuthority.epoch)) {
    throw new ImportPreflightError('import_source_authority_changed')
  }
  return physical
}
