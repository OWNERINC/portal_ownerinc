export type AuthorityMode = 'legacy' | 'frozen' | 'payload' | 'payload_frozen'
export type VerifiedPortalActor = {
  uid: string
  email: string
  name: string | null
  canManageNews: boolean
}
export type Authority = { mode: AuthorityMode; epoch: number }
export type AssetScope = 'legacy' | 'owner-news' | 'owner-news-preview'
export type Mark = 'bold' | 'italic' | 'underline' | 'code'
export type Inline =
  | { type: 'text'; text: string; marks: Mark[] }
  | { type: 'link'; url: string; new_tab: boolean; children: Inline[] }
  | { type: 'break' }
export type RichNode =
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'heading'; level: 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
export type RichBlock = {
  type: 'rich_text'
  nodes: RichNode[]
  layout?: 'content' | 'wide' | 'full' | 'left' | 'right'
  typography?: 'serif' | 'sans'
}
export type NewsEditorial = null | {
  version: 1
  kind: 'article' | 'edition'
  summary: string
  author: string
  source_label: string
  source_date: string | null
}
export type LegacyBlock = Record<string, unknown>
/** CMS input is validated at runtime; Payload generates the persisted Blocks types. */
export type NewsContent = (LegacyBlock | RichBlock)[]
export type NewsDTO = {
  id: string
  title: string
  category: string
  published_at: string | null
  editorial: NewsEditorial
  content_version: 2
  asset_scope: 'owner-news' | 'owner-news-preview'
  content_blocks: NewsContent
  read_time_minutes: number | null
}
export type NewsPage = { rows: NewsDTO[]; count: number }
export type NewsQuery = {
  limit: number
  offset: number
  category?: string
  kind?: 'article' | 'edition'
}
export type NewsNavigation = {
  previous: { id: string; title: string } | null
  next: { id: string; title: string } | null
}
export type PreviewQuery = {
  id: string
  versionId: string
  source: 'payload' | 'legacy'
}
export type HomeContent = {
  version: 1; eyebrow: string; headline: string; summary: string
}
/** Task10/11 handoff: immutable imported history, NOT a native Versions record.
 * CMS id/createdAt/updatedAt describe ingestion only; never original provenance. */
export type LegacyNewsRevisionInput = {
  legacyDocumentId: string; legacyRevisionId: string
  originalVersion: number; originalCreatedAt: string; originalActorUid: string | null
  originalStatus: 'draft' | 'published' | 'scheduled' | 'archived'
  originalTitle: string; originalCategory: string; originalPublishedAt: string | null
  originalBody: NewsContent; originalEditorial: NewsEditorial
  contentHash: string; provenanceHash: string; mediaReferences: string[]
}
export type ScheduleInput = {
  target: 'article' | 'home'
  documentId: string
  versionId: string
  operation: 'publish' | 'unpublish'
  scheduledAt: string
  expectedGeneration: number
  /** Optional saved-content confirmation. Native admin always supplies it. */
  snapshotHash?: string
}
