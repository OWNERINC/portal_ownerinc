import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, opendir, rename, stat, statfs, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Writable, type Readable as NodeReadable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import sharp from 'sharp'
import { sql } from '@payloadcms/db-postgres'
import type { Payload, PayloadRequest } from 'payload'
import { MAX_IMAGE_PIXELS } from '../media/validate-upload'
import { requireCmsTransaction } from '../publication/transaction'
import { withPortalPageMediaMutation } from './persistence'
import { PORTAL_PAGE_MEDIA_SIZE_CAPS, validatePortalPageMediaMetadata } from './validation'
import { PORTAL_PAGE_MEDIA_MIMES } from './primitives'

const MiB = 1024 * 1024
export const PORTAL_PAGE_UPLOAD_CHUNK_SIZE = 5 * MiB
export const PORTAL_PAGE_UPLOAD_MAX_CHUNKS = 100
export const PORTAL_PAGE_UPLOAD_MAX_ACTIVE_PER_ACTOR = 2
export const PORTAL_PAGE_UPLOAD_MAX_ACTIVE_GLOBAL = 8
export const PORTAL_PAGE_UPLOAD_MIN_FREE_BYTES = 1024 * MiB
export const PORTAL_PAGE_UPLOAD_RETENTION_MS = 24 * 60 * 60 * 1000
const MAX_MANIFEST_BYTES = 8192
const MAX_DIRECTORY_SCAN = 1024
const MAX_MANIFEST_SCAN = 32
const STREAM_HIGH_WATER_MARK = 64 * 1024
const PAGE_MEDIA_COLLECTION = 'portal-page-media'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const MP4_BRANDS = new Set(['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'M4V '])

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
type UploadLock = { release: () => Promise<void> }
type ActiveUploadRow = { id: string; uploaded_by: string; filesize: string | number }
type MutationRequestContext = { payload: Payload; req: PayloadRequest; actorUid: string; uploadDir: string; now?: () => number;
  statfsFreeBytes?: (directory: string) => Promise<bigint> }

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
  if ((state === 'ready_to_rename' || state === 'renamed') !== hasFinalHash ||
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

async function writeManifest(paths: StoredPaths, manifest: UploadManifest): Promise<void> {
  const id = validatedID(manifest.id)
  const normalized = validateManifest(manifest, id)
  const temp = manifestTempPath(paths, id)
  const data = Buffer.from(JSON.stringify(normalized), 'utf8')
  if (data.length > MAX_MANIFEST_BYTES) fail('upload_unavailable', 503)
  let handle
  try {
    handle = await open(temp, 'wx', 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close(); handle = undefined
    const target = manifestPath(paths, id)
    if (await assertRegularOrAbsent(target)) await rename(temp, target)
    else await rename(temp, target)
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

async function readLockOwner(filename: string): Promise<{ pid: number; live: boolean }> {
  const bytes = await readSmallRegularFile(filename, 1024)
  let value: Record<string, unknown>
  try { value = asRecord(JSON.parse(bytes.toString('utf8'))) } catch { fail('upload_unavailable', 503) }
  if (!Number.isSafeInteger(value.pid) || Number(value.pid) < 1 || typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt))) fail('upload_unavailable', 503)
  if (Date.now() - Date.parse(value.createdAt) < PORTAL_PAGE_UPLOAD_RETENTION_MS) return { pid: Number(value.pid), live: true }
  try { process.kill(Number(value.pid), 0); return { pid: Number(value.pid), live: true } }
  catch (error) { return { pid: Number(value.pid), live: (error as NodeJS.ErrnoException).code !== 'ESRCH' } }
}

async function acquireUploadLock(paths: StoredPaths, id: string, waitForSameProcess = false): Promise<UploadLock> {
  const filename = uploadLockPath(paths, id)
  const nonce = randomBytes(16).toString('hex')
  const lockData = JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), nonce })
  let handle
  for (let attempt = 0; ; attempt++) {
    try { handle = await open(filename, 'wx', 0o600); break }
    catch (error) {
      if (!isAlreadyExists(error)) fail('storage_unavailable', 503)
      if (!(await assertRegularOrAbsent(filename))) continue
      const owner = await readLockOwner(filename)
      if (owner.live && waitForSameProcess && owner.pid === process.pid && attempt < 200) {
        await new Promise(resolve => setTimeout(resolve, 25))
        continue
      }
      if (!owner.live) {
        await removeRegularFile(filename)
        continue
      }
      fail('upload_busy', 409)
    }
  }
  try { await handle!.writeFile(lockData); await handle!.sync(); await syncDirectory(paths.incoming) }
  catch { await handle?.close().catch(() => {}); await removeRegularFile(filename).catch(() => {}); fail('storage_unavailable', 503) }
  return { release: async () => {
    await handle?.close().catch(() => {})
    const data = await readSmallRegularFile(filename, 1024)
    let lock: Record<string, unknown>
    try { lock = asRecord(JSON.parse(data.toString('utf8'))) } catch { fail('storage_unavailable', 503) }
    if (lock.nonce !== nonce) fail('storage_unavailable', 503)
    await removeRegularFile(filename)
    await syncDirectory(paths.incoming)
  } }
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

async function readActiveUploadRows(payload: Payload, req: PayloadRequest): Promise<ActiveUploadRow[]> {
  const db = await requireCmsTransaction(payload, req)
  const result = await db.execute(sql`SELECT id, uploaded_by, filesize FROM portal_page_media WHERE state = 'uploading' ORDER BY id LIMIT 9`)
  const rows = (result as unknown as { rows?: unknown[] }).rows
  if (!Array.isArray(rows) || rows.length > PORTAL_PAGE_UPLOAD_MAX_ACTIVE_GLOBAL) fail('upload_unavailable', 503)
  return rows.map(raw => {
    const row = asRecord(raw)
    if (typeof row.id !== 'string' || !UUID.test(row.id) || typeof row.uploaded_by !== 'string') fail('upload_unavailable', 503)
    try { if (BigInt(String(row.filesize)) < 1n || BigInt(String(row.filesize)) > BigInt(500 * MiB)) fail('upload_unavailable', 503) }
    catch { fail('upload_unavailable', 503) }
    return { id: String(row.id).toLowerCase(), uploaded_by: row.uploaded_by, filesize: String(row.filesize) }
  })
}

async function freeBytesFromStatfs(directory: string): Promise<bigint> {
  try {
    const info = await statfs(directory, { bigint: true })
    return info.bavail * info.bsize
  } catch { fail('disk_unavailable', 507) }
}

async function verifyDiskReservation(context: MutationRequestContext, paths: StoredPaths, rows: ActiveUploadRow[], nextBytes: number): Promise<void> {
  const activeBytes = rows.reduce((sum, row) => sum + BigInt(row.filesize), 0n)
  let free: bigint
  try { free = await (context.statfsFreeBytes || freeBytesFromStatfs)(paths.incoming) }
  catch { fail('disk_unavailable', 507) }
  // Staging chunks and final assembly coexist until an atomic rename. Reserve both copies.
  const need = (activeBytes + BigInt(nextBytes)) * 2n + BigInt(PORTAL_PAGE_UPLOAD_MIN_FREE_BYTES)
  if (free < need) fail('insufficient_disk_space', 507)
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
  if (header.length < 8 || !header.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) return false
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
    if (id.value === 0x4282) found = size.value === 4 && header.toString('ascii', offset, offset + 4) === 'webm'
    offset += size.value
  }
  return offset === end && found
}

async function validateMediaFile(filename: string, mimeType: UploadManifest['mimeType'], bytes: number): Promise<void> {
  if (mimeType.startsWith('image/')) {
    if (bytes > 15 * MiB) fail('invalid_media_file', 400)
    const data = await readSmallRegularFile(filename, 15 * MiB)
    const validSignature = mimeType === 'image/jpeg' ? data.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex')) :
      mimeType === 'image/png' ? data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) :
        data.length >= 20 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' &&
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
    if (!head.toString('ascii').startsWith('%PDF-') || !/%%EOF[\t\n\r\f ]*$/u.test(tail.toString('latin1'))) fail('invalid_media_file', 400)
    return
  }
  const header = await readFileRange(filename, 0, Math.min(bytes, 4096), 8)
  if (mimeType === 'video/mp4') {
    if (header.length < 16 || header.toString('ascii', 4, 8) !== 'ftyp') fail('invalid_media_file', 400)
    const boxSize = header.readUInt32BE(0)
    const brand = header.toString('ascii', 8, 12)
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

function createFileHandleSink(handle: FileHandle): Writable {
  return new Writable({ highWaterMark: STREAM_HIGH_WATER_MARK, write(chunk: Buffer | Uint8Array, _encoding, callback) {
    void handle.write(chunk).then(() => callback(), error => callback(error as Error))
  } })
}

async function hashRegularFile(filename: string, expectedBytes: number): Promise<string> {
  const source = await createReadStreamSafe(filename)
  return (await streamPortalPageBytes([source], await createDiscardSink(), expectedBytes)).sha256
}

async function inspectChunkSet(paths: StoredPaths, manifest: UploadManifest): Promise<void> {
  const entries: string[] = []
  let directory
  try { directory = await opendir(paths.incoming) } catch { fail('storage_unavailable', 503) }
  try {
    for await (const entry of directory!) {
      if (entries.length >= MAX_DIRECTORY_SCAN) fail('upload_unavailable', 503)
      entries.push(entry.name)
    }
  } catch (error) {
    if (error instanceof PortalPageUploadError) throw error
    fail('storage_unavailable', 503)
  }
  const prefix = `${manifest.id}-`
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    if (name.endsWith('.part')) {
      const indexText = name.slice(prefix.length, -'.part'.length)
      if (!/^(?:0|[1-9][0-9]{0,1})$/u.test(indexText) || Number(indexText) >= manifest.chunkCount) fail('upload_unavailable', 503)
      await removeRegularFile(chunkPartPath(paths, manifest.id, Number(indexText)))
      continue
    }
    if (!name.endsWith('.chunk')) continue
    const indexText = name.slice(prefix.length, -'.chunk'.length)
    if (!/^(?:0|[1-9][0-9]{0,1})$/u.test(indexText) || Number(indexText) >= manifest.chunkCount) fail('upload_unavailable', 503)
  }
  for (let index = 0; index < manifest.chunkCount; index++) {
    const expected = expectedPortalPageUploadChunkBytes(manifest.bytes, manifest.chunkCount, index)
    const filename = chunkPath(paths, manifest.id, index)
    let info
    try { info = await lstat(filename) } catch (error) { if (isNotFound(error)) fail('upload_incomplete', 409); fail('storage_unavailable', 503) }
    if (!info.isFile() || info.isSymbolicLink() || info.size !== expected ||
      (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) fail('upload_incomplete', 409)
  }
}

async function assembleChunks(paths: StoredPaths, manifest: UploadManifest): Promise<string> {
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
    const result = await streamPortalPageBytes(sourceStreams, createFileHandleSink(output), manifest.bytes)
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

type EntryGroup = { id: string; manifest?: string; tempManifest?: string; lock?: string; names: string[] }
async function scanIncoming(paths: StoredPaths): Promise<EntryGroup[]> {
  const groups = new Map<string, EntryGroup>()
  let directory
  try { directory = await opendir(paths.incoming) } catch { fail('storage_unavailable', 503) }
  try {
    let scanned = 0
    for await (const entry of directory!) {
      scanned++
      if (scanned > MAX_DIRECTORY_SCAN) fail('upload_unavailable', 503)
      if (!entry.isFile()) fail('upload_unavailable', 503)
      const name = entry.name
      const manifest = /^m-([0-9a-f-]{36})\.json$/u.exec(name)
      const temporary = /^m-([0-9a-f-]{36})\.tmp$/u.exec(name)
      const lock = /^u-([0-9a-f-]{36})\.lock$/u.exec(name)
      const chunk = /^([0-9a-f-]{36})-(0|[1-9][0-9]{0,2})\.(?:chunk|part)$/u.exec(name)
      const assembled = /^([0-9a-f-]{36})\.assembled\.part$/u.exec(name)
      const match = manifest || temporary || lock || chunk || assembled
      if (!match || !UUID.test(match[1]!)) fail('upload_unavailable', 503)
      const id = match[1]!.toLowerCase()
      const group = groups.get(id) || { id, names: [] }
      group.names.push(name)
      if (manifest) { if (group.manifest) fail('upload_unavailable', 503); group.manifest = name }
      if (temporary) { if (group.tempManifest) fail('upload_unavailable', 503); group.tempManifest = name }
      if (lock) { if (group.lock) fail('upload_unavailable', 503); group.lock = name }
      if (chunk && Number(chunk[2]) >= PORTAL_PAGE_UPLOAD_MAX_CHUNKS) fail('upload_unavailable', 503)
      groups.set(id, group)
      if (groups.size > MAX_MANIFEST_SCAN) fail('upload_unavailable', 503)
    }
  } catch (error) {
    if (error instanceof PortalPageUploadError) throw error
    fail('storage_unavailable', 503)
  }
  for (const group of groups.values()) if (!group.manifest && !group.tempManifest) fail('upload_unavailable', 503)
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id))
}

async function writeRequestToFile(body: Readable, destination: string, expectedBytes: number): Promise<{ bytes: number; sha256: string }> {
  let handle
  try {
    handle = await open(destination, 'wx', 0o600)
    const result = await streamPortalPageBytes([body], createFileHandleSink(handle), expectedBytes)
    await handle.sync()
    await handle.close(); handle = undefined
    return result
  } catch (error) {
    await handle?.close().catch(() => {})
    await removeRegularFile(destination).catch(() => {})
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

/** Private, editor-only upload lifecycle. No path or raw credential enters a response. */
export function createPortalPageUploadService(context: MutationRequestContext) {
  const actor = actorUID(context.actorUid)
  const now = context.now || Date.now
  const pathsPromise = ensureStorage(context.uploadDir)
  const getPathsReady = () => pathsPromise

  async function cleanupExpired(): Promise<{ removed: number; unresolved: number }> {
    const paths = await getPathsReady()
    const releases: UploadLock[] = []
    const pending: Array<{ manifest: UploadManifest; finalKey?: string; removeFinal: boolean }> = []
    const changed: Array<{ paths: StoredPaths; manifest: UploadManifest }> = []
    let unresolved = 0
    let callbackReturned = false
    try {
      await withPortalPageMediaMutation(context.req, actor, 'delete', async transactionReq => {
        const rows = await readActiveUploadRows(context.payload, transactionReq)
        const activeByID = new Map(rows.map(row => [row.id, row]))
        const groups = await scanIncoming(paths)
        for (const group of groups) {
          const manifestSource = group.manifest ? manifestPath(paths, group.id) : manifestTempPath(paths, group.id)
          const manifest = await readManifest(paths, group.id, manifestSource)
          if (group.tempManifest && group.manifest) {
            // A leftover write temp is only removable after proving its content identity.
            await readManifest(paths, group.id, manifestTempPath(paths, group.id))
          }
          const age = now() - Date.parse(manifest.createdAt)
          if (age < PORTAL_PAGE_UPLOAD_RETENTION_MS) continue
          const row = await getMediaRow(context.payload, transactionReq, group.id)
          if (!row) {
            if (manifest.state === 'cancelling' || manifest.state === 'receiving' || manifest.state === 'assembling') {
              const lock = await acquireUploadLock(paths, group.id); releases.push(lock)
              pending.push({ manifest, finalKey: manifest.storageKey, removeFinal: manifest.state === 'cancelling' })
            } else unresolved++
            continue
          }
          const metadata = metadataFromRow(row)
          assertRowMatchesManifest(row, manifest, manifest.actorUid)
          if (metadata.state === 'complete') {
            if ((manifest.state !== 'renamed' && manifest.state !== 'ready_to_rename') ||
              metadata.sha256 !== manifest.finalSha256 || metadata.storageKey !== row.storageKey) { unresolved++; continue }
            const target = finalPath(paths, metadata.storageKey)
            await verifyReadyFile(paths, manifest, target)
            const lock = await acquireUploadLock(paths, group.id); releases.push(lock)
            pending.push({ manifest, finalKey: metadata.storageKey, removeFinal: false })
            continue
          }
          if (metadata.state !== 'uploading' || metadata.uploadedBy !== manifest.actorUid || activeByID.get(group.id)?.uploaded_by !== manifest.actorUid) {
            fail('upload_unavailable', 503)
          }
          if (manifest.state === 'ready_to_rename' || manifest.state === 'renamed') { unresolved++; continue }
          const lock = await acquireUploadLock(paths, group.id); releases.push(lock)
          const original = { ...manifest }
          const cancelling = { ...manifest, state: 'cancelling' as const }
          await writeManifest(paths, cancelling)
          changed.push({ paths, manifest: original })
          await context.payload.delete({ collection: PAGE_MEDIA_COLLECTION, id: group.id, req: transactionReq, overrideAccess: true })
          pending.push({ manifest: cancelling, finalKey: metadata.storageKey, removeFinal: true })
        }
        callbackReturned = true
        return rows
      })
      let removed = 0
      for (const item of pending) {
        await cleanupIncoming(paths, item.manifest, item.removeFinal, item.finalKey)
        removed++
      }
      return { removed, unresolved }
    } catch (error) {
      // Callback errors are known rollbacks. Commit failures happen after the callback and
      // deliberately leave the "cancelling" manifests for a later reconciliation pass.
      if (!callbackReturned && changed.length) {
        for (const item of changed) await writeManifest(item.paths, item.manifest).catch(() => {})
      }
      throw error
    } finally {
      for (const lock of releases.reverse()) await lock.release().catch(() => {})
    }
  }

  async function init(value: unknown) {
    const input = validatePortalPageUploadInit(value)
    const paths = await getPathsReady()
    await cleanupExpired()
    const token = randomBytes(32).toString('base64url')
    const timestamp = new Date(now()).toISOString()
    let createdID: string | undefined
    await withPortalPageMediaMutation(context.req, actor, 'create', async transactionReq => {
      const active = await readActiveUploadRows(context.payload, transactionReq)
      const activeForActor = active.filter(row => row.uploaded_by === actor).length
      if (activeForActor >= PORTAL_PAGE_UPLOAD_MAX_ACTIVE_PER_ACTOR || active.length >= PORTAL_PAGE_UPLOAD_MAX_ACTIVE_GLOBAL) fail('upload_limit_reached', 429)
      await verifyDiskReservation(context, paths, active, input.bytes)
      let created: Record<string, unknown> | undefined
      try {
        created = await context.payload.create({ collection: PAGE_MEDIA_COLLECTION, req: transactionReq, overrideAccess: true,
          data: { originalName: input.originalName, mimeType: input.mimeType, filesize: input.bytes, sha256: null,
            state: 'uploading', completedAt: null } as never }) as unknown as Record<string, unknown>
        const id = validatedID(created.id)
        createdID = id
        const metadata = metadataFromRow({ ...created, id })
        if (metadata.state !== 'uploading' || metadata.uploadedBy !== actor || metadata.sha256 !== null ||
          metadata.mimeType !== input.mimeType || metadata.filesize !== input.bytes) fail('upload_unavailable', 503)
        const manifest: UploadManifest = { version: 1, id, storageKey: metadata.storageKey, actorUid: actor, mimeType: input.mimeType, bytes: input.bytes,
          chunkSize: PORTAL_PAGE_UPLOAD_CHUNK_SIZE, chunkCount: input.chunkCount, createdAt: timestamp,
          tokenHash: tokenHash(token), state: 'receiving' }
        await writeManifest(paths, manifest)
        return id
      } catch (error) {
        if (createdID) {
          await removeRegularFile(manifestTempPath(paths, createdID)).catch(() => {})
          await removeRegularFile(manifestPath(paths, createdID)).catch(() => {})
        }
        throw error
      }
    })
    if (!createdID) fail('upload_unavailable', 503)
    return { id: createdID, token, chunkSize: PORTAL_PAGE_UPLOAD_CHUNK_SIZE, chunkCount: input.chunkCount,
      bytes: input.bytes, mimeType: input.mimeType }
  }

  async function putChunk(rawID: unknown, rawIndex: unknown, headers: Headers, body: ReadableStream<Uint8Array> | null | undefined) {
    const token = headers.get('x-portal-page-upload-token')
    const id = validatedID(rawID)
    if (typeof rawIndex !== 'string' || !/^(?:0|[1-9][0-9]{0,1})$/u.test(rawIndex)) fail('invalid_chunk', 400)
    const index = Number(rawIndex)
    const paths = await getPathsReady()
    const initialManifest = await readManifest(paths, id)
    if (!verifyPortalPageUploadToken(token, initialManifest.tokenHash)) fail('invalid_upload_token', 403)
    if (initialManifest.actorUid !== actor) fail('upload_not_found', 404)
    const lock = await acquireUploadLock(paths, id)
    try {
      const manifest = await readManifest(paths, id)
      if (!verifyPortalPageUploadToken(token, manifest.tokenHash)) fail('invalid_upload_token', 403)
      if (manifest.actorUid !== actor || manifest.state !== 'receiving') fail('upload_not_found', 404)
      const row = await getMediaRow(context.payload, context.req, id)
      if (!row) fail('upload_not_found', 404)
      const metadata = metadataFromRow(row)
      assertRowMatchesManifest(row, manifest, actor)
      if (metadata.state !== 'uploading') fail('upload_not_found', 404)
      const expected = expectedPortalPageUploadChunkBytes(manifest.bytes, manifest.chunkCount, index)
      validateChunkRequest(headers.get('content-type'), headers.get('content-length'), expected)
      const source = requestBodyStream(body)
      const destination = chunkPath(paths, id, index)
      if (await fileExistsRegular(destination)) {
        const existing = await hashRegularFile(destination, expected)
        const incoming = await streamPortalPageBytes([source], await createDiscardSink(), expected)
        if (existing !== incoming.sha256) fail('chunk_conflict', 409)
        return { id, index, received: true, duplicate: true }
      }
      const partial = chunkPartPath(paths, id, index)
      try {
        const result = await writeRequestToFile(source, partial, expected)
        if (await fileExistsRegular(destination)) fail('chunk_conflict', 409)
        await rename(partial, destination)
        await syncDirectory(paths.incoming)
        return { id, index, received: true, duplicate: false, sha256: result.sha256 }
      } catch (error) {
        await removeRegularFile(partial).catch(() => {})
        throw error
      }
    } finally { await lock.release() }
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
    let result: { id: string; state: 'complete'; mimeType: string; bytes: number; sha256: string; completedAt: string } | undefined
    try {
      result = await withPortalPageMediaMutation(context.req, actor, 'update', async transactionReq => {
        lock = await acquireUploadLock(paths, id, true)
        const row = await getMediaRow(context.payload, transactionReq, id)
        if (!row) fail('upload_not_found', 404)
        const { manifest, metadata } = await validateAuthorizedUpload(paths, id, token, actor, row)
        storageKey = metadata.storageKey
        const target = finalPath(paths, metadata.storageKey)
        if (metadata.state === 'complete') {
          if (manifest.state !== 'renamed' || metadata.sha256 !== manifest.finalSha256) fail('upload_unavailable', 503)
          await verifyReadyFile(paths, manifest, target)
          completedManifest = manifest
          return { id, state: 'complete', mimeType: metadata.mimeType, bytes: metadata.filesize,
            sha256: metadata.sha256!, completedAt: metadata.completedAt! }
        }
        if (metadata.state !== 'uploading') fail('upload_not_found', 404)
        let currentManifest = manifest
        if (currentManifest.state === 'receiving' || currentManifest.state === 'assembling') {
          await inspectChunkSet(paths, currentManifest)
          if (await fileExistsRegular(target)) fail('upload_unavailable', 503)
          currentManifest = { ...currentManifest, state: 'assembling' }
          await writeManifest(paths, currentManifest)
          let assembledHash: string
          try { assembledHash = await assembleChunks(paths, currentManifest) }
          catch (error) {
            await removeRegularFile(assembledPartPath(paths, id)).catch(() => {})
            if (!(error instanceof PortalPageUploadError) || error.code !== 'upload_unavailable') {
              await writeManifest(paths, { ...currentManifest, state: 'receiving' }).catch(() => {})
            }
            throw error
          }
          currentManifest = { ...currentManifest, state: 'ready_to_rename', finalSha256: assembledHash }
          await writeManifest(paths, currentManifest)
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
          await writeManifest(paths, currentManifest)
        }
        if (currentManifest.state !== 'renamed' || !currentManifest.finalSha256) fail('upload_unavailable', 503)
        await verifyReadyFile(paths, currentManifest, target)
        const completedAt = new Date(now()).toISOString()
        try {
          await context.payload.update({ collection: PAGE_MEDIA_COLLECTION, id, req: transactionReq, overrideAccess: true,
            data: { state: 'complete', sha256: currentManifest.finalSha256, completedAt } })
        } catch (error) {
          try {
            await removeRegularFile(target)
            await removeRegularFile(assembledPartPath(paths, id))
            currentManifest = { ...currentManifest, state: 'receiving' }
            delete currentManifest.finalSha256
            await writeManifest(paths, currentManifest)
            await syncDirectory(paths.pages)
          } catch { /* Keep the renamed manifest if compensation itself is uncertain. */ }
          throw error
        }
        completedManifest = currentManifest
        return { id, state: 'complete', mimeType: metadata.mimeType, bytes: metadata.filesize,
          sha256: currentManifest.finalSha256, completedAt }
      })
      if (completedManifest && storageKey) await cleanupIncoming(paths, completedManifest, false, storageKey, true)
      if (!result) fail('upload_unavailable', 503)
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
    let lock: UploadLock | undefined
    let manifestForCleanup: UploadManifest | undefined
    let storageKey: string | undefined
    try {
      const result = await withPortalPageMediaMutation(context.req, actor, 'delete', async transactionReq => {
        lock = await acquireUploadLock(paths, id)
        const manifest = await readManifest(paths, id)
        if (!verifyPortalPageUploadToken(token, manifest.tokenHash)) fail('invalid_upload_token', 403)
        if (manifest.actorUid !== actor) fail('upload_not_found', 404)
        const row = await getMediaRow(context.payload, transactionReq, id)
        if (!row) {
          if (manifest.state !== 'cancelling') fail('upload_not_found', 404)
          manifestForCleanup = manifest
          storageKey = manifest.storageKey
          return { id, cancelled: true }
        }
        const metadata = metadataFromRow(row)
        assertRowMatchesManifest(row, manifest, actor)
        if (metadata.state !== 'uploading') fail('media_already_complete', 409)
        storageKey = metadata.storageKey
        const cancelling = { ...manifest, state: 'cancelling' as const }
        await writeManifest(paths, cancelling)
        try {
          await context.payload.delete({ collection: PAGE_MEDIA_COLLECTION, id, req: transactionReq, overrideAccess: true })
        } catch (error) {
          await writeManifest(paths, manifest).catch(() => {})
          throw error
        }
        manifestForCleanup = cancelling
        return { id, cancelled: true }
      })
      if (manifestForCleanup) await cleanupIncoming(paths, manifestForCleanup, Boolean(storageKey), storageKey)
      return result
    } finally { await lock?.release() }
  }

  return { init, putChunk, complete, cancel, cleanupExpired }
}

export const PORTAL_PAGE_UPLOAD_INTERNAL_LIMITS = Object.freeze({
  maxManifestBytes: MAX_MANIFEST_BYTES,
  maxDirectoryScan: MAX_DIRECTORY_SCAN,
  maxManifestScan: MAX_MANIFEST_SCAN,
  streamHighWaterMark: STREAM_HIGH_WATER_MARK,
})
