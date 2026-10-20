import { APIError, type Endpoint, type PayloadRequest } from 'payload'
import { assertEditorialOrigin } from '../auth/cookie'
import { PortalAuthError } from '../auth/portal-client'
import { readPortalPublicURL } from '../config/environment'
import type { EditorialErrorBody, SaveInput } from '../portal-pages/editorial-contracts'
import { EDITORIAL_HEADERS, EXISTING_JSON_BYTES, CREATE_JSON_BYTES } from '../portal-pages/editorial-contracts'
import { assertEditorialReadHeaders, requirePortalPageEditor } from '../portal-pages/editorial-auth'
import { readEditorialRevision, saveEditorialVersion, transitionEditorialPublication } from '../portal-pages/editorial-service'

const messages: Readonly<Record<string, string>> = {
  invalid_request: 'A solicitação editorial é inválida.',
  invalid_portal_page_editorial_request: 'A solicitação editorial é inválida.',
  invalid_portal_page_publication: 'A solicitação de publicação é inválida.',
  invalid_portal_page_content: 'Os campos da página são inválidos.',
  invalid_portal_page_title: 'Informe um título válido para a página.',
  invalid_portal_page_slug: 'Informe um endereço válido para a página.',
  invalid_portal_page_summary: 'O resumo da página é inválido.',
  invalid_portal_page_cover_alt: 'O texto alternativo da capa é inválido.',
  invalid_portal_page_rich_text: 'O conteúdo de texto rico é inválido.',
  portal_page_content_too_large: 'O conteúdo da página excede o limite permitido.',
  invalid_portal_page_category_reference: 'Uma categoria selecionada não está disponível.',
  invalid_portal_page_media_reference: 'Uma mídia selecionada não está disponível.',
  editorial_permission_denied: 'Permissão negada.',
  editorial_session_invalid: 'A sessão editorial expirou. Entre novamente.',
  portal_page_not_found: 'A página não foi encontrada.',
  portal_page_version_conflict: 'A página mudou desde a conferência. Confira a versão atual antes de continuar.',
  portal_page_not_published: 'A página já está como rascunho.',
  portal_page_editorial_unavailable: 'Não foi possível confirmar a operação. Consulte o estado antes de tentar novamente.',
  portal_page_version_state_unavailable: 'Não foi possível consultar a revisão da página.',
  portal_page_publication_scope_active: 'A publicação não pôde ser concluída.',
  request_too_large: 'O corpo da solicitação excede o limite permitido.',
}

const ALLOWED_STATUSES = new Set([400, 401, 403, 404, 409, 413])

function fail(code: string, status: number): APIError<{ [key: string]: unknown } | null> {
  return new APIError<{ [key: string]: unknown } | null>(code, status, undefined, true)
}

/** Read request bytes incrementally, cancelling the stream on all parse/limit failures. */
export async function readEditorialJSON(req: PayloadRequest, maxBytes: number): Promise<{ value: unknown; bytes: number }> {
  const rejectBeforeRead = async (code: string, status: number): Promise<never> => {
    if (req.body && !req.body.locked) await req.body.cancel().catch(() => {})
    throw fail(code, status)
  }
  if (!/^application\/json(?:\s*;|$)/iu.test(req.headers.get('content-type') || '')) {
    return rejectBeforeRead('invalid_request', 400)
  }
  const length = req.headers.get('content-length')
  if (length !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(length)) return rejectBeforeRead('invalid_request', 400)
    if (BigInt(length) > BigInt(maxBytes)) return rejectBeforeRead('request_too_large', 413)
  }
  if (req.signal?.aborted) return rejectBeforeRead('invalid_request', 400)
  const reader = req.body?.getReader()
  if (!reader) throw fail('invalid_request', 400)
  const chunks: Uint8Array[] = []
  let bytes = 0
  const onAbort = () => { void reader.cancel().catch(() => {}) }
  req.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      const part = await reader.read()
      if (req.signal?.aborted) throw fail('invalid_request', 400)
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > maxBytes) throw fail('request_too_large', 413)
      chunks.push(part.value)
    }
    const buffer = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), bytes)
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer) }
    catch { throw fail('invalid_request', 400) }
    try { return { value: JSON.parse(text) as unknown, bytes } }
    catch { throw fail('invalid_request', 400) }
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof APIError) throw error
    throw fail('invalid_request', 400)
  } finally {
    req.signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: EDITORIAL_HEADERS })
}

function safeError(error: unknown): Response {
  let code = 'portal_page_editorial_unavailable'
  let status = 503
  if (error instanceof PortalAuthError) {
    status = error.status
    code = error.reason
  } else if (error instanceof APIError && ALLOWED_STATUSES.has(error.status)) {
    status = error.status
    const candidate = error.message
    if (candidate === 'portal_page_content_too_large') status = 413
    code = Object.hasOwn(messages, candidate) ? candidate : status === 401 ? 'editorial_session_invalid'
      : status === 403 ? 'editorial_permission_denied' : status === 404 ? 'portal_page_not_found'
        : status === 409 ? 'portal_page_version_conflict' : status === 413 ? 'request_too_large' : 'invalid_request'
  }
  if (!Object.hasOwn(messages, code)) { code = 'portal_page_editorial_unavailable'; status = 503 }
  const body: EditorialErrorBody = { error: code, message: messages[code] }
  return json(body, status)
}

function queryID(req: PayloadRequest): string {
  const params = req.searchParams
  if (!params || params.getAll('id').length !== 1 || [...params.keys()].some(key => key !== 'id')) throw fail('invalid_request', 400)
  const id = params.get('id')
  if (!id) throw fail('invalid_request', 400)
  return id
}

async function revision(req: PayloadRequest): Promise<Response> {
  try {
    assertEditorialReadHeaders(req.headers)
    requirePortalPageEditor(req)
    return json(await readEditorialRevision(req, queryID(req)))
  } catch (error) { return safeError(error) }
}

async function post(req: PayloadRequest, operation: 'save' | 'publication'): Promise<Response> {
  try {
    assertEditorialOrigin(req.headers, readPortalPublicURL(process.env))
    requirePortalPageEditor(req)
    const cap = operation === 'save' ? CREATE_JSON_BYTES : EXISTING_JSON_BYTES
    const parsed = await readEditorialJSON(req, cap)
    if (operation === 'save') {
      const input = parsed.value as SaveInput
      if (input && typeof input === 'object' && !Array.isArray(input) &&
        Object.hasOwn(input, 'id') && (input as { id?: unknown }).id !== null &&
        parsed.bytes > EXISTING_JSON_BYTES) throw fail('request_too_large', 413)
      return json(await saveEditorialVersion(req, input), 201)
    }
    if (parsed.bytes > EXISTING_JSON_BYTES) throw fail('request_too_large', 413)
    return json(await transitionEditorialPublication(req, parsed.value as never))
  } catch (error) { return safeError(error) }
}

export const portalPageEditorialEndpoints: Endpoint[] = [
  { path: '/portal-page-editorial/revision', method: 'get', handler: req => revision(req) },
  { path: '/portal-page-editorial/save', method: 'post', handler: req => post(req, 'save') },
  { path: '/portal-page-editorial/publication', method: 'post', handler: req => post(req, 'publication') },
]
