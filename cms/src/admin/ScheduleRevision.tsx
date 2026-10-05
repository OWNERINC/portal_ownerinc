'use client'

import React, { useState } from 'react'
import { Button, CheckboxInput, Drawer, TextInput, useDocumentInfo, useForm, useFormBackgroundProcessing,
  useFormInitializing, useFormModified, useFormProcessing, useModal } from '@payloadcms/ui'
import { scheduleBlocked, scheduleConflictMessage, scheduleUTC, SCHEDULE_TIMEZONE } from './schedule-state'

type Revision = { versionId: string; snapshotHash: string; title: string; savedAt: string; generation: number;
  pending: { id: string; generation: number; scheduledAt: string; action: string }[] }

export function ScheduleRevision() {
  const info = useDocumentInfo()
  const form = useForm()
  const modified = useFormModified(), processing = useFormProcessing(), backgroundProcessing = useFormBackgroundProcessing(), initializing = useFormInitializing()
  const { modalState, openModal, closeModal } = useModal()
  const slug = 'owner-news-schedule'
  const [revision, setRevision] = useState<Revision | null>(null)
  const [date, setDate] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [withdraw, setWithdraw] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const target = info.globalSlug === 'news-home' ? 'news-home' : 'news-articles'
  const documentId = target === 'news-home' ? 'news-home' : String(info.id || '')
  const blocked = scheduleBlocked({ modified, processing, backgroundProcessing, initializing,
    disabled: form.disabled || Boolean(info.documentIsLocked), uploading: info.uploadStatus === 'uploading',
    otherModalOpen: Object.entries(modalState).some(([key, modal]) => key !== slug && modal.isOpen), busy })
  const endpoint = '/editorial/api/news-schedule'
  async function load() {
    if (blocked || !documentId) return
    setBusy(true); setMessage(''); setConfirmed(false)
    try {
      const response = await fetch(`${endpoint}?target=${target}&documentId=${encodeURIComponent(documentId)}`, { credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error('Não foi possível consultar a revisão salva.')
      setRevision(await response.json()); openModal(slug)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Agenda indisponível.') }
    finally { setBusy(false) }
  }
  async function submit(cancel = false) {
    if (blocked || !revision || (!cancel && !confirmed)) return
    let scheduledAt: string | undefined
    try { if (!cancel) scheduledAt = scheduleUTC(date) }
    catch (error) { setMessage((error as Error).message); return }
    setBusy(true); setMessage('')
    try {
      const pending = revision.pending[0]
      const response = await fetch(endpoint, { method: cancel ? 'DELETE' : 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cancel ? { id: pending.id, expectedGeneration: pending.generation } : {
          target, documentId, versionId: revision.versionId, snapshotHash: revision.snapshotHash,
          expectedGeneration: revision.generation, scheduledAt, action: withdraw ? 'unpublish' : 'publish',
        }) })
      if (response.status === 409) { setMessage(scheduleConflictMessage); setConfirmed(false); return }
      if (!response.ok) throw new Error('Não foi possível alterar a agenda. Confira os dados e sua permissão.')
      setMessage(cancel ? 'Agenda cancelada. O rascunho foi preservado.' : 'Revisão salva agendada. Edições posteriores não alteram este snapshot.')
      setRevision(null); setConfirmed(false)
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Agenda indisponível. Consulte antes de tentar novamente.') }
    finally { setBusy(false) }
  }
  return <>
    <Button buttonStyle="secondary" type="button" disabled={blocked || !documentId} onClick={load}>Agendar revisão salva</Button>
    {!modalState[slug]?.isOpen && message && <p role="status">{message}</p>}
    <Drawer slug={slug} title="Agendar revisão salva">
      <p>Fuso: {SCHEDULE_TIMEZONE}. Aguarde uploads e salvamentos antes de agendar.</p>
      {revision && <>
        <p>{revision.title} — revisão {revision.versionId}, salva em {new Date(revision.savedAt).toLocaleString('pt-BR', { timeZone: SCHEDULE_TIMEZONE })}.</p>
        <TextInput path="news-schedule-time" label="Data e hora (AAAA-MM-DD HH:mm)" value={date} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDate(event.target.value)} readOnly={busy} />
        <div className="field-type checkbox"><CheckboxInput id="news-schedule-withdraw" label="Despublicar nesta data" checked={withdraw} onToggle={event => setWithdraw(event.target.checked)} readOnly={busy} /></div>
        <div className="field-type checkbox"><CheckboxInput id="news-schedule-confirm" label="Confirmo esta revisão salva, não alterações locais ou futuras." checked={confirmed} onToggle={event => setConfirmed(event.target.checked)} readOnly={busy} /></div>
        <Button type="button" disabled={blocked || !confirmed || !date} onClick={() => submit()}>Confirmar agendamento</Button>
        {revision.pending.map(pending => <p key={pending.id}>
          Agenda atual: {new Date(pending.scheduledAt).toLocaleString('pt-BR', { timeZone: SCHEDULE_TIMEZONE })} ({pending.action === 'publish' ? 'publicar' : 'despublicar'}).
          <Button type="button" buttonStyle="secondary" disabled={blocked} onClick={() => submit(true)}>Cancelar agenda</Button>
        </p>)}
      </>}
      <p role="status" aria-live="polite">{message || (blocked ? 'Aguarde o salvamento ou upload pendente.' : '')}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--base)' }}>
        <Button type="button" buttonStyle="secondary" disabled={blocked} onClick={load}>Conferir revisão salva novamente</Button>
        <Button type="button" buttonStyle="secondary" disabled={busy} onClick={() => closeModal(slug)}>Fechar</Button>
      </div>
    </Drawer>
  </>
}
