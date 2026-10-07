import { APIError, type Endpoint, type PayloadRequest } from 'payload'
import { hasNewsServiceAccess, newsActions, readNewsActor, readNewsInput } from '../auth/service-access'
import { keys, record } from '../news/primitives'
import { openNewsMedia } from '../media/read-file'
import { queryPublishedNews, queryNewsDetail, queryNewsCategories, queryNewsNavigation, queryNewsHome, queryNewsPreview } from '../news/queries'

async function body(req: PayloadRequest) {
  if (!/^application\/json(?:;|$)/iu.test(req.headers.get('content-type') || '')) throw new APIError('invalid_request', 400)
  const reader = req.body?.getReader()
  if (!reader) throw new APIError('invalid_request', 400)
  let bytes = 0; const chunks: Uint8Array[] = []
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 16 * 1024 || req.signal?.aborted) throw new APIError('invalid_request', 400)
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch { await reader.cancel().catch(() => {}); throw new APIError('invalid_request', 400) }
  finally { reader.releaseLock() }
}
export const portalNewsEndpoints: Endpoint[] = newsActions.map(action => ({ path: `/portal-news/${action}`, method: 'post', handler: async req => {
  const headers = { 'Cache-Control': 'private,no-store' }
  try {
    if (!hasNewsServiceAccess(req)) throw new APIError('forbidden', 403)
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(req.headers.get('x-request-id') || '')) throw new APIError('invalid_request', 400)
    const request = record(await body(req)); keys(request, ['actor', 'input'])
    const actor = readNewsActor(request.actor)
    switch (action) {
      case 'asset': {
        const input = readNewsInput(action, request.input)
        const result = await openNewsMedia({ payload: req.payload, req, actor, ...input })
        return new Response(result.body, { status: result.status, headers: result.headers })
      }
      case 'list': return Response.json(await queryPublishedNews(req, readNewsInput(action, request.input), actor), { headers })
      case 'detail': return Response.json(await queryNewsDetail(req, readNewsInput(action, request.input), actor), { headers })
      case 'categories': return Response.json(await queryNewsCategories(req, readNewsInput(action, request.input), actor), { headers })
      case 'navigation': return Response.json(await queryNewsNavigation(req, readNewsInput(action, request.input), actor), { headers })
      case 'home': return Response.json(await queryNewsHome(req, readNewsInput(action, request.input), actor), { headers })
      case 'preview': return Response.json(await queryNewsPreview(req, readNewsInput(action, request.input), actor), { headers })
    }
  } catch (error) {
    const status = error instanceof APIError && [400, 403, 404].includes(error.status) ? error.status : 503
    return Response.json({ error: status === 400 ? 'invalid_request' : status === 403 ? 'forbidden' : status === 404 ? 'not_found' : 'news_unavailable' }, { status, headers })
  }
} }))
