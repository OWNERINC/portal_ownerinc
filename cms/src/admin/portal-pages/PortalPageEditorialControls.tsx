'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Button, Modal, useDocumentForm, useDocumentInfo, useForm, useFormBackgroundProcessing, useFormFields,
  useFormInitializing, useFormModified, useFormProcessing, useModal } from '@payloadcms/ui'
import type { PortalPagePublicationInput } from '../../portal-pages/contracts'
import { CREATE_JSON_BYTES } from '../../portal-pages/editorial-contracts'
import { EDITORIAL_AMBIGUOUS_MESSAGE, EDITORIAL_CONFLICT_MESSAGE, EditorialRequestError,
  changePublication, confirmedVersion, createEditorialOperationController, editorialBlocked, editableHash,
  extractNativeEditable, fetchRevision, saveVersion } from './editorial-state'
import type { EditorGate, EditorialLiveState, EditorialOperation } from './editorial-state'
import { editorialFieldFocusRegistryFor } from './editorial-focus-state'

const MODAL_SLUG = 'portal-page-editorial-confirmation'
const EDITABLE_FIELD_ROOTS = new Set(['title', 'slug', 'summary', 'cover', 'coverAlt', 'categories', 'body'])
const WAITING_MESSAGE = 'Aguardando salvamento automático'
const WAITING_EXPLANATION = 'Aguarde o salvamento automático para salvar uma versão.'
const CREATE_AMBIGUOUS_MESSAGE =
  'A criação pode ter sido concluída, mas a confirmação foi perdida. Confira a lista nativa e o slug antes de tentar criar novamente.'

type PublicationAction = PortalPagePublicationInput['operation']

function signatureValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (value === undefined) return null
  if (typeof value !== 'object') return String(value)
  if (typeof Date !== 'undefined' && value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : 'invalid-date'
  if (typeof File !== 'undefined' && value instanceof File) {
    return { file: value.name, type: value.type, size: value.size, lastModified: value.lastModified }
  }
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => signatureValue(item, seen))
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, signatureValue(item, seen)]))
}

function selectedEditableRevision(fields: Record<string, { value?: unknown; rows?: Array<{ id: string; blockType?: string }> }>): string {
  const selected = Object.keys(fields)
    .filter(path => EDITABLE_FIELD_ROOTS.has(path) || path.startsWith('body.'))
    .sort()
    .map(path => [path, signatureValue(fields[path]?.value), fields[path]?.rows?.map(row => [row.id, row.blockType]) ?? null])
  try { return JSON.stringify(selected) }
  catch { return `unserializable:${selected.length}` }
}

function isConflict(error: unknown): boolean {
  return error instanceof EditorialRequestError && error.status === 409
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : 'A operação editorial não pôde ser concluída.'
}

function latestOperationTitle(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value : 'Página sem título'
}

export function PortalPageEditorialControls(): React.JSX.Element {
  const info = useDocumentInfo()
  const documentForm = useDocumentForm()
  const form = useForm()
  const modified = useFormModified()
  const processing = useFormProcessing()
  const backgroundProcessing = useFormBackgroundProcessing()
  const initializing = useFormInitializing()
  const { modalState, openModal, closeModal } = useModal()
  const fieldRevision = useFormFields(([fields]) => selectedEditableRevision(fields))
  const titleValue = useFormFields(([fields]) => fields.title?.value)
  const documentID = String(info.id || '')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState('')
  const [confirmed, setConfirmed] = useState<ReturnType<typeof confirmedVersion>>(null)
  const [confirmedFieldRevision, setConfirmedFieldRevision] = useState<string | null>(null)
  const [createdPageHref, setCreatedPageHref] = useState('')
  const [publicationAction, setPublicationAction] = useState<PublicationAction | null>(null)
  const confirmedRef = useRef(confirmed)
  const confirmedFieldRevisionRef = useRef(confirmedFieldRevision)
  confirmedRef.current = confirmed
  confirmedFieldRevisionRef.current = confirmedFieldRevision

  const otherModalOpen = Object.entries(modalState).some(([slug, modal]) => slug !== MODAL_SLUG && modal.isOpen)
  const gate: EditorGate = {
    modified,
    processing,
    backgroundProcessing,
    initializing: initializing || info.isInitializing,
    disabled: form.disabled,
    locked: Boolean(info.documentIsLocked || info.isLocked),
    uploading: info.uploadStatus === 'uploading',
    otherModalOpen,
    busy,
  }
  const live: EditorialLiveState = { documentID, fieldRevision, gate }
  const controllerRef = useRef<ReturnType<typeof createEditorialOperationController> | null>(null)
  if (!controllerRef.current) controllerRef.current = createEditorialOperationController(live)
  const controller = controllerRef.current
  const liveRef = useRef(live)
  liveRef.current = live
  const fieldFocusRegistry = editorialFieldFocusRegistryFor(documentForm)

  function clearAuthorization(): void {
    setConfirmed(null)
    confirmedRef.current = null
    setConfirmedFieldRevision(null)
    confirmedFieldRevisionRef.current = null
    setCreatedPageHref('')
  }

  useEffect(() => {
    const observation = controller.observe(liveRef.current)
    const { documentChanged, fieldsChanged, unsafe, cancelled } = observation
    if (cancelled) {
      const ambiguous = !documentChanged && (fieldsChanged || unsafe) &&
        (cancelled.phase === 'saving' || cancelled.phase === 'publishing')
      if (ambiguous) setFailure(cancelled.documentID ? EDITORIAL_AMBIGUOUS_MESSAGE : CREATE_AMBIGUOUS_MESSAGE)
      setBusy(controller.busy)
      if (modalState[MODAL_SLUG]?.isOpen) closeModal(MODAL_SLUG)
    }

    if (documentChanged || fieldsChanged || unsafe) {
      clearAuthorization()
      setPublicationAction(null)
      if (modalState[MODAL_SLUG]?.isOpen) closeModal(MODAL_SLUG)
    }
    if (documentID && (gate.modified || gate.backgroundProcessing) && !controller.active) {
      setMessage(WAITING_MESSAGE)
    } else if (message === WAITING_MESSAGE && !gate.modified && !gate.backgroundProcessing) {
      setMessage('')
    }
    // observe owns request invalidation and operation cancellation; the local UI
    // effects above only clear the corresponding confirmation/status state.
  }, [documentID, fieldRevision, modified, processing, backgroundProcessing, initializing, form.disabled,
    info.documentIsLocked, info.isLocked, info.uploadStatus, otherModalOpen, message, controller])

  useEffect(() => () => {
    controller.dispose(liveRef.current)
  }, [controller])

  function operationIsCurrent(operation: EditorialOperation): boolean {
    return controller.isCurrent(operation, liveRef.current)
  }

  function startOperation(allowModified: boolean, preserveAuthorization = false): EditorialOperation | null {
    const current = liveRef.current
    const operation = controller.start(allowModified, current)
    if (!operation) return null
    setBusy(true)
    setFailure('')
    setMessage('')
    if (!preserveAuthorization) clearAuthorization()
    return operation
  }

  function acquireFormLease(operation: EditorialOperation): void {
    controller.acquireLease(operation, liveRef.current, { setProcessing: form.setProcessing, setDisabled: form.setDisabled })
  }

  function finishOperation(operation: EditorialOperation): void {
    if (controller.finish(operation, liveRef.current)) setBusy(controller.busy)
  }

  function showWaitingForAutosave(): void {
    setMessage(WAITING_MESSAGE)
    setFailure('')
  }

  async function refreshWithoutAdopting(operation: EditorialOperation): Promise<void> {
    if (!operationIsCurrent(operation) || !operation.documentID) return
    controller.setPhase(operation, 'reading')
    try { await fetchRevision(operation.documentID, operation.ticket.signal) }
    catch { /* Keep authorization cleared; the user must consciously save/check again. */ }
  }

  async function saveExplicitVersion(): Promise<void> {
    const creating = !documentID
    if (!creating && (modified || backgroundProcessing)) {
      showWaitingForAutosave()
      return
    }
    const operation = startOperation(creating)
    if (!operation) {
      if (!creating && (modified || backgroundProcessing)) showWaitingForAutosave()
      return
    }

    try {
      let data
      let localHash: string
      if (creating) {
        controller.setPhase(operation, 'hashing')
        setMessage('Conferindo campos…')
        const valid = await form.validateForm()
        if (!operationIsCurrent(operation)) return
        if (!valid) {
          fieldFocusRegistry.focusFirstInvalid(form.getFields())
          setMessage('Corrija os campos inválidos antes de salvar a página.')
          return
        }
        data = extractNativeEditable(form.getData())
        const bodyBytes = new TextEncoder().encode(JSON.stringify({ id: null, data })).byteLength
        if (bodyBytes > CREATE_JSON_BYTES) {
          setFailure('A solicitação de criação excede o limite de 8 MiB. Reduza o conteúdo antes de salvar.')
          return
        }
        localHash = await editableHash(data)
        if (!operationIsCurrent(operation)) return
        acquireFormLease(operation)
        if (!operationIsCurrent(operation)) return
        controller.setPhase(operation, 'saving')
        setMessage('Salvando versão…')
        const receipt = await saveVersion({ id: null, data }, operation.ticket.signal)
        if (!operationIsCurrent(operation)) return
        setCreatedPageHref(`/editorial/admin/collections/portal-pages/${receipt.id}`)
        setMessage('Versão salva')
        setFailure('')
        return
      }

      controller.setPhase(operation, 'hashing')
      data = extractNativeEditable(form.getData())
      localHash = await editableHash(data)
      if (!operationIsCurrent(operation)) return
      controller.setPhase(operation, 'reading')
      setMessage('Conferindo versão…')
      const revision = await fetchRevision(operation.documentID, operation.ticket.signal)
      if (!operationIsCurrent(operation)) return
      if (!revision.latest || revision.latest.editable_hash !== localHash) {
        clearAuthorization()
        setFailure(EDITORIAL_CONFLICT_MESSAGE)
        setMessage('')
        return
      }

      acquireFormLease(operation)
      if (!operationIsCurrent(operation)) return
      controller.setPhase(operation, 'saving')
      setMessage('Salvando versão…')
      const receipt = await saveVersion({ id: operation.documentID,
        expected_latest_version_id: revision.latest.version_id, expected_snapshot_hash: revision.latest.snapshot_hash },
      operation.ticket.signal)
      if (!operationIsCurrent(operation)) return
      if (receipt.editable_hash !== localHash) throw new EditorialRequestError(EDITORIAL_AMBIGUOUS_MESSAGE, { ambiguous: true })
      controller.setPhase(operation, 'reading')
      setMessage('Conferindo versão…')
      const afterSave = await fetchRevision(operation.documentID, operation.ticket.signal)
      if (!operationIsCurrent(operation)) return
      const nextConfirmed = confirmedVersion(afterSave, localHash)
      setConfirmed(nextConfirmed)
      confirmedRef.current = nextConfirmed
      setConfirmedFieldRevision(nextConfirmed ? operation.fieldRevision : null)
      confirmedFieldRevisionRef.current = nextConfirmed ? operation.fieldRevision : null
      setMessage('Versão salva')
      setFailure(nextConfirmed ? '' : 'A versão foi salva, mas sua prévia não pôde ser confirmada. Consulte o estado antes de publicar.')
    } catch (error) {
      if (!operationIsCurrent(operation)) return
      clearAuthorization()
      setFailure(creating && error instanceof EditorialRequestError && error.ambiguous
        ? CREATE_AMBIGUOUS_MESSAGE : messageFrom(error))
      setMessage('')
      if (error instanceof EditorialRequestError && (error.ambiguous || isConflict(error))) {
        controller.releaseLease(operation, liveRef.current)
        await refreshWithoutAdopting(operation)
      }
    } finally {
      finishOperation(operation)
    }
  }

  async function checkVersionBeforeConfirmation(action: PublicationAction): Promise<void> {
    const expected = confirmedRef.current
    if (!expected || !documentID || confirmedFieldRevisionRef.current !== liveRef.current.fieldRevision) return
    const operation = startOperation(false, true)
    if (!operation) return
    try {
      const editable = extractNativeEditable(form.getData())
      const localHash = await editableHash(editable)
      if (!operationIsCurrent(operation)) return
      controller.setPhase(operation, 'reading')
      setMessage('Conferindo versão…')
      const revision = await fetchRevision(operation.documentID, operation.ticket.signal)
      if (!operationIsCurrent(operation)) return
      const fresh = confirmedVersion(revision, localHash)
      if (!fresh || fresh.versionID !== expected.versionID || fresh.id !== expected.id) {
        clearAuthorization()
        setFailure(EDITORIAL_CONFLICT_MESSAGE)
        setMessage('')
        return
      }
      setConfirmed(fresh)
      confirmedRef.current = fresh
      setConfirmedFieldRevision(operation.fieldRevision)
      confirmedFieldRevisionRef.current = operation.fieldRevision
      setPublicationAction(action)
      openModal(MODAL_SLUG)
    } catch (error) {
      if (!operationIsCurrent(operation)) return
      clearAuthorization()
      setFailure(messageFrom(error))
      setMessage('')
    } finally { finishOperation(operation) }
  }

  async function confirmPublication(): Promise<void> {
    const expected = confirmedRef.current
    const action = publicationAction
    if (!expected || !action || !documentID || confirmedFieldRevisionRef.current !== liveRef.current.fieldRevision) return
    const operation = startOperation(false, true)
    if (!operation) return
    try {
      const editable = extractNativeEditable(form.getData())
      const localHash = await editableHash(editable)
      if (!operationIsCurrent(operation)) return
      controller.setPhase(operation, 'reading')
      setMessage('Conferindo versão…')
      const revision = await fetchRevision(operation.documentID, operation.ticket.signal)
      if (!operationIsCurrent(operation)) return
      const fresh = confirmedVersion(revision, localHash)
      if (!fresh || fresh.versionID !== expected.versionID || fresh.id !== expected.id) {
        clearAuthorization()
        setFailure(EDITORIAL_CONFLICT_MESSAGE)
        setMessage('')
        closeModal(MODAL_SLUG)
        setPublicationAction(null)
        return
      }

      acquireFormLease(operation)
      if (!operationIsCurrent(operation)) return
      controller.setPhase(operation, 'publishing')
      setMessage(action === 'publish' ? 'Publicando…' : 'Despublicando…')
      const result = await changePublication({ id: expected.id, expected_version_id: expected.versionID,
        operation: action }, operation.ticket.signal)
      if (!operationIsCurrent(operation)) return
      clearAuthorization()
      closeModal(MODAL_SLUG)
      setPublicationAction(null)
      setMessage(result.operation === 'publish' ? 'Página publicada' : 'Página despublicada')
      setFailure('')

      controller.setPhase(operation, 'reading')
      try {
        const afterPublication = await fetchRevision(operation.documentID, operation.ticket.signal)
        if (!operationIsCurrent(operation)) return
        const nextConfirmed = confirmedVersion(afterPublication, localHash)
        setConfirmed(nextConfirmed)
        confirmedRef.current = nextConfirmed
        setConfirmedFieldRevision(nextConfirmed ? operation.fieldRevision : null)
        confirmedFieldRevisionRef.current = nextConfirmed ? operation.fieldRevision : null
        if (!nextConfirmed) setFailure('A operação foi concluída, mas a versão atual não pôde ser confirmada. Consulte o estado antes de publicar novamente.')
      } catch (error) {
        if (operationIsCurrent(operation)) setFailure(messageFrom(error))
      }
    } catch (error) {
      if (!operationIsCurrent(operation)) return
      clearAuthorization()
      closeModal(MODAL_SLUG)
      setPublicationAction(null)
      setFailure(messageFrom(error))
      setMessage('')
      if (error instanceof EditorialRequestError && (error.ambiguous || isConflict(error))) {
        controller.releaseLease(operation, liveRef.current)
        await refreshWithoutAdopting(operation)
      }
    } finally { finishOperation(operation) }
  }

  const blocked = editorialBlocked(gate)
  const saveBlocked = creatingSaveBlocked(gate, !documentID)
  const hasMatchingConfirmation = Boolean(confirmed && confirmedFieldRevision === fieldRevision)
  const canPreview = Boolean(hasMatchingConfirmation && !blocked)
  const pageTitle = latestOperationTitle(titleValue)

  return <section aria-label="Controles editoriais da página" className="portal-page-editorial-controls">
    <div className="portal-page-editorial-controls__actions">
      <Button type="button" buttonStyle="secondary" disabled={saveBlocked} onClick={saveExplicitVersion}>
        Salvar versão
      </Button>
      {documentID && <>
        <Button type="button" buttonStyle="secondary" disabled={blocked || !hasMatchingConfirmation} onClick={() => checkVersionBeforeConfirmation('publish')}>
          Publicar versão salva
        </Button>
        <Button type="button" buttonStyle="secondary" disabled={blocked || !hasMatchingConfirmation} onClick={() => checkVersionBeforeConfirmation('unpublish')}>
          Despublicar página
        </Button>
      </>}
    </div>
    {message === WAITING_MESSAGE && <p>{WAITING_EXPLANATION}</p>}
    <p role="status" aria-live="polite">{message}</p>
    {failure && <p role="alert">{failure}</p>}
    {confirmed && canPreview && <p>
      <a href={`/editorial/portal-pages/preview/${confirmed.id}?version=${confirmed.versionID}`}
        target="_blank" rel="noopener noreferrer">Abrir prévia desta versão em nova aba</a>
      {' — versão '}{confirmed.versionID}{' salva em '}{confirmed.savedAt}.
    </p>}
    {createdPageHref && <p>
      <a href={createdPageHref}>Abrir página criada no editor nativo</a>
    </p>}
    <Modal slug={MODAL_SLUG} className="portal-page-editorial-confirmation">
      <div role="dialog" aria-modal="true" aria-labelledby="portal-page-editorial-confirm-title">
        <h2 id="portal-page-editorial-confirm-title">Confirmar publicação da versão salva</h2>
        {confirmed && <p>
          {pageTitle} — versão {confirmed.versionID}, salva em {confirmed.savedAt}.
        </p>}
        <p>{publicationAction === 'publish'
          ? 'A publicação usará somente esta versão explícita, não alterações locais ou futuras.'
          : 'A despublicação usará somente esta versão explícita e preservará a versão de origem.'}</p>
        <div className="portal-page-editorial-confirmation__actions">
          <Button type="button" disabled={blocked || !hasMatchingConfirmation || !publicationAction} onClick={confirmPublication}>
            {publicationAction === 'unpublish' ? 'Despublicar esta versão' : 'Publicar esta versão'}
          </Button>
          <Button type="button" buttonStyle="secondary" disabled={busy} onClick={() => {
            closeModal(MODAL_SLUG)
            setPublicationAction(null)
          }}>Cancelar</Button>
        </div>
        <p role="status" aria-live="polite">{message}</p>
        {failure && <p role="alert">{failure}</p>}
      </div>
    </Modal>
  </section>
}

function creatingSaveBlocked(gate: EditorGate, creating: boolean): boolean {
  return creating ? editorialBlocked({ ...gate, modified: false }) : editorialBlocked(gate)
}
