import type { PortalPagePublicationInput } from '../../portal-pages/contracts'
import { CREATE_JSON_BYTES, EDITORIAL_BASE, type EditorialErrorBody, type NativeEditable,
  type PublicationResult, type RevisionResult, type SaveInput, type SaveResult } from '../../portal-pages/editorial-contracts'
import { editableHash, extractNativeEditable } from '../../portal-pages/editorial-native'

export type EditorGate = {
  modified: boolean
  processing: boolean
  backgroundProcessing: boolean
  initializing: boolean
  disabled: boolean
  locked: boolean
  uploading: boolean
  otherModalOpen: boolean
  busy: boolean
}

export function editorialBlocked(gate: EditorGate): boolean {
  return Object.values(gate).some(Boolean)
}

export type RequestTicket = { generation: number; documentID: string; signal: AbortSignal }
export type RequestGeneration = ReturnType<typeof createRequestGeneration>

export function createRequestGeneration(): {
  begin(documentID: string): RequestTicket
  invalidate(): void
  accepts(ticket: RequestTicket, documentID: string): boolean
} {
  let generation = 0
  let active: { documentID: string; controller: AbortController } | null = null

  const invalidate = () => {
    generation += 1
    active?.controller.abort()
    active = null
  }

  return {
    begin(documentID) {
      active?.controller.abort()
      generation += 1
      const controller = new AbortController()
      active = { documentID, controller }
      return { generation, documentID, signal: controller.signal }
    },
    invalidate,
    accepts(ticket, documentID) {
      return ticket.generation === generation && ticket.documentID === documentID &&
        active?.documentID === documentID && active.controller.signal === ticket.signal && !ticket.signal.aborted
    },
  }
}

/** Guard a response against both document-generation changes and selective form edits. */
export function acceptsEditableRequest(generation: RequestGeneration, ticket: RequestTicket, documentID: string,
  capturedFieldRevision: string, currentFieldRevision: string): boolean {
  return capturedFieldRevision === currentFieldRevision && generation.accepts(ticket, documentID)
}

export type EditorialOperationPhase = 'hashing' | 'reading' | 'saving' | 'publishing'
export type EditorialLiveState = { documentID: string; fieldRevision: string; gate: EditorGate }
export type EditorialFormLease = {
  previousProcessing: boolean
  previousDisabled: boolean
  setProcessing: (processing: boolean) => void
  setDisabled: (disabled: boolean) => void
  released: boolean
}
export type EditorialOperation = {
  documentID: string
  fieldRevision: string
  ticket: RequestTicket
  allowModified: boolean
  phase: EditorialOperationPhase
  lease?: EditorialFormLease
}
export type EditorialOperationObservation = {
  documentChanged: boolean
  fieldsChanged: boolean
  unsafe: boolean
  invalidated: boolean
  cancelled: EditorialOperation | null
}

/**
 * Framework-independent ownership/gate controller shared by the Payload
 * controls and node tests. Setters are injected only for form leases.
 */
export function createEditorialOperationController(initial: EditorialLiveState,
  generations: RequestGeneration = createRequestGeneration()) {
  let live = initial
  let active: EditorialOperation | null = null
  let leaseOwner: EditorialOperation | null = null
  let busy = false

  function releaseLease(operation: EditorialOperation, state: EditorialLiveState = live): void {
    const lease = operation.lease
    if (!lease || lease.released) return
    lease.released = true
    if (active === operation && leaseOwner === operation && state.documentID === operation.documentID) {
      leaseOwner = null
      lease.setProcessing(lease.previousProcessing)
      lease.setDisabled(lease.previousDisabled)
    }
  }

  function externalGateIsSafe(operation: EditorialOperation, state: EditorialLiveState): boolean {
    if (state.documentID !== operation.documentID || state.fieldRevision !== operation.fieldRevision) return false
    const gate = state.gate
    if (gate.backgroundProcessing || gate.initializing || gate.locked || gate.uploading || gate.otherModalOpen ||
      (!operation.allowModified && gate.modified)) return false
    return operation.lease !== undefined || (!gate.processing && !gate.disabled)
  }

  function cancelActive(state: EditorialLiveState): EditorialOperation | null {
    const operation = active
    if (!operation) return null
    releaseLease(operation, state)
    active = null
    busy = false
    generations.invalidate()
    return operation
  }

  return {
    get active(): EditorialOperation | null { return active },
    get busy(): boolean { return busy },
    get live(): EditorialLiveState { return live },

    start(allowModified: boolean, state: EditorialLiveState = live): EditorialOperation | null {
      if (active || busy) return null
      const gate = state.gate
      if (gate.processing || gate.backgroundProcessing || gate.initializing || gate.disabled || gate.locked ||
        gate.uploading || gate.otherModalOpen || (!allowModified && gate.modified)) return null
      const ticket = generations.begin(state.documentID)
      const operation: EditorialOperation = { documentID: state.documentID, fieldRevision: state.fieldRevision,
        ticket, allowModified, phase: 'hashing' }
      active = operation
      busy = true
      return operation
    },

    isCurrent(operation: EditorialOperation, state: EditorialLiveState = live): boolean {
      return active === operation && acceptsEditableRequest(generations, operation.ticket, state.documentID,
        operation.fieldRevision, state.fieldRevision) && externalGateIsSafe(operation, state)
    },

    acquireLease(operation: EditorialOperation, state: EditorialLiveState,
      setters: { setProcessing: (processing: boolean) => void; setDisabled: (disabled: boolean) => void }): boolean {
      if (!this.isCurrent(operation, state)) return false
      operation.lease = { previousProcessing: state.gate.processing, previousDisabled: state.gate.disabled,
        setProcessing: setters.setProcessing, setDisabled: setters.setDisabled, released: false }
      leaseOwner = operation
      setters.setProcessing(true)
      setters.setDisabled(true)
      return true
    },

    releaseLease(operation: EditorialOperation, state: EditorialLiveState = live): void {
      releaseLease(operation, state)
    },

    setPhase(operation: EditorialOperation, phase: EditorialOperationPhase): void {
      if (active === operation) operation.phase = phase
    },

    finish(operation: EditorialOperation, state: EditorialLiveState = live): boolean {
      if (active !== operation) return false
      releaseLease(operation, state)
      active = null
      busy = false
      return true
    },

    cancel(state: EditorialLiveState = live): EditorialOperation | null {
      return cancelActive(state)
    },

    observe(next: EditorialLiveState): EditorialOperationObservation {
      const previous = live
      const documentChanged = previous.documentID !== next.documentID
      const fieldsChanged = previous.fieldRevision !== next.fieldRevision
      const operation = active
      const ownLease = operation?.lease !== undefined && !operation.lease.released
      const gate = next.gate
      const unsafe = gate.backgroundProcessing || gate.initializing || gate.locked || gate.uploading ||
        gate.otherModalOpen || (!ownLease && (gate.processing || gate.disabled)) ||
        (Boolean(next.documentID) && (!operation || !operation.allowModified) && gate.modified)

      live = next
      let cancelled: EditorialOperation | null = null
      let invalidated = false
      if (operation && (documentChanged || fieldsChanged || unsafe)) {
        cancelled = cancelActive(next)
        invalidated = true
      } else if (documentChanged || fieldsChanged || unsafe) {
        generations.invalidate()
        invalidated = true
      }
      return { documentChanged, fieldsChanged, unsafe, invalidated, cancelled }
    },

    dispose(state: EditorialLiveState = live): void {
      cancelActive(state)
      generations.invalidate()
    },
  }
}

export function confirmedVersion(revision: RevisionResult, localHash: string): null | {
  id: string
  versionID: string
  savedAt: string
} {
  const { latest, explicit } = revision
  if (!latest || latest.autosave || !explicit?.is_latest || explicit.version_id !== latest.version_id ||
    latest.editable_hash !== localHash) return null
  return { id: revision.id, versionID: latest.version_id, savedAt: latest.saved_at }
}

export const EDITORIAL_CONFLICT_MESSAGE =
  'A página mudou desde a conferência. Seus campos foram preservados. Confira e salve uma nova versão antes de publicar.'
export const EDITORIAL_AMBIGUOUS_MESSAGE =
  'Não foi possível confirmar a operação. Consulte o estado antes de tentar novamente.'
export const EDITORIAL_SESSION_MESSAGE = 'A sessão editorial expirou. Entre novamente.'
export const EDITORIAL_READ_FAILURE_MESSAGE = 'Não foi possível consultar a revisão da página. Consulte o estado antes de continuar.'
export const EDITORIAL_REJECTED_MESSAGE = 'A operação editorial foi rejeitada. Verifique os campos e sua permissão.'
export const EDITORIAL_INVALID_RESPONSE_MESSAGE = 'A resposta editorial não pôde ser confirmada.'

export class EditorialRequestError extends Error {
  readonly status: number | null
  readonly code: string | null
  readonly ambiguous: boolean

  constructor(message: string, options: { status?: number | null; code?: string | null; ambiguous?: boolean } = {}) {
    super(message)
    this.name = 'EditorialRequestError'
    this.status = options.status ?? null
    this.code = options.code ?? null
    this.ambiguous = options.ambiguous === true
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const hashPattern = /^[0-9a-f]{64}$/u
const pageStatuses = ['draft', 'published'] as const

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function validUUID(value: unknown): value is string {
  return typeof value === 'string' && uuidPattern.test(value)
}

function validHash(value: unknown): value is string {
  return typeof value === 'string' && hashPattern.test(value)
}

function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}

function validStatus(value: unknown): value is RevisionResult['document_status'] {
  return typeof value === 'string' && (pageStatuses as readonly string[]).includes(value)
}

function validateRevision(value: unknown, expectedID: string): RevisionResult {
  const result = record(value)
  if (!result || !exactKeys(result, ['id', 'document_status', 'latest', 'explicit']) || result.id !== expectedID ||
    !validUUID(result.id) || !validStatus(result.document_status)) throw invalidResponse()

  let latest: RevisionResult['latest'] = null
  if (result.latest !== null) {
    const raw = record(result.latest)
    if (!raw || !exactKeys(raw, ['version_id', 'autosave', 'saved_at', 'snapshot_hash', 'editable_hash']) ||
      !validUUID(raw.version_id) || typeof raw.autosave !== 'boolean' || !validDate(raw.saved_at) ||
      !validHash(raw.snapshot_hash) || !validHash(raw.editable_hash)) throw invalidResponse()
    latest = { version_id: raw.version_id, autosave: raw.autosave, saved_at: raw.saved_at,
      snapshot_hash: raw.snapshot_hash, editable_hash: raw.editable_hash }
  }

  let explicit: RevisionResult['explicit'] = null
  if (result.explicit !== null) {
    const raw = record(result.explicit)
    if (!raw || !exactKeys(raw, ['version_id', 'saved_at', 'is_latest']) || !validUUID(raw.version_id) ||
      !validDate(raw.saved_at) || typeof raw.is_latest !== 'boolean') throw invalidResponse()
    explicit = { version_id: raw.version_id, saved_at: raw.saved_at, is_latest: raw.is_latest }
  }

  return { id: result.id, document_status: result.document_status, latest, explicit }
}

function validateSaveReceipt(value: unknown, input: SaveInput): SaveResult {
  const result = record(value)
  if (!result || !exactKeys(result, ['id', 'version_id', 'saved_at', 'editable_hash', 'document_status']) ||
    !validUUID(result.id) || (input.id !== null && result.id !== input.id) || !validUUID(result.version_id) ||
    !validDate(result.saved_at) || !validHash(result.editable_hash) || !validStatus(result.document_status) ||
    (input.id === null && result.document_status !== 'draft')) throw invalidResponse(true)
  return { id: result.id, version_id: result.version_id, saved_at: result.saved_at,
    editable_hash: result.editable_hash, document_status: result.document_status }
}

function validatePublicationReceipt(value: unknown, input: PortalPagePublicationInput): PublicationResult {
  const result = record(value)
  const expectedStatus = input.operation === 'publish' ? 'published' : 'draft'
  if (!result || !exactKeys(result, ['id', 'operation', 'source_version_id', 'resulting_version_id', 'document_status', 'published_at']) ||
    result.id !== input.id || result.operation !== input.operation || result.source_version_id !== input.expected_version_id ||
    !validUUID(result.id) || !validUUID(result.source_version_id) || !validUUID(result.resulting_version_id) ||
    result.document_status !== expectedStatus ||
    (input.operation === 'publish' ? !validDate(result.published_at) : result.published_at !== null)) throw invalidResponse(true)
  return { id: input.id, operation: input.operation, source_version_id: input.expected_version_id,
    resulting_version_id: result.resulting_version_id as string, document_status: expectedStatus,
    published_at: input.operation === 'publish' ? result.published_at as string : null }
}

function invalidResponse(ambiguous = false): EditorialRequestError {
  return new EditorialRequestError(ambiguous ? EDITORIAL_AMBIGUOUS_MESSAGE : EDITORIAL_INVALID_RESPONSE_MESSAGE,
    { code: 'invalid_editorial_response', ambiguous })
}

async function responseError(response: Response, isMutation: boolean): Promise<EditorialRequestError> {
  let body: EditorialErrorBody | null = null
  try {
    const candidate: unknown = await response.json()
    const raw = record(candidate)
    if (raw && exactKeys(raw, ['error', 'message']) && typeof raw.error === 'string' && typeof raw.message === 'string') {
      body = { error: raw.error, message: raw.message }
    }
  } catch { /* Treat a malformed error response as a generic failure. */ }

  if (response.status === 401 || body?.error === 'editorial_session_invalid') {
    return new EditorialRequestError(EDITORIAL_SESSION_MESSAGE, { status: response.status, code: body?.error })
  }
  if (response.status === 409 || body?.error === 'portal_page_version_conflict') {
    return new EditorialRequestError(EDITORIAL_CONFLICT_MESSAGE, { status: response.status, code: body?.error })
  }
  if (isMutation && response.status >= 500) {
    return new EditorialRequestError(EDITORIAL_AMBIGUOUS_MESSAGE,
      { status: response.status, code: body?.error, ambiguous: true })
  }
  if (!isMutation && response.status >= 500) {
    return new EditorialRequestError(EDITORIAL_READ_FAILURE_MESSAGE, { status: response.status, code: body?.error })
  }
  if (response.status === 404) {
    return new EditorialRequestError('A página não foi encontrada. Confira a lista de páginas.',
      { status: response.status, code: body?.error })
  }
  return new EditorialRequestError(EDITORIAL_REJECTED_MESSAGE, { status: response.status, code: body?.error })
}

async function readJSON(response: Response, isMutation: boolean): Promise<unknown> {
  if (!response.ok) throw await responseError(response, isMutation)
  try { return await response.json() }
  catch { throw invalidResponse(isMutation) }
}

function thrownRequestError(error: unknown, isMutation: boolean): EditorialRequestError {
  if (error instanceof EditorialRequestError) return error
  if (error instanceof DOMException && error.name === 'AbortError') throw error
  return new EditorialRequestError(isMutation ? EDITORIAL_AMBIGUOUS_MESSAGE : EDITORIAL_READ_FAILURE_MESSAGE,
    { code: 'editorial_network_failure', ambiguous: isMutation })
}

export async function fetchRevision(id: string, signal: AbortSignal): Promise<RevisionResult> {
  if (!validUUID(id)) throw new EditorialRequestError(EDITORIAL_REJECTED_MESSAGE, { code: 'invalid_page_id' })
  try {
    const response = await fetch(`${EDITORIAL_BASE}/revision?id=${encodeURIComponent(id)}`, {
      credentials: 'same-origin', cache: 'no-store', signal,
    })
    return validateRevision(await readJSON(response, false), id)
  } catch (error) {
    throw thrownRequestError(error, false)
  }
}

function exactEditable(data: NativeEditable): NativeEditable {
  return extractNativeEditable(data)
}

export async function saveVersion(input: SaveInput, signal: AbortSignal): Promise<SaveResult> {
  let body: SaveInput
  if (input.id === null) {
    body = { id: null, data: exactEditable(input.data) }
  } else {
    if (!validUUID(input.id) || !validUUID(input.expected_latest_version_id) || !validHash(input.expected_snapshot_hash)) {
      throw new EditorialRequestError(EDITORIAL_REJECTED_MESSAGE, { code: 'invalid_save_cas' })
    }
    body = { id: input.id, expected_latest_version_id: input.expected_latest_version_id,
      expected_snapshot_hash: input.expected_snapshot_hash }
  }
  const serializedBody = JSON.stringify(body)
  if (input.id === null && new TextEncoder().encode(serializedBody).byteLength > CREATE_JSON_BYTES) {
    throw new EditorialRequestError('A solicitação de criação excede o limite de 8 MiB. Reduza o conteúdo antes de salvar.',
      { code: 'create_request_too_large' })
  }
  try {
    const response = await fetch(`${EDITORIAL_BASE}/save`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: serializedBody, signal,
    })
    const result = await readJSON(response, true)
    if (response.status !== 201) throw invalidResponse(true)
    return validateSaveReceipt(result, body)
  } catch (error) {
    throw thrownRequestError(error, true)
  }
}

export async function changePublication(input: PortalPagePublicationInput, signal: AbortSignal): Promise<PublicationResult> {
  if (!validUUID(input.id) || !validUUID(input.expected_version_id) ||
    (input.operation !== 'publish' && input.operation !== 'unpublish')) {
    throw new EditorialRequestError(EDITORIAL_REJECTED_MESSAGE, { code: 'invalid_publication_input' })
  }
  const body: PortalPagePublicationInput = {
    id: input.id, expected_version_id: input.expected_version_id, operation: input.operation,
  }
  try {
    const response = await fetch(`${EDITORIAL_BASE}/publication`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal,
    })
    const result = await readJSON(response, true)
    if (response.status !== 200) throw invalidResponse(true)
    return validatePublicationReceipt(result, body)
  } catch (error) {
    throw thrownRequestError(error, true)
  }
}

export { editableHash, extractNativeEditable }
