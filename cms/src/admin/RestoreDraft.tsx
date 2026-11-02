'use client'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button, ConfirmationModal, Gutter, useModal } from '@payloadcms/ui'
import { useRouter } from 'next/navigation'
import type { readRestoreDraft, RestoreTarget } from '../publication/restore-draft'

type Comparison = Awaited<ReturnType<typeof readRestoreDraft>>
const fieldLabels: Record<string, string> = { title: 'Título', category: 'Categoria', editorial: 'Informações editoriais', body: 'Conteúdo',
  eyebrow: 'Chamada', headline: 'Título de abertura', summary: 'Resumo' }
const display = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? '—'
const savedTime = (value: string) => new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })

export function RestoreDraft(input: RestoreTarget) {
  const { target, documentId, sourceVersionId } = input
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const pending = useRef<AbortController | null>(null), restoring = useRef(false)
  const content = useRef<HTMLDivElement>(null)
  const { openModal, closeModal } = useModal()
  const router = useRouter(), modalSlug = 'news-restore-draft-confirm'
  const editPath = target === 'news-articles' ? `/editorial/admin/collections/news-articles/${documentId}` : '/editorial/admin/globals/news-home'
  const reload = useCallback(async () => {
    pending.current?.abort()
    const controller = new AbortController(); pending.current = controller
    setComparison(null)
    if (content.current) content.current.hidden = true
    try {
      const query = new URLSearchParams({ target, documentId, sourceVersionId })
      const response = await fetch(`/editorial/api/news-restore-draft?${query}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal })
      if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'Sua sessão não permite consultar este histórico.' : 'Não foi possível consultar a revisão salva.')
      const value = await response.json() as Comparison
      if (controller.signal.aborted || pending.current !== controller) return
      if (value.target !== target || value.documentId !== documentId || value.source?.id !== sourceVersionId ||
        !value.head?.id || !/^[0-9a-f]{64}$/u.test(value.expectedHeadToken) || !/^[0-9a-f]{64}$/u.test(value.sourceRevisionToken)) throw new Error('Revisão indisponível.')
      setComparison(value)
      if (content.current) content.current.hidden = false
    } catch (error) {
      if (!controller.signal.aborted && pending.current === controller) setMessage(error instanceof Error ? error.message : 'Histórico indisponível.')
    }
  }, [target, documentId, sourceVersionId])
  useEffect(() => {
    setMessage(''); void reload()
    const hide = () => { if (content.current) content.current.hidden = true; pending.current?.abort(); setComparison(null) }
    const refresh = () => { if (!restoring.current && document.visibilityState === 'visible') void reload() }
    const visibility = () => document.visibilityState === 'visible' ? refresh() : hide()
    window.addEventListener('pagehide', hide); window.addEventListener('pageshow', refresh); window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', visibility)
    const interval = window.setInterval(refresh, 30_000)
    return () => {
      pending.current?.abort(); window.clearInterval(interval)
      window.removeEventListener('pagehide', hide); window.removeEventListener('pageshow', refresh); window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [reload])

  async function restore() {
    if (!comparison?.canRestore || restoring.current) return
    restoring.current = true; setBusy(true); setMessage(''); pending.current?.abort()
    try {
      const response = await fetch('/editorial/api/news-restore-draft', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target, documentId, sourceVersionId,
          sourceRevisionToken: comparison.sourceRevisionToken, expectedHeadToken: comparison.expectedHeadToken }) })
      if (!response.ok) {
        setMessage(response.status === 409 ? 'A revisão ou o rascunho mudou. Confira o histórico atualizado antes de restaurar.' : 'Restauração não confirmada. Confira o histórico atualizado antes de tentar novamente.')
        await reload(); return
      }
      const result = await response.json()
      if (result._status !== 'draft' || result.documentId !== documentId || result.sourceVersionId !== sourceVersionId || !result.versionId) throw new Error('unconfirmed')
      router.push(editPath); router.refresh()
    } catch {
      setMessage('Resposta não confirmada. Confira a revisão mais recente e sua origem antes de tentar novamente.')
      await reload()
    } finally { closeModal(modalSlug); restoring.current = false; setBusy(false) }
  }

  return <Gutter><h2>Comparar revisão salva</h2>
    <p><a href={`${editPath}/versions`}>Voltar ao histórico</a></p>
    <p role="status" aria-live="polite">{message || (!comparison ? 'Consultando histórico…' : '')}</p>
    {!comparison && <Button buttonStyle="secondary" disabled={busy} onClick={() => { setMessage(''); void reload() }}>Consultar novamente</Button>}
    <div ref={content}>
      {comparison && <>
        <p>Revisão de {savedTime(comparison.source.savedAt)} — {comparison.source.status === 'published' ? 'publicada na origem' : 'rascunho'}.</p>
        <p>Comparada à revisão mais recente, salva em {savedTime(comparison.head.savedAt)}.</p>
        {comparison.head.restoredFrom && <p>A revisão mais recente foi restaurada da versão <code>{comparison.head.restoredFrom}</code>.</p>}
        <div style={{ overflowX: 'auto' }}><table className="table"><thead><tr><th>Campo</th><th>Revisão selecionada</th><th>Revisão mais recente</th></tr></thead>
          <tbody>{Object.keys(comparison.source.content).map(field => <tr key={field}><th scope="row">{fieldLabels[field] || field}</th>
            {[comparison.source.content[field], comparison.head.content[field]].map((value, index) => <td key={index}><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' }}>{display(value)}</pre></td>)}</tr>)}</tbody>
        </table></div>
        <p>Restaurar cria um novo rascunho. A publicação atual só muda quando você publicar explicitamente.</p>
        {!comparison.canRestore && <p>Restauração indisponível: modo somente leitura ou edição em andamento.</p>}
        <Button disabled={busy || !comparison.canRestore} onClick={() => openModal(modalSlug)}>Restaurar como novo rascunho</Button>
        <ConfirmationModal modalSlug={modalSlug} heading="Restaurar como novo rascunho?"
          body="A revisão selecionada será salva como um novo rascunho. A publicação atual será preservada."
          confirmLabel="Restaurar rascunho" confirmingLabel="Restaurando…" onConfirm={restore} />
      </>}
    </div>
  </Gutter>
}
