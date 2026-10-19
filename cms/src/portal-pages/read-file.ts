import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import path from 'node:path'
import { APIError } from 'payload'
import type { PortalPageMediaReadRecord } from './persistence'
import { PORTAL_PAGE_MEDIA_SIZE_CAPS } from './validation'

const CHUNK_BYTES = 64 * 1024
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const EXTENSIONS: Readonly<Record<PortalPageMediaReadRecord['mimeType'], string>> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
  'video/mp4': 'mp4', 'video/webm': 'webm',
}

export type PortalPageByteRange = { start: number; end: number; partial: boolean }
export type PortalPageDescriptor = {
  read: (buffer: Buffer, offset: number, length: number, position: number) => Promise<{ bytesRead: number }>
  close: () => Promise<void>
  stat: () => Promise<{ size: number; isFile: () => boolean; mode?: number; dev?: number; ino?: number }>
}
export type PortalPageAssetResponse = {
  status: number
  headers: Record<string, string>
  body: ReadableStream<Uint8Array> | null
}

const responseHeaders = () => ({ 'Cache-Control': 'private,no-store', 'X-Content-Type-Options': 'nosniff' })
const unavailable = () => new APIError('portal_page_media_unavailable', 503, undefined, true)

/** Parse one RFC-style byte range, including suffix and open-ended forms. */
export function parsePortalPageRange(range: string | null | undefined, size: number): PortalPageByteRange | null {
  if (!Number.isSafeInteger(size) || size < 1) return null
  if (range === null || range === undefined) return { start: 0, end: size - 1, partial: false }
  if (typeof range !== 'string' || range.length > 200) return null
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range)
  if (!match || (!match[1] && !match[2])) return null
  const first = match[1] ? Number(match[1]) : null
  const last = match[2] ? Number(match[2]) : null
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null
  if (first === null && last === 0) return null
  const start = first ?? Math.max(0, size - last!)
  const end = first === null || last === null ? size - 1 : Math.min(last, size - 1)
  if (start < 0 || start >= size || end < start) return null
  return { start, end, partial: true }
}

function canonicalStorageKey(media: PortalPageMediaReadRecord): boolean {
  return Object.hasOwn(EXTENSIONS, media.mimeType) && typeof media.storageKey === 'string' &&
    new RegExp(`^${UUID}\\.${EXTENSIONS[media.mimeType]}$`, 'u').test(media.storageKey)
}

async function verifyDirectory(directory: string, requirePrivate = false): Promise<void> {
  const absolute = path.resolve(directory)
  if (!path.isAbsolute(directory) || directory.includes('\0')) throw unavailable()
  const parsed = path.parse(absolute)
  let current = parsed.root
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    let info
    try { info = await lstat(current) } catch { throw unavailable() }
    if (!info.isDirectory() || info.isSymbolicLink() ||
      (requirePrivate && current === absolute && process.platform !== 'win32' && (info.mode & 0o077) !== 0)) {
      throw unavailable()
    }
  }
}

/** Opens a server-owned key under the private page-media directory without following links. */
export async function openPortalPageMediaDescriptor(uploadDir: string, media: PortalPageMediaReadRecord): Promise<PortalPageDescriptor> {
  if (!canonicalStorageKey(media) || media.state !== 'complete' || !/^[0-9a-f]{64}$/u.test(media.sha256 || '') ||
    !Number.isSafeInteger(media.filesize) || media.filesize < 1 || media.filesize > PORTAL_PAGE_MEDIA_SIZE_CAPS[media.mimeType]) {
    throw unavailable()
  }
  const root = path.resolve(uploadDir)
  if (!path.isAbsolute(uploadDir) || uploadDir.includes('\0')) throw unavailable()
  const directory = path.join(root, 'portal-pages')
  await verifyDirectory(root)
  await verifyDirectory(directory, true)
  const filename = path.join(directory, media.storageKey)
  if (path.dirname(filename) !== directory) throw unavailable()
  let before
  try { before = await lstat(filename) } catch { throw unavailable() }
  if (!before.isFile() || before.isSymbolicLink() || (process.platform !== 'win32' && (before.mode & 0o077) !== 0)) throw unavailable()
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
    const after = await handle.stat()
    if (!after.isFile() || after.size !== media.filesize || (process.platform !== 'win32' && (after.mode & 0o077) !== 0) ||
      (before.dev !== after.dev || before.ino !== after.ino)) throw unavailable()
    return handle
  } catch (error) {
    await handle?.close().catch(() => {})
    if (error instanceof APIError) throw error
    throw unavailable()
  }
}

/** Stream from an already-authorized descriptor. The 64 KiB pull bounds memory and honors backpressure. */
export async function portalPageMediaResponse(options: {
  media: PortalPageMediaReadRecord
  range?: string | null
  signal?: AbortSignal
  openDescriptor: () => Promise<PortalPageDescriptor>
}): Promise<PortalPageAssetResponse> {
  const { media, range, signal } = options
  if (!canonicalStorageKey(media) || media.state !== 'complete' || !/^[0-9a-f]{64}$/u.test(media.sha256 || '') ||
    !Number.isSafeInteger(media.filesize) || media.filesize < 1 || media.filesize > PORTAL_PAGE_MEDIA_SIZE_CAPS[media.mimeType]) {
    throw unavailable()
  }
  const handle = await options.openDescriptor()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    signal?.removeEventListener('abort', abort)
    await handle.close()
  }
  const headers: Record<string, string> = responseHeaders()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const abort = () => {
    controller?.error(new DOMException('Aborted', 'AbortError'))
    void close()
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size !== media.filesize ||
      (process.platform !== 'win32' && typeof info.mode === 'number' && (info.mode & 0o077) !== 0)) throw unavailable()
    const supportsRange = media.mimeType === 'application/pdf' || media.mimeType === 'video/mp4' || media.mimeType === 'video/webm'
    const selected = parsePortalPageRange(supportsRange ? range : null, media.filesize)
    headers['Content-Type'] = media.mimeType
    headers['Content-Disposition'] = `inline; filename="${media.storageKey}"`
    if (supportsRange) headers['Accept-Ranges'] = 'bytes'
    if (!selected) {
      headers['Content-Range'] = `bytes */${media.filesize}`
      headers['Content-Length'] = '0'
      await close()
      return { status: 416, headers, body: null }
    }
    headers['Content-Length'] = String(selected.end - selected.start + 1)
    if (selected.partial) headers['Content-Range'] = `bytes ${selected.start}-${selected.end}/${media.filesize}`
    let position = selected.start
    const end = selected.end
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      },
      async pull(value) {
        if (closed) return
        try {
          const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, end - position + 1))
          const result = await handle.read(bytes, 0, bytes.length, position)
          if (closed) return
          if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead <= 0 || result.bytesRead > bytes.length) throw unavailable()
          position += result.bytesRead
          value.enqueue(bytes.subarray(0, result.bytesRead))
          if (position > end) { value.close(); await close() }
        } catch (error) {
          if (!closed) value.error(error)
          await close()
        }
      },
      cancel: close,
    }, { highWaterMark: 0 })
    return { status: selected.partial ? 206 : 200, headers, body }
  } catch (error) {
    await close()
    throw error instanceof APIError ? error : unavailable()
  }
}

export async function openPortalPageMedia(options: {
  uploadDir: string
  media: PortalPageMediaReadRecord
  range?: string | null
  signal?: AbortSignal
}): Promise<PortalPageAssetResponse> {
  return portalPageMediaResponse({ ...options, openDescriptor: () => openPortalPageMediaDescriptor(options.uploadDir, options.media) })
}
