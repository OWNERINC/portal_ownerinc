import { APIError, type Endpoint, type PayloadRequest } from 'payload'
import { PortalAuthError } from '../auth/portal-client'
import { assertEditorialOrigin } from '../auth/cookie'
import { readPortalPublicURL } from '../config/environment'
import { readRestoreDraft, restoreNewsDraft } from '../publication/restore-draft'
import { registerRestoreEndpoint } from '../config/editorial-profile'

async function restoreBody(req: PayloadRequest) {
  if (!/^application\/json(?:;|$)/iu.test(req.headers.get('content-type') || '')) throw new APIError('invalid_restore_request', 400)
  const reader = req.body?.getReader()
  if (!reader) throw new APIError('invalid_restore_request', 400)
  let length = 0; const chunks: Uint8Array[] = []
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break
      length += part.value.byteLength
      if (length > 4096 || req.signal?.aborted) throw new APIError('invalid_restore_request', 400)
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch { await reader.cancel().catch(() => {}); throw new APIError('invalid_restore_request', 400) }
  finally { reader.releaseLock() }
}
export const newsRestoreDraftEndpoints: Endpoint[] = (['get', 'post'] as const).map(method => ({
  path: '/news-restore-draft', method, handler: registerRestoreEndpoint(method, async req => {
    const headers = { 'Cache-Control': 'private,no-store' }
    try {
      if (method === 'post') {
        assertEditorialOrigin(req.headers, readPortalPublicURL(process.env))
        return Response.json(await restoreNewsDraft(req, await restoreBody(req)), { headers })
      }
      const query = req.searchParams
      if (!query || [...query.keys()].some(key => query.getAll(key).length !== 1)) throw new APIError('invalid_restore_request', 400)
      return Response.json(await readRestoreDraft(req, Object.fromEntries(query)), { headers })
    } catch (error) {
      const status = error instanceof APIError || error instanceof PortalAuthError ? error.status : 503
      const safe = [400, 401, 403, 404, 409].includes(status) ? status : 503
      return Response.json({ error: safe === 409 ? 'news_restore_conflict' : safe === 404 ? 'news_version_not_found' :
        safe === 400 ? 'invalid_restore_request' : safe === 401 ? 'editorial_session_invalid' : safe === 403 ? 'editorial_permission_denied' : 'editorial_unavailable' }, { status: safe, headers })
    }
  }),
}))
