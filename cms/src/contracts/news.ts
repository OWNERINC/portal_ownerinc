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
export type NewsDTO = {
  id: string
  title: string
  category: string
  published_at: string | null
  editorial: NewsEditorial
  content_version: 2
  asset_scope: 'owner-news' | 'owner-news-preview'
  content_blocks: (LegacyBlock | RichBlock)[]
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
export type ScheduleInput = {
  target: 'article' | 'home'
  documentId: string
  versionId: string
  operation: 'publish' | 'unpublish'
  scheduledAt: string
  expectedGeneration: number
}
