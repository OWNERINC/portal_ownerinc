import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readFile, rename, stat, statfs, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Writable, type Readable as NodeReadable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import sharp from 'sharp'
import { sql } from '@payloadcms/db-postgres'
import type { Payload, PayloadRequest } from 'payload'
import { MAX_IMAGE_PIXELS } from '../media/validate-upload'
import { requireCmsTransaction, withCmsTransaction } from '../publication/transaction'
import { lockPortalPageUpload, withPortalPageMediaLifecycleMutation, withPortalPageMediaMutation } from './persistence'
import { PORTAL_PAGE_MEDIA_SIZE_CAPS, validatePortalPageMediaMetadata } from './validation'
import { PORTAL_PAGE_MEDIA_MIMES } from './primitives'
import { readFreshPortalPageUploadState, readPortalPageUploadCleanupState,
  type FreshPortalPageUploadState, type PortalPageUploadCleanupState } from './upload-commit-confirmation'
import {
  PORTAL_PAGE_UPLOAD_CLEANUP_BATCH_SIZE,
  portalPageUploadRetryDelay,
  processPortalPageUploadCleanupBatch,
  type PortalPageUploadCleanupAdapter,
  type PortalPageUploadCleanupItem,
} from './upload-cleanup-queue'

const MiB = 1024 * 1024
export const PORTAL_PAGE_UPLOAD_CHUNK_SIZE = 5 * MiB
export const PORTAL_PAGE_UPLOAD_MAX_CHUNKS = 100
export const PORTAL_PAGE_UPLOAD_MAX_ACTIVE_PER_ACTOR = 2
export const PORTAL_PAGE_UPLOAD_MAX_ACTIVE_GLOBAL = 8
export const PORTAL_PAGE_UPLOAD_MIN_FREE_BYTES = 1024 * MiB
export const PORTAL_PAGE_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000
const MAX_MANIFEST_BYTES = 8192
const STREAM_HIGH_WATER_MARK = 64 * 1024
const PAGE_MEDIA_COLLECTION = 'portal-page-media'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const MP4_BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '].map(value => Buffer.from(value, 'ascii').toString('hex')))
const PDF_HEADER = Buffer.from('%PDF-')
const PDF_EOF = Buffer.from('%%EOF')
const PROCESS_INSTANCE_NONCE = randomBytes(24).toString('hex')

export class PortalPageUploadError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

function fail(code: string, status = 400): never { throw new PortalPageUploadError(code, status) }
function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_request')
  return value as Record<string, unknown>
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || Object.keys(value).some(key => !expected.includes(key))) fail('invalid_request')
}
function validatedID(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) fail('invalid_request')
  return value.toLowerCase()
}
function actorUID(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\p{Cc}]/u.test(value)) fail('forbidden', 403)
  return value
}

export type PortalPageUploadInit = {
  originalName: string
  mimeType: (typeof PORTAL_PAGE_MEDIA_MIMES)[number]
  bytes: number
  chunkCount: number
}

/** Validate declared limits before any storage allocation or request-body read. */
export function validatePortalPageUploadInit(value: unknown): PortalPageUploadInit {
  const input = asRecord(value)
  exactKeys(input, ['originalName', 'mimeType', 'bytes'])
  if (typeof input.originalName !== 'string' || input.originalName.length > 255 ||
    !input.originalName.trim() || /[\/\\\x00-\x1f\x7f]/u.test(input.originalName)) fail('invalid_request')
  const originalName = input.originalName.trim()
  if (Array.from(originalName).length > 255 || /<\s*\/?\s*[a-z]|\bon[a-z0-9_-]+\s*=|javascript\s*:/iu.test(originalName)) fail('invalid_request')
  if (typeof input.mimeType !== 'string' || !PORTAL_PAGE_MEDIA_MIMES.includes(input.mimeType as never)) fail('unsupported_media', 415)
  const mimeType = input.mimeType as PortalPageUploadInit['mimeType']
  const cap = PORTAL_PAGE_MEDIA_SIZE_CAPS[mimeType]
  if (!Number.isSafeInteger(input.bytes) || Number(input.bytes) < 1) fail('invalid_request')
  const bytes = Number(input.bytes)
  if (bytes > cap) fail('media_too_large', 413)
  const chunkCount = Math.ceil(bytes / PORTAL_PAGE_UPLOAD_CHUNK_SIZE)
  if (chunkCount < 1 || chunkCount > PORTAL_PAGE_UPLOAD_MAX_CHUNKS) fail('media_too_large', 413)
  return { originalName, mimeType, bytes, chunkCount }
}

export function expectedPortalPageUploadChunkBytes(bytes: number, chunkCount: number, index: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 1 || !Number.isSafeInteger(chunkCount) || chunkCount < 1 ||
    chunkCount > PORTAL_PAGE_UPLOAD_MAX_CHUNKS || chunkCount !== Math.ceil(bytes / PORTAL_PAGE_UPLOAD_CHUNK_SIZE) ||
    !Number.isSafeInteger(index) || index < 0 || index >= chunkCount) fail('invalid_chunk', 400)
  return index === chunkCount - 1 ? bytes - (chunkCount - 1) * PORTAL_PAGE_UPLOAD_CHUNK_SIZE : PORTAL_PAGE_UPLOAD_CHUNK_SIZE
}

/** Retry short writes until every byte reaches disk; a zero-byte write is never treated as success. */
export async function writePortalPageBytesFully(handle: Pick<FileHandle, 'write'>, bytes: Uint8Array): Promise<void> {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  let offset = 0
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset, null)
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0 || result.bytesWritten > buffer.length - offset) {
      throw new Error('file write made zero progress')
    }
    offset += result.bytesWritten
  }
}

async function writeFileBytes(context: MutationRequestContext, handle: Pick<FileHandle, 'write'>,
  bytes: Uint8Array, purpose: WritePurpose): Promise<void> {
  if (context.fileHandleWrite) return context.fileHandleWrite(handle, bytes, purpose)
  return writePortalPageBytesFully(handle, bytes)
}

/** Stream sequential sources into a backpressured destination while hashing and enforcing an exact byte count. */
export async function streamPortalPageBytes(sources: readonly NodeReadable[], destination: Writable, expectedBytes: number) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1) fail('invalid_request')
  const digest = createHash('sha256')
  let bytes = 0
  const source = Readable.from((async function* () {
    for (const stream of sources) {
      for await (const chunk of stream) {
        if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) fail('invalid_upload_body')
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += part.byteLength
        if (bytes > expectedBytes) fail('invalid_chunk_size', 400)
        digest.update(part)
        for (let offset = 0; offset < part.length; offset += STREAM_HIGH_WATER_MARK) {
          yield part.subarray(offset, Math.min(part.length, offset + STREAM_HIGH_WATER_MARK))
        }
      }
    }
  })(), { objectMode: false, highWaterMark: STREAM_HIGH_WATER_MARK })
  await pipeline(source, destination)
  if (bytes !== expectedBytes) fail('invalid_chunk_size', 400)
  return { bytes, sha256: digest.digest('hex') }
}

type UploadState = 'receiving' | 'assembling' | 'ready_to_rename' | 'renamed' | 'cancelling'
type UploadManifest = {
  version: 1
  id: string
  storageKey: string
  actorUid: string
  mimeType: PortalPageUploadInit['mimeType']
  bytes: number
  chunkSize: number
  chunkCount: number
  createdAt: string
  tokenHash: string
  state: UploadState
  finalSha256?: string
}
type StoredPaths = { root: string; pages: string; incoming: string }
type UploadLock = { release: () => Promise<void>; recoveredStaleOwner: boolean }
type UploadAdmissionStats = { activeForActor: number; activeGlobal: number; reservedBytes: bigint }
type WritePurpose = 'manifest' | 'lock' | 'chunk' | 'assembly'
type UploadQueueServiceAdapter = PortalPageUploadCleanupAdapter & {
  enqueue: (uploadID: string, nextAttemptAt: number) => Promise<void>
  remove: (uploadID: string) => Promise<void>
  schedule: (uploadID: string, nextAttemptAt: number) => Promise<void>
  markDone: (uploadID: string) => Promise<void>
}
type MutationRequestContext = { payload: Payload; req: PayloadRequest; actorUid: string; uploadDir: string; now?: () => number;
  statfsFreeBytes?: (directory: string) => Promise<bigint>;
  processInstanceNonce?: string;
  processStartIdentity?: string;
  readProcessIdentity?: (pid: number) => Promise<string | null>;
  fileHandleWrite?: (handle: Pick<FileHandle, 'write'>, bytes: Uint8Array, purpose: WritePurpose) => Promise<void>;
  readUploadAdmission?: (actorUid: string, now: number) => Promise<UploadAdmissionStats>;
  cleanupQueueAdapter?: (db: Awaited<ReturnType<typeof requireCmsTransaction>>) => UploadQueueServiceAdapter }

function getPaths(uploadDir: string): StoredPaths {
  if (!path.isAbsolute(uploadDir) || uploadDir.includes('\0')) fail('storage_unavailable', 503)
  const root = path.resolve(uploadDir)
  return { root, pages: path.join(root, 'portal-pages'), incoming: path.join(root, 'portal-pages', '.incoming') }
}
function isNotFound(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function isAlreadyExists(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'EEXIST' }

async function verifyDirectoryChain(directory: string): Promise<void> {
  const absolute = path.resolve(directory)
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    let info
    try { info = await lstat(current) } catch { fail('storage_unavailable', 503) }
    if (!info.isDirectory() || info.isSymbolicLink()) fail('storage_unavailable', 503)
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try { await mkdir(directory, { mode: 0o700 }) } catch (error) { if (!isAlreadyExists(error)) fail('storage_unavailable', 503) }
  let info
  try { info = await lstat(directory) } catch { fail('storage_unavailable', 503) }
  if (!info.isDirectory() || info.isSymbolicLink()) fail('storage_unavailable', 503)
  if (process.platform !== 'win32') {
    try { await chmod(directory, 0o700) } catch { fail('storage_unavailable', 503) }
    const secured = await lstat(directory)
    if (!secured.isDirectory() || secured.isSymbolicLink() || (secured.mode & 0o077) !== 0) fail('storage_unavailable', 503)
  }
}

async function ensureStorage(uploadDir: string): Promise<StoredPaths> {
  const paths = getPaths(uploadDir)
  await verifyDirectoryChain(paths.root)
  await ensurePrivateDirectory(paths.pages)
  await ensurePrivateDirectory(paths.incoming)
  try {
    const pages = await stat(paths.pages), incoming = await stat(paths.incoming)
    if (pages.dev !== incoming.dev) fail('storage_unavailable', 503)
  } catch { fail('storage_unavailable', 503) }
  return paths
}

function manifestPath(paths: StoredPaths, id: string): string { return path.join(paths.incoming, `m-${id}.json`) }
function manifestTempPath(paths: StoredPaths, id: string): string { return path.join(paths.incoming, `m-${id}.tmp`) }
function uploadLockPath(paths: StoredPaths, id: string): string { return path.join(paths.incoming, `u-${id}.lock`) }
function recoveryMarkerPath(paths: StoredPaths, id: string): string { return path.join(paths.incoming, `r-${id}.lock`) }
function chunkPath(paths: StoredPaths, id: string, index: number): string { return path.join(paths.incoming, `${id}-${index}.chunk`) }
function chunkPartPath(paths: StoredPaths, id: string, index: number): string { return path.join(paths.incoming, `${id}-${index}.part`) }
function assembledPartPath(paths: StoredPaths, id: string): string { return path.join(paths.incoming, `${id}.assembled.part`) }
function finalPath(paths: StoredPaths, storageKey: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp|pdf|mp4|webm)$/u.test(storageKey)) {
    fail('storage_unavailable', 503)
  }
  const candidate = path.resolve(paths.pages, storageKey)
  if (path.dirname(candidate) !== paths.pages) fail('storage_unavailable', 503)
  return candidate
}

async function assertRegularOrAbsent(filename: string): Promise<boolean> {
  try {
    const info = await lstat(filename)
    if (!info.isFile() || info.isSymbolicLink()) fail('storage_unavailable', 503)
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) fail('storage_unavailable', 503)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

async function removeRegularFile(filename: string): Promise<void> {
  if (!(await assertRegularOrAbsent(filename))) return
  try { await unlink(filename) } catch (error) { if (!isNotFound(error)) fail('storage_unavailable', 503) }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle
  try {
    handle = await open(directory, constants.O_RDONLY)
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (process.platform === 'win32' && ['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes(code || '')) return
    fail('storage_unavailable', 503)
  } finally { await handle?.close().catch(() => {}) }
}

function validateManifest(value: unknown, expectedID: string): UploadManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('upload_unavailable', 503)
  const row = value as Record<string, unknown>
  const allowed = ['version', 'id', 'storageKey', 'actorUid', 'mimeType', 'bytes', 'chunkSize', 'chunkCount', 'createdAt', 'tokenHash', 'state', 'finalSha256']
  if (Object.keys(row).some(key => !allowed.includes(key))) fail('upload_unavailable', 503)
  if (typeof row.id !== 'string' || !UUID.test(row.id)) fail('upload_unavailable', 503)
  const id = row.id.toLowerCase()
  if (row.version !== 1 || id !== expectedID || typeof row.storageKey !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp|pdf|mp4|webm)$/u.test(row.storageKey) ||
    typeof row.actorUid !== 'string' || !row.actorUid || row.actorUid.length > 128 ||
    /[\p{Cc}]/u.test(row.actorUid) || typeof row.mimeType !== 'string' || !PORTAL_PAGE_MEDIA_MIMES.includes(row.mimeType as never) ||
    !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 1 || Number(row.bytes) > PORTAL_PAGE_MEDIA_SIZE_CAPS[row.mimeType as PortalPageUploadInit['mimeType']] ||
    row.chunkSize !== PORTAL_PAGE_UPLOAD_CHUNK_SIZE || !Number.isSafeInteger(row.chunkCount) ||
    row.chunkCount !== Math.ceil(Number(row.bytes) / PORTAL_PAGE_UPLOAD_CHUNK_SIZE) || row.chunkCount < 1 || row.chunkCount > PORTAL_PAGE_UPLOAD_MAX_CHUNKS ||
    typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt)) || new Date(row.createdAt).toISOString() !== row.createdAt ||
    typeof row.tokenHash !== 'string' || !/^[0-9a-f]{64}$/u.test(row.tokenHash) ||
    !['receiving', 'assembling', 'ready_to_rename', 'renamed', 'cancelling'].includes(String(row.state))) fail('upload_unavailable', 503)
  const state = row.state as UploadState
  const extension = row.mimeType === 'image/jpeg' ? 'jpg' : row.mimeType === 'image/png' ? 'png' :
    row.mimeType === 'image/webp' ? 'webp' : row.mimeType === 'application/pdf' ? 'pdf' :
      row.mimeType === 'video/mp4' ? 'mp4' : 'webm'
  if (!row.storageKey.endsWith(`.${extension}`)) fail('upload_unavailable', 503)
  const hasFinalHash = typeof row.finalSha256 === 'string' && /^[0-9a-f]{64}$/u.test(row.finalSha256)
  if (((state === 'ready_to_rename' || state === 'renamed') && !hasFinalHash) ||
    ((state === 'receiving' || state === 'assembling') && hasFinalHash) ||
    (row.finalSha256 !== undefined && !hasFinalHash)) fail('upload_unavailable', 503)
  return {
    version: 1, id, storageKey: row.storageKey, actorUid: row.actorUid, mimeType: row.mimeType as PortalPageUploadInit['mimeType'],
    bytes: Number(row.bytes), chunkSize: PORTAL_PAGE_UPLOAD_CHUNK_SIZE, chunkCount: Number(row.chunkCount),
    createdAt: row.createdAt, tokenHash: row.tokenHash, state, ...(hasFinalHash ? { finalSha256: row.finalSha256 as string } : {}),
  }
}

async function readSmallRegularFile(filename: string, maxBytes: number): Promise<Buffer> {
  let handle
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const info = await handle.stat()
    if (!info.isFile() || info.size < 1 || info.size > maxBytes ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) fail('upload_unavailable', 503)
    return await handle.readFile()
  } catch (error) {
    if (error instanceof PortalPageUploadError) throw error
    throw new PortalPageUploadError('upload_unavailable', 503)
  } finally { await handle?.close().catch(() => {}) }
}

async function readManifest(paths: StoredPaths, id: string, source = manifestPath(paths, id)): Promise<UploadManifest> {
  const bytes = await readSmallRegularFile(source, MAX_MANIFEST_BYTES)
  let parsed: unknown
  try { parsed = JSON.parse(bytes.toString('utf8')) } catch { fail('upload_unavailable', 503) }
  return validateManifest(parsed, id)
}

async function writeManifest(context: MutationRequestContext, paths: StoredPaths, manifest: UploadManifest): Promise<void> {
  const id = validatedID(manifest.id)
  const normalized = validateManifest(manifest, id)
  const temp = manifestTempPath(paths, id)
  const data = Buffer.from(JSON.stringify(normalized), 'utf8')
  if (data.length > MAX_MANIFEST_BYTES) fail('upload_unavailable', 503)
  let handle
  try {
    handle = await open(temp, 'wx', 0o600)
    await writeFileBytes(context, handle, data, 'manifest')
    await handle.sync()
    await handle.close(); handle = undefined
    const target = manifestPath(paths, id)
    await assertRegularOrAbsent(target)
    await rename(temp, target)
    await syncDirectory(paths.incoming)
  } catch (error) {
    await handle?.close().catch(() => {})
    await removeRegularFile(temp).catch(() => {})
    if (error instanceof PortalPageUploadError) throw error
    throw new PortalPageUploadError('storage_unavailable', 503)
  }
}

function tokenHash(token: string): string { return createHash('sha256').update(token, 'utf8').digest('hex') }
export function verifyPortalPageUploadToken(token: unknown, expectedHash: string): boolean {
  const validTokenShape = typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(token)
  const candidate = createHash('sha256').update(typeof token === 'string' ? token : '', 'utf8').digest()
  const expected = /^[0-9a-f]{64}$/u.test(expectedHash) ? Buffer.from(expectedHash, 'hex') : Buffer.alloc(32)
  const equal = timingSafeEqual(candidate, expected)
  return validTokenShape && /^[0-9a-f]{64}$/u.test(expectedHash) && equal
}

async function defaultProcessIdentity(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return pid === process.pid ? `process:${process.pid}` : null
  try {
    const [bootID, statText] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ])
    const close = statText.lastIndexOf(')')
    if (close < 0) return null
    const fields = statText.slice(close + 2).trim().split(/\s+/u)
    const startTicks = fields[19]
    if (!startTicks || !/^\d+$/u.test(startTicks)) return null
    return `linux:${bootID.trim()}:${startTicks}`
  } catch { return null }
}

async function ownProcessIdentity(context: MutationRequestContext): Promise<string> {
  if (context.processStartIdentity) return context.processStartIdentity
  const identity = await (context.readProcessIdentity || defaultProcessIdentity)(process.pid)
  if (identity) return identity
  if (process.platform !== 'linux') return `process:${process.pid}`
  fail('storage_unavailable', 503)
}

type LockOwner = { kind: 'live'; pid: number; sameInstance: boolean } | { kind: 'stale' } | { kind: 'malformed' }

async function readLockOwner(context: MutationRequestContext, filename: string, localIdentity: string): Promise<LockOwner> {
  let info
  try { info = await lstat(filename) } catch (error) {
    if (isNotFound(error)) return { kind: 'stale' }
    fail('storage_unavailable', 503)
  }
  if (!info.isFile() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
    fail('upload_busy', 409)
  }
  let bytes: Buffer
  try { bytes = await readSmallRegularFile(filename, 1024) } catch { return { kind: 'malformed' } }
  let value: Record<string, unknown>
  try { value = asRecord(JSON.parse(bytes.toString('utf8'))) } catch { return { kind: 'malformed' } }
  const allowed = ['version', 'pid', 'processInstanceNonce', 'processStartIdentity', 'createdAt', 'nonce']
  if (Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key)) ||
    value.version !== 1 || !Number.isSafeInteger(value.pid) || Number(value.pid) < 1 ||
    typeof value.processInstanceNonce !== 'string' || !/^[0-9a-f]{48}$/u.test(value.processInstanceNonce) ||
    typeof value.processStartIdentity !== 'string' || !value.processStartIdentity || value.processStartIdentity.length > 256 ||
    typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.nonce !== 'string' || !/^[0-9a-f]{32}$/u.test(value.nonce)) return { kind: 'malformed' }
  const pid = Number(value.pid)
  const sameInstance = pid === process.pid && value.processInstanceNonce === (context.processInstanceNonce || PROCESS_INSTANCE_NONCE) &&
    value.processStartIdentity === localIdentity
  if (sameInstance) return { kind: 'live', pid, sameInstance: true }
  try { process.kill(pid, 0) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return { kind: 'stale' }
    // Permission and platform probing failures cannot prove that a foreign owner is dead.
    return { kind: 'live', pid, sameInstance: false }
  }
  const actual = await (context.readProcessIdentity || defaultProcessIdentity)(pid)
  if (!actual) return { kind: 'live', pid, sameInstance: false }
  if (actual === value.processStartIdentity) return { kind: 'live', pid, sameInstance: false }
  return { kind: 'stale' }
}

/** Preserve process-identity proof across failed partial cleanup without enumerating storage. */
async function preserveStaleOwnerEvidence(context: MutationRequestContext, paths: StoredPaths, id: string,
  staleOwnerPath: string, localIdentity: string): Promise<boolean> {
  const marker = recoveryMarkerPath(paths, id)
  if (await assertRegularOrAbsent(marker)) {
    const existingOwner = await readLockOwner(context, marker, localIdentity)
    if (existingOwner.kind !== 'stale') fail('upload_busy', 409)
    // The marker must be durable before removing the canonical stale lock.
    await syncDirectory(paths.incoming)
    await removeRegularFile(staleOwnerPath)
    await syncDirectory(paths.incoming)
    return true
  }

  try { await link(staleOwnerPath, marker) } catch (error) {
    if (isNotFound(error)) return false
    if (!isAlreadyExists(error)) fail('storage_unavailable', 503)
    if (!(await assertRegularOrAbsent(marker))) return false
    const existingOwner = await readLockOwner(context, marker, localIdentity)
    if (existingOwner.kind !== 'stale') fail('upload_busy', 409)
  }
  // Preserve the only recovery proof before unlinking its canonical name.
  await syncDirectory(paths.incoming)
  await removeRegularFile(staleOwnerPath)
  await syncDirectory(paths.incoming)
  return true
}

async function publishUploadLock(context: MutationRequestContext, paths: StoredPaths, filename: string,
  lockData: Buffer, temp: string): Promise<'published' | 'exists'> {
  let handle
  try { handle = await open(temp, 'wx', 0o600) }
  catch (error) {
    if (isAlreadyExists(error)) return 'exists'
    fail('storage_unavailable', 503)
  }
  let linked = false
  try {
    await writeFileBytes(context, handle, lockData, 'lock')
    await handle.sync()
    await handle.close(); handle = undefined
    try { await link(temp, filename); linked = true }
    catch (error) {
      if (isAlreadyExists(error)) {
        await removeRegularFile(temp)
        await syncDirectory(paths.incoming)
        return 'exists'
      }
      throw error
    }
    await unlink(temp)
    await syncDirectory(paths.incoming)
    return 'published'
  } catch (error) {
    await handle?.close().catch(() => {})
    if (linked) {
      const current = await readSmallRegularFile(filename, 1024).catch(() => Buffer.alloc(0))
      let currentNonce: unknown
      try { currentNonce = asRecord(JSON.parse(current.toString('utf8'))).nonce } catch { currentNonce = null }
      if (currentNonce === JSON.parse(lockData.toString('utf8')).nonce) await removeRegularFile(filename).catch(() => {})
    }
    await removeRegularFile(temp).catch(() => {})
    if (error instanceof PortalPageUploadError) throw error
    fail('storage_unavailable', 503)
  }
}

async function acquireUploadLock(context: MutationRequestContext, paths: StoredPaths, id: string): Promise<UploadLock> {
  const filename = uploadLockPath(paths, id)
  const marker = recoveryMarkerPath(paths, id)
  const nonce = randomBytes(16).toString('hex')
  const processInstanceNonce = context.processInstanceNonce || PROCESS_INSTANCE_NONCE
  const processStartIdentity = await ownProcessIdentity(context)
  const lockData = Buffer.from(JSON.stringify({ version: 1, pid: process.pid, processInstanceNonce,
    processStartIdentity, createdAt: new Date().toISOString(), nonce }), 'utf8')
  const temp = path.join(paths.incoming, `u-${id}.tmp`)
  let recoveredStaleOwner = false
  const recoverOrWait = async (filename: string): Promise<void> => {
    const owner = await readLockOwner(context, filename, processStartIdentity)
    if (owner.kind === 'stale') {
      if (filename === uploadLockPath(paths, id)) {
        recoveredStaleOwner = (await preserveStaleOwnerEvidence(context, paths, id, filename, processStartIdentity)) ||
          recoveredStaleOwner
      } else await removeRegularFile(filename)
      return
    }
    if (owner.kind === 'malformed') {
      let info
      try { info = await lstat(filename) } catch (error) { if (isNotFound(error)) return; fail('storage_unavailable', 503) }
      if (!info.isFile() || info.isSymbolicLink()) fail('upload_busy', 409)
      if (Date.now() - info.mtimeMs >= PORTAL_PAGE_UPLOAD_RETENTION_MS) {
        await removeRegularFile(filename)
        return
      }
      fail('upload_busy', 409)
    }
    fail('upload_busy', 409)
  }
  for (;;) {
    if (await assertRegularOrAbsent(filename)) {
      await recoverOrWait(filename)
      continue
    }
    if (await assertRegularOrAbsent(temp)) {
      await recoverOrWait(temp)
      continue
    }
    if (await assertRegularOrAbsent(marker)) {
      const owner = await readLockOwner(context, marker, processStartIdentity)
      if (owner.kind !== 'stale') fail('upload_busy', 409)
      recoveredStaleOwner = true
    }
    const published = await publishUploadLock(context, paths, filename, lockData, temp)
    if (published === 'exists') continue
    return { recoveredStaleOwner, release: async () => {
      const data = await readSmallRegularFile(filename, 1024)
      let lock: Record<string, unknown>
      try { lock = asRecord(JSON.parse(data.toString('utf8'))) } catch { fail('storage_unavailable', 503) }
      if (lock.nonce !== nonce || lock.processInstanceNonce !== processInstanceNonce || lock.processStartIdentity !== processStartIdentity) {
        fail('storage_unavailable', 503)
      }
      await removeRegularFile(filename)
      await syncDirectory(paths.incoming)
    } }
  }
}

function assertRowMatchesManifest(row: Record<string, unknown>, manifest: UploadManifest, actor: string): void {
  if (String(row.id).toLowerCase() !== manifest.id || row.uploadedBy !== manifest.actorUid || manifest.actorUid !== actor ||
    row.storageKey !== manifest.storageKey || row.mimeType !== manifest.mimeType || Number(row.filesize) !== manifest.bytes) fail('upload_not_found', 404)
}

async function getMediaRow(payload: Payload, req: PayloadRequest, id: string): Promise<Record<string, unknown> | null> {
  const result = await payload.findByID({ collection: PAGE_MEDIA_COLLECTION, id, req, overrideAccess: true, depth: 0, disableErrors: true }) as unknown
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  return result as Record<string, unknown>
}

function metadataFromRow(row: Record<string, unknown>) {
  try {
    return validatePortalPageMediaMetadata({
      originalName: row.originalName, storageKey: row.storageKey, mimeType: row.mimeType, filesize: row.filesize,
      sha256: row.sha256, state: row.state, uploadedBy: row.uploadedBy, completedAt: row.completedAt ?? null,
    })
  } catch { fail('upload_unavailable', 503) }
}

async function readUploadAdmission(context: MutationRequestContext, payload: Payload, req: PayloadRequest,
  actorUid: string, timestamp: number): Promise<UploadAdmissionStats> {
  if (context.readUploadAdmission) return context.readUploadAdmission(actorUid, timestamp)
  const db = await requireCmsTransaction(payload, req)
  const result = await db.execute(sql`SELECT id, uploaded_by, filesize FROM portal_page_media WHERE state = 'uploading' ORDER BY id LIMIT 9`)
  const rows = (result as unknown as { rows?: unknown[] }).rows
  if (!Array.isArray(rows) || rows.length > PORTAL_PAGE_UPLOAD_MAX_ACTIVE_GLOBAL) fail('upload_unavailable', 503)
  let reservedBytes = 0n
  let activeForActor = 0
  for (const raw of rows) {
    const row = asRecord(raw)
    if (typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.uploaded_by !== 'string') fail('upload_unavailable', 503)
    let bytes: bigint
    try { bytes = BigInt(String(row.filesize)); if (bytes < 1n || bytes > BigInt(500 * MiB)) fail('upload_unavailable', 503) }
    catch { fail('upload_unavailable', 503) }
    reservedBytes += bytes
    if (row.uploaded_by === actorUid) activeForActor++
  }
  return { activeForActor, activeGlobal: rows.length, reservedBytes }
}

async function freeBytesFromStatfs(directory: string): Promise<bigint> {
  try {
    const info = await statfs(directory, { bigint: true })
    return info.bavail * info.bsize
  } catch { fail('disk_unavailable', 507) }
}

async function verifyDiskReservation(context: MutationRequestContext, paths: StoredPaths,
  stats: UploadAdmissionStats, nextBytes: number): Promise<void> {
  let free: bigint
  try { free = await (context.statfsFreeBytes || freeBytesFromStatfs)(paths.incoming) }
  catch { fail('disk_unavailable', 507) }
  // Staging chunks and final assembly coexist until an atomic rename. Reserve both copies.
  const need = (stats.reservedBytes + BigInt(nextBytes)) * 2n + BigInt(PORTAL_PAGE_UPLOAD_MIN_FREE_BYTES)
  if (free < need) fail('insufficient_disk_space', 507)
}

function queryRows(result: unknown): Array<Record<string, unknown>> {
  const rows = result && typeof result === 'object' ? (result as { rows?: unknown }).rows : undefined
  if (!Array.isArray(rows)) fail('upload_unavailable', 503)
  return rows.map(asRecord)
}

function createDatabaseUploadCleanupAdapter(db: Awaited<ReturnType<typeof requireCmsTransaction>>): UploadQueueServiceAdapter {
  const savepoint = async <T>(name: 'pass' | 'item', work: () => Promise<T>): Promise<T> => {
    await db.execute(name === 'pass' ? sql`SAVEPOINT portal_page_upload_cleanup_pass` : sql`SAVEPOINT portal_page_upload_cleanup_item`)
    try {
      const result = await work()
      await db.execute(name === 'pass' ? sql`RELEASE SAVEPOINT portal_page_upload_cleanup_pass` : sql`RELEASE SAVEPOINT portal_page_upload_cleanup_item`)
      return result
    } catch (error) {
      try {
        await db.execute(name === 'pass' ? sql`ROLLBACK TO SAVEPOINT portal_page_upload_cleanup_pass` : sql`ROLLBACK TO SAVEPOINT portal_page_upload_cleanup_item`)
        await db.execute(name === 'pass' ? sql`RELEASE SAVEPOINT portal_page_upload_cleanup_pass` : sql`RELEASE SAVEPOINT portal_page_upload_cleanup_item`)
      } catch { /* The caller treats a failed rollback as a pass-level failure. */ }
      throw error
    }
  }
  const setDone = async (uploadID: string) => {
    await db.execute(sql`UPDATE portal_page_upload_cleanup SET status = 'done', next_attempt_at = NULL,
      last_error_code = NULL, updated_at = now() WHERE upload_id = ${uploadID}::uuid`)
  }
  return {
    withPassSavepoint: work => savepoint('pass', work),
    repairMissing: async (limit, timestamp) => queryRows(await db.execute(sql`
      WITH missing AS (
        SELECT media.id
        FROM portal_page_media AS media
        LEFT JOIN portal_page_upload_cleanup AS cleanup ON cleanup.upload_id = media.id
        WHERE cleanup.upload_id IS NULL
        ORDER BY media.id
        LIMIT ${limit}
      )
      INSERT INTO portal_page_upload_cleanup (upload_id, status, next_attempt_at)
      SELECT id, 'pending', ${new Date(timestamp)} FROM missing
      ON CONFLICT (upload_id) DO NOTHING
      RETURNING upload_id`)).length,
    claimDue: async (limit, timestamp) => queryRows(await db.execute(sql`
      SELECT upload_id, attempt_count, extract(epoch FROM next_attempt_at) * 1000 AS next_attempt_ms
      FROM portal_page_upload_cleanup
      WHERE status = 'pending' AND next_attempt_at <= ${new Date(timestamp)}
      ORDER BY next_attempt_at, upload_id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED`)).map(row => {
      const uploadID = typeof row.upload_id === 'string' ? row.upload_id.toLowerCase() : ''
      const attemptCount = Number(row.attempt_count)
      const nextAttemptAt = Number(row.next_attempt_ms)
      if (!UUID.test(uploadID) || !Number.isSafeInteger(attemptCount) || attemptCount < 0 || !Number.isFinite(nextAttemptAt)) {
        fail('upload_unavailable', 503)
      }
      return { uploadID, attemptCount, nextAttemptAt }
    }),
    withSavepoint: (_uploadID, work) => savepoint('item', work),
    markDone: setDone,
    remove: async uploadID => { await db.execute(sql`DELETE FROM portal_page_upload_cleanup WHERE upload_id = ${uploadID}::uuid`) },
    reschedule: async (uploadID, timestamp) => {
      await db.execute(sql`UPDATE portal_page_upload_cleanup SET status = 'pending', next_attempt_at = ${new Date(timestamp)},
        attempt_count = 0, last_error_code = NULL, updated_at = now() WHERE upload_id = ${uploadID}::uuid`)
    },
    defer: async (uploadID, attempts, code, timestamp) => {
      await db.execute(sql`UPDATE portal_page_upload_cleanup SET status = 'pending', next_attempt_at = ${new Date(timestamp)},
        attempt_count = ${Math.min(attempts, 2_147_483_647)}, last_error_code = ${code}, updated_at = now()
        WHERE upload_id = ${uploadID}::uuid`)
    },
    enqueue: async (uploadID, timestamp) => {
      await db.execute(sql`INSERT INTO portal_page_upload_cleanup (upload_id, status, next_attempt_at)
        VALUES (${uploadID}::uuid, 'pending', ${new Date(timestamp)})
        ON CONFLICT (upload_id) DO UPDATE SET
          status = CASE WHEN portal_page_upload_cleanup.status = 'done' THEN 'done' ELSE 'pending' END,
          next_attempt_at = CASE WHEN portal_page_upload_cleanup.status = 'done' THEN NULL
            ELSE LEAST(portal_page_upload_cleanup.next_attempt_at, EXCLUDED.next_attempt_at) END,
          updated_at = now()`)
    },
    schedule: async (uploadID, timestamp) => {
      await db.execute(sql`UPDATE portal_page_upload_cleanup SET status = 'pending', next_attempt_at = ${new Date(timestamp)},
        last_error_code = NULL, updated_at = now() WHERE upload_id = ${uploadID}::uuid`)
    },
  }
}

function uploadCleanupAdapter(context: MutationRequestContext, db: Awaited<ReturnType<typeof requireCmsTransaction>>) {
  return context.cleanupQueueAdapter?.(db) || createDatabaseUploadCleanupAdapter(db)
}

async function fileExistsRegular(filename: string): Promise<boolean> { return assertRegularOrAbsent(filename) }

async function readFileRange(filename: string, position: number, length: number, minSize = 0): Promise<Buffer> {
  let handle
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const info = await handle.stat()
    if (!info.isFile() || info.size < minSize) fail('invalid_media_file', 400)
    const available = Math.max(0, Math.min(length, info.size - position))
    const buffer = Buffer.alloc(available)
    let offset = 0
    while (offset < available) {
      const result = await handle.read(buffer, offset, available - offset, position + offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    return offset === buffer.length ? buffer : buffer.subarray(0, offset)
  } catch (error) {
    if (error instanceof PortalPageUploadError) throw error
    throw new PortalPageUploadError('storage_unavailable', 503)
  } finally { await handle?.close().catch(() => {}) }
}

function webmHasDocType(header: Buffer): boolean {
  if (header.length < 8 || !header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return false
  const vint = (offset: number, keepMarker = false) => {
    const first = header[offset]
    if (first === undefined || first === 0) return null
    let width = 1, mask = 128
    while (!(first & mask) && width <= 8) { width++; mask >>= 1 }
    if (width > 4 || offset + width > header.length) return null
    let value = keepMarker ? first : first & (mask - 1)
    for (let i = 1; i < width; i++) value = value * 256 + header[offset + i]!
    return { value, width }
  }
  const headerSize = vint(4)
  if (!headerSize || headerSize.value > 4096) return false
  const end = 4 + headerSize.width + headerSize.value
  if (end > header.length) return false
  let offset = 4 + headerSize.width, found = false
  while (offset < end) {
    const id = vint(offset, true)
    if (!id) return false
    offset += id.width
    const size = vint(offset)
    if (!size) return false
    offset += size.width
    if (offset + size.value > end) return false
    if (id.value === 0x4282) found = size.value === 4 && header.subarray(offset, offset + 4).equals(Buffer.from([0x77, 0x65, 0x62, 0x6d]))
    offset += size.value
  }
  return offset === end && found
}

async function validateMediaFile(filename: string, mimeType: UploadManifest['mimeType'], bytes: number): Promise<void> {
  if (mimeType.startsWith('image/')) {
    if (bytes > 15 * MiB) fail('invalid_media_file', 400)
    const data = await readSmallRegularFile(filename, 15 * MiB)
    const validSignature = mimeType === 'image/jpeg' ? data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) :
      mimeType === 'image/png' ? data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) :
        data.length >= 20 && data.subarray(0, 4).equals(Buffer.from([0x52, 0x49, 0x46, 0x46])) &&
          data.subarray(8, 12).equals(Buffer.from([0x57, 0x45, 0x42, 0x50])) &&
          data.readUInt32LE(4) + 8 === data.length
    if (!validSignature) fail('invalid_media_file', 400)
    try {
      const image = sharp(data, { limitInputPixels: MAX_IMAGE_PIXELS, animated: true, failOn: 'warning' })
      const metadata = await image.metadata()
      if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_IMAGE_PIXELS) fail('invalid_media_file', 400)
      await image.stats()
    } catch (error) {
      if (error instanceof PortalPageUploadError) throw error
      fail('invalid_media_file', 400)
    }
    return
  }
  if (mimeType === 'application/pdf') {
    const head = await readFileRange(filename, 0, 16, 5)
    const tail = await readFileRange(filename, Math.max(0, bytes - 1024), Math.min(bytes, 1024), 5)
    let eofAt = tail.lastIndexOf(PDF_EOF)
    if (!head.subarray(0, PDF_HEADER.length).equals(PDF_HEADER) || eofAt < 0) fail('invalid_media_file', 400)
    for (let index = eofAt + PDF_EOF.length; index < tail.length; index++) {
      const byte = tail[index]!
      if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d && byte !== 0x20) fail('invalid_media_file', 400)
    }
    return
  }
  const header = await readFileRange(filename, 0, Math.min(bytes, 4096), 8)
  if (mimeType === 'video/mp4') {
    if (header.length < 16 || !header.subarray(4, 8).equals(Buffer.from([0x66, 0x74, 0x79, 0x70]))) fail('invalid_media_file', 400)
    const boxSize = header.readUInt32BE(0)
    const brand = header.subarray(8, 12).toString('hex')
    if (boxSize < 16 || boxSize > 4096 || boxSize > bytes || boxSize % 4 !== 0 || !MP4_BRANDS.has(brand)) fail('invalid_media_file', 400)
    return
  }
  if (mimeType === 'video/webm' && webmHasDocType(header)) return
  fail('invalid_media_file', 400)
}

async function createReadStreamSafe(filename: string): Promise<NodeReadable> {
  if (!(await assertRegularOrAbsent(filename))) fail('upload_incomplete', 409)
  let handle
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const info = await handle.stat()
    if (!info.isFile()) fail('upload_incomplete', 409)
    return handle.createReadStream({ autoClose: true, highWaterMark: STREAM_HIGH_WATER_MARK })
  } catch (error) {
    await handle?.close().catch(() => {})
    if (error instanceof PortalPageUploadError) throw error
    throw new PortalPageUploadError('storage_unavailable', 503)
  }
}

async function createDiscardSink(): Promise<Writable> {
  return new Writable({ highWaterMark: STREAM_HIGH_WATER_MARK, write(_chunk, _encoding, callback) { callback() } })
}

function createFileHandleSink(context: MutationRequestContext, handle: FileHandle, purpose: WritePurpose): Writable {
  return new Writable({ highWaterMark: STREAM_HIGH_WATER_MARK, write(chunk: Buffer | Uint8Array, _encoding, callback) {
    void writeFileBytes(context, handle, chunk, purpose).then(() => callback(), error => callback(error as Error))
  } })
}

async function hashRegularFile(filename: string, expectedBytes: number): Promise<string> {
  const source = await createReadStreamSafe(filename)
  return (await streamPortalPageBytes([source], await createDiscardSink(), expectedBytes)).sha256
}

async function inspectChunkSet(paths: StoredPaths, manifest: UploadManifest): Promise<void> {
  for (let index = 0; index < manifest.chunkCount; index++) {
    const expected = expectedPortalPageUploadChunkBytes(manifest.bytes, manifest.chunkCount, index)
    const filename = chunkPath(paths, manifest.id, index)
    let info
    try { info = await lstat(filename) } catch (error) { if (isNotFound(error)) fail('upload_incomplete', 409); fail('storage_unavailable', 503) }
    if (!info.isFile() || info.isSymbolicLink() || info.size !== expected ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) fail('upload_incomplete', 409)
    const partial = chunkPartPath(paths, manifest.id, index)
    if (await assertRegularOrAbsent(partial)) await removeRegularFile(partial)
  }
}

async function assembleChunks(context: MutationRequestContext, paths: StoredPaths, manifest: UploadManifest): Promise<string> {
  const partial = assembledPartPath(paths, manifest.id)
  if (await assertRegularOrAbsent(partial)) await removeRegularFile(partial)
  const sourceStreams: NodeReadable[] = []
  for (let index = 0; index < manifest.chunkCount; index++) {
    const filename = chunkPath(paths, manifest.id, index)
    const stream = await createReadStreamSafe(filename)
    sourceStreams.push(stream)
  }
  let output
  try {
    output = await open(partial, 'wx', 0o600)
    const result = await streamPortalPageBytes(sourceStreams, createFileHandleSink(context, output, 'assembly'), manifest.bytes)
    await output.sync()
    await output.close(); output = undefined
    if (result.bytes !== manifest.bytes) fail('invalid_chunk_size', 400)
    await syncDirectory(paths.incoming)
    await validateMediaFile(partial, manifest.mimeType, manifest.bytes)
    return result.sha256
  } catch (error) {
    await output?.close().catch(() => {})
    await Promise.all(sourceStreams.map(stream => { stream.destroy(); return Promise.resolve() }))
    if (error instanceof PortalPageUploadError) throw error
    fail('storage_unavailable', 503)
  }
}

async function verifyReadyFile(paths: StoredPaths, manifest: UploadManifest, filename: string): Promise<void> {
  if (!manifest.finalSha256 || !(await fileExistsRegular(filename))) fail('upload_unavailable', 503)
  const info = await stat(filename)
  if (!info.isFile() || info.size !== manifest.bytes) fail('upload_unavailable', 503)
  const hash = await hashRegularFile(filename, manifest.bytes)
  if (hash !== manifest.finalSha256) fail('upload_unavailable', 503)
  await validateMediaFile(filename, manifest.mimeType, manifest.bytes)
}

async function cleanupIncoming(paths: StoredPaths, manifest: UploadManifest, removeFinal = false, storageKey?: string,
  preserveManifest = false): Promise<void> {
  const target = removeFinal && storageKey ? finalPath(paths, storageKey) : undefined
  if (target && await fileExistsRegular(target)) {
    if (!manifest.finalSha256) fail('upload_unavailable', 503)
    await verifyReadyFile(paths, manifest, target)
  }
  for (let index = 0; index < manifest.chunkCount; index++) {
    await removeRegularFile(chunkPath(paths, manifest.id, index))
    await removeRegularFile(chunkPartPath(paths, manifest.id, index))
  }
  await removeRegularFile(assembledPartPath(paths, manifest.id))
  await removeRegularFile(manifestTempPath(paths, manifest.id))
  if (target) await removeRegularFile(target)
  if (!preserveManifest) await removeRegularFile(manifestPath(paths, manifest.id))
  await syncDirectory(paths.incoming)
  if (removeFinal) await syncDirectory(paths.pages)
}

async function reconcileStaleManifestPartials(paths: StoredPaths, manifest: UploadManifest,
  ownership: UploadLock): Promise<void> {
  if (!ownership.recoveredStaleOwner) return
  if (!UUID.test(manifest.id) || !Number.isSafeInteger(manifest.chunkCount) || manifest.chunkCount < 1 ||
    manifest.chunkCount > PORTAL_PAGE_UPLOAD_MAX_CHUNKS) fail('upload_unavailable', 503)

  for (let index = 0; index < manifest.chunkCount; index++) {
    const partial = chunkPartPath(paths, manifest.id, index)
    if (await assertRegularOrAbsent(partial)) await removeRegularFile(partial)
  }
  const manifestTemp = manifestTempPath(paths, manifest.id)
  if (await assertRegularOrAbsent(manifestTemp)) await removeRegularFile(manifestTemp)
  // During assembly this file is incomplete and can be rebuilt from canonical
  // chunks. Once ready_to_rename/renamed it is a validated recovery source.
  if (manifest.state === 'receiving' || manifest.state === 'assembling') {
    const assembled = assembledPartPath(paths, manifest.id)
    if (await assertRegularOrAbsent(assembled)) await removeRegularFile(assembled)
  }

  // Persist exact-part removals before clearing the recovery marker. If any
  // validation/removal/sync fails, the marker remains for a bounded retry.
  await syncDirectory(paths.incoming)
  await removeRegularFile(recoveryMarkerPath(paths, manifest.id))
  await syncDirectory(paths.incoming)
  ownership.recoveredStaleOwner = false
}

async function clearStaleRecoveryMarker(paths: StoredPaths, id: string, ownership: UploadLock): Promise<void> {
  if (!ownership.recoveredStaleOwner) return
  await removeRegularFile(recoveryMarkerPath(paths, id))
  await syncDirectory(paths.incoming)
  ownership.recoveredStaleOwner = false
}

async function writeRequestToFile(context: MutationRequestContext, body: Readable, destination: string,
  expectedBytes: number, onCreated?: () => void): Promise<{ bytes: number; sha256: string }> {
  let handle
  let created = false
  try {
    handle = await open(destination, 'wx', 0o600)
    created = true
    onCreated?.()
    const result = await streamPortalPageBytes([body], createFileHandleSink(context, handle, 'chunk'), expectedBytes)
    await handle.sync()
    await handle.close(); handle = undefined
    return result
  } catch (error) {
    await handle?.close().catch(() => {})
    if (created) await removeRegularFile(destination).catch(() => {})
    body.destroy()
    if (error instanceof PortalPageUploadError) throw error
    fail('storage_unavailable', 503)
  }
}

function requestBodyStream(body: ReadableStream<Uint8Array> | null | undefined): NodeReadable {
  if (!body) fail('invalid_request', 400)
  return Readable.fromWeb(body as never)
}

function validateChunkRequest(contentType: string | null, contentLength: string | null, expected: number): void {
  if (contentType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/octet-stream') fail('invalid_request', 400)
  if (contentLength !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) !== expected)) fail('invalid_chunk_size', 400)
}

function bodyToken(value: unknown): string {
  const data = asRecord(value)
  exactKeys(data, ['token'])
  if (typeof data.token !== 'string') fail('invalid_request', 400)
  return data.token
}

async function validateAuthorizedUpload(paths: StoredPaths, id: string, token: unknown, actor: string,
  row: Record<string, unknown>): Promise<{ manifest: UploadManifest; metadata: ReturnType<typeof metadataFromRow> }> {
  const manifest = await readManifest(paths, id)
  if (!verifyPortalPageUploadToken(token, manifest.tokenHash)) fail('invalid_upload_token', 403)
  assertRowMatchesManifest(row, manifest, actor)
  const metadata = metadataFromRow(row)
  return { manifest, metadata }
}

function assertInitCleanup(cleanup: FreshPortalPageUploadState['cleanup'], initialTimestamp: number,
  confirmationTimestamp: number): void {
  if (!cleanup || cleanup.status !== 'pending' || cleanup.nextAttemptAt === null) fail('upload_unavailable', 503)
  if (cleanup.attemptCount === 0 && cleanup.nextAttemptAt === initialTimestamp && cleanup.lastErrorCode === null) return
  // Cleanup may observe the committed-init/pre-manifest bridge while init owns
  // the filesystem lock. A bounded sanitized retry is valid queue state, not a
  // failed enqueue or permission to publish without a durable queue record.
  if (cleanup.attemptCount > 0 && cleanup.attemptCount <= 2_147_483_647 &&
    cleanup.nextAttemptAt >= initialTimestamp &&
    cleanup.nextAttemptAt <= confirmationTimestamp + portalPageUploadRetryDelay(cleanup.attemptCount) &&
    cleanup.lastErrorCode === 'cleanup_failed') return
  fail('upload_unavailable', 503)
}

function assertCleanupMatches(actual: PortalPageUploadCleanupState | null,
  expected: PortalPageUploadCleanupState | null | undefined): void {
  if (!actual || !expected || actual.status !== expected.status || actual.attemptCount !== expected.attemptCount ||
    actual.nextAttemptAt !== expected.nextAttemptAt || actual.lastErrorCode !== expected.lastErrorCode) fail('upload_unavailable', 503)
}

function assertFreshUploadingRow(state: FreshPortalPageUploadState, expected: {
  id: string; actor: string; storageKey: string; originalName: string; mimeType: string; bytes: number
}): void {
  if (!state.media) fail('upload_unavailable', 503)
  const metadata = metadataFromRow(state.media)
  if (String(state.media.id).toLowerCase() !== expected.id || metadata.uploadedBy !== expected.actor ||
    metadata.storageKey !== expected.storageKey || metadata.originalName !== expected.originalName ||
    metadata.mimeType !== expected.mimeType || metadata.filesize !== expected.bytes || metadata.state !== 'uploading' ||
    metadata.sha256 !== null || metadata.completedAt !== null) fail('upload_unavailable', 503)
}

function assertFreshCompleteRow(state: FreshPortalPageUploadState, manifest: UploadManifest, actor: string,
  sha256: string, completedAt: string): void {
  if (!state.media) fail('upload_unavailable', 503)
  const metadata = metadataFromRow(state.media)
  if (String(state.media.id).toLowerCase() !== manifest.id || metadata.uploadedBy !== actor ||
    metadata.storageKey !== manifest.storageKey || metadata.mimeType !== manifest.mimeType ||
    metadata.filesize !== manifest.bytes || metadata.state !== 'complete' ||
    metadata.sha256 !== sha256 || metadata.completedAt !== completedAt) fail('upload_unavailable', 503)
}

/** Private, editor-only upload lifecycle. No path or raw credential enters a response. */
export function createPortalPageUploadService(context: MutationRequestContext) {
  const actor = actorUID(context.actorUid)
  const now = context.now || Date.now
  const pathsPromise = ensureStorage(context.uploadDir)
  const getPathsReady = () => pathsPromise
  const standaloneRequest = (request: PayloadRequest) => ({ ...request, transactionID: undefined,
    context: { ...request.context } }) as PayloadRequest
  const readFreshState = async (id: string): Promise<FreshPortalPageUploadState> => {
    try { return await readFreshPortalPageUploadState(context.payload, context.req, id) }
    catch { fail('upload_unavailable', 503) }
  }

  async function assertCancelledArtifactsRemoved(paths: StoredPaths, manifest: UploadManifest): Promise<void> {
    for (let index = 0; index < manifest.chunkCount; index++) {
      if (await fileExistsRegular(chunkPath(paths, manifest.id, index)) ||
        await fileExistsRegular(chunkPartPath(paths, manifest.id, index))) fail('upload_unavailable', 503)
    }
    if (await fileExistsRegular(assembledPartPath(paths, manifest.id)) ||
      await fileExistsRegular(manifestPath(paths, manifest.id)) ||
      await fileExistsRegular(manifestTempPath(paths, manifest.id)) ||
      await fileExistsRegular(finalPath(paths, manifest.storageKey))) fail('upload_unavailable', 503)
  }

  async function removeUnmanifestedArtifacts(paths: StoredPaths, id: string): Promise<void> {
    for (let index = 0; index < PORTAL_PAGE_UPLOAD_MAX_CHUNKS; index++) {
      await removeRegularFile(chunkPath(paths, id, index))
      await removeRegularFile(chunkPartPath(paths, id, index))
    }
    await removeRegularFile(assembledPartPath(paths, id))
    await removeRegularFile(manifestTempPath(paths, id))
    await syncDirectory(paths.incoming)
  }

  async function reconcileQueuedUpload(transactionReq: PayloadRequest, paths: StoredPaths, id: string, timestamp: number) {
    await lockPortalPageUpload(context.payload, transactionReq, id)
    const lock = await acquireUploadLock(context, paths, id)
    try {
      const row = await getMediaRow(context.payload, transactionReq, id)
      const manifestPresent = await fileExistsRegular(manifestPath(paths, id))
      if (!manifestPresent) {
        if (row) {
          const metadata = metadataFromRow(row)
          if (metadata.state === 'complete') {
            if (!metadata.sha256 || !metadata.completedAt) fail('upload_unavailable', 503)
            const target = finalPath(paths, metadata.storageKey)
            if (!(await fileExistsRegular(target))) fail('upload_unavailable', 503)
            const info = await stat(target).catch(() => null)
            if (!info?.isFile() || info.size !== metadata.filesize ||
              await hashRegularFile(target, metadata.filesize) !== metadata.sha256) fail('upload_unavailable', 503)
            await validateMediaFile(target, metadata.mimeType, metadata.filesize)
            const expiresAt = Date.parse(metadata.completedAt) + PORTAL_PAGE_UPLOAD_RETENTION_MS
            if (timestamp < expiresAt) return { done: false as const, nextAttemptAt: expiresAt }
            await removeUnmanifestedArtifacts(paths, id)
            await clearStaleRecoveryMarker(paths, id, lock)
            return { done: true as const }
          }
          const target = finalPath(paths, metadata.storageKey)
          if (await fileExistsRegular(target)) fail('upload_unavailable', 503)
          await removeUnmanifestedArtifacts(paths, id)
          await clearStaleRecoveryMarker(paths, id, lock)
          await context.payload.delete({ collection: PAGE_MEDIA_COLLECTION, id, req: transactionReq, overrideAccess: true })
        } else {
          await removeUnmanifestedArtifacts(paths, id)
          await clearStaleRecoveryMarker(paths, id, lock)
        }
        return { done: true as const, remove: true }
      }

      const manifest = await readManifest(paths, id)
      await reconcileStaleManifestPartials(paths, manifest, lock)
      const age = timestamp - Date.parse(manifest.createdAt)
      const expiresAt = Date.parse(manifest.createdAt) + PORTAL_PAGE_UPLOAD_RETENTION_MS
      if (!Number.isFinite(expiresAt)) fail('upload_unavailable', 503)

      if (!row) {
        if (manifest.state === 'cancelling') {
          await cleanupIncoming(paths, manifest, true, manifest.storageKey)
          return { done: true as const, remove: true }
        }
        const target = finalPath(paths, manifest.storageKey)
        if (await fileExistsRegular(target)) fail('upload_unavailable', 503)
        if (manifest.state === 'receiving' || manifest.state === 'assembling') {
          await cleanupIncoming(paths, manifest)
          return { done: true as const, remove: true }
        }
        // A promoted file without a matching metadata row must not be deleted or orphaned silently.
        fail('upload_unavailable', 503)
      }

      const metadata = metadataFromRow(row)
      assertRowMatchesManifest(row, manifest, manifest.actorUid)
      if (metadata.state === 'complete') {
        if ((manifest.state !== 'renamed' && manifest.state !== 'ready_to_rename') ||
          metadata.sha256 !== manifest.finalSha256 || metadata.storageKey !== manifest.storageKey) fail('upload_unavailable', 503)
        await verifyReadyFile(paths, manifest, finalPath(paths, metadata.storageKey))
        const completedAt = metadata.completedAt ? Date.parse(metadata.completedAt) : Number.NaN
        if (!Number.isFinite(completedAt)) fail('upload_unavailable', 503)
        const completeExpiresAt = completedAt + PORTAL_PAGE_UPLOAD_RETENTION_MS
        if (timestamp >= completeExpiresAt) {
          await cleanupIncoming(paths, manifest, false, metadata.storageKey)
          return { done: true as const }
        }
        await cleanupIncoming(paths, manifest, false, metadata.storageKey, true)
        return { done: false as const, nextAttemptAt: Math.max(timestamp + 1, completeExpiresAt) }
      }

      if (metadata.state !== 'uploading' || metadata.uploadedBy !== manifest.actorUid) fail('upload_unavailable', 503)
      if (manifest.state === 'cancelling') {
        await cleanupIncoming(paths, manifest, true, metadata.storageKey)
        await context.payload.delete({ collection: PAGE_MEDIA_COLLECTION, id, req: transactionReq, overrideAccess: true })
        return { done: true as const, remove: true }
      }

      if (manifest.state === 'ready_to_rename' || manifest.state === 'renamed') {
        if (!manifest.finalSha256) fail('upload_unavailable', 503)
        const target = finalPath(paths, metadata.storageKey)
        if (await fileExistsRegular(target)) await verifyReadyFile(paths, manifest, target)
        else {
          const partial = assembledPartPath(paths, id)
          await verifyReadyFile(paths, manifest, partial)
          await rename(partial, target)
          await syncDirectory(paths.incoming)
          await syncDirectory(paths.pages)
        }
        const renamed = { ...manifest, state: 'renamed' as const }
        if (manifest.state !== 'renamed') await writeManifest(context, paths, renamed)
        const completedAt = new Date(timestamp).toISOString()
        await context.payload.update({ collection: PAGE_MEDIA_COLLECTION, id, req: transactionReq, overrideAccess: true,
          data: { state: 'complete', sha256: renamed.finalSha256, completedAt } })
        await cleanupIncoming(paths, renamed, false, metadata.storageKey, true)
        return { done: false as const, nextAttemptAt: timestamp + PORTAL_PAGE_UPLOAD_RETENTION_MS }
      }

      if (age >= PORTAL_PAGE_UPLOAD_RETENTION_MS) {
        const cancelling = { ...manifest, state: 'cancelling' as const }
        await writeManifest(context, paths, cancelling)
        await cleanupIncoming(paths, cancelling, true, metadata.storageKey)
        await context.payload.delete({ collection: PAGE_MEDIA_COLLECTION, id, req: transactionReq, overrideAccess: true })
        return { done: true as const, remove: true }
      }
      if (!Number.isFinite(expiresAt) || expiresAt <= timestamp) fail('upload_unavailable', 503)
      return { done: false as const, nextAttemptAt: expiresAt }
    } finally { await lock.release() }
  }

  async function cleanupExpired(request: PayloadRequest = context.req): Promise<{ removed: number; unresolved: number }> {
    const paths = await getPathsReady()
    try {
      return await withPortalPageMediaLifecycleMutation(request, actor, async transactionReq => {
        const db = await requireCmsTransaction(context.payload, transactionReq)
        const adapter = uploadCleanupAdapter(context, db)
        const result = await processPortalPageUploadCleanupBatch(adapter,
          (id, timestamp) => reconcileQueuedUpload(transactionReq, paths, id, timestamp), now())
        return { removed: result.done, unresolved: result.deferred }
      })
    } catch { return { removed: 0, unresolved: 1 } }
  }

  async function init(value: unknown) {
    const input = validatePortalPageUploadInit(value)
    const paths = await getPathsReady()
    // Init must own the transaction commit so filesystem ownership can bridge
    // the commit-to-manifest window instead of joining a caller-owned session.
    const initRequest = standaloneRequest(context.req)
    await cleanupExpired(initRequest).catch(() => {})
    const token = randomBytes(32).toString('base64url')
    const timestampMs = now()
    const timestamp = new Date(timestampMs).toISOString()
    let createdID: string | undefined
    let createdStorageKey: string | undefined
    let ownership: UploadLock | undefined
    try {
      await withPortalPageMediaMutation(initRequest, actor, 'create', async transactionReq => {
        const stats = await readUploadAdmission(context, context.payload, transactionReq, actor, timestampMs)
        if (stats.activeForActor >= PORTAL_PAGE_UPLOAD_MAX_ACTIVE_PER_ACTOR || stats.activeGlobal >= PORTAL_PAGE_UPLOAD_MAX_ACTIVE_GLOBAL) {
          fail('upload_limit_reached', 429)
        }
        await verifyDiskReservation(context, paths, stats, input.bytes)
        const created = await context.payload.create({ collection: PAGE_MEDIA_COLLECTION, req: transactionReq, overrideAccess: true,
          data: { originalName: input.originalName, mimeType: input.mimeType, filesize: input.bytes, sha256: null,
            state: 'uploading', completedAt: null } as never }) as unknown as Record<string, unknown>
        const id = validatedID(created.id)
        createdID = id
        const metadata = metadataFromRow({ ...created, id })
        if (metadata.state !== 'uploading' || metadata.uploadedBy !== actor || metadata.sha256 !== null ||
          metadata.mimeType !== input.mimeType || metadata.filesize !== input.bytes) fail('upload_unavailable', 503)
        createdStorageKey = metadata.storageKey
        await lockPortalPageUpload(context.payload, transactionReq, id)
        ownership = await acquireUploadLock(context, paths, id)
        const db = await requireCmsTransaction(context.payload, transactionReq)
        await uploadCleanupAdapter(context, db).enqueue(id, timestampMs)
        return id
      })
      if (!createdID || !createdStorageKey || !ownership) fail('upload_unavailable', 503)
      const confirmed = await readFreshState(createdID)
      assertFreshUploadingRow(confirmed, { id: createdID, actor, storageKey: createdStorageKey,
        originalName: input.originalName, mimeType: input.mimeType, bytes: input.bytes })
      assertInitCleanup(confirmed.cleanup, timestampMs, now())
      const manifest: UploadManifest = {
        version: 1, id: createdID, storageKey: createdStorageKey, actorUid: actor,
        mimeType: input.mimeType, bytes: input.bytes, chunkSize: PORTAL_PAGE_UPLOAD_CHUNK_SIZE,
        chunkCount: input.chunkCount, createdAt: timestamp, tokenHash: tokenHash(token), state: 'receiving',
      }
      try {
        await writeManifest(context, paths, manifest)
        await reconcileStaleManifestPartials(paths, manifest, ownership)
      } catch (error) {
        await ownership.release()
        ownership = undefined
        try {
          await withPortalPageMediaLifecycleMutation(initRequest, actor, async transactionReq => {
            await lockPortalPageUpload(context.payload, transactionReq, createdID!)
            const compensationLock = await acquireUploadLock(context, paths, createdID!)
            try {
              await removeRegularFile(manifestTempPath(paths, createdID!))
              await removeRegularFile(manifestPath(paths, createdID!))
              await removeUnmanifestedArtifacts(paths, createdID!)
              await clearStaleRecoveryMarker(paths, createdID!, compensationLock)
              const row = await getMediaRow(context.payload, transactionReq, createdID!)
              if (row) await context.payload.delete({ collection: PAGE_MEDIA_COLLECTION, id: createdID!, req: transactionReq, overrideAccess: true })
              const db = await requireCmsTransaction(context.payload, transactionReq)
              await uploadCleanupAdapter(context, db).remove(createdID!)
            } finally { await compensationLock.release() }
          })
        } catch { /* The durable queue reconciles an unconfirmed manifest/row compensation. */ }
        throw error
      }
      return { id: createdID, token, chunkSize: PORTAL_PAGE_UPLOAD_CHUNK_SIZE, chunkCount: input.chunkCount,
        bytes: input.bytes, mimeType: input.mimeType }
    } finally { await ownership?.release() }
  }

  async function putChunk(rawID: unknown, rawIndex: unknown, headers: Headers, body: ReadableStream<Uint8Array> | null | undefined) {
    const token = headers.get('x-portal-page-upload-token')
    const id = validatedID(rawID)
    if (typeof rawIndex !== 'string' || !/^(?:0|[1-9][0-9]{0,1})$/u.test(rawIndex)) fail('invalid_chunk', 400)
    const index = Number(rawIndex)
    const paths = await getPathsReady()
    let ownership: UploadLock | undefined
    let partialOwned = false
    const partial = chunkPartPath(paths, id, index)
    const destination = chunkPath(paths, id, index)
    try {
      // Phase A: authorize and take short-lived database locks, then acquire
      // filesystem ownership before committing the phase and releasing DB locks.
      const phaseA = await withCmsTransaction(context.payload, standaloneRequest(context.req), async transactionReq => {
        await lockPortalPageUpload(context.payload, transactionReq, id)
        const manifest = await readManifest(paths, id)
        if (!verifyPortalPageUploadToken(token, manifest.tokenHash)) fail('invalid_upload_token', 403)
        if (manifest.actorUid !== actor || manifest.state !== 'receiving') fail('upload_not_found', 404)
        const row = await getMediaRow(context.payload, transactionReq, id)
        if (!row) fail('upload_not_found', 404)
        const metadata = metadataFromRow(row)
        assertRowMatchesManifest(row, manifest, actor)
        if (metadata.state !== 'uploading') fail('upload_not_found', 404)
        const expected = expectedPortalPageUploadChunkBytes(manifest.bytes, manifest.chunkCount, index)
        validateChunkRequest(headers.get('content-type'), headers.get('content-length'), expected)
        const lock = await acquireUploadLock(context, paths, id)
        try {
          await reconcileStaleManifestPartials(paths, manifest, lock)
          return { manifest, expected, originalName: metadata.originalName, lock }
        } catch (error) {
          await lock.release()
          throw error
        }
      })
      ownership = phaseA.lock

      // Phase B: consume the potentially slow request body with no DB session or
      // advisory lock. Only an exact stale-owner-recovered .part may be cleared.
      if (await assertRegularOrAbsent(partial)) {
        if (!ownership.recoveredStaleOwner) fail('upload_busy', 409)
        await removeRegularFile(partial)
        await syncDirectory(paths.incoming)
      }
      const source = requestBodyStream(body)
      const incoming = await writeRequestToFile(context, source, partial, phaseA.expected, () => { partialOwned = true })

      // Phase C: revalidate under short DB locks, then compare or atomically
      // promote the request-owned partial while filesystem ownership remains held.
      const promoted = await withCmsTransaction(context.payload, standaloneRequest(context.req), async transactionReq => {
        await lockPortalPageUpload(context.payload, transactionReq, id)
        const manifest = await readManifest(paths, id)
        if (!verifyPortalPageUploadToken(token, manifest.tokenHash)) fail('invalid_upload_token', 403)
        if (manifest.actorUid !== actor || manifest.state !== 'receiving' || manifest.id !== phaseA.manifest.id ||
          manifest.storageKey !== phaseA.manifest.storageKey || manifest.bytes !== phaseA.manifest.bytes ||
          manifest.mimeType !== phaseA.manifest.mimeType || manifest.chunkCount !== phaseA.manifest.chunkCount) {
          fail('upload_not_found', 404)
        }
        const row = await getMediaRow(context.payload, transactionReq, id)
        if (!row) fail('upload_not_found', 404)
        const metadata = metadataFromRow(row)
        assertRowMatchesManifest(row, manifest, actor)
        if (metadata.state !== 'uploading' ||
          expectedPortalPageUploadChunkBytes(manifest.bytes, manifest.chunkCount, index) !== phaseA.expected) fail('upload_not_found', 404)

        const partialInfo = await lstat(partial).catch(() => null)
        if (!partialInfo?.isFile() || partialInfo.isSymbolicLink() || partialInfo.size !== phaseA.expected ||
          (process.platform !== 'win32' && (partialInfo.mode & 0o077) !== 0)) fail('invalid_chunk_size', 400)
        if (await fileExistsRegular(destination)) {
          const existingHash = await hashRegularFile(destination, phaseA.expected)
          if (existingHash !== incoming.sha256) fail('chunk_conflict', 409)
          await removeRegularFile(partial)
          partialOwned = false
          await syncDirectory(paths.incoming)
          return { duplicate: true as const }
        }
        if (await hashRegularFile(partial, phaseA.expected) !== incoming.sha256) fail('storage_unavailable', 503)
        await rename(partial, destination)
        partialOwned = false
        await syncDirectory(paths.incoming)
        return { duplicate: false as const }
      })

      const confirmed = await readFreshState(id)
      assertFreshUploadingRow(confirmed, { id, actor, storageKey: phaseA.manifest.storageKey,
        originalName: phaseA.originalName, mimeType: phaseA.manifest.mimeType, bytes: phaseA.manifest.bytes })
      if (!confirmed.cleanup || confirmed.cleanup.status !== 'pending' || !(await fileExistsRegular(destination))) {
        fail('upload_unavailable', 503)
      }
      const destinationInfo = await stat(destination).catch(() => null)
      if (!destinationInfo?.isFile() || destinationInfo.size !== phaseA.expected ||
        await hashRegularFile(destination, phaseA.expected) !== incoming.sha256) fail('upload_unavailable', 503)
      return { id, index, received: true, duplicate: promoted.duplicate,
        ...(promoted.duplicate ? {} : { sha256: incoming.sha256 }) }
    } finally {
      if (partialOwned) await removeRegularFile(partial).catch(() => {})
      await ownership?.release()
    }
  }

  async function complete(rawID: unknown, rawToken: unknown) {
    const id = validatedID(rawID)
    const token = bodyToken(rawToken)
    const paths = await getPathsReady()
    const initialManifest = await readManifest(paths, id)
    if (!verifyPortalPageUploadToken(token, initialManifest.tokenHash)) fail('invalid_upload_token', 403)
    if (initialManifest.actorUid !== actor) fail('upload_not_found', 404)
    let lock: UploadLock | undefined
    let completedManifest: UploadManifest | undefined
    let storageKey: string | undefined
    let expectedCleanupState: PortalPageUploadCleanupState | null | undefined
    let result: { id: string; state: 'complete'; mimeType: string; bytes: number; sha256: string; completedAt: string } | undefined
    try {
      result = await withPortalPageMediaMutation(standaloneRequest(context.req), actor, 'update', async transactionReq => {
        await lockPortalPageUpload(context.payload, transactionReq, id)
        const ownership = await acquireUploadLock(context, paths, id)
        lock = ownership
        const row = await getMediaRow(context.payload, transactionReq, id)
        if (!row) fail('upload_not_found', 404)
        const { manifest, metadata } = await validateAuthorizedUpload(paths, id, token, actor, row)
        await reconcileStaleManifestPartials(paths, manifest, ownership)
        storageKey = metadata.storageKey
        const target = finalPath(paths, metadata.storageKey)
        if (metadata.state === 'complete') {
          if (manifest.state !== 'renamed' || metadata.sha256 !== manifest.finalSha256) fail('upload_unavailable', 503)
          await verifyReadyFile(paths, manifest, target)
          completedManifest = manifest
          expectedCleanupState = await readPortalPageUploadCleanupState(context.payload, transactionReq, id)
          if (!expectedCleanupState) fail('upload_unavailable', 503)
          return { id, state: 'complete', mimeType: metadata.mimeType, bytes: metadata.filesize,
            sha256: metadata.sha256!, completedAt: metadata.completedAt! }
        }
        if (metadata.state !== 'uploading') fail('upload_not_found', 404)
        let currentManifest = manifest
        if (currentManifest.state === 'receiving' || currentManifest.state === 'assembling') {
          await inspectChunkSet(paths, currentManifest)
          if (await fileExistsRegular(target)) fail('upload_unavailable', 503)
          currentManifest = { ...currentManifest, state: 'assembling' }
          await writeManifest(context, paths, currentManifest)
          let assembledHash: string
          try { assembledHash = await assembleChunks(context, paths, currentManifest) }
          catch (error) {
            await removeRegularFile(assembledPartPath(paths, id)).catch(() => {})
            if (!(error instanceof PortalPageUploadError) || error.code !== 'upload_unavailable') {
              await writeManifest(context, paths, { ...currentManifest, state: 'receiving' }).catch(() => {})
            }
            throw error
          }
          currentManifest = { ...currentManifest, state: 'ready_to_rename', finalSha256: assembledHash }
          await writeManifest(context, paths, currentManifest)
        }
        if (currentManifest.state === 'ready_to_rename') {
          if (await fileExistsRegular(target)) {
            await verifyReadyFile(paths, currentManifest, target)
          } else {
            const partial = assembledPartPath(paths, id)
            await verifyReadyFile(paths, currentManifest, partial)
            await rename(partial, target)
            await syncDirectory(paths.incoming)
            await syncDirectory(paths.pages)
          }
          currentManifest = { ...currentManifest, state: 'renamed' }
          await writeManifest(context, paths, currentManifest)
        }
        if (currentManifest.state !== 'renamed' || !currentManifest.finalSha256) fail('upload_unavailable', 503)
        await verifyReadyFile(paths, currentManifest, target)
        const completionTimestamp = now()
        const completedAt = new Date(completionTimestamp).toISOString()
        const cleanupAt = completionTimestamp + PORTAL_PAGE_UPLOAD_RETENTION_MS
        try {
          await context.payload.update({ collection: PAGE_MEDIA_COLLECTION, id, req: transactionReq, overrideAccess: true,
            data: { state: 'complete', sha256: currentManifest.finalSha256, completedAt } })
          const db = await requireCmsTransaction(context.payload, transactionReq)
          await uploadCleanupAdapter(context, db).schedule(id, cleanupAt)
          expectedCleanupState = await readPortalPageUploadCleanupState(context.payload, transactionReq, id)
          if (!expectedCleanupState || expectedCleanupState.status !== 'pending' ||
            expectedCleanupState.nextAttemptAt !== cleanupAt || expectedCleanupState.lastErrorCode !== null) {
            fail('upload_unavailable', 503)
          }
        } catch (error) {
          try {
            if (await fileExistsRegular(target)) await verifyReadyFile(paths, currentManifest, target)
            await removeRegularFile(target)
            await removeRegularFile(assembledPartPath(paths, id))
            currentManifest = { ...currentManifest, state: 'receiving' }
            delete currentManifest.finalSha256
            await writeManifest(context, paths, currentManifest)
            await syncDirectory(paths.pages)
          } catch { /* Keep the renamed manifest if compensation itself is uncertain. */ }
          throw error
        }
        completedManifest = currentManifest
        return { id, state: 'complete', mimeType: metadata.mimeType, bytes: metadata.filesize,
          sha256: currentManifest.finalSha256, completedAt }
      })
      if (!result) fail('upload_unavailable', 503)
      if (!completedManifest || !storageKey) fail('upload_unavailable', 503)
      const confirmed = await readFreshState(id)
      assertFreshCompleteRow(confirmed, completedManifest, actor, result.sha256, result.completedAt)
      assertCleanupMatches(confirmed.cleanup, expectedCleanupState)
      await cleanupIncoming(paths, completedManifest, false, storageKey, true)
      return result
    } finally { await lock?.release() }
  }

  async function cancel(rawID: unknown, rawToken: unknown) {
    const id = validatedID(rawID)
    const token = bodyToken(rawToken)
    const paths = await getPathsReady()
    const initialManifest = await readManifest(paths, id)
    if (!verifyPortalPageUploadToken(token, initialManifest.tokenHash)) fail('invalid_upload_token', 403)
    if (initialManifest.actorUid !== actor) fail('upload_not_found', 404)
    const cancelRequest = standaloneRequest(context.req)
    let lock: UploadLock | undefined
    try {
      await withPortalPageMediaMutation(cancelRequest, actor, 'delete', async transactionReq => {
        await lockPortalPageUpload(context.payload, transactionReq, id)
        const ownership = await acquireUploadLock(context, paths, id)
        lock = ownership
        const manifest = await readManifest(paths, id)
        if (!verifyPortalPageUploadToken(token, manifest.tokenHash)) fail('invalid_upload_token', 403)
        if (manifest.actorUid !== actor) fail('upload_not_found', 404)
        await reconcileStaleManifestPartials(paths, manifest, ownership)
        const row = await getMediaRow(context.payload, transactionReq, id)
        if (!row) {
          if (manifest.state !== 'cancelling') fail('upload_not_found', 404)
          return { id, cancelled: true }
        }
        const metadata = metadataFromRow(row)
        assertRowMatchesManifest(row, manifest, actor)
        if (metadata.state !== 'uploading') fail('media_already_complete', 409)
        const cancelling = { ...manifest, state: 'cancelling' as const }
        await writeManifest(context, paths, cancelling)
        try {
          const db = await requireCmsTransaction(context.payload, transactionReq)
          await uploadCleanupAdapter(context, db).schedule(id, now())
        } catch (error) {
          await writeManifest(context, paths, manifest).catch(() => {})
          throw error
        }
        return { id, cancelled: true }
      })
      await withPortalPageMediaLifecycleMutation(cancelRequest, actor, async transactionReq => {
        await lockPortalPageUpload(context.payload, transactionReq, id)
        const row = await getMediaRow(context.payload, transactionReq, id)
        const rowMetadata = row ? metadataFromRow(row) : null
        if (row && rowMetadata) {
          assertRowMatchesManifest(row, initialManifest, actor)
          if (rowMetadata.state !== 'uploading') fail('media_already_complete', 409)
        }
        if (await fileExistsRegular(manifestPath(paths, id))) {
          const cancelling = await readManifest(paths, id)
          if (!verifyPortalPageUploadToken(token, cancelling.tokenHash) || cancelling.actorUid !== actor ||
            cancelling.state !== 'cancelling') fail('upload_unavailable', 503)
          if (row) assertRowMatchesManifest(row, cancelling, actor)
          await cleanupIncoming(paths, cancelling, true, cancelling.storageKey)
        } else {
          if (rowMetadata && await fileExistsRegular(finalPath(paths, rowMetadata.storageKey))) fail('upload_unavailable', 503)
          await removeUnmanifestedArtifacts(paths, id)
        }
        if (row) await context.payload.delete({ collection: PAGE_MEDIA_COLLECTION, id, req: transactionReq, overrideAccess: true })
        const db = await requireCmsTransaction(context.payload, transactionReq)
        await uploadCleanupAdapter(context, db).remove(id)
      })
      const confirmed = await readFreshState(id)
      if (confirmed.media !== null || confirmed.cleanup !== null) fail('upload_unavailable', 503)
      await assertCancelledArtifactsRemoved(paths, initialManifest)
      return { id, cancelled: true }
    } finally { await lock?.release() }
  }

  return { init, putChunk, complete, cancel, cleanupExpired }
}

export const PORTAL_PAGE_UPLOAD_INTERNAL_LIMITS = Object.freeze({
  maxManifestBytes: MAX_MANIFEST_BYTES,
  cleanupBatchSize: PORTAL_PAGE_UPLOAD_CLEANUP_BATCH_SIZE,
  streamHighWaterMark: STREAM_HIGH_WATER_MARK,
})
