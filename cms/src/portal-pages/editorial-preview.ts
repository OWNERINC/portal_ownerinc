import { APIError, type PayloadRequest } from 'payload'
import { PortalAuthError } from '../auth/portal-client'
import { readCmsEnvironment } from '../config/environment'
import { EDITORIAL_HEADERS } from './editorial-contracts'
import type { PortalPageDTO } from './contracts'
import { assertEditorialReadHeaders, requirePortalPageEditor } from './editorial-auth'
import { openPortalPageMedia } from './read-file'
import type { PortalPageAssetResponse } from './read-file'
import { resolvePreviewPortalPageForAsset, queryPortalPagePreviewWithSavedAt } from './reader'
import type { PortalPageReadActor } from './reader'
import { withCmsTransaction } from '../publication/transaction'
import { uuid } from './primitives'
import type { PortalPageMediaReadRecord } from './persistence'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const SAFE_MEDIA_EXTENSIONS: Readonly<Record<PortalPageMediaReadRecord['mimeType'], string>> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'application/pdf': 'pdf', 'video/mp4': 'mp4', 'video/webm': 'webm',
}

const notFound = () => new APIError('portal_page_not_found', 404, undefined, true)
const unavailable = () => new APIError('portal_page_editorial_unavailable', 503, undefined, true)

function strictUUID(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new APIError('invalid_request', 400, undefined, true)
  return uuid(value, 'invalid_request')
}

/** Read a specific saved version and its timestamp under one lock-free imported snapshot. */
export async function loadEditorialPreview(req: PayloadRequest, rawPageID: string, rawVersionID: string):
Promise<{ dto: PortalPageDTO; savedAt: string }> {
  assertEditorialReadHeaders(req.headers)
  const actor: PortalPageReadActor = requirePortalPageEditor(req)
  const pageID = strictUUID(rawPageID)
  const versionID = strictUUID(rawVersionID)

  const result = await queryPortalPagePreviewWithSavedAt(req, pageID, versionID, actor)
  if (!result || result.dto.id !== pageID || result.dto.revision.id !== versionID) throw notFound()
  return result
}

function safeAssetError(error: unknown): Response {
  let status = 503
  let code = 'portal_page_editorial_unavailable'
  if (error instanceof PortalAuthError) {
    status = error.status
    code = error.reason
  } else if (error instanceof APIError) {
    if ([400, 401, 403, 404, 409, 413].includes(error.status)) status = error.status
    if (error.message === 'invalid_request') code = 'invalid_request'
    else if (error.message === 'editorial_permission_denied') code = 'editorial_permission_denied'
    else if (error.message === 'editorial_session_invalid') code = 'editorial_session_invalid'
    else if (error.status === 400 || error.status === 404 || error.message === 'invalid_portal_page_media_reference') {
      status = 404
      code = 'portal_page_not_found'
    }
  }
  const messages: Record<string, string> = {
    invalid_request: 'A solicitação editorial é inválida.',
    editorial_permission_denied: 'Permissão negada.',
    editorial_session_invalid: 'A sessão editorial expirou. Entre novamente.',
    portal_page_not_found: 'A página ou o arquivo não foi encontrado.',
    portal_page_editorial_unavailable: 'Não foi possível carregar a prévia agora.',
  }
  return Response.json({ error: code, message: messages[code] || messages.portal_page_editorial_unavailable },
    { status, headers: EDITORIAL_HEADERS })
}

/** Factory seam keeps endpoint ownership/failure behavior observable in tests. */
export function createEditorialPreviewAssetReader(
  openMedia: typeof openPortalPageMedia = openPortalPageMedia,
): (req: PayloadRequest) => Promise<Response> {
  return async (req: PayloadRequest): Promise<Response> => {
    let opened: PortalPageAssetResponse | undefined
    let extension: string | undefined
    try {
      assertEditorialReadHeaders(req.headers)
      const actor = requirePortalPageEditor(req)
      const route = req.routeParams as Record<string, unknown> | undefined
      const pageID = strictUUID(route?.pageId)
      const versionID = strictUUID(route?.versionId)
      const assetID = strictUUID(route?.assetId)
      const uploadDir = readCmsEnvironment(process.env).uploadDir
      // Never inherit a caller's transaction for an asset GET. The descriptor is
      // opened while reference rows are locked, then the transaction commits before
      // its stream is handed to Next/Fetch.
      const freshReq = { ...req, transactionID: undefined, context: { ...req.context } }
      const result = await withCmsTransaction(req.payload, freshReq, async transactionReq => {
        const page = await resolvePreviewPortalPageForAsset(transactionReq, pageID, versionID, actor)
        const media = page?.media.get(assetID)
        if (!media || media.state !== 'complete') throw notFound()
        extension = SAFE_MEDIA_EXTENSIONS[media.mimeType]
        if (!extension) throw unavailable()
        opened = await openMedia({ uploadDir, media, range: req.headers.get('range'), signal: req.signal })
        return opened
      })
      if (!extension) throw unavailable()
      const headers = new Headers({ ...EDITORIAL_HEADERS, ...result.headers })
      // Storage keys and original upload names are private implementation data.
      // The public name is derived only from the validated asset ID and MIME.
      headers.set('Content-Disposition', `inline; filename="portal-page-${assetID}.${extension}"`)
      return new Response(result.body, { status: result.status, headers })
    } catch (error) {
      // A commit can fail after a descriptor has been opened. The body has not
      // crossed the response boundary yet, so close it and disclose no bytes.
      await opened?.body?.cancel().catch(() => {})
      return safeAssetError(error)
    }
  }
}

/** Freshly authorize and open one private asset for this exact saved version. */
export const readEditorialPreviewAsset = createEditorialPreviewAssetReader()
