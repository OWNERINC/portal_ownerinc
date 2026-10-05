'use client'

import React, { useEffect, useRef, useState } from 'react'
import { Button, useDocumentInfo, useForm, useFormBackgroundProcessing, useFormInitializing,
  useFormModified, useFormProcessing, useModal } from '@payloadcms/ui'
import { scheduleBlocked, SCHEDULE_TIMEZONE } from './schedule-state'
import { savedPreview } from './preview-state'

// Public Payload extension, beside native controls. No form submission or hidden save.
export function SavedPreview() {
  const info = useDocumentInfo(), form = useForm(), { modalState } = useModal()
  const modified = useFormModified(), processing = useFormProcessing(), backgroundProcessing = useFormBackgroundProcessing(), initializing = useFormInitializing()
  const documentId = String(info.id || '')
  const unsafe = scheduleBlocked({ modified, processing, backgroundProcessing, initializing,
    disabled: form.disabled || Boolean(info.documentIsLocked), uploading: info.uploadStatus === 'uploading',
    otherModalOpen: Object.values(modalState).some(modal => modal.isOpen), busy: false })
  const [revision, setRevision] = useState<Awaited<ReturnType<typeof savedPreview>> | null>(null)
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const pending = useRef<AbortController | null>(null)
  const current = useRef({ documentId, unsafe }); current.current = { documentId, unsafe }
  useEffect(() => {
    pending.current?.abort(); pending.current = null; setRevision(null); setBusy(false); setMessage('')
    return () => { pending.current?.abort(); pending.current = null }
  }, [documentId, unsafe])
  async function load() {
    if (unsafe || busy || !documentId || pending.current) return
    const controller = new AbortController(); pending.current = controller
    setBusy(true); setMessage(''); setRevision(null)
    const active = () => pending.current === controller && !controller.signal.aborted
      && current.current.documentId === documentId && !current.current.unsafe
    try {
      const saved = await savedPreview(documentId, controller.signal)
      if (active()) setRevision(saved)
    } catch (error) {
      if (active()) setMessage(error instanceof Error ? error.message : 'Prévia indisponível.')
    } finally {
      if (pending.current === controller) { pending.current = null; setBusy(false) }
    }
  }
  return <div>
    <Button buttonStyle="secondary" type="button" disabled={unsafe || busy || !documentId} onClick={load}>Conferir prévia salva</Button>
    {revision && !unsafe && <p>
      <a href={revision.href} target="_blank" rel="noopener noreferrer">Abrir prévia editorial em nova aba</a>
      {' — salva em '}{new Date(revision.savedAt).toLocaleString('pt-BR', { timeZone: SCHEDULE_TIMEZONE })}.
    </p>}
    <p role="status" aria-live="polite">{unsafe ? 'Aguarde o salvamento ou upload pendente antes de conferir a prévia.' : message}</p>
  </div>
}
