'use client'

import React, { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { RelationshipFieldClientProps } from 'payload'
import { RelationshipField, useDocumentForm, useDocumentInfo, useField, useForm, useFormBackgroundProcessing,
  useFormFields, useFormInitializing, useFormProcessing } from '@payloadcms/ui'
import { useEditorialFieldFocusTarget } from './editorial-focus'
import { PortalPageUploadPanel, PortalPageUploadPanelHostContext } from './PortalPageUploadPanel'
import { isDestinationSelectable, portalPageUploadIsOwnedByOther, readCompleteMedia, sameDestination } from './upload-client'
import type { CompleteMedia, Destination, MediaKind } from './upload-client'
import { isPortalPageMediaEditable } from './upload-panel-state'

type NativeAncestors = {
  blockID: string | null
  galleryItemID: string | null
  blockType: string | null
}

function rowID(rows: Array<{ id?: unknown }> | undefined, index: number): string | null {
  const id = rows?.[index]?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}

function blockTypeAt(rows: Array<{ blockType?: unknown }> | undefined, index: number): string | null {
  const blockType = rows?.[index]?.blockType
  return typeof blockType === 'string' && blockType.length > 0 ? blockType : null
}

function targetKindMatches(path: string, blockType: string | null, kind: MediaKind): boolean {
  if (path === 'cover') return kind === 'image'
  const simple = path.match(/^body\.(\d+)\.asset$/u)
  if (simple) {
    const expectedBlock = kind === 'image' ? 'image' : kind
    return blockType === expectedBlock
  }
  const gallery = path.match(/^body\.(\d+)\.images\.\d+\.asset$/u)
  return Boolean(gallery && kind === 'image' && blockType === 'gallery')
}

export function PortalPageMediaField(props: RelationshipFieldClientProps & { kind: MediaKind }): React.JSX.Element {
  const { kind, ...relationshipProps } = props
  const info = useDocumentInfo()
  const triggerID = useId().replace(/[^a-zA-Z0-9_-]/gu, '')
  const disabledExplanationID = `portal-page-upload-disabled-${triggerID}`
  const form = useForm()
  const processing = useFormProcessing()
  const backgroundProcessing = useFormBackgroundProcessing()
  const initializing = useFormInitializing()
  const documentForm = useDocumentForm()
  const fieldState = useField<string | null>({ potentiallyStalePath: props.path })
  const path = fieldState.path
  const documentID = String(info.id ?? '')
  const ancestors = useFormFields(([fields]): NativeAncestors => {
    const gallery = path.match(/^body\.(\d+)\.images\.(\d+)\.asset$/u)
    const block = path.match(/^body\.(\d+)\.(?:asset|images\.\d+\.asset)$/u) ?? gallery
    if (!block) return { blockID: null, galleryItemID: null, blockType: null }
    const blockIndex = Number(block[1])
    const galleryIndex = gallery ? Number(gallery[2]) : null
    const nativeBlockRows = fields.body?.rows
    const blockID = rowID(nativeBlockRows, blockIndex)
    const blockType = blockTypeAt(nativeBlockRows, blockIndex)
    const galleryRows = gallery ? fields[`body.${blockIndex}.images`]?.rows : undefined
    return { blockID, blockType, galleryItemID: galleryIndex === null ? null : rowID(galleryRows, galleryIndex) }
  })
  const generationRef = useRef<{ identity: string; generation: number } | null>(null)
  const capturedDestinationRef = useRef<Destination | null>(null)
  const destinationInvalidatedRef = useRef(false)
  const readGenerationRef = useRef(0)
  const readControllerRef = useRef<AbortController | null>(null)
  const mutexOwnerRef = useRef<object>({})
  const focusTarget = useEditorialFieldFocusTarget<HTMLButtonElement>(path)
  const [panelOpen, setPanelOpen] = useState(false)
  const [selectorRefresh, setSelectorRefresh] = useState(0)
  const [ready, setReady] = useState<CompleteMedia | null>(null)
  const [selectionError, setSelectionError] = useState('')

  const identity = JSON.stringify([documentID, path, ancestors.blockID, ancestors.galleryItemID, ancestors.blockType])
  const previousObservation = generationRef.current
  if (!previousObservation) generationRef.current = { identity, generation: 0 }
  else if (previousObservation.identity !== identity) {
    generationRef.current = { identity, generation: previousObservation.generation + 1 }
    if (capturedDestinationRef.current) destinationInvalidatedRef.current = true
  }
  const destination: Destination = {
    documentID, path, blockID: ancestors.blockID, galleryItemID: ancestors.galleryItemID,
    generation: generationRef.current!.generation,
  }
  const currentDestinationRef = useRef(destination)
  currentDestinationRef.current = destination
  const readyRef = useRef<CompleteMedia | null>(ready)
  readyRef.current = ready
  const editabilityRef = useRef({ fieldDisabled: Boolean(fieldState.disabled), readOnly: Boolean(props.readOnly),
    formDisabled: Boolean(form.disabled), locked: Boolean(info.documentIsLocked || info.isLocked), processing,
    backgroundProcessing, initializing: Boolean(form.initializing || initializing),
    documentInitializing: Boolean(info.isInitializing) })
  editabilityRef.current = { fieldDisabled: Boolean(fieldState.disabled), readOnly: Boolean(props.readOnly),
    formDisabled: Boolean(form.disabled), locked: Boolean(info.documentIsLocked || info.isLocked), processing,
    backgroundProcessing, initializing: Boolean(form.initializing || initializing),
    documentInitializing: Boolean(info.isInitializing) }

  const canOperate = useCallback((): { ok: boolean; message?: string } => {
    if (isPortalPageMediaEditable(editabilityRef.current)) return { ok: true }
    return { ok: false, message: 'O campo ou formulário está desabilitado, bloqueado ou em processamento. Aguarde antes de operar a mídia.' }
  }, [])

  useEffect(() => () => {
    readGenerationRef.current += 1
    readControllerRef.current?.abort()
  }, [])

  const destinationStillMatches = useCallback((): boolean => {
    const captured = capturedDestinationRef.current
    const current = currentDestinationRef.current
    return Boolean(captured && !destinationInvalidatedRef.current && sameDestination(captured, current) &&
      isDestinationSelectable(current, kind) && targetKindMatches(current.path, ancestors.blockType, kind))
  }, [ancestors.blockType, kind])

  const onUploadStart = useCallback((): { ok: boolean; message?: string } => {
    const permission = canOperate()
    if (!permission.ok) {
      setSelectionError(permission.message || 'O campo não está disponível para envio agora.')
      return permission
    }
    const current = currentDestinationRef.current
    if (!isDestinationSelectable(current, kind) || !targetKindMatches(current.path, ancestors.blockType, kind)) {
      setSelectionError('Este destino ainda não tem uma identidade nativa segura. Salve ou atualize a linha e tente novamente.')
      return { ok: false, message: 'Este destino ainda não tem uma identidade nativa segura. Salve ou atualize a linha e tente novamente.' }
    }
    // A new upload supersedes any completion reread from the previous file.
    // Abort it before capturing the new destination so its response cannot
    // make stale media selectable while this upload is in progress.
    readGenerationRef.current += 1
    readControllerRef.current?.abort()
    readControllerRef.current = null
    capturedDestinationRef.current = { ...current }
    destinationInvalidatedRef.current = false
    setReady(null)
    setSelectionError('')
    return { ok: true }
  }, [ancestors.blockType, canOperate, kind])

  const onComplete = useCallback((media: CompleteMedia): void => {
    const captured = capturedDestinationRef.current
    if (!captured || destinationInvalidatedRef.current || !destinationStillMatches()) {
      setReady(null)
      setSelectionError('A página ou a linha de destino mudou durante o envio. O arquivo foi concluído, mas não será selecionado neste destino.')
      return
    }

    const generation = ++readGenerationRef.current
    readControllerRef.current?.abort()
    const controller = new AbortController()
    readControllerRef.current = controller
    setReady(null)
    setSelectionError('Conferindo a mídia concluída…')
    void readCompleteMedia(media.id, kind, controller.signal).then(confirmed => {
      if (generation !== readGenerationRef.current || controller.signal.aborted) return
      if (destinationInvalidatedRef.current || !sameDestination(captured, currentDestinationRef.current) || !destinationStillMatches()) {
        setReady(null)
        setSelectionError('A página ou a linha de destino mudou durante o envio. O arquivo foi concluído, mas não será selecionado neste destino.')
        return
      }
      if (confirmed.id !== media.id || confirmed.mimeType !== media.mimeType || confirmed.bytes !== media.bytes ||
        confirmed.sha256 !== media.sha256 || confirmed.completedAt !== media.completedAt) {
        setReady(null)
        setSelectionError('A mídia consultada não corresponde ao arquivo concluído. A seleção permanece desativada.')
        return
      }
      setReady(confirmed)
      setSelectorRefresh(current => current + 1)
      setSelectionError('')
    }).catch(() => {
      if (generation !== readGenerationRef.current || controller.signal.aborted) return
      setReady(null)
      setSelectionError('A mídia concluída não pôde ser confirmada. A seleção permanece desativada; atualize o estado e tente novamente.')
    })
  }, [destinationStillMatches, kind])

  function closePanel(): void {
    readGenerationRef.current += 1
    readControllerRef.current?.abort()
    readControllerRef.current = null
    setReady(null)
    setSelectionError('')
    capturedDestinationRef.current = null
    destinationInvalidatedRef.current = false
    setPanelOpen(false)
  }

  function selectReadyMedia(closeUploadPanel: () => void): void {
    const media = readyRef.current
    const permission = canOperate()
    if (!permission.ok) {
      setSelectionError(permission.message || 'O campo não está disponível para selecionar mídia agora.')
      return
    }
    if (!media || !destinationStillMatches()) {
      setSelectionError('O destino mudou. O arquivo não foi selecionado; atualize a página e envie novamente.')
      return
    }
    fieldState.setValue(media.id)
    // Only the Payload selector is refreshed. This wrapper and its useField state stay mounted.
    setSelectorRefresh(current => current + 1)
    closeUploadPanel()
  }

  const relationshipComponentProps: RelationshipFieldClientProps = { ...relationshipProps, path }
  const permission = canOperate()
  const isBlocked = !permission.ok ||
    info.uploadStatus === 'uploading' ||
    portalPageUploadIsOwnedByOther(documentID, documentForm, mutexOwnerRef.current)
  const disabledExplanation = info.uploadStatus === 'uploading' || portalPageUploadIsOwnedByOther(documentID, documentForm, mutexOwnerRef.current)
    ? 'Aguarde o envio ativo neste documento antes de iniciar outro arquivo.'
    : permission.message || 'O campo está indisponível ou somente leitura neste momento.'

  return <div className="portal-page-media-field" data-portal-page-media-path={path}>
    <RelationshipField {...relationshipComponentProps} key={selectorRefresh} />
    <div className="portal-page-media-field__actions">
      <button type="button" ref={focusTarget} disabled={isBlocked} aria-describedby={isBlocked ? disabledExplanationID : undefined} onClick={() => {
        setSelectionError('')
        setReady(null)
        setPanelOpen(true)
      }}>Enviar novo arquivo</button>
      {isBlocked && <p id={disabledExplanationID}>{disabledExplanation}</p>}
    </div>
    {panelOpen && <PortalPageUploadPanelHostContext.Provider value={{ onUploadStart, canOperate,
      selectionSlot: closeUploadPanel => <div className="portal-page-media-field__selection">
        {selectionError && <p role={selectionError === 'Conferindo a mídia concluída…' ? 'status' : 'alert'}
          aria-live={selectionError === 'Conferindo a mídia concluída…' ? 'polite' : undefined}>{selectionError}</p>}
        {ready && <button type="button" disabled={!canOperate().ok || !destinationStillMatches() || Boolean(selectionError)}
          onClick={() => selectReadyMedia(closeUploadPanel)}>Usar este arquivo</button>}
        {capturedDestinationRef.current && !destinationStillMatches() &&
          <p role="alert">O destino mudou. A seleção deste arquivo está desativada.</p>}
      </div> }}>
      <PortalPageUploadPanel kind={kind} onComplete={onComplete} onClose={closePanel} />
    </PortalPageUploadPanelHostContext.Provider>}
  </div>
}
