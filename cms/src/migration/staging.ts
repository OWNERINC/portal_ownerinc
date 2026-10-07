import { constants } from 'node:fs'
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { extensions, MAX_MEDIA_BYTES, validateUpload } from '../media/validate-upload'
import { assertImportBinding, isSha256, isUUID, type ImportBinding } from './identity'
import { missingFile, privateImportDirectory, privateImportFile } from './private-paths'

/** Normalized media input, NOT a second bundle schema. Thread2 owns that boundary. */
export type ImportAsset = { id: string; mime: string; size: number; sha256: string; relativePath: string }
export type PromotionIntent = ImportBinding & {
  version: 1; assetId: string; mime: string; size: number; sha256: string; filename: string
}
export type StagedImportAsset = {
  storageRoot: string; journalDirectory: string; intent: PromotionIntent; directorySynced: boolean
}
const serialize = (value: unknown) => `${JSON.stringify(value)}\n`
const conflict = () => new Error('import_asset_conflict')

function assertAsset(asset: ImportAsset) {
  if (!isUUID(asset.id) || !isSha256(asset.sha256) || !Object.hasOwn(extensions, asset.mime) ||
    !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_MEDIA_BYTES) throw new Error('invalid_import_asset')
}

/** Windows cannot provide the directory-fsync guarantee required by Linux apply.
 * Return evidence, do not silently claim crash durability for that platform. */
async function syncDirectory(directory: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try { handle = await open(directory, constants.O_RDONLY); await handle.sync(); return true }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) return false
    throw new Error('import_directory_sync_failed')
  } finally { await handle?.close() }
}

async function readBounded(filename: string, maxBytes: number, exactSize?: number, syncAcceptedInode = false): Promise<Buffer> {
  const before = await lstat(filename)
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > maxBytes ||
    (exactSize !== undefined && before.size !== exactSize)) throw conflict()
  // Windows FlushFileBuffers requires a writable descriptor. O_RDWR here has
  // no CREATE/TRUNC flags and no write call; it is used only for accepted fsync.
  const handle = await open(filename, (syncAcceptedInode ? constants.O_RDWR : constants.O_RDONLY) | (constants.O_NOFOLLOW || 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) throw conflict()
    const bytes = Buffer.alloc(stat.size)
    for (let offset = 0; offset < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) throw conflict()
      offset += bytesRead
    }
    const after = await handle.stat()
    // Exclusive hard-link promotion legitimately changes ctime/link count while
    // another reader verifies the same immutable inode. Content uses mtime/size
    // plus the expected SHA, not ctime (which would create a retry race).
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw conflict()
    if (syncAcceptedInode) {
      // A restored/existing identical file may not be the inode just fsynced by
      // exclusiveFile. Sync THIS descriptor and recheck its pathname identity.
      await handle.sync()
      const current = await lstat(filename)
      if (!current.isFile() || current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev ||
        current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) throw conflict()
    }
    return bytes
  } finally { await handle.close() }
}

async function verifiedBytes(filename: string, expected: Pick<ImportAsset, 'mime' | 'size' | 'sha256'>) {
  const bytes = await readBounded(filename, MAX_MEDIA_BYTES, expected.size)
  const result = await validateUpload({ bytes, mime: expected.mime, filename: path.basename(filename) })
  if (result.sha256 !== expected.sha256 || result.size !== expected.size || result.mime !== expected.mime) throw conflict()
  return bytes
}

/** fsync the new inode, link without overwrite, then fsync its directory. A crash
 * may leave a private attempt file; backup retains it and no retry deletes it. */
async function exclusiveFile(filename: string, bytes: Buffer): Promise<boolean> {
  const directory = await privateImportDirectory(path.dirname(filename))
  const attempt = path.join(directory, `.attempt-${randomUUID()}`)
  const handle = await open(attempt, 'wx', 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  try { await link(attempt, filename) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readBounded(filename, Math.max(bytes.length, 1), bytes.length, true)
    if (!existing.equals(bytes)) throw conflict()
  }
  const synced = await syncDirectory(directory)
  await unlink(attempt)
  return await syncDirectory(directory) && synced
}

async function loadIntent(journalDirectory: string): Promise<PromotionIntent | null> {
  try { return JSON.parse((await readBounded(path.join(journalDirectory, 'intent.json'), 8192)).toString('utf8')) as PromotionIntent }
  catch (error) {
    if (missingFile(error)) return null
    throw new Error('import_staging_binding_conflict')
  }
}

function sameIntent(actual: PromotionIntent, expected: Omit<PromotionIntent, 'filename'>): boolean {
  return actual !== null && typeof actual === 'object' && Object.keys(actual).length === Object.keys(expected).length + 1 &&
    Object.entries(expected).every(([key, value]) => actual[key as keyof PromotionIntent] === value) &&
    typeof actual.filename === 'string' && new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.${extensions[expected.mime]}$`, 'u').test(actual.filename)
}

async function ensureDirectory(directory: string): Promise<boolean> {
  try { await mkdir(directory, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await privateImportDirectory(directory)
  return syncDirectory(path.dirname(directory))
}

export async function stageImportAsset({ sourceRoot, storageRoot, binding, asset }: {
  sourceRoot: string; storageRoot: string; binding: ImportBinding; asset: ImportAsset
}): Promise<StagedImportAsset> {
  assertImportBinding(binding); assertAsset(asset)
  const sourceFile = await privateImportFile(sourceRoot, asset.relativePath)
  const bytes = await verifiedBytes(sourceFile, asset)
  const root = await privateImportDirectory(storageRoot)
  let directorySynced = true
  let directory = root
  for (const part of ['.owner-news-import', binding.manifestSha256, asset.id]) {
    directory = path.join(directory, part)
    directorySynced = await ensureDirectory(directory) && directorySynced
  }
  const expected = { version: 1 as const, ...binding, assetId: asset.id, mime: asset.mime, size: asset.size, sha256: asset.sha256 }
  let intent = await loadIntent(directory)
  if (!intent) {
    const candidate = { ...expected, filename: `${randomUUID()}.${extensions[asset.mime]}` }
    // Another process may win this intent. Reload its reservation instead of
    // changing the selected destination name or overwriting its bytes.
    try { directorySynced = await exclusiveFile(path.join(directory, 'intent.json'), Buffer.from(serialize(candidate))) && directorySynced }
    catch (error) { if (!(error instanceof Error) || error.message !== 'import_asset_conflict') throw error }
    intent = await loadIntent(directory)
  }
  if (!intent || !sameIntent(intent, expected)) throw new Error('import_staging_binding_conflict')
  directorySynced = await exclusiveFile(path.join(directory, 'bytes'), bytes) && directorySynced
  await verifiedBytes(path.join(directory, 'bytes'), intent)
  directorySynced = await exclusiveFile(path.join(directory, 'staged.json'), Buffer.from(serialize(intent))) && directorySynced
  return { storageRoot: root, journalDirectory: directory, intent, directorySynced }
}

async function assertStagedBinding(staged: StagedImportAsset) {
  assertImportBinding(staged.intent)
  assertAsset({ id: staged.intent.assetId, mime: staged.intent.mime, size: staged.intent.size, sha256: staged.intent.sha256, relativePath: 'bytes' })
  const root = await privateImportDirectory(staged.storageRoot)
  const expectedDirectory = path.join(root, '.owner-news-import', staged.intent.manifestSha256, staged.intent.assetId)
  if (!isUUID(staged.intent.assetId) || expectedDirectory !== staged.journalDirectory) throw new Error('import_staging_binding_conflict')
  await privateImportDirectory(expectedDirectory)
  const intent = await loadIntent(expectedDirectory)
  const { filename: _filename, ...expected } = staged.intent
  if (!intent || !sameIntent(intent, expected) || intent.filename !== staged.intent.filename) throw new Error('import_staging_binding_conflict')
  return root
}

/** Resume from the private journal using manifest expectations, even when the
 * original source tree is offline. The journal alone is never the expected hash. */
export async function resumeStagedImportAsset({ storageRoot, binding, asset }: {
  storageRoot: string; binding: ImportBinding; asset: ImportAsset
}): Promise<StagedImportAsset> {
  assertImportBinding(binding); assertAsset(asset)
  const root = await privateImportDirectory(storageRoot)
  const journalDirectory = path.join(root, '.owner-news-import', binding.manifestSha256, asset.id)
  await privateImportDirectory(journalDirectory)
  const intent = await loadIntent(journalDirectory)
  const expected = { version: 1 as const, ...binding, assetId: asset.id, mime: asset.mime, size: asset.size, sha256: asset.sha256 }
  if (!intent || !sameIntent(intent, expected)) throw new Error('import_staging_binding_conflict')
  await verifiedBytes(path.join(journalDirectory, 'bytes'), intent)
  let directorySynced = await exclusiveFile(path.join(journalDirectory, 'staged.json'), Buffer.from(serialize(intent)))
  for (let directory = journalDirectory;; directory = path.dirname(directory)) {
    directorySynced = await syncDirectory(directory) && directorySynced
    if (directory === root) break
  }
  return { storageRoot: root, journalDirectory, intent, directorySynced }
}

export async function promoteImportAsset(staged: StagedImportAsset): Promise<StagedImportAsset> {
  const root = await assertStagedBinding(staged)
  const source = path.join(staged.journalDirectory, 'bytes')
  await verifiedBytes(source, staged.intent)
  const destination = path.join(root, staged.intent.filename)
  try { await link(source, destination) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await assertReservedHardLink(source, destination)
  await verifiedBytes(destination, staged.intent)
  await assertReservedHardLink(source, destination)
  const synced = await syncDirectory(root)
  const journalSynced = await exclusiveFile(path.join(staged.journalDirectory, 'promoted.json'), Buffer.from(serialize(staged.intent)))
  return { ...staged, directorySynced: staged.directorySynced && synced && journalSynced }
}

export async function verifyImportPromotion(staged: StagedImportAsset) {
  const root = await assertStagedBinding(staged)
  const source = path.join(staged.journalDirectory, 'bytes'), destination = path.join(root, staged.intent.filename)
  await assertReservedHardLink(source, destination)
  await verifiedBytes(destination, staged.intent)
  await assertReservedHardLink(source, destination)
  return { sha256: staged.intent.sha256, size: staged.intent.size, mime: staged.intent.mime }
}

/** Reservation is a hard link, not merely equal content at a coincident filename.
 * bigint avoids loss of precision for filesystem inode identifiers on Windows. */
async function assertReservedHardLink(source: string, destination: string) {
  const [from, to] = await Promise.all([lstat(source, { bigint: true }), lstat(destination, { bigint: true })])
  if (!from.isFile() || !to.isFile() || from.isSymbolicLink() || to.isSymbolicLink() ||
    from.ino === 0n || from.ino !== to.ino || from.dev !== to.dev) throw conflict()
}

/** Must pass before attaching rows/acknowledging apply. Windows unit checks only
 * exercise recovery logic; Linux directory durability is an integration gate. */
export function assertDurablePromotion(staged: StagedImportAsset) {
  if (!staged.directorySynced) throw new Error('import_directory_durability_unavailable')
}

export async function recordAssetCommitOutcome(staged: StagedImportAsset, outcome: 'acknowledged' | 'unknown') {
  await assertStagedBinding(staged)
  if (outcome !== 'acknowledged' && outcome !== 'unknown') throw new Error('invalid_import_commit_outcome')
  // Append-only evidence. An ACK does not remove an earlier unknown receipt;
  // reconciliation of the DB and final content remains mandatory.
  return exclusiveFile(path.join(staged.journalDirectory, `commit-${outcome}-${randomUUID()}.json`),
    Buffer.from(serialize({ ...staged.intent, outcome })))
}
