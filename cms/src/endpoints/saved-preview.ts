import { APIError, type Endpoint, type PayloadRequest } from 'payload'
import { canReadNewsArea, type NewsAreaReadGate } from '../auth/news-area-access'
import { PortalAuthError } from '../auth/portal-client'
import { latestRevision } from '../publication/document'
import { withCmsTransaction } from '../publication/transaction'

const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)

export function createSavedPreviewEndpoint(readNewsArea: NewsAreaReadGate = canReadNewsArea): Endpoint {
  return { path: '/saved-preview', method: 'get', handler: async req => {
    try {
      if (!await readNewsArea(req as PayloadRequest)) throw new APIError('editorial_permission_denied', 403, undefined, true)
      const documentId = req.searchParams?.get('documentId')
      if (!uuid(documentId) || req.searchParams?.get('target') !== 'article') {
        throw new APIError('invalid_saved_preview', 400, undefined, true)
      }
      const revision = await withCmsTransaction(req.payload, req, request => latestRevision(request, 'news-articles', documentId))
      if (!revision) throw new APIError('news_saved_revision_required', 409, undefined, true)
      return Response.json({ versionId: revision.id, savedAt: revision.updatedAt },
        { headers: { 'Cache-Control': 'private,no-store' } })
    } catch (error) {
      const status = error instanceof APIError || error instanceof PortalAuthError ? error.status : 503
      return Response.json({ error: status === 409 ? 'news_saved_revision_required' : status === 400 ? 'invalid_saved_preview' :
        status === 403 ? 'editorial_permission_denied' : 'editorial_unavailable' },
      { status, headers: { 'Cache-Control': 'private,no-store' } })
    }
  } }
}

export const savedPreviewEndpoint = createSavedPreviewEndpoint()
