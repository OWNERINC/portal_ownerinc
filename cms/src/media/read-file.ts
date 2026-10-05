import { APIError, type Payload, type PayloadRequest } from 'payload'
import type { VerifiedPortalActor } from '../contracts/news'
import { uuid } from '../news/primitives'
import { requireCmsTransaction, withCmsTransaction } from '../publication/transaction'
import { canReadPublishedMedia } from './references'
import { openStoredMedia } from './storage'

export type MediaResponse = { status: number; headers: Record<string, string>; body: ReadableStream<Uint8Array> | null }
export function mediaRange(range: string | undefined | null, size: number) {
  if (!range) return { start: 0, end: size - 1, partial: false }
  const match = /^bytes=(\d*)-(\d*)$/u.exec(range)
  if (!match || (!match[1] && !match[2])) return null
  const first = match[1] ? Number(match[1]) : null
  const last = match[2] ? Number(match[2]) : null
  if ((first !== null && !Number.isSafeInteger(first)) || (last !== null && !Number.isSafeInteger(last))) return null
  const start = first ?? Math.max(0, size - last!)
  const end = first === null || last === null ? size - 1 : Math.min(last, size - 1)
  if (start < 0 || start >= size || end < start || (first === null && last === 0)) return null
  return { start, end, partial: true }
}

/** Server-only helper. The future API bridge must supply a VERIFIED, current actor, never JSON-cast identity. */
export async function openNewsMedia({ payload, id, preview = false, actor, range, req }: {
  payload: Payload; id: string; preview?: boolean; actor: VerifiedPortalActor | null;
  range?: string | null; req?: PayloadRequest;
}): Promise<MediaResponse> {
  const headers: Record<string, string> = { 'Cache-Control': 'private,no-store', 'X-Content-Type-Options': 'nosniff' }
  if (!actor?.uid) return { status: 401, headers, body: null }
  if (preview && !actor.canManageNews) return { status: 403, headers, body: null }
  let handle: Awaited<ReturnType<typeof openStoredMedia>> | undefined
  try {
    id = uuid(id)
    const result = await withCmsTransaction(payload, req, async req => {
      await requireCmsTransaction(payload, req)
      const media = await payload.findByID({ collection: 'news-media', id, req, overrideAccess: true, depth: 0, disableErrors: true })
      if (!media) return { status: 404, headers, body: null }
      if (!preview && !await canReadPublishedMedia(payload, id, req)) return { status: 403, headers, body: null }
      // Authorization AND descriptor-open happen before releasing the reference lock.
      handle = await openStoredMedia(payload, media)
      headers['Content-Type'] = media.mimeType!
      headers['Content-Disposition'] = `inline; filename="${media.filename!}"`
      const supportsRange = media.mimeType === 'application/pdf' || media.mimeType?.startsWith('video/')
      if (supportsRange) headers['Accept-Ranges'] = 'bytes'
      const selected = mediaRange(supportsRange ? range : undefined, media.filesize!)
      if (!selected) {
        headers['Content-Range'] = `bytes */${media.filesize}`
        headers['Content-Length'] = '0'
        await handle.close(); handle = undefined
        return { status: 416, headers, body: null }
      }
      headers['Content-Length'] = String(selected.end - selected.start + 1)
      if (selected.partial) headers['Content-Range'] = `bytes ${selected.start}-${selected.end}/${media.filesize}`
      return { status: selected.partial ? 206 : 200, headers, selected }
    })
    if (!('selected' in result) || !result.selected || !handle) return { status: result.status, headers, body: null }
    const file = handle
    let position = result.selected.start, closed = false
    const end = result.selected.end
    const close = async () => {
      if (closed) return
      closed = true
      req?.signal?.removeEventListener('abort', abort)
      await file.close()
    }
    let controller: ReadableStreamDefaultController<Uint8Array>
    const abort = () => { controller.error(new DOMException('Aborted', 'AbortError')); void close() }
    const body = new ReadableStream<Uint8Array>({
      start(c) { controller = c; req?.signal?.addEventListener('abort', abort, { once: true }); if (req?.signal?.aborted) abort() },
      async pull(c) {
        if (closed) return
        try {
          const bytes = Buffer.alloc(Math.min(64 * 1024, end - position + 1))
          const read = await file.read(bytes, 0, bytes.length, position)
          if (closed) return
          if (!read.bytesRead) throw new Error('media_unavailable')
          position += read.bytesRead
          c.enqueue(bytes.subarray(0, read.bytesRead))
          if (position > end) { c.close(); await close() }
        } catch (error) { if (!closed) c.error(error); await close() }
      },
      cancel: close,
    }, { highWaterMark: 0 })
    return { status: result.status, headers, body }
  } catch (error) {
    await handle?.close()
    const status = error instanceof APIError && [400, 401, 403, 404].includes(error.status) ? error.status : 503
    return { status, headers: { 'Cache-Control': 'private,no-store', 'X-Content-Type-Options': 'nosniff' }, body: null }
  }
}
