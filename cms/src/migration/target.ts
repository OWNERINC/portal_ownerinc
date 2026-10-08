import { createHash } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { privateImportDirectory } from './private-paths'
import { ImportPreflightError } from './preflight-error'

export type ImportDatabaseOptions = { connectionString: string; databaseName: string }
export type ImportEnvironment = {
  source: ImportDatabaseOptions; destination: ImportDatabaseOptions
  sourceInstance: string; sourceUploadDir: string; targetUploadDir: string
}
export type ImportDatabaseIdentity = { systemIdentifier: string; databaseOid: string; databaseName: string }

function localDatabase(value: string | undefined): ImportDatabaseOptions {
  if (!value) throw new ImportPreflightError('import_configuration_required')
  try {
    const url = new URL(value)
    const databaseName = decodeURIComponent(url.pathname.slice(1))
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.username || url.search || url.hash || !/^[a-zA-Z0-9_-]+$/u.test(databaseName) ||
      !/(?:^|[_-])(dev|development|local|test)(?:[_-]|$)/iu.test(databaseName)) throw new Error()
    return { connectionString: url.href, databaseName }
  } catch { throw new ImportPreflightError('import_local_database_required') }
}

/** Explicit local endpoints only; never read .env or a generic database URL. */
export function readImportEnvironment(env: Record<string, string | undefined>): ImportEnvironment {
  const source = localDatabase(env.OWNER_NEWS_SOURCE_DATABASE_URL)
  const destination = localDatabase(env.OWNER_NEWS_TARGET_DATABASE_URL)
  const sourceInstance = env.OWNER_NEWS_SOURCE_ID
  const sourceUploadDir = env.OWNER_NEWS_SOURCE_UPLOAD_DIR, targetUploadDir = env.OWNER_NEWS_TARGET_UPLOAD_DIR
  if (!sourceInstance || !/^[A-Za-z0-9_-]{1,80}$/u.test(sourceInstance) ||
    !sourceUploadDir || !targetUploadDir || !path.isAbsolute(sourceUploadDir) || !path.isAbsolute(targetUploadDir)) {
    throw new ImportPreflightError('import_configuration_required')
  }
  return { source, destination, sourceInstance, sourceUploadDir, targetUploadDir }
}

const inside = (root: string, other: string) => {
  const relative = path.relative(root, other)
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export async function assertImportStorageIsolation(input: { sourceUploadDir: string; targetUploadDir: string; bundleDirectory: string }) {
  try {
    const source = await privateImportDirectory(input.sourceUploadDir)
    const sourceMedia = await privateImportDirectory(path.join(source, 'cms-private'))
    const target = await privateImportDirectory(input.targetUploadDir)
    const bundle = await privateImportDirectory(input.bundleDirectory)
    const targetStat = await lstat(target, { bigint: true })
    for (const directory of [source, sourceMedia, bundle]) {
      const other = await lstat(directory, { bigint: true })
      if (inside(directory, target) || inside(target, directory) || other.dev === targetStat.dev && other.ino === targetStat.ino) {
        throw new ImportPreflightError('import_storage_overlap')
      }
    }
    return target
  } catch (error) {
    if (error instanceof ImportPreflightError) throw error
    throw new ImportPreflightError('import_storage_overlap')
  }
}

function positiveDecimal(value: unknown, max: bigint): value is string {
  return typeof value === 'string' && /^[1-9]\d{0,19}$/u.test(value) && BigInt(value) <= max
}
function exactEpoch(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null
  if (typeof value !== 'string' || !/^[1-9]\d*(?:\.0+)?$/u.test(value)) return null
  const whole = value.split('.')[0]
  if (whole.length > 16 || BigInt(whole) > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(whole)
}

function parseImportDatabaseIdentity(row: Record<string, unknown>, expectedDatabaseName: string,
  expectedReadOnly: 'on' | 'off' | 'either'): ImportDatabaseIdentity {
  if (!positiveDecimal(row.system_identifier, 18446744073709551615n) || !positiveDecimal(row.database_oid, 4294967295n) ||
    typeof row.database_name !== 'string' ||
    (expectedReadOnly === 'either' ? !['on', 'off'].includes(String(row.transaction_read_only)) : row.transaction_read_only !== expectedReadOnly) ||
    row.in_recovery !== false) {
    throw new ImportPreflightError('import_database_identity_unavailable')
  }
  if (row.database_name !== expectedDatabaseName) throw new ImportPreflightError('import_database_name_mismatch')
  return { systemIdentifier: row.system_identifier, databaseOid: row.database_oid, databaseName: row.database_name }
}

export function readImportDatabaseIdentity(row: Record<string, unknown>, expectedDatabaseName: string): ImportDatabaseIdentity {
  return parseImportDatabaseIdentity(row, expectedDatabaseName, 'on')
}

/** A second identity probe on the live writable Payload transaction. */
export function readLiveImportDatabaseIdentity(row: Record<string, unknown>, expectedDatabaseName: string): ImportDatabaseIdentity {
  return parseImportDatabaseIdentity(row, expectedDatabaseName, 'off')
}

/** A single SELECT through the configured Payload pool has no transaction-mode assumption. */
export function readObservedImportDatabaseIdentity(row: Record<string, unknown>, expectedDatabaseName: string): ImportDatabaseIdentity {
  return parseImportDatabaseIdentity(row, expectedDatabaseName, 'either')
}

export function importDatabaseIdentityFingerprint(value: ImportDatabaseIdentity) {
  return createHash('sha256').update(JSON.stringify([value.systemIdentifier, value.databaseOid])).digest('hex')
}

export function assertImportDatabaseIsolation(source: ImportDatabaseIdentity, destination: ImportDatabaseIdentity) {
  if (source.systemIdentifier === destination.systemIdentifier && source.databaseOid === destination.databaseOid) {
    throw new ImportPreflightError('import_source_destination_same_database')
  }
  return { sourceIdentitySha256: importDatabaseIdentityFingerprint(source),
    targetIdentitySha256: importDatabaseIdentityFingerprint(destination) }
}

export function sourceEpochMatches(value: unknown, expected: number) {
  return exactEpoch(value) === expected
}
