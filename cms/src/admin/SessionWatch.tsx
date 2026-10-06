'use client'
import React, { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
type State = { status: 'checking' | 'ready' | 'denied' | 'error'; message: string }
type Watch = { stop: () => void; revalidate: () => Promise<void> }
export function SessionWatch({ children }: { children?: React.ReactNode }) {
  const pathname = usePathname()
  const [state, setState] = useState<State>({ status: 'checking', message: '' })
  const watcher = useRef<Watch | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let active = true
    const url = new URL('/js/editorial-session-watch.js', window.location.origin).href
    // Browser-served module owns the single Firebase configuration, not Next.
    void import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url).then(module => {
      if (!active) return
      watcher.current = module.watchEditorialSession({ onState: (next: State) => {
        if (active) setState(previous => next.status === 'checking' && previous.status === 'ready' ? previous : next)
      } })
    }).catch(() => { if (active) setState({ status: 'error', message: 'Não foi possível carregar a validação editorial. Tente novamente.' }) })
    return () => { active = false; watcher.current?.stop(); watcher.current = null }
  }, [attempt])
  // Logout is public and must remain usable even after expiry or offline failure.
  if (pathname === '/editorial/admin/logout') return children
  if (state.status === 'ready') return children
  return <section className="portal-session-status"><h1>Sessão editorial</h1><p role="alert">{state.message || 'Validando a mesma conta do Portal…'}</p>
    {(state.status === 'error' || state.status === 'denied') && <><button type="button" onClick={() => watcher.current ? void watcher.current.revalidate() : setAttempt(value => value + 1)}>Tentar novamente</button><p><a href="/editorial-entry.html">Entrar pelo Portal</a></p></>}
  </section>
}
