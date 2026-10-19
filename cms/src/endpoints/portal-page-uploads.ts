import { APIError, type Endpoint, type PayloadRequest } from 'payload'
import { isVerifiedNewsActor } from '../auth/access'
import { canManagePortalPages } from '../auth/portal-pages-access'
import { assertEditorialOrigin } from '../auth/cookie'
import { PortalAuthError } from '../auth/portal-client'
import { parseAdminActor } from '../contracts/admin'
import { readCmsEnvironment, readPortalPublicURL } from '../config/environment'
import { createPortalPageUploadService, PortalPageUploadError } from '../portal-pages/upload-service'

const RESPONSE_HEADERS = { 'Cache-Control': 'private,no-store', 'X-Content-Type-Options': 'nosniff' }
const JSON_LIMIT_BYTES = 16 * 1024
const messages: Record<string, string> = {
  invalid_request: 'A solicitação é inválida.', unsupported_media: 'Este tipo de arquivo não é aceito.',
  media_too_large: 'O arquivo excede o limite permitido.', invalid_chunk: 'O bloco enviado é inválido.',
  invalid_chunk_size: 'O tamanho do bloco não corresponde ao esperado.', invalid_upload_body: 'O conteúdo enviado é inválido.',
  invalid_media_file: 'O arquivo não corresponde ao formato declarado.', invalid_upload_token: 'O token de upload é inválido.',
  chunk_conflict: 'Este bloco já foi enviado com conteúdo diferente.', upload_incomplete: 'O envio ainda não está completo.',
  upload_busy: 'Este envio está sendo processado. Tente novamente.', upload_limit_reached: 'Há muitos envios ativos. Tente novamente mais tarde.',
  media_already_complete: 'Uma mídia concluída não pode ser cancelada.', insufficient_disk_space: 'Não há espaço disponível para este envio.',
  disk_unavailable: 'O armazenamento não está disponível.', storage_unavailable: 'Não foi possível acessar o armazenamento.',
  upload_unavailable: 'Não foi possível concluir o envio.', upload_not_found: 'O envio não foi encontrado.',
  forbidden: 'Permissão negada.', editorial_session_invalid: 'A sessão editorial expirou. Entre novamente.',
}

function currentEditorUID(req: PayloadRequest): string {
  if (!canManagePortalPages({ req })) throw new PortalPageUploadError('forbidden', 403)
  const user = req.user as (NonNullable<PayloadRequest['user']> & {
    portalUid?: string
    portalActor?: { uid: string; canManageNews: boolean }
    adminActor?: unknown
    adminExpiresAt?: string
    portalExpiresAt?: string
  }) | null
  if (!user || user.collection !== 'portal-editors' || typeof user.portalUid !== 'string') throw new PortalPageUploadError('forbidden', 403)
  const adminActor = parseAdminActor(user.adminActor)
  if (adminActor?.capabilities.manageKnowledge === true && adminActor.uid === user.portalUid) {
    if (!Number.isFinite(Date.parse(user.adminExpiresAt || '')) || Date.parse(user.adminExpiresAt || '') <= Date.now()) {
      throw new PortalAuthError(401)
    }
    return adminActor.uid
  }
  if (isVerifiedNewsActor(user as never)) {
    if (!Number.isFinite(Date.parse(user.portalExpiresAt || '')) || Date.parse(user.portalExpiresAt || '') <= Date.now()) {
      throw new PortalAuthError(401)
    }
    return user.portalActor!.uid
  }
  throw new PortalPageUploadError('forbidden', 403)
}

async function readJson(req: PayloadRequest): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers.get('content-type') || '')) throw new PortalPageUploadError('invalid_request', 400)
  const length = req.headers.get('content-length')
  if (length !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(length) || Number(length) > JSON_LIMIT_BYTES)) {
    throw new PortalPageUploadError(Number(length) > JSON_LIMIT_BYTES ? 'invalid_request' : 'invalid_request', Number(length) > JSON_LIMIT_BYTES ? 413 : 400)
  }
  const reader = req.body?.getReader()
  if (!reader) throw new PortalPageUploadError('invalid_request', 400)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > JSON_LIMIT_BYTES || req.signal?.aborted) throw new PortalPageUploadError('invalid_request', size > JSON_LIMIT_BYTES ? 413 : 400)
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size).toString('utf8')) as unknown
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof PortalPageUploadError) throw error
    throw new PortalPageUploadError('invalid_request', 400)
  } finally { reader.releaseLock() }
}

function safeResponse(error: unknown): Response {
  let status = 503, code = 'upload_unavailable'
  if (error instanceof PortalPageUploadError) { status = error.status; code = error.code }
  else if (error instanceof PortalAuthError) {
    status = error.status
    code = status === 401 ? 'editorial_session_invalid' : status === 403 ? 'forbidden' : 'upload_unavailable'
  } else if (error instanceof APIError && [400, 401, 403, 404, 409, 413, 415, 429, 507].includes(error.status)) {
    status = error.status
    code = status === 401 ? 'editorial_session_invalid' : status === 403 ? 'forbidden' : 'upload_unavailable'
  }
  if (!Object.hasOwn(messages, code)) code = 'upload_unavailable'
  return Response.json({ error: code, message: messages[code] }, { status, headers: RESPONSE_HEADERS })
}

function service(req: PayloadRequest, uid: string) {
  const environment = readCmsEnvironment(process.env)
  return createPortalPageUploadService({ payload: req.payload, req, actorUid: uid, uploadDir: environment.uploadDir })
}

async function run(req: PayloadRequest, operation: 'init' | 'chunk' | 'complete' | 'cancel'): Promise<Response> {
  try {
    assertEditorialOrigin(req.headers, readPortalPublicURL(process.env))
    const uid = currentEditorUID(req)
    const uploads = service(req, uid)
    if (operation === 'init') return Response.json(await uploads.init(await readJson(req)), { status: 201, headers: RESPONSE_HEADERS })
    const id = req.routeParams?.id
    if (operation === 'chunk') {
      const result = await uploads.putChunk(id, req.routeParams?.index, req.headers, req.body as ReadableStream<Uint8Array> | null)
      return Response.json(result, { headers: RESPONSE_HEADERS })
    }
    if (operation === 'complete') return Response.json(await uploads.complete(id, await readJson(req)), { headers: RESPONSE_HEADERS })
    return Response.json(await uploads.cancel(id, await readJson(req)), { headers: RESPONSE_HEADERS })
  } catch (error) { return safeResponse(error) }
}

export const portalPageUploadEndpoints: Endpoint[] = [
  { path: '/portal-page-uploads/init', method: 'post', handler: req => run(req, 'init') },
  { path: '/portal-page-uploads/:id/chunks/:index', method: 'put', handler: req => run(req, 'chunk') },
  { path: '/portal-page-uploads/:id/complete', method: 'post', handler: req => run(req, 'complete') },
  { path: '/portal-page-uploads/:id', method: 'delete', handler: req => run(req, 'cancel') },
]
