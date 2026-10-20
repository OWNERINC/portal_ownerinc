'use client'

import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import { Drawer, useDocumentForm, useDocumentInfo, useModal } from '@payloadcms/ui'
import { PORTAL_PAGE_UPLOAD_ACCEPT, PORTAL_PAGE_UPLOAD_FORMAT_HELP, UploadClientError, claimPortalPageUpload, createUploadClient,
  releasePortalPageUpload, validateUploadFile } from './upload-client'
import type { CompleteMedia, MediaKind, UploadClient, UploadProgress } from './upload-client'
import { resolveUploadDrawerClose, shouldRetainUploadActivityAfterRunFailure } from './upload-panel-state'

type UploadPanelHost = {
  onUploadStart?: () => { ok: boolean; message?: string }
  canOperate?: () => { ok: boolean; message?: string }
  selectionSlot?: (closePanel: () => void) => React.ReactNode
}

export const PortalPageUploadPanelHostContext = createContext<UploadPanelHost>({})

const MiB = 1024 * 1024
const ACTIVE_PHASES = new Set<UploadProgress['phase']>(['preparing', 'uploading', 'validating', 'cancelling'])

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
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

function formatBytes(bytes: number): string {
  if (bytes < MiB) return `${bytes} bytes`
  const value = Math.round(bytes / MiB * 10) / 10
  return `${Number.isInteger(value) ? value : value.toFixed(1)} MiB`
}

function progressMessage(progress: UploadProgress | null): string {
  if (!progress) return 'Escolha um arquivo'
  if (progress.phase === 'preparing') return 'Preparando envio…'
  if (progress.phase === 'uploading') {
    const current = Math.min(progress.count, progress.index + (progress.index < progress.count ? 1 : 0))
    return `Enviando bloco ${current} de ${progress.count} — ${formatBytes(progress.confirmedBytes)} de ${formatBytes(progress.totalBytes)}`
  }
  if (progress.phase === 'validating') return 'Validando arquivo…'
  if (progress.phase === 'ready') return 'Arquivo pronto para selecionar'
  if (progress.phase === 'cancelling') return 'Cancelando…'
  if (progress.phase === 'cancelled') return 'Envio cancelado'
  return 'O envio foi interrompido.'
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof UploadClientError) return error.message
  return 'Não foi possível concluir o envio. Confira o estado antes de tentar novamente.'
}

export function PortalPageUploadPanel(props: {
  kind: MediaKind
  onComplete: (media: CompleteMedia) => void
  onClose: () => void
}): React.JSX.Element {
  const host = useContext(PortalPageUploadPanelHostContext)
  const info = useDocumentInfo()
  const documentForm = useDocumentForm()
  const { closeModal, modalState, openModal } = useModal()
  const rawID = useId()
  const slug = `portal-page-upload-${rawID.replace(/[^a-zA-Z0-9_-]/gu, '')}`
  const inputID = `${slug}-file`
  const instructionsID = `${slug}-instructions`
  const ownerRef = useRef<object>({})
  const clientRef = useRef<UploadClient | null>(null)
  const activeRef = useRef(false)
  const disposedRef = useRef(false)
  const cancelIntentRef = useRef(false)
  const scopeRef = useRef<{ documentID: string; documentForm: object; setStatus?: (status: 'failed' | 'idle' | 'uploading') => void } | null>(null)
  const wasOpenRef = useRef(false)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [fileName, setFileName] = useState('')
  const [message, setMessage] = useState('')
  const [failure, setFailure] = useState('')
  const [retryable, setRetryable] = useState(false)
  const [hasSession, setHasSession] = useState(false)
  const [active, setActive] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [cancelPending, setCancelPending] = useState(false)
  const isOpen = Boolean(modalState[slug]?.isOpen)
  const onCloseRef = useRef(props.onClose)
  onCloseRef.current = props.onClose

  function makeClient(): UploadClient {
    return createUploadClient({
      fetch: (input, init) => fetch(input, init),
      sleep: defaultSleep,
      random: () => Math.random(),
      onProgress: next => {
        if (disposedRef.current) return
        setProgress(next)
        if (ACTIVE_PHASES.has(next.phase)) {
          activeRef.current = true
          setActive(true)
        } else if (next.phase === 'ready' || next.phase === 'cancelled') {
          activeRef.current = false
          setActive(false)
        }
      },
    })
  }

  const currentDocumentID = String(info.id ?? '')

  const openPanel = useCallback(() => openModal(slug), [openModal, slug])

  useEffect(() => {
    disposedRef.current = false
    clientRef.current = makeClient()
    openPanel()
    return () => {
      disposedRef.current = true
      clientRef.current?.dispose()
      clientRef.current = null
      activeRef.current = false
      const scope = scopeRef.current
      if (scope && releasePortalPageUpload(scope.documentID, scope.documentForm, ownerRef.current)) {
        scope.setStatus?.('idle')
      }
      scopeRef.current = null
    }
  }, [openPanel])

  useEffect(() => {
    const action = resolveUploadDrawerClose(wasOpenRef.current, isOpen, activeRef.current, hasSession)
    wasOpenRef.current = isOpen
    if (action === 'confirm-and-reopen') {
      setConfirmClose(true)
      openPanel()
    } else if (action === 'close-panel') {
      onCloseRef.current()
    }
  }, [hasSession, isOpen, openPanel])

  useEffect(() => {
    const scope = scopeRef.current
    if (!activeRef.current || !scope || (scope.documentID === currentDocumentID && scope.documentForm === documentForm)) return
    void cancelCurrentUpload()
    // This effect only cancels stale-document work; destination ownership is invalidated by the wrapper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDocumentID, documentForm])

  useEffect(() => {
    if (!active) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [active])

  useEffect(() => {
    if ((!active && !hasSession) || !isOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (!activeRef.current && !hasSession)) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      setConfirmClose(true)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [active, hasSession, isOpen])

  function setOwnedStatus(status: 'failed' | 'idle' | 'uploading'): void {
    const scope = scopeRef.current
    if (!scope) return
    const released = releasePortalPageUpload(scope.documentID, scope.documentForm, ownerRef.current)
    if (released) scope.setStatus?.(status)
    scopeRef.current = null
  }

  function acquireForRun(): boolean {
    if (scopeRef.current) {
      if (!claimPortalPageUpload(scopeRef.current.documentID, scopeRef.current.documentForm, ownerRef.current)) return false
      scopeRef.current.setStatus?.('uploading')
      return true
    }
    if (info.uploadStatus === 'uploading' || !claimPortalPageUpload(currentDocumentID, documentForm, ownerRef.current)) return false
    scopeRef.current = { documentID: currentDocumentID, documentForm, setStatus: info.setUploadStatus }
    info.setUploadStatus?.('uploading')
    return true
  }

  async function runUpload(action: () => Promise<CompleteMedia>): Promise<void> {
    if (activeRef.current) return
    const permission = host.canOperate?.() ?? { ok: true }
    if (!permission.ok) {
      setFailure(permission.message || 'O formulário não está disponível para operar este envio agora.')
      return
    }
    if (!acquireForRun()) {
      setFailure('Outro envio está ativo neste documento. Aguarde antes de iniciar ou retomar um arquivo.')
      return
    }
    cancelIntentRef.current = false
    setCancelPending(false)
    setFailure('')
    setRetryable(false)
    activeRef.current = true
    setActive(true)
    try {
      const media = await action()
      activeRef.current = false
      setActive(false)
      setOwnedStatus('idle')
      setHasSession(false)
      setRetryable(false)
      setFailure('')
      setMessage('')
      props.onComplete(media)
    } catch (error) {
      if (shouldRetainUploadActivityAfterRunFailure(cancelIntentRef.current)) return
      activeRef.current = false
      setActive(false)
      const isRetryable = error instanceof UploadClientError && error.retryable
      setFailure(safeErrorMessage(error))
      setRetryable(isRetryable)
      setOwnedStatus('failed')
    }
  }

  function onFileChange(event: React.ChangeEvent<HTMLInputElement>): void {
    const file = event.currentTarget.files?.[0]
    if (!file) return
    setFailure('')
    setMessage('')
    setCancelPending(false)
    try { validateUploadFile(file, props.kind) }
    catch (error) {
      setFailure(safeErrorMessage(error))
      setRetryable(false)
      return
    }
    const target = host.onUploadStart?.() ?? { ok: true }
    if (!target.ok) {
      setFailure(target.message || 'Este destino mudou ou ainda não tem uma identidade nativa segura. Atualize a página e tente novamente.')
      setRetryable(false)
      return
    }
    setFileName(file.name)
    setHasSession(true)
    void runUpload(() => clientRef.current!.start(file, props.kind))
  }

  function onRetry(): void {
    if (!retryable || activeRef.current) return
    void runUpload(() => clientRef.current!.retry())
  }

  function closePanel(): void {
    if (activeRef.current || hasSession) {
      setConfirmClose(true)
      return
    }
    closeModal(slug)
    props.onClose()
  }

  async function cancelCurrentUpload(): Promise<void> {
    if (!hasSession || !clientRef.current) {
      setConfirmClose(false)
      closeModal(slug)
      props.onClose()
      return
    }
    const permission = host.canOperate?.() ?? { ok: true }
    if (!permission.ok) {
      setFailure(permission.message || 'O formulário não está disponível para cancelar este envio agora.')
      return
    }
    if (!acquireForRun()) {
      setFailure('Outro envio está ativo neste documento. Aguarde antes de cancelar este arquivo.')
      return
    }
    cancelIntentRef.current = true
    activeRef.current = true
    setActive(true)
    setFailure('')
    setRetryable(false)
    try {
      const result = await clientRef.current.cancel()
      if (result === 'cancelled') {
        activeRef.current = false
        setActive(false)
        setHasSession(false)
        setOwnedStatus('idle')
        setConfirmClose(false)
        setCancelPending(false)
        setMessage('Envio cancelado')
        cancelIntentRef.current = false
        return
      }
      if (result === 'complete') {
        const media = await clientRef.current.retry()
        activeRef.current = false
        setActive(false)
        setHasSession(false)
        setOwnedStatus('idle')
        setConfirmClose(false)
        setMessage('Arquivo pronto para selecionar')
        props.onComplete(media)
        cancelIntentRef.current = false
        return
      }
      activeRef.current = false
      setActive(false)
      setOwnedStatus('failed')
      setCancelPending(true)
      setFailure('Cancelamento pendente. Não foi possível confirmar a remoção; o envio pode continuar ativo.')
      setConfirmClose(false)
      cancelIntentRef.current = false
    } catch (error) {
      activeRef.current = false
      setActive(false)
      setOwnedStatus('failed')
      setCancelPending(true)
      setFailure(safeErrorMessage(error))
      setConfirmClose(false)
      cancelIntentRef.current = false
    }
  }

  const messageForStatus = progressMessage(progress)
  const isActiveProgress = progress !== null && ACTIVE_PHASES.has(progress.phase)
  const progressMaximum = progress?.totalBytes || 1
  const progressValue = Math.min(progress?.confirmedBytes || 0, progressMaximum)

  return <Drawer slug={slug} title="Enviar mídia para esta página">
    <section className="portal-page-upload-panel" aria-label="Envio de mídia da página">
      <p id={instructionsID}>{`Formatos e limites: ${PORTAL_PAGE_UPLOAD_FORMAT_HELP[props.kind]}`}</p>
      <label htmlFor={inputID}>Escolha um arquivo</label>
      <input id={inputID} type="file" accept={PORTAL_PAGE_UPLOAD_ACCEPT[props.kind]}
        aria-describedby={instructionsID} onChange={onFileChange} disabled={hasSession || active} />
      {fileName && <p>Arquivo escolhido: {fileName}</p>}
      {progress && progress.totalBytes > 0 && <progress role="progressbar" aria-label="Blocos confirmados do envio"
        aria-valuemin={0} aria-valuemax={progressMaximum} aria-valuenow={progressValue}
        max={progressMaximum} value={progressValue} />}
      <p role="status" aria-live="polite">{message || messageForStatus}</p>
      {failure && <p role="alert">{failure}</p>}
      {host.selectionSlot?.(closePanel)}
      {retryable && <button type="button" onClick={onRetry} disabled={active}>Tentar novamente</button>}
      {hasSession && progress?.phase !== 'ready' && progress?.phase !== 'cancelled' &&
        <button type="button" onClick={() => setConfirmClose(true)} disabled={progress?.phase === 'cancelling'}>Cancelar envio</button>}
      {cancelPending && <button type="button" onClick={() => void cancelCurrentUpload()}>Tentar cancelar novamente</button>}
      {confirmClose && <div className="portal-page-upload-panel__cancel-confirmation" role="alertdialog"
        aria-labelledby={`${slug}-cancel-title`} aria-live="assertive">
        <p id={`${slug}-cancel-title`}>Cancelar envio?</p>
        <button type="button" onClick={() => void cancelCurrentUpload()}>Confirmar cancelamento</button>
        <button type="button" onClick={() => setConfirmClose(false)}>Continuar envio</button>
        {cancelPending && <button type="button" onClick={() => {
          closeModal(slug)
          props.onClose()
        }}>Fechar sem confirmação</button>}
      </div>}
      {!active && !hasSession && <button type="button" onClick={closePanel}>Fechar painel</button>}
    </section>
  </Drawer>
}
