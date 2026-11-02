'use client'
import React, { useRef, useState } from 'react'
import { Button, useDocumentInfo, useForm, useFormBackgroundProcessing, useFormInitializing,
  useFormModified, useFormProcessing, useModal } from '@payloadcms/ui'

export function SaveDraftCheckpoint() {
  const info = useDocumentInfo(), form = useForm(), { modalState } = useModal()
  const modified = useFormModified(), background = useFormBackgroundProcessing(), processing = useFormProcessing(), initializing = useFormInitializing()
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), pending = useRef(false)
  const versions = info.docConfig?.versions
  if (!versions || !versions.drafts || !versions.drafts.autosave) return null
  const disabled = busy || background || processing || initializing || form.disabled || info.documentIsLocked ||
    info.uploadStatus === 'uploading' || Object.values(modalState).some(modal => modal.isOpen) ||
    info.hasSavePermission === false || (!modified && !info.mostRecentVersionIsAutosaved) || (!info.id && !info.globalSlug)
  async function save() {
    if (disabled || pending.current) return
    pending.current = true; setBusy(true); setMessage('')
    try {
      const path = info.globalSlug ? `/globals/${info.globalSlug}` : `/${info.collectionSlug}/${info.id}`
      const result = await form.submit({ action: `/editorial/api${path}?draft=true&autosave=false&depth=0`,
        method: info.globalSlug ? 'POST' : 'PATCH', overrides: { _status: 'draft' }, skipValidation: true,
        acceptValues: { overrideLocalChanges: false } })
      if (!result?.res?.ok) { setMessage('Não foi possível confirmar a revisão. Seus campos foram preservados.'); return }
      info.setMostRecentVersionIsAutosaved(false)
      info.setUnpublishedVersionCount(count => count + 1)
      setMessage('Revisão do rascunho salva.')
    } catch { setMessage('Resposta não confirmada. Confira o histórico antes de tentar novamente.') }
    finally { pending.current = false; setBusy(false) }
  }
  return <div><Button buttonStyle="secondary" type="button" disabled={Boolean(disabled)} onClick={save}>Salvar revisão do rascunho</Button>
    <p role="status" aria-live="polite">{message}</p></div>
}
