export type MediaKind = 'image' | 'video' | 'pdf'

export type CompleteMedia = {
  id: string
  state: 'complete'
  mimeType: string
  bytes: number
  sha256: string
  completedAt: string
}

export type UploadProgress = {
  phase: 'preparing' | 'uploading' | 'validating' | 'ready' | 'cancelling' | 'cancelled' | 'error'
  confirmedBytes: number
  totalBytes: number
  index: number
  count: number
}

export type Destination = {
  documentID: string
  path: string
  blockID: string | null
  galleryItemID: string | null
  generation: number
}

export const PORTAL_PAGE_UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024
export const PORTAL_PAGE_UPLOAD_RETRY_DELAYS = [1000, 2000, 4000] as const
export const PORTAL_PAGE_UPLOAD_ACCEPT: Record<MediaKind, string> = {
  image: '.jpg,.jpeg,.png,.webp',
  video: '.mp4,.webm',
  pdf: '.pdf',
}

const MiB = 1024 * 1024
const UPLOAD_BASE = '/editorial/api/portal-page-uploads'
const MEDIA_BASE = '/editorial/api/portal-page-media'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const TOKEN = /^[A-Za-z0-9_-]{43}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const MIME_BY_KIND: Record<MediaKind, readonly string[]> = {
  image: ['image/jpeg', 'image/png', 'image/webp'],
  video: ['video/mp4', 'video/webm'],
  pdf: ['application/pdf'],
}
const MAX_BYTES: Record<string, number> = {
  'image/jpeg': 15 * MiB,
  'image/png': 15 * MiB,
  'image/webp': 15 * MiB,
  'application/pdf': 100 * MiB,
  'video/mp4': 500 * MiB,
  'video/webm': 500 * MiB,
}
const EXTENSION_MIME: Record<MediaKind, Record<string, string>> = {
  image: { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' },
  video: { '.mp4': 'video/mp4', '.webm': 'video/webm' },
  pdf: { '.pdf': 'application/pdf' },
}
const EXTENSION_LABEL: Record<MediaKind, string> = {
  image: 'JPG, PNG ou WebP, até 15 MiB.',
  video: 'MP4 ou WebM, até 500 MiB.',
  pdf: 'PDF, até 100 MiB.',
}

export class UploadClientError extends Error {
  readonly code: string | null
  readonly status: number | null
  readonly retryable: boolean

  constructor(message: string, options: { code?: string | null; status?: number | null; retryable?: boolean } = {}) {
    super(message)
    this.name = 'UploadClientError'
    this.code = options.code ?? null
    this.status = options.status ?? null
    this.retryable = options.retryable === true
  }
}

function fail(message = 'A resposta do envio não pôde ser confirmada.'): never {
  throw new UploadClientError(message, { code: 'invalid_upload_response' })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

/** Resolve only the closed extension/MIME table; an empty declared MIME is the sole inference case. */
export function validateUploadFile(file: Pick<File, 'name' | 'type' | 'size'>, kind: MediaKind): { mimeType: string; bytes: number } {
  if (!file || typeof file.name !== 'string' || typeof file.type !== 'string' ||
    !Number.isSafeInteger(file.size) || file.size < 1) {
    throw new UploadClientError('Escolha um arquivo válido.', { code: 'invalid_file' })
  }
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
  const expectedMime = EXTENSION_MIME[kind][extension]
  if (!expectedMime || (file.type !== '' && file.type !== expectedMime)) {
    throw new UploadClientError(`Formato inválido. ${EXTENSION_LABEL[kind]}`, { code: 'unsupported_media' })
  }
  if (file.size > MAX_BYTES[expectedMime]!) {
    throw new UploadClientError(`O arquivo excede o limite permitido. ${EXTENSION_LABEL[kind]}`, { code: 'media_too_large' })
  }
  return { mimeType: expectedMime, bytes: file.size }
}

export function sameDestination(a: Destination, b: Destination): boolean {
  return a.documentID === b.documentID && a.path === b.path && a.blockID === b.blockID &&
    a.galleryItemID === b.galleryItemID && a.generation === b.generation
}

/** A row-backed destination is selectable only after Payload assigns its native IDs. */
export function isDestinationSelectable(destination: Destination, kind: MediaKind): boolean {
  if (destination.path === 'cover') return kind === 'image' && destination.blockID === null && destination.galleryItemID === null
  const simple = destination.path.match(/^body\.(\d+)\.asset$/u)
  if (simple) return typeof destination.blockID === 'string' && destination.blockID.length > 0 && destination.galleryItemID === null
  const gallery = destination.path.match(/^body\.(\d+)\.images\.(\d+)\.asset$/u)
  if (gallery) return kind === 'image' && typeof destination.blockID === 'string' && destination.blockID.length > 0 &&
    typeof destination.galleryItemID === 'string' && destination.galleryItemID.length > 0
  return false
}

const documentUploadOwners = new Map<string | object, object>()

function uploadMutexKey(documentID: string, formIdentity: object): string | object {
  return documentID ? `portal-page-upload:${documentID}` : formIdentity
}

/** Synchronous ownership prevents same-tick starts before Payload's uploadStatus rerenders. */
export function claimPortalPageUpload(documentID: string, formIdentity: object, owner: object): boolean {
  const key = uploadMutexKey(documentID, formIdentity)
  const existing = documentUploadOwners.get(key)
  if (existing && existing !== owner) return false
  documentUploadOwners.set(key, owner)
  return true
}

export function releasePortalPageUpload(documentID: string, formIdentity: object, owner: object): boolean {
  const key = uploadMutexKey(documentID, formIdentity)
  if (documentUploadOwners.get(key) !== owner) return false
  documentUploadOwners.delete(key)
  return true
}

export function portalPageUploadIsOwnedByOther(documentID: string, formIdentity: object, owner: object): boolean {
  const existing = documentUploadOwners.get(uploadMutexKey(documentID, formIdentity))
  return existing !== undefined && existing !== owner
}

type ResponseData = { status: number; body: unknown }
type RequestStage = 'init' | 'chunk' | 'complete' | 'cancel' | 'read'

function errorMessage(code: string | null, status: number, stage: RequestStage): string {
  if (stage === 'init' && code === 'upload_limit_reached') {
    return 'Há muitos envios ativos: o limite é de dois uploads por editor e oito no total. Tente novamente mais tarde.'
  }
  if (status === 401 || code === 'editorial_session_invalid') return 'A sessão editorial expirou. Entre novamente.'
  if (status === 403 || code === 'forbidden') return 'Permissão negada para enviar esta mídia.'
  if (code === 'upload_limit_reached') return 'Há muitos envios ativos: o limite é de dois uploads por editor e oito no total. Tente novamente mais tarde.'
  if (code === 'upload_busy') return 'Este envio está sendo processado. Tente novamente.'
  if (code === 'unsupported_media') return 'Este tipo de arquivo não é aceito.'
  if (code === 'media_too_large') return 'O arquivo excede o limite permitido.'
  if (code === 'chunk_conflict') return 'O bloco enviado diverge do que já foi recebido. O envio foi interrompido.'
  if (code === 'invalid_upload_token') return 'A sessão de envio expirou. Não é seguro continuar este envio.'
  if (status === 404 || code === 'upload_not_found') return 'O envio ou a mídia não foi encontrado.'
  if (status === 507 || code === 'insufficient_disk_space') return 'Não há espaço disponível para este envio.'
  if (stage === 'read') return 'Não foi possível confirmar a mídia concluída. Atualize o estado antes de selecionar.'
  return 'Não foi possível concluir o envio. Confira o estado antes de tentar novamente.'
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function retryableError(error: unknown, policy: 'transfer' | 'cancel'): error is UploadClientError {
  if (!(error instanceof UploadClientError)) return false
  if (error.code === 'network_failure' || error.code === 'upload_busy') return true
  return policy === 'transfer' && (error.status === 429 || error.status === 503)
}

async function responseData(fetcher: typeof fetch, url: string, init: RequestInit, stage: RequestStage): Promise<ResponseData> {
  let response: Response
  try {
    response = await fetcher(url, init)
  } catch (error) {
    if (isAbort(error)) throw error
    throw new UploadClientError(errorMessage(null, 0, stage), { code: 'network_failure', retryable: true })
  }

  let body: unknown
  try { body = await response.json() }
  catch {
    if (response.ok) fail()
    body = null
  }
  if (!response.ok) {
    const candidate = isRecord(body) && typeof body.error === 'string' && /^[a-z0-9_]{1,80}$/u.test(body.error)
      ? body.error : null
    throw new UploadClientError(errorMessage(candidate, response.status, stage), {
      code: candidate, status: response.status,
      retryable: candidate === 'upload_busy' || response.status === 429 || response.status === 503,
    })
  }
  return { status: response.status, body }
}

function exactSuccessfulBody(data: ResponseData, status: number, keys: readonly string[]): Record<string, unknown> {
  if (data.status !== status || !isRecord(data.body) || !hasExactKeys(data.body, keys)) fail()
  return data.body
}

function validateComplete(value: unknown, expected: { id: string; mimeType: string; bytes: number }): CompleteMedia {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'state', 'mimeType', 'bytes', 'sha256', 'completedAt']) ||
    value.id !== expected.id || !UUID.test(String(value.id)) || value.state !== 'complete' ||
    value.mimeType !== expected.mimeType || value.bytes !== expected.bytes || !Number.isSafeInteger(value.bytes) ||
    typeof value.sha256 !== 'string' || !SHA256.test(value.sha256) || !validDate(value.completedAt)) fail()
  return { id: value.id, state: 'complete', mimeType: value.mimeType, bytes: value.bytes,
    sha256: value.sha256, completedAt: value.completedAt }
}

function validateInit(value: unknown, expected: { mimeType: string; bytes: number }): {
  id: string; token: string; chunkCount: number
} {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'token', 'chunkSize', 'chunkCount', 'bytes', 'mimeType']) ||
    typeof value.id !== 'string' || !UUID.test(value.id) || typeof value.token !== 'string' || !TOKEN.test(value.token) ||
    value.chunkSize !== PORTAL_PAGE_UPLOAD_CHUNK_SIZE || value.bytes !== expected.bytes || value.mimeType !== expected.mimeType ||
    !Number.isSafeInteger(value.chunkCount) || value.chunkCount !== Math.ceil(expected.bytes / PORTAL_PAGE_UPLOAD_CHUNK_SIZE) ||
    value.chunkCount < 1 || value.chunkCount > 100) fail()
  return { id: value.id, token: value.token, chunkCount: value.chunkCount }
}

function validateChunk(value: unknown, expected: { id: string; index: number }): void {
  if (!isRecord(value) || typeof value.duplicate !== 'boolean') fail()
  const keys = value.duplicate ? ['id', 'index', 'received', 'duplicate'] : ['id', 'index', 'received', 'duplicate', 'sha256']
  if (!hasExactKeys(value, keys) || value.id !== expected.id || value.index !== expected.index || value.received !== true ||
    (value.duplicate === false && (typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)))) fail()
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    const abort = () => {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function readCollectionMedia(id: string, kind: MediaKind, signal: AbortSignal, fetcher: typeof fetch): Promise<CompleteMedia> {
  if (!UUID.test(id)) throw new UploadClientError('A mídia concluída não pôde ser confirmada.', { code: 'invalid_media_id' })
  const data = await responseData(fetcher, `${MEDIA_BASE}/${encodeURIComponent(id)}?depth=0`, {
    credentials: 'same-origin', cache: 'no-store', signal,
  }, 'read')
  if (data.status !== 200 || !isRecord(data.body) || data.body.id !== id || data.body.state !== 'complete' ||
    typeof data.body.mimeType !== 'string' || !MIME_BY_KIND[kind].includes(data.body.mimeType) ||
    !Number.isSafeInteger(data.body.filesize) || Number(data.body.filesize) < 1 ||
    Number(data.body.filesize) > MAX_BYTES[data.body.mimeType]! || typeof data.body.sha256 !== 'string' ||
    !SHA256.test(data.body.sha256) || !validDate(data.body.completedAt)) {
    throw new UploadClientError(errorMessage('invalid_media_response', data.status, 'read'), { code: 'invalid_media_response' })
  }
  return { id, state: 'complete', mimeType: data.body.mimeType, bytes: Number(data.body.filesize),
    sha256: data.body.sha256, completedAt: data.body.completedAt }
}

export function readCompleteMedia(id: string, kind: MediaKind, signal: AbortSignal,
  fetcher: typeof fetch = fetch): Promise<CompleteMedia> {
  return readCollectionMedia(id, kind, signal, fetcher)
}

export type UploadClient = {
  start(file: File, kind: MediaKind): Promise<CompleteMedia>
  retry(): Promise<CompleteMedia>
  cancel(): Promise<'cancelled' | 'complete' | 'pending'>
  dispose(): void
}

export function createUploadClient(options: {
  fetch: typeof fetch
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
  random: () => number
  onProgress: (progress: UploadProgress) => void
}): UploadClient {
  let fileRef: File | null = null
  let kindRef: MediaKind | null = null
  let expectedMimeType: string | null = null
  let expectedBytes: number | null = null
  let uploadID: string | null = null
  let tokenRef: string | null = null
  let chunkCount = 0
  let totalBytes = 0
  let confirmedBytes = 0
  let nextIndex = 0
  let failedStage: 'chunk' | 'complete' | null = null
  let failedIndex = 0
  let canRetry = false
  let initStarted = false
  let disposed = false
  let cancelRequested = false
  let runController: AbortController | null = null
  let running: Promise<CompleteMedia> | null = null
  let cancelController: AbortController | null = null
  let cancellationPromise: Promise<'cancelled' | 'complete' | 'pending'> | null = null
  let completedMedia: CompleteMedia | null = null
  const acknowledged = new Set<number>()

  function emit(phase: UploadProgress['phase'], index = nextIndex): void {
    if (disposed) return
    const progress: UploadProgress = { phase, confirmedBytes, totalBytes, index, count: chunkCount }
    try { options.onProgress(progress) } catch { /* Observers cannot interrupt a transfer. */ }
  }

  function clearSecrets(): void {
    fileRef = null
    tokenRef = null
    uploadID = null
    kindRef = null
    expectedMimeType = null
    expectedBytes = null
    failedStage = null
    failedIndex = 0
    canRetry = false
    acknowledged.clear()
  }

  function beginRun(work: (signal: AbortSignal) => Promise<CompleteMedia>): Promise<CompleteMedia> {
    if (disposed) return Promise.reject(new UploadClientError('O cliente de envio foi encerrado.', { code: 'client_disposed' }))
    if (running) return Promise.reject(new UploadClientError('Já existe um envio ativo neste painel.', { code: 'upload_in_progress' }))
    cancelRequested = false
    const controller = new AbortController()
    runController = controller
    const task = work(controller.signal)
    running = task
    const clear = () => {
      if (running === task) running = null
      if (runController === controller) runController = null
    }
    void task.then(clear, clear)
    return task
  }

  async function retryingRequest<T>(stage: Exclude<RequestStage, 'init' | 'read'>, signal: AbortSignal,
    request: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try { return await request() }
      catch (error) {
        const policy = stage === 'cancel' ? 'cancel' : 'transfer'
        if (isAbort(error) || !retryableError(error, policy) || attempt >= PORTAL_PAGE_UPLOAD_RETRY_DELAYS.length) throw error
        const baseDelay = PORTAL_PAGE_UPLOAD_RETRY_DELAYS[attempt]!
        const jitter = Math.floor(Math.max(0, Math.min(0.999999999, options.random())) * 100)
        await options.sleep(baseDelay + jitter, signal)
      }
    }
  }

  async function sendChunk(file: File, index: number, signal: AbortSignal): Promise<void> {
    const start = index * PORTAL_PAGE_UPLOAD_CHUNK_SIZE
    const end = Math.min(totalBytes, (index + 1) * PORTAL_PAGE_UPLOAD_CHUNK_SIZE)
    const chunk = file.slice(start, end)
    if (!(chunk instanceof Blob) || chunk.size !== end - start || chunk.size > PORTAL_PAGE_UPLOAD_CHUNK_SIZE) {
      throw new UploadClientError('Não foi possível preparar um bloco do arquivo.', { code: 'invalid_chunk_slice' })
    }
    emit('uploading', index)
    const id = uploadID!
    const secret = tokenRef!
    await retryingRequest('chunk', signal, async () => {
      const response = await responseData(options.fetch, `${UPLOAD_BASE}/${id}/chunks/${index}`, {
        method: 'PUT', credentials: 'same-origin', signal,
        headers: { 'Content-Type': 'application/octet-stream', 'x-portal-page-upload-token': secret },
        body: chunk,
      }, 'chunk')
      const body = exactSuccessfulBody(response, 200, isRecord(response.body) && response.body.duplicate === true
        ? ['id', 'index', 'received', 'duplicate'] : ['id', 'index', 'received', 'duplicate', 'sha256'])
      validateChunk(body, { id, index })
    })
    if (!acknowledged.has(index)) {
      acknowledged.add(index)
      confirmedBytes += end - start
    }
    nextIndex = index + 1
    emit('uploading', nextIndex)
  }

  async function sendComplete(signal: AbortSignal): Promise<CompleteMedia> {
    const id = uploadID!
    const secret = tokenRef!
    const mimeType = expectedMimeType!
    const bytes = expectedBytes!
    emit('validating', chunkCount)
    const response = await retryingRequest('complete', signal, async () => {
      const data = await responseData(options.fetch, `${UPLOAD_BASE}/${id}/complete`, {
        method: 'POST', credentials: 'same-origin', signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: secret }),
      }, 'complete')
      return validateComplete(exactSuccessfulBody(data, 200, ['id', 'state', 'mimeType', 'bytes', 'sha256', 'completedAt']),
        { id, mimeType, bytes })
    })
    completedMedia = response
    clearSecrets()
    emit('ready', chunkCount)
    return response
  }

  async function continueUpload(fromIndex: number, signal: AbortSignal): Promise<CompleteMedia> {
    const file = fileRef
    if (!file || !uploadID || !tokenRef || !kindRef) {
      throw new UploadClientError('Não há uma sessão de envio que possa ser retomada.', { code: 'upload_session_missing' })
    }
    try {
      for (let index = fromIndex; index < chunkCount; index += 1) {
        if (signal.aborted || cancelRequested) throw new DOMException('Aborted', 'AbortError')
        try { await sendChunk(file, index, signal) }
        catch (error) {
          if (!isAbort(error) && !cancelRequested) {
            failedStage = 'chunk'
            failedIndex = index
            canRetry = retryableError(error, 'transfer')
            emit('error', index)
          }
          throw error
        }
      }
      failedStage = 'complete'
      failedIndex = chunkCount
      canRetry = true
      try {
        const result = await sendComplete(signal)
        canRetry = false
        failedStage = null
        return result
      } catch (error) {
        if (!isAbort(error) && !cancelRequested) {
          canRetry = retryableError(error, 'transfer')
          emit('error', chunkCount)
        }
        throw error
      }
    } catch (error) {
      if (!isAbort(error) && !cancelRequested && !(error instanceof UploadClientError)) {
        canRetry = false
        emit('error', nextIndex)
        throw new UploadClientError('Não foi possível concluir o envio. Confira o estado antes de tentar novamente.',
          { code: 'upload_unavailable' })
      }
      throw error
    }
  }

  async function start(file: File, kind: MediaKind): Promise<CompleteMedia> {
    if (disposed) throw new UploadClientError('O cliente de envio foi encerrado.', { code: 'client_disposed' })
    if (running) throw new UploadClientError('Já existe um envio ativo neste painel.', { code: 'upload_in_progress' })
    if (uploadID || tokenRef) throw new UploadClientError('Encerre o envio atual antes de iniciar outro.', { code: 'upload_session_exists' })
    const validated = validateUploadFile(file, kind)
    // A completed receipt is useful to resolve a cancel/complete race until a
    // new file is deliberately started. Do not let that old receipt block the
    // next sequential upload in the same mounted panel.
    completedMedia = null
    fileRef = file
    kindRef = kind
    expectedMimeType = validated.mimeType
    expectedBytes = validated.bytes
    totalBytes = validated.bytes
    confirmedBytes = 0
    nextIndex = 0
    chunkCount = 0
    initStarted = true
    acknowledged.clear()
    failedStage = null
    canRetry = false
    emit('preparing', 0)

    return beginRun(async signal => {
      let initResponse: ResponseData
      try {
        initResponse = await responseData(options.fetch, `${UPLOAD_BASE}/init`, {
          method: 'POST', credentials: 'same-origin', signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ originalName: file.name, mimeType: validated.mimeType, bytes: validated.bytes }),
        }, 'init')
      } catch (error) {
        if (isAbort(error)) {
          emit('error', 0)
          throw error
        }
        const ambiguous = error instanceof UploadClientError && error.code === 'network_failure'
        const safeError = ambiguous
          ? new UploadClientError('A reserva pode ter sido criada, mas a resposta se perdeu. Confira o estado antes de iniciar outro envio.',
            { code: 'init_response_lost' })
          : error
        canRetry = false
        emit('error', 0)
        // No ID/token exists to resume; another init must be an explicit new start.
        fileRef = null
        kindRef = null
        throw safeError
      }
      const expectedStatus = 201
      if (initResponse.status !== expectedStatus) {
        canRetry = false
        emit('error', 0)
        fileRef = null
        kindRef = null
        throw new UploadClientError('Não foi possível iniciar o envio. Confira o estado antes de tentar novamente.',
          { code: 'invalid_init_status', status: initResponse.status })
      }
      let initialized: ReturnType<typeof validateInit>
      try { initialized = validateInit(initResponse.body, validated) }
      catch (error) {
        canRetry = false
        emit('error', 0)
        fileRef = null
        kindRef = null
        throw error
      }
      uploadID = initialized.id
      tokenRef = initialized.token
      chunkCount = initialized.chunkCount
      emit('uploading', 0)
      return continueUpload(0, signal)
    })
  }

  async function retry(): Promise<CompleteMedia> {
    if (disposed) throw new UploadClientError('O cliente de envio foi encerrado.', { code: 'client_disposed' })
    if (completedMedia) return completedMedia
    if (!canRetry || !failedStage || !fileRef || !uploadID || !tokenRef || !kindRef) {
      throw new UploadClientError('Este envio não pode ser retomado automaticamente. Inicie conscientemente um novo envio.',
        { code: 'upload_retry_unavailable' })
    }
    const stage = failedStage
    const fromIndex = stage === 'chunk' ? failedIndex : chunkCount
    canRetry = false
    return beginRun(async signal => {
      if (stage === 'chunk') return continueUpload(fromIndex, signal)
      try { return await sendComplete(signal) }
      catch (error) {
        if (!isAbort(error) && !cancelRequested) {
          failedStage = 'complete'
          failedIndex = chunkCount
          canRetry = retryableError(error, 'transfer')
          emit('error', chunkCount)
        }
        throw error
      }
    })
  }

  async function performCancel(): Promise<'cancelled' | 'complete' | 'pending'> {
    if (completedMedia) return 'complete'
    if (disposed) return 'pending'
    if (!initStarted) {
      clearSecrets()
      emit('cancelled', 0)
      return 'cancelled'
    }

    cancelRequested = true
    emit('cancelling')
    const operation = running
    runController?.abort()
    if (operation) await operation.catch(() => undefined)

    if (disposed) return 'pending'
    if (completedMedia) return 'complete'

    const id = uploadID
    const secret = tokenRef
    const kind = kindRef
    const mimeType = expectedMimeType
    const bytes = expectedBytes
    if (!id || !secret || !kind) {
      // Init may have committed before its response was lost; never claim this was cancelled.
      canRetry = false
      emit('error', 0)
      return initStarted ? 'pending' : 'cancelled'
    }

    const controller = new AbortController()
    cancelController = controller
    try {
      const response = await retryingRequest('cancel', controller.signal, async () => {
        const data = await responseData(options.fetch, `${UPLOAD_BASE}/${id}`, {
          method: 'DELETE', credentials: 'same-origin', signal: controller.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: secret }),
        }, 'cancel')
        const body = exactSuccessfulBody(data, 200, ['id', 'cancelled'])
        if (body.id !== id || body.cancelled !== true) fail('O cancelamento não pôde ser confirmado.')
        return true
      })
      if (!response) return 'pending'
      clearSecrets()
      initStarted = false
      cancelRequested = false
      emit('cancelled')
      return 'cancelled'
    } catch (error) {
      if (error instanceof UploadClientError && error.code === 'media_already_complete') {
        try {
          const media = await readCollectionMedia(id, kind, controller.signal, options.fetch)
          if (media.id !== id || media.mimeType !== mimeType || media.bytes !== bytes) {
            throw new UploadClientError('A mídia concluída não corresponde ao envio original.', { code: 'invalid_media_response' })
          }
          completedMedia = media
          clearSecrets()
          initStarted = false
          cancelRequested = false
          emit('ready', chunkCount)
          return 'complete'
        } catch (readError) {
          emit('error')
          throw readError
        }
      }
      if (retryableError(error, 'cancel')) {
        canRetry = false
        emit('error')
        return 'pending'
      }
      canRetry = false
      emit('error')
      throw error
    } finally {
      if (cancelController === controller) cancelController = null
    }
  }

  function cancel(): Promise<'cancelled' | 'complete' | 'pending'> {
    if (cancellationPromise) return cancellationPromise
    const task = performCancel()
    cancellationPromise = task
    const clear = () => { if (cancellationPromise === task) cancellationPromise = null }
    void task.then(clear, clear)
    return task
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    cancelRequested = true
    runController?.abort()
    const id = uploadID
    const secret = tokenRef
    const outstanding = running
    const cancelling = cancellationPromise
    cancelController?.abort()
    if (id && secret) {
      const bestEffortDelete = async () => {
        const controller = new AbortController()
        try {
          await options.fetch(`${UPLOAD_BASE}/${id}`, {
            method: 'DELETE', credentials: 'same-origin', signal: controller.signal,
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: secret }),
          })
        } catch { /* Disposal cleanup is best-effort and must not expose raw failures. */ }
      }
      void (async () => {
        if (outstanding) await outstanding.catch(() => undefined)
        if (cancelling) await cancelling.catch(() => 'pending' as const)
        await bestEffortDelete()
      })()
    }
    clearSecrets()
    completedMedia = null
    running = null
    runController = null
    cancelController = null
  }

  return { start, retry, cancel, dispose }
}

export { EXTENSION_LABEL as PORTAL_PAGE_UPLOAD_FORMAT_HELP }
