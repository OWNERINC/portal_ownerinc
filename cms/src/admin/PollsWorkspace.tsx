'use client'
import React, { useEffect, useRef, useState } from 'react'
import { Button, Form, Gutter, LeaveWithoutSaving, SetStepNav, TextInput, useForm } from '@payloadcms/ui'
import { requestPolls, PollRequestError, type Poll, type PollDraft } from './polls-client'
import { emptyPoll, pollDraft, pollBaseline, validPollDraft, pollMutation } from './polls-state'
const labels = { draft: 'Rascunho', open: 'Aberta', closed: 'Encerrada' }
export function PollsWorkspace() { return <Gutter><Form el="div" initialState={{}} fields={[]} onSubmit={() => {}}><Workspace /></Form></Gutter> }
function Workspace() {
  const [rows, setRows] = useState<Poll[]>([]), [total, setTotal] = useState(0), [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<Poll | null>(null), [draft, setDraft] = useState<PollDraft>(emptyPoll)
  const [baseline, setBaseline] = useState(pollBaseline(emptyPoll())), [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false), [conflict, setConflict] = useState(false), [denied, setDenied] = useState(false), [message, setMessage] = useState('')
  const pending = useRef<AbortController | null>(null), form = useForm()
  const dirty = editing && pollBaseline(draft) !== baseline
  const valid = validPollDraft(draft)
  useEffect(() => { form.setModified(dirty); form.setProcessing(busy) }, [dirty, busy, form.setModified, form.setProcessing])
  useEffect(() => {
    const leave = (event: Event) => {
      if (event.type === 'click' && !(event.target as Element)?.closest('a[href]')) return
      if (busy) { event.preventDefault(); event.stopImmediatePropagation(); if (event instanceof BeforeUnloadEvent) event.returnValue = '' }
    }
    document.addEventListener('click', leave, true); window.addEventListener('beforeunload', leave)
    return () => { document.removeEventListener('click', leave, true); window.removeEventListener('beforeunload', leave) }
  }, [busy])
  useEffect(() => { void load(0, true); return () => { pending.current?.abort(); pending.current = null } }, [])
  function mayLeave() { return !pending.current && (!dirty || window.confirm('Há alterações não salvas. Descartar as alterações?')) }
  function choose(poll: Poll | null, copy = false) {
    if (!mayLeave()) return
    adopt(poll, copy); setMessage('')
  }
  function adopt(poll: Poll | null, copy = false) {
    const next = poll ? pollDraft(poll) : emptyPoll()
    setSelected(copy ? null : poll); setDraft(next); setBaseline(copy ? '' : pollBaseline(next))
    setEditing(copy || !poll || poll.status === 'draft'); setConflict(false)
  }
  function errorState(error: unknown) {
    if (error instanceof PollRequestError && [401, 403].includes(error.status)) {
      setDenied(true); setRows([]); setSelected(null); setDraft(emptyPoll()); setBaseline(pollBaseline(emptyPoll())); setEditing(false)
      setMessage('Sua sessão ou permissão editorial não está disponível. Entre novamente pelo Portal.'); return
    }
    if (error instanceof PollRequestError && error.status === 409) {
      setConflict(true)
      setMessage(error.reason === 'active_poll_exists' ? 'Já existe uma enquete aberta. Seus valores foram preservados. Recarregue a versão atual ou consulte a lista.'
        : 'A enquete mudou em outra sessão. Seus valores continuam na tela. Recarregue a versão atual para continuar.')
    } else setMessage('Não foi possível concluir. Seus valores continuam na tela. Tente novamente.')
  }
  async function run(operation: (signal: AbortSignal, active: () => boolean) => Promise<void>) {
    if (pending.current) return
    const controller = new AbortController(); pending.current = controller; setBusy(true)
    const active = () => pending.current === controller && !controller.signal.aborted
    try { await operation(controller.signal, active) } catch (error) { if (active()) errorState(error) }
    finally { if (active()) { pending.current = null; setBusy(false) } }
  }
  async function load(start: number, initial = false) {
    if (!initial && !mayLeave()) return
    await run(async (signal, active) => {
      const result = await requestPolls(`/?limit=20&offset=${start}`, { signal })
      if (!active()) return
      setRows(result.data); setTotal(result.total || 0); setOffset(start); setDenied(false); setSelected(null); setEditing(false); setConflict(false); setMessage('')
    })
  }
  async function reconcile() {
    if (!selected || !mayLeave()) return
    await run(async (signal, active) => {
      for (let start = 0; ; start += 20) {
        const result = await requestPolls(`/?limit=20&offset=${start}`, { signal })
        if (!active()) return
        const found = result.data.find(poll => poll.id === selected.id)
        if (found) { adopt(found); setRows(previous => previous.map(row => row.id === found.id ? found : row)); setMessage('Versão atual carregada.'); return }
        if (start + 20 >= (result.total || 0)) throw new Error('missing')
      }
    })
  }
  async function mutate(action: 'draft' | 'publish' | 'close') {
    if (denied || conflict || pending.current || (action === 'draft' && (!editing || !valid))
      || (action === 'publish' && (!selected || selected.status !== 'draft' || dirty || !valid)) || (action === 'close' && selected?.status !== 'open')) return
    const operation = pollMutation(action, selected, draft)
    await run(async (signal, active) => {
      const { data } = await requestPolls<Poll>(operation.path, { ...operation, signal })
      if (!active()) return
      // Only the acknowledged server DTO replaces version and baseline.
      adopt(data)
      setRows(previous => selected ? previous.map(row => row.id === data.id ? data : row) : offset === 0 ? [data, ...previous].slice(0, 20) : previous)
      if (!selected) setTotal(value => value + 1)
      setMessage(action === 'draft' ? 'Rascunho salvo.' : action === 'publish' ? 'Enquete publicada.' : 'Enquete encerrada.')
    })
  }
  return <section className="portal-polls">
    <SetStepNav nav={[{ label: 'Enquetes' }]} />
    {!busy && <LeaveWithoutSaving />}
    <h1>Enquetes</h1>
    <p role="status" aria-live="polite">{busy ? 'Aguarde a operação terminar…' : message}</p>
    {denied ? <a href="/editorial-entry.html">Entrar pelo Portal</a> : <>
      <Button type="button" disabled={busy} onClick={() => choose(null)}>Nova enquete</Button>
      <ul aria-label="Enquetes salvas">{rows.map(poll => <li key={poll.id}><button type="button" disabled={busy} onClick={() => choose(poll)}>{poll.title} · {labels[poll.status]}</button></li>)}</ul>
      <div className="portal-polls-actions"><Button buttonStyle="secondary" disabled={busy || offset === 0} onClick={() => load(offset - 20)}>Anterior</Button>
        <span>{total} enquetes · Página {offset / 20 + 1}</span><Button buttonStyle="secondary" disabled={busy || offset + 20 >= total} onClick={() => load(offset + 20)}>Próxima</Button>
        <Button buttonStyle="secondary" disabled={busy} onClick={() => load(offset)}>Atualizar lista</Button></div>
      {editing ? <form onSubmit={event => { event.preventDefault(); event.stopPropagation(); void mutate('draft') }}>
        <fieldset disabled={busy}><legend>{selected ? 'Editar rascunho' : 'Nova enquete'}</legend>
          {([['title', 'Título'], ['question', 'Pergunta'], ['description', 'Descrição'], ['closing', 'Mensagem de encerramento']] as const).map(([key, label]) =>
            <TextInput key={key} path={key} label={label} required={key === 'title' || key === 'question'} readOnly={busy} value={draft[key]} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft(previous => ({ ...previous, [key]: event.target.value }))} />)}
          {draft.options.map((option, index) => <div className="portal-polls-option" key={index}>
            <TextInput path={`option-${index}`} label={`Opção ${index + 1}`} required readOnly={busy} value={option} onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft(previous => ({ ...previous, options: previous.options.map((item, position) => position === index ? event.target.value : item) }))} />
            <div className="portal-polls-actions">{([-1, 1, 0] as const).map(delta => <button type="button" key={delta} aria-label={`${delta === -1 ? 'Subir' : delta === 1 ? 'Descer' : 'Remover'} opção ${index + 1}`}
              disabled={busy || (delta ? index + delta < 0 || index + delta >= draft.options.length : draft.options.length <= 2)} onClick={() => setDraft(previous => {
                const options = [...previous.options]; if (delta) [options[index], options[index + delta]] = [options[index + delta], options[index]]; else options.splice(index, 1)
                return { ...previous, options }
              })}>{delta === -1 ? 'Subir' : delta === 1 ? 'Descer' : 'Remover'}</button>)}</div>
          </div>)}
          <Button buttonStyle="secondary" disabled={busy || draft.options.length >= 6} onClick={() => setDraft(previous => ({ ...previous, options: [...previous.options, ''] }))}>Adicionar opção</Button>
          <p>Use de 2 a 6 opções distintas. Publicar congela todos os campos da enquete.</p>
          <div className="portal-polls-actions"><Button type="submit" disabled={busy || conflict || !valid}>Salvar rascunho</Button>
            <Button disabled={busy || conflict || dirty || !selected || !valid} onClick={() => mutate('publish')}>Publicar enquete</Button></div>
        </fieldset>
      </form> : selected && <section aria-label="Resultados agregados"><h2>{selected.question}</h2><p>{selected.description}</p><p>{labels[selected.status]} · {selected.total_votes} votos</p>
        <ul>{selected.options.map(option => <li key={option.id}>{option.label}: {option.votes} votos ({option.percentage}%)</li>)}</ul><p>{selected.closing}</p>
        {selected.status === 'open' ? <Button disabled={busy || conflict} onClick={() => mutate('close')}>Encerrar enquete</Button>
          : <Button disabled={busy} onClick={() => choose(selected, true)}>Criar nova enquete</Button>}
      </section>}
      {conflict && <Button buttonStyle="secondary" disabled={busy} onClick={reconcile}>Recarregar versão atual</Button>}
    </>}
  </section>
}
