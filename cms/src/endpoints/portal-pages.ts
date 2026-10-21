import { APIError, type Endpoint, type PayloadRequest } from 'payload'
import { hasPortalPagesServiceAccess, portalPageActions, readPortalPageActor, readPortalPageInput,
  validPortalPageRequestID, type PortalPageAction } from '../auth/portal-pages-service-access'
import { readCmsEnvironment } from '../config/environment'
import { withCmsTransaction } from '../publication/transaction'
import { openPortalPageMedia, type PortalPageAssetResponse } from '../portal-pages/read-file'
import {
  queryPortalPageCategories,
  queryPortalPageAvailability,
  queryPortalPagePreview,
  queryPortalPagePublishedDetail,
  queryPortalPages,
  resolvePreviewPortalPageForAsset,
  resolvePublishedPortalPageForAsset,
} from '../portal-pages/reader'

const RESPONSE_HEADERS = { 'Cache-Control': 'private,no-store', 'X-Content-Type-Options': 'nosniff' }
const JSON_LIMIT_BYTES = 16 * 1024
const MiB = 1024 * 1024
const READ_BUDGET_MS = 4_000

type PortalPageReadOptions = { signal: AbortSignal; deadlineAt: number; cleanup: () => void }

function readBudget(req: PayloadRequest): PortalPageReadOptions {
  const raw = req.headers.get('x-request-deadline')
  let requestedDeadline = Date.now() + READ_BUDGET_MS
  if (raw !== null) {
    if (!/^[1-9][0-9]*$/u.test(raw) || !Number.isSafeInteger(Number(raw))) {
      throw new APIError('invalid_request', 400, undefined, true)
    }
    requestedDeadline = Number(raw)
  }
  const deadlineAt = Math.min(requestedDeadline, Date.now() + READ_BUDGET_MS)
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (req.signal?.aborted) controller.abort()
  else req.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, Math.max(0, deadlineAt - Date.now()))
  return { signal: controller.signal, deadlineAt, cleanup: () => {
    clearTimeout(timer)
    req.signal?.removeEventListener('abort', abort)
  } }
}

async function readRequestJSON(req: PayloadRequest, signal: AbortSignal | undefined = req.signal): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers.get('content-type') || '')) throw new APIError('invalid_request', 400, undefined, true)
  const length = req.headers.get('content-length')
  if (length !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(length) || Number(length) > JSON_LIMIT_BYTES)) {
    throw new APIError('invalid_request', Number(length) > JSON_LIMIT_BYTES ? 413 : 400, undefined, true)
  }
  const reader = req.body?.getReader()
  if (!reader) throw new APIError('invalid_request', 400, undefined, true)
  const chunks: Uint8Array[] = []
  let size = 0
  let abortListener: (() => void) | undefined
  const aborted = signal ? new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(new APIError('portal_pages_unavailable', 503, undefined, true))
    if (signal.aborted) abortListener()
    else signal.addEventListener('abort', abortListener, { once: true })
  }) : new Promise<never>(() => {})
  try {
    while (true) {
      const part = await Promise.race([reader.read(), aborted])
      if (part.done) break
      size += part.value.byteLength
      if (size > JSON_LIMIT_BYTES) throw new APIError('invalid_request', 413, undefined, true)
      if (signal?.aborted) throw new APIError('portal_pages_unavailable', 503, undefined, true)
      chunks.push(part.value)
    }
    if (signal?.aborted) throw new APIError('portal_pages_unavailable', 503, undefined, true)
    return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size).toString('utf8')) as unknown
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof APIError) throw error
    throw new APIError('invalid_request', 400, undefined, true)
  } finally {
    if (abortListener) signal?.removeEventListener('abort', abortListener)
    reader.releaseLock()
  }
}

function budgetedJSON(value: unknown, maxBytes: number, budget: PortalPageReadOptions): Response {
  const response = json(value, maxBytes)
  if (budget.signal.aborted || Date.now() >= budget.deadlineAt) throw new APIError('portal_pages_unavailable', 503, undefined, true)
  return response
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

async function readAssetResponse(req: PayloadRequest, actor: ReturnType<typeof readPortalPageActor>,
  input: ReturnType<typeof readPortalPageInput>, openAsset: typeof openPortalPageMedia): Promise<Response> {
  let opened: PortalPageAssetResponse | undefined
  let handedOff = false
  try {
    // Asset delivery must own transaction completion before the response body is handed to Next.
    const isolatedRequest = { ...req, transactionID: undefined } as PayloadRequest
    const result = await withCmsTransaction(req.payload, isolatedRequest, async transactionReq => {
      const page = input.preview
        ? await resolvePreviewPortalPageForAsset(transactionReq, input.pageId as string, input.revisionId as string, actor)
        : await resolvePublishedPortalPageForAsset(transactionReq, input.pageId as string, input.revisionId as string)
      if (!page) throw new APIError('not_found', 404, undefined, true)
      const media = page.media.get(input.assetId as string)
      if (!media) throw new APIError('not_found', 404, undefined, true)
      const { uploadDir } = readCmsEnvironment(process.env)
      opened = await openAsset({ uploadDir, media, range: input.range as string | null, signal: req.signal })
      return opened
    })
    const response = new Response(result.body, { status: result.status, headers: result.headers })
    handedOff = true
    return response
  } finally {
    if (!handedOff && opened?.body) await opened.body.cancel().catch(() => {})
  }
}

async function handle(action: PortalPageAction, req: PayloadRequest, openAsset: typeof openPortalPageMedia): Promise<Response> {
  let budget: PortalPageReadOptions | undefined
  try {
    if (!hasPortalPagesServiceAccess(req)) throw new APIError('forbidden', 403, undefined, true)
    if (!validPortalPageRequestID(req.headers.get('x-request-id'))) throw new APIError('invalid_request', 400, undefined, true)
    budget = action === 'asset' ? undefined : readBudget(req)
    if (budget?.signal?.aborted || (budget && Date.now() >= budget.deadlineAt)) {
      throw new APIError('portal_pages_unavailable', 503, undefined, true)
    }
    const body = await readRequestJSON(req, budget?.signal || req.signal)
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 ||
      !Object.hasOwn(body, 'actor') || !Object.hasOwn(body, 'input')) throw new APIError('invalid_request', 400, undefined, true)
    const request = body as Record<string, unknown>
    const actor = readPortalPageActor(request.actor)
    const input = readPortalPageInput(action, request.input)
    if (action === 'asset') return await readAssetResponse(req, actor, input, openAsset)
    if (!budget) throw new APIError('portal_pages_unavailable', 503, undefined, true)
    if (action === 'availability') {
      const available = await queryPortalPageAvailability(req, actor, budget)
      return budgetedJSON({ available }, 1024, budget)
    }
    if (action === 'list') return budgetedJSON(await queryPortalPages(req, input as never, actor, budget), 16 * MiB, budget)
    if (action === 'categories') return budgetedJSON(await queryPortalPageCategories(req, actor, budget), 16 * MiB, budget)
    if (action === 'detail') {
      const result = await queryPortalPagePublishedDetail(req, input.slug as string, actor, budget)
      if (!result) throw new APIError('not_found', 404, undefined, true)
      return budgetedJSON(result, 6 * MiB, budget)
    }
    const result = await queryPortalPagePreview(req, input.pageId as string, input.versionId as string, actor, budget)
    if (!result) throw new APIError('not_found', 404, undefined, true)
    return budgetedJSON(result, 6 * MiB, budget)
  } catch (error) { return responseError(error) }
  finally { budget?.cleanup() }
}

export function createPortalPageReadEndpoints(options: { openAsset?: typeof openPortalPageMedia } = {}): Endpoint[] {
  const openAsset = options.openAsset || openPortalPageMedia
  return portalPageActions.map(action => ({
    path: `/portal-pages/${action}`,
    method: 'post',
    handler: req => handle(action, req, openAsset),
  }))
}

export const portalPageReadEndpoints: Endpoint[] = createPortalPageReadEndpoints()
