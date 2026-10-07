import React from 'react'

export type LegacyHistoryRow = {
  legacyDocumentId: string
  legacyRevisionId: string
  originalVersion: number
  originalCreatedAt: string
  originalActorUid: string | null
  originalStatus: 'draft' | 'published' | 'scheduled' | 'archived'
  originalTitle: string
  originalCategory: string
  originalPublishedAt: string | null
  metadataBasis?: { title: 'document_snapshot'; category: 'document_snapshot'; publishedAt: 'published_pointer' | 'unknown' } | null
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const statuses = { draft: 'Rascunho', published: 'Publicada', scheduled: 'Agendada', archived: 'Arquivada' }
const instant = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value))
/** Native REST may add id/timestamps, but no body is requested or retained here. */
export function readHistoryPage(value: unknown, documentId: string): { rows: LegacyHistoryRow[]; hasNextPage: boolean } {
  if (!value || typeof value !== 'object') throw new Error('invalid_history_page')
  const page = value as { docs?: unknown; hasNextPage?: unknown }
  if (!Array.isArray(page.docs) || page.docs.length > 20 || typeof page.hasNextPage !== 'boolean') throw new Error('invalid_history_page')
  const rows = page.docs.map(item => {
    if (!item || typeof item !== 'object') throw new Error('invalid_history_page')
    const row = item as LegacyHistoryRow
    if (row.legacyDocumentId !== documentId || typeof row.legacyDocumentId !== 'string' || typeof row.legacyRevisionId !== 'string' || !uuid.test(row.legacyDocumentId) || !uuid.test(row.legacyRevisionId) ||
      !Number.isSafeInteger(row.originalVersion) || row.originalVersion < 1 || typeof row.originalStatus !== 'string' || !Object.hasOwn(statuses, row.originalStatus) ||
      !instant(row.originalCreatedAt) || !(row.originalPublishedAt === null || instant(row.originalPublishedAt)) ||
      !(row.originalActorUid === null || (typeof row.originalActorUid === 'string' && row.originalActorUid.length > 0 && row.originalActorUid.length <= 128)) ||
      typeof row.originalTitle !== 'string' || row.originalTitle.length > 200 || typeof row.originalCategory !== 'string' || row.originalCategory.length > 100) throw new Error('invalid_history_page')
    if (row.metadataBasis != null && (row.metadataBasis.title !== 'document_snapshot' || row.metadataBasis.category !== 'document_snapshot' ||
      row.metadataBasis.publishedAt !== (row.originalPublishedAt === null ? 'unknown' : 'published_pointer'))) throw new Error('invalid_history_page')
    return { legacyDocumentId: row.legacyDocumentId, legacyRevisionId: row.legacyRevisionId, originalVersion: row.originalVersion,
      originalCreatedAt: row.originalCreatedAt, originalActorUid: row.originalActorUid, originalStatus: row.originalStatus,
      originalTitle: row.originalTitle, originalCategory: row.originalCategory, originalPublishedAt: row.originalPublishedAt, metadataBasis: row.metadataBasis }
  })
  if (new Set(rows.map(row => row.legacyRevisionId)).size !== rows.length) throw new Error('invalid_history_page')
  return { rows, hasNextPage: page.hasNextPage }
}
export function LegacyHistoryList({ rows }: { rows: LegacyHistoryRow[] }) {
  if (!rows.length) return <p>Nenhuma revisão anterior à migração para esta matéria.</p>
  return <ol style={{ paddingInlineStart: '1.5rem', overflowWrap: 'anywhere' }}>
    {rows.map(row => <li key={row.legacyRevisionId} style={{ marginBlock: '1rem' }}>
      <strong>Versão {row.originalVersion} — {statuses[row.originalStatus]}</strong>
      <p>{row.originalTitle}{row.originalCategory ? ` · ${row.originalCategory}` : ''}</p>
      <p>{row.metadataBasis ? 'Título e categoria: fotografia do documento na exportação.' : 'Base histórica de título e categoria não informada.'}</p>
      <dl>
        <dt>Criação original (UTC)</dt><dd><time dateTime={row.originalCreatedAt}>{row.originalCreatedAt}</time></dd>
        <dt>Autoria original (UID)</dt><dd>{row.originalActorUid ?? 'Não registrada'}</dd>
        <dt>Publicação registrada (UTC)</dt><dd>{row.originalPublishedAt
          ? <><time dateTime={row.originalPublishedAt}>{row.originalPublishedAt}</time>{row.metadataBasis ? ' — publicação vigente na exportação' : ' — base não informada'}</>
          : 'Desconhecida para esta revisão'}</dd>
      </dl>
      <a href={`/news-preview.html?id=${encodeURIComponent(row.legacyDocumentId)}&version=${encodeURIComponent(row.legacyRevisionId)}&source=legacy`} target="_blank" rel="noopener noreferrer">Abrir prévia da versão {row.originalVersion} (nova aba)</a>
    </li>)}
  </ol>
}
