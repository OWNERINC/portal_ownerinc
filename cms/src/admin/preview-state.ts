const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
export const previewConflictMessage = 'Ainda não há uma revisão salva disponível. Seus campos foram preservados. Aguarde o salvamento e confira novamente.'

/** This endpoint only reads native Versions; it never creates a draft on GET. */
export async function savedPreview(documentId: string, signal: AbortSignal, request: typeof fetch = fetch) {
  if (!uuid(documentId)) throw new Error('Salve o documento antes de abrir a prévia.')
  const response = await request(`/editorial/api/news-schedule?target=article&documentId=${encodeURIComponent(documentId)}`,
    { credentials: 'same-origin', cache: 'no-store', signal })
  if (response.status === 409) throw new Error(previewConflictMessage)
  if (!response.ok) throw new Error('Não foi possível consultar a revisão salva. Confira sua permissão editorial.')
  const revision = await response.json()
  if (signal.aborted) throw new DOMException('Consulta cancelada.', 'AbortError')
  if (!revision || !uuid(revision.versionId) || typeof revision.savedAt !== 'string' || !Number.isFinite(Date.parse(revision.savedAt))) {
    throw new Error('Revisão salva inválida. Confira novamente antes de abrir a prévia.')
  }
  const query = new URLSearchParams({ id: documentId.toLowerCase(), version: revision.versionId.toLowerCase(), source: 'payload' })
  return { href: `/news-preview.html?${query}`, savedAt: revision.savedAt }
}
