import { APIError, type Endpoint, type PayloadRequest } from 'payload'
import { hasPortalPagesServiceAccess, portalPageActions, readPortalPageActor, readPortalPageInput,
  validPortalPageRequestID, type PortalPageAction } from '../auth/portal-pages-service-access'
import { readCmsEnvironment } from '../config/environment'
import { withCmsTransaction } from '../publication/transaction'
import { openPortalPageMedia } from '../portal-pages/read-file'
import {
  queryPortalPageCategories,
  queryPortalPagePreview,
  queryPortalPagePublishedDetail,
  queryPortalPages,
  resolvePreviewPortalPageForAsset,
  resolvePublishedPortalPageForAsset,
} from '../portal-pages/reader'

const RESPONSE_HEADERS = { 'Cache-Control': 'private,no-store', 'X-Content-Type-Options': 'nosniff' }
const JSON_LIMIT_BYTES = 16 * 1024
const MiB = 1024 * 1024

async function readRequestJSON(req: PayloadRequest): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers.get('content-type') || '')) throw new APIError('invalid_request', 400, undefined, true)
  const length = req.headers.get('content-length')
  if (length !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(length) || Number(length) > JSON_LIMIT_BYTES)) {
    throw new APIError('invalid_request', Number(length) > JSON_LIMIT_BYTES ? 413 : 400, undefined, true)
  }
  const reader = req.body?.getReader()
  if (!reader) throw new APIError('invalid_request', 400, undefined, true)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > JSON_LIMIT_BYTES || req.signal?.aborted) throw new APIError('invalid_request', size > JSON_LIMIT_BYTES ? 413 : 400, undefined, true)
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size).toString('utf8')) as unknown
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof APIError) throw error
    throw new APIError('invalid_request', 400, undefined, true)
  } finally { reader.releaseLock() }
}

function responseError(error: unknown): Response {
  const status = error instanceof APIError && [400, 403, 404, 413].includes(error.status) ? error.status : 503
  return Response.json({ error: status === 404 ? 'not_found' : status === 403 ? 'forbidden'
    : status === 400 || status === 413 ? 'invalid_request' : 'portal_pages_unavailable' }, { status, headers: RESPONSE_HEADERS })
}

function json(value: unknown, maxBytes: number): Response {
  const serialized = JSON.stringify(value)
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new APIError('portal_pages_unavailable', 503, undefined, true)
  return new Response(serialized, { status: 200, headers: { ...RESPONSE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } })
}

async function handle(action: PortalPageAction, req: PayloadRequest): Promise<Response> {
  try {
    if (!hasPortalPagesServiceAccess(req)) throw new APIError('forbidden', 403, undefined, true)
    if (!validPortalPageRequestID(req.headers.get('x-request-id'))) throw new APIError('invalid_request', 400, undefined, true)
    const body = await readRequestJSON(req)
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 ||
      !Object.hasOwn(body, 'actor') || !Object.hasOwn(body, 'input')) throw new APIError('invalid_request', 400, undefined, true)
    const request = body as Record<string, unknown>
    const actor = readPortalPageActor(request.actor)
    const input = readPortalPageInput(action, request.input)
    if (action === 'asset') {
      const result = await withCmsTransaction(req.payload, req, async transactionReq => {
        const page = input.preview
          ? await resolvePreviewPortalPageForAsset(transactionReq, input.pageId as string, input.revisionId as string, actor)
          : await resolvePublishedPortalPageForAsset(transactionReq, input.pageId as string, input.revisionId as string)
        if (!page) throw new APIError('not_found', 404, undefined, true)
        const media = page.media.get(input.assetId as string)
        if (!media) throw new APIError('not_found', 404, undefined, true)
        const { uploadDir } = readCmsEnvironment(process.env)
        return openPortalPageMedia({ uploadDir, media, range: input.range as string | null, signal: req.signal })
      })
      return new Response(result.body, { status: result.status, headers: result.headers })
    }
    if (action === 'list') return json(await queryPortalPages(req, input as never, actor), 16 * MiB)
    if (action === 'categories') return json(await queryPortalPageCategories(req, actor), 16 * MiB)
    if (action === 'detail') {
      const result = await queryPortalPagePublishedDetail(req, input.slug as string, actor)
      if (!result) throw new APIError('not_found', 404, undefined, true)
      return json(result, 6 * MiB)
    }
    const result = await queryPortalPagePreview(req, input.pageId as string, input.versionId as string, actor)
    if (!result) throw new APIError('not_found', 404, undefined, true)
    return json(result, 6 * MiB)
  } catch (error) { return responseError(error) }
}

export const portalPageReadEndpoints: Endpoint[] = portalPageActions.map(action => ({
  path: `/portal-pages/${action}`,
  method: 'post',
  handler: req => handle(action, req),
}))
