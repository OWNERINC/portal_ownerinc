'use client'
import React, { useEffect, useState } from 'react'
import { useDocumentInfo } from '@payloadcms/ui'
import { LegacyHistoryList, readHistoryPage, type LegacyHistoryRow } from './LegacyHistoryList'

const selectedFields = ['legacyDocumentId', 'legacyRevisionId', 'originalVersion', 'originalCreatedAt', 'originalActorUid', 'originalStatus', 'originalTitle', 'originalCategory', 'originalPublishedAt', 'metadataBasis']
export function LegacyHistory() {
  const { id } = useDocumentInfo()
  const documentId = typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id) ? id : null
  const [open, setOpen] = useState(false)
  const [page, setPage] = useState(1)
  const [reload, setReload] = useState(0)
  const [rows, setRows] = useState<LegacyHistoryRow[]>([])
  const [hasNextPage, setHasNextPage] = useState(false)
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error' | 'denied'>('idle')
  useEffect(() => { setPage(1); setRows([]); setState('idle') }, [documentId])
  useEffect(() => {
    if (!open || !documentId) return
    const abort = new AbortController()
    setRows([]); setHasNextPage(false); setState('loading')
    const query = new URLSearchParams({ 'where[legacyDocumentId][equals]': documentId, page: String(page), limit: '20', depth: '0', sort: '-originalVersion' })
    for (const field of selectedFields) query.set(`select[${field}]`, 'true')
    void (async () => {
      try {
        const response = await fetch(`/editorial/api/legacy-news-revisions?${query}`, { credentials: 'same-origin', cache: 'no-store', signal: abort.signal })
        if (response.status === 401 || response.status === 403) { if (!abort.signal.aborted) setState('denied'); return }
        if (!response.ok) throw new Error('history_unavailable')
        const result = readHistoryPage(await response.json(), documentId)
        if (abort.signal.aborted) return
        setRows(result.rows); setHasNextPage(result.hasNextPage); setState('ready')
      } catch { if (!abort.signal.aborted) { setRows([]); setState('error') } }
    })()
    return () => abort.abort()
  }, [documentId, open, page, reload])
  useEffect(() => {
    const revalidate = () => { if (document.visibilityState === 'visible') { setRows([]); setReload(value => value + 1) } }
    window.addEventListener('focus', revalidate); document.addEventListener('visibilitychange', revalidate)
    return () => { window.removeEventListener('focus', revalidate); document.removeEventListener('visibilitychange', revalidate) }
  }, [])
  if (!documentId) return null
  return <details onToggle={event => setOpen(event.currentTarget.open)} style={{ maxWidth: '100%', overflowWrap: 'anywhere' }}>
    <summary>Histórico anterior à migração</summary>
    <p>Revisões preservadas do CMS anterior. O status é o registrado na origem; as versões nativas do Payload estão no histórico próprio da matéria.</p>
    {state === 'loading' && <p role="status">Carregando histórico…</p>}
    {state === 'denied' && <p role="alert">Sua sessão editorial não permite consultar este histórico.</p>}
    {state === 'error' && <div role="alert"><p>Não foi possível carregar o histórico.</p><button type="button" onClick={() => setReload(value => value + 1)}>Tentar novamente</button></div>}
    {state === 'ready' && <><LegacyHistoryList rows={rows} />
      <nav aria-label="Páginas do histórico anterior" style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" disabled={page === 1} onClick={() => setPage(value => value - 1)}>Anterior</button>
        <span>Página {page}</span>
        <button type="button" disabled={!hasNextPage} onClick={() => setPage(value => value + 1)}>Próxima</button>
      </nav></>}
  </details>
}
