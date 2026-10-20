import config from '@payload-config'
import type { Metadata } from 'next'
import { createLocalReq, getPayload, APIError } from 'payload'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { PortalPagePreview } from '../../../../../../admin/portal-pages/PortalPagePreview'
import { loadEditorialPreview } from '../../../../../../portal-pages/editorial-preview'
import './portal-page-preview.scss'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'
export const metadata: Metadata = {
  title: 'Prévia editorial',
  robots: { index: false, follow: false, noarchive: true },
}

type PageProps = {
  params: Promise<{ pageId: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function errorState(message: string, status: number): React.JSX.Element {
  return <main className="portal-page-preview-route" data-preview-status={status}>
    <h1>Prévia editorial indisponível</h1>
    <p role="alert">{message}</p>
    {status === 401 && <p><a href="/editorial-entry.html">Entre novamente no Portal para abrir esta prévia.</a></p>}
  </main>
}

export default async function EditorialPortalPagePreview({ params, searchParams }: PageProps): Promise<React.JSX.Element> {
  const [{ pageId }, query] = await Promise.all([params, searchParams])
  const version = query.version
  if (typeof version !== 'string' || Object.keys(query).some(key => key !== 'version')) {
    return errorState('O endereço da prévia é inválido. Abra novamente a versão salva pelo editor.', 400)
  }

  try {
    const requestHeaders = await headers()
    const payload = await getPayload({ config })
    const auth = await payload.auth({ headers: requestHeaders })
    if (!auth.user) return errorState('Sua sessão editorial expirou. Entre novamente para abrir esta prévia.', 401)
    const req = await createLocalReq({
      req: { headers: requestHeaders, user: auth.user, context: {} },
      user: auth.user,
      context: {},
    }, payload)
    const { dto, savedAt } = await loadEditorialPreview(req, pageId, version)

    return <main className="portal-page-preview-route">
      <header className="portal-page-preview-route__notice">
        <p className="portal-page-preview-route__eyebrow">Prévia editorial</p>
        <h1>{dto.title}</h1>
        <p>Versão salva <code>{dto.revision.id}</code></p>
        <p>Salva em <time dateTime={savedAt}>{savedAt}</time></p>
        <p>Esta prévia não publica a página.</p>
      </header>
      <PortalPagePreview dto={dto} savedAt={savedAt} />
    </main>
  } catch (error) {
    if (error instanceof APIError && error.status === 404) notFound()
    if (error instanceof APIError && error.status === 400) {
      return errorState('O endereço da prévia é inválido. Abra novamente a versão salva pelo editor.', 400)
    }
    if (error instanceof APIError && error.status === 403) {
      return errorState('Sua conta não tem acesso editorial a esta prévia.', 403)
    }
    if (error instanceof APIError && error.status === 401) {
      return errorState('Sua sessão editorial expirou. Entre novamente para abrir esta prévia.', 401)
    }
    return errorState('A prévia está temporariamente indisponível. Tente novamente em instantes.', 503)
  }
}
