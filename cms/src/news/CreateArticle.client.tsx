'use client'

import { Gutter, Link } from '@payloadcms/ui'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

const listURL = '/editorial/admin/collections/news-articles'

export function CreateArticle() {
  const router = useRouter()
  const request = useRef<Promise<string> | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let mounted = true
    // One POST per mounted navigation, including React's development effect replay.
    // No abort/retry: an uncertain response must not automatically create another row.
    request.current ??= fetch('/editorial/api/news-articles?draft=true&depth=0', {
      method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ _status: 'draft' }),
    }).then(async response => {
      if (!response.ok) throw new Error('create_failed')
      const { doc } = await response.json()
      if (typeof doc?.id !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(doc.id)) throw new Error('create_failed')
      return doc.id as string
    })
    void request.current.then(id => {
      if (mounted) router.replace(`${listURL}/${id}`)
    }, () => { if (mounted) setFailed(true) })
    return () => { mounted = false }
  }, [router])

  return <Gutter>
    <p role={failed ? 'alert' : 'status'}>{failed
      ? 'Não foi possível confirmar a criação. Confira a lista antes de criar outra matéria.'
      : 'Criando rascunho…'}</p>
    {failed && <Link href={listURL}>Voltar às matérias</Link>}
  </Gutter>
}
