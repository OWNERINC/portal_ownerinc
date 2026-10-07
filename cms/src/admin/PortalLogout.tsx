'use client'
import React, { useEffect, useState } from 'react'
import { Link, Button } from '@payloadcms/ui'
export function PortalLogout() {
  // Native LeaveWithoutSaving sees a navigation, not an immediate mutation.
  return <Link href="/editorial/admin/logout">Sair do editorial</Link>
}
export function PortalLogoutView() {
  const [message, setMessage] = useState('Encerrando a sessão editorial…'), [busy, setBusy] = useState(false)
  async function end() {
    setBusy(true)
    try {
      const response = await fetch('/api/cms/session', { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' })
      if (!response.ok) throw new Error('revoke')
       window.location.replace('/cms.html')
    } catch { setMessage('Não foi possível confirmar o encerramento. O conteúdo foi ocultado. Tente novamente.') }
    finally { setBusy(false) }
  }
  useEffect(() => { void end() }, [])
  return <section className="portal-session-status"><h1>Sair do editorial</h1><p role="status">{message}</p><Button disabled={busy} onClick={end}>Tentar encerrar novamente</Button></section>
}
